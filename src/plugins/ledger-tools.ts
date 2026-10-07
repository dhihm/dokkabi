import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventLog } from "../host/event-log.ts";
import type { PluginModule, ToolContributionRegistry } from "../loader/types.ts";
import { createAskOperatorTool, createNoteTool } from "./model-loop-tools.ts";
import { clampToolResultText } from "../tools/model-result.ts";
import { createPolicy, disposeSandboxPolicy, type SandboxPolicy } from "../host/sandbox.ts";
import type { EnvironmentCommandFact, EnvironmentFacts, ProjectEnvironmentFact } from "../host/environment-facts.ts";
import {
  checkCaseFindings,
  LEDGER_CASE_EVENT,
  LEDGER_EVENT,
  ledgerMirrorPath,
  propertyCaseFindings,
  proposalShapeFindings,
  recordLedger,
  revisionCases,
  type LedgerCase,
  type LedgerCaseDrop,
  type LedgerRevision,
  type LedgerScenario,
  type LedgerTodo,
} from "../work/plan-ledger.ts";
import { liveLedger } from "../work/ledger-live.ts";
import { LinkSafetyError } from "../work/link-safe-fs.ts";
import { caseDirPath } from "../work/case-launch.ts";
import { caseSpecDigest } from "../work/case-spec.ts";
import {
  boundDefect,
  fixOrderOpenIdentities,
  MAX_DEFECT_TEXT,
  MAX_DEFECT_TITLE,
  orderQuoteFound,
  orderSpecification,
  verifyOrderDisputedIdentities,
  type CheckIdentity,
} from "../work/verified-work.ts";
import { MAX_ADJUDICATION_TEXT, WORK_DISPUTE_ROW, WORK_RULING_ROW } from "../work/recheck-adjudication.ts";
import { casesToProbe, observeCheckNow, probeLedgerCases } from "../work/ledger-probe.ts";
import { judgedRunOn } from "../work/judged-evidence.ts";
import { workspaceDigest } from "../host/execution-receipt.ts";
import { sessionDigestCache } from "../work/session-base.ts";
import { checkDirFor, checkNeedsScratch, checkScratchNeed, formatCheckResult, normalizeCheckInput, storeCheckContents } from "../work/ledger-check.ts";
import { LEDGER_PLANNER } from "../work/ledger-label.ts";
import {
  formatPropertyResult,
  isPropertyCase,
  livePropertyExecutor,
  normalizePropertyInput,
  PROPERTY_CASES_DEFAULT,
  PROPERTY_CASES_MAX,
  PROPERTY_MAX_COUNTEREXAMPLES_DEFAULT,
  PROPERTY_MAX_COUNTEREXAMPLES_MAX,
  PROPERTY_ROW,
  PROPERTY_SEED_MAX,
  PROPERTY_TIME_BUDGET_DEFAULT_MS,
  PROPERTY_TIME_BUDGET_MAX_MS,
  propertyCallPrefix,
  propertyRowFields,
  propertyVerdict,
  runProperty,
  sessionPropertyStore,
  type PropertyObservation,
} from "../work/ledger-property.ts";
import {
  ensureSessionScratch,
  SCRATCH_LIMITS,
  SCRATCH_WARN_FRACTION,
  ScratchMeter,
  scratchCapFact,
  scratchFraction,
  scratchSizeFact,
  type ScratchLimits,
} from "../work/session-scratch.ts";

/**
 * The `plan` tool (interfaces-v3.md §1): the model's work graph as a ledger.
 * Structural checks only; findings come back as data and record nothing. A
 * clean graph appends one `work/ledger` row — every revision retained, the
 * goal host-owned (the operator order from the log, never a model input).
 * The cases `check` recorded are not the plan's to omit (D52): they stay in
 * the ledger unless the call drops them, by id with a reason (`drop_cases`,
 * recorded on the row), and the structural checks cover them. The latest
 * graph is mirrored to work/ledger.json for the operator's eyes only; the
 * host never reads that file back.
 */

/** Common todo-status vocabulary models are trained on, mapped onto the
 * canonical ledger values. Normalized at the tool boundary; only the
 * canonical value is ever stored in work/ledger. */
const TODO_STATUS_SYNONYMS: Record<string, LedgerTodo["status"]> = {
  pending: "open",
  in_progress: "open",
  todo: "open",
  completed: "done",
  complete: "done",
  cancelled: "dropped",
  canceled: "dropped",
  skipped: "dropped",
};

export const TODO_STATUS_VALUES = "open | done | dropped";

/** Canonicalize one todo's status, or name the values the tool accepts. */
function normalizeTodoStatus(status: unknown): { readonly status?: LedgerTodo["status"]; readonly unknown?: string } {
  if (status === undefined) return {};
  if (typeof status !== "string") return { unknown: String(status) };
  if (status === "open" || status === "done" || status === "dropped") return { status };
  const canonical = TODO_STATUS_SYNONYMS[status];
  return canonical === undefined ? { unknown: status } : { status: canonical };
}

/** Coerce one todo's priority to its canonical number, or drop it. Priority
 * is display bookkeeping, never structural: a numeric string ("2") becomes
 * 2, anything else non-numeric is silently omitted. */
function normalizeTodoPriority(item: LedgerTodo): LedgerTodo {
  const priority = (item as { priority?: unknown }).priority;
  if (priority === undefined || typeof priority === "number") return item;
  if (typeof priority === "string" && priority.trim() !== "" && !Number.isNaN(Number(priority))) {
    return { ...item, priority: Number(priority) };
  }
  const { priority: _drop, ...rest } = item as LedgerTodo & { priority?: unknown };
  return rest as LedgerTodo;
}

/** The plan's `drop_cases` as the ledger records them (D52): `{id, reason}`
 * per entry and nothing else. A missing id or reason becomes an empty string,
 * which recordLedger reports as a finding — data, not a schema wall. */
function normalizeCaseDrops(value: readonly unknown[]): LedgerCaseDrop[] {
  return value.map((item) => {
    const entry = (typeof item === "object" && item !== null ? item : {}) as { id?: unknown; reason?: unknown };
    return { id: typeof entry.id === "string" ? entry.id : "", reason: typeof entry.reason === "string" ? entry.reason : "" };
  });
}

/** Give one todo a title: `title` when present, else its `statement`. A todo
 * with neither is a finding — data the model can act on, not a schema wall. */
function todoTitleFinding(item: LedgerTodo): string | undefined {
  const hasTitle = typeof item.title === "string";
  const hasStatement = typeof item.statement === "string";
  if (hasTitle || hasStatement) return undefined;
  return `todo ${item.id} needs a title (or statement)`;
}

// --- case reproducibility findings (CASE-ERGONOMICS, design A) --------------
//
// The host re-runs every case at the end of the session, in a clean sandbox,
// from the workspace root (a case's `dir` field becomes a leading `cd`).
// Command shapes that pass in the model's live session but cannot reproduce
// there (the D23 taxonomy's group B, plus the B5 working-directory channel)
// are returned as DATA alongside the recorded revision — the plan always
// records; nothing here blocks anything.

/** The right side of a `|` whose exit code replaces the runner's. */
const PIPE_REPORTERS: ReadonlySet<string> = new Set(["tail", "head", "grep", "less", "wc", "awk", "sed", "cut"]);

/** The plan tool's known top-level fields. Anything else in the payload is
 * ignored and reported by name (D24) — never a pre-tool refusal. */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["todos", "scenarios", "cases", "delta", "drop_cases"]);

export type CaseReproducibilityFinding = {
  readonly check: "pipe" | "tmp_path" | "relative_from_subdir" | "dir_prefixed_path" | "runner_script"
    | "bare_interpreter" | "absolute_workspace_path" | "missing_directory";
  readonly node: string;
  readonly fact: string;
};

/** A finding about the plan payload itself rather than one case: D24's
 * ignored unknown top-level keys, reported once with their names only. */
export type PlanPayloadFinding = {
  readonly check: "unknown_field";
  readonly node: "root";
  readonly fact: string;
};

/** True when the command pipes a segment into a reporter (a `|` whose right
 * side starts with one of the reporters). `||` is not a pipe. */
function pipesIntoReporter(command: string): boolean {
  const parts = command.split("|");
  for (let index = 1; index < parts.length; index += 1) {
    const left = parts[index - 1]!.trimEnd();
    const right = parts[index]!.trimStart();
    if (left === "" || right === "") continue;
    const head = right.split(/\s+/)[0] ?? "";
    if (PIPE_REPORTERS.has(head)) return true;
  }
  return false;
}

/** True when the command references a scratch-path prefix the re-run context
 * does not preserve: /tmp, /var/tmp, or $TMPDIR. */
function referencesTmp(command: string): boolean {
  return /\/(?:var\/)?tmp\b/u.test(command) || /\$\{?TMPDIR\}?/u.test(command);
}

/** The command's leading `cd <dir> &&` target, when present. */
function leadingCdTarget(command: string): string | undefined {
  const match = /^\s*cd\s+([^\s&;]+)\s*&&/u.exec(command);
  return match?.[1];
}

/** A relative directory as resolved inside the workspace, or undefined when
 * it is the workspace root or leaves the workspace (the predicate never
 * inspects outside the workspace, so neither does the finding). */
function subdirInsideWorkspace(workspaceRoot: string, dir: string): string | undefined {
  const absolute = resolve(workspaceRoot, dir);
  if (absolute === workspaceRoot || !absolute.startsWith(workspaceRoot + sep)) return undefined;
  return relative(workspaceRoot, absolute);
}

/** True when the path exists on disk as a directory. Called only for paths
 * already proven to stay inside the workspace (subdirInsideWorkspace said
 * so) — the same discipline usesRootRelativePath keeps. */
