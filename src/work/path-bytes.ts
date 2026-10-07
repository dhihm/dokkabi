/**
 * PATHS ARE BYTES (D57, design memo §111 R1): a path, a name or a link target
 * the host saves, compares, lists in a manifest or writes back is its exact
 * bytes, end to end. Text is produced only to be shown — a reason, a report
 * line, a listing a person or a model reads — and never flows back into a
 * path, a comparison or a manifest's exact field.
 *
 * Four review rounds (D55, D56) each found one more place where a path went
 * through text on its way and came back as another path: a pax body decoded
 * whole and cut at byte offsets, a strict UTF-8 decoder that drops a leading
 * U+FEFF, a listing that skipped what did not decode. The helpers below are
 * the one way pre-fix-state.ts, session-scratch.ts, verifier-files.ts and
 * recheck-inputs.ts split, join, compare and key paths, so none of them has
 * to decode one to do it.
 */

const SLASH = 0x2f;
const SLASH_BYTES = Buffer.from([SLASH]);
const DOT = Buffer.from(".");
const DOT_DOT = Buffer.from("..");

/** `rel` below `root`: `<root>/<rel>`, as bytes (Node's fs takes a Buffer
 * path). An empty `rel` is `root` itself. */
export function beneath(root: string | Buffer, rel: Buffer): Buffer {
  const base = typeof root === "string" ? Buffer.from(root) : root;
  return rel.length === 0 ? Buffer.from(base) : Buffer.concat([base, SLASH_BYTES, rel]);
}

/** A path's segments, split on `/`. */
export function segments(path: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  for (let at = 0; at <= path.length; at += 1) {
    if (at === path.length || path[at] === SLASH) {
      out.push(path.subarray(from, at));
      from = at + 1;
    }
  }
  return out;
}

/** Segments joined with `/`. */
export function joinSegments(parts: readonly Buffer[]): Buffer {
  const out: Buffer[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(SLASH_BYTES);
    out.push(part);
  });
  return Buffer.concat(out);
}

/** The directory a relative path lies in, or undefined for a top-level one. */
export function parentOf(path: Buffer): Buffer | undefined {
  const at = path.lastIndexOf(SLASH);
  return at <= 0 ? undefined : path.subarray(0, at);
}

/** Every directory above a relative path, outermost first. */
export function ancestorsOf(path: Buffer): Buffer[] {
  const parts = segments(path);
  const out: Buffer[] = [];
  for (let depth = 1; depth < parts.length; depth += 1) out.push(joinSegments(parts.slice(0, depth)));
  return out;
}

/** A relative path with no empty, `.` or `..` segment and no NUL byte. */
export function isPlainRelative(path: Buffer): boolean {
  if (path.length === 0 || path.includes(0) || path[0] === SLASH) return false;
  return segments(path).every((part) => part.length > 0 && !part.equals(DOT) && !part.equals(DOT_DOT));
}

/** Whether `path` is `dir` or lies below it. */
export function isWithin(dir: Buffer, path: Buffer): boolean {
  if (path.equals(dir)) return true;
  return path.length > dir.length && path[dir.length] === SLASH && path.subarray(0, dir.length).equals(dir);
}

/** Whether the last segment of `path` is exactly `name`. */
export function lastSegmentIs(path: Buffer, name: Buffer): boolean {
  if (path.equals(name)) return true;
  return path.length > name.length && path[path.length - name.length - 1] === SLASH && path.subarray(path.length - name.length).equals(name);
}

/** The NUL-separated entries of git's `-z` output (or any such list), as
 * exact bytes; empty entries are dropped. */
export function splitNul(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  for (let at = bytes.indexOf(0); at >= 0; at = bytes.indexOf(0, from)) {
    if (at > from) out.push(bytes.subarray(from, at));
    from = at + 1;
  }
  if (from < bytes.length) out.push(bytes.subarray(from));
  return out;
}

/** Paths joined for git's `--stdin -z`: each followed by a NUL. */
export function joinNul(paths: readonly Buffer[]): Buffer {
  return Buffer.concat(paths.flatMap((path) => [path, Buffer.alloc(1)]));
}

/** A key for a Map or a Set: the bytes one character each (latin1), exact and
 * reversible (bytesOfKey). Never a path, never shown. */
export function bytesKey(bytes: Buffer): string {
  return bytes.toString("latin1");
}

/** The bytes a key stands for (bytesKey's inverse). */
export function bytesOfKey(key: string): Buffer {
  return Buffer.from(key, "latin1");
}

/** Text of bytes that are strictly UTF-8 — then exactly those bytes, a
 * leading U+FEFF kept — else undefined. For what is shown or inlined as text
 * (an order's file text, a display name); never for a path's identity. */
export function exactUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A path as a person reads it in a reason or a listing: its exact text when
 * it is UTF-8, otherwise every byte that is not printable ASCII as `\xNN`.
 * Display only: the exact bytes ride beside it wherever they are needed. */
export function displayPath(bytes: Buffer): string {
  const text = exactUtf8(bytes);
  if (text !== undefined) return text;
  let out = "";
  for (const byte of bytes) out += byte >= 0x20 && byte < 0x7f && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`;
  return out;
}

/** Canonical base64 back to its bytes, or undefined when it is not. */
export function exactBase64(value: unknown): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}
