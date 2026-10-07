import { existsSync } from "node:fs";
import type { EventLog } from "./event-log.ts";
import { spawnSealedHostGit } from "./git-authority.ts";
import { credentialPathRefusal, isSecretPath } from "./workspace-secrets.ts";

/** A body handed to the model is capped like every other tool result. */
export const REPO_READ_LIMIT = 100_000;

/** grep over a whole repository can match thousands of lines; cap it. */
export const REPO_GREP_LIMIT = 200;

/** Registered repositories: "owner/name" to an absolute local clone path. */
export type RepoRegistry = Record<string, string>;

/** Look a repository up in the registry. Unregistered repositories are refused. */
export function resolveRepoPath(registry: RepoRegistry, repo: string): string {
  const path = registry[repo];
  if (!path) {
    const known = Object.keys(registry).sort().join(", ") || "none";
    throw new Error(`${repo} is not in the repo registry (registered: ${known})`);
  }
  return path;
}

/** Pathspecs are repository-relative; anything climbing out is refused. */
export function assertRepoPath(path: string): void {
  if (isSecretPath(path)) throw credentialPathRefusal();
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`path escapes the repository: ${path}`);
  }
}

export interface GitOutput {
  ok: boolean;
  out: string;
  err: string;
}

export type GitRunner = (cwd: string, args: string[]) => GitOutput;

/** Git over a registered clone through the sealed boundary (S2, D57e): a
 * registered path may be a tree a session writes, and a git reading its
 * configuration there (log.showSignature, include.path, …) would run what the
 * session named as the host. The reads here need only objects and refs, which
 * the boundary gives git as data. */
export const defaultGitRunner: GitRunner = (cwd, args) => {
  try {
    const result = spawnSealedHostGit(cwd, args, { timeoutMs: 60_000 });
    return {
      ok: result.exitCode === 0,
      out: result.stdout?.toString() ?? "",
      err: (result.stderr?.toString() ?? "").trim(),
    };
  } catch (error) {
    return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) };
  }
};

export interface RepoPin {
  repo: string;
  path: string;
  ref: string;
  sha: string;
  /** ISO date of the pinned commit: stale code has to be visible as stale. */
  committed: string;
  subject: string;
}

/**
 * Which revision to read when the caller names none: the remote's default
 * branch as this clone knows it, not the checked-out branch. A working
 * checkout sits on whatever branch the operator last used, which is how an
 * analysis ends up describing months-old code as current.
 */
function defaultRef(repoPath: string, git: GitRunner): string {
  const remote = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const name = remote.out.trim();
  return remote.ok && name ? name : "HEAD";
}

/**
 * Resolve a repository and ref to an immutable commit.
 *
 * Reads are served straight out of git object storage — no worktree, no
 * export, no copy on disk. The operator's clone is never mutated, not even
 * its worktree list, and a 2 GB repository costs nothing to read.
 */
export function repoPin(input: {
  registry: RepoRegistry;
  repo: string;
  ref?: string;
  git?: GitRunner;
}): RepoPin {
  const git = input.git ?? defaultGitRunner;
  const path = resolveRepoPath(input.registry, input.repo);
  if (!existsSync(path)) {
    throw new Error(`registered path is missing: ${path}`);
  }
  const ref = input.ref ?? defaultRef(path, git);
  const resolved = git(path, ["rev-parse", `${ref}^{commit}`]);
  const sha = resolved.out.trim();
  if (!resolved.ok || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`cannot resolve ref ${ref} in ${input.repo}: ${resolved.err || "unknown revision"}`);
  }
  const meta = git(path, ["show", "-s", "--format=%cI%n%s", sha]);
  const [committed = "", subject = ""] = meta.out.trim().split("\n");
  return { repo: input.repo, path, ref, sha, committed, subject };
}

export interface RepoGrepMatch {
  path: string;
  line: number;
  text: string;
}

