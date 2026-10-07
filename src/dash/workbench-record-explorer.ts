/**
 * BE-01 bounded retained-record explorer — the pure producer behind the
 * `workbench.record.index` / `workbench.record.body` reads (design: bounded
 * retained-data explorer, BE-01).
 *
 * The R5 page reader refuses any row whose canonical JSON exceeds 64 KiB, so
 * one large retained row makes its page `unavailable`. This module instead
 * describes ONE exact retained row by metadata (seq/ts/kind/name/prev_hash/
 * hash, canonical byte length and SHA-256 body digest) and serves selected
 * byte ranges (at most 32 KiB) of its canonical UTF-8 JSON — the exact bytes
 * of `canonicalJson(row)` — without ever materialising that body.
 *
 * Streaming contract:
 * - The canonical body is produced by an iterative emitter that fills fixed
 *   `RECORD_STREAM_CHUNK_BYTES` chunks. Every chunk except the last is
 *   exactly that size, so chunk i starts at byte i × chunkBytes (the offset
 *   index is this fixed stride). Each full chunk is fed to the incremental
 *   SHA-256 hashers, copied into the requested window and, on the verified
 *   path, optionally retained by the owner cache. No `JSON.stringify(row)`,
 *   no `canonicalJson(row)`, no row copy and no full-body string or buffer
 *   is allocated; string values are escaped in bounded slices of
 *   `RECORD_STRING_SLICE_UNITS` code units (a surrogate pair is never split
 *   across slices). Per-object key lists are sorted, which is the only
 *   per-object allocation.
 * - Byte parity with `canonicalJson` (src/host/canonical.ts) covers the
 *   retained JSON value domain: null, booleans, numbers (non-finite → null,
 *   -0 → 0, exactly as JSON.stringify), strings (JSON.stringify escapes;
 *   lone surrogates escaped, U+2028/2029 raw), arrays (holes and undefined
 *   → null) and plain or null-prototype objects (undefined members omitted).
 *   Member order mirrors canonicalJson's rebuilt object: integer-index keys
 *   first in ascending numeric order, then the rest sorted by UTF-16 code
 *   unit. An own `__proto__` key is omitted, because canonicalJson's
 *   `out[key] =` assignment turns it into a prototype write; its value is
 *   still checked for the domain.
 * - Values outside that domain — functions, symbols, bigints, class
 *   instances (Date, Map, boxed primitives, Array subclasses …), cycles and
 *   nesting beyond `RECORD_MAX_DEPTH` — are an explicit `outside_domain`
 *   refusal, never a guessed serialisation. The depth cap is this emitter's
 *   supported domain, not a claim about every value canonicalJson's own
 *   recursion could or could not serialise.
 *
 * Descriptor contract:
 * - `ts` and `name` are display excerpts of at most
 *   `RECORD_DESCRIPTOR_TEXT_MAX` UTF-16 code units; a surrogate pair at the
 *   cut is kept whole by cutting one unit earlier. `tsTruncated` /
 *   `nameTruncated` are present (literal `true`) only when shortened. The
 *   canonical body, `bodyDigest` and the event-hash check always use the
 *   full original fields, never the excerpts. A descriptor's JSON is bounded
 *   by `RECORD_DESCRIPTOR_MAX_JSON_BYTES`.
 *
 * Integrity contract — ordinary reads (`metadata`, `range`, and the
 * stateless helpers):
 * - Every read streams the whole row fresh, and the SAME pass hashes the
 *   canonical row without its top-level `hash` member — exactly what
 *   EventLog hashes — refusing (`hash_mismatch`) when it differs from
 *   `row.hash`. A payload mutated after the caller's verification is
 *   therefore refused on every read, cached or not, even when its length and
 *   claimed hash are unchanged; object identity is never treated as proof.
 *
 * Integrity contract — verified fast path (`metadataVerified`,
 * `rangeVerified`):
 * - MANDATORY HOST-ONLY PRECONDITION: the row is the caller's freshly
 *   acquired, EventLog-chain-verified row (the gateway chain-verifies the log
 *   from disk before each invocation). It is never model, tool or external
 *   input. Because `row.hash` then cryptographically commits the content,
 *   this path does not re-serialise per read and does not repeat chain
 *   checks: the first serialisation of a hash still checks the row's own
 *   event hash in that same pass (so a forged or mutated row can never seed
 *   the cache), then later reads of the same hash — including structured
 *   clones from new EventLog acquisitions — reuse the retained canonical
 *   chunks without rescanning the row. A same-hash row whose payload was
 *   mutated after verification is NOT rescanned on a hit: it is served the
 *   bytes the hash commits to, which is why the precondition is mandatory.
 * - Every return is built from the presented row's own original fields plus
 *   the cached byte length / body digest, after a key-identity check: the
 *   presented seq, kind, prev_hash and a digest of the full ts/name must
 *   equal those the hash was first serialised with (`identity_conflict`
 *   otherwise; the entry is kept so the conflict keeps refusing until
 *   `clear()`).
 * - Chain verification (seq continuity, prev_hash linkage, generation and
 *   session/asOf binding) belongs to the CALLER on every path. Nothing this
 *   module caches is authority for it.
 * - A range is a slice, not a complete record or chain proof. A client must
 *   assemble every range and check `bodyDigest` (and the row's event hash)
 *   before treating the content as the exact row. `chunkDigest` covers only
 *   the returned bytes.
 *
 * Cache contract (`WorkbenchRecordExplorer` only):
 * - Private, per owner, keyed by event hash, bounded by entry count and
 *   accounted bytes, LRU eviction. An entry binds the exact hash and body
 *   digest with byte length, key identity and a seal digest; verified-path
 *   entries may also retain the canonical chunks with one SHA-256 per chunk.
 *   Never the row, payload or a strong row reference.
 * - Accounting: retained chunk bytes exactly, plus the fixed estimates
 *   `RECORD_CACHE_ENTRY_BYTES` per entry and `RECORD_CACHE_CHUNK_OVERHEAD_BYTES`
 *   per chunk (digest, index slot, buffer header). While a first
 *   serialisation retains chunks, LRU bodies are evicted before metadata so cached plus
 *   in-progress bytes never exceed `maxCacheBytes`; once a body alone cannot
 *   fit, its chunks are dropped immediately and it streams through as a
 *   counted bypass (only a metadata entry stays). Transient working memory —
 *   two chunk buffers and one window of at most `RECORD_RANGE_MAX_BYTES` —
 *   is outside the cache budget.
 * - Fail closed: a broken seal or a retained chunk whose digest no longer
 *   matches is a `cache_corrupt` refusal and drops that entry, so the next
 *   read re-derives it from the caller's row. Callers always receive a new
 *   descriptor object.
 */

