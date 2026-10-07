import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventRecord } from "../host/schema.ts";

/**
 * What the run needs a person to decide.
 *
 * A run reached its final gate and could not pass it. Rather than say so, it
 * authored a case asserting that a file named `OPERATOR_DECISION_RECEIVED.md`
 * existed -- a bar only a human could clear -- and then spun on it: 537 waves
 * in two hours, 1,074 identical red verdicts, zero green. The decision it
 * wanted was written down, in that case's own `red_means`, and nowhere a
 * person would ever look.
 *
 * That is the shape of the bug. A question is not a case. A case measures the
 * product and the run can move it; a question measures the operator and the
 * run cannot. Holding a question as a red case means the graph can never go
 * green, the wave can never finish, and the ask stays invisible.
 *
 * So when the run hits a wall, it writes the question out where a person
 * reads it, in their words: what is red, what each red case says it is
 * waiting for, and which of them no amount of further work can clear.
 */

/** Where the question lands, relative to the workspace root. */
export const OPERATOR_QUESTION_PATH = "work/OPERATOR_QUESTION.md";

export interface RedCase {
  readonly id: string;
  /** The case's own words for why it is red — already an operator-facing
   * sentence, and where a run states the options it wants chosen between. */
  readonly redMeans?: string;
  /** True when nothing the run can do will clear it. */
  readonly needsOperator: boolean;
}

/**
 * A case the run cannot clear by working.
 *
 * Not a filename match: what makes a bar unreachable is that its measurement
 * is an operator artifact rather than the product. Both marks below are that
 * same fact stated in the ledger — a threshold naming an operator decision,
 * or a red that says it is waiting for one.
 */
export function needsOperator(input: { command?: string; redMeans?: string }): boolean {
  const text = `${input.command ?? ""}\n${input.redMeans ?? ""}`;
  return /\boperator_decision\w*\s*>?=/i.test(text)
    || /OPERATOR_DECISION[A-Z_]*\.md/.test(text);
}

/** The red cases as of now, latest verdict per case, with what each says. */
export function redCasesFrom(events: readonly EventRecord[]): RedCase[] {
  const verdict = new Map<string, string>();
  const said = new Map<string, { redMeans?: string; command?: string }>();
  for (const event of events) {
    if (event.name !== "work/case") continue;
    const payload = event.payload as {
      id?: unknown; status?: unknown; red_means?: unknown; command?: unknown;
    };
    if (typeof payload.id !== "string") continue;
    if (typeof payload.red_means === "string" || typeof payload.command === "string") {
      const prior = said.get(payload.id) ?? {};
      said.set(payload.id, {
        redMeans: typeof payload.red_means === "string" ? payload.red_means : prior.redMeans,
        command: typeof payload.command === "string" ? payload.command : prior.command,
      });
    }
    if (payload.status === "red" || payload.status === "green") {
      verdict.set(payload.id, String(payload.status));
    }
  }
  return [...verdict]
    .filter(([, status]) => status === "red")
    .map(([id]) => {
      const words = said.get(id) ?? {};
      return {
        id,
        ...(words.redMeans === undefined ? {} : { redMeans: words.redMeans }),
        needsOperator: needsOperator(words),
      };
    })
    .sort((a, b) => (a.needsOperator === b.needsOperator ? a.id.localeCompare(b.id) : a.needsOperator ? -1 : 1));
}

export function questionText(input: {
  goal?: string;
  streak: number;
  wave: number;
  red: readonly RedCase[];
  at: string;
}): string {
  const blocking = input.red.filter((item) => item.needsOperator);
  const lines: string[] = [
    "# The run needs a decision",
    "",
    `Written ${input.at} — wave ${input.wave}, ${input.streak} wave${input.streak === 1 ? "" : "s"} in a row changed nothing.`,
    "",
  ];
  if (input.goal) {
    lines.push(`**Goal.** ${input.goal}`, "");
  }
  if (blocking.length > 0) {
    lines.push(
      "## Nothing the run can do will clear these",
      "",
      "Each measures a decision rather than the product, so it stays red until someone makes it.",
      "",
    );
    for (const item of blocking) {
      lines.push(`- **${item.id}** — ${item.redMeans ?? "(the case gave no reason)"}`);
    }
    lines.push("");
  }
  const working = input.red.filter((item) => !item.needsOperator);
  if (working.length > 0) {
    lines.push("## Still red, and the run is still working on them", "");
    for (const item of working) {
      lines.push(`- **${item.id}** — ${item.redMeans ?? "(the case gave no reason)"}`);
    }
    lines.push("");
  }
  lines.push(
    "## What happens next",
    "",
    "The run has not stopped. It backs off and keeps retrying, so it costs almost",
    "nothing while it waits. Answer by doing whatever the cases above ask for, or",
    "by changing the bar in the order; the next wave picks it up.",
    "",
  );
  return lines.join("\n");
}

/** Write the question where a person reads it. Returns the path written. */
export function writeOperatorQuestion(input: {
  workspaceRoot: string;
  goal?: string;
  streak: number;
  wave: number;
  events: readonly EventRecord[];
  now?: () => Date;
}): { path: string; red: RedCase[] } {
  const red = redCasesFrom(input.events);
  const path = join(input.workspaceRoot, OPERATOR_QUESTION_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, questionText({
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    streak: input.streak,
    wave: input.wave,
    red,
    at: (input.now ?? (() => new Date()))().toISOString().replace("T", " ").slice(0, 19),
  }));
  return { path, red };
}
