/**
 * Dokkabi adapter behavioral tests over the in-process gateway double (see
 * provider/dokkabi/WorkbenchGatewayDouble.testFixtures.ts) that implements
 * the canonical workbench.* semantics: binding ownership, durable command
 * dedup by id+fingerprint, cursor validation, active-only cancel, tool-card
 * completion refs, and delayed-read / log-replacement / truncation seams.
 *
 * Every assertion is wire-visible behavior: requests the gateway actually
 * received, events the adapter actually emitted (validated against the
 * ProviderRuntimeEvent contract), and the error taxonomy surfaced to the
 * orchestration. No implementation mirrors, no blanket casts.
 *
 * @module provider/Layers/DokkabiAdapter.test
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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";

import {
  makeDokkabiAdapter,
  type DokkabiAdapterConfig,
  type DokkabiAdapterError,
} from "./DokkabiAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  FakeGateway,
  gatewayDoubleTsForSeq,
} from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

// --- harness plumbing ---

/** Plain-runtime Crypto service built from node's secure primitives. */
const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-test-1");
const WORKSPACE = "/tmp/dokkabi-fake-workspace";
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");

// The adapter's transport resolves the token from the server environment.
process.env.DOKKABI_TEST_TOKEN = "non-secret-test-fixture";

interface AdapterBundle {
  readonly adapter: ProviderAdapterShape<DokkabiAdapterError>;
  readonly scope: Scope.Closeable;
}

const makeAdapterForTest = (
  gateway: FakeGateway,
  configOverrides: Partial<DokkabiAdapterConfig> = {},
): Effect.Effect<AdapterBundle, DokkabiAdapterError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const adapter = yield* makeDokkabiAdapter(
      {
        enabled: configOverrides.enabled ?? true,
        gatewayUrl: configOverrides.gatewayUrl ?? "ws://127.0.0.1:4174",
        tokenEnv: configOverrides.tokenEnv ?? "DOKKABI_TEST_TOKEN",
        workspacePath: configOverrides.workspacePath ?? gateway.workspacePath,
        instanceId: INSTANCE_ID,
      },
      {
        clientId: "app-test",
        pollIntervalMs: 40,
        cancelSettlementWaitMs: 200,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
    return { adapter, scope };
  });

interface Harness {
  readonly adapter: ProviderAdapterShape<DokkabiAdapterError>;
  readonly events: ProviderRuntimeEvent[];
  readonly gateway: FakeGateway;
  readonly waitFor: (
    predicate: (events: ReadonlyArray<ProviderRuntimeEvent>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<void>;
  readonly startSession: (
    input?: Partial<ProviderSessionStartInput>,
  ) => Effect.Effect<ProviderSession, DokkabiAdapterError>;
  readonly sendTurn: (input: {
    readonly text: string;
    readonly commandId?: string;
    readonly model?: string;
  }) => Effect.Effect<ProviderTurnStartResult, DokkabiAdapterError>;
}

/** Builds a fully-wired adapter harness; its scope closes with the test. */
const setup = (
  gateway: FakeGateway = new FakeGateway(),
  configOverrides: Partial<DokkabiAdapterConfig> = {},
): Effect.Effect<Harness, DokkabiAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const { adapter, scope } = yield* makeAdapterForTest(gateway, configOverrides);
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
      events,
      gateway,
      waitFor,
      startSession: (input: Partial<ProviderSessionStartInput> = {}) =>
        adapter.startSession({
          threadId: THREAD,
          runtimeMode: "full-access",
          ...input,
        } as ProviderSessionStartInput),
      sendTurn: ({ text, commandId, model }) =>
        adapter.sendTurn({
          threadId: THREAD,
          input: text,
          ...(commandId !== undefined ? { commandId: CommandId.make(commandId) } : {}),
          ...(model !== undefined ? { modelSelection: { instanceId: INSTANCE_ID, model } } : {}),
        } as ProviderSendTurnInput),
    };
  });

const eventTypes = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.map((event) => event.type);
const countType = (events: ReadonlyArray<ProviderRuntimeEvent>, type: string): number =>
  events.filter((event) => event.type === type).length;
const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const payloadReason = (event: ProviderRuntimeEvent | undefined): string | undefined =>
  (event as { payload?: { reason?: string } } | undefined)?.payload?.reason;
const payloadOf = (event: ProviderRuntimeEvent | undefined) =>
  (event as { payload?: Record<string, unknown> } | undefined)?.payload;

// --- gates and session start ---

describe("DokkabiAdapter.startSession gates", () => {
  it.live("refuses a disabled adapter with a setup reason and opens no socket", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway, { enabled: false });
      const outcome = yield* Effect.exit(harness.startSession());
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(gateway.sockets).toHaveLength(0);
    }),
  );

  it.live("refuses an app approval-required runtime policy before any wire traffic", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      const outcome = yield* Effect.exit(
        harness.adapter.startSession({ threadId: THREAD, runtimeMode: "approval-required" }),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(gateway.requests).toEqual([]);
    }),
  );

  it.live("refuses a gateway permissionMode other than bypass BEFORE binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.permissionMode = "ask";
      const harness = yield* setup(gateway);
      const outcome = yield* Effect.exit(harness.startSession());
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(gateway.requestsFor("workbench.handshake")).toHaveLength(1);
      expect(gateway.requestsFor("workbench.bind")).toEqual([]);
    }),
  );

  it.live("refuses a workspace cwd redirect and a mismatched explicit model", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      const cwdOutcome = yield* Effect.exit(
        harness.adapter.startSession({
          threadId: THREAD,
          runtimeMode: "full-access",
          cwd: "/tmp/somewhere-else",
        }),
      );
      expect(Exit.isFailure(cwdOutcome)).toBe(true);
      expect(gateway.requests).toEqual([]);
      const modelOutcome = yield* Effect.exit(
        harness.adapter.startSession({
          threadId: THREAD,
          runtimeMode: "full-access",
          modelSelection: { instanceId: INSTANCE_ID, model: "not-the-configured-model" },
        }),
      );
      expect(Exit.isFailure(modelOutcome)).toBe(true);
      expect(gateway.requestsFor("workbench.bind")).toEqual([]);
    }),
  );
});

