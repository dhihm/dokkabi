import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ProviderWorkbenchGraph, ProviderWorkbenchGraphResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workbenchGraphScopeKey } from "~/state/workbenchGraph";
import {
  coverageLabel,
  graphHeadContinuityError,
  nodeKindLabel,
  resolveWorkbenchGraphPanel,
  type RetainedWorkbenchGraph,
} from "./WorkbenchGraphPanel.logic";

/**
 * R4 graph panel resolver scenarios (docs/internals/dokkabi-graphs-r4.md):
 * explicit unsupported/unavailable states; an available envelope without a
 * payload is refused; same-scope failures keep the last valid graph labeled
 * stale; hidden panels stop polling but keep their retained view; retention
 * never crosses scopes. (The primary's contract-review suite owns the
 * head-rewind/generation quarantine cases.)
 */

const hex64 = (seed: string): string => {
  const base = Array.from({ length: 8 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16),
  ).join("");
  return base.repeat(8);
};

const THREAD = ThreadId.make("thread-graph-1");

const graph = (overrides: Partial<ProviderWorkbenchGraph> = {}): ProviderWorkbenchGraph => ({
  version: 1,
  graphType: "work",
  resnapshot: false,
  sessionCursor: {
    sessionId: "source-1",
    seq: 10,
    hash: hex64("shead"),
    generation: hex64("sgen"),
  },
  gatewayCursor: { seq: 5, hash: hex64("ghead"), generation: hex64("ggen") },
  graph: {
    state: "available",
    mode: "on",
    revision: 3,
    digest: hex64("digest"),
    nodes: [
      {
        id: "goal:1",
        kind: "goal",
        label: "Ship the recorded graph panel",
        status: null,
        provenance: "canonical",
        sources: [{ seq: 2, hash: hex64("goal") }],
        details: [],
        bodyDigest: null,
      },
    ],
    edges: [],
    waves: [],
    unscheduled: [],
    coverage: {
      status: "complete",
      totalNodes: 1,
      totalEdges: 0,
      omittedNodes: 0,
      omittedEdges: 0,
    },
    errors: [],
  },
  ...overrides,
});

const available = (data: ProviderWorkbenchGraph): ProviderWorkbenchGraphResult => ({
  status: "available",
  graph: data,
});

const SCOPE = workbenchGraphScopeKey({
  environmentId: EnvironmentId.make("env"),
  threadId: THREAD,
  graphType: "work",
  providerInstanceId: undefined,
});

const retainedOf = (data: ProviderWorkbenchGraph): RetainedWorkbenchGraph => ({
  scopeKey: SCOPE,
  graph: data,
});

describe("WorkbenchGraphPanel resolver", () => {
  it("is pending while the first read is in flight", () => {
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: { data: null, error: null, isPending: true },
        retained: null,
      }),
    ).toEqual({ kind: "pending" });
  });

  it("renders an explicit unavailable state, never an empty success", () => {
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: {
          data: { status: "unavailable", reason: "binding detached" },
          error: null,
          isPending: false,
        },
        retained: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "binding detached" });
  });

  it("renders an explicit unsupported state for capability-less providers", () => {
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: { data: { status: "unsupported" }, error: null, isPending: false },
        retained: null,
      }),
    ).toEqual({
      kind: "unsupported",
      reason: "This provider has no recorded graph capability.",
    });
  });

  it("refuses an available envelope that carries no graph payload", () => {
    const state = resolveWorkbenchGraphPanel({
      scopeKey: SCOPE,
      query: { data: { status: "available" }, error: null, isPending: false },
      retained: null,
    });
    expect(state.kind).toBe("unavailable");
    if (state.kind === "unavailable") {
      expect(state.reason).toContain("without a payload");
    }
  });

  it("renders a fresh success without a stale label", () => {
    const fresh = graph();
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: { data: available(fresh), error: null, isPending: false },
        retained: null,
      }),
    ).toEqual({ kind: "view", graph: fresh, staleError: null });
  });

  it("keeps the same scope's retained graph through a failed refresh, labeled stale", () => {
    const retained = retainedOf(graph());
    const state = resolveWorkbenchGraphPanel({
      scopeKey: SCOPE,
      query: { data: available(retained.graph), error: "transport lost", isPending: false },
      retained,
    });
    expect(state).toEqual({ kind: "view", graph: retained.graph, staleError: "transport lost" });
  });

  it("a failed first read is unavailable, not a silent empty panel", () => {
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: { data: null, error: "auth rejected", isPending: false },
        retained: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "auth rejected" });
  });

  it("never renders another scope's retention", () => {
    const state = resolveWorkbenchGraphPanel({
      scopeKey: SCOPE,
      query: { data: null, error: null, isPending: true },
      retained: { scopeKey: "another-scope", graph: graph() },
    });
    expect(state).toEqual({ kind: "pending" });
  });

  it("a hidden panel keeps its retained view without polling and without a stale label", () => {
    const retained = retainedOf(graph());
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: { data: null, error: null, isPending: false },
        retained,
        subscribed: false,
      }),
    ).toEqual({ kind: "view", graph: retained.graph, staleError: null });
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: { data: null, error: null, isPending: false },
        retained: null,
        subscribed: false,
      }),
    ).toEqual({ kind: "pending" });
  });

  it("accepts an advanced session head as fresh (reads never rewind, but may advance)", () => {
    const advanced = graph({
      sessionCursor: {
        sessionId: "source-1",
        seq: 11,
        hash: hex64("shead2"),
        generation: hex64("sgen"),
      },
    });
    expect(
      resolveWorkbenchGraphPanel({
        scopeKey: SCOPE,
        query: { data: available(advanced), error: null, isPending: false },
        retained: retainedOf(graph()),
      }),
    ).toEqual({ kind: "view", graph: advanced, staleError: null });
  });
});

describe("graph display vocabularies", () => {
  it("maps every closed node kind to a readable label", () => {
    expect(nodeKindLabel("goal")).toBe("Goal");
    expect(nodeKindLabel("unavailable_reference")).toBe("Unavailable reference");
  });

  it("coverage labels expose omitted totals explicitly", () => {
    expect(
      coverageLabel({
        status: "partial",
        totalNodes: 9,
        totalEdges: 4,
        omittedNodes: 2,
        omittedEdges: 1,
      }),
    ).toContain("omitted 2 nodes, 1 edges");
    expect(
      coverageLabel({
        status: "complete",
        totalNodes: 3,
        totalEdges: 2,
        omittedNodes: 0,
        omittedEdges: 0,
      }),
    ).not.toContain("omitted");
  });

  it("continuity accepts an unchanged head pair", () => {
    expect(graphHeadContinuityError(graph(), graph())).toBeNull();
  });
});
