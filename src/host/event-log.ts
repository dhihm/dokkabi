import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { assertNoSecrets, SecretRejectedError } from "./redact.ts";
import { TelemetryLog, telemetryPathFor } from "./telemetry-log.ts";
import { noteAppendedRows } from "./invocation-scope.ts";
import {
  assertEventName,
  EVENT_KIND,
  type EventInput,
  type EventKind,
  type EventRecord,
  GENESIS_HASH,
  isEventKind,
  type ObserveFields,
} from "./schema.ts";

const durableReceiptBrand = Symbol("dokkabi.durable-tool-call");

export interface DurableToolCallReceipt {
  readonly [durableReceiptBrand]: true;
}

function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

export class AppendRejectedError extends Error {
  readonly code = "append_rejected" as const;

  constructor(message: string) {
    super(message);
    this.name = "AppendRejectedError";
  }
}

export interface EventLogOptions {
  readOnly?: boolean;
  /** Optional writer ceiling over the exact UTF-8 content log bytes. */
  maxBytes?: number;
}
function validateMaxBytes(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    throw new RangeError("EventLog maxBytes must be a positive safe integer");
}

export class EventLog {
  readonly path: string;
  private readonly readOnly: boolean;
  private readonly maxBytes: number | undefined;
  private readonly records: EventRecord[] = [];
  private appendFailed = false;
  private knownSize = 0;
  private reloads = 0;
  private readonly durableToolCalls = new WeakMap<DurableToolCallReceipt, EventRecord>();

  constructor(path: string, options: EventLogOptions = {}) {
    validateMaxBytes(options.maxBytes);
    this.path = path;
    this.readOnly = options.readOnly === true;
    this.maxBytes = options.maxBytes;
    if (existsSync(path)) {
      this.loadExisting();
    }
  }

  static create(path: string, options: EventLogOptions = {}): EventLog {
    validateMaxBytes(options.maxBytes);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return new EventLog(path, options);
  }

  /** Re-read the file. Needed when another process (dash vs turn) also appends. */
  refresh(): void {
    this.records.length = 0;
    this.tornTailBytes = 0;
    if (existsSync(this.path)) {
      this.loadExisting();
      this.reloads += 1;
    } else {
      this.knownSize = 0;
    }
  }

  /** How many times the log was re-read from disk (0 for an uncontended writer). */
  get reloadCount(): number {
    return this.reloads;
  }

  /** True when this handle must not append (dash / replay). */
  get isReadOnly(): boolean {
    return this.readOnly;
  }

  get events(): readonly EventRecord[] {
    return this.records;
  }

  get lastHash(): string {
    return this.records.at(-1)?.hash ?? GENESIS_HASH;
  }

  get lastSeq(): number {
    return this.records.at(-1)?.seq ?? 0;
  }

  /** Constitution 1: a failed append blocks every model request. */
  get canRequestModel(): boolean {
    return !this.appendFailed;
  }

  assertCanRequestModel(): void {
    if (!this.canRequestModel) {
      throw new AppendRejectedError("model request refused: last EventLog append failed");
    }
  }

  private tornTailBytes = 0;
  private telemetry: TelemetryLog | undefined;

  /**
   * Append ephemeral telemetry (model/progress, host/sample) to the sibling
   * telemetry stream instead of the hash-chained content log. Stamped with the
   * current content seq and wall clock so the board can order it against
   * content without a chain. A read-only handle (dash/replay) drops it — only
   * the writer records telemetry. Never blocks a model request.
   */
  appendTelemetry(input: EventInput): void {
    if (this.readOnly) return;
    // Same secret boundary as the content log, but drop-on-detect instead of
    // throw: a tainted heartbeat is discarded, never leaked and never fatal to
    // the turn (telemetry is best-effort). Emitters still scrub upstream; this
    // is the backstop that keeps every derived surface guarded (#61).
    try {
      assertNoSecrets({ payload: input.payload ?? {}, observe: input.observe, name: input.name });
    } catch {
      return;
    }
    if (!this.telemetry) {
      this.telemetry = new TelemetryLog(telemetryPathFor(this.path));
    }
    this.telemetry.append(input, this.lastSeq, input.ts ?? new Date().toISOString());
  }

