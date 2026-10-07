import { liveWritersOf } from "./live-writers.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventLog } from "./event-log.ts";
import { canonicalJson } from "./canonical.ts";
import { listRegion, walkCovered, type CoverageBase, type StateRegion } from "./coverage.ts";
import { resolveLinkIdentity } from "./link-identity.ts";
import { treeOnlyWorld, type WritableWorld } from "./writable-world.ts";
import { beneath, bytesKey, bytesOfKey, displayPath, exactUtf8 } from "../work/path-bytes.ts";

/** Execution receipts (interfaces-v2.md §1). Every sandboxed execution the
 * model performs mints a bound `exec/receipt` observe row: the workspace
 * image before and after the run, the command bytes digest, the exit code
 * and the authenticated output digests. The receipt is the only execution
 * evidence `finish` (and later `propose_plan`) accepts.
 *
 * THE IMAGE IS READ FROM CONTENT (D57d, I1). A content identity is computed
 * from content, or from stat information the HOST established and an
 * execution cannot forge — never from fields an execution can set back (size,
 * mtime), and never from git's stat compare. Git's index lies in the tree an
 * execution writes (its entries, their stat, the assume-unchanged and
 * skip-worktree flags, the config that says which stat fields count), and git
 * compares change times to the whole second where it is built without
 * nanosecond stat (Apple Git is): a same-size rewrite that puts its mtime
 * back within the second after a refresh is "unchanged" to git, whatever it
 * wrote. So every file of the image is identified by the sha256 of its bytes
 * and its full mode, every symbolic link by its target bytes.
 *
 * NOTHING A CASE CAN READ IS OUTSIDE THE IMAGE (C1', D57f): a location the
 * base excludes (a fixed name, an ignore rule) or a special file is covered
 * by the inode states of everything in it — behind the ctime fence, so any
 * write inside moves the image; a stable one costs an lstat per entry,
 * never a read. A link is identified by its target bytes AND what it
 * resolves to inside the tree (followed once, component by component, never
 * through a second link: a file by its content). A directory is identified
 * by its mode. What the host cannot list or read makes the image UNKNOWN: a
 * fresh random value enters it, so it never equals another image — no case
 * is green on it, every receipt over it is `changed` and names what was
 * unknown (U1).
 *
 * WHAT THE IMAGE COVERS IS THE HOST'S DECISION (D57e, C1): the paths come
 * from the host's own walk of the tree (coverage.ts) under the CoverageBase
 * the digest cache carries — the fixed host exclusion list, the ignore rules
 * the host captured when it established the base, the paths tracked then —
 * never from git: no git process runs, so no repository configuration can
 * run a program as the host (S2), and the live index, its flags,
 * `.git/info/exclude`, `core.excludesFile`, `core.worktree`, a `.git` file
 * and a rule written after the base decide nothing.
 *
 * What makes the second digest of a tree cheap is the host's own record: the
 * digest cache keeps a file's content digest keyed by its inode state as the
 * host's lstat reads it — device, inode, change and modification time to the
 * nanosecond, size and mode — and trusts an entry only when the file's change
 * time lay strictly before the file system's clock when the host read the
 * file (the change time of a file the host creates, and removes at once, in
 * the system temporary directory when that shares the tree's file system; the
 * wall clock less a margin otherwise). Any later write, whatever it sets size
 * and mtime back to, gives the file a later change time, which no execution
 * can set: the entry no longer matches and the file is read again.
 *
 * THE CLOCK IS PROBED WHERE THE HOST OWNS A DIRECTORY ON THE TREE'S DEVICE
 * (D57e, F3): the cache names host-owned directories (the recheck's holder,
 * the session's own directory) and the probe file is made in the first of
 * them — then the system temporary directory — that lies on the tree's file
 * system — a shared sticky one (Linux's `/tmp`) through a directory the host
 * makes there exclusively and removes at once (D57i). Where none does, the
 * wall clock less a margin stands in for the digest: a file changed within
 * the margin is read again next time, and a clone adopts nothing (correct,
 * only slower). The fence's wait is bounded (2 s) and counted on the cache.
 * Under a coarse clock the digest waits (at most FENCE_TICK_PATIENCE_MS) for
 * the clock to leave the tick of its newest unrecorded files before reading
 * them, so they are recorded (D57i). */

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

type TreeEntry =
  | { path: string; kind: "file"; mode: number; digest: string }
  | { path: string; kind: "symlink"; target: string; resolved: string }
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "state"; why: string; state: string }
  | { path: string; kind: "unknown"; why: string };

