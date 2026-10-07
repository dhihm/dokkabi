// @vitest-environment jsdom
import * as NodeCrypto from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProviderWorkbenchRecord, RecordCompanionViewAction } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { RecordCompanionView } from "./RecordCompanionView";

function fixturePage(rowName = "test/source"): ProviderWorkbenchRecord {
  const rows: any[] = [];
  let prevHash = "0".repeat(64);
  for (let seq = 1; seq <= 4; seq += 1) {
    const unsigned = {
      kind: "observe" as const,
      name: seq === 2 ? `${rowName}<img src=x onerror=alert(1)>` : `${rowName}#${seq}`,
      payload: { seq },
      prev_hash: prevHash,
      seq,
      ts: "2026-10-02T00:00:00.000Z",
    };
    const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    rows.push({ ...unsigned, hash });
    prevHash = hash;
  }
  const asOf = { sessionId: "s-1", seq: 4, hash: rows[3].hash, generation: "a".repeat(64) };
  return {
    version: 1,
    state: "available",
    sessionCursor: asOf,
    gatewayCursor: { seq: 0, hash: "0".repeat(64), generation: "0".repeat(64) },
    asOf,
    records: rows.slice(0, 2),
    next: { seq: 2, hash: rows[1].hash, generation: asOf.generation },
    total: 4,
    hasMore: true,
    decisions: { status: "unsupported", reason: "checkpoint authority absent" },
  };
}

const DEFAULT_VIEW = { tab: "record" as const, pin: null, after: null, selectedSeq: null };

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mountView(
  props: Partial<Parameters<typeof RecordCompanionView>[0]> & {
    state: Parameters<typeof RecordCompanionView>[0]["state"];
  },
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onAction = props.onAction ?? vi.fn();
  const { onAction: _override, ...rest } = props;
  void act(() => {
    root!.render(
      <RecordCompanionView view={DEFAULT_VIEW} interactive onAction={onAction} {...rest} />,
    );
  });
  return container;
}

it("renders retained rows as inert text, never executable HTML", () => {
  const container = mountView({
    state: { kind: "view", page: fixturePage(), staleError: null },
  });
  const html = container.innerHTML;
  expect(html).toContain("&lt;img src=x"); // escaped text, not markup
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  // The default selection is the page's first row.
  expect(
    container.querySelector("[data-record-row-json]")?.getAttribute("data-record-row-json"),
  ).toBe("1");
  expect(container.querySelector("[data-record-row-json]")?.textContent).toContain('"seq": 1');
});

it("dispatches exactly the closed action vocabulary", () => {
  const onAction = vi.fn();
  const container = mountView({
    state: { kind: "view", page: fixturePage(), staleError: null },
    onAction,
  });
  act(() => {
    (container.querySelector("[data-record-tab-trigger]") as HTMLButtonElement).click();
  });
  expect(onAction).toHaveBeenCalledWith({ type: "tab", tab: "record" });
  // First page is disabled while on the live first page (exact R5 rule).
  expect(
    (container.querySelector("[data-record-first-page]") as HTMLButtonElement).hasAttribute(
      "disabled",
    ),
  ).toBe(true);
  act(() => {
    (container.querySelector("[data-record-next-page]") as HTMLButtonElement).click();
  });
  expect(onAction).toHaveBeenCalledWith({ type: "next" });
  act(() => {
    (container.querySelector('[data-record-seq="2"]') as HTMLButtonElement).click();
  });
  expect(onAction).toHaveBeenCalledWith({ type: "select", seq: 2 });
  act(() => {
    (container.querySelector("[data-record-pin-toggle]") as HTMLButtonElement).click();
  });
  expect(onAction).toHaveBeenCalledWith({ type: "pin" });
  const dispatched = onAction.mock.calls.map(
    ([action]) => (action as RecordCompanionViewAction).type,
  );
  expect(new Set(dispatched)).toEqual(new Set(["tab", "next", "select", "pin"]));
});

it("renders the same view visibly inert when interactive is false", () => {
  const onAction = vi.fn();
  const container = mountView({
    state: { kind: "view", page: fixturePage(), staleError: null },
    interactive: false,
    onAction,
  });
  const tabTrigger = container.querySelector("[data-record-tab-trigger]") as HTMLButtonElement;
  const pinToggle = container.querySelector("[data-record-pin-toggle]") as HTMLButtonElement;
  expect(tabTrigger.hasAttribute("disabled")).toBe(true);
  expect(pinToggle.hasAttribute("disabled")).toBe(true);
  act(() => {
    (container.querySelector('[data-record-seq="2"]') as HTMLButtonElement).click();
  });
  expect(onAction).not.toHaveBeenCalled();
  expect((container.querySelector('[data-record-seq="2"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  // The page itself stays rendered (inert, not unmounted).
  expect(container.querySelector("[data-record-row-json]")).not.toBeNull();
});

it("shows the stale chip only for a quarantined view", () => {
  const page = fixturePage();
  const clean = mountView({ state: { kind: "view", page, staleError: null } });
  expect(clean.querySelector("[data-record-stale]")).toBeNull();
  const stale = mountView({ state: { kind: "view", page, staleError: "head rewound" } });
  expect(stale.querySelector("[data-record-stale]")?.textContent).toBe("stale");
});

it("states the decisions capability fact instead of inventing authority", () => {
  const container = mountView({
    state: { kind: "view", page: fixturePage(), staleError: null },
    view: { ...DEFAULT_VIEW, tab: "decisions" },
  });
  const decisions = container.querySelector("[data-decisions-tab]");
  expect(decisions?.textContent).toContain("Decision responses are unavailable for this session");
  expect(decisions?.querySelector("button")).toBeNull();
});
