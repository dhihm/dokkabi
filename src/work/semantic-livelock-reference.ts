import type { EventRecord } from "../host/schema.ts";
import {
  parseRecordedSemanticLivelock,
  parseSemanticLivelockClear,
  parseSemanticLivelockRefusal,
} from "./semantic-livelock-codec.ts";
import {
  validateRecordedSemanticLivelock,
  validateRecordedSemanticLivelockClear,
  validateRecordedSemanticLivelockRefusal,
} from "./semantic-livelock-recorded.ts";
import { semanticLivelockValidation } from "./semantic-livelock-validation.ts";

export interface SemanticLivelockDetectedReference {
  readonly seq: number;
  readonly name: "detected";
  readonly todo: string;
  readonly case_id: string;
  readonly attempts: number;
  readonly failure_digest: string;
  readonly footprint_digest: string;
  readonly case_digest: string;
  readonly plan_digest: string;
  readonly trigger_seq: number;
  readonly decision: string;
}

interface SemanticLivelockClearedBase {
  readonly seq: number;
  readonly name: "cleared";
  readonly todo: string;
  readonly case_id: string;
}

export type SemanticLivelockClearedReference =
  | SemanticLivelockClearedBase & {
      readonly reason: "case_progress";
      readonly cause_seq: number;
      readonly case_status: "green" | "red";
      readonly case_exit_code: number;
      readonly cause_case_digest: string;
      readonly cause_failure_digest?: string;
    }
  | SemanticLivelockClearedBase & {
      readonly reason: "plan_changed";
      readonly cause_seq: number;
      readonly cause_plan_digest: string;
    };

export interface SemanticLivelockRefusedReference {
  readonly seq: number;
  readonly name: "refused";
  readonly todo: string;
  readonly case_id: string;
  readonly plan_digest: string;
  readonly step_seq: number;
  readonly decision: "refuse_implementation";
}

export type SemanticLivelockReference =
  | SemanticLivelockDetectedReference
  | SemanticLivelockClearedReference
  | SemanticLivelockRefusedReference;

function sameDetection(
  left: ReturnType<typeof parseRecordedSemanticLivelock>,
  right: ReturnType<typeof parseRecordedSemanticLivelock>,
): boolean {
  return !!left && !!right && left.todo === right.todo && left.caseId === right.caseId
    && left.attempts === right.attempts && left.failureDigest === right.failureDigest
    && left.footprintDigest === right.footprintDigest && left.caseDigest === right.caseDigest
    && left.planDigest === right.planDigest && left.triggerSeq === right.triggerSeq;
}

export function projectSemanticLivelockReferences(
  events: readonly EventRecord[],
  featureStart: number | undefined,
): SemanticLivelockReference[] {
  if (featureStart === undefined) return [];
  return events.flatMap((event, index): SemanticLivelockReference[] => {
    if (event.seq < featureStart) return [];
    if (event.name === "livelock/cleared") {
      const clear = parseSemanticLivelockClear(event);
      if (!clear) throw new Error(`invalid semantic livelock clear at seq ${event.seq}`);
      const validation = semanticLivelockValidation(events, featureStart);
      const validated = validateRecordedSemanticLivelockClear(events, index, featureStart);
      const cause = validation.clearCauses.get(index);
      if (!validated || validated.todo !== clear.todo || validated.caseId !== clear.caseId
        || validated.reason !== clear.reason || !cause) {
        throw new Error(`semantic livelock clear without detection at seq ${event.seq}`);
      }
      const base: SemanticLivelockClearedBase = {
        seq: event.seq,
        name: "cleared",
        todo: clear.todo,
        case_id: clear.caseId,
      };
      if (cause.reason === "plan_changed") {
        return [{
          ...base,
          reason: cause.reason,
          cause_seq: cause.seq,
          cause_plan_digest: cause.planDigest,
        }];
      }
      return [{
        ...base,
        reason: cause.reason,
        cause_seq: cause.progress.seq,
        case_status: cause.progress.status,
        case_exit_code: cause.progress.exitCode,
        cause_case_digest: cause.progress.caseDigest,
        ...(cause.progress.failureDigest
          ? { cause_failure_digest: cause.progress.failureDigest }
          : {}),
      }];
    }
    if (event.name === "livelock/refused") {
      const refusal = parseSemanticLivelockRefusal(event);
      if (!refusal) throw new Error(`invalid semantic livelock refusal at seq ${event.seq}`);
      const validated = validateRecordedSemanticLivelockRefusal(events, index, featureStart);
      if (!validated || validated.todo !== refusal.todo || validated.caseId !== refusal.caseId
        || validated.planDigest !== refusal.planDigest || validated.stepSeq !== refusal.stepSeq
        || validated.decision !== refusal.decision) {
        throw new Error(`semantic livelock refusal without active detection at seq ${event.seq}`);
      }
      return [{
        seq: event.seq,
        name: "refused",
        todo: refusal.todo,
        case_id: refusal.caseId,
        plan_digest: refusal.planDigest,
        step_seq: refusal.stepSeq,
        decision: refusal.decision,
      }];
    }
    if (event.name !== "livelock/detected") return [];
    const detection = parseRecordedSemanticLivelock(event);
    if (!detection) throw new Error(`invalid semantic livelock event at seq ${event.seq}`);
    if (!sameDetection(detection, validateRecordedSemanticLivelock(events, index, featureStart))) {
      throw new Error(`semantic livelock evidence mismatch at seq ${event.seq}`);
    }
    return [{
      seq: event.seq,
      name: "detected",
      todo: detection.todo,
      case_id: detection.caseId,
      attempts: detection.attempts,
      failure_digest: detection.failureDigest,
      footprint_digest: detection.footprintDigest,
      case_digest: detection.caseDigest,
      plan_digest: detection.planDigest,
      trigger_seq: detection.triggerSeq,
      decision: "refuse_implementation",
    }];
  });
}
