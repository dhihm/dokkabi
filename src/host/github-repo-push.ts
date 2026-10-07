import { withHostBuiltIndex } from "./host-index.ts";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { sealedGitConfigFile, spawnSealedHostGit } from "./git-authority.ts";
import {
  assertSandboxExecutableIdentity,
  requireAndSealSandboxExecutable,
} from "./sandbox-executable.ts";

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,199})$/u;
const MAX_COMMITS = 256;

export interface GithubRepoPushCommandResult {
  readonly status: number;
  readonly stdout: string;
}

export type GithubRepoPushGit = (
  workspaceRoot: string,
  args: readonly string[],
) => GithubRepoPushCommandResult;

/**
 * The work tree's changes against HEAD, as `diff --name-status -z` records
 * (`A` a path HEAD does not hold, anything else a tracked change). The default
 * (hostWorktreeChanges) stages the HOST's own listing of the tree into an
 * index of its own (I2, D57g) — never the repository's index.
 */
export type GithubRepoPushWorktree = (workspaceRoot: string) => GithubRepoPushCommandResult;

export const hostWorktreeChanges: GithubRepoPushWorktree = (workspaceRoot) => {
  try {
    return withHostBuiltIndex(workspaceRoot, (env) => {
      const result = spawnSealedHostGit(workspaceRoot, ["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"], { extraEnv: env });
      return { status: result.exitCode ?? 1, stdout: result.stdout.toString() };
    }, { writeObjects: false });
  } catch {
    return { status: -1, stdout: "" };
  }
};

export interface GithubRepoPushRemoteResult {
  readonly status: number;
  readonly private?: boolean;
  readonly defaultBranch?: string;
  readonly head?: string;
  readonly branchMissing?: boolean;
}

export type GithubRepoPushRemote = (
  repository: string,
  branch?: string,
) => Promise<GithubRepoPushRemoteResult>;

export interface GithubRepoPushCandidate {
  readonly repository: string;
  readonly branch: string;
  readonly remoteHead: string;
  readonly localHead: string;
  readonly commitCount: number;
  readonly rangeDigest: string;
  readonly untrackedCount: number;
  readonly requestDigest: string;
  readonly visibility?: "private" | "public";
  readonly newBranch?: boolean;
  readonly fullAuthority?: boolean;
}

export type GithubRepoPushInspector = (
  workspaceRoot: string,
  options?: { readonly fullAuthority?: boolean },
) => Promise<GithubRepoPushCandidate>;

export interface GithubRepoPushRunnerInput {
  readonly workspaceRoot: string;
  readonly candidate: GithubRepoPushCandidate;
}

export interface GithubRepoPushRunnerResult {
  readonly status: number;
  readonly remoteHead?: string;
}

export type GithubRepoPushRunner = (
  input: GithubRepoPushRunnerInput,
) => Promise<GithubRepoPushRunnerResult>;

export type GithubRepoPushInspectionCode =
  | "remote_head_missing"
  | "local_not_descendant";

export class GithubRepoPushInspectionError extends Error {
  readonly visibility?: "private" | "public";
  readonly code: GithubRepoPushInspectionCode;
  readonly repository: string;
  readonly branch: string;
  readonly remoteHead: string;
  readonly localHead: string;

  constructor(input: {
    readonly visibility?: "private" | "public";
    readonly code: GithubRepoPushInspectionCode;
    readonly repository: string;
    readonly branch: string;
    readonly remoteHead: string;
    readonly localHead: string;
  }) {
    super(`GitHub push inspection refused: ${input.code}.`);
    this.name = "GithubRepoPushInspectionError";
    this.visibility = input.visibility;
    this.code = input.code;
    this.repository = input.repository;
    this.branch = input.branch;
    this.remoteHead = input.remoteHead;
    this.localHead = input.localHead;
  }
}

export interface GithubRepoFetchRunnerInput {
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly branch: string;
  readonly remoteHead: string;
}

export interface GithubRepoFetchRunnerResult {
  readonly status: number;
  readonly remoteHead?: string;
}

export type GithubRepoFetchRunner = (
  input: GithubRepoFetchRunnerInput,
) => Promise<GithubRepoFetchRunnerResult>;

