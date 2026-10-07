/**
 * Two layers of evidence:
 * 1. SYNTHETIC shape-parity cases — manually constructed event sequences in
 *    exactly the shapes DokkabiAdapter emits, routed through the REAL
 *    ProviderRuntimeIngestion stack. These pin ingestion compatibility.
 * 2. One INTEGRATED case — events obtained from the REAL DokkabiAdapter
 *    running against the in-process validated gateway double, streamed live
 *    into the same real ingestion stack. This proves the actual
 *    adapter→ingestion pipeline.
 *
 * @module provider/Layers/DokkabiAdapter.ingestion.test
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  RuntimeItemId,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
  TurnId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { it } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { makeSqlStatementCounter } from "../../../integration/SqlStatementCounter.integration.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { ProviderRuntimeIngestionLive } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { makeDokkabiAdapter } from "./DokkabiAdapter.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const PROVIDER = ProviderDriverKind.make("dokkabi");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const THREAD_ID = ThreadId.make("thread-dokkabi-1");
const TURN_ID = TurnId.make("provider:turn-start:97ab");

process.env.DOKKABI_INGESTION_TEST_TOKEN = "non-secret-test-fixture";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const asEventId = (value: string) => EventId.make(value);

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

function createProviderServiceHarness(
  runtimeEventPubSub: PubSub.PubSub<{
    readonly events: ReadonlyArray<ProviderRuntimeEvent>;
    readonly enqueued?: Deferred.Deferred<void>;
  }>,
  options?: {
    /** When provided, the service streams THIS (e.g. a real adapter's) event
     * stream instead of the manual PubSub feed. */
    readonly streamEvents?: Stream.Stream<ProviderRuntimeEvent>;
  },
) {
  const runtimeSessions: ProviderSession[] = [];
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "unsupported" }),
    assertConversationRollbackSupported: () => unsupported(),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    uploadFeedback: () => unsupported(),
    getWorkbenchOverview: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    getWorkbenchGraph: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    getWorkbenchCode: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    subscribeWorkbenchCode: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    workbenchCodeAction: () =>
      Effect.succeed({
        version: 1,
        state: "unsupported",
        reason: "not part of this test",
      } as const),
    getWorkbenchRecord: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    getWorkbenchRecordIndex: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    getWorkbenchRecordBody: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    verifyWorkbenchRecordBody: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    exploreWorkbenchGraph: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    getWorkbenchDecisions: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    createWorkbenchDecision: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" } as const),
    selectWorkbenchDecision: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" } as const),
    startWorkbenchBranch: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" } as const),
    resumeWorkbenchSession: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" } as const),
    getWorkbenchWorkMode: () =>
      Effect.succeed({ status: "unsupported", reason: "not part of this test" as const }),
    setWorkbenchWorkMode: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" as const }),
    workbenchWorkModeStatus: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" as const }),
    get streamEvents() {
      return options?.streamEvents ?? streamFromPubSub();
      function streamFromPubSub() {
        return Stream.fromPubSub(runtimeEventPubSub).pipe(
          Stream.flatMap(({ events, enqueued }) =>
            Stream.concat(
              Stream.fromIterable(events),
              enqueued
                ? Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain)
                : Stream.empty,
            ),
          ),
        );
      }
    },
  };
  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };
  const emitAndWaitForEnqueue = Effect.fnUntraced(function* (
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ) {
    const enqueued = yield* Deferred.make<void>();
    yield* PubSub.publish(runtimeEventPubSub, { events, enqueued });
    yield* Deferred.await(enqueued);
  });
  return { service, setSession, emitAndWaitForEnqueue };
}

/** Poll the read model until the thread satisfies the predicate. */
const waitForThread = <E, R>(
  readModel: Effect.Effect<OrchestrationReadModel, E, R>,
  predicate: (thread: OrchestrationReadModel["threads"][number]) => boolean,
  timeoutMs = 4000,
  targetThread = THREAD_ID,
): Effect.Effect<OrchestrationReadModel["threads"][number], E, R> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    for (;;) {
      const snapshot = yield* readModel;
      const thread = snapshot.threads.find((entry) => entry.id === targetThread);
      if (thread && predicate(thread)) {
        return thread;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error("Timed out waiting for thread state"));
      }
      yield* Effect.yieldNow;
    }
  });

