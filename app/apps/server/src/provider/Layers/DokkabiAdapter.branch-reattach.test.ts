/**
 * Explicit prepared-branch recovery after a GENUINE detach
 * (docs/internals/dokkabi-branches-r8.md, "Explicit recovery after genuine
 * detach"). The first adapter's scope is truly closed — its finalizer stops
 * pollers, detaches every binding and closes the transport — before a fresh
 * adapter receives the explicit start for the SAME recorded child with the
 * persisted parent and durable child cursors the facade would pass.
 *
 * The local double mirrors the harness rule that every workbench.decision /
 * workbench.decisions operation requires the live parent binding
 * (`requireBinding`), so a status read cannot succeed before the parent is
 * reattached. Cases: normal reattach + same-child adoption with zero Sends and
 * one start; reads never reattach; invalid durable target / missing or foreign
 * parent refuse before any wire effect; replaced parent session or generation
 * refuse through the normal startup; a lost reattach bind answers unknown and
 * an explicit retry adopts once; a replaced child source or a durable child
 * quarantine latch refuses; a changed parent model keeps the child's pin.
 *
 * @module provider/Layers/DokkabiAdapter.branch-reattach.test
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { ProviderInstanceId, ThreadId, type ProviderSessionStartInput } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeDokkabiAdapter } from "./DokkabiAdapter.ts";
import {
  FakeGateway,
  gatewayDoubleTsForSeq,
  type FakeSocket,
} from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const HARNESS_INSTANCE = ProviderInstanceId.make("dokkabi");
const TOKEN_ENV = "DOKKABI_BRANCH_REATTACH_TEST_TOKEN";
const PARENT_THREAD = ThreadId.make("thread-reattach-parent");
const CHILD_THREAD = ThreadId.make("thread-reattach-child");
const CLIENT_ID = "dokkabi-branch-reattach-test";
const CHILD_WORKSPACE = "/tmp/dokkabi-fake-reattach-child";
const CHILD_SESSION_ID = "child-reattach01";
const CHILD_ID = "child-reattach-0001";
const DECISION_ID = "dec-reattach-1";
const START_INPUT = {
  id: DECISION_ID,
  commandId: "decision-start-reattach",
  expectedRevision: 1,
  childThreadId: CHILD_THREAD,
} as const;

process.env[TOKEN_ENV] = "non-secret-test-fixture";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");

type Request = { readonly method: string; readonly params: unknown };

/** The ordinary method a request performs: the inner method of a child envelope. */
const effectiveMethod = (request: Request): string =>
  request.method === "workbench.branchSession"
    ? `child:${String((request.params as Record<string, unknown>).method)}`
    : request.method === "workbench.decision"
      ? `decision:${String((request.params as Record<string, unknown>).operation)}`
      : request.method;

/**
 * Harness-faithful branch double: a seeded selected decision, a confirmed
 * child behind the authenticated parent envelope, and decision operations
 * that REQUIRE the live parent binding exactly like the harness.
 */
class StrictBranchGateway extends FakeGateway {
  /** Drop the NEXT direct workbench.bind before applying it (outcome uncertain). */
  dropNextBind = false;
  childModel: string | undefined = undefined;
  childGeneration = hex64("reattach-child-generation-1");
  childBinding: { clientId: string; threadId: string } | undefined;
  readonly childSeq = 40;
  revision = 1;
  application: { commandId: string; seq: number } | null = null;

  private requireParentBinding(params: unknown, socket: FakeSocket, requestId: number): boolean {
    const binding = (params as Record<string, unknown>).binding as
      | { clientId: string; threadId: string }
      | undefined;
    if (
      this.binding === undefined ||
      binding === undefined ||
      this.binding.clientId !== binding.clientId ||
      this.binding.threadId !== binding.threadId
    ) {
      socket.reply(requestId, {
        error: { code: -32603, message: "no workbench binding — call workbench.bind first" },
      });
      return false;
    }
    return true;
  }

