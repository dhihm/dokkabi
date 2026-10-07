/**
 * R8-06j2 explicit session work-mode adapter tests (docs/internals/
 * dokkabi-work-mode.md): the read is effect-free and reports the host's
 * actual configuration; the explicit set is one click-shaped command under
 * the displayed revision with durable dedup (same id + payload → stored
 * receipt, different payload → conflict); a stale revision or busy host
 * refuses with no control write; a transport loss during set reconciles ONLY
 * through same-id status and never re-sends; a durable-intent failure or a
 * post-intent crash answers unknown with zero file effects; capability-less
 * gateways are honestly unsupported — with ZERO wire calls when the live
 * handshake said no; foreign persisted identities fail closed; and an applied
 * selection survives an adapter restart through the persisted binding.
 *
 * @module provider/Layers/DokkabiAdapter.workmode.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeDokkabiAdapter, type DokkabiAdapterError } from "./DokkabiAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { FakeGateway } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-workmode-1");
const FOREIGN_THREAD = ThreadId.make("thread-workmode-other");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-workmode-test";

process.env.DOKKABI_WORKMODE_TEST_TOKEN = "non-secret-test-fixture";

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");

interface Bundle {
  readonly adapter: ProviderAdapterShape<DokkabiAdapterError>;
  readonly gateway: FakeGateway;
}

const setup = (
  gateway: FakeGateway = new FakeGateway(),
): Effect.Effect<Bundle, DokkabiAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    const adapter = yield* makeDokkabiAdapter(
      {
        enabled: true,
        gatewayUrl: "ws://127.0.0.1:4176",
        tokenEnv: "DOKKABI_WORKMODE_TEST_TOKEN",
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
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignore));
    return { adapter, gateway };
  });

/** A persisted resume state as ProviderSessionDirectory would hand it over. */
const persistedState = (
  input: {
    readonly threadId?: string;
    readonly clientId?: string;
  } = {},
): Record<string, unknown> => ({
  binding: {
    clientId: input.clientId ?? CLIENT_ID,
    threadId: input.threadId ?? THREAD,
  },
  sessionId: "live-fake01",
});

/** A gateway manually bound to our client (no adapter session needed). */
const manuallyBound = (gateway: FakeGateway): FakeGateway => {
  gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
  return gateway;
};

const errorText = (cause: Cause.Cause<unknown>): string => String(Cause.squash(cause));

const startSession = (adapter: ProviderAdapterShape<DokkabiAdapterError>) =>
  adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });

describe("DokkabiAdapter.readWorkbenchWorkMode", () => {
  it.live("reports the host's actual configuration through the thread's own binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      gateway.workModeStanding = "work";
      const result = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      expect(result.status).toBe("available");
      if (result.status !== "available") return;
      expect(result.selection).toEqual({
        mode: "default",
        effective: "work",
        source: "default",
        revision: gateway.workModeRevision(),
      });
      expect(result.busy).toBe(false);
      // The request went out as exactly the closed read shape.
      const requests = gateway.requestsFor("workbench.workMode");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        version: 1,
        binding: { clientId: CLIENT_ID, threadId: THREAD },
        operation: "read",
      });
    }),
  );

  it.live("an unbound thread reports unavailable, never an error or empty success", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const result = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      expect(result).toEqual({
        status: "unavailable",
        reason: expect.stringContaining("No live workbench session"),
      });
    }),
  );

  it.live("a detached gateway binding reports unavailable", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      gateway.binding = undefined;
      const result = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      expect(result).toEqual({
        status: "unavailable",
        reason: expect.stringContaining("not currently bound"),
      });
    }),
  );

  it.live(
    "a read never binds or submits on the persisted path; its only preflight is the read-only handshake",
    () =>
      Effect.gen(function* () {
        const gateway = manuallyBound(new FakeGateway());
        const { adapter } = yield* setup(gateway);
        const result = yield* adapter.readWorkbenchWorkMode!(THREAD, persistedState());
        expect(result.status).toBe("available");
        expect(gateway.requestsFor("workbench.bind")).toHaveLength(0);
        expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
        // The persisted path's session/capability proof is ONE read-only
        // handshake — never a bind, never a writer effect.
        expect(gateway.requestsFor("workbench.handshake")).toHaveLength(1);
      }),
  );

  it.live("an older gateway reports unsupported with ZERO work-mode calls", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.supportWorkMode = false;
      const { adapter } = yield* setup(gateway);
      const result = yield* adapter.readWorkbenchWorkMode!(THREAD, persistedState());
      expect(result).toEqual({
        status: "unsupported",
        reason: expect.stringContaining("no work mode capability"),
      });
      // The preflight handshake discovered the absent capability; the app
      // never calls the method an old peer does not implement.
      expect(gateway.requestsFor("workbench.workMode")).toHaveLength(0);
    }),
  );

  it.live("a gateway that advertises the capability but drops the method stays a hard error", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      // A lying/broken peer: the handshake advertises workMode but the
      // method answers the documented missing-method error. The translation
      // stays unsupported — never an invented mode, never a silent success.
      const dispatch = gateway.dispatch.bind(gateway);
      gateway.dispatch = (method, params, socket, id) => {
        if (method === "workbench.workMode") {
          socket.reply(id, {
            error: { code: -32601, message: "Method not found: workbench.workMode" },
          });
          return;
        }
        dispatch(method, params, socket, id);
      };
      const { adapter } = yield* setup(gateway);
      const result = yield* adapter.readWorkbenchWorkMode!(THREAD, persistedState());
      expect(result).toEqual({
        status: "unsupported",
        reason: expect.stringContaining("does not implement workbench.workMode"),
      });
    }),
  );

  it.live("a live session whose handshake lacked the capability makes ZERO wire calls", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.supportWorkMode = false;
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const result = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      expect(result).toEqual({
        status: "unsupported",
        reason: expect.stringContaining("no work mode capability"),
      });
      expect(gateway.requestsFor("workbench.workMode")).toHaveLength(0);
    }),
  );

  it.live("a foreign persisted thread identity fails closed", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const exit = yield* Effect.exit(
        adapter.readWorkbenchWorkMode!(
          THREAD,
          persistedState({ threadId: String(FOREIGN_THREAD) }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /belongs to thread/,
      );
    }),
  );

  it.live("a foreign persisted client identity fails closed", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const exit = yield* Effect.exit(
        adapter.readWorkbenchWorkMode!(THREAD, persistedState({ clientId: "another-instance" })),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /belongs to client/,
      );
    }),
  );

  it.live("a persisted quarantine latch refuses before any selection effect", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "workmode-cmd-quarantine-1",
            expectedRevision: gateway.workModeRevision(),
            mode: "work",
          },
          { ...persistedState(), sourceMismatch: true },
        ),
      );
      expect(Exit.isSuccess(exit) && exit.value.state === "applied").toBe(false);
      expect(gateway.workModeWrites).toBe(0);
      expect(
        gateway
          .requestsFor("workbench.workMode")
          .filter((params) => (params as Record<string, unknown>).operation === "set"),
      ).toHaveLength(0);
    }),
  );

  it.live("a persisted binding never selects another current session's mode", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.sessionId = "foreign-current-session";
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "workmode-cmd-foreign-session-1",
            expectedRevision: gateway.workModeRevision(),
            mode: "work",
          },
          persistedState(),
        ),
      );
      expect(Exit.isSuccess(exit) && exit.value.state === "applied").toBe(false);
      expect(gateway.workModeWrites).toBe(0);
    }),
  );

  it.live("a lost selection cannot borrow a different command's applied status", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      // The status call answers ANOTHER command's receipt; the lost set must
      // stay unknown instead of adopting it.
      const dispatch = gateway.dispatch.bind(gateway);
      gateway.dispatch = (method, params, socket, id) => {
        const record = params as Record<string, unknown>;
        if (method === "workbench.workMode" && record.operation === "status") {
          socket.reply(id, {
            result: {
              version: 1,
              state: "applied",
              commandId: "a-different-command",
              duplicate: true,
              selection: {
                mode: "work",
                effective: "work",
                source: "session",
                revision: gateway.workModeRevision(),
              },
            },
          });
          return;
        }
        dispatch(method, params, socket, id);
      };
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      gateway.dropNextWorkModeSet = true;
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-lost-1",
          expectedRevision: gateway.workModeRevision(),
          mode: "work",
        },
        undefined,
      );
      expect(result.state).toBe("unknown");
      expect(
        gateway
          .requestsFor("workbench.workMode")
          .filter((params) => (params as Record<string, unknown>).operation === "set"),
      ).toHaveLength(1);
    }),
  );

  it.live("a documented unavailable read envelope stays typed unavailable", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const dispatch = gateway.dispatch.bind(gateway);
      gateway.dispatch = (method, params, socket, id) => {
        const record = params as Record<string, unknown>;
        if (method === "workbench.workMode" && record.operation === "read") {
          socket.reply(id, {
            result: {
              version: 1,
              state: "unavailable",
              reason: "owned kernel is unopened",
            },
          });
          return;
        }
        dispatch(method, params, socket, id);
      };
      const { adapter } = yield* setup(gateway);
      expect(yield* adapter.readWorkbenchWorkMode!(THREAD, persistedState())).toEqual({
        status: "unavailable",
        reason: "owned kernel is unopened",
      });
    }),
  );
});

