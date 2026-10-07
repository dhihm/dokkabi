import { z } from "zod";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const text = z.string().min(1).max(512);
export const evidenceLevelSchema = z.enum(["workspace_reported", "execution"]);
export const roleSchema = z.enum(["deployment_checker", "acceptance_checker", "hidden_research_oracle"]);
export const phaseSchema = z.enum(["baseline", "implement", "acceptance", "terminal"]);
export const audienceSchema = z.enum(["deployment", "research"]);
export const fileRefSchema = z.strictObject({ path: text, digest: digestSchema });
export const artifactRefSchema = z.strictObject({
  kind: text, digest: digestSchema, blob: digestSchema, blobBytes: z.number().int().nonnegative(),
});
export const authoritySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("deployment"), phase: phaseSchema, audience: z.literal("deployment"), role: roleSchema }),
  z.strictObject({ kind: z.literal("terminal_research"), phase: z.literal("terminal"), audience: z.literal("research"), role: z.literal("hidden_research_oracle"), terminal_artifact_ref: fileRefSchema }),
]);
export const metricIdentitySchema = z.strictObject({ unit: text, source: text });
export const metricSchema = metricIdentitySchema.extend({ value: z.number().finite() });
export const contextBodySchema = z.strictObject({
  schema_version: z.literal(2), authority: authoritySchema,
  candidate_ref: fileRefSchema, contract_ref: fileRefSchema,
  requirements: z.strictObject({ evidence_level: evidenceLevelSchema, metric: metricIdentitySchema }),
});
export const contextSchema = contextBodySchema.extend({ context_ref: artifactRefSchema });
export const outcomeSchema = z.strictObject({
  status: z.enum(["passed", "failed", "error", "timeout", "cancelled"]),
  exit_code: z.number().int().nullable(), signal: text.nullable(),
});
export const resultSchema = z.strictObject({ outcome: outcomeSchema, metric: metricSchema, output: z.json() });
const evaluatorIdentity = {
  runner_digest: digestSchema, evaluator_id: idSchema,
  evaluator_descriptor_digest: digestSchema, evaluator_implementation_digest: digestSchema,
  evaluator_config_digest: digestSchema, evaluator_lifecycle_generation: z.number().int().positive(),
  evidence_level: evidenceLevelSchema,
};
export const dispatchSchema = z.strictObject({
  dispatch_id: idSchema, execution_id: idSchema, contract_ref: digestSchema,
  input_ref: digestSchema, ...evaluatorIdentity, expected_metric: metricIdentitySchema,
});
export const receiptSchema = z.strictObject({
  receipt_id: idSchema, dispatch_id: idSchema, execution_id: idSchema,
  context_digest: digestSchema, candidate_digest: digestSchema, contract_digest: digestSchema,
  policy_digest: digestSchema, ...evaluatorIdentity, metric: metricSchema,
  outcome: outcomeSchema, body: artifactRefSchema.extend({ kind: z.literal("evaluation-result-v2") }),
});
export const policySchema = z.strictObject({ version: z.number().int(), content: z.json(), digest: digestSchema });
export const gateEvidenceInputV2Schema = z.strictObject({
  schema_version: z.literal(2), policy: policySchema, context: contextSchema,
  dispatch: dispatchSchema, receipt: receiptSchema,
});
export const evidenceDecisionV2Schema = z.strictObject({
  schema_version: z.literal(2), status: z.enum(["admissible", "refused"]),
  reason_codes: z.array(idSchema), input_digest: digestSchema,
});
export const evaluationRequestSchema = z.strictObject({
  evaluator_id: idSchema, contract_ref: digestSchema, input_ref: digestSchema,
});
export function validEvaluatorRole(value: { role: string; phases: string[]; audiences: string[] }): boolean {
  const phases = value.role === "hidden_research_oracle" ? ["terminal"] : value.role === "acceptance_checker" ? ["acceptance"] : ["baseline", "implement"];
  const audience = value.role === "hidden_research_oracle" ? "research" : "deployment";
  return value.phases.length > 0 && value.audiences.length > 0
    && new Set(value.phases).size === value.phases.length && new Set(value.audiences).size === value.audiences.length
    && value.phases.every(phase => phases.includes(phase)) && value.audiences.every(value => value === audience);
}
export const enrollmentSchema = z.strictObject({ id: idSchema, role: roleSchema, phases: z.array(phaseSchema), audiences: z.array(audienceSchema), isolation: z.literal("process"), implementation_digest: digestSchema, config_digest: digestSchema }).refine(validEvaluatorRole, "invalid evaluator role/phase/audience");
export const evaluatorDescriptorSchema = z.strictObject({
  id: idSchema, role: roleSchema, phases: z.array(phaseSchema).min(1),
  audiences: z.array(audienceSchema).min(1), isolation: z.literal("process"),
  module_path: text, dependency_paths: z.array(text), config: z.json(),
}).refine(validEvaluatorRole, "invalid evaluator role/phase/audience");
export type GateEvidenceInputV2 = z.infer<typeof gateEvidenceInputV2Schema>;
export type EvidenceDecisionV2 = z.infer<typeof evidenceDecisionV2Schema>;
export type EvaluationContextV2 = z.infer<typeof contextSchema>;
export type EvaluationContextBodyV2 = z.infer<typeof contextBodySchema>;
export type EvaluationResultV2 = z.infer<typeof resultSchema>;
export type EvaluationDispatchV2 = z.infer<typeof dispatchSchema>;
export type EvaluationReceiptV2 = z.infer<typeof receiptSchema>;
export type EvaluatorDescriptorV2 = z.infer<typeof evaluatorDescriptorSchema>;
export type EvaluationRequestV2 = z.infer<typeof evaluationRequestSchema>;


/** Execution history authority for case transitions, separate from V2 result admissibility. */
export const workExecutionIdentitySchema = z.strictObject({
  schema_version: z.literal(1), policy: z.literal("execution-earned-v1"), obligation_key: digestSchema,
  workspace: z.string().min(1), command: z.string().min(1), checker_digest: digestSchema,
  candidate_digest: digestSchema, workspace_digest: digestSchema, runner_digest: digestSchema,
  evaluator_digest: digestSchema, environment_digest: digestSchema,
  protection: z.enum(["managed", "workspace", "remote_sealed", "remote_reported"]), phase: z.enum(["baseline", "verify"]),
});
export const workInputFileSchema = z.strictObject({ path: z.string().min(1), mode: z.number().int().min(0).max(0o777), digest: digestSchema, link: z.string().optional(), directory: z.literal(true).optional() });
const caseEnvironmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sealed-child-environment-v1"), variables: z.record(z.string(), z.string()),
    private_roots: z.strictObject({ home: z.string().min(1).optional(), temp: z.string().min(1).optional(), tool_cache: z.string().min(1).optional() }) }),
  z.strictObject({ kind: z.literal("ambient-environment-digest-v1"), digest: digestSchema }),
]);
export const workExecutionBodySchema = z.strictObject({ checker: z.json(), candidate: z.json(), evaluator: z.json(), workspace_files: z.array(workInputFileSchema).max(100000), environment: caseEnvironmentSchema.optional() });
export type WorkExecutionIdentity = z.infer<typeof workExecutionIdentitySchema>;
