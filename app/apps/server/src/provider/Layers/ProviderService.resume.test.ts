/**
 * Targeted ProviderService acceptance for the R8 explicit recorded-parent
 * reconnect facade (docs/internals/dokkabi-branches-r8.md): resumeWorkbenchSession
 * is the ONLY non-Send recovery seam. A genuine service disposal followed by
 * one explicit resume makes the exact persisted parent live again with ZERO
 Sends, decision starts or allocations, and a repeat resumes no duplicate
 * session; ordinary providers, missing bindings, unregistered/disabled
 * instances and unreadable instance state never reach recovery (unsupported
 * or fail-closed unknown); a missing, foreign or mode-mismatched orchestration
 * shell refuses BEFORE any startup effect; and a persisted sourceMismatch
 * latch, a replaced session generation, a replaced workspace or a failed
 * durable publication answer unknown — never an invented session and never
 * available.
 *
 * @module provider/Layers/ProviderService.resume.test
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
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
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
const TOKEN_ENV = "DOKKABI_RESUME_SERVICE_TEST_TOKEN";
const PARENT_THREAD = ThreadId.make("thread-resume-parent");
const CLIENT_ID = "dokkabi-resume-service-test";

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

// ---------------------------------------------------------------------------
// Test stack (mirrors ProviderService.overview.test.ts / .branch.test.ts):
// a failing-not-dying registry double so the None/fail-closed paths are
// exercisable, plus a projection read-model double carrying thread shells.
// ---------------------------------------------------------------------------

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
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}): OrchestrationThreadShell =>
  ({
    id: input.id,
    projectId: "proj-resume-1",
    title: "shell",
    modelSelection: { instanceId: input.instanceId },
    runtimeMode: input.runtimeMode ?? "full-access",
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

const projectionLayer = (input: { readonly parentShell: OrchestrationThreadShell | null }) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        input.parentShell !== null && String(threadId) === String(input.parentShell.id)
          ? Option.some(input.parentShell)
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);

/** Registry double whose unknown instances FAIL (like the real registry), so
 * the resume facade's fail-closed paths are reachable; instance info can be
 * forced to fail or report disabled for the same purpose. */
