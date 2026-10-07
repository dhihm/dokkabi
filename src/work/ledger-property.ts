import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import { mintReceipt } from "../host/execution-receipt.ts";
import type { EventRecord } from "../host/schema.ts";
import { createPolicy, disposeSandboxPolicy, spawnFenced, type SandboxPolicy } from "../host/sandbox.ts";
import { executeTool, type ToolOutcome } from "../tools/execute.ts";
import { caseLaunch, shellQuote } from "./case-launch.ts";
import {
  CHECK_DIR_ENV,
  CHECK_ID_MAX,
  CHECK_INPUT_MAX_BYTES,
  CHECK_PATH_MAX,
  checkDirFor,
  checkDirName,
  checkShapeOf,
  confiningPolicy,
  normalizeFixtureFiles,
  recordedText,
  refusedReason,
  removeScratchTree,
  safeRelativePath,
  type CheckInputFinding,
} from "./ledger-check.ts";
import { LEDGER_PLANNER } from "./ledger-label.ts";
import { chmodBeneath, ensureDirBeneath, LinkSafetyError, lstatBeneath, readBeneath, readLinkBeneath, removeTreeBeneath, safeRoot, symlinkBeneath, walkBeneath, writeBeneath, type SafeRoot } from "./link-safe-fs.ts";
import { beneath } from "./path-bytes.ts";
import type { LedgerCase, LedgerProperty } from "./plan-ledger.ts";
import {
  PROPERTY_CASES_DEFAULT,
  PROPERTY_CASES_MAX,
  PROPERTY_MAX_COUNTEREXAMPLES_DEFAULT,
  PROPERTY_MAX_COUNTEREXAMPLES_MAX,
  PROPERTY_PRINCIPLE_MAX,
  PROPERTY_REPLAY_MAX,
  PROPERTY_ROW_TAIL_CHARS,
  PROPERTY_SEED_MAX,
  PROPERTY_TIME_BUDGET_DEFAULT_MS,
  PROPERTY_TIME_BUDGET_MAX_MS,
  propertyBoundsOf,
  propertyFieldsOf,
  propertyShortfall,
  propertyVerdict,
  type PropertyCaseRef,
  type PropertyCounterexample,
  type PropertyFields,
  type PropertyInputDiffers,
  type PropertyReplay,
  type PropertyStatus,
  type PropertyStop,
} from "./property-verdict.ts";
import {
  readRecheckInputs,
  recheckInputsGaps,
  RecheckInputStore,
  snapshotRecheckInputs,
  type RecheckInputBounds,
  type RecheckInputSnapshot,
  type RecheckInputsRecord,
} from "./recheck-inputs.ts";
import { cloneWorkspaceCopy, detachLinkedGit, removeWorkspaceCopy, translateLiveRoots, type PristineCopy } from "./workspace-copy.ts";

export {
  PROPERTY_CASES_DEFAULT,
  PROPERTY_CASES_MAX,
  PROPERTY_MAX_COUNTEREXAMPLES_DEFAULT,
  PROPERTY_MAX_COUNTEREXAMPLES_MAX,
  PROPERTY_PRINCIPLE_MAX,
  PROPERTY_REPLAY_MAX,
  PROPERTY_ROW_TAIL_CHARS,
  PROPERTY_SEED_MAX,
  PROPERTY_TIME_BUDGET_DEFAULT_MS,
  PROPERTY_TIME_BUDGET_MAX_MS,
  propertyBoundsOf,
  propertyFieldsOf,
  propertyShortfall,
  propertyVerdict,
};
export { propertyRowFields, propertyRowStatus } from "./property-verdict.ts";
export type { PropertyCaseRef, PropertyCounterexample, PropertyFields, PropertyInputDiffers, PropertyReplay, PropertyStatus, PropertyStop };

/**
 * PROPERTY (D58, design memo §112; D58b, §114): the one evaluator every
 * observation of a `property` case shares — the call's own, the plan probe,
 * the final pass, the base pass and the verify-rounds recheck.
 *
 * A property states an invariant over generated inputs. Its command runs ONE
 * case: it generates its input from DOKKABI_PROPERTY_SEED (and may use
 * DOKKABI_PROPERTY_CASE), writes that input into DOKKABI_PROPERTY_DIR — a
 * directory made empty for it under the scratch — and asserts the invariant:
 * exit 0 holds, anything else violates it. The generator is the model's own
 * code, in any language, recorded as the case's fixtures exactly as a
 * check's are (content-addressed; DOKKABI_CHECK_DIR).
 *
 * An observation runs, in order: the case's REPLAY SET — every counterexample
 * an earlier observation of the case recorded (by the seed and case it ran
 * with, first recorded first) that no later observation re-ran to completion
 * and saw hold (D58c L1, PropertyCounterexampleFold: the host never records
 * more of them than an observation replays, PROPERTY_REPLAY_MAX) — then a
 * SAMPLE — case i of it gets the seed
 * propertyCaseSeed(sample seed, i). The sample seed is the declared one for
 * the model's own call (the same seed, the same cases) and a fresh one for
 * every host observation, recorded on its row. It stops after `cases` sample
 * cases, when the time budget or the run's outer wall is spent (a case still
 * running then is cut and not judged), or once `max_counterexamples` cases
 * violated the invariant.
 *
 * VERDICT INTEGRITY (D58b V1, V2; property-verdict.ts): the row's status is
 * the pure verdict of its own `property` field — red on any completed
 * counterexample; green only when every recorded counterexample it set out to
 * replay ran to completion and held, none was left past the replay cap, every
 * planned case ran and nothing was cut; otherwise not_runnable (unknown).
 * Every execution that started and ended by any exit status or signal is
 * judged (propertyEnding): exit 0 holds, anything else — 126, 127, a signal
 * death — violates it; only an execution that could not start, or that the
 * host itself cut (its time, its output bound), is not judged.
 *
 * RP — A REPLAY RUNS ON THE RECORDED INPUT (D58d, design memo §116): before
 * a recorded counterexample is replayed, the input its snapshot recorded
 * (E1) is restored into the case's directory — its directories, files and
 * links, byte for byte — and the command is told so
 * (DOKKABI_PROPERTY_REPLAY=1): the generator must regenerate the same bytes
 * from the seed or leave them. Once the replay ended, every entry the
 * snapshot recorded must stand at its path as recorded; new paths may be
 * anything. A replay that changed one, or whose recorded input cannot be
 * restored (none taken, over the snapshot's bounds, gone from its store), is
 * `input_differs`: not held — it stays in the replay set (L1) — and not a
 * counterexample (its input is not the one its seed names), and the
 * observation is not green (property-verdict.ts). Before D58d a replay
 * regenerated its input from the seed into an empty directory, so a
 * generator that reads anything besides the seed (the time, $RANDOM, the
 * environment, the tree a fix touched) "held" on another input, and the real
 * counterexample left the replay set unfixed.
 *
 * THE BOUNDS (V5): every observation re-checks the recorded property against
 * the property tool's own bounds (propertyBoundsOf) before it runs anything.
 *
 * THE TIME BUDGET (V6) is charged with case execution time only: the
 * executions themselves, as each executor measures them, never the host's
 * work around them (a copy, a policy, a snapshot). The outer wall is the
 * run's own clock.
 *
 * E1 — a counterexample's input is captured before anything else can change
 * it: right after the failing case's process ended, before the next case is
 * started and before the result is returned, its per-case directory is
 * snapshotted into a content-addressed store the session cannot write (the
 * session directory's `property-inputs`, or the rounds log's `recheck-inputs`
 * for the recheck), bounded per execution, per observation and per store —
 * every byte written, objects and snapshot files, counted (V6); the row names
 * the snapshot. Never an inventory taken later.
 *
 * R1 — the snapshot records paths and link targets as bytes
 * (recheck-inputs.ts, path-bytes.ts).
 *
 * S1 — every host operation on the scratch (the fixtures, the per-case and
 * capture directories, the capture, holding and returning a kept directory,
 * their removal) is relative to the scratch as a root the host pinned
 * (link-safe-fs.ts); recursive removals run as `rm` inside the observation's
 * own policy when it confines writes, as the check path's do.
 *
 * E1'' INSIDE AN OBSERVATION (V4) — each execution sees the fixtures
 * rewritten from the RECORD right before it starts, and a scratch view
 * nothing an earlier execution wrote: every execution runs under a policy of
 * its own that binds the scratch READ-ONLY except its own DOKKABI_PROPERTY_DIR
 * and its own output capture directory, both made fresh for it; once it
 * ended the host removes both — a counterexample's directory, which the
 * model's own call keeps, is held outside the scratch until the call's last
 * execution ended and then put back where the result says. The host's
 * observations (probe, final, base, recheck) also run every execution on a
 * fresh copy of their tree of its own (cloneWorkspaceCopy), removed once the
 * case is over. The model's own call runs in the live workspace, where its
 * bash runs, like `check`: its cases share that tree (never the scratch).
 *
 * Scratch layout (inside the bound scratch):
 *   checks/<case>/               the fixtures (DOKKABI_CHECK_DIR), as for a
 *                                check, rewritten before every execution
 *   properties/<case>/<n>/       the n-th execution's DOKKABI_PROPERTY_DIR;
 *                                removed once it held; a counterexample's is
 *                                kept by the model's own call (until the next
 *                                observation of the case) and removed by the
 *                                host's
 *   .host/observe/<nonce>/out    one execution's output, of which the last
 *                                PROPERTY_OUTPUT_TAIL_BYTES are printed back;
 *                                removed once it ended
 */

