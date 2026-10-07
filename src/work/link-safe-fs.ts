import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readDirectoryBytes } from "../host/fs-bytes.ts";
import { beneath, displayPath, isPlainRelative, isWithin, joinSegments, parentOf, segments } from "./path-bytes.ts";

/**
 * S1 — HOST OPERATIONS NEVER FOLLOW SESSION-CONTROLLED LINKS (D57c, design
 * memo §113).
 *
 * The host creates, writes, removes, moves and reads files in trees a session
 * could have written: its scratch (fixtures under `checks/<case>`, the
 * content store and one observation's captures under `.host/`), the recheck
 * and verifier copies, a ruling verifier's scratch the evidence is delivered
 * into, the developer's tree a pre-fix restore writes and the one a pre-fix
 * save reads. A session can put a symbolic link at any path component there
 * — and under Seatbelt, which confines by path, even replace the directory it
 * was given with a link. A host operation that resolved such a path would
 * delete, write or read wherever the session pointed it: outside the tree,
 * with the host's own rights (the D57b red team's finding: prepareCheckRun's
 * recursive delete under `scratch/checks/<id>` followed a planted link).
 *
 * So every such operation goes through this module, relative to a ROOT the
 * host itself established (safeRoot):
 *
 *   - a root is an absolute directory whose ancestors are resolved once
 *     (they are the host's: a session directory, a private temporary holder,
 *     the directory the operator named) and whose own last component is a real
 *     directory — never a link; its device and inode are pinned, and every
 *     operation re-verifies them;
 *   - every component of a path below the root is checked with lstat,
 *     WITHOUT following it: a symbolic link, or anything that is not a
 *     directory where a directory must be, refuses the operation with a typed
 *     LinkSafetyError before anything is changed;
 *   - a link that is itself the target of a removal is removed as a link; a
 *     recursive removal never descends through one;
 *   - directories are created one component at a time (never `recursive`),
 *     each checked again after it is made, and the whole chain re-verified
 *     (device and inode of every component) right before the operation and
 *     after it;
 *   - files are opened without following a link (on macOS with
 *     O_NOFOLLOW_ANY, which refuses a link in ANY component, atomically; on
 *     Linux with O_NOFOLLOW on the last component), a created file is made
 *     with O_EXCL, its mode and times are set through the descriptor, and a
 *     read or write counts only when the inode the descriptor holds is the one
 *     at the verified path afterwards.
 *
 * THE RESIDUAL WINDOW. Node has no openat/unlinkat/mkdirat, so an entry
 * operation (mkdir, unlink, rmdir, rename, symlink) still names a path: a
 * process running concurrently with the host could swap a verified directory
 * for a link between the last verification and that one system call. The
 * window is one system call wide, and it is detected afterwards (the chain
 * and the moved or created entry are verified again; a created file found
 * elsewhere is truncated). Opens are not in the window on macOS
 * (O_NOFOLLOW_ANY); on Linux a raced read is discarded and a raced write
 * truncated. Who could run concurrently: a live session's own background
 * processes while its `check` call runs; under Seatbelt, a process an earlier
 * execution left running (Seatbelt confines by path, not by process
 * lifetime); under bubblewrap nothing of an execution outlives it (a pid
 * namespace). Where the operation runs INSIDE the session's own sandbox
 * instead, the confinement closes the window: whatever a raced link points
 * at, the sandboxed process can reach only what the session could reach
 * itself (ledger-check.ts: a check's fixture directory and an observation's
 * captures are removed by `rm` inside the check's own policy when that policy
 * confines writes).
 *
 * Paths below a root are exact bytes (path-bytes.ts): nothing is decoded.
 */

/** Why an operation was refused. */
export type LinkSafetyCode =
  /** The root is missing, not a directory, a link, or no longer the one pinned. */
  | "root"
  /** A component (or the target itself, where it must not be one) is a link. */
  | "link"
  /** A component that must be a directory is something else. */
  | "not_directory"
  /** The target must be a regular file and is not. */
  | "not_file"
  /** The path is not a plain relative path (empty, `.`, `..`, NUL, absolute). */
  | "not_plain"
  /** Something changed while the operation ran. */
  | "raced";

/** A refusal: typed, with where and why; the caller reports it. */
export class LinkSafetyError extends Error {
  readonly code: LinkSafetyCode;
  readonly operation: string;
  /** The root's path, shown. */
  readonly root: string;
  /** The path the operation was on, below the root. */
  readonly path: Buffer;
  /** The component at issue, below the root (the root itself: empty). */
  readonly at: Buffer;

