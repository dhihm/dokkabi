import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import { WORK_CLASSES, type WorkClass } from "./schema.ts";

export const DRAFT_PLAN_FORMAT = 1 as const;
const ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_ITEMS = 32;
const MAX_TEXT = 1_024;
const MAX_BYTES = 64 * 1_024;

export interface DraftPlanConcern {
  readonly id: string;
  readonly statement: string;
  readonly blocking: boolean;
}

export interface DraftPlanEvidenceRef {
  readonly id: string;
  readonly path: string;
  readonly detail: string;
}

export interface DraftPlanBoundary {
  readonly id: string;
  readonly statement: string;
}

export interface DraftPlanTodo {
  readonly id: string;
  readonly title: string;
  readonly class: WorkClass;
  readonly priority: number;
  readonly blocked_by: string[];
  readonly statement: string;
  readonly covers: string[];
  readonly evidence_refs: string[];
  readonly test_intents: string[];
}

export interface DraftPlan {
  readonly format: typeof DRAFT_PLAN_FORMAT;
  readonly revision: number;
  readonly supersedes?: string;
  readonly goal: { readonly statement: string };
  readonly scope: string[];
  readonly non_goals: string[];
  readonly assumptions: string[];
  readonly unknowns: DraftPlanConcern[];
  readonly contradictions: DraftPlanConcern[];
  readonly risks: string[];
  readonly evidence_refs: DraftPlanEvidenceRef[];
  readonly boundaries: DraftPlanBoundary[];
  readonly todos: DraftPlanTodo[];
}

export type DraftPlanFindingKind =
  | "missing_boundary"
  | "duplicate"
  | "already_implemented"
  | "dependency"
  | "evidence"
  | "risk";

export interface DraftPlanFinding extends DraftPlanConcern {
  readonly kind: DraftPlanFindingKind;
  readonly evidence_refs: string[];
}

export interface DraftPlanCritique {
  readonly format: typeof DRAFT_PLAN_FORMAT;
  readonly verdict: "accept" | "revise";
  readonly findings: DraftPlanFinding[];
}

export interface DraftPlanSynthesis {
  readonly draft: DraftPlan;
  readonly resolved_findings: string[];
}

export function parseDraftPlanReply(reply: string, order: string, revision: number, supersedes?: string): {
  readonly plan?: DraftPlan;
  readonly errors: string[];
} {
  const parsed = parseJsonReply(reply);
  if (parsed.error) return { errors: [parsed.error] };
  if (!isRecord(parsed.value)) return { errors: ["draft plan reply must be one JSON object"] };
  const raw = parsed.value;
  const {
    format: _modelFormat,
    revision: _modelRevision,
    supersedes: _modelSupersedes,
    goal: _modelGoal,
    ...body
  } = raw;
  const plan = {
    ...body,
    format: DRAFT_PLAN_FORMAT,
    revision,
    ...(supersedes ? { supersedes } : {}),
    goal: { statement: compact(order) },
  } as unknown as DraftPlan;
  const errors = validateDraftPlan(plan);
  return errors.length > 0 ? { plan, errors } : { plan, errors: [] };
}

export function parseDraftPlanCritique(reply: string, plan: DraftPlan): {
  readonly critique?: DraftPlanCritique;
  readonly errors: string[];
} {
  const parsed = parseJsonReply(reply);
  if (parsed.error) return { errors: [parsed.error] };
  if (!isRecord(parsed.value)) return { errors: ["plan critique reply must be one JSON object"] };
  const critique = parsed.value as unknown as DraftPlanCritique;
  const errors = validateCritique(critique, plan);
  return errors.length > 0 ? { critique, errors } : { critique, errors: [] };
}

