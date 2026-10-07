/**
 * Bounded graph explorer — the pure read behind exploratory graph paging
 * (BE-02).
 *
 * `projectWorkGraphView`/`projectContextGraphView` with
 * `displayCapacity: "explore"` return the FULL canonical display graph (the
 * size refusal is suppressed there; every citation was still validated
 * first). This module bounds what a caller actually looks at: every query —
 * a page of the canonical node order, the one-hop neighborhood of an anchor,
 * or an inert literal search — yields at most `nodes` (100) nodes and
 * `edges` (1536) edges while the coverage keeps the EXACT global totals and
 * the omitted counts as full minus displayed.
 *
 * Honesty rules this module obeys:
 * - Queries are validated at runtime, never trusted from TypeScript: unknown
 *   fields and malformed values are rejected before anything is projected.
 * - `digest` pins the FULL current canonical display graph
 *   (sha256(canonicalJson(graph)) — sources, statuses, details, waves,
 *   errors, coverage), not only the projector's own digest; the result
 *   graph's `digest` field remains the original canonical projector digest.
 * - A non-available input graph fails closed unchanged: same state, same
 *   graph object, empty counts, matchedNodes 0, nextOffset null. An
 *   unavailable/invalid/missing graph never becomes a successful page.
 * - Nothing is invented: node statuses, relations, errors and partial
 *   coverage pass through untouched; an unknown anchor produces an empty
 *   slice, never a synthetic node.
 * - Pagination always terminates: nextOffset is null at the end, and a
 *   neighbors queries require at least two slots so each page can include
 *   the anchor and advance through its neighbors.
 * - No state survives a call: every projection is computed from the graph
 *   argument alone (no authority cache across calls).
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import {
  WORKBENCH_GRAPH_LIMITS,
  type WorkbenchGraph,
  type WorkbenchGraphNode,
  type WorkbenchGraphState,
} from "./workbench-graph.ts";

/** Hard bounds of one explore result: a bounded page, never a full dump. */
export const WORKBENCH_GRAPH_EXPLORE_LIMITS = {
  /** Maximum nodes per result (also the maximum accepted limit). */
  nodes: 100,
  /** Maximum edges per result after both-endpoint filtering. */
  edges: WORKBENCH_GRAPH_LIMITS.edges,
  /** Maximum length of a literal search string. */
  searchChars: 128,
  /** The limit a query without an explicit limit explores with. */
  defaultLimit: 100,
} as const;

/** An exploratory graph query. `nodeId` (neighbors) and `search` (search)
 * are mode-specific; `offset` defaults to 0 and `limit` to 100. */
export interface WorkbenchGraphExploreQuery {
  readonly mode: "page" | "neighbors" | "search";
  readonly offset?: number;
  readonly limit?: number;
  readonly nodeId?: string;
  readonly search?: string;
}

/** The validated query every result echoes: explicit offset and limit. */
export interface NormalizedGraphExploreQuery {
  readonly mode: "page" | "neighbors" | "search";
  readonly offset: number;
  readonly limit: number;
  /** The neighbors anchor; absent unless mode is "neighbors". */
  readonly nodeId?: string;
  /** The literal search text; absent unless mode is "search". */
  readonly search?: string;
}

export interface WorkbenchGraphExploreCounts {
  /** All validated graph nodes per node kind. */
  readonly byKind: Record<string, number>;
  /** All validated graph nodes per recorded status (null statuses are not counted). */
  readonly byStatus: Record<string, number>;
}

export interface WorkbenchGraphExploreResult {
  readonly state: WorkbenchGraphState;
  /** SHA-256 of the canonical JSON of the FULL input display graph. */
  readonly digest: string;
  /** The normalized query this result answers. */
  readonly query: NormalizedGraphExploreQuery;
  /** The bounded display graph; unchanged (same object) when failing closed. */
  readonly graph: WorkbenchGraph;
  readonly counts: WorkbenchGraphExploreCounts;
  /** The FULL match count of the query (independent of paging). */
  readonly matchedNodes: number;
  /** The next offset to request, or null when the walk is complete. */
  readonly nextOffset: number | null;
}

const QUERY_FIELDS = new Set(["mode", "offset", "limit", "nodeId", "search"]);

/**
 * Validate a query at runtime and normalize it to explicit values. Rejects
 * unknown fields, wrong types, non-integer or negative offsets, limits
 * outside 1..100 (neighbors requires at least 2), mode-specific field misuse (page takes neither nodeId nor
 * search, neighbors takes nodeId but not search, search takes search but
 * not nodeId), empty node ids and search strings over 128 characters.
 */
