/**
 * Targeted ProviderService acceptance for the R5 retained-record facade
 * (docs/internals/dokkabi-records-r5.md): getWorkbenchRecord resolves the
 * persisted binding and the registered ACTUAL instance with no recovery,
 * bind or model effect. An unbound thread reports unsupported; a provider
 * without the read capability reports unsupported — neither is empty
 * success; a detached Dokkabi source reports unavailable; the Dokkabi
 * thread routes through its persisted provider instance and returns the
 * retained records for the requested closed graph type.
 *
 * @module provider/Layers/ProviderService.graph.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { it, vi } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  WorkspaceLifecycleOwnership,
  type WorkspaceLifecycleOwnershipShape,
} from "../../orchestration/Services/WorkspaceLifecycleOwnership.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { makeDokkabiAdapter } from "./DokkabiAdapter.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";
import {
  bodyResponder,
  buildExplorerGraph,
  buildExplorerRows,
  descriptorOf,
  exploreResponder,
  headCursor,
  indexPage,
  pinAt,
} from "../dokkabi/ExplorerGateway.testFixtures.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";

const HARNESS_INSTANCE = ProviderInstanceId.make("dokkabi");
const APP_INSTANCE = ProviderInstanceId.make("codex");
const APP_DRIVER = ProviderDriverKind.make("codex");
const TOKEN_ENV = "DOKKABI_RECORD_SERVICE_REVIEW_TOKEN";

process.env[TOKEN_ENV] = "non-secret-test-fixture";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const tempDirs: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

const ownershipLayer = (input: {
  readonly roots: ReadonlyArray<string>;
  readonly harnessInstances: ReadonlyArray<string>;
}) =>
  Layer.succeed(WorkspaceLifecycleOwnership, {
    harnessOwnedRoots: Effect.succeed(input.roots),
    instanceIsHarnessOwned: (instanceId: ProviderInstanceId) =>
      Effect.succeed(input.harnessInstances.includes(String(instanceId))),
    pathIsHarnessOwned: (path: string) =>
      Effect.succeed(input.roots.some((root) => path === root || path.startsWith(`${root}/`))),
  } satisfies WorkspaceLifecycleOwnershipShape);

/** Application spy WITHOUT the record capability — the default provider. */
const makeAppSpyAdapter = () => {
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: APP_DRIVER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: vi.fn((input: ProviderSessionStartInput) =>
      Effect.succeed({
        provider: APP_DRIVER,
        providerInstanceId: APP_INSTANCE,
        status: "ready",
        threadId: input.threadId,
        runtimeMode: "full-access",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      } satisfies ProviderSession),
    ),
    sendTurn: vi.fn(() => Effect.die("spy sendTurn must not run for record reads")),
    interruptTurn: vi.fn(() => Effect.void),
    respondToRequest: vi.fn(() => Effect.void),
    respondToUserInput: vi.fn(() => Effect.void),
    stopSession: vi.fn(() => Effect.void),
    listSessions: vi.fn(() => Effect.succeed([])),
    hasSession: vi.fn(() => Effect.succeed(false)),
    readThread: vi.fn(() => Effect.die("spy readThread must not run for record reads")),
    rollbackThread: vi.fn(() => Effect.die("unsupported")),
    stopAll: vi.fn(() => Effect.void),
    streamEvents: Effect.die("spy stream must not run"),
  } as unknown as ProviderAdapterShape<ProviderAdapterError>;
  return adapter;
};

const makeStaticRegistry = (
  entries: ReadonlyArray<readonly [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>]>,
): ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] => {
  const adapters = new Map(entries);
  return {
    getByInstance: (instanceId) => {
      const adapter = adapters.get(instanceId);
      return adapter
        ? Effect.succeed(adapter)
        : Effect.die(`unknown instance ${String(instanceId)} in the record test registry`);
    },
    getInstanceInfo: (instanceId) => {
      const adapter = adapters.get(instanceId);
      return adapter
        ? Effect.succeed({
            instanceId,
            driverKind: adapter.provider,
            displayName: undefined,
            enabled: true,
            continuationIdentity: {
              driverKind: adapter.provider,
              continuationKey: `${adapter.provider}:instance:${String(instanceId)}`,
            },
          })
        : Effect.die(`unknown instance ${String(instanceId)}`);
    },
    listInstances: () => Effect.succeed([...adapters.keys()]),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

const buildStack = (input: {
  readonly dbPath: string;
  readonly registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"];
  readonly harnessRoot?: string;
}) => {
  const repositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(makeSqlitePersistenceLive(input.dbPath).pipe(Layer.provide(NodeServices.layer))),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(repositoryLayer));
  const serviceLayer = Layer.mergeAll(
    makeProviderServiceLive().pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, input.registry)),
      Layer.provide(directoryLayer),
      Layer.provide(
        ownershipLayer({
          roots: input.harnessRoot === undefined ? [] : [input.harnessRoot],
          harnessInstances: input.harnessRoot === undefined ? [] : [String(HARNESS_INSTANCE)],
        }),
      ),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    ),
    directoryLayer,
  );
  return serviceLayer;
};

