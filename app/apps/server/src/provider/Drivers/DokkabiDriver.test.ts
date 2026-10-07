/**
 * Dokkabi driver behavioral tests.
 *
 * The disabled default instance must instantiate SAFELY without ever
 * opening a socket (no probe, no bind, no hidden request); a configured
 * instance advertises the harness's ACTUAL route/model through the
 * authenticated handshake so the operator can pick the real model BEFORE
 * the first thread; an unreachable gateway becomes an honest error
 * snapshot, never a failed creation. Text generation refuses by design.
 *
 * @module provider/Drivers/DokkabiDriver.test
 */
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";

import { type DokkabiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { DokkabiDriver, dokkabiModelsFromHandshake } from "./DokkabiDriver.ts";

const INSTANCE_ID = ProviderInstanceId.make("dokkabi");

/** Plain-runtime Crypto service built from node's secure primitives. */
const cryptoService = Crypto.make({
  // Crypto.make derives every helper from the SYNC random-bytes primitive.
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const makeConfig = (overrides: Partial<DokkabiSettings> = {}): DokkabiSettings => ({
  enabled: overrides.enabled ?? false,
  runtimeMode: overrides.runtimeMode ?? "external",
  gatewayUrl: overrides.gatewayUrl ?? "",
  tokenEnv: overrides.tokenEnv ?? "",
  workspacePath: overrides.workspacePath ?? "",
});

const createDriver = (config: DokkabiSettings, enabled = config.enabled) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const instance = yield* DokkabiDriver.create({
      instanceId: INSTANCE_ID,
      displayName: "Dokkabi",
      accentColor: undefined,
      environment: [],
      enabled,
      config,
    }).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
    return instance;
  });

/** Fails the test body if ANY code path constructs a real WebSocket. */
const withWebSocketSpy = <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E> => {
  const attempts: string[] = [];
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url: string) {
      attempts.push(url);
    }
  } as unknown as typeof WebSocket;
  return body.pipe(
    Effect.onExit(() =>
      Effect.sync(() => {
        globalThis.WebSocket = originalWebSocket;
        if (attempts.length > 0) {
          throw new Error(`unexpected WebSocket construction: ${attempts.join(", ")}`);
        }
      }),
    ),
  );
};

