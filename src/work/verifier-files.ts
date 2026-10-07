import { hostWorkTreeListing } from "../host/host-index.ts";
import { trackedAtBase } from "../host/base-record.ts";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { projectEnvironmentDirs } from "../host/environment-facts.ts";
import { readDirectoryBytes } from "../host/fs-bytes.ts";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import {
  ensureDirBeneath,
  lstatBeneath,
  readBeneath,
  readLinkBeneath,
  removeTreeBeneath,
  safeRoot,
  symlinkBeneath,
  writeBeneath,
  type SafeRoot,
} from "./link-safe-fs.ts";
import { recordedCheckTextOf } from "./ledger-check.ts";
import { LEDGER_MIRROR_PATH } from "./plan-ledger.ts";
import {
  bytesKey,
  beneath,
  displayPath,
  exactUtf8,
  isPlainRelative,
  isWithin,
  parentOf,
  splitNul,
} from "./path-bytes.ts";
import type { DisputeEvidence, DisputeEvidenceFile, DisputeEvidenceLink, DisputeEvidenceMaterial } from "./recheck-adjudication.ts";
import {
  readRecheckInputs,
  recheckInputsGaps,
  recheckSnapshotGaps,
  CONFINING_FENCES,
  type RecheckInputEntry,
  type RecheckInputReach,
  type RecheckInputSnapshot,
  type RecheckInputStore,
} from "./recheck-inputs.ts";
import { readRegularFile } from "./session-scratch.ts";

/**
 * RECHECK-FILES (D47): the files a verifier AUTHORED in its copy, kept for
 * the recheck.
 *
 * A verifier reproduces a defect with a command, and that command often calls
 * a script or a test the verifier wrote in its own copy. The recheck runs the
 * command on a copy of the developer's tree, where that file never existed, so
 * without it the reproduction cannot start and says nothing about the fix.
 *
 * So before the verifier's copy is removed, the orchestrator keeps the paths
 * that are new in it: untracked and not ignored against the delivered-state
 * snapshot commit (`git ls-files --others --exclude-standard` in the copy,
 * through the sealed host git boundary). A tracked file the verifier modified
 * is never taken — the verifier must not change the product — and neither is
 * anything inside a project environment (the marker scan the base prune
 * uses), nor the host's own plan mirror, nor anything that is not a regular
 * file, nor anything over the bounds below. What is kept is stored in the
 * run's own session directory, never in the developer's tree. The recheck
 * then overlays it onto its own copy, and only before the reported cases of
 * that verifier run (recheck-observe.ts). Since D57 every path is its exact
 * bytes from git's `-z` listing to the overlay (path-bytes.ts): a name that is
 * not UTF-8, or that starts with U+FEFF, is kept and overlaid as it is.
 *
 * Nothing here gates and nothing throws: a listing that fails keeps nothing
 * and says why.
 *
 * DISPUTE EVIDENCE (D55, D57): before a verifier that is to rule on disputed
 * checks starts, the evidence of each dispute is written into THAT verifier's
 * scratch — never its workspace, never the developer's tree — under
 * `disputed-checks/<n>/`. Since D57 the evidence is what the check's FAILING
 * run ran with, captured before that run (E1, recheck-inputs.ts): the snapshot
 * its observation row names, every entry read from the run's input store and
 * held to its digest — `files/<path>` the verifier files overlaid onto the
 * recheck copy, `scratch/<path>` the scratch the run bound (files with their
 * modes, links with their exact targets, directories), `check/stdin` the stdin
 * it was given — beside `check.json` and `check/fixtures/` (the check as
 * recorded, texts from the row or from that snapshot, by digest),
 * `observation.json` (that run's observation) and `manifest.json` (every file
 * and link by its exact path bytes, with its sha256). The evidence is complete
 * only when the run held the recorded check, a red recheck of it named a
 * snapshot within its bounds, the keep behind a reported check left nothing
 * behind, and every entry of the snapshot was written and read back as
 * recorded within the verifier's bound. Neither the keep directory nor the
 * scratch as it is at delivery (D55, D56) is read: a check that removed or
 * rewrote its own inputs while it ran, or a later attempt that found them
 * gone, changes nothing of what it is ruled on.
 *
 * Since D57b (E1') the snapshot is of everything the run could read of what
 * the host bound for it — the bound scratch whole, `.host` included — and a
 * link is delivered as the link it was, with where its target was captured:
 * `resolves_to`, the evidence path of the entry it led to (an absolute target
 * names the original place, which the ruling verifier cannot read). A link
 * that led outside what was snapshotted, or a run in a sandbox that does not
 * keep its reads to it, makes the evidence incomplete (recheckInputsGaps,
 * recheckSnapshotGaps).
 */

/** What is kept, at most: 1 MiB per file, 20 MiB and 2,000 files in all. A
 * reproduction script is small; a file past these is output or data, not a
 * check, and is counted as skipped. */
export const VERIFIER_FILES_BOUNDS: Readonly<VerifierFilesBounds> = Object.freeze({
  fileBytes: 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  files: 2_000,
});

export interface VerifierFilesBounds {
  readonly fileBytes: number;
  readonly totalBytes: number;
  readonly files: number;
}

/** One kept file as the keep wrote it (D55): its exact path bytes in the
 * verifier's tree (D57), its sha256 and size. */
