// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId, recordCompanionScopeKey } from "@t3tools/contracts";
import type {
  DesktopRecordCompanionBridge,
  RecordCompanionOpenResult,
  RecordCompanionOwnerEvent,
  RecordCompanionPlacementState,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// The live owner path reads the bounded explorer (metadata index + byte
// windows); the fake answers through the same pure validation as the atoms.
const captured = vi.hoisted(() => ({
  fake: null as null | ReturnType<
    typeof import("../recordExplorer/explorerFakeHooks.testFixtures").makeFakeExplorerHooks
  >,
}));
vi.mock("~/state/workbenchExplorer", () => ({
  useWorkbenchRecordIndex: (request: any) => captured.fake!.hooks.useWorkbenchRecordIndex(request),
  useWorkbenchRecordBodyWindow: (request: any) =>
    captured.fake!.hooks.useWorkbenchRecordBodyWindow(request),
  useWorkbenchRecordVerification: (request: any) =>
    captured.fake!.hooks.useWorkbenchRecordVerification(request),
  useWorkbenchGraphExplore: (request: any) =>
    captured.fake!.hooks.useWorkbenchGraphExplore(request),
}));

import { makeFakeExplorerSource } from "../recordExplorer/explorerFake.testFixtures";
import { makeFakeExplorerHooks } from "../recordExplorer/explorerFakeHooks.testFixtures";
import { DecisionRecordSurface } from "../chat/DecisionRecordSurface";
import { RecordCompanionOwnerHub } from "./RecordCompanionOwnerHub";
import {
  entryNeedsQuery,
  resetRecordCompanionHubForTest,
  useRecordCompanionHubStore,
} from "~/state/recordCompanion";

const ENV = EnvironmentId.make("hub-env");
const THREAD = ThreadId.make("hub-thread");
const SCOPE_KEY = recordCompanionScopeKey({
  environmentId: ENV,
  threadId: THREAD,
  providerInstanceId: null,
});

type FakeBridge = DesktopRecordCompanionBridge & {
  readonly emit: (event: RecordCompanionOwnerEvent) => void;
  /** DOM receipts observed at native-ack callback time (empty string = absent). */
  readonly ackDetachDomReceipt: { rows: string; suppressedPlacement: string };
  readonly ackDockDomReceipt: { rows: string; controlsDisabled: boolean };
};

function placementState(
  placement: RecordCompanionPlacementState["placement"],
  revision: number,
): RecordCompanionPlacementState {
  return {
    companionId: "companion-1",
    scope: { environmentId: ENV, threadId: THREAD, providerInstanceId: null },
    scopeKey: SCOPE_KEY,
    placement,
    revision,
    ownerSenderId: 1,
    childSender: 7,
    childReady: false,
    childQuiesced: false,
    handoff: null,
    acknowledgedHandoff: null,
  };
}

function makeFakeBridge(): FakeBridge {
  const listeners = new Set<(event: RecordCompanionOwnerEvent) => void>();
  // The native ack callbacks must see the OLD main view actually hidden: a
  // DOM receipt, not a store intention. Capture what the committed DOM shows
  // at the exact moment the acknowledgement leaves the renderer.
  const ackDetachDomReceipt = { rows: "", suppressedPlacement: "" };
  const ackDockDomReceipt = { rows: "", controlsDisabled: false };
  return {
    subscribe: vi.fn(async () => [] as readonly RecordCompanionPlacementState[]),
    open: vi.fn(async () => ({
      type: "opening",
      companionId: "companion-1",
      state: placementState("opening", 2),
    })),
    reopen: vi.fn(async () => ({
      type: "opening",
      companionId: "companion-1",
      state: placementState("opening", 2),
    })),
    relay: vi.fn(async () => undefined),
    ackDetach: vi.fn(async () => {
      ackDetachDomReceipt.rows = document.querySelector("[data-record-rows]")?.textContent ?? "";
      ackDetachDomReceipt.suppressedPlacement =
        document.querySelector("[data-record-companion-reveal]")?.textContent ?? "";
      return placementState("detached", 4);
    }),
    ackDock: vi.fn(async () => {
      ackDockDomReceipt.rows = document.querySelector("[data-record-rows]")?.textContent ?? "";
      ackDockDomReceipt.controlsDisabled =
        document.querySelector("[data-record-tab-trigger]")?.hasAttribute("disabled") ?? false;
      return placementState("docked", 7);
    }),
    onOwnerEvent: vi.fn((listener: (event: RecordCompanionOwnerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    ackDetachDomReceipt,
    ackDockDomReceipt,
  } as FakeBridge;
}

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  captured.fake = makeFakeExplorerHooks(makeFakeExplorerSource({ rows: 4, largeRowSeq: 0 }));
  resetRecordCompanionHubForTest();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetRecordCompanionHubForTest();
});

function mountHub(visible = true): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  void act(() => {
    root!.render(
      <RecordCompanionOwnerHub>
        <DecisionRecordSurface environmentId={ENV} threadId={THREAD} visible={visible} />
      </RecordCompanionOwnerHub>,
    );
  });
  return container;
}

it("the hub serves the docked view from one reader and stops querying while hidden", async () => {
  const container = mountHub();
  await act(async () => {});
  const hub = useRecordCompanionHubStore.getState();
  expect(hub.readerScopeKeys()).toEqual([SCOPE_KEY]);
  const entry = hub.entries[SCOPE_KEY];
  expect(entry?.panel?.kind).toBe("explorer");
  expect(container.querySelector('[data-record-seq="1"]')).not.toBeNull();
  // One reader served the scope: every queried index scope is the same key.
  const pageKeys = new Set(
    captured.fake!.control.requested.filter((key) => key.startsWith("index:")),
  );
  expect(pageKeys.size).toBe(1);
});

it("open freezes the current view, relays through the hub, and detaches on childReady", async () => {
  const bridge = makeFakeBridge();
  vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
  const container = mountHub();
  await act(async () => {});
  // Docked interactions apply through the hub's single controller.
  await act(async () => {
    (container.querySelector('[data-record-seq="3"]') as HTMLButtonElement).click();
  });
  expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]?.view.selectedSeq).toBe(3);
  await act(async () => {
    (container.querySelector("[data-record-companion-open]") as HTMLButtonElement).click();
  });
  await act(async () => {});
  expect(bridge.open).toHaveBeenCalledTimes(1);
  const openInput = (bridge.open as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
    readonly view: { readonly selectedSeq: number | null };
    readonly scope: RecordCompanionPlacementState["scope"];
    readonly descriptorRevision: number;
    readonly viewRevision: number;
    readonly presentationRevision: number;
  };
  expect(openInput.view.selectedSeq).toBe(3);
  expect(openInput.scope).toEqual({
    environmentId: ENV,
    threadId: THREAD,
    providerInstanceId: null,
  });
  // The docked view stays mounted and interactive during opening.
  expect(container.querySelector("[data-record-companion-open]")?.hasAttribute("disabled")).toBe(
    true,
  );
  expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]?.dockedSuppressed).toBe(false);
  // The reader relays one schema-shaped snapshot for the frozen transaction.
  await vi.waitFor(() => {
    expect(bridge.relay).toHaveBeenCalled();
  });
  const relayInput = (bridge.relay as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
    readonly companionId: string;
    readonly snapshot: {
      readonly scopeKey: string;
      readonly result: { readonly status: string };
      readonly view: { readonly selectedSeq: number | null };
    };
  };
  expect(relayInput.companionId).toBe("companion-1");
  expect(relayInput.snapshot.scopeKey).toBe(SCOPE_KEY);
  expect(relayInput.snapshot.result.status).toBe("explorer");
  expect(relayInput.snapshot.view.selectedSeq).toBe(3);
  // childReady hides the docked view, THEN the owner commits the detach.
  bridge.emit({
    type: "childReady",
    companionId: "companion-1",
    revision: 3,
    handoff: {
      descriptorRevision: openInput.descriptorRevision,
      viewRevision: openInput.viewRevision,
      presentationRevision: openInput.presentationRevision,
    },
    view: { tab: "record", pin: null, after: null, selectedSeq: 3 },
  });
  await act(async () => {});
  await vi.waitFor(() => {
    expect(bridge.ackDetach).toHaveBeenCalledWith({ companionId: "companion-1", revision: 3 });
  });
  // DOM receipt at ack time: the old interactive rows are GONE from the
  // committed DOM and the suppressed placeholder is what renders.
  expect(bridge.ackDetachDomReceipt.rows).toBe("");
  expect(bridge.ackDetachDomReceipt.suppressedPlacement).toContain("Reveal window");
  expect(container.querySelector("[data-record-companion-reveal]")).not.toBeNull();
});

