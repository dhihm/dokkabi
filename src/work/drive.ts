import type { ExecutionViews } from "../plugins/execution-view.ts";
import { dispatchInterrupt } from "../host/interrupt.ts";
import { defaultInterruptHandlers } from "../host/interrupt-lines.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import type { WorkMeasurements } from "../loader/types.ts";
import type { EventRecord } from "../host/schema.ts";
import { splitTodo, writeWorkPlan, type ChildSpec } from "./decompose.ts";
import { bindPlan, clearTodo } from "./log.ts";
import { actionAllowed, readWorkCeiling } from "./ceiling.ts";
import { nextAction, type WorkAction } from "./next.ts";
import type { WorkPlan } from "./schema.ts";
import { caseNeedsMeasurementVerification, checkManagedPlanPreparation, verifyPlan, type CaseRemoteRunner, type VerifyResult, type WorkEvaluatorError } from "./verify.ts";
import { clearImplementMiss, recordImplementMiss } from "./stuck-ledger.ts";
import { alreadySettledCases, reachableTodos } from "./reachable.ts";
import {
  activeSemanticLivelock,
  reconcileSemanticLivelocks,
  recordSemanticLivelock,
} from "./semantic-livelock-recorded.ts";
import { viewPlan } from "./view.ts";
import { reuseOriginalBaselines } from "./evidence/work-review.ts";

export type DriveStatus =
  | "done"
  | "blocked"
  | "need_scenarios"
  | "need_cases"
  | "need_implement"
  | "still_red"
  | "max_steps";

export interface DriveStep {
  action: WorkAction["type"] | "verify" | "defer";
  todo?: string;
  green?: string[];
  red?: string[];
  cleared?: string[];
  error?: WorkEvaluatorError;
}

export interface DriveHooks {
  writeScenarios?: (input: { plan: WorkPlan; todo: string }) => WorkPlan | Promise<WorkPlan>;
  writeCases?: (input: { plan: WorkPlan; todo: string; scenario: string }) => WorkPlan | Promise<WorkPlan>;
  implement?: (input: {
    plan: WorkPlan;
    todo: string;
    cases: string[];
  }) => void | WorkPlan | Promise<void | WorkPlan>;
  split?: (input: { plan: WorkPlan; todo: string }) => ChildSpec[] | Promise<ChildSpec[]>;
  checkpoint?: (input: {
    plan: WorkPlan;
    reason: "todo_clear" | "goal_done";
    todo?: string;
    events: readonly import("../host/schema.ts").EventRecord[];
  }) => void | Promise<void>;
}

export interface DriveResult {
  status: DriveStatus;
  plan: WorkPlan;
  action: WorkAction;
  steps: DriveStep[];
}

/** Same todo with no new greens this many times means stuck, not "stop the whole
 * graph". Counted across waves — see stuck-ledger. */
export { IMPLEMENT_STUCK_LIMIT } from "./stuck-ledger.ts";

/**
 * A stuck todo whose EVERY red case command also belongs to another todo is
 * a shared-command deadlock (runs 30/35/37/38: locate's case was fix's
 * official test — locate could never clear first, and fix never got a turn).
 * The drive defers such a todo: its outgoing edges relax so downstream work
 * proceeds, and it clears only when its own case turns green later.
 */
/** Locate already wrote observational evidence. Waiting out IMPLEMENT_STUCK_LIMIT
 * (run 39: two 15-minute product-edit turns after REPRO.md existed) just
 * burns the model on a case it can never turn green. */
export function locateReproReady(cwd: string, todoId: string): boolean {
  if (!/locate|repro|find/i.test(todoId)) {
    return false;
  }
  const path = join(cwd, "work", "REPRO.md");
  if (!existsSync(path)) {
    return false;
  }
  try {
    return readFileSync(path, "utf8").trim().length >= 20;
  } catch {
    return false;
  }
}

export function isSharedCommandDeadlock(plan: WorkPlan, todoId: string, redCases: readonly string[]): boolean {
  if (redCases.length === 0) {
    return false;
  }
  const todoOf = new Map(plan.scenarios.map((scenario) => [scenario.id, scenario.todo]));
  return redCases.every((caseId) => {
    const item = plan.cases.find((row) => row.id === caseId);
    if (!item) {
      return false;
    }
    return plan.cases.some(
      (other) => other.id !== item.id && other.command === item.command && todoOf.get(other.scenario) !== todoId,
    );
  });
}

