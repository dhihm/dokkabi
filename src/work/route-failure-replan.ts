/**
 * Consecutive HEUNG route_failure replans allowed before provider_failure.
 * Matches the three-wait transient turn budget in `transient-retry.ts` (weather, not a verdict).
 */
export const ROUTE_FAILURE_REPLAN_BUDGET = 3;

/** Tracks consecutive replannable plain SafeModelFailureError turns (issue #308). */
export interface RouteFailureReplanBudget {
  readonly maxConsecutive: number;
  remaining: number;
}

export function routeFailureReplanBudget(input: { once?: boolean } = {}): RouteFailureReplanBudget {
  const maxConsecutive = input.once ? 0 : ROUTE_FAILURE_REPLAN_BUDGET;
  return { maxConsecutive, remaining: maxConsecutive };
}

/** True when another consecutive route_failure replan is still allowed. */
export function takeRouteFailureReplan(budget: RouteFailureReplanBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

/**
 * Refill after a turn that completed without consuming replan budget this call.
 * Skips refill when an inner `runWorkTurn` replanned (budget already decremented).
 */
export function noteRouteFailureReplanTurnSuccess(
  budget: RouteFailureReplanBudget,
  remainingAtTurnStart: number,
): void {
  if (budget.remaining === remainingAtTurnStart) {
    budget.remaining = budget.maxConsecutive;
  }
}
