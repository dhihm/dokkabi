/**
 * What an op=wait poll can tell the operator.
 *
 * A ten-minute wait showed nothing at all. The loop polls the remote every
 * interval, and every poll returns the probe's output — the very thing that
 * says how far along the job is — which the loop kept in a local and discarded
 * until the wait ended. The answer was in hand the whole time.
 *
 * So each poll reports: which attempt, how long this has run, how long it may
 * still run, what the probe last said, and whether that changed. A changing
 * probe is progress; the same bytes repeated is a stall the operator should be
 * able to see without going and asking.
 */

const PROBE_SNIPPET_LIMIT = 120;

export interface WaitProgress {
  /** Operator-facing one-liner. */
  readonly line: string;
  /** False when the probe repeated itself — the same output is not progress. */
  readonly changed: boolean;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}m${total % 60}s`;
}

/**
 * The newest line is the informative one; a progress bar overwrites itself.
 *
 * A probe that ends in `tail -10`, though, means all ten: an operator watching
 * `grep -c done; grep -E "^measured|failed" log | tail -10` saw one line and
 * asked what had eaten the rest. Nothing had — the run had produced only the
 * count so far — but when it does produce more, one line out of ten is a
 * report that hides its own subject. The newest line still leads, and the
 * count of the ones behind it says they exist.
 */
function snippet(output: string): string {
  const rows = output
    .split(/\r?\n|\r/u)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
  const last = rows.at(-1);
  if (!last) return "";
  const body = last.length > PROBE_SNIPPET_LIMIT ? `${last.slice(0, PROBE_SNIPPET_LIMIT)}…` : last;
  return rows.length > 1 ? `${body} (+${rows.length - 1} more)` : body;
}

export function describeWaitProgress(input: {
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly output: string;
  /** Absent on the first poll, which has nothing to compare against. */
  readonly previousOutput?: string;
  /**
   * What is being watched. A LOG should keep growing, so output that stops
   * moving is a stall. A PROBE returns a count or a marker and is supposed to
   * hold steady until the thing it watches changes — calling that "unchanged"
   * and dimming it made a healthy twelve-minute wait look dead.
   */
  readonly kind?: "log" | "probe";
}): WaitProgress {
  const changed = input.previousOutput === undefined || input.previousOutput !== input.output;
  const body = snippet(input.output);
  const parts = [
    `#${input.attempt}`,
    `${duration(input.elapsedMs)} elapsed`,
    `${duration(input.remainingMs)} left`,
    body ? body : "no output",
  ];
  if (!changed) parts.push(input.kind === "probe" ? "still waiting" : "(unchanged)");
  return { line: parts.join(" · "), changed };
}

/**
 * How long a wait tolerates a probe that says nothing new.
 *
 * A phase's job finished and left its output behind; the wait watching it
 * polled for the rest of its fifteen-minute deadline — thirty-five probes,
 * each returning the same bytes, each recorded as unchanged — while no process
 * remained on the host and the accelerator sat idle. The loop already knew
 * nothing had changed and did nothing with it.
 *
 * Unchanged output is not proof of death: a long computation may be silent for
 * minutes at a time. So the window is a third of the deadline the caller chose
 * — they sized it for the work they expect — with a two-minute floor so a
 * short wait is not cut off after one repeat, and never longer than the
 * deadline itself.
 */
export const WAIT_STALL_FLOOR_MS = 120_000;

export function waitStallMs(deadlineMs: number): number {
  const scaled = Math.floor(Math.max(0, deadlineMs) / 3);
  const floored = Math.max(WAIT_STALL_FLOOR_MS, scaled);
  return deadlineMs > 0 ? Math.min(floored, deadlineMs) : WAIT_STALL_FLOOR_MS;
}

/** True once the probe has been silent for the whole window. */
export function waitHasStalled(unchangedForMs: number, stallMs: number): boolean {
  return unchangedForMs >= stallMs;
}
