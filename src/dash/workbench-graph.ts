/**
 * R4 recorded graph projection — the pure read behind workbench.graph
 * (docs/desktop-graphs-r4.md).
 *
 * Everything here folds ONE verified session prefix (the events the read
 * already validated). Read-only by construction: no model, no bind, no
 * abort, no tool, no context query, no append. Graph truth comes from the
 * canonical projectors only — `readPlanFromLog` + `viewPlan` +
 * `projectWorkGraph` + `scopeWorkEvents`/`currentCaseEvidence` for Work
 * (never a re-implementation of case verdicts from assistant prose, tool
 * exit codes or green words) and the pure `ContextGraphFold` for Context.
 * Rendering positions are view preferences computed elsewhere; nothing here
 * is an execution instruction.
 *
 * Honesty rules this module obeys:
 * - Missing source data is state "missing"; data that exists but cannot be
 *   interpreted is "invalid" with an explanation — never an empty success
 *   dressed as a complete graph.
 * - A case known in the current plan without an earned verdict is PENDING,
 *   never Unknown; goal and scenario stay null rather than inventing an
 *   aggregate verdict.
 * - Definition sources must belong to the CURRENT canonical plan scope;
 *   the latest row anywhere with a matching bare name is never a source,
 *   and neither is a row from an older goal.
 * - Canonical edges that target rows not emitted as semantic nodes become
 *   explicit source_reference display nodes; an endpoint that cannot
 *   resolve (for example the implicit goal:none attempt) becomes an
 *   unavailable_reference node with unresolved provenance, no invented
 *   evidence or status, and partial coverage. The relation is kept.
 * - Frame delivery proof is validated against the verified prefix BEFORE
 *   anything is displayed: sourceHead, surface, appended, dispatched and
 *   responded references must resolve exactly, and a frame's cited sources
 *   are its ACTUAL stage evidence, never only its preparation row. A
 *   forged in-range hash invalidates the whole graph.
 * - Hard limits (512 nodes / 1536 edges) refuse with "unavailable", the
 *   actual totals and empty arrays — never a silently truncated graph.
 * - Every emitted source reference — the FULL list, before any display
 *   bounding — is validated against the prefix exactly (seq AND hash); a
 *   violation invalidates the projection rather than shipping a dangling
 *   citation. When the display bounds a list, the omitted count is an
 *   explicit detail, never a silent slice.
 * - Edge ids are semantic (kind + endpoints + artifact), not array
 *   positions, so a node's identity survives refreshes.
 */

import { createHash } from "node:crypto";
import type { EventRecord } from "../host/schema.ts";
import { canonicalJson } from "../host/canonical.ts";
import { readPlanFromLog } from "../work/log.ts";
import { viewPlan } from "../work/view.ts";
import { planDigest } from "../work/digest.ts";
import { projectWorkGraph } from "../work/graph-projection.ts";
import { currentCaseEvidence, scopeWorkEvents, workCaseDigest } from "../work/scope.ts";
import {
  isWorkClass,
  type Case,
  type CaseStatus,
  type Scenario,
  type Todo,
  type TodoState,
} from "../work/schema.ts";
import { CONTEXT_GRAPH_ROWS } from "../context-graph/types.ts";
import { projectContextGraph, type ContextGraphFold, type ContextGraphNode } from "../context-graph/projector.ts";

export type WorkbenchGraphType = "work" | "context";

export const WORKBENCH_GRAPH_NODE_KINDS = [
  "goal",
  "todo",
  "scenario",
  "case",
  "question",
  "claim",
  "attempt",
  "action",
  "observation",
  "resource_version",
  "lesson",
  "context_frame",
  "source_reference",
  "unavailable_reference",
] as const;
export type WorkbenchGraphNodeKind = (typeof WORKBENCH_GRAPH_NODE_KINDS)[number];

export const WORKBENCH_GRAPH_NODE_STATUSES = [
  "blocked",
  "ready",
  "red",
  "green",
  "clear",
  "pending",
  "completed",
  "interrupted",
  "open",
  "met",
  "not_met",
  "inconclusive",
  "proposed",
  "corroborated",
  "contested",
  "superseded",
  "prepared",
  "appended",
  "dispatched",
  "responded",
] as const;
export type WorkbenchGraphNodeStatus = (typeof WORKBENCH_GRAPH_NODE_STATUSES)[number];

export type WorkbenchGraphState = "missing" | "available" | "invalid" | "unavailable";
export type WorkbenchGraphCoverageStatus = "complete" | "partial" | "unavailable";
export type WorkbenchGraphProvenance = "canonical" | "source_reference" | "unresolved";

/** Hard display bounds: an oversized graph is refused, never truncated. */
export const WORKBENCH_GRAPH_LIMITS = { nodes: 512, edges: 1_536 } as const;

/**
 * Display capacity selection for the recorded-graph projections. The default
 * ("v1") keeps the hard display bounds: an oversized graph is refused. An
 * explicit "explore" capacity suppresses ONLY that graph-size refusal so a
 * bounded explorer (workbench-graph-explorer.ts) can page the full canonical
 * graph; every citation is still validated first, node-source truncation with
 * its omission details and every other status behavior are unchanged.
 */
export interface WorkbenchGraphProjectionOptions {
  readonly displayCapacity?: "v1" | "explore";
}

const LABEL_MAX_CHARS = 160;
const DETAIL_VALUE_MAX_CHARS = 240;
/** Display bound for a node's cited sources; omissions are an explicit detail. */
const NODE_SOURCES_MAX = 8;

export interface WorkbenchGraphSourceRef {
  readonly seq: number;
  readonly hash: string;
}

export interface WorkbenchGraphDetailEntry {
  readonly name: string;
  readonly value: string;
}

