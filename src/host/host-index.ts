import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedAtBase, treeCoverageNow } from "./base-record.ts";
import { coverageOf, walkCovered, type CoverageBase } from "./coverage.ts";
import { spawnSealedHostGit } from "./git-authority.ts";
import { beneath, isPlainRelative, splitNul } from "../work/path-bytes.ts";

/**
 * THE HOST NEVER READS THE SESSION'S INDEX AS AUTHORITY (I2, D57g, design
 * memo §120/§121).
 *
 * spawnSealedHostGit gives git a fresh, empty index of its own; the tree's
 * index — its entries, flags, paths (`../outside.txt`) — is never read. Where
 * a reader needs git to compare the work tree (status, diff, the delivered
 * state's commit, a patch), the host builds the index here from ITS OWN
 * listing of the tree (walkCovered under the tree's rules as the host
 * evaluates them, gitignore.ts — never git's ignore machinery): every path a
 * canonical relative byte path beneath the root, every blob hashed from the
 * bytes the host lists with `hash-object --no-filters` (no attribute, no
 * filter, no eol conversion) and entered with `update-index --index-info`
 * (git reads no work-tree file for it). A path that is not canonical is
 * refused and recorded, never walked.
 */

export interface HostWorkTreeEntry {
  readonly path: Buffer;
  readonly mode: "100644" | "100755" | "120000";
}

/** The work tree as the host lists it: content-covered files and links
 * under the tree's own rules (host-evaluated) and the paths HEAD tracks;
 * with `includeIgnored`, what the rules ignore as well, and with
 * `includeExcluded`, what the host covers by state though no rule ignores
 * it (`node_modules`, `__pycache__`, `.pytest_cache`) — never `.git`. */
export function hostWorkTreeListing(root: string, options: { readonly includeIgnored?: boolean; readonly includeExcluded?: boolean; readonly coverage?: CoverageBase; readonly tracked?: ReadonlySet<string> } = {}): HostWorkTreeEntry[] {
  const tracked = () => options.tracked ?? new Set(trackedAtBase(root).tracked.keys());
  const coverage = options.coverage ?? (options.includeIgnored === true
    ? coverageOf("tree", tracked(), new Map())
    : treeCoverageNow(root, tracked()));
  const walked = walkCovered(root, coverage);
  const out: HostWorkTreeEntry[] = [];
  const add = (path: Buffer, stat: { isSymbolicLink(): boolean; isFile(): boolean; mode: number | bigint }) => {
    if (!isPlainRelative(path)) return;
    if (stat.isSymbolicLink()) out.push({ path, mode: "120000" });
    else if (stat.isFile()) out.push({ path, mode: (Number(stat.mode) & 0o111) !== 0 ? "100755" : "100644" });
  };
  for (const entry of walked.entries) add(entry.path, entry.stat);
  if (options.includeIgnored === true || options.includeExcluded === true) {
    for (const region of walked.regions) {
      if (region.path.toString("latin1").split("/").includes(".git")) continue;
      if (options.includeIgnored !== true && region.why !== "excluded") continue;
      for (const item of region.items) add(item.path, item.stat);
    }
  }
  out.sort((a, b) => Buffer.compare(a.path, b.path));
  return out;
}

