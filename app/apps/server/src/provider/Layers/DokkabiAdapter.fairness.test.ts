// @effect-diagnostics globalTimers:off
import * as NodeCrypto from "node:crypto";
import { CommandId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeDokkabiAdapter } from "./DokkabiAdapter.ts";
import { FakeGateway, type FakeSocket } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

// Goal: foreground lifecycle preserves event order and source admission.
// Correctness TODO: decisions reject rewinds/hash forks. Lifecycle TODO:
// detach waits for held sends; cancellation still reaches its gateway.
// Scenario: preempted reads leave session state and events free of errors.
// Stop observation TODO: a failed final read reports failure and preserves
// verified active tracking until the resumed poller reads recorded settlement.
const PARENT = ThreadId.make("fairness-parent");
const CHILD = ThreadId.make("fairness-child");
const CLIENT = "fairness-client";
const CHILD_ID = "fairness-child-1";
const INSTANCE = ProviderInstanceId.make("dokkabi");
const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

/** A withheld reply is released explicitly, never by a performance timer. */
class FairnessGateway extends FakeGateway {
  readonly child = new FakeGateway();
  readonly trace: string[] = [];
  holdNextParentRead = false;
  holdNextChildSubmit = false;
  holdNextChildStatus = false;
  failFinalReadAfterStatus = false;
  failNextChildRead = false;
  holdNextChildRead = false;
  releaseRead: (() => void) | undefined;
  releaseSubmit: (() => void) | undefined;
  releaseStatus: (() => void) | undefined;
  releaseChildRead: (() => void) | undefined;
  decisionSessionHead: Record<string, unknown> = {};
  decisionGatewayHead: Record<string, unknown> = {};
  private readonly observers = new Map<string, Array<() => void>>();
  constructor() {
    super();
    this.child.sessionId = "fairness-child-session";
    this.child.workspacePath = "/tmp/dokkabi-fairness-child";
  }
  waitFor(marker: string): Promise<void> {
    if (this.trace.includes(marker)) return Promise.resolve();
    return this.waitForNext(marker);
  }
  waitForNext(marker: string): Promise<void> {
    return new Promise((resolve) => {
      this.observers.set(marker, [...(this.observers.get(marker) ?? []), resolve]);
    });
  }
  mark(marker: string): void {
    this.trace.push(marker);
    for (const resolve of this.observers.get(marker) ?? []) resolve();
    this.observers.delete(marker);
  }
  override dispatch(method: string, params: unknown, socket: FakeSocket, requestId: number): void {
    if (method === "workbench.branchSession") {
      this.requests.push({ method, params });
      const envelope = params as {
        binding: { clientId: string; threadId: string };
        childId: string;
        method: string;
        params: unknown;
      };
      if (
        envelope.childId !== CHILD_ID ||
        envelope.binding.clientId !== this.binding?.clientId ||
        envelope.binding.threadId !== this.binding?.threadId
      ) {
        socket.reply(requestId, { error: { code: -32603, message: "Parent ownership mismatch" } });
        return;
      }
      this.mark(`child:${envelope.method}`);
      if (envelope.method === "workbench.read" && this.failNextChildRead) {
        this.failNextChildRead = false;
        this.holdNextChildRead = true;
        this.mark("child:failed-final-read");
        socket.reply(requestId, {
          error: { code: -32603, message: "recorded refresh unavailable" },
        });
        return;
      }
      if (envelope.method === "workbench.read" && this.holdNextChildRead) {
        this.holdNextChildRead = false;
        const delayed = Object.create(socket) as FakeSocket;
        delayed.reply = (id, body) => {
          this.releaseChildRead = () => socket.reply(id, body);
          this.mark("child:held-recovery-read");
        };
        this.child.dispatch(envelope.method, envelope.params, delayed, requestId);
        return;
      }
      if (envelope.method === "workbench.commandStatus" && this.failFinalReadAfterStatus) {
        this.failFinalReadAfterStatus = false;
        const delayed = Object.create(socket) as FakeSocket;
        delayed.reply = (id, body) => {
          this.failNextChildRead = true;
          socket.reply(id, body);
        };
        this.child.dispatch(envelope.method, envelope.params, delayed, requestId);
        return;
      }
      if (envelope.method === "workbench.submit" && this.holdNextChildSubmit) {
        this.holdNextChildSubmit = false;
        const delayed = Object.create(socket) as FakeSocket;
        delayed.reply = (id, body) => {
          this.releaseSubmit = () => socket.reply(id, body);
          this.mark("child:held-submit");
        };
        this.child.dispatch(envelope.method, envelope.params, delayed, requestId);
        return;
      }
      if (envelope.method === "workbench.commandStatus" && this.holdNextChildStatus) {
        this.holdNextChildStatus = false;
        const delayed = Object.create(socket) as FakeSocket;
        delayed.reply = (id, body) => {
          this.releaseStatus = () => socket.reply(id, body);
          this.mark("child:held-command-status");
        };
        this.child.dispatch(envelope.method, envelope.params, delayed, requestId);
        return;
      }
      this.child.dispatch(envelope.method, envelope.params, socket, requestId);
      return;
    }
    this.mark(`parent:${method}`);
    if (method === "workbench.decisions") {
      this.requests.push({ method, params });
      socket.reply(requestId, {
        result: {
          version: 1,
          state: "available",
          decisions: [],
          total: 0,
          omitted: 0,
          sessionCursor: {
            sessionId: this.sessionId,
            ...this.sessionHeadRef(),
            generation: this.sessionGeneration,
            ...this.decisionSessionHead,
          },
          gatewayCursor: { ...this.gatewayHeadRef(), ...this.decisionGatewayHead },
          execution: { supported: true, detail: "recorded fixture" },
        },
      });
      return;
    }
    if (method === "workbench.read" && this.holdNextParentRead) {
      this.holdNextParentRead = false;
      const delayed = Object.create(socket) as FakeSocket;
      delayed.reply = (id, body) => {
        this.releaseRead = () => {
          this.mark("parent:released-read");
          socket.reply(id, body);
        };
        this.mark("parent:held-read");
      };
      super.dispatch(method, params, delayed, requestId);
      return;
    }
    super.dispatch(method, params, socket, requestId);
  }
}