import { createHash, type Hash } from "node:crypto";
import { isEventKind, type EventKind, type EventRecord } from "../host/schema.ts";

/** The largest byte range one read may return (and the default). */
export const RECORD_RANGE_MAX_BYTES = 32_768;
/** The fixed chunk: every generated chunk but the last has exactly this size. */
export const RECORD_STREAM_CHUNK_BYTES = 8_192;
/** String values are escaped in slices of at most this many code units (+1
 * when a surrogate pair straddles the boundary). The escaped slice — at most
 * six output bytes per code unit — always fits one chunk. */
export const RECORD_STRING_SLICE_UNITS = 1_024;
/** Container nesting beyond this depth is an `outside_domain` refusal. */
export const RECORD_MAX_DEPTH = 4_096;
/** Descriptor ts/name excerpts are at most this many UTF-16 code units. */
export const RECORD_DESCRIPTOR_TEXT_MAX = 1_024;
/** Upper bound of JSON.stringify(descriptor) in UTF-8 bytes: two excerpts at
 * six bytes per code unit plus quotes, and 512 bytes for every other field. */
export const RECORD_DESCRIPTOR_MAX_JSON_BYTES = 2 * (6 * RECORD_DESCRIPTOR_TEXT_MAX + 2) + 512;

export const RECORD_EXPLORER_DEFAULT_MAX_ENTRIES = 64;
export const RECORD_EXPLORER_DEFAULT_MAX_CACHE_BYTES = 8 * 1_048_576;
export const RECORD_EXPLORER_HARD_MAX_ENTRIES = 65_536;
export const RECORD_EXPLORER_HARD_MAX_CACHE_BYTES = 64 * 1_048_576;
/** Estimated fixed cost of one cache entry (identity strings and digests). */
export const RECORD_CACHE_ENTRY_BYTES = 1_024;
/** Estimated per-chunk cost beyond its bytes (digest, index slot, header). */
export const RECORD_CACHE_CHUNK_OVERHEAD_BYTES = 128;

const HEX64 = /^[0-9a-f]{64}$/;

/** Metadata for one exact retained row. No payload bytes. */
export interface WorkbenchRecordDescriptor {
  seq: number;
  /** At most RECORD_DESCRIPTOR_TEXT_MAX code units; see `tsTruncated`. */
  ts: string;
  kind: EventKind;
  /** At most RECORD_DESCRIPTOR_TEXT_MAX code units; see `nameTruncated`. */
  name: string;
  prev_hash: string;
  hash: string;
  /** UTF-8 byte length of canonicalJson(row). */
  byteLength: number;
  /** Lowercase hex SHA-256 of the full canonical row bytes, including its
   * `hash` member (NOT the event hash). */
  bodyDigest: string;
  /** Present only when `ts` is a shortened excerpt of the original. */
  tsTruncated?: true;
  /** Present only when `name` is a shortened excerpt of the original. */
  nameTruncated?: true;
}

/** One canonical byte range of one row. Cursor/asOf binding is the caller's. */
export interface WorkbenchRecordRange {
  offset: number;
  /** The next unread offset, or null when this range reaches the end. */
  nextOffset: number | null;
  totalBytes: number;
  bodyDigest: string;
  /** Lowercase hex SHA-256 of exactly the decoded `data` bytes. */
  chunkDigest: string;
  /** Base64 of the canonical UTF-8 bytes [offset, offset + length), at most
   * RECORD_RANGE_MAX_BYTES decoded. May split a multi-byte character;
   * decode incrementally across ranges. */
  data: string;
}

export interface WorkbenchRecordRangeInput {
  offset: number;
  limit?: number;
}

export interface WorkbenchRecordExplorerOptions {
  maxEntries?: number;
  maxCacheBytes?: number;
}

export interface WorkbenchRecordExplorerStats {
  entries: number;
  cacheBytes: number;
  /** Highest cached plus in-progress retained bytes ever observed. */
  peakCacheBytes: number;
  maxEntries: number;
  maxCacheBytes: number;
  /** Canonical chunks currently retained across entries. */
  retainedChunks: number;
  /** Lookups that found a valid entry for the presented hash. */
  hits: number;
  /** Lookups that found none. */
  misses: number;
  /** Verified ranges served from retained chunks without serialising. */
  chunkHits: number;
  /** Body sets evicted while retaining their metadata entries. */
  bodyEvictions: number;
  evictions: number;
  /** Verified serialisations whose body did not fit the budget: streamed
   * through, chunks not retained (or dropped part-way). */
  bypasses: number;
  /** Fresh identities whose fixed entry cost exceeds the whole budget. */
  uncacheable: number;
  metadataReads: number;
  rangeReads: number;
  verifiedMetadataReads: number;
  verifiedRangeReads: number;
  refusals: number;
  /** Entries dropped because their seal or a retained chunk failed. */
  corruptions: number;
  /** Full-row canonical serialisations started (scans of the row). */
  serializations: number;
  /** Canonical bytes emitted across all serialisations. */
  streamedBytes: number;
  /** Body, event-hash, full ts/name, chunk and range bytes hashed. Excludes
   * fixed cache seals and the small field-length framing. */
  hashedBytes: number;
  chunksGenerated: number;
  /** The largest generated chunk; never exceeds `chunkBytes`. */
  largestChunkBytes: number;
  chunkBytes: number;
  disposed: boolean;
}

