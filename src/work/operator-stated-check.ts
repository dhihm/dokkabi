import type { EventLog } from "../host/event-log.ts";
import { createCheckTool } from "../plugins/ledger-tools.ts";
import { liveLedger } from "./ledger-live.ts";
import { extractStatedCheckCommand, statedCheckCaseId } from "./stated-check-command.ts";
import type { LedgerCase } from "./plan-ledger.ts";

/** True when the ledger already carries a case for this exact command. */
export function ledgerHasCaseCommand(log: EventLog, command: string): boolean {
  const needle = command.trim();
  const cases = liveLedger(log).revision()?.graph.cases ?? [];
  return cases.some((item) => typeof item.command === "string" && item.command.trim() === needle);
}

function checkExecuteReturnedFindings(result: { content: Array<{ type: string; text?: unknown }> }): boolean {
  const text = result.content.find((part) => part.type === "text")?.text;
  if (typeof text !== "string") return false;
  try {
    const parsed = JSON.parse(text) as { status?: unknown };
    return parsed.status === "findings";
  } catch {
    return false;
  }
}

/**
 * When the operator order names a runnable check, record it as a ledger case
 * through the same path as the `check` tool — without waiting for the model.
 */
export async function ensureOperatorStatedCheckCase(input: {
  log: EventLog;
  workspaceRoot: string;
  order: string;
}): Promise<{ recorded: boolean; command?: string; caseId?: string }> {
  const command = extractStatedCheckCommand(input.order);
  if (command === undefined) return { recorded: false };
  const statedId = statedCheckCaseId(command);
  if (liveLedger(input.log).fold.hasCase(statedId)) {
    return { recorded: false, command, caseId: statedId };
  }
  const item: LedgerCase = {
    id: statedId,
    command,
    red_means: "the stated check fails on the tree before the fix",
    green_means: "the stated check passes on the fixed tree",
  };
  const check = createCheckTool({ log: input.log, workspaceRoot: input.workspaceRoot });
  const result = await check.execute("operator-stated-check", {
    id: item.id,
    command: item.command,
    red_means: item.red_means,
    green_means: item.green_means,
  });
  if (checkExecuteReturnedFindings(result)) {
    return { recorded: false, command, caseId: item.id };
  }
  return { recorded: true, command, caseId: item.id };
}