export interface DigestCache {
  /**
   * A file's content digest by the state of its inode as the host's lstat
   * read it (I1, D57d): `device:inode:ctime_ns:mtime_ns:size:mode`. An entry
   * is recorded only when the file's change time lay strictly before the file
   * system's clock when the host read the file, so a later change of the file
   * — in place, same size, mtime put back — can never match it. Kept to the
   * files of the last digest.
   */
  readonly contents: Map<string, string>;
  /** What every image of this cache covers (C1, D57e): the base the host
   * established before the session could write. */
  readonly base: CoverageBase;
  /** Host-owned directories the file system's clock is probed in (F3), the
   * first on the tree's device used; the system temporary directory after
   * them. */
  readonly clockDirs: readonly string[];
  /** Number of file contents hashed through this cache (diagnostics/cost tests). */
  contentHashes: number;
  /** The ctime fence (F3): how often the host waited for the clock to move
   * past a recorded change time, how long in all, and how often it could not
   * (no probe on the device, or the clock did not move in time). */
  fenceWaits: number;
  fenceWaitNs: bigint;
  fenceMisses: number;
  /** What the last digest could not know (C1', U1): one line per unknown
   * location, `path: why`; empty when it knew everything. */
  lastUnknown: readonly string[];
  /** The file system's clock reader (F3): the probe in a host-owned
   * directory by default; a caller may give its own (a coarse or stopped
   * clock in a test). Undefined: no clock on that device. */
  readonly clock: (dev: bigint) => bigint | undefined;
  /** Whether the wall clock less a margin stands in for the digest's fence
   * where no probe reads the device's clock (the default clock only; a
   * caller's clock is taken as given). */
  readonly wallFallback: boolean;
  /** The session's writable world (W, D57g): what a link may resolve into
   * that the image must follow, and what host-owned location inside the
   * tree it leaves out by path (W2). Set when the policies are known. */
  world?: WritableWorld;
}

/** One cache per session: it makes the second digest of an unchanged tree
 * free and an N-file edit cost N hashes. Its images cover what `base`
 * decides (C1): a session's cache carries the base its session established
 * (session-base.ts), never one taken after the session could write. */
export function createDigestCache(base: CoverageBase, options: {
  readonly clockDirs?: readonly string[];
  readonly clock?: (dev: bigint) => bigint | undefined;
  readonly world?: WritableWorld;
} = {}): DigestCache {
  const clockDirs = [...(options.clockDirs ?? [])];
  return {
    contents: new Map(),
    base,
    clockDirs,
    contentHashes: 0,
    fenceWaits: 0,
    fenceWaitNs: 0n,
    fenceMisses: 0,
    lastUnknown: [],
    clock: options.clock ?? ((dev) => fileSystemClock(dev, clockDirs)),
    wallFallback: options.clock === undefined,
    ...(options.world === undefined ? {} : { world: options.world }),
  };
}

/** A regular file of a digested tree, as the host read it. */
export interface ListedFile {
  readonly digest: string;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly mode: number;
}

/** One covered path of a digested tree as the host read it (C1', D57f): a
 * regular file (its content digest, full mode and inode), a symbolic link
 * (its target bytes and what it resolves to inside the tree), a directory
 * (its mode), a location covered by inode state (the digest of the host's
 * lstat of everything in it), or a location the host could not know
 * (`unreadable`: why — never equal to anything). */
export type ListedEntry =
  | { readonly kind: "file"; readonly mode: number; readonly digest: string; readonly size: bigint; readonly inode?: string }
  | { readonly kind: "symlink"; readonly target: Buffer; readonly resolved: string; readonly resolvedPath?: Buffer }
  | { readonly kind: "dir"; readonly mode: number }
  | { readonly kind: "state"; readonly state: string }
  | { readonly kind: "unreadable"; readonly state: string };

/** A digested tree: its image, the regular files whose bytes it is made of
 * (for adoption by a copy), every covered path as read (for a host content
 * diff of two listings, C1), by exact path (`bytesKey`), and what the host
 * could not know (C1', U1: non-empty means the image is unknown). */
export interface TreeListing {
  readonly image: string;
  readonly files: ReadonlyMap<string, ListedFile>;
  readonly entries: ReadonlyMap<string, ListedEntry>;
  readonly unknown: readonly string[];
}

