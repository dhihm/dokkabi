import type { WritableWorld } from "./writable-world.ts";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import {
  coverageOf,
  HOST_EXCLUDED_NAMES,
  walkCovered,
  type CoverageBase,
} from "./coverage.ts";
import { createDigestCache, workspaceListing, type DigestCache, type ListedEntry, type TreeListing } from "./execution-receipt.ts";
import { sealedNoIndexNumstat, spawnSealedHostGit } from "./git-authority.ts";
import { trustedGitMetadata } from "./sandbox-docker.ts";
import { ancestorsOf, beneath, bytesKey, bytesOfKey, exactUtf8, isPlainRelative, splitNul } from "../work/path-bytes.ts";

/**
 * THE HOST-OWNED BASE RECORD (D57e, design memo §117 C1).
 *
 * What an image covers, and which paths a session changed, are decided by the
 * host from state it established before that session could write. That state
 * is this record, taken when the host establishes a session's base — the
 * session's start, before its first model request (a recheck uses the fix
 * session's) — and stored in the session's own directory (`<session dir>/
 * base/`), outside every tree a session writes:
 *
 *   - the ignore rules in effect: the exact bytes of every `.gitignore` the
 *     host's walk read (objects/<sha256>);
 *   - the paths tracked then — the index and HEAD's tree, read through the
 *     sealed boundary as data — with their blob ids;
 *   - the host's listing of the tree under those rules: every covered path's
 *     kind, full mode and content digest (sha256, I1) and inode, or link
 *     target and what it resolves to; every directory's mode; every
 *     location covered by inode state (C1', D57f) by its state digest; what
 *     the host could not know, as unknown;
 *   - the bytes of the covered text files a later change set may have to
 *     count lines of and the base commit's objects may not give back — the
 *     caller's own first (a session's: its conventional test paths, whose
 *     lost lines decide tampering), then those untracked then or tracked
 *     with another size than their blob — bounded (BASE_BYTES_BOUNDS). A
 *     session that destroys or redirects its object store later cannot make
 *     them unreadable;
 *   - HEAD then.
 *
 * The record is canonical JSON; its sha256 is named by the session's
 * `work/base_record` row, and every load is held to it. A change set is the
 * host's content diff of this listing and a listing of the tree now
 * (BaseChanges) — never `git diff`; line counts are git's numstat of the base
 * bytes and the bytes now, both host-read, outside any repository.
 */

/** 2 since D57f: directories, regions covered by inode state, what a link
 * resolves to and each file's inode are part of the listing. A record of
 * another version is not read (its session's base is then unknown, B1). */
export const BASE_RECORD_VERSION = 2;
export const BASE_RECORD_FILE = "record.json";
const OBJECTS_DIR = "objects";

/** Bytes kept for line counts, at most: 1 MiB per file, 64 MiB in all. */
export const BASE_BYTES_BOUNDS = Object.freeze({ fileBytes: 1024 * 1024, totalBytes: 64 * 1024 * 1024 });

/** Bytes read of a file now to count its lines, at most. */
const CURRENT_BYTES_MAX = 16 * 1024 * 1024;
/** git's buffer_is_binary(): a NUL in the first 8000 bytes. */
const FIRST_FEW_BYTES = 8000;

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface TrackedAtBase {
  readonly indexOid?: string;
  readonly headOid?: string;
}

export interface BaseRecord {
  readonly version: 2;
  /** The tree the base was taken of (information: coverage is relative). */
  readonly root: string;
  readonly takenAt: string;
  readonly head?: string;
  readonly tracked: ReadonlyMap<string, TrackedAtBase>;
  /** The captured ignore files: directory (bytesKey) → sha256 of the bytes. */
  readonly ignoreFiles: ReadonlyMap<string, string>;
  /** Every covered path at the base as the host read it. */
  readonly entries: ReadonlyMap<string, ListedEntry>;
  /** Paths whose bytes are kept in the record's objects (bytesKey). */
  readonly stored: ReadonlySet<string>;
  /** Paths known to be binary at the base (bytesKey). */
  readonly binary: ReadonlySet<string>;
  readonly coverage: CoverageBase;
  /** Where it lives, and the sha256 of its record file. */
  readonly dir: string;
  readonly digest: string;
}

// --- tracked at the base ------------------------------------------------------------------

