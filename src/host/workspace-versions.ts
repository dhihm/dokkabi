import { isSecretPath as isSecretWorkspacePath } from "./workspace-secrets.ts";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { truncateHead } from "@earendil-works/pi-agent-core";
import { containsSecret, redactText, redactTextWithSpans } from "./redact.ts";
import { expandHomePath } from "./workspace-path.ts";
import { onToolResultDelivered, type DeliveredToolResult } from "../tools/delivery.ts";
import type { EventInput, EventRecord } from "./schema.ts";

/**
 * VERSION-AWARE FILE MUTATIONS (#221, design memo §125).
 *
 * Authority to change a file is a host-minted receipt of what the model was
 * actually shown; every mutation is checked against the live target at the
 * last instant before the write, inside one per-file queue; unknown coverage
 * is never harmless.
 *
 * M1 A read receipt binds the root's identity (device and inode), the path
 *    (as the volume folds it), the sha256 of the bytes the host read, the
 *    object's identity, and the byte ranges the model was SHOWN after the
 *    read's projection (line selection, truncation). Only a registered read
 *    caller mints one (object identity, never a tool name); ids are random
 *    and never taken from the model. A projection that changed bytes
 *    (redaction, invalid UTF-8, an image) has no mapping to file bytes: its
 *    receipt carries no range authority.
 * M2 A full write of an existing file needs the union of this session's live
 *    receipts of the file's CURRENT version to cover every byte; an edit
 *    needs every replaced span inside those ranges, matched unambiguously
 *    (Pi's exact-edit rule). A create is exclusive. A target whose identity
 *    changed is `target_changed`, whose bytes changed `stale_read`; both
 *    leave the bytes untouched.
 * M3 The final identity and digest check and the write run synchronously in
 *    one call (`TargetIo.rewrite` / `create`), inside the per-file queue; the
 *    write lands through the link-safe module (or the Linux fd anchor) on the
 *    inode that was checked. The guarantee is `checked_native`: participating
 *    writers serialise; external writers are not mediated, only detected.
 * M4 Intent is recorded before the effect, the commit (before/after
 *    versions) after it. A record failure after the effect is `unresolved`
 *    — never retried, never reported as a failed write. Observers see each
 *    committed effect exactly once. A commit invalidates every earlier
 *    receipt of the path and mints the after-version's receipt from what the
 *    caller authored. A restart restores recorded receipts; every use
 *    re-verifies the live target. A read-only log (replay, dashboard) never
 *    mutates.
 * M5 One API (`authorize` / `commit` / `committed` / `onCommitted`) for the
 *    native tools and for consumers (#228, #229).
 * M6 Receipts per session and ranges per receipt are capped with explicit
 *    truncation; the binding (Linux fd-anchored or portable link-safe) is a
 *    recorded capability.
 */

export const CHECKED_NATIVE = "checked_native" as const;
/** Live receipts kept per session; the oldest are evicted beyond this. */
export const RECEIPTS_MAX = 1024;
/** Ranges kept per receipt; a longer list is truncated (less authority). */
export const RANGES_MAX = 64;

export type Binding = "linux_fd_anchored" | "portable_link_safe";
/** Half-open byte range [start, end) of the file's bytes. */
export type ByteRange = readonly [number, number];

export interface FileVersion {
  readonly rootId: string;
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly objectIdentity?: string;
}

export interface ReadReceipt {
  readonly id: string;
  readonly version: FileVersion;
  /** The seq of the row that recorded it (0 without a log). */
  readonly sourceEvent: number;
  readonly projectionDigest: string;
  readonly visibleByteRanges: readonly ByteRange[];
  readonly coverage: "complete" | "partial";
  /** `unknown`: the projection changed bytes; the receipt has no range authority. */
  readonly mapping: "exact" | "unknown";
  /** Shown only redacted (M2'): unavailable to the file tools, never "unread". */
  readonly unavailableRanges: readonly ByteRange[];
  readonly rangesTruncated: boolean;
  /** The registered tool that minted it. */
  readonly tool: string;
  /** Mint order within the session. */
  readonly order: number;
}

export interface CommitReceipt {
  readonly operationId: string;
  readonly before?: FileVersion;
  readonly after: FileVersion;
  readonly readReceipt?: string;
  readonly guarantee: typeof CHECKED_NATIVE;
  readonly binding: Binding;
  readonly tool: string;
  /** The after-version's receipt, when the caller's knowledge of it is exact. */
  readonly successor?: string;
}

export type RefusalCode = "read_required" | "stale_read" | "target_changed" | "span_unobserved" | "ambiguous_span" | "unknown";

/** A refused mutation: nothing was written. */
export class MutationRefusal extends Error {
  constructor(readonly code: RefusalCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "MutationRefusal";
  }
}

export interface VersionCapabilities {
  readonly guarantee: typeof CHECKED_NATIVE;
  readonly binding: Binding;
  /** Whether an open refuses a link in ANY path component atomically. */
  readonly openNoFollowAny: boolean;
  readonly externalWriters: "not_mediated";
  readonly compareAndSwap: "none";
  readonly receiptsMax: number;
  readonly rangesMax: number;
}

export interface EditSpec {
  readonly oldText: string;
  readonly newText: string;
}

/** A host-computed byte span over a pinned version (#229 rename plans). */
export interface SpanSpec {
  readonly start: number;
  readonly end: number;
  readonly replacement: string | Uint8Array;
}

/**
 * A host-minted plan of byte spans (#229 M7): one per rename plan, minted by
 * the authority itself for a registered writer (`mintSpansPlan`, reached
 * only through the host's `mintWorkspaceSpansPlan`), keyed by the folded
 * path, frozen, and recognised by identity — a `spans` change is honoured
 * only for a plan minted here, and the spans and before digest applied are
 * the PLAN's, never the caller's.
 */
export interface SpansPlanTarget {
  readonly beforeDigest: string;
  /** The target's identity (device:inode) at planning (N4'). */
  readonly identity?: string;
  readonly spans: readonly SpanSpec[];
}

export interface SpansPlan {
  readonly ref: string;
  /** The identity of the root the plan was minted for (M7'). */
  readonly rootId: string;
  /** A read view (a Map of copies); the authority applies its own private
   * copy, so nothing done to this view is ever authorised. */
  readonly targets: ReadonlyMap<string, SpansPlanTarget>;
}

/** The authority's private, deep-frozen copy of a plan and its mint-time
 * digest (M7'): per instance, reachable by nothing else. */
interface MintedSpans {
  readonly rootId: string;
  readonly digest: string;
  readonly targets: ReadonlyMap<string, { readonly beforeDigest: string; readonly identity?: string; readonly spans: ReadonlyArray<{ readonly start: number; readonly end: number; readonly replacement: string }> }>;
}


export type MutationChange =
  | { readonly kind: "write"; readonly content: string | Uint8Array }
  | { readonly kind: "edit"; readonly edits: readonly EditSpec[] }
  /** #229 (M2''/M7): byte spans a host-minted plan computed over the exact
   * bytes whose digest it pinned. The model authored neither the spans nor
   * the bytes — only the symbol and the new name, and it was shown the plan's
   * previews — so the authority is the pinned digest of the plan's own
   * target: the live bytes must be that version at the decision and again at
   * the boundary (`stale_read` otherwise), the spans (the plan's, non-empty,
   * never touching) must lie inside them, and the after-version gets no
   * successor receipt (a further edit needs a read). */
  | { readonly kind: "spans"; readonly plan: SpansPlan }
  /** Caller-supplied spans: accepted by the type so a consumer can be told
   * why, refused by the authority every time (M7). */
  | { readonly kind: "spans"; readonly plan?: undefined; readonly beforeDigest: string; readonly spans: readonly SpanSpec[] };

/** What stands at a path now, read by the host. */
export type LiveTarget =
  | { readonly state: "absent" }
  | { readonly state: "file"; readonly bytes: Buffer; readonly identity: string }
  | { readonly state: "other"; readonly detail: string };

/**
 * The final boundary, per binding. `rewrite` opens the existing regular file
 * without following a link, hands `decide` what it holds, and writes what
 * `decide` returns on that same inode with nothing asynchronous in between;
 * `create` makes a new file exclusively (never through a link, never over
 * anything). Both are synchronous.
 */
export interface TargetIo {
  readonly binding: Binding;
  readonly openNoFollowAny: boolean;
  inspect(rel: string): LiveTarget;
  rewrite(rel: string, decide: (current: { readonly bytes: Buffer; readonly identity: string }) => Buffer, written: () => void): { readonly identity: string };
  create(rel: string, bytes: Buffer, written: () => void): { readonly identity: string };
}

/** The event log surface this module needs. */
export interface VersionLog {
  readonly events: readonly EventRecord[];
  readonly isReadOnly: boolean;
  append(input: EventInput): EventRecord;
}

/** Test seam for crash points (property test c): a throw from here is a
 * crash — it propagates and nothing further is recorded. */
export type CrashPoint = "after_intent" | "after_effect" | "after_commit";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

/** The path as a root's volume names it (P2/N2''): the existing part
 * resolved by the file system itself (case and normalisation folded as it
 * folds them, the `~/…` spelling included), the rest as given. Undefined
 * outside the root. The one fold every key of the authority and of #229's
 * plans goes through. */
export function foldWorkspaceKey(root: string, rel: string): string | undefined {
  const absolute = resolve(root, expandHomePath(rel));
  let real: string;
  try {
    real = realpathSync.native(absolute);
  } catch {
    try {
      real = join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      real = absolute;
    }
  }
  const inside = relative(root, real);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || resolve(root, inside) !== real) return undefined;
  return inside.split(sep).join("/");
}

/** Apply pinned byte spans (M2''/N2'): each non-empty, inside the bytes, in
 * order, never touching the previous one (two identifier occurrences cannot
 * be adjacent; an empty span is nothing); the result and the edit spans. */
