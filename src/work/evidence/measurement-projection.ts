import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import { evidenceDigest } from "./contract.ts";
import { projectEvidence, type EvidenceBodies } from "./projection.ts";
import { projectFixtures } from "./fixture-projection.ts";
import { artifactRefSchema, digestSchema, idSchema, resultSchema } from "./schema.ts";
import {
  challengeSchema, deriveMeasurement, measurementContractBody, measurementSessionSchema, measurementChallengeSchema,
  measurementProcessSchema, measurementResultSchema, measurementSourceSchema, measurementBoundarySchema,
  type MeasurementSessionV1, type MeasurementResultV1, type MeasurementSourceV1,
} from "./measurements.ts";

export const MEASUREMENT_BODY_EVENTS = new Set(["measurement/source", "measurement/session", "measurement/challenge", "measurement/boundary", "measurement/process", "measurement/result"]);
export const isMeasurementEvent = (name: string): boolean => name.startsWith("measurement/");
export type MeasurementReference = { readonly seq: number; readonly name: string; readonly payload: Readonly<Record<string, unknown>> };
export type MeasurementDecision = {
  schema_version: 1; session_id: string; execution_id: string; case_id: string; receipt_id: string | null;
  result_ref: z.infer<typeof artifactRefSchema>; status: "passed" | "failed" | "refused"; reason_codes: string[];
};
const refusalSchema = z.strictObject({
  status: z.enum(["refused", "unavailable", "evaluator_error"]), reason_code: idSchema,
  case_id: idSchema.optional(), session_id: idSchema.optional(), execution_id: idSchema.optional(),
});
const executeSchema = z.strictObject({ session_id: idSchema, execution_id: idSchema, challenge_digest: digestSchema, preparation_ref: digestSchema, policy_digest: digestSchema, sandbox_policy_digest: z.string().regex(/^[a-f0-9]{16}$/u), boundary_ref: digestSchema });
const resultOutputSchema = z.strictObject({ measurement_ref: artifactRefSchema.extend({ kind: z.literal("measurement-result-v1") }) });
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
export class MeasurementReplayError extends Error {
  constructor(readonly code: string) { super(`measurement replay refused: ${code}`); this.name = "MeasurementReplayError"; }
}
function fail(code: string): never { throw new MeasurementReplayError(code); }
function parse<T>(schema: z.ZodType<T>, raw: unknown, stage: string): T {
  const parsed = schema.safeParse(raw); if (!parsed.success) return fail(`${stage}_schema_invalid`); return parsed.data;
}