export type WorkbenchRecordExplorerErrorCode =
  | "invalid_options"
  | "invalid_row"
  | "outside_domain"
  | "hash_mismatch"
  | "identity_conflict"
  | "cache_corrupt"
  | "invalid_range"
  | "disposed";

export class WorkbenchRecordExplorerError extends Error {
  readonly code: WorkbenchRecordExplorerErrorCode;
  constructor(code: WorkbenchRecordExplorerErrorCode, message: string) {
    super(message);
    this.name = "WorkbenchRecordExplorerError";
    this.code = code;
  }
}

function refuse(code: WorkbenchRecordExplorerErrorCode, message: string): never {
  throw new WorkbenchRecordExplorerError(code, message);
}

/** Validated byte window (absent for metadata-only streams). */
interface Window {
  offset: number;
  limit: number;
}

interface StreamCounters {
  bytes: number;
  hashed: number;
  chunks: number;
  largest: number;
}

function newCounters(): StreamCounters {
  return { bytes: 0, hashed: 0, chunks: 0, largest: 0 };
}

/** Receives each generated chunk. Returns true when it took ownership of a
 * full chunk buffer (the sink then allocates a fresh one). */
interface ChunkCollector {
  accept(segment: Buffer, full: boolean): boolean;
}

interface StreamResult {
  fields: RowFields;
  byteLength: number;
  bodyDigest: string;
  window: Buffer | null;
}

/** Which consumers a piece of canonical text reaches. `both`: the body and
 * the unsigned event-hash form; `body`: the body only (the top-level `hash`
 * member); `discard`: neither (an own `__proto__` subtree being checked). */
type SinkMode = "both" | "body" | "discard";

/** Fixed-chunk sink: full chunks flow to the hashers, window and collector. */
class CanonicalSink {
  private chunk = Buffer.allocUnsafe(RECORD_STREAM_CHUNK_BYTES);
  /** Bounded staging for a piece that straddles a chunk boundary. */
  private readonly scratch = Buffer.allocUnsafe(RECORD_STREAM_CHUNK_BYTES);
  private used = 0;
  /** Start, within the current chunk, of bytes not yet fed to `unsigned`. */
  private unsignedFrom = 0;
  private mode: SinkMode = "both";
  /** Canonical body bytes already flushed. */
  position = 0;
  readonly body: Hash = createHash("sha256");
  readonly unsigned: Hash = createHash("sha256");
  private readonly capture: Buffer | null;
  private readonly windowStart: number;
  private readonly windowEnd: number;

  constructor(
    window: Window | null,
    readonly counters: StreamCounters,
    private readonly collector: ChunkCollector | null,
  ) {
    this.capture = window === null ? null : Buffer.alloc(window.limit);
    this.windowStart = window?.offset ?? 0;
    this.windowEnd = window === null ? 0 : window.offset + window.limit;
  }

  get currentMode(): SinkMode {
    return this.mode;
  }

  setMode(mode: SinkMode): void {
    if (mode === this.mode) return;
    this.syncUnsigned();
    this.mode = mode;
  }

  /** Feed the event-hash form everything written in `both` mode so far. */
  private syncUnsigned(): void {
    if (this.mode === "both" && this.used > this.unsignedFrom) {
      this.unsigned.update(this.chunk.subarray(this.unsignedFrom, this.used));
      this.counters.hashed += this.used - this.unsignedFrom;
    }
    this.unsignedFrom = this.used;
  }

  write(text: string): void {
    if (this.mode === "discard") return;
    const room = RECORD_STREAM_CHUNK_BYTES - this.used;
    // A UTF-16 code unit never encodes to more than three UTF-8 bytes.
    if (text.length * 3 <= room) {
      this.used += this.chunk.write(text, this.used, room, "utf8");
      return;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > RECORD_STREAM_CHUNK_BYTES) {
      // Unreachable by construction (slices are bounded); refuse rather than
      // silently overflow the fixed buffers.
      refuse("outside_domain", `canonical piece of ${bytes} bytes exceeds the ${RECORD_STREAM_CHUNK_BYTES} byte chunk`);
    }
    this.scratch.write(text, 0, bytes, "utf8");
    let from = 0;
    while (from < bytes) {
      if (this.used === RECORD_STREAM_CHUNK_BYTES) this.flush();
      const take = Math.min(bytes - from, RECORD_STREAM_CHUNK_BYTES - this.used);
      this.scratch.copy(this.chunk, this.used, from, from + take);
      this.used += take;
      from += take;
    }
  }

  flush(): void {
    if (this.used === 0) return;
    this.syncUnsigned();
    const segment = this.chunk.subarray(0, this.used);
    this.body.update(segment);
    this.counters.hashed += this.used;
    if (this.capture !== null) {
      const start = Math.max(this.position, this.windowStart);
      const end = Math.min(this.position + this.used, this.windowEnd);
      if (start < end) {
        segment.copy(this.capture, start - this.windowStart, start - this.position, end - this.position);
      }
    }
    this.position += this.used;
    this.counters.bytes += this.used;
    this.counters.chunks += 1;
    if (this.used > this.counters.largest) this.counters.largest = this.used;
    if (this.collector?.accept(segment, this.used === RECORD_STREAM_CHUNK_BYTES) === true) {
      this.chunk = Buffer.allocUnsafe(RECORD_STREAM_CHUNK_BYTES);
    }
    this.used = 0;
    this.unsignedFrom = 0;
  }

