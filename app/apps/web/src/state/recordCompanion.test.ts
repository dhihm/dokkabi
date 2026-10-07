// @vitest-environment jsdom
import * as NodeCrypto from "node:crypto";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  recordCompanionScopeKey,
} from "@t3tools/contracts";
import type {
  DesktopRecordCompanionBridge,
  ProviderWorkbenchRecord,
  RecordCompanionOwnerEvent,
  RecordCompanionPlacementState,
  RecordCompanionScope,
  RecordCompanionViewPreferences,
  WorkbenchRecordRow,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  NULL_RECORD_COMPANION_TOKENS,
  applyRecordCompanionViewAction,
  buildRecordCompanionSnapshot,
  currentRecordCompanionPresentationFacts,
  defaultRecordCompanionView,
  descriptorIdentityOf,
  entryNeedsQuery,
  placementNeedsReader,
  resetRecordCompanionHubForTest,
  sameDescriptorIdentity,
  sameReaderPanel,
  useRecordCompanionHubStore,
} from "./recordCompanion";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");
const INSTANCE = ProviderInstanceId.make("instance-1");
const SCOPE: RecordCompanionScope = {
  environmentId: ENV,
  threadId: THREAD,
  providerInstanceId: INSTANCE,
};

export function fixturePage(options?: {
  readonly sessionId?: string;
  readonly rows?: number;
  readonly pageSize?: number;
}): ProviderWorkbenchRecord {
  const rowCount = options?.rows ?? 4;
  const pageSize = options?.pageSize ?? rowCount;
  const rows: WorkbenchRecordRow[] = [];
  let prevHash = "0".repeat(64);
  for (let seq = 1; seq <= rowCount; seq += 1) {
    const hash = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({
          kind: "observe",
          name: `test/source#${seq}`,
          payload: { seq },
          prev_hash: prevHash,
          seq,
          ts: "2026-10-02T00:00:00.000Z",
        }),
      )
      .digest("hex");
    rows.push({
      kind: "observe",
      name: `test/source#${seq}`,
      payload: { seq },
      prev_hash: prevHash,
      seq,
      ts: "2026-10-02T00:00:00.000Z",
      hash,
    });
    prevHash = hash;
  }
  const last = rows[rowCount - 1];
  if (last === undefined) {
    throw new Error("fixturePage requires at least one row");
  }
  const asOf = {
    sessionId: options?.sessionId ?? "session-1",
    seq: rowCount,
    hash: last.hash,
    generation: "a".repeat(64),
  };
  const shown = rows.slice(0, pageSize);
  const shownLast = shown[shown.length - 1];
  const hasMore = pageSize < rowCount;
  return {
    version: 1,
    state: "available",
    sessionCursor: asOf,
    gatewayCursor: { seq: 0, hash: "0".repeat(64), generation: "0".repeat(64) },
    asOf,
    records: shown,
    next:
      hasMore && shownLast !== undefined
        ? { seq: shownLast.seq, hash: shownLast.hash, generation: asOf.generation }
        : null,
    total: rowCount,
    hasMore,
    decisions: { status: "unsupported", reason: "checkpoint authority absent" },
  };
}

function placementState(
  overrides?: Partial<RecordCompanionPlacementState>,
): RecordCompanionPlacementState {
  return {
    companionId: "companion-1",
    scope: SCOPE,
    scopeKey: recordCompanionScopeKey(SCOPE),
    placement: "opening",
    revision: 2,
    ownerSenderId: 1,
    childSender: 7,
    childReady: false,
    childQuiesced: false,
    handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
    acknowledgedHandoff: null,
    ...overrides,
  };
}

type FakeBridge = DesktopRecordCompanionBridge & {
  readonly emit: (event: RecordCompanionOwnerEvent) => void;
};