  append(input: EventInput): EventRecord {
    const record = this.appendBatch(() => [input])[0];
    if (!record) throw new AppendRejectedError("event log append produced no record");
    return record;
  }

  appendDurable(input: EventInput): EventRecord {
    const record = this.appendBatchDurable(() => [input])[0];
    if (!record) throw new AppendRejectedError("durable event log append produced no record");
    return record;
  }

  appendDurableToolCall(payload: Record<string, unknown>): DurableToolCallReceipt {
    const record = this.appendDurable({ kind: "observe", name: "tool/call", payload });
    const receipt = Object.freeze<DurableToolCallReceipt>({ [durableReceiptBrand]: true });
    this.durableToolCalls.set(receipt, record);
    return receipt;
  }

  consumeDurableToolCall(receipt: DurableToolCallReceipt): EventRecord | undefined {
    const record = this.durableToolCalls.get(receipt);
    this.durableToolCalls.delete(receipt);
    return record;
  }

  appendBatch(buildInputs: (nextSeq: number) => readonly EventInput[]): readonly EventRecord[] {
    return this.appendBatchInternal(buildInputs, false);
  }

  appendBatchDurable(buildInputs: (nextSeq: number) => readonly EventInput[]): readonly EventRecord[] {
    return this.appendBatchInternal(buildInputs, true);
  }

  /** A host projection can insert evidence immediately before its action.
   * It sees preceding rows in the same locked transaction, including hashes.
   * A projection or durable write failure publishes none of the batch. */
  appendProjectedBatchDurable(
    buildInputs: (nextSeq: number) => readonly EventInput[],
    project: (input: EventInput, prefix: readonly EventRecord[]) => readonly EventInput[],
  ): readonly EventRecord[] {
    return this.appendBatchInternal(buildInputs, true, project);
  }

