import { existsSync, lstatSync, readFileSync } from "node:fs";
import { BlobStore, type BlobGcRoots } from "./blob-store.ts";
import { EventLog } from "./event-log.ts";
import type { EventRecord } from "./schema.ts";
import { agentTranscriptPath } from "./agent-transcript.ts";
import { redactForEmission } from "./tool-result-input.ts";
import { compactionBackupPath, pendingCompactionPath } from "./compaction-transaction.ts";
import {
  projectResultText,
  readResultProjection,
  RESULT_MEDIA_TYPE,
  RESULT_RANGE_CAP,
  RESULT_READER,
  RESULT_SLIM_BUDGET,
  sha256Text,
  TOOL_RESULT_MODEL_BUDGET,
  utf8Bytes,
  type ResultCompleteness,
  type ResultProjection,
  type ResultSource,
} from "../tools/model-result.ts";

/**
 * Recoverable tool results (#223, design memo §127).
 *
 * R1 the host stores the SAFE bytes (redaction already applied) in the
 * session's existing BlobStore, records the envelope as a `tool/source` row,
 * and only then hands the bounded projection on for delivery. R3 recovery is
 * a capability: only a reader tool bound to this session's log authorises
 * `available`, and a read is answered only for a source this session
 * recorded, by exact byte range. R4 the `tool/source` row names the blob
 * (`payload.blob`), so the session log roots it for as long as the session
 * exists. R5 every read is recorded and replays offline from the blob.
 */
export const RESULT_SOURCE_EVENT = "tool/source";
export const RESULT_SOURCE_READ_EVENT = "tool/source_read";

const DIGEST = /^[0-9a-f]{64}$/;
const READER = Symbol("dokkabi.result-source-reader");

/** Mark a probe_log tool bound to `log` as this session's source reader. */
export function markResultSourceReader<T extends object>(tool: T, log: EventLog): T {
  Object.defineProperty(tool, READER, { value: log.path, enumerable: true, configurable: false, writable: false });
  return tool;
}

/** Whether the current tool profile holds an authorised reader for `log`.
 * A tool NAMED probe_log is not enough: it must be the host's reader bound
 * to this very session log. */
export function resultSourceReaderAuthorised(tools: readonly object[], log: EventLog): boolean {
  return tools.some((tool) => Reflect.get(tool, "name") === RESULT_READER && Reflect.get(tool, READER) === log.path);
}

type ContentPart = { type?: unknown; text?: unknown };

function completenessOf(redactedStrings: number, details: unknown): ResultCompleteness {
  if (redactedStrings > 0) return "redacted";
  if (details && typeof details === "object") {
    const truncation = Reflect.get(details, "truncation");
    if (truncation && typeof truncation === "object" && Reflect.get(truncation, "truncated") === true) return "producer_truncated";
    if (Reflect.get(details, "producer_truncated") === true) return "producer_truncated";
  }
  return "complete";
}

function storeSafeBytes(store: BlobStore, text: string, digest: string): { ok: true } | { ok: false; reason: string } {
  const stored = () => {
    try { return store.get(digest) === text; } catch { return false; }
  };
  try {
    store.put(text);
    // A file already on disk is not trusted because of its name: a damaged
    // one is replaced once, then checked again.
    if (stored()) return { ok: true };
    store.remove(digest);
    store.put(text);
    return stored() ? { ok: true } : { ok: false, reason: "store_integrity" };
  } catch (error) {
    const code = error && typeof error === "object" && typeof Reflect.get(error, "code") === "string"
      ? String(Reflect.get(error, "code")) : "store_error";
    return { ok: false, reason: `store_failed:${code}` };
  }
}

/** The primary source set is capped. Overflow remains in the session's
 * content-addressed disk archive, rooted by the same log and read capability. */
export const RESULT_SOURCE_SET_CAP = 4_096;
export const RESULT_SOURCE_SET_BYTES_CAP = 256 * 1024 * 1024;

/** Host-minted marks on a delivered result: whatever a tool put under these
 * keys is dropped before anything reads them. */
const HOST_KEYS = new Set(["result_source", "result_read"]);

/** A verified read-back: an exact-range read of a parent source, recorded as
 * a `tool/source_read` row — never a source of its own (R6'). */