describe("DokkabiDriver.create safety", () => {
  it.effect(
    "refuses session startup after bundled failure despite retained external settings",
    () => {
      const priorToken = process.env.DOKKABI_BUNDLE_FAILURE_TEST_TOKEN;
      const priorRoot = process.env.DOKKABI_BUNDLED_RUNTIME;
      process.env.DOKKABI_BUNDLE_FAILURE_TEST_TOKEN = "non-secret-bundle-failure-fixture";
      delete process.env.DOKKABI_BUNDLED_RUNTIME;
      return withWebSocketSpy(
        Effect.gen(function* () {
          const instance = yield* createDriver(
            makeConfig({
              enabled: true,
              runtimeMode: "bundled",
              gatewayUrl: "ws://127.0.0.1:19432/ws",
              tokenEnv: "DOKKABI_BUNDLE_FAILURE_TEST_TOKEN",
              workspacePath: "/tmp",
            }),
          );
          expect((yield* instance.snapshot.getSnapshot).status).toBe("error");
          const result = yield* instance.adapter
            .startSession({
              threadId: ThreadId.make("bundle-failure-thread"),
              runtimeMode: "full-access",
              cwd: "/tmp",
            })
            .pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (priorToken === undefined) delete process.env.DOKKABI_BUNDLE_FAILURE_TEST_TOKEN;
            else process.env.DOKKABI_BUNDLE_FAILURE_TEST_TOKEN = priorToken;
            if (priorRoot === undefined) delete process.env.DOKKABI_BUNDLED_RUNTIME;
            else process.env.DOKKABI_BUNDLED_RUNTIME = priorRoot;
          }),
        ),
      );
    },
  );

  it.effect("instantiates the disabled default without any network attempt", () =>
    withWebSocketSpy(
      Effect.gen(function* () {
        const instance = yield* createDriver(makeConfig());
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("disabled");
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.installed).toBe(false);
        expect(snapshot.models).toEqual([]);
      }),
    ),
  );

  it.effect("instantiates an enabled-but-unconfigured instance as an error snapshot", () =>
    withWebSocketSpy(
      Effect.gen(function* () {
        const instance = yield* createDriver(makeConfig({ enabled: true }));
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("gateway URL");
        expect(snapshot.models).toEqual([]);
      }),
    ),
  );

  it.effect("never fails creation for a configured instance whose gateway is unreachable", () =>
    Effect.gen(function* () {
      const instance = yield* createDriver(
        makeConfig({
          enabled: true,
          gatewayUrl: "ws://127.0.0.1:1/ws",
          tokenEnv: "DOKKABI_TEST_TOKEN",
          workspacePath: "/tmp/dokkabi-driver-test-workspace",
        }),
      );
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBeTruthy();
      // Not a crash: refresh stays effectful and honest.
      const refreshed = yield* instance.snapshot.refresh;
      expect(refreshed.status).toBe("error");
    }),
  );

  it.effect("does not probe on refresh while unconfigured", () =>
    withWebSocketSpy(
      Effect.gen(function* () {
        const instance = yield* createDriver(makeConfig({ enabled: true }));
        const before = yield* instance.snapshot.getSnapshot;
        const after = yield* instance.snapshot.refresh;
        expect(after).toEqual(before);
      }),
    ),
  );

  it.effect("supports exactly one instance and exposes capabilities accordingly", () =>
    Effect.gen(function* () {
      expect(DokkabiDriver.metadata.supportsMultipleInstances).toBe(false);
      expect(DokkabiDriver.metadata.compatibilityAuthority).toBe("protocol");
      expect(DokkabiDriver.driverKind).toBe("dokkabi");
    }),
  );
});

describe("DokkabiDriver discovery mapping", () => {
  it.effect("advertises the real configured model and nothing else", () =>
    Effect.gen(function* () {
      expect(dokkabiModelsFromHandshake("glm-5.3")).toEqual([
        expect.objectContaining({
          slug: "glm-5.3",
          name: "glm-5.3",
          isDefault: true,
          isCustom: false,
        }),
      ]);
      expect(dokkabiModelsFromHandshake(undefined)).toEqual([]);
      expect(dokkabiModelsFromHandshake("  ")).toEqual([]);
    }),
  );

  it.effect("refuses every text-generation operation — no hidden harness turn", () =>
    Effect.gen(function* () {
      const instance = yield* createDriver(makeConfig());
      const modelSelection = {
        instanceId: INSTANCE_ID,
        model: "glm-5.3",
      } as const;
      const failures = yield* Effect.exit(
        Effect.all([
          instance.textGeneration.generateCommitMessage({
            cwd: "/tmp/repo",
            branch: null,
            stagedSummary: "",
            stagedPatch: "",
            modelSelection,
          }),
          instance.textGeneration.generatePrContent({
            cwd: "/tmp/repo",
            baseBranch: "main",
            headBranch: "feature",
            commitSummary: "",
            diffSummary: "",
            diffPatch: "",
            modelSelection,
          }),
          instance.textGeneration.generateBranchName({
            cwd: "/tmp/repo",
            message: "do a thing",
            modelSelection,
          }),
          instance.textGeneration.generateThreadTitle({
            cwd: "/tmp/repo",
            message: "hello",
            modelSelection,
          }),
        ]),
      );
      expect(Exit.isFailure(failures)).toBe(true);
    }),
  );

  it.effect("defaults to disabled with empty settings", () =>
    Effect.gen(function* () {
      const defaults = DokkabiDriver.defaultConfig();
      expect(defaults.enabled).toBe(false);
      expect(defaults.gatewayUrl).toBe("");
      expect(defaults.tokenEnv).toBe("");
      expect(defaults.workspacePath).toBe("");
    }),
  );
});
