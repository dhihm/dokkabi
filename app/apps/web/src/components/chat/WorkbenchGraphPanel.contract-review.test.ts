import { describe, expect, it } from "vite-plus/test";
import type { ProviderWorkbenchGraph } from "@t3tools/contracts";
import { resolveWorkbenchGraphPanel } from "./WorkbenchGraphPanel.logic";

const original: ProviderWorkbenchGraph = {
  version: 1,
  graphType: "work",
  resnapshot: false,
  sessionCursor: {
    sessionId: "review-source",
    seq: 10,
    hash: "a".repeat(64),
    generation: "b".repeat(64),
  },
  gatewayCursor: { seq: 6, hash: "c".repeat(64), generation: "d".repeat(64) },
  graph: {
    state: "missing",
    mode: null,
    revision: null,
    digest: null,
    nodes: [],
    edges: [],
    waves: [],
    unscheduled: [],
    errors: [],
    coverage: {
      status: "complete",
      totalNodes: 0,
      totalEdges: 0,
      omittedNodes: 0,
      omittedEdges: 0,
    },
  },
};
const rejectReplacement = (incoming: ProviderWorkbenchGraph): void => {
  const state = resolveWorkbenchGraphPanel({
    scopeKey: "same-source",
    retained: { scopeKey: "same-source", graph: original },
    query: { data: { status: "available", graph: incoming }, error: null, isPending: false },
  });
  expect(state.kind).toBe("view");
  if (state.kind !== "view")
    throw new Error("A retained valid view must remain inspectable and stale");
  expect(state.graph).toBe(original);
  expect(state.staleError).not.toBeNull();
};

describe("independent retained graph source boundaries", () => {
  it("rejects a session head rewind even when projection digest is unchanged", () => {
    rejectReplacement({
      ...original,
      sessionCursor: { ...original.sessionCursor, seq: 9, hash: "e".repeat(64) },
    });
  });
  it("rejects divergent same-sequence session hashes", () => {
    rejectReplacement({
      ...original,
      sessionCursor: { ...original.sessionCursor, hash: "f".repeat(64) },
    });
  });
  it("validates the independent gateway head too", () => {
    rejectReplacement({
      ...original,
      gatewayCursor: { ...original.gatewayCursor, seq: 5, hash: "e".repeat(64) },
    });
  });
  it("a generation replacement cannot be made fresh by resnapshot", () => {
    rejectReplacement({
      ...original,
      resnapshot: true,
      sessionCursor: { ...original.sessionCursor, generation: "e".repeat(64) },
    });
  });
  it("an explicit different scope starts without its predecessor's retention", () => {
    const next = {
      ...original,
      sessionCursor: {
        ...original.sessionCursor,
        sessionId: "new-source",
        generation: "e".repeat(64),
      },
    };
    const state = resolveWorkbenchGraphPanel({
      scopeKey: "new-scope",
      retained: { scopeKey: "old-scope", graph: original },
      query: { data: { status: "available", graph: next }, error: null, isPending: false },
    });
    expect(state.kind).toBe("view");
    if (state.kind === "view") {
      expect(state.graph).toBe(next);
      expect(state.staleError).toBeNull();
    }
  });
});

it("an available label without a payload cannot become a rendered graph", () => {
  const state = resolveWorkbenchGraphPanel({
    scopeKey: "empty",
    retained: null,
    query: { data: { status: "available" }, error: null, isPending: false },
  });
  expect(state.kind).toBe("unavailable");
});
