/**
 * Behavioral transport tests for the Dokkabi workbench transport.
 *
 * These reproduce the primary's real RED case (a silent WebSocket whose
 * connect deadline fires must REJECT, not hang) and pin the connection
 * lifecycle fences: stale close/error from an obsolete connection can never
 * drop the current one, transport close during a pending connect settles
 * the caller, malformed frames fail pending requests immediately, gateway
 * notifications never invoke anything, and every surfaced error scrubs the
 * pairing token in its raw, URI-encoded and form-encoded forms.
 *
 * @module provider/dokkabi/WorkbenchTransport.test
 */
// @effect-diagnostics globalTimers:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  validateTokenEnvName,
  WorkbenchTransport,
  workbenchRequest,
  type WorkbenchSocket,
} from "./WorkbenchTransport.ts";

/** Fully controllable socket double; tests drive events by hand. */
class ScriptedSocket {
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];
  closed = 0;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(event: string, listener: (event?: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed += 1;
  }

  emit(event: "open"): void;
  emit(event: "close" | "error" | "message", detail?: unknown): void;
  emit(event: string, detail?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(detail);
    }
  }

  reply(id: number, result: unknown): void {
    this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }

  replyError(id: number, message: string): void {
    this.emit("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }),
    });
  }

  lastRequestId(): number | undefined {
    const last = this.sent.at(-1);
    if (last === undefined) return undefined;
    return (JSON.parse(last) as { id: number }).id;
  }
}

const TOKEN = "non-secret-test-fixture";

const baseOptions = (socket: ScriptedSocket) => ({
  url: new URL("ws://127.0.0.1:12345/ws"),
  tokenEnv: "QA_PAIRING",
  env: { QA_PAIRING: TOKEN },
  connectTimeoutMs: 30,
  requestTimeoutMs: 500,
  socketFactory: () => socket as unknown as WorkbenchSocket,
});

describe("connect deadline (the primary's real RED case)", () => {
  it("rejects a request when a silent socket never opens", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws?token=x");
    const transport = new WorkbenchTransport(baseOptions(socket));
    const outcome = await Promise.race([
      transport.request("workbench.handshake", { version: 1 }).then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    transport.close();
    expect(outcome).not.toBe("hung");
    expect(String(outcome)).toContain("rejected");
    expect(String(outcome)).toContain("did not open in time");
  });

  it("rejects even when the silent socket's close emits no event", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws?token=x");
    // close() records but deliberately never emits — a crashed endpoint.
    const transport = new WorkbenchTransport(baseOptions(socket));
    await expect(transport.request("workbench.handshake", { version: 1 })).rejects.toThrow(
      /did not open in time/,
    );
    transport.close();
  });

  it("settles a pending connect when the transport closes underneath it", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws?token=x");
    const transport = new WorkbenchTransport(baseOptions(socket));
    const pending = transport.request("workbench.handshake", { version: 1 });
    transport.close();
    await expect(pending).rejects.toThrow(/transport is closed|reconcile/);
  });
});

