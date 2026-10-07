import { createHash } from "node:crypto";
import { secretSpans } from "../host/redact.ts";


export const TOOL_RESULT_MODEL_BUDGET = 16_000;

export interface ClampToolResultOptions {
  readonly blob?: string;
  readonly blobBytes?: number;
  readonly isolatedPath?: string;
}

/**
 * Slices text up to `maxBytes` UTF-8 bytes without splitting a Unicode code point
 * or surrogate pair.
 */
export function sliceUtf8BytesHead(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let acc = 0;
  let out = "";
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (acc + bytes > maxBytes) {
      break;
    }
    acc += bytes;
    out += char;
  }
  return out;
}

/**
 * Slices text from the end up to `maxBytes` UTF-8 bytes without splitting a Unicode
 * code point or surrogate pair.
 */
export function sliceUtf8BytesTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const chars = Array.from(text);
  let acc = 0;
  let startIndex = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const charBytes = Buffer.byteLength(chars[i]!, "utf8");
    if (acc + charBytes > maxBytes) {
      break;
    }
    acc += charBytes;
    startIndex = i;
  }
  return chars.slice(startIndex).join("");
}

/**
 * A tool's own head/tail clamp. The host bounds every delivered result with a
 * recorded source (`projectResultText`); a tool that still clamps discards the
 * middle itself, so its result is producer-truncated. The `blob` and
 * `isolatedPath` hints name a reader regardless of the tool profile and have
 * no product caller since #223 — the host projection alone advertises
 * recovery.
 */
export function clampToolResultText(
  text: string,
  options?: ClampToolResultOptions,
): string {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= TOOL_RESULT_MODEL_BUDGET) {
    return text;
  }
  const head = sliceUtf8BytesHead(text, 8_000);
  const tail = sliceUtf8BytesTail(text, 4_000);
  const headBytes = Buffer.byteLength(head, "utf8");
  const tailBytes = Buffer.byteLength(tail, "utf8");
  const dropped = totalBytes - headBytes - tailBytes;
  // Nothing beyond this preview is kept by the tool itself: say so rather
  // than promise a copy the log does not hold (#223 R3).
  let hint = `\n[truncated ${dropped} bytes by this tool; the omitted bytes were not kept]\n`;
  if (options?.blob) {
    const blobBytes = options.blobBytes ?? totalBytes;
    hint = `\n[truncated ${dropped} bytes of ${blobBytes} total. Full output isolated to blob:${options.blob}]\n[Hint: Use probe_log(path="blob:${options.blob}", script="...") to inspect/filter this output without context bloat]\n`;
  } else if (options?.isolatedPath) {
    hint = `\n[truncated ${dropped} bytes of ${totalBytes} total. Full output isolated to ${options.isolatedPath}]\n[Hint: Use probe_log(path="${options.isolatedPath}", script="...") to inspect/filter this output without context bloat]\n`;
  }
  return `${head}${hint}${tail}`;
}

export function textToolResult(
  text: string,
  error = false,
  options?: ClampToolResultOptions,
): {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: { readonly error: boolean };
} {
  return {
    content: [{ type: "text", text: clampToolResultText(text, options) }],
    details: { error, ...producerTruncation(text) },
  };
}

/**
 * A producer's own statement of what its result covers (#228 Q1'): a bounded
 * producer (grep's max_results, the glob/ls caps, a read window, a repo read
 * limit, a signal that stopped it) says so here, structurally, in
 * `details.coverage`. A consumer that composes results reads only this: a
 * result without a statement is `unverified`, never assumed complete.
 */
export interface ProducerCoverage {
  readonly complete: boolean;
  readonly unit: "lines" | "bytes" | "matches" | "entries" | "whole";
  /** Units delivered. */
  readonly kept?: number;
  /** The bound that applied. */
  readonly limit?: number;
  readonly reason?: "max_results" | "cap" | "read_window" | "read_limit" | "cancelled" | "producer";
  /** Q1''': a windowed read states its range. */
  readonly range?: ProducerCoverageRange;
  /** Q1''': matches whose text a per-match clamp cut, and the clamp. */
  readonly clamped?: number;
  readonly clamp?: number;
}

export interface ProducerCoverageRange {
  /** First unit shown (1-based lines, or a byte offset). */
  readonly from: number;
  /** Last unit shown (inclusive lines) or end byte (exclusive). */
  readonly to: number;
  /** Total units the resource holds, when known. */
  readonly of?: number;
}

/** The host-side statement for a result whose shape the host does not own
 * (pi's `read` returns its own `details`, undefined when nothing truncated):
 * the statement is bound to the exact result object instead of changing it,
 * so the model-visible shape stays what the tool made (E1'). */
const ATTACHED_COVERAGE = new WeakMap<object, ProducerCoverage>();

