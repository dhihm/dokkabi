import { RecoveryTerminalError } from "../host/recovery.ts";
import type { HostContext, LoopFacade } from "../loader/types.ts";
import type { ModelResilienceService } from "../plugins/model-resilience.ts";
import { runTurnWithTransientRetry } from "./transient-retry.ts";
import { workRecoveryOperation } from "./recovery-operation.ts";

/** The existing work drivers keep their logic and budgets. This adapter only
 * enrolls each actual prompt/resume in the registered recovery owner. */
export function recoveringWorkLoop(ctx: HostContext, loop: LoopFacade, input: { unattended: boolean; requireRecovery?: boolean; order: string; defaultBudgetMs?: number; deadlineMs?: number; maxRequests?: number }): LoopFacade {
  const recovery = ctx.tryGet<ModelResilienceService>("model_resilience")?.recovery;
  if (input.unattended && input.requireRecovery && !recovery) throw new RecoveryTerminalError("unavailable");
  if (!input.unattended || !recovery) return loop;
  const operation = (options: Parameters<LoopFacade["prompt"]>[1], resume = false) => {
    // A prompt's scheduling boundary belongs to this call, not the retained
    // work wall. Completed ordinals may proceed to a later phase boundary.
    const admitted = workRecoveryOperation(ctx.log, {
      ...input, resume,
      maxRequests: minimum(input.maxRequests, options?.sessionBudget?.maxRequests),
      requestsSoFar: options?.sessionBudget?.requestsSoFar,
    });
    return { ...admitted, deadlineMs: minimum(admitted.deadlineMs, options?.sessionBudget?.deadlineMs) };
  };
  const invoke = async (options: Parameters<LoopFacade["prompt"]>[1], resume: boolean, run: () => Promise<void>) => {
    const admitted = operation(options, resume);
    // Durable reservations can precede usage rows (for example an interrupted
    // dispatch). The retained owner, not a stale driver counter, decides whether
    // another logical call may begin. Do not open an invalid zero-attempt episode.
    if (admitted.maxAttempts === 0) {
      ctx.log.append({ kind: "observe", name: "loop/budget_exhausted", payload: { scope: "session", reason: "requests", source: "retained_recovery_budget" } });
      return;
    }
    try { await runTurnWithTransientRetry({ run, unattended: true, recovery, operation: admitted }); }
    catch (error) {
      if (!(error instanceof RecoveryTerminalError) || error.reason !== "deadline" || !error.operation || !options?.sessionBudget?.yieldSettledRecovery) throw error;
      const state = recovery.snapshot(error.operation);
      if (state.state !== "exhausted" || state.inFlight) throw error;
      ctx.log.append({ kind: "observe", name: "work/recovery_boundary", payload: { episode_id: state.episodeId, reason: "deadline", scheduling_deadline_ms: admitted.deadlineMs ?? null } });
      ctx.log.append({ kind: "observe", name: "loop/budget_exhausted", payload: { scope: "session", reason: "deadline", source: "settled_recovery_boundary" } });
    }
  };
  return {
    ...loop,
    prompt: (text, options) => recovery.currentInput() ? loop.prompt(text, options) : invoke(options, false, () => loop.prompt(text, options)),
    ...(loop.resume ? { resume: (options: Parameters<NonNullable<LoopFacade["resume"]>>[0]) => recovery.currentInput() ? loop.resume!(options) : invoke(options, true, () => loop.resume!(options)) } : {}),
  };
}
function minimum(left?: number, right?: number): number | undefined {
  const value = Math.min(left ?? Infinity, right ?? Infinity);
  return Number.isFinite(value) ? value : undefined;
}
