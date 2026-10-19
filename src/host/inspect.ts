import { realpathSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { hostComputationLifeline } from "./sandbox.ts";
import { isAbsolute, relative, resolve } from "node:path";
import { expandHomePath, openWorkspaceAnchor, workspaceRelativePath, type WorkspaceAnchor, type WorkspaceEntry, type WorkspaceEntryKind } from "./workspace-path.ts";
import { missingPathError, outsideWorkspaceError, symlinkPathError, unsupportedPathError } from "./path-error.ts";
import { credentialPathRefusal, isSecretPath } from "./workspace-secrets.ts";

/** Directories that never participate in search: dependency and VCD noise. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

export const GREP_MAX_RESULTS = 200;
export const GLOB_MAX_RESULTS = 500;
export const LS_MAX_ENTRIES = 500;

export interface GrepMatch {
  /** Workspace-relative file path. */
  path: string;
  /** 1-based line number. */
  line: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  /** NUL-containing files excluded from text search. */
  binarySkipped?: number;
  /** #228 Q1''': matches whose text the 500-character clamp cut. */
  clamped?: number;
  /** #228 C1'': the caller's signal aborted between files; the matches are
   * those found before it, and the search stopped there. */
  cancelled?: true;
  /** The bounded asynchronous search stopped before all files were searched. */
  timedOut?: true;
}

/** #228 Q1': a bounded listing states its own omission — the entries kept,
 * whether the cap cut the listing, and whether a signal stopped it. */
export interface WorkspaceListing {
  entries: string[];
  truncated: boolean;
  limit: number;
  cancelled?: true;
}

function withAnchor<T>(root: string, use: (anchor: WorkspaceAnchor) => T): T {
  const anchor = openWorkspaceAnchor(root);
  try {
    return use(anchor);
  } finally {
    anchor.close();
  }
}

function childPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

/**
 * Classify the caller-given base of a grep or ls: a directory to descend into
 * or one file to address directly. The three ways the path can be wrong —
 * outside the workspace, missing, an unusable kind — each get their own
 * message from the shared vocabulary, so the model can correct the call
 * instead of retrying the same refusal.
 */
