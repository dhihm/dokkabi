import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/**
 * Confirmation for individual terminal close actions: drawer buttons, panel
 * buttons, the `terminal.close` keybinding, and closing a terminal surface from
 * the tab strip. Auto-exit cleanup and bulk tab closes skip this path and close
 * directly.
 */
export interface TerminalCloseConfirmOptions {
  /** When false, the dialog must not claim a running subprocess was started. */
  readonly stopsRunningProcess?: boolean;
}

function terminalCloseConfirmMessage(
  labels: readonly [string, ...string[]],
  stopsRunningProcess: boolean,
): string {
  if (labels.length === 1) {
    return [
      `Close terminal "${labels[0]}"?`,
      stopsRunningProcess
        ? "This stops the running process and clears its history."
        : "This clears its history.",
    ].join("\n");
  }
  return [
    `Close ${labels.length} terminals?`,
    stopsRunningProcess
      ? `This stops their running processes and clears their histories: ${labels
          .map((label) => `"${label}"`)
          .join(", ")}.`
      : `This clears their histories: ${labels.map((label) => `"${label}"`).join(", ")}.`,
  ].join("\n");
}

export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
  options?: TerminalCloseConfirmOptions,
): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  const stopsRunningProcess = options?.stopsRunningProcess ?? true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      terminalCloseConfirmMessage(labels, stopsRunningProcess),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