const setup = () =>
  Effect.gen(function* () {
    const gateway = new FairnessGateway();
    const scope = yield* Scope.make("sequential");
    const adapter = yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4174",
        tokenEnv: "DOKKABI_FAIRNESS_TEST_TOKEN",
        env: { DOKKABI_FAIRNESS_TEST_TOKEN: "non-secret-test-fixture" },
        workspacePath: gateway.workspacePath,
        instanceId: INSTANCE,
      },
      {
        clientId: CLIENT,
        pollIntervalMs: 10,
        cancelSettlementWaitMs: 200,
        socketFactory: gateway.createSocket,
      },
    ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
    const collector = yield* Effect.forkDetach(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          gateway.mark(`event:${event.threadId}:${event.type}`);
          if (event.type === "session.state.changed" && event.payload.state === "error") {
            gateway.mark(`error:${event.threadId}:${event.payload.reason}`);
          }
          if (
            event.type === "session.state.changed" &&
            event.payload.reason?.startsWith("Stop requested")
          ) {
            gateway.mark(`stop-pending:${event.threadId}`);
          }
          if (event.type === "turn.completed") gateway.mark(`completed:${event.threadId}`);
        }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        gateway.releaseRead?.();
        gateway.releaseSubmit?.();
        gateway.releaseStatus?.();
        gateway.releaseChildRead?.();
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.interrupt(collector);
      }),
    );
    yield* adapter.startSession({ threadId: PARENT, runtimeMode: "full-access" });
    yield* adapter.sendTurn({
      threadId: PARENT,
      commandId: CommandId.make("parent-settled"),
      input: "parent settled work",
    });
    gateway.settle("parent-settled", "success");
    yield* Effect.promise(() => gateway.waitFor(`completed:${PARENT}`));
    yield* adapter.startSession({
      threadId: CHILD,
      runtimeMode: "full-access",
      resumeCursor: {
        binding: { clientId: CLIENT, threadId: CHILD },
        sessionId: gateway.child.sessionId,
        child: {
          id: CHILD_ID,
          sessionId: gateway.child.sessionId,
          workspacePath: gateway.child.workspacePath,
          parent: { clientId: CLIENT, threadId: PARENT },
          binding: { clientId: CLIENT, threadId: CHILD },
        },
      },
    });
    return { gateway, adapter };
  });

