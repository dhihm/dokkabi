import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  assertJournalAuthority,
  copyRecoveryKey,
  readPromotionJournal,
} from "./promotion-journal.ts";
import { assertPromotionsDirectory, readPromotionFile } from "./promotion-storage.ts";
import { PromotionError } from "./source-cas.ts";

export function assertLegacyPromotionRecovery(
  promotions: string,
  sessionRoot: string,
  sourceRoot: string,
  recoveryKey: Uint8Array,
): void {
  if (!existsSync(promotions)) return;
  assertPromotionsDirectory(sessionRoot);
  const key = copyRecoveryKey(recoveryKey);
  for (const name of readdirSync(promotions).sort()) {
    const storageRoot = join(promotions, name);
    const stat = lstatSync(storageRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PromotionError("rollback");
    if (existsSync(join(storageRoot, "transaction.json"))) continue;
    const journal = readPromotionJournal(storageRoot, key);
    assertJournalAuthority(journal, sourceRoot);
    for (const entry of journal.entries) validateEntry(sourceRoot, storageRoot, entry);
  }
}

function validateEntry(
  root: string,
  storageRoot: string,
  entry: ReturnType<typeof readPromotionJournal>["entries"][number],
): void {
  const safe = (path: string): string => {
    if (!path || isAbsolute(path) || normalize(path) !== path
      || path.split("/").some((part) => part === ".." || part === ".git")) throw new PromotionError("rollback");
    return path;
  };
  const anchorPath = entry.anchorRelative === "." ? root : resolve(root, safe(entry.anchorRelative));
  const anchor = lstatSync(anchorPath);
  if (!anchor.isDirectory() || anchor.isSymbolicLink()
    || anchor.dev !== entry.anchorDevice || anchor.ino !== entry.anchorInode) throw new PromotionError("rollback");
  const suffix = relative(entry.anchorRelative, dirname(safe(entry.relative)));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new PromotionError("rollback");
  for (const created of entry.createdParents) safe(created);
  let current = anchorPath;
  for (const part of suffix === "" ? [] : suffix.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PromotionError("rollback");
  }
  if (entry.backupName === undefined) return;
  if (basename(entry.backupName) !== entry.backupName || entry.backupDigest === undefined) {
    throw new PromotionError("rollback");
  }
  const bytes = readPromotionFile(storageRoot, `backups/${entry.backupName}`);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.backupDigest) throw new PromotionError("rollback");
}