/** HEAD's commit and every path tracked at the base — HEAD's tree (I2,
 * D57g: never the tree's index, whose entries and flags the session writes;
 * an index entry `../outside.txt` names nothing here), gitlinks left out —
 * read through the sealed boundary (a host-built git directory: nothing the
 * tree's configuration names runs), each blob's size from the tree listing.
 * A path that is not a canonical relative byte path beneath the root (a
 * `..`, `.` or empty component, a leading `/`, a NUL) is refused and
 * returned in `refused`, never walked. Empty outside a repository the host
 * trusts. */
export function trackedAtBase(root: string): {
  readonly head?: string;
  readonly tracked: Map<string, TrackedAtBase>;
  readonly sizes: Map<string, number>;
  readonly refused: readonly Buffer[];
  /** HEAD's gitlinks (a nested repository's commit), by path: data. */
  readonly gitlinks: Map<string, string>;
} {
  const tracked = new Map<string, TrackedAtBase>();
  const sizes = new Map<string, number>();
  const refused: Buffer[] = [];
  const gitlinks = new Map<string, string>();
  if (trustedGitMetadata(root) === undefined) return { tracked, sizes, refused, gitlinks };
  const git = (args: readonly string[]) => {
    const run = spawnSealedHostGit(root, ["--no-optional-locks", "-c", "core.precomposeunicode=false", ...args], { timeoutMs: 120_000 });
    return (run.exitCode ?? 1) === 0 && (run as { exitedDueToMaxBuffer?: boolean }).exitedDueToMaxBuffer !== true ? run.stdout : undefined;
  };
  const headOut = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.toString().trim();
  const head = headOut !== undefined && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(headOut) ? headOut : undefined;
  if (head !== undefined) {
    const tree = git(["ls-tree", "-r", "-z", "-l", "--full-tree", head]);
    for (const record of tree === undefined ? [] : splitNul(tree)) {
      const tab = record.indexOf(0x09);
      if (tab < 0) continue;
      const [mode, type, oid, size] = record.subarray(0, tab).toString("latin1").split(/ +/u);
      const path = record.subarray(tab + 1);
      if (type === "commit" && mode === "160000" && oid !== undefined && isPlainRelative(path)) gitlinks.set(bytesKey(path), oid);
      if (type !== "blob" || oid === undefined) continue;
      if (!isPlainRelative(path)) {
        refused.push(path);
        continue;
      }
      const key = bytesKey(path);
      tracked.set(key, { headOid: oid });
      if (size !== undefined && /^\d+$/u.test(size)) sizes.set(key, Number(size));
    }
  }
  return { ...(head === undefined ? {} : { head }), tracked, sizes, refused, gitlinks };
}

/**
 * A base of the tree's own state NOW: the paths tracked in it now (as data,
 * trackedAtBase) and every `.gitignore` the walk reaches now. For trees no
 * session could have written since — a test's fixture, a copy the host made
 * from a tree it knows — never a session's own tree, whose base is its
 * base record (session-base.ts).
 */
export function treeCoverageNow(root: string, tracked: ReadonlySet<string> = new Set(trackedAtBase(root).tracked.keys())): CoverageBase {
  const walked = walkCovered(root, { kind: "tree", identity: "", tracked, rules: "capture" });
  return coverageOf("tree", tracked, walked.captured);
}

// --- establishing ---------------------------------------------------------------------------

/** A regular file read as data: never through a link, never blocking on a
 * FIFO; undefined when it is not a regular file of at most `limit` bytes. */
function readFileBounded(path: Buffer | string, limit: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
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

const isBinary = (bytes: Buffer) => bytes.subarray(0, FIRST_FEW_BYTES).includes(0);

function writeObject(dir: string, bytes: Buffer): string {
  const digest = sha256(bytes);
  const path = join(dir, OBJECTS_DIR, digest);
  if (!existsSync(path)) {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, path);
  }
  return digest;
}

/**
 * Establish the base of the tree at `root` into `dir` (created; whatever an
 * earlier record left there is replaced): the tracked paths, the rules the
 * host's walk captures, the listing under them, the kept bytes, the record.
 * `cache` (optional) is warmed with the listing's content digests. Throws
 * when any of it cannot be taken — a base is whole or there is none (B1).
 */
