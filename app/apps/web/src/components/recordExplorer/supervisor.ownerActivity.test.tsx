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

const hostState = (active: boolean, activityRevision: number): RecordCompanionPlacementState => {
  const tuple = { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 };
  return {
    companionId: "active-child",
    scope: { environmentId: ENV, threadId: THREAD, providerInstanceId: INSTANCE },
    scopeKey: SCOPE_KEY,
    placement: "detached",
    revision: 4,
    ownerSenderId: 1,
    childSender: 9,
    childReady: true,
    childQuiesced: false,
    handoff: tuple,
    acknowledgedHandoff: tuple,
    childActive: active,
    childActivityRevision: activityRevision,
  };
};
async function pushHost(active: boolean, revision: number) {
  await act(async () =>
    useRecordCompanionHubStore
      .getState()
      .handleOwnerEvent({ type: "state", state: hostState(active, revision) }),
  );
  await act(async () => {});
}
async function childAction(action: import("@t3tools/contracts").RecordCompanionViewAction) {
  const entry = useRecordCompanionHubStore.getState().entries[SCOPE_KEY]!;
  await act(async () =>
    useRecordCompanionHubStore.getState().handleOwnerEvent({
      type: "viewAction",
      companionId: "active-child",
      scopeKey: SCOPE_KEY,
      viewRevision: entry.viewRevision,
      action,
    }),
  );
  await act(async () => {});
}
describe("supervisor actual owner scoped demand", () => {
  it("keeps child Next reading while the owner is blurred and removes reads on child blur", async () => {
    await mount();
    await click("[data-record-next-page]");
    await click('[data-record-seq="60"]');
    await pushHost(true, 1);
    windowFocused = false;
    await act(async () => window.dispatchEvent(new Event("blur")));
    const before = reads("body").length;
    await childAction({ type: "bodyNext" });
    expect(reads("body")).toHaveLength(before + 1);
    await pushHost(false, 2);
    const paused = fake.current!.source.reads.length;
    await act(async () => fake.current!.control.poll());
    expect(fake.current!.source.reads).toHaveLength(paused);
    expect(fake.current!.control.mounted.size).toBe(0);
  });
  it("interrupts a child proof when all presentations become inactive and does not restart on child focus", async () => {
    await mount();
    await click('[data-record-seq="5"]');
    await pushHost(true, 1);
    windowFocused = false;
    await act(async () => window.dispatchEvent(new Event("blur")));
    fake.current!.control.deferred = true;
    await childAction({ type: "verify" });
    expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]!.verifyIntent).not.toBeNull();
    await pushHost(false, 2);
    expect(fake.current!.control.cancelled.some((key) => key.startsWith("verify:"))).toBe(true);
    expect(useRecordCompanionHubStore.getState().entries[SCOPE_KEY]!.verifyIntent).toBeNull();
    await pushHost(true, 3);
    expect([...fake.current!.control.mounted.keys()].some((key) => key.startsWith("verify:"))).toBe(
      false,
    );
  });
});