export async function inspectGithubRepoPush(input: {
  readonly workspaceRoot: string;
  readonly git?: GithubRepoPushGit;
  readonly worktree?: GithubRepoPushWorktree;
  readonly remote?: GithubRepoPushRemote;
  readonly fullAuthority?: boolean;
}): Promise<GithubRepoPushCandidate> {
  const workspaceRoot = realpathSync(resolve(input.workspaceRoot));
  const git = input.git ?? defaultGithubRepoPushGit;
  const remote = input.remote ?? ((repository, branch) => inspectGithubRemote(workspaceRoot, repository, branch));
  const run = (args: readonly string[], description: string): string => {
    const result = git(workspaceRoot, args);
    if (result.status !== 0) throw new Error(`GitHub push inspection failed: ${description}.`);
    return result.stdout;
  };

  const topLevel = run(["rev-parse", "--show-toplevel"], "workspace is not a Git worktree").trim();
  if (!topLevel || realpathSync(resolve(topLevel)) !== workspaceRoot) {
    throw new Error("GitHub push inspection refused: Git top level does not match the current workspace.");
  }

  const localConfig = git(workspaceRoot, ["config", "--local", "--name-only", "--list"]);
  if (localConfig.status !== 0) {
    throw new Error("GitHub push inspection failed: repository-local Git configuration is unavailable.");
  }
  if (localConfig.stdout.split("\n").some(dangerousNetworkConfig)) {
    throw new Error("GitHub push inspection refused: repository-local unsafe Git configuration is present.");
  }

  const origin = run(["remote", "get-url", "--push", "origin"], "origin push URL is unavailable").trim();
  const repository = parseGithubRepository(origin);
  if (!repository) {
    throw new Error("GitHub push inspection refused: origin is not one canonical github.com repository.");
  }

  const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"], "HEAD is detached").trim();
  if (!safeBranch(branch)) {
    throw new Error("GitHub push inspection refused: current branch name is outside the fixed policy.");
  }
  const localHead = run(["rev-parse", "--verify", "HEAD^{commit}"], "local HEAD is not a commit").trim().toLowerCase();
  if (!SHA.test(localHead)) {
    throw new Error("GitHub push inspection refused: local HEAD is not a GitHub commit SHA.");
  }

  // I2 (D57g): the work tree as the HOST lists it, staged into an index of
  // its own, against HEAD — never the repository's index. A path HEAD does
  // not hold is untracked; anything else that differs is a tracked change.
  const changes = (input.worktree ?? hostWorktreeChanges)(workspaceRoot);
  if (changes.status !== 0) throw new Error("GitHub push inspection failed: worktree status is unavailable.");
  const status = changes.stdout;
  let untrackedCount = 0;
  const fields = status.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const code = fields[at]!;
    if (code === "") continue;
    if (code === "A") untrackedCount += 1;
    else if (!input.fullAuthority) throw new Error("GitHub push inspection refused: tracked worktree changes must be committed first.");
  }

  const remoteState = await remote(repository, input.fullAuthority ? branch : undefined);
  if (remoteState.status !== 0) {
    throw new Error("GitHub push inspection failed: host GitHub authentication or repository access is unavailable.");
  }
  if (!input.fullAuthority && remoteState.private !== true) {
    throw new Error("GitHub push inspection refused: repository is not private.");
  }
  if (!input.fullAuthority && remoteState.defaultBranch !== branch) {
    throw new Error("GitHub push inspection refused: current branch is not the repository default branch.");
  }
  const newBranch = input.fullAuthority === true && remoteState.branchMissing === true;
  const remoteHead = newBranch ? "0".repeat(40) : remoteState.head?.toLowerCase();
  if (!remoteHead || !SHA.test(remoteHead)) {
    throw new Error("GitHub push inspection refused: remote default-branch head is unavailable.");
  }

  if (!newBranch && git(workspaceRoot, ["cat-file", "-e", `${remoteHead}^{commit}`]).status !== 0) {
    throw new GithubRepoPushInspectionError({
      visibility: remoteState.private ? "private" : "public",
      code: "remote_head_missing",
      repository,
      branch,
      remoteHead,
      localHead,
    });
  }
  if (!newBranch && git(workspaceRoot, ["merge-base", "--is-ancestor", remoteHead, localHead]).status !== 0) {
    throw new GithubRepoPushInspectionError({
      visibility: remoteState.private ? "private" : "public",
      code: "local_not_descendant",
      repository,
      branch,
      remoteHead,
      localHead,
    });
  }
  const commitsResult = git(workspaceRoot, [
    "rev-list",
    "--reverse",
    ...(input.fullAuthority ? [] : [`--max-count=${MAX_COMMITS + 1}`]),
    newBranch ? localHead : `${remoteHead}..${localHead}`,
  ]);
  if (commitsResult.status !== 0) {
    throw new Error("GitHub push inspection failed: commit range cannot be enumerated.");
  }
  const commits = commitsResult.stdout.split("\n").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (commits.some((value) => !SHA.test(value))) {
    throw new Error("GitHub push inspection refused: commit range contains an invalid object identifier.");
  }
  if (!input.fullAuthority && commits.length > MAX_COMMITS) {
    throw new Error(`GitHub push inspection refused: commit range exceeds ${MAX_COMMITS} commits.`);
  }
  if (remoteHead !== localHead && commits.at(-1) !== localHead) {
    throw new Error("GitHub push inspection refused: commit range does not terminate at local HEAD.");
  }
  const rangeDigest = createHash("sha256")
    .update(commits.join("\n"))
    .digest("hex");
  const requestDigest = createHash("sha256")
    .update(JSON.stringify({
      repository: repository.toLowerCase(),
      branch,
      remoteHead,
      localHead,
      commitCount: commits.length,
      rangeDigest,
      untrackedCount,
      ...(input.fullAuthority ? { fullAuthority: true, newBranch, visibility: remoteState.private ? "private" : "public" } : {}),
    }))
    .digest("hex");
  return Object.freeze({
    repository,
    branch,
    remoteHead,
    localHead,
    commitCount: commits.length,
    rangeDigest,
    untrackedCount,
    requestDigest,
    ...(input.fullAuthority ? { fullAuthority: true, newBranch, visibility: remoteState.private ? "private" as const : "public" as const } : {}),
  });
}