  private readonly decisionWire = (): Record<string, unknown> => ({
    id: DECISION_ID,
    revision: this.revision,
    state: this.revision === 1 ? "selected" : "application_pending",
    kind: "branch",
    question: "Which cut first?",
    options: [
      { id: "opt-1", label: "A" },
      { id: "opt-2", label: "B" },
    ],
    recommendation: "opt-1",
    rationale: "A unblocks B.",
    policy: null,
    openedAt: 0,
    selected: {
      option: "opt-1",
      actor: "human",
      commandId: "decision-select-reattach",
      at: 0,
      ref: { seq: 11, hash: hex64("decision-11") },
    },
    application:
      this.application === null
        ? null
        : {
            commandId: this.application.commandId,
            state: "unknown",
            ref: { seq: this.application.seq, hash: hex64(`application-${this.application.seq}`) },
          },
    alternateOf: null,
    citations: { open: 10, selected: 11, application: this.application?.seq ?? null },
  });

  private readonly childDescriptor = (): Record<string, unknown> => ({
    id: CHILD_ID,
    sessionId: CHILD_SESSION_ID,
    workspacePath: CHILD_WORKSPACE,
    parent: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
    binding: { clientId: CLIENT_ID, threadId: String(CHILD_THREAD) },
  });

  private readonly childIdentity = (): Record<string, unknown> => ({
    version: 1,
    workspacePath: CHILD_WORKSPACE,
    sessionId: CHILD_SESSION_ID,
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
    },
    route: this.route,
    ...((this.childModel ?? this.model) !== undefined
      ? { model: this.childModel ?? this.model }
      : {}),
    ready: true,
    routeSource: "kernel",
    permissionMode: this.permissionMode,
    kernelOpen: true,
    ...(this.childBinding !== undefined ? { bound: this.childBinding } : {}),
  });

  private readonly childReadResult = (): Record<string, unknown> => ({
    cards: [
      {
        kind: "system",
        seq: 41,
        ts: gatewayDoubleTsForSeq(41),
        event: "branch/imported",
        text: "imported child context",
      },
    ],
    state: { busy: false, activeCommandId: null },
    commands: [],
    sessionCursor: {
      sessionId: CHILD_SESSION_ID,
      seq: this.childSeq,
      hash: hex64(`child-${this.childGeneration}-${this.childSeq}`),
      generation: this.childGeneration,
    },
    gatewayCursor: { seq: 1, hash: hex64("child-gateway-1"), generation: hex64("child-gateway") },
    resnapshot: false,
  });

  override dispatch(method: string, params: unknown, socket: FakeSocket, requestId: number): void {
    const record = params as Record<string, unknown>;
    if (method === "workbench.bind" && this.dropNextBind) {
      this.requests.push({ method, params });
      this.dropNextBind = false;
      socket.drop();
      return;
    }
    switch (method) {
      case "workbench.decisions": {
        this.requests.push({ method, params });
        if (!this.requireParentBinding(params, socket, requestId)) return;
        socket.reply(requestId, {
          error: { code: -32603, message: "decisions view is not exercised by this double" },
        });
        return;
      }
      case "workbench.decision": {
        this.requests.push({ method, params });
        if (!this.requireParentBinding(params, socket, requestId)) return;
        const operation = String(record.operation);
        if (operation === "status") {
          if (this.application !== null) {
            socket.reply(requestId, {
              result: {
                version: 1,
                state: "ready",
                decision: this.decisionWire(),
                child: this.childDescriptor(),
              },
            });
            return;
          }
          socket.reply(requestId, {
            result: { version: 1, state: "available", decision: this.decisionWire() },
          });
          return;
        }
        if (operation === "start") {
          if (this.application === null) {
            this.application = { commandId: String(record.commandId), seq: 12 };
            this.revision = 2;
          }
          socket.reply(requestId, {
            result: {
              version: 1,
              state: "ready",
              decision: this.decisionWire(),
              child: this.childDescriptor(),
            },
          });
          return;
        }
        socket.reply(requestId, {
          error: { code: -32602, message: `unexercised operation ${operation}` },
        });
        return;
      }
      case "workbench.branchSession": {
        this.requests.push({ method, params });
        if (!this.requireParentBinding(params, socket, requestId)) return;
        if (String(record.childId) !== CHILD_ID) {
          socket.reply(requestId, {
            error: { code: -32603, message: "branchSession refused: unknown child id" },
          });
          return;
        }
        const inner = record.params as Record<string, unknown>;
        switch (String(record.method)) {
          case "workbench.handshake":
            socket.reply(requestId, { result: this.childIdentity() });
            return;
          case "workbench.bind":
            this.childBinding = {
              clientId: String(inner.clientId),
              threadId: String(inner.threadId),
            };
            socket.reply(requestId, {
              result: {
                ok: true,
                sessionId: CHILD_SESSION_ID,
                workspacePath: CHILD_WORKSPACE,
                reconnect: false,
              },
            });
            return;
          case "workbench.read":
            socket.reply(requestId, { result: this.childReadResult() });
            return;
          case "workbench.code": {
            const source = this.childReadResult();
            socket.reply(requestId, { result: {
              version: 1, sessionCursor: source.sessionCursor, gatewayCursor: source.gatewayCursor,
              changed: true, resnapshot: true, versions: [], body: null,
            } });
            return;
          }
          case "workbench.detach":
            this.childBinding = undefined;
            socket.reply(requestId, { result: { detached: true } });
            return;
          default:
            socket.reply(requestId, {
              error: { code: -32601, message: `Method not found: ${String(record.method)}` },
            });
            return;
        }
      }
      default:
        super.dispatch(method, params, socket, requestId);
    }
  }

  requestsSince(mark: number): ReadonlyArray<string> {
    return this.requests.slice(mark).map(effectiveMethod);
  }

  countDecisionStarts(): number {
    return this.requests.map(effectiveMethod).filter((method) => method === "decision:start")
      .length;
  }

  countSends(): number {
    return this.requests
      .map(effectiveMethod)
      .filter((method) => method === "workbench.submit" || method === "child:workbench.submit")
      .length;
  }
}

