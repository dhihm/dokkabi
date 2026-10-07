/**
 * Whether to keep waiting on a case's run, and why not when not.
 *
 * Waiting by the clock alone is the wrong instrument. A case was killed at the
 * transport's two-minute default one percent into an eleven-minute checkpoint
 * load, and the obvious repair — raise the number — is a guess that is either
 * too short for the slow case or wastes an hour on one that failed in the
 * first ten seconds.
 *
 * What the run is saying is the better signal. A case declares what finishing
 * looks like and what already-failed looks like; between those, output that
 * keeps moving means keep waiting and output that has gone quiet means stop.
 * The clock survives only as a backstop for a run that says nothing at all.
 */

export type CaseWaitVerdict = "done" | "failed" | "stalled" | "timeout" | "continue" | "exited";

/** How long a failing-but-alive run may keep printing before the verdict. */
export const FAILED_GRACE_MS = 90_000;

export interface CaseWaitDecision {
  readonly verdict: CaseWaitVerdict;
  readonly reason?: string;
}

/** A pattern the case wrote is data, not code: a bad one matches nothing. */
function matches(pattern: string | undefined, text: string): RegExpExecArray | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern, "iu").exec(text) ?? undefined;
  } catch {
    return undefined;
  }
}

export function caseWaitDecision(input: {
  readonly output: string;
  readonly previousOutput?: string;
  readonly elapsedMs: number;
  /** How long the output has been byte-identical. */
  readonly sinceChangeMs: number;
  /** Regex meaning this run already failed — stop now, do not wait it out. */
  readonly failedWhen?: string;
  /** Regex meaning the work finished; the run's own result then decides. */
  readonly doneWhen?: string;
  /** Quiet for this long with no declared signal means it is not coming. */
  readonly stallAfterMs: number;
  /** Absolute backstop for a run that never says anything conclusive. */
  readonly ceilingMs: number;
  /** False when the pidfile's process is gone. A finished process with no
   * conclusive output has nothing left to say — waiting out a stall window on
   * it burned fifteen minutes on a gate that closed in 0.02s. */
  readonly processAlive?: boolean;
  /** How long ago the failure signal first matched, when the caller tracks
   * it. A failure signal is a verdict, not a kill order: reaping on the
   * first "Traceback" line cut a run off mid-print, the assert message never
   * reached disk, and the implement turn got half a story. A failing run
   * that is still alive gets this long to finish its say; the grace ends
   * early on process exit or the summary line. Callers that do not track
   * this keep the old instant verdict. */
  readonly failedForMs?: number;
}): CaseWaitDecision {
  // Failure first: a traceback followed by a summary line is still a failed
  // run, and answering "done" would hand back a verdict to re-derive.
  const failed = matches(input.failedWhen, input.output);
  if (failed) {
    const summaryArrived = matches(input.doneWhen, input.output) !== undefined;
    const graceRunning = input.failedForMs !== undefined
      && input.failedForMs < FAILED_GRACE_MS
      && input.processAlive !== false
      && !summaryArrived;
    if (graceRunning) {
      return {
        verdict: "continue",
        reason: `failure signal seen (${failed[0].slice(0, 80)}); letting the run finish its say`,
      };
    }
    return { verdict: "failed", reason: `run reported failure: ${failed[0].slice(0, 120)}` };
  }
  const done = matches(input.doneWhen, input.output);
  if (done) {
    return { verdict: "done", reason: `run reported completion: ${done[0].slice(0, 120)}` };
  }
  if (input.processAlive === false) {
    return {
      verdict: "exited",
      reason: "process exited without a completion or failure signal — its output is all there will be",
    };
  }
  if (input.elapsedMs >= input.ceilingMs) {
    return {
      verdict: "timeout",
      reason: `no completion or failure signal within ${Math.round(input.ceilingMs / 1000)}s`,
    };
  }
  if (input.sinceChangeMs >= input.stallAfterMs) {
    return {
      verdict: "stalled",
      reason: `output unchanged for ${Math.round(input.sinceChangeMs / 1000)}s (stall window ${
        Math.round(input.stallAfterMs / 1000)
      }s) with no completion signal`,
    };
  }
  return { verdict: "continue" };
}

/** The waiting policy a case declared, in the shape the runner needs. */
export interface CaseSignals {
  readonly doneWhen?: string;
  readonly failedWhen?: string;
  readonly stallAfterMs?: number;
  readonly pollIntervalMs: number;
  readonly ceilingMs: number;
  /** The case's own progress counter, when the built-in ones do not fit. */
  readonly telemetryPattern?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_STALL_AFTER_MS = 300_000;

/**
 * Undefined when the case declared no waiting policy at all: such a case keeps
 * the ordinary one-shot execution, and filling in defaults for it would put
 * every case on the watched path whether it asked or not.
 */
export function caseSignals(item: {
  readonly done_when?: string;
  readonly failed_when?: string;
  readonly stall_after_ms?: number;
  readonly poll_interval_ms?: number;
  readonly timeout_ms?: number;
  readonly telemetry_pattern?: string;
}): CaseSignals | undefined {
  const declared = Boolean(item.done_when)
    || Boolean(item.failed_when)
    || Number.isFinite(item.stall_after_ms)
    || Number.isFinite(item.poll_interval_ms)
    || Boolean(item.telemetry_pattern);
  if (!declared) return undefined;
  return {
    ...(item.done_when ? { doneWhen: item.done_when } : {}),
    ...(item.failed_when ? { failedWhen: item.failed_when } : {}),
    stallAfterMs: Number.isFinite(item.stall_after_ms)
      ? (item.stall_after_ms as number)
      : DEFAULT_STALL_AFTER_MS,
    pollIntervalMs: Number.isFinite(item.poll_interval_ms) && (item.poll_interval_ms ?? 0) > 0
      ? (item.poll_interval_ms as number)
      : DEFAULT_POLL_INTERVAL_MS,
    ceilingMs: Number.isFinite(item.timeout_ms) && (item.timeout_ms ?? 0) > 0
      ? (item.timeout_ms as number)
      : 3_600_000,
    ...(item.telemetry_pattern ? { telemetryPattern: item.telemetry_pattern } : {}),
  };
}
