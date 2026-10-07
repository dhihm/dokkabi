import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  readConfig,
  updateGithubCreateOwners,
  updateGithubPublishRepositories,
  updateGithubPushRepositories,
} from "../../src/host/config.ts";
import {
  createGithubAdminService,
  type GithubAdminService,
} from "../../src/host/github-admin.ts";
import type { PermissionController } from "../../src/host/permissions.ts";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const GithubAdminParameters = Type.Union([
  Type.Object({
    op: Type.Literal("repo_create"),
    owner: Type.String({
      description: "GitHub account or organization; a first valid request can open explicit owner authorization in live ask mode",
    }),
    repo: Type.String({
      description: "Repository name; creation is always private",
    }),
    description: Type.Optional(Type.String({
      description: "Optional non-secret repository description; never logged",
    })),
  }, { additionalProperties: false }),
  Type.Object({
    op: Type.Literal("repo_publish"),
    owner: Type.String({ description: "Exact GitHub repository owner" }),
    repo: Type.String({ description: "Exact existing private repository name" }),
    source_path: Type.String({
      description: "Relative workspace subdirectory whose UTF-8 text files become repository-root paths",
    }),
    message: Type.Optional(Type.String({
      description: "Optional non-secret commit message; defaults to the source directory",
    })),
  }, { additionalProperties: false }),
  Type.Object({
    op: Type.Literal("repo_push"),
  }, { additionalProperties: false }),
]);

function createGithubAdminTool(service: GithubAdminService): AgentTool<typeof GithubAdminParameters> {
  return {
    name: "github_admin",
    label: "GitHub administration",
    description:
      "Create an always-private GitHub repository, publish one bounded workspace subdirectory additively, or push existing commits from the current branch to its exact GitHub origin. Use only after the operator requests the external mutation. repo_push derives its target and accepts no ref or credential input. Full authority (bypass) permits public/private origins, any checked-out branch and new remote branches without enrollment or popup; other modes retain private default-branch enrollment, clean tracked tree, 256-commit limit and approvals. Push never includes uncommitted files or rewrites existing remote history. A stale remote triggers one exact tracking-ref fetch; remote_advanced_local_sync_required means integrate locally and retry. Remote SHA verification is required. Bypass push is session authority and does not persist policy. Creation and snapshot publication retain their separate policies.",
    parameters: GithubAdminParameters,
    async execute(_toolCallId, params, signal) {
      const outcome = params.op === "repo_create"
        ? await service.create({
            owner: params.owner,
            repo: params.repo,
            ...(params.description === undefined ? {} : { description: params.description }),
          }, signal)
        : params.op === "repo_publish"
          ? await service.publish({
            owner: params.owner,
            repo: params.repo,
            sourcePath: params.source_path,
            ...(params.message === undefined ? {} : { message: params.message }),
          }, signal)
          : await service.push(signal);
      return textToolResult(outcome.text, outcome.error);
    },
  };
}

export const plugin: PluginModule = {
  id: "github-admin",
  claims: [
    { key: "github_admin", role: "definition" },
    { key: "github_admin", role: "provider" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "permissions", role: "consumer", optional: true },
    { key: "skills", role: "consumer", modelFacing: true },
  ],
  activate() {
    if (process.env.DOKKABI_EXTERNAL_KNOWLEDGE === "deny") {
      return { active: false, reason: "external knowledge is disabled", kind: "not_configured" };
    }
    const swarmChild = process.env.DOKKABI_PARENT_SESSION !== undefined
      || process.env.DOKKABI_SWARM_ROLE !== undefined;
    return swarmChild
      ? { active: false, reason: "operator-approved GitHub administration is unavailable to private swarm children", kind: "unavailable" }
      : { active: true };
  },
  register(ctx: HostContext) {
    const permissions = ctx.tryGet<PermissionController>("permissions");
    const service = createGithubAdminService({
      log: ctx.log,
      workspaceRoot: ctx.workspaceRoot,
      allowedOwners: readConfig().github?.create_owners ?? [],
      allowedPublishRepositories: readConfig().github?.publish_repositories ?? [],
      allowedPushRepositories: readConfig().github?.push_repositories ?? [],
      saveAllowedOwners: updateGithubCreateOwners,
      saveAllowedPublishRepositories: updateGithubPublishRepositories,
      saveAllowedPushRepositories: updateGithubPushRepositories,
      ...(permissions ? { permissions } : {}),
    });
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.define("github_admin", { authority: "permission_mode", visibility: "target_derived" });
    ctx.provide("github_admin", service);
    ctx.effect(() => tools.register("github-admin", createGithubAdminTool(service)));
    ctx.effect(() => () => service.dispose());
  },
};
