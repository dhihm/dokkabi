/**
 * Render-stable React ref bindings for presentation surface registration.
 *
 * React detaches a ref callback whose identity changed between renders by
 * calling the previous callback with null before attaching the new one with
 * the element. A per-render callback composed with a React state setter
 * therefore ping-pongs null/element state updates on every rerender until
 * React aborts with error #185 (maximum update depth) — the crash the
 * native app hit on draft/conversation entry. These hooks keep the callback
 * identity stable across presentation-driven rerenders while preserving
 * registration and real unmount cleanup.
 */
import { useCallback, useMemo } from "react";

import type { PresentationSurfaceId } from "@t3tools/contracts";

import { presentationSurfaceRef, setPresentationSurface } from "./presentationLayoutSnapshot";

/** Stable registration callback for a surface element owned by one component. */
export function usePresentationSurfaceRef(
  id: PresentationSurfaceId,
): (element: HTMLElement | null) => () => void {
  return useMemo(() => presentationSurfaceRef(id), [id]);
}

/**
 * Stable composed registration: forwards each attached element — or null on
 * a real unmount — to `onElement` (an existing state setter qualifies) and
 * registers it as presentation surface `id`. `onElement` must itself be
 * render-stable, or the composition inherits its instability.
 */
export function useComposedPresentationSurfaceRef<T extends HTMLElement>(
  id: PresentationSurfaceId,
  onElement: (element: T | null) => void,
): (element: T | null) => void {
  return useCallback(
    (element) => {
      onElement(element);
      setPresentationSurface(id, element);
    },
    [id, onElement],
  );
}
