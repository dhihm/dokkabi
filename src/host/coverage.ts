import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { canonicalJson } from "./canonical.ts";
import { readDirectoryBytes } from "./fs-bytes.ts";
import { isExcludedBy, parseIgnoreFile, PATTERN_MAX_FILE_SIZE, type IgnoreList } from "./gitignore.ts";
import { beneath, bytesKey, bytesOfKey } from "../work/path-bytes.ts";

/**
 * WHAT AN IMAGE COVERS IS THE HOST'S DECISION (D57e, design memo §117 C1).
 *
 * A receipt's image, the plan tools' immobility check, the require-plan
 * guard and every change set are computed over the paths this module lists:
 * the host's own walk of the tree — never through a link — under a
 * CoverageBase the host established before the session could write:
 *
 *   - the FIXED HOST EXCLUSION LIST (HOST_EXCLUDED_NAMES): names never
 *     walked, at any depth;
 *   - the IGNORE RULES IN EFFECT AT THE BASE: the exact bytes of every
 *     `.gitignore` the host read when it established the base, evaluated with
 *     git's semantics in process (gitignore.ts). A rule written after the base
 *     decides nothing; a changed or new `.gitignore` is covered content like
 *     any other file (a file named `.gitignore` is never excluded by a rule);
 *   - the paths TRACKED AT THE BASE (the index and HEAD's tree then, read as
 *     data): always covered, even below an ignored or excluded directory.
 *
 * The live index and its flags (assume-unchanged, skip-worktree),
 * `.git/info/exclude`, `core.excludesFile`, `core.worktree`, a `.git` file
 * and a nested repository decide nothing: no git process takes part in a
 * walk. A nested repository's files are covered like any others (only its
 * `.git` is excluded, by name).
 *
 * NOTHING A CASE CAN READ IS OUTSIDE THE IMAGE (C1', D57f, memo §118).
 * Exclusion — a fixed name or a base rule — exempts a location from CONTENT
 * hashing only: it is a StateRegion, identified by the host's lstat of
 * everything in it (device, inode, change and modification time to the
 * nanosecond, size, mode; never followed, never read), so any write inside
 * moves it. A file that is neither regular nor a link is one too. What the
 * host cannot list or read is `unreadable` — unknown, never equal to
 * anything.
 */

/**
 * THE FIXED HOST EXCLUSION LIST, minimal and explicit. Every name below is a
 * directory whose content is never the product, which a session's ordinary
 * runs rewrite without any product change (churn, measured with a pytest-style
 * and a node-style greenfield session: docs/development-journal.md D57e), and
 * which every ecosystem that makes it regenerates from covered inputs:
 *
 *   `.git`          git's own metadata — the index, refs, objects and logs
 *                   move with every git command, the host's included; what a
 *                   session did to the product is in the work tree.
 *   `node_modules`  the npm/bun dependency install tree, rebuilt from
 *                   package.json and the lock file (both covered); tens of
 *                   thousands of files a digest would read.
 *   `__pycache__`   CPython's bytecode cache: every import of a changed or
 *                   new module writes it, so every case run changes it.
 *   `.pytest_cache` pytest's run state (last failed, node ids), rewritten by
 *                   every run whose outcome or collection differs; pytest
 *                   marks it ignored itself (its own `.gitignore` of `*`).
 *
 * Considered and NOT excluded (covered): virtual environments (`.venv`,
 * `venv`: they do not churn between case runs, and a name that is only a
 * convention would let a session hide product code under it), build outputs
 * (`dist`, `build`, `target`), coverage and other tool caches (`.mypy_cache`,
 * `.ruff_cache`, `.tox`, `coverage`): a repository that does not want them
 * covered ignores them in its own `.gitignore`, which the base captures.
 * Anything under an excluded name is still covered by content when it was
 * tracked at the base. Since C1' (D57f) an excluded name is spared content
 * hashing only: what lies under it is covered by inode state.
 */
export const HOST_EXCLUDED_NAMES: readonly string[] = Object.freeze([".git", "node_modules", "__pycache__", ".pytest_cache"]);