function makeFakeBridge(overrides?: {
  open?: () => ReturnType<DesktopRecordCompanionBridge["open"]>;
  reopen?: () => ReturnType<DesktopRecordCompanionBridge["reopen"]>;
  relay?: () => Promise<void>;
}): FakeBridge {
  const listeners = new Set<(event: RecordCompanionOwnerEvent) => void>();
  return {
    subscribe: vi.fn(async () => [] as readonly RecordCompanionPlacementState[]),
    open:
      overrides?.open ??
      vi.fn(
        async () =>
          ({ type: "opening", companionId: "companion-1", state: placementState() }) as const,
      ),
    reopen:
      overrides?.reopen ??
      vi.fn(
        async () =>
          ({ type: "opening", companionId: "companion-1", state: placementState() }) as const,
      ),
    relay: overrides?.relay ?? vi.fn(async () => undefined),
    ackDetach: vi.fn(async () => placementState({ placement: "detached", revision: 4 })),
    ackDock: vi.fn(async () => placementState({ placement: "docked", revision: 7 })),
    onOwnerEvent: vi.fn((listener: (event: RecordCompanionOwnerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  } as FakeBridge;
}

beforeEach(() => {
  resetRecordCompanionHubForTest();
});

afterEach(() => {
  resetRecordCompanionHubForTest();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Pure view action reducer
// ---------------------------------------------------------------------------

describe("applyRecordCompanionViewAction", () => {
  const page = fixturePage({ rows: 4, pageSize: 2 });
  const base: RecordCompanionViewPreferences = defaultRecordCompanionView();

  it("first clears the page position but keeps an explicit pin", () => {
    const pinned: RecordCompanionViewPreferences = {
      ...base,
      pin: page.asOf,
      after: page.next,
      selectedSeq: 2,
    };
    expect(
      applyRecordCompanionViewAction({ view: pinned, action: { type: "first" }, page }),
    ).toEqual({
      ...pinned,
      after: null,
      selectedSeq: null,
    });
  });

  it("next continues exactly after the page cursor and auto-pins the displayed prefix", () => {
    const next = applyRecordCompanionViewAction({ view: base, action: { type: "next" }, page });
    expect(next).not.toBeNull();
    expect(next?.after).toEqual(page.next);
    expect(next?.pin).toEqual(page.asOf);
    expect(next?.selectedSeq).toBeNull();
  });

  it("pin freezes the page prefix and preserves the selection; follow clears everything", () => {
    const selected: RecordCompanionViewPreferences = { ...base, selectedSeq: 4 };
    const pinned = applyRecordCompanionViewAction({
      view: selected,
      action: { type: "pin" },
      page,
    });
    expect(pinned?.pin).toEqual(page.asOf);
    expect(pinned?.selectedSeq).toBe(4);
    const followed = applyRecordCompanionViewAction({
      view: pinned ?? base,
      action: { type: "follow" },
      page,
    });
    expect(followed).toEqual({ ...base, selectedSeq: null });
  });

  it("refuses select of a seq outside the displayed page", () => {
    expect(
      applyRecordCompanionViewAction({ view: base, action: { type: "select", seq: 99 }, page }),
    ).toBeNull();
    const inPage = applyRecordCompanionViewAction({
      view: base,
      action: { type: "select", seq: 2 },
      page,
    });
    expect(inPage?.selectedSeq).toBe(2);
  });

  it("refuses next without a continuation and follow while live", () => {
    const complete = fixturePage({ rows: 3 });
    expect(
      applyRecordCompanionViewAction({ view: base, action: { type: "next" }, page: complete }),
    ).toBeNull();
    expect(
      applyRecordCompanionViewAction({ view: base, action: { type: "follow" }, page }),
    ).toBeNull();
  });

  it("switches tabs only to the other tab", () => {
    expect(
      applyRecordCompanionViewAction({ view: base, action: { type: "tab", tab: "record" }, page }),
    ).toBeNull();
    expect(
      applyRecordCompanionViewAction({
        view: base,
        action: { type: "tab", tab: "decisions" },
        page,
      })?.tab,
    ).toBe("decisions");
  });
});

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

describe("buildRecordCompanionSnapshot", () => {
  it("carries the frozen descriptor, the current view and the exact panel state", () => {
    const page = fixturePage();
    const snapshot = buildRecordCompanionSnapshot({
      companionId: "companion-1",
      scope: SCOPE,
      scopeKey: recordCompanionScopeKey(SCOPE),
      descriptorRevision: 3,
      viewRevision: 5,
      view: { tab: "record", pin: page.asOf, after: null, selectedSeq: 2 },
      panel: { kind: "view", page, staleError: null },
      sourceLabel: "label",
      presentation: { presentationRevision: 9, tokens: NULL_RECORD_COMPANION_TOKENS, dark: true },
    });
    expect(snapshot.descriptorRevision).toBe(3);
    expect(snapshot.viewRevision).toBe(5);
    expect(snapshot.presentationRevision).toBe(9);
    expect(snapshot.theme).toEqual({ dark: true });
    expect(snapshot.tokens).toBe(NULL_RECORD_COMPANION_TOKENS);
    expect(snapshot.result).toEqual({ status: "view", staleError: null, record: page });
  });

  it("relays a quarantined page as the last validated page with its stale error", () => {
    const page = fixturePage();
    const snapshot = buildRecordCompanionSnapshot({
      companionId: "companion-1",
      scope: SCOPE,
      scopeKey: recordCompanionScopeKey(SCOPE),
      descriptorRevision: 0,
      viewRevision: 1,
      view: defaultRecordCompanionView(),
      panel: { kind: "view", page, staleError: "The session head rewound." },
      sourceLabel: "label",
      presentation: { presentationRevision: 0, tokens: NULL_RECORD_COMPANION_TOKENS, dark: false },
    });
    expect(snapshot.result).toEqual({
      status: "view",
      staleError: "The session head rewound.",
      record: page,
    });
  });

  it("maps the non-view panel kinds honestly", () => {
    const common = {
      companionId: "companion-1",
      scope: SCOPE,
      scopeKey: recordCompanionScopeKey(SCOPE),
      descriptorRevision: 0,
      viewRevision: 1,
      view: defaultRecordCompanionView(),
      sourceLabel: "label",
      presentation: { presentationRevision: 0, tokens: NULL_RECORD_COMPANION_TOKENS, dark: false },
    } as const;
    expect(buildRecordCompanionSnapshot({ ...common, panel: { kind: "pending" } }).result).toEqual({
      status: "pending",
    });
    expect(
      buildRecordCompanionSnapshot({ ...common, panel: { kind: "unavailable", reason: "offline" } })
        .result,
    ).toEqual({ status: "unavailable", reason: "offline" });
    expect(
      buildRecordCompanionSnapshot({ ...common, panel: { kind: "unsupported", reason: "old" } })
        .result,
    ).toEqual({ status: "unsupported", reason: "old" });
  });
});

describe("currentRecordCompanionPresentationFacts", () => {
  it("degrades to the schema-safe null token block without a presentation state", () => {
    const facts = currentRecordCompanionPresentationFacts(null);
    expect(facts.presentationRevision).toBe(0);
    expect(facts.tokens).toEqual(NULL_RECORD_COMPANION_TOKENS);
    expect(typeof facts.dark).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Pure equality/descriptor helpers
// ---------------------------------------------------------------------------

describe("descriptor identity helpers", () => {
  it("treats a replaced session or generation as a different descriptor", () => {
    const page = fixturePage();
    const identity = descriptorIdentityOf(page);
    expect(sameDescriptorIdentity(identity, descriptorIdentityOf(fixturePage()))).toBe(true);
    expect(
      sameDescriptorIdentity(
        identity,
        descriptorIdentityOf(fixturePage({ sessionId: "session-2" })),
      ),
    ).toBe(false);
  });

  it("compares reader panels by page identity, not object identity", () => {
    const page = fixturePage();
    expect(sameReaderPanel(null, { kind: "pending" })).toBe(false);
    expect(
      sameReaderPanel(
        { kind: "view", page, staleError: null },
        { kind: "view", page, staleError: null },
      ),
    ).toBe(true);
    expect(
      sameReaderPanel(
        { kind: "view", page, staleError: null },
        { kind: "view", page, staleError: "stale" },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store: entry ownership, observation gating, close-is-closed
// ---------------------------------------------------------------------------

describe("record companion hub store", () => {
  const scopeKey = recordCompanionScopeKey(SCOPE);

  it("keeps exactly one entry per logical scope", () => {
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label-a");
    hub.ensureEntry(SCOPE, "label-b");
    hub.ensureEntry({ ...SCOPE, providerInstanceId: null }, "other");
    const entries = Object.keys(useRecordCompanionHubStore.getState().entries);
    expect(entries).toEqual([
      scopeKey,
      recordCompanionScopeKey({ ...SCOPE, providerInstanceId: null }),
    ]);
  });

  it("gates the query on observation, suppression and closed state", () => {
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    hub.observeDockedSurface(scopeKey, true, true);
    const observed = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(observed !== undefined && entryNeedsQuery(observed)).toBe(true);
    hub.observeDockedSurface(scopeKey, true, false);
    const hidden = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(hidden !== undefined && entryNeedsQuery(hidden)).toBe(false);
    hub.observeDockedSurface(scopeKey, false, false);
    const unobserved = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(unobserved !== undefined && entryNeedsQuery(unobserved)).toBe(false);
  });

  it("bumps the source descriptor only when a validated page changes identity", () => {
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    const pageScopeKey = "page-key";
    hub.setReaderPanel(
      scopeKey,
      { kind: "view", page: fixturePage(), staleError: null },
      pageScopeKey,
    );
    const first = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(first?.descriptorRevision).toBe(0);
    hub.setReaderPanel(
      scopeKey,
      { kind: "view", page: fixturePage(), staleError: null },
      pageScopeKey,
    );
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.descriptorRevision).toBe(0);
    hub.setReaderPanel(
      scopeKey,
      { kind: "view", page: fixturePage({ sessionId: "session-2" }), staleError: null },
      pageScopeKey,
    );
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.descriptorRevision).toBe(1);
  });

  it("applies docked actions through the closed reducer and bumps the view revision", () => {
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    hub.setReaderPanel(
      scopeKey,
      { kind: "view", page: fixturePage({ rows: 4, pageSize: 2 }), staleError: null },
      "page",
    );
    hub.applyDockedAction(scopeKey, { type: "next" });
    const entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.view.after).not.toBeNull();
    expect(entry?.viewRevision).toBe(1);
    // A refused action (select outside the page) changes nothing.
    hub.applyDockedAction(scopeKey, { type: "select", seq: 99 });
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.viewRevision).toBe(1);
  });

  it("treats an unknown-companion relay refusal as CLOSED, never a silent dock", async () => {
    const bridge = makeFakeBridge({
      relay: () =>
        Promise.reject(
          new Error(
            "Record companion registry refused the operation: unknown companion for this owner.",
          ),
        ),
    });
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    await hub.openCompanion(SCOPE, { reopen: false });
    hub.relaySnapshot(
      scopeKey,
      buildRecordCompanionSnapshot({
        companionId: "companion-1",
        scope: SCOPE,
        scopeKey,
        descriptorRevision: 0,
        viewRevision: 0,
        view: defaultRecordCompanionView(),
        panel: { kind: "pending" },
        sourceLabel: "label",
        presentation: {
          presentationRevision: 0,
          tokens: NULL_RECORD_COMPANION_TOKENS,
          dark: false,
        },
      }),
    );
    await vi.waitFor(() => {
      expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.companionClosed).toBe(true);
    });
    const entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.placement).toBeNull();
    expect(entry?.dockedSuppressed).toBe(false);
    expect(entry !== undefined && entryNeedsQuery(entry)).toBe(false);
  });

  it("childReady adopts the registry view, hides the docked view and stages the detach acknowledgement", async () => {
    const bridge = makeFakeBridge();
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    await hub.openCompanion(SCOPE, { reopen: false });
    const restored: RecordCompanionViewPreferences = {
      tab: "decisions",
      pin: null,
      after: null,
      selectedSeq: null,
    };
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "childReady",
      companionId: "companion-1",
      revision: 3,
      handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
      view: restored,
    });
    await Promise.resolve();
    // The acknowledgement is staged, not sent: a store mutation is not a
    // committed-DOM receipt, so the bridge is untouched until dispatch.
    expect(bridge.ackDetach).not.toHaveBeenCalled();
    let entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.dockedSuppressed).toBe(true);
    expect(entry?.pendingAckDetach).toEqual({ companionId: "companion-1", revision: 3 });
    expect(entry?.view).toEqual(restored);
    hub.dispatchPendingAcknowledgement(scopeKey, "detach");
    await vi.waitFor(() => {
      expect(bridge.ackDetach).toHaveBeenCalledWith({ companionId: "companion-1", revision: 3 });
    });
    entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.pendingAckDetach).toBeNull();
    expect(entry?.placement?.placement).toBe("detached");
    expect(entry !== undefined && entryNeedsQuery(entry)).toBe(true);
  });

  it("refuses a childReady whose frozen tuple was never negotiated", async () => {
    const bridge = makeFakeBridge();
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    await hub.openCompanion(SCOPE, { reopen: false });
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "childReady",
      companionId: "companion-1",
      revision: 3,
      handoff: { descriptorRevision: 9, viewRevision: 9, presentationRevision: 9 },
      view: defaultRecordCompanionView(),
    });
    await Promise.resolve();
    expect(bridge.ackDetach).not.toHaveBeenCalled();
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.dockedSuppressed).toBe(false);
  });

  it("childQuiesced stages the dock acknowledgement; only the committed dock renders docked", async () => {
    const bridge = makeFakeBridge();
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    await hub.openCompanion(SCOPE, { reopen: false });
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "childReady",
      companionId: "companion-1",
      revision: 3,
      handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
      view: defaultRecordCompanionView(),
    });
    hub.dispatchPendingAcknowledgement(scopeKey, "detach");
    await vi.waitFor(() => {
      expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.dockedSuppressed).toBe(true);
    });
    const dockView: RecordCompanionViewPreferences = {
      tab: "record",
      pin: null,
      after: null,
      selectedSeq: 3,
    };
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "childQuiesced",
      companionId: "companion-1",
      revision: 6,
      view: dockView,
    });
    await Promise.resolve();
    // Staged, not sent: the dock waits for the prepared docked destination.
    expect(bridge.ackDock).not.toHaveBeenCalled();
    let entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.pendingAckDock).toEqual({ companionId: "companion-1", revision: 6 });
    expect(entry?.dockedPrepared).toBe(false);
    expect(entry?.view).toEqual(dockView);
    hub.setDockedPrepared(scopeKey, true);
    hub.dispatchPendingAcknowledgement(scopeKey, "dock");
    await vi.waitFor(() => {
      expect(bridge.ackDock).toHaveBeenCalledWith({ companionId: "companion-1", revision: 6 });
    });
    await vi.waitFor(() => {
      entry = useRecordCompanionHubStore.getState().entries[scopeKey];
      expect(entry?.dockedSuppressed).toBe(false);
      expect(entry?.companionClosed).toBe(false);
      expect(entry?.placement).toBeNull();
      expect(entry?.view).toEqual(dockView);
    });
  });

  it("applies child view actions only at the current revision and page", async () => {
    const bridge = makeFakeBridge();
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    await hub.openCompanion(SCOPE, { reopen: false });
    const page = fixturePage();
    hub.setReaderPanel(scopeKey, { kind: "view", page, staleError: null }, "page");
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "viewAction",
      companionId: "companion-1",
      scopeKey,
      viewRevision: 0,
      action: { type: "select", seq: 2 },
    });
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.view.selectedSeq).toBe(2);
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "viewAction",
      companionId: "companion-1",
      scopeKey,
      viewRevision: 0,
      action: { type: "select", seq: 3 },
    });
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.view.selectedSeq).toBe(2);
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "viewAction",
      companionId: "companion-1",
      scopeKey,
      viewRevision: 99,
      action: { type: "tab", tab: "decisions" },
    });
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.view.tab).toBe("record");
  });

  it("a canonical closed state closes the scope; a docked state returns the reader", async () => {
    const bridge = makeFakeBridge();
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    const hub = useRecordCompanionHubStore.getState();
    hub.ensureEntry(SCOPE, "label");
    await hub.openCompanion(SCOPE, { reopen: false });
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "state",
      state: placementState({ placement: "closed", revision: 5 }),
    });
    let entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.companionClosed).toBe(true);
    expect(entry !== undefined && entryNeedsQuery(entry)).toBe(false);
    // The explicit reopen leaves the closed state (interactive until ready).
    await hub.openCompanion(SCOPE, { reopen: true });
    entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.companionClosed).toBe(false);
    // A failed opening (or dock commit) publishes docked: interactive again.
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "state",
      state: placementState({ placement: "docked", revision: 6 }),
    });
    entry = useRecordCompanionHubStore.getState().entries[scopeKey];
    expect(entry?.companionClosed).toBe(false);
    expect(entry?.dockedSuppressed).toBe(false);
    expect(entry?.placement).toBeNull();
  });

  it("surfaces a conflicting open result as a visible message", async () => {
    const bridge = makeFakeBridge({
      open: async () =>
        ({
          type: "conflict",
          message: "Another record companion is already open.",
          existing: placementState({ scope: { ...SCOPE, threadId: ThreadId.make("other") } }),
        }) as const,
    });
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    await useRecordCompanionHubStore.getState().openCompanion(SCOPE, { reopen: false });
    expect(useRecordCompanionHubStore.getState().entries[scopeKey]?.conflictMessage).toContain(
      "Another record companion",
    );
  });
});

