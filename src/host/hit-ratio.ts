import type { Metric } from "./schema.ts";

/** After the cold first request, every logged hit must stay at or above this. */
export const HIT_FLOOR = 0.95;
/** First model request in a session may be a cold miss. */
export const HIT_WARMUP_TURNS = 1;
/**
 * Conservative lower bound of the provider prefix-cache TTL. The first cold
 * read after an idle gap of at least this long is provider eviction, not a
 * prefix break: our hash is unchanged and no seal was logged.
 */
export const CACHE_IDLE_EXPIRY_MS = 5 * 60_000;

/**
 * Below this occupancy the hit arithmetic cannot hold the floor even with a
 * perfect cache: hit = prefix/(prefix+delta), and at the measured p90 delta
 * (~1.6k tokens, issue #76) a 32k prefix lands right at 95%. Drops inside
 * this zone are the arithmetic, not a cache defect — the board labels the
 * zone instead of alerting on it.
 */
export const HIT_WARMUP_CONTEXT_TOKENS = 32_768;

/**
 * The token counts a hit/occupancy derivation needs, shaped like the fields
 * every `model/usage` row and dash projection already carries.
 *
 * This is the ONLY public way to derive a hit or an occupancy. Three fix
 * rounds on #76 each repaired one call site and missed others because every
 * consumer threaded loose (input, cacheRead, cacheWrite) arguments and could
 * silently drop one; passing the whole row makes "forgot the writes" not
 * expressible. The loose-argument forms below still exist for the arithmetic
 * itself, but their write parameter is REQUIRED and guarded at RUNTIME: a
 * two-argument call throws. The tsc error alone is not a fence — CI runs
 * `bun test` only, bun strips types at execution, and the manual tsc baseline
 * already accepts 86 errors, so an omitted argument would otherwise run and
 * silently return the write-blind number this whole issue was about. Failing
 * loudly is the only enforcement that actually executes.
 */
export interface UsageCounts {
  input_tokens: Metric;
  cache_read_tokens: Metric;
  cache_write_tokens?: Metric;
  /** Recorded occupancy, used only when the counts cannot answer. */
  context_used?: Metric;
}

export function hitOf(row: UsageCounts): Metric {
  return cacheHitRatio(row.input_tokens, row.cache_read_tokens, row.cache_write_tokens ?? "missing");
}

export function occupancyOf(row: UsageCounts): Metric {
  return contextOccupancy(
    row.input_tokens,
    row.cache_read_tokens,
    row.context_used ?? "missing",
    row.cache_write_tokens ?? "missing",
  );
}

/** True while a request's context occupancy sits inside the warmup zone.
 * Missing occupancy is not evidence of warmup, so it returns false. */
export function isWarmupContext(row: UsageCounts): boolean {
  const occupancy = occupancyOf(row);
  return typeof occupancy === "number" && occupancy < HIT_WARMUP_CONTEXT_TOKENS;
}

/**
 * Total tokens this request put in front of the model.
 *
 * The discriminator is structural, not a provider name: if the cached parts
 * already exceed `input`, then `input` is the uncached tail and the cached
 * parts sit beside it. Otherwise `input` is the whole prompt and the cached
 * parts are inside it — adding them again double-counts, which a fixture with
 * input=160/read=96/write=64 (96+64 == 160) showed by reading 43% instead of
 * 60%.
 *
 * Comparing `cacheRead` ALONE against input is not enough: a full reload on
 * the write-reporting convention has cacheRead=0 with 190k written, which
 * would then be filed as a 2-token prompt.
 *
 * With no writes reported this is exactly the arithmetic that was here
 * before, so no write-free provider moves.
 */
function promptTotal(input: number, cacheRead: number, cacheWrite: Metric): number {
  const written = typeof cacheWrite === "number" && cacheWrite > 0 ? cacheWrite : 0;
  return cacheRead + written > input ? input + cacheRead + written : input;
}

