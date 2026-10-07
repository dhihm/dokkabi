/**
 * Discovery-probe behavioral tests.
 *
 * Discovery is `workbench.handshake` ONLY: the probe must never bind, boot
 * a kernel, stage a note or invoke a model — there is no discovery thread.
 * Every failure mode classifies into an honest snapshot reason instead of
 * throwing, and the transport is always closed afterwards.
 *
 * @module provider/dokkabi/gatewayProbe.test
 */
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { probeDokkabiGateway } from "./gatewayProbe.ts";
import type { WorkbenchSocket } from "./WorkbenchTransport.ts";

class ProbeSocket {
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];
  closed = 0;

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

  emit(event: string, detail?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(detail);
    }
  }
}

const handshakeResult = {
  version: 1,
  workspacePath: "/Users/operator/work/dokkabi-lab",
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
  model: "glm-5.3",
  ready: false,
  reason: "model readiness not probed — the gateway kernel opens at workbench.bind",
  routeSource: "configured",
  kernelOpen: false,
  permissionMode: "bypass",
};

const baseInput = {
  gatewayUrl: "ws://127.0.0.1:4174",
  tokenEnv: "QA_PAIRING",
  env: { QA_PAIRING: "non-secret-test-fixture" } as Record<string, string | undefined>,
  connectTimeoutMs: 200,
  requestTimeoutMs: 400,
};

describe("probeDokkabiGateway", () => {
  it.effect("performs ONLY a handshake — never bind, submit or any model call", () =>
    Effect.gen(function* () {
      const socket = new ProbeSocket();
      let connection: { url: string; protocols: ReadonlyArray<string> | undefined } | undefined;
      const probe = yield* probeDokkabiGateway({
        ...baseInput,
        socketFactory: (url, protocols) => {
          connection = { url, protocols };
          // Auto-open once the transport has attached its listeners.
          queueMicrotask(() => socket.emit("open"));
          return socket as unknown as WorkbenchSocket;
        },
      });
      // The socket double never answers, so the request times out; but
      // nothing beyond the handshake may ever be SENT.
      const methods = socket.sent.map((frame) => (JSON.parse(frame) as { method: string }).method);
      expect(methods).toEqual(["workbench.handshake"]);
      expect(connection?.url).toBe("ws://127.0.0.1:4174/");
      expect(connection?.protocols).toEqual([
        "dokkabi.rpc",
        "dokkabi.auth.non-secret-test-fixture",
      ]);
      expect(socket.closed).toBeGreaterThan(0);
      expect(probe.ok).toBe(false);
      if (!probe.ok) {
        expect(probe.kind).toBe("unreachable");
        expect(probe.reason).toContain("timed out");
      }
    }),
  );

  it.effect("returns the actual configured identity from a real handshake reply", () =>
    Effect.gen(function* () {
      const socket = new ProbeSocket();
      socket.addEventListener("open", () => {
        const reply = () => {
          if (socket.sent.length === 0) {
            queueMicrotask(reply);
            return;
          }
          const id = (JSON.parse(socket.sent[0]!) as { id: number }).id;
          socket.emit("message", {
            data: JSON.stringify({ jsonrpc: "2.0", id, result: handshakeResult }),
          });
        };
        queueMicrotask(reply);
      });
      const probe = yield* probeDokkabiGateway({
        ...baseInput,
        socketFactory: () => {
          queueMicrotask(() => socket.emit("open"));
          return socket as unknown as WorkbenchSocket;
        },
      });
      expect(probe.ok).toBe(true);
      if (probe.ok) {
        expect(probe.identity.model).toBe("glm-5.3");
        expect(probe.identity.permissionMode).toBe("bypass");
        expect(probe.identity.routeSource).toBe("configured");
      }
      expect(socket.closed).toBeGreaterThan(0);
    }),
  );

  it.effect(
    "classifies a missing token variable as unauthenticated without creating a socket",
    () =>
      Effect.gen(function* () {
        const sockets: ProbeSocket[] = [];
        const probe = yield* probeDokkabiGateway({
          ...baseInput,
          env: {},
          socketFactory: () => {
            const socket = new ProbeSocket();
            sockets.push(socket);
            return socket as unknown as WorkbenchSocket;
          },
        });
        expect(sockets).toHaveLength(0);
        expect(probe.ok).toBe(false);
        if (!probe.ok) {
          expect(probe.kind).toBe("unauthenticated");
          expect(probe.reason).toContain("QA_PAIRING");
        }
      }),
  );

  it.effect("classifies an invalid gateway URL as a config failure", () =>
    Effect.gen(function* () {
      const probe = yield* probeDokkabiGateway({
        ...baseInput,
        gatewayUrl: "https://example.com/ws",
      });
      expect(probe.ok).toBe(false);
      if (!probe.ok) {
        expect(probe.kind).toBe("config");
        expect(probe.reason).toContain("ws://");
      }
    }),
  );

  it.effect("classifies a refused socket as unreachable", () =>
    Effect.gen(function* () {
      const probe = yield* probeDokkabiGateway({
        ...baseInput,
        socketFactory: () => {
          const socket = new ProbeSocket();
          queueMicrotask(() => socket.emit("error"));
          return socket as unknown as WorkbenchSocket;
        },
      });
      expect(probe.ok).toBe(false);
      if (!probe.ok) {
        expect(probe.kind).toBe("unreachable");
      }
    }),
  );

  it.effect("classifies a contract-violating handshake response as a protocol failure", () =>
    Effect.gen(function* () {
      const probe = yield* probeDokkabiGateway({
        ...baseInput,
        socketFactory: () => {
          const socket = new ProbeSocket();
          socket.addEventListener("open", () => {
            const reply = () => {
              if (socket.sent.length === 0) {
                queueMicrotask(reply);
                return;
              }
              const id = (JSON.parse(socket.sent[0]!) as { id: number }).id;
              // permissionMode missing: contract drift must fail loudly.
              const { permissionMode: _missing, ...drifted } = handshakeResult;
              void _missing;
              socket.emit("message", {
                data: JSON.stringify({ jsonrpc: "2.0", id, result: drifted }),
              });
            };
            queueMicrotask(reply);
          });
          queueMicrotask(() => socket.emit("open"));
          return socket as unknown as WorkbenchSocket;
        },
      });
      expect(probe.ok).toBe(false);
      if (!probe.ok) {
        expect(probe.kind).toBe("protocol");
        expect(probe.reason).toContain("contract");
      }
    }),
  );
  for (const version of [0, 2]) {
    it.effect(`refuses unsupported gateway protocol ${version} without binding`, () =>
      Effect.gen(function* () {
        const socket = new ProbeSocket();
        socket.addEventListener("open", () => {
          const reply = () => {
            if (socket.sent.length === 0) {
              queueMicrotask(reply);
              return;
            }
            const id = (JSON.parse(socket.sent[0]!) as { id: number }).id;
            socket.emit("message", {
              data: JSON.stringify({ jsonrpc: "2.0", id, result: { ...handshakeResult, version } }),
            });
          };
          queueMicrotask(reply);
        });
        const result = yield* probeDokkabiGateway({
          ...baseInput,
          socketFactory: () => {
            queueMicrotask(() => socket.emit("open"));
            return socket as unknown as WorkbenchSocket;
          },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("protocol");
        expect(socket.sent.map((raw) => JSON.parse(raw).method)).toEqual(["workbench.handshake"]);
        expect(socket.closed).toBeGreaterThan(0);
      }),
    );
  }
});