/**
 * Builds the real orchestration/ingestion stack (in-memory SQLite unless a
 * file-backed layer is provided), starts ingestion, optionally seeds one
 * project/thread/session and returns the harness. The built layer and
 * ingestion scope close with the surrounding test scope.
 */
const makeFileSqliteLayer = (path: string) =>
  makeSqlitePersistenceLive(path).pipe(Layer.provide(NodeServices.layer));

const acquireIngestionHarness = (options?: {
  readonly streamEvents?: Stream.Stream<ProviderRuntimeEvent>;
  /** File-backed persistence for the closed/reopened SQLite regression. */
  readonly sqliteLayer?: ReturnType<typeof makeFileSqliteLayer>;
  readonly seed?: boolean;
}) =>
  Effect.gen(function* () {
    const repositoryRoot = yield* Effect.sync(() => makeTempDir("t3-dokkabi-ingestion-"));
    yield* Effect.sync(() =>
      NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: repositoryRoot,
        stdio: "ignore",
      }),
    );
    const workspaceRoot = NodePath.join(repositoryRoot, "dokkabi-lab");
    yield* Effect.sync(() => NodeFS.mkdirSync(workspaceRoot, { recursive: true }));
    const runtimeEventPubSub = yield* PubSub.unbounded<{
      readonly events: ReadonlyArray<ProviderRuntimeEvent>;
      readonly enqueued?: Deferred.Deferred<void>;
    }>();
    const provider = createProviderServiceHarness(runtimeEventPubSub, options);
    const sqlCounter = makeSqlStatementCounter();
    const sqliteLayer = options?.sqliteLayer ?? SqlitePersistenceMemory;
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(sqliteLayer),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(sqliteLayer),
    );
    const ingestionProjectionSnapshotLayer = Layer.effect(
      ProjectionSnapshotQuery,
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        return ProjectionSnapshotQuery.of({
          ...query,
          getThreadDetailById: () =>
            Effect.die("provider runtime ingestion must not hydrate thread detail"),
        });
      }),
    ).pipe(Layer.provide(projectionSnapshotLayer));
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(ingestionProjectionSnapshotLayer),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(sqliteLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer()),
      Layer.provideMerge(
        Layer.effect(
          CheckpointStore.CheckpointStore,
          Effect.map(CheckpointStore.CheckpointStore, (store) => store),
        ).pipe(Layer.provide(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer)))),
      ),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(Tracer.Tracer, sqlCounter.tracer)),
    );
    const context = yield* Layer.build(layer);
    const engine = Context.get(context, OrchestrationEngineService);
    const snapshotQuery = Context.get(context, ProjectionSnapshotQuery);
    const ingestion = Context.get(context, ProviderRuntimeIngestionService);
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* ingestion.start();

    const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);
    const emitAndDrain = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      provider.emitAndWaitForEnqueue(events).pipe(Effect.andThen(ingestion.drain));

    const createdAt = "2026-01-01T00:00:00.000Z";
    if (options?.seed !== false) {
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-dokkabi-project-create"),
        projectId: ProjectId.make("project-1"),
        title: "Dokkabi Project",
        workspaceRoot,
        defaultModelSelection: { instanceId: INSTANCE_ID, model: "glm-5.3" },
        createdAt,
      });
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-dokkabi-thread-create"),
        threadId: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Dokkabi thread",
        modelSelection: { instanceId: INSTANCE_ID, model: "glm-5.3" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-dokkabi-session-seed"),
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "dokkabi",
          runtimeMode: "full-access",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      });
      yield* Effect.sync(() =>
        provider.setSession({
          provider: PROVIDER,
          providerInstanceId: INSTANCE_ID,
          status: "ready",
          runtimeMode: "full-access",
          threadId: THREAD_ID,
          createdAt,
          updatedAt: createdAt,
        }),
      );
    }

    return {
      readModel: snapshotQuery.getSnapshot(),
      dispatch,
      emitAndDrain,
      drain: ingestion.drain,
      sql,
    };
  });

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Dokkabi adapter runtime events through real ProviderRuntimeIngestion", () => {
  /** Exactly the event shapes DokkabiAdapter projects for one recorded turn. */
  const adapterTurnEvents = (
    sessionKey = "live-fake01:gen1",
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const base = {
      provider: PROVIDER,
      providerInstanceId: INSTANCE_ID,
      threadId: THREAD_ID,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    return [
      {
        ...base,
        eventId: asEventId(`dokkabi:${sessionKey}:session-started`),
        type: "session.started",
        payload: { resume: undefined },
      },
      {
        ...base,
        eventId: asEventId(`dokkabi:${sessionKey}:turn-start:wire-cmd-1`),
        type: "turn.started",
        turnId: TURN_ID,
        payload: { model: "glm-5.3" },
      },
      {
        ...base,
        eventId: asEventId(`dokkabi:${sessionKey}:card:202:started:aaaa`),
        type: "item.started",
        turnId: TURN_ID,
        itemId: RuntimeItemId.make(`dokkabi:${sessionKey}:card:202`),
        payload: { itemType: "command_execution", title: "bash" },
      },
    ];
  };

  it.live("mounts real assistant text, tool activity and turn outcome with no duplicate rows", () =>
    Effect.gen(function* () {
      const harness = yield* acquireIngestionHarness();
      const sessionKey = "live-fake01:gen1";
      const base = {
        provider: PROVIDER,
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        createdAt: "2026-01-01T00:00:01.000Z",
      };

      yield* harness.emitAndDrain([
        ...adapterTurnEvents(sessionKey),
        {
          ...base,
          eventId: asEventId(`dokkabi:${sessionKey}:card:202:completed:bbbb`),
          type: "item.completed",
          turnId: TURN_ID,
          itemId: RuntimeItemId.make(`dokkabi:${sessionKey}:card:202`),
          payload: {
            itemType: "command_execution",
            status: "completed",
            title: "bash",
            detail: "recorded tool result",
          },
        },
        {
          ...base,
          eventId: asEventId(`dokkabi:${sessionKey}:card:204:assistant:cccc`),
          type: "item.completed",
          turnId: TURN_ID,
          itemId: RuntimeItemId.make(`dokkabi:${sessionKey}:card:204`),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: "actual recorded assistant reply",
          },
        },
        {
          ...base,
          eventId: asEventId(`dokkabi:${sessionKey}:turn-settled:wire-cmd-1:success:206`),
          type: "turn.completed",
          turnId: TURN_ID,
          payload: { state: "completed" },
        },
      ]);

      const thread = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some((message) => message.text === "actual recorded assistant reply"),
      );
      // Exactly one assistant row; the turn completed.
      const assistantRows = thread.messages.filter(
        (message) => message.text === "actual recorded assistant reply",
      );
      expect(assistantRows).toHaveLength(1);
      expect(thread.session?.activeTurnId).toBeNull();

      // Re-projected identical content (an upsert with a fresh event id) must
      // NOT add a duplicate row.
      yield* harness.emitAndDrain([
        {
          ...base,
          eventId: asEventId(`dokkabi:${sessionKey}:card:204:assistant:dddd`),
          type: "item.completed",
          turnId: TURN_ID,
          itemId: RuntimeItemId.make(`dokkabi:${sessionKey}:card:204`),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: "actual recorded assistant reply",
          },
        },
      ]);
      const afterUpsert = yield* waitForThread(harness.readModel, (entry) =>
        entry.messages.some((message) => message.text === "actual recorded assistant reply"),
      );
      expect(
        afterUpsert.messages.filter(
          (message) => message.text === "actual recorded assistant reply",
        ),
      ).toHaveLength(1);
      expect(
        afterUpsert.activities.filter(
          (activity) =>
            activity.kind === "tool.completed" &&
            (activity.payload as { title?: string } | undefined)?.title === "bash",
        ),
      ).toHaveLength(1);
    }),
  );

  it.live("keeps a failed turn visibly failed with its recorded assistant text", () =>
    Effect.gen(function* () {
      const harness = yield* acquireIngestionHarness();
      const sessionKey = "live-fake02:gen1";
      const base = {
        provider: PROVIDER,
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        createdAt: "2026-01-01T00:00:01.000Z",
      };
      yield* harness.emitAndDrain([
        ...adapterTurnEvents(sessionKey),
        {
          ...base,
          eventId: asEventId(`dokkabi:${sessionKey}:card:204:assistant:cccc`),
          type: "item.completed",
          turnId: TURN_ID,
          itemId: RuntimeItemId.make(`dokkabi:${sessionKey}:card:204`),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: "partial reply before failure",
          },
        },
        {
          ...base,
          eventId: asEventId(`dokkabi:${sessionKey}:turn-settled:wire-cmd-2:failure:206`),
          type: "turn.completed",
          turnId: TURN_ID,
          payload: {
            state: "failed",
            errorMessage: "The Dokkabi turn failed; see the recorded transcript.",
          },
        },
      ]);
      const thread = yield* waitForThread(
        harness.readModel,
        (entry) =>
          entry.messages.some((message) => message.text === "partial reply before failure") &&
          entry.session?.status === "error",
      );
      expect(thread.session?.lastError).toContain("Dokkabi turn failed");
    }),
  );

  it.live("leaves no orphan fibers or streams when the ingestion scope closes", () =>
    Effect.gen(function* () {
      yield* acquireIngestionHarness();
      // The test scope closing (end of this effect) closes the ingestion
      // scope; a hang here would fail the suite.
      expect(true).toBe(true);
    }),
  );

  it.live(
    "INTEGRATED: real adapter events through real ingestion — late tool end, missing duration, full text, replay without duplicates",
    () =>
      Effect.gen(function* () {
        const gateway = new FakeGateway();
        const adapterScope = Scope.makeUnsafe("sequential");
        yield* Effect.addFinalizer(() => Scope.close(adapterScope, Exit.void).pipe(Effect.ignore));
        const adapter = yield* makeDokkabiAdapter(
          {
            enabled: true,
            gatewayUrl: "ws://127.0.0.1:4174",
            tokenEnv: "DOKKABI_INGESTION_TEST_TOKEN",
            workspacePath: gateway.workspacePath,
            instanceId: INSTANCE_ID,
          },
          {
            clientId: "app-test",
            pollIntervalMs: 30,
            cancelSettlementWaitMs: 150,
            socketFactory: gateway.createSocket,
          },
        ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(adapterScope));
        // The provider service streams the REAL adapter's canonical events.
        const harness = yield* acquireIngestionHarness({ streamEvents: adapter.streamEvents });

        yield* adapter.startSession({ threadId: THREAD_ID, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          commandId: CommandId.make("cmd-live-1"),
          input: "run the build",
        });
        // Recorded tool starts WITHOUT an end (duration missing), the full
        // assistant text, then the LATE tool end — all through real reads.
        const toolSeq = gateway.addToolCard({
          id: "tool-build",
          tool: "bash",
          resultText: "interim output",
        });
        gateway.addAssistantCard("full recorded reply text");
        gateway.completeToolCard(toolSeq);
        gateway.settle("cmd-live-1", "success");

        const thread = yield* waitForThread(
          harness.readModel,
          (entry) =>
            entry.messages.some((message) => message.text === "full recorded reply text") &&
            entry.session?.activeTurnId === null,
        );
        const assistantRows = thread.messages.filter(
          (message) => message.text === "full recorded reply text",
        );
        expect(assistantRows).toHaveLength(1);
        const toolCompletions = thread.activities.filter(
          (activity) =>
            activity.kind === "tool.completed" &&
            (activity.payload as { title?: string; detail?: string } | undefined)?.title === "bash",
        );
        expect(toolCompletions).toHaveLength(1);
        expect((toolCompletions[0]?.payload as { detail?: string } | undefined)?.detail).toBe(
          "interim output",
        );

        // A duplicate replay of the same command re-projects the same recorded
        // content: still exactly one assistant row, one tool completion.
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          commandId: CommandId.make("cmd-live-1"),
          input: "run the build",
        });
        const afterReplay = yield* waitForThread(
          harness.readModel,
          (entry) =>
            entry.messages.some((message) => message.text === "full recorded reply text") &&
            entry.session?.activeTurnId === null,
        );
        expect(
          afterReplay.messages.filter((message) => message.text === "full recorded reply text"),
        ).toHaveLength(1);
        expect(
          afterReplay.activities.filter(
            (activity) =>
              activity.kind === "tool.completed" &&
              (activity.payload as { title?: string; detail?: string } | undefined)?.title ===
                "bash",
          ),
        ).toHaveLength(1);
      }),
  );
});

