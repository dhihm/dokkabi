import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import { appendObservedTerminal } from "../host/observation-schema.ts";
import { mintReceipt, workspaceDigest, type DigestCache } from "../host/execution-receipt.ts";
import { sessionDigestCache } from "./session-base.ts";
import { createPolicy, disposeSandboxPolicy, type SandboxPolicy } from "../host/sandbox.ts";
import { executeTool, type ToolOutcome } from "../tools/execute.ts";
import { resolveRecordedToolOutput, type RecordedOutput } from "../tools/recorded-output.ts";
import { caseLaunch } from "./case-launch.ts";
import { matchingCaseRunner } from "./case-runners.ts";
import { caseTimeoutSeconds } from "./case-timeout.ts";
import { observeLedgerCasesOnBase, observeLedgerCaseTargets, sessionChangedFiles } from "./ledger-base.ts";
import { deriveLedgerLabel, LEDGER_PLANNER, type LedgerLabelResult } from "./ledger-label.ts";
import { completeCheckRun, discardCheckRun, expectationRowFields, isCheckCase, prepareCheckRun, processTreeSurvived } from "./ledger-check.ts";
import {
  clonePropertyExecutor,
  freshSampleSeed,
  isPropertyCase,
  mintPropertyReceipt,
  propertyCallPrefix,
  propertyRowFields,
  propertyVerdict,
  recordedPropertyReplay,
  runProperty,
  sessionPropertyStore,
} from "./ledger-property.ts";
import { scratchOption } from "./ledger-probe.ts";
import { removeWorkspaceCopy } from "./workspace-copy.ts";
import { projectLedger, revisionCases, type LedgerCase } from "./plan-ledger.ts";
import { refusedOutcome, type RunnerOutcome, type RunnerResultAdapter } from "./results/contract.ts";

/** The typed stop a ledger session ended with (interfaces-v3.md §2). No stop
 * is an error by itself; the label (§4) decides what the work is worth. */
export type LedgerStopReason =
  | "finished"
  | "deadline"
  | "continue_cap"
  | "stalled"
  | "provider_failure"
  | "operator_stop";

export interface LedgerStop {
  reason: LedgerStopReason;
  /** The provider-failure class the loop observed (observedFailureReason),
   * or the sub-reason of a cap stop (rounds | max_requests). */
  detail?: string;
}

