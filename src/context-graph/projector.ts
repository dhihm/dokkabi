import { contributionFrameOf, type RecordedContributionFrameRow } from "../host/context-contribution.ts";
import { createHash } from "node:crypto";
import type { EventLog } from "../host/event-log.ts";
import { canonicalJson } from "../host/canonical.ts";
import { sessionReplayFeatureGenerationIndex, sessionReplayFeaturesAt, type EventRecord } from "../host/schema.ts";
import { BlobStore } from "../host/blob-store.ts";
import {
  BranchContextError,
  branchImportRowSchema,
  branchFitRowSchema,
  computeImportedFit,
  deriveImportedCandidates,
  distinctDeclaredFilePaths,
  MAX_IMPORTED_DECLARED_PATHS,
  validateBranchContextAuthority,
  CONTEXT_BRANCH_FIT_ROW,
  CONTEXT_BRANCH_IMPORT_ROW,
  type ImportedLessonState,
  type RetainedBranchBodyReader,
} from "./branch-context.ts";
import {
  formalAssessmentOf,
  formalObservableFrom,
  isFormalEnd,
  isFormalHostRow,
  isFormalStart,
  isFormalVerdict,
  judgeVerdict,
  obligationOf,
  type FormalExecution,
  type FormalVerdict,
} from "./formal-work.ts";
import {
  assessmentRowSchema,
  attemptRowSchema,
  BRANCH_CONTEXT_FEATURE,
  CONTEXT_ASSESSMENT_ROW,
  CONTEXT_GRAPH_ROWS,
  CONTEXT_ATTEMPT_ROW,
  CONTEXT_DEGRADED_ROW,
  CONTEXT_FRAME_ROW,
  CONTEXT_GRAPH_FEATURE,
  CONTEXT_LESSON_ROW,
  CONTEXT_PRESENTED_ROW,
  CONTEXT_QUERY_ROW,
  CONTEXT_SCOPE_ROW,
  CONTEXT_SURFACE_ROW,
  CONTEXT_TREE_ROW,
  ContextGraphSchemaError,
  degradedRowSchema,
  FORMAL_WORK_FEATURE,
  LESSON_OBSERVATION_FEATURE,
  frameRowSchema,
  lessonRowSchema,
  parseRow,
  presentedRowSchema,
  queryRowSchema,
  scopeRowSchema,
  surfaceRowSchema,
  treeRowSchema,
  type Assessment,
  type Attempt,
  type BlobRef,
  type ContextNodeKind,
  type ContextRelationKind,
  type EventRef,
  type EvidenceRef,
  type FormalCaseObservable,
  type FrameRow,
  type Lesson,
  type ResourceVersion,
} from "./types.ts";

/**
 * #227 CG-01/CG-02 — the context graph as a fold over the EventLog.
 *
 * Pure: it reads only the rows it is given — no clock, no filesystem, no
 * model, no Wiki, no DuckDB — so `sync(sourceHead)` over the same prefix is
 * the same graph, and deleting the projection and rebuilding it from the log
 * yields the same revision and digest. The live projection of one writer's
 * log extends the fold by the rows appended since the previous call (the
 * guard provider-input and the ledger use: a fold whose last row is still at
 * the same position with the same hash covers an unchanged prefix), so a
 * request's preparation reads the suffix, not the session.
 *
 * Body linking (G3): an action is a `tool/call` row; its observations are the
 * `tool/result` and `tool/end` rows carrying the same call id and the rows the
 * loop names on `tool/end` (`observed_rows`: the receipts, checks and ledger
 * rows the invocation's own execution appended — host/invocation-scope.ts).
 * Nothing attaches by position: a late or out-of-order completion lands on its
 * own invocation, an action without a terminal row is `pending`, and one cut
 * off by a restart or an ended turn is `interrupted` with an unknown result.
 *
 * The digest is a chain over the graph operations each world row produced —
 * nodes and edges, not the rows themselves — and `contextGraphRev` counts the
 * rows that produced any. The graph's own accounting (frames, surfaces,
 * presentation, queries) never moves either.
 */

export interface RowFact {
  readonly seq: number;
  readonly hash: string;
  readonly name: string;
  readonly kind: string;
  readonly goalId: string | undefined;
  readonly repositoryId: string;
  readonly blob?: string;
  readonly blobBytes?: number;
  readonly availability: EvidenceRef["availability"];
  readonly authority: EvidenceRef["authority"];
}

export interface ReceiptFact {
  readonly ref: EventRef;
  readonly name: string;
  readonly image: string;
  readonly imageAfter: string;
  readonly exitCode: number;
  readonly live: boolean;
  readonly unknown: boolean;
}

export interface CheckFact {
  readonly ref: EventRef;
  readonly name: string;
  readonly caseId: string;
  readonly status: string;
  readonly exitCode?: number;
}

export type InvocationStatus = "pending" | "completed" | "interrupted";

export interface Invocation {
  readonly key: string;
  readonly callId: string;
  readonly tool: string;
  readonly call: EventRef;
  readonly argsDigest: string | undefined;
  readonly argHint: string;
  /** The `path` argument the call named, when it named one (§130 A1: a call
   * on a lesson's declared file resource is related to it). */
  readonly path: string | undefined;
  readonly goalId: string;
  readonly repositoryId: string;
  status: InvocationStatus;
  error?: boolean;
  exitCode?: number;
  result?: EventRef;
  end?: EventRef;
  resultHead?: string;
  resultAvailability: EvidenceRef["availability"];
  /** #223: the recorded envelope of the result's full source, when the
   * delivered result was reduced (`tool/source`). */
  source?: { ref: EventRef; digest: string; bytes: number; stored: boolean; omittedBytes: number; recovery: "available" | "unavailable" | "not_applicable"; completeness: string };
  rows: EventRef[];
  rowsPartial: boolean;
  receipts: ReceiptFact[];
  checks: CheckFact[];
  failed: boolean;
  mechanical: string;
  attempts: Set<string>;
  resolvedBy?: string;
  /** The earlier invocations with the same tool and argument digest in the
   * same goal, newest last (bounded). */
  sameAs: string[];
}

export interface AttemptState {
  readonly attempt: Attempt;
  readonly ref: EventRef;
}

export interface LessonRevisionState {
  readonly lesson: Lesson;
  readonly ref: EventRef;
}

export interface LessonState {
  readonly id: string;
  readonly revisions: LessonRevisionState[];
  readonly assessments: Array<{ readonly assessment: Assessment; readonly ref: EventRef }>;
  supersededBy?: { lesson: string; revision: number };
}

export interface FrameState<R = FrameRow> {
  readonly row: R;
  readonly ref: EventRef;
  surface?: { ref: EventRef; digest: string };
  appended?: EventRef;
  dispatched: EventRef[];
  responded: EventRef[];
}

export type RecordedFrameState = FrameState<FrameRow | RecordedContributionFrameRow>;
export function isSelectionFrame(state: RecordedFrameState): state is FrameState {
  return state.row.schema === "context-graph-v1";
}

export interface ContextGraphNode {
  readonly id: string;
  readonly kind: ContextNodeKind;
  readonly body: Record<string, unknown>;
}

export interface ContextGraphEdge {
  readonly from: string;
  readonly relation: ContextRelationKind;
  readonly to: string;
  readonly evidence: EventRef[];
}

export interface ContextGraphSnapshot {
  readonly sourceHead: EventRef | null;
  readonly revision: number;
  readonly digest: string;
  readonly nodes: Array<{ id: string; kind: ContextNodeKind; body: BlobRef }>;
  readonly edges: ContextGraphEdge[];
}

type Op =
  | { readonly op: "node"; readonly id: string; readonly kind: ContextNodeKind; readonly body: Record<string, unknown> }
  | { readonly op: "edge"; readonly from: string; readonly relation: ContextRelationKind; readonly to: string; readonly evidence: EventRef[] };

const GENESIS = createHash("sha256").update("context-graph-v1:genesis").digest("hex");
const SAME_ACTION_KEEP = 8;
/** §130 A1: the closed allow-list of rows the HOST mints from what it
 * observed — a tool's result and end, the receipts and results of executions,
 * the ledger's check/probe/property observations, the base record. Nothing
 * else is a host observation: a `tool/call` is the model's request, a note,
 * a plan, a lesson or an assessment is the model's statement, and every name
 * not listed here — including one added later — is a model statement until it
 * is deliberately listed. */
export const HOST_OBSERVATION_ROWS: ReadonlySet<string> = new Set([
  "tool/result", "tool/end", "exec/result", "exec/receipt", "verify/result", "verify/receipt",
  "ledger/check", "ledger/case_probe", "ledger/property", "ledger/case_base", "ledger/case", "work/base_record",
  // #223's recorded result envelopes and reads, #221's read receipts and
  // commits: host-minted records of what was delivered and what a file was.
  "tool/source", "tool/source_read", "workspace/read_receipt", "workspace/mutation_committed", "context/tree",
]);
const OPERATOR_ROWS: ReadonlySet<string> = new Set(["work/order", "work/goal"]);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ref(event: Pick<EventRecord, "seq" | "hash">): EventRef {
  return { seq: event.seq, hash: event.hash };
}

function authorityOf(event: EventRecord): EvidenceRef["authority"] {
  if (HOST_OBSERVATION_ROWS.has(event.name)) return "host_observation";
  // An operator's own line; a harness-generated prompt is not the operator's.
  if (OPERATOR_ROWS.has(event.name) || (event.name === "user/message" && event.payload.source === "operator")) return "operator";
  return "model_statement";
}

/** What of a row's own content survives in the log: a body stored whole
 * (`blob`) or kept verbatim (`raw`) is retained; a tool result the host kept
 * only as its redacted summary is partial. */
function availabilityOf(event: EventRecord): EvidenceRef["availability"] {
  if (event.name === "tool/result") {
    return typeof event.payload.blob === "string" || typeof event.payload.raw === "string" ? "retained" : "partial";
  }
  if (event.name === "tool/end" && typeof event.payload.observed_rows_dropped === "number") return "partial";
  return "retained";
}

function head(text: string, bytes: number): string {
  const flat = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(flat) <= bytes) return flat;
  return `${Buffer.from(flat).subarray(0, bytes).toString("utf8").replace(/�+$/u, "")}…`;
}

