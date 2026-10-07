import { closeSync, constants, lstatSync, openSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { EventLog } from "./event-log.ts";
import { fileLocksAvailable } from "./file-lock.ts";
import { acquireSessionRunLock } from "./session-lock.ts";

/** A caller-owned stable gateway ledger is separate from its transient socket.
 * Admit private file identities before taking the existing kernel-owned lock;
 * the lock, chain and recorded binding survive transport/token replacement. */
export function openDesktopGatewayLedger(directory: string): { path: string; release(): void } {
  if (!isAbsolute(directory) || directory.includes("\0")) throw new Error("ledger refused");
  const canonical = resolve(directory);
  const root = parse(canonical).root;
  let ancestor = root;
  for (const component of relative(root, canonical).split("/")) {
    ancestor = join(ancestor, component);
    const stats = lstatSync(ancestor);
    if (!stats.isDirectory()) throw new Error("ledger refused");
  }
  for (const path of [canonical, dirname(canonical)]) {
    const stats = lstatSync(path);
    if (stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== 0o700) throw new Error("ledger refused");
  }
  const privateFile = (path: string, absentAllowed: boolean): boolean => {
    let stats: ReturnType<typeof lstatSync>;
    try { stats = lstatSync(path); } catch (error) {
      if (absentAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stats.isFile() || stats.uid !== process.getuid?.() || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) {
      throw new Error("ledger refused");
    }
    return true;
  };
  const path = join(canonical, "gateway.jsonl");
  privateFile(path, true);
  const appendLock = `${path}.lock`;
  try {
    const stats = lstatSync(appendLock);
    if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== 0o700 ||
        readdirSync(appendLock).some((name) => name !== "owner.json")) throw new Error("ledger refused");
    privateFile(join(appendLock, "owner.json"), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The existing lock truncates its holder metadata after acquiring flock.
  // Refuse a caller-planted alias BEFORE it can mutate that file identity.
  privateFile(join(canonical, "run.lock"), true);
  if (!fileLocksAvailable()) throw new Error("ledger lock unavailable");
  const lock = acquireSessionRunLock(canonical);
  if (!lock.acquired) throw new Error("ledger already owned");
  try {
    if (!privateFile(path, true)) {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    }
    privateFile(path, false);
    // Verify the entire retained chain while owning its lifetime lock, before
    // the server may append startup/binding records or advertise readiness.
    new EventLog(path, { readOnly: true });
    return { path, release: lock.release };
  } catch (error) {
    lock.release();
    throw error;
  }
}
