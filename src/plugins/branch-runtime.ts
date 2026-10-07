import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { HostContext, PluginModule } from "../loader/types.ts";
import { BranchCheckpointService } from "../host/branch-checkpoint.ts";
import { BranchDecisionService } from "../host/branch-decision.ts";
import {
  DesktopBranchRuntime,
  BRANCH_RUNTIME_CAPABILITY,
  DESKTOP_BRANCH_RUNTIME_BOUNDARY,
  type DesktopModelSelection,
} from "../chat/desktop-branch-runtime.ts";
import { workspaceToolsPolicy } from "./workspace-tools.ts";
import { BRANCH_CHECKPOINTS_ENV } from "./workspace-checkpoints.ts";
import { CONTEXT_GRAPH_SERVICE_CAPABILITY } from "./context-graph.ts";
import { ContextGraphService } from "../context-graph/service.ts";

/** R8-05 optional host-only branch runtime (docs/desktop-runtime-r8.md).
 *
 * The runnable capability exists only when the trusted desktop boot boundary
 * supplied the factory coordinates, the operator turned branch checkpoints
 * on, AND the ACTUAL registered ContextGraph service is present with mode
 * `on`: with the graph off or in shadow mode there is no runnable imported
 * branch, and the capability stays defined-but-unavailable (read and record
 * modes are preserved untouched). A non-desktop boot likewise exposes no
 * runnable branch capability. The plugin registers no tools and adds no
 * loop branch — the runtime it provides composes the accepted R8-01..R8-04
 * authorities around a normal child kernel boot. */

export const plugin: PluginModule = {
  id: "branch-runtime",
  claims: [
    { key: BRANCH_RUNTIME_CAPABILITY, role: "definition" },
    { key: BRANCH_RUNTIME_CAPABILITY, role: "provider" },
    // The runtime binds the owning session's verified checkpoints and the
    // actual durable decision service.
    { key: "workspace_checkpoints", role: "consumer" },
    { key: "tools", role: "consumer" },
    { key: "branch_decisions", role: "consumer" },
    // The ACTUAL registered ContextGraph service: a mandatory claim, so
    // this fiber only registers after the context-graph plugin provided it
    // (with the graph off there is nothing to consume at all).
    { key: CONTEXT_GRAPH_SERVICE_CAPABILITY, role: "consumer" },
    // The trusted desktop factory boundary, absent on non-desktop boots.
    { key: DESKTOP_BRANCH_RUNTIME_BOUNDARY, role: "consumer", optional: true },
  ],
  activate(_ctx: HostContext) {
    const flag = process.env[BRANCH_CHECKPOINTS_ENV];
    if (flag === undefined || flag === "") {
      return { active: false, reason: `${BRANCH_CHECKPOINTS_ENV} is not set; the branch runtime stays off`, kind: "not_configured" as const };
    }
    if (flag !== "1") {
      return { active: false, reason: `invalid ${BRANCH_CHECKPOINTS_ENV}=${JSON.stringify(flag)}; expected 1`, kind: "invalid_configuration" as const };
    }
    return { active: true };
  },
  register(ctx: HostContext) {
    const define = (availability: string, reason: string): void => {
      ctx.define(BRANCH_RUNTIME_CAPABILITY, {
        visibility: "host_only",
        format: 1,
        availability,
        reason,
      });
    };
    const boundary = ctx.tryGet<{
      home: string; repoRoot: string; manifestPath: string; storageRoot: string;
    }>(DESKTOP_BRANCH_RUNTIME_BOUNDARY);
    if (boundary === undefined) {
      define("refused", "no trusted desktop branch runtime boundary");
      return;
    }
    const checkpoints = ctx.tryGet<BranchCheckpointService>("workspace_checkpoints");
    if (!(checkpoints instanceof BranchCheckpointService)) {
      define("refused", "workspace checkpoints unavailable");
      return;
    }
    const decisions = ctx.tryGet<BranchDecisionService>("branch_decisions");
    if (!(decisions instanceof BranchDecisionService)) {
      define("refused", "branch decisions unavailable");
      return;
    }
    // The actual registered service, mode `on` required: shadow records
    // frames without provider application and offers no runnable branch.
    const context = ctx.tryGet<ContextGraphService>(CONTEXT_GRAPH_SERVICE_CAPABILITY);
    if (!(context instanceof ContextGraphService)) {
      define("refused", "context graph service unavailable");
      return;
    }
    if (context.mode !== "on") {
      define("refused", "runnable imported branches require DOKKABI_CONTEXT_GRAPH=on");
      return;
    }
    // Reuse the actual registered workspace policy, as checkpoint capture
    // does. Reading its runtime identity creates no new sandbox or resource.
    const tools = ctx.tryGet<AgentTool[]>("tools");
    const policy = tools ? workspaceToolsPolicy(tools) : undefined;
    if (policy === undefined || policy.workspaceRoot !== ctx.workspaceRoot) {
      define("refused", "workspace policy unavailable");
      return;
    }
    const runtimeExecutable = policy.runtimeExecutable;
    const runtime = new DesktopBranchRuntime({
      log: ctx.log,
      sessionId: ctx.sessionId,
      checkpoints,
      decisions,
      home: boundary.home,
      repoRoot: boundary.repoRoot,
      manifestPath: boundary.manifestPath,
      storageRoot: boundary.storageRoot,
      runtimeExecutable,
      // The actual current parent route/provider/model, read through the
      // live llm facade — custom plugin routes included, no static catalog
      // authority. Evaluated at child creation/boot/dispatch time, when the
      // owning kernel's selection is in force.
      parentModelSelection: (): DesktopModelSelection => {
        const llm = ctx.llm;
        if (!llm) throw new Error("branch_runtime_model_policy_unresolved");
        const route = llm.activeName;
        const model = llm.activeModelId ?? llm.active().defaultModelId();
        const provider = llm.routes.get(route)?.providerId;
        if (typeof model !== "string" || model.length === 0 || typeof provider !== "string" || provider.length === 0) {
          throw new Error("branch_runtime_model_policy_unresolved");
        }
        return { route, provider, model };
      },
    });
    ctx.define(BRANCH_RUNTIME_CAPABILITY, {
      visibility: "host_only",
      format: 1,
      feature: "branch-runtime-v1",
      mutations: ["start_child"],
      execution: "prepared_conversation_only",
    });
    ctx.provide(BRANCH_RUNTIME_CAPABILITY, runtime);
    // Disposal cascades through the kernel's plugin lifecycle: the runtime
    // disposes only its owned child kernels/leases, preserving persistent
    // workspaces and evidence. The disposer RETURNS the dispose promise so
    // a parent kernel/server shutdown truly finishes releasing every child
    // lease before it answers.
    ctx.effect(() => () => runtime.dispose());
  },
};