describe("DokkabiAdapter model selection", () => {
  const catalog = [
    { route: "glm", provider: "zai", model: "glm-5.3", name: "GLM 5.3", connected: true },
    {
      route: "claude",
      provider: "anthropic",
      model: "claude-fixture",
      name: "Claude fixture",
      connected: true,
    },
  ];
  it.live("binds before changing providers and exposes the confirmed model", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.modelCatalog = catalog;
      const harness = yield* setup(gateway);
      const session = yield* harness.startSession({
        modelSelection: { instanceId: INSTANCE_ID, model: "claude/claude-fixture" },
      });
      expect(session.model).toBe("claude/claude-fixture");
      const methods = gateway.requests.map((r) => r.method);
      expect(methods.indexOf("workbench.bind")).toBeLessThan(methods.indexOf("workbench.model"));
      expect(gateway.requests.filter((r) => r.method === "workbench.model")).toHaveLength(1);
      expect(gateway.requests.filter((r) => r.method === "workbench.submit")).toHaveLength(0);
    }),
  );
  it.live("changes the selected provider before submit and never calls it twice", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.modelCatalog = catalog;
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "model selection fixture", model: "claude/claude-fixture" });
      expect(gateway.route).toBe("claude");
      const methods = gateway.requests.map((r) => r.method);
      expect(methods.indexOf("workbench.model")).toBeLessThan(methods.indexOf("workbench.submit"));
      expect(gateway.requests.filter((r) => r.method === "workbench.model")).toHaveLength(1);
    }),
  );
  it.live("busy and carry-confirmation outcomes leave no submit on the wrong model", () =>
    Effect.gen(function* () {
      for (const state of ["busy", "confirmation_required"] as const) {
        const gateway = new FakeGateway();
        gateway.modelCatalog = catalog;
        gateway.modelSelectionState = state;
        const harness = yield* setup(gateway);
        yield* harness.startSession();
        const result = yield* harness
          .sendTurn({ text: "must not send", model: "claude/claude-fixture" })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(gateway.route).toBe("glm");
        expect(gateway.requests.some((r) => r.method === "workbench.submit")).toBe(false);
        expect(gateway.requests.filter((r) => r.method === "workbench.model")).toHaveLength(1);
      }
    }),
  );
});

describe("DokkabiAdapter model selection uncertainty", () => {
  const catalog = [
    {
      route: "claude",
      provider: "anthropic",
      model: "claude-fixture",
      name: "Claude fixture",
      connected: true,
    },
  ];
  it.live("does not mutate a different session discovered after bind", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.modelCatalog = catalog;
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      gateway.sessionId = "another-session";
      const result = yield* harness
        .sendTurn({ text: "must not send", model: "claude/claude-fixture" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(gateway.requestsFor("workbench.model")).toHaveLength(0);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
    }),
  );
  it.live("lost replies and mismatched receipts or identities never submit or retry", () =>
    Effect.gen(function* () {
      for (const fault of ["drop", "wrong-receipt", "unchanged-identity"] as const) {
        const gateway = new FakeGateway();
        gateway.modelCatalog = catalog;
        gateway.modelSelectionFault = fault;
        const harness = yield* setup(gateway);
        yield* harness.startSession();
        const result = yield* harness
          .sendTurn({ text: "must not send", model: "claude/claude-fixture" })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(gateway.requestsFor("workbench.model")).toHaveLength(1);
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
      }
    }),
  );
});

describe("DokkabiAdapter.startSession happy path", () => {
  it.live("publishes session.started FIRST, then source-derived turns and items", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.commands.set("cmd-hist-1", {
        commandId: "cmd-hist-1",
        state: "settled",
        outcome: "success",
        sources: {
          turnStart: 101,
          turnStartAt: gatewayDoubleTsForSeq(101),
          settlement: 203,
          settlementAt: gatewayDoubleTsForSeq(203),
        },
      });
      gateway.cards.push(
        { kind: "note", seq: 100, ts: "2026-01-01T00:00:00.000Z", text: "recorded user text" },
        { kind: "assistant", seq: 102, ts: "2026-01-01T00:00:01.000Z", text: "recorded reply" },
      );
      const harness = yield* setup(gateway);
      const session = yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));

      expect(session.status).toBe("ready");
      expect(session.resumeCursor).toMatchObject({
        sessionId: gateway.sessionId,
        binding: { clientId: "app-test", threadId: THREAD },
      });
      const types = eventTypes(harness.events);
      expect(types[0]).toBe("session.started");
      const startedIndex = types.indexOf("turn.started");
      const itemIndex = types.indexOf("item.completed");
      const completedIndex = types.indexOf("turn.completed");
      expect(startedIndex).toBeGreaterThan(-1);
      expect(completedIndex).toBeGreaterThan(startedIndex);
      expect(itemIndex).toBeGreaterThan(startedIndex);
      expect(itemIndex).toBeLessThan(completedIndex);
      const turn = harness.events[startedIndex] as { turnId?: string };
      expect(turn.turnId).toBe("cmd-hist-1");
      for (const event of harness.events) {
        expect(() => decodeEvent(event)).not.toThrow();
      }
    }),
  );

  it.live("advertises harness workspace lifecycle and the configured root", () =>
    Effect.gen(function* () {
      const harness = yield* setup(new FakeGateway());
      expect(harness.adapter.capabilities.workspaceLifecycle).toBe("harness");
      expect(harness.adapter.capabilities.workspaceRoots).toEqual([WORKSPACE]);
    }),
  );

  it.live("listSessions is a deferred view of live state", () =>
    Effect.gen(function* () {
      const harness = yield* setup(new FakeGateway());
      expect(yield* harness.adapter.listSessions()).toEqual([]);
      yield* harness.startSession();
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.threadId).toBe(THREAD);
      expect(yield* harness.adapter.hasSession(THREAD)).toBe(true);
    }),
  );
});