export const defaultGithubRepoPushInspector: GithubRepoPushInspector = (workspaceRoot, options) =>
  inspectGithubRepoPush({ workspaceRoot, fullAuthority: options?.fullAuthority });

export const defaultGithubRepoFetchRunner: GithubRepoFetchRunner = async (input) => {
  if (!REPOSITORY.test(input.repository) || !safeBranch(input.branch) || !SHA.test(input.remoteHead)) {
    return { status: -1 };
  }
  const localConfig = defaultGithubRepoPushGit(input.workspaceRoot, ["config", "--local", "--name-only", "--list"]);
  if (localConfig.status !== 0 || localConfig.stdout.split("\n").some(dangerousNetworkConfig)) {
    return { status: -1 };
  }
  const authentication = githubAuthorization(input.workspaceRoot);
  if (!authentication.authorization) return { status: authentication.status };
  const target = `https://github.com/${input.repository}.git`;
  const result = spawnSealedHostGit(input.workspaceRoot, [
    "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false",
    "-c", "fetch.writeCommitGraph=false",
    "-c", "fetch.prune=false",
    "-c", "fetch.pruneTags=false",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    target,
    `refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
  ], { httpsAuthHeader: authentication.authorization });
  if (result.exitCode !== 0) return { status: result.exitCode };
  const verified = defaultGithubRepoPushGit(input.workspaceRoot, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${input.branch}^{commit}`,
  ]);
  const remoteHead = verified.stdout.trim().toLowerCase();
  return verified.status === 0 && remoteHead === input.remoteHead
    ? { status: 0, remoteHead }
    : { status: -1 };
};

