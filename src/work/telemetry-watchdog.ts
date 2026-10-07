import { CASE_TIMEOUT_MAX_SECONDS } from "./case-timeout.ts";

/**
 * Progress, not the clock, decides how long a working run may keep working.
 *
 * `case-wait.ts` already replaced the guessed timeout with what the run says:
 * a declared completion signal ends it, quiet output stalls it, and the clock
 * survives only as a backstop. That leaves two cases it cannot separate,
 * because both look identical from the outside — output arriving, no verdict:
 *
 *   - A compile or an epoch benchmark that is genuinely working and needs
 *     more than its declared ceiling. It gets killed at the ceiling and comes
 *     back `timed_out`, unjudged, however correct the product is.
 *   - A loop printing forever without getting anywhere. It is waited out to
 *     the full ceiling before anyone notices, spending the machine on nothing.
 *
 * The difference is legible in the output itself. Long work counts: epochs,
 * steps, iterations, compiled targets, percentages. A run whose counter keeps
 * moving is working and has earned more time; a run whose counter has not
 * moved in a long while is not working, whatever else it is printing.
 *
 * So this watches the counter rather than the byte stream. Each advance
 * renews a lease on the clock, up to a hard ceiling that no amount of
 * progress can pass. Absence of advance, once a run has shown it emits a
 * counter at all, ends it early.
 *
 * The last clause is the safety property. A run that never printed a
 * recognizable counter is not judged by this at all — it keeps the ordinary
 * stall window and ceiling. Aborting a run for failing to report progress it
 * never claimed to report would turn every quiet-but-correct case red, which
 * is a worse failure than the one this fixes.
 */

/** How much runway one observed advance buys. */
export const TELEMETRY_LEASE_EXTENSION_MS = 300_000;
/**
 * No lease may pass the transport's own ceiling. Importing it rather than
 * restating it: the two constants drifted once already, and a case could
 * declare an hour against a transport that refused ten minutes.
 */
export const TELEMETRY_HARD_CEILING_MS = CASE_TIMEOUT_MAX_SECONDS * 1_000;
/**
 * Printing steadily while the counter stands still for this long is a loop,
 * not work. Deliberately longer than one lease extension: a run between two
 * coarse markers — a checkpoint save between epochs — must not be mistaken
 * for a stuck one.
 */
export const TELEMETRY_ZERO_PROGRESS_ABORT_MS = 600_000;

/**
 * The counters a long run prints without being asked to.
 *
 * Ordered from most specific to least: a build line `[ 12/340] Compiling x`
 * also contains digits a percent pattern would happily match, and the kind
 * that matched is what the operator reads in the log.
 */
const TELEMETRY_PATTERNS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "epoch", pattern: /\bepoch\b[\s:=]*(\d+)(?:\s*\/\s*(\d+))?/giu },
  { kind: "step", pattern: /\bstep\b[\s:=]*(\d+)(?:\s*\/\s*(\d+))?/giu },
  { kind: "iteration", pattern: /\biter(?:ation)?\b[\s:=]*(\d+)/giu },
  { kind: "build", pattern: /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/gu },
  { kind: "compiling", pattern: /\bcompiling\b\s+(\S+)/giu },
  { kind: "percent", pattern: /(\d+(?:\.\d+)?)\s*%/gu },
];

export interface TelemetryMark {
  readonly kind: string;
  /** The matched text, which is what changes when the run advances. */
  readonly mark: string;
}

/**
 * The most recent counter of each kind in this output.
 *
 * The tail is bounded and scrolls, so only the LAST match of a kind is
 * meaningful — an earlier one may already have left the window.
 */
