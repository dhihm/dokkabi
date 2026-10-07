import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { EventRecord } from "../host/schema.ts";
import { orderScope } from "./evidence/obligations.ts";

/**
 * The plan ledger (interfaces-v3.md §1): the model's work graph as data the
 * host appends, never a gate. Everything in this file is pure — structural
 * checks, the open-todo projection and the ledger projection from the log —
 * so tests run driver-free and replay reproduces every revision.
 *
 * Structural checks only: ids unique, references resolve, blocked_by acyclic,
 * case.command non-empty, a dropped todo carries a reason. Findings are data
 * `{check, node, fact}`; a graph with findings is simply not recorded.
 *
 * Two rows carry revisions. `work/ledger` holds a whole graph (every `plan`
 * call; a `check` call with no revision to extend or under a changed order).
 * `work/ledger_case` (D48b) holds the one case a `check` call declares, as a
 * revision of its own, so a session of n checks appends n cases instead of
 * n whole graphs; the projection folds it onto the latest graph by id.
 *
 * A case a `check` call declared stays in the projected graph across later
 * whole graphs (D52): a `plan` revision states the whole set of the cases the
 * plan itself declares, and a check case it does not mention stays where it
 * was. Only an explicit drop removes one — `drop_cases: [{id, reason}]` on the
 * row, a non-empty reason each — and the drops stay readable for the
 * conclusion. A log with no case row, no `check_case` and no `drop_cases`
 * (every recording before D52 without case rows) projects exactly as before.
 */

/** The whole-graph revision row. */
export const LEDGER_EVENT = "work/ledger";

/** The one-case revision row a `check` call appends (D48b):
 * `{case, digest, revision, parent_digest}`. */
export const LEDGER_CASE_EVENT = "work/ledger_case";

/** Where the plan tool's operator-facing mirror of the latest graph lives
 * (plugins/ledger-tools.ts, never read back): beside the session's event log,
 * in the session directory, so the host writes nothing into the developer's
 * repository. */
export const LEDGER_MIRROR_FILE = "ledger.json";

/** The mirror's path for the session whose event log is `logPath`. */
export function ledgerMirrorPath(logPath: string): string {
  return join(dirname(logPath), LEDGER_MIRROR_FILE);
}

/** Where earlier builds wrote the mirror, inside the workspace. Nothing
 * writes it any more; a workspace a session of such a build left it in still
 * carries it, so the base-tree prune and the verifier copy keep treating it as
 * the host's file and not the session's work. Workspace-relative and POSIX,
 * because the prune compares it against git's own listing
 * (work/ledger-base.ts). */
export const LEDGER_MIRROR_PATH = "work/ledger.json";

export interface LedgerTodo {
  id: string;
  title: string;
  class?: string;
  priority?: number;
  blocked_by?: readonly string[];
  statement?: string;
  consumes?: readonly { id: string; kind: string }[];
  produces?: readonly { id: string; kind: string }[];
  judgment?: string;
  plan?: string;
  /** Set by the model; the host never rewrites it, it only reports
   * disagreement in the terminal label. */
  status?: "open" | "done" | "dropped";
  /** Required when status is "dropped". */
  reason?: string;
}

export interface LedgerScenario {
  id: string;
  todo: string;
  given?: string;
  when?: string;
  then?: string;
}

/** One fixture or stdin text a `check` recorded (D48): its sha256 and byte
 * length always, the text itself inline when it is small; a larger text lives
 * in the session's scratch store under its digest (work/ledger-check.ts). */
export interface LedgerCheckText {
  digest: string;
  bytes: number;
  content?: string;
}

/** What a text should be: exactly equal (trailing newlines aside), contain
 * every listed substring, or match a regular expression. */
export interface LedgerTextExpectation {
  equals?: string;
  contains?: string[];
  matches?: string;
}

/** A `check` case's expectations (D48). A case that carries them is judged by
 * the host's expectation evaluation (work/ledger-check.ts) in every
 * observation — the check's own, the probe, the final and base passes and
 * the recheck — instead of the bare exit code. */
export interface LedgerCheckExpectation {
  exit?: number;
  stdout?: LedgerTextExpectation;
  stderr?: { contains?: string[] };
  /** Files the command should produce, workspace-relative. */
  files?: Record<string, { equals?: string; contains?: string[] }>;
}

/** A `property` case's invariant and how it is sampled (D58, design memo
 * §112): the principle in words, and the bounds of one observation's run —
 * the sample size, the seed a call's sample is drawn from, the time budget
 * and the counterexamples after which it stops. Its fixtures ride in the
 * case's `files`, recorded exactly as a check's. */
export interface LedgerProperty {
  principle: string;
  cases: number;
  seed: number;
  time_budget_ms: number;
  max_counterexamples: number;
}

