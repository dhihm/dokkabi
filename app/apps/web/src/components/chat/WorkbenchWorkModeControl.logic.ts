import type {
  ProviderWorkbenchWorkModeActionResult,
  ProviderWorkbenchWorkModeResult,
  ProviderWorkbenchWorkModeSelection,
  WorkbenchWorkModeKind,
} from "@t3tools/contracts";

/**
 * Pure view/outcome logic for the R8-06j2 explicit session work-mode control
 * (docs/internals/dokkabi-work-mode.md). Semantics held here:
 * - The control reads ONLY the host's actual configuration; a failed refresh
 *   keeps the last successful view visibly stale, and a failure with no data
 *   shows an honest unavailable state — never an invented mode.
 * - Unsupported providers (ordinary adapters, older gateways) hide the
 *   control; unavailable/unknown states show their bounded reason.
 * - One explicit click mints ONE stable command id in the host's vocabulary
 *   and uses the displayed revision; a failed set is reconciled ONLY through
 *   a read-only same-id status, never a re-send.
 * - "applied" is a control update receipt; no text can describe it as task
 *   success or verified work.
 *
 * @module components/chat/WorkbenchWorkModeControl.logic
 */

/** The query view fields the resolution needs. */
export interface WorkbenchWorkModeQueryLike {
  readonly data: ProviderWorkbenchWorkModeResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export type WorkbenchWorkModeBarState =
  | { readonly kind: "hidden" }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "view";
      readonly selection: ProviderWorkbenchWorkModeSelection;
      readonly busy: boolean;
      readonly staleError: string | null;
    };

/**
 * Resolve the control's state from the keyed query. A live failure with
 * retained data keeps the view labeled stale; a failure with no data is an
 * honest unavailable state. Unsupported hides entirely — ordinary providers
 * and older gateways show nothing rather than a disabled lie.
 */
export function resolveWorkbenchWorkModeBar(input: {
  readonly query: WorkbenchWorkModeQueryLike;
}): WorkbenchWorkModeBarState {
  const { data, error, isPending } = input.query;
  if (data !== null && data.status === "available") {
    return {
      kind: "view",
      selection: data.selection,
      busy: data.busy,
      staleError: error,
    };
  }
  if (data !== null && data.status === "unavailable") {
    return {
      kind: "unavailable",
      reason: data.reason ?? "The session work mode is not available.",
    };
  }
  if (data !== null && data.status === "unsupported") {
    return { kind: "hidden" };
  }
  if (error !== null) {
    return { kind: "unavailable", reason: error };
  }
  return isPending ? { kind: "pending" } : { kind: "hidden" };
}

/** The closed selector vocabulary, rendered in a fixed order. */
export const WORK_MODE_SELECTOR_OPTIONS: ReadonlyArray<{
  readonly mode: WorkbenchWorkModeKind;
  readonly label: string;
}> = [
  { mode: "default", label: "Default" },
  { mode: "chat", label: "Chat" },
  { mode: "work", label: "Work" },
];

/** Honest effective-mode text: which mode routes new turns and why. */
export function effectiveModeLabel(selection: ProviderWorkbenchWorkModeSelection): string {
  const source = selection.source === "session" ? "session override" : "standing default";
  return `effective ${selection.effective} · ${source}`;
}

/** The revision's stable short head — displayed and echoed on a click. */
export function revisionLabel(selection: ProviderWorkbenchWorkModeSelection): string {
  return `rev ${selection.revision.slice(0, 12)}…`;
}

let attemptCounter = 0;

/**
 * A fresh command id for ONE explicit operator attempt, in the host command
 * id vocabulary (alphanumeric-first, ≤128). Created once per attempt and
 * reused for that attempt's same-id status reconciliation; a later click is
 * a new explicit command, never a retry of an unknown prior one.
 */
export function newWorkModeCommandId(): string {
  attemptCounter += 1;
  return `workmode-${Date.now().toString(36)}-${attemptCounter.toString(36)}-${fnv1aHex(
    `${Date.now()}:${attemptCounter}:${Math.random()}`,
  )}`;
}

/** Small dependency-free deterministic digest (FNV-1a, 32-bit hex). */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The honest operator-facing outcome of one explicit attempt. */
export function workModeOutcomeMessage(result: ProviderWorkbenchWorkModeActionResult): string {
  switch (result.state) {
    case "applied":
      return result.duplicate
        ? `Work mode already recorded as ${result.selection.mode}; the stored outcome was returned and nothing was applied again. No message was sent.`
        : `Work mode set to ${result.selection.mode} (${result.selection.source} selection). No message was sent.`;
    case "conflict":
      return (
        result.reason ?? "The recorded work mode changed; refresh and choose again explicitly."
      );
    case "busy":
      return (
        result.reason ??
        "The harness is busy with unresolved work; the mode applies to new turns and can be set once the session settles."
      );
    case "unknown":
      // The reason never replaces the honest framing: an unknown outcome is
      // surfaced as unknown, with no automatic retry implied.
      return `${result.reason ? `${result.reason}; ` : ""}the outcome is unknown and was not re-sent. Current mode will be read again; another selection is a new command.`;
    case "unsupported":
      return result.reason ?? "This conversation's work mode cannot be changed here.";
    case "unavailable":
      return result.reason ?? "The recorded source is not reachable right now.";
  }
}

/** What the control does after a set command failed at the transport. */
export type SetRecoveryPlan =
  | { readonly kind: "status-once" }
  | { readonly kind: "unknown-without-status" };

/**
 * A non-interrupted failed set reconciles EXACTLY ONCE through the read-only
 * same-id status — never an automatic re-send. Interruption cannot prove zero
 * host effect: clear pending but keep visible uncertainty until a current read.
 */
export function planSetRecovery(input: { readonly interrupted: boolean }): SetRecoveryPlan {
  return input.interrupted ? { kind: "unknown-without-status" } : { kind: "status-once" };
}
