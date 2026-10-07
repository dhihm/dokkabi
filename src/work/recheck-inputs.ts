import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LinkSafetyError,
  lstatBeneath,
  readBeneath,
  readLinkBeneath,
  relativeBeneath,
  safeRoot,
  walkBeneath,
  type SafeRoot,
} from "./link-safe-fs.ts";
import { beneath, bytesKey, displayPath, exactBase64, isWithin, segments } from "./path-bytes.ts";
import { readRegularFile } from "./session-scratch.ts";

/**
 * EVIDENCE IS WHAT EXISTED BEFORE THE EXECUTION (D57, design memo §111 E1;
 * D57b, E1').
 *
 * A recheck execution can change or remove its own inputs: a script that
 * deletes itself, one that rewrites its data before it asserts, a later
 * attempt that finds nothing left to start. Anything a ruling depends on is
 * therefore captured BEFORE the execution that produced the observation can
 * change it. Right before every recheck execution of a case — after its
 * fixtures are materialised from the record, before its command starts — the
 * observer snapshots that execution's inputs into a content-addressed store in
 * the run's own session directory.
 *
 * THE SURFACE (E1'): the snapshot covers every location the execution's
 * sandbox makes readable to it among what the host binds for it besides the
 * product — nothing the execution can read there is left out:
 *
 *   - `scratch`: the scratch its policy binds (D48), whole — every file, link
 *     and directory below it, the host's own `.host` subtree (the content
 *     store `.host/fixtures`, the observations' `.host/observe`, anything a
 *     session put there) and the check's fixture directory `checks/<case>/`
 *     just materialised from the record included;
 *   - `files`: the verifier's overlaid files (D47), each as it stands in the
 *     recheck copy right before the run;
 *   - `stdin`: the stdin materialised from the record, when the check has one.
 *
 * A link is captured as a link — its exact target bytes — and where it leads
 * is resolved then, each link on the way followed as the kernel follows it
 * (recheckInputReach): to an entry of the snapshot (so its content is captured
 * too), to a place inside the bound scratch where nothing is, or outside the
 * surface — through a link the snapshot does not hold, to a place it does not
 * hold, or past 32 links. A link that leads outside makes the snapshot
 * incomplete for evidence purposes, and the snapshot and the row say so
 * (`outside`). So does a sandbox that does not confine what the execution
 * reads to the surface (`fence` other than `seatbelt` or `bwrap`: with the
 * fence off or in a Docker world any other location may be readable, and no
 * snapshot covers it; `unconfined` on the row). There is no third way: what
 * the execution can read of what the host bound is in the snapshot.
 *
 * Every path and link target is its exact bytes (base64 in the snapshot), a
 * file its mode, size and sha256, its content an object under that digest.
 * The walk never follows a link. The snapshot is bounded
 * (RECHECK_INPUT_BOUNDS), and so is the store (RECHECK_INPUT_STORE_BYTES); a
 * snapshot past a bound lists nothing and says `bounded: "exceeded"`. A
 * reported case's snapshot also records the keep its overlaid files came from
 * (kept at all, files left behind, why not): a keep that left files behind
 * exceeded its own bound. The observation row names the snapshot
 * (`inputs`), and the evidence of a dispute is the snapshot of the execution
 * that produced its red observation — never a later attempt, never an
 * inventory taken after a run (verifier-files.ts, recheck.ts).
 *
 * Layout, beside the rounds log:
 *   recheck-inputs/objects/<sha256>          file contents
 *   recheck-inputs/snapshots/<sha256>.json   one snapshot, named by its digest
 *
 * Nothing here gates and nothing throws out of snapshotRecheckInputs: a
 * snapshot that cannot be taken is recorded with its reason, and evidence
 * resting on it is incomplete.
 *
 * S1 (D57c): the scratch and the copy are trees a session writes, so the
 * snapshot reads them below roots the host pinned (link-safe-fs.ts): a link
 * in the scratch's own place refuses the snapshot, a directory is listed only
 * through verified real directories, and a file is read only as the inode at
 * its verified path — never through a link a session put in a directory's
 * place, and never a FIFO that would block the host.
 */

/** The store's directory, beside the run's own rounds log. */
export const RECHECK_INPUTS_DIR = "recheck-inputs";
const OBJECTS_DIR = "objects";
const SNAPSHOTS_DIR = "snapshots";

/** The snapshot format this build writes and reads (D57b): version 1 (D57)
 * left the scratch's `.host` out and resolved no link, so it is not read as
 * evidence. */
export const RECHECK_INPUTS_VERSION = 2;

/** The sandboxes that confine what an execution reads to the locations they
 * list (sandbox.ts): with any other — the fence off (`none`), a Docker world
 * — locations the snapshot does not cover are readable. */
export const CONFINING_FENCES: ReadonlySet<string> = new Set(["seatbelt", "bwrap"]);

