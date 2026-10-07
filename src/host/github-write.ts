import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sealedGitConfigFile } from "./git-authority.ts";
import type { EventLog } from "./event-log.ts";
import { containsSecret } from "./redact.ts";
import { hasRedundantGithubSelfLink } from "./github-comment-style.ts";

export type GithubWriteOp = "issue_comment" | "issue_close" | "issue_reopen" | "pull_review" | "issue_comment_edit" | "pull_review_edit";
export type GithubReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface GithubMutationRequest {
  readonly argv: readonly string[];
  readonly stdin: string;
}

export interface GithubMutationResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GithubMutationRunner = (
  request: GithubMutationRequest,
) => Promise<GithubMutationResult>;

export interface GithubWriteOutcome {
  readonly text: string;
  readonly error: boolean;
  readonly result?: GithubPublicationResult;
}

export interface GithubPublicationResult {
  readonly id?: number;
  readonly html_url?: string;
  readonly state?: string;
  readonly commit_id?: string;
}

export interface GithubWriteInput {
  readonly log: EventLog;
  readonly op: GithubWriteOp;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly body?: string;
  readonly publication_id?: number;
  readonly event?: GithubReviewEvent;
  readonly commit_id?: string;
  readonly resolvePullState?: (target: string, number: number) => Promise<{ head: string; base: string } | undefined>;
  readonly resolvePullHead?: (target: string, number: number) => Promise<string | undefined>;
  readonly allowedRepositories: readonly string[];
  readonly workspaceRoot?: string;
  readonly resolveWorkspaceRepository?: () => string | undefined;
  readonly runner?: GithubMutationRunner;
  /** Plugin-owned evidence check, evaluated against the live verified head. */
  readonly reviewCheck?: (target: string, number: number, head: string, base?: string) => string | undefined;
  /** Plugin-owned minimum investigation check, distinct from approval readiness. */
  readonly publicationCheck?: (target: string, number: number, head?: string, base?: string) => string | undefined;
}

const MAX_COMMENT_BYTES = 10_000;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function parseGithubRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+)$/u.exec(trimmed);
  if (scp) return validTarget(scp[1] ?? "", stripGitSuffix(scp[2] ?? ""));

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "ssh:")
    || url.hostname.toLowerCase() !== "github.com"
    || url.username !== (url.protocol === "ssh:" ? "git" : "")
    || url.password
    || url.search
    || url.hash
  ) {
    return undefined;
  }
  const parts = url.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.length !== 2) return undefined;
  return validTarget(parts[0] ?? "", stripGitSuffix(parts[1] ?? ""));
}