export function establishBaseRecord(input: {
  readonly root: string;
  readonly dir: string;
  readonly cache?: DigestCache;
  readonly bounds?: typeof BASE_BYTES_BOUNDS;
  /** Paths whose bytes are kept first, whatever the objects hold (a
   * session's conventional test paths). */
  readonly keepBytes?: (path: Buffer) => boolean;
  /** Told the digest cache the listing warmed (over the record's coverage):
   * the session's first digest need not read the tree again. */
  readonly onCache?: (cache: DigestCache) => void;
  /** The session's writable world (W, D57g): links followed into it, its
   * host-owned locations inside the tree left out. */
  readonly world?: WritableWorld;
}): BaseRecord {
  const { root, dir } = input;
  const bounds = input.bounds ?? BASE_BYTES_BOUNDS;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, OBJECTS_DIR), { recursive: true, mode: 0o700 });
  const { head, tracked, sizes, refused: refusedTracked } = trackedAtBase(root);
  const trackedKeys = new Set(tracked.keys());
  // The rules in effect: every `.gitignore` the host's walk reaches, read as
  // git reads one in a work tree, under the rules above it.
  const skip = hostOwnedKeys(root, input.world);
  const captured = new Map(walkCovered(root, { kind: "session", identity: "", tracked: trackedKeys, rules: "capture" }, { skip }).captured);
  const listedCoverage = coverageOf("session", trackedKeys, captured);
  const warm = input.cache !== undefined && input.cache.base.identity === listedCoverage.identity
    ? input.cache
    : createDigestCache(listedCoverage, { clockDirs: [dir], ...(input.world === undefined ? {} : { world: input.world }) });
  const listing = workspaceListing(root, warm);
  // What the host could not know at the base stays unknown in the record
  // (U1): every change set that meets it is unknown there.
  // The inodes of the files tracked at the base (P2): a path the file system
  // resolves to one of them is tracked however it is spelled later.
  const trackedInodes = new Set<string>();
  for (const key of trackedKeys) {
    const entry = listing.entries.get(key);
    if (entry?.kind === "file" && entry.inode !== undefined) trackedInodes.add(entry.inode);
  }
  const coverage = coverageOf("session", trackedKeys, captured, trackedInodes);
  const cache: DigestCache = { ...warm, base: coverage };
  input.onCache?.(cache);
  const ignoreFiles = new Map<string, string>();
  for (const [key, bytes] of captured) ignoreFiles.set(key, writeObject(dir, bytes));
  // The bytes kept for line counts, bounded: the caller's first, then the
  // ones the base commit's objects cannot give back.
  const stored = new Set<string>();
  const binary = new Set<string>();
  let storedBytes = 0;
  let unstoredText = 0;
  const wanted: string[] = [];
  const later: string[] = [];
  for (const [key, entry] of listing.entries) {
    // A kept link's bytes are what it resolves to (W1, D57g): kept too.
    if (entry.kind === "symlink" && entry.resolvedPath !== undefined && input.keepBytes?.(bytesOfKey(key)) === true) {
      wanted.push(key);
      continue;
    }
    if (entry.kind !== "file") continue;
    if (input.keepBytes?.(bytesOfKey(key)) === true) {
      wanted.push(key);
      continue;
    }
    const blobSize = sizes.get(key);
    if (blobSize === undefined || BigInt(blobSize) !== entry.size) later.push(key);
  }
  for (const key of [...wanted, ...later]) {
    const entry = listing.entries.get(key);
    if (entry === undefined) continue;
    if (entry.kind === "symlink") {
      const digest = resolvedFileDigest(entry.resolved);
      const bytes = entry.resolvedPath === undefined ? undefined : readFileBounded(entry.resolvedPath, bounds.fileBytes);
      if (digest === undefined || bytes === undefined || sha256(bytes) !== digest || storedBytes + bytes.length > bounds.totalBytes) {
        unstoredText += 1;
        continue;
      }
      if (isBinary(bytes)) {
        binary.add(key);
        continue;
      }
      writeObject(dir, bytes);
      stored.add(key);
      storedBytes += bytes.length;
      continue;
    }
    if (entry.kind !== "file") continue;
    if (entry.size < 0n || entry.size > BigInt(bounds.fileBytes) || storedBytes + Number(entry.size) > bounds.totalBytes) {
      unstoredText += 1;
      continue;
    }
    const bytes = readFileBounded(beneath(root, bytesOfKey(key)), bounds.fileBytes);
    if (bytes === undefined || sha256(bytes) !== entry.digest) {
      unstoredText += 1;
      continue;
    }
    if (isBinary(bytes)) {
      binary.add(key);
      continue;
    }
    writeObject(dir, bytes);
    stored.add(key);
    storedBytes += bytes.length;
  }
  const b64 = (key: string) => bytesOfKey(key).toString("base64");
  const body = canonicalJson({
    version: BASE_RECORD_VERSION,
    root,
    taken_at: new Date().toISOString(),
    head: head ?? null,
    exclusions: [...HOST_EXCLUDED_NAMES],
    coverage: coverage.identity,
    tracked: [...tracked.entries()].map(([key, item]) => [b64(key), item.indexOid ?? "", item.headOid ?? ""]).sort(),
    // I2: tracked paths refused as not canonical, recorded, never walked.
    ...(refusedTracked.length > 0 ? { refused_tracked: refusedTracked.map((path) => path.toString("base64")).sort() } : {}),
    ignore_files: [...ignoreFiles.entries()].map(([key, digest]) => [b64(key), digest]).sort(),
    entries: [...listing.entries.entries()].map(([key, entry]) => encodeEntry(b64(key), entry, stored.has(key), binary.has(key)))
      .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0),
    stored_bytes: storedBytes,
    unstored_text: unstoredText,
  });
  writeFileSync(join(dir, BASE_RECORD_FILE), body, { mode: 0o600 });
  return decodeBaseRecord(body, dir);
}

