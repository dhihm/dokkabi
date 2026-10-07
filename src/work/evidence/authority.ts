import { experimentRuntime } from "../../plugins/experiment-runtime.ts";
import { barValuesOnly, projectExperimentCondition } from "../../eval/experiment/condition.ts";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventLog } from "../../host/event-log.ts";
import { currentSessionSchemaPayload, projectSessionReplaySchemas, type EventInput, type EventRecord } from "../../host/schema.ts";
import { matchingCaseRunner } from "../case-runners.ts";
import type { WorkPlan } from "../schema.ts";
import { validatePlan } from "../validate.ts";
import { recordedPrerequisiteIds } from "../prerequisites.ts";
import { AUTHORITY_EVENT, AUTHORITY_REFUSAL, PLAN_DRAFT, PLAN_DRAFT_RESULT, makeSnapshot, missingObligations, obligationErrors, orderScope, projectObligations, projectPlanDrafts, snapshotInput, validateAuthorityPatch, type AuthorityPatch, type ObligationSnapshot, type PlanDraft } from "./obligations.ts";
import { draftAdmissionEvidence } from "./earned.ts";
import { INITIAL_REGRESSION_POLICY } from "./obligations.ts";
import { workCaseDigest } from "../scope.ts";

export function captureRunnerContracts(plan: WorkPlan): Record<string, unknown> {
  return Object.fromEntries(plan.cases.map(item => {
    const runner = matchingCaseRunner(item.command);
    return [item.id, runner ? {
      id: runner.id, definition: runner.definition ?? null,
      matcher: String(runner.matches), file_resolver: String(runner.testFile),
      test_file: runner.testFile(item.command) ?? null,
      authorized_recipe: runner.authorizedRecipe ?? null,
      measurement_evaluator: runner.measurementEvaluator ?? null,
      speculation: runner.speculation ?? null,
      ...(runner.resultAdapter ? { result_adapter: { id: runner.resultAdapter.id, digest: runner.resultAdapter.digest } } : {}),
    } : null];
  }));
}

export class WorkAuthorityError extends Error {
  readonly code = "work_authority_refused";
}

export function assertPlanAuthority(log: EventLog, plan: WorkPlan): void {
  if (!log.isReadOnly) { log.refresh(); experimentRuntime(log); }
  const errors = obligationErrors(plan, log.events, captureRunnerContracts(plan));
  if (errors.length) throw new WorkAuthorityError(errors.join("; "));
}

/** A model may carry an existing guard, never grant itself a new first-pass role. */
export function modelGuardErrors(log: EventLog, plan: WorkPlan): string[] {
  const prior = projectObligations(log.events).current?.plan;
  const allowed = new Set(prior?.cases.filter(item => item.guard).map(item => workCaseDigest(item,
    prior.scenarios.find(scenario => scenario.id === item.scenario))) ?? []);
  return plan.cases.filter(item => item.guard && !allowed.has(workCaseDigest(item,
    plan.scenarios.find(scenario => scenario.id === item.scenario))))
    .map(item => `case ${item.id}: a model draft cannot grant a guard role without prior host authority`);
}

/** Called inside EventLog's existing cross-process append transaction. */
export function planAuthorityInputs(events: readonly EventRecord[], plan: WorkPlan, nextSeq: number): EventInput[] {
  const projected = projectObligations(events);
  const runners = captureRunnerContracts(plan);
  const errors = obligationErrors(plan, events, runners);
  if (errors.length) throw new WorkAuthorityError(errors.join("; "));
  const prior = projected.current;
  const scope = prior?.scope_seq ?? orderScope(events) ?? events[0]?.seq ?? nextSeq;
  if (!prior && projectPlanDrafts(events).some(draft => draft.snapshot.scope_seq === scope)) {
    throw new WorkAuthorityError("an initial plan draft requires native admission before binding");
  }
  if (!prior && projected.snapshots.length && !events.some(row => row.seq === scope && row.name === "work/goal" && row.payload.digest === "pending")) {
    throw new WorkAuthorityError("a replan cannot invent a new operator scope");
  }
  const activation: EventInput[] = projectSessionReplaySchemas(events).featureStart.has("work-replay-v1") ? []
    : [{ kind: "observe", name: "session/open", payload: currentSessionSchemaPayload() }];
  if (prior && canonicalJson(prior.plan) === canonicalJson(plan) && canonicalJson(prior.runners) === canonicalJson(runners)) return activation;
  const next = makeSnapshot(plan, runners, scope, prior);
  const condition = projectExperimentCondition(events);
  const change: EventInput[] = prior && condition.binding?.resolved.removed.includes("bar_pinning") && barValuesOnly(prior.plan, plan)
    ? [{ kind: "observe", name: "experiment/bar_change", payload: { binding_digest: condition.bindingDigest, previous_digest: prior.digest, next_digest: next.digest } }] : [];
  return [...activation, ...change, snapshotInput(next)];
}

