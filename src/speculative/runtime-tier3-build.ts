import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ForegroundBashReuse, WorkspaceBashReuseAuthority } from "../plugins/workspace-bash-reuse.ts";
import type { AuthorizedBuildCaseRecipe } from "../work/case-authority.ts";
import { takeBuildCase } from "../work/verify.ts";
import type { CandidateSeed } from "./candidates.ts";
import { createCandidateScheduler } from "./scheduler.ts";
import type { SchedulerReceipt, SchedulerStateEvent } from "./scheduler-types.ts";
import { SpeculationServiceError } from "./service.ts";
import type { BuildTier3ResolutionOutcome, BuildTier3Runtime, BuildTier3RuntimeOptions } from "./runtime-tier3-build-types.ts";
import { createSchedulerWarmupCandidateIssuer } from "./warmup/candidate.ts";
import { createWarmupRegistry, type WarmupLease } from "./warmup/registry.ts";
import { BUILD_TIER3_PROVIDER_DIGEST } from "./runtime-tier3-build-provider.ts";

export type * from "./runtime-tier3-build-types.ts";

export { BUILD_TIER3_PROVIDER_DIGEST } from "./runtime-tier3-build-provider.ts";

type Accepted = Extract<SchedulerReceipt, { readonly accepted: true }>;
type PreparedBuild = Readonly<{ lease: WarmupLease<ForegroundBashReuse>; recipe: AuthorizedBuildCaseRecipe }>;
type Slot = {
  readonly receipt: Accepted;
  readonly recipe: AuthorizedBuildCaseRecipe;
  readonly authority: WorkspaceBashReuseAuthority;
  readonly surface: AgentTool;
  resolved: boolean;
};
type Binding = Readonly<{
  available: readonly AgentTool[];
  projected: readonly AgentTool[];
  surface: AgentTool;
  authority: WorkspaceBashReuseAuthority;
}>;

