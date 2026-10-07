import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { EventRecord } from "../host/schema.ts";
import { authenticateEarnedExecutionBody, draftAdmissionEvidence, draftReference, EARNED_END, EARNED_START, executionFor } from "../work/evidence/earned.ts";
import { projectPlanDrafts } from "../work/evidence/obligations.ts";
import type { RetainedBranchBodyReader } from "./branch-context.ts";
import type { EventRef, FormalCaseObservable, Lesson } from "./types.ts";

/**
 * context-formal-work-v1 — genuine formal Work executions in the context
 * graph.
 *
 * A `work/execution_start` row the host's verifier minted is a host ACTION
 * (`wx:<seq>`, keyed by its own seq and hash, never a fabricated tool call);
 * the `work/case` verdict that names it is its OBSERVATION (`obs:wx:<seq>`).
 * Whether that verdict is a judged outcome is decided here, prefix-locally,
 * by the same canonical `executionFor` validator the Work verifier and replay
 * use, plus the retained execution bodies of its unique stable start and end:
 * only an authenticated qualifying RED or a valid GREEN is judged. A plan
 * declaration, a nonqualifying or refused RED, an unrunnable case, a missing
 * or altered body, a replaced case digest, an output's text or its exit code
 * alone is never one. A model draft's baseline RED is `pending_admission`
 * until its coupled admission row folds.
 *
 * Nothing here enters the older judged-run index: a schema-3 lesson's
 * formal-case observable is derived only from the cited failed execution,
 * and only a later authenticated execution of the SAME command, obligation
 * and case digest — started after the lesson revision, in the same
 * repository, goal and workspace, under its declared file conditions read
 * unchanged from that execution's own retained inventory — assesses it. The
 * outcome concerns the scoped prediction; a lesson's causal explanation
 * remains the model's proposal.
 */

export type FormalJudgement = "qualifying_red" | "green" | "pending_admission" | "not_judged";

/** One formal Work execution: the host action. */
export interface FormalExecution {
  readonly key: string;
  readonly start: EventRef;
  readonly command: string;
  readonly commandDigest: string;
  readonly obligationKey: string;
  readonly workspace: string;
  readonly phase: string;
  readonly goalId: string;
  readonly repositoryId: string;
  ends: EventRef[];
  /** The first verdict row naming this execution (a second is never judged). */
  verdict?: number;
}

