import { readFileSync } from "node:fs";
import { experimentRequestFromEnv } from "../eval/experiment/request-env.ts";
import type { EventLog } from "../host/event-log.ts";
import { ensureObservationSchema } from "../host/observation-schema.ts";
import type { HostContext, PluginModule } from "../loader/types.ts";
import type { GateRegistry } from "../work/gate/registry.ts";
import { evidenceDigest } from "../work/evidence/contract.ts";
import { decideCaseFactors } from "../eval/experiment/case-policy.ts";
import { decideMeasurementFactors } from "../eval/experiment/measurement-policy.ts";
import type { MeasurementResultV1 } from "../work/evidence/measurements.ts";
import type { Case } from "../work/schema.ts";
import type { RecordedOutput } from "../tools/recorded-output.ts";
import { projectExperimentCondition, resolveCondition, type ConditionBinding, type ExperimentFactor, type FactorFact } from "../eval/experiment/condition.ts";

export interface ExperimentRuntime {
  readonly binding: ConditionBinding;
  enabled(factor: ExperimentFactor): boolean;
  record(facts: readonly FactorFact[]): void;
}
const runtimes = new WeakMap<EventLog, ExperimentRuntime>();

/** A recorded experiment still requires its live registered provider. Loading
 * a log alone cannot grant a product bypass. */
export function experimentRuntime(log: EventLog): ExperimentRuntime | undefined {
  const runtime = runtimes.get(log);
  const recorded = projectExperimentCondition(log.events);
  if (!runtime && (recorded.binding || process.env.DOKKABI_EVAL_ABLATE !== undefined || process.env.DOKKABI_EXPERIMENT_MANIFEST !== undefined || process.env.DOKKABI_EXPERIMENT_REQUEST !== undefined)) throw new Error("experiment policy is unbound or unloaded");
  if (runtime && evidenceDigest(runtime.binding) !== recorded.bindingDigest) throw new Error("experiment live policy differs from its recorded binding");
  return runtime;
}
export function factorEnabled(log: EventLog, factor: ExperimentFactor): boolean {
  return experimentRuntime(log)?.enabled(factor) ?? true;
}
export function recordUnobservedFactor(log: EventLog, factor: ExperimentFactor, reason: string): void {
  experimentRuntime(log)?.record([{ factor, status: "not_evaluated", reason, sources: [] }]);
}

export function recordCasePolicy(log: EventLog, item: Case, recorded: Extract<RecordedOutput, { ok: true }>, durationMs: number, host: string) {
  const runtime = experimentRuntime(log);
  if (!runtime || recorded.error) throw new Error("case policy requires a bound successful execution");
  const decision = decideCaseFactors(item, recorded.body, durationMs, host, { seq: recorded.seq, hash: recorded.hash }, runtime.binding.resolved.removed);
  const row = log.appendDurable({ kind: "observe", name: "experiment/case_policy", payload: {
    binding_digest: evidenceDigest(runtime.binding), case_id: item.id, result_seq: recorded.seq, result_hash: recorded.hash,
    duration_ms: durationMs, host_label: host, decision,
  } });
  return { ...decision, reference: { seq: row.seq, hash: row.hash } };
}

export function recordMeasurementPolicy(log: EventLog, result: MeasurementResultV1) {
  const runtime = experimentRuntime(log);
  const source = log.events.find(row => row.name === "measurement/result" && row.payload.session_id === result.session_id);
  if (!runtime || !source || source.payload.blob !== evidenceDigest(result)) throw new Error("measurement policy requires its recorded result");
  const decision = decideMeasurementFactors(result.derivation, { seq: source.seq, hash: source.hash }, runtime.binding.resolved.removed);
  const row = log.appendDurable({ kind: "observe", name: "experiment/measurement_policy", payload: {
    binding_digest: evidenceDigest(runtime.binding), session_id: result.session_id, result_seq: source.seq, result_hash: source.hash,
    result_digest: source.payload.blob, decision, decision_digest: evidenceDigest(decision),
  } });
  return { decision, reference: { seq: row.seq, hash: row.hash } };
}

/** Trusted host enrollment, invoked only by the registered plugin. The test
 * seam supplies a parsed request through the same host context. */