function isDirectoryOnDisk(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** True when the command, run from the non-root working directory `dir`,
 * uses a workspace-root-relative path: a `.venv/…` or `./…` token (those
 * resolve from the root, not from `dir`), or an argument token naming an
 * existing path under the workspace root but not under `dir`. Detection is
 * conservative: an argument counts only when it contains a `/`, carries no
 * flag/variable/assignment/absolute prefix, and exists on disk. */
function usesRootRelativePath(command: string, workspaceRoot: string, dir: string): boolean {
  const fromDir = resolve(workspaceRoot, dir);
  for (const token of command.split(/\s+/)) {
    if (token.startsWith(".venv/") || token.startsWith("./")) return true;
    if (!token.includes("/") || token.startsWith("-") || token.startsWith("$") || token.startsWith("/")
      || token.startsWith("~") || token.includes("=")) {
      continue;
    }
    // Only after a candidate is proven to stay inside the workspace is the
    // filesystem consulted for it.
    const candidate = resolve(workspaceRoot, token);
    if (candidate === workspaceRoot || !candidate.startsWith(workspaceRoot + sep)) continue;
    if (!candidate.startsWith(fromDir + sep) && existsSync(candidate)) return true;
  }
  return false;
}

/** One case's effective working directory, relative to the workspace root:
 * the command's leading `cd <dir> &&` target when present (the conclusion
 * launches `cd <case dir> && <command>`, so a leading cd lands one level
 * deeper than the case's dir), otherwise the case's `dir` field. The `dir`
 * field is resolved the way the launch enters it (case-launch.ts: path data,
 * a leading home anchor under the home). Undefined when that directory is the
 * workspace root or outside it (then nothing root-relative can misresolve). */
function effectiveSubdir(command: string, dir: string | undefined, workspaceRoot: string): string | undefined {
  const base = dir === undefined || dir === "" ? workspaceRoot : caseDirPath(dir, workspaceRoot);
  if (base === undefined) return undefined;
  const cdTarget = leadingCdTarget(command);
  if (cdTarget !== undefined) {
    const composed = !cdTarget.startsWith("/") && !cdTarget.startsWith("~") ? resolve(base, cdTarget) : cdTarget;
    return subdirInsideWorkspace(workspaceRoot, composed);
  }
  return subdirInsideWorkspace(workspaceRoot, base);
}

/** The first path-like token of the command that already starts with the
 * case's effective working directory — the mirror image of the
 * root-relative predicate above: a path that assumes the workspace root
 * while the re-run works from inside that directory. The match is on a
 * whole path segment (the directory itself, or directory + "/"), so a
 * sibling sharing the first segment stays clean; an option's value is a
 * path too, so the compare uses what follows an "=". */
function dirPrefixedPathToken(command: string, subdir: string): string | undefined {
  const base = posix.normalize(subdir);
  for (const token of command.split(/\s+/)) {
    if (!token.includes("/")) continue;
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    const path = posix.normalize(value.replace(/^\.\//u, ""));
    if (path === base || path.startsWith(base + "/")) return path;
  }
  return undefined;
}

/** True when the command invokes bare pytest/unittest against a test path. */
function invokesBarePytest(command: string): boolean {
  const words = command.split(/\s+/);
  const bare = words.some((word) => word === "pytest" || word === "py.test")
    || words.some((word, index) => word === "-m" && (words[index + 1] === "pytest" || words[index + 1] === "unittest"));
  if (!bare) return false;
  return /\btests?\//u.test(command) || /\s\S+\.py\b/u.test(command);
}

// --- the two CASE-PORTABILITY predicates (D28 + D29, design A) ---------------
//
// Both read the recorded facts and the workspace root, never a repository,
// task, or path NAME: the bare-interpreter check derives everything from the
// recorded host/environment row, the absolute-path check from the workspace
// root itself.

/** Interpreter words whose bare form depends on an activated environment: a
 * shell that never sourced one resolves them on PATH alone. */
const BARE_INTERPRETER_WORDS: ReadonlySet<string> = new Set([
  "python", "python3", "pip", "pip3", "pytest", "py.test",
]);

/** The shell connectors after which the next word is a command again. */
const COMMAND_CONNECTORS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "&"]);

/** The words of the command, whitespace-split with surrounding quotes
 * stripped — the same conservative shape the other predicates use. */
function shellWords(command: string): string[] {
  return command.split(/\s+/).map((word) => word.replace(/^['"]/, "").replace(/['"]$/, ""));
}

/** The first bare interpreter word of the command: a word equal to one of the
 * known names (no "/" in it by construction) in command position — the
 * command's first word, or the word right after a shell connector. A word in
 * argument position (`.venv/bin/python -m pytest …`) invokes nothing. */
function bareInterpreterWord(command: string): string | undefined {
  const words = shellWords(command);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!BARE_INTERPRETER_WORDS.has(word)) continue;
    if (index === 0 || COMMAND_CONNECTORS.has(words[index - 1]!)) return word;
  }
  return undefined;
}

/** True when the command activates the environment's bin: a `source
 * <bin>/activate`, `. <bin>/activate`, or bare `<bin>/activate` token — every
 * shape leaves the recorded workspace-relative bin path + "/activate" as a
 * word of its own (any deeper path shape included). */
function activatesEnvironment(command: string, bin: string): boolean {
  const suffix = `${bin}/activate`;
  return shellWords(command).some((word) => word === suffix || word.endsWith(`/${suffix}`));
}

/** The root spellings that name the workspace absolutely: the root itself,
 * plus its "~"-abbreviation when the root lies under HOME. */
function absoluteRootForms(workspaceRoot: string): string[] {
  const forms = [workspaceRoot];
  const home = process.env.HOME;
  if (home !== undefined && workspaceRoot.startsWith(home + sep)) {
    forms.push(`~${workspaceRoot.slice(home.length)}`);
  }
  return forms;
}

/** The first token of the command — or, when no token offends, the case's
 * dir — that names the workspace by an absolute root spelling: the root
 * itself (end of token) or anything under it (root + "/"). A token sharing
 * only the root's byte prefix ("-other/…") stays clean. */
function absoluteWorkspaceToken(command: string, dir: string | undefined, workspaceRoot: string): string | undefined {
  const forms = absoluteRootForms(workspaceRoot);
  const namesRoot = (value: string): boolean =>
    forms.some((root) => value === root || value.startsWith(root + "/"));
  for (const token of shellWords(command)) {
    if (namesRoot(token)) return token;
  }
  if (dir !== undefined) {
    const stripped = dir.replace(/^['"]/, "").replace(/['"]$/, "");
    if (namesRoot(stripped)) return stripped;
  }
  return undefined;
}

/** The reproducibility findings of one recorded graph's cases. The recorded
 * bytes are untouched — the findings ride along in the tool result. The
 * workspace root is consulted only for the working-directory predicate, and
 * only for paths proven to stay inside it. The environment facts (recorded
 * host/environment row) carry the project environments and resolved command
 * paths the bare-interpreter check names; both optional so pre-existing call
 * sites keep compiling and see no findings. */
export function caseReproducibilityFindings(
  cases: readonly LedgerCase[],
  testRunners: readonly string[],
  workspaceRoot: string,
  projectEnvironments: readonly ProjectEnvironmentFact[] = [],
  commands: readonly EnvironmentCommandFact[] = [],
): CaseReproducibilityFinding[] {
  const findings: CaseReproducibilityFinding[] = [];
  for (const item of cases) {
    const command = typeof item.command === "string" ? item.command : "";
    if (command === "") continue;
    if (pipesIntoReporter(command)) {
      findings.push({
        check: "pipe",
        node: item.id,
        fact: "the exit code will be the pipe's, so the runner's result cannot be verified; record the runner without the pipe (output is clamped anyway)",
      });
    }
    if (referencesTmp(command)) {
      findings.push({
        check: "tmp_path",
        node: item.id,
        fact: "/tmp is not preserved when cases are re-run; keep the test under the workspace",
      });
    }
    const subdir = effectiveSubdir(command, item.dir, workspaceRoot);
    // D30: the working directory itself. Once subdirInsideWorkspace has
    // proven the path stays inside the workspace, the disk may be consulted;
    // a directory that does not exist fails the re-run's own leading cd, and
    // then no root-relative shape matters — the missing directory is the
    // fact, so the two working-directory findings below stay silent.
    const directoryMissing = subdir !== undefined && !isDirectoryOnDisk(resolve(workspaceRoot, subdir));
    if (directoryMissing) {
      findings.push({
        check: "missing_directory",
        node: item.id,
        fact: `the case's working directory "${subdir}" does not exist in the workspace; the host runs the command from it and it will fail before the command starts`,
      });
    }
    if (subdir !== undefined && !directoryMissing && usesRootRelativePath(command, workspaceRoot, subdir)) {
      findings.push({
        check: "relative_from_subdir",
        node: item.id,
        fact: `the case runs from "${subdir}" (its dir, or a leading cd): workspace-root-relative paths (.venv/…, ./…, and arguments like bin/test or tests/…) will not resolve from it; use paths relative to ${subdir}, absolute paths, or drop the dir`,
      });
    }
    if (subdir !== undefined && !directoryMissing) {
      const prefixed = dirPrefixedPathToken(command, subdir);
      if (prefixed !== undefined) {
        const withoutPrefix = prefixed === subdir ? "." : prefixed.slice(subdir.length + 1);
        findings.push({
          check: "dir_prefixed_path",
          node: item.id,
          fact: `the case runs inside "${subdir}": the path "${prefixed}" already starts with it and will resolve to "${subdir}/${prefixed}"; use "${withoutPrefix}" or drop the dir`,
        });
      }
    }
    if (testRunners.length > 0 && invokesBarePytest(command)) {
      findings.push({
        check: "runner_script",
        node: item.id,
        fact: `this repository carries ${testRunners.join(", ")}; pytest may not be its test runner`,
      });
    }
    // D28: the host re-runs the case in a shell that never sourced the
    // environment, so a bare interpreter word resolves on PATH — the recorded
    // environment stays a fact of the session, not of the re-run.
    const offPathEnvironment = projectEnvironments
      .find((environment) => environment.on_path === false && !activatesEnvironment(command, environment.bin));
    if (offPathEnvironment !== undefined) {
      const word = bareInterpreterWord(command);
      if (word !== undefined) {
        const recordedPath = commands.find((entry) => entry.name === word)?.path;
        findings.push({
          check: "bare_interpreter",
          node: item.id,
          fact: `the host re-runs the case without an activated shell: "${word}" resolves to ${recordedPath ?? "nothing on PATH"} there, not to ${offPathEnvironment.bin}/${word}; use ${offPathEnvironment.bin}/${word} (relative to the case's dir) or activate inside the command`,
        });
      }
    }
    // D29: the base pass re-runs cases from a copy of the workspace, where
    // the live absolute root does not exist — the same spelling that made the
    // model's own session work.
    const absoluteToken = absoluteWorkspaceToken(command, item.dir, workspaceRoot);
    if (absoluteToken !== undefined) {
      findings.push({
        check: "absolute_workspace_path",
        node: item.id,
        fact: `the case names the workspace by its absolute path "${absoluteToken}": the host re-runs cases from a copy of the workspace, where that path does not exist; use a path relative to the workspace root (the case runs there, or in its dir)`,
      });
    }
  }
  return findings;
}

/** The facts of the latest recorded host/environment row, when one exists.
 * Every recorded-facts reader below goes through here so they all see the
 * same row — read from the log's running projection, which extends by the
 * rows appended since the last call instead of scanning the log (D48b). */
function recordedEnvironmentFacts(log: EventLog): EnvironmentFacts | undefined {
  return liveLedger(log).environmentFacts();
}

/** The repository test-runner names the recorded host/environment facts
 * carry, when a row exists. Detection reads the recorded facts, never the
 * repository name. */
function recordedTestRunners(log: EventLog): readonly string[] {
  return recordedEnvironmentFacts(log)?.test_runners ?? [];
}

/** The project environments the recorded facts carry (D28): an environment
 * whose bin is not on the sandbox PATH is what makes a bare interpreter word
 * unresolvable in the host's re-run. */
function recordedProjectEnvironments(log: EventLog): readonly ProjectEnvironmentFact[] {
  return recordedEnvironmentFacts(log)?.project_environments ?? [];
}

/** The resolved command paths of the same row: where a bare word actually
 * resolves in the re-run, as the host recorded it. */
function recordedCommands(log: EventLog): readonly EnvironmentCommandFact[] {
  return recordedEnvironmentFacts(log)?.commands ?? [];
}

/** Operator convenience only; the host never reads this back. It lives in
 * the session directory, never in the developer's repository. */
function writeLedgerMirror(log: EventLog, result: { graph: unknown; digest: string; revision: number; parent_digest: string | null }): void {
  try {
    const mirror = ledgerMirrorPath(log.path);
    mkdirSync(dirname(mirror), { recursive: true });
    writeFileSync(mirror, `${JSON.stringify({ graph: result.graph, digest: result.digest, revision: result.revision, parent_digest: result.parent_digest }, null, 2)}\n`);
  } catch {
    // The mirror is cosmetic; a failed write must never fail the record.
  }
}

const parameters = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Todo id, unique across the graph." },
          title: { type: "string", description: "What this todo is. Optional when a statement is present: the statement becomes the title." },
          class: { type: "string", description: "The subsystem this todo works on." },
          priority: { description: "Display bookkeeping only. A number is preferred; a numeric string is coerced, anything else is ignored." },
          blocked_by: { type: "array", items: { type: "string" }, description: "Todo ids that must finish first." },
          statement: { type: "string", description: "The one piece of the goal this todo delivers. Used as the title when no title is given." },
          judgment: { type: "string", description: "Short display clause naming the acceptance signal." },
          plan: { type: "string", description: "Short display clause naming the approach." },
          status: { type: "string", description: "Your own bookkeeping: open, done, or dropped (dropped requires a reason). Common synonyms are accepted and normalized: pending/in_progress/todo → open, completed/complete → done, cancelled/canceled/skipped → dropped." },
          reason: { type: "string", description: "Why this todo was dropped." },
        },
        required: ["id"],
      },
    },
    scenarios: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          todo: { type: "string", description: "Todo id this scenario belongs to; must resolve to a todo." },
          given: { type: "string" },
          when: { type: "string" },
          then: { type: "string" },
        },
        required: ["id"],
      },
    },
    cases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          scenario: { type: "string", description: "Scenario id this case proves." },
          layer: { type: "string", enum: ["unit", "contract", "replay"] },
          command: { type: "string", description: "One command that actually runs and shows the work is done." },
          red_means: { type: "string", description: "Why the command fails before the work." },
          green_means: { type: "string", description: "What the command passing means." },
          guard: { type: "boolean", description: "A standing invariant this case protects; expected to pass from the start." },
          dir: { type: "string", description: "Working directory for this case's command." },
          timeout_ms: { type: "number", description: "Absolute backstop for this case's run." },
        },
        required: ["id"],
      },
    },
    delta: { type: "boolean", description: "Merge this graph into the latest recorded one by id instead of replacing it (default false)." },
    drop_cases: {
      type: "array",
      description: "Recorded cases to remove from the ledger, each by id with the reason it no longer applies. A case recorded with check leaves the ledger only this way.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id of a recorded case." },
          reason: { type: "string", description: "Why this case is dropped (required)." },
        },
        required: ["id"],
      },
    },
  },
  required: ["todos"],
  // Unknown top-level keys are deliberately tolerated (D24): they are
  // ignored and reported as one unknown_field finding, never a pre-tool
  // refusal. Every known field's type above is unchanged.
} as const;

