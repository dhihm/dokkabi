import { isRecoveryTerminalError } from "../host/recovery.ts";
import { recoveringWorkLoop } from "./recovery-loop.ts";
import { liveWritersOf } from "../host/live-writers.ts";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { BlobStore } from "../host/blob-store.ts";
import { observedSecretDigests } from "../host/redact.ts";
import { readFailoverPolicyV1 } from "../host/config.ts";
import { deriveMessages } from "../host/derive-messages.ts";
import { createDigestCache, workspaceDigest, type DigestCache } from "../host/execution-receipt.ts";
import { recordedBaseCache, requireSessionBase, sessionDigestCache } from "./session-base.ts";
import { judgedGreenOn } from "./judged-evidence.ts";
import type { EventRecord } from "../host/schema.ts";
import { systemPromptHash } from "../host/prefix.ts";
import type { HostContext, LoopFacade, SessionBudgetSnapshot } from "../loader/types.ts";
import { operatorInboxPath, takeOperatorInbox, withOperatorNotes } from "./inbox.ts";
import { observedFailureReason } from "./model-loop.ts";
import { LEDGER_CASE_EVENT, LEDGER_EVENT, projectLedger } from "./plan-ledger.ts";
import { concludeLedgerRun, type LedgerStop, type LedgerStopReason } from "./ledger-conclude.ts";
import { workspaceHeadRef } from "./ledger-base.ts";
import type { LedgerLabelResult } from "./ledger-label.ts";
import type { ToolProfileName, ToolScope } from "../loader/tool-profiles.ts";

/**
 * The ledger-driven work session (interfaces-v3.md §0/§2): one model session
 * on driveModelLoop's control points — sealed order, failover refusal, one
 * pinned model, honest typed stops — with three additions: the plan ledger
 * (a tool, not a gate), ledger-driven continuation (one state-only line per
 * round) and a terminal row via concludeLedgerRun. No decompose, no seal, no
 * phases, and no in-band budget state line: the session budget handed to the
 * loop carries the wall minus the conclusion reserve as its deadline (and the
 * operator's opt-in --max-requests), always with `stateLine: false` — the host
 * enforces the budget at every request boundary, the model is never paced by
 * it. One last call (D25): until it has fired, an episode that begins with
 * more than one reserve left stops one reserve before the model deadline, so
 * a session that would otherwise run a single episode to the wall still meets
 * the continuation boundary — the one place the model decides whether to
 * finish — on a line that ends with the seconds left. One last word after it
 * (D33): a second, later boundary delivered under a closed tool profile that
 * exposes only `finish`, because text alone leaves the model reading the line
 * as status while it keeps working. Its reserve follows the session's own
 * request latency (D35) — the D33 constant is the floor, twice the median of
 * the last five completed requests raises it, the conclusion reserve caps it,
 * and every round boundary re-evaluates it. The wall deadline is
 * still enforced here between rounds, as the safety net for a round the loop
 * arrived at already spent.
 */

export interface LedgerLoopBudget {
  hours: number;
  maxRequests?: number;
}

export type LedgerLoopMode = "unattended" | "attended";

export interface LedgerLoopResult {
  stopReason: LedgerStopReason;
  detail?: string;
  rounds: number;
  steps: number;
  seconds: number;
  finish?: { seq: number; hash: string };
  /** The derived terminal result concludeLedgerRun returned (label and
   * exit_code included); the CLI turns it into the process exit code. */
  conclusion: LedgerLabelResult;
}

type LedgerTurnOptions = Parameters<LoopFacade["prompt"]>[1];

interface LedgerUsage {
  steps: number;
  tokens: { input: number; output: number; reasoning: number; cache_read: number };
}

const STALL_LIMIT = 3;
const DEFAULT_CONTINUE_CAP = 32;

/** The closed tool scope of the last word (D33): the projection loop-pi
 * applies per prompt, so the round after the last-word boundary offers the
 * model exactly one affordance — the only honest end. */
const LAST_WORD_TOOL_SCOPE: ToolScope = { todo: "last_word", profile: "last_word" };

/** The session's own scope (D39): the profile the whole session runs under,
 * when the operator named one. It is threaded exactly like the last word's —
 * a ToolScope on every turn, projected by loop-pi per request and recorded as
 * a `tool/profile` row — but it is the session's floor rather than a boundary
 * it crosses, so the last word still closes over it at the end. */
function sessionToolScope(profile: ToolProfileName | undefined): ToolScope | undefined {
  return profile === undefined || profile === "default" ? undefined : { todo: "session", profile };
}

