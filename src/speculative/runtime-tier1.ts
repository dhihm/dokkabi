import type { AgentEvent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createSpeculationCandidate } from "./candidates.ts";
import { earlyExecutionLease } from "../host/received-calls.ts";
import { createExactCallCache } from "./exact-cache.ts";
import type { ExactCacheEvent } from "./exact-cache-types.ts";
import { createTier1Providers, TIER1_PROVIDER_NAMES, type Tier1ProviderName } from "./providers/index.ts";
import { predictionProducer } from "./runtime-tier1-predict.ts";
import { createTier1RuntimeBudget, type Tier1RuntimeBudget } from "./runtime-tier1-budget.ts";
import type { Tier1Ready, Tier1ResolutionOutcome, Tier1Runtime, Tier1RuntimeOptions } from "./runtime-tier1-types.ts";
import { createCandidateScheduler } from "./scheduler.ts";
import type { CandidateToolPolicy, ScheduledCandidate, SchedulerStateEvent } from "./scheduler-types.ts";
import { SpeculationServiceError, type SpeculationToolResult } from "./service.ts";
export type { Tier1Resolution, Tier1ResolutionOutcome, Tier1Runtime, Tier1RuntimeOptions, Tier1RuntimeSnapshot } from "./runtime-tier1-types.ts";
export { createTier1RuntimeBudget, type Tier1RuntimeBudget, type Tier1RuntimeBudgetSnapshot } from "./runtime-tier1-budget.ts";

type Provider = NonNullable<ReturnType<typeof createTier1Providers>[Tier1ProviderName]>;
type Binding = ReturnType<typeof createBinding>;

export function createTier1Runtime(options: Tier1RuntimeOptions): Tier1Runtime {
  let revision = 0;
  let turn = 0;
  let disposed = false;
  let binding: Binding | undefined;
  const retired = new Set<Promise<void>>();
  const enabled = options.mode !== "off" && options.replay !== true;
  const sharedBudget = options.sharedBudget ?? createTier1RuntimeBudget();
  const closeBinding = (): void => {
    const current = binding;
    if (!current) return;
    current.dispose();
    binding = undefined;
    const cleanup = current.idle();
    retired.add(cleanup);
    void cleanup.then(() => retired.delete(cleanup), () => retired.delete(cleanup));
  };
  return {
    project(input) {
      if (disposed) throw new SpeculationServiceError();
      if (!enabled) return { revision, tools: input.projected };
      const authorized = authorizedTools(input.available, input.projected);
      if (!binding?.matches(authorized)) {
        closeBinding();
        binding = createBinding(options, authorized, sharedBudget);
        revision += 1;
      }
      return { revision, tools: input.projected.map((tool) => binding?.wrap(tool) ?? tool) };
    },
    observeAgentEvent(event: AgentEvent) { if (enabled && !disposed) binding?.observe(event); },
    observeToolResult(result: SpeculationToolResult) {
      if (!enabled || disposed || !binding) return;
      turn += 1;
      binding.predict(predictionProducer(options.predictor, options.rulesV1, options.workspaceRoot, result, turn));
    },
    idle: async () => {
      await binding?.idle();
      while (retired.size > 0) await Promise.all([...retired]);
    },
    invalidate() { closeBinding(); revision += 1; },
    dispose() { if (disposed) return; disposed = true; closeBinding(); },
    snapshot() {
      const value = binding?.snapshot();
      return { revision, scheduled: value?.scheduled ?? 0, ready: value?.ready ?? 0,
        taken: value?.taken ?? 0, cacheEntries: value?.cacheEntries ?? 0,
        tracked: value?.tracked ?? 0, disposed };
    },
  };
}