export function retainPlanAuthority(log: EventLog, plan: WorkPlan): void {
  log.appendBatchDurable(nextSeq => planAuthorityInputs(log.events, plan, nextSeq));
}

/** Only the initial model proposal uses this lifecycle. Explicit plans and
 * already admitted obligations continue through the existing authority path. */
export function beginPlanDraft(log: EventLog, plan: WorkPlan, operatorOrder: string, resume = false): PlanDraft {
  let snapshot: ObligationSnapshot | undefined;
  const records = log.appendBatchDurable(nextSeq => {
    if (projectObligations(log.events).current) throw new WorkAuthorityError("an admitted plan cannot become a draft");
    const scope = orderScope(log.events) ?? log.events[0]?.seq ?? nextSeq;
    const order = log.events.find(event => event.seq === scope && event.name === "work/goal");
    if (order && order.payload.statement !== plan.goal.statement) throw new WorkAuthorityError("the draft does not match the current operator order");
    const previous = projectPlanDrafts(log.events).filter(draft => draft.snapshot.scope_seq === scope).at(-1);
    if (previous && previous.event.payload.operator_order !== operatorOrder) throw new WorkAuthorityError("the original operator order cannot change during draft repair");
    snapshot = makeSnapshot(plan, captureRunnerContracts(plan), scope);
    const activation: EventInput[] = projectSessionReplaySchemas(log.events).featureStart.has("work-earned-v1") ? []
      : [{ kind: "observe", name: "session/open", payload: currentSessionSchemaPayload() }];
    return [...activation, { ...snapshotInput(snapshot), name: PLAN_DRAFT,
      payload: { ...snapshotInput(snapshot).payload, operator_order: operatorOrder, resume,
        ...(!resume ? { supplemental_policy: INITIAL_REGRESSION_POLICY } : {}) } }];
  });
  return { event: records.at(-1)!, snapshot: snapshot! };
}

/** Native outcomes and the exact snapshot are committed under one log lock.
 * Another draft or operator action invalidates this admission, never its log. */
export function finishPlanDraft(log: EventLog, draft: PlanDraft, errors: readonly string[]): void {
  log.appendBatchDurable(() => {
    const drafts = projectPlanDrafts(log.events);
    const retained = drafts.find(value => value.event.seq === draft.event.seq && value.event.hash === draft.event.hash);
    if (!retained || retained.result) throw new WorkAuthorityError("plan draft already ended or is not retained");
    const payload = { draft_seq: draft.event.seq, draft_hash: draft.event.hash, errors: [...errors] };
    if (errors.length) return [{ kind: "observe", name: PLAN_DRAFT_RESULT, payload: { ...payload, status: "refused" } }];
    if (canonicalJson(draft.snapshot) !== canonicalJson(retained.snapshot)) {
      throw new WorkAuthorityError("plan draft caller handle differs from the retained draft");
    }
    if (drafts.at(-1) !== retained || projectObligations(log.events).current
      || (orderScope(log.events) ?? log.events[0]?.seq) !== retained.snapshot.scope_seq
      || canonicalJson(captureRunnerContracts(retained.snapshot.plan)) !== canonicalJson(retained.snapshot.runners)) {
      throw new WorkAuthorityError("plan draft changed or lost its operator scope during preparation");
    }
    const evidence = draftAdmissionEvidence(retained, log.events);
    return [{ kind: "observe", name: PLAN_DRAFT_RESULT, payload: { ...payload, status: "admitted", ...evidence } },
      snapshotInput(retained.snapshot)];
  });
}

export function recordAuthorityRefusal(log: EventLog, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  log.append({ kind: "observe", name: AUTHORITY_REFUSAL, payload: { reason } });
  return reason;
}

