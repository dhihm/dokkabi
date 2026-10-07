import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "./run-registry.ts";

/**
 * Runs that never registered themselves.
 *
 * `run-registry.ts` is the primary answer to "where is the run": a run writes
 * a line when it starts. But a run started from a different checkout — an
 * older build, a probe tree under /tmp — has no such code, and a run that
 * began before the registry existed left no line either. Those processes are
 * still visibly running, so the board reads the process table as a fallback.
 *
 * This is deliberately second: it is Linux-shaped, it depends on a process
 * table rather than on a record, and it disappears the moment the process
 * exits. The registry stays the thing that survives.
 */

export interface ProcessInfo {
  pid: number;
  argv: string[];
  env: NodeJS.Dict<string>;
}

/** The commands that append to a session log. `dash` observes; it is not one. */
const RUN_COMMANDS = new Set(["work", "turn"]);

/**
 * Which session, under which home, a command line is driving — or undefined
 * when it is not a run at all.
 */
export function parseRunCommandLine(
  argv: readonly string[],
  env: NodeJS.Dict<string>,
): { home: string; session: string } | undefined {
  const cliAt = argv.findIndex((arg) => arg.endsWith("cli.ts") || arg.endsWith("dokkabi") || arg.endsWith("gabi"));
  if (cliAt < 0) {
    return undefined;
  }
  const command = argv[cliAt + 1];
  if (!command || !RUN_COMMANDS.has(command)) {
    return undefined;
  }
  const flagAt = argv.indexOf("--session");
  const session = flagAt >= 0 ? argv[flagAt + 1] : undefined;
  const home = env.DOKKABI_HOME ?? join(env.HOME?.trim() ? env.HOME : homedir(), ".dokkabi");
  return { home, session: session && session.length > 0 ? session : "live" };
}

/** Live runs found in the process table, newest-looking first. */
export function runsFromProcesses(scan: () => ProcessInfo[] = scanProcesses): RunRecord[] {
  let processes: ProcessInfo[];
  try {
    processes = scan();
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  const seen = new Set<string>();
  for (const info of processes) {
    let found: { home: string; session: string } | undefined;
    try {
      found = parseRunCommandLine(info.argv, info.env);
    } catch {
      continue;
    }
    if (!found) {
      continue;
    }
    const logPath = join(found.home, "sessions", found.session, "events.jsonl");
    if (!existsSync(logPath)) {
      // A process with no log yet is not something the board can open.
      continue;
    }
    const key = `${found.home} ${found.session}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      ts: new Date().toISOString(),
      home: found.home,
      session: found.session,
      pid: info.pid,
      label: commandOf(info.argv),
    });
  }
  return out;
}

function commandOf(argv: readonly string[]): string {
  const at = argv.findIndex((arg) => arg.endsWith("cli.ts") || arg.endsWith("dokkabi") || arg.endsWith("gabi"));
  return argv[at + 1] ?? "work";
}

/** Read /proc. Returns an empty list wherever that does not exist. */
function scanProcesses(): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((part) => part.length > 0);
      if (argv.length === 0 || !argv.some((arg) => arg.includes("cli.ts") || arg.endsWith("dokkabi"))) {
        continue;
      }
      const env: NodeJS.Dict<string> = {};
      for (const pair of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
        const at = pair.indexOf("=");
        if (at > 0) {
          env[pair.slice(0, at)] = pair.slice(at + 1);
        }
      }
      out.push({ pid, argv, env });
    } catch {
      // The process exited between readdir and read, or is not ours.
    }
  }
  return out;
}
