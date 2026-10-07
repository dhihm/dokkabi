import { z } from "zod";

/**
 * #227 CG-01 — the context graph's versioned contracts (TS-28 §5, §9).
 *
 * The EventLog and its blobs are the only truth. The context graph is a pure,
 * rebuildable projection of a durable prefix of that log; every type below is
 * either the body of a `context/*` row the host appends, or a view the
 * projection derives. Node kinds and relations are closed enums; ids are
 * minted by the host from durable sources (row sequence numbers and counts of
 * earlier rows), never from wall clock, pid or a local path; free text is data
 * and never a command. `causes` is not a relation: the graph never infers
 * causation from order.
 *
 * Every row carries `schema: "context-graph-v1"` and is read strictly: a
 * missing or extra field, an unknown enum value or a row before the session
 * enrolled the `context-graph-v1` replay feature fails the fold — a rebuild
 * after a schema field was removed never "succeeds" by re-inferring it.
 */
export const CONTEXT_GRAPH_SCHEMA = "context-graph-v1" as const;
export const CONTEXT_GRAPH_FEATURE = "context-graph-v1" as const;
/** R8-03: the replay feature generation under which the branch-context rows
 * are read and written. A log that carries them cannot be reopened by a host
 * that does not know the generation. */
export const BRANCH_CONTEXT_FEATURE = "branch-context-v1" as const;
/** R8-06g: lesson schema 2 (separated observation versions). */
export const LESSON_OBSERVATION_FEATURE = "context-lesson-observation-v1" as const;
/** Genuine formal Work executions as scoped actions/observations and lesson
 * schema 3 (a host-derived formal-case observable) exist only under this
 * generation; an earlier generation's graph, frames and lessons keep their
 * exact meaning. */
export const FORMAL_WORK_FEATURE = "context-formal-work-v1" as const;

export const CONTEXT_SCOPE_ROW = "context/scope";
export const CONTEXT_ATTEMPT_ROW = "context/attempt";
export const CONTEXT_LESSON_ROW = "context/lesson";
export const CONTEXT_ASSESSMENT_ROW = "context/assessment";
export const CONTEXT_FRAME_ROW = "context/frame";
export const CONTEXT_SURFACE_ROW = "context/surface";
export const CONTEXT_PRESENTED_ROW = "context/presented";
export const CONTEXT_QUERY_ROW = "context/query";
export const CONTEXT_DEGRADED_ROW = "context/degraded";
export const CONTEXT_TREE_ROW = "context/tree";
/** R8-03: imported parent lesson candidates and their child applicability
 * reassessment. Their closed shapes live in branch-context.ts; the row names
 * and authority are the context graph's own. */
export const CONTEXT_BRANCH_IMPORT_ROW = "context/branch_import";
export const CONTEXT_BRANCH_FIT_ROW = "context/branch_fit";

/** Rows that change what the graph knows about the world (they move
 * `contextGraphRev`). Frames, surfaces, presentation, queries and degraded
 * notices are the graph's own accounting: folding them never moves the
 * revision, so a request that records a frame cannot invalidate itself. */
export const CONTEXT_WORLD_ROWS = new Set([CONTEXT_SCOPE_ROW, CONTEXT_ATTEMPT_ROW, CONTEXT_LESSON_ROW, CONTEXT_ASSESSMENT_ROW, CONTEXT_TREE_ROW,
  CONTEXT_BRANCH_IMPORT_ROW, CONTEXT_BRANCH_FIT_ROW]);
export const CONTEXT_ACCOUNTING_ROWS = new Set([CONTEXT_FRAME_ROW, CONTEXT_SURFACE_ROW, CONTEXT_PRESENTED_ROW,
  CONTEXT_QUERY_ROW, CONTEXT_DEGRADED_ROW]);
/** Every row this feature defines. Older `context/*` rows (`context/slim`,
 * `context/prune`, `context/repeat_read`) belong to the loop's context relief
 * and are not context-graph rows. */
