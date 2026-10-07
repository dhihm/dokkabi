/**
 * Bounded record explorer verification for workbench.record.index and
 * workbench.record.body (v1).
 *
 * The gateway describes exact retained rows by metadata and serves their
 * canonical UTF-8 bytes in ranges of at most 32 KiB. Nothing renders on the
 * gateway's word alone:
 * - An index page is held to the same pin/head/paging rules as the R5 page
 *   reader, and its descriptors must form the exact hash chain (seq +1,
 *   prev_hash linkage, genesis/after anchoring, row 1 = generation, the pin's
 *   own hash at its seq). Metadata cannot prove a row's content; it only
 *   names the bytes a body read must reproduce.
 * - A body range must answer exactly the requested row cursor, pin and
 *   offset, carry canonical base64 whose bytes match its own chunk digest,
 *   agree with the descriptor's length/digest, and describe its own end
 *   honestly. That is range integrity only — never a full-row proof, and no
 *   assumption about which member a range starts with: EventLog accepts
 *   further top-level keys and hashes `{...unsigned}`, so integer-like keys
 *   or keys such as `a`/`extra` legitimately sort before `hash`.
 * - `RecordBodyStreamVerifier` earns "exact" only after every range was
 *   consumed in order: the assembled SHA-256 equals the body digest AND the
 *   canonical bytes minus the top-level hash member hash to the row's event
 *   hash. A bounded top-level JSON lexer (depth, string/escape state and a
 *   few withheld separator/key bytes) finds that one member at depth 1,
 *   drops it with its separator, and requires it at its canonical position
 *   with the exact requested hash value; nested `hash` keys or strings are
 *   never touched. Once the member is removed the remaining bytes pass
 *   straight into the digests — no body is assembled, parsed or sorted.
 *
 * A violation is a contract error (the read fails closed); it is never
 * rendered, cached as success or downgraded to unsupported.
 *
 * @module provider/dokkabi/RecordExplorer
 */
import * as NodeCrypto from "node:crypto";

import {
  WORKBENCH_RECORD_BODY_MAX_BYTES,
  WORKBENCH_RECORD_VERIFY_MAX_BYTES,
} from "@t3tools/contracts";

import type { RecordBodyResponse, RecordIndexResponse } from "./WorkbenchProtocol.ts";
import { RECORD_GENESIS_HASH } from "./RecordChain.ts";

export const RECORD_BODY_MAX_BYTES = WORKBENCH_RECORD_BODY_MAX_BYTES;
export const RECORD_INDEX_DEFAULT_LIMIT = 50;
/** Largest row the streamed verifier will walk (2048 bounded ranges). */
export const RECORD_VERIFY_MAX_BYTES = WORKBENCH_RECORD_VERIFY_MAX_BYTES;

interface Cursor {
  readonly seq: number;
  readonly hash: string;
  readonly generation: string;
}
interface Pin extends Cursor {
  readonly sessionId: string;
}

const sameCursor = (left: Cursor, right: Cursor): boolean =>
  left.seq === right.seq && left.hash === right.hash && left.generation === right.generation;

/** Shared pin/head coherence: the pin is a prefix of the reported head. */
function pinHeadRefusal(asOf: Pin, head: Pin): string | null {
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
  return null;
}

/** The pin a response answers must be the requested one, exactly. */
function requestedPinRefusal(answered: Pin, requested: Pin): string | null {
  if (answered.sessionId !== requested.sessionId) {
    return `The gateway answered a pin for session '${answered.sessionId}' but the request pinned session '${requested.sessionId}'.`;
  }
  if (!sameCursor(answered, requested)) {
    return "The gateway answered a different asOf pin than the one requested; refusing instead of splicing.";
  }
  return null;
}

/** The smallest canonical row these descriptor fields can belong to: an
 * empty payload and no observe envelope, keys in canonical order. */
function minimalRowBytes(entry: RecordIndexResponse["entries"][number]): number {
  return Buffer.byteLength(
    JSON.stringify({
      hash: entry.hash,
      kind: entry.kind,
      name: entry.name,
      payload: {},
      prev_hash: entry.prev_hash,
      seq: entry.seq,
      ts: entry.ts,
    }),
    "utf8",
  );
}

