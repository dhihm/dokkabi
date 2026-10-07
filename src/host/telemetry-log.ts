import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { canonicalJson } from "./canonical.ts";
import type { EventInput, EventRecord } from "./schema.ts";

/**
 * The ephemeral telemetry stream.
 *
 * `model/progress` and `host/sample` were ~70% of a live session's
 * hash-chained EventLog — 41k + 17k events in one 17-hour run — so every
 * projection walk and every observer verification paid for telemetry that is
 * pure live-board sugar, and the log grew without bound. They live here
 * instead: a sibling append-only file that is NOT hash-chained (nothing
 * downstream verifies a progress tick), carries the emit-time content seq for
 * ordering, and rotates under a byte cap because only the recent tail is ever
 * read. The authoritative content log keeps its chain, its real seq, and its
 * replay determinism; replay never reads this file.
 */

/** Beyond this the file is rotated down to the newest ROTATE_KEEP_BYTES. */
const ROTATE_MAX_BYTES = 4 * 1024 * 1024;
const ROTATE_KEEP_BYTES = 1024 * 1024;
/** Stat costs a syscall; only check every N appends. */
const ROTATE_CHECK_EVERY = 256;

/** The telemetry file paired with a content log path. */
export function telemetryPathFor(logPath: string): string {
  return `${logPath.replace(/\.jsonl$/u, "")}.telemetry.jsonl`;
}

export class TelemetryLog {
  readonly path: string;
  private sinceCheck = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** Append one telemetry record. `seq` is the content log's last seq at emit
   * time and `ts` the wall clock, both supplied by the caller so the board can
   * order telemetry against content without a chain. */
  append(input: EventInput, seq: number, ts: string): void {
    const record: EventRecord = {
      seq,
      ts,
      kind: input.kind,
      name: input.name,
      prev_hash: "",
      hash: "",
      payload: input.payload ?? {},
      ...(input.observe ? { observe: input.observe } : {}),
    };
    const line = `${canonicalJson(record)}\n`;
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "a");
      writeSync(fd, line);
    } catch {
      // Telemetry is best-effort: a failed progress tick must never block the
      // turn (the content log alone gates model requests).
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    this.sinceCheck += 1;
    if (this.sinceCheck >= ROTATE_CHECK_EVERY) {
      this.sinceCheck = 0;
      this.rotateIfNeeded();
    }
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size <= ROTATE_MAX_BYTES) return;
    try {
      const tail = readTailBytes(this.path, ROTATE_KEEP_BYTES);
      const firstNewline = tail.indexOf("\n");
      // Drop the partial leading line so every kept record is complete.
      const kept = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
      const tmp = `${this.path}.rot`;
      writeFileSync(tmp, kept);
      renameSync(tmp, this.path);
    } catch {
      // A failed rotation leaves the (large) file intact; correctness holds,
      // only the size cap slips until the next check.
    }
  }
}

/** Read the newest telemetry records, tolerant of a torn tail and rotation.
 * Returns at most `limit` records, oldest first. */
/**
 * An incremental reader for the telemetry tail.
 *
 * `readTelemetryTail` re-reads and re-parses the WHOLE tail every time it is
 * called, which the board does whenever the file has grown -- and a live run
 * writes telemetry continuously, so that was a 1.3MB buffer, a 1.3MB string
 * and four thousand fresh objects, ten times a second. Roughly 26MB of
 * garbage per second, which is why the board's memory swung by hundreds of
 * megabytes and why it hurt most where memory is tight.
 *
 * The file only appends between rotations, so bytes already parsed are never
 * read again. A file that SHRANK has rotated, and starts over.
 */
export class TelemetryTail {
  private readonly limit: number;
  private records: EventRecord[] = [];
  /** Bytes of complete lines already folded in. */
  private consumed = 0;
  /** A partial final line, held until its newline arrives. */
  private pending = "";

  constructor(readonly path: string, limit = 4000) {
    this.limit = limit;
  }

  read(): EventRecord[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return this.records;
    }
    if (size < this.consumed) {
      // Rotated: the bytes we counted are gone.
      this.records = [];
      this.consumed = 0;
      this.pending = "";
    }
    if (size === this.consumed) return this.records;
    const raw = readRange(this.path, this.consumed, size - this.consumed);
    this.consumed = size;
    const text = this.pending + raw;
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak < 0) {
      this.pending = text;
      return this.records;
    }
    this.pending = text.slice(lastBreak + 1);
    for (const line of text.slice(0, lastBreak).split("\n")) {
      if (!line || line.trim() === "") continue;
      try {
        this.records.push(JSON.parse(line) as EventRecord);
      } catch {
        // Debris — skip this line, keep the rest.
      }
    }
    if (this.records.length > this.limit) {
      this.records = this.records.slice(-this.limit);
    }
    return this.records;
  }
}

function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return "";
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readTelemetryTail(path: string, limit = 4000): EventRecord[] {
  if (!existsSync(path)) return [];
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  // Read enough bytes to cover the limit; the rotation cap bounds this anyway.
  const want = Math.min(size, ROTATE_KEEP_BYTES + ROTATE_KEEP_BYTES);
  const raw = readTailBytes(path, want);
  const out: EventRecord[] = [];
  const lines = raw.split("\n");
  // When the read began mid-file (the tail is larger than we asked for), the
  // first line is a partial record and is skipped; a full read from offset 0
  // keeps every line.
  const startedMidFile = want < size;
  for (let i = startedMidFile ? 1 : 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as EventRecord);
    } catch {
      // Debris — skip this line, keep the rest.
    }
  }
  return out.length > limit ? out.slice(-limit) : out;
}

function readTailBytes(path: string, length: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - length);
    const want = size - start;
    if (want <= 0) return "";
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(want);
    const read = readSync(fd, buffer, 0, want, start);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