export const CONTEXT_GRAPH_ROWS = new Set([...CONTEXT_WORLD_ROWS, ...CONTEXT_ACCOUNTING_ROWS]);

export const NODE_KINDS = ["goal", "question", "claim", "attempt", "action", "observation", "resource_version",
  "lesson", "context_frame"] as const;
export type ContextNodeKind = (typeof NODE_KINDS)[number];
export const RELATION_KINDS = ["pursues", "tests_hypothesis", "requested_by", "observed_from", "read_version",
  "produced_version", "supports", "contradicts", "supersedes", "revalidates", "applies_to", "depends_on",
  "selected_for", "presented_to", "cited_by", "retries_with"] as const;
export type ContextRelationKind = (typeof RELATION_KINDS)[number];

const HEX64 = /^[a-f0-9]{64}$/u;
export const eventRefSchema = z.strictObject({ seq: z.number().int().positive(), hash: z.string().regex(HEX64) });
export type EventRef = z.infer<typeof eventRefSchema>;
export const blobRefSchema = z.strictObject({ digest: z.string().regex(HEX64), bytes: z.number().int().nonnegative() });
export type BlobRef = z.infer<typeof blobRefSchema>;
export const AVAILABILITY = ["retained", "partial", "unavailable"] as const;
export const AUTHORITY = ["host_observation", "operator", "model_statement", "external_source"] as const;
export const evidenceRefSchema = z.strictObject({
  event: eventRefSchema,
  body: blobRefSchema.nullable(),
  availability: z.enum(AVAILABILITY),
  authority: z.enum(AUTHORITY),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const RESOURCE_KINDS = ["file", "workspace", "environment", "document", "api_result"] as const;
export const resourceVersionSchema = z.strictObject({
  resourceId: z.string().min(1).max(300),
  kind: z.enum(RESOURCE_KINDS),
  digest: z.string().regex(HEX64).nullable(),
  evidence: evidenceRefSchema,
  coverage: z.enum(["exact", "partial", "unknown"]),
});
export type ResourceVersion = z.infer<typeof resourceVersionSchema>;

export const applicabilitySchema = z.strictObject({
  repositoryId: z.string().min(1).max(200),
  goalId: z.string().min(1).max(64).nullable(),
  resources: z.array(resourceVersionSchema).max(32),
  dependencyCoverage: z.enum(["declared", "incomplete"]),
  conditionText: z.string().max(1200),
});
export type Applicability = z.infer<typeof applicabilitySchema>;

export const ATTEMPT_OUTCOMES = ["open", "met", "not_met", "inconclusive", "interrupted"] as const;
export const attemptSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().regex(/^att-[0-9]+$/u),
  goalId: z.string().min(1).max(64),
  question: z.string().max(1200),
  hypothesisRefs: z.array(z.string().max(64)).max(8),
  intentOrigin: z.enum(["model_declared", "operator_declared", "unknown"]),
  inputScope: applicabilitySchema,
  actionRefs: z.array(eventRefSchema).max(32),
  observationRefs: z.array(evidenceRefSchema).max(32),
  expected: z.string().max(1200).nullable(),
  outcome: z.enum(ATTEMPT_OUTCOMES),
  outcomeAuthority: z.enum(["model_statement", "specified_check", "unknown"]),
  previousAttempt: z.string().regex(/^att-[0-9]+$/u).nullable(),
  changedConditions: z.array(evidenceRefSchema).max(16),
  changedApproach: z.string().max(1200).nullable(),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const EPISTEMIC = ["proposed", "corroborated", "contested", "superseded"] as const;
export type Epistemic = (typeof EPISTEMIC)[number];
/** §133 A1'': the schema-1/2 observable — a judged run of a command. */
export const judgedObservableSchema = z.strictObject({
  caseId: z.string().min(1).max(128).nullable(),
  commandDigest: z.string().regex(HEX64),
  source: eventRefSchema,
});
/** Schema 3: the formal-case observable the HOST derived from the cited
 * authenticated formal Work execution that failed (a qualifying RED): the
 * case id, the digest of the command it ran, the verdict row (`source`), the
 * exact execution start, and the obligation and case digests it was bound to.
 * It describes the scoped prediction only; a lesson's causal explanation
 * stays the model's proposal. Never typed by the model, and a valid shape
 * alone never grants it: the fold re-derives it from the retained execution. */
export const formalCaseObservableSchema = z.strictObject({
  kind: z.literal("formal_case"),
  caseId: z.string().min(1).max(128),
  commandDigest: z.string().regex(HEX64),
  source: eventRefSchema,
  executionStart: eventRefSchema,
  obligationKey: z.string().regex(HEX64),
  caseDigest: z.string().regex(HEX64),
});
export type FormalCaseObservable = z.infer<typeof formalCaseObservableSchema>;

export const lessonSchema = z.strictObject({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** Schemas 2 and 3: host-derived execution observation versions, never declared conditions. */
  observationResources: z.array(resourceVersionSchema).max(4).optional(),
  id: z.string().regex(/^lesson-[0-9]+$/u),
  revision: z.number().int().positive(),
  attemptIds: z.array(z.string().regex(/^att-[0-9]+$/u)).max(8),
  statement: z.string().min(1).max(2000),
  evidence: z.array(evidenceRefSchema).min(1).max(16),
  scope: applicabilitySchema,
  /** Always `proposed` when recorded: the model's own word never promotes
   * a lesson. The projection derives the current state from assessments. */
  epistemic: z.literal("proposed"),
  assessmentRefs: z.array(evidenceRefSchema).max(0),
  retryConditions: z.array(z.string().max(400)).max(8),
  invalidationConditions: z.array(z.string().max(400)).max(8),
  previousRevision: eventRefSchema.nullable(),
  /** §133 A1'': the observable the HOST derived for this revision — the
   * judged run that was RED in the lesson's own attempt, bound by the digest
   * of the command it ran (a case's command at that revision, never its id
   * alone), and the row that showed it. Never typed by the model. A later
   * host-judged run of exactly this command digest is what assesses the
   * lesson: RED again corroborates, GREEN contests. Null when the attempt has
   * no red judged run (the lesson then cannot be assessed). Schema 3 holds
   * exactly a formal-case observable; schemas 1 and 2 never do. */
  observable: z.union([judgedObservableSchema, formalCaseObservableSchema]).nullable(),
  /** Another lesson this revision supersedes (its latest revision). */
  supersedes: z.strictObject({ lesson: z.string().regex(/^lesson-[0-9]+$/u), revision: z.number().int().positive() }).nullable(),
}).superRefine((lesson, ctx) => {
  if (lesson.schema === 1 ? lesson.observationResources !== undefined : lesson.observationResources === undefined) {
    ctx.addIssue({ code: "custom", message: "observationResources must be present only for lesson schemas 2 and 3" });
  }
  const formal = lesson.observable !== null && "kind" in lesson.observable;
  if (lesson.schema === 3 ? !formal : formal) {
    ctx.addIssue({ code: "custom", message: "a formal-case observable belongs to lesson schema 3 alone, and schema 3 requires one" });
  }
});
export type Lesson = z.infer<typeof lessonSchema>;

/** §133 A1'': an assessment is HOST-MINTED when a later host-judged run of
 * a lesson revision's observable is observed; the model never writes one. The
 * fold re-derives every field and refuses a row that states otherwise. */
export const assessmentSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().regex(/^assess-[0-9]+$/u),
  lesson: z.string().regex(/^lesson-[0-9]+$/u),
  revision: z.number().int().positive(),
  /** `supports` when the judged run was RED again (the observed failure
   * reproduced), `contradicts` when it was GREEN. */
  stance: z.enum(["supports", "contradicts"]),
  /** Exactly the judged row. */
  evidence: z.array(evidenceRefSchema).length(1),
  author: z.literal("host"),
  observed: z.enum(["pass", "fail"]),
});
export type Assessment = z.infer<typeof assessmentSchema>;