/**
 * Verify one decoded metadata page against the request that produced it.
 * Returns null when the page is exact; otherwise the refusal reason.
 */
export function verifyRecordIndexRead(input: {
  readonly read: RecordIndexResponse;
  readonly after?: Cursor | undefined;
  readonly asOf?: Pin | undefined;
  readonly limit?: number | undefined;
}): string | null {
  const { read } = input;
  const head = read.sessionCursor;
  const asOf = read.asOf;
  const pinRefusal = pinHeadRefusal(asOf, head);
  if (pinRefusal !== null) return pinRefusal;
  if (input.asOf !== undefined) {
    const requested = requestedPinRefusal(asOf, input.asOf);
    if (requested !== null) return requested;
  } else if (asOf.seq !== head.seq || asOf.hash !== head.hash) {
    return `A live first index page must pin the current head (seq ${head.seq}); the gateway pinned seq ${asOf.seq}.`;
  }
  if (input.after !== undefined) {
    if (input.after.generation !== head.generation) {
      return "The requested after cursor names another generation of the session; refusing instead of splicing.";
    }
    if (input.after.seq > asOf.seq) {
      return `The requested after cursor (seq ${input.after.seq}) lies beyond the pinned prefix (${asOf.seq}).`;
    }
  }
  const limit = input.limit ?? RECORD_INDEX_DEFAULT_LIMIT;
  if (read.entries.length > limit) {
    return `The index carries ${read.entries.length} entries beyond the requested limit ${limit}.`;
  }
  if (read.total !== asOf.seq) {
    return `The index total (${read.total}) is not the pinned prefix's own seq (${asOf.seq}).`;
  }
  let previous: { seq: number; hash: string } | null =
    input.after !== undefined ? { seq: input.after.seq, hash: input.after.hash } : null;
  for (const entry of read.entries) {
    const expectedSeq = (previous?.seq ?? 0) + 1;
    if (entry.seq !== expectedSeq) {
      return `The index is not contiguous: expected seq ${expectedSeq}, received ${entry.seq}.`;
    }
    const expectedPrev =
      previous === null || previous.seq === 0 ? RECORD_GENESIS_HASH : previous.hash;
    if (entry.prev_hash !== expectedPrev) {
      return `The descriptor at seq ${entry.seq} does not continue the hash chain (prev_hash).`;
    }
    if (entry.seq === 1 && entry.hash !== head.generation) {
      return "The descriptor at seq 1 does not carry the session generation as its hash; another source's chain is never spliced onto this read.";
    }
    if (entry.seq > asOf.seq) {
      return `The descriptor at seq ${entry.seq} lies beyond the pinned prefix (${asOf.seq}).`;
    }
    if (entry.seq === asOf.seq && entry.hash !== asOf.hash) {
      return `The descriptor at the pinned seq ${asOf.seq} carries a different hash than the asOf pin.`;
    }
    if (entry.byteLength < minimalRowBytes(entry)) {
      return `The descriptor at seq ${entry.seq} claims ${entry.byteLength} canonical bytes, fewer than its own identity fields occupy.`;
    }
    previous = { seq: entry.seq, hash: entry.hash };
  }
  const last = read.entries.at(-1);
  if (read.hasMore) {
    if (last === undefined) {
      return "An empty index page claims more entries remain in the requested window.";
    }
    if (read.next === null || read.next.seq !== last.seq || read.next.hash !== last.hash) {
      return "The next cursor must be the last included entry when more entries remain.";
    }
    if (read.next.generation !== asOf.generation) {
      return "The next cursor names another generation of the session.";
    }
    if (last.seq >= asOf.seq) {
      return "The index claims more entries remain at or beyond its own pinned end.";
    }
  } else {
    if (read.next !== null) {
      return "A complete index page must not carry a next cursor.";
    }
    const end = last?.seq ?? input.after?.seq ?? 0;
    if (end !== asOf.seq) {
      return `A complete index page must end at the pinned prefix (seq ${asOf.seq}); it ended at ${end}.`;
    }
  }
  return null;
}

