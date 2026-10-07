import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import { digestSchema, idSchema, outcomeSchema } from "./schema.ts";
import { evaluateWitnesses, requiredAxesSchema, witnessDecisionSchema, witnessObservationSchema, type WitnessObservationsV1 } from "./witnesses.ts";

export const MEASUREMENT_SENSOR_V1 = "u32-square-v1" as const;
export const MEASUREMENT_METRICS = {
  correct_elements: { unit: "elements", source: "observer.correct_outputs" },
  input_bytes: { unit: "bytes", source: "observer.challenge_bytes" },
  elapsed_ms: { unit: "ms", source: "observer.monotonic_elapsed" },
  throughput_elements_per_second: { unit: "elements_per_second", source: "observer.correct_outputs_per_elapsed" },
} as const;
export const measurementMetricNameSchema = z.enum(["correct_elements", "input_bytes", "elapsed_ms", "throughput_elements_per_second"]);
export type MeasurementMetricName = z.infer<typeof measurementMetricNameSchema>;
const identityFields = { metric: measurementMetricNameSchema, unit: z.string(), source: z.string() };
function supportedIdentity(value: { metric: MeasurementMetricName; unit: string; source: string }): boolean {
  const expected = MEASUREMENT_METRICS[value.metric];
  return value.unit === expected.unit && value.source === expected.source;
}
export const measurementRequirementSchema = z.discriminatedUnion("op", [
  z.strictObject({ ...identityFields, op: z.literal("ge"), value: z.number().finite() }),
  z.strictObject({ ...identityFields, op: z.literal("le"), value: z.number().finite() }),
  z.strictObject({ ...identityFields, op: z.literal("eq"), value: z.number().finite(), tolerance: z.number().finite().nonnegative() }),
]).refine(supportedIdentity, "unsupported measurement unit or source");
export const measurementMetricSchema = z.strictObject({ ...identityFields, value: z.number().finite().nonnegative() }).refine(supportedIdentity, "unsupported measurement unit or source");
export type MeasurementRequirementV1 = z.infer<typeof measurementRequirementSchema>;
export type MeasurementMetricV1 = z.infer<typeof measurementMetricSchema>;
export const caseMeasurementSchema = z.strictObject({
  schema_version: z.literal(1), evidence_level: z.literal("attested"), sensor: z.literal(MEASUREMENT_SENSOR_V1),
  workload: z.strictObject({ elements: z.number().int().min(1).max(100000) }),
  requirements: z.array(measurementRequirementSchema).max(32), required_axes: requiredAxesSchema,
  metadata: z.record(z.string().min(1).max(128), z.union([z.string().max(4096), z.number().finite(), z.boolean()])).optional(),
});
export type CaseMeasurement = z.infer<typeof caseMeasurementSchema>;
export const measurementContractSchema = caseMeasurementSchema;
export type MeasurementContractV1 = CaseMeasurement;
const nonceSchema = digestSchema;
const uint32Schema = z.number().int().min(0).max(0xffffffff);
export const challengeSchema = z.strictObject({
  schema_version: z.literal(1), session_id: idSchema, nonce: nonceSchema,
  values: z.array(uint32Schema).min(1).max(100000),
});
export type MeasurementChallengeV1 = z.infer<typeof challengeSchema>;
export const responseSchema = z.strictObject({
  schema_version: z.literal(1), session_id: idSchema, nonce: nonceSchema,
  results: z.array(z.strictObject({ index: z.number().int().nonnegative().max(99999), value: uint32Schema })).max(100000),
});
export type MeasurementResponseV1 = z.infer<typeof responseSchema>;
export const comparisonSchema = z.strictObject({ metric: measurementMetricNameSchema, passed: z.boolean() });
export const measurementDerivationSchema = z.strictObject({
  schema_version: z.literal(1), status: z.enum(["passed", "failed", "refused"]), reason_codes: z.array(idSchema),
  metrics: z.array(measurementMetricSchema).length(4), comparisons: z.array(comparisonSchema), witnesses: z.array(witnessDecisionSchema),
  semantics: z.literal("whole_invocation_elapsed_including_startup_and_sleep"),
});
export type MeasurementDerivation = z.infer<typeof measurementDerivationSchema>;
export const workMeasurementRefSchema = z.strictObject({ plan_digest: digestSchema, case_digest: digestSchema, phase: z.enum(["red", "green"]) });
export type WorkMeasurementRefV1 = z.infer<typeof workMeasurementRefSchema>;
export function measurementContractBody(contract: CaseMeasurement, workRef: WorkMeasurementRefV1) {
  return { schema_version: 1 as const, measurement: caseMeasurementSchema.parse(contract), work_ref: workMeasurementRefSchema.parse(workRef) };
}
export const measurementSessionSchema = z.strictObject({
  schema_version: z.literal(1), session_id: idSchema, nonce: nonceSchema, sensor: z.literal(MEASUREMENT_SENSOR_V1), case_id: idSchema,
  contract: caseMeasurementSchema, work_ref: workMeasurementRefSchema, candidate_digest: digestSchema, contract_digest: digestSchema, context_digest: digestSchema,
  dispatch_id: idSchema, execution_id: idSchema, preparation_ref: digestSchema, fixture_digest: digestSchema,
  candidate_source_ref: digestSchema, candidate_snapshot_path: z.literal("candidate.ts"),
});
export type MeasurementSessionV1 = z.infer<typeof measurementSessionSchema>;
export const measurementChallengeSchema = z.strictObject({ schema_version: z.literal(1), session_id: idSchema, nonce: nonceSchema, stdin: z.string().max(2 * 1024 * 1024) });
export type MeasurementChallengeArtifactV1 = z.infer<typeof measurementChallengeSchema>;
export const measurementSourceSchema = z.strictObject({
  schema_version: z.literal(1), case_id: idSchema, candidate_path: z.string().min(1).max(4096), sha256: digestSchema,
  identity: z.string().min(1).max(256), mode: z.number().int().min(0).max(0o777), encoding: z.literal("base64"), data: z.string().max(16 * 1024 * 1024),
});
export type MeasurementSourceV1 = z.infer<typeof measurementSourceSchema>;
export const measurementExecutionSchema = z.strictObject({
  exit_code: z.number().int(), raw_exit_code: z.number().int().nullable().optional(), signal: z.string().nullable().optional(),
  error: z.string().optional(), timed_out: z.boolean().optional(), max_buffer_exceeded: z.boolean().optional(), completion_unavailable: z.boolean().optional(),
});
export const measurementBoundarySchema = z.discriminatedUnion("backend", [
  z.strictObject({ schema_version: z.literal(1), backend: z.literal("seatbelt"), network: z.literal("deny"), isolation: z.literal("protected-observer-v1"), mechanism: z.literal("seatbelt-profile"), content: z.string().min(1).max(1024 * 1024) }),
  z.strictObject({ schema_version: z.literal(1), backend: z.literal("bwrap"), network: z.literal("deny"), isolation: z.literal("protected-observer-v1"), mechanism: z.literal("bwrap-argv"), content: z.array(z.string()).min(1).max(4096) }),
]);
export type MeasurementBoundaryV1 = z.infer<typeof measurementBoundarySchema>;
export const measurementProcessSchema = z.strictObject({
  schema_version: z.literal(1), session_id: idSchema, execution_id: idSchema, challenge_digest: digestSchema, preparation_ref: digestSchema,
  stdout: z.string().max(8 * 1024 * 1024), stderr: z.string().max(8 * 1024 * 1024), elapsed_ms: z.number().finite().positive(),
  outcome: outcomeSchema, execution: measurementExecutionSchema, isolation: witnessObservationSchema,
});
export type MeasurementProcessV1 = z.infer<typeof measurementProcessSchema>;
export const measurementResultSchema = z.strictObject({
  schema_version: z.literal(1), session_id: idSchema, execution_id: idSchema, session_digest: digestSchema, challenge_digest: digestSchema,
  process_digest: digestSchema, derivation: measurementDerivationSchema,
});
export type MeasurementResultV1 = z.infer<typeof measurementResultSchema>;

