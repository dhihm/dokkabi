import { createHash } from "node:crypto";
import { canonicalJson } from "../../host/canonical.ts";
import { gateEvidenceInputV2Schema, type EvidenceDecisionV2 } from "./schema.ts";

export function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function freezeEvidence<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}
/** Execution admissibility is not measurement authenticity, earned GREEN or acceptance. */
export const EVIDENCE_POLICY_V2 = freezeEvidence({
  id: "dokkabi.evidence.admissibility", schema_version: 2, evidence_level: "execution",
  required_identities: ["candidate", "contract", "runner", "policy", "evaluator", "metric"],
  terminal_outcomes: ["passed"],
});
export const EVIDENCE_POLICY_DIGEST_V2 = evidenceDigest(EVIDENCE_POLICY_V2);
export const evidencePolicyV2 = freezeEvidence({ version: 2, content: EVIDENCE_POLICY_V2, digest: EVIDENCE_POLICY_DIGEST_V2 });

/** Pure: enrollment, body authentication and single consumption belong to the log projection. */
export function decideEvidence(value: unknown): EvidenceDecisionV2 {
  let inputDigest: string;
  try { inputDigest = evidenceDigest(value); }
  catch { inputDigest = evidenceDigest({ malformed: true }); }
  const reasons: string[] = [];
  const decision = (): EvidenceDecisionV2 => ({ schema_version: 2, status: reasons.length ? "refused" : "admissible", reason_codes: reasons, input_digest: inputDigest });
  const parsed = gateEvidenceInputV2Schema.safeParse(value);
  if (!parsed.success) { reasons.push("malformed_input"); return decision(); }
  const { policy, context, dispatch, receipt } = parsed.data;
  const check = (same: boolean, reason: string): void => { if (!same) reasons.push(reason); };
  check(policy.version === 2, "policy_version_unknown");
  check(evidenceDigest(policy.content) === EVIDENCE_POLICY_DIGEST_V2 && policy.digest === EVIDENCE_POLICY_DIGEST_V2, "policy_content_mismatch");
  check(receipt.policy_digest === policy.digest, "policy_mismatch");
  const { context_ref, ...body } = context;
  check(context_ref.digest === evidenceDigest(body) && context_ref.blob === context_ref.digest && context_ref.blobBytes === Buffer.byteLength(canonicalJson(body)), "context_mismatch");
  check(receipt.candidate_digest === context.candidate_ref.digest, "candidate_mismatch");
  check(receipt.contract_digest === context.contract_ref.digest && dispatch.contract_ref === context.contract_ref.digest, "contract_mismatch");
  check(receipt.context_digest === context_ref.digest && dispatch.input_ref === context_ref.digest, "context_mismatch");
  check(receipt.dispatch_id === dispatch.dispatch_id && receipt.execution_id === dispatch.execution_id, "execution_mismatch");
  check(receipt.runner_digest === dispatch.runner_digest, "runner_mismatch");
  for (const key of ["evaluator_id", "evaluator_descriptor_digest", "evaluator_implementation_digest", "evaluator_config_digest", "evaluator_lifecycle_generation"] as const) {
    check(receipt[key] === dispatch[key], `${key}_mismatch`);
  }
  check(receipt.evidence_level === dispatch.evidence_level && dispatch.evidence_level === context.requirements.evidence_level, "evidence_level_mismatch");
  check(receipt.evidence_level === EVIDENCE_POLICY_V2.evidence_level, "insufficient_evidence_level");
  check(receipt.metric.unit === dispatch.expected_metric.unit && dispatch.expected_metric.unit === context.requirements.metric.unit, "metric_unit_mismatch");
  check(receipt.metric.source === dispatch.expected_metric.source && dispatch.expected_metric.source === context.requirements.metric.source, "metric_source_mismatch");
  check(receipt.outcome.status === "passed" && receipt.outcome.exit_code === 0 && receipt.outcome.signal === null, "execution_not_passed");
  check(context.authority.role !== "hidden_research_oracle" || context.authority.kind === "terminal_research", "role_phase_mismatch");
  check(context.authority.kind !== "deployment" || (context.authority.role === "deployment_checker" && ["baseline", "implement"].includes(context.authority.phase)) || (context.authority.role === "acceptance_checker" && context.authority.phase === "acceptance"), "role_phase_mismatch");
  return decision();
}
