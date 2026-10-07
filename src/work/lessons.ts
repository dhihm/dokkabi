import type { EventRecord } from "../host/schema.ts";
import type { WorkPlan } from "./schema.ts";

/**
 * Wave lessons: what a failed wave must teach the next one.
 *
 * Run 30 (flask-5063) replanned twice on a bare status word; the model
 * retried the same strategy and the budget burned. At every replan the host
 * records a work/lesson observation — wave, status, the stuck todo, and each
 * stuck case WITH the tail of its real failure output — and the replan
 * prompt carries the accumulated ledger. The model infers the lesson; the
 * host only preserves the evidence (the model still owns the reasoning).
 */

/** Same digest verify.ts uses for case tool-call ids. */
function argDigestOf(command: string): string {
  return command.replaceAll(/[^a-z0-9]+/gi, "-").slice(0, 24) || "cmd";
}

/** The last failure output the log recorded for this case command. */
export function caseFailureTail(events: readonly EventRecord[], command: string): string | undefined {
  const id = `case-${argDigestOf(command)}`;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "tool/result" || event.payload.id !== id || event.payload.error !== true) {
      continue;
    }
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    // pytest's summary line truncates the assertion ("assert 'Hos...") —
    // the FAILURES section body carries the expected-vs-actual diff that
    // actually teaches (run 35 repeated the same wrong edit without it).
    const lines = text.trim().split("\n");
    const failuresAt = lines.findIndex((line) => /^=+ FAILURES =+$/.test(line.trim()));
    const summaryAt = lines.findIndex((line) => /=+ short test summary/.test(line));
    const body =
      failuresAt >= 0
        ? lines.slice(failuresAt + 1, summaryAt > failuresAt ? summaryAt : undefined)
        : lines;
    const tail = body
      .filter((line) => line.trim().length > 0)
      .slice(-6)
      .join(" | ");
    return tail.slice(0, 500) || undefined;
  }
  return undefined;
}

export interface WaveLessonInput {
  events: readonly EventRecord[];
  plan: WorkPlan;
  wave: number;
  status: string;
  stuckTodo?: string;
  stuckCases?: readonly string[];
}

/** Other todos whose cases run the exact same command (runs 30/35: locate
 * tied to the official test could never clear before fix — the deadlock is
 * named so the replan rescopes instead of re-implementing). */
function commandSharedWith(plan: WorkPlan, todoId: string | undefined, command: string): string[] {
  if (!todoId) {
    return [];
  }
  const todoOf = new Map(plan.scenarios.map((scenario) => [scenario.id, scenario.todo]));
  const owners = new Set<string>();
  for (const item of plan.cases) {
    if (item.command === command) {
      const owner = todoOf.get(item.scenario);
      if (owner && owner !== todoId) {
        owners.add(owner);
      }
    }
  }
  return [...owners];
}

/**
 * The cases standing red right now, latest verdict per case.
 *
 * The evidence a wave leaves behind when it did not end on an implement. A
 * wave that ends `blocked` -- everything parked, nothing pickable -- has no
 * stuck todo and so used to record no cases at all, which is exactly the wave
 * whose lesson matters most. 689 lessons in a row read `wave N (still_red)`
 * and said nothing else.
 */
function redRightNow(events: readonly EventRecord[]): string[] {
  const verdict = new Map<string, string>();
  for (const event of events) {
    if (event.name !== "work/case") continue;
    const payload = event.payload as { id?: unknown; status?: unknown };
    if (typeof payload.id !== "string") continue;
    if (payload.status === "red" || payload.status === "green") {
      verdict.set(payload.id, String(payload.status));
    }
  }
  return [...verdict].filter(([, status]) => status === "red").map(([id]) => id).sort();
}

/** The work/lesson event payload for one finished (failed) wave. */
export function waveLessonPayload(input: WaveLessonInput): Record<string, unknown> {
  // Falling back to what is red keeps the evidence flowing when the wave ended
  // blocked rather than on an implement.
  const ids = input.stuckCases && input.stuckCases.length > 0
    ? input.stuckCases
    : redRightNow(input.events);
  const cases = ids.map((id) => {
    const item = input.plan.cases.find((row) => row.id === id);
    const failure = item?.command ? caseFailureTail(input.events, item.command) : undefined;
    const sharedWith = item?.command
      ? commandSharedWith(input.plan, input.stuckTodo, item.command)
      : [];
    return {
      id,
      ...(item?.command ? { command: item.command } : {}),
      ...(failure ? { failure } : {}),
      ...(sharedWith.length > 0 ? { shared_with: sharedWith } : {}),
    };
  });
  return {
    wave: input.wave,
    status: input.status,
    ...(input.stuckTodo ? { todo: input.stuckTodo } : {}),
    cases,
  };
}

/**
 * How many lessons the prompt carries.
 *
 * A ledger is evidence while it is short enough to read. One run put 689
 * lessons in front of the model, every one of them the bare line
 * `wave N (still_red)`, and the prompt asked it to infer what each failure
 * taught. Old, contentless waves are not evidence; they are the reason the
 * next wave repeats.
 */
const LESSON_LIMIT = 24;

/** Every recorded lesson, oldest first, one prompt-ready line each. */
export function lessonLines(events: readonly EventRecord[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.name !== "work/lesson") {
      continue;
    }
    const payload = event.payload;
    const wave = typeof payload.wave === "number" ? payload.wave : "?";
    const status = typeof payload.status === "string" ? payload.status : "?";
    const todo = typeof payload.todo === "string" ? ` ${payload.todo}` : "";
    const cases = Array.isArray(payload.cases) ? payload.cases : [];
    const caseBits = cases
      .map((item) => {
        if (typeof item !== "object" || item === null) {
          return "";
        }
        const row = item as { id?: unknown; failure?: unknown; shared_with?: unknown };
        const id = typeof row.id === "string" ? row.id : "?";
        const failure = typeof row.failure === "string" ? `: ${row.failure}` : "";
        const shared =
          Array.isArray(row.shared_with) && row.shared_with.length > 0
            ? ` [same command as ${row.shared_with.join(",")} — this todo can NEVER clear first; give it its own evidence case]`
            : "";
        return `${id}${shared}${failure}`;
      })
      .filter((bit) => bit.length > 0)
      .join("; ");
    lines.push(`wave ${wave} (${status})${todo ? ` —${todo}` : ""}${caseBits ? ` — ${caseBits}` : ""}`);
  }
  // A lesson with no evidence teaches nothing, and a run of them teaches
  // nothing many times over. Keep one so the streak is still visible, drop the
  // rest, and hand over only the recent tail.
  const kept: string[] = [];
  for (const line of lines) {
    const bare = !line.includes(" — ");
    if (bare && kept.length > 0 && !kept.at(-1)!.includes(" — ")) {
      kept[kept.length - 1] = line;
      continue;
    }
    kept.push(line);
  }
  return kept.slice(-LESSON_LIMIT);
}

/** Prompt block: the ledger plus the demand that the plan actually change. */
export function formatLessonsBlock(lessons: readonly string[]): string[] {
  if (lessons.length === 0) {
    return [];
  }
  return [
    "",
    "Lessons from previous waves (real failure output, oldest first):",
    ...lessons.map((line) => `- ${line}`),
    "Infer the lesson each failure teaches and CHANGE the plan accordingly —",
    "split or rescope the stuck todo, fix what the failure output actually",
    "says, reorder dependencies. Re-running the same approach unchanged is a",
    "wasted wave.",
  ];
}
