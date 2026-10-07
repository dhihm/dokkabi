import type { HostContext, PluginModule } from "../loader/types.ts";
import { createGateRegistry } from "../work/gate/registry.ts";

/**
 * The `ctx.verify` seam (#77 T5). `docs/plugins.md` has listed a local gate
 * capability since the plugin surface was written and nothing implemented it;
 * this is the empty registry that gate plugins register into.
 *
 * It ships empty on purpose. An empty registry is a FAIL — a step with no
 * registered gate is refused rather than accepted — so removing every gate
 * plugin stops the isolated step path instead of silently waving it through.
 */
export const plugin: PluginModule = {
  id: "gate-runtime",
  claims: [
    { key: "verify", role: "definition" },
    { key: "verify", role: "provider" },
  ],
  register(ctx: HostContext) {
    ctx.define("verify", { ordering: "manifest", visibility: "host_only", truth: "event_log" });
    ctx.provide("verify", createGateRegistry(ctx.log));
  },
};