export const PROPERTY_SEED_ENV = "DOKKABI_PROPERTY_SEED";
export const PROPERTY_CASE_ENV = "DOKKABI_PROPERTY_CASE";
export const PROPERTY_DIR_ENV = "DOKKABI_PROPERTY_DIR";
/** Set to 1 for a replay of a recorded counterexample (RP): its directory
 * already holds the recorded input. Unset for a sample case. */
export const PROPERTY_REPLAY_ENV = "DOKKABI_PROPERTY_REPLAY";

/** What one execution prints back into its `tool/result` row: the last bytes
 * of its output (stdout and stderr together). */
export const PROPERTY_OUTPUT_TAIL_BYTES = 2_000;
const RESULT_TAIL_CHARS = 400;
/** One counterexample's input snapshot, at most. A generated input is small;
 * past this the snapshot records nothing and says `bounded: "exceeded"`. */
export const PROPERTY_INPUT_BOUNDS: Readonly<RecheckInputBounds> = Object.freeze({ entries: 256, bytes: 1024 * 1024 });
/** Every byte one counterexample's snapshot writes into the store — its
 * objects and its snapshot file together — at most (V6, per execution). */
export const PROPERTY_INPUT_BYTES_PER_EXECUTION = 2 * 1024 * 1024;
/** The counterexample inputs of one observation of one property, together:
 * every byte written, objects and snapshot files (V6, per observation). */
export const PROPERTY_INPUT_BYTES_PER_OBSERVATION = 8 * 1024 * 1024;
/** The session's store of counterexample inputs, at most: objects and
 * snapshot files, content-addressed — an input captured twice costs its bytes
 * once (V6, per session). */
export const PROPERTY_STORE_BYTES = 64 * 1024 * 1024;
/** The store's directory, beside the session's event log — outside the
 * scratch, so nothing the session runs can change it. */
export const PROPERTY_STORE_DIR = "property-inputs";
/** The row name of the model's own call. */
export const PROPERTY_ROW = "ledger/property";

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the case states an invariant: every observation runs it through
 * this file — and refuses it, stated, when its property is not within the
 * property tool's bounds (V5). */
export function isPropertyCase(item: Pick<LedgerCase, "property">): boolean {
  return item.property !== undefined;
}

const refKey = (ref: PropertyCaseRef) => `${ref.seed}:${ref.case}`;

/** Case i of a sample: the seed its command is given, a pure function of the
 * sample seed and i. */
export function propertyCaseSeed(sampleSeed: number, index: number): number {
  return createHash("sha256").update(`dokkabi-property-case\u0000${sampleSeed}\u0000${index}`).digest().readUInt32BE(0);
}

/** The seed a property's own call draws its sample from when it declares
 * none: a pure function of its id. */
export function defaultPropertySeed(id: string): number {
  return createHash("sha256").update(`dokkabi-property-seed\u0000${id}`).digest().readUInt32BE(0);
}

/** A host observation's sample seed: fresh, and recorded on its row. */
export function freshSampleSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

const stores = new WeakMap<EventLog, RecheckInputStore>();

/** The session's store of counterexample inputs, beside its event log: one
 * per log, so the bytes it holds are measured once and then counted as they
 * are added (T7: a call never walks what earlier calls stored). */
export function sessionPropertyStore(log: EventLog): RecheckInputStore {
  let store = stores.get(log);
  if (store === undefined) stores.set(log, store = new RecheckInputStore(join(dirname(resolve(log.path)), PROPERTY_STORE_DIR), PROPERTY_STORE_BYTES));
  return store;
}

// --- the tool boundary -------------------------------------------------------

export type NormalizedProperty =
  | { readonly ok: true; readonly item: LedgerCase; readonly contents: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly findings: CheckInputFinding[] };

/** An integer parameter within [min, max], its default when absent. */
function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
  node: string,
  findings: CheckInputFinding[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    findings.push({ check: name, node, fact: `${name} must be an integer from ${min} to ${max}` });
    return fallback;
  }
  return value;
}

/** The property tool's parameters, normalized into a ledger case and the
 * fixture texts to store. Findings are data: nothing is recorded when there
 * are any. The bounds are the ones every evaluator re-checks
 * (propertyBoundsOf, V5). */
export function normalizePropertyInput(params: Record<string, unknown>): NormalizedProperty {
  const findings: CheckInputFinding[] = [];
  const id = typeof params.id === "string" ? params.id.trim() : "";
  const node = id === "" ? "?" : id;
  if (id === "" || id.length > CHECK_ID_MAX) findings.push({ check: "id", node, fact: `id must be a non-empty string of at most ${CHECK_ID_MAX} characters` });
  const principle = typeof params.principle === "string" ? params.principle.trim() : "";
  if (principle === "") {
    findings.push({ check: "principle", node, fact: "property requires its principle: the invariant in words — what must hold for every input" });
  } else if (principle.length > PROPERTY_PRINCIPLE_MAX) {
    findings.push({ check: "principle", node, fact: `principle is longer than ${PROPERTY_PRINCIPLE_MAX} characters` });
  }
  const command = typeof params.command === "string" ? params.command : "";
  if (command.trim() === "") findings.push({ check: "command", node, fact: "command must be a non-empty string: it runs one case" });
  let dir: string | undefined;
  if (params.dir !== undefined) {
    const safe = typeof params.dir === "string" ? safeRelativePath(params.dir.trim()) : undefined;
    if (params.dir === "." || params.dir === "") dir = undefined;
    else if (safe === undefined) findings.push({ check: "dir", node, fact: "dir must be a workspace-relative directory without .." });
    else dir = safe;
  }
  const contents = new Map<string, string>();
  const fixtures = normalizeFixtureFiles(params.files, node, findings, contents);
  if (fixtures.bytes > CHECK_INPUT_MAX_BYTES) findings.push({ check: "files", node, fact: `fixtures together are longer than ${CHECK_INPUT_MAX_BYTES} bytes` });
  const cases = boundedInteger(params.cases, "cases", PROPERTY_CASES_DEFAULT, 1, PROPERTY_CASES_MAX, node, findings);
  const seed = boundedInteger(params.seed, "seed", defaultPropertySeed(id), 0, PROPERTY_SEED_MAX, node, findings);
  const timeBudget = boundedInteger(params.time_budget_ms, "time_budget_ms", PROPERTY_TIME_BUDGET_DEFAULT_MS, 1, PROPERTY_TIME_BUDGET_MAX_MS, node, findings);
  const maxCounterexamples = boundedInteger(
    params.max_counterexamples, "max_counterexamples", PROPERTY_MAX_COUNTEREXAMPLES_DEFAULT, 1, PROPERTY_MAX_COUNTEREXAMPLES_MAX, node, findings,
  );
  if (findings.length > 0) return { ok: false, findings };
  const item: LedgerCase = {
    id,
    command,
    ...(dir !== undefined ? { dir } : {}),
    ...(fixtures.files !== undefined && Object.keys(fixtures.files).length > 0 ? { files: fixtures.files } : {}),
    property: { principle, cases, seed, time_budget_ms: timeBudget, max_counterexamples: maxCounterexamples },
  };
  return { ok: true, item, contents };
}

// --- one observation ------------------------------------------------------------

export interface PropertyObservation extends PropertyFields {
  readonly status: PropertyStatus;
  readonly reason?: string;
  /** The first counterexample's exit code, 0 when green; absent otherwise. */
  readonly exit_code?: number;
  /** recheck: the inputs every execution ran with besides the product,
   * snapshotted before the first of them (E1', V4, V6). */
  readonly inputs?: RecheckInputsRecord;
  readonly translated_paths: number;
}

