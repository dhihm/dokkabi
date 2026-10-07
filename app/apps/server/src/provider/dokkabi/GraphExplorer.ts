/**
 * Bounded graph exploration verification for workbench.graph.explore (v1).
 *
 * One response is one bounded page (at most 100 nodes / 1536 edges) of the
 * gateway's full canonical display projection, identified by a snapshot
 * digest. Beyond the closed schema, a page is held to:
 * - its request: the graph type, the exact normalized query (defaults
 *   applied) and — when the request was pinned — the same snapshot unless the
 *   response is an explicit stale state, which carries no nodes or edges;
 * - its own structure: unique node/edge ids, edges only between displayed
 *   nodes, coverage arithmetic that cannot hide truncation;
 * - a non-available inner projection (missing/invalid/unavailable, outer
 *   state available): a truthful source refusal that may still report its
 *   coverage totals, but carries no nodes, edges or layout hints, empty
 *   counts, matchedNodes 0 and no next page;
 * - its citations: every node/edge source within the returned head, the
 *   head row's own hash, and one hash per cited seq;
 * - its pagination: page/search offsets count displayed nodes; nextOffset
 *   is the page end exactly while candidates remain and null otherwise; a
 *   page inside the pool is never empty, an offset past the pool is;
 * - canonical neighbors: the anchor is on EVERY page within the limit;
 *   each page shows at most limit - 1 candidate neighbors, offsets count
 *   neighbors only (excluding the repeated anchor), matchedNodes counts the
 *   pool including the anchor, and a missing anchor is an empty page;
 * - one-hop truth: every displayed neighbor is related to the anchor by a
 *   displayed edge (the harness reserves one such edge per neighbor before
 *   the edge cap);
 * - recorded counts: closed kind/status vocabularies only, kind counts that
 *   sum to the projection total (available projections and stale answers,
 *   which carry the full counts), and never fewer than the page displays.
 *
 * A violation is a contract error; nothing partial renders as success.
 *
 * @module provider/dokkabi/GraphExplorer
 */
