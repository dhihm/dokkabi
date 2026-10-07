/**
 * R5 closed wire-contract tests for workbench.record
 * (docs/internals/dokkabi-records-r5.md): the additive read-only record
 * params and the discriminated result body. Unknown, excess and malformed
 * inputs must fail loudly; the unavailable body keeps the closed page shape
 * (empty rows, no next cursor, hasMore false) and never carries clipped
 * data; the decisions capability stays the fixed unsupported fact.
 *
 * @module provider/dokkabi/WorkbenchProtocol.record.test
 */
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  RecordParams,
  RecordResponse,
  STRICT_DECODE_OPTIONS,
  workbenchParamsSchemas,
} from "./WorkbenchProtocol.ts";

const decodeSync = <S extends Schema.Codec<any, any>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, STRICT_DECODE_OPTIONS)(value);

const hex64 = (seed: string): string => {
  const base = Array.from({ length: 8 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16),
  ).join("");
  return base.repeat(8);
};

const genesis = "0".repeat(64);
const binding = { clientId: "app-client", threadId: "thread-record-1" };

const availablePage = (): Record<string, unknown> => ({
  version: 1,
  state: "available",
  sessionCursor: {
    sessionId: "live-fake01",
    seq: 2,
    hash: hex64("head-2"),
    generation: hex64("gen"),
  },
  gatewayCursor: { seq: 1, hash: hex64("gateway-1"), generation: hex64("gateway-gen") },
  asOf: { sessionId: "live-fake01", seq: 2, hash: hex64("head-2"), generation: hex64("gen") },
  records: [
    {
      seq: 1,
      ts: "2026-10-02T00:00:00.000Z",
      kind: "observe",
      name: "test/source",
      prev_hash: genesis,
      hash: hex64("row-1"),
      payload: { text: "inert retained text" },
    },
    {
      seq: 2,
      ts: "2026-10-02T00:00:01.000Z",
      kind: "observe",
      name: "test/source",
      prev_hash: hex64("row-1"),
      hash: hex64("head-2"),
      payload: { text: "later retained text" },
    },
  ],
  next: null,
  total: 2,
  hasMore: false,
  decisions: { status: "unsupported", reason: "no decision execution surface" },
});

const unavailablePage = (): Record<string, unknown> => ({
  version: 1,
  state: "unavailable",
  reason: "a retained row exceeds the byte bound",
  sessionCursor: {
    sessionId: "live-fake01",
    seq: 4,
    hash: hex64("head-4"),
    generation: hex64("gen"),
  },
  gatewayCursor: { seq: 1, hash: hex64("gateway-1"), generation: hex64("gateway-gen") },
  asOf: { sessionId: "live-fake01", seq: 4, hash: hex64("head-4"), generation: hex64("gen") },
  records: [],
  next: null,
  total: 4,
  hasMore: false,
  decisions: { status: "unsupported", reason: "no decision execution surface" },
});

describe("workbench.record params", () => {
  it("accepts the closed paging shape with optional cursors and limit", () => {
    const decoded = decodeSync(RecordParams, {
      version: 1,
      binding,
      after: { seq: 2, hash: hex64("head-2"), generation: hex64("gen") },
      asOf: { sessionId: "live-fake01", seq: 4, hash: hex64("head-4"), generation: hex64("gen") },
      limit: 25,
    });
    expect(decoded.limit).toBe(25);
    expect(decoded.after?.seq).toBe(2);
    expect(decodeSync(RecordParams, { version: 1, binding })).toBeTruthy();
  });

  it("rejects unknown fields, wrong versions and unsafe limits", () => {
    expect(() => decodeSync(RecordParams, { version: 1, binding, sessionId: "chosen" })).toThrow();
    expect(() => decodeSync(RecordParams, { version: 2, binding })).toThrow();
    expect(() => decodeSync(RecordParams, { version: 1, binding, limit: 0 })).toThrow();
    expect(() => decodeSync(RecordParams, { version: 1, binding, limit: 101 })).toThrow();
    expect(() => decodeSync(RecordParams, { version: 1, binding, limit: 1.5 })).toThrow();
    expect(() => decodeSync(RecordParams, { version: 1, binding, after: "genesis" })).toThrow();
    expect(() =>
      decodeSync(RecordParams, {
        version: 1,
        binding,
        asOf: { sessionId: "s", seq: 1, hash: "not-hex", generation: hex64("gen") },
      }),
    ).toThrow();
  });

  it("is registered in the outbound params schema map", () => {
    expect(workbenchParamsSchemas["workbench.record"]).toBe(RecordParams);
  });
});

describe("workbench.record result", () => {
  it("decodes an available page of exact retained rows", () => {
    const decoded = decodeSync(RecordResponse, availablePage());
    expect(decoded.state).toBe("available");
    if (decoded.state === "available") {
      expect(decoded.records).toHaveLength(2);
      expect(decoded.records[1]?.hash).toBe(hex64("head-2"));
      expect(decoded.total).toBe(2);
      expect(decoded.hasMore).toBe(false);
      expect(decoded.decisions.status).toBe("unsupported");
    }
  });

  it("decodes the honest unavailable body with its empty page shape", () => {
    const decoded = decodeSync(RecordResponse, unavailablePage());
    expect(decoded.state).toBe("unavailable");
    if (decoded.state === "unavailable") {
      expect(decoded.reason).toContain("byte bound");
      expect(decoded.records).toEqual([]);
      expect(decoded.next).toBeNull();
      expect(decoded.hasMore).toBe(false);
    }
  });

  it("rejects contract drift: unknown fields, missing page fields, wrong decisions", () => {
    expect(() => decodeSync(RecordResponse, { ...availablePage(), extra: 1 })).toThrow();
    const { records: _records, ...withoutRecords } = availablePage();
    expect(() => decodeSync(RecordResponse, withoutRecords)).toThrow();
    expect(() =>
      decodeSync(RecordResponse, {
        ...availablePage(),
        decisions: { status: "supported", reason: "invented authority" },
      }),
    ).toThrow();
    expect(() =>
      decodeSync(RecordResponse, { ...availablePage(), records: [{ seq: 1, kind: "observe" }] }),
    ).toThrow();
    // The unavailable body may not smuggle rows past the closed shape.
    expect(() =>
      decodeSync(RecordResponse, {
        ...unavailablePage(),
        records: availablePage().records,
      }),
    ).toThrow();
  });
});
