/**
 * Read-only fake explorer source for focused tests and the isolated render
 * fixture. It generates a retained log with one ~2.6MB canonical row and a
 * Work graph with more than 512 nodes, and answers the four bounded explorer
 * reads exactly as the wire contract describes (index/body/verify/explore).
 * Every read is counted with its byte range so tests can bound demand.
 *
 * Never production data: no credentials, sessions, network or model calls.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type {
  ProviderWorkbenchGraphEdge,
  ProviderWorkbenchGraphExploreResult,
  ProviderWorkbenchGraphNode,
  ProviderWorkbenchRecordBodyResult,
  ProviderWorkbenchRecordIndexResult,
  ProviderWorkbenchRecordVerificationResult,
  WorkbenchGraphExploreQuery,
  WorkbenchGraphExploreQueryInput,
  WorkbenchGraphExploreSnapshot,
  WorkbenchGraphNodeKind,
  WorkbenchGraphNodeStatus,
  WorkbenchRecordAsOf,
  WorkbenchRecordBodyExpected,
  WorkbenchRecordCursor,
  WorkbenchRecordDescriptor,
} from "@t3tools/contracts";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));
const hashText = (text: string): string => hex(encoder.encode(text));

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Mixed-width text: 1, 2, 3 and 4 byte UTF-8 sequences in every cycle. */
const UNICODE_UNIT = "ab é 한글 😀 \u{1F9EA} z";

export interface FakeReadEvent {
  readonly method: "index" | "body" | "verify" | "explore";
  readonly offset?: number;
  readonly limit?: number;
  readonly seq?: number;
  readonly mode?: string;
}

export interface FakeRow {
  readonly descriptor: WorkbenchRecordDescriptor;
  readonly bytes: Uint8Array;
}

export type FakeBodyTamper =
  | null
  | "chunkDigest"
  | "swapRow"
  | "corruptData"
  | "wrongTotal"
  | "wrongOffset"
  | "foreignAsOf";

export interface FakeExplorerSource {
  readonly sessionId: string;
  readonly generation: string;
  readonly gatewayCursor: WorkbenchRecordCursor;
  readonly rows: FakeRow[];
  readonly reads: FakeReadEvent[];
  bodyTamper: FakeBodyTamper;
  /** Answer with an older gateway's -32601-equivalent unsupported result. */
  unsupported: boolean;
  head(): WorkbenchRecordAsOf;
  append(name?: string): void;
  index(input: {
    readonly after?: WorkbenchRecordCursor | undefined;
    readonly asOf?: WorkbenchRecordAsOf | undefined;
    readonly limit?: number | undefined;
  }): ProviderWorkbenchRecordIndexResult;
  body(input: {
    readonly row: WorkbenchRecordCursor;
    readonly asOf: WorkbenchRecordAsOf;
    readonly offset: number;
    readonly limit?: number | undefined;
    readonly expected: WorkbenchRecordBodyExpected;
  }): ProviderWorkbenchRecordBodyResult;
  verify(input: {
    readonly row: WorkbenchRecordCursor;
    readonly asOf: WorkbenchRecordAsOf;
    readonly expected: WorkbenchRecordBodyExpected;
  }): ProviderWorkbenchRecordVerificationResult;
  graph: FakeGraph;
  explore(input: {
    readonly graphType: "work" | "context";
    readonly query: WorkbenchGraphExploreQueryInput;
    readonly snapshot?: WorkbenchGraphExploreSnapshot | undefined;
  }): ProviderWorkbenchGraphExploreResult;
  /** Replace the graph projection (a recorded update): pinned pages go stale. */
  bumpGraph(): void;
}

export interface FakeGraph {
  version: number;
  nodes: ProviderWorkbenchGraphNode[];
  edges: ProviderWorkbenchGraphEdge[];
}

const KINDS: readonly WorkbenchGraphNodeKind[] = ["todo", "scenario", "case", "attempt"];
const STATUSES: readonly (WorkbenchGraphNodeStatus | null)[] = [
  "ready",
  "green",
  "red",
  "pending",
  null,
];

