import type { Tier2LatencyBucket } from "./runtime-tier2-types.ts";

export function tier2LatencyBucket(elapsedMs: number): Tier2LatencyBucket {
	if (elapsedMs < 1) return "under_1ms";
	if (elapsedMs < 10) return "under_10ms";
	if (elapsedMs < 100) return "under_100ms";
	if (elapsedMs < 1_000) return "under_1s";
	return "at_least_1s";
}
