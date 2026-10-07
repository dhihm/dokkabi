/**
 * Closed contract tests for the explicit session work mode (Dokkabi
 * R8-06j2): the read result never invents a mode, the action result's state
 * vocabulary is exactly the host's frozen wire union (applied is a control
 * update receipt, never task success), the renderer's inputs carry only the
 * thread/command/revision/mode (no path, session id, token, model, policy,
 * callback or graph), and unknown fields decode as errors.
 *
 * @module contracts/provider.workmode.test
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ProviderGetWorkbenchWorkModeInput,
  ProviderSetWorkbenchWorkModeInput,
  ProviderWorkbenchWorkModeActionResult,
  ProviderWorkbenchWorkModeResult,
  ProviderWorkbenchWorkModeSelection,
  ProviderWorkbenchWorkModeStatusInput,
} from "./provider.ts";

const decode = <S extends Schema.Codec<any, any>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(value);

const REVISION = "a".repeat(64);
const SELECTION = {
  mode: "default",
  effective: "chat",
  source: "default",
  revision: REVISION,
};

describe("ProviderWorkbenchWorkModeSelection", () => {
  it("decodes the host's closed selection snapshot", () => {
    expect(decode(ProviderWorkbenchWorkModeSelection, SELECTION)).toEqual(SELECTION);
  });

  it("rejects an open execution vocabulary", () => {
    for (const mode of ["plan", "agent", "fast", ""]) {
      expect(() => decode(ProviderWorkbenchWorkModeSelection, { ...SELECTION, mode })).toThrow();
    }
    expect(() =>
      decode(ProviderWorkbenchWorkModeSelection, { ...SELECTION, effective: "default" }),
    ).toThrow();
    expect(() =>
      decode(ProviderWorkbenchWorkModeSelection, { ...SELECTION, source: "operator" }),
    ).toThrow();
  });

  it("rejects contradictory mode, effective mode and source", () => {
    for (const selection of [
      { ...SELECTION, source: "session" },
      { ...SELECTION, mode: "work", source: "session" },
      { ...SELECTION, mode: "chat", source: "session", effective: "work" },
      { ...SELECTION, mode: "work", effective: "work" },
    ])
      expect(() => decode(ProviderWorkbenchWorkModeSelection, selection)).toThrow();
  });

  it("requires the opaque SHA-256 revision shape, never a counter", () => {
    expect(() =>
      decode(ProviderWorkbenchWorkModeSelection, { ...SELECTION, revision: "3" }),
    ).toThrow();
    expect(() =>
      decode(ProviderWorkbenchWorkModeSelection, { ...SELECTION, revision: "A".repeat(64) }),
    ).toThrow();
  });
});

describe("ProviderWorkbenchWorkModeResult (read)", () => {
  it("carries the selection plus the host busy fact", () => {
    expect(
      decode(ProviderWorkbenchWorkModeResult, {
        status: "available",
        selection: SELECTION,
        busy: true,
      }),
    ).toEqual({ status: "available", selection: SELECTION, busy: true });
  });

  it("keeps unavailable and unsupported distinct, with bounded reasons", () => {
    expect(
      decode(ProviderWorkbenchWorkModeResult, { status: "unavailable", reason: "not bound" }),
    ).toEqual({ status: "unavailable", reason: "not bound" });
    expect(decode(ProviderWorkbenchWorkModeResult, { status: "unsupported" })).toEqual({
      status: "unsupported",
    });
  });

  it("rejects states that do not exist on the read wire", () => {
    for (const status of ["applied", "conflict", "busy", "unknown", "available-empty"]) {
      expect(() => decode(ProviderWorkbenchWorkModeResult, { status })).toThrow();
    }
  });

  it("rejects an available read without its selection", () => {
    expect(() =>
      decode(ProviderWorkbenchWorkModeResult, { status: "available", busy: false }),
    ).toThrow();
  });
});

describe("ProviderWorkbenchWorkModeActionResult (set and status)", () => {
  it("decodes an applied receipt with the exact post-effect selection", () => {
    expect(
      decode(ProviderWorkbenchWorkModeActionResult, {
        state: "applied",
        commandId: "workmode-cmd-1",
        selection: SELECTION,
        duplicate: false,
      }),
    ).toEqual({
      state: "applied",
      commandId: "workmode-cmd-1",
      selection: SELECTION,
      duplicate: false,
    });
  });

  it("decodes the frozen refusal vocabulary with optional command echo", () => {
    for (const state of ["conflict", "busy", "unknown", "unsupported", "unavailable"]) {
      expect(
        decode(ProviderWorkbenchWorkModeActionResult, { state, reason: "why", commandId: "c1" }),
      ).toEqual({ state, reason: "why", commandId: "c1" });
      expect(decode(ProviderWorkbenchWorkModeActionResult, { state, reason: "why" })).toEqual({
        state,
        reason: "why",
      });
    }
  });

  it("cannot describe the mode change as task success or verified work", () => {
    for (const state of ["success", "ready", "settled", "verified", "applied-quietly"]) {
      expect(() => decode(ProviderWorkbenchWorkModeActionResult, { state })).toThrow();
    }
  });

  it("keeps the command id inside the host vocabulary", () => {
    expect(() =>
      decode(ProviderWorkbenchWorkModeActionResult, {
        state: "applied",
        commandId: ":colon-first",
        selection: SELECTION,
        duplicate: true,
      }),
    ).toThrow();
  });
});

describe("work mode renderer inputs", () => {
  it("read carries the thread only", () => {
    expect(decode(ProviderGetWorkbenchWorkModeInput, { threadId: "thread-wm-1" })).toEqual({
      threadId: "thread-wm-1",
    });
  });

  it("set carries exactly command id, expected revision and closed mode", () => {
    expect(
      decode(ProviderSetWorkbenchWorkModeInput, {
        threadId: "thread-wm-1",
        commandId: "workmode-cmd-1",
        expectedRevision: REVISION,
        mode: "work",
      }),
    ).toEqual({
      threadId: "thread-wm-1",
      commandId: "workmode-cmd-1",
      expectedRevision: REVISION,
      mode: "work",
    });
    expect(() =>
      decode(ProviderSetWorkbenchWorkModeInput, {
        threadId: "thread-wm-1",
        commandId: "workmode-cmd-1",
        expectedRevision: REVISION,
        mode: "plan",
      }),
    ).toThrow();
  });

  it("status carries exactly the thread and command id", () => {
    expect(
      decode(ProviderWorkbenchWorkModeStatusInput, {
        threadId: "thread-wm-1",
        commandId: "workmode-cmd-1",
      }),
    ).toEqual({ threadId: "thread-wm-1", commandId: "workmode-cmd-1" });
  });

  it("refuses renderer authority additions under the actual default decoder", () => {
    for (const [key, value] of Object.entries({
      path: "/foreign/control.json",
      sessionId: "foreign-session",
      token: "synthetic-wire-fixture",
      model: "foreign-model",
      policy: { effort: "bypass" },
      callback: "https://foreign.example",
      graph: { nodes: [] },
      clientId: "foreign-client",
    })) {
      expect(
        () =>
          decode(ProviderSetWorkbenchWorkModeInput, {
            threadId: "thread-wm-1",
            commandId: "workmode-cmd-1",
            expectedRevision: REVISION,
            mode: "chat",
            [key]: value,
          }),
        key,
      ).toThrow();
    }
  });
});
