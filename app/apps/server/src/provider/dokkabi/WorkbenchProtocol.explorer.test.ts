/**
 * Explorer wire codecs beside the unchanged v1 reads. The original
 * workbench.record page still refuses an oversized row and the original
 * workbench.graph codec still refuses more than 512 nodes; the new closed
 * explorer codecs accept bounded metadata, ranges and graph pages, and
 * reject anything they do not model.
 *
 * @module provider/dokkabi/WorkbenchProtocol.explorer.test
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GraphExploreParams,
  GraphExploreResponse,
  GraphResponse,
  RecordBodyParams,
  RecordBodyResponse,
  RecordIndexParams,
  RecordIndexResponse,
  STRICT_DECODE_OPTIONS,
  isBranchSessionMethod,
} from "./WorkbenchProtocol.ts";
import {
  bodyRange,
  buildExplorerGraph,
  buildExplorerRows,
  exploreResponder,
  headCursor,
  indexPage,
  pinAt,
} from "./ExplorerGateway.testFixtures.ts";

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>, STRICT_DECODE_OPTIONS)(value)
    ._tag === "Success";

describe("unchanged v1 graph codec", () => {
  it("still refuses a 541-node graph body", () => {
    const rows = buildExplorerRows(2);
    const full = buildExplorerGraph(541);
    const v1 = {
      version: 1,
      graphType: "context",
      sessionCursor: headCursor(rows),
      gatewayCursor: { seq: 1, hash: "a".repeat(64), generation: "b".repeat(64) },
      resnapshot: false,
      graph: {
        state: "available",
        mode: "on",
        revision: null,
        digest: null,
        nodes: full.nodes,
        edges: full.edges,
        waves: [],
        unscheduled: [],
        coverage: {
          status: "complete",
          totalNodes: 541,
          totalEdges: 540,
          omittedNodes: 0,
          omittedEdges: 0,
        },
        errors: [],
      },
    };
    expect(decodes(GraphResponse, v1)).toBe(false);
  });
});

describe("explorer codecs", () => {
  const rows = buildExplorerRows(3, (seq) => ({ text: "가🙂".repeat(seq * 10) }));

  it("accept harness-shaped index pages and reject payload-carrying descriptors", () => {
    const page = indexPage({ rows, asOf: pinAt(rows, 3) });
    expect(decodes(RecordIndexResponse, page)).toBe(true);
    const smuggled = structuredClone(page) as { entries: Array<Record<string, unknown>> };
    smuggled.entries[0]!.payload = { text: "x" };
    expect(decodes(RecordIndexResponse, smuggled)).toBe(false);
    const tooMany = structuredClone(page) as { entries: unknown[] };
    tooMany.entries = Array.from({ length: 101 }, () => (page.entries as unknown[])[0]);
    expect(decodes(RecordIndexResponse, tooMany)).toBe(false);
  });

  it("accept literal-true excerpt flags and refuse false or unmarked oversized display text", () => {
    const page = indexPage({ rows, asOf: pinAt(rows, 3) });
    const withEntry = (patch: Record<string, unknown>) => {
      const next = structuredClone(page) as { entries: Array<Record<string, unknown>> };
      Object.assign(next.entries[0]!, patch);
      return next;
    };
    const excerpt = "n".repeat(1_024);
    expect(decodes(RecordIndexResponse, withEntry({ name: excerpt, nameTruncated: true }))).toBe(
      true,
    );
    expect(decodes(RecordIndexResponse, withEntry({ ts: excerpt, tsTruncated: true }))).toBe(true);
    // A surrogate pair is never split: the excerpt may stop one unit early.
    expect(
      decodes(RecordIndexResponse, withEntry({ name: "n".repeat(1_023), nameTruncated: true })),
    ).toBe(true);
    expect(decodes(RecordIndexResponse, withEntry({ nameTruncated: false }))).toBe(false);
    expect(decodes(RecordIndexResponse, withEntry({ tsTruncated: false }))).toBe(false);
    expect(decodes(RecordIndexResponse, withEntry({ tsTruncated: "true" }))).toBe(false);
    // Unmarked or marked, display text beyond 1024 UTF-16 units is refused.
    expect(decodes(RecordIndexResponse, withEntry({ name: "n".repeat(1_025) }))).toBe(false);
    expect(
      decodes(RecordIndexResponse, withEntry({ ts: "t".repeat(1_025), tsTruncated: true })),
    ).toBe(false);
    expect(decodes(RecordIndexResponse, withEntry({ nameExcerpt: true }))).toBe(false);
  });

  it("accept bounded body ranges and reject oversized or extended ones", () => {
    const range = bodyRange({ rows, row: rows[2]!, asOf: pinAt(rows, 3), offset: 0 });
    expect(decodes(RecordBodyResponse, range)).toBe(true);
    expect(decodes(RecordBodyResponse, { ...range, path: "/etc/passwd" })).toBe(false);
    expect(
      // Base64 length bounds the range to 32 KiB (+2 bytes of padding
      // slack, which RecordExplorer's exact byte limit check closes).
      decodes(RecordBodyResponse, { ...range, data: Buffer.alloc(32_770).toString("base64") }),
    ).toBe(false);
    expect(decodes(RecordBodyResponse, { ...range, state: "partial" })).toBe(false);
  });

  it("accept bounded graph pages and reject more than 100 nodes", () => {
    const full = buildExplorerGraph(541);
    const page = exploreResponder({ full, head: headCursor(rows) })({
      query: { mode: "page" },
    });
    expect(decodes(GraphExploreResponse, page)).toBe(true);
    const oversized = structuredClone(page) as { graph: { nodes: unknown[] } };
    oversized.graph.nodes = full.nodes.slice(0, 101);
    expect(decodes(GraphExploreResponse, oversized)).toBe(false);
  });

  it("validate outbound params before the wire", () => {
    const binding = { clientId: "c", threadId: "t" };
    const row = { seq: 1, hash: rows[0]!.hash, generation: rows[0]!.hash };
    expect(decodes(RecordIndexParams, { version: 1, binding, limit: 100 })).toBe(true);
    expect(decodes(RecordIndexParams, { version: 1, binding, limit: 101 })).toBe(false);
    expect(
      decodes(RecordBodyParams, { version: 1, binding, row, asOf: pinAt(rows, 3), offset: 0 }),
    ).toBe(true);
    // The pin is required; no arbitrary path or limit beyond 32 KiB.
    expect(decodes(RecordBodyParams, { version: 1, binding, row, offset: 0 })).toBe(false);
    expect(
      decodes(RecordBodyParams, {
        version: 1,
        binding,
        row,
        asOf: pinAt(rows, 3),
        offset: 0,
        limit: 32_769,
      }),
    ).toBe(false);
    expect(
      decodes(GraphExploreParams, {
        version: 1,
        binding,
        graphType: "work",
        query: { mode: "search", search: "x".repeat(129) },
      }),
    ).toBe(false);
    expect(
      decodes(GraphExploreParams, {
        version: 1,
        binding,
        graphType: "work",
        query: { mode: "neighbors", nodeId: "goal:root", offset: 0, limit: 100 },
      }),
    ).toBe(true);
  });

  it("route the explorer methods through the child envelope whitelist", () => {
    expect(isBranchSessionMethod("workbench.record.index")).toBe(true);
    expect(isBranchSessionMethod("workbench.record.body")).toBe(true);
    expect(isBranchSessionMethod("workbench.graph.explore")).toBe(true);
  });
});
