import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LinkSafetyError, listBeneath, lstatBeneath, readBeneath, readLinkBeneath, safeRoot, type SafeRoot } from "./link-safe-fs.ts";
import { beneath, exactUtf8 } from "./path-bytes.ts";

/**
 * SCRATCH (D48): every ledger session owns a scratch directory in its own
 * session directory, `<session dir>/scratch/`, beside its event log. It is the
 * place for fixtures and throwaway scripts: writable by the session's own
 * commands and by every host observation of its cases (the sandbox binds it at
 * its own path, sandbox.ts `scratchRoot`), exported to both as
 * DOKKABI_SCRATCH, and never inside the workspace — so nothing a session puts
 * there reaches the developer's repository, and it outlives a throwaway
 * verifier copy, so a later recheck finds it at the same path.
 *
 * The directory is created at boot (the ledger's workspace tools) and at the
 * first `check`; an observation only ever uses one that exists. A session
 * directory inside the workspace (a test fixture, a log kept in the tree)
 * gets no scratch: there it would be part of the tree.
 *
 * The cap (D48b, design memo §99 T7): 256 MiB of file bytes and 10,000
 * entries (files, directories and links) in all. It is enforced where the
 * host writes into the directory on the model's behalf — a `check` call's
 * fixtures, stdin and output captures — which is refused, with a finding and
 * nothing recorded, when those writes would pass it. The model's own commands
 * write there freely; their files count toward the size, and above 80% of the
 * cap every `check` result says how full the directory is.
 *
 * Measuring is a walk of the directory, which costs what the directory holds
 * (6 ms for 300 case directories, 78 ms for 9,000 entries), so a meter
 * (ScratchMeter) walks it at most once every ceil(entries / 64) calls — about
 * 64 entries a call, amortized, whatever the session's length — and counts
 * the host's own writes exactly in between. The model's own writes since the
 * last walk are seen at the next one; a refusal is always measured afresh.
 *
 * THE MANIFEST (D56): a check may assert through a file in its session's
 * scratch — `sh "$DOKKABI_SCRATCH/checks/x.sh"` — so what the scratch held is
 * part of what the check ran with. Since D57 the evidence a later verifier
 * rules on is the snapshot taken before the run (recheck-inputs.ts; since
 * D57b the whole bound scratch, `.host` included), and this manifest, taken
 * after the run, is output data only. When the recheck observes a case whose source
 * session has a scratch, it records a manifest of that scratch as the case
 * ran (scratchManifest): every file, link and other entry below it but the
 * host's own `.host` directory (the content store and one observation's
 * captures), each path as its exact bytes, a file with its size, mode and
 * sha256, a link with its target's exact bytes. The walk never follows a
 * link and stops past SCRATCH_MANIFEST_BOUNDS; a manifest past them lists
 * nothing and says `bounded: "exceeded"`. It is written content-addressed
 * beside the run's own rounds log (writeScratchManifest) and the recheck row
 * names it. Nothing here gates: a scratch that cannot be read is recorded as
 * such, with the reason.
 */

/** The cap on one session's scratch directory. */
export interface ScratchLimits {
  /** Bytes of regular files (their size, as `ls -l` reports it). */
  readonly bytes: number;
  /** Files, directories and links below the scratch directory. */
  readonly entries: number;
}

export const SCRATCH_LIMITS: ScratchLimits = { bytes: 256 * 1024 * 1024, entries: 10_000 };

/** Above this share of either limit a `check` result reports the size. */
export const SCRATCH_WARN_FRACTION = 0.8;

/** A meter walks the directory at most once every ceil(entries / this) calls. */
export const SCRATCH_WALK_ENTRIES_PER_CALL = 64;

/** An amount of scratch: bytes and entries. */
export interface ScratchAmount {
  readonly bytes: number;
  readonly entries: number;
}

/** What a scratch directory holds. `complete` is false when the walk stopped
 * past a limit: the directory holds at least this much. */
export interface ScratchUsage extends ScratchAmount {
  readonly complete: boolean;
}

