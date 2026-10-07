import { writeFileSync } from "node:fs";
import type { Case, Scenario, Todo, WorkPlan } from "./schema.ts";
import { isBlockedByCycleError, validatePlan } from "./validate.ts";

export interface ChildSpec {
  todo: Todo;
  scenarios: Scenario[];
  cases?: Case[];
}

export function splitTodo(plan: WorkPlan, parentId: string, children: ChildSpec[]): WorkPlan {
  const parent = plan.todos.find((todo) => todo.id === parentId);
  if (!parent) {
    throw new Error(`unknown todo ${parentId}`);
  }
  if (children.length === 0) {
    throw new Error("splitTodo needs at least one child");
  }

  const existing = new Set(plan.todos.map((todo) => todo.id));
  const next: WorkPlan = {
    goal: plan.goal,
    todos: plan.todos.map((todo) => ({ ...todo, blocked_by: [...todo.blocked_by] })),
    scenarios: [...plan.scenarios],
    cases: [...plan.cases],
  };

  const childIds: string[] = [];
  for (const child of children) {
    if (existing.has(child.todo.id) || childIds.includes(child.todo.id)) {
      throw new Error(`duplicate todo ${child.todo.id}`);
    }
    if (child.scenarios.length === 0) {
      throw new Error(`child ${child.todo.id} needs Given/When/Then before it can enter the graph`);
    }
    for (const scenario of child.scenarios) {
      if (scenario.todo !== child.todo.id) {
        throw new Error(`scenario ${scenario.id} must point at ${child.todo.id}`);
      }
    }
    childIds.push(child.todo.id);
    next.todos.push({
      ...child.todo,
      blocked_by: unique([...(parent.blocked_by ?? []), ...(child.todo.blocked_by ?? [])]),
    });
    next.scenarios.push(...child.scenarios);
    if (child.cases) {
      next.cases.push(...child.cases);
    }
  }

  const parentIndex = next.todos.findIndex((todo) => todo.id === parentId);
  const current = next.todos[parentIndex];
  if (!current) {
    throw new Error(`unknown todo ${parentId}`);
  }
  current.blocked_by = unique([...current.blocked_by, ...childIds]);

  const errors = validatePlan(next);
  if (errors.some(isBlockedByCycleError)) {
    throw new Error(errors.join("; "));
  }
  return next;
}

export function addScenario(plan: WorkPlan, scenario: Scenario): WorkPlan {
  if (plan.scenarios.some((item) => item.id === scenario.id)) {
    throw new Error(`duplicate scenario ${scenario.id}`);
  }
  const next: WorkPlan = {
    ...plan,
    scenarios: [...plan.scenarios, scenario],
  };
  return next;
}

export function addCase(plan: WorkPlan, item: Case): WorkPlan {
  if (plan.cases.some((row) => row.id === item.id)) {
    throw new Error(`duplicate case ${item.id}`);
  }
  return {
    ...plan,
    cases: [...plan.cases, item],
  };
}

export function writeWorkPlan(path: string, plan: WorkPlan): void {
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    throw new Error(`invalid work plan: ${errors.join("; ")}`);
  }
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
