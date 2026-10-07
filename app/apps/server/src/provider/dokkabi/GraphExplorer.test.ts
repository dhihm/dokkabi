/**
 * GraphExplorer page verification against the harness's canonical explore
 * semantics (root clarifications 16:46 / 16:50):
 * - neighbors: the anchor is on EVERY page inside the node limit (limit >= 2);
 *   the candidate capacity is limit - 1, offset/nextOffset count candidate
 *   neighbors only, matchedNodes counts the pool INCLUDING the anchor, and a
 *   missing anchor is an empty page with a null next;
 * - dense neighborhoods keep one anchor-incident edge per displayed neighbor
 *   before further edges under the 1536 edge cap;
 * - a non-available inner projection (missing/invalid/unavailable) may
 *   truthfully report coverage totals > 0 with no nodes, empty counts,
 *   matchedNodes 0 and no next page — a genuine source refusal, not a
 *   contract error; an outer stale answer carries the full counts.
 * Page/search offsets keep counting displayed nodes.
 *
 * @module provider/dokkabi/GraphExplorer.test
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { WorkbenchGraphExploreQuery, WorkbenchGraphExploreQueryInput } from "@t3tools/contracts";

import { normalizeGraphExploreQuery, verifyGraphExploreRead } from "./GraphExplorer.ts";
import {
  buildExplorerGraph,
  buildExplorerRows,
  exploreResponder,
  graphDigest,
  headCursor,
  hex64,
  type ExplorerGraphEdge,
  type ExplorerGraphNode,
} from "./ExplorerGateway.testFixtures.ts";
import type { GraphExploreResponse } from "./WorkbenchProtocol.ts";

const rows = buildExplorerRows(2);
const head = headCursor(rows);

/** A star: node 0 is the hub joined to every other node (canonical order). */
const star = (count: number, parallel = 1) => {
  const { nodes } = buildExplorerGraph(count);
  const edges: ExplorerGraphEdge[] = [];
  for (let index = 1; index < count; index += 1) {
    for (let copy = 0; copy < parallel; copy += 1) {
      edges.push({
        id: hex64(`star-${index}-${copy}`),
        from: nodes[index]!.id,
        to: nodes[0]!.id,
        kind: "requested_by",
        artifact: null,
        sources: [{ seq: 1, hash: hex64("graph-source-1") }],
      });
    }
  }
  return { nodes, edges };
};

const explore = (
  full: { nodes: ExplorerGraphNode[]; edges: ExplorerGraphEdge[] },
  query: Parameters<typeof normalizeGraphExploreQuery>[0],
  options: {
    readonly snapshot?: { sessionCursor: typeof head; digest: string };
    readonly innerState?: "missing" | "invalid" | "unavailable";
    readonly mutate?: (result: Record<string, unknown>) => void;
  } = {},
) => {
  const normalized = normalizeGraphExploreQuery(query);
  const read = exploreResponder({
    full,
    head,
    ...(options.innerState !== undefined ? { innerState: options.innerState } : {}),
    ...(options.mutate !== undefined ? { mutate: options.mutate } : {}),
  })({
    query: normalized,
    ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
  }) as unknown as GraphExploreResponse;
  return {
    read,
    refusal: verifyGraphExploreRead({
      read,
      graphType: "context",
      query: normalized,
      snapshot: options.snapshot,
    }),
  };
};