export class ContextGraphFold {
  consumed = 0;
  head: string | undefined;
  headRef: EventRef | null = null;
  revision = 0;
  digest = GENESIS;
  /** The first seq at which the session enrolled context-graph-v1. */
  featureStart: number | undefined;
  /** R8-03: the first seq at which the session enrolled branch-context-v1. */
  branchContextStart: number | undefined;
  lessonObservationStart: number | undefined;
  /** The first seq at which the session enrolled context-formal-work-v1:
   * formal Work rows after it are scoped host actions and observations;
   * before it (and in every earlier generation) they stay plain rows. */
  formalStart: number | undefined;
  private versioned = false;
  private highestGeneration = -1;
  /** R8-03: the governing session id of the last session/open row. */
  private sessionId: string | undefined;
  /** R8-03: where this fold reads a retained branch source bundle; the
   * branch-context rows refuse to fold without one. */
  private readonly retained: RetainedBranchBodyReader | undefined;

  /** Pure folds are built over rows alone; a fold that will meet
   * `context/branch_import` rows needs a retained-body reader. */
  constructor(retained?: RetainedBranchBodyReader) {
    this.retained = retained;
  }

  readonly facts = new Map<number, RowFact>();
  readonly receipts = new Map<number, ReceiptFact>();
  /** #221: the latest observed version of each file (by path digest): a
   * read receipt of what the model was shown, or a committed mutation. An
   * observation for applicability — never authority, never corroboration. */
  readonly fileVersions = new Map<string, { digest: string; ref: EventRef; coverage: "exact" | "partial" }>();
  /** The command each ledger case id is declared with, now (§133 A1''). */
  readonly caseCommands = new Map<string, string>();
  /** Judged rows with a verdict, by the command digest they ran. */
  readonly judgedByDigest = new Map<string, number[]>();
  /** Assessments recorded: `lesson#revision@judged seq`. */
  readonly assessed = new Set<string>();
  /** §133 P3: the latest reading of the tree. */
  tree: { image: string | null; files: Map<string, string | null>; ref: EventRef } | undefined;
  /** The host-judged observations, by seq (§132 A1'). */
  readonly judged = new Map<number, JudgedFact>();
  readonly checks = new Map<number, CheckFact>();
  readonly goals = new Map<string, { id: string; ref: EventRef; statementDigest?: string }>();
  currentGoal: string | undefined;
  repositoryId = "unidentified";
  scopeMode: "shadow" | "on" | undefined;
  readonly invocations = new Map<string, Invocation>();
  private readonly openByCall = new Map<string, string>();
  readonly byCallSeq = new Map<number, string>();
  /** The invocation a `tool/call`, `tool/result` or `tool/end` row belongs to. */
  readonly invocationBySeq = new Map<number, string>();
  /** The invocation whose execution appended an observed row (its receipt,
   * its check), by the row's seq. */
  readonly rowInvocation = new Map<number, string>();
  readonly pending = new Set<string>();
  private readonly redactedCalls = new Set<string>();
  /** Interrupted invocation keys per scope (repository AND goal), in order. */
  readonly interrupted = new Map<string, string[]>();
  /** Declared attempt ids per scope (repository AND goal), in order. */
  readonly attemptsByGoal = new Map<string, string[]>();
  /** Failed invocation keys per scope (repository AND goal, §130 S1), in
   * completion order; `scopeKey` names a scope. */
  readonly failures = new Map<string, string[]>();
  readonly unresolved = new Map<string, number>();
  private readonly sameAction = new Map<string, string[]>();
  readonly attempts = new Map<string, AttemptState>();
  readonly lessons = new Map<string, LessonState>();
  readonly lessonOrder: string[] = [];
  /** R8-03: the imported historical candidates this session holds, in the
   * import row's order, under namespaced ids that never collide with local
   * lesson ids. The candidates are re-derived from the retained source
   * bundle when the import row folds; the fits are re-derived from the
   * recorded tree reads when each fit row folds. */
  readonly importedLessons = new Map<string, ImportedLessonState>();
  /** R8-03: the branch-context import binding of this session, once its row
   * folds: the governing session, the workspace identifier, the authorized
   * child repository scope and the ready receipt's recorded resource
   * identity — root inode and the owner descriptor digest — which is what
   * live ownership loss is refused against at each boundary. */
  branchImportBinding: { session: string; workspace: string; repository: string; root: { uid: number; dev: number; ino: number }; resourceRoot: string; owner: string } | undefined;
  /** R8-03: the `context/scope` row in force. */
  scopeRef: EventRef | undefined;
  /** R8-03: workspace identifiers whose release or closure folded — a spent
   * resource supplies no current imported context. */
  readonly releasedWorkspaces = new Set<string>();
  /** R8-03: one branch-context import per session (the fold's own bound). */
  private importedSession: string | undefined;
  /** R8-03: the whole event array the fold extends over (the shared
   * authority validator reads the prefix behind a row; the suffix after a
   * row never enters it, so a later refusal cannot invalidate history). */
  private branchSource: readonly EventRecord[] | undefined;
  /** R8-03: whether a provider request or a context frame folded already —
   * the import belongs before any current model input. */
  private providerRequestSeen = false;
  private frameSeen = false;
  private contributionStart: number | undefined;
  /** R8-03: each goal's NEWEST host-recorded statement digest (a goal id
   * restated with a new statement updates it; the `goals` provenance map
   * keeps the first opening). Fit rederivation compares against this. */
  readonly goalStatements = new Map<string, string>();
  /** The exact latest statement source, paired with goalStatements. */
  readonly goalStatementRefs = new Map<string, EventRef>();
  assessmentCount = 0;
  readonly frames = new Map<string, RecordedFrameState>();
  readonly frameOrder: string[] = [];
  queries = 0;
  degraded = 0;
  /** The live workspace image the latest live-workspace receipt left. */
  latestImage: { image: string; ref: EventRef } | undefined;
  readonly nodes = new Map<string, ContextGraphNode>();
  readonly edges = new Map<string, ContextGraphEdge>();
  /** context-formal-work-v1: the formal Work executions, by start seq. */
  readonly formalExecutions = new Map<number, FormalExecution>();
  /** Their verdict observations, by verdict seq, in log order. */
  readonly formalVerdicts = new Map<number, FormalVerdict>();
  /** Authenticated qualifying-RED verdict seqs per scope, in order. */
  readonly formalFailures = new Map<string, number[]>();
  /** Judged (qualifying RED or GREEN) verdict seqs per obligation. */
  readonly formalJudged = new Map<string, number[]>();
  /** Draft baseline verdicts awaiting their coupled admission, by draft. */
  private readonly formalPending = new Map<string, number[]>();
  /** The declared case digest and command of each plan case id, now. */
  private readonly declaredCases = new Map<string, { caseDigest: string; command: string }>();
  private pendingOps: Op[] = [];

  /** Fold rows [consumed, upto) — the whole log by default. */
  extend(events: readonly EventRecord[], upto = events.length): void {
    this.branchSource = events;
    for (let index = this.consumed; index < upto; index += 1) {
      const event = events[index]!;
      this.pendingOps = [];
      this.step(event);
      if (this.pendingOps.length > 0) {
        this.revision += 1;
        this.digest = sha256(`${this.digest}\n${canonicalJson(this.pendingOps)}`);
      }
      this.consumed = index + 1;
      this.head = event.hash;
      this.headRef = ref(event);
    }
  }

  private emit(op: Op): void {
    this.pendingOps.push(op);
    if (op.op === "node") this.nodes.set(op.id, { id: op.id, kind: op.kind, body: op.body });
    else {
      const key = `${op.from}\0${op.relation}\0${op.to}`;
      const existing = this.edges.get(key);
      this.edges.set(key, existing
        ? { ...existing, evidence: [...existing.evidence, ...op.evidence].slice(-8) }
        : { from: op.from, relation: op.relation, to: op.to, evidence: op.evidence });
    }
  }

  private step(event: EventRecord): void {
    if (event.name === "session/open") this.openSession(event);
    if (CONTEXT_GRAPH_ROWS.has(event.name)) this.requireFeature(event);
    if (event.name === "work/goal") this.openGoal(event);
    else if (event.name === "user/message" && this.currentGoal === undefined) this.openGoal(event);
    if (event.name === CONTEXT_SCOPE_ROW) {
      const scope = parseRow(scopeRowSchema, event.payload, event.name);
      if (scope.repository_id !== this.repositoryId || scope.mode !== this.scopeMode) {
        this.repositoryId = scope.repository_id;
        this.scopeMode = scope.mode;
        this.emit({ op: "node", id: `repository:${scope.repository_id}`, kind: "claim",
          body: { repository: scope.repository_id, source: scope.source, ref: ref(event) } });
      }
      // R8-03: the scope row in force — the branch-context import binds it.
      this.scopeRef = ref(event);
    }
    this.facts.set(event.seq, {
      seq: event.seq,
      hash: event.hash,
      name: event.name,
      kind: event.kind,
      goalId: this.currentGoal,
      repositoryId: this.repositoryId,
      ...(typeof event.payload.blob === "string" ? { blob: event.payload.blob } : {}),
      ...(typeof event.payload.blob_bytes === "number" ? { blobBytes: event.payload.blob_bytes } : {}),
      availability: event.name === "tool/result" && this.redactedCalls.has(String(event.payload.id)) ? "partial" : availabilityOf(event),
      authority: this.formalActive(event) && isFormalHostRow(event) ? "host_observation" : authorityOf(event),
    });
    if (event.name === "work/ledger_case" || event.name === "work/ledger") this.caseCommandsFrom(event);
    if (this.formalActive(event)) this.formal(event);
    // R8-03: the ordering bound (no current provider request or frame before
    // the import) and the spent-resource bound (a released or closed
    // workspace supplies no current imported context).
    if (event.name === "provider/request") this.providerRequestSeen = true;
    if (event.name === CONTEXT_BRANCH_IMPORT_ROW) return this.branchImport(event);
    if (event.name === CONTEXT_BRANCH_FIT_ROW) return this.branchFit(event);
    if ((event.name === "branch/workspace_release" || event.name === "branch/workspace_closed")
      && typeof event.payload.id === "string") {
      this.releasedWorkspaces.add(event.payload.id);
    }
    const judged = judgedFact(event, this.caseCommands);
    if (judged) {
      this.judged.set(event.seq, judged);
      if (judged.commandDigest !== null && judged.verdict !== null) {
        const list = this.judgedByDigest.get(judged.commandDigest) ?? [];
        list.push(event.seq);
        this.judgedByDigest.set(judged.commandDigest, list);
      }
    }
    switch (event.name) {
      case "tool/output_redacted":
        // The tool's own output was scrubbed before the result row was
        // written: whatever that row keeps is partial.
        if (typeof event.payload.id === "string") this.redactedCalls.add(event.payload.id);
        return;
      case "tool/call": return this.call(event);
      case "tool/result": return this.result(event);
      case "tool/source": return this.source(event);
      case "workspace/read_receipt":
      case "workspace/mutation_committed": return this.fileVersion(event);
      case "tool/end": return this.end(event);
      case "exec/receipt":
      case "verify/receipt": return this.receipt(event);
      case "ledger/check":
      case "ledger/case_probe":
      case "ledger/property": return this.check(event);
      case "agent/status": {
        const status = event.payload.status;
        if (status === "idle" || status === "failed" || status === "cancelled") this.interruptPending(event);
        return;
      }
      case CONTEXT_TREE_ROW: return this.treeRow(event);
      case CONTEXT_ATTEMPT_ROW: return this.attempt(event);
      case CONTEXT_LESSON_ROW: return this.lesson(event);
      case CONTEXT_ASSESSMENT_ROW: return this.assessment(event);
      case CONTEXT_FRAME_ROW: return this.frame(event);
      case CONTEXT_SURFACE_ROW: return this.surface(event);
      case CONTEXT_PRESENTED_ROW: return this.presented(event);
      case CONTEXT_QUERY_ROW: parseRow(queryRowSchema, event.payload, event.name); this.queries += 1; return;
      case CONTEXT_DEGRADED_ROW: parseRow(degradedRowSchema, event.payload, event.name); this.degraded += 1; return;
      default:
    }
  }

