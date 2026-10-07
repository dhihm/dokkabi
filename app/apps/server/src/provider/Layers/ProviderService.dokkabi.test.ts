/**
 * Targeted ProviderService acceptance for the R2 harness boundary.
 *
 * Evidence classes covered here (bounded, not exhaustive mirrors):
 * 1. Single-authority workspace admission: an application-owned spy adapter
 *    never starts or sends inside a harness-owned root, a missing cwd is
 *    refused while claims exist, unrelated workspaces keep working, and a
 *    harness-declaring instance that the shared policy does not POSITIVELY
 *    attest is refused before any adapter/wire effect.
 * 2. Durable resume persistence against a REAL SQLite file: immediate
 *    settlement stores the CURRENT ready snapshot (activeTurnId null), an
 *    uncertain-but-proven submit and a quarantine latch survive an actual
 *    close/reopen over the same database file with a fresh adapter and
 *    service, without a duplicate kernel submit.
 * 3. Fail-closed persistence: an injected failure of the REAL directory
 *    write withholds the runtime event and fails the Send; a
 *    Send-vs-runtime persistence race cannot regress the newer cursor, and
 *    Stop still progresses while a locked write is parked.
 *
 * The harness adapter is the REAL DokkabiAdapter over the in-process
 * validated gateway double (a wire fixture — never live model evidence).
 * The application adapter is a spy. The shared ownership policy fixture is
 * used for admission only; the Live policy is independently verified by its
 * own strict and gate suites. Durability evidence is always the reopened
 * SQLite file, never an in-memory directory.
 *
 * @module provider/Layers/ProviderService.dokkabi.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
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
import {
  ProviderSessionDirectoryPersistenceError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { makeDokkabiAdapter } from "./DokkabiAdapter.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const HARNESS_INSTANCE = ProviderInstanceId.make("dokkabi");
const APP_INSTANCE = ProviderInstanceId.make("codex");
const APP_DRIVER = ProviderDriverKind.make("codex");
const TOKEN_ENV = "DOKKABI_SERVICE_TEST_TOKEN";

process.env[TOKEN_ENV] = "non-secret-test-fixture";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const asThreadId = (value: string) => ThreadId.make(value);

/**
 * Assertion-side narrowing of the persisted resume cursor (the adapter's
 * DokkabiResumeState JSON). Assertion narrowing only — fixtures themselves
 * never fake this shape.
 */
const cursorOf = (source: { readonly resumeCursor?: unknown }) =>
  source.resumeCursor as {
    sessionCursor?: { seq?: number };
    activeCommandId?: string;
    sourceMismatch?: boolean;
  };

const payloadOf = (binding: ProviderSessionDirectory.ProviderRuntimeBinding) =>
  (binding.runtimePayload ?? {}) as { activeTurnId?: string | null };

/** Shared workspace-policy fixture (admission only; Live policy verified separately). */
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

/** Instance-keyed static registry (same shape the existing service test uses). */
const makeStaticRegistry = (
  entries: ReadonlyArray<readonly [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>]>,
): ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] => {
  const adapters = new Map(entries);
  const unsupported = (instanceId: ProviderInstanceId) =>
    new ProviderUnsupportedError({ provider: ProviderDriverKind.make(String(instanceId)) });
  return {
    getByInstance: (instanceId) => {
      const adapter = adapters.get(instanceId);
      return adapter ? Effect.succeed(adapter) : Effect.fail(unsupported(instanceId));
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
        : Effect.fail(unsupported(instanceId));
    },
    listInstances: () => Effect.succeed([...adapters.keys()]),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

/** Application-owned spy adapter (default workspace lifecycle). */
const makeAppSpyAdapter = () => {
  const sessions = new Map<string, ProviderSession>();
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: APP_DRIVER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: vi.fn((input: ProviderSessionStartInput) =>
      Effect.sync(() => {
        const session: ProviderSession = {
          provider: APP_DRIVER,
          providerInstanceId: APP_INSTANCE,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          resumeCursor: { opaque: `app-resume-${String(input.threadId)}` },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        sessions.set(String(input.threadId), session);
        return session;
      }),
    ),
    sendTurn: vi.fn((input: ProviderSendTurnInput) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make("app-turn-1"),
      } satisfies ProviderTurnStartResult),
    ),
    interruptTurn: vi.fn(() => Effect.void),
    respondToRequest: vi.fn(() => Effect.void),
    respondToUserInput: vi.fn(() => Effect.void),
    stopSession: vi.fn((threadId: ThreadId) =>
      Effect.sync(() => {
        sessions.delete(String(threadId));
      }),
    ),
    listSessions: vi.fn(() => Effect.sync(() => [...sessions.values()])),
    hasSession: vi.fn((threadId: ThreadId) => Effect.succeed(sessions.has(String(threadId)))),
    readThread: vi.fn((threadId: ThreadId) => Effect.succeed({ threadId, turns: [] })),
    rollbackThread: vi.fn((threadId: ThreadId) => Effect.succeed({ threadId, turns: [] })),
    stopAll: vi.fn(() =>
      Effect.sync(() => {
        sessions.clear();
      }),
    ),
    streamEvents: Stream.empty,
  };
  return { adapter, sessions };
};

