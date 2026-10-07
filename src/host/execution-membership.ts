import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { registerLiveWriter } from "./live-writers.ts";

/**
 * AN EXECUTION'S MEMBERSHIP IS DECIDED BY THE KERNEL (G2', D57h; design memo
 * §123), never by data a process controls.
 *
 * Seatbelt has no process namespace, and a child can leave everything a host
 * could otherwise recognise it by: its process group and session (setsid),
 * its environment (`env -i`, which drops DOKKABI_EXEC_MARKER), its parent
 * (a double fork reparents it to launchd) and its argv. What it cannot leave
 * is the sandbox profile it was started under — a profile is inherited by
 * every descendant and a sandboxed process cannot apply another one.
 *
 * So every Seatbelt execution the host starts gets a CAPABILITY: one file the
 * host creates in a host-owned directory (mode 0700, in the policy's own
 * runtime root beside its sandbox home and temp — outside the workspace and
 * every root the profile lets the execution write). The execution's profile
 * grants `file-write-data` on exactly that path (sandbox-seatbelt.ts, the
 * `(param …)` rule) and on no other execution's. At the end of the call the
 * host
 *
 *   1. lists only its own user's processes (`proc_listpids(PROC_UID_ONLY)`)
 *      and keeps those that started after the execution began (the kernel's
 *      monotonic start time, `proc_pid_rusage` — a bound on the cost, never
 *      the decision);
 *   2. asks the kernel, with the public `sandbox_check(pid, "file-write-data",
 *      SANDBOX_FILTER_PATH, path)`, whether each one may write the capability
 *      AND may not write a decoy file in the same directory that no profile
 *      grants — an unconfined process may write both, a process of another
 *      execution neither: allowed-and-denied is exactly "confined to this
 *      execution's profile";
 *   3. ends every member with SIGKILL, waits (bounded) until the kernel shows
 *      none remaining (a zombie cannot write and is not counted), and while
 *      any remains registers it as a live writer of the tree — every image of
 *      the tree is unknown until it is gone (live-writers.ts).
 *
 * Nothing is read from any process — no memory, no environment, no argv — and
 * no other process is signalled. A process the kernel cannot classify (its
 * start time cannot be had and `sandbox_check` gives neither answer) while it
 * still exists is treated as a live writer too.
 *
 * On bwrap the pid namespace is the membership: `--unshare-pid` makes the
 * execution's first process the namespace's init, and when it exits the
 * kernel ends every process in the namespace, whatever it did to its session,
 * environment or parent. Nothing here runs there.
 *
 * Where the kernel check is unavailable (not macOS, the FFI cannot be bound,
 * or no host-owned directory lies outside the policy's writable roots) the
 * environment-marker scan is the fallback (live-writers.ts
 * endMarkedProcesses), with its stated residual.
 *
 * Residuals, stated: a process another service starts on the execution's
 * behalf (launchd, an XPC service) is not a descendant and is not confined by
 * the profile; a pid reused between the kernel's answer and the signal
 * (microseconds, pids are allocated upward) could be signalled.
 */

/** The SBPL parameter that names the execution's capability path. */
export const EXECUTION_CAPABILITY_PARAM = "DOKKABI_EXECUTION_CAPABILITY";
/** The wrapper shell's environment variable carrying it from the host (it
 * never crosses the fence: the fence clears the environment). */
export const EXECUTION_CAPABILITY_ENV = "DOKKABI_EXEC_CAPABILITY";
/** The SBPL parameter that names the session's capability path (G2''). */
export const SESSION_CAPABILITY_PARAM = "DOKKABI_SESSION_CAPABILITY";

const SANDBOX_FILTER_NONE = 0;
const SANDBOX_FILTER_PATH = 1;
/** sandbox.h: do not log the (expected) denials of a check. */
const SANDBOX_CHECK_NO_REPORT = 0x4000_0000;
const PROC_UID_ONLY = 4;
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
const SZOMB = 5;
const RUSAGE_INFO_V0 = 0;
const WRITE_DATA = Buffer.from("file-write-data\0");