  private openSession(event: EventRecord): void {
    // A restart ends every action still open: its result is unknown.
    this.interruptPending(event);
    const opened = event.payload.session_id ?? event.payload.id;
    if (typeof opened === "string") this.sessionId = opened;
    if (!("replay_features" in event.payload)) {
      if (this.versioned) throw new ContextGraphSchemaError("a versioned session cannot reopen as a legacy session");
      return;
    }
    const generation = sessionReplayFeatureGenerationIndex(event.payload.replay_features);
    if (generation === undefined) throw new ContextGraphSchemaError("unknown replay feature generation");
    if (generation < this.highestGeneration) throw new ContextGraphSchemaError("replay feature generation downgrade");
    this.versioned = true;
    this.highestGeneration = generation;
    const features = sessionReplayFeaturesAt(generation);
    if (this.contributionStart === undefined && features.includes("host-context-frame-v1")) {
      this.contributionStart = event.seq;
    }
    if (this.featureStart === undefined && features.includes(CONTEXT_GRAPH_FEATURE)) {
      this.featureStart = event.seq;
    }
    if (this.lessonObservationStart === undefined && features.includes(LESSON_OBSERVATION_FEATURE)) {
      this.lessonObservationStart = event.seq;
    }
    if (this.formalStart === undefined && features.includes(FORMAL_WORK_FEATURE)) {
      this.formalStart = event.seq;
    }
    if (this.branchContextStart === undefined && features.includes(BRANCH_CONTEXT_FEATURE)) {
      this.branchContextStart = event.seq;
    }
  }

  private requireFeature(event: EventRecord): void {
    if (this.featureStart === undefined || event.seq <= this.featureStart) {
      throw new ContextGraphSchemaError(`${event.name} precedes the ${CONTEXT_GRAPH_FEATURE} feature generation`);
    }
    if (event.name === CONTEXT_SURFACE_ROW ? event.kind !== "surface" : event.kind !== "observe") {
      throw new ContextGraphSchemaError(`${event.name} has the wrong event kind`);
    }
  }

  /** Whether a row folds under context-formal-work-v1 semantics. */
  formalActive(event: Pick<EventRecord, "seq">): boolean {
    return this.formalStart !== undefined && event.seq > this.formalStart;
  }

  /** context-formal-work-v1: index a formal Work start as a host action, its
   * ends, and its verdict as that action's observation, judged prefix-locally
   * (formal-work.ts). Plan declarations only record the declared case. */
  private formal(event: EventRecord): void {
    if (event.name === "work/case" && event.payload.status === undefined && event.payload.execution_start === undefined) {
      if (typeof event.payload.id === "string" && typeof event.payload.case_digest === "string" && typeof event.payload.command === "string") {
        this.declaredCases.set(event.payload.id, { caseDigest: event.payload.case_digest, command: event.payload.command });
      }
      return;
    }
    if (isFormalStart(event)) return this.formalStartRow(event);
    if (isFormalEnd(event)) {
      this.formalExecutions.get(Number(event.payload.execution_start))?.ends.push(ref(event));
      return;
    }
    if (isFormalVerdict(event)) return this.formalVerdict(event);
    // A draft's admission is coupled to the obligation snapshot right after
    // it: only then does the Work validator read it as admitted.
    if (event.name === "work/obligations" && this.formalPending.size > 0) {
      const admission = this.prefixAt(event.seq)[event.seq - 2];
      if (admission?.name === "work/plan_draft_result" && admission.kind === "observe" && admission.payload.status === "admitted") this.formalAdmission(admission, event);
    }
  }

  private formalStartRow(event: EventRecord): void {
    const p = event.payload;
    if (typeof p.command !== "string" || typeof p.obligation_key !== "string" || typeof p.workspace !== "string") return;
    const goalId = this.currentGoal ?? "goal:none";
    const key = `wx:${event.seq}`;
    const execution: FormalExecution = {
      key, start: ref(event), command: p.command, commandDigest: sha256(p.command), obligationKey: p.obligation_key,
      workspace: p.workspace, phase: String(p.phase), goalId, repositoryId: this.repositoryId, ends: [],
    };
    this.formalExecutions.set(event.seq, execution);
    this.emit({ op: "node", id: key, kind: "action", body: {
      kind: "formal_work_execution", command_digest: execution.commandDigest, obligation_key: execution.obligationKey,
      phase: execution.phase, protection: String(p.protection), workspace_digest: String(p.workspace_digest), start: execution.start,
    } });
    this.emit({ op: "edge", from: key, relation: "requested_by", to: implicitAttemptId(goalId), evidence: [ref(event)] });
  }

  private formalVerdict(event: EventRecord): void {
    const p = event.payload;
    const execution = this.formalExecutions.get(Number(p.execution_start));
    const verdict: FormalVerdict = {
      ref: ref(event), start: Number(p.execution_start), caseId: String(p.id), status: String(p.status),
      commandDigest: sha256(String(p.command)), obligationKey: String(p.obligation_key), caseDigest: String(p.case_digest),
      workspace: execution?.workspace ?? "", goalId: this.currentGoal ?? "goal:none", repositoryId: this.repositoryId,
      draft: p.draft_ref === undefined ? undefined : canonicalJson(p.draft_ref), judged: "not_judged", reason: "", files: undefined,
    };
    const judged = execution && (execution.goalId !== verdict.goalId || execution.repositoryId !== verdict.repositoryId)
      ? { judged: "not_judged" as const, reason: "the scope changed during the execution" }
      : judgeVerdict({ row: event, prefix: this.prefixAt(event.seq), execution, declared: this.declaredCases, read: this.retained });
    verdict.judged = judged.judged;
    verdict.reason = judged.reason;
    verdict.files = judged.files;
    if (execution && execution.verdict === undefined) execution.verdict = event.seq;
    this.formalVerdicts.set(event.seq, verdict);
    if (verdict.judged === "pending_admission" && verdict.draft !== undefined) {
      this.formalPending.set(verdict.draft, [...(this.formalPending.get(verdict.draft) ?? []), event.seq]);
    }
    this.formalObservation(verdict);
  }

  /** A draft's coupled admission: its pending baseline verdicts are judged
   * now, against the prefix that ends at the coupled snapshot row. */
  private formalAdmission(event: EventRecord, coupled: EventRecord): void {
    const draft = canonicalJson({ seq: event.payload.draft_seq, hash: event.payload.draft_hash });
    const pending = this.formalPending.get(draft);
    if (pending === undefined) return;
    this.formalPending.delete(draft);
    const prefix = this.prefixAt(coupled.seq);
    for (const seq of pending) {
      const verdict = this.formalVerdicts.get(seq)!;
      const judged = judgeVerdict({ row: prefix[seq - 1]!, prefix, execution: this.formalExecutions.get(verdict.start),
        declared: this.declaredCases, read: this.retained });
      verdict.judged = judged.judged === "pending_admission" ? "not_judged" : judged.judged;
      verdict.reason = judged.judged === "pending_admission" ? "its draft was admitted without it" : judged.reason;
      verdict.files = judged.files;
      this.formalObservation(verdict, ref(coupled));
    }
  }

  /** Emit (or re-emit) a verdict's observation node and index a judged one. */
  private formalObservation(verdict: FormalVerdict, admission?: EventRef): void {
    const execution = this.formalExecutions.get(verdict.start);
    const id = `obs:wx:${verdict.ref.seq}`;
    this.emit({ op: "node", id, kind: "observation", body: {
      execution: execution?.key ?? null, case: verdict.caseId, status: verdict.status, judged: verdict.judged, reason: verdict.reason,
      verdict: verdict.ref, end: execution?.ends[0] ?? null, obligation_key: verdict.obligationKey, case_digest: verdict.caseDigest,
      command_digest: verdict.commandDigest, ...(admission === undefined ? {} : { admission }),
    } });
    if (execution) this.emit({ op: "edge", from: id, relation: "observed_from", to: execution.key, evidence: [admission ?? verdict.ref] });
    if (verdict.judged !== "qualifying_red" && verdict.judged !== "green") return;
    const obligation = obligationOf(verdict);
    this.formalJudged.set(obligation, [...(this.formalJudged.get(obligation) ?? []), verdict.ref.seq]);
    const scope = scopeKey(verdict.repositoryId, verdict.goalId);
    if (verdict.judged === "qualifying_red") {
      this.formalFailures.set(scope, [...(this.formalFailures.get(scope) ?? []), verdict.ref.seq]);
      return;
    }
    // A later authenticated GREEN of the same obligation in the same scope
    // resolves its earlier qualifying REDs: a host fact about that obligation,
    // never a claim about what caused either outcome.
    for (const seq of this.formalFailures.get(scope) ?? []) {
      const failure = this.formalVerdicts.get(seq)!;
      if (failure.resolvedBy !== undefined || failure.ref.seq >= verdict.ref.seq || obligationOf(failure) !== obligation) continue;
      failure.resolvedBy = verdict.ref.seq;
      if (execution) this.emit({ op: "edge", from: execution.key, relation: "revalidates", to: `wx:${failure.start}`, evidence: [admission ?? verdict.ref] });
    }
  }

  /** The rows up to and including `seq` of the array this fold extends over. */
  private prefixAt(seq: number): readonly EventRecord[] {
    return (this.branchSource ?? []).slice(0, seq);
  }

