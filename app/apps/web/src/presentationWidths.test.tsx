// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PRESENTATION_SCHEMA_VERSION, type PresentationAppliedState } from "@t3tools/contracts";
import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
} from "@t3tools/contracts";

import { setPresentationState } from "./presentationStore";
import {
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
  useThreadSidebarWidth,
} from "./components/threadSidebarWidth";
import { useResizableWidth } from "./hooks/useResizableWidth";

const appliedStateWith = (navigation: {
  minWidth: number;
  defaultWidth: number;
  maxWidth: number;
}): PresentationAppliedState => ({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  revision: 2,
  digest: "d".repeat(64),
  location: "/private/tmp/dokkabi-presentation-x/desktop/presentation.json",
  status: "applied",
  overrideDocument: "{}",
  override: { schemaVersion: PRESENTATION_SCHEMA_VERSION },
  config: {
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
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
    layout: {
      mainWindow: { minWidth: 840, minHeight: 620, defaultWidth: 1100, defaultHeight: 780 },
      navigation,
      conversation: { minWidth: 480 },
      rightPanel: { minWidth: 280, defaultWidth: 320, maxWidth: 440 },
      graph: PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
      recordCompanion: PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
      inlineBreakpoint: 1200,
    },
  },
  error: null,
});

describe("mounted sidebar width provenance with delayed host config", () => {
  let root: Root;
  let container: HTMLDivElement;
  let observed: { width: number; defaultWidth: number };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    setPresentationState(null);
    observed = { width: -1, defaultWidth: -1 };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setPresentationState(null);
    vi.unstubAllGlobals();
  });

  const mountSidebarHarness = async () => {
    function Harness() {
      const sidebar = useThreadSidebarWidth();
      observed = { width: sidebar.width, defaultWidth: sidebar.constraints.defaultWidth };
      return null;
    }
    await act(async () => {
      root.render(createElement(Harness));
    });
  };

  it("applies the JSON navigation default once the host config arrives, without a user preference", async () => {
    await mountSidebarHarness();
    // Before the host config: the legacy default (256) seeds the width.
    expect(observed.width).toBe(256);
    // The host config arrives late with a different navigation default.
    await act(async () => {
      setPresentationState(appliedStateWith({ minWidth: 200, defaultWidth: 300, maxWidth: 340 }));
    });
    expect(observed.width).toBe(300);
    expect(observed.defaultWidth).toBe(300);
  });

  it("preserves a retained user preference by clamping instead of replacing it", async () => {
    window.localStorage.setItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, "260");
    await mountSidebarHarness();
    expect(observed.width).toBe(260);
    await act(async () => {
      setPresentationState(appliedStateWith({ minWidth: 200, defaultWidth: 300, maxWidth: 340 }));
    });
    // Retained 260 stays 260 (within constraints), not the JSON default 300.
    expect(observed.width).toBe(260);
  });

  it("clamps a retained preference above the new maximum without discarding it", async () => {
    window.localStorage.setItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, "400");
    await mountSidebarHarness();
    // Legacy viewport bound (1024 - 640) already clamps the retained 400.
    expect(observed.width).toBe(384);
    await act(async () => {
      setPresentationState(appliedStateWith({ minWidth: 200, defaultWidth: 300, maxWidth: 340 }));
    });
    // The retained 400 is clamped to the active configured maximum.
    expect(observed.width).toBe(340);
  });
});

describe("mounted resizable panel width provenance", () => {
  let root: Root;
  let container: HTMLDivElement;
  let observedWidth: number;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    observedWidth = -1;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const mountPanelHarness = async (props: {
    storageKey: string;
    defaultWidth: number;
    minWidth: number;
    maxWidth: number;
  }) => {
    function Harness() {
      const { width } = useResizableWidth({ ...props, edge: "left" });
      observedWidth = width;
      return null;
    }
    await act(async () => {
      root.render(createElement(Harness));
    });
  };

  it("reseeds to the live default when the host config arrives and nothing was retained", async () => {
    // Legacy defaults before the host config.
    await mountPanelHarness({
      storageKey: "t3code:preview-panel-width:test",
      defaultWidth: 540,
      minWidth: 360,
      maxWidth: 4200,
    });
    expect(observedWidth).toBe(540);
    // Presentation right-panel constraints arrive (simulating delayed config).
    await mountPanelHarness({
      storageKey: "t3code:preview-panel-width:test",
      defaultWidth: 320,
      minWidth: 280,
      maxWidth: 440,
    });
    expect(observedWidth).toBe(320);
  });

  it("keeps a retained panel width when the live defaults change", async () => {
    window.localStorage.setItem("t3code:preview-panel-width:kept", "400");
    await mountPanelHarness({
      storageKey: "t3code:preview-panel-width:kept",
      defaultWidth: 540,
      minWidth: 360,
      maxWidth: 4200,
    });
    expect(observedWidth).toBe(400);
    await mountPanelHarness({
      storageKey: "t3code:preview-panel-width:kept",
      defaultWidth: 320,
      minWidth: 280,
      maxWidth: 440,
    });
    // The retained 400 is a user choice: clamped into the new bounds, kept.
    expect(observedWidth).toBe(400);
  });
});
