import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import { createPolicy, disposeSandboxPolicy, type SandboxPolicy } from "../host/sandbox.ts";
import { createDigestCache, mintReceipt, workspaceDigest, type DigestCache } from "../host/execution-receipt.ts";
import { writableWorldOf } from "../host/writable-world.ts";
import { sessionCoverage, sessionDigestCache } from "./session-base.ts";
import { executeTool, type ToolOutcome } from "../tools/execute.ts";
import { matchingCaseRunner } from "./case-runners.ts";
import { caseLaunch } from "./case-launch.ts";
import { caseTimeoutSeconds } from "./case-timeout.ts";
import { LEDGER_PLANNER } from "./ledger-label.ts";
import type { LedgerCase, LedgerGraph } from "./plan-ledger.ts";
import { completeCheckRun, discardCheckRun, expectationRowFields, isCheckCase, prepareCheckRun, processTreeSurvived, type CheckEvaluation } from "./ledger-check.ts";
import {
  clonePropertyExecutor,
  freshSampleSeed,
  isPropertyCase,
  livePropertyExecutor,
  propertyCallPrefix,
  propertyReceiptText,
  propertyRowFields,
  propertyVerdict,
  runProperty,
  sessionPropertyStore,
  type PropertyObservation,
} from "./ledger-property.ts";
import { liveLedger } from "./ledger-live.ts";
import { existingSessionScratch } from "./session-scratch.ts";
import { makeWorkspaceCopy, removeWorkspaceCopy, runnerOutcomeWithoutRows, translateLiveRoots } from "./workspace-copy.ts";

/**
 * The case probe (CASE-PARITY-B, G2: observe each new case once, where the
 * host will run it).
 *
 * The host learned one command shape at a time why a recorded case cannot run
 * where the host runs it — a piped runner, /tmp, a root-relative path from a
 * dir, a dir-prefixed path, an absolute live path, a missing directory, a
 * bare program — and each became a plan finding that PREDICTS a failure from
 * the command text. A prediction is either ignored or beside the point: the
 * next run hits a shape nobody predicted, and the failure only surfaces at
 * the wall, as red on both trees.
 *
 * So the host stops predicting and observes: when a case is recorded, it is
 * run once, right then, exactly as the conclusion will run it, and what
 * happened comes back with the findings.
 *
 * The rules this pass keeps, without exception:
 *   - it is observation, never a gate: the revision is already recorded when
 *     a probe runs, the probe's own outcome changes nothing, and a red probe
 *     is one finding the model may act on or ignore;
 *   - it never touches the live workspace. A case command may be destructive
 *     (`rm -rf _build`, `git stash`) and the session's work is in progress,
 *     so every probe runs in a throwaway `cp -a` copy of the CURRENT tree —
 *     no tracked-file reset, because the current tree is the point — under a
 *     policy sealed for the COPY, so CASE-PARITY-A's PATH composition finds
 *     the copy's own project environments;
 *   - it is bounded: at most `PROBE_BUDGET` probes per plan call, each at
 *     most `PROBE_TIMEOUT_CAP_SECONDS` (or the case's own shorter budget),
 *     one copy per plan call, removed afterwards;
 *   - it is a JUDGED run (V7, D57i): under a judged policy (a fresh tool
 *     cache of its own, G3') in a copy of the current tree, it mints a
 *     `verify/receipt`. A copy is never the same image as the tree it was
 *     copied from (a location covered by inode state differs in any copy),
 *     so the receipt names the LIVE image the copy was taken from — digested
 *     right before and right after the copy and equal, else nothing is
 *     named — as long as the copy is still as it was made; a green probe
 *     that left its copy unchanged is then a green receipt on the current
 *     tree for acceptV2 and the continuation line — the session's way to
 *     obtain judged evidence before the conclusion. The ledger label still reads only what the conclusion
 *     observed (`ledger/case` rows); a probe row is never a label.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** How many cases one plan call probes. The rest come back as data
 * (`not_probed: budget`) — a plan that records twenty cases must still
 * return within a tool call. */
export const PROBE_BUDGET = 4;

/** The longest one probe may run, whatever the case declares. The case's own
 * budget applies when it is shorter; a case that honestly takes minutes is
 * observed at the conclusion, not here. */
export const PROBE_TIMEOUT_CAP_SECONDS = 60;