  constructor(input: { code: LinkSafetyCode; operation: string; root: SafeRoot | string; path: Buffer; at: Buffer; detail?: string }) {
    const rootText = typeof input.root === "string" ? input.root : `${input.root.what} (${input.root.text})`;
    const target = input.path.length === 0 ? "its root" : JSON.stringify(displayPath(input.path).slice(0, 200));
    const at = input.at.length === 0 ? "the root" : JSON.stringify(displayPath(input.at).slice(0, 200));
    const why = input.detail ?? {
      root: `${at} is not the real directory the host established`,
      link: `${at} is a symbolic link, which a host operation never follows`,
      not_directory: `${at} is not a directory`,
      not_file: `${at} is not a regular file`,
      not_plain: `${target} is not a plain relative path`,
      raced: `${at} changed while the operation ran`,
    }[input.code];
    super(`${input.operation} of ${target} in ${rootText} refused: ${why}`);
    this.name = "LinkSafetyError";
    this.code = input.code;
    this.operation = input.operation;
    this.root = typeof input.root === "string" ? input.root : input.root.text;
    this.path = Buffer.from(input.path);
    this.at = Buffer.from(input.at);
  }
}

/** A directory the host established, pinned by device and inode. */
export interface SafeRoot {
  /** Its canonical absolute path, as bytes. */
  readonly path: Buffer;
  /** The same, shown. */
  readonly text: string;
  /** What it is, for a reason: "the session's scratch", "the recheck copy"… */
  readonly what: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

const EMPTY = Buffer.alloc(0);

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function missing(what: string): Error {
  return Object.assign(new Error(`${what}: no such file or directory`), { code: "ENOENT" });
}

/** macOS's O_NOFOLLOW_ANY: no link in any component of the path, checked by
 * the kernel as it resolves it. */
const DARWIN_O_NOFOLLOW_ANY = 0x2000_0000;
let nofollowAny: number | undefined;

/** The flag an open uses not to follow a link: O_NOFOLLOW_ANY where the
 * kernel honours it (probed once: an open through `/var`, a link on every
 * macOS, must fail with ELOOP, and `/` must open), O_NOFOLLOW (the last
 * component only) elsewhere. The two are never combined (EINVAL). */
function noFollow(): number {
  if (nofollowAny === undefined) {
    nofollowAny = 0;
    if (process.platform === "darwin") {
      try {
        closeSync(openSync("/", constants.O_RDONLY | DARWIN_O_NOFOLLOW_ANY));
        try {
          closeSync(openSync("/var", constants.O_RDONLY | DARWIN_O_NOFOLLOW_ANY));
        } catch (error) {
          if (errnoOf(error) === "ELOOP") nofollowAny = DARWIN_O_NOFOLLOW_ANY;
        }
      } catch {
        nofollowAny = 0;
      }
    }
  }
  return nofollowAny !== 0 ? nofollowAny : constants.O_NOFOLLOW;
}

/** Whether opens refuse a link in any component atomically on this host. */
export function opensRefuseAnyLink(): boolean {
  noFollow();
  return nofollowAny !== 0;
}

function statOf(path: Buffer): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The root at `path`: its ancestors resolved (they are the host's), its last
 * component a real directory — not a link — pinned by device and inode. With
 * `create`, a missing root is made with that mode (its missing ancestors
 * too: they are the host's). Throws a LinkSafetyError (`root`, or `link` when
 * the root itself is a link) otherwise.
 */
export function safeRoot(path: string, what: string, options: { readonly create?: number } = {}): SafeRoot {
  const refuse = (code: LinkSafetyCode, detail: string) => new LinkSafetyError({ code, operation: "use", root: `${what} (${path})`, path: EMPTY, at: EMPTY, detail });
  if (!isAbsolute(path)) throw refuse("root", "it is not an absolute path");
  const absolute = resolve(path);
  if (absolute === "/") throw refuse("root", "the file system root is never a root of these operations");
  let parent: string;
  try {
    if (options.create !== undefined) mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    parent = realpathSync(dirname(absolute));
  } catch (error) {
    throw refuse("root", `its parent cannot be resolved (${errnoOf(error) ?? String(error)})`);
  }
  const canonical = Buffer.from(join(parent, basename(absolute)));
  let entry = statOf(canonical);
  if (entry === undefined && options.create !== undefined) {
    try {
      mkdirSync(canonical, { mode: options.create });
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw refuse("root", `it cannot be made (${errnoOf(error) ?? String(error)})`);
    }
    entry = statOf(canonical);
  }
  if (entry === undefined) throw refuse("root", "it does not exist");
  if (entry.isSymbolicLink()) throw refuse("link", "the root itself is a symbolic link, which a host operation never follows");
  if (!entry.isDirectory()) throw refuse("root", "it is not a directory");
  return { path: canonical, text: canonical.toString(), what, dev: entry.dev, ino: entry.ino };
}

/** Whether a root is still the directory it was pinned as. */
export function rootIntact(root: SafeRoot): boolean {
  const entry = statOf(root.path);
  return entry !== undefined && entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === root.dev && entry.ino === root.ino;
}

/** The path of `absolute` below the root (empty for the root itself), or
 * undefined when it does not lie below it. */
export function relativeBeneath(root: SafeRoot, absolute: string | Buffer): Buffer | undefined {
  const bytes = typeof absolute === "string" ? Buffer.from(absolute) : absolute;
  if (!isWithin(root.path, bytes)) return undefined;
  return bytes.length === root.path.length ? EMPTY : Buffer.from(bytes.subarray(root.path.length + 1));
}

/** One verified directory of a chain from the root down. */
interface Step {
  readonly absolute: Buffer;
  readonly rel: Buffer;
  readonly dev: bigint;
  readonly ino: bigint;
}

function rootStep(root: SafeRoot): Step {
  return { absolute: root.path, rel: EMPTY, dev: root.dev, ino: root.ino };
}

function refusal(code: LinkSafetyCode, operation: string, root: SafeRoot, path: Buffer, at: Buffer, detail?: string): LinkSafetyError {
  return new LinkSafetyError({ code, operation, root, path, at, ...(detail === undefined ? {} : { detail }) });
}

function assertPlain(root: SafeRoot, rel: Buffer, operation: string): void {
  if (!isPlainRelative(rel)) throw refusal("not_plain", operation, root, rel, rel);
}

/** Every step of `chain` is still the real directory it was verified as. */
function verify(root: SafeRoot, chain: readonly Step[], operation: string, path: Buffer): void {
  for (const step of chain) {
    let entry: BigIntStats | undefined;
    try {
      entry = statOf(step.absolute);
    } catch {
      entry = undefined;
    }
    if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== step.dev || entry.ino !== step.ino) {
      throw refusal(step.rel.length === 0 ? "root" : entry?.isSymbolicLink() === true ? "link" : "raced", operation, root, path, step.rel,
        step.rel.length === 0 ? "the root is no longer the real directory the host established" : undefined);
    }
  }
}

/**
 * The chain of real directories from the root to `dir` (relative; empty for
 * the root), each checked with lstat without following it. `complete` is
 * false when a component is missing (and `create` was not given). With
 * `create`, the part that exists is verified whole before anything is made;
 * then each missing directory is made on its own (never recursively),
 * checked after it is made, and the chain re-verified; `created` receives each
 * one made.
 */
function chainTo(
  root: SafeRoot,
  dir: Buffer,
  operation: string,
  path: Buffer,
  create?: { readonly mode: number; readonly created: Buffer[] },
): { readonly chain: Step[]; readonly complete: boolean } {
  verify(root, [rootStep(root)], operation, path);
  const chain: Step[] = [rootStep(root)];
  const parts = dir.length === 0 ? [] : segments(dir);
  let depth = 0;
  for (; depth < parts.length; depth += 1) {
    const rel = joinSegments(parts.slice(0, depth + 1));
    const absolute = beneath(root.path, rel);
    let entry: BigIntStats | undefined;
    try {
      entry = statOf(absolute);
    } catch (error) {
      throw refusal(errnoOf(error) === "ENOTDIR" ? "raced" : "not_directory", operation, root, path, rel);
    }
    if (entry === undefined) break;
    if (entry.isSymbolicLink()) throw refusal("link", operation, root, path, rel);
    if (!entry.isDirectory()) throw refusal("not_directory", operation, root, path, rel);
    chain.push({ absolute, rel, dev: entry.dev, ino: entry.ino });
  }
  if (depth === parts.length) return { chain, complete: true };
  if (create === undefined) return { chain, complete: false };
  for (; depth < parts.length; depth += 1) {
    const rel = joinSegments(parts.slice(0, depth + 1));
    const absolute = beneath(root.path, rel);
    verify(root, chain, operation, path);
    try {
      mkdirSync(absolute, { mode: create.mode });
      create.created.push(rel);
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error;
    }
    // Checked again once made: what stands there now is a real directory.
    const entry = statOf(absolute);
    if (entry === undefined) throw refusal("raced", operation, root, path, rel);
    if (entry.isSymbolicLink()) throw refusal("link", operation, root, path, rel);
    if (!entry.isDirectory()) throw refusal("not_directory", operation, root, path, rel);
    chain.push({ absolute, rel, dev: entry.dev, ino: entry.ino });
  }
  verify(root, chain, operation, path);
  return { chain, complete: true };
}

/** Take back directories made for an operation that was then refused:
 * newest first, each only while it is still the empty real directory made. */
function undoCreated(root: SafeRoot, created: readonly Buffer[]): void {
  for (const rel of [...created].reverse()) {
    try {
      rmdirBeneath(root, rel, "undo");
    } catch {
      // Left for the caller's report: never through a link.
    }
  }
}

/**
 * What stands at `rel` below the root, the entry itself (a link is not
 * followed); undefined when it, or a directory above it, is absent. Every
 * directory above it must be a real one.
 */
export function lstatBeneath(root: SafeRoot, rel: Buffer, operation = "read"): BigIntStats | undefined {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) return undefined;
  const entry = statOf(beneath(root.path, rel));
  verify(root, chain, operation, rel);
  return entry;
}

