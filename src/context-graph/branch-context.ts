import { createHash } from "node:crypto";
import { z } from "zod";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import {
  activeBranchWorkspaceReady,
  BranchWorkspaceService,
  verifyBranchWorkspaceLiveResource,
  verifyRetainedBranchWorkspace,
  type BranchWorkspaceReady,
} from "../host/branch-workspace.ts";
import {
  CHECKPOINT_IMPORT_REASON,
  checkpointImportReceiptSchemas,
  checkpointImportSourceBodyRows,
  PROVIDER_BODY_EVENTS,
  projectProviderInputs,
  validateImportedCheckpointSource,
} from "../host/provider-input.ts";
import { projectCheckpointInputImportReferences } from "../host/checkpoint-input-import-replay.ts";
import { projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";
import { assertNoSecrets } from "../host/redact.ts";
import { repositoryScopeOf } from "./scope.ts";
import { projectContextGraph } from "./projector.ts";
import {
  BRANCH_CONTEXT_FEATURE,
  CONTEXT_GRAPH_SCHEMA,
  CONTEXT_LESSON_ROW,
  evidenceRefSchema,
  FORMAL_WORK_FEATURE,
  formalCaseObservableSchema,
  parseRow,
  resourceVersionSchema,
  type EventRef,
} from "./types.ts";

/**
 * R8-03 branch context (docs/desktop-branches-r8.md): authenticated parent
 * lessons retained as HISTORICAL candidates, reassessed against a newly owned
 * child scope, and admitted into new recorded model input only under a
 * recorded applicability decision.
 *
 * Three parties share this module so they can never diverge: the host-only
 * import writer (`importCheckpointLessons`), the ContextGraph fold (which
 * re-derives every imported candidate from the retained source bundle and
 * re-derives every fit row from the recorded reads), and the service's
 * prepare/query boundary reassessment. An imported candidate is a model
 * claim made in a foreign session — its proposed/corroborated label stays a
 * historical source fact, its evidence stays a foreign reference, and no
 * local action, lesson or assessment is ever minted from it.
 *
 * The retained source bundle is never duplicated into an event payload: one
 * closed `context/branch_import` row carries bounded deterministic candidate
 * identities and roots the bundle by `source_blob`, the ordinary retention
 * root GC, pack and preservation already collect. The row also binds the
 * child's authorized repository scope at import time, so a later root/inode
 * replacement at the same path — even with byte-identical files — can never
 * regain eligibility by path alone.
 */

export const CONTEXT_BRANCH_IMPORT_ROW = "context/branch_import";
export const CONTEXT_BRANCH_FIT_ROW = "context/branch_fit";
/** Deterministic latest source lesson candidates per import, bounded. */
export const MAX_IMPORTED_CANDIDATES = 64;
/** R8-03 hardening: the TOTAL distinct declared file paths an import may
 * carry. `context/tree` reads at most 64 paths and merges older readings, so
 * a wider fanout could never be compared honestly — the whole import
 * refuses instead of trusting partial cached readings. */
export const MAX_IMPORTED_DECLARED_PATHS = 64;

const HEX64 = /^[a-f0-9]{64}$/u;
const SESSION_MAX = 256;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const IMPORTED_ID = /^imported-[a-f0-9]{24}$/u;

export class BranchContextError extends Error {
  readonly code = "branch_context";
  constructor(reason: string) {
    super(`branch-context: ${reason}`);
    this.name = "BranchContextError";
  }
}

function refuse(reason: string): never {
  throw new BranchContextError(reason);
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

// ---------------------------------------------------------------------------
// Closed row contracts, shared by the writer and the fold.
// ---------------------------------------------------------------------------

const eventRefSchema = z.strictObject({ seq: z.number().int().positive(), hash: z.string().regex(HEX64) });
const sourceRefSchema = z.strictObject({
  session: z.string().min(1).max(SESSION_MAX),
  checkpoint: z.string().regex(BRANCH_ID),
  digest: z.string().regex(HEX64),
  head: eventRefSchema,
});

/** One historical lesson candidate, derived — never caller-authored. The
 * evidence and resources are the SOURCE graph's own recorded values; the
 * epistemic label is the source history's, quoted, never reassessed here.
 * `source_goal_statement_digest` is the statement the source goal carried AT
 * the lesson revision (a later reuse of the source goal id cannot relabel
 * it), and `source_repository_current` says whether the lesson's repository
 * was still the source graph's current scope at the captured boundary.
 *
 * A schema-3 source lesson keeps its observation provenance and its
 * discriminated `formal_case` observable exactly as the source fold derived
 * them — the foreign verdict, execution start, command, obligation and case
 * digests — as a historical fact; nothing local is minted from it. */
export const importedCandidateSchema = z.strictObject({
  id: z.string().regex(IMPORTED_ID),
  source: z.strictObject({
    session: z.string().min(1).max(SESSION_MAX),
    event: eventRefSchema,
    lesson: z.string().regex(/^lesson-[0-9]+$/u),
    revision: z.number().int().positive(),
  }),
  statement: z.string().min(1).max(2000),
  epistemic: z.enum(["proposed", "corroborated", "contested", "superseded"]),
  source_repository_current: z.boolean(),
  /** Schema-2/3 source observation provenance; excluded from declared fit conditions. */
  observation_resources: z.array(resourceVersionSchema).max(4).optional(),
  evidence: z.array(evidenceRefSchema).min(1).max(16),
  scope: z.strictObject({
    repository: z.string().min(1).max(200),
    goal: z.string().max(64).nullable(),
    goal_statement_digest: z.string().regex(HEX64).nullable(),
    resources: z.array(resourceVersionSchema).max(32),
    dependency_coverage: z.enum(["declared", "incomplete"]),
    condition_text: z.string().max(1200),
  }),
  retry_conditions: z.array(z.string().max(400)).max(8),
  invalidation_conditions: z.array(z.string().max(400)).max(8),
  observable: z.union([
    z.strictObject({
      caseId: z.string().min(1).max(128).nullable(),
      commandDigest: z.string().regex(HEX64),
      source: eventRefSchema,
    }),
    formalCaseObservableSchema,
  ]).nullable(),
  supersedes: z.strictObject({ lesson: z.string().regex(/^lesson-[0-9]+$/u), revision: z.number().int().positive() }).nullable(),
  superseded_by: z.strictObject({ lesson: z.string().regex(/^lesson-[0-9]+$/u), revision: z.number().int().positive() }).nullable(),
}).superRefine((candidate, ctx) => {
  if (candidate.observable !== null && "kind" in candidate.observable && candidate.observation_resources === undefined) {
    ctx.addIssue({ code: "custom", message: "a formal-case observable belongs to a schema-3 candidate with its observation provenance" });
  }
});
export type ImportedLessonCandidate = z.infer<typeof importedCandidateSchema>;

export const branchImportRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  session: z.string().min(1).max(SESSION_MAX),
  workspace: z.string().regex(BRANCH_ID),
  source: sourceRefSchema,
  /** The retained source evidence bundle — the ordinary retention root. */
  source_blob: z.string().regex(HEX64),
  source_blob_bytes: z.number().int().positive(),
  /** The child's authorized repository scope at import time, and the
   * `context/scope` row that recorded it. A later replacement scope never
   * re-binds by path. */
  repository: z.string().min(1).max(200),
  repository_ref: eventRefSchema,
  candidates: z.array(importedCandidateSchema).max(MAX_IMPORTED_CANDIDATES),
});
export type BranchImportRow = z.infer<typeof branchImportRowSchema>;

