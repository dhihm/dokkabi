export interface RalphPlanTake {
  readonly order: string;
  readonly activated: boolean;
  /** Natural Ralph Plan directives are planning-only. The explicit work flag
   * may opt into the same planner before ordinary RED-first execution. */
  readonly planOnly: boolean;
}

const KOREAN_RALPH = "\uB784\uD504";
const KOREAN_PLAN = "(?:\uD50C\uB79C|\uACC4\uD68D)";
const KOREAN_DELIBERATION_MODE = "\uAD81\uB9AC\\s*\uBAA8\uB4DC";
const CANONICAL = `(?:ralph\\s*plan|${KOREAN_RALPH}\\s*${KOREAN_PLAN}|${KOREAN_DELIBERATION_MODE})`;
const STANDALONE = new RegExp(`^${CANONICAL}[!.]?$`, "iu");
const TASK = new RegExp(`^${CANONICAL}\\s*:\\s*(.*)$`, "iu");
const ENGLISH_ACTIVATION = /^(?:(?:turn|switch)\s+on|enable|start|use)\s+ralph\s*plan\b(?:\s+(?:and|to)\b)?\s*/iu;
const KOREAN_ACTIVATION = new RegExp(
  `^(?:${KOREAN_RALPH}\\s*${KOREAN_PLAN}|${KOREAN_DELIBERATION_MODE})\\s*(?:\uC744|\uB97C)?\\s*\uCF1C\s*\uACE0\\s+`,
  "iu",
);

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Parse only an explicit, anchored Ralph Plan directive.
 *
 * Ordinary requests containing plan, planning, or the Korean words for plan
 * and deliberation remain untouched. Ralph planning is a separate, expensive
 * policy and must never be inferred from generic intent.
 */
export function takeRalphPlanSignal(input: string): RalphPlanTake {
  const original = compact(input);
  if (STANDALONE.test(original)) {
    return { order: "", activated: true, planOnly: true };
  }
  const task = original.match(TASK);
  if (task) {
    return { order: compact(task[1] ?? ""), activated: true, planOnly: true };
  }
  if (ENGLISH_ACTIVATION.test(original)) {
    const order = compact(original.replace(ENGLISH_ACTIVATION, ""));
    if (order) return { order, activated: true, planOnly: true };
  }
  if (KOREAN_ACTIVATION.test(original)) {
    const order = compact(original.replace(KOREAN_ACTIVATION, ""));
    if (order) return { order, activated: true, planOnly: true };
  }
  return { order: original, activated: false, planOnly: false };
}
