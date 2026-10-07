import type { ExactCacheEvent } from "./exact-cache-types.ts";

interface CleanupIdentity {
  readonly digest: string;
  readonly providerDigest: string;
}

export interface ExactCleanupTracker {
  schedule(
    disposer: (() => void | Promise<void>) | undefined,
    identity: CleanupIdentity,
  ): void;
  drain(): Promise<void>;
  pending(): number;
  failures(): number;
}

export function createExactCleanupTracker(
  emit: (event: ExactCacheEvent) => boolean,
): ExactCleanupTracker {
  const tasks = new Set<Promise<void>>();
  let failureCount = 0;
  return {
    schedule(disposer, identity) {
      if (!disposer) return;
      const cleanup = Promise.resolve().then(disposer).then(
        () => undefined,
        () => {
          failureCount += 1;
          emit({
            outcome: "cleanup-failed",
            keyDigest: identity.digest,
            providerDigest: identity.providerDigest,
          });
        },
      );
      tasks.add(cleanup);
      void cleanup.finally(() => tasks.delete(cleanup));
    },
    async drain() {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
    pending: () => tasks.size,
    failures: () => failureCount,
  };
}
