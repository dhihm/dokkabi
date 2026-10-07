// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
  readCodeObserverIntent,
  retainCodeObserverIntent,
  clearCodeObserverIntent,
} from "./workbenchCodeIntent";
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

const request = {
  operation: "resume" as const,
  commandId: "resume-1",
  expectedRevision: 7,
  newWindow: false,
};
beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
  vi.restoreAllMocks();
});
test("retains exact unresolved intent across reads and isolates environment/thread/provider scope", () => {
  retainCodeObserverIntent("scope-a", request);
  expect(readCodeObserverIntent("scope-a")).toEqual({ kind: "pending", request });
  expect(readCodeObserverIntent("scope-b")).toEqual({ kind: "none" });
  retainCodeObserverIntent("scope-a", request);
  clearCodeObserverIntent("scope-a", request);
  expect(readCodeObserverIntent("scope-a")).toEqual({ kind: "none" });
});
test("another command cannot replace or clear unresolved intent", () => {
  retainCodeObserverIntent("scope-a", request);
  const other = { ...request, commandId: "resume-2" };
  expect(() => retainCodeObserverIntent("scope-a", other)).toThrow();
  expect(() => clearCodeObserverIntent("scope-a", other)).toThrow();
  expect(readCodeObserverIntent("scope-a")).toEqual({ kind: "pending", request });
});
test("corrupt or unavailable persisted identity never authorizes a new command", () => {
  window.localStorage.setItem(
    "dokkabi-code-observer-pending-v1:scope-a",
    JSON.stringify({ version: 1, request: { ...request, sessionId: "unowned" } }),
  );
  expect(readCodeObserverIntent("scope-a")).toEqual({ kind: "unavailable" });
  expect(() => retainCodeObserverIntent("scope-a", request)).toThrow();
});
