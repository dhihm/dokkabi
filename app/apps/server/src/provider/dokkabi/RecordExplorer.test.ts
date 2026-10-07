/**
 * RecordExplorer range and streamed full-row verification against canonical
 * rows whose top-level `hash` member is NOT first. EventLog accepts further
 * top-level keys on load and hashes `{...unsigned}`; integer-like keys and
 * keys such as `a`/`extra` sort before `hash` in the canonical encoding.
 * Range browsing must not assume a hash-first prefix, and the streamed
 * verifier must remove exactly the top-level hash member (plus its
 * separator) while every other byte — nested `hash` keys and strings
 * included — stays in the unsigned digest. Fixtures are built independently
 * of the verifier (ExplorerGateway.testFixtures.ts).
 *
 * @module provider/dokkabi/RecordExplorer.test
 */
import { describe, expect, it } from "vite-plus/test";

import {
  RecordBodyStreamVerifier,
  verifyRecordBodyRange,
  verifyRecordIndexRead,
} from "./RecordExplorer.ts";
import {
  bodyRange,
  buildExplorerRows,
  canonicalText,
  descriptorOf,
  indexPage,
  pinAt,
  rowBytes,
  sha256,
  type ExplorerRow,
} from "./ExplorerGateway.testFixtures.ts";
import type { RecordBodyResponse, RecordIndexResponse } from "./WorkbenchProtocol.ts";

/** Top-level members that sort before `hash`, plus nested hash look-alikes. */
const extrasBeforeHash = (seq: number): Record<string, unknown> => ({
  "0": seq,
  "7": { hash: "f".repeat(64), note: '"hash":"' },
  a: `가🙂 "quoted" \\ back\\slash \u0001 "hash":"${"e".repeat(64)}",`,
  extra: [{ hash: "d".repeat(64) }, "}{", '\\"'],
});
const nestedPayload = (seq: number): Record<string, unknown> => ({
  hash: `nested-${seq}`,
  text: `{"hash":"${"c".repeat(64)}",} 가🙂`,
  deeper: { hash: { hash: "x" }, list: ["hash", { '"hash"': 1 }] },
});

const extraRows = (): ExplorerRow[] => buildExplorerRows(3, nestedPayload, extrasBeforeHash);

const unsignedDigest = (row: ExplorerRow): string => {
  const { hash: _hash, ...unsigned } = row;
  return sha256(canonicalText(unsigned));
};

const expectedOf = (bytes: Buffer) => ({ byteLength: bytes.length, bodyDigest: sha256(bytes) });

/** Feed `bytes` to a fresh verifier split at the given cut points. */
const streamWith = (
  rowHash: string,
  bytes: Buffer,
  cuts: readonly number[],
  expected = expectedOf(bytes),
): string | null => {
  const verifier = new RecordBodyStreamVerifier(rowHash, expected);
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    if (cut <= start) continue;
    const refusal = verifier.update(start, bytes.subarray(start, cut));
    if (refusal !== null) return refusal;
    start = cut;
  }
  return verifier.finish();
};

describe("canonical rows whose hash member is not first", () => {
  it("fixture rows really place other top-level members before hash", () => {
    const rows = extraRows();
    for (const row of rows) {
      const text = canonicalText(row);
      expect(text.startsWith('{"0":')).toBe(true);
      // Nested look-alikes appear earlier; the top-level member follows `extra`.
      expect(text.indexOf('"hash":"')).toBeLessThan(text.indexOf('"extra":'));
      expect(text.indexOf(`"hash":"${row.hash}"`)).toBeGreaterThan(text.indexOf('"extra":'));
      // EventLog's own hash: the canonical row without its top-level hash.
      expect(unsignedDigest(row)).toBe(row.hash);
    }
  });

  it("range browsing accepts the first range without a hash-first prefix", () => {
    const rows = extraRows();
    for (const [index, row] of rows.entries()) {
      const asOf = pinAt(rows, 3);
      const read = bodyRange({ rows, row, asOf, offset: 0, limit: 64 }) as RecordBodyResponse;
      const verdict = verifyRecordBodyRange({
        read,
        row: { seq: row.seq, hash: row.hash, generation: rows[0]!.hash },
        asOf,
        offset: 0,
        limit: 64,
        expected: expectedOf(rowBytes(row)),
      });
      expect(verdict, `row ${index + 1}`).toMatchObject({ ok: true });
    }
  });

  it("the index accepts descriptors of such rows", () => {
    const rows = extraRows();
    const read = indexPage({ rows, asOf: pinAt(rows, 3) }) as RecordIndexResponse;
    expect(verifyRecordIndexRead({ read, asOf: pinAt(rows, 3) })).toBeNull();
  });

  it("flagged display excerpts may use any positive width up to the bound", () => {
    const rows = buildExplorerRows(2, () => ({ text: "x".repeat(10000) }));
    const page = indexPage({ rows, asOf: pinAt(rows, 2) }) as RecordIndexResponse;
    for (const width of [1, 23, 1023, 1024]) {
      const read = {
        ...page,
        entries: page.entries.map((entry) => ({
          ...entry,
          name: "x".repeat(width),
          nameTruncated: true as const,
          ts: "y".repeat(width),
          tsTruncated: true as const,
        })),
      };
      expect(verifyRecordIndexRead({ read, asOf: pinAt(rows, 2) })).toBeNull();
    }
  });

  it("streamed verification earns exact for whole, 32 KiB and single-chunk streams", () => {
    for (const row of extraRows()) {
      const bytes = rowBytes(row);
      expect(streamWith(row.hash, bytes, [])).toBeNull();
    }
    const [large] = buildExplorerRows(
      1,
      () => ({ text: '가🙂\\"'.repeat(40_000), hash: "inner" }),
      () => ({ a: "가".repeat(30_000), "1": [1, 2, 3] }),
    );
    const bytes = rowBytes(large!);
    const cuts: number[] = [];
    for (let at = 32_768; at < bytes.length; at += 32_768) cuts.push(at);
    expect(streamWith(large!.hash, bytes, cuts)).toBeNull();
  });

  it("streamed verification is exact for every split around keys, escapes and the hash member", () => {
    const row = extraRows()[1]!;
    const bytes = rowBytes(row);
    const text = bytes.toString("latin1");
    const hashAt = text.indexOf('"hash":"');
    const kindAt = text.indexOf('"kind":');
    expect(hashAt).toBeGreaterThan(0);
    // Every single cut from the first byte to past the hash member's comma.
    for (let cut = 1; cut <= kindAt + 2; cut += 1) {
      expect(streamWith(row.hash, bytes, [cut]), `cut ${cut}`).toBeNull();
    }
    // Byte-by-byte through the whole prefix (escapes, multibyte, nested keys).
    const singles = Array.from({ length: kindAt + 4 }, (_, index) => index + 1);
    expect(streamWith(row.hash, bytes, singles)).toBeNull();
    // Odd-sized chunks across the whole row.
    for (const size of [2, 3, 5, 7, 13, 75, 76]) {
      const cuts: number[] = [];
      for (let at = size; at < bytes.length; at += size) cuts.push(at);
      expect(streamWith(row.hash, bytes, cuts), `size ${size}`).toBeNull();
    }
  });

  it("a hash-first row (no earlier members) still verifies", () => {
    const row = buildExplorerRows(2)[1]!;
    const bytes = rowBytes(row);
    expect(bytes.subarray(0, 9).toString("utf8")).toBe('{"hash":"');
    expect(streamWith(row.hash, bytes, [1, 9, 74, 75, 76])).toBeNull();
  });
});