// --- resume ---

describe("DokkabiAdapter resume", () => {
  it.live("restores cursors and active command mapping without duplicating history", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.cards.push({
        kind: "assistant",
        seq: 102,
        ts: "2026-01-01T00:00:01.000Z",
        text: "recorded reply",
      });
      gateway.commands.set("cmd-live-1", {
        commandId: "cmd-live-1",
        state: "accepted",
        sources: { turnStart: 101, turnStartAt: gatewayDoubleTsForSeq(101) },
      });
      gateway.activeCommandId = "cmd-live-1";
      const harness = yield* setup(gateway);
      const first = yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.started"));
      const eventCount = harness.events.length;

      const second = yield* harness.startSession({ resumeCursor: first.resumeCursor });
      expect(harness.events.length).toBe(eventCount);
      expect(second.status).toBe("running");
    }),
  );

  it.live("refuses foreign and malformed resume state before binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      const cases: ReadonlyArray<unknown> = [
        { binding: { clientId: "someone-else", threadId: THREAD }, sessionId: gateway.sessionId },
        {
          binding: { clientId: "app-test", threadId: "another-thread" },
          sessionId: gateway.sessionId,
        },
        { binding: { clientId: "app-test", threadId: THREAD }, sessionId: "live-somebodyelse" },
        { binding: "not-an-object" },
      ];
      for (const resumeCursor of cases) {
        const outcome = yield* Effect.exit(
          harness.adapter.startSession({
            threadId: THREAD,
            runtimeMode: "full-access",
            resumeCursor,
          }),
        );
        expect(Exit.isFailure(outcome)).toBe(true);
      }
      expect(gateway.requestsFor("workbench.bind")).toEqual([]);
    }),
  );
});

// --- source-mismatch quarantine (replaced or truncated log) ---

describe("DokkabiAdapter source-mismatch quarantine", () => {
  const primeWithHistory = (gateway: FakeGateway) => {
    gateway.cards.push(
      { kind: "note", seq: 210, ts: "2026-01-01T00:00:00.000Z", text: "recorded user text" },
      { kind: "assistant", seq: 212, ts: "2026-01-01T00:00:01.000Z", text: "old generation reply" },
    );
    gateway.commands.set("cmd-old", {
      commandId: "cmd-old",
      state: "settled",
      outcome: "success",
      sources: {
        turnStart: 211,
        turnStartAt: gatewayDoubleTsForSeq(211),
        settlement: 213,
        settlementAt: gatewayDoubleTsForSeq(213),
      },
    });
  };

  it.live("quarantines a replaced log: visible error, preserved rows, refused Sends", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      primeWithHistory(gateway);
      const harness = yield* setup(gateway);
      const first = yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));
      const before = harness.events.length;
      const cursorBefore = (first.resumeCursor as { sessionCursor?: { seq?: number } })
        .sessionCursor?.seq;

      // The harness log is REPLACED (new generation) with different content.
      gateway.flipGeneration("generation-2");
      gateway.cards.length = 0;
      gateway.commands.clear();
      gateway.cards.push({
        kind: "assistant",
        seq: 402,
        ts: "2026-01-01T00:02:00.000Z",
        text: "replacement log reply",
      });
      yield* harness.waitFor((events) =>
        events.slice(before).some((event) => payloadReason(event)?.includes("source mismatch")),
      );
      // Give any (forbidden) rebuild a chance to surface, then pin the state.
      yield* Effect.sleep(150);

      const quarantineError = harness.events.find((event) =>
        payloadReason(event)?.includes("source mismatch"),
      );
      expect(quarantineError?.type).toBe("session.state.changed");
      // ZERO new cards/settlements projected from the replaced source.
      expect(
        harness.events
          .slice(before)
          .filter((event) => event.type.startsWith("item.") || event.type.startsWith("turn.")),
      ).toEqual([]);
      // Prior cursors are PRESERVED (not adopted from the replacement).
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.status).toBe("error");
      const cursor = sessions[0]?.resumeCursor as {
        sourceMismatch?: boolean;
        sessionCursor?: { seq?: number };
      };
      expect(cursor.sourceMismatch).toBe(true);
      expect(cursor.sessionCursor?.seq).toBe(cursorBefore);
      // Sends are refused with the quarantine reason.
      const sendOutcome = yield* Effect.exit(harness.sendTurn({ text: "after replacement" }));
      expect(Exit.isFailure(sendOutcome)).toBe(true);
      expect(gateway.requestsFor("workbench.submit")).toEqual([]);
      // readThread serves the PRESERVED conversation, not the replacement.
      const snapshot = yield* harness.adapter.readThread(THREAD);
      const texts = snapshot.turns
        .flatMap((turn) => turn.items as ReadonlyArray<{ text?: string }>)
        .map((item) => item.text ?? "")
        .join("\n");
      expect(texts).toContain("old generation reply");
      expect(texts).not.toContain("replacement log reply");
    }),
  );

  it.live("quarantines a same-generation truncated log the same way", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      primeWithHistory(gateway);
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));
      const before = harness.events.length;

      // Same generation, but the source is truncated behind our cursor: the
      // prior cursor no longer validates against the chain (the recorded
      // cards at seq 210+ no longer exist and the head sits below our cursor).
      gateway.truncateToSeq(199);
      yield* harness.waitFor((events) =>
        events.slice(before).some((event) => payloadReason(event)?.includes("source mismatch")),
      );
      yield* Effect.sleep(100);
      expect(
        harness.events
          .slice(before)
          .filter((event) => event.type.startsWith("item.") || event.type.startsWith("turn.")),
      ).toEqual([]);
      const sendOutcome = yield* Effect.exit(harness.sendTurn({ text: "after truncation" }));
      expect(Exit.isFailure(sendOutcome)).toBe(true);
    }),
  );

  it.live("keeps the latch across polls and refuses resume until reconciliation", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      primeWithHistory(gateway);
      const harness = yield* setup(gateway);
      const first = yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));

      gateway.flipGeneration("generation-3");
      yield* harness.waitFor((events) =>
        events.some((event) => payloadReason(event)?.includes("source mismatch")),
      );
      const errorCount = harness.events.filter((event) =>
        payloadReason(event)?.includes("source mismatch"),
      ).length;
      // Later polls must not silently clear the latch or spam new errors.
      yield* Effect.sleep(200);
      expect(
        harness.events.filter((event) => payloadReason(event)?.includes("source mismatch")).length,
      ).toBe(errorCount);
      const sessions = yield* harness.adapter.listSessions();
      const latch = sessions[0]?.resumeCursor as { sourceMismatch?: boolean };
      expect(latch.sourceMismatch).toBe(true);

      // Resume WITH the latched cursor is refused.
      const resumeOutcome = yield* Effect.exit(
        harness.startSession({ resumeCursor: first.resumeCursor }),
      );
      expect(Exit.isFailure(resumeOutcome)).toBe(true);
      // Re-starting the quarantined thread is refused too.
      const restartOutcome = yield* Effect.exit(harness.startSession());
      expect(Exit.isFailure(restartOutcome)).toBe(true);

      // Explicit reconciliation: safe detach, then a FRESH conversation
      // adopts the replacement log (adoption without a prior view).
      yield* harness.adapter.stopSession(THREAD);
      const fresh = yield* harness.startSession();
      expect(fresh.status).toBe("ready");
      const freshCursor = fresh.resumeCursor as { sourceMismatch?: boolean };
      expect(freshCursor.sourceMismatch).toBeUndefined();
    }),
  );
});

