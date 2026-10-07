import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { workbenchRecordScopeKey, type WorkbenchRecordScope } from "~/state/workbenchRecord";

const after = { seq: 50, hash: "a".repeat(64), generation: "b".repeat(64) };
const asOf = {
  sessionId: "source-parent",
  seq: 100,
  hash: "c".repeat(64),
  generation: after.generation,
};
const scope: WorkbenchRecordScope = {
  environmentId: EnvironmentId.make("env-reader"),
  threadId: ThreadId.make("thread-reader"),
  providerInstanceId: ProviderInstanceId.make("instance-reader"),
  limit: 50,
  after,
  asOf,
};

describe("R5 independent exact inspection identity", () => {
  it.each([
    { after: { ...after, hash: "d".repeat(64) } },
    { after: { ...after, generation: "d".repeat(64) } },
    { asOf: { ...asOf, sessionId: "source-child" } },
    { asOf: { ...asOf, hash: "d".repeat(64) } },
    { asOf: { ...asOf, generation: "d".repeat(64) } },
  ])("same ordinal with different retained source is a different view: %j", (different) => {
    expect(workbenchRecordScopeKey({ ...scope, ...different })).not.toBe(
      workbenchRecordScopeKey(scope),
    );
  });
  it("equivalent exact cursors retain the same view identity", () => {
    expect(workbenchRecordScopeKey({ ...scope, after: { ...after }, asOf: { ...asOf } })).toBe(
      workbenchRecordScopeKey(scope),
    );
  });
});