/** Canonical base64 only: the decoded bytes re-encode to the same text. */
export function decodeCanonicalBase64(data: string): Buffer | null {
  const bytes = Buffer.from(data, "base64");
  return bytes.toString("base64") === data ? bytes : null;
}

/**
 * Verify one decoded body range against its exact request and the index
 * descriptor. Returns the decoded bytes, or the refusal reason.
 */
export function verifyRecordBodyRange(input: {
  readonly read: RecordBodyResponse;
  readonly row: Cursor;
  readonly asOf: Pin;
  readonly offset: number;
  readonly limit?: number | undefined;
  readonly expected: { readonly byteLength: number; readonly bodyDigest: string };
}):
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: string } {
  const { read } = input;
  const fail = (reason: string) => ({ ok: false as const, reason });
  const requested = requestedPinRefusal(read.asOf, input.asOf);
  if (requested !== null) return fail(requested);
  const pinRefusal = pinHeadRefusal(read.asOf, read.sessionCursor);
  if (pinRefusal !== null) return fail(pinRefusal);
  if (!sameCursor(read.row, input.row)) {
    return fail(
      `The gateway answered row seq ${read.row.seq} for a request naming row seq ${input.row.seq}.`,
    );
  }
  if (input.row.generation !== input.asOf.generation) {
    return fail("The requested row names another generation than its pin.");
  }
  if (input.row.seq < 1 || input.row.seq > input.asOf.seq) {
    return fail(
      `The requested row seq ${input.row.seq} lies outside the pinned prefix (${input.asOf.seq}).`,
    );
  }
  if (input.row.seq === input.asOf.seq && input.row.hash !== input.asOf.hash) {
    return fail("The requested row at the pinned seq carries a different hash than the pin.");
  }
  if (input.row.seq === 1 && input.row.hash !== input.asOf.generation) {
    return fail("The row at seq 1 must carry the session generation as its hash.");
  }
  if (read.offset !== input.offset) {
    return fail(
      `The gateway answered offset ${read.offset} for a range requested at offset ${input.offset}.`,
    );
  }
  if (read.totalBytes !== input.expected.byteLength) {
    return fail(
      `The range reports ${read.totalBytes} canonical bytes but the row's descriptor names ${input.expected.byteLength}.`,
    );
  }
  if (read.bodyDigest !== input.expected.bodyDigest) {
    return fail("The range reports a body digest different from the row's descriptor.");
  }
  const bytes = decodeCanonicalBase64(read.data);
  if (bytes === null) {
    return fail("The range data is not canonical base64.");
  }
  const limit = input.limit ?? RECORD_BODY_MAX_BYTES;
  if (bytes.length > limit) {
    return fail(`The range carries ${bytes.length} bytes beyond the requested limit ${limit}.`);
  }
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== read.chunkDigest) {
    return fail("The range bytes do not match their own chunk digest.");
  }
  if (input.offset > read.totalBytes) {
    return fail(`Offset ${input.offset} lies beyond the ${read.totalBytes} byte canonical row.`);
  }
  const end = input.offset + bytes.length;
  if (end > read.totalBytes) {
    return fail("The range extends beyond the row's canonical length.");
  }
  if (end < read.totalBytes) {
    if (read.nextOffset !== end) {
      return fail(
        `The range's nextOffset (${String(read.nextOffset)}) is not its own end (${end}).`,
      );
    }
    if (bytes.length !== limit) {
      return fail(
        `A non-final range carries ${bytes.length} bytes instead of the requested ${limit}; its nextOffset cannot be trusted.`,
      );
    }
  } else if (read.nextOffset !== null) {
    return fail("The final range must carry a null nextOffset.");
  }
  return { ok: true, bytes };
}

// Bytes the top-level lexer reacts to; every other byte (including all
// UTF-8 lead/continuation bytes >= 0x80) is ordinary content.
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const HASH_KEY = [0x68, 0x61, 0x73, 0x68] as const; // "hash"
const SIMPLE_ESCAPES: Readonly<Record<number, number>> = {
  0x22: 0x22,
  0x5c: 0x5c,
  0x2f: 0x2f,
  0x62: 0x08,
  0x66: 0x0c,
  0x6e: 0x0a,
  0x72: 0x0d,
  0x74: 0x09,
};
const hexValue = (byte: number): number =>
  byte >= 0x30 && byte <= 0x39
    ? byte - 0x30
    : byte >= 0x61 && byte <= 0x66
      ? byte - 0x57
      : byte >= 0x41 && byte <= 0x46
        ? byte - 0x37
        : -1;

