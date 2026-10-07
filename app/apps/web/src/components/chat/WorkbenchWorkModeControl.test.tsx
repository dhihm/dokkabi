// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type QueryView = {
  data: unknown;
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
const OTHER_THREAD = "thread-wm-other" as unknown as ThreadId;

const availableQuery = (busy = false, revision = REVISION): QueryView => ({
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

const settleLast = async (result: AtomCommandResult<any, any>) => {
  const deferred = pendingDeferreds.shift();
  expect(deferred).toBeDefined();
  await act(async () => deferred!.resolve(result));
};

const success = <A,>(value: A): AtomCommandResult<any, any> =>
  ({ _tag: "Success", value }) as AtomCommandResult<any, any>;
const failure = (message: string): AtomCommandResult<never, unknown> =>
  ({ _tag: "Failure", cause: Cause.fail(new Error(message)) }) as unknown as AtomCommandResult<
    never,
    unknown
  >;
const interrupted = (): AtomCommandResult<never, unknown> =>
  ({ _tag: "Failure", cause: Cause.interrupt(1) }) as unknown as AtomCommandResult<never, unknown>;

const optionFor = (mode: string) =>
  container.querySelector(`[data-workbench-work-mode-option="${mode}"]`) as HTMLInputElement | null;

it("renders the execution mode selector with the effective-mode text", async () => {
  currentQuery = availableQuery();
  await render();
  expect(
    container
      .querySelector("[data-workbench-work-mode-control]")
      ?.getAttribute("data-workbench-work-mode-control"),
  ).toBe("view");
  expect(container.textContent).toContain("Execution mode");
  expect(container.querySelector("[data-workbench-work-mode-effective]")?.textContent).toContain(
    "effective chat · standing default",
  );
  for (const mode of ["default", "chat", "work"]) {
    expect(optionFor(mode)).not.toBeNull();
  }
  expect(optionFor("default")?.checked).toBe(true);
  expect(optionFor("work")?.checked).toBe(false);
});

it("a host busy fact disables selection and explains it applies to new turns", async () => {
  currentQuery = availableQuery(true);
  await render();
  for (const mode of ["default", "chat", "work"]) {
    expect(optionFor(mode)?.disabled).toBe(true);
  }
  expect(container.textContent).toContain("new turns");
});

it("one explicit click dispatches exactly one set with the displayed revision", async () => {
  currentQuery = availableQuery();
  await render();
  recordedResults = [
    () =>
      success({
        state: "applied",
        commandId: "workmode-cmd-1",
        duplicate: false,
        selection: { mode: "work", effective: "work", source: "session", revision: REVISION },
      }),
  ];
  const calls = recordDispatches();
  await act(async () => {
    optionFor("work")!.click();
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.environmentId).toBe("environment-a");
  expect(calls[0]!.input.type).toBe("set");
  expect(calls[0]!.input.threadId).toBe(THREAD);
  expect(calls[0]!.input.mode).toBe("work");
  expect(calls[0]!.input.expectedRevision).toBe(REVISION);
  expect(calls[0]!.input.commandId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  // The receipt says what changed and that nothing was sent.
  expect(container.textContent).toContain("No message was sent");
  expect(
    container
      .querySelector("[data-workbench-work-mode-result]")
      ?.getAttribute("data-workbench-work-mode-result"),
  ).toBe("applied");
});

it("hides entirely for an unsupported provider", async () => {
  currentQuery = { ...availableQuery(), data: { status: "unsupported", reason: "none" } };
  await render();
  expect(container.querySelector("[data-workbench-work-mode-control]")).toBeNull();
});

it("an unavailable source renders an honest disabled state with its reason", async () => {
  currentQuery = {
    ...availableQuery(),
    data: { status: "unavailable", reason: "gateway not bound" },
  };
  await render();
  expect(
    container
      .querySelector("[data-workbench-work-mode-control]")
      ?.getAttribute("data-workbench-work-mode-control"),
  ).toBe("unavailable");
  expect(container.textContent).toContain("gateway not bound");
  expect(optionFor("work")).toBeNull();
});

it("a failed set reconciles ONLY through one same-id status and never re-sends", async () => {
  currentQuery = availableQuery();
  await render();
  recordedResults = [
    () => failure("transport lost"),
    () =>
      success({
        state: "applied",
        commandId: "reconciled",
        duplicate: true,
        selection: { mode: "chat", effective: "chat", source: "session", revision: REVISION },
      }),
  ];
  const calls = recordDispatches();
  await act(async () => {
    optionFor("chat")!.click();
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.input.type).toBe("set");
  expect(calls[1]!.input.type).toBe("status");
  expect(calls[1]!.input.commandId).toBe(calls[0]!.input.commandId);
  expect(calls.filter((call) => call.input.type === "set")).toHaveLength(1);
  expect(container.textContent).toContain("already recorded");
});

it("an interrupted set clears pending with visible uncertainty and no follow-up selection", async () => {
  currentQuery = availableQuery();
  await render();
  recordedResults = [() => interrupted()];
  const calls = recordDispatches();
  await act(async () => {
    optionFor("work")!.click();
  });
  expect(calls).toHaveLength(1);
  expect(
    container
      .querySelector("[data-workbench-work-mode-result]")
      ?.getAttribute("data-workbench-work-mode-result"),
  ).toBe("unknown");
  expect(optionFor("work")?.disabled).toBe(true);
});

it("an unknown outcome is surfaced without a silently issued new command", async () => {
  currentQuery = availableQuery();
  await render();
  recordedResults = [
    () => success({ state: "unknown", reason: "the durable mode intent never settled" }),
  ];
  const calls = recordDispatches();
  await act(async () => {
    optionFor("work")!.click();
  });
  expect(calls).toHaveLength(1);
  expect(
    container
      .querySelector("[data-workbench-work-mode-result]")
      ?.getAttribute("data-workbench-work-mode-result"),
  ).toBe("unknown");
  expect(container.textContent).toContain("never settled");
});

it("a scope change fences a late reply: no state write from the old scope", async () => {
  currentQuery = availableQuery();
  await render();
  deferDispatch();
  await act(async () => {
    optionFor("work")!.click();
  });
  expect(pendingDeferreds).toHaveLength(1);
  // Switch the conversation before the reply arrives.
  await render(OTHER_THREAD, undefined);
  await settleLast(
    success({
      state: "applied",
      commandId: "workmode-cmd-late",
      duplicate: false,
      selection: { mode: "work", effective: "work", source: "session", revision: REVISION },
    }),
  );
  // The late reply wrote nothing: no outcome or busy state from the old scope.
  expect(container.querySelector("[data-workbench-work-mode-result]")).toBeNull();
  expect(container.querySelector("[data-workbench-work-mode-state]")).toBeNull();
  // The new scope renders its own surface for its own thread.
  expect(
    container.querySelector("[data-workbench-work-mode-control]")?.getAttribute("data-thread-id"),
  ).toBe(OTHER_THREAD);
});

it("selection is disabled while a set is pending and re-enabled after", async () => {
  currentQuery = availableQuery();
  await render();
  deferDispatch();
  await act(async () => {
    optionFor("work")!.click();
  });
  for (const mode of ["default", "chat", "work"]) {
    expect(optionFor(mode)?.disabled).toBe(true);
  }
  expect(
    container
      .querySelector("[data-workbench-work-mode-state]")
      ?.getAttribute("data-workbench-work-mode-state"),
  ).toBe("busy");
  await settleLast(
    success({
      state: "applied",
      commandId: "workmode-cmd-pending",
      duplicate: false,
      selection: { mode: "work", effective: "work", source: "session", revision: REVISION },
    }),
  );
  for (const mode of ["default", "chat", "work"]) {
    expect(optionFor(mode)?.disabled).toBe(false);
  }
});

it("an unmount with a pending click never writes state", async () => {
  currentQuery = availableQuery();
  await render();
  deferDispatch();
  await act(async () => {
    optionFor("work")!.click();
  });
  const deferred = pendingDeferreds.shift()!;
  await act(async () => root.unmount());
  await act(async () =>
    deferred.resolve(
      success({
        state: "applied",
        commandId: "workmode-cmd-unmount",
        duplicate: false,
        selection: { mode: "work", effective: "work", source: "session", revision: REVISION },
      }),
    ),
  );
  expect(container.textContent).toBe("");
});
