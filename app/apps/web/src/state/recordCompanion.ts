/**
 * Owner-side Record companion hub store (Dokkabi R6 / R5-04).
 *
 * The hub lives at the app root and outlives ChatView route transitions. It
 * is the SINGLE authoritative controller of a logical inspection scope
 * (environment + thread + actual provider instance):
 *
 * - the scope's view preferences (tab/pin/after/selectedSeq) — one owner for
 *   the docked surface and the detached companion, so a hidden docked
 *   component can never report stale local preferences over a changed
 *   detached view;
 * - the scope's single authenticated keyed query (the hub reader resolves the
 *   R5 panel state used by BOTH placements; there is no second poller);
 * - the closed action controller (docked interactions and relayed child
 *   actions apply through the same pure reducer against the same page);
 * - the frozen handoff tuple of any live companion transaction.
 *
 * Close is CLOSED, never an automatic dock: when the native child closes
 * (canonical closed state push, or the terminal relay refusal fallback) the
 * scope enters a closed state — the docked surface shows an explicit
 * closed/Reopen placeholder and source polling stops until the operator
 * explicitly reopens the inspector. Only a committed ackDock renders the
 * docked reader interactive again; a failed opening returns docked with the
 * view intact.
 *
 * The store never talks to the network and never holds credentials: the only
 * IPC edges are the closed owner bridge methods (subscribe/open/reopen/relay/
 * ackDetach/ackDock) and the pushed owner events.
 */
import {
  recordCompanionScopeKey,
  type DesktopRecordCompanionBridge,
  type PresentationAppliedState,
  type PresentationTokensConfig,
  type ProviderWorkbenchRecord,
  type ProviderWorkbenchRecordIndex,
  type RecordCompanionOpenResult,
  type RecordCompanionOwnerEvent,
  type RecordCompanionPlacement,
  type RecordCompanionPlacementState,
  type RecordCompanionBodyWindow,
  type RecordCompanionScope,
  type RecordCompanionSnapshot,
  type RecordCompanionVerification,
  type RecordCompanionViewAction,
  type RecordCompanionViewPreferences,
} from "@t3tools/contracts";
import { create } from "zustand";

import { presentationStore } from "../presentationStore";
import type {
  DecisionRecordPanelState,
  RetainedWorkbenchRecordPage,
} from "../components/chat/DecisionRecordSurface.logic";
import {
  applyRecordExplorerViewAction,
  recordSelectionBinding,
  sameSelectionBinding,
  type RecordVerificationIntent,
  type RetainedRecordIndex,
} from "../components/recordExplorer/recordExplorer.logic";
import { recordVerificationRefusal } from "../components/recordExplorer/recordBodyWindow";

/** The closed owner bridge, when the desktop host exposes it (main window only). */
export function recordCompanionBridge(): DesktopRecordCompanionBridge | null {
  return typeof window !== "undefined" ? (window.desktopBridge?.recordCompanion ?? null) : null;
}

/** Longest width of the scope table; the least-recently-opened entry drops out. */
const MAX_HUB_SCOPE_ENTRIES = 64;

/** Token block meaning "the theme base provides every token" (schema-valid). */
export const NULL_RECORD_COMPANION_TOKENS: PresentationTokensConfig = {
  color: {
    background: null,
    surface: null,
    text: null,
    muted: null,
    border: null,
    accent: null,
  },
  radius: { panel: null, control: null },
  spacing: { base: null },
  font: { family: null, familyMono: null, sizePrompt: null, sizeCode: null, lineHeight: null },
  transition: { durationMs: null },
};

// ---------------------------------------------------------------------------
// Pure view-preference helpers
// ---------------------------------------------------------------------------

/** Structural equality of two view-preference values (cursor identity is exact). */
export function recordCompanionViewEqual(
  left: RecordCompanionViewPreferences,
  right: RecordCompanionViewPreferences,
): boolean {
  return (
    left.tab === right.tab &&
    left.pin?.seq === right.pin?.seq &&
    left.pin?.hash === right.pin?.hash &&
    left.pin?.generation === right.pin?.generation &&
    left.pin?.sessionId === right.pin?.sessionId &&
    left.after?.seq === right.after?.seq &&
    left.after?.hash === right.after?.hash &&
    left.after?.generation === right.after?.generation &&
    left.selectedSeq === right.selectedSeq &&
    (left.bodyStart ?? 0) === (right.bodyStart ?? 0)
  );
}

/** The default view: Record tab, live head, no page position, no selection. */
export function defaultRecordCompanionView(): RecordCompanionViewPreferences {
  return { tab: "record", pin: null, after: null, selectedSeq: null };
}

/**
 * Apply one CLOSED view action (docked or relayed child action — the same
 * vocabulary) against the current view and the currently displayed page.
 * Returns the next view, or null when the action is not applicable (select of
 * a seq outside the displayed page, next without a continuation, follow while
 * live). The action vocabulary never carries an arbitrary after/asOf/path —
 * the page supplies every cursor.
 *
 * The semantics are the exact R5 ones:
 * - first restarts at the log's first row (the pin is kept — an explicit pin
 *   survives paging back to the start);
 * - next continues exactly after the page's own cursor and holds the displayed
 *   prefix automatically (auto-pin when still live);
 * - pin freezes the displayed prefix; follow clears pin, page and selection;
 * - select names a row of the displayed page only.
 */
