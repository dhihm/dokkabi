/**
 * Record-chain verification for the R5 exact retained record read
 * (docs/internals/dokkabi-records-r5.md).
 *
 * The gateway streams whole retained EventLog rows; this module re-verifies
 * them at the app's protocol boundary so nothing renders on the gateway's
 * word alone:
 * - Every row's hash is recomputed as sha256 over the harness's canonical
 *   JSON (recursively sorted object keys) of the row minus its `hash`.
 * - Rows are contiguous (seq +1, prev_hash chaining) across the page, the
 *   first row links to the requested `after` cursor (or genesis when the
 *   page starts the log), and the last row never passes the pinned asOf.
 * - asOf/head consistency: same session and generation, asOf within the
 *   returned head, exact hash equality where the response is authoritative
 *   (asOf at the head) or where the page itself carries the boundary row.
 *   A pin BELOW the head stays valid — pins are prefixes, not heads, and
 *   later appends must not invalidate them.
 * - The preregistered byte bounds hold: 64 KiB per canonical row and 1 MiB
 *   for the canonical records array (brackets and separators count).
 *
 * A violation is a contract error (the read fails closed); it is never
 * rendered as data and never downgraded to unavailable/unsupported.
 *
 * @module provider/dokkabi/RecordChain
 */
import * as NodeCrypto from "node:crypto";
import type { RecordResponse } from "./WorkbenchProtocol.ts";

/** The harness's genesis position: seq 0 carries the all-zero hash. */
export const RECORD_GENESIS_HASH = "0".repeat(64);
export const RECORD_ROW_MAX_BYTES = 65_536;
export const RECORD_PAGE_MAX_BYTES = 1_048_576;

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    out[key] = sortValue(nested);
  }
  return out;
}

/**
 * Deterministic JSON matching the harness's canonicalJson: object keys are
 * sorted recursively. The row hash is taken over exactly this encoding.
 */
export function canonicalRecordJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** The harness row hash: sha256 over the canonical JSON of the row minus `hash`. */
export function recordRowHash(row: {
  seq: number;
  ts: string;
  kind: string;
  name: string;
  prev_hash: string;
  hash: string;
  payload: Record<string, unknown>;
  observe?: unknown;
}): string {
  const { hash: _hash, ...unsigned } = row;
  return NodeCrypto.createHash("sha256")
    .update(canonicalRecordJson(unsigned), "utf8")
    .digest("hex");
}

/** Canonical-JSON byte size of one row. */
export function recordRowBytes(row: Parameters<typeof recordRowHash>[0]): number {
  return Buffer.byteLength(canonicalRecordJson(row), "utf8");
}

/** One decoded retained row (structural mirror of the wire schema's row). */
export interface RecordRow {
  readonly seq: number;
  readonly ts: string;
  readonly kind: "surface" | "observe" | "effect";
  readonly name: string;
  readonly prev_hash: string;
  readonly hash: string;
  readonly payload: Record<string, unknown>;
  readonly observe?: unknown;
}

/**
 * Verify one decoded record read end-to-end. Returns null when the page is
 * internally exact and consistent; otherwise a refusal reason for the
 * fail-closed contract error. `requested` carries the FULL paging cursors
 * the app actually sent (after/asOf including generation, plus limit) so
 * the response is held to its own request, not just to internal
 * consistency. A request WITHOUT an explicit asOf is a live first page: its
 * pin must be the ACTUAL current head — the gateway may never silently
 * choose an older prefix. An explicitly requested older pin stays valid
 * while appends extend the source (pins are prefixes, not heads).
 */