/** The conclusion reserve: the share of the session's wall the episodes stop
 * short of, so the terminal pass (every ledger case run once on the final
 * tree) finishes before the wall instead of being killed mid-pass. One rule —
 * min(300 s, 20% of the session's wall allowance) — with no task-,
 * repository- or runner-specific term: the allowance is whatever the session
 * was given, and 300 s covers a handful of honest case runs at the ordinary
 * 120 s default while staying a small fraction of any real budget. */
const CONCLUSION_RESERVE_MAX_MS = 300_000;
const CONCLUSION_RESERVE_FRACTION = 0.2;

export function conclusionReserveMs(sessionAllowanceMs: number): number {
  return Math.min(CONCLUSION_RESERVE_MAX_MS, Math.max(0, sessionAllowanceMs) * CONCLUSION_RESERVE_FRACTION);
}

/** The last word's reserve (D33): the share of the conclusion reserve the
 * episodes stop short of a second time, after the last call — min(90 s, 30%
 * of the conclusion reserve) — short enough that the last word buys a
 * decision, not more work. Since D35 this is the FLOOR of the reserve a
 * session applies, not the whole of it: see lastWordReserveForSessionMs. */
const LAST_WORD_RESERVE_MAX_MS = 90_000;
const LAST_WORD_RESERVE_FRACTION = 0.3;

export function lastWordReserveMs(reserveMs: number): number {
  return Math.min(LAST_WORD_RESERVE_MAX_MS, Math.max(0, reserveMs) * LAST_WORD_RESERVE_FRACTION);
}

/** How many completed requests the observed latency is read from (D35): the
 * last few, because latency grows with context and the session's own recent
 * past is the only honest estimate of its next request. */
const LATENCY_WINDOW = 5;

/** The wall time of this session's recent model requests (D35): the median of
 * the last five completed ones, an integer in milliseconds, 0 before any
 * request has completed. A request is bracketed by the rows loop-pi already
 * writes — `provider/request` when the host admits the input, then
 * `provider/response` (or, where the route streams without the request audit,
 * the `model/usage` row of the reply) when it is done. An admitted request
 * that never completed contributes nothing. */
export function observedRequestLatencyMs(events: readonly EventRecord[]): number {
  const durations: number[] = [];
  let openedMs: number | undefined;
  for (const event of events) {
    if (event.name === "provider/request") {
      const started = Date.parse(event.ts);
      openedMs = Number.isFinite(started) ? started : undefined;
      continue;
    }
    if (openedMs === undefined) continue;
    if (event.name !== "provider/response" && event.name !== "model/usage") continue;
    const ended = Date.parse(event.ts);
    if (Number.isFinite(ended)) durations.push(Math.max(0, ended - openedMs));
    openedMs = undefined;
  }
  const window = durations.slice(-LATENCY_WINDOW).sort((a, b) => a - b);
  if (window.length === 0) return 0;
  const middle = Math.floor(window.length / 2);
  return window.length % 2 === 1
    ? Math.round(window[middle]!)
    : Math.round((window[middle - 1]! + window[middle]!) / 2);
}

/** The last-word reserve this session applies (D35): the D33 constant is the
 * floor, twice the observed request latency can only raise it, and the
 * conclusion reserve it lives inside is the ceiling. The constant was tuned
 * on 1800 s cohort sessions whose requests took 15–30 s; a 7200 s session at
 * 190 requests of context took ~140 s per request and delivered its last word
 * with 39 s left — less than a third of the request it still had to make. */
export function lastWordReserveForSessionMs(reserveMs: number, latencyMs: number): number {
  const floorMs = lastWordReserveMs(reserveMs);
  const ceilingMs = Math.max(0, reserveMs);
  return Math.min(Math.max(floorMs, 2 * Math.max(0, latencyMs)), ceilingMs);
}

/** The one state-only line a round without finish resumes on (§2): the
 * non-guard case count, the open todos and the cases without a green receipt
 * on the current tree — names and counts only, no advice. `no plan recorded`
 * when no ledger revision exists. With `secondsLeft` (what the driver always
 * passes: the seconds before the episodes stop) the line ends with
 * `time left: Ns` — floored, never negative, still state, not advice. */
