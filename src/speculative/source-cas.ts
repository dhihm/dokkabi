import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import { captureWorktreeSnapshot, releaseWorktreeSnapshot, type WorktreeSnapshot } from "../swarm/worktree.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export class PromotionError extends Error {
  constructor(readonly code: "busy" | "consumed" | "digest" | "source_changed" | "unsafe_target" | "apply" | "rollback") {
    super({
      busy: "another source promotion holds the mutation lock",
      consumed: "promotion authority was already consumed",
      digest: "promotion decision digest mismatch",
      source_changed: "source worktree changed before promotion",
      unsafe_target: "promotion patch contains an unsafe symlink, hardlink, or traversal target",
      apply: "promotion patch could not be applied",
      rollback: "promotion rollback was unsafe; immutable recovery evidence was preserved",
    }[code]);
    this.name = "PromotionError";
  }
}

export function parseDecisionDigest(value: string): string {
  if (!SHA256.test(value)) throw new PromotionError("digest");
  return value;
}

function gitPatch(root: string, args: readonly string[], patch: string): Buffer {
  const result = spawnSealedHostGit(root, args, { input: patch });
  if (result.exitCode !== 0) throw new PromotionError("apply");
  return result.stdout;
}

export function checkPatch(root: string, patch: string): void {
  gitPatch(root, ["apply", "--check", "--binary", "-"], patch);
}

export function applyPatch(root: string, patch: string): void {
  gitPatch(root, ["apply", "--binary", "-"], patch);
}

export function patchTargets(root: string, patch: string): readonly string[] {
  if (/^(?:rename|copy) (?:from|to) /mu.test(patch)) throw new PromotionError("unsafe_target");
  const rows = gitPatch(root, ["apply", "--numstat", "-z", "--binary", "-"], patch)
    .toString().split("\0").filter((row) => row.length > 0);
  const targets = new Set<string>();
  for (const row of rows) {
    const first = row.indexOf("\t");
    const second = row.indexOf("\t", first + 1);
    if (first < 1 || second < first + 2) throw new PromotionError("unsafe_target");
    targets.add(row.slice(second + 1));
  }
  return [...targets].sort();
}

export function assertSourceCas(base: WorktreeSnapshot): void {
  const current = captureWorktreeSnapshot(base.sourceRoot, {
    runtimeArtifacts: base.captureRuntimeArtifacts !== false,
    isolatedObjects: true,
  });
  try {
    if (current.digest !== base.digest || current.tree !== base.tree
      || current.runtimeArtifacts.digest !== base.runtimeArtifacts.digest) {
      throw new PromotionError("source_changed");
    }
  } finally {
    releaseWorktreeSnapshot(current);
  }
}

export function promotionLockPath(sourceRoot: string): string {
  const name = createHash("sha256").update(sourceRoot).digest("hex");
  return join(tmpdir(), `dokkabi-promotion-lock-${name}`);
}

function lockOwner(lock: string): { readonly pid: number; readonly token: string } {
  const value: unknown = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  if (typeof value !== "object" || value === null || !("pid" in value) || !("token" in value)
    || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.token !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(value.token)) {
    throw new PromotionError("busy");
  }
  return { pid: value.pid, token: value.token };
}

function assertProcessDead(pid: number): void {
  try {
    process.kill(pid, 0);
    throw new PromotionError("busy");
  } catch (error) {
    if (error instanceof PromotionError) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function clearOwnedDeadLock(path: string, token: string): void {
  const owner = lockOwner(path);
  if (owner.token !== token) throw new PromotionError("busy");
  assertProcessDead(owner.pid);
  rmSync(path, { recursive: true, force: true });
}

export function clearStalePromotionLock(sourceRoot: string, token: string): void {
  const lock = promotionLockPath(sourceRoot);
  if (existsSync(lock)) clearOwnedDeadLock(lock, token);
  const prefix = `${basename(lock)}.`;
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(prefix) && name.endsWith(`.${token}`)) {
      const candidate = join(tmpdir(), name);
      if (existsSync(join(candidate, "owner.json"))) {
        clearOwnedDeadLock(candidate, token);
      } else {
        const pid = Number(name.slice(prefix.length, -token.length - 1));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new PromotionError("busy");
        assertProcessDead(pid);
        rmSync(candidate, { recursive: true, force: true });
      }
    }
  }
}

export function withPromotionLock<T>(sourceRoot: string, action: () => T, token = `${process.pid}-local-lock`): T {
  const lock = promotionLockPath(sourceRoot);
  const candidate = `${lock}.${process.pid}.${token}`;
  mkdirSync(candidate, { mode: 0o700 });
  const ownerPath = join(candidate, "owner.json");
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  const ownerFd = openSync(ownerPath, "r");
  try {
    fsyncSync(ownerFd);
  } finally {
    closeSync(ownerFd);
  }
  try {
    renameSync(candidate, lock);
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    if (error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) {
      throw new PromotionError("busy");
    }
    throw error;
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