/** Walk `dir` without following links: the bytes of its regular files and
 * its entries, stopping as soon as either passes its limit. `visited` is the
 * number of entries the walk read. A directory the walk cannot read counts as
 * one entry. Never throws. S1 (D57c): the walk is relative to the scratch as
 * a root the host pinned, each directory listed through verified real
 * directories (link-safe-fs.ts), so a directory swapped for a link while it
 * walks is refused, never measured through; a scratch whose own place holds
 * a link is not measured at all (`complete: false`). */
export function measureScratch(dir: string, limits: ScratchLimits): ScratchUsage & { readonly visited: number } {
  let bytes = 0;
  let entries = 0;
  let visited = 0;
  const over = () => bytes > limits.bytes || entries > limits.entries;
  let root: SafeRoot;
  try {
    root = safeRoot(dir, "the session's scratch");
  } catch {
    return { bytes: 0, entries: 0, complete: false, visited: 0 };
  }
  // Names are read and joined as bytes (D57): a name that is not UTF-8 is
  // measured like any other, never lost to a lossy decode.
  const pending: Buffer[] = [Buffer.alloc(0)];
  while (pending.length > 0 && !over()) {
    const current = pending.pop()!;
    let names: Buffer[] | undefined;
    try {
      names = listBeneath(root, current, "measure");
    } catch {
      names = undefined;
    }
    if (names === undefined) continue;
    const base = current.length === 0 ? root.path : beneath(root.path, current);
    for (const name of names) {
      visited += 1;
      entries += 1;
      try {
        const entry = lstatSync(beneath(base, name));
        if (entry.isDirectory()) pending.push(current.length === 0 ? Buffer.from(name) : beneath(current, name));
        else if (entry.isFile()) bytes += entry.size;
      } catch {
        // Gone since the listing: counted as an entry only.
      }
      if (over()) break;
    }
  }
  return { bytes, entries, complete: !over(), visited };
}

const plus = (left: ScratchAmount, right: ScratchAmount): ScratchAmount => ({ bytes: left.bytes + right.bytes, entries: left.entries + right.entries });

/**
 * The scratch cap's meter for one session's directory: `admit` answers
 * whether a host write of `need` fits, `wrote` counts one the host made.
 * Usage is the last walk plus every host write counted since; a walk is due
 * once every ceil(entries / SCRATCH_WALK_ENTRIES_PER_CALL) admits (every
 * admit while the directory holds no more than that), and a write the
 * estimate would refuse is measured afresh before it is refused.
 */
export class ScratchMeter {
  private measured: ScratchUsage | undefined;
  private added: ScratchAmount = { bytes: 0, entries: 0 };
  private calls = 0;
  private every = 1;
  /** Walks made and entries they read — the meter's own cost. */
  readonly work = { walks: 0, visited: 0 };

  constructor(readonly dir: string, readonly limits: ScratchLimits = SCRATCH_LIMITS) {}

  /** Whether writing `need` keeps the directory within both limits, and the
   * usage it was judged against (before the write). */
  admit(need: ScratchAmount): { readonly ok: boolean; readonly usage: ScratchUsage } {
    this.calls += 1;
    let fresh = false;
    if (this.measured === undefined || this.calls >= this.every) {
      this.walk();
      fresh = true;
    }
    let usage = this.current();
    if (!this.fits(usage, need) && !fresh) {
      this.walk();
      usage = this.current();
    }
    return { ok: this.fits(usage, need), usage };
  }

  /** Count a write the host made since the last walk. */
  wrote(amount: ScratchAmount): void {
    this.added = plus(this.added, amount);
  }

  /** The usage as the meter knows it: the last walk plus the host's writes
   * since. */
  current(): ScratchUsage {
    const measured = this.measured ?? { bytes: 0, entries: 0, complete: true };
    return { ...plus(measured, this.added), complete: measured.complete };
  }

  private fits(usage: ScratchUsage, need: ScratchAmount): boolean {
    return usage.complete && usage.bytes + need.bytes <= this.limits.bytes && usage.entries + need.entries <= this.limits.entries;
  }

