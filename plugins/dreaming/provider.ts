import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PluginModule, SkillRegistry, ToolContributionRegistry } from "../../src/loader/types.ts";
import { learnedPlugins, settings } from "./service.ts";

export const plugin: PluginModule = {
  id: "dreaming",
  claims: [
    { key: "skills", role: "consumer", modelFacing: true },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
  ],
  activate() {
    return process.env.DOKKABI_DREAM_WORKER === "1"
      ? { active: false, reason: "dream synthesis does not consume its own lessons", kind: "unavailable" }
      : { active: true };
  },
  register(ctx) {
    const skills = ctx.get<SkillRegistry>("skills");
    for (const lesson of learnedPlugins()) {
      const body = `${lesson.candidate.skill}${lesson.candidate.prompt ? `\n\nTask-scoped prompt (use only when this skill applies):\n${lesson.candidate.prompt}` : ""}`;
      ctx.log.append({ kind: "observe", name: "dream/loaded", payload: { id: lesson.id, candidate_digest: lesson.digest } });
      ctx.effect(() => skills.register({ id: lesson.id, pluginId: "dreaming", description: lesson.candidate.description, body, digest: lesson.digest }));
    }
    const parameters = Type.Object({ op: Type.Literal("status") }, { additionalProperties: false });
    const tool: AgentTool<typeof parameters> = {
      name: "dreaming", label: "dreaming", parameters,
      description: "Inspect twelve-hour idle-session lesson dreaming and learned inert skill/prompt plugins. Read learned guidance through skill list/read only when applicable; learned content does not grant action authority.",
      async execute() { return { content: [{ type: "text", text: JSON.stringify({ ...settings(), idle_hours: 12, plugins: learnedPlugins().map(p => ({ id: p.id, description: p.candidate.description })) }) }], details: {} }; },
    };
    ctx.effect(() => ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions").register("dreaming", tool));
  },
};