describe("placementNeedsReader", () => {
  it("needs the reader while opening, detached or docking, not while closed or docked", () => {
    expect(placementNeedsReader("opening")).toBe(true);
    expect(placementNeedsReader("detached")).toBe(true);
    expect(placementNeedsReader("docking")).toBe(true);
    expect(placementNeedsReader("closed")).toBe(false);
    expect(placementNeedsReader("docked")).toBe(false);
  });
});

it("primary review: explicit reopen cannot query a default view before persisted preferences arrive", async () => {
  const bridge = makeFakeBridge();
  vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
  const hub = useRecordCompanionHubStore.getState();
  const key = recordCompanionScopeKey(SCOPE);
  hub.ensureEntry(SCOPE, "label");
  hub.handleOwnerEvent({ type: "state", state: placementState({ placement: "closed" }) });
  await hub.openCompanion(SCOPE, { reopen: true });
  const opening = useRecordCompanionHubStore.getState().entries[key]!;
  expect(entryNeedsQuery(opening)).toBe(false);
  const restored = { tab: "record" as const, pin: fixturePage().asOf, after: null, selectedSeq: 3 };
  hub.handleOwnerEvent({
    type: "childReady",
    companionId: "companion-1",
    revision: 3,
    handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
    view: restored,
  });
  const ready = useRecordCompanionHubStore.getState().entries[key]!;
  expect(ready.view).toEqual(restored);
  expect(entryNeedsQuery(ready)).toBe(true);
});

