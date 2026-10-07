export type StreamScrollInput = {
  readonly total: number;
  readonly viewport: number;
  readonly offset: number;
  readonly pinned: boolean;
  readonly grewBy?: number;
  readonly userDelta?: number;
};

export type StreamScrollState = {
  readonly offset: number;
  readonly pinned: boolean;
};

/**
 * Stick-to-bottom unless the operator has scrolled up. A follow-on paint
 * that grew the stream only moves the window when pinned. Returning to
 * the last page pins again.
 */
export function nextStreamOffset(input: StreamScrollInput): number | StreamScrollState {
  const total = input.total + (input.grewBy ?? 0);
  const max = Math.max(0, total - input.viewport);
  let offset = Math.min(Math.max(0, input.offset), max);
  let pinned = input.pinned;
  if (input.userDelta !== undefined) {
    offset = Math.min(Math.max(0, offset + input.userDelta), max);
    pinned = offset >= max;
    return { offset, pinned };
  }
  if (pinned) {
    offset = max;
  }
  return offset;
}
