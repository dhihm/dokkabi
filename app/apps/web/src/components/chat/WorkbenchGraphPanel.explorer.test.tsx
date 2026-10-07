// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WORKBENCH_GRAPH_SEARCH_MAX_LENGTH,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  current: null as null | ReturnType<
    typeof import("../recordExplorer/explorerFakeHooks.testFixtures").makeFakeExplorerHooks
  >,
  oldReads: 0,
}));
vi.mock("~/state/workbenchExplorer", () => ({
  useWorkbenchRecordIndex: (request: any) => fake.current!.hooks.useWorkbenchRecordIndex(request),
  useWorkbenchRecordBodyWindow: (request: any) =>
    fake.current!.hooks.useWorkbenchRecordBodyWindow(request),
  useWorkbenchRecordVerification: (request: any) =>
    fake.current!.hooks.useWorkbenchRecordVerification(request),
  useWorkbenchGraphExplore: (request: any) => fake.current!.hooks.useWorkbenchGraphExplore(request),
}));
// The old full-graph endpoint (v1, refuses beyond 512 nodes) is not the path.
vi.mock("~/state/workbenchGraph", async () => {
  const original = await vi.importActual<any>("~/state/workbenchGraph");
  return {
    ...original,
    workbenchGraphAtomFor: () => {
      fake.oldReads += 1;
      return null;
    },
  };
});
vi.mock("~/state/query", async () => {
  const original = await vi.importActual<any>("~/state/query");
  // One stable old-endpoint answer: the v1 refusal for a >512-node graph.
  const oldAnswer = {
    data: {
      status: "available",
      graph: {
        version: 1,
        graphType: "work",
        resnapshot: false,
        sessionCursor: {
          sessionId: "old",
          seq: 1,
          hash: "a".repeat(64),
          generation: "b".repeat(64),
        },
        gatewayCursor: { seq: 1, hash: "c".repeat(64), generation: "d".repeat(64) },
        graph: {
          state: "unavailable",
          mode: "on",
          revision: 1,
          digest: null,
          nodes: [],
          edges: [],
          waves: [],
          unscheduled: [],
          errors: ["The graph exceeds the 512 node display bound."],
          coverage: {
            status: "unavailable",
            totalNodes: 541,
            totalEdges: 594,
            omittedNodes: 541,
            omittedEdges: 594,
          },
        },
      },
    },
    dataUpdatedAt: 1,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  };
  return { ...original, useEnvironmentQuery: () => oldAnswer };
});
vi.mock("~/presentationStore", () => ({ usePresentationState: () => null }));
vi.mock("~/presentationSurfaceHooks", () => ({ usePresentationSurfaceRef: () => null }));

import { makeFakeExplorerSource } from "../recordExplorer/explorerFake.testFixtures";
import { makeFakeExplorerHooks } from "../recordExplorer/explorerFakeHooks.testFixtures";
import { WorkbenchGraphPanel } from "./WorkbenchGraphPanel";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
  fake.current = makeFakeExplorerHooks(makeFakeExplorerSource());
  fake.oldReads = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(threadId = "graph-thread") {
  await act(async () =>
    root.render(
      <WorkbenchGraphPanel
        environmentId={EnvironmentId.make("graph-env")}
        threadId={ThreadId.make(threadId)}
        providerInstanceId={ProviderInstanceId.make("graph-instance")}
        graphType="work"
        visible
      />,
    ),
  );
  await act(async () => {});
}
const q = (selector: string) => container.querySelector(selector);
const nodeIds = () =>
  [...container.querySelectorAll("[data-graph-node]")].map((node) =>
    node.getAttribute("data-graph-node"),
  );
