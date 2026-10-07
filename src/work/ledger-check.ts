import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, openSync, readSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { policyConfinesWrites, spawnFenced, type SandboxPolicy } from "../host/sandbox.ts";
import {
  ensureDirBeneath,
  LinkSafetyError,
  lstatBeneath,
  openBeneath,
  readBeneath,
  readOpened,
  removeTreeBeneath,
  safeRoot,
  unlinkBeneath,
  writeBeneath,
  type OpenedFile,
  type SafeRoot,
} from "./link-safe-fs.ts";
import { beneath, displayPath } from "./path-bytes.ts";
import { BoundedRegexRun, compileBoundedRegex, type BoundedRegexProgram } from "./bounded-regex.ts";
import { propertyBoundsOf } from "./property-verdict.ts";
import type { LedgerCase, LedgerCheckExpectation, LedgerCheckText, LedgerProperty, LedgerTextExpectation } from "./plan-ledger.ts";

/**
 * CHECK (D48): the one evaluator every observation of a `check` case shares.
 *
 * A `check` records a ledger case that carries, besides its command, the text
 * on its stdin, fixture files and expectations (plan-ledger.ts). Everything
 * that observes a case — the check's own immediate observation, the plan
 * probe, the final pass, the base pass and the verify-rounds recheck — runs a
 * case that carries them through the two halves below, and so judges it the
 * same way:
 *
 *   prepareCheckRun  writes the fixtures from the RECORD (inline text, or the
 *                    session's content store verified by digest) into
 *                    `<scratch>/checks/<case>/`, and wraps the launched
 *                    command so that its stdin is the recorded text and its
 *                    stdout and stderr are captured apart, in the scratch;
 *   completeCheckRun reads the captures and the files the command should
 *                    have produced (from the tree it ran on), evaluates every
 *                    expectation (evaluateCheck) and removes the captures.
 *
 * What a result SHOWS is bounded; what the verdict is computed ON is the whole
 * observation (D49): a capture or produced file larger than
 * CHECK_READ_MAX_BYTES is compared and searched over its whole length in
 * bounded chunks, a regular expression is never claimed on a part of one, and
 * a capture that does not exist is not read as empty text.
 *
 * The verdict is green only when every expectation holds; the exit code is
 * one expectation among them (0 unless the check says otherwise). A runner
 * adapter never reads a check case: its expectations are its verdict.
 * Nothing here gates: a red check is data returned to the model and recorded
 * on the observation row.
 *
 * Scratch layout (all inside the recording session's scratch directory):
 *   checks/<case>/          the fixtures, rewritten before every observation;
 *                           the command sees it as DOKKABI_CHECK_DIR
 *   .host/fixtures/<sha256> texts too large to ride inline on the ledger row
 *   .host/observe/<nonce>/  one observation's stdin and captures, removed
 *                           after it is read
 *
 * S1 (D57c): the session writes its scratch too, and may put a link at any of
 * these paths — or at a file the check expects its command to produce in the
 * tree. Every host operation here goes through link-safe-fs.ts, relative to
 * the scratch (or the tree) as a root the host pinned: a link in a component
 * refuses the operation — the case is then `not_runnable`, the refusal its
 * reason, nothing written or removed — a link at a removal's target is
 * removed as the link, a capture or produced file reached through a link is
 * not read (not captured; not a regular file). The two recursive removals —
 * the fixture directory before a run, an observation's captures after it —
 * run as `rm` inside the check's own sandbox policy when that policy confines
 * writes (policyConfinesWrites), so no race with a concurrent process of the
 * session can lead them outside what the session may write itself.
 */

/** The environment variable a check's command finds its fixture directory in. */
export const CHECK_DIR_ENV = "DOKKABI_CHECK_DIR";

/** A fixture or stdin text at most this long rides inline on the ledger row;
 * a longer one is stored under its digest in the scratch store. The case
 * rides on its own revision row and on every whole-graph revision after it
 * (a `plan` call), so inline text is kept small. */
export const CHECK_INLINE_MAX_BYTES = 1_024;
/** The bounds of one check's inputs. */
export const CHECK_FILE_MAX_BYTES = 256 * 1_024;
export const CHECK_INPUT_MAX_BYTES = 1_024 * 1_024;
export const CHECK_FILES_MAX = 32;
export const CHECK_PATH_MAX = 200;
export const CHECK_ID_MAX = 128;
/** The bounds of one check's expectations: they ride inline on every
 * revision, so they stay small. */
export const CHECK_EXPECT_TEXT_MAX = 8 * 1_024;
export const CHECK_EXPECT_MAX_BYTES = 16 * 1_024;
export const CHECK_CONTAINS_MAX = 16;
export const CHECK_EXPECT_FILES_MAX = 16;
export const CHECK_REGEX_MAX = 1_000;
/** How much of a capture or a produced file is held in memory and shown. A
 * text up to this size is evaluated whole in memory; a larger one is evaluated
 * over its whole length in chunks of CHECK_STREAM_CHUNK_BYTES, and only this
 * much of it is ever shown. */
export const CHECK_READ_MAX_BYTES = 1_024 * 1_024;
/** The chunk a text larger than CHECK_READ_MAX_BYTES is read in. */
export const CHECK_STREAM_CHUNK_BYTES = 64 * 1_024;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Compiled patterns, remembered (a pattern is at most CHECK_REGEX_MAX
 * characters; a few hundred kept). */
const COMPILED_PATTERNS = new Map<string, ReturnType<typeof compileBoundedRegex>>();

/** A pattern compiled for bounded evaluation (RX), or why it cannot be. */
function boundedRegexOf(pattern: string): { readonly ok: true; readonly program: BoundedRegexProgram } | { readonly ok: false; readonly reason: string } {
  let compiled = COMPILED_PATTERNS.get(pattern);
  if (compiled === undefined) {
    compiled = compileBoundedRegex(pattern);
    if (COMPILED_PATTERNS.size >= 256) COMPILED_PATTERNS.delete(COMPILED_PATTERNS.keys().next().value!);
    COMPILED_PATTERNS.set(pattern, compiled);
  }
  return compiled;
}

/** Why an execution is no verdict because its process tree outlived it (P1,
 * D58c): the host ended the tree and could not verify every process of it
 * gone. Undefined when nothing survived. */
export function processTreeSurvived(outcome: { readonly execution?: { readonly survivors?: number } }): string | undefined {
  const survivors = outcome.execution?.survivors ?? 0;
  return survivors > 0 ? `${survivors} process(es) of the case survived the host's end of its process tree, so it is not judged` : undefined;
}

/** True when the case was recorded by `check`: it carries expectations,
 * fixtures or stdin, and every observation judges it through this file. A
 * plan-declared case never carries any of them. A `property` case (D58)
 * carries fixtures too, and is judged by work/ledger-property.ts instead. */
export function isCheckCase(item: Pick<LedgerCase, "expect" | "files" | "stdin" | "property">): boolean {
  if (item.property !== undefined) return false;
  return item.expect !== undefined || item.files !== undefined || item.stdin !== undefined;
}

/** The directory name a case's fixtures get: the id itself when it is a plain
 * file name, otherwise a digest of it. */
export function checkDirName(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id) ? id : `case-${sha256(id).slice(0, 16)}`;
}

/** Where a case's fixtures are written, inside a session's scratch. */
export function checkDirFor(scratch: string, caseId: string): string {
  return join(scratch, "checks", checkDirName(caseId));
}

/** A stored text's place below the scratch: `.host/fixtures/<sha256>`. */
function storeRel(digest: string): Buffer {
  return Buffer.from(`.host/fixtures/${digest}`);
}

/** The scratch as a root the host pinned (S1), or undefined when it is not a
 * real directory (a link in its place is never followed). */
function scratchRootOf(scratch: string): SafeRoot | undefined {
  try {
    return safeRoot(scratch, "the session's scratch");
  } catch {
    return undefined;
  }
}

/** The text stored under `digest` when the store holds exactly it. */
function storedText(root: SafeRoot, digest: string): string | undefined {
  try {
    const bytes = readBeneath(root, storeRel(digest));
    if (bytes === undefined) return undefined;
    const text = bytes.toString("utf8");
    return sha256(text) === digest ? text : undefined;
  } catch {
    return undefined;
  }
}

// --- the tool boundary -------------------------------------------------------

export interface CheckInputFinding {
  readonly check: string;
  readonly node: string;
  readonly fact: string;
}