export type CaseProbeStatus = "green" | "red" | "not_runnable" | "not_probed";

/** One probed case as the plan result reports it. `output_head` is the head
 * of the command's own combined output — the model's own text, never the
 * host's paraphrase. */
export interface CaseProbe {
  readonly case: string;
  readonly status: CaseProbeStatus;
  readonly exit_code?: number;
  readonly duration_ms?: number;
  readonly output_head?: string;
  /** Why a probe is `not_runnable`, or why it was `not_probed`. */
  readonly reason?: string;
}

/** The finding a red or not_runnable probe returns beside the recorded
 * revision: what the host saw, where it saw it, and nothing else. */
export interface CaseProbeFinding {
  readonly check: "probe_failed";
  readonly node: string;
  readonly fact: string;
}

export interface CaseProbeResult {
  readonly probes: readonly CaseProbe[];
  readonly findings: readonly CaseProbeFinding[];
}

const EMPTY: CaseProbeResult = { probes: [], findings: [] };

/** The (command, dir) identity a probe is keyed on: a case whose pair is
 * unchanged since the previous revision was already observed. */
function casePair(item: LedgerCase): string {
  return `${typeof item.command === "string" ? item.command : ""}\u0000${item.dir ?? ""}`;
}

/** The NON-GUARD cases of the newly recorded graph whose (command, dir) pair
 * is new or changed against the previously recorded revision — and, with
 * `unjudged`, every other case no judged run has observed on the current
 * tree yet (V7: a plan call after a change probes what the change may have
 * turned green). A first revision has no previous graph, so every non-guard
 * case is new. Guards are standing invariants, not the session's evidence,
 * and are never probed. */
