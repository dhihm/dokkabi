import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { projectEnvironmentDirs } from "../host/environment-facts.ts";
import { EventLog } from "../host/event-log.ts";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import { trustedGitMetadata } from "../host/sandbox-docker.ts";
import type { EventRecord } from "../host/schema.ts";
import { shellQuote } from "./case-launch.ts";
import {
  chmodBeneath,
  createExclusiveBeneath,
  directoryChainState,
  ensureDirBeneath,
  LinkSafetyError,
  listBeneath,
  lstatBeneath,
  openBeneath,
  readBeneath,
  readLinkBeneath,
  renameBeneath,
  rmdirBeneath,
  rootIntact,
  safeRoot,
  symlinkBeneath,
  unlinkBeneath,
  writeBeneath,
  type OpenedFile,
  type SafeRoot,
} from "./link-safe-fs.ts";
import {
  ancestorsOf,
  beneath,
  bytesKey,
  bytesOfKey,
  displayPath,
  exactBase64,
  exactUtf8,
  isPlainRelative,
  isWithin,
  joinNul,
  lastSegmentIs,
  parentOf,
  segments,
  splitNul,
} from "./path-bytes.ts";

/**
 * UNFINISHED FIX (D54, design memo §106 Q2): the developer's tree as it was
 * before a fix stage, kept so a person can go back to it.
 *
 * A fix session works in the developer's workspace itself. One that stops
 * without finishing — a provider failure mid-edit, the wall — can leave the
 * tree worse than the delivery it was asked to repair, and nothing else
 * remembers what the tree was. So before every fix stage the orchestrator
 * saves, in the run's OWN session directory (`<build session>-rounds/fix-<round>/`):
 *
 * - `tracked.patch`: every change to tracked files against HEAD, staged or
 *   not, as `git diff --binary` writes it (binary files included), absent
 *   when there is none;
 * - `untracked.tar`: every untracked, non-ignored file (`git ls-files --others
 *   --exclude-standard`) — regular files with their mode and time, and
 *   symbolic links — absent when there is none.
 *
 * The project environments (the marker scan the base prune uses) are left
 * out of both and out of the restore: they are what a recorded case needs in
 * order to run, not the delivery, and they stay as they are.
 *
 * Git runs through the sealed host boundary with `--no-optional-locks`, only
 * `rev-parse`, `diff` and `ls-files`: the developer's tree, index, HEAD and
 * git are only read. Nothing restores on its own: the report prints where the
 * state is and the one command that brings the tree back
 * (preFixRestoreInvocation), and a person decides.
 *
 * The save is bounded (PRE_FIX_STATE_BOUNDS) and all or nothing: a state that
 * could not be kept whole is not kept at all, and the row says why — a
 * partial state would restore a tree that never existed. It never throws.
 *
 * THE RESTORE (D55): `dokkabi work --restore-pre-fix <dir>`, run inside the
 * workspace (restorePreFixState). The shell sequence D54 printed restored
 * tracked files first and failed half-way when a file staged as new at save
 * time had become untracked, leaving a mixed tree. The restore now works in
 * two phases. The PLAN touches nothing: it reads the state's row from the
 * run's own log beside `<dir>`, holds both saved files to their digests,
 * refuses unless HEAD is the saved HEAD, rebuilds the saved index in a
 * temporary index (the current index, reset to the saved HEAD outside the
 * environments, and the saved patch applied to it — a patch that does not
 * apply is a refusal), materialises the saved tracked files that differ and
 * reads the untracked archive, and classifies every current untracked file
 * by the SAVED ignore rules (`git check-ignore` over a probe tree of the
 * saved `.gitignore` files); it then preflights every path it will write,
 * move or clear, and refuses — having changed nothing — when it cannot
 * restore the tree whole. The APPLY holds `index.lock` throughout; it moves
 * every current file it will replace or remove (tracked, untracked, added by
 * the fix; never an ignored file the saved state does not cover, never an
 * environment) into a recovery directory beside the state, writes the saved
 * tree, installs the saved index, and verifies the result: HEAD, the index,
 * the tracked diff against HEAD byte for byte the saved patch, the untracked
 * files exactly the archive. On any failure once it has started it puts
 * everything back — written files removed, directories as they were, moved
 * files returned, the index restored — and says so.
 *
 * THE UNTRACKED MANIFEST (D56): the save also writes `untracked.manifest.json`,
 * independent of the tar codec: every archived path as its exact bytes, each
 * file's mode, size and sha256 (taken as the archive reads it), each link's
 * exact target. The restore holds the manifest to its digest, refuses when
 * the archive's members are not exactly the manifest's, and verifies the
 * written tree against the manifest. A state saved before D56 has none: it
 * restores with the archive check only, and says so.
 *
 * PATHS ARE BYTES (D57, R1): every path, name and link target is its exact
 * bytes from git's `-z` output to the file system and back — Buffer paths for
 * every fs call, the manifest in base64, every comparison on the bytes, git
 * given paths on stdin as bytes and asked to list names as the file system
 * holds them (`core.precomposeunicode=false`). The tar codec reads and writes
 * the name, link name and pax values as bytes (`hdrcharset=BINARY` marks a
 * value that is not UTF-8, for other readers). Text is produced only for a
 * reason or a result line. D56 still decoded names to text on the way (a
 * strict decoder that drops a leading U+FEFF redirected a link while the
 * restore reported success) and skipped what did not decode; now nothing is
 * decoded and nothing is skipped for its bytes. Old states — with a D56
 * manifest or none — read as they were written.
 *
 * EVERY RECORDED ATTRIBUTE, EXACTLY (D57b, R1'): a saved untracked entry is
 * its presence, its type, and for a file its full mode (`& 0o7777`: the
 * setuid, setgid and sticky bits with the permission bits), its size and its
 * content's sha256, for a link its exact target bytes (SavedEntryAttributes).
 * One comparator (sameEntryAttributes) holds every one of them exactly, and
 * it is the only one: the plan holds the archive's members to the manifest
 * with it, the write decision leaves a path as it is only when the tree holds
 * all of them (never "already present" on the low mode bits, or on the
 * content alone), and the verification holds the written tree to the
 * manifest — or, for a state without one, the archive — with it, reading the
 * tree without following a link (entryAttributesAt). A restore with nothing
 * to write is verified all the same before it says `restored`. A link's own
 * permission bits are not an attribute: no supported file system honours
 * them for access and Linux cannot set them, so the save writes every link
 * member with mode 0777 and the manifest has none. A file's time rides in the
 * archive for other tar readers and is given back to a file the restore
 * writes, but the state is not held to it: the manifest has none. Tracked
 * files are what git records of them — content, the executable bit, the
 * type — held through the patch and the index byte for byte; mode bits git
 * does not record are not part of the saved state, and neither is a
 * directory's mode (a directory is implied by the paths below it).
 */

/** The event name of the row the run's own log records for each fix stage. */
export const PRE_FIX_STATE_ROW = "rounds/pre_fix_state";

export const PRE_FIX_PATCH_FILE = "tracked.patch";
export const PRE_FIX_ARCHIVE_FILE = "untracked.tar";
/** The untracked state apart from the tar codec (D56). */
export const PRE_FIX_MANIFEST_FILE = "untracked.manifest.json";

export interface PreFixStateBounds {
  /** The tracked diff, in bytes. */
  readonly patchBytes: number;
  /** Untracked entries (files and links). */
  readonly untrackedFiles: number;
  /** The untracked regular files' bytes, together. */
  readonly untrackedBytes: number;
}

/** What is kept, at most: a tracked diff of 8 MiB (the sealed git boundary's
 * own output bound), and 5,000 untracked files of 64 MiB together. A tree past
 * these holds data or output, not a delivery a person restores by hand; the
 * row says it was not saved and why. */
export const PRE_FIX_STATE_BOUNDS: Readonly<PreFixStateBounds> = Object.freeze({
  patchBytes: 8 * 1024 * 1024,
  untrackedFiles: 5_000,
  untrackedBytes: 64 * 1024 * 1024,
});

/** One fix stage's pre-fix state, as saved and as its row reads back. */
export interface PreFixState {
  /** The fix round it precedes. */
  readonly round: number;
  /** Whether the whole state was kept. */
  readonly saved: boolean;
  /** Why not, when it was not. */
  readonly reason?: string;
  /** The developer's workspace root the state is of. */
  readonly workspace?: string;
  /** Where it is: `<build session>-rounds/fix-<round>`. */
  readonly dir?: string;
  /** The commit the tracked diff is against. */
  readonly head?: string;
  /** `tracked.patch`, when any tracked file differed from HEAD. */
  readonly patch?: { readonly bytes: number; readonly sha256: string };
  /** `untracked.tar`, when any untracked file or link was there, with the
   * untracked `.gitignore` files among them (`ignore_files`, shown): with the
   * tracked ones they are the saved ignore rules, by which the restore
   * decides what is ignored and kept. */
  readonly archive?: { readonly files: number; readonly bytes: number; readonly sha256: string; readonly ignore_files?: readonly string[] };
  /** `untracked.manifest.json` (D56): every archived path's exact bytes, a
   * file's mode, size and sha256, a link's exact target — how many entries
   * and the file's sha256. Absent in a state saved before D56. */
  readonly manifest?: { readonly entries: number; readonly sha256: string };
  /** Untracked entries that could not be kept — neither a regular file nor a
   * link (a socket, a nested repository), or not readable as listed: counted
   * here when there are any. */
  readonly skipped?: number;
  /** The project environments left out (workspace-relative directories). */
  readonly environments?: readonly string[];
}

const GIT_STEP_MAX_MS = 120_000;
const READ_CHUNK_BYTES = 64 * 1024;
const BLOCK = 512;
const GIT_DIR_BYTES = Buffer.from(".git");
/** The mode every link member is written with: a link's own permission bits
 * are not an attribute of the saved state (R1'). */
const LINK_MODE = 0o777;
/** The mode bits a saved file's mode may hold: permissions, setuid, setgid,
 * sticky. */
const FULL_MODE = 0o7777;
const GITIGNORE_BYTES = Buffer.from(".gitignore");
const SLASH = 0x2f;

/** Git lists and matches names as the file system holds them (D57): never a
 * precomposed spelling of a decomposed name. */
const EXACT_NAMES = ["-c", "core.precomposeunicode=false"] as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The directory of one fix stage's pre-fix state. */
export function preFixStateDir(runDir: string, round: number): string {
  return join(runDir, `fix-${round}`);
}

