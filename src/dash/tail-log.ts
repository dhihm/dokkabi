import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { canonicalJson } from "../host/canonical.ts";
import { EVENT_KIND, GENESIS_HASH, isEventKind, type EventRecord } from "../host/schema.ts";

/**
 * Incremental EventLog reader for the observer board.
 *
 * `EventLog` re-parses and re-verifies the whole file on every construction:
 * a 1150-event session costs ~19ms, and the board asks for a frame several
 * times a second, so the paint budget is spent on records that have not
 * changed since the last frame.
 *
 * `TailLog` keeps the verified prefix in memory and reads only the bytes that
 * were appended since the last poll. Verification is not relaxed —
 * constitution 5 needs `record` and `replay` to agree on the hash sequence,
 * so every new record is still seq-checked, chain-checked and hash-recomputed,
 * continuing from the last verified record. Anything that invalidates the
 * prefix (a shorter file, a rewritten head) falls back to a full reload.
 *
 * Read-only by construction: the observer never repairs a torn tail (that is
 * the writer's job under the lock) and never appends.
 */
export class TailLog {
  readonly path: string;
  private records: EventRecord[] = [];
  /** Bytes of complete, verified lines already folded into `records`. */
  private consumedBytes = 0;
  /** Records parsed from disk over this reader's lifetime — a test probe. */
  private parsed = 0;
  /** Byte offset of each record, for reading a released payload back. */
  private offsets: number[] = [];
  /** How many of the newest records keep their display payload. */
  private readonly keepFull: number;
  /** Records already released; they only ever age out, never back in. */
  private releasedUpto = 0;

  /**
   * `keepFull` is how many of the newest records keep their display payload.
   *
   * The default keeps everything, because a reader that loses text silently is
   * worse than one that costs memory: the desktop transcript renders the whole
   * session and would come back blank. A caller that renders only a tail --
   * the board -- says so.
   */
  constructor(path: string, keepFull = Number.POSITIVE_INFINITY, private readonly maxBytes = Number.POSITIVE_INFINITY) {
    this.path = path;
    this.keepFull = keepFull;
  }

  /**
   * The full record at an index, read back from disk if its payload was let go.
   *
   * The board keeps every record it has ever parsed, because the projection is
   * a function of the whole log. What it does NOT need is every record's TEXT:
   * `text`, `thinking`, `args` and `raw` are read only for the newest records
   * -- the four helpers that touch them all scan backwards or take a limit --
   * and the stream pane renders a tail. They were 33.7MB of an 89MB log,
   * resident for the whole run, unreadable by anything.
   *
   * So beyond the window they are released, and this reads one line back when
   * the operator scrolls past it. The file is append-only: the bytes at that
   * offset are the same bytes that were parsed.
   */
  hydrate(index: number): EventRecord | undefined {
    const record = this.records[index];
    if (!record) return undefined;
    if ((record as { __slim?: true }).__slim !== true) return record;
    const start = this.offsets[index];
    if (start === undefined) return record;
    const end = this.offsets[index + 1] ?? this.consumedBytes;
    const raw = readFrom(this.path, start, Math.max(0, end - start));
    const line = raw.split("\n", 1)[0] ?? "";
    try {
      return JSON.parse(line) as EventRecord;
    } catch {
      return record;
    }
  }

  /** How many records this reader has parsed since it was created. */
  get parsedCount(): number {
    return this.parsed;
  }

  get events(): readonly EventRecord[] {
    return this.records;
  }

