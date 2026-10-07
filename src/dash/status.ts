import type { Tone } from "./screen.ts";

export interface StatusMark {
  glyph: string;
  label: string;
  tone: Tone;
}

/**
 * Todo state presentation. Glyphs are East Asian Wide (two terminal cells in
 * every mainstream terminal and in our own charWidth) so DAG grid math stays
 * aligned. Labels stay English per docs/language.md; the operator reads the
 * glyph first anyway.
 */
export const STATUS_MARKS: Record<string, StatusMark> = {
  ready: { glyph: "🔲", label: "ready", tone: "default" },
  doing: { glyph: "🔄", label: "doing", tone: "lane" },
  blocked: { glyph: "🚧", label: "blocked", tone: "muted" },
  red: { glyph: "❌", label: "failed", tone: "bad" },
  green: { glyph: "🟢", label: "verified", tone: "ok" },
  clear: { glyph: "✅", label: "done", tone: "ok" },
  missing: { glyph: "❓", label: "missing", tone: "muted" },
};

const BY_GLYPH = new Map<string, StatusMark>(Object.values(STATUS_MARKS).map((mark) => [mark.glyph, mark]));

export function statusMark(state: string | undefined): StatusMark {
  return STATUS_MARKS[state ?? "missing"] ?? STATUS_MARKS.missing!;
}

/** Glyph plus label, e.g. `✅ done`, for list surfaces with room. */
export function statusBadge(state: string | undefined): string {
  const mark = statusMark(state);
  return `${mark.glyph} ${mark.label}`;
}

/** Tone for a rendered line that starts with a status glyph, if any. */
export function toneForLine(line: string): Tone | undefined {
  const mark = BY_GLYPH.get([...line][0] ?? "");
  return mark?.tone;
}