export interface LedgerCase {
  id: string;
  scenario?: string;
  /** D48: the todo a `check` case belongs to, when it names one. */
  todo?: string;
  layer?: string;
  command: string;
  guard?: boolean;
  red_means?: string;
  green_means?: string;
  host?: string;
  dir?: string;
  depends_on?: readonly string[];
  timeout_ms?: number;
  done_when?: string;
  failed_when?: string;
  stall_after_ms?: number;
  /** D48 (`check`): the text on the command's stdin. */
  stdin?: LedgerCheckText;
  /** D48 (`check`): fixtures, relative path → text, written under
   * `<scratch>/checks/<case>/` (DOKKABI_CHECK_DIR) before every observation. */
  files?: Record<string, LedgerCheckText>;
  /** D48 (`check`): the expectations the case is judged by. */
  expect?: LedgerCheckExpectation;
  /** D58 (`property`): the invariant the case states over generated inputs;
   * every observation runs it through the property evaluator
   * (work/ledger-property.ts) instead of judging one run. */
  property?: LedgerProperty;
}

export interface LedgerGoal {
  id: string;
  statement: string;
}

export interface LedgerGraph {
  goal: LedgerGoal;
  todos: LedgerTodo[];
  scenarios: LedgerScenario[];
  cases: LedgerCase[];
}

/** One case a revision removes from the ledger explicitly (D52): its id and
 * why. A case `check` declared leaves the ledger only this way. */
export interface LedgerCaseDrop {
  id: string;
  reason: string;
}

/** What the model proposes. The goal is NOT an input: any `goal` field that
 * arrives anyway is ignored — the host owns `goal = {id:"goal",
 * statement:<operator order>}`. */
export interface LedgerProposal {
  goal?: unknown;
  todos: LedgerTodo[];
  scenarios?: LedgerScenario[];
  cases?: LedgerCase[];
  delta?: boolean;
  /** D52: recorded cases this revision removes, each with a reason. */
  drop_cases?: LedgerCaseDrop[];
}

/** One recorded `work/ledger` row. */
export interface LedgerRevision {
  graph: LedgerGraph;
  digest: string;
  revision: number;
  parent_digest: string | null;
}

/** The fields a `work/ledger` row may carry beside the revision (D52):
 * `drop_cases`, the cases a `plan` call removed explicitly, and `check_case`,
 * the id of the case a `check` call declared when it recorded a whole graph
 * (no revision to extend, or a new order). */
export interface LedgerRowExtras {
  drop_cases?: LedgerCaseDrop[];
  check_case?: string;
}

/** One recorded `work/ledger_case` row (D48b): the graph at this revision is
 * the previous revision's with `case` replacing every case of its id, or
 * appended when none has it — the delta merge a `check` call always made. */
export interface LedgerCaseRevision {
  case: LedgerCase;
  digest: string;
  revision: number;
  parent_digest: string;
}

export interface LedgerFinding {
  readonly check: "ids_unique" | "reference" | "cycle" | "command" | "dropped_reason" | "delta" | "property" | "check_fields" | "case" | "drop_cases";
  readonly node: string;
  readonly fact: string;
}

/** A recorded result: `graph` is what the row carries (the proposal, merged
 * by id when it is a delta, without the cases it drops); `projected` is the
 * graph the revision projects — `graph` plus the check cases it keeps (D52),
 * the same object as `graph` when it keeps none; `drop_cases` is present only
 * when the proposal dropped any. */
export type LedgerResult =
  | { readonly status: "findings"; readonly findings: LedgerFinding[] }
  | {
    readonly status: "recorded";
    readonly graph: LedgerGraph;
    readonly projected: LedgerGraph;
    readonly digest: string;
    readonly revision: number;
    readonly parent_digest: string | null;
    readonly open_todos: string[];
    readonly drop_cases?: LedgerCaseDrop[];
  };

/** Structural checks over a full (merged) graph. Pure, order-stable. */
export function ledgerFindings(graph: LedgerGraph): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const todoIds = new Set<string>();
  for (const item of graph.todos) {
    if (todoIds.has(item.id)) findings.push({ check: "ids_unique", node: item.id, fact: "duplicate todo id" });
    else todoIds.add(item.id);
  }
  const scenarioIds = new Set<string>();
  for (const item of graph.scenarios) {
    if (scenarioIds.has(item.id)) findings.push({ check: "ids_unique", node: item.id, fact: "duplicate scenario id" });
    else scenarioIds.add(item.id);
  }
  for (const item of graph.cases) {
    if (scenarioIds.has(item.id) || todoIds.has(item.id)) findings.push({ check: "ids_unique", node: item.id, fact: "duplicate case id" });
  }

  // References: blocked_by → todos, scenario.todo → todos, case.scenario → scenarios.
  for (const item of graph.todos) {
    for (const dep of item.blocked_by ?? []) {
      if (!todoIds.has(dep)) findings.push({ check: "reference", node: item.id, fact: `blocked_by ${dep} resolves to no todo` });
    }
    if (item.status === "dropped" && (typeof item.reason !== "string" || item.reason.length === 0)) {
      findings.push({ check: "dropped_reason", node: item.id, fact: "dropped todo requires a reason" });
    }
  }
  for (const item of graph.scenarios) {
    if (!todoIds.has(item.todo)) findings.push({ check: "reference", node: item.id, fact: `todo ${item.todo} resolves to no todo` });
  }
  for (const item of graph.cases) {
    if (item.scenario !== undefined && !scenarioIds.has(item.scenario)) {
      findings.push({ check: "reference", node: item.id, fact: `scenario ${item.scenario} resolves to no scenario` });
    }
    if (item.todo !== undefined && !todoIds.has(item.todo)) {
      findings.push({ check: "reference", node: item.id, fact: `todo ${item.todo} resolves to no todo` });
    }
    if (typeof item.command !== "string" || item.command.trim().length === 0) {
      findings.push({ check: "command", node: item.id, fact: "case command is empty" });
    }
  }

  // blocked_by cycles: DFS with the standard grey/black mark. Only edges
  // between existing todos count (dangling ones are reference findings).
  const CLOSED = 1;
  const OPEN = 2;
  const mark = new Map<string, number>();
  // First occurrence wins so a duplicate id cannot erase the original edges
  // before the cycle check sees them.
  const edges = new Map<string, readonly string[]>();
  for (const item of graph.todos) {
    if (!edges.has(item.id)) edges.set(item.id, (item.blocked_by ?? []).filter((dep) => todoIds.has(dep)));
  }
  const visit = (id: string, path: readonly string[]): void => {
    const state = mark.get(id);
    if (state === CLOSED) return;
    if (state === OPEN) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(" -> ");
      findings.push({ check: "cycle", node: id, fact: `blocked_by cycle: ${cycle}` });
      return;
    }
    mark.set(id, OPEN);
    for (const dep of edges.get(id) ?? []) visit(dep, [...path, id]);
    mark.set(id, CLOSED);
  };
  for (const item of graph.todos) visit(item.id, []);
  return findings;
}

