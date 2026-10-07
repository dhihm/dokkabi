import type { EventLog } from "../host/event-log.ts";
import { projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";
import { planDigest } from "./digest.ts";
import type { WorkPlan } from "./schema.ts";
import {
  parseRecordedSemanticLivelock,
  parseSemanticLivelockClear,
  parseSemanticLivelockRefusal,
} from "./semantic-livelock-codec.ts";
import { detectSemanticLivelocks } from "./semantic-livelock.ts";
import type { SemanticLivelockDetection } from "./semantic-livelock-types.ts";
import { semanticLivelockValidation } from "./semantic-livelock-validation.ts";
import { scopeWorkEvents, workCaseDigest } from "./scope.ts";

const FEATURE = "semantic-livelock-v1";

function featureStart(events: readonly EventRecord[]): number | undefined {
  return projectSessionReplaySchemas(events).featureStart.get(FEATURE);
}

function sameDetection(left: SemanticLivelockDetection, right: SemanticLivelockDetection): boolean {
  return left.todo === right.todo
    && left.caseId === right.caseId
    && left.attempts === right.attempts
    && left.failureDigest === right.failureDigest
    && left.footprintDigest === right.footprintDigest
    && left.caseDigest === right.caseDigest
    && left.planDigest === right.planDigest
    && left.triggerSeq === right.triggerSeq;
}

export function validateRecordedSemanticLivelock(
  events: readonly EventRecord[],
  index: number,
  start = featureStart(events),
): SemanticLivelockDetection | undefined {
  const event = events[index];
  if (!event || start === undefined || event.seq < start) return undefined;
  return semanticLivelockValidation(events, start).detections.get(index);
}

export function validateRecordedSemanticLivelockClear(
  events: readonly EventRecord[],
  index: number,
  start = featureStart(events),
): ReturnType<typeof parseSemanticLivelockClear> {
  const event = events[index];
  if (!event || start === undefined) return undefined;
  return semanticLivelockValidation(events, start).clears.get(index);
}

export function validateRecordedSemanticLivelockRefusal(
  events: readonly EventRecord[],
  index: number,
  start = featureStart(events),
): ReturnType<typeof parseSemanticLivelockRefusal> {
  const event = events[index];
  if (!event || start === undefined || event.seq < start) return undefined;
  return semanticLivelockValidation(events, start).refusals.get(index);
}

export function activeSemanticLivelock(
  events: readonly EventRecord[],
  plan: WorkPlan,
  todo: string,
  caseId?: string,
): SemanticLivelockDetection | undefined {
  const start = featureStart(events);
  if (start === undefined) return undefined;
  const currentPlan = planDigest(plan);
  const scopedSeqs = new Set(scopeWorkEvents(plan, events).map((event) => event.seq));
  if (scopedSeqs.size === 0) return undefined;
  const validation = semanticLivelockValidation(events, start);
  if (validation.currentGoalDigest !== currentPlan) return undefined;
  const ownedScenarios = new Map(plan.scenarios.map((scenario) => [scenario.id, scenario]));
  const ownedCases = new Map(plan.cases.flatMap((item) => {
    const scenario = ownedScenarios.get(item.scenario);
    return scenario?.todo === todo ? [[item.id, workCaseDigest(item, scenario)] as const] : [];
  }));
  return [...validation.active.values()].map((state) => state.detection).find((detection) =>
    scopedSeqs.has(detection.triggerSeq)
      && detection.planDigest === currentPlan && detection.todo === todo
      && ownedCases.get(detection.caseId) === detection.caseDigest
      && (!caseId || detection.caseId === caseId));
}

export function reconcileSemanticLivelocks(log: EventLog, plan: WorkPlan): void {
  const start = featureStart(log.events);
  if (start === undefined) return;
  const validation = semanticLivelockValidation(log.events, start);
  const scopedSeqs = new Set(scopeWorkEvents(plan, log.events).map((event) => event.seq));
  const latest = new Map<string, { eventSeq: number; detection: SemanticLivelockDetection }>();
  const cleared = new Map<string, number>();
  for (let index = 0; index < log.events.length; index += 1) {
    const event = log.events[index];
    if (!event || !scopedSeqs.has(event.seq)) continue;
    const detection = validation.detections.get(index);
    if (detection) latest.set(`${detection.todo}\0${detection.caseId}`, { eventSeq: event.seq, detection });
    const clear = validation.clears.get(index);
    if (clear) cleared.set(`${clear.todo}\0${clear.caseId}`, event.seq);
  }
  for (const [key, row] of latest) {
    if ((cleared.get(key) ?? 0) > row.eventSeq) continue;
    if (activeSemanticLivelock(log.events, plan, row.detection.todo, row.detection.caseId)) continue;
    const state = validation.states.get(key);
    if (!state || state.scopeChanged) continue;
    const reason = state.progress
      ? "case_progress"
      : state.planChange && validation.currentGoalDigest === planDigest(plan)
        ? "plan_changed"
        : undefined;
    if (!reason) continue;
    log.append({
      kind: "observe",
      name: "livelock/cleared",
      payload: {
        todo: row.detection.todo,
        case_id: row.detection.caseId,
        reason,
      },
    });
  }
}

export function recordSemanticLivelock(log: EventLog, plan: WorkPlan): SemanticLivelockDetection | undefined {
  const start = featureStart(log.events);
  if (start === undefined) return undefined;
  const events = scopeWorkEvents(plan, log.events).filter((event) => event.seq >= start);
  const detections = detectSemanticLivelocks(events);
  let latestEligible: SemanticLivelockDetection | undefined;
  for (const detection of detections) {
    const item = plan.cases.find((candidate) => candidate.id === detection.caseId);
    const scenario = item
      ? plan.scenarios.find((candidate) => candidate.id === item.scenario)
      : undefined;
    if (!item || scenario?.todo !== detection.todo
      || workCaseDigest(item, scenario) !== detection.caseDigest) continue;
    latestEligible = detection;
    const exists = log.events.some((event) => {
      const recorded = parseRecordedSemanticLivelock(event);
      return recorded && sameDetection(recorded, detection);
    });
    if (exists) continue;
    log.append({
      kind: "observe",
      name: "livelock/detected",
      payload: {
        todo: detection.todo,
        case_id: detection.caseId,
        attempts: detection.attempts,
        failure_digest: detection.failureDigest,
        footprint_digest: detection.footprintDigest,
        case_digest: detection.caseDigest,
        plan_digest: detection.planDigest,
        trigger_seq: detection.triggerSeq,
        decision: "refuse_implementation",
      },
    });
  }
  return latestEligible;
}
