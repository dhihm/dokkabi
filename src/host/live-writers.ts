import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

/**
 * AN EXECUTION IS OVER ONLY WHEN NOTHING OF IT CAN STILL WRITE (G2, D57g,
 * design memo §120/§121; G2', D57h, §123).
 *
 * Any live process a session started under a policy that can write its
 * writable world W makes EVERY image of that tree unknown until it ends —
 * not only the call that started it. The bash tool registers each
 * background job here from its spawn to its end (a job under a read-only
 * policy cannot write W and is not registered: it never blocks); the digest
 * (execution-receipt.ts) reads the registry and marks the image unknown
 * while one lives, naming it; the ledger's continuation line says so.
 *
 * At the end of every call the host ends the call's process tree. On
 * Seatbelt — which has no process namespace — membership is the kernel's
 * answer (execution-membership.ts): every process confined to the
 * execution's profile, whatever it did to its session, environment, parent
 * or argv, is ended, and one that remains is registered here until the
 * kernel shows it gone. The environment marker (DOKKABI_EXEC_MARKER) is
 * still set on every process of a call; the marker scan below
 * (endMarkedProcesses) runs only where the kernel check is unavailable, and
 * there a double-forked daemon that scrubs its environment escapes it (the
 * stated residual of that fallback). On bwrap the pid namespace is the
 * membership.
 */

export const EXEC_MARKER_ENV = "DOKKABI_EXEC_MARKER";

type Writer = { readonly description: string; readonly stillLive?: () => boolean };
const LIVE = new Map<string, Map<string, Writer>>();

function key(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** Register a live writer of `root`; the returned function ends it. With
 * `stillLive`, every read of the registry asks it first and drops the
 * writer once it answers false (a process the host ended and verifies gone). */
export function registerLiveWriter(root: string, id: string, description: string, stillLive?: () => boolean): () => void {
  const at = key(root);
  let writers = LIVE.get(at);
  if (writers === undefined) {
    writers = new Map();
    LIVE.set(at, writers);
  }
  writers.set(id, { description, ...(stillLive === undefined ? {} : { stillLive }) });
  return () => {
    const current = LIVE.get(at);
    current?.delete(id);
    if (current?.size === 0) LIVE.delete(at);
  };
}

/** The live writers of the tree at `root` (real path), described. */
export function liveWritersOf(root: string): readonly string[] {
  const at = key(root);
  const writers = LIVE.get(at);
  if (writers === undefined) return [];
  for (const [id, writer] of [...writers]) {
    let live = true;
    try {
      live = writer.stillLive?.() ?? true;
    } catch {
      live = true;
    }
    if (!live) writers.delete(id);
  }
  if (writers.size === 0) LIVE.delete(at);
  return [...writers.values()].map((writer) => writer.description).sort();
}

/** Cost counters of the marker scans (diagnostics and measurement). */
export const MARKER_SCANS = { scans: 0, ns: 0n, ended: 0 };

/**
 * End every process carrying `marker` in its environment (Seatbelt: the
 * host's `ps -E` of its own user's processes, parsed here; never a shell).
 * Returns how many were ended. A no-op off macOS. The FALLBACK where the
 * kernel membership check is unavailable (execution-membership.ts): it reads
 * every process's environment, which the kernel check never does.
 */
export function endMarkedProcesses(marker: string): number {
  if (process.platform !== "darwin" || !/^[0-9a-f-]{16,64}$/u.test(marker)) return 0;
  const started = process.hrtime.bigint();
  let ended = 0;
  try {
    const listed = spawnSync("/bin/ps", ["-axwwE", "-o", "pid=,command="], { encoding: "latin1", maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
    const needle = `${EXEC_MARKER_ENV}=${marker}`;
    for (const line of (listed.stdout ?? "").split("\n")) {
      const at = line.indexOf(needle);
      if (at < 0) continue;
      const after = line[at + needle.length];
      if (after !== undefined && after !== " ") continue;
      const pid = Number(line.trim().split(/\s+/u, 1)[0]);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
        ended += 1;
      } catch {
        // Already gone.
      }
    }
  } finally {
    MARKER_SCANS.scans += 1;
    MARKER_SCANS.ns += process.hrtime.bigint() - started;
    MARKER_SCANS.ended += ended;
  }
  return ended;
}