/** One listed entry as comparable text: equal texts, equal content; an
 * unknown entry's text holds a fresh random value, so it never equals
 * another (U1). */
export function listedEntryText(entry: ListedEntry | undefined): string {
  if (entry === undefined) return "<absent>";
  switch (entry.kind) {
    case "file":
      return `file:${entry.mode}:${entry.digest}`;
    case "symlink":
      return `link:${entry.target.toString("base64")}:${entry.resolved}`;
    case "dir":
      return `dir:${entry.mode}`;
    case "state":
      return `state:${entry.state}`;
    default:
      return `unknown:${randomBytes(16).toString("hex")}`;
  }
}

const inodeState = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}:${stat.mode}`;

/** A path or a link target as it enters the image: its text when the bytes
 * are exactly UTF-8, otherwise its bytes in base64 behind a NUL — which no
 * path and no target holds, so two different byte strings never meet (R1). */
function exactText(bytes: Buffer): string {
  return exactUtf8(bytes) ?? `\u0000${bytes.toString("base64")}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

// --- the file system's clock ---------------------------------------------------

/** A directory the clock may be probed in: a real directory (not a link)
 * owned by the host's own user that no other user may write (F3, D57f) —
 * the session's base directory, a recheck's holder, the per-user temporary
 * directory. A directory anyone else could write is never used: the probe's
 * name could be taken or its directory swapped. */
