import { deriveAcceptanceCurrent, type AcceptanceCurrentObservation } from "./acceptance-replay.ts";
import { projectObligations } from "./obligations.ts";
import { readAcceptanceContract } from "./acceptance-contract.ts";
import { readFixtureEnrollment } from "./fixture-manifest.ts";
import { currentSessionSchemaPayload, projectSessionReplaySchemas, type EventInput } from "../../host/schema.ts";
import type { EventLog } from "../../host/event-log.ts";
import type { EvaluationRun } from "../../loader/types.ts";
import { createPolicy, disposeSandboxPolicy, type SandboxExecutionResult, type SandboxPolicy } from "../../host/sandbox.ts";
import { evidenceDigest } from "./contract.ts";
import { projectEvidence } from "./projection.ts";
import { readEvidenceBodies } from "./bodies.ts";
import { resultSchema } from "./schema.ts";
import { recordFixtureBody } from "./fixture-manifest.ts";
import { assertPreparedFixture, type PreparedFixture } from "./fixture-prepare.ts";
import { acceptanceCandidate, assertAcceptanceContract, completeAcceptanceSpec, type AcceptanceContract, type AcceptanceTemplate } from "./acceptance-contract.ts";
import { deriveAcceptanceDecision, deriveAcceptanceProbe, type AcceptanceProbeFact } from "./acceptance-decision.ts";
import { captureWorkReviewEvidence, sameWorkReviewEvidence, type WorkReviewEvidence } from "./work-review.ts";

export interface AcceptanceProbeExecutor {
  execute(input: {
    prepared: PreparedFixture; template: AcceptanceTemplate; checkId: string;
    candidate: unknown; contract: unknown; timeoutMs: number;
  }): Promise<{ evaluation: EvaluationRun; process: SandboxExecutionResult }>;
}
declare const executionBrand: unique symbol;
export interface AcceptanceExecution { readonly [executionBrand]: true }
interface State {
  parentLog: EventLog; log: EventLog; prepared: PreparedFixture; contract: AcceptanceContract;
  executor?: AcceptanceProbeExecutor; specification: string; specificationDigest: string;
  candidate: { delivered: string; evaluated: string; fixture_digest: string };
  candidateDigest: string; contractDigest: string; facts: AcceptanceProbeFact[];
  started: boolean; calls: number; deadline: number; snapshotClosed: boolean;
}
const executions = new WeakMap<AcceptanceExecution, State>();
const deliveries = new WeakMap<object, () => boolean>();
type WorkDelivery = { log: EventLog; cwd: string; order: string; evidence: WorkReviewEvidence };
const workDeliveries = new WeakMap<object, WorkDelivery>();
const state = (value: AcceptanceExecution): State => {
  const found = executions.get(value); if (!found) throw new Error("acceptance_execution_not_host_issued"); return found;
};
function current(value: State, checkSnapshot: boolean): boolean {
  try {
    assertAcceptanceContract(value.parentLog, value.contract, value.contract.order);
    const excluded = value.prepared.manifest.excluded_candidate_roots;
    if (acceptanceCandidate(value.parentLog, value.contract.workspace, excluded).digest !== value.candidate.delivered) return false;
    if (checkSnapshot) {
      assertPreparedFixture(value.prepared);
      if (acceptanceCandidate(value.log, value.prepared.root).digest !== value.candidate.evaluated) return false;
    }
    return true;
  } catch { return false; }
}

export function beginAcceptanceExecution(input: {
  parentLog: EventLog; log: EventLog; prepared: PreparedFixture; contract: AcceptanceContract;
  specification: string; executor?: AcceptanceProbeExecutor;
  expectedCandidate: { delivered: string; evaluated: string };
}): AcceptanceExecution {
  assertPreparedFixture(input.prepared); assertAcceptanceContract(input.parentLog, input.contract, input.contract.order);
  if (input.prepared.receipt.fixture_digest !== input.contract.fixture_digest) throw new Error("acceptance_fixture_mismatch");
  const delivered = acceptanceCandidate(input.parentLog, input.contract.workspace, input.prepared.manifest.excluded_candidate_roots);
  const evaluated = acceptanceCandidate(input.log, input.prepared.root);
  if (delivered.digest !== input.expectedCandidate.delivered || evaluated.digest !== input.expectedCandidate.evaluated) throw new Error("acceptance_candidate_changed_before_execution");
  const candidate = { delivered: delivered.digest, evaluated: evaluated.digest, fixture_digest: input.contract.fixture_digest };
  if (!projectSessionReplaySchemas(input.log.events).featureStart.has("work-replay-v1")) input.log.appendDurable({ kind: "observe", name: "session/open", payload: currentSessionSchemaPayload() });
  recordFixtureBody(input.log, "acceptance/candidate", { candidate, delivered: delivered.body, evaluated: evaluated.body });
  const contractDigest = evidenceDigest(input.contract);
  const specificationDigest = recordFixtureBody(input.log, "acceptance/specification", { contract: input.contract, review: input.specification });
  const token = Object.freeze({}) as AcceptanceExecution;
  executions.set(token, { ...input, candidate, candidateDigest: evidenceDigest(candidate), contractDigest,
    specificationDigest, facts: [], started: false, calls: 0, deadline: 0, snapshotClosed: false });
  return token;
}

