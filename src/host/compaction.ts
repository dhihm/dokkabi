import { readFileSync } from "node:fs";
import type { EventLog } from "./event-log.ts";
import { saveAgentTranscript, synchronizeAgentTranscript } from "./agent-transcript.ts";
import { liveProviderState, assertProviderMessages, replaceProviderMessages } from "./provider-input.ts";
import { prepareCompactionTransaction, recoverInterruptedCompaction } from "./compaction-transaction.ts";
import type { EventRecord } from "./schema.ts";
import { readResultProjection, reprojectResultText, RESULT_READER, RESULT_SLIM_BUDGET, resultRecovery, sha256Text, slimUnsourcedText, utf8Bytes } from "../tools/model-result.ts";
import { readResultRead, type ResultRead } from "./result-source.ts";

/** Compact when the estimated context crosses this share of the window. */
export const COMPACTION_THRESHOLD = 0.8;
/** Sweep earlier than the hard line so background compaction usually wins the race. */
export const COMPACTION_SOFT_THRESHOLD = 0.65;

/** One absolute caution line shared with manual handoff and reseed: real
 * backends routinely enforce limits far below multi-hundred-k advertised
 * windows, and a context past this line makes every cache-cold re-ingest,
 * handoff, and reseed giant. */
export const CONTEXT_SOFT_CAP_TOKENS = 131_072;

/** The window compaction reasons about. At or below the caution-derived
 * bound (~201k) it is the real window; above, it clamps so the soft sweep
 * engages at ~131k and the hard gate at ~161k — a 17-hour session on
 * advertised-1M models otherwise ran zero compactions while its context
 * grew to 376k. */
export function effectiveCompactionWindow(window: number): number {
  if (!Number.isFinite(window) || window <= 0) return window;
  return Math.min(window, Math.floor(CONTEXT_SOFT_CAP_TOKENS / COMPACTION_SOFT_THRESHOLD));
}
/**
 * Where a compaction lands, as a share of the compaction window.
 *
 * It used to land at the firing line minus 0.1 -- 0.55 of the window for the
 * soft sweep -- so the history was back over the line after a few turns and
 * compacted again. Each compaction rewrites the whole kept history into the
 * provider's prompt cache (dropping from the front moves everything after
 * it), so landing just under the line paid that rewrite again and again: a
 * live run went 158k -> 108k against a 111k budget and wrote 96k tokens of
 * cache for one request. Landing lower keeps less history and rewrites less,
 * and leaves room for many turns before the next one. The work's own state
 * lives in the ledger and the compaction checkpoint, not in old turns.
 * The in-flight pruner makes the same trade (fire 0.75, land 0.5).
 */
export const COMPACTION_LANDING = 0.4;

/** The token budget a compaction fired at `threshold` lands under. */
export function compactionLandingBudget(window: number, threshold: number): number {
  return Math.floor(effectiveCompactionWindow(window) * Math.min(threshold - 0.1, COMPACTION_LANDING));
}

/** Never drop the newest N transcript messages. */
export const KEEP_RECENT_MESSAGES = 6;
/** Rough chars-per-token estimate; the next real usage supersedes it. */
export const CHARS_PER_TOKEN = 4;

export interface CompactionPressure {
  used: number;
  window: number;
  /** True when the newest compaction/drop has no model/usage after it. */
  relieved: boolean;
}

/**
 * Read the context pressure from the log: the last numeric usage and whether
 * a compaction already relieved it without a newer measurement. Shared by the
 * pre-model hard check and the background soft sweep so both gates agree.
 *
 * Pressure must not be blind on a route that reports no usage. One live
 * route sent model/usage as an empty object every turn, so pressure stayed
 * undefined, no compaction ever fired, and an unattended overnight run grew
 * its history to 137k tokens until the provider refused the request. The
 * harness estimates the context every turn anyway (model/context_layers), so
 * when the provider's own numbers are missing — or older than the newest
 * estimate — the estimate is the pressure, measured against the shared soft
 * cap real backends enforce regardless of their advertised window.
 */
