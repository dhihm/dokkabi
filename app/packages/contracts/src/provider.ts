import * as Schema from "effect/Schema";
import { CommandId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  UserInputAttachments,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Stable orchestration command identity for adapters whose backend has its
   * own durable command ledger (e.g. the Dokkabi workbench gateway). The
   * reactor passes the actual orchestration turn-start command event id so a
   * retried dispatch deduplicates at the provider boundary instead of
   * invoking the backend twice. Optional and ignored by drivers without a
   * command-deduplication contract.
   */
  commandId: Schema.optional(CommandId),
  /** Internal recovery signal. Allows an empty turn only for adapters that
      explicitly support promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

// --- Recorded workbench overview (Dokkabi R3) ---
//
// The exact mirror of the harness gateway's additive `workbench.overview`
// result (dokkabi-dev src/dash/workbench-overview.ts): field names are fixed
// on both sides, every summary value is recorded data projected from one
// verified session prefix, missing source data is null/state "missing", and
// data that exists but cannot be interpreted is state "invalid" with an
// explanation — never a zero-count success. Counts are never truncated
// silently.

const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A recorded source row: seq within the returned session prefix plus its hash. */
export const WorkbenchOverviewSourceRef = Schema.Struct({
  seq: PositiveInt,
  hash: Hex64,
});
export type WorkbenchOverviewSourceRef = typeof WorkbenchOverviewSourceRef.Type;

export const ProviderWorkbenchOverviewGoal = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  source: WorkbenchOverviewSourceRef,
});
export type ProviderWorkbenchOverviewGoal = typeof ProviderWorkbenchOverviewGoal.Type;

export const ProviderWorkbenchOverviewTodo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  class: Schema.Literals([
    "host",
    "loop",
    "graph",
    "sandbox",
    "tools",
    "obs",
    "verify",
    "dash",
    "impl",
  ]),
  state: Schema.Literals(["blocked", "ready", "red", "green", "clear"]),
  priority: Schema.Number,
});
export type ProviderWorkbenchOverviewTodo = typeof ProviderWorkbenchOverviewTodo.Type;

export const ProviderWorkbenchOverviewCases = Schema.Struct({
  total: NonNegativeInt,
  green: NonNegativeInt,
  red: NonNegativeInt,
  pending: NonNegativeInt,
});
export type ProviderWorkbenchOverviewCases = typeof ProviderWorkbenchOverviewCases.Type;

export const ProviderWorkbenchOverviewWork = Schema.Struct({
  state: Schema.Literals(["missing", "available", "invalid"]),
  goal: Schema.NullOr(ProviderWorkbenchOverviewGoal),
  planDigest: Schema.NullOr(Schema.String),
  todos: Schema.Array(ProviderWorkbenchOverviewTodo),
  cases: Schema.NullOr(ProviderWorkbenchOverviewCases),
  errors: Schema.Array(Schema.String),
});
export type ProviderWorkbenchOverviewWork = typeof ProviderWorkbenchOverviewWork.Type;

export const ProviderWorkbenchOverviewFrame = Schema.Struct({
  id: Schema.String,
  stage: Schema.Literals(["prepared", "appended", "dispatched", "responded"]),
  source: WorkbenchOverviewSourceRef,
});
export type ProviderWorkbenchOverviewFrame = typeof ProviderWorkbenchOverviewFrame.Type;

export const ProviderWorkbenchOverviewContext = Schema.Struct({
  state: Schema.Literals(["missing", "available", "invalid"]),
  /** Recorded scope mode; "unknown" when no scope row exists (absence cannot prove off). */
  mode: Schema.NullOr(Schema.Literals(["shadow", "on", "unknown"])),
  revision: Schema.NullOr(NonNegativeInt),
  digest: Schema.NullOr(Hex64),
  frame: Schema.NullOr(ProviderWorkbenchOverviewFrame),
  lessonCount: Schema.NullOr(NonNegativeInt),
  errors: Schema.Array(Schema.String),
});
export type ProviderWorkbenchOverviewContext = typeof ProviderWorkbenchOverviewContext.Type;

export const ProviderWorkbenchOverviewUsageMetric = Schema.Struct({
  /** Sum of measured values, or null where nothing was measured. */
  total: Schema.NullOr(NonNegativeInt),
  /** Records that exist but do not report this field. */
  missing: NonNegativeInt,
  /** Newest record that measured this field, or null. */
  latestSource: Schema.NullOr(WorkbenchOverviewSourceRef),
});
export type ProviderWorkbenchOverviewUsageMetric = typeof ProviderWorkbenchOverviewUsageMetric.Type;

export const ProviderWorkbenchOverviewUsage = Schema.Struct({
  records: NonNegativeInt,
  input: ProviderWorkbenchOverviewUsageMetric,
  output: ProviderWorkbenchOverviewUsageMetric,
  reasoning: ProviderWorkbenchOverviewUsageMetric,
  cacheRead: ProviderWorkbenchOverviewUsageMetric,
  cacheWrite: ProviderWorkbenchOverviewUsageMetric,
});
export type ProviderWorkbenchOverviewUsage = typeof ProviderWorkbenchOverviewUsage.Type;

// --- Scoped run usage (Dokkabi R8) ---
//
// The exact mirror of the harness gateway's additive `workbench.usage` (v1)
// report (dokkabi-dev src/dash/workbench-usage.ts): the main scope plus
// every child session this session's own observe rows genuinely reference,
// each counted only over its largest parent-PINNED verified prefix. Usage
// metrics measure only finite nonnegative integer tokens; anything a row
// does not report is preserved as `missing`, never turned into zero.
// Totals are RECORDED usage, not billing; reasoning is a labeled subset of
// the output total; cache read/write are counted outside the input total;
// request-versus-usage gaps stay explicit. Source refs inside a child scope
// are that child's own seq/hash — a child seq is never a main-session seq.

/** A recorded source row of ANY scope's own log (seq 0 only for an empty genesis head). */
export const WorkbenchUsageSourceRef = Schema.Struct({
  seq: NonNegativeInt,
  hash: Hex64,
});
export type WorkbenchUsageSourceRef = typeof WorkbenchUsageSourceRef.Type;

export const WorkbenchUsageMetric = Schema.Struct({
  /** Sum of measured values, or null when nothing was measured. */
  total: Schema.NullOr(NonNegativeInt),
  /** Records that exist but do not report a measurable value for this field. */
  missing: NonNegativeInt,
  /** Newest record that measured this field, scoped to THIS scope's own log. */
  latestSource: Schema.NullOr(WorkbenchUsageSourceRef),
});
export type WorkbenchUsageMetric = typeof WorkbenchUsageMetric.Type;

export const WorkbenchUsageRecords = Schema.Struct({
  records: NonNegativeInt,
  input: WorkbenchUsageMetric,
  output: WorkbenchUsageMetric,
  reasoning: WorkbenchUsageMetric,
  cacheRead: WorkbenchUsageMetric,
  cacheWrite: WorkbenchUsageMetric,
});
export type WorkbenchUsageRecords = typeof WorkbenchUsageRecords.Type;

export const WorkbenchUsageCounts = Schema.Struct({
  /** Recorded provider/request rows in the counted prefix. */
  requests: NonNegativeInt,
  /** Recorded provider/send rows in the counted prefix. */
  sends: NonNegativeInt,
  /** Rows carrying a completed usage observation in the counted prefix. */
  completedUsage: NonNegativeInt,
});
export type WorkbenchUsageCounts = typeof WorkbenchUsageCounts.Type;

/** One parent row that names a child, with the head hash it pinned. */
export const WorkbenchUsageProvenanceRef = Schema.Struct({
  producer: Schema.String.check(Schema.isMaxLength(128)),
  field: Schema.String.check(Schema.isMaxLength(64)),
  ref: WorkbenchUsageSourceRef,
  pinnedHash: Schema.NullOr(Hex64),
});
export type WorkbenchUsageProvenanceRef = typeof WorkbenchUsageProvenanceRef.Type;

