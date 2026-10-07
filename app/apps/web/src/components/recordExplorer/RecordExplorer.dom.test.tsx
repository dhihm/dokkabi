// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProviderInstanceId,
  RecordCompanionSnapshot,
  ThreadId,
  WORKBENCH_RECORD_BODY_MAX_BYTES,
  recordCompanionScopeKey,
  type DesktopRecordCompanionBridge,
  type RecordCompanionOwnerEvent,
  type RecordCompanionPlacementState,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  current: null as null | ReturnType<
    typeof import("./explorerFakeHooks.testFixtures").makeFakeExplorerHooks
  >,
  oldReads: 0,
}));
vi.mock("~/state/workbenchExplorer", () => ({
  useWorkbenchRecordIndex: (request: any) => fake.current!.hooks.useWorkbenchRecordIndex(request),
  useWorkbenchRecordBodyWindow: (request: any) =>
    fake.current!.hooks.useWorkbenchRecordBodyWindow(request),
  useWorkbenchRecordVerification: (request: any) =>
    fake.current!.hooks.useWorkbenchRecordVerification(request),
  useWorkbenchGraphExplore: (request: any) => fake.current!.hooks.useWorkbenchGraphExplore(request),
}));
// The old whole-row page path must never serve the live owner.
vi.mock("~/state/workbenchRecord", async () => {
  const original = await vi.importActual<any>("~/state/workbenchRecord");
  return {
    ...original,
    workbenchRecordAtomFor: () => {
      fake.oldReads += 1;
      return null;
    },
  };
});
vi.mock("~/state/query", async () => {
  const original = await vi.importActual<any>("~/state/query");
  return {
    ...original,
    useEnvironmentQuery: () => ({
      data: null,
      dataUpdatedAt: null,
      error: "The requested page contains a row beyond the 65536-byte exact row bound.",
      isPending: false,
      isSuccess: false,
      refresh: () => {},
    }),
  };
});

import { makeFakeExplorerSource } from "./explorerFake.testFixtures";
import { makeFakeExplorerHooks } from "./explorerFakeHooks.testFixtures";
import { DecisionRecordSurface } from "../chat/DecisionRecordSurface";
import { RecordCompanionOwnerHub } from "../recordCompanion/RecordCompanionOwnerHub";
import {
  resetRecordCompanionHubForTest,
  useRecordCompanionHubStore,
} from "~/state/recordCompanion";

const ENV = EnvironmentId.make("explorer-env");
const THREAD = ThreadId.make("explorer-thread");
const INSTANCE = ProviderInstanceId.make("explorer-instance");
const SCOPE_KEY = recordCompanionScopeKey({
  environmentId: ENV,
  threadId: THREAD,
  providerInstanceId: INSTANCE,
});

let root: Root | null = null;
let container: HTMLDivElement;

let windowFocused = true;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The owning main window is the focused, visible presentation.
  windowFocused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
  fake.current = makeFakeExplorerHooks(makeFakeExplorerSource());
  fake.oldReads = 0;
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

async function mount(threadId: ThreadId = THREAD) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RecordCompanionOwnerHub>
        <DecisionRecordSurface
          environmentId={ENV}
          threadId={threadId}
          providerInstanceId={INSTANCE}
          visible
        />
      </RecordCompanionOwnerHub>,
    );
  });
  await act(async () => {});
}

const q = (selector: string) => container.querySelector(selector);
async function click(selector: string) {
  const element = q(selector) as HTMLButtonElement | null;
  expect(element, selector).not.toBeNull();
  expect(element!.disabled, `${selector} disabled`).toBe(false);
  await act(async () => element!.click());
  await act(async () => {});
}
const reads = (method: string) =>
  fake.current!.source.reads.filter((read) => read.method === method);
const rowSeqs = () =>
  [...container.querySelectorAll("[data-record-seq]")].map((element) =>
    Number(element.getAttribute("data-record-seq")),
  );
const bodyText = () => q("[data-record-body-window]")?.textContent ?? "";