export function applySpans(bytes: Buffer, spans: readonly SpanSpec[]): { readonly final: Buffer; readonly spans: EditSpan[] } | string {
  if (spans.length === 0) return "no spans";
  const sorted = spans.map((span, index) => ({ ...span, index })).sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: Buffer[] = [];
  const out: EditSpan[] = [];
  let cursor = 0;
  for (const [order, span] of sorted.entries()) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end > bytes.length) return "span outside the bytes";
    if (span.end <= span.start) return "empty span";
    if (order > 0 && span.start <= cursor) return "overlapping or adjacent spans";
    const replacement = asBuffer(span.replacement);
    if (replacement.length === 0) return "empty replacement";
    parts.push(bytes.subarray(cursor, span.start), replacement);
    out.push({ start: span.start, end: span.end, replacement, index: span.index });
    cursor = span.end;
  }
  parts.push(bytes.subarray(cursor));
  return { final: Buffer.concat(parts), spans: out };
}

/** Mutation authority shares the host file-name policy without a plugin. */
export { isSecretPath as isSecretWorkspacePath } from "./workspace-secrets.ts";

// ---------------------------------------------------------------- ranges

/** Sorted, merged, bounded; adjacent ranges join. */
export function normaliseRanges(ranges: readonly ByteRange[]): ByteRange[] {
  const sorted = ranges
    .filter(([start, end]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start)
    .map(([start, end]) => [start, end] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push(range);
  }
  return out;
}

/** Whether [start, end) lies inside one range of a normalised list. An
 * empty span at `start` needs a range that holds `start` (end inclusive). */
export function rangesCover(ranges: readonly ByteRange[], start: number, end: number): boolean {
  return ranges.some(([s, e]) => s <= start && end <= e && (start < end || start <= e));
}

export function rangesComplete(ranges: readonly ByteRange[], size: number): boolean {
  if (size === 0) return true;
  return rangesCover(normaliseRanges(ranges), 0, size);
}

/** Cap a range list: the first RANGES_MAX survive (less authority, never more). */
export function capRanges(ranges: readonly ByteRange[], max = RANGES_MAX): { readonly ranges: ByteRange[]; readonly truncated: boolean } {
  const merged = normaliseRanges(ranges);
  return merged.length > max ? { ranges: merged.slice(0, max), truncated: true } : { ranges: merged, truncated: false };
}

/** The ranges of a version, carried through replaced spans (sorted,
 * disjoint, each inside one range): positions after a span shift by its
 * length change; the replacement itself is authored, so it stays observed. */
export function mapRangesThroughSpans(ranges: readonly ByteRange[], spans: readonly EditSpan[]): ByteRange[] {
  const map = (position: number): number => {
    let shift = 0;
    for (const span of spans) if (span.end <= position) shift += span.replacement.length - (span.end - span.start);
    return position + shift;
  };
  return normaliseRanges(ranges.map(([start, end]) => [map(start), map(end)] as ByteRange));
}

// ---------------------------------------------------------- read projection

/**
 * What a read shows of the file (M1', M2'): the file body (decoded exactly,
 * its BOM apart), the character span of it the tool's text shows, and the
 * text itself. Mirrors Pi's projection — offset/limit line selection,
 * `truncateHead` — or, for a line longer than the read window, the window
 * of that line the registered read shows instead. Undefined: the tool's
 * output is not the file's bytes (an image, invalid UTF-8, anything the
 * result does not start with).
 */
export interface ShownProjection {
  readonly body: string;
  readonly bomBytes: number;
  readonly charStart: number;
  readonly charEnd: number;
  /** The text the tool returned for [charStart, charEnd). */
  readonly text: string;
  /** Whether the newline after the last shown line counts (more lines follow). */
  readonly impliedNewline: boolean;
}

export function projectPiRead(
  bytes: Buffer,
  params: { readonly offset?: unknown; readonly limit?: unknown },
  resultText: string,
  resultHasImage: boolean,
  window?: { readonly chars: number },
): ShownProjection | undefined {
  if (resultHasImage) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const body = text.slice(bom);
  const bomBytes = bom === 1 ? 3 : 0;
  const offset = typeof params.offset === "number" ? params.offset : undefined;
  const limit = typeof params.limit === "number" ? params.limit : undefined;
  const allLines = body.split("\n");
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  if (!(startLine < allLines.length)) return undefined;
  const skipped = Math.trunc(startLine);
  let charStart = 0;
  for (let index = 0; index < skipped; index += 1) charStart += allLines[index]!.length + 1;
  let visible: string;
  let impliedNewline = true;
  if (window !== undefined) {
    // A single line longer than the read window: the registered read shows
    // its first bytes (a range like any other, bounded by the window).
    visible = allLines[skipped]!.slice(0, window.chars);
    impliedNewline = visible.length === allLines[skipped]!.length;
  } else {
    const selected = limit !== undefined
      ? allLines.slice(startLine, Math.min(startLine + limit, allLines.length)).join("\n")
      : allLines.slice(startLine).join("\n");
    const truncation = truncateHead(selected);
    visible = truncation.firstLineExceedsLimit ? "" : truncation.content;
  }
  if (!resultText.startsWith(visible) || !body.startsWith(visible, charStart)) return undefined;
  return { body, bomBytes, charStart, charEnd: charStart + visible.length, text: visible, impliedNewline };
}

/**
 * The byte ranges of `shown` the model was GIVEN, read off the delivered
 * text (M1', M2'): the text as returned — all of it; the same text with only
 * its line endings normalised — all of it (newline-only normalisation is
 * byte-mapped); the text with credential-shaped spans redacted as the loop
 * redacts them (per line) — every byte outside the redacted spans, which are
 * reported `unavailable`; anything else — nothing, all `unavailable`. The
 * BOM counts as shown when the view starts at the body's start; the newline
 * after the last shown line counts when more lines follow.
 */
export function deliveredRanges(
  shown: ShownProjection,
  delivered: string,
): { readonly ranges: ByteRange[]; readonly unavailable: ByteRange[]; readonly mapping: "exact" | "unknown" } {
  const { body, bomBytes, charStart, charEnd } = shown;
  const byteAt = (() => {
    // Byte offsets of a few char positions without an O(n) scan per call.
    const base = bomBytes + Buffer.byteLength(body.slice(0, charStart), "utf8");
    return (char: number) => base + Buffer.byteLength(body.slice(charStart, char), "utf8");
  })();
  const endChar = charEnd < body.length && body[charEnd] === "\n" && shown.impliedNewline && shown.text.length > 0 ? charEnd + 1 : charEnd;
  const startByte = charStart === 0 ? 0 : byteAt(charStart);
  const whole: ByteRange = [startByte, byteAt(endChar)];
  const none = { ranges: [] as ByteRange[], unavailable: whole[1] > whole[0] ? [whole] : [], mapping: "unknown" as const };
  if (shown.text.length === 0) {
    // An empty view of an empty body shows the whole (possibly BOM-only) file.
    return body.length === 0 ? { ranges: [[0, bomBytes]], unavailable: [], mapping: "exact" } : { ranges: [], unavailable: [], mapping: "exact" };
  }
  if (delivered.startsWith(shown.text) || toLf(delivered).startsWith(toLf(shown.text))) {
    return { ranges: [whole], unavailable: [], mapping: "exact" };
  }
  // M2'': the redactor's own records of what it replaced, per line (the
  // loop redacts the whole text; per-line redaction must produce the same).
  const lines = shown.text.split("\n");
  const redactedLines = lines.map((line) => redactTextWithSpans(line));
  const redacted = redactedLines.map((line) => line.text).join("\n");
  if (redacted !== redactText(shown.text) || !delivered.startsWith(redacted)) return none;
  const ranges: ByteRange[] = [];
  const unavailable: ByteRange[] = [];
  let lineStart = charStart;
  for (const [index, line] of lines.entries()) {
    const spans = redactedLines[index]!.spans;
    const lineEnd = lineStart + line.length;
    const newlineEnd = index < lines.length - 1 ? lineEnd + 1 : endChar;
    let shownFrom = lineStart;
    const open = (from: number, to: number) => {
      if (to <= from && !(from === charStart && charStart === 0 && bomBytes > 0)) return;
      ranges.push([from === charStart && charStart === 0 ? 0 : byteAt(from), byteAt(to)]);
    };
    for (const [spanStart, spanEnd] of spans) {
      open(shownFrom, lineStart + spanStart);
      unavailable.push([byteAt(lineStart + spanStart), byteAt(lineStart + spanEnd)]);
      shownFrom = lineStart + spanEnd;
    }
    open(shownFrom, newlineEnd);
    lineStart = lineEnd + 1;
  }
  return { ranges: normaliseRanges(ranges), unavailable: normaliseRanges(unavailable), mapping: "exact" };
}

// ------------------------------------------------------------ edit planning

export interface EditSpan {
  /** Replaced bytes of the base, [start, end). */
  readonly start: number;
  readonly end: number;
  readonly replacement: Buffer;
  readonly index: number;
}

export type EditPlan =
  /** Pi will refuse the call on its own (not found, empty, overlap, no change). */
  | { readonly kind: "pi_error" }
  | { readonly kind: "ambiguous"; readonly index: number; readonly occurrences: number }
  /** `final`: the bytes Pi will write, when predicted; `spans`: the replaced
   * byte spans, when the rest of the file provably keeps its bytes. */
  | { readonly kind: "ok"; readonly final?: Buffer; readonly spans?: readonly EditSpan[] };

function fuzzy(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, "\"")
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * What Pi's exact edit will do to `bytes` (the env hands Pi the text decoded
 * with its BOM kept): the same matching rules — LF-normalised, a fuzzy
 * fallback, ambiguity counted in the fuzzy space — decided here so a
 * refusal can be classified and the replaced spans placed in file bytes.
 * The env holds the prediction to Pi's actual output before anything is
 * written; a mismatch is an unknown mapping, never a wider authority.
 */