/** One verdict row: the observation of a formal execution. */
export interface FormalVerdict {
  readonly ref: EventRef;
  readonly start: number;
  readonly caseId: string;
  readonly status: string;
  readonly commandDigest: string;
  readonly obligationKey: string;
  readonly caseDigest: string;
  readonly workspace: string;
  readonly goalId: string;
  readonly repositoryId: string;
  /** The model draft this baseline run belongs to (canonical reference). */
  readonly draft: string | undefined;
  judged: FormalJudgement;
  reason: string;
  /** The candidate files the execution read, from its retained inventory. */
  files: ReadonlyMap<string, string> | undefined;
  resolvedBy?: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function isFormalStart(event: EventRecord): boolean {
  return event.name === EARNED_START && event.kind === "observe";
}

export function isFormalEnd(event: EventRecord): boolean {
  return event.name === EARNED_END && event.kind === "observe" && typeof event.payload.execution_start === "number";
}

/** A verifier's case verdict row (never the statusless plan declaration). */
export function isFormalVerdict(event: EventRecord): boolean {
  return event.name === "work/case" && event.kind === "observe" && typeof event.payload.execution_start === "number"
    && typeof event.payload.status === "string";
}

/** The host-minted rows whose authority this generation records as
 * `host_observation`; the plan declaration stays a model statement. */
export function isFormalHostRow(event: EventRecord): boolean {
  return isFormalStart(event) || isFormalEnd(event) || isFormalVerdict(event);
}

/** Authenticate bytes first, then use the same body/identity validator as
 * canonical earned replay. No second interpretation of checker inputs or
 * workspace identity exists in the context graph. */
export function authenticateExecutionRow(event: EventRecord, read: RetainedBranchBodyReader | undefined): { files: ReadonlyMap<string, string> } | undefined {
  const { blob, blob_bytes } = event.payload;
  if (read === undefined || typeof blob !== "string" || typeof blob_bytes !== "number") return undefined;
  let text: string | undefined;
  try { text = read(blob); } catch { return undefined; }
  if (text === undefined || sha256(text) !== blob || Buffer.byteLength(text) !== blob_bytes) return undefined;
  try {
    const body = authenticateEarnedExecutionBody(event, new Map([[blob, JSON.parse(text) as unknown]]));
    if (canonicalJson(body) !== text) return undefined;
    const files = new Map<string, string>();
    for (const row of body.workspace_files) if (row.directory !== true && row.link === undefined) files.set(row.path, row.digest);
    return { files };
  } catch { return undefined; }
}

/** The prefix-local judgement of one verdict row. `prefix` ends at the row
 * (or, at a draft's admission, at the admission row). */
export function judgeVerdict(input: {
  readonly row: EventRecord;
  readonly prefix: readonly EventRecord[];
  readonly execution: FormalExecution | undefined;
  readonly declared: ReadonlyMap<string, { caseDigest: string; command: string }>;
  readonly read: RetainedBranchBodyReader | undefined;
}): { judged: FormalJudgement; reason: string; files?: ReadonlyMap<string, string> } {
  const { row, execution } = input;
  const p = row.payload;
  if (!execution || execution.start.hash !== p.execution_hash) return { judged: "not_judged", reason: "names no formal execution start of this generation" };
  if (execution.verdict !== undefined && execution.verdict !== row.seq) return { judged: "not_judged", reason: "a second verdict for one execution" };
  if (p.earned_refusal !== undefined || p.evidence_refusal !== undefined || p.unrunnable !== undefined) {
    return { judged: "not_judged", reason: "the execution was refused or unrunnable" };
  }
  const outcome = p.status === "red" ? (p.qualifying_red === true ? "qualifying_red" : undefined) : p.status === "green" ? "green" : undefined;
  if (outcome === undefined) return { judged: "not_judged", reason: p.status === "red" ? "the failure did not qualify" : "no judged case status" };
  if (execution.ends.length !== 1) return { judged: "not_judged", reason: "no unique execution end" };
  if (typeof p.case_digest !== "string" || typeof p.obligation_key !== "string" || p.obligation_key !== execution.obligationKey
    || p.command !== execution.command) return { judged: "not_judged", reason: "the verdict is not bound to its execution's obligation" };
  const drafted = p.draft_ref !== undefined;
  if (!drafted) {
    const declared = input.declared.get(String(p.id));
    if (!declared || declared.caseDigest !== p.case_digest || declared.command !== p.command) {
      return { judged: "not_judged", reason: "the case digest differs from the declared case" };
    }
  }
  const start = input.prefix[execution.start.seq - 1], end = input.prefix[execution.ends[0]!.seq - 1];
  if (!start || !end || end.payload.status !== "stable") return { judged: "not_judged", reason: "the execution end is not stable" };
  const startBody = authenticateExecutionRow(start, input.read), endBody = authenticateExecutionRow(end, input.read);
  if (!startBody || !endBody) return { judged: "not_judged", reason: "a retained execution body is unavailable or differs" };
  // The Work validator may refuse a malformed history by throwing; for the
  // graph that is a verdict it cannot judge, never a judged one.
  const validated = (preparingDraft: boolean) => {
    try { return executionFor(row, input.prefix, preparingDraft) !== undefined; } catch { return false; }
  };
  if (!validated(false)) {
    if (drafted && validated(true)) return { judged: "pending_admission", reason: "awaits its draft's coupled admission", files: startBody.files };
    return { judged: "not_judged", reason: "the earned execution validator refuses it" };
  }
  if (drafted && !draftAdmitted(row, input.prefix)) return { judged: "not_judged", reason: "the draft admission differs from its native executions" };
  return { judged: outcome, reason: outcome === "green" ? "authenticated GREEN" : "authenticated qualifying RED", files: startBody.files };
}

/** A draft's admission, re-derived from its native executions. */
function draftAdmitted(row: EventRecord, prefix: readonly EventRecord[]): boolean {
  try {
    const draft = projectPlanDrafts(prefix).find((value) => canonicalJson(draftReference(value)) === canonicalJson(row.payload.draft_ref));
    if (draft?.result?.payload.status !== "admitted") return false;
    const evidence = draftAdmissionEvidence(draft, prefix);
    return canonicalJson(evidence.case_refs) === canonicalJson(draft.result.payload.case_refs)
      && evidence.case_refs.some((item) => item.seq === row.seq && item.hash === row.hash);
  } catch {
    return false;
  }
}

/** The obligation a verdict assesses: same command, obligation, case digest,
 * case id and workspace. */
export function obligationOf(verdict: Pick<FormalVerdict, "caseId" | "commandDigest" | "obligationKey" | "caseDigest" | "workspace">): string {
  return canonicalJson([verdict.obligationKey, verdict.caseDigest, verdict.commandDigest, verdict.caseId, verdict.workspace]);
}

/** Schema 3: the formal-case observable of the newest authenticated
 * qualifying RED among the cited formal executions. */
export function formalObservableFrom(
  executions: ReadonlyMap<number, FormalExecution>, verdicts: ReadonlyMap<number, FormalVerdict>, actions: readonly EventRef[],
): FormalCaseObservable | null {
  let best: { verdict: FormalVerdict; execution: FormalExecution } | undefined;
  for (const action of actions) {
    const execution = executions.get(action.seq);
    if (!execution || execution.start.hash !== action.hash || execution.verdict === undefined) continue;
    const verdict = verdicts.get(execution.verdict)!;
    if (verdict.judged !== "qualifying_red") continue;
    if (!best || verdict.ref.seq > best.verdict.ref.seq) best = { verdict, execution };
  }
  if (!best) return null;
  return {
    kind: "formal_case", caseId: best.verdict.caseId, commandDigest: best.verdict.commandDigest, source: best.verdict.ref,
    executionStart: best.execution.start, obligationKey: best.verdict.obligationKey, caseDigest: best.verdict.caseDigest,
  };
}

/** Whether a later verdict assesses a schema-3 lesson revision, and how:
 * a judged execution of exactly the observable's obligation, started after
 * the revision, in the lesson's repository, goal and workspace, under its
 * declared complete file conditions read unchanged from that execution's own
 * retained inventory. Anything changed, unknown, incomplete, foreign or
 * older does not assess. */
export function formalAssessmentOf(
  executions: ReadonlyMap<number, FormalExecution>, revision: { readonly lesson: Lesson; readonly ref: EventRef }, verdict: FormalVerdict,
): "pass" | "fail" | undefined {
  const observable = revision.lesson.observable;
  if (observable === null || !("kind" in observable)) return undefined;
  if (verdict.judged !== "qualifying_red" && verdict.judged !== "green") return undefined;
  const execution = executions.get(verdict.start), source = executions.get(observable.executionStart.seq);
  if (!execution || !source || verdict.ref.seq <= revision.ref.seq || execution.start.seq <= revision.ref.seq) return undefined;
  if (verdict.commandDigest !== observable.commandDigest || verdict.obligationKey !== observable.obligationKey
    || verdict.caseDigest !== observable.caseDigest || verdict.caseId !== observable.caseId || verdict.workspace !== source.workspace) return undefined;
  const scope = revision.lesson.scope;
  if (scope.repositoryId !== verdict.repositoryId || scope.goalId === null || scope.goalId !== verdict.goalId) return undefined;
  if (scope.dependencyCoverage !== "declared" || scope.resources.length === 0 || verdict.files === undefined) return undefined;
  for (const resource of scope.resources) {
    if (resource.kind !== "file" || resource.coverage !== "exact" || resource.digest === null) return undefined;
    if (verdict.files.get(resource.resourceId.replace(/^\.\//u, "")) !== resource.digest) return undefined;
  }
  return verdict.judged === "green" ? "pass" : "fail";
}