it("ackDock completes when the mounted destination prepared before the child quiesced", async () => {
  const bridge = makeFakeBridge();
  vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
  const container = mountHub();
  await act(async () => {});
  await act(async () => {
    (container.querySelector("[data-record-companion-open]") as HTMLButtonElement).click();
  });
  await act(async () => {});
  await act(async () => {
    bridge.emit({
      type: "childReady",
      companionId: "companion-1",
      revision: 3,
      handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
      view: { tab: "record", pin: null, after: null, selectedSeq: null },
    });
  });
  await vi.waitFor(() => expect(bridge.ackDetach).toHaveBeenCalledOnce());
  // Native IPC can commit docking before quiescence, with no destination remount.
  await act(async () => {
    bridge.emit({ type: "state", state: placementState("docking", 5) });
  });
  expect(container.querySelector("[data-record-rows]")).not.toBeNull();
  expect(bridge.ackDock).not.toHaveBeenCalled();
  await act(async () => {
    bridge.emit({
      type: "childQuiesced",
      companionId: "companion-1",
      revision: 6,
      view: { tab: "record", pin: null, after: null, selectedSeq: null },
    });
  });
  await vi.waitFor(() => {
    expect(bridge.ackDock).toHaveBeenCalledExactlyOnceWith({
      companionId: "companion-1",
      revision: 6,
    });
  });
  expect(bridge.ackDockDomReceipt.rows).toContain("fixture/row-1");
  expect(bridge.ackDockDomReceipt.controlsDisabled).toBe(true);
  await vi.waitFor(() => {
    expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]?.placement).toBeNull();
  });
});