/** One execution as an observation path runs it. */
export interface PropertyExecution {
  /** 1-based, within the observation. */
  readonly ordinal: number;
  readonly ref: PropertyCaseRef;
  /** The executed shell text for the command as launched in its tree (dir
   * composed, live roots mapped): the fixtures, the seed, the case and the
   * per-case directory exported, the output captured and its tail printed. */
  readonly wrap: (launched: string) => string;
  /** What is left of the time budget (V6): the execution's own bound, which
   * the executor tightens to the outer wall. */
  readonly timeoutMs: number;
  /** The run's outer wall, when it has one. */
  readonly deadlineMs?: number;
  readonly callId: string;
  /** The only places of the scratch this execution may write (V4): its own
   * DOKKABI_PROPERTY_DIR and its own capture directory, both made fresh for
   * it. Its policy binds the rest of the scratch read-only. */
  readonly writable: readonly string[];
}

/** What one execution returned. */
export interface PropertyExecuted {
  /** Absent when the execution could not be made (its tree or its policy). */
  readonly outcome?: ToolOutcome;
  readonly reason?: string;
  readonly translated_paths: number;
  /** The sandbox it ran in: its policy's backend, `none` with the fence off. */
  readonly fence: string;
  /** recheck: its inputs besides the product, snapshotted before it ran. */
  readonly inputs?: RecheckInputsRecord;
  /** How long the execution itself ran (V6): what the time budget is
   * charged, never the host's work around it. */
  readonly duration_ms?: number;
  /** True when the outer wall, not the budget, bounded its time. */
  readonly wall_bound?: boolean;
  /** Give back its tree and policy; called once the evaluator is done with
   * the case (its input snapshotted). */
  readonly release: () => void;
}

export type PropertyExecute = (execution: PropertyExecution) => PropertyExecuted;

export interface PropertyRunInput {
  /** The recorded case (isPropertyCase). */
  readonly item: LedgerCase;
  /** The observation's own policy: it binds the scratch the executions bind;
   * the fixtures, the per-execution directories and every removal go
   * through it. The executions each run under a policy of their own. */
  readonly policy: SandboxPolicy;
  /** The tree the observation is of (for the fixtures' preparation only). */
  readonly treeRoot: string;
  /** Recorded counterexamples, run first (a plain list: no overflow). */
  readonly replay: PropertyReplay | readonly PropertyCaseRef[];
  readonly sampleSeed: number;
  /** Where counterexample inputs are kept (E1). */
  readonly store: RecheckInputStore;
  /** The model's own call keeps a counterexample's directory in the scratch
   * (put back from its snapshot once the call's last execution ended, V4). */
  readonly keepCounterexamples: boolean;
  /** The run's outer wall, when the caller has one. */
  readonly deadlineMs?: number;
  /** The execution call ids: `<prefix>-<ordinal>`. */
  readonly callPrefix: string;
  /** How one execution runs, given the scratch the policy binds. */
  readonly executor: (scratch: string) => PropertyExecute;
}

/** The fence of a policy, as a snapshot records it. */
export function fenceOf(policy: SandboxPolicy): string {
  return policy.disabled === true ? "none" : policy.backend;
}

/** The case's area below the scratch: `properties/<case>`. */
function propertyRel(item: Pick<LedgerCase, "id">): Buffer {
  return Buffer.from(`properties/${checkDirName(item.id)}`);
}

/** The last characters of a text. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** The replay a caller passed, as a list and an overflow. */
function asReplay(value: PropertyReplay | readonly PropertyCaseRef[]): PropertyReplay {
  return Array.isArray(value) ? { refs: value as readonly PropertyCaseRef[], overflow: 0 } : value as PropertyReplay;
}

/** How one execution ended (V2). */
export type PropertyEnding =
  | { readonly kind: "completed"; readonly exitCode: number; readonly signal?: string }
  | { readonly kind: "cut"; readonly by: "time" | "wall" | "host"; readonly reason: string }
  | { readonly kind: "not_started"; readonly reason: string };

/**
 * How one execution ended, from what the host observed of its process (V2):
 * a case that started and ended by any exit status or signal — 126 and 127,
 * a status past 128 a supervising backend reports for a signal
 * (`completion_unavailable`), a signal death itself — COMPLETED and is
 * judged; one the host stopped (its time bound, its output bound) was CUT and
 * is not judged; one that could not be made did NOT START. The same outcome
 * reads the same way on every sandbox backend. Pure.
 */
export function propertyEnding(executed: Pick<PropertyExecuted, "outcome" | "reason" | "wall_bound">): PropertyEnding {
  const outcome = executed.outcome;
  if (outcome === undefined) return { kind: "not_started", reason: executed.reason ?? "the case's execution could not be made" };
  const diagnostics = outcome.execution;
  if (diagnostics?.timed_out === true) {
    return executed.wall_bound === true
      ? { kind: "cut", by: "wall", reason: "the run's outer wall was reached while it ran" }
      : { kind: "cut", by: "time", reason: "the time budget ran out while it ran" };
  }
  if (diagnostics?.max_buffer_exceeded === true) return { kind: "cut", by: "host", reason: "the host stopped it: its output passed the host's bound" };
  // P1 (D58c): an execution whose process tree outlived the host's end of it
  // is not over, whatever its first process returned.
  if ((diagnostics?.survivors ?? 0) > 0) {
    return { kind: "cut", by: "host", reason: `${diagnostics!.survivors} process(es) of the case survived the host's end of its process tree` };
  }
  if (typeof diagnostics?.signal === "string" && diagnostics.signal.length > 0) {
    return { kind: "completed", exitCode: outcome.exitCode ?? 1, signal: diagnostics.signal };
  }
  if (outcome.exitCode === undefined || diagnostics?.raw_exit_code === null) {
    return { kind: "cut", by: "host", reason: "the case process ended with neither an exit status nor a signal the host could read" };
  }
  return { kind: "completed", exitCode: outcome.exitCode };
}

/**
 * Snapshot a counterexample's per-case directory (E1), below the pinned
 * scratch (S1): the directory is verified component by component from the
 * scratch root, then pinned as a root of its own whose device and inode must
 * be the verified one's, and walked from there — never through a link a
 * session placed. Written through `store`, a view capped for this execution
 * inside the observation's and the session's caps (V6).
 */
function snapshotCaseDirectory(root: SafeRoot, rel: Buffer, store: RecheckInputStore, fence: string): RecheckInputsRecord {
  if (!store.admits(1)) {
    return { reason: `over the cap on one observation's counterexample inputs (${PROPERTY_INPUT_BYTES_PER_OBSERVATION} bytes)` };
  }
  let entry: ReturnType<typeof lstatBeneath>;
  try {
    entry = lstatBeneath(root, rel, "snapshot");
  } catch (error) {
    return { reason: `the case's directory could not be read: ${message(error).slice(0, 200)}` };
  }
  if (entry === undefined || !entry.isDirectory()) return { reason: "the case's directory was not there as a directory once the case ran" };
  let pinned: SafeRoot;
  try {
    pinned = safeRoot(beneath(root.path, rel).toString(), "the property case's directory");
  } catch (error) {
    return { reason: `the case's directory could not be read: ${message(error).slice(0, 200)}` };
  }
  if (pinned.dev !== entry.dev || pinned.ino !== entry.ino) return { reason: "the case's directory changed while it was snapshotted" };
  return snapshotRecheckInputs(store, { fence, scratch: pinned.text, scratchRoot: pinned }, PROPERTY_INPUT_BOUNDS);
}

/** Everything an observation that could not run records. */
function notRun(sampleSeed: number, startedAt: number, reason: string, replay: { planned: number; overflow: number } = { planned: 0, overflow: 0 }): PropertyObservation {
  return {
    status: "not_runnable", reason, sample_seed: sampleSeed, runs: 0, sample: 0, replayed: [],
    replay_planned: replay.planned, replay_overflow: replay.overflow, stopped: "error",
    elapsed_ms: Date.now() - startedAt, case_ms: 0, counterexamples: [], translated_paths: 0,
  };
}

/** The fixture texts of a case, from its record (the recording session's
 * store for the large ones); a reason when one is not available. */
function fixtureTexts(item: LedgerCase, scratch: string): { readonly ok: true; readonly texts: readonly [string, string][] } | { readonly ok: false; readonly reason: string } {
  const files = item.files;
  if (files === undefined) return { ok: true, texts: [] };
  // D58c V5': the fixtures in the shapes the tools record (the check tool's
  // own re-check), whoever wrote the row.
  const shape = checkShapeOf({ files });
  if (!shape.ok) return { ok: false, reason: shape.reason.replace("check fields", "fixtures") };
  const texts: [string, string][] = [];
  for (const [path, recorded] of Object.entries(shape.shape.files ?? {})) {
    const safe = safeRelativePath(path);
    if (safe === undefined) return { ok: false, reason: `fixture path ${JSON.stringify(path.slice(0, CHECK_PATH_MAX))} is not relative` };
    const text = recordedText(scratch, recorded);
    if (text === undefined) return { ok: false, reason: `fixture ${safe} is not available as recorded` };
    texts.push([safe, text]);
  }
  return { ok: true, texts };
}

