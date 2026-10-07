import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { containsSecret } from "../host/redact.ts";

const GOAL_STATEMENT_MAX = 200;
const NOTES_MAX = 280;
const UNFINISHED_IDS_MAX = 8;

/**
 * A bounded, factual position report from the workspace work ledger
 * (`work/current.json`), for the first turn of a fresh session. It reads the
 * file tolerantly — live ledgers accumulate inline statuses, evidence notes,
 * and extra fields beyond the decompose-time WorkPlan schema — and reports
 * only what the ledger records, so the model can neither re-explore for its
 * position nor claim more progress than the ledger holds.
 */
export function workLedgerDigestText(workspaceRoot: string): string | undefined {
  const path = join(workspaceRoot, "work", "current.json");
  let raw: string;
  let updated: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
    updated = statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const ledger = parsed as Record<string, unknown>;
  const goal = asRecord(ledger.goal);
  const goalId = safeString(goal?.id);
  const goalStatement = safeString(goal?.statement, GOAL_STATEMENT_MAX);
  if (!goalId && !goalStatement) return undefined;

  const todos = asRecordArray(ledger.todos);
  const cases = asRecordArray(ledger.cases);
  const lines: string[] = [`Workspace work ledger (recorded by earlier sessions; work/current.json, updated ${updated}):`];
  lines.push(`- goal ${goalId ?? "(unnamed)"}: ${goalStatement ?? "(no statement)"}`);
  if (todos.length > 0) {
    const counts = statusCounts(todos);
    const unfinished = todos
      .filter((todo) => safeString(todo.status) !== "green")
      .map((todo) => safeString(todo.id))
      .filter((id): id is string => id !== undefined);
    const shown = unfinished.slice(0, UNFINISHED_IDS_MAX).join(", ");
    const more = unfinished.length > UNFINISHED_IDS_MAX ? ` +${unfinished.length - UNFINISHED_IDS_MAX} more` : "";
    lines.push(
      `- todos ${todos.length}: ${counts}${unfinished.length > 0 ? ` — unfinished: ${shown}${more}` : ""}`,
    );
  }
  if (cases.length > 0) {
    lines.push(`- cases ${cases.length}: ${statusCounts(cases)}`);
  }
  const notes = safeString(asRecord(ledger.evidence)?.comments, NOTES_MAX);
  if (notes) lines.push(`- ledger notes: ${notes}`);
  return lines.join("\n");
}

/** The standing instruction folded together with the digest. */
/**
 * Folded into the first turn of a FRESH context only. The earlier wording
 * ("this ledger is the only durable record … before starting new work, write
 * the plan into the ledger") read as a standing order to continue the ledger:
 * a fresh session adopted the previous task's ten unfinished todos as its own
 * assignment the moment the operator said anything. The ledger is a record
 * left by earlier sessions — the operator's current instruction is the only
 * assignment.
 */
export const WORK_LEDGER_DISCIPLINE =
  "Ledger discipline: this ledger is a record left by earlier sessions — it is "
  + "not your assignment. Your task is solely the operator's instruction below. "
  + "Do not resume, execute, or continue ledger items unless the instruction "
  + "names this work; when it does, re-verify the actual state first and keep "
  + "the ledger updated as you proceed, reporting completion strictly by its "
  + "recorded evidence. When the instruction is unrelated, leave the ledger "
  + "untouched and record any new plan as new work.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined);
}

function statusCounts(items: readonly Record<string, unknown>[]): string {
  let green = 0;
  let red = 0;
  for (const item of items) {
    const status = safeString(item.status);
    if (status === "green") green += 1;
    else if (status === "red") red += 1;
  }
  const unmarked = items.length - green - red;
  return `green ${green}, red ${red}, unmarked ${unmarked}`;
}

function safeString(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  if (!flat || containsSecret(flat)) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
