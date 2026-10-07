import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Protocol from "./WorkbenchProtocol.ts";

const descriptor = {
  id: "child-one",
  sessionId: "child-session",
  workspacePath: "/isolated/owned/workspace",
  parent: { clientId: "main-client", threadId: "parent-thread" },
  binding: { clientId: "main-client", threadId: "child-thread" },
};

const decodeBranch = (result: unknown) =>
  Effect.runPromise(
    Protocol.decodeResult({
      schema: Protocol.BranchDescriptorResponse,
      result,
      method: "workbench.decision",
    }),
  );
const decodeDecision = (result: unknown) =>
  Effect.runPromise(
    Protocol.decodeResult({
      schema: Protocol.DecisionResponse,
      result,
      method: "workbench.decision",
    }),
  );

describe("R8-05 branch wire authority", () => {
  it("accepts a complete recorded child descriptor", async () => {
    expect(await decodeBranch(descriptor)).toEqual(descriptor);
  });
  it("rejects credential and caller authority on a child descriptor", async () => {
    await expect(decodeBranch({ ...descriptor, token: "caller-token" })).rejects.toThrow();
    await expect(decodeBranch({ ...descriptor, policy: { mode: "bypass" } })).rejects.toThrow();
  });
  it("cannot accept synthetic applied as a decision response", async () => {
    await expect(decodeDecision({ version: 1, state: "applied" })).rejects.toThrow();
  });
  it("refuses readiness without a confirmed child descriptor", async () => {
    await expect(decodeDecision({ version: 1, state: "ready" })).rejects.toThrow();
  });
  it("refuses a child that reuses the parent app thread", async () => {
    await expect(decodeBranch({ ...descriptor, binding: descriptor.parent })).rejects.toThrow();
  });
  it("refuses a child binding owned by another client", async () => {
    await expect(
      decodeBranch({ ...descriptor, binding: { ...descriptor.binding, clientId: "other-client" } }),
    ).rejects.toThrow();
  });
});
