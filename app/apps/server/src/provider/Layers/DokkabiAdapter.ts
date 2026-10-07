/**
 * Dokkabi workbench adapter — the provider-native session surface over the
 * harness gateway's closed `workbench.*` protocol.
 *
 * Authority rules (dokkabi-app docs/internals/dokkabi-harness-r2.md):
 * - The harness owns the workspace lifecycle. This adapter exposes
 *   `workspaceLifecycle: "harness"` and, while enabled AND configured, the
 *   configured workspace root — the app's shared ownership policy gates
 *   worktree/checkpoint/terminal/editor mutations for it; the adapter
 *   itself never mutates anything either.
 * - The gateway's permission policy is authoritative and never
 *   app-selected: R2 supports an explicit `bypass` harness workspace driven
 *   by the app's `full-access` runtime mode only. Any other permissionMode
 *   or app policy is refused BEFORE bind/submit with a setup reason.
 * - Sessions bind only when the operator starts one, with the app's own
 *   stable client/thread ids. There is no discovery thread, no fresh-start
 *   and no background title/continuation model call — every model input is
 *   an explicit operator submit carrying the orchestration command id.
 * - A transport receipt alone creates no user row or verified task. Runtime
 *   items are projected ONLY from the gateway's recorded transcript, with
 *   stable source-derived ids (session + generation + card seq + event
 *   kind/content digest) and each item correlated to its real recorded
 *   submit turn through the command receipts' lifecycle source ranges —
 *   never inferred FIFO, never synthetic verified work. Recorded note cards
 *   (the real user/message text, possibly inbox-folded) stay in
 *   readThread snapshots; they are not re-emitted as runtime items because
 *   the app already owns the optimistic user row and R2 rejects inherited
 *   inbox state.
 * - Resume state is validated, not spliced: a foreign or malformed cursor
 *   is refused, and a replaced gateway log is a VISIBLE freeze-and-rebuild
 *   from the validated full snapshot — never a silent erase or rebase.
 * - Uncertain submits reconcile through `workbench.commandStatus` and are
 *   never blind-retried; a settled duplicate is never reopened as a fresh
 *   turn; `turn.started` is always emitted before its settlement so a
 *   completion-before-start race cannot exist. Stop clears the active
 *   command only when the RECORDED settlement establishes termination — a
 *   requested cancellation that has not settled leaves the turn running.
 * - Stopping/detaching releases the transport binding only: the kernel and
 *   an active turn keep running, and no finalizer cancels or closes the
 *   kernel. Exactly one poller fiber runs per bound thread, is interrupted
 *   on detach, and the event queue ends when the adapter scope closes.
 *
 * @module provider/Layers/DokkabiAdapter
 */
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDate:off
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as NodeCrypto from "node:crypto";

import type {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderRuntimeItemCompletedEvent,
  ProviderRuntimeItemStartedEvent,
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionStateChangedEvent,
  ProviderRuntimeTurnAbortedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ProviderWorkbenchOverviewResult,
  ProviderWorkbenchScopedUsage,
  ProviderWorkbenchGraphResult,
  ProviderWorkbenchRecordResult,
  ProviderWorkbenchRecordIndexResult,
  ProviderWorkbenchRecordBodyResult,
  ProviderWorkbenchRecordVerificationResult,
  ProviderWorkbenchGraphExploreResult,
  ProviderWorkbenchCodeResult,
  ProviderWorkbenchCodeActionInput,
  ProviderWorkbenchCodeActionResult,
  ProviderGetWorkbenchCodeInput,
  ProviderWorkbenchDecisionActionResult,
  ProviderWorkbenchDecisionDefinition,
  ProviderWorkbenchDecisionsResult,
  ProviderWorkbenchWorkModeActionResult,
  ProviderWorkbenchWorkModeResult,
  RuntimeMode,
  ThreadId,
  WorkbenchGraphType,
  WorkbenchRecordAsOf,
  WorkbenchRecordBodyExpected,
  WorkbenchRecordCursor,
  WorkbenchGraphExploreQueryInput,
  WorkbenchGraphExploreSnapshot,
} from "@t3tools/contracts";
import {
  EventId,
  CodeActionRequestFields,
  ProviderDriverKind as ProviderDriverKindSchema,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeItemId,
  TurnId,
} from "@t3tools/contracts";

import { ProviderAdapterRequestError, ProviderAdapterProcessError } from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  BindSchema,
  BranchDescriptorSchema,
  CancelSchema,
  CheckpointSchema,
  CommandStatusSchema,
  DecisionSchema,
  DecisionsSchema,
  DetachSchema,
  GraphExploreSchema,
  GraphSchema,
  HandshakeSchema,
  ModelSelectionSchema,
  OverviewSchema,
  ReadSchema,
  RecordBodySchema,
  RecordIndexSchema,
  RecordSchema,
  CodeSchema,
  CodeActionSchema,
  SubmitSchema,
  UsageSchema,
  WorkModeSchema,
  decodeResult,
  isWorkbenchTransportLost,
  validateWorkbenchUrl,
  workbenchRequest,
  WorkbenchTransport,
  WorkbenchTransportLost,
  type BranchDescriptorResult,
  type CheckpointResult,
  type DecisionResult,
  type DecisionsResult,
  type GraphResult,
  type HandshakeResult,
  type OverviewResult,
  type ReadResult,
  type RecordBodyResult,
  type RecordResult,
  type CodeResult,
  type SubmitResult,
  type UsageResult,
  type WorkModeResult,
} from "../dokkabi/WorkbenchClient.ts";
import { verifyCodeRead } from "../dokkabi/CodeRead.ts";
import { requestedDokkabiModel } from "../dokkabi/ModelSelection.ts";
import { verifyRecordRead } from "../dokkabi/RecordChain.ts";
import {
  RECORD_BODY_MAX_BYTES,
  RECORD_VERIFY_MAX_BYTES,
  RecordBodyStreamVerifier,
  verifyRecordBodyRange,
  verifyRecordIndexRead,
} from "../dokkabi/RecordExplorer.ts";
import { normalizeGraphExploreQuery, verifyGraphExploreRead } from "../dokkabi/GraphExplorer.ts";
import {
  STRICT_DECODE_OPTIONS,
  isWorkbenchId,
  workbenchParamsSchemas,
  type WorkbenchCommandState,
} from "../dokkabi/WorkbenchProtocol.ts";
import type { WorkbenchCursor, WorkbenchSessionCursor } from "../dokkabi/WorkbenchProtocol.ts";
import {
  validateTokenEnvName,
  WorkbenchTransportError,
  type WorkbenchSocket,
} from "../dokkabi/WorkbenchTransport.ts";

const PROVIDER_KIND = ProviderDriverKindSchema.make("dokkabi") as ProviderDriverKind;

export const DOKKABI_DRIVER_KIND = "dokkabi";

const decodeCodeAction = Schema.decodeEffect(Schema.Struct(CodeActionRequestFields), {
  onExcessProperty: "error",
});

const POLL_INTERVAL_MS = 1_200;
/** Bounded wait for a RECORDED settlement after a cancel; not a model cap. */
const CANCEL_SETTLEMENT_WAIT_MS = 3_000;
const CANCEL_SETTLEMENT_POLL_MS = 150;
/** The only harness permission policy R2 can truthfully drive. */
const SUPPORTED_PERMISSION_MODE = "bypass";
/** The only app runtime mode that maps onto that policy. */
const REQUIRED_RUNTIME_MODE: RuntimeMode = "full-access";

type SessionStatus = "ready" | "running" | "error";

interface CommandProjection {
  /** Wire command id (gateway vocabulary). */
  readonly commandId: string;
  /** The orchestration id it stands for, when an alias was needed. */
  readonly originalId: string | undefined;
  state: WorkbenchCommandState;
  outcome: "success" | "failure" | "operator_abort" | undefined;
  startSeq: number | undefined;
  /** Recorded ts of the verified `chat/turn_started` row at `startSeq`. */
  startAt: string | undefined;
  endSeq: number | undefined;
  /** Recorded ts of the verified `chat/turn_settled` row behind the settlement. */
  settledAt: string | undefined;
}

/**
 * R8 prepared-child routing: when set, EVERY ordinary wire operation for this
 * thread travels the closed `workbench.branchSession` envelope under the
 * authenticated parent owner — the child has its own gateway, ledger and
 * kernel, and never falls back to the parent handshake session or the
 * adapter's configured parent workspace.
 */
interface ChildRoute {
  readonly childId: string;
  readonly parentBinding: { readonly clientId: string; readonly threadId: string };
  readonly workspacePath: string;
  /**
   * Model fixed at preparation from the actual parent selection (or, for a
   * reconcile adoption with no preparation-time capture, refined to the
   * child's own established handshake model so it stays persisted for exact
   * later checks); a current child boot reporting a different model refuses.
   */
  parentModel: string | undefined;
}

interface ThreadState {
  readonly threadId: ThreadId;
  readonly clientId: string;
  sessionId: string;
  /** Session log generation the projection was built from. */
  generation: string;
  sessionCursor: WorkbenchSessionCursor | undefined;
  gatewayCursor: WorkbenchCursor | undefined;
  /** Active command (wire id) per the gateway's recorded state. */
  activeCommandId: string | undefined;
  status: SessionStatus;
  lastError: string | undefined;
  /**
   * Source-mismatch latch: the gateway's recorded log was replaced or
   * truncated after this thread had a validated view. R2 has no safe
   * full-projection replace protocol, so the prior conversation, cursors and
   * command mapping are PRESERVED, nothing new is projected from the
   * replaced source, and Sends are refused until the operator reconciles
   * (detach + fresh conversation). Persisted through resumeCursor.
   */
  quarantined: string | undefined;
  /**
   * Invalid source views refused before projection for missing or invalid
   * recorded card/lifecycle times. A valid complete read clears the refusal;
   * until then sending is disabled and prior cursors/history are preserved.
   */
  readonly sourceTimeRefusedFor: Set<string>;
  runtimeMode: RuntimeMode | undefined;
  model: string | undefined;
  route: string | undefined;
  modelChangeCapability?: boolean;
  /** R8-06j2: the handshake's optional work-mode capability for this
   * session's gateway; false means the adapter never calls the method. */
  workModeCapability: boolean | undefined;
  /** R8: set exactly for adopted prepared-child conversations. */
  childOf: ChildRoute | undefined;
  /** Card seq → serialized card + attribution, so joined-card updates and
   * re-attributions re-emit as upserts, never duplicate deltas. */
  readonly cards: Map<number, string>;
  /** Wire command id → projection (ranges from recorded lifecycle sources). */
  commands: Map<string, CommandProjection>;
  /** Wire → original orchestration id for aliased commands. */
  readonly aliases: Map<string, string>;
  /** Commands whose source-derived turn.started was already emitted. */
  readonly turnStartsEmitted: Set<string>;
  /** Commands whose terminal runtime event was already emitted. */
  readonly settledEmitted: Set<string>;
  /** One-time visibility for unknown/staged/rejected commands and pending stops. */
  readonly attentionEmitted: Set<string>;
  /** Approval card seqs whose request.opened was already emitted. */
  readonly approvalsOpened: Set<number>;
  pollFiber: Fiber.Fiber<void, never> | undefined;
  consecutiveReadFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface DokkabiAdapterConfig {
  readonly enabled: boolean;
  readonly gatewayUrl: string;
  readonly tokenEnv: string;
  /** Private bundled pairing credentials; external mode resolves process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly workspacePath: string;
  readonly instanceId: ProviderInstanceId;
}

export type DokkabiAdapterError = ProviderAdapterRequestError | ProviderAdapterProcessError;

export interface DokkabiAdapterOptions {
  /** Stable client identity; defaults to the instance's routing key. */
  readonly clientId: string | undefined;
  readonly pollIntervalMs: number | undefined;
  /** Bounded wait for a recorded settlement after a cancel. */
  readonly cancelSettlementWaitMs: number | undefined;
  /** Test seam for the gateway transport socket; production uses the
   * global WebSocket against the operator's loopback gateway. */
  readonly socketFactory:
    | ((url: string, protocols?: ReadonlyArray<string>) => WorkbenchSocket)
    | undefined;
}

/**
 * The recorded prepared-child descriptor persisted through resume state —
 * exactly the frozen R8 wire fields (the app's durable memory of the child
 * the harness confirmed). Validated with the same invariants the wire schema
 * enforces: the child client equals its parent's, the thread is distinct,
 * and the workspace path is bounded and credential-free.
 */
interface DokkabiChildState {
  readonly id: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly parent: { readonly clientId: string; readonly threadId: string };
  readonly binding: { readonly clientId: string; readonly threadId: string };
}

/** Resume state persisted through `ProviderSession.resumeCursor`. */
interface DokkabiResumeState {
  readonly binding: { readonly clientId: string; readonly threadId: string };
  readonly sessionId: string;
  readonly sessionCursor: WorkbenchSessionCursor | undefined;
  readonly gatewayCursor: WorkbenchCursor | undefined;
  readonly activeCommandId: string | undefined;
  readonly commandAliases: ReadonlyArray<readonly [string, string]>;
  /** Persisted source-mismatch latch from a previous incarnation. */
  readonly sourceMismatch: boolean;
  /** R8: present exactly when this thread is a recorded prepared child. */
  readonly child: DokkabiChildState | undefined;
  /** R8: the model fixed at preparation from the actual parent selection. */
  readonly parentModel: string | undefined;
}

const WORKSPACE_PATH_MAX_LENGTH = 1024;

const parseChildState = (
  value: unknown,
): { ok: true; value: DokkabiChildState } | { ok: false; reason: string } => {
  const record = asRecord(value);
  if (record === undefined) return { ok: false, reason: "child descriptor is not an object" };
  const unknownKeys = Object.keys(record).filter(
    (key) => !["id", "sessionId", "workspacePath", "parent", "binding"].includes(key),
  );
  if (unknownKeys.length > 0) {
    return { ok: false, reason: `child descriptor has unknown fields (${unknownKeys.join(", ")})` };
  }
  if (
    typeof record.id !== "string" ||
    !isWorkbenchId(record.id) ||
    typeof record.sessionId !== "string" ||
    !isWorkbenchId(record.sessionId) ||
    typeof record.workspacePath !== "string" ||
    record.workspacePath.length === 0 ||
    record.workspacePath.length > WORKSPACE_PATH_MAX_LENGTH
  ) {
    return { ok: false, reason: "child descriptor identity is malformed" };
  }
  const parent = asRecord(record.parent);
  const binding = asRecord(record.binding);
  if (
    parent === undefined ||
    binding === undefined ||
    typeof parent.clientId !== "string" ||
    typeof parent.threadId !== "string" ||
    typeof binding.clientId !== "string" ||
    typeof binding.threadId !== "string" ||
    parent.clientId.length === 0 ||
    parent.threadId.length === 0 ||
    binding.clientId.length === 0 ||
    binding.threadId.length === 0
  ) {
    return { ok: false, reason: "child descriptor ownership is malformed" };
  }
  if (binding.clientId !== parent.clientId) {
    return { ok: false, reason: "child descriptor binding client must equal its parent client" };
  }
  if (binding.threadId === parent.threadId) {
    return {
      ok: false,
      reason: "child descriptor binding thread must be distinct from its parent",
    };
  }
  return {
    ok: true,
    value: {
      id: record.id,
      sessionId: record.sessionId,
      workspacePath: record.workspacePath,
      parent: { clientId: parent.clientId, threadId: parent.threadId },
      binding: { clientId: binding.clientId, threadId: binding.threadId },
    },
  };
};

/** The envelope route a resumed recorded child adopts from its resume state. */
const childRouteFromResume = (resume: DokkabiResumeState): ChildRoute | undefined =>
  resume.child === undefined
    ? undefined
    : {
        childId: resume.child.id,
        parentBinding: resume.child.parent,
        workspacePath: resume.child.workspacePath,
        parentModel: resume.parentModel,
      };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sha256Hex = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

const digestOf = (text: string): string => sha256Hex(text).slice(0, 12);

const isRequestError = Schema.is(ProviderAdapterRequestError);
const isTransportLost = Schema.is(WorkbenchTransportLost);

/**
 * Stable wire mapping for orchestration command ids the gateway's id
 * vocabulary cannot carry (colons, >128 chars, …). Deterministic, so the
 * same orchestration id always maps to the same wire id across restarts.
 */
const toWireCommandId = (original: string): string =>
  isWorkbenchId(original) ? original : `app-cmd-${sha256Hex(original).slice(0, 40)}`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

/** A string source ref we can carry as a candidate recorded time. */
const sourceTimeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * A usable recorded source time: present, non-blank and parseable. A
 * recorded turn start/settlement without one is REFUSED — never stamped
 * with the projection clock.
 */
const isValidRecordedTime = (value: string | undefined): value is string =>
  value !== undefined &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));

const parseCursor = (
  value: unknown,
): { seq: number; hash: string; generation: string } | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const { seq, hash, generation } = record;
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    !isHex64(hash) ||
    !isHex64(generation)
  ) {
    return undefined;
  }
  return { seq, hash, generation };
};

const parseSessionCursor = (
  value: unknown,
): (WorkbenchSessionCursor & { seq: number; hash: string; generation: string }) | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
  const cursor = parseCursor(record);
  if (cursor === undefined) return undefined;
  return { sessionId: record.sessionId, ...cursor };
};

/**
 * Strict resume-state validation. A malformed or foreign cursor is refused
 * explicitly — never silently spliced onto a fresh view.
 */
const parseResumeState = (
  raw: unknown,
): { ok: true; value: DokkabiResumeState } | { ok: false; reason: string } => {
  const record = asRecord(raw);
  if (record === undefined) {
    return { ok: false, reason: "resume state is not an object" };
  }
  const unknownKeys = Object.keys(record).filter(
    (key) =>
      ![
        "binding",
        "sessionId",
        "sessionCursor",
        "gatewayCursor",
        "activeCommandId",
        "commandAliases",
        "sourceMismatch",
        "child",
        "parentModel",
      ].includes(key),
  );
  if (unknownKeys.length > 0) {
    return { ok: false, reason: `resume state has unknown fields (${unknownKeys.join(", ")})` };
  }
  const binding = asRecord(record.binding);
  if (binding === undefined) {
    return { ok: false, reason: "resume state has no binding" };
  }
  if (
    typeof binding.clientId !== "string" ||
    binding.clientId.length === 0 ||
    typeof binding.threadId !== "string" ||
    binding.threadId.length === 0
  ) {
    return { ok: false, reason: "resume binding is malformed" };
  }
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    return { ok: false, reason: "resume state has no sessionId" };
  }
  const sessionCursor =
    record.sessionCursor === undefined ? undefined : parseSessionCursor(record.sessionCursor);
  if (record.sessionCursor !== undefined && sessionCursor === undefined) {
    return { ok: false, reason: "resume sessionCursor is malformed" };
  }
  const gatewayCursor =
    record.gatewayCursor === undefined ? undefined : parseCursor(record.gatewayCursor);
  if (record.gatewayCursor !== undefined && gatewayCursor === undefined) {
    return { ok: false, reason: "resume gatewayCursor is malformed" };
  }
  const activeCommandId = record.activeCommandId === undefined ? undefined : record.activeCommandId;
  if (
    activeCommandId !== undefined &&
    (typeof activeCommandId !== "string" || activeCommandId.length === 0)
  ) {
    return { ok: false, reason: "resume activeCommandId is malformed" };
  }
  if (record.sourceMismatch !== undefined && typeof record.sourceMismatch !== "boolean") {
    return { ok: false, reason: "resume sourceMismatch is malformed" };
  }
  const aliases: Array<readonly [string, string]> = [];
  if (record.commandAliases !== undefined) {
    const aliasRecord = asRecord(record.commandAliases);
    if (aliasRecord === undefined) {
      return { ok: false, reason: "resume commandAliases is malformed" };
    }
    for (const [wire, original] of Object.entries(aliasRecord)) {
      if (typeof original !== "string" || original.length === 0) {
        return { ok: false, reason: "resume commandAliases is malformed" };
      }
      aliases.push([wire, original] as const);
    }
  }
  let child: DokkabiChildState | undefined;
  if (record.child !== undefined) {
    const parsedChild = parseChildState(record.child);
    if (!parsedChild.ok) {
      return { ok: false, reason: `resume child descriptor is malformed (${parsedChild.reason})` };
    }
    child = parsedChild.value;
  }
  if (child !== undefined && child.binding.threadId !== binding.threadId) {
    return {
      ok: false,
      reason: "resume child descriptor names a different target thread than the resume binding",
    };
  }
  if (record.parentModel !== undefined && typeof record.parentModel !== "string") {
    return { ok: false, reason: "resume parentModel is malformed" };
  }
  return {
    ok: true,
    value: {
      binding: { clientId: binding.clientId, threadId: binding.threadId },
      sessionId: record.sessionId,
      sessionCursor,
      gatewayCursor,
      activeCommandId,
      commandAliases: aliases,
      sourceMismatch: record.sourceMismatch === true,
      child,
      parentModel: record.parentModel,
    },
  };
};

const approvalRequestType = (approvalKind: string) => {
  if (approvalKind.includes("permission")) return "permission_approval" as const;
  if (approvalKind.includes("patch")) return "apply_patch_approval" as const;
  if (approvalKind.includes("exec") || approvalKind.includes("command")) {
    return "command_execution_approval" as const;
  }
  if (approvalKind.includes("file") || approvalKind.includes("edit")) {
    return "file_change_approval" as const;
  }
  return "unknown" as const;
};

/**
 * The host's terminal work summaries (dokkabi-dev src/dash/transcript.ts):
 * system cards for recorded OBSERVE work/run_result / work/operator_report
 * rows, whose text the harness projection opens with a "Host work " label.
 * Exactly those labelled cards are published as MAIN conversation
 * system_message items — the harness's own verdict, never a model reply.
 * Every other system record, and prose under these event names without the
 * label, stays a quiet system item; no text is parsed beyond the label gate.
 */
const HOST_WORK_REPORT_EVENTS = new Set(["work/run_result", "work/operator_report"]);
const HOST_WORK_REPORT_LABEL = "Host work ";

const isHostWorkReportCard = (card: { event: string; text: string }): boolean =>
  HOST_WORK_REPORT_EVENTS.has(card.event) && card.text.startsWith(HOST_WORK_REPORT_LABEL);

export function makeDokkabiAdapter(
  config: DokkabiAdapterConfig,
  options: DokkabiAdapterOptions = {
    clientId: undefined,
    pollIntervalMs: undefined,
    cancelSettlementWaitMs: undefined,
    socketFactory: undefined,
  },
): Effect.Effect<
  ProviderAdapterShape<DokkabiAdapterError>,
  DokkabiAdapterError,
  Scope.Scope | Crypto.Crypto
