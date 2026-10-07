import { describe, expect, it } from "vite-plus/test";
import { WORKBENCH_RECORD_BODY_MAX_BYTES } from "@t3tools/contracts";

import { makeFakeExplorerSource, type FakeExplorerSource } from "./explorerFake.testFixtures";
import {
  RECORD_BODY_WINDOW_BYTES,
  RECORD_VERIFY_MAX_BYTES,
  RecordBodyIntegrityError,
  lastRecordBodyStart,
  nextRecordBodyStart,
  planRecordBodyWindow,
  previousRecordBodyStart,
  recordVerificationRefusal,
  resolveRecordBodyWindowRead,
  resolveRecordVerification,
  type RecordBodyWindowRequest,
} from "./recordBodyWindow";

const encoder = new TextEncoder();

/** Exact byte equality without per-element deep-equality cost. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function requestFor(
  source: FakeExplorerSource,
  seq: number,
  start: number,
): RecordBodyWindowRequest {
  const descriptor = source.rows[seq - 1]!.descriptor;
  return {
    row: { seq, hash: descriptor.hash, generation: source.generation },
    asOf: source.head(),
    expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
    start,
  };
}

function read(source: FakeExplorerSource, request: RecordBodyWindowRequest) {
  const plan = planRecordBodyWindow(request.start, request.expected.byteLength);
  expect(plan.fetchLimit).toBeLessThanOrEqual(WORKBENCH_RECORD_BODY_MAX_BYTES);
  return resolveRecordBodyWindowRead(
    request,
    source.body({
      row: request.row,
      asOf: request.asOf,
      offset: plan.fetchOffset,
      limit: plan.fetchLimit,
      expected: request.expected,
    }),
  );
}

function windowOf(source: FakeExplorerSource, seq: number, start: number) {
  const result = read(source, requestFor(source, seq, start));
  if (result.status !== "available") throw new Error(`unexpected ${result.status}`);
  return result.window;
}

describe("bounded UTF-8 record body windows", () => {
  const source = makeFakeExplorerSource({ rows: 70, largeRowSeq: 60, largeRowBytes: 2_600_000 });
  const large = source.rows[59]!;

  it("decodes arbitrary byte starts exactly, without replacement characters or dropped bytes", () => {
    const total = large.bytes.length;
    const starts = new Set<number>();
    for (let offset = 0; offset < 96; offset += 1) starts.add(offset);
    for (let index = 0; index < 160; index += 1)
      starts.add(Math.floor((index * 7_919_993) % total));
    for (let offset = total - 40; offset < total; offset += 1) starts.add(offset);
    for (const start of starts) {
      const window = windowOf(source, 60, start);
      expect(window.text).not.toContain("�");
      expect(window.start).toBeLessThanOrEqual(start);
      expect(start - window.start).toBeLessThanOrEqual(3);
      expect(window.end).toBeGreaterThanOrEqual(Math.min(total, start + RECORD_BODY_WINDOW_BYTES));
      expect(window.end - window.start).toBeLessThanOrEqual(WORKBENCH_RECORD_BODY_MAX_BYTES);
      // Every displayed byte is the exact canonical byte: nothing dropped or replaced.
      expect(
        sameBytes(encoder.encode(window.text), large.bytes.subarray(window.start, window.end)),
      ).toBe(true);
      expect(window.startExtended).toBe(window.start < start);
      expect(window.leadingOmitted).toBe(window.start > 0);
      expect(window.trailingOmitted).toBe(window.end < total);
    }
  });

  it("walks a 2.6MB row forward and back in contiguous bounded windows", () => {
    const total = large.bytes.length;
    let start: number | null = 0;
    let covered = 0;
    let windows = 0;
    let lastEnd = 0;
    while (start !== null) {
      const window = windowOf(source, 60, start);
      expect(window.start).toBe(lastEnd);
      covered += window.end - window.start;
      lastEnd = window.end;
      windows += 1;
      start = nextRecordBodyStart(window);
    }
    expect(covered).toBe(total);
    expect(lastEnd).toBe(total);
    expect(windows).toBeGreaterThanOrEqual(Math.ceil(total / WORKBENCH_RECORD_BODY_MAX_BYTES));
    expect(windows).toBeLessThanOrEqual(Math.ceil(total / RECORD_BODY_WINDOW_BYTES) + 1);
    // Backward from the last window: each previous window ends at the displayed start.
    let back = windowOf(source, 60, lastRecordBodyStart(total));
    expect(back.end).toBe(total);
    for (let step = 0; step < 5; step += 1) {
      const previous = previousRecordBodyStart(back);
      expect(previous).not.toBeNull();
      const window = windowOf(source, 60, previous!);
      expect(window.end).toBe(back.start);
      back = window;
    }
  });

  it.each([
    ["chunkDigest"],
    ["swapRow"],
    ["corruptData"],
    ["wrongTotal"],
    ["wrongOffset"],
    ["foreignAsOf"],
  ] as const)("fails closed on a %s range", (tamper) => {
    const tampered = makeFakeExplorerSource({ rows: 70, largeRowBytes: 200_000 });
    tampered.bodyTamper = tamper;
    expect(() => read(tampered, requestFor(tampered, 60, 1_000))).toThrow(RecordBodyIntegrityError);
  });

  it("fails closed on noncanonical base64 that atob would still decode", () => {
    const request = requestFor(source, 60, 0);
    const plan = planRecordBodyWindow(0, request.expected.byteLength);
    const result = source.body({
      row: request.row,
      asOf: request.asOf,
      offset: plan.fetchOffset,
      limit: plan.fetchLimit,
      expected: request.expected,
    });
    const body = result.body!;
    // 32765 bytes leave one padding character.
    expect(body.data.endsWith("=")).toBe(true);
    for (const data of [
      body.data.slice(0, -1),
      `${body.data.slice(0, 4)}\n${body.data.slice(4)}`,
    ]) {
      expect(() =>
        resolveRecordBodyWindowRead(request, { status: "available", body: { ...body, data } }),
      ).toThrow(RecordBodyIntegrityError);
    }
  });

  it("fails closed when the range does not match the selected descriptor", () => {
    const request = requestFor(source, 5, 0);
    expect(() =>
      read(source, { ...request, expected: { ...request.expected, bodyDigest: "e".repeat(64) } }),
    ).toThrow(RecordBodyIntegrityError);
    expect(() =>
      read(source, { ...request, expected: { ...request.expected, byteLength: 4 } }),
    ).toThrow(RecordBodyIntegrityError);
  });

  it("binds a whole-record proof to its row, pin and descriptor and refuses beyond 64MiB", () => {
    const request = requestFor(source, 60, 0);
    const exact = resolveRecordVerification(request, source.verify(request));
    expect(exact.status).toBe("exact");
    const other = requestFor(source, 5, 0);
    const swapped = resolveRecordVerification(request, source.verify(other));
    expect(swapped.status).toBe("failed");
    expect(recordVerificationRefusal(request.expected)).toBeNull();
    expect(
      recordVerificationRefusal({
        byteLength: RECORD_VERIFY_MAX_BYTES + 1,
        bodyDigest: "a".repeat(64),
      }),
    ).toContain("limited");
  });
});