export function registerExperiment(ctx: HostContext, manifest: unknown, request: unknown): ExperimentRuntime {
  const gate = ctx.inject<GateRegistry>("verify");
  if (typeof gate.decideExperiment !== "function") throw new Error("experiment requires registered pure gate policy");
  const binding = resolveCondition(manifest, request), digest = evidenceDigest(binding);
  if (runtimes.has(ctx.log)) throw new Error("experiment runtime already registered");
  const prior = projectExperimentCondition(ctx.log.events);
  if (prior.bindingDigest && prior.bindingDigest !== digest) throw new Error("experiment condition cannot change on resume");
  if (!prior.binding && ctx.log.events.some(event => /^(provider\/request|tool\/call|fixture\/|work\/(?:case|execution|goal|run_result)|swarm\/dispatch)/u.test(event.name))) throw new Error("experiment must bind before action");
  ensureObservationSchema(ctx.log);
  ctx.log.appendBatchDurable(() => [
    { kind: "observe", name: "experiment/bind", payload: binding },
    { kind: "observe", name: "eval/ablation", payload: { binding_digest: digest, links: binding.resolved.removed } },
  ]);
  let active = true;
  const assertActive = () => {
    if (!active || ctx.log.isReadOnly) throw new Error("experiment runtime is unavailable");
    ctx.log.assertCanRequestModel();
    if (projectExperimentCondition(ctx.log.events).bindingDigest !== digest) throw new Error("experiment binding changed");
  };
  const runtime: ExperimentRuntime = Object.freeze<ExperimentRuntime>({ binding,
    enabled(factor) { assertActive(); return !binding.resolved.removed.includes(factor); },
    record(input) {
      assertActive();
      const facts = structuredClone(input), decisions = gate.decideExperiment(facts, binding.resolved.removed);
      for (const fact of facts) {
        if (fact.status !== "not_evaluated" && !fact.sources.length) throw new Error("evaluated factor lacks observations");
        if (fact.status !== "not_evaluated") throw new Error("evaluated factor requires raw policy derivation");
        for (const source of fact.sources) {
        if (!ctx.log.events.some(row => row.seq === source.seq && row.hash === source.hash)) throw new Error("factor observation source is unavailable");
        }
      }
      ctx.log.appendDurable({ kind: "observe", name: "experiment/factors", payload: {
        binding_digest: digest, facts, facts_digest: evidenceDigest(facts), decisions,
      } });
    },
  });
  runtimes.set(ctx.log, runtime);
  ctx.effect(() => () => { active = false; if (runtimes.get(ctx.log) === runtime) runtimes.delete(ctx.log); });
  return runtime;
}

export const plugin: PluginModule = {
  id: "experiment-runtime",
  claims: [{ key: "verify", role: "consumer" }, { key: "experiment", role: "definition" }, { key: "experiment", role: "provider" }],
  // The registration refusals, checked by every boot before register and by
  // its prepare phase (#230 round 3, D1').
  preflight(ctx) {
    if (ctx.log.isReadOnly) {
      if (!projectExperimentCondition(ctx.log.events).binding) throw new Error("observer experiment binding missing");
      return;
    }
    const { path, request } = experimentRequestFromEnv();
    // The condition registration would bind, resolved without binding it.
    resolveCondition(JSON.parse(readFileSync(path, "utf8")), request);
  },
  register(ctx) {
    if (ctx.log.isReadOnly) {
      const binding = projectExperimentCondition(ctx.log.events).binding;
      if (!binding) throw new Error("observer experiment binding missing");
      ctx.define("experiment", { visibility: "host_only", truth: "event_log", schema: 1 });
      ctx.provide("experiment", Object.freeze({ binding, enabled() { throw new Error("observer cannot act"); }, record() { throw new Error("observer cannot record"); } }));
      return;
    }
    const { path, request } = experimentRequestFromEnv();
    const runtime = registerExperiment(ctx, JSON.parse(readFileSync(path, "utf8")), request);
    ctx.define("experiment", { visibility: "host_only", truth: "event_log", schema: 1 });
    ctx.provide("experiment", runtime);
  },
};