export type NormalizedCheck =
  | { readonly ok: true; readonly item: LedgerCase; readonly contents: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly findings: CheckInputFinding[] };

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

/** A relative path that stays where it is put: no absolute form, no `..`, no
 * empty or `.` segment after normalization. */
export function safeRelativePath(path: string): string | undefined {
  if (path.length === 0 || path.length > CHECK_PATH_MAX || path.includes("\0") || path.includes("\\")) return undefined;
  if (path.startsWith("/") || isAbsolute(path)) return undefined;
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.split("/").includes("..")) return undefined;
  return normalized.replace(/\/+$/u, "");
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  return undefined;
}

function checkText(text: string): LedgerCheckText {
  const bytes = bytesOf(text);
  return { digest: sha256(text), bytes, ...(bytes <= CHECK_INLINE_MAX_BYTES ? { content: text } : {}) };
}

/** Validate a text expectation's shape; findings name what is wrong. */
function textExpectation(
  value: unknown,
  where: string,
  allowed: readonly ("equals" | "contains" | "matches")[],
  findings: CheckInputFinding[],
  node: string,
): LedgerTextExpectation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    findings.push({ check: "expect", node, fact: `${where} must be an object with ${allowed.join(" | ")}` });
    return undefined;
  }
  const before = findings.length;
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(allowed as readonly string[]).includes(key));
  if (unknown.length > 0) {
    findings.push({ check: "expect", node, fact: `${where} has unknown fields ${unknown.join(", ")}; accepted: ${allowed.join(", ")}` });
  }
  const out: LedgerTextExpectation = {};
  if (record.equals !== undefined) {
    if (typeof record.equals !== "string") findings.push({ check: "expect", node, fact: `${where}.equals must be a string` });
    else if (bytesOf(record.equals) > CHECK_EXPECT_TEXT_MAX) findings.push({ check: "expect", node, fact: `${where}.equals is longer than ${CHECK_EXPECT_TEXT_MAX} bytes` });
    else out.equals = record.equals;
  }
  if (record.contains !== undefined) {
    const list = stringList(record.contains);
    if (list === undefined || list.length === 0) findings.push({ check: "expect", node, fact: `${where}.contains must be a non-empty list of strings` });
    else if (list.length > CHECK_CONTAINS_MAX) findings.push({ check: "expect", node, fact: `${where}.contains holds more than ${CHECK_CONTAINS_MAX} strings` });
    else if (list.some((entry) => entry.length === 0 || bytesOf(entry) > CHECK_EXPECT_TEXT_MAX)) findings.push({ check: "expect", node, fact: `${where}.contains entries must be non-empty and at most ${CHECK_EXPECT_TEXT_MAX} bytes` });
    else out.contains = list;
  }
  if (record.matches !== undefined) {
    if (typeof record.matches !== "string" || record.matches.length === 0 || record.matches.length > CHECK_REGEX_MAX) {
      findings.push({ check: "expect", node, fact: `${where}.matches must be a regular expression of at most ${CHECK_REGEX_MAX} characters` });
    } else {
      // RX (D58c): the host evaluates it in bounded linear time
      // (bounded-regex.ts); one it cannot evaluate that way is refused here,
      // with the reason, never run through a backtracking engine.
      const compiled = boundedRegexOf(record.matches);
      if (compiled.ok) out.matches = record.matches;
      else findings.push({ check: "expect", node, fact: `${where}.matches ${compiled.reason}` });
    }
  }
  if (Object.keys(out).length === 0 && findings.length === before) {
    findings.push({ check: "expect", node, fact: `${where} names no expectation; use ${allowed.join(" | ")}` });
  }
  return out;
}

/** A tool's fixture `files` (relative path → text), as a case records them:
 * each text `{digest, bytes}` with its `content` when it is small, the larger
 * ones added to `contents` (digest → text) for the scratch store; `bytes` is
 * their total. Shared by `check` and `property` (D58), so both record
 * fixtures the same way. Findings are pushed, never thrown. */
export function normalizeFixtureFiles(
  value: unknown,
  node: string,
  findings: CheckInputFinding[],
  contents: Map<string, string>,
): { readonly files?: Record<string, LedgerCheckText>; readonly bytes: number } {
  if (value === undefined) return { bytes: 0 };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    findings.push({ check: "files", node, fact: "files must map relative paths to text" });
    return { bytes: 0 };
  }
  let total = 0;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > CHECK_FILES_MAX) findings.push({ check: "files", node, fact: `files holds more than ${CHECK_FILES_MAX} entries` });
  const files: Record<string, LedgerCheckText> = {};
  for (const [path, text] of entries.slice(0, CHECK_FILES_MAX)) {
    const safe = safeRelativePath(path);
    if (safe === undefined) {
      findings.push({ check: "files", node, fact: `fixture path "${path.slice(0, CHECK_PATH_MAX)}" must be relative, without .., at most ${CHECK_PATH_MAX} characters` });
      continue;
    }
    if (typeof text !== "string") {
      findings.push({ check: "files", node, fact: `fixture ${safe} must be text` });
      continue;
    }
    if (bytesOf(text) > CHECK_FILE_MAX_BYTES) {
      findings.push({ check: "files", node, fact: `fixture ${safe} is longer than ${CHECK_FILE_MAX_BYTES} bytes` });
      continue;
    }
    const recorded = checkText(text);
    total += recorded.bytes;
    if (recorded.content === undefined) contents.set(recorded.digest, text);
    files[safe] = recorded;
  }
  return { files, bytes: total };
}

/**
 * A check's expectations as the check tool records them (D48), and as every
 * evaluator re-checks them (D58c V5'): an object of `exit` (an integer from 0
 * to 255, 0 when absent), `stdout` (`equals` | `contains` | `matches`),
 * `stderr` (`contains`) and `files` (workspace-relative path → `equals` |
 * `contains`), each within the tool's bounds, a `matches` a regular
 * expression the host evaluates in bounded linear time (RX,
 * bounded-regex.ts). Findings are pushed, never thrown; what is returned is
 * the normalized form every evaluation reads.
 */
export function normalizeExpectations(value: unknown, node: string, findings: CheckInputFinding[]): LedgerCheckExpectation {
  const expect: LedgerCheckExpectation = {};
  if (value !== undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      findings.push({ check: "expect", node, fact: "expect must be an object with exit, stdout, stderr or files" });
    } else {
      const record = value as Record<string, unknown>;
      const unknown = Object.keys(record).filter((key) => !["exit", "stdout", "stderr", "files"].includes(key));
      if (unknown.length > 0) findings.push({ check: "expect", node, fact: `expect has unknown fields ${unknown.join(", ")}; accepted: exit, stdout, stderr, files` });
      if (record.exit !== undefined) {
        if (typeof record.exit !== "number" || !Number.isInteger(record.exit) || record.exit < 0 || record.exit > 255) {
          findings.push({ check: "expect", node, fact: "expect.exit must be an integer from 0 to 255" });
        } else expect.exit = record.exit;
      }
      if (record.stdout !== undefined) {
        const text = textExpectation(record.stdout, "expect.stdout", ["equals", "contains", "matches"], findings, node);
        if (text !== undefined && Object.keys(text).length > 0) expect.stdout = text;
      }
      if (record.stderr !== undefined) {
        const text = textExpectation(record.stderr, "expect.stderr", ["contains"], findings, node);
        if (text?.contains !== undefined) expect.stderr = { contains: text.contains };
      }
      if (record.files !== undefined) {
        if (typeof record.files !== "object" || record.files === null || Array.isArray(record.files)) {
          findings.push({ check: "expect", node, fact: "expect.files must map workspace-relative paths to { equals | contains }" });
        } else {
          const entries = Object.entries(record.files as Record<string, unknown>);
          if (entries.length > CHECK_EXPECT_FILES_MAX) findings.push({ check: "expect", node, fact: `expect.files holds more than ${CHECK_EXPECT_FILES_MAX} entries` });
          const out: Record<string, { equals?: string; contains?: string[] }> = {};
          for (const [path, entry] of entries.slice(0, CHECK_EXPECT_FILES_MAX)) {
            const safe = safeRelativePath(path);
            if (safe === undefined) {
              findings.push({ check: "expect", node, fact: `expect.files path "${path.slice(0, CHECK_PATH_MAX)}" must be workspace-relative, without ..` });
              continue;
            }
            const text = textExpectation(entry, `expect.files["${safe}"]`, ["equals", "contains"], findings, node);
            if (text !== undefined && Object.keys(text).length > 0) {
              out[safe] = { ...(text.equals !== undefined ? { equals: text.equals } : {}), ...(text.contains !== undefined ? { contains: text.contains } : {}) };
            }
          }
          if (Object.keys(out).length > 0) expect.files = out;
        }
      }
    }
  }
  // A check always carries its expectations, the default exit included, so
  // every observation knows it is a check and judges it the same way.
  if (expect.exit === undefined) expect.exit = 0;
  if (bytesOf(JSON.stringify(expect)) > CHECK_EXPECT_MAX_BYTES) {
    findings.push({ check: "expect", node, fact: `the expectations together are longer than ${CHECK_EXPECT_MAX_BYTES} bytes` });
  }
  return expect;
}