const acquireHarnessAdapter = (
  gateway: FakeGateway,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = Scope.makeUnsafe("sequential");
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignore));
    return yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4174",
        tokenEnv: TOKEN_ENV,
        workspacePath: gateway.workspacePath,
        instanceId: HARNESS_INSTANCE,
      },
      {
        clientId: "dokkabi-record-service-review",
        pollIntervalMs: 25,
        cancelSettlementWaitMs: 150,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
  });

describe("R5 independent persisted-instance read facade", () => {
  it.live("unbound and capability-less threads remain unsupported without a writer", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-record-facade-"), "orchestration.sqlite");
      const spy = makeAppSpyAdapter();
      const layer = buildStack({ dbPath, registry: makeStaticRegistry([[APP_INSTANCE, spy]]) });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const unbound = yield* service.getWorkbenchRecord(ThreadId.make("record-unbound"), {});
        expect(unbound.status).toBe("unsupported");
        const thread = ThreadId.make("record-app-owned");
        yield* directory.upsert({
          threadId: thread,
          provider: APP_DRIVER,
          providerInstanceId: APP_INSTANCE,
        });
        const result = yield* service.getWorkbenchRecord(thread, { limit: 7 });
        expect(result.status).toBe("unsupported");
        expect(result.record).toBeUndefined();
        expect(spy.startSession).toHaveBeenCalledTimes(0);
        expect(spy.sendTurn).toHaveBeenCalledTimes(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "the persisted actual instance owns the record read and inspection adds no writer calls",
    () =>
      Effect.gen(function* () {
        const gateway = new FakeGateway();
        const harness = yield* acquireHarnessAdapter(gateway);
        const dbPath = NodePath.join(makeTempDir("t3-record-routed-"), "orchestration.sqlite");
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const thread = ThreadId.make("record-harness-owned");
          yield* service.startSession(thread, {
            provider: ProviderDriverKind.make("dokkabi"),
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
          } as Parameters<typeof service.startSession>[1]);
          const writes = gateway.requests.filter((c) =>
            ["workbench.bind", "workbench.submit", "workbench.cancel"].includes(c.method),
          ).length;
          const result = yield* service.getWorkbenchRecord(thread, { limit: 7 });
          expect(result.status).toBe("available");
          expect(result.record?.state).toBe("unavailable");
          expect(result.record?.decisions.status).toBe("unsupported");
          expect(
            gateway.requests.filter((c) =>
              ["workbench.bind", "workbench.submit", "workbench.cancel"].includes(c.method),
            ),
          ).toHaveLength(writes);
          gateway.supportRecord = false;
          expect((yield* service.getWorkbenchRecord(thread, {})).status).toBe("unsupported");
          gateway.supportRecord = true;
          gateway.binding = undefined;
          expect((yield* service.getWorkbenchRecord(thread, {})).status).toBe("unavailable");
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );
});

describe("bounded explorer persisted-instance facade", () => {
  it.live("unbound and capability-less threads report unsupported for every explorer read", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-explorer-facade-"), "orchestration.sqlite");
      const spy = makeAppSpyAdapter();
      const layer = buildStack({ dbPath, registry: makeStaticRegistry([[APP_INSTANCE, spy]]) });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const thread = ThreadId.make("explorer-app-owned");
        const reads = (target: ThreadId) =>
          Effect.all([
            service.getWorkbenchRecordIndex(target, {}),
            service.exploreWorkbenchGraph(target, { graphType: "work", query: { mode: "page" } }),
          ]);
        for (const result of yield* reads(ThreadId.make("explorer-unbound"))) {
          expect(result.status).toBe("unsupported");
        }
        yield* directory.upsert({
          threadId: thread,
          provider: APP_DRIVER,
          providerInstanceId: APP_INSTANCE,
        });
        for (const result of yield* reads(thread)) {
          expect(result.status).toBe("unsupported");
          expect(result.reason).toContain("codex");
        }
        expect(spy.startSession).toHaveBeenCalledTimes(0);
        expect(spy.sendTurn).toHaveBeenCalledTimes(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a recorded driver that differs from the registered instance's driver is refused", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-explorer-driver-"), "orchestration.sqlite");
      // A foreign-driver adapter registered under the persisted instance id
      // that would happily answer: it must never be consulted.
      const foreign = makeAppSpyAdapter() as ProviderAdapterShape<ProviderAdapterError> & {
        readWorkbenchRecordIndex: ReturnType<typeof vi.fn>;
        exploreWorkbenchGraph: ReturnType<typeof vi.fn>;
      };
      const answered = () =>
        Effect.succeed({ status: "unavailable" as const, reason: "foreign adapter answered" });
      Object.assign(foreign, {
        readWorkbenchRecordIndex: vi.fn(answered),
        exploreWorkbenchGraph: vi.fn(answered),
      });
      const layer = buildStack({ dbPath, registry: makeStaticRegistry([[APP_INSTANCE, foreign]]) });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const thread = ThreadId.make("explorer-driver-mismatch");
        yield* directory.upsert({
          threadId: thread,
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: APP_INSTANCE,
        });
        const index = yield* service.getWorkbenchRecordIndex(thread, {}).pipe(Effect.exit);
        expect(Exit.isFailure(index)).toBe(true);
        const graph = yield* service
          .exploreWorkbenchGraph(thread, { graphType: "work", query: { mode: "page" } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(graph)).toBe(true);
        expect(foreign.readWorkbenchRecordIndex).toHaveBeenCalledTimes(0);
        expect(foreign.exploreWorkbenchGraph).toHaveBeenCalledTimes(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a widened request is refused before any adapter is consulted", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-explorer-widened-"), "orchestration.sqlite");
      const spy = makeAppSpyAdapter();
      const layer = buildStack({ dbPath, registry: makeStaticRegistry([[APP_INSTANCE, spy]]) });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const thread = ThreadId.make("explorer-widened");
        const pin = { sessionId: "s", seq: 1, hash: "a".repeat(64), generation: "a".repeat(64) };
        const body = yield* service
          .getWorkbenchRecordBody(thread, {
            row: { seq: 1, hash: "a".repeat(64), generation: "a".repeat(64) },
            asOf: pin,
            offset: 0,
            limit: 65_536,
            expected: { byteLength: 10, bodyDigest: "b".repeat(64) },
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(body)).toBe(true);
        const graph = yield* service
          .exploreWorkbenchGraph(thread, {
            graphType: "context",
            query: { mode: "search", search: "x".repeat(129) },
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(graph)).toBe(true);
        const mixed = yield* service
          .exploreWorkbenchGraph(thread, {
            graphType: "context",
            query: { mode: "page", nodeId: "goal:root" },
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(mixed)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("the persisted actual Dokkabi instance serves explorer reads without writer calls", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const rows = buildExplorerRows(3);
      gateway.sessionGeneration = rows[0]!.hash;
      const harness = yield* acquireHarnessAdapter(gateway);
      const dbPath = NodePath.join(makeTempDir("t3-explorer-routed-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const thread = ThreadId.make("explorer-harness-owned");
        yield* service.startSession(thread, {
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          threadId: thread,
          runtimeMode: "full-access",
        } as Parameters<typeof service.startSession>[1]);
        const pin = pinAt(rows, 3);
        gateway.explorer.index = () => indexPage({ rows, asOf: pin });
        gateway.explorer.body = bodyResponder(rows);
        gateway.explorer.graph = exploreResponder({
          full: buildExplorerGraph(130),
          head: headCursor(rows),
        });
        const writes = () =>
          gateway.requests.filter((c) =>
            ["workbench.bind", "workbench.submit", "workbench.cancel"].includes(c.method),
          ).length;
        const before = writes();
        const index = yield* service.getWorkbenchRecordIndex(thread, { asOf: pin });
        expect(index.status).toBe("available");
        const descriptor = descriptorOf(rows[1]!);
        const body = yield* service.getWorkbenchRecordBody(thread, {
          row: { seq: 2, hash: rows[1]!.hash, generation: rows[0]!.hash },
          asOf: pin,
          offset: 0,
          expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
        });
        expect(body.status).toBe("available");
        const verification = yield* service.verifyWorkbenchRecordBody(thread, {
          row: { seq: 2, hash: rows[1]!.hash, generation: rows[0]!.hash },
          asOf: pin,
          expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
        });
        expect(verification.verification?.verdict).toBe("exact");
        const graph = yield* service.exploreWorkbenchGraph(thread, {
          graphType: "context",
          query: { mode: "page", offset: 100 },
        });
        expect(graph.explore?.graph.nodes).toHaveLength(30);
        expect(graph.explore?.nextOffset).toBeNull();
        expect(writes()).toBe(before);
        gateway.supportExplorer = false;
        expect((yield* service.getWorkbenchRecordIndex(thread, {})).status).toBe("unsupported");
        gateway.supportExplorer = true;
        gateway.binding = undefined;
        expect(
          (yield* service.exploreWorkbenchGraph(thread, {
            graphType: "context",
            query: { mode: "page" },
          })).status,
        ).toBe("unavailable");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
