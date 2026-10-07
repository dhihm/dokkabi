// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type {
  CodeObserverState,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import fixture from "./codeEvolution/retained.fixture.json";

const state = vi.hoisted(() => ({
  query: { data: null as any, error: null as string | null, refresh: vi.fn() },
  dispatch: vi.fn(),
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => state.query }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.dispatch }));
import { WorkbenchCodePanel } from "./WorkbenchCodePanel";
const observer: CodeObserverState = {
  state: "paused",
  policyDigest: "a".repeat(64),
  paths: 1,
  checks: 256,
  reason: "check_limit",
  revision: 7,
  window: 0,
  lifetimeChecks: 256,
  retainedVersions: 0,
  retainedBytes: 0,
  watcher: { mode: "selected_path_idle_poll", intervalMs: 5000, runtime: "suspended" },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      get length() {
        return values.size;
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.query = {
    data: { status: "available", code: { ...fixture, body: null, versions: [], observer } },
    error: null,
    refresh: vi.fn(),
  };
  state.dispatch.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = async (threadId = "thread-a", visible = true) => {
  await act(async () =>
    root.render(
      <WorkbenchCodePanel
        environmentId={"environment-a" as EnvironmentId}
        threadId={threadId as ThreadId}
        providerInstanceId={"provider-a" as ProviderInstanceId}
        visible={visible}
      />,
    ),
  );
};
const resume = async () => {
  const button = [...container.querySelectorAll("button")].find(
    (button) =>
      button.textContent === "Resume capture" || button.textContent === "Retry same resume",
  )!;
  await act(async () => button.click());
};
test("the visible explicit control dispatches through the environment command and refreshes only a confirmed receipt", async () => {
  state.dispatch.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      version: 1,
      state: "applied",
      receipt: { commandId: input.commandId, seq: 10, hash: "b".repeat(64) },
      observer: { ...observer, state: "active", reason: null, revision: 8 },
    },
  }));
  await render();
  expect(container.textContent).toContain("idle capture suspended");
  expect(state.dispatch).not.toHaveBeenCalled();
  await resume();
  expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
    environmentId: "environment-a",
    input: {
      threadId: "thread-a",
      operation: "resume",
      commandId: expect.any(String),
      expectedRevision: 7,
      newWindow: false,
    },
  });
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Resume recorded at #10");
});
test("transport failure does not refresh and remount explicitly retries the same thread-bound intent", async () => {
  state.dispatch.mockResolvedValue({ _tag: "Failure" });
  await render();
  await resume();
  const first = state.dispatch.mock.calls[0]![0];
  expect(state.query.refresh).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await render();
  expect(state.dispatch).toHaveBeenCalledTimes(1);
  await resume();
  expect(state.dispatch.mock.calls[1]![0]).toEqual(first);
  await render("thread-b");
  expect(container.textContent).not.toContain("Retry same resume");
});
test("a hidden Code surface grants no resume admission", async () => {
  await render("thread-a", false);
  await resume();
  expect(state.dispatch).not.toHaveBeenCalled();
});

test("a foreign applied receipt does not refresh or retire the pending command", async () => {
  state.dispatch.mockResolvedValue({
    _tag: "Success",
    value: {
      version: 1,
      state: "applied",
      receipt: { commandId: "foreign-command", seq: 10, hash: "b".repeat(64) },
      observer: { ...observer, state: "active", reason: null, revision: 8 },
    },
  });
  await render();
  await resume();
  expect(state.query.refresh).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Resume outcome unknown");
  const request = state.dispatch.mock.calls[0]![0];
  await resume();
  expect(state.dispatch.mock.calls[1]![0]).toEqual(request);
});

test.each(["busy", "conflict"] as const)(
  "an unknown panel intent survives %s and cold control remount until matching receipt refresh",
  async (negative) => {
    state.dispatch
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { version: 1, state: "unknown", reason: "reply lost" },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { version: 1, state: negative, reason: "host cannot settle the earlier command" },
      })
      .mockImplementation(async ({ input }) => ({
        _tag: "Success",
        value: {
          version: 1,
          state: "applied",
          receipt: { commandId: input.commandId, seq: 10, hash: "b".repeat(64) },
          observer: { ...observer, state: "active", reason: null, revision: 8 },
        },
      }));
    await render();
    await resume();
    const original = state.dispatch.mock.calls[0]![0];
    await act(async () => root.render(null));
    await render();
    await resume();
    expect(state.query.refresh).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Resume remains unresolved");
    expect(container.textContent).toContain(negative);
    await act(async () => root.render(null));
    await render();
    expect(state.dispatch).toHaveBeenCalledTimes(2);
    await resume();
    expect(state.dispatch.mock.calls.map(([request]) => request)).toEqual([
      original,
      original,
      original,
    ]);
    expect(state.query.refresh).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
    expect(container.textContent).toContain("Resume recorded at #10");
  },
);
