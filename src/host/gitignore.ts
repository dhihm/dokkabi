/**
 * GITIGNORE SEMANTICS, EVALUATED BY THE HOST (D57e, design memo §117 C1).
 *
 * What an image covers is decided by the host from rules it captured before a
 * session could write: the exact bytes of every `.gitignore` in effect when the
 * base was established (coverage-base.ts). Those bytes are evaluated here, in
 * process, with git's own semantics — a port of git's dir.c pattern parsing
 * and matching and of wildmatch.c — so no git process, no repository
 * configuration and no rule written after the base takes part in the
 * decision. tests/gitignore-equivalence-property.test.ts holds this module to
 * `git ls-files --others --exclude-standard` on generated trees and rule sets
 * (nested files, anchoring, negation, directory-only patterns, `**`, classes,
 * escapes, trailing spaces, CRLF, BOM, comments, precedence).
 *
 * Deliberate, documented differences from a repository's own git, all toward
 * covering MORE (never hiding a change):
 *   - only per-directory `.gitignore` files are rules: `.git/info/exclude` and
 *     `core.excludesFile` decide nothing (C1);
 *   - matching is by exact bytes (`core.ignoreCase=false`,
 *     `core.precomposeUnicode=false`), whatever the file system;
 *   - a `.gitignore` git would read from the index (skip-worktree) is not a
 *     rule: only the bytes the host read in the tree count.
 *
 * Paths are bytes (R1): patterns and paths are compared byte by byte, never
 * decoded.
 */

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const STAR = 0x2a;
const QUESTION = 0x3f;
const BRACKET_OPEN = 0x5b;
const BRACKET_CLOSE = 0x5d;
const BANG = 0x21;
const CARET = 0x5e;
const HASH = 0x23;
const SPACE = 0x20;
const DASH = 0x2d;
const COLON = 0x3a;
const NEWLINE = 0x0a;
const CR = 0x0d;

/** git refuses a pattern file past this size (dir.c PATTERN_MAX_FILE_SIZE):
 * such a file holds no rule at all. */
export const PATTERN_MAX_FILE_SIZE = 100 * 1024 * 1024;

const FLAG_NODIR = 1;
const FLAG_ENDSWITH = 4;
const FLAG_MUSTBEDIR = 8;
const FLAG_NEGATIVE = 16;

/** One parsed pattern of one `.gitignore` (dir.c `struct path_pattern`). */
export interface IgnorePattern {
  /** The pattern bytes without a leading `!` or a trailing `/`. */
  readonly pattern: Buffer;
  /** Bytes before the first glob-special byte (`simple_length`), capped at
   * the pattern's length. */
  readonly nowildcardlen: number;
  readonly flags: number;
}

/** The patterns of one `.gitignore`, and the directory it lies in: `base`
 * is that directory's path below the root with a trailing `/` (empty for the
 * root's own file). */
export interface IgnoreList {
  readonly base: Buffer;
  readonly patterns: readonly IgnorePattern[];
}

// --- git's ctype (git-compat-util.h sane_ctype): ASCII only ---------------------