export function compactionPressure(events: readonly EventRecord[]): CompactionPressure | undefined {
  let used: number | undefined;
  let window = 0;
  let lastUsageSeq = -1;
  let lastDropSeq = -1;
  let estimated: number | undefined;
  let lastEstimateSeq = -1;
  for (const event of events) {
    if (event.name === "model/usage") {
      const usage = event.observe?.model_usage ?? (event.payload as { model_usage?: Record<string, unknown> }).model_usage;
      const u = typeof usage?.context_used === "number" ? usage.context_used : undefined;
      const w = typeof usage?.context_window === "number" ? usage.context_window : undefined;
      if (u !== undefined && w !== undefined && w > 0) {
        used = u;
        window = w;
        lastUsageSeq = event.seq;
      }
    }
    if (event.name === "model/context_layers") {
      const layers = (event.payload as { layers?: Record<string, unknown> }).layers;
      if (layers && typeof layers === "object") {
        const total = Object.values(layers).reduce<number>(
          (sum, value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? sum + value : sum),
          0,
        );
        if (total > 0) {
          estimated = total;
          lastEstimateSeq = event.seq;
        }
      }
    }
    if (event.name === "compaction/drop" && event.payload.in_turn !== true) {
      lastDropSeq = event.seq;
    }
  }
  if (estimated !== undefined && lastEstimateSeq > lastUsageSeq) {
    // The estimate carries no window, and the advertised one (512k, 1M) is
    // exactly what the clamp already refuses to trust. Hand back the widest
    // window the clamp would allow, so the estimate compacts at the same
    // caution lines as a measured large-window session — no stricter.
    const window = Math.floor(CONTEXT_SOFT_CAP_TOKENS / COMPACTION_SOFT_THRESHOLD);
    return { used: estimated, window, relieved: lastDropSeq > lastEstimateSeq };
  }
  if (used === undefined) {
    return undefined;
  }
  return { used, window, relieved: lastDropSeq > lastUsageSeq };
}

/**
 * One gate for both compaction paths: pressure over the given threshold,
 * not already relieved by an unmeasured compaction. Callers add their own
 * guards (the sweep also requires the agent to be idle).
 */
export function shouldCompact(
  events: readonly EventRecord[],
  threshold: number,
): boolean {
  const pressure = compactionPressure(events);
  if (!pressure || pressure.relieved) {
    return false;
  }
  return pressure.used >= effectiveCompactionWindow(pressure.window) * threshold;
}

/**
 * Measure a transcript file's content size in estimated tokens. The
 * transcript is the source of truth for what the model will actually be
 * sent: surface events and transcript messages are not 1:1 (one assistant
 * completion spans several tool turns).
 */
/** Measure one message the way the provider charges for it: the WHOLE
 * content array — toolCall argument JSON, thinking blocks, image refs —
 * not just text parts. Text-only counting undercounted real requests by
 * 28-40k tokens and made every compaction budget a lie. */
export function messageTokens(message: { content?: unknown; role?: string }): number {
  const json = JSON.stringify(message.content ?? "");
  const role = message.role ?? "";
  return Math.ceil((json.length + role.length + 24) / CHARS_PER_TOKEN);
}

/** Never trust one odd measurement to more than quadruple the estimate. */
const MAX_TOKEN_SCALE = 4;

/**
 * The estimate, corrected by what the provider actually charged.
 *
 * CHARS_PER_TOKEN=4 is an English rule; Korean and other CJK text costs far
 * more per byte. Live, the provider reported 196,628 history tokens while the
 * local estimate said 93,358 — so compaction sized its drops from a number
 * half the truth, concluded the transcript already fit the budget, dropped
 * nothing, and the context climbed past 200k until the provider refused the
 * request. Scaling every message by measured/estimated makes the budget
 * arithmetic use the same units the provider bills in. The scale only ever
 * grows the estimate (an ASCII session that measures under its estimate keeps
 * the estimate) and is capped.
 */
export function scaledMessageTokens(
  message: { content?: unknown; role?: string },
  calibration?: { measured: number; estimated: number },
): number {
  const raw = messageTokens(message);
  if (!calibration) return raw;
  const { measured, estimated } = calibration;
  if (!Number.isFinite(measured) || !Number.isFinite(estimated) || estimated <= 0 || measured <= estimated) {
    return raw;
  }
  const scale = Math.min(MAX_TOKEN_SCALE, measured / estimated);
  return Math.ceil(raw * scale);
}