/** The target of the link at `rel`, as bytes. */
export function readLinkBeneath(root: SafeRoot, rel: Buffer, operation = "read"): Buffer {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) throw missing(displayPath(rel));
  const target = readlinkSync(beneath(root.path, rel), { encoding: "buffer" }) as Buffer;
  verify(root, chain, operation, rel);
  return target;
}

/** The names in the real directory at `rel` (empty: the root), as bytes;
 * undefined when it is absent. A link there is refused, and the directory is
 * verified again after it is listed, so the names are its own. */
export function listBeneath(root: SafeRoot, rel: Buffer, operation = "list"): Buffer[] | undefined {
  if (rel.length > 0) assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, rel, operation, rel);
  if (!complete) return undefined;
  const last = chain.at(-1)!;
  const names = readDirectoryBytes(last.absolute);
  verify(root, chain, operation, rel);
  return names;
}

/**
 * Walk everything below the real directory at `rel` (empty: the root),
 * depth-first, never through a link: `visit` is called with each entry's path
 * below the root and its lstat; a real directory is descended into when
 * `visit` returns true, and the walk stops when it returns "stop". Each
 * directory is listed through listBeneath (its chain verified before and
 * after), so a directory swapped for a link while the walk runs is refused,
 * never listed.
 */
export function walkBeneath(
  root: SafeRoot,
  rel: Buffer,
  visit: (path: Buffer, entry: BigIntStats) => boolean | "stop",
  operation = "list",
): void {
  const pending: Buffer[] = [Buffer.from(rel)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const names = listBeneath(root, current, operation);
    if (names === undefined) continue;
    const base = current.length === 0 ? root.path : beneath(root.path, current);
    const below: Buffer[] = [];
    for (const name of names.sort(Buffer.compare)) {
      const path = current.length === 0 ? Buffer.from(name) : beneath(current, name);
      const entry = statOf(beneath(base, name));
      if (entry === undefined) continue;
      const next = visit(path, entry);
      if (next === "stop") return;
      if (next && entry.isDirectory() && !entry.isSymbolicLink()) below.push(path);
    }
    // Depth-first, in byte order.
    for (const path of below.reverse()) pending.push(path);
  }
}

