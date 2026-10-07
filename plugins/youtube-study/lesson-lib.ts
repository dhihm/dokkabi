/**
 * lesson-v2 data contract shared by the compiler, the tests, and any host
 * adapter that embeds the pinned runtime. Zero runtime dependencies.
 *
 * A lesson pairs one source-language video with one study language: the
 * model authors `pronunciation` (source speech rendered in the learner's
 * script) and `translation` (learner's language); original text and
 * timecodes are bound to the capture via `source_digest`. Documents in the
 * legacy Korean-only v1 shape are upgraded transparently.
 */
import { createHash } from "node:crypto";

export const LESSON_SCHEMA_VERSION = 2;

/** One subtitle line captured from the source video. */
export interface CaptionLine {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
}

/** One study line: captured original plus model-authored study fields. */
export interface LessonLine {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly original: string;
  readonly pronunciation: string;
  readonly translation: string;
  /**
   * Model-authored sentence boundary: true = a sentence ends with this
   * cue, false = it definitely continues, omitted = display-time
   * heuristics decide. Partial annotation is expected.
   */
  readonly sentence_end?: boolean;
}

export interface LessonVideo {
  readonly provider: "youtube";
  readonly video_id: string;
  readonly source_language: string;
  readonly title?: string;
}

export interface LessonDisplay {
  /**
   * "embed" plays the video in the page through the YouTube IFrame player
   * with current-line sync. "sheet" renders the study lines standalone —
   * no player, no IFrame API; each line links out to the video timestamp.
   */
  readonly mode: "embed" | "sheet";
}

/** Model-authored gloss for one normalized word or short phrase. */
export interface GlossaryEntry {
  readonly word: string;
  readonly meaning: string;
}