type LexPhase =
  | "open" // expecting the row's '{'
  | "firstKey" // after '{': a key's opening quote (or '}')
  | "keyStart" // after a top-level ',': a key's opening quote
  | "key" // inside a top-level key
  | "colon"
  | "value" // inside a top-level member value (any JSON, nested allowed)
  | "hashValue" // the removed member's exact `:"<event hash>"`
  | "afterHash" // the removed member's ',' or the row's '}'
  | "nextKeyStart"
  | "nextKey" // the key after the removed member: must sort after "hash"
  | "pass" // member removed and its successor checked: bytes pass through
  | "closed"; // the row's own '}' was consumed

/**
 * Incremental proof that consecutive ranges assemble exactly the row: the
 * full-body SHA-256 against the descriptor digest and the canonical
 * unsigned encoding against the row's event hash. Memory stays bounded by
 * the hash states and a lexer state of a few scalars plus at most six
 * withheld bytes (`,"hash`); no range is retained.
 *
 * The unsigned encoding is the canonical row without its top-level `hash`
 * member: the member and its following separator are dropped (or, if it
 * were the last member, its preceding separator), every other byte —
 * members before it, nested look-alikes, escapes — is hashed unchanged.
 * Because the remaining bytes must then be the exact SHA-256 preimage of
 * the event hash, the only freedom a forger keeps is where the member sits
 * and how its value is spelled; both are pinned here (canonical position
 * by UTF-16 key order, exact raw `"hash":"<requested hash>"` bytes).
 */
export class RecordBodyStreamVerifier {
  private readonly body = NodeCrypto.createHash("sha256");
  private readonly unsigned = NodeCrypto.createHash("sha256");
  private readonly rowHash: string;
  private readonly hashValue: Buffer;
  private readonly expected: { readonly byteLength: number; readonly bodyDigest: string };
  private position = 0;
  private chunkCount = 0;
  private refusal: string | null = null;

  // --- bounded lexer state ---
  private phase: LexPhase = "open";
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Separator/key bytes withheld while the key may still be `hash`. */
  private pending: number[] = [];
  private keyRawMatched = 0;
  private keyRawIsHash = true;
  private keyHadEscape = false;
  private keyUnits = 0;
  private keyOrder: -1 | 0 | 1 = 0;
  /** -1: no escape; 0: after '\'; 1..4: \u hex digits collected. */
  private keyEscape = -1;
  private keyEscapeValue = 0;
  private previousKeyOrder: -1 | 1 | null = null;
  private hashValueMatched = 0;
  private hashHadSeparator = false;
  private sawHash = false;

  constructor(
    rowHash: string,
    expected: { readonly byteLength: number; readonly bodyDigest: string },
  ) {
    this.rowHash = rowHash;
    this.expected = expected;
    this.hashValue = Buffer.from(`:"${rowHash}"`, "utf8");
  }

  /** The next expected offset. */
  get offset(): number {
    return this.position;
  }

  get chunks(): number {
    return this.chunkCount;
  }

  /** Consume the range starting at the current offset; returns a refusal. */
  update(offset: number, bytes: Uint8Array): string | null {
    if (this.refusal !== null) return this.refusal;
    if (offset !== this.position) {
      return `The streamed verification expected offset ${this.position}, received ${offset}.`;
    }
    if (this.position + bytes.length > this.expected.byteLength) {
      return "The streamed ranges exceed the descriptor's canonical length.";
    }
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.body.update(view);
    const refusal = this.lex(view);
    if (refusal !== null) {
      this.refusal = refusal;
      return refusal;
    }
    this.position += view.length;
    this.chunkCount += 1;
    return null;
  }

