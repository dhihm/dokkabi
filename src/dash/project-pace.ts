/**
 * How often the board may rebuild its projection.
 *
 * `projectDash` is a pure function of the WHOLE log, and it walks it about
 * sixty times over: 74 helpers, each its own scan. Measured on a live session
 * — 93MB, 115,000 events — one projection costs 145ms, against a 100ms paint
 * interval. A run appending events continuously makes every poll "changed", so
 * the board was rebuilding the session's entire history ten times a second and
 * finishing none of it on time.
 *
 * The symptoms all followed from that. The spinner only advanced when a chunk
 * of text did, because both waited on the same projection. A mouse drag took
 * seconds to register, because the keyboard and the projection share a thread.
 *
 * This paces the PROJECTION, not the paint: the board still repaints at its
 * interval from the view it already has, so the spinner turns and the keyboard
 * answers while the next projection is still owed.
 *
 * It is a pace, not the fix. The fix is to stop re-reading events already
 * read — the reader is already incremental, only the projection is not — and
 * that is a change to all 74 helpers, which must not land without a proof that
 * folding gives the same answer as rebuilding. Until then this keeps the board
 * usable without making it lie.
 */

/**
 * A frame may claim one part in this many of the board's wall clock.
 *
 * At 4 the board keeps three quarters of a core free, which is what the
 * terminal needs to answer a drag while the run is appending events. The
 * number is a divisor of the MEASURED frame, so a young session -- where a
 * frame is a millisecond -- still redraws on every paint: four times almost
 * nothing is still almost nothing.
 *
 * It was 3, and it was measured against the projection alone (68ms) rather
 * than the frame the projection causes (162ms, because a new projection
 * invalidates every widget body). That scheduled five frames a second at
 * roughly 160ms each and pegged a core.
 */
export const PROJECT_DUTY = 4;

/** However expensive it gets, the view is never older than this. */
export const MAX_PROJECT_GAP_MS = 2_000;

export function dueToReproject(input: {
  now: number;
  /** When the last projection finished. */
  lastAt: number;
  /** What the last projection cost. */
  lastMs: number;
}): boolean {
  const wait = Math.min(MAX_PROJECT_GAP_MS, input.lastMs * PROJECT_DUTY);
  return input.now - input.lastAt >= wait;
}