/** Delta merge by id: nodes replace by id, new ids append, the goal is the
 * host's and never merged. */
export function mergeLedgerGraphs(base: LedgerGraph, delta: Pick<LedgerGraph, "todos" | "scenarios" | "cases">): LedgerGraph {
  const mergeById = <T extends { id: string }>(current: readonly T[], extra: readonly T[]): T[] => {
    const out = current.map((item) => extra.find((candidate) => candidate.id === item.id) ?? item);
    for (const candidate of extra) {
      if (!current.some((item) => item.id === candidate.id)) out.push(candidate);
    }
    return out;
  };
  return {
    goal: base.goal,
    todos: mergeById(base.todos, delta.todos),
    scenarios: mergeById(base.scenarios, delta.scenarios),
    cases: mergeById(base.cases, delta.cases),
  };
}

/** Ids of todos that are still open and not blocked by another open todo.
 * A done or dropped dependency does not block; a dropped todo is never open. */
export function openTodos(graph: LedgerGraph): string[] {
  const status = new Map(graph.todos.map((item) => [item.id, item.status ?? "open"]));
  const open = (id: string): boolean => status.get(id) === "open";
  return graph.todos
    .filter((item) => open(item.id))
    .filter((item) => !(item.blocked_by ?? []).some((dep) => status.has(dep) && open(dep)))
    .map((item) => item.id);
}

/** Ledger digest: the canonical graph bytes chained onto the parent digest,
 * so every revision names the whole history before it. A revision that drops
 * cases (D52) chains the drops' JSON text between the two, so the digest
 * names what it removed too; one without drops digests exactly as before. */
export function ledgerDigest(graph: LedgerGraph, parentDigest: string | null, drops: readonly LedgerCaseDrop[] = []): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(graph));
  if (drops.length > 0) hash.update(JSON.stringify(drops));
  hash.update(parentDigest ?? "");
  return hash.digest("hex");
}

/** A `work/ledger_case` row's digest (D48b): the same chaining over the one
 * case the row carries — its JSON text, then the parent digest — so a case
 * revision, too, names the whole history before it without re-reading the
 * graph. */
export function ledgerCaseDigest(item: LedgerCase, parentDigest: string): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(item));
  hash.update(parentDigest);
  return hash.digest("hex");
}

/** ledgerFindings of a graph that has none with `item` merged into it by id:
 * only the case can add a finding, and in the order the whole-graph pass
 * reports it (its id against todos and scenarios, then its references, then
 * its command). */
function caseFindings(item: LedgerCase, todoIds: ReadonlySet<string>, scenarioIds: ReadonlySet<string>): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  if (scenarioIds.has(item.id) || todoIds.has(item.id)) findings.push({ check: "ids_unique", node: item.id, fact: "duplicate case id" });
  if (item.scenario !== undefined && !scenarioIds.has(item.scenario)) {
    findings.push({ check: "reference", node: item.id, fact: `scenario ${item.scenario} resolves to no scenario` });
  }
  if (item.todo !== undefined && !todoIds.has(item.todo)) {
    findings.push({ check: "reference", node: item.id, fact: `todo ${item.todo} resolves to no todo` });
  }
  if (typeof item.command !== "string" || item.command.trim().length === 0) {
    findings.push({ check: "command", node: item.id, fact: "case command is empty" });
  }
  return findings;
}

/** The findings a proposal's drops raise (D52): each names a case the latest
 * revision projects, once, with a non-empty reason, and not one the same
 * proposal declares. */