export const WorkbenchChildUsageScope = Schema.Struct({
  /** The child session id as the parent's own rows named it. */
  id: Schema.String.check(Schema.isMaxLength(256)),
  /** Every declared role identity the producers gave this child. */
  roles: Schema.Array(Schema.Literals(["spec", "verifier", "readiness"])),
  state: Schema.Literals(["verified", "unpinned", "missing", "invalid"]),
  provenance: Schema.Array(WorkbenchUsageProvenanceRef),
  /** Largest parent-pinned prefix that verified in the child chain. */
  pinnedHead: Schema.NullOr(WorkbenchUsageSourceRef),
  /** The child's own current verified head, when its log was readable. */
  head: Schema.NullOr(WorkbenchUsageSourceRef),
  counts: Schema.NullOr(WorkbenchUsageCounts),
  usage: Schema.NullOr(WorkbenchUsageRecords),
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type WorkbenchChildUsageScope = typeof WorkbenchChildUsageScope.Type;

export const WorkbenchMainUsageScope = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(256)),
  head: WorkbenchUsageSourceRef,
  /** False when a recorded turn started and never settled. */
  settled: Schema.Boolean,
  counts: WorkbenchUsageCounts,
  usage: WorkbenchUsageRecords,
});
export type WorkbenchMainUsageScope = typeof WorkbenchMainUsageScope.Type;

export const WorkbenchUsageTotals = Schema.Struct({
  /** Sum over the counted scopes, or null when nothing was measured. */
  total: Schema.NullOr(NonNegativeInt),
  missing: NonNegativeInt,
});
export type WorkbenchUsageTotals = typeof WorkbenchUsageTotals.Type;

export const WorkbenchUsageAggregate = Schema.Struct({
  /** The main scope plus every verified child scope these totals cover. */
  scopesCounted: NonNegativeInt,
  counts: WorkbenchUsageCounts,
  input: WorkbenchUsageTotals,
  output: WorkbenchUsageTotals,
  reasoning: WorkbenchUsageTotals,
  cacheRead: WorkbenchUsageTotals,
  cacheWrite: WorkbenchUsageTotals,
});
export type WorkbenchUsageAggregate = typeof WorkbenchUsageAggregate.Type;

export const WorkbenchUsageSemantics = Schema.Struct({
  totals: Schema.Literal("recorded_usage_not_billing"),
  reasoning: Schema.Literal("included_in_output_total"),
  cacheRead: Schema.Literal("separate_from_input_total"),
  cacheWrite: Schema.Literal("separate_from_input_total"),
});
export type WorkbenchUsageSemantics = typeof WorkbenchUsageSemantics.Type;

/** The full typed report exactly as `workbench.usage` (v1) projects it. */
export const ProviderWorkbenchUsageReport = Schema.Struct({
  state: Schema.Literals(["complete", "partial", "invalid"]),
  main: WorkbenchMainUsageScope,
  scopes: Schema.Array(WorkbenchChildUsageScope),
  aggregate: WorkbenchUsageAggregate,
  semantics: WorkbenchUsageSemantics,
  /** Bounded, closed reasons the state is partial (never paths or secrets). */
  details: Schema.Array(Schema.String.check(Schema.isMaxLength(512))),
  /** Bounded, closed reasons the state is invalid. */
  errors: Schema.Array(Schema.String.check(Schema.isMaxLength(512))),
});
export type ProviderWorkbenchUsageReport = typeof ProviderWorkbenchUsageReport.Type;

/**
 * The scoped usage companion of one overview read that asked for it
 * (includeChildUsage). "available" carries the typed report; "unsupported"
 * is the documented missing-method answer of an older gateway;
 * "unavailable" is a scoped source that is not bound right now. None of
 * these is ever a zero-total success.
 */
export const ProviderWorkbenchScopedUsage = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    report: ProviderWorkbenchUsageReport,
  }),
  Schema.Struct({
    status: Schema.Literals(["unsupported", "unavailable"]),
    reason: Schema.String,
  }),
]);
export type ProviderWorkbenchScopedUsage = typeof ProviderWorkbenchScopedUsage.Type;

/** The full recorded overview as one closed payload. */
export const ProviderWorkbenchOverview = Schema.Struct({
  version: Schema.Literal(1),
  sessionCursor: Schema.Struct({
    sessionId: Schema.String,
    seq: NonNegativeInt,
    hash: Hex64,
    generation: Hex64,
  }),
  gatewayCursor: Schema.Struct({
    seq: NonNegativeInt,
    hash: Hex64,
    generation: Hex64,
  }),
  resnapshot: Schema.Boolean,
  work: ProviderWorkbenchOverviewWork,
  context: ProviderWorkbenchOverviewContext,
  usage: ProviderWorkbenchOverviewUsage,
});
export type ProviderWorkbenchOverview = typeof ProviderWorkbenchOverview.Type;

/**
 * The provider.getWorkbenchOverview result. "available" carries the overview;
 * "unavailable" means the recorded source is detached/unbound right now (an
 * explicit Send may resume the binding); "unsupported" means this provider
 * has no recorded-overview read capability. Neither non-available state is
 * ever an empty success. `scopedUsage` is present only when the request
 * asked for it (includeChildUsage): "available" carries the typed report,
 * "unsupported" is the documented missing-method answer of an older
 * gateway, "unavailable" is a scoped source that is not bound right now —
 * never a fabricated zero-total success.
 */
export const ProviderWorkbenchOverviewResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  overview: Schema.optional(ProviderWorkbenchOverview),
  scopedUsage: Schema.optional(ProviderWorkbenchScopedUsage),
});
export type ProviderWorkbenchOverviewResult = typeof ProviderWorkbenchOverviewResult.Type;

export const ProviderGetWorkbenchOverviewInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Optional R8 on-demand scoped usage read: when true, the result also
   * carries `scopedUsage` — the recorded run-scoped usage report over the
   * main prefix plus every child session this session's own rows reference.
   * Absent (or false) keeps the request and result byte-compatible with the
   * R3 read: no usage probe is issued and `scopedUsage` stays undefined.
   */
  includeChildUsage: Schema.optional(Schema.Boolean),
});
export type ProviderGetWorkbenchOverviewInput = typeof ProviderGetWorkbenchOverviewInput.Type;

/** A recorded-overview read failed at the provider/source boundary: identity
 * mismatch, replaced source, contract violation or transport failure. Never
 * used for unavailable/unsupported — those are typed result statuses. */
export class ProviderWorkbenchOverviewError extends Schema.TaggedError<ProviderWorkbenchOverviewError>()(
  "ProviderWorkbenchOverviewError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read the recorded workbench overview for thread ${this.threadId}.`;
  }
}

// --- Recorded workbench graphs (Dokkabi R4) ---
//
// The exact mirror of the harness gateway's additive `workbench.graph`
// result (dokkabi-dev src/dash/workbench-graph.ts): closed vocabularies,
// every value projected from one verified session prefix, a planned case
// without an earned verdict is PENDING, goal/scenario stay null rather than
// inventing a verdict, source references resolve exactly against the
// returned prefix, and coverage never silently truncates — an oversized
// graph is state "unavailable" with the actual totals.

export type WorkbenchGraphType = "work" | "context";

export const WorkbenchGraphNodeKind = Schema.Literals([
  "goal",
  "todo",
  "scenario",
  "case",
  "question",
  "claim",
  "attempt",
  "action",
  "observation",
  "resource_version",
  "lesson",
  "context_frame",
  "source_reference",
  "unavailable_reference",
]);
export type WorkbenchGraphNodeKind = typeof WorkbenchGraphNodeKind.Type;

