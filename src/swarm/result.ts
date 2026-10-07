import type { EventLog } from "../host/event-log.ts";
import type { SwarmChildOutcome } from "./child-runner.ts";
import { appendSwarmFinish, type SwarmChildStatus, type SwarmStatus } from "./events.ts";
import type { SwarmRunResult } from "./types.ts";

export function appendAgentStatus(log: EventLog, status: "running" | "idle" | "failed"): void {
  log.append({ kind: "observe", name: "agent/status", payload: { status, operation: "swarm" } });
}

export function finishSwarm(log: EventLog, input: {
  readonly parentSession: string;
  readonly status: SwarmStatus;
  readonly candidateCompleted: number;
  readonly candidateTotal: number;
  readonly reviewerStatus: SwarmChildStatus | "missing";
  readonly finalized: boolean;
}): void {
  appendSwarmFinish(log, input);
  appendAgentStatus(log, input.status === "completed" ? "idle" : "failed");
}

export function failedSwarmResult(
  parentSessionId: string,
  outcomes: readonly SwarmChildOutcome[],
): SwarmRunResult {
  return {
    parentSessionId,
    status: "failed",
    children: outcomes.map((outcome) => outcome.report),
    finalized: false,
    patchDigest: "missing",
  };
}