function dropFindings(drops: readonly LedgerCaseDrop[], declared: readonly LedgerCase[], latest: LedgerRevision | undefined): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const recorded = new Set((latest?.graph.cases ?? []).map((item) => item.id));
  const declaredIds = new Set(declared.map((item) => item.id));
  const seen = new Set<string>();
  for (const item of drops) {
    const id = typeof item?.id === "string" ? item.id : "";
    if (id === "") {
      findings.push({ check: "reference", node: "?", fact: "a dropped case needs the id of a recorded case" });
      continue;
    }
    if (seen.has(id)) {
      findings.push({ check: "ids_unique", node: id, fact: "case dropped twice" });
      continue;
    }
    seen.add(id);
    if (typeof item.reason !== "string" || item.reason.trim().length === 0) {
      findings.push({ check: "dropped_reason", node: id, fact: "dropped case requires a reason" });
    }
    if (declaredIds.has(id)) findings.push({ check: "ids_unique", node: id, fact: "case is both declared and dropped" });
    else if (!recorded.has(id)) findings.push({ check: "reference", node: id, fact: `dropped case ${id} resolves to no recorded case` });
  }
  return findings;
}

/** D58b V5: only the tool that validates a case kind may create it. A
 * proposal case that carries a `property` field — whatever its value — is a
 * finding unless the `property` tool, which validated it, records it. */
export function propertyCaseFindings(cases: readonly unknown[]): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  for (const item of cases) {
    if (typeof item !== "object" || item === null || !Object.prototype.hasOwnProperty.call(item, "property")) continue;
    const id = (item as { readonly id?: unknown }).id;
    findings.push({
      check: "property",
      node: typeof id === "string" ? id : "?",
      fact: "a property case is declared only with the property tool, which validates its principle and its bounds; leave the property field out of plan (a property case stays in the ledger across plan calls until drop_cases drops it)",
    });
  }
  return findings;
}

/** The fields only the `check` tool records (D48): what it is fed and judged
 * by. */
export const CHECK_CASE_FIELDS: readonly string[] = Object.freeze(["stdin", "files", "expect"]);

/** D58c V5': only the tool that validates a case kind may create it — for
 * `check` too. A proposal case that carries any field the check tool
 * validates and records (`stdin`, `files`, `expect`), whatever its value, is a
 * finding unless the `check` tool, which validated it, records it: a plan
 * never carries an expectation the evaluator would read in a shape the tool
 * refuses, a fixture or stdin past the tool's bounds, or a text too large to
 * ride on a row. */
export function checkCaseFindings(cases: readonly unknown[]): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  for (const item of cases) {
    if (typeof item !== "object" || item === null) continue;
    const fields = CHECK_CASE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(item, field));
    if (fields.length === 0) continue;
    const id = (item as { readonly id?: unknown }).id;
    findings.push({
      check: "check_fields",
      node: typeof id === "string" ? id : "?",
      fact: `a case that carries ${fields.join(", ")} is declared only with the check tool, which validates its stdin, fixtures and expectations and their bounds; leave ${fields.length === 1 ? "that field" : "those fields"} out of plan (a check case stays in the ledger across plan calls until drop_cases drops it)`,
    });
  }
  return findings;
}

/** D58c V5': the shape every reader of a declared case relies on, re-checked
 * at the boundary that records it: a case is an object with a non-empty text
 * id, and — when it carries them — a text `dir`, a positive `timeout_ms` and a
 * boolean `guard`. Data, never thrown; the structural checks cover the rest
 * (ids unique, references, the command). */
export function caseShapeFindings(cases: readonly unknown[]): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  for (const item of cases) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      findings.push({ check: "case", node: "?", fact: "each case must be an object with an id and a command" });
      continue;
    }
    const record = item as Record<string, unknown>;
    const node = typeof record.id === "string" && record.id.trim().length > 0 ? record.id : "?";
    if (node === "?") findings.push({ check: "case", node, fact: "case id must be a non-empty string" });
    if (record.dir !== undefined && typeof record.dir !== "string") findings.push({ check: "case", node, fact: "dir, when given, must be a directory as text" });
    if (record.timeout_ms !== undefined && (typeof record.timeout_ms !== "number" || !Number.isFinite(record.timeout_ms) || record.timeout_ms <= 0)) {
      findings.push({ check: "case", node, fact: "timeout_ms, when given, must be a positive number" });
    }
    if (record.guard !== undefined && typeof record.guard !== "boolean") findings.push({ check: "case", node, fact: "guard, when given, must be true or false" });
  }
  return findings;
}

/** D58c V5': the shape every later reader of a proposal relies on — lists
 * where lists go; each todo and scenario an object with a non-empty text id,
 * a todo's `blocked_by` a list of ids, a scenario's `todo` an id; each case as
 * caseShapeFindings says — checked before anything reads it, so no proposal
 * can make a reader throw. Data, never thrown. */
