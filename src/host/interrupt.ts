/**
 * One interrupt vocabulary for everything that stops work.
 *
 * The harness carries fifty-one typed error classes, four unrelated
 * stop-reason vocabularies, and eighty-three throw sites in its two largest
 * files. Exactly two of those errors have a recovery policy attached. The
 * other forty-nine are thrown and hoped for: if nothing catches one, the
 * process ends. A fortnight-long run died twenty minutes in that way, on a
 * tool loop — a local scheduling decision that had no business ending
 * anything larger than a turn.
 *
 * Fixing those one at a time is what produced the sprawl. A stalled wave, an
 * exhausted repair budget, a dropped link, a truncated reply and a tool loop
 * are five different files with five different mechanisms and no shared idea
 * of what happened or what to do about it — so the fiftieth will be a sixth.
 *
 * So interrupts are raised on a LINE, classified, and dispatched to whichever
 * handler owns that line, exactly as a machine does it. What the handler
 * returns is a resolution, and the resolutions are a closed set: everything
 * the harness already does — retry, widen, steer, end the turn, park, fail
 * over, restart — is one of them.
 *
 * The property that makes this worth having is the default. An interrupt no
 * handler claims resolves to ENDING THE TURN, never to stopping the run. An
 * unrecognised failure is a reason to stop what is in flight and think again;
 * it is not evidence that two weeks of work should end. That single default
 * retires the whole class of bug the forty-nine unpoliced errors represent.
 */

/** Which subsystem raised it. Handlers register per line. */
export type InterruptLine =
  | "model"
  | "tool"
  | "graph"
  | "host"
  | "process"
  | "policy";

/**
 * The smallest unit that must end for this interrupt to clear.
 *
 * Ordered: a call is inside a turn, a turn inside a wave, a wave inside a run.
 * Nothing may resolve to a scope wider than it declares.
 */
export type InterruptScope = "call" | "turn" | "wave" | "run";

const SCOPE_ORDER: readonly InterruptScope[] = ["call", "turn", "wave", "run"];

export interface Interrupt {
  readonly line: InterruptLine;
  /** Category within the line: "output_truncated", "tool_loop", "no_progress". */
  readonly class: string;
  /** Stable code for the log and the operator line. */
  readonly reason: string;
  readonly scope: InterruptScope;
  /** Bounded, already-redacted context. Never a raw provider body. */
  readonly detail?: string;
  /**
   * Counters the line's handler needs — how many rungs of a ladder are spent,
   * how much budget is left. Kept on the interrupt so a handler stays a pure
   * function of what happened, rather than reaching for state of its own.
   */
  readonly context?: Readonly<Record<string, number>>;
}

/**
 * What to do about it. A closed set on purpose: a new interrupt has to answer
 * in the existing vocabulary, which is what stops each one inventing its own.
 */
export type Resolution =
  /** Run it again unchanged, after an optional wait. */
  | { readonly action: "retry_same"; readonly delayMs: number }
  /** Ask again with more room — a reply cut off at its budget. */
  | { readonly action: "widen_budget"; readonly scale: number }
  /** Refuse the call and tell the model what to do instead; the turn lives. */
  | { readonly action: "steer"; readonly message: string }
  /** End the turn and let the work loop replan. */
  | { readonly action: "end_turn"; readonly reason: string }
  /** Set this work aside, keep the rest of the graph moving. */
  | { readonly action: "park"; readonly reason: string; readonly todo?: string }
  /** Another route may answer where this one cannot. */
  | { readonly action: "failover"; readonly reason: string }
  /** The process must come back; the ledger survives it. */
  | { readonly action: "restart"; readonly reason: string }
  /** Genuinely nothing further to do. A handler must say this explicitly. */
  | { readonly action: "stop"; readonly reason: string };

/**
 * The resolution for an interrupt nobody claimed.
 *
 * Ending the turn is the smallest act that reliably clears an unknown
 * condition: the in-flight work stops, the loop replans, and the run keeps its
 * budget. Defaulting to `stop` — which is what an uncaught throw does today —
 * treats every unrecognised failure as terminal.
 */
export const UNHANDLED_RESOLUTION: Resolution = Object.freeze({
  action: "end_turn",
  reason: "unhandled_interrupt",
});

