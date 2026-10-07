/**
 * App-root Record companion owner hub (Dokkabi R6 / R5-04).
 *
 * Mounted once in AppRoot, OUTSIDE the router: it survives thread navigation
 * and owns the route-independent active source. It provides the hub
 * controller context — when present, the docked Decision/Record surface is a
 * pure projection of the hub (single authoritative view preferences, single
 * keyed query, single action controller for the docked AND the detached
 * placement); when absent, the surface falls back to its standalone legacy
 * controller (browser-fallback/tests).
 *
 * For every served scope it renders one headless reader: the bounded
 * explorer resolution (metadata index page, the selected row's validated byte
 * window and its explicit proof — keyed queries, retention, integrity/head
 * quarantine) both placements render. The old whole-row page read is not the
 * live path; an older gateway is shown honestly unsupported.
 * The query subscribes only while observed (docked panel mounted and visible,
 * or a companion actually live); closed/unobserved scopes stop polling. While
 * a companion is live the reader relays schema-shaped snapshots through the
 * owner bridge — never a second authenticated source connection.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  recordCompanionScopeKey,
  type RecordCompanionScope,
  type RecordCompanionViewAction,
} from "@t3tools/contracts";

import { usePresentationState } from "~/presentationStore";
import { usePresentationActive } from "~/state/presentationActivity";
import {
  buildRecordCompanionSnapshot,
  companionPresentationActive,
  currentRecordCompanionPresentationFacts,
  entryNeedsQuery,
  placementNeedsReader,
  recordCompanionBridge,
  recordCompanionSourceLabel,
  useRecordCompanionHubStore,
  type RecordCompanionHubScopeEntry,
} from "~/state/recordCompanion";
import { useRecordExplorerPanel } from "../recordExplorer/useRecordExplorerPanel";

/** The controller the hub hands to docked surfaces; null = no hub present. */
export interface RecordCompanionHubController {
  /** A docked surface reports its mount/visibility for this exact scope. */
  observe: (scope: RecordCompanionScope, observed: boolean, visible: boolean) => void;
  /** A docked interaction dispatches one closed view action. */
  dispatch: (scopeKey: string, action: RecordCompanionViewAction) => void;
  /** Open (detach) or explicitly reopen the scope's companion window. */
  open: (scope: RecordCompanionScope, reopen: boolean) => void;
  /**
   * The mounted surface reports, from its own layout effect, whether the
   * committed DOM currently renders the docking-prepared restored view
   * (mounted AND visible). The dock acknowledgement waits for this receipt.
   */
  markPrepared: (scopeKey: string, prepared: boolean) => void;
}

const RecordCompanionHubContext = createContext<RecordCompanionHubController | null>(null);

/** The hub controller, or null when no app-root hub is mounted (legacy path). */
export function useRecordCompanionHub(): RecordCompanionHubController | null {
  return useContext(RecordCompanionHubContext);
}

/**
 * Dispatches the pending handoff acknowledgements AFTER their DOM gates
 * committed. A store mutation is an intention, not a receipt: React runs
 * layout effects only after the whole commit's DOM mutations, so when this
 * component sees the suppressed docked view (its placeholder replaced the
 * interactive rows in the same commit) the detach acknowledgement is sent
 * against a DOM that no longer offers the old view. The dock acknowledgement
 * additionally waits for the mounted original-scope surface to report, from
 * its own layout effect, that the committed DOM renders the restored view
 * prepared (mounted AND visible) — a navigated-away destination keeps the
 * child inert in Docking instead of closing it over nothing.
 */
function RecordCompanionAcknowledgement({ scopeKey }: { readonly scopeKey: string }) {
  const pendingDetach = useRecordCompanionHubStore(
    (state) => state.entries[scopeKey]?.pendingAckDetach ?? null,
  );
  const pendingDock = useRecordCompanionHubStore(
    (state) => state.entries[scopeKey]?.pendingAckDock ?? null,
  );
  const suppressed = useRecordCompanionHubStore(
    (state) => state.entries[scopeKey]?.dockedSuppressed ?? false,
  );
  const prepared = useRecordCompanionHubStore(
    (state) => state.entries[scopeKey]?.dockedPrepared ?? false,
  );
  useLayoutEffect(() => {
    if (pendingDetach !== null && suppressed) {
      useRecordCompanionHubStore.getState().dispatchPendingAcknowledgement(scopeKey, "detach");
    }
  }, [pendingDetach, suppressed, scopeKey]);
  useLayoutEffect(() => {
    if (pendingDock !== null && prepared) {
      useRecordCompanionHubStore.getState().dispatchPendingAcknowledgement(scopeKey, "dock");
    }
  }, [pendingDock, prepared, scopeKey]);
  return null;
}

/**
 * One served scope's reader: resolves the R5 panel state through the keyed
 * query and reports it to the hub store; relays a snapshot whenever the
 * resolution (or the view/presentation) changes while a companion is live.
 */
function RecordCompanionScopeReader({ scopeKey }: { readonly scopeKey: string }) {
  const entry = useRecordCompanionHubStore((state) => state.entries[scopeKey] ?? null);
  return entry === null ? null : (
    <RecordCompanionScopeReaderView scopeKey={scopeKey} entry={entry} />
  );
}

