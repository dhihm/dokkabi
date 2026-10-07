import type { PluginModule } from "../loader/types.ts";
import { BranchCheckpointService } from "../host/branch-checkpoint.ts";
import { BranchDecisionService, type BranchDecisionStandingPolicy } from "../host/branch-decision.ts";
import { BRANCH_CHECKPOINTS_ENV } from "./workspace-checkpoints.ts";

/** R8-04 optional host-only branch decisions (docs/desktop-decisions-r8.md).
 * The capability is off unless the operator turned branch checkpoints on;
 * without an owned checkpoint service it is defined and explicitly
 * unavailable. A standing recommendation policy is host-owned operator
 * authority this plugin may consume, never model or tool input. The plugin
 * registers no tools: the model-visible inventory stays unchanged, and
 * selection never converts into a permission. */

export const BRANCH_DECISIONS_CAPABILITY = "branch_decisions";
/** Host-owned operator standing policy consumed, never provided, here. */
export const BRANCH_DECISION_POLICY_CAPABILITY = "branch_decision_policy";

export const plugin: PluginModule = {
  id: "branch-decisions",
  claims: [
    { key: BRANCH_DECISIONS_CAPABILITY, role: "definition" },
    { key: BRANCH_DECISIONS_CAPABILITY, role: "provider" },
    // The decision service binds the owning session's verified checkpoints.
    { key: "workspace_checkpoints", role: "consumer" },
    { key: BRANCH_DECISION_POLICY_CAPABILITY, role: "consumer", optional: true },
  ],
  activate(_ctx) {
    const flag = process.env[BRANCH_CHECKPOINTS_ENV];
    if (flag === undefined || flag === "") {
      return { active: false, reason: `${BRANCH_CHECKPOINTS_ENV} is not set; branch decisions stay off`, kind: "not_configured" as const };
    }
    if (flag !== "1") {
      return { active: false, reason: `invalid ${BRANCH_CHECKPOINTS_ENV}=${JSON.stringify(flag)}; expected 1`, kind: "invalid_configuration" as const };
    }
    return { active: true };
  },
  register(ctx) {
    const checkpoints = ctx.tryGet<BranchCheckpointService>("workspace_checkpoints");
    if (!(checkpoints instanceof BranchCheckpointService)) {
      // Defined and explicitly unavailable: no service instance exists, so
      // no reader can mistake a lookalike for decision authority.
      ctx.define(BRANCH_DECISIONS_CAPABILITY, {
        visibility: "host_only",
        format: 1,
        availability: "refused",
        reason: "workspace checkpoints unavailable",
      });
      return;
    }
    const standingPolicy = ctx.tryGet<BranchDecisionStandingPolicy>(BRANCH_DECISION_POLICY_CAPABILITY);
    const service = new BranchDecisionService({
      log: ctx.log,
      sessionId: ctx.sessionId,
      checkpoints,
      ...(standingPolicy === undefined ? {} : { standingPolicy }),
    });
    ctx.define(BRANCH_DECISIONS_CAPABILITY, {
      visibility: "host_only",
      format: 1,
      mutations: ["open", "selectHuman", "selectDuePolicy", "beginApplication"],
      read: "verified_fold",
      // R8-04 records admission only; actual dispatch stays a separate gate.
      execution: "unsupported_until_r8_05",
    });
    ctx.provide(BRANCH_DECISIONS_CAPABILITY, service);
  },
};