export interface InterruptHandler {
  readonly line: InterruptLine;
  /** A resolution, or undefined to pass it to the next handler on the line. */
  handle(interrupt: Interrupt): Resolution | undefined;
}

/** How wide a resolution reaches, for the scope check below. */
function resolutionScope(resolution: Resolution): InterruptScope {
  switch (resolution.action) {
    case "retry_same":
    case "widen_budget":
    case "steer":
      return "call";
    case "end_turn":
    // Failover ends this attempt and re-issues it on another route. It costs
    // the turn, not the wave — the graph is untouched by which route answered.
    case "failover":
      return "turn";
    // Parking sets work aside for the rest of the wave so the other todos can
    // move; that is a scheduling act, one level above the turn.
    case "park":
      return "wave";
    case "restart":
    case "stop":
      return "run";
  }
}

/**
 * Resolve one interrupt.
 *
 * Handlers are tried in registration order on the interrupt's own line, and
 * the first that claims it wins. A handler may not answer wider than the
 * interrupt declared — a call-scoped failure cannot end the run, whatever a
 * handler thinks — so a mis-registered handler degrades to ending the turn
 * rather than taking the run down with it.
 */
export function dispatchInterrupt(
  interrupt: Interrupt,
  handlers: readonly InterruptHandler[],
): Resolution {
  const declared = SCOPE_ORDER.indexOf(interrupt.scope);
  for (const handler of handlers) {
    if (handler.line !== interrupt.line) continue;
    const resolution = handler.handle(interrupt);
    if (resolution === undefined) continue;
    if (SCOPE_ORDER.indexOf(resolutionScope(resolution)) > declared) {
      return { action: "end_turn", reason: `${interrupt.reason}_over_scope` };
    }
    return resolution;
  }
  return UNHANDLED_RESOLUTION;
}

/**
 * The typed errors that already carry a meaning, and their line.
 *
 * Keyed by constructor name rather than by importing every class: this module
 * sits under all of them, and a taxonomy that has to import its subjects
 * cannot stay at the bottom.
 */
const KNOWN_ERRORS: Readonly<Record<string, Omit<Interrupt, "detail">>> = Object.freeze({
  ToolLoopError: { line: "tool", class: "tool_loop", reason: "tool_loop", scope: "turn" },
  OperatorAbortError: { line: "policy", class: "operator_abort", reason: "operator_abort", scope: "run" },
  TurnAbandonedError: { line: "policy", class: "turn_abandoned", reason: "turn_abandoned", scope: "turn" },
  EmptyCompletionError: { line: "model", class: "empty_completion", reason: "empty_completion", scope: "turn" },
  StreamStallError: { line: "model", class: "transport", reason: "stream_stalled", scope: "turn" },
  SafeModelFailureError: { line: "model", class: "route_failure", reason: "route_failure", scope: "turn" },
  SecretRejectedError: { line: "policy", class: "secret_rejected", reason: "secret_rejected", scope: "call" },
  ProviderInputError: { line: "policy", class: "provider_input_refused", reason: "provider_input_refused", scope: "run" },
  PrerequisiteBlockedError: { line: "host", class: "prerequisite_blocked", reason: "prerequisite_blocked", scope: "wave" },
  // ssh answered 255: it never connected. The turn is what is interrupted --
  // the far end being gone says nothing about the wave's plan.
  HostUnreachableError: { line: "host", class: "host_unreachable", reason: "host_unreachable", scope: "turn" },
});

/**
 * Any thrown value as an interrupt.
 *
 * What an unrecognised error becomes is the whole point: a TURN-scoped
 * process interrupt. It stops what is in flight and nothing more. Forty-nine
 * of the harness's error classes have no policy of their own, and until they
 * grow one this is what keeps them from ending a run.
 */
export function interruptFromError(error: unknown): Interrupt {
  const name = error instanceof Error ? error.name : "";
  const known = KNOWN_ERRORS[name];
  if (known) return { ...known };
  return {
    line: "process",
    class: "unclassified",
    reason: name ? `unclassified_${name}` : "unclassified",
    scope: "turn",
  };
}

/** True when the run must not continue in this process. */
export function endsTheRun(resolution: Resolution): boolean {
  return resolution.action === "stop" || resolution.action === "restart";
}