export interface LessonV2 {
  readonly schema_version: typeof LESSON_SCHEMA_VERSION;
  readonly video: LessonVideo;
  /** The learner's language; pronunciation, translation, glossary
   * meanings, and the runtime UI all follow it. */
  readonly study_language: string;
  /** Omitted means "embed". */
  readonly display?: LessonDisplay;
  /** SHA-256 over the canonical captured caption list. Binds `original`. */
  readonly source_digest: string;
  readonly lines: readonly LessonLine[];
  /** Optional vocabulary glosses; usage examples come from the lines. */
  readonly glossary?: readonly GlossaryEntry[];
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
/** Unicode-aware: Latin words, CJK sequences, or short phrases. */
const GLOSSARY_WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*(?: [\p{L}\p{N}'’-]+){0,3}$/u;

export class LessonValidationError extends Error {
  override readonly name = "LessonValidationError";
}

function fail(message: string): never {
  throw new LessonValidationError(message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer of milliseconds`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has unknown key "${key}"`);
  }
}

/** Validate an untrusted value as a caption capture list. */
export function validateCaptions(value: unknown): CaptionLine[] {
  if (!Array.isArray(value) || value.length === 0) fail("captions must be a non-empty array");
  const lines: CaptionLine[] = [];
  let previousStart = -1;
  for (const [index, raw] of value.entries()) {
    const record = requireRecord(raw, `captions[${index}]`);
    requireKeys(record, ["start_ms", "end_ms", "text"], `captions[${index}]`);
    const start = requireMs(record.start_ms, `captions[${index}].start_ms`);
    const end = requireMs(record.end_ms, `captions[${index}].end_ms`);
    if (end <= start) fail(`captions[${index}] must end after it starts`);
    if (start < previousStart) fail(`captions[${index}] starts before the previous line`);
    previousStart = start;
    lines.push({ start_ms: start, end_ms: end, text: requireString(record.text, `captions[${index}].text`) });
  }
  return lines;
}

/**
 * Upgrade a legacy v1 document (Korean-only field names) to the v2 shape.
 * Returns the input untouched when it is not a v1 object.
 */
export function upgradeLessonV1(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (root.schema_version !== 1) return value;
  const lines = Array.isArray(root.lines)
    ? root.lines.map((raw) => {
        if (typeof raw !== "object" || raw === null) return raw;
        const line = raw as Record<string, unknown>;
        const { pronunciation_ko, translation_ko, ...rest } = line;
        return { ...rest, pronunciation: pronunciation_ko, translation: translation_ko };
      })
    : root.lines;
  const glossary = Array.isArray(root.glossary)
    ? root.glossary.map((raw) => {
        if (typeof raw !== "object" || raw === null) return raw;
        const entry = raw as Record<string, unknown>;
        const { meaning_ko, ...rest } = entry;
        return { ...rest, meaning: meaning_ko };
      })
    : root.glossary;
  return {
    ...root,
    schema_version: 2,
    study_language: "ko",
    lines,
    ...(glossary !== undefined ? { glossary } : {}),
  };
}

/** Validate an untrusted value as a lesson document (v2, or v1 upgraded). */
export function validateLesson(value: unknown): LessonV2 {
  const root = requireRecord(upgradeLessonV1(value), "lesson");
  requireKeys(
    root,
    ["schema_version", "video", "study_language", "display", "source_digest", "lines", "glossary"],
    "lesson",
  );
  if (root.schema_version !== LESSON_SCHEMA_VERSION) fail("lesson.schema_version must be 2");

  const studyLanguage = requireString(root.study_language, "lesson.study_language");
  if (!LANGUAGE_TAG.test(studyLanguage)) fail("lesson.study_language must be a BCP 47-style tag");

  let display: LessonDisplay | undefined;
  if (root.display !== undefined) {
    const record = requireRecord(root.display, "lesson.display");
    requireKeys(record, ["mode"], "lesson.display");
    if (record.mode !== "embed" && record.mode !== "sheet") {
      fail('lesson.display.mode must be "embed" or "sheet"');
    }
    display = { mode: record.mode };
  }

  const video = requireRecord(root.video, "lesson.video");
  requireKeys(video, ["provider", "video_id", "source_language", "title"], "lesson.video");
  if (video.provider !== "youtube") fail('lesson.video.provider must be "youtube"');
  const videoId = requireString(video.video_id, "lesson.video.video_id");
  if (!VIDEO_ID.test(videoId)) fail("lesson.video.video_id must be an 11-character YouTube id");
  const language = requireString(video.source_language, "lesson.video.source_language");
  if (!LANGUAGE_TAG.test(language)) fail("lesson.video.source_language must be a BCP 47-style tag");
  if (video.title !== undefined) requireString(video.title, "lesson.video.title");

  const digest = requireString(root.source_digest, "lesson.source_digest");
  if (!SHA256_HEX.test(digest)) fail("lesson.source_digest must be lowercase SHA-256 hex");

  if (!Array.isArray(root.lines) || root.lines.length === 0) fail("lesson.lines must be a non-empty array");
  const lines: LessonLine[] = [];
  let previousStart = -1;
  for (const [index, raw] of root.lines.entries()) {
    const record = requireRecord(raw, `lesson.lines[${index}]`);
    requireKeys(
      record,
      ["start_ms", "end_ms", "original", "pronunciation", "translation", "sentence_end"],
      `lesson.lines[${index}]`,
    );
    if (record.sentence_end !== undefined && typeof record.sentence_end !== "boolean") {
      fail(`lesson.lines[${index}].sentence_end must be a boolean when present`);
    }
    const start = requireMs(record.start_ms, `lesson.lines[${index}].start_ms`);
    const end = requireMs(record.end_ms, `lesson.lines[${index}].end_ms`);
    if (end <= start) fail(`lesson.lines[${index}] must end after it starts`);
    if (start < previousStart) fail(`lesson.lines[${index}] starts before the previous line`);
    previousStart = start;
    lines.push({
      start_ms: start,
      end_ms: end,
      original: requireString(record.original, `lesson.lines[${index}].original`),
      pronunciation: requireString(record.pronunciation, `lesson.lines[${index}].pronunciation`),
      translation: requireString(record.translation, `lesson.lines[${index}].translation`),
      ...(record.sentence_end !== undefined ? { sentence_end: record.sentence_end as boolean } : {}),
    });
  }

  let glossary: GlossaryEntry[] | undefined;
  if (root.glossary !== undefined) {
    if (!Array.isArray(root.glossary)) fail("lesson.glossary must be an array");
    glossary = [];
    const seen = new Set<string>();
    for (const [index, raw] of root.glossary.entries()) {
      const record = requireRecord(raw, `lesson.glossary[${index}]`);
      requireKeys(record, ["word", "meaning"], `lesson.glossary[${index}]`);
      const word = requireString(record.word, `lesson.glossary[${index}].word`);
      if (!GLOSSARY_WORD.test(word) || word !== word.toLowerCase()) {
        fail(`lesson.glossary[${index}].word must be a normalized lowercase word or short phrase`);
      }
      if (seen.has(word)) fail(`lesson.glossary[${index}] repeats "${word}"`);
      seen.add(word);
      glossary.push({ word, meaning: requireString(record.meaning, `lesson.glossary[${index}].meaning`) });
    }
  }

  const result: LessonV2 = {
    schema_version: LESSON_SCHEMA_VERSION,
    video: {
      provider: "youtube",
      video_id: videoId,
      source_language: language,
      ...(video.title !== undefined ? { title: video.title as string } : {}),
    },
    study_language: studyLanguage,
    ...(display !== undefined ? { display } : {}),
    source_digest: digest,
    lines,
    ...(glossary !== undefined && glossary.length > 0 ? { glossary } : {}),
  };
  return result;
}

/** Deterministic JSON: sorted keys, no whitespace variance. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Digest that binds every captured original line. */
export function captionDigest(captions: readonly CaptionLine[]): string {
  return sha256Hex(canonicalJson(captions));
}

/**
 * Confirm the lesson kept every captured original verbatim, in order, with
 * unchanged timecodes. Returns the mismatching line index or -1.
 */
export function firstOriginalMismatch(captions: readonly CaptionLine[], lesson: LessonV2): number {
  if (captions.length !== lesson.lines.length) {
    return Math.min(captions.length, lesson.lines.length);
  }
  for (const [index, caption] of captions.entries()) {
    const line = lesson.lines[index]!;
    if (
      line.original !== caption.text ||
      line.start_ms !== caption.start_ms ||
      line.end_ms !== caption.end_ms
    ) {
      return index;
    }
  }
  return -1;
}

export const LESSON_SLOT = "/*__LESSON_JSON__*/null";
export const LESSONS_SLOT = "/*__LESSONS_JSON__*/null";

function inlineJson(value: unknown): string {
  return canonicalJson(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** Escape lesson JSON for a safe inline <script> literal. */
export function inlineLessonJson(lesson: LessonV2): string {
  return inlineJson(lesson);
}

/** Inject a validated lesson into the runtime template. Pure and total. */
export function compilePage(template: string, lesson: LessonV2): string {
  const occurrences = template.split(LESSON_SLOT).length - 1;
  if (occurrences !== 1) fail(`runtime template must contain the lesson slot exactly once, found ${occurrences}`);
  // Function replacement: "$&"-style sequences in lesson text must be
  // inserted literally, never interpreted as replacement patterns.
  return template.replace(LESSON_SLOT, () => inlineLessonJson(lesson));
}

/**
 * Inject a whole validated lesson collection into the library template, so
 * one installed userscript covers every studied video.
 */
export function compileLibrary(template: string, lessons: readonly LessonV2[]): string {
  if (lessons.length === 0) fail("a library needs at least one lesson");
  const seen = new Set<string>();
  for (const lesson of lessons) {
    if (seen.has(lesson.video.video_id)) fail(`duplicate lesson for video ${lesson.video.video_id}`);
    seen.add(lesson.video.video_id);
  }
  const lessonOccurrences = template.split(LESSONS_SLOT).length - 1;
  if (lessonOccurrences !== 1) {
    fail(`library template must contain the lessons slot exactly once, found ${lessonOccurrences}`);
  }
  return template.replace(LESSONS_SLOT, () => inlineJson(lessons));
}
