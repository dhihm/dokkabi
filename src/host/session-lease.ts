import { processStartIdentity, processStartEpochMs } from "./file-lock.ts";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One interactive owner per session.
 *
 * Workspace-scoped default ids stop different directories from sharing a
 * session, but two `dokkabi chat` processes started in the SAME directory
 * still landed on one log and one transcript — two agents interleaving a
 * single conversation. The lease is a directory (atomic mkdir) holding an
 * owner.json {pid, started}; a second acquire is refused while the owner
 * process is alive and takes over when it is dead (crash-safe, no daemon).
 * Only the interactive chat boot takes the lease: work children spawned onto
 * the same session (HEUNG, swarm, freeswarm stages) are cooperative by
 * design and must not deadlock against their parent.
 */

const LEASE_DIR = "session.lease";
const OWNER_FILE = "owner.json";

export interface SessionLease {
  release(): void;
}

function ownerAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether an existing session.lease is held, abandoned, or unreadable. */
export type SessionLeaseOccupancy = "absent" | "live" | "stale" | "unknown" | "malformed";

export interface SessionLeaseOccupancyRead {
  state: SessionLeaseOccupancy;
  pid?: number;
  ownerContent?: string;
}

export function readSessionLeaseOccupancy(sessionDir: string): SessionLeaseOccupancyRead {
  const leasePath = join(sessionDir, LEASE_DIR);
  try {
    lstatSync(leasePath);
  } catch {
    return { state: "absent" };
  }
  const ownerPath = join(leasePath, OWNER_FILE);
  let ownerContent: string;
  try {
    ownerContent = readFileSync(ownerPath, "utf8");
  } catch {
    return { state: "unknown" };
  }
  let pid = 0;
  let recordedStart: string | undefined;
  let claimedAt = Number.NaN;
  try {
    const parsed = JSON.parse(ownerContent) as { pid?: number; process_start?: string; started?: string };
    pid = typeof parsed.pid === "number" ? parsed.pid : 0;
    recordedStart = parsed.process_start;
    claimedAt = Date.parse(parsed.started ?? "");
  } catch {
    return { state: "unknown" };
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "malformed", ownerContent };
  const currentStart = processStartIdentity(pid);
  const born = processStartEpochMs(pid);
  const reused = (recordedStart !== undefined && currentStart !== undefined && recordedStart !== currentStart)
    || (recordedStart === undefined && Number.isFinite(claimedAt) && born !== undefined && born > claimedAt + 2000);
  if (ownerAlive(pid) && !reused) return { state: "live", pid, ownerContent };
  return { state: "stale", pid, ownerContent };
}

export function acquireSessionLease(sessionDir: string): SessionLease {
  const leasePath = join(sessionDir, LEASE_DIR);
  const ownerPath = join(leasePath, OWNER_FILE);
  const claim = (): void => {
    // The session dir may not exist yet on a first boot; the lease dir itself
    // stays non-recursive so the claim is the atomic step.
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(leasePath, { mode: 0o700 });
    writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString(), process_start: processStartIdentity(process.pid) })}\n`, { mode: 0o600 });
  };
  try {
    claim();
  } catch {
    // Held (or debris). Refuse while the recorded owner lives; take over a
    // dead owner's lease so a crash never bricks the session.
    const occupancy = readSessionLeaseOccupancy(sessionDir);
    if (occupancy.state === "unknown") {
      throw new Error("session ownership unavailable: owner.json is unreadable; stop the owner or repair the abandoned lease explicitly");
    }
    if (occupancy.state === "malformed") {
      throw new Error("session ownership unavailable: owner.json is malformed; repair the abandoned lease explicitly");
    }
    if (occupancy.state === "live") {
      throw new Error(
        `session in use: another dokkabi process (pid ${occupancy.pid ?? 0}) holds this session — `
        + "wait for it, stop it, or start with --session NAME",
      );
    }
    rmSync(leasePath, { recursive: true, force: true });
    claim();
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      rmSync(leasePath, { recursive: true, force: true });
    },
  };
}