// --- loading ----------------------------------------------------------------------------------

const LOADED = new Map<string, BaseRecord>();

/** The record at `dir`, held to `digest` (the sha256 its row names); throws
 * when it is missing, altered or not a record this build reads. */
export function loadBaseRecord(dir: string, digest: string): BaseRecord {
  const cached = LOADED.get(`${dir}\0${digest}`);
  if (cached !== undefined) return cached;
  const body = readFileSync(join(dir, BASE_RECORD_FILE), "utf8");
  if (sha256(body) !== digest) throw new Error("the base record does not match the digest its row names");
  const record = decodeBaseRecord(body, dir);
  if (LOADED.size > 64) LOADED.clear();
  LOADED.set(`${dir}\0${digest}`, record);
  return record;
}

function decodeBaseRecord(body: string, dir: string): BaseRecord {
  const raw = JSON.parse(body) as Record<string, unknown>;
  if (raw.version !== BASE_RECORD_VERSION) throw new Error("the base record is not a version this build reads");
  const fromB64 = (value: unknown) => {
    if (typeof value !== "string") throw new Error("the base record holds a malformed path");
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error("the base record holds a malformed path");
    return bytes;
  };
  const tracked = new Map<string, TrackedAtBase>();
  for (const item of Array.isArray(raw.tracked) ? raw.tracked : []) {
    const [path, indexOid, headOid] = item as unknown[];
    tracked.set(bytesKey(fromB64(path)), {
      ...(typeof indexOid === "string" && indexOid !== "" ? { indexOid } : {}),
      ...(typeof headOid === "string" && headOid !== "" ? { headOid } : {}),
    });
  }
  const ignoreFiles = new Map<string, string>();
  const ruleBytes = new Map<string, Buffer>();
  for (const item of Array.isArray(raw.ignore_files) ? raw.ignore_files : []) {
    const [path, digest] = item as unknown[];
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) throw new Error("the base record names a malformed ignore file");
    const bytes = readFileSync(join(dir, OBJECTS_DIR, digest));
    if (sha256(bytes) !== digest) throw new Error("a captured ignore file does not match its digest");
    const key = bytesKey(fromB64(path));
    ignoreFiles.set(key, digest);
    ruleBytes.set(key, bytes);
  }
  const entries = new Map<string, ListedEntry>();
  const stored = new Set<string>();
  const binary = new Set<string>();
  for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
    const row = item as unknown[];
    const key = bytesKey(fromB64(row[0]));
    if (row[1] === "f" && typeof row[2] === "number" && typeof row[3] === "string" && typeof row[4] === "number") {
      entries.set(key, { kind: "file", mode: row[2], digest: row[3], size: BigInt(row[4]), ...(typeof row[7] === "string" ? { inode: row[7] } : {}) });
      if (row[5] === 1) stored.add(key);
      if (row[6] === 1) binary.add(key);
    } else if (row[1] === "l" && typeof row[3] === "string") {
      entries.set(key, { kind: "symlink", target: fromB64(row[2]), resolved: row[3], ...(typeof row[4] === "string" && row[4] !== "" ? { resolvedPath: fromB64(row[4]) } : {}) });
      if (row[5] === 1) stored.add(key);
      if (row[6] === 1) binary.add(key);
    } else if (row[1] === "d" && typeof row[2] === "number") {
      entries.set(key, { kind: "dir", mode: row[2] });
    } else if (row[1] === "s" && typeof row[2] === "string") {
      entries.set(key, { kind: "state", state: row[2] });
    } else if (row[1] === "u" && typeof row[2] === "string") {
      entries.set(key, { kind: "unreadable", state: row[2] });
    } else {
      throw new Error("the base record holds a malformed entry");
    }
  }
  const trackedInodes = new Set<string>();
  for (const key of tracked.keys()) {
    const entry = entries.get(key);
    if (entry?.kind === "file" && entry.inode !== undefined) trackedInodes.add(entry.inode);
  }
  const coverage = coverageOf("session", new Set(tracked.keys()), ruleBytes, trackedInodes);
  if (raw.coverage !== coverage.identity) throw new Error("the base record's coverage does not match its rules");
  return {
    version: 2,
    root: typeof raw.root === "string" ? raw.root : "",
    takenAt: typeof raw.taken_at === "string" ? raw.taken_at : "",
    ...(typeof raw.head === "string" ? { head: raw.head } : {}),
    tracked,
    ignoreFiles,
    entries,
    stored,
    binary,
    coverage,
    dir,
    digest: sha256(body),
  };
}

