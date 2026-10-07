import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactContributionRegistry, EvaluationRegistry, PluginModule, WorkMeasurementInput, WorkMeasurementRun, WorkMeasurements } from "../../src/loader/types.ts";
import { matchingCaseRunner } from "../../src/work/case-runners.ts";
import { readEvidenceBodies } from "../../src/work/evidence/bodies.ts";
import { evidenceDigest, freezeEvidence } from "../../src/work/evidence/contract.ts";
import { caseMeasurementSchema, MEASUREMENT_SENSOR_V1, measurementSessionSchema, measurementChallengeSchema, measurementProcessSchema, measurementResultSchema, measurementSourceSchema, measurementBoundarySchema } from "../../src/work/evidence/measurements.ts";
import { MeasurementReplayError, projectMeasurements } from "../../src/work/evidence/measurement-projection.ts";
import { artifactRefSchema, contextBodySchema, type EvaluationContextV2 } from "../../src/work/evidence/schema.ts";
import { prepareBatchCase, BatchObservationError } from "./batch.ts";

/** Pin the host's local implementation closure, including the sandbox and fixture
 * readers. The candidate receives only the bounded prepared program, not this tree. */
function implementationFiles(root: string): string[] {
  const files: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:[cm]?ts|json)$/u.test(entry.name)) files.push(path);
    }
  }
  walk(join(root, "src")); walk(import.meta.dir);
  return files.filter(path => path !== import.meta.path);
}

