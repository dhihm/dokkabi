// @effect-diagnostics globalTimers:off
// Real socket fixture delays exercise overlapping handshake responses.
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as NodeCrypto from "node:crypto";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { DokkabiDriver } from "./DokkabiDriver.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});
const withGateway = <A, E, R>(body: (gateway: FakeGateway) => Effect.Effect<A, E, R>) => {
  const gateway = new FakeGateway();
  const originalSocket = globalThis.WebSocket;
  const token = process.env.DOKKABI_READINESS_TEST_TOKEN;
  globalThis.WebSocket = class {
    constructor() {
      return gateway.createSocket();
    }
  } as unknown as typeof WebSocket;
  process.env.DOKKABI_READINESS_TEST_TOKEN = "non-secret-test-fixture";
  return body(gateway).pipe(
    Effect.scoped,
    Effect.provideService(Crypto.Crypto, cryptoService),
    Effect.ensuring(
      Effect.sync(() => {
        globalThis.WebSocket = originalSocket;
        if (token === undefined) delete process.env.DOKKABI_READINESS_TEST_TOKEN;
        else process.env.DOKKABI_READINESS_TEST_TOKEN = token;
      }),
    ),
  );
};
const driver = () =>
  DokkabiDriver.create({
    instanceId: ProviderInstanceId.make("dokkabi"),
    displayName: "Dokkabi",
    accentColor: undefined,
    environment: [],
    enabled: true,
    config: {
      enabled: true,
      runtimeMode: "external",
      gatewayUrl: "ws://127.0.0.1:19432/ws",
      tokenEnv: "DOKKABI_READINESS_TEST_TOKEN",
      workspacePath: "/tmp/dokkabi-fake-workspace",
    },
  });

const nextSnapshot = (instance: ProviderInstance) =>
  Stream.runCollect(instance.snapshot.streamChanges.pipe(Stream.take(1))).pipe(
    Effect.map((values) => Array.from(values)[0]),
    Effect.timeout("3 seconds"),
  );