type DirectoryService = ProviderSessionDirectory.ProviderSessionDirectory["Service"];

/** Typed wrapper over the REAL SQLite directory: fails upserts while armed. */
const makeFailToggleDirectory = () => {
  const state = { fail: false };
  const wrap = (inner: DirectoryService): DirectoryService => ({
    ...inner,
    upsert: (binding, options) =>
      Effect.suspend(() =>
        state.fail
          ? Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.upsert",
                detail: "injected directory write failure",
              }),
            )
          : inner.upsert(binding, options),
      ),
  });
  return { state, wrap };
};

/**
 * Typed wrapper over the REAL SQLite directory: after `arm`, the first
 * `gates.length` upserts each park on their own Deferred (an `undefined`
 * entry lets that write pass) — controlled, deterministic ordering of the
 * serialized writers while real disk writes stay the authority. Gates must
 * always be released (tests release in `finally`) so teardown never parks.
 */
const makeGateDirectory = () => {
  const state: {
    count: number;
    gates: ReadonlyArray<Deferred.Deferred<string> | undefined>;
  } = { count: 0, gates: [] };
  const arm = (gates: ReadonlyArray<Deferred.Deferred<string> | undefined>): void => {
    state.count = 0;
    state.gates = gates;
  };
  const wrap = (inner: DirectoryService): DirectoryService => ({
    ...inner,
    upsert: (binding, options) =>
      Effect.gen(function* () {
        state.count += 1;
        const gate = state.count <= state.gates.length ? state.gates[state.count - 1] : undefined;
        if (gate !== undefined) {
          yield* Deferred.await(gate);
        }
        return yield* inner.upsert(binding, options);
      }),
  });
  return { arm, count: () => state.count, wrap };
};

/** Read-only stack over the SAME SQLite file: post-close durability checks. */
const directoryOnlyLayer = (dbPath: string) =>
  ProviderSessionDirectoryLive.pipe(
    Layer.provide(
      ProviderSessionRuntime.layer.pipe(
        Layer.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
  );

const buildStack = (input: {
  readonly dbPath: string;
  readonly registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"];
  readonly ownership: Layer.Layer<WorkspaceLifecycleOwnership>;
  readonly wrapDirectory?: (inner: DirectoryService) => DirectoryService;
}) => {
  const repositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(makeSqlitePersistenceLive(input.dbPath).pipe(Layer.provide(NodeServices.layer))),
  );
  const directoryLayer =
    input.wrapDirectory === undefined
      ? ProviderSessionDirectoryLive.pipe(Layer.provide(repositoryLayer))
      : Layer.effect(
          ProviderSessionDirectory.ProviderSessionDirectory,
          Effect.map(ProviderSessionDirectory.ProviderSessionDirectory, input.wrapDirectory),
        ).pipe(Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(repositoryLayer))));
  const serviceLayer = Layer.mergeAll(
    makeProviderServiceLive().pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, input.registry)),
      Layer.provide(directoryLayer),
      Layer.provide(input.ownership),
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
  return { serviceLayer };
};

/**
 * Real DokkabiAdapter over the shared gateway double; its unsafe scope is
 * closed with the surrounding test scope.
 */
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
        clientId: "dokkabi-service-test",
        pollIntervalMs: 25,
        cancelSettlementWaitMs: 150,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
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

const waitFor = async (
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

const assertAbsentWithin = async (
  windowMs: number,
  condition: () => boolean,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (condition()) throw new Error(`Unexpectedly observed ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

/** Repeatedly run an effect until its value satisfies the condition. */
const waitForEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  condition: (value: A) => boolean,
  timeoutMs: number,
  what: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    for (;;) {
      const value = yield* effect;
      if (condition(value)) return value;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`));
      }
      yield* Effect.sleep(20);
    }
  });

const expectRefusal = <A, E>(effect: Effect.Effect<A, E>, part: string): Effect.Effect<void> =>
  Effect.flatMap(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) {
      return Effect.die(new Error(`expected a refusal containing '${part}', but it succeeded`));
    }
    return Effect.sync(() => {
      const failure = Cause.findErrorOption(exit.cause);
      if (Option.isNone(failure)) throw new Error("expected a typed failure");
      const message =
        failure.value instanceof Error ? failure.value.message : String(failure.value);
      expect(message).toContain(part);
    });
  });

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("expected a typed failure");
  return failure.value;
};

