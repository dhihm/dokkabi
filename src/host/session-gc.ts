import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { listBeneath, openBeneath, safeRoot } from "../work/link-safe-fs.ts";
import { displayPath } from "../work/path-bytes.ts";
import { acquireBlobGcScope } from "./blob-gc-scope.ts";
import { parseDuration } from "./duration.ts";
import { dokkabiHome } from "./paths.ts";
import { logPathOf, runsPath, type RunRecord } from "./run-registry.ts";
import { readConfig, type DokkabiConfig } from "./config.ts";
import { readSessionLeaseOccupancy } from "./session-lease.ts";
import { probeSessionLock, SESSION_LOCK_FILE } from "./session-lock.ts";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TERMINAL_EVENTS = new Set(["work/run_result", "session/close"]);
const DEFAULT_OLDER_THAN = "14d";
const ROUNDS_SUFFIX = "-rounds";

export interface SessionGcOptions {
  dryRun: boolean;
  olderThanMs: number;
  keepLast: number;
  home: string;
  env: NodeJS.Dict<string>;
}

export interface SessionGcLine {
  action: "remove" | "compact";
  target: string;
  reason: string;
  bytes?: number;
}

export interface SessionGcResult {
  dryRun: boolean;
  lines: SessionGcLine[];
}

export function readSessionRetentionFromConfig(config: DokkabiConfig = readConfig()): {
  olderThan?: string;
  keepLast?: number;
} {
  const retention = config.sessions?.retention;
  if (!retention) return {};
  const keepLast = retention.keep_last;
  if (keepLast !== undefined && (!Number.isInteger(keepLast) || keepLast < 0)) {
    throw new Error("sessions.retention.keep_last requires a non-negative integer");
  }
  return {
    ...(retention.older_than ? { olderThan: retention.older_than } : {}),
    ...(keepLast !== undefined ? { keepLast } : {}),
  };
}

