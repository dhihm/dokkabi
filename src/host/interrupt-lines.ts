import {
  TRUNCATED_RETRY_BUDGET_SCALE,
  failureAllowsFailover,
  nextProviderRetry,
  type ModelFailureClass,
} from "./model-failover.ts";
import type { Interrupt, InterruptHandler, Resolution } from "./interrupt.ts";

/**
 * The handlers that own each line.
 *
 * These are the policies the harness already had, moved to where the
 * dispatcher can reach them and written in the one resolution vocabulary. The
 * model line had all of this and had it well — normalize, classify, ask
 * whether failover is allowed, climb a ladder — but only the model line did,
 * so every other interruption grew its own answer at its own call site.
 *
 * Nothing here holds state. An interrupt carries the counters its line needs
 * in `context`, so a handler is a pure function of what happened and can be
 * read, tested and reasoned about on its own.
 */

/** How many times this line has already been retried this turn. */
function count(interrupt: Interrupt, key: string): number {
  const value = interrupt.context?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The model line.
 *
 * The order matters and is the same order the loop used before: a reply that
 * was merely too long is widened, a failure with a rung left is retried on the
 * route that produced it, and only an exhausted ladder asks another route.
 * When no route may be asked, the turn ends — which is a decision, where
 * before it was an uncaught throw.
 */
export function modelInterruptHandler(): InterruptHandler {
  return {
    line: "model",
    handle(interrupt): Resolution | undefined {
      const failure = interrupt.class as ModelFailureClass;

      // The route answered, and answered well, right up to the budget it was
      // given. Another route would be asked the same too-large question.
      if (failure === "output_truncated") {
        const scale = TRUNCATED_RETRY_BUDGET_SCALE[count(interrupt, "truncatedFailures")];
        if (scale !== undefined) return { action: "widen_budget", scale };
        return { action: "end_turn", reason: "output_truncated_ladder_exhausted" };
      }

      // The ladder is not this line's to invent: it is the same
      // PROVIDER_RETRY_POLICY_V1 the loop retries on, asked the same way. This
      // line used to carry its own copy of the per-class tables — two rungs
      // for a dropped link, one for a stalled stream, six for a rate limit —
      // and a second copy is a second answer waiting to disagree with the
      // first. A wait that would outlive the budget the interrupt carries is
      // refused here exactly as the loop refuses it.
      const budgetMsLeft = interrupt.context?.budgetMsLeft;
      const next = nextProviderRetry(count(interrupt, "providerRetries"), failure, {
        ...(typeof budgetMsLeft === "number" && Number.isFinite(budgetMsLeft)
          ? { remainingMs: budgetMsLeft }
          : {}),
        ...(count(interrupt, "retryAfterMs") > 0 ? { retryAfterMs: count(interrupt, "retryAfterMs") } : {}),
      });
      if (next !== undefined) return { action: "retry_same", delayMs: next.delayMs };

      return handover(failure, `${failure}_ladder_exhausted`);
    },
  };
}

function handover(failure: ModelFailureClass, reason: string): Resolution {
  return failureAllowsFailover(failure)
    ? { action: "failover", reason }
    : { action: "end_turn", reason };
}

/**
 * The graph line: the plan itself refusing to move.
 *
 * Both of these used to end the run from their own call site, each having
 * decided on its own that exhausting a local budget meant the work was over.
 * It never did. A repair budget bounds one attempt at sealing, and a stall
 * streak says the current approach is spent — neither is a statement about
 * the fortnight the operator asked for, so both retry while the clock allows
 * and only then stop.
 */
export function graphInterruptHandler(): InterruptHandler {
  return {
    line: "graph",
    handle(interrupt): Resolution | undefined {
      // A todo out of attempts is the wall a wave used to die on. Parking is
      // the honest answer and the only safe one: no bar moves, nothing turns
      // green, the todo stays red and still owed. All the run stops doing is
      // spending the rest of the wave on the one thing that will not move
      // while the parts of the graph that have nothing to do with it wait.
      //
      // It is not deferral. A deferred todo is relaxed out of its dependents'
      // blocked_by because downstream will finish it; this one has not been
      // done, so its dependents stay blocked and only independent work runs.
      if (interrupt.class === "todo_exhausted") {
        return { action: "park", reason: interrupt.reason };
      }
      if (interrupt.class !== "unsealed" && interrupt.class !== "no_progress") return undefined;
      return count(interrupt, "budgetMsLeft") > 0
        ? { action: "retry_same", delayMs: 0 }
        : { action: "stop", reason: interrupt.reason };
    },
  };
}

/**
 * The host line: the machine, or something on it, saying no.
 *
 * A prerequisite that is not there does not become there by being asked
 * again, and it says nothing about the rest of the graph. Parking is the
 * honest answer: this work waits, the other work goes on, and the record
 * carries what was missing rather than the run ending over it.
 */
export function hostInterruptHandler(): InterruptHandler {
  return {
    line: "host",
    handle(interrupt): Resolution | undefined {
      if (interrupt.class === "prerequisite_blocked") {
        return { action: "park", reason: interrupt.reason };
      }
      // The far end is not answering at all. Nothing in the workspace changes
      // that, so retrying at the case's own pace is 206 attempts in 103
      // minutes -- which is what a dropped VPN actually produced. Wait, and
      // wait longer each time, because the fix is a person or a network and
      // both take minutes rather than seconds.
      if (interrupt.class === "host_unreachable") {
        const waited = count(interrupt, "unreachableFailures");
        const delayMs = UNREACHABLE_BACKOFF_MS[Math.min(waited, UNREACHABLE_BACKOFF_MS.length - 1)]!;
        return { action: "retry_same", delayMs };
      }
      return undefined;
    },
  };
}

/**
 * The policy line: a decision a person made, or a rule the run must not talk
 * its way out of.
 *
 * The operator abort is the one interrupt that must reach the run. The safe
 * default would swallow it into a turn, which is exactly wrong — somebody
 * asked it to stop.
 */
/**
 * What a run waits before trying an unreachable host again.
 *
 * Climbing to two minutes: long enough that an outage costs a handful of
 * attempts rather than hundreds, short enough that the run picks the work back
 * up promptly once the link returns.
 */
export const UNREACHABLE_BACKOFF_MS: readonly number[] = Object.freeze([
  5_000, 15_000, 30_000, 60_000, 120_000,
]);

export function policyInterruptHandler(): InterruptHandler {
  return {
    line: "policy",
    handle(interrupt): Resolution | undefined {
      if (interrupt.class === "provider_input_refused") {
        return { action: "stop", reason: "provider_input_refused" };
      }
      if (interrupt.class === "operator_abort") {
        return { action: "stop", reason: "operator_abort" };
      }
      if (interrupt.class === "secret_rejected") {
        // Not a failure to recover from: the call was refused on purpose and
        // must not be retried in any form.
        return { action: "steer", message: "that call was refused; do not send it again in another shape" };
      }
      return undefined;
    },
  };
}

/** Every line this build answers for, in dispatch order. */
export function defaultInterruptHandlers(): readonly InterruptHandler[] {
  return Object.freeze([
    policyInterruptHandler(),
    modelInterruptHandler(),
    graphInterruptHandler(),
    hostInterruptHandler(),
  ]);
}