describe("ProviderService harness boundary (R2 persistence acceptance)", () => {
  it.live(
    "refuses application-owned start and send inside a harness-owned root before adapter effects",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-harness-root-");
        NodeFS.mkdirSync(NodePath.join(harnessRoot, "project"), { recursive: true });
        const unrelated = makeTempDir("t3-app-unrelated-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const harness = yield* acquireHarnessAdapter(gateway);
        const spy = makeAppSpyAdapter();
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-admission-"), "orchestration.sqlite");
        const stack = buildStack({
          dbPath,
          registry: makeStaticRegistry([
            [HARNESS_INSTANCE, harness],
            [APP_INSTANCE, spy.adapter],
          ]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
        });

        const thread = asThreadId("thread-admission-app");
        const otherThread = asThreadId("thread-admission-nocwd");
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

          yield* expectRefusal(
            service.startSession(thread, {
              provider: APP_DRIVER,
              providerInstanceId: APP_INSTANCE,
              threadId: thread,
              runtimeMode: "full-access",
              cwd: NodePath.join(harnessRoot, "project"),
            }),
            "is owned by a harness provider",
          );
          expect(spy.adapter.startSession).toHaveBeenCalledTimes(0);

          yield* expectRefusal(
            service.startSession(thread, {
              provider: APP_DRIVER,
              providerInstanceId: APP_INSTANCE,
              threadId: thread,
              runtimeMode: "full-access",
            }),
            "no resolvable workspace",
          );
          expect(spy.adapter.startSession).toHaveBeenCalledTimes(0);

          const started = yield* service.startSession(thread, {
            provider: APP_DRIVER,
            providerInstanceId: APP_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: unrelated,
          });
          expect(started.status).toBe("ready");
          expect(spy.adapter.startSession).toHaveBeenCalledTimes(1);
          yield* service.sendTurn({ threadId: thread, input: "hello" });
          expect(spy.adapter.sendTurn).toHaveBeenCalledTimes(1);

          // A persisted binding whose cwd sits inside the harness root cannot
          // send: refused before the adapter (no recovery start either).
          yield* directory.upsert({
            threadId: thread,
            provider: APP_DRIVER,
            providerInstanceId: APP_INSTANCE,
            runtimePayload: { cwd: NodePath.join(harnessRoot, "elsewhere") },
          });
          yield* expectRefusal(
            service.sendTurn({ threadId: thread, input: "again" }),
            "is owned by a harness provider",
          );
          expect(spy.adapter.sendTurn).toHaveBeenCalledTimes(1);
          expect(spy.adapter.startSession).toHaveBeenCalledTimes(1);

          // Fresh binding with claims present but no establishable cwd: the
          // send refuses BEFORE session recovery runs the adapter.
          yield* directory.upsert({
            threadId: otherThread,
            provider: APP_DRIVER,
            providerInstanceId: APP_INSTANCE,
            runtimePayload: {},
          });
          yield* expectRefusal(
            service.sendTurn({ threadId: otherThread, input: "where" }),
            "no resolvable workspace",
          );
          expect(spy.adapter.startSession).toHaveBeenCalledTimes(1);
          expect(spy.adapter.sendTurn).toHaveBeenCalledTimes(1);
        }).pipe(Effect.scoped, Effect.provide(stack.serviceLayer));
      }),
  );

  it.live(
    "refuses a harness-declaring instance the shared policy does not attest, before any wire effect",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-harness-negative-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const harness = yield* acquireHarnessAdapter(gateway);
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-negative-"), "orchestration.sqlite");
        const stack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
          // Roots are claimed by SOME harness, but this instance is not attested.
          ownership: ownershipLayer({ roots: [harnessRoot], harnessInstances: [] }),
        });

        const thread = asThreadId("thread-harness-negative");
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

          yield* expectRefusal(
            service.startSession(thread, {
              providerInstanceId: HARNESS_INSTANCE,
              threadId: thread,
              runtimeMode: "full-access",
              cwd: harnessRoot,
            }),
            "does not attest",
          );
          expect(gateway.requestsFor("workbench.handshake")).toHaveLength(0);
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);

          // Even with a persisted binding for the unattested instance, the
          // Send refuses at admission before routing/recovery — nothing is
          // ever submitted to the kernel.
          yield* directory.upsert({
            threadId: thread,
            provider: ProviderDriverKind.make("dokkabi"),
            providerInstanceId: HARNESS_INSTANCE,
          });
          yield* expectRefusal(
            service.sendTurn({ threadId: thread, input: "refused" }),
            "does not attest",
          );
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
          expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
        }).pipe(Effect.scoped, Effect.provide(stack.serviceLayer));
      }),
  );

  it.live(
    "stores the CURRENT ready snapshot on immediate settlement, not the stale send receipt",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-settle-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const harness = yield* acquireHarnessAdapter(gateway);
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-settle-"), "orchestration.sqlite");
        const stack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
        });

        const thread = asThreadId("thread-settle");
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });

          const sendFiber = yield* Effect.forkChild(
            service.sendTurn({
              threadId: thread,
              commandId: CommandId.make("cmd-fast"),
              input: "run the build",
            }),
          );
          yield* Effect.promise(() =>
            waitFor(
              () => gateway.requestsFor("workbench.submit").length === 1,
              4000,
              "submit to reach the gateway",
            ),
          );
          gateway.settle("cmd-fast", "success");
          const turn = yield* Fiber.await(sendFiber);
          expect(Exit.isSuccess(turn)).toBe(true);

          // Converged durable state: the CURRENT settled snapshot — no active
          // command, no active turn, cursor at/after the settlement record.
          const binding = yield* waitForEffect(
            Effect.map(directory.getBinding(thread), Option.getOrThrow),
            (value) =>
              cursorOf(value).activeCommandId === undefined &&
              payloadOf(value).activeTurnId === null,
            4000,
            "settled snapshot without an active command",
          );
          const settlementSeq = gateway.commands.get("cmd-fast")?.sources["settlement"] as
            | number
            | undefined;
          expect(settlementSeq).toBeDefined();
          expect(cursorOf(binding).sessionCursor?.seq).toBeGreaterThanOrEqual(settlementSeq ?? 0);
          expect(gateway.commands.size).toBe(1);
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(stack.serviceLayer));
      }),
  );

  it.live(
    "persists an uncertain submit durably: a reopened SQLite file resumes the same binding without a duplicate submit",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-uncertain-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-uncertain-"), "orchestration.sqlite");
        const thread = asThreadId("thread-uncertain");
        const uncertainText = "uncertain payload";

        // Incarnation 1: the submit's response is lost after the handoff.
        gateway.submitMode = "drop";
        const first = yield* acquireHarnessAdapter(gateway);
        const firstStack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, first]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });
          const turn = yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-uncertain"),
            input: uncertainText,
          });
          expect(String(turn.turnId)).toBe("cmd-uncertain");

          const binding = yield* Effect.map(directory.getBinding(thread), Option.getOrThrow);
          expect(cursorOf(binding).activeCommandId).toBe("cmd-uncertain");
        }).pipe(Effect.scoped, Effect.provide(firstStack.serviceLayer));
        gateway.submitMode = "handed_off";
        // Exactly one submit crossed the wire; reconciliation never re-sent.
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);
        expect(gateway.commands.size).toBe(1);

        // Incarnation 2: fresh adapter/service/SQLite connection over the SAME
        // file. The reopened binding itself is the durability evidence.
        const second = yield* acquireHarnessAdapter(gateway);
        const secondStack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, second]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
        });
        const published: ProviderRuntimeEvent[] = [];
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

          const reopened = yield* Effect.map(directory.getBinding(thread), Option.getOrThrow);
          expect(cursorOf(reopened).activeCommandId).toBe("cmd-uncertain");

          // Subscribe BEFORE resuming: the resumed incarnation publishes
          // session.started and the still-active command's turn.started during
          // startSession itself.
          yield* Stream.runForEach(service.streamEvents, (event) =>
            Effect.sync(() => {
              published.push(event);
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          const resumed = yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
          });
          // The uncertain command is still active at the gateway: the thread
          // resumes RUNNING with the same active command.
          expect(resumed.status).toBe("running");
          expect(cursorOf(resumed).activeCommandId).toBe("cmd-uncertain");
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);

          // Dedup replay of the SAME command: reaches the gateway for its
          // receipt but creates NO second kernel command, and the turn stays
          // bound to the same id.
          const replay = yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-uncertain"),
            input: uncertainText,
          });
          expect(String(replay.turnId)).toBe("cmd-uncertain");
          expect(gateway.commands.size).toBe(1);
          expect(gateway.commands.get("cmd-uncertain")?.state).toBe("handed_off");

          // turn.started is published only after its durable persistence, and
          // the resumed incarnation publishes it for the still-active command.
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.started" && event.threadId === thread,
                ),
              4000,
              "resumed turn.started publication",
            ),
          );

          // Settle the active command before the unproven-submit probe: the
          // harness admits one active command at a time.
          gateway.settle("cmd-uncertain", "success");
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.completed" && event.threadId === thread,
                ),
              4000,
              "settlement before the unproven send",
            ),
          );

          // A submit whose handoff cannot be proven fails the Send with the
          // actual state already persisted — and is never retried.
          gateway.submitMode = "drop-unknown";
          const lostExit = yield* Effect.exit(
            service.sendTurn({
              threadId: thread,
              commandId: CommandId.make("cmd-lost"),
              input: "lost submit",
            }),
          );
          const lostError = failureOf(lostExit);
          const lostMessage = lostError instanceof Error ? lostError.message : String(lostError);
          expect(lostMessage).toContain("no provable handoff");
          expect(gateway.commands.has("cmd-lost")).toBe(false);
          expect(
            gateway
              .requestsFor("workbench.submit")
              .filter((params) => params.commandId === "cmd-lost"),
          ).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(secondStack.serviceLayer));
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(2);
      }),
  );

  it.live(
    "persists the quarantine latch before publication and a reopened file refuses resume and send",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-quarantine-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-quarantine-"), "orchestration.sqlite");
        const thread = asThreadId("thread-quarantine");

        const first = yield* acquireHarnessAdapter(gateway);
        const firstStack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, first]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
        });
        const published: ProviderRuntimeEvent[] = [];
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* Stream.runForEach(service.streamEvents, (event) =>
            Effect.sync(() => {
              published.push(event);
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });
          yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-q"),
            input: "later replaced",
          });
          gateway.settle("cmd-q", "success");
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.completed" && event.threadId === thread,
                ),
              4000,
              "settlement publication",
            ),
          );

          // The source log is replaced: the runtime-event persistence must
          // land the latch in the durable binding BEFORE the error event is
          // published.
          gateway.flipGeneration("generation-replaced");
          const latched = yield* waitForEffect(
            Effect.map(directory.getBinding(thread), Option.getOrThrow),
            (value) => cursorOf(value).sourceMismatch === true,
            4000,
            "quarantine latch on disk",
          );
          expect(cursorOf(latched).sourceMismatch).toBe(true);
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "session.state.changed" && event.threadId === thread,
                ),
              4000,
              "quarantine error publication",
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(firstStack.serviceLayer));

        // Restart over the SAME file: the latched cursor refuses resume and no
        // submit ever reaches the kernel.
        const second = yield* acquireHarnessAdapter(gateway);
        const secondStack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, second]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
        });
        const submitsBefore = gateway.requestsFor("workbench.submit").length;
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const reopened = yield* Effect.map(directory.getBinding(thread), Option.getOrThrow);
          expect(cursorOf(reopened).sourceMismatch).toBe(true);

          yield* expectRefusal(
            service.startSession(thread, {
              providerInstanceId: HARNESS_INSTANCE,
              threadId: thread,
              runtimeMode: "full-access",
            }),
            "replaced or truncated",
          );
          yield* expectRefusal(
            service.sendTurn({ threadId: thread, input: "after quarantine" }),
            "replaced or truncated",
          );
        }).pipe(Effect.scoped, Effect.provide(secondStack.serviceLayer));
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(submitsBefore);
      }),
  );

  it.live(
    "fails the Send closed and withholds runtime events when the actual directory write fails",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-failwrite-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const harness = yield* acquireHarnessAdapter(gateway);
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-failwrite-"), "orchestration.sqlite");
        const failToggle = makeFailToggleDirectory();
        const stack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
          wrapDirectory: failToggle.wrap,
        });

        const thread = asThreadId("thread-failwrite");
        const published: ProviderRuntimeEvent[] = [];
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* Stream.runForEach(service.streamEvents, (event) =>
            Effect.sync(() => {
              published.push(event);
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });
          yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-ok"),
            input: "healthy send",
          });
          // Stream wiring + healthy persistence proven before the injection.
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.started" && event.threadId === thread,
                ),
              4000,
              "healthy turn.started publication",
            ),
          );
          gateway.settle("cmd-ok", "success");
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.completed" && event.threadId === thread,
                ),
              4000,
              "healthy settlement publication",
            ),
          );

          failToggle.state.fail = true;
          const failedExit = yield* Effect.exit(
            service.sendTurn({
              threadId: thread,
              commandId: CommandId.make("cmd-fail"),
              input: "doomed send",
            }),
          );
          const failure = failureOf(failedExit);
          const isPersistenceError = Schema.is(ProviderSessionDirectoryPersistenceError);
          expect(isPersistenceError(failure)).toBe(true);
          if (isPersistenceError(failure)) {
            expect(failure.detail).toContain("injected");
          }

          // The kernel DID receive the submit (honest uncertain state), the
          // service never blind-retried it, and the durable row was NOT
          // advanced onto cmd-fail's cursor.
          expect(gateway.commands.get("cmd-fail")?.state).toBe("handed_off");
          expect(
            gateway
              .requestsFor("workbench.submit")
              .filter((params) => params.commandId === "cmd-fail"),
          ).toHaveLength(1);
          const binding = yield* Effect.map(directory.getBinding(thread), Option.getOrThrow);
          expect(cursorOf(binding).activeCommandId).toBeUndefined();

          // turn.started for cmd-fail was WITHHELD: its durable recovery was
          // never established, so it must never appear as published.
          yield* Effect.promise(() =>
            assertAbsentWithin(
              1500,
              () =>
                published.some(
                  (event) =>
                    event.type === "turn.started" &&
                    event.threadId === thread &&
                    String(event.turnId ?? "").includes("cmd-fail"),
                ),
              "withheld turn.started for cmd-fail",
            ),
          );
          failToggle.state.fail = false;
        }).pipe(Effect.scoped, Effect.provide(stack.serviceLayer));
      }),
  );

  it.live(
    "keeps the final SQLite row non-regressed under a forced Send-vs-runtime write race while Stop still progresses",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-race-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const harness = yield* acquireHarnessAdapter(gateway);
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-race-"), "orchestration.sqlite");
        const gateDirectory = makeGateDirectory();
        const stack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
          wrapDirectory: gateDirectory.wrap,
        });

        const thread = asThreadId("thread-race");
        const raceText = "race payload";
        const published: ProviderRuntimeEvent[] = [];
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* Stream.runForEach(service.streamEvents, (event) =>
            Effect.sync(() => {
              published.push(event);
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });
          yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-race"),
            input: raceText,
          });
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.started" && event.threadId === thread,
                ),
              4000,
              "first turn.started publication",
            ),
          );

          gateway.settle("cmd-race", "success");
          const settlementSeq = gateway.commands.get("cmd-race")?.sources["settlement"] as
            | number
            | undefined;
          expect(settlementSeq).toBeDefined();

          // Arm the deterministic interleave: the SECOND directory upsert
          // (whichever of the Send final write or the runtime-event
          // persistence it is) parks until released. The gate is ALWAYS
          // released (finally) so no teardown step can park on it.
          const gate = Deferred.makeUnsafe<string>();
          gateDirectory.arm([undefined, gate]);
          const replayFiber = yield* Effect.forkChild(
            service.sendTurn({
              threadId: thread,
              commandId: CommandId.make("cmd-race"),
              input: raceText,
            }),
          );
          let intermediateSeq = 0;
          try {
            yield* Effect.promise(() =>
              waitFor(
                () => gateDirectory.count() >= 2,
                4000,
                "both locked writers to enter the directory",
              ),
            );

            // The first writer's row is already durable on the real file.
            const intermediate = yield* waitForEffect(
              Effect.map(directory.getBinding(thread), Option.getOrThrow),
              (value) => (cursorOf(value).sessionCursor?.seq ?? 0) >= (settlementSeq ?? 0),
              4000,
              "intermediate converged row",
            );
            intermediateSeq = cursorOf(intermediate).sessionCursor?.seq ?? 0;

            // NOTE: stop deliberately does NOT bypass the parked writer — an
            // unlocked stop write was the original stale-cursor defect. The
            // lock-is-never-held-across-adapter-execution proof lives in the
            // detach-race regression (the poller latches while locked).
          } finally {
            yield* Deferred.succeed(gate, "release");
          }
          const replayExit = yield* Fiber.await(replayFiber);
          expect(Exit.isSuccess(replayExit)).toBe(true);

          // The runtime settlement publication completes around the parked
          // writer — the lock never blocked it from being observed.
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.completed" && event.threadId === thread,
                ),
              4000,
              "turn.completed publication after the race",
            ),
          );

          // Final row on the REAL file: stable converged snapshot — at or
          // after the settlement and the intermediate write, with no active
          // command or turn regressed onto it.
          const finalBinding = yield* waitForEffect(
            Effect.map(directory.getBinding(thread), Option.getOrThrow),
            (value) =>
              (cursorOf(value).sessionCursor?.seq ?? 0) >=
                Math.max(intermediateSeq, settlementSeq ?? 0) &&
              cursorOf(value).activeCommandId === undefined,
            4000,
            "final non-regressed row",
          );
          expect(
            payloadOf(finalBinding).activeTurnId === null ||
              payloadOf(finalBinding).activeTurnId === undefined,
          ).toBe(true);
          expect(gateway.commands.size).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(stack.serviceLayer));
      }),
  );

  it.live(
    "a parked detach write cannot overwrite a newer quarantine latch: the reopened file keeps it and resume refuses",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-detachrace-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        gateway.addAssistantCard("previously recorded conversation");
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-detachrace-"), "orchestration.sqlite");
        const thread = asThreadId("thread-detach-race");

        const first = yield* acquireHarnessAdapter(gateway);
        const gateDirectory = makeGateDirectory();
        const firstStack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, first]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
          wrapDirectory: gateDirectory.wrap,
        });
        const gate = Deferred.makeUnsafe<string>();
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const published: ProviderRuntimeEvent[] = [];
          yield* Stream.runForEach(service.streamEvents, (event) =>
            Effect.sync(() => {
              published.push(event);
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });

          // Quiescence preamble: one settled turn whose completion PUBLICATION
          // (which happens only after its durable persistence) proves no
          // runtime writer is still pending — so the armed gate parks exactly
          // the stop's pre-detach snapshot write.
          yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-detach"),
            input: "detach race",
          });
          gateway.settle("cmd-detach", "success");
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.completed" && event.threadId === thread,
                ),
              4000,
              "quiescence before arming the gate",
            ),
          );

          // Park the stop's pre-detach snapshot write (it holds the thread's
          // serialized boundary while parked).
          gateDirectory.arm([gate]);
          const stopping = yield* Effect.forkChild(service.stopSession({ threadId: thread }));
          try {
            yield* Effect.promise(() =>
              waitFor(() => gateDirectory.count() >= 1, 4000, "the stop's snapshot write to park"),
            );
            gateway.flipGeneration("detach-race-replacement");
            // The ADAPTER latches the quarantine while the boundary is held —
            // adapter-level execution (the poller) is never blocked by the
            // directory lock. A correct serialized boundary need not write
            // any DB row while locked; only the ACTUAL adapter snapshot is
            // awaited here.
            yield* waitForEffect(
              first.listSessions(),
              (sessions) =>
                sessions.some(
                  (session) =>
                    session.threadId === thread && cursorOf(session).sourceMismatch === true,
                ),
              4000,
              "actual adapter quarantine while the detach write is parked",
            );
          } finally {
            yield* Deferred.succeed(gate, "release");
          }
          yield* Fiber.join(stopping);

          // The converged boundary kept the newer state: the latch is durable
          // and the stop did detach.
          const final = yield* waitForEffect(
            Effect.map(directory.getBinding(thread), Option.getOrThrow),
            (value) => cursorOf(value).sourceMismatch === true,
            4000,
            "final durable quarantine latch",
          );
          expect(cursorOf(final).sourceMismatch).toBe(true);
          expect(gateway.requestsFor("workbench.detach")).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(firstStack.serviceLayer));

        // Fresh adapter/service/SQLite connection over the SAME file: the
        // latched cursor refuses resume and send with no submit.
        const second = yield* acquireHarnessAdapter(gateway);
        const secondStack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, second]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const reopened = yield* Effect.map(directory.getBinding(thread), Option.getOrThrow);
          expect(cursorOf(reopened).sourceMismatch).toBe(true);
          yield* expectRefusal(
            service.startSession(thread, {
              providerInstanceId: HARNESS_INSTANCE,
              threadId: thread,
              runtimeMode: "full-access",
            }),
            "replaced or truncated",
          );
          yield* expectRefusal(
            service.sendTurn({ threadId: thread, input: "after the race" }),
            "replaced or truncated",
          );
        }).pipe(Effect.scoped, Effect.provide(secondStack.serviceLayer));
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);
      }),
  );

  it.live(
    "refuses a stop whose state advances through every allowed write, before detach and without false durable acknowledgment",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-unstable-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-unstable-"), "orchestration.sqlite");
        const thread = asThreadId("thread-unstable");

        const harness = yield* acquireHarnessAdapter(gateway);
        const gateDirectory = makeGateDirectory();
        const stack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
          wrapDirectory: gateDirectory.wrap,
        });
        const gates = [
          Deferred.makeUnsafe<string>(),
          Deferred.makeUnsafe<string>(),
          Deferred.makeUnsafe<string>(),
        ];
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const published: ProviderRuntimeEvent[] = [];
          yield* Stream.runForEach(service.streamEvents, (event) =>
            Effect.sync(() => {
              published.push(event);
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });

          // Quiescence preamble (see the detach-race regression): only when
          // every runtime writer has drained does the armed sequence park
          // exactly the stop's boundary writes.
          yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-unstable"),
            input: "unstable stop",
          });
          gateway.settle("cmd-unstable", "success");
          yield* Effect.promise(() =>
            waitFor(
              () =>
                published.some(
                  (event) => event.type === "turn.completed" && event.threadId === thread,
                ),
              4000,
              "quiescence before arming the gates",
            ),
          );

          gateDirectory.arm(gates);
          const stopping = yield* Effect.forkChild(service.stopSession({ threadId: thread }));
          const advanceProjected = (what: string, seq: number) =>
            waitForEffect(
              harness.listSessions(),
              (sessions) =>
                sessions.some(
                  (session) =>
                    session.threadId === thread &&
                    (cursorOf(session).sessionCursor?.seq ?? 0) >= seq,
                ),
              4000,
              `${what} projected while its write is parked`,
            );
          try {
            // Each allowed write parks on the state captured before its own
            // advance; the boundary burns all three writes chasing.
            yield* Effect.promise(() =>
              waitFor(() => gateDirectory.count() >= 1, 4000, "first write parked"),
            );
            const seqA = gateway.addAssistantCard("advance one");
            yield* advanceProjected("advance one", seqA);
            yield* Deferred.succeed(gates[0]!, "release-1");

            yield* Effect.promise(() =>
              waitFor(() => gateDirectory.count() >= 2, 4000, "second write parked"),
            );
            const seqB = gateway.addAssistantCard("advance two");
            yield* advanceProjected("advance two", seqB);
            yield* Deferred.succeed(gates[1]!, "release-2");

            yield* Effect.promise(() =>
              waitFor(() => gateDirectory.count() >= 3, 4000, "third write parked"),
            );
            const seqC = gateway.addAssistantCard("advance three");
            yield* advanceProjected("advance three", seqC);
            yield* Deferred.succeed(gates[2]!, "release-3");
          } finally {
            for (const gate of gates) {
              yield* Deferred.succeed(gate, "release-all");
            }
          }

          // The post-write re-read still differed from the last write: the
          // boundary refused with UNSTABLE — no false durable acknowledgment.
          const stopExit = yield* Fiber.await(stopping);
          expect(Exit.isFailure(stopExit)).toBe(true);
          const stopError = failureOf(stopExit);
          const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
          expect(stopMessage).toContain("kept advancing");
          // Refused BEFORE detaching: the adapter still holds the session and
          // the kernel binding is intact.
          expect(gateway.requestsFor("workbench.detach")).toHaveLength(0);
          const sessions = yield* harness.listSessions();
          expect(sessions.some((session) => session.threadId === thread)).toBe(true);

          // Once the state has settled, a retry stops and detaches cleanly.
          yield* service.stopSession({ threadId: thread }).pipe(Effect.timeout("4 seconds"));
          expect(gateway.requestsFor("workbench.detach")).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(stack.serviceLayer));
      }),
  );

  it.live(
    "withholds adapter teardown and the stopped settlement when the harness shutdown write fails",
    () =>
      Effect.gen(function* () {
        const harnessRoot = makeTempDir("t3-dokkabi-shutdown-");
        const gateway = new FakeGateway();
        gateway.workspacePath = harnessRoot;
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-shutdown-"), "orchestration.sqlite");
        const thread = asThreadId("thread-shutdown");

        const harness = yield* acquireHarnessAdapter(gateway);
        const failToggle = makeFailToggleDirectory();
        const stack = buildStack({
          dbPath,
          registry: makeStaticRegistry([[HARNESS_INSTANCE, harness]]),
          ownership: ownershipLayer({
            roots: [harnessRoot],
            harnessInstances: [String(HARNESS_INSTANCE)],
          }),
          wrapDirectory: failToggle.wrap,
        });
        yield* Effect.gen(function* () {
          const service = yield* ProviderService.ProviderService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* service.startSession(thread, {
            providerInstanceId: HARNESS_INSTANCE,
            threadId: thread,
            runtimeMode: "full-access",
            cwd: harnessRoot,
          });
          yield* service.sendTurn({
            threadId: thread,
            commandId: CommandId.make("cmd-shutdown"),
            input: "shutdown send",
          });
          gateway.settle("cmd-shutdown", "success");
          // Deterministic settled state before poisoning the writes.
          yield* waitForEffect(
            Effect.map(directory.getBinding(thread), Option.getOrThrow),
            (value) => cursorOf(value).activeCommandId === undefined,
            4000,
            "settled row before the shutdown failure injection",
          );

          // Poison every further durable write: the layer close (runStopAll)
          // must FAIL CLOSED for this harness adapter — no teardown, no
          // stopped settlement, no cleared row.
          failToggle.state.fail = true;
        }).pipe(Effect.scoped, Effect.provide(stack.serviceLayer));

        // Fresh read-only connection over the SAME file: the row must not be
        // claimed stopped and the send's durable markers stand.
        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const binding = yield* Effect.map(directory.getBinding(thread), Option.getOrThrow);
          expect(binding.status).not.toBe("stopped");
          const payload = (binding.runtimePayload ?? {}) as { lastRuntimeEvent?: string };
          expect(payload.lastRuntimeEvent).toBe("provider.sendTurn");
          expect(cursorOf(binding).sessionCursor?.seq).toBeDefined();
        }).pipe(Effect.scoped, Effect.provide(directoryOnlyLayer(dbPath)));
        // Teardown was withheld: no detach was issued during shutdown, and no
        // submit was retried.
        expect(gateway.requestsFor("workbench.detach")).toHaveLength(0);
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);
      }),
  );
});