// --- change sets -------------------------------------------------------------------------------

export type BaseChange = "added" | "modified" | "deleted";

/** Line counts of one changed path: git's numstat of the base bytes and the
 * bytes now; `unknown` when either could not be read (the counts are then 0
 * and a decision that needs them must not take the change as harmless). */
export interface LineCounts {
  readonly added: number;
  readonly removed: number;
  readonly unknown?: true;
}

/** One listing entry as a record row (base64 path first). */
function encodeEntry(path: string, entry: ListedEntry, stored: boolean, binary: boolean): unknown[] {
  switch (entry.kind) {
    case "file":
      return [path, "f", entry.mode, entry.digest, Number(entry.size), stored ? 1 : 0, binary ? 1 : 0, ...(entry.inode === undefined ? [] : [entry.inode])];
    case "symlink":
      return [path, "l", entry.target.toString("base64"), entry.resolved, entry.resolvedPath === undefined ? "" : entry.resolvedPath.toString("base64"), stored ? 1 : 0, binary ? 1 : 0];
    case "dir":
      return [path, "d", entry.mode];
    case "state":
      return [path, "s", entry.state];
    default:
      return [path, "u", entry.state];
  }
}

/** Whether two listed entries are the same content. An unknown one is never
 * the same as anything (U1). */
function sameEntry(a: ListedEntry, b: ListedEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.digest === b.digest && a.mode === b.mode;
  if (a.kind === "symlink" && b.kind === "symlink") return a.target.equals(b.target) && a.resolved === b.resolved;
  if (a.kind === "dir" && b.kind === "dir") return a.mode === b.mode;
  if (a.kind === "state" && b.kind === "state") return a.state === b.state;
  return false;
}

/**
 * Which paths changed between the base and a listing of the tree now — the
 * host's content diff of two host listings (C1), never git's — and, for any
 * path asked, its line counts against the base (`get`, the shape the case
 * target observation reads). Paths are keyed by their exact UTF-8 text (a
 * command names paths as text); a path that is not UTF-8 is in `changedKeys`
 * only.
 */
export class BaseChanges {
  /** Every changed path, by exact bytes (bytesKey). */
  readonly changedKeys: ReadonlyMap<string, BaseChange>;
  private readonly byText = new Map<string, string>();
  private readonly counted = new Map<string, LineCounts>();

