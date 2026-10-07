import type { HostContext, PluginModule } from "../loader/types.ts";
import { createPrerequisiteRegistry } from "../prerequisite/registry.ts";

export const plugin: PluginModule = {
  id: "prerequisite-runtime",
  claims: [
    { key: "prerequisites", role: "definition" },
    { key: "prerequisites", role: "provider" },
  ],
  register(ctx: HostContext) {
    ctx.define("prerequisites", { visibility: "host_only", truth: "event_log" });
    ctx.provide("prerequisites", createPrerequisiteRegistry(ctx.log));
  },
};