/** At most this many links are followed resolving one link's target; past
 * it the target is outside the surface (the kernels give up at 32 or 40). */
export const MAX_LINK_HOPS = 32;

export interface RecheckInputBounds {
  /** Entries in one snapshot: files, links, directories, anything else. */
  readonly entries: number;
  /** Bytes of the files in one snapshot, together. */
  readonly bytes: number;
}

/** One execution's inputs, at most: 3,000 entries and 40 MiB — a scratch's
 * scripts and fixtures, a verifier's kept files (2,000 files and 20 MiB at
 * most, verifier-files.ts) and a check's stdin (1 MiB). One snapshot so fits
 * one verifier's evidence bound (4,000 files, 64 MiB). */
export const RECHECK_INPUT_BOUNDS: Readonly<RecheckInputBounds> = Object.freeze({
  entries: 3_000,
  bytes: 40 * 1024 * 1024,
});

/** The whole store of one run, at most: 256 MiB of objects (a session's
 * scratch cap). Content-addressed, so inputs that do not change between
 * executions cost their bytes once. */
export const RECHECK_INPUT_STORE_BYTES = 256 * 1024 * 1024;

export type RecheckInputNamespace = "scratch" | "files" | "stdin";

/** Where a link leads (E1'): an entry of the snapshot — `path` empty for the
 * scratch root itself — or, `absent`, a place inside the bound scratch where
 * nothing is; or outside the surface, and why. */
export type RecheckInputReach =
  | { readonly to: RecheckInputNamespace; readonly path: Buffer; readonly absent?: true }
  | { readonly outside: string };

/** One input, its path the exact bytes below its namespace's root. */
export type RecheckInputEntry =
  | { readonly ns: RecheckInputNamespace; readonly type: "file"; readonly path: Buffer; readonly mode: number; readonly bytes: number; readonly sha256: string }
  | { readonly ns: RecheckInputNamespace; readonly type: "link"; readonly path: Buffer; readonly target: Buffer; readonly reach: RecheckInputReach }
  | { readonly ns: RecheckInputNamespace; readonly type: "dir"; readonly path: Buffer; readonly mode: number }
  | { readonly ns: RecheckInputNamespace; readonly type: "other"; readonly path: Buffer };

/** The keep a reported case's overlaid files came from (D47): whether one
 * ran, how many authored files it left behind, why it kept nothing, and how
 * many of the files it kept did not reach the recheck copy as kept (not
 * overlaid, or not matching the keep's digest there). */
export interface RecheckInputKeep {
  readonly kept: boolean;
  readonly skipped: number;
  readonly reason?: string;
  readonly notOverlaid?: number;
}

/** One execution's inputs, as the snapshot records them. */
export interface RecheckInputSnapshot {
  /** The scratch the run bound (its `$DOKKABI_SCRATCH`), when it bound one. */
  readonly scratch?: string;
  /** The sandbox the execution ran in (its policy's backend, E1'). */
  readonly fence: string;
  /** reported cases: the keep the overlaid files came from. */
  readonly keep?: RecheckInputKeep;
  readonly bounds: RecheckInputBounds;
  /** `exceeded` when a bound was passed: then `entries` is empty and
   * `exceeded` says which. */
  readonly bounded: "within" | "exceeded";
  readonly exceeded?: string;
  /** Ordered by namespace, then by path bytes. */
  readonly entries: readonly RecheckInputEntry[];
}

/** What an observation row records of its execution's inputs (`inputs`): the
 * snapshot's digest and file, how many entries and file bytes it lists — or
 * that it passed a bound, or why none could be taken — and (E1') how many of
 * its links lead outside the surface, and the execution's fence when it does
 * not confine reads to the surface. */
export interface RecheckInputsRecord {
  readonly snapshot?: string;
  readonly file?: string;
  readonly entries?: number;
  readonly bytes?: number;
  readonly bounded?: "exceeded";
  readonly reason?: string;
  readonly outside?: number;
  readonly unconfined?: string;
}

const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const NAMESPACE_ORDER: Readonly<Record<RecheckInputNamespace, number>> = { scratch: 0, files: 1, stdin: 2 };
const STDIN_PATH = Buffer.from("stdin");
const SLASH = 0x2f;
const ROOT = Buffer.from("/");
const DOT = Buffer.from(".");
const DOT_DOT = Buffer.from("..");

