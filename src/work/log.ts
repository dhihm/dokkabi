import { foldRecoveryEpisodes } from "../host/recovery.ts";
import { experimentRuntime } from "../plugins/experiment-runtime.ts";
import { clearEvidence } from "./replay-evidence.ts";
import { canClear, viewPlan } from "./view.ts";
import { projectObligations } from "./evidence/obligations.ts";
import { planAuthorityInputs } from "./evidence/authority.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import {
  projectSessionReplaySchemas,
  type EventInput,
  type EventRecord,
} from "../host/schema.ts";
import { safeModelInputText } from "../host/model-input.ts";
import { isToolProfileName } from "../loader/tool-profiles.ts";
import { classifyWorkCeiling } from "./ceiling.ts";
import { takeHeungSignal } from "./heung.ts";
import { planDigest } from "./digest.ts";
import { loadWorkPlan } from "./load.ts";
import type { Case, WorkClass, WorkPlan } from "./schema.ts";
import { isCaseLayer, isWorkClass } from "./schema.ts";
import {
  recordedSemanticPlanDefinitionDigest,
  semanticPlanDefinitionDigest,
  validCaseEvidenceDefinition,
} from "./semantic-livelock-plan.ts";
import { caseEvidenceTerms, workCaseDigest } from "./scope.ts";

export function defaultWorkPlanPath(repoRoot: string): string {
  if (process.env.DOKKABI_WORK_PLAN) {
    return process.env.DOKKABI_WORK_PLAN;
  }
  const preferred = resolve(repoRoot, "work", "plan.json");
  if (existsSync(preferred)) {
    return preferred;
  }
  const current = resolve(repoRoot, "work", "current.json");
  if (existsSync(current)) {
    return current;
  }
  return resolve(repoRoot, "work", "example.json");
}

/** An ordinary turn is standalone unless its own workspace or operator binds a ledger. */
export function optionalTurnPlanPath(workspaceRoot: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.DOKKABI_WORK_PLAN) return process.env.DOKKABI_WORK_PLAN;
  const candidate = defaultWorkPlanPath(workspaceRoot);
  return existsSync(candidate) ? candidate : undefined;
}

export function lastPlanDigest(events: readonly EventRecord[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name === "work/goal" && typeof event.payload.digest === "string") {
      return event.payload.digest;
    }
  }
  return undefined;
}

/** Seal the operator order as the live goal so the dash updates before decompose. */
export function sealOperatorGoal(log: EventLog, order: string): void {
  const statement = safeModelInputText(takeHeungSignal(order).order).text.replace(/\s+/g, " ").trim();
  if (!statement) {
    return;
  }
  // A new operator turn starts a new evidence scope — but a RESTART is not a
  // new order. One night saw five relaunches of one unattended goal; each
  // sealed a fresh scope, wiped hours of green evidence, and re-ran every
  // heavy case to confirm verdicts nobody doubted. Identity, not text
  // equality, decides: the same order while its previous scope is still
  // unfinished resumes that scope. Once the goal completed, the same
  // sentence is a genuinely new ask and opens a fresh scope as before.
  if (resumesUnfinishedScope(log.events, statement)) {
    return;
  }
  log.append({
    kind: "observe",
    name: "work/goal",
    payload: { id: "goal-ask", statement, digest: "pending" },
  });
  // A new operator turn reseals the ceiling even when the goal statement
  // already exists — same session, next order must not inherit the old line.
  log.append({
    kind: "observe",
    name: "work/ceiling",
    payload: { ceiling: classifyWorkCeiling(statement), order: statement },
  });
}

/** True when this exact order already owns the latest scope and its goal has
 * not completed — the relaunch continues that work rather than re-asking. */
