import type { EventLog } from "../host/event-log.ts";
import { safeNoteText } from "../work/inbox.ts";

/** Operator Esc aborted a live turn. Not a provider failure and not retried. */
export class OperatorAbortError extends Error {
  readonly code = "DOKKABI_OPERATOR_ABORT";

  constructor() {
    super("operator_abort");
    this.name = "OperatorAbortError";
  }
}

export function isOperatorAbort(error: unknown): boolean {
  return error instanceof OperatorAbortError
    || (error instanceof Error && (error.name === "OperatorAbortError" || error.message === "operator_abort"));
}

/** Record the kernel-side failure fact which live and attach boards share. */
export function recordChatTurnFailure(log: EventLog, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const reason = safeNoteText(raw.replace(/\s+/g, " ").trim());
  try {
    log.append({ kind: "observe", name: "chat/turn_failed", payload: { reason } });
  } catch {
    // A refused append must not replace the safe reason returned to stderr.
  }
  return reason;
}
