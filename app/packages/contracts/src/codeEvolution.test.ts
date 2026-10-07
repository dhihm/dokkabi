import { expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CodeObserverState } from "./codeEvolution.ts";
const decodeObserver = Schema.decodeUnknownSync(CodeObserverState, { onExcessProperty: "error" });
const extended = {
  state: "paused",
  policyDigest: "a".repeat(64),
  paths: 3,
  checks: 256,
  reason: "check_limit",
  revision: 7,
  window: 2,
  lifetimeChecks: 512,
  retainedVersions: 4,
  retainedBytes: 1024,
  watcher: { mode: "selected_path_idle_poll", intervalMs: 5000, runtime: "suspended" },
};
test("accepts complete recorded observer counters and watcher", () => {
  expect(decodeObserver(extended)).toEqual(extended);
});
test("legacy omission stays valid while partial, unsafe and inconsistent projections refuse", () => {
  const decode = decodeObserver;
  expect(
    decode({ state: "off", policyDigest: null, paths: 0, checks: 0, reason: null }).state,
  ).toBe("off");
  for (const change of [
    { window: undefined },
    { lifetimeChecks: 255 },
    { retainedBytes: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { watcher: { ...extended.watcher, intervalMs: 1000 } },
    { watcher: { ...extended.watcher, runtime: "active" } },
  ]) {
    expect(() => decode({ ...extended, ...change })).toThrow();
  }
});
test("default RPC decoding rejects client-chosen authority fields", async () => {
  const { ProviderWorkbenchCodeActionInput } = await import("./codeEvolution.ts");
  const decode = Schema.decodeUnknownSync(ProviderWorkbenchCodeActionInput);
  const input = {
    threadId: "thread-1",
    operation: "resume",
    commandId: "resume-1",
    expectedRevision: 7,
    newWindow: false,
  };
  expect(decode(input)).toMatchObject({ newWindow: false });
  for (const extra of [
    { root: "/source" },
    { sessionId: "other" },
    { binding: {} },
    { token: "not-a-secret-fixture" },
  ])
    expect(() => decode({ ...input, ...extra })).toThrow();
});
