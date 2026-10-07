import { createHash } from "node:crypto";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import type { Case } from "../../work/schema.ts";
import { durationShortfall, hostLabelMismatch, parseSubstrateReport, substrateMismatch, substrateWitnessGap } from "../../work/case-substrate.ts";
import { parseMeasuredReport, parseThresholdReport, thresholdMismatch } from "../../work/case-thresholds.ts";
import { projectObligations } from "../../work/evidence/obligations.ts";
import type { EvidenceBodies } from "../../work/evidence/projection.ts";
import { decideExperimentFactors, projectExperimentCondition, type ExperimentFactor, type FactorFact } from "./condition.ts";

/** Pure legacy workspace-report predicates. Removing a check never raises
 * these facts to attested measurement evidence. */
export function decideCaseFactors(item: Case, output: string, durationMs: number, host: string,
  source: { seq: number; hash: string }, removed: readonly ExperimentFactor[]) {
  if (!Number.isFinite(durationMs) || durationMs < 0 || typeof host !== "string") throw new Error("case observation metadata unavailable");
  const substrate = parseSubstrateReport(output);
  const mismatch = substrateMismatch(item.substrate, substrate) ?? substrateWitnessGap(item.substrate, substrate, output, item.witness_for);
  const duration = durationShortfall(item.min_duration_ms, durationMs);
  const location = hostLabelMismatch(item.host, host, output);
  const threshold = thresholdMismatch(item.thresholds, parseThresholdReport(output), parseMeasuredReport(output));
  const facts: FactorFact[] = [
    { factor: "substrate", status: mismatch || duration ? "refuse" : item.substrate || item.witness_for || item.min_duration_ms !== undefined ? "pass" : "not_applicable", reason: mismatch || duration ? "substrate_requirement_failed" : "substrate_observed", sources: [source] },
    { factor: "thresholds", status: threshold ? "refuse" : item.thresholds ? "pass" : "not_applicable", reason: threshold ? "threshold_requirement_failed" : "threshold_observed", sources: [source] },
  ];
  const decisions = decideExperimentFactors(facts, removed);
  const activeReason = (!removed.includes("substrate") ? mismatch : undefined) ?? location
    ?? (!removed.includes("thresholds") ? threshold : undefined) ?? (!removed.includes("substrate") ? duration : undefined);
  return { facts, decisions, full_reason: mismatch ?? location ?? threshold ?? duration ?? null, active_reason: activeReason ?? null };
}

export function projectCasePolicies(events: readonly EventRecord[], bodies: EvidenceBodies = new Map()) {
  const condition = projectExperimentCondition(events), references = [];
  for (const event of events) {
    if (event.name !== "experiment/case_policy") continue;
    const p = event.payload, prefix = events.filter(row => row.seq < event.seq);
    const item = projectObligations(prefix).current?.plan.cases.find(item => item.id === p.case_id);
    const source = prefix.find(row => row.seq === p.result_seq && row.name === "tool/result" && row.hash === p.result_hash);
    if (!condition.binding || !item || !source || source.payload.error !== false || source.payload.exit_code !== 0) throw new Error("case policy lacks its bound execution");
    const output = typeof source.payload.blob === "string" ? bodies.get(source.payload.blob) : source.payload.text;
    if (typeof output !== "string" || (typeof source.payload.blob === "string" && createHash("sha256").update(output).digest("hex") !== source.payload.blob)) throw new Error("case policy raw output unavailable");
    const expected = decideCaseFactors(item, output, p.duration_ms as number, p.host_label as string,
      { seq: source.seq, hash: source.hash }, condition.binding.resolved.removed);
    if (canonicalJson(p.decision) !== canonicalJson(expected)) throw new Error("case policy differs from its raw observations");
    references.push({ seq: event.seq, case_id: item.id, decision: expected });
  }
  return references;
}