export function planEdits(bytes: Buffer, edits: readonly EditSpec[]): EditPlan {
  if (!Array.isArray(edits) || edits.length === 0) return { kind: "pi_error" };
  if (edits.some((edit) => typeof edit?.oldText !== "string" || typeof edit?.newText !== "string")) return { kind: "pi_error" };
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const exactBytes = Buffer.from(text, "utf8").equals(bytes);
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const content = text.slice(bom.length);
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  const ending = lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n";
  const normalized = toLf(content);
  const wanted = edits.map((edit) => ({ oldText: toLf(edit.oldText), newText: toLf(edit.newText) }));
  if (wanted.some((edit) => edit.oldText.length === 0)) return { kind: "pi_error" };
  const findIn = (haystack: string, needle: string): { index: number; length: number; fuzzy: boolean } | undefined => {
    const exact = haystack.indexOf(needle);
    if (exact !== -1) return { index: exact, length: needle.length, fuzzy: false };
    const space = fuzzy(haystack);
    const want = fuzzy(needle);
    const index = space.indexOf(want);
    return index === -1 ? undefined : { index, length: want.length, fuzzy: true };
  };
  const usedFuzzy = wanted.some((edit) => findIn(normalized, edit.oldText)?.fuzzy === true);
  const base = usedFuzzy ? fuzzy(normalized) : normalized;
  // Pi counts occurrences in the fuzzy space, even for an exact match.
  const fuzzyBase = fuzzy(base);
  const matches: { index: number; length: number; newText: string; edit: number }[] = [];
  for (const [index, edit] of wanted.entries()) {
    const found = findIn(base, edit.oldText);
    if (found === undefined) return { kind: "pi_error" };
    const occurrences = fuzzyBase.split(fuzzy(edit.oldText)).length - 1;
    if (occurrences > 1) return { kind: "ambiguous", index, occurrences };
    matches.push({ index: found.index, length: found.length, newText: edit.newText, edit: index });
  }
  matches.sort((a, b) => a.index - b.index);
  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index - 1]!.index + matches[index - 1]!.length > matches[index]!.index) return { kind: "pi_error" };
  }
  // A fuzzy match rewrites whole lines from the normalised base: the result
  // is Pi's to compute, and no span of the base can be named.
  if (usedFuzzy) return { kind: "ok" };
  let next = normalized;
  for (const match of [...matches].reverse()) {
    next = next.slice(0, match.index) + match.newText + next.slice(match.index + match.length);
  }
  if (next === normalized) return { kind: "pi_error" };
  const final = Buffer.from(bom + (ending === "\r\n" ? next.replace(/\n/g, "\r\n") : next), "utf8");
  if (!exactBytes) return { kind: "ok", final };
  // Normalised index → index in `content` (a CRLF pair is one normalised
  // character), then → byte offset in the file.
  const toContent = new Uint32Array(normalized.length + 1);
  let source = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    toContent[index] = source;
    source += content[source] === "\r" && content[source + 1] === "\n" ? 2 : 1;
  }
  toContent[normalized.length] = source;
  const byteOffset = (contentIndex: number) => Buffer.byteLength(bom, "utf8") + Buffer.byteLength(content.slice(0, contentIndex), "utf8");
  const spans: EditSpan[] = matches.map((match) => ({
    start: byteOffset(toContent[match.index]!),
    end: byteOffset(toContent[match.index + match.length]!),
    replacement: Buffer.from(ending === "\r\n" ? match.newText.replace(/\n/g, "\r\n") : match.newText, "utf8"),
    index: match.edit,
  }));
  // The spans are exact only when splicing them into the base gives Pi's
  // bytes: mixed line endings or a lone CR change bytes outside them.
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(bytes.subarray(cursor, span.start), span.replacement);
    cursor = span.end;
  }
  parts.push(bytes.subarray(cursor));
  return Buffer.concat(parts).equals(final) ? { kind: "ok", final, spans } : { kind: "ok", final };
}

/** Pi's read window per call: a line longer than this is shown only as its
 * first window (M2'). */
const READ_WINDOW_BYTES = 50 * 1024;

/** Whether a span touches a line longer than the read window, past its window. */
function onLongLine(bytes: Buffer, start: number, end: number): boolean {
  const lineStart = start > 0 ? bytes.lastIndexOf(0x0a, start - 1) + 1 : 0;
  const newline = bytes.indexOf(0x0a, lineStart);
  const lineEnd = newline === -1 ? bytes.length : newline;
  return lineEnd - lineStart > READ_WINDOW_BYTES && Math.max(end, start + 1) > lineStart + READ_WINDOW_BYTES - 4;
}

/** 1-based line numbers of a byte span, for a refusal the model can act on. */
function linesOf(bytes: Buffer, start: number, end: number): string {
  let line = 1;
  for (let index = 0; index < start && index < bytes.length; index += 1) if (bytes[index] === 0x0a) line += 1;
  let last = line;
  for (let index = start; index < Math.max(start, end - 1) && index < bytes.length; index += 1) if (bytes[index] === 0x0a) last += 1;
  return last === line ? `line ${line}` : `lines ${line}-${last}`;
}

// ------------------------------------------------------------ the queue

/** One queue per (root, folded path) for the whole process: every
 * participating writer — both native tools, every session's tools on the
 * same root, and API consumers — waits its turn (M3). */
const QUEUES = new Map<string, Promise<void>>();

export async function withFileQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = QUEUES.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((done) => { release = done; });
  const chained = previous.then(() => mine);
  QUEUES.set(key, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (QUEUES.get(key) === chained) QUEUES.delete(key);
  }
}

// ------------------------------------------------------------ the provider

/** A registered caller: the object identity of a host tool, never a name. */
export type CallerRole = "read" | "write";

/** What a mutation will do, decided against the live target. */
export interface Decision {
  readonly create: boolean;
  readonly before?: { readonly identity: string; readonly digest: string; readonly size: number };
  /** The bytes to write; undefined when only the caller's writer knows them
   * (a fuzzy Pi edit under a complete receipt). */
  readonly final?: Buffer;
  readonly receipts: readonly string[];
  /** The after-version's ranges; undefined: complete. */
  readonly successorRanges?: readonly ByteRange[];
  /** The withheld (redacted) spans, carried to the after-version (M2'). */
  readonly successorUnavailable?: readonly ByteRange[];
  readonly complete: boolean;
  readonly spans?: readonly EditSpan[];
  /** The bytes this decision was made on, when the same operation holds
   * them (compared byte for byte at the boundary instead of hashed again). */
  readonly beforeBytes?: Buffer;
}

/** Authority for one checked mutation (M5). Unforgeable: only grants this
 * provider made are honoured, each once. */
export interface MutationGrant {
  readonly operationId: string;
  readonly path: string;
  readonly tool: string;
  readonly before?: FileVersion;
  readonly afterDigest?: string;
}

export type MutationDecision =
  | { readonly ok: true; readonly grant: MutationGrant }
  | { readonly ok: false; readonly code: RefusalCode; readonly detail: string };

export type CommitOutcome =
  | { readonly status: "committed"; readonly receipt: CommitReceipt }
  /** `boundary`: the target itself failed the boundary's guards (a link, not
   * a regular file, a second name, an I/O refusal) — not a version decision. */
  | { readonly status: "refused"; readonly code: RefusalCode; readonly detail: string; readonly boundary?: true }
  /** The effect happened (or may have) and could not be recorded or verified. */
  | { readonly status: "unresolved"; readonly operationId: string; readonly detail: string };

interface GrantState {
  readonly key: string;
  readonly rel: string;
  readonly tool: string;
  readonly callId: string;
  readonly change: MutationChange;
  readonly decision: Decision;
  used: boolean;
}

/** One mutation from intent to its closing row. Opaque outside this module. */
export interface Operation {
  readonly id: string;
  readonly key: string;
  readonly rel: string;
  readonly tool: string;
  readonly callId: string;
  readonly kind: "write" | "edit" | "create" | "spans";
  readonly route: "native" | "promotion" | "api";
  readonly decision: Decision;
  readonly receiptId?: string;
  intentSeq?: number;
  effected: boolean;
  closed: boolean;
  after?: { readonly identity: string; readonly digest: string; readonly size: number };
}

/** A decision point (M1', M4'): the receipts a call may use are those
 * recorded before the model decided on the call — before the assistant
 * message that carries it (`seq`), or, without a loop, before the call was
 * admitted (`order`). A receipt minted while the call waited (a sibling in
 * the same batch committing an edit) is not the call's to use. */
export interface DecisionPoint {
  readonly seq?: number;
  readonly order: number;
}

/** The consumer surface provided as `workspace_versions` (M5'): exactly
 * these five methods, through a facade. */
export interface WorkspaceVersionsApi {
  authorize(input: {
    readonly caller: object;
    readonly path: string;
    readonly receiptId?: string;
    readonly change: MutationChange;
    readonly callId?: string;
    /** The consumer's tool name for the rows and receipts (default `api`). */
    readonly tool?: string;
  }): Promise<MutationDecision>;
  commit(grant: MutationGrant): Promise<CommitOutcome>;
  committed(receipt: CommitReceipt): boolean;
  onCommitted(observer: (receipt: CommitReceipt) => void): () => void;
  /** M7'': mint a spans plan this authority will apply (#229); a facade
   * without it makes rename `unsupported`. */
  mintSpansPlan?(targets: ReadonlyArray<{ readonly path: string; readonly beforeDigest: string; readonly identity?: string; readonly spans: readonly SpanSpec[] }>): SpansPlan | undefined;
}

interface PendingRead {
  readonly callId: string;
  readonly tool: string;
  readonly key: string;
  readonly bytes: Buffer;
  readonly identity: string;
  readonly shown: ShownProjection | undefined;
}

/** Pending reads kept per session until their result is delivered. */
const PENDING_MAX = 64;