  private openGoal(event: EventRecord): void {
    let scopeSeq = event.seq;
    if (event.name === "work/goal") {
      const scope = event.payload.scope_seq;
      if (typeof scope === "number" && Number.isSafeInteger(scope) && scope > 0 && scope <= event.seq) scopeSeq = scope;
    }
    const id = `goal:${scopeSeq}`;
    const statement = typeof event.payload.statement === "string" ? event.payload.statement
      : typeof event.payload.text === "string" ? event.payload.text : undefined;
    // R8-03: the newest statement a goal id carries — BEFORE the first-open
    // early returns below, so a restated goal updates it.
    if (statement !== undefined) {
      this.goalStatements.set(id, sha256(statement));
      this.goalStatementRefs.set(id, ref(event));
    }
    if (this.currentGoal === id) return;
    this.currentGoal = id;
    if (this.goals.has(id)) return;
    const scopeFact = this.facts.get(scopeSeq);
    const goalRef = scopeSeq === event.seq || !scopeFact ? ref(event) : { seq: scopeFact.seq, hash: scopeFact.hash };
    const body = { ref: goalRef, source: event.name, ...(statement === undefined ? {} : { statement_digest: sha256(statement) }) };
    this.goals.set(id, { id, ref: goalRef, ...(statement === undefined ? {} : { statementDigest: sha256(statement) }) });
    this.emit({ op: "node", id, kind: "goal", body });
    const implicit = implicitAttemptId(id);
    this.emit({ op: "node", id: implicit, kind: "attempt", body: { goal: id, intent_origin: "unknown", outcome: "open", outcome_authority: "unknown" } });
    this.emit({ op: "edge", from: implicit, relation: "pursues", to: id, evidence: [goalRef] });
  }

  private call(event: EventRecord): void {
    const callId = typeof event.payload.id === "string" ? event.payload.id : "";
    const tool = typeof event.payload.name === "string" ? event.payload.name : "unknown";
    const goalId = this.currentGoal ?? "goal:none";
    const key = `act:${event.seq}`;
    const argsDigest = typeof event.payload.args_digest === "string" ? event.payload.args_digest : undefined;
    const sameKey = argsDigest === undefined ? undefined : `${scopeKey(this.repositoryId, goalId)}\0${tool}\0${argsDigest}`;
    const args = event.payload.args as { path?: unknown } | undefined;
    const earlier = sameKey === undefined ? [] : [...(this.sameAction.get(sameKey) ?? [])];
    const invocation: Invocation = {
      key, callId, tool, call: ref(event), argsDigest,
      argHint: typeof event.payload.arg_hint === "string" ? event.payload.arg_hint : "",
      path: args !== null && typeof args === "object" && typeof args.path === "string" ? args.path : undefined,
      goalId, repositoryId: this.repositoryId, status: "pending", resultAvailability: "unavailable",
      rows: [], rowsPartial: false, receipts: [], checks: [], failed: false, mechanical: "pending",
      attempts: new Set([implicitAttemptId(goalId)]), sameAs: earlier,
    };
    if (sameKey !== undefined) this.sameAction.set(sameKey, [...earlier, key].slice(-SAME_ACTION_KEEP));
    this.invocations.set(key, invocation);
    this.byCallSeq.set(event.seq, key);
    this.invocationBySeq.set(event.seq, key);
    if (callId !== "") this.openByCall.set(callId, key);
    this.pending.add(key);
    this.emit({ op: "node", id: key, kind: "action", body: { tool, call_id: callId, args_digest: argsDigest ?? null, call: ref(event) } });
    this.emit({ op: "edge", from: key, relation: "requested_by", to: implicitAttemptId(goalId), evidence: [ref(event)] });
  }

  private invocationFor(event: EventRecord): Invocation | undefined {
    const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
    const key = id === undefined ? undefined : this.openByCall.get(id);
    return key === undefined ? undefined : this.invocations.get(key);
  }

  private result(event: EventRecord): void {
    const invocation = this.invocationFor(event);
    if (!invocation) return;
    invocation.result = ref(event);
    this.invocationBySeq.set(event.seq, invocation.key);
    invocation.resultAvailability = this.redactedCalls.delete(invocation.callId) ? "partial" : availabilityOf(event);
    if (typeof event.payload.exit_code === "number") invocation.exitCode = event.payload.exit_code;
    if (typeof event.payload.text === "string") invocation.resultHead = head(event.payload.text, 480);
  }

  /** #223: a reduced result's envelope, attached to its invocation by id. */
  private source(event: EventRecord): void {
    const invocation = this.invocationFor(event);
    if (!invocation || typeof event.payload.digest !== "string") return;
    const projection = (event.payload.projection ?? {}) as { omitted_bytes?: unknown; recovery?: unknown };
    const recovery = projection.recovery === "available" || projection.recovery === "not_applicable" ? projection.recovery : "unavailable";
    invocation.source = {
      ref: ref(event), digest: event.payload.digest,
      bytes: typeof event.payload.source_bytes === "number" ? event.payload.source_bytes : 0,
      stored: typeof event.payload.blob === "string",
      omittedBytes: typeof projection.omitted_bytes === "number" ? projection.omitted_bytes : 0,
      recovery,
      completeness: typeof event.payload.completeness === "string" ? event.payload.completeness : "unknown",
    };
    this.invocationBySeq.set(event.seq, invocation.key);
  }

  /** #221: a file version the host observed (read receipt or commit). */
  private fileVersion(event: EventRecord): void {
    const key = typeof event.payload.path_digest === "string" ? event.payload.path_digest : undefined;
    if (key === undefined) return;
    if (event.name === "workspace/read_receipt" && typeof event.payload.digest === "string") {
      this.fileVersions.set(key, { digest: event.payload.digest, ref: ref(event),
        coverage: event.payload.coverage === "complete" && event.payload.mapping === "exact" ? "exact" : "partial" });
    } else if (event.name === "workspace/mutation_committed") {
      const after = event.payload.after as { digest?: unknown } | undefined;
      if (typeof after?.digest === "string") this.fileVersions.set(key, { digest: after.digest, ref: ref(event), coverage: "exact" });
    }
  }

  private end(event: EventRecord): void {
    const invocation = this.invocationFor(event);
    if (!invocation) return;
    if (invocation.status === "completed") return;
    if (invocation.status === "interrupted") {
      const list = this.interrupted.get(scopeKey(invocation.repositoryId, invocation.goalId));
      if (list) list.splice(list.indexOf(invocation.key), 1);
    }
    invocation.status = "completed";
    invocation.end = ref(event);
    this.invocationBySeq.set(event.seq, invocation.key);
    invocation.error = event.payload.error === true;
    this.pending.delete(invocation.key);
    this.openByCall.delete(invocation.callId);
    const observed = Array.isArray(event.payload.observed_rows) ? event.payload.observed_rows : [];
    for (const item of observed) {
      const row = item as { seq?: unknown; hash?: unknown };
      if (typeof row.seq !== "number" || typeof row.hash !== "string") continue;
      const fact = this.facts.get(row.seq);
      // A row the log does not hold at that seq with that hash is not linked.
      if (!fact || fact.hash !== row.hash) continue;
      invocation.rows.push({ seq: fact.seq, hash: fact.hash });
      this.rowInvocation.set(fact.seq, invocation.key);
      const receipt = this.receipts.get(fact.seq);
      if (receipt) invocation.receipts.push(receipt);
      const check = this.checks.get(fact.seq);
      if (check) invocation.checks.push(check);
    }
    invocation.rowsPartial = typeof event.payload.observed_rows_dropped === "number";
    const parts: string[] = [];
    if (invocation.error) parts.push("error");
    if (invocation.exitCode !== undefined && invocation.exitCode !== 0) parts.push(`exit ${invocation.exitCode}`);
    for (const receipt of invocation.receipts) {
      if (receipt.exitCode !== 0 && !parts.includes(`exit ${receipt.exitCode}`)) parts.push(`exit ${receipt.exitCode}`);
    }
    for (const check of invocation.checks) {
      if (check.status === "red" || check.status === "not_runnable") parts.push(`check ${check.caseId} ${check.status}`);
    }
    invocation.failed = parts.length > 0;
    invocation.mechanical = invocation.failed ? parts.join("; ") : "ok";
    const observation = `obs:${event.seq}`;
    this.emit({ op: "node", id: observation, kind: "observation", body: {
      invocation: invocation.key, mechanical: invocation.mechanical,
      availability: invocation.rowsPartial ? "partial" : invocation.resultAvailability,
      rows: invocation.rows,
    } });
    this.emit({ op: "edge", from: observation, relation: "observed_from", to: invocation.key, evidence: [ref(event)] });
    for (const receipt of invocation.receipts) {
      const before = `rv:workspace:${receipt.image}`;
      this.emit({ op: "node", id: before, kind: "resource_version", body: { kind: "workspace", digest: receipt.image, coverage: receipt.unknown ? "partial" : "exact" } });
      this.emit({ op: "edge", from: observation, relation: "read_version", to: before, evidence: [receipt.ref] });
      if (receipt.imageAfter !== receipt.image) {
        const after = `rv:workspace:${receipt.imageAfter}`;
        this.emit({ op: "node", id: after, kind: "resource_version", body: { kind: "workspace", digest: receipt.imageAfter, coverage: receipt.unknown ? "partial" : "exact" } });
        this.emit({ op: "edge", from: observation, relation: "produced_version", to: after, evidence: [receipt.ref] });
      }
    }
    if (invocation.failed) {
      const scope = scopeKey(invocation.repositoryId, invocation.goalId);
      const list = this.failures.get(scope) ?? [];
      list.push(invocation.key);
      this.failures.set(scope, list);
      this.unresolved.set(scope, (this.unresolved.get(scope) ?? 0) + 1);
    } else if (invocation.argsDigest !== undefined) {
      // The same action (same tool, same argument digest, same goal) later
      // completed without a mechanical failure: a host fact about that
      // action, never a claim that an unrelated success fixed anything.
      for (const earlier of invocation.sameAs) {
        const prior = this.invocations.get(earlier);
        if (prior && prior.failed && prior.resolvedBy === undefined) {
          prior.resolvedBy = invocation.key;
          const scope = scopeKey(prior.repositoryId, prior.goalId);
          this.unresolved.set(scope, Math.max(0, (this.unresolved.get(scope) ?? 1) - 1));
          this.emit({ op: "edge", from: invocation.key, relation: "revalidates", to: prior.key, evidence: [ref(event)] });
        }
      }
    }
  }

