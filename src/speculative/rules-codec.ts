import { canonicalJson } from "../host/canonical.ts";
import type { CoEditRule } from "./coedit.ts";
import {
  SPECULATIVE_RULES_SCHEMA,
  SpeculativeRulesError,
  type SpeculativeRules,
  type SpeculativeTransition,
} from "./rules-schema.ts";

export function canonicalSpeculativeRules(rules: SpeculativeRules): string {
  return `${canonicalJson(rules)}\n`;
}

export function parseSpeculativeRules(text: string): SpeculativeRules {
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new SpeculativeRulesError("rules document exceeds 1 MiB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SpeculativeRulesError("rules document is not valid JSON");
  }
  const root = exactRecord(value, ["schema", "trajectories", "samples", "transitions", "co_edits"], "rules document");
  if (root.schema !== SPECULATIVE_RULES_SCHEMA) throw new SpeculativeRulesError("unsupported rules schema");
  const trajectories = positiveInteger(root.trajectories, "trajectories");
  const samples = positiveInteger(root.samples, "samples");
  if (!Array.isArray(root.transitions) || root.transitions.length > 10_000) {
    throw new SpeculativeRulesError("transitions must be a bounded array");
  }
  const transitions = root.transitions.map((row, index) => parseTransition(row, index));
  if (!Array.isArray(root.co_edits) || root.co_edits.length > 512) {
    throw new SpeculativeRulesError("co_edits must be a bounded array");
  }
  const co_edits = root.co_edits.map((row, index) => parseCoEdit(row, index));
  for (let index = 1; index < co_edits.length; index += 1) {
    const previous = co_edits[index - 1];
    const current = co_edits[index];
    if (!previous || !current) continue;
    if (previous.source > current.source || (previous.source === current.source && previous.target >= current.target)) {
      throw new SpeculativeRulesError("co_edits must be unique and sorted");
    }
  }
  const rules = { schema: SPECULATIVE_RULES_SCHEMA, trajectories, samples, transitions, co_edits };
  if (canonicalSpeculativeRules(rules) !== text) throw new SpeculativeRulesError("rules document is not canonical");
  return rules;
}

function parseTransition(value: unknown, index: number): SpeculativeTransition {
  const row = exactRecord(value, [
    "previous_tool", "previous_error", "previous_exit_code", "next_tool", "count", "total", "probability_ppm",
  ], `transition ${index}`);
  const previous_tool = toolName(row.previous_tool, `transition ${index} previous_tool`);
  const next_tool = toolName(row.next_tool, `transition ${index} next_tool`);
  if (typeof row.previous_error !== "boolean") throw new SpeculativeRulesError(`transition ${index} previous_error must be boolean`);
  const previous_exit_code = row.previous_exit_code === null
    ? null
    : nonnegativeInteger(row.previous_exit_code, `transition ${index} previous_exit_code`);
  const count = positiveInteger(row.count, `transition ${index} count`);
  const total = positiveInteger(row.total, `transition ${index} total`);
  if (count > total) throw new SpeculativeRulesError(`transition ${index} count exceeds total`);
  const probability_ppm = nonnegativeInteger(row.probability_ppm, `transition ${index} probability_ppm`);
  if (probability_ppm !== Math.floor(count * 1_000_000 / total)) {
    throw new SpeculativeRulesError(`transition ${index} probability is inconsistent`);
  }
  return { previous_tool, previous_error: row.previous_error, previous_exit_code, next_tool, count, total, probability_ppm };
}

function parseCoEdit(value: unknown, index: number): CoEditRule {
  const row = exactRecord(value, ["source", "target", "count"], `co-edit ${index}`);
  const source = repositoryPath(row.source, `co-edit ${index} source`);
  const target = repositoryPath(row.target, `co-edit ${index} target`);
  if (source === target) throw new SpeculativeRulesError(`co-edit ${index} must name two files`);
  return { source, target, count: positiveInteger(row.count, `co-edit ${index} count`) };
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SpeculativeRulesError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SpeculativeRulesError(`${label} has unknown or missing fields`);
  }
  return record;
}

function toolName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) throw new SpeculativeRulesError(`${label} is invalid`);
  return value;
}

function repositoryPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new SpeculativeRulesError(`${label} is invalid`);
  }
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new SpeculativeRulesError(`${label} is unsafe`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new SpeculativeRulesError(`${label} must be a positive integer`);
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) {
    throw new SpeculativeRulesError(`${label} must be an integer from 0 to 1000000`);
  }
  return Number(value);
}