/** Two relative paths joined; either may be empty. */
function joinRelative(left: Buffer, right: Buffer): Buffer {
  if (left.length === 0) return Buffer.from(right);
  if (right.length === 0) return Buffer.from(left);
  return beneath(left, right);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write `bytes` to `path` whole, under another name first, then renamed: a
 * reader never sees half of it. */
function writeAtomically(path: string, bytes: Buffer): void {
  const partial = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
  const fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
}

/**
 * The content-addressed store of one run's recheck inputs.
 *
 * T7 (D58b V6): every byte the store writes counts against its limit — the
 * objects AND the snapshot files naming them, which list a snapshot's every
 * entry and so grow with what it covers. A store opened on a directory counts
 * what that directory already holds (walked once, then counted as written);
 * a VIEW of it (`within`) counts only what is written through it and holds
 * both limits at once, so one observation's, or one execution's, writes are
 * capped inside the session's or the run's. Content-addressed: an object or a
 * snapshot already held whole costs nothing again.
 */
export class RecheckInputStore {
  private used: number | undefined;

  constructor(
    readonly dir: string,
    readonly limit: number = RECHECK_INPUT_STORE_BYTES,
    private readonly parent?: RecheckInputStore,
  ) {
    if (parent !== undefined) this.used = 0;
  }

  /** The store beside a rounds log (`<rounds dir>/recheck-inputs`). */
  static beside(roundsLogPath: string, limit?: number): RecheckInputStore {
    return new RecheckInputStore(join(dirname(roundsLogPath), RECHECK_INPUTS_DIR), limit);
  }

  /** A view of this store that writes here and holds at most `limit` newly
   * written bytes of its own, within this store's limit (D58b V6). */
  within(limit: number): RecheckInputStore {
    return new RecheckInputStore(this.dir, limit, this);
  }

  objectPath(sha256: string): string {
    return join(this.dir, OBJECTS_DIR, sha256);
  }

  snapshotPath(sha256: string): string {
    return join(this.dir, SNAPSHOTS_DIR, `${sha256}.json`);
  }

  /** The bytes this store counts: for a store opened on a directory, every
   * object and snapshot file it holds (walked once, then counted as
   * written); for a view, what was written through it. */
  bytesHeld(): number {
    return this.usage();
  }

  private usage(): number {
    if (this.used !== undefined) return this.used;
    let total = 0;
    for (const sub of [OBJECTS_DIR, SNAPSHOTS_DIR]) {
      try {
        for (const name of readdirSync(join(this.dir, sub))) {
          try {
            const entry = lstatSync(join(this.dir, sub, name));
            if (entry.isFile()) total += entry.size;
          } catch {
            // Gone since the listing.
          }
        }
      } catch {
        // No such directory yet.
      }
    }
    this.used = total;
    return total;
  }

  /** True when `bytes` more fit this store and every store it is a view of. */
  admits(bytes: number): boolean {
    return this.usage() + bytes <= this.limit && (this.parent?.admits(bytes) ?? true);
  }

  private charge(bytes: number): void {
    this.used = this.usage() + bytes;
    this.parent?.charge(bytes);
  }

  /** Keep `bytes` under their digest; false when the store is full. An
   * object already held whole is left as it is. */
  put(bytes: Buffer, sha256: string): boolean {
    const path = this.objectPath(sha256);
    try {
      if (sha256Hex(readRegularFile(path)) === sha256) return true;
    } catch {
      // Not held yet (or unreadable): written below.
    }
    if (!this.admits(bytes.length)) return false;
    mkdirSync(join(this.dir, OBJECTS_DIR), { recursive: true, mode: 0o700 });
    writeAtomically(path, bytes);
    if (sha256Hex(readRegularFile(path)) !== sha256) {
      rmSync(path, { force: true });
      throw new Error("an input object was not written whole");
    }
    this.charge(bytes.length);
    return true;
  }

  /** Keep one snapshot file under its digest, counted like an object (D58b
   * V6); false when it does not fit. One already held whole costs nothing. */
  putSnapshot(encoded: Buffer, digest: string): boolean {
    const file = this.snapshotPath(digest);
    try {
      if (sha256Hex(readRegularFile(file)) === digest) return true;
    } catch {
      // Not held yet: written below.
    }
    if (!this.admits(encoded.length)) return false;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeAtomically(file, encoded);
    if (sha256Hex(readRegularFile(file)) !== digest) {
      rmSync(file, { force: true });
      throw new Error("the snapshot was not written whole");
    }
    this.charge(encoded.length);
    return true;
  }

  /** An object's bytes, held to its digest and size; throws what is wrong. */
  read(sha256: string, bytes: number): Buffer {
    let content: Buffer;
    try {
      content = readRegularFile(this.objectPath(sha256));
    } catch {
      throw new Error(`its content (sha256 ${sha256.slice(0, 12)}) is gone from the run's input store`);
    }
    if (content.length !== bytes || sha256Hex(content) !== sha256) {
      throw new Error(`its content (sha256 ${sha256.slice(0, 12)}) no longer matches its digest in the run's input store`);
    }
    return content;
  }
}

/** What one snapshot walks: the sandbox the execution runs in, the scratch
 * its policy binds, the overlaid files in the copy, the materialised stdin,
 * and the keep behind the overlay. */
export interface RecheckInputsSource {
  /** The execution's sandbox: its policy's backend (E1'). Only a confining
   * one (CONFINING_FENCES) keeps what the execution reads to the surface; a
   * caller that names none is recorded as `unknown`, which does not. */
  readonly fence: string;
  readonly scratch?: string;
  /** `scratch` as a root the caller already pinned (S1): walked as it is,
   * never resolved again from its path. A property's counterexample (D58)
   * is snapshotted this way: its per-case directory, verified from the
   * pinned scratch down, component by component. */
  readonly scratchRoot?: SafeRoot;
  readonly copy?: string;
  /** Paths overlaid onto the copy (D47), relative to it, as exact bytes. */
  readonly overlaid?: readonly Buffer[];
  readonly stdin?: string;
  readonly keep?: RecheckInputKeep;
}

class Exceeded extends Error {}

/** One input found by the walk, before any file is read or link resolved:
 * each read later through the pinned root it was found under (S1). */
type Found =
  | { readonly ns: RecheckInputNamespace; readonly type: "file"; readonly path: Buffer; readonly root: SafeRoot; readonly rel: Buffer; readonly mode: number; readonly size: number }
  | { readonly ns: RecheckInputNamespace; readonly type: "link"; readonly path: Buffer; readonly absolute: Buffer; readonly target: Buffer }
  | Extract<RecheckInputEntry, { readonly type: "dir" | "other" }>;

/** The surface as real paths: what a link may lead to and stay inside. */
interface Surface {
  /** The bound scratch's real root. */
  readonly scratch?: Buffer;
  /** Each overlaid file's real absolute path, keyed, to its relative path. */
  readonly overlaid: ReadonlyMap<string, Buffer>;
  /** The materialised stdin's real path. */
  readonly stdin?: Buffer;
}

function realBytes(path: string | Buffer): Buffer {
  return realpathSync(typeof path === "string" ? Buffer.from(path) : path, { encoding: "buffer" }) as Buffer;
}

function parentAbsolute(path: Buffer): Buffer {
  const at = path.lastIndexOf(SLASH);
  return at <= 0 ? ROOT : path.subarray(0, at);
}

function childAbsolute(dir: Buffer, name: Buffer): Buffer {
  return dir.equals(ROOT) ? Buffer.concat([ROOT, name]) : beneath(dir, name);
}

/** The path of `absolute` below the scratch root (empty for the root
 * itself), or undefined when it is not there. */
function inScratch(surface: Surface, absolute: Buffer): Buffer | undefined {
  if (surface.scratch === undefined || !isWithin(surface.scratch, absolute)) return undefined;
  return absolute.length === surface.scratch.length ? Buffer.alloc(0) : absolute.subarray(surface.scratch.length + 1);
}

/** The snapshot entry at a real absolute path, when the surface holds one. */
function entryAt(surface: Surface, absolute: Buffer): { readonly to: RecheckInputNamespace; readonly path: Buffer } | undefined {
  const scratch = inScratch(surface, absolute);
  if (scratch !== undefined) return { to: "scratch", path: Buffer.from(scratch) };
  const overlaid = surface.overlaid.get(bytesKey(absolute));
  if (overlaid !== undefined) return { to: "files", path: overlaid };
  if (surface.stdin !== undefined && surface.stdin.equals(absolute)) return { to: "stdin", path: STDIN_PATH };
  return undefined;
}

/**
 * Where the link at `link` (a real absolute path: every directory above it
 * real) leads, followed as the kernel follows it (E1'): each `..` taken from
 * the real directory reached, each link on the way read and followed — and
 * each of those must itself be an entry of the snapshot, or the target
 * depends on something it does not hold. The result is the entry reached; a
 * place inside the bound scratch where nothing is (or below something that
 * is not a directory), when the rest of the target would stay there; or
 * outside, and why.
 */
function recheckInputReach(link: Buffer, surface: Surface): RecheckInputReach {
  let dir = parentAbsolute(link);
  let pending: Buffer[] = [];
  let hops = 0;
  const follow = (at: Buffer): RecheckInputReach | undefined => {
    hops += 1;
    if (hops > MAX_LINK_HOPS) return { outside: `it goes through more than ${MAX_LINK_HOPS} links` };
    const target = readlinkSync(at, { encoding: "buffer" }) as Buffer;
    if (target.length === 0) return { outside: "its target is empty" };
    if (target[0] === SLASH) dir = ROOT;
    pending = [...segments(target), ...pending];
    return undefined;
  };
  /** Nothing to read at `at` (absent, or below something that is not a
   * directory): inside when it lies in the bound scratch and the rest of the
   * target cannot climb out of it. */
  const nothingAt = (at: Buffer): RecheckInputReach => {
    const place = inScratch(surface, at);
    if (place !== undefined && !pending.some((part) => part.equals(DOT_DOT))) {
      const rest = pending.filter((part) => part.length > 0 && !part.equals(DOT)).reduce((path, part) => joinRelative(path, part), Buffer.alloc(0));
      return { to: "scratch", path: joinRelative(place, rest), absent: true };
    }
    return { outside: `it leads to ${JSON.stringify(displayPath(at).slice(0, 200))}, outside what was snapshotted, where nothing is` };
  };
  const first = follow(link);
  if (first !== undefined) return first;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name.length === 0 || name.equals(DOT)) continue;
    if (name.equals(DOT_DOT)) {
      dir = parentAbsolute(dir);
      continue;
    }
    const next = childAbsolute(dir, name);
    let entry: Stats | undefined;
    try {
      entry = lstatSync(next);
    } catch {
      entry = undefined;
    }
    if (entry === undefined) return nothingAt(next);
    if (entry.isSymbolicLink()) {
      if (entryAt(surface, next) === undefined) {
        return { outside: `it goes through the link ${JSON.stringify(displayPath(next).slice(0, 200))}, outside what was snapshotted` };
      }
      const stop = follow(next);
      if (stop !== undefined) return stop;
      continue;
    }
    // A path through something that is not a directory reads nothing.
    if (!entry.isDirectory() && pending.length > 0) return nothingAt(next);
    dir = next;
  }
  const reached = entryAt(surface, dir);
  if (reached !== undefined) return reached;
  return { outside: `it leads to ${JSON.stringify(displayPath(dir).slice(0, 200))}, outside what was snapshotted` };
}