/** Nullable closed vocabulary: a recorded status or no status at all. */
export const WorkbenchGraphNodeStatus = Schema.Literals([
  "blocked",
  "ready",
  "red",
  "green",
  "clear",
  "pending",
  "completed",
  "interrupted",
  "open",
  "met",
  "not_met",
  "inconclusive",
  "proposed",
  "corroborated",
  "contested",
  "superseded",
  "prepared",
  "appended",
  "dispatched",
  "responded",
]);
export type WorkbenchGraphNodeStatus = typeof WorkbenchGraphNodeStatus.Type;

export const WorkbenchGraphProvenance = Schema.Literals([
  "canonical",
  "source_reference",
  "unresolved",
]);
export type WorkbenchGraphProvenance = typeof WorkbenchGraphProvenance.Type;

/** Closed edge vocabulary: Work's three relation kinds plus the canonical
 * ContextRelation values. An arbitrary relation string is a contract
 * violation, never something to render. */
export const WORKBENCH_GRAPH_EDGE_KINDS = [
  // Work (docs/desktop-graphs-r4.md: contains / blocked_by / flows)
  "contains",
  "blocked_by",
  "flows",
  // Canonical ContextRelation values (dokkabi-dev src/context-graph/types.ts)
  "pursues",
  "tests_hypothesis",
  "requested_by",
  "observed_from",
  "read_version",
  "produced_version",
  "supports",
  "contradicts",
  "supersedes",
  "revalidates",
  "applies_to",
  "depends_on",
  "selected_for",
  "presented_to",
  "cited_by",
  "retries_with",
] as const;
export type WorkbenchGraphEdgeKind = (typeof WORKBENCH_GRAPH_EDGE_KINDS)[number];
export const WorkbenchGraphEdgeKind = Schema.Literals(WORKBENCH_GRAPH_EDGE_KINDS);

export const WorkbenchGraphSourceRef = Schema.Struct({
  seq: PositiveInt,
  hash: Hex64,
});
export type WorkbenchGraphSourceRef = typeof WorkbenchGraphSourceRef.Type;

const GraphId = Schema.String.check(Schema.isMaxLength(512));
const GraphDetailValue = Schema.String.check(Schema.isMaxLength(512));

export const ProviderWorkbenchGraphDetailEntry = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(128)),
  value: GraphDetailValue,
});
export type ProviderWorkbenchGraphDetailEntry = typeof ProviderWorkbenchGraphDetailEntry.Type;

export const ProviderWorkbenchGraphNode = Schema.Struct({
  id: GraphId,
  kind: WorkbenchGraphNodeKind,
  label: Schema.String.check(Schema.isMaxLength(400)),
  status: Schema.NullOr(WorkbenchGraphNodeStatus),
  provenance: WorkbenchGraphProvenance,
  sources: Schema.Array(WorkbenchGraphSourceRef).check(Schema.isMaxLength(32)),
  details: Schema.Array(ProviderWorkbenchGraphDetailEntry).check(Schema.isMaxLength(64)),
  /** SHA-256 of the canonical node body; null for synthesized nodes with no body. */
  bodyDigest: Schema.NullOr(Hex64),
});
export type ProviderWorkbenchGraphNode = typeof ProviderWorkbenchGraphNode.Type;

export const ProviderWorkbenchGraphEdge = Schema.Struct({
  /** Semantic identity (SHA-256 of the canonical edge tuple); stable across refreshes. */
  id: Schema.String.check(Schema.isMaxLength(128)),
  from: GraphId,
  to: GraphId,
  /** Closed vocabulary: the Work relation kinds plus the canonical ContextRelation values. */
  kind: WorkbenchGraphEdgeKind,
  /** `flows` only: the artifact traveling this edge; null otherwise. */
  artifact: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
  sources: Schema.Array(WorkbenchGraphSourceRef).check(Schema.isMaxLength(16)),
});
export type ProviderWorkbenchGraphEdge = typeof ProviderWorkbenchGraphEdge.Type;

export const ProviderWorkbenchGraphCoverage = Schema.Struct({
  status: Schema.Literals(["complete", "partial", "unavailable"]),
  totalNodes: NonNegativeInt,
  totalEdges: NonNegativeInt,
  omittedNodes: NonNegativeInt,
  omittedEdges: NonNegativeInt,
});
export type ProviderWorkbenchGraphCoverage = typeof ProviderWorkbenchGraphCoverage.Type;

export const ProviderWorkbenchGraphBody = Schema.Struct({
  state: Schema.Literals(["missing", "available", "invalid", "unavailable"]),
  /** shadow / on / unknown — absence never proves off; null when not applicable. */
  mode: Schema.NullOr(Schema.Literals(["shadow", "on", "unknown"])),
  revision: Schema.NullOr(NonNegativeInt),
  digest: Schema.NullOr(Hex64),
  /** Hard display bounds mirroring the harness refusal limits (512/1536). */
  nodes: Schema.Array(ProviderWorkbenchGraphNode).check(Schema.isMaxLength(512)),
  edges: Schema.Array(ProviderWorkbenchGraphEdge).check(Schema.isMaxLength(1_536)),
  /** Canonical work layout hints; empty for Context. Never an execution schedule. */
  waves: Schema.Array(Schema.Array(GraphId)),
  unscheduled: Schema.Array(GraphId),
  coverage: ProviderWorkbenchGraphCoverage,
  errors: Schema.Array(Schema.String),
});
export type ProviderWorkbenchGraphBody = typeof ProviderWorkbenchGraphBody.Type;

/** The full recorded graph read as one closed payload. */
export const ProviderWorkbenchGraph = Schema.Struct({
  version: Schema.Literal(1),
  graphType: Schema.Literals(["work", "context"]),
  sessionCursor: Schema.Struct({
    sessionId: Schema.String,
    seq: NonNegativeInt,
    hash: Hex64,
    generation: Hex64,
  }),
  gatewayCursor: Schema.Struct({
    seq: NonNegativeInt,
    hash: Hex64,
    generation: Hex64,
  }),
  resnapshot: Schema.Boolean,
  graph: ProviderWorkbenchGraphBody,
});
export type ProviderWorkbenchGraph = typeof ProviderWorkbenchGraph.Type;

/**
 * The provider.getWorkbenchGraph result. "available" carries the graph;
 * "unavailable" means the recorded source is detached/unbound right now (an
 * explicit Send may resume the binding); "unsupported" means this provider
 * or gateway has no recorded-graph read capability. Neither non-available
 * state is ever an empty success.
 */
export const ProviderWorkbenchGraphResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  graph: Schema.optional(ProviderWorkbenchGraph),
});
export type ProviderWorkbenchGraphResult = typeof ProviderWorkbenchGraphResult.Type;

export const ProviderGetWorkbenchGraphInput = Schema.Struct({
  threadId: ThreadId,
  graphType: Schema.Literals(["work", "context"]),
});
export type ProviderGetWorkbenchGraphInput = typeof ProviderGetWorkbenchGraphInput.Type;

/** A recorded-graph read failed at the provider/source boundary: identity
 * mismatch, replaced source, contract violation or transport failure. Never
 * used for unavailable/unsupported — those are typed result statuses. */
