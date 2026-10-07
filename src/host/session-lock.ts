import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { fileLocksAvailable, processHoldsLockFile, processStartIdentity, tryLock } from "./file-lock.ts";
import { join } from "node:path";

/**
 * One driver per session.
 *
 * A session's event log, plan, and remote runs assume a single work loop is
 * driving them. Live, two work processes drove one session for fifty minutes:
 * a launcher that looked stuck had actually started its run, and the
 * "replacement" started beside it. Each held its own IN-PROCESS host-run
 * lock, so the same heavy case ran twice on the same memory-constrained node
 * twenty-five seconds apart, and both processes interleaved one event log.
 *
 * The session directory is what the two processes share, so the claim lives
 * there: a file naming the driving pid. Acquisition is an exclusive create —
 * the kernel picks the single winner — and a lock whose pid is no longer
 * alive is taken over rather than wedging the session after a crash.
 */

const LOCK_FILE = "run.lock";

export const SESSION_LOCK_FILE = LOCK_FILE;

export type SessionRunLock =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly holder: number };

function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Locks this process holds, by lock path: a second acquire in the same
 * process for its own pid shares the held descriptor (a stale self-lock is
 * reclaimed, as it always was). */
const held = new Map<string, { fd: number; count: number; pid: number }>();

/**
 * The lock file names its holder on two lines: the pid, then the kernel's
 * start time of that process (file-lock.ts). The claim itself is an
 * exclusive `flock` on the file, held for the life of the process: it dies
 * with the process, so a reused pid can never keep a session "live" (#230
 * round 3, D4'). Where file locks are unavailable the pid protocol stands
 * alone, as before.
 */
export function acquireSessionRunLock(dir: string, pid: number = process.pid): SessionRunLock {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  if (!fileLocksAvailable()) return acquireByPid(path, pid);
  const mine = held.get(path);
  if (mine && mine.pid === pid) {
    mine.count += 1;
    return { acquired: true, release: releaser(path) };
  }
  // This process holds the lock for another driver's pid: that driver owns it.
  if (mine) return { acquired: false, holder: mine.pid };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!tryLock(fd, "exclusive")) {
      const holder = readHolder(fd);
      closeSync(fd);
      return { acquired: false, holder: Number.isInteger(holder) && holder > 0 ? holder : 0 };
    }
    // The descriptor must still be the file at the path: a release that
    // unlinked it between our open and our lock leaves an orphan.
    const opened = fstatSync(fd);
    let placed: ReturnType<typeof lstatSync> | undefined;
    try {
      placed = lstatSync(path);
    } catch {
      placed = undefined;
    }
    if (!placed || placed.ino !== opened.ino || placed.dev !== opened.dev) {
      closeSync(fd);
      continue;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, `${pid}\n${processStartIdentity(pid) ?? ""}\n`, 0);
    held.set(path, { fd, count: 1, pid });
    return { acquired: true, release: releaser(path) };
  }
  throw new Error("session run lock could not be taken");
}

function releaser(path: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = held.get(path);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    held.delete(path);
    try {
      rmSync(path, { force: true });
    } catch {
      // Releasing a lock that is already gone is not a failure.
    }
    closeSync(entry.fd);
  };
}

function readHolder(fd: number): number {
  try {
    const buffer = Buffer.alloc(256);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return Number.parseInt(buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "", 10);
  } catch {
    return Number.NaN;
  }
}

/** The pid protocol, for hosts without file locks. */
function acquireByPid(path: string, pid: number): SessionRunLock {
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return {
        acquired: true,
        release: () => {
          try {
            rmSync(path, { force: true });
          } catch {
            // Releasing a lock that is already gone is not a failure.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: number;
    try {
      holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    } catch {
      continue; // the holder released between our create and our read — retry
    }
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && holderAlive(holder)) {
      return { acquired: false, holder };
    }
    rmSync(path, { force: true });
  }
}

export type SessionLockProbe =
  | { readonly state: "held"; readonly pid: number; readonly identityMatches: boolean }
  | { readonly state: "free" }
  | { readonly state: "unavailable" };

/**
 * Whether a live process holds a session's lock, asked without taking it
 * (#230 round 5, L1): from an already opened descriptor of its lock file
 * (opened by the caller without following links), read the pid and kernel
 * start time the holder recorded, and ask the kernel whether that very
 * process — same start time — holds the lock file (Linux: its FLOCK entry in
 * /proc/locks; macOS: an open descriptor on the file's inode). Nothing is
 * locked, so a `work` taking over a stale lock is never in the way of a probe.
 */
function heldHere(dev: number, ino: bigint): boolean {
  for (const entry of held.values()) {
    try {
      const stat = fstatSync(entry.fd, { bigint: true });
      if (Number(stat.dev) === dev && stat.ino === ino) return true;
    } catch {
      // A descriptor closed under us holds nothing.
    }
  }
  return false;
}

export function probeSessionLock(fd: number): SessionLockProbe {
  if (!fileLocksAvailable()) return { state: "unavailable" };
  let text = "";
  let stat: ReturnType<typeof fstatSync> | undefined;
  try {
    stat = fstatSync(fd);
    const buffer = Buffer.alloc(256);
    text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } catch {
    return { state: "free" };
  }
  const [pidLine, startLine] = text.split("\n");
  const pid = Number.parseInt(pidLine ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "free" };
  const recorded = startLine?.trim() ?? "";
  const current = processStartIdentity(pid);
  if (current === undefined) return { state: "free" };
  const holds = pid === process.pid
    // This process: its own table is exact (an open descriptor, the probe's
    // own among them, is not a lock).
    ? heldHere(Number(stat.dev), BigInt(stat.ino))
    : processHoldsLockFile(pid, Number(stat.dev), BigInt(stat.ino));
  if (!holds) return { state: "free" };
  return { state: "held", pid, identityMatches: recorded !== "" && current === recorded };
}
