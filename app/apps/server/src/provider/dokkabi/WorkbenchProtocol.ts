import {
  CodeSelection,
  CodeSessionCursor,
  WorkbenchCode,
  CodeActionRequestFields,
  WorkbenchCodeActionResponse,
} from "@t3tools/contracts";
// @effect-diagnostics preferSchemaOverJson:off
/**
 * Dokkabi workbench wire protocol — closed client-side schemas.
 *
 * Mirrors the harness gateway's `workbench.*` JSON-RPC surface
 * (dokkabi-dev src/dash/workbench.ts) as exact Effect schemas. Every
 * request and response is validated on this side; unknown keys decode as
 * errors so a gateway contract drift fails loudly instead of flowing
 * unvalidated data into the app. Golden fixtures (including a capture of a
 * REAL gateway session) pin the encoding in
 * `WorkbenchProtocol.testFixtures.ts` and `dokkabi-real-gateway.fixture.json`
 * — the app build never imports harness source.
 *
 * Evidence labels match the gateway contract and never overclaim:
 * `handed_off` proves frontend handoff, not model delivery; `accepted`
 * proves a durable model-facing user/message (its seq/hash recorded on the
 * acceptance row); `settled` is the turn outcome — none of them are
 * verified work.
 *
 * @module provider/dokkabi/WorkbenchProtocol
 */
import {
  ProviderWorkbenchUsageReport,
  ProviderWorkbenchWorkModeSelection,
  WORKBENCH_RECORD_BODY_MAX_BASE64,
  WORKBENCH_RECORD_BODY_MAX_BYTES,
  WORKBENCH_RECORD_DESCRIPTOR_TEXT_MAX,
  WorkbenchGraphExploreQuery,
  WorkbenchGraphExploreQueryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export const WORKBENCH_PROTOCOL_VERSION = 1;

/** Decode options rejecting any property the closed schemas do not model —
 * a gateway contract drift fails loudly instead of flowing through. */
export const STRICT_DECODE_OPTIONS = { onExcessProperty: "error" } as const;

/** Gateway ids: alphanumeric first, then [A-Za-z0-9._-]{0,127}. */
export const WorkbenchId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
);
export type WorkbenchId = typeof WorkbenchId.Type;

const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const WorkbenchCursor = Schema.Struct({
  seq: NonNegativeInt,
  hash: Hex64,
  generation: Hex64,
});
export type WorkbenchCursor = typeof WorkbenchCursor.Type;

export const WorkbenchSessionCursor = Schema.Struct({
  ...WorkbenchCursor.fields,
  sessionId: WorkbenchId,
});
export type WorkbenchSessionCursor = typeof WorkbenchSessionCursor.Type;

export const WorkbenchBinding = Schema.Struct({
  clientId: WorkbenchId,
  threadId: WorkbenchId,
});
export type WorkbenchBinding = typeof WorkbenchBinding.Type;

// --- Requests ---

const VersionField = { version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION) };

export const HandshakeParams = Schema.Struct({ ...VersionField });
export type HandshakeParams = typeof HandshakeParams.Type;

export const ModelSelectionParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  route: Schema.String,
  model: Schema.String,
  expectedRoute: Schema.String,
  expectedModel: Schema.String,
});

export const BindParams = Schema.Struct({
  ...VersionField,
  clientId: WorkbenchId,
  threadId: WorkbenchId,
  workspacePath: Schema.String.check(Schema.isNonEmpty()),
});
export type BindParams = typeof BindParams.Type;

export const ReadParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  sessionCursor: Schema.optional(WorkbenchSessionCursor),
  gatewayCursor: Schema.optional(WorkbenchCursor),
});
export type ReadParams = typeof ReadParams.Type;

export const SubmitParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  commandId: WorkbenchId,
  text: Schema.String.check(Schema.isNonEmpty()),
});
export type SubmitParams = typeof SubmitParams.Type;

export const CommandStatusParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  commandId: WorkbenchId,
});
export type CommandStatusParams = typeof CommandStatusParams.Type;

export const CancelParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  commandId: WorkbenchId,
  targetCommandId: WorkbenchId,
});
export type CancelParams = typeof CancelParams.Type;

export const DetachParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
});
export type DetachParams = typeof DetachParams.Type;

/** R3 additive read-only overview. Same closed shape as workbench.read's
 * cursor parameters; the result is the harness's recorded overview. */
export const OverviewParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  sessionCursor: Schema.optional(WorkbenchSessionCursor),
  gatewayCursor: Schema.optional(WorkbenchCursor),
});
export type OverviewParams = typeof OverviewParams.Type;

/** R4 additive read-only recorded graph. Adds the closed graphType to the
 * same cursor shape; a graph read never advances the transcript cursor. */
export const GraphParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  graphType: Schema.Literals(["work", "context"]),
  sessionCursor: Schema.optional(WorkbenchSessionCursor),
  gatewayCursor: Schema.optional(WorkbenchCursor),
});
export type GraphParams = typeof GraphParams.Type;

/** R5 additive read-only exact retained record page. Paging cursors only —
 * the renderer never chooses a session or path; the thread's own binding
 * does. A record read never advances the transcript cursors. */
export const CodeParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  after: Schema.optional(CodeSessionCursor),
  selection: Schema.optional(CodeSelection),
  sessionCursor: Schema.optional(CodeSessionCursor),
  gatewayCursor: Schema.optional(WorkbenchCursor),
}).check(
  Schema.makeFilter(
    (input) => !(input.after && input.selection) || "Body reads cannot acknowledge an index",
  ),
);
export const CodeResponse = WorkbenchCode;
export type CodeResponse = typeof CodeResponse.Type;
export const CodeActionParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  ...CodeActionRequestFields,
});
export const CodeActionResponse = WorkbenchCodeActionResponse;
export type CodeActionResponse = typeof CodeActionResponse.Type;

export const RecordParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  after: Schema.optional(WorkbenchCursor),
  asOf: Schema.optional(WorkbenchSessionCursor),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type RecordParams = typeof RecordParams.Type;