describe("canonical neighbors paging", () => {
  it("walks every neighbor with the anchor repeated on each page", () => {
    const full = star(11);
    const anchor = full.nodes[0]!.id;
    const seen: string[] = [];
    let offset = 0;
    const pages: Array<{ offset: number; next: number | null; ids: string[] }> = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const { read, refusal } = explore(full, {
        mode: "neighbors",
        nodeId: anchor,
        offset,
        limit: 4,
      });
      expect(refusal, `page at ${offset}`).toBeNull();
      const ids = read.graph.nodes.map((node) => node.id);
      expect(ids[0]).toBe(anchor);
      expect(ids.length).toBeLessThanOrEqual(4);
      expect(read.matchedNodes).toBe(11);
      pages.push({ offset, next: read.nextOffset, ids });
      seen.push(...ids.slice(1));
      if (read.nextOffset === null) break;
      offset = read.nextOffset;
    }
    expect(pages.map((page) => [page.offset, page.next])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
      [9, null],
    ]);
    expect(seen).toEqual(full.nodes.slice(1).map((node) => node.id));
  });

  it("a non-first page at exact capacity and an offset past the pool", () => {
    const full = star(7);
    const anchor = full.nodes[0]!.id;
    const exact = explore(full, { mode: "neighbors", nodeId: anchor, offset: 3, limit: 4 });
    expect(exact.refusal).toBeNull();
    expect(exact.read.graph.nodes).toHaveLength(4);
    expect(exact.read.nextOffset).toBeNull();
    const past = explore(full, { mode: "neighbors", nodeId: anchor, offset: 9, limit: 4 });
    expect(past.refusal).toBeNull();
    expect(past.read.graph.nodes.map((node) => node.id)).toEqual([anchor]);
    expect(past.read.nextOffset).toBeNull();
  });

  it("a missing anchor is an empty page with a null next", () => {
    const { read, refusal } = explore(star(5), {
      mode: "neighbors",
      nodeId: "action:absent",
      limit: 2,
    });
    expect(refusal).toBeNull();
    expect(read.graph.nodes).toEqual([]);
    expect(read.matchedNodes).toBe(0);
    expect(read.nextOffset).toBeNull();
  });

  it("dense neighborhoods keep one anchor edge per displayed neighbor under the edge cap", () => {
    // 99 neighbors, 20 parallel anchor edges each (1980 > 1536) plus a
    // complete neighbor clique: the cap still leaves one-hop proof per node.
    const base = star(100, 20);
    const clique: ExplorerGraphEdge[] = [];
    for (let left = 1; left < 100; left += 1) {
      for (let right = left + 1; right < 100; right += 1) {
        clique.push({
          id: hex64(`clique-${left}-${right}`),
          from: base.nodes[left]!.id,
          to: base.nodes[right]!.id,
          kind: "requested_by",
          artifact: null,
          sources: [],
        });
      }
    }
    const full = { nodes: base.nodes, edges: [...clique, ...base.edges] };
    const { read, refusal } = explore(full, {
      mode: "neighbors",
      nodeId: base.nodes[0]!.id,
      limit: 100,
    });
    expect(refusal).toBeNull();
    expect(read.graph.nodes).toHaveLength(100);
    expect(read.graph.edges).toHaveLength(1_536);
    expect(read.graph.coverage.omittedEdges).toBe(full.edges.length - 1_536);
  });

  it("refuses a neighbors page whose capped edges hide a displayed neighbor's relation", () => {
    const full = star(6);
    const { refusal } = explore(
      full,
      { mode: "neighbors", nodeId: full.nodes[0]!.id, limit: 6 },
      {
        mutate: (result) => {
          const graph = result.graph as {
            edges: unknown[];
            coverage: { omittedEdges: number };
          };
          graph.edges = graph.edges.slice(1);
          graph.coverage.omittedEdges += 1;
        },
      },
    );
    expect(refusal).toContain("one-hop");
  });

  it("refuses a neighbors page without its anchor and a first-page-only slicing", () => {
    const full = star(11);
    const anchor = full.nodes[0]!.id;
    const missingAnchor = explore(
      full,
      { mode: "neighbors", nodeId: anchor, offset: 3, limit: 4 },
      {
        mutate: (result) => {
          const graph = result.graph as {
            nodes: Array<{ id: string }>;
            edges: unknown[];
            coverage: { totalEdges: number; omittedNodes: number; omittedEdges: number };
          };
          graph.nodes = graph.nodes.slice(1);
          graph.edges = [];
          graph.coverage.omittedNodes += 1;
          graph.coverage.omittedEdges = graph.coverage.totalEdges;
        },
      },
    );
    expect(missingAnchor.refusal).toContain("anchor");
    // Old first-page-only semantics: the second page advanced by the
    // displayed count (offset 4) instead of the candidate count (3).
    const displayedCount = explore(
      full,
      { mode: "neighbors", nodeId: anchor, offset: 0, limit: 4 },
      { mutate: (result) => (result.nextOffset = 4) },
    );
    expect(displayedCount.refusal).toContain("nextOffset");
  });

  it("neighbors queries require at least two slots", () => {
    const decodes = (schema: Schema.Top, value: unknown) =>
      Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success";
    expect(
      decodes(WorkbenchGraphExploreQueryInput, { mode: "neighbors", nodeId: "a", limit: 1 }),
    ).toBe(false);
    expect(
      decodes(WorkbenchGraphExploreQuery, { mode: "neighbors", nodeId: "a", offset: 0, limit: 1 }),
    ).toBe(false);
    expect(
      decodes(WorkbenchGraphExploreQueryInput, { mode: "neighbors", nodeId: "a", limit: 2 }),
    ).toBe(true);
    // Page and search keep limit 1.
    expect(decodes(WorkbenchGraphExploreQueryInput, { mode: "page", limit: 1 })).toBe(true);
    expect(
      decodes(WorkbenchGraphExploreQueryInput, { mode: "search", search: "x", limit: 1 }),
    ).toBe(true);
  });

  it("a stale neighbors answer carries full counts and no nodes", () => {
    const full = star(11);
    const { read, refusal } = explore(
      full,
      { mode: "neighbors", nodeId: full.nodes[0]!.id, offset: 3, limit: 4 },
      { snapshot: { sessionCursor: head, digest: hex64("older-projection") } },
    );
    expect(refusal).toBeNull();
    expect(read.state).toBe("stale");
    expect(read.graph.nodes).toEqual([]);
    expect(read.nextOffset).toBeNull();
    expect(read.counts.byKind).toEqual({ todo: 1, action: 10 });
  });
});

