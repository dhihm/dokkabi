import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileLocksAvailable, processStartIdentity, tryLock } from "./file-lock.ts";
import { SESSION_LOCK_FILE } from "./session-lock.ts";

type OfflineScope = { acquired: true; release(): void } |
  { acquired: false; reason: "session_in_use" | "ownership_unavailable" };

/** GC cannot borrow an active owner's reentrant run lock. Refuse unknown
 * ownership rather than reclaiming it by PID or deleting lease debris. */
export function acquireBlobGcScope(sessionDir: string): OfflineScope {
  if (!fileLocksAvailable()) return { acquired: false, reason: "ownership_unavailable" };
  const runPath = join(sessionDir, SESSION_LOCK_FILE);
  const leasePath = join(sessionDir, "session.lease");
  const ownerPath = join(leasePath, "owner.json");
  let fd: number | undefined;
  let leaseOwned = false;
  let leaseIdentity: { dev: number; ino: number } | undefined;
  let ownerIdentity: { dev: number; ino: number } | undefined;
  let ownerWritten = false;
  const token = randomUUID();
  const release = () => {
    if (leaseOwned) {
      leaseOwned = false;
      // Release only this claim. Never recursively remove an unknown owner.
      try {
        const current = lstatSync(leasePath);
        const currentOwner = lstatSync(ownerPath);
        const mine = ownerIdentity && currentOwner.dev === ownerIdentity.dev && currentOwner.ino === ownerIdentity.ino;
        const owner = ownerWritten ? JSON.parse(readFileSync(ownerPath, "utf8")) as { gc_token?: string } : undefined;
        if (leaseIdentity && current.dev === leaseIdentity.dev && current.ino === leaseIdentity.ino && mine && (!ownerWritten || owner?.gc_token === token)) {
          unlinkSync(ownerPath);
          rmdirSync(leasePath);
        }
      } catch {
        // A failed initial owner write may leave only our empty directory.
        try {
          const current = lstatSync(leasePath);
          if (leaseIdentity && current.dev === leaseIdentity.dev && current.ino === leaseIdentity.ino) rmdirSync(leasePath);
        } catch { /* Unknown or nonempty ownership is left intact. */ }
      }
    }
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
  };
  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fd = openSync(runPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (!tryLock(fd, "exclusive")) {
      release();
      return { acquired: false, reason: "session_in_use" };
    }
    const opened = fstatSync(fd), placed = lstatSync(runPath);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== placed.dev || opened.ino !== placed.ino) {
      release();
      return { acquired: false, reason: "ownership_unavailable" };
    }
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n${processStartIdentity(process.pid) ?? ""}\n`, 0);
    try { mkdirSync(leasePath, { mode: 0o700 }); } catch (error) {
      release();
      return { acquired: false, reason: (error as NodeJS.ErrnoException).code === "EEXIST" ? "session_in_use" : "ownership_unavailable" };
    }
    leaseOwned = true;
    leaseIdentity = lstatSync(leasePath);
    const ownerFd = openSync(ownerPath, "wx", 0o600);
    try {
      ownerIdentity = fstatSync(ownerFd);
      writeFileSync(ownerFd, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString(), gc_token: token })}\n`);
      ownerWritten = true;
    } finally { closeSync(ownerFd); }
    return { acquired: true, release };
  } catch {
    release();
    return { acquired: false, reason: "ownership_unavailable" };
  }
}