/** Git through the sealed boundary, read-only (`--no-optional-locks`). */
function readGit(root: string, args: readonly string[], timeoutMs: number) {
  // The developer's index is state this save keeps as data and a restore
  // puts back (I2, D57g: named, never an authority for coverage).
  return spawnSealedHostGit(root, ["--no-optional-locks", ...EXACT_NAMES, ...args], { timeoutMs, treeIndex: "state-as-data" });
}

function gitDetail(result: { stdout: Buffer; stderr: Buffer }): string {
  return `${result.stderr.toString()}${result.stdout.toString()}`.replace(/\s+/gu, " ").trim().slice(0, 200);
}

/** Whether the sealed boundary killed a git step for its output bound. */
function overOutputBound(result: { exitCode: number | null }): boolean {
  return (result as { exitedDueToMaxBuffer?: boolean }).exitedDueToMaxBuffer === true;
}

/** One untracked entry to archive: its exact path and, for a link, its exact
 * target. */
interface ArchiveEntry {
  readonly path: Buffer;
  readonly link?: Buffer;
  readonly size: number;
  readonly mode: number;
  readonly mtime: number;
}

/**
 * Save the pre-fix state of `workspaceRoot` under `dir` (replacing whatever
 * an earlier save left there). Returns what was kept, or why nothing was.
 */
export function savePreFixState(input: {
  readonly workspaceRoot: string;
  readonly dir: string;
  readonly round: number;
  readonly bounds?: PreFixStateBounds;
  readonly timeoutMs?: number;
}): PreFixState {
  const { workspaceRoot, dir, round } = input;
  const bounds = input.bounds ?? PRE_FIX_STATE_BOUNDS;
  const timeoutMs = Math.max(1, Math.min(GIT_STEP_MAX_MS, input.timeoutMs ?? GIT_STEP_MAX_MS));
  const base = { round, workspace: workspaceRoot, dir };
  const notSaved = (reason: string): PreFixState => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing more to take back; the row says it was not saved.
    }
    return { ...base, saved: false, reason };
  };
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return notSaved(`the state directory could not be prepared: ${message(error).slice(0, 200)}`);
  }

  let head: string;
  try {
    const result = readGit(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], timeoutMs);
    head = result.stdout.toString().trim();
    if ((result.exitCode ?? 1) !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(head)) {
      return notSaved("the workspace has no commit to save its changes against (HEAD)");
    }
  } catch (error) {
    return notSaved(`the workspace is not a git repository the host can read: ${message(error).slice(0, 200)}`);
  }

  // The project environments are neither saved nor restored: they are what
  // a recorded case needs in order to run at all, not the delivery.
  const environments = projectEnvironmentDirs(workspaceRoot);
  const environmentBytes = environments.map((env) => Buffer.from(env));
  // The tracked changes: one binary-safe diff against HEAD, staged and
  // unstaged alike, outside the environments, spelled so `git apply` takes it
  // whatever the repository's own diff settings say.
  let patch: PreFixState["patch"];
  try {
    const result = trackedDiff(workspaceRoot, head, environments, timeoutMs);
    if (overOutputBound(result) || result.stdout.length > bounds.patchBytes) {
      return notSaved(`the tracked changes' diff is larger than ${bounds.patchBytes} bytes`);
    }
    if ((result.exitCode ?? 1) !== 0) return notSaved(`the tracked changes could not be read: ${gitDetail(result)}`);
    if (result.stdout.length > 0) {
      writeWhole(join(dir, PRE_FIX_PATCH_FILE), result.stdout);
      patch = { bytes: result.stdout.length, sha256: createHash("sha256").update(result.stdout).digest("hex") };
    }
  } catch (error) {
    return notSaved(`the tracked changes could not be saved: ${message(error).slice(0, 200)}`);
  }

  // The untracked, non-ignored files, outside the project environments, each
  // path as the exact bytes git listed (D56, D57).
  let listed: Buffer[];
  try {
    const result = readGit(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"], timeoutMs);
    if (overOutputBound(result)) return notSaved("the untracked files' list is larger than the host git output bound");
    if ((result.exitCode ?? 1) !== 0) return notSaved(`the untracked files could not be listed: ${gitDetail(result)}`);
    listed = splitNul(result.stdout);
  } catch (error) {
    return notSaved(`the untracked files could not be listed: ${message(error).slice(0, 200)}`);
  }
  let root: SafeRoot;
  let own: Buffer | undefined;
  try {
    // The workspace as a root the host pinned (S1, D57c): the developer's
    // tree is one a fix session writes, so every path below it is read
    // without following a link — and a link in the workspace's own place is
    // refused, never saved from.
    root = safeRoot(workspaceRoot, "the workspace");
    // This state's own directory, when it lies inside the workspace: never
    // part of the tree it saves.
    const inside = relative(root.text, realpathSync(dir));
    own = inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : Buffer.from(inside.split(sep).join("/"));
  } catch (error) {
    return notSaved(`the workspace could not be resolved: ${message(error).slice(0, 200)}`);
  }
  const entries: ArchiveEntry[] = [];
  let skipped = 0;
  let bytes = 0;
  for (const listedPath of listed) {
    // A nested repository is listed as a directory (`dir/`): not a file or a
    // link, so it is counted as skipped below, as before.
    const path = isDirectoryListing(listedPath) ? listedPath.subarray(0, -1) : listedPath;
    if (environmentBytes.some((env) => isWithin(env, path))) continue;
    // git lists plain repository-relative paths; anything else, or anything
    // inside this state's own directory, is not the tree's.
    if (!isPlainRelative(path) || (own !== undefined && isWithin(own, path))) continue;
    let entry: ReturnType<typeof lstatBeneath>;
    try {
      // Every directory above it real (S1): a path that reaches the entry
      // only through a link is not the tree's to save.
      entry = lstatBeneath(root, path, "save");
    } catch {
      entry = undefined;
    }
    if (entry === undefined) {
      skipped += 1; // listed, but not readable under that name
      continue;
    }
    const mtime = Math.max(0, Math.floor(Number(entry.mtimeMs) / 1_000));
    if (entry.isFile()) {
      // The full mode (R1'): setuid, setgid and sticky with the permission bits.
      entries.push({ path: Buffer.from(path), size: Number(entry.size), mode: Number(entry.mode) & 0o7777, mtime });
      bytes += Number(entry.size);
    } else if (entry.isSymbolicLink()) {
      try {
        // A link's own mode is not an attribute (R1'): written as 0777.
        entries.push({ path: Buffer.from(path), link: readLinkBeneath(root, path, "save"), size: 0, mode: LINK_MODE, mtime });
      } catch {
        skipped += 1;
      }
    } else {
      skipped += 1;
    }
  }
  if (entries.length > bounds.untrackedFiles || bytes > bounds.untrackedBytes) {
    return notSaved(`${entries.length} untracked files of ${bytes} bytes are over the bound of ${bounds.untrackedFiles} files and ${bounds.untrackedBytes} bytes`);
  }
  let archive: PreFixState["archive"];
  let digests = new Map<string, string>();
  if (entries.length > 0) {
    try {
      const written = writeTarArchive(root, entries, join(dir, PRE_FIX_ARCHIVE_FILE));
      digests = written.digests;
      const ignoreFiles = entries
        .filter((item) => item.link === undefined && lastSegmentIs(item.path, GITIGNORE_BYTES))
        .map((item) => displayPath(item.path));
      archive = { files: entries.length, bytes: written.bytes, sha256: written.sha256, ...(ignoreFiles.length > 0 ? { ignore_files: ignoreFiles } : {}) };
    } catch (error) {
      return notSaved(`the untracked files could not be archived: ${message(error).slice(0, 200)}`);
    }
  }
  // The untracked state apart from the tar codec (D56): what the restore
  // verifies the written tree against — the very bytes git listed and the
  // file system holds (D57). Written for every state, empty or not.
  let manifest: PreFixState["manifest"];
  try {
    const encoded = encodeUntrackedManifest(entries.map((item): UntrackedManifestEntry => item.link === undefined
      ? { type: "file", path: item.path, mode: item.mode, bytes: item.size, sha256: digests.get(bytesKey(item.path))! }
      : { type: "link", path: item.path, target: item.link }));
    writeWhole(join(dir, PRE_FIX_MANIFEST_FILE), encoded);
    manifest = { entries: entries.length, sha256: sha256Of(encoded) };
  } catch (error) {
    return notSaved(`the untracked manifest could not be written: ${message(error).slice(0, 200)}`);
  }
  return {
    ...base,
    saved: true,
    head,
    ...(patch === undefined ? {} : { patch }),
    ...(archive === undefined ? {} : { archive }),
    manifest,
    ...(skipped > 0 ? { skipped } : {}),
    environments: [...environments],
  };
}

/** The pathspec of the whole workspace but its project environments. */
function workspacePathspec(environments: readonly string[]): string[] {
  return [".", ...environments.map((dir) => `:(exclude,literal)${dir}`)];
}

/** The tracked diff the save keeps and the restore verifies against it:
 * every tracked file against `head`, outside the environments, binary-safe
 * and spelled for `git apply` whatever the repository's diff settings. */
function trackedDiff(root: string, head: string, environments: readonly string[], timeoutMs: number) {
  return readGit(root, [
    "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.suppressBlankEmpty=false",
    "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--ignore-submodules=all", "--src-prefix=a/", "--dst-prefix=b/", head, "--", ...workspacePathspec(environments),
  ], timeoutMs);
}

function writeWhole(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(fd);
  }
}

// --- the untracked manifest (D56) ----------------------------------------------

/** One untracked entry as the manifest records it: its path's exact bytes, a
 * file's mode, size and sha256, a link's exact target. */
export type UntrackedManifestEntry =
  | { readonly type: "file"; readonly path: Buffer; readonly mode: number; readonly bytes: number; readonly sha256: string }
  | { readonly type: "link"; readonly path: Buffer; readonly target: Buffer };

/** The manifest file: JSON, paths and targets in base64, ordered by path
 * bytes. */
export function encodeUntrackedManifest(entries: readonly UntrackedManifestEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.path, b.path));
  return Buffer.from(`${JSON.stringify({
    version: 1,
    entries: sorted.map((entry) => entry.type === "file"
      ? { type: "file", path: entry.path.toString("base64"), mode: entry.mode, bytes: entry.bytes, sha256: entry.sha256 }
      : { type: "link", path: entry.path.toString("base64"), target: entry.target.toString("base64") }),
  })}\n`);
}

