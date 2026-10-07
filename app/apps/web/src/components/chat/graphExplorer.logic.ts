/**
 * Pure navigation and view-model of the bounded Work/Context graph explorer.
 *
 * - One view is one bounded page (at most 100 nodes / 1536 edges) of the
 *   server's full canonical display projection. Page, literal search and
 *   one-hop neighbors are the only queries; the renderer never asks for the
 *   whole graph.
 * - The first fresh page adopts its snapshot as the pin; every later
 *   navigation carries it. A stale answer — or a fresh answer naming another
 *   snapshot — never shows new nodes: the last displayed page stays with an
 *   explicit banner until the operator refreshes, which drops the pin.
 * - Back history holds at most GRAPH_EXPLORE_HISTORY_MAX queries; it is view
 *   state only and resets with the scope.
 * - Neighbors pages always include their anchor; their offsets count
 *   candidate neighbors only (the anchor is never repeated in the offset).
 */
import {
  WORKBENCH_GRAPH_EXPLORE_DEFAULT_LIMIT,
  WORKBENCH_GRAPH_EXPLORE_MAX_EDGES,
  WORKBENCH_GRAPH_EXPLORE_MAX_NODES,
  WORKBENCH_GRAPH_SEARCH_MAX_LENGTH,
  type ProviderWorkbenchGraph,
  type ProviderWorkbenchGraphExplore,
  type ProviderWorkbenchGraphExploreResult,
  type WorkbenchGraphExploreQuery,
  type WorkbenchGraphExploreSnapshot,
} from "@t3tools/contracts";

import type { EnvironmentQueryView } from "~/state/query";
import { graphHeadContinuityError } from "./WorkbenchGraphPanel.logic";

export const GRAPH_EXPLORE_HISTORY_MAX = 32;

export interface GraphExploreNav {
  /** The current normalized query. */
  readonly query: WorkbenchGraphExploreQuery;
  /** The snapshot the current request carries (null: unpinned request). */
  readonly snapshot: WorkbenchGraphExploreSnapshot | null;
  /** The adopted snapshot pin; null until the first fresh page. */
  readonly pin: WorkbenchGraphExploreSnapshot | null;
  /** Earlier queries for Back (bounded, oldest first). */
  readonly history: readonly WorkbenchGraphExploreQuery[];
}

export function initialGraphExploreNav(): GraphExploreNav {
  return {
    query: { mode: "page", offset: 0, limit: WORKBENCH_GRAPH_EXPLORE_DEFAULT_LIMIT },
    snapshot: null,
    pin: null,
    history: [],
  };
}

export function sameGraphSnapshot(
  left: WorkbenchGraphExploreSnapshot | null,
  right: WorkbenchGraphExploreSnapshot | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.digest === right.digest &&
    left.sessionCursor.sessionId === right.sessionCursor.sessionId &&
    left.sessionCursor.seq === right.sessionCursor.seq &&
    left.sessionCursor.hash === right.sessionCursor.hash &&
    left.sessionCursor.generation === right.sessionCursor.generation
  );
}

export function sameGraphQuery(
  left: WorkbenchGraphExploreQuery,
  right: WorkbenchGraphExploreQuery,
): boolean {
  return (
    left.mode === right.mode &&
    left.offset === right.offset &&
    left.limit === right.limit &&
    left.nodeId === right.nodeId &&
    left.search === right.search
  );
}

/** Move to a new query under the current pin, remembering the old one. */
export function navigateGraphExplore(
  nav: GraphExploreNav,
  query: WorkbenchGraphExploreQuery,
): GraphExploreNav {
  if (sameGraphQuery(nav.query, query)) return nav;
  const history = [...nav.history, nav.query].slice(-GRAPH_EXPLORE_HISTORY_MAX);
  return { ...nav, query, snapshot: nav.pin, history };
}

export function backGraphExplore(nav: GraphExploreNav): GraphExploreNav {
  const previous = nav.history.at(-1);
  if (previous === undefined) return nav;
  return { ...nav, query: previous, snapshot: nav.pin, history: nav.history.slice(0, -1) };
}