export class ProviderWorkbenchGraphError extends Schema.TaggedError<ProviderWorkbenchGraphError>()(
  "ProviderWorkbenchGraphError",
  {
    threadId: ThreadId,
    graphType: Schema.Literals(["work", "context"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read the recorded ${this.graphType} graph for thread ${this.threadId}.`;
  }
}

// --- Exact retained records (Dokkabi R5) ---
//
// The exact mirror of the harness gateway's additive `workbench.record`
// result (dokkabi-dev src/dash/workbench-record.ts): whole retained
// EventLog rows from ONE verified session prefix under an immutable asOf
// pin, bounded 64 KiB per row and 1 MiB per canonical records array. Rows
// are inert text for the renderer — never executable HTML or links. An
// oversized row that belongs to the requested page reports the body
// "unavailable" with a reason, never a clipped row masquerading as exact.
// Decisions are a capability fact, not data: "unsupported" means no
// decision execution or branch fork surface exists — never an empty
// pending-decision list implying authority.

/** An exact retained EventLog row: seq/ts/kind/name/prev_hash/hash/payload
 * plus the optional observation envelope. hash is the harness's
 * sha256(canonicalJson(row minus hash)); the server verifies it. */
export const WorkbenchRecordRow = Schema.Struct({
  seq: PositiveInt,
  ts: Schema.String,
  kind: Schema.Literals(["surface", "observe", "effect"]),
  name: Schema.String,
  prev_hash: Hex64,
  hash: Hex64,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  /** Opaque observation envelope: identity fields above are closed, the
   * envelope is harness-extensible and never execution input here. */
  observe: Schema.optional(Schema.Unknown),
});
export type WorkbenchRecordRow = typeof WorkbenchRecordRow.Type;

/** An exact position in one session's verified chain. */
export const WorkbenchRecordCursor = Schema.Struct({
  seq: NonNegativeInt,
  hash: Hex64,
  generation: Hex64,
});
export type WorkbenchRecordCursor = typeof WorkbenchRecordCursor.Type;

/** An immutable pinned prefix: the exact session plus the chain position. */
export const WorkbenchRecordAsOf = Schema.Struct({
  ...WorkbenchRecordCursor.fields,
  sessionId: Schema.String,
});
export type WorkbenchRecordAsOf = typeof WorkbenchRecordAsOf.Type;

/** Page bounds mirroring the harness refusal limits. */
export const WORKBENCH_RECORD_MAX_LIMIT = 100;
export const WORKBENCH_RECORD_DEFAULT_LIMIT = 50;

/** The decisions capability fact carried by every record result. */
export const WorkbenchRecordDecisions = Schema.Struct({
  status: Schema.Literal("unsupported"),
  reason: Schema.String,
});
export type WorkbenchRecordDecisions = typeof WorkbenchRecordDecisions.Type;

const RecordSessionCursor = Schema.Struct({
  sessionId: Schema.String,
  ...WorkbenchRecordCursor.fields,
});

/** The record read: exact rows while in bounds, an honest refusal otherwise.
 * Discriminated on `state`. Both branches share one closed field set so
 * page-shaped objects stay assignable across the union; the unavailable
 * body's emptiness is enforced at the source boundary, not by narrower
 * literal types. */
export const ProviderWorkbenchRecord = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("available"),
    sessionCursor: RecordSessionCursor,
    gatewayCursor: WorkbenchRecordCursor,
    asOf: WorkbenchRecordAsOf,
    records: Schema.Array(WorkbenchRecordRow).check(Schema.isMaxLength(WORKBENCH_RECORD_MAX_LIMIT)),
    next: Schema.NullOr(WorkbenchRecordCursor),
    /** The pinned prefix's own seq — not the current session head. */
    total: NonNegativeInt,
    hasMore: Schema.Boolean,
    decisions: WorkbenchRecordDecisions,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("unavailable"),
    reason: Schema.String,
    sessionCursor: RecordSessionCursor,
    gatewayCursor: WorkbenchRecordCursor,
    asOf: WorkbenchRecordAsOf,
    records: Schema.Array(WorkbenchRecordRow).check(Schema.isMaxLength(0)),
    next: Schema.NullOr(WorkbenchRecordCursor),
    total: NonNegativeInt,
    hasMore: Schema.Boolean,
    decisions: WorkbenchRecordDecisions,
  }),
]);
export type ProviderWorkbenchRecord = typeof ProviderWorkbenchRecord.Type;

/**
 * The provider.getWorkbenchRecord result. "available" carries the record
 * body; "unavailable" means the recorded source is detached/unbound right
 * now (an explicit Send may resume the binding); "unsupported" means this
 * provider or gateway has no record read capability (including an older
 * pre-R5 gateway). Neither non-available state is ever an empty success.
 */
export const ProviderWorkbenchRecordResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  record: Schema.optional(ProviderWorkbenchRecord),
});
export type ProviderWorkbenchRecordResult = typeof ProviderWorkbenchRecordResult.Type;

/** A bounded record page request: paging cursors only — the renderer never
 * chooses a session or path; the thread's own binding does. */
export const ProviderGetWorkbenchRecordInput = Schema.Struct({
  threadId: ThreadId,
  after: Schema.optional(WorkbenchRecordCursor),
  asOf: Schema.optional(WorkbenchRecordAsOf),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORKBENCH_RECORD_MAX_LIMIT),
    ),
  ),
});
export type ProviderGetWorkbenchRecordInput = typeof ProviderGetWorkbenchRecordInput.Type;

/** A record read failed at the provider/source boundary: identity mismatch,
 * replaced source, forged row or cursor, contract violation or transport
 * failure. Never used for unavailable/unsupported — those are typed result
 * statuses. */
export class ProviderWorkbenchRecordError extends Schema.TaggedError<ProviderWorkbenchRecordError>()(
  "ProviderWorkbenchRecordError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read the retained records for thread ${this.threadId}.`;
  }
}

// --- Bounded retained-data explorer (record index/body, graph explore) ---
//
// Closed mirrors of the harness's additive read-only v1 methods
// workbench.record.index, workbench.record.body and workbench.graph.explore.
// The index carries exact row METADATA only (never payload bytes, never an
// unmarked preview); exact content travels as canonical UTF-8 byte ranges
// of at most 32 KiB bound to one row cursor and one pinned prefix. A range
// is never a complete record or a chain proof: "exact" is earned only by a
// streamed verification of every range against the body digest AND the
// canonical row/event hash. Graph exploration returns bounded pages of one
// full canonical display projection pinned by a snapshot digest; a snapshot
// mismatch is an explicit stale state, never mixed nodes.

export const WORKBENCH_RECORD_BODY_MAX_BYTES = 32_768;
/** Canonical base64 length of the largest range (ceil(32768 / 3) * 4). */
export const WORKBENCH_RECORD_BODY_MAX_BASE64 = 43_692;
/** Descriptor ts/name display excerpts are at most this many UTF-16 units. */
export const WORKBENCH_RECORD_DESCRIPTOR_TEXT_MAX = 1_024;
/** The largest row an explicit streamed full-row verification walks
 * (2048 bounded ranges); larger rows are refused, never partially proven. */
export const WORKBENCH_RECORD_VERIFY_MAX_BYTES = 64 * 1_048_576;
export const WORKBENCH_GRAPH_EXPLORE_MAX_NODES = 100;
export const WORKBENCH_GRAPH_EXPLORE_MAX_EDGES = 1_536;
export const WORKBENCH_GRAPH_EXPLORE_DEFAULT_LIMIT = 100;
export const WORKBENCH_GRAPH_SEARCH_MAX_LENGTH = 128;

const RecordBodyLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(WORKBENCH_RECORD_BODY_MAX_BYTES),
);
const RecordBodyBase64 = Schema.String.check(
  Schema.isMaxLength(WORKBENCH_RECORD_BODY_MAX_BASE64),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
);

/** Exact metadata of one retained row: identity plus the canonical byte
 * length and SHA-256 of the full canonical row bytes (not the event hash). */
export const WorkbenchRecordDescriptor = Schema.Struct({
  seq: PositiveInt,
  ts: Schema.String.check(Schema.isMaxLength(WORKBENCH_RECORD_DESCRIPTOR_TEXT_MAX)),
  kind: Schema.Literals(["surface", "observe", "effect"]),
  name: Schema.String.check(Schema.isMaxLength(WORKBENCH_RECORD_DESCRIPTOR_TEXT_MAX)),
  prev_hash: Hex64,
  hash: Hex64,
  byteLength: PositiveInt,
  bodyDigest: Hex64,
  /** Present (true) only when ts/name are shortened display excerpts (at
   * most 1024 UTF-16 units); the canonical body keeps the full values. */
  tsTruncated: Schema.optional(Schema.Literal(true)),
  nameTruncated: Schema.optional(Schema.Literal(true)),
});
export type WorkbenchRecordDescriptor = typeof WorkbenchRecordDescriptor.Type;

/** One metadata page of one pinned prefix; `total` is the pin's own seq. */
export const ProviderWorkbenchRecordIndex = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("available"),
  sessionCursor: RecordSessionCursor,
  gatewayCursor: WorkbenchRecordCursor,
  asOf: WorkbenchRecordAsOf,
  entries: Schema.Array(WorkbenchRecordDescriptor).check(
    Schema.isMaxLength(WORKBENCH_RECORD_MAX_LIMIT),
  ),
  next: Schema.NullOr(WorkbenchRecordCursor),
  total: NonNegativeInt,
  hasMore: Schema.Boolean,
});
export type ProviderWorkbenchRecordIndex = typeof ProviderWorkbenchRecordIndex.Type;

export const ProviderWorkbenchRecordIndexResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  index: Schema.optional(ProviderWorkbenchRecordIndex),
});
export type ProviderWorkbenchRecordIndexResult = typeof ProviderWorkbenchRecordIndexResult.Type;

export const ProviderGetWorkbenchRecordIndexInput = Schema.Struct({
  threadId: ThreadId,
  after: Schema.optional(WorkbenchRecordCursor),
  asOf: Schema.optional(WorkbenchRecordAsOf),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORKBENCH_RECORD_MAX_LIMIT),
    ),
  ),
});
export type ProviderGetWorkbenchRecordIndexInput = typeof ProviderGetWorkbenchRecordIndexInput.Type;

export class ProviderWorkbenchRecordIndexError extends Schema.TaggedError<ProviderWorkbenchRecordIndexError>()(
  "ProviderWorkbenchRecordIndexError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read the retained record index for thread ${this.threadId}.`;
  }
}

/** The descriptor a body read is held to: the index's exact length/digest. */
export const WorkbenchRecordBodyExpected = Schema.Struct({
  byteLength: PositiveInt,
  bodyDigest: Hex64,
});
export type WorkbenchRecordBodyExpected = typeof WorkbenchRecordBodyExpected.Type;

/** One canonical byte range of one row under one pin. `chunkDigest` proves
 * only this range's integrity; `nextOffset` is null exactly at the end. */
export const ProviderWorkbenchRecordBody = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("available"),
  sessionCursor: RecordSessionCursor,
  gatewayCursor: WorkbenchRecordCursor,
  asOf: WorkbenchRecordAsOf,
  row: WorkbenchRecordCursor,
  offset: NonNegativeInt,
  nextOffset: Schema.NullOr(PositiveInt),
  totalBytes: PositiveInt,
  bodyDigest: Hex64,
  chunkDigest: Hex64,
  data: RecordBodyBase64,
});
export type ProviderWorkbenchRecordBody = typeof ProviderWorkbenchRecordBody.Type;

export const ProviderWorkbenchRecordBodyResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  body: Schema.optional(ProviderWorkbenchRecordBody),
});
export type ProviderWorkbenchRecordBodyResult = typeof ProviderWorkbenchRecordBodyResult.Type;

export const ProviderGetWorkbenchRecordBodyInput = Schema.Struct({
  threadId: ThreadId,
  row: WorkbenchRecordCursor,
  asOf: WorkbenchRecordAsOf,
  offset: NonNegativeInt,
  limit: Schema.optional(RecordBodyLimit),
  expected: WorkbenchRecordBodyExpected,
});
export type ProviderGetWorkbenchRecordBodyInput = typeof ProviderGetWorkbenchRecordBodyInput.Type;

export class ProviderWorkbenchRecordBodyError extends Schema.TaggedError<ProviderWorkbenchRecordBodyError>()(
  "ProviderWorkbenchRecordBodyError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read the retained record body range for thread ${this.threadId}.`;
  }
}

/** A completed streamed verification: every range read in order, the
 * assembled digest equals the descriptor's, and the canonical bytes carry
 * the row's own event hash. Any failure is an error, never a weaker verdict. */
export const ProviderWorkbenchRecordVerification = Schema.Struct({
  verdict: Schema.Literal("exact"),
  row: WorkbenchRecordCursor,
  asOf: WorkbenchRecordAsOf,
  totalBytes: PositiveInt,
  bodyDigest: Hex64,
  chunks: PositiveInt,
});
export type ProviderWorkbenchRecordVerification = typeof ProviderWorkbenchRecordVerification.Type;

export const ProviderWorkbenchRecordVerificationResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  verification: Schema.optional(ProviderWorkbenchRecordVerification),
});
export type ProviderWorkbenchRecordVerificationResult =
  typeof ProviderWorkbenchRecordVerificationResult.Type;

export const ProviderVerifyWorkbenchRecordBodyInput = Schema.Struct({
  threadId: ThreadId,
  row: WorkbenchRecordCursor,
  asOf: WorkbenchRecordAsOf,
  expected: WorkbenchRecordBodyExpected,
});
export type ProviderVerifyWorkbenchRecordBodyInput =
  typeof ProviderVerifyWorkbenchRecordBodyInput.Type;

export class ProviderWorkbenchRecordVerificationError extends Schema.TaggedError<ProviderWorkbenchRecordVerificationError>()(
  "ProviderWorkbenchRecordVerificationError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to verify the retained record body for thread ${this.threadId}.`;
  }
}

export const WorkbenchGraphExploreMode = Schema.Literals(["page", "neighbors", "search"]);
export type WorkbenchGraphExploreMode = typeof WorkbenchGraphExploreMode.Type;

const GraphExploreLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(WORKBENCH_GRAPH_EXPLORE_MAX_NODES),
);
const GraphExploreNodeId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const GraphExploreSearch = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(WORKBENCH_GRAPH_SEARCH_MAX_LENGTH),
);

/** neighbors needs exactly a nodeId and at least two slots (the anchor is
 * on every page and each page advances by limit - 1 neighbors), search
 * exactly one literal, page neither. */
const graphExploreQueryShape = (query: {
  readonly mode: WorkbenchGraphExploreMode;
  readonly limit?: number | undefined;
  readonly nodeId?: string | undefined;
  readonly search?: string | undefined;
}): true | string =>
  query.mode === "page"
    ? (query.nodeId === undefined && query.search === undefined) ||
      "A page query carries no nodeId or search."
    : query.mode === "neighbors"
      ? query.nodeId === undefined || query.search !== undefined
        ? "A neighbors query carries exactly one nodeId."
        : query.limit === undefined ||
          query.limit >= 2 ||
          "A neighbors query needs a limit of at least 2."
      : (query.search !== undefined && query.nodeId === undefined) ||
        "A search query carries exactly one literal search string.";

/** The normalized query a response echoes: defaults applied. */
export const WorkbenchGraphExploreQuery = Schema.Struct({
  mode: WorkbenchGraphExploreMode,
  offset: NonNegativeInt,
  limit: GraphExploreLimit,
  nodeId: Schema.optional(GraphExploreNodeId),
  search: Schema.optional(GraphExploreSearch),
}).check(Schema.makeFilter(graphExploreQueryShape));
export type WorkbenchGraphExploreQuery = typeof WorkbenchGraphExploreQuery.Type;

/** A request query: offset defaults to 0 and limit to 100. */
export const WorkbenchGraphExploreQueryInput = Schema.Struct({
  mode: WorkbenchGraphExploreMode,
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(GraphExploreLimit),
  nodeId: Schema.optional(GraphExploreNodeId),
  search: Schema.optional(GraphExploreSearch),
}).check(Schema.makeFilter(graphExploreQueryShape));
export type WorkbenchGraphExploreQueryInput = typeof WorkbenchGraphExploreQueryInput.Type;

