import { charWidth } from "./screen.ts";

/**
 * Live TTY write. A Screen frame is exactly `rows` lines of `cols`
 * columns. Writing that last cell with autowrap on scrolls the header
 * off (operator: "the top prints, then it vanishes").
 *
 * This sequence homes, disables wrap, CUP-addresses each row, and
 * leaves the last cell of the last row unwritten.
 */

export function sliceVisible(text: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  let out = "";
  let used = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end !== -1) {
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const cp = text.codePointAt(i);
    if (cp === undefined) {
      break;
    }
    const glyph = String.fromCodePoint(cp);
    const width = charWidth(glyph);
    if (used + width > max) {
      break;
    }
    out += glyph;
    used += width;
    i += glyph.length;
  }
  return out;
}

export function ttyPaintSequence(frame: string, cols: number, rows: number, sync = true): string {
  const lines = frame.split("\n").slice(0, Math.max(1, rows));
  const parts: string[] = [];
  if (sync) {
    parts.push("\x1b[?2026h");
  }
  parts.push("\x1b[?7l");
  parts.push("\x1b[H");
  for (let i = 0; i < lines.length; i += 1) {
    const budget = i === lines.length - 1 ? Math.max(0, cols - 1) : cols;
    parts.push(`\x1b[${i + 1};1H`);
    parts.push(sliceVisible(lines[i] ?? "", budget));
  }
  parts.push("\x1b[J");
  parts.push("\x1b[0m");
  if (sync) {
    parts.push("\x1b[?2026l");
  }
  return parts.join("");
}

/**
 * Differential painter (#37 T4): keeps the previous frame and emits only
 * the rows that changed. Same encoding rules as ttyPaintSequence — wrap
 * off, CUP-addressed rows, last cell of the last row unwritten, sync
 * (2026) around the batch — but a one-row change writes one row, not all
 * of them. A repaint of an identical frame emits nothing (the caller's
 * identical-frame skip and this painter agree; the painter alone is enough
 * for correctness, the skip saves the render itself).
 */
export interface TtyPainter {
  /** Paint a full-frame string; returns the bytes to write (possibly ""). */
  paint(frame: string, cols?: number, rows?: number): string;
}

export function createTtyPainter(cols: number, rows: number): TtyPainter {
  let previous: string[] | undefined;
  let size = { cols, rows };
  return {
    paint(frame: string, nextCols?: number, nextRows?: number): string {
      const resized =
        (nextCols !== undefined && nextCols !== size.cols) ||
        (nextRows !== undefined && nextRows !== size.rows);
      const c = nextCols ?? size.cols;
      const r = nextRows ?? size.rows;
      const lines = frame.split("\n").slice(0, Math.max(1, r));
      if (resized) {
        previous = undefined;
        size = { cols: c, rows: r };
      }
      const first = previous === undefined;
      const parts: string[] = [];
      if (first) {
        parts.push("\x1b[?7l", "\x1b[H");
      }
      let wroteAny = false;
      for (let i = 0; i < lines.length; i += 1) {
        if (!first && previous![i] === lines[i]) {
          continue;
        }
        const budget = i === lines.length - 1 ? Math.max(0, c - 1) : c;
        parts.push(`\x1b[${i + 1};1H`, sliceVisible(lines[i] ?? "", budget));
        wroteAny = true;
      }
      if (previous !== undefined) {
        // Rows that vanished (frame shrank) are cleared individually.
        for (let i = lines.length; i < previous.length && i < r; i += 1) {
          parts.push(`\x1b[${i + 1};1H\x1b[2K`);
          wroteAny = true;
        }
      }
      if (!wroteAny && !first) {
        return "";
      }
      if (first) {
        parts.push("\x1b[J", "\x1b[0m");
      } else {
        parts.push("\x1b[0m");
      }
      previous = lines;
      const sync = process.env.DOKKABI_NO_SYNC !== "1";
      return (sync ? "\x1b[?2026h" : "") + parts.join("") + (sync ? "\x1b[?2026l" : "");
    },
  };
}
