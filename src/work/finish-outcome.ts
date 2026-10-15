import type { EventRecord } from "../host/schema.ts";

export type TaskOutcome = "completed" | "blocked" | "incomplete";
export function isTaskOutcome(value: unknown): value is TaskOutcome {
  return value === "completed" || value === "blocked" || value === "incomplete";
}

/** The model owns the semantic outcome. A finish invocation or a green
 * prerequisite receipt never supplies it; historical omissions stay unknown. */
export function recordedTaskOutcome(events: readonly EventRecord[]): TaskOutcome | "unknown" {
  const row = [...events].reverse().find(event => event.name === "work/finish");
  return isTaskOutcome(row?.payload.task_outcome) ? row!.payload.task_outcome as TaskOutcome : "unknown";
}

export function finishTaskStatus(events: readonly EventRecord[], finishSupported: boolean): {
  outcome: TaskOutcome | "unknown"; status: "done" | "blocked" | "incomplete";
} {
  const outcome = recordedTaskOutcome(events);
  return { outcome, status: !finishSupported ? "incomplete"
    : outcome === "completed" ? "done" : outcome === "blocked" ? "blocked" : "incomplete" };
}
