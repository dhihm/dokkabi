export type Tone =
  | "default"
  | "muted"
  | "ember"
  | "ok"
  | "bad"
  | "title"
  | "box"
  | "header"
  | "banner"
  | "bar"
  | "barEmpty"
  | "lane"
  | "thought"
  | "spin"
  | "diffAdd"
  | "diffDel"
  /** Search hit inside a pane body. */
  | "match"
  /** Border and title of the focused pane. */
  | "focus"
  /** A number that carries the headline of its pane. */
  | "accent"
  /** The operator's own words (user message in the stream). */
  | "user"
  /** Dim companions of the lane tones: the area under a chart stroke. */
  | "emberDim"
  | "titleDim"
  | "laneDim"
  | "badDim"
  | "okDim"
  /** Chart lanes. Separate from the text tones so a chart can carry real hue
   * separation without turning inline code or a tool line vivid. */
  | "chartInput"
  | "chartInputDim"
  | "chartModel"
  | "chartModelDim"
  | "chartTool"
  | "chartToolDim"
  | "chartBad"
  | "chartBadDim"
  /** Markdown **bold** in a model reply. */
  | "strong"
  /** Markdown _italic_ in a model reply. */
  | "emph"
  /** The label of a markdown link. */
  | "link";

/**
 * The quiet companion of a tone.
 *
 * A filled chart used one flat grey under every stroke, so a board with four
 * lanes on it still read as one colour. The area now carries its lane at a
 * lower intensity and the stroke stays the bright edge of the same hue.
 *
 * Idempotent: an already-quiet tone is its own companion. Charts dim the
 * stroke tone for their fill, and a stroke that was already dim (the
 * timeline's idle columns) must not fall through to flat grey one dim
 * later.
 */
const DIM: Partial<Record<Tone, Tone>> = {
  ember: "emberDim",
  emberDim: "emberDim",
  title: "titleDim",
  titleDim: "titleDim",
  lane: "laneDim",
  laneDim: "laneDim",
  bad: "badDim",
  badDim: "badDim",
  ok: "okDim",
  okDim: "okDim",
  chartInput: "chartInputDim",
  chartInputDim: "chartInputDim",
  chartModel: "chartModelDim",
  chartModelDim: "chartModelDim",
  chartTool: "chartToolDim",
  chartToolDim: "chartToolDim",
  chartBad: "chartBadDim",
  chartBadDim: "chartBadDim",
  muted: "box",
  box: "box",
};

export function dimTone(tone: Tone): Tone {
  return DIM[tone] ?? "muted";
}

const RESET = "\x1b[0m";

