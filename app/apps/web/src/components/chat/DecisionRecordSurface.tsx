/**
 * Docked Decision/Record surface (Dokkabi R5, companion-aware in R6).
 *
 * In production the app-root Record companion hub owns this scope's view
 * preferences, keyed query and action controller — this surface is a pure
 * projection that reports its mount/visibility and dispatches the CLOSED
 * action vocabulary; exactly one authenticated query serves the docked and
 * the detached placement, and a hidden docked component can never report
 * stale local preferences over a changed detached view. Close is CLOSED: when
 * the companion window closed, this surface shows an explicit closed/Reopen
 * placeholder and the hub stops polling until an explicit reopen; only a
 * committed dock renders the interactive reader again.
 *
 * When no hub is mounted (standalone/browser-fallback usage) the surface runs
 * the exact R5 legacy controller locally: one keyed query while visible and
 * mounted, retention of the last validated page, stale/quarantine handling,
 * and the same closed action reducer.
 *
 * Rows always render as inert text; inspection never mutates the
 * conversation: the composer target, draft and parent records are untouched
 * and no sends are queued. The Decisions tab remains a capability fact.
 */
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  RecordCompanionScope,
  RecordCompanionViewAction,
  RecordCompanionViewPreferences,
  ThreadId,
} from "@t3tools/contracts";
import { recordCompanionScopeKey } from "@t3tools/contracts";

import { useEnvironmentQuery } from "~/state/query";
import {
  applyRecordCompanionViewAction,
  placementNeedsReader,
  recordCompanionBridge,
  recordCompanionSourceLabel,
  useRecordCompanionHubStore,
} from "~/state/recordCompanion";
import {
  WORKBENCH_RECORD_PAGE_LIMIT,
  workbenchRecordAtomFor,
  workbenchRecordScopeKey,
} from "~/state/workbenchRecord";
import { Button } from "../ui/button";
import {
  useRecordCompanionHub,
  type RecordCompanionHubController,
} from "../recordCompanion/RecordCompanionOwnerHub";
import { RecordCompanionView } from "../recordCompanion/RecordCompanionView";
import {
  resolveDecisionRecordPanel,
  type DecisionRecordPanelState,
  type RetainedWorkbenchRecordPage,
} from "./DecisionRecordSurface.logic";

const DEFAULT_VIEW: RecordCompanionViewPreferences = {
  tab: "record",
  pin: null,
  after: null,
  selectedSeq: null,
};

const PENDING_PANEL: DecisionRecordPanelState = { kind: "pending" };

/**
 * The docked Decision/Record panel. Delegates to the app-root hub when its
 * controller is present; otherwise runs the standalone legacy controller.
 */
export function DecisionRecordSurface({
  environmentId,
  threadId,
  providerInstanceId,
  visible,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly visible: boolean;
}) {
  const hub = useRecordCompanionHub();
  if (hub === null) {
    return (
      <LegacyDecisionRecordSurface
        environmentId={environmentId}
        threadId={threadId}
        providerInstanceId={providerInstanceId}
        visible={visible}
      />
    );
  }
  return (
    <HubDecisionRecordSurface
      environmentId={environmentId}
      threadId={threadId}
      providerInstanceId={providerInstanceId}
      visible={visible}
      hub={hub}
    />
  );
}

function companionScopeOf(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId | undefined,
): RecordCompanionScope {
  return { environmentId, threadId, providerInstanceId: providerInstanceId ?? null };
}

/**
 * The hub-controlled docked panel: a projection of the hub's authoritative
 * entry. Reports observation, renders the hub reader's R5 resolution and
 * dispatches closed actions; shows the companion placements honestly.
 */