/**
 * Snapshot one execution's inputs into `store` and return what the row
 * records. Called right before the execution starts; never throws. Three
 * passes: the walk finds every input and holds the bounds by `lstat` alone —
 * past one, nothing is read —, each link found is resolved against the
 * surface, then each file is read once, held to the size the walk found, and
 * kept under its digest.
 */
export function snapshotRecheckInputs(
  store: RecheckInputStore,
  source: RecheckInputsSource,
  bounds: RecheckInputBounds = RECHECK_INPUT_BOUNDS,
): RecheckInputsRecord {
  const found: Found[] = [];
  let bytes = 0;
  const admit = (item: Found) => {
    const size = item.type === "file" ? item.size : 0;
    if (found.length + 1 > bounds.entries) throw new Exceeded(`more than ${bounds.entries} entries`);
    if (bytes + size > bounds.bytes) throw new Exceeded(`more than ${bounds.bytes} bytes of files`);
    bytes += size;
    found.push(item);
  };
  const entries: RecheckInputEntry[] = [];
  let exceeded: string | undefined;
  const fence = typeof source.fence === "string" && source.fence.length > 0 ? source.fence : "unknown";
  try {
    const overlaid = new Map<string, Buffer>();
    let scratchRoot: SafeRoot | undefined;
    if (source.scratch !== undefined) {
      // The whole bound scratch (E1'): `.host` included. Walked below the
      // scratch as a root the host pinned (S1): a link in its place refuses
      // the snapshot, every directory below is listed through verified real
      // directories, and a link's own place is a real path.
      const root = source.scratchRoot ?? safeRoot(source.scratch, "the bound scratch");
      scratchRoot = root;
      walkBeneath(root, Buffer.alloc(0), (path, entry) => {
        if (entry.isDirectory()) {
          admit({ ns: "scratch", type: "dir", path, mode: Number(entry.mode) & 0o777 });
          return true;
        }
        if (entry.isFile()) admit({ ns: "scratch", type: "file", path, root, rel: path, mode: Number(entry.mode) & 0o777, size: Number(entry.size) });
        else if (entry.isSymbolicLink()) admit({ ns: "scratch", type: "link", path, absolute: beneath(root.path, path), target: readLinkBeneath(root, path, "snapshot") });
        else admit({ ns: "scratch", type: "other", path });
        return false;
      }, "snapshot");
    }
    if (source.copy !== undefined) {
      const copy = safeRoot(source.copy, "the recheck copy");
      for (const path of [...(source.overlaid ?? [])].sort(Buffer.compare)) {
        // Reached through real directories only (S1): a link an earlier run
        // — or the tree the copy was made from — put in a directory's place
        // is never followed out of the copy; such an input is recorded as one
        // that cannot be delivered.
        let entry: ReturnType<typeof lstatBeneath>;
        try {
          entry = lstatBeneath(copy, path, "snapshot");
        } catch (error) {
          if (!(error instanceof LinkSafetyError) || error.code === "root") throw error;
          admit({ ns: "files", type: "other", path });
          continue;
        }
        // Gone before this run: not among the inputs it ran with.
        if (entry === undefined) continue;
        const absolute = beneath(copy.path, path);
        overlaid.set(bytesKey(absolute), path);
        if (entry.isFile()) admit({ ns: "files", type: "file", path, root: copy, rel: path, mode: Number(entry.mode) & 0o777, size: Number(entry.size) });
        else if (entry.isSymbolicLink()) admit({ ns: "files", type: "link", path, absolute, target: readLinkBeneath(copy, path, "snapshot") });
        else admit({ ns: "files", type: "other", path });
      }
    }
    let stdinReal: Buffer | undefined;
    if (source.stdin !== undefined) {
      // The materialised stdin lies in the bound scratch (`.host/observe`),
      // and is read below that root like every other input of it; one the
      // host put anywhere else is read below its own directory, pinned.
      const name = Buffer.from(basename(source.stdin));
      const inScratch = scratchRoot === undefined ? undefined : relativeBeneath(scratchRoot, realBytes(dirname(source.stdin)));
      const stdinRoot = scratchRoot !== undefined && inScratch !== undefined ? scratchRoot : safeRoot(dirname(source.stdin), "the materialised stdin's directory");
      const stdinRel = inScratch === undefined ? name : joinRelative(inScratch, name);
      const entry = lstatBeneath(stdinRoot, stdinRel, "snapshot");
      if (entry === undefined || !entry.isFile()) throw new Error("the materialised stdin is not a regular file");
      stdinReal = beneath(stdinRoot.path, stdinRel);
      admit({ ns: "stdin", type: "file", path: STDIN_PATH, root: stdinRoot, rel: stdinRel, mode: Number(entry.mode) & 0o777, size: Number(entry.size) });
    }
    const surface: Surface = { ...(scratchRoot === undefined ? {} : { scratch: scratchRoot.path }), overlaid, ...(stdinReal === undefined ? {} : { stdin: stdinReal }) };
    // Within the bounds: every link resolved against the surface, every file
    // read once, as the walk found it, through its pinned root.
    for (const item of found) {
      if (item.type === "link") {
        entries.push({ ns: item.ns, type: "link", path: item.path, target: item.target, reach: recheckInputReach(item.absolute, surface) });
        continue;
      }
      if (item.type !== "file") {
        entries.push(item);
        continue;
      }
      const content = readBeneath(item.root, item.rel, "snapshot");
      if (content === undefined || content.length !== item.size) throw new Error(`an input changed while it was snapshotted (${item.ns})`);
      const digest = sha256Hex(content);
      if (!store.put(content, digest)) throw new Exceeded(`the run's input store is full (${store.limit} bytes)`);
      entries.push({ ns: item.ns, type: "file", path: item.path, mode: item.mode, bytes: content.length, sha256: digest });
    }
  } catch (error) {
    if (!(error instanceof Exceeded)) return { reason: `the inputs could not be snapshotted: ${errorText(error).slice(0, 200)}` };
    exceeded = error.message;
  }
  const snapshot: RecheckInputSnapshot = {
    ...(source.scratch === undefined ? {} : { scratch: source.scratch }),
    fence,
    ...(source.keep === undefined ? {} : { keep: source.keep }),
    bounds: { entries: bounds.entries, bytes: bounds.bytes },
    bounded: exceeded === undefined ? "within" : "exceeded",
    ...(exceeded === undefined ? {} : { exceeded }),
    entries: exceeded === undefined ? sortEntries(entries) : [],
  };
  const encoded = encodeRecheckInputs(snapshot);
  const digest = sha256Hex(encoded);
  const file = store.snapshotPath(digest);
  try {
    // The snapshot file counts against the store like its objects (D58b
    // V6): one that does not fit is not written, and the row says why.
    if (!store.putSnapshot(encoded, digest)) {
      return { reason: `the run's input store is full (${store.limit} bytes): the snapshot's own ${encoded.length} bytes do not fit` };
    }
  } catch (error) {
    return { reason: `the inputs' snapshot could not be written: ${errorText(error).slice(0, 200)}` };
  }
  const gaps = {
    ...(CONFINING_FENCES.has(fence) ? {} : { unconfined: fence }),
  };
  if (exceeded !== undefined) return { snapshot: digest, file, bounded: "exceeded", ...gaps };
  const outside = snapshot.entries.filter((entry) => entry.type === "link" && "outside" in entry.reach).length;
  return { snapshot: digest, file, entries: snapshot.entries.length, bytes, ...(outside === 0 ? {} : { outside }), ...gaps };
}