export function challengeStdin(challenge: MeasurementChallengeV1): string { return canonicalJson(challengeSchema.parse(challenge)) + "\n"; }
export function compareMeasurement(requirement: MeasurementRequirementV1, value: number): boolean {
  const bar = measurementRequirementSchema.parse(requirement);
  if (!Number.isFinite(value)) return false;
  if (bar.op === "ge") return value >= bar.value;
  if (bar.op === "le") return value <= bar.value;
  return Math.abs(value - bar.value) <= bar.tolerance;
}

/** Recompute only the named reference work. Invocation time includes startup and idle time. */
export function deriveMeasurement(contractValue: CaseMeasurement, challengeValue: MeasurementChallengeV1, responseRaw: string, elapsedMs: number, observation: {
  stdin: string; isolation: WitnessObservationsV1;
}): MeasurementDerivation {
  const contract = caseMeasurementSchema.parse(contractValue), challenge = challengeSchema.parse(challengeValue);
  const isolation = witnessObservationSchema.parse(observation.isolation);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error("measurement elapsed time must be finite and positive");
  const reasons: string[] = [], refusalReasons: string[] = [];
  const challengeBound = observation.stdin === challengeStdin(challenge) && challenge.values.length === contract.workload.elements;
  if (!challengeBound) refusalReasons.push("challenge_contract_mismatch");
  if (!isolation.process || !isolation.filesystem || !isolation.control) refusalReasons.push("measurement_isolation_unavailable");
  let response: MeasurementResponseV1 | undefined;
  try { response = responseSchema.parse(JSON.parse(responseRaw)); } catch { reasons.push("response_malformed"); }
  let correctElements = 0;
  if (response) {
    if (response.session_id !== challenge.session_id || response.nonce !== challenge.nonce) reasons.push("response_identity_mismatch");
    if (response.results.length !== challenge.values.length) reasons.push("response_count_mismatch");
    const seen = new Set<number>();
    for (const result of response.results) {
      if (seen.has(result.index)) { reasons.push("response_duplicate_index"); continue; }
      seen.add(result.index);
      const input = challenge.values[result.index];
      if (input === undefined) { reasons.push("response_extra_index"); continue; }
      if (result.value !== (Math.imul(input, input) >>> 0)) reasons.push("response_incorrect_output");
      else correctElements++;
    }
    if (seen.size !== challenge.values.length) reasons.push("response_incomplete_work");
    if (response.session_id !== challenge.session_id || response.nonce !== challenge.nonce) correctElements = 0;
  }
  const values: Record<MeasurementMetricName, number> = {
    correct_elements: correctElements, input_bytes: Buffer.byteLength(observation.stdin), elapsed_ms: elapsedMs,
    throughput_elements_per_second: correctElements * 1000 / elapsedMs,
  };
  if (!Number.isFinite(values.throughput_elements_per_second)) throw new Error("measurement throughput must be finite");
  const metrics = (Object.keys(MEASUREMENT_METRICS) as MeasurementMetricName[]).map(metric => ({ metric, ...MEASUREMENT_METRICS[metric], value: values[metric] }));
  const comparisons = contract.requirements.map(bar => ({ metric: bar.metric, passed: compareMeasurement(bar, values[bar.metric]) }));
  if (comparisons.some(value => !value.passed)) reasons.push("measurement_requirement_failed");
  const witnesses = evaluateWitnesses(contract.required_axes, { requestedElements: contract.workload.elements, correctElements, challengeBound, isolation });
  if (witnesses.some(value => !value.passed)) reasons.push("measurement_witness_failed");
  return measurementDerivationSchema.parse({ schema_version: 1, status: refusalReasons.length ? "refused" : reasons.length ? "failed" : "passed",
    reason_codes: [...new Set([...refusalReasons, ...reasons])], metrics, comparisons, witnesses,
    semantics: "whole_invocation_elapsed_including_startup_and_sleep" });
}
