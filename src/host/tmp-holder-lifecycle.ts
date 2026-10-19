import { lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL_CACHE_PREFIX = "dokkabi-tool-cache-";
const SANDBOX_IDENTITY_PREFIX = "dokkabi-sandbox-identity-";
const TOOL_CACHE_NAME = /^dokkabi-tool-cache-(\d+)-/;
const SANDBOX_IDENTITY_NAME = /^dokkabi-sandbox-identity-(\d+)-/;

const signalCleanups = new Set<() => void>();
let signalHandlersInstalled = false;
let toolCacheSweepDone = false;
let sandboxIdentitySweepDone = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return true;
  }
}

function sweepMatchingDirectories(namePattern: RegExp): void {
  const uid = process.getuid?.();
  let names: string[];
  try {
    // Sweep assumes process tmpdir() names are visible across PID namespaces on this host (typical shared /tmp).
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    const match = name.match(namePattern);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pidAlive(pid)) continue;
    const path = join(tmpdir(), name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (uid !== undefined && stat.uid !== uid) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort hygiene only.
    }
  }
}

export function sweepStaleToolCacheHolders(): void {
  sweepMatchingDirectories(TOOL_CACHE_NAME);
}

export function sweepStaleSandboxIdentityHolders(): void {
  sweepMatchingDirectories(SANDBOX_IDENTITY_NAME);
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type HolderSignal = (typeof SIGNALS)[number];

const signalHandlers = new Map<HolderSignal, () => void>();

function runSignalCleanups(): void {
  for (const cleanup of [...signalCleanups]) {
    try {
      cleanup();
    } catch {
      // Best-effort hygiene only.
    }
  }
}

function removeInstalledSignalHandlers(): void {
  for (const signal of SIGNALS) {
    const handler = signalHandlers.get(signal);
    if (handler) process.removeListener(signal, handler);
  }
  signalHandlers.clear();
  signalHandlersInstalled = false;
}

function installSignalHandlersOnce(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of SIGNALS) {
    const handler = (): void => {
      runSignalCleanups();
      if (process.listenerCount(signal) !== 1) return;
      removeInstalledSignalHandlers();
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.prependListener(signal, handler);
  }
}

export function noteToolCacheHolderCreated(): void {
  if (!toolCacheSweepDone) {
    toolCacheSweepDone = true;
    sweepStaleToolCacheHolders();
  }
  installSignalHandlersOnce();
}

export function noteSandboxIdentityHolderCreated(): void {
  if (!sandboxIdentitySweepDone) {
    sandboxIdentitySweepDone = true;
    sweepStaleSandboxIdentityHolders();
  }
  installSignalHandlersOnce();
}

export function registerTmpHolderSignalCleanup(cleanup: () => void): () => void {
  signalCleanups.add(cleanup);
  installSignalHandlersOnce();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    signalCleanups.delete(cleanup);
  };
}

export function toolCacheHolderPrefix(): string {
  return `${TOOL_CACHE_PREFIX}${process.pid}-`;
}

export function sandboxIdentityHolderPrefix(): string {
  return `${SANDBOX_IDENTITY_PREFIX}${process.pid}-`;
}
