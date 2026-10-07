import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import { evidenceDigest, freezeEvidence } from "../../work/evidence/contract.ts";
import type { WorkPlan } from "../../work/schema.ts";

export const EXPERIMENT_FACTORS = ["managed_tests", "red_first", "acceptance", "bar_pinning", "thresholds", "substrate"] as const;
export type ExperimentFactor = typeof EXPERIMENT_FACTORS[number];
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const factors = z.array(z.enum(EXPERIMENT_FACTORS)).max(EXPERIMENT_FACTORS.length).refine(values => new Set(values).size === values.length, "duplicate factor");
export const conditionManifestSchema = z.strictObject({
  schema_version: z.literal(1), id,
  conditions: z.array(z.strictObject({ id, removed: factors })).min(1).max(32),
}).refine(value => new Set(value.conditions.map(row => row.id)).size === value.conditions.length, "duplicate condition");
export const conditionRequestSchema = z.strictObject({ schema_version: z.literal(1), experiment_id: id, condition: id, task_id: id, repeat: z.number().int().min(1).max(1000000) });
export type ConditionManifest = z.infer<typeof conditionManifestSchema>;
export type ConditionRequest = z.infer<typeof conditionRequestSchema>;

export function resolveCondition(manifestInput: unknown, requestInput: unknown) {
  const manifest = conditionManifestSchema.parse(manifestInput), requested = conditionRequestSchema.parse(requestInput);
  const condition = manifest.conditions.find(row => row.id === requested.condition);
  if (requested.experiment_id !== manifest.id || !condition) throw new Error("unknown experiment condition");
  const removed = EXPERIMENT_FACTORS.filter(factor => condition.removed.includes(factor));
  return freezeEvidence({ schema_version: 1 as const, manifest, manifest_digest: evidenceDigest(manifest), requested,
    resolved: { condition: condition.id, removed, evidence_level: removed.length ? "ablated" as const : "full" as const } });
}
export type ConditionBinding = ReturnType<typeof resolveCondition>;

/** Reconstruct binding from rows, without reading a manifest, environment or
 * plugin instance. Both requested and resolved policy must match exactly. */
export function projectExperimentCondition(events: readonly EventRecord[]) {
  let binding: ConditionBinding | undefined, bindingSeq: number | undefined, bindingDigest: string | undefined;
  let ablationSeen = false;
  let requiresBinding = false;
  const references: { seq: number; name: string; digest: string }[] = [];
  for (const event of events) {
    if (event.name === "observation/schema" && Array.isArray(event.payload.plugins) && event.payload.plugins.includes("experiment-runtime")) requiresBinding = true;
    if (requiresBinding && !binding && (/^(provider\/request|tool\/(?:call|start)|fixture\/|work\/(?:case|execution|goal|run_result)|swarm\/dispatch|plugin\/runtime_ready)/u.test(event.name)
      || event.name === "plugin/load" && event.payload.id !== "gate-runtime")) throw new Error("experiment action precedes its registered binding");
    if (event.name === "experiment/bind") {
      const p = event.payload;
      const expected = resolveCondition(p.manifest, p.requested);
      if (event.kind !== "observe" || canonicalJson(p) !== canonicalJson(expected)) throw new Error("experiment requested/resolved binding mismatch");
      const digest = evidenceDigest(expected);
      if (bindingDigest && bindingDigest !== digest) throw new Error("experiment condition cannot change within a session");
      binding = expected; bindingSeq = event.seq; bindingDigest = digest; ablationSeen = false;
      references.push({ seq: event.seq, name: event.name, digest });
    } else if (event.name === "eval/ablation") {
      if (!binding || event.kind !== "observe" || event.seq !== bindingSeq! + 1 || ablationSeen
        || event.payload.binding_digest !== bindingDigest || canonicalJson(event.payload.links) !== canonicalJson(binding.resolved.removed)) throw new Error("ablation lacks its registered condition binding");
      ablationSeen = true; references.push({ seq: event.seq, name: event.name, digest: evidenceDigest(event.payload) });
    } else if (event.name.startsWith("experiment/")) {
      if (!["experiment/factors", "experiment/case_policy", "experiment/measurement_policy", "experiment/bar_change"].includes(event.name)) throw new Error("unknown experiment observation");
      if (!binding || !ablationSeen || event.payload.binding_digest !== bindingDigest) throw new Error("experiment observation has no bound policy");
      references.push({ seq: event.seq, name: event.name, digest: evidenceDigest(event.payload) });
    }
  }
  if (binding && !ablationSeen) throw new Error("condition binding lacks its ablation declaration");
  return { binding, bindingSeq, bindingDigest, references };
}