  private walk(): void {
    const { visited, ...usage } = measureScratch(this.dir, this.limits);
    this.measured = usage;
    this.added = { bytes: 0, entries: 0 };
    this.calls = 0;
    this.every = Math.max(1, Math.ceil(visited / SCRATCH_WALK_ENTRIES_PER_CALL));
    this.work.walks += 1;
    this.work.visited += visited;
  }
}

/** The larger share of the two limits the usage takes. */
export function scratchFraction(usage: ScratchAmount, limits: ScratchLimits): number {
  return Math.max(usage.bytes / limits.bytes, usage.entries / limits.entries);
}

const MIB = 1024 * 1024;
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;
const capText = (limits: ScratchLimits) =>
  `${limits.bytes % MIB === 0 ? `${limits.bytes / MIB} MiB` : mib(limits.bytes)}, ${limits.entries} entries`;

/** The finding a refused `check` returns — or a refused `property` (D58),
 * which also keeps the directories of its counterexamples. */
export function scratchCapFact(usage: ScratchUsage, need: ScratchAmount, limits: ScratchLimits, tool: "check" | "property" = "check"): string {
  const writes = tool === "check" ? "its fixtures, stdin and output captures" : "its fixtures, output captures and the counterexample directories it keeps";
  return `the session's scratch directory holds ${usage.complete ? "" : "more than "}${mib(usage.bytes)} in ${usage.entries} entries, `
    + `and this ${tool} writes up to ${mib(need.bytes)} and ${need.entries} entries there (${writes}), `
    + `past its cap (${capText(limits)}); nothing was recorded or run. Remove what you no longer need from $DOKKABI_SCRATCH and call ${tool} again`;
}

/** The note a `check` result carries above SCRATCH_WARN_FRACTION of the cap. */
export function scratchSizeFact(usage: ScratchUsage, limits: ScratchLimits): string {
  return `the session's scratch directory holds ${usage.complete ? "" : "more than "}${mib(usage.bytes)} in ${usage.entries} entries, `
    + `${Math.floor(scratchFraction(usage, limits) * 100)}% of its cap (${capText(limits)}); past the cap the host refuses a check, `
    + "which writes its fixtures and output captures there. Remove what you no longer need from $DOKKABI_SCRATCH";
}

/** The directory name, beside the session's event log. */
export const SCRATCH_DIR_NAME = "scratch";

/** The absolute path a session's scratch directory has, whether or not it
 * exists yet. */
export function sessionScratchPath(logPath: string): string {
  return join(dirname(resolve(logPath)), SCRATCH_DIR_NAME);
}

function canonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** True when `path` is `root` itself or lies under it. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The canonical scratch directory when it exists as a real directory outside
 * every given live root; undefined otherwise. Reads only. S1 (D57c): a link in
 * the scratch's own place — a session under a fence that confines by path can
 * replace the directory it was given — is never followed: that session has no
 * scratch until the directory is real again. */
export function existingSessionScratch(logPath: string, liveRoots: readonly string[] = []): string | undefined {
  const path = sessionScratchPath(logPath);
  let real: string;
  try {
    real = safeRoot(path, "the session's scratch").text;
  } catch {
    return undefined;
  }
  for (const root of liveRoots) {
    const realRoot = canonical(root) ?? resolve(root);
    if (within(realRoot, real) || within(resolve(root), path)) return undefined;
  }
  return real;
}

/** Create the session's scratch directory (when the session directory lies
 * outside the workspace) and return its canonical path. A replaying log
 * creates nothing and only reports what exists. Never throws: a directory that
 * cannot be made is a session without scratch. */
export function ensureSessionScratch(input: {
  readonly logPath: string;
  readonly workspaceRoot: string;
  readonly readOnly?: boolean;
}): string | undefined {
  const path = sessionScratchPath(input.logPath);
  const root = resolve(input.workspaceRoot);
  const realRoot = canonical(root) ?? root;
  const realSessionDir = canonical(dirname(path)) ?? dirname(path);
  if (within(root, path) || within(realRoot, join(realSessionDir, SCRATCH_DIR_NAME))) return undefined;
  if (input.readOnly !== true) {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      return undefined;
    }
  }
  return existingSessionScratch(input.logPath, [input.workspaceRoot]);
}

