import type { EventRecord } from "../host/schema.ts";
import type { WorkAction } from "./next.ts";

export type WorkCeiling = "chat" | "plan" | "red" | "implement";

const RANK: Record<WorkCeiling, number> = {
  chat: 0,
  plan: 1,
  red: 2,
  implement: 3,
};

const ACTION_RANK: Record<WorkAction["type"], number> = {
  record_red: 2,
  run_baseline: 2,
  implement: 3,
  write_scenarios: 1,
  write_cases: 2,
  clear: 3,
  blocked: 0,
  done: 0,
};

const PRIOR_STAGE_ARTIFACTS = "## 앞 단계 산출물";

/**
 * Classify only this stage's order text. Prior-stage artifacts (forward-only
 * pipeline context) carry their own ceilings and must not downgrade a builder
 * implement turn when the architect wrote "plan only".
 */
function ceilingClassificationText(order: string): string {
  const start = order.indexOf(PRIOR_STAGE_ARTIFACTS);
  if (start < 0) {
    return order;
  }
  const afterMarker = order.slice(start + PRIOR_STAGE_ARTIFACTS.length);
  // The artifact is the prior stage's own markdown and routinely contains
  // `## ` headings of its own; only the pipeline's OWN trailing section
  // (## 제약) may terminate the excision — an arbitrary heading inside the
  // artifact must not leak plan-only prose back into this stage's ceiling
  // (PR #96 review H3).
  const nextSection = afterMarker.search(/\n## 제약(?:\n|$)/u);
  if (nextSection < 0) {
    return order.slice(0, start);
  }
  return order.slice(0, start) + afterMarker.slice(nextSection);
}

/** The operator order is the ceiling. Drive must not commission above it. */
export function classifyWorkCeiling(order: string): WorkCeiling {
  const text = ceilingClassificationText(order).toLowerCase();
  if (asksChatOnly(text)) {
    return "chat";
  }
  if (asksRedOnly(text)) {
    return "red";
  }
  if (asksPlanOnly(text)) {
    return "plan";
  }
  return "implement";
}

export function readWorkCeiling(events: readonly EventRecord[]): WorkCeiling | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "work/ceiling") {
      continue;
    }
    const value = event.payload.ceiling;
    if (value === "chat" || value === "plan" || value === "red" || value === "implement") {
      return value;
    }
  }
  return undefined;
}

export function actionAllowed(action: WorkAction, ceiling: WorkCeiling): boolean {
  return ACTION_RANK[action.type] <= RANK[ceiling];
}

function asksChatOnly(text: string): boolean {
  return (
    /\b(explain|분석|원인만|why\b|how does)\b/.test(text) &&
    /\b(do not (edit|change|implement|write)|코드 (건드리지|쓰지)|파일.*(말|금지))\b/.test(text)
  );
}

function asksRedOnly(text: string): boolean {
  return (
    /\b(red only|tests? only|테스트만|red만)\b/.test(text) ||
    (/\b(write|add|만들어)\b.{0,40}\b(red|test)/.test(text) &&
      /\b(do not (change|implement|touch) product|제품 코드|구현하지)\b/.test(text))
  );
}

function asksPlanOnly(text: string): boolean {
  // Process advice is not a ceiling: "plan only the work that is needed"
  // and "implement turn" describe how to work, not "stop at the plan".
  if (/\bplan only the work\b/.test(text) || /\bimplement turn\b/.test(text)) {
    if (!/\b(plan only\.|work plan only|플랜만|계획만)\b/.test(text) && !/\bdo not implement product code\b/.test(text)) {
      return false;
    }
  }
  return (
    /\b(work plan only|two-todo work plan only|플랜만|계획만|구현하지 마)\b/.test(text) ||
    /\bdo not implement product code\b/.test(text) ||
    (/\bplan only\b/.test(text) && !/\bplan only the work\b/.test(text))
  );
}
