/**
 * R2 workbench wire boundary for the desktop gateway.
 *
 * A closed JSON-RPC surface (`workbench.*`) over the authenticated desktop
 * gateway for one recorded workspace session. The app is never a competing
 * workspace or checkpoint authority: every mutation still goes through the
 * embedded chat kernel's frontend seam, every read is a projection of the
 * session EventLog, and every command carries a durable intent before any
 * effect (constitution 1 and 2).
 *
 * Evidence labels are deliberately precise and never overclaim:
 * - A `workbench/submit_receipt` (note delivery "prompt") proves HANDOFF to
 *   the chat frontend, not that a provider received a model request.
 * - A session `chat/turn_accepted` row proves a durable model-facing
 *   user/message record (the folded text the model will see), not provider
 *   delivery — an unconfigured route still leaves accepted input behind.
 *   The row carries the actual user/message seq and hash, so message
 *   linkage is derived from that recorded source, never guessed.
 * - `chat/turn_settled` is the turn's own outcome (success / failure /
 *   operator_abort). None of these are verified work: graph verification
 *   remains the harness's separate authority.
 * - The transcript projection carries the actual recorded user/message rows
 *   (including any inbox-folded text), never the caller's optimistic input.
 *
 * Durability and authority rules this module obeys:
 * - Requests are strictly validated: `version: 1` plus exactly the declared
 *   fields. Unknown keys, invalid ids and unsupported actions fail before
 *   any effect. Tokens never appear in rows, cursors or errors.
 * - The persisted ledger is rebuilt and chain-verified from disk BEFORE the
 *   first append and refreshed before every read/dedup/cancel decision, so
 *   an external append or a replaced chain is never silently ignored.
 * - Every effect (kernel handoff, abort) is preceded by a durable intent
 *   with a canonical fingerprint. Same id + different canonical payload,
 *   target, binding or operation ALWAYS conflicts. A crash between intent
 *   and receipt is `unknown` and is never blindly replayed. An append
 *   rejection means zero effects. Binding earns its name in two durable
 *   steps: `workbench/bind_intent` lands BEFORE the kernel boots (an append
 *   rejection refuses the bind with zero kernel opens), `workbench/bound`
 *   lands only AFTER a successful boot, and a failed boot records
 *   `workbench/bind_failed` with a redacted reason — a pending or failed
 *   intent is never disguised as a completed binding. A boot whose
 *   completion append fails leaves the intent as an uncertain reserved
 *   claim: no successful RPC, no foreign takeover. The outstanding claim
 *   (pending intent, failed boot, or bound-without-detach) is rebuilt from
 *   the verified ledger at restart, so a foreign thread can never take an
 *   unpublished claim. Detach obeys the same order: the durable row lands
 *   BEFORE any binding state changes, so a rejected detach keeps the
 *   association. A submitNote that throws mid-delivery is recorded as
 *   uncertain — unknown, never rejected without proof. Cancellation
 *   requested is not settlement: the command stays active until its durable
 *   settlement row lands.
 * - Binding is one stable client/thread pair over the gateway's real
 *   workspace; repeating it reconnects, a second thread is refused. Detach
 *   releases only the transport association: unresolved commands keep their
 *   owning binding, so only that owner can rebind. New submits are blocked
 *   while any command of the binding is unresolved — a fresh, idle kernel
 *   never erases that uncertainty.
 * - Submit checks run fail-closed immediately before a synchronous kernel
 *   handoff, so a workbench submit never silently stages an inbox note
 *   (queueing stays a legacy CLI behavior). If staging nevertheless occurs
 *   it is recorded as `staged` — a real, visible harness inbox state — and
 *   never labeled rejected.
 * - Cancellation targets the active command only, deduplicates by its own
 *   stable id, and never pops a staged inbox note. Requested cancellation is
 *   not settlement.
 * - Reads return the complete verified transcript projection with the two
 *   independent heads (session and gateway logs). Cursor seq/hash/generation
 *   are validated against the source chain including genesis; a replaced log
 *   forces an explicit resnapshot instead of splicing views.
 * - R2 cannot truthfully represent inherited operator-inbox state (staged
 *   notes the harness would fold into a later turn), so a binding or submit
 *   that would inherit staged notes is rejected rather than mispresented.
 * - Detach releases the transport binding only; the kernel keeps running and
 *   the same owner may rebind.
 * - While a binding or unresolved command owns the workspace, the shared
 *   server's legacy chat.* mutations and note submits for the owned session
 *   refuse before any effect, with the rejection recorded in the gateway
 *   audit log. The ownership decision and the legacy effect run as ONE step
 *   on this gateway's serialized mutation chain (`runLegacyMutation`), so a
 *   concurrent bind/detach can never interleave between the check and the
 *   effect. With no workbench owner the legacy surfaces keep their semantics
 *   unchanged.
 */

import type { BranchCheckpointService } from "../host/branch-checkpoint.ts";
import { projectBranchDecisions, type BranchDecisionService, type DecisionOpenRequest, type DecisionSnapshot } from "../host/branch-decision.ts";
import { projectBranchRuntime, type BranchRuntimeStartView, type DesktopBranchRuntime } from "../chat/desktop-branch-runtime.ts";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import { readConfig, resolveLlmSelection } from "../host/config.ts";
import { EventLog } from "../host/event-log.ts";
import { workspaceSessionId } from "../host/paths.ts";
import { PERMISSION_MODE_ENV, resolvePermissionMode, type PermissionMode } from "../host/permissions.ts";
import { redactText } from "../host/redact.ts";
import { GENESIS_HASH, type EventRecord } from "../host/schema.ts";
import { pendingNoteState } from "../work/inbox.ts";
import type {
  SessionWorkModeService,
  WorkModeCommandOutcome,
  WorkModeSelection,
} from "../chat/work-mode.ts";
import {
  projectContextOverview,
  projectUsageOverview,
  projectWorkOverview,
} from "./workbench-overview.ts";
import { openChildUsageLog, projectWorkbenchUsage, type WorkbenchUsageResponse } from "./workbench-usage.ts";
import { projectContextGraphView, projectWorkGraphView, type WorkbenchGraphType } from "./workbench-graph.ts";
import { projectGraphExplore, normalizeGraphExploreQuery } from "./workbench-graph-explorer.ts";
import { WorkbenchRecordExplorer } from "./workbench-record-explorer.ts";
import { projectWorkbenchDecisions } from "./workbench-decisions.ts";
import {
  parseRecordLimit,
  projectRecordPage,
  resolveRecordCursor,
  WORKBENCH_RECORD_DECISIONS,
  type WorkbenchRecordAsOf,
  type WorkbenchRecordCursor,
} from "./workbench-record.ts";
import { readWorkbenchCode } from "./workbench-code.ts";
import { openGatewayLog } from "./gateway-log.ts";
import { observerResumeRequest, type CodeObserverState } from "../code-evolution/observer-state.ts";
import { CodeVersionRefusal } from "../code-evolution/material.ts";
import { projectTranscript, type TranscriptCard } from "./transcript.ts";

export type { TranscriptCard };

/** The subset of the embedded chat kernel the workbench boundary needs. */
export interface WorkbenchKernelHandle {
  readonly sessionId: string;
  /** Frontend note submit; a tracked submit carries the command id. */
  submitNote(text: string, commandId?: string): "prompt" | "inbox" | "ignored";
  /** Abort the in-flight turn without popping a staged inbox note. */
  abortActive(): boolean;
  busy(): boolean;
  routeStatus(): Promise<{ route: string; model?: string; ready: boolean; reason?: string }>;
  setModel?(choice: string): Promise<import("../chat/model-control.ts").LiveModelSelectionResult>;
  /** The live model identity of this kernel's own llm facade — trusted
   * host-only material for the R8-05 child dispatch guard; no provider
   * request. Optional so deterministic test doubles may omit it. */
  currentModelSelection?(): { route: string; provider: string; model: string } | undefined;
  /**
   * The permission mode currently in force, when the kernel can report it.
   * Optional so deterministic test doubles may omit it; the real desktop
   * kernel always provides it (its live controller mode).
   */
  permissionMode?(): PermissionMode;
  /** Optional host plugin capability; no app-owned restore or branch. */
  checkpointService?(): Pick<BranchCheckpointService, "capture" | "read"> | undefined;
  /** Optional host-only durable decision capability (R8-04). */
  decisionService?(): BranchDecisionService | undefined;
  /** Optional host-only runnable branch runtime capability (R8-05). */
  branchRuntime?(): DesktopBranchRuntime | undefined;
  /** Optional host-only session work-mode capability (R8-06j2): explicit
   * Default/Chat/Work selection for this kernel's own session. Kernels and
   * deterministic test doubles without it answer unsupported. */
  workModeService?(): SessionWorkModeService | undefined;
  codeObserverService?(): {
    status(): CodeObserverState;
    resume(input: unknown): { commandId: string; seq: number; hash: string };
  } | undefined;
  /**
   * Host-only mutable dispatch readiness guard (R8-05): a branch child
   * kernel handle supplies it, and the submit path calls it immediately
   * before the durable submit intent/handoff — current owned
   * workspace/input/context and recorded source/model identity. The
   * ordinary request context is still applied later at the actual provider
   * request. Absent on ordinary kernels.
   */
  assertBranchDispatchReady?(): void;
}

export interface WorkbenchGatewayConfig {
  workspaceCwd: string;
  sessionsRoot: string;
  gatewayLogPath: string;
  /** Opens (or returns the already open) kernel with resume semantics. */
  openKernel(): Promise<WorkbenchKernelHandle>;
  /** The currently open kernel, if any. */
  getKernel(): WorkbenchKernelHandle | undefined;
  /** Host-owned catalog metadata; discovery never calls a reasoning model. */
  listModels?(): Promise<readonly WorkbenchModel[]>;
  /**
   * Trusted configured session id (R8-05): a branch child gateway is
   * constructed with its explicit host-derived child session id so
   * unbooted/restarted reads can never fall back to the workspace-derived
   * session of another workspace. Host authority only, never wire input.
   */
  sessionId?: string;
  /** Trusted pre-established transport binding for a branch child gateway:
   * the recorded child owner pair from the confirmed ready completion. */
  binding?: { clientId: string; threadId: string };
  /** Trusted configured model identity for a branch child gateway: the
   * exact recorded workspace policy. A cold child handshake reports THIS —
   * honestly not-probed — instead of the global/parent configured
   * selection, so it cannot lie after parent config changes. The normal
   * default gateway remains unchanged. */
  modelIdentity?: { route: string; provider: string; model: string };
}

export interface WorkbenchModel {
  route: string;
  provider: string;
  model: string;
  name: string;
  connected: boolean;
}

export const WORKBENCH_PROTOCOL_VERSION = 1;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUBMIT_TEXT_MAX_CHARS = 1_000_000;
const WORKBENCH_CAPABILITIES = {
  submit: true,
  cancel: true,
  read: true,
  detach: true,
  attachments: false,
  continuation: false,
  compaction: false,
  rollback: false,
  approvals: false,
  userInput: false,
  modelChange: false,
  /** R8-06j2: the additive workbench.workMode method family. A kernel
   * without the optional host capability still answers unsupported. */
  workMode: true,
  codeAction: true,
} as const;

/**
 * Command state, ordered by evidence strength. Each transition is grounded
 * in a named durable record; nothing is inferred from kernel idleness.
 *
 * - `unknown`: no record at all, or an intent whose handoff is unproven.
 * - `rejected`: the submit failed before any effect (recorded reason).
 * - `staged`: the note landed in the harness operator inbox — a real,
 *   visible queue state the harness may later fold into a turn. Prevented
 *   by the fail-closed submit checks; recorded honestly if it ever happens.
 * - `handed_off`: the frontend accepted the note (`workbench/submit_receipt`
 *   plus, when present, the session's `chat/turn_started` row). This is NOT
 *   model delivery.
 * - `accepted`: a durable model-facing user/message exists
 *   (`chat/turn_accepted` carrying that row's seq/hash), with the recorded
 *   (possibly inbox-folded) text.
 * - `settled`: the turn ended with a recorded success/failure/operator_abort
 *   outcome. Settlement of the turn is still not verified work.
 */
export type WorkbenchCommandState =
  | "unknown"
  | "rejected"
  | "staged"
  | "handed_off"
  | "accepted"
  | "settled";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Canonical payload fingerprint for submit deduplication. */
export function submitFingerprint(commandId: string, text: string): string {
  return sha256Hex(canonicalJson({ operation: "submit", command_id: commandId, text }));
}

/** Canonical fingerprint for cancellation deduplication: id, target, binding. */
export function cancelFingerprint(input: {
  commandId: string;
  targetCommandId: string;
  clientId: string;
  threadId: string;
}): string {
  return sha256Hex(
    canonicalJson({
      operation: "cancel",
      command_id: input.commandId,
      target_command_id: input.targetCommandId,
      client_id: input.clientId,
      thread_id: input.threadId,
    }),
  );
}

interface LedgerEntry {
  readonly commandId: string;
  fingerprint: string;
  clientId?: string;
  threadId?: string;
  sessionId?: string;
  /** Frontend handoff receipt, when provable. */
  handedOff?: boolean;
  /** Recorded refusal reason, when the submit failed before effects. */
  refused?: string;
  /** Recorded uncertainty: submitNote threw with a possible effect. */
  uncertain?: string;
  /** The note staged into the harness operator inbox (never "rejected"). */
  staged?: string;
  /** Settlement outcome recorded in the gateway ledger. */
  settledOutcome?: "success" | "failure" | "operator_abort";
}

interface CancelEntry {
  fingerprint: string;
  targetCommandId: string;
  /** Receipt: whether the abort actually happened. Absent = unknown. */
  accepted?: boolean;
}

interface SessionLifecycle {
  startedSeq?: number;
  /** Recorded ts of the verified `chat/turn_started` row at `startedSeq`. */
  startedTs?: string;
  acceptedSeq?: number;
  settledSeq?: number;
  /** Recorded ts of the verified `chat/turn_settled` row at `settledSeq`. */
  settledTs?: string;
  settledOutcome?: "success" | "failure" | "operator_abort";
  /**
   * Seq/hash of the actual durable user/message for this command, copied
   * onto the acceptance record by the kernel — never guessed here.
   */
  message?: { seq: number; hash: string };
}

