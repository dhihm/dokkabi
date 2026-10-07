/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ProviderWorkbenchOverviewResult,
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
  ThreadId,
  WorkbenchGraphType,
  WorkbenchRecordAsOf,
  WorkbenchRecordBodyExpected,
  WorkbenchRecordCursor,
  WorkbenchGraphExploreQueryInput,
  WorkbenchGraphExploreSnapshot,
  WorkbenchWorkModeKind,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

/**
 * Who owns the workspace lifecycle for a session. "application" (the
 * default) means this app owns worktrees, checkpoints and background
 * mutations. "harness" means an external harness (e.g. Dokkabi) owns the
 * recorded workspace: the app must not run competing worktree, checkpoint,
 * terminal or file mutations for that workspace.
 */
export type ProviderWorkspaceLifecycle = "application" | "harness";

/**
 * How ProviderService runs manual context compaction for an adapter.
 * Native adapters expose a start call and must emit a compacted thread state
 * when they finish. Slash-command adapters get the command sent as a turn.
 */
export type ProviderCompaction<TError> =
  | {
      readonly type: "native";
      readonly start: (
        threadId: ThreadId,
        modelSelection?: ProviderSendTurnInput["modelSelection"],
      ) => Effect.Effect<void, TError>;
    }
  | { readonly type: "slash-command"; readonly command: `/${string}` };

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Starts a resumed turn with no synthetic user prompt. Omitted means the
      adapter needs an explicit continuation instruction. */
  readonly promptlessTurnContinuation?: boolean;
  /** False when native conversation history cannot be rewound. */
  readonly supportsConversationRollback?: boolean;
  /**
   * Workspace-lifecycle ownership for sessions of this adapter. Omitted
   * means "application". Harness-owned sessions gate the app's worktree,
   * checkpoint, terminal and editor mutations through the shared ownership
   * policy — never through scattered driver-name checks.
   */
  readonly workspaceLifecycle?: ProviderWorkspaceLifecycle;
  /**
   * Filesystem roots this adapter claims when enabled and its workspace
   * lifecycle is harness-owned (e.g. the Dokkabi gateway's configured
   * workspace). The shared ownership policy protects these paths BEFORE any
   * session starts. A disabled instance advertises no LIVE roots, but roots
   * admitted while it was enabled stay protected by the shared policy's
   * durable lease until a recorded release contract exists.
   */
  readonly workspaceRoots?: ReadonlyArray<string>;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Omitted when this adapter does not support manual context compaction. */
  readonly compaction?: ProviderCompaction<TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Read-only recorded workbench overview for a thread (Dokkabi R3). Omitted
   * when this adapter has no recorded-overview read capability — existing
   * providers stay unsupported by default. The read resolves the thread's
   * persisted resume cursor server-side: it triggers no recovery, bind or
   * model effects, and it never advances the transcript replay cursors.
   * Detached/unbound sources report `unavailable` (an explicit Send may
   * resume the binding); foreign instance/thread/source identities fail
   * closed as errors, never as empty success.
   *
   * The optional third argument (R8) adds the on-demand scoped usage read:
   * when `includeChildUsage` is true the result also carries `scopedUsage`,
   * the recorded run-scoped usage report (main prefix plus referenced
   * children) gathered by ONE read-only optional-method probe under the same
   * binding and cursors. Older gateways answer it as a typed unsupported
   * scoped result — never a fabricated zero-total success. The argument is
   * ignored by reads that do not ask for it, so existing callers are
   * unchanged.
   */
  readonly readWorkbenchOverview?: (
    threadId: ThreadId,
    persistedResumeCursor?: unknown,
    options?: { readonly includeChildUsage?: boolean | undefined },
  ) => Effect.Effect<ProviderWorkbenchOverviewResult, TError>;

  /**
   * Read-only recorded Work/Context graph for a thread (Dokkabi R4).
   * Omitted when this adapter has no recorded-graph read capability —
   * existing providers stay unsupported by default. The read resolves the
   * thread's persisted resume cursor server-side and validates the closed
   * graph payload against the returned source head: it triggers no
   * recovery, bind or model effects, and it never advances the transcript
   * replay cursors. Detached/unbound sources report `unavailable`; foreign
   * instance/thread/source identities fail closed as errors, never as
   * empty success.
   */
  readonly readWorkbenchGraph?: (
    threadId: ThreadId,
    graphType: WorkbenchGraphType,
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchGraphResult, TError>;

  /**
   * Read-only exact retained record page for a thread (Dokkabi R5).
   * Omitted when this adapter has no record read capability — existing
   * providers stay unsupported by default. The read resolves the thread's
   * persisted resume cursor server-side, pages ONE verified session prefix
   * under an immutable asOf pin, and re-verifies every row's canonical hash
   * and chain linkage before the page moves: it triggers no recovery, bind
   * or model effects, and it never advances the transcript replay cursors.
   * Detached/unbound sources report `unavailable`; older pre-R5 gateways and
   * other providers are unsupported; foreign instance/thread/source
   * identities and forged rows/cursors fail closed as errors, never as
   * empty success.
   */
  /** Owned retained-code read; no capture, binding recovery or model effects. */
  readonly readWorkbenchCode?: (
    threadId: ThreadId,
    page: Omit<ProviderGetWorkbenchCodeInput, "threadId">,
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchCodeResult, TError>;

  /** Explicit source-bound Code observer control; absent for unsupported providers. */
  readonly workbenchCodeAction?: (
    threadId: ThreadId,
    input: Omit<ProviderWorkbenchCodeActionInput, "threadId">,
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchCodeActionResult, TError>;

  readonly readWorkbenchRecord?: (
    threadId: ThreadId,
    page: {
      readonly after?: WorkbenchRecordCursor | undefined;
      readonly asOf?: WorkbenchRecordAsOf | undefined;
      readonly limit?: number | undefined;
    },
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchRecordResult, TError>;

  /**
   * Bounded explorer reads (optional; omitted adapters stay unsupported).
   * Same source boundary as readWorkbenchRecord/readWorkbenchGraph: the
   * persisted resume cursor resolves the owner server-side (child routing
   * included), no recovery, bind or model effects, no transcript cursor
   * advance. The record index carries exact metadata only; a body read
   * returns one canonical byte range bound to its row cursor, pin and the
   * index descriptor; the verification streams every range and earns
   * "exact" only from the assembled digest AND the canonical row hash; the
   * graph explorer returns one bounded page of the full projection pinned
   * by a snapshot digest (stale is explicit). Older gateways report
   * unsupported; malformed or foreign data fails closed as an error.
   */
  readonly readWorkbenchRecordIndex?: (
    threadId: ThreadId,
    page: {
      readonly after?: WorkbenchRecordCursor | undefined;
      readonly asOf?: WorkbenchRecordAsOf | undefined;
      readonly limit?: number | undefined;
    },
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchRecordIndexResult, TError>;

  readonly readWorkbenchRecordBody?: (
    threadId: ThreadId,
    range: {
      readonly row: WorkbenchRecordCursor;
      readonly asOf: WorkbenchRecordAsOf;
      readonly offset: number;
      readonly limit?: number | undefined;
      readonly expected?: WorkbenchRecordBodyExpected | undefined;
    },
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchRecordBodyResult, TError>;

  readonly verifyWorkbenchRecordBody?: (
    threadId: ThreadId,
    target: {
      readonly row: WorkbenchRecordCursor;
      readonly asOf: WorkbenchRecordAsOf;
      readonly expected: WorkbenchRecordBodyExpected;
    },
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchRecordVerificationResult, TError>;

  readonly exploreWorkbenchGraph?: (
    threadId: ThreadId,
    input: {
      readonly graphType: WorkbenchGraphType;
      readonly query: WorkbenchGraphExploreQueryInput;
      readonly snapshot?: WorkbenchGraphExploreSnapshot | undefined;
    },
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchGraphExploreResult, TError>;

  /**
   * Read-only recorded decisions for a thread (Dokkabi R8). Omitted when
   * this adapter has no decisions read capability — existing providers stay
   * unsupported by default. The read resolves the thread's persisted resume
   * cursor server-side: no recovery, bind or model effects, and the
   * transcript replay cursors never advance. The wire's own view states
   * (available/missing/invalid) pass through; detached sources report
   * unavailable; foreign identities fail closed as errors.
   */
  readonly readWorkbenchDecisions?: (
    threadId: ThreadId,
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchDecisionsResult, TError>;

  /**
   * Create one recorded decision (Dokkabi R8): the definition carries only
   * the operator's immutable question/options/recommendation/rationale — the
   * adapter derives the stable command/checkpoint ids server-side, captures
   * the compatible checkpoint at the thread's actual current read cursor and
   * opens the definition with the returned real digest. An exact duplicate
   * recovers the recorded decision; a moved source head refuses. Omitted
   * when this adapter has no decision capability.
   */
  readonly createWorkbenchDecision?: (
    threadId: ThreadId,
    definition: ProviderWorkbenchDecisionDefinition,
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchDecisionActionResult, TError>;

  /**
   * Select one recorded decision option under an expected revision (Dokkabi
   * R8). Selection is never execution: it grants no permission and implies
   * no model result. A lost acknowledgement reconciles through status,
   * never a blind re-send. Omitted when this adapter has no decision
   * capability.
   */
  readonly selectWorkbenchDecision?: (
    threadId: ThreadId,
    input: {
      readonly id: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly option: string;
    },
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchDecisionActionResult, TError>;

  /**
   * Start the prepared child conversation of a selected decision (Dokkabi
   * R8). The target app thread is created FIRST through the normal
   * thread-create operation and must share the parent's project/provider
   * instance/runtime mode (validated by the facade). On a confirmed ready
   * the adapter adopts the child as a normal conversation bound to the
   * child session/workspace with the recorded parent envelope; a lost
   * acknowledgement stays unknown and is never blindly re-sent. Omitted
   * when this adapter has no branch capability.
   */
  readonly startWorkbenchBranch?: (
    threadId: ThreadId,
    input: {
      readonly id: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly childThreadId: ThreadId;
    },
    persistedResumeCursor?: unknown,
    /** The target thread's EXISTING durable resume cursor: when present the
     * operation RECONCILES this parent's recorded child for that target from
     * the recorded state — it never re-sends the start. */
    targetResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchDecisionActionResult, TError>;

  /**
   * Read-only workbench work mode for a thread (Dokkabi R8-06j2). Omitted
   * when this adapter has no work-mode capability — existing providers stay
   * unsupported by default. The read resolves the thread's persisted resume
   * cursor server-side: no recovery, bind or model effects, and the transcript
   * replay cursors never advance. The result is the host's actual
   * configuration snapshot — never an execution truth verdict. Detached or
   * capability-less sources report unavailable/unsupported; foreign
   * instance/thread identities fail closed as errors.
   */
  readonly readWorkbenchWorkMode?: (
    threadId: ThreadId,
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchWorkModeResult, TError>;

  /**
   * One explicit work-mode selection for a thread (Dokkabi R8-06j2): a
   * stable command id, the displayed expected revision and the closed mode.
   * The adapter derives the binding server-side and issues exactly one set;
   * a transport loss reconciles ONLY through read-only same-id status and
   * never re-sends. "applied" is a control update receipt — never task
   * success — and no response optimistically rewrites execution state.
   * Omitted when this adapter has no work-mode capability.
   */
  readonly setWorkbenchWorkMode?: (
    threadId: ThreadId,
    input: {
      readonly commandId: string;
      readonly expectedRevision: string;
      readonly mode: WorkbenchWorkModeKind;
    },
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchWorkModeActionResult, TError>;

  /**
   * Read-only reconstruction of one work-mode command's stored outcome
   * (Dokkabi R8-06j2) from the fresh host state. A status never applies,
   * retries or boots anything; an unknown command id reports unknown.
   * Omitted when this adapter has no work-mode capability.
   */
  readonly workbenchWorkModeStatus?: (
    threadId: ThreadId,
    commandId: string,
    persistedResumeCursor?: unknown,
  ) => Effect.Effect<ProviderWorkbenchWorkModeActionResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