export function attachProducerCoverage<T extends object>(result: T, coverage: ProducerCoverage): T {
  ATTACHED_COVERAGE.set(result, coverage);
  return result;
}

/** The producer's statement for a result: attached to the result object,
 * or carried in its `details.coverage`. */
export function producerCoverageOf(result: unknown): ProducerCoverage | undefined {
  if (result && typeof result === "object") {
    const attached = ATTACHED_COVERAGE.get(result);
    if (attached) return attached;
    return readProducerCoverage(Reflect.get(result, "details"));
  }
  return undefined;
}

export function readProducerCoverage(details: unknown): ProducerCoverage | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = Reflect.get(details, "coverage");
  if (!value || typeof value !== "object" || typeof Reflect.get(value, "complete") !== "boolean") return undefined;
  const unit = Reflect.get(value, "unit");
  if (unit !== "lines" && unit !== "bytes" && unit !== "matches" && unit !== "entries" && unit !== "whole") return undefined;
  return value as ProducerCoverage;
}

/** The structural mark of a tool-side clamp: the host records such a result
 * as `producer_truncated`, never as complete (#223 R1). */
export function producerTruncation(text: string): { producer_truncated?: true } {
  return Buffer.byteLength(text, "utf8") > TOOL_RESULT_MODEL_BUDGET ? { producer_truncated: true } : {};
}

// ---------------------------------------------------------------------------
// Recoverable tool results (#223). A long result keeps its identity through
// every later reduction: the host stores the SAFE bytes once, records an
// envelope, and the model sees a projection — kept byte ranges of that source
// plus one marker that states what was omitted and whether an authorised
// reader can return it. Everything below is pure: the host module
// (src/host/result-source.ts) owns storage, the envelope row and retrieval.
// ---------------------------------------------------------------------------

/** An old result the loop slims keeps at most this many bytes, marker included. */
export const RESULT_SLIM_BUDGET = 512;
/** One exact-range read returns at most this many source bytes. */
export const RESULT_RANGE_CAP = 8_192;
export const RESULT_MEDIA_TYPE = "text/plain; charset=utf-8";
/** The reader capability the host can authorise (the probe_log tool). */
export const RESULT_READER = "probe_log";

export type ResultCompleteness = "complete" | "producer_truncated" | "redacted";
export type ResultRecovery = "available" | "unavailable" | "not_applicable";

/** Where the safe bytes live. `unstored` is a source the host could not keep
 * (the store refused, or the envelope append was refused): its omitted bytes
 * are unavailable and no handle is ever shown for it. */
export type ResultSourceLocation =
  | { readonly kind: "blob"; readonly digest: string }
  | { readonly kind: "unstored"; readonly reason: string };

/** The host-minted source envelope. `resultEvent` is the seq of the
 * `tool/source` row that recorded it (0 when the row could not be appended). */
export interface ResultSource {
  readonly invocationId: string;
  readonly resultEvent: number;
  readonly digest: string;
  readonly sourceBytes: number;
  readonly mediaType: string;
  readonly source: ResultSourceLocation;
  readonly completeness: ResultCompleteness;
}

/** What the model sees of a source. Ranges are half-open UTF-8 byte offsets
 * into the source; `visibleBytes` and `projectionDigest` describe the one
 * content part (`part`) that renders them; the marker between the head and
 * tail range is metadata and counts inside `budget`. */