interface Binding {
  clientId: string;
  threadId: string;
  sessionId: string;
}

/**
 * The outstanding binding claim, derived ONLY from the verified durable
 * ledger so it survives a restart:
 * - `intent` — a bind intent recorded before a boot whose outcome is not yet
 *   completed (in-flight, crashed before boot, or a boot whose completion
 *   append failed). Conservative: it reserves the binding.
 * - `failed` — the boot failed after the intent. Still conservative until
 *   the recorded owner reconciles (rebinds) or detaches.
 * - `bound` — a boot completed and its durable completion row landed. The
 *   claim releases only on a recorded detach.
 */
interface BindingClaim {
  readonly clientId: string;
  readonly threadId: string;
  state: "intent" | "failed" | "bound";
  sessionId?: string;
}

/**
 * A workbench read card: the legacy transcript projection, with tool cards
 * optionally carrying their correlated completion references. The pair is
 * present together or absent together; `durationMs` remains an independent
 * measurement and is never completion evidence.
 */
export type WorkbenchCard =
  | Exclude<TranscriptCard, { kind: "tool" }>
  | (Extract<TranscriptCard, { kind: "tool" }> & {
    completionSeq?: number;
    completionHash?: string;
  });

/**
 * Correlated tool completion references for the workbench projection. A
 * tool/start completes ONLY at the recorded tool/end of its own invocation:
 * result text, an available duration, kernel idleness or a model claim are
 * never completion evidence. Under id reuse an end closes the most recent
 * unmatched start of that id — the same attribution the legacy projection
 * gives duration/error — so a later invocation's end never attaches to an
 * earlier card.
 */
function toolCompletionRefs(events: readonly EventRecord[]): Map<number, { seq: number; hash: string }> {
  const openByInvocationId = new Map<string, number[]>();
  const completed = new Map<number, { seq: number; hash: string }>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.name === "tool/start" && typeof payload.id === "string") {
      const starts = openByInvocationId.get(payload.id) ?? [];
      starts.push(event.seq);
      openByInvocationId.set(payload.id, starts);
      continue;
    }
    if (event.name === "tool/end" && typeof payload.id === "string") {
      const starts = openByInvocationId.get(payload.id);
      const startSeq = starts?.pop();
      if (startSeq !== undefined) {
        completed.set(startSeq, { seq: event.seq, hash: event.hash });
      }
      continue;
    }
  }
  return completed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, allowed: readonly string[], context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${context}: unknown field '${key}'`);
    }
  }
  return value;
}

function requireVersion(params: Record<string, unknown>): void {
  if (params.version !== WORKBENCH_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported workbench protocol version ${JSON.stringify(params.version)} — expected ${WORKBENCH_PROTOCOL_VERSION}`,
    );
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`invalid ${label} ${JSON.stringify(String(value))}`);
  }
  return value;
}

function requireBindingFields(value: unknown): { clientId: string; threadId: string } {
  const binding = requireObject(value, ["clientId", "threadId"], "binding");
  return {
    clientId: requireId(binding.clientId, "binding clientId"),
    threadId: requireId(binding.threadId, "binding threadId"),
  };
}

function parseOutcome(value: unknown): "success" | "failure" | "operator_abort" | undefined {
  return value === "success" || value === "failure" || value === "operator_abort" ? value : undefined;
}

interface LogHead {
  seq: number;
  hash: string;
  generation: string;
}

function logHead(events: readonly EventRecord[]): LogHead {
  const first = events[0];
  const last = events.at(-1);
  return {
    seq: last?.seq ?? 0,
    hash: last?.hash ?? GENESIS_HASH,
    generation: first?.hash ?? GENESIS_HASH,
  };
}

/** A cursor is valid when its generation matches the log identity and the
 * record at its seq carries its hash. Genesis (seq 0, all-zero hash) is the
 * empty-log head. Anything else — replaced chain, diverged hash, seq beyond
 * the head — means the client's view cannot be spliced and must resnapshot. */
function cursorMatchesLog(cursor: Record<string, unknown>, events: readonly EventRecord[]): boolean {
  const head = logHead(events);
  if (cursor.generation !== head.generation) return false;
  if (cursor.seq === 0) return cursor.hash === GENESIS_HASH;
  if (typeof cursor.seq !== "number" || !Number.isSafeInteger(cursor.seq)) return false;
  if (cursor.seq > head.seq) return false;
  const record = events[cursor.seq - 1];
  return record !== undefined && record.seq === cursor.seq && record.hash === cursor.hash;
}

/**
 * Correlated session lifecycle rows for tracked commands, by command id.
 * Message linkage comes ONLY from the seq/hash recorded on the acceptance
 * row and is verified against the record at that seq — a command that failed
 * before acceptance can never capture a later command's user/message. Each
 * start/settlement reference travels with the recorded ts of its own row, so
 * downstream projections time recorded turns from the source, never their
 * own clock.
 */
function scanSessionLifecycle(events: readonly EventRecord[]): Map<string, SessionLifecycle> {
  const byCommand = new Map<string, SessionLifecycle>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.name === "chat/turn_started" && typeof payload.command_id === "string") {
      if (!byCommand.has(payload.command_id)) {
        byCommand.set(payload.command_id, {
          startedSeq: event.seq,
          ...(typeof event.ts === "string" && event.ts.length > 0
            ? { startedTs: event.ts }
            : {}),
        });
      }
      continue;
    }
    if (event.name === "chat/turn_accepted" && typeof payload.command_id === "string") {
      const entry = byCommand.get(payload.command_id) ?? {};
      entry.acceptedSeq = event.seq;
      if (
        typeof payload.message_seq === "number" &&
        Number.isSafeInteger(payload.message_seq) &&
        typeof payload.message_hash === "string"
      ) {
        const record = events[payload.message_seq - 1];
        if (
          record !== undefined &&
          record.seq === payload.message_seq &&
          record.hash === payload.message_hash &&
          record.name === "user/message"
        ) {
          entry.message = { seq: record.seq, hash: record.hash };
        }
      }
      byCommand.set(payload.command_id, entry);
      continue;
    }
    if (event.name === "chat/turn_settled" && typeof payload.command_id === "string") {
      const entry = byCommand.get(payload.command_id);
      const outcome = parseOutcome(payload.outcome);
      if (entry && outcome) {
        entry.settledSeq = event.seq;
        entry.settledOutcome = outcome;
        if (typeof event.ts === "string" && event.ts.length > 0) {
          entry.settledTs = event.ts;
        }
      }
      continue;
    }
  }
  return byCommand;
}

/** Derived command state with the durable source references that ground it. */
/** Source refs retained in EVERY derived state (recovery snapshots must be
 * able to map historical cards to their real commands after settlement). */
function lifecycleSourceRefs(lifecycle: SessionLifecycle | undefined): {
  sources: Record<string, number | string>;
  messageSeq?: number;
  messageHash?: string;
} {
  const sources: Record<string, number | string> = {};
  if (lifecycle?.startedSeq !== undefined) {
    sources.turnStart = lifecycle.startedSeq;
    if (lifecycle.startedTs !== undefined) {
      // Paired with its seq: the recorded time of THAT verified row. A
      // consumer needing a time must refuse when the pairing is absent.
      sources.turnStartAt = lifecycle.startedTs;
    }
  }
  if (lifecycle?.acceptedSeq !== undefined) sources.acceptance = lifecycle.acceptedSeq;
  if (lifecycle?.settledSeq !== undefined) {
    sources.settlement = lifecycle.settledSeq;
    if (lifecycle.settledTs !== undefined) {
      sources.settlementAt = lifecycle.settledTs;
    }
  }
  return {
    sources,
    ...(lifecycle?.message !== undefined
      ? { messageSeq: lifecycle.message.seq, messageHash: lifecycle.message.hash }
      : {}),
  };
}

function withRefs(
  base: { state: WorkbenchCommandState; detail?: string; outcome?: "success" | "failure" | "operator_abort" },
  refs: ReturnType<typeof lifecycleSourceRefs>,
  extraSources?: Record<string, number | string>,
): {
  state: WorkbenchCommandState;
  outcome?: "success" | "failure" | "operator_abort";
  detail?: string;
  sources?: Record<string, number | string>;
  messageSeq?: number;
  messageHash?: string;
} {
  const sources = { ...refs.sources, ...extraSources };
  return {
    ...base,
    ...(Object.keys(sources).length > 0 ? { sources } : {}),
    ...(refs.messageSeq !== undefined ? { messageSeq: refs.messageSeq } : {}),
    ...(refs.messageHash !== undefined ? { messageHash: refs.messageHash } : {}),
  };
}

function deriveCommandState(
  entry: LedgerEntry | undefined,
  lifecycle: SessionLifecycle | undefined,
): {
  state: WorkbenchCommandState;
  outcome?: "success" | "failure" | "operator_abort";
  detail?: string;
  sources?: Record<string, number | string>;
  messageSeq?: number;
  messageHash?: string;
} {
  const refs = lifecycleSourceRefs(lifecycle);
  if (entry?.staged !== undefined) {
    return withRefs({ state: "staged", detail: entry.staged }, refs, { staging: "gateway/submit_staged" });
  }
  if (entry?.refused !== undefined) {
    return withRefs({ state: "rejected", detail: entry.refused }, refs, { handoff: "gateway/submit_refused" });
  }
  const settledOutcome = entry?.settledOutcome ?? lifecycle?.settledOutcome;
  if (settledOutcome !== undefined) {
    // A settled command RETAINS its start/acceptance/message source refs so
    // a full recovery snapshot can still attribute historical cards to it.
    return withRefs(
      { state: "settled", outcome: settledOutcome },
      refs,
      {
        settlementSource:
          lifecycle?.settledSeq !== undefined ? "session/chat_turn_settled" : "gateway/submit_settled",
      },
    );
  }
  if (lifecycle?.acceptedSeq !== undefined) {
    return withRefs(
      {
        state: "accepted",
        detail: "durable model-facing user/message recorded — not provider delivery",
      },
      refs,
      { handoff: "gateway/submit_receipt" },
    );
  }
  if (lifecycle?.startedSeq !== undefined || entry?.handedOff === true) {
    return withRefs(
      {
        state: "handed_off",
        detail: "frontend handoff only — no durable model-facing record yet",
      },
      refs,
      lifecycle?.startedSeq === undefined ? { handoff: "gateway/submit_receipt" } : undefined,
    );
  }
  if (entry !== undefined) {
    // Unknown covers both an intent without a provable handoff and a
    // recorded uncertain effect (a submitNote that threw mid-delivery); the
    // actual recorded reason wins when there is one.
    return withRefs(
      {
        state: "unknown",
        detail: entry.uncertain ?? "intent recorded without provable handoff — reconcile before any retry",
      },
      refs,
      {
        intent: "gateway/submit_intent",
        ...(entry.uncertain !== undefined ? { uncertain: "gateway/submit_uncertain" } : {}),
      },
    );
  }
  return { state: "unknown", detail: "command not recorded" };
}

function isResolved(entry: LedgerEntry, lifecycle: SessionLifecycle | undefined): boolean {
  return deriveCommandState(entry, lifecycle).state === "settled" || entry.refused !== undefined;
}

export class WorkbenchGateway {
  private readonly config: WorkbenchGatewayConfig;
  private readonly recordExplorer = new WorkbenchRecordExplorer({ maxEntries: 64, maxCacheBytes: 8 * 1_048_576 });
  private ledgerLog?: EventLog;
  private ledgerBuilt = false;
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly cancels = new Map<string, CancelEntry>();
  private binding?: Binding;
  /** The trusted pre-established child binding is a PERMANENT
   * authorization constraint: even after a detach released the transport
   * association, only this recorded client/thread pair may ever bind this
   * gateway. Never unset, never widened (R8-05). */
  private readonly permanentBinding?: { clientId: string; threadId: string };
  /** The most recent transport association released by detach. */
  private lastDetached?: { clientId: string; threadId: string };
  /**
   * The outstanding binding claim rebuilt from the verified ledger. Durable
   * by construction: it exists before any in-memory state is published and
   * survives a restart, so a foreign thread can never take an unpublished
   * claim and a deletion-side caller can verify ownership without the
   * serialized chain.
   */
  private bindingClaim?: BindingClaim;
  /** The command whose turn the kernel is running, if any. */
  private activeCommandId?: string;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(config: WorkbenchGatewayConfig) {
    this.config = config;
    if (config.binding !== undefined) {
      // A trusted pre-established child binding: the recorded child owner
      // pair from the parent's confirmed ready completion. The gateway is
      // bound from its construction; only that pair may use it, before and
      // after any detach.
      this.permanentBinding = { clientId: config.binding.clientId, threadId: config.binding.threadId };
      this.binding = {
        clientId: config.binding.clientId,
        threadId: config.binding.threadId,
        sessionId: config.sessionId ?? workspaceSessionId(config.workspaceCwd),
      };
    }
  }

