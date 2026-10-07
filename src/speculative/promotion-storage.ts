import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class PromotionStorageError extends Error {
  readonly code = "promotion_storage_authority" as const;
  constructor() { super("promotion storage authority or integrity check failed"); }
}

function privateDirectory(path: string) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0
    || realpathSync(path) !== resolve(path)) throw new PromotionStorageError();
  return stats;
}

export function assertPromotionsDirectory(sessionRoot: string): string {
  privateDirectory(sessionRoot);
  const root = join(sessionRoot, "promotions");
  privateDirectory(root);
  return root;
}

export function assertPromotionStorage(storageRoot: string): void {
  if (!/^[0-9a-f-]{36}$/u.test(basename(storageRoot))) throw new PromotionStorageError();
  const parent = dirname(storageRoot);
  if (basename(parent) !== "promotions") throw new PromotionStorageError();
  assertPromotionsDirectory(dirname(parent));
  privateDirectory(storageRoot);
  privateDirectory(join(storageRoot, "backups"));
}

export function holdPromotionStorage(storageRoot: string): () => void {
  assertPromotionStorage(storageRoot);
  const paths = [dirname(dirname(storageRoot)), dirname(storageRoot), storageRoot, join(storageRoot, "backups")];
  const identities = paths.map((path) => ({ path, stats: privateDirectory(path) }));
  return () => {
    for (const { path, stats } of identities) {
      const current = privateDirectory(path);
      if (stats.dev !== current.dev || stats.ino !== current.ino) throw new PromotionStorageError();
    }
  };
}

export function readPromotionFile(storageRoot: string, path: string): Buffer {
  assertPromotionStorage(storageRoot);
  if (path !== "journal.json" && path !== "transaction.json" && !/^backups\/[0-9]+$/u.test(path)) {
    throw new PromotionStorageError();
  }
  const target = join(storageRoot, path);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    const limit = path === "journal.json" || path === "transaction.json" ? 1024 * 1024 : 16 * 1024 * 1024;
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > limit) throw new PromotionStorageError();
    const bytes = Buffer.alloc(stats.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    assertPromotionStorage(storageRoot);
    if (offset !== stats.size || stats.size !== after.size || stats.mtimeMs !== after.mtimeMs
      || stats.ctimeMs !== after.ctimeMs) throw new PromotionStorageError();
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