/** The manifest read back; throws when it is not one the save writes. */
export function decodeUntrackedManifest(bytes: Buffer): UntrackedManifestEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("it is not JSON");
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error("it is not an untracked manifest");
  const exact = (text: unknown): Buffer => {
    if (typeof text !== "string") throw new Error("a path is not base64");
    const out = exactBase64(text);
    if (out === undefined) throw new Error("a path is not canonical base64");
    return out;
  };
  const count = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  const seen = new Set<string>();
  return value.entries.map((item): UntrackedManifestEntry => {
    if (!isRecord(item)) throw new Error("an entry is not an object");
    const path = exact(item.path);
    const key = bytesKey(path);
    if (seen.has(key)) throw new Error("it lists a path twice");
    seen.add(key);
    if (item.type === "file") {
      if (!count(item.mode) || !count(item.bytes) || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(item.sha256)) {
        throw new Error("a file entry is malformed");
      }
      return { type: "file", path, mode: item.mode, bytes: item.bytes, sha256: item.sha256 };
    }
    if (item.type === "link") return { type: "link", path, target: exact(item.target) };
    throw new Error("an entry has no known type");
  });
}

// --- the archive: POSIX ustar, with pax records for long names --------------
//
// Written here rather than by a `tar` binary so the bytes do not depend on the
// host's tar flavour or its metadata extensions; any POSIX tar reads it back.
// Names, link names and pax values are bytes throughout (D57).

function octal(value: number, length: number): string {
  const digits = Math.max(0, Math.floor(value)).toString(8);
  if (digits.length > length - 1) throw new Error("archive number out of range");
  return `${digits.padStart(length - 1, "0")}\u0000`;
}

function field(header: Buffer, offset: number, length: number, text: string | Buffer): void {
  const bytes = typeof text === "string" ? Buffer.from(text, "latin1") : text;
  if (bytes.length > length) throw new Error("archive field too long");
  bytes.copy(header, offset);
}

