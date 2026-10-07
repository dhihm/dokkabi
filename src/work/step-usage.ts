import type { EventRecord, Metric } from "../host/schema.ts";

/**
 * What one isolated step cost (#77 T9).
 *
 * A step runs in its own session, so its `model/usage` rows are in the CHILD
 * log — an operator asking "what did that step cost" would otherwise have to
 * open a second file and add the rows up by hand. The parent records the
 * summary once, next to the step's other evidence.
 *
 * Record-only. Nothing in the loop reads this to decide anything: the moment
 * a cost number steers control flow it needs an accounting model the RFC has
 * not settled (#60, item 3).
 *
 * A field nothing measured stays `missing`. Summing a missing metric as zero
 * would put a number in a cell that was never observed — the one thing the
 * dashboard rule forbids (constitution 6).
 */

const SUMMED = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;

type SummedField = (typeof SUMMED)[number];

export interface StepUsageSummary {
  readonly turns: number;
  readonly input_tokens: Metric;
  readonly output_tokens: Metric;
  readonly reasoning_tokens: Metric;
  readonly cache_read_tokens: Metric;
  readonly cache_write_tokens: Metric;
  /** Context is a level, not a flow: the peak the step reached. */
  readonly context_used_max: Metric;
  readonly context_window: Metric;
  /** Usage rows that left at least one field unmeasured. */
  readonly missing: number;
}

export function summariseStepUsage(events: readonly EventRecord[]): StepUsageSummary {
  const totals = new Map<SummedField, number>();
  const measured = new Set<SummedField>();
  let turns = 0;
  let missing = 0;
  let contextUsedMax: number | undefined;
  let contextWindow: number | undefined;

  for (const event of events) {
    const usage = event.observe?.model_usage;
    if (!usage) continue;
    // A failed generation is still a turn: it spent the context and the wall
    // clock even though it returned nothing.
    turns += 1;
    let gap = false;
    for (const field of SUMMED) {
      const value = usage[field];
      if (typeof value === "number") {
        totals.set(field, (totals.get(field) ?? 0) + value);
        measured.add(field);
      } else {
        gap = true;
      }
    }
    if (typeof usage.context_used === "number") {
      contextUsedMax = Math.max(contextUsedMax ?? 0, usage.context_used);
    } else {
      gap = true;
    }
    if (typeof usage.context_window === "number") {
      contextWindow = Math.max(contextWindow ?? 0, usage.context_window);
    } else {
      gap = true;
    }
    if (gap) missing += 1;
  }

  const summed = (field: SummedField): Metric => measured.has(field) ? totals.get(field)! : "missing";
  return {
    turns,
    input_tokens: summed("input_tokens"),
    output_tokens: summed("output_tokens"),
    reasoning_tokens: summed("reasoning_tokens"),
    cache_read_tokens: summed("cache_read_tokens"),
    cache_write_tokens: summed("cache_write_tokens"),
    context_used_max: contextUsedMax ?? "missing",
    context_window: contextWindow ?? "missing",
    missing,
  };
}
