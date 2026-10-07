import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Session switching for the board (#dokkabi-dev#47).
 *
 * Resolution is deliberately the same question `dokkabi dash --session`
 * answers: an exact directory under `<home>/sessions` wins, and the special
 * `swe` name follows the newest `swe-*` instance because per-instance runs
 * roll over mid-watch. Kept pure (path in, decision out) so the switch is
 * testable without driving the terminal loop.
 */

export interface SessionTarget {
  ok: true;
  path: string;
  label: string;
}

export interface SessionMiss {
  ok: false;
  reason: string;
}

export function resolveSessionTarget(name: string, home: string): SessionTarget | SessionMiss {
  const sessionsDir = join(home, "sessions");
  const trimmed = name.trim();
  const exact = join(sessionsDir, trimmed, "events.jsonl");
  if (existsSync(exact)) {
    return { ok: true, path: exact, label: trimmed };
  }
  if (trimmed === "swe" || trimmed.startsWith("swe-")) {
    let newest: { path: string; label: string; mtime: number } | undefined;
    try {
      for (const entry of readdirSync(sessionsDir)) {
        const candidate = entry;
        if (!candidate.startsWith("swe-")) {
          continue;
        }
        const log = join(sessionsDir, candidate, "events.jsonl");
        if (!existsSync(log)) {
          continue;
        }
        const mtime = statSync(log).mtimeMs;
        if (newest === undefined || mtime > newest.mtime) {
          newest = { path: log, label: candidate, mtime };
        }
      }
    } catch {
      // Unreadable home: fall through to the miss below.
    }
    if (newest !== undefined) {
      return { ok: true, path: newest.path, label: newest.label };
    }
  }
  return { ok: false, reason: `no session called "${trimmed}" under ${sessionsDir}` };
}

/** Whether this board may switch what it watches. A board with a live note
 * seam is attached to a running kernel in another session — switching the
 * log under it would send notes to a session the operator is no longer
 * looking at. Read-only watchers are free. */
export function sessionSwitchAllowed(options: { interactive: boolean }): boolean {
  return options.interactive !== true;
}
