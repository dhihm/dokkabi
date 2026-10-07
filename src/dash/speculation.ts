import type { SpeculationDashboardState } from "../speculative/events.ts";
import type { SpeculationV2DashboardState } from "../speculative/events-v2.ts";

export interface SpeculationDisplay {
  readonly text: string;
  readonly compact: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

export function speculationDisplay(state: SpeculationDashboardState | undefined): SpeculationDisplay | undefined {
  if (!state) return undefined;
  if (!isV2(state)) {
    const rate = percent(state.hitRatePpm);
    return {
      text: `mode=${state.mode} scheduled=${state.scheduled} hits=${state.hits} (${rate}) misses=${state.misses} stale=${state.stale} drops=${state.drops}`,
      compact: `spec ${state.mode} h${state.hits}/${state.scheduled} ${rate} m${state.misses} s${state.stale} d${state.drops}`,
      rows: [
        { label: "mode", value: state.mode },
        { label: "hits", value: `${state.hits} / ${state.scheduled} · ${rate}` },
        { label: "miss / stale", value: `${state.misses} / ${state.stale}` },
        { label: "drops", value: String(state.drops) },
      ],
    };
  }
  const rate = percent(state.hitRatePpm);
  return {
    text: `mode=${state.mode} pending=${state.pending} forecast=${state.forecastHits}/${state.forecastScheduled} (${rate}) queued_exact=${state.queuedExact} promoted=${state.promotions} warm_only=${state.warmOnly} recovery_events=${state.recoveries} (includes refusals)`,
    compact: `spec ${state.mode} p${state.pending} f${state.forecastHits}/${state.forecastScheduled} ${rate} q${state.queuedExact} +${state.promotions} w${state.warmOnly} r${state.recoveries}`,
    rows: [
      { label: "mode", value: state.mode },
      { label: "pending", value: String(state.pending) },
      { label: "forecast", value: `${state.forecastHits} / ${state.forecastScheduled} · ${rate}` },
      { label: "queued exact", value: String(state.queuedExact) },
      { label: "promotions", value: String(state.promotions) },
      { label: "warm-only", value: String(state.warmOnly) },
      { label: "recovery events", value: `${state.recoveries} · includes refusals` },
    ],
  };
}

function isV2(state: SpeculationDashboardState): state is SpeculationV2DashboardState {
  return "forecastScheduled" in state
    && "forecastHits" in state
    && "queuedExact" in state
    && "promotions" in state
    && "warmOnly" in state
    && "pending" in state
    && "recoveries" in state;
}

function percent(ppm: number): string {
  const tenths = Math.floor(ppm / 1_000) / 10;
  return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)}%`;
}
