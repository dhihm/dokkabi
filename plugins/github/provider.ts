import { createIssueAuditTool, issueCompletion } from "./issue-audit.ts";
import { workspaceScopeContribution } from "./workspace-scope.ts";
import { followupContribution } from "./followup-context.ts";
import type { RequestContextContributionRegistry } from "../../src/loader/types.ts";
import { createGithubDiscussionTool } from "./discussion.ts";
import { createGithubCiTool } from "./ci.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createReviewPreflightTool } from "./review-preflight.ts";
import { githubRead } from "../../src/host/github.ts";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";

const GithubParameters = Type.Object({
  op: Type.Union([
    Type.Literal("pulls"),
    Type.Literal("pull"),
    Type.Literal("release"),
    Type.Literal("issue"),
    Type.Literal("blob"),
    Type.Literal("tree"),
    Type.Literal("search"),
    Type.Literal("search_code"),
    Type.Literal("search_issues"),
  ]),
  owner: Type.Optional(Type.String()),
  repo: Type.Optional(Type.String()),
  number: Type.Optional(Type.Number()),
  ref: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  q: Type.Optional(Type.String()),
  filename: Type.Optional(Type.String({ description: "Only op=tree: find literal basename paths in the full repository Git tree at ref, independent of the code-search index. Use this to resolve legacy/missing source paths before another blob request." })),
  refresh: Type.Optional(Type.Boolean({ description: "Bypass recent same-path404 reuse only when evidence says repository contents changed. Changing a literal/window is not that evidence." })),
  find_text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Only op=blob: locate this exact literal in the full remote source (independent of GitHub code-search indexing) and return bounded context with match_char. start_char sets the search lower bound; next_match_start_char finds another occurrence. Prefer this to guessed offsets or reading unrelated chunks." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500, description: "Only op=pulls supports offset. Search results are bounded; narrow search qualifiers when incomplete." })),
  start_char: Type.Optional(Type.Integer({ minimum: 0, description: "Only op=blob: Unicode character offset for a source-file continuation. Omit for issue, pull, and search operations." })),
  max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000, description: "Only op=blob: source-file window size. Omit for search_issues/search_code/issue/pull; search has a fixed result cap and must be narrowed with q qualifiers." })),
}, { additionalProperties: false });

function createGithubTool(ctx: HostContext): AgentTool<typeof GithubParameters> {
  return {
    name: "github",
    label: "github",
    description: "Authenticated read-only GitHub access. pulls pages open PRs (10 per page; follow next_offset until null) with authenticated viewer/team review requests, current heads, prior reviews, CI summaries and completeness; pull reads a PR thread/files by number. release reads official release metadata and notes (omit ref for latest published release; ref selects an exact tag). Use release rather than issue/code search or PR listing to verify a release, and read source at the returned tag. Also supports global issue/PR search, code search, trees, issue threads and file bodies. Issue search/details include authoritative created/updated dates; issue comments include dates/authors. Dates are metadata, not proof of substantive progress. For a known file, use blob find_text to locate a symbol/literal anywhere in the full source instead of guessing offsets or relying on code search. blob returns a bounded source window (default 20000 Unicode characters): follow next_start_char with the same exact ref/path to recover omitted source; max_chars controls window size. owner/repo are optional only for searches. Use this tool for authenticated PR metadata rather than gh in bash.",
    parameters: GithubParameters,
    async execute(_toolCallId, params) {
      const outcome = await githubRead({
        log: ctx.log,
        workspaceRoot: ctx.workspaceRoot,
        op: params.op,
        ...(params.owner !== undefined ? { owner: params.owner } : {}),
        ...(params.repo !== undefined ? { repo: params.repo } : {}),
        ...(params.number !== undefined ? { number: params.number } : {}),
        ...(params.ref !== undefined ? { ref: params.ref } : {}),
        ...(params.path !== undefined ? { path: params.path } : {}),
        ...(params.q !== undefined ? { q: params.q } : {}),
        ...(params.offset !== undefined ? { offset: params.offset } : {}),
        ...(params.start_char !== undefined ? { start_char: params.start_char } : {}),
        ...(params.max_chars !== undefined ? { max_chars: params.max_chars } : {}),
        ...(params.find_text !== undefined ? { find_text: params.find_text } : {}),
        ...(params.filename !== undefined ? { filename: params.filename } : {}),
        ...(params.refresh !== undefined ? { refresh: params.refresh } : {}),
      });
      // The host records the full source and projects bounded model input.
      // A producer head/tail clamp would discard PRs before that source exists.
      return { content: [{ type: "text" as const, text: outcome.text }], details: { error: outcome.error } };
    },
  };
}

export const plugin: PluginModule = {
  id: "github",
  claims: [
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "skills", role: "consumer", modelFacing: true },
    { key: "request_context_contributions", role: "consumer", optional: true },
  ],
  activate() {
    return process.env.DOKKABI_EXTERNAL_KNOWLEDGE === "deny"
      ? { active: false, reason: "external knowledge is disabled", kind: "not_configured" }
      : { active: true };
  },
  register(ctx: HostContext) {
    const context = ctx.tryGet<RequestContextContributionRegistry>("request_context_contributions");
    if (context) {
      ctx.effect(() => context.register("github.scope", workspaceScopeContribution(ctx.workspaceRoot, ctx.log)));
      ctx.effect(() => context.register("github", followupContribution(ctx.log)));
      ctx.effect(() => context.register("github.issue-completion", issueCompletion(ctx.log, ctx.workspaceRoot)));
    }
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.effect(() => tools.register("github", createGithubTool(ctx)));
    ctx.effect(() => tools.register("github", createIssueAuditTool(ctx)));
    ctx.effect(() => tools.register("github", createGithubCiTool(ctx)));
    ctx.effect(() => tools.register("github", createGithubDiscussionTool(ctx)));
    ctx.effect(() => tools.register("github", createReviewPreflightTool(ctx)));
  },
};