/** git grep at a pinned commit: the whole tree at that revision, nothing else. */
export function repoGrep(input: {
  pin: RepoPin;
  pattern: string;
  path?: string;
  caseSensitive?: boolean;
  maxResults?: number;
  git?: GitRunner;
}): { matches: RepoGrepMatch[]; truncated: boolean } {
  const git = input.git ?? defaultGitRunner;
  if (input.path) {
    assertRepoPath(input.path);
  }
  // NUL-delimited names preserve Unicode, colons and embedded newlines;
  // quoted/display paths cannot decide credential identity.
  const args = ["grep", "-z", "-I", "-n", "--no-color", "-E"];
  if (input.caseSensitive === false) {
    args.push("-i");
  }
  args.push("-e", input.pattern, input.pin.sha);
  if (input.path) {
    args.push("--", input.path);
  }
  const result = git(input.pin.path, args);
  // git grep exits 1 with no output when nothing matched; that is not an error.
  if (!result.ok && result.out.trim() === "") {
    if (result.err) {
      throw new Error(result.err.slice(0, 200));
    }
    return { matches: [], truncated: false };
  }
  const limit = input.maxResults ?? REPO_GREP_LIMIT;
  const matches: RepoGrepMatch[] = [];
  let cursor = 0;
  let truncated = false;
  while (cursor < result.out.length) {
    const nameEnd = result.out.indexOf("\0", cursor);
    const lineEnd = result.out.indexOf("\0", nameEnd + 1);
    if (nameEnd < 0 || lineEnd < 0) break;
    const textEnd = result.out.indexOf("\n", lineEnd + 1);
    const end = textEnd < 0 ? result.out.length : textEnd;
    const name = result.out.slice(cursor, nameEnd);
    const path = name.startsWith(`${input.pin.sha}:`) ? name.slice(input.pin.sha.length + 1) : name;
    const line = Number(result.out.slice(nameEnd + 1, lineEnd));
    const text = result.out.slice(lineEnd + 1, end);
    cursor = end + 1;
    if (!Number.isSafeInteger(line) || line < 1 || isSecretPath(path)) continue;
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    matches.push({
      path,
      line,
      text: text.slice(0, 500),
    });
  }
  return { matches, truncated };
}

/** One directory level at the pinned commit; directories carry a trailing slash. */
export function repoLs(input: { pin: RepoPin; path?: string; git?: GitRunner }): string[] {
  const git = input.git ?? defaultGitRunner;
  if (input.path) {
    assertRepoPath(input.path);
  }
  const treeish = input.path ? `${input.pin.sha}:${input.path}` : input.pin.sha;
  const result = git(input.pin.path, ["ls-tree", "-z", treeish]);
  if (!result.ok) {
    throw new Error(result.err.slice(0, 200) || `cannot list ${input.path ?? "."}`);
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const line of result.out.split("\0")) {
    if (line === "") {
      continue;
    }
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const meta = line.slice(0, separator);
    const name = line.slice(separator + 1);
    const type = meta.split(" ")[1] ?? "";
    if (type !== "tree" && isSecretPath(name)) continue;
    if (type === "tree") {
      dirs.push(`${name}/`);
    } else {
      files.push(name);
    }
  }
  return [...dirs.sort(), ...files.sort()];
}

/** File names at the pinned commit matching a glob; slash-less globs match the basename. */
export function repoGlob(input: { pin: RepoPin; pattern: string; git?: GitRunner }): string[] {
  const git = input.git ?? defaultGitRunner;
  const result = git(input.pin.path, ["ls-tree", "-z", "-r", "--name-only", input.pin.sha]);
  if (!result.ok) {
    throw new Error(result.err.slice(0, 200) || "cannot list the tree");
  }
  const glob = new Bun.Glob(input.pattern);
  const matched: string[] = [];
  for (const path of result.out.split("\0")) {
    if (path === "") {
      continue;
    }
    if (isSecretPath(path)) continue;
    const target = input.pattern.includes("/") ? path : (path.split("/").pop() ?? path);
    if (glob.match(target)) {
      matched.push(path);
    }
  }
  return matched.sort();
}

/** One file body at the pinned commit. */
export function repoShow(input: { pin: RepoPin; path: string; git?: GitRunner }): string {
  const git = input.git ?? defaultGitRunner;
  assertRepoPath(input.path);
  const result = git(input.pin.path, ["show", `${input.pin.sha}:${input.path}`]);
  if (!result.ok) {
    throw new Error(result.err.slice(0, 200) || `cannot read ${input.path}`);
  }
  return result.out.slice(0, REPO_READ_LIMIT);
}

/** The header every repo result carries: what was read, and from which commit. */
export function pinHeader(pin: RepoPin): string {
  return `[${pin.repo}@${pin.sha.slice(0, 12)} ref ${pin.ref} committed ${pin.committed}]`;
}

/**
 * Record a repository read. The effect lands before git runs, so a rejected
 * append cancels the read; the result carries the sha, which is what makes a
 * later audit able to say which code the model actually judged.
 */
export function appendRepoRead(log: EventLog, pin: RepoPin, op: string, target: string): void {
  log.append({
    kind: "effect",
    name: "repo/read",
    payload: { repo: pin.repo, sha: pin.sha, ref: pin.ref, op, target },
  });
}

export function appendRepoResult(
  log: EventLog,
  pin: RepoPin,
  op: string,
  size: number,
  paths: string[] = [],
): void {
  // paths are capped: enough for an evidence audit, not a dump of the tree.
  const seen = paths.slice(0, 20);
  log.append({
    kind: "observe",
    name: "repo/result",
    payload: {
      repo: pin.repo,
      sha: pin.sha,
      op,
      size,
      committed: pin.committed,
      ...(seen.length > 0 ? { paths: seen } : {}),
    },
  });
}