function isGlobSpecial(c: number): boolean {
  return c === STAR || c === QUESTION || c === BRACKET_OPEN || c === BACKSLASH;
}
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
/** git's isspace: space, tab, LF, CR — not VT, not FF. */
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isPrint = (c: number) => c >= 0x20 && c <= 0x7e;
const isCntrl = (c: number) => c < 0x20 || c === 0x7f;
const isPunct = (c: number) => (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
const isXdigit = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isLower = (c: number) => c >= 0x61 && c <= 0x7a;
const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;

// --- wildmatch.c ---------------------------------------------------------------------

const WM_MATCH = 0;
const WM_NOMATCH = 1;
const WM_ABORT_ALL = -1;
const WM_ABORT_TO_STARSTAR = -2;
/** wildmatch's WM_PATHNAME: `*` and `?` and a class never match `/`. */
export const WM_PATHNAME = 2;

/** The byte at `i`, or 0 past the end (the C string's terminator). */
function at(bytes: Uint8Array, i: number): number {
  return i < bytes.length ? bytes[i]! : 0;
}

function indexOfSlash(text: Uint8Array, from: number): number {
  for (let i = from; i < text.length; i += 1) if (text[i] === SLASH) return i;
  return -1;
}

/** A POSIX class by name (`[[:alpha:]]`); undefined when the name is none. */
function classMatches(name: string, c: number): boolean | undefined {
  switch (name) {
    case "alnum": return isAlpha(c) || isDigit(c);
    case "alpha": return isAlpha(c);
    case "blank": return c === 0x20 || c === 0x09;
    case "cntrl": return isCntrl(c);
    case "digit": return isDigit(c);
    case "graph": return isPrint(c) && !isSpace(c);
    case "lower": return isLower(c);
    case "print": return isPrint(c);
    case "punct": return isPunct(c);
    case "space": return isSpace(c);
    case "upper": return isUpper(c);
    case "xdigit": return isXdigit(c);
    default: return undefined;
  }
}

/** git's dowild(): match pattern `p` from `pi` against `text` from `ti`. */
function dowild(p: Uint8Array, pi: number, text: Uint8Array, ti: number, flags: number): number {
  const patternStart = pi;
  for (; ; ti += 1, pi += 1) {
    let pch = at(p, pi);
    if (pch === 0) break;
    let tch = at(text, ti);
    if (tch === 0 && pch !== STAR) return WM_ABORT_ALL;
    switch (pch) {
      case BACKSLASH:
        // A literal match with the next byte; a trailing backslash compares
        // against the terminator and so never matches.
        pi += 1;
        pch = at(p, pi);
        if (tch !== pch) return WM_NOMATCH;
        continue;
      case QUESTION:
        if ((flags & WM_PATHNAME) !== 0 && tch === SLASH) return WM_NOMATCH;
        continue;
      case STAR: {
        let matchSlash: boolean;
        pi += 1;
        if (at(p, pi) === STAR) {
          const prevP = pi - 2;
          pi += 1;
          while (at(p, pi) === STAR) pi += 1;
          if ((prevP < patternStart || at(p, prevP) === SLASH)
            && (at(p, pi) === 0 || at(p, pi) === SLASH || (at(p, pi) === BACKSLASH && at(p, pi + 1) === SLASH))) {
            // `**/` may match nothing: try the rest of the pattern here.
            if (at(p, pi) === SLASH && dowild(p, pi + 1, text, ti, flags) === WM_MATCH) return WM_MATCH;
            matchSlash = true;
          } else {
            matchSlash = false;
          }
        } else {
          // Without WM_PATHNAME, `*` is `**`.
          matchSlash = (flags & WM_PATHNAME) === 0;
        }
        if (at(p, pi) === 0) {
          // A trailing `**` matches everything; a trailing `*` only when no
          // slash is left.
          if (!matchSlash && indexOfSlash(text, ti) >= 0) return WM_NOMATCH;
          return WM_MATCH;
        }
        if (!matchSlash && at(p, pi) === SLASH) {
          // One `*` followed by a slash under WM_PATHNAME matches up to the
          // next slash, which the loop then consumes with the pattern's.
          const slash = indexOfSlash(text, ti);
          if (slash < 0) return WM_NOMATCH;
          ti = slash;
          break;
        }
        for (;;) {
          if (tch === 0) break;
          if (!isGlobSpecial(at(p, pi))) {
            // Advance to the next occurrence of the literal that follows.
            pch = at(p, pi);
            for (;;) {
              tch = at(text, ti);
              if (tch === 0 || (!matchSlash && tch === SLASH)) break;
              if (tch === pch) break;
              ti += 1;
            }
            if (tch !== pch) {
              if (matchSlash) return WM_ABORT_ALL;
              break;
            }
          }
          const matched = dowild(p, pi, text, ti, flags);
          if (matched !== WM_NOMATCH) {
            if (!matchSlash || matched !== WM_ABORT_TO_STARSTAR) return matched;
          } else if (!matchSlash && tch === SLASH) {
            return WM_ABORT_TO_STARSTAR;
          }
          ti += 1;
          tch = at(text, ti);
        }
        return WM_ABORT_ALL;
      }
      case BRACKET_OPEN: {
        pi += 1;
        pch = at(p, pi);
        if (pch === CARET) pch = BANG;
        const negated = pch === BANG;
        if (negated) {
          pi += 1;
          pch = at(p, pi);
        }
        let prevCh = 0;
        let matched = false;
        // do { body } while (prev_ch = p_ch, (p_ch = *++p) != ']');
        for (;;) {
          body: {
            if (pch === 0) return WM_ABORT_ALL;
            if (pch === BACKSLASH) {
              pi += 1;
              pch = at(p, pi);
              if (pch === 0) return WM_ABORT_ALL;
              if (tch === pch) matched = true;
            } else if (pch === DASH && prevCh !== 0 && at(p, pi + 1) !== 0 && at(p, pi + 1) !== BRACKET_CLOSE) {
              pi += 1;
              pch = at(p, pi);
              if (pch === BACKSLASH) {
                pi += 1;
                pch = at(p, pi);
                if (pch === 0) return WM_ABORT_ALL;
              }
              if (tch <= pch && tch >= prevCh) matched = true;
              pch = 0;
            } else if (pch === BRACKET_OPEN && at(p, pi + 1) === COLON) {
              pi += 2;
              const s = pi;
              for (; (pch = at(p, pi)) !== 0 && pch !== BRACKET_CLOSE; pi += 1) {
                // the shared iterator
              }
              if (pch === 0) return WM_ABORT_ALL;
              const length = pi - s - 1;
              if (length < 0 || at(p, pi - 1) !== COLON) {
                // No ":]": a plain `[` in the set.
                pi = s - 2;
                pch = BRACKET_OPEN;
                if (tch === pch) matched = true;
                break body;
              }
              const name = Buffer.from(p.subarray(s, s + length)).toString("latin1");
              const hit = classMatches(name, tch);
              if (hit === undefined) return WM_ABORT_ALL;
              if (hit) matched = true;
              pch = 0;
            } else if (tch === pch) {
              matched = true;
            }
          }
          prevCh = pch;
          pi += 1;
          pch = at(p, pi);
          if (pch === BRACKET_CLOSE) break;
        }
        if (matched === negated || ((flags & WM_PATHNAME) !== 0 && tch === SLASH)) return WM_NOMATCH;
        continue;
      }
      default:
        if (tch !== pch) return WM_NOMATCH;
        continue;
    }
  }
  return at(text, ti) !== 0 ? WM_NOMATCH : WM_MATCH;
}

/** git's wildmatch(): whether `pattern` matches all of `text`. */
export function wildmatch(pattern: Uint8Array, text: Uint8Array, flags: number): boolean {
  return dowild(pattern, 0, text, 0, flags) === WM_MATCH;
}

// --- dir.c: parsing ------------------------------------------------------------------

/** dir.c simple_length(): bytes before the first glob-special byte. */
function simpleLength(bytes: Buffer): number {
  for (let i = 0; i < bytes.length; i += 1) if (isGlobSpecial(bytes[i]!)) return i;
  return bytes.length;
}

/** dir.c trim_trailing_spaces(): unescaped trailing spaces go. */
function trimTrailingSpaces(entry: Buffer): Buffer {
  let lastSpace = -1;
  for (let i = 0; i < entry.length; i += 1) {
    const c = entry[i]!;
    if (c === SPACE) {
      if (lastSpace < 0) lastSpace = i;
    } else if (c === BACKSLASH) {
      i += 1;
      if (i >= entry.length) return entry;
      lastSpace = -1;
    } else {
      lastSpace = -1;
    }
  }
  return lastSpace < 0 ? entry : entry.subarray(0, lastSpace);
}

/** dir.c parse_path_pattern() + add_pattern(). */
function parsePattern(line: Buffer): IgnorePattern {
  let p = line;
  let flags = 0;
  if (p.length > 0 && p[0] === BANG) {
    flags |= FLAG_NEGATIVE;
    p = p.subarray(1);
  }
  const whole = p;
  let len = p.length;
  if (len > 0 && p[len - 1] === SLASH) {
    len -= 1;
    flags |= FLAG_MUSTBEDIR;
  }
  if (!p.subarray(0, len).includes(SLASH)) flags |= FLAG_NODIR;
  const nowildcardlen = Math.min(simpleLength(whole), len);
  // ENDSWITH is decided on the bytes before the trailing slash is dropped,
  // exactly as git does it.
  if (whole.length > 0 && whole[0] === STAR && simpleLength(whole.subarray(1)) === whole.length - 1) flags |= FLAG_ENDSWITH;
  return { pattern: Buffer.from(p.subarray(0, len)), nowildcardlen, flags };
}

/**
 * The patterns of one `.gitignore` as git reads them (dir.c add_patterns +
 * add_patterns_from_buffer): a leading UTF-8 BOM skipped, one pattern per line
 * (the last line counts without a newline), a CR before the newline dropped,
 * lines starting `#` and empty lines skipped, unescaped trailing spaces
 * trimmed; a line is cut at a NUL byte, as git's C strings are. A file over
 * PATTERN_MAX_FILE_SIZE holds nothing.
 */
export function parseIgnoreFile(bytes: Buffer, base: Buffer): IgnoreList {
  if (bytes.length === 0 || bytes.length > PATTERN_MAX_FILE_SIZE) return { base: Buffer.from(base), patterns: [] };
  let buf = bytes;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  // git appends a newline so the last line is a line too.
  buf = Buffer.concat([buf, Buffer.from([NEWLINE])]);
  const patterns: IgnorePattern[] = [];
  let entry = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== NEWLINE) continue;
    if (entry !== i && buf[entry] !== HASH) {
      let end = i;
      if (i > 0 && buf[i - 1] === CR) end = i - 1;
      if (end < entry) end = entry;
      let line = buf.subarray(entry, end);
      const nul = line.indexOf(0);
      if (nul >= 0) line = line.subarray(0, nul);
      patterns.push(parsePattern(trimTrailingSpaces(line)));
    }
    entry = i + 1;
  }
  return { base: Buffer.from(base), patterns };
}