export function normalizeGraphExploreQuery(query: unknown): NormalizedGraphExploreQuery {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new TypeError("a graph explore query must be an object");
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!QUERY_FIELDS.has(key)) throw new TypeError(`unknown graph explore query field: ${key}`);
  }
  const mode = record.mode;
  if (mode !== "page" && mode !== "neighbors" && mode !== "search") {
    throw new TypeError("a graph explore query mode must be page, neighbors or search");
  }
  let offset = 0;
  if (record.offset !== undefined) {
    if (typeof record.offset !== "number" || !Number.isSafeInteger(record.offset) || record.offset < 0) {
      throw new TypeError("a graph explore query offset must be a safe nonnegative integer");
    }
    offset = record.offset;
  }
  let limit: number = WORKBENCH_GRAPH_EXPLORE_LIMITS.defaultLimit;
  if (record.limit !== undefined) {
    if (
      typeof record.limit !== "number"
      || !Number.isSafeInteger(record.limit)
      || record.limit < 1
      || record.limit > WORKBENCH_GRAPH_EXPLORE_LIMITS.nodes
    ) {
      throw new TypeError(
        `a graph explore query limit must be an integer between 1 and ${WORKBENCH_GRAPH_EXPLORE_LIMITS.nodes}`,
      );
    }
    limit = record.limit;
  }
  if (mode === "page") {
    if (record.nodeId !== undefined || record.search !== undefined) {
      throw new TypeError("a graph explore page query accepts neither nodeId nor search");
    }
    return { mode, offset, limit };
  }
  if (mode === "neighbors") {
    if (record.search !== undefined) throw new TypeError("a graph explore neighbors query does not accept search");
    if (typeof record.nodeId !== "string" || record.nodeId.length === 0) {
      throw new TypeError("a graph explore neighbors query requires a nonempty nodeId");
    }
    if (limit < 2) throw new TypeError("a graph explore neighbors query limit must be at least 2");
    return { mode, offset, limit, nodeId: record.nodeId };
  }
  if (record.nodeId !== undefined) throw new TypeError("a graph explore search query does not accept nodeId");
  if (
    typeof record.search !== "string"
    || record.search.length > WORKBENCH_GRAPH_EXPLORE_LIMITS.searchChars
  ) {
    throw new TypeError(
      `a graph explore search query requires a literal string of at most ${WORKBENCH_GRAPH_EXPLORE_LIMITS.searchChars} characters`,
    );
  }
  return { mode, offset, limit, search: record.search };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function countsOf(nodes: readonly WorkbenchGraphNode[]): WorkbenchGraphExploreCounts {
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const node of nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    if (node.status !== null) byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
  }
  return { byKind, byStatus };
}

/** Inert case-insensitive LITERAL substring match — never a regex, never
 * interpreted text. An empty needle matches every node. */