export interface ResultRead {
  readonly seq: number;
  readonly digest: string;
  readonly start: number;
  readonly end: number;
  readonly sourceBytes: number;
  readonly completeness: ResultCompleteness;
  /** sha256 of the text part as it was emitted. */
  readonly emittedDigest: string;
  /** Set once in-flight slimming replaced the read-back with its marker. */
  readonly slimmed?: { readonly recovery: "available" | "unavailable"; readonly digest: string };
}

export function readResultRead(details: unknown): ResultRead | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = Reflect.get(details, "result_read") as ResultRead | undefined;
  if (!value || typeof value !== "object" || typeof value.digest !== "string" || !DIGEST.test(value.digest)) return undefined;
  if (![value.seq, value.start, value.end, value.sourceBytes].every((n) => Number.isSafeInteger(n)) || typeof value.emittedDigest !== "string") return undefined;
  return value;
}

function storedSourceTotals(events: readonly Pick<EventRecord, "name" | "payload">[]): { count: number; bytes: number } {
  const seen = new Set<string>();
  let bytes = 0;
  for (const event of events) {
    if (event.payload.storage_tier === "overflow_archive") continue;
    if (event.name !== RESULT_SOURCE_EVENT || typeof event.payload.blob !== "string" || seen.has(event.payload.blob)) continue;
    seen.add(event.payload.blob);
    bytes += typeof event.payload.blob_bytes === "number" ? event.payload.blob_bytes : 0;
  }
  return { count: seen.size, bytes };
}

/**
 * The tool-agnostic delivery step: after redaction, before any host hint is
 * appended. R1': the text parts are redacted again as the ONE byte string
 * they are delivered as (joined, no separator) — a secret split across two
 * parts, each harmless alone, is caught here — and when that changes
 * anything, or the result is long, the parts become that one part. A result
 * whose text can never be slimmed (≤ RESULT_SLIM_BUDGET bytes) records no
 * source. R6': a verified read-back records no source either. Otherwise the
 * safe text is stored and `details.result_source` carries the projection.
 * Other post-delivery hooks (e.g. #221 read receipts) compose after this one:
 * they see the projected content and the structured projection.
 */
export function deliverToolResult<R extends { content?: unknown; details?: unknown }>(input: {
  log: EventLog;
  store?: BlobStore;
  invocationId: string;
  tool: string;
  result: R;
  redactedStrings: number;
  readerAuthorised: boolean;
  budget?: number;
  /** #228 S1'': store the safe bytes and record the envelope whatever the
   * size — for a result whose text a composition leaves out, so its bytes
   * stay recoverable through the session's reader. */
  forceSource?: boolean;
}): R {
  const incoming = input.result.details;
  const result = incoming && typeof incoming === "object" && Object.keys(incoming).some((key) => HOST_KEYS.has(key))
    ? { ...input.result, details: Object.fromEntries(Object.entries(incoming).filter(([key]) => !HOST_KEYS.has(key))) }
    : input.result;
  const content = Array.isArray(result.content) ? result.content as ContentPart[] : [];
  const textIndexes = content.flatMap((part, index) => part && part.type === "text" && typeof part.text === "string" ? [index] : []);
  if (textIndexes.length === 0) return result;
  const joined = textIndexes.map((index) => content[index]!.text as string).join("");
  const text = redactForEmission(joined);
  const redactedWhole = text !== joined;
  const part = textIndexes[0]!;
  const asOnePart = (value: string): ContentPart[] => {
    const next: ContentPart[] = [];
    content.forEach((item, index) => {
      if (index === part) next.push({ ...item, type: "text", text: value });
      else if (!textIndexes.includes(index)) next.push(item);
    });
    return next;
  };
  const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
  const read = verifiedReadBack(input.log, details, text);
  if (read) return { ...result, content: asOnePart(text), details: { ...details, result_read: read } };
  const sourceBytes = utf8Bytes(text);
  if (sourceBytes <= RESULT_SLIM_BUDGET && input.forceSource !== true) {
    return redactedWhole ? { ...result, content: asOnePart(text) } : result;
  }
  const budget = input.budget ?? TOOL_RESULT_MODEL_BUDGET;
  const store = input.store ?? BlobStore.forSession(input.log.path);
  const digest = sha256Text(text);
  const totals = storedSourceTotals(input.log.events);
  const known = sessionSources(input.log.events).has(digest);
  const capped = !known && (totals.count >= RESULT_SOURCE_SET_CAP || totals.bytes + sourceBytes > RESULT_SOURCE_SET_BYTES_CAP);
  const archived = capped || input.log.events.some(event => event.name === RESULT_SOURCE_EVENT && event.payload.digest === digest && event.payload.storage_tier === "overflow_archive");
  // A primary retention limit bounds the active set, not the original bytes.
  // Both tiers use the existing CAS so GC, export and replay retain the archive.
  const stored = storeSafeBytes(store, text, digest);
  const completeness = completenessOf(input.redactedStrings + (redactedWhole ? 1 : 0), details);
  let source: ResultSource = {
    invocationId: input.invocationId,
    resultEvent: 0,
    digest,
    sourceBytes,
    mediaType: RESULT_MEDIA_TYPE,
    source: stored.ok ? { kind: "blob", digest } : { kind: "unstored", reason: stored.reason },
    completeness,
  };
  let projected = projectResultText(text, source, { budget, part, readerAuthorised: input.readerAuthorised });
  try {
    const row = input.log.append({
      kind: "observe",
      name: RESULT_SOURCE_EVENT,
      payload: {
        id: input.invocationId,
        tool: input.tool,
        digest,
        source_bytes: sourceBytes,
        media_type: RESULT_MEDIA_TYPE,
        completeness,
        ...(stored.ok && archived ? { storage_tier: "overflow_archive" } : {}),
        ...(source.source.kind === "blob" ? { blob: digest, blob_bytes: sourceBytes } : { unstored: source.source.reason }),
        projection: projectionFacts(projected.projection),
      },
    });
    source = { ...source, resultEvent: row.seq };
    projected = { text: projected.text, projection: { ...projected.projection, source } };
  } catch {
    // No recorded envelope, no success-looking reference: the blob (if any)
    // is an orphan for GC, and the model is told the bytes are not kept.
    source = { ...source, source: { kind: "unstored", reason: "envelope_not_recorded" } };
    projected = projectResultText(text, source, { budget, part, readerAuthorised: false });
  }
  return { ...result, content: asOnePart(projected.text), details: { ...details, result_source: projected.projection } };
}

