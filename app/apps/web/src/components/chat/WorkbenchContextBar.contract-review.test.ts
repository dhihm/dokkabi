import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProviderWorkbenchOverview,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveWorkbenchOverviewBar, todoActivityOf } from "./WorkbenchContextBar.logic";
const threadId = ThreadId.make("independent-overview-ui");
const empty = { total: null, missing: 0, latestSource: null };
const overview: ProviderWorkbenchOverview = {
  version: 1,
  sessionCursor: { sessionId: "review", seq: 1, hash: "a".repeat(64), generation: "b".repeat(64) },
  gatewayCursor: { seq: 1, hash: "c".repeat(64), generation: "d".repeat(64) },
  resnapshot: false,
  work: {
    state: "available",
    goal: { id: "goal", statement: "Await execution", source: { seq: 1, hash: "a".repeat(64) } },
    planDigest: "e".repeat(64),
    todos: [
      { id: "ready", title: "Ready, not executing", class: "impl", state: "ready", priority: 1 },
    ],
    cases: { total: 1, green: 0, red: 0, pending: 1 },
    errors: [],
  },
  context: {
    state: "missing",
    mode: null,
    revision: null,
    digest: null,
    frame: null,
    lessonCount: null,
    errors: [],
  },
  usage: {
    records: 0,
    input: empty,
    output: empty,
    reasoning: empty,
    cacheRead: empty,
    cacheWrite: empty,
  },
};
describe("independent recorded overview UI semantics", () => {
  it("cached previous success with a live query error stays visibly stale", () => {
    const result = resolveWorkbenchOverviewBar({
      scopeKey: "independent-overview-ui-scope",
      query: {
        data: { status: "available", overview },
        error: "Controlled refresh failure",
        isPending: false,
      },
      retained: { scopeKey: "independent-overview-ui-scope", overview },
    });
    expect(result.kind).toBe("view");
    if (result.kind === "view") expect(result.staleError).toBe("Controlled refresh failure");
  });
  it("a ready TODO is not reported as currently running", () => {
    const result = todoActivityOf(overview);
    expect(result).not.toHaveProperty("running");
    expect(result).toMatchObject({ ready: 1, blocked: 0 });
  });
});

import { workbenchOverviewScopeKey } from "~/state/workbenchOverview";
it("retention scope key includes environment identity", () => {
  const scope = {
    environmentId: EnvironmentId.make("environment-one"),
    threadId,
    providerInstanceId: ProviderInstanceId.make("dokkabi"),
  };
  expect(workbenchOverviewScopeKey(scope)).not.toBe(
    workbenchOverviewScopeKey({ ...scope, environmentId: EnvironmentId.make("environment-two") }),
  );
});
