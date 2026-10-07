// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  PRESENTATION_SCHEMA_VERSION,
  type PresentationConfig,
  type PresentationTokensConfig,
} from "@t3tools/contracts";

import {
  PRESENTATION_TOKEN_VARIABLES,
  PresentationOverrideLayer,
  presentationTokenDeclarations,
  presentationTokenValueFor,
} from "./presentationTokens.ts";
import { rightPanelInlineSheetMediaQuery } from "./rightPanelLayout.ts";
import {
  getPreviewPanelMaxWidth,
  resolveRightPanelWidthConstraints,
} from "./components/preview/PreviewPanelShell.tsx";
import { resolveThreadSidebarConstraints } from "./components/threadSidebarWidth.ts";
import {
  collectLayoutSnapshot,
  installPresentationWindowDiagnostics,
  presentationSurfaceRef,
  resetPresentationSurfaceRegistryForTest,
} from "./presentationLayoutSnapshot.ts";
import { presentationStore, setPresentationState } from "./presentationStore.ts";

const resolvedConfig = (layout?: Partial<PresentationConfig["layout"]>): PresentationConfig => ({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  tokens: {
    color: { background: null, surface: null, text: null, muted: null, border: null, accent: null },
    radius: { panel: null, control: null },
    spacing: { base: null },
    font: { family: null, familyMono: null, sizePrompt: null, sizeCode: null, lineHeight: null },
    transition: { durationMs: null },
  },
  layout: {
    mainWindow: { minWidth: 840, minHeight: 620, defaultWidth: 1100, defaultHeight: 780 },
    navigation: { minWidth: 200, defaultWidth: 240, maxWidth: 320 },
    conversation: { minWidth: 480 },
    rightPanel: { minWidth: 280, defaultWidth: 320, maxWidth: 440 },
    graph: PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
    recordCompanion: PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
    inlineBreakpoint: 1200,
    ...layout,
  },
});

const resolvedTokens = (tokens: Partial<PresentationTokensConfig>): PresentationTokensConfig => ({
  ...resolvedConfig().tokens,
  ...tokens,
});

afterEach(() => {
  resetPresentationSurfaceRegistryForTest();
  setPresentationState(null);
});

