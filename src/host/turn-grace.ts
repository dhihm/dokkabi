/**
 * A turn that ignored its own deadline had nothing left to stop it.
 *
 * The turn budget fires a timer and, with no tool in flight, calls
 * `agent.abort()`. Whether that reaches a request already hanging on a silent
 * connection is not the harness's to guarantee: the loop then waits for the
 * agent to go idle, and if the abort did not land, that wait has no end. One
 * unattended turn sat for sixty-three minutes against a five-minute budget
 * while an inference gateway dropped roughly a sixth of its requests.
 *
 * So the deadline gets a second line. Once it has expired, the wait for idle
 * is itself bounded: the agent is given a grace period to settle, and when
 * that passes the turn is abandoned and said so. The turn's own bookkeeping
 * still treats it as a failed turn, which is what it is.
 *
 * The grace differs by what the deadline decided. An abort had no tool
 * running, so nothing outside is mid-change and a short grace is enough. A
 * deferral is waiting for tool calls that may already have altered the world,
 * so it is given room for the longest single call the harness permits before
 * it gives up on them.
 */

/** Nothing was running; only the request itself has to unwind. */
export const ABORT_GRACE_MS = 60_000;
/** A tool batch is settling. The longest single call the harness allows is
 * ten minutes, so a batch is given that much plus a margin to finish. */
export const DEFER_GRACE_MS = 11 * 60_000;

export function graceForDecision(decision: "abort" | "defer"): number {
  return decision === "defer" ? DEFER_GRACE_MS : ABORT_GRACE_MS;
}

export class TurnAbandonedError extends Error {
  readonly graceMs: number;
  constructor(graceMs: number) {
    super(
      `turn did not settle ${Math.round(graceMs / 1000)}s after its deadline expired; abandoned`,
    );
    this.name = "TurnAbandonedError";
    this.graceMs = graceMs;
  }
}

/**
 * Wait for the agent to go idle, but never past the grace once the deadline
 * has expired. Resolves `"idle"` when the agent settled and `"abandoned"` when
 * the grace ran out first.
 *
 * `deadlineExpired` is read at call time rather than captured, because the
 * deadline fires while this is already waiting — that is the whole case.
 */
export async function waitForIdleWithin(input: {
  readonly waitForIdle: () => Promise<unknown>;
  readonly deadlineExpired: () => boolean;
  readonly decision: () => "abort" | "defer";
  /** Injected in tests; real callers leave it alone. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<{ outcome: "idle" | "abandoned"; graceMs?: number }> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  }));
  let settled = false;
  const idle = input.waitForIdle().then(() => { settled = true; });

  // Poll rather than arm one timer up front: the deadline has usually not
  // expired when the wait begins, so there is no grace to arm yet.
  const step = 250;
  let sinceExpiry = 0;
  for (;;) {
    await Promise.race([idle, sleep(step)]);
    if (settled) return { outcome: "idle" };
    if (!input.deadlineExpired()) continue;
    sinceExpiry += step;
    const graceMs = graceForDecision(input.decision());
    if (sinceExpiry >= graceMs) return { outcome: "abandoned", graceMs };
  }
}