export class WorkspaceVersions implements WorkspaceVersionsApi {
  readonly root: string;
  readonly rootId: string;
  readonly capabilities: VersionCapabilities;
  private readonly receipts = new Map<string, ReadReceipt>();
  private readonly byKey = new Map<string, Set<string>>();
  private readonly callers = new WeakMap<object, CallerRole>();
  private readonly grants = new WeakMap<MutationGrant, GrantState>();
  /** M7': the plans this instance minted, by identity, with private copies. */
  private readonly mintedSpans = new WeakMap<SpansPlan, MintedSpans>();
  private readonly observers = new Set<(receipt: CommitReceipt) => void>();
  private readonly projected = new Set<string>();
  private readonly minted = new Set<string>();
  private order = 0;
  private revoked = false;
  private readonly pending = new Map<string, PendingRead>();
  private readonly unsubscribe: () => void;
  /** Operations whose effect could not be recorded (shown, never retried). */
  readonly unresolved: string[] = [];
  observerFailures = 0;

  constructor(private readonly input: {
    readonly root: string;
    readonly io: TargetIo;
    readonly log?: VersionLog;
    readonly crash?: (point: CrashPoint, operationId: string) => void;
  }) {
    this.root = realpathSync.native(resolve(input.root));
    const stat = statSync(this.root, { bigint: true });
    this.rootId = `${stat.dev}:${stat.ino}`;
    this.capabilities = Object.freeze({
      guarantee: CHECKED_NATIVE,
      binding: input.io.binding,
      openNoFollowAny: input.io.openNoFollowAny,
      externalWriters: "not_mediated",
      compareAndSwap: "none",
      receiptsMax: RECEIPTS_MAX,
      rangesMax: RANGES_MAX,
    });
    this.restore();
    this.unsubscribe = onToolResultDelivered((delivery) => this.delivered(delivery));
  }

  /** The final boundary of this provider's binding. */
  get io(): TargetIo {
    return this.input.io;
  }

  get readOnly(): boolean {
    return this.input.log?.isReadOnly === true;
  }

  /** Host-only: only the objects registered here mint or use authority. */
  register(caller: object, role: CallerRole): void {
    this.callers.set(caller, role);
  }