// --- sendTurn ---

describe("DokkabiAdapter.sendTurn truthfulness", () => {
  it.live("emits turn.started exactly once, then recorded assistant text and settlement once", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();

      const result = yield* harness.sendTurn({ text: "operator message", commandId: "cmd-run-1" });
      expect(result.turnId).toBe("cmd-run-1");
      gateway.addAssistantCard("actual recorded reply");
      gateway.settle("cmd-run-1", "success");
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));

      expect(countType(harness.events, "turn.started")).toBe(1);
      const assistantEvents = harness.events.filter(
        (event) =>
          event.type === "item.completed" && payloadOf(event)?.itemType === "assistant_message",
      );
      expect(assistantEvents).toHaveLength(1);
      expect(payloadOf(assistantEvents[0])?.detail).toBe("actual recorded reply");
      expect(assistantEvents[0]?.turnId).toBe("cmd-run-1");
      expect(countType(harness.events, "turn.completed")).toBe(1);
      const startedIndex = eventTypes(harness.events).indexOf("turn.started");
      const itemIndex = harness.events.indexOf(assistantEvents[0] as ProviderRuntimeEvent);
      const completedIndex = eventTypes(harness.events).indexOf("turn.completed");
      expect(startedIndex).toBeLessThan(itemIndex);
      expect(itemIndex).toBeLessThan(completedIndex);
      // No per-token streaming claim on recorded cards.
      expect(countType(harness.events, "content.delta")).toBe(0);
    }),
  );

  it.live("reconciles a settled duplicate without reopening a fresh turn", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "same payload", commandId: "cmd-dup" });
      gateway.settle("cmd-dup", "success");
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));
      const counts = {
        started: countType(harness.events, "turn.started"),
        completed: countType(harness.events, "turn.completed"),
      };

      const replay = yield* harness.sendTurn({ text: "same payload", commandId: "cmd-dup" });
      expect(replay.turnId).toBe("cmd-dup");
      expect(countType(harness.events, "turn.started")).toBe(counts.started);
      expect(countType(harness.events, "turn.completed")).toBe(counts.completed);
    }),
  );

  it.live("surfaces a same-id-different-payload conflict", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "first payload", commandId: "cmd-conflict" });
      gateway.settle("cmd-conflict", "success");
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));

      const outcome = yield* Effect.exit(
        harness.adapter.sendTurn({
          threadId: THREAD,
          commandId: CommandId.make("cmd-conflict"),
          input: "different payload",
        }),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
    }),
  );

  it.live("refuses a second, different command while one is active", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "first", commandId: "cmd-active" });
      const outcome = yield* Effect.exit(
        harness.sendTurn({ text: "second", commandId: "cmd-next" }),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      // The deduplicating replay of the ACTIVE command still reaches the gateway.
      yield* harness.sendTurn({ text: "first", commandId: "cmd-active" });
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(2);
    }),
  );

  it.live("rejects and stages surface truthfully, with visible later attention", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.submitMode = "rejected";
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const rejected = yield* Effect.exit(harness.sendTurn({ text: "hi", commandId: "cmd-rej" }));
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(countType(harness.events, "turn.started")).toBe(0);
      yield* harness.waitFor((events) =>
        events.some((event) => payloadReason(event)?.includes("rejected")),
      );

      gateway.submitMode = "staged";
      const staged = yield* Effect.exit(harness.sendTurn({ text: "hi", commandId: "cmd-stage" }));
      expect(Exit.isFailure(staged)).toBe(true);
      yield* harness.waitFor((events) =>
        events.some((event) => payloadReason(event)?.includes("staged")),
      );
    }),
  );

  it.live("never blind-retries after transport loss: reconciles a proven handoff", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.submitMode = "drop";
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const result = yield* harness.sendTurn({ text: "uncertain delivery", commandId: "cmd-drop" });
      expect(result.turnId).toBe("cmd-drop");
      // Exactly one submit frame crossed the wire — no retry.
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);
      expect(gateway.requestsFor("workbench.commandStatus")).toHaveLength(1);
    }),
  );

  it.live("never blind-retries when the reconciled state is unknown", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.submitMode = "drop-unknown";
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const outcome = yield* Effect.exit(
        harness.sendTurn({ text: "no provable handoff", commandId: "cmd-unknown" }),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);
    }),
  );

  it.live("maps wire-unsafe orchestration ids to stable aliases and back", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const originalId = "provider:evt-turn-start:97ab";
      const result = yield* harness.sendTurn({ text: "aliased", commandId: originalId });
      // The app keeps the orchestration id; the gateway saw a wire-safe alias.
      expect(result.turnId).toBe(originalId);
      const submitParams = gateway.requestsFor("workbench.submit")[0] as { commandId: string };
      expect(submitParams.commandId).toMatch(/^app-cmd-[0-9a-f]{40}$/);
      expect(submitParams.commandId).not.toBe(originalId);

      gateway.settle(String(submitParams.commandId), "success");
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));
      const completed = harness.events.find((event) => event.type === "turn.completed");
      expect(completed?.turnId).toBe(originalId);
      const cursor = result.resumeCursor as { commandAliases?: Record<string, string> };
      expect(cursor.commandAliases?.[String(submitParams.commandId)]).toBe(originalId);
    }),
  );
});

