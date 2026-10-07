/**
 * Bounded retained-data explorer adapter tests: workbench.record.index,
 * workbench.record.body and workbench.graph.explore (v1).
 *
 * The raw codecs are closed and fail closed: unexpected fields, foreign or
 * swapped session/source/target identities, broken metadata chains, forged
 * byte ranges, inconsistent pagination and snapshot/request mismatches are
 * contract errors — never cached success, never a fallback. Only the
 * documented exact method-not-found error is an
 * explicit unsupported state. Reads issue no writer calls and never advance
 * the transcript resume cursors. Fixtures are built independently (see
 * ExplorerGateway.testFixtures.ts).
 *
 * @module provider/Layers/DokkabiAdapter.explorer.test
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeDokkabiAdapter, type DokkabiAdapterError } from "./DokkabiAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { FakeGateway, type FakeSocket } from "../dokkabi/WorkbenchGatewayDouble.testFixtures.ts";
import {
  EXPLORER_REMOTE_HEAD,
  bodyRange,
  bodyResponder,
  buildExplorerGraph,
  buildExplorerRows,
  descriptorOf,
  exploreResponder,
  graphDigest,
  headCursor,
  hex64,
  indexPage,
  pinAt,
  rowBytes,
  sha256,
  type ExplorerRow,
} from "../dokkabi/ExplorerGateway.testFixtures.ts";

const cryptoService = Crypto.make({
  randomBytes: (length: number) => new Uint8Array(NodeCrypto.randomBytes(length)),
  digest: (algorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) =>
    Effect.sync(
      () => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase()).update(data).digest()),
    ),
});

const THREAD = ThreadId.make("thread-explorer-1");
const INSTANCE_ID = ProviderInstanceId.make("dokkabi");
const CLIENT_ID = "app-test";
process.env.DOKKABI_TEST_TOKEN = "non-secret-test-fixture";

interface Bundle {
  readonly adapter: ProviderAdapterShape<DokkabiAdapterError>;
  readonly gateway: FakeGateway;
}

const setup = (gateway: FakeGateway): Effect.Effect<Bundle, DokkabiAdapterError, Scope.Scope> =>
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

const errorText = (cause: Cause.Cause<unknown>): string => String(Cause.squash(cause));

/** One 2.6 MB exact row (multi-byte Korean + astral emoji) and two small rows. */
const LARGE_TEXT = "가🙂".repeat(370_000);
const largeRows = (): ExplorerRow[] =>
  buildExplorerRows(3, (seq) => (seq === 1 ? { text: LARGE_TEXT } : { text: `row ${seq}` }));

const startedWith = (rows: readonly ExplorerRow[]) =>
  Effect.gen(function* () {
    const gateway = new FakeGateway();
    gateway.sessionGeneration = rows[0]!.hash;
    const bundle = yield* setup(gateway);
    yield* bundle.adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
    return bundle;
  });

const writerCalls = (gateway: FakeGateway): number =>
  gateway.requests.filter((request) =>
    ["workbench.bind", "workbench.submit", "workbench.cancel", "workbench.workMode"].includes(
      request.method,
    ),
  ).length;

