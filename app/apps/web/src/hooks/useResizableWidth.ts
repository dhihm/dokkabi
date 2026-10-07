import * as Schema from "effect/Schema";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { useResizeDrag } from "./useResizeDrag";

const WidthSchema = Schema.Finite;

export interface UseResizableWidthOptions {
  /** localStorage key the persisted width is stored under. */
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  /**
   * Which edge of the host element carries the drag handle:
   *   - "left"  → panel grows leftward (right-anchored panels)
   *   - "right" → panel grows rightward (left-anchored panels)
   */
  readonly edge: "left" | "right";
}

export interface ResizableWidthHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Width state for a side-anchored panel resized via a drag handle on the
 * specified edge. Width is read on mount or storage-key changes and persisted on
 * drag-end (not on every rAF tick — would otherwise be ~60 writes/sec).
 *
 * The hook updates an internal `width` state during drag (so the panel
 * follows the cursor live) and only commits to localStorage when the user
 * lifts the pointer or the drag is interrupted.
 *
 * Width provenance: a width is a user choice only when it was retained in
 * storage or produced by a drag. A default (the initial `defaultWidth`
 * before the host config arrives) is not, so later `defaultWidth` changes —
 * for example the presentation right-panel default applying after the
 * config loads — reseed the width unless a real user choice exists; retained
 * and dragged widths are only ever clamped into the live bounds.
 */
export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;

  const clamp = useCallback(
    (value: number): number => {
      if (!Number.isFinite(value)) return defaultWidth;
      return Math.max(minWidth, Math.min(maxWidth, value));
    },
    [defaultWidth, maxWidth, minWidth],
  );

  const readStoredWidth = useCallback((): number | null => {
    if (typeof window === "undefined") return null;
    try {
      return getLocalStorageItem(storageKey, WidthSchema);
    } catch (error) {
      console.error("Could not read persisted panel width.", error);
      return null;
    }
  }, [storageKey]);

  interface WidthState {
    readonly storageKey: string;
    readonly width: number;
    readonly fromUser: boolean;
  }

  // No cross-tab subscription: panel width is per-window state.
  const [widthState, setWidthState] = useState<WidthState>(() => {
    const stored = readStoredWidth();
    return { storageKey, width: clamp(stored ?? defaultWidth), fromUser: stored !== null };
  });
  // Panels stay mounted across threads; restore the destination width before paint.
  if (widthState.storageKey !== storageKey) {
    const stored = readStoredWidth();
    setWidthState({ storageKey, width: clamp(stored ?? defaultWidth), fromUser: stored !== null });
  }
  // A changed default only reseeds the width while no user choice exists.
  useEffect(() => {
    setWidthState((current) =>
      current.fromUser ? current : { ...current, width: clamp(defaultWidth) },
    );
  }, [clamp, defaultWidth]);

  const clampedWidth = clamp(widthState.width);
  const latestOptions = useRef({ clamp, storageKey });
  useLayoutEffect(() => {
    latestOptions.current = { clamp, storageKey };
  }, [clamp, storageKey]);

  const handlers = useResizeDrag<HTMLElement>(
    () => ({
      width: clampedWidth,
      edge,
      resize(value) {
        const nextWidth = latestOptions.current.clamp(value);
        setWidthState({ storageKey, width: nextWidth, fromUser: true });
        return nextWidth;
      },
      finish(finalWidth) {
        // Commit once at drag-end to avoid 60Hz localStorage writes.
        try {
          setLocalStorageItem(latestOptions.current.storageKey, finalWidth, WidthSchema);
        } catch (error) {
          console.error("Could not persist panel width.", error);
        }
      },
    }),
    storageKey,
  );

  return { width: clampedWidth, handlers };
}
