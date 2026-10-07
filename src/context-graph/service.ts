import { contributionFrameOf } from "../host/context-contribution.ts";
import { createHash } from "node:crypto";
import { BlobStore } from "../host/blob-store.ts";
import { activeBranchWorkspaceReady, verifyBranchWorkspaceLiveResource } from "../host/branch-workspace.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { workspaceDigest, type DigestCache } from "../host/execution-receipt.ts";
import { sessionDigestCache } from "../work/session-base.ts";
import { canonicalJson } from "../host/canonical.ts";
import { contextFrameIdOf, messageText } from "../host/context-frame.ts";
import type { EventLog } from "../host/event-log.ts";
import { assertNoSecrets } from "../host/redact.ts";
import { sessionReplayFeatureGenerationIndex, type EventRecord } from "../host/schema.ts";
import type { RequestContextContribution, RequestContextDecision, RequestContextInput } from "../loader/types.ts";
import {
  BranchContextError,
  computeImportedFit,
  importedFitPayload,
  repositoryScopeOf,
  sessionRetainedReader,
  CONTEXT_BRANCH_FIT_ROW,
  CONTEXT_BRANCH_IMPORT_ROW,
  type ImportedFitCurrent,
  type ImportedLessonCandidate,
  type RetainedBranchBodyReader,
} from "./branch-context.ts";
import { isSelectionFrame, assessmentsDue, fileResources, formalObservableFromActions, liveContextGraph, observableFromActions, projectContextGraph, scopeKey, syncContextGraph, workspaceVersions, type ContextGraphFold, type ContextGraphSnapshot, type FrameState, type Invocation } from "./projector.ts";
import type { FormalExecution } from "./formal-work.ts";
import { applicability, frameBudget, frameRecovery, lineDigest, policyDigest, quote, renderFrame, selectFrame, type FrameSelection } from "./selection.ts";
import {
  assessmentSchema,
  attemptSchema,
  CONTEXT_ACCOUNTING_ROWS,
  CONTEXT_ASSESSMENT_ROW,
  CONTEXT_ATTEMPT_ROW,
  CONTEXT_DEGRADED_ROW,
  CONTEXT_FRAME_ROW,
  CONTEXT_GRAPH_SCHEMA,
  CONTEXT_LESSON_ROW,
  CONTEXT_QUERY_ROW,
  CONTEXT_SCOPE_ROW,
  CONTEXT_TREE_ROW,
  ContextGraphSchemaError,
  DEFAULT_FRAME_POLICY,
  frameRowSchema,
  lessonSchema,
  type Applicability as ApplicabilityScope,
  type Assessment,
  type Attempt,
  type ContextFrame,
  type EventRef,
  type EvidenceRef,
  type FrameCoverage,
  type FramePolicy,
  type FrameRow,
  type Lesson,
  type ResourceVersion,
} from "./types.ts";

/**
 * #227 CG-03/CG-04 — the context graph service (TS-28 §9): lesson recording
 * with reference verification, scoped queries, and the request-context
 * contribution the loop calls at every provider-request boundary.
 *
 * Authority stays where it was. The repository and goal a lesson is scoped to
 * are the host's (the latest `context/scope` row and the current order
 * scope); a model can only cite rows of THIS session's log, by seq and hash,
 * and a citation the host cannot verify — no such row, another session's
 * hash, another goal or repository, a context row, a body that is gone — is
 * `not_recorded` with the reason returned as data, and the session goes on.
 * A lesson is always recorded `proposed`; only a separate assessment that
 * cites a host observation newer than the assessed revision can make it
 * corroborated or contested. An I/O failure while appending is not hidden as
 * `not_recorded`: it propagates through the durable-write error path.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type LessonRecordResult =
  | { readonly status: "recorded"; readonly event: EventRef; readonly lessonId: string; readonly revision: number; readonly kind: "lesson" | "assessment" }
  | { readonly status: "not_recorded"; readonly reason: "invalid_reference" | "scope_mismatch" | "stale_revision" | "invalid_shape"; readonly detail: string };

/** What a caller proposes. The public tool maps its arguments onto this; the
 * repository and goal are never tool arguments — a caller that names ones
 * that differ from the host's authority is refused (scope_mismatch). */
export interface LessonProposal {
  readonly statement?: string;
  readonly evidence: readonly EventRef[];
  readonly lesson?: string;
  readonly revision?: number;
  readonly stance?: "supports" | "contradicts";
  readonly supersedes?: string;
  readonly condition?: string;
  readonly resources?: readonly string[];
  readonly dependencyCoverage?: "declared" | "incomplete";
  readonly retryConditions?: readonly string[];
  readonly invalidationConditions?: readonly string[];
  readonly repositoryWide?: boolean;
  /** §132 A1': the observable the lesson predicts. */
  readonly attempt?: {
    readonly question?: string;
    readonly hypothesis?: string;
    readonly expected?: string;
    readonly outcome?: Attempt["outcome"];
    readonly actions?: readonly EventRef[];
    readonly previousAttempt?: string;
    readonly changedConditions?: readonly EventRef[];
    readonly changedApproach?: string;
  };
  readonly goalId?: string;
  readonly repositoryId?: string;
}

class Refusal extends Error {
  constructor(readonly reason: Extract<LessonRecordResult, { status: "not_recorded" }>["reason"], readonly detail: string) {
    super(detail);
  }
}

const NOT_EVIDENCE = new Set([...CONTEXT_ACCOUNTING_ROWS, "provider/state", "provider/prefix", "provider/request",
  "provider/payload", "provider/send", "provider/response", "session/open", "prompt/seal", "plugin/load", "plugin/skip"]);

/** A citation as the tool accepts it: a seq and the row's hash or at least
 * its first 16 hex characters (what a frame prints). Resolution against the
 * log turns it into the full reference or refuses it. */
function isRef(value: unknown): value is EventRef {
  return typeof value === "object" && value !== null && Number.isSafeInteger((value as EventRef).seq) && (value as EventRef).seq > 0
    && typeof (value as EventRef).hash === "string" && /^[a-f0-9]{16,64}$/u.test((value as EventRef).hash);
}

function sameRow(fact: { hash: string }, item: EventRef): boolean {
  return item.hash.length === 64 ? fact.hash === item.hash : fact.hash.startsWith(item.hash);
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") throw new Refusal("invalid_shape", `${field} must be a string`);
  if (value.length > max) throw new Refusal("invalid_shape", `${field} exceeds ${max} characters`);
  return value;
}

function texts(value: unknown, maxItems: number, max: number, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Refusal("invalid_shape", `${field} must be at most ${maxItems} strings`);
  return value.map((item, index) => text(item, max, `${field}[${index}]`));
}

function refs(value: unknown, min: number, max: number, field: string): EventRef[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || !value.every(isRef)) {
    throw new Refusal("invalid_shape", `${field} must be ${min}..${max} event references {seq, hash}`);
  }
  return value.map((item) => ({ seq: item.seq, hash: item.hash }));
}