/** A result is a read-back only when its `source_read` names a recorded
 * `tool/source_read` row whose emitted digest is exactly this text. */
function verifiedReadBack(log: EventLog, details: Record<string, unknown>, text: string): ResultRead | undefined {
  const claim = details.source_read;
  if (!claim || typeof claim !== "object") return undefined;
  const seq = Reflect.get(claim, "seq");
  if (typeof seq !== "number") return undefined;
  const row = log.events.find((event) => event.seq === seq);
  if (!row || row.name !== RESULT_SOURCE_READ_EVENT || row.payload.status !== "ok" || row.payload.emitted_digest !== sha256Text(text)) return undefined;
  const p = row.payload;
  return {
    seq,
    digest: String(p.digest),
    start: Number(p.start),
    end: Number(p.end),
    sourceBytes: Number(p.source_bytes),
    completeness: (p.completeness === "producer_truncated" || p.completeness === "redacted" ? p.completeness : "complete"),
    emittedDigest: String(p.emitted_digest),
  };
}

export function projectionFacts(projection: ResultProjection): Record<string, unknown> {
  return {
    projection_digest: projection.projectionDigest,
    visible_bytes: projection.visibleBytes,
    kept_ranges: projection.keptRanges.map(([start, end]) => [start, end]),
    omitted_bytes: projection.omittedBytes,
    recovery: projection.recovery,
    budget: projection.budget,
    ...(projection.readerCapability ? { reader: projection.readerCapability } : {}),
    ...(projection.limit ? { limit: projection.limit } : {}),
  };
}

export interface SessionSource {
  readonly digest: string;
  readonly bytes: number;
  readonly seq: number;
  readonly kind: "envelope" | "legacy";
  readonly completeness?: ResultCompleteness;
}

/**
 * This session's source set: every `tool/source` row that stored its bytes,
 * plus historical `tool/result` rows whose blob and UTF-8 size are recorded
 * (legacy logs). Nothing else in the store is a source — provider bodies,
 * graph bodies and another session's digests are not readable through here.
 */