export const IMPORTED_FIT_VERDICTS = ["applicable", "changed", "unknown", "ineligible"] as const;
export type ImportedFitVerdict = (typeof IMPORTED_FIT_VERDICTS)[number];

export const branchFitRowSchema = z.strictObject({
  schema: z.literal(CONTEXT_GRAPH_SCHEMA),
  lesson: z.string().regex(IMPORTED_ID),
  import: eventRefSchema,
  /** The tree reading the comparison was made under (null: none was read). */
  tree: eventRefSchema.nullable(),
  scope: z.string().min(1).max(200),
  goal: z.strictObject({
    id: z.string().max(64).nullable(),
    statement_match: z.enum(["equal", "different", "unknown"]),
  }),
  files: z.array(z.strictObject({
    path: z.string().min(1).max(300),
    kind: z.enum(resourceVersionSchema.shape.kind.options),
    declared: z.string().regex(HEX64).nullable(),
    read: z.string().regex(HEX64).nullable(),
    verdict: z.enum(["matched", "changed", "unknown"]),
  })).max(32),
  verdict: z.enum(IMPORTED_FIT_VERDICTS),
  reason: z.string().max(240),
});
export type BranchFitRow = z.infer<typeof branchFitRowSchema>;

/** The fold state of one imported candidate. */
export interface ImportedLessonState {
  readonly id: string;
  readonly candidate: ImportedLessonCandidate;
  readonly importRef: EventRef;
  readonly sourceBlob: string;
  /** The child repository scope the import bound; a replaced scope makes the
   * candidate ineligible, never re-bound by path. */
  readonly repository: string;
  /** The latest recorded fit row, as recorded, and its ref. */
  fit?: { readonly row: BranchFitRow; readonly ref: EventRef };
}

