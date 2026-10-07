import type { EventRecord } from "../host/schema.ts";
import { SEMANTIC_LIVELOCK_ATTEMPTS, type SemanticLivelockDetection } from "./semantic-livelock-types.ts";

export const HEX16 = /^[0-9a-f]{16}$/u;
export const HEX64 = /^[0-9a-f]{64}$/u;

export interface SemanticAttempt {
  readonly todo: string;
  readonly stepId?: string;
  readonly cases: readonly string[];
  readonly caseIds: ReadonlySet<string>;
  readonly planDigest: string;
  readonly footprintDigest: string;
  readonly minor: boolean;
  readonly results: Map<string, EventRecord>;
}

export interface SemanticStepInput {
  readonly todo: string;
  readonly stepId: string;
}

export interface SemanticLivelockClear {
  readonly todo: string;
  readonly caseId: string;
  readonly reason: "case_progress" | "plan_changed";
}

export interface SemanticLivelockRefusal {
  readonly todo: string;
  readonly caseId: string;
  readonly planDigest: string;
  readonly stepSeq: number;
  readonly decision: "refuse_implementation";
}

export interface ExecutedSemanticCase {
  readonly caseId: string;
  readonly caseDigest: string;
  readonly status: "green" | "red";
  readonly exitCode: number;
  readonly failureDigest?: string;
}

export function eventText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openSemanticAttempt(event: EventRecord): SemanticAttempt | undefined {
  if (event.name !== "work/attempt_patch") return undefined;
  const todo = eventText(event.payload.todo);
  const stepId = eventText(event.payload.step_id);
  const plan = eventText(event.payload.plan_digest);
  const footprint = eventText(event.payload.footprint_digest);
  const patch = eventText(event.payload.patch_digest);
  const filesCount = event.payload.files_count;
  const changedLines = event.payload.changed_lines;
  const minor = event.payload.minor;
  const cases = Array.isArray(event.payload.cases)
    ? event.payload.cases.filter((value): value is string => typeof value === "string")
    : [];
  const sortedCases = [...cases].sort();
  if (!todo || (event.payload.step_id !== undefined && !stepId)
    || !plan || !footprint || !patch || cases.length === 0
    || cases.some((value) => value.length === 0)
    || new Set(cases).size !== cases.length
    || cases.some((value, index) => value !== sortedCases[index])
    || !HEX64.test(plan) || !HEX16.test(footprint) || !HEX64.test(patch)
    || typeof filesCount !== "number" || !Number.isInteger(filesCount) || filesCount < 0
    || typeof changedLines !== "number" || !Number.isInteger(changedLines) || changedLines < 0
    || minor !== (filesCount <= 2 && changedLines <= 16)) return undefined;
  return {
    todo,
    ...(stepId ? { stepId } : {}),
    cases,
    caseIds: new Set(cases),
    planDigest: plan,
    footprintDigest: footprint,
    minor: event.payload.minor === true,
    results: new Map(),
  };
}

export function parseSemanticStepInput(event: EventRecord): SemanticStepInput | undefined {
  if (event.name !== "work/step_input") return undefined;
  const todo = eventText(event.payload.todo);
  const stepId = eventText(event.payload.step_id);
  const stepSession = eventText(event.payload.step_session);
  const digest = eventText(event.payload.digest);
  const blob = eventText(event.payload.blob);
  const blobBytes = event.payload.blob_bytes;
  if (!todo || !stepId || !stepSession || event.payload.artifact !== "step_input_v1"
    || !digest || !HEX64.test(digest) || !blob || !HEX64.test(blob)
    || typeof blobBytes !== "number" || !Number.isSafeInteger(blobBytes) || blobBytes < 1) {
    return undefined;
  }
  return { todo, stepId };
}

export function parseExecutedSemanticCase(event: EventRecord): ExecutedSemanticCase | undefined {
  if (event.name !== "work/case" || event.payload.settled_by !== undefined) return undefined;
  const caseId = eventText(event.payload.id);
  const caseDigest = eventText(event.payload.case_digest);
  const duration = event.payload.duration_ms;
  const exitCode = event.payload.exit_code;
  const status = event.payload.status;
  if (!caseId || !caseDigest || !HEX64.test(caseDigest)
    || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0
    || typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)
    || (status !== "green" && status !== "red")) return undefined;
  if (status === "green") {
    return exitCode === 0 ? { caseId, caseDigest, status, exitCode } : undefined;
  }
  const failureDigest = eventText(event.payload.failure_digest);
  if (!failureDigest || !HEX16.test(failureDigest)) return undefined;
  return { caseId, caseDigest, status, exitCode, failureDigest };
}

export function parseRecordedSemanticLivelock(event: EventRecord): SemanticLivelockDetection | undefined {
  if (event.name !== "livelock/detected") return undefined;
  const p = event.payload;
  const todo = eventText(p.todo);
  const caseId = eventText(p.case_id);
  const failure = eventText(p.failure_digest);
  const footprint = eventText(p.footprint_digest);
  const caseDigest = eventText(p.case_digest);
  const plan = eventText(p.plan_digest);
  if (!todo || !caseId || !failure || !footprint || !caseDigest || !plan
    || !HEX16.test(failure) || !HEX16.test(footprint) || !HEX64.test(caseDigest) || !HEX64.test(plan)
    || p.attempts !== SEMANTIC_LIVELOCK_ATTEMPTS || p.decision !== "refuse_implementation"
    || typeof p.trigger_seq !== "number" || !Number.isInteger(p.trigger_seq) || p.trigger_seq < 1) return undefined;
  return {
    todo,
    caseId,
    attempts: SEMANTIC_LIVELOCK_ATTEMPTS,
    failureDigest: failure,
    footprintDigest: footprint,
    caseDigest,
    planDigest: plan,
    triggerSeq: p.trigger_seq,
  };
}

export function parseSemanticLivelockClear(event: EventRecord): SemanticLivelockClear | undefined {
  if (event.name !== "livelock/cleared") return undefined;
  const todo = eventText(event.payload.todo);
  const caseId = eventText(event.payload.case_id);
  const reason = event.payload.reason;
  if (!todo || !caseId || (reason !== "case_progress" && reason !== "plan_changed")) return undefined;
  return { todo, caseId, reason };
}

export function parseSemanticLivelockRefusal(event: EventRecord): SemanticLivelockRefusal | undefined {
  if (event.name !== "livelock/refused") return undefined;
  const todo = eventText(event.payload.todo);
  const caseId = eventText(event.payload.case_id);
  const plan = eventText(event.payload.plan_digest);
  const stepSeq = event.payload.step_seq;
  if (!todo || !caseId || !plan || !HEX64.test(plan)
    || typeof stepSeq !== "number" || !Number.isSafeInteger(stepSeq) || stepSeq < 1
    || event.payload.decision !== "refuse_implementation") return undefined;
  return { todo, caseId, planDigest: plan, stepSeq, decision: "refuse_implementation" };
}