describe("connection fencing", () => {
  it("a stale close from an obsolete connection cannot drop the new one", async () => {
    const sockets: ScriptedSocket[] = [];
    const transport = new WorkbenchTransport({
      ...baseOptions(new ScriptedSocket("ws://x")),
      socketFactory: () => {
        const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
        sockets.push(socket);
        return socket as unknown as WorkbenchSocket;
      },
    });
    // First connect attempt times out silently.
    await expect(transport.request("workbench.handshake", { version: 1 })).rejects.toThrow(
      /did not open in time/,
    );
    // Second attempt opens cleanly.
    const second = transport.request("workbench.handshake", { version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const requestId = sockets[1]!.lastRequestId();
    expect(requestId).toBeTypeOf("number");
    // The FIRST socket belatedly reports close — the current one must survive.
    sockets[0]!.emit("close", { code: 1006 });
    sockets[1]!.reply(requestId as number, { ok: true });
    await expect(second).resolves.toHaveProperty("result", { ok: true });
    transport.close();
  });

  it("a request whose socket closes after open rejects with a reconcile hint", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
    const transport = new WorkbenchTransport(baseOptions(socket));
    const pending = transport.request("workbench.handshake", { version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.emit("close", { code: 1000 });
    await expect(pending).rejects.toThrow(/reconcile with workbench\.commandStatus/);
    transport.close();
  });

  it("a malformed frame fails the pending request and closes the socket", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
    const transport = new WorkbenchTransport(baseOptions(socket));
    const pending = transport.request("workbench.handshake", { version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.emit("message", { data: "{not json" });
    await expect(pending).rejects.toThrow(/malformed frame/);
    expect(socket.closed).toBeGreaterThan(0);
    transport.close();
  });

  it("gateway broadcast notifications are ignored and never resolve or fail requests", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
    const transport = new WorkbenchTransport(baseOptions(socket));
    const pending = transport.request("workbench.handshake", { version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({ jsonrpc: "2.0", method: "chat.opened", params: { sessionId: "s" } }),
    });
    socket.emit("message", {
      data: JSON.stringify({ jsonrpc: "2.0", method: "terminal.output", params: { chunk: "x" } }),
    });
    // A response for an unknown id is dropped silently.
    socket.reply(999, { ignored: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const requestId = socket.lastRequestId();
    socket.reply(requestId as number, { version: 1 });
    await expect(pending).resolves.toHaveProperty("id", requestId);
    transport.close();
  });
});

describe("outbound request validation", () => {
  it("rejects invalid params before any socket exists", async () => {
    let factories = 0;
    const transport = new WorkbenchTransport({
      ...baseOptions(new ScriptedSocket("ws://x")),
      socketFactory: () => {
        factories += 1;
        return new ScriptedSocket("ws://127.0.0.1:12345/ws") as unknown as WorkbenchSocket;
      },
    });
    await expect(transport.request("workbench.handshake", { version: 2 })).rejects.toThrow(
      /workbench\.handshake request invalid/,
    );
    await expect(
      transport.request("workbench.submit", {
        version: 1,
        binding: { clientId: "c", threadId: "t" },
        commandId: "cmd",
        text: "hello",
        modelSelection: "glm-5.3",
      }),
    ).rejects.toThrow(/request invalid/);
    expect(factories).toBe(0);
    transport.close();
  });

  it("serializes requests so mutations cannot interleave on the wire", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
    const transport = new WorkbenchTransport(baseOptions(socket));
    const first = transport.request("workbench.handshake", { version: 1 });
    const second = transport.request("workbench.read", {
      version: 1,
      binding: { clientId: "c", threadId: "t" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The second request is not sent until the first has its response.
    expect(socket.sent).toHaveLength(1);
    socket.reply(socket.lastRequestId() as number, { ok: true });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.sent).toHaveLength(2);
    socket.reply(socket.lastRequestId() as number, { cards: [] });
    await second;
    transport.close();
  });
});

describe("token redaction", () => {
  it("scrubs the raw, URI-encoded and form-encoded token from factory errors", async () => {
    const spaceyToken = "s3 cret+tok";
    const transport = new WorkbenchTransport({
      ...baseOptions(new ScriptedSocket("ws://x")),
      env: { QA_PAIRING: spaceyToken },
      socketFactory: (url: string, protocols?: ReadonlyArray<string>) => {
        throw new Error(`cannot connect to ${url} with ${protocols?.join(",")}`);
      },
    });
    const outcome = await transport.request("workbench.handshake", { version: 1 }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    transport.close();
    expect(outcome).not.toContain(spaceyToken);
    expect(outcome).not.toContain(encodeURIComponent(spaceyToken));
    expect(outcome).not.toContain("s3+cret%2Btok");
    expect(outcome).toContain("<redacted-token>");
  });

  it("scrubs the token from gateway error responses", async () => {
    const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
    const transport = new WorkbenchTransport(baseOptions(socket));
    const pending = transport.request("workbench.handshake", { version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.replyError(
      socket.lastRequestId() as number,
      `auth failed for ws://127.0.0.1:12345/ws?token=${TOKEN}`,
    );
    const reply = await pending;
    expect(reply.error?.message).not.toContain(TOKEN);
    expect(reply.error?.message).toContain("<redacted-token>");
    transport.close();
  });

  it.live("scrubs the token from transport-loss errors surfaced through workbenchRequest", () =>
    Effect.gen(function* () {
      const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
      const transport = new WorkbenchTransport(baseOptions(socket));
      const outcome = yield* workbenchRequest(transport, "workbench.submit", {
        version: 1,
        binding: { clientId: "c", threadId: "t" },
        commandId: "cmd-r",
        text: `hello ${TOKEN}`,
      }).pipe(
        Effect.map(() => "resolved"),
        Effect.catch((error: Error) => Effect.succeed(error.message)),
      );
      yield* Effect.sync(() => {
        socket.emit("open");
      });
      yield* Effect.sleep(5);
      yield* Effect.sync(() => {
        socket.emit("close", { code: 1006 });
      });
      transport.close();
      expect(outcome).not.toContain(TOKEN);
    }),
  );

  it("never echoes a secret-like invalid tokenEnv name", () => {
    // Dotted token-like string: invalid as a variable name AND withheld.
    const secretLike = "d3f504a1.c2b9e8f7a6d5c4b3";
    const invalid = validateTokenEnvName(secretLike);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.reason).not.toContain(secretLike);
      expect(invalid.reason).toContain("value withheld");
    }
    // A benign identifier typo is still echoed for debuggability.
    const benign = validateTokenEnvName("dokkabi-gateway-token");
    expect(benign.ok).toBe(false);
    if (!benign.ok) {
      expect(benign.reason).toContain("dokkabi-gateway-token");
    }
  });
});

it("authenticates with private WebSocket protocols and never places the token in a URL", async () => {
  const socket = new ScriptedSocket("ws://127.0.0.1:12345/ws");
  let connected: { url: string; protocols: ReadonlyArray<string> | undefined } | undefined;
  const transport = new WorkbenchTransport({
    ...baseOptions(socket),
    socketFactory: (url: string, protocols?: ReadonlyArray<string>) => {
      connected = { url, protocols };
      queueMicrotask(() => socket.emit("open"));
      return socket as unknown as WorkbenchSocket;
    },
  });
  const pending = transport.request("workbench.handshake", { version: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(connected?.url).toBe("ws://127.0.0.1:12345/ws");
  expect(connected?.protocols).toEqual([
    "dokkabi.rpc",
    `dokkabi.auth.${encodeURIComponent(TOKEN)}`,
  ]);
  socket.reply(socket.lastRequestId()!, { version: 1 });
  await pending;
  transport.close();
});