// --- stop ---

describe("DokkabiAdapter.interruptTurn", () => {
  it.live("clears the turn only when the recorded settlement says aborted", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "stop me", commandId: "cmd-stop" });
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.started"));

      yield* harness.adapter.interruptTurn(THREAD);
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.aborted"));
      expect(countType(harness.events, "turn.aborted")).toBe(1);
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.status).toBe("ready");
    }),
  );

  it.live("keeps the turn running when only a cancellation was requested", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.autoSettleOnCancel = false;
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "keep running", commandId: "cmd-pending" });
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.started"));

      yield* harness.adapter.interruptTurn(THREAD);
      yield* harness.waitFor((events) =>
        events.some((event) => payloadReason(event)?.includes("Stop requested")),
      );
      expect(countType(harness.events, "turn.aborted")).toBe(0);
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.status).toBe("running");
    }),
  );

  it.live("reports an uncertain cancellation as unresolved, not stopped", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.cancelMode = "unknown";
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "uncertain", commandId: "cmd-uc" });
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.started"));
      const outcome = yield* Effect.exit(harness.adapter.interruptTurn(THREAD));
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(countType(harness.events, "turn.aborted")).toBe(0);
    }),
  );

  it.live("stops a command id too long or unsafe for the wire vocabulary", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const longId = "c".repeat(200);
      yield* harness.sendTurn({ text: "long id", commandId: longId });
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.started"));

      yield* harness.adapter.interruptTurn(THREAD, TurnId.make(longId));
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.aborted"));
      const cancelParams = gateway.requestsFor("workbench.cancel")[0] as {
        commandId: string;
        targetCommandId: string;
      };
      expect(cancelParams.commandId).toMatch(/^stop-[0-9a-f]{32}$/);
      expect(cancelParams.targetCommandId.length).toBeLessThanOrEqual(128);
      const aborted = harness.events.find((event) => event.type === "turn.aborted");
      expect(aborted?.turnId).toBe(longId);
    }),
  );

  it.live("refuses a foreign stop target", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const outcome = yield* Effect.exit(
        harness.adapter.interruptTurn(THREAD, TurnId.make("never-sent")),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(gateway.requestsFor("workbench.cancel")).toEqual([]);
    }),
  );
});

// --- projection ---

