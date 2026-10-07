import type { EventRecord } from "../host/schema.ts";
import {
  eventText,
  parseExecutedSemanticCase,
  parseRecordedSemanticLivelock,
  parseSemanticLivelockClear,
  parseSemanticLivelockRefusal,
  type ExecutedSemanticCase,
  type SemanticLivelockClear,
  type SemanticLivelockRefusal,
} from "./semantic-livelock-codec.ts";
import { SemanticLivelockTracker } from "./semantic-livelock.ts";
import { SemanticPlanDefinitionTracker } from "./semantic-livelock-plan.ts";
import type { SemanticLivelockDetection } from "./semantic-livelock-types.ts";

export interface SemanticLivelockActiveDetection {
  readonly detection: SemanticLivelockDetection;
  readonly eventSeq: number;
  readonly scopeSeq: number;
  readonly goalId: string;
  readonly goalStatement: string;
  scopeChanged: boolean;
  planChange?: { readonly seq: number; readonly planDigest: string };
  progress?: ExecutedSemanticCase & { readonly seq: number };
}

export type SemanticLivelockClearCause =
  | {
      readonly reason: "case_progress";
      readonly progress: ExecutedSemanticCase & { readonly seq: number };
    }
  | {
      readonly reason: "plan_changed";
      readonly seq: number;
      readonly planDigest: string;
    };

export interface SemanticLivelockValidation {
  readonly detections: ReadonlyMap<number, SemanticLivelockDetection>;
  readonly clears: ReadonlyMap<number, SemanticLivelockClear>;
  readonly clearCauses: ReadonlyMap<number, SemanticLivelockClearCause>;
  readonly refusals: ReadonlyMap<number, SemanticLivelockRefusal>;
  readonly active: ReadonlyMap<string, SemanticLivelockActiveDetection>;
  readonly states: ReadonlyMap<string, SemanticLivelockActiveDetection>;
  readonly detectionRows: readonly {
    readonly index: number;
    readonly detection: SemanticLivelockDetection;
  }[];
  readonly currentGoalDigest?: string;
}

interface CachedValidation extends SemanticLivelockValidation {
  readonly length: number;
  readonly start: number;
  readonly terminalHash?: string;
}

const caches = new WeakMap<readonly EventRecord[], CachedValidation>();

function sameDetection(left: SemanticLivelockDetection, right: SemanticLivelockDetection): boolean {
  return left.todo === right.todo && left.caseId === right.caseId
    && left.attempts === right.attempts && left.failureDigest === right.failureDigest
    && left.footprintDigest === right.footprintDigest && left.caseDigest === right.caseDigest
    && left.planDigest === right.planDigest && left.triggerSeq === right.triggerSeq;
}

function key(todo: string, caseId: string): string {
  return `${todo}\0${caseId}`;
}

function goalScopeSeq(event: EventRecord): number {
  const value = event.payload.scope_seq;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= event.seq
    ? value
    : event.seq;
}

function goalIdentity(event: EventRecord): { readonly id: string; readonly statement: string } | undefined {
  const id = eventText(event.payload.id);
  const statement = eventText(event.payload.statement);
  return id && statement ? { id, statement } : undefined;
}

function caseProgress(
  event: EventRecord,
  detection: SemanticLivelockDetection,
): ExecutedSemanticCase | undefined {
  const result = parseExecutedSemanticCase(event);
  return result && result.caseId === detection.caseId
    && result.caseDigest === detection.caseDigest
    && (result.status === "green" || result.failureDigest !== detection.failureDigest)
    ? result
    : undefined;
}

function removeCaseIndex(index: Map<string, Set<string>>, caseId: string, stateKey: string): void {
  const entries = index.get(caseId);
  entries?.delete(stateKey);
  if (entries?.size === 0) index.delete(caseId);
}