/** The `plan` tool, bound to a log and workspace. Driver-independent: tests
 * instantiate it directly with an EventLog, the plugin wraps it in the
 * contribution registry. */
export function createPlanTool(input: { log: EventLog; workspaceRoot: string }): AgentTool {
  const { log, workspaceRoot } = input;
  return {
    name: "plan",
    label: "plan",
    description:
      "Record your work graph (todos, optional scenarios and cases). Checks are structural only and returned as data; a clean graph is recorded as a new ledger revision with its open todos. Use delta:true to update the recorded graph by id. Checks recorded with the check tool stay in the ledger across plan calls unless you drop them in drop_cases with a reason. Cases are re-run by the host at the end of the session in a clean sandbox from the workspace root; /tmp is not preserved; a piped runner's exit code is the pipe's. Each new or changed case — and each case no host run has observed on the current tree yet — is run once when recorded, in a copy of the current tree with a fresh cache, exactly as the host will run it at the end; the result comes back with the findings, and a green run there is the judged green receipt the continuation line counts (a green bash call never is). A session that finishes is labeled accepted when at least one recorded non-guard case fails on the base tree and passes on the final tree, and done_unverified otherwise; a session that does not finish is labeled incomplete. A case that also passes on the base tree is recorded as green_at_base and counts as a guard, not as evidence of the change. A case or guard whose target test file the session itself modified (beyond adding tests) is reported as tampered and does not count.",
    parameters: parameters as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const proposal = params as {
        todos?: LedgerTodo[];
        scenarios?: LedgerScenario[];
        cases?: LedgerCase[];
        delta?: boolean;
        drop_cases?: unknown;
      };
      // Unknown top-level keys are ignored, not refused (D24): one finding
      // lists their names — never their values — and the plan records anyway.
      const unknownKeys = Object.keys(params as Record<string, unknown>).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key));
      const unknownFieldFinding: PlanPayloadFinding[] = unknownKeys.length > 0
        ? [{ check: "unknown_field", node: "root", fact: `unknown top-level fields ignored (names only): ${unknownKeys.join(", ")}` }]
        : [];
      // Normalize what models naturally send at the boundary — status
      // vocabulary, a title living in `statement`, a string priority — so
      // only canonical values reach work/ledger and every recoverable shape
      // is data, never a schema wall.
      const todos: LedgerTodo[] = [];
      const boundaryFindings: { check: string; node: string; fact: string }[] = [];
      // D58c V5': the shape every later reader relies on — lists where lists
      // go, each todo, scenario and case an object with a text id, a case's
      // dir, timeout and guard of their types — before anything reads it.
      const shape = proposalShapeFindings(params as Record<string, unknown>);
      if (shape.length > 0) {
        return {
          content: [{ type: "text" as const, text: clampToolResultText(JSON.stringify({ status: "findings", findings: [...shape, ...unknownFieldFinding] })) }],
          details: { error: false },
        };
      }
      for (const item of proposal.todos ?? []) {
        const normalized = normalizeTodoStatus((item as { status?: unknown }).status);
        if (normalized.unknown !== undefined) {
          boundaryFindings.push({
            check: "status",
            node: typeof item?.id === "string" ? item.id : "?",
            fact: `unknown status "${normalized.unknown}"; accepted values: ${TODO_STATUS_VALUES} (common synonyms pending/in_progress/todo, completed/complete, cancelled/canceled/skipped are normalized)`,
          });
          continue;
        }
        const titleFact = todoTitleFinding(item);
        if (titleFact !== undefined) {
          boundaryFindings.push({ check: "title", node: typeof item?.id === "string" ? item.id : "?", fact: titleFact });
          continue;
        }
        let canonical: LedgerTodo = normalizeTodoPriority(item);
        if (normalized.status !== undefined) canonical = { ...canonical, status: normalized.status };
        if (typeof canonical.title !== "string" && typeof canonical.statement === "string") {
          canonical = { ...canonical, title: canonical.statement };
        }
        todos.push(canonical);
      }
      // D52: the explicit drops, `{id, reason}` each; their reasons and ids
      // are judged with the graph (recordLedger).
      if (proposal.drop_cases !== undefined && !Array.isArray(proposal.drop_cases)) {
        boundaryFindings.push({ check: "drop_cases", node: "root", fact: "drop_cases must be a list of {id, reason}" });
      }
      const drops = Array.isArray(proposal.drop_cases) ? normalizeCaseDrops(proposal.drop_cases) : [];
      // D58b V5, D58c V5': only the tool that validates a case kind may
      // create it. A `property` case is declared (and changed) only by
      // `property`, which validates its principle and its bounds, and a
      // `check` case only by `check`, which validates its stdin, fixtures and
      // expectations and their bounds: a plan case that carries a `property`
      // field or any of `stdin`, `files`, `expect` — whatever its value — is
      // refused, and nothing is recorded (recordLedger's own findings, whose
      // callers other than those tools never record one). A check or property
      // case the ledger holds stays across plan calls without being declared
      // again.
      const proposedCases = Array.isArray(proposal.cases) ? proposal.cases : [];
      boundaryFindings.push(...propertyCaseFindings(proposedCases), ...checkCaseFindings(proposedCases));
      if (boundaryFindings.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: clampToolResultText(JSON.stringify({ status: "findings", findings: [...boundaryFindings, ...unknownFieldFinding] })),
          }],
          details: { error: false },
        };
      }
      // The revision this call is measured against: read before the append,
      // so the probe below can tell a new or changed case from one the host
      // has already observed. Read from the log's running projection (D48b).
      const ledger = liveLedger(log);
      const previous = ledger.revision();
      const result = recordLedger({
        // The goal never comes from the model: the order is read from the
        // log the way the drive-side authority path reads it.
        proposal: {
          todos, scenarios: proposal.scenarios, cases: proposal.cases, delta: proposal.delta,
          ...(drops.length > 0 ? { drop_cases: drops } : {}),
        },
        order: ledger.orderStatement() ?? "",
        latest: previous,
        // D52: the cases `check` recorded stay unless this call drops them.
        checks: ledger.fold.checkCases(),
      });
      if (result.status === "findings") {
        // Findings record nothing; nothing else is affected.
        return {
          content: [{
            type: "text" as const,
            text: clampToolResultText(JSON.stringify({ status: "findings", findings: [...result.findings, ...unknownFieldFinding] })),
          }],
          details: { error: false },
        };
      }
      log.append({
        kind: "observe",
        name: LEDGER_EVENT,
        payload: {
          graph: result.graph, digest: result.digest, revision: result.revision, parent_digest: result.parent_digest,
          ...(result.drop_cases !== undefined ? { drop_cases: result.drop_cases } : {}),
        },
      });
      // Reproducibility findings ride along with the recorded revision: the
      // graph is already recorded; these are data the model can act on.
      const reproFindings = caseReproducibilityFindings(
        result.graph.cases,
        recordedTestRunners(log),
        workspaceRoot,
        recordedProjectEnvironments(log),
        recordedCommands(log),
      );
      // The mirror shows the graph the revision projects: the recorded graph
      // with the check cases it keeps (D52).
      writeLedgerMirror(log, liveLedger(log).revision() ?? result);
      // CASE-PARITY-B: the revision is recorded; now the host OBSERVES each
      // new or changed non-guard case once, in a copy of the current tree,
      // exactly as it will run it at the end. Data beside the findings —
      // nothing here gates, and the probe never touches the live workspace.
      // V7 (D57i): a case no judged run has observed on the current tree is
      // probed again, so a change the session made can earn a judged green.
      let current: string | undefined;
      try {
        current = workspaceDigest(workspaceRoot, sessionDigestCache(log, workspaceRoot));
      } catch {
        current = undefined;
      }
      const probed = probeLedgerCases({
        log,
        workspaceRoot,
        cases: casesToProbe(result.graph, previous?.graph, (item) =>
          current !== undefined && typeof item.command === "string" && !judgedRunOn(log.events, item.command, current)),
        revision: result.revision,
      });
      const findings = [...unknownFieldFinding, ...reproFindings, ...probed.findings];
      return {
        content: [{
          type: "text" as const,
          text: clampToolResultText(JSON.stringify({
            status: "recorded",
            digest: result.digest,
            revision: result.revision,
            open_todos: result.open_todos,
            ...(probed.probes.length > 0 ? { probes: probed.probes } : {}),
            ...(findings.length > 0 ? { findings } : {}),
          })),
        }],
        details: { error: false },
      };
    },
  };
}