export interface WorkbenchGraphNode {
  readonly id: string;
  readonly kind: WorkbenchGraphNodeKind;
  readonly label: string;
  readonly status: WorkbenchGraphNodeStatus | null;
  readonly provenance: WorkbenchGraphProvenance;
  readonly sources: readonly WorkbenchGraphSourceRef[];
  readonly details: readonly WorkbenchGraphDetailEntry[];
  /** SHA-256 of the canonical node body, retained for citation; null for synthesized nodes with no body. */
  readonly bodyDigest: string | null;
}

export interface WorkbenchGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** contains / blocked_by / flows for Work; canonical ContextRelation values for Context. */
  readonly kind: string;
  /** `flows` only: the artifact traveling this edge; null otherwise. */
  readonly artifact: string | null;
  readonly sources: readonly WorkbenchGraphSourceRef[];
}

export interface WorkbenchGraphCoverage {
  readonly status: WorkbenchGraphCoverageStatus;
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly omittedNodes: number;
  readonly omittedEdges: number;
}

export interface WorkbenchGraph {
  readonly state: WorkbenchGraphState;
  /** shadow / on / unknown — absence never proves off. Null when not applicable (Work). */
  readonly mode: "shadow" | "on" | "unknown" | null;
  /** Nullable source revision (Context) — context accounting can change without the graph revision moving. */
  readonly revision: number | null;
  /** Nullable SHA-256 canonical projection digest (Context) or work-plan digest (Work). */
  readonly digest: string | null;
  readonly nodes: readonly WorkbenchGraphNode[];
  readonly edges: readonly WorkbenchGraphEdge[];
  /** Canonical work layout hints (compound node ids); empty for Context. Never an execution schedule. */
  readonly waves: readonly (readonly string[])[];
  readonly unscheduled: readonly string[];
  readonly coverage: WorkbenchGraphCoverage;
  readonly errors: readonly string[];
}

// --- shared helpers ---

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ref(event: EventRecord): WorkbenchGraphSourceRef {
  return { seq: event.seq, hash: event.hash };
}

function refOf(source: { seq: number; hash: string }): WorkbenchGraphSourceRef {
  return { seq: source.seq, hash: source.hash };
}

/** A bounded display excerpt, explicitly marked when shortened. */
function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function detail(name: string, value: unknown): WorkbenchGraphDetailEntry | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : canonicalJson(value as unknown);
  if (text.length === 0) return undefined;
  return { name, value: excerpt(text, DETAIL_VALUE_MAX_CHARS) };
}

function detailsOf(entries: ReadonlyArray<WorkbenchGraphDetailEntry | undefined>): WorkbenchGraphDetailEntry[] {
  return entries.filter((entry): entry is WorkbenchGraphDetailEntry => entry !== undefined);
}

function emptyCoverage(): WorkbenchGraphCoverage {
  return { status: "complete", totalNodes: 0, totalEdges: 0, omittedNodes: 0, omittedEdges: 0 };
}

function missingGraph(): WorkbenchGraph {
  return {
    state: "missing",
    mode: null,
    revision: null,
    digest: null,
    nodes: [],
    edges: [],
    waves: [],
    unscheduled: [],
    coverage: emptyCoverage(),
    errors: [],
  };
}

function invalidGraph(
  errors: readonly string[],
  keep: Partial<Pick<WorkbenchGraph, "mode" | "revision" | "digest">> = {},
): WorkbenchGraph {
  return {
    state: "invalid",
    mode: keep.mode ?? null,
    revision: keep.revision ?? null,
    digest: keep.digest ?? null,
    nodes: [],
    edges: [],
    waves: [],
    unscheduled: [],
    coverage: emptyCoverage(),
    errors,
  };
}

/** A ref resolves exactly when the prefix holds that seq with that hash. */
function refResolves(source: WorkbenchGraphSourceRef, events: readonly EventRecord[]): boolean {
  const record = events[source.seq - 1];
  return record !== undefined && record.seq === source.seq && record.hash === source.hash;
}

/** Stable semantic edge identity: the SHA-256 of the canonical edge tuple
 * (kind + endpoints + artifact), never an array position, so an edge keeps
 * its id when unrelated rows refresh — and never a delimiter concatenation,
 * which node ids containing the delimiter could make ambiguous. */
function semanticEdgeId(kind: string, from: string, to: string, artifact: string | null): string {
  return sha256(canonicalJson({ artifact, from, kind, to }));
}

/**
 * The shared finalization, in a fixed order:
 * 1. Validate EVERY original source reference — the full lists, before any
 *    display bounding — exactly (seq AND hash) against the prefix. A single
 *    dangling citation invalidates the whole projection. This runs before
 *    any capacity decision.
 * 2. Refuse oversized graphs with "unavailable", the ACTUAL totals and
 *    empty arrays — never a silent truncation. Suppressed ONLY for an
 *    explicit "explore" display capacity, where the bounded explorer pages
 *    the full canonical graph instead of refusing it.
 * 3. Bound node source lists for display, stamping the omitted count as an
 *    explicit detail so proof is never silently sliced away.
 */
