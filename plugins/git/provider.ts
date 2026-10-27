import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { GithubAdminService } from "../../src/host/github-admin.ts";
import type { HostContext, PluginModule, ToolContributionRegistry } from "../../src/loader/types.ts";
import { swarmChildLineageEnvPresent } from "../../src/swarm/lineage-env.ts";
import { createWorkspaceTools, disposeWorkspaceTools } from "../../src/plugins/workspace-tools.ts";
import { fetchGithubRevision } from "./fetch.ts";
import { createGitTool } from "./tool.ts";

export const plugin: PluginModule = {
  id: "git",
  claims: [
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "skills", role: "consumer", modelFacing: true },
    { key: "github_admin", role: "consumer", optional: true },
  ],
  register(ctx: HostContext) {
    // Private swarm children keep read-only legacy git_* tools from
    // workspace-tools; unified git would fail tool_contribution_not_exposed
    // if registered but filtered off the child surface.
    if (swarmChildLineageEnvPresent()) return;
    const local = createWorkspaceTools(ctx.workspaceRoot, { log: ctx.log, gitMetadataWrite: true });
    const bash = local.find(tool => tool.name === "bash");
    if (!bash) { disposeWorkspaceTools(local); throw new Error("Git requires fenced workspace execution"); }
    const service = ctx.tryGet<GithubAdminService>("github_admin");
    const tool = createGitTool(bash, service ? signal => service.push(signal) : undefined, revision => fetchGithubRevision(ctx.workspaceRoot, revision, ctx.log));
    ctx.effect(() => ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions").register("git", tool));
    ctx.effect(() => () => disposeWorkspaceTools(local));
  },
};