export function parseDraftPlanSynthesis(
  reply: string,
  order: string,
  revision: number,
  supersedes: string,
  critique: DraftPlanCritique,
): { readonly synthesis?: DraftPlanSynthesis; readonly errors: string[] } {
  const parsed = parseJsonReply(reply);
  if (parsed.error) return { errors: [parsed.error] };
  if (!isRecord(parsed.value) || !isRecord(parsed.value.draft)) {
    return { errors: ["plan synthesis reply must contain a draft object"] };
  }
  const synthesisShapeErrors: string[] = [];
  validateKeys(parsed.value, ["draft", "resolved_findings"], "plan synthesis", synthesisShapeErrors);
  const draftResult = parseDraftPlanReply(
    JSON.stringify(parsed.value.draft),
    order,
    revision,
    supersedes,
  );
  const resolved = stringArray(parsed.value.resolved_findings);
  const errors = [...synthesisShapeErrors, ...draftResult.errors];
  if (!Array.isArray(parsed.value.resolved_findings)) {
    errors.push("resolved_findings must be an array");
  } else if (parsed.value.resolved_findings.some((item) => typeof item !== "string" || !ID.test(item))) {
    errors.push("resolved_findings must contain valid finding ids");
  }
  const blocking = critique.findings.filter((finding) => finding.blocking).map((finding) => finding.id);
  const findingIds = new Set(critique.findings.map((finding) => finding.id));
  for (const id of resolved) {
    if (!findingIds.has(id)) errors.push(`resolved_findings references unknown finding ${id}`);
  }
  for (const id of blocking) {
    if (!resolved.includes(id)) errors.push(`blocking finding ${id} was not resolved`);
  }
  const plan = draftResult.plan;
  if (plan && draftResult.errors.length === 0 && draftPlanDigest(plan) === supersedes && blocking.length > 0) {
    errors.push("synthesis made no semantic progress on blocking findings");
  }
  return errors.length > 0 || !plan
    ? { errors }
    : { synthesis: { draft: plan, resolved_findings: unique(resolved) }, errors: [] };
}

export function validateDraftPlan(plan: DraftPlan, workspaceRoot?: string): string[] {
  const errors: string[] = [];
  if (!isRecord(plan)) return ["draft plan must be an object"];
  validateKeys(plan, [
    "format", "revision", "supersedes", "goal", "scope", "non_goals", "assumptions",
    "unknowns", "contradictions", "risks", "evidence_refs", "boundaries", "todos",
  ], "draft plan", errors);
  if (plan.format !== DRAFT_PLAN_FORMAT) errors.push(`draft plan format must be ${DRAFT_PLAN_FORMAT}`);
  if (!Number.isInteger(plan.revision) || plan.revision < 1) errors.push("draft plan revision must be a positive integer");
  if (plan.supersedes !== undefined && !/^[a-f0-9]{64}$/u.test(plan.supersedes)) {
    errors.push("draft plan supersedes must be a sha256 digest");
  }
  if (!isRecord(plan.goal) || !validText(plan.goal.statement)) errors.push("draft plan goal.statement is required");
  validateTextArray(plan.scope, "scope", errors, true);
  validateTextArray(plan.non_goals, "non_goals", errors);
  validateTextArray(plan.assumptions, "assumptions", errors);
  validateTextArray(plan.risks, "risks", errors);
  validateConcerns(plan.unknowns, "unknowns", errors);
  validateConcerns(plan.contradictions, "contradictions", errors);
  if (Array.isArray(plan.unknowns) && plan.unknowns.some((item) => isRecord(item) && item.blocking === true)) {
    errors.push("draft plan has blocking unknowns");
  }
  if (Array.isArray(plan.contradictions) && plan.contradictions.some((item) => isRecord(item) && item.blocking === true)) {
    errors.push("draft plan has blocking contradictions");
  }

  if (!boundedArray(plan.evidence_refs, "evidence_refs", errors)) return errors;
  if (!boundedArray(plan.boundaries, "boundaries", errors, true)) return errors;
  if (!boundedArray(plan.todos, "todos", errors, true)) return errors;

  const evidenceIds = validateIdRows(plan.evidence_refs, "evidence", errors);
  const boundaryIds = validateIdRows(plan.boundaries, "boundary", errors);
  const todoIds = validateIdRows(plan.todos, "todo", errors);
  const evidenceRows = plan.evidence_refs.filter(isRecord);
  const boundaryRows = plan.boundaries.filter(isRecord);
  const todoRows = plan.todos.filter(isRecord);
  for (const evidence of evidenceRows) {
    validateKeys(evidence, ["id", "path", "detail"], `evidence ${String(evidence.id)}`, errors);
    if (!validText(evidence.path) || !validText(evidence.detail)) {
      errors.push(`evidence ${String(evidence.id)} needs path and detail`);
      continue;
    }
    if (workspaceRoot) {
      const path = resolveEvidencePath(workspaceRoot, evidence.path);
      if (!path) errors.push(`evidence ${evidence.id} path escapes the workspace`);
      else if (!existsSync(path)) errors.push(`evidence ${evidence.id} path does not exist: ${evidence.path}`);
    }
  }
  for (const boundary of boundaryRows) {
    validateKeys(boundary, ["id", "statement"], `boundary ${String(boundary.id)}`, errors);
    if (!validText(boundary.statement)) errors.push(`boundary ${String(boundary.id)} needs a statement`);
  }
  for (const todo of todoRows) {
    validateKeys(todo, [
      "id", "title", "class", "priority", "blocked_by", "statement", "covers",
      "evidence_refs", "test_intents",
    ], `todo ${String(todo.id)}`, errors);
    if (!validText(todo.title) || !validText(todo.statement)) errors.push(`todo ${String(todo.id)} needs title and statement`);
    if (!(WORK_CLASSES as readonly string[]).includes(todo.class)) errors.push(`todo ${String(todo.id)} has invalid class`);
    if (!Number.isInteger(todo.priority) || todo.priority < 0) {
      errors.push(`todo ${String(todo.id)} priority must be a non-negative integer`);
    }
    validateRefArray(todo.blocked_by, todoIds, `todo ${String(todo.id)} blocked_by`, errors, true);
    validateRefArray(todo.covers, boundaryIds, `todo ${String(todo.id)} covers`, errors, false);
    validateRefArray(todo.evidence_refs, evidenceIds, `todo ${String(todo.id)} evidence_refs`, errors, false);
    validateTextArray(todo.test_intents, `todo ${String(todo.id)} test_intents`, errors, true);
  }
  for (const boundary of boundaryIds) {
    if (!todoRows.some((todo) => Array.isArray(todo.covers) && todo.covers.includes(boundary))) {
      errors.push(`boundary ${boundary} is not covered by a todo`);
    }
  }
  errors.push(...cycleErrors(todoRows as unknown as DraftPlanTodo[]));
  if (Buffer.byteLength(canonicalJson(plan)) > MAX_BYTES) errors.push(`draft plan exceeds ${MAX_BYTES} bytes`);
  return unique(errors);
}