/** A recorded fixture or stdin text (D48) re-checked (V5'): `{digest, bytes,
 * content?}` — a sha256, a byte length within CHECK_FILE_MAX_BYTES, and the
 * text itself, when it rides inline, exactly `bytes` long. Undefined when it
 * is not that shape. */
export function recordedCheckTextOf(value: unknown): LedgerCheckText | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.digest)) return undefined;
  if (typeof record.bytes !== "number" || !Number.isInteger(record.bytes) || record.bytes < 0 || record.bytes > CHECK_FILE_MAX_BYTES) return undefined;
  if (record.content !== undefined && (typeof record.content !== "string" || bytesOf(record.content) !== record.bytes)) return undefined;
  return { digest: record.digest, bytes: record.bytes, ...(typeof record.content === "string" ? { content: record.content } : {}) };
}

/** A check case's recorded stdin, fixtures and expectations in the shapes the
 * check tool records — what every evaluator runs and judges (V5'). */
export interface CheckShape {
  readonly stdin?: LedgerCheckText;
  readonly files?: Record<string, LedgerCheckText>;
  readonly expect: LedgerCheckExpectation;
}

/**
 * D58c V5': only the tool that validates a case kind creates it, and every
 * evaluator re-checks the shape it relies on. A recorded check case's `stdin`,
 * `files` and `expect` re-checked against the check tool's own shapes and
 * bounds — its recorded texts (recordedCheckTextOf), at most CHECK_FILES_MAX
 * fixtures at relative paths, stdin and fixtures together within
 * CHECK_INPUT_MAX_BYTES, its expectations through the tool's own
 * normalisation (normalizeExpectations) — returning the normalized shape
 * every observation runs and judges, or why the case cannot be judged. A case
 * whose fields did not come through the check tool (a hand-written row,
 * another writer) is refused, stated — never judged on a shape the evaluator
 * cannot rely on, never a throw. Pure.
 */
export function checkShapeOf(item: Pick<LedgerCase, "stdin" | "files" | "expect">): { readonly ok: true; readonly shape: CheckShape } | { readonly ok: false; readonly reason: string } {
  const wrong: string[] = [];
  let total = 0;
  let stdin: LedgerCheckText | undefined;
  if (item.stdin !== undefined) {
    stdin = recordedCheckTextOf(item.stdin);
    if (stdin === undefined) wrong.push("stdin is not a text the check tool recorded ({digest, bytes, content?} within its bounds)");
    else total += stdin.bytes;
  }
  let files: Record<string, LedgerCheckText> | undefined;
  if (item.files !== undefined) {
    const value = item.files as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      wrong.push("files is not a map of relative paths to recorded texts");
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > CHECK_FILES_MAX) wrong.push(`files holds more than ${CHECK_FILES_MAX} entries`);
      files = {};
      for (const [path, text] of entries.slice(0, CHECK_FILES_MAX)) {
        const safe = safeRelativePath(path);
        const recorded = recordedCheckTextOf(text);
        if (safe === undefined || safe !== path) {
          wrong.push(`fixture path ${JSON.stringify(path.slice(0, CHECK_PATH_MAX))} is not a relative path the check tool records`);
          break;
        }
        if (recorded === undefined) {
          wrong.push(`fixture ${safe} is not a text the check tool recorded ({digest, bytes, content?} within its bounds)`);
          break;
        }
        files[safe] = recorded;
        total += recorded.bytes;
      }
    }
  }
  if (total > CHECK_INPUT_MAX_BYTES) wrong.push(`fixtures and stdin together are longer than ${CHECK_INPUT_MAX_BYTES} bytes`);
  const findings: CheckInputFinding[] = [];
  const expect = normalizeExpectations(item.expect, "case", findings);
  for (const finding of findings.slice(0, 3)) wrong.push(finding.fact);
  if (wrong.length > 0) {
    return { ok: false, reason: `the case's check fields are not the shapes the check tool records, so it is not judged: ${wrong.join("; ").slice(0, 600)}` };
  }
  return { ok: true, shape: { ...(stdin === undefined ? {} : { stdin }), ...(files === undefined || Object.keys(files).length === 0 ? {} : { files }), expect } };
}

/** The check tool's parameters, normalized into a ledger case and the texts
 * to store. Findings are data: nothing is recorded when there are any. */
export function normalizeCheckInput(params: Record<string, unknown>): NormalizedCheck {
  const findings: CheckInputFinding[] = [];
  const id = typeof params.id === "string" ? params.id.trim() : "";
  const node = id === "" ? "?" : id;
  if (id === "" || id.length > CHECK_ID_MAX) findings.push({ check: "id", node, fact: `id must be a non-empty string of at most ${CHECK_ID_MAX} characters` });
  const command = typeof params.command === "string" ? params.command : "";
  if (command.trim() === "") findings.push({ check: "command", node, fact: "command must be a non-empty string" });
  let dir: string | undefined;
  if (params.dir !== undefined) {
    const safe = typeof params.dir === "string" ? safeRelativePath(params.dir.trim()) : undefined;
    if (params.dir === "." || params.dir === "") dir = undefined;
    else if (safe === undefined) findings.push({ check: "dir", node, fact: "dir must be a workspace-relative directory without .." });
    else dir = safe;
  }
  const contents = new Map<string, string>();
  let total = 0;
  let stdin: LedgerCheckText | undefined;
  if (params.stdin !== undefined) {
    if (typeof params.stdin !== "string") findings.push({ check: "stdin", node, fact: "stdin must be text" });
    else if (bytesOf(params.stdin) > CHECK_FILE_MAX_BYTES) findings.push({ check: "stdin", node, fact: `stdin is longer than ${CHECK_FILE_MAX_BYTES} bytes` });
    else {
      stdin = checkText(params.stdin);
      total += stdin.bytes;
      if (stdin.content === undefined) contents.set(stdin.digest, params.stdin);
    }
  }
  const fixtures = normalizeFixtureFiles(params.files, node, findings, contents);
  const files = fixtures.files;
  total += fixtures.bytes;
  if (total > CHECK_INPUT_MAX_BYTES) findings.push({ check: "files", node, fact: `fixtures and stdin together are longer than ${CHECK_INPUT_MAX_BYTES} bytes` });
  const expect = normalizeExpectations(params.expect, node, findings);
  if (params.guard !== undefined && typeof params.guard !== "boolean") findings.push({ check: "guard", node, fact: "guard must be a boolean" });
  for (const link of ["todo", "scenario"] as const) {
    if (params[link] !== undefined && (typeof params[link] !== "string" || (params[link] as string).trim() === "")) {
      findings.push({ check: link, node, fact: `${link} must name a recorded ${link}` });
    }
  }
  if (params.timeout_ms !== undefined && (typeof params.timeout_ms !== "number" || !(params.timeout_ms > 0))) {
    findings.push({ check: "timeout_ms", node, fact: "timeout_ms must be a positive number" });
  }
  if (findings.length > 0) return { ok: false, findings };
  const item: LedgerCase = {
    id,
    command,
    ...(dir !== undefined ? { dir } : {}),
    ...(params.guard === true ? { guard: true } : {}),
    ...(typeof params.todo === "string" ? { todo: params.todo.trim() } : {}),
    ...(typeof params.scenario === "string" ? { scenario: params.scenario.trim() } : {}),
    ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
    ...(stdin !== undefined ? { stdin } : {}),
    ...(files !== undefined && Object.keys(files).length > 0 ? { files } : {}),
    expect,
  };
  return { ok: true, item, contents };
}

/** What one `check` call may write into the session's scratch (D48b), as an
 * upper bound, before it writes anything: the texts the store does not hold
 * yet, the case's fixture directory (its fixtures, their directories and the
 * host's parent directories), and one observation's stdin and output captures
 * — CHECK_READ_MAX_BYTES counted for each capture (a larger one is read whole,
 * in bounded chunks, and removed with the observation). `persistent` is what
 * stays once the observation's captures are removed. */