  private receipt(event: EventRecord): void {
    const image = typeof event.payload.image === "string" ? event.payload.image : "";
    const imageAfter = typeof event.payload.image_after === "string" ? event.payload.image_after : image;
    const live = event.name === "exec/receipt" && event.payload.isolation !== "fresh-image";
    const fact: ReceiptFact = {
      ref: ref(event), name: event.name, image, imageAfter,
      exitCode: typeof event.payload.exit_code === "number" ? event.payload.exit_code : -1,
      live, unknown: typeof event.payload.unknown === "object" && event.payload.unknown !== null,
    };
    this.receipts.set(event.seq, fact);
    if (live && imageAfter !== "") {
      const changed = this.latestImage?.image !== imageAfter;
      this.latestImage = { image: imageAfter, ref: ref(event) };
      if (changed) {
        this.emit({ op: "node", id: `rv:workspace:${imageAfter}`, kind: "resource_version",
          body: { kind: "workspace", digest: imageAfter, coverage: fact.unknown ? "partial" : "exact" } });
      }
    }
  }

  private check(event: EventRecord): void {
    this.checks.set(event.seq, {
      ref: ref(event), name: event.name,
      caseId: typeof event.payload.case === "string" ? event.payload.case : typeof event.payload.id === "string" ? event.payload.id : "?",
      status: typeof event.payload.status === "string" ? event.payload.status : "unknown",
      ...(typeof event.payload.exit_code === "number" ? { exitCode: event.payload.exit_code } : {}),
    });
  }

  private interruptPending(event: EventRecord): void {
    for (const key of [...this.pending]) {
      const invocation = this.invocations.get(key)!;
      invocation.status = "interrupted";
      invocation.mechanical = "interrupted; result unknown";
      const scope = scopeKey(invocation.repositoryId, invocation.goalId);
      const list = this.interrupted.get(scope) ?? [];
      list.push(invocation.key);
      this.interrupted.set(scope, list);
      this.pending.delete(key);
      this.openByCall.delete(invocation.callId);
      this.emit({ op: "node", id: `obs:interrupted:${invocation.key}`, kind: "observation",
        body: { invocation: invocation.key, mechanical: "interrupted", availability: "unavailable", at: ref(event) } });
      this.emit({ op: "edge", from: `obs:interrupted:${invocation.key}`, relation: "observed_from", to: invocation.key, evidence: [ref(event)] });
    }
  }

  private attempt(event: EventRecord): void {
    const { attempt } = parseRow(attemptRowSchema, event.payload, event.name);
    if (this.attempts.has(attempt.id)) throw new ContextGraphSchemaError(`attempt ${attempt.id} recorded twice`);
    // §132 V2: every host-derived field is held to the log at this row.
    if (attempt.goalId !== this.currentGoal || attempt.inputScope.repositoryId !== this.repositoryId
      || (attempt.inputScope.goalId !== null && attempt.inputScope.goalId !== this.currentGoal)) {
      throw new ContextGraphSchemaError(`attempt ${attempt.id} names another scope than the log's`);
    }
    for (const action of attempt.actionRefs) {
      const fact = this.facts.get(action.seq);
      // context-formal-work-v1: a genuine formal Work execution of this
      // repository and goal is a host action an attempt may name.
      const formal = this.formalExecutions.get(action.seq);
      if (fact && formal && fact.hash === action.hash && formal.start.hash === action.hash) {
        if (formal.goalId !== attempt.goalId || formal.repositoryId !== this.repositoryId) {
          throw new ContextGraphSchemaError(`attempt ${attempt.id} names a formal execution of another scope`);
        }
        continue;
      }
      if (!fact || fact.hash !== action.hash || fact.name !== "tool/call") throw new ContextGraphSchemaError(`attempt ${attempt.id} action is not a recorded call`);
    }
    for (const item of [...attempt.observationRefs, ...attempt.changedConditions, ...attempt.inputScope.resources.map((resource) => resource.evidence)]) {
      this.checkEvidence(item, `attempt ${attempt.id}`);
    }
    if (attempt.previousAttempt !== null && !this.attempts.has(attempt.previousAttempt)) throw new ContextGraphSchemaError(`attempt ${attempt.id} retries an unknown attempt`);
    this.attempts.set(attempt.id, { attempt, ref: ref(event) });
    const attemptScope = scopeKey(attempt.inputScope.repositoryId, attempt.goalId);
    const byGoal = this.attemptsByGoal.get(attemptScope) ?? [];
    byGoal.push(attempt.id);
    this.attemptsByGoal.set(attemptScope, byGoal);
    this.emit({ op: "node", id: attempt.id, kind: "attempt", body: attempt as unknown as Record<string, unknown> });
    this.emit({ op: "edge", from: attempt.id, relation: "pursues", to: attempt.goalId, evidence: [ref(event)] });
    if (attempt.question.trim() !== "") {
      const question = `q:${attempt.id}`;
      this.emit({ op: "node", id: question, kind: "question", body: { text_digest: sha256(attempt.question) } });
      this.emit({ op: "edge", from: attempt.id, relation: "tests_hypothesis", to: question, evidence: [ref(event)] });
    }
    for (const action of attempt.actionRefs) {
      const formal = this.formalExecutions.get(action.seq);
      if (formal && formal.start.hash === action.hash) {
        this.emit({ op: "edge", from: formal.key, relation: "requested_by", to: attempt.id, evidence: [ref(event)] });
        continue;
      }
      const key = this.byCallSeq.get(action.seq);
      const invocation = key === undefined ? undefined : this.invocations.get(key);
      if (!invocation || invocation.call.hash !== action.hash) continue;
      invocation.attempts.add(attempt.id);
      this.emit({ op: "edge", from: invocation.key, relation: "requested_by", to: attempt.id, evidence: [ref(event)] });
    }
    if (attempt.previousAttempt !== null) {
      this.emit({ op: "edge", from: attempt.id, relation: "retries_with", to: attempt.previousAttempt,
        evidence: [ref(event), ...attempt.changedConditions.map((item) => item.event)] });
    }
  }

  private lesson(event: EventRecord): void {
    const { lesson } = parseRow(lessonRowSchema, event.payload, event.name);
    let state = this.lessons.get(lesson.id);
    const expected = (state?.revisions.length ?? 0) + 1;
    if (lesson.revision !== expected) throw new ContextGraphSchemaError(`lesson ${lesson.id} revision ${lesson.revision} out of order`);
    if (!state) {
      state = { id: lesson.id, revisions: [], assessments: [] };
      this.lessons.set(lesson.id, state);
      this.lessonOrder.push(lesson.id);
    }
    const previous = state.revisions.at(-1);
    // §132 V2: the evidence's authority, availability and body, the scope and
    // the workspace versions are the log's facts at this row, re-derived.
    for (const item of lesson.evidence) this.checkEvidence(item, lesson.id);
    if (lesson.scope.repositoryId !== this.repositoryId || (lesson.scope.goalId !== null && lesson.scope.goalId !== this.currentGoal)) {
      throw new ContextGraphSchemaError(`lesson ${lesson.id} names another scope than the log's`);
    }
    const workspace = workspaceVersions(this, lesson.evidence);
    if (lesson.schema === 2 && (this.lessonObservationStart === undefined || event.seq <= this.lessonObservationStart)) {
      throw new ContextGraphSchemaError("lesson schema 2 precedes the context-lesson-observation-v1 feature generation");
    }
    if (lesson.schema === 3 && !this.formalActive(event)) {
      throw new ContextGraphSchemaError("lesson schema 3 precedes the context-formal-work-v1 feature generation");
    }
    const declaredWorkspace = lesson.scope.resources.filter((item) => item.kind === "workspace");
    if (lesson.schema !== 1 && declaredWorkspace.length !== 0) {
      throw new ContextGraphSchemaError(`lesson ${lesson.id} mixes observation versions into declared dependencies`);
    }
    const recordedWorkspace = lesson.schema === 1 ? declaredWorkspace : lesson.observationResources;
    if (canonicalJson(workspace) !== canonicalJson(recordedWorkspace)) throw new ContextGraphSchemaError(`lesson ${lesson.id} workspace versions differ from the log`);
    const declaredFiles = lesson.scope.resources.filter((item) => item.kind !== "workspace");
    if (canonicalJson(declaredFiles) !== canonicalJson(fileResources(this, declaredFiles.map((item) => item.resourceId), lesson.evidence[0]!))) {
      throw new ContextGraphSchemaError(`lesson ${lesson.id} declares a resource version the host did not observe`);
    }
    for (const attemptId of lesson.attemptIds) if (!this.attempts.has(attemptId)) throw new ContextGraphSchemaError(`lesson ${lesson.id} names an unknown attempt`);
    // context-formal-work-v1: an authenticated qualifying RED among the
    // attempts' formal executions is the observable, and only schema 3 holds
    // one; every earlier generation derives exactly what it always did.
    const formal = this.formalStart === undefined ? null : formalObservableOf(this, lesson.attemptIds);
    if ((lesson.schema === 3) !== (formal !== null)
      || canonicalJson(lesson.observable) !== canonicalJson(formal ?? observableOf(this, lesson.attemptIds))) {
      throw new ContextGraphSchemaError(`lesson ${lesson.id} states an observable the host did not derive`);
    }
    if (previous && (lesson.previousRevision === null || lesson.previousRevision.seq !== previous.ref.seq || lesson.previousRevision.hash !== previous.ref.hash)) {
      throw new ContextGraphSchemaError(`lesson ${lesson.id} does not name its previous revision`);
    }
    if (!previous && lesson.previousRevision !== null) throw new ContextGraphSchemaError(`lesson ${lesson.id} names a previous revision it does not have`);
    state.revisions.push({ lesson, ref: ref(event) });
    const node = lessonNodeId(lesson.id, lesson.revision);
    this.emit({ op: "node", id: node, kind: "lesson", body: lesson as unknown as Record<string, unknown> });
    if (lesson.scope.goalId !== null) {
      this.emit({ op: "edge", from: node, relation: "applies_to", to: lesson.scope.goalId, evidence: [ref(event)] });
    }
    for (const item of lesson.evidence) {
      this.emit({ op: "edge", from: evidenceNode(this, item.event), relation: "cited_by", to: node, evidence: [ref(event)] });
    }
    for (const resource of lesson.scope.resources) {
      const target = resource.kind === "workspace" && resource.digest !== null
        ? `rv:workspace:${resource.digest}` : `resource:${resource.kind}:${resource.resourceId}`;
      if (!this.nodes.has(target)) this.emit({ op: "node", id: target, kind: "resource_version", body: { kind: resource.kind, digest: resource.digest ?? null, coverage: resource.coverage } });
      this.emit({ op: "edge", from: node, relation: "depends_on", to: target, evidence: [resource.evidence.event] });
    }
    for (const attemptId of lesson.attemptIds) {
      this.emit({ op: "edge", from: attemptId, relation: "cited_by", to: node, evidence: [ref(event)] });
    }
    if (formal !== null) {
      // The observation the prediction is scoped to, with its retained
      // provenance: the verdict row and the exact execution start.
      this.emit({ op: "edge", from: `obs:wx:${formal.source.seq}`, relation: "cited_by", to: node, evidence: [ref(event), formal.source, formal.executionStart] });
    }
    if (previous) this.emit({ op: "edge", from: node, relation: "supersedes", to: lessonNodeId(lesson.id, previous.lesson.revision), evidence: [ref(event)] });
    if (lesson.supersedes !== null) {
      const other = this.lessons.get(lesson.supersedes.lesson);
      if (!other) throw new ContextGraphSchemaError(`lesson ${lesson.id} supersedes an unknown lesson`);
      other.supersededBy = { lesson: lesson.id, revision: lesson.revision };
      this.emit({ op: "edge", from: node, relation: "supersedes", to: lessonNodeId(lesson.supersedes.lesson, lesson.supersedes.revision), evidence: [ref(event)] });
    }
  }