/** Bounded explorer metadata index: same paging cursors as workbench.record. */
export const RecordIndexParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  after: Schema.optional(WorkbenchCursor),
  asOf: Schema.optional(WorkbenchSessionCursor),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type RecordIndexParams = typeof RecordIndexParams.Type;

/** One canonical byte range of one exact row under a REQUIRED pin. No path,
 * blob or source selector exists: the row cursor and pin name the bytes. */
export const RecordBodyParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  row: WorkbenchCursor,
  asOf: WorkbenchSessionCursor,
  offset: NonNegativeInt,
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WORKBENCH_RECORD_BODY_MAX_BYTES),
    ),
  ),
});
export type RecordBodyParams = typeof RecordBodyParams.Type;

const GraphExploreSnapshot = Schema.Struct({
  sessionCursor: WorkbenchSessionCursor,
  digest: Hex64,
});

/** One bounded page/search/neighbors query over the full display projection,
 * optionally pinned to the snapshot an earlier page answered. */
export const GraphExploreParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  graphType: Schema.Literals(["work", "context"]),
  query: WorkbenchGraphExploreQueryInput,
  snapshot: Schema.optional(GraphExploreSnapshot),
});
export type GraphExploreParams = typeof GraphExploreParams.Type;

/** R8 additive read-only scoped usage. Same closed shape as
 * workbench.overview's cursor parameters; the result is the harness's
 * recorded run-scoped usage report (main prefix plus referenced children). */
export const UsageParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  sessionCursor: Schema.optional(WorkbenchSessionCursor),
  gatewayCursor: Schema.optional(WorkbenchCursor),
});
export type UsageParams = typeof UsageParams.Type;

// --- Transcript projection cards ---

const CardBase = {
  seq: PositiveInt,
  ts: Schema.String,
};

export const WorkbenchNoteCard = Schema.Struct({
  ...CardBase,
  kind: Schema.Literal("note"),
  text: Schema.String,
});

export const WorkbenchAssistantCard = Schema.Struct({
  ...CardBase,
  kind: Schema.Literal("assistant"),
  text: Schema.String,
  thinking: Schema.optional(Schema.String),
  stop: Schema.optional(Schema.String),
});

/**
 * Tool completion refs: the actual correlated `tool/end` source record for
 * THIS invocation (seq + hash, always as a pair). The gateway enriches each
 * copied tool card by scanning verified session events; an id's reuse never
 * attaches a later invocation's end to an earlier card. `durationMs` stays a
 * MEASUREMENT (allowed to be "missing") and is never completion evidence —
 * only these refs mean the tool settled. Absent refs = still running.
 */
export const WorkbenchToolCard = Schema.Struct({
  ...CardBase,
  kind: Schema.Literal("tool"),
  id: Schema.String,
  tool: Schema.String,
  argHint: Schema.optional(Schema.String),
  resultText: Schema.optional(Schema.String),
  completionSeq: Schema.optional(PositiveInt),
  completionHash: Schema.optional(Hex64),
  durationMs: Schema.Union([NonNegativeInt, Schema.Literal("missing")]),
  error: Schema.Boolean,
}).check(
  Schema.makeFilter((card) =>
    (card.completionSeq === undefined) === (card.completionHash === undefined)
      ? true
      : "completionSeq and completionHash must be present or absent together",
  ),
);

export const WorkbenchApprovalCard = Schema.Struct({
  ...CardBase,
  kind: Schema.Literal("approval"),
  requestId: Schema.String,
  approvalKind: Schema.String,
  target: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  state: Schema.Literals(["requested", "resolved"]),
});

export const WorkbenchSystemCard = Schema.Struct({
  ...CardBase,
  kind: Schema.Literal("system"),
  event: Schema.String,
  text: Schema.String,
});

export const WorkbenchCard = Schema.Union([
  WorkbenchNoteCard,
  WorkbenchAssistantCard,
  WorkbenchToolCard,
  WorkbenchApprovalCard,
  WorkbenchSystemCard,
]);
export type WorkbenchCard = typeof WorkbenchCard.Type;

// --- Responses ---

export const WorkbenchCommandState = Schema.Literals([
  "unknown",
  "rejected",
  "staged",
  "handed_off",
  "accepted",
  "settled",
]);
export type WorkbenchCommandState = typeof WorkbenchCommandState.Type;

export const WorkbenchSettlementOutcome = Schema.Literals(["success", "failure", "operator_abort"]);
export type WorkbenchSettlementOutcome = typeof WorkbenchSettlementOutcome.Type;

const CommandStateFields = {
  state: WorkbenchCommandState,
  outcome: Schema.optional(WorkbenchSettlementOutcome),
  detail: Schema.optional(Schema.String),
  sources: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.Number, Schema.String])),
  ),
  messageSeq: Schema.optional(PositiveInt),
  messageHash: Schema.optional(Hex64),
};

export const HandshakeResponse = Schema.Struct({
  version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
  workspacePath: Schema.String,
  sessionId: WorkbenchId,
  capabilities: Schema.Struct({
    submit: Schema.Boolean,
    cancel: Schema.Boolean,
    read: Schema.Boolean,
    detach: Schema.Boolean,
    attachments: Schema.Boolean,
    continuation: Schema.Boolean,
    compaction: Schema.Boolean,
    rollback: Schema.Boolean,
    approvals: Schema.Boolean,
    userInput: Schema.Boolean,
    modelChange: Schema.Boolean,
    /** Optional R8-06j2 host capability: absent/false on older peers means
     * the app never calls workbench.workMode there. */
    workMode: Schema.optional(Schema.Boolean),
    codeAction: Schema.optional(Schema.Boolean),
  }),
  route: Schema.String,
  model: Schema.optional(Schema.String),
  /** Authenticated harness metadata; connected is not model readiness. */
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        route: Schema.String,
        provider: Schema.String,
        model: Schema.String,
        name: Schema.String,
        connected: Schema.Boolean,
      }),
    ),
  ),
  ready: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  /** "configured": the saved operator selection, unprobed. "kernel": a live runtime identity. */
  routeSource: Schema.Literals(["configured", "kernel"]),
  /**
   * The harness's ACTUAL permission policy, reported by the gateway (never
   * selected by the app): `resolvePermissionMode` before the kernel opens,
   * the live permission controller's mode once it is open. Fixed vocabulary.
   */
  permissionMode: Schema.Literals(["ask", "auto", "bypass"]),
  kernelOpen: Schema.Boolean,
  bound: Schema.optional(Schema.Struct({ clientId: WorkbenchId, threadId: WorkbenchId })),
});
export type HandshakeResponse = typeof HandshakeResponse.Type;

