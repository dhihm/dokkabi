// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type QueryView = {
  data: unknown;
  dataUpdatedAt?: number | null;
  isSuccess?: boolean;
  error: string | null;
  isPending: boolean;
  refresh: () => void;
};

type DispatchedCommand = {
  readonly environmentId: EnvironmentId;
  readonly input: any;
};

interface DeferredDispatch {
  readonly value: DispatchedCommand;
  readonly resolve: (result: AtomCommandResult<any, any>) => void;
}

let currentQuery: QueryView = { data: null, error: null, isPending: false, refresh: vi.fn() };
let dispatchImpl: ((value: DispatchedCommand) => Promise<AtomCommandResult<any, any>>) | undefined;
let pendingDeferreds: DeferredDispatch[] = [];

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => currentQuery,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (value: DispatchedCommand) =>
    dispatchImpl === undefined
      ? Promise.resolve({ _tag: "Success", value: null } as AtomCommandResult<any, any>)
      : dispatchImpl(value),
}));

vi.mock("~/state/workbenchWorkMode", () => ({
  workbenchWorkModeAtomFor: () => null,
  workbenchWorkModeAction: {
    label: "environment-data:commands:provider:workbench-work-mode",
  },
  workbenchWorkModeScopeKey: (scope: {
    environmentId: unknown;
    threadId: unknown;
    providerInstanceId?: unknown;
  }) => JSON.stringify([scope.environmentId, scope.threadId, scope.providerInstanceId ?? null]),
}));

import { WorkbenchWorkModeControl } from "./WorkbenchWorkModeControl";

const hex64 = (seed: string): string => {
  const base = Array.from({ length: 8 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16),
  ).join("");
  return base.repeat(8);
};

const REVISION = hex64("revision");
const THREAD = "thread-wm-control" as unknown as ThreadId;

const availableQuery = (busy = false, revision = REVISION): QueryView => ({
  dataUpdatedAt: 1,
  isSuccess: true,
  data: {
    status: "available",
    selection: { mode: "default", effective: "chat", source: "default", revision },
    busy,
  },
  error: null,
  isPending: false,
  refresh: vi.fn(),
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatchImpl = undefined;
  pendingDeferreds = [];
  currentQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = async (
  threadId: ThreadId = THREAD,
  providerInstanceId?: ProviderInstanceId,
  environmentId = "environment-a" as EnvironmentId,
) => {
  await act(async () =>
    root.render(
      <WorkbenchWorkModeControl
        environmentId={environmentId}
        threadId={threadId}
        {...(providerInstanceId !== undefined ? { providerInstanceId } : {})}
      />,
    ),
  );
};

/** Record every dispatch through a controllable implementation. */
const recordDispatches = () => {
  const calls: DispatchedCommand[] = [];
  dispatchImpl = async (value) => {
    calls.push(value);
    return recordedResults.shift()?.() ?? success(null as never);
  };
  return calls;
};
let recordedResults: Array<() => AtomCommandResult<any, any>> = [];

/** Defer control of the set command's settlement to the test. */
const deferDispatch = () => {
  dispatchImpl = (value) =>
    new Promise<AtomCommandResult<any, any>>((resolve) => {
      pendingDeferreds.push({ value, resolve });
    });
};

const success = <A,>(value: A): AtomCommandResult<any, any> =>
  ({ _tag: "Success", value }) as AtomCommandResult<any, any>;
const interrupted = (): AtomCommandResult<never, unknown> =>
  ({ _tag: "Failure", cause: Cause.interrupt(1) }) as unknown as AtomCommandResult<never, unknown>;

const optionFor = (mode: string) =>
  container.querySelector(`[data-workbench-work-mode-option="${mode}"]`) as HTMLInputElement | null;

it("primary: uncertain selection stays disabled until a newer successful host read", async () => {
  currentQuery = availableQuery();
  await render();
  recordedResults = [() => success({ state: "unknown", reason: "intent has no durable receipt" })];
  const calls = recordDispatches();
  await act(async () => optionFor("work")!.click());
  expect(optionFor("chat")!.disabled).toBe(true);
  expect(calls).toHaveLength(1);
  currentQuery = { ...availableQuery(), dataUpdatedAt: 2 };
  await render();
  expect(optionFor("chat")!.disabled).toBe(false);
  expect(calls).toHaveLength(1);
});
it("primary: an unavailable refresh cannot enable mutations from its stale snapshot", async () => {
  currentQuery = { ...availableQuery(), error: "source unavailable", isSuccess: false };
  await render();
  expect(optionFor("work")!.disabled).toBe(true);
});
it("primary: two events before rerender still admit only one in-flight selection", async () => {
  currentQuery = availableQuery();
  await render();
  deferDispatch();
  await act(async () => {
    optionFor("work")!.click();
    optionFor("chat")!.click();
  });
  expect(pendingDeferreds).toHaveLength(1);
});
it("primary: interruption after dispatch remains visible uncertainty without repeating selection", async () => {
  currentQuery = availableQuery();
  await render();
  recordedResults = [() => interrupted()];
  const calls = recordDispatches();
  await act(async () => optionFor("work")!.click());
  expect(
    container
      .querySelector("[data-workbench-work-mode-result]")
      ?.getAttribute("data-workbench-work-mode-result"),
  ).toBe("unknown");
  expect(optionFor("chat")!.disabled).toBe(true);
  expect(calls).toHaveLength(1);
});
