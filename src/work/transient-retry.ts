import { RecoveryTerminalError, isRecoveryTerminalError, type DurableRecoveryService, type RecoveryOperationInput } from "../host/recovery.ts";
/**
 * An unattended run must outlive a provider hiccup.
 *
 * One night produced three separate process deaths. Two were the provider
 * returning an empty completion; request-layer retries were exhausted,
 * failover was off by operator choice, and the whole work loop exited —
 * leaving hours of unattended time on the table until someone relaunched
 * it. An empty completion, a rate limit, a dropped connection: these are
 * weather, not verdicts — the same request a minute later succeeds.
 *
 * When nobody is watching (HEUNG), the turn waits out the weather with a
 * bounded, growing backoff. When an operator IS watching, failing fast so
 * they can decide remains the right behavior — a silent five-minute stall
 * in an interactive session reads as a hang.
 */

const TRANSIENT_CLASSES: ReadonlySet<string> = new Set([
  "empty_completion",
  "rate_limited",
  "transport_failure",
]);

/** Bounded: three waits, then the failure surfaces like any other. */
const BACKOFF_DELAYS_MS: readonly number[] = [30_000, 90_000, 240_000];

/** The failure's class when — and only when — it is transient weather. */
export function transientFailureClass(error: unknown): string | undefined {
  const failure = (error as { failure?: { class?: unknown } } | undefined)?.failure;
  const klass = typeof failure?.class === "string" ? failure.class : undefined;
  return klass !== undefined && TRANSIENT_CLASSES.has(klass) ? klass : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const failure = (error as { failure?: { retry_after_sec?: unknown } } | undefined)?.failure;
  const sec = failure?.retry_after_sec;
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
}

function failureClassOf(error: unknown): string | undefined {
  const failure = (error as { failure?: { class?: unknown } } | undefined)?.failure;
  return typeof failure?.class === "string" ? failure.class : undefined;
}

export async function runTurnWithTransientRetry(input: {
  run: () => Promise<unknown>;
  recovery?: DurableRecoveryService;
  operation?: RecoveryOperationInput;
  signal?: AbortSignal;
  /** True when HEUNG drives the run and no operator is there to decide. */
  unattended: boolean;
  onRetry?: (info: { class: string; attempt: number; delayMs: number }) => void;
  sleeper?: (ms: number) => Promise<void>;
  /**
   * An oversized conversation is recoverable weather, once. A provider
   * rejected a request outright when the surface outgrew what it would
   * accept — below the harness's own caution line, because token estimates
   * undercount CJK text. The fix a human applied by hand was mechanical:
   * archive the transcript, invalidate the in-memory surface, rerun the
   * turn on a bounded context rebuilt from the ledger and the log. Return
   * true to retry once; a second rejection on a fresh surface is a real
   * defect and surfaces as before. Attended turns never auto-reset.
   */
  recoverInvalidRequest?: () => Promise<boolean>;
}): Promise<void> {
  if (input.unattended && input.operation && !input.recovery) throw new RecoveryTerminalError("durable_recovery_unavailable");
  if (input.unattended && input.recovery && input.operation) {
    const recovery = input.recovery;
    await recovery.withOperation(input.operation, async () => {
      // The registered loop owns all retry dispatches. There is no second ladder.
      await input.run();
      const token = recovery.current();
      if (token) recovery.complete(token);
    }, input.signal);
    return;
  }
  const sleep = input.sleeper ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let surfaceReset = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await input.run();
      return;
    } catch (error) {
      if (isRecoveryTerminalError(error)) throw error;
      if (
        input.unattended
        && !surfaceReset
        && input.recoverInvalidRequest
        && failureClassOf(error) === "invalid_request"
      ) {
        surfaceReset = true;
        if (await input.recoverInvalidRequest()) {
          input.onRetry?.({ class: "invalid_request", attempt: attempt + 1, delayMs: 0 });
          continue;
        }
        throw error;
      }
      const klass = input.unattended ? transientFailureClass(error) : undefined;
      const scheduled = BACKOFF_DELAYS_MS[attempt];
      if (klass === undefined || scheduled === undefined) throw error;
      // A provider-stated retry_after stretches the wait; it never shrinks
      // the schedule — a 1-second hint under real congestion just burns an
      // attempt.
      const delayMs = Math.max(scheduled, retryAfterMs(error) ?? 0);
      input.onRetry?.({ class: klass, attempt: attempt + 1, delayMs });
      await sleep(delayMs);
    }
  }
}