describe("DokkabiAdapter projection", () => {
  it.live("treats tool completion refs — never durationMs — as completion evidence", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.commands.set("cmd-tools", {
        commandId: "cmd-tools",
        state: "settled",
        outcome: "success",
        sources: {
          turnStart: 101,
          turnStartAt: gatewayDoubleTsForSeq(101),
          settlement: 900,
          settlementAt: gatewayDoubleTsForSeq(900),
        },
      });
      // tool/start + tool/result + tool/end with duration MISSING: completed.
      gateway.cards.push(
        {
          kind: "tool",
          seq: 102,
          ts: "2026-01-01T00:00:02.000Z",
          id: "tool-1",
          tool: "bash",
          resultText: "recorded result",
          completionSeq: 103,
          completionHash: "a".repeat(64),
          durationMs: "missing",
          error: false,
        },
        // tool/start + tool/result WITHOUT tool/end: still running.
        {
          kind: "tool",
          seq: 104,
          ts: "2026-01-01T00:00:03.000Z",
          id: "tool-2",
          tool: "read",
          resultText: "interim result",
          durationMs: "missing",
          error: false,
        },
      );
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.waitFor((events) =>
        events.some((event) => event.type === "item.completed" && event.itemId !== undefined),
      );

      const itemEvents = harness.events.filter((event) => event.type.startsWith("item."));
      const completed = itemEvents.filter((event) => event.type === "item.completed");
      const started = itemEvents.filter((event) => event.type === "item.started");
      expect(completed).toHaveLength(1);
      expect(payloadOf(completed[0])?.detail).toBe("recorded result");
      expect(started).toHaveLength(1);
      // The still-running card carries its recorded result as interim progress.
      expect(payloadOf(started[0])?.detail).toBe("interim result");
    }),
  );

  it.live("attributes reused tool ids per invocation, not per name", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.commands.set("cmd-reuse", {
        commandId: "cmd-reuse",
        state: "settled",
        outcome: "success",
        sources: {
          turnStart: 101,
          turnStartAt: gatewayDoubleTsForSeq(101),
          settlement: 900,
          settlementAt: gatewayDoubleTsForSeq(900),
        },
      });
      // First invocation of id "shared-tool": no end yet.
      gateway.cards.push({
        kind: "tool",
        seq: 102,
        ts: "2026-01-01T00:00:02.000Z",
        id: "shared-tool",
        tool: "bash",
        durationMs: "missing",
        error: false,
      });
      // Second invocation of the SAME id, WITH its own end.
      gateway.cards.push({
        kind: "tool",
        seq: 104,
        ts: "2026-01-01T00:00:03.000Z",
        id: "shared-tool",
        tool: "bash",
        completionSeq: 105,
        completionHash: "b".repeat(64),
        durationMs: "missing",
        error: false,
      });
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.waitFor(
        (events) => events.filter((e) => e.type === "item.completed").length > 0,
      );
      const completedIds = harness.events
        .filter((event) => event.type === "item.completed")
        .map((event) => String(event.itemId));
      const startedIds = harness.events
        .filter((event) => event.type === "item.started")
        .map((event) => String(event.itemId));
      expect(completedIds).toHaveLength(1);
      expect(completedIds[0]).toContain("card:104");
      expect(startedIds).toHaveLength(1);
      expect(startedIds[0]).toContain("card:102");
    }),
  );

  it.live("upserts a late tool/end onto the SAME item — no duplicate, no lost completion", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const seq = gateway.addToolCard({
        id: "tool-late",
        tool: "bash",
        resultText: "result first",
      });
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "item.started"));
      const started = harness.events.find((event) => event.type === "item.started");

      gateway.completeToolCard(seq);
      yield* harness.waitFor((events) => events.some((event) => event.type === "item.completed"));
      const completed = harness.events.filter((event) => event.type === "item.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.itemId).toBe(started?.itemId);
      expect(payloadOf(completed[0])?.detail).toBe("result first");
      expect(completed[0]?.eventId).not.toBe(started?.eventId);
    }),
  );

  it.live("keeps system records and unsupported approvals visible", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.addSystemCard("session/error", "recorded failure detail");
      gateway.cards.push({
        kind: "approval",
        seq: 300,
        ts: "2026-01-01T00:00:05.000Z",
        requestId: "req-1",
        approvalKind: "permission",
        state: "requested",
        detail: "run dangerous thing",
      });
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "request.opened"));

      const systemItem = harness.events.find(
        (event) => event.type === "item.completed" && payloadOf(event)?.title === "session/error",
      );
      expect(payloadOf(systemItem)?.detail).toBe("recorded failure detail");
      const opened = harness.events.find((event) => event.type === "request.opened");
      expect(opened?.requestId).toBe("req-1");
      // The app cannot answer harness approvals through this protocol.
      const refuse = yield* Effect.exit(
        harness.adapter.respondToRequest(THREAD, "req-1" as never, "approve" as never),
      );
      expect(Exit.isFailure(refuse)).toBe(true);
    }),
  );

  it.live("does not duplicate assistant text or reopen settled turns across polls", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "stable", commandId: "cmd-stable" });
      gateway.addAssistantCard("single reply");
      gateway.settle("cmd-stable", "success");
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));
      const snapshot = harness.events.length;
      yield* Effect.sleep(150);
      expect(harness.events.length).toBe(snapshot);
    }),
  );

  it.live("a delayed stale poll cannot roll a newer projection backward", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "race", commandId: "cmd-race" });
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.started"));
      gateway.addAssistantCard("newer reply");
      gateway.settle("cmd-race", "success");
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));

      const sessionsBefore = yield* harness.adapter.listSessions();
      const cursorBefore = (sessionsBefore[0]?.resumeCursor as { sessionCursor?: { seq?: number } })
        ?.sessionCursor?.seq;

      // Arm a 250ms-delayed poll reply, wait until the poller has FETCHED
      // it, then run a duplicate submit whose own fresh read lands between.
      gateway.delayNextReadMs = 250;
      const readsBefore = gateway.requestsFor("workbench.read").length;
      yield* Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + 2000;
        while (gateway.requestsFor("workbench.read").length <= readsBefore) {
          if ((yield* Clock.currentTimeMillis) > deadline) {
            return yield* Effect.die("poller read never started");
          }
          yield* Effect.sleep(5);
        }
      });
      const replay = yield* harness.sendTurn({ text: "race", commandId: "cmd-race" });
      expect(replay.turnId).toBe("cmd-race");
      yield* Effect.sleep(350);

      // The newer projection must survive the stale poll: the assistant row
      // is still attributed once and the session cursor never regresses.
      const assistantRows = harness.events.filter(
        (event) =>
          event.type === "item.completed" && payloadOf(event)?.itemType === "assistant_message",
      );
      expect(assistantRows).toHaveLength(1);
      const sessionsAfter = yield* harness.adapter.listSessions();
      const cursorAfter = (sessionsAfter[0]?.resumeCursor as { sessionCursor?: { seq?: number } })
        ?.sessionCursor?.seq;
      expect(cursorAfter).toBeDefined();
      expect(cursorAfter!).toBeGreaterThanOrEqual(cursorBefore ?? 0);
      expect(sessionsAfter[0]?.status).toBe("ready");
    }),
  );
});

// --- detach and finalization ---

