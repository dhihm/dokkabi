/**
 * Closed wire-contract tests for the Dokkabi workbench protocol v1.
 *
 * Pins the exact request/response encoding against hand-written golden
 * fixtures AND against a capture of a REAL gateway session (labeled as
 * such; the unconfigured-route capture settles as failure and never claims
 * live-model acceptance). Unknown, excess and malformed inputs must fail
 * loudly — a gateway contract drift can never flow unvalidated data into
 * the app.
 *
 * @module provider/dokkabi/WorkbenchProtocol.test
 */
import { describe, expect, it } from "vite-plus/test";

import realFixture from "./dokkabi-real-gateway.fixture.json" with { type: "json" };
import {
  BindResponse,
  CancelResponse,
  CommandStatusResponse,
  DetachResponse,
  decodeFrameOrNotification,
  decodeResponseFrame,
  HandshakeResponse,
  ReadResponse,
  SubmitResponse,
  WORKBENCH_PROTOCOL_VERSION,
  workbenchParamsSchemas,
  encodeRequest,
  isWorkbenchId,
} from "./WorkbenchProtocol.ts";
import {
  goldenBindResponse,
  goldenCancelResponse,
  goldenCommandStatusResponse,
  goldenDetachResponse,
  goldenHandshakeRequest,
  goldenHandshakeResponse,
  goldenReadResponse,
  goldenSubmitResponse,
} from "./WorkbenchProtocol.testFixtures.ts";
import * as Schema from "effect/Schema";
import { STRICT_DECODE_OPTIONS } from "./WorkbenchProtocol.ts";

// `any` erases the per-schema generics for the shared helper, mirroring the
// AnyProviderDriver pattern; each call site still gets its precise Type back.
const decodeSync = <S extends Schema.Codec<any, any>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, STRICT_DECODE_OPTIONS)(value);

describe("workbench protocol golden fixtures", () => {
  it("encodes the golden handshake request exactly", () => {
    expect(
      JSON.parse(encodeRequest(1, "workbench.handshake", goldenHandshakeRequest.params)),
    ).toEqual(goldenHandshakeRequest);
  });

  it("decodes the golden handshake response including the required permissionMode", () => {
    const decoded = decodeSync(HandshakeResponse, goldenHandshakeResponse);
    expect(decoded.permissionMode).toBe("bypass");
    expect(decoded.routeSource).toBe("configured");
    expect(decoded.ready).toBe(false);
  });

  it("decodes the golden bind, read, submit, commandStatus, cancel and detach responses", () => {
    expect(decodeSync(BindResponse, goldenBindResponse).sessionId).toBe("live-0123456789");
    const read = decodeSync(ReadResponse, goldenReadResponse);
    expect(read.resnapshot).toBe(false);
    expect(read.commands).toHaveLength(5);
    // Source refs must survive in EVERY state — settled commands keep their
    // turnStart/settlement ranges so recovery can attribute historical cards.
    const settled = read.commands.find((command) => command.commandId === "cmd-1");
    expect(settled?.sources?.["turnStart"]).toBeTypeOf("number");
    expect(settled?.sources?.["settlement"]).toBe(9);
    expect(decodeSync(SubmitResponse, goldenSubmitResponse).state).toBe("handed_off");
    expect(decodeSync(CommandStatusResponse, goldenCommandStatusResponse).outcome).toBe(
      "operator_abort",
    );
    expect(decodeSync(DetachResponse, goldenDetachResponse).detached).toBe(true);
    expect(decodeSync(CancelResponse, goldenCancelResponse).state).toBe("requested");
  });

  it("validates every outbound request against its closed params schema", () => {
    const read = workbenchParamsSchemas["workbench.read"];
    expect(() =>
      decodeSync(read, {
        version: WORKBENCH_PROTOCOL_VERSION,
        binding: { clientId: "dokkabi-app-main", threadId: "thread_7f3a" },
        sessionCursor: {
          sessionId: "live-0123456789",
          seq: 12,
          hash: "a".repeat(64),
          generation: "b".repeat(64),
        },
      }),
    ).not.toThrow();
  });
});

describe("workbench protocol rejects unknown, excess and malformed shapes", () => {
  it("rejects an unknown top-level field on the handshake response", () => {
    expect(() =>
      decodeSync(HandshakeResponse, { ...goldenHandshakeResponse, surprise: 1 }),
    ).toThrow();
  });

  it("rejects an excess field inside capabilities", () => {
    expect(() =>
      decodeSync(HandshakeResponse, {
        ...goldenHandshakeResponse,
        capabilities: { ...goldenHandshakeResponse.capabilities, extra: true },
      }),
    ).toThrow();
  });

  it("rejects a handshake without the required permissionMode", () => {
    const { permissionMode: _omitted, ...withoutPermissionMode } = goldenHandshakeResponse;
    void _omitted;
    expect(() => decodeSync(HandshakeResponse, withoutPermissionMode)).toThrow();
  });

  it("rejects an unknown permissionMode value", () => {
    expect(() =>
      decodeSync(HandshakeResponse, { ...goldenHandshakeResponse, permissionMode: "yolo" }),
    ).toThrow();
  });

  it("rejects a wrong protocol version", () => {
    expect(() =>
      decodeSync(HandshakeResponse, { ...goldenHandshakeResponse, version: 2 }),
    ).toThrow();
  });

  it("rejects an invalid command id shape", () => {
    expect(() =>
      decodeSync(SubmitResponse, { ...goldenSubmitResponse, commandId: "not allowed!" }),
    ).toThrow();
  });

  it("rejects excess fields on read responses and cursor shapes", () => {
    expect(() => decodeSync(ReadResponse, { ...goldenReadResponse, tail: true })).toThrow();
    expect(() =>
      decodeSync(ReadResponse, {
        ...goldenReadResponse,
        sessionCursor: { ...goldenReadResponse.sessionCursor, extra: 1 },
      }),
    ).toThrow();
  });

  it("rejects a params payload with an unknown key", () => {
    expect(() =>
      decodeSync(workbenchParamsSchemas["workbench.submit"], {
        version: 1,
        binding: { clientId: "c", threadId: "t" },
        commandId: "cmd",
        text: "hello",
        model: "glm-5.3",
      }),
    ).toThrow();
  });

  it("decodes tool completion refs and rejects a half pair", () => {
    const read = decodeSync(ReadResponse, goldenReadResponse);
    const completed = read.cards.find((card) => card.kind === "tool" && card.seq === 4);
    const running = read.cards.find((card) => card.kind === "tool" && card.seq === 6);
    expect(completed).toMatchObject({ completionSeq: 5, completionHash: "e".repeat(64) });
    expect(running).not.toHaveProperty("completionSeq");
    // Pair consistency: a lone completionSeq is a contract violation.
    const cards = goldenReadResponse.cards.map((card) =>
      card.kind === "tool" && card.seq === 6 ? { ...card, completionSeq: 7 } : card,
    );
    expect(() => decodeSync(ReadResponse, { ...goldenReadResponse, cards })).toThrow(/together/);
  });
});