it("primary review: revealing an existing detached companion preserves its acknowledged handoff", async () => {
  let calls = 0;
  const bridge = makeFakeBridge({
    open: async () => ({
      type: "opening",
      companionId: "companion-1",
      state: placementState({
        placement: ++calls === 1 ? "opening" : "detached",
        revision: calls === 1 ? 2 : 4,
      }),
    }),
  });
  vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
  const hub = useRecordCompanionHubStore.getState();
  const key = recordCompanionScopeKey(SCOPE);
  hub.ensureEntry(SCOPE, "label");
  await hub.openCompanion(SCOPE, { reopen: false });
  hub.handleOwnerEvent({
    type: "childReady",
    companionId: "companion-1",
    revision: 3,
    handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
    view: defaultRecordCompanionView(),
  });
  hub.dispatchPendingAcknowledgement(key, "detach");
  await vi.waitFor(() =>
    expect(useRecordCompanionHubStore.getState().entries[key]?.placement?.placement).toBe(
      "detached",
    ),
  );
  const before = useRecordCompanionHubStore.getState().entries[key]!;
  await hub.openCompanion(SCOPE, { reopen: false });
  const after = useRecordCompanionHubStore.getState().entries[key]!;
  expect(after.dockedSuppressed).toBe(true);
  expect(after.handoff).toEqual(before.handoff);
  expect(after.view).toEqual(before.view);
});
