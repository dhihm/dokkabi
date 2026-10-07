/**
 * R5 retained-record adapter tests (docs/internals/dokkabi-records-r5.md):
 * the authenticated thread routes through its persisted provider instance
 * and the gateway's own binding; foreign thread identities fail closed; an
 * older pre-R5 gateway is unsupported while a detached binding is
 * unavailable — neither becomes an empty success; a record read never
 * advances the transcript resume cursors nor issues writer calls; and the
 * record body is held to its own exactness: canonical row hashes, chain
 * contiguity, honest completion and immutable pins that survive appends.
 * Hashes are built independently here (hand-rolled sorted-key canonical
 * JSON), never through the verifier's own encoding.
 *
 * @module provider/Layers/DokkabiAdapter.record.test
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

const THREAD = ThreadId.make("thread-record-1");
const FOREIGN_THREAD = ThreadId.make("thread-record-other");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-test";

process.env.DOKKABI_TEST_TOKEN = "non-secret-test-fixture";

const hex64 = (seed: string): string => NodeCrypto.createHash("sha256").update(seed).digest("hex");
const genesis = "0".repeat(64);

// Independent canonical encoding: recursively sorted keys, exactly the
// harness's canonicalJson shape — written out here rather than imported so
// a verifier encoding change cannot silently satisfy these fixtures.
const canonical = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
};
const unsignedHash = (unsigned: Record<string, unknown>): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(canonical(unsigned)), "utf8")
    .digest("hex");

interface BuiltRow {
  readonly seq: number;
  readonly ts: string;
  readonly kind: "observe";
  readonly name: string;
  readonly prev_hash: string;
  readonly hash: string;
  readonly payload: Record<string, unknown>;
}

/** Real retained rows: contiguous, genesis-chained, correctly hashed. */
const buildRows = (count: number): BuiltRow[] => {
  const rows: BuiltRow[] = [];
  let prev = genesis;
  for (let seq = 1; seq <= count; seq += 1) {
    const unsigned = {
      seq,
      ts: `2026-10-02T00:00:${String(seq).padStart(2, "0")}.000Z`,
      kind: "observe" as const,
      name: "test/source",
      prev_hash: prev,
      payload: { text: `retained row ${seq}` },
    };
    const hash = unsignedHash(unsigned);
    rows.push({ ...unsigned, hash } satisfies BuiltRow);
    prev = hash;
  }
  return rows;
};

/**
 * A self-consistent record read: head at `headSeq` of `rows`, an immutable
 * pin at `pinSeq`, and a page window (afterSeq, pinSeq].
 *
 * The double's session head lives far beyond the materialized rows (its
 * seqCounter starts above 200 and the poller keeps advancing it), so the
 * page's sessionCursor reports a large remote head: a live page pins THAT
 * head as its asOf, an explicit pin may sit below it, and only the rows of
 * the requested window need to exist here.
 */
const REMOTE_HEAD_SEQ = 9_000;

