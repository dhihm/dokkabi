import type { EventRecord } from "../host/schema.ts";
import type { CoEditRule } from "./coedit.ts";
import { acceptedSpeculativeTrajectories } from "./trajectories.ts";
import {
  SPECULATIVE_RULES_SCHEMA,
  SpeculativeRulesError,
  type SpeculativeRules,
  type SpeculativeTransition,
} from "./rules-schema.ts";
export {
  canonicalSpeculativeRules,
  parseSpeculativeRules,
} from "./rules-codec.ts";
export {
  SPECULATIVE_RULES_SCHEMA,
  SpeculativeRulesError,
  type SpeculativeRules,
  type SpeculativeTransition,
} from "./rules-schema.ts";

interface CompletedCall {
  readonly tool: string;
  readonly error: boolean;
  readonly exitCode: number | null;
}

export function compileSpeculativeRules(
  events: readonly EventRecord[],
  coEdits: readonly CoEditRule[] = [],
): SpeculativeRules {
  const trajectories = acceptedSpeculativeTrajectories(events);
  if (trajectories.length === 0) throw new SpeculativeRulesError("no accepted EventLog trajectories to compile");
  const counts = new Map<string, number>();
  const totals = new Map<string, number>();
  let samples = 0;
  for (const trajectory of trajectories) {
    const calls = completedCalls(trajectory);
    for (let index = 0; index + 1 < calls.length; index += 1) {
      const previous = calls[index];
      const next = calls[index + 1];
      if (!previous || !next) continue;
      const feature = featureKey(previous.tool, previous.error, previous.exitCode);
      const transition = transitionKey(previous.tool, previous.error, previous.exitCode, next.tool);
      counts.set(transition, (counts.get(transition) ?? 0) + 1);
      totals.set(feature, (totals.get(feature) ?? 0) + 1);
      samples += 1;
    }
  }
  if (samples === 0) throw new SpeculativeRulesError("accepted trajectories contain no completed tool transitions");
  const transitions = [...counts.entries()].map(([key, count]) => {
    const [previous_tool, encodedError, previousExitCode, next_tool] = JSON.parse(key) as [string, boolean, number | null, string];
    const total = totals.get(featureKey(previous_tool, encodedError, previousExitCode));
    if (total === undefined) throw new SpeculativeRulesError("transition total is missing");
    return {
      previous_tool,
      previous_error: encodedError,
      previous_exit_code: previousExitCode,
      next_tool,
      count,
      total,
      probability_ppm: Math.floor(count * 1_000_000 / total),
    };
  }).sort(compareTransition);
  return {
    schema: SPECULATIVE_RULES_SCHEMA,
    trajectories: trajectories.length,
    samples,
    transitions,
    co_edits: [...coEdits],
  };
}

export function evaluateSpeculativeRules(
  rules: SpeculativeRules,
  events: readonly EventRecord[],
): { readonly hits: number; readonly total: number } {
  const predictions = bestPredictions(rules);
  let hits = 0;
  let total = 0;
  for (const trajectory of acceptedSpeculativeTrajectories(events)) {
    const calls = completedCalls(trajectory);
    for (let index = 0; index + 1 < calls.length; index += 1) {
      const previous = calls[index];
      const next = calls[index + 1];
      if (!previous || !next) continue;
      total += 1;
      if (predictions.get(featureKey(previous.tool, previous.error, previous.exitCode)) === next.tool) hits += 1;
    }
  }
  return { hits, total };
}

export function candidateImproves(
  candidate: SpeculativeRules,
  baseline: SpeculativeRules,
  events: readonly EventRecord[],
): boolean {
  const next = evaluateSpeculativeRules(candidate, events);
  const current = evaluateSpeculativeRules(baseline, events);
  if (next.total === 0 || current.total !== next.total) return false;
  return next.hits * current.total > current.hits * next.total;
}

export function predictNextTool(
  rules: SpeculativeRules,
  previousTool: string,
  previousError: boolean,
  previousExitCode: number | null = null,
): string | undefined {
  return bestPredictions(rules).get(featureKey(previousTool, previousError, previousExitCode));
}

