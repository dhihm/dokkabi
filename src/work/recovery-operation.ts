import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { EventInput } from "../host/schema.ts";
import type { EventLog } from "../host/event-log.ts";
import { foldRecoveryEpisodes, RecoveryTerminalError, type RecoveryOperationInput } from "../host/recovery.ts";

interface WorkOperationIdentity { kind: "work"; scope: number; orderDigest: string; phase: string; todo: string; ordinal: number }
function workIdentity(identity: string): WorkOperationIdentity | undefined {
  try { const value = JSON.parse(identity); return value.kind === "work" && Number.isInteger(value.scope) && Number.isInteger(value.ordinal) ? value : undefined; }
  catch { return undefined; }
}

/** Admit a new logical call only after the prior call completed. Process/phase
 * re-entry restores the unfinished call and the original run deadline. */
export function workRecoveryOperation(log: EventLog, input: { order: string; deadlineMs?: number; defaultBudgetMs?: number; resume?: boolean; maxRequests?: number; requestsSoFar?: number }): RecoveryOperationInput {
  let operation!: RecoveryOperationInput;
  let refusal: string | undefined;
  log.appendBatchDurable(() => {
    const goals = log.events.filter(event => event.name === "work/goal" && event.payload.digest === "pending");
    const anchor = goals.at(-1) ?? log.events.find(event => event.name === "work/order") ?? log.events.find(event => event.name === "work/plan_session") ?? log.events.find(event => event.name === "work/goal");
    if (!anchor) { refusal = "work_order_admission_missing"; return []; }
    const orderDigest = createHash("sha256").update(input.order).digest("hex");
    const scope = anchor.seq;
    const episodes = foldRecoveryEpisodes(log.events).map(episode => ({ episode, identity: workIdentity(episode.identity) })).filter(item => item.identity);
    const same = episodes.filter(item => item.identity!.scope === scope);
    if (same.some(item => item.identity!.orderDigest !== orderDigest)) { refusal = "work_order_mismatch"; return []; }
    const unresolved = same.filter(item => item.episode.state !== "completed");
    if (unresolved.length > 1) { refusal = "work_operation_ambiguous"; return []; }
    const previousBudget = log.events.find(event => event.name === "work/recovery_budget" && event.payload.scope === scope);
    const anchorTime = Date.parse(anchor.ts);
    if (!Number.isFinite(anchorTime) || (input.defaultBudgetMs !== undefined && (!Number.isFinite(input.defaultBudgetMs) || input.defaultBudgetMs <= 0))) { refusal = "work_budget_unknown"; return []; }
    const originalDeadline = previousBudget?.payload.deadline_ms === null || !previousBudget ? Infinity : Number(previousBudget.payload.deadline_ms);
    if (Number.isNaN(originalDeadline)) { refusal = "work_budget_unknown"; return []; }
    let retainedDeadline = originalDeadline;
    let retainedRequests = typeof previousBudget?.payload.max_requests === "number" ? previousBudget.payload.max_requests : Infinity;
    for (const row of log.events.filter(event => event.name === "work/recovery_budget_narrow" && event.payload.scope === scope)) {
      const deadline = row.payload.deadline_ms === null ? Infinity : Number(row.payload.deadline_ms);
      const requests = row.payload.max_requests === null ? Infinity : Number(row.payload.max_requests);
      if (deadline > retainedDeadline || requests > retainedRequests || Number.isNaN(deadline) || Number.isNaN(requests)) { refusal = "work_budget_expansion"; return []; }
      retainedDeadline = deadline; retainedRequests = requests;
    }
    const selectedDeadline = Math.min(retainedDeadline, input.deadlineMs ?? Infinity, anchorTime + (input.defaultBudgetMs ?? Infinity));
    const deadlineMs = Number.isFinite(selectedDeadline) ? selectedDeadline : undefined;
    if (deadlineMs !== undefined && !Number.isFinite(deadlineMs)) { refusal = "work_budget_unknown"; return []; }
    const budgetOwner = log.events.find(event => event.seq >= anchor.seq && ["work/loop", "work/ledger_session"].includes(event.name));
    const recordedBudget = budgetOwner?.payload.budget as { max_steps?: unknown; max_requests?: unknown } | undefined;
    const originalCap = recordedBudget?.max_requests ?? recordedBudget?.max_steps;
    const retainedCap = Number.isFinite(retainedRequests) ? retainedRequests : undefined;
    const ceilings = [originalCap, retainedCap, input.maxRequests].filter((value): value is number => typeof value === "number");
    const maxRequests = ceilings.length ? Math.min(...ceilings) : undefined;
    const observed = input.requestsSoFar ?? log.events.filter(event => event.name === "model/usage" && event.seq > (budgetOwner?.seq ?? anchor.seq)).length;
    // Failed requests may have no model/usage row. Reservations are the
    // conservative accounting boundary, including route readiness probes.
    const children = log.events.filter(event => event.name === "work/recovery_child_completed" && typeof event.payload.attempts === "number");
    const childSpent = children.filter(event => {
      const admission = log.events.find(row => row.seq === event.payload.admission_seq);
      try { return JSON.parse(String(admission?.payload.identity)).parent.scope === scope; } catch { return false; }
    }).reduce((sum, event) => sum + Number(event.payload.attempts), 0);
    const reserved = same.reduce((total, item) => total + item.episode.attempts, 0) + childSpent;
    const used = Math.max(observed, reserved);
    const maxAttempts = maxRequests === undefined ? undefined : Math.max(0, Math.floor(maxRequests - used)) + (unresolved[0]?.episode.attempts ?? 0);
    const rows: EventInput[] = [];
    if (!previousBudget) rows.push({ kind: "observe" as const, name: "work/recovery_budget", payload: { scope, order_digest: orderDigest, deadline_ms: deadlineMs ?? null, max_requests: maxRequests ?? null, admitted_at: anchorTime } });
    else if ((deadlineMs ?? Infinity) < retainedDeadline || (maxRequests ?? Infinity) < retainedRequests) rows.push({ kind: "observe", name: "work/recovery_budget_narrow", payload: { scope, deadline_ms: deadlineMs ?? null, max_requests: maxRequests ?? null } });
    if (unresolved[0]) {
      operation = { ...(maxAttempts === undefined ? {} : { maxAttempts }), identity: unresolved[0].episode.identity, deadlineMs: deadlineMs === undefined ? input.deadlineMs : Math.min(deadlineMs, input.deadlineMs ?? Infinity) };
      return rows;
    }
    const phase = [...log.events].reverse().find(event => event.name === "work/phase")?.payload.phase;
    const step = [...log.events].reverse().find(event => event.name === "work/step");
    const identity: WorkOperationIdentity = { kind: "work", scope, orderDigest, phase: typeof phase === "string" ? phase : "work", todo: typeof step?.payload.todo === "string" ? step.payload.todo : "unscoped", ordinal: same.reduce((max, item) => Math.max(max, item.identity!.ordinal), 0) + 1 };
    operation = { ...(maxAttempts === undefined ? {} : { maxAttempts }), ...(input.resume && same.at(-1) ? { inputDigest: same.at(-1)!.episode.inputDigest } : {}), identity: canonicalJson(identity), deadlineMs: deadlineMs === undefined ? input.deadlineMs : Math.min(deadlineMs, input.deadlineMs ?? Infinity) };
    for (const prior of episodes.filter(item => item.identity!.scope !== scope && item.episode.state !== "completed")) {
      if (!log.events.some(event => event.name === "work/recovery_superseded" && event.payload.episode_id === prior.episode.episodeId && event.payload.new_scope === scope)) rows.push({ kind: "observe" as const, name: "work/recovery_superseded", payload: { episode_id: prior.episode.episodeId, new_scope: scope, reason: "new_operator_order_admitted" } });
    }
    return rows;
  });
  if (refusal) throw new RecoveryTerminalError(refusal);
  return operation;
}
