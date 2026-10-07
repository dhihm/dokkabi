/**
 * Targeted ProviderService acceptance for the R4 recorded-graph facade
 * (docs/internals/dokkabi-graphs-r4.md): getWorkbenchGraph resolves the
 * persisted binding and the registered ACTUAL instance with no recovery,
 * bind or model effect. An unbound thread reports unsupported; a provider
 * without the read capability reports unsupported — neither is empty
 * success; a detached Dokkabi source reports unavailable; the Dokkabi
 * thread routes through its persisted provider instance and returns the
 * recorded graph for the requested closed graph type.
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
  type WorkbenchCode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
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
import type { ProviderAdapterError, ProviderServiceError } from "../Errors.ts";
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
const APP_DRIVER = ProviderDriverKind.make("codex");
const TOKEN_ENV = "DOKKABI_GRAPH_SERVICE_TEST_TOKEN";

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

/** Application spy WITHOUT the graph capability — the default provider. */
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
    sendTurn: vi.fn(() => Effect.die("spy sendTurn must not run for graph reads")),
    interruptTurn: vi.fn(() => Effect.void),
    respondToRequest: vi.fn(() => Effect.void),
    respondToUserInput: vi.fn(() => Effect.void),
    stopSession: vi.fn(() => Effect.void),
    listSessions: vi.fn(() => Effect.succeed([])),
    hasSession: vi.fn(() => Effect.succeed(false)),
    readThread: vi.fn(() => Effect.die("spy readThread must not run for graph reads")),
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
        : Effect.die(`unknown instance ${String(instanceId)} in the graph test registry`);
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
  identity = { instanceId: HARNESS_INSTANCE, clientId: "dokkabi-graph-service-test" },
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
        instanceId: identity.instanceId,
      },
      {
        clientId: identity.clientId,
        pollIntervalMs: 25,
        cancelSettlementWaitMs: 150,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
  });

