import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord } from "../../host/schema.ts";
import { decideEvidence, evidenceDigest } from "./contract.ts";
import { enrollmentSchema, contextBodySchema, dispatchSchema, receiptSchema, resultSchema, gateEvidenceInputV2Schema, evidenceDecisionV2Schema, idSchema, type GateEvidenceInputV2, type EvidenceDecisionV2 } from "./schema.ts";

export type EvidenceBodies = ReadonlyMap<string, unknown>;
export const EVIDENCE_BODY_EVENTS = new Set(["evaluation/context", "evaluation/enrolled", "evaluation/dispatch", "evaluation/result", "evaluation/receipt", "evidence/input", "evidence/decision"]);
export type EvidenceReference = { readonly seq: number; readonly name: string; readonly payload: Readonly<Record<string, unknown>> };
export const isEvidenceEvent = (name: string): boolean => name.startsWith("evidence/") || name.startsWith("evaluation/");
const refusalSchema = z.strictObject({ status: z.enum(["refused", "unavailable"]), reason_code: idSchema, execution_id: idSchema.optional() });
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** No filesystem, model, evaluator or recorded verdict is a policy input. */
export function projectEvidence(events: readonly EventRecord[], bodies: EvidenceBodies = new Map()): { inputs: GateEvidenceInputV2[]; decisions: EvidenceDecisionV2[]; references: EvidenceReference[] } {
  const inputs: GateEvidenceInputV2[] = [], decisions: EvidenceDecisionV2[] = [];
  const contexts = new Map<string, unknown>(), dispatches = new Map<string, unknown>();
  const results = new Map<string, { body: unknown; event: EventRecord }>();
  const receipts = new Map<string, unknown>(), consumed = new Map<string, GateEvidenceInputV2>();
  const references: EvidenceReference[] = [];
  const receiptExecutions = new Set<string>(), dispatchIds = new Set<string>(), terminated = new Set<string>();
  const decided = new Set<string>();
  const enrolled = new Map<string, { body: ReturnType<typeof enrollmentSchema.parse>; generation: number }>();
  const generations = new Map<string, number>();
  let previousSeq = -1;
  for (const event of events) {
    if (!isEvidenceEvent(event.name)) continue;
    if (event.seq <= previousSeq) throw new Error("evidence event order is invalid");
    previousSeq = event.seq;
    if (isEvidenceEvent(event.name)) {
      if (event.kind !== "observe") throw new Error("evidence requires an observe event");
      references.push({ seq: event.seq, name: event.name, payload: structuredClone(event.payload) });
    }
    if (event.name === "evaluation/refused") {
      const refusal = refusalSchema.parse(event.payload);
      if (refusal.execution_id) {
        if (!dispatches.has(refusal.execution_id) || terminated.has(refusal.execution_id) || results.has(refusal.execution_id)) throw new Error("evidence execution refusal has no pending dispatch");
        terminated.add(refusal.execution_id);
      }
      continue;
    }
    if (event.name === "evaluation/unloaded") {
      const id = event.payload.evaluator_id, entry = typeof id === "string" ? enrolled.get(id) : undefined;
      if (event.kind !== "observe" || !entry || event.payload.generation !== entry.generation) throw new Error("evaluator unload generation mismatch");
      enrolled.delete(entry.body.id);
      continue;
    }
    if (!EVIDENCE_BODY_EVENTS.has(event.name)) {
      if (isEvidenceEvent(event.name)) throw new Error("unknown evidence event");
      continue;
    }
    if (event.kind !== "observe") throw new Error("evidence requires an observe event");
    const { blob, digest, blob_bytes } = event.payload;
    if (typeof blob !== "string" || !bodies.has(blob)) throw new Error("evidence body blob missing");
    const raw = bodies.get(blob), bytes = canonicalJson(raw);
    if (evidenceDigest(raw) !== blob || digest !== blob || Buffer.byteLength(bytes) !== blob_bytes) throw new Error("evidence body blob integrity mismatch");
    if (event.name === "evaluation/enrolled") {
      const body = enrollmentSchema.parse(raw), generation = event.payload.generation;
      if (event.payload.evaluator_id !== body.id || enrolled.has(body.id) || generation !== (generations.get(body.id) ?? 0) + 1) throw new Error("evaluator enrollment generation mismatch");
      generations.set(body.id, generation);
      enrolled.set(body.id, { body, generation });
    } else if (event.name === "evaluation/context") {
      const body = contextBodySchema.parse(raw);
      contexts.set(blob, { body, event });
    } else if (event.name === "evaluation/dispatch") {
      const dispatch = dispatchSchema.parse(raw);
      if (dispatchIds.has(dispatch.dispatch_id)) throw new Error("duplicate evidence dispatch id");
      dispatchIds.add(dispatch.dispatch_id);
      if (dispatches.has(dispatch.execution_id)) throw new Error("duplicate evidence execution dispatch");
      if (event.payload.execution_id !== dispatch.execution_id) throw new Error("evidence dispatch execution mismatch");
      const context = contexts.get(dispatch.input_ref) as { body: ReturnType<typeof contextBodySchema.parse> } | undefined;
      if (!context) throw new Error("evidence dispatch context missing");
      const entry = enrolled.get(dispatch.evaluator_id);
      if (!entry || entry.generation !== dispatch.evaluator_lifecycle_generation || evidenceDigest(entry.body) !== dispatch.evaluator_descriptor_digest
        || entry.body.implementation_digest !== dispatch.evaluator_implementation_digest || entry.body.config_digest !== dispatch.evaluator_config_digest) throw new Error("evaluator enrollment missing or mismatched");
      const authority = context.body.authority;
      if (entry.body.role !== authority.role || !entry.body.phases.includes(authority.phase) || !entry.body.audiences.includes(authority.audience)) throw new Error("evaluator role/phase mismatch");
      dispatches.set(dispatch.execution_id, dispatch);
    } else if (event.name === "evaluation/result") {
      resultSchema.parse(raw);
      if (typeof event.payload.execution_id !== "string") throw new Error("evidence result execution missing");
      if (!dispatches.has(event.payload.execution_id) || terminated.has(event.payload.execution_id)) throw new Error("evidence result has no prior dispatch");
      if (results.has(event.payload.execution_id)) throw new Error("duplicate evidence result");
      results.set(event.payload.execution_id, { body: raw, event });
    } else if (event.name === "evaluation/receipt") {
      const receipt = receiptSchema.parse(raw);
      if (event.payload.receipt_id !== receipt.receipt_id || event.payload.execution_id !== receipt.execution_id) throw new Error("evidence receipt execution mismatch");
      const entry = enrolled.get(receipt.evaluator_id);
      if (!entry || entry.generation !== receipt.evaluator_lifecycle_generation) throw new Error("evaluator receipt has no active enrollment");
      if (!results.has(receipt.execution_id)) throw new Error("evidence receipt has no prior result");
      if (receipts.has(receipt.receipt_id)) throw new Error("conflicting receipt or duplicate receipt");
      if (receiptExecutions.has(receipt.execution_id)) throw new Error("duplicate execution receipt");
      receiptExecutions.add(receipt.execution_id);
      receipts.set(receipt.receipt_id, receipt);
    } else if (event.name === "evidence/input") {
      const input = gateEvidenceInputV2Schema.parse(raw), receipt = input.receipt;
      if (consumed.has(receipt.receipt_id)) throw new Error("duplicate receipt consumption");
      if (event.payload.receipt_id !== receipt.receipt_id || !same(receipts.get(receipt.receipt_id), receipt)) throw new Error("evidence input receipt mismatch");
      if (!same(dispatches.get(receipt.execution_id), input.dispatch)) throw new Error("evidence input dispatch mismatch");
      const context = contexts.get(input.context.context_ref.blob) as { body: unknown; event: EventRecord } | undefined;
      const { context_ref, ...contextBody } = input.context;
      if (!context || !same(context.body, contextBody) || context.event.payload.artifact !== context_ref.kind || context.event.payload.digest !== context_ref.digest || context.event.payload.blob_bytes !== context_ref.blobBytes) throw new Error("evidence input context mismatch");
      const result = results.get(receipt.execution_id);
      if (!result || result.event.payload.blob !== receipt.body.blob || result.event.payload.digest !== receipt.body.digest || result.event.payload.blob_bytes !== receipt.body.blobBytes || result.event.payload.artifact !== receipt.body.kind) throw new Error("evidence receipt result body mismatch");
      const parsedResult = resultSchema.parse(result.body);
      if (!same(parsedResult.metric, receipt.metric) || !same(parsedResult.outcome, receipt.outcome)) throw new Error("evidence receipt result mismatch");
      consumed.set(receipt.receipt_id, input);
      inputs.push(input);
    } else if (event.name === "evidence/decision") {
      const receiptId = event.payload.receipt_id;
      const input = typeof receiptId === "string" ? consumed.get(receiptId) : undefined;
      if (!input) throw new Error("evidence decision has no prior input");
      if (decided.has(input.receipt.receipt_id)) throw new Error("duplicate evidence decision");
      const recorded = evidenceDecisionV2Schema.parse(raw), computed = decideEvidence(input);
      if (!same(recorded, computed)) throw new Error("evidence decision disagrees with recomputed policy");
      decided.add(input.receipt.receipt_id);
      decisions.push(computed);
    }
  }
  if (inputs.length !== decisions.length || receipts.size !== consumed.size || receipts.size !== results.size || dispatches.size !== results.size + terminated.size) throw new Error("evidence receipt/input/decision incomplete");
  return { inputs, decisions, references };
}