  /**
   * Fold whatever is new on disk into the in-memory prefix.
   * `changed` is false when the file did not move — the caller can then skip
   * the projection and the paint entirely.
   */
  poll(): { events: readonly EventRecord[]; changed: boolean } {
    const size = fileSize(this.path);
    if (size > this.maxBytes) throw new Error("dashboard log byte limit exceeded");
    if (size < 0) {
      // The session log is not there yet. An observer may open before the
      // watched run writes its first event; that is empty, not an error.
      const had = this.records.length > 0;
      this.records = [];
      this.offsets = [];
      this.releasedUpto = 0;
      this.consumedBytes = 0;
      return { events: this.records, changed: had };
    }
    if (size === this.consumedBytes) {
      return { events: this.records, changed: false };
    }
    if (size < this.consumedBytes) {
      // The file shrank: this is a different log on the same path (a session
      // rolled over, a replay fixture was rewritten). The prefix is void.
      return { events: this.reload(), changed: true };
    }
    const chunk = readFrom(this.path, this.consumedBytes, size - this.consumedBytes);
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline < 0) {
      // Only a partial line so far — a writer mid-append. Nothing to fold.
      return { events: this.records, changed: false };
    }
    const complete = chunk.slice(0, lastNewline + 1);
    const before = this.records.length;
    try {
      this.foldLines(complete);
    } catch (error) {
      // A chain break against our prefix can mean the head was rewritten
      // under us rather than the log being corrupt. Re-verify from scratch
      // once; a genuine corruption throws again from the full read.
      if (this.records.length !== before) {
        this.records.length = before;
      }
      const reloaded = this.reload();
      if (error instanceof ChainMismatch) {
        return { events: reloaded, changed: true };
      }
      throw error;
    }
    this.consumedBytes += Buffer.byteLength(complete, "utf8");
    this.release();
    return { events: this.records, changed: this.records.length !== before };
  }

  /**
   * Let go of the display payload on everything past the window.
   *
   * A cursor, not a scan: records only ever age out of the window, so the work
   * is the few that crossed it since the last poll.
   */
  private release(): void {
    const upto = this.records.length - this.keepFull;
    for (; this.releasedUpto < upto; this.releasedUpto += 1) {
      const record = this.records[this.releasedUpto]!;
      for (const field of RELEASED_FIELDS) {
        if (record.payload[field] !== undefined) {
          delete (record.payload as Record<string, unknown>)[field];
        }
      }
      // Marked either way: the mark says "ask disk", not "was big".
      (record as { __slim?: true }).__slim = true;
    }
  }

  private reload(): readonly EventRecord[] {
    this.records = [];
    this.offsets = [];
    this.releasedUpto = 0;
    this.consumedBytes = 0;
    if (!existsSync(this.path)) {
      return this.records;
    }
    const size = fileSize(this.path);
    if (size > this.maxBytes) throw new Error("dashboard log byte limit exceeded");
    const raw = readFrom(this.path, 0, Math.max(0, size));
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline < 0) {
      return this.records;
    }
    const complete = raw.slice(0, lastNewline + 1);
    this.foldLines(complete, { fresh: true });
    this.consumedBytes = Buffer.byteLength(complete, "utf8");
    return this.records;
  }

  /** Verify and append every complete line in `text` to the prefix. */
  private foldLines(text: string, opts: { fresh?: boolean } = {}): void {
    let expectedPrev = this.records.at(-1)?.hash ?? GENESIS_HASH;
    let expectedSeq = (this.records.at(-1)?.seq ?? 0) + 1;
    const lines = text.split("\n");
    // Where each record starts in the file, so a released payload can be read
    // back for the one record that needs it rather than kept for all of them.
    let at = opts.fresh ? 0 : this.consumedBytes;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      const start = at;
      at += lineBytes;
      if (line.trim() === "") {
        continue;
      }
      let parsed: EventRecord;
      try {
        parsed = JSON.parse(line) as EventRecord;
      } catch (error) {
        // Trailing debris after the last complete record: tolerated on read,
        // exactly as EventLog does. Anything earlier is real corruption.
        if (lines.slice(i + 1).every((row) => row.trim() === "")) {
          return;
        }
        throw error;
      }
      if (!isEventKind(parsed.kind) || !EVENT_KIND.includes(parsed.kind)) {
        throw new Error(`corrupt log: bad kind at seq ${parsed.seq}`);
      }
      if (parsed.seq !== expectedSeq) {
        throw opts.fresh
          ? new Error(`corrupt log: seq ${parsed.seq} expected ${expectedSeq}`)
          : new ChainMismatch(`corrupt log: seq ${parsed.seq} expected ${expectedSeq}`);
      }
      if (parsed.prev_hash !== expectedPrev) {
        throw opts.fresh
          ? new Error(`corrupt log: hash chain break at seq ${parsed.seq}`)
          : new ChainMismatch(`corrupt log: hash chain break at seq ${parsed.seq}`);
      }
      const { hash, ...unsigned } = parsed;
      if (sha256Hex(canonicalJson(unsigned)) !== hash) {
        throw new Error(`corrupt log: hash mismatch at seq ${parsed.seq}`);
      }
      this.records.push(parsed);
      this.offsets.push(start);
      this.parsed += 1;
      expectedPrev = parsed.hash;
      expectedSeq += 1;
    }
  }
}

/**
 * What the board asks for.
 *
 * The stream pane widens to at most 120 turns, which is a few thousand records
 * at most, so this is far past anything it can draw -- and `hydrate` reads a
 * line back if that ever stops being true.
 */
export const BOARD_KEEP_FULL_RECORDS = 8_000;

/** Payload fields nothing reads except the render of a recent record. */
const RELEASED_FIELDS = ["text", "thinking", "args", "raw"] as const;

/** A break measured against our own prefix — retryable with a full reload. */
class ChainMismatch extends Error {}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** Read `length` bytes at `start`. Reading the tail must not pull the head. */
function readFrom(path: string, start: number, length: number): string {
  if (length <= 0) {
    return "";
  }
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