export function casesToProbe(graph: LedgerGraph, previous: LedgerGraph | undefined, unjudged?: (item: LedgerCase) => boolean): LedgerCase[] {
  const before = new Map((previous?.cases ?? []).map((item) => [item.id, casePair(item)]));
  return graph.cases.filter((item) => {
    if (item.guard === true) return false;
    const seen = before.get(item.id);
    return seen === undefined || seen !== casePair(item) || unjudged?.(item) === true;
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where the host will run this case, said the way the model wrote it. */
function fromWhere(item: LedgerCase): string {
  const dir = typeof item.dir === "string" ? item.dir.trim() : "";
  return dir === "" || dir === "." ? "the workspace root" : dir;
}

/** The first line of what the command printed, or the reason the run never
 * produced one. */
function firstLine(output: string, reason: string | undefined): string {
  const line = output.split("\n").map((text) => text.trim()).find((text) => text.length > 0);
  return line ?? reason ?? "no output";
}

/** The session's scratch space (D48) for a policy that observes its cases:
 * the directory beside the session's log, when it exists outside the live
 * workspace. */
export function scratchOption(log: EventLog, liveRoot: string): { scratchRoot?: string } {
  const scratch = existingSessionScratch(log.path, [liveRoot]);
  return scratch === undefined ? {} : { scratchRoot: scratch };
}

/**
 * Run every new or changed non-guard case of the just-recorded revision once,
 * in one throwaway copy of the current workspace, and return what happened.
 *
 * Never throws: a copy that cannot be made records `not_runnable` for every
 * candidate, exactly as the base pass does, because a probe that cannot run
 * is unknown and unknown is never a verdict.
 */
export function probeLedgerCases(input: {
  log: EventLog;
  workspaceRoot: string;
  /** The cases to probe, in graph order (casesToProbe). */
  cases: readonly LedgerCase[];
  /** The ledger revision these cases were just recorded as. */
  revision: number;
}): CaseProbeResult {
  const { log } = input;
  if (input.cases.length === 0) return EMPTY;
  const probes: CaseProbe[] = [];
  const findings: CaseProbeFinding[] = [];
  const selected = input.cases.slice(0, PROBE_BUDGET);
  for (const item of input.cases.slice(PROBE_BUDGET)) {
    // Data, not advice and not a finding: the model is told which cases were
    // left unobserved and why.
    probes.push({ case: item.id, status: "not_probed", reason: "budget" });
  }
  const collect = (probe: CaseProbe): void => {
    probes.push(probe);
    if (probe.status !== "red" && probe.status !== "not_runnable") return;
    const item = selected.find((entry) => entry.id === probe.case)!;
    findings.push({
      check: "probe_failed",
      node: probe.case,
      fact: `run once now as the host will run it at the end (from ${fromWhere(item)}, in a copy of the current tree): `
        + `exit ${probe.exit_code ?? "none"}; ${firstLine(probe.output_head ?? "", probe.reason)}`,
    });
  };
  const notRunnableAll = (reason: string): void => {
    for (const item of selected) {
      log.append({ kind: "observe", name: "ledger/case_probe", payload: {
        planner: LEDGER_PLANNER, case: item.id, revision: input.revision,
        status: "not_runnable", duration_ms: 0, stderr_head: "", translated_paths: 0, reason,
      } });
      collect({ case: item.id, status: "not_runnable", duration_ms: 0, output_head: "", reason });
    }
  };
  const holder = mkdtempSync(join(tmpdir(), "dokkabi-ledger-probe-"));
  try {
    // The live image the copy is taken from: the same before and after the
    // copy, or the copy names none (V7).
    const liveImage = (): string | undefined => {
      try {
        return workspaceDigest(input.workspaceRoot, sessionDigestCache(log, input.workspaceRoot));
      } catch {
        return undefined;
      }
    };
    const liveBefore = liveImage();
    const copy = makeWorkspaceCopy(input.workspaceRoot, holder, undefined);
    const liveAfter = liveImage();
    const anchor = { live: liveBefore !== undefined && liveBefore === liveAfter ? liveBefore : undefined, copy: undefined as string | undefined };
    let policy: SandboxPolicy | undefined;
    // The copy's images cover what the session's base decides (C1), the
    // clock probed in the holder (F3); what the probe can write (W).
    const cache = createDigestCache(sessionCoverage(log, input.workspaceRoot), { clockDirs: [holder] });
    try {
      for (const item of selected) {
        if (policy === undefined) {
          policy = createPolicy({ mode: "workspace-write", workspaceRoot: copy, log, toolCache: "judged", ...scratchOption(log, input.workspaceRoot) });
          cache.world = writableWorldOf(copy, [policy]);
        }
        try {
          collect(probeOneCase({ log, liveRoot: input.workspaceRoot, copyRoot: copy, policy, cache, anchor, item, revision: input.revision }));
        } catch (error) {
          const reason = `the probe failed: ${message(error).slice(0, 200)}`;
          log.append({ kind: "observe", name: "ledger/case_probe", payload: {
            planner: LEDGER_PLANNER, case: item.id, revision: input.revision,
            status: "not_runnable", duration_ms: 0, stderr_head: "", translated_paths: 0, reason,
          } });
          collect({ case: item.id, status: "not_runnable", duration_ms: 0, output_head: "", reason });
        }
      }
    } finally {
      if (policy) disposeSandboxPolicy(policy);
    }
  } catch (error) {
    notRunnableAll(`the current tree could not be copied for the probe: ${message(error).slice(0, 200)}`);
  } finally {
    removeWorkspaceCopy(holder);
  }
  // Graph order, budget notes last: the probes the host ran come first.
  probes.sort((a, b) => Number(a.status === "not_probed") - Number(b.status === "not_probed"));
  return { probes, findings };
}

/** What one run of a case in a copy observed, before any row is written. */
export interface CopyObservation {
  readonly status: "green" | "red" | "not_runnable";
  readonly exit_code?: number;
  readonly duration_ms: number;
  readonly output_head: string;
  /** The command's whole combined output (what a receipt binds). */
  readonly output?: string;
  readonly reason?: string;
  readonly translated_paths: number;
  /** A `check` case's expectation results (D48). */
  readonly evaluation?: CheckEvaluation;
  /** A `property` case's run (D58). */
  readonly property?: PropertyObservation;
}

/** One property case observed on a copy (D58, E1''): every execution on a
 * fresh copy of `copyRoot` of its own, the recorded counterexamples first,
 * then a fresh sample; bounded by the property's budget and `capMs`. */
function observePropertyOnCopy(input: {
  log: EventLog;
  liveRoot: string;
  copyRoot: string;
  policy: SandboxPolicy;
  item: LedgerCase;
  capMs: number;
  callPrefix: string;
}): CopyObservation {
  const holder = mkdtempSync(join(tmpdir(), "dokkabi-property-probe-"));
  try {
    const observation = runProperty({
      item: input.item,
      policy: input.policy,
      treeRoot: input.copyRoot,
      // Read from the log's running projection: the probe rides inside a
      // `plan` call, whose cost must not grow with the session (T7). Any
      // past the replay cap keep it from being green (D58b V1).
      replay: liveLedger(input.log).propertyReplay(input.item.id),
      sampleSeed: freshSampleSeed(),
      store: sessionPropertyStore(input.log),
      keepCounterexamples: false,
      deadlineMs: Date.now() + input.capMs,
      callPrefix: propertyCallPrefix(input.callPrefix, input.item.id),
      // In place (never a host observation today) the executions run where
      // the tree is, like the model's own call; on a copy, each on its own.
      executor: (scratch) => input.liveRoot === input.copyRoot
        ? livePropertyExecutor({ log: input.log, item: input.item, policy: input.policy })
        : clonePropertyExecutor({
          log: input.log, source: input.copyRoot, liveRoots: [input.liveRoot], item: input.item, scratch, holder, deadlineMs: Date.now() + input.capMs,
        }),
    });
    const first = observation.counterexamples[0];
    return {
      // The verdict of the observation's own fields (D58b V2).
      status: propertyVerdict(observation),
      ...(observation.exit_code !== undefined ? { exit_code: observation.exit_code } : {}),
      duration_ms: observation.elapsed_ms,
      output_head: first === undefined ? "" : `counterexample seed ${first.seed} case ${first.case} exit ${first.exit_code}: ${first.output_tail.trim()}`.slice(0, 300),
      ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
      translated_paths: observation.translated_paths,
      property: observation,
    };
  } finally {
    removeWorkspaceCopy(holder);
  }
}

/**
 * Run one case once in a copy of the current tree: the dir composition,
 * pipefail and runner adapter of the conclusion's own passes, with the copy's
 * policy so the copy's project environments are on PATH (CASE-PARITY-A). A
 * `check` case (D48) is run and judged through the shared check evaluator
 * instead of the adapter. Appends only the execution rows; the caller writes
 * the observation row, and nothing here mints a receipt.
 */
export function observeCaseOnCopy(input: {
  log: EventLog;
  liveRoot: string;
  copyRoot: string;
  policy: SandboxPolicy;
  item: LedgerCase;
  /** The cap on this run, whatever the case declares. */
  timeoutCapSeconds: number;
  /** The execution call id prefix. */
  callPrefix: string;
}): CopyObservation {
  const { log, item } = input;
  const command = typeof item.command === "string" ? item.command.trim() : "";
  // A run in the live tree itself (a `check` call, D48) maps nothing.
  const inPlace = input.liveRoot === input.copyRoot;
  const translatedCommand = inPlace ? { text: command, count: 0 } : translateLiveRoots(command, input.liveRoot, input.copyRoot);
  const translatedDir = item.dir === undefined ? undefined : inPlace ? { text: item.dir, count: 0 } : translateLiveRoots(item.dir, input.liveRoot, input.copyRoot);
  const translatedPaths = translatedCommand.count + (translatedDir?.count ?? 0);
  if (command === "") {
    return { status: "not_runnable", duration_ms: 0, output_head: "", reason: "case command is empty", translated_paths: translatedPaths };
  }
  // A property case (D58) is run by the property evaluator, every execution
  // on a copy of this tree of its own, within the same cap.
  if (isPropertyCase(item)) {
    return observePropertyOnCopy({
      log, liveRoot: input.liveRoot, copyRoot: input.copyRoot, policy: input.policy, item,
      capMs: input.timeoutCapSeconds * 1_000, callPrefix: input.callPrefix,
    });
  }
  // The case's own declared budget, capped: a probe rides inside a tool call
  // the model is waiting on, so a case that honestly takes minutes is left to
  // the conclusion rather than held here.
  const timeoutMs = Math.min(caseTimeoutSeconds(item), input.timeoutCapSeconds) * 1_000;
  const check = isCheckCase(item);
  const runner = check ? undefined : matchingCaseRunner(command);
  const adapter = runner?.resultAdapter;
  const startedAt = Date.now();
  // The same launch composition both conclusion passes use: the case's dir
  // becomes a leading cd (path data, case-launch.ts), and any live-root
  // spelling was mapped to the copy.
  const launchedDir = translatedDir?.text ?? item.dir;
  const launched = caseLaunch(launchedDir, translatedCommand.text);
  const prepared = check ? prepareCheckRun({ item, policy: input.policy, launched, treeRoot: input.copyRoot }) : undefined;
  if (prepared !== undefined && !prepared.ok) {
    return { status: "not_runnable", duration_ms: 0, output_head: "", reason: prepared.reason, translated_paths: translatedPaths };
  }
  // Recorded bytes unchanged; only the executed shell honors pipefail, so a
  // piped runner contributes its own exit code here exactly as it will at the
  // conclusion.
  const body = prepared?.ok ? prepared.run.wrapped : adapter ? adapter.command(launched) : launched;
  const executed = `set -o pipefail; ${body}`;
  let outcome: ToolOutcome;
  try {
    outcome = executeTool({
      log,
      policy: input.policy,
      mode: "live",
      call: { id: `${input.callPrefix}-${sha256(item.id).slice(0, 16)}`, name: "bash", args: { command: executed } },
      timeoutMs,
    });
  } catch (error) {
    if (prepared?.ok) discardCheckRun(prepared.run);
    throw error;
  }
  const durationMs = Date.now() - startedAt;
  const evaluation = prepared?.ok
    ? completeCheckRun({ run: prepared.run, exitCode: outcome.exitCode, treeRoot: input.copyRoot })
    : undefined;
  const native = adapter ? runnerOutcomeWithoutRows(log, adapter, outcome) : undefined;
  const unrunnable = outcome.exitCode === undefined
    ? "the case process did not complete"
    : outcome.execution?.timed_out === true
      ? "timeout"
      : outcome.execution?.completion_unavailable === true
        ? "the probe run reported no completion"
        : processTreeSurvived(outcome)
          ?? evaluation?.unjudged;
  const green = unrunnable === undefined
    && (evaluation !== undefined ? evaluation.green : adapter ? native?.green === true : outcome.exitCode === 0);
  const status = unrunnable !== undefined ? "not_runnable" : green ? "green" : "red";
  // The model's own command output, head-first: the same text the host will
  // read at the conclusion, clamped to what one finding can carry.
  const outputHead = outcome.text.trim().slice(0, 300);
  const reason = unrunnable ?? (!green && native?.reason ? native.reason : undefined);
  return {
    status,
    ...(outcome.exitCode !== undefined ? { exit_code: outcome.exitCode } : {}),
    duration_ms: durationMs,
    output_head: outputHead,
    output: outcome.text,
    ...(reason !== undefined ? { reason } : {}),
    translated_paths: translatedPaths,
    ...(evaluation !== undefined ? { evaluation } : {}),
  };
}

/** One case in the copy (observeCaseOnCopy). One `ledger/case_probe` row and
 * the judged run's `verify/receipt` over the copy's images (V7). */
function probeOneCase(input: {
  log: EventLog;
  liveRoot: string;
  copyRoot: string;
  policy: SandboxPolicy;
  cache: DigestCache;
  /** The live image the copy was taken from, and the copy's image as made
   * (set by the first probe). */
  anchor: { readonly live: string | undefined; copy: string | undefined };
  item: LedgerCase;
  revision: number;
}): CaseProbe {
  const { log, item } = input;
  const startedAt = Date.now();
  const imageBefore = workspaceDigest(input.copyRoot, input.cache);
  input.anchor.copy ??= imageBefore;
  const unknownBefore = input.cache.lastUnknown;
  const seqBefore = log.lastSeq;
  const observed = observeCaseOnCopy({
    log,
    liveRoot: input.liveRoot,
    copyRoot: input.copyRoot,
    policy: input.policy,
    item,
    timeoutCapSeconds: PROBE_TIMEOUT_CAP_SECONDS,
    callPrefix: "ledger-probe-case",
  });
  const imageAfter = workspaceDigest(input.copyRoot, input.cache);
  let receipt: string | undefined;
  if (observed.exit_code !== undefined && typeof item.command === "string") {
    const execRow = log.events.filter((event) => event.name === "sandbox/exec" && event.seq > seqBefore).at(-1);
    // The copy as made holds the live image: the receipt names that image,
    // and a run that left the copy as it was leaves it named after too.
    const asMade = input.anchor.live !== undefined && imageBefore === input.anchor.copy && input.cache.lastUnknown.length === 0;
    receipt = mintReceipt({
      log,
      image_before: asMade ? input.anchor.live! : imageBefore,
      image_after: asMade && imageAfter === imageBefore ? input.anchor.live! : imageAfter,
      command: item.command,
      exit_code: observed.exit_code,
      // A property's receipt binds its verdict as the host's other
      // observations of it do (mintPropertyReceipt); it has an exit code
      // only when it reached one, red or green (D58b V1).
      stdout: observed.property !== undefined ? propertyReceiptText(observed.property) : observed.output ?? observed.output_head,
      stderr: "",
      duration_ms: Date.now() - startedAt,
      isolation: "live-workspace",
      digest_kind: "workspace-tree",
      exec_ref: execRow ? { seq: execRow.seq, hash: execRow.hash } : null,
      names: { result: "verify/result", receipt: "verify/receipt" },
      unknown: { before: unknownBefore, after: input.cache.lastUnknown },
    }).id;
  }
  log.append({ kind: "observe", name: "ledger/case_probe", payload: {
    planner: LEDGER_PLANNER, case: item.id, revision: input.revision, translated_paths: observed.translated_paths,
    status: observed.status,
    ...(observed.exit_code !== undefined ? { exit_code: observed.exit_code } : {}),
    duration_ms: observed.duration_ms,
    stderr_head: observed.output_head,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(observed.reason !== undefined ? { reason: observed.reason } : {}),
    ...(observed.evaluation !== undefined ? expectationRowFields(observed.evaluation) : {}),
    ...(observed.property !== undefined ? propertyRowFields(observed.property) : {}),
  } });
  return {
    case: item.id,
    status: observed.status,
    ...(observed.exit_code !== undefined ? { exit_code: observed.exit_code } : {}),
    duration_ms: observed.duration_ms,
    output_head: observed.output_head,
    ...(observed.reason !== undefined ? { reason: observed.reason } : {}),
  };
}

/** The longest a `check` call's own observation may run (D48): the case's
 * declared budget applies when it is shorter. */
export const CHECK_TIMEOUT_CAP_SECONDS = 300;

/**
 * A `check` call's own observation (D48): the case it just recorded, run
 * once, right then, in the LIVE workspace — exactly where the session's own
 * `bash` runs, under a workspace-write policy for that workspace that binds
 * the session's scratch — and judged by the shared check evaluator. It is the
 * model's own action, like a `bash` call: what the command writes into the
 * workspace stays there, as it would from `bash`. The launch composition is
 * the probe's (dir as a leading cd, pipefail); the host's own observations
 * (the plan probe, the final and base passes, the recheck) keep their copies.
 * One `ledger/check` row; like the probe, no receipt: the run's evidence is
 * still what the conclusion observes. Never throws.
 */
export function observeCheckNow(input: {
  log: EventLog;
  workspaceRoot: string;
  /** The policy the call runs under: workspace-write for the live
   * workspace, with the session's scratch bound. */
  policy: SandboxPolicy;
  item: LedgerCase;
  revision: number;
}): CopyObservation {
  const { log, item } = input;
  let observed: CopyObservation;
  try {
    observed = observeCaseOnCopy({
      log,
      liveRoot: input.workspaceRoot,
      copyRoot: input.workspaceRoot,
      policy: input.policy,
      item,
      timeoutCapSeconds: CHECK_TIMEOUT_CAP_SECONDS,
      callPrefix: "ledger-check",
    });
  } catch (error) {
    observed = { status: "not_runnable", duration_ms: 0, output_head: "", reason: `the check run failed: ${message(error).slice(0, 200)}`, translated_paths: 0 };
  }
  log.append({ kind: "observe", name: "ledger/check", payload: {
    planner: LEDGER_PLANNER,
    case: item.id,
    revision: input.revision,
    status: observed.status,
    ...(observed.exit_code !== undefined ? { exit_code: observed.exit_code } : {}),
    duration_ms: observed.duration_ms,
    output_head: observed.output_head,
    ...(observed.reason !== undefined ? { reason: observed.reason } : {}),
    ...(observed.evaluation !== undefined ? expectationRowFields(observed.evaluation) : {}),
  } });
  return observed;
}