function ustarHeader(input: {
  readonly name: Buffer;
  readonly prefix: Buffer;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly type: "0" | "2" | "x";
  readonly linkname: Buffer;
}): Buffer {
  const header = Buffer.alloc(BLOCK);
  field(header, 0, 100, input.name);
  field(header, 100, 8, octal(input.mode, 8));
  field(header, 108, 8, octal(0, 8));
  field(header, 116, 8, octal(0, 8));
  field(header, 124, 12, octal(input.size, 12));
  field(header, 136, 12, octal(input.mtime, 12));
  header.fill(0x20, 148, 156);
  field(header, 156, 1, input.type);
  field(header, 157, 100, input.linkname);
  field(header, 257, 6, "ustar\u0000");
  field(header, 263, 2, "00");
  field(header, 345, 155, input.prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\u0000 `);
  return header;
}

/** A pax record `<length> <key>=<value>\n`, its length counting every byte of
 * itself; the value is written as its exact bytes. */
function paxRecord(key: string, value: Buffer): Buffer {
  const body = Buffer.byteLength(` ${key}=`) + value.length + 1;
  let digits = 1;
  while (String(body + digits).length > digits) digits += 1;
  return Buffer.concat([Buffer.from(`${body + digits} ${key}=`, "latin1"), value, Buffer.from("\n")]);
}

/** The ustar name/prefix split of a path's bytes, when one fits. */
function ustarName(path: Buffer): { name: Buffer; prefix: Buffer } | undefined {
  if (path.length <= 100) return { name: path, prefix: Buffer.alloc(0) };
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (path[index] !== SLASH) continue;
    const prefix = path.subarray(0, index);
    const name = path.subarray(index + 1);
    if (name.length > 0 && name.length <= 100 && prefix.length <= 155) return { name, prefix };
  }
  return undefined;
}

class ArchiveWriter {
  bytes = 0;
  constructor(private readonly fd: number, private readonly hash: Hash) {}
  write(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) offset += writeSync(this.fd, chunk, offset, chunk.length - offset);
    this.hash.update(chunk);
    this.bytes += chunk.length;
  }
  pad(length: number): void {
    const rest = (BLOCK - (length % BLOCK)) % BLOCK;
    if (rest > 0) this.write(Buffer.alloc(rest));
  }
}

/** Write the archive; returns its size and sha256, and each file's sha256 as
 * it was read into the archive — the manifest's digests (D56), keyed by the
 * path's bytes. Each file is read below the pinned workspace (S1). */
function writeTarArchive(root: SafeRoot, entries: readonly ArchiveEntry[], dest: string): { bytes: number; sha256: string; digests: Map<string, string> } {
  const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash("sha256");
  const out = new ArchiveWriter(fd, hash);
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  const digests = new Map<string, string>();
  try {
    for (const entry of [...entries].sort((a, b) => Buffer.compare(a.path, b.path))) {
      const split = ustarName(entry.path);
      const linkFits = entry.link === undefined || entry.link.length <= 100;
      const records: Buffer[] = [];
      if (split === undefined) records.push(paxRecord("path", entry.path));
      if (!linkFits) records.push(paxRecord("linkpath", entry.link!));
      // A value that is not UTF-8 is marked for other readers (POSIX
      // `hdrcharset`); this reader takes every value as bytes either way.
      const binary = (split === undefined && exactUtf8(entry.path) === undefined) || (!linkFits && exactUtf8(entry.link!) === undefined);
      if (binary) records.unshift(paxRecord("hdrcharset", Buffer.from("BINARY")));
      const placeholder = Buffer.from(`pax-${createHash("sha256").update(entry.path).digest("hex").slice(0, 32)}`);
      if (records.length > 0) {
        const body = Buffer.concat(records);
        out.write(ustarHeader({ name: placeholder, prefix: Buffer.alloc(0), mode: 0o644, size: body.length, mtime: entry.mtime, type: "x", linkname: Buffer.alloc(0) }));
        out.write(body);
        out.pad(body.length);
      }
      out.write(ustarHeader({
        name: split?.name ?? placeholder,
        prefix: split?.prefix ?? Buffer.alloc(0),
        mode: entry.mode,
        size: entry.link === undefined ? entry.size : 0,
        mtime: entry.mtime,
        type: entry.link === undefined ? "0" : "2",
        linkname: entry.link === undefined || !linkFits ? Buffer.alloc(0) : entry.link,
      }));
      if (entry.link !== undefined) continue;
      // The file as listed, never through a link that replaced it — or a
      // directory above it — since (S1).
      const source = openBeneath(root, entry.path, "save");
      if (source === undefined) throw new Error(`${displayPath(entry.path)} changed while it was being saved`);
      const own = createHash("sha256");
      try {
        // The file as opened is the one listed: a regular file of the size
        // and the full mode recorded for it (R1').
        if (source.size !== entry.size || (source.mode & FULL_MODE) !== entry.mode) {
          throw new Error(`${displayPath(entry.path)} changed while it was being saved`);
        }
        let left = entry.size;
        while (left > 0) {
          const read = readSync(source.fd, buffer, 0, Math.min(buffer.length, left), null);
          if (read <= 0) throw new Error(`${displayPath(entry.path)} changed while it was being saved`);
          out.write(buffer.subarray(0, read));
          own.update(buffer.subarray(0, read));
          left -= read;
        }
        source.verify();
      } finally {
        source.close();
      }
      digests.set(bytesKey(entry.path), own.digest("hex"));
      out.pad(entry.size);
    }
    out.write(Buffer.alloc(2 * BLOCK));
  } finally {
    closeSync(fd);
  }
  return { bytes: out.bytes, sha256: hash.digest("hex"), digests };
}

// --- the row, the report and the restore ------------------------------------

/** The row payload of one pre-fix state. */
export function preFixStatePayload(state: PreFixState): Record<string, unknown> {
  return {
    round: state.round,
    saved: state.saved,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    ...(state.workspace === undefined ? {} : { workspace: state.workspace }),
    ...(state.dir === undefined ? {} : { dir: state.dir }),
    ...(state.head === undefined ? {} : { head: state.head }),
    ...(state.patch === undefined ? {} : { patch: { file: PRE_FIX_PATCH_FILE, ...state.patch } }),
    ...(state.archive === undefined ? {} : { archive: { file: PRE_FIX_ARCHIVE_FILE, ...state.archive } }),
    ...(state.manifest === undefined ? {} : { manifest: { file: PRE_FIX_MANIFEST_FILE, ...state.manifest } }),
    ...(state.skipped === undefined ? {} : { skipped: state.skipped }),
    ...(state.environments === undefined ? {} : { environments: [...state.environments] }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The pre-fix state rows of a run's log, in the order they were recorded. */
export function preFixStatesFromEvents(events: readonly EventRecord[]): PreFixState[] {
  const states: PreFixState[] = [];
  for (const event of events) {
    if (event.name !== PRE_FIX_STATE_ROW) continue;
    const p = event.payload;
    if (typeof p.round !== "number" || typeof p.saved !== "boolean") continue;
    const patch = isRecord(p.patch) && typeof p.patch.bytes === "number" && typeof p.patch.sha256 === "string"
      ? { bytes: p.patch.bytes, sha256: p.patch.sha256 }
      : undefined;
    const archive = isRecord(p.archive) && typeof p.archive.files === "number" && typeof p.archive.bytes === "number" && typeof p.archive.sha256 === "string"
      ? {
        files: p.archive.files, bytes: p.archive.bytes, sha256: p.archive.sha256,
        ...(Array.isArray(p.archive.ignore_files)
          ? { ignore_files: p.archive.ignore_files.filter((item): item is string => typeof item === "string") }
          : {}),
      }
      : undefined;
    const manifest = isRecord(p.manifest) && typeof p.manifest.entries === "number" && typeof p.manifest.sha256 === "string"
      ? { entries: p.manifest.entries, sha256: p.manifest.sha256 }
      : undefined;
    states.push({
      round: p.round,
      saved: p.saved,
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      ...(typeof p.workspace === "string" ? { workspace: p.workspace } : {}),
      ...(typeof p.dir === "string" ? { dir: p.dir } : {}),
      ...(typeof p.head === "string" ? { head: p.head } : {}),
      ...(patch === undefined ? {} : { patch }),
      ...(archive === undefined ? {} : { archive }),
      ...(manifest === undefined ? {} : { manifest }),
      ...(typeof p.skipped === "number" ? { skipped: p.skipped } : {}),
      ...(Array.isArray(p.environments) ? { environments: p.environments.filter((item): item is string => typeof item === "string") } : {}),
    });
  }
  return states;
}


// --- the report line ------------------------------------------------------------

/** The one command that brings the workspace back to a saved pre-fix state
 * (D55), or undefined when none was saved: `dokkabi work --restore-pre-fix
 * '<dir>'`, run inside the workspace. */
export function preFixRestoreInvocation(state: PreFixState): string | undefined {
  if (!state.saved || state.workspace === undefined || state.dir === undefined || state.head === undefined) return undefined;
  return `dokkabi work --restore-pre-fix ${shellQuote(state.dir)}`;
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The report lines of one pre-fix state: where it is and the command that
 * restores it (and where to run it), or that it was not saved and why. */
export function formatPreFixLines(state: PreFixState): string[] {
  const restore = preFixRestoreInvocation(state);
  if (restore === undefined) return [`pre-fix state round=${state.round} not saved: ${oneLine(state.reason ?? "no state was recorded")}`];
  const skipped = state.skipped ?? 0;
  return [
    `pre-fix state round=${state.round} dir=${state.dir} tracked_bytes=${state.patch?.bytes ?? 0} untracked_files=${state.archive?.files ?? 0}` +
      `${skipped > 0 ? ` untracked_skipped=${skipped}` : ""}`,
    `- restore (run inside ${shellQuote(state.workspace!)}): ${restore}`,
  ];
}

// --- the restore (D55) ------------------------------------------------------------

/** The run's own log a state directory lies beside: `<run dir>/events.jsonl`
 * for `<run dir>/fix-<round>`. */
export function preFixStateLogPath(dir: string): string {
  return join(dirname(resolve(dir)), "events.jsonl");
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The recorded state whose directory is `dir`: the last `rounds/pre_fix_state`
 * row of the run's own log beside it that names it; undefined when none
 * does. Throws when the log cannot be read. */
export function readPreFixState(dir: string): PreFixState | undefined {
  const path = preFixStateLogPath(dir);
  if (!existsSync(path)) return undefined;
  const want = canonicalPath(dir);
  return preFixStatesFromEvents(new EventLog(path, { readOnly: true }).events)
    .reverse()
    .find((state) => state.dir !== undefined && canonicalPath(state.dir) === want);
}

/** What one restore did. */
export interface PreFixRestoreResult {
  /** restored: the tree is the saved state; refused: nothing was changed;
   * failed: it started, failed, and put back what it could. */
  readonly status: "restored" | "refused" | "failed";
  readonly dir: string;
  readonly round?: number;
  readonly workspace?: string;
  readonly reason?: string;
  /** Where the files it replaced or removed were moved (restored), or where
   * the ones it could not put back are (failed). */
  readonly recovery?: string;
  /** Workspace-relative paths it moved to the recovery directory, and the
   * ones it wrote — shown (D57: the exact bytes are in the recovery
   * directory's `restore.json`). */
  readonly moved?: readonly string[];
  readonly written?: readonly string[];
  /** failed only: whether everything was put back as it was. */
  readonly rolledBack?: boolean;
  /** failed only: what could not be put back. */
  readonly left?: readonly string[];
  /** restored only (D56): what the untracked files were verified against —
   * the saved manifest, or, for a state saved before D56 without one, the
   * archive only. */
  readonly verified?: "manifest" | "archive";
}

/** A refusal while planning: nothing has been changed. */
class RestoreRefusal extends Error {}

/** The index and its lock, below the repository's git directory. */
const INDEX_REL = Buffer.from("index");
const INDEX_LOCK_REL = Buffer.from("index.lock");

/** The index's bytes, read as the file it is (S1); undefined when there is
 * none. A link, or anything but a regular file, in its place refuses. */
function readIndex(gitRoot: SafeRoot): Buffer | undefined {
  try {
    return readBeneath(gitRoot, INDEX_REL, "read");
  } catch (error) {
    throw new RestoreRefusal(`the index cannot be read as the file it is: ${message(error).slice(0, 200)}`);
  }
}

/** A point of the apply a caller may be told about before it happens: each
 * write, and the verification once the index is installed. A test makes one
 * throw to exercise the rollback; nothing else uses it. */
export type RestoreCheckpoint =
  | { readonly step: "write"; readonly path: string; readonly index: number }
  | { readonly step: "verify" };

/** One member of the untracked archive: its exact path and link target. */
interface ArchiveMember {
  readonly path: Buffer;
  readonly type: "file" | "link";
  readonly mode: number;
  readonly mtime: number;
  readonly data?: Buffer;
  readonly link?: Buffer;
}

/** One path the restore writes. */
interface RestoreWrite {
  readonly path: Buffer;
  readonly kind: "file" | "link";
  readonly data?: Buffer;
  readonly mode?: number;
  readonly link?: Buffer;
  /** Archive files keep the time they were saved with. */
  readonly mtime?: number;
}

/** Everything the apply needs, computed without changing anything. */
interface RestorePlan {
  readonly root: string;
  /** The workspace and the repository's git directory as roots the host
   * pinned (S1): every write, move and removal is below one of them. */
  readonly pinned: SafeRoot;
  readonly gitRoot: SafeRoot;
  readonly indexPath: string;
  /** The sha256 of the index file when the plan was made; undefined when
   * there was none. */
  readonly indexDigest?: string;
  /** The saved index, to install, and its `ls-files -s` listing (bytes). */
  readonly savedIndex: Buffer;
  readonly savedEntries: Buffer;
  readonly moves: readonly Buffer[];
  /** Directories standing where a file is written, emptied by the moves;
   * removed deepest first. */
  readonly clearDirs: readonly Buffer[];
  readonly writes: readonly RestoreWrite[];
  readonly archive: readonly ArchiveMember[];
  /** The saved untracked manifest (D56), when the state has one: what the
   * written tree is verified against. */
  readonly manifest?: readonly UntrackedManifestEntry[];
  /** The saved environments (the verify diff's pathspec) and every
   * environment now (the untracked verification's). */
  readonly savedEnvironments: readonly string[];
  readonly environments: readonly string[];
}

/** Git through the sealed boundary for the restore: `--no-optional-locks`,
 * names as the file system holds them, a temporary index when given, stdin
 * (text or exact bytes) when given. */
function restoreGit(
  root: string,
  args: readonly string[],
  options: { readonly index?: string; readonly input?: string | Buffer; readonly timeoutMs: number },
) {
  return spawnSealedHostGit(root, ["--no-optional-locks", ...EXACT_NAMES, ...args], {
    ...(options.index === undefined ? { treeIndex: "state-as-data" as const } : { extraEnv: { GIT_INDEX_FILE: options.index } }),
    ...(options.input === undefined ? {} : { input: options.input }),
    timeoutMs: options.timeoutMs,
  });
}

/** A git step that must succeed (exit codes in `ok`), or a refusal; its
 * output as text (never a path list: see mustGitBytes). */
function mustGit(
  what: string,
  result: ReturnType<typeof restoreGit>,
  ok: readonly number[] = [0],
): string {
  return mustGitBytes(what, result, ok).toString();
}

/** mustGit, its output as the exact bytes git wrote. */
function mustGitBytes(
  what: string,
  result: ReturnType<typeof restoreGit>,
  ok: readonly number[] = [0],
): Buffer {
  if (overOutputBound(result)) throw new RestoreRefusal(`${what}: the output is larger than the host git output bound`);
  if (!ok.includes(result.exitCode ?? -1)) throw new RestoreRefusal(`${what}: ${gitDetail(result) || `git exited ${String(result.exitCode)}`}`);
  return result.stdout;
}

/** The paths of `git ls-files -s -z` output: each record's bytes after its
 * tab. */
function stagedPaths(listing: Buffer): Buffer[] {
  return splitNul(listing).map((record) => record.subarray(record.indexOf(0x09) + 1));
}

function sha256Of(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether a relative path lies in the repository's own `.git`. */
function inGitDir(path: Buffer): boolean {
  return segments(path)[0]!.equals(GIT_DIR_BYTES);
}

/** Whether a listed path names a directory (git ends it with `/`). */
function isDirectoryListing(path: Buffer): boolean {
  return path.length > 0 && path[path.length - 1] === SLASH;
}

function lstatOrUndefined(path: string | Buffer): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** A path as one quoted item of a reason. */
function shownPath(bytes: Buffer): string {
  return JSON.stringify(displayPath(bytes).slice(0, 200));
}

/** Create the directories above `path` below `root` that are missing, one at
 * a time, never through a link. For the restore's own private temporary tree
 * only (the probe of the saved ignore rules): the workspace and the recovery
 * directory are written through link-safe-fs.ts (S1). */
function makeParents(root: string | Buffer, path: Buffer, mode: number): void {
  for (const above of ancestorsOf(path)) {
    const absolute = beneath(root, above);
    const entry = lstatOrUndefined(absolute);
    if (entry === undefined) mkdirSync(absolute, { mode });
    else if (!entry.isDirectory()) throw new Error(`${shownPath(above)} is not a directory`);
  }
}

/** The longest length field a pax record may have: a record is at most as
 * long as a header's body, and a body is bounded by the archive. */
const PAX_LENGTH_DIGITS_MAX = 12;

/**
 * The records of one pax extended header's body (D56), framed and advanced
 * on the bytes: each record is `<length> <key>=<value>\n`, its decimal length
 * counting every byte of the record — its own digits, the space and the
 * newline included; the newline must stand at exactly the byte that length
 * names. The key (a keyword) is read as text; the value is kept as its exact
 * bytes (D57) — a newline, a leading U+FEFF or bytes that are not UTF-8
 * included; nothing is trimmed or decoded — and an empty value removes its
 * key (POSIX). Malformed framing throws, and the restore refuses before
 * anything changes.
 */
export function readPaxRecords(body: Buffer): Map<string, Buffer> {
  const records = new Map<string, Buffer>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0 || space === at || space - at > PAX_LENGTH_DIGITS_MAX) {
      throw new Error(`an archive pax record at byte ${at} has no length`);
    }
    const digits = body.subarray(at, space).toString("latin1");
    if (!/^[1-9][0-9]*$/u.test(digits)) throw new Error(`an archive pax record at byte ${at} has a length that is not a decimal number`);
    const length = Number(digits);
    const end = at + length;
    // The shortest record is `<digits> k=\n`.
    if (length < digits.length + 4 || end > body.length) {
      throw new Error(`an archive pax record at byte ${at} states ${length} bytes, which its header's ${body.length - at} remaining bytes do not frame`);
    }
    if (body[end - 1] !== 0x0a) throw new Error(`an archive pax record at byte ${at} does not end with a newline at the length it states`);
    const record = body.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error(`an archive pax record at byte ${at} has no key`);
    const key = exactUtf8(record.subarray(0, equals));
    if (key === undefined) throw new Error(`an archive pax record at byte ${at} has a key that is not UTF-8`);
    const value = Buffer.from(record.subarray(equals + 1));
    if (value.length === 0) records.delete(key);
    else records.set(key, value);
    at = end;
  }
  return records;
}

