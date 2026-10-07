import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { verifyRecordRead } from "./RecordChain.ts";
import type { RecordResponse } from "./WorkbenchProtocol.ts";

const genesis = "0".repeat(64);
// Hand-ordered canonical keys independent of the verifier's implementation.
function row(seq: number, prev_hash: string, text: string) {
  const unsigned = {
    kind: "observe" as const,
    name: "test/source",
    payload: { text },
    prev_hash,
    seq,
    ts: "2026-10-02T00:00:00.000Z",
  };
  return {
    ...unsigned,
    hash: NodeCrypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
}
const first = row(1, genesis, "retained source"),
  second = row(2, first.hash, "later source");
const cursor = { sessionId: "owned-session", seq: 2, hash: second.hash, generation: first.hash };
function page(): RecordResponse {
  return {
    version: 1,
    state: "available",
    sessionCursor: cursor,
    gatewayCursor: { seq: 0, hash: genesis, generation: genesis },
    asOf: cursor,
    records: [first],
    next: { seq: 1, hash: first.hash, generation: first.hash },
    total: 2,
    hasMore: true,
    decisions: { status: "unsupported", reason: "no checkpoint authority" },
  };
}

describe("R5 independent source completeness and identity", () => {
  it("accepts an independently signed exact page", () => {
    expect(verifyRecordRead({ read: page() })).toBeNull();
  });
  it("refuses a premature complete page while retained rows remain", () => {
    const read = { ...page(), hasMore: false, next: null };
    expect(verifyRecordRead({ read })).not.toBeNull();
  });
  it("refuses empty success from a nonempty retained source", () => {
    const read = { ...page(), records: [], hasMore: false, next: null };
    expect(verifyRecordRead({ read })).not.toBeNull();
  });
  it("refuses an internally hashed first row from another source generation", () => {
    const foreign = row(1, genesis, "fabricated replacement source");
    const read = {
      ...page(),
      records: [foreign],
      next: { seq: 1, hash: foreign.hash, generation: first.hash },
    };
    expect(verifyRecordRead({ read })).not.toBeNull();
  });
  it("a live first page cannot silently choose an earlier prefix", () => {
    const asOf = { ...cursor, seq: 1, hash: first.hash };
    const read = { ...page(), asOf, total: 1, next: null, hasMore: false };
    expect(verifyRecordRead({ read })).not.toBeNull();
    expect(verifyRecordRead({ read, asOf })).toBeNull();
  });
  it("a requested pin generation must be answered exactly", () => {
    expect(
      verifyRecordRead({ read: page(), asOf: { ...cursor, generation: "f".repeat(64) } }),
    ).not.toBeNull();
  });
});