export function transcriptTokens(transcriptPath: string): number {
  try {
    const parsed = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
      messages?: Array<{ content?: unknown; role?: string }>;
    };
    let tokens = 0;
    for (const message of parsed.messages ?? []) {
      tokens += messageTokens(message);
    }
    return tokens;
  } catch {
    return 0;
  }
}

interface TranscriptShape {
  prefix_hash?: string;
  system_prompt_hash?: string;
  tool_schema_hash?: string;
  plugin_manifest_digest?: string;
  model_id?: string;
  route?: string;
  messages?: Array<Record<string, unknown>>;
}

function readTranscript(path: string): TranscriptShape | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TranscriptShape;
  } catch {
    return undefined;
  }
}

export interface CompactionPlan {
  reason: "over_budget" | "under_budget" | "message_count";
  /** Transcript messages to drop, from the front. */
  dropMessages: number;
  /** Transcript messages that survive (before the summary is prepended). */
  keepMessages: number;
  /** Token estimate after the drop. */
  estimateAfter: number;
}

export interface PlanInput {
  transcriptTokens: number;
  tokenBudget: number;
  keepMessages: number;
  /** Per-message token sizes, oldest first, when the caller knows them. */
  messageTokens?: number[];
  /** Message roles aligned with messageTokens. Durable compaction uses user
   * boundaries so an assistant tool call is never separated from its result. */
  roles?: string[];
  /** Preserve at least this many complete operator turns. */
  keepTurns?: number;
}

/**
 * Plan in message space. Drops whole messages from the front until the
 * transcript estimate fits the budget, never cutting into the keep window.
 */

/**
 * Drop from the front by message count until the remainder fits the budget,
 * always keeping at least keepMessages of the recent tail. Used when the
 * transcript has no user turn boundary to cut on.
 */
function planByMessageCount(
  sizes: readonly number[],
  input: { transcriptTokens: number; tokenBudget: number; keepMessages: number },
  count: number,
): CompactionPlan {
  const floor = Math.max(0, count - Math.max(0, input.keepMessages));
  if (floor === 0) {
    return { reason: "under_budget", dropMessages: 0, keepMessages: count, estimateAfter: input.transcriptTokens };
  }
  let estimate = input.transcriptTokens;
  let drop = 0;
  while (drop < floor && estimate > input.tokenBudget) {
    estimate -= Math.max(0, sizes[drop] ?? 0);
    drop += 1;
  }
  if (drop === 0) {
    return { reason: "under_budget", dropMessages: 0, keepMessages: count, estimateAfter: input.transcriptTokens };
  }
  return { reason: "message_count", dropMessages: drop, keepMessages: count - drop, estimateAfter: estimate };
}

export function planCompaction(input: PlanInput): CompactionPlan {
  const total = Math.max(0, input.transcriptTokens);
  const keep = Math.max(0, input.keepMessages);
  const sizes = input.messageTokens;
  const count = sizes?.length;
  if (total <= input.tokenBudget) {
    return { reason: "under_budget", dropMessages: 0, keepMessages: count ?? 0, estimateAfter: total };
  }
  if (!sizes || count === undefined) {
    return { reason: "under_budget", dropMessages: 0, keepMessages: 0, estimateAfter: total };
  }
  const turnPlan = planAtTurnBoundaries(input, sizes);
  if (turnPlan) {
    return turnPlan;
  }
  let estimate = total;
  const droppable = Math.max(0, count - keep);
  let drop = 0;
  for (let i = 0; i < droppable && estimate > input.tokenBudget; i += 1) {
    estimate -= Math.max(0, sizes[i]!);
    drop += 1;
  }
  return {
    reason: drop > 0 ? "over_budget" : "under_budget",
    dropMessages: drop,
    keepMessages: count - drop,
    estimateAfter: Math.max(0, estimate),
  };
}

