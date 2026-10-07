import { createHash } from "node:crypto";

/**
 * Deduplicated storage of provider request bodies (D53).
 *
 * Every provider payload and send body carries the whole transcript, so a
 * session that stores each body whole grows with the square of its length.
 * A splittable body is stored as parts instead:
 *
 * - a part is the exact UTF-8 bytes of one element of an array the body
 *   carries (a transcript message, a tool definition), or a large piece of
 *   the body between them, stored once per session under its own sha256;
 * - a list is 64 consecutive element digests of one array, stored under its
 *   own sha256 (a full manifest names an array's stable leading elements by
 *   lists, so no manifest grows with the transcript);
 * - a manifest, stored under the body's digest, is the skeleton: the body's
 *   text between the arrays inline, and each array as its element digests —
 *   either whole (lists, then parts) or, while the array only grows, as the
 *   same array of a base manifest cut to a kept length plus the elements
 *   added. A chain holds at most CHAIN_LIMIT manifests; a manifest carries its
 *   own sha256 in its first line.
 *
 * A body's bytes are the skeleton's text with each array's elements joined by
 * ",", and a base64 region as the base64 of the UTF-8 bytes of the text its
 * nested skeleton gives. Reassembly is concatenation and base64 only: nothing
 * is re-serialized, so it does not depend on this code's JSON formatting.
 */

export const PARTS_FORMAT = "dokkabi-parts/1";
/** Manifests per chain: a full one and at most CHAIN_LIMIT - 1 chained to it. */
export const CHAIN_LIMIT = 20;
/** Element digests per list. */
export const LIST_SIZE = 64;
/** Arrays smaller than this stay in the skeleton's text. */
const MIN_RUN_BYTES = 256;
/** Root string members shorter than this are never examined as base64. */
const MIN_ENCODED_BYTES = 1024;
/** Skeleton text longer than this is stored as a part, not inline. */
export const INLINE_TEXT_BYTES = 4096;

const DIGEST = /^[0-9a-f]{64}$/;

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The shape of one splittable body: its text between arrays, each array's
 * element texts, and base64 regions whose decoded text is itself split. */
export type Piece =
  | { kind: "text"; text: string }
  | { kind: "run"; path: string; items: string[] }
  | { kind: "base64"; path: string; pieces: Piece[] };

class NotSplittable extends Error {}

function whitespace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9;
}
function skipWhitespace(text: string, index: number): number {
  while (index < text.length && whitespace(text.charCodeAt(index))) index += 1;
  return index;
}
/** End (exclusive) of the JSON string starting at `start`. */
function stringEnd(text: string, start: number): number {
  let from = start + 1;
  for (;;) {
    const quote = text.indexOf("\"", from);
    if (quote < 0) throw new NotSplittable();
    let back = quote - 1;
    while (text.charCodeAt(back) === 92) back -= 1;
    if ((quote - 1 - back) % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}
/** End (exclusive) of the JSON value starting at `start`. */
function valueEnd(text: string, start: number): number {
  const first = text.charCodeAt(start);
  if (first === 34) return stringEnd(text, start);
  if (first === 123 || first === 91) {
    let depth = 0;
    for (let index = start; index < text.length;) {
      const code = text.charCodeAt(index);
      if (code === 34) { index = stringEnd(text, index); continue; }
      if (code === 123 || code === 91) depth += 1;
      else if (code === 125 || code === 93) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    throw new NotSplittable();
  }
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 44 || code === 125 || code === 93 || whitespace(code)) break;
    index += 1;
  }
  if (index === start) throw new NotSplittable();
  return index;
}
/** A value's range, and for an object opened by the scan its members, for an
 * array its element ranges (null when not separated by exactly ","). */
interface Scanned {
  start: number;
  end: number;
  members?: Array<{ key: string; value: Scanned }>;
  items?: Array<[number, number]> | null;
}
/** One pass over the value at `start`: objects are opened `levels` deep,
 * arrays directly under an opened object have their elements delimited, and
 * everything else is skipped. */
function scan(text: string, start: number, levels: number): Scanned {
  const first = text.charCodeAt(start);
  if (first === 123 && levels > 0) {
    const members: Array<{ key: string; value: Scanned }> = [];
    let index = skipWhitespace(text, start + 1);
    if (text.charCodeAt(index) === 125) return { start, end: index + 1, members };
    for (;;) {
      if (text.charCodeAt(index) !== 34) throw new NotSplittable();
      const keyEnd = stringEnd(text, index);
      const key = JSON.parse(text.slice(index, keyEnd)) as string;
      index = skipWhitespace(text, keyEnd);
      if (text.charCodeAt(index) !== 58) throw new NotSplittable();
      const value = scan(text, skipWhitespace(text, index + 1), levels - 1);
      members.push({ key, value });
      index = skipWhitespace(text, value.end);
      const code = text.charCodeAt(index);
      if (code === 44) { index = skipWhitespace(text, index + 1); continue; }
      if (code === 125) return { start, end: index + 1, members };
      throw new NotSplittable();
    }
  }
  if (first === 91) {
    const items: Array<[number, number]> = [];
    let index = start + 1;
    if (text.charCodeAt(index) === 93) return { start, end: index + 1, items };
    for (;;) {
      const code = text.charCodeAt(index);
      if (whitespace(code) || code === 44 || code === 93) return { start, end: valueEnd(text, start), items: null };
      const stop = valueEnd(text, index);
      items.push([index, stop]);
      const next = text.charCodeAt(stop);
      if (next === 44) { index = stop + 1; continue; }
      if (next === 93) return { start, end: stop + 1, items };
      return { start, end: valueEnd(text, start), items: null };
    }
  }
  return { start, end: valueEnd(text, start) };
}
/** The UTF-8 text a base64 string may encode, when it decodes to UTF-8 that
 * could be a JSON object; else undefined. Whether the base64 of that text's
 * bytes is exactly the string is not checked here: a writer checks that the
 * whole body reassembles before it trusts a split. */
function base64Json(content: string): string | undefined {
  // A JSON object's text starts with "{", whose base64 starts with "e".
  if (content.length % 4 !== 0 || !content.startsWith("e") || content.includes("\\")) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(content, "base64")); } catch { return undefined; }
}

