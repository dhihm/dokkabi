import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EventRecord } from "../host/schema.ts";
import { LEDGER_PLANNER, ledgerReceiptIds, observations } from "./ledger-label.ts";
import {
  LEDGER_MIRROR_FILE,
  projectLedger,
  revisionCases,
  revisionScenarios,
  revisionTodos,
  ledgerOrderStatement,
  type LedgerGraph,
  type LedgerRevision,
} from "./plan-ledger.ts";
import type { Case, CaseStatus, TodoState, WorkPlan, WorkView } from "./schema.ts";
import { isCaseLayer, isWorkClass } from "./schema.ts";
import { validatePlan, type PlanValidationOptions } from "./validate.ts";
import { loadWorkPlan } from "./load.ts";
import { stateFor } from "./view.ts";

function emptyInvalidPlan(): WorkPlan {
  return { goal: { id: "goal-invalid", statement: "" }, todos: [], scenarios: [], cases: [] };
}

/** True when the session was driven by the default ledger planner. */
export function isLedgerPlannerSession(events: readonly EventRecord[]): boolean {
  return events.some((event) => event.name === "work/ledger_session" && event.payload.planner === LEDGER_PLANNER);
}

function isLedgerMirrorDocument(parsed: unknown): parsed is {
  graph: LedgerGraph;
  digest?: unknown;
  revision?: unknown;
  parent_digest?: unknown;
} {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const graph = (parsed as { graph?: unknown }).graph;
  return graph !== null && typeof graph === "object" && !Array.isArray(graph)
    && Array.isArray((graph as LedgerGraph).todos);
}

/** Reconstruct a WorkPlan shape from the latest ledger revision in a log. */
export function readPlanFromLedgerLog(events: readonly EventRecord[]): WorkPlan | undefined {
  const revision = projectLedger(events);
  if (revision === undefined) return undefined;
  const statement = ledgerOrderStatement(events);
  if (statement === undefined) return undefined;
  return workPlanFromLedgerRevision(revision, statement);
}

export function workPlanFromLedgerRevision(revision: LedgerRevision, statement: string): WorkPlan {
  const graph = revision.graph;
  const todos = revisionTodos(revision).map((item) => {
    const todoClass = String(item.class ?? "");
    return {
      id: item.id,
      title: item.title ?? item.statement ?? item.id,
      class: isWorkClass(todoClass) ? todoClass : "impl",
      priority: typeof item.priority === "number" ? item.priority : 100,
      blocked_by: Array.isArray(item.blocked_by) ? [...item.blocked_by] : [],
      statement: item.statement ?? item.title ?? "",
      ...(typeof item.judgment === "string" ? { judgment: item.judgment } : {}),
      ...(typeof item.plan === "string" ? { plan: item.plan } : {}),
    };
  });
  const scenarios = revisionScenarios(revision).map((item) => ({
    id: item.id,
    todo: item.todo ?? "",
    given: item.given ?? "",
    when: item.when ?? "",
    then: item.then ?? "",
  }));
  const cases: Case[] = revisionCases(revision).map((item) => {
    const layer = String(item.layer ?? "");
    return {
      id: item.id,
      scenario: item.scenario ?? "",
      layer: isCaseLayer(layer) ? layer : "unit",
      command: String(item.command ?? ""),
      red_means: item.red_means ?? "",
      green_means: item.green_means ?? "",
      ...(item.guard === true ? { guard: true } : {}),
    };
  });
  return {
    goal: {
      id: typeof graph.goal?.id === "string" ? graph.goal.id : "goal",
      statement: typeof graph.goal?.statement === "string" ? graph.goal.statement : statement,
    },
    todos,
    scenarios,
    cases,
  };
}

export function isExplicitLedgerMirrorPath(planPath: string): boolean {
  return basename(planPath) === LEDGER_MIRROR_FILE;
}

export function sessionIdBesideLedgerMirror(planPath: string): string | undefined {
  if (!isExplicitLedgerMirrorPath(planPath)) return undefined;
  return basename(dirname(planPath));
}

export function ledgerSessionLogBesidePlan(planPath: string): string | undefined {
  if (basename(planPath) !== LEDGER_MIRROR_FILE) return undefined;
  return join(planPath, "..", "events.jsonl");
}

