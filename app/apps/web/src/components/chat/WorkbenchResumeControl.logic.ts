import type { ProviderWorkbenchResumeResult } from "@t3tools/contracts";

/**
 * Pure visibility/outcome logic for the R8 explicit recorded-parent reconnect
 * control. The control appears ONLY for a persisted harness conversation
 * whose recorded source is currently detached — exactly the overview read's
 * "unavailable" state. Ordinary providers report "unsupported" (no recorded
 * capability or no persisted binding), drafts never carry a binding, and a
 * bound/live conversation reports "available": the control stays hidden in
 * every one of those states, and it never appears while the metadata is
 * still loading or failed (incomplete metadata hides rather than guesses).
 */
export type WorkbenchOverviewStatus = "available" | "unavailable" | "unsupported";

export function resumeControlVisible(input: {
  readonly overviewStatus: WorkbenchOverviewStatus | null | undefined;
}): boolean {
  return input.overviewStatus === "unavailable";
}

/** The honest operator-facing outcome of one explicit reconnect attempt. */
export function resumeOutcomeMessage(result: ProviderWorkbenchResumeResult): string {
  switch (result.state) {
    case "available":
      return "Recorded conversation reconnected. Recorded reads are live again; nothing was sent.";
    case "unsupported":
      return result.reason ?? "This conversation cannot be reconnected here.";
    case "unknown":
      return result.reason ?? "The reconnect was refused; the recorded state stays authoritative.";
  }
}