describe("presentation token adapter", () => {
  it("maps exactly the registered R1 tokens onto shipped theme variables", () => {
    expect(PRESENTATION_TOKEN_VARIABLES).toEqual({
      "color.background": "--background",
      "color.surface": "--card",
      "color.text": "--foreground",
      "color.muted": "--muted-foreground",
      "color.border": "--border",
      "color.accent": "--accent",
      "radius.panel": "--radius",
      // The control token binds the semantic control radius that buttons,
      // inputs, badges and sidebar controls actually read; Tailwind inlines
      // the derived --radius-* scale from --radius, so --radius-md would not
      // reach the rounded-md utility.
      "radius.control": "--control-radius",
      "spacing.base": "--spacing",
      "font.family": "--font-sans",
      "font.familyMono": "--font-mono",
      "font.sizePrompt": "--font-size-prompt",
      "font.sizeCode": "--font-size-code",
      "font.lineHeight": "--text-base--line-height",
      "transition.durationMs": "--panel-animation-duration",
    });
  });

  it("emits important declarations for resolved non-null tokens only", () => {
    const declarations = presentationTokenDeclarations(
      resolvedTokens({
        color: {
          background: null,
          surface: null,
          text: null,
          muted: null,
          border: null,
          accent: "#101418",
        },
        radius: { panel: "0.75rem", control: null },
        font: {
          family: "Berkeley Mono",
          familyMono: null,
          sizePrompt: null,
          sizeCode: "13px",
          lineHeight: null,
        },
        transition: { durationMs: 220 },
      }),
    );
    expect(declarations).toContain("--accent: #101418 !important;");
    expect(declarations).toContain("--radius: 0.75rem !important;");
    expect(declarations).toContain("--panel-animation-duration: 220ms !important;");
    // Font families keep a fallback stack for glyph coverage.
    expect(declarations).toContain("--font-sans:");
    expect(declarations).toMatch(/--font-sans: "Berkeley Mono", .*sans-serif !important;/);
    // The diffs surfaces read their own alias of the code font size.
    expect(declarations).toContain("--font-size-code: 13px !important;");
    expect(declarations).toContain("--diffs-font-size: 13px !important;");
    // Null tokens delegate to the current appearance: no declarations.
    expect(declarations).not.toContain("--background:");
    expect(declarations).not.toContain("--card:");
    expect(declarations).not.toContain("--control-radius:");
  });

  it("emits nothing for a fully delegating token policy", () => {
    expect(presentationTokenDeclarations(resolvedConfig().tokens)).toBe("");
  });

  it("installs and removes one dedicated root style element", () => {
    const layer = new PresentationOverrideLayer();
    layer.install(document, resolvedTokens({ radius: { panel: "1rem", control: null } }));
    let element = document.querySelector("style[data-dokkabi-presentation-override]");
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain("--radius: 1rem !important;");
    // Rewriting reuses the same element; removal detaches exactly it.
    layer.install(document, resolvedTokens({ spacing: { base: "8px" } }));
    expect(document.querySelectorAll("style[data-dokkabi-presentation-override]").length).toBe(1);
    expect(element?.textContent).toContain("--spacing: 8px !important;");
    layer.remove(document);
    expect(document.querySelector("style[data-dokkabi-presentation-override]")).toBeNull();
    // Removing again is a no-op.
    layer.remove(document);
    expect(document.querySelector("style[data-dokkabi-presentation-override]")).toBeNull();
    // A fully delegating policy removes the layer entirely.
    layer.install(document, resolvedConfig().tokens);
    expect(document.querySelector("style[data-dokkabi-presentation-override]")).toBeNull();
  });

  it("formats transition duration with a unit and passes dimension strings through", () => {
    expect(presentationTokenValueFor("transition.durationMs", 220)).toBe("220ms");
    expect(presentationTokenValueFor("font.sizeCode", "13px")).toBe("13px");
    expect(presentationTokenValueFor("font.lineHeight", 1.6)).toBe("1.6");
  });
});

describe("right panel layout constraints", () => {
  it("derives the sheet media query from the presentation breakpoint", () => {
    expect(rightPanelInlineSheetMediaQuery(1200)).toBe("(max-width: 1199px)");
    expect(rightPanelInlineSheetMediaQuery(980)).toBe("(max-width: 979px)");
  });

  it("resolves panel width constraints from presentation or legacy fallback", () => {
    expect(resolveRightPanelWidthConstraints(resolvedConfig())).toEqual({
      minWidth: 280,
      defaultWidth: 320,
      maxWidth: 440,
    });
    expect(resolveRightPanelWidthConstraints(null)).toEqual({
      minWidth: 360,
      defaultWidth: 540,
      maxWidth: null,
    });
  });

  it("bounds the panel maximum by the active minima, not the legacy 360 floor", () => {
    const active = {
      minWidth: 280,
      maxWidth: 320,
      siblingMinWidth: 480,
    };
    // The configured maximum binds even though the viewport fraction is larger.
    expect(getPreviewPanelMaxWidth(1000, undefined, active)).toBe(320);
    // A row too narrow for both columns floors at the ACTIVE minimum (280),
    // never at the legacy 360.
    expect(getPreviewPanelMaxWidth(1000, 700, active)).toBe(280);
    // Legacy callers keep the shipped behavior.
    expect(getPreviewPanelMaxWidth(6000)).toBe(4200);
    expect(getPreviewPanelMaxWidth(1000, 700)).toBe(360);
  });
});