function HubDecisionRecordSurface({
  environmentId,
  threadId,
  providerInstanceId,
  visible,
  hub,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly visible: boolean;
  readonly hub: RecordCompanionHubController;
}) {
  const scope = useMemo(
    () => companionScopeOf(environmentId, threadId, providerInstanceId),
    [environmentId, threadId, providerInstanceId],
  );
  const scopeKey = recordCompanionScopeKey(scope);
  const entry = useRecordCompanionHubStore((state) => state.entries[scopeKey] ?? null);
  // Observation: mounted while this surface is mounted, visible with the
  // panel. The hub owns the resulting query subscription decision.
  useEffect(() => {
    hub.observe(scope, true, visible);
  }, [hub, scope, visible]);
  useEffect(() => {
    return () => {
      hub.observe(scope, false, false);
    };
  }, [hub, scope]);

  const suppressed = entry?.dockedSuppressed ?? false;
  const closed = entry?.companionClosed ?? false;
  const placement = entry?.placement ?? null;
  const placementLive = placement !== null && placementNeedsReader(placement.placement);
  const bridge = recordCompanionBridge();
  const view = entry?.view ?? DEFAULT_VIEW;
  const panel = entry?.panel ?? PENDING_PANEL;
  // While docking, the docked destination must PREPARE the restored view:
  // the original scope's inspector is mounted and visible and renders the
  // restored position inertly. Only that committed DOM state (reported from
  // this surface's own layout effect) releases the dock acknowledgement; a
  // navigated-away destination keeps the companion inert in Docking.
  const dockingPreparation = suppressed && placement?.placement === "docking";
  // The child-quiescence receipt starts a new preparation transaction. A
  // docking state may commit earlier; acknowledging that earlier render would
  // be reset by childQuiesced without re-running this layout effect.
  const preparedNow =
    dockingPreparation &&
    entry?.pendingAckDock !== null &&
    entry?.pendingAckDock !== undefined &&
    visible &&
    panel.kind !== "pending";
  useLayoutEffect(() => {
    if (!dockingPreparation) return;
    hub.markPrepared(scopeKey, preparedNow);
    return () => {
      hub.markPrepared(scopeKey, false);
    };
  }, [hub, scopeKey, dockingPreparation, preparedNow]);

  if (closed) {
    // Close is CLOSED: no silent dock restore, no source polling — the
    // inspector reopens explicitly (restoring persisted preferences).
    return (
      <PanelFrame scopeKey={entry?.scopeKey ?? scopeKey} placement="closed">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
          <p className="text-sm font-medium text-foreground">
            The record companion window was closed.
          </p>
          <p className="max-w-[46ch] text-xs text-muted-foreground">
            Inspection is paused for this scope. Reopen to continue where the companion left off;
            the docked reader returns when the view docks back.
          </p>
          <p className="font-mono text-3xs text-muted-foreground" data-record-source-label>
            {entry?.sourceLabel ?? recordCompanionSourceLabel(scope)}
          </p>
          {entry?.conflictMessage ? (
            <p
              className="max-w-[46ch] text-xs text-warning-foreground"
              data-record-companion-conflict="true"
            >
              {entry.conflictMessage}
            </p>
          ) : null}
          {bridge !== null ? (
            <Button
              variant="outline"
              size="xs"
              data-record-companion-reopen="true"
              onClick={() => hub.open(scope, true)}
            >
              Reopen
            </Button>
          ) : null}
        </div>
      </PanelFrame>
    );
  }

  if (suppressed && !dockingPreparation) {
    // The child holds the interactive placement; the old view is hidden and
    // this placeholder is honest about where the view lives.
    return (
      <PanelFrame
        scopeKey={entry?.scopeKey ?? scopeKey}
        placement={placement?.placement ?? "detached"}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
          <p className="text-sm font-medium text-foreground">
            This record view is open in the companion window.
          </p>
          <p className="font-mono text-3xs text-muted-foreground" data-record-source-label>
            {entry?.sourceLabel ?? recordCompanionSourceLabel(scope)}
          </p>
          {entry?.conflictMessage ? (
            <p
              className="max-w-[46ch] text-xs text-warning-foreground"
              data-record-companion-conflict="true"
            >
              {entry.conflictMessage}
            </p>
          ) : null}
          {bridge !== null ? (
            <Button
              variant="outline"
              size="xs"
              data-record-companion-reveal="true"
              onClick={() => hub.open(scope, false)}
            >
              Reveal window
            </Button>
          ) : null}
        </div>
      </PanelFrame>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-decision-record-panel="true"
      data-record-scope-key={scopeKey}
    >
      {dockingPreparation ? (
        <div
          className="border-b border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
          data-record-companion-placement="docking"
        >
          {visible
            ? "Docking the record view back…"
            : "Waiting for this Record panel to become visible to finish docking."}
        </div>
      ) : null}
      {entry?.conflictMessage && !dockingPreparation ? (
        <p
          className="border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-warning-foreground"
          data-record-companion-conflict="true"
        >
          {entry.conflictMessage}
        </p>
      ) : null}
      <RecordCompanionView
        state={panel}
        view={view}
        // Inert while the docking destination is prepared: exactly one
        // interactive placement exists until the dock commits.
        interactive={visible && !dockingPreparation}
        onAction={(action) => hub.dispatch(scopeKey, action)}
        headerExtra={
          dockingPreparation ? null : bridge !== null ? (
            <Button
              variant="ghost"
              size="xs"
              data-record-companion-open="true"
              disabled={placementLive}
              onClick={() => hub.open(scope, false)}
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              Open
            </Button>
          ) : visible ? (
            <span
              className="text-3xs text-muted-foreground"
              data-record-companion-unavailable="true"
            >
              Detached inspection is available in the desktop app.
            </span>
          ) : null
        }
      />
    </div>
  );
}

function PanelFrame({
  scopeKey,
  placement,
  children,
}: {
  readonly scopeKey: string;
  readonly placement: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-decision-record-panel="true"
      data-record-scope-key={scopeKey}
      data-record-companion-placement={placement}
    >
      {children}
    </div>
  );
}

/**
 * The standalone legacy controller (no hub mounted): the exact R5 behavior —
 * one keyed query while visible and mounted, same-scope retention, stale and
 * quarantine handling, closed action reducer over local view state.
 */
function LegacyDecisionRecordSurface({
  environmentId,
  threadId,
  providerInstanceId,
  visible,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly visible: boolean;
}) {
  const [view, setView] = useState<RecordCompanionViewPreferences>(DEFAULT_VIEW);
  const scope = {
    environmentId,
    threadId,
    providerInstanceId,
    after: view.after ?? undefined,
    asOf: view.pin ?? undefined,
    limit: WORKBENCH_RECORD_PAGE_LIMIT,
  };
  const scopeKey = workbenchRecordScopeKey(scope);
  const [retainedScope, setRetainedScope] = useState<RetainedWorkbenchRecordPage | null>(null);
  // Unsubscribing while invisible stops the refresh interval; the retained
  // view keeps the page (and the cache warm) behind the closed panel.
  const query = useEnvironmentQuery(visible ? workbenchRecordAtomFor(scope) : null);
  const retained =
    retainedScope !== null && retainedScope.scopeKey === scopeKey ? retainedScope : null;
  const state = resolveDecisionRecordPanel({
    scopeKey,
    query,
    retained,
    subscribed: visible,
    after: view.after ?? undefined,
  });
  // Retain every fresh valid view for THIS scope (React's own
  // adjust-state-during-render pattern; the guard makes it idempotent). A
  // quarantined response (staleError) never becomes the retained truth.
  if (state.kind === "view" && state.staleError === null) {
    if (retained === null || retained.page !== state.page) {
      setRetainedScope({ scopeKey, page: state.page });
    }
  }

  const applyAction = (action: RecordCompanionViewAction) => {
    const next = applyRecordCompanionViewAction({
      view,
      action,
      page: state.kind === "view" ? state.page : null,
    });
    if (next !== null) {
      setView(next);
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-decision-record-panel="true"
      data-record-scope-key={scopeKey}
    >
      <RecordCompanionView state={state} view={view} interactive={visible} onAction={applyAction} />
    </div>
  );
}
