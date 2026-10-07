import { readFileSync } from "node:fs";

/**
 * Operating-system file locks and process identity, for the one question a
 * pid cannot answer: is the process that took this lock still the one that
 * holds it (#230 round 3, D4')? A `flock` lock belongs to an open file
 * description and dies with its process, so a lock that can be taken belongs
 * to nobody — whatever pid a file names. A process's start time, read from
 * the kernel, tells a reused pid from the one that wrote the file.
 *
 * Both use libc through bun:ffi (macOS libSystem, Linux glibc). Where it
 * cannot be loaded, `fileLocksAvailable` is false and callers fall back to
 * what they did before; nothing here throws.
 */

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

interface Libc {
  flock(fd: number, operation: number): number;
  procStart?(pid: number): string | undefined;
  holdsFile?(pid: number, dev: number, ino: bigint): boolean | undefined;
}

function loadLibc(): Libc | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  try {
    // Loaded lazily: a bundle that never takes a lock never touches FFI.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { dlopen, FFIType, ptr } = ffi;
    if (process.platform === "darwin") {
      const lib = dlopen("/usr/lib/libSystem.B.dylib", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        proc_pidfdinfo: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      });
      return {
        flock: (fd, operation) => lib.symbols.flock(fd, operation),
        procStart: (pid) => {
          // PROC_PIDTBSDINFO: struct proc_bsdinfo, 136 bytes; pbi_pid at 12,
          // pbi_start_tvsec at 120, pbi_start_tvusec at 128.
          const buffer = new Uint8Array(136);
          if (lib.symbols.proc_pidinfo(pid, 3, 0n, ptr(buffer), 136) !== 136) return undefined;
          const view = new DataView(buffer.buffer);
          if (view.getUint32(12, true) !== pid) return undefined;
          return `darwin:${view.getBigUint64(120, true)}.${view.getBigUint64(128, true)}`;
        },
        holdsFile: (pid, dev, ino) => {
          // PROC_PIDLISTFDS: proc_fdinfo {int32 fd; uint32 type}; for each
          // vnode (type 1), PROC_PIDFDVNODEPATHINFO gives vnode_fdinfowithpath
          // (1200 bytes) whose vinfo_stat has vst_dev at 24 and vst_ino at 32.
          const list = new Uint8Array(8 * 4096);
          const bytes = lib.symbols.proc_pidinfo(pid, 1, 0n, ptr(list), list.length);
          if (bytes <= 0) return undefined;
          const entries = new DataView(list.buffer);
          const info = new Uint8Array(1200);
          const infoView = new DataView(info.buffer);
          for (let offset = 0; offset + 8 <= bytes; offset += 8) {
            if (entries.getUint32(offset + 4, true) !== 1) continue;
            if (lib.symbols.proc_pidfdinfo(pid, entries.getInt32(offset, true), 2, ptr(info), 1200) !== 1200) continue;
            if (infoView.getUint32(24, true) === dev && infoView.getBigUint64(32, true) === ino) return true;
          }
          return false;
        },
      };
    }
    const lib = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    return {
      flock: (fd, operation) => lib.symbols.flock(fd, operation),
      procStart: (pid) => {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          // Field 22 (starttime) counts from after the parenthesised command.
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const start = fields[19];
          return start && /^\d+$/u.test(start) ? `linux:${start}` : undefined;
        } catch {
          return undefined;
        }
      },
      holdsFile: (pid, _dev, ino) => {
        // The kernel's own lock table: "n: FLOCK ADVISORY WRITE <pid> maj:min:inode ...".
        try {
          for (const line of readFileSync("/proc/locks", "utf8").split("\n")) {
            const fields = line.trim().split(/\s+/u);
            if (fields[1] !== "FLOCK" || fields[3] !== "WRITE" || fields[4] !== String(pid)) continue;
            if (fields[5]?.split(":")[2] === String(ino)) return true;
          }
          return false;
        } catch {
          return undefined;
        }
      },
    };
  } catch {
    return undefined;
  }
}

let libc: Libc | undefined | null = null;
function lib(): Libc | undefined {
  if (libc === null) libc = loadLibc();
  return libc;
}

export function fileLocksAvailable(): boolean {
  return lib() !== undefined;
}

/** Take a lock on an open descriptor without waiting. False when another open
 * file description holds a conflicting lock (or locks are unavailable). */
export function tryLock(fd: number, mode: "exclusive" | "shared"): boolean {
  const handle = lib();
  if (!handle) return false;
  return handle.flock(fd, (mode === "exclusive" ? LOCK_EX : LOCK_SH) | LOCK_NB) === 0;
}

export function unlock(fd: number): void {
  lib()?.flock(fd, LOCK_UN);
}

/** The kernel's start time of a live process, as an opaque identity string;
 * undefined when the process is gone or not readable by this user. */
export function processStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    return lib()?.procStart?.(pid);
  } catch {
    return undefined;
  }
}

/** Whether this live process holds the lock file with this device and inode,
 * asked of the kernel without taking any lock (Linux: its exclusive FLOCK in
 * /proc/locks; macOS: an open descriptor on the inode). False when it cannot
 * be told. */
export function processHoldsLockFile(pid: number, dev: number, ino: bigint): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    return lib()?.holdsFile?.(pid, dev, ino) === true;
  } catch {
    return false;
  }
}
