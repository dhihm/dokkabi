import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import {
  ProviderResumeWorkbenchSessionInput,
  ProviderWorkbenchResumeError,
  ProviderWorkbenchResumeResult,
} from "./provider.ts";
import { WS_METHODS } from "./rpc.ts";

const THREAD = ThreadId.make("thread-resume-contract");

/** Strict decoding: the schema is CLOSED — any excess property is a contract
 * violation, not a stripped extra. This is the enforcement the resume seam
 * relies on: even where a transport decoder tolerates extras, the server
 * handler consumes ONLY the thread id, so no authority field can influence
 * recovery. */
const decodeInput = Schema.decodeUnknownSync(ProviderResumeWorkbenchSessionInput, {
  onExcessProperty: "error",
});
const decodeResult = Schema.decodeUnknownSync(ProviderWorkbenchResumeResult, {
  onExcessProperty: "error",
});

describe("ProviderResumeWorkbenchSessionInput (R8 closed wire)", () => {
  it("accepts exactly the thread id", () => {
    expect(() => decodeInput({ threadId: THREAD })).not.toThrow();
  });

  it.each([
    ["provider override", { provider: "codex" }],
    ["provider instance override", { providerInstanceId: "instance-fixture" }],
    ["model selection", { modelSelection: { model: "glm-5.4" } }],
    ["resume cursor", { resumeCursor: { sessionId: "session-forged" } }],
    ["cwd/path authority", { cwd: "/tmp/other-workspace" }],
    ["command text", { input: "send this instead" }],
    ["policy", { approvalPolicy: "never" }],
    ["credential material", { token: "fixture-token", tokenEnv: "STEAL_ME" }],
  ] as const)("refuses renderer authority addition: %s", (_label, authority) => {
    expect(() => decodeInput({ threadId: THREAD, ...authority })).toThrow();
  });
});

describe("ProviderWorkbenchResumeResult (R8 closed result)", () => {
  it("accepts each closed state, with or without a bounded reason", () => {
    expect(decodeResult({ state: "available" })).toEqual({ state: "available" });
    expect(decodeResult({ state: "unsupported", reason: "No provider binding." })).toEqual({
      state: "unsupported",
      reason: "No provider binding.",
    });
    expect(decodeResult({ state: "unknown", reason: "Refused." })).toEqual({
      state: "unknown",
      reason: "Refused.",
    });
  });

  it("refuses an invented state (no ready/conflict/empty success) and excess fields", () => {
    expect(() => decodeResult({ state: "ready" })).toThrow();
    expect(() => decodeResult({} as unknown as Record<string, unknown>)).toThrow();
    expect(() => decodeResult({ state: "available", session: { sessionId: "forged" } })).toThrow();
  });

  it("bounds the refusal reason to the wire limit", () => {
    expect(() => decodeResult({ state: "unknown", reason: "x".repeat(2000) })).not.toThrow();
    expect(() => decodeResult({ state: "unknown", reason: "x".repeat(2001) })).toThrow();
  });

  it("carries a typed boundary error carrying the thread only", () => {
    const error = new ProviderWorkbenchResumeError({ threadId: THREAD });
    expect(error.message).toContain(String(THREAD));
    expect(error.threadId).toBe(THREAD);
  });

  it("registers the closed method name in the server group vocabulary", () => {
    expect(WS_METHODS.providerResumeWorkbenchSession).toBe("provider.resumeWorkbenchSession");
  });
});
