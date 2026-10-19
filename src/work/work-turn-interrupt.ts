import type { EventLog } from "../host/event-log.ts";
import {
  dispatchInterrupt,
  endsTheRun,
  interruptFromError,
  type InterruptHandler,
} from "../host/interrupt.ts";
import { isRecoveryTerminalError } from "../host/recovery.ts";

export type WorkTurnOutcome =
  | { outcome: "ok" }
  | { outcome: "replanned"; reason: string; line: string };

/** Shared by `dokkabi work` and tests: one turn's weather policy plus interrupt dispatch. */
export async function runWorkTurnWithInterruptHandling(input: {
  run: () => Promise<void>;
  heung: boolean;
  log: EventLog;
  handlers: readonly InterruptHandler[];
}): Promise<WorkTurnOutcome> {
  try {
    await input.run();
    return { outcome: "ok" };
  } catch (error) {
    if (isRecoveryTerminalError(error)) throw error;
    const interrupt = interruptFromError(error);
    const resolution = dispatchInterrupt(interrupt, input.handlers);
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
    if (!input.heung || endsTheRun(resolution)) throw error;
    return { outcome: "replanned", reason: interrupt.reason, line: interrupt.line };
  }
}