  /** The captured window bytes, trimmed to the actual body end. */
  windowBytes(): Buffer | null {
    if (this.capture === null) return null;
    const available = Math.max(0, Math.min(this.windowEnd, this.position) - this.windowStart);
    return this.capture.subarray(0, available);
  }
}

interface ObjectFrame {
  type: "object";
  source: Record<string, unknown>;
  keys: string[];
  index: number;
  /** An own `__proto__` member still to be domain-checked (discarded). */
  protoPending: boolean;
  top: boolean;
  wroteBody: boolean;
  wroteUnsigned: boolean;
  restore: SinkMode | null;
}

interface ArrayFrame {
  type: "array";
  source: readonly unknown[];
  index: number;
  restore: SinkMode | null;
}

type Frame = ObjectFrame | ArrayFrame;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** JSON.stringify(value) for a string, in bounded slices. Escaping each slice
 * with the engine's own JSON.stringify keeps exact escape parity; a slice
 * boundary never separates a surrogate pair, so pairs stay raw and only
 * genuinely lone surrogates are escaped — exactly as for the whole string. */
function writeString(sink: CanonicalSink, value: string): void {
  if (value.length <= RECORD_STRING_SLICE_UNITS) {
    sink.write(JSON.stringify(value));
    return;
  }
  sink.write('"');
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + RECORD_STRING_SLICE_UNITS, value.length);
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) {
      end += 1;
    }
    const escaped = JSON.stringify(value.slice(start, end));
    sink.write(escaped.slice(1, -1));
    start = end;
  }
  sink.write('"');
}

/** Own member order of canonicalJson's rebuilt `out` object: assign the
 * sorted keys to a fresh ordinary object (as sortValue does) and read the
 * engine's own key order back. `__proto__` never becomes an own key there. */
function canonicalKeyOrder(source: Record<string, unknown>): { keys: string[]; hasProto: boolean } {
  const own = Object.keys(source).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const probe: Record<string, 0> = {};
  let hasProto = false;
  for (const key of own) {
    if (key === "__proto__") {
      hasProto = true;
      continue;
    }
    probe[key] = 0;
  }
  return { keys: Object.keys(probe), hasProto };
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const proto: unknown = Object.getPrototypeOf(value);
  const ctor = proto !== null && typeof proto === "object" ? (proto as { constructor?: { name?: unknown } }).constructor : undefined;
  return typeof ctor?.name === "string" && ctor.name !== "" ? ctor.name : "object";
}

/**
 * Serialise canonicalJson(row) once: body digest, unsigned (event-hash)
 * digest, byte length, the optional window and optional retained chunks —
 * all in fixed chunks. Refuses unless the row hashes to its own `hash`.
 */
function streamRow(
  row: EventRecord,
  window: Window | null,
  counters: StreamCounters = newCounters(),
  collector: ChunkCollector | null = null,
): StreamResult {
  const fields = validateRowShape(row);
  const sink = new CanonicalSink(window, counters, collector);
  const stack: Frame[] = [];
  const ancestors = new Set<object>();

  const openValue = (value: unknown, inArray: boolean, restore: SinkMode | null, top = false): void => {
    if (value === null) {
      sink.write("null");
    } else {
      switch (typeof value) {
        case "string":
          writeString(sink, value);
          break;
        case "number":
          // JSON.stringify's own number form: non-finite → null, -0 → 0.
          sink.write(JSON.stringify(value));
          break;
        case "boolean":
          sink.write(value ? "true" : "false");
          break;
        case "undefined":
          // Objects skip undefined members before reaching here.
          if (!inArray) refuse("outside_domain", "undefined outside an array or object member");
          sink.write("null");
          break;
        case "object": {
          if (stack.length >= RECORD_MAX_DEPTH) {
            refuse("outside_domain", `retained value nests beyond ${RECORD_MAX_DEPTH} levels`);
          }
          if (ancestors.has(value)) refuse("outside_domain", "retained value is cyclic");
          const proto: unknown = Object.getPrototypeOf(value);
          if (Array.isArray(value)) {
            if (proto !== Array.prototype) {
              refuse("outside_domain", `retained array has a non-Array prototype (${describeType(value)})`);
            }
            ancestors.add(value);
            sink.write("[");
            stack.push({ type: "array", source: value, index: 0, restore });
            return;
          }
          if (proto !== Object.prototype && proto !== null) {
            refuse("outside_domain", `retained ${describeType(value)} is not a plain JSON object`);
          }
          ancestors.add(value);
          const source = value as Record<string, unknown>;
          const { keys, hasProto } = canonicalKeyOrder(source);
          sink.write("{");
          stack.push({
            type: "object",
            source,
            keys,
            index: 0,
            protoPending: hasProto,
            top,
            wroteBody: false,
            wroteUnsigned: false,
            restore,
          });
          return;
        }
        default:
          refuse("outside_domain", `retained ${typeof value} is not a JSON value`);
      }
    }
    if (restore !== null) sink.setMode(restore);
  };

  const close = (frame: Frame): void => {
    sink.write(frame.type === "array" ? "]" : "}");
    stack.pop();
    ancestors.delete(frame.source);
    if (frame.restore !== null) sink.setMode(frame.restore);
  };

  openValue(row, false, null, true);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.type === "array") {
      if (frame.index >= frame.source.length) {
        close(frame);
        continue;
      }
      if (frame.index > 0) sink.write(",");
      const value = frame.source[frame.index];
      frame.index += 1;
      openValue(value, true, null);
      continue;
    }
    if (frame.index < frame.keys.length) {
      const key = frame.keys[frame.index]!;
      frame.index += 1;
      const value = frame.source[key];
      if (value === undefined) continue;
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        refuse("outside_domain", `retained member ${JSON.stringify(key.slice(0, 64))} is a ${typeof value}`);
      }
      if (frame.top && key === "hash") {
        // The event hash covers every member except this one.
        sink.setMode("body");
        if (frame.wroteBody) sink.write(",");
        writeString(sink, key);
        sink.write(":");
        openValue(value, false, "both");
        frame.wroteBody = true;
        continue;
      }
      if (frame.wroteBody && !frame.wroteUnsigned) {
        // Only `hash` precedes: the unsigned form has no separator here.
        sink.setMode("body");
        sink.write(",");
        sink.setMode("both");
      } else if (frame.wroteBody) {
        sink.write(",");
      }
      writeString(sink, key);
      sink.write(":");
      openValue(value, false, null);
      frame.wroteBody = true;
      frame.wroteUnsigned = true;
      continue;
    }
    if (frame.protoPending) {
      frame.protoPending = false;
      const value = frame.source["__proto__"];
      if (value === undefined) continue;
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        refuse("outside_domain", `retained member "__proto__" is a ${typeof value}`);
      }
      const previous = sink.currentMode;
      sink.setMode("discard");
      openValue(value, false, previous);
      continue;
    }
    close(frame);
  }
  sink.flush();

  const unsignedDigest = sink.unsigned.digest("hex");
  const bodyDigest = sink.body.digest("hex");
  if (unsignedDigest !== fields.hash) {
    refuse(
      "hash_mismatch",
      `retained record at seq ${fields.seq} no longer hashes to its event hash ${fields.hash.slice(0, 12)}… — refusing a mutated or forged row`,
    );
  }
  return { fields, byteLength: sink.position, bodyDigest, window: sink.windowBytes() };
}