  private appendBatchInternal(
    buildInputs: (nextSeq: number) => readonly EventInput[],
    durable: boolean,
    project?: (input: EventInput, prefix: readonly EventRecord[]) => readonly EventInput[],
  ): readonly EventRecord[] {
    if (this.readOnly) {
      if (durable) throw new AppendRejectedError("durable append refused on read-only EventLog");
      // An observer (the dashboard) never mutates the observed world: the
      // record exists for its own pane only and never reaches the disk, so a
      // board can pin no mtime and race no run.
      const records = this.buildRecords(buildInputs(this.lastSeq + 1));
      this.records.push(...records);
      return records;
    }
    try {
      return withLogLock(this.path, () => {
        // Byte length alone is not a concurrency token. A stale writer can
        // observe a size that happens to equal its cache while its seq/hash
        // head is older (the live dashboard + HEUNG fork of 2026-08-23).
        // Verify the durable tail under the cross-process lock. Ordinary
        // extensions ingest only their suffix; shrinkage or head replacement
        // remains an exceptional full-chain verification.
        const durableHead = readDurableHead(this.path);
        this.catchUpTo(durableHead);
        if (this.maxBytes === undefined && this.tornTailBytes > 0) {
          // Preserve the existing unbounded writer's prefix recovery, even
          // for an empty batch. Bounded writers defer it until quota passes.
          const fd = openSync(this.path, "r+");
          try { ftruncateSync(fd, currentSize(this.path) - this.tornTailBytes); }
          finally { closeSync(fd); }
          this.tornTailBytes = 0;
          this.knownSize = currentSize(this.path);
        }
        const records = this.buildRecords(buildInputs(this.lastSeq + 1), project);
        if (records.length === 0) return records;
        this.persist(records, durable);
        this.records.push(...records);
        this.knownSize = currentSize(this.path);
        this.appendFailed = false;
        // #227 CG-02: attribute the rows to the tool invocation whose scope
        // appended them (host/invocation-scope.ts); a no-op outside one.
        noteAppendedRows(this, records);
        return records;
      });
    } catch (error) {
      this.appendFailed = true;
      if (error instanceof SecretRejectedError || error instanceof AppendRejectedError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AppendRejectedError(message);
    }
  }

  private buildRecords(inputs: readonly EventInput[],
    project?: (input: EventInput, prefix: readonly EventRecord[]) => readonly EventInput[]): EventRecord[] {
    const records: EventRecord[] = [];
    let previous = this.records.at(-1);
    for (const input of inputs) {
      for (const expanded of project ? project(input, [...this.records, ...records]) : [input]) {
        const record = this.buildRecord(expanded, previous);
        records.push(record);
        previous = record;
      }
    }
    return records;
  }

  private buildRecord(input: EventInput, previous = this.records.at(-1)): EventRecord {
    if (!isEventKind(input.kind)) {
      throw new AppendRejectedError(`unknown kind ${String(input.kind)}`);
    }
    assertEventName(input.name);
    const payload = input.payload ?? {};
    const observe = normalizeObserve(input.kind, input.name, input.observe, payload);
    assertNoSecrets({ payload, observe, name: input.name });
    forbidCacheField(observe, payload);

    const seq = (previous?.seq ?? 0) + 1;
    const ts = input.ts ?? new Date().toISOString();
    const prev_hash = previous?.hash ?? GENESIS_HASH;
    const unsigned = {
      seq,
      ts,
      kind: input.kind,
      name: input.name,
      prev_hash,
      payload,
      ...(observe ? { observe } : {}),
    };
    const hash = sha256Hex(canonicalJson(unsigned));
    return { ...unsigned, hash };
  }

  private persist(records: readonly EventRecord[], durable: boolean): void {
    const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const bytes = Buffer.byteLength(text, "utf8");
    // An impossible first batch must not even create an empty log file.
    if (this.maxBytes !== undefined && bytes > this.maxBytes)
      throw new AppendRejectedError("event log byte budget exceeded");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const existed = existsSync(this.path);
    const fd = openSync(this.path, "a", 0o600);
    try {
      const size = fstatSync(fd).size;
      if (this.maxBytes !== undefined && (size > this.maxBytes || bytes > this.maxBytes - size))
        throw new AppendRejectedError("event log byte budget exceeded");
      // We still hold the append lock. Quota refusal above must preserve
      // even torn bytes; successful writes may recover the complete prefix.
      if (this.tornTailBytes > 0) {
        ftruncateSync(fd, size - this.tornTailBytes);
        this.tornTailBytes = 0;
      }
      appendFileSync(fd, text);
      if (durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (durable && !existed) {
      const directory = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }

  private loadExisting(): void {
    const raw = readFileSync(this.path, "utf8");
    // A torn tail (writer crashed mid-append) is tolerated on read: the
    // complete prefix is the truth; append() repairs the debris under the lock.
    const lastNewline = raw.lastIndexOf("\n");
    if (lastNewline !== raw.length - 1) {
      this.tornTailBytes = Buffer.byteLength(raw.slice(lastNewline + 1), "utf8");
    } else {
      this.tornTailBytes = 0;
    }
    const text = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "";
    this.knownSize = Buffer.byteLength(text, "utf8");
    this.appendVerifiedText(text);
  }

  /** Extend an already verified prefix without hashing it again. */
  private catchUpTo(durable: DurableHead): void {
    this.tornTailBytes = durable.tornTailBytes;
    if (
      durable.completeSize === this.knownSize
      && durable.seq === this.lastSeq
      && durable.hash === this.lastHash
    ) {
      return;
    }

    if (durable.completeSize > this.knownSize) {
      const previousLength = this.records.length;
      const suffix = readFileRange(this.path, this.knownSize, durable.completeSize);
      try {
        this.appendVerifiedText(suffix);
      } catch (error) {
        this.records.length = previousLength;
        throw error;
      }
      if (this.lastSeq !== durable.seq || this.lastHash !== durable.hash) {
        this.records.length = previousLength;
        throw new Error("corrupt log: verified suffix does not reach durable head");
      }
      this.knownSize = durable.completeSize;
      return;
    }

    // Shrinkage or a same-size head replacement is exceptional. Re-verify the
    // complete file rather than treating byte length as a concurrency token.
    this.refresh();
    if (
      this.knownSize !== durable.completeSize
      || this.lastSeq !== durable.seq
      || this.lastHash !== durable.hash
    ) {
      throw new Error("corrupt log: durable head changed while append lock was held");
    }
  }

  private appendVerifiedText(text: string): void {
    if (text.trim() === "") {
      return;
    }
    let expectedPrev = this.lastHash;
    let expectedSeq = this.lastSeq + 1;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "") {
        continue;
      }
      let parsed: EventRecord;
      try {
        parsed = JSON.parse(line) as EventRecord;
      } catch (error) {
        const tail = lines.slice(i + 1).every((row) => row.trim() === "");
        if (tail) {
          return;
        }
        throw error;
      }
      if (!isEventKind(parsed.kind) || !EVENT_KIND.includes(parsed.kind)) {
        throw new Error(`corrupt log: bad kind at seq ${parsed.seq}`);
      }
      if (parsed.seq !== expectedSeq) {
        throw new Error(`corrupt log: seq ${parsed.seq} expected ${expectedSeq}`);
      }
      if (parsed.prev_hash !== expectedPrev) {
        throw new Error(`corrupt log: hash chain break at seq ${parsed.seq}`);
      }
      const { hash, ...unsigned } = parsed;
      const recomputed = sha256Hex(canonicalJson(unsigned));
      if (recomputed !== hash) {
        throw new Error(`corrupt log: hash mismatch at seq ${parsed.seq}`);
      }
      this.records.push(parsed);
      expectedPrev = parsed.hash;
      expectedSeq += 1;
    }
  }
}

/** Read a quiescent snapshot under the same lock as durable append. */
export function withEventLogSnapshot<T>(path: string, fn: () => T): T {
  return withLogLock(path, fn);
}

function withLogLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2000;
  while (true) {
    let owner: LockOwner | undefined;
    try {
      // mkdir is one atomic namespace operation on local and network filesystems.
      // Keeping the historical .lock name also excludes older file-lock writers
      // during a rolling deployment: open("wx") and mkdir both see EEXIST.
      mkdirSync(lockPath, { mode: 0o700 });
      owner = writeLockOwner(lockPath);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (reclaimAbandonedLock(lockPath)) {
        continue;
      }
      if (Date.now() > deadline) {
        throw new AppendRejectedError("event log lock timeout");
      }
      Bun.sleepSync(5);
      continue;
    }
    try {
      return fn();
    } finally {
      releaseOwnedLock(lockPath, owner);
    }
  }
}

interface LockOwner {
  version: 1;
  pid: number;
  process_start: string;
  nonce: string;
  acquired_at: number;
}

const LOCK_OWNER_FILE = "owner.json";
const LEGACY_LOCK_GRACE_MS = 30_000;

function writeLockOwner(lockPath: string): LockOwner {
  const owner: LockOwner = {
    version: 1,
    pid: process.pid,
    process_start: processStartIdentity(process.pid) ?? "unavailable",
    nonce: randomUUID(),
    acquired_at: Date.now(),
  };
  try {
    writeFileSync(join(lockPath, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return owner;
  } catch (error) {
    // We created this directory and no append can start before owner metadata
    // is durable. A failed initialization is therefore safe to roll back.
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function releaseOwnedLock(lockPath: string, owner: LockOwner | undefined): void {
  if (!owner) return;
  const durableOwner = readLockOwner(lockPath);
  if (durableOwner?.nonce !== owner.nonce) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // The append result is already durable. A leftover owned lock is recovered
    // by a later writer only after this process can be proven dead.
  }
}

function reclaimAbandonedLock(lockPath: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return true;
    throw error;
  }

  const owner = stat.isDirectory() ? readLockOwner(lockPath) : undefined;
  const legacyStale = owner === undefined && Date.now() - stat.mtimeMs >= LEGACY_LOCK_GRACE_MS;
  if (!legacyStale && (!owner || processOwnerState(owner) !== "dead")) return false;

  // Rename first so cleanup never unlinks a newly acquired lock by pathname.
  // The inode check narrows competing stale-reclaimer races to the atomic
  // namespace operation; a different lock is always left in place.
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(lockPath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return true;
    throw error;
  }
  if (current.dev !== stat.dev || current.ino !== stat.ino) return false;

  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return true;
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, LOCK_OWNER_FILE), "utf8")) as Partial<LockOwner>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0
      || typeof parsed.process_start !== "string"
      || typeof parsed.nonce !== "string"
      || parsed.nonce.length === 0
      || !Number.isFinite(parsed.acquired_at)
    ) {
      return undefined;
    }
    return parsed as LockOwner;
  } catch {
    // A fresh directory may be observed between mkdir and owner-file write.
    // It is treated as live for the full legacy initialization grace period.
    return undefined;
  }
}