export type ToolPredictor = (
  previousTool: string,
  previousError: boolean,
  previousExitCode?: number | null,
) => string | undefined;

export function createToolPredictor(rules: SpeculativeRules): ToolPredictor {
  const predictions = bestPredictions(rules);
  return (tool, error, exitCode = null) => predictions.get(featureKey(tool, error, exitCode));
}

function completedCalls(events: readonly EventRecord[]): CompletedCall[] {
  const calls: Array<{ readonly id: string; readonly tool: string }> = [];
  const calledIds = new Set<string>();
  const results = new Map<string, CompletedCall>();
  for (const event of events) {
    if (event.name === "tool/call") {
      const id = toolField(event, "id");
      const tool = toolField(event, "tool");
      if (calledIds.has(id)) throw new SpeculativeRulesError(`duplicate tool call ${id}`);
      calledIds.add(id);
      calls.push({ id, tool });
    }
    if (event.name === "tool/result") {
      if (typeof event.payload.id !== "string" || !calledIds.has(event.payload.id)) continue;
      const id = toolField(event, "id");
      const tool = toolField(event, "tool");
      if (typeof event.payload.error !== "boolean") throw new SpeculativeRulesError(`tool result ${id} has no error flag`);
      if (results.has(id)) throw new SpeculativeRulesError(`duplicate tool result ${id}`);
      const exitCode = event.payload.exit_code;
      if (exitCode !== undefined && (!Number.isSafeInteger(exitCode) || Number(exitCode) < 0)) {
        throw new SpeculativeRulesError(`tool result ${id} has invalid exit_code`);
      }
      results.set(id, { tool, error: event.payload.error, exitCode: exitCode === undefined ? null : Number(exitCode) });
    }
  }
  return calls.flatMap((call) => {
    const result = results.get(call.id);
    if (!result) return [];
    if (result.tool !== call.tool) throw new SpeculativeRulesError(`tool identity mismatch for ${call.id}`);
    return [result];
  });
}

function bestPredictions(rules: SpeculativeRules): Map<string, string> {
  const best = new Map<string, SpeculativeTransition>();
  for (const row of rules.transitions) {
    const key = featureKey(row.previous_tool, row.previous_error, row.previous_exit_code);
    const current = best.get(key);
    if (!current || row.count > current.count || (row.count === current.count && row.next_tool < current.next_tool)) {
      best.set(key, row);
    }
  }
  return new Map([...best].map(([key, row]) => [key, row.next_tool]));
}

function toolField(event: EventRecord, field: "id" | "tool"): string {
  if (field === "id") {
    const id = event.payload.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 1024 || /[\u0000-\u001f\u007f]/u.test(id)) {
      throw new SpeculativeRulesError(`${event.name} id is invalid`);
    }
    return id;
  }
  if (event.name === "tool/call" && event.payload.name !== undefined) {
    if (event.payload.tool !== undefined && event.payload.tool !== event.payload.name) {
      throw new SpeculativeRulesError("tool call has conflicting names");
    }
    return toolName(event.payload.name, "tool/call name");
  }
  return toolName(event.payload.tool, `${event.name} tool`);
}

function toolName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) throw new SpeculativeRulesError(`${label} is invalid`);
  return value;
}

function featureKey(tool: string, error: boolean, exitCode: number | null): string {
  return JSON.stringify([tool, error, exitCode]);
}

function transitionKey(previous: string, error: boolean, exitCode: number | null, next: string): string {
  return JSON.stringify([previous, error, exitCode, next]);
}

function compareTransition(left: SpeculativeTransition, right: SpeculativeTransition): number {
  return left.previous_tool.localeCompare(right.previous_tool)
    || Number(left.previous_error) - Number(right.previous_error)
    || (left.previous_exit_code ?? -1) - (right.previous_exit_code ?? -1)
    || left.next_tool.localeCompare(right.next_tool);
}