interface RowFields {
  seq: number;
  ts: string;
  kind: EventKind;
  name: string;
  prev_hash: string;
  hash: string;
}

/** Shape only: O(1) in the payload size. Long ts/name are valid source. */
function validateRowShape(row: unknown): RowFields {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    refuse("invalid_row", "retained record must be an object");
  }
  const proto: unknown = Object.getPrototypeOf(row);
  if (proto !== Object.prototype && proto !== null) refuse("invalid_row", "retained record must be a plain object");
  const value = row as Record<string, unknown>;
  const { seq, ts, kind, name, prev_hash, hash, payload } = value;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    refuse("invalid_row", "retained record seq must be a positive integer");
  }
  if (typeof ts !== "string") refuse("invalid_row", "retained record ts must be a string");
  if (!isEventKind(kind)) refuse("invalid_row", "retained record kind is not an event kind");
  if (typeof name !== "string") refuse("invalid_row", "retained record name must be a string");
  if (typeof prev_hash !== "string" || !HEX64.test(prev_hash)) {
    refuse("invalid_row", "retained record prev_hash must be 64 lowercase hex characters");
  }
  if (typeof hash !== "string" || !HEX64.test(hash)) {
    refuse("invalid_row", "retained record hash must be 64 lowercase hex characters");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    refuse("invalid_row", "retained record payload must be an object");
  }
  return { seq, ts, kind, name, prev_hash, hash };
}

/** At most RECORD_DESCRIPTOR_TEXT_MAX code units, never splitting a pair. */
function excerpt(value: string): { text: string; truncated: boolean } {
  if (value.length <= RECORD_DESCRIPTOR_TEXT_MAX) return { text: value, truncated: false };
  let end = RECORD_DESCRIPTOR_TEXT_MAX;
  if (isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

/** A new descriptor from the presented row's own fields. */
function describe(fields: RowFields, byteLength: number, bodyDigest: string): WorkbenchRecordDescriptor {
  const ts = excerpt(fields.ts);
  const name = excerpt(fields.name);
  return {
    seq: fields.seq,
    ts: ts.text,
    kind: fields.kind,
    name: name.text,
    prev_hash: fields.prev_hash,
    hash: fields.hash,
    byteLength,
    bodyDigest,
    ...(ts.truncated ? { tsTruncated: true as const } : {}),
    ...(name.truncated ? { nameTruncated: true as const } : {}),
  };
}

/** Exact digest of the full original ts/name. UTF-16LE keeps lone
 * surrogates distinct; bounded slices avoid one giant encoding. */
function fieldsDigest(fields: RowFields, counters: StreamCounters): string {
  const hash = createHash("sha256");
  for (const value of [fields.ts, fields.name]) {
    hash.update(`${value.length}:`);
    for (let start = 0; start < value.length; start += RECORD_STRING_SLICE_UNITS) {
      hash.update(value.slice(start, start + RECORD_STRING_SLICE_UNITS), "utf16le");
    }
    counters.hashed += 2 * value.length;
  }
  return hash.digest("hex");
}

function parseRange(input: unknown): Window {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    refuse("invalid_range", "range must be an object with offset and optional limit");
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key !== "offset" && key !== "limit") refuse("invalid_range", `unknown range field ${JSON.stringify(key.slice(0, 64))}`);
  }
  const { offset, limit } = value;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    refuse("invalid_range", "offset must be a non-negative integer");
  }
  if (limit === undefined) return { offset, limit: RECORD_RANGE_MAX_BYTES };
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > RECORD_RANGE_MAX_BYTES) {
    refuse("invalid_range", `limit must be an integer between 1 and ${RECORD_RANGE_MAX_BYTES}`);
  }
  return { offset, limit };
}

function checkOffset(window: Window, total: number): void {
  if (window.offset > total) {
    refuse("invalid_range", `offset ${window.offset} lies beyond the ${total} byte canonical row`);
  }
}

