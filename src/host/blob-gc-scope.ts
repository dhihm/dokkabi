import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileLocksAvailable, processStartIdentity, tryLock } from "./file-lock.ts";
import { readSessionLeaseOccupancy } from "./session-lease.ts";
import { SESSION_LOCK_FILE } from "./session-lock.ts";

/** Runs after a stale lease judgment, before takeover. Tests only. */
let afterStaleLeaseJudgment: (() => void) | undefined;

export function setAfterStaleLeaseJudgmentForTest(fn: (() => void) | undefined): void {
  afterStaleLeaseJudgment = fn;
}

export function resetAfterStaleLeaseJudgmentForTest(): void {
  afterStaleLeaseJudgment = undefined;
}

type OfflineScope = { acquired: true; release(): void } |
  { acquired: false; reason: "session_in_use" | "ownership_unavailable" };

/** GC cannot borrow an active owner's reentrant run lock. It may take over a
 * stale interactive lease (same policy as chat) but never unreadable debris. */
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
  const restoreStaleLeaseDir = (stalePath: string): void => {
    try {
      lstatSync(leasePath);
    } catch {
      try { renameSync(stalePath, leasePath); } catch { /* Leave the moved lease for explicit repair. */ }
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
    const claimLease = (): "ok" | "live" | "blocked" => {
      try {
        mkdirSync(leasePath, { mode: 0o700 });
        return "ok";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "blocked";
        const occupancy = readSessionLeaseOccupancy(sessionDir);
        if (occupancy.state === "live") return "live";
        if (occupancy.state === "unknown" || occupancy.state === "malformed") return "blocked";
        if (occupancy.state !== "stale" || !occupancy.ownerContent) return "blocked";
        let judgedLease: { dev: number; ino: number };
        try {
          judgedLease = lstatSync(leasePath);
        } catch {
          return "blocked";
        }
        const judged = { dev: judgedLease.dev, ino: judgedLease.ino, ownerContent: occupancy.ownerContent };
        afterStaleLeaseJudgment?.();
        const stalePath = join(sessionDir, `session.lease.stale-${token}`);
        try {
          renameSync(leasePath, stalePath);
        } catch {
          return "live";
        }
        try {
          const moved = lstatSync(stalePath);
          const movedOwner = readFileSync(join(stalePath, "owner.json"), "utf8");
          if (moved.dev !== judged.dev || moved.ino !== judged.ino || movedOwner !== judged.ownerContent) {
            restoreStaleLeaseDir(stalePath);
            return "live";
          }
        } catch {
          restoreStaleLeaseDir(stalePath);
          return "blocked";
        }
        try {
          rmSync(stalePath, { recursive: true, force: true });
        } catch {
          restoreStaleLeaseDir(stalePath);
          return "blocked";
        }
        try {
          mkdirSync(leasePath, { mode: 0o700 });
          return "ok";
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code === "EEXIST") return "live";
          return "blocked";
        }
      }
    };
    const leaseClaim = claimLease();
    if (leaseClaim !== "ok") {
      release();
      return { acquired: false, reason: leaseClaim === "live" ? "session_in_use" : "ownership_unavailable" };
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
