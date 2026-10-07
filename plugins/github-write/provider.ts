import { ReviewWorkflow, reviewCompletionContribution } from "./review-workflow.ts";
import type { RequestContextContributionRegistry } from "../../src/loader/types.ts";
import { ReviewAssessment } from "./review-assessment.ts";
import { createReviewAssessmentTool,reviewReportMatches } from "./review-assessment-tool.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readConfig } from "../../src/host/config.ts";
import { githubWrite } from "../../src/host/github-write.ts";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const GithubWriteParameters = Type.Object({
  op: Type.Union([
    Type.Literal("issue_comment"),
    Type.Literal("issue_close"),
    Type.Literal("issue_reopen"),
    Type.Literal("pull_review"),
    Type.Literal("issue_comment_edit"),
    Type.Literal("pull_review_edit"),
  ]),
  owner: Type.String(),
  repo: Type.String(),
  number: Type.Number(),
  body: Type.Optional(Type.String()),
  publication_id: Type.Optional(Type.Number()),
  event: Type.Optional(Type.Union([Type.Literal("APPROVE"), Type.Literal("REQUEST_CHANGES"), Type.Literal("COMMENT")])),
  commit_id: Type.Optional(Type.String()),
}, { additionalProperties: false });

function createGithubWriteTool(ctx: HostContext, workflow: ReviewWorkflow): AgentTool<typeof GithubWriteParameters> {
  return {
    name: "github_write",
    label: "github write",
    description:
      "Comment on, close, or reopen an issue, or submit a real PR review in the authorized current-workspace GitHub repository. pull_review requires event and reviewed commit_id; body is optional only for APPROVE and required for REQUEST_CHANGES/COMMENT; successful writes return available id/html_url/state/commit_id; an issue_comment saying APPROVE does not approve a PR. Edit a same-session verified own delivery with issue_comment_edit or pull_review_edit and publication_id plus body; review edits preserve state and reviewed commit. Omit canonical links to the current target. Use only when the operator requested the external mutation.",
    parameters: GithubWriteParameters,
    async execute(_toolCallId, params) {
      const userSeq = ctx.log.events.filter(e => e.name === "user/message").at(-1)?.seq ?? 0;
      const reviewActive = ctx.log.events.some(e => e.seq > userSeq && e.name === "tool/call"
        && e.payload.name === "skill" && (e.payload.args as any)?.op === "read"
        && ["github.pr_review", "github.pr_followup"].includes((e.payload.args as any)?.id));
      if (params.op === "pull_review" || params.op === "issue_comment" && reviewActive) {
        const refusal = workflow.publicationCheck(params.op === "pull_review" ? params.event : undefined);
        if (refusal) return {...textToolResult(`Review publication refused: ${refusal}`, true),details:{error:true}};
      }
      const outcome = await githubWrite({
        publicationCheck: params.op === "pull_review" && params.event !== "APPROVE" || params.op === "issue_comment" && reviewActive
          ? (target, number, head, base) => new ReviewAssessment(ctx.log, ctx.workspaceRoot).checkFindings(target, number, head, base) : undefined,
        reviewCheck: (target, number, head, base) => base ? new ReviewAssessment(ctx.log, ctx.workspaceRoot).check(target, number, head, base) : "Current PR base could not be verified",
        log: ctx.log,
        op: params.op,
        owner: params.owner,
        repo: params.repo,
        number: params.number,
        ...(params.publication_id !== undefined ? { publication_id: params.publication_id } : {}),
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(params.event !== undefined ? { event: params.event } : {}),
        ...(params.commit_id !== undefined ? { commit_id: params.commit_id } : {}),
        allowedRepositories: readConfig().github?.write_repositories ?? [],
        workspaceRoot: ctx.workspaceRoot,
      });
      return { ...textToolResult(outcome.text, outcome.error), details: { error: outcome.error, ...(outcome.result ? { result: outcome.result } : {}) } };
    },
  };
}

export const plugin: PluginModule = {
  id: "github-write",
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
    const workflow = new ReviewWorkflow(ctx.log, new ReviewAssessment(ctx.log, ctx.workspaceRoot),(path,digest)=>reviewReportMatches(ctx.workspaceRoot,path,digest));
    const context = ctx.tryGet<RequestContextContributionRegistry>("request_context_contributions");
    if (context) ctx.effect(()=>context.register("github-write.completion",reviewCompletionContribution(workflow)));
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.effect(() => tools.register("github-write", createGithubWriteTool(ctx, workflow)));
    ctx.effect(() => tools.register("github-write", createReviewAssessmentTool(ctx, workflow)));
  },
};