describe("DokkabiAdapter.readWorkbenchRecordIndex", () => {
  it.live("pages metadata past a 2.6 MB row without carrying any payload bytes", () =>
    Effect.gen(function* () {
      const rows = largeRows();
      const { adapter, gateway } = yield* startedWith(rows);
      const pin = pinAt(rows, 3);
      gateway.explorer.index = (params) =>
        indexPage({
          rows,
          asOf: pin,
          afterSeq: (params.after as { seq: number } | undefined)?.seq ?? 0,
          limit: (params.limit as number | undefined) ?? 50,
        });
      const first = yield* adapter.readWorkbenchRecordIndex!(THREAD, { asOf: pin, limit: 1 });
      expect(first.status).toBe("available");
      const index = first.index!;
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]!.byteLength).toBeGreaterThan(2_590_000);
      expect(index.entries[0]!.bodyDigest).toBe(sha256(rowBytes(rows[0]!)));
      expect("payload" in index.entries[0]!).toBe(false);
      expect(index.hasMore).toBe(true);
      // The request carried only paging cursors under the thread's binding.
      expect(gateway.requestsFor("workbench.record.index")[0]).toEqual({
        version: 1,
        binding: { clientId: CLIENT_ID, threadId: THREAD },
        asOf: pin,
        limit: 1,
      });
      const second = yield* adapter.readWorkbenchRecordIndex!(THREAD, {
        after: index.next!,
        asOf: pin,
        limit: 1,
      });
      expect(second.index!.entries.map((entry) => entry.seq)).toEqual([2]);
    }),
  );

  it.live("a live first page pins the current head; an older explicit pin survives appends", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(4);
      const { adapter, gateway } = yield* startedWith(rows);
      // Explicit older pin: rows stop at 2 while the head reports 9000.
      gateway.explorer.index = () => indexPage({ rows, asOf: pinAt(rows, 2) });
      const pinned = yield* adapter.readWorkbenchRecordIndex!(THREAD, { asOf: pinAt(rows, 2) });
      expect(pinned.index!.total).toBe(2);
      expect(pinned.index!.sessionCursor.seq).toBe(EXPLORER_REMOTE_HEAD);
      // No pin requested: a gateway choosing an older prefix fails closed.
      const failure = yield* adapter.readWorkbenchRecordIndex!(THREAD, {}).pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure)) expect(errorText(failure.cause)).toContain("current head");
    }),
  );

  const forgedIndex: ReadonlyArray<
    readonly [string, (page: Record<string, unknown>, rows: ExplorerRow[]) => void, string]
  > = [
    ["an unexpected top-level field", (page) => (page.preview = "x"), "contract"],
    [
      "a payload smuggled into a descriptor",
      (page) => ((page.entries as Array<Record<string, unknown>>)[0]!.payload = {}),
      "contract",
    ],
    [
      "a foreign session",
      (page) =>
        (page.sessionCursor = { ...(page.sessionCursor as object), sessionId: "foreign01" }),
      "session",
    ],
    [
      "a broken prev_hash chain",
      (page) =>
        ((page.entries as Array<Record<string, unknown>>)[1]!.prev_hash = hex64("forged-prev")),
      "chain",
    ],
    ["a swapped asOf pin", (page, rows) => (page.asOf = pinAt(rows, 2)), "asof"],
    ["a dishonest total", (page) => (page.total = 7), "total"],
    [
      "a premature completion",
      (page) => {
        page.hasMore = false;
        page.next = null;
      },
      "complete",
    ],
    [
      "a row-1 hash that is not the generation",
      (page) =>
        ((page.entries as Array<Record<string, unknown>>)[0]!.hash = hex64("other-generation")),
      "generation",
    ],
  ];
  for (const [label, mutate, needle] of forgedIndex) {
    it.live(`fails closed on ${label}`, () =>
      Effect.gen(function* () {
        const rows = buildExplorerRows(4);
        const { adapter, gateway } = yield* startedWith(rows);
        const pin = pinAt(rows, 4);
        gateway.explorer.index = () => {
          const page = indexPage({ rows, asOf: pin, limit: 2 });
          mutate(page, rows);
          return page;
        };
        const exit = yield* adapter.readWorkbenchRecordIndex!(THREAD, { asOf: pin, limit: 2 }).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(errorText(exit.cause).toLowerCase()).toContain(needle);
      }),
    );
  }

  it.live("an older gateway is explicitly unsupported; a detached binding is unavailable", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.supportExplorer = false;
      const unsupported = yield* adapter.readWorkbenchRecordIndex!(THREAD, {});
      expect(unsupported.status).toBe("unsupported");
      expect(unsupported.reason).toContain("workbench.record.index");
      gateway.supportExplorer = true;
      gateway.explorer.index = () => indexPage({ rows, asOf: pinAt(rows, 2) });
      gateway.binding = undefined;
      const detached = yield* adapter.readWorkbenchRecordIndex!(THREAD, {});
      expect(detached.status).toBe("unavailable");
    }),
  );

  it.live("only code -32601 naming the exact requested method is unsupported", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(1);
      let failure = { code: -32603, message: "method not found: workbench.record.index" };
      const gateway = new (class extends FakeGateway {
        override dispatch(method: string, params: unknown, socket: FakeSocket, requestId: number) {
          if (method === "workbench.record.index") {
            socket.reply(requestId, { error: failure });
            return;
          }
          super.dispatch(method, params, socket, requestId);
        }
      })();
      gateway.sessionGeneration = rows[0]!.hash;
      const { adapter } = yield* setup(gateway);
      yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
      for (const error of [
        { code: -32603, message: "method not found: workbench.record.index" },
        { code: -32601, message: "method not found: workbench.record.body" },
        { code: -32601, message: "policy forbids method not found: workbench.record.index" },
      ]) {
        failure = error;
        const exit = yield* adapter.readWorkbenchRecordIndex!(THREAD, {}).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }
      failure = { code: -32601, message: "method not found: workbench.record.index" };
      expect((yield* adapter.readWorkbenchRecordIndex!(THREAD, {})).status).toBe("unsupported");
    }),
  );

  it.live("a malformed reply is never downgraded to unsupported", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.explorer.index = () => {
        throw new Error("record index source failed verification");
      };
      const exit = yield* adapter.readWorkbenchRecordIndex!(THREAD, {}).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("never advances transcript cursors or issues writer calls", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(3);
      const { adapter, gateway } = yield* startedWith(rows);
      const before = (yield* adapter.listSessions())[0]!;
      const writes = writerCalls(gateway);
      gateway.explorer.index = () => indexPage({ rows, asOf: pinAt(rows, 3) });
      gateway.explorer.body = bodyResponder(rows);
      yield* adapter.readWorkbenchRecordIndex!(
        THREAD,
        { asOf: pinAt(rows, 3) },
        before.resumeCursor,
      );
      yield* adapter.readWorkbenchRecordBody!(
        THREAD,
        {
          row: { seq: 2, hash: rows[1]!.hash, generation: rows[0]!.hash },
          asOf: pinAt(rows, 3),
          offset: 0,
        },
        before.resumeCursor,
      );
      const after = (yield* adapter.listSessions())[0]!;
      expect(after.resumeCursor).toEqual(before.resumeCursor);
      expect(writerCalls(gateway)).toBe(writes);
    }),
  );
});