export const ModelSelectionResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("applied"),
    route: Schema.String,
    model: Schema.String,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literals(["busy", "unsupported", "confirmation_required"]),
    reason: Schema.String,
  }),
]);

export const BindResponse = Schema.Struct({
  ok: Schema.Literal(true),
  sessionId: WorkbenchId,
  workspacePath: Schema.String,
  reconnect: Schema.Boolean,
});
export type BindResponse = typeof BindResponse.Type;

export const WorkbenchCommandReceipt = Schema.Struct({
  commandId: WorkbenchId,
  ...CommandStateFields,
});
export type WorkbenchCommandReceipt = typeof WorkbenchCommandReceipt.Type;

export const ReadResponse = Schema.Struct({
  cards: Schema.Array(WorkbenchCard),
  state: Schema.Struct({
    busy: Schema.Boolean,
    activeCommandId: Schema.NullOr(WorkbenchId),
  }),
  commands: Schema.Array(WorkbenchCommandReceipt),
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  resnapshot: Schema.Boolean,
});
export type ReadResponse = typeof ReadResponse.Type;

export const SubmitResponse = Schema.Struct({
  commandId: WorkbenchId,
  ...CommandStateFields,
  /** Present on a fresh handoff: the note delivery from the frontend seam. */
  noteDelivery: Schema.optional(Schema.Literal("prompt")),
  sessionId: Schema.optional(WorkbenchId),
  duplicate: Schema.optional(Schema.Boolean),
});
export type SubmitResponse = typeof SubmitResponse.Type;

export const CommandStatusResponse = Schema.Struct({
  commandId: WorkbenchId,
  ...CommandStateFields,
});
export type CommandStatusResponse = typeof CommandStatusResponse.Type;

export const CancelResponse = Schema.Struct({
  commandId: WorkbenchId,
  targetCommandId: WorkbenchId,
  state: Schema.Literals(["requested", "already_requested", "unknown", "refused"]),
  detail: Schema.optional(Schema.String),
});
export type CancelResponse = typeof CancelResponse.Type;

export const DetachResponse = Schema.Struct({ detached: Schema.Literal(true) });
export type DetachResponse = typeof DetachResponse.Type;

// --- Recorded overview (R3) ---
//
// The exact mirror of the harness's additive workbench.overview result. The
// shared typed shape lives in @t3tools/contracts (ProviderWorkbenchOverview);
// this schema decodes the wire payload into it strictly — unknown fields are
// errors, so a gateway contract drift fails loudly instead of flowing
// unvalidated data into the app.

const OverviewHex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const OverviewPositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const OverviewNonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const OverviewSourceRef = Schema.Struct({
  seq: OverviewPositiveInt,
  hash: OverviewHex64,
});

const OverviewGoal = Schema.Struct({
  id: Schema.String,
  statement: Schema.String,
  source: OverviewSourceRef,
});

const OverviewTodoRow = Schema.Struct({
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

const OverviewCases = Schema.Struct({
  total: OverviewNonNegativeInt,
  green: OverviewNonNegativeInt,
  red: OverviewNonNegativeInt,
  pending: OverviewNonNegativeInt,
});

const OverviewWork = Schema.Struct({
  state: Schema.Literals(["missing", "available", "invalid"]),
  goal: Schema.NullOr(OverviewGoal),
  planDigest: Schema.NullOr(Schema.String),
  todos: Schema.Array(OverviewTodoRow),
  cases: Schema.NullOr(OverviewCases),
  errors: Schema.Array(Schema.String),
});

const OverviewFrame = Schema.Struct({
  id: Schema.String,
  stage: Schema.Literals(["prepared", "appended", "dispatched", "responded"]),
  source: OverviewSourceRef,
});

const OverviewContext = Schema.Struct({
  state: Schema.Literals(["missing", "available", "invalid"]),
  mode: Schema.NullOr(Schema.Literals(["shadow", "on", "unknown"])),
  revision: Schema.NullOr(OverviewNonNegativeInt),
  digest: Schema.NullOr(OverviewHex64),
  frame: Schema.NullOr(OverviewFrame),
  lessonCount: Schema.NullOr(OverviewNonNegativeInt),
  errors: Schema.Array(Schema.String),
});

const OverviewUsageMetric = Schema.Struct({
  total: Schema.NullOr(OverviewNonNegativeInt),
  missing: OverviewNonNegativeInt,
  latestSource: Schema.NullOr(OverviewSourceRef),
});

const OverviewUsage = Schema.Struct({
  records: OverviewNonNegativeInt,
  input: OverviewUsageMetric,
  output: OverviewUsageMetric,
  reasoning: OverviewUsageMetric,
  cacheRead: OverviewUsageMetric,
  cacheWrite: OverviewUsageMetric,
});

export const OverviewResponse = Schema.Struct({
  version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  resnapshot: Schema.Boolean,
  work: OverviewWork,
  context: OverviewContext,
  usage: OverviewUsage,
});
export type OverviewResponse = typeof OverviewResponse.Type;

// --- Scoped run usage (R8) ---
//
// The exact mirror of the harness's additive workbench.usage result
// (dokkabi-dev src/dash/workbench-usage.ts). The typed report shape lives
// in @t3tools/contracts (ProviderWorkbenchUsageReport); this schema decodes
// the wire envelope strictly — unknown fields are errors, so a gateway
// contract drift fails loudly instead of flowing unvalidated data into the
// app.

export const UsageResponse = Schema.Struct({
  version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  resnapshot: Schema.Boolean,
  usage: ProviderWorkbenchUsageReport,
});
export type UsageResponse = typeof UsageResponse.Type;

// --- Recorded graphs (R4) ---
//
// The exact mirror of the harness's additive workbench.graph result
// (dokkabi-dev src/dash/workbench-graph.ts). The shared typed shape lives in
// @t3tools/contracts (ProviderWorkbenchGraph); this schema decodes the wire
// payload into it strictly — unknown fields are errors, so a gateway
// contract drift fails loudly instead of flowing unvalidated data.

const GraphHex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const GraphPositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const GraphNonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const GraphSourceRef = Schema.Struct({
  seq: GraphPositiveInt,
  hash: GraphHex64,
});

const GraphId = Schema.String.check(Schema.isMaxLength(512));

const GraphDetailEntry = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(128)),
  value: Schema.String.check(Schema.isMaxLength(512)),
});