export async function executeAcceptanceChecks(execution: AcceptanceExecution, options: { completeSet?: boolean } = {}): Promise<{ calls: number; remainingMs: number; summary: string; unavailableReason?: string }> {
  const value = state(execution);
  if (value.started) throw new Error("acceptance_execution_already_used");
  value.started = true; value.deadline = performance.now() + 1800000;
  if (completeAcceptanceSpec(value.specification, value.contract) && value.executor) {
    for (const check of value.contract.required_checks) {
      if (performance.now() >= value.deadline || !current(value, true)) break;
      const template = value.contract.templates.find(item => item.id === check.template_id)!;
      const timeoutMs = Math.min(template.timeout_ms, Math.floor(value.deadline - performance.now()));
      if (timeoutMs < 1) break;
      value.calls++;
      const result = await value.executor.execute({ prepared: value.prepared, template, checkId: check.id,
        candidate: value.candidate, contract: { contract: value.contract, specification_digest: value.specificationDigest }, timeoutMs });
      if (result.evaluation.status !== "completed") continue;
      const { receipt } = result.evaluation;
      // The enrolled evaluator checks the native result; neither generic tool
      // output nor a caller-provided accepted flag can create this receipt.
      if (receipt.candidate_digest !== value.candidateDigest || receipt.contract_digest !== evidenceDigest({ contract: value.contract, specification_digest: value.specificationDigest }) ||
        result.evaluation.input.context.authority.role !== "acceptance_checker") throw new Error("acceptance_receipt_binding_mismatch");
      const bodies = readEvidenceBodies(value.log), authenticated = projectEvidence(value.log.events, bodies);
      const index = authenticated.inputs.findIndex(input => input.receipt.receipt_id === receipt.receipt_id);
      const stored = resultSchema.safeParse(bodies.get(receipt.body.blob));
      const output = stored.success && stored.data.output && typeof stored.data.output === "object" && !Array.isArray(stored.data.output)
        ? stored.data.output as Record<string, unknown> : undefined;
      const native = value.log.events.filter(event => event.name === "acceptance/process").flatMap(event => {
        const body = typeof event.payload.blob === "string" ? bodies.get(event.payload.blob) as Record<string, unknown> | undefined : undefined;
        return body?.execution_id === receipt.execution_id ? [body] : [];
      });
      if (index < 0 || evidenceDigest(authenticated.inputs[index]) !== evidenceDigest(result.evaluation.input) ||
        evidenceDigest(authenticated.decisions[index]) !== evidenceDigest(result.evaluation.decision) ||
        result.evaluation.decision.reason_codes.some(reason => reason !== "execution_not_passed") ||
        !output || evidenceDigest(output.template) !== evidenceDigest(template) || native.length !== 1 ||
        native[0]!.check_id !== check.id || evidenceDigest(native[0]!.process) !== evidenceDigest(output.process)) {
        value.log.append({ kind: "observe", name: "acceptance/receipt_refused", payload: { check_id: check.id, reason: "returned_evidence_does_not_match_authenticated_execution" } });
        break;
      }
      // Consume the process body authenticated by the logged receipt, not the
      // executor's returned process object or its declared success flag.
      const process = output.process as SandboxExecutionResult;
      if (deriveAcceptanceProbe(template, process) === "passed" && result.evaluation.decision.status !== "admissible") break;
      value.facts.push({ check_id: check.id, contract_digest: value.contractDigest,
        specification_digest: value.specificationDigest, candidate_digest: value.candidateDigest,
        template, process, execution_id: receipt.execution_id, receipt_digest: evidenceDigest(receipt) });
      const outcome = deriveAcceptanceProbe(template, process);
      if (outcome === "unavailable" || (outcome === "failed" && !options.completeSet)) break;
    }
  }
  const decision = finishAcceptanceExecution(execution);
  return { calls: value.calls, remainingMs: Math.max(0, Math.floor(value.deadline - performance.now())),
    ...(!value.executor ? { unavailableReason: "acceptance_executor_missing" }
      : !completeAcceptanceSpec(value.specification, value.contract) ? { unavailableReason: "required_specification_incomplete" }
      : options.completeSet && (value.facts.length !== value.contract.required_checks.length || value.facts.some(fact => deriveAcceptanceProbe(fact.template, fact.process) === "unavailable"))
        ? { unavailableReason: "required_execution_incomplete" } : {}),
    summary: JSON.stringify({ ...decision, executed_checks: value.facts.map(fact => ({ id: fact.check_id, process: fact.process })) }) };
}