  constructor(
    readonly record: BaseRecord,
    readonly current: TreeListing,
    /** Where the tree now is read (a copy of it, or the tree itself). */
    readonly currentRoot: string,
    /** Trees whose object stores may hold the base's blobs (tried in order;
     * a blob is used only when its sha256 is the base's digest). */
    readonly objectRoots: readonly string[] = [currentRoot],
  ) {
    const changed = new Map<string, BaseChange>();
    for (const [key, entry] of record.entries) {
      const now = current.entries.get(key);
      if (now === undefined) changed.set(key, "deleted");
      else if (!sameEntry(entry, now)) changed.set(key, "modified");
    }
    for (const key of current.entries.keys()) if (!record.entries.has(key)) changed.set(key, "added");
    this.changedKeys = changed;
    for (const key of changed.keys()) {
      const text = exactUtf8(bytesOfKey(key));
      if (text !== undefined) this.byText.set(text, key);
    }
  }

  /** The line counts of `path` (workspace-relative text) when it changed;
   * undefined when it did not. The path is taken as the file system
   * resolves it in the tree now (P2: case and Unicode folded as the volume
   * folds them, the rest byte-exact). A path below a location the host could
   * not know, or below one covered only by inode state that moved, is
   * unknown (U1): it may have changed in any way. */
  get(path: string): LineCounts | undefined {
    const key = this.resolveKey(path);
    const known = this.counted.get(key);
    if (known !== undefined) return known;
    let counts: LineCounts | undefined;
    if (this.changedKeys.has(key)) counts = this.count(key);
    else if (this.belowUnknown(key)) counts = { added: 0, removed: 0, unknown: true };
    if (counts !== undefined) this.counted.set(key, counts);
    return counts;
  }

  /** The key a path's text names: its exact bytes when the listings hold
   * them, else the spelling the file system resolves it to now. */
  private resolveKey(path: string): string {
    const exact = this.byText.get(path) ?? bytesKey(Buffer.from(path));
    if (this.record.entries.has(exact) || this.current.entries.has(exact)) return exact;
    const resolved = resolvedRelative(this.currentRoot, path);
    return resolved === undefined ? exact : bytesKey(resolved);
  }

  private belowUnknown(key: string): boolean {
    for (const above of ancestorsOf(bytesOfKey(key))) {
      const at = bytesKey(above);
      const base = this.record.entries.get(at);
      const now = this.current.entries.get(at);
      if (base?.kind === "unreadable" || now?.kind === "unreadable") return true;
      if ((base?.kind === "state" || now?.kind === "state") && this.changedKeys.has(at)) return true;
    }
    return false;
  }

  private count(key: string): LineCounts {
    const base = this.record.entries.get(key);
    const now = this.current.entries.get(key);
    const unknown = { added: 0, removed: 0, unknown: true as const };
    // Only content has lines: a directory, a location covered by inode state
    // or one the host could not know changed in a way no count describes.
    if ((base !== undefined && base.kind !== "file" && base.kind !== "symlink")
      || (now !== undefined && now.kind !== "file" && now.kind !== "symlink")) return unknown;
    if (this.belowUnknown(key)) return unknown;
    const before = base === undefined ? Buffer.alloc(0) : this.baseBytes(key, base);
    const after = now === undefined ? Buffer.alloc(0) : this.currentBytes(key, now);
    if (before === undefined || after === undefined) return unknown;
    // Binary at the base (U1: a NUL in its first 8000 bytes, as git decides):
    // no line of it can be counted, so what the change removed is unknown.
    if ((base?.kind === "file" && this.record.binary.has(key)) || isBinary(before)) return unknown;
    // A text file turned binary lost every line it had (git would print no
    // counts at all).
    if (isBinary(after)) return { added: 0, removed: lineCount(before) };
    const counts = sealedNoIndexNumstat(before, after, { beforeAbsent: base === undefined, afterAbsent: now === undefined });
    return counts ?? unknown;
  }