export function applyRecordCompanionViewAction(input: {
  readonly view: RecordCompanionViewPreferences;
  readonly action: RecordCompanionViewAction;
  readonly page: ProviderWorkbenchRecord | null;
}): RecordCompanionViewPreferences | null {
  const { view, action, page } = input;
  const available = page !== null && page.state === "available";
  switch (action.type) {
    case "first":
      return view.after === null && view.selectedSeq === null
        ? null
        : { ...view, after: null, selectedSeq: null };
    case "next":
      if (!available || !page.hasMore || page.next === null) return null;
      return {
        ...view,
        after: page.next,
        pin: view.pin ?? page.asOf,
        selectedSeq: null,
      };
    case "pin":
      if (!available) return null;
      if (view.pin !== null) {
        return { ...view, pin: null, after: null, selectedSeq: null };
      }
      return { ...view, pin: page.asOf };
    case "follow":
      if (view.pin === null) return null;
      return { ...view, pin: null, after: null, selectedSeq: null };
    case "select": {
      if (!available) return null;
      const inPage = page.records.some((row) => row.seq === action.seq);
      if (!inPage || view.selectedSeq === action.seq) return null;
      return { ...view, selectedSeq: action.seq };
    }
    case "tab":
      return view.tab === action.tab ? null : { ...view, tab: action.tab };
    case "bodyFirst":
    case "bodyPrevious":
    case "bodyNext":
    case "bodyLast":
    case "bodyJump":
    case "verify":
    case "cancelVerify":
      // Byte windows and proofs exist only on the bounded explorer path.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pure snapshot construction
// ---------------------------------------------------------------------------

/** The session/gateway generation identity of one validated page. */
export interface RecordCompanionDescriptorIdentity {
  readonly sessionId: string;
  readonly sessionGeneration: string;
  readonly gatewayGeneration: string;
}

export function descriptorIdentityOf(
  page: Pick<ProviderWorkbenchRecord, "sessionCursor" | "gatewayCursor">,
): RecordCompanionDescriptorIdentity {
  return {
    sessionId: page.sessionCursor.sessionId,
    sessionGeneration: page.sessionCursor.generation,
    gatewayGeneration: page.gatewayCursor.generation,
  };
}

export function sameDescriptorIdentity(
  left: RecordCompanionDescriptorIdentity,
  right: RecordCompanionDescriptorIdentity,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionGeneration === right.sessionGeneration &&
    left.gatewayGeneration === right.gatewayGeneration
  );
}

/** Presentation facts a snapshot freezes at build time (safe resolved values). */
export interface RecordCompanionPresentationFacts {
  readonly presentationRevision: number;
  readonly tokens: PresentationTokensConfig;
  readonly dark: boolean;
}

/**
 * The safe resolved presentation facts for one snapshot: the runtime-validated
 * PresentationConfig token block (never computed-style samples) and the
 * document's actually resolved dark/light mode. A missing presentation state
 * (plain browser) degrades to the all-null token block, which the closed
 * schema accepts and which lets the theme base provide everything.
 */
export function currentRecordCompanionPresentationFacts(
  applied?: PresentationAppliedState | null,
): RecordCompanionPresentationFacts {
  const state = applied ?? presentationStore.get();
  let dark = false;
  try {
    dark = document.documentElement.classList.contains("dark");
  } catch {
    // Not a real document (tests); the fact defaults to light.
  }
  return {
    presentationRevision: state?.revision ?? 0,
    tokens: state?.config.tokens ?? NULL_RECORD_COMPANION_TOKENS,
    dark,
  };
}

/**
 * Build one relayed snapshot from the hub's frozen transaction identity, the
 * current view and the R5-resolved panel state. The panel's own integrity and
 * head-continuity quarantine carries through unchanged: a quarantined page
 * relays as the last validated page with its explicit stale error, never as
 * fresh data — the child can never splice an unvalidated source.
 */
export function buildRecordCompanionSnapshot(input: {
  readonly companionId: string;
  readonly scope: RecordCompanionScope;
  readonly scopeKey: string;
  readonly descriptorRevision: number;
  readonly viewRevision: number;
  readonly view: RecordCompanionViewPreferences;
  readonly panel: DecisionRecordPanelState;
  readonly sourceLabel: string;
  readonly presentation: RecordCompanionPresentationFacts;
}): RecordCompanionSnapshot {
  const result =
    input.panel.kind === "explorer"
      ? {
          status: "explorer" as const,
          staleError: boundedReason(input.panel.staleError),
          index: input.panel.index,
          body: boundedBodyWindow(input.panel.body),
          verification: boundedVerification(input.panel.verification),
        }
      : input.panel.kind === "view"
        ? {
            status: "view" as const,
            staleError: input.panel.staleError,
            record: input.panel.page,
          }
        : input.panel.kind === "pending"
          ? { status: "pending" as const }
          : input.panel.kind === "unavailable"
            ? { status: "unavailable" as const, reason: input.panel.reason }
            : { status: "unsupported" as const, reason: input.panel.reason };
  return {
    companionId: input.companionId,
    scope: input.scope,
    scopeKey: input.scopeKey,
    descriptorRevision: input.descriptorRevision,
    viewRevision: input.viewRevision,
    presentationRevision: input.presentation.presentationRevision,
    view: input.view,
    result,
    sourceLabel: input.sourceLabel,
    theme: { dark: input.presentation.dark },
    tokens: input.presentation.tokens,
  };
}

/** Explanations crossing to the companion are bounded inert text. */
const RELAYED_REASON_MAX = 2_048;
function boundedReason<T extends string | null>(reason: T): T {
  return (
    reason !== null && reason.length > RELAYED_REASON_MAX
      ? `${reason.slice(0, RELAYED_REASON_MAX - 1)}…`
      : reason
  ) as T;
}
function boundedBodyWindow(body: RecordCompanionBodyWindow): RecordCompanionBodyWindow {
  return body.status === "failed" || body.status === "unavailable" || body.status === "unsupported"
    ? { ...body, reason: boundedReason(body.reason) }
    : body;
}
function boundedVerification(
  verification: RecordCompanionVerification,
): RecordCompanionVerification {
  return verification.status === "failed" || verification.status === "refused"
    ? { ...verification, reason: boundedReason(verification.reason) }
    : verification;
}

const activityRevisionOf = (state: RecordCompanionPlacementState): number =>
  state.childActivityRevision ?? 0;

const sameCompanionScope = (left: RecordCompanionScope, right: RecordCompanionScope): boolean =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  (left.providerInstanceId ?? null) === (right.providerInstanceId ?? null);

const sameHandoffTuple = (
  left: RecordCompanionPlacementState["handoff"],
  right: RecordCompanionPlacementState["handoff"],
): boolean =>
  left === null || right === null
    ? left === right
    : left.descriptorRevision === right.descriptorRevision &&
      left.viewRevision === right.viewRevision &&
      left.presentationRevision === right.presentationRevision;

/**
 * Reconcile a pushed placement state with the current one. Lifecycle is
 * CAS-ordered by `revision`: older states are ignored. Host activity is
 * ordered independently by `childActivityRevision`: a same-revision push may
 * only advance activity, and only when every lifecycle identity and the
 * handoff tuple are unchanged; a newer lifecycle never rewinds activity.
 */
export function mergePlacementState(
  current: RecordCompanionPlacementState | null,
  next: RecordCompanionPlacementState,
): RecordCompanionPlacementState {
  if (current === null || current.companionId !== next.companionId) return next;
  const currentActivity = activityRevisionOf(current);
  const nextActivity = activityRevisionOf(next);
  if (next.revision < current.revision) return current;
  if (next.revision > current.revision) {
    return nextActivity >= currentActivity
      ? next
      : {
          ...next,
          childActive: current.childActive ?? false,
          childActivityRevision: currentActivity,
        };
  }
  const sameLifecycle =
    current.scopeKey === next.scopeKey &&
    sameCompanionScope(current.scope, next.scope) &&
    current.placement === next.placement &&
    current.ownerSenderId === next.ownerSenderId &&
    current.childSender === next.childSender &&
    current.childReady === next.childReady &&
    current.childQuiesced === next.childQuiesced &&
    sameHandoffTuple(current.handoff, next.handoff) &&
    sameHandoffTuple(current.acknowledgedHandoff, next.acknowledgedHandoff);
  if (!sameLifecycle || nextActivity <= currentActivity) return current;
  return {
    ...current,
    childActive: next.childActive ?? false,
    childActivityRevision: nextActivity,
  };
}

/**
 * True when the host reports this scope's companion as the effectively
 * active presentation: detached, ready, not quiesced and natively active.
 */
export function companionPresentationActive(
  placement: RecordCompanionPlacementState | null,
  expectedScope?: RecordCompanionScope,
): boolean {
  return (
    placement !== null &&
    recordCompanionScopeKey(placement.scope) === placement.scopeKey &&
    (expectedScope === undefined || sameCompanionScope(placement.scope, expectedScope)) &&
    placement.placement === "detached" &&
    placement.childReady &&
    !placement.childQuiesced &&
    placement.childSender !== null &&
    placement.handoff !== null &&
    sameHandoffTuple(placement.handoff, placement.acknowledgedHandoff) &&
    placement.childActive === true
  );
}

/** True while the registry placement needs the hub's relayed query. */
export function placementNeedsReader(placement: RecordCompanionPlacement): boolean {
  return placement === "opening" || placement === "detached" || placement === "docking";
}

/** Terminal relay refusal: the companion no longer exists for this owner. */
export function isUnknownCompanionRefusal(message: string): boolean {
  return message.includes("unknown companion");
}

/** Honest factual source label from the exact scope identities. */
export function recordCompanionSourceLabel(scope: RecordCompanionScope): string {
  const environment = String(scope.environmentId).slice(0, 12);
  const thread = String(scope.threadId).slice(0, 12);
  const instance =
    scope.providerInstanceId === null ? "unbound" : String(scope.providerInstanceId).slice(0, 12);
  return `env ${environment} · thread ${thread} · instance ${instance}`;
}

// ---------------------------------------------------------------------------
// Hub store
// ---------------------------------------------------------------------------

export interface RecordCompanionHubScopeEntry {
  readonly scopeKey: string;
  readonly scope: RecordCompanionScope;
  /** The authoritative view preferences for BOTH placements. */
  view: RecordCompanionViewPreferences;
  sourceLabel: string;
  /** The frozen tuple of the live transaction; null while none is live. */
  handoff: {
    descriptorRevision: number;
    viewRevision: number;
    presentationRevision: number;
  } | null;
  /** The registry's last pushed placement state; null = no live companion. */
  placement: RecordCompanionPlacementState | null;
  /** True once the child acknowledged ready: the docked view is hidden. */
  dockedSuppressed: boolean;
  /**
   * The child acknowledged the frozen tuple and the docked view is hidden in
   * the committed DOM — the detach acknowledgement dispatches from a layout
   * effect once this pending transaction and the suppressed render coexist.
   * Store mutations are intentions, never committed-DOM receipts.
   */
  pendingAckDetach: { readonly companionId: string; readonly revision: number } | null;
  /**
   * The child quiesced and the docked view must first PREPARE the restored
   * position (the committed DOM renders it, disabled); the dock
   * acknowledgement dispatches from a layout effect only then.
   */
  pendingAckDock: { readonly companionId: string; revision: number } | null;
  /**
   * The mounted docked surface reports (from its own layout effect) that the
   * committed DOM currently renders the docking-prepared view.
   */
  dockedPrepared: boolean;
  /**
   * The companion was closed (child window closed / canonical closed state).
   * Close is CLOSED: the docked surface shows closed/Reopen and polling stops
   * until an explicit reopen; only a committed ackDock clears this.
   */
  companionClosed: boolean;
  /** Reopen is inert until the host restores the durable view preferences. */
  awaitingRestoredView: boolean;
  /** A docked surface is currently mounted for this scope. */
  dockedObserved: boolean;
  /** The mounted docked surface reports its panel visibility. */
  dockedVisible: boolean;
  /** Hub-owned view-revision counter; bumped per applied view change. */
  viewRevision: number;
  /** Source-descriptor generation counter frozen into each open. */
  descriptorRevision: number;
  /** Last source identity seen on a validated page of this scope. */
  observedDescriptor: RecordCompanionDescriptorIdentity | null;
  /** The last validated page the hub reader resolved (action validation). */
  currentPage: ProviderWorkbenchRecord | null;
  /** The last validated explorer metadata page (bounded explorer actions). */
  currentIndex: ProviderWorkbenchRecordIndex | null;
  /** Same-page-scope retention of the explorer index. */
  retainedIndex: RetainedRecordIndex | null;
  /**
   * The explicit whole-record proof request, bound to the selected row, pin
   * and descriptor; cleared by any change of selection, pin or page.
   */
  verifyIntent: RecordVerificationIntent | null;
  /** Monotonic proof request counter: each explicit Verify is a new read. */
  verifyNonce: number;
  /** Retention for the reader's R5 resolution, keyed by page-position scope. */
  retained: RetainedWorkbenchRecordPage | null;
  /** The reader's current R5 panel resolution (both placements render this). */
  panel: DecisionRecordPanelState | null;
  /** Canonical JSON of the last relay the registry accepted. */
  lastRelayedJson: string | null;
  /** A visible conflict/error message; null when quiet. */
  conflictMessage: string | null;
}

export interface RecordCompanionHubActions {
  /** Ensure the scope's entry exists (one entry per logical scope). */
  ensureEntry: (scope: RecordCompanionScope, sourceLabel: string) => RecordCompanionHubScopeEntry;
  /** The docked surface reports mount/visibility; the hub owns observation. */
  observeDockedSurface: (scopeKey: string, observed: boolean, visible: boolean) => void;
  /** The hub reader reports its resolved panel (panel + retention + page). */
  setReaderPanel: (
    scopeKey: string,
    panel: DecisionRecordPanelState,
    pageScopeKey: string,
    retainIndex?: RetainedRecordIndex | null,
  ) => void;
  /** Apply one docked-origin view action through the closed reducer. */
  applyDockedAction: (scopeKey: string, action: RecordCompanionViewAction) => void;
  /** The mounted surface reports the committed docking-prepared DOM state. */
  setDockedPrepared: (scopeKey: string, prepared: boolean) => void;
  /**
   * Dispatch one pending acknowledgement after its DOM gate committed. The
   * pending transaction is claimed single-shot before the bridge call.
   */
  dispatchPendingAcknowledgement: (scopeKey: string, kind: "detach" | "dock") => void;
  /** Relay one built snapshot; dedups and handles refusals. */
  relaySnapshot: (scopeKey: string, snapshot: RecordCompanionSnapshot) => void;
  /** Open (detach) or reopen the scope's companion through the owner bridge. */
  openCompanion: (
    scope: RecordCompanionScope,
    options: { readonly reopen: boolean },
  ) => Promise<RecordCompanionOpenResult | null>;
  /** Apply one pushed owner event (state/childReady/childQuiesced/viewAction). */
  handleOwnerEvent: (event: RecordCompanionOwnerEvent) => void;
  /** Reconcile with the registry's current live states (subscribe receipt). */
  handleOwnerStates: (states: readonly RecordCompanionPlacementState[]) => void;
  /** Scope keys the hub reader must serve (companion live or docked observed). */
  readerScopeKeys: () => readonly string[];
}

export interface RecordCompanionHubStore extends RecordCompanionHubActions {
  entries: Record<string, RecordCompanionHubScopeEntry>;
  /** LRU order of scope keys (oldest first). */
  order: string[];
}

/** Meaningful equality of two reader resolutions (page identity is the atom's). */
export function sameReaderPanel(
  left: DecisionRecordPanelState | null,
  right: DecisionRecordPanelState,
): boolean {
  if (left === null) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "view" && right.kind === "view") {
    return left.page === right.page && left.staleError === right.staleError;
  }
  if (left.kind === "explorer" && right.kind === "explorer") {
    return (
      left.index === right.index &&
      left.staleError === right.staleError &&
      JSON.stringify(left.body) === JSON.stringify(right.body) &&
      JSON.stringify(left.verification) === JSON.stringify(right.verification)
    );
  }
  if (
    (left.kind === "unavailable" || left.kind === "unsupported") &&
    (right.kind === "unavailable" || right.kind === "unsupported")
  ) {
    return left.reason === right.reason;
  }
  return true;
}

