import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SSH_ALIAS_PATTERN } from "../host/ssh-aliases.ts";
import { isToolProfileName } from "../loader/tool-profiles.ts";
import { validateSubstrate } from "./case-substrate.ts";
import { contradictoryTimeout } from "./case-timeout.ts";
import { validateDependsOn } from "./case-depends.ts";
import { validateThresholds } from "./case-thresholds.ts";
import { caseMeasurementSchema } from "./evidence/measurements.ts";
import { checkSubstrateCoverage } from "./evidence/witnesses.ts";
import { caseCommandHint, caseTestFile, isAllowedCaseCommand, matchingCaseRunner } from "./case-runners.ts";
import {
  isCaseLayer,
  isWorkClass,
  type Case,
  type Scenario,
  type Todo,
  type WorkPlan,
} from "./schema.ts";

// Which commands may run a case is capability data, not validator logic —
// the registry keeps this file domain-neutral (constitution 7).
export { caseTestFile, isAllowedCaseCommand } from "./case-runners.ts";

export function isBlockedByCycleError(error: string): boolean {
  return error.startsWith("blocked_by cycle:");
}

export interface PlanValidationOptions {
  readonly authenticatedExternalPrerequisiteIds?: ReadonlySet<string>;
  /** Authenticated obligation data for historical views only. This does not
   * install a runner or authorize a new execution. Omission uses live plugins. */
  readonly recordedRunnerContracts?: Readonly<Record<string, unknown>>;
}

function recordedRunner(value: unknown): { measurementEvaluator?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || typeof row.matcher !== "string" || !row.matcher
    || typeof row.file_resolver !== "string" || !row.file_resolver
    || row.test_file !== null && typeof row.test_file !== "string"
    || row.measurement_evaluator !== null && typeof row.measurement_evaluator !== "string") return undefined;
  return { ...(typeof row.measurement_evaluator === "string" ? { measurementEvaluator: row.measurement_evaluator } : {}) };
}