export async function githubWrite(input: GithubWriteInput): Promise<GithubWriteOutcome> {
  const target = validTarget(input.owner, input.repo);
  if (!target || !Number.isSafeInteger(input.number) || input.number < 1) {
    return refused("invalid target or issue number");
  }
  const workspaceTarget = input.resolveWorkspaceRepository
    ? input.resolveWorkspaceRepository()
    : resolveWorkspaceGithubRepository(input.workspaceRoot ?? "");
  const allowed = new Set(input.allowedRepositories.map(normalizedTarget).filter(Boolean));
  if (
    normalizedTarget(workspaceTarget) !== normalizedTarget(target)
    || !allowed.has(normalizedTarget(target))
  ) {
    return refused("target is not authorized for this workspace");
  }

  const editing = input.op === "issue_comment_edit" || input.op === "pull_review_edit";
  const originalOp = input.op === "issue_comment_edit" ? "issue_comment" : "pull_review";
  const original = editing ? input.log.events.find(e => e.name === "github/write_result"
    && e.payload.op === originalOp && e.payload.repo === target
    && e.payload.number === input.number && e.payload.status === "completed"
    && publicationResult(e.payload.result)?.id === input.publication_id) : undefined;
  const originalPublication = original ? publicationResult(original.payload.result) : undefined;
  if (editing && (!Number.isSafeInteger(input.publication_id) || !originalPublication)) {
    return refused("editing requires a same-session verified publication for this target");
  }
  if (input.op === "pull_review_edit" && (!originalPublication?.state || !originalPublication.commit_id)) {
    return refused("review edit requires the verified original state and commit");
  }
  if (!editing && input.publication_id !== undefined) return refused("publication_id requires an edit operation");

  let stdin: string;
  let bodyDigest: string | undefined;
  let bodyBytes: number | undefined;
  let reviewedBase: string | undefined;
  if (input.op !== "pull_review" && (input.event !== undefined || input.commit_id !== undefined)) {
    return refused("review fields require pull_review; issue_comment does not submit approval");
  }
  if (input.op === "issue_comment" || input.op === "pull_review" || editing) {
    if (input.op === "pull_review" && (!input.event || !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(input.event) || !input.commit_id || !/^[0-9a-f]{40}$/.test(input.commit_id))) {
      return refused("pull_review requires an explicit review event and the full reviewed commit_id");
    }
    const bodylessApproval = input.op === "pull_review" && input.event === "APPROVE" && input.body === undefined;
    if (!bodylessApproval && (typeof input.body !== "string" || input.body.trim().length === 0)) {
      return refused(`${input.op} requires a body`);
    }
    const body = input.body ?? "";
    bodyBytes = Buffer.byteLength(body);
    if (bodyBytes > MAX_COMMENT_BYTES) return refused("comment body is too large");
    if (containsSecret(body)) return refused("comment body contains secret-shaped material");
    if (hasRedundantGithubSelfLink(body, input.owner, input.repo, input.number)) {
      return refused("Remove the redundant link to this comment's own PR/issue; keep related links and source/discussion anchors, then retry");
    }
    bodyDigest = createHash("sha256").update(body).digest("hex");
    stdin = JSON.stringify({ body });
    if (input.op === "pull_review") {
      input.log.append({ kind: "effect", name: "github/read", payload: { op: "pull_head", repo: target, number: input.number } });
      let head: string | undefined, base: string | undefined;
      try {
        if (input.reviewCheck && (!input.resolvePullHead || input.resolvePullState)) {
          const state = await (input.resolvePullState ?? defaultPullState)(target, input.number); head = state?.head; base = state?.base;
        } else head = await (input.resolvePullHead ?? defaultPullHead)(target, input.number);
      } catch { /* Refuse unverifiable heads. */ }
      const valid = typeof head === "string" && /^[0-9a-f]{40}$/.test(head);
      reviewedBase = base;
      input.log.append({ kind: "observe", name: "github/result", payload: { op: "pull_head", repo: target, number: input.number, status: valid ? 200 : "error", ...(valid ? { sha: head, ...(base ? { base } : {}) } : {}) } });
      if (!valid || head !== input.commit_id) return refused("PR head changed or could not be verified; re-read and review the current head before submitting");
      if (input.event === "APPROVE" && input.reviewCheck) {
        const gap = input.reviewCheck(target, input.number, head!, base);
        if (gap) return refused(`review_assessment incomplete: ${gap}`);
      }
      stdin = JSON.stringify({ ...(bodylessApproval ? {} : { body }), event: input.event, commit_id: input.commit_id });
    }
  } else {
    if (input.body !== undefined) return refused(`${input.op} does not accept a body`);
    stdin = JSON.stringify({ state: input.op === "issue_close" ? "closed" : "open" });
  }

  if ((input.op === "issue_comment" || input.op === "pull_review") && input.publicationCheck) {
    const gap = input.publicationCheck(target, input.number, input.op === "pull_review" ? input.commit_id : undefined, reviewedBase);
    if (gap) return refused(`review investigation incomplete: ${gap}`);
  }

  const prior = bodyDigest && input.log.events.find(
    (event) =>
      event.name === "github/write_result"
      && event.payload.op === input.op
      && event.payload.repo === target
      && event.payload.number === input.number
      && event.payload.body_digest === bodyDigest
      && (!editing || event.payload.publication_id === input.publication_id)
      && (input.op !== "pull_review" || (event.payload.event === input.event && event.payload.commit_id === input.commit_id))
      && event.payload.status === "completed",
  );
  if (prior) {
    const result = publicationResult(prior.payload.result);
    return withPublication(`GitHub ${input.op} already completed.`, result);
  }

  input.log.append({
    kind: "effect",
    name: "github/write",
    payload: {
      op: input.op,
      repo: target,
      number: input.number,
      ...(editing ? { publication_id: input.publication_id } : {}),
      ...(input.op === "pull_review" ? { event: input.event, commit_id: input.commit_id } : {}),
      ...(bodyDigest ? { body_digest: bodyDigest, body_bytes: bodyBytes } : {}),
    },
  });

  const request = mutationRequest(input.op, target, input.number, stdin, input.publication_id);
  const runner = input.runner ?? defaultMutationRunner;
  let status = -1;
  let reviewState: string | undefined;
  let publication: GithubPublicationResult | undefined;
  try {
    const result = await runner(request);
    status = result.status;
    if (status === 0 && input.op !== "pull_review") {
      try { publication = publicationResult(JSON.parse(result.stdout)); } catch { /* Legacy runners may omit response bodies. */ }
    }
    if (status === 0 && editing) {
      const edited = JSON.parse(result.stdout);
      publication = publicationResult(edited);
      if (publication?.id !== input.publication_id || edited.body !== input.body
        || (input.op === "pull_review_edit" && (publication?.state !== originalPublication?.state || publication?.commit_id !== originalPublication?.commit_id))) status = -1;
    }
    if (status === 0 && input.op === "pull_review") {
      const review = JSON.parse(result.stdout);
      const expected = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[input.event!];
      if (review.state !== expected || review.commit_id !== input.commit_id) status = -1;
      else { reviewState = expected; publication = publicationResult(review); }
    }
  } catch {
    status = -1;
  }
  const completed = status === 0;
  input.log.append({
    kind: "observe",
    name: "github/write_result",
    payload: {
      op: input.op,
      repo: target,
      number: input.number,
      ...(editing ? { publication_id: input.publication_id } : {}),
      ...(input.op === "pull_review" ? { event: input.event, commit_id: input.commit_id, ...(reviewState ? { review_state: reviewState } : {}) } : {}),
      status: completed ? "completed" : "failed",
      ...(completed && publication ? { result: publication } : {}),
      ...(bodyDigest ? { body_digest: bodyDigest } : {}),
      ...(!completed && status >= 0 ? { exit_code: status } : {}),
    },
  });
  if (!completed) return { text: input.op === "pull_review" ? "GitHub PR review submission or returned state could not be verified; do not report approval completed." : `GitHub ${input.op} failed. Inspect gh authentication and repository permission locally.`, error: true };
  return withPublication(editing ? `GitHub ${input.op} verified for publication ${input.publication_id}.` : input.op === "pull_review" ? `GitHub PR review verified: ${reviewState} on ${input.commit_id}.` : input.op === "issue_comment"
      ? "GitHub issue comment completed."
      : input.op === "issue_close"
        ? "GitHub issue close completed."
        : "GitHub issue reopen completed.", publication);
}

