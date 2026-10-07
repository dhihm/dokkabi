/**
 * How many times one todo has been implemented without moving — counted across
 * waves, not within one.
 *
 * `driveWork` already bounded this at three tries, but it built the counter
 * fresh on every call. HEUNG starts a new drive per wave, so the limit reset
 * each time and a todo that could never go green was retried forever. Live,
 * one todo took eight implement turns across two waves with the model saying
 * "nothing left to do" every time, and a twelve-hour budget would have kept
 * that going all night.
 */

/** Same todo with no new greens this many times means stuck. */
export const IMPLEMENT_STUCK_LIMIT = 3;

export interface ImplementMiss {
  /** Total misses recorded for this todo, across every wave so far. */
  readonly misses: number;
  /** True once the accumulated misses reach the limit. */
  readonly exhausted: boolean;
}

/** Record one implement turn that left the todo's reds exactly as they were. */
export function recordImplementMiss(
  ledger: Map<string, number>,
  todoId: string,
): ImplementMiss {
  const misses = (ledger.get(todoId) ?? 0) + 1;
  ledger.set(todoId, misses);
  return { misses, exhausted: misses >= IMPLEMENT_STUCK_LIMIT };
}

/** Progress on a todo forgives its history; other todos keep theirs. */
export function clearImplementMiss(ledger: Map<string, number>, todoId: string): void {
  ledger.delete(todoId);
}