const GraphNode = Schema.Struct({
  id: GraphId,
  kind: Schema.Literals([
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
  ]),
  label: Schema.String.check(Schema.isMaxLength(400)),
  status: Schema.NullOr(
    Schema.Literals([
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
    ]),
  ),
  provenance: Schema.Literals(["canonical", "source_reference", "unresolved"]),
  sources: Schema.Array(GraphSourceRef).check(Schema.isMaxLength(32)),
  details: Schema.Array(GraphDetailEntry).check(Schema.isMaxLength(64)),
  bodyDigest: Schema.NullOr(GraphHex64),
});

const GraphEdge = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  from: GraphId,
  to: GraphId,
  // Closed vocabulary: Work's relation kinds plus the canonical
  // ContextRelation values. An arbitrary relation string is a contract
  // violation, never something to render.
  kind: Schema.Literals([
    "contains",
    "blocked_by",
    "flows",
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
  ]),
  artifact: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
  sources: Schema.Array(GraphSourceRef).check(Schema.isMaxLength(16)),
});

const GraphBody = Schema.Struct({
  state: Schema.Literals(["missing", "available", "invalid", "unavailable"]),
  mode: Schema.NullOr(Schema.Literals(["shadow", "on", "unknown"])),
  revision: Schema.NullOr(GraphNonNegativeInt),
  digest: Schema.NullOr(GraphHex64),
  // Hard display bounds mirroring the harness refusal limits (512/1536).
  nodes: Schema.Array(GraphNode).check(Schema.isMaxLength(512)),
  edges: Schema.Array(GraphEdge).check(Schema.isMaxLength(1_536)),
  waves: Schema.Array(Schema.Array(GraphId)),
  unscheduled: Schema.Array(GraphId),
  coverage: Schema.Struct({
    status: Schema.Literals(["complete", "partial", "unavailable"]),
    totalNodes: GraphNonNegativeInt,
    totalEdges: GraphNonNegativeInt,
    omittedNodes: GraphNonNegativeInt,
    omittedEdges: GraphNonNegativeInt,
  }),
  errors: Schema.Array(Schema.String),
});

export const GraphResponse = Schema.Struct({
  version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
  graphType: Schema.Literals(["work", "context"]),
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  resnapshot: Schema.Boolean,
  graph: GraphBody,
});
export type GraphResponse = typeof GraphResponse.Type;

// --- Bounded graph exploration ---
//
// The existing closed graph body with the explorer's per-response bounds
// (100 nodes, 1536 edges); the outer state is only available|stale, while
// the inner body keeps the projection's own available/missing/invalid/
// unavailable state.

const GraphExploreBody = Schema.Struct({
  ...GraphBody.fields,
  nodes: Schema.Array(GraphNode).check(Schema.isMaxLength(100)),
  edges: Schema.Array(GraphEdge).check(Schema.isMaxLength(1_536)),
});

export const GraphExploreResponse = Schema.Struct({
  version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
  state: Schema.Literals(["available", "stale"]),
  graphType: Schema.Literals(["work", "context"]),
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  snapshot: GraphExploreSnapshot,
  query: WorkbenchGraphExploreQuery,
  nextOffset: Schema.NullOr(PositiveInt),
  graph: GraphExploreBody,
  counts: Schema.Struct({
    byKind: Schema.Record(Schema.String, GraphNonNegativeInt),
    byStatus: Schema.Record(Schema.String, GraphNonNegativeInt),
  }),
  matchedNodes: GraphNonNegativeInt,
});
export type GraphExploreResponse = typeof GraphExploreResponse.Type;

// --- Workbench decisions, checkpoints and branch sessions (R8) ---
//
// Closed client-side mirrors of the harness gateway's ACTUAL decision wire
// (dokkabi-dev src/dash/workbench.ts + workbench-decisions.ts and
// src/host/branch-decision.ts / branch-checkpoint.ts behind it): the
// `workbench.decisions` read, the `workbench.checkpoint` create/read, the
// operation-dispatched `workbench.decision` mutations and the child
// `workbench.branchSession` envelope. Field names, state vocabularies, id
// patterns and bounds mirror the host source exactly; unknown fields
// (credentials, policy, caller authority) decode as errors. "ready" proves a
// prepared child conversation — never an applied or verified model result.

const R8NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const R8Hex64 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
/** host decisionIdSchema / CHECKPOINT_ID_PATTERN: lowercase-first, ≤128. */
const R8DecisionId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/u));
/** host COMMAND_ID_PATTERN: alphanumeric-first, ≤128. */
const R8CommandId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
/** host OPTION_ID_PATTERN: lowercase-first, ≤64. */
const R8OptionId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u));
/** A recorded source row reference: seq within one verified prefix plus hash. */
const R8EventRef = Schema.Struct({
  seq: PositiveInt,
  hash: R8Hex64,
});

export const WorkbenchDecisionOption = Schema.Struct({
  id: R8OptionId,
  label: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
});
export type WorkbenchDecisionOption = typeof WorkbenchDecisionOption.Type;

/** host recordedPolicySchema, as the wire snapshot reports it. */
const DecisionPolicyView = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  version: PositiveInt,
  afterMs: PositiveInt,
  deadline: R8NonNegativeInt,
});

