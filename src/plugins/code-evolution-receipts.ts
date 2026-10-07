import type { HostContext, PluginModule } from "../loader/types.ts";
import { CodeEvolutionReceiptService } from "../host/code-evolution-receipts.ts";

export const CODE_EVOLUTION_RECEIPTS = "code_evolution_receipts";
export const CODE_EVOLUTION_RECEIPTS_ENV = "DOKKABI_CODE_EVOLUTION_RECEIPTS";

export const plugin: PluginModule = {
  id: "code-evolution-receipts",
  claims: [
    { key: CODE_EVOLUTION_RECEIPTS, role: "definition" },
    { key: CODE_EVOLUTION_RECEIPTS, role: "provider" },
  ],
  activate() {
    const flag = process.env[CODE_EVOLUTION_RECEIPTS_ENV];
    if (flag === undefined || flag === "")
      return {
        active: false,
        kind: "not_configured",
        reason: "Code evolution receipt reads are not configured",
      };
    if (flag !== "1")
      return {
        active: false,
        kind: "invalid_configuration",
        reason: "Code evolution receipt reads require an explicit value of 1",
      };
    return { active: true };
  },
  register(ctx: HostContext) {
    const service = new CodeEvolutionReceiptService({
      log: ctx.log,
      sessionId: ctx.sessionId,
      workspaceRoot: ctx.workspaceRoot,
    });
    ctx.define(CODE_EVOLUTION_RECEIPTS, {
      visibility: "host_only",
      format: 1,
      read: "source_pinned_recorded_mutation",
      modelFacing: false,
    });
    ctx.provide(
      CODE_EVOLUTION_RECEIPTS,
      Object.freeze({ read: (request: unknown) => service.read(request) }),
    );
    ctx.effect(() => () => service.revoke());
  },
};
