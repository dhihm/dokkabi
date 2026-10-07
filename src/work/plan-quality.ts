import type { Case, Todo, WorkPlan } from "./schema.ts";
import { reviewPortWiring } from "./ports.ts";

/**
 * Structural plan quality — the internal eval layer for "is this an executable
 * DAG, or a bag of todos?". Complements validatePlan (schema) and
 * reviewPlanFiles (RED tests on disk). No model in the loop.
 */

export interface PlanGraphStats {
  nodes: number;
  edges: number;
  ready: string[];
  /** Longest path length in nodes (1 = single node / no depth). */
  critical_path_len: number;
  /** True when every todo has blocked_by: [] and there are 3+ todos. */
  flat_bag: boolean;
}

export interface PlanQualityOptions {
  /**
   * When true, a single-todo plan is allowed. Default true: the order, not
   * a hardcoded count, decides how many todos exist.
   */
  allowAtomic?: boolean;
  /** Minimum todos when allowAtomic is false. Default 2. */
  minTodos?: number;
  authenticatedExternalPrerequisiteIds?: ReadonlySet<string>;
}

export function countEdges(todos: readonly Todo[]): number {
  let n = 0;
  for (const todo of todos) {
    n += (todo.blocked_by ?? []).length;
  }
  return n;
}

/** Todos with no in-plan blockers — drive's ready set. */
export function listReadyTodos(
  todos: readonly Todo[],
  authenticatedExternalPrerequisiteIds: ReadonlySet<string> = new Set(),
): string[] {
  const ids = new Set(todos.map((todo) => todo.id));
  return todos
    .filter((todo) => (todo.blocked_by ?? []).every((blocker) =>
      !ids.has(blocker) && authenticatedExternalPrerequisiteIds.has(blocker)
    ))
    .map((todo) => todo.id)
    .sort();
}

/**
 * Longest path in the dependency DAG (node count along the path).
 * blocked_by means "I wait on X", so edges run blocker → dependent.
 */
export function criticalPathLen(todos: readonly Todo[]): number {
  if (todos.length === 0) {
    return 0;
  }
  const ids = new Set(todos.map((todo) => todo.id));
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    dependents.set(id, []);
  }
  for (const todo of todos) {
    for (const blocker of todo.blocked_by ?? []) {
      if (!ids.has(blocker)) {
        continue;
      }
      dependents.get(blocker)!.push(todo.id);
    }
  }
  const memo = new Map<string, number>();
  const walk = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) {
      return memo.get(id)!;
    }
    if (stack.has(id)) {
      return 1;
    }
    stack.add(id);
    let best = 1;
    for (const next of dependents.get(id) ?? []) {
      best = Math.max(best, 1 + walk(next, stack));
    }
    stack.delete(id);
    memo.set(id, best);
    return best;
  };
  let max = 1;
  for (const todo of todos) {
    max = Math.max(max, walk(todo.id, new Set()));
  }
  return max;
}

export function planGraphStats(
  plan: WorkPlan,
  authenticatedExternalPrerequisiteIds: ReadonlySet<string> = new Set(),
): PlanGraphStats {
  const todos = plan.todos ?? [];
  const edges = countEdges(todos);
  return {
    nodes: todos.length,
    edges,
    ready: listReadyTodos(todos, authenticatedExternalPrerequisiteIds),
    critical_path_len: criticalPathLen(todos),
    flat_bag: todos.length >= 3 && edges === 0,
  };
}

/**
 * Quality errors that mean "do not seal this as a work graph".
 * Schema → validatePlan; missing test files → reviewPlanFiles.
 */
export function reviewPlanQuality(plan: WorkPlan, options: PlanQualityOptions = {}): string[] {
  const errors: string[] = [];
  const todos = plan.todos ?? [];
  const stats = planGraphStats(plan, options.authenticatedExternalPrerequisiteIds);
  void options;

  if (todos.length > 0 && stats.ready.length === 0) {
    errors.push("work graph has no ready todo: every node is blocked (check blocked_by)");
  }
  errors.push(...sharedCaseCommands(plan));
  // #78: data flow, checked in the same pass as the rest of the graph. A
  // plan that declares no ports contributes nothing here.
  errors.push(...reviewPortWiring(plan));

  return errors;
}

/**
 * One identical execution cannot be independent evidence for two different
 * claims. Live, five cases with unrelated scenarios — golden tensors, CUDA
 * graph capture across batch sizes, SLA budgets, a launch manifest — all ran
 * the same 70-line toy-model test, so all five moved together and none could
 * ever go red for its own reason. Sharing a test FILE stays legal: a -k
 * selector or a ::node_id makes the commands differ, and each case can then
 * fail alone.
 */
function sharedCaseCommands(plan: WorkPlan): string[] {
  const byCommand = new Map<string, Case[]>();
  for (const item of plan.cases ?? []) {
    const command = typeof item.command === "string" ? item.command.trim() : "";
    if (!command) continue;
    const list = byCommand.get(command) ?? [];
    list.push(item);
    byCommand.set(command, list);
  }
  const errors: string[] = [];
  for (const [command, sharing] of byCommand) {
    const scenarios = new Set(sharing.map((item) => item.scenario).filter(Boolean));
    if (scenarios.size < 2) continue;
    errors.push(
      `cases ${sharing.map((item) => item.id).join(", ")} run the same command for different scenarios (${[...scenarios].join(", ")}) — one run cannot be separate evidence for separate claims. Give each case a command that can fail on its own: a distinct test file, or the same file narrowed with -k <name> or ::<test_id> (got ${command.slice(0, 60)})`,
    );
  }
  return errors;
}

/** One-line summary for logs and eval reports. */
export function formatPlanGraphStats(stats: PlanGraphStats): string {
  return `nodes=${stats.nodes} edges=${stats.edges} ready=${stats.ready.length} critical_path=${stats.critical_path_len}${stats.flat_bag ? " flat_bag" : ""}`;
}