describe("page and search offsets count displayed nodes", () => {
  it("pages and searches stay unchanged", () => {
    const full = buildExplorerGraph(250);
    const page = explore(full, { mode: "page", offset: 100, limit: 100 });
    expect(page.refusal).toBeNull();
    expect(page.read.nextOffset).toBe(200);
    const search = explore(full, { mode: "search", search: "explore-001", limit: 5 });
    expect(search.refusal).toBeNull();
    expect(search.read.matchedNodes).toBe(100);
    expect(search.read.nextOffset).toBe(5);
    const pinned = explore(
      full,
      { mode: "page", offset: 200 },
      {
        snapshot: { sessionCursor: head, digest: graphDigest(full) },
      },
    );
    expect(pinned.refusal).toBeNull();
    expect(pinned.read.nextOffset).toBeNull();
  });
});

describe("non-available inner projections", () => {
  for (const innerState of ["missing", "invalid", "unavailable"] as const) {
    it(`a truthful ${innerState} projection with totals is a source refusal, not a contract error`, () => {
      const full = buildExplorerGraph(innerState === "unavailable" ? 600 : 3);
      for (const query of [
        { mode: "page" as const },
        { mode: "neighbors" as const, nodeId: full.nodes[0]!.id, offset: 2, limit: 3 },
        { mode: "search" as const, search: "explore" },
      ]) {
        const { read, refusal } = explore(full, query, { innerState });
        expect(refusal, `${innerState} ${query.mode}`).toBeNull();
        expect(read.state).toBe("available");
        expect(read.graph.state).toBe(innerState);
        expect(read.graph.coverage.totalNodes).toBeGreaterThan(0);
        expect(read.counts).toEqual({ byKind: {}, byStatus: {} });
        expect(read.matchedNodes).toBe(0);
        expect(read.nextOffset).toBeNull();
      }
    });
  }

  const forged: ReadonlyArray<readonly [string, (result: Record<string, unknown>) => void]> = [
    [
      "nodes",
      (result) => {
        const graph = result.graph as { nodes: unknown[]; coverage: { omittedNodes: number } };
        graph.nodes = buildExplorerGraph(1).nodes;
        graph.coverage.omittedNodes -= 1;
      },
    ],
    ["layout hints", (result) => ((result.graph as { unscheduled: string[] }).unscheduled = ["x"])],
    ["a next page", (result) => (result.nextOffset = 5)],
    ["a candidate pool", (result) => (result.matchedNodes = 3)],
    ["invented counts", (result) => (result.counts = { byKind: { action: 3 }, byStatus: {} })],
  ];
  for (const [label, mutate] of forged) {
    it(`refuses an unavailable projection that carries ${label}`, () => {
      const { refusal } = explore(
        buildExplorerGraph(600),
        { mode: "page" },
        {
          innerState: "unavailable",
          mutate,
        },
      );
      expect(refusal).not.toBeNull();
    });
  }

  it("still holds an available projection's counts to its total", () => {
    const { refusal } = explore(
      buildExplorerGraph(10),
      { mode: "page" },
      {
        mutate: (result) => (result.counts = { byKind: {}, byStatus: {} }),
      },
    );
    expect(refusal).toContain("kind counts");
  });

  it("a stale answer over a projection still sums its full counts", () => {
    const full = buildExplorerGraph(150);
    const { refusal } = explore(
      full,
      { mode: "page" },
      {
        snapshot: { sessionCursor: head, digest: hex64("older") },
        mutate: (result) => (result.counts = { byKind: { action: 1 }, byStatus: {} }),
      },
    );
    expect(refusal).toContain("kind counts");
  });
});