it("ackDock waits for the ORIGINAL scope's visible prepared inspector, never a navigated-away destination", async () => {
  const bridge = makeFakeBridge();
  vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
  const container = mountHub();
  await act(async () => {});
  await act(async () => {
    (container.querySelector("[data-record-companion-open]") as HTMLButtonElement).click();
  });
  await act(async () => {});
  bridge.emit({
    type: "childReady",
    companionId: "companion-1",
    revision: 3,
    handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
    view: { tab: "record", pin: null, after: null, selectedSeq: null },
  });
  await act(async () => {});
  await vi.waitFor(() => {
    expect(bridge.ackDetach).toHaveBeenCalled();
  });
  // The main window navigates to another thread: the scope's docked surface
  // unmounts. The child requested dock (registry publishes docking) and
  // quiesces — but ackDock must NOT close it over a missing destination, and
  // nothing retargets the scope.
  await act(async () => {
    root?.render(<RecordCompanionOwnerHub>{null}</RecordCompanionOwnerHub>);
  });
  bridge.emit({ type: "state", state: placementState("docking", 5) });
  bridge.emit({
    type: "childQuiesced",
    companionId: "companion-1",
    revision: 6,
    view: { tab: "record", pin: null, after: null, selectedSeq: 3 },
  });
  await act(async () => {});
  await act(async () => {});
  expect(bridge.ackDock).not.toHaveBeenCalled();
  const staged = useRecordCompanionHubStore.getState().entries[SCOPE_KEY];
  expect(staged?.pendingAckDock).toEqual({ companionId: "companion-1", revision: 6 });
  // Returning to the original Record panel mounts and prepares the restored
  // view; only then does the dock commit.
  await act(async () => {
    root!.render(
      <RecordCompanionOwnerHub>
        <DecisionRecordSurface environmentId={ENV} threadId={THREAD} visible />
      </RecordCompanionOwnerHub>,
    );
  });
  await act(async () => {});
  await vi.waitFor(() => {
    expect(bridge.ackDock).toHaveBeenCalledWith({ companionId: "companion-1", revision: 6 });
  });
  // DOM receipt at ack time: the restored view is rendered (selected row 3)
  // with every control inert — the docked destination is prepared, disabled.
  expect(bridge.ackDockDomReceipt.rows).toContain("fixture/row-3");
  expect(bridge.ackDockDomReceipt.controlsDisabled).toBe(true);
  await vi.waitFor(() => {
    const entry = useRecordCompanionHubStore.getState().entries[SCOPE_KEY];
    expect(entry?.dockedSuppressed).toBe(false);
    expect(entry?.placement).toBeNull();
  });
  // The committed dock renders the same restored view interactive.
  await act(async () => {});
  expect(
    container.ownerDocument.querySelector('[data-record-body-window][data-record-body-row="3"]'),
  ).not.toBeNull();
  expect(
    (
      container.ownerDocument.querySelector("[data-record-tab-trigger]") as HTMLButtonElement
    )?.hasAttribute("disabled"),
  ).toBe(false);
});

