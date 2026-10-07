import type { HostContext, PluginModule } from "../loader/types.ts";
import { createWorkspaceTools, disposeWorkspaceTools } from "./workspace-tools.ts";

export const plugin: PluginModule = {
  id: "workspace-review-tools",
  claims: [
    { key: "tools", role: "definition" },
    { key: "tools", role: "provider" },
  ],
  register(ctx: HostContext) {
    const tools = createWorkspaceTools(ctx.workspaceRoot, {
      log: ctx.log,
      reviewOnly: true,
    });
    ctx.define("tools", { names: tools.map((tool) => tool.name), access: "review" });
    ctx.provide("tools", tools);
    ctx.effect(() => () => disposeWorkspaceTools(tools));
  },
};
