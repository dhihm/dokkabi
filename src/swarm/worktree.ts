import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { sealedGitConfigFile, spawnSealedHostGit } from "../host/git-authority.ts";
import { stageTreeSealed, withHostBuiltIndex } from "../host/host-index.ts";
import { trustedGitMetadata } from "../host/sandbox-docker.ts";
import {
  materializeRuntimeArtifacts,
  runtimeArtifactManifest,
  type RuntimeArtifactManifest,
} from "./runtime-artifacts.ts";

export interface WorktreeSnapshot {
  sourceRoot: string;
  head: string;
  tree: string;
  commit: string;
  digest: string;
  runtimeArtifacts: RuntimeArtifactManifest;
  captureRuntimeArtifacts?: boolean;
  transientObjectDirectory?: string;
  transientObjectRoot?: string;
}

export interface SnapshotWorktree {
  root: string;
  commit: string;
  snapshotDigest: string;
}

export interface WorktreeDelta {
  patch: string;
  patchDigest: string;
  finalTree: string;
}

const SNAPSHOT_COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "Dokkabi",
  GIT_AUTHOR_EMAIL: "dokkabi@local.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
  GIT_COMMITTER_NAME: "Dokkabi",
  GIT_COMMITTER_EMAIL: "dokkabi@local.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
});

const TRANSIENT_OBJECT_PREFIX = "dokkabi-swarm-objects-";
const ownedTransientObjectRoots = new Set<string>();

function snapshotObjectEnv(snapshot: WorktreeSnapshot): Record<string, string> {
  if (!snapshot.transientObjectDirectory) return {};
  const metadata = trustedGitMetadata(snapshot.sourceRoot);
  if (!metadata) throw new Error("swarm snapshot Git metadata is not trusted");
  return {
    GIT_OBJECT_DIRECTORY: snapshot.transientObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: realpathSync(join(metadata.commonDir ?? metadata.gitDir, "objects")),
  };
}

function runGit(root: string, args: readonly string[], extraEnv: Record<string, string> = {}, hostMadeIndex = false): string {
  return runGitRaw(root, args, extraEnv, hostMadeIndex).trim();
}

function runGitRaw(root: string, args: readonly string[], extraEnv: Record<string, string> = {}, hostMadeIndex = false): string {
  const result = spawnSealedHostGit(root, args, { extraEnv, ...(hostMadeIndex ? { treeIndex: "host-made" as const } : {}) });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.toString();
}