export function validatePlan(plan: WorkPlan, options: PlanValidationOptions = {}): string[] {
  const errors: string[] = [];
  // Models emit these as objects or drop them entirely (the second sk-13241
  // envfix run: scenarios was a dict, cases absent). A wrong shape must be a
  // refusal the retry prompt can carry, never an iteration crash.
  const asArray = <T>(value: unknown, name: string): T[] => {
    if (value === undefined || value === null) {
      return [];
    }
    if (Array.isArray(value)) {
      return value as T[];
    }
    errors.push(
      `plan.${name} must be a top-level ARRAY of objects (got ${typeof value}) — write "${name}": [ … ], not an object keyed by id`,
    );
    return [];
  };
  const todos = asArray<Todo>(plan.todos, "todos");
  const scenarios = asArray<Scenario>(plan.scenarios, "scenarios");
  const cases = asArray<Case>(plan.cases, "cases");
  // Leaf fields arrive as whatever JSON the model wrote (run 20: every
  // todo.statement was {"title": …, "judgment": …}). A wrong TYPE must refuse
  // with the field named, never throw on .trim().
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  // Hint only when the TYPE is wrong. "got string" on a missing sibling field
  // (run 23: title absent, statement fine) sends the retry chasing the field
  // the model already fixed.
  const typeHint = (value: unknown): string =>
    value === undefined || value === null || typeof value === "string"
      ? ""
      : ` (must be a plain string, got ${typeof value})`;
  const missingFields = (
    fields: readonly (readonly [name: string, value: unknown])[],
  ): string =>
    fields
      .filter(([, value]) => !text(value))
      .map(([name, value]) => `${name}${typeHint(value)}`)
      .join(", ");
  if (!plan.goal?.id || !text(plan.goal.statement)) {
    errors.push(`goal must have id and a falsifiable statement${typeHint(plan.goal?.statement)}`);
  }
  if (todos.length === 0) {
    errors.push("plan needs at least one todo");
  }

  const todoIds = new Set<string>();
  for (const todo of todos) {
    // Small models invert the structure and nest scenario/case OBJECTS inside
    // each todo (sk-13241 envfix wave). Without a concrete error the retry
    // repeats the shape — name the mistake and where the arrays belong.
    // A string array (["scn-a"]) is a legitimate id back-reference, not nesting.
    const nested = todo as unknown as Record<string, unknown>;
    const nestsObjects = (value: unknown): boolean =>
      Array.isArray(value) && value.some((item) => typeof item === "object" && item !== null);
    if (nestsObjects(nested.scenarios) || nestsObjects(nested.cases)) {
      errors.push(
        `todo ${todo.id || "?"} nests scenarios/cases inline — move them to the top-level plan.scenarios / plan.cases arrays and point each scenario at this todo via scenario.todo`,
      );
    }
    {
      const missing = missingFields([
        ["id", todo.id],
        ["title", todo.title],
        ["statement", todo.statement],
      ]);
      if (missing) {
        errors.push(`todo ${todo.id || "?"} needs ${missing}`);
      }
    }
    if (!isWorkClass(todo.class)) {
      errors.push(`todo ${todo.id} has unknown class ${todo.class}`);
    }
    if (!Number.isFinite(todo.priority)) {
      errors.push(`todo ${todo.id} needs numeric priority`);
    }
    if (todo.profile !== undefined && !isToolProfileName(todo.profile)) {
      errors.push(`todo ${todo.id} has unknown tool profile ${String(todo.profile)}`);
    }
    if (todoIds.has(todo.id)) {
      errors.push(`duplicate todo ${todo.id}`);
    }
    todoIds.add(todo.id);
  }

  for (const todo of todos) {
    for (const blocker of todo.blocked_by ?? []) {
      if (!todoIds.has(blocker) && !options.authenticatedExternalPrerequisiteIds?.has(blocker)) {
        errors.push(`todo ${todo.id} blocked_by unknown ${blocker}`);
      }
    }
  }
  errors.push(...cycles(todos));

  const scenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario.id || !scenario.todo) {
      errors.push("scenario needs id and todo");
      continue;
    }
    if (!todoIds.has(scenario.todo)) {
      errors.push(`scenario ${scenario.id} points at unknown todo ${scenario.todo}`);
    }
    {
      const missing = missingFields([
        ["given", scenario.given],
        ["when", scenario.when],
        ["then", scenario.then],
      ]);
      if (missing) {
        errors.push(`scenario ${scenario.id} needs ${missing}`);
      }
    }
    // Required fields describe the scenario; vocabulary cannot establish
    // semantic observability. Executed cases and review supply that evidence.
    if (scenarioIds.has(scenario.id)) {
      errors.push(`duplicate scenario ${scenario.id}`);
    }
    scenarioIds.add(scenario.id);
  }

  const caseIds = new Set<string>();
  const casesByScenario = new Map<string, Case[]>();
  for (const item of cases) {
    {
      const missing = missingFields([
        ["id", item.id],
        ["scenario", item.scenario],
        ["command", item.command],
      ]);
      if (missing) {
        errors.push(`case ${item.id || "?"} needs ${missing}`);
        continue;
      }
    }
    if (!scenarioIds.has(item.scenario)) {
      // A guard case protects a standing invariant from an earlier campaign;
      // the new plan does not re-plan that work, so its scenario legitimately
      // stays undeclared here. Requiring it would drag the retired todo back
      // into the graph (goal-style90 carry-over refusal).
      if (item.guard !== true) {
        errors.push(`case ${item.id} points at unknown scenario ${item.scenario}`);
      }
    }
    if (!isCaseLayer(item.layer)) {
      errors.push(`case ${item.id} has unknown layer ${item.layer}`);
    }
    {
      const missing = missingFields([
        ["red_means", item.red_means],
        ["green_means", item.green_means],
      ]);
      if (missing) {
        errors.push(`case ${item.id} needs ${missing}`);
      }
    }
    if (caseIds.has(item.id)) {
      errors.push(`duplicate case ${item.id}`);
    }
    caseIds.add(item.id);
    const list = casesByScenario.get(item.scenario) ?? [];
    list.push(item);
    casesByScenario.set(item.scenario, list);
  }

  for (const todo of todos) {
    const todoScenarios = scenarios.filter((scenario) => scenario.todo === todo.id);
    if (todoScenarios.length === 0) {
      errors.push(`todo ${todo.id} has no scenarios`);
    }
    for (const scenario of todoScenarios) {
      if ((casesByScenario.get(scenario.id) ?? []).length === 0) {
        // Run 29 (flask): the refusal narrowed to exactly this and the model
        // still could not produce the shape. Show it one literal case.
        errors.push(
          `scenario ${scenario.id} has no cases — append to plan.cases: {"id": "case-${scenario.id}", "scenario": "${scenario.id}", "layer": "unit", "command": "<runner> <existing-test-file>", "red_means": "…", "green_means": "…"} (runners: ${caseCommandHint()})`,
        );
      }
    }
    // Every todo must own at least one case through its scenarios. A todo
    // with scenarios but zero cases is already rejected above; this catches
    // the empty-scenario-list path that leaves a todo with no check at all.
    const todoCases = cases.filter((item) =>
      todoScenarios.some((scenario) => scenario.id === item.scenario),
    );
    if (todoScenarios.length > 0 && todoCases.length === 0) {
      errors.push(`todo ${todo.id} has no cases`);
    }
  }

  for (const item of cases) {
    if (item.evidence_level !== undefined && item.evidence_level !== "workspace_reported") {
      errors.push(`case ${item.id}: evidence_level must be workspace_reported; attestation requires measurement`);
    }
    if (item.measurement !== undefined) {
      const parsed = caseMeasurementSchema.safeParse(item.measurement);
      if (!parsed.success) errors.push(`case ${item.id}: invalid measurement contract: ${parsed.error.message}`);
      else {
        if (item.done_when !== undefined || item.failed_when !== undefined
          || item.stall_after_ms !== undefined || item.telemetry_pattern !== undefined) {
          errors.push(`case ${item.id}: measurement does not support marker, stall or telemetry execution controls`);
        }
        if (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || item.timeout_ms <= 0 || item.timeout_ms > 30_000)) {
          errors.push(`case ${item.id}: measurement timeout_ms must be an integer from 1 to 30000`);
        }
        if (item.substrate !== undefined) {
          errors.push(...checkSubstrateCoverage(item.substrate, parsed.data.required_axes).map(reason => `case ${item.id}: ${reason}`));
        }
        if (item.evidence_level !== undefined || item.thresholds !== undefined
          || item.witness_for !== undefined || item.min_duration_ms !== undefined) {
          errors.push(`case ${item.id}: measurement cannot combine with legacy evidence_level, thresholds, witness_for or min_duration_ms`);
        }
      }
    }
    // A case may name the host that owns its code, but only by an enrolled
    // alias: a raw coordinate in the plan would leak into the sealed graph.
    if (item.host !== undefined && !SSH_ALIAS_PATTERN.test(item.host)) {
      errors.push(
        `case ${item.id} host must be an enrolled ssh alias (letter-led, no dots or @) — register the coordinate with ssh op=enroll, then name the alias here (got ${String(item.host).slice(0, 40)})`,
      );
    }
    {
      const contradiction = contradictoryTimeout(item);
      if (contradiction) errors.push(`case ${item.id}: ${contradiction}`);
    }
    if (item.thresholds !== undefined) {
      errors.push(...validateThresholds(item.thresholds).map((error) => `case ${item.id}: ${error}`));
    }
    if (item.local_accelerator !== undefined) {
      if (typeof item.local_accelerator !== "boolean") {
        errors.push(`case ${item.id}: local_accelerator must be true or false`);
      }
      // Both would say the work runs in two places at once, and the runner
      // would have to guess which one the verdict came from.
      if (item.local_accelerator === true && item.host !== undefined) {
        errors.push(
          `case ${item.id}: local_accelerator runs on THIS machine, so it cannot also declare host ${item.host}`,
        );
      }
    }
    if (item.needs_memory_gb !== undefined) {
      errors.push(...validateNeedsMemory(item.needs_memory_gb).map((error) => `case ${item.id}: ${error}`));
    }
    if (item.depends_on !== undefined) {
      errors.push(...validateDependsOn(item.depends_on).map((error) => `case ${item.id}: ${error}`));
    }
    if (item.substrate !== undefined) {
      errors.push(...validateSubstrate(item.substrate).map((error) => `case ${item.id}: ${error}`));
    }
    if (!text(item.command)) {
      continue;
    }
    const runner = options.recordedRunnerContracts === undefined
      ? matchingCaseRunner(item.command) : recordedRunner(options.recordedRunnerContracts[item.id]);
    if (runner?.measurementEvaluator !== undefined && item.measurement === undefined) {
      errors.push(`case ${item.id}: the measurement runner requires a protected measurement contract`);
    }
    if (!runner && options.recordedRunnerContracts !== undefined) {
      errors.push(`case ${item.id}: admitted runner contract is missing or invalid`);
    } else if (!runner) {
      errors.push(
        `case ${item.id} command must start with one of: ${caseCommandHint()} — or register the repository's runner by writing work/runners/<id>.json (got ${item.command.slice(0, 80)})`,
      );
    }
  }

  return errors;
}