// ---------------------------------------------------------------------------
// Candidate derivation, shared by the writer and the fold.
// ---------------------------------------------------------------------------

interface GoalStatementRow {
  readonly seq: number;
  readonly goalId: string;
  readonly digest: string;
}

/** The goal statements of a source chain, in row order: every goal-opening
 * row updates its goal's statement, so the statement a goal carried at any
 * row is the NEWEST statement at or before it — a goal id reused after a
 * lesson cannot relabel the lesson. Mirrors the fold's goal-id derivation
 * (`goal:<scope_seq>` for work/goal, `goal:<seq>` for an implicit open). */
function goalStatementTimeline(events: readonly EventRecord[]): GoalStatementRow[] {
  const out: GoalStatementRow[] = [];
  for (const row of events) {
    if (row.name === "work/goal" && typeof row.payload.statement === "string") {
      const scopeSeq = typeof row.payload.scope_seq === "number" && Number.isSafeInteger(row.payload.scope_seq)
        && row.payload.scope_seq > 0 && row.payload.scope_seq <= row.seq ? row.payload.scope_seq : row.seq;
      out.push({ seq: row.seq, goalId: `goal:${scopeSeq}`, digest: sha256(row.payload.statement) });
    } else if (row.name === "user/message" && typeof row.payload.text === "string") {
      out.push({ seq: row.seq, goalId: `goal:${row.seq}`, digest: sha256(row.payload.text) });
    }
  }
  return out;
}

function goalStatementAt(timeline: readonly GoalStatementRow[], goalId: string, atSeq: number): string | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index]!;
    if (entry.seq <= atSeq && entry.goalId === goalId) return entry.digest;
  }
  return null;
}

function bundleEventsAtHead(bundle: unknown, headSeq: number): readonly EventRecord[] {
  const events = (bundle as { events?: unknown }).events;
  if (!Array.isArray(events)) refuse("source bundle carries no event chain");
  return events.slice(0, headSeq) as readonly EventRecord[];
}

/** The source fold's retained-body reader over an AUTHENTICATED bundle: the
 * exact original text of the formal execution bodies the shared selection
 * names within the captured head, re-hashed at every read. Nothing else —
 * no parent filesystem, no future row, no arbitrary carried body. */
function bundleFormalReader(bundle: unknown, headSeq: number): RetainedBranchBodyReader {
  const carried = new Map<string, string>();
  for (const entry of (bundle as { bodies: Array<{ digest: string; text: string }> }).bodies) carried.set(entry.digest, entry.text);
  const formal = new Map<string, string>();
  for (const { row, formal: isFormal } of checkpointImportSourceBodyRows((bundle as { events: EventRecord[] }).events, headSeq)) {
    const digest = row.payload.blob as string;
    const text = carried.get(digest);
    if (isFormal && text !== undefined) formal.set(digest, text);
  }
  return (digest) => {
    const text = formal.get(digest);
    return text !== undefined && sha256(text) === digest ? text : undefined;
  };
}

/**
 * Derive the bounded latest lesson candidates of an authenticated source
 * bundle: the source ContextGraph fold at the checkpoint's captured boundary
 * (the source head — parent future is excluded), latest revision per lesson,
 * with the source's own historical epistemic state, the goal statement each
 * lesson was scoped under at its revision, and whether its repository was
 * still the source's current scope at the boundary. Deterministic in the
 * retained evidence alone, so the writer and every cold fold re-derive the
 * same list.
 */
