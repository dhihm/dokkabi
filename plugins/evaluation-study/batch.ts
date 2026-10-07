import { randomBytes, randomUUID } from "node:crypto";
import type { EventLog } from "../../src/host/event-log.ts";
import { BlobStore } from "../../src/host/blob-store.ts";
import { canonicalJson } from "../../src/host/canonical.ts";
import { appendSandboxExecutionEvent, createPolicy, disposeSandboxPolicy, effectiveSandboxChildEnvironment, spawnPreparedSandbox, type SandboxPolicy } from "../../src/host/sandbox.ts";
import { assertPreparedFixtureEnvironment } from "../../src/work/evidence/fixture-prepare.ts";
import { fixtureHash } from "../../src/work/evidence/fixture-manifest.ts";
import { caseMeasurementSchema, measurementContractBody, workMeasurementRefSchema, challengeStdin, deriveMeasurement, measurementBoundarySchema, measurementChallengeSchema, measurementProcessSchema, measurementResultSchema, measurementSessionSchema, type CaseMeasurement, type WorkMeasurementRefV1 } from "../../src/work/evidence/measurements.ts";
import type { EvaluationContextV2, EvaluationDispatchV2, EvaluationRequestV2, EvaluationResultV2 } from "../../src/work/evidence/schema.ts";
import { BatchObservationError, prepareNativeBatch } from "./native.ts";

export { BatchObservationError } from "./native.ts";
type ArtifactRef = { kind: string; digest: string; blob: string; blobBytes: number };
export interface PreparedBatchCase {
  readonly candidateRef: { path: string; digest: string };
  readonly contractRef: { path: string; digest: string };
  evaluate(request: EvaluationRequestV2 & { dispatch: EvaluationDispatchV2 }, context: EvaluationContextV2): Promise<EvaluationResultV2>;
  close(): void;
}