function publicationResult(value: unknown): GithubPublicationResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const result = {
    ...(typeof v.id === "number" && Number.isSafeInteger(v.id) && v.id > 0 ? { id: v.id } : {}),
    ...(typeof v.html_url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.\/-]+#[A-Za-z0-9-]+$/.test(v.html_url) ? { html_url: v.html_url } : {}),
    ...(typeof v.state === "string" && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "open", "closed"].includes(v.state) ? { state: v.state } : {}),
    ...(typeof v.commit_id === "string" && /^[0-9a-f]{40}$/.test(v.commit_id) ? { commit_id: v.commit_id } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function withPublication(text: string, result?: GithubPublicationResult): GithubWriteOutcome {
  return { text: result ? `${text}\n${JSON.stringify(result)}` : text, error: false, ...(result ? { result } : {}) };
}

function mutationRequest(
  op: GithubWriteOp,
  target: string,
  number: number,
  stdin: string,
  publicationId?: number,
): GithubMutationRequest {
  const suffix = op === "issue_comment" ? "/comments" : "";
  return {
    argv: [
      "gh",
      "api",
      "--method",
      op === "pull_review_edit" ? "PUT" : op === "issue_comment" || op === "pull_review" ? "POST" : "PATCH",
      op === "issue_comment_edit" ? `repos/${target}/issues/comments/${publicationId}` : op === "pull_review_edit" ? `repos/${target}/pulls/${number}/reviews/${publicationId}` : op === "pull_review" ? `repos/${target}/pulls/${number}/reviews` : `repos/${target}/issues/${number}${suffix}`,
      "--input",
      "-",

    ],
    stdin,
  };
}

export function githubPullStateArgv(target: string, number: number): string[] {
  return ["gh", "api", `repos/${target}/pulls/${number}`, "--jq", "[.head.sha, .base.sha] | @tsv"];
}

async function defaultPullState(target: string, number: number): Promise<{ head: string; base: string } | undefined> {
  const result = spawnSync("gh", githubPullStateArgv(target, number).slice(1), { cwd: "/", encoding: "utf8", env: process.env, maxBuffer: 1_000_000 });
  const [head, base] = result.stdout?.trim().split("\t") ?? [];
  return result.status === 0 && head && base && /^[0-9a-f]{40}$/.test(head) && /^[0-9a-f]{40}$/.test(base) ? { head, base } : undefined;
}

async function defaultPullHead(target: string, number: number): Promise<string | undefined> {
  const result = spawnSync("gh", ["api", `repos/${target}/pulls/${number}`, "--jq", ".head.sha"], { cwd: "/", encoding: "utf8", env: process.env, maxBuffer: 1_000_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const defaultMutationRunner: GithubMutationRunner = async (request) => {
  // gh starts outside every workspace (S2, D57e): nothing it asks git about
  // a current repository can read a tree's configuration.
  const result = spawnSync(request.argv[0]!, [...request.argv.slice(1)], {
    cwd: "/",
    encoding: "utf8",
    env: process.env,
    input: request.stdin,
    maxBuffer: 1_000_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/** The workspace's origin as its own config FILE states it, read as data
 * (S2, D57e): no git process reads the tree's configuration — which the
 * session writes, includes and url rewrites included — on the host's behalf. */
function resolveWorkspaceGithubRepository(workspaceRoot: string): string | undefined {
  if (!workspaceRoot) return undefined;
  try {
    const result = sealedGitConfigFile(workspaceRoot, ["--get", "remote.origin.url"]);
    if (result.exitCode !== 0) return undefined;
    return parseGithubRemote(result.stdout.toString());
  } catch {
    return undefined;
  }
}

function validTarget(owner: string, repo: string): string | undefined {
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  if (!OWNER_PATTERN.test(cleanOwner) || !REPOSITORY_PATTERN.test(cleanRepo) || cleanRepo === "." || cleanRepo === "..") {
    return undefined;
  }
  return `${cleanOwner}/${cleanRepo}`;
}

function normalizedTarget(target: string | undefined): string {
  if (!target) return "";
  const separator = target.indexOf("/");
  if (separator < 1 || separator === target.length - 1) return "";
  return (validTarget(target.slice(0, separator), target.slice(separator + 1)) ?? "").toLowerCase();
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function refused(reason: string): GithubWriteOutcome {
  return { text: `GitHub write refused: ${reason}.`, error: true };
}