/** The full current display projection a page belongs to. */
export const WorkbenchGraphExploreSnapshot = Schema.Struct({
  sessionCursor: RecordSessionCursor,
  digest: Hex64,
});
export type WorkbenchGraphExploreSnapshot = typeof WorkbenchGraphExploreSnapshot.Type;

/** The existing graph body with the explorer's per-response display bounds. */
export const ProviderWorkbenchGraphExploreBody = Schema.Struct({
  ...ProviderWorkbenchGraphBody.fields,
  nodes: Schema.Array(ProviderWorkbenchGraphNode).check(
    Schema.isMaxLength(WORKBENCH_GRAPH_EXPLORE_MAX_NODES),
  ),
  edges: Schema.Array(ProviderWorkbenchGraphEdge).check(
    Schema.isMaxLength(WORKBENCH_GRAPH_EXPLORE_MAX_EDGES),
  ),
});
export type ProviderWorkbenchGraphExploreBody = typeof ProviderWorkbenchGraphExploreBody.Type;

/** Recorded kind/status counts of the full projection (statuses only where
 * recorded). A summary of actual records, never a completion proof. */
export const WorkbenchGraphExploreCounts = Schema.Struct({
  byKind: Schema.Record(Schema.String, NonNegativeInt),
  byStatus: Schema.Record(Schema.String, NonNegativeInt),
});
export type WorkbenchGraphExploreCounts = typeof WorkbenchGraphExploreCounts.Type;

export const ProviderWorkbenchGraphExplore = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literals(["available", "stale"]),
  graphType: Schema.Literals(["work", "context"]),
  sessionCursor: RecordSessionCursor,
  gatewayCursor: WorkbenchRecordCursor,
  snapshot: WorkbenchGraphExploreSnapshot,
  query: WorkbenchGraphExploreQuery,
  nextOffset: Schema.NullOr(PositiveInt),
  graph: ProviderWorkbenchGraphExploreBody,
  counts: WorkbenchGraphExploreCounts,
  /** Size of the query's whole candidate pool (all nodes for page mode). */
  matchedNodes: NonNegativeInt,
});
export type ProviderWorkbenchGraphExplore = typeof ProviderWorkbenchGraphExplore.Type;