// --- the manifest of a scratch as a case ran with it (D56) ---------------------

/** The scratch's host-internal directory — the content store
 * (`.host/fixtures`) and one observation's captures (`.host/observe`) — left
 * out of every manifest. */
export const SCRATCH_HOST_DIR = ".host";

/** Where the recheck writes the manifests: beside the run's own rounds log,
 * `<rounds dir>/scratch-manifests/<sha256>.json`. */
export const SCRATCH_MANIFEST_DIR = "scratch-manifests";

export interface ScratchManifestBounds {
  /** Entries the walk reads — files, directories, links, anything else. */
  readonly entries: number;
  /** Bytes of regular files, together. */
  readonly bytes: number;
}

/** What one manifest covers, at most: 1,000 entries and 16 MiB of file
 * bytes. A checker's scratch holds scripts and fixtures; past this it holds
 * output or data. With the keep's bounds (verifier-files.ts: 2,000 files,
 * 20 MiB) one dispute's evidence alone always fits one verifier's evidence bound
 * (4,000 files, 64 MiB), and the walk and the hashing after each rechecked
 * case stay bounded. */
export const SCRATCH_MANIFEST_BOUNDS: Readonly<ScratchManifestBounds> = Object.freeze({
  entries: 1_000,
  bytes: 16 * 1024 * 1024,
});

/** One entry of a scratch manifest, its path the exact bytes below the root. */
export type ScratchManifestEntry =
  | { readonly type: "file"; readonly path: Buffer; readonly bytes: number; readonly mode: number; readonly sha256: string }
  | { readonly type: "link"; readonly path: Buffer; readonly target: Buffer }
  | { readonly type: "other"; readonly path: Buffer };

/** A scratch as one walk found it. */
export interface ScratchManifest {
  readonly root: string;
  readonly bounds: ScratchManifestBounds;
  /** `exceeded` when the walk stopped past a bound: then `entries` is empty. */
  readonly bounded: "within" | "exceeded";
  /** What the walk read: entries, and the bytes of regular files. */
  readonly walked: { readonly entries: number; readonly bytes: number };
  /** Every file, link and other entry, ordered by path bytes. A directory is
   * implied by the paths below it. */
  readonly entries: readonly ScratchManifestEntry[];
}

/** What a recheck row records of a case's source scratch (D56): the scratch,
 * the manifest file and its sha256, how many entries and file bytes it lists
 * — or that it was over the bounds, or why it could not be recorded. */
export interface ScratchManifestRecord {
  readonly root: string;
  readonly manifest?: string;
  readonly sha256?: string;
  readonly entries?: number;
  readonly bytes?: number;
  readonly bounded?: "exceeded";
  readonly reason?: string;
}

const SLASH = Buffer.from("/");
const HOST_DIR_BYTES = Buffer.from(SCRATCH_HOST_DIR);
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `root` joined with a relative path's exact bytes. */
export function scratchEntryPath(root: string, path: Buffer): Buffer {
  return Buffer.concat([Buffer.from(root), SLASH, path]);
}

/** A path's text when its bytes are UTF-8 (then the text is exact, a leading
 * U+FEFF kept — D57), else undefined. Display only (path-bytes.ts). */
export function exactText(bytes: Buffer): string | undefined {
  return exactUtf8(bytes);
}

/** The whole content of a regular file, opened without following a link at
 * its end (O_NONBLOCK: a FIFO there never blocks the host); throws when it is
 * not one. For the host's own directories; a path below a tree a session
 * could have written is read through link-safe-fs.ts (S1). */