const EXCLUDED: readonly Buffer[] = HOST_EXCLUDED_NAMES.map((name) => Buffer.from(name));
const GITIGNORE = Buffer.from(".gitignore");
const SLASH = Buffer.from("/");

/** How a base's ignore rules are found: the rule lists it captured, by the
 * directory each lies in (bytesKey, "" the root); or, while a base is being
 * established, read from the tree as the walk reaches each directory. */
export type CoverageRules = ReadonlyMap<string, IgnoreList> | "capture";

export interface CoverageBase {
  /**
   * `session`: established by the host at a session's start (or, for a
   * recheck, the fix session's start). `unknown` (B1, D57f): the base the
   * host needs cannot be had (none was taken, it cannot be read, it does not
   * match its row) — no fallback listing stands in: every image under it is
   * UNKNOWN and never equals another, and every decision that needs it is
   * unknown. `tree`: the tree's own rules as they are NOW — for trees no
   * session could have written since (tests, a copy the host just made from
   * a base it knows), never for a session's own tree.
   */
  readonly kind: "session" | "unknown" | "tree";
  /** sha256 over what decides coverage: kind, exclusions, tracked paths and
   * the captured rule bytes. Two bases with one identity cover alike. */
  readonly identity: string;
  /** Paths tracked at the base (bytesKey): always covered by content. */
  readonly tracked: ReadonlySet<string>;
  /** The inodes (`dev:ino`) the base recorded for its tracked files (P2): a
   * path the file system resolves to one of them is tracked however it is
   * spelled now. */
  readonly trackedInodes?: ReadonlySet<string>;
  readonly rules: CoverageRules;
  /** kind `unknown`: why the base cannot be had. */
  readonly reason?: string;
}

/** One covered entry of a walk: a regular file, a symbolic link or (in
 * `dirs`) a directory, with the host's lstat of it. */
export interface CoveredEntry {
  readonly path: Buffer;
  readonly stat: BigIntStats;
}

/** A path whose content the host cannot know: a directory it cannot list or
 * search, a path below one, a region it could not list whole. `stat` its
 * state when the host could read it. Anything here makes the image UNKNOWN
 * (C1', D57f): it never equals another image. */
export interface UnreadableEntry {
  readonly path: Buffer;
  readonly stat: BigIntStats | undefined;
  readonly why: string;
}

/**
 * A location the image covers by INODE STATE instead of content (C1',
 * D57f): a fixed-exclusion name, a path the base's rules ignore, or a file
 * that is neither regular nor a link (a FIFO, a socket, a device) — with
 * everything below it, each by the host's lstat (never followed). Exclusion
 * exempts a location from content hashing only: any write inside moves some
 * entry's change time, which no execution can set, so the region's identity
 * moves (behind the ctime fence the digest applies).
 */
export interface StateRegion {
  readonly path: Buffer;
  readonly why: "excluded" | "ignored" | "special";
  /** The region's top and everything below it, relative to the tree's root. */
  readonly items: readonly CoveredEntry[];
}

