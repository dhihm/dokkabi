/**
 * Host work-terminal publication tests (dokkabi-dev src/dash/transcript.ts):
 * the recorded observe work/run_result system cards the harness labels
 * "Host work …" are the host's own verdict, so the adapter publishes exactly
 * those as MAIN conversation system_message items under the card's recorded
 * seq/time, command attribution and a stable own source identity — while
 * ordinary system cards and any unlabelled prose under the same event name
 * stay quiet system items, and the model's own assistant cards stay
 * assistant messages. Duplicate reads, a reconnect and later commands never
 * duplicate the message or re-attach it to another turn.
 *
 * @module provider/Layers/DokkabiAdapter.work-result.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import { CommandId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ProviderRuntimeEvent, ProviderRuntimeItemCompletedEvent } from "@t3tools/contracts";

import { makeDokkabiAdapter, type DokkabiAdapterError } from "./DokkabiAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";
import { gatewayDoubleTsForSeq } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-workresult-1");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-workresult-test";

process.env.DOKKABI_WORKRESULT_TEST_TOKEN = "non-secret-test-fixture";

/** The exact card text the harness projection formats for the D60 native
 * terminal at seq 817 (status/outcome/acceptance/exit/stop reason). */
const HOST_RESULT_TEXT =
  "Host work result — status: done, outcome: completed, acceptance: accepted, exit code: 0, stop reason: done";
const HOST_BLOCKED_TEXT =
  "Host work result — status: blocked, outcome: incomplete, acceptance: not accepted, exit code: 1, stop reason: not_sealed";
/** The blocked-terminal card after the harness merged the operator report's
 * bounded prose in as run details (one authoritative summary). */
const HOST_BLOCKED_REPORTED_TEXT =
  "Host work result — status: blocked, outcome: incomplete, acceptance: not accepted, exit code: 1, stop reason: not_sealed — The planning session ended without a sealed graph (stop_reason not_sealed). Not done.";
/** The harness no longer projects a standalone report card; the labelled
 * family stays recognised so an older recorded log still resolves. */
const HOST_REPORT_TEXT =
  "Host work report — status: blocked — The planning session ended without a sealed graph. Not done.";

interface Harness {
  readonly adapter: ProviderAdapterShape<DokkabiAdapterError>;
  readonly gateway: FakeGateway;
  readonly events: ProviderRuntimeEvent[];
  readonly waitFor: (
    predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<void>;
  readonly startSession: () => Effect.Effect<unknown, DokkabiAdapterError>;
  readonly sendTurn: (
    text: string,
    commandId: string,
  ) => Effect.Effect<{ turnId: string }, DokkabiAdapterError>;
}

const setup = (gateway: FakeGateway): Effect.Effect<Harness, DokkabiAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const adapter = yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4177",
        tokenEnv: "DOKKABI_WORKRESULT_TEST_TOKEN",
        workspacePath: gateway.workspacePath,
        instanceId: INSTANCE_ID,
      },
      {
        clientId: CLIENT_ID,
        pollIntervalMs: 40,
        cancelSettlementWaitMs: 200,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
    const events: ProviderRuntimeEvent[] = [];
    const collector = yield* Effect.forkDetach(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        yield* Fiber.interrupt(collector).pipe(Effect.ignore);
      }).pipe(Effect.ignore),
    );
    const waitFor = (
      predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
      timeoutMs = 3000,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
        while (!predicate(events)) {
          if ((yield* Clock.currentTimeMillis) > deadline) {
            return yield* Effect.die(
              `timed out waiting for events; got [${events.map((event) => event.type).join(", ")}]`,
            );
          }
          yield* Effect.sleep(10);
        }
      });
    return {
      adapter,
      gateway,
      events,
      waitFor,
      startSession: () => adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" }),
      sendTurn: (text, commandId) =>
        adapter.sendTurn({
          threadId: THREAD,
          input: text,
          commandId: CommandId.make(commandId),
        } as Parameters<typeof adapter.sendTurn>[0]) as Effect.Effect<
          { turnId: string },
          DokkabiAdapterError
        >,
    };
  });

