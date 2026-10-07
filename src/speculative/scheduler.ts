import { createHash, randomBytes } from "node:crypto";
import {
  createSpeculationCandidate,
  type CandidateSeed,
} from "./candidates.ts";
import {
  DEFAULT_BUDGET,
  classify,
  compilePolicies,
  exactSeed,
  normalizeBudget,
  rejected,
} from "./scheduler-internals.ts";
import type {
  CandidateScheduler,
  CandidateSchedulerOptions,
  ScheduledCandidate,
  SchedulerReceipt,
} from "./scheduler-types.ts";
import { CandidateWorkQueue } from "./scheduler-work.ts";

const EXECUTING_CANDIDATES = new WeakSet<object>();

export function isExecutingScheduledCandidate(candidate: ScheduledCandidate): boolean {
  return EXECUTING_CANDIDATES.has(candidate);
}

export type {
  CandidateScheduler,
  CandidateSchedulerBudget,
  CandidateSchedulerOptions,
  CandidateSchedulerSnapshot,
  CandidateSource,
  CandidateToolPolicy,
  OwnedCandidate,
  PreparedCandidate,
  ScheduledCandidate,
  SchedulerDropReason,
  SchedulerReceipt,
  SchedulerStateEvent,
  SourceCounts,
} from "./scheduler-types.ts";

export function createCandidateScheduler<Ready>(
  options: CandidateSchedulerOptions<Ready>,
): CandidateScheduler<Ready> {
  const policies = compilePolicies(options.tools);
  const nonce = createHash("sha256").update(options.nonce ?? randomBytes(16)).digest("hex");
  const work = new CandidateWorkQueue({
    nonce,
    budget: normalizeBudget(options.budget, DEFAULT_BUDGET),
    execute: async (candidate, signal) => {
      EXECUTING_CANDIDATES.add(candidate);
      try {
        return await options.execute(candidate, signal);
      } finally {
        EXECUTING_CANDIDATES.delete(candidate);
      }
    },
    ...(options.onState ? { onState: options.onState } : {}),
  });
  const enqueue = (seed: CandidateSeed): SchedulerReceipt => {
    if (work.isDisposed) return rejected("disposed");
    const classification = classify(policies, seed);
    if (!classification) return rejected("unsupported");
    const candidate = createSpeculationCandidate(seed, {
      tier: classification.tier,
      maxCallBytes: work.maxCallBytes,
    });
    return candidate
      ? work.admit(candidate, classification.source)
      : work.reject(classification.source, "invalid");
  };
  return {
    enqueue,
    deferPrediction(producer) {
      return work.defer((limit) => {
        const seeds = producer();
        const count = Math.min(seeds.length, limit);
        for (let index = 0; index < count; index += 1) {
          const seed = seeds[index];
          if (seed) enqueue(seed);
        }
        if (seeds.length > count) work.reject("prediction", "queue_full");
      });
    },
    observeAgentEvent(event) {
      const seed = exactSeed(event);
      return seed ? enqueue(seed) : undefined;
    },
    take: (candidateId) => work.take(candidateId),
    reloadBudget: (budget) => work.reload(budget),
    idle: () => work.idle(),
    snapshot: () => work.snapshot(),
    invalidate: () => work.invalidate(false),
    dispose: () => work.invalidate(true),
  };
}
