import {
  CACHE_IDLE_EXPIRY_MS,
  hitOf,
  occupancyOf,
  HIT_WARMUP_CONTEXT_TOKENS,
  HIT_WARMUP_TURNS,
} from "./hit-ratio.ts";
import type { EventRecord, Metric } from "./schema.ts";

/**
 * Re-derive #76's cache-hit analysis from a session log.
 *
 * That issue concluded — correctly — that 98–99% is already held above ~100k
 * context and that sub-94% numbers are explained by warmup arithmetic, cold
 * reloads, and tool-heavy deltas. But the analysis lived as a markdown table
 * computed once, by hand, from one 2026-08-24 log. An analysis nobody can
 * re-run is a claim, not a fact, so this is the same derivation as code.
 *
 * `hit = prefix / (prefix + delta)`. The delta is new input that must be paid
 * uncached exactly once, so the ceiling is arithmetic and the interesting
 * question is never "is hit below 98" — it is which requests are cold for a
 * reason nothing on the log explains.
 */

export interface HitContextBucket {
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

/** The occupancy bands #76 reported, kept so the table stays comparable. */
export const HIT_CONTEXT_BUCKETS: readonly HitContextBucket[] = [
  { label: "<20k", min: 0, max: 20_000 },
  { label: "20–50k", min: 20_000, max: 50_000 },
  { label: "50–100k", min: 50_000, max: 100_000 },
  { label: "100–200k", min: 100_000, max: 200_000 },
  { label: "≥200k", min: 200_000, max: Number.POSITIVE_INFINITY },
];

/** Why a request read nothing from cache. Only `unexplained` is a finding —
 * the rest are the log accounting for itself. */
export type ColdCause = "idle_expiry" | "sealed" | "unexplained";

export interface ColdRequest {
  readonly seq: number;
  readonly ts: string;
  readonly occupancy: number;
  readonly cause: ColdCause;
  /** Milliseconds since the previous model request, when both are timed. */
  readonly gapMs?: number;
}

export interface HitBucketReport {
  readonly label: string;
  readonly requests: number;
  readonly medianHit: Metric;
  /** Share of this bucket's requests at or above 98%. */
  readonly atLeast98: Metric;
}

export interface HitAnalysisReport {
  readonly format: 1;
  readonly requests: number;
  /** Usage rows the analysis could not read (no numeric hit or occupancy).
   * Reported beside `requests` so a denominator never silently excludes
   * data — a 147-request vllm session that reports no cache usage at all
   * printed a clean empty table without saying it had read nothing. */
  readonly skipped: number;
  readonly routes: readonly string[];
  readonly buckets: readonly HitBucketReport[];
  /** Requests inside the zone where a perfect cache still cannot hold the
   * floor. Counting these as failures is what made a healthy run look broken. */
  readonly warmupRequests: number;
  readonly colds: readonly ColdRequest[];
  readonly unexplainedColds: readonly ColdRequest[];
  readonly deltaMedian: Metric;
  readonly deltaP90: Metric;
  /** Context occupancy the median delta needs to reach 98% / 99%. */
  readonly contextFor98: Metric;
  readonly contextFor99: Metric;
}

/** A cold read on a trivial prompt is not evidence of anything. Measured
 * against OCCUPANCY, not `input`: on Anthropic `input` is a constant ~2, so an
 * input-keyed floor made the cold detector structurally unreachable there —
 * a 713-request session with 32 full reloads reported zero. */
const COLD_OCCUPANCY_FLOOR = 1_000;

/** Nearest-rank. With a handful of samples the interpolating conventions put
 * "p90" in the middle of the set, which is the opposite of what a tail
 * statistic is for. */
function quantile(values: readonly number[], fraction: number): Metric {
  if (values.length === 0) return "missing";
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

/** prefix such that prefix/(prefix+delta) = target. */
function contextForTarget(delta: Metric, target: number): Metric {
  if (typeof delta !== "number" || delta <= 0) return "missing";
  return Math.round((delta * target) / (1 - target));
}

export function analyzeHitRatio(events: readonly EventRecord[]): HitAnalysisReport {
  const rows: {
    seq: number; ts: string; hit: number; occupancy: number; delta: number;
    cold: boolean; route: string; skippedPaidBefore: boolean; previousTs?: string;
  }[] = [];
  const sealSeqs: number[] = [];
  let skipped = 0;
  // The timestamp of the previous model REQUEST, whether or not the analysis
  // could read it. Measuring the gap to the previous ACCEPTED row let a
  // skipped attempt — which cluster around retries and route switches, the
  // exact place colds happen — stretch the gap past the idle threshold and
  // downgrade a real finding to "provider TTL, nothing to see here".
  let previousUsageTs: string | undefined;
  let paidSinceReadable = false;
  for (const event of events) {
    if (event.name === "prompt/seal") sealSeqs.push(event.seq);
    const usage = event.observe?.model_usage;
    if (!usage) continue;
    const priorTs = previousUsageTs;
    previousUsageTs = event.ts;
    const hit = hitOf(usage);
    const occupancy = occupancyOf(usage);
    if (typeof hit !== "number" || typeof occupancy !== "number") {
      skipped += 1;
      // An unreadable attempt can still have PAID the prefix (anthropic bills
      // cache_write on failed requests). If one did after the last readable
      // row, a later cold cannot be explained by a seal — the seal's reload
      // already happened on the attempt, and the cold is a second drop.
      if (typeof usage.cache_write_tokens === "number" && usage.cache_write_tokens > 0) {
        paidSinceReadable = true;
      }
      continue;
    }
    const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const cacheRead = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : 0;
    const cacheWrite = typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : 0;
    // The NEW material paid uncached this turn. Anthropic reports it as
    // `cache_write`; the other conventions leave it inside `input`.
    const delta = cacheWrite > 0
      ? cacheWrite + input
      : cacheRead > input ? input : Math.max(0, input - cacheRead);
    rows.push({
      seq: event.seq,
      ts: event.ts,
      hit,
      occupancy,
      delta,
      cold: cacheRead === 0 && occupancy > COLD_OCCUPANCY_FLOOR,
      route: typeof usage.route === "string" ? usage.route : "missing",
      skippedPaidBefore: paidSinceReadable,
      ...(priorTs ? { previousTs: priorTs } : {}),
    });
    paidSinceReadable = false;
  }

  const buckets = HIT_CONTEXT_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((row) => row.occupancy >= bucket.min && row.occupancy < bucket.max);
    const hits = inBucket.map((row) => row.hit);
    return {
      label: bucket.label,
      requests: inBucket.length,
      medianHit: quantile(hits, 0.5),
      atLeast98: inBucket.length === 0
        ? ("missing" as Metric)
        : hits.filter((hit) => hit >= 0.98).length / inBucket.length,
    };
  });

