// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  OrchestrationReadModel,
  type OrchestrationEvent,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeSqlStatementCounter } from "../../../integration/SqlStatementCounter.integration.ts";

/**
 * Generic system_message item completions (the host's own MAIN conversation
 * notices, e.g. the Dokkabi host's recorded work terminal) must persist as
 * an independent, stable role "system" message: never reusing, finalizing or
 * replacing the turn's active assistant/reasoning segment, and never
 * blocking the model message that follows.
 *
 * @module orchestration/Layers/ProviderRuntimeIngestion.system-message.test
 */

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (threadId: string): ThreadId => ThreadId.make(threadId);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly replayKey?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(
    PubSub.unbounded<{
      readonly events: ReadonlyArray<ProviderRuntimeEvent>;
      readonly enqueued?: Deferred.Deferred<void>;
    }>(),
  );
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
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
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
      Effect.succeed({ status: "unsupported", reason: "not part of this test" } as const),
    setWorkbenchWorkMode: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" } as const),
    workbenchWorkModeStatus: () =>
      Effect.succeed({ state: "unsupported", reason: "not part of this test" } as const),
    get streamEvents() {
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
    events: ReadonlyArray<LegacyProviderRuntimeEvent>,
  ) {
    const enqueued = yield* Deferred.make<void>();
    yield* PubSub.publish(runtimeEventPubSub, {
      events: [...events] as unknown as ReadonlyArray<ProviderRuntimeEvent>,
      enqueued,
    });
    yield* Deferred.await(enqueued);
  });

  return {
    service,
    emitAndWaitForEnqueue,
    setSession,
  };
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];