/** A regular file opened through verified directories, without following a
 * link. `verify` holds the path to it: the chain unchanged and the inode at
 * the path the one the descriptor holds. */
export interface OpenedFile {
  readonly fd: number;
  readonly size: number;
  readonly mode: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  /** How many names the inode has (a second one can lie outside the root). */
  readonly nlink: bigint;
  verify(): void;
  close(): void;
}

/** Open the regular file at `rel` for reading (O_NONBLOCK: a FIFO planted
 * there never blocks the host); undefined when it is absent. A link there or
 * above it, or anything but a regular file, is refused. */
export function openBeneath(root: SafeRoot, rel: Buffer, operation = "read"): OpenedFile | undefined {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) return undefined;
  const absolute = beneath(root.path, rel);
  verify(root, chain, operation, rel);
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | noFollow());
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EMLINK") throw refusal("link", operation, root, rel, rel);
    if (code === "ENOTDIR") throw refusal("raced", operation, root, rel, parentOf(rel) ?? EMPTY);
    throw error;
  }
  let opened: BigIntStats;
  try {
    opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw refusal("not_file", operation, root, rel, rel);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const check = () => {
    verify(root, chain, operation, rel);
    const placed = statOf(absolute);
    if (placed === undefined || placed.dev !== opened.dev || placed.ino !== opened.ino) throw refusal("raced", operation, root, rel, rel);
  };
  try {
    check();
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return {
    fd,
    size: Number(opened.size),
    mode: Number(opened.mode),
    dev: opened.dev,
    ino: opened.ino,
    mtimeNs: opened.mtimeNs,
    nlink: opened.nlink,
    verify: check,
    close: () => closeSync(fd),
  };
}

/** Read `length` bytes from the start of an opened file (fewer at its end). */
export function readOpened(file: OpenedFile, length: number): Buffer {
  const out = Buffer.alloc(Math.max(0, length));
  let read = 0;
  while (read < out.length) {
    const got = readSync(file.fd, out, read, out.length - read, read);
    if (got === 0) break;
    read += got;
  }
  return out.subarray(0, read);
}

/** The whole regular file at `rel`; undefined when absent. Held to the size
 * it had when opened, and to the path afterwards. */
export function readBeneath(root: SafeRoot, rel: Buffer, operation = "read"): Buffer | undefined {
  const file = openBeneath(root, rel, operation);
  if (file === undefined) return undefined;
  try {
    const bytes = readOpened(file, file.size);
    if (bytes.length !== file.size || readSync(file.fd, Buffer.alloc(1), 0, 1, file.size) !== 0) {
      throw refusal("raced", operation, root, rel, rel, `${JSON.stringify(displayPath(rel).slice(0, 200))} changed while it was read`);
    }
    file.verify();
    return bytes;
  } finally {
    file.close();
  }
}

/** Make the directory at `rel` and every missing one above it, each a real
 * directory, none through a link. Returns the ones made. */
export function ensureDirBeneath(root: SafeRoot, rel: Buffer, mode = 0o700, operation = "create"): Buffer[] {
  if (rel.length === 0) {
    verify(root, [rootStep(root)], operation, rel);
    return [];
  }
  assertPlain(root, rel, operation);
  const created: Buffer[] = [];
  try {
    chainTo(root, rel, operation, rel, { mode, created });
  } catch (error) {
    undoCreated(root, created);
    throw error;
  }
  return created;
}

/** Whether every directory from the root down to `dir` (empty: the root
 * itself) is a real directory (`real`), one of them is absent (`missing`), or
 * one is a link or not a directory (`not_real`). Never follows a link. */
export function directoryChainState(root: SafeRoot, dir: Buffer, operation = "read"): "real" | "missing" | "not_real" {
  try {
    return chainTo(root, dir, operation, dir).complete ? "real" : "missing";
  } catch (error) {
    if (error instanceof LinkSafetyError && (error.code === "link" || error.code === "not_directory")) return "not_real";
    throw error;
  }
}

/**
 * Create a NEW regular file at `rel` and hand back its descriptor, open for
 * writing (O_CREAT|O_EXCL, never through a link): what a lock file needs. The
 * file made must be the one at the verified path; otherwise it is removed
 * from where it was made (by descriptor: truncated) and refused. The caller
 * closes the descriptor.
 */
export function createExclusiveBeneath(root: SafeRoot, rel: Buffer, mode: number, operation = "create"): number {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) throw missing(displayPath(parentOf(rel) ?? EMPTY));
  const absolute = beneath(root.path, rel);
  verify(root, chain, operation, rel);
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), mode);
  } catch (error) {
    if (errnoOf(error) === "ELOOP") throw refusal("link", operation, root, rel, rel);
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const placed = statOf(absolute);
    if (placed === undefined || placed.dev !== opened.dev || placed.ino !== opened.ino) throw refusal("raced", operation, root, rel, parentOf(rel) ?? EMPTY);
    verify(root, chain, operation, rel);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Write `bytes` into a NEW regular file at `rel` (O_CREAT|O_EXCL: anything
 * there, a link included, is EEXIST), its mode and times set through the
 * descriptor. With `parents`, missing directories above it are made with that
 * mode. The write counts only when the file made is the one at the verified
 * path afterwards; otherwise it is truncated and the operation refused.
 * `created` is called as soon as the file exists, before anything else can
 * fail: a caller that journals what it wrote journals it there.
 */
export function writeBeneath(
  root: SafeRoot,
  rel: Buffer,
  bytes: Buffer,
  options: {
    readonly mode: number;
    readonly atime?: number;
    readonly mtime?: number;
    readonly parents?: number;
    readonly operation?: string;
    readonly created?: () => void;
  },
): { readonly dev: bigint; readonly ino: bigint } {
  const operation = options.operation ?? "write";
  assertPlain(root, rel, operation);
  const created: Buffer[] = [];
  let fd: number | undefined;
  try {
    const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel, options.parents === undefined ? undefined : { mode: options.parents, created });
    if (!complete) throw missing(displayPath(parentOf(rel) ?? EMPTY));
    const absolute = beneath(root.path, rel);
    verify(root, chain, operation, rel);
    try {
      fd = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
    } catch (error) {
      if (errnoOf(error) === "ELOOP") throw refusal("link", operation, root, rel, rel);
      throw error;
    }
    options.created?.();
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, options.mode);
    if (options.mtime !== undefined) futimesSync(fd, options.atime ?? options.mtime, options.mtime);
    const opened = fstatSync(fd, { bigint: true });
    const placed = statOf(absolute);
    if (placed === undefined || placed.dev !== opened.dev || placed.ino !== opened.ino) {
      // The file was made somewhere else: what it holds is taken back.
      ftruncateSync(fd, 0);
      throw refusal("raced", operation, root, rel, parentOf(rel) ?? EMPTY);
    }
    verify(root, chain, operation, rel);
    return { dev: opened.dev, ino: opened.ino };
  } catch (error) {
    undoCreated(root, created);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What an existing regular file held when `rewriteBeneath` opened it. */
export interface RewriteState {
  readonly bytes: Buffer;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
}

/**
 * Rewrite the EXISTING regular file at `rel` in place, on the inode that was
 * checked (#221 M3). It is opened for reading and writing without following
 * a link (O_NOFOLLOW_ANY on macOS, O_NOFOLLOW on the last component
 * elsewhere, every directory above it checked with lstat) and O_NONBLOCK, so
 * a FIFO planted there never blocks the host; anything but a regular file
 * with exactly one name is refused (a second name could lie outside the
 * root, and the write would reach it). `decide` is called synchronously with
 * what the descriptor holds and returns the bytes to write, or throws to
 * refuse — then nothing is written. Nothing asynchronous can run between
 * `decide` and the write: the inode at the verified path is checked again,
 * the file truncated and written through the same descriptor. `written` is
 * called as soon as the bytes are in; a path that no longer names the
 * written inode afterwards is a `raced` refusal thrown AFTER the effect.
 * Mode and ownership are kept (the inode is the same). Absent: ENOENT.
 */
export function rewriteBeneath(
  root: SafeRoot,
  rel: Buffer,
  decide: (state: RewriteState) => Buffer,
  options: { readonly operation?: string; readonly written?: () => void } = {},
): { readonly dev: bigint; readonly ino: bigint; readonly size: number } {
  const operation = options.operation ?? "rewrite";
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) throw missing(displayPath(rel));
  const absolute = beneath(root.path, rel);
  verify(root, chain, operation, rel);
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDWR | constants.O_NONBLOCK | noFollow());
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") throw missing(displayPath(rel));
    if (code === "ELOOP" || code === "EMLINK") throw refusal("link", operation, root, rel, rel);
    if (code === "ENOTDIR") throw refusal("raced", operation, root, rel, parentOf(rel) ?? EMPTY);
    if (code === "EISDIR" || code === "ENXIO") throw refusal("not_file", operation, root, rel, rel);
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw refusal("not_file", operation, root, rel, rel);
    if (opened.nlink !== 1n) {
      throw refusal("not_file", operation, root, rel, rel,
        `${JSON.stringify(displayPath(rel).slice(0, 200))} has more than one name; a write would reach every other name of it`);
    }
    const placedBefore = statOf(absolute);
    if (placedBefore === undefined || placedBefore.dev !== opened.dev || placedBefore.ino !== opened.ino) {
      throw refusal("raced", operation, root, rel, rel);
    }
    verify(root, chain, operation, rel);
    const size = Number(opened.size);
    const current = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const count = readSync(fd, current, got, size - got, got);
      if (count === 0) break;
      got += count;
    }
    if (got !== size || readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) {
      throw refusal("raced", operation, root, rel, rel, `${JSON.stringify(displayPath(rel).slice(0, 200))} changed while it was read`);
    }
    const next = decide({ bytes: current, dev: opened.dev, ino: opened.ino, mode: Number(opened.mode) });
    // The path must still name the inode decided on: one lstat, no await.
    const placed = statOf(absolute);
    if (placed === undefined || placed.dev !== opened.dev || placed.ino !== opened.ino) {
      throw refusal("raced", operation, root, rel, rel);
    }
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < next.length) offset += writeSync(fd, next, offset, next.length - offset, offset);
    options.written?.();
    // Read back through the same descriptor (#221 M3'): only bytes the host
    // wrote and reads back equal count.
    const after = fstatSync(fd, { bigint: true });
    const back = Buffer.alloc(next.length);
    let read = 0;
    while (read < back.length) {
      const count = readSync(fd, back, read, back.length - read, read);
      if (count === 0) break;
      read += count;
    }
    if (Number(after.size) !== next.length || read !== next.length || !back.equals(next)) {
      throw refusal("raced", operation, root, rel, rel, `${JSON.stringify(displayPath(rel).slice(0, 200))} does not hold the bytes written`);
    }
    const still = statOf(absolute);
    if (still === undefined || still.dev !== after.dev || still.ino !== after.ino) throw refusal("raced", operation, root, rel, rel);
    verify(root, chain, operation, rel);
    return { dev: after.dev, ino: after.ino, size: Number(after.size) };
  } finally {
    closeSync(fd);
  }
}