export function finishAcceptanceExecution(execution: AcceptanceExecution) {
  const value = state(execution);
  let observed: AcceptanceCurrentObservation;
  try {
    const contract = readAcceptanceContract(value.parentLog, value.contract.workspace);
    const authority = projectObligations(value.parentLog.events).current;
    const fixture = readFixtureEnrollment(value.parentLog, value.contract.workspace);
    if (!contract || !authority || !fixture) throw new Error("acceptance_current_authority_missing");
    if (!value.snapshotClosed) assertPreparedFixture(value.prepared);
    observed = { status: "observed", contract, authority, fixture_digest: fixture.digest,
      delivered: acceptanceCandidate(value.parentLog, value.contract.workspace, value.prepared.manifest.excluded_candidate_roots).body,
      evaluated: value.snapshotClosed ? null : acceptanceCandidate(value.log, value.prepared.root).body, snapshot_closed: value.snapshotClosed };
  } catch {
    observed = { status: "unavailable", reason: "acceptance_current_observation_unavailable" };
  }
  const currentRef = recordFixtureBody(value.log, "acceptance/current", observed);
  const facts = { required_ids: value.contract.required_checks.map(check => check.id), contract_digest: value.contractDigest,
    contract: value.contract, specification: value.specification,
    specification_digest: value.specificationDigest, candidate_digest: value.candidateDigest,
    facts: value.facts, specification_complete: completeAcceptanceSpec(value.specification, value.contract), candidate_current: deriveAcceptanceCurrent(observed, value.contract, value.candidate) };
  const decision = deriveAcceptanceDecision(facts);
  recordFixtureBody(value.log, "acceptance/decision", { facts, decision, current_ref: currentRef }, { replay_schema: 1, status: decision.status, reason: decision.reason });
  return decision;
}

/** Called after session disposers and immediately before snapshot deletion. */
export function closeAcceptanceSnapshot(execution: AcceptanceExecution): void {
  const value = state(execution);
  if (!current(value, true)) throw new Error("acceptance_candidate_or_contract_changed");
  value.snapshotClosed = true;
}
export function bindAcceptanceDelivery(verdict: object, execution: AcceptanceExecution): void {
  const value = state(execution);
  deliveries.set(verdict, () => current(value, false));
}
function currentWorkDelivery(input: WorkDelivery, transaction?: { policy: SandboxPolicy; pending: EventInput[] }): boolean {
  const observe = (event: EventInput) => transaction ? transaction.pending.push(event) : input.log.append(event);
    try {
      const observed = captureWorkReviewEvidence(input.log, input.cwd, input.order, transaction);
      const current = sameWorkReviewEvidence(input.evidence, observed);
      if (!current) observe({ kind: "observe", name: "acceptance/work_refused", payload: {
        reason: "work_review_receipt_or_scope_changed", expected: input.evidence, observed,
      } });
      return current;
    } catch (error) {
      observe({ kind: "observe", name: "acceptance/work_refused", payload: {
        reason: "work_review_inputs_unavailable", detail: error instanceof Error ? error.message : String(error),
      } });
      return false;
    }
}
export function bindWorkReviewDelivery(verdict: object, input: WorkDelivery): void {
  workDeliveries.set(verdict, input);
  deliveries.set(verdict, () => currentWorkDelivery(input));
}

/** Prepare any sandbox attestation outside the terminal lock; capture current
 * input bytes and append their observations inside that lock's single batch. */
export function prepareAcceptanceDeliveryCheck(verdict: object | undefined): {
  current(pending: EventInput[]): boolean; close(): void;
} {
  const work = verdict && workDeliveries.get(verdict);
  if (!work) return { current: () => verdict !== undefined && acceptanceDeliveryCurrent(verdict), close() {} };
  const policy = createPolicy({ mode: "workspace-write", workspaceRoot: work.cwd, log: work.log, toolCache: "judged" });
  return { current: pending => currentWorkDelivery(work, { policy, pending }), close: () => disposeSandboxPolicy(policy) };
}
/** The actual CLI calls this at its terminal append boundary, not just after a
 * model turn. A structurally forged verdict object has no delivery authority. */
export function acceptanceDeliveryCurrent(verdict: object): boolean { return deliveries.get(verdict)?.() === true; }
