/**
 * R5 exact retained record reader — the pure read behind workbench.record
 * (docs/desktop-records-r5.md, mirrored in the app as
 * docs/internals/dokkabi-records-r5.md).
 *
 * Everything here folds ONE verified session prefix (the events EventLog
 * already chain-verified on open) into exact retained EventRecord rows.
 * Read-only by construction: no model, no bind, no abort, no kernel open,
 * no transcript cursor advance and no append on any path — a record read
 * must never mint session or ledger rows, including on refusals.
 *
 * Honesty rules this module obeys:
 * - Rows are the EXACT retained records (seq/ts/kind/name/prev_hash/hash/
 *   payload/observe), never summaries or projections; the renderer treats
 *   them as inert text.
 * - A live first page pins the CURRENT head as its immutable asOf; an
 *   explicit asOf stays valid while appends extend the log (the pin is a
 *   prefix, not the head). Cursors that name another session, generation
 *   or hash REFUSE instead of splicing a view.
 * - `after` must resolve within the requested prefix: a differing
 *   generation, hash or session is an honest refusal, never a resnapshot
 *   that would silently move the window.
 * - Oversized rows (canonical bytes beyond 64 KiB) make the body
 *   `unavailable` with an explanation — never a clipped payload
 *   masquerading as exact. The 1 MiB page bound stops BEFORE the row that
 *   would overflow, leaving an exact `next` cursor; every included row
 *   stays whole and exact.
 * - Decisions are a capability fact, not data: the kernel exposes no
 *   decision execution or branch fork surface, so the reader reports
 *   `unsupported` rather than an empty pending-decision list that would
 *   imply authority exists.
 */

import { canonicalJson } from "../host/canonical.ts";
import { GENESIS_HASH, type EventRecord } from "../host/schema.ts";

/** Canonical-JSON byte bound for ONE retained row. */
export const WORKBENCH_RECORD_ROW_MAX_BYTES = 65_536;
/** Canonical-JSON byte bound for one page (all included rows, whole rows). */
export const WORKBENCH_RECORD_PAGE_MAX_BYTES = 1_048_576;
/** Page size when the caller sends no limit. */
export const WORKBENCH_RECORD_DEFAULT_LIMIT = 50;
/** The largest page a caller may request. */
export const WORKBENCH_RECORD_MAX_LIMIT = 100;

/** An exact position in one session's verified chain. */
export interface WorkbenchRecordCursor {
  seq: number;
  hash: string;
  generation: string;
}

/** An immutable pinned prefix: the exact session plus the chain position. */
export interface WorkbenchRecordAsOf extends WorkbenchRecordCursor {
  sessionId: string;
}

/** The decisions capability fact carried by every record result. */
export interface WorkbenchRecordDecisions {
  status: "unsupported";
  reason: string;
}

export const WORKBENCH_RECORD_DECISIONS: WorkbenchRecordDecisions = {
  status: "unsupported",
  reason:
    "the harness kernel exposes no decision execution or branch fork surface; recorded evidence is not decision authority",
};

/** The record body: exact rows while in bounds, an honest refusal otherwise. */
export type WorkbenchRecordPageBody =
  | {
      state: "available";
      records: EventRecord[];
      next: WorkbenchRecordCursor | null;
      total: number;
      hasMore: boolean;
    }
  | { state: "unavailable"; reason: string };

/** Canonical-JSON byte size of one exact retained row. */
export function recordRowBytes(record: EventRecord): number {
  return Buffer.byteLength(canonicalJson(record), "utf8");
}

/** Parse the optional `limit` param: integer 1..100, default 50. Anything
 * else — zero, over-max, fractional, non-number — is a refusal. */
