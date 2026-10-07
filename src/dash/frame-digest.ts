import { createHash } from "node:crypto";
import { projectDash } from "./project.ts";
import { renderDashScreen } from "./board.ts";
import type { EventRecord } from "../host/schema.ts";

/**
 * Replay frame parity (#37 T3): a board frame is a pure function of
 * (events, now, geometry). This module turns that claim into a mechanical
 * check — every event boundary produces one digest, with the clock dated at
 * the event that produced the frame, never at the wall clock of whoever is
 * replaying (constitution 5). `dokkabi replay --frames` prints the sequence;
 * two replays of the same log must agree byte for byte.
 */

export interface FrameDigestOptions {
  cols?: number;
  rows?: number;
  /** Log path, for headers that name the session. */
  path?: string;
}

function digestFrame(events: readonly EventRecord[], now: number, opts: FrameDigestOptions): string {
  const view = projectDash(events);
  const frame = renderDashScreen(view, {
    path: opts.path ?? "replay",
    replay: true,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    color: false,
    now,
  });
  return createHash("sha256").update(frame).digest("hex").slice(0, 16);
}

/**
 * One digest per event boundary, first to last. `now` for frame k is the
 * timestamp of event k, so the spinner, ages, and clocks render as they
 * would have on the live board at that moment.
 */
export function replayFrameDigests(events: readonly EventRecord[], opts: FrameDigestOptions = {}): string[] {
  const out: string[] = [];
  for (let k = 1; k <= events.length; k += 1) {
    const at = events[k - 1]!;
    out.push(digestFrame(events.slice(0, k), Date.parse(at.ts), opts));
  }
  return out;
}

/** Single-frame digest at the last event — the frame the live board paints now. */
export function currentFrameDigest(events: readonly EventRecord[], opts: FrameDigestOptions = {}): string {
  if (events.length === 0) {
    return digestFrame(events, 0, opts);
  }
  const last = events[events.length - 1]!;
  return digestFrame(events, Date.parse(last.ts), opts);
}