export function readRegularFile(path: Buffer | string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile()) throw new Error("not a regular file");
    const out = Buffer.alloc(entry.size);
    let read = 0;
    while (read < out.length) {
      const got = readSync(fd, out, read, out.length - read, read);
      if (got === 0) break;
      read += got;
    }
    if (read !== out.length) throw new Error("the file changed while it was read");
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Walk `root` without following links and list what it holds but `.host`,
 * within `bounds`. Throws when the root or an entry cannot be read. S1
 * (D57c): relative to the scratch as a root the host pinned — a link in its
 * place, or a directory swapped for one while the walk runs, is refused,
 * never walked or read through. */
export function scratchManifest(root: string, bounds: ScratchManifestBounds = SCRATCH_MANIFEST_BOUNDS): ScratchManifest {
  let pinned: SafeRoot;
  try {
    pinned = safeRoot(root, "the scratch");
  } catch (error) {
    throw new Error(error instanceof LinkSafetyError && error.code === "link" ? "the scratch is a symbolic link" : "the scratch is not a directory");
  }
  const entries: ScratchManifestEntry[] = [];
  let walked = 0;
  let bytes = 0;
  const exceeded = () => walked > bounds.entries || bytes > bounds.bytes;
  const pending: Buffer[] = [Buffer.alloc(0)];
  while (pending.length > 0 && !exceeded()) {
    const rel = pending.pop()!;
    const names = listBeneath(pinned, rel, "read") ?? [];
    for (const name of names) {
      if (rel.length === 0 && name.equals(HOST_DIR_BYTES)) continue;
      const path = rel.length === 0 ? Buffer.from(name) : Buffer.concat([rel, SLASH, name]);
      walked += 1;
      if (exceeded()) break;
      const entry = lstatBeneath(pinned, path);
      if (entry === undefined) throw new Error("an entry is gone since the listing");
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        bytes += Number(entry.size);
        if (exceeded()) break;
        const content = readBeneath(pinned, path);
        if (content === undefined) throw new Error("an entry is gone since the listing");
        entries.push({ type: "file", path, bytes: content.length, mode: Number(entry.mode) & 0o777, sha256: sha256Hex(content) });
      } else if (entry.isSymbolicLink()) {
        entries.push({ type: "link", path, target: readLinkBeneath(pinned, path) });
      } else {
        entries.push({ type: "other", path });
      }
    }
  }
  const over = exceeded();
  return {
    root,
    bounds: { entries: bounds.entries, bytes: bounds.bytes },
    bounded: over ? "exceeded" : "within",
    walked: { entries: walked, bytes },
    entries: over ? [] : entries.sort((a, b) => Buffer.compare(a.path, b.path)),
  };
}

/** The manifest file's bytes: one JSON document, paths and link targets in
 * base64 (their exact bytes). */
