export type WarmupStatus = "prepared" | "starting" | "ready" | "consumed" | "failed" | "disposing" | "disposed";

export type WarmupAuthority = {
  readonly kind: string;
  readonly keyDigest: string;
};

export type WarmupConsumption<Resource> = {
  readonly value: Resource;
  readonly dispose: () => Promise<void>;
};

export type WarmupPreparation<Resource> = {
  readonly authority: WarmupAuthority;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly acquire: (signal: AbortSignal) => Promise<Resource>;
  readonly release: (resource: Resource) => void | Promise<void>;
};

export interface WarmupLease<Resource> {
  readonly id: string;
  readonly authority: WarmupAuthority;
  status(): WarmupStatus;
  start(): void;
  ready(): Promise<void>;
  tryConsume(expected: WarmupAuthority): WarmupConsumption<Resource> | undefined;
  dispose(): Promise<void>;
}

export interface WarmupRegistry {
  prepare<Resource>(input: WarmupPreparation<Resource>): WarmupLease<Resource>;
  dispose(): Promise<void>;
}

export class WarmupLifecycleError extends Error {
  readonly code: "authority" | "lifecycle" | "aborted" | "timeout" | "cleanup";

  constructor(code: WarmupLifecycleError["code"]) {
    super(`warmup ${code}`);
    this.name = "WarmupLifecycleError";
    this.code = code;
  }
}

type ManagedLease = {
  dispose(): Promise<void>;
};

export function createWarmupRegistry(): WarmupRegistry {
  const leases = new Set<ManagedLease>();
  let disposed = false;
  return {
    prepare<Resource>(input: WarmupPreparation<Resource>): WarmupLease<Resource> {
      if (disposed) throw new WarmupLifecycleError("lifecycle");
      assertAuthority(input.authority);
      const lease = createLease(input, () => leases.delete(lease));
      leases.add(lease);
      return lease;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all([...leases].map((lease) => lease.dispose()));
      leases.clear();
    },
  };
}

function createLease<Resource>(
  input: WarmupPreparation<Resource>,
  onRelease: () => void,
): WarmupLease<Resource> {
  const authority = Object.freeze({ ...input.authority });
  const controller = new AbortController();
  let state: WarmupStatus = "prepared";
  let resource: Resource | undefined;
  let acquireTask: Promise<void> | undefined;
  let cleanupTask: Promise<void> | undefined;
  let cleanupFailure: WarmupLifecycleError | undefined;
  let failure: WarmupLifecycleError | undefined;
  let settleReady: (() => void) | undefined;
  const readyBarrier = new Promise<void>((resolve) => { settleReady = resolve; });
  const abort = (code: "aborted" | "timeout") => {
    if (state !== "starting") return;
    failure = new WarmupLifecycleError(code);
    state = "failed";
    controller.abort();
    settleReady?.();
  };
  const externalAbort = () => {
    if (state === "starting") {
      abort("aborted");
      return;
    }
    if (state === "ready") {
      state = "disposing";
      controller.abort();
      void release();
    }
  };
  input.signal?.addEventListener("abort", externalAbort, { once: true });

  const release = async (): Promise<void> => {
    if (cleanupTask) return cleanupTask;
    cleanupTask = (async () => {
      try {
        if (resource !== undefined) {
          const owned = resource;
          resource = undefined;
          await input.release(owned);
        }
        state = "disposed";
      } catch (error) {
        cleanupFailure = new WarmupLifecycleError("cleanup");
        if (error instanceof Error) cleanupFailure.cause = error;
        state = "failed";
      } finally {
        input.signal?.removeEventListener("abort", externalAbort);
        onRelease();
      }
    })();
    return cleanupTask;
  };

  const lease: WarmupLease<Resource> = {
    id: `warmup-${crypto.randomUUID()}`,
    authority,
    status: () => state,
    start() {
      if (state !== "prepared") throw new WarmupLifecycleError("lifecycle");
      state = "starting";
      if (input.signal?.aborted) abort("aborted");
      const timeoutMs = positiveTimeout(input.timeoutMs);
      const timer = setTimeout(() => abort("timeout"), timeoutMs);
      acquireTask = (async () => {
        try {
          const acquired = await input.acquire(controller.signal);
          resource = acquired;
          if (controller.signal.aborted || state !== "starting") {
            await release();
            return;
          }
          state = "ready";
          settleReady?.();
        } catch (error) {
          if (state === "starting") {
            failure = new WarmupLifecycleError(controller.signal.aborted ? "aborted" : "lifecycle");
            if (error instanceof Error) {
              failure.cause = error;
            }
            state = "failed";
            settleReady?.();
          }
        } finally {
          clearTimeout(timer);
        }
      })();
    },
    async ready() {
      if (state === "prepared") throw new WarmupLifecycleError("lifecycle");
      await readyBarrier;
      if (state === "ready" || state === "consumed") return;
      throw failure ?? new WarmupLifecycleError("lifecycle");
    },
    tryConsume(expected) {
      assertAuthority(expected);
      if (state !== "ready" || resource === undefined) return undefined;
      if (!sameAuthority(authority, expected)) {
        state = "disposing";
        void release();
        return undefined;
      }
      const value = resource;
      resource = undefined;
      state = "consumed";
      input.signal?.removeEventListener("abort", externalAbort);
      onRelease();
      let released = false;
      return Object.freeze({
        value,
        dispose: async () => {
          if (released) return;
          released = true;
          await input.release(value);
        },
      });
    },
    async dispose() {
      if (state === "consumed" || state === "disposed") return;
      state = "disposing";
      controller.abort();
      settleReady?.();
      await acquireTask;
      await release();
      if (cleanupFailure) throw cleanupFailure;
    },
  };
  return Object.freeze(lease);
}

function assertAuthority(authority: WarmupAuthority): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(authority.kind) || !/^[a-f0-9]{64}$/u.test(authority.keyDigest)) {
    throw new WarmupLifecycleError("authority");
  }
}

function sameAuthority(left: WarmupAuthority, right: WarmupAuthority): boolean {
  return left.kind === right.kind && left.keyDigest === right.keyDigest;
}

function positiveTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : 30_000;
}