// --- dir.c: matching -----------------------------------------------------------------

/** dir.c match_basename(). */
function matchBasename(basename: Buffer, pattern: IgnorePattern): boolean {
  const { pattern: bytes, nowildcardlen: prefix, flags } = pattern;
  const patternlen = bytes.length;
  if (prefix === patternlen) {
    return patternlen === basename.length && bytes.equals(basename);
  }
  if ((flags & FLAG_ENDSWITH) !== 0) {
    // "*literal" against "fooliteral".
    return patternlen - 1 <= basename.length
      && bytes.subarray(1).equals(basename.subarray(basename.length - (patternlen - 1)));
  }
  return wildmatch(bytes, basename, 0);
}

/** dir.c match_pathname(): `pathname` below the root; `base` the list's
 * directory without its trailing slash. */
function matchPathname(pathname: Buffer, base: Buffer, pattern: IgnorePattern): boolean {
  let bytes = pattern.pattern;
  let prefix = pattern.nowildcardlen;
  if (bytes.length > 0 && bytes[0] === SLASH) {
    bytes = bytes.subarray(1);
    prefix -= 1;
  }
  const baselen = base.length;
  if (pathname.length < baselen + 1
    || (baselen > 0 && pathname[baselen] !== SLASH)
    || !pathname.subarray(0, baselen).equals(base)) return false;
  const namelen = baselen > 0 ? pathname.length - baselen - 1 : pathname.length;
  let name = pathname.subarray(pathname.length - namelen);
  if (prefix > 0) {
    if (prefix > name.length) return false;
    if (!bytes.subarray(0, prefix).equals(name.subarray(0, prefix))) return false;
    bytes = bytes.subarray(prefix);
    name = name.subarray(prefix);
    if (bytes.length === 0 && name.length === 0) return true;
  }
  return wildmatch(bytes, name, WM_PATHNAME);
}