function makeGraph(nodeCount: number, rootFanout: number, version: number): FakeGraph {
  const nodes: ProviderWorkbenchGraphNode[] = [];
  const edges: ProviderWorkbenchGraphEdge[] = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const kind = index === 0 ? "goal" : (KINDS[index % KINDS.length] ?? "todo");
    const status = index === 0 ? null : (STATUSES[index % STATUSES.length] ?? null);
    const id = index === 0 ? "goal:root" : `${kind}:n${String(index).padStart(5, "0")}`;
    nodes.push({
      id,
      kind,
      label: index === 0 ? "Root goal" : `Recorded ${kind} ${index}${version > 1 ? " (v2)" : ""}`,
      status,
      provenance: "canonical",
      sources: [{ seq: 1, hash: "1".repeat(64) }],
      details: [{ name: "index", value: String(index) }],
      bodyDigest: hashText(`node-${index}`),
    });
  }
  for (let index = 1; index < nodeCount; index += 1) {
    const parent = index <= rootFanout ? 0 : Math.floor((index - rootFanout - 1) / 3) + 1;
    const from = nodes[parent]!.id;
    const to = nodes[index]!.id;
    edges.push({
      id: hashText(`contains:${from}:${to}`).slice(0, 64),
      from,
      to,
      kind: "contains",
      artifact: null,
      sources: [],
    });
    if (index % 10 === 0 && index > 1) {
      const blocker = nodes[index - 1]!.id;
      edges.push({
        id: hashText(`blocked:${to}:${blocker}`).slice(0, 64),
        from: to,
        to: blocker,
        kind: "blocked_by",
        artifact: null,
        sources: [],
      });
    }
  }
  return { version, nodes, edges };
}

/**
 * Build the fake source. Defaults: 130 rows (row 60 ≈ 2.6MB, row 61 carries
 * a truncated display name), and a 541-node Work graph whose root has 150
 * one-hop neighbors (so neighbors mode pages too).
 */
