import type { EventRecord } from "../host/schema.ts";
import type { SpeculationDashboardState } from "./events.ts";
import type { SpeculativeMode } from "./mode.ts";
import { isSpeculationV2Event, parseSpeculationV2Event, SpeculationV2Error, unreachable, validTierTool,
  type SpeculationPrepareReference, type SpeculationV2Reference } from "./events-v2-schema.ts";
export { isSpeculationV2Event, type SpeculationV2Reference } from "./events-v2-schema.ts";

export function projectSpeculationV2References(events: readonly EventRecord[], featureStart: number | undefined): SpeculationV2Reference[] {
  const references: SpeculationV2Reference[] = [];
  const active = new Map<string, SpeculationPrepareReference>();
  const seen = new Set<string>();
  let mode: SpeculativeMode | undefined;
  for (const event of events) {
    if (!isSpeculationV2Event(event.name)) {
      if (mode !== undefined && event.name.startsWith("speculation/")) throw new SpeculationV2Error(event.seq);
      continue;
    }
    if (featureStart === undefined || event.seq < featureStart) throw new SpeculationV2Error(event.seq);
    const row = parseSpeculationV2Event(event);
    if (row.name === "config_v2") {
      if (active.size > 0) throw new SpeculationV2Error(row.seq);
      mode = row.mode;
      references.push(row);
      continue;
    }
    if (mode === undefined || mode === "off") throw new SpeculationV2Error(row.seq);
    switch (row.name) {
      case "prepare":
        if (seen.has(row.candidate_id) || !validTierTool(row.tier, row.tool)
          || (mode !== "full" && row.tier !== 1)
          || (row.tier === 2 && row.source === "prediction")) throw new SpeculationV2Error(row.seq);
        seen.add(row.candidate_id);
        active.set(row.candidate_id, row);
        break;
      case "resolve": {
        const preparation = active.get(row.candidate_id);
        if (!preparation || (row.outcome === "promoted" && preparation.tier !== 2)
          || (row.outcome === "hit" && preparation.tier === 2)) throw new SpeculationV2Error(row.seq);
        active.delete(row.candidate_id);
        break;
      }
      case "recover":
        if (!active.has(row.candidate_id)) throw new SpeculationV2Error(row.seq);
        if (row.outcome !== "refused") active.delete(row.candidate_id);
        break;
      case "miss_v2":
        if (!validTierTool(row.tier, row.tool) || (mode !== "full" && row.tier !== 1)) throw new SpeculationV2Error(row.seq);
        break;
      default: unreachable(row);
    }
    references.push(row);
  }
  return references;
}

export interface SpeculationV2DashboardState extends SpeculationDashboardState {
  readonly forecastScheduled: number;
  readonly forecastHits: number;
  readonly queuedExact: number;
  readonly promotions: number;
  readonly warmOnly: number;
  readonly pending: number;
  readonly recoveries: number;
}

export function summarizeSpeculationsV2(references: readonly SpeculationV2Reference[]): SpeculationV2DashboardState | undefined {
  let mode: SpeculativeMode | undefined;
  let rulesDigest: string = "missing";
  let scheduled = 0, hits = 0, misses = 0, stale = 0, drops = 0, forecastScheduled = 0;
  let forecastHits = 0, queuedExact = 0, promotions = 0, warmOnly = 0, recoveries = 0;
  const active = new Map<string, SpeculationPrepareReference>();
  for (const row of references) {
    switch (row.name) {
      case "config_v2": mode = row.mode; rulesDigest = row.predictor_digest ?? "missing"; break;
      case "prepare":
        scheduled += 1;
        if (row.source === "prediction") forecastScheduled += 1;
        if (row.source === "queued_exact") queuedExact += 1;
        active.set(row.candidate_id, row);
        break;
      case "resolve": {
        const preparation = active.get(row.candidate_id);
        if (row.outcome === "hit" || row.outcome === "promoted") {
          hits += 1;
          if (preparation?.source === "prediction") forecastHits += 1;
        } else if (row.outcome === "stale") stale += 1;
        else if (row.outcome === "warm_only") warmOnly += 1;
        else drops += 1;
        if (row.outcome === "promoted") promotions += 1;
        active.delete(row.candidate_id);
        break;
      }
      case "recover":
        recoveries += 1;
        if (row.outcome !== "refused") active.delete(row.candidate_id);
        break;
      case "miss_v2": misses += 1; break;
      default: unreachable(row);
    }
  }
  return mode === undefined ? undefined : { mode, rulesDigest, scheduled, hits, misses, stale, drops,
    forecastScheduled, forecastHits, queuedExact, promotions, warmOnly, pending: active.size, recoveries,
    hitRatePpm: forecastScheduled === 0 ? 0 : Math.floor(forecastHits * 1_000_000 / forecastScheduled) };
}