function splitDocument(text: string, prefix: string[], nested: boolean): Piece[] | undefined {
  const start = skipWhitespace(text, 0);
  if (text.charCodeAt(start) !== 123) return undefined;
  const root = scan(text, start, 2);
  if (skipWhitespace(text, root.end) !== text.length) return undefined;
  const pieces: Piece[] = [];
  let cursor = 0;
  const run = (path: string[], value: Scanned): void => {
    if (!value.items || value.items.length === 0 || value.end - value.start - 2 < MIN_RUN_BYTES) return;
    pieces.push({ kind: "text", text: text.slice(cursor, value.start + 1) });
    pieces.push({ kind: "run", path: JSON.stringify([...prefix, ...path]), items: value.items.map(([from, to]) => text.slice(from, to)) });
    cursor = value.end - 1;
  };
  for (const { key, value } of root.members ?? []) {
    const first = text.charCodeAt(value.start);
    if (first === 91) run([key], value);
    else if (first === 123) {
      for (const inner of value.members ?? []) if (text.charCodeAt(inner.value.start) === 91) run([key, inner.key], inner.value);
    } else if (first === 34 && !nested && value.end - value.start - 2 >= MIN_ENCODED_BYTES) {
      const decoded = base64Json(text.slice(value.start + 1, value.end - 1));
      const inner = decoded === undefined ? undefined : splitDocument(decoded, [...prefix, key, "base64"], true);
      if (inner && inner.some(piece => piece.kind === "run")) {
        pieces.push({ kind: "text", text: text.slice(cursor, value.start + 1) });
        pieces.push({ kind: "base64", path: JSON.stringify([...prefix, key]), pieces: inner });
        cursor = value.end - 1;
      }
    }
  }
  pieces.push({ kind: "text", text: text.slice(cursor) });
  return pieces;
}

/** Split a JSON object's text at the arrays its members carry (members'
 * arrays and their objects' arrays) and at a root string member that is the
 * base64 of such a JSON text. Undefined when the text has nothing to split or
 * is not JSON of that shape: such a body is stored whole. */