export function readLedgerMirrorPlanFile(path: string, options: PlanValidationOptions = {}): { plan: WorkPlan; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { plan: emptyInvalidPlan(), errors: [`${path} is not valid JSON: ${message}`] };
  }
  if (!isLedgerMirrorDocument(parsed)) {
    return {
      plan: emptyInvalidPlan(),
      errors: [`${path} is not a ledger mirror (expected ${LEDGER_MIRROR_FILE} with a graph object); for ledger work runs use dokkabi plan status --session <id>`],
    };
  }
  const statement = typeof parsed.graph.goal?.statement === "string" ? parsed.graph.goal.statement : "";
  if (statement === "") {
    return {
      plan: emptyInvalidPlan(),
      errors: [`${path} is a ledger mirror but has no goal statement; use dokkabi plan status --session <id>`],
    };
  }
  const plan = workPlanFromLedgerRevision({
    graph: parsed.graph,
    digest: typeof parsed.digest === "string" ? parsed.digest : "",
    revision: typeof parsed.revision === "number" ? parsed.revision : 0,
    parent_digest: typeof parsed.parent_digest === "string" || parsed.parent_digest === null ? parsed.parent_digest : null,
  }, statement);
  return { plan, errors: validatePlan(plan, options) };
}

function casesForTodo(plan: WorkPlan, todoId: string) {
  const scenarioIds = new Set(plan.scenarios.filter((scenario) => scenario.todo === todoId).map((scenario) => scenario.id));
  return plan.cases.filter((item) => scenarioIds.has(item.scenario));
}

function ledgerEarnedClears(plan: WorkPlan, caseStatus: Record<string, CaseStatus>): Set<string> {
  const cleared = new Set<string>();
  for (const todo of plan.todos) {
    const cases = casesForTodo(plan, todo.id);
    if (cases.length > 0 && cases.every((item) => caseStatus[item.id] === "green")) {
      cleared.add(todo.id);
    }
  }
  return cleared;
}

/** Todo ids the ledger graph marks done (the model's claim, not host clearance). */
export function ledgerModelClaimedDone(events: readonly EventRecord[]): string[] {
  const revision = projectLedger(events);
  if (revision === undefined) return [];
  return revisionTodos(revision)
    .filter((todo) => todo.status === "done")
    .map((todo) => todo.id)
    .sort((a, b) => a.localeCompare(b));
}

/** Green ledger/case rows whose receipt is missing or not in the log (V7). */
export function ledgerGreenWithoutReceipt(events: readonly EventRecord[], plan: WorkPlan): string[] {
  const { rows } = observations(events);
  const receipts = ledgerReceiptIds(events);
  const ids: string[] = [];
  for (const item of plan.cases) {
    const row = rows.get(item.id);
    if (row === undefined || row.unrunnable || row.status !== "green") continue;
    if (row.receipt === undefined || !receipts.has(row.receipt)) ids.push(item.id);
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

function ledgerCaseStatus(
  row: { readonly status: string; readonly unrunnable: boolean; readonly receipt: string | undefined },
  receipts: ReadonlySet<string>,
): CaseStatus | undefined {
  if (row.unrunnable) return undefined;
  if (row.status === "red") return "red";
  if (row.status === "green") {
    return row.receipt !== undefined && receipts.has(row.receipt) ? "green" : undefined;
  }
  return undefined;
}

/** Read-only verdict projection for ledger-planner sessions (`dokkabi plan` only). */
export function viewLedgerPlan(plan: WorkPlan, events: readonly EventRecord[]): WorkView {
  const { rows } = observations(events);
  const receipts = ledgerReceiptIds(events);
  const caseStatus: Record<string, CaseStatus> = {};
  for (const item of plan.cases) {
    const row = rows.get(item.id);
    if (row === undefined) continue;
    const status = ledgerCaseStatus(row, receipts);
    if (status !== undefined) caseStatus[item.id] = status;
  }
  const cleared = ledgerEarnedClears(plan, caseStatus);
  const todoState: Record<string, TodoState> = {};
  for (const todo of plan.todos) {
    todoState[todo.id] = stateFor(plan, todo.id, caseStatus, cleared, todoState);
  }
  const ready = plan.todos
    .filter((todo) => todoState[todo.id] === "ready" || todoState[todo.id] === "red")
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((todo) => todo.id);
  const errors = validatePlan(plan, { skipCaseRunnerChecks: true });
  return { plan, caseStatus, todoState, ready, errors };
}

function looksLikeLedgerMirrorAttempt(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if ("graph" in record) return true;
  if ("revision" in record || "digest" in record) return !Array.isArray(record.todos);
  return false;
}

/** Load a workspace plan file or a session ledger mirror beside the log. */
export function loadPlanFromPath(path: string, options: PlanValidationOptions = {}): { plan: WorkPlan; errors: string[] } {
  const work = loadWorkPlan(path, options);
  if (work.errors.length === 0) return work;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return work;
  }
  if (isLedgerMirrorDocument(parsed) || looksLikeLedgerMirrorAttempt(parsed)) {
    return readLedgerMirrorPlanFile(path, options);
  }
  return work;
}
