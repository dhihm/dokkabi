import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { Type } from "typebox";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import { textToolResult } from "../../src/tools/model-result.ts";
import { detectCaptionFormat, parseCaptions } from "./captions.ts";
import {
  canonicalJson,
  captionDigest,
  compilePage,
  firstOriginalMismatch,
  LessonValidationError,
  sha256Hex,
  validateCaptions,
  validateLesson,
  type CaptionLine,
  type GlossaryEntry,
  type LessonV2,
} from "./lesson-lib.ts";

/** Operator-visible failure of a study-page operation. */
export class StudyToolError extends Error {
  override readonly name = "StudyToolError";
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const DEFAULT_DIR = "youtube-study";

/** Extract an 11-character video id from a YouTube URL or a bare id. */
export function parseVideoId(input: string): string | undefined {
  const raw = input.trim();
  if (VIDEO_ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return undefined;
  const candidate =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1).split("/", 1)[0]
      : url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/") || url.pathname.startsWith("/live/")
        ? url.pathname.split("/")[2]
        : (url.searchParams.get("v") ?? undefined);
  return candidate !== undefined && VIDEO_ID.test(candidate) ? candidate : undefined;
}

/** Resolve a relative path and refuse anything that escapes the root. */
function resolveInside(root: string, relative: string, label: string): string {
  if (isAbsolute(relative)) {
    throw new StudyToolError(`${label} must be a relative path inside the workspace`);
  }
  const target = normalize(join(root, relative));
  const bounds = normalize(root) + sep;
  if (target !== normalize(root) && !target.startsWith(bounds)) {
    throw new StudyToolError(`${label} must stay inside the workspace`);
  }
  return target;
}

interface CaptureFile {
  readonly schema_version: 1;
  readonly video: LessonV2["video"];
  /** The learner's language for this capture; legacy captures default to "ko". */
  readonly study_language: string;
  readonly source_digest: string;
  readonly captions: readonly CaptionLine[];
}

interface DraftEntry {
  readonly pronunciation: string;
  readonly translation: string;
  /** Optional model-authored sentence boundary; see lesson-lib. */
  readonly sentence_end?: boolean;
}

interface DraftFile {
  readonly schema_version: 1;
  readonly source_digest: string;
  readonly lines: Record<string, DraftEntry>;
}

interface GlossaryFile {
  readonly schema_version: 1;
  readonly source_digest: string;
  readonly words: Record<string, string>;
}

/** Unicode-aware: Latin words, CJK sequences, or short phrases. */
const GLOSSARY_WORD = /^[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*(?: [\p{L}\p{N}'\u2019-]+){0,3}$/u;

/** Function words and fillers that need no vocabulary gloss. */
const STOPWORDS = new Set(
  ("a an the and or but if so of to in on at by for with from as into onto over under out up down off " +
   "is are was were be been being am do does did done have has had having will would can could should " +
   "shall may might must not no nor i you he she it we they me him her us them my your his its our " +
   "their mine yours this that these those there here what which who whom whose when where why how " +
   "than then too also very just only even still yet again once about because while during through " +
   "um uh mhm yeah yes okay ok oh well hey s t re ve ll d m don didn doesn isn aren wasn weren won " +
   "wouldn couldn shouldn can't don't it's that's i'm you're we're they're there's what's let's gonna " +
   "wanna gotta").split(" "),
);

/**
 * Lowercase word tokens of one original line, punctuation stripped.
 * The English stopword filter applies only to English sources; other
 * languages keep every token (their function words are not enumerated).
 */
function wordsOf(text: string, sourceLanguage: string): string[] {
  const english = sourceLanguage.split("-")[0] === "en";
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((token) => token.replace(/^['-]+|['-]+$/gu, ""))
    .filter(
      (token) =>
        token.length > 1 &&
        token.length <= 30 &&
        (!english || !STOPWORDS.has(token)) &&
        GLOSSARY_WORD.test(token),
    );
}

function readGlossary(root: string, videoId: string): GlossaryFile | undefined {
  const path = join(videoDir(root, videoId), "glossary.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as GlossaryFile;
}

function videoDir(root: string, videoId: string): string {
  if (!VIDEO_ID.test(videoId)) throw new StudyToolError("video_id must be an 11-character YouTube id");
  return join(root, videoId);
}

function readCapture(root: string, videoId: string): CaptureFile {
  const path = join(videoDir(root, videoId), "capture.json");
  if (!existsSync(path)) {
    throw new StudyToolError(`no capture for ${videoId}; run the inspect operation first`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as CaptureFile;
  const captions = validateCaptions(raw.captions);
  const digest = captionDigest(captions);
  if (raw.schema_version !== 1 || raw.source_digest !== digest) {
    throw new StudyToolError(`capture for ${videoId} is corrupt; run the inspect operation again`);
  }
  return {
    schema_version: 1,
    video: raw.video,
    study_language: typeof raw.study_language === "string" ? raw.study_language : "ko",
    source_digest: digest,
    captions,
  };
}

function readDraft(root: string, videoId: string): DraftFile | undefined {
  const path = join(videoDir(root, videoId), "draft.json");
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as DraftFile & {
    readonly lines: Record<string, DraftEntry & { pronunciation_ko?: string; translation_ko?: string }>;
  };
  // Upgrade legacy Korean-only field names in place.
  const lines: Record<string, DraftEntry> = {};
  for (const [index, entry] of Object.entries(raw.lines)) {
    lines[index] = {
      pronunciation: entry.pronunciation ?? entry.pronunciation_ko ?? "",
      translation: entry.translation ?? entry.translation_ko ?? "",
      ...(entry.sentence_end !== undefined ? { sentence_end: entry.sentence_end } : {}),
    };
  }
  return { schema_version: 1, source_digest: raw.source_digest, lines };
}

const TEMPLATE_URL = new URL("./runtime/index.template.html", import.meta.url);
const USERSCRIPT_URL = new URL("./runtime/study.user.template.js", import.meta.url);
const LIBRARY_URL = new URL("./runtime/library.user.template.js", import.meta.url);
const PINNED_URL = new URL("./PINNED.json", import.meta.url);

interface PinnedRecord {
  readonly runtime_sha256: string;
  readonly userscript_sha256: string;
  readonly library_sha256: string;
}

function readPinned(url: URL, key: keyof PinnedRecord, label: string): string {
  const body = readFileSync(url, "utf8");
  const pinned = JSON.parse(readFileSync(PINNED_URL, "utf8")) as PinnedRecord;
  if (sha256Hex(body) !== pinned[key]) {
    throw new StudyToolError(`bundled ${label} does not match its PINNED record`);
  }
  return body;
}

function readPinnedTemplate(): string {
  return readPinned(TEMPLATE_URL, "runtime_sha256", "runtime template");
}

function readPinnedUserscript(): string {
  return readPinned(USERSCRIPT_URL, "userscript_sha256", "userscript template");
}

function readPinnedLibrary(): string {
  return readPinned(LIBRARY_URL, "library_sha256", "library template");
}

const LESSONS_SLOT = "/*__LESSONS_JSON__*/null";

/** Same escaping contract as compilePage, over the whole lesson array. */
function compileLibrary(template: string, lessons: readonly LessonV2[]): string {
  const occurrences = template.split(LESSONS_SLOT).length - 1;
  if (occurrences !== 1) {
    throw new StudyToolError(`library template must contain the lessons slot exactly once, found ${occurrences}`);
  }
  const inline = canonicalJson(lessons)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  // Function replacement: "$&"-style sequences in lesson text must be
  // inserted literally, never interpreted as replacement patterns.
  return template.replace(LESSONS_SLOT, () => inline);
}

export interface InspectInput {
  readonly root: string;
  readonly url: string;
  readonly captionsPath: string;
  readonly sourceLanguage?: string;
  /** The learner's language for this lesson; defaults to "ko". */
  readonly studyLanguage?: string;
  readonly title?: string;
}

export interface InspectResult {
  readonly videoId: string;
  readonly lineCount: number;
  readonly sourceDigest: string;
  readonly capturePath: string;
  readonly lines: readonly { index: number; start_ms: number; end_ms: number; original: string }[];
}

/** Capture originals from a local subtitle file and bind them by digest. */
export function inspectCaptions(input: InspectInput): InspectResult {
  const videoId = parseVideoId(input.url);
  if (videoId === undefined) {
    throw new StudyToolError("url must be a YouTube video URL or an 11-character video id");
  }
  const captionsPath = resolveInside(input.root, input.captionsPath, "captions_path");
  const format = detectCaptionFormat(input.captionsPath);
  if (format === undefined) {
    throw new StudyToolError("captions_path must end in .vtt, .srt, or .json");
  }
  if (!existsSync(captionsPath)) {
    throw new StudyToolError(`captions file not found: ${input.captionsPath}`);
  }
  const captions = parseCaptions(readFileSync(captionsPath, "utf8"), format);
  const sourceDigest = captionDigest(captions);
  const capture: CaptureFile = {
    schema_version: 1,
    video: {
      provider: "youtube",
      video_id: videoId,
      source_language: input.sourceLanguage ?? "en",
      ...(input.title !== undefined ? { title: input.title } : {}),
    },
    study_language: input.studyLanguage ?? "ko",
    source_digest: sourceDigest,
    captions,
  };
  const dir = videoDir(input.root, videoId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "capture.json"), `${canonicalJson(capture)}\n`, "utf8");
  return {
    videoId,
    lineCount: captions.length,
    sourceDigest,
    capturePath: join(videoId, "capture.json"),
    lines: captions.map((caption, index) => ({
      index,
      start_ms: caption.start_ms,
      end_ms: caption.end_ms,
      original: caption.text,
    })),
  };
}

export interface DraftInput {
  readonly root: string;
  readonly videoId: string;
  readonly lines: readonly {
    index: number;
    pronunciation: string;
    translation: string;
    sentence_end?: boolean;
  }[];
}

export interface DraftResult {
  readonly draftedCount: number;
  readonly missingCount: number;
  readonly missingIndices: readonly number[];
}

/**
 * Store model-authored Korean fields for a window of lines. Only
 * pronunciation_ko and translation_ko are accepted; any attempt to carry
 * original text or timecodes is refused.
 */
export function draftLines(input: DraftInput): DraftResult {
  const capture = readCapture(input.root, input.videoId);
  const existing = readDraft(input.root, input.videoId);
  if (existing !== undefined && existing.source_digest !== capture.source_digest) {
    throw new StudyToolError("draft belongs to a different capture; run the inspect operation again");
  }
  const lines: Record<string, DraftEntry> = { ...(existing?.lines ?? {}) };
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new StudyToolError("draft needs at least one line");
  }
  for (const entry of input.lines) {
    const keys = Object.keys(entry as Record<string, unknown>).sort();
    const shape = keys.join(",");
    if (shape !== "index,pronunciation,translation" && shape !== "index,pronunciation,sentence_end,translation") {
      throw new StudyToolError(
        "a draft line carries exactly index, pronunciation, translation, and optionally sentence_end; originals are read from the capture",
      );
    }
    if (entry.sentence_end !== undefined && typeof entry.sentence_end !== "boolean") {
      throw new StudyToolError(`line ${entry.index} sentence_end must be a boolean`);
    }
    if (!Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= capture.captions.length) {
      throw new StudyToolError(`line index ${entry.index} is outside the capture (0..${capture.captions.length - 1})`);
    }
    if (typeof entry.pronunciation !== "string" || entry.pronunciation.trim().length === 0) {
      throw new StudyToolError(`line ${entry.index} needs a non-empty pronunciation`);
    }
    if (typeof entry.translation !== "string" || entry.translation.trim().length === 0) {
      throw new StudyToolError(`line ${entry.index} needs a non-empty translation`);
    }
    lines[String(entry.index)] = {
      pronunciation: entry.pronunciation,
      translation: entry.translation,
      ...(entry.sentence_end !== undefined ? { sentence_end: entry.sentence_end } : {}),
    };
  }
  const draft: DraftFile = { schema_version: 1, source_digest: capture.source_digest, lines };
  writeFileSync(join(videoDir(input.root, input.videoId), "draft.json"), `${canonicalJson(draft)}\n`, "utf8");
  const missingIndices = capture.captions
    .map((_, index) => index)
    .filter((index) => lines[String(index)] === undefined);
  return {
    draftedCount: Object.keys(lines).length,
    missingCount: missingIndices.length,
    missingIndices,
  };
}

export interface BuildInput {
  readonly root: string;
  readonly videoId: string;
  /** "embed" (default) plays in-page; "sheet" renders the lines standalone. */
  readonly mode?: "embed" | "sheet";
}

export interface BuildResult {
  readonly outDir: string;
  readonly pageDigest: string;
  readonly userscriptDigest: string;
  readonly lessonDigest: string;
  readonly lineCount: number;
}

/** Compile capture + complete draft into the static study page. */
export function buildLesson(input: BuildInput): BuildResult {
  const capture = readCapture(input.root, input.videoId);
  const draft = readDraft(input.root, input.videoId);
  if (draft === undefined || draft.source_digest !== capture.source_digest) {
    throw new StudyToolError("no draft for this capture; run the draft operation first");
  }
  const missing = capture.captions
    .map((_, index) => index)
    .filter((index) => draft.lines[String(index)] === undefined);
  if (missing.length > 0) {
    throw new StudyToolError(`draft is missing ${missing.length} lines (e.g. index ${missing[0]}); build needs full coverage`);
  }
  const glossaryFile = readGlossary(input.root, input.videoId);
  if (glossaryFile !== undefined && glossaryFile.source_digest !== capture.source_digest) {
    throw new StudyToolError("glossary belongs to a different capture; run the inspect operation again");
  }
  const glossary: GlossaryEntry[] | undefined =
    glossaryFile !== undefined && Object.keys(glossaryFile.words).length > 0
      ? Object.entries(glossaryFile.words)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([word, meaning]) => ({ word, meaning }))
      : undefined;
  const lesson = validateLesson({
    schema_version: 2,
    video: capture.video,
    study_language: capture.study_language,
    ...(input.mode === "sheet" ? { display: { mode: "sheet" } } : {}),
    ...(glossary !== undefined ? { glossary } : {}),
    source_digest: capture.source_digest,
    lines: capture.captions.map((caption, index) => {
      const entry = draft.lines[String(index)]!;
      return {
        start_ms: caption.start_ms,
        end_ms: caption.end_ms,
        original: caption.text,
        pronunciation: entry.pronunciation,
        translation: entry.translation,
        ...(entry.sentence_end !== undefined ? { sentence_end: entry.sentence_end } : {}),
      };
    }),
  });
  const page = compilePage(readPinnedTemplate(), lesson);
  const userscript = compilePage(readPinnedUserscript(), lesson);
  const lessonJson = canonicalJson(lesson);
  const outDir = join(videoDir(input.root, input.videoId), "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), page, "utf8");
  writeFileSync(join(outDir, "study.user.js"), userscript, "utf8");
  writeFileSync(join(outDir, "lesson.json"), `${lessonJson}\n`, "utf8");
  return {
    outDir,
    pageDigest: sha256Hex(page),
    userscriptDigest: sha256Hex(userscript),
    lessonDigest: sha256Hex(lessonJson),
    lineCount: lesson.lines.length,
  };
}

export interface VerifyInput {
  readonly root: string;
  readonly videoId: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly built: boolean;
  readonly lineCount: number;
  readonly draftedCount: number;
  readonly checks: {
    readonly capture: string;
    readonly schema: string;
    readonly originals: string;
    readonly timecodes: string;
    readonly page: string;
    readonly userscript: string;
  };
}

/**
 * Re-derive every guarantee from disk: capture integrity, lesson schema,
 * verbatim originals and timecodes, and byte-identity of the page with the
 * pinned runtime output. Doubles as the status surface.
 */
export function verifyLesson(input: VerifyInput): VerifyResult {
  let capture: CaptureFile | undefined;
  let captureCheck = "ok";
  try {
    capture = readCapture(input.root, input.videoId);
  } catch (error) {
    captureCheck = error instanceof Error ? error.message : String(error);
  }
  const draft = capture === undefined ? undefined : readDraft(input.root, input.videoId);
  const draftedCount =
    draft === undefined || draft.source_digest !== capture?.source_digest
      ? 0
      : Object.keys(draft.lines).length;
  const lineCount = capture?.captions.length ?? 0;

  const outDir = capture === undefined ? undefined : join(videoDir(input.root, input.videoId), "out");
  const built =
    outDir !== undefined &&
    existsSync(join(outDir, "index.html")) &&
    existsSync(join(outDir, "study.user.js")) &&
    existsSync(join(outDir, "lesson.json"));
  if (capture === undefined || !built) {
    const pending = capture === undefined ? "capture missing" : "not built";
    return {
      ok: false,
      built,
      lineCount,
      draftedCount,
      checks: { capture: captureCheck, schema: pending, originals: pending, timecodes: pending, page: pending, userscript: pending },
    };
  }

  let schemaCheck = "ok";
  let originalsCheck = "ok";
  let timecodesCheck = "ok";
  let pageCheck = "ok";
  let userscriptCheck = "ok";
  let lesson: LessonV2 | undefined;
  try {
    lesson = validateLesson(JSON.parse(readFileSync(join(outDir!, "lesson.json"), "utf8")));
    if (lesson.source_digest !== capture.source_digest) {
      schemaCheck = "lesson source_digest does not match the capture";
    }
  } catch (error) {
    schemaCheck = error instanceof Error ? error.message : String(error);
  }

  if (lesson !== undefined) {
    if (capture.captions.length !== lesson.lines.length) {
      const detail = `line ${Math.min(capture.captions.length, lesson.lines.length)} capture has ${capture.captions.length} lines, lesson has ${lesson.lines.length}`;
      originalsCheck = detail;
      timecodesCheck = detail;
    } else if (firstOriginalMismatch(capture.captions, lesson) !== -1) {
      for (const [index, caption] of capture.captions.entries()) {
        const line = lesson.lines[index]!;
        if (originalsCheck === "ok" && line.original !== caption.text) {
          originalsCheck = `line ${index} original differs from the capture`;
        }
        if (timecodesCheck === "ok" && (line.start_ms !== caption.start_ms || line.end_ms !== caption.end_ms)) {
          timecodesCheck = `line ${index} timecodes differ from the capture`;
        }
      }
    }
    try {
      const expected = compilePage(readPinnedTemplate(), lesson);
      if (readFileSync(join(outDir!, "index.html"), "utf8") !== expected) {
        pageCheck = "index.html differs from the pinned runtime output";
      }
    } catch (error) {
      pageCheck = error instanceof Error ? error.message : String(error);
    }
    try {
      const expected = compilePage(readPinnedUserscript(), lesson);
      if (readFileSync(join(outDir!, "study.user.js"), "utf8") !== expected) {
        userscriptCheck = "study.user.js differs from the pinned runtime output";
      }
    } catch (error) {
      userscriptCheck = error instanceof Error ? error.message : String(error);
    }
  } else {
    pageCheck = "lesson.json is invalid";
    userscriptCheck = "lesson.json is invalid";
    originalsCheck = "lesson.json is invalid";
    timecodesCheck = "lesson.json is invalid";
  }

  const checks = {
    capture: captureCheck,
    schema: schemaCheck,
    originals: originalsCheck,
    timecodes: timecodesCheck,
    page: pageCheck,
    userscript: userscriptCheck,
  };
  return {
    ok: Object.values(checks).every((check) => check === "ok"),
    built,
    lineCount,
    draftedCount,
    checks,
  };
}

export interface WordsInput {
  readonly root: string;
  readonly videoId: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface WordsResult {
  readonly totalWords: number;
  readonly glossedCount: number;
  readonly offset: number;
  readonly words: readonly { word: string; count: number; glossed: boolean }[];
}

/**
 * Distinct content words of the capture, most frequent first, so the model
 * can gloss them in windows. Function words and fillers are excluded.
 */
export function listWords(input: WordsInput): WordsResult {
  const capture = readCapture(input.root, input.videoId);
  const glossary = readGlossary(input.root, input.videoId);
  const glossed =
    glossary !== undefined && glossary.source_digest === capture.source_digest
      ? new Set(Object.keys(glossary.words))
      : new Set<string>();
  const counts = new Map<string, number>();
  for (const caption of capture.captions) {
    for (const word of wordsOf(caption.text, capture.video.source_language)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(1, Math.min(input.limit ?? 300, 500));
  return {
    totalWords: sorted.length,
    glossedCount: [...counts.keys()].filter((word) => glossed.has(word)).length,
    offset,
    words: sorted.slice(offset, offset + limit).map(([word, count]) => ({
      word,
      count,
      glossed: glossed.has(word),
    })),
  };
}

export interface GlossInput {
  readonly root: string;
  readonly videoId: string;
  readonly entries: readonly { word: string; meaning: string }[];
}

export interface GlossResult {
  readonly glossedCount: number;
  readonly remainingCount: number;
}

/** Store model-authored Korean glosses, digest-bound like the draft. */
export function glossWords(input: GlossInput): GlossResult {
  const capture = readCapture(input.root, input.videoId);
  const existing = readGlossary(input.root, input.videoId);
  if (existing !== undefined && existing.source_digest !== capture.source_digest) {
    throw new StudyToolError("glossary belongs to a different capture; run the inspect operation again");
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new StudyToolError("gloss needs at least one entry");
  }
  const words: Record<string, string> = { ...(existing?.words ?? {}) };
  for (const entry of input.entries) {
    const keys = Object.keys(entry as Record<string, unknown>).sort();
    if (keys.join(",") !== "meaning,word") {
      throw new StudyToolError("a gloss entry carries exactly word and meaning");
    }
    if (typeof entry.word !== "string" || !GLOSSARY_WORD.test(entry.word) || entry.word !== entry.word.toLowerCase()) {
      throw new StudyToolError(`gloss word "${String(entry.word)}" must be a normalized lowercase word or short phrase`);
    }
    if (typeof entry.meaning !== "string" || entry.meaning.trim().length === 0) {
      throw new StudyToolError(`gloss for "${entry.word}" needs a non-empty meaning`);
    }
    words[entry.word] = entry.meaning.trim();
  }
  const file: GlossaryFile = { schema_version: 1, source_digest: capture.source_digest, words };
  writeFileSync(join(videoDir(input.root, input.videoId), "glossary.json"), `${canonicalJson(file)}\n`, "utf8");
  const distinct = new Set<string>();
  for (const caption of capture.captions) for (const word of wordsOf(caption.text, capture.video.source_language)) distinct.add(word);
  let remaining = 0;
  for (const word of distinct) if (words[word] === undefined) remaining += 1;
  return { glossedCount: Object.keys(words).length, remainingCount: remaining };
}

export interface ListInput {
  readonly root: string;
}

export interface LessonStatus {
  readonly videoId: string;
  readonly title?: string;
  readonly lineCount: number;
  readonly draftedCount: number;
  readonly built: boolean;
  readonly verified: boolean;
}

export interface ListResult {
  readonly lessons: readonly LessonStatus[];
  readonly styleGuide: boolean;
}

/** Catalog every captured video under the workspace with its progress. */
export function listLessons(input: ListInput): ListResult {
  const lessons: LessonStatus[] = [];
  if (existsSync(input.root)) {
    for (const entry of readdirSync(input.root).sort()) {
      if (!VIDEO_ID.test(entry) || !existsSync(join(input.root, entry, "capture.json"))) continue;
      const status = verifyLesson({ root: input.root, videoId: entry });
      let title: string | undefined;
      try {
        title = (JSON.parse(readFileSync(join(input.root, entry, "capture.json"), "utf8")) as CaptureFile)
          .video.title;
      } catch {
        title = undefined;
      }
      lessons.push({
        videoId: entry,
        ...(title !== undefined ? { title } : {}),
        lineCount: status.lineCount,
        draftedCount: status.draftedCount,
        built: status.built,
        verified: status.ok,
      });
    }
  }
  return { lessons, styleGuide: existsSync(join(input.root, "style.md")) };
}

export interface LibraryInput {
  readonly root: string;
}

export interface LibraryResult {
  readonly path: string;
  readonly libraryDigest: string;
  readonly videos: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Merge every verified lesson into one installable library userscript at
 * <root>/library/study-library.user.js. Unverified lessons are skipped and
 * reported, never silently included.
 */
export function buildLibrary(input: LibraryInput): LibraryResult {
  const catalog = listLessons(input);
  const videos: string[] = [];
  const skipped: string[] = [];
  const lessons: LessonV2[] = [];
  for (const status of catalog.lessons) {
    if (!status.verified) {
      skipped.push(status.videoId);
      continue;
    }
    lessons.push(validateLesson(JSON.parse(readFileSync(join(input.root, status.videoId, "out", "lesson.json"), "utf8"))));
    videos.push(status.videoId);
  }
  if (lessons.length === 0) {
    throw new StudyToolError("no verified lessons to include; build and verify at least one video first");
  }
  const script = compileLibrary(readPinnedLibrary(), lessons);
  const dir = join(input.root, "library");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "study-library.user.js");
  writeFileSync(path, script, "utf8");
  return { path, libraryDigest: sha256Hex(script), videos, skipped };
}

const GlossEntry = Type.Object(
  {
    word: Type.String(),
    meaning: Type.String(),
  },
  { additionalProperties: false },
);

const DraftLine = Type.Object(
  {
    index: Type.Number(),
    pronunciation: Type.String(),
    translation: Type.String(),
    sentence_end: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const StudyParameters = Type.Object(
  {
    op: Type.Union([
      Type.Literal("inspect"),
      Type.Literal("draft"),
      Type.Literal("build"),
      Type.Literal("verify"),
      Type.Literal("list"),
      Type.Literal("library"),
      Type.Literal("words"),
      Type.Literal("gloss"),
    ]),
    url: Type.Optional(Type.String()),
    captions_path: Type.Optional(Type.String()),
    video_id: Type.Optional(Type.String()),
    dir: Type.Optional(Type.String()),
    source_language: Type.Optional(Type.String()),
    study_language: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    mode: Type.Optional(Type.Union([Type.Literal("embed"), Type.Literal("sheet")])),
    lines: Type.Optional(Type.Array(DraftLine)),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
    entries: Type.Optional(Type.Array(GlossEntry)),
  },
  { additionalProperties: false },
);

function requireParam<T>(value: T | undefined, name: string, op: string): T {
  if (value === undefined) throw new StudyToolError(`${name} is required for the ${op} operation`);
  return value;
}

function createStudyTool(ctx: HostContext): AgentTool<typeof StudyParameters> {
  return {
    name: "youtube_study",
    label: "youtube study",
    description:
      "Build a static study page for one YouTube video and one study language from a local subtitle file. inspect captures originals from captions_path (study_language defaults to ko) and returns numbered lines; draft stores model-authored pronunciation/translation in the study language for a window of line indices; build compiles the pinned runtime page once every line is drafted (mode \"sheet\" renders the lines standalone with timestamp links instead of an embedded player); verify re-checks schema, verbatim originals, timecodes, and page integrity; list catalogs every captured video with its progress; library merges all verified lessons into one installable study-library.user.js; words returns the capture's distinct content words for glossing; gloss stores model-authored word meanings in the study language that build embeds for the vocabulary book. Originals cannot be modified: they are bound to the capture digest.",
    parameters: StudyParameters,
    async execute(_toolCallId, params) {
      try {
        const root = resolveInside(ctx.workspaceRoot, params.dir ?? DEFAULT_DIR, "dir");
        switch (params.op) {
          case "inspect": {
            const result = inspectCaptions({
              root,
              url: requireParam(params.url, "url", "inspect"),
              captionsPath: requireParam(params.captions_path, "captions_path", "inspect"),
              ...(params.source_language !== undefined ? { sourceLanguage: params.source_language } : {}),
              ...(params.study_language !== undefined ? { studyLanguage: params.study_language } : {}),
              ...(params.title !== undefined ? { title: params.title } : {}),
            });
            return textToolResult(JSON.stringify(result));
          }
          case "draft": {
            const result = draftLines({
              root,
              videoId: requireParam(params.video_id, "video_id", "draft"),
              lines: requireParam(params.lines, "lines", "draft"),
            });
            return textToolResult(JSON.stringify(result));
          }
          case "build": {
            const result = buildLesson({
              root,
              videoId: requireParam(params.video_id, "video_id", "build"),
              ...(params.mode !== undefined ? { mode: params.mode } : {}),
            });
            return textToolResult(JSON.stringify(result));
          }
          case "verify": {
            const result = verifyLesson({
              root,
              videoId: requireParam(params.video_id, "video_id", "verify"),
            });
            return textToolResult(JSON.stringify(result), !result.ok);
          }
          case "list": {
            return textToolResult(JSON.stringify(listLessons({ root })));
          }
          case "library": {
            return textToolResult(JSON.stringify(buildLibrary({ root })));
          }
          case "words": {
            return textToolResult(JSON.stringify(listWords({
              root,
              videoId: requireParam(params.video_id, "video_id", "words"),
              ...(params.offset !== undefined ? { offset: params.offset } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            })));
          }
          case "gloss": {
            return textToolResult(JSON.stringify(glossWords({
              root,
              videoId: requireParam(params.video_id, "video_id", "gloss"),
              entries: requireParam(params.entries, "entries", "gloss"),
            })));
          }
        }
      } catch (error) {
        if (error instanceof StudyToolError || error instanceof LessonValidationError || error instanceof SyntaxError) {
          return textToolResult(error.message, true);
        }
        throw error;
      }
    },
  };
}

export const plugin: PluginModule = {
  id: "youtube-study",
  claims: [
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "skills", role: "consumer", modelFacing: true },
  ],
  activate() {
    // Private swarm children keep the fixed child-safe tool core.
    const swarmChild = process.env.DOKKABI_PARENT_SESSION !== undefined
      || process.env.DOKKABI_SWARM_ROLE !== undefined;
    return swarmChild
      ? { active: false, reason: "study pages are a parent-session capability", kind: "unavailable" }
      : { active: true };
  },
  register(ctx: HostContext) {
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.effect(() => tools.register("youtube-study", createStudyTool(ctx)));
  },
};
