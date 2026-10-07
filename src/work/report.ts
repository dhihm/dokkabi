import type { EventRecord } from "../host/schema.ts";
import type { DriveResult, DriveStep } from "./drive.ts";
import { viewPlan } from "./view.ts";

export function formatWorkReport(input: {
  result: DriveResult;
  planPath?: string;
  order?: string;
  sessionId: string;
  logPath: string;
  verbose?: boolean;
  /** Final host disposition, which may refuse a green work graph. */
  terminalStatus?: string;
  events?: readonly EventRecord[];
}): string {
  const { result } = input;
  const green = unique(result.steps.flatMap((step) => step.green ?? []));
  const red = unique(result.steps.flatMap((step) => step.red ?? []));
  const newly = unique(result.steps.flatMap((step) => step.cleared ?? []));
  const total = result.plan.todos.length;
  const clearNow = countClear(result, input.events);
  const spoken = input.terminalStatus && input.terminalStatus !== "done"
    ? `Not completed. Work stopped with status ${input.terminalStatus}; ${clearNow}/${total} obligations are clear.`
    : result.status === "done" ? lastAssistantText(input.events)
    : formatIncompleteWorkReport(result, input.events).text;
  const lines = [
    spoken ??
      prose(result, result.plan.goal.statement, newly.length, clearNow, total, green.length),
  ];
  if (input.verbose) {
    lines.push("");
    for (const step of result.steps) {
      lines.push(formatStep(step));
    }
    if (red.length > 0) {
      lines.push(`red: ${red.join(", ")}`);
    }
    lines.push(`status=${input.terminalStatus ?? result.status}`);
    lines.push(`plan=${input.planPath ?? "(none)"}`);
    lines.push(`goal=${result.plan.goal.id}`);
    lines.push(`session=${input.sessionId}`);
    lines.push(`log=${input.logPath}`);
  }
  return `${lines.join("\n")}\n`;
}

/** An unsuccessful work result has host-owned status, not a fresh model
 * narrative. Earlier assistant claims remain in the trace for inspection. */
export function formatIncompleteWorkReport(result: DriveResult, events: readonly EventRecord[] = []) {
  const clear = countClear(result, events), total = result.plan.todos.length;
  const failure = [...events].reverse().find(row => row.name === "work/step" && row.payload.action === "blocked");
  const reason = typeof failure?.payload.reason === "string" ? failure.payload.reason : [...result.steps].reverse().find(step => step.error)?.error?.reason;
  return { source: "host" as const, status: result.status, clear, total,
    text: `Not completed. Work stopped with status ${result.status}; ${clear}/${total} obligations are clear.${reason ? " " + reason : ""}`,
    ...(failure ? { reason_ref: { seq: failure.seq, hash: failure.hash } } : {}) };
}

function prose(
  result: DriveResult,
  goal: string,
  newly: number,
  clearNow: number,
  total: number,
  green: number,
): string {
  const about = trimAsk(goal).replace(/\.$/, "");
  if (result.status === "done" && newly === 0) {
    return `${about}. Already green — all ${total} todos were already clear.`;
  }
  if (result.status === "done") {
    return `Done. ${about}. I cleared ${newly} todos (${clearNow}/${total} clear).`;
  }
  if (result.status === "still_red") {
    return `Not done. ${about}. I implemented once and the same cases are still red.`;
  }
  if (result.status === "need_implement") {
    return `Not done. ${about}. The next todo is still red and implement did not run.`;
  }
  if (result.status === "need_scenarios") {
    return `I stopped before coding. The next todo has no Given/When/Then yet.`;
  }
  if (result.status === "need_cases") {
    return `I stopped before coding. A scenario has no case yet.`;
  }
  if (result.status === "blocked") {
    return `I could not start. Ready todos are still blocked.`;
  }
  return `Not done. ${about}. ${green} green, ${clearNow}/${total} todos clear.`;
}

function lastAssistantText(events: readonly EventRecord[] | undefined): string | undefined {
  if (!events) {
    return undefined;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "assistant/message") {
      continue;
    }
    const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
    const stop = typeof event.payload.stop === "string" ? event.payload.stop : "";
    if (stop === "error" || !text) {
      continue;
    }
    return text;
  }
  return undefined;
}

function trimAsk(ask: string): string {
  const text = ask.replace(/\s+/g, " ").trim();
  if (text.length <= 180) {
    return text;
  }
  return `${text.slice(0, 177)}...`;
}

function countClear(result: DriveResult, events: readonly EventRecord[] | undefined): number {
  if (result.status === "done") {
    return result.plan.todos.length;
  }
  if (!events) {
    return unique(result.steps.flatMap((step) => step.cleared ?? [])).length;
  }
  const view = viewPlan(result.plan, events);
  return result.plan.todos.filter((todo) => view.todoState[todo.id] === "clear").length;
}

function formatStep(step: DriveStep): string {
  const bits = [`step=${step.action}`];
  if (step.todo) {
    bits.push(`todo=${step.todo}`);
  }
  if (step.green) {
    bits.push(`green=${step.green.join(",") || "(none)"}`);
  }
  if (step.red) {
    bits.push(`red=${step.red.join(",") || "(none)"}`);
  }
  if (step.cleared) {
    bits.push(`cleared=${step.cleared.join(",") || "(none)"}`);
  }
  return bits.join(" ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