function resumesUnfinishedScope(events: readonly EventRecord[], statement: string): boolean {
  const lastAsk = [...events].reverse().find(
    (event) => event.name === "work/goal" && event.payload.digest === "pending",
  );
  if (!lastAsk || lastAsk.payload.statement !== statement) return false;
  // Finished means the drive said so — a goal_done checkpoint or done step —
  // or every todo the scope's plan bound has since cleared. A finished scope
  // re-asked with the same sentence is a genuinely new ask.
  const after = events.filter((event) => event.seq > lastAsk.seq);
  // Implementation TODOs can clear before acceptance's provider recovers.
  // Restart of that order still owns its exhausted/uncertain operation; it
  // cannot obtain a fresh scope merely because implementation is green.
  const unfinishedRecovery = foldRecoveryEpisodes(events).some(episode => episode.state !== "completed"
    && after.some(event => event.name === "recovery/begin" && (event.payload.episode as { episodeId?: unknown })?.episodeId === episode.episodeId));
  const unfinishedChild = after.some(event => event.name === "work/recovery_child"
    && !events.some(row => row.name === "work/recovery_child_completed" && row.payload.admission_seq === event.seq));
  if (unfinishedRecovery || unfinishedChild) return true;
  const declaredDone = after.some(
    (event) => (event.name === "work/checkpoint"
        && event.payload.reason === "goal_done"
        && event.payload.status === "completed")
      || (event.name === "work/step" && event.payload.action === "done"),
  );
  if (declaredDone) return false;
  const boundTodos = new Set<string>();
  for (const event of after) {
    if (event.name === "work/todo" && typeof event.payload.id === "string") {
      boundTodos.add(event.payload.id);
    }
  }
  if (boundTodos.size > 0) {
    const cleared = new Set(
      after
        .filter((event) => event.name === "work/clear" && typeof event.payload.todo === "string")
        .map((event) => event.payload.todo as string),
    );
    if ([...boundTodos].every((todo) => cleared.has(todo))) return false;
  }
  return true;
}

function retainedCaseEvidenceTerms(item: Case | Record<string, unknown>): Partial<Case> | undefined {
  const terms = caseEvidenceTerms(item).evidence_terms as Record<string, unknown> | undefined;
  if (terms === undefined) return undefined;
  // Plans are editable. Neither binding nor resuming one may share mutable
  // measurement objects with the retained event that authenticates them.
  return structuredClone(Object.fromEntries(Object.entries(terms).filter(([, value]) => value !== undefined)));
}