export function sessionSources(events: readonly Pick<EventRecord, "name" | "seq" | "payload">[]): Map<string, SessionSource> {
  const sources = new Map<string, SessionSource>();
  for (const event of events) {
    const blob = event.payload.blob, bytes = event.payload.blob_bytes;
    if (typeof blob !== "string" || !DIGEST.test(blob) || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) continue;
    if (event.name === RESULT_SOURCE_EVENT) {
      if (event.payload.digest !== blob || event.payload.source_bytes !== bytes) continue;
      const completeness = event.payload.completeness;
      sources.set(blob, {
        digest: blob, bytes, seq: event.seq, kind: "envelope",
        ...(completeness === "complete" || completeness === "producer_truncated" || completeness === "redacted" ? { completeness } : {}),
      });
    } else if (event.name === "tool/result" && !sources.has(blob)) {
      sources.set(blob, { digest: blob, bytes, seq: event.seq, kind: "legacy" });
    }
  }
  return sources;
}

export type SourceReadRefusal =
  | "invalid_digest"
  | "not_a_session_source"
  | "invalid_range"
  | "range_too_large"
  | "range_splits_code_point";
export type SourceReadUnavailable = "source_missing" | "source_corrupt" | "source_size_mismatch";

export type SourceReadOutcome =
  | {
    readonly status: "ok";
    readonly digest: string;
    readonly start: number;
    readonly end: number;
    readonly sourceBytes: number;
    readonly completeness: ResultCompleteness;
    /** The range's bytes as the model receives them (re-redacted at emission). */
    readonly text: string;
    /** The whole tool text emitted: one header line, then `text`. */
    readonly emitted: string;
    readonly readDigest: string;
    readonly emittedDigest: string;
    readonly sliceDigest: string;
    readonly redactedAtEmission: boolean;
    /** The `tool/source_read` row that recorded this read. */
    readonly seq?: number;
  }
  | { readonly status: "refused"; readonly code: SourceReadRefusal; readonly message: string; readonly next?: { readonly start: number; readonly end: number } }
  | { readonly status: "unavailable"; readonly code: SourceReadUnavailable; readonly message: string };

function short(digest: string): string {
  return DIGEST.test(digest) ? `${digest.slice(0, 12)}…` : "(not a digest)";
}

const continuation = (bytes: Buffer, at: number) => at > 0 && at < bytes.length && (bytes[at]! & 0xc0) === 0x80;
function floorBoundary(bytes: Buffer, at: number): number {
  let out = Math.max(0, Math.min(bytes.length, at));
  while (continuation(bytes, out)) out -= 1;
  return out;
}
function ceilBoundary(bytes: Buffer, at: number): number {
  let out = Math.max(0, Math.min(bytes.length, at));
  while (continuation(bytes, out)) out += 1;
  return out;
}

/** The range the reader will accept nearest to what was asked: the start on
 * the code point boundary at or below it, the end on the boundary at or below
 * min(asked end, start + cap) — always a non-empty readable range. */
export function acceptableRange(bytes: Buffer, start: number, end: number): { start: number; end: number } | undefined {
  if (bytes.length === 0) return undefined;
  const from = floorBoundary(bytes, Number.isFinite(start) ? Math.min(Math.max(0, Math.trunc(start)), bytes.length - 1) : 0);
  const wanted = Number.isFinite(end) && end > from ? Math.trunc(end) : from + RESULT_RANGE_CAP;
  let to = floorBoundary(bytes, Math.min(bytes.length, wanted, from + RESULT_RANGE_CAP));
  if (to <= from) to = ceilBoundary(bytes, from + 1);
  return { start: from, end: to };
}

/** The exact text a range read emits: a header line, then the range — the
 * whole re-redacted at emission (R3'), since a cut can make a credential
 * shape the redactor rightly left alone inside the source. */
export function emitSourceRead(read: { digest: string; start: number; end: number; sourceBytes: number; completeness: ResultCompleteness }, slice: string): { emitted: string; text: string } {
  const facts = read.completeness === "complete" ? "" : `; the source is ${read.completeness.replace("_", "-")}`;
  const header = `[source blob:${short(read.digest)} bytes ${read.start}-${read.end} of ${read.sourceBytes}${facts}]`;
  const emitted = redactForEmission(`${header}\n${slice}`);
  const newline = emitted.indexOf("\n");
  return { emitted, text: newline < 0 ? emitted : emitted.slice(newline + 1) };
}

/**
 * Read an exact byte range of one of this session's sources. The answer is
 * the recorded safe bytes as emitted, or a refusal that names the range the
 * reader would accept instead — never a nearby range silently, never another
 * reader. Every outcome is recorded; a read row carries the digest of what the
 * model received (`redacted_at_emission` when that differs from the source
 * slice). A vanished or damaged source is unavailable with its reason and is
 * not retried.
 */