function finalize(
  graph: WorkbenchGraph,
  events: readonly EventRecord[],
  options?: WorkbenchGraphProjectionOptions,
): WorkbenchGraph {
  for (const node of graph.nodes) {
    for (const source of node.sources) {
      if (!refResolves(source, events)) {
        return invalidGraph(
          [...graph.errors, `node ${node.id} cites a source (seq ${source.seq}) that does not resolve in the verified prefix`],
          { mode: graph.mode, revision: graph.revision, digest: graph.digest },
        );
      }
    }
  }
  for (const edge of graph.edges) {
    for (const source of edge.sources) {
      if (!refResolves(source, events)) {
        return invalidGraph(
          [...graph.errors, `edge ${edge.id} cites a source (seq ${source.seq}) that does not resolve in the verified prefix`],
          { mode: graph.mode, revision: graph.revision, digest: graph.digest },
        );
      }
    }
  }
  const totalNodes = graph.nodes.length;
  const totalEdges = graph.edges.length;
  if (
    options?.displayCapacity !== "explore"
    && (totalNodes > WORKBENCH_GRAPH_LIMITS.nodes || totalEdges > WORKBENCH_GRAPH_LIMITS.edges)
  ) {
    return {
      ...graph,
      state: "unavailable",
      nodes: [],
      edges: [],
      waves: [],
      unscheduled: [],
      coverage: {
        status: "unavailable",
        totalNodes,
        totalEdges,
        omittedNodes: totalNodes,
        omittedEdges: totalEdges,
      },
      errors: [
        ...graph.errors,
        `the recorded graph exceeds the display limits (${totalNodes} nodes, limit ${WORKBENCH_GRAPH_LIMITS.nodes}; `
          + `${totalEdges} edges, limit ${WORKBENCH_GRAPH_LIMITS.edges}) — no graph is rendered`,
      ],
    };
  }
  const nodes = graph.nodes.map((node) => {
    if (node.sources.length <= NODE_SOURCES_MAX) return node;
    return {
      ...node,
      sources: node.sources.slice(0, NODE_SOURCES_MAX),
      details: [
        ...node.details,
        { name: "sources_omitted", value: String(node.sources.length - NODE_SOURCES_MAX) },
      ],
    };
  });
  return { ...graph, nodes };
}

// --- Work projection ---

function lastEventNamed(events: readonly EventRecord[], name: string): EventRecord | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === name) return events[i];
  }
  return undefined;
}

/**
 * Ports are compared only when the canonical plan item carries them: the
 * non-authority reader drops optional ports, so their absence on the plan
 * side must not disqualify the row the reader itself accepted.
 */
function portsMatch(payload: unknown, plan: readonly { id: string; kind: string }[] | undefined): boolean {
  if (plan === undefined) return true;
  return canonicalJson(payload) === canonicalJson(plan);
}

/**
 * The definition row of a plan item: the LAST row inside the current
 * canonical scope whose content equals the item the canonical reader
 * accepted — matching the optional ports/judgment/plan/profile fields too.
 * A later row that merely reuses the bare id (a redefinition under a newer,
 * unaccepted scope) is never a definition source, and neither is a row from
 * an older goal: content AND scope decide, not the name.
 */
function todoDefinitionRef(scope: readonly EventRecord[], todo: Todo): WorkbenchGraphSourceRef | undefined {
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const event = scope[i];
    if (event === undefined || event.name !== "work/todo" || event.payload.id !== todo.id) continue;
    const payload = event.payload;
    if (
      String(payload.title ?? payload.id) === todo.title
      && (isWorkClass(String(payload.class)) ? payload.class : "host") === todo.class
      && (typeof payload.priority === "number" ? payload.priority : 100) === todo.priority
      && canonicalJson(Array.isArray(payload.blocked_by) ? payload.blocked_by.map(String) : []) === canonicalJson(todo.blocked_by ?? [])
      && String(payload.statement ?? "") === todo.statement
      && payload.judgment === todo.judgment
      && payload.plan === todo.plan
      && payload.profile === todo.profile
      && portsMatch(payload.consumes, todo.consumes)
      && portsMatch(payload.produces, todo.produces)
    ) {
      return ref(event);
    }
  }
  return undefined;
}

function scenarioDefinitionRef(scope: readonly EventRecord[], scenario: Scenario): WorkbenchGraphSourceRef | undefined {
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const event = scope[i];
    if (event === undefined || event.name !== "work/scenario" || event.payload.id !== scenario.id) continue;
    const payload = event.payload;
    if (
      String(payload.todo ?? "") === scenario.todo
      && String(payload.given ?? "") === scenario.given
      && String(payload.when ?? "") === scenario.when
      && String(payload.then ?? "") === scenario.then
    ) {
      return ref(event);
    }
  }
  return undefined;
}

function caseRowMatchesDefinition(payload: Record<string, unknown>, item: Case, scenario: Scenario | undefined): boolean {
  if (String(payload.scenario ?? "") !== item.scenario) return false;
  if (String(payload.layer ?? "") !== item.layer) return false;
  if (String(payload.command ?? "") !== item.command) return false;
  if (String(payload.red_means ?? "") !== item.red_means) return false;
  if (String(payload.green_means ?? "") !== item.green_means) return false;
  if (payload.guard === true && item.guard !== true) return false;
  if (typeof payload.case_digest === "string") {
    return payload.case_digest === workCaseDigest(item, scenario);
  }
  return true;
}

function caseDefinitionRef(scope: readonly EventRecord[], item: Case, scenario: Scenario | undefined): WorkbenchGraphSourceRef | undefined {
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const event = scope[i];
    if (event === undefined || event.name !== "work/case" || event.payload.id !== item.id) continue;
    if (event.payload.status === "red" || event.payload.status === "green") continue;
    if (typeof event.payload.scenario !== "string") continue;
    if (caseRowMatchesDefinition(event.payload, item, scenario)) return ref(event);
  }
  return undefined;
}

/**
 * The recorded run that decided this case's current status, through the
 * canonical revision-aware selector over the CANONICALLY SCOPED events —
 * the same scopeWorkEvents slice viewPlan itself judges on. A same-named
 * case under an older goal is not current proof.
 */
function caseDecidingRunRef(
  scopedEvents: readonly EventRecord[],
  item: Case,
  scenario: Scenario | undefined,
  status: CaseStatus | undefined,
): WorkbenchGraphSourceRef | undefined {
  if (status === undefined) return undefined;
  const runs = currentCaseEvidence(item, scenario, scopedEvents);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run !== undefined && run.payload.status === status) return ref(run);
  }
  return undefined;
}

function portsDetail(name: string, ports: readonly { id: string; kind: string }[] | undefined): WorkbenchGraphDetailEntry | undefined {
  if (ports === undefined || ports.length === 0) return undefined;
  return detail(name, ports.map((port) => `${port.id}:${port.kind}`).join(", "));
}

