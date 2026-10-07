import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import {
  HandshakeResponse,
  STRICT_DECODE_OPTIONS,
  WorkModeParams,
  WorkModeResponse,
  workbenchParamsSchemas,
} from "./WorkbenchProtocol.ts";

const decodeParams = Schema.decodeUnknownSync(WorkModeParams, STRICT_DECODE_OPTIONS);
const decodeResponse = Schema.decodeUnknownSync(WorkModeResponse, STRICT_DECODE_OPTIONS);
const decodeHandshake = Schema.decodeUnknownSync(HandshakeResponse, STRICT_DECODE_OPTIONS);

const BINDING = { clientId: "dokkabi-app-main", threadId: "thread_7f3a" };
const REVISION = "b".repeat(64);
const SELECTION = {
  mode: "work",
  effective: "work",
  source: "session",
  revision: REVISION,
};

describe("workbench.workMode closed request wire", () => {
  it("accepts exactly the three documented operations", () => {
    expect(decodeParams({ version: 1, binding: BINDING, operation: "read" })).toEqual({
      version: 1,
      binding: BINDING,
      operation: "read",
    });
    expect(
      decodeParams({
        version: 1,
        binding: BINDING,
        operation: "set",
        commandId: "workmode-cmd-1",
        expectedRevision: REVISION,
        mode: "work",
      }),
    ).toEqual({
      version: 1,
      binding: BINDING,
      operation: "set",
      commandId: "workmode-cmd-1",
      expectedRevision: REVISION,
      mode: "work",
    });
    expect(
      decodeParams({
        version: 1,
        binding: BINDING,
        operation: "status",
        commandId: "workmode-cmd-1",
      }),
    ).toEqual({
      version: 1,
      binding: BINDING,
      operation: "status",
      commandId: "workmode-cmd-1",
    });
  });

  it("refuses renderer authority and policy fields on the set operation", () => {
    for (const [key, value] of Object.entries({
      path: "/foreign/control.json",
      sessionId: "foreign-session",
      token: "synthetic-wire-fixture",
      model: "foreign-model",
      policy: { permissions: "bypass" },
      callback: "https://foreign.example",
      graph: { nodes: [] },
    })) {
      expect(
        () =>
          decodeParams({
            version: 1,
            binding: BINDING,
            operation: "set",
            commandId: "workmode-cmd-1",
            expectedRevision: REVISION,
            mode: "chat",
            [key]: value,
          }),
        key,
      ).toThrow();
    }
  });

  it("rejects an open mode vocabulary and a counter revision", () => {
    expect(() =>
      decodeParams({
        version: 1,
        binding: BINDING,
        operation: "set",
        commandId: "workmode-cmd-1",
        expectedRevision: REVISION,
        mode: "plan",
      }),
    ).toThrow();
    expect(() =>
      decodeParams({
        version: 1,
        binding: BINDING,
        operation: "set",
        commandId: "workmode-cmd-1",
        expectedRevision: "7",
        mode: "work",
      }),
    ).toThrow();
  });

  it("registers the closed params schema for outbound validation", () => {
    expect(workbenchParamsSchemas["workbench.workMode"]).toBe(WorkModeParams);
  });
});

describe("workbench.workMode closed response wire", () => {
  it("decodes the available snapshot with the host busy fact", () => {
    expect(
      decodeResponse({ version: 1, state: "available", selection: SELECTION, busy: false }),
    ).toEqual({ version: 1, state: "available", selection: SELECTION, busy: false });
  });

  it("decodes an applied receipt and the frozen refusal vocabulary", () => {
    expect(
      decodeResponse({
        version: 1,
        state: "applied",
        commandId: "workmode-cmd-1",
        selection: SELECTION,
        duplicate: true,
      }),
    ).toEqual({
      version: 1,
      state: "applied",
      commandId: "workmode-cmd-1",
      selection: SELECTION,
      duplicate: true,
    });
    for (const state of ["conflict", "busy", "unknown", "unsupported", "unavailable"]) {
      expect(
        decodeResponse({ version: 1, state, reason: "why", commandId: "workmode-cmd-1" }),
      ).toEqual({ version: 1, state, reason: "why", commandId: "workmode-cmd-1" });
    }
  });

  it("cannot carry task-success or verification vocabulary", () => {
    for (const state of ["success", "ready", "settled", "verified"]) {
      expect(() => decodeResponse({ version: 1, state })).toThrow();
    }
  });
});

describe("handshake capabilities.workMode optionality", () => {
  const baseHandshake = {
    version: 1,
    workspacePath: "/tmp/dokkabi",
    sessionId: "live-0123456789",
    capabilities: {
      submit: true,
      cancel: true,
      read: true,
      detach: true,
      attachments: false,
      continuation: false,
      compaction: false,
      rollback: false,
      approvals: false,
      userInput: false,
      modelChange: false,
    },
    route: "glm",
    ready: false,
    reason: "not probed",
    routeSource: "configured",
    permissionMode: "bypass",
    kernelOpen: false,
  };

  it("an older peer without the field still decodes (absent means unsupported)", () => {
    const decoded = decodeHandshake(baseHandshake);
    expect(decoded.capabilities.workMode).toBeUndefined();
  });

  it("a new peer advertising the capability decodes", () => {
    const decoded = decodeHandshake({
      ...baseHandshake,
      capabilities: { ...baseHandshake.capabilities, workMode: true },
    });
    expect(decoded.capabilities.workMode).toBe(true);
  });

  it("still rejects unknown capability fields", () => {
    expect(() =>
      decodeHandshake({
        ...baseHandshake,
        capabilities: { ...baseHandshake.capabilities, surprise: true },
      }),
    ).toThrow();
  });
});

describe("app RPC registration and authorization", () => {
  it("belongs to the actual RPC group with read for reads and operate for the mutation", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.providerGetWorkbenchWorkMode)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.providerSetWorkbenchWorkMode)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.providerWorkbenchWorkModeStatus)).toBe(true);
    expect(requiredScopeForRpcMethod(WS_METHODS.providerGetWorkbenchWorkMode)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.providerSetWorkbenchWorkMode)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.providerSetWorkbenchWorkMode)).not.toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.providerWorkbenchWorkModeStatus)).toBe(
      AuthOrchestrationReadScope,
    );
  });
});