function retain(log: EventLog, name: string, kind: string, body: unknown, binding: Record<string, unknown>): ArtifactRef {
  const text = canonicalJson(body);
  const digest = fixtureHash(text);
  BlobStore.forSession(log.path).putAndAppend(log, { kind: "observe", name, payload: { ...binding, artifact: kind, digest } }, text);
  return { kind, digest, blob: digest, blobBytes: Buffer.byteLength(text) };
}
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** A single host-owned callback consumes one fresh managed candidate snapshot. */
export function prepareBatchCase(input: {
  log: EventLog; workspaceRoot: string; candidatePath: string; caseId: string;
  contract: CaseMeasurement; phase: string; workRef: WorkMeasurementRefV1; timeoutMs?: number;
}): PreparedBatchCase {
  const contract = caseMeasurementSchema.parse(input.contract);
  const workRef = workMeasurementRefSchema.parse(input.workRef);
  const caseId = input.caseId;
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new BatchObservationError("unavailable", "observer_timeout_unavailable");
  const native = prepareNativeBatch({ ...input, caseId, contract: measurementContractBody(contract, workRef) });
  let consumed = false; let closed = false;
  return Object.freeze({
    candidateRef: native.candidateRef, contractRef: native.contractRef,
    async evaluate(request: EvaluationRequestV2 & { dispatch: EvaluationDispatchV2 }, context: EvaluationContextV2): Promise<EvaluationResultV2> {
      if (closed || consumed) throw new BatchObservationError("evaluator_error", "observer_invocation_consumed");
      consumed = true;
      const dispatch = request.dispatch;
      const sessionId = `measure-${randomUUID()}`;
      const binding = { session_id: sessionId, execution_id: dispatch.execution_id };
      let policy: SandboxPolicy | undefined;
      try {
        if (request.contract_ref !== native.contractRef.digest || dispatch.contract_ref !== native.contractRef.digest
          || request.input_ref !== context.context_ref.digest || dispatch.input_ref !== context.context_ref.digest
          || context.candidate_ref.path !== native.candidateRef.path || context.candidate_ref.digest !== native.candidateRef.digest
          || context.contract_ref.path !== native.contractRef.path || context.contract_ref.digest !== native.contractRef.digest) {
          throw new BatchObservationError("evaluator_error", "observer_context_mismatch");
        }
        native.assertIntegrity();
        try { policy = createPolicy({ mode: "workspace-write", workspaceRoot: native.fixture.root, observerIsolation: true, log: input.log }); }
        catch (error) { throw new BatchObservationError("unavailable", "observer_isolation_unavailable", error); }
        if (policy.observerIsolation !== "protected-observer-v1" || !policy.networkDenied || (policy.backend !== "seatbelt" && policy.backend !== "bwrap")) {
          throw new BatchObservationError("unavailable", "observer_isolation_unavailable");
        }
        assertPreparedFixtureEnvironment(native.fixture, effectiveSandboxChildEnvironment(policy));
        const random = randomBytes(contract.workload.elements * 4);
        const challenge = { schema_version: 1 as const, session_id: sessionId, nonce: randomBytes(32).toString("hex"),
          values: Array.from({ length: contract.workload.elements }, (_, index) => random.readUInt32LE(index * 4)) };
        const stdin = challengeStdin(challenge);
        const session = measurementSessionSchema.parse({ schema_version: 1, session_id: sessionId, nonce: challenge.nonce,
          sensor: contract.sensor, case_id: caseId, contract, work_ref: workRef, candidate_digest: native.candidateRef.digest,
          candidate_source_ref: native.sourceRef, candidate_snapshot_path: "candidate.ts",
          contract_digest: native.contractRef.digest, context_digest: context.context_ref.digest,
          dispatch_id: dispatch.dispatch_id, execution_id: dispatch.execution_id,
          preparation_ref: native.fixture.receiptDigest, fixture_digest: native.fixture.receipt.fixture_digest });
        const sessionRef = retain(input.log, "measurement/session", "measurement-session-v1", session, { ...binding, case_id: caseId });
        const challengeRef = retain(input.log, "measurement/challenge", "measurement-challenge-v1",
          measurementChallengeSchema.parse({ schema_version: 1, session_id: sessionId, nonce: challenge.nonce, stdin }), binding);
        // The command contains only the sealed runtime and the host-owned adapter path.
        const command = `exec ${quote(policy.runtimeExecutable)} ${quote(".observer/adapter.ts")}`;
        const prepared = appendSandboxExecutionEvent({ log: input.log, policy, evidence: { kind: "direct", commandDigest: fixtureHash(command) } });
        if (!prepared.observerBoundary || !prepared.observerIsolationDigest) throw new BatchObservationError("unavailable", "observer_isolation_unavailable");
        const boundaryRef = retain(input.log, "measurement/boundary", "measurement-boundary-v1", measurementBoundarySchema.parse(prepared.observerBoundary), binding);
        input.log.append({ kind: "effect", name: "measurement/execute", payload: { ...binding,
          challenge_digest: challengeRef.digest, preparation_ref: native.fixture.receiptDigest, policy_digest: prepared.observerIsolationDigest,
          sandbox_policy_digest: prepared.digest, boundary_ref: boundaryRef.digest } });
        native.assertIntegrity();
        const started = performance.now();
        const result = spawnPreparedSandbox(prepared, command, timeoutMs, { stdin: Buffer.from(stdin), maxBuffer: 8 * 1024 * 1024 });
        const elapsedMs = performance.now() - started;
        const outcome: EvaluationResultV2["outcome"] = {
          status: result.timedOut ? "timeout" : result.error || result.maxBufferExceeded || result.completionUnavailable || result.rawExitCode === null ? "error" : result.signal ? "cancelled" : result.exitCode === 0 ? "passed" : "failed",
          exit_code: result.rawExitCode === null ? null : result.exitCode, signal: result.signal ?? null,
        };
        const isolation = { provider: policy.backend, policy_digest: prepared.observerIsolationDigest, sandbox_policy_digest: prepared.digest, process: true, filesystem: true, control: true };
        const processBody = measurementProcessSchema.parse({ schema_version: 1, ...binding, challenge_digest: challengeRef.digest,
          preparation_ref: native.fixture.receiptDigest, stdout: result.stdout, stderr: result.stderr, elapsed_ms: elapsedMs, outcome, isolation,
          execution: { exit_code: result.exitCode, ...(result.rawExitCode === undefined ? {} : { raw_exit_code: result.rawExitCode }),
            ...(result.signal ? { signal: result.signal } : {}), ...(result.error ? { error: result.error } : {}),
            ...(result.timedOut ? { timed_out: true } : {}), ...(result.maxBufferExceeded ? { max_buffer_exceeded: true } : {}),
            ...(result.completionUnavailable ? { completion_unavailable: true } : {}) } });
        const processRef = retain(input.log, "measurement/process", "measurement-process-v1", processBody, binding);
        native.assertIntegrity();
        if (outcome.status === "failed") throw new BatchObservationError("evaluator_error", "observer_candidate_process_failed");
        if (outcome.status !== "passed") throw new BatchObservationError("evaluator_error", "observer_process_completion_unavailable");
        native.finish();
        const derivation = deriveMeasurement(contract, challenge, result.stdout, elapsedMs, { stdin, isolation });
        const body = measurementResultSchema.parse({ schema_version: 1, ...binding, session_digest: sessionRef.digest,
          challenge_digest: challengeRef.digest, process_digest: processRef.digest, derivation });
        const measurementRef = retain(input.log, "measurement/result", "measurement-result-v1", body, { ...binding,
          status: derivation.status, evidence_level: "attested",
          correct_elements: derivation.metrics.find(value => value.metric === "correct_elements")!.value,
          requested_elements: contract.workload.elements, elapsed_ms: elapsedMs,
          witness_status: derivation.witnesses.every(value => value.passed) ? "passed" : "failed", uncertainty: "invocation_elapsed_only" });
        return { outcome,
          metric: { value: derivation.metrics.find(value => value.metric === "correct_elements")!.value,
            unit: "elements", source: "observer.correct_outputs" }, output: { measurement_ref: measurementRef } };
      } catch (error) {
        const failure = error instanceof BatchObservationError ? error : new BatchObservationError("evaluator_error", "observer_execution_failed", error);
        input.log.append({ kind: "observe", name: "measurement/refused", payload: { ...binding, case_id: caseId, status: failure.status, reason_code: failure.code } });
        throw failure;
      } finally { if (policy) disposeSandboxPolicy(policy); }
    },
    close() { closed = true; native.close(); },
  });
}