export function readSourceRange(input: {
  log: EventLog;
  store?: BlobStore;
  digest: string;
  start: number;
  end: number;
}): SourceReadOutcome {
  const outcome = decideSourceRead(input);
  const payload: Record<string, unknown> = {
    status: outcome.status,
    ...(DIGEST.test(input.digest) ? { digest: input.digest } : {}),
    ...(Number.isSafeInteger(input.start) ? { start: input.start } : {}),
    ...(Number.isSafeInteger(input.end) ? { end: input.end } : {}),
  };
  if (outcome.status === "ok") {
    payload.read_bytes = outcome.end - outcome.start;
    payload.source_bytes = outcome.sourceBytes;
    payload.completeness = outcome.completeness;
    payload.read_digest = outcome.readDigest;
    payload.emitted_digest = outcome.emittedDigest;
    payload.emitted_bytes = utf8Bytes(outcome.emitted);
    payload.slice_digest = outcome.sliceDigest;
    if (outcome.redactedAtEmission) payload.redacted_at_emission = true;
  } else {
    payload.code = outcome.code;
    if (outcome.status === "refused" && outcome.next) payload.next = [outcome.next.start, outcome.next.end];
  }
  const row = input.log.append({ kind: "observe", name: RESULT_SOURCE_READ_EVENT, payload });
  return outcome.status === "ok" ? { ...outcome, seq: row.seq } as SourceReadOutcome : outcome;
}

/** Recover the next omitted interval, subtracting successful prior reads.
 * Exact reads remain strict; this mode chooses capped UTF-8 boundaries itself. */
export function readNextOmittedRange(input: { log: EventLog; digest: string; start?: number; end?: number }): SourceReadOutcome | undefined {
  const source = sessionSources(input.log.events).get(input.digest);
  if (!source) return readSourceRange({ ...input, start: 0, end: 1 });
  const row = [...input.log.events].reverse().find(event => event.name === RESULT_SOURCE_EVENT && event.payload.digest === input.digest);
  const projection = row?.payload.projection as { kept_ranges?: Array<[number, number]> } | undefined;
  if ((input.start !== undefined || input.end !== undefined) &&
      (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start! < 0 || input.end! <= input.start! || input.end! > source.bytes)) {
    return readSourceRange({ log: input.log, digest: input.digest, start: Number.NaN, end: Number.NaN });
  }
  const covered: Array<[number, number]> = input.start === undefined ? [...(projection?.kept_ranges ?? [])]
    : [[0, input.start], [input.end!, source.bytes]];
  for (const event of input.log.events) {
    if (event.name === RESULT_SOURCE_READ_EVENT && event.payload.digest === input.digest && event.payload.status === "ok") {
      covered.push([event.payload.start as number, event.payload.end as number]);
    }
  }
  covered.sort((a, b) => a[0] - b[0]);
  let start = 0;
  for (const [from, to] of covered) {
    if (from > start) break;
    start = Math.max(start, to);
  }
  if (start >= source.bytes) return undefined;
  const end = covered.find(([from]) => from > start)?.[0] ?? source.bytes;
  try {
    const bytes = Buffer.from(BlobStore.forSession(input.log.path).get(input.digest), "utf8");
    const range = acceptableRange(bytes, start, end);
    if (range) return readSourceRange({ ...input, ...range });
  } catch { /* The exact reader records the source failure below. */ }
  return readSourceRange({ ...input, start, end: Math.min(end, start + RESULT_RANGE_CAP) });
}

