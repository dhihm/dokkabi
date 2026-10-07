import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function createBuildRecoveryRecord(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, content);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

export function replaceBuildRecoveryRecord(path: string, content: string): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  createBuildRecoveryRecord(temporary, content);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

export function readBuildRecoveryRecord(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4_096 || (stat.mode & 0o777) !== 0o600) {
      throw new BuildRecoveryStoreError();
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function removeBuildRecoveryRecord(path: string): void {
  rmSync(path, { force: true });
  syncDirectory(dirname(path));
}

export class BuildRecoveryStoreError extends Error {
  readonly name = "BuildRecoveryStoreError";
  constructor() { super("build recovery receipt is unsafe"); }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return Reflect.get(error, "code") === "EPERM";
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