export function bindPlan(log: EventLog, plan: WorkPlan): { digest: string; appended: boolean } {
  experimentRuntime(log);
  for (const item of plan.cases) {
    if (!validCaseEvidenceDefinition(item)) {
      throw new Error(`case ${item.id} has an invalid evidence definition`);
    }
  }
  const digest = planDigest(plan);
  const semanticDefinitionDigest = semanticPlanDefinitionDigest(plan);
  const records = log.appendBatchDurable((nextSeq) => {
    const authorityInputs = planAuthorityInputs(log.events, plan, nextSeq);
    const semanticFeatureStart = projectSessionReplaySchemas(log.events)
      .featureStart.get("semantic-livelock-v1");
    const previous = [...log.events].reverse().find((event) => event.name === "work/goal");
    if (previous?.payload.digest === digest
      && previous.payload.id === plan.goal.id
      && previous.payload.statement === plan.goal.statement
      && previous.payload.semantic_definition_digest === semanticDefinitionDigest
      && typeof previous.payload.authority_digest === "string"
      && (semanticFeatureStart === undefined || previous.seq >= semanticFeatureStart)
      && recordedSemanticPlanDefinitionDigest(log.events, previous.seq) === semanticDefinitionDigest) {
      return authorityInputs;
    }
    const scopeSeq = previous
      ? previous.payload.digest === "pending"
        ? previous.seq
        : typeof previous.payload.scope_seq === "number"
          ? previous.payload.scope_seq
          : previous.seq
      : projectObligations(log.events).current?.scope_seq;
    const newSnapshot = authorityInputs.find(input => input.name === "work/obligations");
    const authority = newSnapshot?.payload ?? (() => {
      const current = projectObligations(log.events).current;
      return current ? { digest: current.digest, revision: current.revision, scope_seq: current.scope_seq } : undefined;
    })();
    const effectiveScope = Number(authority?.scope_seq ?? scopeSeq ?? nextSeq);
    const inputs: EventInput[] = [...authorityInputs, {
      kind: "observe",
      name: "work/goal",
      payload: {
        id: plan.goal.id,
        statement: plan.goal.statement,
        digest,
        semantic_definition_digest: semanticDefinitionDigest,
        ...(authority ? { authority_digest: authority.digest, authority_revision: authority.revision } : {}),
        ...(plan.require_red_first === undefined ? {} : { require_red_first: plan.require_red_first }),
        ...(scopeSeq === undefined && authorityInputs.length === 0 ? {} : { scope_seq: effectiveScope }),
      },
    }];
    for (const todo of plan.todos) inputs.push({
      kind: "observe",
      name: "work/todo",
      payload: {
        ...structuredClone(todo),
        id: todo.id,
        title: todo.title,
        class: todo.class,
        priority: todo.priority,
        blocked_by: todo.blocked_by,
        statement: todo.statement,
        ...(todo.judgment === undefined ? {} : { judgment: todo.judgment }),
        ...(todo.plan === undefined ? {} : { plan: todo.plan }),
        ...(todo.profile === undefined ? {} : { profile: todo.profile }),
      },
    });
    for (const scenario of plan.scenarios) inputs.push({
      kind: "observe",
      name: "work/scenario",
      payload: {
        ...structuredClone(scenario),
        id: scenario.id,
        todo: scenario.todo,
        given: scenario.given,
        when: scenario.when,
        then: scenario.then,
      },
    });
    for (const item of plan.cases) inputs.push({
      kind: "observe",
      name: "work/case",
      payload: {
        ...structuredClone(item),
        id: item.id,
        scenario: item.scenario,
        layer: item.layer,
        command: item.command,
        red_means: item.red_means,
        green_means: item.green_means,
        ...(item.guard === true || (item.guard === false && caseEvidenceTerms(item).evidence_terms !== undefined)
          ? { guard: item.guard } : {}),
        // Store the actual terms, not only a digest: the dashboard, replay and
        // session resume must reconstruct the same declared claim from the log.
        ...retainedCaseEvidenceTerms(item),
        case_digest: workCaseDigest(item, plan.scenarios.find((scenario) => scenario.id === item.scenario)),
        scope_seq: effectiveScope,
      },
    });
    return inputs;
  });
  return { digest, appended: records.length > 0 };
}

export function bindPlanFile(log: EventLog, path: string): { digest: string; appended: boolean } {
  const { plan, errors } = loadWorkPlan(path);
  if (errors.length > 0) {
    throw new Error(`invalid work plan ${path}: ${errors.join("; ")}`);
  }
  return bindPlan(log, plan);
}

