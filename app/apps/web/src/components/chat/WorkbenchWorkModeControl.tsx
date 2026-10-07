import { useCallback, useEffect, useRef, useState } from "react";
import { GaugeIcon } from "lucide-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderWorkbenchWorkModeActionResult,
  ThreadId,
  WorkbenchWorkModeKind,
} from "@t3tools/contracts";

import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import {
  workbenchWorkModeAction,
  workbenchWorkModeAtomFor,
  workbenchWorkModeScopeKey,
} from "~/state/workbenchWorkMode";
import {
  effectiveModeLabel,
  newWorkModeCommandId,
  planSetRecovery,
  resolveWorkbenchWorkModeBar,
  WORK_MODE_SELECTOR_OPTIONS,
  workModeOutcomeMessage,
} from "./WorkbenchWorkModeControl.logic";

/** The displayed outcome of one explicit attempt. */
interface OutcomeMessage {
  readonly text: string;
  /** The action result's own state — honest for conflict/busy/unknown too. */
  readonly resultState: string;
}

/**
 * R8-06j2 explicit session work-mode control: a small Default/Chat/Work
 * selector for THIS conversation's harness session. The host owns selection,
 * persistence and evidence — this control only reads the host's actual
 * configuration on a bounded poll and changes it through ONE explicit click
 * carrying that attempt's stable command id and the displayed revision.
 *
 * No Send, activation rewrite, reconnect or localStorage truth happens here:
 * mounting, reconnecting and polling never send a selection; a failed set is
 * reconciled ONLY through a read-only same-id status and never re-sent; an
 * unknown outcome is surfaced without silently issuing a new command. Host
 * busy disables the selector and explains that the mode applies to new
 * turns. Unsupported ordinary/old providers hide the control entirely;
 * unavailable states show their reason honestly. Every async continuation is
 * guarded by mount + generation + owner scope, so a stale or unmounted reply
 * can never touch state, and pending always clears. The timeline, composer
 * and drafts keep their independent lifetimes.
 */
