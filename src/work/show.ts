import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { statusBadge } from "../dash/status.ts";
import { currentPlanPath } from "./graph.ts";
import { defaultWorkPlanPath } from "./log.ts";
import type { WorkPlan } from "./schema.ts";
import { viewPlan } from "./view.ts";
import type { EventRecord } from "../host/schema.ts";

export function showPlanPath(repoRoot: string, requested?: string): string {
  if (requested) {
    return resolve(requested);
  }
  const current = currentPlanPath(repoRoot);
  if (existsSync(current)) {
    return current;
  }
  return defaultWorkPlanPath(repoRoot);
}

/** Verification plan derived from real case data: the test layers for this todo. */
function caseLayersFor(plan: WorkPlan, todoId: string): string | undefined {
  const scenarioIds = new Set(plan.scenarios.filter((scenario) => scenario.todo === todoId).map((scenario) => scenario.id));
  const layers: string[] = [];
  for (const item of plan.cases) {
    if (scenarioIds.has(item.scenario) && !layers.includes(item.layer)) {
      layers.push(item.layer);
    }
  }
  return layers.length > 0 ? layers.join(" → ") : undefined;
}

export function formatPlanShow(
  plan: WorkPlan,
  events: readonly EventRecord[] = [],
  extras: { doing?: string; collapse?: boolean } = {},
): string {
  const view = viewPlan(plan, events);
  const lines: string[] = [];
  lines.push(`goal  ${plan.goal.id}`);
  lines.push(`      ${plan.goal.statement}`);
  lines.push("");
  const todos = [...plan.todos].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const todo of todos) {
    const state = extras.doing === todo.id ? "doing" : (view.todoState[todo.id] ?? "missing");
    const blockers = todo.blocked_by.length > 0 ? ` blocked_by=${todo.blocked_by.join(",")}` : "";
    const profile = todo.profile ? ` profile=${todo.profile}` : "";
    lines.push(`${statusBadge(state)} ${todo.id}  ${todo.class} p=${todo.priority}${profile}${blockers}`);
    lines.push(`       goal: ${todo.title}`);
    // Collapsed boards (dashboard = TUI) fold everything that is not being
    // worked or failing: the active node keeps the eye, finished detail is
    // one `plan show` away (TUI review: fold done/blocked nodes).
    const scenarios = plan.scenarios.filter((scenario) => scenario.todo === todo.id);
    const hasRedCase = scenarios.some((scenario) =>
      plan.cases.some((item) => item.scenario === scenario.id && view.caseStatus[item.id] === "red"),
    );
    const folded = extras.collapse === true && state !== "doing" && !hasRedCase;
    if (folded) {
      lines.push("");
      continue;
    }
    lines.push(`       judgment: ${todo.judgment ?? todo.statement}`);
    const planClause = todo.plan ?? caseLayersFor(plan, todo.id);
    if (planClause) {
      lines.push(`       plan: ${planClause}`);
    }
    for (const scenario of scenarios) {
      lines.push(`       scenario ${scenario.id}`);
      lines.push(`         Given ${scenario.given}`);
      lines.push(`         When  ${scenario.when}`);
      lines.push(`         Then  ${scenario.then}`);
      const cases = plan.cases.filter((item) => item.scenario === scenario.id);
      for (const item of cases) {
        const status = view.caseStatus[item.id] ?? "unrun";
        lines.push(`         case ${item.id} [${status}] ${item.layer}  ${item.command}`);
      }
    }
    lines.push("");
  }
  lines.push(`ready ${view.ready.join(", ") || "(none)"}`);
  return `${lines.join("\n")}\n`;
}