const recordRead = (input: {
  readonly rows: readonly BuiltRow[];
  /** Window end (records = rows in (afterSeq, windowEnd]). */
  readonly windowEnd: number;
  /** The immutable pin; a live page (no pin requested) pins the remote head. */
  readonly pinSeq?: number;
  readonly afterSeq?: number;
  readonly live?: boolean;
  readonly overrides?: Record<string, unknown>;
}): Record<string, unknown> => {
  const { rows } = input;
  const generation = rows[0]!.hash;
  const afterSeq = input.afterSeq ?? 0;
  const asOfSeq = input.live === true ? REMOTE_HEAD_SEQ : (input.pinSeq ?? input.windowEnd);
  const page = rows.filter((row) => row.seq > afterSeq && row.seq <= input.windowEnd);
  const last = page[page.length - 1];
  const hasMore = last !== undefined && last.seq < asOfSeq;
  const headHash = hex64(`session-${generation}-${REMOTE_HEAD_SEQ}`);
  return {
    version: 1,
    state: "available",
    sessionCursor: {
      sessionId: "live-fake01",
      seq: REMOTE_HEAD_SEQ,
      hash: headHash,
      generation,
    },
    gatewayCursor: { seq: 1, hash: hex64("gateway-1"), generation: hex64("gateway-generation") },
    asOf:
      input.live === true
        ? { sessionId: "live-fake01", seq: REMOTE_HEAD_SEQ, hash: headHash, generation }
        : {
            sessionId: "live-fake01",
            seq: asOfSeq,
            hash: rows[asOfSeq - 1]!.hash,
            generation,
          },
    records: page,
    next: hasMore && last !== undefined ? { seq: last.seq, hash: last.hash, generation } : null,
    total: asOfSeq,
    hasMore,
    decisions: {
      status: "unsupported",
      reason: "the kernel exposes no decision execution surface",
    },
    ...(input.overrides ?? {}),
  };
};

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
    readonly threadId?: string;
  } = {},
): Record<string, unknown> => ({
  binding: { clientId: CLIENT_ID, threadId: input.threadId ?? THREAD },
  sessionId: "live-fake01",
});

const errorText = (cause: Cause.Cause<unknown>): string => String(Cause.squash(cause));

