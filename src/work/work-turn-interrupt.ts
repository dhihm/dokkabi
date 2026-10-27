import type { EventLog } from "../host/event-log.ts";
import {
  dispatchInterrupt,
  endsTheRun,
  interruptFromError,
  type InterruptHandler,
} from "../host/interrupt.ts";
import type { RouteFailureClassV1 } from "../host/model-failover.ts";
import { isRecoveryTerminalError } from "../host/recovery.ts";
import { SafeModelFailureError } from "../plugins/loop-pi.ts";
import {
  type RouteFailureReplanBudget,
  noteRouteFailureReplanTurnSuccess,
  takeRouteFailureReplan,
} from "./route-failure-replan.ts";

/** Plain SafeModelFailureError classes that must not become a HEUNG route_failure replan. */
const PLAIN_SAFE_MODEL_FAILURE_ENDS_RUN: ReadonlySet<RouteFailureClassV1> = new Set([
  "auth_unavailable",
  "quota_exhausted",
  "invalid_request",
  "content_rejected",
  "context_exhausted",
  "policy_failure",
]);

export type WorkTurnOutcome =
  | { outcome: "ok" }
  | { outcome: "replanned"; reason: string; line: string };

/** Shared by `dokkabi work` and tests: one turn's weather policy plus interrupt dispatch. */
export async function runWorkTurnWithInterruptHandling(input: {
  run: () => Promise<void>;
  heung: boolean;
  log: EventLog;
  handlers: readonly InterruptHandler[];
  /** Bounds consecutive HEUNG replans after replannable plain SafeModelFailureError (issue #308). */
  routeFailureReplanBudget?: RouteFailureReplanBudget;
}): Promise<WorkTurnOutcome> {
  const budget = input.routeFailureReplanBudget;
  const remainingAtTurnStart = budget?.remaining;
  try {
    await input.run();
    if (budget !== undefined && remainingAtTurnStart !== undefined) {
      noteRouteFailureReplanTurnSuccess(budget, remainingAtTurnStart);
    }
    return { outcome: "ok" };
  } catch (error) {
    if (isRecoveryTerminalError(error)) throw error;
    let replannablePlainSafeFailure = false;
    if (error instanceof SafeModelFailureError) {
      if (error.recoveryTerminalReason !== undefined) throw error;
      if (PLAIN_SAFE_MODEL_FAILURE_ENDS_RUN.has(error.failure.class)) throw error;
      replannablePlainSafeFailure = true;
    }
    const interrupt = interruptFromError(error);
    const resolution = dispatchInterrupt(interrupt, input.handlers);
    if (!input.heung || endsTheRun(resolution)) {
      input.log.append({
        kind: "observe",
        name: "work/interrupt",
        payload: {
          line: interrupt.line,
          class: interrupt.class,
          reason: interrupt.reason,
          scope: interrupt.scope,
          resolution: resolution.action,
        },
      });
      throw error;
    }
    if (replannablePlainSafeFailure && budget && !takeRouteFailureReplan(budget)) {
      input.log.append({
        kind: "observe",
        name: "work/interrupt",
        payload: {
          line: interrupt.line,
          class: interrupt.class,
          reason: interrupt.reason,
          scope: interrupt.scope,
          resolution: "stop",
          route_failure_replan_exhausted: true,
          consecutive_replans_remaining: budget.remaining,
        },
      });
      throw error;
    }
    input.log.append({
      kind: "observe",
      name: "work/interrupt",
      payload: {
        line: interrupt.line,
        class: interrupt.class,
        reason: interrupt.reason,
        scope: interrupt.scope,
        resolution: resolution.action,
      },
    });
    return { outcome: "replanned", reason: interrupt.reason, line: interrupt.line };
  }
}
