import type { EventLog } from "./event-log.ts";

/** Harness overhead above this level flags a harness problem. */
export const HARNESS_BUDGET_MS = 50;
export const HARNESS_BUDGET_RATIO = 0.1;

export type LatencyVerdict = "model_bound" | "harness_overhead" | "unknown";

export interface LatencyRow {
  /** host + command. */
  total_ms: number | "missing";
  /** Host-side overhead we measured: event appends, result capture, dispatch. */
  harness_ms: number | "missing";
  /** What the command itself took: start to end, before host post-processing. */
  command_bound_ms: number | "missing";
  verdict: LatencyVerdict;
  notes: string[];
}

export interface LatencyInput {
  name: string;
  /** Command time: tool/start to tool/end, before host post-processing. */
  duration_ms: number | "missing";
  arg_hint: string;
  result_bytes: number;
  /** Measured host work for this call (capture, appends, classification). */
  harness_ms?: number;
}

/**
 * One tool call as harness + command = total. The command time is what the
 * model chose; the harness time is ours. A healthy harness shows harness_ms
 * at noise level — anything else is overhead the model never asked for.
 */
export function latencyBreakdown(input: LatencyInput, _log?: EventLog): LatencyRow {
  const notes: string[] = [];
  if (input.duration_ms === "missing") {
    return { total_ms: "missing", harness_ms: "missing", command_bound_ms: "missing", verdict: "unknown", notes };
  }
  if (input.harness_ms === undefined) {
    notes.push("harness_ms missing: measure the host path to classify");
    return {
      total_ms: input.duration_ms,
      harness_ms: "missing",
      command_bound_ms: input.duration_ms,
      verdict: "unknown",
      notes,
    };
  }
  const harness = Math.max(0, input.harness_ms);
  const command = Math.max(0, input.duration_ms);
  const overBudget =
    harness > HARNESS_BUDGET_MS && harness > command * HARNESS_BUDGET_RATIO;
  if (overBudget) {
    notes.push(
      `harness ${harness}ms exceeds budget ${HARNESS_BUDGET_MS}ms and ${Math.round(
        HARNESS_BUDGET_RATIO * 100,
      )}% of the command`,
    );
  }
  return {
    total_ms: command + harness,
    harness_ms: harness,
    command_bound_ms: command,
    verdict: overBudget ? "harness_overhead" : "model_bound",
    notes,
  };
}