/** Set the mode of the file or directory at `rel` through a descriptor
 * opened without following a link. */
export function chmodBeneath(root: SafeRoot, rel: Buffer, mode: number, operation = "chmod"): void {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) throw missing(displayPath(rel));
  const absolute = beneath(root.path, rel);
  verify(root, chain, operation, rel);
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | noFollow());
  } catch (error) {
    if (errnoOf(error) === "ELOOP") throw refusal("link", operation, root, rel, rel);
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const placed = statOf(absolute);
    if (placed === undefined || placed.dev !== opened.dev || placed.ino !== opened.ino) throw refusal("raced", operation, root, rel, rel);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
  verify(root, chain, operation, rel);
}

/** Remove the entry at `rel` when it is not a directory — a file, a link (as
 * the link), anything else; false when absent. A directory is refused. */
export function unlinkBeneath(root: SafeRoot, rel: Buffer, operation = "remove"): boolean {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) return false;
  const absolute = beneath(root.path, rel);
  const entry = statOf(absolute);
  if (entry === undefined) return false;
  if (entry.isDirectory()) throw refusal("not_file", operation, root, rel, rel, `${JSON.stringify(displayPath(rel).slice(0, 200))} is a directory`);
  verify(root, chain, operation, rel);
  unlinkSync(absolute);
  verify(root, chain, operation, rel);
  return true;
}