/** Explicit refresh: drop the pin; the next fresh page adopts a new one. */
export function refreshGraphExplore(nav: GraphExploreNav): GraphExploreNav {
  return { ...nav, snapshot: null, pin: null };
}

/** Adopt the first fresh page's snapshot as the pin. */
export function adoptGraphExplorePin(
  nav: GraphExploreNav,
  snapshot: WorkbenchGraphExploreSnapshot,
): GraphExploreNav {
  return nav.pin === null ? { ...nav, pin: snapshot } : nav;
}

/** Candidate capacity of one page: neighbors pages reserve the anchor slot. */
export function graphPageCapacity(query: WorkbenchGraphExploreQuery): number {
  return query.mode === "neighbors" ? Math.max(1, query.limit - 1) : query.limit;
}

export function pageQuery(offset = 0): WorkbenchGraphExploreQuery {
  return { mode: "page", offset, limit: WORKBENCH_GRAPH_EXPLORE_DEFAULT_LIMIT };
}

export function searchQuery(search: string): WorkbenchGraphExploreQuery | null {
  if (search.length === 0 || search.length > WORKBENCH_GRAPH_SEARCH_MAX_LENGTH) return null;
  return { mode: "search", offset: 0, limit: WORKBENCH_GRAPH_EXPLORE_DEFAULT_LIMIT, search };
}

export function neighborsQuery(nodeId: string): WorkbenchGraphExploreQuery {
  return { mode: "neighbors", offset: 0, limit: WORKBENCH_GRAPH_EXPLORE_DEFAULT_LIMIT, nodeId };
}

export function withGraphOffset(
  query: WorkbenchGraphExploreQuery,
  offset: number,
): WorkbenchGraphExploreQuery {
  return { ...query, offset: Math.max(0, offset) };
}

export type GraphExplorePanelState =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      /** The source changed since the pin and no page was displayed yet. */
      readonly kind: "stale-empty";
      readonly explore: ProviderWorkbenchGraphExplore;
    }
  | {
      readonly kind: "view";
      /** The displayed page (fresh, or the retained one while navigating/stale). */
      readonly explore: ProviderWorkbenchGraphExplore;
      readonly staleError: string | null;
      /** The pinned snapshot no longer describes the current projection. */
      readonly snapshotStale: boolean;
      /** The displayed page belongs to an earlier query still loading. */
      readonly navigating: boolean;
    };

/** The last displayed fresh page of this panel scope. */
export interface RetainedGraphExplore {
  readonly scopeKey: string;
  readonly requestKey: string;
  readonly explore: ProviderWorkbenchGraphExplore;
}

/** Local integrity of one fresh page against its request; null when exact. */
export function graphExploreIntegrityError(
  explore: ProviderWorkbenchGraphExplore,
  query: WorkbenchGraphExploreQuery,
  graphType: "work" | "context",
): string | null {
  if (explore.graphType !== graphType) return "The page answers another graph type.";
  if (!sameGraphQuery(explore.query, query)) return "The page answers a different query.";
  const { nodes, edges } = explore.graph;
  if (nodes.length > Math.min(query.limit, WORKBENCH_GRAPH_EXPLORE_MAX_NODES)) {
    return `The page displays ${nodes.length} nodes beyond its bound.`;
  }
  if (edges.length > WORKBENCH_GRAPH_EXPLORE_MAX_EDGES) {
    return `The page displays ${edges.length} edges beyond its bound.`;
  }
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) return "The page repeats a node.";
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      return "An edge names an endpoint that is not displayed.";
    }
  }
  if (query.mode === "neighbors" && nodes.length > 0 && !ids.has(query.nodeId ?? "")) {
    return "A neighbors page must include its anchor.";
  }
  return null;
}

/**
 * Resolve the panel state from the current request's query view, the pin
 * and the last displayed page of this scope. Stale answers never replace
 * the displayed nodes.
 */