function planAtTurnBoundaries(input: PlanInput, sizes: number[]): CompactionPlan | undefined {
  const roles = input.roles;
  if (!roles || roles.length !== sizes.length || !input.keepTurns || input.keepTurns < 1) {
    return undefined;
  }
  const boundaries = roles
    .map((role, index) => role === "user" ? index : -1)
    .filter((index) => index > 0);
  if (boundaries.length === 0) {
    // A work-mode transcript is one operator order followed by hundreds of
    // assistant/toolResult messages: there is no second `user` message, so
    // turn-boundary cutting finds nothing and the context grows forever
    // (live: 594 messages, 211k tokens, drop 0 every attempt). Fall back to a
    // message-count cut that keeps the recent tail — less tidy than a turn
    // boundary, but a transcript that cannot be cut is worse than one cut
    // mid-turn.
    return planByMessageCount(sizes, input, roles.length);
  }
  const allUserStarts = [0, ...boundaries];
  const recentTurnStart = allUserStarts[Math.max(0, allUserStarts.length - input.keepTurns)] ?? 0;
  const rawMessageFloor = Math.max(0, sizes.length - Math.max(0, input.keepMessages));
  const maxDrop = Math.min(recentTurnStart, rawMessageFloor);
  const candidates = boundaries.filter((index) => index <= maxDrop);
  if (candidates.length === 0) {
    return { reason: "under_budget", dropMessages: 0, keepMessages: sizes.length, estimateAfter: input.transcriptTokens };
  }
  const prefix = [0];
  for (const size of sizes) prefix.push(prefix[prefix.length - 1]! + Math.max(0, size));
  let drop = candidates.at(-1)!;
  for (const boundary of candidates) {
    if (input.transcriptTokens - prefix[boundary]! <= input.tokenBudget) {
      drop = boundary;
      break;
    }
  }
  return {
    reason: drop > 0 ? "over_budget" : "under_budget",
    dropMessages: drop,
    keepMessages: sizes.length - drop,
    estimateAfter: Math.max(0, input.transcriptTokens - prefix[drop]!),
  };
}

/**
 * The exhaustion gate: a compaction that dropped nothing at a recorded
 * pressure blocks retries only while usage stays at or below that pressure.
 * Once the context grows past it, new messages have aged past the keep
 * window and a retry may drop again. A legacy drop-0 without the marker
 * never blocks (the original deadlock).
 */
export function compactionExhausted(
  events: readonly { name: string; payload: Record<string, unknown> }[],
  used: number,
): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name === "compaction/end" && event.payload.nothing_left === true) {
      const pressure = typeof event.payload.pressure_tokens === "number" ? event.payload.pressure_tokens : Number.MAX_SAFE_INTEGER;
      return used <= pressure;
    }
    if (event?.name !== "compaction/drop" || event.payload.in_turn === true) {
      continue;
    }
    if (event.payload.nothing_left === true) {
      const pressure = typeof event.payload.pressure_tokens === "number" ? event.payload.pressure_tokens : Number.MAX_SAFE_INTEGER;
      return used <= pressure;
    }
    if (typeof event.payload.dropped_messages === "number" && event.payload.dropped_messages > 0) {
      return false;
    }
  }
  return false;
}

export interface CompactionResult {
  droppedMessages: number;
  /** Messages in the rewritten transcript, including the summary. */
  keptMessages: number;
  /** Estimated tokens of the rewritten transcript, measured from disk. */
  keptTokens: number;
  transcriptPath: string;
  /** Start event owning the pending marker; the caller clears it after seal. */
  transactionStartSeq?: number;
}

/**
 * Compact: plan in message space against the measured transcript, record the
 * four constitution events, rewrite the transcript with a summary in front,
 * and back the previous one up one generation. kept_tokens in the drop event
 * is measured from the rewritten file, so the dashboard reads what the model
 * will actually see, not a plan estimate.
 */