// --- recorded replay identity and time through the real engine (R2-06) ---

describe("DokkabiAdapter replay identity through real ingestion and engine", () => {
  /** Raw durable rows — byte-level comparison, not a read-model summary. */
  const readRows = <E, R>(
    sql: SqlClient.SqlClient,
    statement: Effect.Effect<ReadonlyArray<Record<string, unknown>>, E, R>,
  ) => Effect.map(statement, (rows) => rows as ReadonlyArray<Record<string, unknown>>);
  const readMessages = (sql: SqlClient.SqlClient) =>
    sql`SELECT * FROM projection_thread_messages ORDER BY message_id`;
  const readActivities = (sql: SqlClient.SqlClient) =>
    sql`SELECT * FROM projection_thread_activities ORDER BY activity_id`;
  const readTurns = (sql: SqlClient.SqlClient) =>
    sql`SELECT * FROM projection_turns ORDER BY turn_id`;

  const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

  const rowsByPrimary = (rows: ReadonlyArray<Record<string, unknown>>, key: string) =>
    new Map(rows.map((row) => [String(row[key]), encodeRow(row)] as const));

  const replayReceipts = (sql: SqlClient.SqlClient) =>
    Effect.map(
      sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id LIKE 'provider-replay:%' ORDER BY command_id`,
      (rows) => (rows as ReadonlyArray<{ command_id: string }>).map((row) => row.command_id),
    );

  it.live("a recorded observation re-emitted with its replayKey changes nothing durable", () =>
    Effect.gen(function* () {
      const harness = yield* acquireIngestionHarness();
      const base = {
        provider: PROVIDER,
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        createdAt: "2026-03-01T00:00:00.000Z",
      };
      const recorded = {
        ...base,
        eventId: asEventId("dokkabi:s1:g1:card:301:completed:aaaa"),
        replayKey: "card:301:completed:aaaa",
        type: "item.completed" as const,
        turnId: TURN_ID,
        itemId: RuntimeItemId.make("dokkabi:s1:g1:card:301"),
        payload: {
          itemType: "command_execution" as const,
          status: "completed" as const,
          title: "bash",
          detail: "recorded output",
        },
      };
      yield* harness.emitAndDrain([recorded]);
      const beforeRows = yield* readRows(harness.sql, readActivities(harness.sql));
      const beforeReceipts = yield* replayReceipts(harness.sql);
      expect(beforeReceipts.length).toBeGreaterThan(0);
      // Every deterministic replay command id encodes its full scope:
      // provider instance, thread, replay key and command tag.
      expect(beforeReceipts[0]).toContain("thread-activity-append");

      // The SAME recorded observation again — as a fresh adapter replay would
      // emit it — must be a durable no-op: identical rows, no new receipts.
      yield* harness.emitAndDrain([recorded]);
      yield* harness.drain;
      const afterRows = yield* readRows(harness.sql, readActivities(harness.sql));
      const afterReceipts = yield* replayReceipts(harness.sql);
      expect(afterRows).toEqual(beforeRows);
      expect(afterReceipts).toEqual(beforeReceipts);
    }),
  );

  it.live(
    "the same replay key in another instance or thread has independent durable receipts",
    () =>
      Effect.gen(function* () {
        const harness = yield* acquireIngestionHarness();
        const otherThread = ThreadId.make("thread-dokkabi-2");
        yield* harness.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-other-thread"),
          threadId: otherThread,
          projectId: ProjectId.make("project-1"),
          title: "Other thread",
          modelSelection: { instanceId: INSTANCE_ID, model: "glm-5.3" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-03-01T00:00:00.000Z",
        });
        const events = [
          { instance: INSTANCE_ID, thread: THREAD_ID },
          { instance: ProviderInstanceId.make("dokkabi-other"), thread: THREAD_ID },
          { instance: INSTANCE_ID, thread: otherThread },
        ].map(({ instance, thread }, index) => ({
          provider: PROVIDER,
          providerInstanceId: instance,
          threadId: thread,
          createdAt: "2026-03-01T00:00:00.000Z",
          replayKey: "same-source-key",
          eventId: asEventId(`scope-event-${index}`),
          itemId: RuntimeItemId.make(`scope-item-${index}`),
          type: "item.completed" as const,
          payload: {
            itemType: "command_execution" as const,
            status: "completed" as const,
            title: "bash",
          },
        }));
        yield* harness.emitAndDrain(events);
        const before = yield* replayReceipts(harness.sql);
        expect(before.filter((id) => id.includes("thread-activity-append"))).toHaveLength(3);
        const rows = yield* readActivities(harness.sql);
        expect(rows).toHaveLength(3);
        yield* harness.emitAndDrain(events);
        expect(yield* replayReceipts(harness.sql)).toEqual(before);
        expect(yield* readActivities(harness.sql)).toEqual(rows);
      }),
  );

  it.live("events without a replayKey keep unique per-emission command identities", () =>
    Effect.gen(function* () {
      const harness = yield* acquireIngestionHarness();
      const base = {
        provider: PROVIDER,
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        createdAt: "2026-03-01T00:00:00.000Z",
      };
      const transient = {
        ...base,
        eventId: asEventId("dokkabi:s1:g1:state-running-x"),
        type: "session.state.changed" as const,
        payload: { state: "running" as const, reason: "legacy path" },
      };
      const before = yield* harness.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE 'provider:%:thread-session-set:%'`;
      yield* harness.emitAndDrain([transient, { ...transient }]);
      const after = yield* harness.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE 'provider:%:thread-session-set:%'`;
      expect(after[0]!.count - before[0]!.count).toBe(2);
      const receipts = yield* replayReceipts(harness.sql);
      // Legacy events never take the deterministic path.
      expect(receipts).toEqual([]);
    }),
  );

  it.live(
    "RESTART: fresh adapter and ingestion scopes against reopened SQLite replay history byte-equivalently before a later explicit turn",
    () =>
      Effect.gen(function* () {
        const gateway = new FakeGateway();
        const dbPath = NodePath.join(makeTempDir("t3-dokkabi-replay-restart-"), "orchestration.db");
        const sqliteFor = () =>
          makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));

        const adapterFor = (scope: Scope.Closeable) =>
          makeDokkabiAdapter(
            {
              enabled: true,
              gatewayUrl: "ws://127.0.0.1:4175",
              tokenEnv: "DOKKABI_INGESTION_TEST_TOKEN",
              workspacePath: gateway.workspacePath,
              instanceId: INSTANCE_ID,
            },
            {
              clientId: "app-replay-test",
              pollIntervalMs: 30,
              cancelSettlementWaitMs: 150,
              socketFactory: gateway.createSocket,
            },
          ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));

        // --- phase 1: two recorded turns (one success, one operator abort) ---
        const scope1 = yield* Scope.make("sequential");
        yield* Effect.addFinalizer(() => Scope.close(scope1, Exit.void).pipe(Effect.ignore));
        const adapter1 = yield* adapterFor(scope1);
        const harness1 = yield* acquireIngestionHarness({
          streamEvents: adapter1.streamEvents,
          sqliteLayer: sqliteFor(),
        }).pipe(Scope.provide(scope1));

        yield* adapter1.startSession({ threadId: THREAD_ID, runtimeMode: "full-access" });
        yield* adapter1.sendTurn({
          threadId: THREAD_ID,
          commandId: CommandId.make("cmd-restart-1"),
          input: "first recorded turn",
        });
        const tool1 = gateway.addToolCard({
          id: "tool-one",
          tool: "bash",
          resultText: "first out",
        });
        gateway.addAssistantCard("first recorded reply");
        gateway.completeToolCard(tool1);
        gateway.settle("cmd-restart-1", "success");
        yield* waitForThread(
          harness1.readModel,
          (entry) =>
            entry.messages.some((message) => message.text === "first recorded reply") &&
            entry.session?.activeTurnId === null,
        );

        yield* adapter1.sendTurn({
          threadId: THREAD_ID,
          commandId: CommandId.make("cmd-restart-2"),
          input: "turn that gets stopped",
        });
        const tool2 = gateway.addToolCard({ id: "tool-two", tool: "bash" });
        gateway.completeToolCard(tool2, true);
        yield* adapter1.interruptTurn(THREAD_ID, TurnId.make("cmd-restart-2"));
        yield* waitForThread(
          harness1.readModel,
          (entry) => entry.session?.status === "interrupted" && entry.session.activeTurnId === null,
        );
        // Let the poller run a few idle cycles, then drain everything durable.
        yield* Effect.sleep(200);
        yield* harness1.drain;

        const snapshotMessages = yield* readRows(harness1.sql, readMessages(harness1.sql));
        const snapshotActivities = yield* readRows(harness1.sql, readActivities(harness1.sql));
        const snapshotTurns = yield* readRows(harness1.sql, readTurns(harness1.sql));
        const snapshotReplayReceipts = yield* replayReceipts(harness1.sql);
        expect(snapshotMessages.length).toBeGreaterThan(0);
        expect(snapshotActivities.length).toBeGreaterThan(0);
        expect(snapshotTurns.length).toBeGreaterThan(0);
        expect(snapshotReplayReceipts.length).toBeGreaterThan(0);

        // --- phase 2: reopen the SAME SQLite file with fresh scopes ---
        yield* Scope.close(scope1, Exit.void);
        const scope2 = yield* Scope.make("sequential");
        yield* Effect.addFinalizer(() => Scope.close(scope2, Exit.void).pipe(Effect.ignore));
        const adapter2 = yield* adapterFor(scope2);
        const harness2 = yield* acquireIngestionHarness({
          streamEvents: adapter2.streamEvents,
          sqliteLayer: sqliteFor(),
          seed: false,
        }).pipe(Scope.provide(scope2));

        // A FRESH adapter adopting the unchanged recorded history replays it
        // all — that replay must be a durable no-op for every recorded row.
        yield* adapter2.startSession({ threadId: THREAD_ID, runtimeMode: "full-access" });
        const deadline = (yield* Clock.currentTimeMillis) + 10_000;
        for (;;) {
          const sessions = yield* adapter2.listSessions();
          const ready =
            sessions.find((session) => session.threadId === THREAD_ID)?.status === "ready";
          if (ready || (yield* Clock.currentTimeMillis) > deadline) break;
          yield* Effect.sleep(30);
        }
        yield* Effect.sleep(250);
        yield* harness2.drain;

        const replayMessages = rowsByPrimary(
          yield* readRows(harness2.sql, readMessages(harness2.sql)),
          "message_id",
        );
        const replayActivities = rowsByPrimary(
          yield* readRows(harness2.sql, readActivities(harness2.sql)),
          "activity_id",
        );
        const replayTurns = rowsByPrimary(
          yield* readRows(harness2.sql, readTurns(harness2.sql)),
          "turn_id",
        );
        const replayReceiptsAfterReplay = yield* replayReceipts(harness2.sql);

        // Byte-equivalence: every recorded row from before the restart is
        // exactly itself afterwards, and the replay created NO new durable
        // replay commands for unchanged history.
        for (const row of snapshotMessages) {
          expect(replayMessages.get(String(row.message_id))).toBe(encodeRow(row));
        }
        for (const row of snapshotActivities) {
          expect(replayActivities.get(String(row.activity_id))).toBe(encodeRow(row));
        }
        for (const row of snapshotTurns) {
          expect(replayTurns.get(String(row.turn_id))).toBe(encodeRow(row));
        }
        expect(replayReceiptsAfterReplay).toEqual(snapshotReplayReceipts);

        // --- phase 3: a later EXPLICIT turn appends only new work ---
        yield* adapter2.sendTurn({
          threadId: THREAD_ID,
          commandId: CommandId.make("cmd-restart-3"),
          input: "later explicit turn",
        });
        const tool3 = gateway.addToolCard({
          id: "tool-three",
          tool: "bash",
          resultText: "third out",
        });
        gateway.addAssistantCard("third recorded reply");
        gateway.completeToolCard(tool3);
        gateway.settle("cmd-restart-3", "success");
        const finalThread = yield* waitForThread(
          harness2.readModel,
          (entry) =>
            entry.messages.some((message) => message.text === "third recorded reply") &&
            entry.session?.activeTurnId === null,
        );

        // Historical rows remain byte-equivalent; only new facts were appended.
        const finalMessages = rowsByPrimary(
          yield* readRows(harness2.sql, readMessages(harness2.sql)),
          "message_id",
        );
        const finalActivities = rowsByPrimary(
          yield* readRows(harness2.sql, readActivities(harness2.sql)),
          "activity_id",
        );
        const finalTurns = rowsByPrimary(
          yield* readRows(harness2.sql, readTurns(harness2.sql)),
          "turn_id",
        );
        for (const row of snapshotMessages) {
          expect(finalMessages.get(String(row.message_id))).toBe(encodeRow(row));
        }
        for (const row of snapshotActivities) {
          expect(finalActivities.get(String(row.activity_id))).toBe(encodeRow(row));
        }
        for (const row of snapshotTurns) {
          expect(finalTurns.get(String(row.turn_id))).toBe(encodeRow(row));
        }
        // The later turn's data is present — never discarded by the replay.
        expect(
          finalThread.messages.filter((message) => message.text === "third recorded reply"),
        ).toHaveLength(1);
        const thirdToolCompletions = finalThread.activities.filter(
          (activity) =>
            activity.kind === "tool.completed" &&
            (activity.payload as { title?: string; detail?: string } | undefined)?.detail ===
              "third out",
        );
        expect(thirdToolCompletions).toHaveLength(1);
        // A late joined result is another observation of the SAME tool item.
        // Keep the prior observation immutable and append the new source fact.
        const cardIndex = gateway.cards.findIndex((card) => card.seq === tool3);
        const priorCard = gateway.cards[cardIndex]!;
        if (priorCard.kind !== "tool") return yield* Effect.die("Expected recorded tool card");
        gateway.cards[cardIndex] = { ...priorCard, resultText: "late recorded output" };
        const toolCallId = (thirdToolCompletions[0]!.payload as { toolCallId: string }).toolCallId;
        const enriched = yield* waitForThread(harness2.readModel, (entry) =>
          entry.activities.some(
            (activity) =>
              (activity.payload as { detail?: string } | undefined)?.detail ===
              "late recorded output",
          ),
        );
        const update = enriched.activities.find(
          (activity) =>
            (activity.payload as { detail?: string } | undefined)?.detail ===
            "late recorded output",
        )!;
        expect((update.payload as { toolCallId: string }).toolCallId).toBe(toolCallId);
        expect(update.id).not.toBe(thirdToolCompletions[0]!.id);
        expect(update.createdAt).toBe(thirdToolCompletions[0]!.createdAt);
        expect(
          enriched.activities.find((activity) => activity.id === thirdToolCompletions[0]!.id),
        ).toEqual(thirdToolCompletions[0]);
        // No orphan current turn: the settled session has no active turn.
        expect(finalThread.session?.activeTurnId).toBeNull();
        expect(finalThread.session?.status).not.toBe("running");
        // And no historical completion command was duplicated for the new work.
        const finalReplayReceipts = yield* replayReceipts(harness2.sql);
        expect(finalReplayReceipts.length).toBeGreaterThan(replayReceiptsAfterReplay.length);
        for (const receipt of replayReceiptsAfterReplay) {
          expect(finalReplayReceipts).toContain(receipt);
        }
        // Sequential adoption of the same source into another conversation
        // must not collide with globally keyed message or activity rows.
        const originalMessages = yield* readMessages(harness2.sql);
        const originalActivities = yield* readActivities(harness2.sql);
        const originalTurns = yield* readTurns(harness2.sql);
        yield* adapter2.stopSession(THREAD_ID);
        const otherThread = ThreadId.make("thread-adopt-same-source");
        yield* harness2.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-adoption-thread"),
          threadId: otherThread,
          projectId: ProjectId.make("project-1"),
          title: "Same source adoption",
          modelSelection: { instanceId: INSTANCE_ID, model: "glm-5.3" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-03-01T00:00:00.000Z",
        });
        yield* adapter2.startSession({ threadId: otherThread, runtimeMode: "full-access" });
        yield* waitForThread(
          harness2.readModel,
          (entry) =>
            entry.messages.some((message) => message.text === "third recorded reply") &&
            entry.activities.some(
              (activity) =>
                (activity.payload as { detail?: string } | undefined)?.detail ===
                "late recorded output",
            ),
          4000,
          otherThread,
        );
        yield* harness2.drain;
        const rowsAfterAdoption = {
          messages: rowsByPrimary(yield* readMessages(harness2.sql), "message_id"),
          activities: rowsByPrimary(yield* readActivities(harness2.sql), "activity_id"),
          turns: rowsByPrimary(yield* readTurns(harness2.sql), "turn_id"),
        };
        for (const row of originalMessages)
          expect(rowsAfterAdoption.messages.get(String(row.message_id))).toBe(encodeRow(row));
        for (const row of originalActivities)
          expect(rowsAfterAdoption.activities.get(String(row.activity_id))).toBe(encodeRow(row));
        // Turn IDs are scoped by thread in persistence.
        const firstTurns = (yield* readTurns(harness2.sql)).filter(
          (row) => row.thread_id === THREAD_ID,
        );
        expect(firstTurns).toEqual(originalTurns);
      }),
  );
});