function RecordCompanionScopeReaderView({
  scopeKey,
  entry,
}: {
  readonly scopeKey: string;
  readonly entry: RecordCompanionHubScopeEntry;
}) {
  const presentation = usePresentationState();
  const view = entry.view;
  const companionActive = companionPresentationActive(entry.placement, entry.scope);
  const ownerActive = usePresentationActive();
  const subscribed = entryNeedsQuery(entry) && (ownerActive || companionActive);
  const source = useMemo(
    () => ({
      environmentId: entry.scope.environmentId,
      threadId: entry.scope.threadId,
      providerInstanceId: entry.scope.providerInstanceId ?? undefined,
    }),
    [entry.scope],
  );
  // Host-observed activity of this scope's ready child keeps Record reads
  // alive while the main window is blurred; nothing else is woken.
  const { panel, pageScopeKey, retain } = useRecordExplorerPanel({
    source,
    view,
    retainedIndex: entry.retainedIndex,
    verifyIntent: entry.verifyIntent,
    subscribed,
    companionActive,
  });

  useEffect(() => {
    useRecordCompanionHubStore.getState().setReaderPanel(scopeKey, panel, pageScopeKey, retain);
  });
  // Demand gone cancels the proof: an unobserved or wholly inactive scope
  // never resumes it on its own when it becomes visible/focused again.
  const hasIntent = entry.verifyIntent !== null;
  const demandGone = !subscribed || (!ownerActive && !companionActive);
  useEffect(() => {
    if (demandGone && hasIntent) {
      useRecordCompanionHubStore.getState().applyDockedAction(scopeKey, { type: "cancelVerify" });
    }
  }, [demandGone, hasIntent, scopeKey]);

  const companionLive = entry.placement !== null && placementNeedsReader(entry.placement.placement);
  const snapshot = useMemo(() => {
    if (!companionLive || entry.placement === null || entry.awaitingRestoredView) return null;
    return buildRecordCompanionSnapshot({
      companionId: entry.placement.companionId,
      scope: entry.scope,
      scopeKey: entry.scopeKey,
      // The relayed descriptor revision is the FROZEN transaction identity;
      // a replaced source can never splice into a live companion.
      descriptorRevision: entry.handoff?.descriptorRevision ?? entry.descriptorRevision,
      viewRevision: entry.viewRevision,
      view,
      panel,
      sourceLabel: entry.sourceLabel,
      presentation: currentRecordCompanionPresentationFacts(presentation),
    });
  }, [
    companionLive,
    entry.placement,
    entry.awaitingRestoredView,
    entry.handoff,
    entry.descriptorRevision,
    entry.viewRevision,
    entry.scope,
    entry.scopeKey,
    entry.sourceLabel,
    view,
    panel,
    presentation,
  ]);
  useEffect(() => {
    if (snapshot !== null) useRecordCompanionHubStore.getState().relaySnapshot(scopeKey, snapshot);
  }, [snapshot, scopeKey]);
  return <RecordCompanionAcknowledgement scopeKey={scopeKey} />;
}

/**
 * The app-root owner hub. Wraps the routed application so docked surfaces can
 * find the controller; renders one headless reader per served scope.
 */
export function RecordCompanionOwnerHub({ children }: { readonly children: ReactNode }) {
  const controller = useMemo<RecordCompanionHubController>(
    () => ({
      observe: (scope, observed, visible) => {
        const hub = useRecordCompanionHubStore.getState();
        hub.ensureEntry(scope, recordCompanionSourceLabel(scope));
        hub.observeDockedSurface(recordCompanionScopeKey(scope), observed, visible);
      },
      dispatch: (scopeKey, action) => {
        useRecordCompanionHubStore.getState().applyDockedAction(scopeKey, action);
      },
      open: (scope, reopen) => {
        void useRecordCompanionHubStore.getState().openCompanion(scope, { reopen });
      },
      markPrepared: (scopeKey, prepared) => {
        useRecordCompanionHubStore.getState().setDockedPrepared(scopeKey, prepared);
      },
    }),
    [],
  );

  // The closed owner bridge exists only in the desktop main window; in a
  // plain browser the hub still controls the docked view, without companions.
  useEffect(() => {
    const bridge = recordCompanionBridge();
    if (bridge === null) return;
    let disposed = false;
    void bridge
      .subscribe()
      .then((states) => {
        if (!disposed) useRecordCompanionHubStore.getState().handleOwnerStates(states);
      })
      .catch(() => {
        // The hub stays docked-only until a successful subscription arrives.
      });
    const off = bridge.onOwnerEvent((event) => {
      useRecordCompanionHubStore.getState().handleOwnerEvent(event);
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);

  const readerKeys = useRecordCompanionHubStore((state) => state.readerScopeKeys().join("\u0000"));
  return (
    <RecordCompanionHubContext.Provider value={controller}>
      {children}
      {readerKeys === ""
        ? null
        : readerKeys
            .split("\u0000")
            .map((key) => <RecordCompanionScopeReader key={key} scopeKey={key} />)}
    </RecordCompanionHubContext.Provider>
  );
}