export function ledgerContinuationLine(input: {
  events: readonly EventRecord[];
  workspaceRoot: string;
  secondsLeft?: number;
  /** The run's digest cache (D57d: every file of the tree is identified by
   * its content, so a fresh cache reads the whole tree). Absent: one over
   * the base the events name (C1, D57e). */
  digestCache?: DigestCache;
}): string {
  const latest = projectLedger(input.events);
  const timeLeft = input.secondsLeft === undefined
    ? ""
    : `; time left: ${Math.max(0, Math.floor(input.secondsLeft))}s`;
  if (!latest) return `no plan recorded${timeLeft}`;
  const current = currentWorkspaceDigest(input.workspaceRoot, input.digestCache ?? recordedBaseCache(input.events));
  const open = openTodoNames(latest.graph.todos);
  const nonGuard = latest.graph.cases.filter((item) => item.guard !== true).length;
  const withoutGreen = latest.graph.cases
    .filter((item) => !caseGreenOn(input.events, item.command, current))
    .map((item) => item.id);
  // G2 (D57g): while a background job of the session can still write the
  // tree, no image of it is known — the line says so (state, not advice).
  const writers = liveWritersOf(input.workspaceRoot);
  const live = writers.length === 0 ? "" : `; the tree is unknown while ${writers.length} background job${writers.length === 1 ? "" : "s"} that can write it run${writers.length === 1 ? "s" : ""}`;
  return `cases: ${nonGuard}; open todos: ${open.join(", ") || "none"}; cases without a green receipt on the current tree: ${withoutGreen.join(", ") || "none"}${live}${timeLeft}`;
}

/** The last word's line (D33): the ordinary continuation line, prefixed with
 * the one fact the closed tool profile makes true — the only tool available
 * now is finish. Still state only: no advice, no imperative; the prefix
 * states the surface, the line states the ledger, the seconds state the
 * clock. */
export function ledgerLastWordLine(input: {
  events: readonly EventRecord[];
  workspaceRoot: string;
  secondsLeft?: number;
  digestCache?: DigestCache;
}): string {
  return `last word (the only tool available now is finish); ${ledgerContinuationLine(input)}`;
}

/** Todos the model left open (status open or unset), in graph order. */
function openTodoNames(todos: readonly { id: string; status?: string }[]): string[] {
  return todos.filter((item) => (item.status ?? "open") === "open").map((item) => item.id);
}

/** A case is green on the current tree when some HOST-JUDGED run (a
 * `verify/receipt`: the probe, the host's passes, the recheck — V7, D57i)
 * ran exactly its command to exit 0 against the workspace digest the tree
 * has now; the session's own `exec/receipt` never makes it green. Both
 * images cover what the session's base decides (C1, D57e): a session that
 * drops a file from its index, flags it, or ignores it after the base still
 * changes the image when it changes the file, so no green receipt of an
 * earlier tree is carried onto it. */
function caseGreenOn(events: readonly EventRecord[], command: string, currentDigest: string): boolean {
  // G1 (D57g): a receipt whose tree changed (image ≠ image_after) is
  // evidence for neither image; one is credited only when the tree it ran
  // on is the tree it left, and that is the tree now.
  return judgedGreenOn(events, command, currentDigest);
}

function currentWorkspaceDigest(workspaceRoot: string, cache: DigestCache): string {
  try {
    return workspaceDigest(workspaceRoot, cache);
  } catch {
    // An unreadable tree digests to nothing: no case can be green on it.
    return "";
  }
}

