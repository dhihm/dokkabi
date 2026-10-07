import type { HostContext, PluginModule } from "../loader/types.ts";
export const CODE_EVOLUTION_VERSIONS = "code_evolution_versions";
export const CODE_EVOLUTION_VERSIONS_ENV = "DOKKABI_CODE_EVOLUTION_VERSIONS";
export const plugin: PluginModule = {
  id: "code-evolution-versions",
  claims: [
    { key: CODE_EVOLUTION_VERSIONS, role: "definition" },
    { key: CODE_EVOLUTION_VERSIONS, role: "provider" },
  ],
  activate() {
    const flag = process.env[CODE_EVOLUTION_VERSIONS_ENV];
    if (flag === undefined || flag === "")
      return {
        active: false,
        kind: "not_configured",
        reason: "Code evolution versions are not configured",
      };
    if (flag !== "1")
      return {
        active: false,
        kind: "invalid_configuration",
        reason: "Code evolution versions require an explicit value of 1",
      };
    return { active: true };
  },
  async register(ctx: HostContext) {
    const { CodeEvolutionVersionService } = await import("../host/code-evolution-versions.ts");
    const service = new CodeEvolutionVersionService({
      log: ctx.log,
      sessionId: ctx.sessionId,
      workspaceRoot: ctx.workspaceRoot,
    });
    ctx.define(CODE_EVOLUTION_VERSIONS, {
      visibility: "host_only",
      format: 1,
      modelFacing: false,
      read: "retained_structural_version",
    });
    ctx.provide(
      CODE_EVOLUTION_VERSIONS,
      Object.freeze({
        capture: (input: unknown) => service.capture(input),
        read: (input: unknown) => service.read(input),
      }),
    );
    ctx.effect(() => () => service.revoke());
  },
};