/** The winning selection fact (host SelectedFact via decisionWire). */
const DecisionSelectedView = Schema.Struct({
  option: R8OptionId,
  actor: Schema.Literals(["human", "policy"]),
  commandId: R8CommandId,
  at: R8NonNegativeInt,
  ref: R8EventRef,
});

/** The single application admission (host ApplicationFact via decisionWire). */
const DecisionApplicationView = Schema.Struct({
  commandId: R8CommandId,
  state: Schema.Literal("unknown"),
  ref: R8EventRef,
});

/**
 * The closed decision snapshot wire shape (`decisionWire`): plain bounded
 * data with local citations. `state` is the host fold's fact — awaiting,
 * selected, or application_pending (an admitted application whose execution
 * stays unknown). There is deliberately no applied state.
 */
export const WorkbenchDecisionSnapshot = Schema.Struct({
  id: R8DecisionId,
  revision: R8NonNegativeInt,
  state: Schema.Literals(["awaiting", "selected", "application_pending"]),
  kind: Schema.Literal("branch"),
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  options: Schema.Array(WorkbenchDecisionOption).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(16),
  ),
  recommendation: R8OptionId,
  rationale: Schema.String.check(Schema.isMaxLength(2000)),
  policy: Schema.NullOr(DecisionPolicyView),
  openedAt: R8NonNegativeInt,
  selected: Schema.NullOr(DecisionSelectedView),
  application: Schema.NullOr(DecisionApplicationView),
  alternateOf: Schema.NullOr(
    Schema.Struct({
      id: R8DecisionId,
      selection: R8EventRef,
    }),
  ),
  citations: Schema.Struct({
    open: PositiveInt,
    selected: Schema.NullOr(PositiveInt),
    application: Schema.NullOr(PositiveInt),
  }),
});
export type WorkbenchDecisionSnapshot = typeof WorkbenchDecisionSnapshot.Type;

/**
 * The recorded child conversation descriptor — EXACTLY the host's
 * runtimeOutcomeWire child shape. The child's binding client equals the
 * parent's client; its thread is distinct; the workspace path is the
 * harness-owned child root (never a credential or arbitrary caller path).
 */
export const BranchDescriptorResponse = Schema.Struct({
  id: R8DecisionId,
  sessionId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  workspacePath: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(4096),
    Schema.isPattern(/^[^\u0000-\u001f]+$/u),
  ),
  parent: WorkbenchBinding,
  binding: WorkbenchBinding,
}).check(
  Schema.makeFilter((descriptor) =>
    descriptor.binding.clientId === descriptor.parent.clientId
      ? descriptor.binding.threadId !== descriptor.parent.threadId
        ? true
        : "child binding thread must be distinct from its parent thread"
      : "child binding client must equal its parent client",
  ),
);
export type BranchDescriptorResponse = typeof BranchDescriptorResponse.Type;

/**
 * The shared prepared-state overlay on a decisions item: `unknown` (a runtime
 * start intent exists, unconfirmed) or `ready` (the confirmed child with its
 * actual start command). ABSENT means no runtime start. This is recorded
 * prepared state — never an applied, verified or model-available claim.
 */
export const WorkbenchDecisionPreparation = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("unknown"),
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    commandId: R8CommandId,
    child: BranchDescriptorResponse,
  }),
]);
export type WorkbenchDecisionPreparation = typeof WorkbenchDecisionPreparation.Type;

/**
 * One `workbench.decisions` view item (`WorkbenchDecisionItem`): the same
 * recorded facts as the snapshot with the read projection's flatter cite
 * shapes (seq numbers, policy without afterMs), plus the optional recorded
 * preparation overlay.
 */
export const WorkbenchDecisionItem = Schema.Struct({
  id: R8DecisionId,
  state: Schema.Literals(["awaiting", "selected", "application_pending"]),
  revision: R8NonNegativeInt,
  kind: Schema.Literal("branch"),
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  options: Schema.Array(WorkbenchDecisionOption).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(16),
  ),
  recommendation: R8OptionId,
  rationale: Schema.String.check(Schema.isMaxLength(2000)),
  policy: Schema.NullOr(
    Schema.Struct({
      id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
      version: PositiveInt,
      deadline: R8NonNegativeInt,
    }),
  ),
  selected: Schema.NullOr(
    Schema.Struct({
      option: R8OptionId,
      actor: Schema.Literals(["human", "policy"]),
      commandId: R8CommandId,
      seq: PositiveInt,
    }),
  ),
  application: Schema.NullOr(
    Schema.Struct({
      commandId: R8CommandId,
      state: Schema.Literal("unknown"),
      seq: PositiveInt,
    }),
  ),
  alternateOf: Schema.NullOr(
    Schema.Struct({
      id: R8DecisionId,
      selectionSeq: PositiveInt,
    }),
  ),
  citations: Schema.Struct({
    open: PositiveInt,
    selected: Schema.NullOr(PositiveInt),
    application: Schema.NullOr(PositiveInt),
  }),
  preparation: Schema.optional(WorkbenchDecisionPreparation),
});
export type WorkbenchDecisionItem = typeof WorkbenchDecisionItem.Type;

/**
 * The `workbench.decisions` read result (`projectWorkbenchDecisions` view
 * under the gateway's fixed cursor/execution envelope): newest whole items,
 * at most 256 / 1 MiB with an explicit omitted count. Missing and invalid
 * retained authority stay distinct states; a read never boots a kernel,
 * appends or evaluates a deadline.
 */
export const DecisionsResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("available"),
    decisions: Schema.Array(WorkbenchDecisionItem).check(Schema.isMaxLength(256)),
    total: R8NonNegativeInt,
    omitted: R8NonNegativeInt,
    sessionCursor: WorkbenchSessionCursor,
    gatewayCursor: WorkbenchCursor,
    execution: Schema.Struct({
      supported: Schema.Boolean,
      detail: Schema.String,
    }),
  }),
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literals(["missing", "invalid"]),
    reason: Schema.String,
    decisions: Schema.Array(WorkbenchDecisionItem).check(Schema.isMaxLength(0)),
    total: Schema.Literal(0),
    omitted: Schema.Literal(0),
    sessionCursor: WorkbenchSessionCursor,
    gatewayCursor: WorkbenchCursor,
    execution: Schema.Struct({
      supported: Schema.Boolean,
      detail: Schema.String,
    }),
  }),
]);
export type DecisionsResponse = typeof DecisionsResponse.Type;