function hostOwnedDirectory(dir: string, dev: bigint): boolean {
  let stat: BigIntStats;
  try {
    stat = lstatSync(dir, { bigint: true });
  } catch {
    return false;
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  return stat.isDirectory() && stat.dev === dev && uid !== undefined && stat.uid === uid && (stat.mode & 0o022n) === 0n;
}

/** The clock of the file system on device `dev` now (F3): the change time a
 * file the host creates receives in the first of `dirs` — host-owned
 * directories — then the system temporary directory, that lies on that
 * device and is the host's own (hostOwnedDirectory); made exclusively under a
 * random name, never through a link, and removed at once, so nothing is left
 * behind and no execution is granted it. Undefined when none lies on that
 * device (another file system's clock may tick differently) or nothing can
 * be made there: every decision that needs the clock then fails safe — a
 * content digest is not recorded, a copy adopts nothing, a region is
 * unknown. */
function fileSystemClock(dev: bigint, dirs: readonly string[] = []): bigint | undefined {
  for (const dir of [...dirs, tmpdir()]) {
    if (hostOwnedDirectory(dir, dev)) {
      const now = probeClock(dir, dev);
      if (now !== undefined) return now;
    } else if (stickyDirectory(dir, dev)) {
      const now = probeClockByDirectory(dir, dev);
      if (now !== undefined) return now;
    }
  }
  return undefined;
}

/** A shared temporary directory whose entries only their owner may remove
 * or rename (the sticky bit: Linux's `/tmp`), on device `dev`. A directory
 * the host makes there under a random name is its own until it removes it. */
function stickyDirectory(dir: string, dev: bigint): boolean {
  let stat: BigIntStats;
  try {
    stat = lstatSync(dir, { bigint: true });
  } catch {
    return false;
  }
  return stat.isDirectory() && stat.dev === dev && (stat.mode & 0o1000n) !== 0n;
}

/** The clock of device `dev` as the change time of a directory the host
 * makes exclusively (mkdtemp) in a sticky directory, removed at once. */
function probeClockByDirectory(dir: string, dev: bigint): bigint | undefined {
  let made: string | undefined;
  try {
    made = mkdtempSync(join(dir, ".dokkabi-clock-"));
    const stat = lstatSync(made, { bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
    return stat.isDirectory() && stat.dev === dev && uid !== undefined && stat.uid === uid ? stat.ctimeNs : undefined;
  } catch {
    return undefined;
  } finally {
    if (made !== undefined) {
      try {
        rmdirSync(made);
      } catch {
        // Already gone.
      }
    }
  }
}

/** The wall clock less this margin stands in for a device no probe reaches
 * (F3): a file changed within the margin is read again next time. */
export const WALL_CLOCK_MARGIN_MS = 2_000;

/** How long a digest waits for the device's clock to leave the tick its
 * newest unrecorded files were changed in (a coarse clock: Linux's
 * file-system time advances per jiffy), before it reads them. */
export const FENCE_TICK_PATIENCE_MS = 100;

/** The directory the clock of device `dev` would be probed in for `cache`,
 * or undefined (diagnostics and tests: the fence's own location). */
export function clockProbeDirectory(cache: DigestCache, dev: bigint): string | undefined {
  return [...cache.clockDirs, tmpdir()].find((dir) => hostOwnedDirectory(dir, dev) || stickyDirectory(dir, dev));
}

function probeClock(dir: string, dev: bigint): bigint | undefined {
  const path = join(dir, `.dokkabi-clock-${process.pid}-${randomBytes(8).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd, { bigint: true });
    return stat.dev === dev ? stat.ctimeNs : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** The fence's bound (F3): the longest the host waits for a file system's
 * clock to move past a recorded change time. */
export const FENCE_PATIENCE_MS = 2_000;

/** Wait (at most `patienceMs`) until the clock of the file system on `dev`
 * has moved strictly past `latest`, and return it; undefined when there is no
 * probe there or it does not move in time. The wait is counted on `cache`. */
function clockPast(dev: bigint, latest: bigint, cache: DigestCache, patienceMs = FENCE_PATIENCE_MS): bigint | undefined {
  const started = process.hrtime.bigint();
  const until = Date.now() + patienceMs;
  try {
    for (;;) {
      const now = cache.clock(dev);
      if (now === undefined) {
        cache.fenceMisses += 1;
        return undefined;
      }
      if (now > latest) return now;
      if (Date.now() >= until) {
        cache.fenceMisses += 1;
        return undefined;
      }
      Atomics.wait(sleeper, 0, 0, 1);
    }
  } finally {
    cache.fenceWaits += 1;
    cache.fenceWaitNs += process.hrtime.bigint() - started;
  }
}

// --- one digest ------------------------------------------------------------------

const chunk = Buffer.allocUnsafe(1024 * 1024);

/** The content of one regular file, read through a descriptor that never
 * follows a link and never blocks on a FIFO swapped in; `stable` when the
 * inode state before and after the read is the one the listing saw. */
function readContent(full: Buffer, seen: BigIntStats): { digest: string; stable: boolean } | "unreadable" | "changed" {
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    return code === "EACCES" || code === "EPERM" ? "unreadable" : "changed";
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) return "changed";
    const hash = createHash("sha256");
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count <= 0) break;
      hash.update(chunk.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    const state = inodeState(seen);
    return { digest: hash.digest("hex"), stable: inodeState(before) === state && inodeState(after) === state };
  } catch (error) {
    const code = errorCode(error);
    return code === "EACCES" || code === "EPERM" ? "unreadable" : "changed";
  } finally {
    closeSync(fd);
  }
}

/** The identity of a region covered by inode state: the host's lstat of
 * everything in it, by exact path. */
function regionState(items: readonly { readonly path: Buffer; readonly stat: BigIntStats }[]): string {
  const hash = createHash("sha256");
  const sorted = [...items].sort((a, b) => Buffer.compare(a.path, b.path));
  for (const item of sorted) hash.update(item.path).update("\0").update(inodeState(item.stat)).update("\n");
  return hash.digest("hex");
}

/**
 * The regions of a walk (C1', D57f; the instability rule, D57g): each is
 * identified by the host's lstat of everything in it, as listed — whatever
 * the file system's clock says. Instability never makes a region unknown and
 * never changes an image: an entry written in the clock tick of the listing
 * is identified by the lstat fields it has, like any other. (What the fence
 * gates is only the REUSE of a content digest across calls.) Unknown is for
 * what the host cannot list or read — listRegion says so.
 */
function settleRegions(
  regions: readonly StateRegion[],
): { readonly settled: { path: Buffer; why: string; state: string }[]; readonly unknown: { path: Buffer; why: string }[] } {
  return { settled: regions.map((region) => ({ path: region.path, why: region.why, state: regionState(region.items) })), unknown: [] };
}

function digestTree(root: string, cache: DigestCache, keepFiles: boolean): TreeListing {
  const rootPath = Buffer.from(root);
  let rootReal = rootPath;
  try {
    rootReal = Buffer.from(realpathSync.native(root));
  } catch {
    // The walk below throws for a root it cannot read.
  }
  const world = cache.world ?? treeOnlyWorld(rootReal.toString());
  // Host-owned locations inside the tree (W2): left out by exact path.
  const skip = new Set<string>();
  for (const owned of world.hostOwned) {
    const own = Buffer.from(owned);
    if (own.length > rootReal.length + 1 && own[rootReal.length] === 0x2f && own.subarray(0, rootReal.length).equals(rootReal)) skip.add(bytesKey(own.subarray(rootReal.length + 1)));
  }
  // The host's own walk under the cache's base (C1, C1'): files and links
  // covered by content, directories, and regions covered by inode state,
  // below real directories only — a component that is a link, a file or
  // nothing is never walked through (the link itself is covered on its own).
  const walked = walkCovered(root, cache.base, { skip });
  const entries: { readonly at: Buffer; entry: TreeEntry | undefined }[] = [];
  const pending: { slot: { entry: TreeEntry | undefined }; path: Buffer; full: Buffer; stat: BigIntStats; key: string }[] = [];
  const files = new Map<string, ListedFile>();
  const listed = new Map<string, ListedEntry>();
  const seen = new Set<string>();
  const unknown: { path: Buffer; why: string }[] = walked.unreadable.map((item) => ({ path: item.path, why: item.why }));
  if (cache.base.kind === "unknown") unknown.push({ path: Buffer.alloc(0), why: `the session's base is unknown: ${cache.base.reason ?? "unavailable"}` });
  // G2 (D57g): while a process of the session that can write the tree
  // lives, no image of it is known.
  for (const writer of liveWritersOf(rootReal.toString())) unknown.push({ path: Buffer.alloc(0), why: writer });
  const links: { path: Buffer; target: Buffer; stat: BigIntStats }[] = [];
  for (const { path, stat } of walked.entries) {
    const full = beneath(root, path);
    if (stat.isSymbolicLink()) {
      try {
        links.push({ path, target: readlinkSync(full, { encoding: "buffer" }) as Buffer, stat });
      } catch (error) {
        unknown.push({ path, why: `its target cannot be read (${errorCode(error) ?? "error"})` });
      }
      continue;
    }
    const key = inodeState(stat);
    const mode = Number(stat.mode) & 0o7777;
    const digest = cache.contents.get(key);
    if (digest !== undefined) {
      seen.add(key);
      entries.push({ at: path, entry: { path: exactText(path), kind: "file", mode, digest } });
      if (keepFiles) {
        files.set(bytesKey(path), { digest, size: stat.size, mtimeNs: stat.mtimeNs, mode });
        listed.set(bytesKey(path), { kind: "file", mode, digest, size: stat.size, inode: `${stat.dev}:${stat.ino}` });
      }
      continue;
    }
    const slot = { at: path, entry: undefined as TreeEntry | undefined };
    entries.push(slot);
    pending.push({ slot, path, full, stat, key });
  }
  // The file system's clock, read AFTER every file above was listed and
  // BEFORE any of them is read: a file whose change time lies strictly
  // before it cannot change again without a later change time, so its
  // record stays true until its inode state moves. No clock on the device
  // (no host-owned directory there): nothing is recorded (F3, fails safe).
  const floors = new Map<bigint, bigint | undefined>();
  const exact = new Set<bigint>();
  const floorOf = (dev: bigint) => {
    if (!floors.has(dev)) {
      let now = cache.clock(dev);
      if (now === undefined) {
        cache.fenceMisses += 1;
        // No probe on the device: the wall clock less a margin (F3).
        if (cache.wallFallback) now = BigInt(Date.now() - WALL_CLOCK_MARGIN_MS) * 1_000_000n;
      } else {
        exact.add(dev);
      }
      floors.set(dev, now);
    }
    return floors.get(dev);
  };
  for (const item of pending) floorOf(item.stat.dev);
  // A coarse clock (D57i, the Linux follow-up): files changed in the tick
  // the probe read cannot be recorded against it. The host waits (bounded)
  // until the device's clock has left the newest such change time, and
  // reads them after it — so a file written just before a digest is
  // recorded by that digest, and the next one reuses it.
  const newest = new Map<bigint, bigint>();
  for (const item of pending) {
    const floor = floors.get(item.stat.dev);
    if (floor === undefined || !exact.has(item.stat.dev) || item.stat.ctimeNs < floor) continue;
    if (item.stat.ctimeNs > (newest.get(item.stat.dev) ?? -1n)) newest.set(item.stat.dev, item.stat.ctimeNs);
  }
  for (const [dev, latest] of newest) {
    const later = clockPast(dev, latest, cache, FENCE_TICK_PATIENCE_MS);
    if (later !== undefined) floors.set(dev, later);
  }
  /** A regular file's digest: recorded when stable and fenced. */
  const contentOf = (path: Buffer, full: Buffer, stat: BigIntStats): { digest: string; stable: boolean } | { unknown: string } => {
    const key = inodeState(stat);
    const known = cache.contents.get(key);
    if (known !== undefined) {
      seen.add(key);
      return { digest: known, stable: true };
    }
    const read = readContent(full, stat);
    if (read === "unreadable") return { unknown: "the host cannot read it" };
    if (read === "changed") return { unknown: "it changed while the host read it" };
    cache.contentHashes += 1;
    const floor = floorOf(stat.dev);
    if (read.stable && floor !== undefined && stat.ctimeNs < floor) {
      cache.contents.set(key, read.digest);
      seen.add(key);
    }
    return read;
  };
  const linkIdentity = (linkAbs: Buffer, target: Buffer): { resolved: string; resolvedPath?: Buffer; unknown?: string } => {
    const resolution = resolveLinkIdentity(linkAbs, target, world);
    switch (resolution.kind) {
      case "outside":
        return { resolved: "outside" };
      case "unknown":
        return { resolved: "unknown", unknown: resolution.why };
      case "other":
        return { resolved: resolution.identity };
      case "file": {
        const read = contentOf(resolution.path, resolution.path, resolution.stat);
        if ("unknown" in read) return { resolved: "unknown", unknown: `what it resolves to: ${read.unknown}` };
        return { resolved: `file:${Number(resolution.stat.mode) & 0o7777}:${read.digest}`, resolvedPath: resolution.path };
      }
      case "dir": {
        const inTree = resolution.path.equals(rootReal) || (resolution.path.length > rootReal.length && resolution.path[rootReal.length] === 0x2f && resolution.path.subarray(0, rootReal.length).equals(rootReal));
        if (inTree) return { resolved: `dir:${resolution.path.subarray(rootReal.length).toString("base64")}:${Number(resolution.stat.mode) & 0o7777}` };
        // A directory outside the tree but in W: the listing identity of
        // everything in it (the host's lstat, never followed, never read).
        const listedDir = listRegion(Buffer.from("/"), resolution.path.subarray(1), resolution.stat);
        if ("unreadable" in listedDir) return { resolved: "unknown", unknown: `what it resolves to: ${listedDir.unreadable.why}` };
        return { resolved: `dirlist:${regionState(listedDir.items)}` };
      }
    }
  };
  for (const item of pending) {
    const read = contentOf(item.path, item.full, item.stat);
    const mode = Number(item.stat.mode) & 0o7777;
    if ("unknown" in read) {
      item.slot.entry = { path: exactText(item.path), kind: "unknown", why: read.unknown };
      unknown.push({ path: item.path, why: read.unknown });
      if (keepFiles) listed.set(bytesKey(item.path), { kind: "unreadable", state: read.unknown });
      continue;
    }
    item.slot.entry = { path: exactText(item.path), kind: "file", mode, digest: read.digest };
    if (keepFiles) {
      if (read.stable) files.set(bytesKey(item.path), { digest: read.digest, size: item.stat.size, mtimeNs: item.stat.mtimeNs, mode });
      listed.set(bytesKey(item.path), { kind: "file", mode, digest: read.digest, size: read.stable ? item.stat.size : -1n, inode: `${item.stat.dev}:${item.stat.ino}` });
    }
  }
  // Links: the target bytes AND what they resolve to whenever the
  // resolution passes through or ends in the session's writable world (W1,
  // D57g: link-identity.ts, the one link rule) — a file by its content, a
  // directory by its listing identity; entirely outside W, the target alone.
  // Memoised per inode for this digest.
  const memo = new Map<string, { resolved: string; resolvedPath?: Buffer; unknown?: string }>();
  for (const { path, target, stat } of links) {
    const memoKey = `${inodeState(stat)}\0${target.toString("base64")}`;
    let hit = memo.get(memoKey);
    if (hit === undefined) {
      hit = linkIdentity(Buffer.concat([rootReal, Buffer.from("/"), path]), target);
      memo.set(memoKey, hit);
    }
    if (hit.unknown !== undefined) unknown.push({ path, why: hit.unknown });
    entries.push({ at: path, entry: { path: exactText(path), kind: "symlink", target: exactText(target), resolved: hit.resolved } });
    if (keepFiles) listed.set(bytesKey(path), { kind: "symlink", target, resolved: hit.resolved, ...(hit.resolvedPath === undefined ? {} : { resolvedPath: hit.resolvedPath }) });
  }
  for (const { path, stat } of walked.dirs) {
    const mode = Number(stat.mode) & 0o7777;
    entries.push({ at: path, entry: { path: exactText(path), kind: "dir", mode } });
    if (keepFiles) listed.set(bytesKey(path), { kind: "dir", mode });
  }
  const regions = settleRegions(walked.regions);
  for (const region of regions.settled) {
    entries.push({ at: region.path, entry: { path: exactText(region.path), kind: "state", why: region.why, state: region.state } });
    if (keepFiles) listed.set(bytesKey(region.path), { kind: "state", state: region.state });
  }
  unknown.push(...regions.unknown);
  // What the host could not know is unknown in the listing, whatever else
  // it was listed as (a directory found, then not listable).
  for (const item of unknown) {
    if (item.path.length === 0) continue;
    if (keepFiles) listed.set(bytesKey(item.path), { kind: "unreadable", state: item.why });
  }
  for (const item of unknown) entries.push({ at: item.path, entry: { path: exactText(item.path), kind: "unknown", why: item.why } });
  entries.sort((a, b) => Buffer.compare(a.at, b.at) || kindOrder(a.entry) - kindOrder(b.entry));
  // Only the files of this digest stay recorded.
  if (cache.contents.size > seen.size) {
    for (const key of cache.contents.keys()) if (!seen.has(key)) cache.contents.delete(key);
  }
  const present = entries.flatMap((item) => (item.entry === undefined ? [] : [item.entry]));
  const unknownLines = unknown.map((item) => `${item.path.length === 0 ? "." : displayPath(item.path)}: ${item.why}`);
  cache.lastUnknown = unknownLines;
  // An image with anything the host could not know never equals another
  // image (C1', U1): a fresh random value enters it, so no case is green on
  // it and every receipt over it says `changed`.
  const image = unknownLines.length === 0
    ? sha256(canonicalJson(present))
    : sha256(`${canonicalJson(present)}\0unknown\0${randomBytes(32).toString("hex")}`);
  return { image, files, entries: listed, unknown: unknownLines };
}

const KIND_ORDER: Record<TreeEntry["kind"], number> = { dir: 0, file: 1, symlink: 2, state: 3, unknown: 4 };
function kindOrder(entry: TreeEntry | undefined): number {
  return entry === undefined ? 5 : KIND_ORDER[entry.kind];
}

/** Deterministic sha256 over the sorted entries of the workspace tree (I1,
 * D57d; C1', D57f): every regular file by the sha256 of its bytes and its
 * full mode (`& 0o7777`), every symbolic link by its target bytes and what
 * it resolves to inside the tree, every directory by its mode, every
 * location covered by inode state — a fixed-exclusion name, a path the
 * base's rules ignore, a special file — by the host's lstat of everything
 * in it; paths and targets exact bytes. What the host cannot list or read
 * makes the image unknown: it then never equals another image, and
 * `cache.lastUnknown` says what. The paths are the ones the cache's base
 * covers (C1, D57e: coverage.ts); no git process runs. Unchanged files cost
 * an lstat, through the cache's record of their inode state. Writes nothing
 * in the tree: the file system's clock is read off a file it creates and
 * removes at once in a host-owned directory on the tree's device (F3). */
export function workspaceDigest(root: string, cache: DigestCache): string {
  return digestTree(root, cache, false).image;
}

/** workspaceDigest, with the regular files the image is made of — what a
 * copy made from this tree holds until something writes it
 * (adoptCopyDigests) — every covered path as read (a host content diff of
 * two listings, C1) and what the host could not know. */
export function workspaceListing(root: string, cache: DigestCache): TreeListing {
  return digestTree(root, cache, true);
}

/**
 * A copy the HOST just made of a tree it digested, before anything else
 * could write the copy (a recheck execution's clone of the pristine copy,
 * E1''): the copy holds the listed bytes at the listed paths, so each copied
 * file's inode state — read now by the host's lstat — is recorded with the
 * content digest the source listed, once the file system's clock has moved
 * strictly past every change time recorded (the ctime fence: any write after
 * it, the execution's included, gives a later change time). A file whose
 * size, mtime or mode differs from the listing's is not adopted, and nothing
 * is when the clock cannot be read on the copy's file system; those are read
 * by the next digest. Returns how many files were adopted.
 */
export function adoptCopyDigests(cache: DigestCache, source: TreeListing, copyRoot: string): number {
  const found: { key: string; digest: string; stat: BigIntStats }[] = [];
  let latest = -1n;
  let dev: bigint | undefined;
  for (const [key, file] of source.files) {
    let stat: BigIntStats | undefined;
    try {
      stat = lstatSync(beneath(copyRoot, bytesOfKey(key)), { bigint: true, throwIfNoEntry: false });
    } catch {
      stat = undefined;
    }
    if (stat === undefined || !stat.isFile() || stat.size !== file.size || stat.mtimeNs !== file.mtimeNs || (Number(stat.mode) & 0o7777) !== file.mode) continue;
    if (dev === undefined) dev = stat.dev;
    if (stat.dev !== dev) continue;
    found.push({ key: inodeState(stat), digest: file.digest, stat });
    if (stat.ctimeNs > latest) latest = stat.ctimeNs;
  }
  if (dev === undefined || found.length === 0) return 0;
  const fence = clockPast(dev, latest, cache);
  if (fence === undefined) return 0;
  for (const item of found) cache.contents.set(item.key, item.digest);
  return found.length;
}

/** The receipt's `unknown` field (C1', U1): what either image could not
 * know, bounded; absent when both knew everything. An image that holds an
 * unknown never equals another image, so such a receipt is always
 * `changed` and no case is green on it. */
function unknownField(unknown: { readonly before: readonly string[]; readonly after: readonly string[] } | undefined): Record<string, unknown> {
  if (unknown === undefined || (unknown.before.length === 0 && unknown.after.length === 0)) return {};
  const bound = (lines: readonly string[]) => lines.slice(0, 16).map((line) => line.slice(0, 300));
  return { unknown: { before: bound(unknown.before), after: bound(unknown.after), count: unknown.before.length + unknown.after.length } };
}

/** Receipt identity: the candidate image, the command bytes, and the
 * authenticated execution result — nothing else (unchanged formula). */
export function execReceiptId(input: { image: string; commandDigest: string; resultHash: string }): string {
  return sha256(canonicalJson({ image: input.image, command_digest: input.commandDigest, result: { hash: input.resultHash } }));
}

export type ReceiptIsolation = "live-workspace" | "fresh-image";
export type ReceiptDigestKind = "workspace-tree" | "execution-image";

/** The subset of ExecutionViews receipts need to run in a fresh image. */
export interface ExecutionReceiptViews {
  capture(): { status: "retained"; digest: string } | { status: "unavailable"; reason: string };
  execute(input: { image: string; command: string; timeoutMs?: number }):
    | { status: "executed"; process: { exitCode: number; stdout: string; stderr: string }; changed: boolean; result: { seq: number; hash: string } }
    | { status: "unavailable"; reason: string };
}

/** Append the authenticated output row (`exec/result`) and the `exec/receipt`
 * row referencing it. Returns the receipt id. `names` renames the pair for a
 * host-run case execution (`verify/result` + `verify/receipt`): every
 * execution is evidence, and the verdict accepts both names; the payload
 * shape and the id formula are identical either way. */
export function mintReceipt(input: {
  log: EventLog;
  image_before: string;
  image_after: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  isolation: ReceiptIsolation;
  digest_kind: ReceiptDigestKind;
  exec_ref?: { seq: number; hash: string } | null;
  names?: { result: string; receipt: string };
  /** What the images could not know (C1', U1): the row names it. */
  unknown?: { readonly before: readonly string[]; readonly after: readonly string[] };
}): { id: string } {
  const names = input.names ?? { result: "exec/result", receipt: "exec/receipt" };
  const commandDigest = sha256(input.command);
  // The result row is the authentication target: it binds the command bytes
  // and both output digests to the sandbox/exec effect (exec_ref).
  const result = input.log.append({
    kind: "observe",
    name: names.result,
    payload: {
      command_digest: commandDigest,
      exec: input.exec_ref ?? null,
      exit_code: input.exit_code,
      stdout_sha256: sha256(input.stdout),
      stderr_sha256: sha256(input.stderr),
    },
  });
  const id = execReceiptId({ image: input.image_before, commandDigest, resultHash: result.hash });
  input.log.append({
    kind: "observe",
    name: names.receipt,
    payload: {
      id,
      image: input.image_before,
      image_after: input.image_after,
      changed: input.image_before !== input.image_after,
      command_digest: commandDigest,
      exit_code: input.exit_code,
      duration_ms: input.duration_ms,
      result: { seq: result.seq, hash: result.hash },
      isolation: input.isolation,
      digest_kind: input.digest_kind,
      ...unknownField(input.unknown),
    },
  });
  return { id };
}
