// @vitest-environment jsdom
import * as NodeCrypto from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RecordCompanionBootstrap,
  RecordCompanionBridge,
  RecordCompanionChildEvent,
  RecordCompanionSnapshot,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { RecordCompanionWindow } from "./RecordCompanionWindow";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const OPENING_HANDOFF = { descriptorRevision: 0, viewRevision: 2, presentationRevision: 4 };
const DOCKING_HANDOFF = { descriptorRevision: 1, viewRevision: 6, presentationRevision: 4 };

function fixturePage(): any {
  const rows: any[] = [];
  let prevHash = "0".repeat(64);
  for (let seq = 1; seq <= 2; seq += 1) {
    const unsigned = {
      kind: "observe" as const,
      name: `test/source#${seq}`,
      payload: { seq },
      prev_hash: prevHash,
      seq,
      ts: "2026-10-02T00:00:00.000Z",
    };
    const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    rows.push({ ...unsigned, hash });
    prevHash = hash;
  }
  const asOf = { sessionId: "s-1", seq: 2, hash: rows[1].hash, generation: "a".repeat(64) };
  return {
    version: 1,
    state: "available",
    sessionCursor: asOf,
    gatewayCursor: { seq: 0, hash: "0".repeat(64), generation: "0".repeat(64) },
    asOf,
    records: rows,
    next: null,
    total: 2,
    hasMore: false,
    decisions: { status: "unsupported", reason: "checkpoint authority absent" },
  };
}

function bootstrapReceipt(overrides?: {
  revision?: number;
  handoff?: RecordCompanionBootstrap["handoff"];
  omitHandshake?: boolean;
}): RecordCompanionBootstrap {
  return {
    companionId: COMPANION_ID,
    scope: {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: null,
    },
    scopeKey: '["env-1","thread-1",null]',
    view: { tab: "record", pin: null, after: null, selectedSeq: null },
    placement: "opening",
    sourceLabel: "env env-1 · thread thread-1 · instance unbound",
    ...(overrides?.omitHandshake
      ? {}
      : { revision: overrides?.revision ?? 2, handoff: overrides?.handoff ?? OPENING_HANDOFF }),
  } as RecordCompanionBootstrap;
}

function snapshotOf(viewRevision: number): RecordCompanionSnapshot {
  return {
    companionId: COMPANION_ID,
    scope: bootstrapReceipt().scope,
    scopeKey: '["env-1","thread-1",null]',
    descriptorRevision: OPENING_HANDOFF.descriptorRevision,
    viewRevision,
    presentationRevision: OPENING_HANDOFF.presentationRevision,
    view: { tab: "record", pin: null, after: null, selectedSeq: null },
    result: { status: "view", staleError: null, record: fixturePage() },
    sourceLabel: "env env-1 · thread thread-1 · instance unbound",
    theme: { dark: true },
    tokens: {
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
    },
  } as unknown as RecordCompanionSnapshot;
}

type FakeChildBridge = RecordCompanionBridge & {
  readonly emit: (event: RecordCompanionChildEvent) => void;
  /** DOM receipt observed at quiesce callback time. */
  readonly quiesceDomReceipt: {
    tabDisabled: boolean;
    pinDisabled: boolean;
    firstDisabled: boolean;
  };
};

function makeFakeBridge(bootstrap: () => Promise<RecordCompanionBootstrap>): FakeChildBridge {
  const listeners = new Set<(event: RecordCompanionChildEvent) => void>();
  // The quiesce acknowledgement must see the committed inert DOM: every view
  // control disabled at the exact moment quiesce leaves the renderer.
  const quiesceDomReceipt = { tabDisabled: false, pinDisabled: false, firstDisabled: false };
  return {
    bootstrap: vi.fn(bootstrap),
    ready: vi.fn(async () => undefined),
    quiesce: vi.fn(async () => {
      quiesceDomReceipt.tabDisabled =
        document.querySelector("[data-record-tab-trigger]")?.hasAttribute("disabled") ?? false;
      quiesceDomReceipt.pinDisabled =
        document.querySelector("[data-record-pin-toggle]")?.hasAttribute("disabled") ?? false;
      quiesceDomReceipt.firstDisabled =
        document.querySelector("[data-record-first-page]")?.hasAttribute("disabled") ?? false;
      return undefined;
    }),
    requestDock: vi.fn(async () => undefined),
    viewAction: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: RecordCompanionChildEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    quiesceDomReceipt,
  } as FakeChildBridge;
}

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

function mountChild(bridge: FakeChildBridge): HTMLDivElement {
  vi.stubGlobal("recordCompanion", bridge);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  void act(() => {
    root!.render(<RecordCompanionWindow />);
  });
  return container;
}