/** The `check` tool's one-paragraph description (D48, T2). */
export const CHECK_TOOL_DESCRIPTION =
  "Confirm one behaviour with a runnable, recorded check: a command, optionally with stdin, fixture files (written to a scratch directory outside the workspace, given to the command as DOKKABI_CHECK_DIR) and expectations on its exit code, stdout, stderr and the files it should produce. Use it instead of bash whenever you run something to see whether it behaves as the order says. The check is recorded as a ledger case (reusing an id updates that case) and run at once in the workspace, where bash runs; the result says, per expectation, what was expected and what was observed. The host runs the same case again at the end on the final tree and on the base tree, judged by the same expectations, and it counts for the session's label like any case. It stays in the ledger across later plan calls until a plan drops it by id in drop_cases with a reason.";

const checkParameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "Case id. Reusing an id updates that case." },
    command: { type: "string", description: "The command to run, from the workspace root (or dir)." },
    dir: { type: "string", description: "Workspace-relative directory to run the command from." },
    stdin: { type: "string", description: "Text given to the command on stdin." },
    files: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Fixture files, relative path → text, written under DOKKABI_CHECK_DIR (outside the workspace) before the command runs.",
    },
    expect: {
      type: "object",
      description: "What the run should show. Without it, exit 0 is expected.",
      properties: {
        exit: { type: "integer", description: "Expected exit code (default 0)." },
        stdout: {
          type: "object",
          properties: {
            equals: { type: "string", description: "The whole stdout (trailing newlines ignored)." },
            contains: { type: "array", items: { type: "string" }, description: "Substrings stdout must contain." },
            matches: { type: "string", description: "A regular expression stdout must match (multiline), evaluated in bounded linear time: no backreferences or lookaround." },
          },
        },
        stderr: {
          type: "object",
          properties: { contains: { type: "array", items: { type: "string" }, description: "Substrings stderr must contain." } },
        },
        files: {
          type: "object",
          description: "Files the command should produce, workspace-relative path → { equals | contains }.",
          additionalProperties: {
            type: "object",
            properties: {
              equals: { type: "string" },
              contains: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    guard: { type: "boolean", description: "A standing invariant expected to pass from the start." },
    todo: { type: "string", description: "The recorded todo this check belongs to." },
    scenario: { type: "string", description: "The recorded scenario this check proves." },
    timeout_ms: { type: "number", description: "Absolute backstop for this check's run." },
  },
  required: ["id", "command"],
} as const;

/**
 * The ledger's `check` (D48, design memo §99 tool 1): one runnable check,
 * recorded and observed in one call. The call IS the observation (T1): the
 * case the model declares is appended as a new revision — a
 * `work/ledger_case` row carrying that one case (D48b), which the projection
 * folds onto the latest graph exactly as the delta merge did; a whole-graph
 * `work/ledger` row naming the case in `check_case` only where there is no
 * revision to extend or the order changed. Either way the ledger keeps the
 * case across later `plan` revisions until one drops it with a reason (D52)
 * — its large fixture texts kept in the session's scratch store by
 * digest, and then run once in the live workspace, where the session's bash
 * runs, and judged by the shared check evaluator (work/ledger-check.ts), which
 * every later observation of the case uses too. One `ledger/check` row records
 * what that run saw. Nothing gates: malformed input returns findings and
 * records nothing; a failing check is data returned to the model.
 *
 * T7 (D48b): the call's cost does not grow with the session. It appends one
 * case, reads the ledger, the order and the environment facts from the log's
 * running projection (work/ledger-live.ts), and writes into the session's
 * scratch only within its cap (work/session-scratch.ts): a call whose
 * fixtures, stdin and captures would pass it is refused with a finding and
 * records nothing, and above 80% of it the result says how full it is.
 */
const CHECK_TOOL_DISPOSERS = new WeakMap<AgentTool, () => void>();

/** Release the live policy a `check` tool sealed (D48); idempotent. */
export function disposeCheckTool(tool: AgentTool): void {
  CHECK_TOOL_DISPOSERS.get(tool)?.();
}

export function createCheckTool(input: {
  log: EventLog;
  workspaceRoot: string;
  /** The scratch cap (default SCRATCH_LIMITS); tests give a smaller one. */
  scratchLimits?: ScratchLimits;
}): AgentTool {
  const { log, workspaceRoot } = input;
  const scratchLimits = input.scratchLimits ?? SCRATCH_LIMITS;
  // One meter per scratch directory the session has (it never changes in a
  // session; a different one starts a new meter).
  let meter: ScratchMeter | undefined;
  const meterFor = (scratch: string): ScratchMeter => {
    if (meter === undefined || meter.dir !== scratch) meter = new ScratchMeter(scratch, scratchLimits);
    return meter;
  };
  // The live policy (D48): the one the session's own bash gets — workspace-
  // write (or the envfix wave's mode) on the live workspace with the
  // session's scratch bound — sealed once, at the first call, and reused.
  let live: { policy: SandboxPolicy; scratch: string | undefined } | undefined;
  const livePolicy = (scratch: string | undefined): SandboxPolicy => {
    if (live !== undefined && live.scratch === scratch) return live.policy;
    if (live !== undefined) disposeSandboxPolicy(live.policy);
    const policy = createPolicy({
      mode: process.env.DOKKABI_SANDBOX_MODE === "envfix" ? "envfix" : "workspace-write",
      workspaceRoot,
      log,
      ...(scratch !== undefined ? { scratchRoot: scratch } : {}),
    });
    live = { policy, scratch };
    return policy;
  };
  const findingsText = (findings: readonly { check: string; node?: string; fact: string }[]) => ({
    content: [{ type: "text" as const, text: clampToolResultText(JSON.stringify({ status: "findings", findings })) }],
    details: { error: false },
  });
  const tool: AgentTool = {
    name: "check",
    label: "check",
    description: CHECK_TOOL_DESCRIPTION,
    parameters: checkParameters as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const normalized = normalizeCheckInput((params ?? {}) as Record<string, unknown>);
      if (!normalized.ok) return findingsText(normalized.findings);
      const { item, contents } = normalized;
      // The session's scratch directory, made now if boot did not: fixtures,
      // stdin and captures live there, never in the workspace.
      const scratch = ensureSessionScratch({ logPath: log.path, workspaceRoot, readOnly: log.isReadOnly });
      if (scratch === undefined && checkNeedsScratch(item)) {
        return findingsText([{ check: "scratch", node: item.id, fact: "this session has no scratch directory outside the workspace, so fixtures, stdin and output expectations cannot be kept; use a command and an exit code only" }]);
      }
      // The scratch cap (D48b), before anything is written: what this call
      // writes there — new store texts, the case's fixture directory, one
      // observation's stdin and captures — must fit, or the call is refused
      // and records nothing.
      const scratchMeter = scratch === undefined ? undefined : meterFor(scratch);
      if (scratch !== undefined && scratchMeter !== undefined) {
        const need = checkScratchNeed(scratch, item, contents);
        const admitted = scratchMeter.admit(need.total);
        if (!admitted.ok) {
          return findingsText([{ check: "scratch_cap", node: item.id, fact: scratchCapFact(admitted.usage, need.total, scratchLimits) }]);
        }
        scratchMeter.wrote(need.persistent);
      }
      if (scratch !== undefined && contents.size > 0) {
        try {
          storeCheckContents(scratch, contents);
        } catch (error) {
          return findingsText([{ check: "scratch", node: item.id, fact: `the fixture texts could not be kept in the scratch directory: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` }]);
        }
      }
      // The revision: one case row on the latest graph, from the log's
      // running projection; a whole graph only where the D48 build's delta
      // merge had nothing to extend or a new order to take (D48b).
      const ledger = liveLedger(log);
      const order = ledger.orderStatement() ?? "";
      const decision = ledger.fold.recordCase(item, order);
      if (decision.status === "findings") return findingsText(decision.findings);
      let revision: number;
      let recorded: LedgerCase = item;
      if (decision.status === "graph") {
        const result = recordLedger({
          proposal: { todos: [], cases: [item], delta: decision.latest !== undefined },
          order,
          latest: decision.latest,
          // D58c V5': the one caller that records a check case — validated
          // above (normalizeCheckInput).
          validatedCases: true,
        });
        if (result.status === "findings") return findingsText(result.findings);
        log.append({
          kind: "observe",
          name: LEDGER_EVENT,
          // `check_case` (D52): the case this call declared, which the
          // ledger keeps across later plan revisions like a case row's.
          payload: { graph: result.graph, digest: result.digest, revision: result.revision, parent_digest: result.parent_digest, check_case: item.id },
        });
        writeLedgerMirror(log, result);
        revision = result.revision;
        recorded = result.graph.cases.find((entry) => entry.id === item.id) ?? item;
      } else {
        log.append({ kind: "observe", name: LEDGER_CASE_EVENT, payload: { ...decision.row } });
        const latest: LedgerRevision | undefined = liveLedger(log).revision();
        if (latest !== undefined) writeLedgerMirror(log, latest);
        revision = decision.row.revision;
      }
      const reproFindings = caseReproducibilityFindings(
        [recorded],
        recordedTestRunners(log),
        workspaceRoot,
        recordedProjectEnvironments(log),
        recordedCommands(log),
      );
      let observed: ReturnType<typeof observeCheckNow>;
      try {
        observed = observeCheckNow({ log, workspaceRoot, policy: livePolicy(scratch), item: recorded, revision });
      } catch (error) {
        // A policy that cannot be sealed: the case is recorded, the run is
        // unknown — never a verdict.
        observed = { status: "not_runnable", duration_ms: 0, output_head: "", translated_paths: 0,
          reason: `the check could not be run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
      }
      // Above 80% of the cap the result says how full the scratch is: the
      // model's own writes there are its own, and this is how it learns of
      // them before a check is refused.
      const usage = scratchMeter?.current();
      const scratchNotes = usage !== undefined && scratchFraction(usage, scratchLimits) >= SCRATCH_WARN_FRACTION
        ? [{ check: "scratch_size", fact: scratchSizeFact(usage, scratchLimits) }]
        : [];
      return {
        content: [{
          type: "text" as const,
          text: clampToolResultText(formatCheckResult({
            id: item.id,
            revision,
            status: observed.status,
            ...(observed.exit_code !== undefined ? { exitCode: observed.exit_code } : {}),
            durationMs: observed.duration_ms,
            ...(observed.evaluation !== undefined ? { evaluation: observed.evaluation } : {}),
            ...(observed.reason !== undefined ? { reason: observed.reason } : {}),
            outputHead: observed.output_head,
            findings: [...reproFindings, ...scratchNotes],
          })),
        }],
        details: { error: false },
      };
    },
  };
  CHECK_TOOL_DISPOSERS.set(tool, () => {
    if (live !== undefined) disposeSandboxPolicy(live.policy);
    live = undefined;
  });
  return tool;
}

/** The `property` tool's one-paragraph description (D58, T2). */
export const PROPERTY_TOOL_DESCRIPTION =
  "State an invariant — a rule that must hold for every input, not one example — and test it over many generated inputs in one recorded call. Give the principle in words and a command that runs ONE case: it generates its input from the seed in DOKKABI_PROPERTY_SEED (DOKKABI_PROPERTY_CASE is the case's index), writes that input into DOKKABI_PROPERTY_DIR (a directory made empty for each case, outside the workspace), and asserts the invariant: exit 0 holds, any other exit status or a crash violates it. The input must be a function of the seed alone (never the time, $RANDOM, the environment or the tree): a recorded counterexample is replayed with DOKKABI_PROPERTY_DIR already holding its recorded input and DOKKABI_PROPERTY_REPLAY=1 — regenerate the same bytes or leave them, and write outputs elsewhere or under new names; a replay that changed a recorded file counts as not re-run (the property is not judged), never as held. The generator is your own code in any language; pass it in files (written under DOKKABI_CHECK_DIR, as for check, and rewritten from what you passed before every case). Each case may write the workspace, its DOKKABI_PROPERTY_DIR and its temporary directory; the rest of the session's scratch is read-only to it, so no case reads what an earlier case left there. The property is recorded as a ledger case (reusing an id updates it) and run at once in the workspace, where bash runs: counterexamples it recorded before first (one that holds when re-run is not replayed again), then `cases` cases drawn from `seed` (the same seed runs the same cases), until the time budget (the cases' own run time) runs out or `max_counterexamples` cases violate it. It holds only when every recorded counterexample was re-run and held and every planned case ran; a run the budget cut short is not judged. The result says whether it holds and, for each counterexample, its seed, a one-line reproduction, where its input is and the end of its output. Use it instead of bash or check whenever the order implies a rule over many inputs (round trips, orderings, escaping, idempotence, any-input rules). The host runs it again at the end on the final tree and on the base tree — recorded counterexamples first, then a fresh sample — and it counts for the session's label like any case. It stays in the ledger across later plan calls until a plan drops it by id in drop_cases with a reason.";

const propertyParameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "Case id. Reusing an id updates that case." },
    principle: { type: "string", description: "The invariant in words: what must hold for every input (required)." },
    command: { type: "string", description: "Runs ONE case from the workspace root (or dir): generate the input from DOKKABI_PROPERTY_SEED alone into DOKKABI_PROPERTY_DIR (on a replay, DOKKABI_PROPERTY_REPLAY=1, it already holds the recorded input: regenerate the same bytes or leave them), check the invariant, exit 0 when it holds." },
    files: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Fixture files, relative path → text (the generator, data), written under DOKKABI_CHECK_DIR (outside the workspace) before the cases run.",
    },
    dir: { type: "string", description: "Workspace-relative directory to run the command from." },
    cases: { type: "integer", description: `How many generated cases to run (default ${PROPERTY_CASES_DEFAULT}, at most ${PROPERTY_CASES_MAX}).` },
    seed: { type: "integer", description: `The seed the cases are drawn from, 0 to ${PROPERTY_SEED_MAX} (default: derived from the id, so a run is reproducible).` },
    time_budget_ms: { type: "integer", description: `The time the cases may take together (default ${PROPERTY_TIME_BUDGET_DEFAULT_MS}, at most ${PROPERTY_TIME_BUDGET_MAX_MS}).` },
    max_counterexamples: { type: "integer", description: `Stop after this many violating cases (default ${PROPERTY_MAX_COUNTEREXAMPLES_DEFAULT}, at most ${PROPERTY_MAX_COUNTEREXAMPLES_MAX}).` },
  },
  required: ["id", "principle", "command"],
} as const;

const PROPERTY_TOOL_DISPOSERS = new WeakMap<AgentTool, () => void>();

/** Release the live policy a `property` tool sealed (D58); idempotent. */
export function disposePropertyTool(tool: AgentTool): void {
  PROPERTY_TOOL_DISPOSERS.get(tool)?.();
}

/**
 * The ledger's `property` (D58, design memo §112): an invariant over
 * generated inputs, declared and run in one call. The call IS the
 * observation (T1): the case the model declares — the principle, the
 * command that runs one case, its fixtures (content-addressed, as a check's)
 * and its bounds — is appended as a new revision exactly as `check` appends
 * one (one `work/ledger_case` row, O(1) bytes per call), kept across later
 * `plan` revisions until one drops it (D52), then run once in the live
 * workspace, where the session's bash runs, under the same live policy
 * `check` seals, through the shared property evaluator
 * (work/ledger-property.ts) that every later observation of the case uses
 * too. One `ledger/property` row records what that run saw: the sample seed,
 * the cases run, every counterexample with its input snapshotted before
 * anything else ran (E1). Nothing gates: malformed input returns findings
 * and records nothing; a violated property is data returned to the model.
 *
 * T7: the run is bounded by `cases`, the time budget and
 * `max_counterexamples`; the call reads the ledger, the order, the
 * environment facts and the recorded counterexamples from the log's running
 * projection; its writes into the scratch are admitted by the same cap as a
 * check's; counterexample inputs are capped per observation and per session
 * (work/ledger-property.ts).
 */
export function createPropertyTool(input: {
  log: EventLog;
  workspaceRoot: string;
  /** The scratch cap (default SCRATCH_LIMITS); tests give a smaller one. */
  scratchLimits?: ScratchLimits;
}): AgentTool {
  const { log, workspaceRoot } = input;
  const scratchLimits = input.scratchLimits ?? SCRATCH_LIMITS;
  let meter: ScratchMeter | undefined;
  const meterFor = (scratch: string): ScratchMeter => {
    if (meter === undefined || meter.dir !== scratch) meter = new ScratchMeter(scratch, scratchLimits);
    return meter;
  };
  // The live policy: the one `check` seals — workspace-write (or the envfix
  // wave's mode) on the live workspace with the session's scratch bound.
  let live: { policy: SandboxPolicy; scratch: string } | undefined;
  const livePolicy = (scratch: string): SandboxPolicy => {
    if (live !== undefined && live.scratch === scratch) return live.policy;
    if (live !== undefined) disposeSandboxPolicy(live.policy);
    const policy = createPolicy({
      mode: process.env.DOKKABI_SANDBOX_MODE === "envfix" ? "envfix" : "workspace-write",
      workspaceRoot,
      log,
      scratchRoot: scratch,
    });
    live = { policy, scratch };
    return policy;
  };
  const findingsText = (findings: readonly { check: string; node?: string; fact: string }[]) => ({
    content: [{ type: "text" as const, text: clampToolResultText(JSON.stringify({ status: "findings", findings })) }],
    details: { error: false },
  });
  const tool: AgentTool = {
    name: "property",
    label: "property",
    description: PROPERTY_TOOL_DESCRIPTION,
    parameters: propertyParameters as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const normalized = normalizePropertyInput((params ?? {}) as Record<string, unknown>);
      if (!normalized.ok) return findingsText(normalized.findings);
      const { item, contents } = normalized;
      // Every case writes its input into the scratch: a session without one
      // cannot run a property.
      const scratch = ensureSessionScratch({ logPath: log.path, workspaceRoot, readOnly: log.isReadOnly });
      if (scratch === undefined) {
        return findingsText([{ check: "scratch", node: item.id, fact: "this session has no scratch directory outside the workspace, so the property's generated inputs cannot be kept; use check instead" }]);
      }
      // The scratch cap (D48b), before anything is written: the fixtures and
      // one execution's capture, as a check's, plus the case's area and the
      // directories of the counterexamples the call keeps.
      const scratchMeter = meterFor(scratch);
      const need = checkScratchNeed(scratch, item, contents);
      const kept = { bytes: 0, entries: 2 + item.property!.max_counterexamples };
      const total = { bytes: need.total.bytes, entries: need.total.entries + kept.entries };
      const admitted = scratchMeter.admit(total);
      if (!admitted.ok) {
        return findingsText([{ check: "scratch_cap", node: item.id, fact: scratchCapFact(admitted.usage, total, scratchLimits, "property") }]);
      }
      scratchMeter.wrote({ bytes: need.persistent.bytes, entries: need.persistent.entries + kept.entries });
      if (contents.size > 0) {
        try {
          storeCheckContents(scratch, contents);
        } catch (error) {
          // A link a session placed on the store's path is refused (S1); the
          // finding leads with that, whatever the length of the path.
          const why = error instanceof LinkSafetyError ? `refused (S1): ${error.message}` : error instanceof Error ? error.message : String(error);
          return findingsText([{ check: "scratch", node: item.id, fact: `the fixture texts could not be kept in the scratch directory: ${why.slice(0, 400)}` }]);
        }
      }
      // The counterexamples earlier observations of this id recorded, read
      // before this call's own row: they run first — and any past the replay
      // cap keep the call from being green (D58b V1).
      const ledger = liveLedger(log);
      const replay = ledger.propertyReplay(item.id);
      const order = ledger.orderStatement() ?? "";
      const decision = ledger.fold.recordCase(item, order);
      if (decision.status === "findings") return findingsText(decision.findings);
      let revision: number;
      let recorded: LedgerCase = item;
      if (decision.status === "graph") {
        const result = recordLedger({
          proposal: { todos: [], cases: [item], delta: decision.latest !== undefined },
          order,
          latest: decision.latest,
          // D58b V5: the one caller that records a property case — validated
          // above (normalizePropertyInput).
          validatedCases: true,
        });
        if (result.status === "findings") return findingsText(result.findings);
        log.append({
          kind: "observe",
          name: LEDGER_EVENT,
          payload: { graph: result.graph, digest: result.digest, revision: result.revision, parent_digest: result.parent_digest, check_case: item.id },
        });
        writeLedgerMirror(log, result);
        revision = result.revision;
        recorded = result.graph.cases.find((entry) => entry.id === item.id) ?? item;
      } else {
        log.append({ kind: "observe", name: LEDGER_CASE_EVENT, payload: { ...decision.row } });
        const latest: LedgerRevision | undefined = liveLedger(log).revision();
        if (latest !== undefined) writeLedgerMirror(log, latest);
        revision = decision.row.revision;
      }
      const reproFindings = caseReproducibilityFindings(
        [recorded],
        recordedTestRunners(log),
        workspaceRoot,
        recordedProjectEnvironments(log),
        recordedCommands(log),
      );
      let observation: PropertyObservation;
      try {
        const policy = livePolicy(scratch);
        observation = runProperty({
          item: recorded,
          policy,
          treeRoot: workspaceRoot,
          replay,
          sampleSeed: recorded.property!.seed,
          store: sessionPropertyStore(log),
          keepCounterexamples: true,
          callPrefix: propertyCallPrefix("ledger-property", recorded.id),
          // Each execution under a policy of its own made from the live one:
          // the live workspace, the scratch read-only but for its own
          // directories (D58b V4).
          executor: () => livePropertyExecutor({ log, item: recorded, policy }),
        });
      } catch (error) {
        // A policy that cannot be sealed: the case is recorded, the run is
        // unknown — never a verdict.
        observation = {
          status: "not_runnable", reason: `the property could not be run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          sample_seed: recorded.property!.seed, runs: 0, sample: 0, replayed: [], replay_planned: 0, replay_overflow: replay.overflow,
          stopped: "error", elapsed_ms: 0, case_ms: 0, counterexamples: [], translated_paths: 0,
        };
      }
      log.append({ kind: "observe", name: PROPERTY_ROW, payload: {
        planner: LEDGER_PLANNER,
        case: recorded.id,
        revision,
        // The pure verdict of the row's own `property` field (D58b V2).
        status: propertyVerdict(observation),
        ...(observation.exit_code !== undefined ? { exit_code: observation.exit_code } : {}),
        duration_ms: observation.elapsed_ms,
        ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
        ...propertyRowFields(observation),
      } });
      const usage = scratchMeter.current();
      const scratchNotes = scratchFraction(usage, scratchLimits) >= SCRATCH_WARN_FRACTION
        ? [{ check: "scratch_size", fact: scratchSizeFact(usage, scratchLimits) }]
        : [];
      return {
        content: [{
          type: "text" as const,
          text: clampToolResultText(formatPropertyResult({
            item: recorded,
            revision,
            observation,
            fixturesDir: checkDirFor(scratch, recorded.id),
            findings: [...reproFindings, ...scratchNotes],
          })),
        }],
        details: { error: false },
      };
    },
  };
  PROPERTY_TOOL_DISPOSERS.set(tool, () => {
    if (live !== undefined) disposeSandboxPolicy(live.policy);
    live = undefined;
  });
  return tool;
}

/**
 * The ledger's `finish` (interfaces-v3.md §1): the model's claim that the
 * order is met. It ends the session; it does not gate — the host observes the
 * cases itself at the end and labels the run (ledger-label), so there is no
 * verdict and no receipts protocol here, only the claimed summary's digest.
 * When the ledger carries zero non-guard cases, the claim records exactly as
 * before AND the result returns one informational finding stating what that
 * means for the label — data, never a refusal, never an invitation (the
 * run-6 evidence: an invitation at finish time produced a weak case and the
 * first false accepted; the finding now states the consequence and nothing
 * else). The host never infers a case from session activity.
 */
export function createLedgerFinishTool(input: { log: EventLog }): AgentTool {
  const { log } = input;
  return {
    name: "finish",
    label: "finish",
    description: "Claim the order is met with a short summary. The claim ends the session; the host observes the ledger cases itself at the end. Cases are re-run by the host at the end of the session in a clean sandbox from the workspace root; /tmp is not preserved; a piped runner's exit code is the pipe's. A session that finishes is labeled accepted when at least one recorded non-guard case fails on the base tree and passes on the final tree, and done_unverified otherwise; a session that does not finish is labeled incomplete. A case that also passes on the base tree is recorded as green_at_base and counts as a guard, not as evidence of the change. A case or guard whose target test file the session itself modified (beyond adding tests) is reported as tampered and does not count.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What was done, in your own words." },
      },
      required: ["summary"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = params as { summary?: unknown };
      if (typeof p.summary !== "string" || p.summary.length === 0) {
        // Same shape as the plan tool's findings: data, records nothing.
        return {
          content: [{
            type: "text" as const,
            text: clampToolResultText(JSON.stringify({ status: "findings", findings: [{ check: "summary", fact: "finish requires a non-empty summary" }] })),
          }],
          details: { error: true },
        };
      }
      log.append({
        kind: "observe",
        name: "work/finish",
        payload: { summary_digest: createHash("sha256").update(p.summary).digest("hex") },
      });
      // Informational only (CASE-ERGONOMICS item 2, LABEL-EVIDENCE A): the
      // row above is exactly the claim either way; a ledger with no non-guard
      // case is delivered as done_unverified, and the model is told so — as
      // the consequence for the label, with no count and no invitation.
      const nonGuard = revisionCases(liveLedger(log).revision()).filter((item) => item.guard !== true).length;
      if (nonGuard === 0) {
        return {
          content: [{
            type: "text" as const,
            text: clampToolResultText(JSON.stringify({
              status: "recorded",
              findings: [{
                check: "no_cases",
                fact: "no verification case recorded; this session's label will be done_unverified",
              }],
            })),
          }],
          details: { error: false },
        };
      }
      return {
        content: [{ type: "text" as const, text: "finish recorded; the host observes the ledger cases at the end" }],
        details: { error: false },
      };
    },
  };
}