/** The last pattern of one list that matches (dir.c
 * last_matching_pattern_from_list), or undefined. */
function lastMatchInList(pathname: Buffer, basename: Buffer, isDir: boolean, list: IgnoreList): IgnorePattern | undefined {
  const base = list.base.length > 0 ? list.base.subarray(0, list.base.length - 1) : list.base;
  for (let i = list.patterns.length - 1; i >= 0; i -= 1) {
    const pattern = list.patterns[i]!;
    if ((pattern.flags & FLAG_MUSTBEDIR) !== 0 && !isDir) continue;
    if ((pattern.flags & FLAG_NODIR) !== 0) {
      if (matchBasename(basename, pattern)) return pattern;
      continue;
    }
    if (matchPathname(pathname, base, pattern)) return pattern;
  }
  return undefined;
}

/**
 * Whether `pathname` (below the root; its basename its last segment) is
 * excluded by `lists` — the rule files of the directories above it, root
 * first — with git's precedence: the deepest file first, in each file the
 * last matching pattern, a negation re-including. Whether a directory above
 * it is excluded is the caller's to have decided (the walk never descends
 * into one), exactly as git's traversal never does.
 */
export function isExcludedBy(lists: readonly IgnoreList[], pathname: Buffer, isDir: boolean): boolean {
  const slash = pathname.lastIndexOf(SLASH);
  const basename = slash >= 0 ? pathname.subarray(slash + 1) : pathname;
  for (let j = lists.length - 1; j >= 0; j -= 1) {
    const hit = lastMatchInList(pathname, basename, isDir, lists[j]!);
    if (hit !== undefined) return (hit.flags & FLAG_NEGATIVE) === 0;
  }
  return false;
}
