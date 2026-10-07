import type { Tone } from "./screen.ts";
import { charWidth, visibleWidth } from "./screen.ts";

/**
 * Drawing primitives shared by the board widgets.
 *
 * Every one of these turns a recorded number into cells. None of them invent
 * a value: a `missing` metric draws as the missing glyph, never as zero
 * (constitution 6 — the log is the truth, the screen only masks it as `-`).
 */

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
export const MISSING_CELL = "·";

/** Clip to a visible-width budget, never mid-wide-glyph. */
export function clip(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  let out = "";
  let used = 0;
  for (const glyph of text) {
    const w = charWidth(glyph);
    if (w === 0) {
      continue;
    }
    if (used + w > width) {
      return out;
    }
    out += glyph;
    used += w;
  }
  return out;
}

/** Clip with an ellipsis when the text does not fit. */
export function ellipsize(text: string, width: number): string {
  if (visibleWidth(text) <= width) {
    return text;
  }
  return `${clip(text, Math.max(0, width - 1))}…`;
}

export function padTo(text: string, width: number): string {
  const room = width - visibleWidth(text);
  return room > 0 ? text + " ".repeat(room) : clip(text, width);
}

/**
 * A sub-cell gauge. Full cells are `█`, the boundary cell carries one of the
 * eighth-block glyphs, so a 3% bar is visible instead of rounding to empty.
 */
export function gauge(ratio: number | undefined, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (ratio === undefined || !Number.isFinite(ratio)) {
    return MISSING_CELL.repeat(width);
  }
  const clamped = Math.max(0, Math.min(1, ratio));
  const exact = clamped * width;
  const full = Math.floor(exact);
  const rest = Math.round((exact - full) * 8);
  const head = "█".repeat(Math.min(width, full));
  const edge = full < width && rest > 0 ? EIGHTHS[rest] ?? "" : "";
  return padTo(head + edge, width).replaceAll(" ", "░");
}

export interface Segment {
  value: number;
  glyph: string;
  tone: Tone;
  label?: string;
}

/**
 * A single-row stacked bar. Segments keep their order and every non-zero
 * segment gets at least one cell, so a 2% slice does not silently vanish.
 */
export function stackBar(segments: readonly Segment[], width: number): { text: string; tones: Tone[] } {
  const tones: Tone[] = [];
  if (width <= 0) {
    return { text: "", tones };
  }
  const total = segments.reduce((sum, seg) => sum + Math.max(0, seg.value), 0);
  if (total <= 0) {
    return { text: MISSING_CELL.repeat(width), tones: Array.from({ length: width }, () => "muted" as Tone) };
  }
  const cells = segments.map((seg) => (seg.value > 0 ? Math.max(1, Math.round((seg.value / total) * width)) : 0));
  let over = cells.reduce((sum, value) => sum + value, 0) - width;
  // Shave the widest segments first so a rounding overshoot never eats a
  // small-but-present slice.
  while (over > 0) {
    let widest = 0;
    for (let i = 1; i < cells.length; i += 1) {
      if (cells[i]! > cells[widest]!) {
        widest = i;
      }
    }
    if (cells[widest]! <= 1) {
      break;
    }
    cells[widest]! -= 1;
    over -= 1;
  }
  let text = "";
  for (let i = 0; i < segments.length; i += 1) {
    for (let c = 0; c < cells[i]!; c += 1) {
      text += segments[i]!.glyph;
      tones.push(segments[i]!.tone);
    }
  }
  while (visibleWidth(text) < width) {
    text += "░";
    tones.push("barEmpty");
  }
  return { text: clip(text, width), tones: tones.slice(0, width) };
}

/** Right-aligned small number: `12`, `1.2k`, `3.4M`. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

export function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  // Decompose from whole rounded seconds so a near-minute value can never
  // render as an impossible 60s field.
  const total = Math.round(ms / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Age of something, coarsely, for the header's proof-of-life field.
 *
 * Seconds below a minute, then whole minutes, then hours and minutes. A
 * negative age (an observer whose clock trails the writer's) reads as zero
 * rather than as a time in the future.
 */
export function fmtAge(ms: number): string {
  const age = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (age < 60_000) {
    return `+${Math.floor(age / 1_000)}s`;
  }
  if (age < 3_600_000) {
    return `+${Math.floor(age / 60_000)}m`;
  }
  if (age < 86_400_000) {
    const hours = Math.floor(age / 3_600_000);
    const minutes = Math.floor((age % 3_600_000) / 60_000);
    return `+${hours}h${String(minutes).padStart(2, "0")}m`;
  }
  // Past a day the exact figure stops being operational and starts eating the
  // header: a log from last year read as `+24222h35m`.
  const days = Math.floor(age / 86_400_000);
  return days > 99 ? "+99d+" : `+${days}d`;
}

/** A horizontal latency bar scaled against the slowest peer in its group. */
export function latencyBar(value: number, max: number, width: number): string {
  if (width <= 0 || max <= 0) {
    return "";
  }
  return gauge(value / max, width);
}
