import { SSH_TIMEOUT_MAX_SECONDS } from "../host/ssh.ts";

/**
 * How long a case's run may take.
 *
 * The livelock's root cause: a case declared it could not honestly take less
 * than two minutes of real work, and the executor killed it
 * at the transport's two-minute default. Every run was cut off at one percent
 * of weight loading, so the case could never pass however correct the product
 * was. The model, running the same command by hand with a long window, saw it
 * pass and called the todo green; the harness saw red. Both were right about
 * what they had watched, and neither could see the other.
 *
 * A duration floor is a lower bound on real work, never an allowance. A case
 * whose timeout does not clear its own floor is unsatisfiable by construction,
 * which the seal should say rather than letting a run discover it forever.
 */

/** The transport's ordinary cap when a case asks for nothing special. */
export const CASE_TIMEOUT_DEFAULT_SECONDS = 120;
/**
 * Ceiling the ssh transport will accept for one command — the transport's own
 * constant, not a second copy of it. The two drifted once: a case could
 * declare an hour and the transport refused anything over ten minutes, so a
 * plan whose cases load real weights was refused before any of them ran.
 */
export const CASE_TIMEOUT_MAX_SECONDS = SSH_TIMEOUT_MAX_SECONDS;
/**
 * A ceiling only. It is a backstop against a run that has stopped saying
 * anything, never the thing that decides a verdict — that is the case's own
 * completion signal. Guessing a generous number here is what produced a
 * two-minute cap on an eleven-minute run.
 */
export function caseTimeoutSeconds(item: {
  readonly timeout_ms?: number;
}): number {
  const declared = item.timeout_ms;
  const seconds = Number.isFinite(declared) && (declared ?? 0) > 0
    ? Math.round((declared as number) / 1000)
    : CASE_TIMEOUT_DEFAULT_SECONDS;
  return Math.max(1, Math.min(CASE_TIMEOUT_MAX_SECONDS, seconds));
}

/** Why this case can never pass, or undefined when its budget is coherent. */
export function contradictoryTimeout(item: {
  readonly timeout_ms?: number;
  readonly min_duration_ms?: number;
}): string | undefined {
  const floor = item.min_duration_ms;
  const timeout = item.timeout_ms;
  if (!Number.isFinite(floor) || (floor ?? 0) <= 0) return undefined;
  if (!Number.isFinite(timeout) || (timeout ?? 0) <= 0) return undefined;
  if ((timeout as number) > (floor as number)) return undefined;
  return `case declares min_duration_ms ${floor} but timeout_ms ${timeout}: the run is killed before it can honestly finish, so this case can never pass. A duration floor is a lower bound on real work, not an allowance — raise timeout_ms above it.`;
}

/**
 * What to say when the clock, not the case, ended the run.
 *
 * A run killed at its cap has not been judged: the product may be right and
 * merely slow, or hung. Reported as an ordinary red, the tail showed only
 * `state=timed_out`, and the implement turn kept re-running a four-minute
 * weight load against a two-minute default it did not know it could raise.
 */
export function timedOutCaseReason(
  item: { readonly timeout_ms?: number },
  output: string,
): string | undefined {
  if (!/\bstate=timed_out\b|\[timed out after \d+s\]/u.test(output)) return undefined;
  const seconds = caseTimeoutSeconds(item);
  if (seconds >= CASE_TIMEOUT_MAX_SECONDS) return ceilingCaseReason(seconds);
  const budget = Number.isFinite(item.timeout_ms) && (item.timeout_ms ?? 0) > 0
    ? `its declared timeout_ms ${item.timeout_ms}`
    : `no timeout_ms is declared, so the ${CASE_TIMEOUT_DEFAULT_SECONDS}s default applied`;
  return `case was cut by the clock at ${seconds}s (${budget}) and has not been judged. `
    + `If the work honestly takes longer — loading real weights, dumping a golden — declare timeout_ms on the case `
    + `(at most ${CASE_TIMEOUT_MAX_SECONDS * 1000}) rather than shrinking the work; if it should have finished by now, the run is hung and that is the bug.`;
}

/**
 * What to say when the cut happened at the transport's own ceiling.
 *
 * "Declare a longer timeout_ms" is the right advice at every budget except the
 * largest one, where it is advice that cannot be followed: the case is already
 * asking for the maximum the transport will accept. Live, a case running the
 * whole accumulated suite on one GPU was cut at the ceiling, told to raise a
 * budget already at its maximum, and re-emitted unchanged — two hours of a
 * two-and-three-quarter-hour run spent twice on a case that could not pass
 * either time. At the ceiling the only real moves are to make the case smaller
 * or to let it report progress, so say those instead.
 */
function ceilingCaseReason(seconds: number): string {
  return `case was cut at the ceiling of ${seconds}s, the longest run this transport accepts, and has not been judged. `
    + `A larger timeout_ms does not exist, so raising it is not the fix. Either split the case — one case per test file, `
    + `or per phase, each judged on its own — or, if it honestly is one long run, declare done_when and poll_interval_ms `
    + `so it reports progress while it works instead of being killed silently at the ceiling.`;
}

/** True when this case's budget already asks for the largest run allowed. */
export function atCaseTimeoutCeiling(item: { readonly timeout_ms?: number }): boolean {
  return caseTimeoutSeconds(item) >= CASE_TIMEOUT_MAX_SECONDS;
}
