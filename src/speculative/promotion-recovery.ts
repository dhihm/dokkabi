import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { captureWorktreeSnapshot, releaseWorktreeSnapshot } from "../swarm/worktree.ts";
import { assertJournalAuthority, copyRecoveryKey, persistPromotionJournal, readPromotionJournal, removePromotionStorage, trustedSessionRoot, type PromotionJournal, type PromotionJournalEntry } from "./promotion-journal.ts";
import { assertPromotionStorage, assertPromotionsDirectory, holdPromotionStorage, readPromotionFile } from "./promotion-storage.ts";
import { clearStalePromotionLock, PromotionError, withPromotionLock } from "./source-cas.ts";
import { assertLegacyPromotionRecovery } from "./promotion-recovery-preflight.ts";

export interface RecoverPromotionsInput {
  readonly sourceRoot: string;
  readonly sessionRoot: string;
  readonly recoveryKey: Uint8Array;
}

export interface PromotionRecoveryReport {
  readonly restored: number;
  readonly cleaned: number;
  readonly refused: number;
}

function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || normalize(path) !== path
    || path.split("/").some((part) => part === ".." || part === ".git")) {
    throw new PromotionError("unsafe_target");
  }
  return path;
}

function relativePathFrom(root: string, target: string): string {
  const path = relative(root, target);
  if (!path || path.startsWith("..") || isAbsolute(path)) throw new PromotionError("unsafe_target");
  return path;
}

function anchorFor(root: string, path: string): {
  readonly relative: string;
  readonly device: number;
  readonly inode: number;
  readonly createdParents: readonly string[];
} {
  const parent = dirname(safeRelative(path));
  const createdParents: string[] = [];
  let anchor = parent;
  while (anchor !== "." && !existsSync(resolve(root, anchor))) {
    createdParents.unshift(anchor);
    anchor = dirname(anchor);
  }
  const absolute = resolve(root, anchor);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PromotionError("unsafe_target");
  return { relative: anchor, device: stat.dev, inode: stat.ino, createdParents };
}

export function capturePromotionEntries(root: string, paths: readonly string[], storageRoot: string): PromotionJournalEntry[] {
  assertPromotionStorage(storageRoot);
  const entries: PromotionJournalEntry[] = [];
  for (const [index, relativePath] of paths.entries()) {
    const relative = safeRelative(relativePath);
    const target = resolve(root, relative);
    if (relativePathFrom(root, target) !== relative) throw new PromotionError("unsafe_target");
    const anchor = anchorFor(root, relative);
    if (!existsSync(target)) {
      entries.push({ relative, anchorRelative: anchor.relative, anchorDevice: anchor.device,
        anchorInode: anchor.inode, createdParents: [...anchor.createdParents] });
      continue;
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1) throw new PromotionError("unsafe_target");
    const backupName = String(index);
    const bytes = readFileSync(target);
    if (bytes.byteLength > 16 * 1024 * 1024) throw new PromotionError("unsafe_target");
    const backup = join(storageRoot, "backups", backupName);
    const fd = openSync(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    entries.push({ relative, anchorRelative: anchor.relative, anchorDevice: anchor.device,
      anchorInode: anchor.inode, backupName,
      backupDigest: createHash("sha256").update(bytes).digest("hex"),
      mode: stat.mode & 0o7777, createdParents: [...anchor.createdParents] });
  }
  const backups = openSync(join(storageRoot, "backups"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(backups);
  } finally {
    closeSync(backups);
  }
  return entries;
}

function restoreTarget(root: string, entry: PromotionJournalEntry): { readonly path: string; readonly parentReady: boolean } {
  safeRelative(entry.relative);
  const anchorPath = entry.anchorRelative === "." ? root : resolve(root, safeRelative(entry.anchorRelative));
  const anchor = lstatSync(anchorPath);
  if (!anchor.isDirectory() || anchor.isSymbolicLink()
    || anchor.dev !== entry.anchorDevice || anchor.ino !== entry.anchorInode) {
    throw new PromotionError("unsafe_target");
  }
  const parent = dirname(entry.relative);
  const suffix = relative(entry.anchorRelative, parent);
  let current = anchorPath;
  for (const part of suffix === "" ? [] : suffix.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) return { path: resolve(root, entry.relative), parentReady: false };
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PromotionError("unsafe_target");
  }
  return { path: join(current, basename(entry.relative)), parentReady: true };
}

export function restorePromotionEntries(root: string, storageRoot: string, entries: readonly PromotionJournalEntry[]): void {
  const assertAttached = holdPromotionStorage(storageRoot);
  const plans = entries.map((entry) => {
    const target = restoreTarget(root, entry);
    const hasBackup = entry.backupName !== undefined;
    if (hasBackup !== (entry.backupDigest !== undefined) || hasBackup !== (entry.mode !== undefined)) {
      throw new PromotionError("rollback");
    }
    const bytes = entry.backupName === undefined ? undefined : readPromotionFile(storageRoot, `backups/${entry.backupName}`);
    if ((bytes === undefined) !== (entry.backupDigest === undefined)
      || (bytes !== undefined && createHash("sha256").update(bytes).digest("hex") !== entry.backupDigest)) {
      throw new PromotionError("rollback");
    }
    return { entry, target, bytes };
  });
  for (const { entry, target, bytes } of plans) {
    assertAttached();
    if (bytes === undefined) {
      if (target.parentReady && existsSync(target.path)) {
        if (lstatSync(target.path).isDirectory()) throw new PromotionError("rollback");
        rmSync(target.path, { force: true });
      }
      continue;
    }
    if (!target.parentReady || entry.mode === undefined) throw new PromotionError("rollback");
    if (existsSync(target.path) && lstatSync(target.path).isDirectory()) throw new PromotionError("rollback");
    rmSync(target.path, { force: true });
    writeFileSync(target.path, bytes, { mode: entry.mode });
    chmodSync(target.path, entry.mode);
  }
  const created = [...new Set(entries.flatMap((entry) => entry.createdParents))]
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const path of created) {
    const absolute = resolve(root, safeRelative(path));
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PromotionError("rollback");
    rmdirSync(absolute);
  }
}