type Kernel = {
  readonly check: (pid: number, path: Buffer | null) => number;
  readonly listUserPids: () => number[];
  /** The process's start in mach absolute time; undefined when not had. */
  readonly startedAt: (pid: number) => bigint | undefined;
  /** Whether the process exists and is not a zombie. */
  readonly alive: (pid: number) => boolean;
  readonly now: () => bigint;
};

let kernel: Kernel | null | undefined;

function bindKernel(): Kernel | null {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) return null;
  try {
    // sandbox_check is variadic: `int sandbox_check(pid_t, const char *op,
    // int type, ...)`. On arm64 Apple's ABI passes variadic arguments on the
    // stack, so the path goes as the ninth integer argument, which the callee
    // finds at [sp] where va_arg reads the first; on x86-64 variadic integers
    // travel in the same registers as named ones.
    const sandbox = dlopen("/usr/lib/system/libsystem_sandbox.dylib", {
      sandbox_check: process.arch === "arm64"
        ? { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.ptr], returns: FFIType.i32 }
        : { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    const system = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      mach_absolute_time: { args: [], returns: FFIType.u64 },
    });
    const call = sandbox.symbols.sandbox_check as (...args: unknown[]) => number;
    const check = (pid: number, path: Buffer | null): number => (path === null
      ? (process.arch === "arm64" ? call(pid, null, SANDBOX_FILTER_NONE, 0, 0, 0, 0, 0, null) : call(pid, null, SANDBOX_FILTER_NONE, null))
      : (process.arch === "arm64"
        ? call(pid, WRITE_DATA, SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, 0, 0, 0, 0, 0, path)
        : call(pid, WRITE_DATA, SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, path)));
    const uid = process.getuid?.() ?? -1;
    if (uid < 0) return null;
    const usage = new BigUint64Array(12);
    const info = new Uint8Array(PROC_BSDINFO_SIZE);
    const infoView = new DataView(info.buffer);
    const bound: Kernel = {
      check,
      listUserPids: () => {
        for (let room = 4096; room <= 1048576; room *= 2) {
          const buffer = new Int32Array(room);
          const bytes = system.symbols.proc_listpids(PROC_UID_ONLY, uid, buffer, buffer.byteLength) as number;
          if (bytes <= 0 || bytes % 4 !== 0) throw new Error("kernel process membership enumeration unavailable");
          if (bytes < buffer.byteLength) return Array.from(buffer.subarray(0, bytes / 4)).filter((pid) => pid > 0);
        }
        throw new Error("kernel process membership enumeration limit exceeded");
      },
      startedAt: (pid) => ((system.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V0, usage) as number) === 0 ? usage[10] : undefined),
      alive: (pid) => {
        const size = system.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, info, PROC_BSDINFO_SIZE) as number;
        if (size === PROC_BSDINFO_SIZE && infoView.getUint32(12, true) === pid) return infoView.getUint32(4, true) !== SZOMB;
        try { process.kill(pid, 0); return true; }
        catch (error) { return (error as { code?: string }).code !== "ESRCH"; }
      },
      now: () => system.symbols.mach_absolute_time() as bigint,
    };
    // The bound call must answer as documented for the host itself: not
    // sandboxed (0), and allowed to write a file it owns (0).
    if (bound.check(process.pid, null) !== 0) return null;
    return bound;
  } catch {
    return null;
  }
}

function theKernel(): Kernel | null {
  if (kernel === undefined) kernel = bindKernel();
  return kernel;
}

/** Whether the kernel membership check is bound in this process. */
export function membershipAvailable(): boolean {
  return theKernel() !== null;
}

// --- the host-owned capability directory: one session -----------------------------