export function proposalShapeFindings(proposal: Partial<Record<"todos" | "scenarios" | "cases" | "drop_cases", unknown>>): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const listOf = (field: "todos" | "scenarios" | "cases" | "drop_cases"): unknown[] => {
    const value = proposal[field];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      findings.push(field === "drop_cases"
        ? { check: "drop_cases", node: "root", fact: "drop_cases must be a list of {id, reason}" }
        : { check: field === "cases" ? "case" : "reference", node: "root", fact: `${field} must be a list` });
      return [];
    }
    return value;
  };
  const idOf = (item: unknown): string | undefined => {
    const id = typeof item === "object" && item !== null ? (item as { readonly id?: unknown }).id : undefined;
    return typeof id === "string" && id.trim().length > 0 ? id : undefined;
  };
  for (const item of listOf("todos")) {
    const id = idOf(item);
    if (typeof item !== "object" || item === null || Array.isArray(item) || id === undefined) {
      findings.push({ check: "reference", node: id ?? "?", fact: "each todo must be an object with a non-empty text id" });
      continue;
    }
    const blocked = (item as { readonly blocked_by?: unknown }).blocked_by;
    if (blocked !== undefined && !(Array.isArray(blocked) && blocked.every((dep) => typeof dep === "string"))) {
      findings.push({ check: "reference", node: id, fact: "blocked_by, when given, must be a list of todo ids" });
    }
  }
  for (const item of listOf("scenarios")) {
    const id = idOf(item);
    if (typeof item !== "object" || item === null || Array.isArray(item) || id === undefined) {
      findings.push({ check: "reference", node: id ?? "?", fact: "each scenario must be an object with a non-empty text id" });
      continue;
    }
    const todo = (item as { readonly todo?: unknown }).todo;
    if (todo !== undefined && typeof todo !== "string") findings.push({ check: "reference", node: id, fact: "a scenario's todo, when given, must be a todo id" });
  }
  findings.push(...caseShapeFindings(listOf("cases")));
  listOf("drop_cases");
  return findings;
}

/**
 * Check a proposal and, when it is clean, produce the next revision. Pure:
 * appending the `work/ledger` row is the caller's single side effect. The
 * goal is overwritten with the host-owned order whatever the proposal says.
 *
 * D52: the check cases the ledger keeps (`checks`, LedgerFold.checkCases)
 * stay in the revision's projected graph unless the proposal declares their
 * id (its declaration replaces them) or drops it, and the structural checks
 * judge that projected graph — a plan that removes a todo or scenario a kept
 * check names is a finding on that check, never a silent loss. Drops name a
 * case the latest revision projects, with a reason; a delta leaves them out
 * of the merged graph it carries.
 */
export function recordLedger(input: {
  readonly proposal: LedgerProposal;
  readonly order: string;
  readonly latest?: LedgerRevision;
  readonly checks?: readonly LedgerCase[];
  /** D58b V5, D58c V5': the proposal's cases were validated by the tool that
   * records their kind — `check` (stdin, fixtures, expectations) or
   * `property` (the property and its fixtures) — and may carry those fields.
   * Only those tools say so; a `plan` proposal never does. */
  readonly validatedCases?: boolean;
}): LedgerResult {
  const { proposal, order } = input;
  if (proposal.delta === true && !input.latest) {
    return { status: "findings", findings: [{ check: "delta", node: "goal", fact: "no recorded ledger to merge into" }] };
  }
  // V5': nothing below reads a proposal whose shape a reader cannot rely on.
  const shape = proposalShapeFindings(proposal as unknown as Partial<Record<"todos" | "scenarios" | "cases" | "drop_cases", unknown>>);
  if (shape.length > 0) return { status: "findings", findings: shape };
  const partial: Pick<LedgerGraph, "todos" | "scenarios" | "cases"> = {
    todos: [...(proposal.todos ?? [])],
    scenarios: [...(proposal.scenarios ?? [])],
    cases: [...(proposal.cases ?? [])],
  };
  const drops = [...(proposal.drop_cases ?? [])];
  const dropped = new Set(drops.map((item) => item?.id));
  const joined: LedgerGraph = {
    ...(proposal.delta === true && input.latest ? mergeLedgerGraphs(input.latest.graph, partial) : partial),
    goal: { id: "goal", statement: order },
  };
  const merged: LedgerGraph = dropped.size > 0 ? { ...joined, cases: joined.cases.filter((item) => !dropped.has(item.id)) } : joined;
  const declared = new Set(merged.cases.map((item) => item.id));
  const kept = (input.checks ?? []).filter((item) => !dropped.has(item.id) && !declared.has(item.id));
  const projected: LedgerGraph = kept.length > 0
    ? { goal: merged.goal, todos: merged.todos, scenarios: merged.scenarios, cases: [...merged.cases, ...kept] }
    : merged;
  const todoIds = new Set(merged.todos.map((item) => item.id));
  const scenarioIds = new Set(merged.scenarios.map((item) => item.id));
  const findings = [
    ...(input.validatedCases === true ? [] : [...propertyCaseFindings(partial.cases), ...checkCaseFindings(partial.cases)]),
    ...ledgerFindings(merged),
    ...kept.flatMap((item) => caseFindings(item, todoIds, scenarioIds).map((finding) => ({
      ...finding,
      fact: `${finding.fact}; case ${item.id} was recorded by check and stays in the ledger unless drop_cases drops it with a reason`,
    }))),
    ...dropFindings(drops, partial.cases, input.latest),
  ];
  if (findings.length > 0) return { status: "findings", findings };
  const parentDigest = input.latest?.digest ?? null;
  return {
    status: "recorded",
    graph: merged,
    projected,
    digest: ledgerDigest(merged, parentDigest, drops),
    revision: (input.latest?.revision ?? 0) + 1,
    parent_digest: parentDigest,
    open_todos: openTodos(merged),
    ...(drops.length > 0 ? { drop_cases: drops } : {}),
  };
}