export function encodeScratchManifest(manifest: ScratchManifest): Buffer {
  const b64 = (bytes: Buffer) => bytes.toString("base64");
  return Buffer.from(`${JSON.stringify({
    version: 1,
    root: manifest.root,
    excluded: [SCRATCH_HOST_DIR],
    bounds: { entries: manifest.bounds.entries, bytes: manifest.bounds.bytes },
    bounded: manifest.bounded,
    walked: { entries: manifest.walked.entries, bytes: manifest.walked.bytes },
    entries: manifest.entries.map((entry) => entry.type === "file"
      ? { type: "file", path: b64(entry.path), bytes: entry.bytes, mode: entry.mode, sha256: entry.sha256 }
      : entry.type === "link"
        ? { type: "link", path: b64(entry.path), target: b64(entry.target) }
        : { type: "other", path: b64(entry.path) }),
  })}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical base64 back to its bytes; anything else is malformed. */
function exactBytes(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("the scratch manifest is malformed: a path is not base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("the scratch manifest is malformed: a path is not canonical base64");
  return bytes;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A manifest file read back; throws when it is not one this build wrote. */
export function decodeScratchManifest(bytes: Buffer): ScratchManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("the scratch manifest is malformed: not JSON");
  }
  if (!isObject(value) || value.version !== 1 || typeof value.root !== "string" || !isObject(value.bounds) || !isObject(value.walked)
    || (value.bounded !== "within" && value.bounded !== "exceeded") || !Array.isArray(value.entries)
    || !count(value.bounds.entries) || !count(value.bounds.bytes) || !count(value.walked.entries) || !count(value.walked.bytes)) {
    throw new Error("the scratch manifest is malformed");
  }
  const entries = value.entries.map((item): ScratchManifestEntry => {
    if (!isObject(item)) throw new Error("the scratch manifest is malformed: an entry is not an object");
    const path = exactBytes(item.path);
    if (item.type === "file") {
      if (!count(item.bytes) || !count(item.mode) || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(item.sha256)) {
        throw new Error("the scratch manifest is malformed: a file entry");
      }
      return { type: "file", path, bytes: item.bytes, mode: item.mode, sha256: item.sha256 };
    }
    if (item.type === "link") return { type: "link", path, target: exactBytes(item.target) };
    if (item.type === "other") return { type: "other", path };
    throw new Error("the scratch manifest is malformed: an entry of no known type");
  });
  return {
    root: value.root,
    bounds: { entries: value.bounds.entries, bytes: value.bounds.bytes },
    bounded: value.bounded,
    walked: { entries: value.walked.entries, bytes: value.walked.bytes },
    entries,
  };
}

/**
 * Record the manifest of the scratch `root` into `dir` (the rounds log's
 * `scratch-manifests`), named by its own sha256, and return what the recheck
 * row records of it. Never throws: a scratch that cannot be walked, or a
 * manifest that cannot be written, is recorded with the reason.
 */
export function writeScratchManifest(root: string, dir: string, bounds: ScratchManifestBounds = SCRATCH_MANIFEST_BOUNDS): ScratchManifestRecord {
  let manifest: ScratchManifest;
  try {
    manifest = scratchManifest(root, bounds);
  } catch (error) {
    return { root, reason: `the scratch could not be read: ${errorText(error).slice(0, 200)}` };
  }
  const bytes = encodeScratchManifest(manifest);
  const digest = sha256Hex(bytes);
  const file = join(dir, `${digest}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let present = false;
    try {
      present = sha256Hex(readFileSync(file)) === digest;
    } catch {
      present = false;
    }
    if (!present) {
      // Written whole under another name, then renamed: a reader never sees
      // half of it.
      const partial = `${file}.${process.pid}.partial`;
      writeFileSync(partial, bytes, { mode: 0o600 });
      renameSync(partial, file);
      if (sha256Hex(readFileSync(file)) !== digest) {
        rmSync(file, { force: true });
        throw new Error("the manifest was not written whole");
      }
    }
  } catch (error) {
    return { root, reason: `the scratch manifest could not be written: ${errorText(error).slice(0, 200)}` };
  }
  if (manifest.bounded === "exceeded") return { root, manifest: file, sha256: digest, bounded: "exceeded" };
  const fileBytes = manifest.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.bytes : 0), 0);
  return { root, manifest: file, sha256: digest, entries: manifest.entries.length, bytes: fileBytes };
}

/** The manifest a record names, held to the digest the record carries;
 * throws what is wrong with it. */
export function readScratchManifest(record: ScratchManifestRecord): ScratchManifest {
  if (record.manifest === undefined || record.sha256 === undefined) throw new Error("the recheck names no manifest of it");
  let bytes: Buffer;
  try {
    bytes = readFileSync(record.manifest);
  } catch {
    throw new Error("the recheck's manifest of it is gone");
  }
  if (sha256Hex(bytes) !== record.sha256) throw new Error("the recheck's manifest of it does not match the digest its row records");
  return decodeScratchManifest(bytes);
}

/** A row's `scratch` field read back, or undefined when it is not one. */
export function scratchManifestRecordOf(value: unknown): ScratchManifestRecord | undefined {
  if (!isObject(value) || typeof value.root !== "string") return undefined;
  return {
    root: value.root,
    ...(typeof value.manifest === "string" ? { manifest: value.manifest } : {}),
    ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
    ...(count(value.entries) ? { entries: value.entries } : {}),
    ...(count(value.bytes) ? { bytes: value.bytes } : {}),
    ...(value.bounded === "exceeded" ? { bounded: "exceeded" as const } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}