describe("Dokkabi structured discovery and lifecycle status", () => {
  it.effect("keeps cold discovery unprobed without binding or starting a model", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        const instance = yield* driver();
        const state = yield* instance.snapshot.getSnapshot;
        expect(state).toMatchObject({
          status: "warning",
          auth: { status: "authenticated" },
          modelReadiness: "unprobed",
        });
        expect(gateway.requests.map((r) => r.method)).toEqual(["workbench.handshake"]);
        expect(gateway.binding).toBeUndefined();
      }),
    ),
  );
  it.effect("publishes current parent readiness after normal bind and recorded reconnect", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        const instance = yield* driver();
        let boundReady = true;
        const dispatch = gateway.dispatch.bind(gateway);
        gateway.dispatch = (method, params, socket, id) => {
          if (method === "workbench.bind") {
            gateway.ready = boundReady;
            gateway.kernelOpen = true;
            gateway.routeSource = "kernel";
            gateway.reason = boundReady
              ? "Local model credentials are configured."
              : "The selected model has no usable credentials.";
          }
          dispatch(method, params, socket, id);
        };
        const session = yield* instance.adapter.startSession({
          threadId: ThreadId.make("readiness-thread"),
          runtimeMode: "full-access",
          cwd: gateway.workspacePath,
        });
        const current = yield* nextSnapshot(instance);
        expect(current).toMatchObject({ status: "ready", modelReadiness: "ready" });
        expect(yield* instance.snapshot.getSnapshot).toEqual(current);
        yield* instance.adapter.stopSession(session.threadId);
        boundReady = false;
        gateway.ready = false;
        gateway.reason = "The selected model has no usable credentials.";
        yield* instance.adapter.startSession({
          threadId: session.threadId,
          runtimeMode: "full-access",
          cwd: gateway.workspacePath,
          resumeCursor: session.resumeCursor,
        });
        expect(yield* nextSnapshot(instance)).toMatchObject({
          status: "warning",
          modelReadiness: "unavailable",
          message: "The selected model has no usable credentials.",
        });
        yield* instance.adapter.stopSession(session.threadId);
        boundReady = true;
        yield* instance.adapter.startSession({
          threadId: session.threadId,
          runtimeMode: "full-access",
          cwd: gateway.workspacePath,
          resumeCursor: session.resumeCursor,
        });
        expect(yield* nextSnapshot(instance)).toMatchObject({
          status: "ready",
          modelReadiness: "ready",
        });
        expect(gateway.requests.filter((r) => r.method === "workbench.submit")).toHaveLength(0);
      }),
    ),
  );
  it.effect("preserves probed unavailable and unsupported permission warnings", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        gateway.kernelOpen = true;
        gateway.routeSource = "kernel";
        gateway.reason = "No credentials for the selected model.";
        const instance = yield* driver();
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          status: "warning",
          modelReadiness: "unavailable",
          message: gateway.reason,
        });
        gateway.permissionMode = "ask";
        gateway.kernelOpen = false;
        gateway.routeSource = "configured";
        const blocked = yield* instance.snapshot.refresh;
        expect(blocked.status).toBe("warning");
        expect(blocked.message).toContain("permission mode");
        expect(blocked).not.toMatchObject({ modelReadiness: "unprobed" });
      }),
    ),
  );
  it.effect("refreshes after accepted submit and preserves failed-operation errors", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        gateway.ready = true;
        gateway.kernelOpen = true;
        gateway.routeSource = "kernel";
        const instance = yield* driver();
        const session = yield* instance.adapter.startSession({
          threadId: ThreadId.make("send-readiness"),
          runtimeMode: "full-access",
          cwd: gateway.workspacePath,
        });
        yield* nextSnapshot(instance);
        gateway.ready = false;
        gateway.reason = "Selected model is unavailable.";
        yield* instance.adapter.sendTurn({
          threadId: session.threadId,
          input: "explicit fixture submit",
        });
        expect(yield* nextSnapshot(instance)).toMatchObject({
          status: "warning",
          modelReadiness: "unavailable",
          message: gateway.reason,
        });
        gateway.ready = true;
        const failed = yield* Effect.exit(
          instance.adapter.sendTurn({
            threadId: ThreadId.make("missing-thread"),
            input: "must fail",
          }),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed)) expect(String(failed.cause)).toContain("missing-thread");
        expect(yield* nextSnapshot(instance)).toMatchObject({
          status: "ready",
          modelReadiness: "ready",
        });
        expect(gateway.requests.filter((r) => r.method === "workbench.submit")).toHaveLength(1);
        yield* instance.adapter.stopSession(session.threadId);
      }),
    ),
  );
  it.effect(
    "does not classify inconsistent cold identity or failed authentication as unprobed",
    () =>
      withGateway((gateway) =>
        Effect.gen(function* () {
          gateway.kernelOpen = false;
          gateway.routeSource = "kernel";
          const instance = yield* driver();
          expect(yield* instance.snapshot.getSnapshot).toMatchObject({
            status: "warning",
            modelReadiness: "unavailable",
          });
          const dispatch = gateway.dispatch.bind(gateway);
          gateway.dispatch = (method, params, socket, id) => {
            if (method === "workbench.handshake") {
              socket.reply(id, { error: { code: -32001, message: "Unauthorized" } });
              return;
            }
            dispatch(method, params, socket, id);
          };
          const failed = yield* instance.snapshot.refresh;
          expect(failed.status).toBe("error");
          expect(failed.modelReadiness).toBeUndefined();
          expect(failed.auth.status).not.toBe("authenticated");
        }),
      ),
  );
  it.live("returns an actual bind result without waiting for a stalled status probe", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        const instance = yield* driver();
        const dispatch = gateway.dispatch.bind(gateway);
        let bound = false;
        gateway.dispatch = (method, params, socket, id) => {
          if (method === "workbench.handshake" && bound) return;
          if (method === "workbench.bind") bound = true;
          dispatch(method, params, socket, id);
        };
        const session = yield* instance.adapter
          .startSession({
            threadId: ThreadId.make("stalled-status"),
            runtimeMode: "full-access",
            cwd: gateway.workspacePath,
          })
          .pipe(Effect.timeout("1 second"));
        expect(session.threadId).toBe("stalled-status");
        expect(gateway.binding).toBeDefined();
        expect(gateway.requests.filter((r) => r.method === "workbench.submit")).toHaveLength(0);
      }),
    ),
  );
  it.live("serializes overlapping refreshes through publication", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        gateway.kernelOpen = true;
        gateway.routeSource = "kernel";
        const instance = yield* driver();
        const dispatch = gateway.dispatch.bind(gateway);
        let inFlight = 0;
        let maximum = 0;
        gateway.dispatch = (method, params, socket, id) => {
          if (method !== "workbench.handshake") {
            dispatch(method, params, socket, id);
            return;
          }
          inFlight++;
          maximum = Math.max(maximum, inFlight);
          setTimeout(() => {
            dispatch(method, params, socket, id);
            gateway.ready = true;
            inFlight--;
          }, 20);
        };
        const states = yield* Effect.all([instance.snapshot.refresh, instance.snapshot.refresh], {
          concurrency: "unbounded",
        });
        expect(maximum).toBe(1);
        expect(states.map((s) => s.modelReadiness)).toEqual(["unavailable", "ready"]);
        const published = yield* Stream.runCollect(
          instance.snapshot.streamChanges.pipe(Stream.take(2)),
        ).pipe(Effect.timeout("1 second"));
        expect(Array.from(published)).toEqual(states);
        expect(yield* instance.snapshot.getSnapshot).toEqual(states[1]);
      }),
    ),
  );
  it.live("preserves a typed operation error while a status probe stalls", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        const instance = yield* driver();
        const dispatch = gateway.dispatch.bind(gateway);
        gateway.dispatch = (method, params, socket, id) => {
          if (method !== "workbench.handshake") dispatch(method, params, socket, id);
        };
        const failed = yield* Effect.exit(
          instance.adapter.sendTurn({
            threadId: ThreadId.make("missing-stalled-thread"),
            input: "must fail",
          }),
        ).pipe(Effect.timeout("1 second"));
        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed))
          expect(String(failed.cause)).toContain("missing-stalled-thread");
        expect(gateway.requests.filter((r) => r.method === "workbench.submit")).toHaveLength(0);
      }),
    ),
  );
  it.effect("preserves a successful bind when the diagnostic probe defects", () =>
    withGateway((gateway) =>
      Effect.gen(function* () {
        const instance = yield* driver();
        const dispatch = gateway.dispatch.bind(gateway);
        gateway.dispatch = (method, params, socket, id) => {
          if (method === "workbench.bind") {
            globalThis.WebSocket = class {
              constructor() {
                throw new Error("diagnostic fixture defect");
              }
            } as unknown as typeof WebSocket;
          }
          dispatch(method, params, socket, id);
        };
        const session = yield* instance.adapter.startSession({
          threadId: ThreadId.make("diagnostic-defect"),
          runtimeMode: "full-access",
          cwd: gateway.workspacePath,
        });
        expect(session.threadId).toBe("diagnostic-defect");
        yield* Effect.yieldNow;
        expect((yield* instance.snapshot.getSnapshot).modelReadiness).not.toBe("ready");
      }),
    ),
  );
});