export interface Walked {
  /** Covered files and links, sorted by path bytes, each once: identified by
   * content (a file) or by target and what it resolves to (a link). */
  readonly entries: readonly CoveredEntry[];
  /** Covered directories below the root (identified by path and mode). */
  readonly dirs: readonly CoveredEntry[];
  /** Locations covered by inode state, sorted by path bytes. */
  readonly regions: readonly StateRegion[];
  readonly unreadable: readonly UnreadableEntry[];
  /** In capture mode: the bytes of every `.gitignore` the walk read, by the
   * directory it lies in (bytesKey). */
  readonly captured: ReadonlyMap<string, Buffer>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The identity of a base's coverage decision. */
export function coverageIdentity(input: {
  readonly kind: CoverageBase["kind"];
  readonly tracked: Iterable<string>;
  readonly ruleBytes: ReadonlyMap<string, Buffer>;
}): string {
  return sha256(canonicalJson({
    kind: input.kind,
    exclusions: [...HOST_EXCLUDED_NAMES],
    tracked: [...input.tracked].map((key) => bytesOfKey(key).toString("base64")).sort(),
    rules: [...input.ruleBytes.entries()].map(([dir, bytes]) => [bytesOfKey(dir).toString("base64"), sha256(bytes)]).sort(),
  }));
}

/** A base built from captured rule bytes and tracked paths. */
export function coverageOf(
  kind: CoverageBase["kind"],
  tracked: ReadonlySet<string>,
  ruleBytes: ReadonlyMap<string, Buffer>,
  trackedInodes?: ReadonlySet<string>,
): CoverageBase {
  const rules = new Map<string, IgnoreList>();
  for (const [dir, bytes] of ruleBytes) {
    const dirBytes = bytesOfKey(dir);
    rules.set(dir, parseIgnoreFile(bytes, dirBytes.length === 0 ? dirBytes : Buffer.concat([dirBytes, SLASH])));
  }
  return {
    kind,
    identity: coverageIdentity({ kind, tracked, ruleBytes }),
    tracked,
    ...(trackedInodes === undefined ? {} : { trackedInodes }),
    rules,
  };
}

/** No base the host can have (B1, D57f): every image under it is unknown,
 * and says why. The walk under it applies no rule (only the fixed host
 * exclusions), so a listing still shows what is there. */
export function unknownCoverage(reason: string): CoverageBase {
  return { ...coverageOf("tree", new Set(), new Map()), kind: "unknown", identity: `unknown:${sha256(reason)}`, reason };
}

/** Read a directory's `.gitignore` as git does in a work tree: a regular
 * file only (a link to one is not followed, git ≥ 2.32), never blocking on a
 * FIFO; undefined when there is none. */
export function readIgnoreFile(dir: Buffer): Buffer | undefined {
  const path = Buffer.concat([dir, SLASH, GITIGNORE]);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PATTERN_MAX_FILE_SIZE) return undefined;
    const out = Buffer.alloc(stat.size);
    let read = 0;
    while (read < out.length) {
      const got = readSync(fd, out, read, out.length - read, read);
      if (got === 0) break;
      read += got;
    }
    return out.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function lstatOrUndefined(path: Buffer): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

const sameInode = (a: BigIntStats, b: BigIntStats | undefined) =>
  b !== undefined && b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;

/** The most entries a walk lists by inode state in one digest; a region
 * beyond it is unknown rather than partly listed. */
export const REGION_ENTRIES_MAX = 2_000_000;

const inodeKey = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;

/**
 * The host's walk of `root` under `base` (C1, D57e; C1', D57f): every
 * regular file and symbolic link it covers BY CONTENT, every directory it
 * walked, and every location it covers BY INODE STATE — sorted by path
 * bytes. Directories are descended only when real (a link is listed as
 * itself, never followed), each verified to be the directory it was before
 * and after it is listed. A fixed-exclusion name, a path the base's rules
 * ignore and a file that is neither regular nor a link are not content: each
 * is a StateRegion, listed whole by the host's lstat — nothing a case can
 * read is outside the image. A path tracked at the base (by exact bytes, or
 * as the file system resolves it: the inode the base recorded) is always
 * covered by content, even below an ignored or excluded directory. What the
 * host cannot list or read is `unreadable`. Writes nothing. Throws only
 * when the root itself cannot be read.
 */
export function walkCovered(root: string, base: CoverageBase, options: {
  /** Host-owned locations inside the tree (W2, D57g), by exact relative
   * path (bytesKey): never walked, never listed, never in an image. */
  readonly skip?: ReadonlySet<string>;
} = {}): Walked {
  const skip = options.skip ?? new Set<string>();
  const rootPath = Buffer.from(root);
  const entries: CoveredEntry[] = [];
  const dirs: CoveredEntry[] = [];
  const regions: StateRegion[] = [];
  const unreadable: UnreadableEntry[] = [];
  const captured = new Map<string, Buffer>();
  const listed = new Set<string>();
  const covered = new Set<string>();
  let regionEntries = 0;
  const rulesAt = (dir: Buffer, full: Buffer): IgnoreList | undefined => {
    if (base.rules === "capture") {
      const bytes = readIgnoreFile(full);
      if (bytes === undefined) return undefined;
      captured.set(bytesKey(dir), bytes);
      return parseIgnoreFile(bytes, dir.length === 0 ? dir : Buffer.concat([dir, SLASH]));
    }
    return base.rules.get(bytesKey(dir));
  };
  const trackedHere = (path: Buffer, stat: BigIntStats) =>
    base.tracked.has(bytesKey(path)) || (stat.isFile() && base.trackedInodes?.has(inodeKey(stat)) === true);
  /** A location covered by its inode state: its top and everything below. */
  const region = (path: Buffer, stat: BigIntStats, why: StateRegion["why"]): void => {
    const listedRegion = listRegion(rootPath, path, stat, REGION_ENTRIES_MAX - regionEntries, skip);
    if ("unreadable" in listedRegion) {
      unreadable.push(listedRegion.unreadable);
      return;
    }
    regionEntries += listedRegion.items.length;
    regions.push({ path, why, items: listedRegion.items });
  };
  const rootStat = lstatOrUndefined(rootPath);
  if (rootStat === undefined || !rootStat.isDirectory()) throw new Error("the tree to walk is not a directory");
  const pending: { rel: Buffer; lists: IgnoreList[]; stat: BigIntStats }[] = [{ rel: Buffer.alloc(0), lists: [], stat: rootStat }];
  while (pending.length > 0) {
    const { rel, lists, stat } = pending.pop()!;
    const full = beneath(rootPath, rel);
    let names: Buffer[];
    try {
      names = readDirectoryBytes(full);
    } catch (error) {
      if (rel.length === 0) throw error;
      unreadable.push({ path: rel, stat, why: `the host cannot list it (${errorCode(error) ?? "error"})` });
      continue;
    }
    // Listed as the directory the host found: a directory swapped for a link
    // (or anything else) while it was listed is not taken as its content.
    if (!sameInode(stat, lstatOrUndefined(full))) {
      if (rel.length === 0) throw new Error("the tree's root changed while it was walked");
      unreadable.push({ path: rel, stat, why: "it changed while the host listed it" });
      continue;
    }
    listed.add(bytesKey(rel));
    const own = rulesAt(rel, full);
    const childLists = own === undefined ? lists : [...lists, own];
    const below: { rel: Buffer; lists: IgnoreList[]; stat: BigIntStats }[] = [];
    for (const name of names) {
      const path = rel.length === 0 ? Buffer.from(name) : Buffer.concat([rel, SLASH, name]);
      if (skip.has(bytesKey(path))) continue;
      let entry: BigIntStats | undefined;
      try {
        entry = lstatOrUndefined(beneath(rootPath, path));
      } catch (error) {
        unreadable.push({ path, stat, why: `the host cannot read its state (${errorCode(error) ?? "error"})` });
        continue;
      }
      if (entry === undefined) continue;
      if (EXCLUDED.some((excluded) => excluded.equals(name))) {
        region(path, entry, "excluded");
        continue;
      }
      if (entry.isDirectory()) {
        if (isExcludedBy(childLists, path, true)) region(path, entry, "ignored");
        else {
          below.push({ rel: path, lists: childLists, stat: entry });
          dirs.push({ path, stat: entry });
        }
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        region(path, entry, "special");
        continue;
      }
      if (trackedHere(path, entry) || name.equals(GITIGNORE) || !isExcludedBy(childLists, path, false)) {
        entries.push({ path, stat: entry });
        covered.add(bytesKey(path));
      } else {
        region(path, entry, "ignored");
      }
    }
    // Depth-first; the order of `entries` is fixed by the sort below.
    for (let index = below.length - 1; index >= 0; index -= 1) pending.push(below[index]!);
  }
  // Tracked at the base, below a directory the walk did not list (excluded by
  // name or by a rule, or not a real directory): reached component by
  // component, never through a link, and covered by content besides the
  // region's state.
  for (const key of base.tracked) {
    if (covered.has(key)) continue;
    const path = bytesOfKey(key);
    const slash = path.lastIndexOf(0x2f);
    if (slash > 0 && listed.has(bytesKey(path.subarray(0, slash)))) continue;
    if (slash < 0) continue;
    const reached = reachTracked(rootPath, path);
    if (reached === undefined) continue;
    if ("blockedBy" in reached) {
      unreadable.push({ path, stat: reached.blockedBy, why: "the host cannot reach it" });
      continue;
    }
    entries.push({ path, stat: reached.stat });
    covered.add(key);
  }
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  dirs.sort((a, b) => Buffer.compare(a.path, b.path));
  regions.sort((a, b) => Buffer.compare(a.path, b.path));
  unreadable.sort((a, b) => Buffer.compare(a.path, b.path));
  return { entries, dirs, regions, unreadable, captured };
}

/**
 * A region's top and everything below it, by the host's lstat — directories
 * descended only when real, each verified to be the directory it was before
 * and after it is listed; nothing read, nothing followed. `unreadable` when
 * any part of it cannot be listed (or it holds more than `bound` entries):
 * the region is then unknown as a whole.
 */
export function listRegion(
  root: Buffer,
  top: Buffer,
  stat: BigIntStats,
  bound: number = REGION_ENTRIES_MAX,
  skip: ReadonlySet<string> = new Set(),
): { readonly items: CoveredEntry[] } | { readonly unreadable: UnreadableEntry } {
  const items: CoveredEntry[] = [{ path: top, stat }];
  if (!stat.isDirectory()) return { items };
  const pending: { rel: Buffer; stat: BigIntStats }[] = [{ rel: top, stat }];
  while (pending.length > 0) {
    const { rel, stat: dirStat } = pending.pop()!;
    const full = beneath(root, rel);
    let names: Buffer[];
    try {
      names = readDirectoryBytes(full);
    } catch (error) {
      return { unreadable: { path: rel, stat: dirStat, why: `the host cannot list it (${errorCode(error) ?? "error"})` } };
    }
    if (!sameInode(dirStat, lstatOrUndefined(full))) {
      return { unreadable: { path: rel, stat: dirStat, why: "it changed while the host listed it" } };
    }
    for (const name of names) {
      const path = Buffer.concat([rel, SLASH, name]);
      if (skip.has(bytesKey(path))) continue;
      let entry: BigIntStats | undefined;
      try {
        entry = lstatOrUndefined(beneath(root, path));
      } catch (error) {
        return { unreadable: { path, stat: dirStat, why: `the host cannot read its state (${errorCode(error) ?? "error"})` } };
      }
      if (entry === undefined) continue;
      items.push({ path, stat: entry });
      if (items.length > bound) return { unreadable: { path: top, stat, why: "it holds more entries than the host lists" } };
      if (entry.isDirectory()) pending.push({ rel: path, stat: entry });
    }
  }
  return { items };
}

/** A tracked path below directories the walk did not list: each directory
 * above it must be real (lstat, never followed); the path itself a file or a
 * link. Undefined when it is not there as one. */
function reachTracked(root: Buffer, path: Buffer): { stat: BigIntStats } | { blockedBy: BigIntStats | undefined } | undefined {
  let at = 0;
  let above: BigIntStats | undefined;
  for (;;) {
    const slash = path.indexOf(0x2f, at);
    if (slash < 0) break;
    const dir = path.subarray(0, slash);
    let stat: BigIntStats | undefined;
    try {
      stat = lstatOrUndefined(beneath(root, dir));
    } catch (error) {
      const code = errorCode(error);
      return code === "EACCES" || code === "EPERM" ? { blockedBy: above } : undefined;
    }
    if (stat === undefined || !stat.isDirectory()) return undefined;
    above = stat;
    at = slash + 1;
  }
  let stat: BigIntStats | undefined;
  try {
    stat = lstatOrUndefined(beneath(root, path));
  } catch (error) {
    const code = errorCode(error);
    return code === "EACCES" || code === "EPERM" ? { blockedBy: above } : undefined;
  }
  if (stat === undefined || (!stat.isFile() && !stat.isSymbolicLink())) return undefined;
  return { stat };
}
