import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventLog } from "../../host/event-log.ts";
import type { EventRecord, EventInput } from "../../host/schema.ts";
import { canonicalJson } from "../../host/canonical.ts";
import { createPolicy, disposeSandboxPolicy, type SandboxPolicy } from "../../host/sandbox.ts";
import { projectExperimentCondition } from "../../eval/experiment/condition.ts";
import { bindPlan } from "../log.ts";
import { viewPlan } from "../view.ts";
import { parseAcceptDecision } from "../prompt.ts";
import { applyOperatorGoal } from "../graph.ts";
import type { WorkPlan } from "../schema.ts";
import { projectObligations } from "./obligations.ts";
import { readFixtureEnrollment } from "./fixture-manifest.ts";
import { EARNED_CURRENT, captureCurrentCase, observeCurrentCase, validateCurrentCase } from "./earned.ts";

const reference = (row: EventRecord) => ({ seq: row.seq, hash: row.hash });
const matches = (row: EventRecord, ref: unknown) => canonicalJson(reference(row)) === canonicalJson(ref);

/** Ordinary deployment evidence is explicitly selected by the host catalogue.
 * An enrolled evaluator or research condition cannot silently downgrade to it. */
export function enrollWorkReview(log: EventLog, workspace: string, order: string, plan: WorkPlan): void {
  if (projectExperimentCondition(log.events).binding || readFixtureEnrollment(log, workspace)
    || existsSync(join(workspace, ".swe-test.patch"))) throw new Error("explicit_acceptance_catalog_required");
  if (applyOperatorGoal(plan, order).goal.statement !== plan.goal.statement) throw new Error("acceptance_order_mismatch");
  bindPlan(log, plan);
  const prior = workReviewPolicy(log.events, workspace, order);
  if (prior) return;
  log.append({ kind: "observe", name: "acceptance/work_policy", payload: {
    schema_version: 1, mode: "workspace_cases_and_review", evidence_level: "workspace_reported",
    workspace: resolve(workspace), order, scope_digest: projectObligations(log.events).current!.digest,
  } });
}

export function workReviewPolicy(events: readonly EventRecord[], workspace: string, order: string): EventRecord | undefined {
  if (projectExperimentCondition(events).binding) return undefined;
  return [...events].reverse().find(row => row.kind === "observe" && row.name === "acceptance/work_policy"
    && row.payload.schema_version === 1 && row.payload.mode === "workspace_cases_and_review"
    && row.payload.evidence_level === "workspace_reported" && row.payload.workspace === resolve(workspace) && row.payload.order === order);
}

export type WorkReviewEvidence = { scope: string; cases: { id: string; current?: { seq: number; hash: string }; receipt: unknown }[] };

/** Startup can reuse only an original, qualifying, still-current local baseline.
 * Mixed, managed, measured, remote, resumed and changed inputs use normal verify. */
export function reuseOriginalBaselines(log: EventLog, cwd: string, plan: WorkPlan): boolean {
  if (!plan.cases.length || projectExperimentCondition(log.events).binding || readFixtureEnrollment(log, cwd)
    || plan.cases.some(item => item.host || item.local_accelerator || item.measurement)
    || Object.values(viewPlan(plan, log.events).caseStatus).filter(status => status === "red").length !== plan.cases.length) return false;
  const policy = createPolicy({ mode: "workspace-write", workspaceRoot: cwd, log, toolCache: "judged" });
  try {
    for (const item of plan.cases) {
      const row = observeCurrentCase({ log, cwd, plan }, item, policy, "red");
      if (!row.payload.current || row.payload.phase !== "baseline") return false;
    }
    log.append({ kind: "observe", name: "work/verify", payload: { phase: "reused_baseline", cases: plan.cases.length } });
    return true;
  } catch { return false; }
  finally { disposeSandboxPolicy(policy); }
}