/** The members of the untracked archive the save wrote (ustar with pax
 * `path` and `linkpath` records), header checksums held, pax records framed
 * on the bytes (readPaxRecords), names and link names read as their exact
 * bytes (D57), and the archive ended by its zero block; anything else
 * throws. */
function readTarArchive(bytes: Buffer): ArchiveMember[] {
  const members: ArchiveMember[] = [];
  const raw = (from: number, length: number, header: Buffer): Buffer => {
    const slice = header.subarray(from, from + length);
    const end = slice.indexOf(0);
    return Buffer.from(slice.subarray(0, end < 0 ? slice.length : end));
  };
  const octalField = (from: number, length: number, header: Buffer) => {
    const text = raw(from, length, header).toString("latin1").replace(/[\s\u0000]+/gu, "");
    if (!/^[0-7]*$/u.test(text)) throw new Error("an archive header number is not octal");
    return text === "" ? 0 : Number.parseInt(text, 8);
  };
  let pax: Map<string, Buffer> | undefined;
  let offset = 0;
  let ended = false;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (octalField(148, 8, header) !== sum) throw new Error("an archive header checksum does not match");
    const size = octalField(124, 12, header);
    const type = String.fromCharCode(header[156]!);
    const data = bytes.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length !== size) throw new Error("the archive is truncated");
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      if (pax !== undefined) throw new Error("an archive pax header follows another without a member between them");
      pax = readPaxRecords(data);
      continue;
    }
    const name = raw(0, 100, header);
    const prefix = raw(345, 155, header);
    const path = pax?.get("path") ?? (prefix.length === 0 ? name : Buffer.concat([prefix, Buffer.from("/"), name]));
    const link = pax?.get("linkpath") ?? raw(157, 100, header);
    pax = undefined;
    const mode = octalField(100, 8, header);
    const mtime = octalField(136, 12, header);
    if (type === "0" || type === "\u0000") members.push({ path, type: "file", mode, mtime, data: Buffer.from(data) });
    else if (type === "2") members.push({ path, type: "link", mode, mtime, link });
    else throw new Error(`archive member ${shownPath(path)} has a type the restore does not write`);
  }
  if (pax !== undefined) throw new Error("an archive pax header is not followed by a member");
  if (!ended) throw new Error("the archive has no end");
  return members;
}

/** Whether every directory above `path` inside `root` is a real directory,
 * none of them a link — read without following one (S1). */
function realParents(root: SafeRoot, path: Buffer): boolean {
  return directoryChainState(root, parentOf(path) ?? Buffer.alloc(0)) === "real";
}

/** What stands at `path` below the pinned workspace, the entry itself, when
 * every directory above it is a real one; undefined otherwise (S1). */
function entryBelow(root: SafeRoot, path: Buffer): BigIntStats | undefined {
  return realParents(root, path) ? lstatBeneath(root, path) : undefined;
}

// --- every recorded attribute, exactly (R1') ------------------------------------

/** The attributes of one saved untracked entry, all of them (R1'): a file's
 * full mode (`& 0o7777`), size and sha256; a link's exact target bytes. The
 * type is the discriminant; presence is the entry's being there at all. */
export type SavedEntryAttributes =
  | { readonly type: "file"; readonly mode: number; readonly bytes: number; readonly sha256: string }
  | { readonly type: "link"; readonly target: Buffer };

/** What the tree holds at a path, as sameEntryAttributes compares it: a
 * file's or a link's attributes, `other` for anything else (a directory, a
 * socket, a path below something that is not a real directory), undefined
 * for nothing at all. */
export type FoundEntryAttributes = SavedEntryAttributes | { readonly type: "other" } | undefined;

/** Whether what the tree holds is exactly the recorded entry: present, of the
 * same type, and every attribute equal — a file's full mode (the setuid,
 * setgid and sticky bits too), size and sha256; a link's target byte for
 * byte. The one comparator of the plan, the write decision and every
 * verification (R1'). */
export function sameEntryAttributes(recorded: SavedEntryAttributes, found: FoundEntryAttributes): boolean {
  if (found === undefined || found.type !== recorded.type) return false;
  if (recorded.type === "link") return found.type === "link" && found.target.equals(recorded.target);
  return found.type === "file" && found.mode === recorded.mode && found.bytes === recorded.bytes && found.sha256 === recorded.sha256;
}

/** The attributes the tree holds at `path` below the pinned `root`, read
 * without following a link (S1): every directory above it must be a real
 * directory (otherwise it is `other`: not an entry of the tree), a file is
 * read through a descriptor opened without following a link and its mode and
 * size taken from that descriptor, a link's target read as bytes. With
 * `bytes`, a file of another size is not read: its digest is left empty,
 * which no recorded digest equals. */
export function entryAttributesAt(root: SafeRoot, path: Buffer, bytes?: number): FoundEntryAttributes {
  if (!isPlainRelative(path)) return { type: "other" };
  let parents: "real" | "missing" | "not_real";
  try {
    parents = directoryChainState(root, parentOf(path) ?? Buffer.alloc(0));
  } catch {
    return { type: "other" };
  }
  if (parents === "missing") return undefined;
  if (parents === "not_real") return { type: "other" };
  let entry: BigIntStats | undefined;
  try {
    entry = lstatBeneath(root, path);
  } catch {
    return { type: "other" };
  }
  if (entry === undefined) return undefined;
  if (entry.isSymbolicLink()) {
    try {
      return { type: "link", target: readLinkBeneath(root, path) };
    } catch {
      return { type: "other" };
    }
  }
  if (!entry.isFile()) return { type: "other" };
  let file: OpenedFile | undefined;
  try {
    file = openBeneath(root, path);
  } catch {
    return { type: "other" };
  }
  if (file === undefined) return undefined;
  try {
    if (bytes !== undefined && file.size !== bytes) return { type: "file", mode: file.mode & FULL_MODE, bytes: file.size, sha256: "" };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(file.fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      total += read;
    }
    file.verify();
    return { type: "file", mode: file.mode & FULL_MODE, bytes: total, sha256: hash.digest("hex") };
  } catch {
    return { type: "other" };
  } finally {
    file.close();
  }
}

/** An archive member's attributes, as the archive records them. */
function memberAttributes(member: ArchiveMember): SavedEntryAttributes {
  return member.type === "link"
    ? { type: "link", target: member.link! }
    : { type: "file", mode: member.mode, bytes: member.data!.length, sha256: sha256Of(member.data!) };
}

/** Whether the tree holds exactly the archive member at its path (R1'). */
function sameAsMember(root: SafeRoot, member: ArchiveMember): boolean {
  const recorded = memberAttributes(member);
  return sameEntryAttributes(recorded, entryAttributesAt(root, member.path, recorded.type === "file" ? recorded.bytes : undefined));
}

/** Whether the tree holds exactly the manifest entry at its path — its exact
 * bytes (D56), every attribute (R1'). */
function sameAsManifestEntry(root: SafeRoot, entry: UntrackedManifestEntry): boolean {
  return sameEntryAttributes(entry, entryAttributesAt(root, entry.path, entry.type === "file" ? entry.bytes : undefined));
}

/** Why the archive's members are not exactly the manifest's entries (D56),
 * or undefined when they are: the same paths byte for byte, each with every
 * attribute the manifest records (R1'). */
function archiveAgainstManifest(archive: readonly ArchiveMember[], manifest: readonly UntrackedManifestEntry[]): string | undefined {
  const listed = new Map(manifest.map((entry) => [bytesKey(entry.path), entry]));
  for (const member of archive) {
    const key = bytesKey(member.path);
    const entry = listed.get(key);
    if (entry === undefined) return `the member ${shownPath(member.path)} is not in the manifest`;
    listed.delete(key);
    if (entry.type !== member.type) return `${shownPath(member.path)} is a ${member.type} in the archive and a ${entry.type} in the manifest`;
    if (!sameEntryAttributes(entry, memberAttributes(member))) {
      return `${shownPath(member.path)} is not the ${entry.type} the manifest records`;
    }
  }
  const lacking = [...listed.values()][0];
  return lacking === undefined ? undefined : `${shownPath(lacking.path)} is in the manifest and not in the archive`;
}

/** Every file and link below `rel` (workspace-relative, exact), not following
 * links (S1: listed below the pinned workspace, each directory verified); a
 * nested repository or a special file below it is reported in `other`. */
function entriesBelow(root: SafeRoot, rel: Buffer): { readonly files: Buffer[]; readonly dirs: Buffer[]; readonly other: Buffer[] } {
  const files: Buffer[] = [];
  const dirs: Buffer[] = [];
  const other: Buffer[] = [];
  const walk = (current: Buffer) => {
    if (lstatBeneath(root, beneath(current, GIT_DIR_BYTES)) !== undefined) {
      other.push(current);
      return;
    }
    dirs.push(current);
    for (const name of listBeneath(root, current) ?? []) {
      const path = beneath(current, name);
      const entry = lstatBeneath(root, path);
      if (entry === undefined) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
      else other.push(path);
    }
  };
  walk(rel);
  return { files, dirs, other };
}

/** The saved rules' verdict on each path (D55): `git check-ignore` with the
 * probe tree — the saved `.gitignore` files at their paths — as the work
 * tree, so the per-directory rules are the saved ones while the repository's
 * own `info/exclude` and configuration stay what they are. A directory is
 * given with a trailing slash. Paths go in and come back as bytes (D57). */
function ignoredBySavedRules(root: string, probe: string, paths: readonly Buffer[], timeoutMs: number): Set<string> {
  if (paths.length === 0) return new Set();
  const out = mustGitBytes("the saved ignore rules could not be read", restoreGit(root, [
    // A second --work-tree after the boundary's own wins: only this call
    // reads its rule files from the probe.
    `--work-tree=${probe}`, "check-ignore", "--no-index", "-z", "--stdin",
  ], { input: joinNul(paths), timeoutMs }), [0, 1]);
  return new Set(splitNul(out).map(bytesKey));
}

/** Plan the restore of `state` in `root`, or refuse (RestoreRefusal). Writes
 * only inside `tmp`; git may store the saved patch's new contents as objects,
 * which nothing names. `idle` when there is nothing to move, clear or write
 * and the index is the saved one: then the tree is verified, not changed. */