function processOwnerState(owner: LockOwner): "alive" | "dead" | "unknown" {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
  const currentStart = processStartIdentity(owner.pid);
  if (
    currentStart !== undefined
    && owner.process_start !== "unavailable"
    && currentStart !== owner.process_start
  ) {
    return "dead";
  }
  return "alive";
}

function processStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    // The fields after the command start at proc field 3; starttime is field 22.
    return stat.slice(close + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

interface DurableHead {
  completeSize: number;
  seq: number;
  hash: string;
  tornTailBytes: number;
}

function readFileRange(path: string, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) return "";
  const bytes = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, start + offset);
      if (count === 0) throw new Error("corrupt log: verified suffix ended early");
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  return bytes.toString("utf8");
}

/** Read only the final complete JSONL record. This makes the common append
 * path independent of the total session size while still comparing the
 * actual durable seq/hash head. */
function readDurableHead(path: string): DurableHead {
  if (!existsSync(path)) return { completeSize: 0, seq: 0, hash: GENESIS_HASH, tornTailBytes: 0 };
  const size = statSync(path).size;
  if (size === 0) return { completeSize: 0, seq: 0, hash: GENESIS_HASH, tornTailBytes: 0 };
  const fd = openSync(path, "r");
  try {
    let window = Math.min(size, 64 * 1024);
    while (true) {
      const start = size - window;
      const bytes = Buffer.allocUnsafe(window);
      const count = readSync(fd, bytes, 0, window, start);
      const chunk = bytes.subarray(0, count);
      let lineEnd = chunk.lastIndexOf(0x0a);
      if (lineEnd < 0) {
        if (start === 0) return { completeSize: 0, seq: 0, hash: GENESIS_HASH, tornTailBytes: size };
        window = Math.min(size, window * 2);
        continue;
      }
      const completeSize = start + lineEnd + 1;
      // Skip blank lines defensively and find the beginning of the final row.
      while (lineEnd > 0 && chunk[lineEnd - 1] === 0x0a) lineEnd -= 1;
      const previous = chunk.lastIndexOf(0x0a, lineEnd - 1);
      if (previous < 0 && start > 0) {
        window = Math.min(size, window * 2);
        continue;
      }
      const line = chunk.subarray(previous + 1, lineEnd).toString("utf8");
      if (line.trim().length === 0) return { completeSize, seq: 0, hash: GENESIS_HASH, tornTailBytes: size - completeSize };
      let record: EventRecord;
      try {
        record = JSON.parse(line) as EventRecord;
      } catch {
        throw new Error("corrupt log: final complete event is not valid JSON");
      }
      if (!Number.isSafeInteger(record.seq) || typeof record.hash !== "string") {
        throw new Error("corrupt log: final complete event has no seq/hash head");
      }
      return { completeSize, seq: record.seq, hash: record.hash, tornTailBytes: size - completeSize };
    }
  } finally {
    closeSync(fd);
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function forbidCacheField(observe: ObserveFields | undefined, payload: Record<string, unknown>): void {
  if (observe && "cache" in observe) {
    throw new AppendRejectedError("observe.cache is forbidden; use observe.model_usage");
  }
  if ("cache" in payload && payload.cache !== undefined) {
    throw new AppendRejectedError("payload.cache is forbidden; use observe.model_usage");
  }
}

function normalizeObserve(
  kind: EventKind,
  name: string,
  observe: ObserveFields | undefined,
  payload: Record<string, unknown>,
): ObserveFields | undefined {
  if (kind !== "observe") {
    if (observe) {
      throw new AppendRejectedError("observe fields are only valid on kind=observe");
    }
    return undefined;
  }
  if (name === "model/usage" && !observe?.model_usage) {
    throw new AppendRejectedError("model/usage requires observe.model_usage");
  }
  if (payload.observe && typeof payload.observe === "object") {
    throw new AppendRejectedError("do not nest observe inside payload");
  }
  return observe;
}

export { sha256Hex };