describe("streamed verification refuses forgeries", () => {
  const row = (): ExplorerRow => extraRows()[2]!;

  it("refuses a self-consistent body whose hash member names another row", () => {
    const original = row();
    const other = extraRows()[1]!;
    // Bytes whose top-level hash member is another row's hash; descriptor
    // digest and length are recomputed so only the event hash can tell.
    const forged = Buffer.from(canonicalText({ ...original, hash: other.hash }), "utf8");
    expect(streamWith(original.hash, forged, [40, 300])).not.toBeNull();
  });

  it("refuses a payload changed under an unchanged hash member (forged event hash)", () => {
    const original = row();
    const tampered = Buffer.from(
      canonicalText({ ...original, payload: { ...original.payload, text: "changed" } }),
      "utf8",
    );
    const refusal = streamWith(original.hash, tampered, [17]);
    expect(refusal).toContain("event hash");
  });

  it("refuses a changed member BEFORE the hash member", () => {
    const original = row();
    const tampered = Buffer.from(canonicalText({ ...original, a: "changed" }), "utf8");
    expect(streamWith(original.hash, tampered, [3])).toContain("event hash");
  });

  it("refuses bytes that disagree with the independent descriptor digest", () => {
    const original = row();
    const bytes = rowBytes(original);
    const refusal = streamWith(original.hash, bytes, [100], {
      byteLength: bytes.length,
      bodyDigest: sha256("another body"),
    });
    expect(refusal).toContain("body digest");
  });

  it("refuses a body without a top-level hash member, even with nested ones", () => {
    const original = row();
    const { hash: _hash, ...unsigned } = original;
    const bytes = Buffer.from(canonicalText(unsigned), "utf8");
    expect(streamWith(original.hash, bytes, [11])).not.toBeNull();
  });

  it("refuses a partial stream at finish", () => {
    const original = row();
    const bytes = rowBytes(original);
    const verifier = new RecordBodyStreamVerifier(original.hash, expectedOf(bytes));
    expect(verifier.update(0, bytes.subarray(0, 50))).toBeNull();
    expect(verifier.finish()).toContain("ended at 50");
  });

  it("refuses out-of-order and overlong ranges", () => {
    const original = row();
    const bytes = rowBytes(original);
    const verifier = new RecordBodyStreamVerifier(original.hash, expectedOf(bytes));
    expect(verifier.update(10, bytes.subarray(10, 20))).toContain("expected offset 0");
    const overlong = new RecordBodyStreamVerifier(original.hash, {
      byteLength: 10,
      bodyDigest: sha256(bytes.subarray(0, 10)),
    });
    expect(overlong.update(0, bytes.subarray(0, 11))).not.toBeNull();
  });

  it("descriptor-consistent descriptors of a forged body cannot pass both checks", () => {
    // A gateway that recomputes descriptor digest/length for bytes with a
    // reordered member list (non-canonical order) still fails the event hash.
    const original = row();
    const { hash, ...unsigned } = original;
    const reordered = Buffer.from(JSON.stringify({ hash, ...unsigned }), "utf8");
    expect(reordered.equals(rowBytes(original))).toBe(false);
    expect(streamWith(original.hash, reordered, [64])).not.toBeNull();
    expect(descriptorOf(original).bodyDigest).toBe(sha256(rowBytes(original)));
  });
});