export function WorkbenchWorkModeControl({
  environmentId,
  threadId,
  providerInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}) {
  const mountedRef = useRef(true);
  /** Bumped on unmount and on every scope change: continuations of an older
   * generation may neither touch state nor show stale thread results. */
  const actionGenerationRef = useRef(0);
  const scopeKey = workbenchWorkModeScopeKey({ environmentId, threadId, providerInstanceId });
  const scopeKeyRef = useRef(scopeKey);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<OutcomeMessage | null>(null);
  const [uncertainSnapshot, setUncertainSnapshot] = useState<{ timestamp: number | null } | null>(
    null,
  );

  useEffect(() => {
    mountedRef.current = true;
    if (scopeKeyRef.current !== scopeKey) {
      scopeKeyRef.current = scopeKey;
      actionGenerationRef.current += 1;
      setBusy(false);
      setMessage(null);
      setUncertainSnapshot(null);
    }
    return () => {
      mountedRef.current = false;
      actionGenerationRef.current += 1;
    };
  }, [scopeKey]);

  // Stop the bounded read poll while the surface is hidden: the atom
  // unsubscribes and no request is issued until the page is visible again.
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const track = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", track);
    return () => document.removeEventListener("visibilitychange", track);
  }, []);

  const query = useEnvironmentQuery(
    pageVisible ? workbenchWorkModeAtomFor({ environmentId, threadId, providerInstanceId }) : null,
  );
  const runAction = useAtomCommand(workbenchWorkModeAction, { reportFailure: false });
  const state = resolveWorkbenchWorkModeBar({ query });
  const currentSelection = state.kind === "view" ? state.selection : null;
  const querySnapshotTimeRef = useRef(query.dataUpdatedAt);
  useEffect(() => {
    querySnapshotTimeRef.current = query.dataUpdatedAt;
  }, [query.dataUpdatedAt]);
  /** Guarded state write: only the CURRENT generation may touch state. */
  const recordOutcome = useCallback((generation: number, outcome: OutcomeMessage | null) => {
    if (!mountedRef.current || generation !== actionGenerationRef.current) return;
    if (outcome?.resultState === "unknown" || outcome?.resultState === "unavailable") {
      setUncertainSnapshot({ timestamp: querySnapshotTimeRef.current });
    } else {
      setUncertainSnapshot(null);
    }
    setBusy(false);
    setMessage(outcome);
  }, []);

  const selectMode = async (mode: WorkbenchWorkModeKind) => {
    if (!mountedRef.current || busy) return;
    const scopeAtStart = scopeKeyRef.current;
    const generation = actionGenerationRef.current;
    const selection = currentSelection;
    if (selection === null) return;
    // ONE explicit attempt: the command id is minted here and reused only
    // for this attempt's same-id status reconciliation. The revision is
    // exactly the one the operator saw displayed.
    const commandId = newWorkModeCommandId();
    const expectedRevision = selection.revision;
    setBusy(true);
    setMessage(null);
    let outcome: ProviderWorkbenchWorkModeActionResult | null = null;
    let failureMessage: string | null = null;
    let interrupted = false;
    try {
      const result = await runAction({
        environmentId,
        input: { type: "set", threadId, commandId, expectedRevision, mode },
      });
      if (result._tag === "Failure") {
        interrupted = isAtomCommandInterrupted(result);
        if (!interrupted) {
          const squashed = squashAtomCommandFailure(result);
          failureMessage =
            squashed instanceof Error
              ? squashed.message
              : "The selection failed at the provider boundary.";
        }
      } else {
        outcome = result.value;
      }
    } catch {
      failureMessage = "The selection failed.";
    }
    // A stale continuation (unmount or scope change) writes nothing.
    const stillCurrent = () =>
      mountedRef.current &&
      generation === actionGenerationRef.current &&
      scopeKeyRef.current === scopeAtStart;
    if (!stillCurrent()) return;
    if (outcome !== null) {
      recordOutcome(generation, {
        text: workModeOutcomeMessage(outcome),
        resultState: outcome.state,
      });
      // Read-only refresh: the poll fetches the host's current state.
      query.refresh();
      return;
    }
    if (planSetRecovery({ interrupted }).kind === "unknown-without-status") {
      // Cancellation of the client wait does not prove zero host effect.
      recordOutcome(generation, {
        text: "The selection wait was interrupted. Its result is unconfirmed; the current mode will be read again.",
        resultState: "unknown",
      });
      query.refresh();
      return;
    }
    // A failed set reconciles ONLY through one read-only same-id status —
    // never a re-send. An unavailable or failed status stays unknown.
    const unknownText = `${failureMessage ?? "The selection failed."} The outcome is unknown and it was not re-sent.`;
    try {
      const status = await runAction({
        environmentId,
        input: { type: "status", threadId, commandId },
      });
      if (!stillCurrent()) return;
      recordOutcome(
        generation,
        status._tag === "Success"
          ? { text: workModeOutcomeMessage(status.value), resultState: status.value.state }
          : { text: unknownText, resultState: "unknown" },
      );
      query.refresh();
    } catch {
      if (!stillCurrent()) return;
      recordOutcome(generation, { text: unknownText, resultState: "unknown" });
      query.refresh();
    }
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "pending") {
    return (
      <div
        className="flex min-h-9 items-center gap-3 border-b border-border bg-background px-4 text-xs text-muted-foreground"
        data-workbench-work-mode-control="pending"
        data-thread-id={threadId}
      >
        <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Execution mode…</span>
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <div
        className="flex min-h-9 items-center gap-3 border-b border-border bg-background px-4 text-xs text-muted-foreground"
        data-workbench-work-mode-control="unavailable"
        data-thread-id={threadId}
      >
        <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="max-w-[72ch] truncate">Execution mode unavailable — {state.reason}</span>
      </div>
    );
  }

  const { selection, busy: hostBusy, staleError } = state;
  const awaitingCurrentRead =
    uncertainSnapshot !== null &&
    (query.isPending || !query.isSuccess || query.dataUpdatedAt === uncertainSnapshot.timestamp);
  const selectorDisabled = busy || hostBusy || staleError !== null || awaitingCurrentRead;

  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-background px-4 text-xs text-foreground"
      data-workbench-work-mode-control="view"
      data-thread-id={threadId}
    >
      <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium">Execution mode</span>
      <span
        className="flex items-center gap-2"
        role="radiogroup"
        aria-label="Execution mode"
        data-workbench-work-mode-selector="true"
      >
        {WORK_MODE_SELECTOR_OPTIONS.map((option) => (
          <label key={option.mode} className="flex items-center gap-1">
            <input
              type="radio"
              name={`workbench-work-mode-${threadId}`}
              checked={selection.mode === option.mode}
              disabled={selectorDisabled}
              data-workbench-work-mode-option={option.mode}
              onChange={() => {
                void selectMode(option.mode);
              }}
            />
            <span className={selection.mode === option.mode ? "font-medium" : undefined}>
              {option.label}
            </span>
          </label>
        ))}
      </span>
      <span className="text-muted-foreground" data-workbench-work-mode-effective>
        {effectiveModeLabel(selection)}
      </span>
      {staleError !== null ? (
        <span
          className="rounded bg-warning/12 px-1.5 py-0.5 font-medium text-warning-foreground"
          data-workbench-work-mode-stale="true"
        >
          stale
        </span>
      ) : null}
      {hostBusy ? (
        <span className="text-muted-foreground" data-workbench-work-mode-host-busy="true">
          The harness is busy; the mode applies to new turns and can be set once the session
          settles.
        </span>
      ) : null}
      <span className="grow" />
      {busy ? (
        <span className="text-muted-foreground" data-workbench-work-mode-state="busy">
          Applying… this changes only the mode selection.
        </span>
      ) : message !== null ? (
        <span
          className="max-w-[72ch] truncate text-muted-foreground"
          data-workbench-work-mode-state="message"
          data-workbench-work-mode-result={message.resultState}
        >
          {message.text}
        </span>
      ) : null}
    </div>
  );
}
