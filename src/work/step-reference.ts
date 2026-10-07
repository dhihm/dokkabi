import type { EventRecord } from "../host/schema.ts";

/**
 * The replay projection for one isolated work step (#77 T7).
 *
 * A step's evidence is spread across four rows — the slot it was handed, the
 * child session that ran it, the patch it returned, and the gate verdict that
 * accepted or refused it. The replay contract's evidence digest covers event
 * names and order only, so without this projection a log whose recorded patch
 * digest was swapped for a different one would replay clean.
 *
 * Digest-only, like every other reference in the contract: replay projects
 * what a step did, it never re-runs the step or reads its blobs.
 */

export interface WorkStepReferenceV1 {
  step_id: string;
  input_digest: string;
  patch_digest: string;
  child_session: string;
  child_final_hash: string;
  child_replay_digest: string;
  status: string;
  reason_code: string;
  gates: string[];
  failed: string[];
}

const MISSING = "missing";

function text(value: unknown): string {
  return typeof value === "string" ? value : MISSING;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function blank(stepId: string): WorkStepReferenceV1 {
  return {
    step_id: stepId,
    input_digest: MISSING,
    patch_digest: MISSING,
    child_session: MISSING,
    child_final_hash: MISSING,
    child_replay_digest: MISSING,
    status: MISSING,
    reason_code: MISSING,
    gates: [],
    failed: [],
  };
}

/**
 * `featureStart` is the seq of the session/open that declared
 * `work-step-v1`. Rows before it belong to a log this host must not
 * reinterpret under mesh semantics, so they are not projected.
 */
export function projectWorkStepReferences(
  events: readonly EventRecord[],
  featureStart: number | undefined,
): WorkStepReferenceV1[] {
  if (featureStart === undefined) return [];
  const order: string[] = [];
  const byStep = new Map<string, WorkStepReferenceV1>();

  const slot = (stepId: string): WorkStepReferenceV1 => {
    const existing = byStep.get(stepId);
    if (existing) return existing;
    const created = blank(stepId);
    byStep.set(stepId, created);
    order.push(stepId);
    return created;
  };

  for (const event of events) {
    if (event.seq < featureStart) continue;
    const stepId = event.payload.step_id;
    if (typeof stepId !== "string") continue;
    if (event.name === "work/step_input") {
      slot(stepId).input_digest = text(event.payload.digest);
      continue;
    }
    if (event.name === "work/step_session") {
      const row = slot(stepId);
      row.child_session = text(event.payload.child_session);
      row.child_final_hash = text(event.payload.final_hash);
      row.child_replay_digest = text(event.payload.replay_digest);
      continue;
    }
    if (event.name === "work/step_patch") {
      slot(stepId).patch_digest = text(event.payload.digest);
      continue;
    }
    if (event.name === "verify/decision") {
      const row = slot(stepId);
      row.status = text(event.payload.status);
      row.reason_code = text(event.payload.reason_code);
      row.gates = names(event.payload.gates);
      row.failed = names(event.payload.failed);
      continue;
    }
    if (event.name === "work/step_refused") {
      const row = slot(stepId);
      // A refusal is a verdict too. Left as `missing` it would be
      // indistinguishable from a step whose gate never ran.
      row.status = "refused";
      row.reason_code = "step_refused";
    }
  }
  return order.map((stepId) => byStep.get(stepId)!);
}
