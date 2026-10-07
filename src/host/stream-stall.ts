/**
 * Silent-stream stall detection.
 *
 * A provider stream can stop without erroring: the connection stays open,
 * no delta arrives, nothing throws. The turn deadline (`timeoutMs`,
 * model/turn_budget) cannot tell a slow honest generation from a dead
 * socket, and the interactive chat path ran with no deadline at all. One
 * observed stall held a chat turn for ~1300 seconds at 30-50% CPU with the
 * last delta four seconds in; only a manual kill ended it.
 *
 * The watchdog here is delta-based and two-phased: before the first
 * assistant delta a request may legitimately wait on a queue or a long
 * prefill, so it gets the larger first-delta budget; once deltas flow, a
 * gap of `streamIdleMs` with no tool executing is a stall. A model thinking
 * at 11 tok/s still ticks; a stalled socket does not.
 */

/** No assistant delta for this long, after the first one, is a stall. */
export const DEFAULT_STREAM_IDLE_MS = 90_000;
/** Time allowed for the FIRST delta: queueing and prefill are honest
 * silence, so this budget is the larger one. */
export const DEFAULT_STREAM_FIRST_DELTA_MS = 300_000;
/** setTimeout clamps larger delays to 1 ms — an "effectively unlimited"
 * override would otherwise fire immediately. */
export const MAX_TIMER_MS = 2_147_483_647;

export const STREAM_STALL_ERROR_CODE = "ESTREAMSTALL";

export class StreamStallError extends Error {
  readonly code = STREAM_STALL_ERROR_CODE;
  readonly idleMs: number;
  readonly chars: number;
  constructor(idleMs: number, chars: number) {
    super(
      `model stream stalled: no delta for ${Math.round(idleMs / 1000)}s after ${chars} chars; `
      + "the request was aborted as a transport timeout",
    );
    this.name = "StreamStallError";
    this.idleMs = idleMs;
    this.chars = chars;
  }
}

/** The slice of turn state the stall decision reads. */
export interface StreamActivity {
  /** A model request is between turn_start and its assistant message_end. */
  streaming?: boolean;
  /** Tools executing right now — their silence is not the stream's. */
  activeToolCalls: number;
  /** Wall-clock of the last assistant delta (or the request start). */
  lastStreamActivityAt?: number;
  /** Whether any assistant delta has arrived for the current request. */
  firstDeltaSeen?: boolean;
  streamIdleMs?: number;
  streamFirstDeltaMs?: number;
}

/** Idle milliseconds when the stream counts as stalled, else undefined.
 * Pure: the caller owns the clock and the timer. */
export function streamIdleFor(state: StreamActivity, now: number): number | undefined {
  if (state.streamIdleMs === undefined || state.streamIdleMs <= 0) return undefined;
  if (state.streaming !== true || state.activeToolCalls > 0) return undefined;
  if (state.lastStreamActivityAt === undefined) return undefined;
  const firstDelta = state.streamFirstDeltaMs !== undefined && state.streamFirstDeltaMs > 0
    ? state.streamFirstDeltaMs
    : state.streamIdleMs;
  const limit = state.firstDeltaSeen === true ? state.streamIdleMs : Math.max(firstDelta, state.streamIdleMs);
  const idle = now - state.lastStreamActivityAt;
  return idle > limit ? idle : undefined;
}

export interface InteractiveTurnBudget {
  timeoutMs?: number;
  streamIdleMs?: number;
  streamFirstDeltaMs?: number;
}

function budgetFromEnv(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  // A malformed or overflowing override keeps the default: a typo must not
  // silently remove the only bound on a silent connection, and a value past
  // the timer range would fire at once instead of never. `0` is the
  // explicit off switch.
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMER_MS) return fallback;
  return value === 0 ? undefined : value;
}

/** The stall watchdog budgets every turn resolves when its caller passes
 * nothing: `DOKKABI_STREAM_IDLE_MS` (default 90000) and
 * `DOKKABI_STREAM_FIRST_DELTA_MS` (default 300000). Positive integers within
 * the timer range, `0` to disable, anything else keeps the default. */
export function resolveStreamIdleBudget(env: NodeJS.Dict<string> = process.env): {
  streamIdleMs?: number;
  streamFirstDeltaMs?: number;
} {
  const streamIdleMs = budgetFromEnv(env.DOKKABI_STREAM_IDLE_MS, DEFAULT_STREAM_IDLE_MS);
  const streamFirstDeltaMs = budgetFromEnv(env.DOKKABI_STREAM_FIRST_DELTA_MS, DEFAULT_STREAM_FIRST_DELTA_MS);
  return {
    ...(streamIdleMs === undefined ? {} : { streamIdleMs }),
    ...(streamFirstDeltaMs === undefined ? {} : { streamFirstDeltaMs }),
  };
}

/** Interactive turns (chat, turn, resume): the watchdog budgets plus an
 * OPT-IN whole-turn deadline, `DOKKABI_CHAT_TURN_TIMEOUT_MS`. Off by
 * default — a whole-turn deadline counts tool execution and healthy
 * streaming, so it cuts legitimately long agentic turns; the watchdog is
 * what closes the silent-stall incident. */
export function resolveInteractiveTurnBudget(env: NodeJS.Dict<string> = process.env): InteractiveTurnBudget {
  const timeoutMs = budgetFromEnv(env.DOKKABI_CHAT_TURN_TIMEOUT_MS, undefined);
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...resolveStreamIdleBudget(env),
  };
}