/**
 * The ledger's `defect` (D39): how a session that was asked to CHECK something
 * reports what it found. One call appends one `work/defect` row — an
 * observation, like every other row here — carrying the four statements the
 * next session needs (title, expected, observed, reproduce) and, optionally,
 * the id of a recorded case that reproduces it. The tool holds no state: two
 * calls with the same title are two observations, never an update, and nothing
 * here gates, labels or refuses the work.
 *
 * It exists because the alternative does not survive contact with the ledger's
 * own norm. The first verified-work chain asked its verifier to report defects
 * as RED cases; the verifier wrote every one of them to exit 0 when the defect
 * was present, said so in its summary, and the fix stage never ran. A green
 * case is the good outcome everywhere else in the contract, so a defect needs
 * its own affordance rather than an inverted reading of that one.
 *
 * D58: a defect may also name the principle it breaks (`principle`, text) and
 * the property that states that principle over many inputs (`property`, the
 * id of a case the ledger declares as a property — anything else is a finding
 * and records nothing), so the fix order can say the fix is done when that
 * property holds, not when one reproduction passes.
 */
export function createLedgerDefectTool(input: { log: EventLog }): AgentTool {
  const { log } = input;
  return {
    name: "defect",
    label: "defect",
    description: `Report one defect of the product you are checking: what the order specifies, what you observed instead, and how to reproduce it. One call per defect — each call records one observation and changes nothing, so reporting the same defect twice records it twice. Name the check that reproduces it in \`case\` (the id you gave \`check\`, or any recorded ledger case); a case's own verdict is not how a defect is reported. Name the rule it breaks in \`principle\`, and when you stated that rule over many inputs with \`property\`, its id in \`property\`: the fix is then done when the property holds, not when one reproduction passes. Titles are kept to ${MAX_DEFECT_TITLE} characters and each statement to ${MAX_DEFECT_TEXT}.`,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The defect in one short line." },
        expected: { type: "string", description: "The behaviour the order specifies." },
        observed: { type: "string", description: "The behaviour you observed instead." },
        reproduce: { type: "string", description: "How to reproduce it, step by step." },
        case: { type: "string", description: "The id of the check (a recorded ledger case) that reproduces this defect." },
        principle: { type: "string", description: "The rule this defect breaks, in words." },
        property: { type: "string", description: "The id of a recorded property (the property tool) that captures this defect over many inputs." },
      },
      required: ["title", "expected", "observed", "reproduce"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = params as Record<string, unknown>;
      // Same shape as the plan and finish tools' findings: data, records
      // nothing. A defect missing one of its four statements is not a report
      // the next session can act on.
      for (const field of ["title", "expected", "observed", "reproduce"] as const) {
        const value = p[field];
        if (typeof value !== "string" || value.trim().length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: clampToolResultText(JSON.stringify({
                status: "findings",
                findings: [{ check: field, fact: `defect requires a non-empty ${field}` }],
              })),
            }],
            details: { error: true },
          };
        }
      }
      // D58: the principle, when given, is text; the property, when given,
      // names a property the ledger declares — otherwise the report would
      // hand the fix a rule with no command behind it. Findings, recording
      // nothing.
      const principle = p.principle === undefined ? undefined : typeof p.principle === "string" && p.principle.trim().length > 0 ? p.principle : null;
      const propertyId = p.property === undefined ? undefined : typeof p.property === "string" && p.property.trim().length > 0 ? p.property.trim() : null;
      const shapeFindings: { check: string; fact: string }[] = [];
      // D58b V3: the property's spec as declared NOW, bound onto the row by
      // its digest — the recheck re-runs exactly this spec, whatever the
      // verifier declares under that id later (drops it, re-declares it).
      let propertySpec: string | undefined;
      if (principle === null) shapeFindings.push({ check: "principle", fact: "principle, when given, must be the rule the defect breaks, in words" });
      if (propertyId === null) shapeFindings.push({ check: "property", fact: "property, when given, must be the id of a recorded property" });
      else if (propertyId !== undefined) {
        const declared = liveLedger(log).fold.caseOf(propertyId);
        if (declared !== undefined && isPropertyCase(declared)) propertySpec = caseSpecDigest(declared);
        if (declared === undefined || !isPropertyCase(declared)) {
          shapeFindings.push({
            check: "property",
            fact: declared === undefined
              ? `the ledger declares no property ${propertyId}; state it with the property tool first, or leave property out`
              : `ledger case ${propertyId} is not a property; name a case recorded with the property tool, or leave property out`,
          });
        }
      }
      if (shapeFindings.length > 0) {
        return {
          content: [{ type: "text" as const, text: clampToolResultText(JSON.stringify({ status: "findings", findings: shapeFindings })) }],
          details: { error: true },
        };
      }
      const caseId = typeof p.case === "string" && p.case.trim().length > 0 ? p.case : undefined;
      const statement = boundDefect({
        title: p.title as string,
        expected: p.expected as string,
        observed: p.observed as string,
        reproduce: p.reproduce as string,
        ...(caseId === undefined ? {} : { case: caseId }),
        ...(principle === undefined || principle === null ? {} : { principle }),
        ...(propertyId === undefined || propertyId === null ? {} : { property: propertyId }),
        ...(propertySpec === undefined ? {} : { property_digest: propertySpec }),
      });
      // The id is the host's, not the model's: the ordinal of this session's
      // defect rows, so a second call about the same thing is visibly a second
      // observation rather than a collision.
      const id = `defect-${liveLedger(log).defectRows() + 1}`;
      log.append({ kind: "observe", name: "work/defect", payload: { id, ...statement } });
      // Informational only, exactly like finish's no-cases finding: the row is
      // already recorded either way. A case id the ledger does not declare
      // reaches the fix session as a name with no command behind it.
      if (statement.case !== undefined && !liveLedger(log).fold.hasCase(statement.case)) {
        return {
          content: [{
            type: "text" as const,
            text: clampToolResultText(JSON.stringify({
              status: "recorded",
              id,
              findings: [{
                check: "unknown_case",
                fact: `${id} recorded; the ledger declares no case ${statement.case}, so the report carries the name without a command`,
              }],
            })),
          }],
          details: { error: false },
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: `${id} recorded${statement.case === undefined ? "" : `, reproduced by case ${statement.case}`}${statement.property === undefined ? "" : `, captured by property ${statement.property}`}; the next session reads these rows`,
        }],
        details: { error: false },
      };
    },
  };
}

