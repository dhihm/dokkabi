import type { EventRecord } from "./schema.ts";

export interface CompactionCheckpoint {
  version: 1;
  objective: string;
  completed_work: string[];
  pending_work: string[];
  tests: {
    green: string[];
    red: string[];
  };
  next_action: string;
}

/**
 * Build durable memory only from EventLog facts. Unlike a model-authored
 * prose summary, every field can be reconstructed during replay and carries
 * no hidden reasoning. EventLog has already rejected secret-shaped values.
 */
export function buildCompactionCheckpoint(events: readonly EventRecord[]): CompactionCheckpoint {
  let objective = "Continue the current operator goal.";
  const todos: string[] = [];
  const cleared = new Set<string>();
  const caseState = new Map<string, "green" | "red">();
  let nextAction = "Continue the first pending work item.";

  let latestGoalIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "work/goal" && typeof events[i]?.payload.statement === "string") {
      latestGoalIndex = i;
      objective = String(events[i]!.payload.statement);
      break;
    }
  }
  if (latestGoalIndex < 0) {
    const firstOrder = events.find((event) => event.name === "user/message" && typeof event.payload.text === "string");
    if (firstOrder) objective = String(firstOrder.payload.text);
  }
  const workEvents = latestGoalIndex >= 0 ? events.slice(latestGoalIndex) : events;

  for (const event of workEvents) {
    if (event.name === "work/goal" && typeof event.payload.statement === "string") {
      objective = event.payload.statement;
    }
    if (event.name === "work/todo" && typeof event.payload.id === "string" && !todos.includes(event.payload.id)) {
      todos.push(event.payload.id);
    }
    if (event.name === "work/clear" && typeof event.payload.todo === "string") {
      cleared.add(event.payload.todo);
    }
    if (
      event.name === "work/case" &&
      typeof event.payload.id === "string" &&
      (event.payload.status === "green" || event.payload.status === "red")
    ) {
      caseState.set(event.payload.id, event.payload.status);
    }
    if (event.name === "work/doing" && typeof event.payload.todo === "string") {
      nextAction = event.payload.todo;
    }
  }

  const completed = todos.filter((id) => cleared.has(id));
  const pending = todos.filter((id) => !cleared.has(id));
  if (pending.length > 0 && (nextAction === "Continue the first pending work item." || cleared.has(nextAction))) {
    nextAction = pending[0]!;
  }

  return {
    version: 1,
    objective,
    completed_work: completed,
    pending_work: pending,
    tests: {
      green: [...caseState].filter(([, status]) => status === "green").map(([id]) => id),
      red: [...caseState].filter(([, status]) => status === "red").map(([id]) => id),
    },
    next_action: nextAction,
  };
}

/** The marker is data, not a fresh operator order. Keep the JSON canonical so
 * the checkpoint recorded in compaction/drop exactly reconstructs the model
 * message. */
export function compactionCheckpointText(checkpoint: CompactionCheckpoint): string {
  return `[dokkabi compaction checkpoint; kind=dokkabi.compaction_checkpoint; host-derived non-authoritative state] ${JSON.stringify(checkpoint)}`;
}