/**
 * Work graph from the canonical plan projectors. Work is a DAG: cycles are
 * invalid (viewPlan errors), not repaired into a suggested order. Ready and
 * red are recorded TODO states, never claims that execution is running.
 * A case known in the plan without an earned verdict is PENDING; goal and
 * scenario carry null rather than an invented aggregate verdict; assistant
 * prose has no status authority.
 */
export function projectWorkGraphView(
  events: readonly EventRecord[],
  options?: WorkbenchGraphProjectionOptions,
): WorkbenchGraph {
  const goalEvent = lastEventNamed(events, "work/goal");
  if (goalEvent === undefined) return missingGraph();
  const goalDigest =
    typeof goalEvent.payload.digest === "string" && goalEvent.payload.digest !== "pending"
      ? goalEvent.payload.digest
      : null;
  const refuse = (errors: readonly string[]): WorkbenchGraph =>
    invalidGraph(errors, { digest: goalDigest });
  if (goalEvent.payload.digest === "pending") {
    return refuse([
      "the recorded goal is awaiting its sealed plan (digest is pending) — no plan has been sealed for this goal",
    ]);
  }
  const plan = readPlanFromLog(events);
  if (plan === undefined) {
    return refuse([
      "the recorded work/goal cannot be reconstructed into a plan: malformed or unsupported work records (readPlanFromLog refused)",
    ]);
  }
  if (
    typeof goalEvent.payload.id !== "string"
    || typeof goalEvent.payload.statement !== "string"
    || plan.goal.id !== goalEvent.payload.id
    || plan.goal.statement !== goalEvent.payload.statement
  ) {
    return refuse([
      "the reconstructed plan does not belong to the latest recorded work/goal — an older plan cannot be drawn under the current goal",
    ]);
  }
  let view: ReturnType<typeof viewPlan>;
  try {
    view = viewPlan(plan, events);
  } catch (error) {
    return refuse([`the recorded plan could not be projected: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (view.errors.length > 0) {
    return refuse(view.errors);
  }
  // The canonical scope: definitions and evidence belong to the active
  // sealed goal and plan (scopeWorkEvents); when no binding scopes the log,
  // the reader's own slice (from the latest goal row) is the authority.
  const scopedEvents = scopeWorkEvents(plan, events);
  const definitionScope =
    scopedEvents.length > 0 ? scopedEvents : events.filter((event) => event.seq >= goalEvent.seq);
  const graph = projectWorkGraph(plan);
  const scenarioById = new Map(plan.scenarios.map((scenario) => [scenario.id, scenario]));
  const todoDef = new Map<string, WorkbenchGraphSourceRef>();
  const scenarioDef = new Map<string, WorkbenchGraphSourceRef>();
  const caseDef = new Map<string, WorkbenchGraphSourceRef>();
  const definitionErrors: string[] = [];
  for (const todo of plan.todos) {
    const found = todoDefinitionRef(definitionScope, todo);
    if (found !== undefined) todoDef.set(todo.id, found);
    else definitionErrors.push(`todo ${todo.id}: no definition row in the canonical scope matches the current plan — its source is not claimed`);
  }
  for (const scenario of plan.scenarios) {
    const found = scenarioDefinitionRef(definitionScope, scenario);
    if (found !== undefined) scenarioDef.set(scenario.id, found);
    else definitionErrors.push(`scenario ${scenario.id}: no definition row in the canonical scope matches the current plan — its source is not claimed`);
  }
  for (const item of plan.cases) {
    const found = caseDefinitionRef(definitionScope, item, scenarioById.get(item.scenario));
    if (found !== undefined) caseDef.set(item.id, found);
    else definitionErrors.push(`case ${item.id}: no definition row in the canonical scope matches the current plan — its source is not claimed`);
  }
  const nodes: WorkbenchGraphNode[] = [];
  for (const node of graph.nodes) {
    const sources: WorkbenchGraphSourceRef[] = [];
    let details: WorkbenchGraphDetailEntry[] = [];
    let status: WorkbenchGraphNodeStatus | null = null;
    if (node.kind === "goal") {
      sources.push(ref(goalEvent));
      details = detailsOf([
        detail("statement", plan.goal.statement),
        detail("digest", goalDigest ?? planDigest(plan)),
      ]);
    } else if (node.kind === "todo") {
      const todo = plan.todos.find((item) => item.id === node.id);
      if (todo !== undefined) {
        status = (view.todoState[todo.id] ?? "blocked") satisfies TodoState;
        const definition = todoDef.get(todo.id);
        if (definition !== undefined) sources.push(definition);
        details = detailsOf([
          detail("statement", todo.statement),
          detail("class", todo.class),
          detail("priority", todo.priority),
          detail("judgment", todo.judgment),
          detail("plan", todo.plan),
          detail("profile", todo.profile),
          portsDetail("consumes", todo.consumes),
          portsDetail("produces", todo.produces),
        ]);
      }
    } else if (node.kind === "scenario") {
      const scenario = scenarioById.get(node.id);
      if (scenario !== undefined) {
        const definition = scenarioDef.get(scenario.id);
        if (definition !== undefined) sources.push(definition);
        details = detailsOf([
          detail("given", scenario.given),
          detail("when", scenario.when),
          detail("then", scenario.then),
          detail("todo", scenario.todo),
        ]);
      }
    } else if (node.kind === "case") {
      const item = plan.cases.find((candidate) => candidate.id === node.id);
      if (item !== undefined) {
        const scenario = scenarioById.get(item.scenario);
        // A case known in the current plan without an earned verdict is
        // pending — an explicit state, never "unknown".
        status = view.caseStatus[item.id] ?? "pending";
        const definition = caseDef.get(item.id);
        if (definition !== undefined) sources.push(definition);
        const deciding = caseDecidingRunRef(scopedEvents, item, scenario, view.caseStatus[item.id]);
        if (deciding !== undefined) sources.push(deciding);
        details = detailsOf([
          detail("scenario", item.scenario),
          detail("command", item.command),
          detail("layer", item.layer),
          detail("red_means", item.red_means),
          detail("green_means", item.green_means),
          detail("guard", item.guard === true ? "true" : undefined),
        ]);
      }
    }
    nodes.push({
      id: node.node,
      kind: node.kind,
      label: excerpt(node.label, LABEL_MAX_CHARS),
      status,
      provenance: "canonical",
      sources,
      details,
      bodyDigest: null,
    });
  }
  // Edges carry the definition row that DECLARES the relationship, so a
  // dependency or artifact flow can be inspected at its source: containment
  // cites the contained item's definition (and the goal's own binding row
  // for goal→todo), blocked_by the dependent todo's definition, flows the
  // consumer's definition (its consumes names the artifact).
  const goalRef = ref(goalEvent);
  const refList = (source: WorkbenchGraphSourceRef | undefined): WorkbenchGraphSourceRef[] =>
    source === undefined ? [] : [source];
  const edges: WorkbenchGraphEdge[] = graph.edges.map((edge) => {
    let sources: WorkbenchGraphSourceRef[] = [];
    if (edge.kind === "contains" && edge.from === `goal:${plan.goal.id}`) {
      sources = [goalRef, ...refList(todoDef.get(edge.to.slice("todo:".length) ?? ""))];
    } else if (edge.kind === "contains") {
      const from = edge.from;
      if (from.startsWith("todo:")) sources = refList(scenarioDef.get(edge.to.slice("scenario:".length) ?? ""));
      else sources = refList(caseDef.get(edge.to.slice("case:".length) ?? ""));
    } else if (edge.kind === "blocked_by") {
      sources = refList(todoDef.get(edge.to.slice("todo:".length) ?? ""));
    } else if (edge.kind === "flows") {
      sources = refList(todoDef.get(edge.to.slice("todo:".length) ?? ""));
    }
    return {
      id: semanticEdgeId(edge.kind, edge.from, edge.to, edge.kind === "flows" ? (edge.artifact ?? null) : null),
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      artifact: edge.kind === "flows" ? (edge.artifact ?? null) : null,
      sources,
    };
  });
  return finalize(
    {
      state: "available",
      mode: null,
      revision: null,
      digest: goalDigest ?? planDigest(plan),
      nodes,
      edges,
      waves: graph.waves.map((wave) => wave.map((id) => `todo:${id}`)),
      unscheduled: graph.unscheduled.map((id) => `todo:${id}`),
      coverage: {
        status: "complete",
        totalNodes: nodes.length,
        totalEdges: edges.length,
        omittedNodes: 0,
        omittedEdges: 0,
      },
      errors: definitionErrors,
    },
    events,
    options,
  );
}

// --- Context projection ---

const FRAME_STAGE_TO_STATUS: Record<string, WorkbenchGraphNodeStatus> = {
  prepared: "prepared",
  surfaced: "prepared",
  shadow: "prepared",
  appended: "appended",
  dispatched: "dispatched",
  responded: "responded",
};

/**
 * Frame delivery proof, validated against the verified prefix BEFORE any of
 * it is displayed: the frame's own row, its sourceHead, its surface, and
 * every appended/dispatched/responded reference must resolve exactly. The
 * fold itself does not re-check dispatched/responded request rows, so a
 * forged in-range hash must be caught here — and it invalidates the whole
 * graph rather than becoming a delivery claim.
 */
function frameRefIntegrityErrors(fold: ContextGraphFold, events: readonly EventRecord[]): string[] {
  const errors: string[] = [];
  const check = (frame: string, source: { seq: number; hash: string }, what: string): void => {
    if (!refResolves(source, events)) {
      errors.push(`frame ${frame} cites ${what} (seq ${source.seq}) that does not resolve in the verified prefix — its delivery cannot be claimed`);
    }
  };
  for (const [id, frame] of fold.frames) {
    check(id, frame.ref, "its own row");
    check(id, frame.row.frame.sourceHead, "its source head");
    if (frame.surface !== undefined) check(id, frame.surface.ref, "its surface row");
    if (frame.appended !== undefined) check(id, frame.appended, "the transcript row that appended it");
    frame.dispatched.forEach((request, index) => check(id, request, `dispatched request ${index + 1}`));
    frame.responded.forEach((request, index) => check(id, request, `responded request ${index + 1}`));
  }
  return errors;
}

/** Host assessment rows are the only status evidence for corroborated or
 * contested lessons; their refs are validated like every other proof. */
function assessmentRefIntegrityErrors(fold: ContextGraphFold, events: readonly EventRecord[]): string[] {
  const errors: string[] = [];
  for (const [id, state] of fold.lessons) {
    for (const entry of state.assessments) {
      if (!refResolves(entry.ref, events)) {
        errors.push(`lesson ${id} cites a host assessment (seq ${entry.ref.seq}) that does not resolve in the verified prefix`);
      }
    }
  }
  return errors;
}

function contextNodeStatus(fold: ContextGraphFold, node: ContextGraphNode): WorkbenchGraphNodeStatus | null {
  if (node.kind === "attempt") {
    const outcome = node.body.outcome;
    return typeof outcome === "string" && (WORKBENCH_GRAPH_NODE_STATUSES as readonly string[]).includes(outcome)
      ? (outcome as WorkbenchGraphNodeStatus)
      : null;
  }
  if (node.kind === "lesson") {
    // R8-03: an imported parent lesson has NO local epistemic status — its
    // source label (even corroborated) is history, never a local state. The
    // current applicability lives in the details, from the recorded fit.
    if (fold.importedLessons.has(node.id)) return null;
    const parsed = /^(.+)#r([0-9]+)$/u.exec(node.id);
    if (parsed === null) return null;
    return fold.epistemic(parsed[1]!, Number.parseInt(parsed[2]!, 10));
  }
  if (node.kind === "context_frame") {
    const stage = fold.frameStage(node.id);
    return stage === undefined ? null : (FRAME_STAGE_TO_STATUS[stage] ?? null);
  }
  if (node.kind === "action") {
    const invocation = fold.invocations.get(node.id);
    return invocation === undefined ? null : invocation.status;
  }
  return null;
}

function contextNodeLabel(node: ContextGraphNode, fold: ContextGraphFold): string {
  switch (node.kind) {
    case "claim": {
      const repository = typeof node.body.repository === "string" ? node.body.repository : "";
      return excerpt(`repository ${repository}`.trim(), LABEL_MAX_CHARS);
    }
    case "action": {
      const tool = typeof node.body.tool === "string" ? node.body.tool : "";
      const invocation = fold.invocations.get(node.id);
      const hint = invocation?.argHint ?? "";
      return excerpt(`${tool} ${hint}`.trim(), LABEL_MAX_CHARS);
    }
    case "resource_version": {
      const kind = typeof node.body.kind === "string" ? node.body.kind : "";
      const digest = typeof node.body.digest === "string" ? node.body.digest.slice(0, 12) : "";
      const image = typeof node.body.image === "string" ? node.body.image.slice(0, 12) : "";
      const head = digest !== "" ? digest : image;
      return excerpt(`${kind} ${head}`.trim() + (head !== "" ? "…" : ""), LABEL_MAX_CHARS);
    }
    case "lesson": {
      // R8-03: an imported parent lesson is labelled from its AUTHENTICATED
      // candidate statement (the fold re-derived it from the retained
      // bundle), not from an opaque namespaced id.
      const imported = fold.importedLessons.get(node.id);
      if (imported !== undefined) {
        return excerpt(imported.candidate.statement.length > 0 ? imported.candidate.statement : node.id, LABEL_MAX_CHARS);
      }
      const statement = typeof node.body.statement === "string" ? node.body.statement : "";
      return excerpt(statement.length > 0 ? statement : node.id, LABEL_MAX_CHARS);
    }
    default:
      return node.id;
  }
}

function contextNodeDetails(node: ContextGraphNode, fold: ContextGraphFold): WorkbenchGraphDetailEntry[] {
  switch (node.kind) {
    case "goal":
      return detailsOf([
        detail("statement_digest", typeof node.body.statement_digest === "string" ? node.body.statement_digest : undefined),
        detail("opened_by", node.body.source),
      ]);
    case "claim":
      return detailsOf([detail("repository", node.body.repository), detail("scope_source", node.body.source)]);
    case "attempt": {
      if (fold.attempts.has(node.id)) {
        const attempt = fold.attempts.get(node.id)!.attempt;
        return detailsOf([
          detail("question", attempt.question),
          detail("goal", attempt.goalId),
          detail("intent_origin", attempt.intentOrigin),
          detail("outcome_authority", attempt.outcomeAuthority),
          detail("previous_attempt", attempt.previousAttempt),
          detail("changed_approach", attempt.changedApproach),
        ]);
      }
      return detailsOf([
        detail("goal", node.body.goal),
        detail("intent_origin", node.body.intent_origin),
        detail("outcome_authority", node.body.outcome_authority),
        detail("implicit", "true"),
      ]);
    }
    case "question":
      return detailsOf([detail("text_digest", node.body.text_digest)]);
    case "action": {
      const invocation = fold.invocations.get(node.id);
      return detailsOf([
        detail("tool", node.body.tool),
        detail("call_id", node.body.call_id),
        detail("args_digest", node.body.args_digest),
        ...(invocation === undefined
          ? []
          : [
            detail("mechanical", invocation.mechanical),
            detail("exit_code", invocation.exitCode),
            detail("result_availability", invocation.resultAvailability),
          ]),
      ]);
    }
    case "observation":
      return detailsOf([
        detail("invocation", node.body.invocation),
        detail("mechanical", node.body.mechanical),
        detail("availability", node.body.availability),
        detail("observed_rows", node.body.rows),
      ]);
    case "resource_version":
      return detailsOf([
        detail("kind", node.body.kind),
        detail("digest", node.body.digest),
        detail("coverage", node.body.coverage),
        detail("image", node.body.image),
      ]);
    case "lesson": {
      // R8-03: an imported parent lesson shows its bounded HISTORICAL
      // provenance — the foreign source session/event/lesson/revision and
      // the source's own epistemic label — and the child's CURRENT fit
      // separately. Nothing here claims local corroboration.
      const imported = fold.importedLessons.get(node.id);
      if (imported !== undefined) {
        const candidate = imported.candidate;
        return detailsOf([
          detail("statement", candidate.statement),
          detail("origin", "imported_model_statement (historical model claim, foreign provenance)"),
          detail("source_session", candidate.source.session),
          detail("source_lesson", candidate.source.lesson),
          detail("source_revision", candidate.source.revision),
          detail("source_event_seq", candidate.source.event.seq),
          detail("source_epistemic", `${candidate.epistemic} (historical; never reassessed in this session)`),
          detail("scope_repository", candidate.scope.repository),
          detail("scope_goal", candidate.scope.goal),
          detail("dependency_coverage", candidate.scope.dependency_coverage),
          detail("scope_condition", candidate.scope.condition_text),
          detail("retry_conditions", candidate.retry_conditions),
          detail("invalidation_conditions", candidate.invalidation_conditions),
          detail(
            "fit",
            imported.fit === undefined
              ? "none recorded yet (applicability unknown)"
              : `${imported.fit.row.verdict} (${imported.fit.row.reason}); goal statement ${imported.fit.row.goal.statement_match}; files ${imported.fit.row.files
                .map((file) => `${file.path}:${file.verdict}`)
                .join(", ")}`,
          ),
        ]);
      }
      const parsed = /^(.+)#r([0-9]+)$/u.exec(node.id);
      const lessonId = parsed?.[1];
      const revision = parsed === null ? undefined : Number.parseInt(parsed[2]!, 10);
      const state = lessonId === undefined ? undefined : fold.lessons.get(lessonId);
      const lesson =
        state === undefined
          ? undefined
          : state.revisions.find((candidate) => candidate.lesson.revision === revision)?.lesson;
      if (lesson === undefined) return detailsOf([detail("statement", node.body.statement)]);
      // Scope, retry and invalidation conditions belong to the view;
      // corroboration is evidence for the observable, not a causal guarantee.
      return detailsOf([
        detail("statement", lesson.statement),
        detail("revision", lesson.revision),
        detail("scope_repository", lesson.scope.repositoryId),
        detail("scope_goal", lesson.scope.goalId),
        detail("dependency_coverage", lesson.scope.dependencyCoverage),
        detail("scope_condition", lesson.scope.conditionText),
        detail("retry_conditions", lesson.retryConditions),
        detail("invalidation_conditions", lesson.invalidationConditions),
        detail("observable_case", lesson.observable?.caseId ?? null),
        detail("observable_command_digest", lesson.observable?.commandDigest ?? null),
        detail("attempts", lesson.attemptIds),
      ]);
    }
    case "context_frame": {
      const frame = fold.frames.get(node.id);
      if (frame === undefined) return detailsOf([detail("goal", node.body.goal), detail("mode", node.body.mode)]);
      if (frame.row.schema !== "context-graph-v1") {
        return detailsOf([
          detail("kind", "recorded contribution; not graph selection or earned authority"),
          detail("contributor_schema", frame.row.contribution.schema),
          detail("boundary", frame.row.boundary),
          detail("body_bytes", frame.row.blob_bytes),
        ]);
      }
      // Selected/omitted items and reasons are the frame's own recorded
      // accounting; presented_to edges are never fabricated from them.
      return detailsOf([
        detail("goal", frame.row.frame.goalId),
        detail("boundary", frame.row.boundary),
        detail("coverage", frame.row.frame.coverage),
        detail("selected", frame.row.frame.selected.map((item) => item.nodeId)),
        detail("selected_reasons", frame.row.frame.selected.map((item) => `${item.nodeId}: ${item.reason}`)),
        detail("omitted", frame.row.frame.omitted.map((item) => `${item.group} x${item.count} (${item.reason})`)),
        detail("body_bytes", frame.row.frame.body.bytes),
        detail("budget_bytes", frame.row.frame.budget.maxBytes),
        detail("recovery", frame.row.recovery),
      ]);
    }
    default:
      return [];
  }
}

/**
 * A node's recorded citations. The context_frame's sources are its ACTUAL
 * stage evidence — the responded/dispatched/appended/surface row that
 * proves where delivery got to — followed by the frame's own row; a
 * lesson's sources are its revision row plus every host assessment behind
 * its current epistemic state, so status evidence can be inspected.
 */
/** A typed {seq,hash} ref stored in a canonical node body, when it is one. */
function bodyRefOf(value: unknown): { seq: number; hash: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ref = value as { seq?: unknown; hash?: unknown };
  return typeof ref.seq === "number" && typeof ref.hash === "string" ? { seq: ref.seq, hash: ref.hash } : undefined;
}

function contextNodeSources(fold: ContextGraphFold, node: ContextGraphNode): WorkbenchGraphSourceRef[] {
  if (node.kind === "goal" || node.kind === "claim") {
    const bodyRef = bodyRefOf(node.body.ref);
    return bodyRef === undefined ? [] : [refOf(bodyRef)];
  }
  if (node.kind === "action") {
    const bodyRef = bodyRefOf(node.body.call);
    return bodyRef === undefined ? [] : [refOf(bodyRef)];
  }
  if (node.kind === "observation") {
    const at = bodyRefOf(node.body.at);
    if (at !== undefined) return [refOf(at)];
    const parsed = /^obs:([0-9]+)$/u.exec(node.id);
    if (parsed !== null) {
      const fact = fold.facts.get(Number.parseInt(parsed[1]!, 10));
      if (fact !== undefined) return [{ seq: fact.seq, hash: fact.hash }];
    }
    return [];
  }
  if (node.kind === "resource_version") {
    const parsed = /^tree:([0-9]+)$/u.exec(node.id);
    if (parsed !== null) {
      const fact = fold.facts.get(Number.parseInt(parsed[1]!, 10));
      if (fact !== undefined) return [{ seq: fact.seq, hash: fact.hash }];
    }
    return [];
  }
  if (node.kind === "attempt") {
    const state = fold.attempts.get(node.id);
    return state === undefined ? [] : [refOf(state.ref)];
  }
  if (node.kind === "lesson") {
    // R8-03: an imported parent lesson's sources are its CHILD-side
    // citations only — the import row and, when one is recorded, the current
    // fit row. The parent session's rows are foreign references and never
    // appear as local refs.
    const imported = fold.importedLessons.get(node.id);
    if (imported !== undefined) {
      return [
        refOf(imported.importRef),
        ...(imported.fit === undefined ? [] : [refOf(imported.fit.ref)]),
      ];
    }
    const parsed = /^(.+)#r([0-9]+)$/u.exec(node.id);
    if (parsed === null) return [];
    const state = fold.lessons.get(parsed[1]!);
    const revision = state?.revisions.find((candidate) => candidate.lesson.revision === Number.parseInt(parsed[2]!, 10));
    if (revision === undefined) return [];
    // Keep the evidence that explains the canonical state before older
    // assessments when the display is bounded. Later support does not erase
    // a contradiction: epistemic() remains the status authority.
    const assessments = state!.assessments.filter(
      (entry) => entry.assessment.revision === revision.lesson.revision,
    );
    const epistemic = fold.epistemic(parsed[1]!, revision.lesson.revision);
    const stance = epistemic === "contested" ? "contradicts" : "supports";
    const decisive = [...assessments].reverse().find(
      (entry) => entry.assessment.stance === stance,
    );
    const newest = state!.supersededBy === undefined
      ? state!.revisions.at(-1)
      : fold.lessons.get(state!.supersededBy.lesson)?.revisions.find(
        (entry) => entry.lesson.revision === state!.supersededBy!.revision,
      );
    const superseding = epistemic === "superseded" && newest !== undefined
      ? [refOf(newest.ref)] : [];
    return [
      refOf(revision.ref),
      ...superseding,
      ...(decisive === undefined ? [] : [refOf(decisive.ref)]),
      ...[...assessments].reverse().filter((entry) => entry !== decisive)
        .map((entry) => refOf(entry.ref)),
    ];
  }
  if (node.kind === "context_frame") {
    const frame = fold.frames.get(node.id);
    if (frame === undefined) return [];
    const stage = fold.frameStage(node.id);
    const proof =
      stage === "responded"
        ? frame.responded.at(-1)
        : stage === "dispatched"
          ? frame.dispatched.at(-1)
          : stage === "appended"
            ? frame.appended
            : stage === "surfaced"
              ? frame.surface?.ref
              : undefined;
    // Surfaced and shadow preparation is displayed prepared, never
    // dispatched; the proof row is the farthest delivery evidence recorded.
    return proof === undefined ? [refOf(frame.ref)] : [refOf(proof), refOf(frame.ref)];
  }
  return [];
}

/**
 * Context graph from the pure fold. Cycles are real recorded relations and
 * remain untouched (SCC condensation is a LAYOUT decision made by the view,
 * never here). Ordinary recorded actions create nodes even without a scope
 * row — the mode then reads unknown, because absence never proves off.
 * `retained` is the owner-side reader of retained branch source bundles
 * (R8-03): a session that carries branch-context rows refuses to project
 * without one.
 */
export function projectContextGraphView(
  events: readonly EventRecord[],
  retained?: (digest: string) => string | undefined,
  options?: WorkbenchGraphProjectionOptions,
): WorkbenchGraph {
  const hasGraphRows = events.some((event) => CONTEXT_GRAPH_ROWS.has(event.name));
  let fold: ContextGraphFold;
  try {
    fold = projectContextGraph(events, retained);
  } catch (error) {
    return invalidGraph([
      `the recorded context-graph rows cannot be folded: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (!hasGraphRows && fold.nodes.size === 0) {
    return missingGraph();
  }
  // Delivery and assessment proof is validated BEFORE anything is bounded
  // or displayed: a forged in-range hash never becomes a stage claim.
  const integrityErrors = [...frameRefIntegrityErrors(fold, events), ...assessmentRefIntegrityErrors(fold, events)];
  if (integrityErrors.length > 0) {
    return invalidGraph(integrityErrors, { mode: fold.scopeMode ?? "unknown", revision: fold.revision, digest: fold.digest });
  }
  const nodes = new Map<string, WorkbenchGraphNode>();
  for (const node of fold.nodes.values()) {
    nodes.set(node.id, {
      id: node.id,
      kind: node.kind,
      label: contextNodeLabel(node, fold),
      status: contextNodeStatus(fold, node),
      provenance: "canonical",
      sources: contextNodeSources(fold, node),
      details: contextNodeDetails(node, fold),
      bodyDigest: sha256(canonicalJson(node.body)),
    });
  }
  // Resource versions minted from receipts carry no ref of their own; the
  // first incoming edge's evidence grounds them in the prefix.
  for (const edge of fold.edges.values()) {
    const target = nodes.get(edge.to);
    if (target !== undefined && target.sources.length === 0 && edge.evidence.length > 0) {
      nodes.set(target.id, { ...target, sources: [refOf(edge.evidence[0]!)] });
    }
  }
  const edges: WorkbenchGraphEdge[] = [];
  const errors: string[] = [];
  let unavailableEndpoints = 0;
  for (const edge of fold.edges.values()) {
    for (const endpoint of [edge.from, edge.to]) {
      if (nodes.has(endpoint)) continue;
      const row = /^row:([0-9]+)$/u.exec(endpoint);
      const fact = row === null ? undefined : fold.facts.get(Number.parseInt(row[1]!, 10));
      if (fact !== undefined) {
        // A canonical edge citing a row that is not a semantic node: an
        // explicit source_reference display node, never a dropped relation.
        nodes.set(endpoint, {
          id: endpoint,
          kind: "source_reference",
          label: excerpt(`row ${fact.seq} · ${fact.name}`, LABEL_MAX_CHARS),
          status: null,
          provenance: "source_reference",
          sources: [{ seq: fact.seq, hash: fact.hash }],
          details: detailsOf([
            detail("row", fact.name),
            detail("authority", fact.authority),
            detail("availability", fact.availability),
          ]),
          bodyDigest: null,
        });
        continue;
      }
      unavailableEndpoints += 1;
      nodes.set(endpoint, {
        id: endpoint,
        kind: "unavailable_reference",
        label: excerpt(endpoint, LABEL_MAX_CHARS),
        status: null,
        provenance: "unresolved",
        sources: [],
        details: detailsOf([detail("endpoint", endpoint), detail("unavailable", "this canonical endpoint does not resolve to a recorded node")]),
        bodyDigest: null,
      });
      errors.push(
        `canonical endpoint ${endpoint} does not resolve in the verified prefix — shown as an unavailable reference, never as knowledge`,
      );
    }
    edges.push({
      id: semanticEdgeId(edge.relation, edge.from, edge.to, null),
      from: edge.from,
      to: edge.to,
      kind: edge.relation,
      artifact: null,
      sources: edge.evidence.map(refOf),
    });
  }
  const nodeList = [...nodes.values()];
  return finalize(
    {
      state: "available",
      mode: fold.scopeMode ?? "unknown",
      revision: fold.revision,
      digest: fold.digest,
      nodes: nodeList,
      edges,
      waves: [],
      unscheduled: [],
      coverage: {
        // Nothing is dropped: partial means an endpoint is explicitly
        // unavailable, which the display marks rather than omits.
        status: unavailableEndpoints > 0 ? "partial" : "complete",
        totalNodes: nodeList.length,
        totalEdges: edges.length,
        omittedNodes: 0,
        omittedEdges: 0,
      },
      errors,
    },
    events,
    options,
  );
}
