/**
 * The search match cursor (#dokkabi-dev#51).
 *
 * Counts where a query hits within one pane's lines and folds any cursor
 * value into that ring, so the footer can answer "which of how many" and the
 * cycling keys can wrap without special cases. No matches is an EMPTY cursor
 * — index undefined, never a fabricated 0 of 0.
 */

export interface MatchCursor {
  /** 0-based position in the match ring; undefined when nothing matched. */
  index: number | undefined;
  total: number;
}

export function matchCursor(
  lines: readonly { text: string }[],
  query: string | undefined,
  cursor: number | undefined,
): MatchCursor {
  if (!query) {
    return { index: undefined, total: 0 };
  }
  const needle = query.toLowerCase();
  const total = lines.filter((line) => line.text.toLowerCase().includes(needle)).length;
  if (total === 0) {
    return { index: undefined, total: 0 };
  }
  const base = cursor ?? 0;
  return { index: ((base % total) + total) % total, total };
}
