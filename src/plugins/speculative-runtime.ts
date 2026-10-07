import type { HostContext, PluginModule } from "../loader/types.ts";
import { projectSessionReplaySchemas } from "../host/schema.ts";
import { SpeculationServiceError, type SpeculationService } from "../speculative/service.ts";
import { createLegacySpeculationService } from "./speculative-runtime-v1.ts";
import { createCurrentSpeculationService } from "./speculative-runtime-v2.ts";

export function createSpeculationService(ctx: HostContext): SpeculationService {
  let service: SpeculationService | undefined;
  let disposed = false;
  const current = (): SpeculationService => {
    if (disposed) throw new SpeculationServiceError();
    service ??= projectSessionReplaySchemas(ctx.log.events).featureStart.has("speculation-v2")
      ? createCurrentSpeculationService(ctx)
      : createLegacySpeculationService(ctx);
    return service;
  };
  return {
    project(input) {
      return current().project(input);
    },
    observeAgentEvent(event) { service?.observeAgentEvent(event); },
    observeToolResult(result) { service?.observeToolResult(result); },
    requiresDurableForeground(tool, args) { return service?.requiresDurableForeground?.(tool, args) === true; },
    stageForegroundAuthorization(callId, receipt) { service?.stageForegroundAuthorization?.(callId, receipt); },
    stageAuthorizedCases(receipt) { current().stageAuthorizedCases?.(receipt); },
    assertHealthy() { service?.assertHealthy?.(); },
    async idle() { await service?.idle(); },
    invalidate() { service?.invalidate(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      service?.dispose();
    },
  };
}

export const plugin: PluginModule = {
  id: "speculative-runtime",
  claims: [
    { key: "speculation", role: "definition" },
    { key: "speculation", role: "provider" },
    { key: "ssh", role: "consumer", optional: true },
  ],
  register(ctx) {
    const service = createSpeculationService(ctx);
    ctx.define("speculation", { lifecycle: "provider-owned" });
    ctx.provide("speculation", service);
    ctx.effect(() => () => service.dispose());
  },
};
