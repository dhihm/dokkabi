import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
  CandidateProvenance,
  CandidateSeed,
  PredictionCandidateSeed,
  PredictionSource,
  SpeculationCandidate,
  SpeculationTier,
} from "./candidates.ts";

export type CandidateSource = CandidateProvenance["kind"];
export type SchedulerDropReason =
  | "invalid"
  | "unsupported"
  | "duplicate"
  | "queue_full"
  | "disposed"
  | "deadline"
  | "failed"
  | "publication_failed"
  | "ready_full";

export type CandidateToolPolicy = {
  readonly name: string;
  readonly prediction?: SpeculationTier;
  readonly queuedExact?: SpeculationTier;
  readonly authorizedRecipe?: SpeculationTier;
};

export type CandidateSchedulerBudget = {
  readonly maxQueue: number;
  readonly maxQueueBytes: number;
  readonly maxCallBytes: number;
  readonly maxConcurrency: number;
  readonly maxOutstanding: number;
  readonly maxReady: number;
  readonly deadlineMs: number;
};

export type SchedulerReceipt =
  | {
    readonly accepted: true;
    readonly id: string;
    readonly keyDigest: string;
    readonly tool: string;
    readonly tier: SpeculationTier;
    readonly source: CandidateSource;
    readonly predictionSource: PredictionSource | undefined;
    readonly signal: AbortSignal;
  }
  | {
    readonly accepted: false;
    readonly keyDigest: string | undefined;
    readonly reason: SchedulerDropReason;
  };

export type SchedulerStateEvent = {
  readonly phase: "scheduled" | "ready" | "dropped" | "taken" | "disposed" | "cleanup_failed";
  readonly id: string;
  readonly keyDigest: string;
  readonly tool: string;
  readonly tier: SpeculationTier;
  readonly source: CandidateSource;
  readonly predictionSource: PredictionSource | undefined;
  readonly reason: SchedulerDropReason | undefined;
};

export type ScheduledCandidate = SpeculationCandidate & { readonly id: string };
export type PreparedCandidate<Ready> = {
  readonly value: Ready;
  readonly dispose?: () => void | Promise<void>;
};
export type OwnedCandidate<Ready> = PreparedCandidate<Ready> & {
  readonly candidate: ScheduledCandidate;
};
export type SourceCounts = {
  readonly prediction: number;
  readonly queuedExact: number;
  readonly authorizedRecipe: number;
};
export type CandidateSchedulerSnapshot = {
  readonly scheduled: SourceCounts;
  readonly dropped: SourceCounts;
  readonly readyBySource: SourceCounts;
  readonly taken: SourceCounts;
  readonly queued: number;
  readonly active: number;
  readonly outstanding: number;
  readonly ready: number;
  readonly queuedBytes: number;
  readonly pendingPrediction: boolean;
  readonly cleanupFailures: number;
  readonly pendingCleanup: number;
  readonly disposed: boolean;
};

export interface CandidateScheduler<Ready> {
  enqueue(seed: CandidateSeed): SchedulerReceipt;
  deferPrediction(producer: () => readonly PredictionCandidateSeed[]): boolean;
  observeAgentEvent(event: AgentEvent): SchedulerReceipt | undefined;
  take(candidateId: string): OwnedCandidate<Ready> | undefined;
  reloadBudget(budget: Partial<CandidateSchedulerBudget>): void;
  idle(): Promise<void>;
  snapshot(): CandidateSchedulerSnapshot;
  invalidate(): void;
  dispose(): void;
}

export type CandidateSchedulerOptions<Ready> = {
  readonly tools: readonly CandidateToolPolicy[];
  readonly execute: (
    candidate: ScheduledCandidate,
    signal: AbortSignal,
  ) => Promise<PreparedCandidate<Ready> | undefined>;
  readonly budget?: Partial<CandidateSchedulerBudget>;
  readonly nonce?: string;
  readonly onState?: (event: SchedulerStateEvent) => boolean | void;
};
