import type { WidgetId } from "./widgets.ts";

/**
 * The board's geometry as data.
 *
 * Painting used to compute coordinates inline and immediately write cells, so
 * "does anything overlap?" could only be answered by looking at a screenshot,
 * and moving a pane meant editing paint code. A `LayoutFrame` is the whole
 * screen described before a single cell is written: every region that will be
 * drawn, where, and what it is for.
 *
 * That buys three things the paint path could not give:
 *
 * - overlap and out-of-bounds become machine checks (`checkLayout`),
 * - a frame serialises, so a board can be dumped, diffed and replayed,
 * - placement becomes a question about data rather than about control flow.
 *
 * A frame carries no colours and no text. Tones stay semantic (`theme.ts`)
 * and content stays with the widgets; this layer only answers "where".
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RegionKind =
  /** Fixed furniture: the title row, the model rows, the footer. */
  | "chrome"
  /** A bordered widget box. */
  | "pane"
  /** Drawn above everything else, e.g. the key map. */
  | "overlay";

export interface Region {
  /** Stable name: `chrome:title`, `pane:stream`. Unique within a frame. */
  id: string;
  kind: RegionKind;
  rect: Rect;
  /** Interior of a bordered pane — where the widget's lines go. */
  content?: Rect;
  title?: string;
  widget?: WidgetId;
  focused?: boolean;
  /** Higher paints later. Regions only conflict within one layer. */
  z?: number;
}

export interface LayoutFrame {
  cols: number;
  rows: number;
  regions: Region[];
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function layerOf(region: Region): number {
  return region.z ?? (region.kind === "overlay" ? 10 : 0);
}

/**
 * Everything wrong with a frame, as readable lines. Empty means the frame is
 * paintable: inside the screen, non-overlapping within each layer, and with
 * every pane's content inside its own border.
 */
export function checkLayout(frame: LayoutFrame): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const region of frame.regions) {
    if (seen.has(region.id)) {
      problems.push(`duplicate region id ${region.id}`);
    }
    seen.add(region.id);
    const { x, y, w, h } = region.rect;
    if (w < 0 || h < 0) {
      problems.push(`${region.id} has negative size ${w}x${h}`);
    }
    if (x < 0 || y < 0 || x + w > frame.cols || y + h > frame.rows) {
      problems.push(`${region.id} escapes the screen: ${x},${y} ${w}x${h} outside ${frame.cols}x${frame.rows}`);
    }
    if (region.content && !contains(region.rect, region.content)) {
      problems.push(`${region.id} draws content outside its own border`);
    }
  }
  for (let i = 0; i < frame.regions.length; i += 1) {
    for (let j = i + 1; j < frame.regions.length; j += 1) {
      const a = frame.regions[i]!;
      const b = frame.regions[j]!;
      if (layerOf(a) !== layerOf(b)) {
        continue;
      }
      if (overlaps(a.rect, b.rect)) {
        problems.push(`${a.id} overlaps ${b.id}`);
      }
    }
  }
  return problems;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function frameToJson(frame: LayoutFrame): string {
  return `${JSON.stringify(frame, null, 2)}\n`;
}

export function frameFromJson(text: string): LayoutFrame {
  const parsed = JSON.parse(text) as LayoutFrame;
  if (typeof parsed?.cols !== "number" || typeof parsed?.rows !== "number" || !Array.isArray(parsed.regions)) {
    throw new Error("not a layout frame: needs cols, rows and regions");
  }
  return parsed;
}

/** A frame as a text map, one line per row — a readable diff of a board. */
export function frameAscii(frame: LayoutFrame): string {
  const grid = Array.from({ length: frame.rows }, () => Array.from({ length: frame.cols }, () => "."));
  const ordered = [...frame.regions].sort((a, b) => layerOf(a) - layerOf(b));
  for (let index = 0; index < ordered.length; index += 1) {
    const region = ordered[index]!;
    // One letter per region keeps a 240-column board readable.
    const mark = String.fromCharCode(97 + (index % 26));
    for (let y = region.rect.y; y < region.rect.y + region.rect.h; y += 1) {
      for (let x = region.rect.x; x < region.rect.x + region.rect.w; x += 1) {
        if (grid[y]?.[x] !== undefined) {
          grid[y]![x] = mark;
        }
      }
    }
  }
  const legend = ordered
    .map((region, index) => `${String.fromCharCode(97 + (index % 26))} ${region.id}`)
    .join("\n");
  return `${grid.map((row) => row.join("")).join("\n")}\n\n${legend}\n`;
}