describe("DokkabiAdapter detach and scope finalization", () => {
  it.live("stopSession detaches the transport only — no kernel close, poller fenced", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.waitFor((events) => events.some((event) => event.type === "session.started"));
      yield* harness.adapter.stopSession(THREAD);
      yield* harness.waitFor((events) => events.some((event) => event.type === "session.exited"));
      expect(gateway.requestsFor("workbench.detach")).toHaveLength(1);

      const after = harness.events.length;
      gateway.addAssistantCard("ignored after detach");
      yield* Effect.sleep(150);
      expect(harness.events.length).toBe(after);
      expect(yield* harness.adapter.hasSession(THREAD)).toBe(false);
    }),
  );

  it.live("scope close ends the event stream and detaches every binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter, scope } = yield* makeAdapterForTest(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      const collected: ProviderRuntimeEvent[] = [];
      const collector = yield* Effect.forkDetach(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            collected.push(event);
          }),
        ),
      );
      yield* Scope.close(scope, Exit.void);
      // The finalizer ends the queue, so the collector COMPLETES (not hangs):
      // awaiting it proves both the exit event and the stream end.
      yield* Fiber.await(collector);
      expect(collected.some((event) => event.type === "session.exited")).toBe(true);
      expect(gateway.requestsFor("workbench.detach")).toHaveLength(1);
    }),
  );

  it.live("readThread derives turns from recorded command ranges, keeping note text", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "recorded user text", commandId: "cmd-turns" });
      gateway.addAssistantCard("turn reply");
      gateway.settle("cmd-turns", "success");
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));

      const snapshot = yield* harness.adapter.readThread(THREAD);
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]?.id).toBe("cmd-turns");
      const items = snapshot.turns[0]?.items as ReadonlyArray<{ kind: string; text?: string }>;
      expect(items.find((item) => item.kind === "note")?.text).toBe("recorded user text");
      expect(items.find((item) => item.kind === "assistant")?.text).toBe("turn reply");
    }),
  );

  it.live("refuses rollback and attachments with clear reasons", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const rollback = yield* Effect.exit(harness.adapter.rollbackThread(THREAD, 1));
      expect(Exit.isFailure(rollback)).toBe(true);
      const attachments = yield* Effect.exit(
        harness.adapter.sendTurn({
          threadId: THREAD,
          input: "with files",
          attachments: [{ type: "image", path: "/tmp/x.png" }] as never,
        }),
      );
      expect(Exit.isFailure(attachments)).toBe(true);
      const continuation = yield* Effect.exit(
        harness.adapter.sendTurn({ threadId: THREAD, continuation: true } as never),
      );
      expect(Exit.isFailure(continuation)).toBe(true);
    }),
  );

  it.live("refuses plan-mode turns explicitly instead of executing them", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      const outcome = yield* Effect.exit(
        harness.adapter.sendTurn({
          threadId: THREAD,
          input: "plan something",
          interactionMode: "plan",
        }),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      // Refused before the wire: no submit ever reached the gateway.
      expect(gateway.requestsFor("workbench.submit")).toEqual([]);
    }),
  );
});

// --- recorded replay identity and time (R2-06) ---

