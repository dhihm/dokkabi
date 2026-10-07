import { createEarnedProjection, usesEarnedEvidence, type EarnedProjection } from "./evidence/earned.ts";
import { obligationErrors, projectObligations, remapRunners } from "./evidence/obligations.ts";
import type { EventRecord } from "../host/schema.ts";
import type { CaseStatus, TodoState, WorkPlan, WorkView } from "./schema.ts";
import { createCaseEvidenceReader, scopeWorkEvents, type CaseEvidenceReader } from "./scope.ts";
import { isBlockedByCycleError, validatePlan } from "./validate.ts";
import { recordedPrerequisiteIds } from "./prerequisites.ts";

export function viewPlan(
  plan: WorkPlan,
  events: readonly EventRecord[] = [],
  options: { evidencePlan?: WorkPlan } = {},
): WorkView {
  const authorityErrors: string[] = [];
  try { authorityErrors.push(...obligationErrors(options.evidencePlan ?? plan, events)); }
  catch (error) { authorityErrors.push(`obligation projection refused: ${String(error)}`); }
  if (authorityErrors.length) {
    return { plan, caseStatus: {}, todoState: Object.fromEntries(plan.todos.map(todo => [todo.id, "blocked"])), ready: [], errors: authorityErrors };
  }
  const scopedEvents = scopeWorkEvents(options.evidencePlan ?? plan, events);
  const prerequisites = recordedPrerequisiteIds(options.evidencePlan ?? plan, scopedEvents);
  const authority = projectObligations(scopedEvents);
  const errors = validatePlan(plan, { authenticatedExternalPrerequisiteIds: prerequisites,
    ...(authority.current ? { recordedRunnerContracts: remapRunners(authority.current, plan) } : {}) });
  if (errors.some(isBlockedByCycleError)) {
    return { plan, caseStatus: {}, todoState: {}, ready: [], errors };
  }
  const caseStatus: Record<string, CaseStatus> = {};
  const skipUnearned = plan.require_red_first === true;
  const evidenceReader = createCaseEvidenceReader(scopedEvents);
  const earnedProjection = usesEarnedEvidence(scopedEvents) ? createEarnedProjection(scopedEvents) : undefined;
  // Every case on the plan paints the graph. A narrowing to the official
  // FAIL_TO_PASS ids used to live here, fed by a `swe/fail_to_pass` row that
  // nothing has appended since blind running landed — so it fired only on a
  // log old enough to still carry one, silently dropping a case's status
  // (#98). Official scoring belongs to the parent evaluator.
  for (const item of plan.cases) {
    const last = lastCaseStatus(plan, item, evidenceReader, skipUnearned, earnedProjection);
    if (last) {
      caseStatus[item.id] = last;
    }
  }

  const currentTodo = (event: EventRecord): string | undefined => {
    if (!authority.current) return event.payload.plan === plan.goal.id && typeof event.payload.todo === "string" ? event.payload.todo : undefined;
    const then = authority.snapshots.filter(snapshot => snapshot.seq < event.seq).at(-1)?.value;
    if (then?.plan.goal.id !== event.payload.plan) return undefined;
    const old = then?.obligations.find(item => item.kind === "todo" && item.alias === event.payload.todo);
    return old && authority.current.obligations.find(item => item.kind === "todo" && item.key === old.key)?.alias;
  };
  // A clear belongs to ONE plan (the goal it cleared): a shared campaign
  // log reuses scaffold todo ids across instances, so a past run's clears
  // must never auto-complete a fresh plan with the same ids.
  const cleared = new Set(
    scopedEvents
      .filter(
        (event) =>
          event.name === "work/clear" &&
          currentTodo(event) !== undefined &&
          clearHasCurrentEvidence(
            plan,
            currentTodo(event)!,
            caseStatus,
            scopedEvents,
            event.seq,
            evidenceReader,
            earnedProjection,
          ),
      )
      .map((event) => currentTodo(event)!),
  );
  for (const id of prerequisites) cleared.add(id);

  const todoState: Record<string, TodoState> = {};
  for (const todo of plan.todos) {
    todoState[todo.id] = stateFor(plan, todo.id, caseStatus, cleared, todoState);
  }

  const ready = plan.todos
    .filter((todo) => todoState[todo.id] === "ready" || todoState[todo.id] === "red")
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((todo) => todo.id);

  return { plan, caseStatus, todoState, ready, errors, ...(usesEarnedEvidence(events) ? { earnedEvidence: true } : {}) };
}

export function canStart(view: WorkView, todoId: string): boolean {
  const state = view.todoState[todoId];
  return state === "ready" || state === "red";
}

/** Inherited guards can belong to an earlier campaign rather than a current
 * todo. Their measured status still gates completion of the current plan. */
export function unmetInheritedMeasurements(view: WorkView): string[] {
  const scenarios = new Set(view.plan.scenarios.map(scenario => scenario.id));
  return view.plan.cases.filter(item => item.guard === true
    && !scenarios.has(item.scenario) && view.caseStatus[item.id] !== "green").map(item => item.id);
}

export function canClear(view: WorkView, todoId: string): boolean {
  return !view.errors.some(error => error.startsWith("obligation ")) && view.todoState[todoId] === "green"
    && unmetInheritedMeasurements(view).length === 0
    && (!view.earnedEvidence || view.plan.cases.every(item => !item.guard || view.caseStatus[item.id] === "green"));
}