// --- adjudication: `dispute` and `ruling` (D54) -------------------------------
//
// A fix session may DISPUTE an open check its order states (the section after
// the previous fix) as contradicting the order; the next fresh verifier RULES
// on each dispute its order lists. Each call records one row in its own
// session and changes nothing else: the orchestrator reads the rows after the
// session and decides from them, outside every session, whether a check
// closes (work/recheck-adjudication.ts). What a call accepts is a pure
// function of the log — the identities and the operator's order inside the
// order the session was given (its work/goal row) — and anything else comes
// back as findings and records nothing.

/** The `dispute` tool's one-paragraph description (D54, T2). */
export const DISPUTE_TOOL_DESCRIPTION =
  "Dispute an open check you believe contradicts the order: a check your order lists as observed after the previous fix, named by its identity exactly as stated there, with your reason and the exact text of the order you rely on. The dispute is recorded and changes nothing now: the check stays open and is re-run as recorded after this session; a later verifier, which neither wrote nor disputed it, rules on it against the order, and only its ruling that the order does not require what the check expects closes it. Changing, weakening or re-declaring the check closes nothing.";

/** The `ruling` tool's one-paragraph description (D54, T2). */
export const RULING_TOOL_DESCRIPTION =
  "Rule on a check your order lists as disputed, named by its identity exactly as listed: upheld when the order requires what the check expects, invalid only when it does not. Judge it against the order alone — not the product, the tests in the tree or the reasons given — and cite the exact order text your ruling rests on, with your reason. One call per disputed check; the ruling is recorded and changes nothing in the product.";

