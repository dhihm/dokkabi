import type { AgentEvent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { SSH_EXACT_PROVIDER_DIGEST, sshExactToolAuthority, type ProjectedQueuedSshExec,
  type SshExactToolAuthority } from "../../plugins/ssh/speculative.ts";
import type { SshApprovedOperation } from "../host/ssh.ts";
import { createSpeculationCandidate } from "./candidates.ts";
import type { Tier1ResolutionOutcome } from "./runtime-tier1-types.ts";
import { createCandidateScheduler } from "./scheduler.ts";
import type { ScheduledCandidate, SchedulerStateEvent } from "./scheduler-types.ts";
import { SpeculationServiceError } from "./service.ts";
import type { SshTier3Runtime, SshTier3RuntimeOptions } from "./runtime-tier3-ssh-types.ts";
import { authorityForWarmupCandidate, createSchedulerWarmupCandidateIssuer } from "./warmup/candidate.ts";
import { createSshWarmupLease, type SshWarmupLease, type SshWarmupPlan } from "./warmup/ssh.ts";

export { type SshTier3Runtime, type SshTier3RuntimeOptions } from "./runtime-tier3-ssh-types.ts";
export const SSH_TIER3_PROVIDER_DIGEST = SSH_EXACT_PROVIDER_DIGEST;
type Ready = Readonly<{ lease: SshWarmupLease<SshApprovedOperation>; plan: SshWarmupPlan }>;
type Terminal = { readonly kind: "ready" }
  | { readonly kind: "fallback" }
  | { readonly kind: "refused"; readonly result: AgentToolResult<unknown> }
  | { readonly kind: "failed_after_approval" };
type Slot = {
  readonly callId: string;
  readonly candidateId: string;
  readonly keyDigest: string;
  readonly projected: ProjectedQueuedSshExec;
  readonly authority: SshExactToolAuthority;
  readonly controller: AbortController;
  readonly gate: Promise<Terminal>;
  settle: (terminal: Terminal) => void;
  approvalAttempted: boolean;
  refusal?: AgentToolResult<unknown>;
  resolved: boolean;
};

export function createSshTier3Runtime(options: SshTier3RuntimeOptions): SshTier3Runtime {
  const enabled = options.mode === "full";
  const issuer = createSchedulerWarmupCandidateIssuer();
  const byCall = new Map<string, Slot>();
  const byCandidate = new Map<string, Slot>();
  const blockedCalls = new Set<string>();
  const foregroundTasks = new Set<Promise<unknown>>();
  const wrappers = new WeakMap<AgentTool, AgentTool>();
  let boundTool: AgentTool | undefined;
  let boundAuthority: SshExactToolAuthority | undefined;
  let revision = 0;
  let disposed = false;
  let callbackFailure: Error | undefined;

  const resolve = (slot: Slot, outcome: Tier1ResolutionOutcome): void => {
    if (slot.resolved) return;
    slot.resolved = true;
    try { options.onResolve?.({ candidateId: slot.candidateId, outcome }); }
    catch (error) { callbackFailure ??= asError(error, "SSH Tier 3 resolution callback failed"); }
  };
  const state = (event: SchedulerStateEvent): boolean => {
    let accepted = true;
    try { accepted = options.onState?.(event) !== false; }
    catch (error) {
      callbackFailure ??= asError(error, "SSH Tier 3 state callback failed");
      accepted = false;
    }
    const slot = byCandidate.get(event.id);
    if (!slot) return accepted;
    if (event.phase === "ready" && accepted) slot.settle({ kind: "ready" });
    if (event.phase === "dropped" || event.phase === "disposed") {
      const terminal = slot.refusal
        ? { kind: "refused" as const, result: slot.refusal }
        : slot.approvalAttempted ? { kind: "failed_after_approval" as const } : { kind: "fallback" as const };
      slot.settle(terminal);
      resolve(slot, event.phase === "disposed" ? "cancelled" : slot.approvalAttempted ? "failed" : "drop");
      if (!slot.approvalAttempted) forget(slot);
    }
    return accepted;
  };
  const scheduler = createCandidateScheduler<Ready>({
    tools: [{ name: "ssh", queuedExact: 3 }],
    budget: { maxConcurrency: 1, maxOutstanding: 1, maxReady: 1, maxQueue: 4,
      deadlineMs: 3_600_000, ...options.schedulerBudget },
    onState: state,
    async execute(candidate, signal) {
      const slot = byCandidate.get(candidate.id);
      if (!slot || signal.aborted || slot.controller.signal.aborted) return undefined;
      const receipt = issuer.issue(candidate);
      authorityForWarmupCandidate("ssh", receipt, candidate.args);
      const plan = slot.authority.seal(slot.projected);
      if (!plan) return undefined;
      const crashRecovery = options.recovery?.prepare(candidate.id, plan);
      const abort = () => slot.controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const lease = createSshWarmupLease({
        plan,
        signal: slot.controller.signal,
        timeoutMs: options.schedulerBudget?.deadlineMs ?? 3_600_000,
        ...(options.driver ? { driver: options.driver } : {}),
        ...(options.assertExecutable ? { assertExecutable: options.assertExecutable } : {}),
        ...(crashRecovery ? { crashRecovery } : {}),
        approval: async (request, transport, approvalSignal) => {
          slot.approvalAttempted = true;
          const prepared = await options.service.requestOperationApproval(request, transport, approvalSignal);
          if (!prepared.ok) slot.refusal = slot.authority.format(prepared.result);
          return prepared;
        },
      });
      try {
        lease.start();
        await lease.ready();
        return { value: { lease, plan }, dispose: () => lease.dispose() };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });

  const forget = (slot: Slot): void => {
    if (byCall.get(slot.callId) === slot) byCall.delete(slot.callId);
    if (byCandidate.get(slot.candidateId) === slot) byCandidate.delete(slot.candidateId);
  };
  const reset = (): void => {
    scheduler.invalidate();
    for (const slot of byCall.values()) {
      if (slot.approvalAttempted) blockedCalls.add(slot.callId);
      slot.controller.abort();
    }
    byCall.clear(); byCandidate.clear();
  };
  const wrap = (tool: AgentTool, authority: SshExactToolAuthority): AgentTool => {
    const cached = wrappers.get(tool);
    if (cached) return cached;
    const wrapped: AgentTool = { ...tool, async execute(callId, args, signal, onUpdate) {
      const slot = byCall.get(callId);
      if (!slot) return blockedCalls.has(callId)
        ? failure(authority, "warmup_cancelled_after_approval")
        : tool.execute(callId, args, signal, onUpdate);
      const candidate = createSpeculationCandidate({ tool: "ssh", args,
        provenance: { kind: "queued_exact", callId } }, { tier: 3, maxCallBytes: options.schedulerBudget?.maxCallBytes ?? 64 * 1024 });
      if (!candidate || candidate.keyDigest !== slot.keyDigest) {
        slot.controller.abort();
        if (!slot.approvalAttempted) { forget(slot); return tool.execute(callId, args, signal, onUpdate); }
        return failure(authority, "foreground_mismatch_after_approval");
      }
      const abort = () => slot.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const task = consumeForeground(slot, scheduler, tool, signal);
      foregroundTasks.add(task);
      try { return await task; } finally {
        signal?.removeEventListener("abort", abort);
        foregroundTasks.delete(task);
        if (slot.approvalAttempted) blockedCalls.add(callId);
        forget(slot);
      }
    } };
    wrappers.set(tool, wrapped);
    return wrapped;
  };

  return {
    project(input) {
      if (disposed) throw new SpeculationServiceError();
      if (!enabled) return { revision, tools: input.projected };
      const actual = uniqueSsh(input.available);
      const projected = uniqueSsh(input.projected);
      const authority = actual && projected === actual ? sshExactToolAuthority(actual, options.service) : undefined;
      if (actual !== boundTool || authority !== boundAuthority) {
        reset(); boundTool = actual; boundAuthority = authority; revision += 1;
      }
      return { revision, tools: input.projected.map((tool) => authority && tool === actual ? wrap(tool, authority) : tool) };
    },
    observeAgentEvent(event: AgentEvent) {
      if (!enabled || disposed || !boundAuthority) return;
      const exact = exactSshCall(event);
      if (!exact || byCall.has(exact.callId) || blockedCalls.has(exact.callId)) return;
      const projected = boundAuthority.project(exact.args);
      if (!projected) return;
      const receipt = scheduler.enqueue({ tool: "ssh", args: exact.args,
        provenance: { kind: "queued_exact", callId: exact.callId } });
      if (!receipt.accepted) return;
      const terminalGate = createTerminalGate();
      const slot: Slot = { callId: exact.callId, candidateId: receipt.id, keyDigest: receipt.keyDigest,
        projected, authority: boundAuthority, controller: new AbortController(),
        gate: terminalGate.promise, settle: terminalGate.resolve,
        approvalAttempted: false, resolved: false };
      byCall.set(exact.callId, slot); byCandidate.set(receipt.id, slot);
    },
    observeToolResult(result) { if (result.tool === "ssh") blockedCalls.delete(result.callId); },
    assertHealthy() { if (callbackFailure) throw callbackFailure; },
    idle: async () => { await scheduler.idle(); while (foregroundTasks.size > 0) await Promise.allSettled([...foregroundTasks]); },
    invalidate() { reset(); revision += 1; },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      for (const slot of byCall.values()) slot.controller.abort();
      byCall.clear(); byCandidate.clear();
    },
    snapshot() { const value = scheduler.snapshot(); return { revision,
      scheduled: value.scheduled.queuedExact, ready: value.ready, taken: value.taken.queuedExact,
      tracked: byCall.size + blockedCalls.size, callbackFailures: callbackFailure ? 1 : 0, disposed } as const; },
  };

  async function consumeForeground(
    slot: Slot,
    candidateScheduler: typeof scheduler,
    original: AgentTool,
    signal?: AbortSignal,
  ) {
    const terminal = await slot.gate;
    if (terminal.kind === "fallback") {
      return original.execute(slot.callId, { op: "exec", ...slot.projected.request }, signal);
    }
    if (terminal.kind === "refused") return terminal.result;
    if (terminal.kind === "failed_after_approval") return failure(slot.authority, "warmup_failed_after_approval");
    const owned = candidateScheduler.take(slot.candidateId);
    const consumption = owned?.value.lease.tryConsume(owned.value.plan.authority);
    if (!owned || !consumption) return failure(slot.authority, "warmup_unavailable_after_approval");
    let result: { ok: true; value: AgentToolResult<unknown> } | { ok: false; error: unknown };
    try { result = { ok: true, value: await slot.authority.executeApproved(owned.value.plan, consumption.value, signal) }; }
    catch (error) { result = { ok: false, error }; }
    await Promise.allSettled([consumption.dispose()]);
    if (!result.ok) throw result.error;
    resolve(slot, "hit");
    return result.value;
  }
}

function uniqueSsh(tools: readonly AgentTool[]): AgentTool | undefined {
  const matches = tools.filter((tool) => tool.name === "ssh");
  return matches.length === 1 ? matches[0] : undefined;
}

function exactSshCall(event: AgentEvent): { readonly callId: string; readonly args: unknown } | undefined {
  if (event.type !== "message_update" || event.message.role !== "assistant" ||
    event.assistantMessageEvent.type !== "toolcall_end" || event.assistantMessageEvent.toolCall.name !== "ssh") return undefined;
  return { callId: event.assistantMessageEvent.toolCall.id, args: event.assistantMessageEvent.toolCall.arguments };
}

function failure(authority: SshExactToolAuthority, reason: string): AgentToolResult<unknown> {
  return authority.format({ error: true, text: `ssh state=${reason}; no second connection started` });
}

function createTerminalGate(): Readonly<{
  promise: Promise<Terminal>;
  resolve: (terminal: Terminal) => void;
}> {
  let resolve = (_terminal: Terminal): void => { throw new Error("SSH Tier 3 gate is not initialized"); };
  const promise = new Promise<Terminal>((done) => { resolve = done; });
  return { promise, resolve };
}
function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}
