import { admitRecoveryChild, recoveringChildLoop, type RecoveryChildInput } from "./recovery-child.ts";
import { join } from "node:path";
import { bootSession } from "../boot.ts";
import type { EventLog } from "../host/event-log.ts";
import type { LoopFacade } from "../loader/types.ts";
import type { ModelResilienceService } from "../plugins/model-resilience.ts";

/**
 * A work step runs in its OWN session (#77 T3).
 *
 * That is not an optimisation, it is what makes the design legal: the frozen
 * prefix is system prompt + tool schemas and `ALLOWED_SEAL_REASONS` is closed
 * to compaction | tools_changed | skill_set_changed, so a per-step prefix
 * would need a seal reason that does not exist (constitution 4). A fresh
 * session builds the same prefix from the same bytes and seals it for the
 * legitimate reason — and, because it has no transcript, the artifact slot
 * really is the whole world the step sees.
 *
 * The manifest is deliberately its own file rather than a copy of a role
 * manifest: `loop-pi` consumes `model_resilience` and `workspace-tools`
 * consumes `tool_contributions`, both NON-optionally, and an unsatisfied
 * consumer leaves the fiber `pending` with no plugin/skip and no
 * plugin/failed row — a step would then open with no loop, or with no tools,
 * and nothing in the log would say why.
 */

export interface WorkStepSession {
  readonly sessionId: string;
  readonly log: EventLog;
  readonly loop: LoopFacade;
  close(): Promise<void>;
}

export function workStepManifestPath(repoRoot: string): string {
  return join(repoRoot, "plugins", "manifest.work-step.json");
}

/** One session per step, named after it — the parent event that binds the
 * step's evidence carries this id, so a reader can open exactly that log. */
export function workStepSessionId(parentSessionId: string, stepId: string): string {
  return `${parentSessionId}-step-${stepId}`;
}

export async function openWorkStep(input: {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly repoRoot: string;
  readonly route: string;
  readonly modelId?: string;
  readonly manifestPath?: string;
  readonly recovery?: RecoveryChildInput;
}): Promise<WorkStepSession> {
  const admission = input.recovery ? admitRecoveryChild(input.recovery, input.sessionId) : undefined;
  const { ctx, runtime } = await bootSession({
    sessionId: admission?.sessionId ?? input.sessionId,
    workspaceRoot: input.workspaceRoot,
    manifestPath: input.manifestPath ?? workStepManifestPath(input.repoRoot),
    repoRoot: input.repoRoot,
  });
  // bootSession transfers ownership of the whole plugin runtime. Disposing it
  // is the only thing that stops the host sampler's interval, the compaction
  // sweeper's interval, and — the expensive one — the session's bash runtime
  // and every job backgrounded under it.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= runtime.dispose();
  const loop = ctx.loop;
  if (!ctx.llm || !loop) {
    await close();
    throw new Error("work step requires llm and loop capabilities");
  }
  try {
    ctx.llm.select(input.route, input.modelId);
    const active = ctx.llm.active();
    ctx.tryGet<ModelResilienceService>("model_resilience")?.setManualPrimary({
      route: ctx.llm.activeName,
      model: ctx.llm.activeModelId ?? active.defaultModelId() ?? "missing",
    });
  } catch (error) {
    await close();
    throw error;
  }
  let recovered: ReturnType<typeof recoveringChildLoop> | undefined;
  try { recovered = admission ? recoveringChildLoop(ctx, loop, admission) : undefined; }
  catch (error) { await close(); throw error; }
  return { sessionId: admission?.sessionId ?? input.sessionId, log: ctx.log, loop: recovered?.loop ?? loop, close: async () => { await close(); recovered?.settled(); } };
}
