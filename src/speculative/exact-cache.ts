import {
  canonicalExactCall,
  DEFAULT_MAX_CALL_BYTES,
  digestExactCall,
  EXACT_CACHE_DEFAULTS,
  positiveExactBound,
  readExactProviderName,
  validExactProof,
} from "./exact-cache-value.ts";
import type {
  ExactCall,
  ExactCacheEvent,
  ExactCacheEventOutcome,
  ExactCacheEntry,
  ExactCallCache,
  ExactCallProvider,
  PendingExactAttempt,
} from "./exact-cache-types.ts";
import { createExactCleanupTracker } from "./exact-cache-cleanup.ts";
import { inspectExactDisposer, inspectExactPreparation } from "./exact-cache-admission.ts";
export type { ExactCall, ExactCacheEvent, ExactCacheEventOutcome, ExactCacheSnapshot, ExactCallProvider, ExactCallCache, ExactPreparation } from "./exact-cache-types.ts";
export function exactCallDigest(providerName: string, call: ExactCall): string | undefined {
  return digestExactCall(providerName, call);
}
export function createExactCallCache(options: {
  readonly maxEntries?: number;
  readonly maxResultBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxCallBytes?: number;
  readonly maxInFlight?: number;
  readonly maxOutstanding?: number;
  readonly timeoutMs?: number;
  readonly onEvent?: (event: ExactCacheEvent) => void;
} = {}): ExactCallCache {
  const maxEntries = positiveExactBound(options.maxEntries, EXACT_CACHE_DEFAULTS.maxEntries);
  const maxResultBytes = positiveExactBound(options.maxResultBytes, EXACT_CACHE_DEFAULTS.maxResultBytes);
  const maxTotalBytes = positiveExactBound(options.maxTotalBytes, EXACT_CACHE_DEFAULTS.maxTotalBytes);
  const maxCallBytes = positiveExactBound(options.maxCallBytes, DEFAULT_MAX_CALL_BYTES);
  const maxInFlight = positiveExactBound(options.maxInFlight, EXACT_CACHE_DEFAULTS.maxInFlight);
  const maxOutstanding = positiveExactBound(
    options.maxOutstanding,
    EXACT_CACHE_DEFAULTS.maxOutstanding,
  );
  const entries = new Map<string, ExactCacheEntry>();
  const pending = new Map<string, PendingExactAttempt>();
  const logicalTasks = new Set<Promise<void>>();
  const providerIds = new WeakMap<object, number>();
  const counts = { scheduled: 0, hits: 0, stale: 0, dropped: 0, warmOnly: 0 };
  let nextProviderId = 1;
  let inFlight = 0;
  let outstanding = 0;
  let totalBytes = 0;
  let disposed = false;
  const emit = (event: ExactCacheEvent): boolean => {
    try {
      options.onEvent?.(event);
      return true;
    } catch (error) {
      if (error instanceof Error) return false;
      return false;
    }
  };
  const cleanup = createExactCleanupTracker(emit);
  const providerId = (provider: object): number => {
    const current = providerIds.get(provider);
    if (current !== undefined) return current;
    const created = nextProviderId;
    nextProviderId += 1;
    providerIds.set(provider, created);
    return created;
  };
  const dropEntry = (key: string, outcome: "drop" | "stale" = "drop"): void => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes -= entry.bytes;
    if (outcome === "stale") counts.stale += 1;
    else counts.dropped += 1;
    emit({ outcome, keyDigest: entry.digest, providerDigest: entry.providerDigest });
    cleanup.schedule(entry.dispose, entry);
  };

  return {
    schedule(provider, call, signal) {
      if (disposed || signal?.aborted) return false;
      const providerName = readExactProviderName(provider);
      if (providerName === undefined) return false;
      const canonical = canonicalExactCall(providerName, call, maxCallBytes);
      if (!canonical) return false;
      const key = `${providerId(provider)}:${canonical.key}`;
      if (entries.has(key) || pending.has(key)) return false;
      if (inFlight >= maxInFlight || outstanding >= maxOutstanding) {
        counts.dropped += 1;
        emit({ outcome: "drop", keyDigest: canonical.digest, providerDigest: canonical.providerDigest });
        return false;
      }
      if (!emit({
        outcome: "scheduled",
        keyDigest: canonical.digest,
        providerDigest: canonical.providerDigest,
      })) {
        counts.dropped += 1;
        return false;
      }
      counts.scheduled += 1;
      inFlight += 1;
      outstanding += 1;
      const controller = new AbortController();
      let resolveLogical: (() => void) | undefined;
      const logical = new Promise<void>((resolve) => { resolveLogical = resolve; });
      logicalTasks.add(logical);
      void logical.finally(() => logicalTasks.delete(logical));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const attempt: PendingExactAttempt = {
        controller,
        closed: false,
        finish(outcome) {
          if (attempt.closed) return;
          attempt.closed = true;
          pending.delete(key);
          inFlight -= 1;
          if (timer) clearTimeout(timer);
          if (signal && abortListener) signal.removeEventListener("abort", abortListener);
          if (outcome) {
            if (outcome === "stale") counts.stale += 1;
            else if (outcome === "warm-only") counts.warmOnly += 1;
            else counts.dropped += 1;
            emit({ outcome, keyDigest: canonical.digest, providerDigest: canonical.providerDigest });
          }
          resolveLogical?.();
        },
      };
      pending.set(key, attempt);
      abortListener = () => {
        controller.abort();
        attempt.finish("drop");
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(abortListener, positiveExactBound(options.timeoutMs, EXACT_CACHE_DEFAULTS.timeoutMs));
      timer.unref?.();
      const operation = Promise.resolve().then(() => provider.prepare(canonical.call, controller.signal));
      let preparedDisposer: (() => void | Promise<void>) | undefined;
      void operation.then((prepared) => {
        outstanding -= 1;
        if (attempt.closed || disposed || controller.signal.aborted) {
          preparedDisposer = inspectExactDisposer(prepared);
          cleanup.schedule(preparedDisposer, canonical);
          return;
        }
        const admission = inspectExactPreparation(prepared, maxResultBytes);
        preparedDisposer = admission.dispose;
        if (admission.kind !== "reusable") {
          attempt.finish(admission.kind);
          cleanup.schedule(admission.dispose, canonical);
          return;
        }
        const { snapshot } = admission;
        if (snapshot.bytes > maxTotalBytes) {
          attempt.finish("drop");
          cleanup.schedule(admission.dispose, canonical);
          return;
        }
        entries.set(key, {
          ...snapshot,
          validate: admission.validate,
          dispose: admission.dispose,
          digest: canonical.digest,
          providerDigest: canonical.providerDigest,
        });
        totalBytes += snapshot.bytes;
        attempt.finish();
        while (entries.size > maxEntries || totalBytes > maxTotalBytes) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          dropEntry(oldest);
        }
      }, () => { outstanding -= 1; attempt.finish("drop"); }).catch((error) => {
        if (error instanceof Error) {
          attempt.finish("drop");
          cleanup.schedule(preparedDisposer, canonical);
          return;
        }
        attempt.finish("drop");
        cleanup.schedule(preparedDisposer, canonical);
      });
      return true;
    },
    take(provider, call) {
      const providerName = readExactProviderName(provider);
      if (providerName === undefined) return undefined;
      const canonical = canonicalExactCall(providerName, call, maxCallBytes);
      if (!canonical) return undefined;
      const key = `${providerId(provider)}:${canonical.key}`;
      const active = pending.get(key);
      if (active) {
        active.controller.abort();
        active.finish("drop");
        return undefined;
      }
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      totalBytes -= entry.bytes;
      if (!validExactProof(entry.validate)) {
        counts.stale += 1;
        emit({ outcome: "stale", keyDigest: entry.digest, providerDigest: entry.providerDigest });
        cleanup.schedule(entry.dispose, entry);
        return undefined;
      }
      if (!emit({
        outcome: "hit",
        keyDigest: entry.digest,
        providerDigest: entry.providerDigest,
      })) {
        counts.dropped += 1;
        cleanup.schedule(entry.dispose, entry);
        return undefined;
      }
      counts.hits += 1;
      cleanup.schedule(entry.dispose, entry);
      return entry.value;
    },
    async idle() {
      await Promise.all([...logicalTasks]);
      await cleanup.drain();
    },
    snapshot: () => ({
      ...counts,
      entries: entries.size,
      inFlight,
      outstanding,
      totalBytes,
      cleanupFailures: cleanup.failures(),
      pendingCleanup: cleanup.pending(),
      disposed,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const attempt of [...pending.values()]) {
        attempt.controller.abort();
        attempt.finish("drop");
      }
      for (const key of [...entries.keys()]) dropEntry(key);
    },
  };
}