function toRange(total: number, bodyDigest: string, window: Window, data: Buffer, counters: StreamCounters): WorkbenchRecordRange {
  const end = window.offset + data.length;
  counters.hashed += data.length;
  return {
    offset: window.offset,
    nextOffset: end < total ? end : null,
    totalBytes: total,
    bodyDigest,
    chunkDigest: createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
}

/** Stateless: describe one retained row by streaming it once. */
export function prepareRecordMetadata(row: EventRecord): WorkbenchRecordDescriptor {
  const result = streamRow(row, null);
  return describe(result.fields, result.byteLength, result.bodyDigest);
}

/** Stateless: one canonical byte range of one retained row. */
export function readRecordRange(row: EventRecord, input: WorkbenchRecordRangeInput): WorkbenchRecordRange {
  const window = parseRange(input);
  const result = streamRow(row, window);
  checkOffset(window, result.byteLength);
  return toRange(result.byteLength, result.bodyDigest, window, result.window ?? Buffer.alloc(0), newCounters());
}

function parseOption(value: unknown, label: string, fallback: number, hardMax: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > hardMax) {
    refuse("invalid_options", `${label} must be an integer between 1 and ${hardMax}`);
  }
  return value;
}

interface CacheEntry {
  readonly hash: string;
  readonly seq: number;
  readonly kind: EventKind;
  readonly prev_hash: string;
  readonly fieldsDigest: string;
  readonly byteLength: number;
  readonly bodyDigest: string;
  /** Fixed-stride canonical chunks (chunk i starts at i × chunkBytes), or
   * null for a metadata-only entry. */
  readonly chunks: readonly Buffer[] | null;
  /** SHA-256 of each retained chunk, checked whenever it is served. */
  readonly chunkDigests: readonly Buffer[] | null;
  readonly bytes: number;
  readonly seal: string;
}

function sealOf(entry: Omit<CacheEntry, "seal" | "chunks" | "chunkDigests" | "bytes">, chunkCount: number): string {
  return createHash("sha256")
    .update([entry.hash, entry.seq, entry.kind, entry.prev_hash, entry.fieldsDigest, entry.byteLength, entry.bodyDigest, chunkCount].join("\n"))
    .digest("hex");
}

function chunkCost(bytes: number): number {
  return bytes + RECORD_CACHE_CHUNK_OVERHEAD_BYTES;
}

/** Retained cost of a body of `byteLength` bytes, entry included. */
function retainedCost(byteLength: number): number {
  const chunks = Math.ceil(byteLength / RECORD_STREAM_CHUNK_BYTES);
  return RECORD_CACHE_ENTRY_BYTES + byteLength + chunks * RECORD_CACHE_CHUNK_OVERHEAD_BYTES;
}

/** Collects chunks for one first serialisation while the budget allows. */
class ChunkFill implements ChunkCollector {
  chunks: Buffer[] | null = [];
  digests: Buffer[] = [];
  bytes = RECORD_CACHE_ENTRY_BYTES;

  constructor(
    private readonly reserve: (bytes: number) => boolean,
    private readonly counters: StreamCounters,
  ) {}

  accept(segment: Buffer, full: boolean): boolean {
    if (this.chunks === null) return false;
    const next = this.bytes + chunkCost(segment.length);
    if (!this.reserve(next)) {
      // The body alone cannot fit: release everything held so far.
      this.chunks = null;
      this.digests = [];
      this.bytes = RECORD_CACHE_ENTRY_BYTES;
      return false;
    }
    let kept = segment;
    if (!full) {
      // Exact-size, unpooled copy of the short final chunk.
      kept = Buffer.allocUnsafeSlow(segment.length);
      segment.copy(kept);
    }
    this.chunks.push(kept);
    this.digests.push(createHash("sha256").update(kept).digest());
    this.counters.hashed += kept.length;
    this.bytes = next;
    return full;
  }
}

/**
 * Per-owner explorer with a bounded cache of canonical chunks and derived
 * identities. The owner (one gateway) constructs it, chain-verifies its
 * source freshly before each read, and clears or disposes it when the
 * source scope ends.
 */
export class WorkbenchRecordExplorer {
  /** LRU by insertion order; keyed by event hash. Private: tests may only
   * reach it through a controlled cast to inject corruption. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Body access order is independent of descriptor access order. */
  private readonly bodyLru = new Set<string>();
  private readonly maxEntries: number;
  private readonly maxCacheBytes: number;
  private cacheBytes = 0;
  private peakCacheBytes = 0;
  private retainedChunks = 0;
  private disposed = false;
  private readonly counters = {
    hits: 0,
    misses: 0,
    chunkHits: 0,
    bodyEvictions: 0,
    evictions: 0,
    bypasses: 0,
    uncacheable: 0,
    metadataReads: 0,
    rangeReads: 0,
    verifiedMetadataReads: 0,
    verifiedRangeReads: 0,
    refusals: 0,
    corruptions: 0,
    serializations: 0,
    streamedBytes: 0,
    hashedBytes: 0,
    chunksGenerated: 0,
    largestChunkBytes: 0,
  };

  constructor(options: WorkbenchRecordExplorerOptions = {}) {
    if (options === null || typeof options !== "object") refuse("invalid_options", "options must be an object");
    this.maxEntries = parseOption(options.maxEntries, "maxEntries", RECORD_EXPLORER_DEFAULT_MAX_ENTRIES, RECORD_EXPLORER_HARD_MAX_ENTRIES);
    this.maxCacheBytes = parseOption(
      options.maxCacheBytes,
      "maxCacheBytes",
      RECORD_EXPLORER_DEFAULT_MAX_CACHE_BYTES,
      RECORD_EXPLORER_HARD_MAX_CACHE_BYTES,
    );
  }

  /** Fresh descriptor of any row: always re-serialised and self-hash checked. */
  metadata(row: EventRecord): WorkbenchRecordDescriptor {
    return this.guard((work) => {
      this.counters.metadataReads += 1;
      const result = this.serialize(row, null, null, work);
      this.observe(result, work);
      return describe(result.fields, result.byteLength, result.bodyDigest);
    });
  }

