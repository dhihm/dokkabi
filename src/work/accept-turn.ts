import type { EventLog } from "../host/event-log.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { acceptanceThinkingLevel, resolveThinkingLevel, thinkingBudgetsForLevel } from "../host/thinking.ts";
import {
  buildAcceptancePrompt,
  buildAcceptanceSpecPrompt,
  buildAcceptanceSpecRetryPrompt,
  buildAcceptanceVerdictPrompt,
  parseAcceptDecision,
  parseAcceptanceSpecReview,
} from "./prompt.ts";
import { reportEvidence, streamFinalChunk, type VoiceLoop } from "./turn-support.ts";
import { blindAcceptanceInventory, validateAcceptanceCheckInventory, type AcceptanceContract } from "./evidence/acceptance-contract.ts";
import { executeAcceptanceChecks, finishAcceptanceExecution, type AcceptanceExecution } from "./evidence/acceptance-execution.ts";
import { remainingReviewTime } from "./review-budget.ts";

export interface AcceptVerdict {
  readonly speech: string;
  readonly accepted: boolean;
  readonly inconclusive: boolean;
  readonly marker: boolean;
  readonly toolBudgetExhausted: boolean;
  readonly turnBudgetExhausted: boolean;
  readonly verdictTurnUsed: boolean;
  /** The ordinary host route already completed its reserved no-tools decision. */
  readonly confirmationComplete?: true;
  /** False when another model review cannot supply missing host capability. */
  readonly retryable?: boolean;
  readonly reason?: string;
}

export function unavailableAcceptance(log: EventLog, reason: string, print: (text: string) => void): AcceptVerdict {
  const speech = `Acceptance is unavailable: ${reason}. No completion was recorded.`;
  log.append({ kind: "observe", name: "work/accept", payload: { decision: "inconclusive", reason_code: reason, retryable: false } });
  print(speech);
  return { speech, accepted: false, inconclusive: true, marker: false, toolBudgetExhausted: false,
    turnBudgetExhausted: false, verdictTurnUsed: false, retryable: false, reason };
}

const ACCEPTANCE_SPEC_GENERATION = {
  thinkingBudgets: { medium: 2_048 },
  maxOutputTokens: 4_096,
  timeoutMs: 120_000,
} as const;

const ACCEPTANCE_PROBE_GENERATION = {
  thinkingBudgets: { medium: 2_048 },
  maxOutputTokens: 4_096,
  timeoutMs: 1_800_000,
  timeoutPolicy: "continue",
} as const;

const ACCEPTANCE_SPEC_RETRY_GENERATION = {
  thinkingBudgets: { medium: 2_048 },
  maxOutputTokens: 4_096,
  timeoutMs: 120_000,
} as const;

const ACCEPTANCE_VERDICT_GENERATION = {
  // Inherit the resolved model's output allowance and thinking policy. An
  // adaptive provider cannot reserve 512 reasoning tokens inside a 2048 cap;
  // both reasoning and the visible verdict consume that shared allowance.
  // The caller's remaining work budget and zero-tool boundary are authoritative.
  timeoutPolicy: "continue",
} as const;

function reviewResponse(log: EventLog, afterSeq: number, reply: string) {
  const response = [...log.events].reverse().find(row => row.seq > afterSeq && row.name === "assistant/message");
  const ref = response ? { seq: response.seq, hash: response.hash } : undefined;
  const stop = response?.payload.stop;
  const text = typeof response?.payload.text === "string" ? response.payload.text.trim() : "";
  const reason = !response ? "response_missing"
    : stop === "length" ? "output_truncated"
    : stop === "aborted" ? "response_aborted"
    : stop === "error" ? "response_error"
    : stop !== "stop" ? "unexpected_stop"
    : !text ? "empty_response"
    : text !== reply.trim() ? "response_mismatch"
    : parseAcceptDecision(reply).kind === "unknown" ? "decision_missing"
    : undefined;
  return { ref, reason };
}

/** Finish a budgeted inspection with one recorded, no-tools decision. A
 * warning is a reason to finalize, not evidence that DONE was completed.
 * The final turn's own deadline and tool attempts cannot grant acceptance. */