export function conditionRemoves(events: readonly EventRecord[], factor: ExperimentFactor): boolean {
  return projectExperimentCondition(events).binding?.resolved.removed.includes(factor) ?? false;
}

/** Bar-pinning removal changes numeric standards only. It cannot retire a
 * requirement, substitute a checker, change a metric or alter its direction. */
export function barValuesOnly(before: WorkPlan, after: WorkPlan): boolean {
  const withoutValues = (plan: WorkPlan) => {
    const copy = structuredClone(plan);
    for (const item of copy.cases) {
      if (item.thresholds) item.thresholds = Object.fromEntries(Object.entries(item.thresholds).map(([name, value]) => {
        const match = /^(>=|<=)?\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.exec(value.trim());
        return [name, match ? `${match[1] ?? "="}number` : value];
      }));
      if (item.measurement) item.measurement.requirements = item.measurement.requirements.map(requirement => ({ ...requirement, value: 0 }));
    }
    return copy;
  };
  return canonicalJson(before) !== canonicalJson(after) && canonicalJson(withoutValues(before)) === canonicalJson(withoutValues(after));
}

export const factorFactSchema = z.strictObject({
  factor: z.enum(EXPERIMENT_FACTORS), status: z.enum(["pass", "refuse", "not_applicable", "error", "cancel", "not_evaluated"]),
  reason: id,
  sources: z.array(z.strictObject({ seq: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/u) })).max(64),
});
export type FactorFact = z.infer<typeof factorFactSchema>;
/** One pure pass on an immutable fact vector. It has no callback, I/O,
 * acceptance, restoration, scheduler, prompt or model capability. */
export function decideExperimentFactors(factsInput: readonly FactorFact[], removedInput: readonly ExperimentFactor[]) {
  const facts = z.array(factorFactSchema).max(EXPERIMENT_FACTORS.length).parse(factsInput), removed = factors.parse(removedInput);
  if (new Set(facts.map(fact => fact.factor)).size !== facts.length) throw new Error("duplicate factor facts");
  return freezeEvidence(facts.map(fact => ({ ...fact, mode: removed.includes(fact.factor) ? "shadow" as const : "active" as const,
    enforced: !removed.includes(fact.factor), refused: fact.status === "not_evaluated" ? null : ["refuse", "error", "cancel"].includes(fact.status),
  })));
}

export function projectExperimentFacts(events: readonly EventRecord[]) {
  const condition = projectExperimentCondition(events);
  const decisions = [];
  for (const event of events) {
    if (!["experiment/factors", "experiment/case_policy", "experiment/measurement_policy"].includes(event.name)) continue;
    if (!condition.binding) throw new Error("unbound experiment facts");
    const p = event.payload;
    const derived = event.name === "experiment/factors" ? p : p.decision as Record<string, unknown>;
    const facts = z.array(factorFactSchema).parse(derived?.facts);
    for (const fact of facts) {
      if (fact.status !== "not_evaluated" && !fact.sources.length) throw new Error("evaluated factor lacks observations");
      if (event.name === "experiment/factors" && fact.status !== "not_evaluated") throw new Error("evaluated factor requires raw policy derivation");
      for (const source of fact.sources) {
        if (source.seq >= event.seq || !events.some(row => row.seq === source.seq && row.hash === source.hash)) throw new Error("shadow fact source is unavailable");
      }
    }
    const expected = decideExperimentFactors(facts, condition.binding.resolved.removed);
    if ((event.name === "experiment/factors" && p.facts_digest !== evidenceDigest(facts)) || canonicalJson(derived.decisions) !== canonicalJson(expected)) throw new Error("shadow decision differs from immutable facts");
    decisions.push({ seq: event.seq, facts, decisions: expected });
  }
  return { ...condition, decisions };
}