/**
 * Run one observation of a property (see the file comment): the recorded
 * property re-checked against the bounds, the recorded counterexamples first,
 * then the sample; before each execution the fixtures rewritten from the
 * record and a per-case directory and a capture directory made empty for it,
 * its only writable places in the scratch; each counterexample's input
 * snapshotted as soon as its case ended. Never throws.
 */
export function runProperty(input: PropertyRunInput): PropertyObservation {
  const { item } = input;
  const startedAt = Date.now();
  const replayIn = asReplay(input.replay);
  const replay = dedupe(replayIn.refs);
  const planned = replay.slice(0, PROPERTY_REPLAY_MAX);
  const overflow = Math.max(0, replayIn.overflow) + (replay.length - planned.length);
  const counts = { planned: planned.length, overflow };
  // V5: the bounds this run relies on, re-checked whoever recorded the case.
  const bounds = propertyBoundsOf(item.property);
  if (!bounds.ok) return notRun(input.sampleSeed, startedAt, bounds.reason, counts);
  const spec = bounds.property;
  if (typeof item.command !== "string" || item.command.trim() === "") return notRun(input.sampleSeed, startedAt, "the case's command is empty", counts);
  if (typeof item.id !== "string" || item.id.length === 0) return notRun(input.sampleSeed, startedAt, "the case has no id", counts);
  const scratch = input.policy.scratchRoot;
  if (scratch === undefined) {
    return notRun(input.sampleSeed, startedAt, "no session scratch space is visible to this run, so the property's per-case directories cannot be made", counts);
  }
  // S1: every host operation below is relative to the scratch as a root the
  // host pinned.
  let root: SafeRoot;
  try {
    root = safeRoot(scratch, "the session's scratch");
  } catch (error) {
    return notRun(input.sampleSeed, startedAt, error instanceof LinkSafetyError ? refusedReason("the property's scratch", error) : `the property's scratch could not be used: ${message(error).slice(0, 200)}`, counts);
  }
  const fixtures = fixtureTexts(item, scratch);
  if (!fixtures.ok) return notRun(input.sampleSeed, startedAt, fixtures.reason, counts);
  const confinedBy = confiningPolicy(input.policy, scratch);
  const checkRel = Buffer.from(`checks/${checkDirName(item.id)}`);
  const checkDir = checkDirFor(scratch, item.id);
  const area = propertyRel(item);
  const counterexamples: PropertyCounterexample[] = [];
  const replayed: PropertyCaseRef[] = [];
  // RP: the replays that did not run on their recorded input.
  const inputDiffers: PropertyInputDiffers[] = [];
  let runs = 0;
  let sample = 0;
  let stopped: PropertyStop = "cases";
  let unfinished: (PropertyCaseRef & { reason: string }) | undefined;
  let failure: string | undefined;
  let translated = 0;
  let firstInputs: RecheckInputsRecord | undefined;
  let failingInputs: RecheckInputsRecord | undefined;
  let spent = 0;
  // V6: the counterexample inputs of this observation, every byte written
  // counted, within the store's own cap.
  const observationStore = input.store.within(PROPERTY_INPUT_BYTES_PER_OBSERVATION);
  // V4: the counterexamples the model's own call keeps, put back once its
  // last execution ended.
  const kept: { readonly caseRel: Buffer; readonly index: number }[] = [];
  try {
    // The case's area, as the record makes it: whatever an earlier
    // observation (or anyone) left there is removed first, a link as the
    // link.
    removeScratchTree(confinedBy, root, area);
    ensureDirBeneath(root, area, 0o755, "write");
  } catch (error) {
    if (error instanceof LinkSafetyError) return notRun(input.sampleSeed, startedAt, refusedReason("the property's scratch", error), counts);
    return notRun(input.sampleSeed, startedAt, `the property's scratch could not be prepared: ${message(error).slice(0, 200)}`, counts);
  }
  {
    const execute = input.executor(scratch);
    const ran = new Set(planned.map(refKey));
    let ordinal = 0;
    let sampleIndex = 0;
    let replayIndex = 0;
    for (;;) {
      let ref: PropertyCaseRef;
      let fromReplay: boolean;
      if (replayIndex < planned.length) {
        ref = planned[replayIndex]!;
        replayIndex += 1;
        fromReplay = true;
      } else {
        if (sampleIndex >= spec.cases) break;
        ref = { seed: propertyCaseSeed(input.sampleSeed, sampleIndex), case: sampleIndex };
        sampleIndex += 1;
        if (ran.has(refKey(ref))) continue;
        fromReplay = false;
      }
      if (counterexamples.length >= spec.max_counterexamples) {
        stopped = "counterexamples";
        break;
      }
      // V6: the budget is the cases' own time; the wall is the run's clock.
      if (spent >= spec.time_budget_ms) {
        stopped = "time";
        break;
      }
      if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
        stopped = "wall";
        break;
      }
      // RP: a replay runs on the input its snapshot recorded, or not at all.
      let recorded: ReturnType<typeof readRestorable> | undefined;
      if (fromReplay) {
        recorded = readRestorable(replayIn.inputs?.get(refKey(ref)));
        if (!recorded.ok) {
          inputDiffers.push({ ...ref, reason: recorded.reason });
          continue;
        }
      }
      ordinal += 1;
      const caseRel = beneath(area, Buffer.from(String(ordinal)));
      const captureRel = Buffer.from(`.host/observe/${randomBytes(8).toString("hex")}`);
      try {
        // V4: the fixtures exactly as recorded — written anew for the first
        // execution, and for every later one whenever they are not byte for
        // byte the record's —, and this execution's own directories, made
        // empty for it; a replay's holding its recorded input (RP).
        if (ordinal === 1 || !fixturesIntact(root, checkRel, fixtures.texts)) writeFixtures(confinedBy, root, checkRel, fixtures.texts);
        removeScratchTrees(confinedBy, root, [caseRel]);
        if (recorded?.ok === true) {
          try {
            restoreSnapshot(root, caseRel, recorded.snapshot, recorded.store, "replay");
          } catch (error) {
            if (error instanceof LinkSafetyError) throw error;
            // Its recorded input could not be put back: the replay does not
            // run, and is not held.
            inputDiffers.push({ ...ref, reason: `its recorded input could not be restored: ${message(error).slice(0, 200)}` });
            removeScratchTrees(confinedBy, root, [caseRel]);
            continue;
          }
        } else {
          ensureDirBeneath(root, caseRel, 0o755, "write");
        }
        ensureDirBeneath(root, captureRel, 0o755, "write");
      } catch (error) {
        failure = error instanceof LinkSafetyError ? refusedReason("the case's scratch", error) : `the case's directories could not be made: ${message(error).slice(0, 200)}`;
        unfinished = { ...ref, reason: failure };
        stopped = "error";
        removeScratchTrees(confinedBy, root, [caseRel, captureRel]);
        break;
      }
      const caseDir = join(scratch, caseRel.toString());
      const captureDir = join(scratch, captureRel.toString());
      const capture = join(captureDir, "out");
      const replayFlag = fromReplay ? `export ${PROPERTY_REPLAY_ENV}=1; ` : `unset ${PROPERTY_REPLAY_ENV}; `;
      const wrap = (launched: string): string =>
        `export ${CHECK_DIR_ENV}=${shellQuote(checkDir)}; export ${PROPERTY_SEED_ENV}=${ref.seed}; export ${PROPERTY_CASE_ENV}=${ref.case}; ${replayFlag}`
        + `export ${PROPERTY_DIR_ENV}=${shellQuote(caseDir)}; ( ${launched}\n) < /dev/null > ${shellQuote(capture)} 2>&1; `
        + `__dokkabi_property_exit=$?; tail -c ${PROPERTY_OUTPUT_TAIL_BYTES} ${shellQuote(capture)}; exit $__dokkabi_property_exit`;
      const measured = Date.now();
      const executed = execute({
        ordinal,
        ref,
        wrap,
        timeoutMs: Math.max(1, spec.time_budget_ms - spent),
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        callId: `${input.callPrefix}-${ordinal}`,
        writable: [caseDir, captureDir],
      });
      spent += Math.max(0, executed.duration_ms ?? Date.now() - measured);
      const ending = propertyEnding(executed);
      let differs: string | undefined;
      try {
        translated = Math.max(translated, executed.translated_paths);
        firstInputs ??= executed.inputs;
        if (ending.kind !== "completed") {
          // Not judged: an execution that could not start, or that the host
          // cut — the budget, the wall, its output bound (V1: unknown is
          // never a verdict, and nothing more is tried).
          unfinished = { ...ref, reason: ending.reason };
          if (ending.kind === "cut" && ending.by !== "host") stopped = ending.by;
          else {
            failure = ending.reason;
            stopped = "error";
          }
        } else if (recorded?.ok === true && (differs = differingEntry(root, caseRel, recorded.snapshot)) !== undefined) {
          // RP: the replay did not run on the recorded input — whatever it
          // exited with, it is neither held nor a counterexample.
          const where = differs;
          inputDiffers.push({ ...ref, reason: `after the replay ${where}, not as its recorded input holds it (DOKKABI_PROPERTY_REPLAY=1: the directory held the recorded input; a generator must regenerate the same bytes from the seed or leave them, and the case must not change them)` });
        } else {
          runs += 1;
          if (fromReplay) replayed.push(ref);
          else sample += 1;
          if (ending.exitCode === 0 && ending.signal === undefined) {
            // Removed with the capture directory below.
          } else {
            // E1: the input the failing case left, captured now — before the
            // next case starts and before anything returns.
            const snapshot = snapshotCaseDirectory(root, caseRel, observationStore.within(PROPERTY_INPUT_BYTES_PER_EXECUTION), executed.fence);
            failingInputs ??= executed.inputs;
            const index = counterexamples.length;
            counterexamples.push({
              seed: ref.seed,
              case: ref.case,
              ...(fromReplay ? { replayed: true as const } : {}),
              exit_code: ending.exitCode,
              ...(ending.signal === undefined ? {} : { signal: ending.signal }),
              output_tail: tail(executed.outcome?.text ?? "", PROPERTY_ROW_TAIL_CHARS),
              input: snapshot,
              ...(executed.inputs === undefined ? {} : { inputs: executed.inputs }),
            });
            // The model's own call keeps it — put back from its snapshot once
            // the call's last execution ended (V4: until then no later
            // execution may read it).
            if (input.keepCounterexamples) kept.push({ caseRel, index });
          }
        }
      } finally {
        executed.release();
        // V4: out of every later execution's view — one removal inside the
        // observation's own policy (S1).
        removeScratchTrees(confinedBy, root, [caseRel, captureRel]);
      }
      if (unfinished !== undefined) break;
    }
    // The kept directories, as their snapshots hold them (E1: what each case
    // left, byte for byte), where the result says; one whose snapshot is not
    // complete is not claimed as kept.
    for (const entry of kept) {
      if (restoreKept(confinedBy, root, entry.caseRel, counterexamples[entry.index]!.input)) {
        counterexamples[entry.index] = { ...counterexamples[entry.index]!, kept: join(scratch, entry.caseRel.toString()) };
      }
    }
    if (!input.keepCounterexamples) removeScratchTrees(confinedBy, root, [area]);
  }
  const fields: PropertyFields = {
    sample_seed: input.sampleSeed,
    runs,
    sample,
    replayed,
    replay_planned: planned.length,
    replay_overflow: overflow,
    stopped,
    elapsed_ms: Date.now() - startedAt,
    case_ms: spent,
    counterexamples,
    ...(unfinished === undefined ? {} : { unfinished }),
    ...(inputDiffers.length === 0 ? {} : { input_differs: inputDiffers }),
  };
  const status = propertyVerdict(fields);
  const inputs = failingInputs ?? firstInputs;
  const shortfall = status === "not_runnable" ? propertyShortfall(fields) : undefined;
  return {
    ...fields,
    status,
    ...(status === "not_runnable"
      ? { reason: failure !== undefined && !(shortfall ?? "").includes(failure) ? `${shortfall ?? "not judged"}; ${failure}` : shortfall ?? failure ?? "not judged" }
      : {}),
    ...(status === "red" ? { exit_code: counterexamples[0]!.exit_code } : status === "green" ? { exit_code: 0 } : {}),
    ...(inputs === undefined ? {} : { inputs }),
    translated_paths: translated,
  };
}