  /** Close the stream; null means the row is exactly verified. */
  finish(): string | null {
    if (this.refusal !== null) return this.refusal;
    if (this.position !== this.expected.byteLength) {
      return `The streamed verification ended at ${this.position} of ${this.expected.byteLength} bytes.`;
    }
    if (this.body.digest("hex") !== this.expected.bodyDigest) {
      return "The assembled canonical bytes do not match the descriptor's body digest.";
    }
    if (!this.sawHash) {
      return "The canonical bytes carry no top-level hash member; the row is not exact.";
    }
    if (this.phase !== "pass" && this.phase !== "closed") {
      return "The canonical bytes end inside the row's top-level structure.";
    }
    if (this.unsigned.digest("hex") !== this.rowHash) {
      return "The assembled canonical bytes do not hash to the row's own event hash; the row is not exact.";
    }
    return null;
  }

  private resetKey(): void {
    this.keyRawMatched = 0;
    this.keyRawIsHash = true;
    this.keyHadEscape = false;
    this.keyUnits = 0;
    this.keyOrder = 0;
    this.keyEscape = -1;
    this.keyEscapeValue = 0;
  }

  /** Compare one decoded key code unit with "hash" (UTF-16 order). */
  private keyUnit(unit: number): void {
    if (this.keyOrder !== 0) return;
    if (this.keyUnits >= HASH_KEY.length) {
      this.keyOrder = 1;
      return;
    }
    const expected = HASH_KEY[this.keyUnits]!;
    if (unit < expected) this.keyOrder = -1;
    else if (unit > expected) this.keyOrder = 1;
    else this.keyUnits += 1;
  }

  /** One key byte (not the closing quote); returns a refusal. */
  private keyByte(byte: number): string | null {
    if (this.keyEscape === 0) {
      if (byte === 0x75) {
        this.keyEscape = 1;
        this.keyEscapeValue = 0;
        return null;
      }
      const unit = SIMPLE_ESCAPES[byte];
      if (unit === undefined)
        return "The canonical bytes carry an invalid escape in a top-level key.";
      this.keyEscape = -1;
      this.keyUnit(unit);
      return null;
    }
    if (this.keyEscape > 0) {
      const digit = hexValue(byte);
      if (digit < 0) return "The canonical bytes carry an invalid escape in a top-level key.";
      this.keyEscapeValue = this.keyEscapeValue * 16 + digit;
      this.keyEscape += 1;
      if (this.keyEscape === 5) {
        this.keyEscape = -1;
        this.keyUnit(this.keyEscapeValue);
      }
      return null;
    }
    if (byte === BACKSLASH) {
      this.keyEscape = 0;
      this.keyHadEscape = true;
      this.keyRawIsHash = false;
      return null;
    }
    // A UTF-8 lead byte starts a code unit >= 0x80, above every "hash" unit;
    // continuation bytes no longer change a decided order.
    this.keyUnit(byte);
    if (
      this.keyRawIsHash &&
      this.keyRawMatched < HASH_KEY.length &&
      byte === HASH_KEY[this.keyRawMatched]
    ) {
      this.keyRawMatched += 1;
    } else {
      this.keyRawIsHash = false;
    }
    return null;
  }

  /** The key's final order relative to "hash" once its quote closed. */
  private closedKeyOrder(): -1 | 0 | 1 {
    if (this.keyOrder !== 0) return this.keyOrder;
    return this.keyUnits === HASH_KEY.length ? 0 : -1;
  }

