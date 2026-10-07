import { charWidth, visibleWidth, wrapText, type Tone } from "./screen.ts";

/**
 * The markdown a model actually writes into a reply.
 *
 * The stream printed backticks, fences, asterisks and pipes verbatim, so the
 * one thing the model marked up — the path, the regex, the emphasis, the table
 * it built for the operator — read exactly like the prose around it. This is
 * not a markdown implementation: it covers inline code, emphasis, links,
 * fenced blocks, lists (nested), headings, quotes and pipe tables, because
 * those are what shows up, and leaves everything else as prose.
 *
 * Output carries per-cell tones so a span can differ from its line without
 * the renderer having to parse anything.
 */

export interface MarkdownLine {
  text: string;
  tone: Tone;
  /** Per-cell tones, one per code point of `text`. */
  cells?: Tone[];
}

/** A tone for one code point, or null to inherit the line's tone. */
type Mark = Tone | null;

interface Inline {
  text: string;
  marks: Mark[];
}

/** Bullet glyph per nesting depth; deeper levels reuse the last. */
const BULLETS = ["•", "◦", "▪", "▫"];
/** Columns of source indent that make one list level. */
const INDENT_STEP = 2;
/** A table column never shrinks below this before the table gives up. */
const COLUMN_MIN = 3;
/** What separates two table columns: space, bar, space. */
const COLUMN_GAP = " │ ";

export function renderMarkdown(markdown: string, width: number): MarkdownLine[] {
  const w = Math.max(4, width);
  const out: MarkdownLine[] = [];
  const rows = markdown.replaceAll("\t", "    ").split("\n");
  let fence: { open: boolean; language?: string } = { open: false };

  for (let i = 0; i < rows.length; ) {
    const row = rows[i]!;
    const fenceAt = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/.exec(row);
    if (fenceAt) {
      if (fence.open) {
        fence = { open: false };
      } else {
        fence = { open: true, language: fenceAt[1] || undefined };
        if (fence.language) {
          out.push({ text: clip(`  ${fence.language}`, w), tone: "muted" });
        }
      }
      i += 1;
      continue;
    }
    if (fence.open) {
      // Code keeps its own spacing; it is clipped rather than reflowed,
      // because a wrapped line of code is a lie about the file.
      out.push({ text: clip(`  ${row}`, w), tone: "thought" });
      i += 1;
      continue;
    }
    const table = readTable(rows, i);
    if (table) {
      out.push(...renderTable(table, w));
      i = table.next;
      continue;
    }
    out.push(...renderProse(row, w));
    i += 1;
  }
  return out;
}

function renderProse(row: string, width: number): MarkdownLine[] {
  const heading = /^\s*(#{1,6})\s+(.*)$/.exec(row);
  if (heading) {
    return inlineWrap(heading[2]!, width, "accent", "");
  }
  // A quote keeps its bar and its text undimmed: the model quotes an error or
  // a spec line because the words matter, not to whisper them.
  const quote = /^\s*((?:>\s?)+)(.*)$/.exec(row);
  if (quote) {
    const depth = (quote[1]!.match(/>/g) ?? []).length;
    return inlineWrap(quote[2]!, width, "default", "│ ".repeat(depth), "box");
  }
  const bullet = /^([ ]*)[-*+][ ]+(.*)$/.exec(row);
  if (bullet) {
    const depth = listDepth(bullet[1]!);
    const glyph = BULLETS[Math.min(depth, BULLETS.length - 1)]!;
    return inlineWrap(bullet[2]!, width, "default", `${pad(depth)}${glyph} `);
  }
  const numbered = /^([ ]*)(\d+)[.)][ ]+(.*)$/.exec(row);
  if (numbered) {
    const depth = listDepth(numbered[1]!);
    return inlineWrap(numbered[3]!, width, "default", `${pad(depth)}${numbered[2]}. `);
  }
  if (row.trim().length === 0) {
    return [{ text: "", tone: "default" }];
  }
  return inlineWrap(row, width, "default", "");
}

const listDepth = (indent: string): number => Math.floor(indent.length / INDENT_STEP);
const pad = (depth: number): string => " ".repeat(depth * INDENT_STEP);

/**
 * Wrap one logical line, keeping marked spans marked and indenting
 * continuations under the marker so a list stays a list.
 */
