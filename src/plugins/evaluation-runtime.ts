import { z } from "zod";
import type { ArtifactContributionRegistry, PluginModule } from "../loader/types.ts";
import { createEvaluationRegistry } from "../work/evidence/registry.ts";
import { evidenceDigest } from "../work/evidence/contract.ts";
import { contextBodySchema, dispatchSchema, receiptSchema, gateEvidenceInputV2Schema, evidenceDecisionV2Schema, resultSchema, enrollmentSchema } from "../work/evidence/schema.ts";

const bodySchema = z.union([contextBodySchema, dispatchSchema, receiptSchema, gateEvidenceInputV2Schema, evidenceDecisionV2Schema, enrollmentSchema]);
export const plugin: PluginModule = {
  id: "evaluation-runtime",
  claims: [
    { key: "artifact_contributions", role: "consumer" },
    { key: "verify", role: "consumer" },
    { key: "evaluation_context_source", role: "consumer", optional: true },
    { key: "evaluation", role: "definition" }, { key: "evaluation", role: "provider" },
  ],
  register(ctx) {
    const artifacts = ctx.inject<ArtifactContributionRegistry>("artifact_contributions");
    ctx.effect(() => artifacts.register("evidence-record-v2", { validate: value => bodySchema.parse(value), digest: evidenceDigest }));
    ctx.effect(() => artifacts.register("evaluation-result-v2", { validate: value => resultSchema.parse(value), digest: evidenceDigest }));
    ctx.define("evaluation", { ordering: "manifest", visibility: "host_only", truth: "event_log", format: 2 });
    const registry = createEvaluationRegistry(ctx, artifacts);
    ctx.effect(() => () => registry.dispose());
    ctx.provide("evaluation", registry);
  },
};