export async function finalizeBudgetedReview(input: {
  log: EventLog; loop: VoiceLoop; afterSeq: number; reply: string; verdictPrompt: string;
  modelId?: string; thinkingLevel: ThinkingLevel; timeoutMs?: number; remainingMs?: () => number | undefined;
}): Promise<{ reply: string; toolBudgetExhausted: boolean; turnBudgetExhausted: boolean;
  verdictTurnUsed: boolean; verdictIncomplete: boolean; verdictReason?: string }> {
  const budgetRows = input.log.events.filter(row => row.seq > input.afterSeq
    && (row.name === "model/tool_budget" || row.name === "model/turn_budget"));
  const toolBudgetExhausted = budgetRows.some(row => row.name === "model/tool_budget");
  const turnBudgetExhausted = budgetRows.some(row => row.name === "model/turn_budget");
  const inspection = reviewResponse(input.log, input.afterSeq, input.reply);
  if (!inspection.reason && (!budgetRows.length || parseAcceptDecision(input.reply).kind === "not_done")) return {
    reply: input.reply, toolBudgetExhausted, turnBudgetExhausted, verdictTurnUsed: false, verdictIncomplete: false,
  };
  const timeoutMs = remainingReviewTime(input.remainingMs, input.timeoutMs);
  input.log.append({ kind: "observe", name: "work/review_finalization", payload: {
    after_seq: input.afterSeq, timeout_ms: timeoutMs ?? null, max_tool_calls: 0,
    output_allowance: "resolved_model", thinking_level: input.thinkingLevel,
    ...(inspection.reason ? { inspection_issue: inspection.reason } : {}),
    ...(inspection.ref ? { response_ref: inspection.ref } : {}),
    causes: budgetRows.map(row => ({ seq: row.seq, hash: row.hash, name: row.name, decision: row.payload.decision ?? "missing" })),
  } });
  const finalStart = input.log.lastSeq;
  const reply = timeoutMs === 0 ? "" : await streamFinalChunk(input.loop, input.verdictPrompt, {
    providerRole: "review", modelId: input.modelId, ...ACCEPTANCE_VERDICT_GENERATION,
    timeoutMs,
    thinkingLevel: input.thinkingLevel,
    maxToolCalls: 0,
  });
  const finalRows = input.log.events.filter(row => row.seq > finalStart);
  const final = reviewResponse(input.log, finalStart, reply);
  const verdictReason = timeoutMs === 0 ? "work_budget_exhausted"
    : finalRows.some(row => row.name === "tool/call" || row.name === "model/tool_budget") ? "tool_attempt"
    : finalRows.some(row => row.name === "model/turn_budget") ? "deadline"
    : final.reason;
  const verdictIncomplete = verdictReason !== undefined;
  input.log.append({ kind: "observe", name: "work/review_finalization_result", payload: {
    after_seq: finalStart, verdict_incomplete: verdictIncomplete,
    decision: verdictIncomplete ? "inconclusive" : parseAcceptDecision(reply).kind,
    ...(final.ref ? { response_ref: final.ref } : {}), ...(verdictReason ? { reason: verdictReason } : {}),
  } });
  return { reply, toolBudgetExhausted, turnBudgetExhausted, verdictTurnUsed: true, verdictIncomplete, verdictReason };
}

export async function acceptanceSpecTurn(input: {
  readonly log: EventLog;
  readonly loop: VoiceLoop;
  readonly order: string;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly contract?: AcceptanceContract;
}): Promise<string> {
  const thinkingLevel = acceptanceThinkingLevel(input.thinkingLevel ?? resolveThinkingLevel());
  input.log.append({
    kind: "observe",
    name: "work/step",
    payload: { action: "accept_spec", agent: "dokkabi" },
  });
  const inventory = input.contract ? `\nHost-enrolled required checks: ${blindAcceptanceInventory(input.contract)}\nCHECK must be only a JSON array containing every required check ID exactly once, with no explanation after it. Explain the grounded boundaries in the other three fields. Do not replace or omit enrolled requirements.` : "";
  let review = await streamFinalChunk(input.loop, buildAcceptanceSpecPrompt(input.order) + inventory, {
    providerRole: "spec",
    modelId: input.modelId,
    ...ACCEPTANCE_SPEC_GENERATION,
    thinkingLevel,
    thinkingBudgets: thinkingBudgetsForLevel(thinkingLevel, ACCEPTANCE_SPEC_GENERATION.thinkingBudgets),
  });
  let parsed = parseAcceptanceSpecReview(review);
  const checked = parsed.valid && input.contract ? validateAcceptanceCheckInventory(parsed.review, input.contract) : undefined;
  // The one retry carries the actual failure, so a CHECK syntax error is not
  // repeated under a generic inventory message.
  const reason = !parsed.valid ? parsed.reason ?? "review is malformed" : checked && !checked.complete ? checked.reason : undefined;
  if (reason !== undefined) {
    input.log.append({
      kind: "observe",
      name: "work/accept_spec",
      payload: { decision: "retry", reason },
    });
    review = await streamFinalChunk(input.loop, buildAcceptanceSpecRetryPrompt(reason) + inventory, {
      providerRole: "spec",
      modelId: input.modelId,
      ...ACCEPTANCE_SPEC_RETRY_GENERATION,
      thinkingLevel,
      thinkingBudgets: thinkingBudgetsForLevel(thinkingLevel, ACCEPTANCE_SPEC_RETRY_GENERATION.thinkingBudgets),
    });
    parsed = parseAcceptanceSpecReview(review);
  }
  if (!parsed.valid) {
    throw new Error(`acceptance specification review was refused: ${parsed.reason}`);
  }
  // A well-formed review that still drops required IDs remains visible evidence
  // of an incomplete specification. The host executes no checks and cannot accept.
  return parsed.review;
}

