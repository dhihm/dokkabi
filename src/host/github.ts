import type { EventLog } from "./event-log.ts";
import { containsSecret, redactText } from "./redact.ts";
import { spawnSealedHostGh } from "./github-repo-push.ts";

/** Non-source projections retain their existing bound; source windows are recoverable. */
export const GITHUB_BODY_LIMIT = 100_000;

/** Code search returns paths, not bodies: a long list helps nobody. */
export const GITHUB_SEARCH_LIMIT = 20;

export type GithubOp = "pulls" | "pull" | "release" | "issue" | "blob" | "tree" | "search" | "search_code" | "search_issues";
type GithubResolvedOp = "pulls" | "pull" | "release" | "issue" | "blob" | "tree" | "search_code" | "search_issues";

export function githubIssueArgv(input: { owner: string; repo: string; number: number }): string[] {
  return [
    "gh", "issue", "view", String(input.number),
    "--repo", `${input.owner}/${input.repo}`,
    "--json", "title,body,comments,url,state,createdAt,updatedAt,assignees",
  ];
}

export function githubBlobArgv(input: { owner: string; repo: string; ref: string; path: string }): string[] {
  return [
    "gh", "api", `repos/${input.owner}/${input.repo}/contents/${input.path}?ref=${input.ref}`,
    "-H", "Accept: application/vnd.github.raw",
  ];
}

export function githubTreeArgv(input: { owner: string; repo: string; ref: string; path?: string; filename?: string }): string[] {
  if (input.filename) return ["gh", "api", `repos/${input.owner}/${input.repo}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`];
  const target = input.path ? `/${input.path}` : "";
  return ["gh", "api", `repos/${input.owner}/${input.repo}/contents${target}?ref=${input.ref}`];
}

/** Code search over the repository's default branch — how a path is found without guessing. */
export function githubSearchArgv(input: { q: string; owner?: string; repo?: string }): string[] {
  const scope = input.owner && input.repo ? ` repo:${input.owner}/${input.repo}` : "";
  return ["gh", "api", `search/code?q=${encodeURIComponent(`${input.q}${scope}`)}`];
}

/** Issue and pull-request search can be global; repository scope is optional. */
export function githubIssueSearchArgv(input: { q: string; owner?: string; repo?: string }): string[] {
  const scope = input.owner && input.repo ? ` repo:${input.owner}/${input.repo}` : "";
  return ["gh", "api", `search/issues?q=${encodeURIComponent(`${input.q}${scope}`)}`];
}

/** Ask the API which branch the repository actually defaults to. */
export function githubDefaultRefArgv(input: { owner: string; repo: string }): string[] {
  return ["gh", "api", `repos/${input.owner}/${input.repo}`, "--jq", ".default_branch"];
}

export interface GithubReadOutcome {
  text: string;
  error: boolean;
}

export type GithubRunner = (argv: string[]) => Promise<{ status: number; body: string }>;

const defaultRunner = (workspaceRoot: string): GithubRunner => async (argv) => {
  // gh starts outside every workspace (S2, D57e): nothing it asks git about
  // a current repository can read a tree's configuration.
  if (argv[0] !== "gh") throw new Error("unexpected GitHub executable");
  const result = spawnSealedHostGh(workspaceRoot, argv.slice(1));
  if (result.status !== 0) {
    throw new Error(`gh failed with status ${result.status}`);
  }
  return { status: 200, body: result.stdout };
};