export function applyCompactionToTranscript(input: {
  transcriptPath: string;
  log: EventLog;
  summary: string;
  keepMessages: number;
  transcriptTokens: number;
  tokenBudget: number;
  messageTokens?: number[];
  roles?: string[];
  keepTurns?: number;
  checkpoint?: Record<string, unknown>;
  /** When a pressured compaction drops nothing, the pressure to record. */
  nothingLeftPressure?: number;
}): CompactionResult {
  synchronizeAgentTranscript(input.log, input.transcriptPath);
  const plan = planCompaction({
    transcriptTokens: input.transcriptTokens,
    tokenBudget: input.tokenBudget,
    keepMessages: input.keepMessages,
    ...(input.messageTokens ? { messageTokens: input.messageTokens } : {}),
    ...(input.roles ? { roles: input.roles } : {}),
    ...(input.keepTurns ? { keepTurns: input.keepTurns } : {}),
  });

  const transcript = readTranscript(input.transcriptPath);
  const messages = (transcript?.messages ?? []) as Array<Record<string, unknown>>;
  const structured = liveProviderState(input.log).ref !== null;
  if (structured) assertProviderMessages(input.log, messages);
  const drop = Math.min(plan.dropMessages, Math.max(0, messages.length - input.keepMessages));
  const keptRaw = messages.slice(drop);
  const summaryMessage = {
    role: "user",
    content: [{ type: "text", text: `[compaction summary] ${input.summary}` }],
  };

  const startInput = {
    kind: "observe",
    name: "compaction/start",
    payload: {
      reason: "context_pressure",
      estimated_tokens: input.transcriptTokens,
      budget_tokens: input.tokenBudget,
    },
  } as const;
  const planInput = {
    kind: "observe",
    name: "compaction/plan",
    payload: {
      drop_messages: plan.dropMessages,
      keep_messages: plan.keepMessages,
      estimated_tokens_before: input.transcriptTokens,
      estimated_tokens_after: plan.estimateAfter,
      budget_tokens: input.tokenBudget,
    },
  } as const;
  if (drop === 0) {
    const keptTokens = transcriptTokens(input.transcriptPath);
    input.log.appendBatch(() => [
      startInput,
      planInput,
      {
        kind: "observe",
        name: "compaction/end",
        payload: {
          status: "nothing_to_drop",
          dropped_messages: 0,
          kept_messages: messages.length,
          kept_tokens: keptTokens,
          ...(input.nothingLeftPressure !== undefined
            ? { nothing_left: true, pressure_tokens: input.nothingLeftPressure }
            : {}),
        },
      },
    ]);
    return {
      droppedMessages: 0,
      keptMessages: messages.length,
      keptTokens,
      transcriptPath: input.transcriptPath,
    };
  }
  const [start] = input.log.appendBatch((nextSeq) => {
    prepareCompactionTransaction(input.transcriptPath, nextSeq);
    return [startInput, planInput];
  });
  if (!start || start.name !== "compaction/start") {
    throw new Error("compaction transaction did not record its start");
  }
  try {
    if (structured) replaceProviderMessages(input.log, [summaryMessage, ...keptRaw], "compaction", {
      compaction_start: start.seq, drop_messages: drop, summary: input.summary,
    });
    const saved = saveAgentTranscript(input.transcriptPath, {
      prefix_hash: transcript?.prefix_hash ?? "missing",
      ...(transcript?.system_prompt_hash ? { system_prompt_hash: transcript.system_prompt_hash } : {}),
      ...(transcript?.tool_schema_hash ? { tool_schema_hash: transcript.tool_schema_hash } : {}),
      ...(transcript?.plugin_manifest_digest ? { plugin_manifest_digest: transcript.plugin_manifest_digest } : {}),
      model_id: transcript?.model_id ?? "missing",
      route: transcript?.route ?? "missing",
      messages: [summaryMessage, ...keptRaw],
    } as never, input.log);
    if (!saved) {
      throw new Error("compacted transcript was rejected by the secret or shape guard");
    }
  } catch (error) {
    recoverInterruptedCompaction({ transcriptPath: input.transcriptPath, log: input.log });
    throw error;
  }
  const keptTokens = transcriptTokens(input.transcriptPath);
  input.log.append({
    kind: "observe",
    name: "compaction/drop",
    payload: {
      start_seq: start.seq,
      dropped_messages: drop,
      kept_messages: keptRaw.length + 1,
      kept_tokens: keptTokens,
      digest: summaryDigest(input.summary),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    },
  });
  return {
    droppedMessages: drop,
    keptMessages: keptRaw.length + 1,
    keptTokens,
    transcriptPath: input.transcriptPath,
    transactionStartSeq: start.seq,
  };
}

