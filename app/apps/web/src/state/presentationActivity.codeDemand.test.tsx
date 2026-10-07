// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import fixture from "../components/chat/codeEvolution/retained.fixture.json";
const index = { ...fixture, body: null };
const indexResponse = { status: "available", code: index };
const bodyResponse = { status: "available", code: fixture };

const demand = vi.hoisted(() => ({
  index: { lane: "index" },
  body: { lane: "body" },
  indexAtom: vi.fn(),
  bodyAtom: vi.fn(),
  queries: [] as unknown[],
}));
vi.mock("./workbenchCode", () => ({
  codeScopeKey: () => "code-test-scope",
  workbenchCodeIndexAtomFor: demand.indexAtom,
  workbenchCodeBodyAtomFor: demand.bodyAtom,
  workbenchCodeAction: {},
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    demand.queries.push(atom);
    return {
      data: atom === null ? null : atom === demand.index ? indexResponse : bodyResponse,
      error: null,
      isPending: false,
      isSuccess: atom !== null,
      refresh: () => {},
    };
  },
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../components/chat/codeEvolution/CodeCanvas", () => ({ CodeCanvas: () => null }));
import { WorkbenchCodePanel } from "../components/chat/WorkbenchCodePanel";

test("Code retains selection/picture but releases both index and selected body demand on native inactivity", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  demand.indexAtom.mockImplementation(() => demand.index);
  demand.bodyAtom.mockImplementation(() => demand.body);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <WorkbenchCodePanel
          environmentId={"environment-a" as EnvironmentId}
          threadId={"thread-a" as ThreadId}
          visible
        />,
      ),
    );
    expect(demand.indexAtom).toHaveBeenCalled();
    expect(demand.bodyAtom).toHaveBeenCalled();
    const selection = container.querySelector("select")!.value;
    const bodyDigest = container
      .querySelector("[data-code-body-digest]")!
      .getAttribute("data-code-body-digest");
    demand.indexAtom.mockClear();
    demand.bodyAtom.mockClear();
    demand.queries.length = 0;
    focused = false;
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(demand.indexAtom).not.toHaveBeenCalled();
    expect(demand.bodyAtom).not.toHaveBeenCalled();
    expect(demand.queries.length).toBeGreaterThan(0);
    expect(demand.queries.every((atom) => atom === null)).toBe(true);
    expect(container.textContent).toContain("Paused retained view");
    expect(container.querySelector("select")!.value).toBe(selection);
    expect(
      container.querySelector("[data-code-body-digest]")!.getAttribute("data-code-body-digest"),
    ).toBe(bodyDigest);
    focused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(demand.indexAtom).toHaveBeenCalled();
    expect(demand.bodyAtom).toHaveBeenCalled();
    expect(container.querySelector("select")!.value).toBe(selection);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
