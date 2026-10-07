export interface DeferredPrediction {
  readonly active: boolean;
  schedule(
    run: (limit: number) => void,
    limit: number,
    available: () => boolean,
  ): boolean;
  cancel(): void;
}

export function createDeferredPrediction(lifecycle: {
  readonly dropped: () => void;
  readonly settled: () => void;
}): DeferredPrediction {
  let pending: {
    readonly limit: number;
    readonly run: (limit: number) => void;
    readonly available: () => boolean;
  } | undefined;
  return {
    get active() { return pending !== undefined; },
    schedule(run, limit, available) {
      if (pending) {
        lifecycle.dropped();
        return false;
      }
      pending = { run, limit, available };
      setImmediate(() => {
        const current = pending;
        pending = undefined;
        if (!current || !current.available()) {
          lifecycle.settled();
          return;
        }
        try {
          current.run(current.limit);
        } catch (error) {
          lifecycle.dropped();
          if (!(error instanceof Error)) return;
        } finally {
          lifecycle.settled();
        }
      });
      return true;
    },
    cancel() { pending = undefined; },
  };
}
