import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readConfig, updateMcpServers } from "../../src/host/config.ts";
import { createMcpService, type McpService } from "../../src/host/mcp.ts";
import type { PermissionController } from "../../src/host/permissions.ts";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const McpParameters = Type.Union([
  Type.Object({ op: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({
    op: Type.Literal("enroll"),
    name: Type.String({ description: "Stable public name for this MCP server" }),
    command: Type.String({ description: "One executable name, never a shell command or path" }),
    args: Type.Optional(Type.Array(Type.String(), { maxItems: 24 })),
    env: Type.Optional(Type.Array(Type.String(), {
      maxItems: 16,
      description: "Names of host environment credentials to copy; never provide their values",
    })),
  }, { additionalProperties: false }),
  Type.Object({
    op: Type.Literal("tools"),
    server: Type.Optional(Type.String({ description: "Enrolled server name; omit to inspect all servers" })),
  }, { additionalProperties: false }),
  Type.Object({
    op: Type.Literal("call"),
    server: Type.String({ description: "Enrolled server name" }),
    tool: Type.String({ description: "Exact tool name returned by op=tools" }),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }, { additionalProperties: false }),
]);

function createMcpTool(service: McpService): AgentTool<typeof McpParameters> {
  return {
    name: "mcp",
    label: "MCP",
    description:
      "Enroll and use arbitrary MCP stdio servers through one generic operator-approved capability. If the operator asks for an external integration that is available as MCP, use op=enroll with the exact executable/args and credential ENVIRONMENT NAMES; never ask them to edit MCP JSON. First enrollment opens a persistent approval and continues the same call with discovered tools. op=tools discovers tools. op=call invokes one exact server/tool and is approval-gated. Servers run in a disposable empty sandbox with no Dokkabi workspace or ambient environment. Never put credential values in arguments; env contains names only. Bypass cannot enroll new server code.",
    parameters: McpParameters,
    async execute(_toolCallId, params, signal) {
      const outcome = params.op === "status"
        ? service.status()
        : params.op === "enroll"
          ? await service.enroll({
              name: params.name,
              command: params.command,
              ...(params.args === undefined ? {} : { args: params.args }),
              ...(params.env === undefined ? {} : { env: params.env }),
            }, signal)
          : params.op === "tools"
            ? await service.tools(params.server)
            : await service.call({
                server: params.server,
                tool: params.tool,
                ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
              }, signal);
      const result = textToolResult(outcome.text, outcome.error);
      // The service's own cut is producer truncation, stated structurally so
      // the host's envelope records it (#223 R1).
      return outcome.truncated ? { ...result, details: { ...result.details, producer_truncated: true as const } } : result;
    },
  };
}

export const plugin: PluginModule = {
  id: "mcp",
  claims: [
    { key: "mcp", role: "definition" },
    { key: "mcp", role: "provider" },
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
      ? { active: false, reason: "operator-approved MCP is unavailable to private swarm children", kind: "unavailable" }
      : { active: true };
  },
  register(ctx: HostContext) {
    const permissions = ctx.tryGet<PermissionController>("permissions");
    const service = createMcpService({
      log: ctx.log,
      servers: readConfig().mcp?.servers ?? {},
      saveServers: updateMcpServers,
      ...(permissions ? { permissions } : {}),
    });
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.define("mcp", {
      authority: "operator_approval",
      transport: "stdio",
      filesystem: "isolated_empty",
      discovery: "generic_tool",
    });
    ctx.provide("mcp", service);
    ctx.effect(() => tools.register("mcp", createMcpTool(service)));
    ctx.effect(() => () => service.dispose());
  },
};
