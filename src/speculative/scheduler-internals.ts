import { createHash } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { CandidateSeed, SpeculationTier } from "./candidates.ts";
import type {
  CandidateSchedulerBudget,
  CandidateSource,
  CandidateToolPolicy,
  PreparedCandidate,
  ScheduledCandidate,
  SchedulerDropReason,
  SchedulerReceipt,
  SourceCounts,
} from "./scheduler-types.ts";

export const DEFAULT_BUDGET: CandidateSchedulerBudget = Object.freeze({
  maxQueue: 32,
  maxQueueBytes: 2 * 1024 * 1024,
  maxCallBytes: 64 * 1024,
  maxConcurrency: 4,
  maxOutstanding: 8,
  maxReady: 32,
  deadlineMs: 2_000,
});

export type MutableCounts = { prediction: number; queuedExact: number; authorizedRecipe: number };
export type QueueItem = {
  readonly candidate: ScheduledCandidate;
  readonly controller: AbortController;
  readonly source: CandidateSource;
  readonly generation: number;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};
export type ReadyEntry<Ready> = {
  readonly item: QueueItem;
  readonly prepared: PreparedCandidate<Ready>;
};
export type PreparedInspection<Ready> =
  | { readonly kind: "ready"; readonly prepared: PreparedCandidate<Ready> }
  | { readonly kind: "rejected"; readonly dispose: (() => void | Promise<void>) | undefined };

export function compilePolicies(
  tools: readonly CandidateToolPolicy[],
): ReadonlyMap<string, CandidateToolPolicy> {
  const policies = new Map<string, CandidateToolPolicy>();
  for (const tool of tools) {
    if (!policies.has(tool.name)) policies.set(tool.name, Object.freeze({ ...tool }));
  }
  return policies;
}

export function classify(
  policies: ReadonlyMap<string, CandidateToolPolicy>,
  seed: CandidateSeed,
): { readonly tier: SpeculationTier; readonly source: CandidateSource } | undefined {
  try {
    const policy = policies.get(seed.tool);
    if (!policy) return undefined;
    switch (seed.provenance.kind) {
      case "prediction":
        return policy.prediction ? { tier: policy.prediction, source: "prediction" } : undefined;
      case "queued_exact":
        return policy.queuedExact ? { tier: policy.queuedExact, source: "queued_exact" } : undefined;
      case "authorized_recipe":
        return policy.authorizedRecipe
          ? { tier: policy.authorizedRecipe, source: "authorized_recipe" }
          : undefined;
    }
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}

export function exactSeed(event: AgentEvent): CandidateSeed | undefined {
  try {
    if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
    const update = event.assistantMessageEvent;
    if (update.type !== "toolcall_end") return undefined;
    return {
      tool: update.toolCall.name,
      args: update.toolCall.arguments,
      provenance: { kind: "queued_exact", callId: update.toolCall.id },
    };
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}

export function inspectPrepared<Ready>(value: unknown): PreparedInspection<Ready> {
  try {
    if (value === null || typeof value !== "object") return { kind: "rejected", dispose: undefined };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { kind: "rejected", dispose: undefined };
    const result = Object.getOwnPropertyDescriptor(value, "value");
    const disposer = Object.getOwnPropertyDescriptor(value, "dispose");
    const dispose = disposer && "value" in disposer && typeof disposer.value === "function"
      ? disposer.value
      : undefined;
    if (!result || !("value" in result)) return { kind: "rejected", dispose };
    if (disposer && (!("value" in disposer) || (disposer.value !== undefined && !dispose))) {
      return { kind: "rejected", dispose: undefined };
    }
    return {
      kind: "ready",
      prepared: dispose ? { value: result.value, dispose } : { value: result.value },
    };
  } catch (error) {
    if (error instanceof Error) return { kind: "rejected", dispose: undefined };
    return { kind: "rejected", dispose: undefined };
  }
}

export function normalizeBudget(
  input: Partial<CandidateSchedulerBudget> | undefined,
  fallback: CandidateSchedulerBudget,
): CandidateSchedulerBudget {
  return Object.freeze({
    maxQueue: positive(input?.maxQueue, fallback.maxQueue),
    maxQueueBytes: positive(input?.maxQueueBytes, fallback.maxQueueBytes),
    maxCallBytes: positive(input?.maxCallBytes, fallback.maxCallBytes),
    maxConcurrency: positive(input?.maxConcurrency, fallback.maxConcurrency),
    maxOutstanding: positive(input?.maxOutstanding, fallback.maxOutstanding),
    maxReady: positive(input?.maxReady, fallback.maxReady),
    deadlineMs: positive(input?.deadlineMs, fallback.deadlineMs),
  });
}

export function attemptId(nonce: string, attempt: number, key: string, source: CandidateSource): string {
  return createHash("sha256").update(`${nonce}:${attempt}:${key}:${source}`, "utf8").digest("hex");
}

export function emptyCounts(): MutableCounts {
  return { prediction: 0, queuedExact: 0, authorizedRecipe: 0 };
}

export function copyCounts(counts: MutableCounts): SourceCounts {
  return Object.freeze({ ...counts });
}

export function increment(counts: MutableCounts, source: CandidateSource): void {
  switch (source) {
    case "prediction": counts.prediction += 1; return;
    case "queued_exact": counts.queuedExact += 1; return;
    case "authorized_recipe": counts.authorizedRecipe += 1; return;
  }
}

export function rejected(reason: SchedulerDropReason, keyDigest?: string): SchedulerReceipt {
  return Object.freeze({ accepted: false, keyDigest, reason });
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