function makeEntry(scope: RecordCompanionScope, sourceLabel: string): RecordCompanionHubScopeEntry {
  return {
    scopeKey: recordCompanionScopeKey(scope),
    scope,
    view: defaultRecordCompanionView(),
    sourceLabel,
    handoff: null,
    placement: null,
    dockedSuppressed: false,
    pendingAckDetach: null,
    pendingAckDock: null,
    dockedPrepared: false,
    companionClosed: false,
    awaitingRestoredView: false,
    dockedObserved: false,
    dockedVisible: false,
    viewRevision: 0,
    descriptorRevision: 0,
    observedDescriptor: null,
    currentPage: null,
    currentIndex: null,
    retainedIndex: null,
    verifyIntent: null,
    verifyNonce: 0,
    retained: null,
    panel: null,
    lastRelayedJson: null,
    conflictMessage: null,
  };
}

export const useRecordCompanionHubStore = create<RecordCompanionHubStore>((set, get) => {
  const mutateEntry = (
    scopeKey: string,
    mutate: (entry: RecordCompanionHubScopeEntry) => RecordCompanionHubScopeEntry | null,
  ): void => {
    set((state) => {
      const entry = state.entries[scopeKey];
      if (entry === undefined) return state;
      const next = mutate(entry);
      if (next === null || next === entry) return state;
      return { entries: { ...state.entries, [scopeKey]: next } };
    });
  };

  /** A transaction that ended with the child gone: closed, never auto-docked. */
  const closeCompanion = (entry: RecordCompanionHubScopeEntry): RecordCompanionHubScopeEntry => ({
    ...entry,
    handoff: null,
    placement: null,
    dockedSuppressed: false,
    pendingAckDetach: null,
    pendingAckDock: null,
    dockedPrepared: false,
    companionClosed: true,
    awaitingRestoredView: false,
    lastRelayedJson: null,
  });

  /** A transaction that ended docked: the docked reader becomes interactive. */
  const settleDocked = (entry: RecordCompanionHubScopeEntry): RecordCompanionHubScopeEntry => ({
    ...entry,
    handoff: null,
    placement: null,
    dockedSuppressed: false,
    pendingAckDetach: null,
    pendingAckDock: null,
    dockedPrepared: false,
    companionClosed: false,
    awaitingRestoredView: false,
    lastRelayedJson: null,
  });

  /** Adopt an externally restored view (registry reopen restore, dock restore). */
  const adoptView = (
    entry: RecordCompanionHubScopeEntry,
    view: RecordCompanionViewPreferences,
  ): RecordCompanionHubScopeEntry => {
    if (recordCompanionViewEqual(entry.view, view)) return entry;
    return {
      ...entry,
      view,
      // The restored view is authoritative: the bump makes the next relay
      // carry it so the registry's own view/persistence re-sync.
      viewRevision: entry.viewRevision + 1,
    };
  };

  const entryOfCompanion = (
    companionId: string,
  ): { scopeKey: string; entry: RecordCompanionHubScopeEntry } | null => {
    for (const [scopeKey, entry] of Object.entries(get().entries)) {
      if (entry.placement?.companionId === companionId) return { scopeKey, entry };
    }
    return null;
  };

  /** Apply a view change and bump the hub's view revision (one owner). */
  const applyViewChange = (
    entry: RecordCompanionHubScopeEntry,
    action: RecordCompanionViewAction,
  ): RecordCompanionHubScopeEntry | null => {
    const explorer = entry.panel?.kind === "explorer" || entry.currentIndex !== null;
    if (!explorer) {
      const next = applyRecordCompanionViewAction({
        view: entry.view,
        action,
        page: entry.currentPage,
      });
      if (next === null) return null;
      return { ...entry, view: next, viewRevision: entry.viewRevision + 1 };
    }
    const binding = recordSelectionBinding(entry.currentIndex, entry.view);
    if (action.type === "verify") {
      // Explicit only; a refused (>64 MiB) or unbound selection sends nothing.
      if (binding === null || recordVerificationRefusal(binding.expected) !== null) return null;
      const status = entry.panel?.kind === "explorer" ? entry.panel.verification.status : "idle";
      if (
        entry.verifyIntent !== null &&
        sameSelectionBinding(entry.verifyIntent, binding) &&
        (status === "pending" || status === "exact")
      ) {
        // Already running or proven for this exact selection: no repeat.
        return null;
      }
      const nonce = entry.verifyNonce + 1;
      return {
        ...entry,
        verifyIntent: { ...binding, nonce },
        verifyNonce: nonce,
        viewRevision: entry.viewRevision + 1,
      };
    }
    if (action.type === "cancelVerify") {
      if (entry.verifyIntent === null) return null;
      return { ...entry, verifyIntent: null, viewRevision: entry.viewRevision + 1 };
    }
    const next = applyRecordExplorerViewAction({
      view: entry.view,
      action,
      index: entry.currentIndex,
      window: entry.panel?.kind === "explorer" ? entry.panel.body : null,
    });
    if (next === null) return null;
    const nextBinding = recordSelectionBinding(entry.currentIndex, next);
    return {
      ...entry,
      view: next,
      viewRevision: entry.viewRevision + 1,
      // A proof never transfers to another selection, pin or page.
      verifyIntent:
        entry.verifyIntent !== null && sameSelectionBinding(entry.verifyIntent, nextBinding)
          ? entry.verifyIntent
          : null,
    };
  };

  const actions: RecordCompanionHubActions = {
    ensureEntry: (scope, sourceLabel) => {
      const scopeKey = recordCompanionScopeKey(scope);
      const existing = get().entries[scopeKey];
      if (existing !== undefined) {
        if (existing.sourceLabel !== sourceLabel) {
          mutateEntry(scopeKey, (entry) => ({ ...entry, sourceLabel }));
        }
        return existing;
      }
      const entry = makeEntry(scope, sourceLabel);
      set((state) => {
        const order = [...state.order, scopeKey];
        const overflow = order.length - MAX_HUB_SCOPE_ENTRIES;
        const entries = { ...state.entries, [scopeKey]: entry };
        let finalOrder = order;
        for (let index = 0; index < overflow; index += 1) {
          const dropped = order[index];
          if (dropped === undefined) continue;
          const droppedEntry = entries[dropped];
          // A live or observed entry never drops out of the table.
          if (
            droppedEntry === undefined ||
            droppedEntry.placement !== null ||
            droppedEntry.dockedObserved
          ) {
            continue;
          }
          delete entries[dropped];
          finalOrder = finalOrder.filter((key) => key !== dropped);
        }
        return { entries, order: finalOrder };
      });
      return entry;
    },
    observeDockedSurface: (scopeKey, observed, visible) => {
      mutateEntry(scopeKey, (entry) => {
        if (entry.dockedObserved === observed && entry.dockedVisible === visible) return null;
        return { ...entry, dockedObserved: observed, dockedVisible: visible };
      });
    },
    setReaderPanel: (scopeKey, panel, pageScopeKey, retainIndex = null) => {
      mutateEntry(scopeKey, (entry) => {
        // Every field update is conditional: this runs after each reader
        // render, and an unconditional spread would loop the store.
        let next = sameReaderPanel(entry.panel, panel) ? entry : { ...entry, panel };
        if (panel.kind === "view" && panel.staleError === null) {
          if (
            next.retained === null ||
            next.retained.scopeKey !== pageScopeKey ||
            next.retained.page !== panel.page
          ) {
            next = { ...next, retained: { scopeKey: pageScopeKey, page: panel.page } };
          }
          if (next.currentPage !== panel.page) {
            next = { ...next, currentPage: panel.page };
          }
          const identity = descriptorIdentityOf(panel.page);
          if (next.observedDescriptor === null) {
            next = { ...next, observedDescriptor: identity };
          } else if (!sameDescriptorIdentity(next.observedDescriptor, identity)) {
            // A validated page from a replaced source: the scope's descriptor
            // counter advances so the NEXT open freezes the new identity.
            next = {
              ...next,
              observedDescriptor: identity,
              descriptorRevision: next.descriptorRevision + 1,
            };
          }
        } else if (panel.kind === "explorer" && panel.staleError === null) {
          if (
            retainIndex !== null &&
            (next.retainedIndex === null ||
              next.retainedIndex.scopeKey !== retainIndex.scopeKey ||
              next.retainedIndex.pinned !== retainIndex.pinned ||
              next.retainedIndex.index !== retainIndex.index)
          ) {
            next = { ...next, retainedIndex: retainIndex };
          }
          if (next.currentIndex !== panel.index) next = { ...next, currentIndex: panel.index };
          const identity = descriptorIdentityOf(panel.index);
          if (next.observedDescriptor === null) {
            next = { ...next, observedDescriptor: identity };
          } else if (!sameDescriptorIdentity(next.observedDescriptor, identity)) {
            next = {
              ...next,
              observedDescriptor: identity,
              descriptorRevision: next.descriptorRevision + 1,
            };
          }
        } else if (panel.kind === "explorer") {
          if (next.currentIndex !== panel.index) next = { ...next, currentIndex: panel.index };
        } else if (panel.kind !== "view") {
          if (next.currentPage !== null) next = { ...next, currentPage: null };
          if (next.currentIndex !== null) next = { ...next, currentIndex: null };
        }
        return next === entry ? null : next;
      });
    },
    applyDockedAction: (scopeKey, action) => {
      mutateEntry(scopeKey, (entry) => applyViewChange(entry, action));
    },
    setDockedPrepared: (scopeKey, prepared) => {
      mutateEntry(scopeKey, (entry) => {
        if (entry.dockedPrepared === prepared) return null;
        return { ...entry, dockedPrepared: prepared };
      });
    },
    dispatchPendingAcknowledgement: (scopeKey, kind) => {
      const entry = get().entries[scopeKey];
      if (entry === undefined) return;
      const bridge = recordCompanionBridge();
      if (kind === "detach") {
        const pending = entry.pendingAckDetach;
        if (pending === null) return;
        // Claim the transaction single-shot before the async call: a layout
        // effect must never double-send the same acknowledgement.
        mutateEntry(scopeKey, (current) => ({ ...current, pendingAckDetach: null }));
        if (bridge === null) return;
        void bridge
          .ackDetach({ companionId: pending.companionId, revision: pending.revision })
          .then((placement) => {
            mutateEntry(scopeKey, (current) =>
              placement.placement === "closed"
                ? closeCompanion(current)
                : placement.placement === "docked"
                  ? settleDocked(current)
                  : { ...current, placement },
            );
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            mutateEntry(scopeKey, (current) => ({
              ...current,
              dockedSuppressed: false,
              conflictMessage: message,
            }));
          });
        return;
      }
      const pending = entry.pendingAckDock;
      if (pending === null) return;
      mutateEntry(scopeKey, (current) => ({
        ...current,
        pendingAckDock: null,
        dockedPrepared: false,
      }));
      if (bridge === null) return;
      void bridge
        .ackDock({ companionId: pending.companionId, revision: pending.revision })
        .then((placement) => {
          // Only the committed dock renders the docked reader interactive.
          mutateEntry(scopeKey, (current) =>
            placement.placement === "closed" ? closeCompanion(current) : settleDocked(current),
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          mutateEntry(scopeKey, (current) => ({ ...current, conflictMessage: message }));
        });
    },
    relaySnapshot: (scopeKey, snapshot) => {
      const entry = get().entries[scopeKey];
      if (entry === undefined) return;
      const companionId = entry.placement?.companionId;
      if (companionId === undefined || companionId === null) return;
      const json = JSON.stringify(snapshot);
      if (json === entry.lastRelayedJson) return;
      const bridge = recordCompanionBridge();
      if (bridge === null) return;
      void bridge
        .relay({ companionId, snapshot })
        .then(() => {
          mutateEntry(scopeKey, (current) => ({ ...current, lastRelayedJson: json }));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (isUnknownCompanionRefusal(message)) {
            // The child window was closed: the scope becomes CLOSED — the
            // docked surface shows closed/Reopen and polling stops here with
            // the reader; the docked reader never silently returns.
            mutateEntry(scopeKey, closeCompanion);
            return;
          }
          mutateEntry(scopeKey, (current) => ({ ...current, conflictMessage: message }));
        });
    },
    openCompanion: async (scope, options) => {
      const bridge = recordCompanionBridge();
      if (bridge === null) return null;
      const entry = actions.ensureEntry(scope, recordCompanionSourceLabel(scope));
      const input = {
        scope,
        view: entry.view,
        descriptorRevision: entry.descriptorRevision,
        viewRevision: entry.viewRevision,
        presentationRevision: presentationStore.get()?.revision ?? 0,
      };
      if (options.reopen) {
        mutateEntry(entry.scopeKey, (current) => ({ ...current, awaitingRestoredView: true }));
      }
      let result: RecordCompanionOpenResult;
      try {
        result = options.reopen ? await bridge.reopen(input) : await bridge.open(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mutateEntry(entry.scopeKey, (current) => ({
          ...current,
          awaitingRestoredView: false,
          conflictMessage: message,
        }));
        return { type: "error", message };
      }
      if (result.type === "opening") {
        mutateEntry(entry.scopeKey, (current) => {
          if (current.handoff !== null && current.placement?.companionId === result.companionId) {
            // Reveal is not a new transaction: retain the already acknowledged
            // placement, preferences and tuple, including a newer pushed state.
            return { ...current, conflictMessage: null };
          }
          return {
            ...current,
            handoff: result.state.handoff,
            placement: result.state,
            companionClosed: false,
            awaitingRestoredView: current.awaitingRestoredView,
            dockedSuppressed: result.state.placement !== "opening",
            conflictMessage: null,
            lastRelayedJson: null,
          };
        });
      } else {
        mutateEntry(entry.scopeKey, (current) => ({
          ...current,
          awaitingRestoredView: false,
          conflictMessage:
            result.type === "conflict" || result.type === "error"
              ? result.message
              : current.conflictMessage,
        }));
      }
      return result;
    },
    handleOwnerEvent: (event) => {
      if (event.type === "state") {
        const state = event.state;
        if (recordCompanionScopeKey(state.scope) !== state.scopeKey) return;
        actions.ensureEntry(state.scope, recordCompanionSourceLabel(state.scope));
        mutateEntry(state.scopeKey, (entry) => {
          const merged = mergePlacementState(entry.placement, state);
          if (merged === entry.placement) return null;
          if (merged.placement === "closed") {
            // Canonical closed: never an automatic dock.
            if (
              entry.placement === null &&
              entry.handoff === null &&
              !entry.dockedSuppressed &&
              entry.companionClosed
            ) {
              return null;
            }
            return closeCompanion(entry);
          }
          if (merged.placement === "docked") {
            // A failed opening returns docked with the view intact; a dock
            // commit publishes docked before the child closes.
            return settleDocked(entry);
          }
          return { ...entry, placement: merged };
        });
        return;
      }
      if (event.type === "childReady") {
        const found = entryOfCompanion(event.companionId);
        if (found === null) return;
        const { scopeKey, entry } = found;
        if (
          entry.handoff !== null &&
          (entry.handoff.descriptorRevision !== event.handoff.descriptorRevision ||
            entry.handoff.viewRevision !== event.handoff.viewRevision ||
            entry.handoff.presentationRevision !== event.handoff.presentationRevision)
        ) {
          // A tuple we never negotiated: refuse the transaction by not
          // acknowledging the detach. The opening times out natively and the
          // docked view stays interactive.
          mutateEntry(scopeKey, (current) => ({
            ...current,
            conflictMessage:
              "The companion acknowledged a different handoff tuple; refusing to detach.",
          }));
          return;
        }
        // Hide/disable the docked view FIRST — a store intention, not yet a
        // committed-DOM receipt. The registry's view (which reopen restored
        // from persisted preferences) becomes authoritative, and the detach
        // acknowledgement dispatches from a layout effect only after the
        // suppressed placeholder actually committed.
        mutateEntry(scopeKey, (current) => ({
          ...adoptView(
            { ...current, dockedSuppressed: true, awaitingRestoredView: false },
            event.view,
          ),
          pendingAckDetach: { companionId: event.companionId, revision: event.revision },
        }));
        return;
      }
      if (event.type === "childQuiesced") {
        const found = entryOfCompanion(event.companionId);
        if (found === null) return;
        const { scopeKey } = found;
        // The dock acknowledgement waits until the ORIGINAL scope's docked
        // inspector is mounted, visible and renders the restored position
        // prepared: if the main window navigated to another thread, the child
        // stays inert in Docking rather than closing over a missing
        // destination. No navigation or composer retarget ever happens here.
        mutateEntry(scopeKey, (current) => ({
          ...adoptView(current, event.view),
          pendingAckDock: { companionId: event.companionId, revision: event.revision },
          dockedPrepared: false,
        }));
        return;
      }
      if (event.type === "viewAction") {
        mutateEntry(event.scopeKey, (entry) => {
          if (
            entry.placement === null ||
            entry.placement.companionId !== event.companionId ||
            entry.viewRevision !== event.viewRevision
          ) {
            // Stale or foreign action: the next relayed snapshot re-syncs the
            // child; nothing is applied.
            return null;
          }
          return applyViewChange(entry, event.action);
        });
        return;
      }
      // snapshotRelayed: the registry's own dedup echo; nothing to apply.
    },
    handleOwnerStates: (states) => {
      const liveKeys = new Set<string>();
      for (const state of states) {
        liveKeys.add(state.scopeKey);
        actions.ensureEntry(state.scope, recordCompanionSourceLabel(state.scope));
        actions.handleOwnerEvent({ type: "state", state });
      }
      set((hub) => {
        const entries = { ...hub.entries };
        for (const [scopeKey, entry] of Object.entries(hub.entries)) {
          if (entry.placement !== null && !liveKeys.has(scopeKey)) {
            // The registry dropped the record: a close we were not told about
            // (the child window closed without a state push).
            entries[scopeKey] = closeCompanion(entry);
          }
        }
        return { entries };
      });
    },
    readerScopeKeys: () =>
      Object.entries(get().entries)
        .filter(
          ([, entry]) =>
            (entry.placement !== null && placementNeedsReader(entry.placement.placement)) ||
            entry.dockedObserved,
        )
        .map(([scopeKey]) => scopeKey),
  };

  return { entries: {}, order: [], ...actions };
});

/** True when the hub reader must keep the scope's query subscribed. */
export function entryNeedsQuery(entry: RecordCompanionHubScopeEntry): boolean {
  if (entry.awaitingRestoredView) return false;
  if (entry.placement !== null && placementNeedsReader(entry.placement.placement)) return true;
  return (
    entry.dockedObserved && entry.dockedVisible && !entry.dockedSuppressed && !entry.companionClosed
  );
}

/** Reset the hub store between tests. */
export function resetRecordCompanionHubForTest(): void {
  useRecordCompanionHubStore.setState({
    entries: {},
    order: [],
  });
}
