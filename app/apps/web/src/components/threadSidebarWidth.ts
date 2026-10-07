import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import { usePresentationState } from "../presentationStore";

export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

export interface ThreadSidebarNavigationConstraints {
  readonly minWidth: number;
  readonly defaultWidth: number;
  readonly maxWidth: number;
}

export interface ThreadSidebarConstraints {
  readonly minWidth: number;
  readonly defaultWidth: number;
  readonly maxWidth: number;
  /** Clamps any width (including a stored user preference) into range. */
  readonly clamp: (width: number) => number;
}

/**
 * Resolves the live sidebar constraints. With a presentation config the
 * navigation constraints apply, with the viewport bound derived from the
 * active conversation minimum rather than the legacy constant; without one
 * the legacy defaults (and any stored user width) are kept. A stored user
 * resize preference stays valid by clamping it into the active constraints
 * instead of discarding it.
 */
export function resolveThreadSidebarConstraints(
  layout: {
    readonly navigation: ThreadSidebarNavigationConstraints;
    readonly conversation: { readonly minWidth: number };
  } | null,
  viewportWidth: number,
  storedWidth: number | null,
): ThreadSidebarConstraints {
  if (layout === null) {
    const minWidth = THREAD_SIDEBAR_MIN_WIDTH;
    const maxWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
    const defaultWidth = Math.min(
      Math.max(storedWidth ?? THREAD_SIDEBAR_DEFAULT_WIDTH, minWidth),
      maxWidth,
    );
    return withClamp({ minWidth, defaultWidth, maxWidth });
  }
  const minWidth = layout.navigation.minWidth;
  const viewportMax = Math.max(minWidth, Math.floor(viewportWidth) - layout.conversation.minWidth);
  const maxWidth = Math.min(layout.navigation.maxWidth, viewportMax);
  const defaultWidth = Math.min(
    Math.max(storedWidth ?? layout.navigation.defaultWidth, minWidth),
    maxWidth,
  );
  return withClamp({ minWidth, defaultWidth, maxWidth });
}

function withClamp(constraints: {
  readonly minWidth: number;
  readonly defaultWidth: number;
  readonly maxWidth: number;
}): ThreadSidebarConstraints {
  return {
    ...constraints,
    clamp: (width: number) => Math.min(Math.max(width, constraints.minWidth), constraints.maxWidth),
  };
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readStoredSidebarWidth(): number | null {
  try {
    return getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite);
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return null;
  }
}

interface SidebarWidthState {
  readonly width: number;
  readonly fromUser: boolean;
}

/**
 * Live sidebar width with preference provenance. A width is a user choice
 * only when it was retained in storage or produced by a drag; the legacy
 * boot default is not. When the host presentation config arrives (or its
 * defaults change), the JSON navigation default applies only while no user
 * choice exists; a retained or dragged width is preserved by clamping into
 * the active constraints.
 */
export function useThreadSidebarWidth(): {
  readonly width: number;
  readonly constraints: ThreadSidebarConstraints;
  readonly setWidthFromDrag: (width: number) => void;
  readonly resetWidth: () => void;
} {
  const [state, setState] = useState<SidebarWidthState>(() => {
    const stored = readStoredSidebarWidth();
    return {
      width: resolveInitialThreadSidebarWidth(stored, window.innerWidth),
      fromUser: stored !== null,
    };
  });
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const presentationState = usePresentationState();
  const layout = presentationState?.config.layout ?? null;
  const constraints = useMemo(
    () => resolveThreadSidebarConstraints(layout, viewportWidth, null),
    [layout, viewportWidth],
  );
  useEffect(() => {
    setState((current) => ({
      width: current.fromUser ? constraints.clamp(current.width) : constraints.defaultWidth,
      fromUser: current.fromUser,
    }));
  }, [constraints]);
  const setWidthFromDrag = useCallback((width: number) => setState({ width, fromUser: true }), []);
  const resetWidth = useCallback(() => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setState({ width: constraints.defaultWidth, fromUser: false });
  }, [constraints]);
  return {
    width: constraints.clamp(state.width),
    constraints,
    setWidthFromDrag,
    resetWidth,
  };
}