function inlineWrap(
  source: string,
  width: number,
  tone: Tone,
  marker: string,
  markerTone: Tone = tone,
): MarkdownLine[] {
  const { text, marks } = parseInline(source);
  const all = [...text];
  const markerWidth = visibleWidth(marker);
  const indent = " ".repeat(markerWidth);
  const body = Math.max(2, width - markerWidth);
  const wrapped = wrapText(text, body);
  const out: MarkdownLine[] = [];
  let consumed = 0;
  for (let i = 0; i < wrapped.length; i += 1) {
    const chunk = wrapped[i]!;
    const prefix = i === 0 ? marker : indent;
    const glyphs = [...chunk];
    // wrapText drops the space it broke on; track it so the marked spans of
    // later chunks still line up with the original string. Positions count
    // code points, never UTF-16 units: one emoji ahead of a `span` used to
    // shift its highlight by one character for every surrogate pair.
    const at = findGlyphs(all, glyphs, consumed);
    consumed = at + glyphs.length;
    const cells: Tone[] = [];
    for (const _ of [...prefix]) {
      cells.push(i === 0 ? markerTone : tone);
    }
    for (let g = 0; g < glyphs.length; g += 1) {
      cells.push(marks[at + g] ?? tone);
    }
    const full = clip(prefix + chunk, width);
    out.push({ text: full, tone, cells: cells.slice(0, [...full].length) });
  }
  return out.length > 0 ? out : [{ text: clip(marker, width), tone }];
}

/** Punctuation a backslash may escape back into ordinary text. */
const ESCAPABLE = new Set(["\\", "`", "*", "_", "[", "]", "(", ")", "#", "|", ">", "~"]);

/**
 * Strip the markup and report which code point carries which tone.
 *
 * Code spans win outright — inside backticks an asterisk is an asterisk.
 * Emphasis opens only when a matching closer exists ahead and the run sits at
 * a word edge, so `_command_re` and `2 * 3` survive as the model typed them
 * instead of turning into emphasis that swallows the rest of the line.
 */
function parseInline(source: string): Inline {
  const g = [...source];
  const text: string[] = [];
  const marks: Mark[] = [];
  const stack: Tone[] = [];
  const top = (): Mark => (stack.length > 0 ? stack[stack.length - 1]! : null);
  const emit = (glyph: string, tone: Mark): void => {
    text.push(glyph);
    marks.push(tone);
  };

  let i = 0;
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === "\\" && i + 1 < g.length && ESCAPABLE.has(g[i + 1]!)) {
      emit(g[i + 1]!, top());
      i += 2;
      continue;
    }
    if (ch === "`") {
      const close = g.indexOf("`", i + 1);
      if (close > i) {
        for (let j = i + 1; j < close; j += 1) {
          emit(g[j]!, "lane");
        }
        i = close + 1;
        continue;
      }
    }
    if (ch === "<") {
      const close = g.indexOf(">", i + 1);
      const inner = close > i ? g.slice(i + 1, close).join("") : "";
      if (close > i && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(inner)) {
        for (const c of inner) {
          emit(c, "link");
        }
        i = close + 1;
        continue;
      }
    }
    if (ch === "[") {
      const link = readLink(g, i);
      if (link) {
        for (const c of [...link.label]) {
          emit(c, "link");
        }
        // The terminal cannot follow a link, so the address is the useful
        // half. It is kept unless the label already is the address.
        if (link.url.length > 0 && link.url !== link.label) {
          for (const c of ` (${link.url})`) {
            emit(c, "muted");
          }
        }
        i = link.next;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const run = g[i + 1] === ch ? 2 : 1;
      const tone: Tone = run === 2 ? "strong" : "emph";
      if (top() === tone && closes(g, i, ch, run)) {
        stack.pop();
        i += run;
        continue;
      }
      if (top() !== tone && opens(g, i, ch, run)) {
        stack.push(tone);
        i += run;
        continue;
      }
    }
    emit(ch, top());
    i += 1;
  }
  return { text: text.join(""), marks };
}

const isWord = (glyph: string | undefined): boolean => glyph !== undefined && /[\p{L}\p{N}_]/u.test(glyph);
const isSpace = (glyph: string | undefined): boolean => glyph === undefined || /\s/u.test(glyph);

/** A run opens emphasis only if the span it would start is actually closed. */
function opens(g: readonly string[], at: number, ch: string, run: number): boolean {
  if (isSpace(g[at + run])) {
    return false;
  }
  if (ch === "_" && isWord(g[at - 1])) {
    return false;
  }
  for (let i = at + run; i < g.length; i += 1) {
    if (g[i] === ch && (run === 1 || g[i + 1] === ch) && closes(g, i, ch, run)) {
      return true;
    }
  }
  return false;
}

/** A run closes emphasis only from the inside of a word-edged span. */
function closes(g: readonly string[], at: number, ch: string, run: number): boolean {
  if (isSpace(g[at - 1])) {
    return false;
  }
  return !(ch === "_" && isWord(g[at + run]));
}