describe("ProviderService.getWorkbenchGraph (R4 facade)", () => {
  it.live(
    "a thread with no provider binding reports unsupported (hidden), not an error or empty success",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-graph-unbound-"), "orchestration.sqlite");
        const layer = buildStack({
          dbPath,
          registry: makeStaticRegistry([[APP_INSTANCE, makeAppSpyAdapter()]]),
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const result = yield* service.getWorkbenchGraph(
            ThreadId.make("thread-never-bound"),
            "work",
          );
          expect(result.status).toBe("unsupported");
          expect(result.reason).toContain("No provider binding");
          expect(result.graph).toBeUndefined();
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "a capability-less provider reports unsupported without recovery or session effects",
    () =>
      Effect.gen(function* () {
        const dbPath = NodePath.join(makeTempDir("t3-graph-unsupported-"), "orchestration.sqlite");
        const spy = makeAppSpyAdapter();
        const layer = buildStack({ dbPath, registry: makeStaticRegistry([[APP_INSTANCE, spy]]) });
        const thread = ThreadId.make("thread-app-owned");
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: thread,
            provider: APP_DRIVER,
            providerInstanceId: APP_INSTANCE,
          });
          const result = yield* service.getWorkbenchGraph(thread, "context");
          expect(result.status).toBe("unsupported");
          expect(result.reason).toContain("no recorded workbench graph capability");
          expect(result.graph).toBeUndefined();
          // A read never wakes the writer path.
          expect(spy.startSession).toHaveBeenCalledTimes(0);
          expect(spy.sendTurn).toHaveBeenCalledTimes(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live("a detached Dokkabi source reports unavailable while the binding persists", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* acquireHarnessAdapter(gateway);
      const dbPath = NodePath.join(makeTempDir("t3-graph-detached-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
        harnessRoot: gateway.workspacePath,
      });
      const thread = ThreadId.make("thread-dokkabi-graph-detached");
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        yield* service.startSession(thread, {
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          threadId: thread,
          runtimeMode: "full-access",
        } as Parameters<typeof service.startSession>[1]);
        // The gateway restarted: its binding is gone while ours persists.
        gateway.binding = undefined;
        const result = yield* service.getWorkbenchGraph(thread, "work");
        expect(result.status).toBe("unavailable");
        expect(result.reason).toContain("not currently bound");
        expect(result.graph).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live("a Dokkabi thread routes through its persisted instance to the recorded graph", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* acquireHarnessAdapter(gateway);
      const dbPath = NodePath.join(makeTempDir("t3-graph-routed-"), "orchestration.sqlite");
      const layer = buildStack({
        dbPath,
        registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
        harnessRoot: gateway.workspacePath,
      });
      const thread = ThreadId.make("thread-dokkabi-graph");
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        yield* service.startSession(thread, {
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          threadId: thread,
          runtimeMode: "full-access",
        } as Parameters<typeof service.startSession>[1]);
        const work = yield* service.getWorkbenchGraph(thread, "work");
        expect(work.status).toBe("available");
        expect(work.graph?.graphType).toBe("work");
        expect(work.graph?.graph.state).toBe("missing");
        const context = yield* service.getWorkbenchGraph(thread, "context");
        expect(context.status).toBe("available");
        expect(context.graph?.graphType).toBe("context");
        // The graph reads issued no writer calls, and each closed type was
        // requested exactly once.
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(1);
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
        const requests = gateway.requestsFor("workbench.graph");
        expect(requests).toHaveLength(2);
        expect(
          requests.map((request) => (request as { graphType: string }).graphType).sort(),
        ).toEqual(["context", "work"]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});

describe("E1-04 retained code routing and acknowledged pulls", () => {
  const hex = (seed: string) => NodeCrypto.createHash("sha256").update(seed).digest("hex");
  const code: WorkbenchCode = {
    version: 1,
    sessionCursor: {
      sessionId: "live-fake01",
      seq: 1,
      hash: hex("head"),
      generation: hex("generation-1"),
    },
    gatewayCursor: { seq: 1, hash: hex("gateway-1"), generation: hex("gateway-generation") },
    changed: false,
    resnapshot: false,
    versions: [],
    body: null,
  };
  const runBound = (
    run: (
      service: ProviderService.ProviderService["Service"],
      gateway: FakeGateway,
      directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
      thread: ThreadId,
    ) => Effect.Effect<void, ProviderServiceError, Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* acquireHarnessAdapter(gateway);
      const thread = ThreadId.make("thread-code-service");
      gateway.binding = { clientId: "dokkabi-graph-service-test", threadId: thread };
      gateway.codeResponse = code as unknown as Record<string, unknown>;
      const layer = buildStack({
        dbPath: NodePath.join(makeTempDir("dokkabi-code-service-"), "db.sqlite"),
        registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
      });
      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const service = yield* ProviderService.ProviderService;
        yield* directory.upsert({
          threadId: thread,
          provider: ProviderDriverKind.make("dokkabi"),
          providerInstanceId: HARNESS_INSTANCE,
          resumeCursor: {
            binding: gateway.binding,
            sessionId: gateway.sessionId,
            sessionCursor: code.sessionCursor,
            gatewayCursor: code.gatewayCursor,
          },
        });
        yield* run(service, gateway, directory, thread);
      }).pipe(Effect.scoped, Effect.provide(layer));
    });

  it.live("uses the persisted actual instance, with no writer recovery or cursor update", () =>
    runBound((service, gateway, directory, thread) =>
      Effect.gen(function* () {
        const before = yield* directory.getBinding(thread);
        const result = yield* service.getWorkbenchCode(thread, { after: code.sessionCursor });
        expect(result).toEqual({ status: "available", code });
        expect(yield* directory.getBinding(thread)).toEqual(before);
        expect(gateway.requests.map((r) => r.method)).toEqual(["workbench.code"]);
      }),
    ),
  );

  it.live("returns unsupported for unbound and capability-less threads without startSession", () =>
    Effect.gen(function* () {
      const spy = makeAppSpyAdapter(),
        thread = ThreadId.make("code-unsupported");
      const layer = buildStack({
        dbPath: NodePath.join(makeTempDir("code-unsupported-"), "db.sqlite"),
        registry: makeStaticRegistry([[APP_INSTANCE, spy]]),
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        expect((yield* service.getWorkbenchCode(thread, {})).status).toBe("unsupported");
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: thread,
          provider: APP_DRIVER,
          providerInstanceId: APP_INSTANCE,
        });
        expect((yield* service.subscribeWorkbenchCode(thread, code.sessionCursor)).status).toBe(
          "unsupported",
        );
        expect(spy.startSession).toHaveBeenCalledTimes(0);
        expect(spy.sendTurn).toHaveBeenCalledTimes(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "a quiet pull performs exactly two bounded reads; consumer absence creates no background poll",
    () =>
      runBound((service, gateway, _directory, thread) =>
        Effect.gen(function* () {
          const result = yield* service.subscribeWorkbenchCode(thread, code.sessionCursor);
          expect(result).toEqual({ status: "available", code });
          expect(gateway.requestsFor("workbench.code")).toHaveLength(2);
          yield* Effect.sleep("30 millis");
          expect(gateway.requestsFor("workbench.code")).toHaveLength(2);
        }),
      ),
  );

  it.live("interruption closes the pull before a second read and a later pull succeeds", () =>
    runBound((service, gateway, _directory, thread) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .subscribeWorkbenchCode(thread, code.sessionCursor)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("30 millis");
        yield* Fiber.interrupt(fiber);
        expect(gateway.requestsFor("workbench.code")).toHaveLength(1);
        const fresh = yield* service.getWorkbenchCode(thread, { after: code.sessionCursor });
        expect(fresh.status).toBe("available");
        expect(gateway.requestsFor("workbench.code")).toHaveLength(2);
      }),
    ),
  );

  it.live("a detached owner during the wait is unavailable instead of recovering the writer", () =>
    runBound((service, gateway, _directory, thread) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .subscribeWorkbenchCode(thread, code.sessionCursor)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("30 millis");
        gateway.binding = undefined;
        const result = yield* Fiber.join(fiber);
        expect(result.status).toBe("unavailable");
        expect(gateway.requests.map((r) => r.method)).toEqual(["workbench.code", "workbench.code"]);
      }),
    ),
  );

  it.live("a replaced source during the wait fails stale rather than splicing", () =>
    runBound((service, gateway, _directory, thread) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .subscribeWorkbenchCode(thread, code.sessionCursor)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("30 millis");
        gateway.codeResponse = {
          ...code,
          changed: true,
          resnapshot: true,
          sessionCursor: { ...code.sessionCursor, generation: hex("replacement") },
        };
        expect(Exit.isFailure(yield* Effect.exit(Fiber.join(fiber)))).toBe(true);
      }),
    ),
  );
});

describe("OC05 owned Code recovery service routing", () => {
  const hex = (seed: string) => NodeCrypto.createHash("sha256").update(seed).digest("hex");
  const action = {
    operation: "resume" as const,
    commandId: "recovery-service",
    expectedRevision: 1,
    newWindow: false,
  };
  const observer = {
    state: "active" as const,
    policyDigest: hex("policy"),
    paths: 1,
    checks: 2,
    reason: null,
    revision: 202,
    window: 1,
    lifetimeChecks: 10,
    retainedVersions: 2,
    retainedBytes: 50,
  };
  const installControl = (gateway: FakeGateway, clientId: string, thread: ThreadId) => {
    gateway.binding = { clientId, threadId: thread };
    const dispatch = gateway.dispatch.bind(gateway);
    gateway.dispatch = (method, params, socket, id) => {
      if (method === "workbench.handshake") {
        gateway.requests.push({ method, params });
        socket.reply(id, {
          result: {
            version: 1,
            workspacePath: gateway.workspacePath,
            sessionId: gateway.sessionId,
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
              codeAction: true,
            },
            route: gateway.route,
            model: gateway.model,
            ready: false,
            routeSource: "configured",
            kernelOpen: false,
            permissionMode: "bypass",
            bound: gateway.binding,
          },
        });
      } else if (method === "workbench.codeAction") {
        gateway.requests.push({ method, params });
        socket.reply(id, {
          result: {
            version: 1,
            state: "applied",
            receipt: {
              commandId: (params as { commandId: string }).commandId,
              seq: 201,
              hash: hex(clientId),
            },
            observer,
          },
        });
      } else dispatch(method, params, socket, id);
    };
  };
  const resume = (gateway: FakeGateway) => ({
    binding: gateway.binding,
    sessionId: gateway.sessionId,
    sessionCursor: {
      sessionId: gateway.sessionId,
      seq: 1,
      hash: hex("prefix"),
      generation: gateway.sessionGeneration,
    },
    gatewayCursor: { seq: 1, hash: hex("gateway-1"), generation: hex("gateway-generation") },
  });

  it.live("unbound and capability-less recovery stays unsupported without creating a writer", () =>
    Effect.gen(function* () {
      const spy = makeAppSpyAdapter(),
        thread = ThreadId.make("recovery-unsupported");
      const layer = buildStack({
        dbPath: NodePath.join(makeTempDir("recovery-unsupported-"), "db.sqlite"),
        registry: makeStaticRegistry([[APP_INSTANCE, spy]]),
      });
      yield* Effect.gen(function* () {
        const service = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        expect((yield* service.workbenchCodeAction(thread, action)).state).toBe("unsupported");
        yield* directory.upsert({
          threadId: thread,
          provider: APP_DRIVER,
          providerInstanceId: APP_INSTANCE,
        });
        expect((yield* service.workbenchCodeAction(thread, action)).state).toBe("unsupported");
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              service.workbenchCodeAction(thread, { ...action, root: "/foreign" } as never),
            ),
          ),
        ).toBe(true);
        expect(spy.startSession).not.toHaveBeenCalled();
        expect(spy.sendTurn).not.toHaveBeenCalled();
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.live(
    "two owned instances route recovery independently and keep persisted replay cursors unchanged",
    () =>
      Effect.gen(function* () {
        const a = new FakeGateway(),
          b = new FakeGateway();
        const threadA = ThreadId.make("recovery-owner-a"),
          threadB = ThreadId.make("recovery-owner-b");
        const instanceB = ProviderInstanceId.make("dokkabi-b");
        installControl(a, "dokkabi-graph-service-test", threadA);
        installControl(b, "owner-b", threadB);
        const adapterA = yield* acquireHarnessAdapter(a);
        const adapterB = yield* acquireHarnessAdapter(b, {
          instanceId: instanceB,
          clientId: "owner-b",
        });
        const layer = buildStack({
          dbPath: NodePath.join(makeTempDir("recovery-two-"), "db.sqlite"),
          registry: makeStaticRegistry([
            [HARNESS_INSTANCE, adapterA],
            [instanceB, adapterB],
          ]),
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          for (const [thread, instanceId, gateway] of [
            [threadA, HARNESS_INSTANCE, a],
            [threadB, instanceB, b],
          ] as const)
            yield* directory.upsert({
              threadId: thread,
              provider: ProviderDriverKind.make("dokkabi"),
              providerInstanceId: instanceId,
              resumeCursor: resume(gateway),
            });
          const beforeA = yield* directory.getBinding(threadA),
            beforeB = yield* directory.getBinding(threadB);
          const resultA = yield* service.workbenchCodeAction(threadA, action);
          expect(resultA.state).toBe("applied");
          expect(b.requests).toHaveLength(0);
          const resultB = yield* service.workbenchCodeAction(threadB, action);
          expect(resultB.state).toBe("applied");
          expect(a.requestsFor("workbench.codeAction")).toEqual([
            { version: 1, binding: a.binding, ...action },
          ]);
          expect(b.requestsFor("workbench.codeAction")).toEqual([
            { version: 1, binding: b.binding, ...action },
          ]);
          expect(yield* directory.getBinding(threadA)).toEqual(beforeA);
          expect(yield* directory.getBinding(threadB)).toEqual(beforeB);
          for (const gateway of [a, b]) {
            expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
            expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
            expect(gateway.requestsFor("workbench.code")).toHaveLength(0);
          }
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.live(
    "foreign persisted ownership or registered driver mismatch cannot mutate either instance",
    () =>
      Effect.gen(function* () {
        const gateway = new FakeGateway(),
          thread = ThreadId.make("recovery-foreign");
        installControl(gateway, "dokkabi-graph-service-test", thread);
        const adapter = yield* acquireHarnessAdapter(gateway);
        const layer = buildStack({
          dbPath: NodePath.join(makeTempDir("recovery-foreign-"), "db.sqlite"),
          registry: makeStaticRegistry([[HARNESS_INSTANCE, adapter]]),
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* directory.upsert({
            threadId: thread,
            provider: ProviderDriverKind.make("dokkabi"),
            providerInstanceId: HARNESS_INSTANCE,
            resumeCursor: {
              ...resume(gateway),
              binding: { clientId: "foreign-client", threadId: thread },
            },
          });
          expect(
            Exit.isFailure(yield* Effect.exit(service.workbenchCodeAction(thread, action))),
          ).toBe(true);
          yield* directory.upsert({
            threadId: thread,
            provider: APP_DRIVER,
            providerInstanceId: HARNESS_INSTANCE,
            resumeCursor: resume(gateway),
          });
          expect(
            Exit.isFailure(yield* Effect.exit(service.workbenchCodeAction(thread, action))),
          ).toBe(true);
          expect(gateway.requests).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );
});