export function makeFakeExplorerSource(
  options: {
    readonly rows?: number;
    readonly largeRowSeq?: number;
    readonly largeRowBytes?: number;
    readonly hugeDescriptorSeq?: number;
    readonly graphNodes?: number;
    readonly rootFanout?: number;
  } = {},
): FakeExplorerSource {
  const rowCount = options.rows ?? 130;
  const largeSeq = options.largeRowSeq ?? 60;
  const largeBytes = options.largeRowBytes ?? 2_600_000;
  const hugeSeq = options.hugeDescriptorSeq ?? 0;
  const sessionId = "fixture-session";
  // The source generation is the first row's own hash (set once row 1 exists).
  let generation = "";
  const rows: FakeRow[] = [];
  const reads: FakeReadEvent[] = [];
  let prevHash = "0".repeat(64);

  const pushRow = (seq: number, name: string, payload: Record<string, unknown>) => {
    const unsigned = {
      seq,
      ts: `2026-10-06T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
      kind: "observe" as const,
      name,
      prev_hash: prevHash,
      payload,
    };
    const hash = hashText(JSON.stringify(unsigned));
    // Canonical rows may carry keys before the hash member; bytes are opaque here.
    const row = { ...unsigned, hash };
    const bytes = encoder.encode(JSON.stringify(row));
    const nameTruncated = name.length > 1_024;
    const descriptor: WorkbenchRecordDescriptor = {
      seq,
      ts: unsigned.ts,
      kind: unsigned.kind,
      name: nameTruncated ? name.slice(0, 1_024) : name,
      prev_hash: prevHash,
      hash,
      byteLength: seq === hugeSeq ? 70 * 1_048_576 : bytes.length,
      bodyDigest: hex(bytes),
      ...(nameTruncated ? { nameTruncated: true as const } : {}),
    };
    rows.push({ descriptor, bytes });
    prevHash = hash;
  };

  for (let seq = 1; seq <= rowCount; seq += 1) {
    if (seq === 2) generation = rows[0]!.descriptor.hash;
    if (seq === largeSeq) {
      const repeat = Math.ceil(largeBytes / encoder.encode(UNICODE_UNIT).length);
      pushRow(seq, "fixture/large-observation", { text: UNICODE_UNIT.repeat(repeat) });
    } else if (largeSeq > 0 && seq === largeSeq + 1) {
      pushRow(seq, `fixture/wide-name-${"n".repeat(2_000)}`, { seq });
    } else {
      pushRow(seq, `fixture/row-${seq}`, { seq, note: `row ${seq} 한 😀` });
    }
  }

  const gatewayCursor: WorkbenchRecordCursor = {
    seq: 3,
    hash: "c".repeat(64),
    generation: "d".repeat(64),
  };
  const head = (): WorkbenchRecordAsOf => {
    const last = rows.at(-1)!.descriptor;
    return { sessionId, seq: last.seq, hash: last.hash, generation };
  };

  let graph = makeGraph(options.graphNodes ?? 541, options.rootFanout ?? 150, 1);
  const snapshotOf = (): WorkbenchGraphExploreSnapshot => ({
    sessionCursor: head(),
    digest: hashText(`graph-v${graph.version}-${graph.nodes.length}`),
  });

  if (generation === "") generation = rows[0]!.descriptor.hash;
  const source: FakeExplorerSource = {
    sessionId,
    get generation() {
      return generation;
    },
    gatewayCursor,
    rows,
    reads,
    bodyTamper: null,
    unsupported: false,
    head,
    append: (name = "fixture/appended") => {
      pushRow(rows.length + 1, name, { appended: true });
    },
    index: (input) => {
      reads.push({ method: "index", ...(input.limit !== undefined ? { limit: input.limit } : {}) });
      if (source.unsupported) {
        return {
          status: "unsupported",
          reason: "The gateway does not offer workbench.record.index.",
        };
      }
      const asOf = input.asOf ?? head();
      const limit = input.limit ?? 50;
      const startSeq = (input.after?.seq ?? 0) + 1;
      const entries: WorkbenchRecordDescriptor[] = [];
      for (let seq = startSeq; seq <= asOf.seq && entries.length < limit; seq += 1) {
        entries.push(rows[seq - 1]!.descriptor);
      }
      const last = entries.at(-1);
      const hasMore = last !== undefined && last.seq < asOf.seq;
      return {
        status: "available",
        index: {
          version: 1,
          state: "available",
          sessionCursor: head(),
          gatewayCursor,
          asOf,
          entries,
          next: hasMore ? { seq: last.seq, hash: last.hash, generation } : null,
          total: asOf.seq,
          hasMore,
        },
      };
    },
    body: (input) => {
      const limit = input.limit ?? 32_768;
      reads.push({ method: "body", offset: input.offset, limit, seq: input.row.seq });
      if (source.unsupported) {
        return {
          status: "unsupported",
          reason: "The gateway does not offer workbench.record.body.",
        };
      }
      const row = rows[input.row.seq - 1];
      if (row === undefined || row.descriptor.hash !== input.row.hash) {
        return { status: "unavailable", reason: "The requested row is not retained." };
      }
      const total = row.bytes.length;
      if (input.offset >= total) {
        return { status: "unavailable", reason: "The offset lies beyond the row's end." };
      }
      const end = Math.min(total, input.offset + limit);
      let data = row.bytes.slice(input.offset, end);
      const chunkDigest = hex(data);
      if (source.bodyTamper === "corruptData") {
        data = data.slice();
        data[0] = data[0] === 0x41 ? 0x42 : 0x41;
      }
      const swapped = rows[input.row.seq % rows.length]!.descriptor;
      return {
        status: "available",
        body: {
          version: 1,
          state: "available",
          sessionCursor: head(),
          gatewayCursor,
          asOf:
            source.bodyTamper === "foreignAsOf"
              ? { ...input.asOf, sessionId: "foreign-session" }
              : input.asOf,
          row:
            source.bodyTamper === "swapRow"
              ? { seq: swapped.seq, hash: swapped.hash, generation }
              : input.row,
          offset: source.bodyTamper === "wrongOffset" ? input.offset + 1 : input.offset,
          nextOffset: end < total ? end : null,
          totalBytes: source.bodyTamper === "wrongTotal" ? total + 1 : total,
          bodyDigest: row.descriptor.bodyDigest,
          chunkDigest: source.bodyTamper === "chunkDigest" ? "f".repeat(64) : chunkDigest,
          data: bytesToBase64(data),
        },
      };
    },
    verify: (input) => {
      reads.push({ method: "verify", seq: input.row.seq });
      if (source.unsupported) {
        return { status: "unsupported", reason: "The gateway does not offer verification." };
      }
      const row = rows[input.row.seq - 1]!;
      return {
        status: "available",
        verification: {
          verdict: "exact",
          row: input.row,
          asOf: input.asOf,
          totalBytes: row.bytes.length,
          bodyDigest: row.descriptor.bodyDigest,
          chunks: Math.ceil(row.bytes.length / 32_768),
        },
      };
    },
    get graph() {
      return graph;
    },
    set graph(next: FakeGraph) {
      graph = next;
    },
    bumpGraph: () => {
      graph = makeGraph(graph.nodes.length + 3, options.rootFanout ?? 150, graph.version + 1);
      source.append("fixture/graph-update");
    },
    explore: (input) => {
      reads.push({ method: "explore", mode: input.query.mode });
      if (source.unsupported) {
        return {
          status: "unsupported",
          reason: "The gateway does not offer workbench.graph.explore.",
        };
      }
      const query: WorkbenchGraphExploreQuery = {
        mode: input.query.mode,
        offset: input.query.offset ?? 0,
        limit: input.query.limit ?? 100,
        ...(input.query.nodeId !== undefined ? { nodeId: input.query.nodeId } : {}),
        ...(input.query.search !== undefined ? { search: input.query.search } : {}),
      };
      const snapshot = snapshotOf();
      const byKind: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const node of graph.nodes) {
        byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
        if (node.status !== null) byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
      }
      const totalNodes = graph.nodes.length;
      const totalEdges = graph.edges.length;
      const base = {
        version: 1 as const,
        graphType: input.graphType,
        sessionCursor: head(),
        gatewayCursor,
        snapshot,
        query,
        counts: { byKind, byStatus },
      };
      const bodyBase = {
        state: "available" as const,
        mode: "on" as const,
        revision: graph.version,
        digest: snapshot.digest,
        waves: [],
        unscheduled: [],
        errors: [],
      };
      if (
        input.snapshot !== undefined &&
        (input.snapshot.digest !== snapshot.digest ||
          input.snapshot.sessionCursor.seq !== snapshot.sessionCursor.seq)
      ) {
        return {
          status: "available",
          explore: {
            ...base,
            state: "stale",
            nextOffset: null,
            matchedNodes: 0,
            graph: {
              ...bodyBase,
              nodes: [],
              edges: [],
              coverage: {
                status: "complete",
                totalNodes,
                totalEdges,
                omittedNodes: totalNodes,
                omittedEdges: totalEdges,
              },
            },
          },
        };
      }
      let shown: ProviderWorkbenchGraphNode[] = [];
      let matchedNodes = 0;
      let nextOffset: number | null = null;
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      if (query.mode === "neighbors") {
        const anchor = byId.get(query.nodeId!);
        if (anchor !== undefined) {
          const neighborIds = new Set<string>();
          for (const edge of graph.edges) {
            if (edge.from === anchor.id) neighborIds.add(edge.to);
            if (edge.to === anchor.id) neighborIds.add(edge.from);
          }
          neighborIds.delete(anchor.id);
          const candidates = [...neighborIds].sort().map((id) => byId.get(id)!);
          const capacity = Math.max(1, query.limit - 1);
          const slice = candidates.slice(query.offset, query.offset + capacity);
          shown = [anchor, ...slice];
          matchedNodes = candidates.length + 1;
          const end = query.offset + slice.length;
          nextOffset = end < candidates.length ? end : null;
        }
      } else {
        const needle = query.search?.toLowerCase();
        const pool =
          needle === undefined
            ? graph.nodes
            : graph.nodes.filter(
                (node) =>
                  node.label.toLowerCase().includes(needle) ||
                  node.id.toLowerCase().includes(needle),
              );
        shown = pool.slice(query.offset, query.offset + query.limit);
        matchedNodes = pool.length;
        const end = query.offset + shown.length;
        nextOffset = end < pool.length ? end : null;
      }
      const ids = new Set(shown.map((node) => node.id));
      const edges = graph.edges
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        .slice(0, 1_536);
      return {
        status: "available",
        explore: {
          ...base,
          state: "available",
          nextOffset,
          matchedNodes,
          graph: {
            ...bodyBase,
            nodes: shown,
            edges,
            coverage: {
              status: "complete",
              totalNodes,
              totalEdges,
              omittedNodes: totalNodes - shown.length,
              omittedEdges: totalEdges - edges.length,
            },
          },
        },
      };
    },
  };
  return source;
}