function planRestore(state: PreFixState, dir: string, pinned: SafeRoot, tmp: string, timeoutMs: number): RestorePlan & { readonly idle: boolean } {
  const root = pinned.text;
  const metadata = trustedGitMetadata(root);
  if (metadata === undefined) throw new RestoreRefusal("the workspace is not a git repository the host can read");
  // The repository's own directory as a root the host pinned (S1): the
  // index and its lock are read and written only as the entries they are,
  // never through a link a session put in their place.
  let gitRoot: SafeRoot;
  try {
    gitRoot = safeRoot(metadata.gitDir, "the repository's git directory");
  } catch (error) {
    throw new RestoreRefusal(`the repository's git directory cannot be used: ${message(error).slice(0, 200)}`);
  }
  const indexPath = join(gitRoot.text, "index");
  const head = state.head!;

  // The saved files, held to the digests their row records.
  const readSaved = (file: string, recorded: { readonly sha256: string } | undefined): Buffer | undefined => {
    if (recorded === undefined) return undefined;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, file));
    } catch {
      throw new RestoreRefusal(`${file} is missing from the state directory`);
    }
    if (sha256Of(bytes) !== recorded.sha256) throw new RestoreRefusal(`${file} does not match the digest its row records`);
    return bytes;
  };
  const patch = readSaved(PRE_FIX_PATCH_FILE, state.patch);
  const archiveBytes = readSaved(PRE_FIX_ARCHIVE_FILE, state.archive);
  let archive: ArchiveMember[] = [];
  try {
    archive = archiveBytes === undefined ? [] : readTarArchive(archiveBytes);
  } catch (error) {
    throw new RestoreRefusal(`${PRE_FIX_ARCHIVE_FILE} cannot be read: ${message(error).slice(0, 200)}`);
  }
  // The untracked state apart from the tar codec (D56), held to its digest:
  // the archive's members must be exactly its entries, or nothing is written.
  const manifestBytes = readSaved(PRE_FIX_MANIFEST_FILE, state.manifest);
  let manifest: UntrackedManifestEntry[] | undefined;
  if (manifestBytes !== undefined) {
    try {
      manifest = decodeUntrackedManifest(manifestBytes);
    } catch (error) {
      throw new RestoreRefusal(`${PRE_FIX_MANIFEST_FILE} cannot be read: ${message(error).slice(0, 200)}`);
    }
    const disagreement = archiveAgainstManifest(archive, manifest);
    if (disagreement !== undefined) throw new RestoreRefusal(`${PRE_FIX_ARCHIVE_FILE} does not hold what ${PRE_FIX_MANIFEST_FILE} records: ${disagreement}`);
  }

  // HEAD must be the saved HEAD: the restore never moves it.
  const current = mustGit("HEAD could not be read", restoreGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { timeoutMs }), [0, 1]).trim();
  if (current !== head) {
    throw new RestoreRefusal(`HEAD is ${current === "" ? "unborn" : current}, but the state was saved at ${head}; ` +
      "move HEAD back to that commit first (the restore does not move HEAD)");
  }
  if (lstatBeneath(gitRoot, INDEX_LOCK_REL) !== undefined) throw new RestoreRefusal("another git process holds the index (index.lock exists)");
  if (mustGitBytes("the index could not be read", restoreGit(root, ["ls-files", "-u", "-z"], { timeoutMs })).length > 0) {
    throw new RestoreRefusal("the index has unmerged paths; finish or abort that merge first");
  }
  const indexBytes = readIndex(gitRoot);
  const indexDigest = indexBytes === undefined ? undefined : sha256Of(indexBytes);

  // The environments: the saved ones and whatever is one now. Never touched.
  const savedEnvironments = [...(state.environments ?? [])];
  const environments = [...new Set([...savedEnvironments, ...projectEnvironmentDirs(root)])].sort();
  const environmentBytes = environments.map((env) => Buffer.from(env));
  const inEnvironment = (path: Buffer) => environmentBytes.some((env) => isWithin(env, path));
  const spec = workspacePathspec(environments);
  const archivePaths = new Set<string>();
  for (const member of archive) {
    if (!isPlainRelative(member.path) || inGitDir(member.path)) {
      throw new RestoreRefusal(`the archive holds a path the restore does not write: ${shownPath(member.path)}`);
    }
    // A file's recorded mode is written and verified whole (R1'): one with
    // bits outside the permission, setuid, setgid and sticky bits is not a
    // mode the restore can give a file.
    if (member.type === "file" && (member.mode & ~FULL_MODE) !== 0) {
      throw new RestoreRefusal(`the archive records ${shownPath(member.path)} with mode ${member.mode.toString(8)}, which is not a file mode`);
    }
    if (inEnvironment(member.path)) throw new RestoreRefusal(`the archive holds ${shownPath(member.path)}, inside a project environment the restore does not touch`);
    const key = bytesKey(member.path);
    if (archivePaths.has(key)) throw new RestoreRefusal(`the archive holds ${shownPath(member.path)} twice`);
    archivePaths.add(key);
  }

  // The saved index in a temporary one: the current index reset to the saved
  // HEAD outside the environments, the saved patch applied to it.
  const index = join(tmp, "index");
  if (indexBytes !== undefined) {
    writeFileSync(index, indexBytes, { flag: "wx", mode: 0o600 });
    mustGit("the saved HEAD could not be read into a temporary index", restoreGit(root, ["reset", "-q", head, "--", ...spec], { index, timeoutMs }));
  } else {
    mustGit("the saved HEAD could not be read into a temporary index", restoreGit(root, ["read-tree", head], { index, timeoutMs }));
  }
  if (patch !== undefined) {
    const applied = restoreGit(root, ["apply", "--cached", "--whitespace=nowarn", join(dir, PRE_FIX_PATCH_FILE)], { index, timeoutMs });
    if ((applied.exitCode ?? 1) !== 0) {
      throw new RestoreRefusal(`the saved tracked changes do not apply to the saved HEAD: ${gitDetail(applied)}`);
    }
  }
  // A patch that changes a directory that is now an environment would touch it.
  const newEnvironments = environments.filter((env) => !savedEnvironments.includes(env));
  if (newEnvironments.length > 0) {
    const touched = splitNul(mustGitBytes("the saved changes could not be listed", restoreGit(root, [
      "diff-index", "--cached", "--name-only", "-z", "--ignore-submodules=all", head, "--", ...newEnvironments.map((env) => `:(literal)${env}`),
    ], { index, timeoutMs })));
    if (touched.length > 0) throw new RestoreRefusal(`the saved changes touch ${shownPath(touched[0]!)}, inside what is now a project environment`);
  }
  mustGit("the temporary index could not be refreshed", restoreGit(root, ["update-index", "-q", "--ignore-missing", "--refresh"], { index, timeoutMs }), [0, 1]);
  const differing = splitNul(mustGitBytes("the tracked files could not be compared", restoreGit(root, [
    "diff-files", "--name-only", "-z", "--ignore-submodules=all", "--", ...spec,
  ], { index, timeoutMs })));
  const savedEntries = mustGitBytes("the saved index could not be listed", restoreGit(root, ["ls-files", "-s", "-z"], { index, timeoutMs }));
  const savedTrackedPaths = stagedPaths(savedEntries).filter((path) => !inEnvironment(path));
  const savedTracked = new Set(savedTrackedPaths.map(bytesKey));
  const currentTracked = splitNul(mustGitBytes("the index could not be listed", restoreGit(root, ["ls-files", "-z", "--", ...spec], { timeoutMs })));
  for (const key of archivePaths) {
    if (savedTracked.has(key)) throw new RestoreRefusal(`the saved state holds ${shownPath(bytesOfKey(key))} both tracked and untracked`);
  }

  // The saved tracked files that differ, materialised apart; the saved rule
  // files in a probe tree.
  const treeDir = join(tmp, "tree");
  const probe = join(tmp, "probe");
  mkdirSync(treeDir);
  mkdirSync(probe);
  if (differing.length > 0) {
    mustGit("the saved tracked files could not be written apart", restoreGit(root, [
      "checkout-index", "-f", "-z", "--stdin", `--prefix=${treeDir}/`,
    ], { index, input: joinNul(differing), timeoutMs }));
  }
  const ruleFiles = savedTrackedPaths.filter((path) => lastSegmentIs(path, GITIGNORE_BYTES));
  if (ruleFiles.length > 0) {
    mustGit("the saved ignore rules could not be written apart", restoreGit(root, [
      "checkout-index", "-f", "-z", "--stdin", `--prefix=${probe}/`,
    ], { index, input: joinNul(ruleFiles), timeoutMs }));
  }
  for (const member of archive) {
    if (member.type !== "file" || !lastSegmentIs(member.path, GITIGNORE_BYTES)) continue;
    makeParents(probe, member.path, 0o700);
    writeFileSync(beneath(probe, member.path), member.data!);
  }

  // What to write: every differing saved tracked file, every archive member
  // the tree does not hold exactly.
  const writes: RestoreWrite[] = [];
  for (const path of differing) {
    const staged = beneath(treeDir, path);
    const entry = lstatOrUndefined(staged);
    if (entry === undefined) continue; // a gitlink: submodules are left as they are
    if (entry.isSymbolicLink()) writes.push({ path, kind: "link", link: readlinkSync(staged, { encoding: "buffer" }) as Buffer });
    else if (entry.isFile()) writes.push({ path, kind: "file", data: readFileSync(staged), mode: entry.mode & 0o777 });
  }
  for (const member of archive) {
    if (sameAsMember(pinned, member)) continue;
    writes.push(member.type === "link"
      ? { path: member.path, kind: "link", link: member.link! }
      : { path: member.path, kind: "file", data: member.data!, mode: member.mode & 0o7777, mtime: member.mtime });
  }
  const writePaths = new Set(writes.map((item) => bytesKey(item.path)));

  // What to move away: files tracked now that the saved state does not hold,
  // and untracked files the SAVED rules do not ignore that it does not hold.
  const moves = new Map<string, Buffer>();
  const move = (path: Buffer) => moves.set(bytesKey(path), path);
  for (const path of currentTracked) {
    const key = bytesKey(path);
    if (savedTracked.has(key) || archivePaths.has(key) || inEnvironment(path)) continue;
    const entry = entryBelow(pinned, path);
    if (entry !== undefined && !entry.isDirectory()) move(path);
  }
  // Every untracked entry, by its exact bytes (D57): none is left out for
  // its name or its link target.
  const listOthers = (extra: readonly string[]) => splitNul(mustGitBytes("the untracked files could not be listed", restoreGit(root, [
    "ls-files", "--others", "--exclude-standard", ...extra, "-z", "--", ...spec,
  ], { timeoutMs })));
  const covered = (path: Buffer) => savedTracked.has(bytesKey(path)) || archivePaths.has(bytesKey(path));
  const unignored = listOthers([]);
  const ignored = listOthers(["--ignored", "--directory"]);
  const nested = new Set(unignored.filter(isDirectoryListing).map((path) => bytesKey(path.subarray(0, -1))));
  const candidates = [...new Map([...unignored, ...ignored].map((path) => [bytesKey(path), path])).values()]
    .filter((path) => isDirectoryListing(path) || !covered(path));
  const byRules = ignoredBySavedRules(root, probe, candidates, timeoutMs);
  const expand: Buffer[] = [];
  for (const path of candidates) {
    if (byRules.has(bytesKey(path))) continue;
    if (!isDirectoryListing(path)) move(path);
    else if (!nested.has(bytesKey(path.subarray(0, -1)))) expand.push(path.subarray(0, -1));
  }
  // A directory the current rules ignore whole, but the saved rules do not:
  // each file in it is judged on its own.
  const inside: Buffer[] = [];
  for (const rel of expand) {
    const below = entriesBelow(pinned, rel);
    inside.push(...below.files.filter((path) => !covered(path) && !inEnvironment(path)));
  }
  const insideIgnored = ignoredBySavedRules(root, probe, inside, timeoutMs);
  for (const path of inside) if (!insideIgnored.has(bytesKey(path))) move(path);

  // Every path written is free once the moves are done: its current entry
  // moved (a file or a link) or cleared (a directory holding only moved
  // files), and every directory above it a real directory or moved.
  const clearDirs = new Map<string, Buffer>();
  for (const write of writes) {
    // Below a link or a file there is nothing of the tree's to move: what
    // stands above it is dealt with below.
    const entry = entryBelow(pinned, write.path);
    if (entry === undefined) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      move(write.path);
      continue;
    }
    const below = entriesBelow(pinned, write.path);
    const kept = [...below.other, ...below.files.filter((path) => !moves.has(bytesKey(path)))];
    if (kept.length > 0) throw new RestoreRefusal(`${shownPath(write.path)} is a directory holding ${shownPath(kept[0]!)}, which the restore keeps`);
    for (const path of below.dirs) clearDirs.set(bytesKey(path), path);
  }
  for (const write of writes) {
    // Outermost first, each read without following a link (S1): a link or a
    // file standing where a directory goes must be moved away (then nothing
    // below it is the tree's), a real directory stays; nothing below an
    // absent one exists.
    for (const above of ancestorsOf(write.path)) {
      if (writePaths.has(bytesKey(above))) throw new RestoreRefusal(`the saved state holds ${shownPath(above)} both as a file and as a directory`);
      const entry = lstatBeneath(pinned, above, "plan");
      if (entry === undefined) break;
      if (entry.isDirectory() && !entry.isSymbolicLink() && !clearDirs.has(bytesKey(above))) continue;
      if (!moves.has(bytesKey(above))) throw new RestoreRefusal(`${shownPath(above)} stands where ${shownPath(write.path)} goes, and the restore keeps it`);
      break;
    }
  }
  for (const path of moves.values()) {
    if (!isPlainRelative(path) || inGitDir(path) || inEnvironment(path)) {
      throw new RestoreRefusal(`the restore would move ${shownPath(path)}, which it does not touch`);
    }
    // Moved as the entry it is: every directory above it a real one (S1).
    if (directoryChainState(pinned, parentOf(path) ?? Buffer.alloc(0), "plan") === "not_real") {
      throw new RestoreRefusal(`${shownPath(path)} lies below something that is not a real directory`);
    }
  }

  const depth = (path: Buffer) => segments(path).length;
  const plan: RestorePlan = {
    root,
    pinned,
    gitRoot,
    indexPath,
    ...(indexDigest === undefined ? {} : { indexDigest }),
    savedIndex: readFileSync(index),
    savedEntries,
    moves: [...moves.values()].sort(Buffer.compare),
    clearDirs: [...clearDirs.values()].sort((a, b) => depth(b) - depth(a) || Buffer.compare(b, a)),
    writes: writes.sort((a, b) => Buffer.compare(a.path, b.path)),
    archive,
    ...(manifest === undefined ? {} : { manifest }),
    savedEnvironments,
    environments,
  };
  if (plan.moves.length === 0 && plan.writes.length === 0 && plan.clearDirs.length === 0) {
    const entries = mustGitBytes("the index could not be listed", restoreGit(root, ["ls-files", "-s", "-z"], { timeoutMs }));
    if (entries.equals(savedEntries)) return { ...plan, idle: true };
  }
  return { ...plan, idle: false };
}

