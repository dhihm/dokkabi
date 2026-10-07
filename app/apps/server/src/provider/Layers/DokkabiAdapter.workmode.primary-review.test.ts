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
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-workmode-test";

process.env.DOKKABI_WORKMODE_PRIMARY_TEST_TOKEN = "non-secret-test-fixture";

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
        tokenEnv: "DOKKABI_WORKMODE_PRIMARY_TEST_TOKEN",
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

const startSession = (adapter: ProviderAdapterShape<DokkabiAdapterError>) =>
  adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });

// Primary-owned independent boundary tests. Do not weaken these to fit a draft.
describe("primary work-mode source and receipt boundaries", () => {
  it.live("persisted quarantine refuses before a selection effect", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "primary-quarantine",
            expectedRevision: gateway.workModeRevision(),
            mode: "work",
          },
          { ...persistedState(), sourceMismatch: true },
        ),
      );
      expect(Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value.state !== "applied")).toBe(
        true,
      );
      expect(gateway.workModeWrites).toBe(0);
      expect(
        gateway.requestsFor("workbench.workMode").filter((p) => p.operation === "set"),
      ).toHaveLength(0);
    }),
  );
  it.live(
    "a persisted session cannot select another current session with the same transport binding",
    () =>
      Effect.gen(function* () {
        const gateway = manuallyBound(new FakeGateway());
        gateway.sessionId = "foreign-current-session";
        const { adapter } = yield* setup(gateway);
        const exit = yield* Effect.exit(
          adapter.setWorkbenchWorkMode!(
            THREAD,
            {
              commandId: "primary-foreign-session",
              expectedRevision: gateway.workModeRevision(),
              mode: "work",
            },
            persistedState(),
          ),
        );
        expect(
          Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value.state !== "applied"),
        ).toBe(true);
        expect(gateway.workModeWrites).toBe(0);
      }),
  );
  it.live("a persisted view checks capability without calling the absent operation", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.supportWorkMode = false;
      const { adapter } = yield* setup(gateway);
      expect((yield* adapter.readWorkbenchWorkMode!(THREAD, persistedState())).status).toBe(
        "unsupported",
      );
      expect(gateway.requestsFor("workbench.workMode")).toHaveLength(0);
    }),
  );
  it.live("a documented unopened-kernel response stays typed unavailable", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const dispatch = gateway.dispatch.bind(gateway);
      gateway.dispatch = (method, params, socket, id) => {
        if (method === "workbench.workMode" && (params as any).operation === "read")
          socket.reply(id, {
            result: { version: 1, state: "unavailable", reason: "owned kernel is unopened" },
          });
        else dispatch(method, params, socket, id);
      };
      const { adapter } = yield* setup(gateway);
      expect(yield* adapter.readWorkbenchWorkMode!(THREAD, persistedState())).toEqual({
        status: "unavailable",
        reason: "owned kernel is unopened",
      });
    }),
  );
  it.live("lost selection cannot borrow a different command's applied status", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const dispatch = gateway.dispatch.bind(gateway);
      gateway.dispatch = (method, params, socket, id) => {
        if (method === "workbench.workMode" && (params as any).operation === "status")
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
        else dispatch(method, params, socket, id);
      };
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      gateway.dropNextWorkModeSet = true;
      const exit = yield* Effect.exit(
        adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "primary-lost-command",
            expectedRevision: gateway.workModeRevision(),
            mode: "work",
          },
          undefined,
        ),
      );
      expect(Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value.state !== "applied")).toBe(
        true,
      );
      expect(
        gateway.requestsFor("workbench.workMode").filter((p) => p.operation === "set"),
      ).toHaveLength(1);
    }),
  );
});

describe("primary complete source guard", () => {
  it.live("a live quarantined source refuses without a mode effect", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.addSystemCard("host/session", "Recorded initial policy");
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      gateway.flipGeneration("primary-live-replacement");
      for (let attempt = 0; attempt < 50; attempt++) {
        const sessions = yield* adapter.listSessions();
        if ((sessions[0]?.resumeCursor as any)?.sourceMismatch === true) break;
        yield* Effect.sleep(40);
      }
      const sessions = yield* adapter.listSessions();
      expect((sessions[0]?.resumeCursor as any)?.sourceMismatch).toBe(true);
      const exit = yield* Effect.exit(
        adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "primary-live-quarantine",
            expectedRevision: gateway.workModeRevision(),
            mode: "work",
          },
          undefined,
        ),
      );
      expect(Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value.state !== "applied")).toBe(
        true,
      );
      expect(gateway.workModeWrites).toBe(0);
    }),
  );
  it.live("a current live owner cannot cross to a different gateway workspace", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* startSession(adapter);
      gateway.workspacePath = "/tmp/another-recorded-workspace";
      const exit = yield* Effect.exit(
        adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "primary-live-workspace",
            expectedRevision: gateway.workModeRevision(),
            mode: "work",
          },
          undefined,
        ),
      );
      expect(Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value.state !== "applied")).toBe(
        true,
      );
      expect(gateway.workModeWrites).toBe(0);
    }),
  );
  it.live("a persisted known prefix replacement refuses before selection", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const generation = gateway.sessionGeneration;
      const resume = {
        ...persistedState(),
        sessionCursor: {
          sessionId: gateway.sessionId,
          seq: 0,
          hash: hex64(`session-${generation}-0`),
          generation,
        },
        gatewayCursor: {
          seq: 1,
          hash: hex64("gateway-1"),
          generation: hex64("gateway-generation"),
        },
      };
      gateway.flipGeneration("primary-prefix-replacement");
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.setWorkbenchWorkMode!(
          THREAD,
          {
            commandId: "primary-prefix-quarantine",
            expectedRevision: gateway.workModeRevision(),
            mode: "work",
          },
          resume,
        ),
      );
      expect(Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value.state !== "applied")).toBe(
        true,
      );
      expect(gateway.workModeWrites).toBe(0);
    }),
  );
});