/** Remove the empty real directory at `rel`; false when absent. */
export function rmdirBeneath(root: SafeRoot, rel: Buffer, operation = "remove"): boolean {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) return false;
  const absolute = beneath(root.path, rel);
  const entry = statOf(absolute);
  if (entry === undefined) return false;
  if (entry.isSymbolicLink()) throw refusal("link", operation, root, rel, rel);
  if (!entry.isDirectory()) throw refusal("not_directory", operation, root, rel, rel);
  verify(root, [...chain, { absolute, rel, dev: entry.dev, ino: entry.ino }], operation, rel);
  rmdirSync(absolute);
  verify(root, chain, operation, rel);
  return true;
}

/**
 * Remove whatever is at `rel`, recursively: a link is removed as the link, a
 * file as the file, a real directory with everything below it — never
 * descending through a link. Every directory is verified before it is
 * listed, after it is listed and before each removal in it; a change seen
 * stops the removal with a `raced` refusal. False when nothing was there.
 */
export function removeTreeBeneath(root: SafeRoot, rel: Buffer, operation = "remove"): boolean {
  assertPlain(root, rel, operation);
  const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel);
  if (!complete) return false;
  const absolute = beneath(root.path, rel);
  const entry = statOf(absolute);
  if (entry === undefined) return false;
  removeEntry(root, chain, rel, absolute, entry, operation);
  return true;
}