/** `workbench.decisions` request: version + binding only (host allowed keys). */
export const DecisionsParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
});
export type DecisionsParams = typeof DecisionsParams.Type;

// --- Explicit session work mode (R8-06j2) ---
//
// Closed client-side mirror of the harness gateway's additive
// `workbench.workMode` operation-dispatched surface (dokkabi-dev
// src/chat/work-mode.ts): read (effect-free, never boots a kernel), set (one
// explicit command under an expected revision) and status (read-only
// reconstruction). Exactly these request shapes travel the wire — no path,
// session id, token, model, policy, callback or graph can arrive from the
// renderer, and the response vocabulary below is frozen.

const WorkModeRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** The host's actual configuration snapshot a read or applied receipt carries. */
const WorkModeSelection = ProviderWorkbenchWorkModeSelection;

export const WorkModeParams = Schema.Union([
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("read"),
  }),
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("set"),
    commandId: R8CommandId,
    expectedRevision: WorkModeRevision,
    mode: Schema.Literals(["default", "chat", "work"]),
  }),
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("status"),
    commandId: R8CommandId,
  }),
]);
export type WorkModeParams = typeof WorkModeParams.Type;

/**
 * The `workbench.workMode` result — the host's closed envelopes: `available`
 * carries the actual configuration plus the busy fact; `applied` is a control
 * update receipt with the exact post-effect selection (duplicate marks a
 * stored receipt returned without applying again); the refusal states carry a
 * bounded reason and may echo the command id. There is deliberately no
 * success/verified vocabulary.
 */
export const WorkModeResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("available"),
    selection: WorkModeSelection,
    busy: Schema.Boolean,
  }),
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("applied"),
    commandId: R8CommandId,
    selection: WorkModeSelection,
    duplicate: Schema.Boolean,
  }),
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literals(["conflict", "busy", "unknown", "unsupported", "unavailable"]),
    reason: Schema.String,
    commandId: Schema.optional(R8CommandId),
  }),
]);
export type WorkModeResponse = typeof WorkModeResponse.Type;

/**
 * The `workbench.checkpoint` request. `create` captures at an EXACT expected
 * source head (CAS: a moved head refuses, never recaptures under the same
 * id); `read` verifies an expected digest. Ids follow the host
 * CHECKPOINT_ID_PATTERN and are derived server-side — a renderer never
 * supplies paths.
 */
export const CheckpointParams = Schema.Union([
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("create"),
    id: R8DecisionId,
    expectedSource: Schema.Struct({
      seq: R8NonNegativeInt,
      hash: R8Hex64,
    }),
  }),
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("read"),
    id: R8DecisionId,
    expectedDigest: R8Hex64,
  }),
]);
export type CheckpointParams = typeof CheckpointParams.Type;

/** host checkpointManifestSchema.coverage, exactly. */
const CheckpointCoverage = Schema.Struct({
  providerInput: Schema.Literals(["complete", "messages_only"]),
  workspace_files: Schema.Literal("retained"),
  git_metadata: Schema.Literals(["retained", "absent"]),
  external_resources: Schema.Literal("unavailable"),
  restart_scope: Schema.Literal("isolated_materialization"),
  decision_execution: Schema.Literal("unsupported"),
  branch_execution: Schema.Literal("unsupported"),
});

/**
 * The `workbench.checkpoint` result — the host's FLAT top-level shape: a
 * ready capture reports its id/digest, the bound source cursor
 * (seq/hash/generation), the workspace-image/provider-input/prefix digests
 * and the manifest coverage facts. An owned kernel without the checkpoint
 * capability reports unsupported with a reason.
 */
export const CheckpointResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("ready"),
    id: R8DecisionId,
    digest: R8Hex64,
    source: Schema.Struct({
      seq: PositiveInt,
      hash: R8Hex64,
      generation: R8NonNegativeInt,
    }),
    imageDigest: R8Hex64,
    inputDigest: R8Hex64,
    prefixHash: R8Hex64,
    coverage: CheckpointCoverage,
  }),
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("unsupported"),
    reason: Schema.String,
  }),
]);
export type CheckpointResponse = typeof CheckpointResponse.Type;

/**
 * The `workbench.decision` open definition: ONLY the immutable question/
 * options/recommendation/rationale plus decision/command/checkpoint
 * identity — no source paths, policy or model authority travel from the
 * caller. `alternateOf` optionally names an earlier selected decision of
 * the same checkpoint (host-validated).
 */
export const DecisionOpenDefinition = Schema.Struct({
  id: R8DecisionId,
  commandId: R8CommandId,
  kind: Schema.Literal("branch"),
  checkpointId: R8DecisionId,
  checkpointDigest: R8Hex64,
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  options: Schema.Array(WorkbenchDecisionOption).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(16),
  ),
  recommendation: R8OptionId,
  rationale: Schema.String.check(Schema.isMaxLength(2000)),
  alternateOf: Schema.optional(
    Schema.Struct({
      id: R8DecisionId,
      selection: R8EventRef,
    }),
  ),
});
export type DecisionOpenDefinition = typeof DecisionOpenDefinition.Type;

export const DecisionParams = Schema.Union([
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("open"),
    definition: DecisionOpenDefinition,
  }),
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("select"),
    id: R8DecisionId,
    commandId: R8CommandId,
    expectedRevision: R8NonNegativeInt,
    option: R8OptionId,
  }),
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("start"),
    id: R8DecisionId,
    commandId: R8CommandId,
    expectedRevision: R8NonNegativeInt,
    childThreadId: WorkbenchId,
  }),
  Schema.Struct({
    ...VersionField,
    binding: WorkbenchBinding,
    operation: Schema.Literal("status"),
    id: R8DecisionId,
  }),
]);
export type DecisionParams = typeof DecisionParams.Type;