export function checkScratchNeed(
  scratch: string,
  item: Pick<LedgerCase, "files" | "stdin">,
  contents: ReadonlyMap<string, string>,
): { readonly total: { bytes: number; entries: number }; readonly persistent: { bytes: number; entries: number } } {
  let bytes = 0;
  let entries = 0;
  const root = scratchRootOf(scratch);
  for (const [digest, text] of contents) {
    if (root !== undefined && storedText(root, digest) !== undefined) continue;
    bytes += bytesOf(text);
    entries += 1;
  }
  const directories = new Set<string>();
  for (const [path, text] of Object.entries(item.files ?? {})) {
    bytes += text.bytes;
    entries += 1;
    for (let parent = posix.dirname(path); parent !== "." && parent !== "/" && parent !== ""; parent = posix.dirname(parent)) directories.add(parent);
  }
  // checks/, checks/<case>/, .host/ and .host/fixtures/.
  const persistent = { bytes, entries: entries + directories.size + 4 };
  // .host/observe/, its <nonce>/ directory, stdin, stdout and stderr.
  const observation = { bytes: (item.stdin?.bytes ?? 0) + 2 * CHECK_READ_MAX_BYTES, entries: 5 };
  return { total: { bytes: persistent.bytes + observation.bytes, entries: persistent.entries + observation.entries }, persistent };
}

/** Keep the texts too large to ride inline, under their digests. A text
 * already stored is left as it is: the store is content-addressed. Whatever
 * else stands at a text's place — a link (removed as the link), a directory,
 * a file of other bytes — is removed and the text written anew (S1: a link in
 * any component above it refuses the call, LinkSafetyError). */
export function storeCheckContents(scratch: string, contents: ReadonlyMap<string, string>): void {
  const root = safeRoot(scratch, "the session's scratch");
  for (const [digest, text] of contents) {
    if (storedText(root, digest) !== undefined) continue;
    const rel = storeRel(digest);
    if (lstatBeneath(root, rel, "write") !== undefined) removeTreeBeneath(root, rel, "write");
    writeBeneath(root, rel, Buffer.from(text), { mode: 0o644, parents: 0o755 });
  }
}

/** A recorded text, from the row or from the store; undefined when the
 * store no longer holds exactly that text (or no store is given, or the
 * store is reached only through a link). */
export function recordedText(scratch: string | undefined, text: LedgerCheckText): string | undefined {
  if (typeof text.content === "string") return sha256(text.content) === text.digest ? text.content : undefined;
  if (scratch === undefined) return undefined;
  const root = scratchRootOf(scratch);
  return root === undefined ? undefined : storedText(root, text.digest);
}

// --- one observation ----------------------------------------------------------

/** One prepared run: the shell text to execute, and where its stdin and
 * captures live. */
export interface PreparedCheckRun {
  readonly item: LedgerCase;
  /** The wrapped command; the caller prefixes its own shell options. */
  readonly wrapped: string;
  /** Where stdin and the captures live; absent for a check that needs
   * neither (no scratch is visible to the run, and none is needed). */
  readonly observeDir?: string;
  readonly checkDir?: string;
  /** The stdin materialised from the record, when the check has one (D57:
   * one of the inputs a recheck snapshots before the run). */
  readonly stdinPath?: string;
  /** Each expected produced file as it stood before the run (undefined when
   * absent), so a file the run did not write is not read as its output. */
  readonly before: Readonly<Record<string, FileSignature | undefined>>;
  /** The scratch its host files live in, pinned (S1), and the observation's
   * directory below it: the captures are read and removed only through it. */
  readonly scratchRoot?: SafeRoot;
  readonly observeRel?: Buffer;
  /** The policy the removal of its captures runs inside, when that policy
   * confines writes (S1). */
  readonly confinedBy?: SandboxPolicy;
}

/** What identifies one state of a file: a write changes at least one. */
interface FileSignature {
  readonly ino: number;
  readonly size: number;
  readonly mtimeNs: string;
}

function signatureOf(entry: BigIntStats): FileSignature {
  return { ino: Number(entry.ino), size: Number(entry.size), mtimeNs: entry.mtimeNs.toString() };
}

/** The tree the command ran on as a root the host pinned (S1), or undefined
 * when it is not a real directory. */
function treeRootOf(treeRoot: string): SafeRoot | undefined {
  try {
    return safeRoot(resolve(treeRoot), "the tree the check ran on");
  } catch {
    return undefined;
  }
}

/** An expected produced file's path below the tree, as bytes, or undefined
 * when the path would leave it. */
function producedRel(treeRoot: string, path: string): Buffer | undefined {
  const safe = safeRelativePath(path);
  if (safe === undefined) return undefined;
  const absolute = resolve(treeRoot, safe);
  return relative(resolve(treeRoot), absolute).startsWith("..") ? undefined : Buffer.from(safe);
}

/** What stands at a produced file's path, read without following a link
 * anywhere on it (S1): `through_link` when a directory above it is a link or
 * not a directory — then it is not a file of the tree. */
function producedEntry(tree: SafeRoot | undefined, rel: Buffer | undefined): BigIntStats | undefined | "through_link" {
  if (tree === undefined || rel === undefined) return undefined;
  try {
    return lstatBeneath(tree, rel);
  } catch {
    return "through_link";
  }
}

function signaturesBefore(item: LedgerCase, treeRoot: string): Record<string, FileSignature | undefined> {
  const out: Record<string, FileSignature | undefined> = {};
  const paths = Object.keys(item.expect?.files ?? {});
  const tree = paths.length === 0 ? undefined : treeRootOf(treeRoot);
  for (const path of paths) {
    const entry = producedEntry(tree, producedRel(treeRoot, path));
    out[path] = entry === undefined || entry === "through_link" ? undefined : signatureOf(entry);
  }
  return out;
}

/** The policy a scratch removal runs inside (S1): the check's own, when it
 * confines writes and binds that scratch; otherwise none, and the removal is
 * the host's own, link-safe walk. */
export function confiningPolicy(policy: Pick<SandboxPolicy, "scratchRoot">, scratch: string): SandboxPolicy | undefined {
  const full = policy as SandboxPolicy;
  return policy.scratchRoot === scratch && policyConfinesWrites(full) ? full : undefined;
}

/** How long the confined removal may take before the host removes it
 * itself. */
const CONFINED_REMOVE_TIMEOUT_MS = 60_000;

/**
 * Remove whatever stands at `rel` below the scratch (S1): nothing above it may
 * be a link (refused, LinkSafetyError); a link or a file there is removed as
 * itself; a directory is removed whole — by `rm -rf` inside `policy` when one
 * is given (it confines writes: whatever a concurrent process of the session
 * swaps in while `rm` runs, it can remove only what the session could), and
 * otherwise, or when that did not remove it, by the host's link-safe walk.
 */
export function removeScratchTree(policy: SandboxPolicy | undefined, root: SafeRoot, rel: Buffer): void {
  const entry = lstatBeneath(root, rel, "remove");
  if (entry === undefined) return;
  if (!entry.isDirectory()) {
    unlinkBeneath(root, rel, "remove");
    return;
  }
  if (policy !== undefined) {
    try {
      spawnFenced(policy, `/bin/rm -rf -- ${quote(beneath(root.path, rel).toString())}`, CONFINED_REMOVE_TIMEOUT_MS);
    } catch {
      // The helper could not run: the host's own walk below.
    }
    if (lstatBeneath(root, rel, "remove") === undefined) return;
  }
  removeTreeBeneath(root, rel, "remove");
}

/** A refusal's reason, as a `not_runnable` row carries it. */
export function refusedReason(what: string, error: LinkSafetyError): string {
  return `${what} refused (S1): ${error.message}`;
}

/** True when a check needs the scratch: fixtures, stdin, or an expectation
 * on what it printed. Exit code and produced files are read without it. */
export function checkNeedsScratch(item: Pick<LedgerCase, "files" | "stdin" | "expect">): boolean {
  return item.files !== undefined || item.stdin !== undefined
    || item.expect?.stdout !== undefined || item.expect?.stderr !== undefined;
}