export function promotionEntriesMatch(root: string, storageRoot: string, entries: readonly PromotionJournalEntry[]): boolean {
  return entries.every((entry) => {
    const target = restoreTarget(root, entry);
    if (entry.backupName === undefined) return !target.parentReady || !existsSync(target.path);
    if (!target.parentReady || !existsSync(target.path) || entry.backupDigest === undefined || entry.mode === undefined) return false;
    const stat = lstatSync(target.path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== entry.mode) return false;
    const bytes = readFileSync(target.path);
    return createHash("sha256").update(bytes).digest("hex") === entry.backupDigest
      && bytes.equals(readPromotionFile(storageRoot, `backups/${entry.backupName}`));
  });
}

export function verifyPromotionBase(root: string, journal: PromotionJournal): void {
  const snapshot = captureWorktreeSnapshot(root, {
    isolatedObjects: true,
    runtimeArtifacts: journal.captureRuntimeArtifacts,
  });
  try {
    if (snapshot.digest !== journal.baseDigest || snapshot.tree !== journal.baseTree
      || snapshot.runtimeArtifacts.digest !== journal.runtimeDigest) throw new PromotionError("rollback");
  } finally {
    releaseWorktreeSnapshot(snapshot);
  }
}

export function recoverPromotions(input: RecoverPromotionsInput): PromotionRecoveryReport {
  const recoveryKey = copyRecoveryKey(input.recoveryKey);
  const sessionRoot = trustedSessionRoot(input.sessionRoot);
  const sourceRoot = realpathSync(resolve(input.sourceRoot));
  const promotions = join(sessionRoot, "promotions");
  if (!existsSync(promotions)) return { restored: 0, cleaned: 0, refused: 0 };
  assertPromotionsDirectory(sessionRoot);
  const legacyRoots = readdirSync(promotions).filter((name) =>
    !existsSync(join(promotions, name, "transaction.json")));
  try {
    assertLegacyPromotionRecovery(promotions, sessionRoot, sourceRoot, recoveryKey);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { restored: 0, cleaned: 0, refused: Math.max(1, legacyRoots.length) };
  }
  let restored = 0;
  let cleaned = 0;
  let refused = 0;
  for (const name of readdirSync(promotions).sort()) {
    const storageRoot = join(promotions, name);
    if (existsSync(join(storageRoot, "transaction.json"))) continue;
    try {
      const stat = lstatSync(storageRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PromotionError("rollback");
      const assertAttached = holdPromotionStorage(storageRoot);
      const journal = readPromotionJournal(storageRoot, recoveryKey);
      assertJournalAuthority(journal, sourceRoot);
      clearStalePromotionLock(sourceRoot, journal.promotionId);
      if (journal.phase === "applying") {
        withPromotionLock(sourceRoot, () => {
          restorePromotionEntries(sourceRoot, storageRoot, journal.entries);
          verifyPromotionBase(sourceRoot, journal);
          assertAttached();
          persistPromotionJournal(storageRoot, { ...journal, phase: "resolved" }, recoveryKey);
        }, journal.promotionId);
        restored += 1;
      } else {
        cleaned += 1;
      }
      assertAttached();
      removePromotionStorage(sessionRoot, storageRoot);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      refused += 1;
    }
  }
  return { restored, cleaned, refused };
}
