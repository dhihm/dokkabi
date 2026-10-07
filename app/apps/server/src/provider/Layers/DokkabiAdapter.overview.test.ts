/**
 * R3 recorded-overview adapter tests (docs/internals/dokkabi-overview-r3.md):
 * the authenticated thread routes through its persisted provider instance and
 * the gateway's own binding; foreign instance/thread/source identities fail
 * closed; a replaced generation fails closed even when the response claims
 * resnapshot; unavailable or unsupported capabilities never become empty
 * success or trigger writer recovery; unsupported is reserved for the
 * documented missing method; an overview poll never advances the transcript
 * resume cursors.
 *
 * @module provider/Layers/DokkabiAdapter.overview.test
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
import { FakeGateway, emptyOverview } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-overview-1");
const FOREIGN_THREAD = ThreadId.make("thread-overview-other");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-test";

process.env.DOKKABI_TEST_TOKEN = "non-secret-test-fixture";

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
        gatewayUrl: "ws://127.0.0.1:4174",
        tokenEnv: "DOKKABI_TEST_TOKEN",
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
    readonly sessionCursor?: { seq: number; hash: string; generation: string };
    readonly gatewayCursor?: { seq: number; hash: string; generation: string };
    readonly threadId?: string;
  } = {},
): Record<string, unknown> => ({
  binding: { clientId: CLIENT_ID, threadId: input.threadId ?? THREAD },
  sessionId: "live-fake01",
  ...(input.sessionCursor !== undefined
    ? {
        sessionCursor: {
          sessionId: "live-fake01",
          ...input.sessionCursor,
        },
      }
    : {}),
  ...(input.gatewayCursor !== undefined ? { gatewayCursor: input.gatewayCursor } : {}),
});

/** A recorded overview with real content: sealed plan, frame, measured usage. */
const recordedOverview = (head: number): Record<string, unknown> => ({
  work: {
    state: "available",
    goal: {
      id: "goal-recorded",
      statement: "Build the recorded overview",
      source: { seq: 3, hash: hex64("goal-row") },
    },
    planDigest: hex64("plan"),
    todos: [{ id: "todo-1", title: "One", class: "host", state: "green", priority: 1 }],
    cases: { total: 2, green: 1, red: 0, pending: 1 },
    errors: [],
  },
  context: {
    state: "available",
    mode: "on",
    revision: 4,
    digest: hex64("graph"),
    frame: {
      id: "cf-2",
      stage: "dispatched",
      source: { seq: Math.min(head, 150), hash: hex64("frame-row") },
    },
    lessonCount: 1,
    errors: [],
  },
  usage: {
    records: 2,
    input: { total: 150, missing: 0, latestSource: { seq: 5, hash: hex64("usage-5") } },
    output: { total: 40, missing: 1, latestSource: { seq: 5, hash: hex64("usage-5") } },
    reasoning: { total: null, missing: 2, latestSource: null },
    cacheRead: { total: 500, missing: 0, latestSource: { seq: 5, hash: hex64("usage-5") } },
    cacheWrite: { total: null, missing: 2, latestSource: null },
  },
});

/** A gateway manually bound to our client (no adapter session needed). */
const manuallyBound = (gateway: FakeGateway): FakeGateway => {
  gateway.binding = { clientId: CLIENT_ID, threadId: THREAD };
  return gateway;
};

const errorText = (cause: Cause.Cause<unknown>): string => String(Cause.squash(cause));