/** Resolve one citation against the live projection of THIS log. */
function resolveEvidence(fold: ContextGraphFold, store: BlobStore, item: EventRef, scope: { goalId?: string; repositoryId: string }): EvidenceRef {
  const fact = fold.facts.get(item.seq);
  if (!fact || !sameRow(fact, item)) throw new Refusal("invalid_reference", `seq ${item.seq} is not a row of this session with that hash`);
  if (NOT_EVIDENCE.has(fact.name)) throw new Refusal("invalid_reference", `seq ${item.seq} (${fact.name}) is not an observation`);
  if (fact.repositoryId !== scope.repositoryId) throw new Refusal("scope_mismatch", `seq ${item.seq} belongs to another repository scope`);
  if (scope.goalId !== undefined && fact.goalId !== scope.goalId) throw new Refusal("scope_mismatch", `seq ${item.seq} belongs to another goal`);
  if (fact.blob !== undefined && !store.has(fact.blob)) throw new Refusal("invalid_reference", `the body of seq ${item.seq} is no longer retained`);
  return {
    event: { seq: fact.seq, hash: fact.hash },
    body: fact.blob !== undefined && fact.blobBytes !== undefined ? { digest: fact.blob, bytes: fact.blobBytes } : null,
    availability: fact.availability,
    authority: fact.authority,
  };
}

export interface ContextGraphServiceOptions {
  readonly log: EventLog;
  readonly mode: "shadow" | "on";
  /** §133 P3: the tree applicability is read from (absent: never read, so
   * every version comparison is `unknown`). */
  readonly workspaceRoot?: string;
  readonly policy?: FramePolicy;
}

export interface RecordedContextResult {
  readonly sourceHead: EventRef | null;
  readonly body: { digest: string; bytes: number };
  readonly coverage: FrameCoverage;
  readonly text: string;
}

export class ContextGraphService {
  readonly log: EventLog;
  readonly mode: "shadow" | "on";
  readonly policy: FramePolicy;

  readonly workspaceRoot: string | undefined;
  private digestCache: DigestCache | undefined;

  constructor(options: ContextGraphServiceOptions) {
    this.log = options.log;
    this.mode = options.mode;
    this.policy = options.policy ?? DEFAULT_FRAME_POLICY;
    this.workspaceRoot = options.workspaceRoot;
  }