export function readTelemetry(output: string, customPattern?: string): TelemetryMark[] {
  const marks: TelemetryMark[] = [];
  const sources = [...TELEMETRY_PATTERNS];
  if (customPattern) {
    // A pattern the case wrote is data, not code: a bad one contributes
    // nothing rather than throwing inside a poll.
    try {
      sources.unshift({ kind: "declared", pattern: new RegExp(customPattern, "giu") });
    } catch {
      // ignore an unusable declaration
    }
  }
  for (const { kind, pattern } of sources) {
    let last: string | undefined;
    // Each entry owns its lastIndex; reset so one poll never resumes another's
    // scan position.
    pattern.lastIndex = 0;
    for (let m = pattern.exec(output); m !== null; m = pattern.exec(output)) {
      last = m[0].trim();
      // A zero-width match would spin here forever.
      if (m.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
    if (last !== undefined) marks.push({ kind, mark: last });
  }
  return marks;
}

export interface TelemetryLease {
  /** kind → the counter text last seen for it. */
  readonly marks: Map<string, string>;
  /** True once any counter has been seen; gates the early abort. */
  seen: boolean;
  /** When a counter last changed, on the caller's clock. */
  lastAdvanceAt: number;
  /** How many extensions this run has been granted. */
  extensions: number;
  /** The ceiling in force now, which only ever grows. */
  ceilingMs: number;
}

export function openTelemetryLease(baseCeilingMs: number, now: number): TelemetryLease {
  return {
    marks: new Map(),
    seen: false,
    lastAdvanceAt: now,
    extensions: 0,
    ceilingMs: baseCeilingMs,
  };
}

export interface TelemetryObservation {
  /** A counter moved since the last poll. */
  readonly advanced: boolean;
  /** The counter that moved, for the log. */
  readonly mark?: TelemetryMark;
  /** The ceiling the caller should wait against now. */
  readonly ceilingMs: number;
  /** True when this poll bought more runway; the caller records that. */
  readonly extended: boolean;
  /** Set when the run has been printing without progressing for too long. */
  readonly abort?: string;
}

/**
 * Fold one poll's output into the lease.
 *
 * Advance is measured as a CHANGE in the counter text, not as an increase in
 * its number. A build that finishes one target and restarts at `[1/40]`, or a
 * benchmark whose percentage resets between phases, is still working; a
 * strictly-increasing rule would call both of those stuck. What it must catch
 * is the counter that does not move at all, and an unchanged line is exactly
 * that.
 */
export function observeTelemetry(
  lease: TelemetryLease,
  input: {
    readonly output: string;
    readonly now: number;
    readonly elapsedMs: number;
    readonly customPattern?: string;
    readonly extensionMs?: number;
    readonly hardCeilingMs?: number;
    readonly zeroProgressAbortMs?: number;
  },
): TelemetryObservation {
  const extensionMs = input.extensionMs ?? TELEMETRY_LEASE_EXTENSION_MS;
  const hardCeilingMs = Math.min(
    input.hardCeilingMs ?? TELEMETRY_HARD_CEILING_MS,
    TELEMETRY_HARD_CEILING_MS,
  );
  const abortAfterMs = input.zeroProgressAbortMs ?? TELEMETRY_ZERO_PROGRESS_ABORT_MS;

  const marks = readTelemetry(input.output, input.customPattern);
  let moved: TelemetryMark | undefined;
  for (const mark of marks) {
    if (lease.marks.get(mark.kind) !== mark.mark) {
      lease.marks.set(mark.kind, mark.mark);
      moved ??= mark;
    }
  }
  if (marks.length > 0) lease.seen = true;

  if (moved !== undefined) {
    lease.lastAdvanceAt = input.now;
    // A lease is runway from HERE, not a fixed addition: each advance
    // guarantees another window of work regardless of how long the run has
    // already been going, and the hard ceiling bounds the total.
    const wanted = Math.min(hardCeilingMs, input.elapsedMs + extensionMs);
    if (wanted > lease.ceilingMs) {
      lease.ceilingMs = wanted;
      lease.extensions += 1;
      return { advanced: true, mark: moved, ceilingMs: lease.ceilingMs, extended: true };
    }
    return { advanced: true, mark: moved, ceilingMs: lease.ceilingMs, extended: false };
  }

  // Only a run that has shown it counts is held to counting. Everything else
  // keeps the ordinary stall window.
  if (lease.seen && input.now - lease.lastAdvanceAt >= abortAfterMs) {
    const stuck = [...lease.marks.entries()].map(([kind, mark]) => `${kind}=${mark}`).join(", ");
    return {
      advanced: false,
      ceilingMs: lease.ceilingMs,
      extended: false,
      abort: `run kept printing but its progress counter has not moved for ${
        Math.round((input.now - lease.lastAdvanceAt) / 1000)
      }s (${stuck || "no counter"}) — this is a loop, not slow work`,
    };
  }
  return { advanced: false, ceilingMs: lease.ceilingMs, extended: false };
}