describe("DokkabiAdapter.setWorkbenchWorkMode", () => {
  it.live("applies one explicit selection under the displayed revision", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-apply-1",
          expectedRevision: read.selection.revision,
          mode: "work",
        },
        undefined,
      );
      expect(result).toEqual({
        state: "applied",
        commandId: "workmode-cmd-apply-1",
        duplicate: false,
        selection: {
          mode: "work",
          effective: "work",
          source: "session",
          revision: gateway.workModeRevision(),
        },
      });
      // Exactly the closed set shape crossed the wire.
      const sets = gateway.requestsFor("workbench.workMode").filter((params) => {
        const record = params as Record<string, unknown>;
        return record.operation === "set";
      });
      expect(sets).toHaveLength(1);
      expect(sets[0]).toEqual({
        version: 1,
        binding: { clientId: CLIENT_ID, threadId: THREAD },
        operation: "set",
        commandId: "workmode-cmd-apply-1",
        expectedRevision: read.selection.revision,
        mode: "work",
      });
      // The next read exposes the actual host configuration; nothing was sent.
      const after = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      expect(after.status).toBe("available");
      if (after.status === "available") expect(after.selection.mode).toBe("work");
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
    }),
  );

  it.live("the same command and payload returns its stored outcome without applying again", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      const first = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-dedup-1",
          expectedRevision: read.selection.revision,
          mode: "chat",
        },
        undefined,
      );
      expect(first.state).toBe("applied");
      // A later explicit replay under the SAME payload (even a stale revision
      // token) is the host's stored receipt, not a second effect.
      const again = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-dedup-1",
          expectedRevision: read.selection.revision,
          mode: "chat",
        },
        undefined,
      );
      expect(again.state).toBe("applied");
      if (again.state === "applied") expect(again.duplicate).toBe(true);
      expect(gateway.workModeWrites).toBe(1);
    }),
  );

  it.live("the same command under a different payload conflicts", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      const first = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-clash-1",
          expectedRevision: read.selection.revision,
          mode: "chat",
        },
        undefined,
      );
      expect(first.state).toBe("applied");
      const clash = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-clash-1",
          expectedRevision: read.selection.revision,
          mode: "work",
        },
        undefined,
      );
      expect(clash.state).toBe("conflict");
      expect(gateway.workModeWrites).toBe(1);
    }),
  );

  it.live("a stale revision conflicts with no control write", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-stale-1",
          expectedRevision: hex64("a-revision-that-never-was"),
          mode: "work",
        },
        undefined,
      );
      expect(result.state).toBe("conflict");
      expect(gateway.workModeWrites).toBe(0);
      expect(gateway.workModeOverride).toBeUndefined();
    }),
  );

  it.live("a busy host refuses the mutation with its reason", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      gateway.workModeRefuseBusy = true;
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-busy-1",
          expectedRevision: read.selection.revision,
          mode: "work",
        },
        undefined,
      );
      expect(result.state).toBe("busy");
      expect(gateway.workModeWrites).toBe(0);
    }),
  );

  it.live("reset to default removes only this session's override", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      let read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-reset-1",
          expectedRevision: read.selection.revision,
          mode: "work",
        },
        undefined,
      );
      read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      const reset = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-reset-2",
          expectedRevision: read.selection.revision,
          mode: "default",
        },
        undefined,
      );
      expect(reset.state).toBe("applied");
      expect(gateway.workModeOverride).toBeUndefined();
      // The standing default is untouched by a session reset.
      expect(gateway.workModeStanding).toBe("chat");
      const after = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (after.status !== "available") throw new Error("expected available read");
      expect(after.selection.source).toBe("default");
      expect(after.selection.effective).toBe("chat");
    }),
  );

  it.live("a failed durable intent answers unknown with zero file effects", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      gateway.failNextWorkModeIntent = true;
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-intentfail-1",
          expectedRevision: read.selection.revision,
          mode: "work",
        },
        undefined,
      );
      expect(result.state).toBe("unknown");
      expect(gateway.workModeWrites).toBe(0);
      expect(gateway.workModeOverride).toBeUndefined();
    }),
  );

  it.live("a transport loss reconciles ONLY through same-id status and never re-sends", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      gateway.dropNextWorkModeSet = true;
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-drop-1",
          expectedRevision: read.selection.revision,
          mode: "work",
        },
        undefined,
      );
      // The effect happened; the stored receipt came back through status.
      expect(result.state).toBe("applied");
      if (result.state === "applied") {
        expect(result.commandId).toBe("workmode-cmd-drop-1");
        expect(result.duplicate).toBe(true);
      }
      const operations = gateway
        .requestsFor("workbench.workMode")
        .map((params) => (params as Record<string, unknown>).operation);
      expect(operations.filter((operation) => operation === "set")).toHaveLength(1);
      expect(operations.filter((operation) => operation === "status")).toHaveLength(1);
      const status = gateway
        .requestsFor("workbench.workMode")
        .find((params) => (params as Record<string, unknown>).operation === "status");
      expect(status).toMatchObject({ commandId: "workmode-cmd-drop-1" });
    }),
  );

  it.live("a post-intent crash stays unknown — no receipt, no automatic repeat", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      gateway.crashNextWorkModeSet = true;
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-crash-1",
          expectedRevision: read.selection.revision,
          mode: "work",
        },
        undefined,
      );
      expect(result.state).toBe("unknown");
      // The intent was durable but no file effect ran.
      expect(gateway.workModeWrites).toBe(0);
      expect(gateway.workModeOverride).toBeUndefined();
      // Exactly one set crossed the wire; reconciliation was read-only.
      const operations = gateway
        .requestsFor("workbench.workMode")
        .map((params) => (params as Record<string, unknown>).operation);
      expect(operations.filter((operation) => operation === "set")).toHaveLength(1);
      expect(operations.filter((operation) => operation === "status")).toHaveLength(1);
    }),
  );

  it.live("an older gateway reports the mutation unsupported with ZERO work-mode calls", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.supportWorkMode = false;
      const { adapter } = yield* setup(gateway);
      const result = yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-old-1",
          expectedRevision: "c".repeat(64),
          mode: "work",
        },
        persistedState(),
      );
      expect(result).toEqual({
        state: "unsupported",
        reason: expect.stringContaining("no work mode capability"),
      });
      expect(gateway.requestsFor("workbench.workMode")).toHaveLength(0);
      expect(gateway.workModeWrites).toBe(0);
    }),
  );

  it.live("an applied selection survives an adapter restart through the persisted binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      {
        const scope = yield* Scope.make("sequential");
        const adapter = yield* makeDokkabiAdapter(
          {
            enabled: true,
            gatewayUrl: "ws://127.0.0.1:4176",
            tokenEnv: "DOKKABI_WORKMODE_TEST_TOKEN",
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
        yield* startSession(adapter);
        const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
        if (read.status !== "available") throw new Error("expected available read");
        const applied = yield* adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "workmode-cmd-restart-1",
            expectedRevision: read.selection.revision,
            mode: "work",
          },
          undefined,
        );
        expect(applied.state).toBe("applied");
        yield* Scope.close(scope, Exit.void);
      }
      // Disposing the first incarnation released its transport binding. The
      // harness gateway restarted and restored its owner binding from its own
      // durable records — the control file kept the session override, which
      // is exactly what must survive on the harness side.
      gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
      {
        const gateway2 = gateway;
        const scope = yield* Scope.make("sequential");
        const adapter = yield* makeDokkabiAdapter(
          {
            enabled: true,
            gatewayUrl: "ws://127.0.0.1:4176",
            tokenEnv: "DOKKABI_WORKMODE_TEST_TOKEN",
            workspacePath: gateway2.workspacePath,
            instanceId: INSTANCE_ID,
          },
          {
            clientId: CLIENT_ID,
            pollIntervalMs: 40,
            cancelSettlementWaitMs: 200,
            socketFactory: gateway2.createSocket,
          },
        ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Scope.provide(scope));
        const result = yield* adapter.readWorkbenchWorkMode!(THREAD, persistedState());
        expect(result.status).toBe("available");
        if (result.status === "available") {
          expect(result.selection.mode).toBe("work");
          expect(result.selection.source).toBe("session");
        }
        yield* Scope.close(scope, Exit.void);
      }
    }),
  );
});

describe("DokkabiAdapter.workbenchWorkModeStatus", () => {
  it.live("reconstructs the stored receipt read-only", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const read = yield* adapter.readWorkbenchWorkMode!(THREAD, undefined);
      if (read.status !== "available") throw new Error("expected available read");
      yield* adapter.setWorkbenchWorkMode!(
        THREAD,
        {
          commandId: "workmode-cmd-status-1",
          expectedRevision: read.selection.revision,
          mode: "chat",
        },
        undefined,
      );
      const status = yield* adapter.workbenchWorkModeStatus!(
        THREAD,
        "workmode-cmd-status-1",
        undefined,
      );
      expect(status.state).toBe("applied");
      if (status.state === "applied") {
        expect(status.selection.mode).toBe("chat");
        expect(status.duplicate).toBe(true);
      }
      expect(gateway.workModeWrites).toBe(1);
    }),
  );

  it.live("an unknown command id reports unknown", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      const status = yield* adapter.workbenchWorkModeStatus!(
        THREAD,
        "workmode-cmd-never-recorded",
        undefined,
      );
      expect(status.state).toBe("unknown");
    }),
  );
});