  const colds: ColdRequest[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.cold) continue;
    // The first request of a session is expected to be cold (HIT_WARMUP_TURNS
    // in hit-ratio.ts says so in as many words). Reporting it as a provider
    // fault made the tool's only failure signal fire on essentially every
    // session that opens with a seal.
    if (index < HIT_WARMUP_TURNS) continue;
    const parsedGap = row.previousTs && row.ts
      ? Date.parse(row.ts) - Date.parse(row.previousTs)
      : Number.NaN;
    const gapMs = Number.isFinite(parsedGap) ? parsedGap : undefined;
    // A seal between the two requests changed the prefix by design, so the
    // reload is the seal's cost, not a cache defect.
    // Two different windows, on purpose, because the two explanations have
    // different evidentiary weight. The GAP is a downgrading heuristic (a
    // failed attempt in between may or may not have refreshed the provider
    // TTL), so it takes the SHORTEST window — the previous request of any
    // kind — and keeps findings alive. A SEAL is deterministic evidence the
    // prefix changed, so it takes the window since the last READABLE request:
    // warm → seal → unreadable attempt → cold is a sealed cold, and the
    // narrower previous-event window called it unexplained and failed CI on a
    // shape that happens on every retry after a seal.
    const previous = rows[index - 1];
    const sealed = previous !== undefined
      && !row.skippedPaidBefore
      && sealSeqs.some((seal) => seal > previous.seq && seal < row.seq);
    const cause: ColdCause = typeof gapMs === "number" && gapMs >= CACHE_IDLE_EXPIRY_MS
      ? "idle_expiry"
      : sealed
        ? "sealed"
        : "unexplained";
    colds.push({
      seq: row.seq,
      ts: row.ts,
      occupancy: row.occupancy,
      cause,
      ...(typeof gapMs === "number" ? { gapMs } : {}),
    });
  }

  const deltas = rows.map((row) => row.delta);
  const deltaMedian = quantile(deltas, 0.5);
  return {
    format: 1,
    requests: rows.length,
    skipped,
    routes: [...new Set(rows.map((row) => row.route))].sort(),
    buckets,
    warmupRequests: rows.filter((row) => row.occupancy < HIT_WARMUP_CONTEXT_TOKENS).length,
    colds,
    unexplainedColds: colds.filter((row) => row.cause === "unexplained"),
    deltaMedian,
    deltaP90: quantile(deltas, 0.9),
    contextFor98: contextForTarget(deltaMedian, 0.98),
    contextFor99: contextForTarget(deltaMedian, 0.99),
  };
}