export function parseSessionGcArgs(
  args: readonly string[],
  env: NodeJS.Dict<string> = process.env,
): SessionGcOptions {
  let dryRun = true;
  let olderThanSpec: string | undefined;
  let keepLast: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      dryRun = false;
      continue;
    }
    if (arg === "--older-than") {
      olderThanSpec = args[index + 1];
      if (!olderThanSpec) throw new Error("--older-than requires a duration like 14d");
      index += 1;
      continue;
    }
    if (arg === "--keep-last") {
      const value = args[index + 1];
      if (!value) throw new Error("--keep-last requires a non-negative integer");
      keepLast = Number(value);
      if (!Number.isInteger(keepLast) || keepLast < 0) {
        throw new Error("--keep-last requires a non-negative integer");
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown gc flag ${arg}`);
  }
  const fromConfig = readSessionRetentionFromConfig();
  const olderThanMs = parseDuration(olderThanSpec ?? fromConfig.olderThan ?? DEFAULT_OLDER_THAN);
  return {
    dryRun,
    olderThanMs,
    keepLast: keepLast ?? fromConfig.keepLast ?? 0,
    home: dokkabiHome(env),
    env,
  };
}

export function formatSessionGcResult(result: SessionGcResult): string {
  const header = result.dryRun ? "gc (dry-run):\n" : "gc:\n";
  const body = result.lines
    .map((line) => {
      const extra = line.bytes === undefined ? "" : `\tbytes=${line.bytes}`;
      return `gc\t${line.action}\t${line.target}\t${line.reason}${extra}`;
    })
    .join("\n");
  return body.length === 0 ? header : `${header}${body}\n`;
}

export function runSessionGc(options: SessionGcOptions): SessionGcResult {
  const cutoff = Date.now() - options.olderThanMs;
  const protectedIds = collectProtectedSessionIds(options.home);
  const keepLastIds = collectKeepLastSessionIds(options.home, options.keepLast);
  for (const id of keepLastIds) protectedIds.add(id);

  const lines: SessionGcLine[] = [];
  for (const entry of listSessionEntries(options.home)) {
    if (entry.isSymlink) continue;
    const classification = classifySessionEntry(entry, options.home, cutoff);
    if (!classification) continue;
    if (protectedIds.has(entry.id)) continue;
    const bytes = directoryBytes(entry.path);
    if (options.dryRun) {
      if (sessionInUseReadOnly(options.home, entry.id, entry.path)) continue;
      lines.push({
        action: "remove",
        target: entry.id,
        reason: classification,
        bytes,
      });
      continue;
    }
    if (!removeSessionDirectory(entry.path)) continue;
    lines.push({
      action: "remove",
      target: entry.id,
      reason: classification,
      bytes,
    });
  }

  const staleLineCount = countStaleRunLines(options);
  if (staleLineCount > 0) {
    lines.push({
      action: "compact",
      target: "runs.jsonl",
      reason: `stale_lines=${staleLineCount}`,
    });
    if (!options.dryRun) {
      compactRunsIndex(options);
    }
  }

  return { dryRun: options.dryRun, lines };
}

type SessionEntry = {
  id: string;
  path: string;
  isSymlink: boolean;
  activityMs: number;
};

function listSessionEntries(home: string): SessionEntry[] {
  let root: ReturnType<typeof safeRoot>;
  try {
    root = safeRoot(join(home, "sessions"), "sessions");
  } catch {
    return [];
  }
  const names = listBeneath(root, Buffer.alloc(0), "list sessions");
  if (!names) return [];
  const out: SessionEntry[] = [];
  for (const rel of names) {
    const id = displayPath(rel);
    if (!SESSION_ID.test(id)) continue;
    const path = join(home, "sessions", id);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    const logPath = join(path, "events.jsonl");
    const signals = readSessionSignals(logPath);
    out.push({
      id,
      path,
      isSymlink: stat.isSymbolicLink(),
      activityMs: signals.activityMs > 0 ? signals.activityMs : stat.mtimeMs,
    });
  }
  return out;
}

function collectProtectedSessionIds(home: string): Set<string> {
  const protectedIds = new Set<string>();
  const workspaces = join(home, "workspaces");
  let dirs: string[];
  try {
    dirs = readdirSync(workspaces);
  } catch {
    return protectedIds;
  }
  for (const digest of dirs) {
    const pointer = join(workspaces, digest, "latest-work-session");
    try {
      const id = readFileSync(pointer, "utf8").trim();
      if (SESSION_ID.test(id)) protectedIds.add(id);
    } catch {
      // No pointer for this workspace.
    }
  }
  return protectedIds;
}

function collectKeepLastSessionIds(home: string, keepLast: number): Set<string> {
  const kept = new Set<string>();
  if (keepLast <= 0) return kept;
  const entries = listSessionEntries(home)
    .filter((entry) => !entry.isSymlink)
    .sort((left, right) => right.activityMs - left.activityMs);
  for (const entry of entries.slice(0, keepLast)) kept.add(entry.id);
  return kept;
}

function classifySessionEntry(entry: SessionEntry, home: string, cutoffMs: number): string | undefined {
  if (entry.id.endsWith(ROUNDS_SUFFIX)) {
    const parent = entry.id.slice(0, -ROUNDS_SUFFIX.length);
    const parentPath = join(home, "sessions", parent);
    if (!existsSync(parentPath)) return "orphan_rounds";
    return undefined;
  }
  const signals = readSessionSignals(join(entry.path, "events.jsonl"));
  if (!signals.hasModelRequest) return "dead";
  if (signals.terminalTs === undefined) return undefined;
  const terminalMs = Date.parse(signals.terminalTs);
  if (!Number.isFinite(terminalMs)) return undefined;
  if (terminalMs <= cutoffMs) return "terminal_expired";
  return undefined;
}

function readSessionSignals(logPath: string): {
  hasModelRequest: boolean;
  terminalTs?: string;
  activityMs: number;
} {
  let hasModelRequest = false;
  let terminalTs: string | undefined;
  try {
    const text = readFileSync(logPath, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let row: { name?: string; ts?: string };
      try {
        row = JSON.parse(line) as { name?: string; ts?: string };
      } catch {
        continue;
      }
      if (row.name === "provider/request") hasModelRequest = true;
      if (row.name && TERMINAL_EVENTS.has(row.name)) terminalTs = row.ts ?? terminalTs;
    }
  } catch {
    // Missing or unreadable logs are treated as dead by the caller.
  }
  let activityMs = 0;
  if (terminalTs !== undefined) {
    const parsed = Date.parse(terminalTs);
    if (Number.isFinite(parsed)) activityMs = parsed;
  }
  if (activityMs === 0) {
    try {
      activityMs = statSync(logPath).mtimeMs;
    } catch {
      activityMs = 0;
    }
  }
  return { hasModelRequest, terminalTs, activityMs };
}

/** Read-only: a live run lock or interactive lease blocks removal; never creates lock files. */
function sessionInUseReadOnly(home: string, sessionId: string, sessionDir: string): boolean {
  try {
    const root = safeRoot(join(home, "sessions"), "sessions");
    const opened = openBeneath(root, Buffer.from(`${sessionId}/${SESSION_LOCK_FILE}`), "probe session lock");
    if (opened !== undefined) {
      try {
        const probe = probeSessionLock(opened.fd);
        if (probe.state === "held" && probe.identityMatches) return true;
      } finally {
        opened.close();
      }
    }
  } catch {
    // No lock file or unreadable sessions root.
  }
  const lease = readSessionLeaseOccupancy(sessionDir);
  return lease.state === "live";
}

function removeSessionDirectory(sessionDir: string): boolean {
  const scope = acquireBlobGcScope(sessionDir);
  if (!scope.acquired) return false;
  try {
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  } finally {
    scope.release();
  }
}

function directoryBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const child = join(current, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(child);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) stack.push(child);
      else total += stat.size;
    }
  }
  return total;
}

function countStaleRunLines(options: SessionGcOptions): number {
  const path = runsPath(options.env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as RunRecord;
      if (typeof parsed.home !== "string" || typeof parsed.session !== "string") continue;
      if (parsed.home === options.home && !existsSync(logPathOf(parsed))) count += 1;
    } catch {
      continue;
    }
  }
  return count;
}

function compactRunsIndex(options: SessionGcOptions): void {
  const path = runsPath(options.env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const kept = text
    .split("\n")
    .filter((line) => {
      if (line.trim() === "") return false;
      try {
        const parsed = JSON.parse(line) as RunRecord;
        if (typeof parsed.home !== "string" || typeof parsed.session !== "string") return true;
        return !(parsed.home === options.home && !existsSync(logPathOf(parsed)));
      } catch {
        return true;
      }
    });
  const next = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
  const tmp = `${path}.${process.pid}.gc.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, path);
}