const makeStaticRegistry = (
  entries: ReadonlyArray<readonly [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>]>,
  behavior?: {
    readonly failInstanceInfo?: boolean;
    readonly disabled?: boolean;
  },
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
      if (adapter === undefined) {
        return unsupported(instanceId);
      }
      if (behavior?.failInstanceInfo) {
        return unsupported(instanceId);
      }
      return Effect.succeed({
        instanceId,
        driverKind: adapter.provider,
        displayName: undefined,
        enabled: !(behavior?.disabled ?? false),
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

/** Application spy WITHOUT the harness workspace capability — the default provider. */
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
    sendTurn: () => Effect.die("spy sendTurn must not run for the resume facade"),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => Effect.die("spy readThread must not run for the resume facade"),
    rollbackThread: () => Effect.die("unsupported"),
    stopAll: () => Effect.void,
    streamEvents: Effect.die("spy stream must not run"),
  } as unknown as ProviderAdapterShape<ProviderAdapterError>;
  return { adapter, started };
};

const buildStack = (input: {
  readonly dbPath: string;
  readonly registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"];
  readonly parentShell: OrchestrationThreadShell | null;
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
      Layer.provide(projectionLayer({ parentShell: input.parentShell })),
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
        gatewayUrl: "ws://127.0.0.1:4173",
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

/** First incarnation: start the PARENT through the real service (binding
 * persists automatically), then genuinely DISPOSE the layer — its finalizer
 * runs stopAll, which persists the final snapshot and detaches the gateway
 * owner binding exactly like an app restart. */
const startParentThenDispose = (gateway: FakeGateway, dbPath: string) =>
  Effect.gen(function* () {
    const adapter = yield* acquireHarnessAdapter(gateway);
    const layer = buildStack({
      dbPath,
      registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
      parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
      harnessRoot: gateway.workspacePath,
    });
    yield* Effect.gen(function* () {
      const service = yield* ProviderService.ProviderService;
      yield* service.startSession(PARENT_THREAD, {
        provider: ProviderDriverKind.make("dokkabi"),
        providerInstanceId: HARNESS_INSTANCE,
        threadId: PARENT_THREAD,
        runtimeMode: "full-access",
      } as Parameters<typeof service.startSession>[1]);
    }).pipe(Effect.scoped, Effect.provide(layer));
    // Genuine dispose: the gateway holds no owner binding any more.
    expect(gateway.binding).toBeUndefined();
  });

describe("ProviderService.resumeWorkbenchSession (R8 facade)", () => {
  it.live(
    "an ordinary application provider with a persisted binding reports unsupported without any recovery",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-resume-ordinary-"), "orchestration.sqlite");
        const spy = makeAppSpyAdapter();
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[APP_INSTANCE, spy.adapter]]),
          parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(APP_INSTANCE) }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: APP_DRIVER,
            providerInstanceId: APP_INSTANCE,
            status: "stopped",
            resumeCursor: {
              binding: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
              sessionId: "app-1",
            },
          });
          const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(result.state).toBe("unsupported");
          expect(result.reason).toContain("harness-recorded workspace");
          expect(spy.started).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live("a thread with no persisted binding reports unsupported", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-unbound-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("No provider binding");
        expect(gateway.requestsFor("workbench.handshake")).toHaveLength(0);
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("an unregistered recorded instance reports unsupported", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-unregistered-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: PARENT_THREAD,
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: REMOVED_INSTANCE,
          status: "stopped",
          resumeCursor: {
            binding: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
            sessionId: "session-1",
          },
        });
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("not registered");
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("an unreadable instance state fails closed as unknown without recovery", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-unreadable-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]], { failInstanceInfo: true }),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: PARENT_THREAD,
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          status: "stopped",
          resumeCursor: {
            binding: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
            sessionId: "session-1",
          },
        });
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unknown");
        expect(result.reason).toContain("could not be read");
        expect(gateway.requestsFor("workbench.handshake")).toHaveLength(0);
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a disabled instance reports unsupported without recovery", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-disabled-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]], { disabled: true }),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: PARENT_THREAD,
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          status: "stopped",
          resumeCursor: {
            binding: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
            sessionId: "session-1",
          },
        });
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("disabled");
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "a missing orchestration shell refuses BEFORE any startup effect — a deleted thread never resurrects",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-resume-no-shell-"), "orchestration.sqlite");
        const gateway = new FakeGateway();
        const adapter = yield* acquireHarnessAdapter(gateway);
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          parentShell: null,
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: PARENT_THREAD,
            provider: ProviderDriverKind.make("dokkabi"),
            providerInstanceId: HARNESS_INSTANCE,
            runtimeMode: "full-access",
            status: "stopped",
            resumeCursor: {
              binding: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
              sessionId: "session-1",
            },
          });
          const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(result.state).toBe("unknown");
          expect(result.reason).toContain("not an active orchestration thread");
          expect(gateway.requestsFor("workbench.handshake")).toHaveLength(0);
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live("a foreign shell instance refuses instead of switching sources", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-foreign-shell-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(APP_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: PARENT_THREAD,
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          runtimeMode: "full-access",
          status: "stopped",
          resumeCursor: {
            binding: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
            sessionId: "session-1",
          },
        });
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unknown");
        expect(result.reason).toContain("targets provider instance");
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a runtime-mode mismatch between shell and recorded binding refuses", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-mode-mismatch-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        parentShell: threadShell({
          id: PARENT_THREAD,
          instanceId: String(HARNESS_INSTANCE),
          runtimeMode: "auto",
        }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: PARENT_THREAD,
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          runtimeMode: "full-access",
          status: "stopped",
          resumeCursor: {
            binding: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
            sessionId: "session-1",
          },
        });
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unknown");
        expect(result.reason).toContain("runtime mode");
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "genuine disposal then ONE explicit resume makes the persisted parent live with zero Sends or starts; repeat starts nothing",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-resume-live-"), "orchestration.sqlite");
        const gateway = new FakeGateway();
        yield* startParentThenDispose(gateway, dbPath);

        // Post-restart incarnation: a fresh adapter over the same gateway,
        // the same durable directory, no live session state.
        const adapter = yield* acquireHarnessAdapter(gateway);
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          // The retained read observes the detached source WITHOUT binding.
          const detached = yield* service.getWorkbenchOverview(PARENT_THREAD);
          expect(detached.status).toBe("unavailable");
          expect(gateway.binding).toBeUndefined();

          const resumed = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(resumed.state).toBe("available");
          expect(resumed.reason).toBeUndefined();
          expect(gateway.binding).toEqual({ clientId: CLIENT_ID, threadId: String(PARENT_THREAD) });
          expect(yield* adapter.hasSession(PARENT_THREAD)).toBe(true);

          // Recorded reads are live again through the SAME owner.
          const after = yield* service.getWorkbenchOverview(PARENT_THREAD);
          expect(after.status).not.toBe("unavailable");

          // Repeat: idempotent, write-free on the gateway — no duplicate
          // session (no second handshake/bind), still zero Sends.
          const bindsAfterResume = gateway.requestsFor("workbench.bind").length;
          const handshakesAfterResume = gateway.requestsFor("workbench.handshake").length;
          const again = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(again.state).toBe("available");
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(bindsAfterResume);
          expect(gateway.requestsFor("workbench.handshake")).toHaveLength(handshakesAfterResume);

          expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "explicit reconnect repairs lost gateway binding while the same cached adapter remains alive",
    () =>
      Effect.gen(function* () {
        const gateway = new FakeGateway();
        const adapter = yield* acquireHarnessAdapter(gateway);
        const layer = buildStack({
          dbPath: NodePath.join(makeTempDir("t3-resume-cached-loss-"), "orchestration.sqlite"),
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          yield* service.startSession(PARENT_THREAD, {
            provider: ProviderDriverKind.make("dokkabi"),
            providerInstanceId: HARNESS_INSTANCE,
            threadId: PARENT_THREAD,
            runtimeMode: "full-access",
          });
          const errorEvent = yield* service.streamEvents.pipe(
            Stream.filter(
              (event) =>
                event.threadId === PARENT_THREAD &&
                event.type === "session.state.changed" &&
                event.payload.state === "error",
            ),
            Stream.runHead,
            Effect.timeout("2 seconds"),
            Effect.forkChild({ startImmediately: true }),
          );
          gateway.binding = undefined; // Remote binding loss; do not dispose the local adapter.
          expect(Option.isSome(yield* Fiber.join(errorEvent))).toBe(true);
          expect(yield* adapter.hasSession(PARENT_THREAD)).toBe(true);
          expect((yield* service.getWorkbenchOverview(PARENT_THREAD)).status).toBe("unavailable");
          const binds = gateway.requestsFor("workbench.bind").length;
          const resumed = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(resumed.state).toBe("available");
          expect(gateway.binding).toEqual({ clientId: CLIENT_ID, threadId: String(PARENT_THREAD) });
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(binds + 1);
          expect((yield* service.getWorkbenchOverview(PARENT_THREAD)).status).toBe("available");
          const verifiedReads = gateway.requestsFor("workbench.overview").length;
          expect((yield* service.resumeWorkbenchSession(PARENT_THREAD)).state).toBe("available");
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(binds + 1);
          expect(gateway.requestsFor("workbench.overview").length).toBeGreaterThan(verifiedReads);
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  for (const refusal of [
    "unsupported",
    "transient",
    "foreign",
    "malformed",
    "still-absent",
    "post-lost",
  ] as const) {
    it.live(
      `explicit reconnect refuses ${refusal} remote proof without claiming cached availability`,
      () =>
        Effect.gen(function* () {
          const gateway = new FakeGateway();
          const adapter = yield* acquireHarnessAdapter(gateway);
          const layer = buildStack({
            dbPath: NodePath.join(
              makeTempDir(`t3-resume-proof-${refusal}-`),
              "orchestration.sqlite",
            ),
            registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
            parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
            harnessRoot: gateway.workspacePath,
          });
          yield* Effect.gen(function* () {
            const service = yield* ProviderService.ProviderService;
            yield* service.startSession(PARENT_THREAD, {
              provider: ProviderDriverKind.make("dokkabi"),
              providerInstanceId: HARNESS_INSTANCE,
              threadId: PARENT_THREAD,
              runtimeMode: "full-access",
            });
            const binds = gateway.requestsFor("workbench.bind").length;
            const original = gateway.dispatch.bind(gateway);
            let proofReads = 0;
            gateway.dispatch = (method, params, socket, requestId) => {
              if (method !== "workbench.overview")
                return original(method, params, socket, requestId);
              proofReads += 1;
              gateway.requests.push({ method, params });
              if (refusal === "post-lost" && proofReads === 1)
                return original(method, params, socket, requestId);
              if (refusal === "malformed") {
                socket.reply(requestId, { result: { invalid: true } });
                return;
              }
              if (refusal === "foreign") {
                const oldSession = gateway.sessionId;
                gateway.sessionId = "foreign-proof-session";
                try {
                  original(method, params, socket, requestId);
                } finally {
                  gateway.sessionId = oldSession;
                }
              } else {
                socket.reply(requestId, {
                  error: {
                    code: refusal === "unsupported" ? -32601 : -32603,
                    message:
                      refusal === "unsupported"
                        ? "Method not found: workbench.overview"
                        : refusal === "transient"
                          ? "temporary gateway read failure"
                          : "no workbench binding — call workbench.bind first",
                  },
                });
              }
            };
            const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
            expect(result.state).toBe("unknown");
            expect(proofReads).toBeGreaterThan(0);
            expect(result.reason).toBeTruthy();
            expect(gateway.requestsFor("workbench.bind")).toHaveLength(
              binds + (refusal === "still-absent" ? 1 : 0),
            );
            expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
          }).pipe(Effect.scoped, Effect.provide(layer));
        }),
    );
  }

  it.live("cached quarantine with available remote overview is refused by validated startup", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.addAssistantCard("Retained source history.");
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath: NodePath.join(makeTempDir("t3-resume-cached-quarantine-"), "orchestration.sqlite"),
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        yield* service.startSession(PARENT_THREAD, {
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          threadId: PARENT_THREAD,
          runtimeMode: "full-access",
        });
        const generation = gateway.sessionGeneration;
        const errorEvent = yield* service.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === PARENT_THREAD &&
              event.type === "session.state.changed" &&
              event.payload.state === "error",
          ),
          Stream.runHead,
          Effect.timeout("2 seconds"),
          Effect.forkChild({ startImmediately: true }),
        );
        gateway.flipGeneration("quarantined-replacement");
        expect(Option.isSome(yield* Fiber.join(errorEvent))).toBe(true);
        gateway.sessionGeneration = generation;
        const cached = (yield* adapter.listSessions()).find(
          (session) => session.threadId === PARENT_THREAD,
        )!;
        expect(cached.status).toBe("error");
        expect((cached.resumeCursor as Record<string, unknown>).sourceMismatch).toBe(true);
        expect((yield* service.getWorkbenchOverview(PARENT_THREAD)).status).toBe("available");
        const binds = gateway.requestsFor("workbench.bind").length;
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unknown");
        expect(result.reason).toMatch(/replaced or truncated|source mismatch/i);
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(binds);
        expect(
          ((yield* adapter.listSessions())[0]!.resumeCursor as Record<string, unknown>)
            .sourceMismatch,
        ).toBe(true);
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "a newly quarantined first reconnect read never acknowledges an available error snapshot",
    () =>
      Effect.gen(function* () {
        const gateway = new FakeGateway();
        gateway.addAssistantCard("Retained history before source replacement.");
        const adapter = yield* acquireHarnessAdapter(gateway);
        const layer = buildStack({
          dbPath: NodePath.join(
            makeTempDir("t3-resume-first-read-quarantine-"),
            "orchestration.sqlite",
          ),
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          yield* service.startSession(PARENT_THREAD, {
            provider: ProviderDriverKind.make("dokkabi"),
            providerInstanceId: HARNESS_INSTANCE,
            threadId: PARENT_THREAD,
            runtimeMode: "full-access",
          });
          gateway.binding = undefined;
          const original = gateway.dispatch.bind(gateway);
          const oldGeneration = gateway.sessionGeneration;
          let replaced = false;
          gateway.dispatch = (method, params, socket, id) => {
            if (method === "workbench.bind") {
              gateway.flipGeneration("new-first-read-replacement");
              replaced = true;
            }
            original(method, params, socket, id);
            // The first startup read sees replacement. Restoring a readable
            // source afterward cannot clear the authoritative quarantine latch.
            if (method === "workbench.read" && replaced) {
              gateway.sessionGeneration = oldGeneration;
              replaced = false;
            }
          };
          const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          const cached = (yield* adapter.listSessions())[0]!;
          expect(cached.status).toBe("error");
          expect((cached.resumeCursor as Record<string, unknown>).sourceMismatch).toBe(true);
          expect((yield* service.getWorkbenchOverview(PARENT_THREAD)).status).toBe("available");
          expect(result.state).toBe("unknown");
          expect(result.reason).toMatch(/source mismatch|replaced or truncated/i);
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "explicit reconnect without remote overview capability is unsupported before startup",
    () =>
      Effect.gen(function* () {
        const gateway = new FakeGateway();
        const dbPath = NodePath.join(makeTempDir("t3-resume-no-proof-"), "orchestration.sqlite");
        yield* startParentThenDispose(gateway, dbPath);
        const realAdapter = yield* acquireHarnessAdapter(gateway);
        const adapter = { ...realAdapter };
        delete adapter.readWorkbenchOverview;
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const binds = gateway.requestsFor("workbench.bind").length;
          expect((yield* service.resumeWorkbenchSession(PARENT_THREAD)).state).toBe("unsupported");
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(binds);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "a persisted sourceMismatch latch answers unknown — the source is never resurrected",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(
          makeTempDir("t3-resume-source-mismatch-"),
          "orchestration.sqlite",
        );
        const gateway = new FakeGateway();
        yield* startParentThenDispose(gateway, dbPath);
        const adapter = yield* acquireHarnessAdapter(gateway);
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
          parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const binding = Option.getOrThrow(yield* directory.getBinding(PARENT_THREAD));
          const latched = {
            ...(binding.resumeCursor as Record<string, unknown>),
            sourceMismatch: true,
          };
          yield* directory.upsert({ ...binding, resumeCursor: latched });
          const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(result.state).toBe("unknown");
          expect(result.reason).toContain("replaced or truncated");
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live("a replaced session generation answers unknown instead of binding another session", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-generation-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      yield* startParentThenDispose(gateway, dbPath);
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const binding = Option.getOrThrow(yield* directory.getBinding(PARENT_THREAD));
        const replaced = {
          ...(binding.resumeCursor as Record<string, unknown>),
          sessionId: "session-from-another-generation",
        };
        yield* directory.upsert({ ...binding, resumeCursor: replaced });
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unknown");
        expect(result.reason).toContain("Resume state names session");
        expect(gateway.binding).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a replaced workspace answers unknown instead of redirecting the session", () =>
    Effect.gen(function* () {
      const dbPath = NodePath.join(makeTempDir("t3-resume-workspace-"), "orchestration.sqlite");
      const gateway = new FakeGateway();
      yield* startParentThenDispose(gateway, dbPath);
      const adapter = yield* acquireHarnessAdapter(gateway);
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
        harnessRoot: gateway.workspacePath,
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const binding = Option.getOrThrow(yield* directory.getBinding(PARENT_THREAD));
        yield* directory.upsert({
          ...binding,
          runtimePayload: {
            ...(binding.runtimePayload ?? {}),
            cwd: "/tmp/dokkabi-moved-workspace",
          },
        });
        const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
        expect(result.state).toBe("unknown");
        expect(result.reason).toContain("owns workspace");
        expect(gateway.binding).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "a failed durable publication after a successful startup answers unknown, never available",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(
          makeTempDir("t3-resume-persist-fail-"),
          "orchestration.sqlite",
        );
        const gateway = new FakeGateway();
        yield* startParentThenDispose(gateway, dbPath);
        const realAdapter = yield* acquireHarnessAdapter(gateway);
        // Persistence-failure injection: the adapter hides the parent from
        // listSessions, so the serialized snapshot boundary cannot attest the
        // resumed session and the recovery is refused.
        const hidingAdapter: ProviderAdapterShape<ProviderAdapterError> = {
          ...realAdapter,
          listSessions: () =>
            Effect.map(realAdapter.listSessions(), (sessions) =>
              sessions.filter((session) => session.threadId !== PARENT_THREAD),
            ),
        };
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, hidingAdapter]]),
          parentShell: threadShell({ id: PARENT_THREAD, instanceId: String(HARNESS_INSTANCE) }),
          harnessRoot: gateway.workspacePath,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const result = yield* service.resumeWorkbenchSession(PARENT_THREAD);
          expect(result.state).toBe("unknown");
          expect(result.reason).toContain("refused");
          expect(result.reason!.length).toBeLessThanOrEqual(2000);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );
});