function runGitInput(root: string, args: readonly string[], input: string, hostMadeIndex = false): void {
  const result = spawnSealedHostGit(root, args, { input, ...(hostMadeIndex ? { treeIndex: "host-made" as const } : {}) });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`);
  }
}

/** The source's state as git states it against HEAD — over an index the
 * host built from its own listing (I2, D57g), never the source's index. */
function sourceState(root: string): string {
  return withHostBuiltIndex(root, (env) => runGit(root, ["diff", "--cached", "--no-renames", "--name-status", "-z", "--no-ext-diff", "--no-textconv", "HEAD"], { ...env }), { writeObjects: false });
}

export function captureWorktreeSnapshot(
  sourceRoot: string,
  options: { readonly runtimeArtifacts?: boolean; readonly isolatedObjects?: boolean } = {},
): WorktreeSnapshot {
  return captureSnapshot(sourceRoot, options);
}

function captureSnapshot(
  sourceRoot: string,
  options: { readonly runtimeArtifacts?: boolean; readonly isolatedObjects?: boolean },
  transient?: Pick<WorktreeSnapshot, "transientObjectDirectory" | "transientObjectRoot">,
): WorktreeSnapshot {
  const requested = realpathSync(resolve(sourceRoot));
  const root = realpathSync(runGit(requested, ["rev-parse", "--show-toplevel"]));
  if (root !== requested) {
    throw new Error("swarm snapshot root differs from the requested canonical workspace");
  }
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const before = sourceState(root);
  const captureRuntimeArtifacts = options.runtimeArtifacts !== false;
  const runtimeArtifacts = captureRuntimeArtifacts
    ? runtimeArtifactManifest(root)
    : { paths: [], digest: createHash("sha256").digest("hex") };
  const indexRoot = mkdtempSync(join(tmpdir(), "dokkabi-swarm-index-"));
  const indexPath = join(indexRoot, "index");
  let transientObjectRoot = transient?.transientObjectRoot;
  let transientObjectDirectory = transient?.transientObjectDirectory;
  let allocatedObjectRoot = false;
  try {
    if (options.isolatedObjects && !transientObjectRoot) {
      transientObjectRoot = realpathSync(mkdtempSync(join(tmpdir(), TRANSIENT_OBJECT_PREFIX)));
      ownedTransientObjectRoots.add(transientObjectRoot);
      allocatedObjectRoot = true;
      transientObjectDirectory = join(transientObjectRoot, "objects");
      mkdirSync(transientObjectDirectory, { mode: 0o700 });
    }
    const snapshot = {
      sourceRoot: root,
      head,
      tree: "",
      commit: "",
      digest: "",
      runtimeArtifacts,
      captureRuntimeArtifacts,
      ...(transientObjectDirectory ? { transientObjectDirectory } : {}),
      ...(transientObjectRoot ? { transientObjectRoot } : {}),
    } satisfies WorktreeSnapshot;
    const env = { GIT_INDEX_FILE: indexPath, ...snapshotObjectEnv(snapshot) };
    // The tree as the host lists it (I2, D57g), its blobs in the snapshot's
    // store.
    const tree = stageTreeSealed(root, { extraEnv: snapshotObjectEnv(snapshot) });
    const commit = deterministicSnapshotCommit(root, tree, head, env);
    const currentRuntimeArtifacts = captureRuntimeArtifacts
      ? runtimeArtifactManifest(root)
      : runtimeArtifacts;
    if (
      runGit(root, ["rev-parse", "HEAD"]) !== head
      || sourceState(root) !== before
      || currentRuntimeArtifacts.digest !== runtimeArtifacts.digest
    ) {
      throw new Error("source worktree changed while capturing swarm snapshot");
    }
    const digest = createHash("sha256")
      .update(`${head}\0${tree}\0${before}\0${runtimeArtifacts.digest}`)
      .digest("hex");
    return {
      sourceRoot: root,
      head,
      tree,
      commit,
      digest,
      runtimeArtifacts,
      captureRuntimeArtifacts,
      ...(transientObjectDirectory ? { transientObjectDirectory } : {}),
      ...(transientObjectRoot ? { transientObjectRoot } : {}),
    };
  } catch (error) {
    if (allocatedObjectRoot && transientObjectRoot) {
      ownedTransientObjectRoots.delete(transientObjectRoot);
      rmSync(transientObjectRoot, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(indexRoot, { recursive: true, force: true });
  }
}

export function releaseWorktreeSnapshot(snapshot: WorktreeSnapshot): void {
  const root = snapshot.transientObjectRoot;
  if (!root || !ownedTransientObjectRoots.delete(root)) return;
  rmSync(root, { recursive: true, force: true });
}

export function allocateSnapshotWorktree(snapshot: WorktreeSnapshot, targetRoot: string): SnapshotWorktree {
  const target = resolve(targetRoot);
  if (existsSync(target)) {
    throw new Error(`swarm worktree target already exists: ${target}`);
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    initializeStandaloneGit(target);
    importSnapshotHistory(snapshot, target);
    chmodSync(target, 0o700);
    materializeSnapshotTree(snapshot, target);
    // The target is a repository the host made: its own index (I2).
    const tree = runGit(target, ["write-tree"], {}, true);
    if (tree !== snapshot.tree) {
      throw new Error(`swarm worktree tree mismatch at ${target}`);
    }
    const commit = deterministicSnapshotCommit(target, tree, snapshot.head);
    if (commit !== snapshot.commit) {
      throw new Error(`swarm worktree commit mismatch at ${target}`);
    }
    runGit(target, ["update-ref", "--no-deref", "HEAD", commit]);
    sanitizeStandaloneGitMetadata(snapshot.sourceRoot, target);
    const verifiedTree = runGit(target, ["rev-parse", "HEAD^{tree}"]);
    if (verifiedTree !== snapshot.tree) {
      throw new Error(`swarm worktree tree mismatch at ${target}`);
    }
    materializeRuntimeArtifacts(snapshot.sourceRoot, target, snapshot.runtimeArtifacts);
    if (sourceState(target) !== "") {
      throw new Error(`swarm worktree is not clean after allocation at ${target}`);
    }
    return { root: target, commit: snapshot.commit, snapshotDigest: snapshot.digest };
  } catch (error) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function removeSnapshotWorktree(sourceRoot: string, targetRoot: string): void {
  const source = realpathSync(resolve(sourceRoot));
  const target = realpathSync(resolve(targetRoot));
  const sourceFromTarget = relative(target, source);
  const targetContainsSource = sourceFromTarget !== "" && sourceFromTarget !== ".." &&
    !sourceFromTarget.startsWith(`..${sep}`) && !isAbsolute(sourceFromTarget);
  if (source === target || targetContainsSource) {
    throw new Error("refusing to remove a swarm worktree that contains the source");
  }
  const metadata = trustedGitMetadata(target);
  if (!metadata || metadata.commonDir !== undefined ||
    realpathSync(join(target, ".git")) !== metadata.gitDir) {
    throw new Error("refusing to remove a non-standalone swarm worktree");
  }
  rmSync(target, { recursive: true, force: true });
}

export function captureWorktreeDelta(base: WorktreeSnapshot, targetRoot: string): WorktreeDelta {
  const final = captureWorktreeSnapshot(targetRoot);
  if (final.head !== base.commit) {
    throw new Error("swarm child changed HEAD instead of leaving a workspace result");
  }
  const patch = runGitRaw(targetRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    base.commit,
    final.commit,
    "--",
    ".",
  ]);
  return {
    patch,
    patchDigest: createHash("sha256").update(patch).digest("hex"),
    finalTree: final.tree,
  };
}

/**
 * The delta a step left IN PLACE in the operator's workspace.
 */
export function captureInPlaceDelta(
  base: WorktreeSnapshot,
  targetRoot: string,
  options: { readonly allowHeadChange?: boolean } = {},
): WorktreeDelta {
  const final = captureSnapshot(
    targetRoot,
    {
      runtimeArtifacts: base.captureRuntimeArtifacts !== false,
      isolatedObjects: base.transientObjectDirectory !== undefined,
    },
    base,
  );
  if (final.head !== base.head && options.allowHeadChange !== true) {
    throw new Error("work step changed HEAD instead of leaving a workspace result");
  }
  const patch = runGitRaw(targetRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    base.commit,
    final.commit,
    "--",
    ".",
  ], snapshotObjectEnv(base));
  return {
    patch,
    patchDigest: createHash("sha256").update(patch).digest("hex"),
    finalTree: final.tree,
  };
}

export function applyWorktreeDelta(base: WorktreeSnapshot, delta: WorktreeDelta): WorktreeSnapshot {
  const current = captureWorktreeSnapshot(base.sourceRoot);
  if (current.digest !== base.digest) {
    throw new Error("source worktree changed while swarm children were running");
  }
  return applyVerifiedDelta(base.sourceRoot, delta);
}

export function applyWorktreeDeltaToTarget(
  base: WorktreeSnapshot,
  delta: WorktreeDelta,
  targetRoot: string,
): WorktreeSnapshot {
  const target = captureWorktreeSnapshot(targetRoot);
  if (
    target.head !== base.commit
    || target.tree !== base.tree
    || target.runtimeArtifacts.digest !== base.runtimeArtifacts.digest
  ) {
    throw new Error("reviewer worktree changed before candidate seeding");
  }
  return applyVerifiedDelta(targetRoot, delta);
}

function applyVerifiedDelta(targetRoot: string, delta: WorktreeDelta): WorktreeSnapshot {
  if (delta.patch.length > 0) {
    runGitInput(targetRoot, ["apply", "--check", "--binary", "-"], delta.patch);
    runGitInput(targetRoot, ["apply", "--binary", "-"], delta.patch);
  }
  const applied = captureWorktreeSnapshot(targetRoot);
  if (applied.tree !== delta.finalTree) {
    throw new Error("reviewed swarm result does not reproduce its final tree");
  }
  return applied;
}

function deterministicSnapshotCommit(
  root: string,
  tree: string,
  parent: string,
  extraEnv: Record<string, string> = {},
): string {
  return runGit(root, ["commit-tree", tree, "-p", parent, "-m", "Dokkabi swarm snapshot"], {
    ...extraEnv,
    ...SNAPSHOT_COMMIT_ENV,
  });
}

/** A minimal repository of its own at `target/.git`, written without running
 * git, so the sealed host git boundary can take over from the first command.
 * Also the verifier copy's repository when the workspace's own `.git` is a
 * link into another repository (work/verify-rounds-stage.ts). */
export function initializeStandaloneGit(target: string): void {
  const gitDir = join(target, ".git");
  mkdirSync(join(gitDir, "objects"), { recursive: true, mode: 0o700 });
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/dokkabi-snapshot\n", { mode: 0o600 });
  writeFileSync(join(gitDir, "config"), [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = false",
    "",
  ].join("\n"), { mode: 0o600 });
}

/** Copy only the ancestry reachable from the captured HEAD. A private bundle
 * avoids linked metadata, repository-local clone helpers, hard links,
 * alternates, dangling objects, and refs belonging to sibling workspaces. */
function importSnapshotHistory(snapshot: WorktreeSnapshot, target: string): void {
  if (runGit(snapshot.sourceRoot, ["rev-parse", "HEAD"]) !== snapshot.head) {
    throw new Error("source HEAD changed before allocating a swarm worktree");
  }
  const bundleRoot = mkdtempSync(join(tmpdir(), "dokkabi-swarm-bundle-"));
  const bundlePath = join(bundleRoot, "repository.bundle");
  try {
    const bundled = spawnSealedHostGit(snapshot.sourceRoot, [
      "bundle", "create", bundlePath, "HEAD",
    ]);
    if (bundled.exitCode !== 0) {
      throw new Error(`git bundle failed: ${bundled.stderr.toString().trim()}`);
    }
    const fetched = spawnSealedHostGit(target, [
      "-c", "protocol.file.allow=always",
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
      "--", bundlePath, "HEAD",
    ]);
    if (fetched.exitCode !== 0) {
      throw new Error(`git fetch failed: ${fetched.stderr.toString().trim()}`);
    }
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
  runGit(target, ["cat-file", "-e", `${snapshot.head}^{commit}`]);
}

/** Materialize the immutable snapshot tree without consulting mutable source
 * files. The fresh child index then hashes the same bytes into its private
 * object database, including paths ignored only because they were tracked. */
function materializeSnapshotTree(snapshot: WorktreeSnapshot, target: string): void {
  const indexRoot = mkdtempSync(join(tmpdir(), "dokkabi-swarm-checkout-index-"));
  const indexPath = join(indexRoot, "index");
  try {
    const env = { GIT_INDEX_FILE: indexPath, ...snapshotObjectEnv(snapshot) };
    runGit(snapshot.sourceRoot, ["read-tree", snapshot.commit], env);
    runGit(snapshot.sourceRoot, [
      "checkout-index", "--all", "--force", `--prefix=${target}${sep}`,
    ], env);
    // Hash materialized regular files into the private object database, then
    // restore its entries without the source index cache-tree extension. The
    // cached tree IDs may not exist in the fresh object database.
    stageTreeSealed(target, { includeIgnored: true });
    const entries = runGitRaw(snapshot.sourceRoot, ["ls-files", "--stage", "-z"], env);
    runGit(target, ["read-tree", "--empty"], {}, true);
    runGitInput(target, ["update-index", "-z", "--index-info"], entries, true);
  } finally {
    rmSync(indexRoot, { recursive: true, force: true });
  }
}

/** The target's own configuration FILE, read or written as data (S2: a
 * sealed git never reads a repository's configuration). */
function configFile(target: string, args: readonly string[]): string {
  const result = sealedGitConfigFile(target, args);
  if (result.exitCode !== 0 && !(result.exitCode === 1 && args.includes("--list"))) {
    throw new Error(`git config failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function sanitizeStandaloneGitMetadata(sourceRoot: string, target: string): void {
  configFile(target, ["core.logAllRefUpdates", "false"]);
  const gitDir = join(target, ".git");
  for (const name of ["logs", "FETCH_HEAD", "ORIG_HEAD", "COMMIT_EDITMSG"]) {
    rmSync(join(gitDir, name), { recursive: true, force: true });
  }
  const metadata = trustedGitMetadata(target);
  if (!metadata || metadata.commonDir !== undefined || realpathSync(gitDir) !== metadata.gitDir) {
    throw new Error("swarm child Git metadata is not standalone");
  }
  const forbiddenConfig = configFile(target, ["--name-only", "--list"])
    .split("\n")
    .filter(Boolean)
    .filter((key) => /^(?:branch|credential|include|includeif|remote|url)\./iu.test(key) || key === "core.worktree");
  const config = readFileSync(join(gitDir, "config"), "utf8");
  if (forbiddenConfig.length > 0 || config.includes(sourceRoot) ||
    existsSync(join(gitDir, "worktrees")) || existsSync(join(gitDir, "objects", "info", "alternates")) ||
    existsSync(join(gitDir, "objects", "info", "http-alternates"))) {
    throw new Error("swarm child Git metadata retains parent authority");
  }
}