export interface ResultProjection {
  readonly source: ResultSource;
  readonly part: number;
  readonly budget: number;
  readonly projectionDigest: string;
  readonly visibleBytes: number;
  readonly keptRanges: ReadonlyArray<readonly [number, number]>;
  readonly omittedBytes: number;
  readonly recovery: ResultRecovery;
  readonly readerCapability?: string;
  /** Why recovery is unavailable, stated to the model without naming a tool. */
  readonly limit?: string;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Recovery the host may state for a source right now. */
export function resultRecovery(
  source: ResultSource,
  readerAuthorised: boolean,
): { recovery: ResultRecovery; readerCapability?: string; limit?: string } {
  if (source.source.kind !== "blob") {
    return { recovery: "unavailable", limit: `the source was not stored (${source.source.reason})` };
  }
  if (!readerAuthorised) return { recovery: "unavailable", limit: "this tool profile has no source reader" };
  return { recovery: "available", readerCapability: RESULT_READER };
}

function omissionMarker(
  source: ResultSource,
  gap: readonly [number, number],
  recovery: { recovery: ResultRecovery; limit?: string },
  omitted = gap[1] - gap[0],
): string {
  const [start, end] = gap;
  const facts = source.completeness === "complete" ? "" : `; the source is ${source.completeness.replace("_", "-")}`;
  const how = recovery.recovery === "available" && source.source.kind === "blob"
    ? `recover next unread omission: ${RESULT_READER}(path="blob:${source.source.digest}", recover=true, start_byte=${start}, end_byte=${end})`
    : `not recoverable here: ${recovery.limit ?? "no reader"}`;
  // The leading quote ends any `key=` / `Bearer ` / `?access_token=` / token
  // shape a head piece may stop inside: a quote followed by a newline cannot
  // continue a credential value in any of the redactor's shapes.
  return `'\n[omitted bytes ${start}-${end} of ${source.sourceBytes} (${omitted} bytes)${facts}; ${how}]\n`;
}

/** Head/tail layout inside `budget` bytes, marker included, never cutting a
 * code point. `head` and `tail` are what may be kept: the source itself on
 * the first projection, the currently visible ranges when slimming. */
function layout(
  source: ResultSource,
  head: { text: string; start: 0 },
  tail: { text: string; end: number },
  budget: number,
  recovery: { recovery: ResultRecovery; limit?: string },
): { text: string; keptRanges: Array<[number, number]>; omittedBytes: number } {
  const total = source.sourceBytes;
  // Upper bound of the marker: every number at its widest.
  const widest = omissionMarker(source, [total, total], recovery, total);
  const available = Math.max(0, budget - utf8Bytes(widest));
  const headWant = Math.ceil((available * 2) / 3);
  const tailWant = available - headWant;
  // R3': each piece is checked by itself; the marker between them begins
  // with a character no assignment or token shape can continue.
  const headText = safeCutHead(sliceUtf8BytesHead(head.text, headWant));
  const tailText = safeCutTail(sliceUtf8BytesTail(tail.text, tailWant));
  const headEnd = utf8Bytes(headText);
  const tailStart = tail.end - utf8Bytes(tailText);
  const keptRanges: Array<[number, number]> = [];
  if (headEnd > 0) keptRanges.push([0, headEnd]);
  if (tailStart < tail.end) keptRanges.push([tailStart, tail.end]);
  const marker = omissionMarker(source, [headEnd, tailStart], recovery);
  return { text: `${headText}${marker}${tailText}`, keptRanges, omittedBytes: tailStart - headEnd };
}

/**
 * The first projection of a recorded source: the whole text when it fits the
 * budget, otherwise head and tail around one omission marker.
 */
export function projectResultText(
  text: string,
  source: ResultSource,
  input: { budget: number; part: number; readerAuthorised: boolean },
): { text: string; projection: ResultProjection } {
  const recovery = resultRecovery(source, input.readerAuthorised);
  const total = utf8Bytes(text);
  if (total !== source.sourceBytes) throw new Error("projection source size differs from its envelope");
  if (total <= input.budget) {
    return {
      text,
      projection: finish(source, input.part, input.budget, text, [[0, total]], 0, recovery),
    };
  }
  const laid = layout(source, { text, start: 0 }, { text, end: total }, input.budget, recovery);
  return {
    text: laid.text,
    projection: finish(source, input.part, input.budget, laid.text, laid.keptRanges, laid.omittedBytes, recovery),
  };
}

function finish(
  source: ResultSource,
  part: number,
  budget: number,
  text: string,
  keptRanges: Array<[number, number]>,
  omittedBytes: number,
  recovery: { recovery: ResultRecovery; readerCapability?: string; limit?: string },
): ResultProjection {
  return {
    source,
    part,
    budget,
    projectionDigest: sha256Text(text),
    visibleBytes: utf8Bytes(text),
    keptRanges,
    omittedBytes,
    recovery: omittedBytes === 0 ? "not_applicable" : recovery.recovery,
    ...(omittedBytes > 0 && recovery.readerCapability ? { readerCapability: recovery.readerCapability } : {}),
    ...(omittedBytes > 0 && recovery.limit ? { limit: recovery.limit } : {}),
  };
}

/** The projection a content part carries, when its bytes still are the ones
 * the projection describes. Structure only: nothing is parsed out of text. */
export function readResultProjection(details: unknown): ResultProjection | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = Reflect.get(details, "result_source");
  if (!value || typeof value !== "object") return undefined;
  const p = value as ResultProjection;
  const s = p.source as ResultSource | undefined;
  const ranges = p.keptRanges;
  if (!s || typeof s !== "object" || typeof s.sourceBytes !== "number" || typeof s.digest !== "string") return undefined;
  if (!s.source || (s.source.kind !== "blob" && s.source.kind !== "unstored")) return undefined;
  if (!Number.isInteger(p.part) || p.part < 0 || typeof p.projectionDigest !== "string" || !Array.isArray(ranges)) return undefined;
  if (ranges.length > 2 || ranges.some((range) => !Array.isArray(range) || range.length !== 2
    || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] < 0 || range[0] >= range[1] || range[1] > s.sourceBytes)) {
    return undefined;
  }
  return p;
}

