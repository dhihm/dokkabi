import type { SandboxExecutionResult } from "../../host/sandbox.ts";
import { completeAcceptanceSpec, type AcceptanceContract, type AcceptanceTemplate } from "./acceptance-contract.ts";
import { evidenceDigest } from "./contract.ts";

export type AcceptanceStatus = "accepted" | "rejected" | "inconclusive";
export interface AcceptanceProbeFact {
  check_id: string;
  contract_digest: string;
  specification_digest: string;
  candidate_digest: string;
  template: AcceptanceTemplate;
  process: SandboxExecutionResult;
  execution_id: string;
  receipt_digest: string;
}

/** Candidate output is compared by the host against a visible enrolled public
 * behavior template. A self-reported PASS or test-runner success is not read. */
export function deriveAcceptanceProbe(template: AcceptanceTemplate, result: SandboxExecutionResult): "passed" | "failed" | "unavailable" {
  if (result.rawExitCode === null || result.error !== undefined || result.signal !== undefined || result.timedOut || result.maxBufferExceeded || result.completionUnavailable ||
    !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode >= 126 || typeof result.stdoutBase64 !== "string" || typeof result.stderrBase64 !== "string") return "unavailable";
  return result.exitCode === template.expected.exit_code && result.stdoutBase64 === Buffer.from(template.expected.stdout).toString("base64") &&
    result.stderrBase64 === Buffer.from(template.expected.stderr).toString("base64") ? "passed" : "failed";
}

/** Pure policy shared with replay. Authentication of native executions and
 * receipts is a prerequisite; model/tool payloads never construct these facts. */
export function deriveAcceptanceDecision(input: {
  required_ids: readonly string[]; contract_digest: string; specification_digest: string; candidate_digest: string;
  contract: AcceptanceContract; specification: string;
  facts: readonly AcceptanceProbeFact[]; specification_complete: boolean; candidate_current: boolean;
}): { status: AcceptanceStatus; reason: string; missing_ids: string[] } {
  const missing = input.required_ids.filter(id => !input.facts.some(fact => fact.check_id === id));
  const inconclusive = (reason: string) => ({ status: "inconclusive" as const, reason, missing_ids: missing });
  if (!input.required_ids.length || new Set(input.required_ids).size !== input.required_ids.length) return inconclusive("required_inventory_missing");
  if (input.contract_digest !== evidenceDigest(input.contract) || input.specification_digest !== evidenceDigest({ contract: input.contract, review: input.specification }) ||
    evidenceDigest(input.required_ids) !== evidenceDigest(input.contract.required_checks.map(check => check.id))) return inconclusive("contract_inventory_mismatch");
  if (!input.specification_complete || !completeAcceptanceSpec(input.specification, input.contract)) return inconclusive("required_specification_incomplete");
  if (!input.candidate_current) return inconclusive("candidate_or_contract_changed");
  if (new Set(input.facts.map(fact => fact.check_id)).size !== input.facts.length || new Set(input.facts.map(fact => fact.execution_id)).size !== input.facts.length ||
    input.facts.some(fact => !input.required_ids.includes(fact.check_id) || fact.contract_digest !== input.contract_digest ||
      fact.specification_digest !== input.specification_digest || fact.candidate_digest !== input.candidate_digest ||
      evidenceDigest(fact.template) !== evidenceDigest(input.contract.templates.find(template => template.id === input.contract.required_checks.find(check => check.id === fact.check_id)?.template_id)))) return inconclusive("probe_binding_mismatch");
  if (input.facts.some(fact => deriveAcceptanceProbe(fact.template, fact.process) === "failed")) return { status: "rejected", reason: "executed_counterexample", missing_ids: missing };
  if (missing.length || input.facts.some(fact => deriveAcceptanceProbe(fact.template, fact.process) === "unavailable")) return inconclusive("required_execution_incomplete");
  return { status: "accepted", reason: "complete_executed_set", missing_ids: [] };
}