/** The plan as the scheduler sees it: deferred todos stop blocking others.
 * Verification still runs the REAL plan — only readiness relaxes. */
function relaxDeferred(plan: WorkPlan, deferred: ReadonlySet<string>): WorkPlan {
  if (deferred.size === 0) {
    return plan;
  }
  return {
    ...plan,
    todos: plan.todos.map((todo) => ({
      ...todo,
      blocked_by: (todo.blocked_by ?? []).filter((dep) => !deferred.has(dep)),
    })),
  };
}

export function defaultMaxSteps(plan: WorkPlan): number {
  return Math.max(32, plan.todos.length * 8);
}

export async function driveWork(input: {
  log: EventLog;
  plan: WorkPlan;
  cwd: string;
  planPath?: string;
  once?: boolean;
  maxSteps?: number;
  verify?: boolean;
  measurements?: WorkMeasurements;
  executionViews?: ExecutionViews;
  hooks?: DriveHooks;
  /** Executes a host-bound case on its enrolled alias. Absent: none can run. */
  remote?: CaseRemoteRunner;
  /** Implement misses per todo, carried across waves. A drive-local counter
   * reset every wave, so a todo that could never go green was retried
   * forever. */
  stuckLedger?: Map<string, number>;
  /** Independent-todo wave concurrency (#119): 1 (default) keeps the serial
   * verify; up to 4 fans one topological wave's independent todos out over
   * isolated worktrees and distinct ssh aliases behind a barrier. */
  waveConcurrency?: number;
}): Promise<DriveResult> {
  let plan = input.plan;
  const hooks = input.hooks ?? {};
  const steps: DriveStep[] = [];
  const maxSteps = input.once ? 1 : (input.maxSteps ?? defaultMaxSteps(plan));
  const stuck = input.stuckLedger ?? new Map<string, number>();
  const deferred = new Set<string>();
  // Parked is deliberately NOT deferred. Deferring relaxes a todo out of its
  // dependents' blocked_by, which is right for a shared-command deadlock —
  // downstream owns the same command and will turn it green. A todo that has
  // simply run out of attempts has not been done, so its dependents must stay
  // blocked. Parking only takes it out of SELECTION, so the independent parts
  // of the graph keep moving while this one waits for the next wave.
  const parked = new Set<string>();
  const interruptHandlers = defaultInterruptHandlers();
  bindPlan(input.log, plan);
  reconcileSemanticLivelocks(input.log, plan);

  // A standing, authenticated implementation refusal takes precedence over
  // optional startup verification. An observation-only retry must not replace
  // its failure signature and silently release the refused implementation.
  if (input.verify === false) {
    const pending = nextAction(viewPlan(plan, input.log.events));
    if ((pending.type === "implement" || pending.type === "run_baseline" || pending.type === "record_red")
      && activeSemanticLivelock(input.log.events, plan, pending.todo)) {
      const livelock = activeSemanticLivelock(input.log.events, plan, pending.todo)!;
      const action: WorkAction = { type: "implement", todo: pending.todo, cases: pending.cases };
      const step = recordStep(input.log, action);
      input.log.append({ kind: "observe", name: "livelock/refused", payload: {
        todo: livelock.todo, case_id: livelock.caseId, plan_digest: livelock.planDigest,
        step_seq: step.seq, decision: "refuse_implementation",
      } });
      steps.push({ action: action.type, todo: action.todo, red: action.cases });
      return finish("still_red", plan, action, steps);
    }
  }

  const skippedVerifyPreparation = input.verify === false
    ? checkManagedPlanPreparation({ log: input.log, plan, cwd: input.cwd })
    : undefined;
  if (skippedVerifyPreparation?.error) return fixtureBlocked(input.log, plan, steps, skippedVerifyPreparation.error);
  if (skippedVerifyPreparation?.managed) {
    input.log.append({ kind: "observe", name: "work/step", payload: { action: "verify", reason: "managed_verification_required" } });
  }
  if ((input.verify !== false || plan.cases.length > 0 || skippedVerifyPreparation?.managed || plan.cases.some(caseNeedsMeasurementVerification))
    && !reuseOriginalBaselines(input.log, input.cwd, plan)) {
    const verified = await runVerify(input.log, plan, input.cwd, input.remote, input.waveConcurrency, input.measurements, [], input.executionViews);
    steps.push(verified);
    if (verified.error) return fixtureBlocked(input.log, plan, steps, verified.error);
    reconcileSemanticLivelocks(input.log, plan);
    recordSemanticLivelock(input.log, plan);
    for (const todo of verified.cleared ?? []) await runCheckpoint(input.log, hooks, plan, "todo_clear", todo);
  }

  const decide = (): WorkAction =>
    nextAction(
      viewPlan(relaxDeferred(plan, deferred), input.log.events, { evidencePlan: plan }),
      parked.size > 0 ? new Set([...deferred, ...parked]) : deferred,
    );
  let action = decide();
  for (let i = 0; i < maxSteps; i += 1) {
    const preparation = checkManagedPlanPreparation({ log: input.log, plan, cwd: input.cwd });
    if (preparation.error) return fixtureBlocked(input.log, plan, steps, preparation.error);
    action = decide();
    const ceiling = readWorkCeiling(input.log.events);
    if (ceiling && !actionAllowed(action, ceiling)) {
      input.log.append({
        kind: "observe",
        name: "work/step",
        payload: { action: "ceiling", ceiling, blocked: action.type },
      });
      return finish(statusFor(action), plan, { type: "done" }, steps);
    }
    const step = recordStep(input.log, action);
    if (action.type === "done") {
      await runCheckpoint(input.log, hooks, plan, "goal_done");
      return finish("done", plan, action, steps);
    }
    if (action.type === "blocked") {
      // Nothing left to pick because everything that could move already did
      // and the rest is parked. That is red work outstanding, not a
      // dependency wait, and the wave says so — the same verdict it gave
      // before parking existed, reached after the independent work ran.
      return parked.size > 0
        ? finish("still_red", plan, action, steps)
        : finish("blocked", plan, action, steps);
    }
    if (action.type === "write_scenarios") {
      if (hooks.split) {
        const children = await hooks.split({ plan, todo: action.todo });
        plan = persist(input, splitTodo(plan, action.todo, children));
        steps.push({ action: action.type, todo: action.todo });
        continue;
      }
      if (!hooks.writeScenarios) {
        steps.push({ action: action.type, todo: action.todo });
        return finish("need_scenarios", plan, action, steps);
      }
      plan = persist(input, await hooks.writeScenarios({ plan, todo: action.todo }));
      steps.push({ action: action.type, todo: action.todo });
      continue;
    }
    if (action.type === "write_cases") {
      if (!hooks.writeCases) {
        steps.push({ action: action.type, todo: action.todo });
        return finish("need_cases", plan, action, steps);
      }
      plan = persist(input, await hooks.writeCases({ plan, todo: action.todo, scenario: action.scenario }));
      steps.push({ action: action.type, todo: action.todo });
      continue;
    }
    if (action.type === "run_baseline" || action.type === "record_red") {
      const verified = await runVerify(input.log, plan, input.cwd, input.remote, input.waveConcurrency, input.measurements, [action.todo], input.executionViews);
      steps.push({ ...verified, action: "run_baseline", todo: action.todo });
      if (verified.error) return fixtureBlocked(input.log, plan, steps, verified.error);
      const current = viewPlan(plan, input.log.events);
      if (action.cases.some(id => current.caseStatus[id] === undefined)) {
        return fixtureBlocked(input.log, plan, steps, { status: "evaluator_error", reason_code: "baseline_unearned", reason: "A qualifying baseline execution is required; repeated GREEN or unavailable execution cannot earn completion." });
      }
      continue;
    }
    if (action.type === "implement") {
      const livelock = activeSemanticLivelock(input.log.events, plan, action.todo);
      if (livelock) {
        input.log.append({
          kind: "observe",
          name: "livelock/refused",
          payload: {
            todo: livelock.todo,
            case_id: livelock.caseId,
            plan_digest: livelock.planDigest,
            step_seq: step.seq,
            decision: "refuse_implementation",
          },
        });
        steps.push({ action: action.type, todo: action.todo, red: action.cases });
        return finish("still_red", plan, action, steps);
      }
      if (!hooks.implement) {
        steps.push({ action: action.type, todo: action.todo });
        return finish("need_implement", plan, action, steps);
      }
      const redBefore = new Set(action.cases);
      input.log.append({
        kind: "observe",
        name: "work/doing",
        payload: { todo: action.todo, agent: "dokkabi" },
      });
      const nextPlan = await hooks.implement({ plan, todo: action.todo, cases: action.cases });
      // Hooks may return a replacement or mutate the supplied plan in place.
      // Bind either shape so changed case semantics receive a new definition
      // boundary before verification evidence is recorded.
      plan = persist(input, nextPlan ?? plan);
      steps.push({ action: action.type, todo: action.todo });
      const after = await runVerify(input.log, plan, input.cwd, input.remote, input.waveConcurrency, input.measurements, [action.todo], input.executionViews);
      steps.push(after);
      if (after.error) return fixtureBlocked(input.log, plan, steps, after.error);
      reconcileSemanticLivelocks(input.log, plan);
      recordSemanticLivelock(input.log, plan);
      for (const todo of after.cleared ?? []) await runCheckpoint(input.log, hooks, plan, "todo_clear", todo);
      const still = [...redBefore].filter((id) => after.red?.includes(id));
      if (still.length === redBefore.size) {
        const { misses, exhausted } = recordImplementMiss(stuck, action.todo);
        const deadlock = isSharedCommandDeadlock(plan, action.todo, action.cases);
        // Run 39: locate owned test_host (not on fix) so the shared-command
        // check said "not a deadlock", then still_red after three product-edit
        // turns — even though REPRO.md already existed. Locate evidence is
        // enough to unblock the graph; the official tests belong to fix.
        const earlyDefer = locateReproReady(input.cwd, action.todo);
        if (exhausted || earlyDefer) {
          if (deadlock || earlyDefer) {
            // The wave survives: downstream work owns the same command and
            // can turn it green; this todo clears then.
            deferred.add(action.todo);
            input.log.append({
              kind: "observe",
              name: "work/step",
              payload: {
                action: "defer",
                todo: action.todo,
                reason: earlyDefer && !deadlock ? "locate_repro_ready" : "shared_command_deadlock",
                agent: "dokkabi",
              },
            });
            steps.push({ action: "defer", todo: action.todo });
            continue;
          }
          // The wall. This todo is out of attempts and nothing downstream can
          // finish it, and until now that ended the whole wave — one todo
          // stuck stopped every other todo that had nothing to do with it.
          // Whether that ends anything is a policy, so the graph line decides.
          const resolution = dispatchInterrupt({
            line: "graph",
            class: "todo_exhausted",
            reason: "implement_attempts_exhausted",
            scope: "wave",
            context: { misses },
          }, interruptHandlers);
          input.log.append({
            kind: "observe",
            name: "work/interrupt",
            payload: {
              line: "graph",
              class: "todo_exhausted",
              reason: "implement_attempts_exhausted",
              scope: "wave",
              resolution: resolution.action,
              todo: action.todo,
              misses,
            },
          });
          if (resolution.action === "park") {
            // No bar moved and nothing turned green. The todo is still red and
            // still owed; the run simply stops spending this wave on a wall.
            parked.add(action.todo);
            steps.push({ action: "defer", todo: action.todo });
            continue;
          }
          return finish("still_red", plan, action, steps);
        }
      } else {
        clearImplementMiss(stuck, action.todo);
      }
      continue;
    }
    if (action.type === "clear") {
      if (clearTodo(input.log, plan, action.todo)) {
        steps.push({ action: action.type, todo: action.todo, cleared: [action.todo] });
        await runCheckpoint(input.log, hooks, plan, "todo_clear", action.todo);
      }
    }
  }

  action = decide();
  if (action.type === "done") {
    await runCheckpoint(input.log, hooks, plan, "goal_done");
    return finish("done", plan, action, steps);
  }
  return finish(input.once ? statusFor(action) : "max_steps", plan, action, steps);
}

