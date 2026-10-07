import type { EventRecord } from "../host/schema.ts";
import { projectExperimentFacts } from "../eval/experiment/condition.ts";
import { projectObservationCoverage } from "../host/observation-schema.ts";
import { wrapText } from "./screen.ts";

/** Bounded display projection. Raw body verification remains replay-audit's
 * separate dimension; recorded labels are never external oracle truth. */
export function projectExperimentDashboard(events: readonly EventRecord[]) {
  if (!events.some(row => row.name === "experiment/bind" || row.name === "eval/ablation")) return undefined;
  try {
    const condition = projectExperimentFacts(events), coverage = projectObservationCoverage(events);
    const terminal = [...events].reverse().find(row => row.name === "work/run_result");
    const removed = condition.binding?.resolved.removed ?? [];
    const decisions = condition.decisions.flatMap(row => row.decisions);
    return { state: "recorded", requested: condition.binding?.requested.condition ?? "missing", resolved: condition.binding?.resolved.condition ?? "missing",
      evidenceLevel: removed.includes("managed_tests") ? "workspace_reported" : removed.length ? "ablated" : "full_policy",
      gaps: coverage.gaps.length, unobservedDomains: coverage.rows.filter(row => !row.count).length,
      raw: String(terminal?.payload.raw_outcome ?? terminal?.payload.status ?? "not_evaluated"),
      earned: String(terminal?.payload.earned_outcome ?? "not_evaluated"),
      shadowRefusals: decisions.filter(row => row.mode === "shadow" && row.refused === true).length,
      shadowMissing: decisions.filter(row => row.mode === "shadow" && row.refused === null).length };
  } catch {
    return { state: "invalid", requested: "invalid", resolved: "invalid", evidenceLevel: "not_evaluated", gaps: 1,
      unobservedDomains: 12, raw: "not_evaluated", earned: "not_evaluated", shadowRefusals: 0, shadowMissing: 0 };
  }
}
export type ExperimentDashboard = ReturnType<typeof projectExperimentDashboard>;

export function experimentDashboardLines(view: ExperimentDashboard, cols: number): string[] {
  if (!view) return [];
  const width = Math.max(1, cols - 2);
  return [
    `experiment=${view.requested} -> ${view.resolved}`,
    `evidence=${view.evidenceLevel} gaps=${view.gaps} unobserved=${view.unobservedDomains}`,
    `raw=${view.raw} earned=${view.earned} shadow_refuse=${view.shadowRefusals} shadow_missing=${view.shadowMissing}`,
  ].flatMap(line => wrapText(line, width));
}