export async function driveLedgerLoop(input: {
  ctx: HostContext;
  requireRecovery?: boolean;
  order: string;
  budget: LedgerLoopBudget;
  /** Continuation rounds before the cap stop (default 32). */
  continueCap?: number;
  mode: LedgerLoopMode;
  /** The tool profile every turn of this session is projected through, when
   * the operator named one (D39); absent leaves the full installed surface. */
  profile?: ToolProfileName;
  turn?: LedgerTurnOptions;
  /** The run's wall (supervisor ceiling folded with --budget-hours); caps the
   * session's own hours budget exactly as the model loop derives it. */
  deadlineMs?: number;
}): Promise<LedgerLoopResult> {
  const { ctx } = input;
  void input.mode;
  const log = ctx.log;
  const continueCap = input.continueCap ?? DEFAULT_CONTINUE_CAP;
  // The session's own scope, fixed for the whole run; the last word's closed
  // scope still replaces it on the rounds that deliver it.
  const sessionScope = sessionToolScope(input.profile);
  // The session's base (C1, D57e): established here at the latest — before
  // the first model request — or read back as the log names it; every image
  // of the run covers what it decides. None can be had: the session does not
  // start (B1, D57f). One digest cache for the run's continuation lines: the
  // tree is read once, then only what changed (D57d).
  requireSessionBase(ctx.log, ctx.workspaceRoot);
  const digestCache = sessionDigestCache(ctx.log, ctx.workspaceRoot);
  if (!ctx.loop) throw new Error("ledger loop requires a loop facade (ctx.loop missing after load)");
  const loop = recoveringWorkLoop(ctx, ctx.loop, { unattended: input.mode === "unattended", requireRecovery: input.requireRecovery, order: input.order, ...(input.budget.hours > 0 ? { defaultBudgetMs: input.budget.hours * 3_600_000 } : {}) });

  // Session state every stop reason reports, initialized before the first
  // refusal so an early stop can never touch an uninitialized binding.
  let rounds = 0;
  let sessionStartMs: number | undefined;
  const startedNs = process.hrtime.bigint();
  const elapsedSeconds = () => Math.max(
    sessionStartMs !== undefined ? (Date.now() - sessionStartMs) / 1_000 : 0,
    Number(process.hrtime.bigint() - startedNs) / 1e9,
  );

  const stop = (stopIn: LedgerStop, finishSeq?: EventRecord): LedgerLoopResult => {
    const used = usage(log.events);
    log.append({
      kind: "observe",
      name: "work/budget",
      payload: {
        step: used.steps,
        remaining_seconds: sessionStartMs !== undefined
          ? round3(Math.max(0, (sessionDeadlineMs(sessionStartMs, input) - Date.now()) / 1_000))
          : 0,
        tokens: used.tokens,
      },
    });
    const finished = log.events.find((event) => event.name === "work/finish");
    const conclusion = concludeLedgerRun({
      log,
      workspaceRoot: ctx.workspaceRoot,
      stop: stopIn,
      // The conclusion owes the wall its reserve: each case is bounded by the
      // time left before it. Stops before the session row exists (the two
      // refusals below) have no wall yet and conclude unbounded, exactly as
      // before — a session that never started has no cases to run.
      ...(sessionStartMs !== undefined ? { deadlineMs: sessionDeadlineMs(sessionStartMs, input) } : {}),
      ...(finished !== undefined && typeof finished.payload.summary_digest === "string"
        ? { finishSummary: { seq: finished.seq, hash: finished.hash, summary_digest: finished.payload.summary_digest } }
        : {}),
    });
    return {
      stopReason: stopIn.reason,
      ...(stopIn.detail !== undefined ? { detail: stopIn.detail } : {}),
      rounds,
      steps: used.steps,
      seconds: round3(elapsedSeconds()),
      ...(finishSeq !== undefined ? { finish: { seq: finishSeq.seq, hash: finishSeq.hash } } : {}),
      conclusion,
    };
  };

  // Failover must be off (§0): the same refusal the model loop makes, for the
  // same reason — no per-session pin exists, so a non-off policy would let a
  // second model in mid-run.
  const failoverPolicy = readFailoverPolicyV1();
  if (failoverPolicy.mode !== "off") {
    return stop({ reason: "provider_failure", detail: "model_loop_requires_failover_off" });
  }

  // The finish tool is the only honest end; a surface without it (or an
  // unknowable one) refuses before the first model request.
  const exposed = exposedToolNames(ctx, log.events);
  if (exposed === undefined || !exposed.includes("finish")) {
    return stop({
      reason: "provider_failure",
      detail: exposed === undefined ? "finish_tools_unknown" : "finish_tool_not_exposed",
    });
  }

  // 1. The order is sealed once, immutable, exactly as the model loop seals
  // it; a differing re-run order is refused before anything is appended.
  const sealedOrder = log.events.find((event) => event.name === "work/order");
  let fresh = false;
  if (sealedOrder) {
    const digest = sha256(input.order);
    if (input.order.trim().length > 0 && sealedOrder.payload.digest !== digest) {
      throw new Error(
        `work/order refused: this session already sealed a different order (${String(sealedOrder.payload.digest).slice(0, 12)}…)`,
      );
    }
  } else {
    if (input.order.trim().length === 0) {
      throw new Error("ledger loop requires an order: none given and none sealed in this session");
    }
    const blob = BlobStore.forSession(log.path).put(input.order);
    const observed = observedSecretDigests(input.order);
    log.append({
      kind: "observe",
      name: "work/order",
      // The order is READ by the session. A credential value it names is the
      // operator's, so the model cannot author it by repeating it (D36).
      payload: { blob, blob_bytes: Buffer.byteLength(input.order), digest: blob,
        ...(observed.length === 0 ? {} : { observed_secret_digests: observed }) },
    });
    fresh = true;
  }
  // The `plan` tool reads the order from the log's work/goal row (the same
  // row the graph loop's authorities read); the ledger session records it
  // once so `plan` can bind the host-owned goal statement.
  if (!log.events.some((event) => event.name === "work/goal")) {
    log.append({
      kind: "observe",
      name: "work/goal",
      payload: { id: "goal", statement: input.order, digest: "pending" },
    });
  }

  // 2. Session identity, once. The budget names the wall-only default and
  // the opt-in ceilings; no request ceiling exists unless the operator asked.
  // The session also records the workspace's HEAD at open — the base commit
  // the conclusion's base-tree observation restores to (LABEL-EVIDENCE C1).
  // Recording it AT OPEN is what makes a session whose model commits (its
  // work then moves HEAD) still observe cases against the tree it started
  // from. A workspace git cannot answer records nothing here; the conclusion
  // then finds no base and says not_runnable rather than guessing.
  let sessionEvent = log.events.find((event) => event.name === "work/ledger_session");
  if (!sessionEvent) {
    const baseRef = workspaceHeadRef(ctx.workspaceRoot);
    sessionEvent = log.append({
      kind: "observe",
      name: "work/ledger_session",
      payload: {
        planner: "ledger",
        route: ctx.llm?.activeName ?? "unknown",
        model: ctx.llm?.activeModelId ?? "unknown",
        failover: failoverPolicy.mode,
        manifest_digest: manifestDigest(log.events),
        prompt_digest: systemPromptHash(ctx.systemPrompt),
        ...(baseRef !== undefined ? { base_ref: baseRef } : {}),
        budget: {
          hours: input.budget.hours,
          continue_cap: continueCap,
          ...(input.budget.maxRequests !== undefined ? { max_requests: input.budget.maxRequests } : {}),
        },
      },
    });
  }
  const pinnedRoute = String(sessionEvent.payload.route ?? "unknown");
  const pinnedModel = String(sessionEvent.payload.model ?? "unknown");
  sessionStartMs = Date.parse(sessionEvent.ts);
  if (!Number.isFinite(sessionStartMs)) sessionStartMs = Date.now();
  const deadlineMs = sessionDeadlineMs(sessionStartMs, input);
  // The model's deadline is the wall minus the conclusion reserve: episodes
  // stop at a request boundary inside loop-pi (loop/budget_exhausted) early
  // enough that concludeLedgerRun's pass over the ledger cases still fits
  // before the wall. The driver enforces the same boundary between rounds.
  const reserveMs = conclusionReserveMs(deadlineMs - sessionStartMs);
  const modelDeadlineMs = deadlineMs - reserveMs;
  // One last call (D25): until it has fired, an episode that begins with more
  // than one reserve left stops at the last-call boundary instead — so the
  // run-7 shape, one episode that never stops, still meets the continuation
  // boundary where the model decides whether to finish. The episode that ends
  // there is not a stop: the next round delivers the continuation line
  // through prompt (not resume — the line must reach the model, even though
  // the derived last role is tool) and every episode after it carries the
  // real model deadline. A session whose wall is already within the two
  // reserves below of its birth has no last call; an exhaustion at or after
  // the model deadline stops as `deadline` exactly as before this rule
  // existed.
  // One last word after it (D33): a second, later boundary — a shorter
  // reserve before the episodes stop — whose round is delivered the same way
  // (prompt, never resume) but under the closed LAST_WORD_TOOL_SCOPE, because
  // run 13 showed the model reads the last-call line as status and keeps
  // working while finish is never gated: the closed profile leaves the
  // decision to end as the only affordance. From the moment it has fired,
  // every later turn in the session keeps the same scope — a text-only reply
  // or a stalled round must not reopen the full tool set. A session whose
  // last-word boundary is already past at its first round has no last word.
  // That shorter reserve follows the session's own request latency (D35): the
  // D33 constant is a floor, and twice the median wall time of the last five
  // completed requests raises it when a request costs more than the constant
  // buys — the real-work trial delivered its last word with 39 s left and
  // needed ~140 s for the request after it.
  let lastWordLatencyMs = observedRequestLatencyMs(log.events);
  let lastWordReserveApplied = lastWordReserveForSessionMs(reserveMs, lastWordLatencyMs);
  let lastWordMs = modelDeadlineMs - lastWordReserveApplied;
  let lastWordFired = lastWordMs <= Date.now();
  let lastWordPending = false;
  // The last call sits one full conclusion reserve BEFORE the last word
  // (D25 + D35), so a last word that moves earlier moves the last call
  // earlier by the same amount and the round between them keeps its whole
  // reserve. A session whose wall is already within these of its birth has
  // neither, exactly as before.
  let lastCallMs = lastWordMs - reserveMs;
  let lastCallFired = lastCallMs <= Date.now();
  let lastCallPending = false;
  // The pair the boundary that actually fired was chosen from — the numbers
  // the work/last_word row carries as data, captured when it fires so a later
  // round's re-evaluation cannot rewrite them.
  let firedLatencyMs = lastWordLatencyMs;
  let firedReserveMs = lastWordReserveApplied;
  // The scope follows DELIVERY, not the boundary flag: a session born within
  // one last-word reserve of its wall has no last word (the flag starts
  // fired, as the last call's does) and keeps its full tool set.
  let lastWordDelivered = false;
  const inboxPath = operatorInboxPath(dirname(log.path));
  const orderDelivered = () => log.events.some((event) => event.name === "user/message");
  let firstTurn = true;
  let stallCount = 0;
  let lastProgressSignature = progressSignature(log.events);

  const appendBudgetRow = (step: number, tokens: LedgerUsage["tokens"]): void => {
    log.append({
      kind: "observe",
      name: "work/budget",
      payload: {
        step,
        remaining_seconds: round3(Math.max(0, (deadlineMs - Date.now()) / 1_000)),
        tokens,
      },
    });
  };

  /** Records the round's work/continue row and returns its payload — the
   * fields the last-word row repeats beside it; undefined when the
   * continuation cap is spent. */
  const continuationRow = ():
    | { round: number; open_todos: string[]; cases_without_green: string[]; seconds_left: number }
    | undefined => {
    rounds += 1;
    if (rounds > continueCap) return undefined;
    const latest = projectLedger(log.events);
    let openTodos: string[] = [];
    let casesWithoutGreen: string[] = [];
    if (latest) {
      const current = currentWorkspaceDigest(ctx.workspaceRoot, digestCache);
      openTodos = openTodoNames(latest.graph.todos);
      casesWithoutGreen = latest.graph.cases
        .filter((item) => !caseGreenOn(log.events, item.command, current))
        .map((item) => item.id);
    }
    const secondsLeft = Math.max(0, Math.floor((modelDeadlineMs - Date.now()) / 1_000));
    const row = { round: rounds, open_todos: openTodos, cases_without_green: casesWithoutGreen, seconds_left: secondsLeft };
    log.append({ kind: "observe", name: "work/continue", payload: row });
    return row;
  };

  /** The round's state-only line (ending with the seconds before the episodes
   * stop); undefined when the continuation cap is spent. */
  const continuation = (): string | undefined => {
    const row = continuationRow();
    if (row === undefined) return undefined;
    return ledgerContinuationLine({ events: log.events, workspaceRoot: ctx.workspaceRoot, secondsLeft: row.seconds_left, digestCache });
  };

  /** The three-step ladder of episode boundaries (D25 + D33 + D35): until the
   * last call has fired, an episode that begins before the last-call boundary
   * stops there; after it, until the last word has fired, an episode that
   * begins before the last-word boundary stops there; every episode after
   * that carries the model deadline. An episode that begins already past its
   * step's boundary uses the next one — the same guard D25 gives the last
   * call. The two earlier rungs are the bindings the round boundary above
   * re-evaluates, so the ladder reads whatever this round's observed latency
   * bought. */
  const episodeDeadlineMs = (): number => {
    if (!lastCallFired && Date.now() < lastCallMs) return lastCallMs;
    if (!lastWordFired && Date.now() < lastWordMs) return lastWordMs;
    return modelDeadlineMs;
  };

  // 3. The rounds. Each prompt()/resume() call is one model episode; an
  // episode that ends without finish gets ONE state-only continuation line.
  for (;;) {
    if (Date.now() >= modelDeadlineMs) return stop({ reason: "deadline" });
    const used = usage(log.events);
    if (input.budget.maxRequests !== undefined && used.steps >= input.budget.maxRequests) {
      return stop({ reason: "continue_cap", detail: "max_requests" });
    }
    // The reserve is re-evaluated at every round boundary (D35): latency
    // grows with context, so a session whose requests get slower buys itself
    // a wider last word — and its last call with it. This runs BETWEEN
    // episodes only: the boundary a running episode was given never moves
    // mid-episode. Both consumers read the fired flags, so recomputing after
    // a boundary has fired changes nothing.
    lastWordLatencyMs = observedRequestLatencyMs(log.events);
    lastWordReserveApplied = lastWordReserveForSessionMs(reserveMs, lastWordLatencyMs);
    lastWordMs = modelDeadlineMs - lastWordReserveApplied;
    lastCallMs = lastWordMs - reserveMs;

    const before = log.events.length;
    const inbox = takeOperatorInbox(inboxPath);
    // The model deadline reaches loop-pi so a model that never stops still
    // ends its episode at a request boundary (loop/budget_exhausted): one
    // prompt() is a whole episode, so a wall the driver checks only between
    // episodes never bounds it. Until the last call has fired, an episode
    // that begins early enough stops at the last-call boundary instead — one
    // reserve earlier — buying the continuation round its line is delivered
    // in; after it, until the last word has fired, an episode that begins
    // early enough stops at the last-word boundary — the same mechanism one
    // shorter reserve later. `stateLine: false` keeps the in-band budget line
    // out of the model's band even with the deadline set — the host
    // enforces, the model is not paced by it. The observe callback still
    // reports before every request, so work/budget rows stay as
    // observations.
    const sessionBudget = {
      deadlineMs: episodeDeadlineMs(),
      ...(input.budget.maxRequests !== undefined ? { maxRequests: input.budget.maxRequests } : {}),
      stateLine: false,
      requestsSoFar: used.steps,
      observe: (state: SessionBudgetSnapshot) => {
        appendBudgetRow(state.requests_used, usage(log.events).tokens);
      },
    };
    // From the round that delivers the last word on, every turn in this
    // session — prompt or resume — carries the closed finish-only scope.
    const turn: LedgerTurnOptions = {
      ...input.turn,
      sessionBudget,
      ...(sessionScope === undefined ? {} : { toolScope: sessionScope }),
      ...(lastWordPending || lastWordDelivered ? { toolScope: LAST_WORD_TOOL_SCOPE } : {}),
    };
    try {
      if (firstTurn && (fresh || !orderDelivered())) {
        // The first turn (or a crash before the order was ever delivered):
        // the order itself, not a continuation line.
        await loop.prompt(withOperatorNotes(inbox.notes, input.order), turn);
      } else if (lastCallPending) {
        // The last call's continuation: prompt, never resume — the episode
        // ended on a tool-result suffix and the line must reach the model.
        const line = continuation();
        if (line === undefined) return stop({ reason: "continue_cap", detail: "rounds" });
        lastCallPending = false;
        await loop.prompt(withOperatorNotes(inbox.notes, line), turn);
      } else if (lastWordPending) {
        // The last word: the same state the continuation line carries,
        // prefixed with the one fact the closed profile makes true, and
        // recorded as a work/last_word row beside this round's work/continue
        // row. Prompt, never resume — the line must reach the model.
        const row = continuationRow();
        if (row === undefined) return stop({ reason: "continue_cap", detail: "rounds" });
        lastWordPending = false;
        lastWordDelivered = true;
        log.append({
          kind: "observe",
          name: "work/last_word",
          payload: {
            ...row,
            latency_ms: Math.round(firedLatencyMs),
            reserve_ms: Math.round(firedReserveMs),
          },
        });
        await loop.prompt(
          withOperatorNotes(
            inbox.notes,
            ledgerLastWordLine({ events: log.events, workspaceRoot: ctx.workspaceRoot, secondsLeft: row.seconds_left, digestCache }),
          ),
          turn,
        );
      } else if (inbox.notes.length > 0) {
        const line = continuation();
        if (line === undefined) return stop({ reason: "continue_cap", detail: "rounds" });
        await loop.prompt(withOperatorNotes(inbox.notes, line), turn);
      } else {
        const lastRole = deriveMessages(log.events).at(-1)?.role;
        if ((lastRole === "user" || lastRole === "tool") && loop.resume) {
          // A stop mid-turn leaves a user/toolResult suffix: continue without
          // appending another operator message.
          await loop.resume(turn);
        } else {
          const line = continuation();
          if (line === undefined) return stop({ reason: "continue_cap", detail: "rounds" });
          await loop.prompt(line, turn);
        }
      }
      inbox.commit();
    } catch (error) {
      inbox.rollback();
      if (isRecoveryTerminalError(error)) throw error;
      const reason = observedFailureReason(log.events, sessionEvent.seq, error);
      if (/operator_abort/.test(reason)) return stop({ reason: "operator_stop" });
      return stop({ reason: "provider_failure", detail: reason });
    } finally {
      firstTurn = false;
    }

    // One model judges: a recorded move to another route or model ends the
    // run honestly instead of continuing on the intervening one.
    const intervened = log.events.filter((event) => event.seq > sessionEvent.seq).some((event) => {
      if (event.name !== "model/route_transition" && event.name !== "model/failover") return false;
      const target = transitionTarget(event);
      return target === undefined || target.route !== pinnedRoute || target.model !== pinnedModel;
    });
    if (intervened) return stop({ reason: "provider_failure", detail: "route_transition_refused" });

    const finishedRow = log.events.slice(before).find((event) => event.name === "work/finish");
    if (finishedRow) return stop({ reason: "finished" }, finishedRow);

    // The deadline (and the opt-in request ceiling) can end an episode inside
    // loop-pi (loop/budget_exhausted); the driver-side check above catches it
    // on the next round, this catches the round it happened in.
    const budgetStop = log.events.slice(before).find(
      (event) => event.name === "loop/budget_exhausted" && event.payload.scope === "session",
    );
    if (budgetStop) {
      if (
        budgetStop.payload.reason === "deadline" && !lastCallFired && Date.now() < modelDeadlineMs
      ) {
        // The last call: the episode stopped at the earlier boundary while
        // the episodes' own deadline is still ahead — the next round delivers
        // the continuation line rather than stopping.
        lastCallFired = true;
        lastCallPending = true;
      } else if (
        budgetStop.payload.reason === "deadline" && lastCallFired && !lastWordFired
        && Date.now() < modelDeadlineMs
      ) {
        // The last word: the episode stopped at the second boundary — one
        // shorter reserve before the episodes stop — while the model deadline
        // is still ahead. Not a stop either: the next round delivers the
        // last-word line under the finish-only profile.
        lastWordFired = true;
        lastWordPending = true;
        firedLatencyMs = lastWordLatencyMs;
        firedReserveMs = lastWordReserveApplied;
      } else {
        return stop(budgetStop.payload.reason === "requests"
          ? { reason: "continue_cap", detail: "max_requests" }
          : { reason: "deadline" });
      }
    }

    // Stall guard: rounds with no new tool call, receipt or ledger revision.
    const signature = progressSignature(log.events);
    if (signature === lastProgressSignature) {
      stallCount += 1;
      if (stallCount >= STALL_LIMIT) return stop({ reason: "stalled" });
    } else {
      stallCount = 0;
      lastProgressSignature = signature;
    }
  }
}

