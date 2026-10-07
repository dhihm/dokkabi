import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderWorkbenchRecordBody } from "@t3tools/contracts";
import {
  planRecordBodyWindow,
  resolveRecordBodyWindowRead,
  type RecordBodyWindowRequest,
} from "./recordBodyWindow";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const encoder = new TextEncoder();
const unsigned = (seq: number, prev_hash: string, text: string) => ({
  kind: "observe" as const,
  name: "supervisor/identity-boundary",
  payload: { text },
  prev_hash,
  seq,
  ts: "2026-10-06T00:00:00.000Z",
});
const first = unsigned(1, "0".repeat(64), "first");
const generation = hash(JSON.stringify(first));
const second = unsigned(2, generation, "x".repeat(100_000));
const secondHash = hash(JSON.stringify(second));
const bytes = encoder.encode(JSON.stringify({ hash: secondHash, ...second }));

function fixture(): { request: RecordBodyWindowRequest; body: ProviderWorkbenchRecordBody } {
  const asOf = { sessionId: "supervisor-bounded-source", seq: 2, hash: secondHash, generation };
  const row = { seq: 2, hash: secondHash, generation };
  const request = {
    row,
    asOf,
    expected: { byteLength: bytes.length, bodyDigest: hash(bytes) },
    start: 0,
  };
  const plan = planRecordBodyWindow(0, bytes.length);
  const chunk = bytes.subarray(plan.fetchOffset, plan.fetchOffset + plan.fetchLimit);
  return {
    request,
    body: {
      version: 1,
      state: "available",
      sessionCursor: asOf,
      gatewayCursor: { seq: 0, hash: "0".repeat(64), generation: "0".repeat(64) },
      asOf,
      row,
      offset: plan.fetchOffset,
      nextOffset: plan.fetchOffset + chunk.length,
      totalBytes: bytes.length,
      bodyDigest: request.expected.bodyDigest,
      chunkDigest: hash(chunk),
      data: Buffer.from(chunk).toString("base64"),
    },
  };
}

describe("supervisor independent bounded-body wire defenses", () => {
  it("rejects a sequence-one gateway cursor whose hash differs from generation", () => {
    const { request, body } = fixture();
    expect(() =>
      resolveRecordBodyWindowRead(request, {
        status: "available",
        body: {
          ...body,
          gatewayCursor: { seq: 1, hash: "f".repeat(64), generation: "e".repeat(64) },
        },
      }),
    ).toThrow();
  });
  it("accepts the exact requested canonical byte range", () => {
    const { request, body } = fixture();
    expect(resolveRecordBodyWindowRead(request, { status: "available", body }).status).toBe(
      "available",
    );
  });

  it("rejects a short nonfinal range even with self-consistent digest and nextOffset", () => {
    const { request, body } = fixture();
    const short = Buffer.from(body.data, "base64").subarray(0, 1_024);
    expect(() =>
      resolveRecordBodyWindowRead(request, {
        status: "available",
        body: {
          ...body,
          data: short.toString("base64"),
          chunkDigest: hash(short),
          nextOffset: short.length,
        },
      }),
    ).toThrow();
  });

  it("rejects whitespace accepted by atob in a noncanonical base64 wire value", () => {
    const { request, body } = fixture();
    expect(() =>
      resolveRecordBodyWindowRead(request, {
        status: "available",
        body: { ...body, data: `${body.data.slice(0, 4)}\n${body.data.slice(4)}` },
      }),
    ).toThrow();
  });

  it("rejects missing base64 padding even when atob decodes identical bytes", () => {
    const { request, body } = fixture();
    expect(body.data.endsWith("=")).toBe(true);
    expect(() =>
      resolveRecordBodyWindowRead(request, {
        status: "available",
        body: { ...body, data: body.data.replace(/=+$/, "") },
      }),
    ).toThrow();
  });

  it("rejects a same-sequence source head hash that disagrees with the pin", () => {
    const { request, body } = fixture();
    expect(() =>
      resolveRecordBodyWindowRead(request, {
        status: "available",
        body: { ...body, sessionCursor: { ...body.sessionCursor, hash: "f".repeat(64) } },
      }),
    ).toThrow();
  });

  it("rejects a row generation different from its pinned source even when echoed", () => {
    const { request, body } = fixture();
    const foreign = { ...request.row, generation: "e".repeat(64) };
    expect(() =>
      resolveRecordBodyWindowRead(
        { ...request, row: foreign },
        {
          status: "available",
          body: { ...body, row: foreign },
        },
      ),
    ).toThrow();
  });

  it("rejects a first-row hash different from the source generation even when echoed", () => {
    const { request, body } = fixture();
    const forged = { seq: 1, hash: "f".repeat(64), generation };
    expect(() =>
      resolveRecordBodyWindowRead(
        { ...request, row: forged },
        {
          status: "available",
          body: { ...body, row: forged },
        },
      ),
    ).toThrow();
  });
});
