import type { GateRegistry } from "../gate/registry.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { HostContext, ArtifactContributionRegistry, EvaluationRegistry, EvaluationRun, Evaluator } from "../../loader/types.ts";
import { canonicalJson } from "../../host/canonical.ts";
import { BlobStore } from "../../host/blob-store.ts";
import { evidenceDigest, evidencePolicyV2, freezeEvidence } from "./contract.ts";
import { contextSchema, evaluationRequestSchema, evaluatorDescriptorSchema, resultSchema, type EvaluationContextV2, type EvaluatorDescriptorV2, type EvaluationDispatchV2, type GateEvidenceInputV2 } from "./schema.ts";

const fileDigest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
function implementationDigest(descriptor: EvaluatorDescriptorV2): string {
  return evidenceDigest({
    module: fileDigest(descriptor.module_path),
    dependencies: descriptor.dependency_paths.map(fileDigest),
  });
}
function recordedDescriptor(descriptor: EvaluatorDescriptorV2) {
  return { id: descriptor.id, role: descriptor.role, phases: descriptor.phases, audiences: descriptor.audiences, isolation: descriptor.isolation,
    implementation_digest: implementationDigest(descriptor), config_digest: evidenceDigest(descriptor.config) };
}

export function createEvaluationRegistry(ctx: HostContext, artifacts: ArtifactContributionRegistry): EvaluationRegistry {
  const decideEvidence = ctx.get<GateRegistry>("verify").decideEvidence;
  let active = true;
  const entries = new Map<string, { descriptor: EvaluatorDescriptorV2; evaluate: Evaluator; generation: number; identity: ReturnType<typeof recordedDescriptor> }>();
  const record = (name: string, body: unknown, payload?: Record<string, unknown>) => artifacts.record({ kind: "evidence-record-v2", name, body, payload });
  function frozenContext(raw: unknown): EvaluationContextV2 {
    const context = contextSchema.parse(raw);
    const { context_ref, ...body } = context;
    const bytes = BlobStore.forSession(ctx.log.path).get(context_ref.blob);
    if (context_ref.digest !== evidenceDigest(body) || context_ref.blob !== context_ref.digest || context_ref.blobBytes !== Buffer.byteLength(bytes) || bytes !== canonicalJson(body)) throw new Error("context_body_mismatch");
    if (!ctx.log.events.some(event => event.name === "evaluation/context" && event.payload.blob === context_ref.blob && event.payload.digest === context_ref.digest && event.payload.blob_bytes === context_ref.blobBytes && event.payload.artifact === context_ref.kind)) throw new Error("context_not_recorded");
    for (const ref of [context.candidate_ref, context.contract_ref, ...(context.authority.kind === "terminal_research" ? [context.authority.terminal_artifact_ref] : [])]) {
      if (fileDigest(ref.path) !== ref.digest) throw new Error("context_source_changed");
    }
    return freezeEvidence(context);
  }
  function refusal(status: "refused" | "unavailable", reason: string, executionId?: string): EvaluationRun {
    ctx.log.append({ kind: "observe", name: "evaluation/refused", payload: { status, reason_code: reason, ...(executionId ? { execution_id: executionId } : {}) } });
    return { status, reason_code: reason };
  }
  async function dispatch(raw: unknown, readContext: () => unknown): Promise<EvaluationRun> {
    if (ctx.log.isReadOnly) throw new Error("evaluation execution unavailable in replay");
    if (!active) return refusal("unavailable", "evaluation_runtime_unloaded");
    const parsed = evaluationRequestSchema.safeParse(raw);
    if (!parsed.success) return refusal("refused", "malformed_request");
    const request = freezeEvidence(parsed.data);
    const entry = entries.get(request.evaluator_id);
    if (!entry) return refusal("unavailable", "evaluator_unavailable");
    let context: EvaluationContextV2;
    try { context = frozenContext(readContext()); }
    catch { return refusal("refused", "context_unavailable_or_changed"); }
    const authority = context.authority;
    if (request.input_ref !== context.context_ref.digest || request.contract_ref !== context.contract_ref.digest) return refusal("refused", "context_mismatch");
    if (entry.descriptor.role !== authority.role || !entry.descriptor.phases.includes(authority.phase) || !entry.descriptor.audiences.includes(authority.audience)
      || (entry.descriptor.role === "hidden_research_oracle" && authority.kind !== "terminal_research")) return refusal("refused", "role_phase_mismatch");
    try { if (evidenceDigest(recordedDescriptor(entry.descriptor)) !== evidenceDigest(entry.identity)) return refusal("refused", "evaluator_source_changed"); }
    catch { return refusal("refused", "evaluator_source_changed"); }
    const sequence = ctx.log.events.length;
    const runnerDigest = fileDigest(process.execPath);
    const dispatch: EvaluationDispatchV2 = freezeEvidence({
      dispatch_id: `dispatch-${sequence}`, execution_id: `execution-${sequence}`,
      contract_ref: request.contract_ref, input_ref: request.input_ref,
      runner_digest: runnerDigest, evaluator_id: entry.descriptor.id,
      evaluator_descriptor_digest: evidenceDigest(entry.identity), evaluator_implementation_digest: entry.identity.implementation_digest,
      evaluator_config_digest: entry.identity.config_digest, evaluator_lifecycle_generation: entry.generation,
      evidence_level: context.requirements.evidence_level, expected_metric: context.requirements.metric,
    });
    record("evaluation/dispatch", dispatch, { execution_id: dispatch.execution_id });
    let result;
    try {
      result = resultSchema.parse(await entry.evaluate(freezeEvidence({ ...request, dispatch })));
      if (entries.get(request.evaluator_id) !== entry) return refusal("refused", "evaluator_unloaded_during_execution", dispatch.execution_id);
      if (evidenceDigest(frozenContext(readContext())) !== evidenceDigest(context)) return refusal("refused", "context_changed_during_execution", dispatch.execution_id);
      if (evidenceDigest(recordedDescriptor(entry.descriptor)) !== evidenceDigest(entry.identity) || runnerDigest !== fileDigest(process.execPath)) return refusal("refused", "evaluator_changed_during_execution", dispatch.execution_id);
    } catch { return refusal("refused", "evaluator_error", dispatch.execution_id); }
    const resultRef = artifacts.record({ kind: "evaluation-result-v2", name: "evaluation/result", body: result, payload: { execution_id: dispatch.execution_id } });
    const receipt = freezeEvidence({
      receipt_id: `receipt-${sequence}`, dispatch_id: dispatch.dispatch_id, execution_id: dispatch.execution_id,
      context_digest: context.context_ref.digest, candidate_digest: context.candidate_ref.digest, contract_digest: context.contract_ref.digest,
      runner_digest: dispatch.runner_digest, policy_digest: evidencePolicyV2.digest, evaluator_id: dispatch.evaluator_id,
      evaluator_descriptor_digest: dispatch.evaluator_descriptor_digest, evaluator_implementation_digest: dispatch.evaluator_implementation_digest,
      evaluator_config_digest: dispatch.evaluator_config_digest, evaluator_lifecycle_generation: dispatch.evaluator_lifecycle_generation,
      evidence_level: dispatch.evidence_level, metric: result.metric, outcome: result.outcome,
      body: { ...resultRef, kind: "evaluation-result-v2" as const },
    });
    record("evaluation/receipt", receipt, { receipt_id: receipt.receipt_id, execution_id: receipt.execution_id });
    const input: GateEvidenceInputV2 = freezeEvidence({ schema_version: 2, policy: evidencePolicyV2, context, dispatch, receipt });
    record("evidence/input", input, { receipt_id: receipt.receipt_id });
    const decision = freezeEvidence(decideEvidence(input));
    record("evidence/decision", decision, { receipt_id: receipt.receipt_id, status: decision.status, evidence_level: receipt.evidence_level, audience: authority.audience, reason_codes: decision.reason_codes });
    return { status: "completed", input, receipt, decision };
  }
  return Object.freeze({
    register(raw: EvaluatorDescriptorV2, evaluate: Evaluator) {
      if (ctx.log.isReadOnly || !active) throw new Error("evaluation registration unavailable in replay or after unload");
      const descriptor = freezeEvidence(evaluatorDescriptorSchema.parse(raw));
      if (entries.has(descriptor.id)) throw new Error("duplicate evaluator");
      if (new Set(descriptor.dependency_paths).size !== descriptor.dependency_paths.length) throw new Error("duplicate evaluator dependency");
      const generation = 1 + ctx.log.events.filter(event => event.name === "evaluation/enrolled" && event.payload.evaluator_id === descriptor.id).length;
      const identity = freezeEvidence(recordedDescriptor(descriptor));
      const entry = { descriptor, evaluate, generation, identity };
      record("evaluation/enrolled", identity, { evaluator_id: descriptor.id, generation });
      entries.set(descriptor.id, entry);
      return () => {
        if (entries.get(descriptor.id) !== entry) return;
        // Revocation must take effect even if its observation cannot be persisted.
        entries.delete(descriptor.id);
        ctx.log.append({ kind: "observe", name: "evaluation/unloaded", payload: { evaluator_id: descriptor.id, generation } });
      };
    },
    list() {
      const order = new Set(ctx.log.events.filter(event => event.name === "evaluation/enrolled").map(event => String(event.payload.evaluator_id)));
      return [...order].flatMap(id => { const entry = entries.get(id); return entry ? [entry.descriptor] : []; });
    },
    dispose() {
      if (!active) return;
      active = false;
      const revoked = [...entries.values()]; entries.clear();
      for (const entry of revoked) ctx.log.append({ kind: "observe", name: "evaluation/unloaded", payload: { evaluator_id: entry.descriptor.id, generation: entry.generation } });
    },
    dispatch(raw: unknown) {
      return dispatch(raw, () => {
        const source = ctx.tryGet<{ current(): unknown }>("evaluation_context_source");
        if (!source) throw new Error("context_unavailable");
        return source.current();
      });
    },
    dispatchForContext(raw: unknown, supplied: EvaluationContextV2) {
      if (ctx.log.isReadOnly) throw new Error("evaluation execution unavailable in replay");
      // Parsing copies the supplied body; concurrent host calls cannot replace
      // another dispatch's expectations or mutate them after dispatch begins.
      let context: EvaluationContextV2;
      try { context = freezeEvidence(contextSchema.parse(supplied)); }
      catch { return Promise.resolve(refusal("refused", "context_unavailable_or_changed")); }
      return dispatch(raw, () => context);
    },
  });
}