  /** §133 P3: read the tree now — the workspace image under the session's
   * base coverage and the content digest of each path (null: not readable,
   * outside the root, or a link out of it) — and record it as a
   * `context/tree` row when it differs from the last reading. */
  readTree(paths: readonly string[], withImage: boolean): void {
    const root = this.workspaceRoot;
    if (root === undefined || this.log.isReadOnly) return;
    let image: string | null = null;
    if (withImage) {
      try {
        this.digestCache ??= sessionDigestCache(this.log, root);
        image = workspaceDigest(root, this.digestCache);
      } catch { image = null; }
    }
    const files = [...new Set(paths.map((path) => path.replace(/^\.\//u, "")))].slice(0, 64).map((path) => ({ path, digest: fileDigest(root, path) }));
    const fold = liveContextGraph(this.log);
    const same = fold.tree !== undefined && (!withImage || fold.tree.image === image)
      && files.every((file) => fold.tree!.files.get(file.path) === file.digest);
    if (same) return;
    const current = fold.tree;
    this.log.append({ kind: "observe", name: CONTEXT_TREE_ROW, payload: {
      schema: CONTEXT_GRAPH_SCHEMA, image: withImage ? image : current?.image ?? null, files,
    } });
  }

  /** §133 P3: read the tree for the active lessons' declared resources. */
  private readActiveTree(): void {
    if (this.workspaceRoot === undefined) return;
    const fold = liveContextGraph(this.log);
    const paths: string[] = [];
    let image = false;
    for (const id of fold.lessonOrder) {
      const state = fold.lessons.get(id)!;
      if (state.supersededBy !== undefined) continue;
      for (const resource of state.revisions.at(-1)!.lesson.scope.resources) {
        if (resource.kind === "workspace") image = true;
        else if (resource.kind === "file") paths.push(resource.resourceId);
      }
    }
    if (image || paths.length > 0) this.readTree(paths, image);
  }

  /**
   * R8-03: reassess every imported parent lesson at this prepare/query
   * boundary. The retained source bundle must still be present — missing
   * retained import evidence BLOCKS branch-context preparation (a hard
   * error, never a degraded no-op that would keep an old frame standing).
   * Live ownership loss of the bound workspace root refuses the same way;
   * the check compares the live root with the identity the workspace's own
   * ready receipt recorded (the workspace service's durable ownership
   * binding), not a re-implemented containment walk. The current root scope
   * is re-derived (device/inode identity, never a path spelling) and
   * recorded when it changed, the declared file resources are read fresh,
   * and one `context/branch_fit` row per changed fit binds the current
   * scope, goal statement and tree evidence.
   */
  private reassessImportedLessons(): void {
    const initial = liveContextGraph(this.log);
    if (initial.importedLessons.size === 0) return;
    const store = BlobStore.forSession(this.log.path);
    // The retained source is RE-VERIFIED at every boundary — its digest, not
    // merely its presence — so bytes changed under a live fold cache cannot
    // hide behind it. Missing retained import evidence blocks branch-context
    // preparation (a hard error, never a degraded no-op that would keep an
    // old frame standing).
    for (const state of initial.importedLessons.values()) {
      let text: string;
      try {
        text = store.get(state.sourceBlob);
      } catch {
        throw new BranchContextError(`the retained branch source body ${state.sourceBlob.slice(0, 12)} is missing; branch context preparation is blocked`);
      }
      if (sha256(text) !== state.sourceBlob) {
        throw new BranchContextError("the retained branch source body differs from its digest; branch context preparation is blocked");
      }
    }
    const binding = initial.branchImportBinding;
    if (binding !== undefined) {
      // The workspace host's OWN closed lifecycle predicate and live
      // ownership/containment verification — mount table, resource root
      // uid/dev/ino/mode, the mode0600 owner marker's identity, digest and
      // binding, and current containment. Never a partial copy: a spent
      // (released/closed/failed/unknown) resource or a swapped container
      // inode refuses here exactly as the workspace service's own read does.
      if (initial.releasedWorkspaces.has(binding.workspace)) {
        throw new BranchContextError("the branch workspace is released or closed; branch context preparation is blocked");
      }
      const active = activeBranchWorkspaceReady(this.log.events, binding.session, binding.workspace);
      if (active === undefined) {
        throw new BranchContextError("the branch workspace has no active ready outcome; branch context preparation is blocked");
      }
      try {
        verifyBranchWorkspaceLiveResource(active.payload);
      } catch (error) {
        throw new BranchContextError(`branch workspace verification refused (${error instanceof Error ? error.message.slice(0, 160) : "unknown"})`);
      }
    }
    if (!this.log.isReadOnly && this.workspaceRoot !== undefined) {
      // The current root identity, recorded as a new scope when it changed.
      const scope = repositoryScopeOf(this.log, this.workspaceRoot);
      if (scope !== undefined) this.recordScope(scope.id, scope.source);
      // Fresh reads of every declared file resource of the imported lessons.
      const paths = new Set<string>();
      for (const state of liveContextGraph(this.log).importedLessons.values()) {
        for (const resource of state.candidate.scope.resources) {
          if (resource.kind === "file") paths.add(resource.resourceId.replace(/^\.\//u, ""));
        }
      }
      if (paths.size > 0) this.readTree([...paths], false);
    }
    const now = liveContextGraph(this.log);
    const goalId = now.currentGoal;
    const current: Omit<ImportedFitCurrent, "importRepository"> = {
      repositoryId: now.repositoryId,
      goalId: goalId ?? null,
      goalStatementDigest: goalId !== undefined ? now.goalStatements.get(goalId) : undefined,
      tree: now.tree === undefined ? null : { files: now.tree.files },
    };
    const rows: Array<{ name: string; payload: Record<string, unknown> }> = [];
    for (const state of now.importedLessons.values()) {
      const fit = computeImportedFit(state.candidate, { ...current, importRepository: state.repository });
      const payload = importedFitPayload({
        candidate: state.candidate,
        importRef: state.importRef,
        tree: now.tree === undefined ? null : now.tree.ref,
        repositoryId: now.repositoryId,
        fit,
      });
      if (state.fit !== undefined && canonicalJson(state.fit.row) === canonicalJson(payload)) continue;
      rows.push({ name: CONTEXT_BRANCH_FIT_ROW, payload: payload as unknown as Record<string, unknown> });
    }
    if (rows.length > 0 && !this.log.isReadOnly) {
      this.log.appendBatchDurable(() => rows.map(row => ({ kind: "observe" as const, name: row.name, payload: row.payload })));
    }
  }

  /** §133 A1'': record every assessment the host owes, as host rows. */
  mintAssessments(): number {
    if (this.log.isReadOnly) return 0;
    const due = assessmentsDue(liveContextGraph(this.log));
    if (due.length === 0) return 0;
    let count = liveContextGraph(this.log).assessmentCount;
    const rows = due.map((item) => {
      const fact = liveContextGraph(this.log).facts.get(item.judged.seq)!;
      const assessment: Assessment = {
        schema: 1,
        id: `assess-${count += 1}`,
        lesson: item.lesson,
        revision: item.revision,
        stance: item.observed === "fail" ? "supports" : "contradicts",
        evidence: [{ event: item.judged, body: fact.blob !== undefined && fact.blobBytes !== undefined ? { digest: fact.blob, bytes: fact.blobBytes } : null,
          availability: fact.availability, authority: fact.authority }],
        author: "host",
        observed: item.observed,
      };
      return { kind: "observe" as const, name: CONTEXT_ASSESSMENT_ROW, payload: { schema: CONTEXT_GRAPH_SCHEMA, assessment: assessmentSchema.parse(assessment) } };
    });
    this.log.appendBatchDurable(() => rows);
    return rows.length;
  }

  sync(sourceHead: EventRef): ContextGraphSnapshot {
    // R8-03: a session with imported lessons reads its retained source
    // bundles from its own store when it syncs.
    return syncContextGraph(this.log.events, sourceHead, sessionRetainedReader(this.log.path));
  }

  /** Record the session's repository scope once per change (plugin boot). */
  recordScope(repositoryId: string, source: "base_record" | "root_inode"): void {
    if (this.log.isReadOnly) return;
    const fold = liveContextGraph(this.log);
    if (fold.repositoryId === repositoryId && fold.scopeMode === this.mode) return;
    this.log.append({ kind: "observe", name: CONTEXT_SCOPE_ROW, payload: {
      schema: CONTEXT_GRAPH_SCHEMA, repository_id: repositoryId, source, mode: this.mode, policy_digest: policyDigest(this.policy),
    } });
  }

  /** lesson_record: verify, then append; refusals are data. */
  recordLesson(proposal: LessonProposal): LessonRecordResult {
    let rows: Array<{ name: string; payload: Record<string, unknown> }>;
    let result: { lessonId: string; revision: number; kind: "lesson" | "assessment" };
    // §133 P3: a declared file's version is what the host reads of it now.
    if (Array.isArray(proposal.resources) && proposal.resources.length > 0 && proposal.resources.length <= 16
      && proposal.resources.every((item) => typeof item === "string" && item.length <= 300)) {
      this.readTree(proposal.resources, false);
    }
    try {
      ({ rows, result } = this.prepareLesson(proposal));
    } catch (error) {
      if (error instanceof Refusal) return { status: "not_recorded", reason: error.reason, detail: error.detail };
      throw error;
    }
    // Refuse what the log's own guard would refuse BEFORE appending: a
    // rejected append fails the session's writer (constitution 1).
    for (const row of rows) {
      try { assertNoSecrets({ payload: row.payload, name: row.name }); }
      catch { return { status: "not_recorded", reason: "invalid_shape", detail: "the proposal matches the secret guard; remove the credential-shaped text" }; }
    }
    const appended = this.log.appendBatchDurable(() => rows.map((row) => ({ kind: "observe" as const, name: row.name, payload: row.payload })));
    const last = appended.at(-1)!;
    return { status: "recorded", event: { seq: last.seq, hash: last.hash }, ...result };
  }

  private prepareLesson(proposal: LessonProposal): { rows: Array<{ name: string; payload: Record<string, unknown> }>; result: { lessonId: string; revision: number; kind: "lesson" | "assessment" } } {
    if (this.log.isReadOnly) throw new Refusal("invalid_shape", "a read-only session records no lesson");
    const fold = liveContextGraph(this.log);
    const store = BlobStore.forSession(this.log.path);
    const goalId = fold.currentGoal;
    if (goalId === undefined) throw new Refusal("scope_mismatch", "no operator goal is recorded yet");
    if (proposal.goalId !== undefined && proposal.goalId !== goalId) throw new Refusal("scope_mismatch", "the goal is the host's current goal, not a caller's");
    if (proposal.repositoryId !== undefined && proposal.repositoryId !== fold.repositoryId) {
      throw new Refusal("scope_mismatch", "the repository is the host's, not a caller's");
    }
    const evidenceRefs = refs(proposal.evidence, 1, 16, "evidence");
    const repositoryWide = proposal.repositoryWide === true;
    const scopeCheck = { repositoryId: fold.repositoryId, ...(repositoryWide ? {} : { goalId }) };
    const evidence = evidenceRefs.map((item) => resolveEvidence(fold, store, item, scopeCheck));

    // §133 A1'': assessments are host-minted; the model proposes statements
    // and conditions only.
    if (proposal.stance !== undefined) throw new Refusal("invalid_shape", "assessments are recorded by the host from judged runs; lesson_record proposes statements and conditions only");

    const statement = text(proposal.statement, 2000, "statement").trim();
    if (statement === "") throw new Refusal("invalid_shape", "statement is required");
    const retryConditions = texts(proposal.retryConditions, 8, 400, "retry_conditions");
    const invalidationConditions = texts(proposal.invalidationConditions, 8, 400, "invalidation_conditions");
    const declared = texts(proposal.resources, 16, 300, "resources");
    const condition = proposal.condition === undefined ? "" : text(proposal.condition, 1200, "condition");
    if (proposal.dependencyCoverage !== undefined && proposal.dependencyCoverage !== "declared" && proposal.dependencyCoverage !== "incomplete") {
      throw new Refusal("invalid_shape", "dependency_coverage must be declared or incomplete");
    }
    const observationResources = workspaceVersions(fold, evidence);
    const separatedObservations = fold.lessonObservationStart !== undefined;
    const resources: ResourceVersion[] = [
      ...(separatedObservations ? [] : observationResources),
      // #221: a declared file carries the version the host last observed of
      // it (a read receipt or a commit) — an observation for applicability,
      // never authority; without one it is unknown.
      ...fileResources(fold, declared, evidence[0]!),
    ];
    const scope: ApplicabilityScope = {
      repositoryId: fold.repositoryId,
      goalId: repositoryWide ? null : goalId,
      resources,
      dependencyCoverage: proposal.dependencyCoverage ?? "incomplete",
      conditionText: condition,
    };

    const rows: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const attemptIds: string[] = [];
    const pendingActions: EventRef[] = [];
    if (proposal.attempt !== undefined) {
      const input = proposal.attempt;
      const actions = input.actions === undefined ? [] : refs(input.actions, 0, 32, "attempt.actions");
      for (const action of actions) {
        const fact = fold.facts.get(action.seq);
        // context-formal-work-v1: a genuine formal Work execution start of
        // this session, repository and goal is a host action too.
        const formal = fact && sameRow(fact, action) ? fold.formalExecutions.get(action.seq) : undefined;
        if (formal !== undefined) {
          if (formal.goalId !== goalId) throw new Refusal("scope_mismatch", `attempt action seq ${action.seq} belongs to another goal`);
          if (formal.repositoryId !== fold.repositoryId) throw new Refusal("scope_mismatch", `attempt action seq ${action.seq} belongs to another repository scope`);
          action.hash = fact!.hash;
          continue;
        }
        if (!fact || !sameRow(fact, action) || fact.name !== "tool/call") throw new Refusal("invalid_reference", `attempt action seq ${action.seq} is not a tool call of this session`);
        if (fact.goalId !== goalId) throw new Refusal("scope_mismatch", `attempt action seq ${action.seq} belongs to another goal`);
        action.hash = fact.hash;
      }
      const changed = input.changedConditions === undefined ? [] : refs(input.changedConditions, 0, 16, "attempt.changed_conditions")
        .map((item) => resolveEvidence(fold, store, item, { repositoryId: fold.repositoryId, goalId }));
      if (input.previousAttempt !== undefined && !fold.attempts.has(input.previousAttempt)) {
        throw new Refusal("invalid_reference", `${input.previousAttempt} is not a recorded attempt`);
      }
      const outcome = input.outcome ?? "open";
      const attempt: Attempt = {
        schema: 1,
        id: `att-${fold.attempts.size + 1}`,
        goalId,
        question: input.question === undefined ? "" : text(input.question, 1200, "attempt.question"),
        hypothesisRefs: [],
        intentOrigin: "model_declared",
        inputScope: scope,
        actionRefs: actions,
        observationRefs: evidence,
        expected: input.expected === undefined ? null : text(input.expected, 1200, "attempt.expected"),
        outcome,
        // The host never turns an exit code into an outcome: a stated
        // outcome is the model's, and an absent one is unknown.
        outcomeAuthority: input.outcome === undefined ? "unknown" : "model_statement",
        previousAttempt: input.previousAttempt ?? null,
        changedConditions: changed,
        changedApproach: input.changedApproach === undefined ? null : text(input.changedApproach, 1200, "attempt.changed_approach"),
      };
      const parsed = attemptSchema.safeParse(attempt);
      if (!parsed.success) throw new Refusal("invalid_shape", "the attempt does not fit its schema");
      rows.push({ name: CONTEXT_ATTEMPT_ROW, payload: { schema: CONTEXT_GRAPH_SCHEMA, attempt: parsed.data } });
      attemptIds.push(attempt.id);
      pendingActions.push(...parsed.data.actionRefs);
    }

    let id: string, revision: number, previousRevision: EventRef | undefined;
    if (proposal.lesson !== undefined) {
      id = text(proposal.lesson, 32, "lesson");
      const state = fold.lessons.get(id);
      if (!state) throw new Refusal("invalid_reference", `${id} is not a recorded lesson`);
      const latest = state.revisions.at(-1)!;
      if (proposal.revision !== latest.lesson.revision) throw new Refusal("stale_revision", `${id} is at r${latest.lesson.revision}`);
      revision = latest.lesson.revision + 1;
      previousRevision = latest.ref;
    } else {
      id = `lesson-${fold.lessons.size + 1}`;
      revision = 1;
    }
    // §133 A1'': the observable is the host's: the newest RED judged run the
    // lesson's attempts' own invocations produced, bound by its command digest.
    if (proposal.lesson !== undefined && attemptIds.length === 0) attemptIds.push(...fold.lessons.get(id)!.revisions.at(-1)!.lesson.attemptIds);
    const actions = [...pendingActions, ...attemptIds.filter((attemptId) => fold.attempts.has(attemptId)).flatMap((attemptId) => fold.attempts.get(attemptId)!.attempt.actionRefs)];
    // context-formal-work-v1: an authenticated qualifying RED of a cited
    // formal execution is a schema-3 formal-case observable; otherwise the
    // earlier derivation, unchanged.
    const formalObservable = formalObservableFromActions(fold, actions);
    const observable = formalObservable ?? observableFromActions(fold, actions);
    let supersedes: Lesson["supersedes"] = null;
    if (proposal.supersedes !== undefined) {
      const other = fold.lessons.get(proposal.supersedes);
      if (!other || proposal.supersedes === id) throw new Refusal("invalid_reference", `${proposal.supersedes} is not another recorded lesson`);
      supersedes = { lesson: proposal.supersedes, revision: other.revisions.length };
    }
    const lesson: Lesson = {
      schema: formalObservable !== null ? 3 : separatedObservations ? 2 : 1,
      ...(separatedObservations ? { observationResources } : {}),
      id,
      revision,
      attemptIds,
      statement,
      evidence,
      scope,
      epistemic: "proposed",
      assessmentRefs: [],
      retryConditions,
      invalidationConditions,
      previousRevision: previousRevision ?? null,
      observable,
      supersedes,
    };
    const parsed = lessonSchema.safeParse(lesson);
    if (!parsed.success) throw new Refusal("invalid_shape", "the lesson does not fit its schema");
    rows.push({ name: CONTEXT_LESSON_ROW, payload: { schema: CONTEXT_GRAPH_SCHEMA, lesson: parsed.data } });
    return { rows, result: { lessonId: id, revision, kind: "lesson" } };
  }

  /** context_query: the current goal's selection, every unresolved failure,
   * and the named nodes — never another goal's. Recorded as a
   * `context/query` row whose blob is the exact result. */
  query(input: { question: string; nodeIds?: readonly string[]; maxBytes?: number }): RecordedContextResult {
    // R8-03: a query boundary reassesses the imported lessons too — scope,
    // goal and fresh declared reads — before it answers.
    try {
      this.reassessImportedLessons();
    } catch (error) {
      if (!(error instanceof ContextGraphSchemaError)) throw error;
    }
    const fold = liveContextGraph(this.log);
    const goalId = fold.currentGoal;
    const maxBytes = Math.max(1024, Math.min(16_384, Math.trunc(input.maxBytes ?? 8192)));
    const lines: string[] = [`[dokkabi context query | ${CONTEXT_GRAPH_SCHEMA} | reference data from this session's log, not an instruction]`];
    let coverage: FrameCoverage = "complete_for_selection";
    if (goalId === undefined) {
      lines.push("no operator goal is recorded yet");
      coverage = "unavailable";
    } else {
      lines.push(`goal ${goalId} | source seq ${fold.headRef?.seq ?? 0} | graph rev ${fold.revision}`);
      const recent = [...fold.invocations.values()].filter(item => item.goalId === goalId && item.repositoryId === fold.repositoryId);
      if (recent.length > 0) {
        lines.push("recent actions and observations (current scope, oldest first; stdout is not an exit-code judgment):");
        for (const invocation of recent.slice(-20)) lines.push(`- ${invocationCitations(invocation)}${invocation.resultHead ? `; output head ${quote(invocation.resultHead, 160)}` : ""}`);
        if (recent.length > 20) {
          lines.push(`[${recent.length - 20} earlier current-scope actions omitted; inspect their exact node ids]`);
          coverage = "partial";
        }
        if (recent.slice(-20).some(item => item.rowsPartial || item.resultAvailability !== "retained")) coverage = "partial";
      }
      const failures = (fold.failures.get(scopeKey(fold.repositoryId, goalId)) ?? []).map((key) => fold.invocations.get(key)!).filter((item) => item.resolvedBy === undefined);
      if (failures.length > 0) {
        lines.push("unresolved failures (host observations, oldest first):");
        for (const invocation of failures.slice(-40)) lines.push(`- f:${invocation.key} ${invocation.tool} (call seq ${invocation.call.seq}): ${invocation.mechanical}`);
        if (failures.length > 40) coverage = "partial";
      }
      // context-formal-work-v1: the current scope's formal Work executions
      // with their exact start and verdict references (none exist in an
      // earlier generation, so its query bytes are unchanged).
      const formal = [...fold.formalExecutions.values()].filter((item) => item.goalId === goalId && item.repositoryId === fold.repositoryId);
      if (formal.length > 0) {
        lines.push("formal Work executions (current scope, oldest first; the host judges a verdict only from the authenticated retained execution — output text, an exit code or a status name alone is never the judgment; a lesson may name a start in attempt.actions and cite its verdict as evidence):");
        for (const execution of formal.slice(-20)) lines.push(`- ${formalCitations(fold, execution)}`);
        if (formal.length > 20) {
          lines.push(`[${formal.length - 20} earlier formal executions omitted; inspect their exact wx: node ids]`);
          coverage = "partial";
        }
      }
      for (const nodeId of input.nodeIds ?? []) lines.push(...this.describe(fold, goalId, nodeId));
    }
    let body = lines.join("\n");
    if (Buffer.byteLength(body) > maxBytes) {
      body = `${Buffer.from(body).subarray(0, maxBytes - 40).toString("utf8").replace(/�+$/u, "")}\n[query result cut at ${maxBytes} bytes]`;
      coverage = "partial";
    }
    const digest = BlobStore.forSession(this.log.path).put(body);
    const head = fold.headRef;
    if (!this.log.isReadOnly && head) {
      this.log.append({ kind: "observe", name: CONTEXT_QUERY_ROW, payload: {
        schema: CONTEXT_GRAPH_SCHEMA, goal_id: goalId ?? "none", source_head: head, question_digest: sha256(input.question),
        blob: digest, blob_bytes: Buffer.byteLength(body), coverage,
      } });
    }
    return { sourceHead: head, body: { digest, bytes: Buffer.byteLength(body) }, coverage, text: body };
  }

  private describe(fold: ContextGraphFold, goalId: string, raw: string): string[] {
    const nodeId = raw.replace(/^[fpila]:/u, "").replace(/^w:(?=wx:)/u, "");
    // R8-03: an imported candidate is shown with its full foreign provenance —
    // inspectable history even when its fit is ineligible.
    const imported = fold.importedLessons.get(nodeId.replace(/#r[0-9]+$/u, ""));
    if (imported) {
      const candidate: ImportedLessonCandidate = imported.candidate;
      const lines = [
        `${imported.id}: imported parent lesson (historical model claim; never a local lesson or assessment)`,
        `  statement: ${quote(candidate.statement, 800)}`,
        `  source: session ${candidate.source.session} lesson ${candidate.source.lesson} r${candidate.source.revision} at source seq ${candidate.source.event.seq}; historical epistemic ${candidate.epistemic}`,
        `  source repository ${candidate.scope.repository}${candidate.source_repository_current ? "" : " (an earlier source scope; the boundary's current scope differs)"}`,
        `  foreign evidence: ${candidate.evidence.map(item => `source seq ${item.event.seq} ${item.authority} ${item.availability}`).join(", ")}; parent session references, not this log's rows`,
      ];
      if (imported.fit !== undefined) {
        lines.push(`  fit at seq ${imported.fit.ref.seq}: ${imported.fit.row.verdict} (${imported.fit.row.reason}); goal statement ${imported.fit.row.goal.statement_match}; files ${imported.fit.row.files.map(file => `${file.path}:${file.verdict}`).join(", ")}`);
      } else {
        lines.push("  fit: none recorded yet (applicability unknown)");
      }
      return lines;
    }
    const lesson = fold.lessons.get(nodeId.replace(/#r[0-9]+$/u, ""));
    if (lesson) {
      const latest = lesson.revisions.at(-1)!.lesson;
      if ((latest.scope.goalId !== null && latest.scope.goalId !== goalId) || latest.scope.repositoryId !== fold.repositoryId) return [`${raw}: outside the current goal scope`];
      return [`${lesson.id} (${fold.epistemic(lesson.id)}; applicability ${applicability(fold, latest).state}):`,
        ...lesson.revisions.map(({ lesson: revision, ref }) => `  r${revision.revision} at seq ${ref.seq} ${fold.epistemic(lesson.id, revision.revision)}: ${quote(revision.statement, 800)}; evidence ${revision.evidence.map((item) => `seq ${item.event.seq} ${item.authority} ${item.availability}`).join(", ")}${formalObservableText(revision)}`),
        ...lesson.assessments.map(({ assessment, ref }) => `  ${assessment.id} at seq ${ref.seq}: ${assessment.stance} r${assessment.revision}: judged run seq ${assessment.evidence[0]!.event.seq} ${assessment.observed === "fail" ? "red again" : "green"}`)];
    }
    const invocation = fold.invocations.get(nodeId);
    if (invocation) {
      if (invocation.goalId !== goalId || invocation.repositoryId !== fold.repositoryId) return [`${raw}: outside the current goal scope`];
      return [describeInvocation(invocation)];
    }
    const formal = /^(obs:)?wx:([0-9]+)$/u.exec(nodeId);
    const execution = formal === null ? undefined : formal[1] === undefined ? fold.formalExecutions.get(Number(formal[2]))
      : fold.formalExecutions.get(fold.formalVerdicts.get(Number(formal[2]))?.start ?? 0);
    if (execution) {
      if (execution.goalId !== goalId || execution.repositoryId !== fold.repositoryId) return [`${raw}: outside the current goal scope`];
      return [formalCitations(fold, execution)];
    }
    const attempt = fold.attempts.get(nodeId);
    if (attempt) {
      if (attempt.attempt.goalId !== goalId || attempt.attempt.inputScope.repositoryId !== fold.repositoryId) return [`${raw}: outside the current goal scope`];
      return [`${attempt.attempt.id}: ${canonicalJson({ question: attempt.attempt.question, outcome: attempt.attempt.outcome, authority: attempt.attempt.outcomeAuthority, actions: attempt.attempt.actionRefs.map((item) => item.seq) })}`];
    }
    return [`${raw}: unknown node`];
  }

  /** The request-context contribution (CG-04). */
  contribution(): RequestContextContribution {
    return {
      mode: this.mode,
      prepare: (input) => this.prepare(input),
      degraded: (reason, boundary, detail, guard) => this.degraded(reason, boundary, detail, guard),
      refused: (input, guard) => this.refusedFrame(input, guard),
    };
  }

  private prepare(input: RequestContextInput): RequestContextDecision {
    let fold: ContextGraphFold;
    const reader = input.readerAuthorised === true;
    try {
      // §133 A1'': the host records the assessments later judged runs owe;
      // §133 P3: and reads the tree the active lessons' versions compare with;
      // R8-03: and reassesses the imported parent lessons against the current
      // scope, goal and tree (a missing retained source blocks here).
      this.mintAssessments();
      this.readActiveTree();
      this.reassessImportedLessons();
      fold = liveContextGraph(this.log);
    } catch (error) {
      if (!(error instanceof ContextGraphSchemaError)) throw error;
      this.degraded("projection_failed", input.boundary, error.message);
      return { action: "none" };
    }
    const selection = selectFrame(fold, this.policy, reader);
    if (!selection || !fold.headRef) return { action: "none" };
    const budget = frameBudget(this.policy, input);
    const reuseKey = reuseKeyOf(selection, { policy: this.policy, profile: input.profile, budget: budget.bytes, mode: this.mode, reader });
    const latest = latestFrame(fold, this.mode);
    if (this.mode === "shadow") {
      if (latest?.row.reuse_key === reuseKey) return { action: "none" };
      if (selection.items.length === 0 && !latest) return { action: "none" };
      return this.record(fold, selection, input, budget);
    }
    // §130 F1: the provider input carries exactly one live frame. The one the
    // transcript carries now (recorded frames only; a lookalike is text).
    const carried = liveFrameIn(fold, input.messages);
    // §132 F2': a live frame whose body is gone is rebuilt here, at the next
    // boundary — never refused at every request until the state changes.
    const live = carried !== undefined && bodyIntact(this.log, carried) ? carried : undefined;
    if (carried !== undefined && live === undefined) return this.record(fold, selection, input, budget);
    // The same materialized selection: a retry, a resume or an unchanged
    // state reuses the live frame — no row, no render, no Body call.
    if (live !== undefined && live.row.reuse_key === reuseKey) return { action: "none" };
    // Recorded but never appended (a crash between the two): present it as
    // recorded when it still says what the state says.
    if (latest && latest !== live && latest.row.reuse_key === reuseKey && latest.appended === undefined && latest.surface !== undefined
      && bodyIntact(this.log, latest)) {
      return { action: "present", frameId: latest.row.frame.id };
    }
    if (live !== undefined) {
      if (live.row.selection_digest === selection.selectionDigest && !live.row.frame.omitted.some((item) => item.group === "budget")) {
        return { action: "none" };
      }
      // Anything else replaces it, even with an empty selection: a frame of
      // another goal or repository is never left standing.
      return this.record(fold, selection, input, budget);
    }
    if (selection.items.length === 0) return { action: "none" };
    return this.record(fold, selection, input, budget);
  }

  private record(fold: ContextGraphFold, selection: FrameSelection, input: RequestContextInput,
    budget: { bytes: number; narrowed: boolean }, degraded: { guard: string } | null = null): RequestContextDecision {
    let nextId = fold.frameOrder.length + 1;
    while (fold.frames.has(`cf-${nextId}`)) nextId += 1;
    const built = buildFramePayload(fold, selection, { id: `cf-${nextId}`, budget, boundary: input.boundary,
      profile: input.profile, mode: this.mode, policy: this.policy, degraded, reader: input.readerAuthorised === true });
    return { action: "record", frameId: built.payload.frame.id, payload: built.payload as unknown as Record<string, unknown>, text: built.text, present: this.mode === "on" };
  }

  /** §132 F2': the full frame for this boundary was refused by `guard`: the
   * frame that replaces the previous one instead — no items, the reason
   * stated — so no stale frame stays live. */
  private refusedFrame(input: RequestContextInput, guard: string): RequestContextDecision {
    const fold = liveContextGraph(this.log);
    const selection = selectFrame(fold, this.policy, input.readerAuthorised === true);
    if (!selection || !fold.headRef) return { action: "none" };
    return this.record(fold, selection, input, frameBudget(this.policy, input), { guard });
  }

  degraded(reason: "frame_store_failed" | "frame_refused" | "projection_failed" | "optional_recall_unavailable" | "context_full", boundary: string, detail: string, guard: string | null = null): void {
    if (this.log.isReadOnly) return;
    this.log.append({ kind: "observe", name: CONTEXT_DEGRADED_ROW, payload: {
      schema: CONTEXT_GRAPH_SCHEMA, reason, guard: guard === null ? null : guard.slice(0, 64), boundary: boundary.slice(0, 32), detail: detail.slice(0, 240),
    } });
    this.refuseStaleBranchFrame(reason);
  }

  /** R8-03 hardening: a branch-context session fails CLOSED when a frame
   * replacement cannot be stored or applied. The observed degraded row is
   * kept first; then, if the transcript still carries a DELIVERED frame that
   * no longer says what the state says, the boundary throws instead of
   * letting a model request proceed on stale imported input. Sessions
   * without imported lessons keep the ordinary optional-context behavior. */
  private refuseStaleBranchFrame(reason: string): void {
    if (this.mode !== "on") return;
    let fold: ContextGraphFold;
    try {
      fold = liveContextGraph(this.log);
    } catch (error) {
      // Only a log that BEARS branch-context rows fails closed here; an
      // ordinary session keeps the optional-context behavior (the degraded
      // row above already recorded the failure either way).
      const bears = this.log.events.some(row => row.name === CONTEXT_BRANCH_IMPORT_ROW || row.name === CONTEXT_BRANCH_FIT_ROW);
      if (!bears) return;
      throw new BranchContextError(`the context graph refuses to fold after a ${reason} boundary (${error instanceof Error ? error.message.slice(0, 120) : "unknown"}); the request fails closed`);
    }
    if (fold.importedLessons.size === 0) return;
    const latest = latestFrame(fold, "on");
    if (latest === undefined) return;
    const stage = fold.frameStage(latest.row.frame.id);
    if (stage !== "appended" && stage !== "dispatched" && stage !== "responded") return;
    const selection = selectFrame(fold, this.policy, false);
    if (selection !== undefined && selection.selectionDigest === latest.row.selection_digest) return;
    throw new BranchContextError(`a ${reason} boundary would leave a stale live branch frame as the next model input; the request fails closed`);
  }
}

function invocationCitations(invocation: Invocation): string {
  const cite = (item: EventRef) => `${item.seq}:${item.hash}`;
  return `${invocation.key} ${invocation.tool} call ${cite(invocation.call)}: ${invocation.status}; ${invocation.mechanical}`
    + `; result ${invocation.result ? cite(invocation.result) : "pending or unavailable"} (${invocation.resultAvailability})`
    + `; end ${invocation.end ? cite(invocation.end) : "pending or unavailable"}${invocation.rowsPartial ? "; observations partial" : ""}`;
}

/** One formal Work execution with its exact citable references: the start
 * (a host action), its end and its verdict (the observation), and whether the
 * host judged that verdict. */
function formalCitations(fold: ContextGraphFold, execution: FormalExecution): string {
  const cite = (item: EventRef) => `${item.seq}:${item.hash}`;
  const verdict = execution.verdict === undefined ? undefined : fold.formalVerdicts.get(execution.verdict);
  const parts = [`${execution.key} formal Work execution start ${cite(execution.start)} (${execution.phase}; command sha256:${execution.commandDigest.slice(0, 12)})`,
    `end ${execution.ends.length === 1 ? cite(execution.ends[0]!) : execution.ends.length === 0 ? "pending or unavailable" : "not unique"}`];
  if (verdict === undefined) parts.push("no verdict yet");
  else {
    const judged = verdict.judged === "qualifying_red" ? "qualifying RED, judged by the host from the authenticated retained execution"
      : verdict.judged === "green" ? "GREEN, judged by the host from the authenticated retained execution"
        : verdict.judged === "pending_admission" ? `status ${verdict.status}, not yet a judged outcome (${verdict.reason})`
          : `status ${verdict.status}, not a judged outcome (${verdict.reason})`;
    parts.push(`case ${quote(verdict.caseId, 128)} verdict ${cite(verdict.ref)}: ${judged}`);
    if (verdict.resolvedBy !== undefined) parts.push(`a later authenticated GREEN of the same obligation at seq ${verdict.resolvedBy}`);
  }
  return parts.join("; ");
}

/** A schema-3 revision's scoped prediction, said as what it is. */
function formalObservableText(lesson: Lesson): string {
  const observable = lesson.observable;
  if (observable === null || !("kind" in observable)) return "";
  return `; observable: formal case ${quote(observable.caseId, 128)} qualifying RED at verdict seq ${observable.source.seq} (execution wx:${observable.executionStart.seq}); `
    + "a later authenticated same-obligation execution under unchanged declared conditions corroborates (RED again) or contests (GREEN) only this scoped prediction; the causal explanation remains the model's proposal";
}

function describeInvocation(invocation: Invocation): string {
  return invocationCitations(invocation)
    + `; observed rows ${invocation.rows.map((row) => row.seq).join(", ") || "none"}${invocation.rowsPartial ? " (partial)" : ""}`
    + `; receipts ${invocation.receipts.map((receipt) => `${receipt.name}@${receipt.ref.seq} exit ${receipt.exitCode} workspace ${receipt.image.slice(0, 12)}`).join(", ") || "none"}`
    + `; attempts ${[...invocation.attempts].join(", ")}${invocation.resolvedBy ? `; same action later ok (${invocation.resolvedBy})` : ""}`
    + (invocation.resultHead ? `; output head ${quote(invocation.resultHead, 400)}` : "");
}

function latestFrame(fold: ContextGraphFold, mode: "shadow" | "on"): FrameState | undefined {
  for (let index = fold.frameOrder.length - 1; index >= 0; index -= 1) {
    const frame = fold.frames.get(fold.frameOrder[index]!)!;
    if (isSelectionFrame(frame) && frame.row.mode === mode) return frame;
  }
  return undefined;
}

/** The recorded frame a transcript carries (the newest, when a malformed
 * transcript carries more). Only a message that IS a recorded surface's bytes
 * counts; a lookalike is ordinary text. */
function liveFrameIn(fold: ContextGraphFold, messages: readonly unknown[]): FrameState | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = contextFrameIdOf(messages[index]);
    if (id === undefined) continue;
    const frame = fold.frames.get(id);
    const text = messageText((messages[index] as { content?: unknown }).content);
    if (frame !== undefined && isSelectionFrame(frame) && frame.surface && text !== undefined && sha256(text) === frame.surface.digest) return frame;
  }
  return undefined;
}

/** Whether a frame's body is still in the store as recorded (§132 F2': a
 * live frame whose blob is gone is rebuilt at the next boundary, not refused
 * at every request). */
function bodyIntact(log: EventLog, frame: FrameState): boolean {
  try {
    const store = BlobStore.forSession(log.path);
    return store.has(frame.row.blob) && sha256(store.get(frame.row.blob)) === frame.row.blob;
  } catch {
    return false;
  }
}

/** The reuse key of a selection under a request's policy, budget, profile
 * and mode. */
export function reuseKeyOf(selection: FrameSelection, input: { policy: FramePolicy; profile: string; budget: number; mode: "shadow" | "on"; reader: boolean }): string {
  return sha256(canonicalJson({ goal: selection.goalId, repository: selection.repositoryId, policy: policyDigest(input.policy),
    profile: input.profile.slice(0, 32), budget: input.budget, selection: selection.selectionDigest, mode: input.mode, reader: input.reader }));
}

/** §132 V2: the whole `context/frame` row — every typed field — as a pure
 * function of the graph at its source head and the request's recorded
 * parameters. Recording and replay both call this; replay compares the whole
 * row, so any altered field fails at that row. */
export function buildFramePayload(fold: ContextGraphFold, selection: FrameSelection, input: {
  readonly id: string;
  readonly budget: { bytes: number; narrowed: boolean };
  readonly boundary: FrameRow["boundary"];
  readonly profile: string;
  readonly mode: "shadow" | "on";
  readonly policy: FramePolicy;
  readonly degraded: { guard: string } | null;
  readonly reader: boolean;
}): { payload: FrameRow; text: string } {
  const rendered = renderFrame(selection, {
    id: input.id,
    sourceSeq: fold.headRef!.seq,
    revision: fold.revision,
    budgetBytes: input.budget.bytes,
    narrowed: input.budget.narrowed,
    ...(input.degraded === null ? {} : { degraded: input.degraded }),
    request: { boundary: input.boundary, profile: input.profile.slice(0, 32), mode: input.mode, reader: input.reader },
    recoveryOf: (items) => frameRecovery(fold, items, input.reader),
  });
  const bytes = Buffer.byteLength(rendered.text);
  const blob = sha256(rendered.text);
  const scope = scopeKey(selection.repositoryId, selection.goalId);
  const openAttempt = (fold.attemptsByGoal.get(scope) ?? []).map((attemptId) => fold.attempts.get(attemptId)!)
    .reverse().find((item) => item.attempt.outcome === "open");
  const frame: ContextFrame = {
    schema: 1,
    id: input.id,
    sourceHead: fold.headRef!,
    contextGraphRev: fold.revision,
    projectionDigest: fold.digest,
    goalId: selection.goalId,
    attemptId: openAttempt ? openAttempt.attempt.id : null,
    policyDigest: policyDigest(input.policy),
    selected: rendered.effective.map((item) => ({ nodeId: item.nodeId.slice(0, 96), revision: item.revision.slice(0, 96), reason: item.reason })),
    omitted: rendered.omitted.slice(0, 16),
    body: { digest: blob, bytes },
    coverage: rendered.coverage,
    budget: { maxBytes: input.budget.bytes, actualBytes: bytes, estimatedTokens: "missing" },
  };
  const payload: FrameRow = {
    schema: CONTEXT_GRAPH_SCHEMA,
    frame,
    blob,
    blob_bytes: bytes,
    mode: input.mode,
    boundary: input.boundary,
    kind: "full",
    reuse_key: reuseKeyOf(selection, { policy: input.policy, profile: input.profile, budget: input.budget.bytes, mode: input.mode, reader: input.reader }),
    selection_digest: selection.selectionDigest,
    items: rendered.effective.map((item) => ({ key: item.key.slice(0, 96), line: lineDigest(item) })),
    recovery: frameRecovery(fold, rendered.effective, input.reader),
    profile: input.profile.slice(0, 32),
    reader: input.reader,
    degraded: input.degraded,
  };
  const parsed = frameRowSchema.safeParse(payload);
  if (!parsed.success) throw new ContextGraphSchemaError("a prepared frame does not fit its schema");
  return { payload: parsed.data, text: rendered.text };
}

/** Replay: re-derive every recorded frame from the log alone — the graph at
 * its source head and the row's recorded request parameters (id, boundary,
 * profile, mode, budget, degraded guard) — and compare the WHOLE row and the
 * exact bytes (§132 V2). No workspace, Wiki, DuckDB or model. `retained` is
 * where a fold of branch-context rows reads the retained source bundles; it
 * defaults to `readBlob`, the same owner-side body reader, so a session that
 * carries branch-context rows refuses to verify without one. */
export function verifyContextFrames(events: readonly EventRecord[], readBlob?: (digest: string) => string | undefined,
  retained?: RetainedBranchBodyReader): {
  frames: number;
  mismatches: string[];
} {
  const mismatches: string[] = [];
  const branchReader = retained ?? readBlob;
  const fold = projectContextGraph([], branchReader);
  let frames = 0;
  let contributionGeneration = false;
  for (const event of events) {
    if (event.name === "session/open" && sessionReplayFeatureGenerationIndex(event.payload.replay_features) !== undefined &&
        Array.isArray(event.payload.replay_features) && event.payload.replay_features.includes("host-context-frame-v1")) {
      contributionGeneration = true;
    }
    if (event.name !== CONTEXT_FRAME_ROW) continue;
    if (event.payload.schema !== CONTEXT_GRAPH_SCHEMA) {
      if (event.payload.schema === "host-context-frame-v1" && !contributionGeneration) {
        throw new ContextGraphSchemaError("a host contribution precedes its replay feature generation");
      }
      const row = contributionFrameOf(event, !contributionGeneration);
      const head = events[row.frame.sourceHead.seq - 1];
      if (!head || head.hash !== row.frame.sourceHead.hash || head.seq !== event.seq - 1 || row.frame.sourceHead.hash !== event.prev_hash) {
        mismatches.push(`${row.frame.id}: contribution source head does not resolve`);
      }
      if (readBlob === undefined) {
        mismatches.push(`${row.frame.id}: contribution body reader unavailable`);
      } else {
        const text = readBlob(row.blob);
        if (text === undefined || sha256(text) !== row.blob || Buffer.byteLength(text) !== row.blob_bytes ||
            contextFrameIdOf({ role: "user", content: text }) !== row.frame.id) {
          mismatches.push(`${row.frame.id}: contribution body is missing or differs`);
        }
      }
      continue;
    }
    frames += 1;
    const row = frameRowSchema.parse(event.payload);
    const head = row.frame.sourceHead;
    const at = events[head.seq - 1];
    if (!at || at.hash !== head.hash || head.seq >= event.seq) { mismatches.push(`${row.frame.id}: source head is not an earlier row`); continue; }
    fold.extend(events, head.seq);
    if (row.frame.policyDigest !== policyDigest(DEFAULT_FRAME_POLICY)) { mismatches.push(`${row.frame.id}: unknown policy`); continue; }
    const selection = selectFrame(fold, DEFAULT_FRAME_POLICY, row.reader);
    if (!selection) { mismatches.push(`${row.frame.id}: no selection at its source head`); continue; }
    const rebuilt = buildFramePayload(fold, selection, {
      id: row.frame.id,
      budget: { bytes: row.frame.budget.maxBytes, narrowed: row.frame.budget.maxBytes < DEFAULT_FRAME_POLICY.maxBytes },
      boundary: row.boundary,
      profile: row.profile,
      mode: row.mode,
      policy: DEFAULT_FRAME_POLICY,
      degraded: row.degraded,
      reader: row.reader,
    });
    if (canonicalJson(rebuilt.payload) !== canonicalJson(row)) {
      const fields = [...Object.keys(row.frame).filter((key) => canonicalJson((row.frame as Record<string, unknown>)[key]) !== canonicalJson((rebuilt.payload.frame as Record<string, unknown>)[key])).map((key) => `frame.${key}`),
        ...Object.keys(row).filter((key) => key !== "frame" && canonicalJson((row as Record<string, unknown>)[key]) !== canonicalJson((rebuilt.payload as Record<string, unknown>)[key]))];
      mismatches.push(`${row.frame.id}: row differs from its re-derivation (${fields.join(", ")})`);
    }
    if (readBlob) {
      const stored = readBlob(row.blob);
      if (stored === undefined) mismatches.push(`${row.frame.id}: frame body is missing`);
      else if (sha256(stored) !== row.blob) mismatches.push(`${row.frame.id}: stored body differs`);
    }
  }
  // The full fold must also succeed: a removed field or a downgrade fails here.
  projectContextGraph(events, branchReader);
  return { frames, mismatches };
}

/** §133 P3: the content digest of a workspace file now, or null when it is
 * not a readable regular file inside the root (a link out of it included). */
function fileDigest(root: string, path: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(realRoot, path));
    const rel = relative(realRoot, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return null;
    return createHash("sha256").update(readFileSync(real)).digest("hex");
  } catch {
    return null;
  }
}
