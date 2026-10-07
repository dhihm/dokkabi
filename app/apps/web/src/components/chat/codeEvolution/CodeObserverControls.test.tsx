// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import type { CodeObserverState } from "@t3tools/contracts";
import { CodeObserverControls } from "./CodeObserverControls";
const observer: CodeObserverState = {
  state: "paused",
  policyDigest: "a".repeat(64),
  paths: 2,
  checks: 256,
  reason: "check_limit",
  revision: 7,
  window: 0,
  lifetimeChecks: 256,
  retainedVersions: 4,
  retainedBytes: 1024,
  watcher: { mode: "selected_path_idle_poll", intervalMs: 5000, runtime: "suspended" },
};
function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = async (
  onResume: any,
  state: CodeObserverState | undefined = observer,
  disabled = false,
) => {
  await act(async () =>
    root.render(
      <StrictMode>
        <CodeObserverControls
          scopeKey="isolated-test-scope"
          observer={state}
          disabled={disabled}
          onResume={onResume}
        />
      </StrictMode>,
    ),
  );
};
const click = async () => {
  await act(async () => container.querySelector("button")!.click());
};
const applied = (request: any) => ({
  version: 1,
  state: "applied",
  receipt: { commandId: request.commandId, seq: 10, hash: "b".repeat(64) },
  observer: { ...observer, state: "active", reason: null, revision: 8 },
});
test("mounting does not resume; the explicit click sends one displayed revision and no quota reset", async () => {
  const onResume = vi.fn(async (request) => applied(request));
  await render(onResume);
  expect(onResume).not.toHaveBeenCalled();
  expect((container.querySelector("input") as HTMLInputElement).checked).toBe(false);
  await click();
  expect(onResume).toHaveBeenCalledTimes(1);
  expect(onResume.mock.calls[0]![0]).toMatchObject({
    operation: "resume",
    expectedRevision: 7,
    newWindow: false,
  });
  expect(container.textContent).toContain("Resume recorded at #10");
});
test("only an explicit checkbox grants a new check window", async () => {
  const onResume = vi.fn(async (request) => applied(request));
  await render(onResume);
  await act(async () => container.querySelector("input")!.click());
  await click();
  expect(onResume.mock.calls[0]![0].newWindow).toBe(true);
  expect((container.querySelector("input") as HTMLInputElement).checked).toBe(false);
});
test("storage exhaustion blocks reset and retains the readable-history explanation", async () => {
  const onResume = vi.fn();
  await render(onResume, { ...observer, reason: "retention_bytes_limit", retainedBytes: 67108864 });
  expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  expect((container.querySelector("input") as HTMLInputElement).disabled).toBe(true);
  expect(container.textContent).toContain("Retained history stays readable");
  await click();
  expect(onResume).not.toHaveBeenCalled();
});
test("legacy state offers no inferred recovery capability", async () => {
  await render(vi.fn(), {
    state: "paused",
    policyDigest: "a".repeat(64),
    paths: 2,
    checks: 256,
    reason: "check_limit",
  });
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Idle capture availability is unknown");
});
test("unknown delivery retains the exact command and reset choice for an explicit retry", async () => {
  const onResume = vi
    .fn()
    .mockRejectedValueOnce(new Error("lost response"))
    .mockImplementation(async (request) => applied(request));
  await render(onResume);
  await click();
  expect(container.textContent).toContain("Resume outcome unknown");
  expect((container.querySelector("input") as HTMLInputElement).disabled).toBe(true);
  await render(onResume, { ...observer, revision: 8 });
  await click();
  expect(onResume).toHaveBeenCalledTimes(2);
  expect(onResume.mock.calls[1]![0]).toEqual(onResume.mock.calls[0]![0]);
});
test("unconfirmed same-command receipt never claims applied", async () => {
  const onResume = vi.fn(async (request) => ({
    ...applied(request),
    receipt: { ...applied(request).receipt, commandId: "different" },
  }));
  await render(onResume);
  await click();
  expect(container.textContent).toContain("Resume outcome unknown");
  expect(container.textContent).not.toContain("Resume recorded");
});
test("pending clicks cannot dispatch duplicate commands", async () => {
  let complete!: (value: any) => void;
  const onResume = vi.fn(
    (_request: any) =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render(onResume);
  await act(async () => {
    container.querySelector("button")!.click();
    container.querySelector("button")!.click();
  });
  expect(onResume).toHaveBeenCalledTimes(1);
  await act(async () => complete(applied(onResume.mock.calls[0]![0])));
});
test("a stale or hidden index never grants resume", async () => {
  const onResume = vi.fn();
  await render(onResume, observer, true);
  await click();
  expect(onResume).not.toHaveBeenCalled();
});
test("uncertain intent survives unmount and remount with identical explicit reset payload", async () => {
  const onResume = vi
    .fn()
    .mockRejectedValueOnce(new Error("lost reply"))
    .mockImplementation(async (request) => applied(request));
  await render(onResume);
  await act(async () => container.querySelector("input")!.click());
  await click();
  const original = onResume.mock.calls[0]![0];
  await act(async () => root.render(null));
  await render(onResume, { ...observer, revision: 9 });
  expect(container.textContent).toContain("Retry same resume");
  expect((container.querySelector("input") as HTMLInputElement).checked).toBe(true);
  expect(onResume).toHaveBeenCalledTimes(1);
  await click();
  expect(onResume.mock.calls[1]![0]).toEqual(original);
});
test("applied receipt waits for a current observer projection before another distinct command", async () => {
  const onResume = vi.fn(async (request) => applied(request));
  await render(onResume);
  await click();
  expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  await click();
  expect(onResume).toHaveBeenCalledTimes(1);
  await render(onResume, { ...observer, revision: 8 });
  expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
});
test("an uncertain command remains available to reconcile while projection is missing", async () => {
  const onResume = vi
    .fn()
    .mockRejectedValueOnce(new Error("lost reply"))
    .mockImplementation(async (request) => applied(request));
  await render(onResume);
  await click();
  await act(async () =>
    root.render(
      <CodeObserverControls
        scopeKey="isolated-test-scope"
        observer={undefined}
        disabled={false}
        onResume={onResume}
      />,
    ),
  );
  expect(container.textContent).toContain("Retry same resume");
  await click();
  expect(onResume.mock.calls[1]![0]).toEqual(onResume.mock.calls[0]![0]);
});

test("storage refusal prevents dispatch instead of losing the command identity", async () => {
  const onResume = vi.fn();
  await render(onResume);
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await click();
  expect(onResume).not.toHaveBeenCalled();
  expect(container.textContent).toContain("No request was sent");
});

test.each(["busy", "conflict", "unsupported", "unavailable"] as const)(
  "an uncertain intent survives %s and remount until a matching applied receipt",
  async (negative) => {
    const onResume = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, state: "unknown", reason: "reply lost" })
      .mockResolvedValueOnce({ version: 1, state: negative, reason: "current host refusal" })
      .mockImplementation(async (request) => ({
        ...applied(request),
        observer: { ...observer, state: "active", reason: null, revision: 14 },
      }));
    const remove = vi.spyOn(window.localStorage, "removeItem");
    await render(onResume);
    await act(async () => container.querySelector("input")!.click());
    await click();
    const original = onResume.mock.calls[0]![0];
    await act(async () => root.render(null));
    await render(onResume, { ...observer, revision: 12 });
    expect(onResume).toHaveBeenCalledTimes(1);
    await click();
    expect(onResume.mock.calls[1]![0]).toEqual(original);
    expect(container.textContent).toContain("Resume remains unresolved");
    expect(container.textContent).toContain(`${negative}: current host refusal`);
    expect(remove).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    await render(onResume, { ...observer, revision: 13 });
    expect(container.textContent).toContain("Retry same resume");
    expect((container.querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(onResume).toHaveBeenCalledTimes(2);
    await click();
    expect(onResume.mock.calls[2]![0]).toEqual(original);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
    expect(container.textContent).toContain("Resume recorded at #10");
  },
);

test("a fresh first definite refusal can retire its intent", async () => {
  const onResume = vi.fn(async () => ({ version: 1, state: "busy", reason: "turn active" }));
  await render(onResume);
  await click();
  expect(window.localStorage.length).toBe(0);
  expect(container.textContent).toContain("busy: turn active");
  expect(container.textContent).not.toContain("Retry same resume");
});