export function parseRecordLimit(value: unknown): number {
  if (value === undefined) return WORKBENCH_RECORD_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`limit must be an integer between 1 and ${WORKBENCH_RECORD_MAX_LIMIT}`);
  }
  if (value < 1 || value > WORKBENCH_RECORD_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${WORKBENCH_RECORD_MAX_LIMIT}`);
  }
  return value;
}

/**
 * Verify an exact cursor against the verified chain. Genesis (seq 0,
 * all-zero hash) is the empty-log position. A cursor is exact when its
 * generation is this log's identity AND the record at its seq carries its
 * hash; anything else — replaced chain, diverged hash, seq beyond the
 * head — is an honest refusal, never a spliced view.
 */
export function resolveRecordCursor(
  events: readonly EventRecord[],
  cursor: Record<string, unknown>,
  label: string,
): { ok: true; cursor: WorkbenchRecordCursor } | { ok: false; error: string } {
  if (typeof cursor.hash !== "string" || typeof cursor.generation !== "string") {
    return { ok: false, error: `${label} must carry string hash and generation` };
  }
  if (typeof cursor.seq !== "number" || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) {
    return { ok: false, error: `${label} must carry a non-negative integer seq` };
  }
  const generation = events[0]?.hash ?? GENESIS_HASH;
  if (cursor.generation !== generation) {
    return {
      ok: false,
      error: `${label} names generation ${JSON.stringify(cursor.generation.slice(0, 12))}… but this session is ${JSON.stringify(generation.slice(0, 12))}… — refusing instead of splicing`,
    };
  }
  const head = events.at(-1);
  const headSeq = head?.seq ?? 0;
  if (cursor.seq > headSeq) {
    return { ok: false, error: `${label} seq ${cursor.seq} lies beyond the session head ${headSeq}` };
  }
  if (cursor.seq === 0) {
    if (cursor.hash !== GENESIS_HASH) {
      return { ok: false, error: `${label} names seq 0 with a non-genesis hash` };
    }
    return { ok: true, cursor: { seq: 0, hash: cursor.hash, generation: cursor.generation } };
  }
  const record = events[cursor.seq - 1];
  if (record === undefined || record.seq !== cursor.seq || record.hash !== cursor.hash) {
    return {
      ok: false,
      error: `${label} does not match the retained record at seq ${cursor.seq} — refusing instead of splicing`,
    };
  }
  return { ok: true, cursor: { seq: cursor.seq, hash: cursor.hash, generation: cursor.generation } };
}

/**
 * Project ONE verified prefix into a bounded page of exact rows. The window
 * is (after.seq, asOf.seq]; rows are whole, ascending and contiguous. The
 * requested-limit stop comes BEFORE any further row is inspected, so an
 * oversized row beyond the requested page never erases the valid page in
 * front of it — a row beyond the 64 KiB row bound makes the body unavailable
 * only when that row itself belongs to the requested page. The 1 MiB page
 * bound measures the ACTUAL canonical JSON records array (brackets and
 * separators count, not just the sum of row bytes) and stops before the row
 * that would overflow, leaving an exact `next` (a row within the row bound
 * always fits an empty page alone, so paging always progresses).
 */
export function projectRecordPage(
  events: readonly EventRecord[],
  input: {
    after: WorkbenchRecordCursor | null;
    asOf: WorkbenchRecordAsOf;
    limit: number;
  },
): WorkbenchRecordPageBody {
  const generation = events[0]?.hash ?? GENESIS_HASH;
  const records: EventRecord[] = [];
  let rowsBytes = 0;
  for (const record of events) {
    if (record.seq <= (input.after?.seq ?? 0)) continue;
    if (record.seq > input.asOf.seq) break;
    // The requested page is complete: never inspect an excluded row.
    if (records.length >= input.limit) break;
    const rowBytes = recordRowBytes(record);
    if (rowBytes > WORKBENCH_RECORD_ROW_MAX_BYTES) {
      return {
        state: "unavailable",
        reason:
          `retained record at seq ${record.seq} spans ${rowBytes} canonical bytes, beyond the ` +
          `${WORKBENCH_RECORD_ROW_MAX_BYTES} byte row bound — refusing rather than clipping an exact row`,
      };
    }
    // The page bound is the canonical JSON of the whole records array:
    // brackets plus one separator per join, not merely the sum of rows.
    const arrayBytesAfterPush = rowsBytes + rowBytes + records.length + 2;
    if (arrayBytesAfterPush > WORKBENCH_RECORD_PAGE_MAX_BYTES) break;
    records.push(record);
    rowsBytes += rowBytes;
  }
  const last = records.at(-1);
  const hasMore = (last?.seq ?? input.after?.seq ?? 0) < input.asOf.seq;
  return {
    state: "available",
    records,
    next:
      hasMore && last !== undefined
        ? { seq: last.seq, hash: last.hash, generation }
        : null,
    total: input.asOf.seq,
    hasMore,
  };
}
