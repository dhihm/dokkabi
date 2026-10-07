export type Tier1RuntimeBudgetSnapshot = {
  readonly active: number;
  readonly outstanding: number;
  readonly rejected: number;
  readonly maxActive: number;
  readonly maxOutstanding: number;
};

export interface Tier1RuntimeBudget {
  run<Result>(signal: AbortSignal, start: () => Promise<Result>): Promise<Result> | undefined;
  snapshot(): Tier1RuntimeBudgetSnapshot;
  idle(): Promise<void>;
}

export function createTier1RuntimeBudget(options: {
  readonly maxActive?: number;
  readonly maxOutstanding?: number;
} = {}): Tier1RuntimeBudget {
  const maxOutstanding = positiveBound(options.maxOutstanding, 8);
  const maxActive = Math.min(positiveBound(options.maxActive, 4), maxOutstanding);
  const operations = new Set<Promise<void>>();
  let active = 0;
  let outstanding = 0;
  let rejected = 0;
  return {
    run<Result>(signal: AbortSignal, start: () => Promise<Result>): Promise<Result> | undefined {
      if (signal.aborted || active >= maxActive || outstanding >= maxOutstanding) {
        rejected += 1;
        return undefined;
      }
      active += 1;
      outstanding += 1;
      let activeCharge = true;
      const releaseActive = (): void => {
        if (!activeCharge) return;
        activeCharge = false;
        active -= 1;
      };
      signal.addEventListener("abort", releaseActive, { once: true });
      const operation = Promise.resolve().then(start);
      const settled = operation.then(() => undefined, () => undefined).then(() => {
        signal.removeEventListener("abort", releaseActive);
        releaseActive();
        outstanding -= 1;
      });
      operations.add(settled);
      void settled.then(() => operations.delete(settled));
      return operation;
    },
    snapshot: () => ({ active, outstanding, rejected, maxActive, maxOutstanding }),
    idle: async () => { while (operations.size > 0) await Promise.all([...operations]); },
  };
}

function positiveBound(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
