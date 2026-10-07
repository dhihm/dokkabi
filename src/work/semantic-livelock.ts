import type { EventRecord } from "../host/schema.ts";
import {
  openSemanticAttempt,
  parseExecutedSemanticCase,
  parseSemanticStepInput,
  type SemanticAttempt,
} from "./semantic-livelock-codec.ts";
import {
  SEMANTIC_LIVELOCK_ATTEMPTS,
  type SemanticLivelockDetection,
} from "./semantic-livelock-types.ts";

interface Miss {
  readonly todo: string;
  readonly caseId: string;
  readonly planDigest: string;
  readonly footprintDigest: string;
  readonly failureDigest?: string;
  readonly caseDigest?: string;
  readonly triggerSeq: number;
  readonly evidenceVersion: number;
  readonly qualifying: boolean;
}

function closeAttempt(attempt: SemanticAttempt, evidenceVersion: number): Miss[] {
  return attempt.cases.map((caseId) => {
    const event = attempt.results.get(caseId);
    const result = event ? parseExecutedSemanticCase(event) : undefined;
    return {
      todo: attempt.todo,
      caseId,
      planDigest: attempt.planDigest,
      footprintDigest: attempt.footprintDigest,
      ...(result?.failureDigest ? { failureDigest: result.failureDigest } : {}),
      ...(result?.caseDigest ? { caseDigest: result.caseDigest } : {}),
      triggerSeq: event?.seq ?? 0,
      evidenceVersion,
      qualifying: attempt.minor && result?.status === "red",
    };
  });
}

function sameMiss(left: Miss, right: Miss): boolean {
  return left.qualifying && right.qualifying
    && left.todo === right.todo
    && left.caseId === right.caseId
    && left.planDigest === right.planDigest
    && left.footprintDigest === right.footprintDigest
    && left.failureDigest === right.failureDigest
    && left.caseDigest === right.caseDigest
    && left.evidenceVersion === right.evidenceVersion;
}

interface CaseState {
  previous?: Miss;
  streak: number;
  candidate?: SemanticLivelockDetection;
}

export class SemanticLivelockTracker {
  private evidenceVersion = 0;
  private attempt: SemanticAttempt | undefined;
  private attemptEvidenceVersion = 0;
  private previous: EventRecord | undefined;
  private readonly pendingTranscriptActions = new Set<string>();
  private readonly pendingStepInputs = new Map<string, string>();
  private readonly cases = new Map<string, CaseState>();
  private readonly caseIndex = new Map<string, Set<string>>();

  push(event: EventRecord): void {
    const previous = this.previous;
    this.previous = event;
    if (event.name === "work/goal") {
      this.attempt = undefined;
      this.evidenceVersion += 1;
      this.clearPendingActions();
      this.cases.clear();
      this.caseIndex.clear();
      return;
    }
    if (event.name === "work/step_input") {
      const input = parseSemanticStepInput(event);
      if (!input || this.pendingStepInputs.has(input.stepId)) {
        this.evidenceVersion += 1;
      } else {
        this.pendingStepInputs.set(input.stepId, input.todo);
      }
      return;
    }
    if (event.name === "work/doing" && typeof event.payload.todo === "string"
      && previous?.name === "work/step" && previous.payload.action === "implement"
      && previous.payload.todo === event.payload.todo) {
      this.pendingTranscriptActions.add(event.payload.todo);
      return;
    }
    if (event.name === "work/attempt_patch") {
      this.closeAttempt();
      const opened = openSemanticAttempt(event);
      const authorized = opened ? this.consumeAuthorization(opened) : false;
      this.attempt = authorized ? opened : undefined;
      if (authorized) this.attemptEvidenceVersion = this.evidenceVersion;
      else this.evidenceVersion += 1;
      return;
    }
    if (event.name === "livelock/evidence" && event.payload.status === "unavailable") {
      this.evidenceVersion += 1;
      return;
    }
    if (event.name === "work/case") {
      this.observeCaseProgress(event);
      if (this.attempt && typeof event.payload.id === "string"
        && this.attempt.caseIds.has(event.payload.id)) {
        this.attempt.results.set(event.payload.id, event);
      }
      return;
    }
    if (event.name === "work/step" && event.payload.action === "verify") {
      this.closeAttempt();
      this.clearPendingActions();
    }
    if (event.name === "verify/decision") this.clearPendingActions();
  }

  detections(): SemanticLivelockDetection[] {
    return [...this.cases.values()]
      .flatMap((state) => state.candidate ? [state.candidate] : [])
      .sort((left, right) => left.triggerSeq - right.triggerSeq
        || left.todo.localeCompare(right.todo) || left.caseId.localeCompare(right.caseId));
  }

  detection(todo: string, caseId: string): SemanticLivelockDetection | undefined {
    return this.cases.get(`${todo}\0${caseId}`)?.candidate;
  }

  private closeAttempt(): void {
    if (!this.attempt) return;
    for (const miss of closeAttempt(this.attempt, this.attemptEvidenceVersion)) this.acceptMiss(miss);
    this.attempt = undefined;
  }

  private consumeAuthorization(attempt: SemanticAttempt): boolean {
    if (!attempt.stepId) return this.pendingTranscriptActions.delete(attempt.todo);
    if (this.pendingStepInputs.get(attempt.stepId) !== attempt.todo) return false;
    this.pendingStepInputs.delete(attempt.stepId);
    return true;
  }

  private clearPendingActions(): void {
    this.pendingTranscriptActions.clear();
    this.pendingStepInputs.clear();
  }

  private acceptMiss(miss: Miss): void {
    const key = `${miss.todo}\0${miss.caseId}`;
    if (!this.cases.has(key)) {
      const entries = this.caseIndex.get(miss.caseId) ?? new Set<string>();
      entries.add(key);
      this.caseIndex.set(miss.caseId, entries);
    }
    const state = this.cases.get(key) ?? { streak: 0 };
    state.streak = state.previous && sameMiss(state.previous, miss) ? state.streak + 1 : 1;
    state.previous = miss;
    state.candidate = undefined;
    if (state.streak >= SEMANTIC_LIVELOCK_ATTEMPTS && miss.qualifying
      && miss.failureDigest && miss.caseDigest) {
      state.candidate = {
        todo: miss.todo,
        caseId: miss.caseId,
        attempts: SEMANTIC_LIVELOCK_ATTEMPTS,
        failureDigest: miss.failureDigest,
        footprintDigest: miss.footprintDigest,
        caseDigest: miss.caseDigest,
        planDigest: miss.planDigest,
        triggerSeq: miss.triggerSeq,
      };
    }
    this.cases.set(key, state);
  }

  private observeCaseProgress(event: EventRecord): void {
    const result = parseExecutedSemanticCase(event);
    if (!result) return;
    for (const key of this.caseIndex.get(result.caseId) ?? []) {
      const state = this.cases.get(key);
      if (!state) continue;
      const detection = state.candidate;
      if (!detection || detection.caseId !== result.caseId
        || detection.caseDigest !== result.caseDigest) continue;
      if (result.status === "green"
        || result.failureDigest !== detection.failureDigest) state.candidate = undefined;
    }
  }
}

export function detectSemanticLivelocks(events: readonly EventRecord[]): SemanticLivelockDetection[] {
  const tracker = new SemanticLivelockTracker();
  for (const event of events) tracker.push(event);
  return tracker.detections();
}

export function detectSemanticLivelock(events: readonly EventRecord[]): SemanticLivelockDetection | undefined {
  return detectSemanticLivelocks(events).at(-1);
}