function argvFor(
  input: { op: GithubResolvedOp; owner?: string; repo?: string; number?: number; path?: string; q?: string; filename?: string },
  ref: string,
): string[] {
  switch (input.op) {
    case "pulls":
      return ["gh", "pr", "list", "--repo", `${input.owner}/${input.repo}`, "--state", "open", "--limit", "501", "--json", PR_FIELDS];
    case "pull":
      return ["gh", "pr", "view", String(input.number), "--repo", `${input.owner}/${input.repo}`, "--json", `${PR_FIELDS},body,comments,files`];
    case "release":
      return ["gh", "api", `repos/${input.owner}/${input.repo}/releases/${ref ? `tags/${encodeURIComponent(ref)}` : "latest"}`];
    case "issue":
      if (typeof input.number !== "number") {
        throw new Error("github issue needs number");
      }
      return githubIssueArgv({ owner: input.owner!, repo: input.repo!, number: input.number });
    case "blob":
      if (!input.path) {
        throw new Error("github blob needs path");
      }
      return githubBlobArgv({ owner: input.owner!, repo: input.repo!, ref, path: input.path });
    case "tree":
      return githubTreeArgv({ owner: input.owner!, repo: input.repo!, ref, ...(input.path ? { path: input.path } : {}), ...(input.filename ? { filename: input.filename } : {}) });
    case "search_code":
      if (!input.q) {
        throw new Error("github search needs q");
      }
      return githubSearchArgv({ q: input.q, owner: input.owner, repo: input.repo });
    case "search_issues":
      if (!input.q) {
        throw new Error("github search needs q");
      }
      return githubIssueSearchArgv({ q: input.q, owner: input.owner, repo: input.repo });
  }
}

const PR_FIELDS = "number,title,url,state,createdAt,closedAt,mergedAt,author,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,updatedAt,reviewRequests,reviewDecision,reviews,statusCheckRollup,mergeable,mergeStateStatus,assignees";
type PrData = Record<string, any>;