import {
  WorkbenchGraphNodeKind,
  WorkbenchGraphNodeStatus,
  type WorkbenchGraphExploreQuery,
  type WorkbenchGraphExploreQueryInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { GraphExploreResponse } from "./WorkbenchProtocol.ts";

const isNodeKind = Schema.is(WorkbenchGraphNodeKind);
const isNodeStatus = Schema.is(WorkbenchGraphNodeStatus);

export const GRAPH_EXPLORE_DEFAULT_LIMIT = 100;

/** Apply the wire defaults so a response can be compared to its request. */
export function normalizeGraphExploreQuery(
  query: WorkbenchGraphExploreQueryInput,
): WorkbenchGraphExploreQuery {
  return {
    mode: query.mode,
    offset: query.offset ?? 0,
    limit: query.limit ?? GRAPH_EXPLORE_DEFAULT_LIMIT,
    ...(query.nodeId !== undefined ? { nodeId: query.nodeId } : {}),
    ...(query.search !== undefined ? { search: query.search } : {}),
  };
}

const sameQuery = (left: WorkbenchGraphExploreQuery, right: WorkbenchGraphExploreQuery): boolean =>
  left.mode === right.mode &&
  left.offset === right.offset &&
  left.limit === right.limit &&
  left.nodeId === right.nodeId &&
  left.search === right.search;

interface SessionCursor {
  readonly sessionId: string;
  readonly seq: number;
  readonly hash: string;
  readonly generation: string;
}

const sameSessionCursor = (left: SessionCursor, right: SessionCursor): boolean =>
  left.sessionId === right.sessionId &&
  left.seq === right.seq &&
  left.hash === right.hash &&
  left.generation === right.generation;

/** Verify one decoded explore page; null when it is exact. */
export function verifyGraphExploreRead(input: {
  readonly read: GraphExploreResponse;
  readonly graphType: "work" | "context";
  readonly query: WorkbenchGraphExploreQuery;
  readonly snapshot?:
    | { readonly sessionCursor: SessionCursor; readonly digest: string }
    | undefined;
}): string | null {
  const { read } = input;
  const graph = read.graph;
  if (read.graphType !== input.graphType) {
    return `The gateway answered a '${read.graphType}' graph for a '${input.graphType}' request.`;
  }
  if (!sameQuery(read.query, input.query)) {
    return "The gateway answered a different query than the one requested.";
  }
  if (!sameSessionCursor(read.snapshot.sessionCursor, read.sessionCursor)) {
    return "The snapshot does not describe the returned session head.";
  }
  if (read.state === "stale") {
    if (input.snapshot === undefined) {
      return "An unpinned explore request cannot be stale.";
    }
    if (
      input.snapshot.digest === read.snapshot.digest &&
      sameSessionCursor(input.snapshot.sessionCursor, read.snapshot.sessionCursor)
    ) {
      return "A stale answer must name a snapshot different from the requested one.";
    }
    if (
      graph.nodes.length > 0 ||
      graph.edges.length > 0 ||
      graph.waves.length > 0 ||
      graph.unscheduled.length > 0 ||
      read.nextOffset !== null
    ) {
      return "A stale answer must carry no nodes, edges, layout hints or next page.";
    }
  } else if (input.snapshot !== undefined) {
    if (
      input.snapshot.digest !== read.snapshot.digest ||
      !sameSessionCursor(input.snapshot.sessionCursor, read.snapshot.sessionCursor)
    ) {
      return "The gateway answered a different snapshot than the pinned one without reporting stale; pages of two projections are never mixed.";
    }
  }
  if (
    input.snapshot !== undefined &&
    input.snapshot.sessionCursor.sessionId !== read.sessionCursor.sessionId
  ) {
    return "The pinned snapshot names another session.";
  }

  // --- structure ---
  if (graph.nodes.length > read.query.limit) {
    return `The page displays ${graph.nodes.length} nodes beyond the query limit ${read.query.limit}.`;
  }
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) return `The page contains duplicate node id '${node.id}'.`;
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) return `The page contains duplicate edge id '${edge.id}'.`;
    edgeIds.add(edge.id);
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      return `Edge '${edge.id}' references an endpoint that is not displayed on this page.`;
    }
  }
  for (const wave of graph.waves) {
    for (const id of wave)
      if (!ids.has(id)) return "A layout wave names a node that is not displayed.";
  }
  for (const id of graph.unscheduled) {
    if (!ids.has(id)) return "An unscheduled hint names a node that is not displayed.";
  }
  const coverage = graph.coverage;
  if (coverage.totalNodes !== graph.nodes.length + coverage.omittedNodes) {
    return "The page's node coverage does not add up to the projection total.";
  }
  if (coverage.totalEdges !== graph.edges.length + coverage.omittedEdges) {
    return "The page's edge coverage does not add up to the projection total.";
  }
  const innerAvailable = graph.state === "available";
  if (!innerAvailable) {
    if (
      graph.nodes.length > 0 ||
      graph.edges.length > 0 ||
      graph.waves.length > 0 ||
      graph.unscheduled.length > 0 ||
      read.nextOffset !== null
    ) {
      return `A ${graph.state} graph body must not carry nodes, edges, layout hints or a next page.`;
    }
    // A genuine source refusal (not a stale pin) names nothing to page.
    if (read.state === "available") {
      if (read.matchedNodes !== 0) {
        return `A ${graph.state} projection cannot match ${read.matchedNodes} nodes.`;
      }
      if (
        Object.keys(read.counts.byKind).length > 0 ||
        Object.keys(read.counts.byStatus).length > 0
      ) {
        return `A ${graph.state} projection must carry empty recorded counts.`;
      }
    }
  }

  // --- citations against the returned head ---
  {
    const head = read.sessionCursor;
    const hashBySeq = new Map<number, string>();
    const refOk = (ref: { seq: number; hash: string }): boolean => {
      if (!Number.isSafeInteger(ref.seq) || ref.seq < 1 || ref.seq > head.seq) return false;
      if (ref.seq === head.seq && ref.hash !== head.hash) return false;
      const known = hashBySeq.get(ref.seq);
      if (known !== undefined) return known === ref.hash;
      hashBySeq.set(ref.seq, ref.hash);
      return true;
    };
    for (const node of graph.nodes) {
      if (!node.sources.every(refOk)) {
        return `Node '${node.id}' cites a source reference outside the returned session head or inconsistent with another citation.`;
      }
    }
    for (const edge of graph.edges) {
      if (!edge.sources.every(refOk)) {
        return `Edge '${edge.id}' cites a source reference outside the returned session head or inconsistent with another citation.`;
      }
    }
  }

  // --- pagination ---
  if (read.matchedNodes > coverage.totalNodes) {
    return "The query matched more nodes than the projection holds.";
  }
  const pageable = read.state === "available" && innerAvailable;
  if (pageable && read.query.mode === "page" && read.matchedNodes !== coverage.totalNodes) {
    return "A page query's candidate pool must be the whole projection.";
  }
  if (pageable && read.query.mode === "neighbors") {
    const anchor = read.query.nodeId;
    if (anchor === undefined || read.query.limit < 2) {
      return "A neighbors page needs an anchor and a limit of at least 2.";
    }
    if (!ids.has(anchor)) {
      // A missing anchor: nothing matched, nothing shown, nothing next.
      if (graph.nodes.length > 0) {
        return "A neighbors page must include its anchor on every page.";
      }
      if (read.matchedNodes !== 0 || read.nextOffset !== null) {
        return "A neighbors page without its anchor must be empty with no candidates or next page.";
      }
    } else {
      if (read.matchedNodes < 1) {
        return "A neighbors pool must include its displayed anchor.";
      }
      // Offsets count candidate neighbors only; the anchor repeats on top.
      const candidates = read.matchedNodes - 1;
      const shown = graph.nodes.length - 1;
      if (shown > read.query.limit - 1) {
        return `The neighbors page shows ${shown} neighbors beyond its capacity ${read.query.limit - 1}.`;
      }
      const end = read.query.offset + shown;
      if (shown > 0 && end > candidates) {
        return "The neighbors page displays more neighbors than its candidate pool holds.";
      }
      if (end < candidates) {
        if (shown !== read.query.limit - 1) {
          return `A non-final neighbors page shows ${shown} neighbors instead of its capacity ${read.query.limit - 1}.`;
        }
        if (read.nextOffset !== end) {
          return `The neighbors page's nextOffset (${String(read.nextOffset)}) is not its candidate end (${end}).`;
        }
      } else if (read.nextOffset !== null) {
        return "The last neighbors page must carry a null nextOffset.";
      }
    }
  } else if (pageable) {
    const end = read.query.offset + graph.nodes.length;
    if (graph.nodes.length > 0 && end > read.matchedNodes) {
      return "The page displays more nodes than its candidate pool holds.";
    }
    if (end < read.matchedNodes) {
      if (graph.nodes.length === 0) {
        return "A page inside the candidate pool must not be empty.";
      }
      if (read.nextOffset !== end) {
        return `The page's nextOffset (${String(read.nextOffset)}) is not its own end (${end}).`;
      }
    } else if (read.nextOffset !== null) {
      return "The last page of a candidate pool must carry a null nextOffset.";
    }
  }

  // --- one-hop neighbors ---
  if (
    read.query.mode === "neighbors" &&
    read.query.nodeId !== undefined &&
    ids.has(read.query.nodeId)
  ) {
    const anchor = read.query.nodeId;
    const related = new Set<string>([anchor]);
    for (const edge of graph.edges) {
      if (edge.from === anchor) related.add(edge.to);
      if (edge.to === anchor) related.add(edge.from);
    }
    for (const id of ids) {
      if (!related.has(id)) return `Node '${id}' is not a one-hop neighbor of the anchor.`;
    }
  }

  // --- recorded counts ---
  let kindTotal = 0;
  for (const [kind, count] of Object.entries(read.counts.byKind)) {
    if (!isNodeKind(kind)) return `The kind count names an unknown node kind '${kind}'.`;
    kindTotal += count;
  }
  let statusTotal = 0;
  for (const [status, count] of Object.entries(read.counts.byStatus)) {
    if (!isNodeStatus(status)) return `The status count names an unrecorded status '${status}'.`;
    statusTotal += count;
  }
  // Full counts accompany an available projection and a stale answer; a
  // non-available projection's counts are empty (checked above).
  if ((innerAvailable || read.state === "stale") && kindTotal !== coverage.totalNodes) {
    return `The kind counts (${kindTotal}) do not sum to the projection total (${coverage.totalNodes}).`;
  }
  if (statusTotal > coverage.totalNodes) {
    return "The status counts exceed the projection total.";
  }
  const shownKinds = new Map<string, number>();
  const shownStatuses = new Map<string, number>();
  for (const node of graph.nodes) {
    shownKinds.set(node.kind, (shownKinds.get(node.kind) ?? 0) + 1);
    if (node.status !== null) {
      shownStatuses.set(node.status, (shownStatuses.get(node.status) ?? 0) + 1);
    }
  }
  for (const [kind, shown] of shownKinds) {
    if ((read.counts.byKind[kind] ?? 0) < shown) {
      return `The kind count for '${kind}' is smaller than the page displays.`;
    }
  }
  for (const [status, shown] of shownStatuses) {
    if ((read.counts.byStatus[status] ?? 0) < shown) {
      return `The status count for '${status}' is smaller than the page displays.`;
    }
  }
  return null;
}
