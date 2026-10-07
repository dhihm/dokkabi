// @vitest-environment jsdom

import { act, createElement, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  PRESENTATION_SCHEMA_VERSION,
  PRESENTATION_SURFACE_DATA_ATTRIBUTE,
  type PresentationAppliedState,
} from "@t3tools/contracts";

import {
  collectLayoutSnapshot,
  resetPresentationSurfaceRegistryForTest,
} from "./presentationLayoutSnapshot";
import { setPresentationState, usePresentationState } from "./presentationStore";
import {
  useComposedPresentationSurfaceRef,
  usePresentationSurfaceRef,
} from "./presentationSurfaceHooks";

const appliedState = (revision: number): PresentationAppliedState => ({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  revision,
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
      navigation: { minWidth: 200, defaultWidth: 280, maxWidth: 420 },
      conversation: { minWidth: 480 },
      rightPanel: { minWidth: 280, defaultWidth: 320, maxWidth: 440 },
      graph: PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
      recordCompanion: PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
      inlineBreakpoint: 1200,
    },
  },
  error: null,
});

describe("mounted composed presentation surface refs across presentation rerenders", () => {
  let root: Root;
  let container: HTMLDivElement;
  let observedElements: Array<HTMLDivElement | null>;
  let observedRevisions: number[];
  let refIdentities: Array<unknown>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetPresentationSurfaceRegistryForTest();
    setPresentationState(null);
    observedElements = [];
    observedRevisions = [];
    refIdentities = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setPresentationState(null);
    resetPresentationSurfaceRegistryForTest();
    vi.unstubAllGlobals();
  });

  // Mirrors ChatView's composer wiring: the presentation-state subscription
  // rerenders the component when the host pushes a new revision, while the
  // composed ref forwards each element to the existing state setter and
  // registers the surface. The recording wrapper only observes the state
  // boundary; the composition itself is the production hook.
  function ComposerHarness() {
    const presentationState = usePresentationState();
    observedRevisions.push(presentationState?.revision ?? -1);
    const [, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
    const recordElement = useCallback((element: HTMLDivElement | null) => {
      observedElements.push(element);
      setComposerOverlayElement(element);
    }, []);
    const composerOverlayRef = useComposedPresentationSurfaceRef<HTMLDivElement>(
      "composer",
      recordElement,
    );
    refIdentities.push(composerOverlayRef);
    return createElement("div", { ref: composerOverlayRef });
  }

  function SurfaceHarness() {
    usePresentationState();
    const surfaceRef = usePresentationSurfaceRef("conversation");
    refIdentities.push(surfaceRef);
    return createElement("div", { ref: surfaceRef });
  }

  const applyRevision = async (revision: number) => {
    await act(async () => {
      setPresentationState(appliedState(revision));
    });
  };

  it("keeps the composer attached without a null/element rebind loop across revisions", async () => {
    await act(async () => {
      root.render(createElement(ComposerHarness));
    });
    await applyRevision(2);
    await applyRevision(3);
    await applyRevision(4);

    // The harness actually rerendered per revision — one initial render, one
    // rerender from the ref attach setting element state, then one per host
    // revision; none of those detached the ref (a per-render callback would
    // have ping-ponged the state setter into React error #185 first).
    expect(observedRevisions).toEqual([-1, -1, 2, 3, 4]);
    expect(new Set(refIdentities).size).toBe(1);

    const element = container.firstElementChild;
    expect(element).toBeInstanceOf(HTMLDivElement);
    expect(observedElements).toEqual([element]);
    expect(container.firstElementChild).toBe(element);
    expect(element?.getAttribute(PRESENTATION_SURFACE_DATA_ATTRIBUTE)).toBe("composer");
    expect(collectLayoutSnapshot()?.surfaces.composer.status).toBe("measured");
  });

  it("clears the composer state and registry registration on real unmount", async () => {
    await act(async () => {
      root.render(createElement(ComposerHarness));
    });
    await applyRevision(2);
    expect(collectLayoutSnapshot()?.surfaces.composer.status).toBe("measured");

    await act(async () => root.unmount());
    // The only null the setter ever received is the real unmount detach.
    expect(observedElements).toHaveLength(2);
    expect(observedElements[observedElements.length - 1]).toBeNull();
    expect(collectLayoutSnapshot()?.surfaces.composer.status).toBe("absent");
  });

  it("keeps the registry-only surface ref stable, registered and attributed", async () => {
    await act(async () => {
      root.render(createElement(SurfaceHarness));
    });
    await applyRevision(2);
    await applyRevision(3);

    expect(new Set(refIdentities).size).toBe(1);
    const element = container.firstElementChild;
    expect(element).toBeInstanceOf(HTMLDivElement);
    expect(element?.getAttribute(PRESENTATION_SURFACE_DATA_ATTRIBUTE)).toBe("conversation");
    expect(collectLayoutSnapshot()?.surfaces.conversation.status).toBe("measured");

    await act(async () => root.unmount());
    expect(collectLayoutSnapshot()?.surfaces.conversation.status).toBe("absent");
  });
});
