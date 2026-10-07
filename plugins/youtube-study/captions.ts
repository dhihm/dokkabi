/**
 * Caption acquisition seam for the youtube-study package.
 *
 * v1 ships exactly one adapter: parsing a subtitle file the operator already
 * has (`.vtt`, `.srt`, or the neutral JSON capture form). There is no
 * network fetcher here — see LEGAL_REVIEW.md in dhihm/malgwi.
 * An experimental fetcher, if ever added, must implement CaptionAdapter and
 * stay an isolated, off-by-default package change.
 */
import { validateCaptions, type CaptionLine } from "./lesson-lib.ts";

export type CaptionFormat = "vtt" | "srt" | "json";

export interface CaptionAdapter {
  readonly id: string;
  collect(source: string): Promise<readonly CaptionLine[]>;
}

export function detectCaptionFormat(path: string): CaptionFormat | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".vtt")) return "vtt";
  if (lower.endsWith(".srt")) return "srt";
  if (lower.endsWith(".json")) return "json";
  return undefined;
}

const VTT_TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/u;
const CUE_SEPARATOR = /\s+--?>\s+/u;
/** Inline markup: voice/class spans and mid-cue timestamps. */
const INLINE_TAGS = /<\/?[^>]*>/gu;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * YouTube caption exports leave text HTML-escaped (`&gt;&gt;` speaker
 * markers, `&#39;` apostrophes). Decode entities so the capture holds the
 * text as spoken; `&amp;` is decoded last so double escapes cannot smuggle
 * markup through.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(lt|gt|quot|apos|nbsp);/giu, (_, name: string) => NAMED_ENTITIES[name.toLowerCase()]!)
    .replace(/&amp;/giu, "&");
}

function parseTimestamp(raw: string): number | undefined {
  const match = VTT_TIME.exec(raw.trim());
  if (!match) return undefined;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseInt(match[3]!, 10);
  const millis = Number.parseInt(match[4]!, 10);
  if (minutes >= 60 || seconds >= 60) return undefined;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function cleanCueText(rawLines: readonly string[]): string {
  return rawLines
    .map((line) => line.replace(INLINE_TAGS, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function parseCueBlocks(text: string): CaptionLine[] {
  const lines: CaptionLine[] = [];
  const blocks = text.replace(/\r\n?/gu, "\n").split(/\n{2,}/u);
  for (const block of blocks) {
    const blockLines = block.split("\n");
    const timingIndex = blockLines.findIndex((line) => CUE_SEPARATOR.test(line));
    if (timingIndex === -1) continue;
    const [rawStart, rawEnd] = blockLines[timingIndex]!.split(CUE_SEPARATOR, 2);
    const start = parseTimestamp(rawStart ?? "");
    // Cue settings such as "align:start" may follow the end timestamp.
    const end = parseTimestamp((rawEnd ?? "").split(/\s+/u, 1)[0] ?? "");
    if (start === undefined || end === undefined) continue;
    const cueText = cleanCueText(blockLines.slice(timingIndex + 1));
    if (cueText.length === 0) continue;
    lines.push({ start_ms: start, end_ms: end, text: cueText });
  }
  return lines;
}

/**
 * Parse caption text into the validated capture form. Ordering and shape
 * problems throw instead of being silently repaired, so a bad source is
 * visible at inspect time rather than inside a built page.
 */
export function parseCaptions(text: string, format: CaptionFormat): CaptionLine[] {
  const parsed = format === "json" ? (JSON.parse(text) as unknown) : parseCueBlocks(text);
  const lines = validateCaptions(parsed);
  // Re-validate so an entity-only cue cannot decode into an empty line.
  return validateCaptions(lines.map((line) => ({ ...line, text: decodeHtmlEntities(line.text).trim() })));
}