/** Build a reviewable exact patch for the operator's existing bars command. */
export function operatorPlanPatch(prior: ObligationSnapshot, replacement: WorkPlan, reason: string): AuthorityPatch {
  const next = makeSnapshot(replacement, captureRunnerContracts(replacement), prior.scope_seq, prior);
  return { schema_version: 1, expected_digest: prior.digest, expected_revision: prior.revision, reason,
    replacement_plan: JSON.parse(canonicalJson(replacement)) as WorkPlan,
    replacement_runners: next.runners,
    retirements: missingObligations(prior.obligations, next.obligations).map(item => ({ kind: item.kind, alias: item.alias,
      replacement_aliases: next.obligations.filter(value => value.kind === item.kind && value.alias === item.alias).map(value => value.alias) })) };
}

/** Host control-plane entry point. A sandboxed candidate cannot append to the
 * protected session log. Validation and consumption share the log's one lock. */
export function commitOperatorPlanPatch(log: EventLog, patch: AuthorityPatch, extraEffects: readonly EventInput[] = []): ObligationSnapshot {
  let accepted: ObligationSnapshot | undefined;
  const frozen = JSON.parse(canonicalJson(patch)) as AuthorityPatch;
  log.appendBatchDurable(() => {
    const errors = validatePlan(frozen.replacement_plan, { authenticatedExternalPrerequisiteIds: recordedPrerequisiteIds(frozen.replacement_plan, log.events) });
    if (errors.length) throw new WorkAuthorityError(errors.join("; "));
    const prior = projectObligations(log.events).current;
    if (!prior) throw new WorkAuthorityError("operator patch requires a bound obligation contract");
    const next = makeSnapshot(frozen.replacement_plan, captureRunnerContracts(frozen.replacement_plan), prior.scope_seq, prior);
    validateAuthorityPatch(prior, next, frozen);
    accepted = next;
    return [
      { kind: "effect", name: AUTHORITY_EVENT, payload: { schema_version: 1, source: "operator", patch_json: canonicalJson(frozen), result_digest: next.digest, reason: frozen.reason } },
      snapshotInput(next), ...extraEffects,
    ];
  });
  if (!accepted) throw new WorkAuthorityError("operator patch did not commit");
  return accepted;
}

/** Recover the last committed operator plan before accepting another proposal.
 * A failed file write never rolls back or invents the durable authority. */
export function materializeOperatorPlan(log: EventLog, planPath: string): boolean {
  const records = log.appendBatchDurable(() => {
    const projected = projectObligations(log.events);
    const current = projected.current;
    if (!current) return [];
    const scopeSnapshots = projected.snapshots.filter(row => row.value.scope_seq === current.scope_seq);
    const digests = new Set(scopeSnapshots.map(row => row.value.digest));
    const patch = [...log.events].reverse().find(row => row.name === AUTHORITY_EVENT && digests.has(String(row.payload.result_digest)));
    const materializedHere = (row: EventRecord) => row.name === "work/authority_materialized" && row.payload.plan_path === resolve(planPath);
    if (!patch || log.events.some(row => materializedHere(row) && row.payload.patch_digest === patch.payload.result_digest && row.seq > patch.seq)) return [];
    // Several durably accepted patches can precede one recovery. A disk image
    // from their retained ancestry is valid; an unrelated proposal is not.
    const lastAck = [...log.events].reverse().find(row => materializedHere(row) && row.seq < patch.seq);
    const pending = scopeSnapshots.filter(row => lastAck === undefined || row.seq > lastAck.seq);
    const firstPending = pending.find(row => log.events.some(event => event.name === AUTHORITY_EVENT && event.payload.result_digest === row.value.digest));
    const parent = scopeSnapshots.find(row => row.value.digest === firstPending?.value.parent_digest);
    const accepted = [current.plan, ...pending.map(row => row.value.plan), ...(parent ? [parent.value.plan] : [])].map(canonicalJson);
    if (existsSync(planPath) && !accepted.includes(canonicalJson(JSON.parse(readFileSync(planPath, "utf8"))))) {
      throw new WorkAuthorityError("committed operator patch has an unrelated uncommitted plan; preserve it before recovery");
    }
    const temporary = `${planPath}.${randomUUID()}.tmp`;
    try {
      const file = openSync(temporary, "wx", 0o600);
      try { writeFileSync(file, canonicalJson(current.plan) + "\n"); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, planPath);
      const directory = openSync(dirname(planPath), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { rmSync(temporary, { force: true }); }
    return [{ kind: "observe", name: "work/authority_materialized", payload: { digest: current.digest,
      patch_digest: patch.payload.result_digest, plan_path: resolve(planPath), revision: current.revision } }];
  });
  return records.length > 0;
}
