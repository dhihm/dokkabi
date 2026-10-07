// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  type ProviderWorkbenchGraph,
} from "@t3tools/contracts";
const state = vi.hoisted(() => ({ query: {} as any, presentation: null as any }));
// The panel reads bounded explore pages; this fixture is one complete page.
vi.mock("~/state/workbenchExplorer", () => ({ useWorkbenchGraphExplore: () => state.query }));
vi.mock("~/state/workbenchGraph", () => ({
  workbenchGraphScopeKey: () => "layout-test",
}));
vi.mock("~/presentationStore", () => ({ usePresentationState: () => state.presentation }));
vi.mock("~/presentationSurfaceHooks", () => ({ usePresentationSurfaceRef: () => null }));
vi.mock("./graphLayout", async (load) => {
  const actual = await load<typeof import("./graphLayout")>();
  return { ...actual, layoutGraph: vi.fn(actual.layoutGraph) };
});
import { layoutGraph } from "./graphLayout";
import { WorkbenchGraphPanel } from "./WorkbenchGraphPanel";
let root: Root;
let container: HTMLDivElement;
let graph: ProviderWorkbenchGraph;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.presentation = null;
  graph = {
    version: 1,
    graphType: "work",
    resnapshot: false,
    sessionCursor: {
      sessionId: "isolated-layout",
      seq: 1,
      hash: "a".repeat(64),
      generation: "b".repeat(64),
    },
    gatewayCursor: { seq: 1, hash: "c".repeat(64), generation: "d".repeat(64) },
    graph: {
      state: "available",
      mode: "on",
      revision: 1,
      digest: "e".repeat(64),
      nodes: ["a", "b"].map((id) => ({
        id,
        kind: "goal",
        label: id,
        status: null,
        provenance: "canonical",
        sources: [],
        details: [],
        bodyDigest: null,
      })),
      edges: [{ id: "edge", from: "a", to: "b", kind: "contains", artifact: null, sources: [] }],
      waves: [],
      unscheduled: [],
      errors: [],
      coverage: {
        status: "complete",
        totalNodes: 2,
        totalEdges: 1,
        omittedNodes: 0,
        omittedEdges: 0,
      },
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(layoutGraph).mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function explorePage(source: ProviderWorkbenchGraph) {
  return {
    version: 1,
    state: "available",
    graphType: source.graphType,
    sessionCursor: source.sessionCursor,
    gatewayCursor: source.gatewayCursor,
    snapshot: {
      sessionCursor: source.sessionCursor,
      digest: source.graph.digest ?? "e".repeat(64),
    },
    query: { mode: "page", offset: 0, limit: 100 },
    nextOffset: null,
    graph: source.graph,
    counts: { byKind: {}, byStatus: {} },
    matchedNodes: source.graph.nodes.length,
  };
}
async function render() {
  state.query = {
    data: { status: "available", explore: explorePage(graph) },
    error: null,
    isPending: false,
    refresh: () => {},
  };
  await act(async () =>
    root.render(
      <WorkbenchGraphPanel
        environmentId={EnvironmentId.make("isolated")}
        threadId={ThreadId.make("layout")}
        graphType={graph.graphType}
        visible
      />,
    ),
  );
}
test("new cursor/status/label/evidence render without repeating identical layout", async () => {
  await render();
  expect(layoutGraph).toHaveBeenCalledTimes(1);
  graph = {
    ...graph,
    sessionCursor: { ...graph.sessionCursor, seq: 2, hash: "f".repeat(64) },
    graph: {
      ...graph.graph,
      revision: 2,
      nodes: graph.graph.nodes.map((n) => ({ ...n, label: `updated ${n.id}`, status: "green" })),
    },
  };
  await render();
  // A new snapshot is explicit stale until Refresh; then the same topology
  // renders its new labels/status without another layout.
  expect(container.querySelector("[data-graph-stale-snapshot]")).not.toBeNull();
  await act(async () =>
    (container.querySelector("[data-graph-refresh]") as HTMLButtonElement).click(),
  );
  expect(container.textContent).toContain("updated a");
  expect(layoutGraph).toHaveBeenCalledTimes(1);
});

test("node kind/order, edge endpoints, graph type and each geometry input invalidate layout", async () => {
  await render();
  let calls = 1;
  graph = {
    ...graph,
    graph: { ...graph.graph, nodes: graph.graph.nodes.map((n) => ({ ...n, kind: "todo" })) },
  };
  await render();
  expect(layoutGraph).toHaveBeenCalledTimes(++calls);
  graph = { ...graph, graph: { ...graph.graph, nodes: [...graph.graph.nodes].reverse() } };
  await render();
  expect(layoutGraph).toHaveBeenCalledTimes(++calls);
  graph = {
    ...graph,
    graph: {
      ...graph.graph,
      edges: graph.graph.edges.map((e) => ({ ...e, from: e.to, to: e.from })),
    },
  };
  await render();
  expect(layoutGraph).toHaveBeenCalledTimes(++calls);
  graph = { ...graph, graphType: "context" };
  await render();
  expect(layoutGraph).toHaveBeenCalledTimes(++calls);
  let geometry = { ...PRESENTATION_GRAPH_LAYOUT_DEFAULTS };
  for (const key of [
    "nodeWidth",
    "nodeHeight",
    "rankGap",
    "siblingGap",
    "canvasPadding",
  ] as const) {
    geometry = { ...geometry, [key]: geometry[key] + 1 };
    state.presentation = { config: { layout: { graph: geometry } } };
    await render();
    expect(layoutGraph).toHaveBeenCalledTimes(++calls);
  }
  geometry = { ...geometry, direction: geometry.direction === "LR" ? "TB" : "LR" };
  state.presentation = { config: { layout: { graph: geometry } } };
  await render();
  expect(layoutGraph).toHaveBeenCalledTimes(++calls);
  expect(container.querySelectorAll("[data-graph-node]")).toHaveLength(2);
});
