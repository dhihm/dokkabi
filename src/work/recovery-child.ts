import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { EventLog } from "../host/event-log.ts";
import { RecoveryTerminalError, type RecoveryOperationInput } from "../host/recovery.ts";
import type { HostContext, LoopFacade } from "../loader/types.ts";
import type { ModelResilienceService } from "../plugins/model-resilience.ts";
import { recoveringWorkLoop } from "./recovery-loop.ts";

export interface RecoveryChildInput {
  parentLog: EventLog;
  operation: RecoveryOperationInput;
  /** A host-selected logical role/todo, never a clock or random nonce. */
  scope: string;
}
export interface RecoveryChildAdmission extends RecoveryChildInput { sessionId: string; admissionSeq: number; identity: string }

/** Reopening a child after a lost/failed turn must reopen its retained owner.
 * Only a recorded completion permits a new child transcript for this scope. */
export function admitRecoveryChild(input: RecoveryChildInput, requestedSessionId: string): RecoveryChildAdmission {
  let parentScope: unknown = input.operation.identity;
  try { const parsed = JSON.parse(input.operation.identity); if (parsed.kind === "work") parentScope = { scope: parsed.scope, orderDigest: parsed.orderDigest }; } catch { /* Opaque non-work owner identity. */ }
  const identity = canonicalJson({ parent: parentScope, child: input.scope });
  const identityDigest = createHash("sha256").update(identity).digest("hex");
  const parentDigest = createHash("sha256").update(canonicalJson(parentScope)).digest("hex");
  let sessionId = requestedSessionId; let admissionSeq = 0; let refusal: string | undefined;
  input.parentLog.appendBatchDurable((nextSeq) => {
    const admissions = input.parentLog.events.filter(event => event.name === "work/recovery_child" && event.payload.parent_digest === parentDigest);
    const pending = admissions.filter(event => !input.parentLog.events.some(row => row.name === "work/recovery_child_completed" && row.payload.admission_seq === event.seq));
    if (pending.length > 1) { refusal = "child_operation_ambiguous"; return []; }
    if (pending[0] && pending[0].payload.identity_digest !== identityDigest) { refusal = "child_operation_pending"; return []; }
    if (pending[0]) { sessionId = String(pending[0].payload.child_session); admissionSeq = pending[0].seq; return []; }
    admissionSeq = nextSeq;
    const superseded = input.parentLog.events.filter(event => event.name === "work/recovery_child" && event.payload.parent_digest !== parentDigest
      && !input.parentLog.events.some(row => row.name === "work/recovery_child_completed" && row.payload.admission_seq === event.seq)
      && !input.parentLog.events.some(row => row.name === "work/recovery_child_superseded" && row.payload.admission_seq === event.seq && row.payload.new_parent_digest === parentDigest));
    // Append the admission first so its sequence stays the recorded grant.
    return [{ kind: "observe", name: "work/recovery_child", payload: { parent_digest: parentDigest, identity_digest: identityDigest, identity, child_session: sessionId, deadline_ms: input.operation.deadlineMs ?? null, max_attempts: input.operation.maxAttempts ?? null } },
      ...superseded.map(event => ({ kind: "observe" as const, name: "work/recovery_child_superseded", payload: { admission_seq: event.seq, new_parent_digest: parentDigest, reason: "new_operator_order_admitted" } }))];
  });
  if (refusal) throw new RecoveryTerminalError(refusal);
  return { ...input, identity, sessionId, admissionSeq };
}

export function recoveringChildLoop(ctx: HostContext, loop: LoopFacade, input: RecoveryChildAdmission): { loop: LoopFacade; settled(): void } {
  const recovery = ctx.tryGet<ModelResilienceService>("model_resilience")?.recovery;
  if (!recovery) throw new RecoveryTerminalError("unavailable");
  ctx.log.appendBatchDurable(() => ctx.log.events.some(event => event.name === "work/order") ? [] : [{ kind: "observe", name: "work/order", payload: { order: input.identity, parent_admission_seq: input.admissionSeq, deadline_ms: input.operation.deadlineMs ?? null } }]);
  const wrapped = recoveringWorkLoop(ctx, loop, { unattended: true, order: input.identity, deadlineMs: input.operation.deadlineMs, maxRequests: input.operation.maxAttempts });
  return { loop: wrapped, settled() {
    const episodes = recovery.episodes();
    // Failed cleanup does not grant a fresh allowance. Unknown effects and
    // exhausted/waiting episodes keep the child admission pending.
    if (!episodes.length || episodes.some(episode => episode.state !== "completed")) return;
    input.parentLog.appendBatchDurable(() => input.parentLog.events.some(row => row.name === "work/recovery_child_completed" && row.payload.admission_seq === input.admissionSeq) ? [] : [{ kind: "observe", name: "work/recovery_child_completed", payload: { admission_seq: input.admissionSeq, child_session: input.sessionId, child_log_hash: ctx.log.lastHash, attempts: episodes.reduce((sum, episode) => sum + episode.attempts, 0), dispatches: episodes.reduce((sum, episode) => sum + episode.dispatches, 0) } }]);
  } };
}
