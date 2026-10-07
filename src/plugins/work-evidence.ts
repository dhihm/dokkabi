import type { EvaluationRegistry, PluginModule, WorkEvidence } from "../loader/types.ts";
import { projectEvidence } from "../work/evidence/projection.ts";

export const plugin: PluginModule = {
  id: "work-evidence",
  claims: [
    { key: "evaluation", role: "consumer" }, { key: "verify", role: "consumer" },
    { key: "work_evidence", role: "definition" }, { key: "work_evidence", role: "provider" },
  ],
  register(ctx) {
    const registry = ctx.inject<EvaluationRegistry>("evaluation");
    let active = true;
    ctx.effect(() => () => { active = false; });
    const facade: WorkEvidence = Object.freeze({
      evaluate(request: unknown) {
        if (!active) return Promise.resolve({ status: "unavailable" as const, reason_code: "work_evidence_unloaded" });
        return registry.dispatch(request);
      },
      projectEvidence,
    });
    ctx.define("work_evidence", { visibility: "host_only", truth: "event_log", format: 2 });
    ctx.provide("work_evidence", facade);
  },
};