  /** Fresh canonical byte range of any row: always re-serialised and checked. */
  range(row: EventRecord, input: WorkbenchRecordRangeInput): WorkbenchRecordRange {
    return this.guard((work) => {
      this.counters.rangeReads += 1;
      const window = parseRange(input);
      const result = this.serialize(row, window, null, work);
      checkOffset(window, result.byteLength);
      this.observe(result, work);
      return toRange(result.byteLength, result.bodyDigest, window, result.window ?? Buffer.alloc(0), work);
    });
  }

  /**
   * Descriptor of a row the HOST has just acquired from a chain-verified
   * EventLog (mandatory precondition, see the module contract). A cached hash
   * is answered without rescanning the row.
   */
  metadataVerified(row: EventRecord): WorkbenchRecordDescriptor {
    return this.guard((work) => {
      this.counters.verifiedMetadataReads += 1;
      const fields = validateRowShape(row);
      const entry = this.lookup(fields, work);
      if (entry !== null) return describe(fields, entry.byteLength, entry.bodyDigest);
      const result = this.fill(row, null, work);
      return describe(result.fields, result.byteLength, result.bodyDigest);
    });
  }

  /**
   * Byte range of a row the HOST has just acquired from a chain-verified
   * EventLog (mandatory precondition). Served from retained chunks when this
   * hash's body is cached; otherwise serialised once (retaining chunks when
   * the budget allows, else a counted bypass).
   */
  rangeVerified(row: EventRecord, input: WorkbenchRecordRangeInput): WorkbenchRecordRange {
    return this.guard((work) => {
      this.counters.verifiedRangeReads += 1;
      const window = parseRange(input);
      const fields = validateRowShape(row);
      const entry = this.lookup(fields, work);
      if (entry !== null) {
        checkOffset(window, entry.byteLength);
        if (entry.chunks !== null) {
          this.counters.chunkHits += 1;
          const data = this.slice(entry, window, work);
          return toRange(entry.byteLength, entry.bodyDigest, window, data, work);
        }
        if (retainedCost(entry.byteLength) > this.maxCacheBytes) {
          this.counters.bypasses += 1;
          const result = this.serialize(row, window, null, work);
          this.matchEntry(entry, result);
          return toRange(result.byteLength, result.bodyDigest, window, result.window ?? Buffer.alloc(0), work);
        }
      }
      const result = this.fill(row, window, work, entry);
      checkOffset(window, result.byteLength);
      return toRange(result.byteLength, result.bodyDigest, window, result.window ?? Buffer.alloc(0), work);
    });
  }

  /** Drop every cached entry and retained chunk; cumulative counters remain. */
  clear(): void {
    this.cache.clear();
    this.bodyLru.clear();
    this.cacheBytes = 0;
    this.retainedChunks = 0;
  }

  /** Release the cache; every later read refuses. */
  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  stats(): WorkbenchRecordExplorerStats {
    return {
      entries: this.cache.size,
      cacheBytes: this.cacheBytes,
      peakCacheBytes: this.peakCacheBytes,
      maxEntries: this.maxEntries,
      maxCacheBytes: this.maxCacheBytes,
      retainedChunks: this.retainedChunks,
      ...this.counters,
      chunkBytes: RECORD_STREAM_CHUNK_BYTES,
      disposed: this.disposed,
    };
  }

  private guard<T>(read: (work: StreamCounters) => T): T {
    const work = newCounters();
    try {
      if (this.disposed) refuse("disposed", "record explorer is disposed");
      return read(work);
    } catch (error) {
      this.counters.refusals += 1;
      throw error;
    } finally {
      // Charged even when a read refuses part-way.
      this.counters.streamedBytes += work.bytes;
      this.counters.hashedBytes += work.hashed;
      this.counters.chunksGenerated += work.chunks;
      if (work.largest > this.counters.largestChunkBytes) this.counters.largestChunkBytes = work.largest;
    }
  }

  private serialize(row: EventRecord, window: Window | null, collector: ChunkCollector | null, work: StreamCounters): StreamResult {
    this.counters.serializations += 1;
    return streamRow(row, window, work, collector);
  }

  /** Verified-path serialisation that retains chunks within the budget; a
   * metadata-only `previous` entry for the hash must match before upgrade. */
  private fill(row: EventRecord, window: Window | null, work: StreamCounters, previous: CacheEntry | null = null): StreamResult {
    let fill: ChunkFill | null = null;
    if (this.reserve(RECORD_CACHE_ENTRY_BYTES)) {
      fill = new ChunkFill((bytes) => this.reserve(bytes, false), work);
    } else {
      this.counters.uncacheable += 1;
    }
    const result = this.serialize(row, window, fill, work);
    if (previous !== null) this.matchEntry(previous, result);
    if (fill === null) return result;
    if (fill.chunks === null) this.counters.bypasses += 1;
    this.admit(result, fill.chunks, fill.chunks === null ? null : fill.digests, fill.bytes, work);
    return result;
  }

  /** Ordinary path: compare a fresh serialisation with the owner's entry,
   * or admit a metadata-only entry for it. */
  private observe(result: StreamResult, work: StreamCounters): void {
    const entry = this.lookup(result.fields, work);
    if (entry !== null) {
      this.matchEntry(entry, result);
      return;
    }
    if (this.reserve(RECORD_CACHE_ENTRY_BYTES)) {
      this.admit(result, null, null, RECORD_CACHE_ENTRY_BYTES, work);
    } else {
      this.counters.uncacheable += 1;
    }
  }

  private matchEntry(entry: CacheEntry, result: StreamResult): void {
    if (entry.byteLength !== result.byteLength || entry.bodyDigest !== result.bodyDigest) {
      refuse(
        "identity_conflict",
        `retained record at seq ${entry.seq} streamed a body that differs from the one this owner cached for its hash — refusing; clear() only after fresh source re-verification`,
      );
    }
  }