export function createBuildTier3Runtime(options: BuildTier3RuntimeOptions): BuildTier3Runtime {
  const enabled = options.mode === "full";
  const issuer = createSchedulerWarmupCandidateIssuer();
  const registry = createWarmupRegistry();
  const slots = new Map<string, Slot>();
  const foregroundTasks = new Set<Promise<unknown>>();
  const recoveryTasks = new Set<Promise<unknown>>();
  const recoveryControllers = new Set<AbortController>();
  const wrappers = new WeakMap<AgentTool, AgentTool>();
  let binding: Binding | undefined;
  let revision = 0;
  let disposed = false;
  let callbackFailure: Error | undefined;
  let cleanupTask: Promise<void> | undefined;

  const rememberFailure = (error: unknown, message: string): void => {
    callbackFailure ??= error instanceof Error ? error : new BuildTier3PublicationError(message);
  };
  const resolve = (slot: Slot, outcome: BuildTier3ResolutionOutcome): void => {
    if (slot.resolved) return;
    slot.resolved = true;
    try {
      if (options.onResolve?.({ candidateId: slot.receipt.id, outcome }) === false) {
        rememberFailure(undefined, "build Tier 3 resolution publication rejected");
      }
    } catch (error) {
      rememberFailure(error, "build Tier 3 resolution publication failed");
    }
  };
  const state = (event: SchedulerStateEvent): boolean => {
    let accepted = true;
    try {
      accepted = options.onState?.(event) !== false;
    } catch (error) {
      rememberFailure(error, "build Tier 3 state publication failed");
      accepted = false;
    }
    if (event.phase === "dropped" || event.phase === "disposed") {
      const slot = slots.get(event.id);
      if (slot) {
        slots.delete(event.id);
        const outcome = event.phase === "disposed"
          ? "cancelled"
          : event.reason === "failed" ? "failed" : "drop";
        resolve(slot, outcome);
      }
    }
    return accepted;
  };
  const scheduler = createCandidateScheduler<PreparedBuild>({
    tools: enabled ? [{ name: "bash", authorizedRecipe: 3 }] : [],
    ...(options.schedulerBudget ? { budget: options.schedulerBudget } : {}),
    onState: state,
    async execute(candidate, signal) {
      const slot = slots.get(candidate.id);
      if (!slot || signal.aborted) return undefined;
      const lease = slot.authority.prepare(slot.surface, {
        registry,
        receipt: issuer.issue(candidate),
        recipe: slot.recipe,
        workspaceRoot: options.workspaceRoot,
        ...(options.log ? { log: options.log } : {}),
        signal,
        timeoutMs: options.schedulerBudget?.deadlineMs ?? 30_000,
        candidateId: candidate.id,
        ...(options.recovery ? { recovery: options.recovery } : {}),
      });
      if (!lease) return undefined;
      lease.start();
      await lease.ready();
      return { value: { lease, recipe: slot.recipe }, dispose: () => lease.dispose() };
    },
  });

  const invalidate = (): void => {
    for (const controller of recoveryControllers) controller.abort();
    recoveryControllers.clear();
    scheduler.invalidate();
    slots.clear();
    revision += 1;
  };
  const wrap = (surface: AgentTool): AgentTool => {
    const cached = wrappers.get(surface);
    if (cached) return cached;
    const wrapped: AgentTool = {
      ...surface,
      execute(callId, args, signal, onUpdate) {
        if (disposed || binding?.surface !== surface) return surface.execute(callId, args, signal, onUpdate);
        for (const slot of slots.values()) {
          if (!slot.authority.matches(surface, slot.recipe, args)) continue;
          const owned = scheduler.take(slot.receipt.id);
          if (!owned) continue;
          slots.delete(slot.receipt.id);
          const task = consumeBuild(slot, owned.value, surface, callId, args, signal, onUpdate);
          foregroundTasks.add(task);
          void task.then(
            () => foregroundTasks.delete(task),
            () => foregroundTasks.delete(task),
          );
          return task;
        }
        return surface.execute(callId, args, signal, onUpdate);
      },
    };
    wrappers.set(surface, wrapped);
    return wrapped;
  };

  return {
    project(input) {
      if (disposed) throw new SpeculationServiceError();
      if (!enabled) return { revision, tools: input.projected };
      if (!binding || !sameTools(binding.available, input.available) || !sameTools(binding.projected, input.projected)) {
        invalidate();
        const authority = options.createBashReuseAuthority(input.available, input.projected);
        const surface = uniqueBash(input.projected);
        binding = authority && surface ? { available: [...input.available], projected: [...input.projected], surface, authority } : undefined;
      }
      return { revision, tools: input.projected.map((tool) => binding?.surface === tool ? wrap(tool) : tool) };
    },
    observeAgentEvent() {},
    observeToolResult() {},
    stageAuthorizedBuilds(dispatch, recipeIds) {
      if (!enabled || disposed || !binding) return [];
      const receipts: SchedulerReceipt[] = [];
      for (const recipeId of recipeIds) {
        const recipe = takeBuildCase(dispatch, recipeId);
        if (!recipe) continue;
        const args = binding.authority.candidateArgs(binding.surface, recipe);
        if (!args) continue;
        const seed: CandidateSeed = { tool: "bash", args, provenance: { kind: "authorized_recipe", recipeId } };
        const receipt = scheduler.enqueue(seed);
        receipts.push(receipt);
        if (receipt.accepted) slots.set(receipt.id, { receipt, recipe, authority: binding.authority, surface: binding.surface, resolved: false });
      }
      return Object.freeze(receipts);
    },
    recoverPending(candidateIds) {
      if (!enabled || disposed || !binding || !options.recovery) return Promise.resolve([]);
      const controller = new AbortController();
      recoveryControllers.add(controller);
      const task = binding.authority.recover(binding.surface, options.recovery, candidateIds, controller.signal)
        .catch((error: unknown) => {
          rememberFailure(error, "build Tier 3 recovery failed");
          throw error;
        });
      recoveryTasks.add(task);
      void task.then(
        () => { recoveryTasks.delete(task); recoveryControllers.delete(controller); },
        () => { recoveryTasks.delete(task); recoveryControllers.delete(controller); },
      );
      return task;
    },
    snapshot() {
      const value = scheduler.snapshot();
      return Object.freeze({ revision, scheduled: value.scheduled.authorizedRecipe,
        ready: value.ready, taken: value.taken.authorizedRecipe, tracked: slots.size,
        callbackFailures: callbackFailure ? 1 : 0, disposed });
    },
    assertHealthy() { if (callbackFailure) throw callbackFailure; },
    async idle() {
      await scheduler.idle();
      while (foregroundTasks.size > 0) await Promise.allSettled([...foregroundTasks]);
      while (recoveryTasks.size > 0) await Promise.allSettled([...recoveryTasks]);
      await cleanupTask;
      if (callbackFailure) throw callbackFailure;
    },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      slots.clear();
      cleanupTask = scheduler.idle().then(() => registry.dispose()).catch((error: unknown) => {
        rememberFailure(error, "build Tier 3 cleanup failed");
      });
    },
  };

  async function consumeBuild(
    slot: Slot,
    prepared: PreparedBuild,
    surface: AgentTool,
    callId: string,
    args: unknown,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<AgentTool["execute"]>[3],
  ) {
    const consumed = prepared.lease.tryConsume(prepared.lease.authority);
    if (!consumed || !consumed.value.isCurrent()) {
      await consumed?.dispose();
      resolve(slot, "stale");
      return surface.execute(callId, args, signal, onUpdate);
    }
    const projected = slot.authority.project(surface, consumed.value);
    if (!projected) {
      await consumed.dispose();
      resolve(slot, "stale");
      return surface.execute(callId, args, signal, onUpdate);
    }
    try {
      return await projected.execute(callId, args, signal, onUpdate);
    } finally {
      await consumed.dispose();
      resolve(slot, "hit");
    }
  }
}

function uniqueBash(tools: readonly AgentTool[]): AgentTool | undefined {
  const matches = tools.filter((tool) => tool.name === "bash");
  return matches.length === 1 ? matches[0] : undefined;
}

function sameTools(left: readonly AgentTool[], right: readonly AgentTool[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

class BuildTier3PublicationError extends Error {
  readonly name = "BuildTier3PublicationError";
}