function decideSourceRead(input: { log: EventLog; store?: BlobStore; digest: string; start: number; end: number }): SourceReadOutcome {
  const { digest, start, end } = input;
  if (!DIGEST.test(digest)) {
    return { status: "refused", code: "invalid_digest", message: "the path names no source digest; nothing was read" };
  }
  const source = sessionSources(input.log.events).get(digest);
  if (!source) {
    return { status: "refused", code: "not_a_session_source", message: `blob:${short(digest)} is not a source recorded in this session; nothing was read` };
  }
  const store = input.store ?? BlobStore.forSession(input.log.path);
  if (!store.has(digest)) {
    return { status: "unavailable", code: "source_missing", message: `the recorded source blob:${short(digest)} is no longer stored` };
  }
  let body: string;
  try {
    body = store.get(digest);
  } catch {
    return { status: "unavailable", code: "source_corrupt", message: `the recorded source blob:${short(digest)} failed its integrity check` };
  }
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length !== source.bytes) {
    return { status: "unavailable", code: "source_size_mismatch", message: `the stored source is ${bytes.length} bytes, recorded as ${source.bytes}` };
  }
  const next = acceptableRange(bytes, start, end);
  const instead = next ? `; read start_byte=${next.start}, end_byte=${next.end} instead, then continue from end_byte` : "";
  const refuse = (code: SourceReadRefusal, why: string): SourceReadOutcome =>
    ({ status: "refused", code, message: `${why}${instead}`, ...(next ? { next } : {}) });
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.bytes) {
    return refuse("invalid_range", `byte range must satisfy 0 <= start_byte < end_byte <= ${source.bytes}`);
  }
  if (end - start > RESULT_RANGE_CAP) {
    return refuse("range_too_large", `one read returns at most ${RESULT_RANGE_CAP} bytes`);
  }
  if (continuation(bytes, start) || continuation(bytes, end)) {
    return refuse("range_splits_code_point", "the range starts or ends inside a UTF-8 code point");
  }
  const slice = bytes.subarray(start, end).toString("utf8");
  const completeness = source.completeness ?? "complete";
  const read = { digest, start, end, sourceBytes: source.bytes, completeness };
  const emission = emitSourceRead(read, slice);
  return {
    status: "ok", ...read, text: emission.text, emitted: emission.emitted,
    readDigest: sha256Text(emission.text), emittedDigest: sha256Text(emission.emitted), sliceDigest: sha256Text(slice),
    redactedAtEmission: emission.text !== slice,
  };
}

/** The text a read returns to the model: the emitted text on success, the
 * refusal with its usable next step otherwise. */
export function sourceReadText(outcome: SourceReadOutcome): string {
  if (outcome.status !== "ok") return `probe_log: ${outcome.status === "refused" ? "refused" : "unavailable"} (${outcome.code}): ${outcome.message}`;
  return outcome.emitted;
}

// --- R4: roots ------------------------------------------------------------

/**
 * R4': sources the session's current and retained model-input views hold —
 * the live transcript (agent.json) and a pending compaction's backup — read
 * as typed rows only: a toolResult message's own `details.result_source`,
 * and only for a digest a host-minted `tool/source` row of this log recorded.
 * Tool arguments, nested tool details and any model-authored text are never
 * walked, so nothing they carry can root a blob.
 */
export function viewSourceRoots(target: Pick<EventLog, "path" | "events"> | string): Set<string> {
  return scanViewSourceRoots(target, false).roots;
}

/** Offline GC must distinguish an absent saved view from an unreadable or
 * incomplete one. Call only inside the collector's deferred roots callback. */
export function strictViewSourceRoots(target: Pick<EventLog, "path" | "events"> | string): BlobGcRoots {
  return scanViewSourceRoots(target, true);
}

function scanViewSourceRoots(target: Pick<EventLog, "path" | "events"> | string, strict: boolean): { roots: Set<string>; complete: boolean } {
  // A path alone is read as the log it names, read-only: the typed rows are
  // the authority either way.
  const log = typeof target === "string" ? new EventLog(target, { readOnly: true }) : target;
  const recorded = sessionSources(log.events);
  const roots = new Set<string>();
  let complete = true;
  const transcript = agentTranscriptPath(log.path);
  for (const path of [transcript, compactionBackupPath(transcript)]) {
    if (!strict && !existsSync(path)) continue;
    let messages: unknown;
    try {
      if (strict) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.nlink !== 1) { complete = false; continue; }
      }
      messages = (JSON.parse(readFileSync(path, "utf8")) as { messages?: unknown }).messages;
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
      continue;
    }
    if (!Array.isArray(messages)) { if (strict) complete = false; continue; }
    for (const message of messages) {
      if (!message || typeof message !== "object" || Reflect.get(message, "role") !== "toolResult") continue;
      const projection = readResultProjection(Reflect.get(message, "details"));
      const digest = projection?.source.source.kind === "blob" ? projection.source.source.digest : undefined;
      if (digest && recorded.get(digest)?.kind === "envelope") roots.add(digest);
    }
  }
  if (strict) {
    try {
      // A pending transaction requires its saved pre-compaction view.
      const pending = lstatSync(pendingCompactionPath(transcript));
      if (!pending.isFile() || pending.nlink !== 1) complete = false;
      const backup = lstatSync(compactionBackupPath(transcript));
      if (!backup.isFile() || backup.nlink !== 1) complete = false;
    } catch (error) {
      // Only an absent pending marker is normal. An existing marker without
      // a backup is an incomplete retained-root scan.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existsSync(pendingCompactionPath(transcript))) complete = false;
    }
  }
  return { roots, complete };
}

