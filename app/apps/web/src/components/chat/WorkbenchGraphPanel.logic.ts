import type {
  ProviderWorkbenchGraph,
  ProviderWorkbenchGraphResult,
  WorkbenchGraphEdgeKind,
  WorkbenchGraphNodeKind,
  WorkbenchGraphNodeStatus,
} from "@t3tools/contracts";
import type { EnvironmentQueryView } from "~/state/query";
import { workbenchGraphScopeKey, type WorkbenchGraphScope } from "~/state/workbenchGraph";

/**
 * Pure view-model for the R4 recorded graph panels
 * (docs/internals/dokkabi-graphs-r4.md). Semantics held here:
 * - A live query error OUTRANKS the value in `data`: the same scope's last
 *   valid graph stays rendered, labeled stale, until a fresh success lands.
 * - Retention is same-scope only (environment+thread+instance+graphType): a
 *   different scope NEVER observes its predecessor's graph, selection or
 *   camera, and a late old-scope response cannot overwrite a newer scope.
 * - The unsupported/unavailable capability results render explicit states;
 *   an explicitly opened panel never hides as if nothing happened.
 * - Positions are deterministic view preferences derived from the recorded
 *   relations; they are never execution instructions.
 */

export type WorkbenchGraphPanelState =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "view";
      readonly graph: ProviderWorkbenchGraph;
      readonly staleError: string | null;
    };

/** The latest retained graph view, keyed to the scope it belongs to. */
export interface RetainedWorkbenchGraph {
  /** Composite client-only scope key (environment+thread+instance+graphType). */
  readonly scopeKey: string;
  readonly graph: ProviderWorkbenchGraph;
}

const graphOf = (result: ProviderWorkbenchGraphResult | null): ProviderWorkbenchGraph | null =>
  result !== null && result.status === "available" && result.graph !== undefined
    ? result.graph
    : null;

/**
 * Independent source-head continuity between the retained view and a fresh
 * same-scope success. Graph reads intentionally never advance the transcript
 * cursors, but a poll may also never REWIND either independent head or
 * replace the session/generation: a response doing so is not rendered as a
 * fresh replacement — the last validated graph stays, labeled stale with an
 * explicit error. Returns null when continuity holds.
 */
export function graphHeadContinuityError(
  previous: Pick<ProviderWorkbenchGraph, "sessionCursor" | "gatewayCursor">,
  next: Pick<ProviderWorkbenchGraph, "sessionCursor" | "gatewayCursor">,
): string | null {
  if (next.sessionCursor.sessionId !== previous.sessionCursor.sessionId) {
    return `The recorded session source was replaced (session ${next.sessionCursor.sessionId.slice(0, 12)}…, expected ${previous.sessionCursor.sessionId.slice(0, 12)}…); keeping the last validated graph.`;
  }
  if (next.sessionCursor.generation !== previous.sessionCursor.generation) {
    return "The recorded session source was replaced (new generation); keeping the last validated graph.";
  }
  if (next.sessionCursor.seq < previous.sessionCursor.seq) {
    return `The session head rewound (seq ${next.sessionCursor.seq} after ${previous.sessionCursor.seq}); keeping the last validated graph.`;
  }
  if (
    next.sessionCursor.seq === previous.sessionCursor.seq &&
    next.sessionCursor.hash !== previous.sessionCursor.hash
  ) {
    return `The session head at seq ${previous.sessionCursor.seq} carries a different hash; keeping the last validated graph.`;
  }
  if (next.gatewayCursor.generation !== previous.gatewayCursor.generation) {
    return "The gateway's durable ledger was replaced; keeping the last validated graph.";
  }
  if (next.gatewayCursor.seq < previous.gatewayCursor.seq) {
    return `The gateway head rewound (seq ${next.gatewayCursor.seq} after ${previous.gatewayCursor.seq}); keeping the last validated graph.`;
  }
  if (
    next.gatewayCursor.seq === previous.gatewayCursor.seq &&
    next.gatewayCursor.hash !== previous.gatewayCursor.hash
  ) {
    return `The gateway head at seq ${previous.gatewayCursor.seq} carries a different hash; keeping the last validated graph.`;
  }
  return null;
}

/**
 * Resolve the panel's state from the keyed query plus the previously retained
 * view. The retained view is used only when its composite scope key is the
 * query's own; otherwise it is discarded before anything is decided — a moved
 * thread/instance keeps no old scope's graph. An unsubscribed (hidden) panel
 * renders its retained view without polling; a fresh success that breaks
 * independent head continuity is quarantined behind an explicit stale error.
 */