function summaryDigest(summary: string): string {
  let hash = 5381;
  for (let i = 0; i < summary.length; i += 1) {
    hash = ((hash << 5) + hash + summary.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * In-turn pruning for the running agent context (Pi successful-turn hook).
 * The prompt()-time check cannot see context growth inside a turn: tool
 * rounds refill the window and the request dies at the provider. This drops
 * the oldest pair-safe message range (user-boundary to user-boundary, so
 * toolCall/toolResult pairs never split) until the estimate fits the budget.
 * Returns the messages unchanged when there is nothing safe to drop.
 */
export function pruneInFlightMessages(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
  window: number,
  keepRecent = KEEP_RECENT_MESSAGES,
  /** Hysteresis: fire above fireAt, cut down to pruneTo. Firing and landing
   * at the same line made the pruner thrash — every request re-pruned 75
   * messages (flask-5063 sweep 5: 100+ in_turn drops per run). */
  opts: { fireAt?: number; pruneTo?: number } = {},
): { messages: Array<{ role: string; content?: unknown }>; dropped: number; droppedTokens: number; estimate: number } {
  const fireAt = opts.fireAt ?? 0.75;
  const pruneTo = opts.pruneTo ?? 0.5;
  const estimate = estimateMessagesTokens(messages);
  const fireLine = Math.floor(window * fireAt);
  const target = Math.floor(window * pruneTo);
  if (estimate <= fireLine || messages.length <= keepRecent + 1) {
    return { messages: [...messages], dropped: 0, droppedTokens: 0, estimate };
  }
  // Drop ranges must start at a user boundary (index > 0) and end before a
  // later user boundary: [1 .. end) keeps tool pairs intact and messages[0]
  // (the original order) always survives.
  const userBoundaries: number[] = [];
  for (let i = 1; i < messages.length - keepRecent; i += 1) {
    if (messages[i]!.role === "user") {
      userBoundaries.push(i);
    }
  }
  if (userBoundaries.length === 0) {
    return { messages: [...messages], dropped: 0, droppedTokens: 0, estimate };
  }
  // Prefix token sums so the cut point is a subtraction, not a rescan.
  const prefix: number[] = [0];
  for (let i = 0; i < messages.length; i += 1) {
    prefix.push(prefix[i]! + estimateMessagesTokens([messages[i]!]));
  }
  // Largest boundary whose remainder still fits the target; at least the
  // first boundary so a firing prune always lands below the fire line.
  let end = userBoundaries[0]!;
  for (const boundary of userBoundaries) {
    if (estimate - (prefix[boundary]! - prefix[1]!) > target) {
      end = boundary;
    } else {
      break;
    }
  }
  // A boundary at index 1 leaves the protected first message followed by the
  // exact same tail. Do not prepend a marker for a zero-message cut: doing so
  // grows provider context precisely when pruning cannot relieve it.
  if (end <= 1) {
    return { messages: [...messages], dropped: 0, droppedTokens: 0, estimate };
  }
  const cutTokens = prefix[end]! - prefix[1]!;
  const kept = [messages[0]!, ...messages.slice(end)];
  const marker = {
    role: "user",
    content: [
      {
        type: "text",
        text: `[compaction summary] dropped ${end - 1} older in-flight messages (~${cutTokens} tokens) to stay inside the context window; the work goal and recent state are unchanged.`,
      },
    ],
  };
  return { messages: [marker, ...kept], dropped: end - 1, droppedTokens: cutTokens, estimate };
}

export function estimateMessagesTokensPublic(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): number {
  return estimateMessagesTokens(messages);
}

function estimateMessagesTokens(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += messageTokens(message);
  }
  return tokens;
}

/**
 * Slim-before-prune: shrink OLD content without dropping any message.
 * Old thinking is already-executed reasoning; old tool results are already
 * digested. Removing/clamping them reclaims the bulk of the budget (a real
 * envfix transcript was 55% thinking + 37% toolResult) while the recent
 * keepRounds stay lossless. Message count and pair structure never change,
 * so this is safe to run before every prune and keeps the sawtooth shallow.
 *
 * #223 R2: a result the host delivered with a recorded source is slimmed
 * structurally — from `details.result_source`, never by re-reading a handle
 * out of its text — so the kept ranges only narrow, the omission marker is
 * rebuilt for the reader the CURRENT profile holds (`readerAuthorised`), and
 * slimming again under the same budget returns the same bytes. A result
 * without a source is cut on code point boundaries in bytes and says its
 * omitted bytes cannot be read back.
 */
export function slimInFlightMessages(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
  opts: { keepRounds?: number; readerAuthorised?: boolean; budget?: number } = {},
): { messages: Array<{ role: string; content?: unknown }>; reclaimed: number; sourcesSlimmed: number; sourceOmittedBytes: number } {
  const keepRounds = opts.keepRounds ?? 3;
  const budget = opts.budget ?? RESULT_SLIM_BUDGET;
  const readerAuthorised = opts.readerAuthorised === true;
  // A "round" boundary: assistant message carrying tool calls. The last
  // keepRounds such rounds (and everything after) stay lossless.
  const assistantToolIdx: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((p) => p?.type === "toolCall")) {
      assistantToolIdx.push(i);
    }
  }
  const cutoff = assistantToolIdx.length > keepRounds
    ? assistantToolIdx[assistantToolIdx.length - keepRounds]!
    : 0;
  let reclaimed = 0;
  let sourcesSlimmed = 0;
  let sourceOmittedBytes = 0;
  const out = messages.map((m, i) => {
    if (i >= cutoff || !Array.isArray(m.content)) {
      return { ...m };
    }
    const parts = m.content as Array<Record<string, unknown>>;
    const details = (m as { details?: unknown }).details;
    const projection = m.role === "toolResult" ? readResultProjection(details) : undefined;
    const projectedPart = projection ? parts[projection.part] : undefined;
    const reprojected = projection && projectedPart?.type === "text" && typeof projectedPart.text === "string"
      ? reprojectResultText(projectedPart.text, projection, { budget, readerAuthorised })
      : undefined;
    const readBack = m.role === "toolResult" && !projection ? slimReadBack(parts, details, budget, readerAuthorised) : undefined;
    if (readBack) {
      reclaimed += readBack.reclaimed;
      return { ...m, content: readBack.parts, details: { ...(details as Record<string, unknown>), result_read: readBack.read } } as { role: string; content?: unknown };
    }
    const newParts: Array<Record<string, unknown>> = [];
    parts.forEach((part, index) => {
      if (part.type === "thinking" && !part.redacted) {
        reclaimed += JSON.stringify(part).length;
        return; // executed reasoning: remove entirely
      }
      if (reprojected && index === projection!.part) {
        const before = utf8Bytes(part.text as string);
        reclaimed += Math.max(0, before - reprojected.projection.visibleBytes);
        if (reprojected.text !== part.text) {
          sourcesSlimmed += 1;
          sourceOmittedBytes += reprojected.projection.omittedBytes - projection!.omittedBytes;
        }
        newParts.push({ ...part, text: reprojected.text });
        return;
      }
      // Tool results are pi ToolResultMessage-shaped: role "toolResult" with
      // a content array of TextContent/ImageContent.
      if (part.type === "text" && typeof part.text === "string" && m.role === "toolResult" && utf8Bytes(part.text) > budget) {
        const slimmed = slimUnsourcedText(part.text, budget);
        reclaimed += utf8Bytes(part.text) - utf8Bytes(slimmed);
        newParts.push({ ...part, text: slimmed });
        return;
      }
      newParts.push(part);
    });
    // An assistant message left with zero parts would be malformed; keep text parts.
    if (newParts.length === 0 && parts.length > 0) {
      newParts.push({ type: "text", text: "[earlier reasoning elided by context slimming]" });
    }
    const slimmedMessage: Record<string, unknown> = { ...m, content: newParts };
    if (reprojected && details && typeof details === "object") {
      slimmedMessage.details = { ...(details as Record<string, unknown>), result_source: reprojected.projection };
    } else if (projection && details && typeof details === "object") {
      // The part no longer holds the projected bytes: its projection is stale
      // and must not keep describing (or advertising) what is shown.
      const { result_source: _stale, ...rest } = details as Record<string, unknown>;
      slimmedMessage.details = rest;
    }
    return slimmedMessage as { role: string; content?: unknown };
  });
  return { messages: out, reclaimed, sourcesSlimmed, sourceOmittedBytes };
}