  /** Dispatch one workbench.* method. All methods serialize onto one chain so
   * binding/open/send/cancel mutations cannot interleave. */
  public handle(method: string, params: unknown): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      switch (method) {
        case "workbench.handshake":
          return this.handshake(params);
        case "workbench.model":
          return this.selectModel(params);
        case "workbench.bind":
          return this.bind(params);
        case "workbench.read":
          return this.read(params);
        case "workbench.submit":
          return this.submit(params);
        case "workbench.commandStatus":
          return this.commandStatus(params);
        case "workbench.cancel":
          return this.cancel(params);
        case "workbench.detach":
          return this.detach(params);
        case "workbench.overview":
          return this.overview(params);
        case "workbench.graph":
          return this.graph(params);
        case "workbench.graph.explore":
          return this.exploreGraph(params);
        case "workbench.code":
          return this.code(params);
        case "workbench.codeAction":
          return this.codeAction(params);
        case "workbench.record":
          return this.record(params);
        case "workbench.record.index":
          return this.recordIndex(params);
        case "workbench.record.body":
          return this.recordBody(params);
        case "workbench.decisions":
          return this.decisions(params);
        case "workbench.decision":
          return this.decision(params);
        case "workbench.branchSession":
          return this.branchSession(params);
        case "workbench.checkpoint":
          return this.checkpoint(params);
        case "workbench.workMode":
          return this.workMode(params);
        case "workbench.usage":
          return this.usage(params);
        default:
          throw new Error(`Method not found: ${method}`);
      }
    };
    const next = this.mutations.then(run, run);
    this.mutations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // --- ledger ---

  private ledgerEventLog(): EventLog {
    if (!this.ledgerLog) {
      this.ledgerLog = openGatewayLog(this.config.gatewayLogPath);
    }
    return this.ledgerLog;
  }

  /**
   * Re-verify and rebuild the persisted ledger from disk. Called before the
   * first append and at the start of every read/dedup/cancel decision, so
   * rows appended externally — or a replaced chain — are observed rather
   * than silently ignored. A corrupt chain fails closed.
   */
  private refreshLedger(): void {
    const log = this.ledgerEventLog();
    log.refresh();
    this.ledger.clear();
    this.cancels.clear();
    this.bindingClaim = undefined;
    for (const event of log.events) {
      this.absorbLedgerRow(event);
    }
    this.ledgerBuilt = true;
    // The in-memory active pointer yields to durable settlement records.
    if (this.activeCommandId !== undefined) {
      const entry = this.ledger.get(this.activeCommandId);
      if (entry && isResolved(entry, undefined)) {
        this.activeCommandId = undefined;
      }
    }
  }

  private absorbLedgerRow(event: EventRecord): void {
    const payload = event.payload as Record<string, unknown>;
    // Binding lifecycle rows carry no command id: they reshape the durable
    // binding claim itself.
    switch (event.name) {
      case "workbench/bind_intent": {
        if (typeof payload.client_id === "string" && typeof payload.thread_id === "string") {
          this.bindingClaim = {
            clientId: payload.client_id,
            threadId: payload.thread_id,
            state: "intent",
            ...(typeof payload.session_id === "string" ? { sessionId: payload.session_id } : {}),
          };
        }
        return;
      }
      case "workbench/bind_failed": {
        const claim = this.bindingClaim;
        if (
          claim &&
          claim.state !== "bound" &&
          payload.client_id === claim.clientId &&
          payload.thread_id === claim.threadId
        ) {
          claim.state = "failed";
        }
        return;
      }
      case "workbench/bound": {
        if (typeof payload.client_id === "string" && typeof payload.thread_id === "string") {
          this.bindingClaim = {
            clientId: payload.client_id,
            threadId: payload.thread_id,
            state: "bound",
            ...(typeof payload.session_id === "string" ? { sessionId: payload.session_id } : {}),
          };
        }
        return;
      }
      case "workbench/detached": {
        const claim = this.bindingClaim;
        if (claim && payload.client_id === claim.clientId && payload.thread_id === claim.threadId) {
          this.bindingClaim = undefined;
        }
        return;
      }
      default:
        break;
    }
    if (typeof payload.command_id !== "string") return;
    const commandId = payload.command_id;
    switch (event.name) {
      case "workbench/submit_intent": {
        if (typeof payload.fingerprint !== "string") return;
        if (this.ledger.has(commandId)) return;
        this.ledger.set(commandId, {
          commandId,
          fingerprint: payload.fingerprint,
          ...(typeof payload.client_id === "string" ? { clientId: payload.client_id } : {}),
          ...(typeof payload.thread_id === "string" ? { threadId: payload.thread_id } : {}),
          ...(typeof payload.session_id === "string" ? { sessionId: payload.session_id } : {}),
        });
        return;
      }
      case "workbench/submit_receipt": {
        const entry = this.ledger.get(commandId);
        if (entry && payload.handoff === "frontend") entry.handedOff = true;
        return;
      }
      case "workbench/submit_refused": {
        const entry = this.ledger.get(commandId);
        if (entry && typeof payload.reason === "string") entry.refused = payload.reason;
        return;
      }
      case "workbench/submit_uncertain": {
        const entry = this.ledger.get(commandId);
        if (entry && typeof payload.reason === "string") entry.uncertain = payload.reason;
        return;
      }
      case "workbench/submit_staged": {
        const entry = this.ledger.get(commandId);
        if (entry && typeof payload.reason === "string") entry.staged = payload.reason;
        return;
      }
      case "workbench/submit_settled": {
        const outcome = parseOutcome(payload.outcome);
        const entry = this.ledger.get(commandId);
        if (entry && outcome) entry.settledOutcome = outcome;
        return;
      }
      case "workbench/cancel_intent": {
        if (typeof payload.fingerprint !== "string" || typeof payload.target_command_id !== "string") {
          return;
        }
        if (this.cancels.has(commandId)) return;
        this.cancels.set(commandId, { fingerprint: payload.fingerprint, targetCommandId: payload.target_command_id });
        return;
      }
      case "workbench/cancel_receipt": {
        const cancel = this.cancels.get(commandId);
        if (cancel && typeof payload.accepted === "boolean") cancel.accepted = payload.accepted;
        return;
      }
      default:
        return;
    }
  }

  private appendLedger(name: string, payload: Record<string, unknown>): void {
    // Rebuild-and-verify BEFORE the first append so a restarted gateway can
    // never forget persisted intents and re-invoke an old command. Later
    // appends absorb their own row; method-start refreshes pick up external
    // writes.
    if (!this.ledgerBuilt) {
      this.refreshLedger();
    }
    const record = this.ledgerEventLog().appendDurable({ kind: "observe", name, payload });
    this.absorbLedgerRow(record);
  }

  // --- helpers ---

  private sessionId(): string {
    // A trusted configured session id (a branch child gateway) wins over
    // both the live kernel and the workspace-derived id, so pre-boot and
    // restarted reads can never fall back to another session.
    if (this.config.sessionId !== undefined) return this.config.sessionId;
    return this.config.getKernel()?.sessionId ?? workspaceSessionId(this.config.workspaceCwd);
  }

  private sessionDirectory(sessionId: string): string {
    return join(this.config.sessionsRoot, sessionId);
  }

  /**
   * R2 rejects inherited operator-inbox state instead of mispresenting it:
   * staged notes would be folded into the next turn's model-facing text, and
   * this protocol cannot yet represent that folding truthfully to the app.
   */
  private refuseInheritedInbox(sessionId: string, context: string): void {
    const pending = pendingNoteState(this.sessionDirectory(sessionId));
    if (pending.queued > 0 || pending.inFlight > 0) {
      throw new Error(
        `${context} refused: the session carries ${pending.queued + pending.inFlight} staged operator inbox note(s) ` +
          "that R2 cannot represent truthfully — drain them through the harness first",
      );
    }
  }

  private openSessionLog(sessionId: string): EventLog {
    return new EventLog(join(this.sessionDirectory(sessionId), "events.jsonl"), { readOnly: true });
  }

  /** R8-03: the owner-side retained reader the recorded context projections
   * fold branch-context rows with — the session's own blob store. A missing
   * retained source surfaces as the projection's own refusal, never as a
   * silently degraded view. */
  private retainedReader(sessionLog: EventLog): (digest: string) => string | undefined {
    const store = BlobStore.forSession(sessionLog.path);
    return (digest: string) => (store.has(digest) ? store.get(digest) : undefined);
  }

  private requireBinding(value: unknown): Binding {
    const fields = requireBindingFields(value);
    const binding = this.binding;
    if (!binding) {
      throw new Error("no workbench binding — call workbench.bind first");
    }
    if (binding.clientId !== fields.clientId || binding.threadId !== fields.threadId) {
      throw new Error("binding mismatch — this gateway is bound to another client/thread");
    }
    return binding;
  }

  /**
   * The binding that owns unresolved commands, reconstructed from the
   * verified ledger. Detach releases only the transport association; active
   * ownership stays with the submitting client/thread so only that owner —
   * or a later settlement record — can release it. Entries recorded for a
   * different session id never own THIS workspace.
   */
  private owningBinding(
    lifecycle: Map<string, SessionLifecycle>,
    sessionId?: string,
  ): { clientId: string; threadId: string } | undefined {
    let owner: { clientId: string; threadId: string } | undefined;
    for (const entry of this.ledger.values()) {
      if (entry.clientId === undefined || entry.threadId === undefined) continue;
      if (sessionId !== undefined && entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (!isResolved(entry, lifecycle.get(entry.commandId))) {
        owner = { clientId: entry.clientId, threadId: entry.threadId };
      }
    }
    return owner;
  }

  /**
   * True while a workbench binding, outstanding durable binding claim, or
   * unresolved workbench command owns the gateway workspace session — the
   * R2 ownership fence for the legacy chat surfaces on the shared server.
   * Derived from the verified ledger (never volatile-only state), so an
   * unbooted intent, a failed-boot claim or a restart-rebuilt binding all
   * count. Serialized onto the same chain as every workbench mutation.
   */
  public ownsWorkspaceSession(): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      this.refreshLedger();
      return this.workspaceOwnedByWorkbench();
    };
    const next = this.mutations.then(run, run);
    this.mutations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private workspaceOwnedByWorkbench(): boolean {
    if (this.permanentBinding !== undefined) return true;
    if (this.binding !== undefined) return true;
    if (this.bindingClaim !== undefined) return true;
    const sessionId = this.sessionId();
    const lifecycle = scanSessionLifecycle(this.openSessionLog(sessionId).events);
    return this.owningBinding(lifecycle, sessionId) !== undefined;
  }

  /**
   * Synchronous verified ownership answer for callers whose effect cannot
   * await the serialized chain (session deletion). The ledger is re-read
   * from disk on every call — no cached answer, no TOCTOU against this
   * process: JavaScript runs this check and the caller's effect without an
   * interleaving point, and every bind publishes its durable claim BEFORE
   * the chain's first await, so the disk state this reads is always at
   * least as conservative as any in-flight workbench mutation. Only the
   * gateway workspace session can be workbench-owned; anything else is a
   * plain directory. An unreadable ledger fails closed (owned).
   */
  public ownsWorkspaceSessionSync(sessionId: string): { owned: boolean; detail?: string } {
    if (sessionId !== (this.config.sessionId ?? workspaceSessionId(this.config.workspaceCwd))) {
      return { owned: false };
    }
    try {
      this.refreshLedger();
      return { owned: this.workspaceOwnedByWorkbench() };
    } catch (error) {
      const detail = redactText(error instanceof Error ? error.message : String(error)).slice(0, 160);
      return { owned: true, detail };
    }
  }

  /**
   * The shared serialized seam for legacy chat mutations: the ownership
   * decision AND the caller's effect run as ONE step on the same chain as
   * every workbench mutation, so a bind or detach can never interleave
   * between the check and the effect it gated. The effect must not call
   * back into this gateway's chain (it would deadlock); the embedded
   * kernel's submitNote returns immediately, so a fenced send does not hold
   * the chain for a whole model turn.
   */
  public runLegacyMutation<T>(
    method: string,
    effect: () => T | Promise<T>,
  ): Promise<
    | { readonly refused: false; readonly value: T }
    | {
      readonly refused: true;
      readonly reason: "workbench_owns_workspace" | "workbench_ownership_unverifiable";
      readonly detail?: string;
    }
  > {
    const run = async (): Promise<
      | { readonly refused: false; readonly value: T }
      | {
        readonly refused: true;
        readonly reason: "workbench_owns_workspace" | "workbench_ownership_unverifiable";
        readonly detail?: string;
      }
    > => {
      try {
        this.refreshLedger();
      } catch (error) {
        return {
          refused: true,
          reason: "workbench_ownership_unverifiable",
          detail: redactText(error instanceof Error ? error.message : String(error)).slice(0, 160),
        };
      }
      if (this.workspaceOwnedByWorkbench()) {
        return { refused: true, reason: "workbench_owns_workspace" };
      }
      return { refused: false, value: await effect() };
    };
    const next = this.mutations.then(run, run);
    this.mutations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Settlement observed through the kernel lifecycle, after its durable
   * session record. Records the gateway receipt and clears active tracking. */
  public noteSettlement(commandId: string, outcome: "success" | "failure" | "operator_abort"): void {
    try {
      this.appendLedger("workbench/submit_settled", { command_id: commandId, outcome });
    } finally {
      if (this.activeCommandId === commandId) {
        this.activeCommandId = undefined;
      }
    }
  }

  // --- methods ---

  /** Closed host checkpoint boundary: snapshots stay out of the renderer. */
  private checkpoint(params: unknown): unknown {
    const parsed = requireObject(params, ["version", "binding", "operation", "id", "expectedSource", "expectedDigest"], "workbench.checkpoint params");
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    const id = requireId(parsed.id, "checkpoint id");
    if (parsed.operation !== "create" && parsed.operation !== "read") throw new Error("checkpoint operation must be create or read");
    let expected: { seq: number; hash: string } | undefined;
    if (parsed.operation === "create") {
      if (parsed.expectedDigest !== undefined) throw new Error("create does not accept expectedDigest");
      const source = requireObject(parsed.expectedSource, ["seq", "hash"], "expectedSource");
      if (!Number.isSafeInteger(source.seq) || Number(source.seq) < 0 || typeof source.hash !== "string" || !/^[a-f0-9]{64}$/u.test(source.hash)) throw new Error("expectedSource must name an exact seq/hash");
      expected = { seq: Number(source.seq), hash: source.hash };
    } else {
      if (parsed.expectedSource !== undefined) throw new Error("read does not accept expectedSource");
      if (typeof parsed.expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.expectedDigest)) throw new Error("expectedDigest must be a SHA-256 digest");
    }
    this.refreshLedger();
    const kernel = this.config.getKernel();
    if (kernel && kernel.sessionId !== binding.sessionId) throw new Error("checkpoint kernel does not own this binding");
    const service = kernel?.checkpointService?.();
    if (!service) return { version: WORKBENCH_PROTOCOL_VERSION, state: "unsupported", reason: "the owned kernel has no workspace checkpoint capability" };
    if (parsed.operation === "create") {
      this.refuseInheritedInbox(binding.sessionId, "workbench.checkpoint");
      const lifecycle = scanSessionLifecycle(this.openSessionLog(binding.sessionId).events);
      const unresolved = [...this.ledger.values()].some(entry => entry.clientId === binding.clientId && entry.threadId === binding.threadId && !isResolved(entry, lifecycle.get(entry.commandId)));
      if (unresolved || this.activeCommandId !== undefined || kernel!.busy()) throw new Error("checkpoint refused: the owned session is not settled");
    }
    const checkpoint = parsed.operation === "create"
      ? service.capture({ id, expected: expected! })
      : service.read(id, parsed.expectedDigest as string);
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      state: "ready",
      id: checkpoint.id,
      digest: checkpoint.digest,
      source: checkpoint.manifest.source,
      imageDigest: checkpoint.manifest.workspaceImage.digest,
      inputDigest: sha256Hex(canonicalJson(checkpoint.manifest.providerState)),
      prefixHash: checkpoint.manifest.prefix.hash,
      coverage: checkpoint.manifest.coverage,
    };
  }

  /**
   * R8-06j2 explicit session work mode (docs/desktop-coding-r8-work-mode.md).
   * Closed version-1 envelopes over the optional kernel work-mode capability:
   * read is effect-free and NEVER boots a kernel (an unopened gateway is
   * unavailable); set runs on this serialized chain behind the exact binding
   * check and the settled-session fence — work mode changes apply only to
   * settled sessions/new turns, with no mid-run override or implicit abort;
   * status is a read-only reconstruction. No path, session id, token, model,
   * policy, callback or graph is accepted from the renderer, and nothing
   * here submits a note or certifies task completion: applied is a control
   * update receipt only.
   */
  private workModeBusyReason(binding: Binding, kernel: WorkbenchKernelHandle): string | undefined {
    this.refreshLedger();
    const pending = pendingNoteState(this.sessionDirectory(binding.sessionId));
    if (pending.queued > 0 || pending.inFlight > 0) return "The session has staged operator inbox notes; mode changes apply to settled sessions and new turns.";
    const lifecycle = scanSessionLifecycle(this.openSessionLog(binding.sessionId).events);
    const unresolved = [...this.ledger.values()].some((entry) =>
      entry.clientId === binding.clientId && entry.threadId === binding.threadId &&
      (entry.sessionId === undefined || entry.sessionId === binding.sessionId) && !isResolved(entry, lifecycle.get(entry.commandId)));
    if (unresolved || this.activeCommandId !== undefined || kernel.busy()) return "The session has unresolved or active work; mode changes apply to settled sessions and new turns.";
    return undefined;
  }

  private workMode(params: unknown): unknown {
    if (!isRecord(params)) throw new Error("workbench.workMode params must be an object");
    const request = (() => {
      switch (params.operation) {
        case "read":
          requireObject(params, ["version", "binding", "operation"], "workbench.workMode params");
          return { operation: "read" as const };
        case "set": {
          const body = requireObject(params, ["version", "binding", "operation", "commandId", "expectedRevision", "mode"], "workbench.workMode params");
          const commandId = requireId(body.commandId, "work mode command id");
          const expectedRevision = requireWorkModeRevision(body.expectedRevision);
          const mode = body.mode;
          if (mode !== "default" && mode !== "chat" && mode !== "work") throw new Error("workbench.workMode mode must be default, chat or work");
          return { operation: "set", commandId, expectedRevision, mode } as const;
        }
        case "status": {
          const body = requireObject(params, ["version", "binding", "operation", "commandId"], "workbench.workMode params");
          return { operation: "status" as const, commandId: requireId(body.commandId, "work mode command id") };
        }
        default: throw new Error("workbench.workMode has an unknown operation");
      }
    })();
    requireVersion(params);
    const binding = this.requireBinding(params.binding);
    const command = request.operation === "read" ? {} : { commandId: request.commandId };
    const kernel = this.config.getKernel();
    if (!kernel) return { version: WORKBENCH_PROTOCOL_VERSION, state: "unavailable", reason: "No owned kernel is open; this operation never boots one.", ...command };
    if (kernel.sessionId !== binding.sessionId) throw new Error("workbench.workMode kernel does not own this binding");
    const service = kernel.workModeService?.();
    if (!service) return { version: WORKBENCH_PROTOCOL_VERSION, state: "unsupported", reason: "The owned kernel has no session work-mode capability.", ...command };
    try {
      if (request.operation === "read") return {
        version: WORKBENCH_PROTOCOL_VERSION, state: "available", selection: selectionWire(service.read()),
        busy: this.workModeBusyReason(binding, kernel) !== undefined,
      };
      const owner = { clientId: binding.clientId, threadId: binding.threadId };
      if (request.operation === "status") return workModeWire(service.status({ commandId: request.commandId, owner }));
      const reason = this.workModeBusyReason(binding, kernel);
      if (reason !== undefined) return { version: WORKBENCH_PROTOCOL_VERSION, state: "busy", reason, ...command };
      return workModeWire(service.set({ commandId: request.commandId, expectedRevision: request.expectedRevision, mode: request.mode, owner }));
    } catch (error) {
      return {
        version: WORKBENCH_PROTOCOL_VERSION,
        state: request.operation === "set" ? "unknown" : "unavailable",
        reason: request.operation === "set"
          ? "The selection outcome could not be verified. Check the same command's status; it was not automatically repeated."
          : redactText(error instanceof Error ? error.message : String(error)).slice(0, 256),
        ...command,
      };
    }
  }

  private async handshake(params: unknown): Promise<unknown> {
    requireVersion(requireObject(params, ["version"], "workbench.handshake params"));
    const kernel = this.config.getKernel();
    // The permission policy actually in force, never an app choice: an open
    // kernel reports its live controller mode (handles that cannot report
    // fall back to the same standing resolution); an unopened gateway reports
    // the operator's standing selection — environment, then config file.
    const standingMode = resolvePermissionMode({
      env: process.env[PERMISSION_MODE_ENV],
      configured: readConfig().permissions?.default_mode,
    }).mode;
    let identity: {
      route: string;
      model?: string;
      ready: boolean;
      reason?: string;
      routeSource: "configured" | "kernel";
      permissionMode: PermissionMode;
    };
    if (kernel) {
      // Legacy route-status shape; the handshake itself supplies routeSource
      // and permissionMode — no cast, the kernel's answer stays its own.
      const status = await kernel.routeStatus();
      identity = {
        route: status.route,
        ...(status.model ? { model: status.model } : {}),
        ready: status.ready,
        ...(status.reason ? { reason: status.reason } : {}),
        routeSource: "kernel",
        permissionMode: kernel.permissionMode?.() ?? standingMode,
      };
    } else {
      // Model identity for an unopened kernel is the operator's CONFIGURED
      // selection — never a model call and never a placeholder — honestly
      // marked not-probed. A branch child gateway instead reports its exact
      // recorded workspace policy (trusted configured model identity), so a
      // cold child can never lie through the global/parent selection after
      // a config change.
      const recorded = this.config.modelIdentity;
      if (recorded !== undefined) {
        identity = {
          route: recorded.route,
          model: recorded.model,
          ready: false,
          reason: "model readiness not probed — the child kernel boots at workbench.bind pinned to its recorded policy",
          routeSource: "configured",
          permissionMode: standingMode,
        };
      } else {
        const selection = resolveLlmSelection();
        identity = {
          route: selection.route,
          ...(selection.model ? { model: selection.model } : {}),
          ready: false,
          reason: "model readiness not probed — the gateway kernel opens at workbench.bind",
          routeSource: "configured",
          permissionMode: standingMode,
        };
      }
    }
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      workspacePath: realpathSync(this.config.workspaceCwd),
      sessionId: this.sessionId(),
      capabilities: { ...WORKBENCH_CAPABILITIES, modelChange: this.config.listModels !== undefined && this.config.modelIdentity === undefined && (kernel === undefined || kernel.setModel !== undefined) },
      ...(this.config.listModels !== undefined && this.config.modelIdentity === undefined ? { models: await this.config.listModels() } : {}),
      route: identity.route,
      ...(identity.model ? { model: identity.model } : {}),
      ready: identity.ready,
      ...(identity.reason ? { reason: identity.reason } : {}),
      // "configured" answers with the saved operator selection without
      // probing; "kernel" is a live runtime identity. A reachable adapter
      // and a probed model-ready runtime stay distinguishable.
      routeSource: identity.routeSource,
      permissionMode: identity.permissionMode,
      kernelOpen: kernel !== undefined,
      ...(this.binding ? { bound: { clientId: this.binding.clientId, threadId: this.binding.threadId } } : {}),
    };
  }

  private async selectModel(params: unknown): Promise<unknown> {
    const parsed = requireObject(params,
      ["version", "binding", "route", "model", "expectedRoute", "expectedModel"], "workbench.model params");
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    const kernel = this.config.getKernel();
    if (!kernel || !kernel.setModel || !this.config.listModels || this.config.modelIdentity) {
      return { version: 1, state: "unsupported", reason: "This gateway cannot change its recorded model policy." };
    }
    if (kernel.sessionId !== binding.sessionId) throw new Error("Model selection kernel does not own this binding");
    this.refreshLedger();
    const reason = this.workModeBusyReason(binding, kernel);
    if (reason) return { version: 1, state: "busy", reason };
    const pair = (route: unknown, model: unknown) => {
      if (typeof route !== "string" || !/^[A-Za-z0-9._-]+$/.test(route) ||
          typeof model !== "string" || !/^[A-Za-z0-9._:+/@~-]+$/.test(model) || model.length > 512) {
        throw new Error("Model selection requires an exact public route/model pair");
      }
      return { route, model };
    };
    const target = pair(parsed.route, parsed.model);
    const expected = pair(parsed.expectedRoute, parsed.expectedModel);
    const current = await kernel.routeStatus();
    if (current.route !== expected.route || current.model !== expected.model) {
      throw new Error("The current model changed; refresh its identity before selecting again");
    }
    const entry = (await this.config.listModels()).find(item => item.route === target.route && item.model === target.model);
    if (!entry) throw new Error("The selected route/model is not in the harness catalog");
    if (!entry.connected) throw new Error(`Sign in with dokkabi login ${target.route} before selecting this model`);
    const lateBusy = this.workModeBusyReason(binding, kernel);
    if (lateBusy) return { version: 1, state: "busy", reason: lateBusy };
    const latest = await kernel.routeStatus();
    if (latest.route !== expected.route || latest.model !== expected.model) throw new Error("The current model changed during discovery; refresh before selecting again");
    this.appendLedger("workbench/model_intent", { client_id: binding.clientId, thread_id: binding.threadId,
      expected_route: expected.route, expected_model: expected.model, route: target.route, model: target.model });
    try {
      const result = await kernel.setModel(`${target.route}/${target.model}`);
      if (typeof result !== "string") {
        this.appendLedger("workbench/model_confirmation_required", { client_id: binding.clientId,
          thread_id: binding.threadId, route: target.route, model: target.model });
        return { version: 1, state: "confirmation_required", reason: "This context carry needs an explicit carry/slim choice. The model has not changed." };
      }
      const actual = await kernel.routeStatus();
      if (actual.route !== target.route || actual.model !== target.model) throw new Error("The kernel did not confirm the requested model identity");
      this.appendLedger("workbench/model_applied", { client_id: binding.clientId, thread_id: binding.threadId,
        route: actual.route, model: actual.model });
      return { version: 1, state: "applied", route: actual.route, model: actual.model };
    } catch (error) {
      this.appendLedger("workbench/model_failed", { client_id: binding.clientId, thread_id: binding.threadId,
        route: target.route, model: target.model });
      throw error;
    }
  }

  private async bind(params: unknown): Promise<unknown> {
    const parsed = requireObject(params, ["version", "clientId", "threadId", "workspacePath"], "workbench.bind params");
    requireVersion(parsed);
    const clientId = requireId(parsed.clientId, "clientId");
    const threadId = requireId(parsed.threadId, "threadId");
    // A trusted pre-established child binding is permanent authorization:
    // ANY other client/thread pair is refused before a single ledger row
    // lands — including after a detach cleared the transport association —
    // so a foreign bind can never wedge the child between two owners.
    if (
      this.permanentBinding !== undefined &&
      (this.permanentBinding.clientId !== clientId || this.permanentBinding.threadId !== threadId)
    ) {
      throw new Error(
        `this branch child gateway accepts only its recorded owner ` +
          `(${this.permanentBinding.clientId}/${this.permanentBinding.threadId})`,
      );
    }
    if (typeof parsed.workspacePath !== "string" || parsed.workspacePath.trim().length === 0) {
      throw new Error("workspacePath is required");
    }
    let requestedPath: string;
    try {
      requestedPath = realpathSync(parsed.workspacePath);
    } catch {
      throw new Error(`workspace path cannot be resolved: ${parsed.workspacePath}`);
    }
    let gatewayWorkspace: string;
    try {
      gatewayWorkspace = realpathSync(this.config.workspaceCwd);
    } catch {
      throw new Error("gateway workspace cannot be resolved");
    }
    if (requestedPath !== gatewayWorkspace) {
      this.appendLedger("workbench/bind_refused", {
        reason: "foreign_workspace",
        client_id: clientId,
        thread_id: threadId,
      });
      throw new Error(`workspace mismatch — the gateway owns ${gatewayWorkspace}`);
    }
    this.refreshLedger();
    const current = this.binding;
    if (current && (current.clientId !== clientId || current.threadId !== threadId)) {
      this.appendLedger("workbench/bind_refused", {
        reason: "foreign_thread",
        client_id: clientId,
        thread_id: threadId,
      });
      throw new Error(
        `the workbench thread ${current.threadId} (client ${current.clientId}) already owns this binding`,
      );
    }
    // The durable claim rebuilt from the ledger fences foreign threads across
    // restarts and crash windows: a pending intent, a failed boot, or a
    // completed binding that was never detached all keep their owner.
    const claim = this.bindingClaim;
    if (claim && (claim.clientId !== clientId || claim.threadId !== threadId)) {
      this.appendLedger("workbench/bind_refused", {
        reason: "foreign_thread",
        client_id: clientId,
        thread_id: threadId,
      });
      throw new Error(
        `the workbench thread ${claim.threadId} (client ${claim.clientId}) holds the durable binding claim on this gateway` +
          " — only that owner may rebind until it detaches or reconciles",
      );
    }
    // Unresolved commands keep their owner: a detached transport association
    // never lets a different thread take over an unsettled command.
    const lifecycle = scanSessionLifecycle(this.openSessionLog(this.sessionId()).events);
    const owner = this.owningBinding(lifecycle);
    if (owner && (owner.clientId !== clientId || owner.threadId !== threadId)) {
      this.appendLedger("workbench/bind_refused", {
        reason: "unresolved_commands_owned_elsewhere",
        client_id: clientId,
        thread_id: threadId,
      });
      throw new Error(
        `unresolved workbench commands are still owned by thread ${owner.threadId} (client ${owner.clientId}) ` +
          "— only that owner may rebind until they settle or are reconciled",
      );
    }
    const reconnect =
      current !== undefined ||
      (claim !== undefined && claim.clientId === clientId && claim.threadId === threadId) ||
      (this.lastDetached !== undefined &&
        this.lastDetached.clientId === clientId &&
        this.lastDetached.threadId === threadId);
    // Refuse inherited operator-inbox state BEFORE opening the kernel: R2
    // cannot truthfully represent staged notes folded into a later turn.
    this.refuseInheritedInbox(this.sessionId(), "workbench.bind");
    // Binding earns its name in two durable steps. The INTENT lands before
    // the kernel boots: an append rejection refuses the bind with ZERO kernel
    // opens, and a boot failure afterwards leaves the intent visible and
    // unacknowledged — a conservative reservation, never a completed
    // binding — so the same owner retries as a reconnect and no other thread
    // can take the binding in between.
    const sessionId = this.sessionId();
    this.appendLedger("workbench/bind_intent", {
      client_id: clientId,
      thread_id: threadId,
      session_id: sessionId,
      reconnect,
    });
    this.binding = { clientId, threadId, sessionId };
    // Always resume the kernel: the desktop binding must never fresh-start
    // production history, and the interactive lease still decides ownership.
    let kernel: WorkbenchKernelHandle;
    try {
      kernel = await this.config.openKernel();
    } catch (error) {
      // The boot failed: record the redacted outcome, keep the intent claim
      // reserved, and report the failure — never a successful bind.
      try {
        this.appendLedger("workbench/bind_failed", {
          client_id: clientId,
          thread_id: threadId,
          session_id: sessionId,
          reason: redactText(error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
      } catch {
        // The failure record could not land either; the durable intent above
        // still stands as the conservative claim.
      }
      throw error;
    }
    // Completed binding only after the successful boot. If THIS append fails
    // the RPC errors with the effect uncertain: the intent claim stays
    // reserved, no success is acknowledged, no foreign thread may take over.
    this.appendLedger("workbench/bound", {
      client_id: clientId,
      thread_id: threadId,
      session_id: kernel.sessionId,
      reconnect,
    });
    this.binding = { clientId, threadId, sessionId: kernel.sessionId };
    return {
      ok: true,
      sessionId: kernel.sessionId,
      workspacePath: gatewayWorkspace,
      reconnect,
    };
  }

  private read(params: unknown): unknown {
    const parsed = requireObject(
      params,
      ["version", "binding", "sessionCursor", "gatewayCursor"],
      "workbench.read params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    this.refreshLedger();

    const sessionId = binding.sessionId;
    const sessionLog = this.openSessionLog(sessionId);
    const ledgerLog = this.ledgerEventLog();

    let sessionCursorValid = true;
    if (parsed.sessionCursor !== undefined) {
      const cursor = requireObject(
        parsed.sessionCursor,
        ["sessionId", "seq", "hash", "generation"],
        "sessionCursor",
      );
      if (cursor.sessionId !== sessionId) {
        throw new Error(
          `sessionCursor names session ${JSON.stringify(String(cursor.sessionId))} but this binding owns ${sessionId}`,
        );
      }
      sessionCursorValid = cursorMatchesLog(cursor, sessionLog.events);
    }
    let gatewayCursorValid = true;
    if (parsed.gatewayCursor !== undefined) {
      const cursor = requireObject(parsed.gatewayCursor, ["seq", "hash", "generation"], "gatewayCursor");
      gatewayCursorValid = cursorMatchesLog(cursor, ledgerLog.events);
    }

    const lifecycle = scanSessionLifecycle(sessionLog.events);
    const commands = [...this.ledger.values()]
      .filter((entry) => entry.clientId === binding.clientId && entry.threadId === binding.threadId)
      .map((entry) => ({
        commandId: entry.commandId,
        ...withOptionalFields(deriveCommandState(entry, lifecycle.get(entry.commandId))),
      }));

    const kernel = this.config.getKernel();
    // R2 tool completion references: the legacy projection stays untouched;
    // workbench read alone enriches its COPY of each tool card with the
    // actual correlated tool/end record (both refs together or neither).
    // durationMs remains an independent measurement — a "missing" duration
    // is never completion evidence and a present one is not required.
    const completions = toolCompletionRefs(sessionLog.events);
    const cards: WorkbenchCard[] = projectTranscript(sessionLog.events).map((card) => {
      if (card.kind !== "tool") return card;
      const completion = completions.get(card.seq);
      return completion === undefined
        ? card
        : { ...card, completionSeq: completion.seq, completionHash: completion.hash };
    });
    return {
      cards,
      state: {
        busy: kernel?.busy() ?? false,
        activeCommandId: this.activeCommandId ?? null,
      },
      commands,
      sessionCursor: { sessionId, ...headFields(logHead(sessionLog.events)) },
      gatewayCursor: headFields(logHead(ledgerLog.events)),
      // A read without prior cursors has no view to splice: the response is
      // explicitly a full resnapshot.
      resnapshot:
        parsed.sessionCursor === undefined ||
        parsed.gatewayCursor === undefined ||
        !(sessionCursorValid && gatewayCursorValid),
    };
  }

  private async submit(params: unknown): Promise<unknown> {
    const parsed = requireObject(params, ["version", "binding", "commandId", "text"], "workbench.submit params");
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    const commandId = requireId(parsed.commandId, "command id");
    if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
      throw new Error("text is required");
    }
    if (parsed.text.length > SUBMIT_TEXT_MAX_CHARS) {
      throw new Error(`text exceeds the ${SUBMIT_TEXT_MAX_CHARS} character limit`);
    }
    const text = parsed.text;
    const fingerprint = submitFingerprint(commandId, text);

    this.refreshLedger();
    const existing = this.ledger.get(commandId);
    if (existing) {
      // A command belongs to the binding that submitted it; another binding
      // must never retrieve its receipt through a replayed submit.
      if (
        (existing.clientId !== undefined && existing.clientId !== binding.clientId) ||
        (existing.threadId !== undefined && existing.threadId !== binding.threadId)
      ) {
        throw new Error(`command ${commandId} belongs to another binding`);
      }
      // Same id with a different canonical payload ALWAYS conflicts —
      // including intents whose handoff is unknown.
      if (existing.fingerprint !== fingerprint) {
        this.appendLedger("workbench/submit_repeated", { command_id: commandId, outcome: "conflict" });
        throw new Error(`command ${commandId} already exists with a different payload`);
      }
      this.appendLedger("workbench/submit_repeated", { command_id: commandId, outcome: "returned_existing" });
      const lifecycle = scanSessionLifecycle(this.openSessionLog(binding.sessionId).events);
      const derived = deriveCommandState(existing, lifecycle.get(commandId));
      return { commandId, duplicate: true, ...withOptionalFields(derived) };
    }

    // A restarted external gateway may have a fresh ledger while its real
    // session still records an accepted or interrupted command. Missing
    // gateway identity is never permission to resend that input, change its
    // fingerprint or release unresolved effects with a different command id.
    const retainedLifecycle = scanSessionLifecycle(this.openSessionLog(binding.sessionId).events);
    if (retainedLifecycle.has(commandId)) {
      this.appendLedger("workbench/submit_refused", { command_id: commandId, reason: "retained_command_identity_unavailable" });
      throw new Error(`command ${commandId} has retained session evidence but its original gateway identity unavailable — reconcile before retry`);
    }
    const orphaned = [...retainedLifecycle.entries()].filter(([id, lifecycle]) =>
      !this.ledger.has(id) && lifecycle.settledOutcome === undefined &&
      (lifecycle.startedSeq !== undefined || lifecycle.acceptedSeq !== undefined));
    if (orphaned.length > 0) {
      this.appendLedger("workbench/submit_refused", { command_id: commandId, reason: "unresolved_retained_command" });
      throw new Error(`submit refused: unresolved retained command ${orphaned[0]![0]} has no original gateway identity — reconcile before new input`);
    }

    const kernel = this.config.getKernel() ?? (await this.config.openKernel());
    // Everything from here to the kernel handoff is synchronous inside the
    // serialized mutation chain: the fail-closed checks below cannot race a
    // turn boundary, so a workbench submit never silently stages a note.
    this.refuseInheritedInbox(binding.sessionId, "workbench.submit");
    const lifecycleForBlock = scanSessionLifecycle(this.openSessionLog(binding.sessionId).events);
    const unresolved = [...this.ledger.values()].filter(
      (entry) =>
        entry.clientId === binding.clientId &&
        entry.threadId === binding.threadId &&
        !isResolved(entry, lifecycleForBlock.get(entry.commandId)),
    );
    if (unresolved.length > 0 || this.activeCommandId !== undefined || kernel.busy()) {
      const names = unresolved.map((entry) => entry.commandId);
      const reason =
        names.length > 0
          ? `command ${names.at(-1)} is unresolved (${names.join(", ")}) — reconcile or wait for its settlement`
          : this.activeCommandId !== undefined
            ? `command ${this.activeCommandId} is still active`
            : "the kernel is busy with an untracked turn";
      this.appendLedger("workbench/submit_refused", { command_id: commandId, reason: "unresolved" });
      throw new Error(`submit refused: ${reason}`);
    }
    // R8-05: the host-only mutable dispatch readiness guard. A branch child
    // kernel handle rechecks current owned workspace/input/context and the
    // recorded source/model identity immediately before the durable submit
    // intent and handoff — historical admission cannot freeze mutable files.
    // The ordinary request context still applies later at the actual
    // provider request; this guard grants no request authority.
    try {
      kernel.assertBranchDispatchReady?.();
    } catch (error) {
      const reason = error instanceof Error && error.message.startsWith("branch-runtime: ")
        ? error.message.slice("branch-runtime: ".length)
        : "branch_dispatch_not_ready";
      this.appendLedger("workbench/submit_refused", { command_id: commandId, reason });
      throw error;
    }

    // Durable intent before any effect. A failed append refuses the submit;
    // after a crash an intent without a receipt is unknown, never a retry.
    this.appendLedger("workbench/submit_intent", {
      command_id: commandId,
      fingerprint,
      client_id: binding.clientId,
      thread_id: binding.threadId,
      session_id: kernel.sessionId,
    });

    let noteDelivery: "prompt" | "inbox" | "ignored";
    try {
      noteDelivery = kernel.submitNote(text, commandId);
    } catch (error) {
      // The throw leaves the effect UNCERTAIN — the note may have staged or
      // the turn may have opened before the failure. That is unknown, never
      // "rejected": a refusal without proof would release the command. It
      // stays unknown and fences new submits until reconciliation.
      const reason = redactText(error instanceof Error ? error.message : String(error)).slice(0, 200);
      this.appendLedger("workbench/submit_uncertain", { command_id: commandId, reason });
      throw error;
    }
    if (noteDelivery !== "prompt") {
      // Unreachable through the fail-closed ordering above; recorded as the
      // real state it is. A staged note is queued harness input, not a
      // rejection, and never a completed effect.
      const reason =
        noteDelivery === "inbox" ? "note staged in the harness operator inbox" : "text ignored";
      this.appendLedger("workbench/submit_staged", { command_id: commandId, reason });
      return { commandId, state: "staged" as const, detail: reason };
    }
    // The receipt proves frontend handoff only — never model delivery.
    this.appendLedger("workbench/submit_receipt", {
      command_id: commandId,
      handoff: "frontend",
      session_id: kernel.sessionId,
    });
    this.activeCommandId = commandId;
    return {
      commandId,
      state: "handed_off" as const,
      noteDelivery,
      sessionId: kernel.sessionId,
    };
  }

  private commandStatus(params: unknown): unknown {
    const parsed = requireObject(params, ["version", "binding", "commandId"], "workbench.commandStatus params");
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    const commandId = requireId(parsed.commandId, "command id");

    this.refreshLedger();
    const entry = this.ledger.get(commandId);
    if (
      entry &&
      ((entry.clientId !== undefined && entry.clientId !== binding.clientId) ||
        (entry.threadId !== undefined && entry.threadId !== binding.threadId))
    ) {
      throw new Error(`command ${commandId} belongs to another binding`);
    }
    const lifecycle = scanSessionLifecycle(this.openSessionLog(binding.sessionId).events);
    const derived = deriveCommandState(entry, lifecycle.get(commandId));
    return { commandId, ...withOptionalFields(derived) };
  }

  private cancel(params: unknown): unknown {
    const parsed = requireObject(
      params,
      ["version", "binding", "commandId", "targetCommandId"],
      "workbench.cancel params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    const commandId = requireId(parsed.commandId, "command id");
    const targetCommandId = requireId(parsed.targetCommandId, "target command id");
    const fingerprint = cancelFingerprint({
      commandId,
      targetCommandId,
      clientId: binding.clientId,
      threadId: binding.threadId,
    });

    this.refreshLedger();
    // A stable cancellation id deduplicates retries — but only when the
    // operation, target and binding are all identical.
    const existing = this.cancels.get(commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(
          `cancellation ${commandId} already exists for a different target or binding`,
        );
      }
      if (existing.accepted === true) {
        return { commandId, targetCommandId, state: "already_requested" as const };
      }
      // Intent without a provable receipt: the crash window between intent
      // and abort is unknown and is never blindly replayed.
      return {
        commandId,
        targetCommandId,
        state: "unknown" as const,
        detail: "cancellation intent recorded without a provable effect — reconcile via the target command's settlement",
      };
    }

    const kernel = this.config.getKernel();
    if (this.activeCommandId === undefined || this.activeCommandId !== targetCommandId || !kernel) {
      this.appendLedger("workbench/cancel_refused", {
        command_id: commandId,
        target_command_id: targetCommandId,
        reason: "no_active_target",
      });
      throw new Error(
        this.activeCommandId === undefined
          ? "no active command to cancel"
          : `stale or foreign cancel target ${targetCommandId} — the active command is ${this.activeCommandId}`,
      );
    }
    // A second cancellation id for a target whose abort was already accepted
    // never aborts twice: requested is not settlement, and only a recorded
    // settlement may clear the active command.
    const alreadyRequested = [...this.cancels.values()].some(
      (cancel) => cancel.targetCommandId === targetCommandId && cancel.accepted === true,
    );
    if (alreadyRequested) {
      this.appendLedger("workbench/cancel_refused", {
        command_id: commandId,
        target_command_id: targetCommandId,
        reason: "cancellation_already_requested",
      });
      throw new Error(
        `cancellation already requested for command ${targetCommandId} — ` +
          "it stays active until its settlement is recorded",
      );
    }
    // Durable cancellation intent before the abort effect; its fingerprint
    // pins operation, target and binding. An append rejection means zero
    // abort calls.
    this.appendLedger("workbench/cancel_intent", {
      command_id: commandId,
      fingerprint,
      operation: "cancel",
      target_command_id: targetCommandId,
      client_id: binding.clientId,
      thread_id: binding.threadId,
    });
    // Active-only abort. The staged inbox is untouched; the command stays
    // unsettled until its operator_abort settlement is recorded durably.
    let aborted = false;
    try {
      aborted = kernel.abortActive();
    } finally {
      this.appendLedger("workbench/cancel_receipt", {
        command_id: commandId,
        target_command_id: targetCommandId,
        accepted: aborted === true,
      });
    }
    if (aborted !== true) {
      throw new Error("the kernel reports no active turn for this command");
    }
    // Requested, not settled: the command REMAINS the active one — new
    // submits stay fenced by its unresolved ledger entry — until the durable
    // settlement row lands (noteSettlement or a ledger refresh).
    return { commandId, targetCommandId, state: "requested" as const };
  }

  private detach(params: unknown): unknown {
    const parsed = requireObject(params, ["version", "binding"], "workbench.detach params");
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    // Durable row BEFORE any state change: an append rejection keeps the
    // transport association exactly as it was. Detach only releases that
    // association — it never closes or cancels the kernel, and unresolved
    // commands keep their owning binding.
    this.appendLedger("workbench/detached", { client_id: binding.clientId, thread_id: binding.threadId });
    this.binding = undefined;
    this.lastDetached = { clientId: binding.clientId, threadId: binding.threadId };
    return { detached: true };
  }

  /**
   * R3 read-only recorded overview. Projects ONE verified session prefix and
   * the gateway head through the canonical work/context projectors and the
   * recorded usage rows. Zero read effects: no model, bind, abort, tool or
   * context query, and NO session/gateway append on any path — including
   * validation refusals, which throw without recording (a read must never
   * mint ledger rows). Cursor semantics mirror workbench.read: a mismatch
   * means resnapshot, never a spliced view.
   */
  private overview(params: unknown): unknown {
    const parsed = requireObject(
      params,
      ["version", "binding", "sessionCursor", "gatewayCursor"],
      "workbench.overview params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    // Read-only ledger re-verify (no append): the gateway head must be as
    // fresh as workbench.read's, picked up from disk like every other read.
    this.refreshLedger();

    const sessionId = binding.sessionId;
    const sessionLog = this.openSessionLog(sessionId);
    const ledgerLog = this.ledgerEventLog();

    let sessionCursorValid = true;
    if (parsed.sessionCursor !== undefined) {
      const cursor = requireObject(
        parsed.sessionCursor,
        ["sessionId", "seq", "hash", "generation"],
        "sessionCursor",
      );
      if (cursor.sessionId !== sessionId) {
        throw new Error(
          `sessionCursor names session ${JSON.stringify(String(cursor.sessionId))} but this binding owns ${sessionId}`,
        );
      }
      sessionCursorValid = cursorMatchesLog(cursor, sessionLog.events);
    }
    let gatewayCursorValid = true;
    if (parsed.gatewayCursor !== undefined) {
      const cursor = requireObject(parsed.gatewayCursor, ["seq", "hash", "generation"], "gatewayCursor");
      gatewayCursorValid = cursorMatchesLog(cursor, ledgerLog.events);
    }

    const events = sessionLog.events;
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      sessionCursor: { sessionId, ...headFields(logHead(events)) },
      gatewayCursor: headFields(logHead(ledgerLog.events)),
      resnapshot:
        parsed.sessionCursor === undefined ||
        parsed.gatewayCursor === undefined ||
        !(sessionCursorValid && gatewayCursorValid),
      work: projectWorkOverview(events),
      context: projectContextOverview(events, this.retainedReader(sessionLog)),
      usage: projectUsageOverview(events),
    };
  }

  /**
   * The separate read-only work-mode usage read (v1): all and only the run
   * scopes this session's own observe rows reference — the main prefix plus
   * the acceptance/design/readiness children its producers genuinely named —
   * with per-scope counts/metrics over parent-pinned verified prefixes and an
   * aggregate of recorded usage (never billing). The legacy overview usage
   * block and the handshake stay byte-identical; nothing is added to them.
   * Zero read effects: no model, bind, abort, kernel boot, blob replay or
   * session/child/gateway append on any path — including validation
   * refusals. Child logs open ONLY through the guarded read-only helper
   * (safe owned descendant ids, no traversal/symlink/special files, no
   * foreign prefixes), never through a session scan. Cursor semantics mirror
   * workbench.overview: a mismatch means resnapshot, never a spliced view.
   */
  private usage(params: unknown): WorkbenchUsageResponse {
    const parsed = requireObject(
      params,
      ["version", "binding", "sessionCursor", "gatewayCursor"],
      "workbench.usage params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    // Read-only ledger re-verify (no append): the gateway head must be as
    // fresh as every other read's, picked up from disk.
    this.refreshLedger();

    const sessionId = binding.sessionId;
    const sessionLog = this.openSessionLog(sessionId);
    const ledgerLog = this.ledgerEventLog();

    let sessionCursorValid = true;
    if (parsed.sessionCursor !== undefined) {
      const cursor = requireObject(
        parsed.sessionCursor,
        ["sessionId", "seq", "hash", "generation"],
        "sessionCursor",
      );
      if (cursor.sessionId !== sessionId) {
        throw new Error(
          `sessionCursor names session ${JSON.stringify(String(cursor.sessionId))} but this binding owns ${sessionId}`,
        );
      }
      sessionCursorValid = cursorMatchesLog(cursor, sessionLog.events);
    }
    let gatewayCursorValid = true;
    if (parsed.gatewayCursor !== undefined) {
      const cursor = requireObject(parsed.gatewayCursor, ["seq", "hash", "generation"], "gatewayCursor");
      gatewayCursorValid = cursorMatchesLog(cursor, ledgerLog.events);
    }

    const kernel = this.config.getKernel();
    const report = projectWorkbenchUsage({
      parentSessionId: sessionId,
      parentEvents: sessionLog.events,
      openChildLog: (childSessionId) => openChildUsageLog(this.config.sessionsRoot, sessionId, childSessionId),
      mainLiveActive: this.activeCommandId !== undefined || kernel?.busy() === true,
    });
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      sessionCursor: { sessionId, ...headFields(logHead(sessionLog.events)) },
      gatewayCursor: headFields(logHead(ledgerLog.events)),
      resnapshot:
        parsed.sessionCursor === undefined ||
        parsed.gatewayCursor === undefined ||
        !(sessionCursorValid && gatewayCursorValid),
      usage: report,
    };
  }

  /**
   * R4 read-only recorded graph (docs/desktop-graphs-r4.md). Projects ONE
   * verified session prefix into the closed work/context display graph
   * through the canonical projectors. Zero read effects: no model, bind,
   * abort, tool or context query, and NO session/gateway append on any path
   * — including validation refusals, which throw without recording. A graph
   * read never advances the transcript cursor; the heads are reported, not
   * moved. Cursor semantics mirror workbench.read: a mismatch means
   * resnapshot, never a spliced view.
   */
  private graph(params: unknown): unknown {
    const parsed = requireObject(
      params,
      ["version", "binding", "graphType", "sessionCursor", "gatewayCursor"],
      "workbench.graph params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    if (parsed.graphType !== "work" && parsed.graphType !== "context") {
      throw new Error(`invalid graphType ${JSON.stringify(String(parsed.graphType))} — expected "work" or "context"`);
    }
    const graphType = parsed.graphType as WorkbenchGraphType;
    // Read-only ledger re-verify (no append): the gateway head must be as
    // fresh as workbench.read's, picked up from disk like every other read.
    this.refreshLedger();

    const sessionId = binding.sessionId;
    const sessionLog = this.openSessionLog(sessionId);
    const ledgerLog = this.ledgerEventLog();

    let sessionCursorValid = true;
    if (parsed.sessionCursor !== undefined) {
      const cursor = requireObject(
        parsed.sessionCursor,
        ["sessionId", "seq", "hash", "generation"],
        "sessionCursor",
      );
      if (cursor.sessionId !== sessionId) {
        throw new Error(
          `sessionCursor names session ${JSON.stringify(String(cursor.sessionId))} but this binding owns ${sessionId}`,
        );
      }
      sessionCursorValid = cursorMatchesLog(cursor, sessionLog.events);
    }
    let gatewayCursorValid = true;
    if (parsed.gatewayCursor !== undefined) {
      const cursor = requireObject(parsed.gatewayCursor, ["seq", "hash", "generation"], "gatewayCursor");
      gatewayCursorValid = cursorMatchesLog(cursor, ledgerLog.events);
    }

    const events = sessionLog.events;
    const graph = graphType === "work"
      ? projectWorkGraphView(events)
      : projectContextGraphView(events, this.retainedReader(sessionLog));
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      graphType,
      sessionCursor: { sessionId, ...headFields(logHead(events)) },
      gatewayCursor: headFields(logHead(ledgerLog.events)),
      resnapshot:
        parsed.sessionCursor === undefined ||
        parsed.gatewayCursor === undefined ||
        !(sessionCursorValid && gatewayCursorValid),
      graph,
    };
  }

  /** Fresh authority folds precede every bounded navigation read. Neither
   * a pinned view nor a derived byte cache can authorize execution. */
  private exploreGraph(params: unknown): unknown {
    const parsed = requireObject(params, ["version", "binding", "graphType", "query", "snapshot"], "workbench.graph.explore params");
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    if (parsed.graphType !== "work" && parsed.graphType !== "context") throw new Error("invalid graphType");
    const query = normalizeGraphExploreQuery(requireObject(parsed.query, ["mode", "offset", "limit", "nodeId", "search"], "graph query"));
    this.refreshLedger();
    const log = this.openSessionLog(binding.sessionId);
    const sessionCursor = { sessionId: binding.sessionId, ...headFields(logHead(log.events)) };
    const full = parsed.graphType === "work"
      ? projectWorkGraphView(log.events, { displayCapacity: "explore" })
      : projectContextGraphView(log.events, this.retainedReader(log), { displayCapacity: "explore" });
    const result = projectGraphExplore(full, query);
    const snapshot = { sessionCursor, digest: result.digest };
    let stale = false;
    if (parsed.snapshot !== undefined) {
      const pin = requireObject(parsed.snapshot, ["sessionCursor", "digest"], "graph snapshot");
      const cursor = requireObject(pin.sessionCursor, ["sessionId", "seq", "hash", "generation"], "graph snapshot cursor");
      if (cursor.sessionId !== binding.sessionId) throw new Error("graph snapshot belongs to another session");
      const resolved = resolveRecordCursor(log.events, cursor, "graph snapshot");
      if (!resolved.ok) throw new Error(resolved.error);
      if (typeof pin.digest !== "string" || !/^[a-f0-9]{64}$/.test(pin.digest)) throw new Error("invalid graph snapshot digest");
      stale = resolved.cursor.seq !== sessionCursor.seq || pin.digest !== result.digest;
    }
    return {
      version: 1, state: stale ? "stale" : "available", graphType: parsed.graphType,
      sessionCursor, gatewayCursor: headFields(logHead(this.ledgerEventLog().events)), snapshot,
      query: result.query, nextOffset: stale ? null : result.nextOffset,
      counts: result.counts, matchedNodes: result.matchedNodes,
      graph: stale ? { ...result.graph, state: "unavailable", nodes: [], edges: [], waves: [], unscheduled: [], coverage: { ...result.graph.coverage, status: "unavailable", omittedNodes: result.graph.coverage.totalNodes, omittedEdges: result.graph.coverage.totalEdges }, errors: ["The recorded graph changed; explicitly refresh this view before navigating."] } : result.graph,
    };
  }

  /** E1-04 owned retained structural index/body read. It never opens a
   * kernel, captures files or advances the transcript consumer. */
  private codeAction(params: unknown): unknown {
    const body = requireObject(params, ["version", "binding", "operation", "commandId", "expectedRevision", "newWindow"], "workbench.codeAction params");
    requireVersion(body);
    if (body.operation !== "resume") throw new Error("Unknown Code action operation");
    const command = observerResumeRequest.parse({ commandId: body.commandId,
      expectedRevision: body.expectedRevision, ...(body.newWindow !== undefined ? { newWindow: body.newWindow } : {}) });
    const binding = this.requireBinding(body.binding);
    const kernel = this.config.getKernel();
    if (!kernel) return { version: 1, state: "unavailable", reason: "No owned kernel is open; Code controls never open one." };
    if (kernel.sessionId !== binding.sessionId) throw new Error("Code action kernel does not own this binding");
    const service = kernel.codeObserverService?.();
    if (!service) return { version: 1, state: "unsupported", reason: "The owned kernel has no Code observer control capability." };
    if (this.workModeBusyReason(binding, kernel)) return { version: 1, state: "busy", reason: "Code controls require a settled owned session." };
    try {
      const receipt = service.resume(command);
      return { version: 1, state: "applied", receipt, observer: service.status() };
    } catch (error) {
      if (error instanceof CodeVersionRefusal)
        return { version: 1, state: "conflict", reason: error.code };
      return { version: 1, state: "unknown", reason: "The Code control receipt could not be verified. Retry the same command explicitly to reconcile its outcome." };
    }
  }

  private async code(params: unknown): Promise<unknown> {
    const parsed = requireObject(
      params,
      ["version", "binding", "after", "selection", "sessionCursor", "gatewayCursor"],
      "workbench.code params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    if (parsed.after !== undefined && parsed.selection !== undefined)
      throw new Error("Code body reads cannot carry an index acknowledgement");
    this.refreshLedger();
    const sessionLog = this.openSessionLog(binding.sessionId);
    const events = sessionLog.events;
    const ledgerEvents = this.ledgerEventLog().events;
    if (parsed.sessionCursor !== undefined) {
      const expected = requireObject(
        parsed.sessionCursor,
        ["sessionId", "seq", "hash", "generation"],
        "code session cursor",
      );
      if (expected.sessionId !== binding.sessionId || !cursorMatchesLog(expected, events))
        throw new Error("The recorded code session source changed; the view is stale");
    }
    if (parsed.gatewayCursor !== undefined) {
      const expected = requireObject(
        parsed.gatewayCursor,
        ["seq", "hash", "generation"],
        "code gateway cursor",
      );
      if (!cursorMatchesLog(expected, ledgerEvents))
        throw new Error("The recorded code gateway source changed; the view is stale");
    }
    let afterSeq: number | undefined;
    let resnapshot = parsed.after === undefined;
    if (parsed.after !== undefined) {
      const cursor = requireObject(
        parsed.after,
        ["sessionId", "seq", "hash", "generation"],
        "code after",
      );
      if (cursor.sessionId !== binding.sessionId)
        throw new Error("Code cursor names another session");
      // Shape errors refuse; a well-formed cursor no longer in this chain
      // explicitly resnapshots. The app additionally fences persisted sources.
      if (
        !Number.isSafeInteger(cursor.seq) ||
        Number(cursor.seq) < 0 ||
        typeof cursor.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(cursor.hash) ||
        typeof cursor.generation !== "string" ||
        !/^[a-f0-9]{64}$/.test(cursor.generation)
      )
        throw new Error("Invalid code index cursor");
      const resolved = resolveRecordCursor(events, cursor, "code after");
      resnapshot = !resolved.ok;
      if (resolved.ok) afterSeq = resolved.cursor.seq;
    }
    const body = await readWorkbenchCode({
      log: sessionLog,
      workspaceRoot: this.config.workspaceCwd,
      sessionId: binding.sessionId,
      afterSeq,
      resnapshot,
      selection: parsed.selection,
    });
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      sessionCursor: { sessionId: binding.sessionId, ...headFields(logHead(events)) },
      gatewayCursor: headFields(logHead(ledgerEvents)),
      ...body,
    };
  }

  /**
   * R5 read-only exact retained record page (docs/desktop-records-r5.md).
   * Projects ONE verified session prefix into whole EventRecord rows with an
   * immutable asOf pin. Zero read effects: no model, no bind, no abort, no
   * kernel open, no transcript cursor advance, and NO session/gateway append
   * on any path — including validation refusals, which throw without
   * recording (a record read must never mint ledger rows). Divergent
   * cursors (another session, generation or hash) REFUSE instead of
   * splicing; oversized rows report the body unavailable rather than
   * clipping. Decisions stay the capability fact they are.
   */
  private record(params: unknown): unknown {
    const parsed = requireObject(
      params,
      ["version", "binding", "after", "asOf", "limit"],
      "workbench.record params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    const limit = parseRecordLimit(parsed.limit);
    // Read-only ledger re-verify (no append): the gateway head must be as
    // fresh as workbench.read's, picked up from disk like every other read.
    this.refreshLedger();

    const sessionLog = this.openSessionLog(binding.sessionId);
    const ledgerLog = this.ledgerEventLog();
    const events = sessionLog.events;

    // asOf: an explicit exact pin, or the CURRENT head pinned immutable for
    // this response. The pin stays valid while later appends extend the log;
    // it never claims to be the head.
    let asOf: WorkbenchRecordAsOf;
    if (parsed.asOf !== undefined) {
      const cursor = requireObject(parsed.asOf, ["sessionId", "seq", "hash", "generation"], "asOf");
      if (cursor.sessionId !== binding.sessionId) {
        throw new Error(
          `asOf names session ${JSON.stringify(String(cursor.sessionId))} but this binding owns ${binding.sessionId}`,
        );
      }
      const resolved = resolveRecordCursor(events, cursor, "asOf");
      if (!resolved.ok) throw new Error(resolved.error);
      asOf = { ...resolved.cursor, sessionId: binding.sessionId };
    } else {
      const head = logHead(events);
      asOf = { ...head, sessionId: binding.sessionId };
    }

    // after must resolve within that prefix; a differing generation, hash or
    // session position refuses instead of splicing the window.
    let after: WorkbenchRecordCursor | null = null;
    if (parsed.after !== undefined) {
      const cursor = requireObject(parsed.after, ["seq", "hash", "generation"], "after");
      if (cursor.generation !== asOf.generation) {
        throw new Error(
          "after names another generation of this session — refusing instead of splicing",
        );
      }
      if (typeof cursor.seq === "number" && cursor.seq > asOf.seq) {
        throw new Error(`after seq ${cursor.seq} lies beyond the requested prefix ${asOf.seq}`);
      }
      const resolved = resolveRecordCursor(events, cursor, "after");
      if (!resolved.ok) throw new Error(resolved.error);
      after = resolved.cursor;
    }

    const body = projectRecordPage(events, { after, asOf, limit });
    // One closed result shape: an unavailable body still carries the page
    // fields (empty, explicit) so no state ever streams a partial contract.
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      state: body.state,
      ...(body.state === "unavailable"
        ? { reason: body.reason, records: [] as EventRecord[], next: null, total: asOf.seq, hasMore: false }
        : {}),
      sessionCursor: { sessionId: binding.sessionId, ...headFields(logHead(events)) },
      gatewayCursor: headFields(logHead(ledgerLog.events)),
      asOf,
      ...(body.state === "available"
        ? { records: body.records, next: body.next, total: body.total, hasMore: body.hasMore }
        : {}),
      decisions: WORKBENCH_RECORD_DECISIONS,
    };
  }

  /** Each request independently verifies the live chain. Derived canonical
   * bytes are reusable only after resolving this exact verified row identity. */
  private recordSource(parsed: Record<string, unknown>): {
    events: readonly EventRecord[]; asOf: WorkbenchRecordAsOf;
    sessionCursor: WorkbenchRecordAsOf; gatewayCursor: WorkbenchRecordCursor;
  } {
    const binding = this.requireBinding(parsed.binding);
    this.refreshLedger();
    const log = this.openSessionLog(binding.sessionId);
    const sessionCursor = { sessionId: binding.sessionId, ...headFields(logHead(log.events)) };
    let asOf = sessionCursor;
    if (parsed.asOf !== undefined) {
      const pin = requireObject(parsed.asOf, ["sessionId", "seq", "hash", "generation"], "asOf");
      if (pin.sessionId !== binding.sessionId) throw new Error("asOf belongs to another session");
      const resolved = resolveRecordCursor(log.events, pin, "asOf");
      if (!resolved.ok) throw new Error(resolved.error);
      asOf = { ...resolved.cursor, sessionId: binding.sessionId };
    }
    return { events: log.events, asOf, sessionCursor, gatewayCursor: headFields(logHead(this.ledgerEventLog().events)) };
  }

  private recordIndex(params: unknown): unknown {
    const parsed = requireObject(params, ["version", "binding", "after", "asOf", "limit"], "workbench.record.index params");
    requireVersion(parsed);
    const limit = parseRecordLimit(parsed.limit);
    const { events, asOf, sessionCursor, gatewayCursor } = this.recordSource(parsed);
    let after = 0;
    if (parsed.after !== undefined) {
      const cursor = requireObject(parsed.after, ["seq", "hash", "generation"], "after");
      const resolved = resolveRecordCursor(events, cursor, "after");
      if (!resolved.ok) throw new Error(resolved.error);
      if (resolved.cursor.seq > asOf.seq) throw new Error("after lies beyond the pinned prefix");
      after = resolved.cursor.seq;
    }
    const entries = events.slice(after, Math.min(after + limit, asOf.seq)).map((row) => this.recordExplorer.metadataVerified(row));
    const last = entries.at(-1);
    const hasMore = (last?.seq ?? after) < asOf.seq;
    return { version: 1, state: "available", sessionCursor, gatewayCursor, asOf, entries,
      next: hasMore && last !== undefined ? { seq: last.seq, hash: last.hash, generation: asOf.generation } : null,
      total: asOf.seq, hasMore };
  }

  private recordBody(params: unknown): unknown {
    const parsed = requireObject(params, ["version", "binding", "row", "asOf", "offset", "limit"], "workbench.record.body params");
    requireVersion(parsed);
    if (parsed.asOf === undefined) throw new Error("record body requires an exact asOf pin");
    if (typeof parsed.offset !== "number" || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid record byte offset");
    const limit = parsed.limit === undefined ? 32_768 : parsed.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 32_768) throw new Error("invalid record byte limit");
    const { events, asOf, sessionCursor, gatewayCursor } = this.recordSource(parsed);
    const cursor = requireObject(parsed.row, ["seq", "hash", "generation"], "row");
    const resolved = resolveRecordCursor(events, cursor, "row");
    if (!resolved.ok) throw new Error(resolved.error);
    if (resolved.cursor.seq < 1 || resolved.cursor.seq > asOf.seq) throw new Error("row lies outside the pinned prefix");
    const range = this.recordExplorer.rangeVerified(events[resolved.cursor.seq - 1]!, { offset: parsed.offset, limit });
    return { ...range, version: 1, state: "available", sessionCursor, gatewayCursor, asOf, row: resolved.cursor };
  }

  /** Called after owned transport shutdown; a stopped gateway retains no
   * derived body chunks or metadata. No durable evidence is removed. */
  public clearReadCaches(): void { this.recordExplorer.clear(); }

  /**
   * R8-04 read-only decision view (docs/desktop-decisions-r8.md). Projects
   * ONE verified session prefix through the canonical decision fold and its
   * retained-evidence verification: bounded truthful snapshots with local
   * citations, explicit missing/invalid states, and no synthetic applied
   * outcome. Zero read effects: no kernel open, no model, no bind, no
   * transcript cursor advance, and NO session/gateway append on any path —
   * including validation refusals. Expiry is never evaluated: a decision
   * past its recorded deadline stays awaiting until a writer selects.
   * Execution stays explicitly unsupported until the actual R8-05 dispatch
   * binding exists; existing record/graph result shapes are unchanged.
   */
  private decisions(params: unknown): unknown {
    const parsed = requireObject(
      params,
      ["version", "binding"],
      "workbench.decisions params",
    );
    requireVersion(parsed);
    const binding = this.requireBinding(parsed.binding);
    // Read-only ledger re-verify (no append): the gateway head must be as
    // fresh as workbench.read's, picked up from disk like every other read.
    this.refreshLedger();
    const sessionLog = this.openSessionLog(binding.sessionId);
    const ledgerLog = this.ledgerEventLog();
    const view = projectWorkbenchDecisions(sessionLog.events, this.retainedReader(sessionLog));
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      ...view,
      sessionCursor: { sessionId: binding.sessionId, ...headFields(logHead(sessionLog.events)) },
      gatewayCursor: headFields(logHead(ledgerLog.events)),
      execution: this.config.getKernel()?.branchRuntime?.() !== undefined
        ? { supported: true, detail: "prepared conversation only — never applied or verified work" }
        : { supported: false, detail: "unsupported until the R8-05 actual dispatch binding" },
    };
  }

  /**
   * R8-05 closed decision mutations over the actual parent kernel
   * capabilities (docs/desktop-runtime-r8.md). Operations are open, select,
   * start and read-status with strict operation-specific shapes; requests
   * carry stable command ids and an expected revision. Answers are closed
   * version-1 envelopes: state unsupported|available|unknown|conflict|ready,
   * a decision snapshot when known, and a child descriptor only for a
   * confirmed ready start. No token, policy, workspace path, blob or caller
   * callback is accepted or returned. Selection is never execution
   * capability: a start without the host-only branch runtime refuses as
   * unsupported with zero rows.
   */
  private async decision(params: unknown): Promise<unknown> {
    // The discriminator fields are extracted WITHOUT pre-rejecting the
    // operation-specific fields (the closed key check is per operation
    // below); the wire shapes stay strict for each operation.
    if (!isRecord(params)) throw new Error("workbench.decision params must be an object");
    requireVersion(params);
    const binding = this.requireBinding(params.binding);
    const kernel = this.config.getKernel();
    const operation = params.operation;
    if (operation === "open") {
      const body = requireObject(params, ["version", "binding", "operation", "definition"], "workbench.decision params");
      const service = kernel?.decisionService?.();
      if (!service) {
        return { version: WORKBENCH_PROTOCOL_VERSION, state: "unsupported", reason: "the owned kernel has no branch decision capability" };
      }
      const definition = requireObject(body.definition, [
        "id", "commandId", "kind", "checkpointId", "checkpointDigest",
        "question", "options", "recommendation", "rationale", "alternateOf",
      ], "workbench.decision definition");
      if (definition.kind !== "branch") throw new Error("workbench.decision: only branch decisions are supported");
      if (!Array.isArray(definition.options)) throw new Error("workbench.decision: options must be an array");
      const options = definition.options.map((option) => {
        if (!isRecord(option)) throw new Error("workbench.decision: each option must be an object");
        return {
          id: requireId(option.id, "decision option id"),
          label: String(option.label),
        };
      });
      const checkpointDigest = String(definition.checkpointDigest);
      if (!/^[a-f0-9]{64}$/u.test(checkpointDigest)) throw new Error("workbench.decision: checkpointDigest must be a SHA-256 digest");
      const decision = service.open({
        id: requireId(definition.id, "decision id"),
        commandId: requireId(definition.commandId, "decision command id"),
        kind: "branch",
        checkpointId: requireId(definition.checkpointId, "checkpoint id"),
        checkpointDigest,
        question: String(definition.question),
        options,
        recommendation: String(definition.recommendation),
        rationale: String(definition.rationale),
        alternateOf: (definition.alternateOf ?? null) as DecisionOpenRequest["alternateOf"],
      });
      return { version: WORKBENCH_PROTOCOL_VERSION, state: "available", decision: decisionWire(decision) };
    }
    if (operation === "select") {
      const body = requireObject(params, ["version", "binding", "operation", "id", "commandId", "expectedRevision", "option"], "workbench.decision params");
      const service = kernel?.decisionService?.();
      if (!service) {
        return { version: WORKBENCH_PROTOCOL_VERSION, state: "unsupported", reason: "the owned kernel has no branch decision capability" };
      }
      const request = {
        id: requireId(body.id, "decision id"),
        commandId: requireId(body.commandId, "decision command id"),
        expectedRevision: revisionOrThrow(body.expectedRevision),
        option: requireId(body.option, "decision option"),
      };
      const outcome = service.selectHuman(request);
      return { version: WORKBENCH_PROTOCOL_VERSION, state: "available", decision: decisionWire(outcome.decision) };
    }
    if (operation === "start") {
      const body = requireObject(params, ["version", "binding", "operation", "id", "commandId", "expectedRevision", "childThreadId"], "workbench.decision params");
      const runtime = kernel?.branchRuntime?.();
      if (!runtime) {
        return {
          version: WORKBENCH_PROTOCOL_VERSION,
          state: "unsupported",
          reason: "the owned kernel has no runnable branch runtime capability",
        };
      }
      // Settlement authority for a start: the owning session must not carry
      // inherited inbox state, an in-flight turn, OR unresolved gateway
      // ledger commands — the same durable predicate checkpoint create uses,
      // so a restart-time submit intent without its receipt (an unknown
      // effect) fences the start with zero parent rows.
      this.refreshLedger();
      this.refuseInheritedInbox(binding.sessionId, "workbench.decision.start");
      const startLifecycle = scanSessionLifecycle(this.openSessionLog(binding.sessionId).events);
      const unresolved = [...this.ledger.values()].some(
        (entry) =>
          entry.clientId === binding.clientId &&
          entry.threadId === binding.threadId &&
          !isResolved(entry, startLifecycle.get(entry.commandId)),
      );
      if (unresolved || this.activeCommandId !== undefined || (kernel !== undefined && kernel.busy())) {
        throw new Error("workbench.decision.start refused: the owned session is not settled");
      }
      let outcome: Awaited<ReturnType<DesktopBranchRuntime["startChild"]>>;
      try {
        outcome = await runtime.startChild({
          commandId: requireId(body.commandId, "decision command id"),
          decisionId: requireId(body.id, "decision id"),
          expectedRevision: revisionOrThrow(body.expectedRevision),
          owner: { clientId: binding.clientId, threadId: binding.threadId },
          childThreadId: requireId(body.childThreadId, "child thread id"),
        });
      } catch (error) {
        // Decision-shaped state conflicts answer as closed envelope states;
        // validation and command-reuse refusals stay RPC errors carrying
        // only the closed code.
        const code = error instanceof Error && error.name === "BranchRuntimeError"
          ? error.message.replace(/^branch-runtime: /u, "")
          : undefined;
        if (code === "branch_runtime_not_selected" || code === "branch_runtime_application_exists") {
          return { version: WORKBENCH_PROTOCOL_VERSION, state: "conflict", reason: code };
        }
        throw error;
      }
      return { version: WORKBENCH_PROTOCOL_VERSION, ...runtimeOutcomeWire(outcome) };
    }
    if (operation === "status") {
      const body = requireObject(params, ["version", "binding", "operation", "id"], "workbench.decision params");
      const id = requireId(body.id, "decision id");
      // Historical status is PURE retained same-prefix authority: the SAME
      // refreshed session prefix and retained reader feed BOTH the
      // canonical decision fold and the runtime projection — no live
      // kernel, decision service or runtime capability is consulted, so a
      // trusted cold reader answers after any restart or capability loss.
      // A genuinely missing decision id is unknown; a corrupt decision or
      // runtime fold is an explicit INVALID read, never a missing
      // fallback. Write-free and boot-free (R8-05).
      this.refreshLedger();
      const sessionLog = this.openSessionLog(binding.sessionId);
      const retained = this.retainedReader(sessionLog);
      let decision: DecisionSnapshot | undefined;
      let start: BranchRuntimeStartView | undefined;
      try {
        decision = projectBranchDecisions(sessionLog.events, retained).decisions.get(id);
        if (sessionLog.events.some(row => row.name.startsWith("branch/runtime_"))) {
          for (const view of projectBranchRuntime(sessionLog.events, retained).starts.values()) {
            if (view.decisionId === id) {
              start = view;
              break;
            }
          }
        }
      } catch {
        // Keep the five-state success envelope closed. Corrupt authority
        // refuses through RPC with a bounded code, not missing/available.
        throw new Error("branch_runtime_status_invalid");
      }
      if (decision === undefined) {
        return { version: WORKBENCH_PROTOCOL_VERSION, state: "unknown", reason: "branch_decision_unknown" };
      }
      if (start?.state === "ready" && start.child !== undefined) {
        return { version: WORKBENCH_PROTOCOL_VERSION, state: "ready", decision: decisionWire(decision), child: start.child };
      }
      // A durable runtime intent keeps the decision reserved-unknown even
      // before any application admission exists; only an admitted-but-
      // unconfirmed application is unknown for the admission's own sake.
      const reserved = start !== undefined || decision.application !== null;
      return {
        version: WORKBENCH_PROTOCOL_VERSION,
        state: reserved ? "unknown" : "available",
        decision: decisionWire(decision),
        ...(reserved ? { reason: "branch_runtime_start_reserved" } : {}),
      };
    }
    throw new Error(`workbench.decision: unknown operation ${JSON.stringify(String(operation))}`);
  }

  /**
   * R8-05 child-method envelope. Names an already recorded child id and a
   * whitelisted ordinary workbench method/params; the parent binding and
   * the recorded child owner/target binding are authenticated BEFORE any
   * child boot/read/effect. No legacy method, token or path forwarding; no
   * recursion; no decision or checkpoint mutation inside the child
   * envelope. A read never creates or reconnects a kernel — only an
   * explicit child bind resumes a confirmed recorded child.
   */
  private async branchSession(params: unknown): Promise<unknown> {
    const parsed = requireObject(params, ["version", "binding", "childId", "method", "params"], "workbench.branchSession params");
    requireVersion(parsed);
    const parentBinding = this.requireBinding(parsed.binding);
    const childId = requireId(parsed.childId, "child id");
    const method = typeof parsed.method === "string" ? parsed.method : "";
    if (!BRANCH_SESSION_METHODS.has(method)) {
      throw new Error(`workbench.branchSession forbids method ${JSON.stringify(method)}`);
    }
    const runtime = this.config.getKernel()?.branchRuntime?.();
    if (!runtime) {
      throw new Error("workbench.branchSession refused: no runnable branch runtime capability");
    }
    // The recorded owning client and target thread are authenticated before
    // any child gateway, boot or effect exists for this call.
    const descriptor = runtime.childForOwner(childId, {
      clientId: parentBinding.clientId,
      threadId: parentBinding.threadId,
    });
    const inner = parsed.params;
    if (isRecord(inner) && inner.binding !== undefined) {
      const fields = requireBindingFields(inner.binding);
      if (fields.clientId !== descriptor.binding.clientId || fields.threadId !== descriptor.binding.threadId) {
        throw new Error("workbench.branchSession params bind another client/thread");
      }
    }
    // `workbench.bind` carries its identity at the TOP level of the inner
    // params: verify it against the recorded child binding at the envelope,
    // before any child gateway exists or a ledger row can land (R8-05).
    if (method === "workbench.bind" && isRecord(inner)) {
      const clientId = typeof inner.clientId === "string" ? inner.clientId : undefined;
      const threadId = typeof inner.threadId === "string" ? inner.threadId : undefined;
      if (clientId !== descriptor.binding.clientId || threadId !== descriptor.binding.threadId) {
        throw new Error("workbench.branchSession refuses a bind for another client/thread");
      }
    }
    const gateway = runtime.childGateway(childId);
    return await gateway.handle(method, inner);
  }
}

