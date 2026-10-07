import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { EventLog } from "../host/event-log.ts";
import { dokkabiHome } from "../host/paths.ts";
import { acquireSessionRunLock } from "../host/session-lock.ts";
import { runDistill } from "../work/distill.ts";
import { distillMaekIngest, maekIndexedForCampaign } from "../work/distill-maek.ts";

/**
 * `dokkabi distill --session ID` — post-campaign self-distillation (#117).
 *
 * Runs as a one-shot process against a finished session's EventLog: the work
 * loop's context is never touched, the log stays the source of truth, and
 * every emitted row is rebuildable from it. A session that still holds its
 * run lock is refused — distillation reads a completed campaign, it does not
 * race a live one. The session identifier is validated and canonically
 * confined to the sessions root before any lock, blob, EventLog, or database
 * write, so a crafted id cannot escape `$DOKKABI_HOME/sessions`.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Reject path shapes and aliases, then prove canonical containment under the
 * sessions root. Returns the absolute session directory. */
export function assertContainedSessionDir(sessionId: string): string {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  }
  if (sessionId === "." || sessionId === "..") {
    throw new Error("invalid session id: directory alias");
  }
  const root = resolve(dokkabiHome(), "sessions");
  const dir = resolve(root, sessionId);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    // The sessions root may not exist yet for a fresh home; resolve() without
    // symlinks still cannot move upward out of it, which the id pattern has
    // already guaranteed contains no separators.
    canonicalRoot = root;
  }
  const canonicalDir = resolve(canonicalRoot, sessionId);
  if (canonicalDir !== canonicalRoot && !canonicalDir.startsWith(canonicalRoot + sep)) {
    throw new Error(`session id escapes the sessions root: ${sessionId}`);
  }
  return canonicalDir;
}

export async function runDistillCommand(args: string[]): Promise<number> {
  let sessionId: string | undefined;
  let withMaek = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--session") {
      sessionId = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--no-maek") {
      withMaek = false;
      continue;
    }
    throw new Error(`unknown distill argument ${arg} (usage: dokkabi distill --session ID [--no-maek])`);
  }
  if (!sessionId) throw new Error("distill requires --session ID");

  const dir = assertContainedSessionDir(sessionId);
  const logPath = join(dir, "events.jsonl");
  if (!existsSync(logPath)) throw new Error(`no session log for ${sessionId} at ${logPath}`);

  const lock = acquireSessionRunLock(dir);
  if (!lock.acquired) {
    throw new Error(`session ${sessionId} is still running (pid ${lock.holder}); distill only reads finished campaigns`);
  }
  try {
    const log = new EventLog(logPath);
    const result = runDistill({ log, sessionId });
    const summary = result.summary?.payload ?? {};
    console.log(`distill: session ${sessionId} ${result.status}`);
    if (result.status === "distilled") {
      console.log(`  reversals: ${summary.reversals}`);
      console.log(`  unresolved faults: ${summary.unresolved_faults} (${(summary.fault_patterns as unknown[]).length} repeated pattern(s))`);
      console.log(`  promote candidates: ${result.candidates.length}`);
      console.log(`  wiki drafts: ${result.drafts.length}`);
    }
    if (withMaek) {
      if (maekIndexedForCampaign(log, sessionId)) {
        console.log("  maek rows indexed: already indexed for this prefix");
      } else {
        // A failed projection throws: the command fails instead of printing
        // success, and the missing distill/maek_indexed row keeps the retry
        // honest (this also covers a previous --no-maek run).
        const rows = await distillMaekIngest({ log, sessionId, dbPath: join(dir, "maek.duckdb") });
        console.log(`  maek rows indexed: ${rows}`);
      }
    }
    return 0;
  } finally {
    lock.release();
  }
}