/** The fixtures of the record, written anew (V4): whatever stands at the
 * fixture directory is removed first, a link as the link (S1). */
function writeFixtures(confinedBy: SandboxPolicy | undefined, root: SafeRoot, checkRel: Buffer, texts: readonly [string, string][]): void {
  removeScratchTrees(confinedBy, root, [checkRel]);
  ensureDirBeneath(root, checkRel, 0o755, "write");
  for (const [path, text] of texts) {
    writeBeneath(root, beneath(checkRel, Buffer.from(path)), Buffer.from(text), { mode: 0o644, parents: 0o755 });
  }
}

/** True when the fixture directory holds exactly the record's fixtures —
 * their directories, and each file with the record's bytes and mode 0644 —
 * and nothing else, read without following a link (S1). Anything else —
 * a changed, added, removed or linked entry — and the fixtures are written
 * anew before the next execution (V4). */
function fixturesIntact(root: SafeRoot, checkRel: Buffer, texts: readonly [string, string][]): boolean {
  const expected = new Map<string, Buffer | "dir">();
  for (const [path, text] of texts) {
    expected.set(path, Buffer.from(text));
    for (let parent = dirname(path); parent !== "." && parent !== "/" && parent !== ""; parent = dirname(parent)) expected.set(parent, "dir");
  }
  let seen = 0;
  let intact = true;
  try {
    const top = lstatBeneath(root, checkRel, "check");
    if (top === undefined || !top.isDirectory()) return false;
    walkBeneath(root, checkRel, (path, entry) => {
      const rel = path.subarray(checkRel.length + 1).toString();
      const want = expected.get(rel);
      seen += 1;
      if (want === undefined) intact = false;
      else if (want === "dir") {
        if (!entry.isDirectory() || entry.isSymbolicLink()) intact = false;
      } else if (!entry.isFile() || (Number(entry.mode) & 0o7777) !== 0o644 || Number(entry.size) !== want.length) {
        intact = false;
      } else {
        const bytes = readBeneath(root, path, "check");
        if (bytes === undefined || !bytes.equals(want)) intact = false;
      }
      return intact ? true : "stop";
    }, "check");
  } catch {
    return false;
  }
  return intact && seen === expected.size;
}

/**
 * Remove what stands at each of `rels` below the scratch (S1): nothing above
 * one may be a link (refused, left where it is); a link or a file there is
 * removed as itself; the directories together by ONE `rm -rf` inside
 * `policy` when it confines writes — whatever a concurrent process of the
 * session swaps in while it runs, it can remove only what the session could
 * — and whatever that left, by the host's link-safe walk. Never throws.
 */
function removeScratchTrees(policy: SandboxPolicy | undefined, root: SafeRoot, rels: readonly Buffer[]): void {
  const directories: Buffer[] = [];
  for (const rel of rels) {
    try {
      const entry = lstatBeneath(root, rel, "remove");
      if (entry === undefined) continue;
      if (entry.isDirectory()) directories.push(rel);
      else removeScratchTree(undefined, root, rel);
    } catch {
      // Refused (a link in its path): left, never followed.
    }
  }
  if (directories.length === 0) return;
  if (policy !== undefined) {
    try {
      spawnFenced(policy, `/bin/rm -rf -- ${directories.map((rel) => shellQuote(beneath(root.path, rel).toString())).join(" ")}`, 60_000);
    } catch {
      // The helper could not run: the host's own walk below.
    }
  }
  for (const rel of directories) {
    try {
      if (lstatBeneath(root, rel, "remove") !== undefined) removeTreeBeneath(root, rel, "remove");
    } catch {
      // Refused: left, never followed.
    }
  }
}

/** A recorded input's snapshot, read back for a replay (RP); why not when it
 * cannot be: none was taken, it passed the snapshot's bounds, it is gone
 * from its store or does not match its digest, or it holds an entry that
 * cannot be put back. */
function readRestorable(record: RecheckInputsRecord | undefined):
  | { readonly ok: true; readonly snapshot: RecheckInputSnapshot; readonly store: RecheckInputStore }
  | { readonly ok: false; readonly reason: string } {
  if (record === undefined) return { ok: false, reason: "no snapshot of its recorded input is known to this run, so it cannot be re-run on that input" };
  if (record.reason !== undefined) return { ok: false, reason: `its input was not snapshotted when it was recorded (${record.reason.slice(0, 160)}), so it cannot be re-run on that input` };
  if (record.bounded === "exceeded") {
    return { ok: false, reason: `its recorded input passed the snapshot's bounds (${PROPERTY_INPUT_BOUNDS.entries} entries, ${PROPERTY_INPUT_BOUNDS.bytes} bytes), so it cannot be re-run on that input` };
  }
  try {
    const { snapshot, store } = readRecheckInputs(record);
    if (snapshot.bounded !== "within") return { ok: false, reason: "its recorded input passed the snapshot's bounds, so it cannot be re-run on that input" };
    for (const entry of snapshot.entries) {
      if (entry.ns !== "scratch" || entry.path.length === 0 || entry.type === "other") {
        return { ok: false, reason: "its recorded input holds an entry that cannot be put back (neither a file, a link nor a directory)" };
      }
    }
    return { ok: true, snapshot, store };
  } catch (error) {
    return { ok: false, reason: `its recorded input cannot be read back: ${message(error).slice(0, 160)}` };
  }
}

