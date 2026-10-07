import { expect, test } from "vite-plus/test";
import { codeObserverLabel } from "./observerLabel";
test("legacy producer state is unknown while recorded pause and active coverage are explicit", () => {
  expect(codeObserverLabel(undefined)).toBe("Producer state unknown (legacy host)");
  expect(
    codeObserverLabel({ state: "off", paths: 0, checks: 0, reason: null, policyDigest: null }),
  ).toBe("Automatic capture off");
  expect(
    codeObserverLabel({
      state: "active",
      paths: 3,
      checks: 9,
      reason: null,
      policyDigest: "a".repeat(64),
    }),
  ).toBe("Automatic capture active · 3 selected paths · 9/256 checks");
  expect(
    codeObserverLabel({
      state: "paused",
      paths: 3,
      checks: 256,
      reason: "check_limit",
      policyDigest: "a".repeat(64),
    }),
  ).toBe("Automatic capture paused · check_limit · retained history stays readable");
});
test("shows recorded idle availability and lifetime storage counters", () => {
  const label = codeObserverLabel({
    state: "paused",
    paths: 3,
    checks: 256,
    reason: "check_limit",
    policyDigest: "a".repeat(64),
    revision: 7,
    window: 2,
    lifetimeChecks: 512,
    retainedVersions: 4,
    retainedBytes: 1024,
    watcher: { mode: "selected_path_idle_poll", intervalMs: 5000, runtime: "suspended" },
  } as never);
  expect(label).toContain("idle capture suspended");
  expect(label).toContain("revision 7");
  expect(label).toContain("window 2");
  expect(label).toContain("256/256 checks");
  expect(label).toContain("512 lifetime checks");
  expect(label).toContain("4/32 retained versions");
  expect(label).toContain("1024/67108864 retained bytes");
});
