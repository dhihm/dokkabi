export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";

/**
 * Derives the inline-vs-sheet media query from the presentation's inline
 * breakpoint: at the breakpoint and above the right panel renders inline;
 * below it, the sheet/drawer takes over. The legacy constant above remains
 * the default when no presentation is applied.
 */
export function rightPanelInlineSheetMediaQuery(inlineBreakpoint: number): string {
  return `(max-width: ${Math.max(0, Math.floor(inlineBreakpoint) - 1)}px)`;
}