function createBinding(
  options: Tier1RuntimeOptions,
  tools: readonly AgentTool[],
  sharedBudget: Tier1RuntimeBudget,
) {
  const providers = createTier1Providers({ workspaceRoot: options.workspaceRoot, tools,
    ...(options.providerLimits ? { limits: options.providerLimits } : {}),
    ...(options.gitAuthority ? { gitAuthority: options.gitAuthority } : {}),
    ...(options.probeAuthority ? { probeAuthority: options.probeAuthority } : {}) });
  const actualTasks = new Set<Promise<void>>();
  const trackedProviders = trackProviders(providers, actualTasks, sharedBudget);
  const ids = new Map<string, string>();
  const cacheIds = new Map<string, string>();
  const candidateKeys = new Map<string, string>();
  const cacheKeys = new Map<string, string>();
  const outcomes = new Map<string, ExactCacheEvent["outcome"] | Tier1ResolutionOutcome>();
  const foreground = new Set<string>();
  // #224 SO-O2: an early start for a call whose exact candidate is queued or
  // in flight waits for that candidate to settle (ready, dropped, disposed)
  // and adopts it, instead of running a second execution of the same
  // identity. Pi's ordinary point never waits (unchanged): a candidate not
  // ready by then is cancelled and the tool runs in the foreground.
  const settledWaiters = new Map<string, Array<() => void>>();
  const settledIds = new Set<string>();
  const notifySettled = (id: string): void => {
    settledIds.add(id);
    const waiters = settledWaiters.get(id);
    if (!waiters) return;
    settledWaiters.delete(id);
    for (const resolve of waiters) resolve();
  };
  const awaitSettled = (id: string, signal: AbortSignal | undefined): Promise<void> => new Promise((resolve) => {
    // Already settled (ready, dropped, disposed, taken) or never scheduled here: nothing to wait for.
    if (signal?.aborted || settledIds.has(id) || !candidateKeys.has(id)) { resolve(); return; }
    const waiters = settledWaiters.get(id) ?? [];
    const done = (): void => { signal?.removeEventListener("abort", done); resolve(); };
    waiters.push(done);
    settledWaiters.set(id, waiters);
    signal?.addEventListener("abort", done, { once: true });
  });
  let active: ScheduledCandidate | undefined;
  const cache = createExactCallCache({ ...options.cacheBudget, onEvent(event) {
    if (event.outcome === "scheduled" && active) {
      cacheIds.set(event.keyDigest, active.id);
      cacheKeys.set(active.id, event.keyDigest);
    }
    const id = cacheIds.get(event.keyDigest);
    if (id) outcomes.set(id, event.outcome);
    options.onMiss?.(event);
  } });
  const forget = (id: string): void => {
    const candidateKey = candidateKeys.get(id);
    if (candidateKey && ids.get(candidateKey) === id) ids.delete(candidateKey);
    const cacheKey = cacheKeys.get(id);
    if (cacheKey && cacheIds.get(cacheKey) === id) cacheIds.delete(cacheKey);
    candidateKeys.delete(id);
    cacheKeys.delete(id);
    outcomes.delete(id);
    foreground.delete(id);
    settledIds.delete(id);
    notifySettled(id);
    settledIds.delete(id);
  };
  const resolve = (id: string, outcome: Tier1ResolutionOutcome): boolean => {
    try {
      const accepted = options.onResolve?.({ candidateId: id, outcome }) !== false;
      forget(id);
      return accepted;
    } catch { forget(id); return false; }
  };
  const state = (event: SchedulerStateEvent): boolean => {
    try {
      if (options.onState?.(event) === false) {
        if (event.phase === "dropped" || event.phase === "disposed") forget(event.id);
        return false;
      }
      if (event.phase === "scheduled") {
        ids.set(event.keyDigest, event.id);
        candidateKeys.set(event.id, event.keyDigest);
      }
      if (event.phase === "dropped") resolve(event.id, resolutionFor(outcomes.get(event.id)));
      if (event.phase === "disposed") resolve(event.id, "cancelled");
      if (event.phase === "ready" || event.phase === "dropped" || event.phase === "disposed" || event.phase === "taken") notifySettled(event.id);
      return true;
    } catch {
      if (event.phase === "dropped" || event.phase === "disposed") { forget(event.id); notifySettled(event.id); }
      return false;
    }
  };
  const scheduler = createCandidateScheduler<Tier1Ready>({
    tools: TIER1_PROVIDER_NAMES.flatMap((name) => trackedProviders.get(name) ? [toolPolicy(name)] : []),
    ...(options.schedulerBudget ? { budget: options.schedulerBudget } : {}), onState: state,
    async execute(candidate, signal) {
      if (foreground.has(candidate.id)) { outcomes.set(candidate.id, "cancelled"); return undefined; }
      active = candidate;
      const provider = trackedProviders.get(candidate.tool);
      if (!provider || !cache.schedule(provider, { tool: candidate.tool, args: candidate.args }, signal)) {
        outcomes.set(candidate.id, signal.aborted ? "cancelled" : "drop");
        return undefined;
      }
      await cache.idle();
      active = undefined;
      if (foreground.has(candidate.id)) { outcomes.set(candidate.id, "cancelled"); return undefined; }
      const outcome = outcomes.get(candidate.id);
      if (outcome === "warm-only" || outcome === "drop" || signal.aborted) return undefined;
      return { value: { keyDigest: candidate.keyDigest } };
    },
  });
  const wrappers = new Map<AgentTool, AgentTool>();
  return {
    wrap(tool: AgentTool): AgentTool {
      const existing = wrappers.get(tool);
      if (existing) return existing;
      const provider = trackedProviders.get(tool.name);
      if (!provider) return tool;
      const wrapped: AgentTool = { ...tool, async execute(callId, args, signal, onUpdate) {
        const candidate = createSpeculationCandidate({ tool: tool.name, args,
          provenance: { kind: "prediction", source: "output" } }, { tier: 1, maxCallBytes: options.schedulerBudget?.maxCallBytes ?? 64 * 1024 });
        let id = candidate ? ids.get(candidate.keyDigest) : undefined;
        if (id && earlyExecutionLease() !== undefined && !foreground.has(id)) {
          // #224 SO-O2: adopt, never duplicate — wait for the owner's own
          // candidate to settle (bounded by the scheduler deadline and the
          // early lease's own signal), then take it if it is ready.
          await awaitSettled(id, signal);
          id = candidate ? ids.get(candidate.keyDigest) : undefined;
        }
        if (id && scheduler.take(id)) {
          const authorized = validateReuse(options, tool);
          const hit = cache.take(provider, { tool: tool.name, args });
          const outcome = outcomes.get(id);
          if (authorized && isToolResult(hit) && resolve(id, "hit")) return hit;
          if (!authorized) resolve(id, "cancelled");
          else if (!isToolResult(hit)) resolve(id, outcome === "stale" ? "stale" : "drop");
        } else if (id) {
          foreground.add(id);
          cache.take(provider, { tool: tool.name, args });
        }
        return tool.execute(callId, args, signal, onUpdate);
      } };
      wrappers.set(tool, wrapped);
      return wrapped;
    },
    matches: (next: readonly AgentTool[]) => next.length === tools.length
      && next.every((tool, index) => tool === tools[index]),
    observe: (event: AgentEvent) => { scheduler.observeAgentEvent(event); },
    predict: (producer: () => readonly import("./candidates.ts").PredictionCandidateSeed[]) => { scheduler.deferPrediction(producer); },
    idle: async () => {
      await scheduler.idle();
      await cache.idle();
      while (actualTasks.size > 0) await Promise.all([...actualTasks]);
    },
    snapshot: () => { const s = scheduler.snapshot(); return {
      scheduled: s.scheduled.prediction + s.scheduled.queuedExact,
      ready: s.ready, taken: s.taken.prediction + s.taken.queuedExact, cacheEntries: cache.snapshot().entries,
      tracked: candidateKeys.size,
    }; },
    dispose: () => { scheduler.dispose(); cache.dispose(); },
  };
}