export const COVERAGE = ["complete_for_selection", "partial", "unavailable"] as const;
export type FrameCoverage = (typeof COVERAGE)[number];
export const frameSelectedSchema = z.strictObject({ nodeId: z.string().max(96), revision: z.string().max(96), reason: z.string().max(160) });
export const frameOmittedSchema = z.strictObject({ group: z.string().max(64), count: z.number().int().nonnegative(), reason: z.string().max(160) });
export const contextFrameSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().regex(/^cf-[0-9]+$/u),
  sourceHead: eventRefSchema,
  contextGraphRev: z.number().int().nonnegative(),
  projectionDigest: z.string().regex(HEX64),
  goalId: z.string().min(1).max(64),
  attemptId: z.string().max(64).nullable(),
  policyDigest: z.string().regex(HEX64),
  selected: z.array(frameSelectedSchema).max(64),
  omitted: z.array(frameOmittedSchema).max(16),
  body: blobRefSchema,
  coverage: z.enum(COVERAGE),
  budget: z.strictObject({
    maxBytes: z.number().int().positive(),
    actualBytes: z.number().int().nonnegative(),
    /** No tokenizer is part of the host: tokens are `missing`, never a
     * byte count relabelled. */
    estimatedTokens: z.literal("missing"),
  }),
});
export type ContextFrame = z.infer<typeof contextFrameSchema>;