  /** Seal and key-identity checked entry for the presented row, or null. */
  private lookup(fields: RowFields, work: StreamCounters): CacheEntry | null {
    const entry = this.cache.get(fields.hash);
    if (entry === undefined) {
      this.counters.misses += 1;
      return null;
    }
    if (entry.hash !== fields.hash || sealOf(entry, entry.chunks?.length ?? 0) !== entry.seal) {
      this.corrupt(fields.hash);
      refuse("cache_corrupt", `cached record entry for seq ${fields.seq} failed its seal — dropped; re-read to re-derive it`);
    }
    if (
      entry.seq !== fields.seq
      || entry.kind !== fields.kind
      || entry.prev_hash !== fields.prev_hash
      || entry.fieldsDigest !== fieldsDigest(fields, work)
    ) {
      refuse(
        "identity_conflict",
        `retained record at seq ${fields.seq} presents fields that differ from the identity its hash was first serialised with — refusing; clear() only after fresh source re-verification`,
      );
    }
    this.counters.hits += 1;
    this.cache.delete(fields.hash);
    this.cache.set(fields.hash, entry);
    return entry;
  }

  /** The window's bytes from retained chunks, each touched chunk verified. */
  private slice(entry: CacheEntry, window: Window, work: StreamCounters): Buffer {
    const chunks = entry.chunks!;
    const digests = entry.chunkDigests!;
    const end = Math.min(window.offset + window.limit, entry.byteLength);
    const out = Buffer.allocUnsafe(Math.max(0, end - window.offset));
    let position = window.offset;
    while (position < end) {
      const index = Math.floor(position / RECORD_STREAM_CHUNK_BYTES);
      const chunk = chunks[index];
      const digest = digests[index];
      work.hashed += chunk?.length ?? 0;
      if (chunk === undefined || digest === undefined || !createHash("sha256").update(chunk).digest().equals(digest)) {
        this.corrupt(entry.hash);
        refuse("cache_corrupt", `cached chunk ${index} of seq ${entry.seq} failed its digest — dropped; re-read to re-derive it`);
      }
      const within = position - index * RECORD_STREAM_CHUNK_BYTES;
      const take = Math.min(chunk.length - within, end - position);
      if (take <= 0) {
        this.corrupt(entry.hash);
        refuse("cache_corrupt", `cached chunk ${index} of seq ${entry.seq} is shorter than its stride — dropped`);
      }
      chunk.copy(out, position - window.offset, within, within + take);
      position += take;
    }
    this.bodyLru.delete(entry.hash);
    this.bodyLru.add(entry.hash);
    return out;
  }

  /** Evict bodies first. A body builder cannot evict retained descriptors. */
  private reserve(bytes: number, allowMetadataEviction = true): boolean {
    if (bytes > this.maxCacheBytes) return false;
    while (this.cacheBytes + bytes > this.maxCacheBytes) {
      const oldestBody = this.bodyLru.values().next();
      if (oldestBody.done !== true) {
        this.dropBody(oldestBody.value);
        continue;
      }
      if (!allowMetadataEviction) return false;
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
      this.counters.evictions += 1;
    }
    if (this.cacheBytes + bytes > this.peakCacheBytes) this.peakCacheBytes = this.cacheBytes + bytes;
    return true;
  }

  private dropBody(key: string): void {
    this.bodyLru.delete(key);
    const entry = this.cache.get(key);
    if (entry === undefined || entry.chunks === null) return;
    this.cacheBytes -= entry.bytes - RECORD_CACHE_ENTRY_BYTES;
    this.retainedChunks -= entry.chunks.length;
    this.cache.set(key, Object.freeze({
      ...entry,
      chunks: null,
      chunkDigests: null,
      bytes: RECORD_CACHE_ENTRY_BYTES,
      seal: sealOf(entry, 0),
    }));
    this.counters.bodyEvictions += 1;
  }

  private corrupt(key: string): void {
    this.counters.corruptions += 1;
    this.drop(key);
  }

  private drop(key: string): void {
    this.bodyLru.delete(key);
    const entry = this.cache.get(key);
    if (entry === undefined) return;
    this.cache.delete(key);
    this.cacheBytes -= entry.bytes;
    this.retainedChunks -= entry.chunks?.length ?? 0;
  }

  private admit(
    result: StreamResult,
    chunks: Buffer[] | null,
    chunkDigests: Buffer[] | null,
    bytes: number,
    work: StreamCounters,
  ): void {
    const { fields } = result;
    this.drop(fields.hash);
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
      this.counters.evictions += 1;
    }
    // The bytes were reserved while serialising; an entry evicted since then
    // only lowers cacheBytes, so this admission stays within the budget.
    if (this.cacheBytes + bytes > this.maxCacheBytes && !this.reserve(bytes)) return;
    const base = {
      hash: fields.hash,
      seq: fields.seq,
      kind: fields.kind,
      prev_hash: fields.prev_hash,
      fieldsDigest: fieldsDigest(fields, work),
      byteLength: result.byteLength,
      bodyDigest: result.bodyDigest,
    };
    const entry: CacheEntry = Object.freeze({
      ...base,
      chunks: chunks === null ? null : Object.freeze(chunks),
      chunkDigests: chunkDigests === null ? null : Object.freeze(chunkDigests),
      bytes,
      seal: sealOf(base, chunks?.length ?? 0),
    });
    this.cache.set(fields.hash, entry);
    if (chunks !== null) this.bodyLru.add(fields.hash);
    this.cacheBytes += bytes;
    this.retainedChunks += chunks?.length ?? 0;
    if (this.cacheBytes > this.peakCacheBytes) this.peakCacheBytes = this.cacheBytes;
  }
}