/**
 * Cache hit as a 0-1 fraction.
 *
 * Three provider conventions, not two:
 *  - OpenAI-style: `input` is the full prompt, prefix inside it.
 *  - Codex-style:  `input` is the uncached tail; total is input + cache_read.
 *  - Anthropic:    `input` is a constant ~2, the prefix is `cache_read`, and
 *                  the new material paid uncached this turn is `cache_write`.
 *
 * The third one is why `cacheWrite` is part of the denominator. Excluding it
 * measured a 713-request session at a 99.998% median against a true 98.991%
 * (n=710 readable rows, the product's own arithmetic),
 * and showed a request that re-paid 144,520 tokens beside a 12,135-token
 * prefix as a 99.98% hit against a true 7.75% — a ratio that ignores tokens
 * you paid for is not a hit ratio. Every other provider
 * in the corpus reports no writes, so this changes nothing for them.
 *
 * Never returns a value above 1.
 */
export function cacheHitRatio(input: Metric, cacheRead: Metric, cacheWrite: Metric): Metric {
  if (cacheWrite === undefined) {
    throw new Error("cacheHitRatio requires the cache-write metric; pass \"missing\" when unreported");
  }
  if (typeof cacheRead !== "number" || cacheRead < 0) {
    return "missing";
  }
  if (typeof input !== "number" || input < 0) {
    return "missing";
  }
  if (input === 0 && cacheRead === 0) {
    return 0;
  }
  const total = promptTotal(input, cacheRead, cacheWrite);
  if (total <= 0) {
    return "missing";
  }
  return cacheRead / total;
}

/**
 * Tokens occupying the model window on this request.
 * Codex often reports only the uncached tail as input and the prefix as cache_read.
 * In that case occupancy is input + cache_read, not input alone.
 */
export function contextOccupancy(
  input: Metric,
  cacheRead: Metric,
  recorded: Metric,
  cacheWrite: Metric,
): Metric {
  if (recorded === undefined || cacheWrite === undefined) {
    throw new Error("contextOccupancy requires all four metrics; pass \"missing\" when unreported");
  }
  if (typeof input === "number" && typeof cacheRead === "number" && cacheRead >= 0 && input >= 0) {
    return promptTotal(input, cacheRead, cacheWrite);
  }
  // Writes without a readable read count still occupied the window and were
  // still paid. A failed anthropic attempt records read="missing" with a
  // real write; falling through to `recorded` here returned the circularly
  // recorded 2 for a request that paid 99,869 tokens.
  if (typeof input === "number" && input >= 0 && typeof cacheWrite === "number" && cacheWrite > 0) {
    return input + cacheWrite;
  }
  if (typeof recorded === "number" && recorded >= 0) {
    return recorded;
  }
  if (typeof input === "number" && input >= 0) {
    return input;
  }
  return "missing";
}

export interface HitSample extends UsageCounts {
  hit_ratio?: Metric;
}

export interface HitTrack {
  series: Array<number | "missing">;
  warm: number[];
  min: Metric;
  max: Metric;
  floor: number;
  held: boolean | "missing";
}

export function hitSeriesFromUsages(usages: readonly HitSample[]): Array<number | "missing"> {
  return usages.map((row) => hitOf(row));
}

export function hitTrack(
  hits: readonly (number | "missing")[],
  warmup = HIT_WARMUP_TURNS,
  floor = HIT_FLOOR,
  skip?: readonly boolean[],
): HitTrack {
  const series = [...hits];
  const warm = series
    .slice(warmup)
    .filter((hit, index): hit is number => typeof hit === "number" && !(skip?.[index + warmup] === true));
  if (warm.length === 0) {
    return { series, warm, min: "missing", max: "missing", floor, held: "missing" };
  }
  const min = Math.min(...warm);
  const max = Math.max(...warm);
  return { series, warm, min, max, floor, held: min + 1e-12 >= floor };
}

export function fmtHitPercent(hit: number | "missing"): string {
  if (typeof hit !== "number") {
    return "-";
  }
  return `${Math.min(100, Math.max(0, Math.round(hit * 100)))}%`;
}

export function fmtHitSeries(track: HitTrack, take = 8): string {
  if (track.series.length === 0) {
    return `hits=- min=- floor=${fmtHitPercent(track.floor)} held=-`;
  }
  const shown = track.series.slice(-take).map((hit) => fmtHitPercent(hit)).join(",");
  const held = track.held === "missing" ? "-" : track.held ? "yes" : "no";
  return `hits=${shown} min=${fmtHitPercent(track.min)} floor=${fmtHitPercent(track.floor)} held=${held}`;
}