export function captureWorkReviewEvidence(log: EventLog, cwd: string, order: string,
  transaction?: { policy: SandboxPolicy; pending: EventInput[] }): WorkReviewEvidence {
  if (!workReviewPolicy(log.events, cwd, order) || readFixtureEnrollment(log, cwd)) throw new Error("ordinary_review_not_authorized");
  const scope = projectObligations(log.events).current;
  if (!scope || applyOperatorGoal(scope.plan, order).goal.statement !== scope.plan.goal.statement) throw new Error("ordinary_review_order_changed");
  const view = viewPlan(scope.plan, log.events);
  if (!scope.plan.cases.length || !scope.plan.todos.length || !scope.plan.scenarios.length || view.errors.length
    || scope.plan.todos.some(todo => view.todoState[todo.id] !== "clear")
    || scope.plan.cases.some(item => view.caseStatus[item.id] !== "green")) throw new Error("ordinary_review_work_not_complete");
  const policy = transaction?.policy ?? createPolicy({ mode: "workspace-write", workspaceRoot: cwd, log, toolCache: "judged" });
  try {
    const cases = scope.plan.cases.map(item => {
      const observation = captureCurrentCase({ log, plan: scope.plan, cwd }, item, policy, "green");
      const row = transaction ? undefined : log.append(observation);
      if (transaction) transaction.pending.push(observation);
      if (observation.payload!.current !== true) throw new Error("ordinary_review_execution_inputs_changed");
      return { id: item.id, ...(row ? { current: reference(row) } : {}), receipt: observation.payload!.receipt_ref };
    });
    return { scope: scope.digest, cases };
  } finally { if (!transaction) disposeSandboxPolicy(policy); }
}

/** References change on each acquisition; their authenticated case receipts and
 * obligation scope must remain identical throughout review and publication. */
export function sameWorkReviewEvidence(before: WorkReviewEvidence, after: WorkReviewEvidence): boolean {
  const identity = (evidence: WorkReviewEvidence) => ({ scope: evidence.scope,
    cases: evidence.cases.map(({ current: _current, ...item }) => item) });
  return canonicalJson(identity(before)) === canonicalJson(identity(after));
}

/** Terminal/replay validation uses retained observations, never the live disk or
 * a model's bare DONE. Input manifest hashes are checked by projectEarnedInputs. */
export function workReviewDeliveryValid(events: readonly EventRecord[], delivery: EventRecord): boolean {
  const p = delivery.payload, evidence = p.work_evidence as WorkReviewEvidence | undefined;
  const scope = projectObligations(events).current;
  if (delivery.kind !== "observe" || p.mode !== "workspace_cases_and_review" || !evidence || !scope
    || p.verdict_incomplete === true
    || (p.tool_budget_exhausted === true || p.turn_budget_exhausted === true) && p.verdict_turn !== true
    || p.verdict_turn === true && p.confirmation_complete !== true
    || evidence.scope !== scope.digest || !Array.isArray(evidence.cases) || !evidence.cases.length
    || !["verifier_digest", "verifier_log_hash"].every(key => /^[a-f0-9]{64}$/u.test(String(p[key])))
    || typeof p.review !== "string" || parseAcceptDecision(p.review).kind !== "done" || typeof p.order !== "string"
    || applyOperatorGoal(scope.plan, p.order).goal.statement !== scope.plan.goal.statement
    || !workReviewPolicy(events.filter(row => row.seq < delivery.seq), String(p.workspace), p.order)) return false;
  const view = viewPlan(scope.plan, events);
  if (view.errors.length || scope.plan.todos.some(todo => view.todoState[todo.id] !== "clear")
    || canonicalJson(evidence.cases.map(item => item.id).sort()) !== canonicalJson(scope.plan.cases.map(item => item.id).sort())) return false;
  return evidence.cases.every(item => {
    const original = events.find(row => row.seq < delivery.seq && matches(row, item.current));
    const latest = [...events].reverse().find(row => row.name === EARNED_CURRENT && row.payload.case_id === item.id);
    return original !== undefined && latest !== undefined && original.payload.expected === "green" && latest.payload.expected === "green"
      && matches(original, item.current) && canonicalJson(original.payload.receipt_ref) === canonicalJson(item.receipt)
      && canonicalJson(latest.payload.receipt_ref) === canonicalJson(item.receipt)
      && validateCurrentCase(original, events) && validateCurrentCase(latest, events);
  });
}