/** The directory `<dir>-recovery-<n>` beside the state, the first free n. */
function recoveryDir(dir: string): string {
  for (let n = 1; ; n += 1) {
    const path = `${dir}-recovery-${n}`;
    try {
      mkdirSync(path, { mode: 0o700 });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 10_000) throw error;
    }
  }
}

/** The recovery tree's place for a workspace path: `tree/<path>`. */
const TREE_REL = Buffer.from("tree");
function inTree(path: Buffer): Buffer {
  return beneath(TREE_REL, path);
}

/** Replace the index through its lock file: the lock is written whole, then
 * renamed over the index — both entries of the pinned git directory, never
 * followed (S1: rename replaces a link standing at the index, it does not
 * write through it). */
function writeIndex(lockFd: number, gitRoot: SafeRoot, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(lockFd, bytes, offset, bytes.length - offset);
  closeSync(lockFd);
  if (!rootIntact(gitRoot)) throw new Error("the repository's git directory changed while the restore ran");
  renameSync(beneath(gitRoot.path, INDEX_LOCK_REL), beneath(gitRoot.path, INDEX_REL));
}

/** What the apply changed, so a failure can put it back. */
interface RestoreJournal {
  readonly moved: Buffer[];
  readonly removedDirs: { readonly path: Buffer; readonly mode: number }[];
  readonly createdDirs: Buffer[];
  readonly written: Buffer[];
  lockFd?: number;
  installed: boolean;
}

/** Apply a plan: move, clear, write, install the index, verify; on failure,
 * put everything back. S1 (D57c): every write, move and removal in the
 * workspace is below it as a root the host pinned (link-safe-fs.ts) — a link
 * a session put in place of a directory on any path refuses that step, and
 * the apply puts back what it did, never touching what the link points at. */
function applyRestore(
  plan: RestorePlan,
  state: PreFixState,
  dir: string,
  timeoutMs: number,
  checkpoint: ((at: RestoreCheckpoint) => void) | undefined,
): PreFixRestoreResult {
  const { root, pinned, gitRoot } = plan;
  const base = { dir, round: state.round, workspace: root };
  const recovery = recoveryDir(dir);
  const journal: RestoreJournal = { moved: [], removedDirs: [], createdDirs: [], written: [], installed: false };
  const refuse = (reason: string): PreFixRestoreResult => {
    rmSync(recovery, { recursive: true, force: true });
    return { status: "refused", ...base, reason };
  };
  let recoveryRoot: SafeRoot;
  try {
    recoveryRoot = safeRoot(recovery, "the recovery directory");
    journal.lockFd = createExclusiveBeneath(gitRoot, INDEX_LOCK_REL, 0o644, "lock");
  } catch {
    return refuse("another git process holds the index (index.lock exists)");
  }
  // Inside the lock: the repository must still be as planned.
  const head = restoreGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { timeoutMs }).stdout.toString().trim();
  let indexDigest: string | undefined;
  let indexBytes: Buffer | undefined;
  try {
    indexBytes = readIndex(gitRoot);
    indexDigest = indexBytes === undefined ? undefined : sha256Of(indexBytes);
  } catch {
    indexDigest = "unreadable";
  }
  if (head !== state.head || indexDigest !== plan.indexDigest || !rootIntact(pinned)) {
    closeSync(journal.lockFd);
    unlinkBeneath(gitRoot, INDEX_LOCK_REL, "unlock");
    return refuse("the repository changed while the restore was planned (HEAD or the index); run it again");
  }
  try {
    if (indexBytes !== undefined) writeBeneath(recoveryRoot, INDEX_REL, indexBytes, { mode: 0o600, operation: "keep" });
    ensureDirBeneath(recoveryRoot, TREE_REL, 0o700, "recover");
    for (const path of plan.moves) {
      renameBeneath(pinned, path, recoveryRoot, inTree(path), { parents: 0o700, operation: "move" });
      journal.moved.push(path);
    }
    // Directories where a file goes, and directories the moves left empty.
    const removeDir = (path: Buffer): boolean => {
      const entry = lstatBeneath(pinned, path, "clear");
      if (entry === undefined || !entry.isDirectory() || (listBeneath(pinned, path, "clear") ?? []).length > 0) return false;
      rmdirBeneath(pinned, path, "clear");
      journal.removedDirs.push({ path, mode: Number(entry.mode) & 0o7777 });
      return true;
    };
    for (const path of plan.clearDirs) {
      if (!removeDir(path) && lstatBeneath(pinned, path, "clear") !== undefined) throw new Error(`${shownPath(path)} was not empty once its files were moved`);
    }
    for (const path of plan.moves) {
      for (const above of ancestorsOf(path).reverse()) {
        if (!removeDir(above)) break;
      }
    }
    plan.writes.forEach((write, index) => {
      checkpoint?.({ step: "write", path: displayPath(write.path), index });
      const parent = parentOf(write.path);
      if (parent !== undefined) journal.createdDirs.push(...ensureDirBeneath(pinned, parent, 0o755, "write"));
      const created = () => {
        journal.written.push(write.path);
      };
      if (write.kind === "link") {
        symlinkBeneath(pinned, write.path, write.link!, { operation: "write", created });
      } else {
        writeBeneath(pinned, write.path, write.data!, {
          mode: write.mode!,
          ...(write.mtime === undefined ? {} : { mtime: write.mtime }),
          operation: "write",
          created,
        });
      }
    });
    writeIndex(journal.lockFd, gitRoot, plan.savedIndex);
    journal.lockFd = undefined;
    journal.installed = true;
    mustGit("the restored index could not be refreshed", restoreGit(root, ["update-index", "-q", "--refresh"], { timeoutMs }), [0, 1]);
    checkpoint?.({ step: "verify" });
    verifyRestore(plan, state, timeoutMs);
    const verified = plan.manifest === undefined ? "archive" as const : "manifest" as const;
    const listed = (paths: readonly Buffer[]) => paths.map((path) => ({ path: displayPath(path), path_b64: path.toString("base64") }));
    writeFileSync(join(recovery, "restore.json"), `${JSON.stringify({
      state: dir, workspace: root, head: state.head,
      moved: journal.moved.map(displayPath), written: journal.written.map(displayPath),
      exact: { moved: listed(journal.moved), written: listed(journal.written) },
      verified,
    }, null, 2)}\n`);
    return { status: "restored", ...base, recovery, moved: journal.moved.map(displayPath), written: journal.written.map(displayPath), verified };
  } catch (error) {
    const left = rollBack(plan, journal, recoveryRoot);
    if (left.length === 0) rmSync(recovery, { recursive: true, force: true });
    return {
      status: "failed",
      ...base,
      reason: message(error).slice(0, 300),
      rolledBack: left.length === 0,
      ...(left.length === 0 ? {} : { recovery, left }),
      moved: [],
      written: [],
    };
  }
}

