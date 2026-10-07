import { canonicalWorkspaceRoot, trustedGitMetadata } from "./sandbox-docker.ts";
import { createPolicy, spawnFenced } from "./sandbox.ts";

export const GIT_OUTPUT_LIMIT = 100_000;

/**
 * One read-only policy per workspace for the life of the process. Creating
 * a policy is not free — on macOS it runs the Seatbelt startup probe, two
 * sandbox-exec spawns — and git_status, git_diff, and git_log were paying it
 * on every call. The world does not change between calls; the policy is
 * sealed and immutable, so it can be reused.
 */
const READ_ONLY_POLICIES = new Map<string, ReturnType<typeof createPolicy>>();

function readOnlyPolicyFor(canonicalRoot: string): ReturnType<typeof createPolicy> {
  const cached = READ_ONLY_POLICIES.get(canonicalRoot);
  if (cached) return cached;
  const policy = createPolicy({ mode: "read-only", workspaceRoot: canonicalRoot });
  READ_ONLY_POLICIES.set(canonicalRoot, policy);
  return policy;
}

export interface GitResult {
  ok: boolean;
  text: string;
}

export type GitTrackedState =
  | { readonly status: "tracked" | "untracked" }
  | { readonly status: "unavailable"; readonly reason: string };

/** Run a read-only Git view inside the same filesystem fence as model bash.
 * Repository metadata is input, not host authority: alternates, fsmonitor,
 * textconv, and diff helpers must never make this host-side tool read or
 * execute outside the canonical workspace boundary. */
function run(root: string, args: string[], suppliedPolicy?: ReturnType<typeof createPolicy>): GitResult {
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalWorkspaceRoot(root);
  } catch {
    return { ok: false, text: "git workspace is unavailable" };
  }
  const metadata = trustedGitMetadata(canonicalRoot);
  if (!metadata) {
    return { ok: false, text: "git metadata is not trusted for this workspace" };
  }
  const executionRoot = suppliedPolicy?.backend === "docker" ? "/testbed" : canonicalRoot;
  const safeArgs = [
    `--git-dir=${metadata.gitDir}`,
    `--work-tree=${executionRoot}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=",
    "-c", "pager.status=false",
    "-c", "pager.diff=false",
    "-c", "pager.log=false",
    ...args,
  ];
  let result: ReturnType<typeof spawnFenced>;
  try {
    const policy = suppliedPolicy ?? readOnlyPolicyFor(canonicalRoot);
    const command = [
      "env",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_SYSTEM=/dev/null",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_PAGER=cat",
      "PAGER=cat",
      "/usr/bin/git",
      ...safeArgs,
    ].map(shellWord).join(" ");
    result = spawnFenced(policy, command);
  } catch {
    return { ok: false, text: "git view sandbox is unavailable" };
  }
  if (result.exitCode !== 0) {
    const stderr = (result.stderr?.toString() ?? "git failed").trim();
    return { ok: false, text: stderr.slice(0, 500) };
  }
  const text = (result.stdout?.toString() ?? "").slice(0, GIT_OUTPUT_LIMIT);
  return { ok: true, text };
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Porcelain status: short, stable, machine- and model-readable. */
export function gitStatus(input: { root: string; policy?: ReturnType<typeof createPolicy> }): GitResult {
  return run(input.root, ["status", "--porcelain"], input.policy);
}

/** Working-tree diff, or the staged diff when asked. */
export function gitDiff(input: { root: string; staged?: boolean; path?: string; policy?: ReturnType<typeof createPolicy> }): GitResult {
  const args = ["diff", "--no-ext-diff", "--no-textconv", ...(input.staged ? ["--staged"] : [])];
  if (input.path) {
    args.push("--", input.path);
  }
  return run(input.root, args, input.policy);
}

/** Oneline log, newest first, capped by limit. */
export function gitLog(input: { root: string; limit?: number; path?: string }): GitResult {
  const args = ["log", "--oneline", `-${input.limit ?? 10}`];
  if (input.path) {
    args.push("--", input.path);
  }
  return run(input.root, args);
}

/** Exact tracked-path probe under the same hermetic read-only Git view. */
export function gitTracked(input: { root: string; path: string }): boolean {
  return gitTrackedState(input).status === "tracked";
}

export function gitTrackedState(input: { root: string; path: string }): GitTrackedState {
  if (!input.path || input.path.includes("\0")) {
    return { status: "unavailable", reason: "git path is invalid" };
  }
  const result = run(input.root, ["ls-files", "--", input.path]);
  if (!result.ok) return { status: "unavailable", reason: result.text };
  return { status: result.text.trim() ? "tracked" : "untracked" };
}