describe("DokkabiAdapter recorded replay identity and time", () => {
  it.live("times recorded card and lifecycle events from the source, never the clock", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "timed turn", commandId: "cmd-time-1" });
      const sources = gateway.commands.get("cmd-time-1")?.sources as {
        turnStart: number;
        turnStartAt: string;
      };
      const toolSeq = gateway.addToolCard({ id: "tool-timed", tool: "bash", resultText: "out" });
      const assistantSeq = gateway.addAssistantCard("timed recorded reply");
      const toolCardTs = gatewayDoubleTsForSeq(toolSeq);
      const assistantCardTs = gatewayDoubleTsForSeq(assistantSeq);
      yield* harness.waitFor((events) => events.some((event) => event.type === "item.started"));
      gateway.completeToolCard(toolSeq);
      gateway.settle("cmd-time-1", "success");
      const settlementAt = gateway.commands.get("cmd-time-1")?.sources.settlementAt as string;
      yield* harness.waitFor((events) => events.some((event) => event.type === "turn.completed"));

      const started = harness.events.find((event) => event.type === "turn.started");
      const completed = harness.events.find((event) => event.type === "turn.completed");
      // Recorded lifecycle times come from the source rows, paired with seqs.
      expect(started?.createdAt).toBe(sources.turnStartAt);
      expect(completed?.createdAt).toBe(settlementAt);
      expect(started?.replayKey).toBe(started?.eventId);
      expect(started?.replayKey).toContain(`turn-start:cmd-time-1`);
      expect(completed?.replayKey).toBe(completed?.eventId);
      expect(completed?.replayKey).toContain(`turn-settled:cmd-time-1:success`);

      // Recorded cards anchor their ORIGINAL recorded start time; a joined
      // completion keeps that anchor, and each content change is a distinct
      // replay fact on the SAME item identity.
      const toolEvents = harness.events.filter(
        (event) => event.type === "item.started" || event.type === "item.completed",
      );
      const toolStarted = toolEvents.find((event) => event.type === "item.started");
      const toolCompleted = toolEvents.find(
        (event) =>
          event.type === "item.completed" && payloadOf(event)?.itemType === "command_execution",
      );
      expect(toolStarted?.createdAt).toBe(toolCardTs);
      expect(toolCompleted?.createdAt).toBe(toolCardTs);
      expect(toolStarted?.itemId).toBe(toolCompleted?.itemId);
      expect(toolStarted?.replayKey).toBeDefined();
      expect(toolCompleted?.replayKey).toBeDefined();
      expect(toolStarted?.replayKey).not.toBe(toolCompleted?.replayKey);

      const assistant = harness.events.find(
        (event) =>
          event.type === "item.completed" && payloadOf(event)?.itemType === "assistant_message",
      );
      expect(assistant?.createdAt).toBe(assistantCardTs);
      expect(assistant?.replayKey).toBeDefined();

      // Transient session/transport statuses are NOT replay facts: no
      // replayKey, and they keep the live clock path.
      const sessionStarted = harness.events.find((event) => event.type === "session.started");
      expect(sessionStarted?.replayKey).toBeUndefined();
    }),
  );

  it.live("refuses to project recorded turn lifecycle when the source time is missing", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.omitLifecycleSourceTimes = true;
      const harness = yield* setup(gateway);
      yield* harness.startSession();
      yield* harness.sendTurn({ text: "untimed turn", commandId: "cmd-untime" });
      gateway.addAssistantCard("recorded but untimed lifecycle");
      gateway.settle("cmd-untime", "success");
      yield* harness.waitFor(
        (events) =>
          events.some(
            (event) =>
              event.type === "session.state.changed" &&
              payloadReason(event)?.includes("missing source time") === true,
          ),
        5000,
      );

      // Refused, never invented: no lifecycle event carries a fabricated time.
      expect(countType(harness.events, "turn.started")).toBe(0);
      expect(countType(harness.events, "turn.completed")).toBe(0);
      expect(countType(harness.events, "turn.aborted")).toBe(0);
      // The whole invalid view is refused, including otherwise valid cards.
      expect(countType(harness.events, "item.completed")).toBe(0);
      const submissions = gateway.requestsFor("workbench.submit").length;
      const refused = yield* Effect.exit(
        harness.sendTurn({ text: "must refuse", commandId: "cmd-refused" }),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(submissions);
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.status).toBe("error");
    }),
  );
  for (const badTime of [undefined, "2026-02-30T00:00:00.000Z", "not-a-time"]) {
    it.live(
      `refuses a late invalid view atomically (${badTime ?? "missing"}) and recovers from valid source`,
      () =>
        Effect.gen(function* () {
          const gateway = new FakeGateway();
          const harness = yield* setup(gateway);
          yield* harness.startSession();
          yield* harness.sendTurn({ text: "original", commandId: "cmd-atomic" });
          gateway.addAssistantCard("original reply");
          gateway.settle("cmd-atomic", "success");
          yield* harness.waitFor((events) =>
            events.some((event) => event.type === "turn.completed"),
          );
          const cursorBefore = (yield* harness.adapter.listSessions())[0]?.resumeCursor;
          const command = gateway.commands.get("cmd-atomic")!;
          const recordedAt = command.sources.turnStartAt;
          if (badTime === undefined) delete command.sources.turnStartAt;
          else command.sources.turnStartAt = badTime;
          const projectedBefore = harness.events.filter(
            (event) => event.replayKey !== undefined,
          ).length;
          gateway.addAssistantCard("late valid card in invalid view");
          yield* harness.waitFor((events) =>
            events.some(
              (event) =>
                event.type === "session.state.changed" &&
                payloadReason(event)?.includes("missing source time"),
            ),
          );
          const invalidSession = (yield* harness.adapter.listSessions())[0];
          expect(invalidSession?.resumeCursor).toEqual(cursorBefore);
          expect(harness.events.filter((event) => event.replayKey !== undefined)).toHaveLength(
            projectedBefore,
          );
          const submissions = gateway.requestsFor("workbench.submit").length;
          expect(
            Exit.isFailure(
              yield* Effect.exit(harness.sendTurn({ text: "blocked", commandId: "cmd-blocked" })),
            ),
          ).toBe(true);
          expect(gateway.requestsFor("workbench.submit")).toHaveLength(submissions);
          command.sources.turnStartAt = recordedAt!;
          yield* harness.waitFor((events) =>
            events.some(
              (event) =>
                event.type === "item.completed" &&
                payloadOf(event)?.detail === "late valid card in invalid view",
            ),
          );
          expect((yield* harness.adapter.listSessions())[0]?.status).toBe("ready");
          expect(countType(harness.events, "turn.completed")).toBe(1);
        }),
    );
  }
});

it.live("routes independent same-workspace conversations and resumes to their own gateway", () =>
  Effect.gen(function* () {
    const a = new FakeGateway();
    const b = new FakeGateway();
    b.sessionId = "desktop-independent-b";
    const threadB = ThreadId.make("thread-test-2");
    const selected: string[] = [];
    const adapter = yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4174",
        tokenEnv: "DOKKABI_TEST_TOKEN",
        workspacePath: WORKSPACE,
        instanceId: INSTANCE_ID,
        gatewayForThread: (threadId) =>
          Effect.sync(() => {
            selected.push(threadId);
            return {
              gatewayUrl: threadId === THREAD ? "ws://127.0.0.1:4174" : "ws://127.0.0.1:4175",
              tokenEnv: "DOKKABI_TEST_TOKEN",
            };
          }),
      },
      {
        clientId: "app-test",
        pollIntervalMs: 10000,
        cancelSettlementWaitMs: 200,
        socketFactory: (url) => (url.includes(":4175") ? b.createSocket() : a.createSocket()),
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService));
    const first = yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
    const second = yield* adapter.startSession({ threadId: threadB, runtimeMode: "full-access" });
    expect(first.resumeCursor).not.toEqual(second.resumeCursor);
    yield* adapter.sendTurn({
      threadId: THREAD,
      input: "Conversation A",
      commandId: CommandId.make("shared-command"),
    });
    yield* adapter.sendTurn({
      threadId: threadB,
      input: "Conversation B",
      commandId: CommandId.make("shared-command"),
    });
    expect(
      a.requests
        .filter((r) => r.method === "workbench.submit")
        .map((r) => (r.params as { text: string }).text),
    ).toEqual(["Conversation A"]);
    expect(
      b.requests
        .filter((r) => r.method === "workbench.submit")
        .map((r) => (r.params as { text: string }).text),
    ).toEqual(["Conversation B"]);
    expect(selected).toEqual([THREAD, threadB]);
    yield* adapter.stopSession(THREAD);
    const resumed = yield* adapter.startSession({
      threadId: THREAD,
      runtimeMode: "full-access",
      resumeCursor: first.resumeCursor,
    });
    expect(resumed.resumeCursor).toMatchObject({ sessionId: a.sessionId });
    expect(b.requests.filter((r) => r.method === "workbench.detach")).toHaveLength(0);
  }),
);