export function verifyRecordRead(input: {
  readonly read: RecordResponse;
  readonly after?:
    | { readonly seq: number; readonly hash: string; readonly generation: string }
    | undefined;
  readonly asOf?:
    | {
        readonly sessionId: string;
        readonly seq: number;
        readonly hash: string;
        readonly generation: string;
      }
    | undefined;
  readonly limit?: number | undefined;
}): string | null {
  const read = input.read;
  const head = read.sessionCursor;
  const asOf = read.asOf;

  // --- asOf/head consistency: same session and generation, prefix of head ---
  if (asOf.sessionId !== head.sessionId) {
    return `The record pin names session '${asOf.sessionId}' but the source head is '${head.sessionId}'.`;
  }
  if (asOf.generation !== head.generation) {
    return "The record pin names another generation of the session; a replaced source is never spliced onto this read.";
  }
  if (asOf.seq > head.seq) {
    return `The record pin (seq ${asOf.seq}) lies beyond the session head (${head.seq}).`;
  }
  if (asOf.seq === head.seq && asOf.hash !== head.hash) {
    return `The record pin at the head seq ${head.seq} carries a different hash than the head.`;
  }
  if (asOf.seq === 0 && asOf.hash !== RECORD_GENESIS_HASH) {
    return "The record pin names the genesis position with a non-genesis hash.";
  }
  if (input.asOf !== undefined) {
    // The requested pin is answered EXACTLY — identity, position, hash and
    // generation. An older explicit pin is legitimate; a different one never is.
    if (
      input.asOf.sessionId !== asOf.sessionId ||
      input.asOf.seq !== asOf.seq ||
      input.asOf.hash !== asOf.hash ||
      input.asOf.generation !== asOf.generation
    ) {
      return "The gateway answered a different asOf pin than the one requested; refusing instead of splicing.";
    }
  } else if (asOf.seq !== head.seq || asOf.hash !== head.hash) {
    // No explicit pin: this was a live first page, whose immutable pin is
    // the CURRENT head. An older prefix is never silently chosen.
    return `A live first page must pin the current head (seq ${head.seq}); the gateway pinned seq ${asOf.seq}.`;
  }

  // --- the response honors its own request shape ---
  if (input.after !== undefined && input.after.generation !== head.generation) {
    return "The requested after cursor names another generation of the session; refusing instead of splicing.";
  }
  if (input.limit !== undefined && read.records.length > input.limit) {
    return `The page carries ${read.records.length} rows beyond the requested limit ${input.limit}.`;
  }
  if (read.total !== asOf.seq) {
    return `The page total (${read.total}) is not the pinned prefix's own seq (${asOf.seq}).`;
  }

  // --- unavailable body: the empty page shape, nothing else ---
  if (read.state === "unavailable") {
    if (read.records.length > 0 || read.next !== null || read.hasMore !== false) {
      return "An unavailable record body must not carry rows, a next cursor or hasMore.";
    }
    return null;
  }

  // --- exact rows: hash, contiguity, window bounds ---
  let pageBytes = 0;
  let previous: { seq: number; hash: string } | null = null;
  for (const row of read.records) {
    const bytes = recordRowBytes(row);
    if (bytes > RECORD_ROW_MAX_BYTES) {
      return `Retained record at seq ${row.seq} spans ${bytes} canonical bytes, beyond the ${RECORD_ROW_MAX_BYTES} byte row bound.`;
    }
    pageBytes += bytes;
    const expectedSeq: number = (previous?.seq ?? input.after?.seq ?? 0) + 1;
    if (row.seq !== expectedSeq) {
      return `The page is not contiguous: expected seq ${expectedSeq}, received ${row.seq}.`;
    }
    if (previous === null && input.after === undefined && row.prev_hash !== RECORD_GENESIS_HASH) {
      return "The first row of the log must chain from the genesis hash.";
    }
    if (previous !== null && row.prev_hash !== previous.hash) {
      return `The row at seq ${row.seq} does not chain from the previous row's hash.`;
    }
    if (row.hash !== recordRowHash(row)) {
      return `The row at seq ${row.seq} does not carry its own canonical hash.`;
    }
    // The session's generation IS the first retained row's hash: a row at
    // seq 1 whose hash differs belongs to another internally-signed source.
    if (row.seq === 1 && row.hash !== head.generation) {
      return "The row at seq 1 does not carry the session generation as its hash; another source's chain is never spliced onto this read.";
    }
    if (row.seq > asOf.seq) {
      return `The row at seq ${row.seq} lies beyond the pinned prefix (${asOf.seq}).`;
    }
    previous = { seq: row.seq, hash: row.hash };
  }
  // The page bound is the canonical JSON of the whole records array.
  if (
    read.records.length > 0 &&
    pageBytes + (read.records.length - 1) + 2 > RECORD_PAGE_MAX_BYTES
  ) {
    return `The page spans beyond the ${RECORD_PAGE_MAX_BYTES} byte canonical array bound.`;
  }
  if (input.after !== undefined && read.records.length > 0) {
    const first = read.records[0]!;
    if (first.seq !== input.after.seq + 1 || first.prev_hash !== input.after.hash) {
      return `The page does not begin exactly after the requested cursor (seq ${input.after.seq}).`;
    }
  }

  // --- boundary coherence: next/hasMore describe the actual page end ---
  const last = read.records.at(-1);
  const windowStart = input.after?.seq ?? 0;
  if (read.hasMore) {
    if (last === undefined) {
      return "An empty page claims more rows remain in the requested window.";
    }
    if (read.next === null || read.next.seq !== last.seq || read.next.hash !== last.hash) {
      return "The next cursor must be the last included row when more rows remain.";
    }
    if (read.next.generation !== asOf.generation) {
      return "The next cursor names another generation of the session.";
    }
    if (last.seq >= asOf.seq) {
      return "The page claims more rows remain at or beyond its own pinned end.";
    }
  } else {
    if (read.next !== null) {
      return "A complete page must not carry a next cursor.";
    }
    // A complete page must actually BE complete: its end (the last row, or
    // the cursor the window starts after when empty) is exactly the pinned
    // prefix's end. A premature completion — or an empty success while the
    // requested window retains rows — is never accepted.
    const end = last?.seq ?? windowStart;
    if (end !== asOf.seq) {
      return `A complete page must end at the pinned prefix (seq ${asOf.seq}); it ended at ${end}.`;
    }
  }
  if (last !== undefined && last.seq === asOf.seq && last.hash !== asOf.hash) {
    return `The row at the pinned seq ${asOf.seq} carries a different hash than the pin.`;
  }
  return null;
}