function fixtureBlocked(log: EventLog, plan: WorkPlan, steps: DriveStep[], error: WorkEvaluatorError): DriveResult {
  const action: WorkAction = { type: "blocked", waiting: [error.reason] };
  log.append({ kind: "observe", name: "work/step", payload: { action: "blocked", ...error } });
  return finish("blocked", plan, action, steps);
}

async function runCheckpoint(
  log: EventLog,
  hooks: DriveHooks,
  plan: WorkPlan,
  reason: "todo_clear" | "goal_done",
  todo?: string,
): Promise<void> {
  if (!hooks.checkpoint) return;
  log.append({ kind: "observe", name: "work/checkpoint", payload: { reason, goal: plan.goal.id, ...(todo ? { todo } : {}), status: "pending" } });
  try {
    await hooks.checkpoint({ plan, reason, ...(todo ? { todo } : {}), events: log.events });
    log.append({ kind: "observe", name: "work/checkpoint", payload: { reason, goal: plan.goal.id, ...(todo ? { todo } : {}), status: "completed" } });
  } catch {
    log.append({ kind: "observe", name: "work/checkpoint", payload: { reason, goal: plan.goal.id, ...(todo ? { todo } : {}), status: "failed" } });
  }
}

async function runVerify(
  log: EventLog,
  plan: WorkPlan,
  cwd: string,
  remote?: CaseRemoteRunner,
  waveConcurrency?: number,
  measurements?: WorkMeasurements,
  selectedOwners: readonly string[] = [],
  executionViews?: ExecutionViews,
): Promise<DriveStep> {
  // The verify pass can run minutes of pytest with no other event — without
  // a start marker the board reads idle while the host is hard at work
  // (run 26 operator report). The completed work/step below closes it.
  log.append({
    kind: "observe",
    name: "work/verify",
    payload: { phase: "start", cases: plan.cases.length },
  });
  // Only what can be acted on now. A case behind an unfinished blocker costs a
  // full remote round trip to re-learn what the graph already says, and on a
  // long chain that was half an hour before the model's first turn.
  const standing = viewPlan(plan, log.events);
  const measuredOwners = new Set(plan.cases.filter(item => item.measurement !== undefined)
    .flatMap(item => plan.scenarios.filter(scenario => scenario.id === item.scenario).map(scenario => scenario.todo)));
  // A completed measured todo still needs a fresh invocation before drive can
  // report done. Ordinary reachable scheduling remains unchanged.
  const scopeTodos = [...new Set([...reachableTodos(plan, log.events), ...selectedOwners,
    ...[...measuredOwners].filter(todo => standing.todoState[todo] === "clear")])];
  // A case green on unchanged terms has nothing left to tell this wave.
  const settled = alreadySettledCases(plan, log.events);
  // What each host is running right now, from the remote diff probe.
  const hostRevisions: Record<string, string> = {};
  for (const event of log.events) {
    if (event.name !== "ssh/diff") continue;
    const p = event.payload as { target?: unknown; revision?: unknown };
    if (typeof p.target === "string" && typeof p.revision === "string") {
      hostRevisions[p.target] = p.revision;
    }
  }
  const result: VerifyResult = await verifyPlan({
    log,
    plan,
    cwd,
    scopeTodos,
    settled,
    hostRevisions,
    executionViews,
    ...(measurements ? { measurements } : {}),
    ...(remote ? { remote } : {}),
    ...(waveConcurrency !== undefined ? { concurrency: waveConcurrency } : {}),
  });
  log.append({
    kind: "observe",
    name: "work/step",
    payload: { action: "verify", agent: "dokkabi" },
  });
  return {
    action: "verify",
    green: result.green,
    red: result.red,
    cleared: result.cleared,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * The step, with what it was about.
 *
 * `blocked` recorded `{action, agent}` and nothing else, 71 times over a
 * 34-hour run. The action already carries `waiting` -- the todo ids the wave
 * is stuck behind, or `no-todos`, or the validator's own errors -- and it was
 * being thrown away at the log boundary. Reading the log afterwards, there
 * was no way to tell what had blocked, so a todo that cycled
 * implement -> verify -> blocked -> replan four times in 35 minutes was
 * indistinguishable from a dependency wait.
 *
 * `cases` is carried for the same reason: a `record_red` or `implement` that
 * names no case cannot be traced to the verdict that caused it.
 */
function recordStep(log: EventLog, action: WorkAction): EventRecord {
  const waiting = action.type === "blocked" ? action.waiting : undefined;
  return log.append({
    kind: "observe",
    name: "work/step",
    payload: {
      action: action.type,
      todo: "todo" in action ? action.todo : undefined,
      ...(waiting !== undefined ? { waiting, waiting_count: waiting.length } : {}),
      ...("cases" in action && action.cases.length > 0 ? { cases: action.cases } : {}),
      agent: "dokkabi",
    },
  });
}

function persist(input: { log: EventLog; planPath?: string }, plan: WorkPlan): WorkPlan {
  bindPlan(input.log, plan);
  if (input.planPath) {
    writeWorkPlan(input.planPath, plan);
  }
  return plan;
}

function statusFor(action: WorkAction): DriveStatus {
  if (action.type === "write_scenarios") {
    return "need_scenarios";
  }
  if (action.type === "write_cases") {
    return "need_cases";
  }
  if (action.type === "implement") {
    return "need_implement";
  }
  if (action.type === "blocked") {
    return "blocked";
  }
  if (action.type === "done") {
    return "done";
  }
  return "max_steps";
}

function finish(status: DriveStatus, plan: WorkPlan, action: WorkAction, steps: DriveStep[]): DriveResult {
  return { status, plan, action, steps };
}