/**
 * The `workbench.decision` result — the host's closed envelopes: `available`
 * carries the decision snapshot (open/select/status), `ready` carries the
 * confirmed child descriptor (start/status on a recorded child), `unknown`
 * keeps an uncertain or reserved start visible, `conflict` names a state
 * conflict, `unsupported` names a missing kernel capability. There is
 * deliberately no "applied" state.
 */
export const DecisionResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("unsupported"),
    reason: Schema.String,
  }),
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("ready"),
    decision: Schema.optional(WorkbenchDecisionSnapshot),
    child: BranchDescriptorResponse,
  }),
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literals(["available", "unknown", "conflict"]),
    reason: Schema.optional(Schema.String),
    decision: Schema.optional(WorkbenchDecisionSnapshot),
  }),
]);
export type DecisionResponse = typeof DecisionResponse.Type;

/** Whitelisted ordinary child methods the branch envelope may carry. */
export const BRANCH_SESSION_METHODS = [
  "workbench.handshake",
  "workbench.bind",
  "workbench.read",
  "workbench.submit",
  "workbench.commandStatus",
  "workbench.cancel",
  "workbench.detach",
  "workbench.overview",
  "workbench.graph",
  "workbench.code",
  "workbench.record",
  "workbench.workMode",
  "workbench.usage",
  "workbench.record.index",
  "workbench.record.body",
  "workbench.graph.explore",
] as const satisfies ReadonlyArray<WorkbenchMethod>;

export type BranchSessionMethod = (typeof BRANCH_SESSION_METHODS)[number];

export const isBranchSessionMethod = (method: string): method is BranchSessionMethod =>
  (BRANCH_SESSION_METHODS as readonly string[]).includes(method);

/**
 * The `workbench.branchSession` envelope: one whitelisted ordinary method
 * addressed to one RECORDED child under the authenticated parent owner. No
 * recursive envelopes, no arbitrary endpoints, no child paths or tokens —
 * the gateway resolves the child from its own records.
 */
export const BranchSessionParams = Schema.Struct({
  ...VersionField,
  binding: WorkbenchBinding,
  childId: R8DecisionId,
  method: Schema.Literals([...BRANCH_SESSION_METHODS]),
  params: Schema.Unknown,
});
export type BranchSessionParams = typeof BranchSessionParams.Type;

// --- Exact retained records (R5) ---
//
// The exact mirror of the harness's additive workbench.record result
// (dokkabi-dev src/dash/workbench-record.ts). Whole retained EventLog rows
// from ONE verified session prefix under an immutable asOf pin; an
// oversized row that belongs to the requested page reports the body
// "unavailable" with a reason plus the empty page shape — never a clipped
// row masquerading as exact. Decisions stay the capability fact they are.

const RecordRow = Schema.Struct({
  seq: PositiveInt,
  ts: Schema.String,
  kind: Schema.Literals(["surface", "observe", "effect"]),
  name: Schema.String,
  prev_hash: Hex64,
  hash: Hex64,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  /** Opaque harness observation envelope; the identity fields stay closed. */
  observe: Schema.optional(Schema.Unknown),
});

const RecordNextCursor = Schema.Struct({
  seq: NonNegativeInt,
  hash: Hex64,
  generation: Hex64,
});

const RecordDecisions = Schema.Struct({
  status: Schema.Literal("unsupported"),
  reason: Schema.String,
});

const RecordSharedFields = {
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  asOf: WorkbenchSessionCursor,
  decisions: RecordDecisions,
};

/** Discriminated on `state`. Both branches share one closed field set so
 * page-shaped objects stay assignable across the union; the unavailable
 * body's emptiness (no rows, no next cursor, hasMore false) is enforced by
 * the record-chain verifier, not by narrower literal types. */
export const RecordResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("available"),
    ...RecordSharedFields,
    records: Schema.Array(RecordRow).check(Schema.isMaxLength(100)),
    next: Schema.NullOr(RecordNextCursor),
    total: NonNegativeInt,
    hasMore: Schema.Boolean,
  }),
  Schema.Struct({
    version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
    state: Schema.Literal("unavailable"),
    reason: Schema.String,
    ...RecordSharedFields,
    records: Schema.Array(RecordRow).check(Schema.isMaxLength(0)),
    next: Schema.NullOr(RecordNextCursor),
    total: NonNegativeInt,
    hasMore: Schema.Boolean,
  }),
]);
export type RecordResponse = typeof RecordResponse.Type;

// --- Bounded record explorer ---
//
// Metadata entries carry identity, canonical byte length and the SHA-256 of
// the full canonical row bytes — never payload bytes. Body ranges carry at
// most 32 KiB of canonical UTF-8 bytes as canonical base64 plus the range's
// own digest; chain, cursor and descriptor bindings are re-verified by
// RecordExplorer before anything moves.

const RecordDescriptor = Schema.Struct({
  seq: PositiveInt,
  ts: Schema.String.check(Schema.isMaxLength(WORKBENCH_RECORD_DESCRIPTOR_TEXT_MAX)),
  kind: Schema.Literals(["surface", "observe", "effect"]),
  name: Schema.String.check(Schema.isMaxLength(WORKBENCH_RECORD_DESCRIPTOR_TEXT_MAX)),
  prev_hash: Hex64,
  hash: Hex64,
  byteLength: PositiveInt,
  bodyDigest: Hex64,
  /** Present (true) only when ts/name are shortened display excerpts; the
   * canonical body always retains the full original values. */
  tsTruncated: Schema.optional(Schema.Literal(true)),
  nameTruncated: Schema.optional(Schema.Literal(true)),
});

export const RecordIndexResponse = Schema.Struct({
  version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
  state: Schema.Literal("available"),
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  asOf: WorkbenchSessionCursor,
  entries: Schema.Array(RecordDescriptor).check(Schema.isMaxLength(100)),
  next: Schema.NullOr(RecordNextCursor),
  total: NonNegativeInt,
  hasMore: Schema.Boolean,
});
export type RecordIndexResponse = typeof RecordIndexResponse.Type;