/** Single-quote a path for the shell. */
function quote(text: string): string {
  return `'${text.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Write the fixtures of `item` from its record into its check directory and
 * wrap `launched` (the command as the caller would run it, its dir already
 * composed) so its stdin is the recorded text and its stdout and stderr are
 * captured apart. The scratch is the one the policy binds; a policy without
 * one (a Docker world) cannot see the fixtures, and the run is not started.
 */
export function prepareCheckRun(input: {
  readonly item: LedgerCase;
  readonly policy: Pick<SandboxPolicy, "scratchRoot">;
  readonly launched: string;
  /** The tree the command runs on: expected produced files are read there. */
  readonly treeRoot: string;
}): { readonly ok: true; readonly run: PreparedCheckRun } | { readonly ok: false; readonly reason: string } {
  // V5' (D58c): the shape this run and its evaluation rely on, re-checked —
  // whoever recorded the case; the run judges the normalized shape only.
  const checked = checkShapeOf(input.item);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const { stdin: _stdin, files: _files, expect: _expect, ...rest } = input.item;
  const item: LedgerCase = { ...rest, ...checked.shape };
  if (typeof item.id !== "string" || item.id.length === 0) return { ok: false, reason: "the case has no id" };
  const scratch = input.policy.scratchRoot;
  if (scratch === undefined) {
    if (!checkNeedsScratch(item)) {
      return { ok: true, run: { item, wrapped: input.launched, before: signaturesBefore(item, input.treeRoot) } };
    }
    return { ok: false, reason: "no session scratch space is visible to this run, so the check's fixtures and captures cannot be kept" };
  }
  // The scratch as the root every host operation below is relative to (S1):
  // a link in its place, or anywhere on a path below it, refuses the run.
  let root: SafeRoot;
  try {
    root = safeRoot(scratch, "the session's scratch");
  } catch (error) {
    if (error instanceof LinkSafetyError) return { ok: false, reason: refusedReason("the check's scratch", error) };
    throw error;
  }
  const checkDir = checkDirFor(scratch, item.id);
  const checkRel = Buffer.from(`checks/${checkDirName(item.id)}`);
  const texts: [string, string][] = [];
  for (const [path, recorded] of Object.entries(item.files ?? {})) {
    const safe = safeRelativePath(path);
    if (safe === undefined) return { ok: false, reason: `fixture path ${JSON.stringify(path.slice(0, CHECK_PATH_MAX))} is not relative` };
    const text = recordedText(scratch, recorded);
    if (text === undefined) return { ok: false, reason: `fixture ${safe} is not available as recorded (digest ${recorded.digest.slice(0, 12)})` };
    texts.push([safe, text]);
  }
  let stdinText: string | undefined;
  if (item.stdin !== undefined) {
    stdinText = recordedText(scratch, item.stdin);
    if (stdinText === undefined) return { ok: false, reason: `stdin is not available as recorded (digest ${item.stdin.digest.slice(0, 12)})` };
  }
  const confinedBy = confiningPolicy(input.policy, scratch);
  const observeRel = Buffer.from(`.host/observe/${randomBytes(8).toString("hex")}`);
  let observing = false;
  try {
    // The fixture directory is the record's, rewritten before every run:
    // whatever stands there is removed first, a link as the link.
    removeScratchTree(confinedBy, root, checkRel);
    ensureDirBeneath(root, checkRel, 0o755, "write");
    for (const [path, text] of texts) {
      writeBeneath(root, beneath(checkRel, Buffer.from(path)), Buffer.from(text), { mode: 0o644, parents: 0o755 });
    }
    ensureDirBeneath(root, observeRel, 0o755, "write");
    observing = true;
    if (stdinText !== undefined) writeBeneath(root, beneath(observeRel, Buffer.from("stdin")), Buffer.from(stdinText), { mode: 0o644 });
  } catch (error) {
    // Nothing of this observation outlives it, even a run never started.
    if (observing) {
      try {
        removeScratchTree(confinedBy, root, observeRel);
      } catch {
        // Refused as well: left where it is, never followed.
      }
    }
    if (error instanceof LinkSafetyError) return { ok: false, reason: refusedReason("the check's scratch", error) };
    throw error;
  }
  const observeDir = join(scratch, observeRel.toString());
  const stdinPath = stdinText === undefined ? "/dev/null" : join(observeDir, "stdin");
  const stdoutPath = join(observeDir, "stdout");
  const stderrPath = join(observeDir, "stderr");
  // A subshell, so an `exit` in the command ends only the command; the
  // captures are replayed afterwards, so the combined output the receipt and
  // the model see is still the command's own.
  const wrapped = `export ${CHECK_DIR_ENV}=${quote(checkDir)}; ( ${input.launched}\n) < ${quote(stdinPath)} > ${quote(stdoutPath)} 2> ${quote(stderrPath)}; `
    + `__dokkabi_check_exit=$?; cat ${quote(stdoutPath)}; cat ${quote(stderrPath)} >&2; exit $__dokkabi_check_exit`;
  return {
    ok: true,
    run: {
      item: item, wrapped, observeDir, checkDir,
      ...(stdinText === undefined ? {} : { stdinPath }),
      before: signaturesBefore(item, input.treeRoot),
      scratchRoot: root,
      observeRel,
      ...(confinedBy === undefined ? {} : { confinedBy }),
    },
  };
}

/** What a capture that does not exist is observed as. */
const NOT_CAPTURED: ObservedText = { missing: "the command's output was not captured" };

/** One capture or produced file as the evaluator reads it: the whole text
 * when it is at most CHECK_READ_MAX_BYTES, otherwise its size, its first
 * CHECK_READ_MAX_BYTES bytes (what a result shows) and how to open it again,
 * which the evaluator does to read it whole in bounded chunks. Read below a
 * pinned root without following a link anywhere on its path (S1); undefined
 * when it is not a regular file reached that way. */
function observedText(root: SafeRoot, rel: Buffer): ObservedText | undefined {
  let file: OpenedFile | undefined;
  try {
    file = openBeneath(root, rel);
  } catch {
    return undefined;
  }
  if (file === undefined) return undefined;
  try {
    const head = readOpened(file, Math.min(file.size, CHECK_READ_MAX_BYTES));
    file.verify();
    const text = new TextDecoder("utf-8").decode(head);
    if (file.size <= CHECK_READ_MAX_BYTES) return text;
    const { dev, ino } = file;
    // Opened again only as the same file, through the same verified path.
    const open = (): number => {
      const again = openBeneath(root, rel);
      if (again === undefined) throw new Error("the output is gone");
      if (again.dev !== dev || again.ino !== ino) {
        again.close();
        throw new Error("the output was replaced while it was evaluated");
      }
      return again.fd;
    };
    return { path: displayPath(beneath(root.path, rel)), bytes: file.size, head: text, open };
  } catch {
    return undefined;
  } finally {
    file.close();
  }
}

/** Remove one run's stdin and captures (S1: through the pinned scratch,
 * inside the check's own policy when it confines writes). A removal that is
 * refused leaves them where they are, never followed. */
export function discardCheckRun(run: PreparedCheckRun): void {
  if (run.scratchRoot === undefined || run.observeRel === undefined) return;
  try {
    removeScratchTree(run.confinedBy, run.scratchRoot, run.observeRel);
  } catch {
    // Refused (a link was put in place of a directory on its path): nothing
    // outside the scratch is touched, and the captures are left.
  }
}

/** Read what the run left, evaluate it, and remove the captures. `treeRoot`
 * is the tree the command ran on (the live workspace or a copy); the files the
 * check expects are read there. The captures are evaluated before they are
 * removed: a large one is read whole from disk. */
export function completeCheckRun(input: {
  readonly run: PreparedCheckRun;
  readonly exitCode: number | undefined;
  readonly treeRoot: string;
}): CheckEvaluation {
  try {
    const { scratchRoot, observeRel } = input.run;
    const capture = (name: "stdout" | "stderr"): ObservedText =>
      scratchRoot === undefined || observeRel === undefined ? NOT_CAPTURED : observedText(scratchRoot, beneath(observeRel, Buffer.from(name))) ?? NOT_CAPTURED;
    const files: Record<string, ObservedFile> = {};
    const expected = Object.keys(input.run.item.expect?.files ?? {});
    const tree = expected.length === 0 ? undefined : treeRootOf(input.treeRoot);
    for (const path of expected) {
      const rel = producedRel(input.treeRoot, path);
      const entry = producedEntry(tree, rel);
      // Reached only through a link (S1): not a file of the tree, never read.
      if (entry === "through_link") {
        files[path] = { state: "not_a_file" };
        continue;
      }
      if (entry === undefined || rel === undefined || tree === undefined) {
        files[path] = { state: "missing" };
        continue;
      }
      // A file that stands exactly as it stood before the run was not
      // produced by it: an earlier run's output is not this run's evidence.
      const before = input.run.before[path];
      const after = signatureOf(entry);
      if (before !== undefined && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs) {
        files[path] = { state: "not_written" };
        continue;
      }
      const text = entry.isFile() ? observedText(tree, rel) : undefined;
      files[path] = text === undefined ? { state: "not_a_file" } : { state: "present", text };
    }
    return evaluateCheck(input.run.item.expect, {
      ...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
      stdout: capture("stdout"),
      stderr: capture("stderr"),
      files,
    });
  } finally {
    discardCheckRun(input.run);
  }
}

// --- the evaluator --------------------------------------------------------------

/**
 * One captured stream or produced file as the evaluator reads it (D49):
 *   - a string: the whole text, held in memory;
 *   - `{ path, bytes, head }`: a text larger than CHECK_READ_MAX_BYTES on
 *     disk — `head` is its first CHECK_READ_MAX_BYTES bytes, all a result ever
 *     shows, and every verdict on it is computed over all `bytes` of it, read
 *     in bounded chunks;
 *   - `{ missing }`: no capture exists, so nothing about the stream is claimed
 *     (it is never read as empty text).
 * The same record and the same observation give the same verdict wherever it
 * runs.
 */
export type ObservedText =
  | string
  /** `open` (S1) opens exactly the file observed, through the verified path
   * it was read on; without it the path is opened, never following a link at
   * its end. */
  | { readonly path: string; readonly bytes: number; readonly head: string; readonly open?: () => number }
  | { readonly missing: string };

export type ObservedFile =
  | { readonly state: "present"; readonly text: ObservedText }
  | { readonly state: "missing" }
  | { readonly state: "not_a_file" }
  /** Present, but untouched by this run: left by something earlier. */
  | { readonly state: "not_written" };

export interface CheckObserved {
  readonly exit_code?: number;
  readonly stdout: ObservedText;
  readonly stderr: ObservedText;
  readonly files: Readonly<Record<string, ObservedFile>>;
}

export type ExpectationKind =
  | "exit"
  | "stdout_equals"
  | "stdout_contains"
  | "stdout_matches"
  | "stderr_contains"
  | "file_equals"
  | "file_contains";

/** One expectation as observed: what was expected, what was seen (bounded),
 * and for an `equals` that failed, where the texts first differ and a bounded
 * unified diff. */
export interface ExpectationResult {
  readonly kind: ExpectationKind;
  /** The file path (file_*) or the substring / pattern (contains, matches). */
  readonly target?: string;
  readonly pass: boolean;
  readonly expected: string;
  readonly observed: string;
  readonly first_difference?: { readonly line: number; readonly expected: string; readonly observed: string };
  readonly diff?: string;
  /** Why the verdict is what it is, when the texts alone do not say: an
   * observation larger than what is shown, or one that was not captured. */
  readonly reason?: string;
  /** False when the host did not judge this expectation (RX: its regular
   * expression passed the evaluation's bound; V5': its shape is not one the
   * check tool records): `pass` is then false, and it is no evidence either
   * way. */
  readonly judged?: false;
}

export interface CheckEvaluation {
  readonly green: boolean;
  readonly results: readonly ExpectationResult[];
  /** Why the observation is no verdict (RX, V5'): some expectation was not
   * judged and none that was judged failed. Every caller records such an
   * observation as not_runnable — unknown, never green and never red. */
  readonly unjudged?: string;
}

/** How much observed text one result carries back. */
const OBSERVED_MAX = 1_000;
const DIFF_MAX_LINES = 40;
const DIFF_MAX_CHARS = 2_000;
const DIFF_LCS_MAX_LINES = 400;

function head(text: string, max = OBSERVED_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/** Texts compare with CRLF read as LF and trailing newlines ignored: a
 * command's final newline is not part of what it says. The trailing newlines
 * are counted from the end in one pass — an anchored `\n+$` retries from every
 * newline of a long run that ends in something else, quadratic in the run. */
function comparable(text: string): string {
  const lf = text.replace(/\r\n/gu, "\n");
  let end = lf.length;
  while (end > 0 && lf.charCodeAt(end - 1) === 10) end -= 1;
  return lf.slice(0, end);
}

function firstDifference(expected: string, observed: string): { line: number; expected: string; observed: string } | undefined {
  const left = expected.split("\n");
  const right = observed.split("\n");
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] !== right[index]) {
      return {
        line: index + 1,
        expected: head(left[index] ?? "(no line)", 300),
        observed: head(right[index] ?? "(no line)", 300),
      };
    }
  }
  return undefined;
}

/** A bounded unified diff (expected → observed) over at most
 * DIFF_LCS_MAX_LINES lines a side; undefined past that. */
export function boundedUnifiedDiff(expected: string, observed: string): string | undefined {
  const a = expected.split("\n");
  const b = observed.split("\n");
  if (a.length > DIFF_LCS_MAX_LINES || b.length > DIFF_LCS_MAX_LINES) return undefined;
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: { op: " " | "-" | "+"; line: string; a: number; b: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", line: a[i]!, a: i, b: j });
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      ops.push({ op: "-", line: a[i]!, a: i, b: j });
      i += 1;
    } else {
      ops.push({ op: "+", line: b[j]!, a: i, b: j });
      j += 1;
    }
  }
  // One hunk around the changes, three lines of context each side.
  const changed = ops.map((entry, index) => (entry.op === " " ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return undefined;
  const from = Math.max(0, changed[0]! - 3);
  const to = Math.min(ops.length, changed.at(-1)! + 4);
  const slice = ops.slice(from, to);
  const startA = (slice.find((entry) => entry.op !== "+")?.a ?? 0) + 1;
  const startB = (slice.find((entry) => entry.op !== "-")?.b ?? 0) + 1;
  const lenA = slice.filter((entry) => entry.op !== "+").length;
  const lenB = slice.filter((entry) => entry.op !== "-").length;
  const lines = ["--- expected", "+++ observed", `@@ -${startA},${lenA} +${startB},${lenB} @@`];
  let dropped = 0;
  for (const entry of slice) {
    if (lines.length >= DIFF_MAX_LINES + 3) {
      dropped += 1;
      continue;
    }
    lines.push(`${entry.op}${head(entry.line, 200)}`);
  }
  if (dropped > 0) lines.push(`… ${dropped} more diff lines`);
  const text = lines.join("\n");
  return text.length <= DIFF_MAX_CHARS ? text : `${text.slice(0, DIFF_MAX_CHARS)}\n… diff cut at ${DIFF_MAX_CHARS} characters`;
}

/** A text larger than CHECK_READ_MAX_BYTES, on disk. */
type OnDisk = { readonly path: string; readonly bytes: number; readonly head: string; readonly open?: () => number };

/** What a result shows of an observation: the text (bounded), the head of a
 * larger one with its size, or why there is nothing to show. */
function shown(text: ObservedText): string {
  if (typeof text === "string") return head(text);
  if ("missing" in text) return `(not captured: ${text.missing})`;
  return `${text.head.slice(0, OBSERVED_MAX)}… [${text.bytes} bytes in all]`;
}

/** Why an observation larger than what is shown still has an exact verdict. */
function wholeReason(text: OnDisk, done: string): string {
  return `the output is ${text.bytes} bytes; ${done} over all of it (only the first ${CHECK_READ_MAX_BYTES} bytes are shown)`;
}

function readFailure(error: unknown): string {
  return `the output could not be read in full: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
}

