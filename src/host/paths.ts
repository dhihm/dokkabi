import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function dokkabiHome(): string {
  return process.env.DOKKABI_HOME ?? join(homedir(), ".dokkabi");
}

/** The environment variable a caller names the workspace in when it does not
 * pass --workspace (a HEUNG or Ralph Plan work child, for one). */
export const WORKSPACE_ENV = "DOKKABI_WORKSPACE";

/**
 * The workspace a command works on (D49): `--workspace`, else
 * DOKKABI_WORKSPACE, else the current directory, as an absolute path.
 * Resolved once per command, and every use of the workspace in it — the
 * session id, the latest-session pointer, the run lock, the run breadcrumb,
 * boot — takes this one value, so a run never picks its session in one
 * directory and works in another. The commands that read "this workspace's
 * session" resolve it the same way.
 */
export function resolveWorkspaceRoot(
  flag?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): string {
  const fromEnv = env[WORKSPACE_ENV];
  const chosen = flag ?? (fromEnv === undefined || fromEnv === "" ? undefined : fromEnv);
  return chosen === undefined ? resolve(cwd) : resolve(cwd, chosen);
}

/** The digest of the workspace's real path: stable across spellings
 * (trailing slash, symlink, relative), distinct for every directory. */
export function workspaceDigest(workspaceRoot: string = process.cwd()): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(workspaceRoot));
  } catch {
    canonical = resolve(workspaceRoot);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 10);
}

/**
 * The workspace's stable session identity, `live-<digest>`. A bare constant
 * ("live") meant every checkout and every directory shared one session dir —
 * two dokkabi processes in two repos wrote the same log and transcript and
 * bled context into each other. Chat and turn still default to this id; a
 * `dokkabi work` run no longer does (newWorkSessionId), and every session
 * recorded before that change carries it, so the read side falls back to it
 * (resolveWorkspaceSessionId). An explicit --session ID remains global, by
 * operator choice.
 */
export function workspaceSessionId(workspaceRoot: string = process.cwd()): string {
  return `live-${workspaceDigest(workspaceRoot)}`;
}

/**
 * A fresh work session id for this workspace: `live-<digest>-<time>-<rand>`.
 * A second run in the same checkout used to reopen the first one's session
 * (same order: an instant deadline stop; another order: refused), so every
 * `dokkabi work` that names no session and does not resume starts a new one.
 * The time part is base-36 milliseconds padded to a fixed width, so ids of one
 * workspace sort by creation; the random part separates two runs started in
 * the same millisecond. Filesystem-safe: lowercase letters, digits, dashes.
 */
export function newWorkSessionId(
  workspaceRoot: string = process.cwd(),
  nowMs: number = Date.now(),
  random: string = randomBytes(3).toString("hex"),
): string {
  return `${workspaceSessionId(workspaceRoot)}-${Math.max(0, Math.floor(nowMs)).toString(36).padStart(9, "0")}-${random}`;
}

/** Where the workspace's latest work session is named: one small file under
 * the Dokkabi home, keyed by the workspace digest. */
export function latestWorkSessionPath(workspaceRoot: string = process.cwd(), home: string = dokkabiHome()): string {
  return join(home, "workspaces", workspaceDigest(workspaceRoot), "latest-work-session");
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Name `sessionId` as the workspace's latest work session. Written through
 * a temporary file and a rename, so a reader sees the old id or the new one,
 * never a torn line. */
export function recordLatestWorkSession(workspaceRoot: string, sessionId: string, home: string = dokkabiHome()): void {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error(`refusing to record an unsafe session id ${JSON.stringify(sessionId)}`);
  }
  const path = latestWorkSessionPath(workspaceRoot, home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${sessionId}\n`);
  renameSync(temporary, path);
}

/** The workspace's latest work session, or undefined when none was recorded
 * (or the pointer does not hold a safe id). */
export function readLatestWorkSession(workspaceRoot: string = process.cwd(), home: string = dokkabiHome()): string | undefined {
  let text: string;
  try {
    text = readFileSync(latestWorkSessionPath(workspaceRoot, home), "utf8");
  } catch {
    return undefined;
  }
  const id = text.trim();
  return SAFE_SESSION_ID.test(id) && id !== "." && id !== ".." ? id : undefined;
}

/** "This workspace's session" for every command that reads or continues one
 * without --session: the latest work session, else the legacy stable id, so
 * sessions recorded before work runs got ids of their own are still found. */
export function resolveWorkspaceSessionId(workspaceRoot: string = process.cwd(), home: string = dokkabiHome()): string {
  return readLatestWorkSession(workspaceRoot, home) ?? workspaceSessionId(workspaceRoot);
}

export function sessionDir(sessionId: string): string {
  return join(dokkabiHome(), "sessions", sessionId);
}

export function sessionLogPath(sessionId: string): string {
  return join(sessionDir(sessionId), "events.jsonl");
}

/** Pi coding-agent home. `pi-ai login` writes ./auth.json in cwd instead. */
export function defaultPiAuthPath(): string {
  // $HOME first (Node homedir semantics); Bun's homedir() reads the passwd
  // entry, which would make every test host-dependent.
  const home = process.env.HOME?.trim() ? process.env.HOME : homedir();
  return join(home, ".pi", "agent", "auth.json");
}

/** Mutable auth storage is selected by the operator, never discovered in a
 * model-controlled repository or its ancestors. The argument remains for API
 * compatibility but does not influence credential authority. */
export function piAuthPath(_cwd = process.cwd()): string {
  return process.env.DOKKABI_PI_AUTH || defaultPiAuthPath();
}

export function repoRootFrom(importMetaDir: string): string {
  return join(importMetaDir, "..", "..");
}