/** A gateway manually bound to our client (no adapter session needed). */
const manuallyBound = (gateway: FakeGateway): FakeGateway => {
  gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
  return gateway;
};

const completedItems = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.filter(
    (event): event is ProviderRuntimeItemCompletedEvent => event.type === "item.completed",
  );

/** Records a host card through the fixture's seq-allocating API. */
const addHostCard = (gateway: FakeGateway, event: string, text: string): number => {
  gateway.addSystemCard(event, text);
  const card = gateway.cards.at(-1);
  if (card === undefined) throw new Error("no recorded card");
  return card.seq;
};

const assistantMessages = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  completedItems(events).filter((event) => event.payload.itemType === "assistant_message");

const hostSystemMessages = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  completedItems(events).filter((event) => event.payload.itemType === "system_message");

const systemItems = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  completedItems(events).filter((event) => event.payload.itemType === "unknown");

describe("DokkabiAdapter host work results", () => {
  it.live("publishes a labelled host terminal as a system_message item, never as the model's own", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const modelSeq = gateway.addAssistantCard("Model narrative before the verdict.");
      const seq = addHostCard(gateway, "work/run_result", HOST_RESULT_TEXT);
      addHostCard(gateway, "session/open", "session opened");
      const { events, waitFor, startSession } = yield* setup(gateway);
      yield* startSession();
      yield* waitFor((current) =>
        completedItems(current).some(
          (event) => event.payload.itemType === "system_message" && event.payload.detail === HOST_RESULT_TEXT,
        ),
      );

      // The host verdict is a MAIN conversation system message: its own item
      // type, recorded time, stable card-seq identity, unattributed to any
      // turn — while the model's assistant card stays an assistant message.
      const message = hostSystemMessages(events).find(
        (event) => event.payload.detail === HOST_RESULT_TEXT,
      );
      expect(message).toBeDefined();
      expect(message?.payload.title).toBe("work/run_result");
      expect(message?.payload.status).toBe("completed");
      expect(message?.createdAt).toBe(gatewayDoubleTsForSeq(seq));
      expect(String(message?.itemId)).toMatch(new RegExp(`card:${seq}$`));
      expect(message?.turnId).toBeUndefined();
      expect(message?.replayKey).toBe(String(message?.eventId));

      const modelMessage = assistantMessages(events).find(
        (event) => event.payload.detail === "Model narrative before the verdict.",
      );
      expect(modelMessage).toBeDefined();
      expect(String(modelMessage?.itemId)).toMatch(new RegExp(`card:${modelSeq}$`));
      expect(hostSystemMessages(events).some((event) => event.itemId === modelMessage?.itemId)).toBe(
        false,
      );

      // Ordinary system cards stay quiet system items.
      const ordinary = systemItems(events).find(
        (event) => event.payload.title === "session/open",
      );
      expect(ordinary).toBeDefined();
      expect(ordinary?.payload.detail).toBe("session opened");
      expect(ordinary?.turnId).toBeUndefined();
    }),
  );

  it.live("publishes blocked terminals and merged report details honestly, never as certified", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      addHostCard(gateway, "work/run_result", HOST_BLOCKED_REPORTED_TEXT);
      const { events, waitFor, startSession } = yield* setup(gateway);
      yield* startSession();
      yield* waitFor((current) =>
        hostSystemMessages(current).some(
          (event) => event.payload.detail === HOST_BLOCKED_REPORTED_TEXT,
        ),
      );
      const details = hostSystemMessages(events).map((event) => String(event.payload.detail));
      expect(details).toContain(HOST_BLOCKED_REPORTED_TEXT);
      expect(details.join(" ")).not.toContain("acceptance: accepted");

      // The labelled report family still resolves to the same host item type
      // when an older recorded log carries one.
      addHostCard(gateway, "work/operator_report", HOST_REPORT_TEXT);
      yield* waitFor((current) =>
        hostSystemMessages(current).some((event) => event.payload.detail === HOST_REPORT_TEXT),
      );
      const report = hostSystemMessages(events).find(
        (event) => event.payload.detail === HOST_REPORT_TEXT,
      );
      expect(report?.payload.title).toBe("work/operator_report");
      expect(assistantMessages(events).some((event) => event.payload.detail === HOST_REPORT_TEXT)).toBe(
        false,
      );
    }),
  );

  it.live("unlabelled prose under the terminal event name stays a quiet system item", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const prose =
        "I have finished all the work; every check passed and the goal is complete. acceptance: accepted, exit code: 0";
      addHostCard(gateway, "work/run_result", prose);
      const { events, waitFor, startSession } = yield* setup(gateway);
      yield* startSession();
      yield* waitFor((current) =>
        completedItems(current).some((event) => event.payload.detail === prose),
      );
      const asMain = hostSystemMessages(events).filter((event) => event.payload.detail === prose);
      expect(asMain).toHaveLength(0);
      const asSystem = systemItems(events).find((event) => event.payload.detail === prose);
      expect(asSystem).toBeDefined();
      expect(asSystem?.payload.title).toBe("work/run_result");
    }),
  );

  it.live("keeps one stable message across duplicate reads and a reconnect", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      addHostCard(gateway, "work/run_result", HOST_RESULT_TEXT);
      const { events, waitFor, startSession } = yield* setup(gateway);
      yield* startSession();
      yield* waitFor((current) =>
        hostSystemMessages(current).some((event) => event.payload.detail === HOST_RESULT_TEXT),
      );
      const first = hostSystemMessages(events).find(
        (event) => event.payload.detail === HOST_RESULT_TEXT,
      );
      expect(first).toBeDefined();

      // A transport loss followed by the poller's reconnect re-reads the same
      // recorded card: same identity, no duplicate message.
      for (const socket of gateway.sockets) socket.drop();
      yield* Effect.sleep(250);
      const messages = hostSystemMessages(events).filter(
        (event) => event.payload.detail === HOST_RESULT_TEXT,
      );
      expect(messages).toHaveLength(1);
      expect(String(messages[0]?.eventId)).toBe(String(first?.eventId));
      expect(String(messages[0]?.replayKey)).toBe(String(first?.replayKey));
      expect(String(messages[0]?.itemId)).toBe(String(first?.itemId));
    }),
  );

  it.live("attributes the terminal to its own command and never re-attaches it to a later turn", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const { events, waitFor, startSession, sendTurn } = yield* setup(gateway);
      yield* startSession();

      const first = yield* sendTurn("run the bounded wave", "cmd-host-1");
      addHostCard(gateway, "work/run_result", HOST_RESULT_TEXT);
      gateway.settle("cmd-host-1", "success");
      yield* waitFor((current) => current.some((event) => event.type === "turn.completed"));
      const message = hostSystemMessages(events).find(
        (event) => event.payload.detail === HOST_RESULT_TEXT,
      );
      expect(message).toBeDefined();
      expect(String(message?.turnId)).toBe(first.turnId);

      // A later command owns its own terminal; the earlier result keeps its
      // recorded attribution and is not re-emitted.
      yield* sendTurn("run the follow-up wave", "cmd-host-2");
      addHostCard(gateway, "work/run_result", HOST_BLOCKED_TEXT);
      gateway.settle("cmd-host-2", "failure");
      yield* waitFor((current) =>
        hostSystemMessages(current).some((event) => event.payload.detail === HOST_BLOCKED_TEXT),
      );
      const firstMessages = hostSystemMessages(events).filter(
        (event) => event.payload.detail === HOST_RESULT_TEXT,
      );
      expect(firstMessages).toHaveLength(1);
      expect(String(firstMessages[0]?.turnId)).toBe(first.turnId);
      const secondMessage = hostSystemMessages(events).find(
        (event) => event.payload.detail === HOST_BLOCKED_TEXT,
      );
      expect(String(secondMessage?.turnId)).toBe("cmd-host-2");
    }),
  );
});