/** `[label](url)`, tolerating brackets inside the label. */
function readLink(g: readonly string[], at: number): { label: string; url: string; next: number } | null {
  let depth = 0;
  let i = at;
  for (; i < g.length; i += 1) {
    if (g[i] === "[") {
      depth += 1;
    } else if (g[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  if (i >= g.length || g[i + 1] !== "(") {
    return null;
  }
  const close = g.indexOf(")", i + 2);
  if (close < 0) {
    return null;
  }
  return {
    label: g.slice(at + 1, i).join(""),
    url: g.slice(i + 2, close).join("").trim(),
    next: close + 1,
  };
}

/** Where `needle` sits in `all`, counted in code points, at or after `from`.
 * Falls back to `from` so a chunk wrapText reshaped never throws off the rest. */
function findGlyphs(all: readonly string[], needle: readonly string[], from: number): number {
  for (let i = from; i + needle.length <= all.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (all[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      return i;
    }
  }
  return from;
}

type Align = "left" | "right" | "center";

interface TableAt {
  header: string[];
  align: Align[];
  body: string[][];
  next: number;
}

/** A pipe table is a header row, a dashed rule, and rows until the pipes stop. */
function readTable(rows: readonly string[], at: number): TableAt | null {
  const head = rows[at];
  const rule = rows[at + 1];
  if (head === undefined || rule === undefined || !head.includes("|")) {
    return null;
  }
  if (!rule.includes("-") || !/^[\s:|-]+$/.test(rule) || !rule.includes("|")) {
    return null;
  }
  const header = splitRow(head);
  const marks = splitRow(rule);
  const align: Align[] = header.map((_, i) => {
    const cell = marks[i] ?? "";
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
  const body: string[][] = [];
  let i = at + 2;
  for (; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!row.includes("|") || row.trim().length === 0) {
      break;
    }
    body.push(splitRow(row));
  }
  return { header, align, body, next: i };
}

function splitRow(row: string): string[] {
  let text = row.trim();
  if (text.startsWith("|")) {
    text = text.slice(1);
  }
  if (text.endsWith("|")) {
    text = text.slice(0, -1);
  }
  return text.split("|").map((cell) => cell.trim());
}

/**
 * Lay the table out at its natural column widths, then take columns off the
 * widest until the whole thing fits. A table the operator cannot read across
 * is worth less than one whose longest cell ends in an ellipsis.
 */
function renderTable(table: TableAt, width: number): MarkdownLine[] {
  const cols = table.header.length;
  const rows = [table.header, ...table.body].map((row) =>
    Array.from({ length: cols }, (_, c) => parseInline(row[c] ?? "")),
  );
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, ...rows.map((row) => visibleWidth(row[c]!.text))),
  );
  const gap = (cols - 1) * visibleWidth(COLUMN_GAP);
  let total = widths.reduce((sum, each) => sum + each, 0) + gap;
  while (total > width) {
    const widest = widths.indexOf(Math.max(...widths));
    const widestWidth = widths[widest];
    if (widestWidth === undefined || widestWidth <= COLUMN_MIN) {
      break;
    }
    widths[widest] = widestWidth - 1;
    total -= 1;
  }
  const out: MarkdownLine[] = [];
  out.push(tableRow(rows[0]!, widths, table.align, "title", width));
  out.push(tableRule(widths, width));
  for (const row of rows.slice(1)) {
    out.push(tableRow(row, widths, table.align, "default", width));
  }
  return out;
}

function tableRow(
  cells: readonly Inline[],
  widths: readonly number[],
  align: readonly Align[],
  base: Tone,
  width: number,
): MarkdownLine {
  let text = "";
  const tones: Tone[] = [];
  for (let c = 0; c < widths.length; c += 1) {
    if (c > 0) {
      for (const glyph of COLUMN_GAP) {
        text += glyph;
        tones.push("box");
      }
    }
    const cell = clipCell(cells[c] ?? { text: "", marks: [] }, widths[c]!);
    const slack = Math.max(0, widths[c]! - visibleWidth(cell.text));
    const before = align[c] === "right" ? slack : align[c] === "center" ? Math.floor(slack / 2) : 0;
    for (let k = 0; k < before; k += 1) {
      text += " ";
      tones.push(base);
    }
    const glyphs = [...cell.text];
    for (let k = 0; k < glyphs.length; k += 1) {
      text += glyphs[k]!;
      tones.push(cell.marks[k] ?? base);
    }
    for (let k = 0; k < slack - before; k += 1) {
      text += " ";
      tones.push(base);
    }
  }
  const full = clip(text, width);
  return { text: full, tone: base, cells: tones.slice(0, [...full].length) };
}

function tableRule(widths: readonly number[], width: number): MarkdownLine {
  const bar = widths.map((each) => "─".repeat(each)).join("─┼─");
  return { text: clip(bar, width), tone: "box" };
}

function clipCell(cell: Inline, width: number): Inline {
  if (visibleWidth(cell.text) <= width) {
    return cell;
  }
  const glyphs = [...cell.text];
  const text: string[] = [];
  const marks: Mark[] = [];
  let used = 0;
  for (let i = 0; i < glyphs.length; i += 1) {
    const size = charWidth(glyphs[i]!);
    if (used + size > width - 1) {
      break;
    }
    text.push(glyphs[i]!);
    marks.push(cell.marks[i] ?? null);
    used += size;
  }
  text.push("…");
  marks.push("muted");
  return { text: text.join(""), marks };
}

function clip(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const glyph of text) {
    const size = charWidth(glyph);
    if (used + size > width) {
      break;
    }
    out += glyph;
    used += size;
  }
  return out;
}
