import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProviderResumeWorkbenchSessionInput,
  ProviderWorkbenchResumeResult,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
const decodeInput = Schema.decodeUnknownSync(ProviderResumeWorkbenchSessionInput);
const decodeResult = Schema.decodeUnknownSync(ProviderWorkbenchResumeResult);
describe("primary: explicit recorded-parent reconnect wire", () => {
  it("accepts only a recorded thread selector", () => {
    expect(decodeInput({ threadId: "parent-wire-review" })).toEqual({
      threadId: "parent-wire-review",
    });
    expect(() => decodeInput({})).toThrow();
  });
  it("refuses incoming execution authority under the actual default decoder", () => {
    for (const [key, value] of Object.entries({
      providerInstanceId: "foreign-provider",
      model: "foreign-model",
      cwd: "/foreign/workspace",
      resumeCursor: {},
      token: "synthetic-wire-fixture",
      input: "unwanted model message",
      runtimeMode: "full-access",
      policy: { permissions: "bypass" },
    })) {
      expect(() => decodeInput({ threadId: "parent-wire-review", [key]: value }), key).toThrow();
    }
  });
  it("cannot describe recovered source as model success or verified work", () => {
    for (const state of ["available", "unknown", "unsupported"])
      expect(decodeResult({ state }).state).toBe(state);
    for (const state of ["ready", "success", "applied", "verified"])
      expect(() => decodeResult({ state })).toThrow();
    expect(() => decodeResult({ state: "unknown", reason: "x".repeat(2001) })).toThrow();
  });
  it("requires operate permission and belongs to the actual RPC group", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.providerResumeWorkbenchSession)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.providerResumeWorkbenchSession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.providerResumeWorkbenchSession)).not.toBe(
      AuthOrchestrationReadScope,
    );
  });
});