export function splitBody(text: string): Piece[] | undefined {
  try {
    const pieces = splitDocument(text, [], false);
    return pieces && pieces.some(piece => piece.kind !== "text") ? pieces : undefined;
  } catch (error) {
    if (error instanceof NotSplittable || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** The text a split gives back (the check a writer makes before trusting it). */
export function joinPieces(pieces: readonly Piece[]): string {
  return pieces.map(piece => piece.kind === "text" ? piece.text : piece.kind === "run" ? piece.items.join(",")
    : Buffer.from(joinPieces(piece.pieces), "utf8").toString("base64")).join("");
}

/** The arrays of a split in document order (base64 regions included), and
 * the signature a chained manifest must share with its base. */
export function runsOf(pieces: readonly Piece[]): Array<Extract<Piece, { kind: "run" }>> {
  const out: Array<Extract<Piece, { kind: "run" }>> = [];
  const visit = (list: readonly Piece[]) => {
    for (const piece of list) {
      if (piece.kind === "run") out.push(piece);
      else if (piece.kind === "base64") visit(piece.pieces);
    }
  };
  visit(pieces);
  return out;
}
export function splitSignature(pieces: readonly Piece[]): string {
  const shape = (list: readonly Piece[]): unknown[] => list.filter(piece => piece.kind !== "text")
    .map(piece => piece.kind === "run" ? piece.path : { [piece.path]: shape(piece.pieces) });
  return JSON.stringify(shape(pieces));
}

// ---------------------------------------------------------------------------
// Manifests

export interface ManifestRun {
  /** Elements kept from the same array of the base manifest (chained only). */
  keep?: number;
  /** Lists of element digests, in order (full manifests only). */
  lists?: string[];
  /** Element digests after the kept elements and the lists. */
  parts: string[];
}
export type ManifestSegment = string | { text: string } | { run: ManifestRun } | { base64: ManifestSegment[] };
export interface Manifest {
  /** The body digest of the manifest this one is chained to, or null. */
  base: string | null;
  bytes: number;
  /** 0 for a full manifest; its base's depth + 1 for a chained one. */
  depth: number;
  digest: string;
  segments: ManifestSegment[];
}

export class PartsIntegrityError extends Error {
  constructor(readonly digest: string, detail: string) {
    super(`body parts of sha256:${digest.slice(0, 7)}... ${detail}`);
    this.name = "PartsIntegrityError";
  }
}

export function encodeManifest(manifest: Manifest): string {
  const json = JSON.stringify({ base: manifest.base, bytes: manifest.bytes, depth: manifest.depth,
    digest: manifest.digest, segments: manifest.segments });
  return `${PARTS_FORMAT} ${sha256(json)}\n${json}\n`;
}

function digestList(value: unknown, what: string, digest: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !DIGEST.test(item))) {
    throw new PartsIntegrityError(digest, `manifest ${what} is malformed`);
  }
  return value as string[];
}
function segmentsOf(value: unknown, digest: string, chained: boolean): ManifestSegment[] {
  if (!Array.isArray(value)) throw new PartsIntegrityError(digest, "manifest segments are malformed");
  return value.map((segment): ManifestSegment => {
    if (typeof segment === "string") return segment;
    if (segment === null || typeof segment !== "object" || Array.isArray(segment) || Object.keys(segment).length !== 1) {
      throw new PartsIntegrityError(digest, "manifest segment is malformed");
    }
    if ("text" in segment) return { text: digestList([segment.text], "text", digest)[0]! };
    if ("base64" in segment) return { base64: segmentsOf(segment.base64, digest, chained) };
    if (!("run" in segment) || segment.run === null || typeof segment.run !== "object") {
      throw new PartsIntegrityError(digest, "manifest segment is malformed");
    }
    const run = segment.run as Record<string, unknown>;
    const keep = run.keep, out: ManifestRun = { parts: digestList(run.parts, "parts", digest) };
    if (keep !== undefined) {
      if (!chained || !Number.isSafeInteger(keep) || (keep as number) < 0) throw new PartsIntegrityError(digest, "manifest keep is malformed");
      out.keep = keep as number;
    }
    if (run.lists !== undefined) out.lists = digestList(run.lists, "lists", digest);
    return { run: out };
  });
}

/** Parse and check a manifest file's text: its first line names its format
 * and the sha256 of the rest, and it describes the body `digest`. */
export function decodeManifest(text: string, digest: string): Manifest {
  const newline = text.indexOf("\n");
  const header = newline < 0 ? "" : text.slice(0, newline);
  const json = newline < 0 ? "" : text.slice(newline + 1, text.endsWith("\n") ? -1 : undefined);
  if (header !== `${PARTS_FORMAT} ${sha256(json)}` || !text.endsWith("\n")) throw new PartsIntegrityError(digest, "manifest does not match its digest");
  let value: Record<string, unknown>;
  try { value = JSON.parse(json) as Record<string, unknown>; } catch { throw new PartsIntegrityError(digest, "manifest is not JSON"); }
  if (value === null || typeof value !== "object" || value.digest !== digest || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    || !Number.isSafeInteger(value.depth) || (value.depth as number) < 0 || (value.depth as number) >= CHAIN_LIMIT
    || (value.base !== null && (typeof value.base !== "string" || !DIGEST.test(value.base)))
    || (value.base === null) !== (value.depth === 0)) {
    throw new PartsIntegrityError(digest, "manifest header is malformed");
  }
  return { base: value.base as string | null, bytes: value.bytes as number, depth: value.depth as number, digest,
    segments: segmentsOf(value.segments, digest, value.base !== null) };
}

/** The body digest a manifest file's text describes, when its first line
 * matches the rest (the manifest is checked in full when it is decoded). */
export function manifestBodyDigest(text: string): string | undefined {
  if (!text.startsWith(`${PARTS_FORMAT} `)) return undefined;
  const newline = text.indexOf("\n");
  const json = text.slice(newline + 1, text.endsWith("\n") ? -1 : undefined);
  if (newline < 0 || text.slice(0, newline) !== `${PARTS_FORMAT} ${sha256(json)}`) return undefined;
  try {
    const digest = (JSON.parse(json) as { digest?: unknown }).digest;
    return typeof digest === "string" && DIGEST.test(digest) ? digest : undefined;
  } catch { return undefined; }
}

/** What a manifest names directly: its base, its lists and its parts. */
export function manifestReferences(manifest: Manifest): { lists: string[]; parts: string[] } {
  const lists: string[] = [], parts: string[] = [];
  const visit = (segments: readonly ManifestSegment[]) => {
    for (const segment of segments) {
      if (typeof segment === "string") continue;
      if ("text" in segment) parts.push(segment.text);
      else if ("base64" in segment) visit(segment.base64);
      else {
        for (const list of segment.run.lists ?? []) lists.push(list);
        for (const part of segment.run.parts) parts.push(part);
      }
    }
  };
  visit(manifest.segments);
  return { lists, parts };
}

/** The parts that hold a manifest's large skeleton text (not array elements). */
export function manifestTextParts(manifest: Manifest): string[] {
  const out: string[] = [];
  const visit = (segments: readonly ManifestSegment[]) => {
    for (const segment of segments) {
      if (typeof segment === "string") continue;
      if ("text" in segment) out.push(segment.text);
      else if ("base64" in segment) visit(segment.base64);
    }
  };
  visit(manifest.segments);
  return out;
}

export function manifestRuns(manifest: Manifest): ManifestRun[] {
  const out: ManifestRun[] = [];
  const visit = (segments: readonly ManifestSegment[]) => {
    for (const segment of segments) {
      if (typeof segment === "string" || "text" in segment) continue;
      if ("base64" in segment) visit(segment.base64);
      else out.push(segment.run);
    }
  };
  visit(manifest.segments);
  return out;
}

/** Where a manifest's files come from. Implementations return a part's or a
 * list's text only after checking it against its digest; a manifest's text
 * is checked by decodeManifest. */
export interface PartsSource {
  /** The manifest file text stored for body `digest`, or undefined. */
  manifest(digest: string): string | undefined;
  /** A list's checked text, or undefined when absent. */
  list(digest: string): string | undefined;
  /** A part's checked text, or undefined when absent. */
  part(digest: string): string | undefined;
}

export interface ResolvedManifest { manifest: Manifest; runs: string[][] }

/** The manifest of `digest` with each array's element digests, its base chain
 * resolved (at most CHAIN_LIMIT manifests). `cache` may hold resolved ones. */
export function resolveManifest(digest: string, source: PartsSource,
  cache?: Map<string, ResolvedManifest>, depth = 0, budget?: { remaining: number }): ResolvedManifest {
  const cached = cache?.get(digest);
  if (cached) return cached;
  if (depth >= CHAIN_LIMIT) throw new PartsIntegrityError(digest, "manifest chain is too long");
  const text = source.manifest(digest);
  if (text === undefined) throw new PartsIntegrityError(digest, "manifest is missing");
  const manifest = decodeManifest(text, digest);
  const base = manifest.base === null ? undefined : resolveManifest(manifest.base, source, cache, depth + 1, budget);
  if (base && base.manifest.depth + 1 !== manifest.depth) throw new PartsIntegrityError(digest, "manifest depth differs from its base");
  const runs = manifestRuns(manifest).map((run, index) => {
    const kept = run.keep ?? 0;
    const inherited = base?.runs[index];
    if (kept > 0 && (!inherited || inherited.length < kept)) throw new PartsIntegrityError(digest, "manifest keeps more than its base holds");
    if (budget && (budget.remaining -= kept) < 0) throw new PartsIntegrityError(digest, "manifest reference budget exceeded");
    const out = kept > 0 ? inherited!.slice(0, kept) : [];
    for (const list of run.lists ?? []) {
      const listed = source.list(list);
      if (listed === undefined) throw new PartsIntegrityError(digest, `list sha256:${list.slice(0, 7)}... is missing`);
      let parsed: unknown;
      try { parsed = JSON.parse(listed); } catch { throw new PartsIntegrityError(digest, "list is not JSON"); }
      for (const item of digestList(parsed, "list", digest)) { if (budget && --budget.remaining < 0) throw new PartsIntegrityError(digest, "manifest reference budget exceeded"); out.push(item); }
    }
    for (const item of run.parts) { if (budget && --budget.remaining < 0) throw new PartsIntegrityError(digest, "manifest reference budget exceeded"); out.push(item); }
    return out;
  });
  const resolved = { manifest, runs };
  cache?.set(digest, resolved);
  return resolved;
}

function render(segments: readonly ManifestSegment[], runs: readonly string[][], cursor: { run: number },
  part: (digest: string) => string, maxBytes = Number.POSITIVE_INFINITY): string {
  let out = "", bytes = 0;
  const append = (text: string) => {
    const count = Buffer.byteLength(text);
    if (count > maxBytes - bytes) throw new Error("assembled blob byte budget exceeded");
    bytes += count; out += text;
  };
  for (const segment of segments) {
    if (typeof segment === "string") append(segment);
    else if ("text" in segment) append(part(segment.text));
    else if ("base64" in segment) {
      const inner = render(segment.base64, runs, cursor, part, maxBytes - bytes);
      if (Math.ceil(Buffer.byteLength(inner) / 3) * 4 > maxBytes - bytes) throw new Error("assembled blob byte budget exceeded");
      append(Buffer.from(inner, "utf8").toString("base64"));
    } else {
      const items = runs[cursor.run++];
      if (!items) throw new Error("manifest run is missing");
      for (let i = 0; i < items.length; i++) { if (i) append(","); append(part(items[i]!)); }
    }
  }
  return out;
}

/** The body `digest` from its manifest and parts, checked against the digest
 * and byte length the manifest records — or, for a writer that holds the
 * body `expected` (whose digest it computed), checked equal to it. */
export function assembleBody(digest: string, source: PartsSource, cache?: Map<string, ResolvedManifest>, expected?: string, maxBytes = Number.POSITIVE_INFINITY): string {
  const { manifest, runs } = resolveManifest(digest, source, cache, 0, Number.isFinite(maxBytes) ? { remaining: 200000 } : undefined);
  if (manifest.bytes > maxBytes) throw new PartsIntegrityError(digest, "body byte budget exceeded");
  const part = (item: string) => {
    const text = source.part(item);
    if (text === undefined) throw new PartsIntegrityError(digest, `part sha256:${item.slice(0, 7)}... is missing`);
    return text;
  };
  let body: string;
  try { body = render(manifest.segments, runs, { run: 0 }, part, maxBytes); }
  catch (error) { throw error instanceof PartsIntegrityError ? error : new PartsIntegrityError(digest, "manifest does not reassemble"); }
  if (expected !== undefined ? body !== expected || Buffer.byteLength(expected) !== manifest.bytes
    : Buffer.byteLength(body) !== manifest.bytes || sha256(body) !== digest) throw new PartsIntegrityError(digest, "reassembly differs from its digest");
  return body;
}

/** The body with every array emptied and every base64 region emptied: the
 * fields a body carries besides its transcript, without reading any part
 * but the skeleton's own large text. */
export function hollowBody(manifest: Manifest, part: (digest: string) => string): string {
  const visit = (segments: readonly ManifestSegment[]): string => segments.map(segment =>
    typeof segment === "string" ? segment : "text" in segment ? part(segment.text) : "").join("");
  return visit(manifest.segments);
}

/** Manifest segments for a split: skeleton text inline (or as a part when
 * large, named by `textPart`), each array as `encode(its index)`. */
export function manifestSegments(pieces: readonly Piece[], encode: (index: number) => ManifestRun,
  textPart: (text: string) => string): ManifestSegment[] {
  let index = 0;
  const visit = (list: readonly Piece[]): ManifestSegment[] => list.flatMap((piece): ManifestSegment[] => {
    if (piece.kind === "text") {
      if (piece.text.length === 0) return [];
      return Buffer.byteLength(piece.text) <= INLINE_TEXT_BYTES ? [piece.text] : [{ text: textPart(piece.text) }];
    }
    if (piece.kind === "base64") return [{ base64: visit(piece.pieces) }];
    return [{ run: encode(index++) }];
  });
  return visit(pieces);
}

/** Every stored file a split body needs — its manifest, the manifests it is
 * chained to, their lists and parts — read through `text` (manifests and
 * lists only; each is checked). Names already in `seen` are not walked again,
 * so a caller collecting many bodies' files reads each manifest once. */
export function partsClosure(digest: string, text: (name: string) => string | undefined, seen: Set<string>): string[] {
  const out: string[] = [];
  const add = (name: string) => { if (!seen.has(name)) { seen.add(name); out.push(name); } };
  let current: string | null = digest;
  for (let depth = 0; current !== null; depth += 1) {
    const name = storedName(current, "manifest");
    if (seen.has(name)) break;
    if (depth >= CHAIN_LIMIT) throw new PartsIntegrityError(digest, "manifest chain is too long");
    const read = text(name);
    if (read === undefined) throw new PartsIntegrityError(current, "manifest is missing");
    const manifest = decodeManifest(read, current);
    add(name);
    const { lists, parts } = manifestReferences(manifest);
    for (const list of lists) {
      const listName = storedName(list, "list");
      if (seen.has(listName)) continue;
      const listed = text(listName);
      if (listed === undefined || sha256(listed) !== list) throw new PartsIntegrityError(current, `list sha256:${list.slice(0, 7)}... is missing or damaged`);
      add(listName);
      let items: unknown;
      try { items = JSON.parse(listed); } catch { throw new PartsIntegrityError(current, "list is not JSON"); }
      for (const item of digestList(items, "list", current)) add(storedName(item, "part"));
    }
    for (const part of parts) add(storedName(part, "part"));
    current = manifest.base;
  }
  return out;
}

// ---------------------------------------------------------------------------
// File names under a session's blob directory

export type StoredKind = "whole" | "part" | "list" | "manifest";
const SUFFIX: Record<StoredKind, string> = { whole: "", part: ".part", list: ".list", manifest: ".manifest" };
const STORED_NAME = /^([0-9a-f]{64})(?:\.(part|list|manifest))?$/;

/** `ab/<digest>[.part|.list|.manifest]`, relative to the blob directory. */
export function storedName(digest: string, kind: StoredKind): string {
  return `${digest.slice(0, 2)}/${digest}${SUFFIX[kind]}`;
}
/** The digest and kind a file name under a shard names, or undefined. */
export function parseStoredFile(shard: string, name: string): { digest: string; kind: StoredKind } | undefined {
  const match = STORED_NAME.exec(name);
  if (!match || !name.startsWith(shard) || !/^[0-9a-f]{2}$/.test(shard)) return undefined;
  return { digest: match[1]!, kind: (match[2] ?? "whole") as StoredKind };
}
/** Whether a stored file's bytes are intact: a whole body, part or list hashes
 * to its name; a manifest matches its own first line and names its body. */
export function storedFileIntact(digest: string, kind: StoredKind, bytes: Buffer): boolean {
  if (kind !== "manifest") return sha256(bytes) === digest;
  try { decodeManifest(bytes.toString("utf8"), digest); return true; } catch { return false; }
}