describe("Dokkabi background poll fairness", () => {
  for (const settled of [false, true]) {
    for (const replacement of [false, true]) {
      it.live(
        `ignores obsolete ${settled ? "settled" : "pending"} Stop after detach${replacement ? " and rebind" : ""}`,
        () =>
          Effect.gen(function* () {
            const { gateway, adapter } = yield* setup();
            const commandId = CommandId.make(`obsolete-${settled}-${replacement}`);
            yield* adapter.sendTurn({
              threadId: CHILD,
              commandId,
              input: "original active command",
            });
            const resumeCursor = (yield* adapter.listSessions()).find(
              (session) => session.threadId === CHILD,
            )!.resumeCursor;
            gateway.child.autoSettleOnCancel = settled;
            gateway.holdNextChildStatus = true;
            const cancel = yield* Effect.forkDetach(
              adapter.interruptTurn(CHILD, TurnId.make(commandId)),
            );
            yield* Effect.promise(() => gateway.waitFor("child:held-command-status"));
            const readCount = gateway.child.requestsFor("workbench.read").length;
            const detach = yield* Effect.forkDetach(
              Effect.sync(() => gateway.mark("interrupt-detach-entered")).pipe(
                Effect.andThen(adapter.stopSession(CHILD)),
              ),
            );
            yield* Effect.promise(() => gateway.waitFor("interrupt-detach-entered"));
            yield* Fiber.join(yield* Effect.forkDetach(Effect.void));
            // The settlement waiter owns no adapter permit: detach removes the
            // binding while its final wire receipt waits behind commandStatus.
            expect(yield* adapter.hasSession(CHILD)).toBe(false);
            const rebind = replacement
              ? yield* Effect.forkDetach(
                  adapter.startSession({
                    threadId: CHILD,
                    runtimeMode: "full-access",
                    resumeCursor,
                  }),
                )
              : undefined;
            if (settled && !replacement) gateway.failNextChildRead = true;
            gateway.releaseStatus?.();
            yield* Fiber.join(detach);
            if (rebind !== undefined) yield* Fiber.join(rebind);
            yield* Fiber.join(cancel);
            // A later exit is a FIFO collector drain, not a timing sleep.
            yield* adapter.stopSession(PARENT);
            yield* Effect.promise(() => gateway.waitFor(`event:${PARENT}:session.exited`));
            expect(gateway.trace).not.toContain(`stop-pending:${CHILD}`);
            if (settled && !replacement) {
              expect(gateway.child.requestsFor("workbench.read")).toHaveLength(readCount);
              expect(gateway.failNextChildRead).toBe(true);
              expect(gateway.trace).not.toContain("child:failed-final-read");
            }
            if (settled && replacement)
              expect(
                gateway.trace.filter((marker) => marker === `event:${CHILD}:turn.aborted`),
              ).toHaveLength(1);
            expect(yield* adapter.hasSession(CHILD)).toBe(replacement);
            expect(gateway.child.requestsFor("workbench.cancel")).toHaveLength(1);
            expect(gateway.child.requestsFor("workbench.submit")).toHaveLength(1);
          }),
      );
    }
  }

  it.live("retains the current owner's active turn and emits one pending Stop notice", () =>
    Effect.gen(function* () {
      const { gateway, adapter } = yield* setup();
      const commandId = CommandId.make("current-owner-pending-stop");
      yield* adapter.sendTurn({ threadId: CHILD, commandId, input: "pending cancellation" });
      gateway.child.autoSettleOnCancel = false;
      yield* adapter.interruptTurn(CHILD, TurnId.make(commandId));
      yield* adapter.stopSession(PARENT);
      yield* Effect.promise(() => gateway.waitFor(`event:${PARENT}:session.exited`));
      expect(gateway.trace.filter((marker) => marker === `stop-pending:${CHILD}`)).toHaveLength(1);
      expect(
        (yield* adapter.listSessions()).find((session) => session.threadId === CHILD)?.resumeCursor,
      ).toMatchObject({ activeCommandId: commandId });
    }),
  );

  it.live("reports a failed final Stop read and recovers only from a later recorded read", () =>
    Effect.gen(function* () {
      const { gateway, adapter } = yield* setup();
      const commandId = CommandId.make("failed-final-stop-read");
      yield* adapter.sendTurn({ threadId: CHILD, commandId, input: "recorded active work" });
      const before = (yield* adapter.listSessions()).find(
        (session) => session.threadId === CHILD,
      )!.resumeCursor;
      gateway.failFinalReadAfterStatus = true;
      const result = yield* adapter.interruptTurn(CHILD, TurnId.make(commandId)).pipe(
        Effect.match({
          onFailure: (error) => ({ state: "failure" as const, error }),
          onSuccess: () => ({ state: "success" as const }),
        }),
      );
      yield* Effect.promise(() => gateway.waitFor("child:held-recovery-read"));
      expect(result).toMatchObject({
        state: "failure",
        error: { _tag: "ProviderAdapterRequestError", detail: "recorded refresh unavailable" },
      });
      expect(
        (yield* adapter.listSessions()).find((session) => session.threadId === CHILD)?.resumeCursor,
      ).toEqual(before);
      expect(before).toMatchObject({ activeCommandId: commandId });
      expect(gateway.trace).not.toContain(`event:${CHILD}:turn.aborted`);
      gateway.releaseChildRead?.();
      yield* Effect.promise(() => gateway.waitFor(`event:${CHILD}:turn.aborted`));
      const recovered = (yield* adapter.listSessions()).find(
        (session) => session.threadId === CHILD,
      )!;
      expect(recovered.resumeCursor).not.toHaveProperty("activeCommandId");
      expect(recovered.resumeCursor).not.toEqual(before);
      expect(
        gateway.trace.filter((marker) => marker === `event:${CHILD}:turn.aborted`),
      ).toHaveLength(1);
      expect(gateway.child.requestsFor("workbench.cancel")).toHaveLength(1);
      expect(gateway.child.requestsFor("workbench.submit")).toHaveLength(1);
      expect(gateway.child.commands.get(commandId)?.outcome).toBe("operator_abort");
    }),
  );

  for (const [label, head] of [
    ["gateway rewind", { gateway: { seq: 0 } }],
    [
      "same-sequence gateway hash divergence",
      { gateway: { hash: NodeCrypto.createHash("sha256").update("fork-gateway").digest("hex") } },
    ],
    [
      "same-sequence session hash divergence",
      { session: { hash: NodeCrypto.createHash("sha256").update("fork-session").digest("hex") } },
    ],
  ] as const) {
    it.live(`refuses decision ${label} without changing validated cursors`, () =>
      Effect.gen(function* () {
        const { gateway, adapter } = yield* setup();
        const before = yield* adapter.listSessions();
        expect((yield* adapter.readWorkbenchDecisions!(PARENT)).status).toBe("available");
        if ("gateway" in head) gateway.decisionGatewayHead = head.gateway;
        if ("session" in head) gateway.decisionSessionHead = head.session;
        const read = yield* Effect.exit(adapter.readWorkbenchDecisions!(PARENT));
        expect(Exit.isFailure(read)).toBe(true);
        expect((yield* adapter.listSessions()).map((session) => session.resumeCursor)).toEqual(
          before.map((session) => session.resumeCursor),
        );
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(1);
      }),
    );
  }

  for (const operation of ["stopSession", "stopAll"] as const) {
    it.live(
      `${operation} retains ownership until a held child submit settles and emits exit last`,
      () =>
        Effect.gen(function* () {
          const { gateway, adapter } = yield* setup();
          gateway.holdNextChildSubmit = true;
          const send = yield* Effect.forkDetach(
            adapter.sendTurn({
              threadId: CHILD,
              commandId: CommandId.make(`held-${operation}`),
              input: "held submit",
            }),
          );
          yield* Effect.promise(() => gateway.waitFor("child:held-submit"));
          const stop = yield* Effect.forkDetach(
            Effect.sync(() => gateway.mark("detach-started")).pipe(
              Effect.andThen(
                operation === "stopSession" ? adapter.stopSession(CHILD) : adapter.stopAll(),
              ),
            ),
          );
          yield* Effect.promise(() => gateway.waitFor("detach-started"));
          yield* Fiber.join(yield* Effect.forkDetach(Effect.void));
          expect(yield* adapter.hasSession(CHILD)).toBe(true);
          if (operation === "stopAll") expect(yield* adapter.hasSession(PARENT)).toBe(true);
          gateway.releaseSubmit?.();
          yield* Fiber.join(send);
          yield* Fiber.join(stop);
          yield* Effect.promise(() => gateway.waitFor(`event:${CHILD}:session.exited`));
          yield* Fiber.join(yield* Effect.forkDetach(Effect.void));
          const childEvents = gateway.trace.filter((marker) =>
            marker.startsWith(`event:${CHILD}:`),
          );
          const exited = childEvents.lastIndexOf(`event:${CHILD}:session.exited`);
          expect(exited).toBeGreaterThanOrEqual(0);
          expect(childEvents).toContain(`event:${CHILD}:turn.started`);
          expect(childEvents.slice(exited + 1)).toEqual([]);
          expect(yield* adapter.hasSession(CHILD)).toBe(false);
          expect(gateway.child.requestsFor("workbench.cancel")).toHaveLength(0);
        }),
    );
  }

  it.live(
    "keeps cancellation queued after an unresolved write without losing its recorded settlement",
    () =>
      Effect.gen(function* () {
        const { gateway, adapter } = yield* setup();
        const commandId = CommandId.make("held-deduplicated-submit");
        yield* adapter.sendTurn({ threadId: CHILD, commandId, input: "known active work" });
        gateway.holdNextChildSubmit = true;
        const send = yield* Effect.forkDetach(
          adapter.sendTurn({ threadId: CHILD, commandId, input: "known active work" }),
        );
        yield* Effect.promise(() => gateway.waitFor("child:held-submit"));
        const cancel = yield* Effect.forkDetach(
          adapter.interruptTurn(CHILD, TurnId.make(commandId)),
        );
        yield* Fiber.join(yield* Effect.forkDetach(Effect.void));
        expect(gateway.trace).not.toContain("child:workbench.cancel");
        gateway.releaseSubmit?.();
        yield* Effect.promise(() => gateway.waitFor("child:workbench.cancel")).pipe(
          Effect.timeout(800),
        );
        expect(gateway.child.commands.get(commandId)?.outcome).toBe("operator_abort");
        yield* Fiber.join(send);
        yield* Fiber.join(cancel);
        expect(gateway.child.requestsFor("workbench.submit")).toHaveLength(2);
        expect(gateway.child.requestsFor("workbench.cancel")).toHaveLength(1);
      }),
  );

  it.live("sends to a recorded child before releasing a held settled-parent poll", () =>
    Effect.gen(function* () {
      const { gateway, adapter } = yield* setup();
      gateway.holdNextParentRead = true;
      yield* Effect.promise(() => gateway.waitFor("parent:held-read"));
      const send = yield* Effect.forkDetach(
        adapter.sendTurn({
          threadId: CHILD,
          commandId: CommandId.make("child-send"),
          input: "independent work",
        }),
      );
      yield* Effect.promise(() => gateway.waitFor("child:workbench.submit")).pipe(
        Effect.timeout(800),
      );
      yield* Fiber.join(send);
      expect(gateway.trace).not.toContain("parent:released-read");
      expect(gateway.child.commands.get("child-send")?.state).toBe("handed_off");
      expect(gateway.trace.filter((marker) => marker.startsWith("error:"))).toEqual([]);
      expect(
        (yield* adapter.listSessions()).some(
          (session) => session.status === "error" || session.lastError !== undefined,
        ),
      ).toBe(false);
    }),
  );
  it.live("records child Stop before releasing a held settled-parent poll", () =>
    Effect.gen(function* () {
      const { gateway, adapter } = yield* setup();
      yield* adapter.sendTurn({
        threadId: CHILD,
        commandId: CommandId.make("child-stop"),
        input: "active child work",
      });
      gateway.holdNextParentRead = true;
      yield* Effect.promise(() => gateway.waitFor("parent:held-read"));
      const stop = yield* Effect.forkDetach(
        adapter.interruptTurn(CHILD, TurnId.make("child-stop")),
      );
      yield* Effect.promise(() => gateway.waitFor("child:workbench.cancel")).pipe(
        Effect.timeout(800),
      );
      yield* Fiber.join(stop);
      expect(gateway.trace).not.toContain("parent:released-read");
      expect(gateway.child.commands.get("child-stop")?.outcome).toBe("operator_abort");
      const sessions = yield* adapter.listSessions();
      expect(
        sessions.find((session) => session.threadId === CHILD)?.resumeCursor,
      ).not.toHaveProperty("activeCommandId");
    }),
  );

  it.live(
    "keeps background polls suspended through overlapping work and resumes after refusal",
    () =>
      Effect.gen(function* () {
        const { gateway, adapter } = yield* setup();
        gateway.holdNextParentRead = true;
        yield* Effect.promise(() => gateway.waitFor("parent:held-read"));
        gateway.holdNextChildSubmit = true;
        const send = yield* Effect.forkDetach(
          adapter.sendTurn({
            threadId: CHILD,
            commandId: CommandId.make("overlapping-send"),
            input: "held foreground receipt",
          }),
        );
        yield* Effect.promise(() => gateway.waitFor("child:held-submit")).pipe(Effect.timeout(800));
        const suspendedAt = gateway.trace.length;
        const refusal = yield* Effect.forkDetach(
          Effect.exit(
            adapter.sendTurn({
              threadId: PARENT,
              commandId: CommandId.make("refused-model"),
              input: "refused",
              modelSelection: { instanceId: INSTANCE, model: "foreign-model" },
            }),
          ),
        );
        // Joining a trivial sibling lets the pending foreground fiber enter its
        // reference-counted acquire while the real submit receipt remains held.
        yield* Fiber.join(yield* Effect.forkDetach(Effect.void));
        expect(gateway.trace.slice(suspendedAt)).not.toContain("parent:workbench.read");
        const resumed = gateway.waitForNext("parent:workbench.read");
        gateway.releaseSubmit?.();
        yield* Fiber.join(send);
        const result = yield* Fiber.join(refusal);
        expect(Exit.isFailure(result)).toBe(true);
        yield* Effect.promise(() => resumed).pipe(Effect.timeout(800));
        expect(gateway.trace).not.toContain("parent:released-read");
        expect(gateway.commands.has("refused-model")).toBe(false);
        const sessions = yield* adapter.listSessions();
        expect(sessions.find((session) => session.threadId === PARENT)?.status).toBe("ready");
      }),
  );

  it.live("detaches a held background read without cancelling either kernel", () =>
    Effect.gen(function* () {
      const { gateway, adapter } = yield* setup();
      gateway.holdNextParentRead = true;
      yield* Effect.promise(() => gateway.waitFor("parent:held-read"));
      yield* adapter.stopSession(PARENT).pipe(Effect.timeout(800));
      expect(gateway.trace).toContain("parent:workbench.detach");
      expect(gateway.trace).not.toContain("parent:released-read");
      expect(gateway.requestsFor("workbench.cancel")).toHaveLength(0);
      expect(gateway.child.requestsFor("workbench.cancel")).toHaveLength(0);
      expect(yield* adapter.hasSession(PARENT)).toBe(false);
      expect(yield* adapter.hasSession(CHILD)).toBe(true);
    }),
  );
});
