import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import { evidenceDigest } from "../../work/evidence/contract.ts";
import { measurementDerivationSchema, type MeasurementDerivation } from "../../work/evidence/measurements.ts";
import { projectMeasurements } from "../../work/evidence/measurement-projection.ts";
import type { EvidenceBodies } from "../../work/evidence/projection.ts";
import { decideExperimentFactors, projectExperimentCondition, type ExperimentFactor, type FactorFact } from "./condition.ts";

/** Applies policy to the already authenticated sensor derivation. The sensor
 * response, metric identities and observation boundary are never rewritten. */
export function decideMeasurementFactors(input: MeasurementDerivation, source: { seq: number; hash: string }, removed: readonly ExperimentFactor[]) {
  const raw = measurementDerivationSchema.parse(input);
  const facts: FactorFact[] = [
    { factor: "managed_tests", status: "not_applicable", reason: "observer_is_not_deployment_checker", sources: [source] },
    { factor: "thresholds", status: raw.comparisons.some(row => !row.passed) ? "refuse" : raw.comparisons.length ? "pass" : "not_applicable", reason: "measurement_comparisons", sources: [source] },
    { factor: "substrate", status: raw.witnesses.some(row => !row.passed) ? "refuse" : raw.witnesses.length ? "pass" : "not_applicable", reason: "measurement_witnesses", sources: [source] },
  ];
  const decisions = decideExperimentFactors(facts, removed);
  const reason_codes = raw.reason_codes.filter(reason => !(reason === "measurement_requirement_failed" && removed.includes("thresholds"))
    && !(reason === "measurement_witness_failed" && removed.includes("substrate")));
  return { facts, decisions, raw_status: raw.status,
    status: raw.status === "refused" ? "refused" as const : reason_codes.length ? "failed" as const : "passed" as const, reason_codes };
}

export function projectMeasurementPolicies(events: readonly EventRecord[], bodies: EvidenceBodies) {
  const condition = projectExperimentCondition(events);
  const policies = events.filter(row => row.name === "experiment/measurement_policy");
  if (!policies.length) return [];
  const measurements = projectMeasurements(events, bodies);
  return policies.map(event => {
    const p = event.payload;
    const source = events.find(row => row.seq === p.result_seq && row.hash === p.result_hash && row.name === "measurement/result" && row.seq < event.seq);
    const result = source && measurements.results.find(row => row.session_id === source.payload.session_id);
    const decision = result && measurements.decisions.find(row => row.session_id === result.session_id);
    if (!condition.binding || !source || !result || !decision || decision.status === "refused" || p.session_id !== result.session_id || p.result_digest !== source.payload.blob) throw new Error("measurement policy lacks authenticated observations");
    const session = measurements.sessions.find(row => row.session_id === result.session_id)!;
    const preparation = bodies.get(session.preparation_ref) as { fixture_digest?: string } | undefined;
    const manifest = preparation?.fixture_digest ? bodies.get(preparation.fixture_digest) as { purpose?: string } | undefined : undefined;
    if (manifest?.purpose !== "observer") throw new Error("measurement experiment lacks its observer fixture purpose");
    const expected = decideMeasurementFactors(result.derivation, { seq: source.seq, hash: source.hash }, condition.binding.resolved.removed);
    if (canonicalJson(p.decision) !== canonicalJson(expected) || p.decision_digest !== evidenceDigest(expected)) throw new Error("measurement policy differs from its raw observations");
    return { seq: event.seq, session_id: result.session_id, decision: expected };
  });
}