/** The wall this session enforces: its own hours budget from the session
 * row's birth, capped by the run's supervisor ceiling when the caller knows
 * one — the same derivation as driveModelLoop's episode deadline. */
function sessionDeadlineMs(
  startMs: number,
  input: { budget: LedgerLoopBudget; deadlineMs?: number },
): number {
  return [
    startMs + input.budget.hours * 3_600_000,
    ...(input.deadlineMs !== undefined ? [input.deadlineMs] : []),
  ].reduce((a, b) => Math.min(a, b));
}

/** What counts as progress between rounds: tool calls, execution receipts,
 * and ledger revisions. Names only — replay recomputes the same counts. */
export function progressSignature(events: readonly EventRecord[]): string {
  let toolCalls = 0;
  let receipts = 0;
  let revisions = 0;
  for (const event of events) {
    if (event.name === "tool/call" || event.name === "tool/start") toolCalls += 1;
    else if (event.name === "exec/receipt" || event.name === "verify/receipt") receipts += 1;
    else if (event.name === LEDGER_EVENT || event.name === LEDGER_CASE_EVENT) revisions += 1;
  }
  return `${toolCalls}:${receipts}:${revisions}`;
}

/** The tool names this session exposes (same shape as the model loop's
 * precondition; model-loop.ts keeps its own copy private). */