export interface KeptFile {
  readonly path: Buffer;
  readonly sha256: string;
  readonly bytes: number;
}

/** What one keep did. */
export interface VerifierFilesKept {
  /** Where the kept files are, by their repository-relative paths. */
  readonly dir: string;
  readonly kept: number;
  /** Authored files left behind: over a bound, or not a regular file. */
  readonly skipped: number;
  /** Authored files left behind because they lie in a project environment. */
  readonly environment: number;
  /** Why nothing could be kept, when that is the case. */
  readonly reason?: string;
  /** Every kept file, with its sha256 and size as kept (D55); absent when
   * nothing could be kept. */
  readonly files?: readonly KeptFile[];
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const LIST_TIMEOUT_MS = 120_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The kept files of one verifier: `<run dir>/verifier-<round>/files`. */
export function verifierFilesDir(runDir: string, round: number): string {
  return join(runDir, `verifier-${round}`, "files");
}

/** Keep the files the verifier authored in `copy` under `dest` (replacing
 * whatever an earlier keep left there). S1 (D57c): the verifier copy is a
 * tree the verifier session wrote, so each file is read below it as a root
 * the host pinned — a link in any directory on its path, or at the file
 * itself, leaves it behind (skipped), never read through — and written below
 * `dest` the same way. */
export function keepVerifierFiles(input: {
  readonly copy: string;
  readonly dest: string;
  readonly bounds?: VerifierFilesBounds;
  readonly timeoutMs?: number;
}): VerifierFilesKept {
  const { copy, dest } = input;
  const bounds = input.bounds ?? VERIFIER_FILES_BOUNDS;
  const none = (reason: string): VerifierFilesKept => ({ dir: dest, kept: 0, skipped: 0, environment: 0, reason });
  let listed: { stdout: Buffer };
  try {
    // I2 (D57g): the files the verifier authored are what the HOST lists in
    // the copy (its rules evaluated by the host, each name as the file
    // system has it) that the snapshot commit does not track — never git's
    // index or ignore machinery.
    const snapshot = trackedAtBase(copy);
    if (snapshot.head === undefined) return none("the verifier copy has no snapshot commit to tell its authored files from");
    const atSnapshot = new Set(snapshot.tracked.keys());
    // Excluded locations too (a `node_modules` no rule ignores): an
    // environment there is counted and never taken.
    const authored = hostWorkTreeListing(copy, { includeExcluded: true }).map((entry) => entry.path).filter((path) => !atSnapshot.has(bytesKey(path)));
    listed = { stdout: Buffer.concat(authored.flatMap((path) => [path, Buffer.alloc(1)])) };
  } catch (error) {
    return none(`the verifier copy's new files could not be listed: ${message(error).slice(0, 200)}`);
  }
  let copyRoot: SafeRoot;
  try {
    copyRoot = safeRoot(copy, "the verifier copy");
  } catch (error) {
    return none(`the verifier copy's new files could not be read: ${message(error).slice(0, 200)}`);
  }
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch (error) {
    return none(`the kept-files directory could not be cleared: ${message(error).slice(0, 200)}`);
  }
  const environmentDirs = projectEnvironmentDirs(copy).map((dir) => Buffer.from(dir));
  const mirror = Buffer.from(LEDGER_MIRROR_PATH);
  let kept = 0;
  let skipped = 0;
  let environment = 0;
  let total = 0;
  const files: KeptFile[] = [];
  let destRoot: SafeRoot | undefined;
  for (const path of splitNul(listed.stdout)) {
    if (path.equals(mirror)) continue;
    if (environmentDirs.some((dir) => isWithin(dir, path))) {
      environment += 1;
      continue;
    }
    // git lists plain repository-relative paths; anything else is not this
    // keep's to read or write.
    if (!isPlainRelative(path)) {
      skipped += 1;
      continue;
    }
    let size: number;
    let mode: number;
    try {
      // Every directory above it real, the file itself a regular file (S1).
      const entry = lstatBeneath(copyRoot, path, "keep");
      if (entry === undefined || !entry.isFile()) {
        skipped += 1;
        continue;
      }
      size = Number(entry.size);
      mode = Number(entry.mode) & 0o777;
    } catch {
      skipped += 1;
      continue;
    }
    if (size > bounds.fileBytes || total + size > bounds.totalBytes || kept >= bounds.files) {
      skipped += 1;
      continue;
    }
    let digest: KeptFile;
    try {
      destRoot ??= safeRoot(dest, "the kept-files directory", { create: 0o700 });
      const bytes = readBeneath(copyRoot, path, "keep");
      if (bytes === undefined) throw new Error("gone since it was listed");
      writeBeneath(destRoot, path, bytes, { mode, parents: 0o700, operation: "keep" });
      // The digest of the kept copy itself: what a later evidence is held to.
      const back = readBeneath(destRoot, path, "keep");
      if (back === undefined) throw new Error("the kept copy is gone");
      digest = { path: Buffer.from(path), sha256: sha256(back), bytes: back.length };
    } catch {
      skipped += 1;
      continue;
    }
    files.push(digest);
    kept += 1;
    total += size;
  }
  return { dir: dest, kept, skipped, environment, files };
}

/** Every regular file under `root`, as root-relative exact paths, sorted by
 * their bytes. */
function keptPaths(root: string): Buffer[] {
  const out: Buffer[] = [];
  const walk = (rel: Buffer) => {
    for (const name of readDirectoryBytes(beneath(root, rel)).sort(Buffer.compare)) {
      const path = rel.length === 0 ? Buffer.from(name) : beneath(rel, name);
      const entry = lstatSync(beneath(root, path));
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(Buffer.alloc(0));
  return out;
}

/**
 * Overlay kept files onto a throwaway copy: directories are created, and a
 * path the copy already has is replaced — in the copy only. S1 (D57c): every
 * operation is below the copy as a root the host pinned, so a link in any
 * directory on a target's path (the developer's tree the copy came from may
 * hold one) leaves that file not overlaid, never written through; what stands
 * at the target itself — a link, a hard link, a directory — is removed as
 * itself first, never followed. Returns the exact paths overlaid (D57: the
 * recheck snapshots them before each run); a missing or unreadable source, or
 * a copy that is not a real directory, overlays nothing.
 */
export function overlayVerifierFileList(source: string, copy: string): Buffer[] {
  let paths: Buffer[];
  let copyRoot: SafeRoot;
  try {
    paths = keptPaths(source);
    copyRoot = safeRoot(copy, "the recheck copy");
  } catch {
    return [];
  }
  const overlaid: Buffer[] = [];
  for (const path of paths) {
    if (!isPlainRelative(path)) continue;
    try {
      const parent = parentOf(path);
      if (parent !== undefined) ensureDirBeneath(copyRoot, parent, 0o755, "overlay");
      // Removed first, whatever it is: a link or a hard link is replaced, not
      // written through; a directory is removed whole, never through a link.
      removeTreeBeneath(copyRoot, path, "overlay");
      const from = beneath(source, path);
      writeBeneath(copyRoot, path, readRegularFile(from), { mode: lstatSync(from).mode & 0o777, operation: "overlay" });
      overlaid.push(path);
    } catch {
      // Not overlaid; the list says which were.
    }
  }
  return overlaid;
}

/** overlayVerifierFileList, counted. */
export function overlayVerifierFiles(source: string, copy: string): number {
  return overlayVerifierFileList(source, copy).length;
}

// --- the evidence of a disputed check (D55, D57) --------------------------------

/** The directory of the disputes' evidence inside a verifier's scratch. */
export const DISPUTE_EVIDENCE_DIR = "disputed-checks";

/** The directory of the scratch a check's failing run bound, inside its
 * evidence (D56, D57). */
export const DISPUTE_EVIDENCE_SCRATCH_DIR = "scratch";

/** The directory of the verifier files overlaid for that run. */
export const DISPUTE_EVIDENCE_FILES_DIR = "files";

/** The directory of a property's counterexample inputs (D58): the k-th
 * counterexample's generated input under `counterexamples/<k>/input`. */
export const DISPUTE_EVIDENCE_COUNTEREXAMPLES_DIR = "counterexamples";

/** What one verifier's evidence holds, at most, over all its disputes: 64 MiB
 * and 4,000 files — a quarter of a session's scratch cap in bytes, so the
 * verifier's own checks keep their room. A dispute whose inputs would pass it
 * is delivered without them, and so not complete. */
export const DISPUTE_EVIDENCE_BOUNDS: Readonly<{ bytes: number; files: number }> = Object.freeze({
  bytes: 64 * 1024 * 1024,
  files: 4_000,
});

/** A relative path with no `..`, `.` or empty segment, or undefined. */
function plainRelative(path: string): string | undefined {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")) return undefined;
  const parts = path.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? undefined : path;
}

/** UTF-8 text without NUL bytes, or undefined (a binary file is named by
 * digest, never inlined). */
function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  return exactUtf8(bytes);
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Write the evidence of each dispute into the verifier's scratch, under
 * `disputed-checks/<index>/` (whatever an earlier delivery left there is
 * replaced), and say for each what was delivered and whether it is complete.
 * A scratch inside the developer's workspace (`liveRoots`) gets nothing.
 * Never throws.
 */
export function deliverDisputeEvidence(input: {
  /** The verifier session's scratch directory; created when absent. */
  readonly scratch: string;
  readonly items: readonly DisputeEvidenceMaterial[];
  /** The developer's workspace spellings. */
  readonly liveRoots?: readonly string[];
  readonly bounds?: { readonly bytes: number; readonly files: number };
}): { readonly scratch?: string; readonly items: DisputeEvidence[] } {
  const bounds = input.bounds ?? DISPUTE_EVIDENCE_BOUNDS;
  const none = (reason: string) => input.items.map((item) => ({ index: item.index, complete: false, missing: [reason] }));
  // The verifier's scratch as a root the host pinned (S1, D57c): made when
  // absent, refused when a link stands in its place; everything below is
  // written through verified real directories only.
  let root: SafeRoot;
  try {
    root = safeRoot(input.scratch, "the verifier's scratch", { create: 0o700 });
  } catch (error) {
    return { items: none(`the verifier's scratch could not be prepared: ${message(error).slice(0, 200)}`) };
  }
  const scratch = root.text;
  for (const live of input.liveRoots ?? []) {
    let real: string;
    try {
      real = realpathSync(live);
    } catch {
      real = resolve(live);
    }
    if (within(real, scratch) || within(resolve(live), resolve(input.scratch))) {
      return { items: none("the verifier's scratch lies inside the developer's workspace; no evidence was written there") };
    }
  }
  const base = Buffer.from(DISPUTE_EVIDENCE_DIR);
  try {
    // Whatever an earlier delivery (or anyone) left there is removed first —
    // a link as the link, never followed.
    removeTreeBeneath(root, base, "deliver");
    ensureDirBeneath(root, base, 0o700, "deliver");
  } catch (error) {
    return { scratch, items: none(`the evidence directory could not be prepared: ${message(error).slice(0, 200)}`) };
  }
  const used = { bytes: 0, files: 0 };
  return { scratch, items: input.items.map((item) => deliverOne(root, base, item, bounds, used)) };
}

/** One regular file of a dispute's evidence, to write. */
interface EvidenceEntry {
  /** Relative to the evidence directory, exact. */
  readonly path: Buffer;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly sha256: string;
  /** A verifier file overlaid for the failing run: its path in that
   * verifier's tree. */
  readonly source_path?: Buffer;
  /** A file of the scratch that run bound: its path there. */
  readonly scratch_path?: Buffer;
  /** A file of a property's counterexample input (D58): the counterexample
   * and its path in that case's directory. */
  readonly counterexample?: number;
  readonly input_path?: Buffer;
}

/** One link of that scratch or of the overlaid files, to write: its target
 * as it was, and where that target was captured in the evidence (or that it
 * led outside what was snapshotted). */
interface EvidenceLinkEntry {
  readonly path: Buffer;
  readonly target: Buffer;
  readonly resolves_to?: Buffer;
  readonly absent?: true;
  readonly outside?: string;
  readonly source_path?: Buffer;
  readonly scratch_path?: Buffer;
  readonly counterexample?: number;
  readonly input_path?: Buffer;
}

const NS_DIR: Readonly<Record<"scratch" | "files", Buffer>> = {
  scratch: Buffer.from(DISPUTE_EVIDENCE_SCRATCH_DIR),
  files: Buffer.from(DISPUTE_EVIDENCE_FILES_DIR),
};
const CHECK_STDIN = Buffer.from("check/stdin");

/** Where an input entry goes in the evidence directory. */
function evidencePathOf(entry: RecheckInputEntry): Buffer {
  return entry.ns === "stdin" ? CHECK_STDIN : beneath(NS_DIR[entry.ns], entry.path);
}

/** Where a link's target was captured in the evidence directory (E1'): the
 * evidence path of the entry it leads to — `scratch` itself for the scratch's
 * root — or nothing, when it led outside what was snapshotted. */
function evidencePathOfReach(reach: RecheckInputReach): { readonly resolves_to: Buffer; readonly absent?: true } | { readonly outside: string } {
  if ("outside" in reach) return { outside: reach.outside };
  const at = reach.to === "stdin" ? CHECK_STDIN : reach.path.length === 0 ? Buffer.from(NS_DIR[reach.to]) : beneath(NS_DIR[reach.to], reach.path);
  return { resolves_to: at, ...(reach.absent === true ? { absent: true as const } : {}) };
}

/** The inputs of the failing run, read from the store and held to their
 * digests: what the evidence writes, or what is missing. */
function planInputs(snapshot: RecheckInputSnapshot, store: RecheckInputStore, missing: string[]): {
  readonly files: EvidenceEntry[];
  readonly links: EvidenceLinkEntry[];
  readonly dirs: Buffer[];
  readonly stdin?: EvidenceEntry;
} {
  const files: EvidenceEntry[] = [];
  const links: EvidenceLinkEntry[] = [];
  const dirs: Buffer[] = [];
  let stdin: EvidenceEntry | undefined;
  for (const entry of snapshot.entries) {
    const name = `${entry.ns === "files" ? "verifier file" : entry.ns === "scratch" ? "scratch entry" : "stdin"} ${JSON.stringify(displayPath(entry.path).slice(0, 200))}`;
    if (entry.ns !== "stdin" && !isPlainRelative(entry.path)) {
      missing.push(`the ${name} of its failing run is not a relative path`);
      continue;
    }
    const at = evidencePathOf(entry);
    const origin = entry.ns === "files" ? { source_path: entry.path } : entry.ns === "scratch" ? { scratch_path: entry.path } : {};
    if (entry.type === "other") {
      missing.push(`the ${name} its failing run had is neither a file, a link nor a directory, so it cannot be delivered`);
      continue;
    }
    if (entry.type === "dir") {
      dirs.push(at);
      continue;
    }
    if (entry.type === "link") {
      links.push({ path: at, target: entry.target, ...evidencePathOfReach(entry.reach), ...origin });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = store.read(entry.sha256, entry.bytes);
    } catch (error) {
      missing.push(`the ${name} its failing run had: ${message(error).slice(0, 200)}`);
      continue;
    }
    const file: EvidenceEntry = { path: at, bytes, mode: entry.mode, sha256: entry.sha256, ...origin };
    if (entry.ns === "stdin") stdin = file;
    else files.push(file);
  }
  return { files, links, dirs, ...(stdin === undefined ? {} : { stdin }) };
}

/**
 * A property's counterexample inputs (D58, E1): for each counterexample of
 * the failing run, the snapshot of the input its case generated, taken as
 * the case ended, read from the run's store and held to its digests —
 * written under `counterexamples/<k>/input/<path>` (files with their modes,
 * links with their exact targets and where they were captured, directories).
 * A counterexample whose input was not snapshotted, was over its bounds, has
 * a link that led outside it or ran in a sandbox that did not confine it
 * makes the evidence incomplete, as an input of the run does.
 */
function planCounterexampleInputs(observation: DisputeEvidenceMaterial["observation"], run: string, missing: string[]): {
  readonly files: EvidenceEntry[];
  readonly links: EvidenceLinkEntry[];
  readonly dirs: Buffer[];
} {
  const files: EvidenceEntry[] = [];
  const links: EvidenceLinkEntry[] = [];
  const dirs: Buffer[] = [];
  (observation?.property?.counterexamples ?? []).forEach((item, index) => {
    const k = index + 1;
    const base = Buffer.from(`${DISPUTE_EVIDENCE_COUNTEREXAMPLES_DIR}/${k}/input`);
    const what = `counterexample ${k} (seed ${item.seed}, case ${item.case}) of ${run}`;
    const record = item.input;
    if (record.snapshot === undefined || record.file === undefined || record.reason !== undefined || record.bounded === "exceeded") {
      missing.push(...(recheckInputsGaps(record, what).length > 0 ? recheckInputsGaps(record, what) : [`${what} names no snapshot of its input`]));
      return;
    }
    let snapshot: RecheckInputSnapshot;
    let store: RecheckInputStore;
    try {
      ({ snapshot, store } = readRecheckInputs(record));
    } catch (error) {
      missing.push(`the input of ${what}: ${message(error).slice(0, 200)}`);
      return;
    }
    missing.push(...recheckSnapshotGaps(snapshot, what));
    const outside = snapshot.entries.filter((entry) => entry.type === "link" && "outside" in entry.reach).length;
    const unconfined = CONFINING_FENCES.has(snapshot.fence) ? undefined : snapshot.fence;
    if ((record.outside ?? 0) !== outside || record.unconfined !== unconfined) {
      missing.push(`the row's record of the input of ${what} does not say what its snapshot says`);
    }
    dirs.push(base);
    for (const entry of snapshot.entries) {
      const name = `input entry ${JSON.stringify(displayPath(entry.path).slice(0, 200))} of ${what}`;
      if (!isPlainRelative(entry.path)) {
        missing.push(`the ${name} is not a relative path`);
        continue;
      }
      const at = beneath(base, entry.path);
      const origin = { counterexample: k, input_path: entry.path };
      if (entry.type === "other") {
        missing.push(`the ${name} is neither a file, a link nor a directory, so it cannot be delivered`);
        continue;
      }
      if (entry.type === "dir") {
        dirs.push(at);
        continue;
      }
      if (entry.type === "link") {
        const reach = "outside" in entry.reach
          ? { outside: entry.reach.outside }
          : { resolves_to: entry.reach.path.length === 0 ? Buffer.from(base) : beneath(base, entry.reach.path), ...(entry.reach.absent === true ? { absent: true as const } : {}) };
        links.push({ path: at, target: entry.target, ...reach, ...origin });
        continue;
      }
      try {
        files.push({ path: at, bytes: store.read(entry.sha256, entry.bytes), mode: entry.mode, sha256: entry.sha256, ...origin });
      } catch (error) {
        missing.push(`the ${name}: ${message(error).slice(0, 200)}`);
      }
    }
  });
  return { files, links, dirs };
}

/** The evidence of one dispute, written and read back below the verifier's
 * scratch as a pinned root (S1). */
function deliverOne(
  root: SafeRoot,
  base: Buffer,
  item: DisputeEvidenceMaterial,
  bounds: { readonly bytes: number; readonly files: number },
  used: { bytes: number; files: number },
): DisputeEvidence {
  const relativeDir = `${DISPUTE_EVIDENCE_DIR}/${item.index}`;
  const dirRel = beneath(base, Buffer.from(String(item.index)));
  const dir = join(root.text, relativeDir);
  const missing: string[] = [];
  const { dispute, recorded, observation } = item;
  const json = (path: string, value: unknown): EvidenceEntry => {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    return { path: Buffer.from(path), bytes, mode: 0o644, sha256: sha256(bytes) };
  };

  // The run the evidence is of (D57): the check's failing recheck and the
  // snapshot of its inputs, taken before it ran.
  let snapshot: RecheckInputSnapshot | undefined;
  let store: RecheckInputStore | undefined;
  const run = observation === undefined ? "" : `its failing recheck (round ${observation.round})`;
  if (observation === undefined) {
    missing.push("no recheck of the check ran red since it was last green, so no run's inputs show what it asserts");
  } else {
    const record = observation.inputs;
    // What the row's record itself says stands in the way (E1'): none taken,
    // over its bounds, links that led outside, an unconfined sandbox.
    const recorded = recheckInputsGaps(record, run);
    if (record === undefined || record.snapshot === undefined || record.file === undefined || record.reason !== undefined || record.bounded === "exceeded") {
      missing.push(...recorded);
    } else {
      try {
        ({ snapshot, store } = readRecheckInputs(record));
      } catch (error) {
        missing.push(`what ${run} ran with: ${message(error).slice(0, 200)}`, ...recorded);
      }
      if (snapshot !== undefined) {
        // The snapshot's own account, held to its digest; the row's record
        // must say the same of it.
        missing.push(...recheckSnapshotGaps(snapshot, run));
        const outside = snapshot.entries.filter((entry) => entry.type === "link" && "outside" in entry.reach).length;
        const unconfined = CONFINING_FENCES.has(snapshot.fence) ? undefined : snapshot.fence;
        if ((record.outside ?? 0) !== outside || record.unconfined !== unconfined) {
          missing.push(`the row's record of what ${run} ran with does not say what its snapshot says`);
        }
      }
    }
  }
  if (snapshot !== undefined && snapshot.bounded === "exceeded") {
    missing.push(`what ${run} ran with was over the snapshot's bounds, so it was not recorded`);
    snapshot = undefined;
  }
  // The keep behind a reported check's overlaid files (D47, D55): one that
  // did not run, failed, or left files behind exceeded its own bound.
  if (dispute.kind === "reported" && snapshot !== undefined) {
    const keep = snapshot.keep;
    if (keep === undefined || !keep.kept) missing.push("the files its verifier authored were not kept (the run kept no verifier files)");
    else {
      if (keep.reason !== undefined) missing.push(`the files its verifier authored could not be kept: ${keep.reason.slice(0, 200)}`);
      if (keep.skipped > 0) missing.push(`${keep.skipped} file(s) its verifier authored were left behind by the keep (over a bound, or not a regular file)`);
      if ((keep.notOverlaid ?? 0) > 0) missing.push(`${keep.notOverlaid} file(s) its verifier authored did not reach the recheck copy as kept`);
    }
  }
  const planned: { readonly files: EvidenceEntry[]; readonly links: EvidenceLinkEntry[]; readonly dirs: Buffer[]; readonly stdin?: EvidenceEntry } =
    snapshot === undefined || store === undefined ? { files: [], links: [], dirs: [] } : planInputs(snapshot, store, missing);
  // A property's counterexamples (D58): the inputs its failing run's cases
  // generated, each captured as its case ended.
  const generated = planCounterexampleInputs(observation, run, missing);
  const inputs = {
    files: [...planned.files, ...generated.files],
    links: [...planned.links, ...generated.links],
    dirs: [...planned.dirs, ...generated.dirs],
    ...(planned.stdin === undefined ? {} : { stdin: planned.stdin }),
  };

  // The check as recorded, with its stdin and fixtures as files of their own:
  // texts from the row, or from the failing run's inputs by digest — never
  // from a store the run itself could change.
  const entries: EvidenceEntry[] = [];
  const identity = { source: dispute.source, case: dispute.case, spec: dispute.spec };
  const captured = new Map((snapshot === undefined ? [] : snapshot.entries).flatMap((entry) => (entry.type === "file" ? [[entry.sha256, entry] as const] : [])));
  const textOfRecord = (text: { readonly digest: string; readonly bytes: number; readonly content?: string }): Buffer | undefined => {
    if (typeof text.content === "string") {
      const bytes = Buffer.from(text.content);
      return sha256(bytes) === text.digest ? bytes : undefined;
    }
    const entry = captured.get(text.digest);
    if (entry === undefined || entry.type !== "file" || store === undefined) return undefined;
    try {
      return store.read(entry.sha256, entry.bytes);
    } catch {
      return undefined;
    }
  };
  if (recorded === undefined) {
    missing.push("the check as recorded is not held by this run");
    entries.push(json("check.json", { identity, kind: dispute.kind, command: dispute.command, ...(dispute.dir === undefined ? {} : { dir: dispute.dir }) }));
  } else {
    // D58c V5': the recorded texts in the shapes the check tool records —
    // another writer's row may hold anything, and one malformed case must not
    // take the evidence of the others down with it.
    const stdin = recorded.stdin === undefined ? undefined : recordedCheckTextOf(recorded.stdin);
    if (recorded.stdin !== undefined && stdin === undefined) missing.push("the check's stdin is not a text the check tool records");
    const recordedFiles = typeof recorded.files === "object" && recorded.files !== null && !Array.isArray(recorded.files) ? recorded.files : undefined;
    if (recorded.files !== undefined && recordedFiles === undefined) missing.push("the check's fixtures are not a map of recorded texts");
    let stdinFile: string | undefined;
    if (stdin !== undefined) {
      // The stdin the failing run was given is one of its inputs (D57): it is
      // delivered from the snapshot, and must be the recorded one.
      const given = inputs.stdin;
      if (snapshot !== undefined && (given === undefined || given.sha256 !== stdin.digest)) {
        missing.push(`the stdin its failing run was given is not the recorded one (sha256 ${stdin.digest})`);
      } else if (given !== undefined) {
        stdinFile = "check/stdin";
      } else {
        // No snapshot to deliver it from (already incomplete): the row's own
        // text, when it carries it, for the reader.
        const value = textOfRecord(stdin);
        if (value === undefined) missing.push(`the check's stdin is not available as recorded (sha256 ${stdin.digest})`);
        else {
          stdinFile = "check/stdin";
          entries.push({ path: CHECK_STDIN, bytes: value, mode: 0o644, sha256: sha256(value) });
        }
      }
    }
    const fixtures: Record<string, Record<string, unknown>> = {};
    for (const [path, entry] of Object.entries(recordedFiles ?? {})) {
      const recordedFixture = recordedCheckTextOf(entry);
      if (recordedFixture === undefined) {
        missing.push(`the check's fixture ${JSON.stringify(path.slice(0, 200))} is not a text the check tool records`);
        continue;
      }
      const safe = plainRelative(path);
      const value = safe === undefined ? undefined : textOfRecord(recordedFixture);
      if (safe === undefined) missing.push(`the check's fixture path ${JSON.stringify(path.slice(0, 200))} is not relative`);
      else if (value === undefined) missing.push(`the check's fixture ${safe} is not available as recorded (sha256 ${recordedFixture.digest})`);
      else entries.push({ path: Buffer.from(`check/fixtures/${safe}`), bytes: value, mode: 0o644, sha256: sha256(value) });
      fixtures[path] = {
        sha256: recordedFixture.digest,
        bytes: recordedFixture.bytes,
        ...(safe === undefined || value === undefined ? {} : { file: `check/fixtures/${safe}` }),
      };
    }
    entries.push(json("check.json", {
      identity,
      kind: recorded.kind,
      id: recorded.id,
      command: recorded.command,
      ...(recorded.dir === undefined ? {} : { dir: recorded.dir }),
      ...(recorded.timeout_ms === undefined ? {} : { timeout_ms: recorded.timeout_ms }),
      ...(stdin === undefined ? {} : { stdin: { sha256: stdin.digest, bytes: stdin.bytes, ...(stdinFile === undefined ? {} : { file: stdinFile }) } }),
      ...(recorded.files === undefined ? {} : { fixtures }),
      ...(recorded.expect === undefined ? {} : { expect: recorded.expect }),
      ...(recorded.property === undefined ? {} : { property: recorded.property }),
      ...(recorded.counterexamples === undefined ? {} : { recorded_counterexamples: recorded.counterexamples.map((ref) => [ref.seed, ref.case]) }),
    }));
  }
  // That run's observation.
  if (observation !== undefined) entries.push(json("observation.json", observation));

  // The inputs of the failing run, within what the verifier's bound leaves.
  const inputFiles = [...inputs.files, ...(inputs.stdin === undefined ? [] : [inputs.stdin])];
  const inputBytes = inputFiles.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const inputCount = inputFiles.length + inputs.links.length;
  const ownBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const bound = `the evidence bound of ${bounds.bytes} bytes and ${bounds.files} files for one verifier`;
  const fits = used.bytes + ownBytes + inputBytes <= bounds.bytes && used.files + entries.length + inputCount <= bounds.files;
  if (!fits && inputCount > 0) missing.push(`what its failing run ran with is over ${bound}`);
  const writeFiles = fits ? [...entries, ...inputFiles] : entries;
  const writeLinks = fits ? inputs.links : [];
  const writeDirs = fits ? inputs.dirs : [];

  // Written, then read back: the manifest lists what is on disk. Directories
  // first, then files, then links: nothing is ever written through a link
  // (S1: every path below the pinned scratch, each directory real).
  const files: DisputeEvidenceFile[] = [];
  const links: DisputeEvidenceLink[] = [];
  try {
    if (lstatBeneath(root, dirRel, "deliver") !== undefined) throw new Error(`the evidence directory ${relativeDir} already exists`);
    ensureDirBeneath(root, dirRel, 0o700, "deliver");
    for (const path of writeDirs) {
      if (!isPlainRelative(path)) throw new Error(`evidence path ${JSON.stringify(displayPath(path))} leaves its directory`);
      ensureDirBeneath(root, beneath(dirRel, path), 0o700, "deliver");
    }
    for (const entry of writeFiles) {
      if (!isPlainRelative(entry.path)) throw new Error(`evidence path ${JSON.stringify(displayPath(entry.path))} leaves its directory`);
      const target = beneath(dirRel, entry.path);
      writeBeneath(root, target, entry.bytes, { mode: entry.mode, parents: 0o700, operation: "deliver" });
      const back = readBeneath(root, target, "deliver");
      if (back === undefined) throw new Error(`evidence file ${JSON.stringify(displayPath(entry.path))} is gone once written`);
      const digest = sha256(back);
      if (digest !== entry.sha256 || back.length !== entry.bytes.length) throw new Error(`evidence file ${JSON.stringify(displayPath(entry.path))} was not written whole`);
      const content = entry.source_path !== undefined || entry.scratch_path !== undefined || entry.counterexample !== undefined ? textOf(back) : undefined;
      files.push({
        path: displayPath(entry.path),
        path_bytes: Buffer.from(entry.path),
        sha256: digest,
        bytes: back.length,
        mode: entry.mode,
        ...(entry.source_path === undefined ? {} : { source_path: displayPath(entry.source_path), source_path_bytes: Buffer.from(entry.source_path) }),
        ...(entry.scratch_path === undefined ? {} : { scratch_path: displayPath(entry.scratch_path), scratch_path_bytes: Buffer.from(entry.scratch_path) }),
        ...(entry.counterexample === undefined ? {} : { counterexample: entry.counterexample }),
        ...(entry.input_path === undefined ? {} : { input_path: displayPath(entry.input_path), input_path_bytes: Buffer.from(entry.input_path) }),
        ...(content === undefined ? {} : { text: content }),
      });
      used.bytes += back.length;
      used.files += 1;
    }
    for (const entry of writeLinks) {
      if (!isPlainRelative(entry.path)) throw new Error(`evidence path ${JSON.stringify(displayPath(entry.path))} leaves its directory`);
      const target = beneath(dirRel, entry.path);
      symlinkBeneath(root, target, entry.target, { parents: 0o700, operation: "deliver" });
      if (!readLinkBeneath(root, target, "deliver").equals(entry.target)) {
        throw new Error(`evidence link ${JSON.stringify(displayPath(entry.path))} was not written whole`);
      }
      links.push({
        path: displayPath(entry.path),
        path_bytes: Buffer.from(entry.path),
        target: displayPath(entry.target),
        target_bytes: Buffer.from(entry.target),
        ...(entry.resolves_to === undefined ? {} : { resolves_to: displayPath(entry.resolves_to), resolves_to_bytes: Buffer.from(entry.resolves_to) }),
        ...(entry.absent === undefined ? {} : { absent: true }),
        ...(entry.outside === undefined ? {} : { outside: entry.outside }),
        ...(entry.source_path === undefined ? {} : { source_path: displayPath(entry.source_path), source_path_bytes: Buffer.from(entry.source_path) }),
        ...(entry.scratch_path === undefined ? {} : { scratch_path: displayPath(entry.scratch_path), scratch_path_bytes: Buffer.from(entry.scratch_path) }),
        ...(entry.counterexample === undefined ? {} : { counterexample: entry.counterexample }),
        ...(entry.input_path === undefined ? {} : { input_path: displayPath(entry.input_path), input_path_bytes: Buffer.from(entry.input_path) }),
      });
      used.files += 1;
    }
    files.sort((a, b) => Buffer.compare(a.path_bytes, b.path_bytes));
    links.sort((a, b) => Buffer.compare(a.path_bytes, b.path_bytes));
    const inputsOf = observation?.inputs?.snapshot === undefined || snapshot === undefined
      ? undefined
      : { round: observation.round, snapshot: observation.inputs.snapshot, ...(snapshot.scratch === undefined ? {} : { scratch: snapshot.scratch }) };
    const b64 = (bytes: Buffer) => bytes.toString("base64");
    const manifest = Buffer.from(`${JSON.stringify({
      version: 2,
      ...(inputsOf === undefined ? {} : { inputs: inputsOf }),
      files: files.map((file) => ({
        path: file.path,
        path_b64: b64(file.path_bytes),
        sha256: file.sha256,
        bytes: file.bytes,
        mode: file.mode,
        ...(file.source_path_bytes === undefined ? {} : { source_path_b64: b64(file.source_path_bytes) }),
        ...(file.scratch_path_bytes === undefined ? {} : { scratch_path_b64: b64(file.scratch_path_bytes) }),
        ...(file.counterexample === undefined ? {} : { counterexample: file.counterexample }),
        ...(file.input_path_bytes === undefined ? {} : { input_path_b64: b64(file.input_path_bytes) }),
      })),
      ...(links.length === 0 ? {} : {
        links: links.map((link) => ({
          path: link.path,
          path_b64: b64(link.path_bytes),
          target: link.target,
          target_b64: b64(link.target_bytes),
          ...(link.resolves_to_bytes === undefined ? {} : { resolves_to: link.resolves_to, resolves_to_b64: b64(link.resolves_to_bytes) }),
          ...(link.absent === true ? { absent: true } : {}),
          ...(link.outside === undefined ? {} : { outside: link.outside }),
          ...(link.source_path_bytes === undefined ? {} : { source_path_b64: b64(link.source_path_bytes) }),
          ...(link.scratch_path_bytes === undefined ? {} : { scratch_path_b64: b64(link.scratch_path_bytes) }),
          ...(link.counterexample === undefined ? {} : { counterexample: link.counterexample }),
          ...(link.input_path_bytes === undefined ? {} : { input_path_b64: b64(link.input_path_bytes) }),
        })),
      }),
      ...(writeDirs.length === 0 ? {} : { dirs: [...writeDirs].sort(Buffer.compare).map((path) => ({ path: displayPath(path), path_b64: b64(path) })) }),
    }, null, 2)}\n`);
    const manifestRel = beneath(dirRel, Buffer.from("manifest.json"));
    writeBeneath(root, manifestRel, manifest, { mode: 0o644, operation: "deliver" });
    const back = readBeneath(root, manifestRel, "deliver");
    if (back === undefined || !back.equals(manifest)) throw new Error("the manifest was not written whole");
    const scratchFiles = files.filter((file) => file.scratch_path_bytes !== undefined).length;
    const scratchLinks = links.filter((link) => link.scratch_path_bytes !== undefined).length;
    return {
      index: item.index,
      dir,
      relative: relativeDir,
      complete: missing.length === 0,
      missing,
      manifest: { sha256: sha256(manifest), files, ...(links.length === 0 ? {} : { links }) },
      ...(observation === undefined ? {} : { observation }),
      ...(inputsOf === undefined ? {} : { inputs: inputsOf }),
      ...(inputsOf?.scratch === undefined
        ? {}
        : { scratch: { source: inputsOf.scratch, dir: DISPUTE_EVIDENCE_SCRATCH_DIR, snapshot: inputsOf.snapshot, files: scratchFiles, links: scratchLinks } }),
    };
  } catch (error) {
    return {
      index: item.index,
      dir,
      relative: relativeDir,
      complete: false,
      missing: [...missing, `the evidence could not be written: ${message(error).slice(0, 200)}`],
      ...(observation === undefined ? {} : { observation }),
    };
  }
}