async function click(selector: string) {
  const element = q(selector) as HTMLButtonElement | null;
  expect(element, selector).not.toBeNull();
  expect(element!.disabled, `${selector} disabled`).toBe(false);
  await act(async () => element!.click());
  await act(async () => {});
}
async function type(selector: string, value: string) {
  const input = q(selector) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const exploreReads = () => fake.current!.source.reads.filter((read) => read.method === "explore");

describe("bounded Work graph explorer", () => {
  it("pages a 541-node graph in bounded views until every node is reachable", async () => {
    await render();
    expect(fake.oldReads).toBe(0);
    const seen = new Set<string | null>();
    let pages = 0;
    for (;;) {
      const ids = nodeIds();
      expect(ids.length).toBeLessThanOrEqual(100);
      expect(container.querySelectorAll("[data-graph-edge]").length).toBeLessThanOrEqual(1536);
      for (const id of ids) seen.add(id);
      pages += 1;
      const next = q("[data-graph-page-next]") as HTMLButtonElement;
      if (next.disabled) break;
      await click("[data-graph-page-next]");
    }
    expect(pages).toBe(6);
    expect(seen.size).toBe(541);
    const summary = q("[data-graph-explore-summary]")!.textContent!;
    expect(summary).toContain("501–541");
    expect(summary).toContain("541");
    // Full recorded kind counts, not page counts.
    expect(q('[data-graph-count-kind="todo"]')?.textContent).toContain("135");
    await click("[data-graph-page-previous]");
    expect(q("[data-graph-explore-summary]")!.textContent).toContain("401–500");
  });

  it("searches literally and bounds the search input", async () => {
    await render();
    const input = q("[data-graph-search-input]") as HTMLInputElement;
    expect(input.maxLength).toBe(WORKBENCH_GRAPH_SEARCH_MAX_LENGTH);
    await type("[data-graph-search-input]", "n0012");
    await click("[data-graph-search-submit]");
    const ids = nodeIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id!.includes("n0012"))).toBe(true);
    expect(q("[data-graph-explore-summary]")!.textContent).toContain(`${ids.length} matched`);
    // Regex metacharacters are inert literals.
    await type("[data-graph-search-input]", ".*");
    await click("[data-graph-search-submit]");
    expect(nodeIds()).toEqual([]);
    expect(q("[data-graph-explore-summary]")!.textContent).toContain("0 matched");
    await click("[data-graph-back]");
    expect(nodeIds().every((id) => id!.includes("n0012"))).toBe(true);
  });

  it("keeps the neighbor anchor on every page and pages candidates without repeating it", async () => {
    await render();
    await act(async () => (q('[data-graph-node="goal:root"]') as HTMLButtonElement).click());
    await click("[data-graph-neighbors]");
    let ids = nodeIds();
    expect(ids).toContain("goal:root");
    expect(ids).toHaveLength(100);
    expect(q("[data-graph-explore-summary]")!.textContent).toContain("151 matched");
    const first = new Set(ids);
    await click("[data-graph-page-next]");
    ids = nodeIds();
    expect(ids).toContain("goal:root");
    expect(ids).toHaveLength(52);
    expect(ids.filter((id) => id !== "goal:root" && first.has(id))).toEqual([]);
    expect((q("[data-graph-page-next]") as HTMLButtonElement).disabled).toBe(true);
    await click("[data-graph-back]");
    await click("[data-graph-back]");
    expect(q("[data-graph-explore-summary]")!.textContent).toContain("1–100");
  });

  it("holds the snapshot across navigation and requires an explicit refresh after a change", async () => {
    await render();
    await click("[data-graph-page-next]");
    const before = nodeIds();
    fake.current!.source.bumpGraph();
    await act(async () => fake.current!.control.poll());
    expect(q("[data-graph-stale-snapshot]")).not.toBeNull();
    expect(nodeIds()).toEqual(before);
    expect(container.textContent).not.toContain("(v2)");
    await click("[data-graph-refresh]");
    expect(q("[data-graph-stale-snapshot]")).toBeNull();
    expect(container.textContent).toContain("(v2)");
    expect(q("[data-graph-explore-summary]")!.textContent).toContain("544");
  });

  it("retains selection and camera across a same-topology refresh and resets on scope change", async () => {
    await render();
    await act(async () => (q('[data-graph-node="goal:root"]') as HTMLButtonElement).click());
    await click('[aria-label="Zoom in"]');
    const world = () => (q("[data-graph-world]") as HTMLElement).style.transform;
    const zoomed = world();
    await act(async () => fake.current!.control.poll());
    expect(world()).toBe(zoomed);
    expect(q('[data-graph-node="goal:root"]')?.getAttribute("data-graph-selected")).toBe("true");
    await click("[data-graph-page-next]");
    await render("another-thread");
    expect(q("[data-graph-explore-summary]")!.textContent).toContain("1–100");
    expect(q('[data-graph-selected="true"]')).toBeNull();
  });

  it("bounds Back history", async () => {
    await render();
    for (let index = 0; index < 40; index += 1) {
      await type("[data-graph-search-input]", `n00${index % 10}`);
      await click("[data-graph-search-submit]");
    }
    let backs = 0;
    while (!(q("[data-graph-back]") as HTMLButtonElement).disabled) {
      await click("[data-graph-back]");
      backs += 1;
    }
    expect(backs).toBeLessThanOrEqual(32);
    expect(exploreReads().length).toBeGreaterThan(0);
  });

  it("an older gateway is honestly unsupported without the old oversized graph read", async () => {
    fake.current!.source.unsupported = true;
    await render();
    expect(container.textContent).toContain("unsupported");
    expect(fake.oldReads).toBe(0);
    expect(nodeIds()).toEqual([]);
  });
});