const identityParameter = {
  type: "object",
  description: "The check's identity exactly as your order states it.",
  properties: {
    source: { type: "string", description: "The session that recorded the check." },
    case: { type: "string", description: "The check's case id." },
    spec: { type: "string", description: "The digest of the check's spec." },
  },
  required: ["source", "case", "spec"],
} as const;

type AdjudicationFinding = { readonly check: string; readonly fact: string };

function adjudicationFindings(findings: readonly AdjudicationFinding[]) {
  return {
    content: [{ type: "text" as const, text: clampToolResultText(JSON.stringify({ status: "findings", findings })) }],
    details: { error: true },
  };
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundText(value: string): string {
  return value.length <= MAX_ADJUDICATION_TEXT ? value : value.slice(0, MAX_ADJUDICATION_TEXT);
}

/** The identity a call names: the object, or the same object as JSON text. */
function namedIdentity(value: unknown): CheckIdentity | undefined {
  let item = value;
  if (typeof item === "string") {
    try {
      item = JSON.parse(item);
    } catch {
      return undefined;
    }
  }
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const { source, case: caseId, spec } = item as Record<string, unknown>;
  if (!nonEmptyText(source) || !nonEmptyText(caseId) || !nonEmptyText(spec)) return undefined;
  return { source, case: caseId, spec };
}

function sameIdentity(a: CheckIdentity, b: CheckIdentity): boolean {
  return a.source === b.source && a.case === b.case && a.spec === b.spec;
}

/** The session's order, parsed once per order text: the calls of a session
 * read the same work/goal row. */
function orderReader(log: EventLog, parse: (order: string) => CheckIdentity[]) {
  let cached: { readonly order: string; readonly identities: CheckIdentity[]; readonly specification: string } | undefined;
  return () => {
    const order = liveLedger(log).orderStatement() ?? "";
    if (cached === undefined || cached.order !== order) {
      cached = { order, identities: parse(order), specification: orderSpecification(order) };
    }
    return cached;
  };
}

const QUOTE_FACT = "the order does not contain this text; quote the order's own words exactly (line breaks and runs of spaces may differ)";

/**
 * The ledger's `dispute` (D54): how a fix session says that an open check its
 * order states contradicts the order. One call appends one `work/dispute` row
 * — `{id, source, case, spec, reason, order_text}` — and nothing else: the
 * check stays open and is re-run as recorded; the next fresh verifier rules on
 * it. A call without an identity, a reason or the order text, one naming an
 * identity the order does not state as open, or quoting text the order does
 * not contain, is a finding and records nothing.
 */
export function createLedgerDisputeTool(input: { log: EventLog }): AgentTool {
  const { log } = input;
  const order = orderReader(log, fixOrderOpenIdentities);
  return {
    name: "dispute",
    label: "dispute",
    description: DISPUTE_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        identity: identityParameter,
        reason: { type: "string", description: "Why the check contradicts the order." },
        order_text: { type: "string", description: "The exact text of the order the dispute relies on." },
      },
      required: ["identity", "reason", "order_text"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = (params ?? {}) as Record<string, unknown>;
      const identity = namedIdentity(p.identity);
      const findings: AdjudicationFinding[] = [];
      if (identity === undefined) findings.push({ check: "identity", fact: "dispute requires the check's identity — source, case and spec — exactly as the order states it" });
      if (!nonEmptyText(p.reason)) findings.push({ check: "reason", fact: "dispute requires a non-empty reason" });
      if (!nonEmptyText(p.order_text)) findings.push({ check: "order_text", fact: "dispute requires the exact order text it relies on" });
      if (findings.length > 0 || identity === undefined) return adjudicationFindings(findings);
      const read = order();
      if (!read.identities.some((item) => sameIdentity(item, identity))) {
        return adjudicationFindings([{
          check: "unknown_identity",
          fact: "the order states no open check with this identity; dispute only a check the order lists as observed after the previous fix, by the identity stated there",
        }]);
      }
      const orderText = boundText(p.order_text as string);
      if (!orderQuoteFound(read.specification, orderText)) return adjudicationFindings([{ check: "order_text", fact: QUOTE_FACT }]);
      const id = `dispute-${liveLedger(log).disputeRows() + 1}`;
      log.append({
        kind: "observe",
        name: WORK_DISPUTE_ROW,
        payload: { id, source: identity.source, case: identity.case, spec: identity.spec, reason: boundText(p.reason as string), order_text: orderText },
      });
      return {
        content: [{
          type: "text" as const,
          text: `${id} recorded: ${identity.case} (source ${identity.source}) is disputed. It stays open and is re-run as recorded; a later verifier rules on it against the order.`,
        }],
        details: { error: false },
      };
    },
  };
}