function removeEntry(root: SafeRoot, chain: readonly Step[], rel: Buffer, absolute: Buffer, entry: BigIntStats, operation: string): void {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    verify(root, chain, operation, rel);
    unlinkSync(absolute);
    return;
  }
  const inner = [...chain, { absolute, rel, dev: entry.dev, ino: entry.ino }];
  verify(root, inner, operation, rel);
  const names = readDirectoryBytes(absolute);
  verify(root, inner, operation, rel);
  for (const name of names) {
    const childAbsolute = beneath(absolute, name);
    const child = statOf(childAbsolute);
    if (child === undefined) continue;
    removeEntry(root, inner, beneath(rel, name), childAbsolute, child, operation);
  }
  verify(root, inner, operation, rel);
  rmdirSync(absolute);
  verify(root, chain, operation, rel);
}

/** Make a link at `rel` whose target is exactly `target` (never at a path
 * through a link); checked after it is made. `created` is called as soon as
 * the link exists. */
export function symlinkBeneath(
  root: SafeRoot,
  rel: Buffer,
  target: Buffer,
  options: { readonly parents?: number; readonly operation?: string; readonly created?: () => void } = {},
): void {
  const operation = options.operation ?? "link";
  assertPlain(root, rel, operation);
  const created: Buffer[] = [];
  try {
    const { chain, complete } = chainTo(root, parentOf(rel) ?? EMPTY, operation, rel, options.parents === undefined ? undefined : { mode: options.parents, created });
    if (!complete) throw missing(displayPath(parentOf(rel) ?? EMPTY));
    const absolute = beneath(root.path, rel);
    verify(root, chain, operation, rel);
    symlinkSync(target, absolute);
    options.created?.();
    const made = statOf(absolute);
    if (made === undefined || !made.isSymbolicLink() || !(readlinkSync(absolute, { encoding: "buffer" }) as Buffer).equals(target)) {
      throw refusal("raced", operation, root, rel, rel);
    }
    verify(root, chain, operation, rel);
  } catch (error) {
    undoCreated(root, created);
    throw error;
  }
}

