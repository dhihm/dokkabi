import { isRecoveryTerminalError } from "../host/recovery.ts";
import { readEvidenceBodies } from "./evidence/bodies.ts";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EventLog } from "../host/event-log.ts";
import { replayContract, replayDigest } from "../host/replay.ts";
import {
  draftPlanDigest,
  parseDraftPlanReply,
  validateDraftPlan,
  writeDraftPlan,
  type DraftPlan,
} from "./draft-plan.ts";
import { ralphDraftPlanPath, type RalphPlannerSession } from "./ralph-plan.ts";
import { redactText } from "../host/redact.ts";
import { renderPrompt } from "./prompt-slots.ts";
import { streamFinalChunk } from "./turn-support.ts";

/**
 * ralph-sample (#60 phase 2): the PARALLEL plan-authoring strategy, beside
 * ralph-refine's sequential scout→critic→synthesizer loop (src/work/
 * ralph-plan.ts). It applies the Monkeys move to decompose: draw k
 * INDEPENDENT plan samples — fresh session each, the SAME scout prompt
 * (constitution 4: no sample index in prompt bytes; diversity comes from
 * independent sessions and route-side temperature) — gate each through the
 * draft-plan validator, rank the survivors with a HOST-measured structural
 * score, and seal the winner for HEUNG to execute. No majority vote, no
 * reward model, no model self-grading (#59's precision lesson: with a
 * validator in hand, votes plateau); all-fail fails closed.
 */

export const MIN_RALPH_SAMPLES = 2;
export const MAX_RALPH_SAMPLES = 8;
export const DEFAULT_RALPH_SAMPLES = 3;

export function resolveRalphSamples(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RALPH_SAMPLES;
  if (!Number.isInteger(value) || value < MIN_RALPH_SAMPLES || value > MAX_RALPH_SAMPLES) {
    throw new Error(`plan samples (--plan-samples, or a ralph-sample recipe's k) must be an integer from ${MIN_RALPH_SAMPLES} to ${MAX_RALPH_SAMPLES}`);
  }
  return value;
}

/** Dependency edges among the plan's todos — the docs/plan-eval.md signal
 * that a flat bag is a dead architecture. */
export function draftPlanEdges(plan: DraftPlan): number {
  let edges = 0;
  for (const todo of plan.todos) edges += todo.blocked_by.length;
  return edges;
}

/**
 * The host-measured rank (RFC: "통과한 플랜을 rank/fuse (host, 모델 주장이
 * 아님)"): reward real DAG structure, charge every unresolved concern the
 * plan carries forward. A deliberately coarse v1 — it orders survivors of
 * the validator, it does not pretend to measure plan goodness.
 */
export function draftPlanSampleScore(plan: DraftPlan): number {
  return draftPlanEdges(plan) - (plan.unknowns.length + plan.contradictions.length);
}

export interface RalphSampleRecord {
  readonly index: number;
  readonly passed: boolean;
  readonly plan?: DraftPlan;
  readonly score?: number;
  readonly errors?: readonly string[];
}

/** Argmax score among passers; ties break to the SMALLER plan (fewer
 * todos), then to the earlier draw — deterministic, never a vote. */
export function selectSampleWinner(records: readonly RalphSampleRecord[]): number | undefined {
  let winner: RalphSampleRecord | undefined;
  for (const record of records) {
    if (!record.passed || record.plan === undefined || record.score === undefined) continue;
    if (
      !winner ||
      record.score > winner.score! ||
      (record.score === winner.score && record.plan.todos.length < winner.plan!.todos.length)
    ) {
      winner = record;
    }
  }
  return winner?.index;
}

export interface RalphSampleResult {
  readonly status: "selected" | "failed";
  readonly samples: RalphSampleRecord[];
  readonly winnerIndex?: number;
  readonly path?: string;
  readonly digest?: string;
  readonly plan?: DraftPlan;
  readonly errors: string[];
}

function textDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Failure text is model/provider output territory — redact like refine
 * does (PR #94 review M3): provider errors can embed URLs and keys. */
function safeFailure(error: unknown): string {
  return redactText((error instanceof Error ? error.message : String(error)).slice(0, 200));
}

function workspaceRelative(workspaceRoot: string, path: string): string {
  const related = relative(workspaceRoot, path);
  return related.startsWith("..") ? path : related;
}

export async function runRalphSample(input: {
  readonly parentLog: EventLog;
  readonly parentSessionId: string;
  readonly order: string;
  readonly workspaceRoot: string;
  readonly artifactPath?: string;
  readonly samples?: number;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly route: string;
  readonly openSession: (sessionId: string) => Promise<RalphPlannerSession>;
  readonly nonce?: () => string;
  /** Test seam: produce one sample reply. Defaults to a real model turn. */
  readonly draw?: (session: RalphPlannerSession, prompt: string) => Promise<string>;
}): Promise<RalphSampleResult> {
  const k = resolveRalphSamples(input.samples);
  const artifactPath = input.artifactPath ?? ralphDraftPlanPath(input.workspaceRoot);
  const nonce = input.nonce?.() ?? Date.now().toString(36);
  // The SAME prompt for every sample: no index, no attempt id, no clock.
  const prompt = renderPrompt("work/ralph-plan-scout.md", { order: input.order, refusal_block: "" }).trimEnd();
  const draw = input.draw ?? ((session: RalphPlannerSession, text: string) =>
    streamFinalChunk(session.loop, text, {
      providerRole: "scout",
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      thinkingBudgets: { medium: 2_048 },
      maxOutputTokens: 8_192,
      timeoutMs: 180_000,
      timeoutPolicy: "continue",
      maxToolCalls: 16,
    }));

  input.parentLog.append({
    kind: "observe",
    name: "work/plan_started",
    payload: {
      mode: "ralph-sample",
      samples: k,
      route: input.route,
      artifact: workspaceRelative(input.workspaceRoot, artifactPath),
      ...(input.modelId ? { model: input.modelId } : {}),
    },
  });

  const records: RalphSampleRecord[] = [];
  for (let index = 1; index <= k; index += 1) {
    const childSessionId = `${input.parentSessionId}-plan-sample-${index}-${nonce}`;
    let reply = "";
    let childDigest = "missing";
    let childLogHash = "missing";
    let errors: string[] = [];
    let plan: DraftPlan | undefined;
    try {
      const session = await input.openSession(childSessionId);
      try {
        reply = await draw(session, prompt);
      } catch (error) {
        if (isRecoveryTerminalError(error)) throw error;
        // Independence (#59 S3 applied to planning): one failed draw is one
        // failed sample, never the end of the campaign — and the child's
        // observability survives the throw: its session opened and spent
        // (PR #94 review M5).
        errors = [safeFailure(error)];
      } finally {
        childDigest = replayDigest(replayContract(session.log.events, readEvidenceBodies(session.log)));
        childLogHash = session.log.lastHash;
        await session.close().catch(() => undefined);
      }
      if (errors.length === 0) {
        const parsed = parseDraftPlanReply(reply, input.order, 1);
        const evidenceErrors = parsed.plan ? validateDraftPlan(parsed.plan, input.workspaceRoot) : [];
        errors = [...new Set([...parsed.errors, ...evidenceErrors])];
        if (parsed.plan && errors.length === 0) plan = parsed.plan;
      }
    } catch (error) {
      if (isRecoveryTerminalError(error)) throw error;
      errors = [safeFailure(error)];
    }
    const record: RalphSampleRecord = plan
      ? { index, passed: true, plan, score: draftPlanSampleScore(plan) }
      : { index, passed: false, errors };
    records.push(record);
    input.parentLog.append({
      kind: "observe",
      name: "work/plan_sample",
      payload: {
        mode: "ralph-sample",
        i: index,
        samples: k,
        child_session: childSessionId,
        child_digest: childDigest,
        child_log_hash: childLogHash,
        passed: record.passed,
        reply_digest: textDigest(reply),
        ...(record.passed
          ? {
              digest: draftPlanDigest(record.plan!),
              score: record.score,
              todos: record.plan!.todos.length,
              edges: draftPlanEdges(record.plan!),
            }
          : { errors: (record.errors ?? []).slice(0, 12) }),
      },
    });
  }

  const winnerIndex = selectSampleWinner(records);
  if (winnerIndex === undefined) {
    // Every sample failed its gate: fail closed (RFC: 전부 실패면 fail
    // closed) — no fabricated plan, no vote among the failures.
    input.parentLog.append({
      kind: "observe",
      name: "work/plan_stopped",
      payload: { mode: "ralph-sample", reason: "all_samples_failed", samples: k },
    });
    return {
      status: "failed",
      samples: records,
      errors: records.flatMap((record) => record.errors ?? []).slice(0, 12),
    };
  }

  const winner = records.find((record) => record.index === winnerIndex)!;
  const digest = draftPlanDigest(winner.plan!);
  writeDraftPlan(artifactPath, winner.plan!);
  input.parentLog.append({
    kind: "observe",
    name: "work/plan_selected",
    payload: {
      mode: "ralph-sample",
      winner: winnerIndex,
      digest,
      score: winner.score,
      samples: k,
      passed: records.filter((record) => record.passed).length,
    },
  });
  input.parentLog.append({
    kind: "observe",
    name: "work/plan_sealed",
    payload: {
      mode: "ralph-sample",
      stage: "draft",
      draft_digest: digest,
      artifact: workspaceRelative(input.workspaceRoot, artifactPath),
    },
  });
  return {
    status: "selected",
    samples: records,
    winnerIndex,
    path: artifactPath,
    digest,
    plan: winner.plan!,
    errors: [],
  };
}
