export interface ExactCall {
  readonly tool: string;
  readonly args: unknown;
}

export type ExactPreparation<Result> =
  | {
    readonly kind: "reusable";
    readonly result: Result;
    readonly validate: () => boolean;
    readonly dispose?: () => void | Promise<void>;
  }
  | {
    readonly kind: "warm-only";
    readonly dispose?: () => void | Promise<void>;
  };

export interface ExactCallProvider<Result> {
  readonly name: string;
  /** Starts provider-owned work. Reusable results require a complete synchronous validate proof. */
  prepare(call: ExactCall, signal: AbortSignal): Promise<ExactPreparation<Result>>;
}

export type ExactCacheEventOutcome =
  | "scheduled"
  | "hit"
  | "stale"
  | "drop"
  | "warm-only"
  | "cleanup-failed";

export interface ExactCacheEvent {
  readonly outcome: ExactCacheEventOutcome;
  /** Digest-only identity; events never expose tool arguments or result bytes. */
  readonly keyDigest: string;
  readonly providerDigest: string;
}

export interface ExactCacheSnapshot {
  readonly scheduled: number;
  readonly hits: number;
  readonly stale: number;
  readonly dropped: number;
  readonly warmOnly: number;
  readonly entries: number;
  readonly inFlight: number;
  readonly outstanding: number;
  readonly totalBytes: number;
  readonly cleanupFailures: number;
  readonly pendingCleanup: number;
  readonly disposed: boolean;
}

export interface ExactCallCache {
  /** Admits background work without waiting; false means no provider work was started. */
  schedule<Result>(
    provider: ExactCallProvider<Result>,
    call: ExactCall,
    signal?: AbortSignal,
  ): boolean;
  /** Synchronously consumes one completed, exact, currently valid result and never waits. */
  take(provider: ExactCallProvider<unknown>, call: ExactCall): unknown;
  /** Waits for logical completion or timeout, but never hides abort-ignoring outstanding work. */
  idle(): Promise<void>;
  snapshot(): ExactCacheSnapshot;
  dispose(): void;
}

export interface ExactCacheEntry {
  readonly value: unknown;
  readonly bytes: number;
  readonly validate: () => boolean;
  readonly dispose?: () => void | Promise<void>;
  readonly digest: string;
  readonly providerDigest: string;
}

export interface PendingExactAttempt {
  readonly controller: AbortController;
  readonly finish: (
    outcome?: Exclude<ExactCacheEventOutcome, "scheduled" | "hit" | "cleanup-failed">,
  ) => void;
  closed: boolean;
}