function validateReuse(options: Tier1RuntimeOptions, tool: AgentTool): boolean {
  try {
    return options.validateForegroundReuse?.(tool) !== false;
  } catch (error) {
    if (error instanceof Error) return false;
    return false;
  }
}

function resolutionFor(outcome: ExactCacheEvent["outcome"] | Tier1ResolutionOutcome | undefined): Tier1ResolutionOutcome {
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "warm-only") return "warm_only";
  if (outcome === "stale") return "stale";
  if (outcome === "drop") return "drop";
  return "failed";
}

function trackProviders(
  providers: ReturnType<typeof createTier1Providers>,
  actualTasks: Set<Promise<void>>,
  sharedBudget: Tier1RuntimeBudget,
): ReadonlyMap<string, Provider> {
  const tracked = new Map<string, Provider>();
  for (const name of TIER1_PROVIDER_NAMES) {
    const provider = providers[name];
    if (!provider) continue;
    tracked.set(name, { name: provider.name, async prepare(call, signal) {
      const operation = sharedBudget.run(signal, () => provider.prepare(call, signal));
      if (!operation) return { kind: "warm-only" };
      const settled = operation.then(() => undefined, () => undefined);
      actualTasks.add(settled);
      void settled.then(() => actualTasks.delete(settled));
      return await operation;
    } });
  }
  return tracked;
}

function toolPolicy(name: Tier1ProviderName): CandidateToolPolicy {
  return name === "read" ? { name, queuedExact: 1, prediction: 1 } : { name, queuedExact: 1 };
}

function authorizedTools(available: readonly AgentTool[], projected: readonly AgentTool[]): readonly AgentTool[] {
  const availableCounts = new Map<string, number>();
  const projectedCounts = new Map<string, number>();
  for (const tool of available) availableCounts.set(tool.name, (availableCounts.get(tool.name) ?? 0) + 1);
  for (const tool of projected) projectedCounts.set(tool.name, (projectedCounts.get(tool.name) ?? 0) + 1);
  return projected.filter((tool) => availableCounts.get(tool.name) === 1 && projectedCounts.get(tool.name) === 1);
}

function isToolResult(value: unknown): value is AgentToolResult<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "content");
  return Boolean(descriptor && "value" in descriptor && Array.isArray(descriptor.value));
}
