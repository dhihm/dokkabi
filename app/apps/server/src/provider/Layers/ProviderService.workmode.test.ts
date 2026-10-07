/**
 * Targeted ProviderService acceptance for the R8-06j2 work-mode facade: the
 * three typed operations resolve the thread's recorded actual provider
 * instance and derive the gateway binding server-side from the persisted
 * resume cursor — ordinary providers without the optional adapter methods
 * report unsupported (hidden), unbound threads and unregistered instances
 * report unsupported with zero gateway interaction, a set dispatch reaches
 * the harness under the derived binding only, and an invalid closed-vocabulary
 * payload refuses as a validation error before any wire effect.
 *
 * @module provider/Layers/ProviderService.workmode.test
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
  type OrchestrationThreadShell,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import { it } from "@effect/vitest";
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
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderUnsupportedError } from "../Errors.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { makeDokkabiAdapter } from "./DokkabiAdapter.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";

const HARNESS_INSTANCE = ProviderInstanceId.make("dokkabi");
const APP_INSTANCE = ProviderInstanceId.make("codex");
const REMOVED_INSTANCE = ProviderInstanceId.make("removed-instance");
const APP_DRIVER = ProviderDriverKind.make("codex");
const TOKEN_ENV = "DOKKABI_WORKMODE_SERVICE_TEST_TOKEN";
const THREAD = ThreadId.make("thread-workmode-facade");
const CLIENT_ID = "dokkabi-workmode-service-test";

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

const threadShell = (input: {
  readonly id: ThreadId;
  readonly instanceId: string;
}): OrchestrationThreadShell =>
  ({
    id: input.id,
    projectId: "proj-workmode-1",
    title: "shell",
    modelSelection: { instanceId: input.instanceId },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as unknown as OrchestrationThreadShell;

const projectionService = (
  shell: OrchestrationThreadShell | null,
): ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] =>
  ({
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        shell !== null && String(threadId) === String(shell.id)
          ? Option.some(shell)
          : Option.none(),
      ),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const makeStaticRegistry = (
  entries: ReadonlyArray<readonly [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>]>,
): ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] => {
  const adapters = new Map(entries);
  const unsupported = (instanceId: ProviderInstanceId) =>
    Effect.fail(new ProviderUnsupportedError({ provider: String(instanceId) }));
  return {
    getByInstance: (instanceId) => {
      const adapter = adapters.get(instanceId);
      return adapter ? Effect.succeed(adapter) : unsupported(instanceId);
    },
    getInstanceInfo: (instanceId) => {
      const adapter = adapters.get(instanceId);
      if (adapter === undefined) return unsupported(instanceId);
      return Effect.succeed({
        instanceId,
        driverKind: adapter.provider,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: adapter.provider,
          continuationKey: `${adapter.provider}:instance:${String(instanceId)}`,
        },
      });
    },
    listInstances: () => Effect.succeed([...adapters.keys()]),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

/** Ordinary application provider WITHOUT the optional work-mode methods. */
const makeAppSpyAdapter = () => {
  const started: ProviderSessionStartInput[] = [];
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: APP_DRIVER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input: ProviderSessionStartInput) => {
      started.push(input);
      return Effect.succeed({
        provider: APP_DRIVER,
        providerInstanceId: APP_INSTANCE,
        status: "ready",
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      } satisfies ProviderSession);
    },
    sendTurn: () => Effect.die("spy sendTurn must not run for the work-mode facade"),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => Effect.die("spy readThread must not run for the work-mode facade"),
    rollbackThread: () => Effect.die("unsupported"),
    stopAll: () => Effect.void,
    streamEvents: Effect.die("spy stream must not run"),
  } as unknown as ProviderAdapterShape<ProviderAdapterError>;
  return { adapter, started };
};

const buildStack = (input: {
  readonly dbPath: string;
  readonly registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"];
  readonly shell: OrchestrationThreadShell | null;
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
        Layer.succeed(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          projectionService(input.shell),
        ),
      ),
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
        gatewayUrl: "ws://127.0.0.1:4177",
        tokenEnv: TOKEN_ENV,
        workspacePath: gateway.workspacePath,
        instanceId: HARNESS_INSTANCE,
      },
      {
        clientId: CLIENT_ID,
        pollIntervalMs: 25,
        cancelSettlementWaitMs: 150,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
  });

const recordBinding = {
  threadId: THREAD,
  provider: ProviderDriverKind.make("dokkabi"),
  providerInstanceId: HARNESS_INSTANCE,
  status: "stopped" as const,
  resumeCursor: {
    binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
    sessionId: "live-fake01",
  },
};