/** The `context/frame` row: the typed frame plus the facts replay needs to
 * re-derive the same bytes. */
export const frameRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  frame: contextFrameSchema,
  /** The rendered bytes' blob — the GC root (`payload.blob`). */
  blob: z.string().regex(HEX64),
  blob_bytes: z.number().int().nonnegative(),
  mode: z.enum(["shadow", "on"]),
  boundary: z.enum(["initial", "tool_batch", "resume", "retry", "completion"]),
  /** One live frame (§130 F1): every frame is whole and replaces the last. */
  kind: z.literal("full"),
  reuse_key: z.string().regex(HEX64),
  selection_digest: z.string().regex(HEX64),
  items: z.array(z.strictObject({ key: z.string().max(96), line: z.string().regex(HEX64) })).max(64),
  /** Raw-output recovery is #223's; until its envelopes land it is
   * `unavailable` and the frame says so. */
  /** Raw-output recovery of the selected failures' reduced results, from
   * #223's `tool/source` envelopes: `available` when every reduced output
   * has a stored source and a reader, `unavailable` when none has,
   * `partial` when some have, `not_applicable` when no selected output was
   * reduced. */
  recovery: z.enum(["available", "partial", "unavailable", "not_applicable"]),
  profile: z.string().max(32),
  /** §133 R2: whether THIS request's tools held the source reader. */
  reader: z.boolean(),
  /** §132 F2': a frame that replaced the previous one because nothing else
   * could be delivered, and the guard that refused the full frame. */
  degraded: z.strictObject({ guard: z.string().min(1).max(64) }).nullable(),
});
export type FrameRow = z.infer<typeof frameRowSchema>;

/** §132 B2: the surface REFERENCES the frame's bytes (its blob digest and
 * size); it never duplicates them. */
export const surfaceRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  frame_id: z.string().regex(/^cf-[0-9]+$/u),
  frame: eventRefSchema,
  origin: z.literal("host_context"),
  blob: z.string().regex(HEX64),
  blob_bytes: z.number().int().nonnegative(),
});

/** A frame's presentation stages after it is recorded: `appended` (the
 * transcript carries it: `state` is the provider/state row), `dispatched`
 * (a request carrying it was handed to the send path) and `responded` (that
 * request was answered). */
