/**
 * Independent fixtures for the bounded retained-data explorer
 * (workbench.record.index / workbench.record.body / workbench.graph.explore).
 *
 * Rows, canonical bytes, descriptors and graph pages are built here with a
 * hand-rolled sorted-key canonical encoder — never through the app verifier's
 * own encoding — so a verifier change cannot silently satisfy the fixtures.
 * The responders answer like the harness gateway: metadata pages over one
 * pinned prefix, exact canonical byte ranges, and bounded graph pages over
 * one full display projection with a snapshot digest.
 *
 * @module provider/dokkabi/ExplorerGateway.testFixtures
 */
import * as NodeCrypto from "node:crypto";

export const sha256 = (data: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");
export const hex64 = (seed: string): string => sha256(seed);
export const GENESIS = "0".repeat(64);

const canonicalValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalValue((value as Record<string, unknown>)[key]);
  }
  return out;
};
export const canonicalText = (value: unknown): string => JSON.stringify(canonicalValue(value));

export interface ExplorerRow {
  readonly seq: number;
  readonly ts: string;
  readonly kind: "observe";
  readonly name: string;
  readonly prev_hash: string;
  readonly hash: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Contiguous genesis-chained rows; `payloadFor` may return a large payload.
 * `extrasFor` adds further top-level members, exactly as EventLog accepts
 * them on load (it hashes `{...unsigned}` of whatever the row carries):
 * integer-like keys and keys such as `a`/`extra` sort BEFORE `hash` in the
 * canonical encoding, so `hash` is not necessarily the first member.
 */
export const buildExplorerRows = (
  count: number,
  payloadFor: (seq: number) => Record<string, unknown> = (seq) => ({ text: `row ${seq}` }),
  extrasFor?: (seq: number) => Record<string, unknown>,
): ExplorerRow[] => {
  const rows: ExplorerRow[] = [];
  let prev = GENESIS;
  for (let seq = 1; seq <= count; seq += 1) {
    const unsigned = {
      ...extrasFor?.(seq),
      seq,
      ts: `2026-10-06T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
      kind: "observe" as const,
      name: seq === 1 ? "test/large" : "test/source",
      prev_hash: prev,
      payload: payloadFor(seq),
    };
    const hash = sha256(canonicalText(unsigned));
    rows.push({ ...unsigned, hash });
    prev = hash;
  }
  return rows;
};

/** The exact canonical UTF-8 bytes of one row (hash included). */
export const rowBytes = (row: ExplorerRow): Buffer => Buffer.from(canonicalText(row), "utf8");

export const descriptorOf = (row: ExplorerRow) => {
  const bytes = rowBytes(row);
  return {
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    name: row.name,
    prev_hash: row.prev_hash,
    hash: row.hash,
    byteLength: bytes.length,
    bodyDigest: sha256(bytes),
  };
};

export const EXPLORER_SESSION = "live-fake01";
export const EXPLORER_REMOTE_HEAD = 9_000;
export const EXPLORER_GATEWAY_CURSOR = {
  seq: 1,
  hash: hex64("gateway-1"),
  generation: hex64("gateway-generation"),
};

export const headCursor = (rows: readonly ExplorerRow[], sessionId = EXPLORER_SESSION) => ({
  sessionId,
  seq: EXPLORER_REMOTE_HEAD,
  hash: hex64(`session-${rows[0]!.hash}-${EXPLORER_REMOTE_HEAD}`),
  generation: rows[0]!.hash,
});

export const pinAt = (rows: readonly ExplorerRow[], seq: number, sessionId = EXPLORER_SESSION) => ({
  sessionId,
  seq,
  hash: rows[seq - 1]!.hash,
  generation: rows[0]!.hash,
});

/** A metadata index page over (afterSeq, asOf.seq], limited like the harness. */
export const indexPage = (input: {
  readonly rows: readonly ExplorerRow[];
  readonly asOf: { sessionId: string; seq: number; hash: string; generation: string };
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly head?: { sessionId: string; seq: number; hash: string; generation: string };
}): Record<string, unknown> => {
  const after = input.afterSeq ?? 0;
  const limit = input.limit ?? 50;
  const entries = input.rows
    .filter((row) => row.seq > after && row.seq <= input.asOf.seq)
    .slice(0, limit)
    .map(descriptorOf);
  const last = entries.at(-1);
  const hasMore = (last?.seq ?? after) < input.asOf.seq;
  return {
    version: 1,
    state: "available",
    sessionCursor: input.head ?? headCursor(input.rows, input.asOf.sessionId),
    gatewayCursor: EXPLORER_GATEWAY_CURSOR,
    asOf: input.asOf,
    entries,
    next:
      hasMore && last !== undefined
        ? { seq: last.seq, hash: last.hash, generation: input.asOf.generation }
        : null,
    total: input.asOf.seq,
    hasMore,
  };
};

/** One exact canonical byte range of a row, harness-shaped. */
export const bodyRange = (input: {
  readonly rows: readonly ExplorerRow[];
  readonly row: ExplorerRow;
  readonly asOf: { sessionId: string; seq: number; hash: string; generation: string };
  readonly offset: number;
  readonly limit?: number;
  readonly head?: { sessionId: string; seq: number; hash: string; generation: string };
}): Record<string, unknown> => {
  const bytes = rowBytes(input.row);
  const limit = input.limit ?? 32_768;
  const data = bytes.subarray(input.offset, input.offset + limit);
  const end = input.offset + data.length;
  return {
    version: 1,
    state: "available",
    sessionCursor: input.head ?? headCursor(input.rows, input.asOf.sessionId),
    gatewayCursor: EXPLORER_GATEWAY_CURSOR,
    asOf: input.asOf,
    row: { seq: input.row.seq, hash: input.row.hash, generation: input.rows[0]!.hash },
    offset: input.offset,
    nextOffset: end < bytes.length ? end : null,
    totalBytes: bytes.length,
    bodyDigest: sha256(bytes),
    chunkDigest: sha256(data),
    data: data.toString("base64"),
  };
};

/**
 * A responder that answers record.body requests from the params themselves,
 * like the harness: the requested row/offset/limit over the fixture rows.
 */
export const bodyResponder =
  (rows: readonly ExplorerRow[], mutate?: (result: Record<string, unknown>) => void) =>
  (params: Record<string, unknown>): Record<string, unknown> => {
    const cursor = params.row as { seq: number };
    const asOf = params.asOf as {
      sessionId: string;
      seq: number;
      hash: string;
      generation: string;
    };
    const result = bodyRange({
      rows,
      row: rows[cursor.seq - 1]!,
      asOf,
      offset: params.offset as number,
      limit: (params.limit as number | undefined) ?? 32_768,
    });
    mutate?.(result);
    return result;
  };

// --- Graph explorer fixtures ---

export interface ExplorerGraphNode {
  readonly id: string;
  readonly kind: "action" | "observation" | "todo";
  readonly label: string;
  readonly status: "pending" | "completed" | null;
  readonly provenance: "canonical";
  readonly sources: ReadonlyArray<{ seq: number; hash: string }>;
  readonly details: ReadonlyArray<{ name: string; value: string }>;
  readonly bodyDigest: string | null;
}

export interface ExplorerGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "requested_by";
  readonly artifact: null;
  readonly sources: ReadonlyArray<{ seq: number; hash: string }>;
}

/** A full context projection of `count` nodes in a chain (node i → node i-1). */
export const buildExplorerGraph = (
  count: number,
): { nodes: ExplorerGraphNode[]; edges: ExplorerGraphEdge[] } => {
  const nodes: ExplorerGraphNode[] = [];
  const edges: ExplorerGraphEdge[] = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: `action:explore-${String(index).padStart(5, "0")}`,
      kind: index === 0 ? "todo" : "action",
      label: `read explore-${index}`,
      status: index === 0 ? null : index % 2 === 0 ? "completed" : "pending",
      provenance: "canonical",
      sources: [{ seq: index + 1, hash: hex64(`graph-source-${index + 1}`) }],
      details: [],
      bodyDigest: null,
    });
    if (index > 0) {
      edges.push({
        id: hex64(`edge-${index}`),
        from: nodes[index]!.id,
        to: nodes[index - 1]!.id,
        kind: "requested_by",
        artifact: null,
        sources: [{ seq: index + 1, hash: hex64(`graph-source-${index + 1}`) }],
      });
    }
  }
  return { nodes, edges };
};

export const graphDigest = (full: { nodes: unknown[]; edges: unknown[] }): string =>
  sha256(canonicalText(full));

const recordedCounts = (nodes: readonly ExplorerGraphNode[]) => {
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const node of nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    if (node.status !== null) byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
  }
  return { byKind, byStatus };
};

/** Harness edge selection for one displayed id set: both endpoints shown;
 * for neighbors one canonical anchor-incident edge per displayed neighbor
 * first, then further incident edges, then the rest; capped at 1536. */
const displayedEdges = (
  edges: readonly ExplorerGraphEdge[],
  ids: ReadonlySet<string>,
  anchor: string | undefined,
): ExplorerGraphEdge[] => {
  const selected = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  let ordered = selected;
  if (anchor !== undefined) {
    const covered = new Set<string>();
    const first: ExplorerGraphEdge[] = [];
    const incident: ExplorerGraphEdge[] = [];
    const other: ExplorerGraphEdge[] = [];
    for (const edge of selected) {
      const neighbor: string | undefined =
        edge.from === anchor ? edge.to : edge.to === anchor ? edge.from : undefined;
      if (neighbor === undefined) other.push(edge);
      else if (neighbor !== anchor && !covered.has(neighbor)) {
        covered.add(neighbor);
        first.push(edge);
      } else incident.push(edge);
    }
    ordered = [...first, ...incident, ...other];
  }
  return ordered.slice(0, 1_536);
};

/**
 * A harness-shaped explore responder over one full projection: page,
 * literal search and one-hop neighbors (the anchor on EVERY page inside the
 * limit; offsets count candidate neighbors only), with a snapshot digest; a
 * request pinned to a different snapshot answers stale with no nodes but
 * the full counts. `innerState` simulates a non-available projection: the
 * graph passes through with its truthful totals, no nodes, empty counts,
 * matchedNodes 0 and no next page.
 */
export const exploreResponder = (input: {
  readonly graphType?: "work" | "context";
  readonly full: { nodes: ExplorerGraphNode[]; edges: ExplorerGraphEdge[] };
  readonly head: { sessionId: string; seq: number; hash: string; generation: string };
  readonly innerState?: "missing" | "invalid" | "unavailable";
  readonly mutate?: (result: Record<string, unknown>, params: Record<string, unknown>) => void;
}) => {
  return (params: Record<string, unknown>): Record<string, unknown> => {
    const full = input.full;
    const digest = graphDigest({
      ...full,
      ...(input.innerState ? { state: input.innerState } : {}),
    });
    const snapshot = { sessionCursor: input.head, digest };
    const raw = params.query as Record<string, unknown>;
    const query: Record<string, unknown> = {
      mode: raw.mode,
      offset: (raw.offset as number | undefined) ?? 0,
      limit: (raw.limit as number | undefined) ?? 100,
      ...(raw.nodeId !== undefined ? { nodeId: raw.nodeId } : {}),
      ...(raw.search !== undefined ? { search: raw.search } : {}),
    };
    const pin = params.snapshot as { sessionCursor: { seq: number }; digest: string } | undefined;
    const stale =
      pin !== undefined && (pin.digest !== digest || pin.sessionCursor.seq !== input.head.seq);
    const offset = query.offset as number;
    const limit = query.limit as number;
    let matched: ExplorerGraphNode[];
    let page: ExplorerGraphNode[];
    let nextOffset: number | null;
    let anchorId: string | undefined;
    if (input.innerState !== undefined) {
      matched = [];
      page = [];
      nextOffset = null;
    } else if (query.mode === "neighbors") {
      const anchor = full.nodes.find((node) => node.id === query.nodeId);
      if (anchor === undefined) {
        matched = [];
        page = [];
        nextOffset = null;
      } else {
        anchorId = anchor.id;
        const adjacent = new Set<string>();
        for (const edge of full.edges) {
          if (edge.from === anchor.id) adjacent.add(edge.to);
          else if (edge.to === anchor.id) adjacent.add(edge.from);
        }
        const neighbors = full.nodes.filter(
          (node) => node.id !== anchor.id && adjacent.has(node.id),
        );
        matched = [anchor, ...neighbors];
        const window = limit - 1;
        page = [anchor, ...neighbors.slice(offset, offset + window)];
        nextOffset = offset + window < neighbors.length ? offset + window : null;
      }
    } else {
      const needle = String(query.search ?? "").toLowerCase();
      matched =
        query.mode === "search"
          ? full.nodes.filter(
              (node) =>
                node.id.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle),
            )
          : full.nodes;
      page = matched.slice(offset, offset + limit);
      nextOffset = offset + page.length < matched.length ? offset + page.length : null;
    }
    if (stale) page = [];
    const ids = new Set(page.map((node) => node.id));
    const edges = stale ? [] : displayedEdges(full.edges, ids, anchorId);
    const innerState = stale ? "unavailable" : (input.innerState ?? "available");
    const result: Record<string, unknown> = {
      version: 1,
      state: stale ? "stale" : "available",
      graphType: input.graphType ?? "context",
      sessionCursor: input.head,
      gatewayCursor: EXPLORER_GATEWAY_CURSOR,
      snapshot,
      query,
      nextOffset: stale ? null : nextOffset,
      graph: {
        state: innerState,
        mode: input.graphType === "work" ? null : "on",
        revision: null,
        digest: null,
        nodes: page,
        edges,
        waves: [],
        unscheduled: [],
        coverage: {
          status: innerState === "available" ? "complete" : "unavailable",
          totalNodes: full.nodes.length,
          totalEdges: full.edges.length,
          omittedNodes: full.nodes.length - page.length,
          omittedEdges: full.edges.length - edges.length,
        },
        errors: stale
          ? ["The recorded graph changed; explicitly refresh this view before navigating."]
          : input.innerState !== undefined
            ? [`the recorded graph is ${input.innerState}`]
            : [],
      },
      counts:
        input.innerState !== undefined ? { byKind: {}, byStatus: {} } : recordedCounts(full.nodes),
      matchedNodes: matched.length,
    };
    input.mutate?.(result, params);
    return result;
  };
};