export const ProviderWorkbenchGraphExploreResult = Schema.Struct({
  status: Schema.Literals(["available", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  explore: Schema.optional(ProviderWorkbenchGraphExplore),
});
export type ProviderWorkbenchGraphExploreResult = typeof ProviderWorkbenchGraphExploreResult.Type;

export const ProviderExploreWorkbenchGraphInput = Schema.Struct({
  threadId: ThreadId,
  graphType: Schema.Literals(["work", "context"]),
  query: WorkbenchGraphExploreQueryInput,
  snapshot: Schema.optional(WorkbenchGraphExploreSnapshot),
});
export type ProviderExploreWorkbenchGraphInput = typeof ProviderExploreWorkbenchGraphInput.Type;

export class ProviderWorkbenchGraphExploreError extends Schema.TaggedError<ProviderWorkbenchGraphExploreError>()(
  "ProviderWorkbenchGraphExploreError",
  {
    threadId: ThreadId,
    graphType: Schema.Literals(["work", "context"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to explore the recorded ${this.graphType} graph for thread ${this.threadId}.`;
  }
}

// --- Workbench decisions and prepared branches (Dokkabi R8) ---
//
// The closed typed shapes behind the decision/branch facade, mirroring the
// harness gateway's ACTUAL wire (dokkabi-dev src/dash/workbench.ts
// decisionWire/decisions and src/dash/workbench-decisions.ts items): the
// recorded decision item/snapshot, the exact prepared-child descriptor and
// the mutation result whose states are the frozen workbench.decision
// vocabulary. None of these can carry credentials, policy or caller
// authority, and no state is an applied or verified model result — "ready"
// proves a prepared child conversation only.

/** Host decision/checkpoint id vocabulary: lowercase-first, ≤128. */
const WorkbenchDecisionId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/u));
/** Host command id vocabulary: alphanumeric-first, ≤128. */
const WorkbenchDecisionCommandId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
);
/** Host option id vocabulary: lowercase-first, ≤64. */
const WorkbenchDecisionOptionId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
);

export const WorkbenchDecisionOption = Schema.Struct({
  id: WorkbenchDecisionOptionId,
  label: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
});
export type WorkbenchDecisionOption = typeof WorkbenchDecisionOption.Type;

/** Bounded operator definition bounds mirroring the harness open contract. */
export const WORKBENCH_DECISION_MIN_OPTIONS = 2;
export const WORKBENCH_DECISION_MAX_OPTIONS = 16;

/** A recorded source row reference: seq within one verified prefix plus hash. */
const WorkbenchDecisionEventRef = Schema.Struct({
  seq: PositiveInt,
  hash: Hex64,
});

/**
 * The shared prepared-state overlay on a decisions item: `unknown` (a runtime
 * start intent exists, unconfirmed) or `ready` (the confirmed child with its
 * actual start command). ABSENT means no runtime start. Recorded prepared
 * state — never an applied, verified or model-available claim.
 */
export const ProviderWorkbenchDecisionPreparation = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("unknown"),
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    commandId: WorkbenchDecisionCommandId,
    child: Schema.Struct({
      id: WorkbenchDecisionId,
      sessionId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
      workspacePath: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
      parent: Schema.Struct({ clientId: Schema.String, threadId: Schema.String }),
      binding: Schema.Struct({ clientId: Schema.String, threadId: Schema.String }),
    }),
  }),
]);
export type ProviderWorkbenchDecisionPreparation = typeof ProviderWorkbenchDecisionPreparation.Type;

/**
 * One recorded decision as the decisions read reports it (the harness
 * WorkbenchDecisionItem): immutable question/options/recommendation/
 * rationale plus selection/application facts and local citations. `state` is
 * the fold's fact — awaiting, selected, or application_pending (an admitted
 * application whose execution stays unknown). There is no applied state.
 */
export const ProviderWorkbenchDecisionItem = Schema.Struct({
  id: WorkbenchDecisionId,
  state: Schema.Literals(["awaiting", "selected", "application_pending"]),
  revision: NonNegativeInt,
  kind: Schema.Literal("branch"),
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  options: Schema.Array(WorkbenchDecisionOption).check(
    Schema.isMinLength(WORKBENCH_DECISION_MIN_OPTIONS),
    Schema.isMaxLength(WORKBENCH_DECISION_MAX_OPTIONS),
  ),
  recommendation: WorkbenchDecisionOptionId,
  rationale: Schema.String.check(Schema.isMaxLength(2000)),
  policy: Schema.NullOr(
    Schema.Struct({
      id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
      version: PositiveInt,
      deadline: NonNegativeInt,
    }),
  ),
  selected: Schema.NullOr(
    Schema.Struct({
      option: WorkbenchDecisionOptionId,
      actor: Schema.Literals(["human", "policy"]),
      commandId: WorkbenchDecisionCommandId,
      seq: PositiveInt,
    }),
  ),
  application: Schema.NullOr(
    Schema.Struct({
      commandId: WorkbenchDecisionCommandId,
      state: Schema.Literal("unknown"),
      seq: PositiveInt,
    }),
  ),
  alternateOf: Schema.NullOr(
    Schema.Struct({
      id: WorkbenchDecisionId,
      selectionSeq: PositiveInt,
    }),
  ),
  citations: Schema.Struct({
    open: PositiveInt,
    selected: Schema.NullOr(PositiveInt),
    application: Schema.NullOr(PositiveInt),
  }),
  /** Recorded prepared-state overlay; absent means no runtime start. */
  preparation: Schema.optional(ProviderWorkbenchDecisionPreparation),
});
export type ProviderWorkbenchDecisionItem = typeof ProviderWorkbenchDecisionItem.Type;

/**
 * The decision snapshot as mutations and status report it (the harness
 * decisionWire shape): the same recorded facts with full reference detail.
 */
export const ProviderWorkbenchDecisionSnapshot = Schema.Struct({
  id: WorkbenchDecisionId,
  revision: NonNegativeInt,
  state: Schema.Literals(["awaiting", "selected", "application_pending"]),
  kind: Schema.Literal("branch"),
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  options: Schema.Array(WorkbenchDecisionOption).check(
    Schema.isMinLength(WORKBENCH_DECISION_MIN_OPTIONS),
    Schema.isMaxLength(WORKBENCH_DECISION_MAX_OPTIONS),
  ),
  recommendation: WorkbenchDecisionOptionId,
  rationale: Schema.String.check(Schema.isMaxLength(2000)),
  policy: Schema.NullOr(
    Schema.Struct({
      id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
      version: PositiveInt,
      afterMs: PositiveInt,
      deadline: NonNegativeInt,
    }),
  ),
  openedAt: NonNegativeInt,
  selected: Schema.NullOr(
    Schema.Struct({
      option: WorkbenchDecisionOptionId,
      actor: Schema.Literals(["human", "policy"]),
      commandId: WorkbenchDecisionCommandId,
      at: NonNegativeInt,
      ref: WorkbenchDecisionEventRef,
    }),
  ),
  application: Schema.NullOr(
    Schema.Struct({
      commandId: WorkbenchDecisionCommandId,
      state: Schema.Literal("unknown"),
      ref: WorkbenchDecisionEventRef,
    }),
  ),
  alternateOf: Schema.NullOr(
    Schema.Struct({
      id: WorkbenchDecisionId,
      selection: WorkbenchDecisionEventRef,
    }),
  ),
  citations: Schema.Struct({
    open: PositiveInt,
    selected: Schema.NullOr(PositiveInt),
    application: Schema.NullOr(PositiveInt),
  }),
});
export type ProviderWorkbenchDecisionSnapshot = typeof ProviderWorkbenchDecisionSnapshot.Type;

/**
 * The prepared child conversation descriptor — exactly the host's wire
 * fields. The child's binding client equals its parent's client, its thread
 * is distinct, and `workspacePath` is the harness-owned child root reported
 * by the host.
 */
export const ProviderWorkbenchBranchDescriptor = Schema.Struct({
  id: WorkbenchDecisionId,
  sessionId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  workspacePath: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  parent: Schema.Struct({ clientId: Schema.String, threadId: Schema.String }),
  binding: Schema.Struct({ clientId: Schema.String, threadId: Schema.String }),
});
export type ProviderWorkbenchBranchDescriptor = typeof ProviderWorkbenchBranchDescriptor.Type;

/**
 * The provider.getWorkbenchDecisions result. The wire's own view states pass
 * through unchanged: "available" carries the newest whole items with
 * explicit totals and the gateway's execution-capability fact; "missing"
 * means this session recorded no decision rows; "invalid" means the retained
 * decision authority refused. "unavailable" means the recorded source is
 * detached/unbound right now; "unsupported" means this provider or an older
 * pre-R8 gateway has no decisions capability. None is an empty success.
 */
export const ProviderWorkbenchDecisionsResult = Schema.Struct({
  status: Schema.Literals(["available", "missing", "invalid", "unavailable", "unsupported"]),
  reason: Schema.optional(Schema.String),
  decisions: Schema.optional(Schema.Array(ProviderWorkbenchDecisionItem)),
  total: Schema.optional(NonNegativeInt),
  omitted: Schema.optional(NonNegativeInt),
  /** The gateway's own execution capability fact for this session. */
  executionSupported: Schema.optional(Schema.Boolean),
});
export type ProviderWorkbenchDecisionsResult = typeof ProviderWorkbenchDecisionsResult.Type;

export const ProviderGetWorkbenchDecisionsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderGetWorkbenchDecisionsInput = typeof ProviderGetWorkbenchDecisionsInput.Type;

/** A decision creation definition WITHOUT checkpoint identity: the server
 * captures the compatible checkpoint at the thread's actual current read
 * cursor and opens the immutable definition with the returned real digest. */
export const ProviderWorkbenchDecisionDefinition = Schema.Struct({
  id: WorkbenchDecisionId,
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  options: Schema.Array(WorkbenchDecisionOption).check(
    Schema.isMinLength(WORKBENCH_DECISION_MIN_OPTIONS),
    Schema.isMaxLength(WORKBENCH_DECISION_MAX_OPTIONS),
  ),
  recommendation: WorkbenchDecisionOptionId,
  rationale: Schema.String.check(Schema.isMaxLength(2000)),
});
export type ProviderWorkbenchDecisionDefinition = typeof ProviderWorkbenchDecisionDefinition.Type;

export const ProviderCreateWorkbenchDecisionInput = Schema.Struct({
  threadId: ThreadId,
  definition: ProviderWorkbenchDecisionDefinition,
});
export type ProviderCreateWorkbenchDecisionInput = typeof ProviderCreateWorkbenchDecisionInput.Type;

export const ProviderSelectWorkbenchDecisionInput = Schema.Struct({
  threadId: ThreadId,
  id: WorkbenchDecisionId,
  commandId: WorkbenchDecisionCommandId,
  expectedRevision: NonNegativeInt,
  option: WorkbenchDecisionOptionId,
});
export type ProviderSelectWorkbenchDecisionInput = typeof ProviderSelectWorkbenchDecisionInput.Type;

export const ProviderStartWorkbenchBranchInput = Schema.Struct({
  threadId: ThreadId,
  id: WorkbenchDecisionId,
  commandId: WorkbenchDecisionCommandId,
  expectedRevision: NonNegativeInt,
  /** The app target thread created FIRST through the normal thread-create
   * operation (same project/provider instance/runtime mode; no Send yet). */
  childThreadId: ThreadId,
});
export type ProviderStartWorkbenchBranchInput = typeof ProviderStartWorkbenchBranchInput.Type;

/**
 * The provider decision/branch mutation result — the frozen workbench.decision
 * state vocabulary. "ready" carries the prepared child descriptor; "unknown"
 * is an uncertain mutation (e.g. a lost start acknowledgement) that must not
 * be blindly retried; "conflict" is a revision/CAS or changed-command
 * refusal. No state means applied or verified work.
 */
export const ProviderWorkbenchDecisionActionResult = Schema.Struct({
  state: Schema.Literals(["unsupported", "available", "unknown", "conflict", "ready"]),
  reason: Schema.optional(Schema.String),
  decision: Schema.optional(ProviderWorkbenchDecisionSnapshot),
  child: Schema.optional(ProviderWorkbenchBranchDescriptor),
});
export type ProviderWorkbenchDecisionActionResult =
  typeof ProviderWorkbenchDecisionActionResult.Type;

/** A decision/branch mutation failed at the provider/source boundary: foreign
 * instance/thread/source identity, replaced source, contract violation or
 * transport failure. Never used for unsupported/unknown/conflict — those are
 * typed result states. */
export class ProviderWorkbenchDecisionError extends Schema.TaggedError<ProviderWorkbenchDecisionError>()(
  "ProviderWorkbenchDecisionError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to execute the workbench decision operation for thread ${this.threadId}.`;
  }
}

// --- Explicit recorded-parent reconnect (Dokkabi R8) ---
//
// One closed THREAD-ONLY operator mutation: the renderer names the thread and
// nothing else — no provider, model, path, cursor, credential, command text
// or policy can cross the wire. The server resolves the exact durable
// binding/instance/runtime/parent state, requires the harness-owned
// workspaceLifecycle capability and a genuine recorded source, and reuses the
// normal validated recovery path. "available" proves a reconnected recorded
// source ONLY — never model work, a decision selection or a prepared child.

// Validate raw keys before Struct decoding can strip unknown authority.
const resumeObjectKeys = (allowed: ReadonlyArray<string>) =>
  Schema.Unknown.check(
    Schema.makeFilter(
      (input: unknown) =>
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Reflect.ownKeys(input).every((key) => typeof key === "string" && allowed.includes(key)),
      { expected: `an object containing only ${allowed.join(", ")}` },
    ),
  );

export const ProviderResumeWorkbenchSessionInput = resumeObjectKeys(["threadId"]).pipe(
  Schema.decodeTo(Schema.Struct({ threadId: ThreadId })),
);
export type ProviderResumeWorkbenchSessionInput = typeof ProviderResumeWorkbenchSessionInput.Type;

/**
 * The provider.resumeWorkbenchSession result. "available" means the exact
 * persisted PARENT conversation is reconnected through the normal validated
 * startup/adoption path — a reconnected source only, never model work.
 * "unsupported" means no persisted binding, an unregistered/disabled instance
 * or a provider without the harness workspace capability (ordinary providers
 * and drafts stay unsupported — never an invented session). "unknown" means
 * the resume was attempted but refused (missing recorded source, replaced
 * source, workspace/generation mismatch, failed durable publication); the
 * bounded reason names the refusal. No state is ever an empty success, and
 * the result carries no fields beyond the closed state/reason pair.
 */
export const ProviderWorkbenchResumeResult = resumeObjectKeys(["state", "reason"]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      state: Schema.Literals(["available", "unsupported", "unknown"]),
      reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
    }),
  ),
);
export type ProviderWorkbenchResumeResult = typeof ProviderWorkbenchResumeResult.Type;

/** An explicit reconnect failed at the provider/source boundary beyond the
 * closed result vocabulary (defects and infrastructure failures). Never used
 * for unsupported/unknown — those are typed result states. */
export class ProviderWorkbenchResumeError extends Schema.TaggedError<ProviderWorkbenchResumeError>()(
  "ProviderWorkbenchResumeError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to reconnect the recorded workbench conversation for thread ${this.threadId}.`;
  }
}