function nodeMatchesSearch(node: WorkbenchGraphNode, needle: string): boolean {
  if (needle.length === 0) return true;
  if (node.id.toLowerCase().includes(needle)) return true;
  if (node.label.toLowerCase().includes(needle)) return true;
  if (node.kind.toLowerCase().includes(needle)) return true;
  if (node.status !== null && node.status.toLowerCase().includes(needle)) return true;
  for (const entry of node.details) {
    if (entry.value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Bound one exploratory view of an already-validated display graph. The
 * input graph is never mutated and never cached; the result graph keeps the
 * projector's digest, errors, waves (filtered to the displayed ids, wave
 * order preserved) and coverage status, while its coverage carries the
 * exact global totals with omitted = full minus displayed.
 */
export function projectGraphExplore(
  graph: WorkbenchGraph,
  query: WorkbenchGraphExploreQuery,
): WorkbenchGraphExploreResult {
  const normalized = normalizeGraphExploreQuery(query);
  if (
    typeof graph !== "object"
    || graph === null
    || !Array.isArray(graph.nodes)
    || !Array.isArray(graph.edges)
    || !Array.isArray(graph.waves)
    || !Array.isArray(graph.unscheduled)
    || typeof graph.state !== "string"
  ) {
    throw new TypeError("graph explore requires a WorkbenchGraph with nodes, edges, waves, unscheduled and state");
  }
  // The result digest pins the FULL graph exactly as passed in — before any
  // paging decision — so two pages of the same graph share one digest and a
  // tampered graph can never repeat a previously computed one.
  const digest = sha256(canonicalJson(graph));
  if (graph.state !== "available") {
    return {
      state: graph.state,
      digest,
      query: normalized,
      graph,
      counts: { byKind: {}, byStatus: {} },
      matchedNodes: 0,
      nextOffset: null,
    };
  }

  const counts = countsOf(graph.nodes);
  const totalNodes = graph.nodes.length;
  const totalEdges = graph.edges.length;
  let matched: readonly WorkbenchGraphNode[];
  let displayed: readonly WorkbenchGraphNode[];
  let nextOffset: number | null;
  if (normalized.mode === "neighbors") {
    const anchor = graph.nodes.find((node) => node.id === normalized.nodeId);
    if (anchor === undefined) {
      // An unknown anchor is an empty slice — never a synthetic node and
      // never a refusal of the available graph it names nothing in.
      return {
        state: graph.state,
        digest,
        query: normalized,
        graph: emptySlice(graph),
        counts,
        matchedNodes: 0,
        nextOffset: null,
      };
    }
    // One-hop neighborhood in the canonical node order: the anchor plus
    // every node joined to it by an edge, either direction.
    const adjacent = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.from === anchor.id) adjacent.add(edge.to);
      else if (edge.to === anchor.id) adjacent.add(edge.from);
    }
    const neighbors = graph.nodes.filter((node) => node.id !== anchor.id && adjacent.has(node.id));
    matched = [anchor, ...neighbors];
    // Every page includes the anchor WITHIN the limit, reserving one slot.
    // Normalization requires at least two slots so every page advances.
    const window = normalized.limit - 1;
    displayed = [anchor, ...neighbors.slice(normalized.offset, normalized.offset + window)];
    nextOffset = normalized.offset + window < neighbors.length
      ? normalized.offset + window
      : null;
  } else {
    matched = normalized.mode === "search"
      ? graph.nodes.filter((node) => nodeMatchesSearch(node, normalized.search!.toLowerCase()))
      : graph.nodes;
    displayed = matched.slice(normalized.offset, normalized.offset + normalized.limit);
    nextOffset = normalized.offset + displayed.length < matched.length
      ? normalized.offset + displayed.length
      : null;
  }

  const ids = new Set(displayed.map((node) => node.id));
  // Keep only edges whose both endpoints are displayed, then hard-cap: the
  // page never carries more than the edge bound.
  const selectedEdges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  // Reserve one canonical incident edge for every displayed neighbor before
  // filling the cap. Parallel edges for one neighbor cannot hide the recorded
  // relation that made another node a neighbor. Each group keeps canonical
  // relative order; edge objects and global omission accounting are unchanged.
  let orderedEdges = selectedEdges;
  if (normalized.mode === "neighbors") {
    const coveredNeighbors = new Set<string>();
    const firstIncident: typeof selectedEdges = [];
    const remainingIncident: typeof selectedEdges = [];
    const otherEdges: typeof selectedEdges = [];
    for (const edge of selectedEdges) {
      const neighbor = edge.from === normalized.nodeId ? edge.to
        : edge.to === normalized.nodeId ? edge.from : undefined;
      if (neighbor === undefined) {
        otherEdges.push(edge);
      } else if (neighbor !== normalized.nodeId && !coveredNeighbors.has(neighbor)) {
        coveredNeighbors.add(neighbor);
        firstIncident.push(edge);
      } else {
        remainingIncident.push(edge);
      }
    }
    orderedEdges = [...firstIncident, ...remainingIncident, ...otherEdges];
  }
  const displayedEdges = orderedEdges.slice(0, WORKBENCH_GRAPH_EXPLORE_LIMITS.edges);
  return {
    state: graph.state,
    digest,
    query: normalized,
    graph: {
      ...graph,
      nodes: displayed,
      edges: displayedEdges,
      // Layout hints follow the display in canonical relative order, dropping
      // empty groups and off-page ids; the schedule itself is never
      // re-derived here.
      waves: graph.waves.map((wave: readonly string[]) => wave.filter((id) => ids.has(id))).filter((wave) => wave.length > 0),
      unscheduled: graph.unscheduled.filter((id) => ids.has(id)),
      coverage: {
        status: graph.coverage.status,
        totalNodes,
        totalEdges,
        omittedNodes: totalNodes - displayed.length,
        omittedEdges: totalEdges - displayedEdges.length,
      },
      errors: [...graph.errors],
    },
    counts,
    matchedNodes: matched.length,
    nextOffset,
  };
}

/** The unknown-anchor slice: an available graph with nothing displayed. */
function emptySlice(graph: WorkbenchGraph): WorkbenchGraph {
  return {
    ...graph,
    nodes: [],
    edges: [],
    waves: [],
    unscheduled: [],
    coverage: {
      status: graph.coverage.status,
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length,
      omittedNodes: graph.nodes.length,
      omittedEdges: graph.edges.length,
    },
    errors: [...graph.errors],
  };
}