/**
 * The ledger's `ruling` (D54): how a verifier rules on a check a fix session
 * disputed, listed in its order. One call appends one `work/ruling` row —
 * `{id, source, case, spec, ruling: upheld | invalid, order_text, reason}` —
 * and nothing else. A call without an identity, a ruling, the order text or a
 * reason, one naming an identity the order does not list as disputed, or
 * quoting text the order does not contain, is a finding and records nothing.
 */
export function createLedgerRulingTool(input: { log: EventLog }): AgentTool {
  const { log } = input;
  const order = orderReader(log, verifyOrderDisputedIdentities);
  return {
    name: "ruling",
    label: "ruling",
    description: RULING_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        identity: identityParameter,
        ruling: { type: "string", enum: ["upheld", "invalid"], description: "upheld: the order requires what the check expects; invalid: it does not." },
        order_text: { type: "string", description: "The exact text of the order the ruling rests on." },
        reason: { type: "string", description: "Why, judged against the order." },
      },
      required: ["identity", "ruling", "order_text", "reason"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = (params ?? {}) as Record<string, unknown>;
      const identity = namedIdentity(p.identity);
      const findings: AdjudicationFinding[] = [];
      if (identity === undefined) findings.push({ check: "identity", fact: "ruling requires the disputed check's identity — source, case and spec — exactly as the order lists it" });
      if (p.ruling !== "upheld" && p.ruling !== "invalid") findings.push({ check: "ruling", fact: "ruling must be upheld or invalid" });
      if (!nonEmptyText(p.order_text)) findings.push({ check: "order_text", fact: "ruling requires the exact order text it rests on" });
      if (!nonEmptyText(p.reason)) findings.push({ check: "reason", fact: "ruling requires a non-empty reason" });
      if (findings.length > 0 || identity === undefined) return adjudicationFindings(findings);
      const read = order();
      if (!read.identities.some((item) => sameIdentity(item, identity))) {
        return adjudicationFindings([{
          check: "unknown_identity",
          fact: "the order lists no disputed check with this identity; rule only on a check the order lists as disputed, by the identity listed there",
        }]);
      }
      const orderText = boundText(p.order_text as string);
      if (!orderQuoteFound(read.specification, orderText)) return adjudicationFindings([{ check: "order_text", fact: QUOTE_FACT }]);
      const id = `ruling-${liveLedger(log).rulingRows() + 1}`;
      const ruling = p.ruling as "upheld" | "invalid";
      log.append({
        kind: "observe",
        name: WORK_RULING_ROW,
        payload: { id, source: identity.source, case: identity.case, spec: identity.spec, ruling, order_text: orderText, reason: boundText(p.reason as string) },
      });
      return {
        content: [{ type: "text" as const, text: `${id} recorded: ${identity.case} (source ${identity.source}) ruled ${ruling}.` }],
        details: { error: false },
      };
    },
  };
}

export const plugin: PluginModule = {
  id: "ledger-tools",
  claims: [{ key: "tool_contributions", role: "consumer", modelFacing: true }],
  register(ctx) {
    const registry = ctx.inject<ToolContributionRegistry<AgentTool>>("tool_contributions");
    const plan = createPlanTool({ log: ctx.log, workspaceRoot: ctx.workspaceRoot });
    // note and ask_operator are the model-loop tools themselves, reused.
    const note = createNoteTool(ctx.log);
    const askOperator = createAskOperatorTool(ctx.log);
    const finish = createLedgerFinishTool({ log: ctx.log });
    const defect = createLedgerDefectTool({ log: ctx.log });
    const check = createCheckTool({ log: ctx.log, workspaceRoot: ctx.workspaceRoot });
    // D58: an invariant over generated inputs, recorded and run in one call.
    const property = createPropertyTool({ log: ctx.log, workspaceRoot: ctx.workspaceRoot });
    // D54: a fix disputes, a verifier rules; the verify profile projects
    // `ruling` and not `dispute`.
    const dispute = createLedgerDisputeTool({ log: ctx.log });
    const ruling = createLedgerRulingTool({ log: ctx.log });
    ctx.effect(() => {
      const disposers = [plan, check, property, note, askOperator, finish, defect, dispute, ruling].map((tool) => registry.register(plugin.id, tool));
      return () => {
        for (const dispose of disposers) dispose();
        disposeCheckTool(check);
        disposePropertyTool(property);
      };
    });
  },
};