function sortEntries(entries: readonly RecheckInputEntry[]): RecheckInputEntry[] {
  return [...entries].sort((a, b) => NAMESPACE_ORDER[a.ns] - NAMESPACE_ORDER[b.ns] || Buffer.compare(a.path, b.path));
}

/** The snapshot file's bytes: one JSON document, every path and link target
 * in base64 — its exact bytes. */
export function encodeRecheckInputs(snapshot: RecheckInputSnapshot): Buffer {
  const b64 = (bytes: Buffer) => bytes.toString("base64");
  return Buffer.from(`${JSON.stringify({
    version: RECHECK_INPUTS_VERSION,
    ...(snapshot.scratch === undefined ? {} : { scratch: snapshot.scratch }),
    fence: snapshot.fence,
    ...(snapshot.keep === undefined
      ? {}
      : {
        keep: {
          kept: snapshot.keep.kept,
          skipped: snapshot.keep.skipped,
          ...(snapshot.keep.reason === undefined ? {} : { reason: snapshot.keep.reason }),
          ...(snapshot.keep.notOverlaid === undefined || snapshot.keep.notOverlaid === 0 ? {} : { not_overlaid: snapshot.keep.notOverlaid }),
        },
      }),
    bounds: { entries: snapshot.bounds.entries, bytes: snapshot.bounds.bytes },
    bounded: snapshot.bounded,
    ...(snapshot.exceeded === undefined ? {} : { exceeded: snapshot.exceeded }),
    entries: snapshot.entries.map((entry) => {
      const head = { ns: entry.ns, type: entry.type, path: b64(entry.path) };
      if (entry.type === "file") return { ...head, mode: entry.mode, bytes: entry.bytes, sha256: entry.sha256 };
      if (entry.type === "link") {
        const reach = "outside" in entry.reach
          ? { outside: entry.reach.outside }
          : { to: entry.reach.to, to_path: b64(entry.reach.path), ...(entry.reach.absent === true ? { absent: true } : {}) };
        return { ...head, target: b64(entry.target), ...reach };
      }
      if (entry.type === "dir") return { ...head, mode: entry.mode };
      return head;
    }),
  })}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNamespace = (value: unknown): value is RecheckInputNamespace => value === "scratch" || value === "files" || value === "stdin";

/** A snapshot file read back; throws when it is not one this build writes. */
export function decodeRecheckInputs(bytes: Buffer): RecheckInputSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("the inputs' snapshot is malformed: not JSON");
  }
  if (isObject(value) && value.version === 1) {
    throw new Error("the inputs' snapshot is of version 1, which left the scratch's `.host` out and resolved no link, so it does not show everything the run could read");
  }
  if (!isObject(value) || value.version !== RECHECK_INPUTS_VERSION || typeof value.fence !== "string" || !isObject(value.bounds)
    || !count(value.bounds.entries) || !count(value.bounds.bytes)
    || (value.bounded !== "within" && value.bounded !== "exceeded") || !Array.isArray(value.entries)
    || (value.scratch !== undefined && typeof value.scratch !== "string")) {
    throw new Error("the inputs' snapshot is malformed");
  }
  let keep: RecheckInputKeep | undefined;
  if (value.keep !== undefined) {
    const raw = value.keep;
    if (!isObject(raw) || typeof raw.kept !== "boolean" || !count(raw.skipped) || (raw.reason !== undefined && typeof raw.reason !== "string")
      || (raw.not_overlaid !== undefined && !count(raw.not_overlaid))) {
      throw new Error("the inputs' snapshot is malformed: its keep");
    }
    keep = {
      kept: raw.kept, skipped: raw.skipped,
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      ...(count(raw.not_overlaid) ? { notOverlaid: raw.not_overlaid } : {}),
    };
  }
  const seen = new Set<string>();
  const entries = value.entries.map((item): RecheckInputEntry => {
    if (!isObject(item) || !isNamespace(item.ns)) throw new Error("the inputs' snapshot is malformed: an entry");
    const ns = item.ns;
    const path = exactBase64(item.path);
    if (path === undefined) throw new Error("the inputs' snapshot is malformed: a path is not canonical base64");
    const key = `${ns}\u0000${bytesKey(path)}`;
    if (seen.has(key)) throw new Error("the inputs' snapshot is malformed: it lists a path twice");
    seen.add(key);
    if (item.type === "file") {
      if (!count(item.mode) || !count(item.bytes) || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(item.sha256)) {
        throw new Error("the inputs' snapshot is malformed: a file entry");
      }
      return { ns, type: "file", path, mode: item.mode, bytes: item.bytes, sha256: item.sha256 };
    }
    if (item.type === "link") {
      const target = exactBase64(item.target);
      if (target === undefined) throw new Error("the inputs' snapshot is malformed: a link target is not canonical base64");
      if (typeof item.outside === "string" && item.to === undefined && item.to_path === undefined && item.absent === undefined) {
        return { ns, type: "link", path, target, reach: { outside: item.outside } };
      }
      const to = exactBase64(item.to_path);
      if (item.outside !== undefined || !isNamespace(item.to) || to === undefined || (item.absent !== undefined && item.absent !== true)) {
        throw new Error("the inputs' snapshot is malformed: a link's reach");
      }
      return { ns, type: "link", path, target, reach: { to: item.to, path: to, ...(item.absent === true ? { absent: true as const } : {}) } };
    }
    if (item.type === "dir") {
      if (!count(item.mode)) throw new Error("the inputs' snapshot is malformed: a directory entry");
      return { ns, type: "dir", path, mode: item.mode };
    }
    if (item.type === "other") return { ns, type: "other", path };
    throw new Error("the inputs' snapshot is malformed: an entry of no known type");
  });
  return {
    ...(typeof value.scratch === "string" ? { scratch: value.scratch } : {}),
    fence: value.fence,
    ...(keep === undefined ? {} : { keep }),
    bounds: { entries: value.bounds.entries, bytes: value.bounds.bytes },
    bounded: value.bounded,
    ...(typeof value.exceeded === "string" ? { exceeded: value.exceeded } : {}),
    entries,
  };
}

/** The snapshot a row's record names, held to the digest the record carries,
 * and the store it lies in; throws what is wrong. */
export function readRecheckInputs(record: RecheckInputsRecord): { readonly snapshot: RecheckInputSnapshot; readonly store: RecheckInputStore } {
  if (record.snapshot === undefined || record.file === undefined) throw new Error("the recheck names no snapshot of its inputs");
  let bytes: Buffer;
  try {
    bytes = readRegularFile(record.file);
  } catch {
    throw new Error("the snapshot of its inputs is gone from the run's input store");
  }
  if (sha256Hex(bytes) !== record.snapshot) throw new Error("the snapshot of its inputs does not match the digest its row records");
  const snapshot = decodeRecheckInputs(bytes);
  return { snapshot, store: new RecheckInputStore(dirname(dirname(record.file))) };
}

/** A row's `inputs` field read back, or undefined when it is not one. */
export function recheckInputsRecordOf(value: unknown): RecheckInputsRecord | undefined {
  if (!isObject(value)) return undefined;
  const record: RecheckInputsRecord = {
    ...(typeof value.snapshot === "string" && /^[0-9a-f]{64}$/u.test(value.snapshot) ? { snapshot: value.snapshot } : {}),
    ...(typeof value.file === "string" ? { file: value.file } : {}),
    ...(count(value.entries) ? { entries: value.entries } : {}),
    ...(count(value.bytes) ? { bytes: value.bytes } : {}),
    ...(value.bounded === "exceeded" ? { bounded: "exceeded" as const } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(count(value.outside) && value.outside > 0 ? { outside: value.outside } : {}),
    ...(typeof value.unconfined === "string" ? { unconfined: value.unconfined } : {}),
  };
  return Object.keys(record).length === 0 ? undefined : record;
}

/**
 * Why a row's record of an execution's inputs cannot be that execution's
 * complete evidence (E1'), in the words a reason uses, `run` naming the
 * execution — empty when nothing on the record stands in the way: none
 * recorded, none taken, over its bounds, links that lead outside the surface,
 * a sandbox that does not confine reads to it. The delivery says these; the
 * open-set fold (recheck.ts) lets no `invalid` ruling close on a record that
 * has any.
 */
export function recheckInputsGaps(record: RecheckInputsRecord | undefined, run: string): string[] {
  if (record === undefined) return [`${run} recorded no snapshot of what it ran with`];
  if (record.reason !== undefined) return [`what ${run} ran with could not be snapshotted: ${record.reason.slice(0, 200)}`];
  const gaps: string[] = [];
  if (record.snapshot === undefined || record.file === undefined) gaps.push(`${run} recorded no snapshot of what it ran with`);
  if (record.bounded === "exceeded") gaps.push(`what ${run} ran with was over the snapshot's bounds, so it was not recorded`);
  if (record.unconfined !== undefined) gaps.push(unconfinedGap(record.unconfined, run));
  if ((record.outside ?? 0) > 0) gaps.push(`${record.outside} link(s) ${run} had lead outside what was snapshotted`);
  return gaps;
}

function unconfinedGap(fence: string, run: string): string {
  return `${run} ran in a sandbox that does not keep its reads to what was snapshotted (${fence}): what else it read is unknown`;
}

/** Why a snapshot read back cannot be its execution's complete evidence
 * (E1'), the snapshot's own account of it: the fence it ran in, and each
 * link that leads outside the surface (the first few named, then how many
 * more). Empty when nothing does. */
export function recheckSnapshotGaps(snapshot: RecheckInputSnapshot, run: string): string[] {
  const gaps: string[] = [];
  if (!CONFINING_FENCES.has(snapshot.fence)) gaps.push(unconfinedGap(snapshot.fence, run));
  const outside = snapshot.entries.flatMap((entry) => (entry.type === "link" && "outside" in entry.reach ? [{ entry, why: entry.reach.outside }] : []));
  for (const { entry, why } of outside.slice(0, 3)) {
    gaps.push(`the ${entry.ns === "files" ? "verifier file" : "scratch"} link ${JSON.stringify(displayPath(entry.path).slice(0, 200))} ${run} had leads outside what was snapshotted: ${why}`);
  }
  if (outside.length > 3) gaps.push(`${outside.length - 3} more link(s) ${run} had lead outside what was snapshotted`);
  return gaps;
}
