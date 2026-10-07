export interface SpeculationSnapshot {
  readonly scheduled: number;
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly dropped: number;
}

export type SpeculationEvent =
  | { readonly outcome: "miss"; readonly keyDigest: string }
  | {
    readonly outcome: "resolved";
    readonly keyDigest: string;
    readonly resolution: "hit" | "stale" | "drop";
  };

export interface PrefetchLifecycle {
  begin(key: string, keyDigest: string): void;
  close(key: string, outcome: "hit" | "stale" | "drop"): void;
  miss(keyDigest?: string): void;
  closeAll(): void;
  snapshot(): SpeculationSnapshot;
}

export function createPrefetchLifecycle(
  onEvent?: (event: SpeculationEvent) => void,
): PrefetchLifecycle {
  const open = new Map<string, string>();
  const counts = { scheduled: 0, hits: 0, misses: 0, stale: 0, dropped: 0 };
  const emit = (event: SpeculationEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      return;
    }
  };
  const close = (key: string, outcome: "hit" | "stale" | "drop"): void => {
    const digest = open.get(key);
    if (!digest) return;
    open.delete(key);
    if (outcome === "hit") counts.hits += 1;
    else if (outcome === "stale") counts.stale += 1;
    else counts.dropped += 1;
    emit({ outcome: "resolved", resolution: outcome, keyDigest: digest });
  };
  return {
    begin(key, keyDigest) {
      counts.scheduled += 1;
      open.set(key, keyDigest);
    },
    close,
    miss(keyDigest) {
      counts.misses += 1;
      if (keyDigest) emit({ outcome: "miss", keyDigest });
    },
    closeAll() {
      for (const key of [...open.keys()]) close(key, "drop");
    },
    snapshot: () => ({ ...counts }),
  };
}