it("acknowledges the original Opening frozen tuple with ready and stays inert", async () => {
  const bridge = makeFakeBridge(async () => bootstrapReceipt());
  const container = mountChild(bridge);
  await act(async () => {});
  expect(bridge.ready).toHaveBeenCalledWith({
    companionId: COMPANION_ID,
    revision: 2,
    handoff: OPENING_HANDOFF,
  });
  expect(bridge.ready).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-companion-preparing]")?.textContent).toContain("preparing");
  // Inert: controls disabled before activation even with a snapshot rendered.
  bridge.emit({ type: "snapshot", snapshot: snapshotOf(2) });
  await act(async () => {});
  expect(container.querySelector("[data-record-tab-trigger]")?.hasAttribute("disabled")).toBe(true);
  expect(bridge.viewAction).not.toHaveBeenCalled();
});

it("activates on the activated event and refetches bootstrap for the dock revision", async () => {
  const bootstrapCalls: number[] = [];
  const bridge = makeFakeBridge(async () => {
    const receipt = bootstrapReceipt();
    bootstrapCalls.push(receipt.revision ?? -1);
    return receipt;
  });
  const container = mountChild(bridge);
  await act(async () => {});
  bridge.emit({ type: "activated" });
  await act(async () => {});
  expect(container.querySelector("[data-companion-dock]")).not.toBeNull();
  // The activation refetch happened (bootstrap revision read again).
  expect(bootstrapCalls.length).toBeGreaterThanOrEqual(2);
});

it("expresses child actions against the displayed snapshot's view revision only", async () => {
  const bridge = makeFakeBridge(async () => bootstrapReceipt());
  const container = mountChild(bridge);
  await act(async () => {});
  bridge.emit({ type: "snapshot", snapshot: snapshotOf(5) });
  bridge.emit({ type: "activated" });
  await act(async () => {});
  act(() => {
    (container.querySelector('[data-record-seq="2"]') as HTMLButtonElement).click();
  });
  expect(bridge.viewAction).toHaveBeenCalledWith({
    companionId: COMPANION_ID,
    viewRevision: 5,
    action: { type: "select", seq: 2 },
  });
});

it("docks through the CURRENT frozen tuple: docking refetch feeds quiesce", async () => {
  let revision = 2;
  const bridge = makeFakeBridge(async () =>
    bootstrapReceipt({ revision, handoff: revision >= 5 ? DOCKING_HANDOFF : OPENING_HANDOFF }),
  );
  const container = mountChild(bridge);
  await act(async () => {});
  bridge.emit({ type: "snapshot", snapshot: snapshotOf(2) });
  bridge.emit({ type: "activated" });
  await act(async () => {});
  // The activation refetch observed revision 2; the machine advanced since.
  revision = 5;
  act(() => {
    (container.querySelector("[data-companion-dock]") as HTMLButtonElement).click();
  });
  await act(async () => {});
  expect(bridge.requestDock).toHaveBeenCalledWith({ companionId: COMPANION_ID, revision: 2 });
  bridge.emit({ type: "docking", handoff: DOCKING_HANDOFF });
  await act(async () => {});
  // quiesce acknowledges the refreshed DOCKING bootstrap: revision 5 and the
  // docking tuple, never the Opening tuple.
  expect(bridge.quiesce).toHaveBeenCalledWith({
    companionId: COMPANION_ID,
    revision: 5,
    handoff: DOCKING_HANDOFF,
  });
  // DOM receipt at quiesce time: the committed child view is inert.
  expect(bridge.quiesceDomReceipt.tabDisabled).toBe(true);
  expect(bridge.quiesceDomReceipt.pinDisabled).toBe(true);
  expect(bridge.quiesceDomReceipt.firstDisabled).toBe(true);
  expect(container.querySelector("[data-companion-docking-guidance]")?.textContent).toContain(
    "original Record panel",
  );
  expect(container.querySelector("[data-companion-docking]")?.textContent).toContain("docking");
  bridge.emit({ type: "closed" });
  await act(async () => {});
  expect(
    container
      .querySelector("[data-record-companion-window]")
      ?.getAttribute("data-record-companion-window"),
  ).toBe("closed");
});

it("refuses to acknowledge a bootstrap without the exact handshake tuple", async () => {
  const bridge = makeFakeBridge(async () => bootstrapReceipt({ omitHandshake: true }));
  const container = mountChild(bridge);
  await act(async () => {});
  expect(bridge.ready).not.toHaveBeenCalled();
  expect(container.textContent).toContain("refusing to acknowledge the handoff");
});

it("fails honestly when no restricted bridge exists", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RecordCompanionWindow />);
  });
  expect(container.textContent).toContain("no record companion bridge");
});

it("applies the snapshot's resolved theme to the document", async () => {
  const bridge = makeFakeBridge(async () => bootstrapReceipt());
  const container = mountChild(bridge);
  await act(async () => {});
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  bridge.emit({ type: "snapshot", snapshot: snapshotOf(2) });
  await act(async () => {});
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