describe("DokkabiAdapter.readWorkbenchRecord", () => {
  it.live("projects an exact page through the thread's own binding and pages it", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const rows = buildRows(3);
      // The session generation IS row 1's hash; the double must agree before
      // startSession's first read pins the live state's generation.
      gateway.sessionGeneration = rows[0]!.hash;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setRecordResult(recordRead({ rows, windowEnd: 2, live: true }));
      const result = yield* adapter.readWorkbenchRecord!(THREAD, { limit: 2 }, undefined);
      expect(result.status).toBe("available");
      expect(result.record?.state).toBe("available");
      if (result.record?.state === "available") {
        expect(result.record.records.map((row) => row.seq)).toEqual([1, 2]);
        expect(result.record.total).toBe(REMOTE_HEAD_SEQ);
        expect(result.record.hasMore).toBe(true);
        expect(result.record.next?.seq).toBe(2);
        expect(result.record.decisions.status).toBe("unsupported");
      }
      // The request went out under the thread's binding with paging only.
      const requests = gateway.requestsFor("workbench.record");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        version: 1,
        limit: 2,
        binding: { clientId: CLIENT_ID, threadId: THREAD },
      });
      // Page two continues exactly after the returned cursor, pinned to the
      // prefix the first page reported.
      gateway.setRecordResult(recordRead({ rows, windowEnd: 3, afterSeq: 2, pinSeq: 3 }));
      const second = yield* adapter.readWorkbenchRecord!(
        THREAD,
        {
          after: { seq: 2, hash: rows[1]!.hash, generation: rows[0]!.hash },
          asOf: {
            sessionId: "live-fake01",
            seq: 3,
            hash: rows[2]!.hash,
            generation: rows[0]!.hash,
          },
          limit: 2,
        },
        undefined,
      );
      expect(second.status).toBe("available");
      expect(second.record?.state).toBe("available");
      if (second.record?.state === "available") {
        expect(second.record.records.map((row) => row.seq)).toEqual([3]);
        expect(second.record.next).toBeNull();
        expect(second.record.hasMore).toBe(false);
      }
    }),
  );

  it.live("an immutable pin below the head stays valid after appends", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const rows = buildRows(5);
      gateway.sessionGeneration = rows[0]!.hash;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      // The source grew far beyond the pinned prefix; the pin stops at 3.
      gateway.setRecordResult(recordRead({ rows, windowEnd: 3, pinSeq: 3 }));
      const pin = {
        sessionId: "live-fake01",
        seq: 3,
        hash: rows[2]!.hash,
        generation: rows[0]!.hash,
      };
      const result = yield* adapter.readWorkbenchRecord!(THREAD, { asOf: pin }, undefined);
      expect(result.status).toBe("available");
      if (result.record?.state === "available") {
        expect(result.record.records.map((row) => row.seq)).toEqual([1, 2, 3]);
        expect(result.record.total).toBe(3);
        // The independent head reports the grown truth; the pin does not follow.
        expect(result.record.sessionCursor.seq).toBe(REMOTE_HEAD_SEQ);
      }
    }),
  );

  it.live("never advances transcript cursors or issues writer calls from a read", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const rows = buildRows(2);
      gateway.sessionGeneration = rows[0]!.hash;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      const before = (yield* adapter.listSessions())[0]!;
      gateway.setRecordResult(recordRead({ rows, windowEnd: 2, live: true }));
      yield* adapter.readWorkbenchRecord!(THREAD, {}, before.resumeCursor);
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
      const result = yield* adapter.readWorkbenchRecord!(THREAD, {}, undefined);
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
      gateway.binding = undefined;
      const result = yield* adapter.readWorkbenchRecord!(THREAD, {}, persistedState());
      expect(result.status).toBe("unavailable");
      expect(result.reason).toContain("not currently bound");
    }),
  );

  it.live("an older pre-R5 gateway reports unsupported without downgrading errors", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      gateway.supportRecord = false;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      const result = yield* adapter.readWorkbenchRecord!(THREAD, {}, undefined);
      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("does not implement workbench.record");
    }),
  );

  it.live("an honest unavailable body passes through as the record's own state", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      const result = yield* adapter.readWorkbenchRecord!(THREAD, {}, undefined);
      expect(result.status).toBe("available");
      expect(result.record?.state).toBe("unavailable");
      if (result.record?.state === "unavailable") {
        expect(result.record.records).toEqual([]);
        expect(result.record.reason).toContain("double");
      }
    }),
  );

  it.live("a foreign persisted thread identity fails closed", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup();
      const exit = yield* adapter.readWorkbenchRecord!(
        FOREIGN_THREAD,
        {},
        persistedState({ threadId: String(THREAD) }),
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(errorText(exit.cause)).toContain("belongs to thread");
      }
    }),
  );

  it.live("a forged row hash fails closed instead of rendering", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const rows = buildRows(2);
      const forgedRow = { ...rows[1]!, payload: { text: "tampered retained row" } };
      gateway.sessionGeneration = rows[0]!.hash;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setRecordResult(recordRead({ rows: [rows[0]!, forgedRow], windowEnd: 2, pinSeq: 2 }));
      const exit = yield* adapter.readWorkbenchRecord!(
        THREAD,
        {
          asOf: {
            sessionId: "live-fake01",
            seq: 2,
            hash: rows[1]!.hash,
            generation: rows[0]!.hash,
          },
        },
        undefined,
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(errorText(exit.cause)).toContain("does not carry its own canonical hash");
      }
    }),
  );

  it.live("a premature complete page fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const rows = buildRows(3);
      gateway.sessionGeneration = rows[0]!.hash;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setRecordResult(
        recordRead({
          rows,
          windowEnd: 2,
          pinSeq: 3,
          overrides: { next: null, hasMore: false },
        }),
      );
      const exit = yield* adapter.readWorkbenchRecord!(
        THREAD,
        {
          asOf: {
            sessionId: "live-fake01",
            seq: 3,
            hash: rows[2]!.hash,
            generation: rows[0]!.hash,
          },
        },
        undefined,
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(errorText(exit.cause)).toContain("must end at the pinned prefix");
      }
    }),
  );

  it.live("a live first page that pins an older prefix fails closed", () =>
    Effect.gen(function* () {
      const gateway = new FakeGateway();
      const rows = buildRows(3);
      gateway.sessionGeneration = rows[0]!.hash;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      gateway.setRecordResult(recordRead({ rows, windowEnd: 2, pinSeq: 2 }));
      const exit = yield* adapter.readWorkbenchRecord!(THREAD, {}, undefined).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(errorText(exit.cause)).toContain("must pin the current head");
      }
    }),
  );
});