/** R6': a read-back is a read of its parent source, so slimming it leaves
 * one marker that names that read again (or states why it cannot be made). */
function readBackMarker(read: ResultRead, readerAuthorised: boolean): string {
  const how = readerAuthorised
    ? `read it again: ${RESULT_READER}(path="blob:${read.digest}", start_byte=${read.start}, end_byte=${read.end})`
    : "not recoverable here: this tool profile has no source reader";
  return `[read-back of source bytes ${read.start}-${read.end} of ${read.sourceBytes} omitted from context; ${how}]`;
}

function slimReadBack(
  parts: Array<Record<string, unknown>>,
  details: unknown,
  budget: number,
  readerAuthorised: boolean,
): { parts: Array<Record<string, unknown>>; read: ResultRead; reclaimed: number } | undefined {
  const read = readResultRead(details);
  const first = parts[0];
  if (!read || first?.type !== "text" || typeof first.text !== "string") return undefined;
  const digest = sha256Text(first.text);
  const recovery = readerAuthorised ? "available" : "unavailable";
  if (read.slimmed) {
    if (digest !== read.slimmed.digest || read.slimmed.recovery === recovery) return undefined;
  } else if (digest !== read.emittedDigest || utf8Bytes(first.text) <= budget) {
    return undefined;
  }
  const text = readBackMarker(read, readerAuthorised);
  return {
    parts: [{ ...first, text }, ...parts.slice(1)],
    read: { ...read, slimmed: { recovery, digest: sha256Text(text) } },
    reclaimed: Math.max(0, utf8Bytes(first.text) - utf8Bytes(text)),
  };
}