export const presentedRowSchema = z.union([
  z.strictObject({
    schema: z.literal(CONTEXT_GRAPH_SCHEMA),
    stage: z.literal("appended"),
    state: eventRefSchema,
    frames: z.array(z.string().regex(/^cf-[0-9]+$/u)).length(1),
  }),
  z.strictObject({
    schema: z.literal(CONTEXT_GRAPH_SCHEMA),
    stage: z.enum(["dispatched", "responded"]),
    request: eventRefSchema,
    frames: z.array(z.string().regex(/^cf-[0-9]+$/u)).length(1),
    stop: z.string().max(32).nullable(),
  }),
]);

export const scopeRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  repository_id: z.string().min(1).max(200),
  /** §130 S1: the base record's digest with the root's device and inode,
   * or the root's device and inode alone when the log names no base. */
  source: z.enum(["base_record", "root_inode"]),
  mode: z.enum(["shadow", "on"]),
  policy_digest: z.string().regex(HEX64),
});

export const attemptRowSchema = z.strictObject({ schema: z.literal(CONTEXT_GRAPH_SCHEMA), attempt: attemptSchema });
export const lessonRowSchema = z.strictObject({ schema: z.literal(CONTEXT_GRAPH_SCHEMA), lesson: lessonSchema });
export const assessmentRowSchema = z.strictObject({ schema: z.literal(CONTEXT_GRAPH_SCHEMA), assessment: assessmentSchema });
/** §133 P3: what the host read of the tree — the workspace image under the
 * session's base coverage and the content digests of declared files (null:
 * not readable). Applicability compares declared versions with the latest
 * reading; nothing is assumed to match. */
export const treeRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  image: z.string().regex(HEX64).nullable(),
  files: z.array(z.strictObject({ path: z.string().min(1).max(300), digest: z.string().regex(HEX64).nullable() })).max(64),
});

export const queryRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  goal_id: z.string().max(64),
  source_head: eventRefSchema,
  question_digest: z.string().regex(HEX64),
  blob: z.string().regex(HEX64),
  blob_bytes: z.number().int().nonnegative(),
  coverage: z.enum(COVERAGE),
});
export const degradedRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  reason: z.enum(["frame_store_failed", "frame_refused", "projection_failed", "optional_recall_unavailable", "context_full"]),
  /** The guard that refused, for `frame_refused`. */
  guard: z.string().max(64).nullable(),
  boundary: z.string().max(32),
  detail: z.string().max(240),
});

export class ContextGraphSchemaError extends Error {
  readonly code = "context_graph_schema";
  constructor(reason: string) {
    super(`context-graph: ${reason}`);
    this.name = "ContextGraphSchemaError";
  }
}

/** Parse one row strictly, or fail the fold (never re-infer a field). */
export function parseRow<T>(schema: z.ZodType<T>, payload: unknown, name: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ContextGraphSchemaError(`${name} row does not match ${CONTEXT_GRAPH_SCHEMA}`);
  return parsed.data;
}

/** The selection policy the frame is rendered under (TS-28 §8). Budgets are
 * bytes; the frame never claims a token count. */
export interface FramePolicy {
  readonly maxBytes: number;
  readonly maxFailures: number;
  readonly maxLessons: number;
  readonly maxPending: number;
  readonly maxAttempts: number;
  readonly outputHeadBytes: number;
}
export const DEFAULT_FRAME_POLICY: FramePolicy = Object.freeze({
  maxBytes: 8192,
  maxFailures: 6,
  maxLessons: 8,
  maxPending: 4,
  maxAttempts: 2,
  outputHeadBytes: 160,
});

export type ContextGraphMode = "off" | "shadow" | "on";

/** The operator's rollout switch (TS-28 §15): off → shadow → on. Anything
 * else is off — the fail-closed default. */
export function contextGraphMode(env: NodeJS.Dict<string> = process.env): ContextGraphMode {
  const value = env.DOKKABI_CONTEXT_GRAPH?.trim().toLowerCase();
  return value === "shadow" || value === "on" ? value : "off";
}