  private lex(view: Buffer): string | null {
    let emitFrom = 0;
    const emitUntil = (index: number) => {
      if (index > emitFrom) this.unsigned.update(view.subarray(emitFrom, index));
      emitFrom = index;
    };
    for (let index = 0; index < view.length; index += 1) {
      const byte = view[index]!;
      switch (this.phase) {
        case "open":
          if (byte !== OPEN_OBJECT) return "The canonical bytes do not begin a JSON object.";
          this.phase = "firstKey";
          break;
        case "firstKey":
        case "keyStart":
          if (byte === CLOSE_OBJECT && this.phase === "firstKey") {
            this.phase = "closed";
            break;
          }
          if (byte !== QUOTE) return "The canonical bytes carry a non-canonical top-level member.";
          emitUntil(index);
          this.pending.push(byte);
          emitFrom = index + 1;
          this.resetKey();
          this.phase = "key";
          break;
        case "key": {
          const withholding = this.pending.length > 0;
          if (byte === QUOTE && this.keyEscape < 0) {
            const order = this.closedKeyOrder();
            const isHashMember = this.keyRawIsHash && this.keyRawMatched === HASH_KEY.length;
            if (order === 0 && !isHashMember) {
              return "The canonical bytes spell a top-level hash key non-canonically.";
            }
            if (isHashMember) {
              if (this.sawHash) return "The canonical bytes carry a second top-level hash member.";
              if (this.previousKeyOrder === 1) {
                return "The top-level hash member is not at its canonical position.";
              }
              this.hashHadSeparator = this.pending[0] === COMMA;
              this.pending = [];
              emitFrom = index + 1;
              this.hashValueMatched = 0;
              this.phase = "hashValue";
              break;
            }
            if (order === 1 && !this.sawHash) {
              return "A top-level member that sorts after hash precedes the hash member; the row is not canonical.";
            }
            this.previousKeyOrder = order === -1 ? -1 : 1;
            if (withholding) {
              this.unsigned.update(Buffer.from(this.pending));
              this.pending = [];
              emitFrom = index;
            }
            this.phase = "colon";
            break;
          }
          const refusal = this.keyByte(byte);
          if (refusal !== null) return refusal;
          if (withholding) {
            if (this.keyRawIsHash) {
              this.pending.push(byte);
              emitFrom = index + 1;
            } else {
              this.unsigned.update(Buffer.from(this.pending));
              this.pending = [];
              emitFrom = index;
            }
          }
          break;
        }
        case "colon":
          if (byte !== COLON) return "The canonical bytes carry a non-canonical top-level member.";
          this.depth = 0;
          this.inString = false;
          this.escaped = false;
          this.phase = "value";
          break;
        case "value":
          if (this.inString) {
            if (this.escaped) this.escaped = false;
            else if (byte === BACKSLASH) this.escaped = true;
            else if (byte === QUOTE) this.inString = false;
            break;
          }
          if (byte === QUOTE) this.inString = true;
          else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) this.depth += 1;
          else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
            if (this.depth > 0) this.depth -= 1;
            else if (byte === CLOSE_OBJECT) this.phase = "closed";
            else return "The canonical bytes close an array that was never opened.";
          } else if (byte === COMMA && this.depth === 0) {
            emitUntil(index);
            this.pending = [byte];
            emitFrom = index + 1;
            this.phase = "keyStart";
          }
          break;
        case "hashValue":
          if (byte !== this.hashValue[this.hashValueMatched]) {
            return "The top-level hash member does not carry the requested row's event hash.";
          }
          this.hashValueMatched += 1;
          emitFrom = index + 1;
          if (this.hashValueMatched === this.hashValue.length) this.phase = "afterHash";
          break;
        case "afterHash":
          this.sawHash = true;
          if (byte === COMMA) {
            // Keep the separator before the member (if any), drop its own.
            if (this.hashHadSeparator) this.unsigned.update(Buffer.from([COMMA]));
            emitFrom = index + 1;
            this.phase = "nextKeyStart";
          } else if (byte === CLOSE_OBJECT) {
            // The last member: its preceding separator was withheld and is dropped.
            emitFrom = index;
            this.phase = "closed";
          } else {
            return "The canonical bytes carry a non-canonical top-level member.";
          }
          break;
        case "nextKeyStart":
          if (byte !== QUOTE) return "The canonical bytes carry a non-canonical top-level member.";
          this.resetKey();
          this.phase = "nextKey";
          break;
        case "nextKey":
          if (byte === QUOTE && this.keyEscape < 0) {
            if (this.closedKeyOrder() !== 1) {
              return "The top-level hash member is not at its canonical position.";
            }
            // Everything after is the unsigned remainder: no further lexing.
            this.phase = "pass";
            emitUntil(view.length);
            return null;
          } else {
            const refusal = this.keyByte(byte);
            if (refusal !== null) return refusal;
          }
          break;
        case "pass":
          emitUntil(view.length);
          return null;
        case "closed":
          return "The canonical bytes continue after the row's closing brace.";
      }
    }
    emitUntil(view.length);
    return null;
  }
}
