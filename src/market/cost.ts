import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";

/**
 * Trial cost accounting for 돗가비 장터 search campaigns (#60 T6).
 *
 * A campaign's objective and budget filter read ONLY these aggregates, and
 * the aggregates read ONLY recorded model/usage observations (constitution
 * 5/6): reported token numbers sum, an unreported number stays counted as
 * missing — never estimated into a cell — and the wall clock comes from the
 * sessions' own recorded events. Model calls are the primary budget unit
 * (the RFC's 콜 수): every model/usage row is one ATTEMPT, including rows a
 * boundary failure recorded before the provider answered — a rate-limited
 * or failed attempt still consumed the window, and over-counting can only
 * stop a point earlier, never let it win cheap. failed_calls keeps that
 * component auditable so a network-noisy trial is distinguishable from an
 * expensive recipe (PR #93 review M3).
 */
export interface TrialCost {
  /** model/usage rows observed — attempts, the budget unit. */
  readonly calls: number;
  /** Attempts whose usage row carries a failure status. */
  readonly failed_calls: number;
  /** Sum of REPORTED input tokens; unreported rows are not guessed in. */
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** Rows whose input or output report was missing (constitution 6). */
  readonly missing_usage: number;
  /** Session logs that could not be read: no data is NOT zero spend —
   * the count keeps a broken ledger visible (PR #93 review M5). */
  readonly sessions_unreadable: number;
  /** Wall time; missing when nothing recorded enough to span. */
  readonly wall_ms: number | "missing";
}

const ZERO: TrialCost = {
  calls: 0,
  failed_calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  missing_usage: 0,
  sessions_unreadable: 0,
  wall_ms: "missing",
};

function reported(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One session's cost. Wall is the span of ITS OWN recorded events;
 * missing below two events. */
export function sessionCost(events: readonly EventRecord[]): TrialCost {
  let calls = 0;
  let failed = 0;
  let input = 0;
  let output = 0;
  let missing = 0;
  for (const event of events) {
    const usage = event.observe?.model_usage;
    if (!usage) continue;
    calls += 1;
    if (usage.status !== undefined) failed += 1;
    input += reported(usage.input_tokens);
    output += reported(usage.output_tokens);
    if (usage.input_tokens === "missing" || usage.output_tokens === "missing") missing += 1;
  }
  const first = events.at(0)?.ts;
  const last = events.at(-1)?.ts;
  const wall = events.length >= 2 && first && last ? Date.parse(last) - Date.parse(first) : Number.NaN;
  return {
    calls,
    failed_calls: failed,
    input_tokens: input,
    output_tokens: output,
    missing_usage: missing,
    sessions_unreadable: 0,
    wall_ms: Number.isFinite(wall) ? wall : "missing",
  };
}

/** Sum for SEQUENTIAL work (the campaign's per-row trials): walls add.
 * For overlapping sessions inside one trial home, use readTrialCost —
 * summing there double-counted a k>1 campaign session (PR #93 review M4). */
export function sumCosts(costs: readonly TrialCost[]): TrialCost {
  let wall: number | "missing" = "missing";
  let out = ZERO;
  for (const cost of costs) {
    if (typeof cost.wall_ms === "number") wall = (wall === "missing" ? 0 : wall) + cost.wall_ms;
    out = {
      calls: out.calls + cost.calls,
      failed_calls: out.failed_calls + cost.failed_calls,
      input_tokens: out.input_tokens + cost.input_tokens,
      output_tokens: out.output_tokens + cost.output_tokens,
      missing_usage: out.missing_usage + cost.missing_usage,
      sessions_unreadable: out.sessions_unreadable + cost.sessions_unreadable,
      wall_ms: wall,
    };
  }
  return out;
}

/**
 * Everything a trial spent, from its own isolated DOKKABI_HOME: every
 * session under it — campaign log, samples, envfix children — belongs to
 * the trial, so the sum is complete without parsing any runner output.
 * Sessions NEST in time (a k>1 campaign session brackets its samples), so
 * the trial wall is the SPAN across all sessions, never the per-session
 * sum. An unreadable log is counted, not silently read as zero spend.
 */
export function readTrialCost(home: string): TrialCost {
  let names: string[];
  try {
    names = readdirSync(join(home, "sessions"));
  } catch {
    return { ...ZERO, sessions_unreadable: 1 };
  }
  const costs: TrialCost[] = [];
  let unreadable = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const name of names) {
    try {
      const events = new EventLog(join(home, "sessions", name, "events.jsonl")).events;
      costs.push(sessionCost(events));
      for (const ts of [events.at(0)?.ts, events.at(-1)?.ts]) {
        const parsed = ts ? Date.parse(ts) : Number.NaN;
        if (Number.isFinite(parsed)) {
          earliest = Math.min(earliest, parsed);
          latest = Math.max(latest, parsed);
        }
      }
    } catch {
      unreadable += 1;
    }
  }
  const summed = sumCosts(costs);
  return {
    ...summed,
    sessions_unreadable: summed.sessions_unreadable + unreadable,
    wall_ms: Number.isFinite(earliest) && Number.isFinite(latest) && latest > earliest
      ? latest - earliest
      : "missing",
  };
}