export async function acceptTurn(input: {
  readonly log: EventLog;
  readonly loop: VoiceLoop;
  readonly order: string;
  readonly modelId?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly print: (text: string) => void;
  readonly narrate?: boolean;
  readonly ledger?: string;
  readonly specReview?: string;
  readonly execution?: AcceptanceExecution;
  readonly remainingMs?: () => number | undefined;
}): Promise<AcceptVerdict> {
  const thinkingLevel = acceptanceThinkingLevel(input.thinkingLevel ?? resolveThinkingLevel());
  input.log.append({
    kind: "observe",
    name: "work/step",
    payload: { action: "accept", agent: "dokkabi" },
  });
  const turnStartSeq = input.log.lastSeq;
  if (!input.execution) return unavailableAcceptance(input.log, "required_inventory_missing", input.print);
  const executed = input.execution ? await executeAcceptanceChecks(input.execution) : undefined;
  if (executed?.unavailableReason) return unavailableAcceptance(input.log, executed.unavailableReason, input.print);
  const evidence = executed ? `\nHost executed acceptance evidence: ${executed.summary}` : "\nNo host-enrolled acceptance inventory is available. Model and generic tool results cannot establish completion.";
  if (executed?.remainingMs === 0) input.log.append({ kind: "observe", name: "model/turn_budget", payload: { phase: "acceptance_probes", decision: "exhausted" } });
  let reply = executed?.remainingMs === 0 ? "INCONCLUSIVE" : await streamFinalChunk(input.loop, buildAcceptancePrompt(input.order, input.ledger, input.specReview) + evidence, {
    providerRole: "review",
    modelId: input.modelId,
    print: input.narrate ? input.print : undefined,
    ...ACCEPTANCE_PROBE_GENERATION,
    thinkingLevel,
    thinkingBudgets: thinkingBudgetsForLevel(thinkingLevel, ACCEPTANCE_PROBE_GENERATION.thinkingBudgets),
    timeoutMs: executed?.remainingMs ?? ACCEPTANCE_PROBE_GENERATION.timeoutMs,
    maxToolCalls: 240 - (executed?.calls ?? 0),
  });
  const finalized = await finalizeBudgetedReview({ ...input, afterSeq: turnStartSeq, reply,
    verdictPrompt: buildAcceptanceVerdictPrompt(), thinkingLevel });
  reply = finalized.reply;
  const { toolBudgetExhausted, turnBudgetExhausted } = finalized;
  const verdictIncomplete = finalized.verdictIncomplete;
  const parsed = parseAcceptDecision(reply);
  const host = input.execution ? finishAcceptanceExecution(input.execution) : { status: "inconclusive", reason: "required_inventory_missing" };
  const inconclusive = host.status !== "rejected" && (host.status === "inconclusive" || verdictIncomplete ||
    parsed.kind === "unknown" ||
    parsed.kind === "inconclusive" ||
    (host.status === "accepted" && parsed.kind !== "done"));
  const specReview = input.specReview?.trim();
  const speech = verdictIncomplete
    ? [
        `Acceptance is inconclusive: the final review response is incomplete (${finalized.verdictReason}). DONE was refused.`,
        specReview
          ? `Blind review that must be satisfied before DONE:\n${specReview}`
          : "Add a runnable case for the strongest unchecked acceptance claim before accepting.",
      ].join("\n")
    : host.status === "inconclusive"
      ? `Acceptance is inconclusive: ${host.reason}. Required executed evidence is not complete.`
      : host.status === "rejected"
        ? "Acceptance rejected: a host-executed required check found a product counterexample."
        : parsed.speech;
  const accepted = host.status === "accepted" && parsed.kind === "done" && !verdictIncomplete;
  const verdict: AcceptVerdict = {
    speech,
    accepted,
    inconclusive,
    marker: parsed.kind !== "unknown",
    toolBudgetExhausted,
    turnBudgetExhausted,
    verdictTurnUsed: finalized.verdictTurnUsed,
    ...(finalized.verdictReason ? { reason: finalized.verdictReason } : {}),
    ...(finalized.verdictReason === "work_budget_exhausted" ? { retryable: false } : {}),
  };
  if (verdict.speech.trim().length > 0) {
    input.print(verdict.speech);
  }
  input.log.append({
    kind: "observe",
    name: "work/accept",
    payload: {
      decision: verdict.accepted ? "done" : verdict.inconclusive ? "inconclusive" : "not_done",
      marker: verdict.marker,
      host_reason: host.reason,
      ...(verdict.toolBudgetExhausted ? { tool_budget_exhausted: true } : {}),
      ...(verdict.turnBudgetExhausted ? { turn_budget_exhausted: true } : {}),
      ...(verdict.verdictTurnUsed ? { verdict_turn: true } : {}),
      verdict_incomplete: verdictIncomplete,
      ...(verdict.reason ? { reason_code: verdict.reason } : {}),
      ...(input.ledger ? { ledger: true } : {}),
    },
  });
  if (verdict.speech.trim().length > 0) {
    reportEvidence({ log: input.log, text: verdict.speech, stage: "accept", print: input.print });
  }
  return verdict;
}
