import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readConfig } from "../../src/host/config.ts";
import {
  createManagedPluginService,
  type ManagedPluginService,
} from "../../src/host/managed-plugin.ts";
import type { PermissionController } from "../../src/host/permissions.ts";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const SourceFields = {
  repository: Type.String({ description: "Public GitHub owner/repository, never a URL" }),
  ref: Type.Optional(Type.String({ description: "Branch, tag, or commit; omitted means the default branch" })),
  path: Type.Optional(Type.String({ description: "Relative SKILL.md directory; omit to auto-detect one compatible skill" })),
  id: Type.Optional(Type.String({ description: "Installed id; omitted means the SKILL.md frontmatter name" })),
};

const PluginParameters = Type.Union([
  Type.Object({ op: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("inspect"), ...SourceFields }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("install"), ...SourceFields }, { additionalProperties: false }),
  Type.Object({
    op: Type.Literal("read"),
    id: Type.String({ description: "Exact installed managed plugin id" }),
    path: Type.Optional(Type.String({ description: "Installed inert file; defaults to SKILL.md" })),
  }, { additionalProperties: false }),
]);

function createPluginTool(service: ManagedPluginService): AgentTool<typeof PluginParameters> {
  return {
    name: "plugin",
    label: "plugin",
    description:
      "Inspect, install, and read compatible public GitHub SKILL.md bundles through an operator-approved managed store. Use this when an integration is a Claude/Codex/Copilot skill rather than MCP; do not tell the operator to run another plugin CLI. op=inspect pins a commit and reports license/files/permissions without executing code. op=install opens a persistent approval popup, stores only inert UTF-8 skill/reference files, and returns SKILL.md in the same call. Bypass cannot install. op=read loads installed references. Hooks, commands, agents, MCP servers, runtime modules, binary files, executable files, private repositories, and arbitrary URLs are not installed.",
    parameters: PluginParameters,
    async execute(_toolCallId, params, signal) {
      const outcome = params.op === "status"
        ? service.status()
        : params.op === "read"
          ? service.read(params.id, params.path)
          : params.op === "inspect"
            ? await service.inspect({
                repository: params.repository,
                ...(params.ref === undefined ? {} : { ref: params.ref }),
                ...(params.path === undefined ? {} : { path: params.path }),
                ...(params.id === undefined ? {} : { id: params.id }),
              })
            : await service.install({
                repository: params.repository,
                ...(params.ref === undefined ? {} : { ref: params.ref }),
                ...(params.path === undefined ? {} : { path: params.path }),
                ...(params.id === undefined ? {} : { id: params.id }),
              }, signal);
      return textToolResult(outcome.text, outcome.error);
    },
  };
}

export const plugin: PluginModule = {
  id: "plugin-installer",
  claims: [
    { key: "plugin_installer", role: "definition" },
    { key: "plugin_installer", role: "provider" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "permissions", role: "consumer", optional: true },
    { key: "skills", role: "consumer", modelFacing: true },
  ],
  activate() {
    if (process.env.DOKKABI_EXTERNAL_KNOWLEDGE === "deny") {
      return { active: false, reason: "external knowledge is disabled", kind: "not_configured" };
    }
    const privateChild = process.env.DOKKABI_PARENT_SESSION !== undefined
      || process.env.DOKKABI_SWARM_ROLE !== undefined;
    return privateChild
      ? { active: false, reason: "operator-approved plugin installation is unavailable to private swarm children", kind: "unavailable" }
      : { active: true };
  },
  register(ctx: HostContext) {
    const permissions = ctx.tryGet<PermissionController>("permissions");
    const service = createManagedPluginService({
      log: ctx.log,
      entries: readConfig().managed_plugins ?? {},
      ...(permissions ? { permissions } : {}),
    });
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.define("plugin_installer", {
      source: "public_github",
      content: "inert_skill_bundle",
      authority: "operator_approval",
      runtime: "none",
    });
    ctx.provide("plugin_installer", service);
    ctx.effect(() => tools.register("plugin-installer", createPluginTool(service)));
    ctx.effect(() => () => service.dispose());
  },
};