  private caseCommandsFrom(event: EventRecord): void {
    const record = (item: unknown) => {
      if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        && typeof (item as { command?: unknown }).command === "string") {
        this.caseCommands.set((item as { id: string }).id, (item as { command: string }).command);
      }
    };
    if (event.name === "work/ledger_case") record(event.payload.case);
    else {
      const graph = event.payload.graph as { cases?: unknown } | undefined;
      if (Array.isArray(graph?.cases)) for (const item of graph.cases) record(item);
    }
  }

  private treeRow(event: EventRecord): void {
    const row = parseRow(treeRowSchema, event.payload, event.name);
    const files = new Map(this.tree?.files ?? []);
    for (const file of row.files) files.set(file.path, file.digest);
    this.tree = { image: row.image, files, ref: ref(event) };
    this.emit({ op: "node", id: `tree:${event.seq}`, kind: "resource_version", body: { image: row.image, files: row.files } });
  }

  private assessment(event: EventRecord): void {
    const { assessment } = parseRow(assessmentRowSchema, event.payload, event.name);
    const state = this.lessons.get(assessment.lesson);
    if (!state || assessment.revision !== state.revisions.length) {
      throw new ContextGraphSchemaError(`assessment ${assessment.id} names a lesson revision that is not the latest`);
    }
    // §133 A1'': host-minted, re-derived here: the one cited row is a judged
    // run newer than the revision, of exactly the revision's observable
    // command digest, not assessed before; its verdict decides the stance.
    const revision = state.revisions[assessment.revision - 1]!;
    const observable = revision.lesson.observable;
    const cited = assessment.evidence[0]!;
    this.checkEvidence(cited, `assessment ${assessment.id}`);
    const key = `${assessment.lesson}#${assessment.revision}@${cited.event.seq}`;
    if (observable !== null && "kind" in observable) {
      // Schema 3: a later authenticated execution of the same obligation
      // under the lesson's unchanged declared conditions (formal-work.ts).
      const verdict = this.formalVerdicts.get(cited.event.seq);
      const observed = verdict === undefined ? undefined : formalAssessmentOf(this.formalExecutions, revision, verdict);
      if (observed === undefined || observed !== assessment.observed || this.assessed.has(key)
        || assessment.stance !== (assessment.observed === "fail" ? "supports" : "contradicts")) {
        throw new ContextGraphSchemaError(`assessment ${assessment.id} states host facts the log does not show`);
      }
    } else {
      const fact = this.judged.get(cited.event.seq);
      if (observable === null || !fact || fact.commandDigest !== observable.commandDigest || fact.verdict !== assessment.observed
        || cited.event.seq <= revision.ref.seq || this.assessed.has(key)
        || assessment.stance !== (assessment.observed === "fail" ? "supports" : "contradicts")) {
        throw new ContextGraphSchemaError(`assessment ${assessment.id} states host facts the log does not show`);
      }
    }
    this.assessed.add(key);
    state.assessments.push({ assessment, ref: ref(event) });
    this.assessmentCount += 1;
    const node = lessonNodeId(assessment.lesson, assessment.revision);
    for (const item of assessment.evidence) {
      this.emit({ op: "edge", from: evidenceNode(this, item.event), relation: assessment.stance === "supports" ? "supports" : "contradicts",
        to: node, evidence: [ref(event)] });
    }
  }

  private frame(event: EventRecord): void {
    if (event.payload.schema !== "context-graph-v1") {
      if (event.payload.schema === "host-context-frame-v1" &&
          (this.contributionStart === undefined || event.seq <= this.contributionStart)) {
        throw new ContextGraphSchemaError("a host contribution precedes its replay feature generation");
      }
      const row = contributionFrameOf(event, this.contributionStart === undefined || event.seq < this.contributionStart);
      if (this.frames.has(row.frame.id)) throw new ContextGraphSchemaError(`frame ${row.frame.id} recorded twice`);
      const source = this.facts.get(row.frame.sourceHead.seq);
      if (!source || source.hash !== row.frame.sourceHead.hash || source.seq !== event.seq - 1 || row.frame.sourceHead.hash !== event.prev_hash) {
        throw new ContextGraphSchemaError(`contribution ${row.frame.id} source head does not resolve`);
      }
      this.frameSeen = true;
      this.frames.set(row.frame.id, { row, ref: ref(event), dispatched: [], responded: [] });
      this.frameOrder.push(row.frame.id);
      this.nodes.set(row.frame.id, { id: row.frame.id, kind: "context_frame", body: {
        mode: row.mode, kind: "contribution", contributor_schema: typeof row.contribution.schema === "string" ? row.contribution.schema : null,
      } });
      return;
    }
    const row = parseRow(frameRowSchema, event.payload, event.name);
    if (this.frames.has(row.frame.id)) throw new ContextGraphSchemaError(`frame ${row.frame.id} recorded twice`);
    if (row.blob !== row.frame.body.digest || row.blob_bytes !== row.frame.body.bytes) {
      throw new ContextGraphSchemaError(`frame ${row.frame.id} body differs from its row`);
    }
    this.frameSeen = true;
    this.frames.set(row.frame.id, { row, ref: ref(event), dispatched: [], responded: [] });
    this.frameOrder.push(row.frame.id);
    this.nodes.set(row.frame.id, { id: row.frame.id, kind: "context_frame", body: { goal: row.frame.goalId, mode: row.mode, kind: row.kind } });
  }

  /** §132 V2: an EvidenceRef is exactly the log's fact for its row. */
  private checkEvidence(item: EvidenceRef, owner: string): void {
    const fact = this.facts.get(item.event.seq);
    const body = fact?.blob !== undefined && fact.blobBytes !== undefined ? { digest: fact.blob, bytes: fact.blobBytes } : null;
    if (!fact || fact.hash !== item.event.hash || fact.authority !== item.authority || fact.availability !== item.availability
      || canonicalJson(body) !== canonicalJson(item.body)) {
      throw new ContextGraphSchemaError(`${owner} cites evidence whose recorded facts differ from the log`);
    }
  }

  private surface(event: EventRecord): void {
    const row = parseRow(surfaceRowSchema, event.payload, event.name);
    const frame = this.frames.get(row.frame_id);
    if (!frame || frame.ref.seq !== row.frame.seq || frame.ref.hash !== row.frame.hash) {
      throw new ContextGraphSchemaError(`surface names an unrecorded frame ${row.frame_id}`);
    }
    if (frame.row.schema !== "legacy-context-contribution" && frame.row.mode !== "on") throw new ContextGraphSchemaError(`shadow frame ${row.frame_id} has a model surface`);
    if (row.blob !== frame.row.blob || row.blob_bytes !== frame.row.blob_bytes) {
      throw new ContextGraphSchemaError(`surface bytes differ from frame ${row.frame_id}`);
    }
    if (!frame.surface) frame.surface = { ref: ref(event), digest: row.blob };
  }

  private presented(event: EventRecord): void {
    const row = parseRow(presentedRowSchema, event.payload, event.name);
    for (const id of row.frames) {
      const frame = this.frames.get(id);
      if (!frame?.surface) throw new ContextGraphSchemaError(`presented names frame ${id} without a surface`);
      if (row.stage === "appended") {
        const state = this.facts.get(row.state.seq);
        if (!state || state.hash !== row.state.hash || state.name !== "provider/state") {
          throw new ContextGraphSchemaError(`frame ${id} appended by a row that is not a transcript state`);
        }
        frame.appended ??= row.state;
      } else (row.stage === "dispatched" ? frame.dispatched : frame.responded).push(row.request);
    }
  }

  /** R8-03: the branch-context rows exist only under their own feature
   * generation as well as the graph's. */
  private requireBranchContext(event: EventRecord): void {
    if (this.branchContextStart === undefined || event.seq <= this.branchContextStart) {
      throw new ContextGraphSchemaError(`${event.name} precedes the ${BRANCH_CONTEXT_FEATURE} feature generation`);
    }
  }

  /** R8-03: one closed branch-context import per session, before any current
   * provider request or frame, bound to this child's own ACTIVE workspace
   * and checkpoint input import authority — validated with the ONE shared
   * authority validator the live writer also uses, so a cold graph can never
   * accept an orphan workspace receipt or a duplicate input readiness the
   * writer would refuse — and whose candidates are RE-DERIVED from the
   * retained source bundle: a copied list that differs from the retained
   * evidence refuses the fold, and a fold with no retained-body reader
   * refuses too. */
  private branchImport(event: EventRecord): void {
    const row = parseRow(branchImportRowSchema, event.payload, event.name);
    this.requireBranchContext(event);
    if (this.importedSession !== undefined) throw new ContextGraphSchemaError("a second branch context import folds");
    if (this.providerRequestSeen || this.frameSeen) {
      throw new ContextGraphSchemaError("a branch context import follows a provider request or context frame");
    }
    if (row.session !== this.sessionId) throw new ContextGraphSchemaError("the branch context import names another session");
    if (this.releasedWorkspaces.has(row.workspace)) {
      throw new ContextGraphSchemaError("the branch context import names an already spent workspace");
    }
    if (this.retained === undefined) {
      throw new ContextGraphSchemaError("context/branch_import requires a retained source body reader");
    }
    if (this.branchSource === undefined) {
      throw new ContextGraphSchemaError("context/branch_import requires the event array it folds");
    }
    let authority: ReturnType<typeof validateBranchContextAuthority>;
    try {
      authority = validateBranchContextAuthority(this.branchSource.slice(0, event.seq),
        { session: row.session, workspace: row.workspace, reader: this.retained });
    } catch (error) {
      throw new ContextGraphSchemaError(`branch context authority differs (${error instanceof Error ? error.message.slice(0, 140) : "unknown"})`);
    }
    if (canonicalJson(authority.importReady.source) !== canonicalJson(row.source)
      || authority.importReady.bundle.blob !== row.source_blob) {
      throw new ContextGraphSchemaError("the branch context import differs from the child's input import");
    }
    const workspaceReady = authority.workspaceReady;
    if (canonicalJson(workspaceReady.source) !== canonicalJson(row.source)
      || workspaceReady.source_blob !== row.source_blob) {
      throw new ContextGraphSchemaError("the branch context import differs from the child's workspace receipt");
    }
    // The import binds the authorized child scope in force: its id and the
    // exact `context/scope` row that recorded it.
    if (row.repository !== this.repositoryId || this.scopeRef === undefined
      || row.repository_ref.seq !== this.scopeRef.seq || row.repository_ref.hash !== this.scopeRef.hash) {
      throw new ContextGraphSchemaError("the branch context import does not bind the scope row in force");
    }
    const text = this.retained(row.source_blob);
    if (text === undefined) throw new ContextGraphSchemaError("the retained branch source body is unavailable");
    if (sha256(text) !== row.source_blob || Buffer.byteLength(text) !== row.source_blob_bytes) {
      throw new ContextGraphSchemaError("the retained branch source body differs from its digest");
    }
    let bundle: unknown;
    try {
      bundle = JSON.parse(text);
    } catch {
      throw new ContextGraphSchemaError("the retained branch source body is not JSON");
    }
    let candidates: ReturnType<typeof deriveImportedCandidates>;
    try {
      candidates = deriveImportedCandidates(bundle);
    } catch (error) {
      throw new ContextGraphSchemaError(`the retained branch source does not authenticate (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
    }
    const bundleSource = (bundle as { source?: unknown }).source;
    if (canonicalJson(bundleSource) !== canonicalJson(row.source)) {
      throw new ContextGraphSchemaError("the branch context import differs from its retained source binding");
    }
    if (canonicalJson(candidates) !== canonicalJson(row.candidates)) {
      throw new ContextGraphSchemaError("the branch context import candidates differ from the retained source");
    }
    if (distinctDeclaredFilePaths(row.candidates).size > MAX_IMPORTED_DECLARED_PATHS) {
      throw new ContextGraphSchemaError(`branch context import declares more than ${MAX_IMPORTED_DECLARED_PATHS} distinct file paths`);
    }
    const ids = new Set(row.candidates.map(candidate => candidate.id));
    if (ids.size !== row.candidates.length) throw new ContextGraphSchemaError("branch context import candidate ids repeat");
    for (const candidate of row.candidates) {
      this.importedLessons.set(candidate.id, { id: candidate.id, candidate, importRef: ref(event), sourceBlob: row.source_blob, repository: row.repository });
      // The node body marks the foreign origin explicitly: a historical
      // model claim with immutable parent references, never a local lesson.
      this.emit({ op: "node", id: candidate.id, kind: "lesson", body: {
        origin: "imported_model_statement",
        source_session: candidate.source.session,
        source_event: candidate.source.event,
        source_lesson: candidate.source.lesson,
        source_revision: candidate.source.revision,
        source_epistemic: candidate.epistemic,
        statement_digest: sha256(candidate.statement),
        scope: candidate.scope,
      } });
      this.emit({ op: "edge", from: `row:${event.seq}`, relation: "cited_by", to: candidate.id, evidence: [ref(event)] });
    }
    this.importedSession = row.session;
    this.branchImportBinding = { session: row.session, workspace: row.workspace, repository: row.repository,
      root: { uid: workspaceReady.root.uid, dev: workspaceReady.root.dev, ino: workspaceReady.root.ino },
      resourceRoot: workspaceReady.resource.root, owner: workspaceReady.resource.owner };
  }

  /** R8-03: a child applicability reassessment, held to the log: the fold
   * re-derives the whole fit from the candidate and the tree, scope and goal
   * recorded at this row, so an altered verdict or a fabricated match
   * refuses here. The FULL readiness authority is re-validated over this
   * row's own prefix — active workspace lifecycle, valid checkpoint input
   * receipts, provider-input fold — exactly as at the import; the suffix
   * after the row never enters, so a later refusal cannot invalidate a
   * historical frame. */
  private branchFit(event: EventRecord): void {
    const row = parseRow(branchFitRowSchema, event.payload, event.name);
    this.requireBranchContext(event);
    const state = this.importedLessons.get(row.lesson);
    if (state === undefined) throw new ContextGraphSchemaError(`branch fit names an unknown imported lesson ${row.lesson}`);
    if (this.branchImportBinding === undefined || this.retained === undefined || this.branchSource === undefined) {
      throw new ContextGraphSchemaError("branch fit folds without its import binding");
    }
    if (this.releasedWorkspaces.has(this.branchImportBinding.workspace)) {
      throw new ContextGraphSchemaError("branch fit names a spent workspace");
    }
    try {
      validateBranchContextAuthority(this.branchSource.slice(0, event.seq),
        { session: this.branchImportBinding.session, workspace: this.branchImportBinding.workspace, reader: this.retained });
    } catch (error) {
      throw new ContextGraphSchemaError(`branch context authority differs (${error instanceof Error ? error.message.slice(0, 140) : "unknown"})`);
    }
    if (row.import.seq !== state.importRef.seq || row.import.hash !== state.importRef.hash) {
      throw new ContextGraphSchemaError(`branch fit for ${row.lesson} does not cite its import row`);
    }
    const goalId = this.currentGoal;
    const derived = computeImportedFit(state.candidate, {
      repositoryId: this.repositoryId,
      importRepository: state.repository,
      goalId: goalId ?? null,
      goalStatementDigest: goalId !== undefined ? this.goalStatements.get(goalId) : undefined,
      tree: this.tree === undefined ? null : { files: this.tree.files },
    });
    const treeRef = this.tree === undefined ? null : this.tree.ref;
    if (row.scope !== this.repositoryId || canonicalJson(row.tree) !== canonicalJson(treeRef)
      || canonicalJson({ goal: row.goal, files: row.files, verdict: row.verdict, reason: row.reason }) !== canonicalJson(derived)) {
      throw new ContextGraphSchemaError(`branch fit for ${row.lesson} differs from its recorded reads`);
    }
    state.fit = { row, ref: ref(event) };
    if (row.verdict === "applicable" && goalId !== undefined) {
      this.emit({ op: "edge", from: row.lesson, relation: "applies_to", to: goalId, evidence: [ref(event)] });
    }
  }

  /** The lesson's current epistemic state, derived — never the model's word. */
  epistemic(id: string, revision?: number): "proposed" | "corroborated" | "contested" | "superseded" {
    const state = this.lessons.get(id);
    if (!state) return "proposed";
    const at = revision ?? state.revisions.length;
    if (at < state.revisions.length || state.supersededBy !== undefined) return "superseded";
    // §133 A1'': only host-minted assessments exist; each is a judged run of
    // the revision's own observable.
    const counted = state.assessments.filter((item) => item.assessment.revision === at);
    const supports = counted.some((item) => item.assessment.stance === "supports");
    const contradicts = counted.some((item) => item.assessment.stance === "contradicts");
    if (contradicts) return "contested";
    return supports ? "corroborated" : "proposed";
  }

  /** Where one frame got to: recorded, surfaced, in the transcript, handed to
   * the send path, answered. `prepared` alone is never "presented". */
  frameStage(id: string): "prepared" | "surfaced" | "appended" | "dispatched" | "responded" | "shadow" | undefined {
    const frame = this.frames.get(id);
    if (!frame) return undefined;
    if (frame.row.mode === "shadow") return "shadow";
    if (frame.responded.length > 0) return "responded";
    if (frame.dispatched.length > 0) return "dispatched";
    if (frame.appended) return "appended";
    if (frame.surface) return "surfaced";
    return "prepared";
  }

  snapshot(): ContextGraphSnapshot {
    const nodes = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((node) => {
      const text = canonicalJson(node.body);
      return { id: node.id, kind: node.kind, body: { digest: sha256(text), bytes: Buffer.byteLength(text) } };
    });
    const edges = [...this.edges.values()].sort((a, b) => {
      const left = `${a.from}\0${a.relation}\0${a.to}`, right = `${b.from}\0${b.relation}\0${b.to}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return { sourceHead: this.headRef, revision: this.revision, digest: this.digest, nodes, edges };
  }
}

/** One selection scope: a repository AND a goal (§130 S1). */
export function scopeKey(repositoryId: string, goalId: string): string {
  return `${repositoryId}\u0000${goalId}`;
}

/** §132 A1': the host-judged observation a row is — a run the HOST judged
 * (`verify/receipt`: the verify step, the plan probe, the final and base
 * passes, the recheck, the finish re-observation) or a ledger row recording
 * such a judgement (check, probe, property, base, final case) — with the case
 * or command it observed and the verdict it showed. A session's own
 * `exec/receipt`, a `tool/end`, a `tool/call`: never judged. */
export interface JudgedFact {
  readonly caseId: string | null;
  readonly commandDigest: string | null;
  readonly verdict: "pass" | "fail" | null;
}
export const JUDGED_ROWS: ReadonlySet<string> = new Set([
  "verify/receipt", "ledger/check", "ledger/case_probe", "ledger/property", "ledger/case_base", "ledger/case",
]);
function judgedFact(event: EventRecord, caseCommands: ReadonlyMap<string, string>): JudgedFact | undefined {
  if (!JUDGED_ROWS.has(event.name)) return undefined;
  const payload = event.payload;
  if (event.name === "verify/receipt") {
    return { caseId: null, commandDigest: typeof payload.command_digest === "string" ? payload.command_digest : null,
      verdict: typeof payload.exit_code === "number" ? (payload.exit_code === 0 ? "pass" : "fail") : null };
  }
  const caseId = typeof payload.case === "string" ? payload.case : typeof payload.id === "string" ? payload.id : null;
  // A case is bound by the command it ran: the row's own, else the command
  // the ledger declared for that id at this point of the log (§133 A1'').
  const command = typeof payload.command === "string" && payload.command !== "" ? payload.command
    : caseId === null ? undefined : caseCommands.get(caseId);
  return { caseId, commandDigest: command === undefined ? null : sha256(command),
    verdict: payload.status === "green" ? "pass" : payload.status === "red" ? "fail" : null };
}

/** §133 A1'': the observable of a lesson revision, derived by the host: the
 * newest judged row that was RED among the rows its attempts' own invocations
 * appended, bound by the command digest that row ran. */
export function observableOf(fold: ContextGraphFold, attemptIds: readonly string[]): { caseId: string | null; commandDigest: string; source: EventRef } | null {
  return observableFromActions(fold, attemptIds.flatMap((id) => fold.attempts.get(id)?.attempt.actionRefs ?? []));
}

/** context-formal-work-v1: the schema-3 observable of a lesson revision —
 * the newest authenticated qualifying RED among its attempts' formal Work
 * executions — or null. */
export function formalObservableOf(fold: ContextGraphFold, attemptIds: readonly string[]): FormalCaseObservable | null {
  return formalObservableFromActions(fold, attemptIds.flatMap((id) => fold.attempts.get(id)?.attempt.actionRefs ?? []));
}

export function formalObservableFromActions(fold: ContextGraphFold, actions: readonly EventRef[]): FormalCaseObservable | null {
  if (fold.formalStart === undefined) return null;
  return formalObservableFrom(fold.formalExecutions, fold.formalVerdicts, actions);
}

export function observableFromActions(fold: ContextGraphFold, actions: readonly EventRef[]): { caseId: string | null; commandDigest: string; source: EventRef } | null {
  let best: { seq: number; fact: JudgedFact; ref: EventRef } | undefined;
  for (const action of actions) {
    const key = fold.byCallSeq.get(action.seq);
    const invocation = key === undefined ? undefined : fold.invocations.get(key);
    for (const row of invocation?.rows ?? []) {
      const fact = fold.judged.get(row.seq);
      if (fact?.verdict !== "fail" || fact.commandDigest === null) continue;
      if (!best || row.seq > best.seq) best = { seq: row.seq, fact, ref: row };
    }
  }
  return best ? { caseId: best.fact.caseId, commandDigest: best.fact.commandDigest!, source: { seq: best.ref.seq, hash: best.ref.hash } } : null;
}

/** §133 A1'': the assessments the host owes — for each lesson's latest
 * revision with an observable, every later judged run of exactly that
 * command digest not yet assessed, in log order. */
export function assessmentsDue(fold: ContextGraphFold): Array<{ lesson: string; revision: number; judged: EventRef; observed: "pass" | "fail" }> {
  const out: Array<{ lesson: string; revision: number; judged: EventRef; observed: "pass" | "fail" }> = [];
  for (const id of fold.lessonOrder) {
    const state = fold.lessons.get(id)!;
    const latest = state.revisions.at(-1)!;
    const observable = latest.lesson.observable;
    if (observable === null) continue;
    if ("kind" in observable) {
      const source = fold.formalVerdicts.get(observable.source.seq);
      for (const seq of source === undefined ? [] : fold.formalJudged.get(obligationOf(source)) ?? []) {
        if (fold.assessed.has(`${id}#${latest.lesson.revision}@${seq}`)) continue;
        const observed = formalAssessmentOf(fold.formalExecutions, latest, fold.formalVerdicts.get(seq)!);
        if (observed !== undefined) out.push({ lesson: id, revision: latest.lesson.revision, judged: fold.formalVerdicts.get(seq)!.ref, observed });
      }
      continue;
    }
    for (const seq of fold.judgedByDigest.get(observable.commandDigest) ?? []) {
      if (seq <= latest.ref.seq || fold.assessed.has(`${id}#${latest.lesson.revision}@${seq}`)) continue;
      const fact = fold.facts.get(seq)!;
      out.push({ lesson: id, revision: latest.lesson.revision, judged: { seq, hash: fact.hash }, observed: fold.judged.get(seq)!.verdict! });
    }
  }
  return out.sort((a, b) => a.judged.seq - b.judged.seq);
}

/** #221/§133 P3: the path key a declared file is read under. */
export function filePathDigest(path: string): string {
  return sha256(path.replace(/^\.\//u, "")).slice(0, 16);
}

/** The versions a lesson's declared files had when it was recorded: the
 * content digest the host read of each from the tree (a `context/tree` row
 * just before the lesson), else unknown. */
export function fileResources(fold: ContextGraphFold, declared: readonly string[], fallback: EvidenceRef): ResourceVersion[] {
  return declared.map((path): ResourceVersion => {
    const digest = fold.tree?.files.get(path.replace(/^\.\//u, ""));
    const fact = fold.tree ? fold.facts.get(fold.tree.ref.seq) : undefined;
    if (!fold.tree || !fact || digest === undefined || digest === null) return { resourceId: path, kind: "file", digest: null, evidence: fallback, coverage: "unknown" };
    return { resourceId: path, kind: "file", digest, coverage: "exact",
      evidence: { event: fold.tree.ref, body: null, availability: fact.availability, authority: fact.authority } };
  });
}

/** The workspace versions cited evidence was observed under (receipts only —
 * read receipts are #221's and will add file versions): the host derives
 * them, and the fold re-derives them to hold a lesson row to them. */
export function workspaceVersions(fold: ContextGraphFold, evidence: readonly EvidenceRef[]): ResourceVersion[] {
  const out: ResourceVersion[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const direct = fold.receipts.get(item.event.seq);
    const key = direct ? undefined : fold.invocationBySeq.get(item.event.seq);
    const receipts = direct ? [direct] : key === undefined ? [] : fold.invocations.get(key)!.receipts;
    const receipt = receipts.find((candidate) => candidate.live) ?? receipts[0];
    if (!receipt || receipt.image === "" || seen.has(receipt.image)) continue;
    seen.add(receipt.image);
    out.push({ resourceId: "workspace", kind: "workspace", digest: receipt.image, evidence: item, coverage: receipt.unknown ? "partial" : "exact" });
  }
  return out.slice(-4);
}

export function implicitAttemptId(goalId: string): string {
  return `attempt:implicit:${goalId}`;
}

export function lessonNodeId(id: string, revision: number): string {
  return `${id}#r${revision}`;
}

function evidenceNode(fold: ContextGraphFold, event: EventRef): string {
  const key = fold.byCallSeq.get(event.seq);
  if (key !== undefined) return key;
  // context-formal-work-v1 only: these maps are empty in earlier generations.
  if (fold.formalExecutions.has(event.seq)) return `wx:${event.seq}`;
  if (fold.formalVerdicts.has(event.seq)) return `obs:wx:${event.seq}`;
  const fact = fold.facts.get(event.seq);
  return fact?.name === "tool/end" ? `obs:${event.seq}` : `row:${event.seq}`;
}

/** The graph at exactly the durable prefix `events` (TS-28 §9 sync). A fold
 * that meets branch-context rows needs `retained`, the reader of the
 * retained source bundles; without it those rows refuse the fold. */
export function projectContextGraph(events: readonly EventRecord[], retained?: RetainedBranchBodyReader): ContextGraphFold {
  const fold = new ContextGraphFold(retained);
  fold.extend(events);
  return fold;
}

/** The complete current goal statement at an exact source boundary, using
 * the same fold that scopes lessons. Ordinary follow-up messages cannot
 * replace an implicit goal; restatements update their own goal, including
 * empty strings. A new goal with no known statement remains unknown. */
export function contextGoalStatementAt(events: readonly EventRecord[], sourceHead: EventRef, retained?: RetainedBranchBodyReader): string | undefined {
  const row = events[sourceHead.seq - 1];
  if (!row || row.seq !== sourceHead.seq || row.hash !== sourceHead.hash) {
    throw new ContextGraphSchemaError("source head is not a row of this log");
  }
  const fold = projectContextGraph(events.slice(0, sourceHead.seq), retained);
  const statementRef = fold.currentGoal === undefined ? undefined : fold.goalStatementRefs.get(fold.currentGoal);
  if (statementRef === undefined) return undefined;
  const source = events[statementRef.seq - 1];
  if (!source || source.hash !== statementRef.hash) {
    throw new ContextGraphSchemaError("goal statement source is not a row of this log");
  }
  return typeof source.payload.statement === "string" ? source.payload.statement
    : typeof source.payload.text === "string" ? source.payload.text : undefined;
}

/** sync(sourceHead): the graph of the prefix ending at `sourceHead`, which
 * must name a row of `events` exactly. */
export function syncContextGraph(events: readonly EventRecord[], sourceHead: EventRef, retained?: RetainedBranchBodyReader): ContextGraphSnapshot {
  const row = events[sourceHead.seq - 1];
  if (!row || row.seq !== sourceHead.seq || row.hash !== sourceHead.hash) {
    throw new ContextGraphSchemaError("source head is not a row of this log");
  }
  return projectContextGraph(events.slice(0, sourceHead.seq), retained).snapshot();
}

/** Diagnostic only: how many rows the live projections have folded. */
export interface ContextGraphFoldWork { rowsFolded: number; refolds: number }
const live = new WeakMap<EventLog, ContextGraphFold>();
const works = new WeakMap<EventLog, ContextGraphFoldWork>();

export function contextGraphFoldWork(log: EventLog): Readonly<ContextGraphFoldWork> {
  return { ...(works.get(log) ?? { rowsFolded: 0, refolds: 0 }) };
}

/** The live projection of one writer's log, extended to its last row. A
 * refusal discards the fold, so the next call re-derives it and refuses the
 * same way. The fold reads retained branch source bundles from the session's
 * own BlobStore: a body that is gone fails hard — missing retained import
 * evidence blocks branch-context preparation rather than degrading it. */
export function liveContextGraph(log: EventLog): ContextGraphFold {
  const events = log.events;
  let work = works.get(log);
  if (!work) works.set(log, work = { rowsFolded: 0, refolds: 0 });
  let fold = live.get(log);
  if (fold) {
    const extendsPrefix = fold.consumed <= events.length && (fold.consumed === 0 || events[fold.consumed - 1]?.hash === fold.head);
    if (!extendsPrefix) {
      fold = undefined;
      work.refolds += 1;
    }
  }
  fold ??= new ContextGraphFold(retainedStoreReader(log));
  live.delete(log);
  const from = fold.consumed;
  fold.extend(events);
  work.rowsFolded += fold.consumed - from;
  live.set(log, fold);
  return fold;
}

/** The store-backed retained reader of one live log (built lazily: sessions
 * without branch-context rows never touch the store). */
function retainedStoreReader(log: EventLog): RetainedBranchBodyReader {
  return digest => {
    const store = BlobStore.forSession(log.path);
    if (!store.has(digest)) {
      throw new BranchContextError("retained branch source body is missing; branch preparation is blocked");
    }
    return store.get(digest);
  };
}