/** Every character of a text on disk, decoded, one bounded chunk at a time. */
function* diskChunks(text: OnDisk): Generator<string> {
  const fd = text.open?.() ?? openSync(text.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const decoder = new TextDecoder("utf-8");
    const buffer = Buffer.alloc(CHECK_STREAM_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const decoded = decoder.decode(buffer.subarray(0, read), { stream: true });
      if (decoded.length > 0) yield decoded;
    }
    const rest = decoder.decode();
    if (rest.length > 0) yield rest;
  } finally {
    closeSync(fd);
  }
}

/** The line a comparison departs on, as far as one chunk shows it. */
const DEPARTURE_LINE_MAX = 300;

/**
 * Whether a text on disk equals `want` (already comparable) under the same
 * normalization as comparable(): read as CRLF → LF, it must be exactly `want`
 * followed by nothing but newlines. Bounded memory: one chunk at a time. When
 * it is not, where it first departs: the 1-based line, and that line of the
 * output as far as it can be shown.
 */
function diskEquals(text: OnDisk, want: string): { readonly equal: true } | { readonly equal: false; readonly line: number; readonly observed: string } {
  let at = 0;
  let line = 1;
  // The part of the current line already matched: `want`'s, since the text
  // equals it so far (nothing, once past it — only newlines are matched there).
  let lineStart = 0;
  let pendingCr = false;
  const accept = (ch: string): boolean => {
    const ok = at < want.length ? want[at] === ch : ch === "\n";
    if (!ok) return false;
    at += 1;
    if (ch === "\n") {
      line += 1;
      lineStart = at;
    }
    return true;
  };
  const departure = (rest: string) => {
    const matched = lineStart <= want.length ? want.slice(lineStart, Math.min(at, want.length)) : "";
    const tail = rest.split("\n", 1)[0] ?? "";
    return { equal: false as const, line, observed: `${matched}${tail}`.slice(0, DEPARTURE_LINE_MAX) };
  };
  for (const chunk of diskChunks(text)) {
    // Past the expected text only newlines may follow: a chunk without a
    // carriage return is checked in one search instead of per character.
    if (at >= want.length && !pendingCr && !chunk.includes("\r")) {
      const other = chunk.search(/[^\n]/u);
      const newlines = other < 0 ? chunk.length : other;
      at += newlines;
      line += newlines;
      if (newlines > 0) lineStart = at;
      if (other >= 0) return departure(chunk.slice(other, other + DEPARTURE_LINE_MAX));
      continue;
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const ch = chunk[index]!;
      if (pendingCr) {
        pendingCr = false;
        if (ch === "\n") {
          if (!accept("\n")) return departure(chunk.slice(index, index + DEPARTURE_LINE_MAX));
          continue;
        }
        if (!accept("\r")) return departure(`\r${chunk.slice(index, index + DEPARTURE_LINE_MAX)}`);
      }
      if (ch === "\r") {
        pendingCr = true;
        continue;
      }
      if (!accept(ch)) return departure(chunk.slice(index, index + DEPARTURE_LINE_MAX));
    }
  }
  if (pendingCr && !accept("\r")) return departure("\r");
  return at >= want.length ? { equal: true } : departure("");
}

