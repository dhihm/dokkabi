import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { HostContext, PluginModule } from "../loader/types.ts";
import { BranchCheckpointService } from "../host/branch-checkpoint.ts";
import { workspaceToolsPolicy } from "./workspace-tools.ts";

/** The operator switch for branch checkpoints (docs/desktop-checkpoints-r7.md).
 * The capability is off unless this is exactly "1"; any other value is an
 * invalid configuration, not a silent off. */
export const BRANCH_CHECKPOINTS_ENV = "DOKKABI_BRANCH_CHECKPOINTS";

/** The trusted settled observation only the owning boot/desktop host can
 * supply. No renderer, model tool or plugin fabricates it. */
export interface WorkspaceCheckpointBoundary {
  isSettled(): boolean;
}

export const WORKSPACE_CHECKPOINTS_CAPABILITY = "workspace_checkpoints";

export const plugin: PluginModule = {
  id: "workspace-checkpoints",
  claims: [
    { key: WORKSPACE_CHECKPOINTS_CAPABILITY, role: "definition" },
    { key: WORKSPACE_CHECKPOINTS_CAPABILITY, role: "provider" },
    // The checkpoint service binds the same policy the live workspace tools
    // hold; it never creates a sandbox of its own.
    { key: "tools", role: "consumer" },
    { key: "workspace_checkpoint_boundary", role: "consumer", optional: true },
  ],
  activate(_ctx: HostContext) {
    const flag = process.env[BRANCH_CHECKPOINTS_ENV];
    if (flag === undefined || flag === "") {
      return { active: false, reason: `${BRANCH_CHECKPOINTS_ENV} is not set; branch checkpoints stay off`, kind: "not_configured" as const };
    }
    if (flag !== "1") {
      return { active: false, reason: `invalid ${BRANCH_CHECKPOINTS_ENV}=${JSON.stringify(flag)}; expected 1`, kind: "invalid_configuration" as const };
    }
    return { active: true };
  },
  register(ctx: HostContext) {
    // The exact array the tools provider registered: the policy lookup is
    // keyed by that identity, so it must pass through uncopied.
    const tools = ctx.tryGet<AgentTool[]>("tools");
    const policy = tools ? workspaceToolsPolicy(tools) : undefined;
    if (!policy) {
      // Without the workspace tools' policy there is no owned workspace to
      // checkpoint: the capability is defined and explicitly unavailable, and
      // no service instance is created.
      ctx.define(WORKSPACE_CHECKPOINTS_CAPABILITY, {
        visibility: "host_only",
        format: 1,
        availability: "refused",
        reason: "workspace policy unavailable",
      });
      return;
    }
    const boundary = ctx.tryGet<WorkspaceCheckpointBoundary>("workspace_checkpoint_boundary");
    // A missing boundary must not create a usable mutation capability: the
    // service exists for verified reads, but capture can never pass a
    // settled observation it was never given. A read-only log refuses
    // capture and materialization inside the service itself.
    const service = new BranchCheckpointService({
      log: ctx.log,
      sessionId: ctx.sessionId,
      policy,
      isSettled: boundary ? () => boundary.isSettled() : () => false,
    });
    ctx.define(WORKSPACE_CHECKPOINTS_CAPABILITY, {
      visibility: "host_only",
      format: 1,
      mutations: ["capture", "materialize"],
      read: "stateless_verified_read",
      boundary: boundary === undefined ? "unsettled" : "host_supplied",
    });
    ctx.provide(WORKSPACE_CHECKPOINTS_CAPABILITY, service);
    ctx.effect(() => () => service.revoke());
  },
};
