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
  const operation = (options: Parameters<LoopFacade["prompt"]>[1], resume = false) => workRecoveryOperation(ctx.log, {
    ...input, resume,
    deadlineMs: minimum(input.deadlineMs, options?.sessionBudget?.deadlineMs),
    maxRequests: minimum(input.maxRequests, options?.sessionBudget?.maxRequests),
    requestsSoFar: options?.sessionBudget?.requestsSoFar,
  });
  return {
    ...loop,
    prompt: (text, options) => recovery.currentInput() ? loop.prompt(text, options) : runTurnWithTransientRetry({
      run: () => loop.prompt(text, options), unattended: true, recovery, operation: operation(options),
    }),
    ...(loop.resume ? { resume: (options: Parameters<NonNullable<LoopFacade["resume"]>>[0]) => recovery.currentInput() ? loop.resume!(options) : runTurnWithTransientRetry({
      run: () => loop.resume!(options), unattended: true, recovery, operation: operation(options, true),
    }) } : {}),
  };
}
function minimum(left?: number, right?: number): number | undefined {
  const value = Math.min(left ?? Infinity, right ?? Infinity);
  return Number.isFinite(value) ? value : undefined;
}