function exposedToolNames(ctx: HostContext, events: readonly EventRecord[]): string[] | undefined {
  const tools = ctx.tryGet<readonly { name?: unknown }[]>("tools");
  if (Array.isArray(tools)) {
    return tools.filter((tool) => typeof tool?.name === "string").map((tool) => String(tool.name));
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name !== "tool/profile" || !Array.isArray(event.payload.tools)) continue;
    const names = event.payload.tools.filter((name): name is string => typeof name === "string");
    if (names.length > 0) return names;
  }
  return undefined;
}

function usage(events: readonly EventRecord[]): LedgerUsage {
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0 };
  let steps = 0;
  for (const event of events) {
    if (event.name !== "model/usage") continue;
    steps += 1;
    const row = event.observe?.model_usage;
    tokens.input += metric(row?.input_tokens);
    tokens.output += metric(row?.output_tokens);
    tokens.reasoning += metric(row?.reasoning_tokens);
    tokens.cache_read += metric(row?.cache_read_tokens);
  }
  return { steps, tokens };
}

function metric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function transitionTarget(event: EventRecord): { route: string; model: string } | undefined {
  if (event.name === "model/route_transition") {
    const to = event.payload.to as { route?: unknown; model?: unknown } | undefined;
    if (typeof to?.route === "string" && typeof to?.model === "string") return { route: to.route, model: to.model };
    return undefined;
  }
  const metadata = event.payload.metadata as { route?: unknown; model_id?: unknown } | undefined;
  if (typeof metadata?.route === "string" && typeof metadata?.model_id === "string") {
    return { route: metadata.route, model: metadata.model_id };
  }
  return undefined;
}

function manifestDigest(events: readonly EventRecord[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name === "session/open" && typeof event.payload.plugin_manifest_digest === "string") {
      return event.payload.plugin_manifest_digest;
    }
  }
  return "unknown";
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