  private baseBytes(key: string, entry: ListedEntry): Buffer | undefined {
    if (entry.kind === "symlink") {
      // W1 (D57g): a link's bytes are what it resolves to — kept by the
      // record for a link into W; its target text only when it resolves
      // entirely outside W; otherwise unknown.
      if (entry.resolved === "outside") return entry.target;
      const digest = resolvedFileDigest(entry.resolved);
      if (digest === undefined || !this.record.stored.has(key)) return undefined;
      try {
        const bytes = readFileSync(join(this.record.dir, OBJECTS_DIR, digest));
        return sha256(bytes) === digest ? bytes : undefined;
      } catch {
        return undefined;
      }
    }
    if (entry.kind !== "file") return undefined;
    if (this.record.stored.has(key)) {
      try {
        const bytes = readFileSync(join(this.record.dir, OBJECTS_DIR, entry.digest));
        if (sha256(bytes) === entry.digest) return bytes;
      } catch {
        // Fall through to the objects.
      }
    }
    const tracked = this.record.tracked.get(key);
    const oids = [tracked?.indexOid, tracked?.headOid].filter((oid): oid is string => oid !== undefined);
    for (const root of this.objectRoots) {
      for (const oid of oids) {
        try {
          const blob = spawnSealedHostGit(root, ["cat-file", "blob", oid], { timeoutMs: 60_000 });
          if ((blob.exitCode ?? 1) === 0 && sha256(blob.stdout) === entry.digest) return blob.stdout;
        } catch {
          // Not a repository the host trusts: the next root.
        }
      }
    }
    return undefined;
  }

  /** The bytes a path holds now: a file's own; a link's — what it resolves
   * to (W1, D57g), its target text only when it resolves entirely outside
   * the writable world; anything else is bytes the host does not know (U1). */
  private currentBytes(key: string, entry: ListedEntry): Buffer | undefined {
    if (entry.kind === "symlink") {
      // W1 (D57g): what the link resolves to (held to the digest the listing
      // read); its target text only when it resolves entirely outside W.
      if (entry.resolved === "outside") return entry.target;
      const digest = resolvedFileDigest(entry.resolved);
      if (digest === undefined || entry.resolvedPath === undefined) return undefined;
      const bytes = readFileBounded(entry.resolvedPath, CURRENT_BYTES_MAX);
      return bytes !== undefined && sha256(bytes) === digest ? bytes : undefined;
    }
    if (entry.kind !== "file") return undefined;
    const bytes = readFileBounded(beneath(this.currentRoot, bytesOfKey(key)), CURRENT_BYTES_MAX);
    return bytes !== undefined && sha256(bytes) === entry.digest ? bytes : undefined;
  }
}

/** A workspace-relative path as the file system resolves it in `root` now
 * (P2): the longest existing prefix canonicalised by the file system itself
 * (realpath.native — case and Unicode normalisation folded exactly as the
 * volume folds them, links followed), the rest byte-exact. Undefined when it
 * resolves outside the tree. */
export function resolvedRelative(root: string, path: string): Buffer | undefined {
  let rootReal: string;
  try {
    rootReal = realpathSync.native(root);
  } catch {
    return undefined;
  }
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  for (let keep = parts.length; keep >= 0; keep -= 1) {
    let real: string;
    try {
      real = realpathSync.native(join(root, ...parts.slice(0, keep)));
    } catch {
      continue;
    }
    const rest = parts.slice(keep);
    if (rest.some((part) => part === "..")) return undefined;
    if (real !== rootReal && !real.startsWith(`${rootReal}/`)) return undefined;
    const within = real === rootReal ? "" : real.slice(rootReal.length + 1);
    const joined = [within, ...rest].filter((part) => part !== "").join("/");
    return Buffer.from(joined);
  }
  return undefined;
}

/** The content digest a link's resolution names (`file:<mode>:<digest>`). */
function resolvedFileDigest(resolved: string): string | undefined {
  return /^file:\d+:([0-9a-f]{64})$/u.exec(resolved)?.[1];
}

/** Lines as git counts them for a whole file: newlines, plus a last line
 * without one. */
function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

/** A listing of `root` under the record's own coverage, for a change set;
 * the clock probed in the record's own host-owned directory first (F3). */
export function listingUnderBase(record: BaseRecord, root: string, clockDirs: readonly string[] = [], world?: WritableWorld): TreeListing {
  return workspaceListing(root, createDigestCache(record.coverage, { clockDirs: [...clockDirs, record.dir], ...(world === undefined ? {} : { world }) }));
}

/** The host-owned locations of `world` inside `root`, as walk keys (W2). */
function hostOwnedKeys(root: string, world: WritableWorld | undefined): Set<string> {
  const skip = new Set<string>();
  if (world === undefined) return skip;
  let rootReal: string;
  try {
    rootReal = realpathSync.native(root);
  } catch {
    return skip;
  }
  for (const owned of world.hostOwned) {
    if (owned.startsWith(`${rootReal}/`)) skip.add(bytesKey(Buffer.from(owned.slice(rootReal.length + 1))));
  }
  return skip;
}

