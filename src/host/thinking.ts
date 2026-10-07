import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingBudgets } from "@earendil-works/pi-ai";
import { readConfig, writeConfig } from "./config.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const THINKING_LEVEL_INDEX = new Map(THINKING_LEVELS.map((level, index) => [level, index]));

export function parseThinkingLevel(value: unknown): ThinkingLevel {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!THINKING_LEVEL_SET.has(normalized)) {
    throw new Error(`invalid effort ${JSON.stringify(value)}; expected one of ${THINKING_LEVELS.join(", ")}`);
  }
  return normalized as ThinkingLevel;
}

/** Flag > environment > saved configuration > medium. */
export function resolveThinkingLevel(explicit?: string): ThinkingLevel {
  if (explicit !== undefined) return parseThinkingLevel(explicit);
  const environment = process.env.DOKKABI_EFFORT?.trim();
  if (environment) return parseThinkingLevel(environment);
  const saved = readConfig().effort;
  return saved === undefined ? "medium" : parseThinkingLevel(saved);
}

export function writeThinkingLevel(value: string): ThinkingLevel {
  const effort = parseThinkingLevel(value);
  writeConfig({ effort });
  return effort;
}

/** Independent acceptance keeps a quality floor but honors stronger operator effort. */
export function acceptanceThinkingLevel(level: ThinkingLevel): ThinkingLevel {
  return (THINKING_LEVEL_INDEX.get(level) ?? 0) < THINKING_LEVEL_INDEX.get("medium")! ? "medium" : level;
}

/** Preserve a phase's token ceiling while applying it to the selected effort. */
export function thinkingBudgetsForLevel(
  level: ThinkingLevel,
  budgets?: ThinkingBudgets,
): ThinkingBudgets | undefined {
  if (!budgets || level === "off") return budgets;
  const providerLevel = level === "xhigh" || level === "max" ? "high" : level;
  const direct = budgets[providerLevel as keyof ThinkingBudgets];
  const fallback = direct ?? budgets.medium ?? budgets.high ?? budgets.low ?? budgets.minimal;
  return fallback === undefined ? budgets : { [providerLevel]: fallback };
}