/** The ordinary child methods a branchSession envelope may route. Recursive
 * branchSession and decision/checkpoint mutation are excluded by
 * construction: the child envelope is chat surface only. */
const BRANCH_SESSION_METHODS = new Set([
  "workbench.handshake",
  "workbench.bind",
  "workbench.read",
  "workbench.submit",
  "workbench.commandStatus",
  "workbench.cancel",
  "workbench.detach",
  "workbench.overview",
  "workbench.usage",
  "workbench.graph",
  "workbench.graph.explore",
  "workbench.code",
  "workbench.codeAction",
  "workbench.record",
  "workbench.record.index",
  "workbench.record.body",
  "workbench.workMode",
]);

function revisionOrThrow(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid expectedRevision ${JSON.stringify(String(value))}`);
  }
  return value;
}

/** A work-mode expected revision is the opaque SHA-256 a read answered. */
function requireWorkModeRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(
      `invalid expectedRevision ${JSON.stringify(String(value))} — must be the SHA-256 revision a work-mode read answered`,
    );
  }
  return value;
}

/** The closed work-mode selection wire shape: plain data only. */
function selectionWire(selection: WorkModeSelection): {
  mode: WorkModeSelection["mode"];
  effective: "chat" | "work";
  source: "default" | "session";
  revision: string;
} {
  return {
    mode: selection.mode,
    effective: selection.effective,
    source: selection.source,
    revision: selection.revision,
  };
}

/** Service outcomes as the closed version-1 work-mode envelope states. */
function workModeWire(outcome: WorkModeCommandOutcome): Record<string, unknown> {
  if (outcome.state === "applied") {
    return {
      version: WORKBENCH_PROTOCOL_VERSION,
      state: "applied",
      commandId: outcome.commandId,
      selection: selectionWire(outcome.selection),
      duplicate: outcome.duplicate,
    };
  }
  return {
    version: WORKBENCH_PROTOCOL_VERSION,
    state: outcome.state,
    reason: outcome.reason,
    commandId: outcome.commandId,
  };
}

/** The closed decision snapshot wire shape: plain bounded data with local
 * citations, never a synthetic applied outcome, token or blob. */
function decisionWire(snapshot: DecisionSnapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    revision: snapshot.revision,
    state: snapshot.state,
    kind: snapshot.kind,
    question: snapshot.question,
    options: snapshot.options.map((option) => ({ id: option.id, label: option.label })),
    recommendation: snapshot.recommendation,
    rationale: snapshot.rationale,
    policy: snapshot.policy === null ? null : {
      id: snapshot.policy.id, version: snapshot.policy.version,
      afterMs: snapshot.policy.afterMs, deadline: snapshot.policy.deadline,
    },
    openedAt: snapshot.openedAt,
    selected: snapshot.selected === null ? null : {
      option: snapshot.selected.option,
      actor: snapshot.selected.actor,
      commandId: snapshot.selected.commandId,
      at: snapshot.selected.at,
      ref: { seq: snapshot.selected.ref.seq, hash: snapshot.selected.ref.hash },
    },
    application: snapshot.application === null ? null : {
      commandId: snapshot.application.commandId,
      state: snapshot.application.state,
      ref: { seq: snapshot.application.ref.seq, hash: snapshot.application.ref.hash },
    },
    alternateOf: snapshot.alternateOf === null ? null : {
      id: snapshot.alternateOf.id,
      selection: { seq: snapshot.alternateOf.selection.seq, hash: snapshot.alternateOf.selection.hash },
    },
    citations: snapshot.citations,
  };
}

/** The start outcomes as closed envelope states: a confirmed ready child
   carries its host-derived descriptor; unknown keeps the reserved start
   visible; a state conflict names its reason. */
function runtimeOutcomeWire(outcome: {
  state: "ready" | "unknown" | "conflict";
  decision?: DecisionSnapshot;
  reason?: string;
  child?: { id: string; sessionId: string; workspacePath: string; parent: { clientId: string; threadId: string }; binding: { clientId: string; threadId: string } };
}): Record<string, unknown> {
  return {
    state: outcome.state,
    ...(outcome.decision !== undefined ? { decision: decisionWire(outcome.decision) } : {}),
    ...(outcome.child !== undefined
      ? {
        child: {
          id: outcome.child.id,
          sessionId: outcome.child.sessionId,
          workspacePath: outcome.child.workspacePath,
          parent: { ...outcome.child.parent },
          binding: { ...outcome.child.binding },
        },
      }
      : {}),
    ...(outcome.state !== "ready" && outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

/** Validation-shaped branch runtime refusals surface as RPC errors (the
 * same closed code, never a path or secret); decision-shaped state
 * conflicts remain envelope states. */
function branchRuntimeWireError(error: unknown): unknown {
  if (error instanceof Error && error.name === "BranchRuntimeError") {
    return error;
  }
  return error;
}

function headFields(head: LogHead): { seq: number; hash: string; generation: string } {
  return { seq: head.seq, hash: head.hash, generation: head.generation };
}

function withOptionalFields(derived: ReturnType<typeof deriveCommandState>): Record<string, unknown> {
  return {
    state: derived.state,
    ...(derived.outcome !== undefined ? { outcome: derived.outcome } : {}),
    ...(derived.detail !== undefined ? { detail: derived.detail } : {}),
    ...(derived.sources !== undefined ? { sources: derived.sources } : {}),
    ...(derived.messageSeq !== undefined
      ? { messageSeq: derived.messageSeq, messageHash: derived.messageHash }
      : {}),
  };
}
