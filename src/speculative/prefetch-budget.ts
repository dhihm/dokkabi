export interface SpeculativeReadBudget {
  hasCapacity(limit: number): boolean;
  track(operation: Promise<void>): void;
}

export function createSpeculativeReadBudget(): SpeculativeReadBudget {
  const active = new Set<Promise<void>>();
  return {
    hasCapacity: (limit) => active.size < limit,
    track(operation) {
      active.add(operation);
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
    },
  };
}