// --- Explicit session work mode (Dokkabi R8-06j2) ---
//
// The closed typed shapes behind the explicit work-mode facade, mirroring the
// harness gateway's additive `workbench.workMode` result (dokkabi-dev
// src/chat/work-mode.ts): the host's actual configuration snapshot for future
// routing, the applied control-update receipt, and the frozen refusal
// vocabulary. "applied" proves the session's control file was written — never
// task success or an execution truth verdict. No path, session id, token,
// model, policy, callback or graph can cross these shapes from the renderer.

/** Opaque control revision: SHA-256 over trusted session scope, exact
 * control bytes (or absence) and the kernel standing default. Never a counter. */
const WorkModeRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** Host command id vocabulary (same as decisions): alphanumeric-first, ≤128. */
const WorkbenchWorkModeCommandId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
);

export type WorkbenchWorkModeKind = "default" | "chat" | "work";

/**
 * The host's actual work-mode configuration for the session's future routing:
 * the effective standing Chat/Work, whether it comes from the standing
 * default or this session's recorded override, and the opaque revision a set
 * must echo. A snapshot, never an execution truth verdict.
 */
export const ProviderWorkbenchWorkModeSelection = Schema.Struct({
  mode: Schema.Literals(["default", "chat", "work"]),
  effective: Schema.Literals(["chat", "work"]),
  source: Schema.Literals(["default", "session"]),
  revision: WorkModeRevision,
}).check(
  Schema.makeFilter(
    (selection) =>
      (selection.mode === "default"
        ? selection.source === "default"
        : selection.source === "session" && selection.effective === selection.mode) ||
      "Work mode, source and effective mode are inconsistent.",
  ),
);
export type ProviderWorkbenchWorkModeSelection = typeof ProviderWorkbenchWorkModeSelection.Type;

/**
 * The provider.getWorkbenchWorkMode result. "available" carries the host's
 * actual configuration and busy fact; "unavailable" means the recorded source
 * is detached/unbound right now (an explicit Send may resume the binding);
 * "unsupported" means this provider or gateway has no work-mode capability
 * (ordinary providers, disabled instances, older pre-R8-06j2 gateways).
 * Neither non-available state is ever an empty success.
 */
export const ProviderWorkbenchWorkModeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    selection: ProviderWorkbenchWorkModeSelection,
    busy: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literals(["unavailable", "unsupported"]),
    reason: Schema.optional(Schema.String),
  }),
]);
export type ProviderWorkbenchWorkModeResult = typeof ProviderWorkbenchWorkModeResult.Type;

/**
 * The provider.setWorkbenchWorkMode and provider.workbenchWorkModeStatus
 * result — the wire's own frozen state vocabulary. "applied" is a control
 * update receipt carrying the exact post-effect selection (duplicate marks a
 * stored receipt returned without applying again); "conflict" is a stale
 * revision or changed-command refusal; "busy" means the session has
 * unresolved work; "unknown" is an uncertain mutation (e.g. a lost
 * acknowledgement or an unsettled durable intent) that must not be blindly
 * retried. No state means applied task success or verified work.
 */
export const ProviderWorkbenchWorkModeActionResult = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("applied"),
    commandId: WorkbenchWorkModeCommandId,
    selection: ProviderWorkbenchWorkModeSelection,
    duplicate: Schema.Boolean,
  }),
  Schema.Struct({
    state: Schema.Literals(["conflict", "busy", "unknown", "unsupported", "unavailable"]),
    reason: Schema.optional(Schema.String),
    commandId: Schema.optional(WorkbenchWorkModeCommandId),
  }),
]);
export type ProviderWorkbenchWorkModeActionResult =
  typeof ProviderWorkbenchWorkModeActionResult.Type;

/** Validate raw keys before Struct decoding can strip unknown authority. */
const workModeObjectKeys = (allowed: ReadonlyArray<string>) =>
  Schema.Unknown.check(
    Schema.makeFilter(
      (input: unknown) =>
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Reflect.ownKeys(input).every((key) => typeof key === "string" && allowed.includes(key)),
      { expected: `an object containing only ${allowed.join(", ")}` },
    ),
  );

/** The read request: the thread id only — the server derives the binding. */
export const ProviderGetWorkbenchWorkModeInput = workModeObjectKeys(["threadId"]).pipe(
  Schema.decodeTo(Schema.Struct({ threadId: ThreadId })),
);
export type ProviderGetWorkbenchWorkModeInput = typeof ProviderGetWorkbenchWorkModeInput.Type;

/** The set request: one explicit operator attempt's stable command id, the
 * displayed revision and the closed mode — nothing else crosses the wire. */
export const ProviderSetWorkbenchWorkModeInput = workModeObjectKeys([
  "threadId",
  "commandId",
  "expectedRevision",
  "mode",
]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      threadId: ThreadId,
      commandId: WorkbenchWorkModeCommandId,
      expectedRevision: WorkModeRevision,
      mode: Schema.Literals(["default", "chat", "work"]),
    }),
  ),
);
export type ProviderSetWorkbenchWorkModeInput = typeof ProviderSetWorkbenchWorkModeInput.Type;

/** The status request: the thread and the command id to reconstruct. */
export const ProviderWorkbenchWorkModeStatusInput = workModeObjectKeys([
  "threadId",
  "commandId",
]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      threadId: ThreadId,
      commandId: WorkbenchWorkModeCommandId,
    }),
  ),
);
export type ProviderWorkbenchWorkModeStatusInput = typeof ProviderWorkbenchWorkModeStatusInput.Type;

/** A work-mode operation failed at the provider/source boundary: identity
 * mismatch, contract violation or transport failure. Never used for the
 * closed refusal states — those are typed result states. */
export class ProviderWorkbenchWorkModeError extends Schema.TaggedError<ProviderWorkbenchWorkModeError>()(
  "ProviderWorkbenchWorkModeError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read or set the workbench work mode for thread ${this.threadId}.`;
  }
}

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