/** Which of the needles a text on disk contains anywhere: chunk by chunk,
 * each chunk searched together with the end of the one before it, as long as
 * the longest needle, so no occurrence across a chunk boundary is missed. */
function diskContains(text: OnDisk, needles: readonly string[]): boolean[] {
  const found = needles.map(() => false);
  const overlap = Math.max(0, ...needles.map((needle) => needle.length));
  let carry = "";
  for (const chunk of diskChunks(text)) {
    const window = carry + chunk;
    needles.forEach((needle, index) => {
      if (!found[index] && window.includes(needle)) found[index] = true;
    });
    if (found.every(Boolean)) break;
    carry = window.slice(Math.max(0, window.length - overlap));
  }
  return found;
}

function equalsResult(kind: "stdout_equals" | "file_equals", target: string | undefined, expected: string, observed: ObservedText): ExpectationResult {
  const where = target !== undefined ? { target } : {};
  const want = comparable(expected);
  if (typeof observed === "string") {
    const got = comparable(observed);
    if (want === got) return { kind, ...where, pass: true, expected: head(expected), observed: head(observed) };
    const first = firstDifference(want, got);
    const diff = boundedUnifiedDiff(want, got);
    return {
      kind,
      ...where,
      pass: false,
      expected: head(expected),
      observed: head(observed),
      ...(first !== undefined ? { first_difference: first } : {}),
      ...(diff !== undefined ? { diff } : {}),
    };
  }
  if ("missing" in observed) return { kind, ...where, pass: false, expected: head(expected), observed: shown(observed), reason: observed.missing };
  let compared: ReturnType<typeof diskEquals>;
  try {
    compared = diskEquals(observed, want);
  } catch (error) {
    return { kind, ...where, pass: false, expected: head(expected), observed: shown(observed), reason: readFailure(error) };
  }
  if (compared.equal) return { kind, ...where, pass: true, expected: head(expected), observed: shown(observed) };
  // Where the whole output first departs from the expected text followed only
  // by newlines: every line before it matched, or was one of those newlines.
  return {
    kind,
    ...where,
    pass: false,
    expected: head(expected),
    observed: shown(observed),
    first_difference: {
      line: compared.line,
      expected: head(want.split("\n")[compared.line - 1] ?? "(no line)", 300),
      observed: head(compared.observed, 300),
    },
    reason: wholeReason(observed, "it was compared"),
  };
}

/** One result per needle, the observation searched once for all of them. */
function containsResults(
  kind: "stdout_contains" | "stderr_contains" | "file_contains",
  target: string | undefined,
  needles: readonly string[],
  observed: ObservedText,
): ExpectationResult[] {
  const one = (needle: string, pass: boolean, reason?: string): ExpectationResult => ({
    kind,
    target: target ?? head(needle, 200),
    pass,
    expected: head(needle),
    observed: shown(observed),
    ...(reason !== undefined && !pass ? { reason } : {}),
  });
  if (needles.length === 0) return [];
  if (typeof observed === "string") return needles.map((needle) => one(needle, observed.includes(needle)));
  if ("missing" in observed) return needles.map((needle) => one(needle, false, observed.missing));
  try {
    const found = diskContains(observed, needles);
    return needles.map((needle, index) => one(needle, found[index] === true, wholeReason(observed, "it was searched")));
  } catch (error) {
    return needles.map((needle) => one(needle, false, readFailure(error)));
  }
}

/** A regular expression is evaluated by the bounded linear-time engine (RX,
 * bounded-regex.ts) over the WHOLE observation — a text held in memory, or one
 * larger than that read from disk in bounded chunks — never on a part of it;
 * past the engine's bound, or for a pattern it cannot evaluate, the
 * expectation is not judged. An output that was not captured fails it, as it
 * fails every text expectation. */
function matchesResult(pattern: string, observed: ObservedText): ExpectationResult {
  const base = { kind: "stdout_matches" as const, target: head(pattern, 200), expected: head(pattern), observed: shown(observed) };
  if (typeof observed !== "string" && "missing" in observed) return { ...base, pass: false, reason: observed.missing };
  const compiled = boundedRegexOf(pattern);
  if (!compiled.ok) return { ...base, pass: false, judged: false, reason: `the regular expression ${compiled.reason}` };
  const run = new BoundedRegexRun(compiled.program);
  if (typeof observed === "string") {
    run.push(observed);
  } else {
    try {
      for (const chunk of diskChunks(observed)) {
        run.push(chunk);
        if (run.done !== undefined) break;
      }
    } catch (error) {
      return { ...base, pass: false, reason: readFailure(error) };
    }
  }
  const verdict = run.end();
  if (verdict.kind === "not_judged") return { ...base, pass: false, judged: false, reason: verdict.reason };
  const pass = verdict.kind === "match";
  return typeof observed === "string"
    ? { ...base, pass }
    : { ...base, pass, reason: wholeReason(observed, "it was searched") };
}

/** Evaluate every expectation against one observation: the same record and
 * the same observation give the same verdict wherever it runs. Every verdict
 * covers the whole of what it judges (ObservedText); absent expectations mean
 * exit 0. */
