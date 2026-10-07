import type { RecoveryEpisode } from "./recovery.ts";
import type { FailoverContinuityV1, FailoverMode, ModelCost, ModelRouteSelection } from "./model-failover.ts";
import type { FailoverSessionPhase } from "./model-failover-session.ts";

export interface ModelResilienceCandidateViewV1 extends ModelRouteSelection {
  auth: "connected" | "missing" | "expired" | "unknown";
  cost: ModelCost;
  eligibility: "primary" | "active" | "eligible" | "ineligible";
  quota: {
    freshness: "fresh" | "stale" | "unknown";
    windows: string[];
  };
}

export interface ModelResilienceViewV1 {
  recovery?: RecoveryEpisode[];
  mode: FailoverMode;
  state: FailoverSessionPhase;
  primary: ModelRouteSelection;
  active: ModelRouteSelection;
  continuity: FailoverContinuityV1;
  lastTransition?: string;
  candidates: ModelResilienceCandidateViewV1[];
}

/** One formatter is shared by CLI/TUI notices and the compact remote status
 * contribution. Inputs are already normalized public metadata. */
export function formatModelResilienceStatus(
  view: ModelResilienceViewV1,
  options: { compact?: boolean } = {},
): string {
  const head = options.compact
    ? `failover=${view.mode}/${view.state}`
    : `failover=${view.mode} state=${view.state}`;
  const episode = view.recovery?.at(-1);
  const recovery = episode ? ` recovery=${episode.reason === "reconciliation_required" ? "reconciling" : episode.inFlight ? "reserved" : episode.state} attempts=${episode.attempts}/${episode.effectiveMaxAttempts} original_limit=${episode.maxAttempts} deadline=${Math.min(episode.effectiveDeadlineMs ?? Infinity, episode.effectiveRecoveryDeadline)} dispatches=${episode.dispatches} due=${episode.dueAt ?? "none"} tokens=${episode.tokens ?? "unknown"} cost=${episode.cost ?? "unknown"}` : "";
  const selections = `primary=${name(view.primary)} active=${name(view.active)} continuity=${view.continuity}`;
  if (options.compact) {
    const active = view.candidates.find((candidate) => candidate.eligibility === "active");
    return `${head} ${selections} auth=${active?.auth ?? "unknown"} cost=${active?.cost ?? "unknown"} quota=${active?.quota.freshness ?? "unknown"}${recovery}`;
  }
  const candidates = view.candidates.length === 0
    ? "candidates=none"
    : `candidates=${view.candidates.map((candidate, index) => {
        const windows = candidate.quota.windows.length > 0 ? candidate.quota.windows.join(",") : "unknown";
        return `${index + 1}:${name(candidate)} auth=${candidate.auth} cost=${candidate.cost} ${candidate.eligibility} quota=${candidate.quota.freshness}[${windows}]`;
      }).join(" | ")}`;
  return `${head} ${selections} ${candidates}${view.lastTransition ? ` last=${view.lastTransition}` : ""}${recovery}`;
}

function name(selection: ModelRouteSelection): string {
  return `${selection.route}/${selection.model}`;
}