describe("workbench frame decoding", () => {
  it("treats a gateway notification (method, no id) as ignorable, not malformed", () => {
    const frame = decodeFrameOrNotification(
      JSON.stringify({ jsonrpc: "2.0", method: "chat.opened", params: { sessionId: "x" } }),
    );
    expect(frame.kind).toBe("notification");
  });

  it("decodes a response frame and keeps error frames as responses", () => {
    const response = decodeResponseFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: { detached: true } }),
    );
    expect(response.id).toBe(7);
    const errorFrame = decodeResponseFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        error: { code: -32603, message: "workspace mismatch" },
      }),
    );
    expect(errorFrame.error?.code).toBe(-32603);
  });

  it("throws on malformed JSON so the transport can treat it as a contract violation", () => {
    expect(() => decodeFrameOrNotification("{not json")).toThrow();
  });
});

describe("workbench id vocabulary", () => {
  it("accepts gateway-shaped ids and refuses others", () => {
    expect(isWorkbenchId("cmd-1")).toBe(true);
    expect(isWorkbenchId("a".repeat(128))).toBe(true);
    expect(isWorkbenchId("a".repeat(129))).toBe(false);
    expect(isWorkbenchId("provider:evt:1")).toBe(false); // colons are not wire-safe
    expect(isWorkbenchId("-leading-dash")).toBe(false);
    expect(isWorkbenchId("")).toBe(false);
  });
});

describe("real gateway fixture (labeled: unconfigured-route capture; not live-model evidence)", () => {
  it("decodes every response frame of the capture with the closed schemas", () => {
    const frames = realFixture.frames as ReadonlyArray<{
      readonly label: string;
      readonly response: {
        readonly result?: unknown;
        readonly error?: { code: number; message: string };
      };
    }>;
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.response.error ?? frame.response.result).toBeDefined();
      if (frame.response.error !== undefined) {
        // The foreign-workspace bind refusal is a real error frame.
        expect(frame.response.error.code).toBe(-32603);
        continue;
      }
      switch (frame.label) {
        case "handshake-configured":
        case "handshake-after-bind":
          expect(() => decodeSync(HandshakeResponse, frame.response.result)).not.toThrow();
          break;
        case "bind":
          expect(() => decodeSync(BindResponse, frame.response.result)).not.toThrow();
          break;
        case "read-initial":
        case "read-settled":
          expect(() => decodeSync(ReadResponse, frame.response.result)).not.toThrow();
          break;
        case "submit":
        case "submit-duplicate":
          expect(() => decodeSync(SubmitResponse, frame.response.result)).not.toThrow();
          break;
        case "commandStatus-settled":
          expect(() => decodeSync(CommandStatusResponse, frame.response.result)).not.toThrow();
          break;
        case "detach":
          expect(() => decodeSync(DetachResponse, frame.response.result)).not.toThrow();
          break;
        default:
          throw new Error(`unlabeled fixture frame ${frame.label}`);
      }
    }
  });

  it("records the kernel-identity handshake with permissionMode bypass", () => {
    const frames = realFixture.frames as ReadonlyArray<{
      readonly label: string;
      readonly response: { readonly result?: unknown };
    }>;
    const afterBind = frames.find((frame) => frame.label === "handshake-after-bind");
    const decoded = decodeSync(HandshakeResponse, afterBind?.response?.result);
    expect(decoded.routeSource).toBe("kernel");
    expect(decoded.kernelOpen).toBe(true);
    expect(decoded.permissionMode).toBe("bypass");
  });

  it("keeps source ranges on the settled command of the capture", () => {
    const frames = realFixture.frames as ReadonlyArray<{
      readonly label: string;
      readonly response: { readonly result?: unknown };
    }>;
    const readSettled = frames.find((frame) => frame.label === "read-settled");
    const read = decodeSync(ReadResponse, readSettled?.response?.result);
    const command = read.commands.find((entry) => entry.commandId === "cmd-capture-1");
    expect(command?.state).toBe("settled");
    expect(command?.outcome).toBe("failure");
    expect(command?.sources?.["turnStart"]).toBe(49);
    expect(command?.messageSeq).toBe(50);
  });
});