export const RecordBodyResponse = Schema.Struct({
  version: Schema.Literal(WORKBENCH_PROTOCOL_VERSION),
  state: Schema.Literal("available"),
  sessionCursor: WorkbenchSessionCursor,
  gatewayCursor: WorkbenchCursor,
  asOf: WorkbenchSessionCursor,
  row: WorkbenchCursor,
  offset: NonNegativeInt,
  nextOffset: Schema.NullOr(PositiveInt),
  totalBytes: PositiveInt,
  bodyDigest: Hex64,
  chunkDigest: Hex64,
  data: Schema.String.check(
    Schema.isMaxLength(WORKBENCH_RECORD_BODY_MAX_BASE64),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  ),
});
export type RecordBodyResponse = typeof RecordBodyResponse.Type;

// --- JSON-RPC envelope ---

export const JsonRpcError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export type JsonRpcError = typeof JsonRpcError.Type;

/** A response to one of OUR requests. */
export const JsonRpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.Int, Schema.String]),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcError),
});
export type JsonRpcResponse = typeof JsonRpcResponse.Type;

/**
 * A notification from the shared gateway broadcast surface (chat.opened,
 * terminal.output, …). The workbench client never treats these as
 * malformed frames and never lets them invoke anything; they are ignored.
 */
export const JsonRpcNotificationFrame = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
export type JsonRpcNotificationFrame = typeof JsonRpcNotificationFrame.Type;

export type DecodedFrame =
  | { readonly kind: "response"; readonly response: JsonRpcResponse }
  | { readonly kind: "notification" };

const decodeFrame = Schema.decodeUnknownSync(JsonRpcResponse, STRICT_DECODE_OPTIONS);
// Notifications are IGNORED, so only their shape is matched — no strict
// excess-property check is needed (or possible through `Schema.is`).
const isNotificationFrame = Schema.is(JsonRpcNotificationFrame);

/**
 * Decode a raw frame. A frame with an id is a response; a frame with a
 * method and no id is a notification to ignore. Anything else throws so the
 * transport can treat it as a contract violation.
 */
export function decodeFrameOrNotification(raw: string): DecodedFrame {
  const parsed: unknown = JSON.parse(raw);
  if (isNotificationFrame(parsed) && !("id" in (parsed as Record<string, unknown>))) {
    return { kind: "notification" };
  }
  return { kind: "response", response: decodeFrame(parsed) };
}

/** Kept for direct response decoding in tests. */
export function decodeResponseFrame(raw: string): JsonRpcResponse {
  const frame = decodeFrameOrNotification(raw);
  if (frame.kind !== "response") {
    throw new Error("expected a JSON-RPC response frame");
  }
  return frame.response;
}

export type WorkbenchMethod =
  | "workbench.handshake"
  | "workbench.model"
  | "workbench.bind"
  | "workbench.read"
  | "workbench.submit"
  | "workbench.commandStatus"
  | "workbench.cancel"
  | "workbench.detach"
  | "workbench.overview"
  | "workbench.graph"
  | "workbench.code"
  | "workbench.codeAction"
  | "workbench.record"
  | "workbench.decisions"
  | "workbench.checkpoint"
  | "workbench.decision"
  | "workbench.branchSession"
  | "workbench.workMode"
  | "workbench.usage"
  | "workbench.record.index"
  | "workbench.record.body"
  | "workbench.graph.explore";

/** Client-side request validation: every outbound params payload is checked
 * against the closed schema BEFORE it reaches the wire. */
export const workbenchParamsSchemas = {
  "workbench.handshake": HandshakeParams,
  "workbench.model": ModelSelectionParams,
  "workbench.bind": BindParams,
  "workbench.read": ReadParams,
  "workbench.submit": SubmitParams,
  "workbench.commandStatus": CommandStatusParams,
  "workbench.cancel": CancelParams,
  "workbench.detach": DetachParams,
  "workbench.overview": OverviewParams,
  "workbench.graph": GraphParams,
  "workbench.record": RecordParams,
  "workbench.code": CodeParams,
  "workbench.codeAction": CodeActionParams,
  "workbench.decisions": DecisionsParams,
  "workbench.checkpoint": CheckpointParams,
  "workbench.decision": DecisionParams,
  "workbench.branchSession": BranchSessionParams,
  "workbench.workMode": WorkModeParams,
  "workbench.usage": UsageParams,
  "workbench.record.index": RecordIndexParams,
  "workbench.record.body": RecordBodyParams,
  "workbench.graph.explore": GraphExploreParams,
} as const;

/** The gateway's id vocabulary — mirrors the harness `ID_PATTERN`. */
export const WORKBENCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const WORKBENCH_ID_MAX_LENGTH = 128;

/** True when an arbitrary orchestration identifier can travel the wire as-is. */
export function isWorkbenchId(value: string): boolean {
  return value.length <= WORKBENCH_ID_MAX_LENGTH && WORKBENCH_ID_PATTERN.test(value);
}

/** Encode one JSON-RPC request frame. */
export function encodeRequest(id: number, method: WorkbenchMethod, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export class WorkbenchProtocolError extends Schema.TaggedError<WorkbenchProtocolError>()(
  "WorkbenchProtocolError",
  {
    method: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Dokkabi workbench ${this.method} failed: ${this.detail}`;
  }
}

const formatIssue = SchemaIssue.makeFormatterDefault();

/** Decode a method result payload with one of the closed schemas. */
export const decodeResult = <S extends Schema.Top>(input: {
  readonly method: WorkbenchMethod;
  readonly schema: S;
  readonly result: unknown;
}): Effect.Effect<S["Type"], WorkbenchProtocolError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(
    input.schema,
    STRICT_DECODE_OPTIONS,
  )(input.result).pipe(
    Effect.mapError(
      (schemaError) =>
        new WorkbenchProtocolError({
          method: input.method,
          detail:
            `response did not match the v${WORKBENCH_PROTOCOL_VERSION} contract: ${JSON.stringify(
              formatIssue(schemaError.issue),
            )}`.slice(0, 600),
        }),
    ),
  );