/** An adapter whose scope the test closes for real (genuine finalizer). */
const openAdapter = (gateway: StrictBranchGateway) =>
  Effect.gen(function* () {
    const scope = Scope.makeUnsafe("sequential");
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignore));
    const adapter: ProviderAdapterShape<ProviderAdapterError> = yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4175",
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
    return { adapter, close: Scope.close(scope, Exit.void) };
  });

/**
 * First incarnation: start the parent, prepare + adopt the child, capture
 * the persisted cursors, then CLOSE the adapter scope — its finalizer
 * releases every binding at the gateway (a genuine detach).
 */
const prepareThenDetach = (gateway: StrictBranchGateway) =>
  Effect.gen(function* () {
    const first = yield* openAdapter(gateway);
    const parent = yield* first.adapter.startSession({
      threadId: PARENT_THREAD,
      runtimeMode: "full-access",
    } as ProviderSessionStartInput);
    const started = yield* first.adapter.startWorkbenchBranch!(
      PARENT_THREAD,
      START_INPUT,
      parent.resumeCursor,
    );
    expect(started.state).toBe("ready");
    const sessions = yield* first.adapter.listSessions();
    const parentCursor = sessions.find((session) => session.threadId === PARENT_THREAD)!
      .resumeCursor as Record<string, unknown>;
    const childCursor = sessions.find((session) => session.threadId === CHILD_THREAD)!
      .resumeCursor as Record<string, unknown>;
    expect(childCursor.child).toBeDefined();
    yield* first.close;
    // Genuine detach: the gateway holds no parent owner binding any more.
    expect(gateway.binding).toBeUndefined();
    expect(gateway.countDecisionStarts()).toBe(1);
    return { parentCursor, childCursor, mark: gateway.requests.length };
  });

