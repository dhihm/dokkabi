/**
 * Layout snapshot collector for the real registered surfaces.
 *
 * Surfaces register their actual mounted elements by stable presentation ID
 * (see presentationSurfaceRef), which also stamps the element with a stable
 * data-presentation-id attribute so the surfaces stay inspectable in the
 * built native application. Collection measures those live elements —
 * rectangles, visibility, clipping and a computed-style sample — resolves
 * the root's live token variables, and reports unmounted surfaces as
 * explicitly absent. It never invents geometry and performs no continuous
 * polling; callers collect on demand.
 */
import {
  PRESENTATION_SURFACE_DATA_ATTRIBUTE,
  PRESENTATION_SURFACE_IDS,
  type PresentationAppliedState,
  type PresentationComputedStyleSample,
  type PresentationLayoutSnapshot,
  type PresentationLayoutRect,
  type PresentationResolvedTokens,
  type PresentationSurfaceId,
  type PresentationSurfaceMeasurement,
} from "@t3tools/contracts";
import {
  PRESENTATION_TOKEN_PROPERTY_PATHS,
  type PresentationTokenPropertyPath,
} from "@t3tools/contracts";

import { presentationConnectionError, presentationStore } from "./presentationStore";
import { PRESENTATION_TOKEN_VARIABLES } from "./presentationTokens";

const surfaces = new Map<PresentationSurfaceId, HTMLElement>();

/**
 * Ref callback registering a surface element by stable presentation ID.
 * Returns a detach cleanup (React 19 ref cleanup semantics). Unmounting or
 * detaching removes it; omitted or unregistered surfaces are reported as
 * absent, never as fake rectangles.
 */
export function presentationSurfaceRef(
  id: PresentationSurfaceId,
): (element: HTMLElement | null) => () => void {
  return (element) => {
    setPresentationSurface(id, element);
    return () => {
      if (surfaces.get(id) === element) {
        surfaces.delete(id);
      }
    };
  };
}

/** Imperative registration for composing with existing ref callbacks. */
export function setPresentationSurface(
  id: PresentationSurfaceId,
  element: HTMLElement | null,
): void {
  if (element === null) {
    surfaces.delete(id);
    return;
  }
  // The stable attribute makes this surface discoverable in the real DOM
  // (built app devtools, native diagnostics) without guessing selectors.
  if (element.getAttribute(PRESENTATION_SURFACE_DATA_ATTRIBUTE) !== id) {
    element.setAttribute(PRESENTATION_SURFACE_DATA_ATTRIBUTE, id);
  }
  surfaces.set(id, element);
}

export function resetPresentationSurfaceRegistryForTest(): void {
  surfaces.clear();
}

function isHidden(element: HTMLElement): boolean {
  try {
    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  } catch {
    // Not a real Element (test doubles); visibility falls back to geometry.
    return false;
  }
}

const computedOrNull = (value: string): string | null => (value === "" ? null : value);

/** Actual computed styles of the live element, sampled at capture time. */
function sampleComputedStyles(element: HTMLElement): PresentationComputedStyleSample {
  try {
    const style = window.getComputedStyle(element);
    return {
      backgroundColor: computedOrNull(style.backgroundColor),
      color: computedOrNull(style.color),
      borderColor: computedOrNull(style.borderColor),
      fontFamily: computedOrNull(style.fontFamily),
      fontSize: computedOrNull(style.fontSize),
      lineHeight: computedOrNull(style.lineHeight),
      borderRadius: computedOrNull(style.borderRadius),
      paddingInline: computedOrNull(style.paddingInline),
      transitionDuration: computedOrNull(style.transitionDuration),
    };
  } catch {
    return {
      backgroundColor: null,
      color: null,
      borderColor: null,
      fontFamily: null,
      fontSize: null,
      lineHeight: null,
      borderRadius: null,
      paddingInline: null,
      transitionDuration: null,
    };
  }
}