export function evaluateCheck(recorded: LedgerCheckExpectation | undefined, observed: CheckObserved): CheckEvaluation {
  // V5' (D58c): the shape this evaluation relies on, re-checked through the
  // check tool's own normalisation; one it does not record is not judged.
  const shapeFindings: CheckInputFinding[] = [];
  const expect = normalizeExpectations(recorded, "case", shapeFindings);
  if (shapeFindings.length > 0) {
    const reason = `the case's expectations are not the shapes the check tool records, so it is not judged: ${shapeFindings.slice(0, 3).map((item) => item.fact).join("; ").slice(0, 400)}`;
    return {
      green: false,
      results: [{ kind: "exit", pass: false, judged: false, expected: "(not judged)", observed: observed.exit_code === undefined ? "none" : String(observed.exit_code), reason }],
      unjudged: reason,
    };
  }
  const results: ExpectationResult[] = [];
  const exit = expect.exit ?? 0;
  results.push({
    kind: "exit",
    pass: observed.exit_code === exit,
    expected: String(exit),
    observed: observed.exit_code === undefined ? "none (the process did not complete)" : String(observed.exit_code),
  });
  const stdout = expect?.stdout;
  if (stdout?.equals !== undefined) results.push(equalsResult("stdout_equals", undefined, stdout.equals, observed.stdout));
  results.push(...containsResults("stdout_contains", undefined, stdout?.contains ?? [], observed.stdout));
  if (stdout?.matches !== undefined) results.push(matchesResult(stdout.matches, observed.stdout));
  results.push(...containsResults("stderr_contains", undefined, expect?.stderr?.contains ?? [], observed.stderr));
  for (const [path, want] of Object.entries(expect?.files ?? {})) {
    const file = observed.files[path] ?? { state: "missing" as const };
    if (file.state === "present") {
      if (want.equals !== undefined) results.push(equalsResult("file_equals", path, want.equals, file.text));
      results.push(...containsResults("file_contains", path, want.contains ?? [], file.text));
      continue;
    }
    const seen = file.state === "missing" ? "(missing)"
      : file.state === "not_written" ? "(not written by this run: unchanged since before it)"
      : "(not a regular file)";
    if (want.equals !== undefined) results.push({ kind: "file_equals", target: path, pass: false, expected: head(want.equals), observed: seen });
    for (const needle of want.contains ?? []) {
      results.push({ kind: "file_contains", target: path, pass: false, expected: head(needle), observed: head(seen) });
    }
  }
  // Red only on an expectation judged false; unknown when one was not judged
  // and nothing judged failed (RX, V5').
  const green = results.every((result) => result.pass);
  const failedJudged = results.some((result) => !result.pass && result.judged !== false);
  const unjudged = green || failedJudged ? undefined : results.find((result) => result.judged === false)?.reason;
  return { green, results, ...(unjudged === undefined ? {} : { unjudged }) };
}

/** The expectation results as an observation row carries them: bounded, so
 * a row stays small; a failing one keeps its first difference. */
export function expectationRowFields(evaluation: CheckEvaluation): { expectations: Record<string, unknown>[] } {
  return {
    expectations: evaluation.results.map((result) => ({
      kind: result.kind,
      ...(result.target !== undefined ? { target: head(result.target, 120) } : {}),
      pass: result.pass,
      ...(result.judged === false ? { judged: false } : {}),
      ...(result.pass ? {} : {
        expected: head(result.expected, 200),
        observed: head(result.observed, 200),
        ...(result.first_difference !== undefined ? { first_difference: result.first_difference } : {}),
        ...(result.reason !== undefined ? { reason: head(result.reason, 300) } : {}),
      }),
    })),
  };
}

/** The text a `check` call returns (T3): the verdict, then per expectation
 * what was expected and what was observed, the exit code, the duration and
 * the case id. */
export function formatCheckResult(input: {
  readonly id: string;
  readonly revision: number;
  readonly status: "green" | "red" | "not_runnable";
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly evaluation?: CheckEvaluation;
  readonly reason?: string;
  readonly outputHead?: string;
  readonly findings?: readonly { readonly check: string; readonly fact: string }[];
}): string {
  const verdict = input.status === "green" ? "PASS" : input.status === "red" ? "FAIL" : "NOT RUN";
  const lines = [
    `check ${input.id}: ${verdict} (recorded as ledger case ${input.id}, revision ${input.revision})`,
    `exit ${input.exitCode ?? "none"}; ${input.durationMs ?? 0} ms`,
  ];
  if (input.reason !== undefined) lines.push(`why: ${input.reason}`);
  for (const result of input.evaluation?.results ?? []) {
    const label = result.target !== undefined && result.kind !== "exit" ? `${result.kind} ${JSON.stringify(result.target)}` : result.kind;
    if (result.pass) {
      lines.push(`ok   ${label}`);
      continue;
    }
    lines.push(`FAIL ${label}`);
    if (result.kind === "exit") {
      lines.push(`     expected ${result.expected}, observed ${result.observed}`);
    } else if (result.first_difference !== undefined) {
      lines.push(`     first difference at line ${result.first_difference.line}:`);
      lines.push(`     expected: ${JSON.stringify(result.first_difference.expected)}`);
      lines.push(`     observed: ${JSON.stringify(result.first_difference.observed)}`);
      if (result.diff !== undefined) lines.push(result.diff);
    } else {
      lines.push(`     expected: ${JSON.stringify(result.expected)}`);
      lines.push(`     observed: ${JSON.stringify(result.observed)}`);
    }
    if (result.reason !== undefined) lines.push(`     why: ${result.reason}`);
  }
  if (input.status !== "green" && input.outputHead !== undefined && input.outputHead.length > 0
    && !(input.evaluation?.results ?? []).some((result) => !result.pass && result.kind !== "exit")) {
    lines.push("output:", head(input.outputHead, OBSERVED_MAX));
  }
  for (const finding of input.findings ?? []) lines.push(`note (${finding.check}): ${finding.fact}`);
  return lines.join("\n");
}

/** At most this many bytes of fixture and stdin text ride in one fix order's
 * check specs together (D48); a text past the bound is named by digest. */
export const FIX_ORDER_CHECK_TEXT_MAX_BYTES = 128 * 1_024;

/** A red check case as the fix session can pass it to its own `check` tool
 * verbatim: `{id, command, dir?, stdin?, files?, expect, timeout_ms?}` — no
 * todo or scenario link, which names the verifier's graph, not the fixer's.
 * Texts come from the record (inline, or the recording session's store by
 * digest) while `budget.left` allows; a text that does not fit, or that the
 * store no longer holds, is left out of the spec and listed in `omitted`. A
 * `property` case (D58) is rendered as its own tool takes it: `{id,
 * principle, command, dir?, files?, cases, seed, time_budget_ms,
 * max_counterexamples}`. Undefined when the recorded fields are not the
 * shapes the tools record (D58c V5': the spec is read only through the shape
 * the tool that records it validates — a hand-written row gets no spec, and
 * never throws). */
export function fixOrderCheckSpec(
  item: LedgerCase,
  scratch: string | undefined,
  budget: { left: number },
): { readonly spec: Record<string, unknown>; readonly omitted: readonly { readonly what: string; readonly bytes: number; readonly digest: string }[] } | undefined {
  if (typeof item.id !== "string" || typeof item.command !== "string") return undefined;
  const dir = typeof item.dir === "string" ? item.dir : undefined;
  let stdinText: LedgerCheckText | undefined;
  let fileTexts: Record<string, LedgerCheckText> | undefined;
  let expect: LedgerCheckExpectation | undefined;
  let property: LedgerProperty | undefined;
  if (item.property !== undefined) {
    const bounds = propertyBoundsOf(item.property);
    const shape = checkShapeOf({ ...(item.files === undefined ? {} : { files: item.files }) });
    if (!bounds.ok || !shape.ok) return undefined;
    property = bounds.property;
    fileTexts = shape.shape.files;
  } else {
    const shape = checkShapeOf(item);
    if (!shape.ok) return undefined;
    stdinText = shape.shape.stdin;
    fileTexts = shape.shape.files;
    // The expectations as recorded (their shape re-checked above): the spec
    // the fixer passes back is byte for byte the one the verifier's tool
    // recorded.
    expect = item.expect ?? { exit: 0 };
  }
  const omitted: { what: string; bytes: number; digest: string }[] = [];
  const take = (what: string, text: LedgerCheckText): string | undefined => {
    const value = text.bytes <= budget.left ? recordedText(scratch, text) : undefined;
    if (value === undefined) {
      omitted.push({ what, bytes: text.bytes, digest: text.digest });
      return undefined;
    }
    budget.left -= text.bytes;
    return value;
  };
  const stdin = stdinText === undefined ? undefined : take("stdin", stdinText);
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(fileTexts ?? {})) {
    const value = take(`fixture ${path}`, text);
    if (value !== undefined) files[path] = value;
  }
  if (property !== undefined) {
    return {
      spec: {
        id: item.id,
        principle: property.principle,
        command: item.command,
        ...(dir !== undefined ? { dir } : {}),
        ...(Object.keys(files).length > 0 ? { files } : {}),
        cases: property.cases,
        seed: property.seed,
        time_budget_ms: property.time_budget_ms,
        max_counterexamples: property.max_counterexamples,
      },
      omitted,
    };
  }
  return {
    spec: {
      id: item.id,
      command: item.command,
      ...(dir !== undefined ? { dir } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
      ...(Object.keys(files).length > 0 ? { files } : {}),
      expect: expect ?? { exit: 0 },
      ...(typeof item.timeout_ms === "number" ? { timeout_ms: item.timeout_ms } : {}),
    },
    omitted,
  };
}