function makeFile(path: string): void {
  closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** The SESSION of a capability directory (G2'', D57i): one policy's
 * executions. Its `session` file every one of their profiles may write, the
 * decoy none may, the kernel's clock when it began, and its executions that
 * have not ended. */
interface MembershipSession {
  readonly session: Buffer;
  readonly decoy: Buffer;
  readonly began: bigint;
  readonly live: Set<ExecutionMembership>;
}

const SESSIONS = new Map<string, MembershipSession>();

/** The file every execution of the session behind `dir` may write. */
export function sessionCapabilityPath(dir: string): string {
  return join(dir, "session");
}

function ownFile(path: string): boolean {
  try {
    makeFile(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") return false;
    const found = lstatSync(path);
    return found.isFile() && found.uid === uid();
  }
}

/** The session of `dir`, made (or found) as a host-owned directory — a real
 * directory, not a link, of the host's user, mode 0700 — holding the session
 * file and the decoy; undefined when that cannot be had. */
function capabilitySession(dir: string, now: bigint): MembershipSession | undefined {
  const known = SESSIONS.get(dir);
  if (known !== undefined && existsSync(dir)) return known;
  try {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") return undefined;
    }
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid() || (stat.mode & 0o077) !== 0 || realpathSync(dir) !== dir) return undefined;
    const decoy = join(dir, "no-execution");
    const session = sessionCapabilityPath(dir);
    if (!ownFile(decoy) || !ownFile(session)) return undefined;
    const made: MembershipSession = { session: Buffer.from(`${session}\0`), decoy: Buffer.from(`${decoy}\0`), began: now, live: new Set() };
    SESSIONS.set(dir, made);
    return made;
  } catch {
    return undefined;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// --- one execution ------------------------------------------------------------------

/** Cost counters of the end-of-call classification (diagnostics, the cost
 * test): sweeps, their time, processes listed, those past the start filter,
 * kernel checks made, processes ended. */
export const MEMBERSHIP_SWEEPS = { sweeps: 0, ns: 0n, listed: 0, candidates: 0, checks: 0, ended: 0 };

/** Tests only. `withholdSignals`: identify members but never signal them, so
 * that the live-writers rule (a member that remains makes every image
 * unknown) can be observed. `unavailable`: behave as where the kernel check
 * cannot be bound (the marker-scan fallback), so the state before G2' can be
 * measured against the same scenarios. */
export const membershipTesting = { withholdSignals: false, unavailable: false };

export interface ExecutionMembership {
  /** The capability path the execution's profile may write (real path). */
  readonly capability: string;
  /** The session's directory (sessionCapabilityPath). */
  readonly dir: string;
  /** The kernel's monotonic clock when the execution began. */
  readonly began: bigint;
  /** A short name for the execution (diagnostics and live-writer lines). */
  readonly name: string;
}

const RELEASED = new WeakSet<ExecutionMembership>();

/**
 * Begin tracking one Seatbelt execution: a fresh capability file in `dir`
 * (a host-owned directory of the policy, made here when missing: sandbox.ts
 * puts it in the policy's own runtime root, beside — never inside — its
 * sandbox home and temp), and the kernel's clock. Undefined when the kernel
 * check is unavailable, `dir` is not a real host-owned directory, or it lies
 * inside (or holds) one of `writableRoots` — the policy's own write grants:
 * the decoy must be denied to every execution — and the caller then falls
 * back to the marker scan.
 */
export function beginExecutionMembership(dir: string, writableRoots: readonly string[]): ExecutionMembership | undefined {
  if (membershipTesting.unavailable) return undefined;
  const bound = theKernel();
  if (bound === null || !isAbsolute(dir)) return undefined;
  if (writableRoots.some((root) => within(root, dir) || within(dir, root))) return undefined;
  const session = capabilitySession(dir, bound.now());
  if (session === undefined) return undefined;
  const name = `x-${randomUUID()}`;
  const capability = join(dir, name);
  try {
    makeFile(capability);
  } catch {
    return undefined;
  }
  const membership: ExecutionMembership = { capability, dir, began: bound.now(), name };
  session.live.add(membership);
  return membership;
}

/**
 * The processes to end at the end of `membership` now, and those the kernel
 * could not classify (G2'', D57i). Every process of the user that started
 * after the SESSION began is asked — so a process one sweep missed, or one
 * an earlier execution of the session left behind, is classified by the
 * next: confined to a profile of this session (allowed the session file,
 * denied the decoy), and not a member of an execution of the session that is
 * still running (allowed its capability), is to be ended.
 */
export function executionMembers(membership: ExecutionMembership): { readonly members: number[]; readonly unclassified: number[] } {
  const bound = theKernel();
  const session = SESSIONS.get(membership.dir);
  const members: number[] = [];
  const unclassified: number[] = [];
  if (bound === null || session === undefined) throw new Error("kernel membership evidence unavailable");
  const started = process.hrtime.bigint();
  const running = [...session.live].filter((other) => other !== membership).map((other) => Buffer.from(`${other.capability}\0`));
  const check = (pid: number, path: Buffer): number => {
    MEMBERSHIP_SWEEPS.checks += 1;
    return bound.check(pid, path);
  };
  try {
    const pids = bound.listUserPids();
    MEMBERSHIP_SWEEPS.listed += pids.length;
    for (const pid of pids) {
      if (pid === process.pid || pid <= 1) continue;
      const start = bound.startedAt(pid);
      // Started before the session began: no profile of it existed then.
      // Unknown start: asked anyway.
      if (start !== undefined && start < session.began) continue;
      MEMBERSHIP_SWEEPS.candidates += 1;
      const decoy = check(pid, session.decoy);
      // Allowed the decoy: unconfined, or a profile that writes the
      // directory — never one of this session's.
      if (decoy === 0) continue;
      const inSession = decoy === 1 ? check(pid, session.session) : -1;
      if (decoy === 1 && inSession === 1) continue; // another profile
      if (decoy === 1 && inSession === 0) {
        if (running.some((other) => check(pid, other) === 0)) continue; // a running execution's
        if (bound.alive(pid)) members.push(pid);
      } else if (bound.alive(pid)) {
        unclassified.push(pid);
      }
    }
  } finally {
    MEMBERSHIP_SWEEPS.sweeps += 1;
    MEMBERSHIP_SWEEPS.ns += process.hrtime.bigint() - started;
  }
  return { members, unclassified };
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** How long the host waits for ended members to be gone. */
export const MEMBERSHIP_PATIENCE_MS = 2_000;

function signalAll(pids: readonly number[]): number {
  if (membershipTesting.withholdSignals) return 0;
  let ended = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      ended += 1;
    } catch {
      // Already gone.
    }
  }
  MEMBERSHIP_SWEEPS.ended += ended;
  return ended;
}

function release(membership: ExecutionMembership): void {
  if (RELEASED.has(membership)) return;
  RELEASED.add(membership);
  rmSync(membership.capability, { force: true });
}

/**
 * End the execution: it leaves the session's running executions, and every
 * process of the session that is not a running execution's — its own, and
 * whatever an earlier sweep missed — is ended with SIGKILL; the host waits
 * (bounded) until the kernel shows none. What remains — or cannot be
 * classified — is registered as a live writer of `writes` (a tree the policy
 * could write; undefined for a read-only one) until it is gone, so every
 * image of that tree is unknown meanwhile. Returns what was ended and what
 * remains.
 */
export function endExecutionMembership(membership: ExecutionMembership, writes?: string): { readonly ended: number; readonly remaining: readonly number[] } {
  SESSIONS.get(membership.dir)?.live.delete(membership);
  release(membership);
  const inspect = () => {
    try { return executionMembers(membership); }
    catch (error) {
      if (writes !== undefined) registerLiveWriter(writes, `execution:${membership.name}`, "kernel membership inspection is unavailable", () => {
        try { const state = executionMembers(membership); return state.members.length + state.unclassified.length > 0; }
        catch { return true; }
      });
      throw error;
    }
  };
  let ended = 0;
  const until = Date.now() + MEMBERSHIP_PATIENCE_MS;
  let left: { readonly members: number[]; readonly unclassified: number[] } = inspect();
  while (left.members.length > 0) {
    ended += signalAll(left.members);
    if (membershipTesting.withholdSignals || Date.now() >= until) break;
    Atomics.wait(sleeper, 0, 0, 5);
    left = inspect();
  }
  const remaining = [...left.members, ...left.unclassified];
  if (remaining.length === 0) return { ended, remaining };
  if (writes !== undefined) {
    registerLiveWriter(writes, `execution:${membership.name}`, `process ${remaining.join(", ")} of an ended execution can still write the tree`, () => {
      const now = executionMembers(membership);
      if (now.members.length > 0) signalAll(now.members);
      return now.members.length + now.unclassified.length > 0;
    });
  }
  return { ended, remaining };
}
