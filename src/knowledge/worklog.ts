import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { EventRecord } from "../host/schema.ts";
import type { KnowledgeEvidence } from "./types.ts";

export interface WorkCheckpointProjectionInput {
  events: readonly EventRecord[];
  goalId: string;
  reason: "todo_clear" | "goal_done";
  todoId?: string;
}

export interface WorkCheckpointProjection {
  checkpointDigest: string;
  title: string;
  body: string;
  evidence: KnowledgeEvidence[];
  task: string;
}

/** Deterministic EventLog -> Markdown projection. No model transcript synthesis. */
export function projectWorkCheckpoint(input: WorkCheckpointProjectionInput): WorkCheckpointProjection {
  const start = latestGoalIndex(input.events, input.goalId);
  if (start < 0) throw new Error(`knowledge checkpoint cannot find goal ${input.goalId}`);
  const tail = input.events.slice(start);
  const terminal = terminalIndex(tail, input);
  const events = tail.slice(0, terminal + 1);
  const final = events[terminal];
  if (!final) throw new Error("knowledge checkpoint has no durable events");
  const checkpointDigest = digest({
    goal: input.goalId,
    reason: input.reason,
    todo: input.todoId ?? "",
    head: final.hash,
  });
  const goal = events.find((event) => event.name === "work/goal" && event.payload.id === input.goalId);
  const statement = typeof goal?.payload.statement === "string" ? goal.payload.statement : input.goalId;
  const todo = input.todoId
    ? events.find((event) => event.name === "work/todo" && event.payload.id === input.todoId)
    : undefined;
  const caseTransitions = caseTransitionLines(events, input.todoId);
  const failures = toolFailureLines(events);
  const operatorNotes = events
    .filter((event) => event.name === "operator/note" && typeof event.payload.text === "string")
    .map((event) => `- ${event.payload.text}`);
  const cleared = events
    .filter((event) => event.name === "work/clear" && (!input.todoId || event.payload.todo === input.todoId))
    .map((event) => String(event.payload.todo));
  const allCleared = new Set(events.filter((event) => event.name === "work/clear").map((event) => String(event.payload.todo)));
  const nextSteps = events
    .filter((event) => event.name === "work/todo" && typeof event.payload.id === "string" && !allCleared.has(event.payload.id))
    .map((event) => `- ${event.payload.id}: ${String(event.payload.title ?? event.payload.statement ?? "pending")}`);
  const evidenceEvents = events.filter((event) =>
    event.name === "work/goal" || event.name === "work/case" || event.name === "work/clear"
      || event.name === "tool/end" || event.name === "operator/note" || event.name === "swarm/finalized"
  );
  const evidence = evidenceEvents.map((event) => ({
    kind: "event" as const,
    locator: `event:${event.hash}`,
    digest: event.hash,
  }));
  const timestamp = final.ts;
  const lines = [
    `<!-- dokkabi-checkpoint:${checkpointDigest} -->`,
    `## ${timestamp} — ${input.reason === "goal_done" ? "Goal completed" : `Todo cleared: ${input.todoId ?? "unknown"}`}`,
    "",
    `Goal: ${statement}`,
    ...(todo && typeof todo.payload.title === "string" ? [`Todo: ${todo.payload.title}`] : []),
    ...(caseTransitions.length > 0 ? ["", "### Cases", ...caseTransitions] : []),
    ...(failures.length > 0 ? ["", "### Failures and observations", ...failures] : []),
    ...(operatorNotes.length > 0 ? ["", "### Operator notes", ...operatorNotes] : []),
    ...(cleared.length > 0 ? ["", `Cleared: ${[...new Set(cleared)].sort().join(", ")}`] : []),
    ...(nextSteps.length > 0 ? ["", "### Next steps", ...[...new Set(nextSteps)].sort()] : []),
    "",
    "### Evidence",
    ...evidence.map((item) => `- ${item.locator}`),
  ];
  return {
    checkpointDigest,
    title: `Worklog for ${input.goalId}`,
    body: lines.join("\n"),
    evidence,
    task: input.goalId,
  };
}

function terminalIndex(
  events: readonly EventRecord[],
  input: WorkCheckpointProjectionInput,
): number {
  // A clear/done transition is monotonic within one bound plan. Select its
  // first durable occurrence so restarting an already-complete drive cannot
  // manufacture a second journal checkpoint from a duplicate terminal step.
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (input.reason === "todo_clear" && event.name === "work/clear" && event.payload.todo === input.todoId) return index;
    if (input.reason === "goal_done" && event.name === "work/step" && event.payload.action === "done") return index;
  }
  // Compatibility for imported logs that predate the explicit terminal step.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if ((event.name.startsWith("work/") && event.name !== "work/checkpoint") || event.name === "tool/end") return index;
  }
  return -1;
}

function latestGoalIndex(events: readonly EventRecord[], goalId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name === "work/goal" && event.payload.id === goalId) return index;
  }
  return -1;
}

function caseTransitionLines(events: readonly EventRecord[], todoId?: string): string[] {
  const scenarioIds = todoId
    ? new Set(events.filter((event) => event.name === "work/scenario" && event.payload.todo === todoId).map((event) => String(event.payload.id)))
    : undefined;
  const states = new Map<string, string[]>();
  for (const event of events) {
    if (event.name !== "work/case" || typeof event.payload.id !== "string" || typeof event.payload.status !== "string") continue;
    if (scenarioIds && typeof event.payload.scenario === "string" && scenarioIds.size > 0 && !scenarioIds.has(event.payload.scenario)) continue;
    const sequence = states.get(event.payload.id) ?? [];
    if (sequence.at(-1) !== event.payload.status) sequence.push(event.payload.status);
    states.set(event.payload.id, sequence);
  }
  return [...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, values]) => `- ${id}: ${values.map((value) => value.toUpperCase()).join(" → ")}`);
}

function toolFailureLines(events: readonly EventRecord[]): string[] {
  return events
    .filter((event) => event.name === "tool/end" && (event.payload.status === "failed" || event.payload.status === "error"))
    .map((event) => `- tool ${String(event.payload.name ?? "unknown")} failed (${typeof event.payload.result_digest === "string" ? event.payload.result_digest.slice(0, 12) : event.hash.slice(0, 12)})`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
