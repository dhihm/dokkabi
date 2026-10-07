import { basename, dirname } from "node:path";
import type { PluginModule } from "../loader/types.ts";
import { registerResearchGuard, validateResearchPolicy } from "../eval/experiment/preflight.ts";
import { researchHash, researchRead } from "../eval/experiment/environment.ts";

export const plugin: PluginModule = {
  id: "research-runtime",
  claims: [{ key: "research", role: "definition" }, { key: "research", role: "provider" }],
  // The registration refusals, checked by every boot before register and by
  // its prepare phase (#230 round 3, D1'). Reading the policy has no side effect.
  preflight(ctx) {
    if (ctx.log.isReadOnly) {
      if (!ctx.log.events.find(row => row.name === "research/bind")) throw new Error("research observer has no recorded binding");
      return;
    }
    const path = process.env.DOKKABI_RESEARCH_POLICY;
    const expected = process.env.DOKKABI_RESEARCH_POLICY_SHA256;
    if (!path || !expected) throw new Error("research requires a byte-bound request policy");
    const bytes = researchRead(dirname(path), basename(path));
    if (researchHash(bytes) !== expected) throw new Error("research policy file changed");
    validateResearchPolicy(JSON.parse(bytes.toString("utf8")));
  },
  register(ctx) {
    ctx.define("research", { visibility: "host_only", truth: "event_log", schema: 1 });
    if (ctx.log.isReadOnly) {
      const binding = ctx.log.events.find(row => row.name === "research/bind");
      if (!binding) throw new Error("research observer has no recorded binding");
      ctx.provide("research", Object.freeze({ digest: binding.payload.digest, readOnly: true }));
      return;
    }
    const path = process.env.DOKKABI_RESEARCH_POLICY;
    const expected = process.env.DOKKABI_RESEARCH_POLICY_SHA256;
    if (!path || !expected) throw new Error("research requires a byte-bound request policy");
    const bytes = researchRead(dirname(path), basename(path));
    if (researchHash(bytes) !== expected) throw new Error("research policy file changed");
    const dispose = registerResearchGuard(ctx.log, JSON.parse(bytes.toString("utf8")));
    ctx.effect(() => dispose);
    ctx.provide("research", Object.freeze({ digest: expected, readOnly: false }));
  },
};