/**
 * Move the entry at `fromRel` below `from` to `toRel` below `to`, which must
 * not exist: the entry itself, a link as the link. Both chains are verified
 * right before the move and after it, and what arrived must be the entry
 * checked (device and inode). Across file systems (EXDEV) a file or a link is
 * copied through verified paths and the original removed; a directory is not
 * moved there.
 */
export function renameBeneath(
  from: SafeRoot,
  fromRel: Buffer,
  to: SafeRoot,
  toRel: Buffer,
  options: { readonly parents?: number; readonly operation?: string } = {},
): void {
  const operation = options.operation ?? "move";
  assertPlain(from, fromRel, operation);
  assertPlain(to, toRel, operation);
  const source = chainTo(from, parentOf(fromRel) ?? EMPTY, operation, fromRel);
  if (!source.complete) throw missing(displayPath(fromRel));
  const created: Buffer[] = [];
  let target: { readonly chain: Step[]; readonly complete: boolean };
  try {
    target = chainTo(to, parentOf(toRel) ?? EMPTY, operation, toRel, options.parents === undefined ? undefined : { mode: options.parents, created });
  } catch (error) {
    undoCreated(to, created);
    throw error;
  }
  if (!target.complete) throw missing(displayPath(parentOf(toRel) ?? EMPTY));
  const fromAbsolute = beneath(from.path, fromRel);
  const toAbsolute = beneath(to.path, toRel);
  const entry = statOf(fromAbsolute);
  if (entry === undefined) throw missing(displayPath(fromRel));
  if (statOf(toAbsolute) !== undefined) throw Object.assign(new Error(`${displayPath(toRel)} already exists`), { code: "EEXIST" });
  verify(from, source.chain, operation, fromRel);
  verify(to, target.chain, operation, toRel);
  try {
    renameSync(fromAbsolute, toAbsolute);
  } catch (error) {
    if (errnoOf(error) !== "EXDEV") throw error;
    moveAcross(from, fromRel, source.chain, entry, to, toRel, operation);
    return;
  }
  const arrived = statOf(toAbsolute);
  if (arrived === undefined || arrived.dev !== entry.dev || arrived.ino !== entry.ino) throw refusal("raced", operation, from, fromRel, fromRel);
  verify(from, source.chain, operation, fromRel);
  verify(to, target.chain, operation, toRel);
}

function moveAcross(from: SafeRoot, fromRel: Buffer, chain: readonly Step[], entry: BigIntStats, to: SafeRoot, toRel: Buffer, operation: string): void {
  const fromAbsolute = beneath(from.path, fromRel);
  if (entry.isSymbolicLink()) {
    symlinkBeneath(to, toRel, readLinkBeneath(from, fromRel, operation), { operation });
  } else if (entry.isFile()) {
    const file = openBeneath(from, fromRel, operation);
    if (file === undefined || file.dev !== entry.dev || file.ino !== entry.ino) {
      file?.close();
      throw refusal("raced", operation, from, fromRel, fromRel);
    }
    try {
      const bytes = readOpened(file, file.size);
      file.verify();
      const mtime = Number(entry.mtimeMs) / 1_000;
      writeBeneath(to, toRel, bytes, { mode: Number(entry.mode) & 0o7777, atime: Number(entry.atimeMs) / 1_000, mtime, operation });
    } finally {
      file.close();
    }
  } else {
    throw Object.assign(new Error(`${displayPath(fromRel)} is not a file or a link and cannot be moved across file systems`), { code: "EXDEV" });
  }
  const still = statOf(fromAbsolute);
  if (still === undefined || still.dev !== entry.dev || still.ino !== entry.ino) throw refusal("raced", operation, from, fromRel, fromRel);
  verify(from, chain, operation, fromRel);
  unlinkSync(fromAbsolute);
}