describe("bounded record explorer (live owner path)", () => {
  it("pages metadata past a 2.6MB row with a stable pin and reads no body until a row is selected", async () => {
    await mount();
    expect(fake.oldReads).toBe(0);
    expect(rowSeqs()).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(reads("index").every((read) => read.limit === 50)).toBe(true);
    await click("[data-record-next-page]");
    expect(rowSeqs()).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
    // The wide name is labeled as a display excerpt, never as the exact value.
    expect(q('[data-record-seq="61"] [data-record-name-excerpt]')).not.toBeNull();
    // A later append does not move the pinned pages.
    fake.current!.source.append();
    await act(async () => fake.current!.control.poll());
    await click("[data-record-next-page]");
    expect(rowSeqs()).toEqual(Array.from({ length: 30 }, (_, index) => index + 101));
    expect(q("[data-record-index-summary]")?.textContent).toContain("130");
    expect(reads("body")).toHaveLength(0);
    expect(q("[data-record-body-window]")).toBeNull();
  });

  it("shows bounded byte windows of the 2.6MB row with exact offsets, navigation and Unicode", async () => {
    await mount();
    await click("[data-record-next-page]");
    await click('[data-record-seq="60"]');
    const total = fake.current!.source.rows[59]!.bytes.length;
    expect(reads("body")).toHaveLength(1);
    expect(reads("body")[0]!.offset).toBe(0);
    expect(reads("body")[0]!.limit).toBeLessThanOrEqual(WORKBENCH_RECORD_BODY_MAX_BYTES);
    const window = q("[data-record-body-window]")!;
    expect(window.getAttribute("data-record-body-total")).toBe(String(total));
    expect(q("[data-record-body-summary]")?.textContent).toContain(String(total));
    expect(q("[data-record-body-summary]")?.textContent).toContain(
      fake.current!.source.rows[59]!.descriptor.bodyDigest.slice(0, 12),
    );
    expect(q("[data-record-body-flags]")?.textContent).toContain("partial");
    expect(bodyText().length).toBeLessThanOrEqual(WORKBENCH_RECORD_BODY_MAX_BYTES);
    const firstEnd = Number(window.getAttribute("data-record-body-end"));
    await click("[data-record-body-next]");
    expect(Number(q("[data-record-body-window]")!.getAttribute("data-record-body-start"))).toBe(
      firstEnd,
    );
    // Jump to an arbitrary byte that may split a character.
    const jump = q("[data-record-body-jump-input]") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(jump, "1300001");
      jump.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("[data-record-body-jump]");
    const jumped = q("[data-record-body-window]")!;
    const start = Number(jumped.getAttribute("data-record-body-start"));
    expect(start).toBeLessThanOrEqual(1_300_001);
    expect(1_300_001 - start).toBeLessThanOrEqual(3);
    expect(bodyText()).not.toContain("�");
    await click("[data-record-body-previous]");
    expect(Number(q("[data-record-body-window]")!.getAttribute("data-record-body-end"))).toBe(
      start,
    );
    await click("[data-record-body-last]");
    expect(Number(q("[data-record-body-window]")!.getAttribute("data-record-body-end"))).toBe(
      total,
    );
    for (const read of reads("body")) {
      expect(read.limit).toBeLessThanOrEqual(WORKBENCH_RECORD_BODY_MAX_BYTES);
    }
    // Only the displayed window is retained: no concatenated full buffer.
    expect(container.textContent!.length).toBeLessThan(
      2 * WORKBENCH_RECORD_BODY_MAX_BYTES + 60_000,
    );
    expect(reads("verify")).toHaveLength(0);
  });

  it("cancels an obsolete in-flight range when the selection changes", async () => {
    await mount();
    fake.current!.control.deferred = true;
    await click('[data-record-seq="3"]');
    expect(q("[data-record-body-pending]")).not.toBeNull();
    await click('[data-record-seq="4"]');
    expect(fake.current!.control.cancelled.some((key) => key.includes('"seq":3'))).toBe(true);
    await act(async () => fake.current!.control.flush());
    expect(q("[data-record-body-window]")?.getAttribute("data-record-body-row")).toBe("4");
  });

  it("fails closed on a tampered range and shows no text", async () => {
    await mount();
    fake.current!.source.bodyTamper = "chunkDigest";
    await click('[data-record-seq="2"]');
    expect(q("[data-record-body-error]")?.textContent).toContain("chunk digest");
    expect(q("[data-record-body-window]")).toBeNull();
  });

  it("verifies the whole record only on explicit request and resets on selection", async () => {
    await mount();
    await click("[data-record-next-page]");
    await click('[data-record-seq="60"]');
    expect(reads("verify")).toHaveLength(0);
    expect(q("[data-record-verification]")?.getAttribute("data-record-verification-status")).toBe(
      "idle",
    );
    await click("[data-record-verify]");
    expect(reads("verify")).toHaveLength(1);
    expect(q("[data-record-verification]")?.getAttribute("data-record-verification-status")).toBe(
      "exact",
    );
    // A periodic refresh never repeats the proof or the immutable range.
    const bodyReads = reads("body").length;
    await act(async () => fake.current!.control.poll());
    expect(reads("verify")).toHaveLength(1);
    expect(reads("body")).toHaveLength(bodyReads);
    await click('[data-record-seq="62"]');
    expect(q("[data-record-verification]")?.getAttribute("data-record-verification-status")).toBe(
      "idle",
    );
    // A pending proof is cancelled when its demand disappears.
    fake.current!.control.deferred = true;
    await click("[data-record-verify]");
    expect(q("[data-record-verification]")?.getAttribute("data-record-verification-status")).toBe(
      "pending",
    );
    await click("[data-record-verify-cancel]");
    expect(fake.current!.control.cancelled.some((key) => key.startsWith("verify:"))).toBe(true);
  });

  it("cancels a pending proof when every presentation becomes inactive and never restarts it", async () => {
    await mount();
    await click('[data-record-seq="5"]');
    fake.current!.control.deferred = true;
    await click("[data-record-verify]");
    expect(q("[data-record-verification]")?.getAttribute("data-record-verification-status")).toBe(
      "pending",
    );
    windowFocused = false;
    await act(async () => window.dispatchEvent(new Event("blur")));
    await act(async () => {});
    expect(fake.current!.control.cancelled.some((key) => key.startsWith("verify:"))).toBe(true);
    windowFocused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => {});
    expect(q("[data-record-verification]")?.getAttribute("data-record-verification-status")).toBe(
      "idle",
    );
    expect(reads("verify")).toHaveLength(0);
  });

  it("refuses whole-record verification beyond 64MiB without a request", async () => {
    fake.current = makeFakeExplorerHooks(makeFakeExplorerSource({ hugeDescriptorSeq: 7 }));
    await mount();
    await click('[data-record-seq="7"]');
    expect(q("[data-record-verify]")?.hasAttribute("disabled")).toBe(true);
    expect(q("[data-record-verification]")?.getAttribute("data-record-verification-status")).toBe(
      "refused",
    );
    expect(reads("verify")).toHaveLength(0);
  });

  it("an older gateway is honestly unsupported and the old page endpoint is not used", async () => {
    fake.current!.source.unsupported = true;
    await mount();
    expect(container.textContent).toContain("unsupported");
    expect(fake.oldReads).toBe(0);
    expect(rowSeqs()).toEqual([]);
  });

  it("relays only bounded closed explorer snapshots and applies closed child range actions", async () => {
    const listeners = new Set<(event: RecordCompanionOwnerEvent) => void>();
    const state = (placement: RecordCompanionPlacementState["placement"], revision: number) => ({
      companionId: "companion-x",
      scope: { environmentId: ENV, threadId: THREAD, providerInstanceId: INSTANCE },
      scopeKey: SCOPE_KEY,
      placement,
      revision,
      ownerSenderId: 1,
      childSender: 9,
      childReady: false,
      childQuiesced: false,
      handoff: { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 },
      acknowledgedHandoff: null,
    });
    const bridge = {
      subscribe: vi.fn(async () => []),
      open: vi.fn(async () => ({
        type: "opening",
        companionId: "companion-x",
        state: state("opening", 2),
      })),
      reopen: vi.fn(),
      relay: vi.fn(async () => undefined),
      ackDetach: vi.fn(async () => state("detached", 4)),
      ackDock: vi.fn(),
      onOwnerEvent: (listener: (event: RecordCompanionOwnerEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as DesktopRecordCompanionBridge;
    vi.stubGlobal("desktopBridge", { recordCompanion: bridge });
    await mount();
    await click("[data-record-next-page]");
    await click('[data-record-seq="60"]');
    await click("[data-record-companion-open]");
    await vi.waitFor(() => expect(bridge.relay).toHaveBeenCalled());
    const decode = Schema.decodeUnknownSync(RecordCompanionSnapshot, { onExcessProperty: "error" });
    const relays = (bridge.relay as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { snapshot: unknown }).snapshot,
    );
    const last = relays.at(-1) as any;
    expect(() => decode(last)).not.toThrow();
    expect(last.result.status).toBe("explorer");
    expect(last.result.index.entries).toHaveLength(50);
    expect(last.result.body.status).toBe("window");
    expect(JSON.stringify(last).length).toBeLessThan(2 * 1_048_576);
    expect(JSON.stringify(last)).not.toContain('"data"');
    const end = last.result.body.end as number;
    // A child range action applies through the owner at the current revision.
    const viewRevision = useRecordCompanionHubStore.getState().entries[SCOPE_KEY]!.viewRevision;
    for (const listener of listeners) {
      listener({
        type: "viewAction",
        companionId: "companion-x",
        scopeKey: SCOPE_KEY,
        viewRevision,
        action: { type: "bodyNext" },
      });
    }
    await act(async () => {});
    await act(async () => {});
    expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]!.view.bodyStart).toBe(end);
    expect(reads("body").at(-1)!.offset).toBe(end - 3);
  });
});