/** Put a snapshot's entries into `caseRel`, made fresh (it must not exist):
 * its directories, its files with their bytes and modes, its links with
 * their exact targets — below the pinned scratch through real directories
 * only (S1). Throws when an entry cannot be put back. */
function restoreSnapshot(root: SafeRoot, caseRel: Buffer, snapshot: RecheckInputSnapshot, store: RecheckInputStore, operation: string): void {
  if (lstatBeneath(root, caseRel, operation) !== undefined) throw new Error("the case's directory is already there");
  ensureDirBeneath(root, caseRel, 0o700, operation);
  const dirs: { readonly rel: Buffer; readonly mode: number }[] = [];
  for (const entry of snapshot.entries) {
    if (entry.ns !== "scratch" || entry.path.length === 0) throw new Error("not an input of the case's directory");
    const at = beneath(caseRel, entry.path);
    if (entry.type === "dir") {
      ensureDirBeneath(root, at, 0o700, operation);
      dirs.push({ rel: at, mode: entry.mode });
    } else if (entry.type === "file") {
      writeBeneath(root, at, store.read(entry.sha256, entry.bytes), { mode: entry.mode, operation });
    } else if (entry.type === "link") {
      symlinkBeneath(root, at, entry.target, { operation });
    } else {
      throw new Error("an entry that is neither a file, a link nor a directory");
    }
  }
  // Deepest first, so a directory made read-only does not stop its own.
  for (const dir of dirs.reverse()) chmodBeneath(root, dir.rel, dir.mode, operation);
  chmodBeneath(root, caseRel, 0o755, operation);
}

/** The first entry of `snapshot` that does not stand in `caseRel` as
 * recorded — described — or undefined when every one does (RP): a directory
 * still a directory, a file still a regular file with the recorded bytes, a
 * link still a link with the recorded target. Paths the snapshot does not
 * name are not looked at. Read below the pinned scratch, never through a
 * link (S1). */
function differingEntry(root: SafeRoot, caseRel: Buffer, snapshot: RecheckInputSnapshot): string | undefined {
  for (const entry of snapshot.entries) {
    const at = beneath(caseRel, entry.path);
    const name = JSON.stringify(entry.path.toString().slice(0, 120));
    try {
      const now = lstatBeneath(root, at, "compare");
      if (now === undefined) return `the recorded ${entry.type} ${name} is gone`;
      if (entry.type === "dir") {
        if (!now.isDirectory()) return `the recorded directory ${name} is no longer a directory`;
      } else if (entry.type === "link") {
        if (!now.isSymbolicLink()) return `the recorded link ${name} is no longer a link`;
        if (!readLinkBeneath(root, at, "compare").equals(entry.target)) return `the recorded link ${name} leads elsewhere`;
      } else if (entry.type === "file") {
        if (!now.isFile()) return `the recorded file ${name} is no longer a regular file`;
        if (Number(now.size) !== entry.bytes) return `the recorded file ${name} has other bytes (${Number(now.size)} for ${entry.bytes} recorded)`;
        const bytes = readBeneath(root, at, "compare");
        if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return `the recorded file ${name} has other bytes`;
      } else {
        return `the recorded entry ${name} cannot be compared`;
      }
    } catch (error) {
      return `the recorded ${entry.type} ${name} could not be read: ${message(error).slice(0, 120)}`;
    }
  }
  return undefined;
}

/**
 * Put a kept counterexample's directory back below the scratch from its
 * snapshot (V4, E1), as a replay's input is (restoreSnapshot). False, and
 * nothing left, when its snapshot is not complete or the directory cannot be
 * made.
 */
function restoreKept(policy: SandboxPolicy | undefined, root: SafeRoot, caseRel: Buffer, record: RecheckInputsRecord): boolean {
  const recorded = readRestorable(record);
  if (!recorded.ok) return false;
  try {
    restoreSnapshot(root, caseRel, recorded.snapshot, recorded.store, "keep");
    return true;
  } catch {
    removeScratchTrees(policy, root, [caseRel]);
    return false;
  }
}