import { activeTheme, type DokkabiTheme } from "./theme.ts";

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0) {
    return 0;
  }
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) {
    return 0;
  }
  if (cp >= 0x300 && cp <= 0x36f) {
    return 0;
  }
  if (cp >= 0x20d0 && cp <= 0x20ff) {
    return 0;
  }
  if (cp >= 0xfe00 && cp <= 0xfe0f) {
    return 0;
  }
  if (cp >= 0x2500 && cp <= 0x259f) {
    return 1;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2705 ||
    cp === 0x274c ||
    cp === 0x2753 ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of plain) {
    width += charWidth(ch);
  }
  return width;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const glyph of text) {
    const next = charWidth(glyph);
    if (next === 0) {
      continue;
    }
    if (used + next > width && current.length > 0) {
      const space = current.lastIndexOf(" ");
      if (space > 0) {
        lines.push(current.slice(0, space));
        current = current.slice(space + 1);
        used = visibleWidth(current);
      } else {
        lines.push(current);
        current = "";
        used = 0;
      }
    }
    current += glyph;
    used += next;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

export class Screen {
  readonly cols: number;
  readonly rows: number;
  private readonly ch: string[];
  private readonly tone: Tone[];

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    const n = this.cols * this.rows;
    this.ch = Array.from({ length: n }, () => " ");
    this.tone = Array.from({ length: n }, () => "default" as Tone);
  }

  private at(x: number, y: number): number {
    return y * this.cols + x;
  }

  fill(x: number, y: number, w: number, h: number, glyph: string, tone: Tone = "default"): void {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) {
        this.set(col, row, glyph, tone);
      }
    }
  }

  set(x: number, y: number, glyph: string, tone: Tone = "default"): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) {
      return;
    }
    if (x > 0) {
      const left = this.ch[this.at(x - 1, y)] ?? " ";
      if (charWidth(left) === 2) {
        this.ch[this.at(x - 1, y)] = " ";
        this.tone[this.at(x - 1, y)] = "default";
      }
    }
    const width = charWidth(glyph);
    if (width === 2 && x + 1 >= this.cols) {
      this.ch[this.at(x, y)] = " ";
      this.tone[this.at(x, y)] = tone;
      return;
    }
    this.ch[this.at(x, y)] = glyph;
    this.tone[this.at(x, y)] = tone;
    if (width === 2) {
      this.ch[this.at(x + 1, y)] = "";
      this.tone[this.at(x + 1, y)] = tone;
      return;
    }
    if (glyph !== "" && x + 1 < this.cols && this.ch[this.at(x + 1, y)] === "") {
      this.ch[this.at(x + 1, y)] = " ";
      this.tone[this.at(x + 1, y)] = "default";
    }
  }

  /** Override one cell's tone in place — the selection highlight. */
  retone(x: number, y: number, tone: Tone): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) {
      return;
    }
    this.tone[this.at(x, y)] = tone;
  }

  /** The text between two columns of one row, wide-glyph aware, for the
   * application-owned selection's clipboard copy. */
  rowSlice(y: number, x1: number, x2: number): string {
    if (y < 0 || y >= this.rows) {
      return "";
    }
    let out = "";
    for (let x = Math.max(0, x1); x <= Math.min(this.cols - 1, x2); x += 1) {
      const glyph = this.ch[this.at(x, y)] ?? " ";
      if (glyph === "") continue; // wide-glyph continuation cell
      out += glyph;
    }
    return out.replace(/\s+$/u, "");
  }

  /** The glyph currently at a cell, for chrome that repaints over itself. */
  glyphAt(x: number, y: number): string | undefined {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) {
      return undefined;
    }
    return this.ch[this.at(x, y)];
  }

  text(x: number, y: number, maxWidth: number, value: string, tone: Tone = "default"): number {
    if (maxWidth <= 0 || y < 0 || y >= this.rows) {
      return 0;
    }
    let col = 0;
    for (const glyph of value) {
      const width = charWidth(glyph);
      if (width === 0) {
        continue;
      }
      if (col + width > maxWidth) {
        break;
      }
      this.set(x + col, y, glyph, tone);
      col += width;
    }
    return col;
  }

  box(x: number, y: number, w: number, h: number, title?: string, titleTone: Tone = "title"): void {
    if (w < 2 || h < 2) {
      return;
    }
    this.set(x, y, "┌", "box");
    this.set(x + w - 1, y, "┐", "box");
    this.set(x, y + h - 1, "└", "box");
    this.set(x + w - 1, y + h - 1, "┘", "box");
    for (let i = 1; i < w - 1; i += 1) {
      this.set(x + i, y, "─", "box");
      this.set(x + i, y + h - 1, "─", "box");
    }
    for (let j = 1; j < h - 1; j += 1) {
      this.set(x, y + j, "│", "box");
      this.set(x + w - 1, y + j, "│", "box");
    }
    if (title) {
      this.text(x + 2, y, Math.max(0, w - 4), ` ${title} `, titleTone);
    }
  }

  render(color: boolean, theme: DokkabiTheme = activeTheme()): string {
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y += 1) {
      let line = "";
      let current: Tone | undefined;
      for (let x = 0; x < this.cols; x += 1) {
        const glyph = this.ch[this.at(x, y)];
        if (glyph === "") {
          continue;
        }
        const tone = this.tone[this.at(x, y)] ?? "default";
        if (color) {
          if (tone !== current) {
            if (current && current !== "default") {
              line += RESET;
            }
            if (tone !== "default") {
              line += theme.tones[tone] ?? "";
            }
            current = tone;
          }
        }
        line += glyph ?? " ";
      }
      if (color && current && current !== "default") {
        line += RESET;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }
}
