import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { recoverPromotions, type PromotionRecoveryReport } from "./promotion-recovery.ts";

const RECOVERY_KEY_BYTES = 32;
export const RECOVERY_KEY_FILE = "speculative-recovery.key";

export class RecoveryAuthorityError extends Error {
  readonly name = "RecoveryAuthorityError";

  constructor(readonly code: "unsafe_root" | "unsafe_key" | "invalid_key") {
    super(`speculative recovery authority ${code.replaceAll("_", " ")}`);
  }
}

function trustedRoot(sessionRoot: string): string {
  const requested = resolve(sessionRoot);
  const root = realpathSync(requested);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1 || (stat.mode & 0o077) !== 0) {
    throw new RecoveryAuthorityError("unsafe_root");
  }
  return root;
}

export type RecoveryKeyReadOptions = { readonly afterStat?: () => void };

function readKey(path: string, options: RecoveryKeyReadOptions = {}): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n) {
      throw new RecoveryAuthorityError("unsafe_key");
    }
    if (stat.size !== BigInt(RECOVERY_KEY_BYTES)) throw new RecoveryAuthorityError("invalid_key");
    options.afterStat?.();
    const key = Buffer.alloc(RECOVERY_KEY_BYTES + 1);
    let offset = 0;
    while (offset < key.byteLength) {
      const count = readSync(fd, key, offset, key.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (offset !== RECOVERY_KEY_BYTES || after.dev !== stat.dev || after.ino !== stat.ino
      || after.size !== stat.size || after.mode !== stat.mode || after.nlink !== stat.nlink
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
      throw new RecoveryAuthorityError("invalid_key");
    }
    return new Uint8Array(key.subarray(0, RECOVERY_KEY_BYTES));
  } finally {
    closeSync(fd);
  }
}

export function loadOrCreateRecoveryKey(
  sessionRoot: string,
  options: RecoveryKeyReadOptions = {},
): Uint8Array {
  const root = trustedRoot(sessionRoot);
  const path = join(root, RECOVERY_KEY_FILE);
  try {
    return readKey(path, options);
  } catch (error) {
    if (!(error instanceof Error) || !Reflect.has(error, "code") || Reflect.get(error, "code") !== "ENOENT") {
      throw error;
    }
  }
  const key = randomBytes(RECOVERY_KEY_BYTES);
  const temporary = join(root, `.speculative-recovery-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, key);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (!(error instanceof Error) || !Reflect.has(error, "code") || Reflect.get(error, "code") !== "EEXIST") {
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return readKey(path, options);
}

export function recoverTier2Promotions(input: {
  readonly sourceRoot: string;
  readonly sessionRoot: string;
}): PromotionRecoveryReport {
  return recoverPromotions({
    sourceRoot: input.sourceRoot,
    sessionRoot: input.sessionRoot,
    recoveryKey: loadOrCreateRecoveryKey(input.sessionRoot),
  });
}