/** What recording one `check` call's case appends (LedgerFold.recordCase):
 * a case row, a whole graph as recordLedger derives it (against `latest`),
 * or the findings that record nothing. */
export type LedgerCaseRecord =
  | { readonly status: "case"; readonly row: LedgerCaseRevision }
  | { readonly status: "graph"; readonly latest: LedgerRevision | undefined }
  | { readonly status: "findings"; readonly findings: LedgerFinding[] };

/**
 * The ledger as a fold over its rows (D48b). A `work/ledger` row sets the
 * whole graph; a `work/ledger_case` row replaces every case of its id in that
 * graph, or appends the case when none has it — the delta merge a `check`
 * call made when it still appended whole graphs — and takes the row's digest,
 * revision and parent as the head. A row the fold cannot read (a whole-graph
 * row without graph, digest or revision, as projectLedger always refused; a
 * case row without a case id, digest or revision, or with no readable graph
 * before it) leaves no ledger — and no check case to keep — until the next
 * whole-graph row. The fold owns a copy of the cases once a case row applies
 * or a whole graph keeps a check case, so no recorded payload is ever
 * changed; applying a case row touches that one case.
 *
 * D52: every case a `check` call declared — a case row's, or the one a
 * whole-graph row names in `check_case` — is kept, by id, in the order first
 * declared, as its latest declaration: a later case row, or a whole graph
 * that declares the id again, replaces it. A whole-graph row that does not
 * declare a kept id leaves it in the graph, after the row's own cases; a row
 * that drops the id (`drop_cases`) removes it and keeps the drop and its
 * reason until a later row declares the id again. A log with no case row, no
 * `check_case` and no `drop_cases` keeps nothing, so each whole-graph row
 * projects as recorded, as before.
 */
export class LedgerFold {
  private state: "none" | "unreadable" | "ok" = "none";
  private base: LedgerRevision | undefined;
  private head: { digest: string; revision: number; parent_digest: string | null } | undefined;
  /** The fold's own cases (after the first case row on `base`, or when
   * `base` keeps a check case it does not declare) and the positions of each
   * id among them. */
  private cases: LedgerCase[] | undefined;
  private positions: Map<string, number[]> | undefined;
  private ids: { readonly todos: ReadonlySet<string>; readonly scenarios: ReadonlySet<string> } | undefined;
  /** True when the current graph has no ledgerFindings; undefined until
   * asked after a whole graph is folded. */
  private clean: boolean | undefined;
  /** D52: the check cases kept, id → latest declaration, in the order first
   * declared. */
  private readonly checks = new Map<string, LedgerCase>();
  /** D52: the drops in force, id → reason, in the order dropped. */
  private readonly drops = new Map<string, string>();

  /** `casesFolded` counts the case entries the fold copied, indexed, applied
   * or checked — the work diagnostics read (ledger-live.ts). */
  constructor(readonly work: { casesFolded: number } = { casesFolded: 0 }) {}

  /** Fold one row; rows other than the two ledger rows change nothing. */
  push(event: EventRecord): void {
    if (event.name === LEDGER_EVENT) this.pushGraph(event.payload as Partial<LedgerRevision> & LedgerRowExtras);
    else if (event.name === LEDGER_CASE_EVENT) this.pushCase(event.payload as Partial<LedgerCaseRevision>);
  }

  /** True when a revision is readable (projectLedger(events) !== undefined). */
  get exists(): boolean {
    return this.state === "ok";
  }

  /** The latest revision: the whole-graph row's own objects when no case row
   * followed it and it keeps no check case it does not declare (D52), else a
   * graph `{goal, todos, scenarios, cases}` built from them — the key order
   * and content the delta merge gave it. */
  revision(): LedgerRevision | undefined {
    if (this.state !== "ok") return undefined;
    const base = this.base!;
    const head = this.head!;
    if (this.cases === undefined) return { graph: base.graph, digest: base.digest, revision: base.revision, parent_digest: base.parent_digest };
    return {
      graph: { goal: base.graph.goal, todos: [...base.graph.todos], scenarios: [...base.graph.scenarios], cases: [...this.cases] },
      digest: head.digest,
      revision: head.revision,
      parent_digest: head.parent_digest,
    };
  }

  /** True when the latest revision declares a case with this id. */
  hasCase(id: string): boolean {
    if (this.state !== "ok" || !this.wellFormed()) return false;
    return this.index().has(id);
  }

  /** The latest revision's case with this id (the first of it), or
   * undefined when it declares none (D58: `defect` names a property by id). */
  caseOf(id: string): LedgerCase | undefined {
    if (this.state !== "ok" || !this.wellFormed()) return undefined;
    const at = this.index().get(id)?.[0];
    return at === undefined ? undefined : (this.cases ?? this.base!.graph.cases)[at];
  }