  /**
   * Mint a spans plan for a registered writer (M7). Targets are keyed by the
   * folded path; a path outside the root, a secret path, an empty target
   * list, a duplicate key, or invalid spans mint nothing. The plan is frozen
   * and recognised by identity only.
   */
  mintSpansPlan(targets: ReadonlyArray<{ readonly path: string; readonly beforeDigest: string; readonly identity?: string; readonly spans: readonly SpanSpec[] }>): SpansPlan | undefined {
    if (this.revoked || this.readOnly || targets.length === 0) return undefined;
    const copies = new Map<string, { readonly beforeDigest: string; readonly identity?: string; readonly spans: ReadonlyArray<{ readonly start: number; readonly end: number; readonly replacement: string }> }>();
    for (const target of targets) {
      const key = this.key(target.path);
      if (key === undefined || isSecretWorkspacePath(key) || copies.has(key) || !/^[0-9a-f]{64}$/u.test(target.beforeDigest)) return undefined;
      if (target.identity !== undefined && !/^\d+:\d+$/u.test(target.identity)) return undefined;
      const sorted = [...target.spans].sort((a, b) => a.start - b.start || a.end - b.end);
      let cursor = -1;
      const spans: Array<{ readonly start: number; readonly end: number; readonly replacement: string }> = [];
      for (const span of sorted) {
        if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.start <= cursor) return undefined;
        // A primitive copy of the replacement: valid UTF-8, non-empty.
        let replacement: string;
        try {
          replacement = typeof span.replacement === "string" ? span.replacement : new TextDecoder("utf-8", { fatal: true }).decode(span.replacement);
        } catch {
          return undefined;
        }
        if (replacement.length === 0) return undefined;
        spans.push(Object.freeze({ start: span.start, end: span.end, replacement }));
        cursor = span.end;
      }
      if (spans.length === 0) return undefined;
      copies.set(key, Object.freeze({ beforeDigest: target.beforeDigest, ...(target.identity !== undefined ? { identity: target.identity } : {}), spans: Object.freeze(spans) }));
    }
    const digest = sha256(Buffer.from(JSON.stringify([...copies.entries()]), "utf8"));
    const minted: MintedSpans = Object.freeze({ rootId: this.rootId, digest, targets: copies });
    // The public view: fresh copies (Map, Buffers) the authority never reads.
    const view = new Map<string, SpansPlanTarget>();
    for (const [key, target] of copies) {
      view.set(key, Object.freeze({ beforeDigest: target.beforeDigest, ...(target.identity !== undefined ? { identity: target.identity } : {}), spans: Object.freeze(target.spans.map((span) => Object.freeze({ start: span.start, end: span.end, replacement: Buffer.from(span.replacement, "utf8") }))) }));
    }
    const plan: SpansPlan = Object.freeze({ ref: `sp_${randomBytes(16).toString("hex")}`, rootId: this.rootId, targets: view });
    this.mintedSpans.set(plan, minted);
    return plan;
  }

  /** This instance's private copy for `key` (M7'), re-verified against its
   * mint-time digest; a plan this instance did not mint, one minted for
   * another root, or a path the plan does not name, is nothing. */
  private spansTargetOf(change: { readonly plan?: unknown }, key: string): { readonly beforeDigest: string; readonly identity?: string; readonly spans: ReadonlyArray<{ readonly start: number; readonly end: number; readonly replacement: string }> } {
    const plan = change.plan;
    const minted = typeof plan === "object" && plan !== null ? this.mintedSpans.get(plan as SpansPlan) : undefined;
    if (!minted || minted.rootId !== this.rootId) throw new MutationRefusal("unknown", `a spans change needs a plan this authority minted; ${key} was not changed`);
    if (sha256(Buffer.from(JSON.stringify([...minted.targets.entries()]), "utf8")) !== minted.digest) throw new MutationRefusal("unknown", `the plan's contents no longer match what was minted; ${key} was not changed`);
    const target = minted.targets.get(key);
    if (!target) throw new MutationRefusal("unknown", `the plan does not name ${key}`);
    return target;
  }

  /** The path as this root's volume names it: the existing part resolved by
   * the file system itself (case and normalisation folded as it folds them),
   * the rest as given. Undefined outside the root. */
  key(rel: string): string | undefined {
    return foldWorkspaceKey(this.root, rel);
  }


  /** The tools were disposed (plugin unload): every later read, decision and
   * commit refuses, whoever still holds this object. */
  revoke(): void {
    this.revoked = true;
    this.pending.clear();
    this.unsubscribe();
  }

  get isRevoked(): boolean {
    return this.revoked;
  }


  /** The per-process queue key: the folded path, lower-cased and composed
   * too, so two spellings a volume might fold together always serialise. */
  queueKey(key: string): string {
    return `${this.rootId}\0${key.normalize("NFC").toLowerCase()}`;
  }

  /** This session's live receipts of `key`, newest last. */
  receiptsOf(key: string): ReadReceipt[] {
    return [...(this.byKey.get(key) ?? [])].map((id) => this.receipts.get(id)!).sort((a, b) => a.order - b.order);
  }

  // ---------------------------------------------------------------- reads

  /**
   * A registered read tool ran (M1'): what it read and what its text shows
   * are held — NOT a receipt. The receipt is minted only when that text is
   * delivered to the model as the result of its own call (`delivered`); a
   * prefetch or probe running the same tool is shown to no one.
   */
  shownBy(input: {
    readonly caller: object;
    readonly tool: string;
    readonly callId: string;
    readonly rel: string;
    readonly bytes: Buffer;
    readonly identity: string;
    readonly shown: ShownProjection | undefined;
  }): void {
    if (this.revoked || this.callers.get(input.caller) !== "read" || this.readOnly) return;
    const key = this.key(input.rel);
    if (key === undefined) return;
    this.pending.delete(input.callId);
    this.pending.set(input.callId, { callId: input.callId, tool: input.tool, key, bytes: input.bytes, identity: input.identity, shown: input.shown });
    while (this.pending.size > PENDING_MAX) this.pending.delete(this.pending.keys().next().value!);
  }

  /** THE PROJECTION STEP (M1'): a result the loop gives the model for its
   * own call. The call's own pending read — or, for a result served from a
   * prefetch, the pending read of that path whose text the result carries —
   * becomes a receipt of exactly the ranges the delivered text shows. */
  private delivered(delivery: DeliveredToolResult): void {
    if (this.revoked || this.readOnly || delivery.session !== this.input.log) return;
    let pending = this.pending.get(delivery.callId);
    if (pending !== undefined && pending.tool !== delivery.tool) return;
    if (pending === undefined) {
      const path = typeof delivery.args === "object" && delivery.args !== null ? Reflect.get(delivery.args, "path") : undefined;
      const key = typeof path === "string" ? this.key(path) : undefined;
      if (key === undefined) return;
      pending = [...this.pending.values()].reverse().find((candidate) => candidate.tool === delivery.tool && candidate.key === key
        && candidate.shown !== undefined && delivery.text.startsWith(candidate.shown.text) && candidate.shown.text.length > 0);
      if (pending === undefined) return;
    }
    this.pending.delete(pending.callId);
    if (delivery.isError || delivery.hasImage) return;
    const mapped = pending.shown === undefined
      ? { ranges: [] as ByteRange[], unavailable: [] as ByteRange[], mapping: "unknown" as const }
      : deliveredRanges(pending.shown, delivery.text);
    const capped = capRanges(mapped.ranges);
    this.mint({
      version: { rootId: this.rootId, path: pending.key, digest: sha256(pending.bytes), bytes: pending.bytes.length, objectIdentity: pending.identity },
      ranges: capped.ranges,
      unavailable: capRanges(mapped.unavailable).ranges,
      rangesTruncated: capped.truncated,
      mapping: mapped.mapping,
      projectionDigest: sha256(Buffer.from(delivery.text, "utf8")),
      tool: delivery.tool,
      callId: delivery.callId,
      source: "read",
    });
  }

  private mint(input: {
    readonly version: FileVersion;
    readonly ranges: readonly ByteRange[];
    readonly unavailable?: readonly ByteRange[];
    readonly rangesTruncated: boolean;
    readonly mapping: "exact" | "unknown";
    readonly projectionDigest: string;
    readonly tool: string;
    readonly callId: string;
    readonly source: "read" | "commit";
    readonly id?: string;
    readonly seq?: number;
    readonly record?: boolean;
  }): ReadReceipt {
    const id = input.id ?? `wr_${randomBytes(16).toString("hex")}`;
    const coverage = input.mapping === "exact" && rangesComplete(input.ranges, input.version.bytes) ? "complete" : "partial";
    let evicted = 0;
    while (this.receipts.size >= RECEIPTS_MAX) {
      const oldest = [...this.receipts.values()].sort((a, b) => a.order - b.order)[0]!;
      this.drop(oldest.id);
      evicted += 1;
    }
    let sourceEvent = input.seq ?? 0;
    if (input.record !== false && input.source === "read") {
      sourceEvent = this.append("workspace/read_receipt", {
        receipt: id,
        root: this.rootId,
        ...pathFields(input.version.path),
        tool: input.tool,
        call: input.callId,
        digest: input.version.digest,
        bytes: input.version.bytes,
        identity: input.version.objectIdentity ?? null,
        coverage,
        mapping: input.mapping,
        ranges: input.ranges.map(([start, end]) => [start, end]),
        ...((input.unavailable?.length ?? 0) > 0 ? { unavailable: input.unavailable!.map(([start, end]) => [start, end]) } : {}),
        ...(input.rangesTruncated ? { ranges_truncated: true } : {}),
        projection_digest: input.projectionDigest,
        ...(evicted > 0 ? { evicted } : {}),
      }) ?? 0;
    }
    const receipt: ReadReceipt = Object.freeze({
      id,
      version: Object.freeze({ ...input.version }),
      sourceEvent,
      projectionDigest: input.projectionDigest,
      visibleByteRanges: Object.freeze(input.ranges.map((range) => Object.freeze([range[0], range[1]]) as ByteRange)),
      coverage,
      mapping: input.mapping,
      unavailableRanges: Object.freeze((input.unavailable ?? []).map((range) => Object.freeze([range[0], range[1]]) as ByteRange)),
      rangesTruncated: input.rangesTruncated,
      tool: input.tool,
      order: (this.order += 1),
    });
    this.receipts.set(id, receipt);
    const set = this.byKey.get(input.version.path) ?? new Set<string>();
    set.add(id);
    this.byKey.set(input.version.path, set);
    return receipt;
  }

  private drop(id: string): void {
    const receipt = this.receipts.get(id);
    if (!receipt) return;
    this.receipts.delete(id);
    const set = this.byKey.get(receipt.version.path);
    set?.delete(id);
    if (set?.size === 0) this.byKey.delete(receipt.version.path);
  }

  /** A committed change (or an unresolved one) ends every earlier receipt of
   * the path: bytes that returned to an old digest are still not the bytes
   * that receipt's reader saw (M4). */
  private invalidate(key: string): void {
    for (const id of [...(this.byKey.get(key) ?? [])]) this.drop(id);
  }

  // ------------------------------------------------------------ decisions

  /** The authority a live target leaves for `change` (M2). Throws a
   * MutationRefusal; never touches the file. */
  decide(key: string, live: LiveTarget, change: MutationChange, only?: string, point?: DecisionPoint): Decision {
    const all = this.receiptsOf(key);
    const receipts = all.filter((receipt) => (only === undefined || receipt.id === only) && usable(receipt, point));
    if (live.state === "other") throw new MutationRefusal("target_changed", `${key} is not a regular file (${live.detail})`);
    if (live.state === "absent") {
      if (change.kind === "spans") throw new MutationRefusal("target_changed", `${key} does not exist any more; plan again`);
      if (change.kind === "edit") {
        throw new MutationRefusal(all.length > 0 ? "target_changed" : "read_required", `${key} does not exist`);
      }
      // A file this session read is gone (removed, or renamed away for a
      // moment): a write to its name is not a create (P2).
      if (all.length > 0) {
        throw new MutationRefusal("target_changed", `${key} was read in this session and is gone now (removed or moved); check the path and read it again`);
      }
      const final = asBuffer(change.content);
      return { create: true, final, receipts: [], complete: true };
    }
    const digest = sha256(live.bytes);
    const before = { identity: live.identity, digest, size: live.bytes.length };
    if (change.kind === "spans") {
      // M2''/M7'/N4': this instance's private copy of the plan is the
      // authority — identity and digest both; no receipt is read and no
      // caller-supplied span is applied.
      const target = this.spansTargetOf(change, key);
      if (target.identity !== undefined && target.identity !== live.identity) {
        throw new MutationRefusal("target_changed", `${key} is no longer the file the plan was made on (it was replaced); plan again`);
      }
      if (digest !== target.beforeDigest) {
        throw new MutationRefusal("stale_read", `${key} is not the version the plan was made on (its bytes changed); plan again`);
      }
      const applied = applySpans(live.bytes, target.spans);
      if (typeof applied === "string") throw new MutationRefusal("unknown", `the plan's spans for ${key} are invalid (${applied}); plan again`);
      return { create: false, before, final: applied.final, receipts: [], complete: false, spans: applied.spans };
    }
    const verb = change.kind === "write" ? "overwrite" : "edit";
    if (receipts.length === 0 && all.length > 0 && only === undefined) {
      // M4': what this session knows of the path came after this call was
      // decided (a change earlier in the same batch).
      throw new MutationRefusal("read_required",
        `what this session read or changed of ${key} came after this call was made (earlier in the same batch); read it again before you ${verb} it`);
    }
    if (receipts.length === 0) {
      throw new MutationRefusal("read_required",
        `${key} exists and has not been read in this session; read it before you ${verb} it`);
    }
    const sameObject = receipts.filter((receipt) => receipt.version.objectIdentity === live.identity);
    if (sameObject.length === 0) {
      throw new MutationRefusal("target_changed",
        `${key} is no longer the file that was read (it was replaced or recreated); read it again`);
    }
    const current = sameObject.filter((receipt) => receipt.version.digest === digest);
    if (current.length === 0) {
      throw new MutationRefusal("stale_read",
        `${key} changed since it was last read (another writer or a command changed it); read it again`);
    }
    const ranges = normaliseRanges(current.filter((receipt) => receipt.mapping === "exact").flatMap((receipt) => receipt.visibleByteRanges));
    const unavailable = normaliseRanges(current.flatMap((receipt) => receipt.unavailableRanges))
      .filter(([start, end]) => !rangesCover(ranges, start, end));
    const complete = rangesComplete(ranges, live.bytes.length);
    const ids = current.map((receipt) => receipt.id);
    if (change.kind === "write") {
      if (!complete && unavailable.length > 0) {
        throw new MutationRefusal("read_required",
          `${key} holds ${describeUnavailable(unavailable)} the read could only show redacted (credential-like text); those bytes are unavailable to the file tools, so the file cannot be replaced whole with write — edit the shown parts, or use bash`);
      }
      if (!complete) {
        throw new MutationRefusal("read_required",
          `${key} was read only in part (${describeRanges(ranges, live.bytes.length)}); read all of it before you overwrite it`);
      }
      return { create: false, before, final: asBuffer(change.content), receipts: ids, complete: true };
    }
    const plan = planEdits(live.bytes, change.edits);
    if (plan.kind === "ambiguous") {
      throw new MutationRefusal("ambiguous_span",
        `edits[${plan.index}].oldText occurs ${plan.occurrences} times in ${key}; add surrounding context to make it unique`);
    }
    if (plan.kind === "pi_error") return { create: false, before, receipts: ids, complete };
    if (complete) {
      return {
        create: false,
        before,
        ...(plan.final ? { final: plan.final } : {}),
        receipts: ids,
        complete: true,
        ...(plan.spans ? { spans: plan.spans } : {}),
      };
    }
    if (!plan.spans || !plan.final) {
      throw new MutationRefusal("span_unobserved",
        `the edit to ${key} cannot be placed in the bytes that were shown (normalised match or line endings); read the whole file first`);
    }
    for (const span of plan.spans) {
      if (!rangesCover(ranges, span.start, span.end)) {
        if (unavailable.some(([start, end]) => start < Math.max(span.end, span.start + 1) && span.start < end)) {
          throw new MutationRefusal("span_unobserved",
            `edits[${span.index}].oldText in ${key} (${linesOf(live.bytes, span.start, span.end)}) touches bytes the read showed only redacted (credential-like text); they are unavailable to the file tools — change them with bash`);
        }
        if (onLongLine(live.bytes, span.start, span.end)) {
          throw new MutationRefusal("span_unobserved",
            `edits[${span.index}].oldText in ${key} lies at ${linesOf(live.bytes, span.start, span.end)} beyond the part of that long line read can show (its first ${READ_WINDOW_BYTES / 1024} KB); change it with bash`);
        }
        throw new MutationRefusal("span_unobserved",
          `edits[${span.index}].oldText in ${key} lies at ${linesOf(live.bytes, span.start, span.end)}, which no read of this version showed; read that part first`);
      }
    }
    return {
      create: false,
      before,
      final: plan.final,
      receipts: ids,
      complete: false,
      spans: plan.spans,
      successorRanges: mapRangesThroughSpans(ranges, plan.spans),
      successorUnavailable: mapRangesThroughSpans(unavailable, plan.spans),
    };
  }

  // -------------------------------------------------------- the commit path

  /** Start an operation for a registered writer. */
  begin(input: {
    readonly caller: object;
    readonly tool: string;
    readonly callId: string;
    readonly rel: string;
    readonly change: MutationChange;
    readonly route: "native" | "promotion" | "api";
  }): { readonly key: string; readonly operationId: string; readonly point: DecisionPoint } {
    if (this.revoked) throw new MutationRefusal("unknown", "the workspace tools were unloaded; this authority is revoked");
    if (this.callers.get(input.caller) !== "write") throw new MutationRefusal("unknown", "only a registered writer holds mutation authority");
    if (this.readOnly) throw new MutationRefusal("unknown", "this log is read-only (replay or dashboard): nothing is mutated");
    const key = this.key(input.rel);
    if (key === undefined) throw new MutationRefusal("unknown", `${input.rel} does not resolve inside the workspace`);
    return { key, operationId: `wm_${randomBytes(16).toString("hex")}`, point: this.pointOf(input.callId) };
  }

  /** Where the model decided on `callId` (M4'): the assistant message that
   * carries its recorded tool call; else, now. */
  pointOf(callId?: string): DecisionPoint {
    const order = this.order;
    const events = this.input.log?.events;
    if (events === undefined) return { order };
    if (callId !== undefined && callId !== "") {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (event.name !== "tool/call" || Reflect.get(event.payload, "id") !== callId) continue;
        for (let back = index - 1; back >= 0; back -= 1) {
          if (events[back]!.name === "assistant/message") return { seq: events[back]!.seq, order };
        }
        return { seq: event.seq, order };
      }
    }
    return { seq: (events.at(-1)?.seq ?? 0) + 1, order };
  }

  /**
   * THE FINAL BOUNDARY (M3): check and write in one synchronous run. For an
   * existing file the live bytes are read through the descriptor that will
   * be written, identity and digest compared, intent recorded, then written
   * — nothing asynchronous in between. `expected` (a decision made earlier
   * in the same operation) must still describe what the descriptor holds.
   * `writerFinal` is the bytes a native tool computed (Pi's own edit output);
   * under a partial receipt it must equal the prediction whose spans were
   * checked. Every refusal here is recorded; nothing is written then.
   */
  land(input: {
    readonly io: TargetIo;
    readonly operationId: string;
    readonly key: string;
    readonly rel: string;
    readonly tool: string;
    readonly callId: string;
    readonly change: MutationChange;
    readonly route: "native" | "promotion" | "api";
    readonly expected?: Decision;
    readonly writerFinal?: Buffer;
    readonly only?: string;
    /** An operation whose intent is already recorded (the promotion route). */
    readonly op?: Operation;
    readonly point?: DecisionPoint;
  }): CommitOutcome {
    if (this.revoked) {
      return { status: "refused", code: "unknown", detail: "the workspace tools were unloaded; this authority is revoked" };
    }
    const holder: { op?: Operation } = input.op ? { op: input.op } : {};
    let decided = false;
    const open = (decision: Decision, final: Buffer): Operation => {
      if (input.op) return input.op;
      const op: Operation = {
        id: input.operationId,
        key: input.key,
        rel: input.rel,
        tool: input.tool,
        callId: input.callId,
        kind: decision.create ? "create" : input.change.kind,
        route: input.route,
        decision,
        ...(decision.receipts.length > 0 ? { receiptId: decision.receipts.at(-1)! } : {}),
        effected: false,
        closed: false,
      };
      holder.op = op;
      this.recordIntent(op, final);
      this.input.crash?.("after_intent", op.id);
      return op;
    };
    const choose = (decision: Decision): Buffer => {
      const predicted = decision.final;
      const writer = input.writerFinal;
      if (writer === undefined) {
        if (predicted === undefined) throw new MutationRefusal("unknown", `the bytes to write to ${input.key} are unknown`);
        return predicted;
      }
      if (!decision.complete && (predicted === undefined || !writer.equals(predicted))) {
        throw new MutationRefusal("span_unobserved",
          `the edit to ${input.key} changes bytes beyond its matched text (normalised match or line endings); read the whole file first`);
      }
      return writer;
    };
    try {
      let rewritten: { readonly identity: string } | undefined;
      try {
        rewritten = input.io.rewrite(input.rel, (current) => {
          decided = true;
          let decision: Decision;
          const expected = input.expected;
          if (expected?.create) {
            throw new MutationRefusal("target_changed", `${input.key} appeared after it was checked; read it before you overwrite it`);
          }
          if (expected?.before) {
            const before = expected.before;
            if (current.identity !== before.identity) {
              throw new MutationRefusal("target_changed", `${input.key} was replaced after it was checked; read it again`);
            }
            const same = expected.beforeBytes !== undefined
              ? current.bytes.equals(expected.beforeBytes)
              : current.bytes.length === before.size && sha256(current.bytes) === before.digest;
            if (!same) throw new MutationRefusal("stale_read", `${input.key} changed after it was checked; read it again`);
            decision = expected;
          } else {
            decision = this.decide(input.key, { state: "file", bytes: current.bytes, identity: current.identity }, input.change, input.only, input.point);
          }
          const final = choose(decision);
          open(decision, final);
          return final;
        }, () => {
          if (holder.op) holder.op.effected = true;
        });
      } catch (error) {
        if (decided || nodeCode(error) !== "ENOENT") throw error;
      }
      if (rewritten !== undefined) {
        const op = holder.op!;
        const final = choose(op.decision);
        return this.afterEffect(op, { identity: rewritten.identity, digest: sha256(final), size: final.length }, final);
      }
      // Nothing at the path: only an exclusive create may land here.
      if (input.expected?.before) {
        throw new MutationRefusal("target_changed", `${input.key} was removed after it was checked; read it again`);
      }
      const decision = this.decide(input.key, { state: "absent" }, input.change, input.only, input.point);
      const final = choose(decision);
      const op = open(decision, final);
      let made: { readonly identity: string };
      try {
        made = input.io.create(input.rel, final, () => { op.effected = true; });
      } catch (error) {
        if (!op.effected && nodeCode(error) === "EEXIST") {
          throw new MutationRefusal("target_changed", `${input.key} was created by someone else while this write waited; read it first`);
        }
        throw error;
      }
      return this.afterEffect(op, { identity: made.identity, digest: sha256(final), size: final.length }, final);
    } catch (error) {
      if (isCrash(error)) throw error;
      const op = holder.op;
      if (op?.effected) {
        // The bytes are in; what follows could not be verified or recorded.
        return this.unresolve(op, error instanceof Error ? error.message : String(error));
      }
      const boundary = !(error instanceof MutationRefusal);
      const refusal = boundary ? toRefusal(error, input.key) : error;
      if (op) this.closeRefused(op, refusal);
      else this.refused({ rel: input.rel, tool: input.tool, callId: input.callId, refusal, stage: "final" });
      return { status: "refused", code: refusal.code, detail: refusal.detail, ...(boundary ? { boundary: true as const } : {}) };
    }
  }

  /** Record the intent of an operation whose effect a terminal other than
   * the native boundary may perform (the speculative promotion): the
   * decision was made on the live target in the same synchronous run. */
  openOperation(input: {
    readonly operationId: string;
    readonly key: string;
    readonly rel: string;
    readonly tool: string;
    readonly callId: string;
    readonly change: MutationChange;
    readonly decision: Decision;
  }): Operation {
    const op: Operation = {
      id: input.operationId,
      key: input.key,
      rel: input.rel,
      tool: input.tool,
      callId: input.callId,
      kind: input.decision.create ? "create" : input.change.kind,
      route: "promotion",
      decision: input.decision,
      ...(input.decision.receipts.length > 0 ? { receiptId: input.decision.receipts.at(-1)! } : {}),
      effected: false,
      closed: false,
    };
    this.recordIntent(op, input.decision.final ?? Buffer.alloc(0), input.decision.final === undefined);
    return op;
  }

  /** Whether an operation reached its closing row. */
  isClosed(op: Operation): boolean {
    return op.closed;
  }

  /** A terminal reported success without passing the native boundary: what
   * stands at the path now is compared with the decision's bytes. Equal (or
   * unpredictable under a complete receipt): committed. Otherwise the
   * effect is unresolved — never retried. */
  adoptEffect(op: Operation, io: TargetIo): CommitOutcome {
    op.effected = true;
    let live: LiveTarget;
    try {
      live = io.inspect(op.rel);
    } catch (error) {
      return this.unresolve(op, `the promoted effect could not be read back: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (live.state !== "file") return this.unresolve(op, "the promoted effect left no regular file at the path");
    const predicted = op.decision.final;
    // M3': only bytes known in advance and read back equal commit. A
    // promotion whose bytes were not predicted is never adopted blind.
    if (predicted === undefined) return this.unresolve(op, "the promoted bytes were not predicted, so what the path holds cannot be told from another writer's bytes");
    if (!live.bytes.equals(predicted)) return this.unresolve(op, "the promoted bytes are not the bytes that were checked");
    return this.afterEffect(op, { identity: live.identity, digest: sha256(live.bytes), size: live.bytes.length }, live.bytes);
  }

  /** A refusal decided after the intent was recorded: closed as refused. */
  refuseOperation(op: Operation, refusal: MutationRefusal): void {
    if (!op.closed) this.closeRefused(op, refusal);
  }

  /** The terminal failed and nothing was written: the intent is closed. */
  closeNotApplied(op: Operation, reason: string): void {
    if (op.closed) return;
    op.closed = true;
    try {
      this.append("workspace/mutation_reconciled", {
        operation: op.id,
        root: this.rootId,
        ...pathFields(op.key),
        tool: op.tool,
        outcome: "not_applied",
        reason: reason.slice(0, 400),
        guarantee: CHECKED_NATIVE,
        binding: this.capabilities.binding,
      });
    } catch {
      // A restart reconciles it.
    }
  }

  private afterEffect(op: Operation, after: { readonly identity: string; readonly digest: string; readonly size: number }, final: Buffer): CommitOutcome {
    op.after = after;
    this.input.crash?.("after_effect", op.id);
    const commit = this.commitReceipt(op, final);
    let seq: number | undefined;
    try {
      seq = this.append("workspace/mutation_committed", {
        operation: op.id,
        root: this.rootId,
        ...pathFields(op.key),
        tool: op.tool,
        call: op.callId,
        kind: op.kind,
        route: op.route,
        before: op.decision.before ? { digest: op.decision.before.digest, bytes: op.decision.before.size, identity: op.decision.before.identity } : null,
        after: { digest: after.digest, bytes: after.size, identity: after.identity },
        receipt: op.receiptId ?? null,
        guarantee: CHECKED_NATIVE,
        binding: this.capabilities.binding,
        ...(commit.successor ? {
          successor: {
            receipt: commit.successor.id,
            coverage: commit.successor.coverage,
            ranges: commit.successor.visibleByteRanges.map(([start, end]) => [start, end]),
            ...(commit.successor.unavailableRanges.length > 0 ? { unavailable: commit.successor.unavailableRanges.map(([start, end]) => [start, end]) } : {}),
          },
        } : {}),
      });
    } catch (error) {
      if (isCrash(error)) throw error;
      return this.unresolve(op, `the commit could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    op.closed = true;
    this.input.crash?.("after_commit", op.id);
    this.invalidate(op.key);
    if (commit.successor) this.adopt(commit.successor, seq);
    this.project(commit.receipt);
    return { status: "committed", receipt: commit.receipt };
  }

  /** The commit receipt and the after-version's receipt (not yet adopted). */
  private commitReceipt(op: Operation, final: Buffer): { readonly receipt: CommitReceipt; readonly successor?: ReadReceipt } {
    const after: FileVersion = { rootId: this.rootId, path: op.key, digest: op.after!.digest, bytes: op.after!.size, objectIdentity: op.after!.identity };
    const ranges: ByteRange[] | undefined = (op.kind === "edit" || op.kind === "spans") && !op.decision.complete
      ? op.decision.successorRanges ? [...op.decision.successorRanges] : undefined
      : [[0, final.length]];
    const successor = ranges === undefined ? undefined : this.detachedReceipt(after, ranges, op.tool, op.decision.successorUnavailable ?? []);
    const receipt: CommitReceipt = Object.freeze({
      operationId: op.id,
      ...(op.decision.before ? { before: { rootId: this.rootId, path: op.key, digest: op.decision.before.digest, bytes: op.decision.before.size, objectIdentity: op.decision.before.identity } } : {}),
      after,
      ...(op.receiptId ? { readReceipt: op.receiptId } : {}),
      guarantee: CHECKED_NATIVE,
      binding: this.capabilities.binding,
      tool: op.tool,
      ...(successor ? { successor: successor.id } : {}),
    });
    this.minted.add(op.id);
    return { receipt, ...(successor ? { successor } : {}) };
  }

  private detachedReceipt(version: FileVersion, ranges: readonly ByteRange[], tool: string, unavailable: readonly ByteRange[]): ReadReceipt {
    const capped = capRanges(ranges);
    return Object.freeze({
      id: `wr_${randomBytes(16).toString("hex")}`,
      version: Object.freeze({ ...version }),
      sourceEvent: 0,
      projectionDigest: version.digest,
      visibleByteRanges: Object.freeze(capped.ranges.map((range) => Object.freeze([range[0], range[1]]) as ByteRange)),
      coverage: rangesComplete(capped.ranges, version.bytes) ? "complete" : "partial",
      mapping: "exact",
      unavailableRanges: Object.freeze(capRanges(unavailable).ranges.map((range) => Object.freeze([range[0], range[1]]) as ByteRange)),
      rangesTruncated: capped.truncated,
      tool,
      order: 0,
    });
  }

  private adopt(receipt: ReadReceipt, seq: number | undefined): void {
    this.mint({
      ...(seq === undefined ? {} : { seq }),
      unavailable: receipt.unavailableRanges,
      version: receipt.version,
      ranges: receipt.visibleByteRanges,
      rangesTruncated: receipt.rangesTruncated,
      mapping: receipt.mapping,
      projectionDigest: receipt.projectionDigest,
      tool: receipt.tool,
      callId: "",
      source: "commit",
      id: receipt.id,
      record: false,
    });
  }

  private recordIntent(op: Operation, final: Buffer, unpredicted = false): void {
    try {
      op.intentSeq = this.append("workspace/mutation_intent", {
        operation: op.id,
        root: this.rootId,
        ...pathFields(op.key),
        tool: op.tool,
        call: op.callId,
        kind: op.kind,
        route: op.route,
        before: op.decision.before ? { digest: op.decision.before.digest, bytes: op.decision.before.size, identity: op.decision.before.identity } : null,
        after: unpredicted ? null : { digest: sha256(final), bytes: final.length },
        receipt: op.receiptId ?? null,
      });
    } catch (error) {
      if (isCrash(error)) throw error;
      throw new MutationRefusal("unknown", `the intent could not be recorded, so nothing was written (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private closeRefused(op: Operation, refusal: MutationRefusal): void {
    op.closed = true;
    try {
      this.append("workspace/mutation_refused", {
        operation: op.id,
        root: this.rootId,
        ...pathFields(op.key),
        tool: op.tool,
        call: op.callId,
        code: refusal.code,
        detail: refusal.detail.slice(0, 400),
        stage: "final",
        guarantee: CHECKED_NATIVE,
        binding: this.capabilities.binding,
      });
    } catch {
      // The refusal stands; the log's own failure blocks the next request.
    }
  }

  /** Record a refusal decided before any intent (the preflight). */
  refused(input: { readonly rel: string; readonly tool: string; readonly callId: string; readonly refusal: MutationRefusal; readonly stage?: "preflight" | "final" }): void {
    if (this.readOnly) return;
    const key = this.key(input.rel) ?? input.rel;
    try {
      this.append("workspace/mutation_refused", {
        root: this.rootId,
        ...pathFields(key),
        tool: input.tool,
        call: input.callId,
        code: input.refusal.code,
        detail: input.refusal.detail.slice(0, 400),
        stage: input.stage ?? "preflight",
        guarantee: CHECKED_NATIVE,
        binding: this.capabilities.binding,
      });
    } catch {
      // As above.
    }
  }

  private unresolve(op: Operation, reason: string): CommitOutcome {
    op.closed = true;
    this.unresolved.push(op.id);
    this.invalidate(op.key);
    try {
      this.append("workspace/mutation_reconciled", {
        operation: op.id,
        root: this.rootId,
        ...pathFields(op.key),
        tool: op.tool,
        outcome: "unresolved",
        reason: reason.slice(0, 400),
        guarantee: CHECKED_NATIVE,
        binding: this.capabilities.binding,
      });
    } catch {
      // A later restart reconciles the dangling intent.
    }
    return { status: "unresolved", operationId: op.id, detail: reason };
  }

  // ------------------------------------------------------------ observers

  /** Exactly-once projection (M4, VM-O3): a receipt this provider minted is
   * delivered to every observer once; a repeat or a foreign receipt is not. */
  committed(receipt: CommitReceipt): boolean {
    if (this.revoked) return false;
    if (!this.minted.has(receipt.operationId) || this.projected.has(receipt.operationId)) return false;
    this.project(receipt);
    return true;
  }

  private project(receipt: CommitReceipt): void {
    if (this.projected.has(receipt.operationId)) return;
    this.projected.add(receipt.operationId);
    for (const observer of [...this.observers]) {
      try {
        observer(receipt);
      } catch {
        // An observer can neither undo nor re-run the effect.
        this.observerFailures += 1;
      }
    }
  }

  onCommitted(observer: (receipt: CommitReceipt) => void): () => void {
    if (this.revoked) return () => false;
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** Effects this provider projected (each once). */
  get projectedCount(): number {
    return this.projected.size;
  }

  // ------------------------------------------------------------ the API

  async authorize(input: {
    readonly caller: object;
    readonly path: string;
    readonly receiptId?: string;
    readonly change: MutationChange;
    readonly callId?: string;
    readonly tool?: string;
  }): Promise<MutationDecision> {
    const tool = typeof input.tool === "string" && /^[a-z0-9_.-]{1,64}$/u.test(input.tool) ? input.tool : "api";
    const callId = input.callId ?? "";
    try {
      const begun = this.begin({ caller: input.caller, tool, callId, rel: input.path, change: input.change, route: "api" });
      // The tools' own guard, held on the API route for every change kind.
      if (isSecretWorkspacePath(begun.key)) throw new MutationRefusal("unknown", `${begun.key} is a credential file the file tools never change`);
      if (input.receiptId !== undefined) {
        const receipt = this.receipts.get(input.receiptId);
        if (!receipt || receipt.version.rootId !== this.rootId || receipt.version.path !== begun.key) {
          throw new MutationRefusal("unknown", "that receipt was not minted for this path in this session");
        }
      }
      const decision = this.decide(begun.key, this.input.io.inspect(input.path), input.change, input.receiptId, begun.point);
      const grant: MutationGrant = Object.freeze({
        operationId: begun.operationId,
        path: begun.key,
        tool,
        ...(decision.before ? { before: { rootId: this.rootId, path: begun.key, digest: decision.before.digest, bytes: decision.before.size, objectIdentity: decision.before.identity } } : {}),
        ...(decision.final ? { afterDigest: sha256(decision.final) } : {}),
      });
      this.grants.set(grant, { key: begun.key, rel: input.path, tool, callId, change: input.change, decision, used: false });
      return { ok: true, grant };
    } catch (error) {
      const refusal = error instanceof MutationRefusal ? error : toRefusal(error, input.path);
      this.refused({ rel: input.path, tool, callId, refusal });
      return { ok: false, code: refusal.code, detail: refusal.detail };
    }
  }

  /** The same final check at commit (M5): the live target must still be
   * what `authorize` decided on. A grant is used once. */
  async commit(grant: MutationGrant): Promise<CommitOutcome> {
    const state = this.grants.get(grant);
    if (!state || state.used) return { status: "refused", code: "unknown", detail: "this grant was not issued here or was already used" };
    if (this.revoked) return { status: "refused", code: "unknown", detail: "the workspace tools were unloaded; this authority is revoked" };
    state.used = true;
    return await withFileQueue(this.queueKey(state.key), async () => this.land({
      io: this.input.io,
      operationId: grant.operationId,
      key: state.key,
      rel: state.rel,
      tool: state.tool,
      callId: state.callId,
      change: state.change,
      route: "api",
      expected: state.decision,
    }));
  }

  // ------------------------------------------------------------ recording

  private append(name: string, payload: Record<string, unknown>): number | undefined {
    const log = this.input.log;
    if (!log) return undefined;
    return log.append({ kind: "observe", name, payload }).seq;
  }

  /**
   * RESTART (M4): the recorded receipts of this root return; a committed or
   * unresolved change ends the receipts before it; an intent with no closing
   * row is reconciled now — the live target is compared, never re-written —
   * and recorded `unresolved`. Every later use re-verifies the live target.
   */
  private restore(): void {
    const log = this.input.log;
    if (!log) return;
    const open = new Map<string, { key: string; before?: string; after?: string; tool: string }>();
    for (const event of log.events) {
      const payload = event.payload as Record<string, unknown>;
      if (!event.name.startsWith("workspace/") || payload.root !== this.rootId) continue;
      const key = typeof payload.path === "string" ? payload.path : undefined;
      if (event.name === "workspace/read_receipt" && key !== undefined && typeof payload.receipt === "string"
        && typeof payload.digest === "string" && typeof payload.bytes === "number") {
        const ranges = Array.isArray(payload.ranges)
          ? (payload.ranges as unknown[]).filter((range): range is [number, number] => Array.isArray(range) && range.length === 2
            && typeof range[0] === "number" && typeof range[1] === "number")
          : [];
        this.mint({
          version: {
            rootId: this.rootId,
            path: key,
            digest: payload.digest,
            bytes: payload.bytes,
            ...(typeof payload.identity === "string" ? { objectIdentity: payload.identity } : {}),
          },
          ranges: capRanges(ranges).ranges,
          unavailable: Array.isArray(payload.unavailable)
            ? capRanges((payload.unavailable as unknown[]).filter((range): range is [number, number] => Array.isArray(range) && range.length === 2
              && typeof range[0] === "number" && typeof range[1] === "number")).ranges
            : [],
          rangesTruncated: payload.ranges_truncated === true,
          mapping: payload.mapping === "exact" ? "exact" : "unknown",
          projectionDigest: typeof payload.projection_digest === "string" ? payload.projection_digest : "",
          tool: typeof payload.tool === "string" ? payload.tool : "read",
          callId: "",
          source: "read",
          id: payload.receipt,
          seq: event.seq,
          record: false,
        });
        continue;
      }
      const operation = typeof payload.operation === "string" ? payload.operation : undefined;
      if (event.name === "workspace/mutation_intent" && operation && key !== undefined) {
        const before = payload.before as { digest?: unknown } | null;
        const after = payload.after as { digest?: unknown } | null;
        open.set(operation, {
          key,
          ...(typeof before?.digest === "string" ? { before: before.digest } : {}),
          ...(typeof after?.digest === "string" ? { after: after.digest } : {}),
          tool: typeof payload.tool === "string" ? payload.tool : "",
        });
        continue;
      }
      if (event.name === "workspace/mutation_committed" && operation && key !== undefined) {
        open.delete(operation);
        this.minted.add(operation);
        this.projected.add(operation);
        this.invalidate(key);
        const successor = payload.successor as { receipt?: unknown; ranges?: unknown } | undefined;
        const after = payload.after as { digest?: unknown; bytes?: unknown; identity?: unknown } | undefined;
        if (successor && typeof successor.receipt === "string" && typeof after?.digest === "string" && typeof after.bytes === "number") {
          const ranges = Array.isArray(successor.ranges)
            ? (successor.ranges as unknown[]).filter((range): range is [number, number] => Array.isArray(range) && range.length === 2
              && typeof range[0] === "number" && typeof range[1] === "number")
            : [];
          this.mint({
            version: {
              rootId: this.rootId,
              path: key,
              digest: after.digest,
              bytes: after.bytes,
              ...(typeof after.identity === "string" ? { objectIdentity: after.identity } : {}),
            },
            ranges: capRanges(ranges).ranges,
            unavailable: Array.isArray((successor as { unavailable?: unknown }).unavailable)
              ? capRanges(((successor as { unavailable: unknown[] }).unavailable).filter((range): range is [number, number] => Array.isArray(range)
                && range.length === 2 && typeof range[0] === "number" && typeof range[1] === "number")).ranges
              : [],
            rangesTruncated: false,
            mapping: "exact",
            projectionDigest: after.digest,
            tool: typeof payload.tool === "string" ? payload.tool : "",
            callId: "",
            source: "commit",
            id: successor.receipt,
            seq: event.seq,
            record: false,
          });
        }
        continue;
      }
      if ((event.name === "workspace/mutation_reconciled" || event.name === "workspace/mutation_refused") && operation) {
        const pending = open.get(operation);
        open.delete(operation);
        if (event.name === "workspace/mutation_reconciled" && payload.outcome === "unresolved" && key !== undefined) {
          this.invalidate(key);
          this.unresolved.push(operation);
        }
        void pending;
      }
    }
    if (log.isReadOnly) return;
    for (const [operation, pending] of open) {
      this.invalidate(pending.key);
      this.unresolved.push(operation);
      let live: "after" | "before" | "other" | "absent" | "unknown" = "unknown";
      try {
        const target = this.input.io.inspect(pending.key);
        if (target.state === "absent") live = "absent";
        else if (target.state === "file") {
          const digest = sha256(target.bytes);
          live = digest === pending.after ? "after" : digest === pending.before ? "before" : "other";
        }
      } catch {
        live = "unknown";
      }
      try {
        this.append("workspace/mutation_reconciled", {
          operation,
          root: this.rootId,
          ...pathFields(pending.key),
          tool: pending.tool,
          outcome: "unresolved",
          reason: "an intent was recorded and no commit followed (a crash between intent, effect and record); the effect is not re-applied",
          live,
          guarantee: CHECKED_NATIVE,
          binding: this.capabilities.binding,
        });
      } catch {
        // Shown again at the next restart.
      }
    }
  }
}

function isCrash(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "simulatedCrash") === true;
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(Reflect.get(error, "code")) : undefined;
}

/** A failure at the boundary that is not a version decision. */
function toRefusal(error: unknown, key: string): MutationRefusal {
  const code = nodeCode(error);
  const name = typeof error === "object" && error !== null ? String(Reflect.get(error, "name")) : "";
  if (name === "LinkSafetyError") {
    const safety = String(Reflect.get(error as object, "code"));
    return new MutationRefusal("target_changed", safety === "link"
      ? `${key} is reached through a symbolic link, which a write never follows`
      : safety === "not_file"
        ? `${key} is not a regular file with one name`
        : `${key} changed while it was being written; nothing was written`);
  }
  if (code === "ENOENT") return new MutationRefusal("target_changed", `${key} disappeared after it was checked`);
  if (code === "EEXIST") return new MutationRefusal("target_changed", `${key} was created by someone else`);
  if (code === "ELOOP") return new MutationRefusal("target_changed", `${key} is reached through a symbolic link, which a write never follows`);
  if (code === "EACCES" || code === "EPERM") return new MutationRefusal("unknown", `${key} is not writable (${code})`);
  return new MutationRefusal("unknown", `${key} could not be checked (${error instanceof Error ? error.message : String(error)})`);
}

/** A path in a row: its text when it is safe to record, its digest always. */
function pathFields(path: string): Record<string, unknown> {
  const digest = sha256(Buffer.from(path, "utf8")).slice(0, 16);
  return containsSecret(path) ? { path_digest: digest, path_redacted: true } : { path, path_digest: digest };
}

/** Whether a receipt was recorded before the call's decision point. */
function usable(receipt: ReadReceipt, point: DecisionPoint | undefined): boolean {
  if (point === undefined) return true;
  if (point.seq !== undefined && receipt.sourceEvent > 0) return receipt.sourceEvent < point.seq;
  return receipt.order <= point.order;
}

function describeUnavailable(ranges: readonly ByteRange[]): string {
  const bytes = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  return `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

/**
 * THE PROVIDED OBJECT (M5'): exactly the consumer API (five methods), nothing else on its
 * prototype; the implementation is held in a private field no plugin can
 * reach, and every method checks revocation itself.
 */
export class WorkspaceVersionsFacade implements WorkspaceVersionsApi {
  readonly #impl: WorkspaceVersions;

  constructor(impl: WorkspaceVersions) {
    this.#impl = impl;
  }

  async authorize(input: Parameters<WorkspaceVersionsApi["authorize"]>[0]): Promise<MutationDecision> {
    if (this.#impl.isRevoked) return { ok: false, code: "unknown", detail: "the workspace tools were unloaded; this authority is revoked" };
    return await this.#impl.authorize(input);
  }

  async commit(grant: MutationGrant): Promise<CommitOutcome> {
    if (this.#impl.isRevoked) return { status: "refused", code: "unknown", detail: "the workspace tools were unloaded; this authority is revoked" };
    return await this.#impl.commit(grant);
  }

  committed(receipt: CommitReceipt): boolean {
    if (this.#impl.isRevoked) return false;
    return this.#impl.committed(receipt);
  }

  onCommitted(observer: (receipt: CommitReceipt) => void): () => void {
    if (this.#impl.isRevoked) return () => false;
    return this.#impl.onCommitted(observer);
  }

  mintSpansPlan(targets: Parameters<WorkspaceVersions["mintSpansPlan"]>[0]): SpansPlan | undefined {
    if (this.#impl.isRevoked) return undefined;
    return this.#impl.mintSpansPlan(targets);
  }
}

function describeRanges(ranges: readonly ByteRange[], size: number): string {
  const shown = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  return `${shown} of ${size} bytes shown`;
}