export const plugin: PluginModule = {
  id: "evaluation-study",
  claims: [
    { key: "artifact_contributions", role: "consumer" },
    { key: "evaluation", role: "consumer" },
    { key: "work_measurements", role: "definition" },
    { key: "work_measurements", role: "provider" },
  ],
  activate() {
    return process.env.DOKKABI_EVALUATION_STUDY === "1"
      ? { active: true }
      : { active: false, reason: "evaluation_study_not_enabled", kind: "not_configured" };
  },
  register(ctx) {
    const artifacts = ctx.inject<ArtifactContributionRegistry>("artifact_contributions");
    const registry = ctx.inject<EvaluationRegistry>("evaluation");
    for (const [kind, schema] of [
      ["measurement-source-v1", measurementSourceSchema],
      ["measurement-boundary-v1", measurementBoundarySchema],
      ["measurement-session-v1", measurementSessionSchema],
      ["measurement-challenge-v1", measurementChallengeSchema],
      ["measurement-process-v1", measurementProcessSchema],
      ["measurement-result-v1", measurementResultSchema],
    ] as const) ctx.effect(() => artifacts.register(kind, { validate: value => schema.parse(value), digest: evidenceDigest }));
    let active = true;
    type Prepared = Awaited<ReturnType<typeof prepareBatchCase>>;
    const pending = new Map<string, { readonly prepared: Prepared; readonly context: EvaluationContextV2; failure?: BatchObservationError }>();
    // These are only in-flight invocation arguments for the one enrolled evaluator.
    // The existing registry retains enrollment, execution and receipt authority.
    ctx.effect(() => registry.register({
      id: MEASUREMENT_SENSOR_V1, role: "deployment_checker", phases: ["baseline", "implement"], audiences: ["deployment"], isolation: "process",
      module_path: import.meta.path, dependency_paths: implementationFiles(resolve(import.meta.dir, "../..")),
      config: { schema_version: 1, sensor: MEASUREMENT_SENSOR_V1, source_policy: "host-source-tree-v1" },
    }, async request => {
      const invocation = pending.get(request.input_ref);
      if (!active || !invocation) throw new Error("measurement_invocation_unavailable");
      if (request.contract_ref !== invocation.context.contract_ref.digest) throw new Error("measurement_invocation_mismatch");
      try { return await invocation.prepared.evaluate(request, invocation.context); }
      catch (error) { if (error instanceof BatchObservationError) invocation.failure = error; throw error; }
    }));
    ctx.effect(() => () => { active = false; });
    const refuse = (input: WorkMeasurementInput, status: "unavailable" | "evaluator_error", reason: string): WorkMeasurementRun => {
      ctx.log.append({ kind: "observe", name: "measurement/refused", payload: { case_id: input.caseId, status, reason_code: reason } });
      return { status, reason_code: reason };
    };
    const service: WorkMeasurements = Object.freeze({
      async evaluateCase(input: WorkMeasurementInput): Promise<WorkMeasurementRun> {
        if (ctx.log.isReadOnly) throw new Error("measurement execution unavailable in replay");
        if (!active) return refuse(input, "unavailable", "measurement_provider_unloaded");
        const definition = input.plan.cases.find(item => item.id === input.caseId);
        if (!definition) return refuse(input, "evaluator_error", "measurement_case_missing");
        const parsed = caseMeasurementSchema.safeParse(definition.measurement);
        if (!parsed.success) return refuse(input, "unavailable", "measurement_contract_unavailable");
        if (definition.host || definition.dir || definition.local_accelerator) return refuse(input, "unavailable", "measurement_isolation_unavailable");
        const timeoutMs = definition.timeout_ms ?? 30_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return refuse(input, "unavailable", "measurement_timeout_unsupported");
        if ([definition.done_when, definition.failed_when, definition.stall_after_ms, definition.telemetry_pattern].some(value => value !== undefined)) return refuse(input, "unavailable", "measurement_execution_controls_unsupported");
        const runner = matchingCaseRunner(definition.command);
        if (!runner || runner.measurementEvaluator !== MEASUREMENT_SENSOR_V1) return refuse(input, "unavailable", "measurement_evaluator_unavailable");
        const file = runner.testFile(definition.command);
        if (!file || definition.command.trim() !== `bun ${file}` || isAbsolute(file)) return refuse(input, "unavailable", "measurement_candidate_shape_unsupported");
        const candidatePath = resolve(input.cwd, file), rel = relative(resolve(input.cwd), candidatePath);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return refuse(input, "unavailable", "measurement_candidate_path_unsafe");
        let prepared: Prepared | undefined;
        let context: EvaluationContextV2 | undefined;
        let result: WorkMeasurementRun;
        try {
          prepared = await prepareBatchCase({ log: ctx.log, workspaceRoot: resolve(input.cwd), candidatePath: rel, caseId: input.caseId, contract: freezeEvidence(parsed.data), phase: input.phase,
            workRef: { plan_digest: evidenceDigest(input.plan), case_digest: evidenceDigest(definition), phase: input.phase }, timeoutMs });
          const body = contextBodySchema.parse({ schema_version: 2,
            authority: { kind: "deployment", phase: input.phase === "red" ? "baseline" : "implement", audience: "deployment", role: "deployment_checker" },
            candidate_ref: prepared.candidateRef, contract_ref: prepared.contractRef,
            requirements: { evidence_level: "execution", metric: { unit: "elements", source: "observer.correct_outputs" } },
          });
          context = freezeEvidence({ ...body, context_ref: artifacts.record({ kind: "evidence-record-v2", name: "evaluation/context", body }) });
          if (!active) throw new Error("measurement_provider_unloaded");
          if (pending.has(context.context_ref.digest)) throw new Error("measurement_context_collision");
          pending.set(context.context_ref.digest, { prepared, context });
          const evaluation = await registry.dispatchForContext({ evaluator_id: MEASUREMENT_SENSOR_V1, contract_ref: context.contract_ref.digest, input_ref: context.context_ref.digest }, context);
          if (evaluation.status !== "completed") {
            const failure = pending.get(context.context_ref.digest)?.failure;
            result = evaluation.reason_code === "evaluator_error" && failure
              ? refuse(input, failure.status, failure.code)
              : refuse(input, evaluation.status === "unavailable" ? "unavailable" : "evaluator_error", evaluation.reason_code);
          }
          else {
            const output = artifacts.read<{ output: unknown }>("evaluation-result-v2", evaluation.receipt.body.blob).output;
            if (!output || typeof output !== "object" || !("measurement_ref" in output)) throw new Error("measurement_result_missing");
            const measurement_ref = artifactRefSchema.parse(output.measurement_ref);
            if (measurement_ref.kind !== "measurement-result-v1") throw new Error("measurement_result_kind_mismatch");
            const projection = projectMeasurements(ctx.log.events, readEvidenceBodies(ctx.log));
            const decision = projection.decisions.find(item => item.execution_id === evaluation.receipt.execution_id);
            if (!decision || decision.receipt_id !== evaluation.receipt.receipt_id || decision.case_id !== input.caseId || decision.result_ref.digest !== measurement_ref.digest) throw new Error("measurement_projection_mismatch");
            result = freezeEvidence({ status: "completed", evaluation, measurement_ref, session_id: decision.session_id, decision });
          }
        } catch (error) {
          result = refuse(input, error instanceof BatchObservationError ? error.status : "evaluator_error", error instanceof BatchObservationError ? error.code : error instanceof MeasurementReplayError ? error.code : "measurement_evaluator_error");
        } finally {
          if (context) pending.delete(context.context_ref.digest);
        }
        try { await prepared?.close(); }
        catch { return refuse(input, "evaluator_error", "measurement_cleanup_failed"); }
        if (!active && result.status === "completed") return refuse(input, "unavailable", "measurement_provider_unloaded");
        return result;
      },
    });
    ctx.define("work_measurements", { visibility: "host_only", truth: "event_log", format: 1 });
    ctx.provide("work_measurements", service);
  },
};