describe("DokkabiAdapter explicit parent reattachment after a genuine detach (R8)", () => {
  it.live(
    "reattaches the persisted parent through normal startup BEFORE the binding-gated status, then adopts the same child — zero Sends, one start",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, childCursor, mark } = yield* prepareThenDetach(gateway);
        const second = yield* openAdapter(gateway);
        const result = yield* second.adapter.startWorkbenchBranch!(
          PARENT_THREAD,
          START_INPUT,
          parentCursor,
          childCursor,
        );
        expect(result.state).toBe("ready");
        expect(result.child).toEqual({
          id: CHILD_ID,
          sessionId: CHILD_SESSION_ID,
          workspacePath: CHILD_WORKSPACE,
          parent: { clientId: CLIENT_ID, threadId: String(PARENT_THREAD) },
          binding: { clientId: CLIENT_ID, threadId: String(CHILD_THREAD) },
        });
        const after = gateway.requestsSince(mark);
        // Normal parent startup (handshake → bind → read) precedes the status.
        expect(after.slice(0, 4)).toEqual([
          "workbench.handshake",
          "workbench.bind",
          "workbench.read",
          "decision:status",
        ]);
        expect(after).toContain("child:workbench.bind");
        expect(after).not.toContain("decision:start");
        expect(gateway.countDecisionStarts()).toBe(1);
        expect(gateway.countSends()).toBe(0);
        expect(gateway.binding).toEqual({ clientId: CLIENT_ID, threadId: String(PARENT_THREAD) });
        expect(yield* second.adapter.hasSession(PARENT_THREAD)).toBe(true);
        expect(yield* second.adapter.hasSession(CHILD_THREAD)).toBe(true);
        // A same-command retry is the recorded result: no reattach, no adoption.
        const retryMark = gateway.requests.length;
        const retried = yield* second.adapter.startWorkbenchBranch!(
          PARENT_THREAD,
          START_INPUT,
          parentCursor,
          childCursor,
        );
        expect(retried.state).toBe("ready");
        expect(
          gateway
            .requestsSince(retryMark)
            .filter((method) => method !== "workbench.read" && method !== "child:workbench.read"),
        ).toEqual(["decision:status"]);
        expect(gateway.countDecisionStarts()).toBe(1);
      }),
  );

  it.live("E1-04 adopted child code reads remain inside the authenticated parent envelope", () =>
    Effect.gen(function* () {
      const gateway = new StrictBranchGateway();
      const { parentCursor, childCursor } = yield* prepareThenDetach(gateway);
      const second = yield* openAdapter(gateway);
      yield* second.adapter.startWorkbenchBranch!(PARENT_THREAD, START_INPUT, parentCursor, childCursor);
      const mark = gateway.requests.length;
      const result = yield* second.adapter.readWorkbenchCode!(CHILD_THREAD, {});
      expect(result.status).toBe("available");
      if (result.status === "available") expect(result.code.sessionCursor.sessionId).toBe(CHILD_SESSION_ID);
      expect(gateway.requestsSince(mark)).toEqual(["child:workbench.code"]);
      const request = gateway.requests.slice(mark)[0]!.params as Record<string, unknown>;
      expect(request.binding).toEqual({ clientId: CLIENT_ID, threadId: PARENT_THREAD });
      expect((request.params as Record<string, unknown>).binding).toEqual({ clientId: CLIENT_ID, threadId: CHILD_THREAD });
    }),
  );

  it.live("ordinary decisions/overview/record reads after the detach never reattach or bind", () =>
    Effect.gen(function* () {
      const gateway = new StrictBranchGateway();
      const { parentCursor, mark } = yield* prepareThenDetach(gateway);
      const second = yield* openAdapter(gateway);
      const decisions = yield* Effect.exit(
        second.adapter.readWorkbenchDecisions!(PARENT_THREAD, parentCursor),
      );
      if (Exit.isSuccess(decisions)) {
        expect(decisions.value.status).toBe("unavailable");
      }
      yield* Effect.exit(second.adapter.readWorkbenchOverview!(PARENT_THREAD, parentCursor));
      yield* Effect.exit(second.adapter.readWorkbenchRecord!(PARENT_THREAD, {}, parentCursor));
      const after = gateway.requestsSince(mark);
      expect(after).not.toContain("workbench.bind");
      expect(after).not.toContain("workbench.handshake");
      expect(after).not.toContain("child:workbench.bind");
      expect(gateway.binding).toBeUndefined();
      expect(yield* second.adapter.hasSession(PARENT_THREAD)).toBe(false);
      expect(yield* second.adapter.hasSession(CHILD_THREAD)).toBe(false);
    }),
  );

  it.live(
    "an invalid durable target or a missing/foreign persisted parent refuses before any wire effect",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, childCursor, mark } = yield* prepareThenDetach(gateway);
        const second = yield* openAdapter(gateway);
        const child = childCursor.child as Record<string, unknown>;
        const foreignParentChild = {
          ...childCursor,
          child: { ...child, parent: { clientId: CLIENT_ID, threadId: "thread-other-parent" } },
        };
        const foreignParent = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(
            PARENT_THREAD,
            START_INPUT,
            parentCursor,
            foreignParentChild,
          ),
        );
        expect(String(foreignParent)).toContain("not this parent's recorded child");
        const otherTarget = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(
            PARENT_THREAD,
            { ...START_INPUT, childThreadId: ThreadId.make("thread-reattach-other-target") },
            parentCursor,
            childCursor,
          ),
        );
        expect(String(otherTarget)).toContain("not this parent's recorded child");
        const missingParent = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(PARENT_THREAD, START_INPUT, undefined, childCursor),
        );
        expect(String(missingParent)).toContain("No live workbench session");
        const foreignClient = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(
            PARENT_THREAD,
            START_INPUT,
            {
              ...parentCursor,
              binding: { clientId: "another-client", threadId: String(PARENT_THREAD) },
            },
            childCursor,
          ),
        );
        expect(String(foreignClient)).toContain("belongs to client");
        const latched = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(PARENT_THREAD, START_INPUT, parentCursor, {
            ...childCursor,
            sourceMismatch: true,
          }),
        );
        expect(String(latched)).toContain("replaced or truncated source");
        expect(gateway.requestsSince(mark)).toEqual([]);
        expect(gateway.binding).toBeUndefined();
        expect(yield* second.adapter.hasSession(PARENT_THREAD)).toBe(false);
      }),
  );

  it.live(
    "a replaced parent session refuses through the normal startup — no bind, status, start or adoption",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, childCursor, mark } = yield* prepareThenDetach(gateway);
        gateway.sessionId = "live-fake-replaced";
        const second = yield* openAdapter(gateway);
        const error = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(
            PARENT_THREAD,
            START_INPUT,
            parentCursor,
            childCursor,
          ),
        );
        expect(String(error)).toContain("could not be reattached");
        expect(String(error)).toContain("live-fake-replaced");
        expect(gateway.requestsSince(mark)).toEqual(["workbench.handshake"]);
        expect(gateway.binding).toBeUndefined();
        expect(gateway.countDecisionStarts()).toBe(1);
        expect(yield* second.adapter.hasSession(CHILD_THREAD)).toBe(false);
      }),
  );

  it.live(
    "a replaced parent generation is quarantined by the normal startup and refuses before status or adoption",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, childCursor, mark } = yield* prepareThenDetach(gateway);
        gateway.flipGeneration("generation-replaced");
        const second = yield* openAdapter(gateway);
        const error = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(
            PARENT_THREAD,
            START_INPUT,
            parentCursor,
            childCursor,
          ),
        );
        expect(String(error)).toContain("source mismatch");
        expect(String(error)).toContain("preserved read-only");
        const after = gateway.requestsSince(mark);
        expect(after).not.toContain("decision:status");
        expect(after).not.toContain("child:workbench.handshake");
        expect(gateway.countDecisionStarts()).toBe(1);
        expect(yield* second.adapter.hasSession(CHILD_THREAD)).toBe(false);
        // The normal startup's quarantine latch is preserved on the parent.
        const parent = (yield* second.adapter.listSessions()).find(
          (session) => session.threadId === PARENT_THREAD,
        );
        expect((parent?.resumeCursor as Record<string, unknown>).sourceMismatch).toBe(true);
      }),
  );

  it.live(
    "a lost reattach bind answers an explicit unknown; an explicit retry reattaches and adopts once",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, childCursor, mark } = yield* prepareThenDetach(gateway);
        const second = yield* openAdapter(gateway);
        gateway.dropNextBind = true;
        const uncertain = yield* second.adapter.startWorkbenchBranch!(
          PARENT_THREAD,
          START_INPUT,
          parentCursor,
          childCursor,
        );
        expect(uncertain.state).toBe("unknown");
        expect(uncertain.reason).toContain("uncertain");
        expect(uncertain.reason).toContain("NOT re-sent");
        expect(gateway.requestsSince(mark)).not.toContain("decision:status");
        expect(yield* second.adapter.hasSession(CHILD_THREAD)).toBe(false);
        const retried = yield* second.adapter.startWorkbenchBranch!(
          PARENT_THREAD,
          START_INPUT,
          parentCursor,
          childCursor,
        );
        expect(retried.state).toBe("ready");
        expect(gateway.countDecisionStarts()).toBe(1);
        expect(gateway.countSends()).toBe(0);
        expect(
          gateway.requestsSince(mark).filter((method) => method === "child:workbench.handshake"),
        ).toHaveLength(1);
      }),
  );

  it.live(
    "a replaced child source refuses adoption after the parent reattaches — no child session, no start",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, childCursor } = yield* prepareThenDetach(gateway);
        gateway.childGeneration = hex64("reattach-child-generation-replaced");
        const second = yield* openAdapter(gateway);
        const error = yield* Effect.flip(
          second.adapter.startWorkbenchBranch!(
            PARENT_THREAD,
            START_INPUT,
            parentCursor,
            childCursor,
          ),
        );
        expect(String(error)).toContain("recorded source changed");
        expect(yield* second.adapter.hasSession(CHILD_THREAD)).toBe(false);
        expect(gateway.countDecisionStarts()).toBe(1);
        expect(gateway.countSends()).toBe(0);
      }),
  );

  it.live(
    "a changed parent model reattaches the parent while the child keeps its recorded pin",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, childCursor } = yield* prepareThenDetach(gateway);
        expect(childCursor.parentModel).toBe("glm-5.3");
        gateway.model = "glm-5.4";
        gateway.childModel = "glm-5.3";
        const second = yield* openAdapter(gateway);
        const result = yield* second.adapter.startWorkbenchBranch!(
          PARENT_THREAD,
          START_INPUT,
          parentCursor,
          childCursor,
        );
        expect(result.state).toBe("ready");
        const sessions = yield* second.adapter.listSessions();
        expect(sessions.find((session) => session.threadId === PARENT_THREAD)?.model).toBe(
          "glm-5.4",
        );
        expect(sessions.find((session) => session.threadId === CHILD_THREAD)?.model).toBe(
          "glm-5.3",
        );
        expect(gateway.countDecisionStarts()).toBe(1);

        // A child booting a model other than its durable pin still refuses.
        const other = new StrictBranchGateway();
        const recorded = yield* prepareThenDetach(other);
        other.childModel = "glm-5.5";
        const third = yield* openAdapter(other);
        const refused = yield* Effect.flip(
          third.adapter.startWorkbenchBranch!(
            PARENT_THREAD,
            START_INPUT,
            recorded.parentCursor,
            recorded.childCursor,
          ),
        );
        expect(String(refused)).toContain("cannot silently switch models");
        expect(yield* third.adapter.hasSession(CHILD_THREAD)).toBe(false);
        expect(other.countDecisionStarts()).toBe(1);
      }),
  );

  it.live(
    "bounded: without a durable child binding a detached parent is NOT reattached — the start stays unknown and unsent",
    () =>
      Effect.gen(function* () {
        const gateway = new StrictBranchGateway();
        const { parentCursor, mark } = yield* prepareThenDetach(gateway);
        const second = yield* openAdapter(gateway);
        const result = yield* second.adapter.startWorkbenchBranch!(
          PARENT_THREAD,
          START_INPUT,
          parentCursor,
        );
        expect(result.state).toBe("unknown");
        expect(result.reason).toContain("nothing was sent");
        const after = gateway.requestsSince(mark);
        expect(after).not.toContain("workbench.bind");
        expect(after).not.toContain("decision:start");
        expect(gateway.binding).toBeUndefined();
        expect(gateway.countDecisionStarts()).toBe(1);
      }),
  );
});