describe("ProviderService work-mode facade (R8-06j2)", () => {
  it.live(
    "an ordinary provider without the optional methods reports unsupported for all three",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-workmode-ordinary-"), "orchestration.sqlite");
        const spy = makeAppSpyAdapter();
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[APP_INSTANCE, spy.adapter]]),
          shell: threadShell({ id: THREAD, instanceId: String(APP_INSTANCE) }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            ...recordBinding,
            provider: APP_DRIVER,
            providerInstanceId: APP_INSTANCE,
          });
          const read = yield* service.getWorkbenchWorkMode(THREAD);
          expect(read.status).toBe("unsupported");
          const set = yield* service.setWorkbenchWorkMode(THREAD, {
            commandId: "workmode-cmd-ordinary-1",
            expectedRevision: "d".repeat(64),
            mode: "work",
          });
          expect(set.state).toBe("unsupported");
          const status = yield* service.workbenchWorkModeStatus(THREAD, "workmode-cmd-ordinary-1");
          expect(status.state).toBe("unsupported");
          expect(spy.started).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live("a thread with no persisted binding reports unsupported", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-workmode-unbound-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        shell: threadShell({ id: THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const read = yield* service.getWorkbenchWorkMode(THREAD);
        expect(read.status).toBe("unsupported");
        expect(gateway.requestsFor("workbench.workMode")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("an unregistered recorded instance reports unsupported", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(
        makeTempDir("t3-workmode-unregistered-"),
        "orchestration.sqlite",
      );
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        shell: threadShell({ id: THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({ ...recordBinding, providerInstanceId: REMOVED_INSTANCE });
        const read = yield* service.getWorkbenchWorkMode(THREAD);
        expect(read.status).toBe("unsupported");
        expect(gateway.requestsFor("workbench.workMode")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("read and set reach the harness under the server-derived binding only", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-workmode-live-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      // The persisted binding is the only source; the gateway is bound to the
      // same recorded owner, exactly like a restarted harness gateway.
      gateway.binding = { clientId: CLIENT_ID, threadId: String(THREAD) };
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        shell: threadShell({ id: THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert(recordBinding);

        const read = yield* service.getWorkbenchWorkMode(THREAD);
        expect(read.status).toBe("available");
        if (read.status !== "available") return;
        expect(read.selection.mode).toBe("default");

        const applied = yield* service.setWorkbenchWorkMode(THREAD, {
          commandId: "workmode-cmd-facade-1",
          expectedRevision: read.selection.revision,
          mode: "chat",
        });
        expect(applied.state).toBe("applied");

        // Every wire request carried the server-derived recorded binding.
        const requests = gateway.requestsFor("workbench.workMode");
        expect(requests.length).toBeGreaterThanOrEqual(2);
        for (const params of requests) {
          expect(params).toMatchObject({
            version: 1,
            binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
          });
        }
        const setRequest = requests.find(
          (params) => (params as Record<string, unknown>).operation === "set",
        );
        expect(setRequest).toMatchObject({
          commandId: "workmode-cmd-facade-1",
          expectedRevision: read.selection.revision,
          mode: "chat",
        });
        // Nothing else was invoked: no Send, no bind, no submit.
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);

        const status = yield* service.workbenchWorkModeStatus(THREAD, "workmode-cmd-facade-1");
        expect(status.state).toBe("applied");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a payload outside the closed vocabulary refuses as a validation error", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-workmode-invalid-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      gateway.binding = { clientId: CLIENT_ID, threadId: String(THREAD) };
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        shell: threadShell({ id: THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert(recordBinding);
        const badMode = yield* Effect.exit(
          service.setWorkbenchWorkMode(THREAD, {
            commandId: "workmode-cmd-invalid-1",
            expectedRevision: "e".repeat(64),
            mode: "plan" as "work",
          }),
        );
        expect(Exit.isSuccess(badMode)).toBe(false);
        const badRevision = yield* Effect.exit(
          service.setWorkbenchWorkMode(THREAD, {
            commandId: "workmode-cmd-invalid-2",
            expectedRevision: "not-a-revision",
            mode: "work",
          }),
        );
        expect(Exit.isSuccess(badRevision)).toBe(false);
        const badCommandId = yield* Effect.exit(
          service.setWorkbenchWorkMode(THREAD, {
            commandId: ":colon-first",
            expectedRevision: "e".repeat(64),
            mode: "work",
          }),
        );
        expect(Exit.isSuccess(badCommandId)).toBe(false);
        expect(
          gateway
            .requestsFor("workbench.workMode")
            .filter((params) => (params as Record<string, unknown>).operation === "set"),
        ).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