export const defaultGithubRepoPushRunner: GithubRepoPushRunner = async ({ workspaceRoot, candidate }) => {
  if (!validCandidate(candidate)) return { status: -1 };
  const authentication = githubAuthorization(workspaceRoot);
  if (!authentication.authorization) return { status: authentication.status };
  const target = `https://github.com/${candidate.repository}.git`;
  const result = spawnSealedHostGit(workspaceRoot, [
    "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false",
    "-c", "push.gpgSign=false",
    "-c", "push.pushOption=",
    "push",
    "--porcelain",
    "--no-verify",
    "--no-follow-tags",
    ...(candidate.newBranch ? [`--force-with-lease=refs/heads/${candidate.branch}:`] : []),
    target,
    `${candidate.localHead}:refs/heads/${candidate.branch}`,
  ], { httpsAuthHeader: authentication.authorization });
  if (result.exitCode !== 0) return { status: result.exitCode };
  const verified = await inspectGithubRemote(workspaceRoot, candidate.repository, candidate.fullAuthority ? candidate.branch : undefined);
  return verified.status === 0 && verified.head === candidate.localHead
    ? { status: 0, remoteHead: verified.head }
    : { status: -1 };
};

export function githubAuthorization(workspaceRoot: string): { status: number; authorization?: string } {
  const tokenResult = spawnSealedHostGh(workspaceRoot, ["auth", "token", "--hostname", "github.com"]);
  const token = tokenResult.stdout.trim();
  if (tokenResult.status !== 0 || !/^[A-Za-z0-9_]{8,4096}$/u.test(token)) {
    return { status: tokenResult.status === 0 ? -1 : tokenResult.status };
  }
  return {
    status: 0,
    authorization: `Authorization: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
  };
}

/** The sealed boundary for the push's git (S2, D57e). A sealed git never
 * reads the repository's configuration, so the two questions about that
 * configuration are answered from its config FILE, read as data (no include
 * followed): the names it sets, and origin's push URL (`pushurl`, else
 * `url`; the url.* rewrites git would apply are refused as unsafe
 * configuration before any push, so none can apply). */
function defaultGithubRepoPushGit(workspaceRoot: string, args: readonly string[]): GithubRepoPushCommandResult {
  const joined = args.join(" ");
  if (joined === "config --local --name-only --list") {
    const listed = sealedGitConfigFile(workspaceRoot, ["--name-only", "--list"]);
    return { status: listed.exitCode, stdout: listed.stdout.toString() };
  }
  if (joined === "remote get-url --push origin") {
    for (const key of ["remote.origin.pushurl", "remote.origin.url"]) {
      const found = sealedGitConfigFile(workspaceRoot, ["--get", key]);
      if (found.exitCode === 0) return { status: 0, stdout: found.stdout.toString() };
      if (found.exitCode !== 1) return { status: found.exitCode, stdout: "" };
    }
    return { status: 2, stdout: "" };
  }
  const result = spawnSealedHostGit(workspaceRoot, args);
  return { status: result.exitCode, stdout: result.stdout.toString() };
}

async function inspectGithubRemote(
  workspaceRoot: string,
  repository: string,
  branch?: string,
): Promise<GithubRepoPushRemoteResult> {
  if (!REPOSITORY.test(repository)) return { status: -1 };
  const repositoryResult = spawnSealedHostGh(workspaceRoot, ["api", `repos/${repository}`]);
  if (repositoryResult.status !== 0) return { status: repositoryResult.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(repositoryResult.stdout);
  } catch {
    return { status: -1 };
  }
  if (!parsed || typeof parsed !== "object") return { status: -1 };
  const record = parsed as Record<string, unknown>;
  const defaultBranch = typeof record.default_branch === "string" ? record.default_branch : undefined;
  if (!defaultBranch || !safeBranch(defaultBranch)) return { status: -1 };
  const targetBranch = branch ?? defaultBranch;
  if (!safeBranch(targetBranch)) return { status: -1 };
  const refResult = spawnSealedHostGh(
    workspaceRoot,
    ["api", `repos/${repository}/git/ref/heads/${encodeURIComponent(targetBranch)}`],
  );
  if (refResult.status !== 0) {
    let missing = false;
    try { const error = JSON.parse(refResult.stdout); missing = String(error.status) === "404" && error.message === "Not Found"; } catch {}
    return branch && missing ? { status: 0, private: record.private === true, defaultBranch, branchMissing: true } : { status: refResult.status };
  }
  let ref: unknown;
  try {
    ref = JSON.parse(refResult.stdout);
  } catch {
    return { status: -1 };
  }
  const object = ref && typeof ref === "object"
    ? (ref as Record<string, unknown>).object
    : undefined;
  const head = object && typeof object === "object"
    ? (object as Record<string, unknown>).sha
    : undefined;
  return {
    status: 0,
    private: record.private === true,
    defaultBranch,
    ...(typeof head === "string" && SHA.test(head.toLowerCase()) ? { head: head.toLowerCase() } : {}),
  };
}

export function spawnSealedHostGh(workspaceRoot: string, args: readonly string[]): GithubRepoPushCommandResult {
  const canonicalRoot = realpathSync(resolve(workspaceRoot));
  const executable = requireAndSealSandboxExecutable("gh", [canonicalRoot]);
  assertSandboxExecutableIdentity(executable);
  const operatorHome = safeOperatorPath(process.env.HOME, canonicalRoot) ?? "/dev/null";
  const xdgConfig = safeOperatorPath(process.env.XDG_CONFIG_HOME, canonicalRoot);
  const ghConfig = safeOperatorPath(process.env.GH_CONFIG_DIR, canonicalRoot);
  // gh never starts in the tree (S2): nothing it might ask git there can
  // read the repository's configuration.
  const result = Bun.spawnSync([executable.path, ...args], {
    cwd: "/",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: operatorHome,
      ...(xdgConfig ? { XDG_CONFIG_HOME: xdgConfig } : {}),
      ...(ghConfig ? { GH_CONFIG_DIR: ghConfig } : {}),
      GH_PROMPT_DISABLED: "1",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { status: result.exitCode, stdout: result.stdout.toString() };
}

function safeOperatorPath(value: string | undefined, workspaceRoot: string): string | undefined {
  if (!value || !isAbsolute(value) || value.includes("\0") || value.includes("\n")) return undefined;
  const normalized = resolve(value);
  const rel = relative(workspaceRoot, normalized);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? undefined : normalized;
}

function parseGithubRepository(value: string): string | undefined {
  let repository: string | undefined;
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port
        || url.username || url.password || url.search || url.hash) return undefined;
      repository = url.pathname.replace(/^\//u, "").replace(/\.git$/iu, "");
    } catch {
      return undefined;
    }
  } else {
    const scp = /^git@github\.com:([^\s]+)$/iu.exec(value);
    const ssh = /^ssh:\/\/git@github\.com\/([^\s]+)$/iu.exec(value);
    repository = (scp?.[1] ?? ssh?.[1])?.replace(/\.git$/iu, "");
  }
  if (!repository || !REPOSITORY.test(repository)) return undefined;
  const name = repository.slice(repository.indexOf("/") + 1);
  return name === "." || name === ".." ? undefined : repository;
}

function safeBranch(value: string): boolean {
  return BRANCH.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !value.endsWith("/")
    && !value.endsWith(".lock");
}

function dangerousNetworkConfig(value: string): boolean {
  const key = value.trim().toLowerCase();
  return /^url\..*\.(?:insteadof|pushinsteadof)$/u.test(key)
    || key.startsWith("http.")
    || key.startsWith("credential.")
    || key.startsWith("include.")
    || key.startsWith("includeif.")
    || /^remote\..*\.(?:receivepack|uploadpack|proxy)$/u.test(key);
}

function validCandidate(candidate: GithubRepoPushCandidate): boolean {
  return REPOSITORY.test(candidate.repository)
    && safeBranch(candidate.branch)
    && SHA.test(candidate.remoteHead)
    && SHA.test(candidate.localHead)
    && Number.isSafeInteger(candidate.commitCount)
    && candidate.commitCount > 0
    && (candidate.fullAuthority === true || candidate.commitCount <= MAX_COMMITS)
    && DIGEST.test(candidate.rangeDigest)
    && Number.isSafeInteger(candidate.untrackedCount)
    && candidate.untrackedCount >= 0
    && DIGEST.test(candidate.requestDigest);
}