async function waitForThread(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

describe("ProviderRuntimeIngestion system messages", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness() {
    const repositoryRoot = makeTempDir("t3-provider-project-");
    NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    const workspaceRoot = NodePath.join(repositoryRoot, "");
    NodeFS.mkdirSync(workspaceRoot, { recursive: true });
    const provider = createProviderServiceHarness();
    const sqlCounter = makeSqlStatementCounter();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
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
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer()),
      Layer.provideMerge(
        Layer.effect(
          CheckpointStore.CheckpointStore,
          Effect.map(CheckpointStore.CheckpointStore, (store) => ({
            ...store,
            isGitRepository: () => Effect.succeed(false),
          })),
        ).pipe(Layer.provide(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer)))),
      ),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(Tracer.Tracer, sqlCounter.tracer)),
    );
    const testRuntime = ManagedRuntime.make(layer);
    runtime = testRuntime;
    const engine = await testRuntime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await testRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await testRuntime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await testRuntime.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const emitAndDrain = (events: ReadonlyArray<LegacyProviderRuntimeEvent>) =>
      testRuntime.runPromise(
        provider.emitAndWaitForEnqueue(events).pipe(Effect.andThen(ingestion.drain)),
      );

    const createdAt = "2026-01-01T00:00:00.000Z";
    const dispatch = (command: OrchestrationCommand) =>
      testRuntime.runPromise(engine.dispatch(command));
    await dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-provider-project-create"),
      projectId: asProjectId("project-1"),
      title: "Provider Project",
      workspaceRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    });
    await dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: ThreadId.make("thread-1"),
      projectId: asProjectId("project-1"),
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: createdAt,
        lastError: null,
      },
      createdAt,
    });
    provider.setSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    const liveEvents: OrchestrationEvent[] = [];
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const stream = yield* engine.subscribeDomainEvents;
        yield* Stream.runForEach(stream, (event) =>
          Effect.sync(() => {
            liveEvents.push(event);
          }),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
      }).pipe(Scope.provide(scope)),
    );

    return {
      dispatch,
      liveEvents,
      readEvents: () => testRuntime.runPromise(engine.readEvents(0).pipe(Stream.runCollect)),
      readModel: () => testRuntime.runPromise(snapshotQuery.getSnapshot()),
      emitAndDrain,
    };
  }

  /** The host terminal the Dokkabi adapter publishes for a recorded card. */
  const hostSystemMessageEvent = (
    overrides: Partial<LegacyProviderRuntimeEvent> = {},
  ): LegacyProviderRuntimeEvent => ({
    type: "item.completed",
    eventId: asEventId("evt-host-terminal"),
    provider: ProviderDriverKind.make("dokkabi"),
    createdAt: "2026-01-01T00:00:02.000Z",
    threadId: asThreadId("thread-1"),
    turnId: asTurnId("turn-1"),
    itemId: asItemId("card:817"),
    replayKey: "session-1:card:817:system-message:abc",
    payload: {
      itemType: "system_message",
      status: "completed",
      title: "work/run_result",
      detail:
        "Host work result — status: done, outcome: completed, acceptance: accepted, exit code: 0, stop reason: done",
    },
    ...overrides,
  });

  it("persists an independent stable role system message under its own identity", async () => {
    const harness = await createHarness();
    await harness.emitAndDrain([hostSystemMessageEvent()]);

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) => message.role === "system" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.role === "system",
    );
    expect(message).toBeDefined();
    expect(message?.id).toBe("system:card:817");
    expect(message?.text).toContain("Host work result — status: done");
    expect(message?.streaming).toBe(false);
    expect(message?.turnId).toBe("turn-1");
    // The host verdict is never a model message.
    expect(thread.messages.some((entry) => entry.role === "assistant")).toBe(false);

    const durable = (await harness.readEvents()).filter(
      (event) => event.type === "thread.message-sent" && event.payload.role === "system",
    );
    expect(durable).toHaveLength(1);
    expect(
      harness.liveEvents.filter(
        (event) => event.type === "thread.message-sent" && event.payload.role === "system",
      ),
    ).toEqual(durable);
    expect(durable[0]?.payload).toMatchObject({
      messageId: "system:card:817",
      role: "system",
      text: message?.text,
      streaming: false,
    });
    // The same recorded fact replayed (same replay identity) is
    // idempotent: one stable row, unchanged.
    await harness.emitAndDrain([hostSystemMessageEvent()]);
    const replayed = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some((message: ProviderRuntimeTestMessage) => message.role === "system"),
    );
    const systemMessages = replayed.messages.filter(
      (entry: ProviderRuntimeTestMessage) => entry.role === "system",
    );
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.createdAt).toBe(message?.createdAt);
    expect(
      (await harness.readEvents()).filter(
        (event) => event.type === "thread.message-sent" && event.payload.role === "system",
      ),
    ).toHaveLength(1);
  });

  it("keeps an active assistant segment intact and allows the model message after it", async () => {
    const harness = await createHarness();
    const base = {
      provider: ProviderDriverKind.make("dokkabi"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-a1"),
    };
    await harness.emitAndDrain([
      {
        ...base,
        type: "content.delta",
        eventId: asEventId("evt-assistant-delta-1"),
        payload: { streamKind: "assistant_text", delta: "Partial " },
      },
    ]);
    // Host verdict lands mid-turn, between the model's own deltas.
    await harness.emitAndDrain([hostSystemMessageEvent({ turnId: "turn-2" })]);
    await harness.emitAndDrain([
      {
        ...base,
        type: "content.delta",
        eventId: asEventId("evt-assistant-delta-2"),
        payload: { streamKind: "assistant_text", delta: "model answer" },
      },
      {
        ...base,
        type: "item.completed",
        eventId: asEventId("evt-assistant-completed"),
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ]);

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) => message.role === "assistant" && !message.streaming,
      ),
    );
    // One assistant message carrying the whole streamed answer — the
    // system message neither finalized nor split the segment.
    const assistantMessages = thread.messages.filter(
      (entry: ProviderRuntimeTestMessage) => entry.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("Partial model answer");
    expect(assistantMessages[0]?.id).toBe("assistant:item-a1");
    const systemMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.role === "system",
    );
    expect(systemMessage).toBeDefined();
    expect(systemMessage?.id).toBe("system:card:817");
    expect(systemMessage?.turnId).toBe("turn-2");
  });

  it("keeps an active reasoning segment intact", async () => {
    const harness = await createHarness();
    const base = {
      provider: ProviderDriverKind.make("dokkabi"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
    };
    await harness.emitAndDrain([
      {
        ...base,
        type: "content.delta",
        itemId: asItemId("item-r1"),
        eventId: asEventId("evt-reasoning-delta-1"),
        payload: { streamKind: "reasoning_text", delta: "Weighing " },
      },
    ]);
    await harness.emitAndDrain([hostSystemMessageEvent({ turnId: "turn-3" })]);
    await harness.emitAndDrain([
      {
        ...base,
        type: "content.delta",
        itemId: asItemId("item-r1"),
        eventId: asEventId("evt-reasoning-delta-2"),
        payload: { streamKind: "reasoning_text", delta: "the options" },
      },
      {
        ...base,
        type: "item.completed",
        itemId: asItemId("item-r1"),
        eventId: asEventId("evt-reasoning-completed"),
        payload: { itemType: "reasoning", status: "completed" },
      },
    ]);

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) => message.role === "reasoning" && !message.streaming,
      ),
    );
    const reasoningMessages = thread.messages.filter(
      (entry: ProviderRuntimeTestMessage) => entry.role === "reasoning",
    );
    expect(reasoningMessages).toHaveLength(1);
    expect(reasoningMessages[0]?.text).toBe("Weighing the options");
    expect(
      thread.messages.some((entry: ProviderRuntimeTestMessage) => entry.role === "system"),
    ).toBe(true);
  });

  it("persists a system message without a turn unattributed, and skips one with nothing to show", async () => {
    const harness = await createHarness();
    await harness.emitAndDrain([
      hostSystemMessageEvent({
        eventId: asEventId("evt-host-terminal-unattributed"),
        turnId: undefined,
        itemId: asItemId("card:901"),
        replayKey: "session-1:card:901:system-message:def",
      }),
    ]);
    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some((message: ProviderRuntimeTestMessage) => message.role === "system"),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.role === "system",
    );
    expect(message?.id).toBe("system:card:901");
    expect(message?.turnId).toBeNull();

    // Nothing renderable means nothing persisted — no empty bubbles.
    await harness.emitAndDrain([
      hostSystemMessageEvent({
        eventId: asEventId("evt-host-terminal-empty"),
        itemId: asItemId("card:902"),
        replayKey: "session-1:card:902:system-message:xyz",
        payload: { itemType: "system_message", status: "completed" },
      }),
    ]);
    const settled = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "system:card:901",
      ),
    );
    expect(
      settled.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "system:card:902",
      ),
    ).toBe(false);
  });

  it("allows a later turn's model message after the host verdict", async () => {
    const harness = await createHarness();
    await harness.emitAndDrain([hostSystemMessageEvent()]);

    const followUp = {
      provider: ProviderDriverKind.make("dokkabi"),
      createdAt: "2026-01-01T00:00:05.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-4"),
      itemId: asItemId("item-a2"),
    };
    await harness.emitAndDrain([
      {
        ...followUp,
        type: "content.delta",
        eventId: asEventId("evt-followup-delta"),
        payload: { streamKind: "assistant_text", delta: "Follow-up answer" },
      },
      {
        ...followUp,
        type: "item.completed",
        eventId: asEventId("evt-followup-completed"),
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ]);

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.role === "assistant" && !message.streaming && message.text === "Follow-up answer",
      ),
    );
    const roles = thread.messages.map((message: ProviderRuntimeTestMessage) => [
      message.role as string,
      MessageId.make(message.id) as string,
    ]);
    expect(roles).toContainEqual(["system", "system:card:817"]);
    expect(roles).toContainEqual(["assistant", "assistant:item-a2"]);
  });
});