/** The restored tree is the saved state: HEAD, the index, the tracked diff
 * against HEAD byte for byte the saved patch, the untracked files exactly
 * the manifest (or, before D56, the archive). Throws what differs. */
function verifyRestore(plan: RestorePlan, state: PreFixState, timeoutMs: number): void {
  const { root, pinned } = plan;
  const head = restoreGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { timeoutMs }).stdout.toString().trim();
  if (head !== state.head) throw new Error("the restored tree does not match the saved state: HEAD moved");
  const entries = mustGitBytes("the restored index could not be listed", restoreGit(root, ["ls-files", "-s", "-z"], { timeoutMs }));
  if (!entries.equals(plan.savedEntries)) throw new Error("the restored tree does not match the saved state: the index differs");
  const diff = trackedDiff(root, state.head!, plan.savedEnvironments, timeoutMs);
  if ((diff.exitCode ?? 1) !== 0 || overOutputBound(diff)) throw new Error("the restored tree does not match the saved state: the tracked diff could not be read");
  if (sha256Of(diff.stdout) !== (state.patch?.sha256 ?? sha256Of(""))) {
    throw new Error("the restored tree does not match the saved state: the tracked diff against HEAD is not the saved patch");
  }
  const listing = splitNul(mustGitBytes("the restored untracked files could not be listed", restoreGit(root, [
    "ls-files", "--others", "--exclude-standard", "-z", "--", ...workspacePathspec(plan.environments),
  ], { timeoutMs }))).filter((path) => !isDirectoryListing(path));
  // The untracked files are exactly the saved ones, by their exact bytes,
  // each as recorded — whatever the archive's reader made of the archive
  // (D56): the manifest, or before D56 the archive itself.
  const expected: readonly { readonly path: Buffer; readonly same: () => boolean }[] = plan.manifest !== undefined
    ? plan.manifest.map((entry) => ({ path: entry.path, same: () => sameAsManifestEntry(pinned, entry) }))
    : plan.archive.map((member) => ({ path: member.path, same: () => sameAsMember(pinned, member) }));
  const want = new Set(expected.map((entry) => bytesKey(entry.path)));
  const have = new Set(listing.map(bytesKey));
  const extra = listing.find((path) => !want.has(bytesKey(path)));
  const lacking = expected.find((entry) => !have.has(bytesKey(entry.path)));
  const against = plan.manifest !== undefined ? "the saved manifest" : "the archive";
  if (extra !== undefined || lacking !== undefined) {
    throw new Error(`the restored tree does not match the saved state: the untracked files are not ${against} (${extra === undefined ? `${shownPath(lacking!.path)} is missing` : `${shownPath(extra)} is extra`})`);
  }
  for (const entry of expected) {
    if (!entry.same()) {
      throw new Error(`the restored tree does not match the saved state: ${shownPath(entry.path)} is not as ${plan.manifest !== undefined ? "the manifest records" : "saved"}`);
    }
  }
}

/** Put back what the apply changed, newest first; returns what could not be
 * put back (shown). Every step below the pinned roots (S1): a link a session
 * put in place of a directory since refuses that step — reported as left —
 * and nothing it points at is touched. */
function rollBack(plan: RestorePlan, journal: RestoreJournal, recoveryRoot: SafeRoot): string[] {
  const { pinned, gitRoot } = plan;
  const left: string[] = [];
  if (journal.lockFd !== undefined) {
    try {
      closeSync(journal.lockFd);
      unlinkBeneath(gitRoot, INDEX_LOCK_REL, "unlock");
    } catch {
      left.push("index.lock");
    }
  } else if (journal.installed) {
    try {
      const backup = readBeneath(recoveryRoot, INDEX_REL, "rollback");
      if (backup !== undefined) {
        const fd = createExclusiveBeneath(gitRoot, INDEX_LOCK_REL, 0o644, "lock");
        writeIndex(fd, gitRoot, backup);
      } else {
        unlinkBeneath(gitRoot, INDEX_REL, "rollback");
      }
    } catch {
      left.push("the index (its copy is index in the recovery directory)");
    }
  }
  for (const path of [...journal.written].reverse()) {
    try {
      unlinkBeneath(pinned, path, "rollback");
    } catch {
      left.push(displayPath(path));
    }
  }
  for (const path of [...journal.createdDirs].reverse()) {
    try {
      rmdirBeneath(pinned, path, "rollback");
    } catch {
      left.push(`${displayPath(path)}/`);
    }
  }
  for (const { path, mode } of [...journal.removedDirs].reverse()) {
    try {
      ensureDirBeneath(pinned, path, 0o700, "rollback");
      chmodBeneath(pinned, path, mode, "rollback");
    } catch {
      left.push(`${displayPath(path)}/`);
    }
  }
  for (const path of [...journal.moved].reverse()) {
    try {
      renameBeneath(recoveryRoot, inTree(path), pinned, path, { operation: "rollback" });
    } catch {
      left.push(displayPath(path));
    }
  }
  return left;
}

/**
 * Restore the saved pre-fix state in `dir` (D55): `dokkabi work
 * --restore-pre-fix <dir>`, run inside the workspace the state was saved
 * from. Plans without changing anything, and refuses when it cannot restore
 * the whole saved tree; otherwise moves what it replaces or removes into
 * `<dir>-recovery-<n>`, writes the saved tree, installs the saved index and
 * verifies the result, putting everything back on any failure. Never throws.
 * S1 (D57c): the workspace is a root the host pins first — a link in its own
 * place is refused — and every path below it is used without following a
 * link.
 */
export function restorePreFixState(input: {
  readonly dir: string;
  /** Where the command runs: the workspace, or a directory inside it. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Told before each write and before the verification (RestoreCheckpoint). */
  readonly checkpoint?: (at: RestoreCheckpoint) => void;
}): PreFixRestoreResult {
  const dir = resolve(input.dir);
  const timeoutMs = Math.max(1, Math.min(GIT_STEP_MAX_MS, input.timeoutMs ?? GIT_STEP_MAX_MS));
  let state: PreFixState | undefined;
  try {
    state = readPreFixState(dir);
  } catch (error) {
    return { status: "refused", dir, reason: `the run's log beside the state could not be read: ${message(error).slice(0, 200)}` };
  }
  if (state === undefined) return { status: "refused", dir, reason: `no pre-fix state recorded in ${preFixStateLogPath(dir)} names this directory` };
  if (!state.saved || state.workspace === undefined || state.head === undefined) {
    return { status: "refused", dir, round: state.round, reason: `that state was not saved: ${oneLine(state.reason ?? "no reason recorded")}` };
  }
  let pinned: SafeRoot;
  try {
    pinned = safeRoot(state.workspace, "the workspace");
  } catch (error) {
    if (error instanceof LinkSafetyError && error.code === "link") {
      return { status: "refused", dir, round: state.round, reason: `the workspace ${state.workspace} is a symbolic link now, not the directory the state was saved from (S1: never followed)` };
    }
    return { status: "refused", dir, round: state.round, reason: `the workspace ${state.workspace} is gone` };
  }
  const root = pinned.text;
  const base = { dir, round: state.round, workspace: root };
  const cwd = canonicalPath(input.cwd);
  if (!(cwd === root || cwd.startsWith(`${root}${sep}`))) {
    return { status: "refused", ...base, reason: `run it inside the workspace the state was saved from: ${root}` };
  }
  const tmp = mkdtempSync(join(tmpdir(), "dokkabi-restore-"));
  try {
    let plan: RestorePlan & { readonly idle: boolean };
    try {
      plan = planRestore(state, dir, pinned, tmp, timeoutMs);
    } catch (error) {
      return { status: "refused", ...base, reason: error instanceof RestoreRefusal ? error.message : `the restore could not be planned: ${message(error).slice(0, 200)}` };
    }
    if (plan.idle) {
      // Nothing to change: `restored` still only once the tree is verified
      // against the saved state, every attribute of it (R1').
      try {
        verifyRestore(plan, state, timeoutMs);
      } catch (error) {
        return { status: "refused", ...base, reason: `the restore found nothing to write or move, but the tree is not the saved state (${message(error).slice(0, 200)})` };
      }
      return { status: "restored", ...base, moved: [], written: [], verified: plan.manifest === undefined ? "archive" : "manifest" };
    }
    return applyRestore(plan, state, dir, timeoutMs, input.checkpoint);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The lines `dokkabi work --restore-pre-fix` prints for a result. */
export function formatPreFixRestoreLines(result: PreFixRestoreResult): string[] {
  const round = result.round === undefined ? "" : ` round=${result.round}`;
  if (result.status === "restored") {
    const moved = result.moved?.length ?? 0;
    return [
      `pre-fix state${round} restored: dir=${result.dir} written=${result.written?.length ?? 0} moved=${moved}` +
        `${result.recovery === undefined ? " (the tree already was the saved state)" : ` recovery=${result.recovery}`}`,
      ...(moved > 0 ? ["- the files it replaced or removed are in the recovery directory, under tree/, at their paths"] : []),
      ...(result.verified === "archive"
        ? ["- the untracked files were checked against the archive only: this state was saved without an untracked manifest"]
        : []),
    ];
  }
  if (result.status === "refused") return [`pre-fix restore${round} refused, nothing was changed: ${oneLine(result.reason ?? "")}`];
  return [
    `pre-fix restore${round} failed: ${oneLine(result.reason ?? "")}`,
    result.rolledBack === true
      ? "- every change was put back: the tree and the index are as they were"
      : `- not everything could be put back (${(result.left ?? []).slice(0, 8).join(", ")}); what was moved is in ${result.recovery}/tree`,
  ];
}