function dedupe(refs: readonly PropertyCaseRef[]): PropertyCaseRef[] {
  const seen = new Set<string>();
  const out: PropertyCaseRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// --- how each observation path runs one execution -------------------------------

/** The command as launched in `copyRoot`: the case's dir entered as path data
 * and every live-root spelling mapped to the copy (the base pass's rule). */
function launchIn(item: LedgerCase, liveRoots: readonly string[], copyRoot: string): { readonly text: string; readonly count: number } {
  const roots = [...new Set(liveRoots)].filter((root) => root !== copyRoot).sort((left, right) => right.length - left.length);
  let count = 0;
  const translate = (text: string): string => {
    let out = text;
    for (const root of roots) {
      const step = translateLiveRoots(out, root, copyRoot);
      out = step.text;
      count += step.count;
    }
    return out;
  };
  const command = translate(item.command.trim());
  const dir = item.dir === undefined ? undefined : translate(item.dir);
  return { text: caseLaunch(dir, command), count };
}

/** One execution's bound (V6): the budget left, tightened to the outer wall
 * right before it starts. */
function executionBound(execution: PropertyExecution): { readonly timeoutMs: number; readonly wallBound: boolean } {
  const wallLeft = execution.deadlineMs === undefined ? undefined : execution.deadlineMs - Date.now();
  const wallBound = wallLeft !== undefined && wallLeft < execution.timeoutMs;
  return { timeoutMs: Math.max(1, Math.floor(wallBound ? wallLeft! : execution.timeoutMs)), wallBound };
}

/**
 * The model's own call (D58): every execution in the live workspace itself,
 * where its bash runs, like `check` — under a policy of its own made from the
 * call's live policy (its mode, the live workspace, the session's scratch)
 * that binds the scratch read-only except the execution's own directories
 * (V4). So the call's cases share the live tree, as bash would, and never
 * the scratch.
 */
export function livePropertyExecutor(input: { readonly log: EventLog; readonly item: LedgerCase; readonly policy: SandboxPolicy }): PropertyExecute {
  const launched = caseLaunch(input.item.dir, input.item.command.trim());
  return (execution) => {
    let own: SandboxPolicy | undefined;
    const release = (): void => {
      if (own !== undefined) disposeSandboxPolicy(own);
      own = undefined;
    };
    try {
      own = createPolicy({
        mode: input.policy.mode,
        workspaceRoot: input.policy.workspaceRoot,
        log: input.log,
        ...(input.policy.scratchRoot === undefined ? {} : { scratchRoot: input.policy.scratchRoot, scratchWritable: execution.writable }),
      });
      const bound = executionBound(execution);
      const startedAt = Date.now();
      const outcome = executeTool({
        log: input.log,
        policy: own,
        mode: "live",
        call: { id: execution.callId, name: "bash", args: { command: `set -o pipefail; ${execution.wrap(launched)}` } },
        timeoutMs: bound.timeoutMs,
      });
      return { outcome, translated_paths: 0, fence: fenceOf(own), duration_ms: Date.now() - startedAt, wall_bound: bound.wallBound, release };
    } catch (error) {
      const fence = own === undefined ? "unknown" : fenceOf(own);
      release();
      return { reason: `the case's execution could not be made: ${message(error).slice(0, 200)}`, translated_paths: 0, fence, release: () => undefined };
    }
  };
}

/**
 * The host's observations (E1''): every execution on a fresh copy of `source`
 * of its own (cloneWorkspaceCopy — copy-on-write where the file system has
 * it, never hard links), a linked `.git` detached from it, under a policy of
 * its own that binds the scratch read-only except the execution's own
 * directories (V4); the copy is removed once the case is over. `prepare` runs
 * right before the command starts (the recheck overlays its verifier's files
 * there and snapshots, once per observation, what the executions run with).
 */
export function clonePropertyExecutor(input: {
  readonly log: EventLog;
  /** The tree every execution copies; never run in. */
  readonly source: string;
  readonly liveRoots: readonly string[];
  readonly item: LedgerCase;
  readonly scratch: string;
  /** Where the copies are made (the caller removes it). */
  readonly holder: string;
  readonly deadlineMs?: number;
  readonly prepare?: (copy: string, policy: SandboxPolicy) => { readonly inputs?: RecheckInputsRecord };
  /** How a copy is removed: at once by default. */
  readonly remove?: (place: string) => void;
}): PropertyExecute {
  const pristine: PristineCopy = { copy: input.source };
  const remove = input.remove ?? removeWorkspaceCopy;
  return (execution) => {
    let place: string | undefined;
    let policy: SandboxPolicy | undefined;
    const release = (): void => {
      if (policy !== undefined) disposeSandboxPolicy(policy);
      policy = undefined;
      if (place !== undefined) remove(place);
      place = undefined;
    };
    try {
      place = mkdtempSync(join(input.holder, "run-"));
      const remaining = input.deadlineMs === undefined ? undefined : input.deadlineMs - Date.now();
      const { copy } = cloneWorkspaceCopy(pristine, place, remaining);
      detachLinkedGit(copy);
      // A judged run (G3', D57h): a tool cache of this execution's policy
      // alone, emptied before and after it — never the session's.
      const own = createPolicy({
        mode: "workspace-write", workspaceRoot: copy, log: input.log, toolCache: "judged",
        scratchRoot: input.scratch, scratchWritable: execution.writable,
      });
      policy = own;
      const launched = launchIn(input.item, input.liveRoots, copy);
      const prepared = input.prepare?.(copy, own) ?? {};
      const bound = executionBound({ ...execution, ...(input.deadlineMs === undefined ? {} : { deadlineMs: Math.min(input.deadlineMs, execution.deadlineMs ?? Infinity) }) });
      const startedAt = Date.now();
      const outcome = executeTool({
        log: input.log,
        policy: own,
        mode: "live",
        call: { id: execution.callId, name: "bash", args: { command: `set -o pipefail; ${execution.wrap(launched.text)}` } },
        timeoutMs: bound.timeoutMs,
      });
      return {
        outcome, translated_paths: launched.count, fence: fenceOf(own), ...prepared,
        duration_ms: Date.now() - startedAt, wall_bound: bound.wallBound, release,
      };
    } catch (error) {
      release();
      return { reason: `the case's execution could not be made: ${message(error).slice(0, 200)}`, translated_paths: 0, fence: "unknown", release: () => undefined };
    }
  };
}

// --- rows -----------------------------------------------------------------------

/** Why the counterexample inputs a row records cannot be complete evidence
 * (E1, E1'): a counterexample with no snapshot, one over its bounds, links
 * that lead outside it, a sandbox that did not confine the case — in the
 * words a reason uses. Empty when nothing stands in the way. */
export function propertyInputGaps(fields: PropertyFields | undefined, run: string): string[] {
  if (fields === undefined) return [];
  const gaps: string[] = [];
  fields.counterexamples.forEach((item, index) => {
    for (const gap of recheckInputsGaps(item.input, `counterexample ${index + 1} of ${run}`)) gaps.push(gap);
  });
  return gaps;
}

/** The ledger rows an observation of a property is recorded on, and the case
 * id each names. */
function propertyRowCase(event: EventRecord): string | undefined {
  if (event.payload.planner !== LEDGER_PLANNER) return undefined;
  const id = event.name === "ledger/case" ? event.payload.id
    : event.name === PROPERTY_ROW || event.name === "ledger/case_probe" || event.name === "ledger/case_base" ? event.payload.case
      : undefined;
  return typeof id === "string" ? id : undefined;
}

/**
 * THE REPLAY SET (D58c L1): the counterexamples a property's next observation
 * replays first — a set folded row by row over the observations of the case
 * (its own calls, the probe, the final and base passes; the recheck folds its
 * rows the same way, replaySetStep), first recorded first:
 *
 *   - a recorded counterexample that an observation re-ran TO COMPLETION and
 *     that HELD there (in the row's `replayed`, not among its
 *     counterexamples) leaves the set — its history stays in the rows;
 *   - one that failed again, or that the observation did not re-run to
 *     completion (cut, stopped, never reached), stays where it is;
 *   - every new counterexample the row records joins it at the end.
 *
 * So the host never records more counterexamples than an observation
 * replays: every observation replays the whole set first, and the set after
 * it is (what failed again) ∪ (what it did not finish) ∪ (what is new). A run
 * that did not finish its replay never reached its sample (nothing new), and
 * one that did holds at most `max_counterexamples` failures, replayed or new —
 * so the set never grows past max(its size before, max_counterexamples), and
 * PROPERTY_MAX_COUNTEREXAMPLES_MAX ≤ PROPERTY_REPLAY_MAX keeps it within the
 * replay cap by induction. V1's overflow — recorded counterexamples an
 * observation cannot replay — is then unreachable for the rows the host
 * writes, and a property is green again after a real fix: the first
 * observation of the fixed product re-runs every recorded counterexample,
 * each holds and leaves, and the fresh sample decides.
 *
 * A log the host did not write that way (a hand-written row, rows another
 * writer interleaved) can still hold more than the cap: the set keeps every
 * one, the next observation replays the first PROPERTY_REPLAY_MAX and counts
 * the rest as `overflow` (V1: not green), and each later observation replays
 * the next ones as the earlier ones hold — never green on what it did not run,
 * never stuck.
 */
export class PropertyCounterexampleFold {
  private readonly cases = new Map<string, Map<string, PropertyReplayEntry>>();

  push(event: EventRecord): void {
    const id = propertyRowCase(event);
    if (id === undefined) return;
    const fields = propertyFieldsOf(event.payload.property);
    if (fields === undefined) return;
    let set = this.cases.get(id);
    if (set === undefined) {
      if (fields.counterexamples.length === 0) return;
      this.cases.set(id, set = new Map());
    }
    replaySetStep(set, fields);
  }

  refs(id: string): PropertyCaseRef[] {
    return this.replay(id).refs.map((ref) => ({ ...ref }));
  }

  /** What the next observation of `id` replays (at most PROPERTY_REPLAY_MAX,
   * first recorded first), and how many more the set holds (only a log the
   * host did not write can hold any, V1). */
  replay(id: string): PropertyReplay {
    return replayOfSet(this.cases.get(id));
  }

  /** How many counterexamples the set of `id` holds (L1: never more than
   * PROPERTY_REPLAY_MAX for the rows the host writes). */
  size(id: string): number {
    return this.cases.get(id)?.size ?? 0;
  }
}

/** One counterexample of a replay set: its seed and case, and the snapshot
 * of the input it was recorded with (E1), which its replays run on (RP). */
export interface PropertyReplayEntry extends PropertyCaseRef {
  readonly input?: RecheckInputsRecord;
}

/**
 * One row's step of a replay set (L1), in place: the recorded counterexamples
 * the row re-ran to completion ON THEIR RECORDED INPUT and that held leave
 * (`replayed` lists only those, RP: an `input_differs` replay stays); every
 * counterexample the row records that the set does not hold joins it at the
 * end, with the snapshot of its input — the first recorded, which every
 * later replay of it runs on. Shared by the session's fold and the
 * recheck's (recheck.ts), so both apply one rule.
 */
export function replaySetStep(set: Map<string, PropertyReplayEntry>, fields: Pick<PropertyFields, "replayed" | "counterexamples">): void {
  const failed = new Set(fields.counterexamples.map(refKey));
  for (const ref of fields.replayed) {
    const key = refKey(ref);
    if (!failed.has(key)) set.delete(key);
  }
  for (const item of fields.counterexamples) {
    const key = refKey(item);
    if (!set.has(key)) set.set(key, { seed: item.seed, case: item.case, input: item.input });
  }
}

/** What an observation of a replay set replays: its first
 * PROPERTY_REPLAY_MAX, first recorded first, how many more it holds, and the
 * recorded input of each (RP). */
export function replayOfSet(set: ReadonlyMap<string, PropertyReplayEntry> | undefined): PropertyReplay {
  if (set === undefined || set.size === 0) return { refs: [], overflow: 0 };
  const refs: PropertyCaseRef[] = [];
  const inputs = new Map<string, RecheckInputsRecord>();
  for (const entry of set.values()) {
    if (refs.length >= PROPERTY_REPLAY_MAX) break;
    refs.push({ seed: entry.seed, case: entry.case });
    if (entry.input !== undefined) inputs.set(refKey(entry), entry.input);
  }
  return { refs, overflow: set.size - refs.length, inputs };
}

/** The replay set's key of one case. */
export function propertyRefKey(ref: PropertyCaseRef): string {
  return refKey(ref);
}

/** The replay set a log leaves for a property case (the fold over every row,
 * L1): the first PROPERTY_REPLAY_MAX of it. */
export function recordedPropertyCounterexamples(events: readonly EventRecord[], id: string): PropertyCaseRef[] {
  return recordedPropertyReplay(events, id).refs.map((ref) => ({ ...ref }));
}

/** The replay set a log leaves for a property case (L1), and how many more
 * than the replay cap it holds (V1; none for the rows the host writes). */
export function recordedPropertyReplay(events: readonly EventRecord[], id: string): PropertyReplay {
  const fold = new PropertyCounterexampleFold();
  for (const event of events) fold.push(event);
  return fold.replay(id);
}

/** The text a receipt of a property observation binds: its verdict and every
 * counterexample by seed, case and exit code. */
export function propertyReceiptText(observation: PropertyObservation): string {
  return JSON.stringify({
    status: observation.status,
    sample_seed: observation.sample_seed,
    runs: observation.runs,
    counterexamples: observation.counterexamples.map((item) => [item.seed, item.case, item.exit_code]),
    ...((observation.input_differs ?? []).length === 0 ? {} : { input_differs: observation.input_differs!.map((item) => [item.seed, item.case]) }),
  });
}

/** The one receipt a host observation of a property mints (the final and
 * base passes, the probe, the recheck): the command, the tree the executions
 * were copied from before and after, the first counterexample's exit code (0
 * when the verdict is green), the verdict's text, and the last execution
 * after `seqBefore` as its execution — none when no case completed, and none
 * when the observation reached no verdict (not_runnable): a receipt is
 * judged completion evidence (V7, D57i), and an exit code of 0 there would
 * credit a property that was cut, overflowed or ran on another input as
 * green. */
export function mintPropertyReceipt(input: {
  readonly log: EventLog;
  readonly command: string;
  readonly observation: PropertyObservation;
  readonly imageBefore: string;
  readonly imageAfter: string;
  readonly seqBefore: number;
  readonly startedAt: number;
  /** What the images could not know (C1', U1): the receipt names it. */
  readonly unknown?: { readonly before: readonly string[]; readonly after: readonly string[] };
}): string | undefined {
  const { log, observation } = input;
  if (observation.runs === 0 || observation.exit_code === undefined) return undefined;
  const execRow = log.events.filter((event) => event.name === "sandbox/exec" && event.seq > input.seqBefore).at(-1);
  return mintReceipt({
    log,
    image_before: input.imageBefore,
    image_after: input.imageAfter,
    command: input.command,
    exit_code: observation.exit_code,
    stdout: propertyReceiptText(observation),
    stderr: "",
    duration_ms: Date.now() - input.startedAt,
    isolation: "live-workspace",
    digest_kind: "workspace-tree",
    exec_ref: execRow ? { seq: execRow.seq, hash: execRow.hash } : null,
    names: { result: "verify/result", receipt: "verify/receipt" },
    ...(input.unknown === undefined ? {} : { unknown: input.unknown }),
  }).id;
}

// --- the result the model reads (T3) ----------------------------------------------

/** One line that reproduces one case by hand: the seed, the case, a fresh
 * directory for its input and the fixtures exported, then the command as the
 * case launches it. */
export function propertyReproduction(item: Pick<LedgerCase, "command" | "dir">, ref: PropertyCaseRef, fixturesDir: string | undefined): string {
  const exports = [
    `${PROPERTY_SEED_ENV}=${ref.seed}`,
    `${PROPERTY_CASE_ENV}=${ref.case}`,
    `${PROPERTY_DIR_ENV}="$(mktemp -d)"`,
    ...(fixturesDir === undefined ? [] : [`${CHECK_DIR_ENV}=${shellQuote(fixturesDir)}`]),
  ];
  return `export ${exports.join(" ")}; ${caseLaunch(item.dir, item.command.trim())}`;
}

function stopText(observation: PropertyObservation, spec: LedgerProperty): string {
  switch (observation.stopped) {
    case "cases": return "every planned case ran";
    case "counterexamples": return `stopped after ${spec.max_counterexamples} counterexample(s) (max_counterexamples)`;
    case "time": return `the time budget of ${spec.time_budget_ms} ms ran out (${observation.case_ms} ms of case time)`;
    case "wall": return "the run's outer wall was reached";
    case "error": return "an execution could not be made";
  }
}

function inputText(item: PropertyCounterexample): string {
  const where = item.kept === undefined ? "" : `${item.kept} `;
  const record = item.input;
  if (record.reason !== undefined) return `${where}(not snapshotted: ${record.reason})`;
  if (record.bounded === "exceeded") return `${where}(over the snapshot's bounds of ${PROPERTY_INPUT_BOUNDS.entries} entries and ${PROPERTY_INPUT_BOUNDS.bytes} bytes; not snapshotted)`;
  const outside = (record.outside ?? 0) > 0 ? `; ${record.outside} link(s) lead outside it` : "";
  return `${where}(snapshot ${String(record.snapshot).slice(0, 12)}: ${record.entries ?? 0} entries, ${record.bytes ?? 0} bytes${outside})`;
}

/** The text a `property` call returns: the verdict, what ran, and each
 * counterexample with the line that reproduces it, where its input is and
 * the end of what it printed. NOT RUN when no case completed, NOT JUDGED when
 * some did but the run is not a verdict (V1). */
export function formatPropertyResult(input: {
  readonly item: LedgerCase;
  readonly revision: number;
  readonly observation: PropertyObservation;
  /** The fixtures directory the reproduction exports, when the case has one. */
  readonly fixturesDir?: string;
  readonly findings?: readonly { readonly check: string; readonly fact: string }[];
}): string {
  const { item, observation } = input;
  const spec = item.property!;
  const verdict = observation.status === "green" ? "HOLDS" : observation.status === "red" ? "VIOLATED" : observation.runs === 0 ? "NOT RUN" : "NOT JUDGED";
  const principle = spec.principle.length <= 300 ? spec.principle : `${spec.principle.slice(0, 300)}…`;
  const replays = observation.replayed.length > 0 ? `${observation.replayed.length} recorded counterexample(s) replayed first on their recorded input, then ` : "";
  const lines = [
    `property ${item.id}: ${verdict} (recorded as ledger case ${item.id}, revision ${input.revision})`,
    `principle: ${principle}`,
    `${observation.runs} case(s) ran in ${observation.elapsed_ms} ms: ${replays}${observation.sample} of ${spec.cases} drawn from seed ${observation.sample_seed}; ${stopText(observation, spec)}`,
  ];
  if (observation.reason !== undefined) lines.push(`why: ${observation.reason}`);
  const differs = observation.input_differs ?? [];
  if (differs.length > 0) {
    lines.push(`${differs.length} recorded counterexample(s) were not re-run on their recorded input, so none of them counts as held: `
      + `your generator is not a function of the seed (or the case changes its own input). A replay starts with ${PROPERTY_DIR_ENV} holding the recorded input and ${PROPERTY_REPLAY_ENV}=1; `
      + `generate the input from ${PROPERTY_SEED_ENV} alone (never the time, $RANDOM, the environment or the tree), regenerate the same bytes or leave them, and write outputs elsewhere or under new names.`);
    for (const item of differs.slice(0, 5)) lines.push(`  not re-run on its input: seed ${item.seed}, case ${item.case}: ${item.reason}`);
  } else if (observation.status === "not_runnable" && observation.runs > 0) {
    lines.push("A property is judged green only when every recorded counterexample was re-run to completion and held and every planned case ran; lower cases or raise time_budget_ms (it counts case execution time only) to have it judged.");
  }
  if (observation.unfinished !== undefined && observation.status === "red") {
    lines.push(`case ${observation.unfinished.case} (seed ${observation.unfinished.seed}) was stopped before it completed and is not judged: ${observation.unfinished.reason}`);
  }
  observation.counterexamples.forEach((counterexample, index) => {
    const ended = counterexample.signal === undefined ? `exit ${counterexample.exit_code}` : `exit ${counterexample.exit_code}, ended by ${counterexample.signal}`;
    lines.push(`counterexample ${index + 1}: seed ${counterexample.seed}, case ${counterexample.case}, ${ended}${counterexample.replayed === true ? " (a recorded counterexample, replayed)" : ""}`);
    lines.push(`  reproduce: ${propertyReproduction(item, counterexample, input.fixturesDir)}`);
    lines.push(`  input: ${inputText(counterexample)}`);
    const shown = tail(counterexample.output_tail.trim(), RESULT_TAIL_CHARS);
    if (shown.length > 0) lines.push(`  output: ${shown.length < counterexample.output_tail.trim().length ? "…" : ""}${shown}`);
  });
  for (const finding of input.findings ?? []) lines.push(`note (${finding.check}): ${finding.fact}`);
  return lines.join("\n");
}

/** The id and the sha256 prefix an execution's call ids start with. */
export function propertyCallPrefix(kind: string, id: string): string {
  return `${kind}-${sha256Hex(id).slice(0, 16)}`;
}