/** Metadata, not approval: only a review on the current head reviews that head. */
export function classifyPull(pr: PrData, login: string, teams: ReadonlySet<string>) {
  const reviews = (pr.reviews ?? []).filter((r: PrData) => r.author?.login?.toLowerCase() === login.toLowerCase())
    .sort((a: PrData, b: PrData) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  const latest = reviews.at(-1);
  const requests: PrData[] = pr.reviewRequests ?? [];
  const checks: Record<string, number> = {};
  for (const check of pr.statusCheckRollup ?? []) {
    const status = check.status === "COMPLETED" ? check.conclusion : check.status ?? check.state ?? "UNKNOWN";
    const key = String(status ?? "UNKNOWN").toLowerCase();
    checks[key] = (checks[key] ?? 0) + 1;
  }
  return {
    direct_request: requests.some(r => r.__typename === "User" && r.login?.toLowerCase() === login.toLowerCase()),
    team_request: requests.some(r => r.__typename === "Team" && teams.has(String(r.slug).toLowerCase().split("/").at(-1)!)),
    authored_by_viewer: pr.author?.login?.toLowerCase() === login.toLowerCase(),
    latest_viewer_review: latest ? { state: latest.state, commit: latest.commit?.oid ?? null, submittedAt: latest.submittedAt } : null,
    new_head_since_review: latest?.commit?.oid ? latest.commit.oid !== pr.headRefOid : null,
    checks,
    check_count: (pr.statusCheckRollup ?? []).length,
    review_count: (pr.reviews ?? []).length,
  };
}

async function prMetadata(input: { op: "pulls" | "pull"; owner: string; repo: string; number?: number; offset?: number }, runner: GithubRunner) {
  const identity = await runner(["gh", "api", "user"]);
  if (identity.status >= 400) throw new Error("authenticated GitHub identity unavailable");
  const login = JSON.parse(identity.body).login;
  if (typeof login !== "string" || !login) throw new Error("authenticated GitHub identity has no login");
  let teamMembershipKnown = true;
  let teams: PrData[] = [];
  try {
    const result = await runner(["gh", "api", "user/teams", "--paginate", "--slurp"]);
    if (result.status >= 400) throw new Error("team membership unavailable");
    const pages = JSON.parse(result.body);
    if (!Array.isArray(pages)) throw new Error("invalid team membership response");
    teams = pages.flat();
  } catch { teamMembershipKnown = false; }
  const slugs = new Set<string>(teams.filter(t => t.organization?.login?.toLowerCase() === input.owner.toLowerCase()).map(t => String(t.slug).toLowerCase()));
  const result = await runner(argvFor(input, ""));
  if (result.status >= 400) throw new Error("GitHub PR metadata unavailable");
  const parsed = JSON.parse(result.body);
  if (input.op === "pulls" && !Array.isArray(parsed)) throw new Error("invalid PR listing");
  const raw: PrData[] = input.op === "pulls" ? parsed : [parsed];
  const offset = input.op === "pulls" ? input.offset ?? 0 : 0;
  const page = input.op === "pulls" ? raw.slice(offset, offset + 10) : raw;
  const pulls: PrData[] = page.map(pr => {
    const { reviews: _reviews, statusCheckRollup: _checks, ...fields } = pr;
    return { ...fields, triage: classifyPull(pr, login, slugs) };
  });
  const report = { viewer: login, team_membership_known: teamMembershipKnown, teams: [...slugs],
    observed_at: new Date().toISOString(),
    listing_complete: input.op !== "pulls" || raw.length < 501,
    complete: input.op !== "pulls" || (raw.length < 501 && offset === 0 && pulls.length === raw.length),
    offset, next_offset: offset + pulls.length < raw.length ? offset + pulls.length : null,
    total_available: raw.length, returned: pulls.length,
    listing_limit: input.op === "pulls" ? 501 : 1, pulls };
  // Never cut JSON mid-record or claim a capped listing is complete.
  if (JSON.stringify(report).length > GITHUB_BODY_LIMIT) {
    report.complete = false;
    if (input.op === "pull") {
      for (const pr of report.pulls) {
        pr.body = String(pr.body ?? "").slice(0, 20_000);
        pr.comments = []; pr.files = [];
      }
    }
    while (report.pulls.length && JSON.stringify(report).length > GITHUB_BODY_LIMIT) report.pulls.pop();
    report.returned = report.pulls.length;
    report.next_offset = input.op === "pulls" && offset + report.returned < raw.length ? offset + report.returned : null;
  }
  return JSON.stringify(report);
}

function formatBody(op: GithubResolvedOp, body: string): string {
  if (op === "pulls" || op === "pull" || op === "release") return body;
  if (op === "blob") {
    return body;
  }
  if (op === "tree") {
    const entries = JSON.parse(body) as Array<{ type?: string; path?: string }>;
    return entries.map((entry) => `${entry.type === "dir" ? "dir" : "file"}  ${entry.path ?? ""}`).join("\n");
  }
  if (op === "search_code") {
    const parsed = JSON.parse(body) as { total_count?: number; incomplete_results?: boolean; items?: Array<{ path?: string }> };
    const items = (parsed.items ?? []).slice(0, GITHUB_SEARCH_LIMIT);
    return [
      `matches: ${parsed.total_count ?? items.length}`,
      `returned: ${items.length}; complete: ${parsed.incomplete_results !== true && (parsed.total_count ?? items.length) <= items.length}`,
      ...items.map((item) => item.path ?? ""),
    ].join("\n");
  }
  if (op === "search_issues") {
    const parsed = JSON.parse(body) as {
      total_count?: number; incomplete_results?: boolean;
      items?: Array<{
        number?: number;
        title?: string;
        html_url?: string;
        repository_url?: string;
        pull_request?: unknown;
        created_at?: string; updated_at?: string; state?: string; comments?: number;
      }>;
    };
    const items = (parsed.items ?? []).slice(0, GITHUB_SEARCH_LIMIT);
    return [
      `matches: ${parsed.total_count ?? items.length}`,
      `returned: ${items.length}; complete: ${parsed.incomplete_results !== true && (parsed.total_count ?? items.length) <= items.length}`,
      ...items.map((item) => {
        const repo = issueSearchRepository(item) ?? "unknown/unknown";
        const kind = item.pull_request === undefined ? "issue" : "PR";
        return `${repo}#${item.number ?? "?"}  ${kind}  ${item.title ?? ""}  ${item.html_url ?? ""}\n  created_at: ${item.created_at ?? "unknown"}; updated_at: ${item.updated_at ?? "unknown"}; state: ${item.state ?? "unknown"}; comments: ${item.comments ?? "unknown"}`.trimEnd();
      }),
    ].join("\n");
  }
  const parsed = JSON.parse(body) as { title?: string; state?: string; body?: string; url?: string; createdAt?: string; updatedAt?: string; assignees?: Array<{login?: string}>; comments?: Array<{ body?: string; author?: {login?: string}; createdAt?: string; updatedAt?: string; url?: string }> };
  const comments = (parsed.comments ?? []).map((comment, index) => `--- comment ${index + 1} ---\nauthor: ${comment.author?.login ?? "unknown"}\ncreated_at: ${comment.createdAt ?? "unknown"}\nupdated_at: ${comment.updatedAt ?? "unknown"}\nurl: ${comment.url ?? "unknown"}\n${comment.body ?? ""}`).join("\n\n");
  return [
    `title: ${parsed.title ?? ""}`,
    `state: ${parsed.state ?? ""}`,
    `url: ${parsed.url ?? ""}`,
    `created_at: ${parsed.createdAt ?? "unknown"}`,
    `updated_at: ${parsed.updatedAt ?? "unknown"}`,
    `assignees: ${(parsed.assignees ?? []).map(a=>a.login ?? "unknown").join(", ") || "none"}`,
    "",
    parsed.body ?? "",
    comments ? `\ncomments:\n${comments}` : "",
  ].join("\n");
}

function issueSearchRepository(item: { repository_url?: string; html_url?: string }): string | undefined {
  const api = item.repository_url?.match(/\/repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/);
  if (api?.[1]) return api[1];
  const page = item.html_url?.match(/\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+(?:[/?#]|$)/);
  return page?.[1];
}

/** Legacy op=search stays source-compatible and selects the metadata API
 * only when the query contains issue/PR-only qualifiers. */
export function resolveGithubSearchOp(op: GithubOp, q = ""): GithubResolvedOp {
  if (op === "search_code" || op === "search_issues") return op;
  if (op !== "search") return op;
  return /(?:^|\s)(?:(?:type|is):(?:pr|issue)|(?:author|assignee|mentions|commenter|involves|state|label|milestone|draft|review|reviewed-by|review-requested|team-review-requested):)/i.test(q)
    ? "search_issues"
    : "search_code";
}

/**
 * Authenticated GitHub reads through gh. Separate from web_fetch on purpose:
 * anonymous HTTPS and credentialled private-repo access are different trust
 * domains, and the log must show which one happened. The effect lands before
 * gh runs — a rejected append cancels the read.
 *
 * An omitted ref resolves the repository's default branch instead of assuming
 * main: assuming it produced honest-looking 404s on repositories whose default
 * is something else. The ref that was actually read is recorded, so what the
 * model saw stays reconstructible.
 */
export async function githubRead(input: {
  log: EventLog;
  workspaceRoot?: string;
  op: GithubOp;
  owner?: string;
  repo?: string;
  number?: number;
  ref?: string;
  path?: string;
  q?: string;
  offset?: number;
  start_char?: number;
  max_chars?: number;
  find_text?: string;
  filename?: string;
  refresh?: boolean;
  runner?: GithubRunner;
}): Promise<GithubReadOutcome> {
  const target = input.owner && input.repo ? `${input.owner}/${input.repo}` : undefined;
  const resolvedOp = resolveGithubSearchOp(input.op, input.q);
  const isSearch = resolvedOp === "search_code" || resolvedOp === "search_issues";
  if ((input.owner && !/^[A-Za-z0-9_.-]+$/.test(input.owner)) || (input.repo && !/^[A-Za-z0-9_.-]+$/.test(input.repo))) {
    return { text: "github owner and repo must be repository names", error: true };
  }
  if (Boolean(input.owner) !== Boolean(input.repo)) {
    return { text: "github owner and repo must be provided together", error: true };
  }
  if (!isSearch && !target) {
    return { text: `github ${input.op} needs owner and repo`, error: true };
  }
  if (isSearch && !input.q) {
    return { text: "github search needs q", error: true };
  }
  if ((resolvedOp === "issue" || resolvedOp === "pull") && (!Number.isSafeInteger(input.number) || input.number! <= 0)) {
    return { text: `github ${resolvedOp} needs a positive integer number`, error: true };
  }
  if (input.offset !== undefined && resolvedOp !== "pulls") {
    return { text: `github op=${resolvedOp} does not support offset. Remove offset; changing its value will still fail. Search has no offset pagination: complete=true means the query is finished; when incomplete, narrow q with date/type/label qualifiers. Only op=pulls supports offset.`, error: true };
  }
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= 501)) {
    return { text: "github pulls offset must be an integer from 0 to 500", error: true };
  }
  if ((input.start_char !== undefined || input.max_chars !== undefined) &&
      (resolvedOp !== "blob" || (input.start_char !== undefined && (!Number.isSafeInteger(input.start_char) || input.start_char < 0)) ||
       (input.max_chars !== undefined && (!Number.isSafeInteger(input.max_chars) || input.max_chars < 1 || input.max_chars > GITHUB_BODY_LIMIT)))) {
    return { text: "github source windows need blob, nonnegative start_char and max_chars from 1 to 100000", error: true };
  }
  if (input.find_text !== undefined && (resolvedOp !== "blob" || typeof input.find_text !== "string" || !input.find_text.length || input.find_text.length > 1000)) {
    return { text: "github find_text needs op=blob and a nonempty literal of at most 1000 characters", error: true };
  }
  if (input.filename !== undefined && (resolvedOp !== "tree" || !/^[A-Za-z0-9_.-]+$/.test(input.filename))) {
    return {text:"github filename needs op=tree and a literal basename, without directory separators",error:true};
  }
  const user = input.log.events.filter(e => e.name === "user/message").at(-1)?.seq ?? 0;
  const missing = input.refresh !== true && resolvedOp === "blob" && input.path && input.ref
    ? input.log.events.filter(e => e.seq > user && e.name === "github/result" && e.payload.op === "blob" && e.payload.repo === target && e.payload.path === input.path && e.payload.ref === input.ref && (e.payload.status === 404 || /HTTP 404/.test(String(e.payload.error ?? ""))) && Date.now() - Date.parse(e.ts) < 300_000).at(-1) : undefined;
  if (missing) {
    input.log.append({kind:"observe",name:"github/read_reuse",payload:{source_seq:missing.seq,repo:target,ref:input.ref,path:input.path,reason:"same_recent_missing_path"}});
    return {error:true,text:`No network retry: this path/ref returned 404 at source event ${missing.seq}. A different literal/window cannot repair its path. Locate current paths with github op=tree filename=${input.path!.split("/").at(-1)} owner=${input.owner} repo=${input.repo} ref=${input.ref}. Use refresh=true only with evidence the repository changed.`};
  }
  input.log.append({
    kind: "effect",
    name: "github/read",
    payload: {
      op: input.op,
      ...(target ? { repo: target, scope: target } : { scope: "global" }),
      ...(isSearch ? { search_kind: resolvedOp === "search_issues" ? "issues" : "code" } : {}),
      ...(input.number !== undefined ? { number: input.number } : {}),
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.q !== undefined ? { q: input.q } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.start_char !== undefined ? { start_char: input.start_char } : {}),
      ...(input.max_chars !== undefined ? { max_chars: input.max_chars } : {}),
      ...(input.find_text !== undefined ? { find_text: input.find_text } : {}),
      ...(input.filename !== undefined ? { filename: input.filename } : {}),
      ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
    },
  });
  const runner = input.runner ?? defaultRunner(input.workspaceRoot ?? process.cwd());
  let ref = input.ref ?? "";
  try {
    if (!ref && (input.op === "blob" || input.op === "tree")) {
      const resolved = await runner(githubDefaultRefArgv({ owner: input.owner!, repo: input.repo! }));
      ref = resolved.body.trim();
      if (!ref) {
        throw new Error("could not resolve the default branch");
      }
    }
    const { status, body } = resolvedOp === "pulls" || resolvedOp === "pull"
      ? { status: 200, body: await prMetadata({ op: resolvedOp, owner: input.owner!, repo: input.repo!, number: input.number, offset: input.offset }, runner) }
      : await runner(argvFor({ ...input, op: resolvedOp }, ref));
    const text = resolvedOp === "issue"
      ? redactText(formatBody(resolvedOp, body)).slice(0, GITHUB_BODY_LIMIT)
      : containsSecret(body)
        ? `[redacted github body ${body.length} bytes]`
      : resolvedOp === "blob"
        ? githubSourceWindow(body, input.start_char ?? 0, input.max_chars ?? 20_000, input.start_char !== undefined || input.max_chars !== undefined, input.find_text)
        : resolvedOp === "tree" && input.filename
          ? formatFilenameTree(body,input.filename,input.path).slice(0,GITHUB_BODY_LIMIT)
          : formatBody(resolvedOp, body).slice(0, GITHUB_BODY_LIMIT);
    const observedShas: string[] = [];
    if ((resolvedOp === "pull" || resolvedOp === "pulls") && !containsSecret(body)) {
      const report = JSON.parse(body) as { pulls: PrData[] };
      for (const pr of report.pulls) {
        for (const sha of [pr.headRefOid, pr.baseRefOid]) {
          if (typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) observedShas.push(sha);
        }
      }
    }
    input.log.append({
      kind: "observe",
      name: "github/result",
      payload: {
        op: input.op,
        ...(target ? { repo: target, scope: target } : { scope: "global" }),
        ...(isSearch ? { search_kind: resolvedOp === "search_issues" ? "issues" : "code" } : {}),
        status,
        bytes: body.length,
        ...(observedShas.length ? { shas: [...new Set(observedShas)] } : {}),
        ...(ref ? { ref } : {}),
        ...(input.path ? { path: input.path } : {}),
      },
    });
    return { text, error: status >= 400 };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const scrubbed = redactText(rawMessage);
    const message = containsSecret(scrubbed) ? "[redacted GitHub failure]" : scrubbed;
    input.log.append({
      kind: "observe",
      name: "github/result",
      payload: {
        op: input.op,
        ...(target ? { repo: target, scope: target } : { scope: "global" }),
        ...(isSearch ? { search_kind: resolvedOp === "search_issues" ? "issues" : "code" } : {}),
        status: "error",
        error: message.slice(0, 200),
        ...(ref ? { ref } : {}),
        ...(input.path ? { path: input.path } : {}),
      },
    });
    return { text: `github ${input.op} failed: ${message}${resolvedOp === "blob" && /HTTP 404/.test(message) ? `. Locate the current path with op=tree filename=${input.path?.split("/").at(-1)}; changing source windows cannot fix a missing path.` : ""}`, error: true };
  }
}

/** Unicode code-point offsets permit lossless continuation, including long lines. */
function githubSourceWindow(body: string, start: number, limit: number, explicit: boolean, findText?: string): string {
  const chars = Array.from(body);
  if (start > chars.length) throw new Error("github source start_char exceeds total_chars");
  let match: number | undefined;
  if (findText !== undefined) {
    const suffix = chars.slice(start).join("");
    const index = suffix.indexOf(findText);
    if (index < 0) return `[GitHub source literal lookup: no match in ${start === 0 ? "entire source" : `source from start_char=${start}`}; total_chars=${chars.length}. No omitted result to recover; use a different literal if appropriate.]`;
    match = start + Array.from(suffix.slice(0, index)).length;
    start = Math.max(start, match - Math.min(300, Math.floor(limit / 4)));
    explicit = true;
  }
  const end = Math.min(start + limit, chars.length);
  const shown = chars.slice(start, end).join("");
  if (!explicit && start === 0 && end === chars.length) return shown;
  return `${shown}\n\n[GitHub source window start_char=${start} end_char=${end} total_chars=${chars.length}; ${match !== undefined ? `literal match_char=${match}; next_match_start_char=${match + Array.from(findText!).length}; ` : ""}${end < chars.length ? `omitted content remains; next_start_char=${end}. Continue blob with the same repository, ref and path.` : "complete; no omitted content remains."}]`;
}

function formatFilenameTree(body: string, filename: string, prefix?: string): string {
  const data=JSON.parse(body) as {truncated?:boolean;tree?:Array<{type?:string;path?:string}>};
  const matches=(data.tree??[]).filter(e=>e.type==="blob"&&e.path?.split("/").at(-1)===filename&&(!prefix||e.path.startsWith(prefix.replace(/\/$/,"")+"/")));
  const shown=matches.slice(0,GITHUB_SEARCH_LIMIT);
  return [`filename: ${filename}`,`matches: ${matches.length}; returned: ${shown.length}; complete: ${data.truncated!==true&&shown.length===matches.length}`,...shown.map(e=>e.path)].join("\n");
}