/**
 * #223 R3: a delivered projection states recovery for the tool profile it was
 * delivered under. When a later profile gains or loses the reader, every
 * projection whose stated recovery no longer holds is re-rendered at its own
 * budget (ranges only narrow), so the model is never pointed at a reader it
 * does not have — and is told when one appears. Messages whose recovery still
 * holds are returned as they are.
 */
export function refreshResultRecovery(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
  readerAuthorised: boolean,
): { messages: Array<{ role: string; content?: unknown }>; changed: number } {
  let changed = 0;
  const out = messages.map((message) => {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
    const details = (message as { details?: unknown }).details;
    const read = readResultRead(details);
    if (read?.slimmed) {
      const slimmed = slimReadBack(message.content as Array<Record<string, unknown>>, details, 0, readerAuthorised);
      if (!slimmed) return message;
      changed += 1;
      return { ...message, content: slimmed.parts, details: { ...(details as Record<string, unknown>), result_read: slimmed.read } } as { role: string; content?: unknown };
    }
    const projection = readResultProjection(details);
    if (!projection || projection.omittedBytes === 0) return message;
    const expected = resultRecovery(projection.source, readerAuthorised);
    if (expected.recovery === projection.recovery && (expected.limit ?? "") === (projection.limit ?? "")) return message;
    const parts = message.content as Array<Record<string, unknown>>;
    const part = parts[projection.part];
    if (part?.type !== "text" || typeof part.text !== "string") return message;
    const next = reprojectResultText(part.text, projection, { budget: projection.budget, readerAuthorised });
    if (!next || next.text === part.text) return message;
    changed += 1;
    return {
      ...message,
      content: parts.map((item, index) => index === projection.part ? { ...item, text: next.text } : item),
      details: { ...(details as Record<string, unknown>), result_source: next.projection },
    } as { role: string; content?: unknown };
  });
  return { messages: out as Array<{ role: string; content?: unknown }>, changed };
}