/**
 * Slim one projected part to `budget` bytes. The kept ranges only narrow —
 * every byte still shown lies inside the previous ranges — and the result
 * depends only on (source, budget, recovery), so slimming the same part again
 * under the same budget returns the same bytes. `undefined` when the part no
 * longer holds the projected bytes (the caller then treats it as unprojected).
 */
export function reprojectResultText(
  visible: string,
  projection: ResultProjection,
  input: { budget: number; readerAuthorised: boolean },
): { text: string; projection: ResultProjection } | undefined {
  if (sha256Text(visible) !== projection.projectionDigest || utf8Bytes(visible) !== projection.visibleBytes) return undefined;
  const source = projection.source;
  const total = source.sourceBytes;
  const recovery = resultRecovery(source, input.readerAuthorised);
  const ranges = projection.keptRanges;
  const whole = ranges.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === total;
  if (whole) {
    if (projection.visibleBytes <= input.budget) return { text: visible, projection };
    const laid = layout(source, { text: visible, start: 0 }, { text: visible, end: total }, input.budget, recovery);
    return {
      text: laid.text,
      projection: finish(source, projection.part, input.budget, laid.text, laid.keptRanges, laid.omittedBytes, recovery),
    };
  }
  const bytes = Buffer.from(visible, "utf8");
  const headRange = ranges.find((range) => range[0] === 0);
  const tailRange = ranges.find((range) => range[1] === total && range[0] !== 0);
  const headLength = headRange ? headRange[1] : 0;
  const tailLength = tailRange ? total - tailRange[0] : 0;
  if (headLength + tailLength > bytes.length) return undefined;
  const headText = bytes.subarray(0, headLength).toString("utf8");
  const tailText = bytes.subarray(bytes.length - tailLength).toString("utf8");
  if (utf8Bytes(headText) !== headLength || utf8Bytes(tailText) !== tailLength) return undefined;
  const sameRecovery = recovery.recovery === projection.recovery && (recovery.limit ?? "") === (projection.limit ?? "");
  if (projection.visibleBytes <= input.budget && sameRecovery) return { text: visible, projection };
  const laid = layout(source, { text: headText, start: 0 }, { text: tailText, end: total }, input.budget, recovery);
  // Never widen: a budget above what is shown keeps what is shown.
  const narrowed = laid.keptRanges.every(([start, end]) => ranges.some(([from, to]) => start >= from && end <= to));
  if (!narrowed) return undefined;
  return {
    text: laid.text,
    projection: finish(source, projection.part, input.budget, laid.text, laid.keptRanges, laid.omittedBytes, recovery),
  };
}

/**
 * R3' at a cut, checked on each emitted piece BY ITSELF: a safe source can
 * hold `Xghp_…` or `password=%AAAA…` that the redactor rightly leaves alone in
 * context, and a cut can expose a credential shape. The piece is shortened
 * inward by exactly the credential-shaped span — a head loses everything from
 * the earliest such span on, a tail everything up to the end of the last —
 * and never more. The piece stays a byte range of the source, so the kept
 * ranges stay true.
 */
function safeCutHead(piece: string): string {
  let out = piece;
  while (out.length > 0) {
    const spans = secretSpans(out);
    if (spans.length === 0) return out;
    const cut = Math.min(...spans.map(([start]) => start));
    // Assignment patterns include their preceding delimiter in the match.
    // Keep that harmless delimiter while dropping the credential-shaped span.
    const delimiter = out[cut];
    out = out.slice(0, cut + (delimiter && /[^\p{L}\p{N}_]/u.test(delimiter) ? 1 : 0));
  }
  return out;
}

function safeCutTail(piece: string): string {
  let out = piece;
  while (out.length > 0) {
    const spans = secretSpans(out);
    if (spans.length === 0) return out;
    out = out.slice(Math.max(...spans.map(([, end]) => end)));
  }
  return out;
}

/** Slim text that carries no recorded source: byte-accurate, code point
 * safe, and honest that the omitted bytes cannot be read back. */
export function slimUnsourcedText(text: string, budget: number): string {
  const total = utf8Bytes(text);
  if (total <= budget) return text;
  const marker = (dropped: number) => `'\n[context-slimmed ${dropped} bytes; not recoverable: no recorded source]\n`;
  const available = Math.max(0, budget - utf8Bytes(marker(total)));
  const head = safeCutHead(sliceUtf8BytesHead(text, Math.ceil(available / 2)));
  const tail = safeCutTail(sliceUtf8BytesTail(text, available - Math.ceil(available / 2)));
  return `${head}${marker(total - utf8Bytes(head) - utf8Bytes(tail))}${tail}`;
}
