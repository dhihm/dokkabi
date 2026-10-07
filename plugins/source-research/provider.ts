import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginModule, RequestContextContributionRegistry, ToolContributionRegistry } from "../../src/loader/types.ts";
import { semanticSourceAudit } from "./semantic.ts";
import { sourceCompletion, verifySourceAudit, sourceReads } from "./service.ts";
const AuditParameters = Type.Object({
  latest_release_required: Type.Boolean(), repository_source_required: Type.Boolean(),
  report_path: Type.String({description: "Workspace path of the full substantive final report, not an audit summary or metadata JSON."}),
  claims: Type.Array(Type.Object({ claim: Type.String(), source_sequences: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }) }, { additionalProperties: false }), { minItems: 1 }),
  incomplete: Type.Array(Type.String({ description: "Only unresolved required-source gaps with recorded failed reads. Exclude optional repo failures and runtime test scope notes when required sources are grounded." })),
}, { additionalProperties: false });
const Parameters = Type.Union([Type.Object({ op: Type.Literal("sources") }, { additionalProperties: false }), AuditParameters]);
export const plugin: PluginModule = {
  id: "source-research",
  claims: [{ key: "tool_contributions", role: "consumer", modelFacing: true }, { key: "request_context_contributions", role: "consumer", modelFacing: true }],
  register(ctx) {
    const tool: AgentTool<typeof Parameters> = { name: "research_audit", label: "research_audit", parameters: Parameters,
      description: "First use op=sources to get exact current-turn source/probe tool/result sequences; do not invent ordinal numbers. Complete documentation/source research with a grounded self-audit of the original request. Declare whether latest release and repository source were required; cite actual successful source tool/result sequences for material claims. Missing available evidence must be read before completion; incomplete names only concrete external gaps. This records source provenance, not runtime certification.",
      async execute(_id, params) {
        let result: unknown;
        if ("op" in params) result = { error: false, available_sources: sourceReads(ctx.log, true).map(r => ({ seq: r.seq, tool: r.call.payload.name, args: r.call.payload.args })) };
        else {
          const mechanics = verifySourceAudit(ctx.log, params, false);
          if (mechanics.error) result = mechanics;
          else {
            const semantic = await semanticSourceAudit(ctx.log, ctx.workspaceRoot, params);
            result = semantic.error ? { ...semantic, next_action: "Complete these available gaps/corrections and update the report; then audit again without repeating passing probes." } : { ...verifySourceAudit(ctx.log, params), semantic };
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { error: (result as {error:boolean}).error } };
      },
    };
    ctx.effect(() => ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions").register("source-research", tool));
    ctx.effect(() => ctx.get<RequestContextContributionRegistry>("request_context_contributions").register("source-research", sourceCompletion(ctx.log)));
  },
};