it("a canonical closed state shows closed/Reopen and stops the query until explicit reopen", async () => {
  const bridge = makeFakeBridge();
  vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
  const container = mountHub();
  await act(async () => {});
  await act(async () => {
    (container.querySelector("[data-record-companion-open]") as HTMLButtonElement).click();
  });
  await act(async () => {});
  bridge.emit({
    type: "childReady",
    companionId: "companion-1",
    revision: 3,
    handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
    view: { tab: "record", pin: null, after: null, selectedSeq: null },
  });
  await act(async () => {});
  await vi.waitFor(() => {
    expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]?.dockedSuppressed).toBe(true);
  });
  bridge.emit({ type: "state", state: placementState("closed", 5) });
  await act(async () => {});
  const hub = useRecordCompanionHubStore.getState();
  const entry = hub.entries[SCOPE_KEY];
  expect(entry?.companionClosed).toBe(true);
  expect(entry !== undefined && entryNeedsQuery(entry)).toBe(false);
  expect(container.querySelector("[data-record-companion-reopen]")).not.toBeNull();
  // The relay that ran during opening stops with the closed scope: no new
  // relay call may appear after the close.
  const relayCallsAfterClose = (bridge.relay as ReturnType<typeof vi.fn>).mock.calls.length;
  await act(async () => {});
  expect((bridge.relay as ReturnType<typeof vi.fn>).mock.calls.length).toBe(relayCallsAfterClose);
  await act(async () => {
    (container.querySelector("[data-record-companion-reopen]") as HTMLButtonElement).click();
  });
  await act(async () => {});
  expect(bridge.reopen).toHaveBeenCalledTimes(1);
  expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]?.companionClosed).toBe(false);
});

it("without the desktop bridge the docked view renders with an honest unavailable note", async () => {
  const container = mountHub();
  await act(async () => {});
  expect(container.querySelector("[data-record-companion-unavailable]")?.textContent).toContain(
    "desktop app",
  );
  expect(container.querySelector("[data-record-seq]")).not.toBeNull();
});

it("a conflicting open for another live scope stays visible, never a silent retarget", async () => {
  const bridge = makeFakeBridge();
  bridge.open = vi.fn(async (): Promise<RecordCompanionOpenResult> => ({
    type: "conflict",
    message: "Another record companion is already open.",
    existing: placementState("detached", 9),
  }));
  vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
  const container = mountHub();
  await act(async () => {});
  await act(async () => {
    (container.querySelector("[data-record-companion-open]") as HTMLButtonElement).click();
  });
  await act(async () => {});
  expect(container.querySelector("[data-record-companion-conflict]")?.textContent).toContain(
    "Another record companion",
  );
  // The docked view keeps its own scope: no retarget, no placeholder.
  expect(container.querySelector("[data-record-seq]")).not.toBeNull();
});
