import { unmetInheritedMeasurements } from "./view.ts";
import type { Case, Scenario, WorkPlan, WorkView } from "./schema.ts";
import { isBlockedByCycleError } from "./validate.ts";

export type WorkAction =
  | { type: "done" }
  | { type: "blocked"; waiting: string[] }
  | { type: "write_scenarios"; todo: string }
  | { type: "write_cases"; todo: string; scenario: string }
  | { type: "run_baseline"; todo: string; cases: string[] }
  | { type: "record_red"; todo: string; cases: string[] }
  | { type: "implement"; todo: string; cases: string[] }
  | { type: "clear"; todo: string };

export function scenariosForTodo(plan: WorkPlan, todoId: string): Scenario[] {
  return plan.scenarios.filter((scenario) => scenario.todo === todoId);
}

export function casesForTodo(plan: WorkPlan, todoId: string): Case[] {
  const scenarioIds = new Set(scenariosForTodo(plan, todoId).map((scenario) => scenario.id));
  return plan.cases.filter((item) => scenarioIds.has(item.scenario));
}

export function allClear(view: WorkView): boolean {
  return !view.errors.some(error => error.startsWith("obligation ")) && unmetInheritedMeasurements(view).length === 0 && view.plan.todos.length > 0 && view.plan.todos.every((todo) => view.todoState[todo.id] === "clear");
}

export function nextAction(view: WorkView, skip?: ReadonlySet<string>): WorkAction {
  if (view.errors.some(error => isBlockedByCycleError(error) || error.startsWith("obligation "))) {
    return { type: "blocked", waiting: view.errors };
  }
  if (view.plan.todos.length === 0) {
    return { type: "blocked", waiting: ["no-todos"] };
  }
  const inherited = unmetInheritedMeasurements(view);
  if (inherited.length > 0) return { type: "blocked", waiting: inherited.map(id => `measured-guard:${id}`) };
  if (allClear(view)) {
    return { type: "done" };
  }

  const green = view.plan.todos.find((todo) => view.todoState[todo.id] === "green");
  if (green) {
    return { type: "clear", todo: green.id };
  }

  // Deferred todos (shared-command deadlock) never take the implement slot;
  // they clear through the green branch above when their case turns green.
  const ready = skip && skip.size > 0 ? view.ready.filter((id) => !skip.has(id)) : view.ready;
  const readyId = ready[0];
  if (!readyId) {
    const waiting = view.plan.todos
      .filter((todo) => view.todoState[todo.id] === "blocked")
      .map((todo) => todo.id);
    return { type: "blocked", waiting };
  }

  const scenarios = scenariosForTodo(view.plan, readyId);
  if (scenarios.length === 0) {
    return { type: "write_scenarios", todo: readyId };
  }

  const bare = scenarios.find((scenario) => !view.plan.cases.some((item) => item.scenario === scenario.id));
  if (bare) {
    return { type: "write_cases", todo: readyId, scenario: bare.id };
  }

  const cases = casesForTodo(view.plan, readyId);
  const unrun = cases.filter((item) => view.caseStatus[item.id] === undefined);
  if (unrun.length > 0) {
    return { type: view.earnedEvidence ? "run_baseline" : "record_red", todo: readyId, cases: unrun.map((item) => item.id) };
  }

  const red = cases.filter((item) => view.caseStatus[item.id] === "red");
  if (red.length > 0) {
    return { type: "implement", todo: readyId, cases: red.map((item) => item.id) };
  }

  return { type: "clear", todo: readyId };
}