/**
 * Plan review against the repository: every case must name a test file that
 * already exists. The decompose turn is required to write RED tests before
 * the graph is accepted; a case that points at a missing file is a plan that
 * cannot go red-first.
 *
 * Pytest cases name an existing suite path (file or node id's file part).
 */
export function reviewPlanFiles(plan: WorkPlan, repoRoot: string): string[] {
  const errors: string[] = [];
  for (const item of plan.cases ?? []) {
    const file = caseTestFile(typeof item.command === "string" ? item.command : "");
    if (!file) {
      errors.push(`case ${item.id} command does not name a test file`);
      continue;
    }
    // A case that runs on another machine keeps its RED there. Requiring the
    // file here pointed the two checks at different hosts: the review refused
    // the plan until the RED was written locally, and the preflight then
    // reported "executed no tests" because the runner looked on the host,
    // where nothing had been written. The preflight is the stronger proof —
    // it launches the command where the case actually runs.
    if (item.host !== undefined) {
      continue;
    }
    const absolute = resolve(repoRoot, file);
    if (!existsSync(absolute)) {
      errors.push(`case ${item.id} names missing test file ${file}`);
    }
  }
  return errors;
}

function cycles(todos: Todo[]): string[] {
  const edges = new Map(todos.map((todo) => [todo.id, todo.blocked_by ?? []]));
  const visiting = new Set<string>();
  const seen = new Set<string>();
  const found: string[] = [];

  const walk = (id: string, stack: string[]) => {
    if (seen.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const path = cycleStart >= 0 ? stack.slice(cycleStart) : stack;
      found.push(`blocked_by cycle: ${[...path, id].join(" -> ")}`);
      return;
    }
    visiting.add(id);
    for (const next of edges.get(id) ?? []) {
      walk(next, [...stack, id]);
    }
    visiting.delete(id);
    seen.add(id);
  };

  for (const todo of todos) {
    walk(todo.id, []);
  }
  return found;
}

export function assertCompleteSentences(scenario: Scenario): void {
  if (!scenario.given || !scenario.when || !scenario.then) {
    throw new Error(`scenario ${scenario.id} is missing a sentence`);
  }
}

/** Shape gate for a case's declared memory need, in gigabytes. */
export function validateNeedsMemory(value: unknown): string[] {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return ["case needs_memory_gb must be a positive number of gigabytes (e.g. 52)"];
  }
  return [];
}