/** The model's finish claim, cited from the recorded work/finish row. */
export interface LedgerFinishSummary {
  seq: number;
  hash: string;
  summary_digest: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The single terminal call every ledger session ends with. On ANY stop the
 * host first runs every recorded ledger case once on the FINAL workspace tree
 * (§3), then — after those rows are safely recorded, so final evidence can
 * never be contaminated — observes which of each case's and guard's command
 * targets the session changed against its base (ledger-base, D26), then
 * observes every NON-GUARD case once more on a throwaway copy of the
 * workspace restored to the base commit (ledger-base), then derives the
 * terminal label from the rows that pass left behind (§4) and records
 * exactly one `work/run_result`.
 *
 * Nothing here gates: an unrecognised runner is observed by its exit code
 * rather than refused, a red case produces a gap rather than a refusal, and
 * the exit code only separates "stopped without finish" from the rest. This
 * is a library: it RETURNS the derived result (exit_code included) and never
 * touches process.exitCode or stderr — only the CLI entry point decides how
 * the process reports the run.
 */
export function concludeLedgerRun(input: {
  log: EventLog;
  workspaceRoot: string;
  stop: LedgerStop;
  finishSummary?: LedgerFinishSummary;
  /** The run's outer wall, when the caller knows one. Every case execution is
   * bounded by the time left before it: a case whose declared budget is longer
   * runs with the remaining time instead, and a case with no time left is
   * recorded unrunnable without spawning — the pass always concludes before
   * the wall instead of being killed mid-pass. Unset: the declared case budget
   * alone bounds each run, as before. */
  deadlineMs?: number;
}): LedgerLabelResult {
  // One digest cache over the session's base for the whole conclusion (C1):
  // the final pass reads the tree once, the change set reuses it.
  const cache = sessionDigestCache(input.log, input.workspaceRoot);
  observeLedgerCases(input.log, input.workspaceRoot, input.deadlineMs, cache);
  // Strictly after the final observations, still before the base pass: the
  // files each case's and guard's command points at that this session changed
  // against its base — paths and line counts only, read from the real tree,
  // never a verdict (D26). Which files changed is the host's content diff of
  // the session's base record and the tree now (C1); a session without one
  // records nothing, so the label keeps its prior rule for that recording.
  const changes = sessionChangedFiles(input.log.events, input.workspaceRoot, [input.workspaceRoot], [], cache);
  observeLedgerCaseTargets({ log: input.log, workspaceRoot: input.workspaceRoot, changes });
  // Strictly after the final observations: the base pass reads the ledger the
  // same way, works only in a copy, and never throws (LABEL-EVIDENCE C1).
  observeLedgerCasesOnBase({ log: input.log, workspaceRoot: input.workspaceRoot, deadlineMs: input.deadlineMs, changes });
  const derived = deriveLedgerLabel(input.log.events);
  // The terminal row goes through the same observed-terminal boundary every
  // other work path uses: every boot seals the observation producer schema,
  // and the replay audit then requires the run_result to carry its
  // observation checkpoint (a plain append fails "terminal lacks its
  // observation checkpoint" on replay).
  appendObservedTerminal(input.log, () => [{
    kind: "observe",
    name: "work/run_result",
    payload: {
      planner: LEDGER_PLANNER,
      stop_reason: input.stop.reason,
      ...(input.stop.detail !== undefined ? { reason: input.stop.detail } : {}),
      label: derived.label,
      finished: derived.finished,
      cases: derived.cases,
      green: derived.green,
      gaps: derived.gaps,
      open_todos: derived.open_todos,
      model_host_disagreement: derived.model_host_disagreement,
      ...(derived.green_at_base.length > 0 ? { green_at_base: derived.green_at_base } : {}),
      ...(derived.guard_tampered.length > 0 ? { guard_tampered: derived.guard_tampered } : {}),
      ...(derived.case_tampered.length > 0 ? { case_tampered: derived.case_tampered } : {}),
      ...(derived.dropped_cases !== undefined ? { dropped_cases: derived.dropped_cases } : {}),
      ...(derived.disagreement_todos.length > 0 ? { disagreement_todos: derived.disagreement_todos } : {}),
      ...(derived.workspace_image !== undefined ? { workspace_image: derived.workspace_image } : {}),
      ...(input.finishSummary !== undefined ? { finish: { seq: input.finishSummary.seq, hash: input.finishSummary.hash } } : {}),
    },
  }]);
  return derived;
}

/**
 * Run every recorded ledger case once on the final tree through the host
 * execution boundary (§3): the same `executeTool` live branch point the bash
 * tool and v1's verify step run through, followed by the same `mintReceipt`
 * pair v1 mints for a host-run case (`verify/result` + `verify/receipt`).
 *
 * v1's `executeCase` wrapper is not reused because its first act is the seal's
 * command allowlist, which refuses an unregistered runner before it runs — the
 * one thing §3 forbids here. Everything below the allowlist is shared.
 */
function observeLedgerCases(log: EventLog, workspaceRoot: string, deadlineMs: number | undefined, cache: DigestCache): void {
  const cases = ledgerCasesOf(log);
  if (cases.length === 0) return;
  // Images cover what the session's base decides (C1, D57e).
  // The anchor every observation of this pass is reported against: the tree as
  // the session left it, digested once before the first case runs.
  const finalImage = workspaceDigest(workspaceRoot, cache);
  let policy: SandboxPolicy | undefined;
  try {
    for (const item of cases) {
      // V5' (D58c): no case's data can crash the conclusion — an evaluation
      // that throws is that case's unknown, recorded with its reason, and the
      // pass goes on with the next case.
      try {
        policy ??= createPolicy({ mode: "workspace-write", workspaceRoot, log, toolCache: "judged", ...scratchOption(log, workspaceRoot) });
        observeOneCase({ log, workspaceRoot, policy, cache, finalImage, item, deadlineMs });
      } catch (error) {
        log.append({ kind: "observe", name: "ledger/case", payload: {
          id: item.id,
          planner: LEDGER_PLANNER,
          command: typeof item.command === "string" ? item.command : "",
          final_image: finalImage,
          ...(item.guard === true ? { guard: true } : {}),
          status: "red",
          image: finalImage,
          evidence: "exit_code",
          unrunnable: `the case could not be observed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
          seen_red_before_green: false,
        } });
      }
    }
  } finally {
    if (policy) disposeSandboxPolicy(policy);
  }
}

/** The recorded ledger's cases the conclusion observes (V5'): only cases a
 * row can name — objects with a text id — whatever else a hand-written graph
 * holds; a graph whose cases are not a list has none. */
function ledgerCasesOf(log: EventLog): LedgerCase[] {
  return revisionCases(projectLedger(log.events));
}

function observeOneCase(input: {
  log: EventLog;
  workspaceRoot: string;
  policy: SandboxPolicy;
  cache: DigestCache;
  finalImage: string;
  item: LedgerCase;
  /** The run's outer wall, when the caller knows one. */
  deadlineMs?: number;
}): void {
  const { log, item } = input;
  const command = typeof item.command === "string" ? item.command.trim() : "";
  const commonFields = {
    id: item.id,
    planner: LEDGER_PLANNER,
    command: item.command,
    final_image: input.finalImage,
    ...(item.guard === true ? { guard: true } : {}),
  };
  if (command === "") {
    // A structurally checked graph cannot hold this; a hand-written log can.
    log.append({ kind: "observe", name: "ledger/case", payload: {
      ...commonFields, status: "red", image: input.finalImage, evidence: "exit_code",
      unrunnable: "case command is empty", seen_red_before_green: false,
    } });
    return;
  }
  // Each run is bounded by the time left before the outer wall: a case whose
  // declared budget is longer gets the remaining time instead, and a case
  // with no time left is not spawned at all — the wall's bound is recorded as
  // the evidence, never a hang.
  const declaredMs = caseTimeoutSeconds(item) * 1_000;
  const remainingMs = input.deadlineMs === undefined ? undefined : input.deadlineMs - Date.now();
  if (remainingMs !== undefined && remainingMs <= 0) {
    log.append({ kind: "observe", name: "ledger/case", payload: {
      ...commonFields, status: "red", image: input.finalImage, evidence: "exit_code",
      unrunnable: "the run's outer wall left no time to run this case", seen_red_before_green: false,
    } });
    return;
  }
  const wallBound = remainingMs !== undefined && remainingMs < declaredMs;
  const timeoutMs = wallBound ? Math.max(1, Math.floor(remainingMs)) : declaredMs;
  // A property case (D58) is run by the property evaluator on the final
  // tree: every execution on a copy of it of its own (E1''), the recorded
  // counterexamples first, then a fresh sample; one row, one receipt.
  if (isPropertyCase(item)) {
    observeOnePropertyCase({ ...input, commonFields });
    return;
  }
  // The runner registry decides only whether a native adapter reads the
  // outcome. A command no runner claims is still run: its evidence is the
  // exit code, and the row says so (§3).
  // A `check` case (D48) is judged by its expectations through the shared
  // evaluator; no runner adapter reads it.
  const check = isCheckCase(item);
  const runner = check ? undefined : matchingCaseRunner(command);
  const adapter = runner?.resultAdapter;
  const startedAt = Date.now();
  const imageBefore = workspaceDigest(input.workspaceRoot, input.cache);
  const unknownBefore = input.cache.lastUnknown;
  // A case may name the directory its command belongs in, entered as path
  // data (case-launch.ts); the receipt still binds the case's DECLARED
  // command bytes, exactly as v1's boundary does.
  const launched = caseLaunch(item.dir, command);
  const prepared = check ? prepareCheckRun({ item, policy: input.policy, launched, treeRoot: input.workspaceRoot }) : undefined;
  if (prepared !== undefined && !prepared.ok) {
    log.append({ kind: "observe", name: "ledger/case", payload: {
      ...commonFields, status: "red", image: imageBefore, evidence: "expectations",
      unrunnable: prepared.reason, seen_red_before_green: false,
    } });
    return;
  }
  // The execution shell option only, never a rewrite of the recorded bytes:
  // every row (ledger/case, verify/receipt, runner invocations) keeps binding
  // `item.command` / `launched`, so replay of a recorded session is unchanged
  // — only the shell the host spawns honors pipefail, so a runner piped into
  // a reporter contributes its own exit code instead of the pipe's.
  const executed = `set -o pipefail; ${prepared?.ok ? prepared.run.wrapped : adapter ? adapter.command(launched) : launched}`;
  if (adapter) {
    // The ledger's runner rows carry their own names: v1's replay validates
    // every `work/runner_invocation` / `work/runner_result` against the graph
    // loop's native-runner contract (src/work/results/evidence.ts), which a
    // host observation of another planner would violate.
    log.append({ kind: "observe", name: "ledger/runner_invocation", payload: {
      command: item.command, adapter: adapter.id, adapter_digest: adapter.digest,
      executed_command_digest: sha256(executed),
    } });
  }
  const seqBefore = log.lastSeq;
  let outcome: ToolOutcome;
  try {
    outcome = executeTool({
      log,
      policy: input.policy,
      mode: "live",
      call: { id: `ledger-case-${sha256(item.id).slice(0, 16)}`, name: "bash", args: { command: executed } },
      timeoutMs,
    });
  } catch (error) {
    if (prepared?.ok) discardCheckRun(prepared.run);
    throw error;
  }
  const evaluation = prepared?.ok
    ? completeCheckRun({ run: prepared.run, exitCode: outcome.exitCode, treeRoot: input.workspaceRoot })
    : undefined;
  const imageAfter = workspaceDigest(input.workspaceRoot, input.cache);
  let receipt: string | undefined;
  if (outcome.exitCode !== undefined) {
    const execRow = log.events.filter((event) => event.name === "sandbox/exec" && event.seq > seqBefore).at(-1);
    receipt = mintReceipt({
      log,
      image_before: imageBefore,
      image_after: imageAfter,
      command: item.command,
      exit_code: outcome.exitCode,
      stdout: outcome.text,
      stderr: "",
      duration_ms: Date.now() - startedAt,
      isolation: "live-workspace",
      digest_kind: "workspace-tree",
      exec_ref: execRow ? { seq: execRow.seq, hash: execRow.hash } : null,
      names: { result: "verify/result", receipt: "verify/receipt" },
      unknown: { before: unknownBefore, after: input.cache.lastUnknown },
    }).id;
  }
  const native = adapter
    ? recordLedgerRunnerResult(log, item.id, item.command, adapter, resolveRecordedToolOutput(log, outcome))
    : undefined;
  // A run the process never completed is not a verdict on the work: it is a
  // gap the label reports, never a refusal of anything. A timeout names what
  // cut it: the wall when the remaining time was the tighter bound, the case's
  // own declared backstop otherwise.
  const unrunnable = outcome.exitCode === undefined
    ? "the case process did not complete"
    : outcome.execution?.timed_out === true
      ? wallBound
        ? "the case run was cut off by the run's outer wall"
        : "the case run reached its declared backstop"
      : outcome.execution?.completion_unavailable === true
        ? "the case run reported no completion"
        : processTreeSurvived(outcome)
          ?? evaluation?.unjudged;
  const green = unrunnable === undefined
    && (evaluation !== undefined ? evaluation.green : adapter ? native?.outcome.green === true : outcome.exitCode === 0);
  log.append({ kind: "observe", name: "ledger/case", payload: {
    ...commonFields,
    status: green ? "green" : "red",
    image: imageBefore,
    changed: imageBefore !== imageAfter,
    evidence: evaluation !== undefined ? "expectations" : adapter ? "native_result" : "exit_code",
    ...(evaluation !== undefined ? expectationRowFields(evaluation) : {}),
    ...(runner ? { runner: runner.id } : {}),
    ...(outcome.exitCode !== undefined ? { exit_code: outcome.exitCode } : {}),
    duration_ms: Date.now() - startedAt,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(native ? { runner_result_ref: native.reference } : {}),
    ...(unrunnable !== undefined ? { unrunnable } : {}),
    ...(!green && native?.outcome.reason ? { reason: native.outcome.reason } : {}),
    seen_red_before_green: green && seenRedBeforeGreen(log, item.command, imageBefore),
  } });
}

/** One property case on the final tree (D58): the tree as the session left
 * it is never run in — each execution runs on a fresh copy of it — so the
 * image before and after is the tree's own; the receipt binds the command,
 * the verdict and the last execution. */
function observeOnePropertyCase(input: {
  log: EventLog;
  workspaceRoot: string;
  policy: SandboxPolicy;
  cache: DigestCache;
  item: LedgerCase;
  deadlineMs?: number;
  commonFields: Record<string, unknown>;
}): void {
  const { log, item } = input;
  const startedAt = Date.now();
  const imageBefore = workspaceDigest(input.workspaceRoot, input.cache);
  const unknownBefore = input.cache.lastUnknown;
  const seqBefore = log.lastSeq;
  const holder = mkdtempSync(join(tmpdir(), "dokkabi-property-final-"));
  let observation: ReturnType<typeof runProperty>;
  try {
    observation = runProperty({
      item,
      policy: input.policy,
      treeRoot: input.workspaceRoot,
      // Every recorded counterexample, and how many lie past the replay cap
      // (D58b V1).
      replay: recordedPropertyReplay(log.events, item.id),
      sampleSeed: freshSampleSeed(),
      store: sessionPropertyStore(log),
      keepCounterexamples: false,
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      callPrefix: propertyCallPrefix("ledger-case", item.id),
      executor: (scratch) => clonePropertyExecutor({
        log, source: input.workspaceRoot, liveRoots: [input.workspaceRoot], item, scratch, holder,
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      }),
    });
  } finally {
    removeWorkspaceCopy(holder);
  }
  const imageAfter = workspaceDigest(input.workspaceRoot, input.cache);
  const receipt = mintPropertyReceipt({
    log, command: item.command, observation, imageBefore, imageAfter, seqBefore, startedAt,
    unknown: { before: unknownBefore, after: input.cache.lastUnknown },
  });
  // The verdict of the row's own `property` field (D58b V2): green, red, or
  // unknown — recorded, as every `ledger/case` row records unknown, as red
  // with `unrunnable`.
  const verdict = propertyVerdict(observation);
  const green = verdict === "green";
  log.append({ kind: "observe", name: "ledger/case", payload: {
    ...input.commonFields,
    status: green ? "green" : "red",
    image: imageBefore,
    changed: imageBefore !== imageAfter,
    evidence: "property",
    ...propertyRowFields(observation),
    ...(observation.exit_code !== undefined ? { exit_code: observation.exit_code } : {}),
    duration_ms: Date.now() - startedAt,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(verdict === "not_runnable" ? { unrunnable: observation.reason ?? "no case of the property completed" } : {}),
    seen_red_before_green: green && seenRedBeforeGreen(log, item.command, imageBefore),
  } });
}

/** The same row shape v1's recordRunnerResult (src/work/results/evidence.ts)
 * appends, under the ledger's own event name: v1's replay validates every
 * `work/runner_result` against the graph loop's native-runner contract (an
 * adapter allowlist of one, a surface tool/result, a recomputed outcome), so
 * this observation cannot share the row without being misread as v1
 * authority. */
function recordLedgerRunnerResult(log: EventLog, caseId: string, command: string,
  adapter: RunnerResultAdapter, recorded: RecordedOutput) {
  if (!recorded.ok && recorded.code !== "process_completion_unavailable") return undefined;
  const source = log.events.find((row) => row.seq === recorded.seq && row.hash === recorded.hash);
  const outcome = recorded.ok
    ? adapter.read(recorded.body, recorded.exitCode)
    : interruptedRunnerOutcome(source?.payload.execution);
  const event = log.append({ kind: "observe", name: "ledger/runner_result", payload: {
    case_id: caseId, command, adapter: adapter.id, adapter_digest: adapter.digest,
    result_seq: recorded.seq, result_hash: recorded.hash, outcome, evidence_level: "workspace_reported",
  } });
  return { outcome, reference: { seq: event.seq, hash: event.hash } };
}

/** The outcome a recorded-but-unfinished native run reads as; the same
 * mapping v1's recordRunnerResult applies to an interrupted process. */
function interruptedRunnerOutcome(value: unknown): RunnerOutcome {
  const execution = value as { timed_out?: boolean; signal?: string } | undefined;
  return execution?.timed_out === true
    ? refusedOutcome("incomplete", "native test process timed out")
    : typeof execution?.signal === "string"
      ? refusedOutcome("cancelled", `native test process ended with ${execution.signal}`)
      : refusedOutcome("execution_unavailable", "native test process did not complete");
}

/** An observation that strengthens trust, never a requirement (§3): this
 * command failed on an earlier image before it passed on this one. */
function seenRedBeforeGreen(log: EventLog, command: string, image: string): boolean {
  const digest = sha256(command);
  return log.events.some((event) => {
    if (event.name !== "exec/receipt" && event.name !== "verify/receipt") return false;
    return event.payload.command_digest === digest
      && event.payload.exit_code !== 0
      && event.payload.image !== image;
  });
}