export function draftPlanDigest(plan: DraftPlan): string {
  return createHash("sha256").update(canonicalJson(semanticDraft(plan))).digest("hex");
}

export function writeDraftPlan(path: string, plan: DraftPlan): void {
  const errors = validateDraftPlan(plan);
  if (errors.length > 0) throw new Error(`invalid draft plan: ${errors.join("; ")}`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function validateCritique(critique: DraftPlanCritique, plan: DraftPlan): string[] {
  const errors: string[] = [];
  validateKeys(
    critique as unknown as Record<string, unknown>,
    ["format", "verdict", "findings"],
    "plan critique",
    errors,
  );
  if (critique.format !== DRAFT_PLAN_FORMAT) errors.push(`plan critique format must be ${DRAFT_PLAN_FORMAT}`);
  if (critique.verdict !== "accept" && critique.verdict !== "revise") errors.push("plan critique verdict must be accept or revise");
  if (!boundedArray(critique.findings, "findings", errors)) return errors;
  const findingIds = validateIdRows(critique.findings, "finding", errors);
  void findingIds;
  const evidenceIds = new Set(plan.evidence_refs.map((item) => item.id));
  const kinds = new Set<DraftPlanFindingKind>([
    "missing_boundary", "duplicate", "already_implemented", "dependency", "evidence", "risk",
  ]);
  for (const finding of critique.findings.filter(isRecord)) {
    validateKeys(
      finding,
      ["id", "kind", "statement", "blocking", "evidence_refs"],
      `finding ${String(finding.id)}`,
      errors,
    );
    if (!kinds.has(finding.kind)) errors.push(`finding ${String(finding.id)} has invalid kind`);
    if (!validText(finding.statement) || typeof finding.blocking !== "boolean") {
      errors.push(`finding ${String(finding.id)} needs statement and blocking`);
    }
    validateRefArray(finding.evidence_refs, evidenceIds, `finding ${String(finding.id)} evidence_refs`, errors, true);
    if (finding.kind === "already_implemented" && Array.isArray(finding.evidence_refs) && finding.evidence_refs.length === 0) {
      errors.push(`finding ${String(finding.id)} already_implemented needs evidence`);
    }
  }
  const blocking = critique.findings.some((finding) => isRecord(finding) && finding.blocking === true);
  if (critique.verdict === "accept" && blocking) errors.push("accept critique cannot contain blocking findings");
  if (critique.verdict === "revise" && !blocking) errors.push("revise critique needs at least one blocking finding");
  return unique(errors);
}

function semanticDraft(plan: DraftPlan): unknown {
  const sortText = (items: readonly string[]) => [...items].sort();
  const sortById = <T extends { readonly id: string }>(items: readonly T[]) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: plan.format,
    goal: plan.goal,
    scope: sortText(plan.scope),
    non_goals: sortText(plan.non_goals),
    assumptions: sortText(plan.assumptions),
    unknowns: sortById(plan.unknowns),
    contradictions: sortById(plan.contradictions),
    risks: sortText(plan.risks),
    evidence_refs: sortById(plan.evidence_refs),
    boundaries: sortById(plan.boundaries),
    todos: sortById(plan.todos).map((todo) => ({
      ...todo,
      blocked_by: sortText(todo.blocked_by),
      covers: sortText(todo.covers),
      evidence_refs: sortText(todo.evidence_refs),
      test_intents: sortText(todo.test_intents),
    })),
  };
}

function parseJsonReply(reply: string): { value?: unknown; error?: string } {
  const text = reply.trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
  const body = (fenced?.[1] ?? text).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) {
    return { error: "planner reply must contain only one JSON object" };
  }
  try {
    return { value: JSON.parse(body) };
  } catch (error) {
    return { error: `planner reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function validateConcerns(value: unknown, label: string, errors: string[]): void {
  if (!boundedArray(value, label, errors)) return;
  validateIdRows(value, label.slice(0, -1), errors);
  for (const item of value.filter(isRecord)) {
    validateKeys(item, ["id", "statement", "blocking"], `${label} ${String(item.id)}`, errors);
    if (!validText(item.statement) || typeof item.blocking !== "boolean") {
      errors.push(`${label} ${String(item.id)} needs statement and blocking`);
    }
  }
}

function validateTextArray(value: unknown, label: string, errors: string[], required = false): void {
  if (!boundedArray(value, label, errors, required)) return;
  if ((value as unknown[]).some((item) => !validText(item))) errors.push(`${label} must contain short non-empty strings`);
}

function boundedArray(value: unknown, label: string, errors: string[], required = false): value is unknown[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return false;
  }
  if (required && value.length === 0) errors.push(`${label} must not be empty`);
  if (value.length > MAX_ITEMS) errors.push(`${label} exceeds ${MAX_ITEMS} items`);
  return true;
}

function validateIdRows(value: readonly unknown[], label: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id)) {
      errors.push(`${label} id is invalid`);
      continue;
    }
    if (ids.has(item.id)) errors.push(`duplicate ${label} ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function validateRefArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  errors: string[],
  allowEmpty: boolean,
): void {
  if (!boundedArray(value, label, errors, !allowEmpty)) return;
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) errors.push(`${label} references unknown id ${String(item)}`);
  }
}

function cycleErrors(todos: readonly DraftPlanTodo[]): string[] {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const errors: string[] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) {
      errors.push(`draft todo dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.blocked_by ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return errors;
}

function resolveEvidencePath(workspaceRoot: string, value: string): string | undefined {
  const raw = value.replace(/:\d+(?::\d+)?$/u, "");
  if (isAbsolute(raw)) return undefined;
  const root = resolve(workspaceRoot);
  const target = resolve(root, raw);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? target : undefined;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT && !/[\r\n]/u.test(value);
}

function validateKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${label} has unknown field ${key}`);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
