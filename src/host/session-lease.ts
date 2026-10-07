import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export function acquireSessionLease(sessionDir: string): SessionLease {
  const leasePath = join(sessionDir, LEASE_DIR);
  const ownerPath = join(leasePath, OWNER_FILE);
  const claim = (): void => {
    // The session dir may not exist yet on a first boot; the lease dir itself
    // stays non-recursive so the claim is the atomic step.
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(leasePath, { mode: 0o700 });
    writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString() })}\n`, { mode: 0o600 });
  };
  try {
    claim();
  } catch {
    // Held (or debris). Refuse while the recorded owner lives; take over a
    // dead owner's lease so a crash never bricks the session.
    let pid = 0;
    try {
      const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: number };
      pid = typeof parsed.pid === "number" ? parsed.pid : 0;
    } catch {
      // The owner may be between its atomic claim and writing owner.json.
      // Unknown ownership is not evidence of abandonment.
      throw new Error("session ownership unavailable: owner.json is unreadable; stop the owner or repair the abandoned lease explicitly");
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("session ownership unavailable: owner.json is malformed; repair the abandoned lease explicitly");
    }
    if (ownerAlive(pid)) {
      throw new Error(
        `session in use: another dokkabi process (pid ${pid}) holds this session — `
        + "wait for it, stop it, or start with --session NAME",
      );
    } else {
      rmSync(leasePath, { recursive: true, force: true });
      claim();
    }
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
