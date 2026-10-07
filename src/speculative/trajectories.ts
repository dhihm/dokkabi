import type { EventRecord } from "../host/schema.ts";

export function acceptedSpeculativeTrajectories(events: readonly EventRecord[]): EventRecord[][] {
  const trajectories: EventRecord[][] = [];
  let start = 0;
  let goal: string | undefined;
  let hasCalls = false;
  let completed = false;
  let accepted = false;
  const reset = (next: number): void => {
    start = next;
    hasCalls = false;
    completed = false;
    accepted = false;
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    switch (event.name) {
      case "work/goal":
        if (event.payload.id !== goal) {
          reset(index);
          goal = typeof event.payload.id === "string" ? event.payload.id : undefined;
        }
        break;
      case "tool/call":
        hasCalls = true;
        completed = false;
        accepted = false;
        break;
      case "work/accept":
        if (event.payload.decision === "done") accepted = hasCalls;
        else reset(index + 1);
        break;
      case "work/checkpoint":
        if (event.payload.reason !== "goal_done") break;
        if (goal !== undefined && event.payload.goal !== goal) {
          reset(index + 1);
          break;
        }
        if (event.payload.status === "completed") completed = true;
        else if (event.payload.status === "pending") completed = false;
        else reset(index + 1);
        break;
      default:
        break;
    }
    if (hasCalls && completed && accepted) {
      trajectories.push(events.slice(start, index + 1));
      reset(index + 1);
    }
  }
  return trajectories;
}