// --- R5: replay and dashboard projections ----------------------------------

export interface ResultSourceReference {
  seq: number;
  id: string;
  digest: string;
  source_bytes: number;
  completeness: string;
  stored: boolean;
  projection_digest: string;
  visible_bytes: number;
  omitted_bytes: number;
  recovery: string;
}

export interface ResultSourceReadReference {
  seq: number;
  status: string;
  digest?: string;
  start?: number;
  end?: number;
  code?: string;
  read_digest?: string;
  emitted_digest?: string;
  slice_digest?: string;
  completeness?: string;
  source_bytes?: number;
}

/** Envelope and read references in log order. A successful read must follow
 * the source it read; anything else is not replayable truth. */
export function projectResultSourceReferences(events: readonly EventRecord[]): {
  sources: ResultSourceReference[];
  reads: ResultSourceReadReference[];
} {
  const sources: ResultSourceReference[] = [];
  const reads: ResultSourceReadReference[] = [];
  const known = new Map<string, number>();
  for (const event of events) {
    const p = event.payload;
    if (event.name === RESULT_SOURCE_EVENT) {
      const projection = (p.projection && typeof p.projection === "object" ? p.projection : {}) as Record<string, unknown>;
      if (typeof p.digest !== "string" || typeof p.source_bytes !== "number") throw new Error(`tool/source at seq ${event.seq} is malformed`);
      const stored = typeof p.blob === "string";
      if (stored && (p.blob !== p.digest || p.blob_bytes !== p.source_bytes)) throw new Error(`tool/source at seq ${event.seq} names a different blob`);
      if (stored) known.set(p.digest, p.source_bytes);
      sources.push({
        seq: event.seq,
        id: String(p.id ?? ""),
        digest: p.digest,
        source_bytes: p.source_bytes,
        completeness: String(p.completeness ?? "missing"),
        stored,
        projection_digest: String(projection.projection_digest ?? "missing"),
        visible_bytes: Number(projection.visible_bytes ?? 0),
        omitted_bytes: Number(projection.omitted_bytes ?? 0),
        recovery: String(projection.recovery ?? "missing"),
      });
    } else if (event.name === "tool/result" && typeof p.blob === "string" && typeof p.blob_bytes === "number" && !known.has(p.blob)) {
      known.set(p.blob, p.blob_bytes);
    } else if (event.name === RESULT_SOURCE_READ_EVENT) {
      const reference: ResultSourceReadReference = { seq: event.seq, status: String(p.status) };
      if (typeof p.digest === "string") reference.digest = p.digest;
      if (typeof p.start === "number") reference.start = p.start;
      if (typeof p.end === "number") reference.end = p.end;
      if (typeof p.code === "string") reference.code = p.code;
      if (p.status === "ok") {
        const bytes = typeof p.digest === "string" ? known.get(p.digest) : undefined;
        if (bytes === undefined || typeof p.start !== "number" || typeof p.end !== "number" || typeof p.read_digest !== "string"
          || p.start < 0 || p.end <= p.start || p.end > bytes || p.read_bytes !== p.end - p.start) {
          throw new Error(`tool/source_read at seq ${event.seq} has no recorded source it could have read`);
        }
        reference.read_digest = p.read_digest;
        reference.source_bytes = bytes;
        if (typeof p.emitted_digest === "string") reference.emitted_digest = p.emitted_digest;
        if (typeof p.slice_digest === "string") reference.slice_digest = p.slice_digest;
        if (typeof p.completeness === "string") reference.completeness = p.completeness;
      }
      reads.push(reference);
    }
  }
  return { sources, reads };
}

/** Re-derive one recorded read from the stored source alone: the slice, then
 * its emission exactly as the reader emitted it. */