describe("DokkabiAdapter.readWorkbenchRecordBody", () => {
  const rowCursor = (rows: readonly ExplorerRow[], seq: number) => ({
    seq,
    hash: rows[seq - 1]!.hash,
    generation: rows[0]!.hash,
  });

  it.live("serves exact bounded canonical byte ranges bound to the descriptor", () =>
    Effect.gen(function* () {
      const rows = largeRows();
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.explorer.body = bodyResponder(rows);
      const exact = rowBytes(rows[0]!);
      const descriptor = descriptorOf(rows[0]!);
      for (const offset of [0, 32_768, exact.length - 11]) {
        const result = yield* adapter.readWorkbenchRecordBody!(THREAD, {
          row: rowCursor(rows, 1),
          asOf: pinAt(rows, 3),
          offset,
          expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
        });
        expect(result.status).toBe("available");
        const body = result.body!;
        const bytes = Buffer.from(body.data, "base64");
        expect(bytes.equals(exact.subarray(offset, offset + 32_768))).toBe(true);
        expect(body.totalBytes).toBe(exact.length);
        expect(body.nextOffset).toBe(
          offset + bytes.length < exact.length ? offset + bytes.length : null,
        );
      }
    }),
  );

  const forgedBody: ReadonlyArray<
    readonly [string, (body: Record<string, unknown>, rows: ExplorerRow[]) => void, string]
  > = [
    ["an unexpected field", (body) => (body.path = "/etc/passwd"), "contract"],
    [
      "a chunk digest that does not match its bytes",
      (body) => (body.chunkDigest = hex64("forged")),
      "chunk",
    ],
    [
      "a swapped row cursor",
      (body, rows) => (body.row = { seq: 2, hash: rows[1]!.hash, generation: rows[0]!.hash }),
      "row",
    ],
    ["a different offset", (body) => (body.offset = 1), "offset"],
    [
      "more bytes than the requested limit",
      (body, rows) => {
        const bytes = rowBytes(rows[0]!).subarray(0, 65);
        body.data = bytes.toString("base64");
        body.chunkDigest = sha256(bytes);
        body.nextOffset = 65;
      },
      "limit",
    ],
    ["a dishonest nextOffset", (body) => (body.nextOffset = 7), "nextoffset"],
    [
      "a total that differs from the descriptor",
      (body) => (body.totalBytes = Number(body.totalBytes) + 1),
      "descriptor",
    ],
    [
      "a body digest that differs from the descriptor",
      (body) => (body.bodyDigest = hex64("other-body")),
      "descriptor",
    ],
    [
      "a foreign asOf pin",
      (body) => (body.asOf = { ...(body.asOf as object), sessionId: "foreign01" }),
      "session",
    ],
    [
      "base64 outside the closed alphabet",
      (body) => (body.data = `${String(body.data)}\n`),
      "contract",
    ],
    [
      "non-canonical base64 padding bits",
      (body) => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const data = String(body.data);
        const index = alphabet.indexOf(data[data.length - 3]!);
        body.data = `${data.slice(0, -3)}${alphabet[index | 1]}==`;
      },
      "base64",
    ],
  ];
  for (const [label, mutate, needle] of forgedBody) {
    it.live(`fails closed on ${label}`, () =>
      Effect.gen(function* () {
        const rows = buildExplorerRows(3, (seq) => ({ text: `exact row ${seq} `.repeat(40) }));
        const { adapter, gateway } = yield* startedWith(rows);
        gateway.explorer.body = bodyResponder(rows, (body) => mutate(body, rows));
        const descriptor = descriptorOf(rows[0]!);
        const exit = yield* adapter.readWorkbenchRecordBody!(THREAD, {
          row: rowCursor(rows, 1),
          asOf: pinAt(rows, 3),
          offset: 0,
          limit: 64,
          expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(errorText(exit.cause).toLowerCase()).toContain(needle);
      }),
    );
  }

  it.live(
    "a self-consistent tampered range is range integrity only; the full proof refuses it",
    () =>
      Effect.gen(function* () {
        // A range carries no full-row proof: bytes altered together with their
        // own chunk digest pass range browsing (the UI labels them partial),
        // and only the streamed verification can refuse them.
        const rows = buildExplorerRows(3, (seq) => ({ text: `exact row ${seq} `.repeat(40) }));
        const { adapter, gateway } = yield* startedWith(rows);
        // Absolute byte 200 lies inside the payload text of row 1.
        const TAMPERED = 200;
        expect(
          rowBytes(rows[0]!)
            .subarray(TAMPERED - 4, TAMPERED + 4)
            .toString("utf8"),
        ).toMatch(/^[a-z0-9 ]+$/);
        const tamper = (body: Record<string, unknown>) => {
          const offset = Number(body.offset);
          const bytes = Buffer.from(String(body.data), "base64");
          if (TAMPERED < offset || TAMPERED >= offset + bytes.length) return;
          bytes[TAMPERED - offset] = bytes[TAMPERED - offset]! ^ 1;
          body.data = bytes.toString("base64");
          body.chunkDigest = sha256(bytes);
        };
        gateway.explorer.body = bodyResponder(rows, tamper);
        const descriptor = descriptorOf(rows[0]!);
        const expected = { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest };
        const range = yield* adapter.readWorkbenchRecordBody!(THREAD, {
          row: rowCursor(rows, 1),
          asOf: pinAt(rows, 3),
          offset: 192,
          limit: 64,
          expected,
        });
        expect(range.status).toBe("available");
        const exit = yield* adapter.verifyWorkbenchRecordBody!(THREAD, {
          row: rowCursor(rows, 1),
          asOf: pinAt(rows, 3),
          expected,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(errorText(exit.cause)).toContain("body digest");
      }),
  );

  it.live("browses and fully verifies canonical rows whose hash member is not first", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(
        3,
        (seq) => ({
          hash: `nested-${seq}`,
          text: `{"hash":"${"c".repeat(64)}",} 가🙂`.repeat(900),
        }),
        (seq) => ({
          "0": seq,
          a: `가🙂 "hash":"${"e".repeat(64)}" \\ `.repeat(50),
          extra: { hash: "x" },
        }),
      );
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.explorer.body = bodyResponder(rows);
      const descriptor = descriptorOf(rows[1]!);
      expect(rowBytes(rows[1]!).subarray(0, 5).toString("utf8")).toBe('{"0":');
      const expected = { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest };
      const range = yield* adapter.readWorkbenchRecordBody!(THREAD, {
        row: rowCursor(rows, 2),
        asOf: pinAt(rows, 3),
        offset: 0,
        limit: 128,
        expected,
      });
      expect(range.status).toBe("available");
      const verified = yield* adapter.verifyWorkbenchRecordBody!(THREAD, {
        row: rowCursor(rows, 2),
        asOf: pinAt(rows, 3),
        expected,
      });
      expect(verified.verification?.verdict).toBe("exact");
      expect(verified.verification?.chunks).toBe(Math.ceil(descriptor.byteLength / 32_768));
    }),
  );

  it.live("refuses oversized requests before the wire", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.explorer.body = bodyResponder(rows);
      const exit = yield* adapter.readWorkbenchRecordBody!(THREAD, {
        row: rowCursor(rows, 1),
        asOf: pinAt(rows, 2),
        offset: 0,
        limit: 32_769,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(gateway.requestsFor("workbench.record.body")).toHaveLength(0);
    }),
  );
});

describe("DokkabiAdapter.verifyWorkbenchRecordBody", () => {
  it.live("streams every bounded range and proves digest plus canonical row hash", () =>
    Effect.gen(function* () {
      const rows = largeRows();
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.explorer.body = bodyResponder(rows);
      const descriptor = descriptorOf(rows[0]!);
      const result = yield* adapter.verifyWorkbenchRecordBody!(THREAD, {
        row: { seq: 1, hash: rows[0]!.hash, generation: rows[0]!.hash },
        asOf: pinAt(rows, 3),
        expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
      });
      expect(result.status).toBe("available");
      expect(result.verification).toMatchObject({
        verdict: "exact",
        totalBytes: descriptor.byteLength,
        bodyDigest: descriptor.bodyDigest,
        chunks: Math.ceil(descriptor.byteLength / 32_768),
      });
      // Every request is bounded and contiguous.
      const offsets = gateway
        .requestsFor("workbench.record.body")
        .map((params) => (params as { offset: number; limit: number }).offset);
      expect(offsets[0]).toBe(0);
      expect(offsets.every((offset, index) => offset === index * 32_768)).toBe(true);
    }),
  );

  it.live(
    "an interrupted verification sends no further ranges, no writes, and frees the slot",
    () =>
      Effect.gen(function* () {
        const rows = largeRows();
        let held: (() => void) | undefined;
        const gateway = new (class extends FakeGateway {
          override dispatch(
            method: string,
            params: unknown,
            socket: FakeSocket,
            requestId: number,
          ) {
            if (method === "workbench.record.body" && this.requestsFor(method).length === 2) {
              // The third range stays unanswered until after the interruption.
              this.requests.push({ method, params });
              held = () =>
                socket.reply(requestId, {
                  result: this.explorer.body!(params as Record<string, unknown>),
                });
              return;
            }
            super.dispatch(method, params, socket, requestId);
          }
        })();
        gateway.sessionGeneration = rows[0]!.hash;
        const { adapter } = yield* setup(gateway);
        yield* adapter.startSession({ threadId: THREAD, runtimeMode: "full-access" });
        gateway.explorer.body = bodyResponder(rows);
        gateway.explorer.index = () => indexPage({ rows, asOf: pinAt(rows, 3) });
        const descriptor = descriptorOf(rows[0]!);
        const writes = writerCalls(gateway);
        const fiber = yield* adapter.verifyWorkbenchRecordBody!(THREAD, {
          row: { seq: 1, hash: rows[0]!.hash, generation: rows[0]!.hash },
          asOf: pinAt(rows, 3),
          expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
        }).pipe(Effect.forkChild);
        for (let guard = 0; guard < 200 && held === undefined; guard += 1) {
          yield* Effect.sleep("5 millis");
        }
        expect(held).toBeDefined();
        const sentBefore = gateway.requestsFor("workbench.record.body").length;
        expect(sentBefore).toBe(3);
        yield* Fiber.interrupt(fiber);
        // The aborted read released its queue slot: the next disposable read
        // is answered while the held range is still outstanding.
        const index = yield* adapter.readWorkbenchRecordIndex!(THREAD, {
          asOf: pinAt(rows, 3),
        }).pipe(Effect.timeout("2 seconds"));
        expect(index.status).toBe("available");
        // The late reply is ignored; no range was re-sent or continued.
        held!();
        yield* Effect.sleep("30 millis");
        expect(gateway.requestsFor("workbench.record.body")).toHaveLength(sentBefore);
        expect(writerCalls(gateway)).toBe(writes);
        expect(gateway.requests.some((request) => request.method === "workbench.cancel")).toBe(
          false,
        );
      }),
  );

  const rewound: ReadonlyArray<
    readonly [string, (body: Record<string, unknown>, chunk: number) => void, string]
  > = [
    [
      "the gateway head",
      (body, chunk) =>
        (body.gatewayCursor = {
          ...(body.gatewayCursor as object),
          seq: chunk === 0 ? 50 : 40,
          hash: hex64(`gateway-${chunk}`),
        }),
      "gateway head rewound",
    ],
    [
      "the session head",
      (body, chunk) =>
        (body.sessionCursor = {
          ...(body.sessionCursor as object),
          seq: chunk === 0 ? 9_500 : 9_400,
          hash: hex64(`session-${chunk}`),
        }),
      "session head rewound",
    ],
  ];
  for (const [label, mutate, needle] of rewound) {
    it.live(`refuses ${label} rewinding between verification chunks`, () =>
      Effect.gen(function* () {
        const rows = largeRows();
        const { adapter, gateway } = yield* startedWith(rows);
        gateway.explorer.body = bodyResponder(rows, (body) =>
          mutate(body, Number(body.offset) === 0 ? 0 : 1),
        );
        const descriptor = descriptorOf(rows[0]!);
        const exit = yield* adapter.verifyWorkbenchRecordBody!(THREAD, {
          row: { seq: 1, hash: rows[0]!.hash, generation: rows[0]!.hash },
          asOf: pinAt(rows, 3),
          expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(errorText(exit.cause).toLowerCase()).toContain(needle);
        // It stopped at the first inconsistent chunk.
        expect(gateway.requestsFor("workbench.record.body")).toHaveLength(2);
      }),
    );
  }

  it.live("refuses a row beyond the streamed verification bound before the wire", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.explorer.body = bodyResponder(rows);
      const exit = yield* adapter.verifyWorkbenchRecordBody!(THREAD, {
        row: { seq: 1, hash: rows[0]!.hash, generation: rows[0]!.hash },
        asOf: pinAt(rows, 2),
        expected: { byteLength: 64 * 1_048_576 + 1, bodyDigest: hex64("huge") },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(gateway.requestsFor("workbench.record.body")).toHaveLength(0);
    }),
  );

  it.live("a same-digest gateway lying about the row hash cannot earn exact", () =>
    Effect.gen(function* () {
      // The gateway serves a DIFFERENT row's internally consistent bytes and
      // claims them for row 2: digest and chunks agree with each other, the
      // canonical row hash does not.
      const rows = buildExplorerRows(3);
      const { adapter, gateway } = yield* startedWith(rows);
      const imposter = rowBytes(rows[2]!);
      gateway.explorer.body = (params) => {
        const offset = params.offset as number;
        const data = imposter.subarray(offset, offset + 32_768);
        return {
          ...bodyRange({ rows, row: rows[1]!, asOf: pinAt(rows, 3), offset }),
          totalBytes: imposter.length,
          bodyDigest: sha256(imposter),
          chunkDigest: sha256(data),
          nextOffset: offset + data.length < imposter.length ? offset + data.length : null,
          data: data.toString("base64"),
        };
      };
      const exit = yield* adapter.verifyWorkbenchRecordBody!(THREAD, {
        row: { seq: 2, hash: rows[1]!.hash, generation: rows[0]!.hash },
        asOf: pinAt(rows, 3),
        expected: { byteLength: imposter.length, bodyDigest: sha256(imposter) },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(errorText(exit.cause).toLowerCase()).toContain("row");
    }),
  );
});

describe("DokkabiAdapter explorer child routing", () => {
  it.live(
    "a recorded child reads through the branchSession envelope; policy denial remains an error",
    () =>
      Effect.gen(function* () {
        const CHILD_ID = "child-explorer-0001";
        const CHILD_SESSION = "live-child01";
        const rows = buildExplorerRows(3);
        let routeChild = true;
        const gateway = new (class extends FakeGateway {
          override dispatch(
            method: string,
            params: unknown,
            socket: FakeSocket,
            requestId: number,
          ) {
            if (method === "workbench.branchSession") {
              this.requests.push({ method, params });
              const record = params as Record<string, unknown>;
              const inner = record.params as Record<string, unknown>;
              if (!routeChild) {
                socket.reply(requestId, {
                  error: {
                    code: -32603,
                    message: `workbench.branchSession forbids method ${JSON.stringify(record.method)}`,
                  },
                });
                return;
              }
              super.dispatch(String(record.method), inner, socket, requestId);
              return;
            }
            super.dispatch(method, params, socket, requestId);
          }
        })();
        gateway.sessionId = CHILD_SESSION;
        gateway.binding = { clientId: CLIENT_ID, threadId: String(THREAD) };
        const pin = pinAt(rows, 3, CHILD_SESSION);
        gateway.explorer.index = () => indexPage({ rows, asOf: pin });
        gateway.explorer.graph = exploreResponder({
          full: buildExplorerGraph(5),
          head: headCursor(rows, CHILD_SESSION),
        });
        const { adapter } = yield* setup(gateway);
        const persisted = {
          binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
          sessionId: CHILD_SESSION,
          child: {
            id: CHILD_ID,
            sessionId: CHILD_SESSION,
            workspacePath: "/tmp/dokkabi-fake-child",
            parent: { clientId: CLIENT_ID, threadId: "thread-explorer-parent" },
            binding: { clientId: CLIENT_ID, threadId: String(THREAD) },
          },
        };
        const index = yield* adapter.readWorkbenchRecordIndex!(THREAD, { asOf: pin }, persisted);
        expect(index.status).toBe("available");
        expect(index.index!.sessionCursor.sessionId).toBe(CHILD_SESSION);
        const envelope = gateway.requestsFor("workbench.branchSession")[0] as Record<
          string,
          unknown
        >;
        expect(envelope).toMatchObject({
          binding: { clientId: CLIENT_ID, threadId: "thread-explorer-parent" },
          childId: CHILD_ID,
          method: "workbench.record.index",
        });
        const graph = yield* adapter.exploreWorkbenchGraph!(
          THREAD,
          { graphType: "context", query: { mode: "page" } },
          persisted,
        );
        expect(graph.status).toBe("available");
        routeChild = false;
        const refused = yield* adapter.readWorkbenchRecordIndex!(
          THREAD,
          { asOf: pin },
          persisted,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(refused)).toBe(true);
        const refusedGraph = yield* adapter.exploreWorkbenchGraph!(
          THREAD,
          { graphType: "context", query: { mode: "page" } },
          persisted,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(refusedGraph)).toBe(true);
      }),
  );
});

describe("DokkabiAdapter.exploreWorkbenchGraph", () => {
  it.live("pages every node of a 541-node graph under one snapshot", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      const full = buildExplorerGraph(541);
      gateway.explorer.graph = exploreResponder({ full, head: headCursor(rows) });
      const seen = new Set<string>();
      let offset = 0;
      let snapshot: { sessionCursor: ReturnType<typeof headCursor>; digest: string } | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const result = yield* adapter.exploreWorkbenchGraph!(THREAD, {
          graphType: "context",
          query: { mode: "page", offset, limit: 100 },
          ...(snapshot !== undefined ? { snapshot } : {}),
        });
        expect(result.status).toBe("available");
        const explore = result.explore!;
        expect(explore.state).toBe("available");
        expect(explore.graph.nodes.length).toBeLessThanOrEqual(100);
        expect(explore.graph.coverage.totalNodes).toBe(541);
        expect(explore.matchedNodes).toBe(541);
        for (const node of explore.graph.nodes) {
          expect(seen.has(node.id)).toBe(false);
          seen.add(node.id);
        }
        snapshot = explore.snapshot;
        if (explore.nextOffset === null) break;
        offset = explore.nextOffset;
      }
      expect(seen.size).toBe(541);
      expect(snapshot?.digest).toBe(graphDigest(full));
      // The query traveled exactly, with the snapshot pin after the first page.
      const requests = gateway.requestsFor("workbench.graph.explore");
      expect(requests[1]).toMatchObject({
        version: 1,
        graphType: "context",
        query: { mode: "page", offset: 100, limit: 100 },
        snapshot: { digest: graphDigest(full) },
      });
    }),
  );

  it.live("literal search and one-hop neighbors stay bounded and anchored", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      const full = buildExplorerGraph(600);
      gateway.explorer.graph = exploreResponder({ full, head: headCursor(rows) });
      const search = yield* adapter.exploreWorkbenchGraph!(THREAD, {
        graphType: "context",
        query: { mode: "search", search: "explore-00599" },
      });
      expect(search.explore!.graph.nodes.map((node) => node.id)).toEqual(["action:explore-00599"]);
      expect(search.explore!.matchedNodes).toBe(1);
      const neighbors = yield* adapter.exploreWorkbenchGraph!(THREAD, {
        graphType: "context",
        query: { mode: "neighbors", nodeId: "action:explore-00300" },
      });
      expect(neighbors.explore!.graph.nodes.map((node) => node.id)).toEqual([
        "action:explore-00300",
        "action:explore-00299",
        "action:explore-00301",
      ]);
      expect(neighbors.explore!.graph.edges).toHaveLength(2);
    }),
  );

  it.live("neighbors pages repeat the anchor and advance by candidate neighbors", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      const full = buildExplorerGraph(600);
      // A hub: node 300 additionally relates to 20 further nodes.
      for (let index = 0; index < 20; index += 1) {
        full.edges.push({
          id: hex64(`hub-${index}`),
          from: full.nodes[index * 10]!.id,
          to: full.nodes[300]!.id,
          kind: "requested_by",
          artifact: null,
          sources: [{ seq: 1, hash: hex64("graph-source-1") }],
        });
      }
      gateway.explorer.graph = exploreResponder({ full, head: headCursor(rows) });
      const anchor = "action:explore-00300";
      const neighbors: string[] = [];
      let offset = 0;
      let snapshot: { sessionCursor: ReturnType<typeof headCursor>; digest: string } | undefined;
      const offsets: Array<number | null> = [];
      for (let guard = 0; guard < 20; guard += 1) {
        const result = yield* adapter.exploreWorkbenchGraph!(THREAD, {
          graphType: "context",
          query: { mode: "neighbors", nodeId: anchor, offset, limit: 5 },
          ...(snapshot !== undefined ? { snapshot } : {}),
        });
        const explore = result.explore!;
        expect(explore.graph.nodes[0]!.id).toBe(anchor);
        expect(explore.matchedNodes).toBe(23);
        neighbors.push(...explore.graph.nodes.slice(1).map((node) => node.id));
        snapshot = explore.snapshot;
        offsets.push(explore.nextOffset);
        if (explore.nextOffset === null) break;
        offset = explore.nextOffset;
      }
      expect(offsets).toEqual([4, 8, 12, 16, 20, null]);
      expect(new Set(neighbors).size).toBe(22);
      expect(neighbors).not.toContain(anchor);
      const missing = yield* adapter.exploreWorkbenchGraph!(THREAD, {
        graphType: "context",
        query: { mode: "neighbors", nodeId: "action:absent", limit: 2 },
      });
      expect(missing.explore!.graph.nodes).toEqual([]);
      expect(missing.explore!.nextOffset).toBeNull();
    }),
  );

  it.live("a truthful non-available projection is returned as such, not as a contract error", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.explorer.graph = exploreResponder({
        full: buildExplorerGraph(700),
        head: headCursor(rows),
        innerState: "unavailable",
      });
      const result = yield* adapter.exploreWorkbenchGraph!(THREAD, {
        graphType: "context",
        query: { mode: "page" },
      });
      expect(result.status).toBe("available");
      expect(result.explore!.state).toBe("available");
      expect(result.explore!.graph.state).toBe("unavailable");
      expect(result.explore!.graph.coverage.totalNodes).toBe(700);
      expect(result.explore!.counts).toEqual({ byKind: {}, byStatus: {} });
    }),
  );

  it.live("a snapshot mismatch is an explicit stale state with no mixed nodes", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      const full = buildExplorerGraph(150);
      gateway.explorer.graph = exploreResponder({ full, head: headCursor(rows) });
      const result = yield* adapter.exploreWorkbenchGraph!(THREAD, {
        graphType: "context",
        query: { mode: "page", offset: 100 },
        snapshot: { sessionCursor: headCursor(rows), digest: hex64("older-projection") },
      });
      expect(result.status).toBe("available");
      expect(result.explore!.state).toBe("stale");
      expect(result.explore!.graph.nodes).toEqual([]);
      expect(result.explore!.snapshot.digest).toBe(graphDigest(full));
    }),
  );

  const forgedGraph: ReadonlyArray<
    readonly [string, (result: Record<string, unknown>) => void, string]
  > = [
    ["an unexpected field", (result) => (result.cursor = 1), "contract"],
    [
      "more than 100 nodes",
      (result) => {
        const graph = result.graph as { nodes: unknown[]; coverage: { omittedNodes: number } };
        const extra = buildExplorerGraph(101).nodes.map((node) => ({
          ...node,
          id: `${node.id}-x`,
        }));
        graph.nodes = extra;
        graph.coverage.omittedNodes = 541 - 101;
      },
      "contract",
    ],
    [
      "an edge to a node that is not displayed",
      (result) => {
        const graph = result.graph as { edges: Array<Record<string, unknown>> };
        graph.edges[0] = { ...graph.edges[0]!, to: "action:explore-00999" };
      },
      "endpoint",
    ],
    [
      "a citation beyond the returned head",
      (result) => {
        const graph = result.graph as { nodes: Array<Record<string, unknown>> };
        graph.nodes[1] = { ...graph.nodes[1]!, sources: [{ seq: 9_999, hash: hex64("x") }] };
      },
      "source",
    ],
    [
      "a different query than requested",
      (result) => (result.query = { mode: "page", offset: 0, limit: 50 }),
      "query",
    ],
    [
      "an available answer to a mismatched snapshot pin",
      (result) =>
        (result.snapshot = {
          sessionCursor: result.sessionCursor,
          digest: hex64("another-projection"),
        }),
      "snapshot",
    ],
    ["a dishonest nextOffset", (result) => (result.nextOffset = 7), "nextoffset"],
    [
      "omitted counts that hide truncation",
      (result) =>
        ((result.graph as { coverage: { omittedNodes: number } }).coverage.omittedNodes = 0),
      "coverage",
    ],
    [
      "an invented count status",
      (result) => ((result.counts as { byStatus: Record<string, number> }).byStatus.done = 3),
      "count",
    ],
    [
      "counts that do not sum to the recorded total",
      (result) => ((result.counts as { byKind: Record<string, number> }).byKind.action = 1),
      "count",
    ],
    [
      "a foreign session",
      (result) =>
        (result.sessionCursor = { ...(result.sessionCursor as object), sessionId: "foreign01" }),
      "session",
    ],
    ["the other graph type", (result) => (result.graphType = "work"), "graph"],
  ];
  for (const [label, mutate, needle] of forgedGraph) {
    it.live(`fails closed on ${label}`, () =>
      Effect.gen(function* () {
        const rows = buildExplorerRows(2);
        const { adapter, gateway } = yield* startedWith(rows);
        const full = buildExplorerGraph(541);
        const digest = graphDigest(full);
        gateway.explorer.graph = exploreResponder({
          full,
          head: headCursor(rows),
          mutate: (result) => mutate(result),
        });
        const exit = yield* adapter.exploreWorkbenchGraph!(THREAD, {
          graphType: "context",
          query: { mode: "page", offset: 100, limit: 100 },
          snapshot: { sessionCursor: headCursor(rows), digest },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(errorText(exit.cause).toLowerCase()).toContain(needle);
      }),
    );
  }

  it.live("an older gateway is explicitly unsupported and the v1 graph read is unchanged", () =>
    Effect.gen(function* () {
      const rows = buildExplorerRows(2);
      const { adapter, gateway } = yield* startedWith(rows);
      gateway.supportExplorer = false;
      const result = yield* adapter.exploreWorkbenchGraph!(THREAD, {
        graphType: "work",
        query: { mode: "page" },
      });
      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("workbench.graph.explore");
      const v1 = yield* adapter.readWorkbenchGraph!(THREAD, "work", undefined);
      expect(v1.status).toBe("available");
    }),
  );
});
