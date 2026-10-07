/**
 * Targeted ProviderService acceptance for the R8 scoped-usage probe behind
 * getWorkbenchOverview: the optional includeChildUsage argument is resolved
 * through the thread's persisted binding with no recovery, bind or model
 * effect, forwarded to the adapter exactly when true, and never minted on
 * behalf of a caller that did not ask for it. Unbound threads and
 * capability-less providers keep their unchanged typed results; an older
 * gateway keeps the overview available with a typed unsupported scoped
 * usage; a non-boolean flag is a validation error, never a silent truthy
 * coercion.
 *
 * @module provider/Layers/ProviderService.scoped-usage.test
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
import { FakeGateway, emptyOverview } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";

const HARNESS_INSTANCE = ProviderInstanceId.make("dokkabi");
const APP_INSTANCE = ProviderInstanceId.make("codex");
const APP_DRIVER = ProviderDriverKind.make("codex");
const TOKEN_ENV = "DOKKABI_SCOPED_USAGE_SERVICE_TEST_TOKEN";

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

/** Application spy WITHOUT the overview capability — the default provider. */
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
    sendTurn: vi.fn(() => Effect.die("spy sendTurn must not run for scoped usage reads")),
    interruptTurn: vi.fn(() => Effect.void),
    respondToRequest: vi.fn(() => Effect.void),
    respondToUserInput: vi.fn(() => Effect.void),
    stopSession: vi.fn(() => Effect.void),
    listSessions: vi.fn(() => Effect.succeed([])),
    hasSession: vi.fn(() => Effect.succeed(false)),
    readThread: vi.fn(() => Effect.die("spy readThread must not run for scoped usage reads")),
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
        : Effect.die(`unknown instance ${String(instanceId)} in the scoped usage test registry`);
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
        clientId: "dokkabi-scoped-usage-service-test",
        pollIntervalMs: 25,
        cancelSettlementWaitMs: 150,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
  });

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");

/** The gateway's own heads, so the fixture report binds to the source. */
const report = (gateway: FakeGateway): Record<string, unknown> => ({
  state: "complete",
  main: {
    sessionId: gateway.sessionId,
    head: gateway.sessionHeadRef(),
    settled: true,
    counts: { requests: 1, sends: 1, completedUsage: 1 },
    usage: {
      records: 1,
      input: { total: 100, missing: 0, latestSource: { seq: 5, hash: hex64("svc-u5") } },
      output: { total: 20, missing: 0, latestSource: { seq: 5, hash: hex64("svc-u5") } },
      reasoning: { total: null, missing: 1, latestSource: null },
      cacheRead: { total: null, missing: 1, latestSource: null },
      cacheWrite: { total: null, missing: 1, latestSource: null },
    },
  },
  scopes: [],
  aggregate: {
    scopesCounted: 1,
    counts: { requests: 1, sends: 1, completedUsage: 1 },
    input: { total: 100, missing: 0 },
    output: { total: 20, missing: 0 },
    reasoning: { total: null, missing: 1 },
    cacheRead: { total: null, missing: 1 },
    cacheWrite: { total: null, missing: 1 },
  },
  semantics: {
    totals: "recorded_usage_not_billing",
    reasoning: "included_in_output_total",
    cacheRead: "separate_from_input_total",
    cacheWrite: "separate_from_input_total",
  },
  details: [],
  errors: [],
});

describe("ProviderService.getWorkbenchOverview scoped usage", () => {
  it.live("forwards includeChildUsage through the persisted Dokkabi instance", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* acquireHarnessAdapter(gateway);
      const dbPath = NodePath.join(makeTempDir("t3-scoped-usage-routed-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
        harnessRoot: gateway.workspacePath,
      });
      const thread = ThreadId.make("thread-scoped-usage-routed");
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        yield* service.startSession(thread, {
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          threadId: thread,
          runtimeMode: "full-access",
        } as Parameters<typeof service.startSession>[1]);
        gateway.setOverview(emptyOverview());
        gateway.setUsage(report(gateway));
        const result = yield* service.getWorkbenchOverview(thread, { includeChildUsage: true });
        expect(result.status).toBe("available");
        const scoped = result.scopedUsage;
        expect(scoped?.status).toBe("available");
        if (scoped?.status !== "available") return;
        expect(scoped.report.main.usage.input.total).toBe(100);
        // Exactly one probe; the read stays read-only end to end.
        expect(gateway.requestsFor("workbench.usage")).toHaveLength(1);
        expect(gateway.requestsFor("workbench.overview")).toHaveLength(1);
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("without the flag the service issues no probe and returns no scoped usage", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* acquireHarnessAdapter(gateway);
      const dbPath = NodePath.join(makeTempDir("t3-scoped-usage-plain-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
        harnessRoot: gateway.workspacePath,
      });
      const thread = ThreadId.make("thread-scoped-usage-plain");
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        yield* service.startSession(thread, {
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          threadId: thread,
          runtimeMode: "full-access",
        } as Parameters<typeof service.startSession>[1]);
        gateway.setOverview(emptyOverview());
        gateway.setUsage(report(gateway));
        const result = yield* service.getWorkbenchOverview(thread);
        expect(result.status).toBe("available");
        expect(result.scopedUsage).toBeUndefined();
        expect(gateway.requestsFor("workbench.usage")).toHaveLength(0);
        expect(gateway.requestsFor("workbench.overview")).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("an older gateway keeps the overview available with a typed unsupported scoped usage", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.supportUsage = false;
      const harness = yield* acquireHarnessAdapter(gateway);
      const dbPath = NodePath.join(makeTempDir("t3-scoped-usage-old-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
        harnessRoot: gateway.workspacePath,
      });
      const thread = ThreadId.make("thread-scoped-usage-old");
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        yield* service.startSession(thread, {
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          threadId: thread,
          runtimeMode: "full-access",
        } as Parameters<typeof service.startSession>[1]);
        gateway.setOverview(emptyOverview());
        const result = yield* service.getWorkbenchOverview(thread, { includeChildUsage: true });
        expect(result.status).toBe("available");
        expect(result.overview?.work.state).toBe("missing");
        const scoped = result.scopedUsage;
        expect(scoped?.status).toBe("unsupported");
        if (scoped?.status !== "unsupported" && scoped?.status !== "unavailable") return;
        expect(scoped.reason).toContain("does not implement workbench.usage");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("an unbound thread is unchanged unsupported with no scoped usage", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-scoped-usage-unbound-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[APP_INSTANCE, makeAppSpyAdapter()]]),
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const result = yield* service.getWorkbenchOverview(ThreadId.make("thread-never-bound"), {
          includeChildUsage: true,
        });
        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("No provider binding");
        expect(result.scopedUsage).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a non-boolean flag is a validation error, never a truthy coercion", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-scoped-usage-flag-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[APP_INSTANCE, makeAppSpyAdapter()]]),
      });
      const thread = ThreadId.make("thread-scoped-usage-flag");
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: thread,
          provider: APP_DRIVER,
          providerInstanceId: APP_INSTANCE,
        });
        const exit = yield* Effect.exit(
          service.getWorkbenchOverview(thread, {
            includeChildUsage: "yes" as never,
          }),
        );
        expect(Exit.isSuccess(exit)).toBe(false);
        expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("includeChildUsage");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