export function readPlanFromLog(events: readonly EventRecord[]): WorkPlan | undefined {
  try {
    const accepted = projectObligations(events).current;
    if (accepted) return structuredClone(accepted.plan);
  } catch { return undefined; }
  let goalIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "work/goal") {
      goalIndex = i;
      break;
    }
  }
  if (goalIndex < 0) {
    return undefined;
  }
  const goalEvent = events[goalIndex];
  if (!goalEvent || typeof goalEvent.payload.id !== "string" || typeof goalEvent.payload.statement !== "string") {
    return undefined;
  }
  const slice = events.slice(goalIndex);
  const todoPayloads = lastById(slice, "work/todo");
  if (todoPayloads.some((payload) => payload.profile !== undefined && !isToolProfileName(payload.profile))) {
    return undefined;
  }
  const todos = todoPayloads.map((payload) => ({
    id: String(payload.id),
    title: String(payload.title ?? payload.id),
    class: (isWorkClass(String(payload.class)) ? payload.class : "host") as WorkClass,
    priority: typeof payload.priority === "number" ? payload.priority : 100,
    blocked_by: Array.isArray(payload.blocked_by) ? payload.blocked_by.map(String) : [],
    statement: String(payload.statement ?? ""),
    ...(typeof payload.judgment === "string" ? { judgment: payload.judgment } : {}),
    ...(typeof payload.plan === "string" ? { plan: payload.plan } : {}),
    ...(isToolProfileName(payload.profile) ? { profile: payload.profile } : {}),
  }));
  const scenarios = lastById(slice, "work/scenario").map((payload) => ({
    id: String(payload.id),
    todo: String(payload.todo ?? ""),
    given: String(payload.given ?? ""),
    when: String(payload.when ?? ""),
    then: String(payload.then ?? ""),
  }));
  const cases: Case[] = [];
  for (const payload of lastById(slice, "work/case")) {
    if (typeof payload.scenario !== "string") continue;
    if (!validCaseEvidenceDefinition(payload)) return undefined;
    const layer = String(payload.layer);
    const evidenceTerms = retainedCaseEvidenceTerms(payload);
    const item: Case = {
      id: String(payload.id),
      scenario: payload.scenario,
      layer: isCaseLayer(layer) ? layer : "unit",
      command: String(payload.command ?? ""),
      red_means: String(payload.red_means ?? ""),
      green_means: String(payload.green_means ?? ""),
      ...(payload.guard === true || (payload.guard === false && evidenceTerms !== undefined)
        ? { guard: payload.guard } : {}),
      ...evidenceTerms,
    };
    // A removed or altered body must not silently downgrade a measured case.
    // Pre-digest historical definitions still retain their existing projection.
    if (evidenceTerms !== undefined && typeof payload.case_digest !== "string") return undefined;
    if (typeof payload.case_digest === "string"
      && payload.case_digest !== workCaseDigest(item, scenarios.find(scenario => scenario.id === item.scenario))) {
      return undefined;
    }
    cases.push(item);
  }
  return {
    goal: { id: goalEvent.payload.id, statement: goalEvent.payload.statement },
    todos,
    scenarios,
    cases,
    ...(typeof goalEvent.payload.require_red_first === "boolean"
      ? { require_red_first: goalEvent.payload.require_red_first }
      : {}),
  };
}

export function lastDoing(events: readonly EventRecord[]): { todo: string; agent: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "work/doing") {
      continue;
    }
    if (typeof event.payload.todo !== "string") {
      return undefined;
    }
    return {
      todo: event.payload.todo,
      agent: typeof event.payload.agent === "string" ? event.payload.agent : "dokkabi",
    };
  }
  return undefined;
}

function lastById(events: readonly EventRecord[], name: string): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.name !== name) {
      continue;
    }
    const id = event.payload.id;
    if (typeof id !== "string") {
      continue;
    }
    const current = map.get(id);
    if (name === "work/case" && current && typeof event.payload.scenario !== "string") {
      continue;
    }
    map.set(id, event.payload);
  }
  return [...map.values()];
}


/** Decide and append under the EventLog authority lock. Concurrent writers
 * cannot turn a stale projection into a second or unearned completion. */
export function clearTodo(log: EventLog, plan: WorkPlan, todo: string): boolean {
  const records = log.appendBatchDurable(() => {
    const view = viewPlan(plan, log.events);
    if (!canClear(view, todo)) return [];
    return [{ kind: "observe", name: "work/clear", payload: { todo, plan: plan.goal.id,
      ...(projectSessionReplaySchemas(log.events).featureStart.has("work-replay-v1") ? clearEvidence(plan, log.events, todo) : {}) } }];
  });
  return records.some(event => event.name === "work/clear");
}