export function stateFor(
  plan: WorkPlan,
  todoId: string,
  caseStatus: Record<string, CaseStatus>,
  cleared: Set<string>,
  memo: Record<string, TodoState>,
  visiting: Set<string> = new Set(),
): TodoState {
  if (memo[todoId]) {
    return memo[todoId];
  }
  if (visiting.has(todoId)) {
    memo[todoId] = "blocked";
    return "blocked";
  }
  const todo = plan.todos.find((item) => item.id === todoId);
  if (!todo) {
    return "blocked";
  }
  visiting.add(todoId);
  const blockers = todo.blocked_by ?? [];
  const blockersClear = blockers.every((id) => {
    if (cleared.has(id)) {
      return true;
    }
    return stateFor(plan, id, caseStatus, cleared, memo, visiting) === "clear";
  });
  visiting.delete(todoId);
  if (!blockersClear) {
    memo[todoId] = "blocked";
    return "blocked";
  }
  if (cleared.has(todoId)) {
    memo[todoId] = "clear";
    return "clear";
  }
  const cases = casesForTodo(plan, todoId);
  if (cases.length === 0) {
    memo[todoId] = "ready";
    return "ready";
  }
  const statuses = cases.map((item) => caseStatus[item.id]);
  if (statuses.every((status) => status === "green")) {
    memo[todoId] = "green";
    return "green";
  }
  if (statuses.some((status) => status === "red" || status === "green")) {
    memo[todoId] = "red";
    return "red";
  }
  memo[todoId] = "ready";
  return "ready";
}

function casesForTodo(plan: WorkPlan, todoId: string) {
  const scenarioIds = new Set(plan.scenarios.filter((scenario) => scenario.todo === todoId).map((scenario) => scenario.id));
  return plan.cases.filter((item) => scenarioIds.has(item.scenario));
}

function lastCaseStatus(
  plan: WorkPlan,
  item: WorkPlan["cases"][number],
  evidenceReader: CaseEvidenceReader,
  skipUnearned = false,
  earnedProjection?: EarnedProjection,
): CaseStatus | undefined {
  const runs = currentCaseRuns(plan, item, evidenceReader);
  if (earnedProjection) return earnedProjection.earnedCaseStatus(item, skipUnearned, runs);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const event = runs[i]!;
    const status = event.payload.status;
    if (status === "red" || status === "green") {
      // A green on the case's first recorded run never had a RED to earn it:
      // the test passed before any implementation existed. For plans that
      // require RED first it does not count until a later run goes green.
      if (skipUnearned && !item.guard && status === "green" && event.payload.first_run === true) {
        return undefined;
      }
      return status;
    }
  }
  return undefined;
}

function clearHasCurrentEvidence(
  plan: WorkPlan,
  todoId: string,
  caseStatus: Record<string, CaseStatus>,
  events: readonly EventRecord[],
  clearSeq: number,
  evidenceReader: CaseEvidenceReader,
  earnedProjection?: EarnedProjection,
): boolean {
  const cases = casesForTodo(plan, todoId);
  if (cases.length === 0) return !earnedProjection;
  if (earnedProjection) {
    return cases.every(item => {
      const runs = currentCaseRuns(plan, item, evidenceReader);
      return caseStatus[item.id] === "green"
        && earnedProjection.earnedCaseStatus(item, plan.require_red_first === true, runs.filter(row => row.seq < clearSeq)) === "green"
        && !runs.some(row => row.seq > clearSeq && row.payload.status === "red");
    });
  }
  const hasDefinitions = cases.some((item) => events.some(
    (event) => event.name === "work/case"
      && event.payload.id === item.id
      && typeof event.payload.scenario === "string"
      && event.payload.status !== "red"
      && event.payload.status !== "green",
  ));
  if (!hasDefinitions) return true;
  return cases.every((item) => {
    if (caseStatus[item.id] !== "green") return false;
    const hasDefinition = events.some(
      (event) => event.name === "work/case"
        && event.payload.id === item.id
        && typeof event.payload.scenario === "string"
        && event.payload.status !== "red"
        && event.payload.status !== "green",
    );
    if (!hasDefinition) return true;

    const runs = currentCaseRuns(plan, item, evidenceReader);
    const beforeClear = runs.filter((event) => event.seq < clearSeq);
    const statusAtClear = lastEarnedStatus(beforeClear, plan.require_red_first === true && !item.guard);
    const invalidated = runs.some(
      (event) => event.seq > clearSeq && event.payload.status === "red",
    );
    return statusAtClear === "green" && !invalidated;
  });
}

function currentCaseRuns(
  plan: WorkPlan,
  item: WorkPlan["cases"][number],
  evidenceReader: CaseEvidenceReader,
): EventRecord[] {
  const scenario = plan.scenarios.find((candidate) => candidate.id === item.scenario);
  return evidenceReader(item, scenario);
}

function lastEarnedStatus(
  events: readonly EventRecord[],
  skipUnearned: boolean,
): CaseStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const status = event.payload.status;
    if (status !== "red" && status !== "green") continue;
    if (skipUnearned && status === "green" && event.payload.first_run === true) return undefined;
    return status;
  }
  return undefined;
}