function resolveInspectBase(
  anchor: WorkspaceAnchor,
  tool: "grep" | "ls",
  input: string | undefined,
  needs: string,
): { kind: "file" | "directory"; path: string } {
  const shown = input ?? ".";
  let base: string;
  try {
    base = workspaceRelativePath(anchor.root, shown);
  } catch {
    throw outsideWorkspaceError(tool, shown);
  }
  if (base.includes("\0") || base.split(/[\\/]/u).includes("..")) {
    throw outsideWorkspaceError(tool, shown);
  }
  if (isSecretPath(base)) throw credentialPathRefusal();
  let kind: WorkspaceEntryKind;
  try {
    kind = anchor.kind(base);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw missingPathError(tool, shown);
    if (code === "ELOOP") throw symlinkPathError(tool, shown);
    throw error;
  }
  if (kind === "other") throw unsupportedPathError(tool, shown, needs);
  return { kind, path: base };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

/**
 * Enumerate from a stable workspace directory capability. Every `list` and
 * later `readFile` reopens each component from the root fd with O_NOFOLLOW.
 * A concurrent rename may make an entry disappear or replace it with another
 * in-workspace inode, but it cannot redirect either operation through a
 * symlink after a pathname check.
 */
function walk(
  anchor: WorkspaceAnchor,
  dir: string,
  out: string[],
  visitedDirectories = new Set<string>(),
  visitedFiles = new Set<string>(),
): void {
  let entries: WorkspaceEntry[];
  try {
    entries = anchor.list(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const relative = childPath(dir, entry.name);
    if (entry.kind === "file" && isSecretPath(relative)) continue;
    if (entry.kind === "directory") {
      if (visitedDirectories.has(entry.identity)) continue;
      visitedDirectories.add(entry.identity);
      walk(anchor, relative, out, visitedDirectories, visitedFiles);
    } else if (entry.kind === "file" && !visitedFiles.has(entry.identity)) {
      visitedFiles.add(entry.identity);
      out.push(relative);
    }
  }
}

/**
 * Regex search over workspace text files. Skips node_modules and .git,
 * stops at maxResults, and opens every file beneath the workspace root fd.
 * `path` may name a directory to walk or one file to search; a file is
 * still held to the glob filter.
 */
export function grepWorkspace(input: {
  root: string;
  pattern: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
  signal?: AbortSignal;
}): GrepResult {
  return withAnchor(input.root, (anchor) => {
    const base = resolveInspectBase(anchor, "grep", input.path, "grep needs a file or directory to search");
    const regex = new RegExp(input.pattern, input.caseSensitive === false ? "i" : "");
    const matcher = input.glob ? new Bun.Glob(input.glob) : undefined;
    // Like rg -g: a glob without a slash matches the basename at any depth.
    const matchFile = (shown: string): boolean => {
      if (!matcher) return true;
      return input.glob!.includes("/") ? matcher.match(shown) : matcher.match(shown.split("/").pop()!);
    };
    const limit = input.maxResults ?? GREP_MAX_RESULTS;
    const files: string[] = [];
    if (base.kind === "file") files.push(base.path);
    else walk(anchor, base.path, files);
    const matches: GrepMatch[] = [];
    let truncated = false;
    let cancelled = false;
    let clamped = 0;
    let binarySkipped = 0;
    outer: for (const shown of files) {
      // C1'': the signal is honoured between files; what was found stands.
      if (input.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (!matchFile(shown)) continue;
      let text: string;
      try {
        const bytes = Buffer.from(anchor.readFile(shown));
        if (bytes.includes(0)) {
          binarySkipped += 1;
          continue;
        }
        text = bytes.toString("utf8");
      } catch (error) {
        // A walked entry may disappear or become a symlink after enumeration;
        // an explicitly named file reports its failure instead.
        if (base.kind === "file") throw error;
        continue;
      }
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index]!)) {
          if (lines[index]!.length > 500) clamped += 1;
          matches.push({ path: shown, line: index + 1, text: lines[index]!.slice(0, 500) });
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    return { matches, truncated, ...(binarySkipped > 0 ? { binarySkipped } : {}), ...(clamped > 0 ? { clamped } : {}), ...(cancelled ? { cancelled: true as const } : {}) };
  });
}

// Inline so compiled CLI builds need no sidecar. BUN_BE_BUN also supports the
// compiled executable. Only regex evaluation leaves the host; workspace reads
// retain the fd anchor. An OS child can be killed even inside native RegExp.
const GREP_WORKER = `
const readline = require("node:readline");
readline.createInterface({input: process.stdin}).on("line", line => {
  const {text, pattern, insensitive, limit} = JSON.parse(line);
  try {
    const re = new RegExp(pattern, insensitive ? "i" : "");
    const matches = []; let clamped = 0;
    const lines = text.split("\\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        if (lines[i].length > 500) clamped++;
        matches.push({line: i + 1, text: lines[i].slice(0, 500)});
        if (matches.length >= limit) break;
      }
    }
    process.stdout.write(JSON.stringify({matches, clamped}) + "\\n");
  } catch (e) { process.stdout.write(JSON.stringify({error: String(e)}) + "\\n"); }
});`;

/** Model-facing grep: arbitrary JS regexes cannot monopolize the host thread. */
export async function grepWorkspaceAsync(
  input: Parameters<typeof grepWorkspace>[0] & { timeoutMs?: number },
): Promise<GrepResult> {
  // Validate on the host before allocating a worker, preserving typed failures.
  new RegExp(input.pattern, input.caseSensitive === false ? "i" : "");
  const anchor = openWorkspaceAnchor(input.root);
  let worker: ChildProcessWithoutNullStreams | undefined;
  let settled: Promise<void> | undefined;
  let lifeline: ReturnType<typeof hostComputationLifeline> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const base = resolveInspectBase(anchor, "grep", input.path, "grep needs a file or directory to search");
    if (input.signal?.aborted) return { matches: [], truncated: false, cancelled: true };
    const files: string[] = [];
    if (base.kind === "file") files.push(base.path);
    else walk(anchor, base.path, files);
    const matcher = input.glob ? new Bun.Glob(input.glob) : undefined;
    const limit = input.maxResults ?? GREP_MAX_RESULTS;
    const matches: GrepMatch[] = [];
    let binarySkipped = 0, clamped = 0, truncated = false;
    let stopped: "cancelled" | "timeout" | undefined;
    let stop!: () => void;
    const interrupted = new Promise<undefined>((resolve) => { stop = () => resolve(undefined); });
    onAbort = () => { stopped = "cancelled"; stop(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { stopped = "timeout"; stop(); }, input.timeoutMs ?? 10_000);
    lifeline = hostComputationLifeline([process.execPath, "--no-env-file", "--eval", GREP_WORKER]);
    worker = spawn(lifeline.argv[0]!, lifeline.argv.slice(1), {
      env: { BUN_BE_BUN: "1" }, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    settled = new Promise((resolve) => { worker!.once("close", () => resolve()); });
    type Reply = { matches: Omit<GrepMatch, "path">[]; clamped: number; error?: string };
    let receive: ((value: Reply) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    const responses = createInterface({ input: worker.stdout });
    responses.on("line", (line) => {
      try { receive?.(JSON.parse(line) as Reply); }
      catch (error) { reject?.(error instanceof Error ? error : new Error(String(error))); }
    });
    let failureText = "";
    worker.stderr.on("data", (data: Buffer) => { failureText = (failureText + data.toString()).slice(0, 2000); });
    worker.stdin.on("error", (error) => reject?.(error));
    worker.on("error", (error) => reject?.(error));
    worker.on("close", () => reject?.(new Error(`grep helper exited before its result${failureText ? `: ${failureText}` : ""}`)));
    for (const shown of files) {
      if (stopped) break;
      if (matcher && !matcher.match(input.glob!.includes("/") ? shown : shown.split("/").pop()!)) continue;
      let text: string;
      try {
        const bytes = Buffer.from(anchor.readFile(shown));
        if (bytes.includes(0)) { binarySkipped++; continue; }
        text = bytes.toString("utf8");
      } catch (error) {
        if (base.kind === "file") throw error;
        continue;
      }
      const answer = new Promise<Reply>((resolve, fail) => { receive = resolve; reject = fail; });
      worker.stdin.write(JSON.stringify({ text, pattern: input.pattern, insensitive: input.caseSensitive === false, limit: limit - matches.length }) + "\n");
      const result = await Promise.race([answer, interrupted]);
      if (!result) break;
      if (result.error) throw new Error(result.error);
      clamped += result.clamped;
      matches.push(...result.matches.map((match) => ({ path: shown, ...match })));
      if (matches.length >= limit) { truncated = true; break; }
    }
    return {
      matches, truncated,
      ...(binarySkipped ? { binarySkipped } : {}), ...(clamped ? { clamped } : {}),
      ...(stopped === "timeout" ? { timedOut: true as const } : {}),
      ...(stopped === "cancelled" ? { cancelled: true as const } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    if (worker) {
      if (worker.pid) {
        try { process.kill(-worker.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await settled;
    }
    lifeline?.release();
    anchor.close();
  }
}

/**
 * File-name globbing relative to the workspace root. Dotfiles and
 * node_modules are never returned; absolute or escaping patterns refuse.
 * A `~/…` pattern — the spelling home-path normalization puts in tool
 * output — expands against the operator's home and must land inside the
 * workspace, where it becomes the equivalent root-relative pattern.
 */
export function globWorkspace(input: { root: string; pattern: string; maxResults?: number; signal?: AbortSignal }): string[] {
  return globWorkspaceListing(input).entries;
}

/** The glob with its own statement of omission (Q1') and cancellation (C1''). */
export function globWorkspaceListing(input: { root: string; pattern: string; maxResults?: number; signal?: AbortSignal }): WorkspaceListing {
  let pattern = input.pattern;
  if (pattern === "~" || pattern.startsWith("~/")) {
    const expanded = expandHomePath(pattern);
    const canonicalRoot = realpathSync(resolve(input.root));
    const rel = relative(canonicalRoot, resolve(expanded));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw outsideWorkspaceError("glob", input.pattern);
    }
    pattern = rel;
  }
  if (pattern.startsWith("/") || pattern.includes("..")) {
    throw outsideWorkspaceError("glob", input.pattern);
  }
  return withAnchor(input.root, (anchor) => {
    const matcher = new Bun.Glob(pattern);
    const files: string[] = [];
    walk(anchor, ".", files);
    const limit = input.maxResults ?? GLOB_MAX_RESULTS;
    const out: string[] = [];
    let truncated = false;
    let cancelled = false;
    for (const path of files) {
      if (input.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (path.split("/").some((part) => part.startsWith("."))) continue;
      if (!matcher.match(path)) continue;
      if (out.length >= limit) {
        // The cap cut the listing: said, never silent.
        truncated = true;
        break;
      }
      out.push(path);
    }
    return { entries: out.sort(), truncated, limit, ...(cancelled ? { cancelled: true as const } : {}) };
  });
}

/**
 * Flat directory listing: directories first with a trailing slash, then
 * files, both sorted. A path that names a file lists that one file, like
 * `ls <file>` does.
 */
export function lsWorkspace(input: { root: string; path?: string; signal?: AbortSignal }): string[] {
  return lsWorkspaceListing(input).entries;
}

/** The listing with its own statement of omission (Q1') and cancellation (C1''). */
export function lsWorkspaceListing(input: { root: string; path?: string; signal?: AbortSignal }): WorkspaceListing {
  return withAnchor(input.root, (anchor) => {
    const base = resolveInspectBase(anchor, "ls", input.path, "ls needs a file or directory to list");
    if (base.kind === "file") {
      return { entries: [base.path.split("/").at(-1) ?? base.path], truncated: false, limit: LS_MAX_ENTRIES };
    }
    const dirs: string[] = [];
    const files: string[] = [];
    let truncated = false;
    let cancelled = false;
    for (const entry of anchor.list(base.path)) {
      if (input.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (entry.kind !== "directory" && entry.kind !== "file") continue;
      if (entry.kind === "file" && isSecretPath(childPath(base.path, entry.name))) continue;
      if (dirs.length + files.length >= LS_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (entry.kind === "directory") dirs.push(`${entry.name}/`);
      else files.push(entry.name);
    }
    return { entries: [...dirs.sort(), ...files.sort()], truncated, limit: LS_MAX_ENTRIES, ...(cancelled ? { cancelled: true as const } : {}) };
  });
}