export function resolveGraphExplorePanel(input: {
  readonly scopeKey: string;
  readonly requestKey: string;
  readonly graphType: "work" | "context";
  readonly nav: GraphExploreNav;
  readonly query: Pick<
    EnvironmentQueryView<ProviderWorkbenchGraphExploreResult>,
    "data" | "error" | "isPending"
  >;
  readonly retained: RetainedGraphExplore | null;
  readonly subscribed: boolean;
}): GraphExplorePanelState {
  const retained =
    input.retained !== null && input.retained.scopeKey === input.scopeKey ? input.retained : null;
  const shownRetained = (staleError: string | null, snapshotStale: boolean) =>
    retained === null
      ? null
      : ({
          kind: "view",
          explore: retained.explore,
          staleError,
          snapshotStale,
          navigating: retained.requestKey !== input.requestKey,
        } as const);
  if (!input.subscribed) {
    return shownRetained(null, false) ?? { kind: "pending" };
  }
  if (input.query.error !== null) {
    return (
      shownRetained(input.query.error, false) ?? {
        kind: "unavailable",
        reason: input.query.error,
      }
    );
  }
  const result = input.query.data;
  if (result === null) {
    return (
      shownRetained(null, false) ??
      (input.query.isPending ? { kind: "pending" } : { kind: "unavailable", reason: "" })
    );
  }
  if (result.status === "unsupported") {
    return {
      kind: "unsupported",
      reason:
        result.reason ??
        "This gateway does not offer bounded graph exploration; the recorded graph is unsupported here.",
    };
  }
  if (result.status === "unavailable") {
    return {
      kind: "unavailable",
      reason: result.reason ?? "The recorded graph is not available right now.",
    };
  }
  const explore = result.explore;
  if (explore === undefined) {
    return {
      kind: "unavailable",
      reason:
        "The source reported an available graph page without a payload; refusing to render it.",
    };
  }
  const changed =
    explore.state === "stale" ||
    (input.nav.pin !== null && !sameGraphSnapshot(explore.snapshot, input.nav.pin));
  if (changed) {
    return shownRetained(null, true) ?? { kind: "stale-empty", explore };
  }
  const integrity = graphExploreIntegrityError(explore, input.nav.query, input.graphType);
  if (integrity !== null) {
    return shownRetained(integrity, false) ?? { kind: "unavailable", reason: integrity };
  }
  if (retained !== null) {
    const continuity = graphHeadContinuityError(retained.explore, explore);
    if (continuity !== null) return shownRetained(continuity, false)!;
  }
  return { kind: "view", explore, staleError: null, snapshotStale: false, navigating: false };
}

/** The existing graph-panel shape for the shared canvas, legend and inspector. */
export function graphViewOfExplore(explore: ProviderWorkbenchGraphExplore): ProviderWorkbenchGraph {
  return {
    version: 1,
    graphType: explore.graphType,
    sessionCursor: explore.sessionCursor,
    gatewayCursor: explore.gatewayCursor,
    resnapshot: false,
    graph: explore.graph,
  };
}

/** Explicit displayed / matched / total / omitted line; never silent. */
export function graphExploreSummary(explore: ProviderWorkbenchGraphExplore): string {
  const { query, graph, matchedNodes } = explore;
  const shown = graph.nodes.length;
  const coverage = graph.coverage;
  let range: string;
  if (query.mode === "neighbors") {
    const anchorShown = shown > 0 ? 1 : 0;
    const candidates = shown - anchorShown;
    const pool = Math.max(0, matchedNodes - 1);
    range =
      candidates > 0
        ? `Neighbors ${query.offset + 1}–${query.offset + candidates} of ${pool} + anchor · ${matchedNodes} matched`
        : `0 of ${pool} neighbors${anchorShown ? " + anchor" : ""} · ${matchedNodes} matched`;
  } else {
    range =
      shown > 0
        ? `Nodes ${query.offset + 1}–${query.offset + shown} of ${matchedNodes} matched`
        : `0 of ${matchedNodes} matched`;
  }
  return `${range} · displayed ${shown}/${coverage.totalNodes} nodes · projection ${coverage.totalNodes} nodes, ${coverage.totalEdges} edges · showing ${graph.edges.length} edges · omitted ${coverage.omittedNodes} nodes, ${coverage.omittedEdges} edges`;
}