  /** D52: the check cases the ledger keeps, each its latest declaration, in
   * the order first declared — what a `plan` revision keeps unless it
   * declares or drops them (recordLedger's `checks`). */
  checkCases(): LedgerCase[] {
    return this.state === "ok" ? [...this.checks.values()] : [];
  }

  /** D52: the cases dropped explicitly and not declared again since, with
   * the reason each drop gave, in the order dropped. */
  droppedCases(): LedgerCaseDrop[] {
    return this.state === "ok" ? [...this.drops].map(([id, reason]) => ({ id, reason })) : [];
  }

  /**
   * What one `check` call recording `item` under the current `order` appends
   * — the same graph the whole-graph revision it replaces derived. With no
   * readable revision, or a goal that is not the current order (a new order
   * since the latest revision), the call records a whole graph exactly as
   * before (`graph`, recordLedger against `latest`). Otherwise it is a case
   * row, judged by the same structural checks: when the current graph is
   * clean only the case can add a finding (checked alone); when it is not (a
   * graph an older rule set recorded) the merged graph is checked whole, as
   * before. Pure: nothing is folded until the row is.
   */
  recordCase(item: LedgerCase, order: string): LedgerCaseRecord {
    if (this.state !== "ok") return { status: "graph", latest: undefined };
    const graph = this.base!.graph;
    if (!this.wellFormed() || JSON.stringify(graph.goal) !== JSON.stringify({ id: "goal", statement: order })) {
      return { status: "graph", latest: this.revision() };
    }
    let findings: LedgerFinding[];
    if (this.isClean()) {
      const ids = this.idSets();
      findings = caseFindings(item, ids.todos, ids.scenarios);
      this.work.casesFolded += 1;
    } else {
      // The case of a `check` or `property` call, validated by its tool
      // (D58b V5: a property case is created only by the tool that
      // validated it).
      const merged = recordLedger({ proposal: { todos: [], cases: [item], delta: true }, order, latest: this.revision(), validatedCases: true });
      this.work.casesFolded += graph.cases.length + 1;
      findings = merged.status === "findings" ? merged.findings : [];
    }
    if (findings.length > 0) return { status: "findings", findings };
    const head = this.head!;
    return {
      status: "case",
      row: { case: item, digest: ledgerCaseDigest(item, head.digest), revision: head.revision + 1, parent_digest: head.digest },
    };
  }

  /** No readable ledger until the next whole graph, and nothing kept. */
  private unreadable(): void {
    this.state = "unreadable";
    this.base = undefined;
    this.head = undefined;
    this.cases = undefined;
    this.positions = undefined;
    this.ids = undefined;
    this.clean = undefined;
    this.checks.clear();
    this.drops.clear();
  }

  private pushGraph(payload: Partial<LedgerRevision> & LedgerRowExtras): void {
    this.cases = undefined;
    this.positions = undefined;
    this.ids = undefined;
    this.clean = undefined;
    if (payload.graph === undefined || typeof payload.digest !== "string" || typeof payload.revision !== "number") {
      this.unreadable();
      return;
    }
    this.state = "ok";
    this.base = {
      graph: payload.graph,
      digest: payload.digest,
      revision: payload.revision,
      parent_digest: typeof payload.parent_digest === "string" ? payload.parent_digest : null,
    };
    this.head = { digest: this.base.digest, revision: this.base.revision, parent_digest: this.base.parent_digest };
    this.keepChecks(payload);
  }

  /** D52: apply a whole-graph row's drops and declarations to the kept check
   * cases, then keep, after the row's own cases, every one it does not
   * declare. Nothing to do — the row projects as recorded — when nothing is
   * kept, dropped or named. */
  private keepChecks(payload: LedgerRowExtras): void {
    for (const drop of Array.isArray(payload.drop_cases) ? payload.drop_cases : []) {
      if (typeof drop?.id !== "string") continue;
      this.checks.delete(drop.id);
      this.drops.delete(drop.id);
      this.drops.set(drop.id, typeof drop.reason === "string" ? drop.reason : "");
    }
    const named = typeof payload.check_case === "string" ? payload.check_case : undefined;
    if ((this.checks.size === 0 && this.drops.size === 0 && named === undefined) || !this.wellFormed()) return;
    const cases = this.base!.graph.cases;
    const declared = new Set<string>();
    for (const item of cases) {
      if (typeof item?.id !== "string" || declared.has(item.id)) continue;
      declared.add(item.id);
      this.drops.delete(item.id);
      if (item.id === named || this.checks.has(item.id)) this.checks.set(item.id, item);
    }
    this.work.casesFolded += cases.length;
    const kept = [...this.checks.values()].filter((item) => !declared.has(item.id));
    if (kept.length === 0) return;
    this.cases = [...cases, ...kept];
    this.work.casesFolded += this.cases.length;
  }