function mustGit(root: string, args: readonly string[], env: Readonly<Record<string, string>>, input?: Buffer, timeoutMs?: number): Buffer {
  const result = spawnSealedHostGit(root, args, {
    extraEnv: env,
    ...(input === undefined ? {} : { input }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(`git ${args.find((arg) => !arg.startsWith("-")) ?? ""} failed: ${result.stderr.toString().trim().slice(0, 300)}`);
  }
  return result.stdout;
}

/**
 * Stage the host's listing of `root` into the index `env.GIT_INDEX_FILE`
 * (emptied first), objects written to the store `env` names (or the tree's).
 * Gitlinks HEAD records for a directory still there are kept as HEAD has
 * them. Returns the listing staged.
 */
export function stageHostListing(
  root: string,
  env: Readonly<Record<string, string>> & { readonly GIT_INDEX_FILE: string },
  options: { readonly includeIgnored?: boolean; readonly timeoutMs?: number; readonly writeObjects?: boolean } = {},
): HostWorkTreeEntry[] {
  // HEAD read once: what it tracks (the coverage) and its gitlinks.
  const head = trackedAtBase(root);
  const listing = hostWorkTreeListing(root, { tracked: new Set(head.tracked.keys()), ...(options.includeIgnored === undefined ? {} : { includeIgnored: options.includeIgnored }) });
  // A fresh index file is already empty; one that exists is emptied.
  if (existsSync(env.GIT_INDEX_FILE)) mustGit(root, ["read-tree", "--empty"], env, undefined, options.timeoutMs);
  const write = options.writeObjects === false ? [] : ["-w"];
  const lines: Buffer[] = [];
  // Nothing to write and the object format known (HEAD's id): the host
  // computes each blob id itself — git's own `blob <size>\0<bytes>` hash of
  // the bytes it reads (never through a link), no git process at all.
  const format = head.head?.length === 64 ? "sha256" : head.head?.length === 40 ? "sha1" : undefined;
  if (options.writeObjects === false && format !== undefined) {
    for (const entry of listing) {
      const full = beneath(root, entry.path);
      let bytes: Buffer;
      try {
        bytes = entry.mode === "120000" ? readlinkSync(full, { encoding: "buffer" }) as Buffer : readBounded(full);
      } catch {
        continue;
      }
      const oid = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      lines.push(Buffer.concat([Buffer.from(`${entry.mode} ${oid}\t`), entry.path, Buffer.alloc(1)]));
    }
  }
  // Regular files by path (one batch: names without a newline), each hashed
  // from its bytes with no filter; a name with a newline, and every link's
  // target bytes, one at a time on stdin.
  const hashed = lines.length > 0 || (options.writeObjects === false && format !== undefined);
  const batch = hashed ? [] : listing.filter((entry) => entry.mode !== "120000" && !entry.path.includes(0x0a));
  if (batch.length > 0) {
    const oids = mustGit(root, ["hash-object", ...write, "--no-filters", "--stdin-paths"], env,
      Buffer.concat(batch.flatMap((entry) => [entry.path, Buffer.from("\n")])), options.timeoutMs).toString("latin1").trim().split("\n");
    if (oids.length !== batch.length) throw new Error("git hash-object did not hash every listed path");
    batch.forEach((entry, index) => lines.push(Buffer.concat([Buffer.from(`${entry.mode} ${oids[index]}\t`), entry.path, Buffer.alloc(1)])));
  }
  for (const entry of hashed ? [] : listing) {
    if (entry.mode !== "120000" && !entry.path.includes(0x0a)) continue;
    const full = beneath(root, entry.path);
    let bytes: Buffer;
    try {
      bytes = entry.mode === "120000" ? readlinkSync(full, { encoding: "buffer" }) as Buffer : readBounded(full);
    } catch {
      continue;
    }
    const oid = mustGit(root, ["hash-object", ...write, "--no-filters", "--stdin"], env, bytes, options.timeoutMs).toString("latin1").trim();
    lines.push(Buffer.concat([Buffer.from(`${entry.mode} ${oid}\t`), entry.path, Buffer.alloc(1)]));
  }
  // Gitlinks HEAD records (a nested repository's commit), kept as recorded
  // while their directory is still a directory.
  for (const [key, oid] of head.gitlinks) {
    const path = Buffer.from(key, "latin1");
    try {
      if (!lstatSync(beneath(root, path)).isDirectory()) continue;
    } catch {
      continue;
    }
    lines.push(Buffer.concat([Buffer.from(`160000 ${oid}\t`), path, Buffer.alloc(1)]));
  }
  if (lines.length > 0) mustGit(root, ["update-index", "-z", "--index-info"], env, Buffer.concat(lines), options.timeoutMs);
  return listing;
}

/** A regular file's bytes, never through a link (O_NOFOLLOW), never
 * blocking on a FIFO. */
function readBounded(path: Buffer): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Run `fn` with a host-built index of `root` (I2): a private index file in a
 * host-owned temporary directory, the host's listing staged into it; removed
 * afterwards. `fn` gets the environment to hand spawnSealedHostGit.
 */
export function withHostBuiltIndex<T>(
  root: string,
  fn: (env: Readonly<Record<string, string>> & { readonly GIT_INDEX_FILE: string }) => T,
  options: { readonly includeIgnored?: boolean; readonly timeoutMs?: number; readonly writeObjects?: boolean; readonly extraEnv?: Readonly<Record<string, string>> } = {},
): T {
  const dir = mkdtempSync(join(tmpdir(), "dokkabi-host-index-"));
  try {
    const env = { ...(options.extraEnv ?? {}), GIT_INDEX_FILE: join(dir, "index") };
    stageHostListing(root, env, options);
    return fn(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `git add -A` + `write-tree`, from the host's own listing (I2): the tree
 * object of the work tree as the host lists it, written to the store the
 * environment names (or the tree's). Never git's own `add`, which starts a
 * git inside a populated submodule, and never the tree's index.
 */
export function stageTreeSealed(
  root: string,
  options: { readonly extraEnv?: Readonly<Record<string, string>>; readonly includeIgnored?: boolean; readonly timeoutMs?: number } = {},
): string {
  return withHostBuiltIndex(root, (env) => mustGit(root, ["write-tree"], env, undefined, options.timeoutMs).toString("latin1").trim(), options);
}

/** The paths HEAD tracks of `paths` (I2: HEAD's tree, never the index). */
export function trackedInHead(root: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const result = spawnSealedHostGit(root, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD", "--", ...paths]);
  if ((result.exitCode ?? 1) !== 0) return new Set();
  return new Set(splitNul(result.stdout).map((path) => path.toString()));
}