describe("DokkabiAdapter.readWorkbenchOverview", () => {
  it.live("projects an available recorded overview through the thread's own binding", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setOverview(recordedOverview(200));
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined);
      expect(result.status).toBe("available");
      expect(result.overview?.work.cases).toEqual({ total: 2, green: 1, red: 0, pending: 1 });
      expect(result.overview?.context.frame?.stage).toBe("dispatched");
      expect(result.overview?.usage.input.total).toBe(150);
      // The request went out under the thread's binding only.
      const requests = gateway.requestsFor("workbench.overview");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        version: 1,
        binding: { clientId: CLIENT_ID, threadId: THREAD },
      });
    }),
  );

  it.live("never advances transcript cursors or issues writer calls from a poll", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      const before = (yield* adapter.listSessions())[0]!;
      gateway.setOverview(recordedOverview(200));
      yield* adapter.readWorkbenchOverview!(THREAD, before.resumeCursor);
      yield* adapter.readWorkbenchOverview!(THREAD, before.resumeCursor);
      const after = (yield* adapter.listSessions())[0]!;
      expect(after.resumeCursor).toEqual(before.resumeCursor);
      expect(gateway.requestsFor("workbench.submit")).toHaveLength(0);
      expect(gateway.requestsFor("workbench.bind")).toHaveLength(1);
      expect(gateway.requestsFor("workbench.cancel")).toHaveLength(0);
    }),
  );

  it.live("an unbound thread reports unavailable, not an error or empty success", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined);
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
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      // The gateway restarted: its binding is gone while ours persists.
      gateway.binding = undefined;
      const result = yield* adapter.readWorkbenchOverview!(THREAD, undefined);
      expect(result).toEqual({
        status: "unavailable",
        reason: expect.stringContaining("not currently bound"),
      });
    }),
  );

  it.live("a pre-R3 gateway without the method reports unsupported", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.supportOverview = false;
      const { adapter } = yield* setup(gateway);
      const result = yield* adapter.readWorkbenchOverview!(
        THREAD,
        persistedState({
          sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
        }),
      );
      expect(result).toEqual({
        status: "unsupported",
        reason: expect.stringContaining("does not implement workbench.overview"),
      });
    }),
  );

  it.live("a malformed gateway reply stays a hard error, never unsupported", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setOverview({ ...emptyOverview(), unexpectedField: true });
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
          THREAD,
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).not.toMatch(
        /unsupported/i,
      );
    }),
  );

  it.live("a persisted resume state from a foreign thread fails closed", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
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

  it.live("a persisted resume state from a foreign client fails closed", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const foreign = {
        binding: { clientId: "another-instance", threadId: String(THREAD) },
        sessionId: "live-fake01",
      };
      const exit = yield* Effect.exit(adapter.readWorkbenchOverview!(THREAD, foreign));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /belongs to client/,
      );
    }),
  );

  it.live("an overview naming a foreign session identity fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      // The gateway now fronts a different session than the bound one.
      gateway.sessionId = "live-other99";
      gateway.setOverview(recordedOverview(10));
      const exit = yield* Effect.exit(adapter.readWorkbenchOverview!(THREAD, undefined));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /names session/,
      );
    }),
  );

  it.live("a replaced session generation fails closed even when resnapshot is claimed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.forceOverviewResnapshot = true;
      gateway.setOverview(recordedOverview(200));
      // The persisted cursor names the generation the thread validated; the
      // gateway now answers from a different, replaced chain.
      const persisted = persistedState({
        sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
      });
      gateway.flipGeneration("replaced-chain");
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchOverview!(THREAD, persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/replaced/);
    }),
  );

  it.live("a session head that rewound fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setOverview(recordedOverview(200));
      // The thread validated a head at seq 205 within this generation; the
      // response rewinds to an earlier seq.
      const persisted = persistedState({
        sessionCursor: {
          seq: 205,
          hash: hex64("session-old-205"),
          generation: gateway.sessionGeneration,
        },
      });
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchOverview!(THREAD, persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/rewound/);
    }),
  );

  it.live("a same-seq head with a different hash fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setOverview(recordedOverview(200));
      const persisted = persistedState({
        sessionCursor: {
          seq: 200,
          hash: hex64("a-different-row-at-200"),
          generation: gateway.sessionGeneration,
        },
      });
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchOverview!(THREAD, persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(/diverged/);
    }),
  );

  it.live("a replaced gateway ledger generation fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      gateway.setOverview(recordedOverview(200));
      const persisted = persistedState({
        sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
        gatewayCursor: { seq: 1, hash: hex64("g1"), generation: hex64("old-ledger") },
      });
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(adapter.readWorkbenchOverview!(THREAD, persisted));
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /ledger was replaced/,
      );
    }),
  );

  it.live("case counts that do not add up fail closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedOverview(200);
      (broken.work as Record<string, unknown>).cases = { total: 5, green: 1, red: 0, pending: 1 };
      gateway.setOverview(broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
          THREAD,
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /do not add up/,
      );
    }),
  );

  it.live("an invalid work summary with successful case counts fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedOverview(200);
      (broken.work as Record<string, unknown>).state = "invalid";
      gateway.setOverview(broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
          THREAD,
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /must not carry case counts/,
      );
    }),
  );

  it.live("a usage metric counting more missing records than exist fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedOverview(200);
      const usage = broken.usage as Record<string, unknown>;
      usage.records = 1;
      gateway.setOverview(broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
          THREAD,
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /more missing records than exist/,
      );
    }),
  );

  it.live("a usage total without its latest source fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const broken = recordedOverview(200);
      const usage = broken.usage as Record<string, unknown>;
      usage.reasoning = { total: 12, missing: 0, latestSource: null };
      gateway.setOverview(broken);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
          THREAD,
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /missing its total or latest source/,
      );
    }),
  );

  it.live("a source ref beyond the returned head fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      const beyond = recordedOverview(200);
      (beyond.work as Record<string, unknown>).goal = {
        id: "goal-recorded",
        statement: "Build the recorded overview",
        source: { seq: 99_999, hash: hex64("goal-row") },
      };
      gateway.setOverview(beyond);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
          THREAD,
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /outside the returned session head/,
      );
    }),
  );

  it.live("a source ref at the head carrying a foreign hash fails closed", () =>
    Effect.gen(function* () {
      const gateway = manuallyBound(new FakeGateway());
      // The gateway's head hash for seq 200 is derived; cite a different one.
      const atHead = recordedOverview(200);
      (atHead.work as Record<string, unknown>).goal = {
        id: "goal-recorded",
        statement: "Build the recorded overview",
        source: { seq: 200, hash: hex64("not-the-head-hash") },
      };
      gateway.setOverview(atHead);
      const { adapter } = yield* setup(gateway);
      const exit = yield* Effect.exit(
        adapter.readWorkbenchOverview!(
          THREAD,
          persistedState({
            sessionCursor: { seq: 1, hash: hex64("s1"), generation: gateway.sessionGeneration },
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(false);
      expect(errorText(Exit.isFailure(exit) ? exit.cause : Cause.fail(exit))).toMatch(
        /outside the returned session head/,
      );
    }),
  );
});