function rederiveRead(read: ResultSourceReadReference, store: BlobStore): { text: string; emitted: string; slice: string } {
  const slice = Buffer.from(store.get(read.digest!), "utf8").subarray(read.start!, read.end!).toString("utf8");
  if (read.emitted_digest === undefined) return { text: slice, emitted: slice, slice }; // a read recorded before R3'
  const completeness = read.completeness === "producer_truncated" || read.completeness === "redacted" ? read.completeness : "complete";
  const emission = emitSourceRead({ digest: read.digest!, start: read.start!, end: read.end!, sourceBytes: read.source_bytes!, completeness }, slice);
  return { ...emission, slice };
}

function readMatches(read: ResultSourceReadReference, derived: { text: string; emitted: string; slice: string }): boolean {
  return sha256Text(derived.text) === read.read_digest
    && (read.emitted_digest === undefined || sha256Text(derived.emitted) === read.emitted_digest)
    && (read.slice_digest === undefined || sha256Text(derived.slice) === read.slice_digest);
}

/** Replay preflight: every recorded successful read is re-derived from the
 * stored source bytes alone — no workspace, no filter subprocess — and must
 * give the digests of what the model received. */
export function validateRecordedSourceReads(events: readonly EventRecord[], store: BlobStore): void {
  const { reads } = projectResultSourceReferences(events);
  for (const read of reads) {
    if (read.status !== "ok") continue;
    if (!readMatches(read, rederiveRead(read, store))) {
      throw new Error(`Error: recorded source read at event seq #${read.seq} differs from its stored source\nReplay aborted (fail-closed).`);
    }
  }
}

/** Replay-side recovery of one recorded read (offline): the range's bytes as
 * the model received them. */
export function replaySourceRead(events: readonly EventRecord[], store: BlobStore, seq: number): string {
  const read = projectResultSourceReferences(events).reads.find((item) => item.seq === seq);
  if (!read || read.status !== "ok") throw new Error(`no recorded successful source read at seq ${seq}`);
  const derived = rederiveRead(read, store);
  if (!readMatches(read, derived)) throw new Error(`recorded source read at seq ${seq} differs from its stored source`);
  return derived.text;
}

export interface ResultSourceStats {
  sources: number;
  unstored: number;
  /** Unique stored source bytes: one blob counts once however many rows or
   * views share it. */
  stored_bytes: number;
  /** Model-visible bytes of the delivered projections. */
  visible_bytes: number;
  /** Bytes omitted at delivery. */
  omitted_bytes: number;
  /** Further bytes omitted by later in-flight slimming. */
  slim_omitted_bytes: number;
  reads_ok: number;
  reads_refused: number;
  reads_unavailable: number;
  read_bytes: number;
}

export function resultSourceStats(events: readonly EventRecord[]): ResultSourceStats | undefined {
  const stats: ResultSourceStats = {
    sources: 0, unstored: 0, stored_bytes: 0, visible_bytes: 0, omitted_bytes: 0, slim_omitted_bytes: 0,
    reads_ok: 0, reads_refused: 0, reads_unavailable: 0, read_bytes: 0,
  };
  const counted = new Set<string>();
  for (const event of events) {
    const p = event.payload;
    if (event.name === RESULT_SOURCE_EVENT) {
      stats.sources += 1;
      const projection = (p.projection && typeof p.projection === "object" ? p.projection : {}) as Record<string, unknown>;
      if (typeof projection.visible_bytes === "number") stats.visible_bytes += projection.visible_bytes;
      if (typeof projection.omitted_bytes === "number") stats.omitted_bytes += projection.omitted_bytes;
      if (typeof p.blob === "string" && typeof p.blob_bytes === "number") {
        if (!counted.has(p.blob)) {
          counted.add(p.blob);
          stats.stored_bytes += p.blob_bytes;
        }
      } else {
        stats.unstored += 1;
      }
    } else if (event.name === RESULT_SOURCE_READ_EVENT) {
      if (p.status === "ok") {
        stats.reads_ok += 1;
        // Visible bytes per emission: what the model received, not the slice.
        const emitted = typeof p.emitted_bytes === "number" ? p.emitted_bytes : p.read_bytes;
        if (typeof emitted === "number") stats.read_bytes += emitted;
      } else if (p.status === "refused") stats.reads_refused += 1;
      else stats.reads_unavailable += 1;
    } else if ((event.name === "context/slim" || event.name === "context/prune") && typeof p.source_omitted_bytes === "number") {
      stats.slim_omitted_bytes += p.source_omitted_bytes;
    }
  }
  return stats.sources + stats.reads_ok + stats.reads_refused + stats.reads_unavailable > 0 ? stats : undefined;
}