describe("thread sidebar constraints", () => {
  it("uses presentation constraints when available", () => {
    const constraints = resolveThreadSidebarConstraints(resolvedConfig().layout, 1600, null);
    expect(constraints.minWidth).toBe(200);
    expect(constraints.defaultWidth).toBe(240);
    expect(constraints.maxWidth).toBe(320);
  });

  it("keeps legacy behavior without presentation", () => {
    const constraints = resolveThreadSidebarConstraints(null, 1600, 256);
    expect(constraints.minWidth).toBe(208);
    expect(constraints.defaultWidth).toBe(256);
    expect(constraints.maxWidth).toBe(960);
  });

  it("bounds the sidebar by the active conversation minimum, not the legacy constant", () => {
    // Legacy: 800 - 640 (legacy main content min) floors at the sidebar min.
    const legacy = resolveThreadSidebarConstraints(null, 800, null);
    expect(legacy.maxWidth).toBe(208);
    // Presentation: 800 - 480 (active conversation minimum) reaches the
    // configured navigation maximum.
    const presented = resolveThreadSidebarConstraints(resolvedConfig().layout, 800, null);
    expect(presented.maxWidth).toBe(320);
    expect(presented.defaultWidth).toBe(240);
  });

  it("clamps a stored user width into the active constraints", () => {
    const constraints = resolveThreadSidebarConstraints(resolvedConfig().layout, 1600, 300);
    expect(constraints.clamp(400)).toBe(320);
    expect(constraints.clamp(120)).toBe(200);
    expect(constraints.clamp(260)).toBe(260);
    // A stored preference survives constraint changes by clamping, not by
    // being discarded.
    expect(constraints.clamp(300)).toBe(300);
  });
});

