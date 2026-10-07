/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ProviderWorkbenchOverviewResult,
  ProviderWorkbenchGraphResult,
  ProviderWorkbenchRecordResult,
  ProviderWorkbenchRecordIndexResult,
  ProviderWorkbenchRecordBodyResult,
  ProviderWorkbenchRecordVerificationResult,
  ProviderWorkbenchGraphExploreResult,
  ProviderGetWorkbenchRecordIndexInput,
  ProviderGetWorkbenchRecordBodyInput,
  ProviderVerifyWorkbenchRecordBodyInput,
  ProviderExploreWorkbenchGraphInput,
  ProviderWorkbenchCodeResult,
  ProviderWorkbenchCodeActionInput,
  ProviderWorkbenchCodeActionResult,
  ProviderGetWorkbenchCodeInput,
  CodeSessionCursor,
  ProviderWorkbenchDecisionActionResult,
  ProviderWorkbenchDecisionDefinition,
  ProviderWorkbenchDecisionsResult,
  ProviderWorkbenchResumeResult,
  ProviderWorkbenchWorkModeActionResult,
  ProviderWorkbenchWorkModeResult,
  MessageId,
  ThreadId,
  WorkbenchGraphType,
  WorkbenchRecordAsOf,
  WorkbenchRecordCursor,
  WorkbenchWorkModeKind,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly compactThread: (
    threadId: ThreadId,
    modelSelection?: ProviderSendTurnInput["modelSelection"],
    requestId?: MessageId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Reject unsupported rewind before files change, without resuming the session.
   */
  readonly assertConversationRollbackSupported: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Read the recorded workbench overview for a thread (Dokkabi R3). Resolves
   * the persisted provider instance through ProviderSessionDirectory WITHOUT
   * recovery, bind or model effects; never advances transcript replay
   * cursors. Unbound threads report unavailable; providers without the read
   * capability report unsupported — neither is an empty success.
   *
   * The optional options argument (R8) adds the on-demand scoped usage read:
   * `includeChildUsage: true` asks the resolved adapter to also return
   * `scopedUsage`, the recorded run-scoped usage report over the main prefix
   * plus every referenced child session. It is forwarded only when true, so
   * callers that do not ask keep the exact R3 request and result.
   */
  readonly getWorkbenchOverview: (
    threadId: ThreadId,
    options?: { readonly includeChildUsage?: boolean | undefined },
  ) => Effect.Effect<ProviderWorkbenchOverviewResult, ProviderServiceError>;

  /**
   * Read the recorded Work/Context graph for a thread (Dokkabi R4). Resolves
   * the persisted provider instance through ProviderSessionDirectory WITHOUT
   * recovery, bind or model effects; never advances transcript replay
   * cursors. Unbound threads report unavailable; providers without the read
   * capability report unsupported — neither is an empty success.
   */
  readonly getWorkbenchGraph: (
    threadId: ThreadId,
    graphType: WorkbenchGraphType,
  ) => Effect.Effect<ProviderWorkbenchGraphResult, ProviderServiceError>;

  /**
   * Read one exact retained record page for a thread (Dokkabi R5). Resolves
   * the persisted provider instance through ProviderSessionDirectory WITHOUT
   * recovery, bind or model effects; never advances transcript replay
   * cursors. The page carries only bounded paging cursors — the renderer
   * never chooses a session or path. Unbound threads report unavailable;
   * providers without the read capability and older pre-R5 gateways report
   * unsupported — neither is an empty success.
   */
  readonly getWorkbenchCode: (
    threadId: ThreadId,
    page: Omit<ProviderGetWorkbenchCodeInput, "threadId">,
  ) => Effect.Effect<ProviderWorkbenchCodeResult, ProviderServiceError>;
  /** A bounded acknowledged pull. Cancellation interrupts its one-second wait. */
  readonly subscribeWorkbenchCode: (
    threadId: ThreadId,
    after: CodeSessionCursor,
  ) => Effect.Effect<ProviderWorkbenchCodeResult, ProviderServiceError>;

  /** Mutates only the recorded thread owner; never recovers or chooses a session. */
  readonly workbenchCodeAction: (
    threadId: ThreadId,
    input: Omit<ProviderWorkbenchCodeActionInput, "threadId">,
  ) => Effect.Effect<ProviderWorkbenchCodeActionResult, ProviderServiceError>;

  readonly getWorkbenchRecord: (
    threadId: ThreadId,
    page?: {
      readonly after?: WorkbenchRecordCursor | undefined;
      readonly asOf?: WorkbenchRecordAsOf | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<ProviderWorkbenchRecordResult, ProviderServiceError>;

  /**
   * Bounded explorer reads (Dokkabi bounded retained-data explorer). Each
   * resolves the persisted binding and the registered ACTUAL instance with
   * no recovery, bind or model effect and never advances transcript replay
   * cursors. Unbound threads and capability-less providers are unsupported;
   * older gateways report unsupported; a detached source is unavailable.
   */
  readonly getWorkbenchRecordIndex: (
    threadId: ThreadId,
    page: Omit<ProviderGetWorkbenchRecordIndexInput, "threadId">,
  ) => Effect.Effect<ProviderWorkbenchRecordIndexResult, ProviderServiceError>;
  readonly getWorkbenchRecordBody: (
    threadId: ThreadId,
    range: Omit<ProviderGetWorkbenchRecordBodyInput, "threadId">,
  ) => Effect.Effect<ProviderWorkbenchRecordBodyResult, ProviderServiceError>;
  readonly verifyWorkbenchRecordBody: (
    threadId: ThreadId,
    target: Omit<ProviderVerifyWorkbenchRecordBodyInput, "threadId">,
  ) => Effect.Effect<ProviderWorkbenchRecordVerificationResult, ProviderServiceError>;
  readonly exploreWorkbenchGraph: (
    threadId: ThreadId,
    input: Omit<ProviderExploreWorkbenchGraphInput, "threadId">,
  ) => Effect.Effect<ProviderWorkbenchGraphExploreResult, ProviderServiceError>;

  /**
   * Read the recorded workbench decisions for a thread (Dokkabi R8). Resolves
   * the persisted provider instance through ProviderSessionDirectory WITHOUT
   * recovery, bind or model effects; never advances transcript replay
   * cursors. The wire's own view states pass through; unbound threads report
   * unavailable; capability-less providers and older pre-R8 gateways report
   * unsupported — neither is an empty success.
   */
  readonly getWorkbenchDecisions: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderWorkbenchDecisionsResult, ProviderServiceError>;

  /**
   * Create one recorded decision for a thread (Dokkabi R8). The definition
   * carries only the operator's immutable question/options/recommendation/
   * rationale; the adapter captures the compatible checkpoint at the
   * thread's actual current read cursor server-side and opens the immutable
   * definition with the returned real digest. An exact duplicate recovers
   * the recorded decision; a moved source head refuses.
   */
  readonly createWorkbenchDecision: (
    threadId: ThreadId,
    definition: ProviderWorkbenchDecisionDefinition,
  ) => Effect.Effect<ProviderWorkbenchDecisionActionResult, ProviderServiceError>;

  /**
   * Select one recorded decision option under an expected revision (Dokkabi
   * R8). Selection is never execution; a lost acknowledgement reconciles
   * through status, never a blind re-send.
   */
  readonly selectWorkbenchDecision: (
    threadId: ThreadId,
    input: {
      readonly id: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly option: string;
    },
  ) => Effect.Effect<ProviderWorkbenchDecisionActionResult, ProviderServiceError>;

  /**
   * Start the prepared child conversation of a selected decision (Dokkabi
   * R8). The target app thread must already exist through the normal
   * thread-create operation with the same project/provider instance/runtime
   * mode as its recorded parent — validated here through orchestration read
   * models before the harness start. On a confirmed ready the child binding
   * persists through the serialized harness snapshot boundary with the
   * adapter's CURRENT snapshot (bindingRule allow-initial), never the stale
   * returned one.
   */
  readonly startWorkbenchBranch: (
    threadId: ThreadId,
    input: {
      readonly id: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly childThreadId: ThreadId;
    },
  ) => Effect.Effect<ProviderWorkbenchDecisionActionResult, ProviderServiceError>;

  /**
   * Explicitly reconnect one recorded PARENT conversation (Dokkabi R8).
   * THREAD-ONLY: the caller names the thread and nothing else. The service
   * resolves the exact durable binding/instance/runtime state server-side,
   * requires the adapter's harness workspaceLifecycle capability and a
   * genuine recorded source, then reuses the normal validated recovery path
   * (recoverSessionForThread) — it never issues a sendTurn, a decision
   * open/select/start or any target allocation. "available" proves a
   * reconnected source only; missing binding/instance/capability report
   * unsupported; refused or failed recovery reports unknown with a bounded
   * reason — a session is never invented and a failure never reports
   * available. Cached ownership alone does not prove a live remote binding:
   * explicit reconnect verifies recorded reads before adoption and after
   * recovery. Errored snapshots retain their refusal/uncertainty. Repeated
   * live reconnect performs read-only verification with no duplicate bind.
   */
  readonly resumeWorkbenchSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderWorkbenchResumeResult, ProviderServiceError>;

  /**
   * Read the session's explicit work mode for a thread (Dokkabi R8-06j2).
   * Resolves the persisted provider instance through ProviderSessionDirectory
   * WITHOUT recovery, bind or model effects; the result is the host's actual
   * configuration snapshot, never an execution truth verdict. Unbound threads
   * report unavailable; capability-less providers and older pre-R8-06j2
   * gateways report unsupported — neither is an empty success.
   */
  readonly getWorkbenchWorkMode: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderWorkbenchWorkModeResult, ProviderServiceError>;

  /**
   * One explicit work-mode selection for a thread (Dokkabi R8-06j2): a stable
   * command id, the displayed expected revision and the closed mode. The
   * server derives the binding from the recorded session; ordinary providers
   * without the optional adapter method report unsupported. "applied" is a
   * control update receipt — never task success — and a transport loss
   * reconciles ONLY through read-only same-id status, never a re-send.
   */
  readonly setWorkbenchWorkMode: (
    threadId: ThreadId,
    input: {
      readonly commandId: string;
      readonly expectedRevision: string;
      readonly mode: WorkbenchWorkModeKind;
    },
  ) => Effect.Effect<ProviderWorkbenchWorkModeActionResult, ProviderServiceError>;

  /**
   * Read-only reconstruction of one work-mode command's stored outcome for a
   * thread (Dokkabi R8-06j2). A status never applies, retries or boots
   * anything; an unknown command id reports unknown.
   */
  readonly workbenchWorkModeStatus: (
    threadId: ThreadId,
    commandId: string,
  ) => Effect.Effect<ProviderWorkbenchWorkModeActionResult, ProviderServiceError>;

  /**
   * Upload a thread and return the provider's shareable feedback identifier.
   */
  readonly uploadFeedback: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