export function deriveImportedCandidates(bundle: unknown): ImportedLessonCandidate[] {
  const facts = validateImportedCheckpointSource(bundle);
  const events = bundleEventsAtHead(bundle, facts.head.seq);
  const sourceFold = projectContextGraph(events, bundleFormalReader(bundle, facts.head.seq));
  const timeline = goalStatementTimeline(events);
  const headRepository = sourceFold.repositoryId;
  const out: ImportedLessonCandidate[] = [];
  for (const id of sourceFold.lessonOrder.slice(0, MAX_IMPORTED_CANDIDATES)) {
    const state = sourceFold.lessons.get(id)!;
    const { lesson, ref } = state.revisions.at(-1)!;
    // A schema-3 revision exists only under the source's sealed
    // context-formal-work-v1 generation, with its host-derived observable.
    if (lesson.schema === 3 && (sourceFold.formalStart === undefined || ref.seq <= sourceFold.formalStart
      || lesson.observable === null || !("kind" in lesson.observable))) {
      refuse(`source lesson ${id} is schema 3 outside the source's context-formal-work-v1 generation`);
    }
    const goalStatement = lesson.scope.goalId !== null ? goalStatementAt(timeline, lesson.scope.goalId, ref.seq) : null;
    out.push({
      id: `imported-${sha256(canonicalJson([facts.sourceSession, ref.seq, ref.hash, id, lesson.revision])).slice(0, 24)}`,
      source: { session: facts.sourceSession, event: { seq: ref.seq, hash: ref.hash }, lesson: id, revision: lesson.revision },
      statement: lesson.statement,
      epistemic: sourceFold.epistemic(id),
      source_repository_current: lesson.scope.repositoryId === headRepository,
      ...(lesson.schema !== 1 ? { observation_resources: lesson.observationResources! } : {}),
      evidence: lesson.evidence,
      scope: {
        repository: lesson.scope.repositoryId,
        goal: lesson.scope.goalId,
        goal_statement_digest: goalStatement,
        resources: lesson.scope.resources,
        dependency_coverage: lesson.scope.dependencyCoverage,
        condition_text: lesson.scope.conditionText,
      },
      retry_conditions: lesson.retryConditions,
      invalidation_conditions: lesson.invalidationConditions,
      observable: lesson.observable,
      supersedes: lesson.supersedes,
      superseded_by: state.supersededBy === undefined
        ? null
        : { lesson: state.supersededBy.lesson, revision: state.supersededBy.revision },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Child applicability, shared by the service writer and the fold.
// ---------------------------------------------------------------------------

export interface ImportedFitCurrent {
  /** The child's CURRENT repository scope (its root/inode identity). */
  readonly repositoryId: string;
  /** The repository scope the import bound. */
  readonly importRepository: string;
  /** The child's current goal, and the digest of its host-recorded statement. */
  readonly goalId: string | null;
  readonly goalStatementDigest: string | undefined;
  /** The child's latest tree reading (null: nothing was read). */
  readonly tree: { readonly files: ReadonlyMap<string, string | null> } | null;
}

export type ImportedFitValue = Pick<BranchFitRow, "goal" | "files" | "verdict" | "reason">;

/**
 * Reassess one historical candidate against the child's current scope: host
 * facts only. Imported candidates are historical model claims, so nothing
 * here corroborates or contradicts the claim itself — it only decides whether
 * the conditions the candidate DECLARED hold now. A null or unreadable
 * declared version, an unsupported resource kind, an incomplete declared
 * scope or an unknown goal statement are `unknown`, never a synthetic match
 * or change; a goal-scoped candidate needs the exact current operator goal
 * statement (an equal goal id alone is insufficient); a candidate recorded
 * under an earlier source repository, or a child scope replaced after the
 * import, is `ineligible` — inspectable history, never applicable input.
 */
export function computeImportedFit(candidate: ImportedLessonCandidate, current: ImportedFitCurrent): ImportedFitValue {
  const goalScoped = candidate.scope.goal !== null;
  const statementMatch: "equal" | "different" | "unknown" = !goalScoped
    ? "unknown"
    : candidate.scope.goal_statement_digest === null || current.goalId === null || current.goalStatementDigest === undefined
      ? "unknown"
      : current.goalStatementDigest === candidate.scope.goal_statement_digest ? "equal" : "different";
  const files = candidate.scope.resources.map((resource) => {
    if (resource.kind !== "file") {
      return { path: resource.resourceId, kind: resource.kind, declared: resource.digest, read: null, verdict: "unknown" as const };
    }
    const path = resource.resourceId.replace(/^\.\//u, "");
    const read = current.tree?.files.get(path);
    const verdict = resource.digest === null || read === null || read === undefined
      ? "unknown" as const
      : read === resource.digest ? "matched" as const : "changed" as const;
    return { path, kind: resource.kind, declared: resource.digest, read: read ?? null, verdict };
  });
  const goal: BranchFitRow["goal"] = { id: current.goalId, statement_match: statementMatch };
  if (candidate.epistemic === "contested" || candidate.epistemic === "superseded" || candidate.superseded_by !== null) {
    return { goal, files, verdict: "ineligible", reason: "the source history is contested or superseded; inspectable but never applicable" };
  }
  if (!candidate.source_repository_current) {
    return { goal, files, verdict: "ineligible", reason: "the lesson was recorded under an earlier source repository scope; retained as history" };
  }
  if (current.repositoryId !== current.importRepository) {
    return { goal, files, verdict: "ineligible", reason: "the child root scope was replaced after the import; no path-only rebinding" };
  }
  if (statementMatch === "different") {
    return { goal, files, verdict: "ineligible", reason: "the current operator goal statement differs from the source goal; an equal goal id is insufficient" };
  }
  if (files.some((file) => file.verdict === "changed")) {
    return { goal, files, verdict: "changed", reason: "a declared resource reads differently in the child tree now" };
  }
  const matched = files.filter((file) => file.verdict === "matched").length;
  if (candidate.scope.dependency_coverage === "declared" && files.length > 0 && matched === files.length
    && (!goalScoped || statementMatch === "equal")) {
    return { goal, files, verdict: "applicable", reason: "every declared resource reads as its declared version in the child tree now" };
  }
  const reason = files.length === 0
    ? "no declared resource could be compared with the child tree"
    : candidate.scope.dependency_coverage === "incomplete"
      ? "declared resources unchanged, but the declared scope is incomplete"
      : goalScoped && statementMatch === "unknown"
        ? "the current operator goal statement is unknown or unrecorded"
        : "a declared resource has no comparable child reading";
  return { goal, files, verdict: "unknown", reason };
}

/** The complete fit row payload the writer appends (the fold re-derives and
 * compares exactly this). */
export function importedFitPayload(input: {
  readonly candidate: ImportedLessonCandidate;
  readonly importRef: EventRef;
  readonly tree: EventRef | null;
  readonly repositoryId: string;
  readonly fit: ImportedFitValue;
}): BranchFitRow {
  return parseRow(branchFitRowSchema, {
    schema: CONTEXT_GRAPH_SCHEMA,
    lesson: input.candidate.id,
    import: input.importRef,
    tree: input.tree,
    scope: input.repositoryId,
    goal: input.fit.goal,
    files: input.fit.files,
    verdict: input.fit.verdict,
    reason: input.fit.reason,
  }, CONTEXT_BRANCH_FIT_ROW);
}

// ---------------------------------------------------------------------------
// Retained-body readers.
// ---------------------------------------------------------------------------

/** Where a pure fold reads a retained branch source body: the text of the
 * blob, or undefined when the reader's source does not hold it (the fold
 * then refuses the row, fail-closed). A reader may instead throw a hard
 * error (the live reader below) — missing retained import evidence blocks
 * branch preparation rather than degrading it. */
export type RetainedBranchBodyReader = (digest: string) => string | undefined;

/** The live/owner-side reader: the session's own BlobStore, failing hard on
 * a missing or unreadable body. */
export function sessionRetainedReader(path: string, suppliedStore?: BlobStore): RetainedBranchBodyReader {
  const store = suppliedStore ?? BlobStore.forSession(path);
  return (digest) => {
    if (!store.has(digest)) throw new BranchContextError("retained branch source body is missing; branch preparation is blocked");
    try {
      return store.get(digest);
    } catch (error) {
      throw new BranchContextError(`retained branch source body is unreadable (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
    }
  };
}

/** The replay-side reader over a supplied EvidenceBodies map. */
export function retainedReaderOfBodies(bodies: ReadonlyMap<string, unknown>): RetainedBranchBodyReader {
  return (digest) => {
    const value = bodies.get(digest);
    if (value === undefined) return undefined;
    return canonicalJson(value);
  };
}

// ---------------------------------------------------------------------------
// The host-only import writer.
// ---------------------------------------------------------------------------

export interface BranchContextImportRequest {
  readonly sessionId: string;
  /** The owner-supplied actual workspace service that owns the child root. */
  readonly workspace: BranchWorkspaceService;
  readonly workspaceId: string;
}

export interface BranchContextImportResult {
  readonly ids: string[];
}

interface ContextServiceLike {
  readonly log: import("../host/event-log.ts").EventLog;
  readonly workspaceRoot: string | undefined;
}

function lastRowOf(events: readonly EventRecord[], name: string): EventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.name === name) return events[index]!;
  }
  return undefined;
}

function governingSessionOf(events: readonly EventRecord[]): string | undefined {
  let session: string | undefined;
  for (const row of events) {
    if (row.name !== "session/open") continue;
    const id = row.payload.session_id ?? row.payload.id;
    if (typeof id === "string") session = id;
  }
  return session;
}

/**
 * Import the retained source graph's latest lesson candidates into the child
 * session as historical, namespaced candidates. Every precondition is checked
 * before any write: the actual workspace resource must read through its own
 * service (the host-only BranchWorkspaceService, not a lookalike) and match
 * the child's recorded workspace-ready receipt — session, workspace path,
 * resource root and owner digest — and the context service root; the child's
 * checkpoint input import must name the same original bundle/checkpoint; the
 * authorized child repository scope in force must match the root's actual
 * device/inode identity; and no current provider request or context frame may
 * exist yet. A confirmed import is re-verified end to end on retry — the
 * durable row, its bindings and its retained bundle, through the fold itself —
 * and appends nothing.
 */
export function importCheckpointLessons(service: ContextServiceLike, request: unknown): BranchContextImportResult {
  if (!request || typeof request !== "object") refuse("import request is missing");
  const options = request as Partial<BranchContextImportRequest>;
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0 || options.sessionId.length > SESSION_MAX) {
    refuse("import session is invalid");
  }
  if (typeof options.workspaceId !== "string" || !BRANCH_ID.test(options.workspaceId)) {
    refuse("import workspace identifier is invalid");
  }
  if (!(options.workspace instanceof BranchWorkspaceService)) {
    refuse("import workspace service is not the host-only branch workspace service");
  }
  const log = service.log;
  if (log.isReadOnly) refuse("a read-only session imports no branch context");
  log.refresh();
  const session = governingSessionOf(log.events);
  if (session === undefined || session !== options.sessionId) {
    refuse("the session id differs from the log's governing session");
  }
  if (projectSessionReplaySchemas(log.events).featureStart.get(BRANCH_CONTEXT_FEATURE) === undefined) {
    refuse(`the session does not declare the ${BRANCH_CONTEXT_FEATURE} feature generation`);
  }
  const store = BlobStore.forSession(log.path);

  // The actual workspace resource, verified by its own service: ownership,
  // retained evidence and live containment were re-checked there.
  const descriptor = options.workspace.read(options.workspaceId);
  if (descriptor.session !== options.sessionId) {
    refuse("the branch workspace resource belongs to another session");
  }

  // The child's recorded workspace-ready outcome and checkpoint input
  // import, through the ONE shared authority validator the live fold and
  // every cold projection also use — an orphan or duplicate receipt, a
  // failed/released/closed workspace, or a prefix the provider-input fold
  // refuses is the same refusal everywhere. The retained images are then
  // verified with the workspace host's own cold-evidence check.
  const authority = validateBranchContextAuthority(log.events,
    { session: options.sessionId, workspace: options.workspaceId, reader: sessionRetainedReader(log.path) });
  const workspaceReady = authority.workspaceReady;
  if (workspaceReady.id !== options.workspaceId || workspaceReady.session !== options.sessionId
    || workspaceReady.workspace !== descriptor.workspace
    || workspaceReady.resource.root !== descriptor.resource.root || workspaceReady.resource.owner !== descriptor.resource.owner) {
    refuse("the workspace-ready receipt differs from the actual resource");
  }
  if (service.workspaceRoot === undefined || workspaceReady.workspace !== service.workspaceRoot) {
    refuse("the context service root differs from the branch workspace root");
  }
  verifyRetainedBranchWorkspace(log.events, store, workspaceReady, authority.workspaceRow.seq);
  const importReady = authority.importReady;
  if (importReady.session !== options.sessionId) refuse("the input import receipt belongs to another session");
  if (!sameJson(importReady.source, workspaceReady.source) || importReady.bundle.blob !== workspaceReady.source_blob) {
    refuse("the input import and the workspace do not name the same original bundle and checkpoint");
  }

  // A confirmed import answers from durable evidence before any first-import
  // freshness rule: an exact retry after the session has moved on is
  // read-only, re-verifies the row and its retained bundle through the fold,
  // and appends nothing.
  const existing = lastRowOf(log.events, CONTEXT_BRANCH_IMPORT_ROW);
  if (existing !== undefined) {
    if (existing.payload.session !== options.sessionId || existing.payload.workspace !== options.workspaceId) {
      refuse("an existing branch context import conflicts with this request");
    }
    const fold = projectContextGraph(log.events, sessionRetainedReader(log.path));
    const ids = [...fold.importedLessons.keys()];
    const recorded = parseRow(branchImportRowSchema, existing.payload, CONTEXT_BRANCH_IMPORT_ROW);
    if (ids.length !== recorded.candidates.length) refuse("the recorded branch context import does not fold to its candidates");
    return { ids };
  }

  // First import only: before any current provider request or frame.
  if (lastRowOf(log.events, "provider/request") !== undefined || lastRowOf(log.events, "context/frame") !== undefined) {
    refuse("a provider request or context frame already exists; the import belongs before any current model input");
  }

  // The authorized child scope in force must be the root's actual identity.
  const scope = repositoryScopeOf(log, service.workspaceRoot);
  const scopeRef = lastRowOf(log.events, "context/scope");
  if (scope === undefined) refuse("the branch workspace root cannot be identified");
  if (scopeRef === undefined || scopeRef.payload.repository_id !== scope.id) {
    refuse("the recorded repository scope differs from the branch workspace root identity");
  }
  const repositoryRef: EventRef = { seq: scopeRef.seq, hash: scopeRef.hash };

  // Fresh import: derive the candidates from the retained bundle only.
  if (!store.has(importReady.bundle.blob)) refuse("the retained source bundle is missing");
  const bundleText = store.get(importReady.bundle.blob);
  if (sha256(bundleText) !== importReady.bundle.blob) refuse("the retained source bundle digest differs");
  let bundle: unknown;
  try {
    bundle = JSON.parse(bundleText);
  } catch {
    return refuse("the retained source bundle is not JSON");
  }
  let candidates: ImportedLessonCandidate[];
  try {
    candidates = deriveImportedCandidates(bundle);
  } catch (error) {
    return refuse(`the retained source bundle does not authenticate (${error instanceof Error ? error.message.slice(0, 160) : "unknown"})`);
  }
  // R8-03 hardening: the import's declared file fanout must fit the tree
  // reader's bound — a wider fanout could only be compared against partial
  // cached readings, so the whole import refuses before publication.
  if (distinctDeclaredFilePaths(candidates).size > MAX_IMPORTED_DECLARED_PATHS) {
    refuse(`the import declares more than ${MAX_IMPORTED_DECLARED_PATHS} distinct file paths; the whole import is refused rather than trusted to partial readings`);
  }
  const payload: BranchImportRow = {
    schema: CONTEXT_GRAPH_SCHEMA,
    session: options.sessionId,
    workspace: options.workspaceId,
    source: importReady.source,
    source_blob: importReady.bundle.blob,
    source_blob_bytes: importReady.bundle.blob_bytes,
    repository: scope.id,
    repository_ref: repositoryRef,
    candidates,
  };
  try {
    assertNoSecrets({ payload: payload as unknown as Record<string, unknown>, name: CONTEXT_BRANCH_IMPORT_ROW });
  } catch {
    return refuse("a derived candidate matches the credential guard; the import is refused whole");
  }
  const head = { seq: log.lastSeq, hash: log.lastHash };
  log.appendBatchDurable(() => {
    if (log.lastSeq !== head.seq || log.lastHash !== head.hash) refuse("the target head moved during the branch context import");
    if (log.events.some(row => row.name === "provider/request" || row.name === "context/frame" || row.name === CONTEXT_BRANCH_IMPORT_ROW)) {
      refuse("the target is no longer fresh for the branch context import");
    }
    return [{ kind: "observe" as const, name: CONTEXT_BRANCH_IMPORT_ROW, payload: payload as unknown as Record<string, unknown> }];
  });
  // The fold is the acceptance authority: a row the fold refuses is a failed
  // import, never a confirmed one.
  projectContextGraph(log.events, sessionRetainedReader(log.path));
  return { ids: candidates.map(candidate => candidate.id) };
}

// ---------------------------------------------------------------------------
// Cold replay validation.
// ---------------------------------------------------------------------------

/** Verify every recorded branch-context row from retained evidence alone:
 * the fold re-derives the candidates from the retained bundle and the fit
 * rows from the recorded tree reads. No live workspace, no source root. */
export function validateRecordedBranchContext(log: { readonly path: string; readonly events: readonly EventRecord[] }, suppliedStore?: BlobStore): void {
  if (!log.events.some(row => row.name === CONTEXT_BRANCH_IMPORT_ROW || row.name === CONTEXT_BRANCH_FIT_ROW)) return;
  projectContextGraph(log.events, sessionRetainedReader(log.path, suppliedStore));
}

// ---------------------------------------------------------------------------
// The shared branch-context authority check (R8-03 hardening): the live
// writer, the live fold and every cold projection call the SAME validator,
// so none of them can be stricter or looser than another. Everything is
// derived from the recorded prefix and the retained-body reader — no
// filesystem allocation, no model, no Git.
// ---------------------------------------------------------------------------

/** The normalized distinct declared file paths of a candidate list. */
export function distinctDeclaredFilePaths(candidates: readonly ImportedLessonCandidate[]): Set<string> {
  const paths = new Set<string>();
  for (const candidate of candidates) {
    for (const resource of candidate.scope.resources) {
      if (resource.kind === "file") paths.add(resource.resourceId.replace(/^\.\//u, ""));
    }
  }
  return paths;
}

export interface BranchContextAuthority {
  readonly workspaceReady: BranchWorkspaceReady;
  readonly workspaceRow: EventRecord;
  readonly importReady: z.infer<typeof checkpointImportReceiptSchemas["branch/import_ready"]>;
  readonly importReadyRow: EventRecord;
}

/** The one shared authority check behind a branch-context import: the
 * workspace lifecycle must hold exactly one ACTIVE ready outcome for this
 * session and identifier (no failed/released/closed/unknown readiness, no
 * orphan or duplicate receipt — the workspace host's own closed validator),
 * the checkpoint input import receipt chain must be valid (the R8-01 replay
 * projector), and the provider-input fold must accept the whole prefix from
 * the retained bodies (the import's own acceptance authority). Throws
 * BranchContextError with the first refusal. */
export function validateBranchContextAuthority(
  events: readonly EventRecord[],
  input: { session: string; workspace: string; reader: RetainedBranchBodyReader },
): BranchContextAuthority {
  const active = activeBranchWorkspaceReady(events, input.session, input.workspace);
  if (active === undefined) {
    refuse("the branch workspace has no active ready outcome for this session and identifier");
  }
  try {
    projectCheckpointInputImportReferences(events);
  } catch (error) {
    return refuse(`the checkpoint input import authority differs (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
  }
  let importReadyRow: EventRecord | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = events[index]!;
    if (row.name === "branch/import_ready" && row.payload.session === input.session) {
      importReadyRow = row;
      break;
    }
  }
  if (importReadyRow === undefined) refuse("the child records no checkpoint input import for this session");
  const importReady = parseRow(checkpointImportReceiptSchemas["branch/import_ready"], importReadyRow.payload, "branch/import_ready");
  // The provider-input fold over the prefix, from the retained reader alone:
  // every provider body (and the retained bundle an import state row roots)
  // must be exactly what its row names, and the import transformation must
  // re-derive — the same acceptance the writer's own fold applied.
  const bodies = new Map<string, unknown>();
  const readBody = (digest: string): unknown => {
    if (bodies.has(digest)) return bodies.get(digest);
    const text = input.reader(digest);
    if (text === undefined) refuse(`a retained provider body sha256:${digest.slice(0, 12)} is unavailable to the branch authority check`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refuse(`a retained provider body sha256:${digest.slice(0, 12)} is not JSON`);
    }
    bodies.set(digest, body);
    return body;
  };
  for (const row of events) {
    if (!PROVIDER_BODY_EVENTS.has(row.name)) continue;
    if (typeof row.payload.blob !== "string") refuse("a provider body row of the prefix names no blob");
    const body = readBody(row.payload.blob);
    if (row.name === "provider/state" && body !== null && typeof body === "object" && !Array.isArray(body)) {
      const stateBody = body as { reason?: unknown; bundle?: { blob?: unknown } | null };
      const bundleDigest = stateBody.bundle !== null && typeof stateBody.bundle === "object"
        ? stateBody.bundle.blob : undefined;
      if (stateBody.reason === CHECKPOINT_IMPORT_REASON && typeof bundleDigest === "string") readBody(bundleDigest);
    }
  }
  try {
    projectProviderInputs(events, bodies);
  } catch (error) {
    return refuse(`the retained input authority differs (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
  }
  assertFormalDestination(events, readBody(importReady.bundle.blob));
  return { workspaceReady: active.payload, workspaceRow: active.row, importReady, importReadyRow };
}

/** Schema-3 candidates exist only when BOTH the source and this destination
 * sealed context-formal-work-v1: a source that recorded a schema-3 lesson
 * within its captured head imports only into a destination sealed under that
 * generation. An older destination fails closed rather than reinterpreting a
 * formal-case observable under semantics that never defined one. */
function assertFormalDestination(events: readonly EventRecord[], bundle: unknown): void {
  let destination: number | undefined;
  try {
    destination = projectSessionReplaySchemas(events).featureStart.get(FORMAL_WORK_FEATURE);
  } catch {
    refuse("the destination replay features differ");
  }
  if (destination !== undefined) return;
  const value = bundle as { events?: unknown; source?: { head?: { seq?: unknown } } } | null;
  const headSeq = value?.source?.head?.seq;
  if (value === null || !Array.isArray(value.events) || typeof headSeq !== "number") refuse("the source bundle carries no captured head");
  const source = (value.events as EventRecord[]).slice(0, headSeq);
  let start: number | undefined;
  try {
    start = projectSessionReplaySchemas(source).featureStart.get(FORMAL_WORK_FEATURE);
  } catch {
    refuse("the source replay features differ");
  }
  if (start === undefined) return;
  if (source.some(row => row.seq > start && row.name === CONTEXT_LESSON_ROW
    && (row.payload.lesson as { schema?: unknown } | undefined)?.schema === 3)) {
    refuse(`a schema-3 source lesson needs a destination sealed under ${FORMAL_WORK_FEATURE}; an older destination is never reinterpreted`);
  }
}

export { repositoryScopeOf };
