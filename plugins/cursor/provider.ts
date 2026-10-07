import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  createCursorService,
  CURSOR_DEFAULT_TIMEOUT_SECONDS,
  CURSOR_MAX_TIMEOUT_SECONDS,
  CURSOR_PROMPT_MAX_BYTES,
  type CursorService,
} from "../../src/host/cursor.ts";
import type { HostContext, PluginModule, ToolContributionRegistry } from "../../src/loader/types.ts";
import type { PermissionController } from "../../src/host/permissions.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const CursorParameters = Type.Object({
  op: Type.Union([
    Type.Literal("status"),
    Type.Literal("ask"),
    Type.Literal("plan"),
  ]),
  prompt: Type.Optional(Type.String({
    minLength: 1,
    maxLength: CURSOR_PROMPT_MAX_BYTES,
    description:
      "op=ask/plan: the question, self-contained. Name files by workspace-relative path and quote the lines that matter;"
      + " never include a key, token, password, or a private host address",
  })),
  model: Type.Optional(Type.String({
    description: "Vendor model id; defaults to the operator's configured default (auto)",
  })),
  timeout: Type.Optional(Type.Number({
    minimum: 1,
    maximum: CURSOR_MAX_TIMEOUT_SECONDS,
    description: `Seconds to wait; defaults to ${CURSOR_DEFAULT_TIMEOUT_SECONDS}. Anything that makes it read the tree takes minutes`,
  })),
}, { additionalProperties: false });

function createCursorTool(service: CursorService): AgentTool<typeof CursorParameters> {
  return {
    name: "cursor",
    label: "Cursor",
    description:
      "A second opinion from Cursor's own agent, read-only. CALL SHAPES — op=status: no other arguments; reports whether the"
      + " executable and credential are present. op=ask: prompt (a question about this workspace, answered in prose)."
      + " op=plan: prompt (asks for an approach rather than an answer). Both run the vendor CLI in its read-only modes:"
      + " it may read the workspace, and it can never write a file, run a shell command, or make a commit — so its answer is"
      + " advice you act on yourself, and a change it suggests is yours to make and to prove with a case. The prompt and"
      + " whatever it reads leave this machine, so it is approval-gated like ssh and refuses a prompt carrying a secret or a"
      + " private host address. A simple question comes back in seconds; one that makes it read the tree takes minutes."
      + " Use it for a review, a second reading of a failure, or a design"
      + " question — not for work you can do here.",
    parameters: CursorParameters,
    async execute(_toolCallId, params, signal) {
      if (params.op === "status") return textToolResult(service.status().text);
      if (!params.prompt) return textToolResult(`cursor ${params.op} requires prompt`, true);
      const result = await service.ask({
        mode: params.op,
        prompt: params.prompt,
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
      }, signal);
      return textToolResult(result.text, result.error);
    },
  };
}

export const plugin: PluginModule = {
  id: "cursor",
  claims: [
    { key: "cursor", role: "definition" },
    { key: "cursor", role: "provider" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "permissions", role: "consumer", optional: true },
  ],
  activate() {
    // Same rule as ssh: a private swarm child gets no capability that sends
    // workspace content off this machine under the operator's credential.
    const swarmChild = process.env.DOKKABI_PARENT_SESSION !== undefined
      || process.env.DOKKABI_SWARM_ROLE !== undefined;
    return swarmChild
      ? { active: false, reason: "operator-approved Cursor is unavailable to private swarm children", kind: "unavailable" }
      : { active: true };
  },
  register(ctx: HostContext) {
    const permissions = ctx.tryGet<PermissionController>("permissions");
    const service = createCursorService({
      log: ctx.log,
      workspaceRoot: ctx.workspaceRoot,
      ...(permissions ? { permissions } : {}),
    });
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.define("cursor", { authority: "operator_approval", transport: "host_cursor_agent", writes: "never" });
    ctx.provide("cursor", service);
    ctx.effect(() => tools.register("cursor", createCursorTool(service)));
    ctx.effect(() => () => service.dispose());
  },
};