export function resolveWorkbenchGraphPanel(input: {
  readonly scopeKey: string;
  readonly query: Pick<
    EnvironmentQueryView<ProviderWorkbenchGraphResult>,
    "data" | "error" | "isPending"
  >;
  readonly retained: RetainedWorkbenchGraph | null;
  /** False while the panel is hidden/closed (atom unsubscribed, no polling). */
  readonly subscribed?: boolean;
}): WorkbenchGraphPanelState {
  const retained =
    input.retained !== null && input.retained.scopeKey === input.scopeKey ? input.retained : null;
  if (input.subscribed === false) {
    // Hidden/closed panel: the query atom is unsubscribed (polling stopped),
    // so the query view is empty — the retained view is the honest display.
    return retained !== null
      ? { kind: "view", graph: retained.graph, staleError: null }
      : { kind: "pending" };
  }
  // A live failure outranks the retained success inside `data`: same-scope
  // valid data stays visibly stale (idle failure or in-flight refresh), and
  // nothing is cleared until a fresh success lands.
  if (input.query.error !== null) {
    const stale = retained?.graph ?? graphOf(input.query.data);
    if (stale !== null) {
      return { kind: "view", graph: stale, staleError: input.query.error };
    }
    return { kind: "unavailable", reason: input.query.error };
  }
  if (input.query.data !== null) {
    const result = input.query.data;
    if (result.status === "unsupported") {
      return {
        kind: "unsupported",
        reason: result.reason ?? "This provider has no recorded graph capability.",
      };
    }
    if (result.status === "unavailable") {
      return {
        kind: "unavailable",
        reason: result.reason ?? "The recorded graph is not available right now.",
      };
    }
    const fresh = result.graph;
    if (fresh === undefined) {
      // The envelope says available but carries no graph: never trust the
      // label over the payload.
      return {
        kind: "unavailable",
        reason: "The source reported an available graph without a payload; refusing to render it.",
      };
    }
    if (retained !== null) {
      const continuity = graphHeadContinuityError(retained.graph, fresh);
      if (continuity !== null) {
        // Quarantine: the replacement never renders as fresh data and never
        // overwrites retention; the last validated graph carries the error.
        return { kind: "view", graph: retained.graph, staleError: continuity };
      }
    }
    return { kind: "view", graph: fresh, staleError: null };
  }
  return input.query.isPending ? { kind: "pending" } : { kind: "unavailable", reason: "" };
}

/** True when two scopes name the same environment+thread+instance+type view. */
export function sameWorkbenchGraphScope(
  left: WorkbenchGraphScope,
  right: WorkbenchGraphScope,
): boolean {
  return workbenchGraphScopeKey(left) === workbenchGraphScopeKey(right);
}

// --- Deterministic display vocabularies (closed; no invented states) ---

const NODE_KIND_LABELS: Record<WorkbenchGraphNodeKind, string> = {
  goal: "Goal",
  todo: "TODO",
  scenario: "Scenario",
  case: "Case",
  question: "Question",
  claim: "Claim",
  attempt: "Attempt",
  action: "Action",
  observation: "Observation",
  resource_version: "Resource version",
  lesson: "Lesson",
  context_frame: "Context frame",
  source_reference: "Source reference",
  unavailable_reference: "Unavailable reference",
};

/** Human-readable node kind label; closed vocabulary, no invented kinds. */
export function nodeKindLabel(kind: WorkbenchGraphNodeKind): string {
  return NODE_KIND_LABELS[kind];
}

const STATUS_TONES: Record<WorkbenchGraphNodeStatus, string> = {
  blocked: "text-muted-foreground",
  ready: "text-foreground",
  red: "text-destructive",
  green: "text-emerald-600 dark:text-emerald-400",
  clear: "text-muted-foreground",
  pending: "text-amber-600 dark:text-amber-400",
  completed: "text-muted-foreground",
  interrupted: "text-amber-600 dark:text-amber-400",
  open: "text-foreground",
  met: "text-emerald-600 dark:text-emerald-400",
  not_met: "text-destructive",
  inconclusive: "text-amber-600 dark:text-amber-400",
  proposed: "text-foreground",
  corroborated: "text-emerald-600 dark:text-emerald-400",
  contested: "text-amber-600 dark:text-amber-400",
  superseded: "text-muted-foreground",
  prepared: "text-foreground",
  appended: "text-muted-foreground",
  dispatched: "text-foreground",
  responded: "text-foreground",
};

/** Theme-token tone class per recorded status; never invents a verdict. */
export function nodeStatusTone(status: WorkbenchGraphNodeStatus): string {
  return STATUS_TONES[status];
}

export interface EdgeStyle {
  /** SVG stroke dash pattern; distinct per visually distinct relation. */
  readonly dash: string | null;
  /** Theme token stroke class. */
  readonly className: string;
}

const WORK_EDGE_STYLES: Record<"contains" | "blocked_by" | "flows", EdgeStyle> = {
  contains: { dash: null, className: "stroke-muted-foreground" },
  blocked_by: { dash: "6 4", className: "stroke-amber-500" },
  flows: { dash: "2 3", className: "stroke-primary" },
};

/** Context relations share one neutral directed style; the kind stays in the
 * legend/tooltip — the canonical relation itself is never relabeled. */
const CONTEXT_EDGE_STYLE: EdgeStyle = { dash: null, className: "stroke-accent-foreground/60" };

/** Visual style for one recorded relation kind (closed vocabulary). */
export function edgeStyleFor(kind: WorkbenchGraphEdgeKind): EdgeStyle {
  if (kind === "contains" || kind === "blocked_by" || kind === "flows") {
    return WORK_EDGE_STYLES[kind];
  }
  return CONTEXT_EDGE_STYLE;
}

/** Legend rows: the distinct relations actually present, in first-seen order. */
export function edgeLegend(kinds: readonly WorkbenchGraphEdgeKind[]): WorkbenchGraphEdgeKind[] {
  return [...new Set(kinds)];
}

/** Coverage line; omitted totals are always explicit, never silent. */
export function coverageLabel(coverage: {
  readonly status: string;
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly omittedNodes: number;
  readonly omittedEdges: number;
}): string {
  const omitted =
    coverage.omittedNodes > 0 || coverage.omittedEdges > 0
      ? ` · omitted ${coverage.omittedNodes} nodes, ${coverage.omittedEdges} edges`
      : "";
  return `Coverage ${coverage.status} · ${coverage.totalNodes} nodes, ${coverage.totalEdges} edges${omitted}`;
}