function measure(element: HTMLElement): PresentationSurfaceMeasurement {
  const domRect = element.getBoundingClientRect();
  const rect: PresentationLayoutRect = {
    x: domRect.x,
    y: domRect.y,
    width: domRect.width,
    height: domRect.height,
  };
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const intersectsViewport =
    domRect.left < viewportWidth &&
    domRect.right > 0 &&
    domRect.top < viewportHeight &&
    domRect.bottom > 0;
  const clipped =
    domRect.left < 0 ||
    domRect.top < 0 ||
    domRect.right > viewportWidth ||
    domRect.bottom > viewportHeight;
  const visible =
    element.isConnected !== false &&
    !isHidden(element) &&
    domRect.width > 0 &&
    domRect.height > 0 &&
    intersectsViewport;
  return { status: "measured", rect, visible, clipped, styles: sampleComputedStyles(element) };
}

/** Chromium zoom factor from the desktop bridge; 1 in plain browsers. */
function currentZoomFactor(): number {
  const zoom = window.desktopBridge?.getZoomFactor?.();
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * Values the document root actually resolves for every registered token
 * variable. An empty or unresolvable custom property reads null: the theme
 * base provides that token and no override is in effect at the root.
 */
function collectResolvedTokens(): PresentationResolvedTokens {
  const resolved = {} as Record<PresentationTokenPropertyPath, string | null>;
  let rootStyle: CSSStyleDeclaration | null = null;
  for (const path of PRESENTATION_TOKEN_PROPERTY_PATHS) {
    if (rootStyle === null) {
      try {
        rootStyle = window.getComputedStyle(document.documentElement);
      } catch {
        rootStyle = null;
      }
    }
    const variable = PRESENTATION_TOKEN_VARIABLES[path];
    const value = rootStyle?.getPropertyValue(variable) ?? "";
    resolved[path] = value === "" ? null : value.trim();
  }
  return resolved;
}

/**
 * Collects one snapshot from the currently registered elements and the
 * applied presentation state. Returns null when no presentation state is
 * available (outside the desktop host).
 */
export function collectLayoutSnapshot(): PresentationLayoutSnapshot | null {
  const state = presentationStore.get();
  if (state === null) return null;
  const measured = {} as Record<PresentationSurfaceId, PresentationSurfaceMeasurement>;
  for (const id of PRESENTATION_SURFACE_IDS) {
    const element = surfaces.get(id);
    measured[id] = element === undefined ? { status: "absent" } : measure(element);
  }
  return {
    schemaVersion: state.schemaVersion,
    capturedAt: new Date().toISOString(),
    configRevision: state.revision,
    configDigest: state.digest,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    zoom: currentZoomFactor(),
    devicePixelRatio: window.devicePixelRatio,
    surfaces: measured,
    resolvedTokens: collectResolvedTokens(),
  };
}

/**
 * The read-only, window-local presentation diagnostic entry point. It reads
 * the same registered renderer elements and the same applied store as the
 * Settings capture control and grants nothing else: no host filesystem, no
 * task, model or generic evaluation authority, no mutation surface.
 */
export interface PresentationWindowDiagnostics {
  /** Snapshot of the registered surfaces; null outside the desktop host. */
  readonly collectLayoutSnapshot: () => PresentationLayoutSnapshot | null;
  /** The applied presentation state, or null when none is applied. */
  readonly appliedState: () => PresentationAppliedState | null;
  /** The visible connection diagnostic, or null when healthy. */
  readonly connectionError: () => string | null;
}

const windowDiagnostics: PresentationWindowDiagnostics = {
  collectLayoutSnapshot,
  appliedState: presentationStore.get,
  connectionError: presentationConnectionError,
};

declare global {
  interface Window {
    readonly __dokkabiPresentationDiagnostics?: PresentationWindowDiagnostics;
  }
}

const DIAGNOSTICS_KEY = "__dokkabiPresentationDiagnostics" as const;

/** Installs the read-only diagnostic endpoint on this window, idempotently. */
export function installPresentationWindowDiagnostics(
  target: Window,
): PresentationWindowDiagnostics {
  if (target[DIAGNOSTICS_KEY] === undefined) {
    Object.defineProperty(target, DIAGNOSTICS_KEY, {
      value: windowDiagnostics,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  return windowDiagnostics;
}