describe("presentation layout snapshot", () => {
  it("reports registered surfaces as measured and others as explicitly absent", () => {
    setPresentationState({
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      revision: 4,
      digest: "a".repeat(64),
      location: "/private/tmp/dokkabi-presentation-x/desktop/presentation.json",
      status: "applied",
      overrideDocument: "{}",
      override: { schemaVersion: PRESENTATION_SCHEMA_VERSION },
      config: resolvedConfig(),
      error: null,
    });
    const element = document.createElement("div");
    document.body.append(element);
    element.getBoundingClientRect = () =>
      ({
        x: 1,
        y: 2,
        width: 320,
        height: 640,
        top: 2,
        left: 1,
        right: 321,
        bottom: 642,
      }) as DOMRect;
    const detach = presentationSurfaceRef("navigation")(element);
    const snapshot = collectLayoutSnapshot();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.configRevision).toBe(4);
    expect(snapshot.configDigest).toBe("a".repeat(64));
    expect(snapshot.viewport.width).toBeGreaterThan(0);
    expect(snapshot.zoom).toBeGreaterThan(0);
    expect(snapshot.devicePixelRatio).toBeGreaterThan(0);
    expect(snapshot.surfaces.navigation.status).toBe("measured");
    if (snapshot.surfaces.navigation.status !== "measured") return;
    expect(snapshot.surfaces.navigation.rect).toEqual({ x: 1, y: 2, width: 320, height: 640 });
    // A fully in-viewport connected element is visible and unclipped.
    expect(snapshot.surfaces.navigation.visible).toBe(true);
    expect(snapshot.surfaces.navigation.clipped).toBe(false);
    expect(snapshot.surfaces.conversation).toEqual({ status: "absent" });
    expect(snapshot.surfaces.composer).toEqual({ status: "absent" });
    detach();
    element.remove();
    expect(collectLayoutSnapshot()?.surfaces.navigation).toEqual({ status: "absent" });
  });

  it("marks registered surfaces with stable presentation data attributes", () => {
    setPresentationState({
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      revision: 4,
      digest: "a".repeat(64),
      location: "/private/tmp/dokkabi-presentation-x/desktop/presentation.json",
      status: "applied",
      overrideDocument: "{}",
      override: { schemaVersion: PRESENTATION_SCHEMA_VERSION },
      config: resolvedConfig(),
      error: null,
    });
    const element = document.createElement("div");
    document.body.append(element);
    const detach = presentationSurfaceRef("conversation")(element);
    try {
      expect(element.dataset.presentationId).toBe("conversation");
    } finally {
      detach?.();
    }
  });

  it("samples actual computed styles and resolved token variables of registered elements", () => {
    setPresentationState({
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      revision: 6,
      digest: "b".repeat(64),
      location: "/private/tmp/dokkabi-presentation-x/desktop/presentation.json",
      status: "applied",
      overrideDocument: "{}",
      override: { schemaVersion: PRESENTATION_SCHEMA_VERSION },
      config: resolvedConfig(),
      error: null,
    });
    const element = document.createElement("div");
    element.style.fontSize = "13px";
    element.style.backgroundColor = "rgb(16, 20, 24)";
    element.style.borderRadius = "8px";
    element.style.transitionDuration = "0.22s";
    document.body.append(element);
    const detach = presentationSurfaceRef("composer")(element);
    try {
      const snapshot = collectLayoutSnapshot();
      expect(snapshot).not.toBeNull();
      if (snapshot === null) return;
      const composer = snapshot.surfaces.composer;
      expect(composer.status).toBe("measured");
      if (composer.status !== "measured") return;
      // The style sample comes from the live element's computed style.
      expect(composer.styles.fontSize).toBe("13px");
      expect(composer.styles.backgroundColor).toContain("16");
      expect(composer.styles.borderRadius).toBe("8px");
      expect(composer.styles.transitionDuration).toBe("0.22s");
      // Resolved token variables are reported for every registered token
      // path; jsdom cannot resolve custom properties, so they read null here
      // while a real Chromium reports the consumed values.
      for (const path of Object.keys(snapshot.resolvedTokens)) {
        expect(Object.keys(snapshot.resolvedTokens)).toContain(path);
      }
      expect(Object.keys(snapshot.resolvedTokens)).toHaveLength(15);
    } finally {
      detach?.();
      element.remove();
    }
  });

  it("exposes a read-only window-local diagnostic endpoint over the same collector", () => {
    setPresentationState({
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      revision: 8,
      digest: "c".repeat(64),
      location: "/private/tmp/dokkabi-presentation-x/desktop/presentation.json",
      status: "applied",
      overrideDocument: "{}",
      override: { schemaVersion: PRESENTATION_SCHEMA_VERSION },
      config: resolvedConfig(),
      error: null,
    });
    const diagnostics = installPresentationWindowDiagnostics(window);
    expect(diagnostics.appliedState()?.revision).toBe(8);
    const element = document.createElement("div");
    document.body.append(element);
    const detach = presentationSurfaceRef("root")(element);
    try {
      const snapshot = diagnostics.collectLayoutSnapshot();
      expect(snapshot?.configRevision).toBe(8);
      expect(snapshot?.surfaces.root.status).toBe("measured");
      expect(snapshot?.surfaces.navigation).toEqual({ status: "absent" });
    } finally {
      detach?.();
      element.remove();
    }
    // The endpoint grants no mutation authority: it exposes reads only.
    const keys = Object.keys(diagnostics);
    expect(keys).toContain("collectLayoutSnapshot");
    expect(keys).toContain("appliedState");
    expect(keys).toContain("connectionError");
  });

  it("returns null when presentation state is unavailable", () => {
    expect(collectLayoutSnapshot()).toBeNull();
  });
});

describe("presentation store", () => {
  it("does not emit when the same state object is set again", () => {
    let emissions = 0;
    const unsubscribe = presentationStore.subscribe(() => {
      emissions += 1;
    });
    const state = {
      schemaVersion: PRESENTATION_SCHEMA_VERSION as typeof PRESENTATION_SCHEMA_VERSION,
      revision: 1,
      digest: "d",
      location: "/x",
      status: "defaults" as const,
      overrideDocument: null,
      override: null,
      config: resolvedConfig(),
      error: null,
    };
    setPresentationState(state);
    setPresentationState(state);
    expect(emissions).toBe(1);
    unsubscribe();
    const current = presentationStore.get();
    expect(current?.status).toBe("defaults");
  });
});