export function semanticLivelockValidation(
  events: readonly EventRecord[],
  start: number,
): SemanticLivelockValidation {
  const cached = caches.get(events);
  const terminalHash = events.at(-1)?.hash;
  if (cached?.length === events.length && cached.start === start
    && cached.terminalHash === terminalHash) return cached;

  const tracker = new SemanticLivelockTracker();
  const detections = new Map<number, SemanticLivelockDetection>();
  const clears = new Map<number, SemanticLivelockClear>();
  const clearCauses = new Map<number, SemanticLivelockClearCause>();
  const refusals = new Map<number, SemanticLivelockRefusal>();
  const lifecycle = new Map<string, SemanticLivelockActiveDetection>();
  const caseIndex = new Map<string, Set<string>>();
  const definitionTracker = new SemanticPlanDefinitionTracker();
  const detectionRows: { index: number; detection: SemanticLivelockDetection }[] = [];
  let priorGoalIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.seq < start && event.name === "work/goal") {
      priorGoalIndex = index;
      break;
    }
  }
  const priorGoal = priorGoalIndex >= 0 ? events[priorGoalIndex] : undefined;
  let currentGoalDigest = priorGoal ? eventText(priorGoal.payload.digest) : undefined;
  let currentDefinitionDigest = priorGoal
    ? eventText(priorGoal.payload.semantic_definition_digest)
    : undefined;
  let currentScopeSeq = priorGoal ? goalScopeSeq(priorGoal) : start;
  let currentGoalIdentity = priorGoal ? goalIdentity(priorGoal) : undefined;
  let currentGoalIndex = priorGoalIndex;
  let definitionBindingValid = true;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.seq < start) continue;
    if (event.name === "work/goal") definitionTracker.reset();
    else definitionTracker.push(event);
    if (event.name === "work/goal") {
      currentGoalDigest = eventText(event.payload.digest);
      currentDefinitionDigest = eventText(event.payload.semantic_definition_digest);
      currentScopeSeq = goalScopeSeq(event);
      currentGoalIdentity = goalIdentity(event);
      currentGoalIndex = index;
      definitionBindingValid = true;
      for (const state of lifecycle.values()) {
        if (currentScopeSeq !== state.scopeSeq) {
          state.scopeChanged = true;
        } else if (currentGoalDigest && currentGoalDigest !== state.detection.planDigest) {
          state.planChange ??= { seq: event.seq, planDigest: currentGoalDigest };
        } else if (currentGoalIdentity?.id !== state.goalId
          || currentGoalIdentity.statement !== state.goalStatement) {
          state.scopeChanged = true;
        }
      }
    } else if (event.name === "work/case"
      && (event.payload.status === "red" || event.payload.status === "green")) {
      const caseId = eventText(event.payload.id);
      for (const stateKey of caseId ? caseIndex.get(caseId) ?? [] : []) {
        const state = lifecycle.get(stateKey);
        if (!state || state.progress) continue;
        const progress = caseProgress(event, state.detection);
        if (progress) state.progress = { ...progress, seq: event.seq };
      }
    } else if (event.name === "livelock/detected") {
      const recorded = parseRecordedSemanticLivelock(event);
      const derived = recorded ? tracker.detection(recorded.todo, recorded.caseId) : undefined;
      if (recorded && recorded.triggerSeq < event.seq
        && derived && sameDetection(recorded, derived)
        && currentGoalIdentity && currentGoalDigest === recorded.planDigest
        && currentGoalIndex >= 0 && definitionBindingValid) {
        const definitions = definitionTracker.snapshot();
        if (!definitions || definitions.digest !== currentDefinitionDigest) {
          definitionBindingValid = false;
          tracker.push(event);
          continue;
        }
        const definition = definitions.cases.get(recorded.caseId);
        if (definition?.todo !== recorded.todo || definition.digest !== recorded.caseDigest) {
          tracker.push(event);
          continue;
        }
        detections.set(index, recorded);
        detectionRows.push({ index, detection: recorded });
        const stateKey = key(recorded.todo, recorded.caseId);
        lifecycle.set(stateKey, {
          detection: recorded,
          eventSeq: event.seq,
          scopeSeq: currentScopeSeq,
          goalId: currentGoalIdentity.id,
          goalStatement: currentGoalIdentity.statement,
          scopeChanged: false,
        });
        const entries = caseIndex.get(recorded.caseId) ?? new Set<string>();
        entries.add(stateKey);
        caseIndex.set(recorded.caseId, entries);
      }
    } else if (event.name === "livelock/cleared") {
      const clear = parseSemanticLivelockClear(event);
      const stateKey = clear ? key(clear.todo, clear.caseId) : undefined;
      const state = stateKey ? lifecycle.get(stateKey) : undefined;
      const planChange = clear?.reason === "plan_changed" ? state?.planChange : undefined;
      const progress = clear?.reason === "case_progress" ? state?.progress : undefined;
      if (clear && stateKey && state && !state.scopeChanged && (planChange || progress)) {
        clears.set(index, clear);
        if (planChange) {
          clearCauses.set(index, {
            reason: "plan_changed",
            seq: planChange.seq,
            planDigest: planChange.planDigest,
          });
        } else if (progress) {
          clearCauses.set(index, { reason: "case_progress", progress });
        }
        lifecycle.delete(stateKey);
        removeCaseIndex(caseIndex, clear.caseId, stateKey);
      }
    } else if (event.name === "livelock/refused") {
      const refusal = parseSemanticLivelockRefusal(event);
      const state = refusal ? lifecycle.get(key(refusal.todo, refusal.caseId)) : undefined;
      const step = events[index - 1];
      if (refusal && state && refusal.planDigest === state.detection.planDigest
        && currentGoalDigest === refusal.planDigest && !state.scopeChanged
        && !state.planChange && !state.progress
        && step?.seq === refusal.stepSeq && step.name === "work/step"
        && step.payload.action === "implement" && step.payload.todo === refusal.todo) {
        refusals.set(index, refusal);
      }
    }
    tracker.push(event);
  }

  const active = new Map([...lifecycle].filter(([, state]) =>
    !state.scopeChanged && !state.planChange && !state.progress));
  const built: CachedValidation = {
    length: events.length,
    start,
    ...(terminalHash ? { terminalHash } : {}),
    detections,
    clears,
    clearCauses,
    refusals,
    active,
    states: lifecycle,
    detectionRows,
    ...(currentGoalDigest ? { currentGoalDigest } : {}),
  };
  caches.set(events, built);
  return built;
}