  private pushCase(payload: Partial<LedgerCaseRevision>): void {
    const item = payload.case;
    if (this.state !== "ok" || !this.wellFormed() || item === null || typeof item !== "object" || typeof item.id !== "string"
      || typeof payload.digest !== "string" || typeof payload.revision !== "number") {
      this.unreadable();
      return;
    }
    const cases = this.own();
    const positions = this.index();
    const at = positions.get(item.id);
    if (at === undefined) {
      positions.set(item.id, [cases.length]);
      cases.push(item);
    } else {
      for (const index of at) cases[index] = item;
    }
    // D52: a case row is a check's declaration; it is kept across later
    // whole graphs and ends a drop of its id.
    this.checks.set(item.id, item);
    this.drops.delete(item.id);
    this.work.casesFolded += 1;
    if (this.clean === true) {
      const ids = this.idSets();
      this.clean = caseFindings(item, ids.todos, ids.scenarios).length === 0;
    } else {
      this.clean = undefined;
    }
    this.head = { digest: payload.digest, revision: payload.revision, parent_digest: typeof payload.parent_digest === "string" ? payload.parent_digest : null };
  }

  /** A whole graph a case row can be folded onto: a goal and three lists. */
  private wellFormed(): boolean {
    const graph = this.base?.graph as Partial<LedgerGraph> | undefined;
    return graph !== undefined && graph !== null && typeof graph.goal === "object" && graph.goal !== null
      && Array.isArray(graph.todos) && Array.isArray(graph.scenarios) && Array.isArray(graph.cases);
  }

  /** The fold's own copy of the base's cases (once per base, at the first
   * case row folded onto it). */
  private own(): LedgerCase[] {
    if (this.cases === undefined) {
      this.cases = [...this.base!.graph.cases];
      this.work.casesFolded += this.cases.length;
    }
    return this.cases;
  }

  /** Where each case id sits among the current cases (built once per base,
   * then kept current by pushCase). */
  private index(): Map<string, number[]> {
    if (this.positions === undefined) {
      const positions = new Map<string, number[]>();
      const cases = this.cases ?? this.base!.graph.cases;
      cases.forEach((entry, index) => {
        if (typeof entry?.id !== "string") return;
        const list = positions.get(entry.id);
        if (list === undefined) positions.set(entry.id, [index]);
        else list.push(index);
      });
      this.work.casesFolded += cases.length;
      this.positions = positions;
    }
    return this.positions;
  }

  private idSets(): { readonly todos: ReadonlySet<string>; readonly scenarios: ReadonlySet<string> } {
    if (this.ids === undefined) {
      const graph = this.base!.graph;
      this.ids = { todos: new Set(graph.todos.map((item) => item.id)), scenarios: new Set(graph.scenarios.map((item) => item.id)) };
    }
    return this.ids;
  }

  private isClean(): boolean {
    if (this.clean === undefined) {
      const current = this.revision()!;
      this.clean = ledgerFindings(current.graph).length === 0;
      this.work.casesFolded += current.graph.cases.length;
    }
    return this.clean;
  }
}

/** The cases of a revision every reader can rely on (D58c V5'): the objects
 * with a text id among its graph's cases; none when the graph holds no list
 * (a hand-written row). The fold keeps what a row carried; readers read
 * through this. */
export function revisionCases(revision: Pick<LedgerRevision, "graph"> | undefined): LedgerCase[] {
  const cases = (revision?.graph as { readonly cases?: unknown } | undefined)?.cases;
  if (!Array.isArray(cases)) return [];
  return cases.filter((item): item is LedgerCase =>
    typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as { readonly id?: unknown }).id === "string");
}

/** The todos and scenarios of a revision a reader can rely on (V5'): objects
 * with a text id; none when the graph holds no list. */
export function revisionTodos(revision: Pick<LedgerRevision, "graph"> | undefined): LedgerTodo[] {
  return objectsWithIds((revision?.graph as { readonly todos?: unknown } | undefined)?.todos) as LedgerTodo[];
}

export function revisionScenarios(revision: Pick<LedgerRevision, "graph"> | undefined): LedgerScenario[] {
  return objectsWithIds((revision?.graph as { readonly scenarios?: unknown } | undefined)?.scenarios) as LedgerScenario[];
}

function objectsWithIds(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as { readonly id?: unknown }).id === "string");
}

/** The ledger fold over every row of the log, from the first (D52: a check
 * case a later whole graph keeps can come from any earlier row) — the same
 * fold the running projection extends row by row (ledger-live.ts). */
export function foldLedger(events: readonly EventRecord[]): LedgerFold {
  const fold = new LedgerFold();
  for (const event of events) fold.push(event);
  return fold;
}

/** Rebuild the latest revision from the log alone — the projection replay
 * and the label (§4) both read only recorded rows. The latest `work/ledger`
 * row, with the `work/ledger_case` rows after it folded on (D48b) and the
 * check cases it keeps after its own (D52); a log with no case row, no
 * `check_case` and no `drop_cases` projects exactly as before: its latest
 * `work/ledger` row, as recorded. */
export function projectLedger(events: readonly EventRecord[]): LedgerRevision | undefined {
  return foldLedger(events).revision();
}

/** The operator order this ledger works on: the work/goal row opening the
 * current order scope, read the way plan-seal's operatorOrderStatement does
 * (evidence/authority.ts reads the same row). */
export function ledgerOrderStatement(events: readonly EventRecord[]): string | undefined {
  const scope = orderScope(events);
  if (scope === undefined) return undefined;
  const row = events.find((event) => event.seq === scope && event.name === "work/goal");
  return typeof row?.payload.statement === "string" ? row.payload.statement : undefined;
}
