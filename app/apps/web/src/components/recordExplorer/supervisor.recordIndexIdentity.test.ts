import { describe, expect, it } from "vite-plus/test";
import { makeFakeExplorerSource } from "./explorerFake.testFixtures";
import { recordIndexIntegrityError, resolveRecordExplorerIndex } from "./recordExplorer.logic";
const source = makeFakeExplorerSource({ rows: 60, largeRowSeq: 0 });
const index = source.index({ limit: 50 }).index!;
const cursor = { seq: 50, hash: source.rows[49]!.descriptor.hash, generation: source.generation };
const later = source.index({ after: cursor, asOf: source.head(), limit: 50 }).index!;
describe("supervisor index source identity", () => {
  it("does not display an unvalidated fresh payload through the stale-error branch", () => {
    const forged = { ...index, sessionCursor: { ...index.sessionCursor, hash: "f".repeat(64) } };
    const result = resolveRecordExplorerIndex({
      scopeKey: "source",
      query: {
        data: { status: "available", index: forged },
        error: "Revalidating",
        isPending: false,
      },
      retained: null,
      subscribed: true,
      limit: 50,
    });
    expect(result.kind).toBe("unavailable");
  });

  it("accepts the exact metadata page", () =>
    expect(recordIndexIntegrityError({ index, limit: 50 })).toBeNull());
  it("rejects a same-sequence head carrying another hash", () => {
    expect(
      recordIndexIntegrityError({
        index: { ...index, sessionCursor: { ...index.sessionCursor, hash: "f".repeat(64) } },
        limit: 50,
      }),
    ).not.toBeNull();
  });
  it("rejects an after cursor from another generation even with matching row seq/hash", () => {
    expect(
      recordIndexIntegrityError({
        index: later,
        after: { ...cursor, generation: "e".repeat(64) },
        limit: 50,
      }),
    ).not.toBeNull();
  });
  it("rejects a next cursor from another generation", () => {
    expect(
      recordIndexIntegrityError({
        index: { ...index, next: { ...index.next!, generation: "e".repeat(64) } },
        limit: 50,
      }),
    ).not.toBeNull();
  });
  it("rejects a first-row predecessor other than genesis", () => {
    expect(
      recordIndexIntegrityError({
        index: {
          ...index,
          entries: [{ ...index.entries[0]!, prev_hash: "f".repeat(64) }, ...index.entries.slice(1)],
        },
        limit: 50,
      }),
    ).not.toBeNull();
  });
  it("rejects a sequence-one gateway cursor whose hash is not its generation", () => {
    expect(
      recordIndexIntegrityError({
        index: {
          ...index,
          gatewayCursor: { seq: 1, hash: "f".repeat(64), generation: "e".repeat(64) },
        },
        limit: 50,
      }),
    ).not.toBeNull();
  });
});