/** Authenticate retained native observations and recalculate protocol facts without a clock or provider. */
export function projectMeasurements(events: readonly EventRecord[], bodies: EvidenceBodies = new Map()): {
  sessions: MeasurementSessionV1[]; results: MeasurementResultV1[]; decisions: MeasurementDecision[]; references: MeasurementReference[];
} {
  const references: MeasurementReference[] = [], sessions: MeasurementSessionV1[] = [], results: MeasurementResultV1[] = [], decisions: MeasurementDecision[] = [];
  if (!events.some(event => isMeasurementEvent(event.name))) return { sessions, results, decisions, references };
  const evidence = projectEvidence(events, bodies);
  projectFixtures(events, bodies);
  const sourceMap = new Map<string, { body: MeasurementSourceV1; seq: number }>();
  const states = new Map<string, {
    session: MeasurementSessionV1; sessionDigest: string; sessionSeq: number;
    challenge?: { body: z.infer<typeof measurementChallengeSchema>; digest: string; seq: number };
    boundary?: { body: z.infer<typeof measurementBoundarySchema>; digest: string; seq: number };
    execute?: { body: z.infer<typeof executeSchema>; seq: number };
    process?: { body: z.infer<typeof measurementProcessSchema>; digest: string; seq: number };
    result?: { body: MeasurementResultV1; ref: z.infer<typeof artifactRefSchema>; seq: number };
    refusal?: { code: string; seq: number };
  }>();
  const nonces = new Set<string>(), executions = new Set<string>(), consumedResults = new Set<string>(), consumedSandboxExecutions = new Set<number>();
  const refusedSessions = new Set<string>(), refusedExecutions = new Set<string>();
  let previousSeq = -1;
  for (const event of events) {
    if (!isMeasurementEvent(event.name)) continue;
    if (event.seq <= previousSeq) fail("event_order_invalid"); previousSeq = event.seq;
    references.push({ seq: event.seq, name: event.name, payload: structuredClone(event.payload) });
    if (event.name === "measurement/execute") {
      if (event.kind !== "effect") fail("execute_effect_required");
      const body = parse(executeSchema, event.payload, "execute"), state = states.get(body.session_id);
      if (!state || state.refusal || state.execute || !state.challenge || body.execution_id !== state.session.execution_id
        || body.challenge_digest !== state.challenge.digest || body.preparation_ref !== state.session.preparation_ref) fail("execute_binding_mismatch");
      const boundary = state.boundary;
      if (!boundary || body.boundary_ref !== boundary.digest) fail("execute_boundary_missing");
      const boundaryBytes = typeof boundary.body.content === "string" ? boundary.body.content : JSON.stringify(boundary.body.content);
      if (createHash("sha256").update(boundaryBytes).digest("hex") !== body.policy_digest) fail("execute_boundary_digest_mismatch");
      const native = [...events].reverse().find(row => row.name === "sandbox/exec" && row.seq < boundary.seq);
      const policy = native && [...events].reverse().find(row => row.name === "sandbox/policy" && row.seq < native.seq);
      if (!native || native.kind !== "effect" || consumedSandboxExecutions.has(native.seq) || native.seq <= state.challenge.seq
        || !policy || policy.kind !== "observe" || native.payload.backend !== boundary.body.backend || policy.payload.backend !== boundary.body.backend
        || native.payload.network !== "deny" || policy.payload.network !== "deny" || native.payload.mode !== "workspace-write" || policy.payload.mode !== "workspace-write"
        || native.payload.digest !== body.sandbox_policy_digest || policy.payload.digest !== body.sandbox_policy_digest) fail("execute_native_policy_mismatch");
      consumedSandboxExecutions.add(native.seq);
      state.execute = { body, seq: event.seq }; continue;
    }
    if (event.kind !== "observe") fail("observe_event_required");
    if (event.name === "measurement/refused") {
      const refusal = parse(refusalSchema, event.payload, "refusal");
      if ((refusal.session_id && refusedSessions.has(refusal.session_id)) || (refusal.execution_id && refusedExecutions.has(refusal.execution_id))) fail("refusal_duplicate");
      if (refusal.session_id) refusedSessions.add(refusal.session_id);
      if (refusal.execution_id) refusedExecutions.add(refusal.execution_id);
      if (refusal.session_id) {
        const state = states.get(refusal.session_id);
        if (!state) {
          const dispatch = events.find(row => row.name === "evaluation/dispatch" && row.payload.execution_id === refusal.execution_id && row.seq < event.seq);
          const terminal = events.find(row => row.name === "evaluation/refused" && row.payload.execution_id === refusal.execution_id && row.seq > event.seq);
          if (!dispatch || !terminal || events.some(row => row.name === "evaluation/result" && row.payload.execution_id === refusal.execution_id)) fail("refusal_dispatch_mismatch");
          continue;
        }
        if (state.refusal || state.result || (refusal.execution_id !== undefined && refusal.execution_id !== state.session.execution_id)
          || (refusal.case_id !== undefined && refusal.case_id !== state.session.case_id)) fail("refusal_binding_mismatch");
        state.refusal = { code: refusal.reason_code, seq: event.seq };
      } else if (refusal.execution_id) fail("refusal_session_missing");
      continue;
    }
    if (!MEASUREMENT_BODY_EVENTS.has(event.name)) fail("unknown_event");
    const { blob, blob_bytes, digest, artifact } = event.payload;
    if (typeof blob !== "string" || !bodies.has(blob)) fail("body_blob_missing");
    const raw = bodies.get(blob), expectedKind = event.name.replace("measurement/", "measurement-") + "-v1";
    if (evidenceDigest(raw) !== blob || digest !== blob || Buffer.byteLength(canonicalJson(raw)) !== blob_bytes || artifact !== expectedKind) fail("body_blob_integrity_mismatch");
    if (event.name === "measurement/source") {
      const body = parse(measurementSourceSchema, raw, "source"), bytes = Buffer.from(body.data, "base64");
      if (bytes.toString("base64") !== body.data || createHash("sha256").update(bytes).digest("hex") !== body.sha256) fail("source_content_mismatch");
      if (event.payload.case_id !== body.case_id) fail("source_binding_mismatch");
      sourceMap.set(blob, { body, seq: event.seq }); continue;
    }
    if (event.name === "measurement/session") {
      const body = parse(measurementSessionSchema, raw, "session");
      if (event.payload.session_id !== body.session_id || event.payload.execution_id !== body.execution_id || event.payload.case_id !== body.case_id
        || states.has(body.session_id) || refusedSessions.has(body.session_id) || refusedExecutions.has(body.execution_id) || nonces.has(body.nonce) || executions.has(body.execution_id)) fail("session_duplicate_or_binding_mismatch");
      if (body.contract_digest !== evidenceDigest(measurementContractBody(body.contract, body.work_ref))) fail("session_contract_mismatch");
      const source = sourceMap.get(body.candidate_source_ref);
      if (!source || source.seq >= event.seq || source.body.case_id !== body.case_id || source.body.sha256 !== body.candidate_digest) fail("session_source_mismatch");
      const dispatch = events.find(row => row.name === "evaluation/dispatch" && row.payload.execution_id === body.execution_id);
      const dispatchBody = dispatch && typeof dispatch.payload.blob === "string" ? bodies.get(dispatch.payload.blob) as Record<string, unknown> | undefined : undefined;
      if (!dispatch || dispatch.seq >= event.seq || !dispatchBody || dispatchBody.dispatch_id !== body.dispatch_id || dispatchBody.input_ref !== body.context_digest || dispatchBody.contract_ref !== body.contract_digest) fail("session_dispatch_mismatch");
      const preparation = events.find(row => row.name === "fixture/preparation" && row.payload.blob === body.preparation_ref);
      const preparationBody = bodies.get(body.preparation_ref) as Record<string, unknown> | undefined;
      if (!preparation || preparation.seq >= event.seq || !preparationBody || preparationBody.status !== "prepared" || preparationBody.fixture_digest !== body.fixture_digest) fail("session_preparation_mismatch");
      const candidate = typeof preparationBody.candidate_digest === "string" ? bodies.get(preparationBody.candidate_digest) : undefined;
      if (!Array.isArray(candidate) || !candidate.some(row => row.path === body.candidate_snapshot_path && row.sha256 === source.body.sha256 && row.bytes === Buffer.from(source.body.data, "base64").length && row.mode === source.body.mode)) fail("session_candidate_snapshot_mismatch");
      if (events.some(row => row.seq < event.seq && row.name === "fixture/cleanup" && row.payload.preparation_ref === body.preparation_ref)) fail("session_preparation_closed");
      states.set(body.session_id, { session: body, sessionDigest: blob, sessionSeq: event.seq });
      sessions.push(body); nonces.add(body.nonce); executions.add(body.execution_id); continue;
    }
    const rawSessionId = event.name === "measurement/boundary" ? event.payload.session_id : raw && typeof raw === "object" && "session_id" in raw ? raw.session_id : undefined;
    const state = typeof rawSessionId === "string" ? states.get(rawSessionId) : undefined;
    if (!state || state.refusal || event.payload.session_id !== state.session.session_id || event.payload.execution_id !== state.session.execution_id) fail("session_link_mismatch");
    if (event.name === "measurement/boundary") {
      const body = parse(measurementBoundarySchema, raw, "boundary");
      if (!state.challenge || state.boundary || state.execute) fail("boundary_order_invalid");
      state.boundary = { body, digest: blob, seq: event.seq };
    } else if (event.name === "measurement/challenge") {
      const body = parse(measurementChallengeSchema, raw, "challenge");
      if (state.challenge || body.nonce !== state.session.nonce) fail("challenge_duplicate_or_identity_mismatch");
      let challenge: z.infer<typeof challengeSchema>;
      try { challenge = challengeSchema.parse(JSON.parse(body.stdin)); } catch { return fail("challenge_stdin_invalid"); }
      if (challenge.session_id !== state.session.session_id || challenge.nonce !== state.session.nonce || challenge.values.length !== state.session.contract.workload.elements) fail("challenge_session_mismatch");
      state.challenge = { body, digest: blob, seq: event.seq };
    } else if (event.name === "measurement/process") {
      const body = parse(measurementProcessSchema, raw, "process");
      if (!state.challenge || !state.execute || state.process || body.execution_id !== state.session.execution_id || body.challenge_digest !== state.challenge.digest
        || body.preparation_ref !== state.session.preparation_ref || body.isolation.policy_digest !== state.execute.body.policy_digest
        || body.isolation.sandbox_policy_digest !== state.execute.body.sandbox_policy_digest || body.isolation.provider !== state.boundary?.body.backend) fail("process_binding_mismatch");
      state.process = { body, digest: blob, seq: event.seq };
    } else if (event.name === "measurement/result") {
      const body = parse(measurementResultSchema, raw, "result");
      if (!state.challenge || !state.process || state.result || body.execution_id !== state.session.execution_id || body.session_digest !== state.sessionDigest
        || body.challenge_digest !== state.challenge.digest || body.process_digest !== state.process.digest) fail("result_binding_mismatch");
      const process = state.process.body, execution = process.execution;
      if (execution.exit_code !== 0 || (execution.raw_exit_code !== undefined && execution.raw_exit_code !== 0) || execution.signal || execution.error
        || execution.timed_out || execution.max_buffer_exceeded || execution.completion_unavailable
        || process.outcome.status !== "passed" || process.outcome.exit_code !== 0 || process.outcome.signal !== null) fail("result_process_incomplete");
      const challenge = challengeSchema.parse(JSON.parse(state.challenge.body.stdin));
      const derived = deriveMeasurement(state.session.contract, challenge, process.stdout, process.elapsed_ms, { stdin: state.challenge.body.stdin, isolation: process.isolation });
      if (!same(body.derivation, derived)) fail("result_derivation_mismatch");
      const correct = derived.metrics.find(metric => metric.metric === "correct_elements")!.value;
      if (event.payload.status !== derived.status || event.payload.evidence_level !== "attested" || event.payload.correct_elements !== correct
        || event.payload.requested_elements !== state.session.contract.workload.elements || event.payload.elapsed_ms !== process.elapsed_ms
        || event.payload.witness_status !== (derived.witnesses.every(witness => witness.passed) ? "passed" : "failed")
        || event.payload.uncertainty !== "invocation_elapsed_only") fail("result_summary_mismatch");
      state.result = { body, ref: { kind: "measurement-result-v1", digest: blob, blob, blobBytes: blob_bytes as number }, seq: event.seq }; results.push(body);
    }
  }
  for (const state of states.values()) {
    if (!state.result) {
      if (!state.refusal) fail("session_incomplete");
      if (!events.some(event => event.name === "evaluation/refused" && event.payload.execution_id === state.session.execution_id && event.seq > state.refusal!.seq)) fail("session_refusal_terminal_missing");
      continue;
    }
    const { session, result, process } = state;
    const input = evidence.inputs.find(value => value.receipt.execution_id === session.execution_id);
    if (!input) {
      const refused = events.some(event => event.name === "evaluation/refused" && event.payload.execution_id === session.execution_id && event.seq > result.seq);
      if (!refused) fail("result_receipt_missing");
      decisions.push({ schema_version: 1, session_id: session.session_id, execution_id: session.execution_id, case_id: session.case_id, receipt_id: null, result_ref: result.ref, status: "refused", reason_codes: ["evaluation_refused"] }); continue;
    }
    if (input.context.authority.kind !== "deployment" || input.context.authority.phase !== (session.work_ref.phase === "red" ? "baseline" : "implement")) fail("result_work_phase_mismatch");
    if (input.context.candidate_ref.digest !== session.candidate_digest || input.context.contract_ref.digest !== session.contract_digest || input.context.context_ref.digest !== session.context_digest) fail("result_context_mismatch");
    const evaluationResult = parse(resultSchema, bodies.get(input.receipt.body.blob), "evaluation_result");
    const output = parse(resultOutputSchema, evaluationResult.output, "evaluation_output");
    if (!same(output.measurement_ref, result.ref) || consumedResults.has(result.ref.digest)) fail("result_receipt_binding_mismatch");
    const evaluationResultEvent = events.find(event => event.name === "evaluation/result" && event.payload.execution_id === session.execution_id);
    if (!evaluationResultEvent || evaluationResultEvent.seq <= result.seq) fail("result_receipt_order_invalid");
    const correct = result.body.derivation.metrics.find(metric => metric.metric === "correct_elements")!;
    if (evaluationResult.metric.value !== correct.value || evaluationResult.metric.unit !== correct.unit || evaluationResult.metric.source !== correct.source || !same(evaluationResult.outcome, process!.body.outcome)) fail("result_metric_mismatch");
    const preparedInvalid = events.some(event => event.name === "fixture/integrity" && event.payload.preparation_ref === session.preparation_ref && event.payload.status !== "passed");
    const integrity = events.some(event => event.name === "fixture/integrity" && event.payload.preparation_ref === session.preparation_ref && event.payload.status === "passed" && event.seq > process!.seq && event.seq < evaluationResultEvent.seq);
    const cleanup = events.some(event => event.name === "fixture/cleanup" && event.payload.preparation_ref === session.preparation_ref && event.payload.status === "completed" && event.seq > process!.seq && event.seq < evaluationResultEvent.seq);
    if (preparedInvalid || !integrity || !cleanup) fail("result_preparation_not_finalized");
    const evidenceDecision = evidence.decisions.find(decision => decision.input_digest === evidenceDigest(input));
    if (!evidenceDecision) fail("result_evidence_decision_missing");
    consumedResults.add(result.ref.digest);
    decisions.push({ schema_version: 1, session_id: session.session_id, execution_id: session.execution_id, case_id: session.case_id, receipt_id: input.receipt.receipt_id,
      result_ref: result.ref, status: evidenceDecision.status === "admissible" ? result.body.derivation.status : "refused",
      reason_codes: evidenceDecision.status === "admissible" ? result.body.derivation.reason_codes : evidenceDecision.reason_codes });
  }
  return { sessions, results, decisions, references };
}