> {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const clientId = options.clientId ?? `dokkabi-app-${config.instanceId}`;
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const cancelSettlementWaitMs = options.cancelSettlementWaitMs ?? CANCEL_SETTLEMENT_WAIT_MS;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent, Cause.Done>();
    /** Serializes every projection/mutation so poll, send, start and stop
     * interleavings cannot tear thread state. */
    const gate = yield* Semaphore.make(1);
    let foregroundOperations = 0;
    let closing = false;
    const threads = new Map<ThreadId, ThreadState>();
    /**
     * R8: every CONFIRMED child workspace root joins the adapter's
     * harness-owned reservation set so the shared ownership policy protects
     * child roots exactly like the parent root. Populated on adoption and on
     * recorded-child resume; entries stay for the adapter's lifetime (a
     * released root needs its own recorded release contract before removal).
     */
    const childWorkspaceRoots = new Map<ThreadId, string>();
    /** Created lazily: a disabled/unconfigured adapter never opens a socket. */
    let transport: WorkbenchTransport | undefined;
    let configFailure: string | undefined = (() => {
      if (config.gatewayUrl.trim().length === 0) {
        return "gateway URL is empty";
      }
      const urlCheck = validateWorkbenchUrl(config.gatewayUrl);
      if (!urlCheck.ok) return urlCheck.reason;
      if (config.workspacePath.trim().length === 0) {
        return "gateway workspace path is empty";
      }
      const tokenEnvCheck = validateTokenEnvName(config.tokenEnv);
      if (!tokenEnvCheck.ok) return tokenEnvCheck.reason;
      return undefined;
    })();

    const requireConfig = (): Effect.Effect<WorkbenchTransport, DokkabiAdapterError> => {
      if (configFailure !== undefined) {
        return Effect.fail(
          new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method: "adapter.config",
            detail: configFailure,
          }),
        );
      }
      if (transport === undefined) {
        const urlCheck = validateWorkbenchUrl(config.gatewayUrl);
        if (!urlCheck.ok) {
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: DOKKABI_DRIVER_KIND,
              method: "adapter.config",
              detail: urlCheck.reason,
            }),
          );
        }
        transport = new WorkbenchTransport({
          url: urlCheck.url,
          tokenEnv: config.tokenEnv,
          ...(config.env !== undefined ? { env: config.env } : {}),
          ...(options.socketFactory !== undefined ? { socketFactory: options.socketFactory } : {}),
        });
      }
      return Effect.succeed(transport);
    };

    const nowIso = () => new Date().toISOString();

    // Retain the RPC code privately; public adapter errors keep their existing shape.
    const requestRpcCodes = new WeakMap<ProviderAdapterRequestError, number>();
    const failRequest = (
      method: string,
      detail: string,
    ): Effect.Effect<never, DokkabiAdapterError> =>
      Effect.fail(new ProviderAdapterRequestError({ provider: PROVIDER_KIND, method, detail }));
    const failProcess = (
      method: string,
      threadId: ThreadId,
      detail: string,
    ): Effect.Effect<never, DokkabiAdapterError> =>
      Effect.fail(new ProviderAdapterProcessError({ provider: PROVIDER_KIND, threadId, detail }));

    /**
     * One gateway round trip. A transport failure before the response is
     * kept as `WorkbenchTransportLost` — the effect may or may not have
     * happened — so callers reconcile instead of blindly retrying. All
     * surfaced text (gateway error messages, schema-decode failures) passes
     * the transport's redaction choke point.
     */
    const call = <T>(
      method: Parameters<typeof workbenchRequest>[1],
      params: unknown,
      schema: Schema.Codec<T, unknown>,
      interruptibleRead = false,
    ): Effect.Effect<T, DokkabiAdapterError | WorkbenchTransportLost> =>
      requireConfig().pipe(
        Effect.flatMap((wire) =>
          workbenchRequest(wire, method, params, interruptibleRead).pipe(
            Effect.flatMap((reply) => {
              if (reply.error !== undefined) {
                const error = new ProviderAdapterRequestError({
                  provider: PROVIDER_KIND,
                  method,
                  detail: wire.redactText(reply.error.message),
                });
                requestRpcCodes.set(error, reply.error.code);
                return Effect.fail(error);
              }
              return decodeResult({ method, schema, result: reply.result }).pipe(
                Effect.mapError(
                  (error: { message: string }) =>
                    new ProviderAdapterRequestError({
                      provider: DOKKABI_DRIVER_KIND,
                      method,
                      detail: wire.redactText(error.message),
                    }),
                ),
              );
            }),
            Effect.mapError(
              (error: DokkabiAdapterError | WorkbenchTransportLost | WorkbenchTransportError) =>
                isRequestError(error)
                  ? error
                  : isTransportLost(error)
                    ? error
                    : new WorkbenchTransportLost({ detail: describe(error) }),
            ),
          ),
        ),
      );

    /** Collapse residual transport loss into a visible process error. */
    const collapseLost =
      (method: string, threadId: ThreadId) =>
      (error: DokkabiAdapterError | WorkbenchTransportLost): DokkabiAdapterError =>
        isTransportLost(error)
          ? new ProviderAdapterProcessError({
              provider: DOKKABI_DRIVER_KIND,
              threadId,
              detail: error.message,
            })
          : error;

    /**
     * R8 child routing: a thread with a ChildRoute sends EVERY ordinary
     * operation through the closed `workbench.branchSession` envelope under
     * the authenticated parent owner. The envelope names only the recorded
     * child id and one whitelisted ordinary method — never an arbitrary
     * endpoint, token or child path. Parent threads (childOf undefined) keep
     * the direct wire, byte-for-byte unchanged.
     */
    const callRouted = <T>(
      route: ChildRoute | undefined,
      method: Parameters<typeof workbenchRequest>[1],
      params: unknown,
      schema: Schema.Codec<T, unknown>,
      interruptibleRead = false,
    ): Effect.Effect<T, DokkabiAdapterError | WorkbenchTransportLost> =>
      route === undefined
        ? call(method, params, schema, interruptibleRead)
        : call(
            "workbench.branchSession",
            { version: 1, binding: route.parentBinding, childId: route.childId, method, params },
            schema,
            interruptibleRead,
          );

    const handshake = (route?: ChildRoute) =>
      callRouted(route, "workbench.handshake", { version: 1 }, HandshakeSchema);
    const bindThread = (state: ThreadState) =>
      callRouted(
        state.childOf,
        "workbench.bind",
        {
          version: 1,
          clientId: state.clientId,
          threadId: state.threadId,
          workspacePath: state.childOf?.workspacePath ?? config.workspacePath,
        },
        BindSchema,
      );
    const readOnce = (state: ThreadState, interruptibleRead = false) =>
      callRouted(
        state.childOf,
        "workbench.read",
        {
          version: 1,
          binding: { clientId: state.clientId, threadId: state.threadId },
          ...(state.sessionCursor !== undefined ? { sessionCursor: state.sessionCursor } : {}),
          ...(state.gatewayCursor !== undefined ? { gatewayCursor: state.gatewayCursor } : {}),
        },
        ReadSchema,
        interruptibleRead,
      );
    const commandStatus = (state: ThreadState, commandId: string) =>
      callRouted(
        state.childOf,
        "workbench.commandStatus",
        {
          version: 1,
          binding: { clientId: state.clientId, threadId: state.threadId },
          commandId,
        },
        CommandStatusSchema,
      );

    // --- typed runtime event builders (no blanket casts) ---

    interface EventBase {
      readonly eventId: EventId;
      readonly provider: ProviderDriverKind;
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: ThreadId;
      readonly createdAt: string;
      readonly replayKey?: string;
    }
    /**
     * Transient session/transport events keep the live clock and carry no
     * replay identity. Recorded source facts pass `recorded`: the event is
     * stamped with the SOURCE time and its stable source identity, so a
     * replay of unchanged history re-emits the byte-same observation and the
     * ingestion's durable receipts no-op it.
     */
    const eventBase = (
      state: ThreadState,
      eventId: string,
      recorded?: { readonly at: string; readonly replayKey: string },
    ): EventBase => ({
      eventId: EventId.make(eventId),
      provider: PROVIDER_KIND,
      providerInstanceId: config.instanceId,
      threadId: state.threadId,
      createdAt: recorded?.at ?? nowIso(),
      ...(recorded !== undefined ? { replayKey: recorded.replayKey } : {}),
    });

    /** Application rows are globally keyed: source identity must also be
     * scoped to the provider instance and receiving conversation. A canonical
     * tuple avoids delimiter collisions and stays fixed across a restart. */
    const scopedEventId = (state: ThreadState, scope: string): string =>
      `dokkabi:${sha256Hex(
        JSON.stringify([config.instanceId, state.threadId, state.sessionId, state.generation]),
      )}:${scope}`;

    /** Later observations retain the same scoped item identity. */
    const cardItemId = (state: ThreadState, seq: number): string =>
      scopedEventId(state, `card:${seq}`);

    const sessionStarted = (
      state: ThreadState,
      resume: unknown,
    ): ProviderRuntimeSessionStartedEvent => ({
      ...eventBase(state, scopedEventId(state, "session-started")),
      type: "session.started",
      payload: { resume },
    });

    const sessionStateChanged = (
      state: ThreadState,
      sessionState: "starting" | "running" | "ready" | "waiting" | "error" | "stopped",
      reason: string,
      key: string,
    ): ProviderRuntimeSessionStateChangedEvent => ({
      ...eventBase(state, scopedEventId(state, `state-${sessionState}-${digestOf(key)}`)),
      type: "session.state.changed",
      payload: { state: sessionState, reason: reason.slice(0, 200) },
    });

    const sessionExited = (
      state: ThreadState,
      reason: string,
    ): ProviderRuntimeSessionExitedEvent => ({
      ...eventBase(state, scopedEventId(state, "session-exited")),
      type: "session.exited",
      payload: { reason },
    });

    /** The runtime turn id is the ORCHESTRATION id whenever known, so
     * ingestion correlates settlements with the optimistic turn. */
    const turnIdFor = (state: ThreadState, command: CommandProjection): TurnId =>
      TurnId.make(command.originalId ?? command.commandId);

    /**
     * Recorded turn lifecycle events are timed by the verified source rows
     * (`turnStartAt`/`settlementAt` paired with their seqs by the gateway
     * contract). Callers must have validated the recorded time — a missing
     * or invalid time refuses projection rather than inventing one. The
     * replay key is the FULL stable source event identity (session +
     * generation + scope): the same command or seq in a different source
     * identity is a different replay fact.
     */
    const turnStartedEvent = (
      state: ThreadState,
      command: CommandProjection,
      recordedAt: string,
    ): ProviderRuntimeTurnStartedEvent => {
      const sourceEvent = scopedEventId(state, `turn-start:${command.commandId}`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "turn.started",
        turnId: turnIdFor(state, command),
        payload: {
          ...(state.model !== undefined ? { model: state.model } : {}),
        },
      };
    };

    const turnCompletedEvent = (
      state: ThreadState,
      command: CommandProjection,
      settledSeq: number | undefined,
      recordedAt: string,
    ): ProviderRuntimeTurnCompletedEvent => {
      const sourceEvent = scopedEventId(
        state,
        `turn-settled:${command.commandId}:${command.outcome ?? "unknown"}${settledSeq !== undefined ? `:${settledSeq}` : ""}`,
      );
      return {
        ...eventBase(state, sourceEvent, {
          at: recordedAt,
          replayKey: sourceEvent,
        }),
        type: "turn.completed",
        turnId: turnIdFor(state, command),
        payload: {
          state: command.outcome === "success" ? "completed" : "failed",
          ...(command.outcome === "failure"
            ? { errorMessage: "The Dokkabi turn failed; see the recorded transcript." }
            : {}),
        },
      };
    };

    const turnAbortedEvent = (
      state: ThreadState,
      command: CommandProjection,
      settledSeq: number | undefined,
      recordedAt: string,
    ): ProviderRuntimeTurnAbortedEvent => ({
      ...eventBase(
        state,
        scopedEventId(
          state,
          `turn-settled:${command.commandId}:operator_abort${settledSeq !== undefined ? `:${settledSeq}` : ""}`,
        ),
        {
          at: recordedAt,
          replayKey: scopedEventId(
            state,
            `turn-settled:${command.commandId}:operator_abort${settledSeq !== undefined ? `:${settledSeq}` : ""}`,
          ),
        },
      ),
      type: "turn.aborted",
      turnId: turnIdFor(state, command),
      payload: { reason: "Operator stopped the Dokkabi turn." },
    });

    /** Recorded cards anchor their ORIGINAL recorded start time (card.ts);
     * a joined completion keeps that anchor — duration is only a measurement.
     * The replay key is the full source event identity: a joined content or
     * attribution change is a new fact on the SAME item id. */
    const toolItemStartedEvent = (
      state: ThreadState,
      cardSeq: number,
      turnId: string | undefined,
      title: string,
      interimDetail: string | undefined,
      contentDigest: string,
      recordedAt: string,
    ): ProviderRuntimeItemStartedEvent => {
      const sourceEvent = scopedEventId(state, `card:${cardSeq}:started:${contentDigest}`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "item.started",
        ...(turnId !== undefined ? { turnId: TurnId.make(turnId) } : {}),
        itemId: RuntimeItemId.make(cardItemId(state, cardSeq)),
        // A recorded tool/result that precedes tool/end is honest interim
        // progress on the still-running item — never completion evidence.
        ...(interimDetail !== undefined
          ? { payload: { itemType: "command_execution" as const, title, detail: interimDetail } }
          : { payload: { itemType: "command_execution" as const, title } }),
      };
    };

    const toolItemCompletedEvent = (
      state: ThreadState,
      cardSeq: number,
      turnId: string | undefined,
      title: string,
      detail: string | undefined,
      error: boolean,
      contentDigest: string,
      recordedAt: string,
    ): ProviderRuntimeItemCompletedEvent => {
      const sourceEvent = scopedEventId(state, `card:${cardSeq}:completed:${contentDigest}`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "item.completed",
        ...(turnId !== undefined ? { turnId: TurnId.make(turnId) } : {}),
        itemId: RuntimeItemId.make(cardItemId(state, cardSeq)),
        payload: {
          itemType: "command_execution",
          status: error ? "failed" : "completed",
          title,
          ...(detail !== undefined ? { detail } : {}),
        },
      };
    };

    const assistantItemCompletedEvent = (
      state: ThreadState,
      cardSeq: number,
      turnId: string | undefined,
      text: string,
      contentDigest: string,
      recordedAt: string,
    ): ProviderRuntimeItemCompletedEvent => {
      const sourceEvent = scopedEventId(state, `card:${cardSeq}:assistant:${contentDigest}`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "item.completed",
        ...(turnId !== undefined ? { turnId: TurnId.make(turnId) } : {}),
        itemId: RuntimeItemId.make(cardItemId(state, cardSeq)),
        payload: { itemType: "assistant_message", status: "completed", detail: text },
      };
    };

    /** System/error records stay visible as transcript items. */
    const systemItemCompletedEvent = (
      state: ThreadState,
      cardSeq: number,
      turnId: string | undefined,
      event: string,
      text: string,
      contentDigest: string,
      recordedAt: string,
    ): ProviderRuntimeItemCompletedEvent => {
      const sourceEvent = scopedEventId(state, `card:${cardSeq}:system:${contentDigest}`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "item.completed",
        ...(turnId !== undefined ? { turnId: TurnId.make(turnId) } : {}),
        itemId: RuntimeItemId.make(cardItemId(state, cardSeq)),
        payload: { itemType: "unknown", status: "completed", title: event, detail: text },
      };
    };

    /** A labelled host work report is the host's MAIN conversation verdict:
     *  a system_message item under the card's own seq/time/attribution and a
     *  replay identity distinct from both assistant text and quiet system
     *  records, so downstream consumers can never mistake it for a reply. */
    const hostSystemMessageCompletedEvent = (
      state: ThreadState,
      cardSeq: number,
      turnId: string | undefined,
      event: string,
      text: string,
      contentDigest: string,
      recordedAt: string,
    ): ProviderRuntimeItemCompletedEvent => {
      const sourceEvent = scopedEventId(state, `card:${cardSeq}:system-message:${contentDigest}`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "item.completed",
        ...(turnId !== undefined ? { turnId: TurnId.make(turnId) } : {}),
        itemId: RuntimeItemId.make(cardItemId(state, cardSeq)),
        payload: { itemType: "system_message", status: "completed", title: event, detail: text },
      };
    };

    /** Unsupported harness approvals stay visible, never silently dropped. */
    const approvalOpenedEvent = (
      state: ThreadState,
      cardSeq: number,
      requestId: string,
      approvalKind: string,
      detail: string | undefined,
      recordedAt: string,
    ): ProviderRuntimeRequestOpenedEvent => {
      const sourceEvent = scopedEventId(state, `card:${cardSeq}:approval-opened`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "request.opened",
        requestId: RuntimeRequestId.make(requestId),
        payload: {
          requestType: approvalRequestType(approvalKind),
          ...(detail !== undefined ? { detail } : {}),
        },
      };
    };

    const approvalResolvedEvent = (
      state: ThreadState,
      cardSeq: number,
      requestId: string,
      approvalKind: string,
      recordedAt: string,
    ): ProviderRuntimeRequestResolvedEvent => {
      const sourceEvent = scopedEventId(state, `card:${cardSeq}:approval-resolved`);
      return {
        ...eventBase(state, sourceEvent, { at: recordedAt, replayKey: sourceEvent }),
        type: "request.resolved",
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: approvalRequestType(approvalKind) },
      };
    };

    const emit = (event: ProviderRuntimeEvent): Effect.Effect<void> => Queue.offer(events, event);

    // --- projection ---

    /**
     * Rebuild command ownership from the RECORDED lifecycle source refs —
     * a card belongs to the command whose turnStart seq precedes it before
     * the next command's turnStart. Sources are retained in every derived
     * state by the gateway contract, so historical attribution survives
     * settlement. Original-id aliases from the previous projection and the
     * resume state are preserved.
     */
    const rebuildCommandRanges = (
      read: ReadResult,
      previous: Map<string, CommandProjection>,
      aliases: Map<string, string>,
    ): Map<string, CommandProjection> => {
      const withStarts = read.commands.flatMap((command) => {
        const start = command.sources?.["turnStart"];
        if (typeof start !== "number") return [];
        return [
          {
            command,
            start,
            startAt: sourceTimeString(command.sources?.["turnStartAt"]),
            settledAt: sourceTimeString(command.sources?.["settlementAt"]),
          },
        ];
      });
      withStarts.sort((left, right) => left.start - right.start);
      const ranges = new Map<string, CommandProjection>();
      const upsert = (
        commandId: string,
        patch: Partial<CommandProjection> & { state: WorkbenchCommandState },
      ) => {
        const existing = ranges.get(commandId);
        const prior = existing ?? previous.get(commandId);
        const originalId = prior?.originalId ?? aliases.get(commandId);
        ranges.set(commandId, {
          commandId,
          originalId,
          startSeq: patch.startSeq ?? prior?.startSeq,
          startAt: patch.startAt ?? prior?.startAt,
          endSeq: patch.endSeq ?? prior?.endSeq,
          settledAt: patch.settledAt ?? prior?.settledAt,
          state: patch.state,
          outcome: patch.outcome ?? prior?.outcome,
        });
      };
      withStarts.forEach((entry, index) => {
        const next = withStarts[index + 1]?.start;
        upsert(entry.command.commandId, {
          startSeq: entry.start,
          startAt: entry.startAt,
          ...(next !== undefined ? { endSeq: next } : {}),
          settledAt: entry.settledAt,
          state: entry.command.state,
          outcome: entry.command.outcome,
        });
      });
      for (const command of read.commands) {
        if (ranges.has(command.commandId)) continue;
        upsert(command.commandId, {
          state: command.state,
          outcome: command.outcome,
          settledAt: sourceTimeString(command.sources?.["settlementAt"]),
        });
      }
      return ranges;
    };

    const commandForSeq = (state: ThreadState, seq: number): CommandProjection | undefined => {
      let owner: CommandProjection | undefined;
      for (const command of state.commands.values()) {
        if (command.startSeq === undefined) continue;
        if (command.startSeq <= seq && (command.endSeq === undefined || seq < command.endSeq)) {
          owner = command;
        }
      }
      return owner;
    };

    const emitCard = (
      state: ThreadState,
      card: ReadResult["cards"][number],
      turn: CommandProjection | undefined,
    ): Effect.Effect<void> => {
      const turnId = turn === undefined ? undefined : (turn.originalId ?? turn.commandId);
      const serialized = JSON.stringify({ card, turnId: turnId ?? null });
      // Same content AND attribution as the last emission: nothing new.
      if (state.cards.get(card.seq) === serialized) return Effect.void;
      state.cards.set(card.seq, serialized);
      const contentDigest = sha256Hex(serialized);
      switch (card.kind) {
        case "assistant":
          // Completed recorded assistant card; no per-token streaming claim.
          return emit(
            assistantItemCompletedEvent(state, card.seq, turnId, card.text, contentDigest, card.ts),
          );
        case "tool": {
          // ONLY the actual correlated tool/end source refs mean settled —
          // durationMs is a measurement that real harness tools legitimately
          // record as "missing" even after completion, and timing availability
          // is never completion evidence.
          const settled = card.completionSeq !== undefined && card.completionHash !== undefined;
          return settled
            ? emit(
                toolItemCompletedEvent(
                  state,
                  card.seq,
                  turnId,
                  card.tool,
                  card.resultText,
                  card.error,
                  contentDigest,
                  card.ts,
                ),
              )
            : emit(
                toolItemStartedEvent(
                  state,
                  card.seq,
                  turnId,
                  card.tool,
                  card.resultText,
                  contentDigest,
                  card.ts,
                ),
              );
        }
        case "system":
          // A labelled host work report is the one system family promoted to
          // a MAIN message: the harness's recorded terminal verdict, emitted
          // as a system_message item under the card's own seq/time/attribution
          // and its own stable source identity. Ordinary system records — and
          // anything the harness did not label — stay quiet system items.
          return isHostWorkReportCard(card)
            ? emit(
                hostSystemMessageCompletedEvent(
                  state,
                  card.seq,
                  turnId,
                  card.event,
                  card.text,
                  contentDigest,
                  card.ts,
                ),
              )
            : emit(
                systemItemCompletedEvent(
                  state,
                  card.seq,
                  turnId,
                  card.event,
                  card.text,
                  contentDigest,
                  card.ts,
                ),
              );
        case "approval": {
          if (card.state === "requested") {
            if (state.approvalsOpened.has(card.seq)) return Effect.void;
            state.approvalsOpened.add(card.seq);
            return emit(
              approvalOpenedEvent(
                state,
                card.seq,
                card.requestId,
                card.approvalKind,
                card.detail,
                card.ts,
              ),
            );
          }
          return emit(
            approvalResolvedEvent(state, card.seq, card.requestId, card.approvalKind, card.ts),
          );
        }
        case "note":
          // The REAL recorded user/message text (possibly inbox-folded —
          // which R2 refuses to inherit). The app already owns the
          // optimistic user row; the recorded text surfaces through
          // readThread snapshots instead of a duplicate runtime item.
          return Effect.void;
      }
    };

    /** Refuse an entire invalid source view before advancing any projection state. */
    const refuseSourceTime = (state: ThreadState, key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        state.sourceTimeRefusedFor.add(key);
        state.status = "error";
        const detail =
          "Recorded history has an invalid or missing source time. Prior history is preserved and sending is disabled until the gateway provides a valid view.";
        state.lastError = detail;
        if (!state.attentionEmitted.has(key)) {
          state.attentionEmitted.add(key);
          yield* emit(sessionStateChanged(state, "error", detail, key));
        }
      });

    /**
     * Project one verified read into runtime events. MUST run under `gate`.
     * `hadPriorView` distinguishes a first adoption from a cursor
     * replacement: adoption rebuilds silently; a replacement is a VISIBLE
     * freeze-and-rebuild and never a silent splice.
     */
    const projectRead = (
      state: ThreadState,
      read: ReadResult,
      hadPriorView: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // The latch stops ALL later projection — even if the source is later
        // restored and a read reports resnapshot:false again, nothing from
        // the suspect source is projected until explicit reconciliation.
        if (state.quarantined !== undefined) {
          return;
        }
        if (read.resnapshot && hadPriorView) {
          // A replaced/truncated source log cannot be spliced onto the prior
          // conversation: ProviderRuntimeIngestion retains old rows and new
          // source ids would add rows alongside them. R2 has no safe
          // full-projection replace protocol, so the mismatch is QUARANTINED:
          // prior cards/cursors/command mapping are preserved untouched,
          // nothing is projected from the replaced source, and Sends are
          // refused until the operator detaches and starts a fresh
          // conversation. The latch persists in resumeCursor — a later poll
          // that happens to validate must NOT silently clear it.
          if (state.quarantined === undefined) {
            state.quarantined =
              "Gateway source mismatch: the recorded log was replaced or truncated after this conversation had a validated view.";
            state.status = "error";
            state.lastError = state.quarantined;
            yield* emit(
              sessionStateChanged(
                state,
                "error",
                `${state.quarantined} Prior conversation and cursors are preserved; sending is disabled until you stop this session and start a fresh conversation.`,
                `source-mismatch:${state.generation}:${read.sessionCursor.generation}`,
              ),
            );
          }
          return;
        }
        // Validate the complete candidate before publishing source facts or
        // changing cursors, command attribution, or emission signatures.
        const candidateCommands = rebuildCommandRanges(read, state.commands, state.aliases);
        const badCard = read.cards.find((card) => !isValidRecordedTime(card.ts));
        const badCommand = read.commands.find(
          (command) =>
            (command.sources?.["turnStart"] !== undefined &&
              !isValidRecordedTime(sourceTimeString(command.sources?.["turnStartAt"]))) ||
            (["handed_off", "accepted", "settled"].includes(command.state) &&
              (typeof command.sources?.["turnStart"] !== "number" ||
                !isValidRecordedTime(sourceTimeString(command.sources?.["turnStartAt"])))) ||
            (command.state === "settled" &&
              !isValidRecordedTime(sourceTimeString(command.sources?.["settlementAt"]))),
        );
        if (badCard !== undefined || badCommand !== undefined) {
          yield* refuseSourceTime(
            state,
            `source-time:${badCard !== undefined ? `card:${badCard.seq}` : `command:${badCommand!.commandId}`}`,
          );
          return;
        }
        state.generation = read.sessionCursor.generation;
        state.sessionCursor = read.sessionCursor;
        state.gatewayCursor = read.gatewayCursor;
        state.commands = candidateCommands;
        state.activeCommandId = read.state.activeCommandId ?? undefined;
        // Refusals are recomputed from THIS read: commands whose lifecycle
        // now carries valid recorded times recover on their next loop pass.
        state.sourceTimeRefusedFor.clear();

        const orderedCards = [...read.cards].sort((left, right) => left.seq - right.seq);
        const firstStart = read.commands.reduce<number | undefined>((min, command) => {
          const start = command.sources?.["turnStart"];
          if (typeof start !== "number") return min;
          return min === undefined ? start : Math.min(min, start);
        }, undefined);
        const orderedCommands = [...state.commands.values()].sort((left, right) => {
          const leftStart = left.startSeq ?? Number.MAX_SAFE_INTEGER;
          const rightStart = right.startSeq ?? Number.MAX_SAFE_INTEGER;
          return leftStart - rightStart;
        });

        // Cards recorded before any tracked turn start: unattributed history.
        for (const card of orderedCards) {
          if (firstStart !== undefined && card.seq >= firstStart) break;
          yield* emitCard(state, card, undefined);
        }
        for (const command of orderedCommands) {
          // turn.started is ALWAYS emitted before this command's items and
          // settlement — a completion-before-start race cannot exist — and
          // ONLY from a valid recorded source time. A missing/invalid
          // turnStartAt refuses the lifecycle projection; the recorded cards
          // still project honestly under their own times.
          if (command.startSeq !== undefined && !state.turnStartsEmitted.has(command.commandId)) {
            state.turnStartsEmitted.add(command.commandId);
            yield* emit(turnStartedEvent(state, command, command.startAt!));
          }
          if (command.startSeq !== undefined) {
            for (const card of orderedCards) {
              if (card.seq < command.startSeq) continue;
              if (command.endSeq !== undefined && card.seq >= command.endSeq) continue;
              yield* emitCard(state, card, command);
            }
          }
          if (
            command.state === "unknown" ||
            command.state === "staged" ||
            command.state === "rejected"
          ) {
            const detail =
              command.state === "unknown"
                ? "recorded intent without a provable handoff — reconcile before any retry"
                : command.state === "staged"
                  ? "note staged in the harness operator inbox"
                  : "the gateway refused the submit";
            if (!state.attentionEmitted.has(`attention:${command.commandId}`)) {
              state.attentionEmitted.add(`attention:${command.commandId}`);
              yield* emit(
                sessionStateChanged(
                  state,
                  "error",
                  `Dokkabi command ${command.originalId ?? command.commandId} is ${command.state}: ${detail}`,
                  `attention:${command.commandId}:${command.state}`,
                ),
              );
            }
          }
          if (command.state === "settled" && !state.settledEmitted.has(command.commandId)) {
            state.settledEmitted.add(command.commandId);
            const settledSeq = read.commands.find((entry) => entry.commandId === command.commandId)
              ?.sources?.["settlement"];
            const seq = typeof settledSeq === "number" ? settledSeq : undefined;
            if (command.outcome === "operator_abort") {
              yield* emit(turnAbortedEvent(state, command, seq, command.settledAt!));
            } else if (command.outcome === "success" || command.outcome === "failure") {
              yield* emit(turnCompletedEvent(state, command, seq, command.settledAt!));
            }
          }
        }

        // busy:false is NEVER ready while one of our commands is unresolved
        // or a lifecycle projection is refused for a missing source time.
        const hasUnknown = read.commands.some((command) => command.state === "unknown");
        const hasUnresolved = read.commands.some(
          (command) => command.state !== "settled" && command.state !== "rejected",
        );
        state.status =
          hasUnknown || state.sourceTimeRefusedFor.size > 0
            ? "error"
            : hasUnresolved || read.state.busy
              ? "running"
              : "ready";
        if (state.status === "ready") {
          state.lastError = undefined;
        }
        state.consecutiveReadFailures = 0;
        state.updatedAt = nowIso();
      });

    /**
     * One poll: the read AND its projection run as a single gate-held
     * operation. A read fetched outside the gate could be applied after a
     * newer Send's projection and roll cards/cursors/active attribution
     * backward; serialization makes every projection land in fetch order.
     * The gate is released on interruption, so a poller interrupted while a
     * read is in flight can never deadlock stopPoller or the finalizer.
     */
    const pollThread = (state: ThreadState): Effect.Effect<void> =>
      gate
        .withPermits(1)(
          Effect.gen(function* () {
            const read = yield* readOnce(state, true);
            yield* projectRead(
              state,
              read,
              state.cards.size > 0 || state.turnStartsEmitted.size > 0,
            );
          }),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              state.consecutiveReadFailures += 1;
              state.status = "error";
              state.lastError = describe(error);
              if (state.consecutiveReadFailures === 1) {
                yield* emit(
                  sessionStateChanged(
                    state,
                    "error",
                    `Workbench read failed: ${state.lastError}`,
                    `read-failure:${digestOf(state.lastError)}`,
                  ),
                );
              }
            }),
          ),
          Effect.andThen(Effect.sleep(pollIntervalMs)),
          Effect.forever,
        );

    /** Exactly one poller fiber per bound thread (daemon, tracked, fenced). */
    const startPoller = (state: ThreadState): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* stopPoller(state);
        if (foregroundOperations > 0 || closing || threads.get(state.threadId) !== state) return;
        state.pollFiber = yield* Effect.forkDetach(Effect.interruptible(pollThread(state)));
      });

    const stopPoller = (state: ThreadState): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = state.pollFiber;
        state.pollFiber = undefined;
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber);
        }
      });

    /** Foreground work retains the global gate; only background waits yield. */
    const withForeground = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          foregroundOperations += 1;
          if (foregroundOperations === 1) {
            for (const state of threads.values()) yield* stopPoller(state);
          }
        }),
        () => effect,
        () =>
          Effect.gen(function* () {
            foregroundOperations -= 1;
            if (foregroundOperations === 0 && !closing) {
              for (const state of threads.values()) yield* startPoller(state);
            }
          }),
      );

    const withForegroundGate = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      withForeground(gate.withPermits(1)(effect));

    const resumeCursorOf = (state: ThreadState) => ({
      binding: { clientId: state.clientId, threadId: state.threadId },
      sessionId: state.sessionId,
      ...(state.sessionCursor !== undefined ? { sessionCursor: state.sessionCursor } : {}),
      ...(state.gatewayCursor !== undefined ? { gatewayCursor: state.gatewayCursor } : {}),
      ...(state.activeCommandId !== undefined ? { activeCommandId: state.activeCommandId } : {}),
      ...(state.aliases.size > 0
        ? { commandAliases: Object.fromEntries(state.aliases.entries()) }
        : {}),
      ...(state.quarantined !== undefined ? { sourceMismatch: true } : {}),
      ...(state.childOf !== undefined
        ? {
            child: {
              id: state.childOf.childId,
              sessionId: state.sessionId,
              workspacePath: state.childOf.workspacePath,
              parent: state.childOf.parentBinding,
              binding: { clientId: state.clientId, threadId: state.threadId },
            },
            ...(state.childOf.parentModel !== undefined
              ? { parentModel: state.childOf.parentModel }
              : {}),
          }
        : {}),
    });

    const sessionSnapshot = (state: ThreadState): ProviderSession => ({
      provider: PROVIDER_KIND,
      providerInstanceId: config.instanceId,
      // Actual running/error/recovery state, never a static label.
      status: state.status,
      // The mode validated at bind — full-access against the gateway's
      // bypass policy; never a hardcoded claim.
      runtimeMode: state.runtimeMode ?? REQUIRED_RUNTIME_MODE,
      cwd: state.childOf?.workspacePath ?? config.workspacePath,
      ...(state.model !== undefined
        ? {
            model:
              state.modelChangeCapability && state.route
                ? `${state.route}/${state.model}`
                : state.model,
          }
        : {}),
      threadId: state.threadId,
      resumeCursor: resumeCursorOf(state),
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      ...(state.status === "error" && state.lastError !== undefined
        ? { lastError: state.lastError }
        : {}),
    });

    /** Select once through the bound host, then verify its actual identity.
     * Transport loss is propagated; never retry or submit on an assumed model. */
    const selectRequestedModel = (
      state: ThreadState,
      request: string | undefined,
      method: string,
    ) =>
      Effect.gen(function* () {
        if (request === undefined) return;
        const identity = yield* handshake(state.childOf);
        if (identity.sessionId !== state.sessionId)
          return yield* failRequest(method, "Model discovery belongs to another session.");
        const target = requestedDokkabiModel(request, identity);
        if (target === undefined)
          return yield* failRequest(
            method,
            "The selected model is not in the authenticated Dokkabi catalog. Refresh the provider models.",
          );
        if (target.route !== identity.route || target.model !== identity.model) {
          if (
            !identity.capabilities.modelChange ||
            state.childOf !== undefined ||
            identity.model === undefined
          ) {
            return yield* failRequest(
              method,
              `The Dokkabi gateway is configured with model '${identity.model}' (route '${identity.route}'); this gateway cannot change models.`,
            );
          }
          const result = yield* callRouted(
            state.childOf,
            "workbench.model",
            {
              version: 1,
              binding: { clientId: state.clientId, threadId: state.threadId },
              route: target.route,
              model: target.model,
              expectedRoute: identity.route,
              expectedModel: identity.model,
            },
            ModelSelectionSchema,
          );
          if (result.state !== "applied") return yield* failRequest(method, result.reason);
          if (result.route !== target.route || result.model !== target.model) {
            return yield* failRequest(
              method,
              "The model selection receipt names another model; no turn was submitted.",
            );
          }
          const actual = yield* handshake(state.childOf);
          if (
            actual.sessionId !== state.sessionId ||
            actual.route !== target.route ||
            actual.model !== target.model
          ) {
            return yield* failRequest(
              method,
              "The model change could not be verified; refresh before sending. No turn was submitted.",
            );
          }
        }
        state.route = target.route;
        state.model = target.model;
        state.modelChangeCapability = identity.capabilities.modelChange;
        state.updatedAt = nowIso();
      });

    /**
     * The NORMAL trusted, validated startup body. It does not take `gate`:
     * the public `startSession` wraps it in the single permit, and an
     * operation that already HOLDS the permit (explicit prepared-branch
     * reconcile after a genuine detach) reuses it directly instead of
     * re-entering the gate (which would deadlock) or running a second,
     * weaker boot path. MUST run under `gate`.
     */
    const startSessionLocked = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, DokkabiAdapterError | WorkbenchTransportLost> =>
      Effect.gen(function* () {
        if (!config.enabled) {
          return yield* failRequest(
            "thread.session.start",
            "The Dokkabi provider is disabled. Configure and enable it in Settings first.",
          );
        }
        if (configFailure !== undefined) {
          return yield* failRequest("thread.session.start", configFailure);
        }
        // The app's permission policy must be the explicit full-access
        // mode; the harness cannot honor a narrower app-side policy.
        if (input.runtimeMode !== REQUIRED_RUNTIME_MODE) {
          return yield* failRequest(
            "thread.session.start",
            `The Dokkabi harness owns this workspace's policy; this app supports only the '${REQUIRED_RUNTIME_MODE}' runtime mode against it (requested '${input.runtimeMode}'). Interactive approval modes arrive with a later protocol version.`,
          );
        }
        // Resume state is parsed and ownership-checked BEFORE any wire
        // effect, so a recorded prepared child routes its own handshake
        // through its branch envelope from the very first call.
        let resume: DokkabiResumeState | undefined;
        if (input.resumeCursor !== undefined) {
          const parsed = parseResumeState(input.resumeCursor);
          if (!parsed.ok) {
            return yield* failRequest(
              "thread.session.start",
              `Refusing resume state: ${parsed.reason}.`,
            );
          }
          if (parsed.value.binding.clientId !== clientId) {
            return yield* failRequest(
              "thread.session.start",
              `Resume state belongs to workbench client '${parsed.value.binding.clientId}'; this instance is '${clientId}'.`,
            );
          }
          if (parsed.value.binding.threadId !== input.threadId) {
            return yield* failRequest(
              "thread.session.start",
              `Resume state belongs to workbench thread '${parsed.value.binding.threadId}'; this thread is '${input.threadId}'.`,
            );
          }
          resume = parsed.value;
        }
        const childRoute = resume !== undefined ? childRouteFromResume(resume) : undefined;
        const expectedWorkspace = childRoute?.workspacePath ?? config.workspacePath;
        // A session cannot silently redirect the harness's workspace; a
        // recorded prepared child names its own harness-owned workspace.
        if (input.cwd !== undefined && input.cwd !== expectedWorkspace) {
          return yield* failRequest(
            "thread.session.start",
            `The Dokkabi gateway owns workspace '${expectedWorkspace}'; a session cannot run in '${input.cwd}'.`,
          );
        }
        const identity: HandshakeResult = yield* handshake(childRoute);
        // A child startup validates its EXACT returned source — never the
        // parent handshake, never the configured parent workspace.
        if (childRoute !== undefined && identity.sessionId !== resume?.child?.sessionId) {
          return yield* failRequest(
            "thread.session.start",
            `The child gateway returned session '${identity.sessionId}' but this conversation is recorded against child session '${resume?.child?.sessionId}'; a child never falls back to another session.`,
          );
        }
        // The recorded model policy was fixed at preparation from the
        // actual parent selection; a current boot mismatch refuses.
        if (
          childRoute?.parentModel !== undefined &&
          identity.model !== undefined &&
          identity.model !== childRoute.parentModel
        ) {
          return yield* failRequest(
            "thread.session.start",
            `The child gateway boots model '${identity.model}' but this branch was prepared for model '${childRoute.parentModel}'; the prepared child cannot silently switch models.`,
          );
        }
        if (identity.permissionMode !== SUPPORTED_PERMISSION_MODE) {
          return yield* failRequest(
            "thread.session.start",
            `The gateway workspace runs permission mode '${identity.permissionMode}'. This app supports explicit full-access (bypass) harness workspaces only; switch the harness's default permission mode first.`,
          );
        }
        // Legacy peers cannot change models. Modern peers select through
        // the bound host after ownership validation.
        const requestedModel = input.modelSelection?.model;
        if (
          requestedModel !== undefined &&
          identity.model !== undefined &&
          requestedModel !== identity.model &&
          requestedModel !== `${identity.route}/${identity.model}` &&
          !identity.capabilities.modelChange
        ) {
          return yield* failRequest(
            "thread.session.start",
            `The Dokkabi gateway is configured with model '${identity.model}' (route '${identity.route}'); '${requestedModel}' was requested. Start the thread on the configured model.`,
          );
        }
        // Resume session identity and the quarantine latch complete the
        // validation begun before the handshake.
        if (resume !== undefined && resume.sessionId !== identity.sessionId) {
          return yield* failRequest(
            "thread.session.start",
            `Resume state names session '${resume.sessionId}' but the gateway owns '${identity.sessionId}'.`,
          );
        }
        if (resume?.sourceMismatch) {
          return yield* failRequest(
            "thread.session.start",
            "This conversation's recorded source log was previously replaced or truncated. It is preserved read-only; stop the session and start a fresh conversation to continue.",
          );
        }
        const existing = threads.get(input.threadId);
        const fresh = (): ThreadState => ({
          threadId: input.threadId,
          clientId,
          sessionId: identity.sessionId,
          generation: "genesis",
          sessionCursor: resume?.sessionCursor,
          gatewayCursor: resume?.gatewayCursor,
          activeCommandId: resume?.activeCommandId,
          status: "ready",
          lastError: undefined,
          quarantined: undefined,
          sourceTimeRefusedFor: new Set(),
          runtimeMode: input.runtimeMode,
          model: identity.model,
          route: identity.route,
          modelChangeCapability: identity.capabilities.modelChange,
          workModeCapability: identity.capabilities.workMode ?? false,
          childOf: childRoute,
          cards: new Map(),
          commands: new Map(),
          aliases: new Map(resume?.commandAliases ?? []),
          turnStartsEmitted: new Set(),
          settledEmitted: new Set(),
          attentionEmitted: new Set(),
          approvalsOpened: new Set(),
          pollFiber: undefined,
          consecutiveReadFailures: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        // An idempotent rebind (identical cursors) keeps the projection;
        // anything else starts from the validated snapshot.
        if (existing?.quarantined !== undefined) {
          return yield* failRequest(
            "thread.session.start",
            `${existing.quarantined} Stop this session and start a fresh conversation to continue.`,
          );
        }
        const sameView =
          existing !== undefined &&
          resume !== undefined &&
          resume.sessionId === existing.sessionId &&
          JSON.stringify(resume.sessionCursor) === JSON.stringify(existing.sessionCursor) &&
          JSON.stringify(resume.gatewayCursor) === JSON.stringify(existing.gatewayCursor);
        const state = sameView ? existing : fresh();
        if (existing !== undefined && !sameView) {
          yield* stopPoller(existing);
          threads.delete(input.threadId);
        }
        state.sessionId = identity.sessionId;
        state.model = identity.model;
        state.route = identity.route;
        state.workModeCapability = identity.capabilities.workMode ?? false;
        state.modelChangeCapability = identity.capabilities.modelChange;
        state.runtimeMode = input.runtimeMode;
        state.updatedAt = nowIso();
        const bound = yield* bindThread(state);
        state.sessionId = bound.sessionId;
        if (childRoute !== undefined && bound.sessionId !== resume?.child?.sessionId) {
          return yield* failRequest(
            "thread.session.start",
            `The child gateway bound session '${bound.sessionId}' but this conversation is recorded against child session '${resume?.child?.sessionId}'; the recorded child is never swapped for another session.`,
          );
        }
        yield* selectRequestedModel(state, requestedModel, "thread.session.start");
        const hadPriorView =
          resume?.sessionCursor !== undefined || (sameView && state.cards.size > 0);
        const firstRead = yield* readOnce(state);
        state.generation = firstRead.sessionCursor.generation;
        threads.set(input.threadId, state);
        if (state.childOf !== undefined) {
          childWorkspaceRoots.set(input.threadId, state.childOf.workspacePath);
        }
        // session.started is published BEFORE any historical item or
        // settlement so adoption replays into a live session view.
        yield* emit(sessionStarted(state, input.resumeCursor));
        yield* projectRead(state, firstRead, hadPriorView);
        yield* startPoller(state);
        return sessionSnapshot(state);
      });

    const startSession = (input: ProviderSessionStartInput) =>
      withForegroundGate(startSessionLocked(input)).pipe(
        Effect.mapError(collapseLost("thread.session.start", input.threadId)),
      );

    /**
     * Submit once. A transport loss leaves the outcome uncertain: reconcile
     * through commandStatus and NEVER blind-retry the submit.
     */
    const submitOnce = (state: ThreadState, wireCommandId: string, text: string) =>
      callRouted(
        state.childOf,
        "workbench.submit",
        {
          version: 1,
          binding: { clientId: state.clientId, threadId: state.threadId },
          commandId: wireCommandId,
          text,
        },
        SubmitSchema,
      ).pipe(
        Effect.catchIf(isTransportLost, (transportError: WorkbenchTransportLost) =>
          commandStatus(state, wireCommandId).pipe(
            Effect.option,
            Effect.flatMap((option) => {
              if (Option.isNone(option)) {
                return failProcess(
                  "thread.turn.start",
                  state.threadId,
                  `${transportError.message} The command's state could not be reconciled; it was NOT retried. Check the gateway before sending again.`,
                );
              }
              const status = option.value;
              if (status.state === "unknown") {
                return failProcess(
                  "thread.turn.start",
                  state.threadId,
                  `${transportError.message} The gateway reports the command as unknown (no provable handoff); it was NOT retried.`,
                );
              }
              return Effect.succeed({
                commandId: wireCommandId,
                state: status.state,
                duplicate: true,
                ...(status.outcome !== undefined ? { outcome: status.outcome } : {}),
                ...(status.detail !== undefined ? { detail: status.detail } : {}),
              } satisfies SubmitResult);
            }),
          ),
        ),
      );

    /** Every submit state handled truthfully. MUST run under `gate`. */
    const handleSubmitResult = (
      state: ThreadState,
      command: CommandProjection,
      submit: SubmitResult,
    ): Effect.Effect<ProviderTurnStartResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        if (submit.state === "rejected" || submit.state === "staged") {
          return yield* failRequest(
            "thread.turn.start",
            submit.detail ??
              (submit.state === "staged"
                ? "The gateway staged the note in its operator inbox; it was not turned into model input."
                : "The gateway refused the submit."),
          );
        }
        if (submit.state === "unknown") {
          return yield* failProcess(
            "thread.turn.start",
            state.threadId,
            "The gateway could not prove handoff for this command (state unknown); it was NOT retried.",
          );
        }
        if (submit.state === "handed_off" || submit.state === "accepted") {
          // Transport handoff is not a recorded lifecycle observation.
          // The verified read emits start before settlement with source times.
          state.activeCommandId = command.commandId;
          state.status = "running";
          state.updatedAt = nowIso();
          const read = yield* Effect.option(readOnce(state));
          if (Option.isSome(read)) {
            yield* projectRead(state, read.value, true);
          }
          return {
            threadId: state.threadId,
            turnId: turnIdFor(state, command),
            resumeCursor: resumeCursorOf(state),
          } satisfies ProviderTurnStartResult;
        }
        // settled (duplicate or immediate): reconcile through the recorded
        // projection — turn.started then settlement, each exactly once; a
        // settled command is NEVER reopened as a fresh active turn.
        const read = yield* Effect.option(readOnce(state));
        if (Option.isSome(read)) {
          yield* projectRead(state, read.value, true);
        }
        return {
          threadId: state.threadId,
          turnId: turnIdFor(state, command),
          resumeCursor: resumeCursorOf(state),
        } satisfies ProviderTurnStartResult;
      });

    const sendTurn = (input: ProviderSendTurnInput) =>
      withForegroundGate(
        Effect.gen(function* () {
          const state = threads.get(input.threadId);
          if (state === undefined) {
            return yield* failRequest(
              "thread.turn.start",
              `No Dokkabi workbench session is bound to thread ${input.threadId}.`,
            );
          }
          if (state.quarantined !== undefined) {
            return yield* failRequest(
              "thread.turn.start",
              `${state.quarantined} Stop this session and start a fresh conversation to continue; a replaced source log is never spliced or retried silently.`,
            );
          }
          if (state.sourceTimeRefusedFor.size > 0) {
            return yield* failRequest(
              "thread.turn.start",
              state.lastError ?? "Recorded source time is unavailable; sending is disabled.",
            );
          }
          if (input.attachments !== undefined && input.attachments.length > 0) {
            return yield* failRequest(
              "thread.turn.start",
              "Attachments are not supported by the Dokkabi workbench protocol yet.",
            );
          }
          if (input.continuation === true) {
            return yield* failRequest(
              "thread.turn.start",
              "Promptless continuation is not supported by the Dokkabi workbench protocol.",
            );
          }
          // The harness has no plan-mode capability: treating a plan request
          // as ordinary execution would silently change semantics, so it is
          // refused before the wire.
          if (input.interactionMode === "plan") {
            return yield* failRequest(
              "thread.turn.start",
              "The Dokkabi harness has no plan-mode capability; plan-mode turns cannot be sent through this gateway. Send the turn in default mode.",
            );
          }
          const requestedModel = input.modelSelection?.model;
          if (input.input === undefined || input.input.trim().length === 0) {
            return yield* failRequest(
              "thread.turn.start",
              "The Dokkabi workbench protocol requires non-empty turn text.",
            );
          }
          // The orchestration command id IS the stable turn id; when absent
          // (non-orchestrated callers) a unique id is minted once. Ids the
          // gateway's vocabulary cannot carry get a deterministic wire alias.
          const minted =
            input.commandId !== undefined
              ? undefined
              : yield* crypto.randomUUIDv4.pipe(
                  Effect.mapError(
                    (error) =>
                      new ProviderAdapterProcessError({
                        provider: PROVIDER_KIND,
                        threadId: input.threadId,
                        detail: `cannot mint a command id: ${describe(error)}`,
                      }),
                  ),
                );
          const originalId = input.commandId !== undefined ? input.commandId : `app-${minted}`;
          const wireCommandId = toWireCommandId(originalId);
          if (wireCommandId !== originalId) {
            state.aliases.set(wireCommandId, originalId);
          }
          const existing = state.commands.get(wireCommandId);
          const command: CommandProjection = {
            commandId: wireCommandId,
            originalId: wireCommandId === originalId ? undefined : originalId,
            state: existing?.state ?? "unknown",
            outcome: existing?.outcome,
            startSeq: existing?.startSeq,
            startAt: existing?.startAt,
            endSeq: existing?.endSeq,
            settledAt: existing?.settledAt,
          };
          // One active command at a time — except a deduplicating replay of
          // THAT command, which must reach the gateway to fetch its receipt.
          if (state.activeCommandId !== undefined && state.activeCommandId !== wireCommandId) {
            return yield* failRequest(
              "thread.turn.start",
              `Dokkabi command ${state.commands.get(state.activeCommandId)?.originalId ?? state.activeCommandId} is still active on this thread; wait for its settlement or stop it.`,
            );
          }
          yield* selectRequestedModel(state, requestedModel, "thread.turn.start");
          const submit = yield* submitOnce(state, wireCommandId, input.input);
          command.state = submit.state;
          command.outcome = submit.outcome;
          state.commands.set(wireCommandId, command);
          return yield* handleSubmitResult(state, command, submit);
        }),
      ).pipe(Effect.mapError(collapseLost("thread.turn.start", input.threadId)));

    /**
     * Wait briefly for the RECORDED settlement after a cancel; the active
     * command is cleared only when the record establishes termination,
     * never because a cancellation was merely requested.
     */
    const awaitSettlement = (state: ThreadState, wireCommandId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = startedAt + cancelSettlementWaitMs;
        while ((yield* Clock.currentTimeMillis) < deadline) {
          const status = yield* Effect.option(commandStatus(state, wireCommandId));
          if (Option.isSome(status) && status.value.state === "settled") {
            return true;
          }
          yield* Effect.sleep(CANCEL_SETTLEMENT_POLL_MS);
        }
        return false;
      });

    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const state = threads.get(threadId);
        if (state === undefined) {
          return yield* failRequest(
            "thread.turn.interrupt",
            `No Dokkabi workbench session is bound to thread ${threadId}.`,
          );
        }
        // The app speaks orchestration turn ids; map onto the wire id.
        const targetWire = turnId !== undefined ? toWireCommandId(turnId) : state.activeCommandId;
        if (targetWire === undefined) {
          return yield* failRequest(
            "thread.turn.interrupt",
            `No active Dokkabi command to stop for thread ${threadId}.`,
          );
        }
        if (
          turnId !== undefined &&
          state.activeCommandId !== targetWire &&
          !state.commands.has(targetWire)
        ) {
          return yield* failRequest(
            "thread.turn.interrupt",
            `No Dokkabi command ${turnId} is known to thread ${threadId}.`,
          );
        }
        const target = state.commands.get(targetWire);
        // Stable cancellation id within the gateway's id vocabulary: retries
        // of the same stop deduplicate at the durable cancellation ledger,
        // whatever the source command id's length or characters.
        const cancelCommandId = `stop-${sha256Hex(targetWire).slice(0, 32)}`;
        const cancel = yield* callRouted(
          state.childOf,
          "workbench.cancel",
          {
            version: 1,
            binding: { clientId: state.clientId, threadId: state.threadId },
            commandId: cancelCommandId,
            targetCommandId: targetWire,
          },
          CancelSchema,
        );
        if (cancel.state === "unknown") {
          return yield* failProcess(
            "thread.turn.interrupt",
            threadId,
            "The stop request's outcome is uncertain at the gateway (a cancellation intent is recorded without a provable effect). " +
              "The turn was not assumed stopped; the recorded settlement will say.",
          );
        }
        // requested (or already requested): wait for the RECORDED settlement
        // before clearing active tracking.
        const settled = yield* awaitSettlement(state, targetWire);
        yield* gate.withPermits(1)(
          Effect.gen(function* () {
            // Detach or rebind may have replaced this owner during the
            // ungated cancellation wait. Only its current owner may project.
            if (threads.get(threadId) !== state) return;
            if (settled) {
              const read = yield* readOnce(state);
              yield* projectRead(
                state,
                read,
                state.cards.size > 0 || state.turnStartsEmitted.size > 0,
              );
            } else if (!state.attentionEmitted.has(`stop-pending:${targetWire}`)) {
              state.attentionEmitted.add(`stop-pending:${targetWire}`);
              yield* emit(
                sessionStateChanged(
                  state,
                  "running",
                  `Stop requested for command ${target?.originalId ?? targetWire}; the turn stays active until its recorded settlement.`,
                  `stop-pending:${targetWire}`,
                ),
              );
            }
            state.updatedAt = nowIso();
          }),
        );
      }).pipe(withForeground, Effect.mapError(collapseLost("thread.turn.interrupt", threadId)));

    const callDetach = (state: ThreadState) =>
      callRouted(
        state.childOf,
        "workbench.detach",
        {
          version: 1,
          binding: { clientId: state.clientId, threadId: state.threadId },
        },
        DetachSchema,
      );

    /**
     * R8 scoped usage report validation — the closed arithmetic a genuine
     * `workbench.usage` (v1) projection always satisfies. Pure: given the
     * decoded report, the owning session id and the response's own session
     * head, return the first refusal reason or null. Main-scope refs and
     * child PROVENANCE refs are parent-log rows bounded by the main head; a
     * child's pinnedHead/head/metrics are that child's OWN log rows (bounded
     * by the child's pinned prefix, never the parent's); and the aggregate must be
     * exactly the sum of the counted scopes — no main-seq pretending, no
     * double-counted child, no invented totals.
     */
    const scopedUsageRefusal = (input: {
      readonly report: UsageResult["usage"];
      readonly sessionId: string;
      readonly sessionHead: { readonly seq: number; readonly hash: string };
    }): string | null => {
      const { report, sessionId, sessionHead } = input;
      const metricFields = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;
      const metricRefusal = (
        name: string,
        records: number,
        metric: UsageResult["usage"]["main"]["usage"]["input"],
      ): string | null => {
        if (metric.missing > records) {
          return `Usage field '${name}' counts more missing records than exist.`;
        }
        const measured = records - metric.missing;
        if (measured === 0 && (metric.total !== null || metric.latestSource !== null)) {
          return `Usage field '${name}' claims a measured total or source with no measured record behind it.`;
        }
        if (measured > 0 && (metric.total === null || metric.latestSource === null)) {
          return `Usage field '${name}' is missing its total or latest source despite measured records.`;
        }
        return null;
      };
      const refWithinHead = (
        ref: { readonly seq: number; readonly hash: string },
        head: { readonly seq: number; readonly hash: string },
      ): boolean => ref.seq <= head.seq && (ref.seq !== head.seq || ref.hash === head.hash);

      if (report.main.sessionId !== sessionId) {
        return `The scoped usage report names main session '${report.main.sessionId}' but this thread is bound to '${sessionId}'.`;
      }
      if (report.main.head.seq !== sessionHead.seq || report.main.head.hash !== sessionHead.hash) {
        return "The scoped usage report's main head must equal the returned session head.";
      }
      if (report.main.counts.completedUsage !== report.main.usage.records) {
        return "The main completed usage count must equal its usage records.";
      }
      if (
        (report.state === "invalid") !== report.errors.length > 0 ||
        (report.state === "complete" &&
          (report.details.length > 0 ||
            !report.main.settled ||
            report.main.counts.requests !== report.main.counts.completedUsage ||
            report.scopes.some(
              (scope) =>
                scope.state !== "verified" ||
                scope.head?.seq !== scope.pinnedHead?.seq ||
                scope.counts?.requests !== scope.counts?.completedUsage,
            ))) ||
        (report.state === "partial" && report.details.length === 0)
      ) {
        return "The scoped usage state does not agree with its recorded coverage.";
      }
      for (const field of metricFields) {
        const metric = report.main.usage[field];
        const refusal = metricRefusal(field, report.main.usage.records, metric);
        if (refusal !== null) return refusal;
        if (metric.latestSource !== null && !refWithinHead(metric.latestSource, sessionHead)) {
          return "The scoped usage report cites a main usage source outside the returned session head.";
        }
      }

      const seen = new Set<string>();
      const counted: Array<Pick<UsageResult["usage"]["main"], "counts" | "usage">> = [report.main];
      for (const scope of report.scopes) {
        if (seen.has(scope.id)) {
          return `The scoped usage report counts child session '${scope.id}' twice.`;
        }
        seen.add(scope.id);
        for (const entry of scope.provenance) {
          if (!refWithinHead(entry.ref, sessionHead)) {
            return "The scoped usage report cites child provenance outside the returned session head.";
          }
        }
        if (scope.state === "verified") {
          // A counted child must be a safe EXACT owned acceptance descendant
          // of this session — the guarded host opener guarantees it, so a
          // foreign or traversal id here is a forged report.
          if (
            !isWorkbenchId(scope.id) ||
            scope.id === sessionId ||
            !scope.id.startsWith(`${sessionId}-accept-`)
          ) {
            return `The report counts child session '${scope.id.slice(0, 80)}' as verified, but it is not a safe owned acceptance descendant of this session.`;
          }
          const { head, pinnedHead, counts, usage } = scope;
          if (
            head === null ||
            pinnedHead === null ||
            counts === null ||
            usage === null ||
            scope.detail !== null
          ) {
            return `The verified child scope '${scope.id}' must carry its pinned prefix, head, counts and usage.`;
          }
          if (!refWithinHead(pinnedHead, head)) {
            return `Child session '${scope.id}' reports a pinned prefix outside its own verified head.`;
          }
          if (
            scope.provenance.length === 0 ||
            !scope.provenance.some((entry) => entry.pinnedHash === pinnedHead.hash)
          ) {
            return `Child session '${scope.id}' has no parent provenance for its counted pinned prefix.`;
          }
          if (counts.completedUsage !== usage.records) {
            return `Child session '${scope.id}' completed usage count must equal its usage records.`;
          }
          for (const field of metricFields) {
            const metric = usage[field];
            const refusal = metricRefusal(`child ${scope.id} ${field}`, usage.records, metric);
            if (refusal !== null) return refusal;
            if (metric.latestSource !== null && !refWithinHead(metric.latestSource, pinnedHead)) {
              return `Child session '${scope.id}' cites a usage source outside its parent-pinned prefix.`;
            }
          }
          counted.push({ counts, usage });
        } else {
          if (scope.pinnedHead !== null || scope.counts !== null || scope.usage !== null) {
            return `Child session '${scope.id}' is not verified and must not carry counted usage.`;
          }
          if (scope.state === "missing" && scope.head !== null) {
            return `The missing child scope '${scope.id}' must not carry a head.`;
          }
        }
      }

      if (report.aggregate.scopesCounted !== counted.length) {
        return `The scoped usage aggregate counts ${report.aggregate.scopesCounted} scope(s) but the report carries ${counted.length} counted scope(s).`;
      }
      for (const key of ["requests", "sends", "completedUsage"] as const) {
        const expected = counted.reduce((sum, scope) => sum + scope.counts[key], 0);
        if (report.aggregate.counts[key] !== expected) {
          return `The scoped usage aggregate ${key} does not match the counted scopes' records.`;
        }
      }
      for (const field of metricFields) {
        let total = 0;
        let measured = 0;
        let missing = 0;
        for (const scope of counted) {
          const metric = scope.usage[field];
          if (metric.total !== null) {
            measured += 1;
            total += metric.total;
          }
          missing += metric.missing;
        }
        const totals = report.aggregate[field];
        if (totals.total !== (measured > 0 ? total : null) || totals.missing !== missing) {
          return `The scoped usage aggregate ${field} does not match the counted scopes' records.`;
        }
      }
      return null;
    };

    /**
     * R3 read-only recorded overview. Resolves the thread's own binding — the
     * live one, else the validated persisted resume cursor — and projects the
     * gateway's recorded summary. Zero side effects: no bind, no recovery, no
     * model call, and the thread's transcript cursors are NEVER advanced from
     * this poll. Foreign identities fail closed; a detached/unbound gateway
     * binding reports unavailable (an explicit Send may resume it); a gateway
     * that documents the missing method reports unsupported — nothing else is
     * downgraded from a hard error.
     *
     * The optional R8 `includeChildUsage` argument adds ONE read-only
     * `workbench.usage` (v1) probe after the overview is anchored: same
     * binding, same cursors, same child routing — no boot, no bind, no model,
     * no cursor advance. The probe's source heads must bind to the returned
     * overview by full-head equality or authentic monotonic progression; a
     * rewind, a foreign session, a replaced generation or a malformed report
     * fails the whole read closed. Only the documented missing-method (or a
     * child envelope that refuses to route it) is answered as a typed
     * unsupported `scopedUsage` — never a fabricated zero-total success.
     */
    const readWorkbenchOverview = (
      threadId: ThreadId,
      persistedResumeCursor?: unknown,
      options?: { readonly includeChildUsage?: boolean | undefined },
    ): Effect.Effect<ProviderWorkbenchOverviewResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const liveState = threads.get(threadId);
        let binding: { clientId: string; threadId: string };
        let sessionId: string;
        let sessionCursor: WorkbenchSessionCursor | undefined;
        let gatewayCursor: WorkbenchCursor | undefined;
        let observedGeneration: string | undefined;
        let childRoute: ChildRoute | undefined;
        if (liveState !== undefined) {
          binding = { clientId: liveState.clientId, threadId: liveState.threadId };
          sessionId = liveState.sessionId;
          sessionCursor = liveState.sessionCursor;
          gatewayCursor = liveState.gatewayCursor;
          observedGeneration =
            liveState.generation !== "genesis" ? liveState.generation : undefined;
          childRoute = liveState.childOf;
        } else if (persistedResumeCursor === undefined || persistedResumeCursor === null) {
          // Nothing anywhere binds this thread to a recorded source: an
          // unavailable view, never an error and never an empty success. The
          // operator's explicit Send creates the binding.
          return {
            status: "unavailable" as const,
            reason: `No live workbench session is bound to this thread; an explicit Send binds it and its recorded overview becomes available.`,
          };
        } else {
          // No live adapter state (server restart, detached view): the
          // persisted binding is the only legitimate source, validated the
          // same way startSession validates it — never an arbitrary caller's.
          const parsed = parseResumeState(persistedResumeCursor);
          if (!parsed.ok) {
            return yield* failRequest(
              "workbench.overview",
              `Refusing persisted resume state for thread ${threadId}: ${parsed.reason}.`,
            );
          }
          if (parsed.value.binding.clientId !== clientId) {
            return yield* failRequest(
              "workbench.overview",
              `Persisted workbench state belongs to client '${parsed.value.binding.clientId}'; this instance is '${clientId}'.`,
            );
          }
          if (parsed.value.binding.threadId !== threadId) {
            return yield* failRequest(
              "workbench.overview",
              `Persisted workbench state belongs to thread '${parsed.value.binding.threadId}'; this thread is '${threadId}'.`,
            );
          }
          binding = parsed.value.binding;
          sessionId = parsed.value.sessionId;
          sessionCursor = parsed.value.sessionCursor;
          gatewayCursor = parsed.value.gatewayCursor;
          childRoute = childRouteFromResume(parsed.value);
        }
        if (!config.enabled || configFailure !== undefined) {
          return {
            status: "unavailable" as const,
            reason: configFailure ?? "The Dokkabi provider is disabled.",
          };
        }
        let overview: OverviewResult;
        {
          const outcome = yield* callRouted(
            childRoute,
            "workbench.overview",
            {
              version: 1,
              binding,
              ...(sessionCursor !== undefined ? { sessionCursor } : {}),
              ...(gatewayCursor !== undefined ? { gatewayCursor } : {}),
            },
            OverviewSchema,
          ).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (!outcome.ok) {
            const detail = describe(outcome.error);
            // A gateway that is not bound right now is an unavailable source:
            // the operator's next explicit Send resumes the binding.
            if (/no workbench binding/i.test(detail)) {
              return {
                status: "unavailable" as const,
                reason:
                  "The Dokkabi gateway is not currently bound; an explicit Send resumes the binding and the recorded overview.",
              };
            }
            // Unsupported ONLY for the documented missing method on an older
            // gateway. A malformed reply, a source failure or a transport
            // loss never downgrades to unsupported — those stay errors.
            if (/method not found: workbench\.overview/i.test(detail)) {
              return {
                status: "unsupported" as const,
                reason:
                  "The Dokkabi gateway does not implement workbench.overview (older than the R3 protocol); its recorded overview cannot be read.",
              };
            }
            return yield* Effect.fail(outcome.error);
          }
          overview = outcome.result;
        }
        // --- source identity and continuity, fail closed ---
        //
        // The response must name THIS session. A known generation that
        // changed means the recorded source was REPLACED: that fails closed
        // even when the response claims resnapshot — R3 has no validated
        // projection-replacement contract, so a foreign chain never becomes
        // this conversation's summary. Both known generations (session log
        // and gateway ledger) are held to it, heads may never rewind, and a
        // head at a known seq must keep that row's hash.
        if (overview.sessionCursor.sessionId !== sessionId) {
          return yield* failRequest(
            "workbench.overview",
            `The overview names session '${overview.sessionCursor.sessionId}' but this thread is bound to '${sessionId}'.`,
          );
        }
        const knownSessionGeneration = sessionCursor?.generation ?? observedGeneration;
        if (
          knownSessionGeneration !== undefined &&
          overview.sessionCursor.generation !== knownSessionGeneration
        ) {
          return yield* failRequest(
            "workbench.overview",
            `The recorded session source was replaced (generation ${overview.sessionCursor.generation.slice(0, 12)}…, expected ${knownSessionGeneration.slice(0, 12)}…); a replaced source is never spliced onto this thread's overview.`,
          );
        }
        if (
          gatewayCursor?.generation !== undefined &&
          overview.gatewayCursor.generation !== gatewayCursor.generation
        ) {
          return yield* failRequest(
            "workbench.overview",
            "The gateway's durable ledger was replaced; its overview can no longer be correlated with this thread's validated cursors.",
          );
        }
        if (sessionCursor !== undefined) {
          if (overview.sessionCursor.seq < sessionCursor.seq) {
            return yield* failRequest(
              "workbench.overview",
              `The session head rewound (seq ${overview.sessionCursor.seq} after ${sessionCursor.seq}); a truncated or tampered source is never treated as current.`,
            );
          }
          if (
            overview.sessionCursor.seq === sessionCursor.seq &&
            overview.sessionCursor.hash !== sessionCursor.hash
          ) {
            return yield* failRequest(
              "workbench.overview",
              `The session head at seq ${sessionCursor.seq} carries a different hash than the validated cursor; the source chain diverged.`,
            );
          }
        }
        if (gatewayCursor !== undefined && overview.gatewayCursor.seq < gatewayCursor.seq) {
          return yield* failRequest(
            "workbench.overview",
            `The gateway head rewound (seq ${overview.gatewayCursor.seq} after ${gatewayCursor.seq}).`,
          );
        }
        if (
          gatewayCursor !== undefined &&
          overview.gatewayCursor.seq === gatewayCursor.seq &&
          overview.gatewayCursor.hash !== gatewayCursor.hash
        ) {
          return yield* failRequest(
            "workbench.overview",
            `The gateway head at seq ${gatewayCursor.seq} carries a different hash than the validated cursor; the ledger chain diverged.`,
          );
        }
        // --- closed-summary semantic consistency ---
        const refusal = (reason: string) => failRequest("workbench.overview", reason);
        {
          const cases = overview.work.cases;
          if (overview.work.state === "available" && cases === null) {
            return yield* refusal("An available work summary must carry its case counts.");
          }
          if (overview.work.state !== "available" && cases !== null) {
            return yield* refusal("A missing or invalid work summary must not carry case counts.");
          }
          if (cases !== null && cases.green + cases.red + cases.pending !== cases.total) {
            return yield* refusal("The work case counts do not add up to their total.");
          }
          const usage = overview.usage;
          const metrics: Array<
            readonly [
              string,
              {
                total: number | null;
                missing: number;
                latestSource: { seq: number; hash: string } | null;
              },
            ]
          > = [
            ["input", usage.input],
            ["output", usage.output],
            ["reasoning", usage.reasoning],
            ["cacheRead", usage.cacheRead],
            ["cacheWrite", usage.cacheWrite],
          ];
          for (const [name, metric] of metrics) {
            if (metric.missing > usage.records) {
              return yield* refusal(
                `Usage field '${name}' counts more missing records than exist.`,
              );
            }
          }
          for (const [name, metric] of metrics) {
            // Measured-only accounting: the records that are not missing are
            // exactly the measured ones. With none measured, a total or a
            // latest source would invent a record that does not exist; with
            // some measured, both must be present.
            const measured = usage.records - metric.missing;
            if (measured === 0 && (metric.total !== null || metric.latestSource !== null)) {
              return yield* refusal(
                `Usage field '${name}' claims a measured total or source with no measured record behind it.`,
              );
            }
            if (measured > 0 && (metric.total === null || metric.latestSource === null)) {
              return yield* refusal(
                `Usage field '${name}' is missing its total or latest source despite measured records.`,
              );
            }
          }
        }
        // --- source references against the returned prefix ---
        //
        // Precise scope: every ref must be a positive seq at or before the
        // returned session head, and a ref AT the head must carry the head's
        // own hash. Membership of OLDER rows is proven by the gateway's
        // hash chain, not re-derived here — these checks bound the refs, they
        // do not re-verify the chain.
        {
          const head = overview.sessionCursor;
          const refOk = (ref: { seq: number; hash: string } | null | undefined): boolean =>
            ref === null ||
            ref === undefined ||
            (Number.isSafeInteger(ref.seq) &&
              ref.seq >= 1 &&
              ref.seq <= head.seq &&
              (ref.seq !== head.seq || ref.hash === head.hash));
          if (
            !refOk(overview.work.goal?.source ?? null) ||
            !refOk(overview.context.frame?.source ?? null) ||
            !refOk(overview.usage.input.latestSource) ||
            !refOk(overview.usage.output.latestSource) ||
            !refOk(overview.usage.reasoning.latestSource) ||
            !refOk(overview.usage.cacheRead.latestSource) ||
            !refOk(overview.usage.cacheWrite.latestSource)
          ) {
            return yield* failRequest(
              "workbench.overview",
              "The overview cites a source reference outside the returned session head.",
            );
          }
        }
        if (options?.includeChildUsage !== true) {
          return { status: "available" as const, overview };
        }
        // --- R8 on-demand scoped usage: ONE optional-method read-only probe ---
        //
        // The overview above is the anchor: the probe travels the same
        // binding/cursors (and the same child envelope route), and its answer
        // must bind to that overview's validated source heads. A missing
        // method is the ONLY non-error refusal — and it is typed inside
        // scopedUsage so the overview itself stays usable.
        let scopedUsage: ProviderWorkbenchScopedUsage;
        {
          const outcome = yield* callRouted(
            childRoute,
            "workbench.usage",
            {
              version: 1,
              binding,
              ...(sessionCursor !== undefined ? { sessionCursor } : {}),
              ...(gatewayCursor !== undefined ? { gatewayCursor } : {}),
            },
            UsageSchema,
          ).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (!outcome.ok) {
            const detail = describe(outcome.error);
            // A gateway whose binding vanished between the two reads keeps
            // the anchored overview and reports the scoped read unavailable.
            if (/no workbench binding/i.test(detail)) {
              scopedUsage = {
                status: "unavailable" as const,
                reason:
                  "The Dokkabi gateway is not currently bound; an explicit Send resumes the binding and the scoped run usage.",
              };
            } else if (/method not found: workbench\.usage/i.test(detail)) {
              // Unsupported ONLY for the documented missing method on an
              // older gateway. A malformed reply, a source failure or a
              // transport loss never downgrades — those stay errors.
              scopedUsage = {
                status: "unsupported" as const,
                reason:
                  "The Dokkabi gateway does not implement workbench.usage (older than the R8 protocol); the scoped run usage cannot be read.",
              };
            } else if (/forbids method .*workbench\.usage/i.test(detail)) {
              // A child envelope that refuses to route the additive read is
              // the same documented missing-capability signal, nothing else.
              scopedUsage = {
                status: "unsupported" as const,
                reason:
                  "The Dokkabi gateway's child envelope does not route workbench.usage; the scoped run usage cannot be read for this child.",
              };
            } else {
              return yield* Effect.fail(outcome.error);
            }
          } else {
            const result = outcome.result;
            // --- source identity and continuity against the anchored overview ---
            if (result.sessionCursor.sessionId !== sessionId) {
              return yield* failRequest(
                "workbench.usage",
                `The scoped usage read names session '${result.sessionCursor.sessionId}' but this thread is bound to '${sessionId}'.`,
              );
            }
            if (result.sessionCursor.generation !== overview.sessionCursor.generation) {
              return yield* failRequest(
                "workbench.usage",
                `The recorded session source was replaced between the overview and scoped usage reads (generation ${result.sessionCursor.generation.slice(0, 12)}…, expected ${overview.sessionCursor.generation.slice(0, 12)}…); a replaced source is never spliced onto this thread's usage.`,
              );
            }
            if (result.sessionCursor.seq < overview.sessionCursor.seq) {
              return yield* failRequest(
                "workbench.usage",
                `The scoped usage session head rewound (seq ${result.sessionCursor.seq} after ${overview.sessionCursor.seq}); a truncated or tampered source is never treated as current.`,
              );
            }
            if (
              result.sessionCursor.seq === overview.sessionCursor.seq &&
              result.sessionCursor.hash !== overview.sessionCursor.hash
            ) {
              return yield* failRequest(
                "workbench.usage",
                `The scoped usage head at seq ${result.sessionCursor.seq} carries a different hash than the overview's validated head; the source chain diverged.`,
              );
            }
            if (result.gatewayCursor.generation !== overview.gatewayCursor.generation) {
              return yield* failRequest(
                "workbench.usage",
                "The gateway's durable ledger was replaced between the overview and scoped usage reads; its usage can no longer be correlated with this thread's validated cursors.",
              );
            }
            if (result.gatewayCursor.seq < overview.gatewayCursor.seq) {
              return yield* failRequest(
                "workbench.usage",
                `The gateway head rewound (seq ${result.gatewayCursor.seq} after ${overview.gatewayCursor.seq}).`,
              );
            }
            if (
              result.gatewayCursor.seq === overview.gatewayCursor.seq &&
              result.gatewayCursor.hash !== overview.gatewayCursor.hash
            ) {
              return yield* failRequest(
                "workbench.usage",
                `The gateway head at seq ${result.gatewayCursor.seq} carries a different hash than the overview's validated head; the ledger chain diverged.`,
              );
            }
            const refusal = scopedUsageRefusal({
              report: result.usage,
              sessionId,
              sessionHead: result.sessionCursor,
            });
            if (refusal !== null) {
              return yield* failRequest("workbench.usage", refusal);
            }
            scopedUsage = { status: "available" as const, report: result.usage };
          }
        }
        return { status: "available" as const, overview, scopedUsage };
      }).pipe(
        // A read has no effects, so a lost transport collapses into a visible
        // typed process error (the poller keeps the last view; the caller
        // reconciles on the next refresh).
        Effect.mapError(collapseLost("workbench.overview", threadId)),
      );

    /**
     * R4 read-only recorded Work/Context graph. Same source-boundary rules
     * as readWorkbenchOverview: resolves the thread's own binding (live, else
     * the validated persisted resume cursor), projects one verified prefix,
     * never advances the transcript cursors, and triggers no recovery, bind
     * or model effects. Beyond the shared identity/head validation, the
     * closed graph payload is held to its own contract: the requested
     * graphType, unique node ids, complete edge endpoints, coverage
     * arithmetic that cannot hide truncation, and source references bounded
     * by the returned head with exact hashes where the response itself is
     * authoritative (the head row, and internal consistency for equal seqs).
     */
    const readWorkbenchGraph = (
      threadId: ThreadId,
      graphType: WorkbenchGraphType,
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchGraphResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const liveState = threads.get(threadId);
        let binding: { clientId: string; threadId: string };
        let sessionId: string;
        let sessionCursor: WorkbenchSessionCursor | undefined;
        let gatewayCursor: WorkbenchCursor | undefined;
        let observedGeneration: string | undefined;
        let childRoute: ChildRoute | undefined;
        if (liveState !== undefined) {
          binding = { clientId: liveState.clientId, threadId: liveState.threadId };
          sessionId = liveState.sessionId;
          sessionCursor = liveState.sessionCursor;
          gatewayCursor = liveState.gatewayCursor;
          observedGeneration =
            liveState.generation !== "genesis" ? liveState.generation : undefined;
          childRoute = liveState.childOf;
        } else if (persistedResumeCursor === undefined || persistedResumeCursor === null) {
          return {
            status: "unavailable" as const,
            reason: `No live workbench session is bound to this thread; an explicit Send binds it and its recorded ${graphType} graph becomes available.`,
          };
        } else {
          const parsed = parseResumeState(persistedResumeCursor);
          if (!parsed.ok) {
            return yield* failRequest(
              "workbench.graph",
              `Refusing persisted resume state for thread ${threadId}: ${parsed.reason}.`,
            );
          }
          if (parsed.value.binding.clientId !== clientId) {
            return yield* failRequest(
              "workbench.graph",
              `Persisted workbench state belongs to client '${parsed.value.binding.clientId}'; this instance is '${clientId}'.`,
            );
          }
          if (parsed.value.binding.threadId !== threadId) {
            return yield* failRequest(
              "workbench.graph",
              `Persisted workbench state belongs to thread '${parsed.value.binding.threadId}'; this thread is '${threadId}'.`,
            );
          }
          binding = parsed.value.binding;
          sessionId = parsed.value.sessionId;
          sessionCursor = parsed.value.sessionCursor;
          gatewayCursor = parsed.value.gatewayCursor;
          childRoute = childRouteFromResume(parsed.value);
        }
        if (!config.enabled || configFailure !== undefined) {
          return {
            status: "unavailable" as const,
            reason: configFailure ?? "The Dokkabi provider is disabled.",
          };
        }
        let graphRead: GraphResult;
        {
          const outcome = yield* callRouted(
            childRoute,
            "workbench.graph",
            {
              version: 1,
              binding,
              graphType,
              ...(sessionCursor !== undefined ? { sessionCursor } : {}),
              ...(gatewayCursor !== undefined ? { gatewayCursor } : {}),
            },
            GraphSchema,
          ).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (!outcome.ok) {
            const detail = describe(outcome.error);
            if (/no workbench binding/i.test(detail)) {
              return {
                status: "unavailable" as const,
                reason:
                  "The Dokkabi gateway is not currently bound; an explicit Send resumes the binding and the recorded graph.",
              };
            }
            // Unsupported ONLY for the documented missing method on an older
            // gateway. A malformed reply, a source failure or a transport
            // loss never downgrades to unsupported — those stay errors.
            if (/method not found: workbench\.graph/i.test(detail)) {
              return {
                status: "unsupported" as const,
                reason:
                  "The Dokkabi gateway does not implement workbench.graph (older than the R4 protocol); its recorded graphs cannot be read.",
              };
            }
            return yield* Effect.fail(outcome.error);
          }
          graphRead = outcome.result;
        }
        // --- source identity and continuity, fail closed (shared rules) ---
        if (graphRead.sessionCursor.sessionId !== sessionId) {
          return yield* failRequest(
            "workbench.graph",
            `The ${graphType} graph names session '${graphRead.sessionCursor.sessionId}' but this thread is bound to '${sessionId}'.`,
          );
        }
        const knownSessionGeneration = sessionCursor?.generation ?? observedGeneration;
        if (
          knownSessionGeneration !== undefined &&
          graphRead.sessionCursor.generation !== knownSessionGeneration
        ) {
          return yield* failRequest(
            "workbench.graph",
            `The recorded session source was replaced (generation ${graphRead.sessionCursor.generation.slice(0, 12)}…, expected ${knownSessionGeneration.slice(0, 12)}…); a replaced source is never spliced onto this thread's graph.`,
          );
        }
        if (
          gatewayCursor?.generation !== undefined &&
          graphRead.gatewayCursor.generation !== gatewayCursor.generation
        ) {
          return yield* failRequest(
            "workbench.graph",
            "The gateway's durable ledger was replaced; its graphs can no longer be correlated with this thread's validated cursors.",
          );
        }
        if (sessionCursor !== undefined) {
          if (graphRead.sessionCursor.seq < sessionCursor.seq) {
            return yield* failRequest(
              "workbench.graph",
              `The session head rewound (seq ${graphRead.sessionCursor.seq} after ${sessionCursor.seq}); a truncated or tampered source is never treated as current.`,
            );
          }
          if (
            graphRead.sessionCursor.seq === sessionCursor.seq &&
            graphRead.sessionCursor.hash !== sessionCursor.hash
          ) {
            return yield* failRequest(
              "workbench.graph",
              `The session head at seq ${sessionCursor.seq} carries a different hash than the validated cursor; the source chain diverged.`,
            );
          }
        }
        if (gatewayCursor !== undefined && graphRead.gatewayCursor.seq < gatewayCursor.seq) {
          return yield* failRequest(
            "workbench.graph",
            `The gateway head rewound (seq ${graphRead.gatewayCursor.seq} after ${gatewayCursor.seq}).`,
          );
        }
        if (
          gatewayCursor !== undefined &&
          graphRead.gatewayCursor.seq === gatewayCursor.seq &&
          graphRead.gatewayCursor.hash !== gatewayCursor.hash
        ) {
          return yield* failRequest(
            "workbench.graph",
            `The gateway head at seq ${gatewayCursor.seq} carries a different hash than the validated cursor; the ledger chain diverged.`,
          );
        }
        // --- closed graph payload contract ---
        const refusal = (reason: string) => failRequest("workbench.graph", reason);
        const graph = graphRead.graph;
        if (graphRead.graphType !== graphType) {
          return yield* refusal(
            `The gateway answered a '${graphRead.graphType}' graph for a '${graphType}' request.`,
          );
        }
        {
          const ids = new Set<string>();
          for (const node of graph.nodes) {
            if (ids.has(node.id)) {
              return yield* refusal(`The graph contains duplicate node id '${node.id}'.`);
            }
            ids.add(node.id);
          }
          const edgeIds = new Set<string>();
          for (const edge of graph.edges) {
            if (edgeIds.has(edge.id)) {
              return yield* refusal(`The graph contains duplicate edge id '${edge.id}'.`);
            }
            edgeIds.add(edge.id);
            if (!ids.has(edge.from) || !ids.has(edge.to)) {
              return yield* refusal(
                `Edge '${edge.id}' references an endpoint that is not a node of this graph.`,
              );
            }
          }
        }
        {
          const coverage = graph.coverage;
          if (coverage.totalNodes !== graph.nodes.length + coverage.omittedNodes) {
            return yield* refusal("The graph's node coverage does not add up to its total.");
          }
          if (coverage.totalEdges !== graph.edges.length + coverage.omittedEdges) {
            return yield* refusal("The graph's edge coverage does not add up to its total.");
          }
          if (graph.state === "unavailable") {
            if (graph.nodes.length > 0 || graph.edges.length > 0) {
              return yield* refusal("An unavailable graph must not carry nodes or edges.");
            }
            if (
              coverage.omittedNodes !== coverage.totalNodes ||
              coverage.omittedEdges !== coverage.totalEdges
            ) {
              return yield* refusal("An unavailable graph must report everything as omitted.");
            }
          }
          if (
            (graph.state === "missing" || graph.state === "invalid") &&
            (graph.nodes.length > 0 ||
              graph.edges.length > 0 ||
              graph.waves.length > 0 ||
              graph.unscheduled.length > 0)
          ) {
            return yield* refusal(
              "A missing or invalid graph must not carry nodes, edges or layout hints.",
            );
          }
        }
        {
          // Source references: positive seqs bounded by the returned head,
          // the head row's own hash where the response is authoritative, and
          // internal consistency — two refs citing one seq never carry two
          // hashes. Range alone is never acceptance.
          const head = graphRead.sessionCursor;
          const hashBySeq = new Map<number, string>();
          const refOk = (ref: { seq: number; hash: string }): boolean => {
            if (!Number.isSafeInteger(ref.seq) || ref.seq < 1 || ref.seq > head.seq) return false;
            if (ref.seq === head.seq && ref.hash !== head.hash) return false;
            const known = hashBySeq.get(ref.seq);
            if (known !== undefined) return known === ref.hash;
            hashBySeq.set(ref.seq, ref.hash);
            return true;
          };
          for (const node of graph.nodes) {
            if (!node.sources.every(refOk)) {
              return yield* refusal(
                `Node '${node.id}' cites a source reference outside the returned session head or inconsistent with another citation.`,
              );
            }
          }
          for (const edge of graph.edges) {
            if (!edge.sources.every(refOk)) {
              return yield* refusal(
                `Edge '${edge.id}' cites a source reference outside the returned session head or inconsistent with another citation.`,
              );
            }
          }
        }
        return { status: "available" as const, graph: graphRead };
      }).pipe(
        // A read has no effects: a lost transport stays a visible typed
        // process error; the panel keeps its last view labeled stale.
        Effect.mapError(collapseLost("workbench.graph", threadId)),
      );

    /**
     * R5 read-only exact retained record page. Same source-boundary rules
     * as readWorkbenchGraph: resolves the thread's own binding (live, else
     * the validated persisted resume cursor), reads ONE verified prefix
     * under an immutable asOf pin, never advances the transcript cursors,
     * and triggers no recovery, bind or model effects. Beyond the shared
     * identity/head validation, every streamed row is re-verified at this
     * boundary: its canonical hash (sorted-key JSON, exactly the harness's
     * encoding), chain contiguity, first-row linkage to the requested
     * `after` (or genesis), asOf/head coherence with a pin that may sit
     * below the head, next/hasMore boundary truth, and the preregistered
     * 64 KiB row / 1 MiB canonical-array bounds. A forged or spliced page
     * fails closed — never rendered, never downgraded to unavailable.
     */
    const readWorkbenchRecord = (
      threadId: ThreadId,
      page: {
        readonly after?: WorkbenchRecordCursor | undefined;
        readonly asOf?: WorkbenchRecordAsOf | undefined;
        readonly limit?: number | undefined;
      },
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchRecordResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const liveState = threads.get(threadId);
        let binding: { clientId: string; threadId: string };
        let sessionId: string;
        let sessionCursor: WorkbenchSessionCursor | undefined;
        let gatewayCursor: WorkbenchCursor | undefined;
        let observedGeneration: string | undefined;
        let childRoute: ChildRoute | undefined;
        if (liveState !== undefined) {
          binding = { clientId: liveState.clientId, threadId: liveState.threadId };
          sessionId = liveState.sessionId;
          sessionCursor = liveState.sessionCursor;
          gatewayCursor = liveState.gatewayCursor;
          observedGeneration =
            liveState.generation !== "genesis" ? liveState.generation : undefined;
          childRoute = liveState.childOf;
        } else if (persistedResumeCursor === undefined || persistedResumeCursor === null) {
          return {
            status: "unavailable" as const,
            reason:
              "No live workbench session is bound to this thread; an explicit Send binds it and its retained records become available.",
          };
        } else {
          const parsed = parseResumeState(persistedResumeCursor);
          if (!parsed.ok) {
            return yield* failRequest(
              "workbench.record",
              `Refusing persisted resume state for thread ${threadId}: ${parsed.reason}.`,
            );
          }
          if (parsed.value.binding.clientId !== clientId) {
            return yield* failRequest(
              "workbench.record",
              `Persisted workbench state belongs to client '${parsed.value.binding.clientId}'; this instance is '${clientId}'.`,
            );
          }
          if (parsed.value.binding.threadId !== threadId) {
            return yield* failRequest(
              "workbench.record",
              `Persisted workbench state belongs to thread '${parsed.value.binding.threadId}'; this thread is '${threadId}'.`,
            );
          }
          binding = parsed.value.binding;
          sessionId = parsed.value.sessionId;
          sessionCursor = parsed.value.sessionCursor;
          gatewayCursor = parsed.value.gatewayCursor;
          childRoute = childRouteFromResume(parsed.value);
        }
        if (!config.enabled || configFailure !== undefined) {
          return {
            status: "unavailable" as const,
            reason: configFailure ?? "The Dokkabi provider is disabled.",
          };
        }
        let recordRead: RecordResult;
        {
          const outcome = yield* callRouted(
            childRoute,
            "workbench.record",
            {
              version: 1,
              binding,
              ...(page.after !== undefined ? { after: page.after } : {}),
              ...(page.asOf !== undefined ? { asOf: page.asOf } : {}),
              ...(page.limit !== undefined ? { limit: page.limit } : {}),
            },
            RecordSchema,
          ).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (!outcome.ok) {
            const detail = describe(outcome.error);
            if (/no workbench binding/i.test(detail)) {
              return {
                status: "unavailable" as const,
                reason:
                  "The Dokkabi gateway is not currently bound; an explicit Send resumes the binding and the retained records.",
              };
            }
            // Unsupported ONLY for the documented missing method on an older
            // gateway. A malformed reply, a forged row, a source failure or a
            // transport loss never downgrades to unsupported — those stay errors.
            if (/method not found: workbench\.record/i.test(detail)) {
              return {
                status: "unsupported" as const,
                reason:
                  "The Dokkabi gateway does not implement workbench.record (older than the R5 protocol); its retained records cannot be read.",
              };
            }
            return yield* Effect.fail(outcome.error);
          }
          recordRead = outcome.result;
        }
        // --- source identity and continuity, fail closed (shared rules) ---
        if (recordRead.sessionCursor.sessionId !== sessionId) {
          return yield* failRequest(
            "workbench.record",
            `The record page names session '${recordRead.sessionCursor.sessionId}' but this thread is bound to '${sessionId}'.`,
          );
        }
        const knownSessionGeneration = sessionCursor?.generation ?? observedGeneration;
        if (
          knownSessionGeneration !== undefined &&
          recordRead.sessionCursor.generation !== knownSessionGeneration
        ) {
          return yield* failRequest(
            "workbench.record",
            `The recorded session source was replaced (generation ${recordRead.sessionCursor.generation.slice(0, 12)}…, expected ${knownSessionGeneration.slice(0, 12)}…); a replaced source is never spliced onto this thread's records.`,
          );
        }
        if (
          gatewayCursor?.generation !== undefined &&
          recordRead.gatewayCursor.generation !== gatewayCursor.generation
        ) {
          return yield* failRequest(
            "workbench.record",
            "The gateway's durable ledger was replaced; its records can no longer be correlated with this thread's validated cursors.",
          );
        }
        if (sessionCursor !== undefined) {
          if (recordRead.sessionCursor.seq < sessionCursor.seq) {
            return yield* failRequest(
              "workbench.record",
              `The session head rewound (seq ${recordRead.sessionCursor.seq} after ${sessionCursor.seq}); a truncated or tampered source is never treated as current.`,
            );
          }
          if (
            recordRead.sessionCursor.seq === sessionCursor.seq &&
            recordRead.sessionCursor.hash !== sessionCursor.hash
          ) {
            return yield* failRequest(
              "workbench.record",
              `The session head at seq ${sessionCursor.seq} carries a different hash than the validated cursor; the source chain diverged.`,
            );
          }
        }
        if (gatewayCursor !== undefined && recordRead.gatewayCursor.seq < gatewayCursor.seq) {
          return yield* failRequest(
            "workbench.record",
            `The gateway head rewound (seq ${recordRead.gatewayCursor.seq} after ${gatewayCursor.seq}).`,
          );
        }
        if (
          gatewayCursor !== undefined &&
          recordRead.gatewayCursor.seq === gatewayCursor.seq &&
          recordRead.gatewayCursor.hash !== gatewayCursor.hash
        ) {
          return yield* failRequest(
            "workbench.record",
            `The gateway head at seq ${gatewayCursor.seq} carries a different hash than the validated cursor; the ledger chain diverged.`,
          );
        }
        // --- exact record chain: canonical hashes, contiguity, bounds ---
        const refusal = (reason: string) => failRequest("workbench.record", reason);
        const forged = verifyRecordRead({
          read: recordRead,
          after: page.after,
          asOf: page.asOf,
          limit: page.limit,
        });
        if (forged !== null) {
          return yield* refusal(forged);
        }
        return { status: "available" as const, record: recordRead };
      }).pipe(
        // A read has no effects: a lost transport stays a visible typed
        // process error; the panel keeps its last view labeled stale.
        Effect.mapError(collapseLost("workbench.record", threadId)),
      );

    // --- R8-06j2 explicit session work mode ---

    /** A gateway RPC error, as visible text. */
    const errorDetail = (error: unknown): string => describe(error);

    /** Older-gateway/missing-method detection shared by the additive reads. */
    const isMissingMethod = (method: string, detail: string): boolean =>
      detail.toLowerCase().endsWith(`method not found: ${method.toLowerCase()}`);

    // --- Bounded retained-data explorer (record index/body, graph explore) ---

    /**
     * The read owner every explorer method uses, resolved exactly like the
     * R4/R5 reads: the live thread state (including an adopted recorded
     * child, routed through the branch envelope), else the validated
     * persisted resume cursor of THIS client and thread — never a caller's.
     */
    type ExplorerOwner = {
      readonly binding: { clientId: string; threadId: string };
      readonly sessionId: string;
      readonly sessionCursor: WorkbenchSessionCursor | undefined;
      readonly gatewayCursor: WorkbenchCursor | undefined;
      readonly observedGeneration: string | undefined;
      readonly childRoute: ChildRoute | undefined;
    };
    const resolveExplorerOwner = (
      method: string,
      threadId: ThreadId,
      persistedResumeCursor: unknown,
      unboundReason: string,
    ): Effect.Effect<
      | { readonly ok: true; readonly owner: ExplorerOwner }
      | { readonly ok: false; readonly reason: string },
      DokkabiAdapterError
    > =>
      Effect.gen(function* () {
        const liveState = threads.get(threadId);
        let owner: ExplorerOwner;
        if (liveState !== undefined) {
          owner = {
            binding: { clientId: liveState.clientId, threadId: liveState.threadId },
            sessionId: liveState.sessionId,
            sessionCursor: liveState.sessionCursor,
            gatewayCursor: liveState.gatewayCursor,
            observedGeneration:
              liveState.generation !== "genesis" ? liveState.generation : undefined,
            childRoute: liveState.childOf,
          };
        } else if (persistedResumeCursor === undefined || persistedResumeCursor === null) {
          return { ok: false as const, reason: unboundReason };
        } else {
          const parsed = parseResumeState(persistedResumeCursor);
          if (!parsed.ok) {
            return yield* failRequest(
              method,
              `Refusing persisted resume state for thread ${threadId}: ${parsed.reason}.`,
            );
          }
          if (parsed.value.binding.clientId !== clientId) {
            return yield* failRequest(
              method,
              `Persisted workbench state belongs to client '${parsed.value.binding.clientId}'; this instance is '${clientId}'.`,
            );
          }
          if (parsed.value.binding.threadId !== threadId) {
            return yield* failRequest(
              method,
              `Persisted workbench state belongs to thread '${parsed.value.binding.threadId}'; this thread is '${threadId}'.`,
            );
          }
          owner = {
            binding: parsed.value.binding,
            sessionId: parsed.value.sessionId,
            sessionCursor: parsed.value.sessionCursor,
            gatewayCursor: parsed.value.gatewayCursor,
            observedGeneration: undefined,
            childRoute: childRouteFromResume(parsed.value),
          };
        }
        if (!config.enabled || configFailure !== undefined) {
          return {
            ok: false as const,
            reason: configFailure ?? "The Dokkabi provider is disabled.",
          };
        }
        return { ok: true as const, owner };
      });

    /**
     * One disposable explorer read through the owner's route. Only the
     * documented exact method-not-found code and method identity
     * become `unsupported`; an unbound gateway is `unavailable`. Every other
     * failure (malformed reply, source refusal, transport loss) stays an
     * error and is never cached or downgraded.
     */
    type ExplorerMiss = {
      readonly ok: false;
      readonly status: "unavailable" | "unsupported";
      readonly reason: string;
    };
    const callExplorer = <T>(
      owner: ExplorerOwner,
      method: "workbench.record.index" | "workbench.record.body" | "workbench.graph.explore",
      params: unknown,
      schema: Schema.Codec<T, unknown>,
    ): Effect.Effect<
      { readonly ok: true; readonly result: T } | ExplorerMiss,
      DokkabiAdapterError | WorkbenchTransportLost
    > =>
      callRouted(owner.childRoute, method, params, schema, true).pipe(
        Effect.map((result): { readonly ok: true; readonly result: T } | ExplorerMiss => ({
          ok: true as const,
          result,
        })),
        Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) => {
          const detail = describe(error);
          if (/no workbench binding/i.test(detail)) {
            return Effect.succeed<ExplorerMiss>({
              ok: false as const,
              status: "unavailable" as const,
              reason:
                "The Dokkabi gateway is not currently bound; an explicit Send resumes the binding.",
            });
          }
          if (
            isRequestError(error) &&
            requestRpcCodes.get(error) === -32601 &&
            error.detail.toLowerCase() === `method not found: ${method}`
          ) {
            return Effect.succeed<ExplorerMiss>({
              ok: false as const,
              status: "unsupported" as const,
              reason: `The Dokkabi gateway does not implement ${method} (older than the bounded explorer protocol).`,
            });
          }
          return Effect.fail(error);
        }),
      );

    /** Shared identity/continuity: this session, no replaced generation, no
     * rewound or diverged head relative to the thread's validated cursors. */
    const explorerContinuityRefusal = (
      owner: ExplorerOwner,
      sessionCursor: WorkbenchSessionCursor,
      gatewayCursor: WorkbenchCursor,
    ): string | null => {
      if (sessionCursor.sessionId !== owner.sessionId) {
        return `The response names session '${sessionCursor.sessionId}' but this thread is bound to '${owner.sessionId}'.`;
      }
      const knownGeneration = owner.sessionCursor?.generation ?? owner.observedGeneration;
      if (knownGeneration !== undefined && sessionCursor.generation !== knownGeneration) {
        return `The recorded session source was replaced (generation ${sessionCursor.generation.slice(0, 12)}…, expected ${knownGeneration.slice(0, 12)}…); a replaced source is never spliced onto this thread.`;
      }
      if (
        owner.gatewayCursor !== undefined &&
        gatewayCursor.generation !== owner.gatewayCursor.generation
      ) {
        return "The gateway's durable ledger was replaced; the response can no longer be correlated with this thread's validated cursors.";
      }
      if (owner.sessionCursor !== undefined) {
        if (sessionCursor.seq < owner.sessionCursor.seq) {
          return `The session head rewound (seq ${sessionCursor.seq} after ${owner.sessionCursor.seq}); a truncated or tampered source is never treated as current.`;
        }
        if (
          sessionCursor.seq === owner.sessionCursor.seq &&
          sessionCursor.hash !== owner.sessionCursor.hash
        ) {
          return `The session head at seq ${owner.sessionCursor.seq} carries a different hash than the validated cursor; the source chain diverged.`;
        }
      }
      if (owner.gatewayCursor !== undefined) {
        if (gatewayCursor.seq < owner.gatewayCursor.seq) {
          return `The gateway head rewound (seq ${gatewayCursor.seq} after ${owner.gatewayCursor.seq}).`;
        }
        if (
          gatewayCursor.seq === owner.gatewayCursor.seq &&
          gatewayCursor.hash !== owner.gatewayCursor.hash
        ) {
          return `The gateway head at seq ${owner.gatewayCursor.seq} carries a different hash than the validated cursor; the ledger chain diverged.`;
        }
      }
      return null;
    };

    /** Outbound params are checked against the closed schema before ANY
     * route — a child envelope carries its inner params opaquely. */
    const checkExplorerParams = (
      method: "workbench.record.index" | "workbench.record.body" | "workbench.graph.explore",
      params: unknown,
    ): Effect.Effect<void, DokkabiAdapterError> =>
      Schema.decodeUnknownEffect(
        workbenchParamsSchemas[method],
        STRICT_DECODE_OPTIONS,
      )(params).pipe(
        Effect.asVoid,
        Effect.mapError(
          () =>
            new ProviderAdapterRequestError({
              provider: PROVIDER_KIND,
              method,
              detail: `The ${method} request does not match the closed v1 request schema.`,
            }),
        ),
      );

    /**
     * Bounded metadata page of one pinned prefix: exact descriptors only, no
     * payload bytes. Held to the shared identity rules and the descriptor
     * hash chain (RecordExplorer.verifyRecordIndexRead).
     */
    const readWorkbenchRecordIndex = (
      threadId: ThreadId,
      page: {
        readonly after?: WorkbenchRecordCursor | undefined;
        readonly asOf?: WorkbenchRecordAsOf | undefined;
        readonly limit?: number | undefined;
      },
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchRecordIndexResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const method = "workbench.record.index" as const;
        const resolved = yield* resolveExplorerOwner(
          method,
          threadId,
          persistedResumeCursor,
          "No live workbench session is bound to this thread; an explicit Send binds it and its retained records become available.",
        );
        if (!resolved.ok) return { status: "unavailable" as const, reason: resolved.reason };
        const owner = resolved.owner;
        const params = {
          version: 1,
          binding: owner.binding,
          ...(page.after !== undefined ? { after: page.after } : {}),
          ...(page.asOf !== undefined ? { asOf: page.asOf } : {}),
          ...(page.limit !== undefined ? { limit: page.limit } : {}),
        };
        yield* checkExplorerParams(method, params);
        if (page.asOf !== undefined && page.asOf.sessionId !== owner.sessionId) {
          return yield* failRequest(
            method,
            `The requested pin names session '${page.asOf.sessionId}' but this thread is bound to '${owner.sessionId}'.`,
          );
        }
        const outcome = yield* callExplorer(owner, method, params, RecordIndexSchema);
        if (!outcome.ok) return { status: outcome.status, reason: outcome.reason };
        const read = outcome.result;
        const continuity = explorerContinuityRefusal(owner, read.sessionCursor, read.gatewayCursor);
        if (continuity !== null) return yield* failRequest(method, continuity);
        const refusal = verifyRecordIndexRead({
          read,
          after: page.after,
          asOf: page.asOf,
          limit: page.limit,
        });
        if (refusal !== null) return yield* failRequest(method, refusal);
        return { status: "available" as const, index: read };
      }).pipe(Effect.mapError(collapseLost("workbench.record.index", threadId)));

    /**
     * One canonical byte range of one exact row under a required pin, held
     * to its request, the descriptor's length/digest, its own chunk digest
     * and honest end (RecordExplorer.verifyRecordBodyRange). A range is a
     * slice: it never claims the row is exact.
     */
    const readWorkbenchRecordBody = (
      threadId: ThreadId,
      range: {
        readonly row: WorkbenchRecordCursor;
        readonly asOf: WorkbenchRecordAsOf;
        readonly offset: number;
        readonly limit?: number | undefined;
        readonly expected?: WorkbenchRecordBodyExpected | undefined;
      },
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchRecordBodyResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const resolved = yield* resolveExplorerOwner(
          "workbench.record.body",
          threadId,
          persistedResumeCursor,
          "No live workbench session is bound to this thread; an explicit Send binds it and its retained records become available.",
        );
        if (!resolved.ok) return { status: "unavailable" as const, reason: resolved.reason };
        const outcome = yield* readBodyRange(resolved.owner, range);
        if (!outcome.ok) return { status: outcome.status, reason: outcome.reason };
        return { status: "available" as const, body: outcome.body };
      }).pipe(Effect.mapError(collapseLost("workbench.record.body", threadId)));

    const readBodyRange = (
      owner: ExplorerOwner,
      range: {
        readonly row: WorkbenchRecordCursor;
        readonly asOf: WorkbenchRecordAsOf;
        readonly offset: number;
        readonly limit?: number | undefined;
        readonly expected?: WorkbenchRecordBodyExpected | undefined;
      },
    ): Effect.Effect<
      | { readonly ok: true; readonly body: RecordBodyResult; readonly bytes: Buffer }
      | {
          readonly ok: false;
          readonly status: "unavailable" | "unsupported";
          readonly reason: string;
        },
      DokkabiAdapterError | WorkbenchTransportLost
    > =>
      Effect.gen(function* () {
        const method = "workbench.record.body" as const;
        const params = {
          version: 1,
          binding: owner.binding,
          row: range.row,
          asOf: range.asOf,
          offset: range.offset,
          ...(range.limit !== undefined ? { limit: range.limit } : {}),
        };
        yield* checkExplorerParams(method, params);
        if (range.asOf.sessionId !== owner.sessionId) {
          return yield* failRequest(
            method,
            `The requested pin names session '${range.asOf.sessionId}' but this thread is bound to '${owner.sessionId}'.`,
          );
        }
        const outcome = yield* callExplorer(owner, method, params, RecordBodySchema);
        if (!outcome.ok) return outcome;
        const read = outcome.result;
        const continuity = explorerContinuityRefusal(owner, read.sessionCursor, read.gatewayCursor);
        if (continuity !== null) return yield* failRequest(method, continuity);
        const verified = verifyRecordBodyRange({
          read,
          row: range.row,
          asOf: range.asOf,
          offset: range.offset,
          limit: range.limit,
          // Without an explicit descriptor the range still binds to its own
          // reported length/digest; callers that hold a descriptor pass it.
          expected: range.expected ?? {
            byteLength: read.totalBytes,
            bodyDigest: read.bodyDigest,
          },
        });
        if (!verified.ok) return yield* failRequest(method, verified.reason);
        return { ok: true as const, body: read, bytes: verified.bytes };
      });

    /**
     * Streamed full-row verification, explicit and app-only (no fourth
     * gateway method): reads every bounded range in order through the same
     * owner and the same exact pin, feeding RecordBodyStreamVerifier against
     * the caller's independent descriptor (length + body digest) and the
     * requested row's event hash. Each chunk's session/gateway heads must
     * continue the previous chunk's (no rewind, divergence or replaced
     * generation mid-stream). The verdict is "exact" only when the assembled
     * digest equals the descriptor's AND the canonical bytes hash to the
     * row's event hash. No range is retained; any failure is an error, never
     * a weaker verdict. Interrupting the caller aborts the in-flight range
     * (a disposable read) and sends nothing further; rows beyond
     * RECORD_VERIFY_MAX_BYTES are refused before the wire.
     */
    const verifyWorkbenchRecordBody = (
      threadId: ThreadId,
      target: {
        readonly row: WorkbenchRecordCursor;
        readonly asOf: WorkbenchRecordAsOf;
        readonly expected: WorkbenchRecordBodyExpected;
      },
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchRecordVerificationResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const method = "workbench.record.body" as const;
        const resolved = yield* resolveExplorerOwner(
          method,
          threadId,
          persistedResumeCursor,
          "No live workbench session is bound to this thread; an explicit Send binds it and its retained records become available.",
        );
        if (!resolved.ok) return { status: "unavailable" as const, reason: resolved.reason };
        if (target.expected.byteLength > RECORD_VERIFY_MAX_BYTES) {
          return yield* failRequest(
            method,
            `The row spans ${target.expected.byteLength} canonical bytes, beyond the ${RECORD_VERIFY_MAX_BYTES} byte streamed verification bound.`,
          );
        }
        const verifier = new RecordBodyStreamVerifier(target.row.hash, target.expected);
        let owner = resolved.owner;
        while (verifier.offset < target.expected.byteLength) {
          const outcome = yield* readBodyRange(owner, {
            row: target.row,
            asOf: target.asOf,
            offset: verifier.offset,
            limit: RECORD_BODY_MAX_BYTES,
            expected: target.expected,
          });
          if (!outcome.ok) return { status: outcome.status, reason: outcome.reason };
          const refusal = verifier.update(outcome.body.offset, outcome.bytes);
          if (refusal !== null) return yield* failRequest(method, refusal);
          // Ratchet: the next chunk is held to this chunk's heads.
          owner = {
            ...owner,
            sessionCursor: outcome.body.sessionCursor,
            gatewayCursor: outcome.body.gatewayCursor,
          };
          if (outcome.body.nextOffset === null) break;
        }
        const refusal = verifier.finish();
        if (refusal !== null) return yield* failRequest(method, refusal);
        return {
          status: "available" as const,
          verification: {
            verdict: "exact" as const,
            row: target.row,
            asOf: target.asOf,
            totalBytes: target.expected.byteLength,
            bodyDigest: target.expected.bodyDigest,
            chunks: verifier.chunks,
          },
        };
      }).pipe(Effect.mapError(collapseLost("workbench.record.body", threadId)));

    /**
     * One bounded page/search/neighbors view of the full Work/Context display
     * projection, optionally pinned to an earlier snapshot. A stale answer is
     * an explicit state; every page is held to its request, its structure,
     * its citations, its pagination and its recorded counts
     * (GraphExplorer.verifyGraphExploreRead).
     */
    const exploreWorkbenchGraph = (
      threadId: ThreadId,
      input: {
        readonly graphType: WorkbenchGraphType;
        readonly query: WorkbenchGraphExploreQueryInput;
        readonly snapshot?: WorkbenchGraphExploreSnapshot | undefined;
      },
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchGraphExploreResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const method = "workbench.graph.explore" as const;
        const resolved = yield* resolveExplorerOwner(
          method,
          threadId,
          persistedResumeCursor,
          `No live workbench session is bound to this thread; an explicit Send binds it and its recorded ${input.graphType} graph becomes available.`,
        );
        if (!resolved.ok) return { status: "unavailable" as const, reason: resolved.reason };
        const owner = resolved.owner;
        const query = normalizeGraphExploreQuery(input.query);
        const params = {
          version: 1,
          binding: owner.binding,
          graphType: input.graphType,
          query,
          ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
        };
        yield* checkExplorerParams(method, params);
        if (
          input.snapshot !== undefined &&
          input.snapshot.sessionCursor.sessionId !== owner.sessionId
        ) {
          return yield* failRequest(
            method,
            `The pinned snapshot names session '${input.snapshot.sessionCursor.sessionId}' but this thread is bound to '${owner.sessionId}'.`,
          );
        }
        const outcome = yield* callExplorer(owner, method, params, GraphExploreSchema);
        if (!outcome.ok) return { status: outcome.status, reason: outcome.reason };
        const read = outcome.result;
        const continuity = explorerContinuityRefusal(owner, read.sessionCursor, read.gatewayCursor);
        if (continuity !== null) return yield* failRequest(method, continuity);
        const refusal = verifyGraphExploreRead({
          read,
          graphType: input.graphType,
          query,
          snapshot: input.snapshot,
        });
        if (refusal !== null) return yield* failRequest(method, refusal);
        return { status: "available" as const, explore: read };
      }).pipe(Effect.mapError(collapseLost("workbench.graph.explore", threadId)));

    /**
     * Shared owner resolution for scoped workbench operations: the live thread state
     * (including an adopted prepared child, whose workMode travels the branch
     * envelope under the authenticated parent owner), else the validated
     * persisted resume cursor — never an arbitrary caller's. A persisted
     * quarantine latch refuses BEFORE any operation: a replaced source log
     * never receives a selection effect.
     */
    const resolveWorkbenchOwner = (
      threadId: ThreadId,
      persistedResumeCursor: unknown,
      method = "workbench.workMode",
    ):
      | {
          readonly ok: true;
          readonly binding: { clientId: string; threadId: string };
          readonly sessionId: string;
          readonly sessionCursor: WorkbenchSessionCursor | undefined;
          readonly gatewayCursor: WorkbenchCursor | undefined;
          readonly observedGeneration: string | undefined;
          readonly model: string | undefined;
          readonly childRoute: ChildRoute | undefined;
          /**
           * The live handshake's capability fact. False short-circuits to
           * unsupported WITHOUT a wire call; undefined (persisted-only path)
           * is resolved by ONE read-only preflight handshake that proves both
           * the current session identity and the optional capability.
           */
          readonly workModeCapability: boolean | undefined;
        }
      | { readonly ok: false; readonly kind: "unavailable"; readonly reason: string }
      | { readonly ok: false; readonly kind: "error"; readonly error: DokkabiAdapterError } => {
      const liveState = threads.get(threadId);
      if (liveState !== undefined) {
        if (liveState.quarantined !== undefined || liveState.sourceTimeRefusedFor.size > 0) {
          return {
            ok: false,
            kind: "error",
            error: new ProviderAdapterRequestError({
              provider: DOKKABI_DRIVER_KIND,
              method,
              detail:
                "The recorded source is quarantined or has unverified source times; work mode remains read-only.",
            }),
          };
        }
        return {
          ok: true,
          binding: { clientId: liveState.clientId, threadId: liveState.threadId },
          sessionId: liveState.sessionId,
          sessionCursor: liveState.sessionCursor,
          gatewayCursor: liveState.gatewayCursor,
          observedGeneration: liveState.generation !== "genesis" ? liveState.generation : undefined,
          model: liveState.model,
          childRoute: liveState.childOf,
          workModeCapability: liveState.workModeCapability ?? false,
        };
      }
      if (persistedResumeCursor === undefined || persistedResumeCursor === null) {
        return {
          ok: false,
          kind: "unavailable",
          reason:
            "No live workbench session is bound to this thread; an explicit Send binds its recorded workbench source.",
        };
      }
      const parsed = parseResumeState(persistedResumeCursor);
      if (!parsed.ok) {
        return {
          ok: false,
          kind: "error",
          error: new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method,
            detail: `Refusing persisted resume state for thread ${threadId}: ${parsed.reason}.`,
          }),
        };
      }
      if (parsed.value.binding.clientId !== clientId) {
        return {
          ok: false,
          kind: "error",
          error: new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method,
            detail: `Persisted workbench state belongs to client '${parsed.value.binding.clientId}'; this instance is '${clientId}'.`,
          }),
        };
      }
      if (parsed.value.binding.threadId !== threadId) {
        return {
          ok: false,
          kind: "error",
          error: new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method,
            detail: `Persisted workbench state belongs to thread '${parsed.value.binding.threadId}'; this thread is '${threadId}'.`,
          }),
        };
      }
      if (parsed.value.sourceMismatch) {
        return {
          ok: false,
          kind: "error",
          error: new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method,
            detail:
              "This conversation's recorded source log was previously replaced or truncated. It is preserved read-only; stop the session and start a fresh conversation before changing its work mode.",
          }),
        };
      }
      return {
        ok: true,
        binding: parsed.value.binding,
        sessionId: parsed.value.sessionId,
        sessionCursor: parsed.value.sessionCursor,
        gatewayCursor: parsed.value.gatewayCursor,
        observedGeneration: parsed.value.sessionCursor?.generation,
        model: parsed.value.parentModel,
        childRoute: childRouteFromResume(parsed.value),
        workModeCapability: undefined,
      };
    };

    /**
     * Map a wire refusal/error outcome onto the read result. Only the
     * documented missing method becomes unsupported; a detached binding is
     * unavailable; everything else stays a hard error — never an empty
     * success and never a downgrade of a malformed reply.
     */
    const readWorkbenchCode = Effect.fn("DokkabiAdapter.readWorkbenchCode")(function* (
      threadId: ThreadId,
      page: Omit<ProviderGetWorkbenchCodeInput, "threadId">,
      persistedResumeCursor?: unknown,
    ): Effect.fn.Return<ProviderWorkbenchCodeResult, DokkabiAdapterError> {
      const owner = resolveWorkbenchOwner(threadId, persistedResumeCursor, "workbench.code");
      if (!owner.ok) {
        if (owner.kind === "error") return yield* Effect.fail(owner.error);
        return { status: "unavailable", reason: owner.reason };
      }
      if (!owner.sessionCursor || owner.sessionCursor.seq === 0 || !owner.gatewayCursor) {
        return {
          status: "unavailable",
          reason:
            "Code history requires verified session and gateway cursors from the bound workbench; this connection has no source anchors yet.",
        };
      }
      if (!config.enabled || configFailure !== undefined)
        return {
          status: "unavailable",
          reason: configFailure ?? "The Dokkabi provider is disabled.",
        };
      if (page.after?.sessionId !== undefined && page.after.sessionId !== owner.sessionId)
        return yield* failRequest(
          "workbench.code",
          "Code acknowledgement belongs to another session.",
        );
      const outcome = yield* callRouted(
        owner.childRoute,
        "workbench.code",
        {
          version: 1,
          binding: owner.binding,
          ...page,
          ...(owner.sessionCursor ? { sessionCursor: owner.sessionCursor } : {}),
          ...(owner.gatewayCursor ? { gatewayCursor: owner.gatewayCursor } : {}),
        },
        CodeSchema,
      ).pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
          Effect.succeed({ ok: false as const, error }),
        ),
      );
      if (!outcome.ok) {
        const detail = describe(outcome.error);
        if (isMissingMethod("workbench.code", detail))
          return {
            status: "unsupported",
            reason: "The gateway has no retained code read capability.",
          };
        if (/no workbench binding/i.test(detail))
          return { status: "unavailable", reason: "The workbench source is detached." };
        return yield* Effect.fail(collapseLost("workbench.code", threadId)(outcome.error));
      }
      const read: CodeResult = outcome.result;
      if (read.sessionCursor.sessionId !== owner.sessionId)
        return yield* failRequest("workbench.code", "The code index names another session.");
      for (const [current, known] of [
        [read.sessionCursor, owner.sessionCursor],
        [read.gatewayCursor, owner.gatewayCursor],
      ] as const) {
        if (
          known &&
          (current.generation !== known.generation ||
            current.seq < known.seq ||
            (current.seq === known.seq && current.hash !== known.hash))
        )
          return yield* failRequest(
            "workbench.code",
            "The recorded code source was replaced or rewound; the view is stale.",
          );
      }
      if (owner.observedGeneration && read.sessionCursor.generation !== owner.observedGeneration)
        return yield* failRequest(
          "workbench.code",
          "The recorded code session generation changed; the view is stale.",
        );
      const invalid = verifyCodeRead(read, page);
      if (invalid) return yield* failRequest("workbench.code", invalid);
      return { status: "available", code: read };
    });

    const pendingCodeActions = new Map<
      string,
      { readonly payload: string; readonly owner: string }
    >();
    const workbenchCodeAction = Effect.fn("DokkabiAdapter.workbenchCodeAction")(function* (
      threadId: ThreadId,
      input: Omit<ProviderWorkbenchCodeActionInput, "threadId">,
      persistedResumeCursor?: unknown,
    ): Effect.fn.Return<ProviderWorkbenchCodeActionResult, DokkabiAdapterError> {
      const action = yield* decodeCodeAction(input).pipe(
        Effect.mapError(
          () =>
            new ProviderAdapterRequestError({
              provider: DOKKABI_DRIVER_KIND,
              method: "workbench.codeAction",
              detail: "Invalid Code recovery request.",
            }),
        ),
      );
      return yield* withForegroundGate(
        Effect.gen(function* () {
          const unknown = {
            version: 1 as const,
            state: "unknown" as const,
            reason:
              "The Code recovery outcome is unknown. Retry this same command and payload after reconnecting to its recorded owner.",
          };
          const payload = JSON.stringify(action);
          const pending = pendingCodeActions.get(action.commandId);
          if (pending && pending.payload !== payload)
            return yield* failRequest(
              "workbench.codeAction",
              "An unknown Code recovery command can only be retried with its exact payload and recorded owner.",
            );
          const owner = resolveWorkbenchOwner(
            threadId,
            persistedResumeCursor,
            "workbench.codeAction",
          );
          if (!owner.ok) {
            if (owner.kind === "error") return yield* owner.error;
            return pending
              ? unknown
              : { version: 1 as const, state: "unavailable" as const, reason: owner.reason };
          }
          if (!owner.sessionCursor || owner.sessionCursor.seq === 0 || !owner.gatewayCursor) {
            return pending
              ? unknown
              : {
                  version: 1 as const,
                  state: "unavailable" as const,
                  reason: "Code recovery requires verified session and gateway source anchors.",
                };
          }
          if (!config.enabled || configFailure !== undefined) {
            return pending
              ? unknown
              : {
                  version: 1 as const,
                  state: "unavailable" as const,
                  reason: configFailure ?? "The Dokkabi provider is disabled.",
                };
          }
          const source = JSON.stringify({
            binding: owner.binding,
            sessionId: owner.sessionId,
            sessionGeneration: owner.sessionCursor.generation,
            gatewayGeneration: owner.gatewayCursor.generation,
          });
          if (pending && pending.owner !== source) {
            return yield* failRequest(
              "workbench.codeAction",
              "An unknown Code recovery command can only be retried with its exact payload and recorded owner.",
            );
          }
          if (!pending && pendingCodeActions.size >= 128) {
            return {
              version: 1 as const,
              state: "busy" as const,
              reason: "Resolve an existing unknown Code recovery command before creating another.",
            };
          }
          const preflight = yield* workModePreflight(owner, "codeAction").pipe(
            Effect.mapError(collapseLost("workbench.codeAction", threadId)),
          );
          if (!preflight.ok)
            return pending
              ? unknown
              : { version: 1 as const, state: preflight.state, reason: preflight.reason };
          pendingCodeActions.set(action.commandId, { payload, owner: source });
          const outcome = yield* callRouted(
            owner.childRoute,
            "workbench.codeAction",
            {
              ...action,
              version: 1,
              binding: owner.binding,
            },
            CodeActionSchema,
          ).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch(() => Effect.succeed({ ok: false as const })),
          );
          if (!outcome.ok) return unknown;
          const response = outcome.result;
          if (response.state === "applied") {
            if (
              response.receipt.commandId !== action.commandId ||
              response.observer.revision === undefined ||
              response.observer.revision < response.receipt.seq ||
              (response.receipt.seq === preflight.read.sessionCursor.seq &&
                response.receipt.hash !== preflight.read.sessionCursor.hash)
            ) {
              return unknown;
            }
          }
          // A negative retry describes this attempt, not an earlier lost receipt.
          // Only a matching applied receipt reconciles a previously unknown command.
          if (pending && response.state !== "applied") {
            const reason = transport?.redactText(response.reason) ?? response.reason;
            return {
              ...unknown,
              reason:
                `The original Code recovery receipt remains unknown · ${response.state}: ${reason}`.slice(
                  0,
                  1024,
                ),
            };
          }
          if (response.state !== "unknown") pendingCodeActions.delete(action.commandId);
          return response.state === "applied"
            ? response
            : { ...response, reason: transport?.redactText(response.reason) ?? response.reason };
        }),
      );
    });

    const workModeReadRefusal = (
      detail: string,
    ):
      | { status: "unavailable"; reason: string }
      | { status: "unsupported"; reason: string }
      | undefined => {
      if (/no workbench binding/i.test(detail)) {
        return {
          status: "unavailable",
          reason:
            "The Dokkabi gateway is not currently bound; an explicit Send resumes the binding and the work mode.",
        };
      }
      if (/method not found: workbench\.workMode/i.test(detail)) {
        return {
          status: "unsupported",
          reason:
            "The Dokkabi gateway does not implement workbench.workMode (older than the R8-06j2 protocol); the session work mode cannot be read.",
        };
      }
      return undefined;
    };

    /**
     * Read-only preflight for every supported operation. Preserve the current
     * owner and validated prefix without advancing projection cursors. The
     * handshake proves the gateway's CURRENT session identity
     * (a foreign session with the same transport binding never receives a
     * work-mode effect) and the optional capability (the app never calls an
     * unsupported method). A handshake boots nothing and appends nothing.
     */
    const workModePreflight = (
      owner: {
        readonly binding: { readonly clientId: string; readonly threadId: string };
        readonly sessionId: string;
        readonly sessionCursor: WorkbenchSessionCursor | undefined;
        readonly gatewayCursor: WorkbenchCursor | undefined;
        readonly observedGeneration: string | undefined;
        readonly model: string | undefined;
        readonly childRoute: ChildRoute | undefined;
      },
      capability: "workMode" | "codeAction" = "workMode",
    ): Effect.Effect<
      | { readonly ok: true; readonly read: ReadResult }
      | {
          readonly ok: false;
          readonly state: "unavailable" | "unsupported";
          readonly reason: string;
        },
      DokkabiAdapterError | WorkbenchTransportLost
    > =>
      Effect.gen(function* () {
        const method = capability === "workMode" ? "workbench.workMode" : "workbench.codeAction";
        const identity = yield* handshake(owner.childRoute);
        if (identity.sessionId !== owner.sessionId) {
          return yield* failRequest(
            method,
            `The gateway owns session '${identity.sessionId}' but this thread is recorded against '${owner.sessionId}'; a work-mode operation never crosses sessions.`,
          );
        }
        if (
          identity.workspacePath !== (owner.childRoute?.workspacePath ?? config.workspacePath) ||
          (owner.model !== undefined && identity.model !== owner.model)
        ) {
          return yield* failRequest(
            method,
            "The current gateway workspace or model differs from this recorded owner.",
          );
        }
        if (identity.capabilities[capability] !== true) {
          return {
            ok: false as const,
            state: "unsupported" as const,
            reason:
              capability === "workMode"
                ? "This Dokkabi gateway reported no work mode capability at handshake; the session work mode cannot be reached here."
                : "This Dokkabi gateway reported no Code observer control capability at handshake.",
          };
        }
        const readOutcome = yield* callRouted(
          owner.childRoute,
          "workbench.read",
          {
            version: 1,
            binding: owner.binding,
            ...(owner.sessionCursor !== undefined ? { sessionCursor: owner.sessionCursor } : {}),
            ...(owner.gatewayCursor !== undefined ? { gatewayCursor: owner.gatewayCursor } : {}),
          },
          ReadSchema,
        ).pipe(
          Effect.map((read) => ({ ok: true as const, read })),
          Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        );
        if (!readOutcome.ok) {
          if (/no workbench binding/i.test(errorDetail(readOutcome.error))) {
            return {
              ok: false as const,
              state: "unavailable" as const,
              reason:
                "The Dokkabi gateway is not currently bound; an explicit Send resumes the recorded binding.",
            };
          }
          return yield* Effect.fail(readOutcome.error);
        }
        const read = readOutcome.read;
        const previousSession = owner.sessionCursor;
        const previousGateway = owner.gatewayCursor;
        const generation = previousSession?.generation ?? owner.observedGeneration;
        const changed =
          read.sessionCursor.sessionId !== owner.sessionId ||
          (generation !== undefined && read.sessionCursor.generation !== generation) ||
          (previousGateway !== undefined &&
            read.gatewayCursor.generation !== previousGateway.generation) ||
          (previousSession !== undefined &&
            (read.sessionCursor.seq < previousSession.seq ||
              (read.sessionCursor.seq === previousSession.seq &&
                read.sessionCursor.hash !== previousSession.hash))) ||
          (previousGateway !== undefined &&
            (read.gatewayCursor.seq < previousGateway.seq ||
              (read.gatewayCursor.seq === previousGateway.seq &&
                read.gatewayCursor.hash !== previousGateway.hash))) ||
          (previousSession !== undefined && previousGateway !== undefined && read.resnapshot);
        if (changed)
          return yield* failRequest(
            method,
            "The recorded session or gateway prefix changed; mode selection cannot cross a replaced source.",
          );
        const invalidTime =
          read.cards.some((card) => !isValidRecordedTime(card.ts)) ||
          read.commands.some(
            (command) =>
              (command.sources?.["turnStart"] !== undefined &&
                !isValidRecordedTime(sourceTimeString(command.sources?.["turnStartAt"]))) ||
              (["handed_off", "accepted", "settled"].includes(command.state) &&
                (typeof command.sources?.["turnStart"] !== "number" ||
                  !isValidRecordedTime(sourceTimeString(command.sources?.["turnStartAt"])))) ||
              (command.state === "settled" &&
                !isValidRecordedTime(sourceTimeString(command.sources?.["settlementAt"]))),
          );
        if (invalidTime)
          return yield* failRequest(
            method,
            "The current source has unverified recorded times; mode selection remains read-only.",
          );
        return { ok: true as const, read };
      });

    /** Map a wire refusal/error outcome onto the action-result vocabulary. */
    const workModeActionRefusal = (
      detail: string,
    ): { state: "unsupported" | "unavailable"; reason: string } | undefined => {
      const refusal = workModeReadRefusal(detail);
      if (refusal === undefined) return undefined;
      return { state: refusal.status, reason: refusal.reason };
    };

    /**
     * R8-06j2 read-only work mode. Effect-free: no bind, no recovery, no
     * model call, no cursor advance, no event append. Reports the host's
     * actual configuration snapshot — never an execution truth verdict.
     */
    const readWorkbenchWorkMode = (
      threadId: ThreadId,
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchWorkModeResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const owner = resolveWorkbenchOwner(threadId, persistedResumeCursor);
        if (!owner.ok) {
          if (owner.kind === "error") return yield* Effect.fail(owner.error);
          return { status: "unavailable" as const, reason: owner.reason };
        }
        if (!config.enabled || configFailure !== undefined) {
          return {
            status: "unavailable" as const,
            reason: configFailure ?? "The Dokkabi provider is disabled.",
          };
        }
        // The app never calls an unsupported method: a live handshake that
        // reported no capability short-circuits before any wire call, and
        // the persisted-only path resolves the same fact through ONE
        // read-only preflight handshake.
        if (owner.workModeCapability !== false) {
          const preflight = yield* workModePreflight(owner);
          if (!preflight.ok) {
            return { status: preflight.state, reason: preflight.reason };
          }
        } else if (owner.workModeCapability === false) {
          return {
            status: "unsupported" as const,
            reason:
              "This Dokkabi gateway reported no work mode capability at handshake; its session work mode cannot be read.",
          };
        }
        const outcome = yield* callRouted(
          owner.childRoute,
          "workbench.workMode",
          { version: 1, binding: owner.binding, operation: "read" },
          WorkModeSchema,
        ).pipe(
          Effect.map((result): { ok: true; result: WorkModeResult } => ({ ok: true, result })),
          Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        );
        if (!outcome.ok) {
          const refusal = workModeReadRefusal(errorDetail(outcome.error));
          if (refusal !== undefined) return refusal;
          return yield* Effect.fail(outcome.error);
        }
        const response = outcome.result;
        if (response.state === "available") {
          return {
            status: "available" as const,
            selection: response.selection,
            busy: response.busy,
          };
        }
        // The read envelope's own documented refusal states pass through
        // with their reasons; anything else (an applied receipt, a set-time
        // refusal vocabulary) is a contract violation, never an invented mode.
        if (response.state === "unavailable" || response.state === "unsupported") {
          return { status: response.state, reason: response.reason };
        }
        return yield* failRequest(
          "workbench.workMode",
          `The gateway answered a work-mode read with state '${response.state}'; a read carries only the available snapshot.`,
        );
      }).pipe(
        // A read has no effects, so a lost transport collapses into a visible
        // typed process error; the poll keeps the last view.
        Effect.mapError(collapseLost("workbench.workMode", threadId)),
      );

    /** One raw work-mode operation call under the resolved owner. */
    const callWorkMode = (
      owner: {
        readonly binding: { clientId: string; threadId: string };
        readonly childRoute: ChildRoute | undefined;
      },
      params:
        | {
            readonly operation: "set";
            readonly commandId: string;
            readonly expectedRevision: string;
            readonly mode: "default" | "chat" | "work";
          }
        | { readonly operation: "status"; readonly commandId: string },
    ) =>
      callRouted(
        owner.childRoute,
        "workbench.workMode",
        { version: 1, binding: owner.binding, ...params },
        WorkModeSchema,
      );

    /** Map a decoded wire envelope onto the facade's action result. */
    const toWorkModeActionResult = (
      response: WorkModeResult,
    ): ProviderWorkbenchWorkModeActionResult => {
      if (response.state === "available") {
        // A mutation answered with the read envelope: contract violation.
        return {
          state: "unknown",
          reason:
            "The gateway answered the work-mode operation with a read snapshot; nothing was inferred from it.",
        };
      }
      if (response.state === "applied") {
        return {
          state: "applied",
          commandId: response.commandId,
          selection: response.selection,
          duplicate: response.duplicate,
        };
      }
      return {
        state: response.state,
        ...(response.reason !== undefined ? { reason: response.reason } : {}),
        ...(response.commandId !== undefined ? { commandId: response.commandId } : {}),
      };
    };

    /**
     * R8-06j2 one explicit work-mode selection. Serialized with the adapter's
     * single mutation chain; the host owns busy/refusal, and a transport loss
     * is reconciled ONLY through read-only same-id status — never a re-send.
     */
    const setWorkbenchWorkMode = (
      threadId: ThreadId,
      input: {
        readonly commandId: string;
        readonly expectedRevision: string;
        readonly mode: "default" | "chat" | "work";
      },
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchWorkModeActionResult, DokkabiAdapterError> =>
      withForegroundGate(
        Effect.gen(function* () {
          const owner = resolveWorkbenchOwner(threadId, persistedResumeCursor);
          if (!owner.ok) {
            if (owner.kind === "error") return yield* Effect.fail(owner.error);
            return { state: "unavailable" as const, reason: owner.reason };
          }
          if (!config.enabled || configFailure !== undefined) {
            return {
              state: "unavailable" as const,
              reason: configFailure ?? "The Dokkabi provider is disabled.",
            };
          }
          if (owner.workModeCapability !== false) {
            const preflight = yield* workModePreflight(owner);
            if (!preflight.ok) {
              return { state: preflight.state, reason: preflight.reason };
            }
          } else if (owner.workModeCapability === false) {
            return {
              state: "unsupported" as const,
              reason:
                "This Dokkabi gateway reported no work mode capability at handshake; selections cannot be recorded.",
            };
          }
          const selected = yield* callWorkMode(owner, {
            operation: "set",
            commandId: input.commandId,
            expectedRevision: input.expectedRevision,
            mode: input.mode,
          }).pipe(
            Effect.map((result): { ok: true; result: WorkModeResult } => ({ ok: true, result })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (selected.ok) {
            if (
              selected.result.state === "applied" &&
              selected.result.commandId !== input.commandId
            ) {
              return yield* failRequest(
                "workbench.workMode",
                `The gateway answered command '${selected.result.commandId}' for a work-mode set of '${input.commandId}'.`,
              );
            }
            if (
              selected.result.state === "applied" &&
              selected.result.selection.mode !== input.mode
            ) {
              return {
                state: "unknown" as const,
                commandId: input.commandId,
                reason:
                  "The receipt names a different selection; the requested outcome remains unconfirmed.",
              };
            }
            return toWorkModeActionResult(selected.result);
          }
          const detail = errorDetail(selected.error);
          const refusal = workModeActionRefusal(detail);
          if (refusal !== undefined) return refusal;
          if (isTransportLost(selected.error)) {
            // Reconcile through the read-only same-id status; never
            // re-send, and never borrow ANOTHER command's receipt.
            const statusOption = yield* Effect.option(
              Effect.gen(function* () {
                const source = yield* workModePreflight(owner);
                if (!source.ok) return yield* failRequest("workbench.workMode", source.reason);
                return yield* callWorkMode(owner, {
                  operation: "status",
                  commandId: input.commandId,
                });
              }),
            );
            if (
              Option.isSome(statusOption) &&
              statusOption.value.state === "applied" &&
              statusOption.value.commandId === input.commandId &&
              statusOption.value.selection.mode === input.mode
            ) {
              return toWorkModeActionResult(statusOption.value);
            }
            return {
              state: "unknown" as const,
              reason:
                "The selection's outcome is uncertain (transport lost before the response); it was NOT re-sent. An explicit status can reconcile it.",
              commandId: input.commandId,
            };
          }
          return yield* Effect.fail(selected.error);
        }),
      ).pipe(Effect.mapError(collapseLost("workbench.workMode", threadId)));

    /**
     * R8-06j2 read-only status reconstruction of one work-mode command. Never
     * applies, retries or boots anything; an unknown id stays unknown.
     */
    const workbenchWorkModeStatus = (
      threadId: ThreadId,
      commandId: string,
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchWorkModeActionResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const owner = resolveWorkbenchOwner(threadId, persistedResumeCursor);
        if (!owner.ok) {
          if (owner.kind === "error") return yield* Effect.fail(owner.error);
          return { state: "unavailable" as const, reason: owner.reason };
        }
        if (!config.enabled || configFailure !== undefined) {
          return {
            state: "unavailable" as const,
            reason: configFailure ?? "The Dokkabi provider is disabled.",
          };
        }
        if (owner.workModeCapability !== false) {
          const preflight = yield* workModePreflight(owner);
          if (!preflight.ok) {
            return { state: preflight.state, reason: preflight.reason };
          }
        } else if (owner.workModeCapability === false) {
          return {
            state: "unsupported" as const,
            reason:
              "This Dokkabi gateway reported no work mode capability at handshake; command outcomes cannot be reconstructed.",
          };
        }
        const outcome = yield* callWorkMode(owner, {
          operation: "status",
          commandId,
        }).pipe(
          Effect.map((result): { ok: true; result: WorkModeResult } => ({ ok: true, result })),
          Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        );
        if (!outcome.ok) {
          const refusal = workModeActionRefusal(errorDetail(outcome.error));
          if (refusal !== undefined) return refusal;
          return yield* Effect.fail(outcome.error);
        }
        if (outcome.result.state === "applied" && outcome.result.commandId !== commandId) {
          return yield* failRequest(
            "workbench.workMode",
            `The gateway answered command '${outcome.result.commandId}' for a status of '${commandId}'.`,
          );
        }
        return toWorkModeActionResult(outcome.result);
      }).pipe(Effect.mapError(collapseLost("workbench.workMode", threadId)));

    // --- R8 decisions and prepared branches ---

    /**
     * Shared owner resolution for decision operations: the live parent
     * thread state, else the validated persisted resume cursor — never an
     * arbitrary caller's. A thread that is itself a recorded prepared child
     * exposes no decision surface (the child envelope is chat-only).
     */
    const resolveDecisionOwner = (
      threadId: ThreadId,
      persistedResumeCursor: unknown,
    ):
      | {
          readonly ok: true;
          readonly binding: { clientId: string; threadId: string };
          readonly sessionId: string;
          readonly sessionCursor: WorkbenchSessionCursor | undefined;
          readonly gatewayCursor: WorkbenchCursor | undefined;
          readonly observedGeneration: string | undefined;
          readonly liveModel: string | undefined;
        }
      | {
          readonly ok: false;
          readonly kind: "unavailable" | "child" | "malformed";
          readonly reason: string;
        }
      | { readonly ok: false; readonly kind: "error"; readonly error: DokkabiAdapterError } => {
      const liveState = threads.get(threadId);
      if (liveState !== undefined) {
        if (liveState.childOf !== undefined) {
          return {
            ok: false,
            kind: "child",
            reason:
              "A prepared child conversation exposes no decision surface; decisions belong to its parent.",
          };
        }
        return {
          ok: true,
          binding: { clientId: liveState.clientId, threadId: liveState.threadId },
          sessionId: liveState.sessionId,
          sessionCursor: liveState.sessionCursor,
          gatewayCursor: liveState.gatewayCursor,
          observedGeneration: liveState.generation !== "genesis" ? liveState.generation : undefined,
          liveModel: liveState.model,
        };
      }
      if (persistedResumeCursor === undefined || persistedResumeCursor === null) {
        return {
          ok: false,
          kind: "unavailable",
          reason:
            "No live workbench session is bound to this thread; an explicit Send binds it and its recorded decisions become reachable.",
        };
      }
      const parsed = parseResumeState(persistedResumeCursor);
      if (!parsed.ok) {
        return {
          ok: false,
          kind: "error",
          error: new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method: "workbench.decisions",
            detail: `Refusing persisted resume state for thread ${threadId}: ${parsed.reason}.`,
          }),
        };
      }
      if (parsed.value.binding.clientId !== clientId) {
        return {
          ok: false,
          kind: "error",
          error: new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method: "workbench.decisions",
            detail: `Persisted workbench state belongs to client '${parsed.value.binding.clientId}'; this instance is '${clientId}'.`,
          }),
        };
      }
      if (parsed.value.binding.threadId !== threadId) {
        return {
          ok: false,
          kind: "error",
          error: new ProviderAdapterRequestError({
            provider: DOKKABI_DRIVER_KIND,
            method: "workbench.decisions",
            detail: `Persisted workbench state belongs to thread '${parsed.value.binding.threadId}'; this thread is '${threadId}'.`,
          }),
        };
      }
      if (parsed.value.child !== undefined) {
        return {
          ok: false,
          kind: "child",
          reason:
            "A prepared child conversation exposes no decision surface; decisions belong to its parent.",
        };
      }
      return {
        ok: true,
        binding: parsed.value.binding,
        sessionId: parsed.value.sessionId,
        sessionCursor: parsed.value.sessionCursor,
        gatewayCursor: parsed.value.gatewayCursor,
        observedGeneration: undefined,
        liveModel: undefined,
      };
    };

    /** The snapshot a wire envelope carries, when it carries one. */
    const decisionOf = (response: DecisionResult) =>
      response.state === "unsupported" ? undefined : response.decision;

    /** The closed reason a wire envelope carries, when it carries one. */
    const reasonOf = (response: DecisionResult): string | undefined =>
      response.state === "ready" ? undefined : response.reason;

    /** Map a decoded wire envelope onto the facade's action result. */
    const toActionResult = (response: DecisionResult): ProviderWorkbenchDecisionActionResult => {
      if (response.state === "unsupported") {
        return { state: "unsupported", reason: response.reason };
      }
      if (response.state === "ready") {
        return {
          state: "ready",
          ...(response.decision !== undefined ? { decision: response.decision } : {}),
          child: response.child,
        };
      }
      return {
        state: response.state,
        ...(response.reason !== undefined ? { reason: response.reason } : {}),
        ...(response.decision !== undefined ? { decision: response.decision } : {}),
      };
    };

    /** Shared identity/continuity validation for decision envelope reads. */
    const validateDecisionSource = (
      method: string,
      threadId: ThreadId,
      owner: {
        readonly sessionId: string;
        readonly sessionCursor: WorkbenchSessionCursor | undefined;
        readonly gatewayCursor: WorkbenchCursor | undefined;
        readonly observedGeneration: string | undefined;
      },
      head: {
        readonly sessionCursor: WorkbenchSessionCursor;
        readonly gatewayCursor: WorkbenchCursor;
      },
    ): Effect.Effect<void, DokkabiAdapterError> => {
      if (head.sessionCursor.sessionId !== owner.sessionId) {
        return failRequest(
          method,
          `The decision view names session '${head.sessionCursor.sessionId}' but this thread is bound to '${owner.sessionId}'.`,
        );
      }
      const knownSessionGeneration = owner.sessionCursor?.generation ?? owner.observedGeneration;
      if (
        knownSessionGeneration !== undefined &&
        head.sessionCursor.generation !== knownSessionGeneration
      ) {
        return failRequest(
          method,
          `The recorded session source was replaced (generation ${head.sessionCursor.generation.slice(0, 12)}…, expected ${knownSessionGeneration.slice(0, 12)}…); a replaced source is never spliced onto this thread's decisions.`,
        );
      }
      if (
        owner.gatewayCursor?.generation !== undefined &&
        head.gatewayCursor.generation !== owner.gatewayCursor.generation
      ) {
        return failRequest(
          method,
          "The gateway's durable ledger was replaced; its decisions can no longer be correlated with this thread's validated cursors.",
        );
      }
      if (owner.sessionCursor !== undefined && head.sessionCursor.seq < owner.sessionCursor.seq) {
        return failRequest(
          method,
          `The session head rewound (seq ${head.sessionCursor.seq} after ${owner.sessionCursor.seq}).`,
        );
      }
      if (
        owner.sessionCursor !== undefined &&
        head.sessionCursor.seq === owner.sessionCursor.seq &&
        head.sessionCursor.hash !== owner.sessionCursor.hash
      ) {
        return failRequest(
          method,
          "The session head hash changed at the same sequence; its decisions cannot be correlated with this thread's validated source.",
        );
      }
      if (
        owner.gatewayCursor !== undefined &&
        (head.gatewayCursor.seq < owner.gatewayCursor.seq ||
          (head.gatewayCursor.seq === owner.gatewayCursor.seq &&
            head.gatewayCursor.hash !== owner.gatewayCursor.hash))
      ) {
        return failRequest(
          method,
          "The gateway head rewound or its hash changed at the same sequence; its decisions cannot be correlated with this thread's validated source.",
        );
      }
      return Effect.void;
    };

    /**
     * R8 read-only recorded decisions. Same source-boundary rules as the
     * other reads: no recovery, no bind, no model effect, no cursor advance.
     * The wire's own view states pass through unchanged — missing (no
     * decision rows), invalid (retained authority refused) and available are
     * distinct facts, never collapsed into an empty success.
     */
    const readWorkbenchDecisions = (
      threadId: ThreadId,
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchDecisionsResult, DokkabiAdapterError> =>
      Effect.gen(function* () {
        const owner = resolveDecisionOwner(threadId, persistedResumeCursor);
        if (!owner.ok) {
          if (owner.kind === "error") return yield* Effect.fail(owner.error);
          if (owner.kind === "child")
            return { status: "unsupported" as const, reason: owner.reason };
          return { status: "unavailable" as const, reason: owner.reason };
        }
        if (!config.enabled || configFailure !== undefined) {
          return {
            status: "unavailable" as const,
            reason: configFailure ?? "The Dokkabi provider is disabled.",
          };
        }
        const outcome = yield* call(
          "workbench.decisions",
          { version: 1, binding: owner.binding },
          DecisionsSchema,
        ).pipe(
          Effect.map((result): { ok: true; result: DecisionsResult } => ({ ok: true, result })),
          Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        );
        if (!outcome.ok) {
          const detail = errorDetail(outcome.error);
          if (/no workbench binding/i.test(detail)) {
            return {
              status: "unavailable" as const,
              reason:
                "The Dokkabi gateway is not currently bound; an explicit Send resumes the binding and the recorded decisions.",
            };
          }
          if (isMissingMethod("workbench.decisions", detail)) {
            return {
              status: "unsupported" as const,
              reason:
                "The Dokkabi gateway does not implement workbench.decisions (older than the R8 protocol); its recorded decisions cannot be read.",
            };
          }
          return yield* Effect.fail(outcome.error);
        }
        const view = outcome.result;
        yield* validateDecisionSource("workbench.decisions", threadId, owner, view);
        if (view.state === "available") {
          return {
            status: "available" as const,
            decisions: view.decisions,
            total: view.total,
            omitted: view.omitted,
            executionSupported: view.execution.supported,
          };
        }
        return {
          status: view.state,
          reason: view.reason,
          total: view.total,
          omitted: view.omitted,
          executionSupported: view.execution.supported,
        };
      }).pipe(Effect.mapError(collapseLost("workbench.decisions", threadId)));

    /**
     * One `workbench.decision` status read for one decision id under the
     * owner binding. The gateway answers unknown decisions with the closed
     * `unknown`/`branch_decision_unknown` envelope — never an error — so a
     * missing decision is distinguishable from an uncertain mutation.
     */
    const decisionStatus = (
      binding: { clientId: string; threadId: string },
      id: string,
    ): Effect.Effect<DecisionResult, DokkabiAdapterError | WorkbenchTransportLost> =>
      call("workbench.decision", { version: 1, binding, operation: "status", id }, DecisionSchema);

    /**
     * R8 decision creation. The definition carries only the operator's
     * immutable question/options/recommendation/rationale: the adapter
     * derives the stable command and checkpoint ids from the definition
     * content, captures a FRESH compatible checkpoint at the thread's actual
     * current read cursor (a moved source head refuses — never a hidden
     * recapture), and opens the definition with the returned real digest. An
     * exact duplicate recovers the recorded decision with zero new effects.
     */
    const createWorkbenchDecision = (
      threadId: ThreadId,
      definition: ProviderWorkbenchDecisionDefinition,
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchDecisionActionResult, DokkabiAdapterError> =>
      withForegroundGate(
        Effect.gen(function* () {
          const owner = resolveDecisionOwner(threadId, persistedResumeCursor);
          if (!owner.ok) {
            if (owner.kind === "error") return yield* Effect.fail(owner.error);
            return yield* failRequest("workbench.decision.open", owner.reason);
          }
          if (!config.enabled || configFailure !== undefined) {
            return yield* failRequest(
              "workbench.decision.open",
              configFailure ?? "The Dokkabi provider is disabled.",
            );
          }
          // Exact-duplicate recovery: a recorded decision for this id
          // answers with its snapshot and nothing new is captured.
          const existingOption = yield* Effect.option(decisionStatus(owner.binding, definition.id));
          if (Option.isSome(existingOption)) {
            const existing = existingOption.value;
            const existingDecision = decisionOf(existing);
            if (!(existing.state === "unknown" && existing.reason === "branch_decision_unknown")) {
              if (existingDecision !== undefined && existingDecision.id !== definition.id) {
                return yield* failRequest(
                  "workbench.decision.open",
                  `The gateway answered decision '${existingDecision.id}' for an open of '${definition.id}'.`,
                );
              }
              return toActionResult(existing);
            }
          }
          // The exact current read cursor anchors the capture.
          let cursor = owner.sessionCursor;
          if (cursor === undefined) {
            const read = yield* call(
              "workbench.read",
              { version: 1, binding: owner.binding },
              ReadSchema,
            );
            if (read.sessionCursor.sessionId !== owner.sessionId) {
              return yield* failRequest(
                "workbench.decision.open",
                `The current read names session '${read.sessionCursor.sessionId}' but this thread is bound to '${owner.sessionId}'.`,
              );
            }
            cursor = read.sessionCursor;
          }
          // Deterministic stable command identity from the definition
          // content: the same retry derives the same ids, a changed
          // definition under the same decision id conflicts at the host.
          const commandId = `decision-open-${sha256Hex(
            JSON.stringify([
              definition.id,
              definition.question,
              definition.options,
              definition.recommendation,
              definition.rationale,
            ]),
          ).slice(0, 40)}`;
          const checkpointId = `cp-${sha256Hex(commandId).slice(0, 40)}`;
          const captureOutcome = yield* call(
            "workbench.checkpoint",
            {
              version: 1,
              binding: owner.binding,
              operation: "create",
              id: checkpointId,
              expectedSource: { seq: cursor.seq, hash: cursor.hash },
            },
            CheckpointSchema,
          ).pipe(
            Effect.map((result): { ok: true; result: CheckpointResult } => ({
              ok: true,
              result,
            })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (!captureOutcome.ok) {
            const detail = errorDetail(captureOutcome.error);
            if (isMissingMethod("workbench.checkpoint", detail)) {
              return {
                state: "unsupported" as const,
                reason:
                  "The Dokkabi gateway does not implement workbench.checkpoint (older than the R7 protocol); a compatible checkpoint cannot be captured.",
              };
            }
            if (isTransportLost(captureOutcome.error)) {
              return {
                state: "unknown" as const,
                reason:
                  "The checkpoint capture's outcome is uncertain (transport lost before the response); it was NOT retried. An explicit status can reconcile it.",
              };
            }
            // A moved source head (CAS) or unsettled session refuses —
            // never a hidden recapture under the same id.
            return yield* Effect.fail(captureOutcome.error);
          }
          const capture = captureOutcome.result;
          if (capture.state === "unsupported") {
            return { state: "unsupported" as const, reason: capture.reason };
          }
          if (capture.source.seq !== cursor.seq || capture.source.hash !== cursor.hash) {
            return yield* failRequest(
              "workbench.decision.open",
              `The captured checkpoint bound source seq ${capture.source.seq} but the exact current cursor is seq ${cursor.seq}; a mismatched capture is never opened.`,
            );
          }
          const opened = yield* call(
            "workbench.decision",
            {
              version: 1,
              binding: owner.binding,
              operation: "open",
              definition: {
                id: definition.id,
                commandId,
                kind: "branch",
                checkpointId,
                checkpointDigest: capture.digest,
                question: definition.question,
                options: definition.options,
                recommendation: definition.recommendation,
                rationale: definition.rationale,
              },
            },
            DecisionSchema,
          );
          const result = toActionResult(opened);
          const openedDecision = decisionOf(opened);
          if (
            openedDecision !== undefined &&
            (opened.state === "available" || opened.state === "ready") &&
            openedDecision.id !== definition.id
          ) {
            return yield* failRequest(
              "workbench.decision.open",
              `The gateway answered decision '${openedDecision.id}' for an open of '${definition.id}'.`,
            );
          }
          return result;
        }),
      ).pipe(Effect.mapError(collapseLost("workbench.decision.open", threadId)));

    /**
     * R8 explicit option selection under an expected revision. A transport
     * loss is reconciled through status — never a blind re-send.
     */
    const selectWorkbenchDecision = (
      threadId: ThreadId,
      input: {
        readonly id: string;
        readonly commandId: string;
        readonly expectedRevision: number;
        readonly option: string;
      },
      persistedResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchDecisionActionResult, DokkabiAdapterError> =>
      withForegroundGate(
        Effect.gen(function* () {
          const owner = resolveDecisionOwner(threadId, persistedResumeCursor);
          if (!owner.ok) {
            if (owner.kind === "error") return yield* Effect.fail(owner.error);
            return yield* failRequest("workbench.decision.select", owner.reason);
          }
          if (!config.enabled || configFailure !== undefined) {
            return yield* failRequest(
              "workbench.decision.select",
              configFailure ?? "The Dokkabi provider is disabled.",
            );
          }
          const selected = yield* call(
            "workbench.decision",
            {
              version: 1,
              binding: owner.binding,
              operation: "select",
              id: input.id,
              commandId: input.commandId,
              expectedRevision: input.expectedRevision,
              option: input.option,
            },
            DecisionSchema,
          ).pipe(
            Effect.map((result): { ok: true; result: DecisionResult } => ({ ok: true, result })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (selected.ok) {
            const selectedDecision = decisionOf(selected.result);
            if (
              selected.result.state === "available" &&
              selectedDecision !== undefined &&
              selectedDecision.id !== input.id
            ) {
              return yield* failRequest(
                "workbench.decision.select",
                `The gateway answered decision '${selectedDecision.id}' for a select of '${input.id}'.`,
              );
            }
            return toActionResult(selected.result);
          }
          const detail = errorDetail(selected.error);
          if (isMissingMethod("workbench.decision", detail)) {
            return {
              state: "unsupported" as const,
              reason:
                "The Dokkabi gateway does not implement workbench.decision (older than the R8 protocol); selections cannot be recorded.",
            };
          }
          if (isTransportLost(selected.error)) {
            // Reconcile through the recorded state; never re-send.
            const statusOption = yield* Effect.option(decisionStatus(owner.binding, input.id));
            if (Option.isSome(statusOption) && decisionOf(statusOption.value) !== undefined) {
              return toActionResult(statusOption.value);
            }
            return {
              state: "unknown" as const,
              reason:
                "The selection's outcome is uncertain (transport lost before the response); it was NOT re-sent. An explicit status can reconcile it.",
            };
          }
          return yield* Effect.fail(selected.error);
        }),
      ).pipe(Effect.mapError(collapseLost("workbench.decision.select", threadId)));

    /**
     * Adopt one CONFIRMED prepared child: create its ThreadState bound to
     * the child session/workspace with the recorded parent envelope, then a
     * normal handshake/bind/read and session.started so existing ingestion
     * sets up the conversation. The child startup validates its exact
     * returned source — never the parent handshake or the configured parent
     * workspace — and the actual child handshake's permission mode and model
     * are checked against this app's support and the recorded parent
     * selection. MUST run under `gate`.
     */
    const adoptBranchChild = (input: {
      readonly descriptor: BranchDescriptorResult;
      readonly childThreadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly parentModel: string | undefined;
      /** The EXACT initiating owner binding the descriptor must name. */
      readonly expectedParentBinding: { readonly clientId: string; readonly threadId: string };
      /** The durable child binding's recorded session cursor, when adopting
       * from an existing durable target binding. */
      readonly durableSessionCursor?: WorkbenchSessionCursor | undefined;
    }): Effect.Effect<void, DokkabiAdapterError | WorkbenchTransportLost> =>
      Effect.gen(function* () {
        // FULL source identity validation BEFORE any wire effect and before
        // the already-adopted fast-return: parent client AND thread, child
        // binding, and the exact target thread. Child-id equality alone can
        // never bypass these comparisons.
        if (
          input.descriptor.parent.clientId !== input.expectedParentBinding.clientId ||
          input.descriptor.parent.threadId !== input.expectedParentBinding.threadId ||
          input.descriptor.binding.clientId !== input.expectedParentBinding.clientId ||
          input.descriptor.binding.threadId !== String(input.childThreadId)
        ) {
          return yield* failRequest(
            "workbench.decision.start",
            `The prepared child descriptor does not name the initiating owner binding (${input.expectedParentBinding.clientId}/${input.expectedParentBinding.threadId}) and target thread ${input.childThreadId}.`,
          );
        }
        if (input.descriptor.parent.clientId !== clientId) {
          return yield* failRequest(
            "workbench.decision.start",
            `The prepared child names parent client '${input.descriptor.parent.clientId}' but this instance is '${clientId}'.`,
          );
        }
        const existing = threads.get(input.childThreadId);
        if (existing !== undefined) {
          if (
            existing.childOf?.childId === input.descriptor.id &&
            existing.childOf.parentBinding.clientId === input.descriptor.parent.clientId &&
            existing.childOf.parentBinding.threadId === input.descriptor.parent.threadId &&
            existing.childOf.workspacePath === input.descriptor.workspacePath &&
            existing.sessionId === input.descriptor.sessionId
          ) {
            return;
          }
          return yield* failRequest(
            "workbench.decision.start",
            `Target thread ${input.childThreadId} already holds a Dokkabi workbench session; a prepared child never displaces it.`,
          );
        }
        const route: ChildRoute = {
          childId: input.descriptor.id,
          parentBinding: input.descriptor.parent,
          workspacePath: input.descriptor.workspacePath,
          parentModel: input.parentModel,
        };
        const identity = yield* handshake(route);
        if (identity.sessionId !== input.descriptor.sessionId) {
          return yield* failRequest(
            "workbench.decision.start",
            `The child gateway returned session '${identity.sessionId}' but the prepared child is recorded against session '${input.descriptor.sessionId}'; a child never falls back to another session.`,
          );
        }
        if (identity.permissionMode !== SUPPORTED_PERMISSION_MODE) {
          return yield* failRequest(
            "workbench.decision.start",
            `The child gateway runs permission mode '${identity.permissionMode}'. This app supports explicit full-access (bypass) harness workspaces only.`,
          );
        }
        if (
          input.parentModel !== undefined &&
          identity.model !== undefined &&
          identity.model !== input.parentModel
        ) {
          return yield* failRequest(
            "workbench.decision.start",
            `The child gateway boots model '${identity.model}' but this branch was prepared for model '${input.parentModel}'; the prepared child cannot silently switch models.`,
          );
        }
        // Keep a model persisted for subsequent exact child checks: when no
        // preparation-time model was captured (a reconcile adoption after a
        // lost first adoption), the trusted statement is the child's OWN
        // established handshake model — the host source-binds the child to
        // its recorded model. The parent's CURRENT model is never
        // substituted here.
        if (route.parentModel === undefined && identity.model !== undefined) {
          route.parentModel = identity.model;
        }
        const state: ThreadState = {
          threadId: input.childThreadId,
          clientId,
          sessionId: identity.sessionId,
          generation: "genesis",
          sessionCursor: undefined,
          gatewayCursor: undefined,
          activeCommandId: undefined,
          status: "ready",
          lastError: undefined,
          quarantined: undefined,
          sourceTimeRefusedFor: new Set(),
          runtimeMode: input.runtimeMode,
          model: identity.model,
          route: identity.route,
          workModeCapability: identity.capabilities.workMode ?? false,
          childOf: route,
          cards: new Map(),
          commands: new Map(),
          aliases: new Map(),
          turnStartsEmitted: new Set(),
          settledEmitted: new Set(),
          attentionEmitted: new Set(),
          approvalsOpened: new Set(),
          pollFiber: undefined,
          consecutiveReadFailures: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        const bound = yield* bindThread(state);
        if (bound.sessionId !== input.descriptor.sessionId) {
          return yield* failRequest(
            "workbench.decision.start",
            `The child gateway bound session '${bound.sessionId}' but the prepared child is recorded against session '${input.descriptor.sessionId}'.`,
          );
        }
        state.sessionId = bound.sessionId;
        const firstRead = yield* readOnce(state);
        // A durable child binding (restart/reconcile) pins the child source it
        // recorded: a replaced generation, another session or a rewound head
        // refuses BEFORE the child is registered, published or persisted — a
        // replaced child log is never adopted as if it were continuous.
        const durableCursor = input.durableSessionCursor;
        if (
          durableCursor !== undefined &&
          (firstRead.sessionCursor.sessionId !== durableCursor.sessionId ||
            firstRead.sessionCursor.generation !== durableCursor.generation ||
            firstRead.sessionCursor.seq < durableCursor.seq)
        ) {
          return yield* failRequest(
            "workbench.decision.start",
            `The prepared child's recorded source changed since its durable binding (session '${firstRead.sessionCursor.sessionId}', generation ${firstRead.sessionCursor.generation.slice(0, 12)}…, seq ${firstRead.sessionCursor.seq}; recorded '${durableCursor.sessionId}', ${durableCursor.generation.slice(0, 12)}…, seq ${durableCursor.seq}); a replaced child source is never adopted.`,
          );
        }
        state.generation = firstRead.sessionCursor.generation;
        threads.set(input.childThreadId, state);
        childWorkspaceRoots.set(input.childThreadId, route.workspacePath);
        // session.started is published BEFORE any historical item so
        // adoption replays into a live session view.
        yield* emit(sessionStarted(state, undefined));
        yield* projectRead(state, firstRead, false);
        yield* startPoller(state);
      });

    /** Complete branch-descriptor equality — every recorded field, so a
     * plausible child id can never substitute the current source. */
    const sameBranchDescriptor = (
      left: BranchDescriptorResult,
      right: BranchDescriptorResult,
    ): boolean =>
      left.id === right.id &&
      left.sessionId === right.sessionId &&
      left.workspacePath === right.workspacePath &&
      left.parent.clientId === right.parent.clientId &&
      left.parent.threadId === right.parent.threadId &&
      left.binding.clientId === right.binding.clientId &&
      left.binding.threadId === right.binding.threadId;

    /**
     * Explicit prepared-branch recovery after a genuine detach: reattach the
     * EXACT persisted parent through the NORMAL validated startup body
     * (client/thread ownership, configured workspace, permission policy,
     * resume session identity, persisted quarantine latch, bind and first
     * read with the normal source-mismatch quarantine). No Send, no model
     * call. The caller already holds `gate`, so the shared locked body runs
     * directly — the public startSession would re-enter the single permit.
     * A missing or invalid persisted parent is never fabricated: the shared
     * body refuses it. Transport loss leaves the bind outcome uncertain and
     * answers an explicit unknown; nothing is resent here. MUST run under
     * `gate`.
     */
    const reattachRecordedParent = (
      threadId: ThreadId,
      persistedResumeCursor: unknown,
      expectedSessionId: string,
    ): Effect.Effect<
      { readonly kind: "live" } | { readonly kind: "unknown"; readonly reason: string },
      DokkabiAdapterError
    > =>
      Effect.gen(function* () {
        const outcome = yield* startSessionLocked({
          threadId,
          provider: PROVIDER_KIND,
          providerInstanceId: config.instanceId,
          runtimeMode: REQUIRED_RUNTIME_MODE,
          resumeCursor: persistedResumeCursor,
        }).pipe(
          Effect.map(() => ({ ok: true as const })),
          Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        );
        if (!outcome.ok) {
          if (isTransportLost(outcome.error)) {
            return {
              kind: "unknown" as const,
              reason: `Reattaching the recorded parent conversation ${threadId} lost its transport before confirmation; the parent binding outcome is uncertain and no child was adopted.`,
            };
          }
          return yield* failRequest(
            "workbench.decision.start",
            `The recorded parent conversation ${threadId} could not be reattached through its normal validated startup (${errorDetail(outcome.error)}). No start was replayed and no child was adopted.`,
          );
        }
        const live = threads.get(threadId);
        if (live === undefined || live.childOf !== undefined) {
          return yield* failRequest(
            "workbench.decision.start",
            `The recorded parent conversation ${threadId} did not become a live parent after its normal startup. No start was replayed and no child was adopted.`,
          );
        }
        if (live.quarantined !== undefined) {
          // The normal startup's source check quarantined the parent: it stays
          // preserved read-only exactly as after any startup; nothing from the
          // replaced source authorizes a child adoption.
          return yield* failRequest(
            "workbench.decision.start",
            `${live.quarantined} The parent conversation ${threadId} stays preserved read-only. No start was replayed and no child was adopted.`,
          );
        }
        if (live.sessionId !== expectedSessionId) {
          return yield* failRequest(
            "workbench.decision.start",
            `The reattached parent bound session '${live.sessionId}' but its persisted binding names '${expectedSessionId}'. No start was replayed and no child was adopted.`,
          );
        }
        return { kind: "live" as const };
      });

    /**
     * R8 prepared-child start. The target app thread must already exist (the
     * normal thread-create operation created it; same project/instance/
     * runtime mode is validated by the facade). EVERY start reads the
     * decision's recorded status FIRST: a ready/reserved application is
     * reconciled without sending start again even when app binding
     * persistence or adoption previously failed; an admitted-but-unconfirmed
     * application stays unknown; only a fresh selected decision with no
     * previous application sends its FIRST start. Adoption from a status
     * answer requires the EXACT captured input — decision id, application
     * command, pre-admission revision and the requested target owner —
     * before any effect. An explicit reconcile of a validated durable child
     * whose parent holds no live transport here (a genuine detach) first
     * reattaches the EXACT persisted parent through the normal validated
     * startup, then follows the same status-first path; reads never do.
     */
    const startWorkbenchBranch = (
      threadId: ThreadId,
      input: {
        readonly id: string;
        readonly commandId: string;
        readonly expectedRevision: number;
        readonly childThreadId: ThreadId;
      },
      persistedResumeCursor?: unknown,
      targetResumeCursor?: unknown,
    ): Effect.Effect<ProviderWorkbenchDecisionActionResult, DokkabiAdapterError> =>
      withForegroundGate(
        Effect.gen(function* () {
          const owner = resolveDecisionOwner(threadId, persistedResumeCursor);
          if (!owner.ok) {
            if (owner.kind === "error") return yield* Effect.fail(owner.error);
            return yield* failRequest("workbench.decision.start", owner.reason);
          }
          if (!config.enabled || configFailure !== undefined) {
            return yield* failRequest(
              "workbench.decision.start",
              configFailure ?? "The Dokkabi provider is disabled.",
            );
          }
          if (!isWorkbenchId(String(input.childThreadId))) {
            return yield* failRequest(
              "workbench.decision.start",
              `Target thread id '${String(input.childThreadId)}' cannot travel the workbench id vocabulary.`,
            );
          }
          /**
           * Classify a recorded status answer against THIS captured input.
           * "confirmed" means the host's ready child is exactly this
           * attempt's outcome: same decision id, same application command,
           * admitted at this attempt's pre-admission revision (each
           * admitted action bumps the revision by one), and owned by the
           * initiating parent binding on the requested target thread.
           */
          const capturedStatusMatch = (
            status: DecisionResult,
          ):
            | { readonly kind: "confirmed"; readonly child: BranchDescriptorResult }
            | { readonly kind: "mismatch"; readonly reason: string }
            | { readonly kind: "unconfirmed"; readonly reason?: string } => {
            if (status.state !== "ready") {
              const unconfirmedReason = reasonOf(status);
              return unconfirmedReason === undefined
                ? { kind: "unconfirmed" as const }
                : { kind: "unconfirmed" as const, reason: unconfirmedReason };
            }
            const decision = decisionOf(status);
            if (decision === undefined) {
              return {
                kind: "mismatch",
                reason: "the ready answer carries no decision snapshot",
              };
            }
            if (decision.id !== input.id) {
              return {
                kind: "mismatch",
                reason: `the gateway answered decision '${decision.id}' for a start of '${input.id}'`,
              };
            }
            if (decision.application === null) {
              return {
                kind: "mismatch",
                reason: "the ready answer admits no application for this decision",
              };
            }
            if (decision.application.commandId !== input.commandId) {
              return {
                kind: "mismatch",
                reason: `the recorded application used command '${decision.application.commandId}' but this attempt captured '${input.commandId}'`,
              };
            }
            if (
              decision.state !== "application_pending" ||
              decision.revision !== input.expectedRevision + 1
            ) {
              return {
                kind: "mismatch",
                reason: `the recorded admission sits at revision ${decision.revision} (state '${decision.state}') but this attempt was captured before revision ${
                  input.expectedRevision + 1
                }`,
              };
            }
            if (
              status.child.parent.clientId !== owner.binding.clientId ||
              status.child.parent.threadId !== owner.binding.threadId
            ) {
              return {
                kind: "mismatch",
                reason: `the recorded child names parent '${status.child.parent.clientId}/${status.child.parent.threadId}' but this start initiates from '${owner.binding.clientId}/${owner.binding.threadId}'`,
              };
            }
            if (status.child.binding.threadId !== String(input.childThreadId)) {
              return {
                kind: "mismatch",
                reason: `the recorded child is bound to target thread '${status.child.binding.threadId}' but this attempt captured '${String(input.childThreadId)}'`,
              };
            }
            return { kind: "confirmed", child: status.child };
          };
          const unknownOutcome = (reason: string, status?: DecisionResult) => ({
            state: "unknown" as const,
            reason: `${reason} The reserved start was NOT re-sent and no thread was reallocated.`,
            ...(status !== undefined && decisionOf(status) !== undefined
              ? { decision: decisionOf(status) }
              : {}),
          });
          // Reconciliation of an EXISTING durable target binding (same
          // source/command retry after a confirmed adoption, or a restart):
          // the binding must be THIS parent's recorded child for THIS
          // exact target — validated server-side, fail closed. The
          // recorded status answers against the COMPLETE captured input;
          // the status child must equal the durable child's COMPLETE
          // descriptor, and adoption reuses the RECORDED parent model (a
          // later parent model change never retargets the pinned child).
          if (targetResumeCursor !== undefined && targetResumeCursor !== null) {
            const parsedTarget = parseResumeState(targetResumeCursor);
            if (!parsedTarget.ok || parsedTarget.value.child === undefined) {
              return yield* failRequest(
                "workbench.decision.start",
                `Refusing the existing binding on target thread ${input.childThreadId}: ${
                  parsedTarget.ok ? "it is not a recorded prepared child" : parsedTarget.reason
                }. No start was replayed.`,
              );
            }
            const durableChild = parsedTarget.value.child;
            if (
              parsedTarget.value.binding.clientId !== clientId ||
              durableChild.binding.threadId !== String(input.childThreadId) ||
              durableChild.parent.clientId !== owner.binding.clientId ||
              durableChild.parent.threadId !== owner.binding.threadId
            ) {
              return yield* failRequest(
                "workbench.decision.start",
                `The existing binding on target thread ${input.childThreadId} is not this parent's recorded child for this target. No start was replayed.`,
              );
            }
            const childNeedsAdoption = threads.get(input.childThreadId) === undefined;
            if (childNeedsAdoption && parsedTarget.value.sourceMismatch) {
              // The durable child carries the persisted source-mismatch
              // latch: exactly as its normal startup would, adoption
              // refuses instead of rebuilding a fresh view over it.
              return yield* failRequest(
                "workbench.decision.start",
                `The durable child on target thread ${input.childThreadId} records a replaced or truncated source; it stays preserved read-only. No start was replayed and no child was adopted.`,
              );
            }
            if (childNeedsAdoption && threads.get(threadId) === undefined) {
              // Explicit recovery after a genuine detach: the parent owner
              // resolved from its authenticated persisted binding holds no
              // live transport here. Only now — after the complete durable
              // child identity was validated and before the binding-gated
              // status read — the EXACT persisted parent re-enters the
              // normal validated startup. Reads never take this path.
              const reattached = yield* reattachRecordedParent(
                threadId,
                persistedResumeCursor,
                owner.sessionId,
              );
              if (reattached.kind === "unknown") {
                return unknownOutcome(reattached.reason);
              }
            }
            const statusOption = yield* Effect.option(decisionStatus(owner.binding, input.id));
            if (Option.isNone(statusOption)) {
              return unknownOutcome(
                "The recorded start state could not be read before any dispatch.",
              );
            }
            const status = statusOption.value;
            const match = capturedStatusMatch(status);
            if (match.kind !== "confirmed") {
              return unknownOutcome(
                match.kind === "mismatch"
                  ? `The recorded application does not match this attempt (${match.reason}).`
                  : (match.reason ?? "The recorded start is not confirmed for this attempt."),
                status,
              );
            }
            if (!sameBranchDescriptor(match.child, durableChild)) {
              // The current source never substitutes a plausible child id:
              // every durable field must still match the recorded child.
              return unknownOutcome(
                `The recorded child no longer equals the durable child binding on target thread ${input.childThreadId}.`,
                status,
              );
            }
            const live = threads.get(input.childThreadId);
            if (live !== undefined && live.childOf?.childId !== durableChild.id) {
              return yield* failRequest(
                "workbench.decision.start",
                `Target thread ${input.childThreadId} already holds a different Dokkabi workbench session; a prepared child never displaces it.`,
              );
            }
            if (live !== undefined) {
              // Already adopted: the recorded result, zero new effects.
              return toActionResult(status);
            }
            // Restart: adopt the confirmed recorded child as a fresh live
            // view (normal session.started; no start re-send) under the
            // RECORDED preparation model and the durable child source.
            yield* adoptBranchChild({
              descriptor: match.child,
              childThreadId: input.childThreadId,
              runtimeMode: REQUIRED_RUNTIME_MODE,
              parentModel: parsedTarget.value.parentModel,
              expectedParentBinding: owner.binding,
              durableSessionCursor: parsedTarget.value.sessionCursor,
            });
            return toActionResult(status);
          }
          // No durable target binding — status FIRST, before any dispatch:
          // a previously recorded application (even one whose app-side
          // adoption or persistence failed) answers from the recorded
          // state and the start is never re-sent.
          const statusOption = yield* Effect.option(decisionStatus(owner.binding, input.id));
          if (Option.isNone(statusOption)) {
            return unknownOutcome(
              "The decision's recorded state could not be read before this start; nothing was sent.",
            );
          }
          const status = statusOption.value;
          if (status.state === "unsupported") {
            return toActionResult(status);
          }
          if (status.state === "unknown" && status.reason === "branch_decision_unknown") {
            // The host definitively holds no such decision: a start would
            // have nothing to admit — a refusal, not an uncertain effect.
            return yield* failRequest(
              "workbench.decision.start",
              `The gateway holds no recorded decision '${input.id}' to start; open the decision first.`,
            );
          }
          if (status.state === "ready") {
            const match = capturedStatusMatch(status);
            if (match.kind === "confirmed") {
              // A previously admitted application for this EXACT captured
              // attempt: reconcile WITHOUT sending start again. No durable
              // recorded parent model exists on this path, so the pinned
              // child check uses the host's own handshake identity (the
              // child is source-bound to its recorded model) — the
              // parent's CURRENT model never rejects it here.
              const live = threads.get(input.childThreadId);
              if (live !== undefined && live.childOf?.childId !== match.child.id) {
                return yield* failRequest(
                  "workbench.decision.start",
                  `Target thread ${input.childThreadId} already holds a different Dokkabi workbench session; a prepared child never displaces it.`,
                );
              }
              if (live === undefined) {
                yield* adoptBranchChild({
                  descriptor: match.child,
                  childThreadId: input.childThreadId,
                  runtimeMode: REQUIRED_RUNTIME_MODE,
                  parentModel: undefined,
                  expectedParentBinding: owner.binding,
                });
              }
              return toActionResult(status);
            }
            // Ready for ANOTHER command or target: the recorded
            // application is authoritative; this input is not it.
            return unknownOutcome(
              match.kind === "mismatch"
                ? `The recorded application does not match this attempt (${match.reason}).`
                : "The recorded start is not confirmed for this attempt.",
              status,
            );
          }
          const recordedDecision = decisionOf(status);
          if (recordedDecision !== undefined) {
            if (recordedDecision.id !== input.id) {
              return yield* failRequest(
                "workbench.decision.start",
                `The gateway answered decision '${recordedDecision.id}' for a start of '${input.id}'.`,
              );
            }
            if (recordedDecision.application !== null) {
              // Admitted but unconfirmed: stays unknown — never re-sent.
              return unknownOutcome(
                "The recorded application is admitted but not confirmed for this attempt.",
                status,
              );
            }
            if (recordedDecision.state !== "selected") {
              return yield* failRequest(
                "workbench.decision.start",
                `Decision '${input.id}' is recorded as '${recordedDecision.state}'; an explicit selection must be recorded before a start.`,
              );
            }
            // A fresh selected decision with no previous application: the
            // FIRST start may be sent. The target must not already hold a
            // live session on this adapter — a prepared child never
            // displaces one.
            if (threads.get(input.childThreadId) !== undefined) {
              return yield* failRequest(
                "workbench.decision.start",
                `Target thread ${input.childThreadId} already holds a Dokkabi workbench session; a prepared child never displaces it.`,
              );
            }
          } else if (status.state !== "available") {
            return toActionResult(status);
          } else {
            // Available without the recorded snapshot: refusing instead of
            // sending a start whose recorded precondition cannot be read.
            return yield* failRequest(
              "workbench.decision.start",
              `The gateway did not return the recorded decision '${input.id}' for this start; refusing instead of guessing its state.`,
            );
          }
          // The recorded model policy is fixed at preparation from the
          // actual parent selection; the live parent state's model is that
          // selection, and a persisted owner's handshake reports the
          // operator's configured selection without a model call.
          const parentModel =
            owner.liveModel !== undefined
              ? owner.liveModel
              : (yield* Effect.option(handshake())).pipe(
                  Option.flatMap((identity) =>
                    identity.model !== undefined ? Option.some(identity.model) : Option.none(),
                  ),
                  Option.getOrUndefined,
                );
          const runtimeMode: RuntimeMode = REQUIRED_RUNTIME_MODE;
          const started = yield* call(
            "workbench.decision",
            {
              version: 1,
              binding: owner.binding,
              operation: "start",
              id: input.id,
              commandId: input.commandId,
              expectedRevision: input.expectedRevision,
              childThreadId: String(input.childThreadId),
            },
            DecisionSchema,
          ).pipe(
            Effect.map((result): { ok: true; result: DecisionResult } => ({ ok: true, result })),
            Effect.catch((error: DokkabiAdapterError | WorkbenchTransportLost) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (started.ok) {
            const result = started.result;
            if (result.state === "ready") {
              if (result.child.binding.threadId !== String(input.childThreadId)) {
                return yield* failRequest(
                  "workbench.decision.start",
                  `The prepared child names target thread '${result.child.binding.threadId}' but this start named '${String(input.childThreadId)}'.`,
                );
              }
              yield* adoptBranchChild({
                descriptor: result.child,
                childThreadId: input.childThreadId,
                runtimeMode,
                parentModel,
                expectedParentBinding: owner.binding,
              });
            }
            return toActionResult(result);
          }
          const detail = errorDetail(started.error);
          if (isMissingMethod("workbench.decision", detail)) {
            return {
              state: "unsupported" as const,
              reason:
                "The Dokkabi gateway does not implement workbench.decision (older than the R8 protocol); prepared children cannot start.",
            };
          }
          if (isTransportLost(started.error)) {
            // Lost acknowledgement: unknown, never re-sent or reallocated
            // automatically. A same-attempt status read may reconcile a
            // confirmed child — only for THIS captured input — without new
            // effects.
            const reconcileOption = yield* Effect.option(decisionStatus(owner.binding, input.id));
            if (Option.isSome(reconcileOption)) {
              const reconciled = reconcileOption.value;
              const match = capturedStatusMatch(reconciled);
              if (match.kind === "confirmed") {
                yield* adoptBranchChild({
                  descriptor: match.child,
                  childThreadId: input.childThreadId,
                  runtimeMode,
                  parentModel,
                  expectedParentBinding: owner.binding,
                });
                return toActionResult(reconciled);
              }
              return unknownOutcome(
                match.kind === "mismatch"
                  ? `The recorded application does not match this attempt (${match.reason}).`
                  : (match.reason ?? "The recorded start is not confirmed for this attempt."),
                reconciled,
              );
            }
            return {
              state: "unknown" as const,
              reason:
                "The branch start's outcome is uncertain (transport lost before the response); it was NOT re-sent and no thread was reallocated. An explicit status can reconcile a confirmed child.",
            };
          }
          return yield* Effect.fail(started.error);
        }),
      ).pipe(Effect.mapError(collapseLost("workbench.decision.start", threadId)));

    const detachThreadLocked = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = threads.get(threadId);
        if (state === undefined) return;
        // Stop the poller FIRST so no old-thread events follow the detach.
        yield* stopPoller(state);
        threads.delete(threadId);
        // Transport binding only: the kernel and any active turn keep
        // running; the same owner may rebind.
        yield* callDetach(state).pipe(Effect.catch(() => Effect.void));
        yield* emit(
          sessionExited(
            state,
            "Workbench transport binding released; the Dokkabi kernel keeps running.",
          ),
        );
      });

    const detachThread = (threadId: ThreadId): Effect.Effect<void> =>
      withForegroundGate(detachThreadLocked(threadId));

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const state = threads.get(threadId);
        if (state === undefined) {
          return yield* failRequest(
            "thread.read",
            `No Dokkabi workbench session is bound to thread ${threadId}.`,
          );
        }
        // Serves the adapter's PRESERVED projection, not a fresh read: during
        // a source-mismatch quarantine the replaced gateway log must never be
        // exposed as if it were a continuous view of this conversation. Turn
        // grouping still comes from the recorded command ranges — never FIFO
        // card guessing — and note cards carry the REAL recorded user text.
        const cardsBySeq = [...state.cards.entries()]
          .map(([seq, serialized]) => {
            void seq;
            const entry = JSON.parse(serialized) as { card: ReadResult["cards"][number] };
            return entry.card;
          })
          .sort((left, right) => left.seq - right.seq);
        const ordered = [...state.commands.values()]
          .filter((command) => command.startSeq !== undefined)
          .sort((left, right) => (left.startSeq ?? 0) - (right.startSeq ?? 0));
        const turns: ProviderThreadTurnSnapshot[] = [];
        const firstStart = ordered[0]?.startSeq;
        const leading = cardsBySeq.filter(
          (card) => firstStart === undefined || card.seq < firstStart,
        );
        if (leading.length > 0) {
          turns.push({
            id: TurnId.make(`dokkabi:${state.sessionId}:history`),
            items: leading,
          });
        }
        for (const command of ordered) {
          const items = cardsBySeq.filter(
            (card) =>
              card.seq >= (command.startSeq ?? 0) &&
              (command.endSeq === undefined || card.seq < command.endSeq),
          );
          if (items.length === 0) continue;
          turns.push({ id: turnIdFor(state, command), items });
        }
        return { threadId, turns } satisfies ProviderThreadSnapshot;
      });

    const unsupported = (method: string, reason: string) => failRequest(method, reason);

    // Scope finalization: stop pollers, emit exits, end the event queue,
    // detach every binding, close the transport. No kernel close, no cancel.
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* () {
        closing = true;
        const bound = [...threads.values()];
        threads.clear();
        for (const state of bound) {
          yield* stopPoller(state);
        }
        for (const state of bound) {
          yield* emit(
            sessionExited(
              state,
              "Adapter scope closed; workbench bindings released. The Dokkabi kernel keeps running.",
            ),
          );
        }
        yield* Queue.end(events);
        for (const state of bound) {
          yield* callDetach(state).pipe(Effect.catch(() => Effect.void));
        }
        transport?.close();
      }).pipe(Effect.ignore),
    );

    const adapter: ProviderAdapterShape<DokkabiAdapterError> = {
      provider: PROVIDER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported",
        supportsConversationRollback: false,
        workspaceLifecycle: "harness",
        // Deferred view of CURRENT roots: the configured parent root when
        // enabled, plus every CONFIRMED prepared-child workspace root (R8)
        // so the shared ownership policy protects child roots exactly like
        // the parent root. A disabled instance advertises no live roots.
        get workspaceRoots() {
          const roots = [
            ...(config.enabled && config.workspacePath.trim().length > 0
              ? [config.workspacePath]
              : []),
            ...childWorkspaceRoots.values(),
          ];
          return [...new Set(roots)];
        },
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () =>
        unsupported(
          "thread.approval.respond",
          "Approval responses are not part of the Dokkabi workbench protocol yet; resolve harness approvals through the harness surface.",
        ),
      respondToUserInput: () =>
        unsupported(
          "thread.user-input.respond",
          "Structured user input is not part of the Dokkabi workbench protocol yet.",
        ),
      stopSession: (threadId) => detachThread(threadId).pipe(Effect.asVoid),
      // Deferred view of CURRENT state — never a construction-time copy.
      listSessions: () => Effect.sync(() => [...threads.values()].map(sessionSnapshot)),
      hasSession: (threadId) => Effect.sync(() => threads.has(threadId)),
      readThread,
      readWorkbenchOverview,
      readWorkbenchGraph,
      readWorkbenchRecord,
      readWorkbenchRecordIndex,
      readWorkbenchRecordBody,
      verifyWorkbenchRecordBody,
      exploreWorkbenchGraph,
      readWorkbenchCode,
      workbenchCodeAction,
      readWorkbenchDecisions,
      readWorkbenchWorkMode,
      setWorkbenchWorkMode,
      workbenchWorkModeStatus,
      createWorkbenchDecision,
      selectWorkbenchDecision,
      startWorkbenchBranch,
      rollbackThread: () =>
        unsupported(
          "thread.rollback",
          "The Dokkabi harness owns recorded history; conversation rollback is not available.",
        ),
      stopAll: () =>
        withForegroundGate(
          Effect.suspend(() =>
            Effect.forEach([...threads.keys()], detachThreadLocked, { discard: true }),
          ),
        ),
      streamEvents: Stream.fromQueue(events),
    };
    return adapter;
  });
}
