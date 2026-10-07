import { applyOperatorGoal } from "./graph.ts";
import { factorEnabled, experimentRuntime, recordCasePolicy, recordMeasurementPolicy } from "../plugins/experiment-runtime.ts";
import { clearTodo } from "./log.ts";
import { beginCaseExecution, finishCaseExecution, executionFields, decideCaseHistory, draftReference, EARNED_ROLE, type CaseExecution } from "./evidence/earned.ts";
import { assertPlanAuthority, recordAuthorityRefusal, WorkAuthorityError, retainPlanAuthority, beginPlanDraft, finishPlanDraft, modelGuardErrors } from "./evidence/authority.ts";
import { authorityCaseKey, projectObligations, type PlanDraft } from "./evidence/obligations.ts";
import type { ExecutionViews } from "../plugins/execution-view.ts";
import { activeCheckerFollowup, auditCheckerRevision, captureCheckerImage, observeCheckerImage, retainCheckerSource } from "./evidence/checker-revision.ts";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import type { WorkMeasurements } from "../loader/types.ts";
import { caseMeasurementSchema } from "./evidence/measurements.ts";
import { projectMeasurements } from "./evidence/measurement-projection.ts";
import { projectEvidence } from "./evidence/projection.ts";
import { readEvidenceBodies } from "./evidence/bodies.ts";
import { evidenceDigest } from "./evidence/contract.ts";
import { canonicalJson } from "../host/canonical.ts";
import { checkSubstrateCoverage } from "./evidence/witnesses.ts";
import type { EventRecord } from "../host/schema.ts";
import { redactText, stripTerminalControls } from "../host/redact.ts";
import { createPolicy, disposeSandboxPolicy, effectiveSandboxChildEnvironment, type SandboxPolicy } from "../host/sandbox.ts";
import { SSH_ALIAS_PATTERN } from "../host/ssh-aliases.ts";
import { executeTool, type ToolOutcome } from "../tools/execute.ts";
import { resolveRecordedToolOutput, type RecordedOutput } from "../tools/recorded-output.ts";
import { listedEntryText, mintReceipt, workspaceDigest, workspaceListing, type DigestCache } from "../host/execution-receipt.ts";
import { spawnSealedHostGit } from "../host/git-authority.ts";
import { BaseUnavailable, sessionBase, sessionDigestCache } from "./session-base.ts";
import { ancestorsOf, bytesKey, bytesOfKey, displayPath } from "./path-bytes.ts";
import type { WorkPlan } from "./schema.ts";
import type { Case } from "./schema.ts";
import { caseTodo, planCaseBatches, resolveWaveConcurrency, runWaveBatch } from "./concurrent-runner.ts";
import {
  allocateSnapshotWorktree,
  captureWorktreeSnapshot,
  releaseWorktreeSnapshot,
  type WorktreeSnapshot,
} from "../swarm/worktree.ts";
import { currentCaseEvidence, scopeWorkEvents, workCaseDigest } from "./scope.ts";
import { canClear, viewPlan } from "./view.ts";
import { isAllowedCaseCommand } from "./validate.ts";
import {
  durationShortfall,
  formatSubstrate,
  parseSubstrateReport,
  hostLabelMismatch,
  substrateMismatch,
  substrateWitnessGap,
} from "./case-substrate.ts";
import { caseLaunch } from "./case-launch.ts";
import { resourceBusyReason, unreachableHostReason, unrunnableCaseReason } from "./case-runnable.ts";
import { parseMeasuredReport, parseThresholdReport, thresholdMismatch } from "./case-thresholds.ts";
import { atCaseTimeoutCeiling, caseTimeoutSeconds, timedOutCaseReason } from "./case-timeout.ts";

/**
 * Commands this process has already watched run out the transport's ceiling,
 * keyed by the command itself, holding the reason to repeat when one returns.
 *
 * It outlives a single preflight because that is the whole point: the repair
 * loop calls preflight again for every refusal, and the expensive knowledge —
 * "this command does not finish in an hour" — belongs to the run, not to one
 * pass of it. Keyed by command so that splitting a case, or changing what it
 * runs, clears the entry by construction; nothing else is meant to.
 */
const ceilingTimeouts = new Map<string, string>();

/** Forget the ceiling record. For tests, which must not inherit each other's. */
export function forgetCeilingTimeouts(): void {
  ceilingTimeouts.clear();
}
import { planDigest } from "./digest.ts";
import { eligibleCaseSpeculationProfile, isAuthorizedCaseRecipe, matchingCaseRunner } from "./case-runners.ts";
import type { RunnerResultAdapter } from "./results/contract.ts";
import { recordRunnerResult } from "./results/evidence.ts";
import {
  inspectAuthorizedCaseSource,
  sourceDigestForAuthorizedCase,
  type AuthorizedBuildCaseRecipe,
  type AuthorizedCaseRecipe,
} from "./case-authority.ts";
export type { AuthorizedCaseRecipe } from "./case-authority.ts";
import { dependsProbeScript, lastVerdictDepends, parseDependsDigest } from "./case-depends.ts";
import { caseSignals, caseWaitDecision, type CaseSignals } from "./case-wait.ts";
import { observeTelemetry, openTelemetryLease } from "./telemetry-watchdog.ts";
import { caseBarsPath, deathSceneScript, exhaustedHostReason, writeLocalBars, formatDeathScene, harnessFailureReason, hostMemoryScript, launchScript, parseHostAvailableGb, parsePoll, pollScript, reapScript, starvedHostReason, withBarsEnv, withHostRunLock, writeBarsScript } from "./case-run-process.ts";

import { FixturePreparationError, fixtureRoot, readFixtureEnrollment } from "./evidence/fixture-manifest.ts";
import { assertPreparedFixtureEnvironment, requirePreparedFixture, type PreparedFixture } from "./evidence/fixture-prepare.ts";

export interface WorkEvaluatorError {
  readonly status: "evaluator_error";
  readonly reason_code: string;
  readonly reason: string;
}

class MeasurementRefusal extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}

/** Printed bars and substrate labels never implicitly grant attestation. */
export function caseNeedsMeasurementVerification(item: Case): boolean {
  return item.measurement !== undefined || item.thresholds !== undefined
    || item.substrate !== undefined || item.witness_for !== undefined
    || item.min_duration_ms !== undefined
    || matchingCaseRunner(item.command)?.measurementEvaluator !== undefined;
}

function assertMeasurementDeclarations(plan: WorkPlan, measurements?: WorkMeasurements): void {
  for (const item of plan.cases) {
    if (item.evidence_level !== undefined && item.evidence_level !== "workspace_reported") {
      throw new MeasurementRefusal("measurement_evidence_level_invalid", `case ${item.id}: unsupported evidence level`);
    }
    if (item.measurement === undefined) {
      if (matchingCaseRunner(item.command)?.measurementEvaluator !== undefined) {
        throw new MeasurementRefusal("measurement_contract_required", `case ${item.id}: the measurement runner requires a protected measurement contract`);
      }
      if (caseNeedsMeasurementVerification(item) && item.evidence_level !== "workspace_reported") {
        throw new MeasurementRefusal("measurement_contract_required",
          `case ${item.id}: work claims require a protected measurement contract; candidate text requires explicit workspace_reported evidence`);
      }
      continue;
    }
    const parsed = caseMeasurementSchema.safeParse(item.measurement);
    if (!parsed.success) throw new MeasurementRefusal("measurement_contract_invalid", `case ${item.id}: ${parsed.error.message}`);
    if (item.evidence_level !== undefined || item.thresholds !== undefined
      || item.witness_for !== undefined || item.min_duration_ms !== undefined) {
      throw new MeasurementRefusal("measurement_claim_modes_conflict",
        `case ${item.id}: protected measurements cannot use legacy text bars, witnesses or duration floors`);
    }
    if (item.done_when !== undefined || item.failed_when !== undefined
      || item.stall_after_ms !== undefined || item.telemetry_pattern !== undefined) {
      throw new MeasurementRefusal("measurement_execution_controls_unsupported");
    }
    if (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || item.timeout_ms <= 0 || item.timeout_ms > 30_000)) {
      throw new MeasurementRefusal("measurement_timeout_unsupported");
    }
    const uncovered = checkSubstrateCoverage(item.substrate ?? {}, parsed.data.required_axes);
    if (uncovered.length > 0) throw new MeasurementRefusal("measurement_substrate_uncovered", uncovered.join("; "));
    if (item.host !== undefined || item.dir !== undefined || item.local_accelerator === true) {
      throw new MeasurementRefusal("measurement_execution_backend_unsupported");
    }
    if (!measurements) throw new MeasurementRefusal("measurement_provider_unavailable");
    if (!matchingCaseRunner(item.command)?.measurementEvaluator) {
      throw new MeasurementRefusal("measurement_runner_unavailable");
    }
  }
}

/** Recompute the host evidence from this invocation's retained log, never its returned verdict. */
async function evaluateMeasuredCase(input: {
  log: EventLog; plan: WorkPlan; cwd: string; measurements?: WorkMeasurements;
}, item: Case, phase: "red" | "green") {
  const afterSeq = input.log.events.at(-1)?.seq ?? 0;
  // Retain the requested identity before yielding to a provider. Mutating the
  // caller's objects during evaluation cannot change the terms being judged.
  const expected = { plan_digest: evidenceDigest(input.plan), case_digest: evidenceDigest(item), phase };
  const contract = canonicalJson(item.measurement);
  const candidateFile = matchingCaseRunner(item.command)?.testFile(item.command);
  if (!candidateFile) throw new MeasurementRefusal("measurement_candidate_path_unavailable");
  const candidatePath = resolve(fixtureRoot(input.cwd), candidateFile);
  let run: Awaited<ReturnType<WorkMeasurements["evaluateCase"]>>;
  try {
    if (!input.measurements) throw new MeasurementRefusal("measurement_provider_unavailable");
    run = await input.measurements.evaluateCase({ plan: input.plan, caseId: item.id, cwd: input.cwd, phase });
  } catch (error) {
    if (error instanceof MeasurementRefusal) throw error;
    throw new MeasurementRefusal("measurement_evaluator_error");
  }
  if (run.status !== "completed") throw new MeasurementRefusal(run.reason_code);
  try {
    input.log.refresh();
    const bodies = readEvidenceBodies(input.log);
    const projection = projectMeasurements(input.log.events, bodies);
    const evidence = projectEvidence(input.log.events, bodies);
    const session = projection.sessions.find(value => value.session_id === run.session_id);
    const decision = projection.decisions.find(value => value.session_id === run.session_id);
    const result = projection.results.find(value => value.session_id === run.session_id);
    const execution = evidence.inputs.find(value => value.receipt.execution_id === session?.execution_id);
    const source = session ? bodies.get(session.candidate_source_ref) as { candidate_path?: unknown } | undefined : undefined;
    const fresh = projection.references.find(value => value.name === "measurement/session"
      && value.payload.session_id === run.session_id && value.seq > afterSeq);
    if (!session || !decision || !result || !fresh || !decision.receipt_id || !execution
      || execution.context.candidate_ref.path !== candidatePath || source?.candidate_path !== candidateFile
      || session.case_id !== item.id || canonicalJson(session.work_ref) !== canonicalJson(expected)
      || canonicalJson(session.contract) !== contract || canonicalJson(run.decision) !== canonicalJson(decision)
      || decision.receipt_id !== run.evaluation.receipt.receipt_id
      || session.execution_id !== run.evaluation.receipt.execution_id
      || canonicalJson(run.measurement_ref) !== canonicalJson(decision.result_ref)
      || evidenceDigest(input.plan) !== expected.plan_digest || evidenceDigest(item) !== expected.case_digest) {
      throw new MeasurementRefusal("measurement_result_binding_mismatch");
    }
    if (decision.status === "refused") throw new MeasurementRefusal(decision.reason_codes[0] ?? "measurement_refused");
    const policy = experimentRuntime(input.log) ? recordMeasurementPolicy(input.log, result) : undefined;
    return { decision: policy ? { ...decision, status: policy.decision.status, reason_codes: policy.decision.reason_codes } : decision, session, result, policy_ref: policy?.reference };
  } catch (error) {
    if (error instanceof MeasurementRefusal) throw error;
    throw new MeasurementRefusal("measurement_evidence_invalid");
  }
}

function measurementError(log: EventLog, error: MeasurementRefusal): WorkEvaluatorError {
  const result = { status: "evaluator_error" as const, reason_code: error.code, reason: error.message };
  log.append({ kind: "observe", name: "work/measurement_refused", payload: result });
  return result;
}

interface ManagedCasePreparation {
  readonly fixture: PreparedFixture;
  readonly policy: SandboxPolicy;
}

function ordinaryResultAdapter(log: EventLog, item: Case, prepared?: ManagedCasePreparation): RunnerResultAdapter | undefined {
  return prepared || item.host || item.local_accelerator || caseNeedsMeasurementVerification(item) || experimentRuntime(log)
    ? undefined : matchingCaseRunner(item.command)?.resultAdapter;
}

function evaluatorError(log: EventLog, error: FixturePreparationError): WorkEvaluatorError {
  const result = { status: "evaluator_error" as const, reason_code: error.code, reason: error.message };
  log.append({ kind: "observe", name: "fixture/execution", payload: result });
  return result;
}

function closeManagedPreparation(prepared: ManagedCasePreparation): void {
  try { prepared.fixture.close(); }
  finally { disposeSandboxPolicy(prepared.policy); }
}

function releaseManagedCase(preparations: Map<string, ManagedCasePreparation>, id: string): void {
  const prepared = preparations.get(id);
  if (!prepared) return;
  preparations.delete(id);
  try { prepared.fixture.assertIntegrity(); }
  catch (error) {
    if (error instanceof FixturePreparationError) throw error;
    throw new FixturePreparationError("managed_fixture_integrity_failed", String(error));
  } finally { closeManagedPreparation(prepared); }
}

function closeManagedCases(preparations: Map<string, ManagedCasePreparation>): void {
  let failure: unknown;
  for (const id of [...preparations.keys()]) {
    try { releaseManagedCase(preparations, id); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

function prepareManagedCases(input: {
  log: EventLog; plan: WorkPlan; cwd: string; run?: unknown;
}, preparations: Map<string, ManagedCasePreparation>): void {
  // Even an empty or fully settled plan must validate fixture authority before
  // its historical GREEN can cause a clear or an implementation hook can run.
  const cases = input.plan.cases.length > 0 ? input.plan.cases : [{ id: "", command: "" }];
  for (const item of cases) {
    if ("measurement" in item && item.measurement !== undefined) continue;
    const fixture = requirePreparedFixture({ log: input.log, workspace: input.cwd, command: item.command, visibility: "visible" });
    if (!fixture) continue;
    let policy: SandboxPolicy | undefined;
    try {
      if (input.run !== undefined || ("host" in item && item.host !== undefined)
        || ("local_accelerator" in item && item.local_accelerator === true)
        || ("dir" in item && item.dir !== undefined)) {
        throw new FixturePreparationError("managed_execution_backend_unsupported");
      }
      policy = createPolicy({ mode: "workspace-write", workspaceRoot: fixture.root, log: input.log, toolCache: "judged" });
      if (policy.backend === "none" || policy.disabled) throw new FixturePreparationError("managed_execution_requires_sandbox");
      preparations.set(item.id, { fixture, policy });
    } catch (error) {
      try { fixture.close(); }
      finally { if (policy) disposeSandboxPolicy(policy); }
      if (error instanceof FixturePreparationError) throw error;
      throw new FixturePreparationError("managed_sandbox_preparation_failed", String(error));
    }
  }
}

/** Validate the managed boundary before scheduling actions that skip verify. */
export function checkManagedPlanPreparation(input: {
  log: EventLog; plan: WorkPlan; cwd: string;
}): { managed: boolean; error?: WorkEvaluatorError } {
  const preparations = new Map<string, ManagedCasePreparation>();
  try {
    let managed = false;
    try { prepareManagedCases(input, preparations); managed = preparations.size > 0; }
    finally { closeManagedCases(preparations); }
    return { managed };
  } catch (error) {
    if (!(error instanceof FixturePreparationError)) throw error;
    return { managed: true, error: evaluatorError(input.log, error) };
  }
}

const CASE_AUTHORITY_SECRET = Symbol("preflight-case-authority");
const AUTHORIZED_CASE_BATCHES = new WeakMap<AuthorizedCaseBatchReceipt, readonly AuthorizedCaseRecipe[]>();
const AUTHORIZED_CASE_DISPATCHES = new WeakMap<AuthorizedCaseDispatch, Map<string, AuthorizedCaseRecipe>>();

export class AuthorizedCaseBatchReceipt {
  readonly #brand = "preflight-case-authority";

  constructor(secret: symbol) {
    if (secret !== CASE_AUTHORITY_SECRET) throw new TypeError("case authority is host-only");
  }
}

export class AuthorizedCaseDispatch {
  readonly #brand = "preflight-case-dispatch";

  constructor(secret: symbol) {
    if (secret !== CASE_AUTHORITY_SECRET) throw new TypeError("case dispatch is host-only");
  }
}

function issuePreflightCaseBatch(recipes: readonly AuthorizedCaseRecipe[]): AuthorizedCaseBatchReceipt | undefined {
  if (recipes.length === 0) return undefined;
  const receipt = new AuthorizedCaseBatchReceipt(CASE_AUTHORITY_SECRET);
  Object.freeze(receipt);
  AUTHORIZED_CASE_BATCHES.set(receipt, Object.freeze([...recipes]));
  return receipt;
}

export function consumeAuthorizedCaseDispatch(
  receipt: AuthorizedCaseBatchReceipt,
): AuthorizedCaseDispatch | undefined {
  const recipes = AUTHORIZED_CASE_BATCHES.get(receipt);
  if (!recipes) return undefined;
  AUTHORIZED_CASE_BATCHES.delete(receipt);
  const dispatch = new AuthorizedCaseDispatch(CASE_AUTHORITY_SECRET);
  Object.freeze(dispatch);
  AUTHORIZED_CASE_DISPATCHES.set(dispatch, new Map(recipes.map((recipe) => [recipe.recipeId, recipe])));
  return dispatch;
}

export function authorizedCaseRecipeIds(dispatch: AuthorizedCaseDispatch): readonly string[] {
  return Object.freeze([...(AUTHORIZED_CASE_DISPATCHES.get(dispatch)?.keys() ?? [])]);
}

export function takeBuildCase(dispatch: AuthorizedCaseDispatch, recipeId: string): AuthorizedBuildCaseRecipe | undefined {
  const recipe = AUTHORIZED_CASE_DISPATCHES.get(dispatch)?.get(recipeId);
  if (!recipe?.profile) return undefined;
  takeDispatchedCase(dispatch, recipeId);
  return Object.freeze({ ...recipe, profile: recipe.profile });
}

export function takeTier2Recipe(dispatch: AuthorizedCaseDispatch, recipeId: string): AuthorizedCaseRecipe | undefined {
  return takeDispatchedCase(dispatch, recipeId);
}

function takeDispatchedCase(dispatch: AuthorizedCaseDispatch, recipeId: string): AuthorizedCaseRecipe | undefined {
  const recipes = AUTHORIZED_CASE_DISPATCHES.get(dispatch);
  const recipe = recipes?.get(recipeId);
  if (!recipes || !recipe) return undefined;
  recipes.delete(recipeId);
  if (recipes.size === 0) AUTHORIZED_CASE_DISPATCHES.delete(dispatch);
  return recipe;
}


/**
 * The run's ending, preferring a final read that saw more than the poll did.
 * A shorter or unreadable final read means the log did not grow (or could
 * not be read) and the polled snapshot is already the ending.
 */
export function mergeFinalRead(polled: string, finalRead: string | undefined): string {
  if (!finalRead) return polled;
  return finalRead.length > polled.length ? finalRead : polled;
}


/**
 * Which measured values the verdict records.
 *
 * The first version kept the first twelve a run printed. One gate emitted
 * seventeen and the two the ledger actually judges — the latency speedups —
 * were printed last and silently dropped, so six runs read as "the gate does
 * not measure the latency bars" while it had measured them every time. A cap
 * that discards evidence must discard the least important, not the decisive:
 * every name the plan names is kept first, the rest fill what is left.
 */
export function keptMeasurements(
  measured: Record<string, number>,
  thresholds?: Readonly<Record<string, string>>,
): Record<string, number> {
  const LIMIT = 24;
  const judged = new Set(Object.keys(thresholds ?? {}));
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(measured)) {
    if (judged.has(name)) out[name] = value;
  }
  for (const [name, value] of Object.entries(measured)) {
    if (Object.keys(out).length >= LIMIT) break;
    if (!(name in out)) out[name] = value;
  }
  return out;
}

export interface VerifyResult {
  green: string[];
  red: string[];
  /** Cases that passed on their first recorded run — no RED ever existed. */
  bornGreen: string[];
  cleared: string[];
  error?: WorkEvaluatorError;
}

/**
 * The bytes failure_digest hashes: the failure's IDENTITY, not the run's.
 * Runner output carries wall-clock chatter — bun's "[21.00ms]" search line,
 * "Ran 1 test across 1 file. [811.52ms]", pytest's "1 failed in 0.12s" —
 * that differs every execution. Digesting it made an unchanged red read as
 * a moving failure, so the HEUNG no-progress fingerprint never repeated and
 * a stuck run burned max waves. Masking is confined to TIMING CONTEXTS
 * (bracketed/parenthesized durations, "in Ns", bare Nms): a bare "Ns" can
 * be an assertion value ("5s != 10s"), and masking it collapsed genuinely
 * different failures into one identity. Masking happens BEFORE the tail
 * window so digits of different widths cannot slide different bytes into
 * the last 4000 chars either.
 */
export function failureIdentityText(raw: string): string {
  return stripTerminalControls(raw)
    .replace(/\[\d+(?:\.\d+)?\s*m?s\]/g, "<duration>")
    .replace(/\(\d+(?:\.\d+)?\s*m?s\)/g, "<duration>")
    .replace(/\bin \d+(?:\.\d+)?m?s\b/g, "in <duration>")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "<duration>")
    .slice(-4000);
}

export function failureIdentityDigest(outcome: ToolOutcome): string {
  const normalized = failureIdentityText(outcome.text);
  const lines = normalized.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const assertionLines = lines.filter((line) =>
    /AssertionError|expect\(received\)|\bExpected:|\bReceived:|\bFAIL:/u.test(line));
  const errorLines = assertionLines.length > 0
    ? assertionLines
    : lines.filter((line) => /^(?:[A-Za-z]*Error\b|error:)/u.test(line)).slice(0, 3);
  const frames = lines.filter((line) =>
    /^(?:at\s|File\s+".*",\s+line\s+\d+|[^\s].*:\d+(?::\d+)?\)?$)/u.test(line)).slice(0, 3);
  const stackDigest = createHash("sha256").update(frames.join("\n")).digest("hex").slice(0, 16);
  const fallbackDigest = errorLines.length === 0 && frames.length === 0
    ? createHash("sha256").update(normalized).digest("hex").slice(0, 16)
    : undefined;
  return createHash("sha256")
    .update(JSON.stringify({
      exit_code: outcome.exitCode ?? "missing",
      assertion: errorLines.join("\n") || "missing",
      stack_digest: stackDigest,
      ...(fallbackDigest ? { fallback_digest: fallbackDigest } : {}),
    }))
    .digest("hex")
    .slice(0, 16);
}

export interface RedFailureClassification {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * The plan tools' immobility baseline (C1, D57e): HEAD, read through the
 * sealed boundary, and the state of every path tracked at the SESSION'S BASE
 * — its kind, mode and content digest as the host's own listing reads it
 * (I1), or its absence — keyed by the path's display text. Never git's
 * `diff`: the index and its flags (assume-unchanged, skip-worktree) are the
 * session's to write, and so is the configuration an unsealed git would run
 * programs from (S2).
 */
export interface TrackedChangeSnapshot {
  readonly head: string;
  readonly files: ReadonlyMap<string, string>;
  /** The paths compared (bytesKey): tracked at the session's base. */
  readonly keys: readonly string[];
  /** Why the baseline could not be taken (B1, U1): the review then refuses
   * — an unknown baseline never shows a planning session immobile. */
  readonly unknown?: string;
}

/** HEAD's commit through the sealed boundary; "" when there is none the
 * host can read. */
function sealedHead(cwd: string): string {
  try {
    const run = spawnSealedHostGit(cwd, ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { timeoutMs: 30_000 });
    const head = run.stdout.toString().trim();
    return (run.exitCode ?? 1) === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head) ? head : "";
  } catch {
    return "";
  }
}

/** One digest cache per session log for the immobility baseline and its
 * reviews: a planning session captures and reviews many times, and a file
 * whose inode state has not moved is not read again. */
const IMMOBILITY_CACHES = new WeakMap<EventLog, { readonly root: string; readonly cache: DigestCache }>();

function trackedStates(cwd: string, log: EventLog, keys?: readonly string[]): { files: Map<string, string>; keys: string[] } | { unknown: string } {
  const base = sessionBase(log, cwd);
  if (base instanceof BaseUnavailable) return { unknown: base.message };
  let listing;
  try {
    let held = IMMOBILITY_CACHES.get(log);
    if (held === undefined || held.root !== cwd) {
      held = { root: cwd, cache: sessionDigestCache(log, cwd) };
      IMMOBILITY_CACHES.set(log, held);
    }
    listing = workspaceListing(cwd, held.cache);
  } catch (error) {
    return { unknown: `the tree could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const compared = keys !== undefined ? [...keys] : [...base.tracked.keys()];
  // A tracked path the host could not know is unknown (U1): its state text
  // equals nothing, so the review refuses it.
  const unknownAbove = new Set(listing.unknown.length === 0 ? [] : [...listing.entries].filter(([, entry]) => entry.kind === "unreadable").map(([key]) => key));
  const files = new Map<string, string>();
  for (const key of compared) {
    const entry = listing.entries.get(key);
    const hidden = entry === undefined && ancestorsOf(bytesOfKey(key)).some((above) => unknownAbove.has(bytesKey(above)));
    files.set(displayPath(bytesOfKey(key)), hidden
      ? listedEntryText({ kind: "unreadable", state: "below a location the host could not know" })
      : entry === undefined ? "<deleted>" : listedEntryText(entry));
  }
  return { files, keys: compared };
}

export function captureTrackedChanges(cwd: string, log: EventLog): TrackedChangeSnapshot {
  const states = trackedStates(cwd, log);
  if ("unknown" in states) return { head: "", files: new Map(), keys: [], unknown: states.unknown };
  return { head: sealedHead(cwd), files: states.files, keys: states.keys };
}

export function reviewTrackedPlanningChanges(
  cwd: string,
  baseline: TrackedChangeSnapshot | undefined,
  log?: EventLog,
): string[] {
  if (!baseline || log === undefined) {
    return [];
  }
  if (baseline.unknown !== undefined) {
    return [`planning cannot be shown to leave tracked files unchanged: ${baseline.unknown}`];
  }
  const states = trackedStates(cwd, log, baseline.keys);
  if ("unknown" in states) {
    return [`planning cannot be shown to leave tracked files unchanged: ${states.unknown}`];
  }
  const current = { head: sealedHead(cwd), files: states.files };
  if (current.head !== baseline.head) {
    return ["planning changed repository HEAD; restore the original commit before sealing"];
  }
  const errors: string[] = [];
  const paths = new Set([...baseline.files.keys(), ...current.files.keys()]);
  for (const path of [...paths].sort()) {
    if (path === "work/current.json" || path.startsWith("work/runners/")) {
      continue;
    }
    if (baseline.files.get(path) !== current.files.get(path)) {
      errors.push(
        `planning changed tracked file ${path}; restore it and put the private RED in a new test file`,
      );
    }
  }
  return errors;
}

/**
 * A bar that only a person can clear.
 *
 * Not a filename match: what makes it unreachable is that the measurement is
 * an operator artifact rather than the product. Both marks are the same fact
 * written in the ledger -- a threshold named for an operator decision, or a
 * red that waits on one.
 */
function asksTheOperator(item: {
  command?: unknown;
  red_means?: unknown;
  green_means?: unknown;
  thresholds?: Record<string, unknown>;
}): boolean {
  const text = [item.command, item.red_means, item.green_means, ...Object.keys(item.thresholds ?? {})]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return /\boperator_decision\w*\s*>?=/i.test(text)
    || /OPERATOR_DECISION[A-Z_]*\.md/.test(text);
}

function declaresImportOrModuleRed(redMeans: string): boolean {
  const red = normalizeFailureText(redMeans);
  return /\b(importerror|modulenotfounderror|missing module|no module named|cannot import|failed to import|module not found)\b/u.test(red);
}

function isImportOrModuleNotFoundFailure(failure: string): boolean {
  const fail = normalizeFailureText(failure);
  return fail.startsWith("importerror:") || fail.startsWith("modulenotfounderror:");
}

function isImportInfrastructureFailure(failure: string, output: string): boolean {
  const combined = `${failure}\n${output}`.toLowerCase();
  if (/error(?:s)? collecting|while loading conftest|collection errors?/iu.test(combined)) {
    return true;
  }
  if (/no module named ['"](?:pytest|_pytest|unittest2|django|distutils|setuptools|pip|pluggy)['"]/iu.test(combined)) {
    return true;
  }
  if (/:\s*no module named pytest\b/iu.test(combined)) {
    return true;
  }
  return false;
}

/** Missing product-module import failures are valid RED when red_means declares them. */
function isMissingModuleImportRed(redMeans: string, failure: string, output: string): boolean {
  if (!declaresImportOrModuleRed(redMeans)) {
    return false;
  }
  if (!isImportOrModuleNotFoundFailure(failure)) {
    return false;
  }
  return !isImportInfrastructureFailure(failure, output);
}

function importFailuresInOutput(output: string): string[] {
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const match of output.matchAll(/(ImportError|ModuleNotFoundError):\s*(.+)$/gmu)) {
    const failure = `${match[1]}: ${match[2]!.trim()}`;
    if (seen.has(failure)) {
      continue;
    }
    seen.add(failure);
    failures.push(failure);
  }
  return failures;
}

function allRaisedFailures(output: string): string[] {
  const merged = [...raisedFailures(output), ...importFailuresInOutput(output)];
  const seen = new Set<string>();
  return merged.filter((failure) => {
    if (seen.has(failure)) {
      return false;
    }
    seen.add(failure);
    return true;
  });
}

/** Anchored to unittest's ACTUAL failure formats, case-sensitive — a bun
 * or npm "error:" banner must never read as a unittest witness (PR #96
 * review H4). */
function hasUnittestErrorWitness(output: string): boolean {
  return /^ERROR: \S|\.\.\. ERROR\b/mu.test(output);
}

function hasBunInfrastructureDiagnostic(output: string): boolean {
  return /^(?:[ \t]*error:[ \t]+)+(?:Module not found\b.*|An internal error occurred \((?:CouldntReadCurrentDirectory|PermissionDenied)\))[ \t]*$/imu
    .test(output) ||
    /^[ \t]*error loading current directory[ \t]*$/imu.test(output) ||
    /^[ \t]*error:[ \t]+Cannot read (?:file|directory) "[^"]+": [A-Za-z][A-Za-z0-9_]*[ \t]*$/imu.test(output);
}

function missingModuleRedFromOutput(redMeans: string, output: string): boolean {
  if (/error(?:s)? collecting|while loading conftest|collection errors?/iu.test(output)) {
    return false;
  }
  let sawImportRed = false;
  for (const failure of allRaisedFailures(output)) {
    if (isMissingModuleImportRed(redMeans, failure, output)) {
      sawImportRed = true;
      continue;
    }
    // A NAMED failure that is not the declared missing-module import —
    // another exception class, or import infrastructure — is evidence
    // AGAINST a missing module. The ERROR-witness and presumed fallbacks
    // exist for outputs with NO named exception (lazy setUp imports,
    // truncated runners); they must never launder a contradicting named
    // failure into a valid RED (main regression: TemplateSyntaxError).
    return false;
  }
  if (sawImportRed) {
    return true;
  }
  // Absence of evidence is not a witness (constitution 6): empty or
  // stalled output never presumes a RED — pick #88 intended it, honesty
  // forbids it (PR #96 review M1).
  return hasUnittestErrorWitness(output);
}

/** Inspect nested process diagnostics only to refuse evidence, never to create
 * assertion authority from arbitrary serialized output. */
function nestedExecutionRefusal(output: string): string | undefined {
  const queue = [{ text: output, depth: 0 }];
  let inspected = 0;
  const limit = Math.max(output.length * 4, 65536);
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index]!;
    inspected += item.text.length;
    if (inspected > limit || index >= 64 || item.depth > 8) return "nested execution diagnostics exceed their bound";
    const text = stripTerminalFormatting(item.text);
    if (/^(?:error: )?Seatbelt startup attestation failed:|^sandbox-exec:|^bwrap: (?:.*(?:Operation not permitted|Permission denied|No such file))/mu.test(text)) {
      return "test execution infrastructure failed";
    }
    if (hasBunInfrastructureDiagnostic(text)) return "test setup or resolution failed";
    if (/ERROR(?:S)? collecting|error during collection|collection errors?/iu.test(text)) return "test collection failed";
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("{")) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row !== "object" || row === null) continue;
      const process = row as Record<string, unknown>;
      if (!["child_exit", "exit_code", "exitCode", "returncode"].some(key => key in process)) continue;
      if (process.signal || process.signalCode || process.error || process.timed_out === true) return "nested runner did not complete";
      for (const key of ["stdout", "stderr"]) {
        if (typeof process[key] === "string") queue.push({ text: process[key], depth: item.depth + 1 });
      }
    }
  }
  return undefined;
}

export function classifyRedFailure(output: string, redMeans?: string): RedFailureClassification {
  const executionRefusal = nestedExecutionRefusal(output);
  if (executionRefusal) return { valid: false, reason: executionRefusal };
  output = stripTerminalFormatting(output);
  if (/ERROR(?:S)? collecting|error during collection|collection errors?/iu.test(output)) {
    return { valid: false, reason: "test collection failed" };
  }
  if (/Ran 0 tests|no tests ran|collected 0 items/iu.test(output)) {
    return { valid: false, reason: "runner executed no tests" };
  }
  if (hasBunInfrastructureDiagnostic(output)) {
    return { valid: false, reason: "test setup or resolution failed" };
  }
  const raised = allRaisedFailures(output);
  const undeclared = [...raised].reverse().find((failure) => !redMeans || !describesObservedValue(redMeans, failure));
  if (undeclared) {
    if (redMeans && missingModuleRedFromOutput(redMeans, output)) {
      return { valid: true };
    }
    return {
      valid: false,
      reason: redMeans
        ? `test raised ${undeclared}, which red_means does not describe`
        : "runner reported test errors",
    };
  }
  const bunAssertion = bunAssertionEnvelope(output);
  if (bunAssertion?.kind === "invalid") {
    return { valid: false, reason: bunAssertion.reason };
  }
  if (/AssertionError|\bFAIL:|expect\(received\)|\bExpected:/u.test(output) || bunAssertion?.kind === "valid") {
    // Pytest renders a source expression after a custom AssertionError:
    //
    //   E AssertionError: evidence snapshot ... missing
    //   E assert None is not None
    //
    // The custom message is the product RED. Requiring red_means to also
    // contain the generic sentinel (`None`) rejects an accurately declared
    // failure and traps HEUNG in planning repair. Keep operand integrity for
    // bare assertions, but prefer a matching explicit assertion message.
    const declaredMessage = bunAssertion === undefined && redMeans !== undefined && assertionFailureMessages(output)
      .some((message) => describesAssertionMessage(redMeans, message));
    const undeclaredObserved = declaredMessage
      ? undefined
      : (bunAssertion?.kind === "valid" ? bunAssertion.observedValues : assertionObservedValues(output))
        .find((value) => redMeans && !describesObservedValue(redMeans, value));
    if (undeclaredObserved) {
      return {
        valid: false,
        reason: `assertion observed ${undeclaredObserved}, which red_means does not describe`,
      };
    }
    return { valid: true };
  }
  if (raised.length > 0) {
    return { valid: true };
  }
  if (/FAILED \([^)]*\berrors?=\d+/iu.test(output)) {
    if (redMeans && missingModuleRedFromOutput(redMeans, output)) {
      return { valid: true };
    }
    return { valid: false, reason: "runner reported test errors" };
  }
  if (
    /# Unhandled error between tests|(?:SyntaxError|ImportError|ModuleNotFoundError|TemplateSyntaxError|ImproperlyConfigured):|(?:test|module).*(?:not found|does not exist)/iu.test(
      output,
    )
  ) {
    if (redMeans && missingModuleRedFromOutput(redMeans, output)) {
      return { valid: true };
    }
    return { valid: false, reason: "test setup or resolution failed" };
  }
  if (redMeans && missingModuleRedFromOutput(redMeans, output)) {
    return { valid: true };
  }
  return { valid: false, reason: "runner exited without assertion or declared exception evidence" };
}

/** Diagnostic data for one repair, never evidence admission. Only complete
 * supported Bun frames may expose their missing concrete operands. */
function bunRedRepairOperands(output: string, redMeans: string): string | undefined {
  if (!classifyRedFailure(output).valid) return undefined;
  const envelope = bunAssertionEnvelope(output);
  if (envelope?.kind !== "valid") return undefined;
  const missing = envelope.observedValues.filter(value => !describesObservedValue(redMeans, value));
  if (!missing.length || missing.length > 128) return undefined;
  const encoded = JSON.stringify(missing);
  return encoded.length <= 16_384 ? encoded : undefined;
}

/** Strict implementations must reproduce their declared cause. Authorized
 * first-pass roles can observe any real assertion failure, while still using
 * declared product exceptions and preserving precise infrastructure refusals. */
function classifyCaseFailure(output: string, item: Case, plan: WorkPlan): RedFailureClassification {
  const described = classifyRedFailure(output, item.red_means);
  if (described.valid || (!item.guard && plan.require_red_first === true)) return described;
  const observed = classifyRedFailure(output);
  return observed.valid ? observed : described;
}

type BunAssertionEnvelope = {
  readonly kind: "valid";
  readonly observedValues: readonly string[];
} | {
  readonly kind: "invalid";
  readonly reason: string;
};

function bunAssertionEnvelope(output: string): BunAssertionEnvelope | undefined {
  const plain = stripTerminalFormatting(output);
  const hasBunHeader = /^bun test v\d+\.\d+\.\d+\b/mu.test(plain);
  if (!hasBunHeader) {
    return undefined;
  }
  const errorHeadline = /^error:\s+(.+)$/mu.exec(plain)?.[1]?.trim();
  const hasAssertionDiagnostic = (errorHeadline !== undefined && /expect\(received\)/u.test(errorHeadline)) ||
    /^\s*Received(?::| value:| function )/mu.test(plain) ||
    /^\+ Received\s+\+/mu.test(plain);
  if (!hasAssertionDiagnostic) {
    return undefined;
  }
  if (!errorHeadline) {
    return { kind: "invalid", reason: "Bun assertion envelope is incomplete" };
  }
  // Bun may omit source excerpts or carets. Closed diagnostic frames, received
  // values and matching terminal counts below carry the assertion evidence.
  const completeFrame = /^\(fail\) .+$/mu.test(plain);
  if (!completeFrame) {
    return { kind: "invalid", reason: "Bun assertion envelope is incomplete" };
  }
  const observed = bunObservedValues(plain);
  if (!observed.supported || observed.values.length === 0 ||
    !Number.isInteger(observed.terminalFailCount) || observed.terminalFailCount < 1 ||
    !Number.isInteger(observed.terminalExpectCount) || observed.terminalExpectCount < 1 ||
    observed.rootFrameCount !== observed.terminalFailCount) {
    return { kind: "invalid", reason: "Bun assertion envelope has no supported received evidence" };
  }
  return { kind: "valid", observedValues: observed.values };
}

function bunObservedValues(output: string): {
  readonly values: readonly string[];
  readonly supported: boolean;
  readonly rootFrameCount: number;
  readonly terminalFailCount: number;
  readonly terminalExpectCount: number;
} {
  const values: string[] = [];
  let supported = true;
  let rootFrameCount = 0;
  let terminalFailCount: number | undefined;
  let terminalExpectCount: number | undefined;
  const stack: string[][] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (/^error:\s+.+$/u.test(line)) {
      if (stack.length === 0 && (terminalFailCount !== undefined || terminalExpectCount !== undefined)) {
        supported = false;
      }
      stack.push([]);
      continue;
    }
    if (/^\(fail\) .+$/u.test(line)) {
      const block = stack.pop();
      if (!block) {
        supported = false;
        continue;
      }
      const observed = bunObservedBlock(block.join("\n"));
      values.push(...observed.values);
      if (!observed.supported) supported = false;
      if (stack.length === 0) rootFrameCount += 1;
      continue;
    }
    if (stack.length === 0 && rootFrameCount > 0) {
      const failSummary = /^\s*(\d+) fail\s*$/u.exec(line)?.[1];
      if (failSummary !== undefined) {
        if (terminalFailCount !== undefined) supported = false;
        terminalFailCount = Number(failSummary);
        continue;
      }
      const expectSummary = /^\s*(\d+) expect\(\) calls\s*$/u.exec(line)?.[1];
      if (expectSummary !== undefined) {
        if (terminalExpectCount !== undefined) supported = false;
        terminalExpectCount = Number(expectSummary);
        continue;
      }
    }
    const current = stack.at(-1);
    if (current) current.push(line);
  }
  return {
    values: [...new Set(values.filter(Boolean))],
    supported: supported && stack.length === 0 && rootFrameCount > 0,
    rootFrameCount,
    terminalFailCount: terminalFailCount ?? Number.NaN,
    terminalExpectCount: terminalExpectCount ?? Number.NaN,
  };
}

function bunObservedBlock(block: string): {
  readonly values: readonly string[];
  readonly supported: boolean;
} {
  const values: string[] = [];
  let supported = true;
  const lines = block.split(/\r?\n/u);
  const summaries = lines.flatMap((line, index) => {
    const count = /^\+ Received\s+\+\s+(\d+)\s*$/u.exec(line)?.[1];
    return count === undefined ? [] : [{ count: Number(count), index }];
  });
  const addedIndices = lines.flatMap((line, index) =>
    /^\+\s+(.+)$/u.test(line) && !/^\+ Received\s+\+\s+\d+\s*$/u.test(line) ? [index] : []
  );
  let structuralStart = -1;
  let structuralEnd = -1;
  if (summaries.length === 1) {
    const summary = summaries[0];
    if (summary !== undefined) {
      const expectedSummary = lines[summary.index - 1];
      if (expectedSummary === undefined || !/^- Expected\s+-\s+\d+\s*$/u.test(expectedSummary)) {
        supported = false;
      } else {
        structuralEnd = summary.index - 1;
        while (structuralEnd > 0 && lines[structuralEnd - 1]?.trim() === "") structuralEnd -= 1;
        structuralStart = structuralEnd;
        while (structuralStart > 0 && lines[structuralStart - 1]?.trim() !== "") structuralStart -= 1;
      }
    }
  } else if (summaries.length > 1 || addedIndices.length > 0) {
    supported = false;
  }
  if (addedIndices.some((index) => index < structuralStart || index >= structuralEnd)) {
    supported = false;
  }
  let structuralPayloadLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const received = /^\s*Received(?: value)?:\s*(.+)$/u.exec(line)?.[1] ??
      /^\s*Received (function .+)$/u.exec(line)?.[1];
    if (received) {
      values.push(stripRepresentation(received));
      continue;
    }
    if (index < structuralStart || index >= structuralEnd) continue;
    const added = /^\+\s+(.+)$/u.exec(line)?.[1]?.trim();
    if (!added) continue;
    structuralPayloadLines += 1;
    const normalized = added.replace(/,$/u, "");
    if (/^[\[\]{}]$/u.test(normalized)) {
      continue;
    }
    const member = /^"([^"]+)":\s*(.+)$/u.exec(normalized);
    if (member?.[1] && member[2]) {
      values.push(member[1]);
      if (!/^(?:\{|\[)$/u.test(member[2])) {
        const literal = bunObservedLiteral(member[2]);
        if (literal === undefined) supported = false;
        else values.push(literal);
      }
      continue;
    }
    const literal = bunObservedLiteral(normalized);
    if (literal !== undefined) {
      values.push(literal);
      continue;
    }
    const multiline = bunMultilineObservedLiteral(lines.slice(0, structuralEnd), index, normalized);
    if (multiline === undefined) {
      supported = false;
    } else {
      values.push(multiline.value);
      index = multiline.lastLine;
    }
  }
  const summary = summaries[0];
  if (summary !== undefined) {
    const declaredPayloadLines = summary.count;
    if (!Number.isInteger(declaredPayloadLines) || declaredPayloadLines < 1 ||
      declaredPayloadLines !== structuralPayloadLines) {
      supported = false;
    }
  }
  return { values, supported: supported && values.length > 0 };
}

function bunMultilineObservedLiteral(
  lines: readonly string[],
  startLine: number,
  opening: string,
): { readonly value: string; readonly lastLine: number } | undefined {
  const quote = opening[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const parts = [opening.slice(1)];
  for (let index = startLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) return undefined;
    const continuation = /^ {2}(.*)$/u.exec(line)?.[1];
    if (continuation === undefined) return undefined;
    if (continuation === quote) {
      return { value: parts.join("\n"), lastLine: index };
    }
    parts.push(continuation);
  }
  return undefined;
}

function bunObservedLiteral(value: string): string | undefined {
  // Bun's pretty printer is display text, not JSON: it wraps a received string
  // in quotes again without escaping interior quotes. Within the structurally
  // authenticated hunk the outer delimiter pair bounds the value, and the
  // interior bytes stay verbatim rather than being decoded as escapes.
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.at(-1) === quote) {
    return stripRepresentation(value);
  }
  if (/^(?:true|false|null|undefined|-?\d+(?:\.\d+)?)$/u.test(value) || value === "[]" || value === "{}") {
    return value;
  }
  return undefined;
}

function stripTerminalFormatting(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function assertionFailureMessages(output: string): string[] {
  const plain = stripTerminalFormatting(output);
  return [...plain.matchAll(/^[ \t]*(?:E[ \t]+)?AssertionError:[ \t]*(.+)$/gmu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function describesAssertionMessage(redMeans: string, observed: string): boolean {
  const stripName = (value: string): string => normalizeFailureText(value)
    .replace(/^assertionerror:\s*/u, "");
  const description = stripName(redMeans);
  const witness = stripName(observed);
  // A test may append bounded diagnostics such as `; saw: ...` to a stable
  // contract message. The stable declared prefix is sufficient evidence,
  // while short generic descriptions remain subject to operand inspection.
  return description.length >= 12 &&
    (witness.startsWith(description) || description.includes(witness));
}

function raisedFailures(output: string): string[] {
  const matches = [...output.matchAll(
    /^([A-Za-z_][\w.]*(?:Error|Exception)|ImproperlyConfigured):\s*(.+)$/gmu,
  )].filter((match) => match[1] !== "AssertionError");
  return matches.flatMap((match) => {
    const after = output.slice((match.index ?? 0) + match[0].length);
    const next = after.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
    if (
      next.startsWith("During handling of the above exception") ||
      next.startsWith("The above exception was the direct cause")
    ) {
      return [];
    }
    return match[1] && match[2]
      ? [`${match[1]}: ${match[2].trim()}`]
      : [];
  });
}

function assertionObservedValues(output: string): string[] {
  const plain = stripTerminalFormatting(output);
  const python = /AssertionError:\s*(.+?)\s*!=\s*(.+?)(?:\r?\n|$)/u.exec(plain);
  if (python?.[1] && python[2]) {
    return [stripRepresentation(python[1]), stripRepresentation(python[2])];
  }
  const received = /^\s*Received:\s*(.+)$/imu.exec(plain);
  if (received?.[1]) {
    return [stripRepresentation(received[1])];
  }
  const pytest = /^\s*E\s+assert\s+(.+?)\s+(?:==|!=|is|in|>=|<=|>|<)\s+.+$/imu.exec(plain);
  if (pytest?.[1]) {
    return [stripRepresentation(pytest[1])];
  }
  const rust = /^\s*left:\s*(.+)$/imu.exec(plain);
  if (rust?.[1] && /^\s*right:/imu.test(plain)) {
    return [stripRepresentation(rust[1])];
  }
  const go = /\bgot\s+(.+?),\s*want\s+.+(?:\r?\n|$)/iu.exec(plain);
  return go?.[1] ? [stripRepresentation(go[1])] : [];
}

function stripRepresentation(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return trimmed.length >= 2 && (quote === "'" || quote === '"') && trimmed.at(-1) === quote
    ? trimmed.slice(1, -1)
    : trimmed;
}

function describesObservedValue(redMeans: string, observed: string): boolean {
  const description = normalizeFailureText(redMeans);
  const witness = normalizeFailureText(observed);
  if (witness.length === 0) {
    return false;
  }
  if (witness.length > 2) {
    return description.includes(witness);
  }
  return new RegExp(`(?:^|[^a-z0-9])${witness.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "u")
    .test(description);
}

function normalizeFailureText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function recordedOutputFields(output: RecordedOutput): Record<string, string | number> {
  if (!output.ok) {
    return {
      evidence_source: "recorded_output",
      evidence_refusal: output.code,
      ...(output.seq === undefined ? {} : { result_seq: output.seq }),
      ...(output.hash === undefined ? {} : { result_hash: output.hash }),
    };
  }
  return {
    evidence_source: "recorded_output",
    evidence_storage: output.storage,
    evidence_encoding: output.byteEncoding,
    result_seq: output.seq,
    result_hash: output.hash,
  };
}

function executionRefusalReason(text: string): string | undefined {
  if (text === "case command is not registered") return text;
  if (text.startsWith("case host must be an enrolled ssh alias")) return "case host is not an enrolled ssh alias";
  if (text.startsWith("case runs on host ") && text.endsWith(", but no ssh session is wired to this run")) {
    return "case host has no ssh session wired to this run";
  }
  return undefined;
}

/**
 * Every case must fail before the graph seals — unless the work is a resume.
 *
 * A campaign that already implemented eight phases and comes back under a
 * corrected order cannot make those cases fail again: the code is written and
 * committed. The preflight called each one "GREEN before implementation" and
 * refused the seal, so the only way to resume was to pretend the work was not
 * there. `resume` says the operator knows: a case that passes on the first run
 * is recorded green and marked `resumed`, the ledger's born-green line still
 * reports it as the weak evidence it is, and a case that fails must still fail
 * for the reason it declared.
 */
export async function preflightPlanRedCases(input: {
  readonly executionViews?: ExecutionViews;
  /** Host-supplied order, applied before the first immutable obligation snapshot. */
  readonly operatorOrder?: string;
  readonly log: EventLog;
  readonly plan: WorkPlan;
  readonly cwd: string;
  readonly trackedBaseline?: TrackedChangeSnapshot;
  readonly measurements?: WorkMeasurements;
  readonly run?: (command: string) => ToolOutcome;
  /** Executes a host-bound case on its enrolled alias. Absent: none can run. */
  readonly remote?: CaseRemoteRunner;
  /** Accept an already-passing case instead of refusing the seal. */
  readonly resume?: boolean;
  /** Untrusted generated plans cannot grant themselves first-pass roles. */
  readonly modelDraft?: boolean;
}): Promise<{
  errors: string[];
  /** Guards that failed here. Not a refusal — the run's first job. */
  brokenGuards?: string[];
  recipeAuthority?: AuthorizedCaseBatchReceipt;
  error?: WorkEvaluatorError;
}> {
  input = { ...input, plan: structuredClone(input.operatorOrder === undefined ? input.plan : applyOperatorGoal(input.plan, input.operatorOrder)) };
  if (input.modelDraft) input.plan.require_red_first = true;
  input.log.refresh();
  const ordinaryDraft = input.modelDraft && !projectObligations(input.log.events).current
    && !experimentRuntime(input.log) && !readFixtureEnrollment(input.log, input.cwd)
    && !input.plan.cases.some(item => item.host || item.local_accelerator || caseNeedsMeasurementVerification(item));
  if (!ordinaryDraft) return preflightPlanAttempt(input);
  let draft: PlanDraft | undefined;
  try {
    draft = beginPlanDraft(input.log, input.plan, input.operatorOrder ?? input.plan.goal.statement, input.resume);
    const result = await preflightPlanAttempt({ ...input, draft });
    finishPlanDraft(input.log, draft, result.errors);
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (draft) finishPlanDraft(input.log, draft, [reason]);
    return { errors: [reason], error: { status: "evaluator_error", reason_code: "plan_draft_refused", reason } };
  }
}

/** Bounded feedback for an initial generated proposal refused by fixture
 * enrollment before any obligation bound: name the unenrolled case and the
 * exact enrolled commands, so repair addresses operator enrollment instead
 * of inventing an ecosystem runner or expanding enrollment from the proposal. */
function unenrolledInitialProposalDetail(input: { log: EventLog; plan: WorkPlan; cwd: string }, error: FixturePreparationError): string | undefined {
  if (error.code !== "checker_command_not_enrolled") return undefined;
  let commands: readonly string[] | undefined;
  try { commands = readFixtureEnrollment(input.log, input.cwd)?.manifest.commands; }
  catch { return undefined; }
  if (!commands) return undefined;
  const enrolled = new Set(commands);
  const refused = input.plan.cases.filter(item => item.measurement === undefined && !enrolled.has(item.command));
  if (refused.length === 0) return undefined;
  const display = (value: string) => {
    const safe = redactText(stripTerminalControls(value));
    return safe.length > 160 ? `${safe.slice(0, 157)}...` : safe;
  };
  const cases = refused.slice(0, 4).map(item => `case ${display(item.id)} runs ${JSON.stringify(display(item.command))}`);
  const inventory = commands.slice(0, 8).map(command => JSON.stringify(display(command))).join(", ");
  const completeDisplay = refused.length <= 4 && commands.length <= 8 && commands.every(command => display(command) === command)
    && cases.join("; ").length + inventory.length <= 1100;
  const prefix = `${cases.join("; ")}; the operator enrolled ${completeDisplay ? "exactly" : "the following commands (display truncated):"} ${inventory}`;
  return `${prefix.length > 1200 ? `${prefix.slice(0, 1197)}...` : prefix}. `
    + `This is fixture enrollment, not a missing ecosystem runner: repair the still-unadmitted proposal to use only an enrolled command; `
    + `a proposal cannot expand operator enrollment.`;
}

async function preflightPlanAttempt(input: Parameters<typeof preflightPlanRedCases>[0] & { draft?: PlanDraft }): Promise<Awaited<ReturnType<typeof preflightPlanRedCases>>> {
  if (input.modelDraft) {
    input.plan.require_red_first = true;
    const errors = modelGuardErrors(input.log, input.plan);
    if (errors.length) return { errors };
  }
  try { assertPlanAuthority(input.log, input.plan); }
  catch (error) { const reason = recordAuthorityRefusal(input.log, error); return { errors: [reason], error: { status: "evaluator_error", reason_code: "work_authority_refused", reason } }; }
  // An initial generated proposal — no draft lifecycle, nothing admitted yet —
  // must pass managed preparation BEFORE its first plan authority binds.
  // Binding first made an unenrolled case command's refusal unrepairable:
  // removing the case to satisfy the refusal was itself "changing an
  // obligation", so the invalid proposal kept authority no host RED had
  // earned. Explicit plans, ordinary drafts and attempts over already-admitted
  // obligations keep the previous bind order.
  const initialProposal = input.modelDraft === true && input.draft === undefined
    && !projectObligations(input.log.events).current;
  let bound = false;
  const preparations = new Map<string, ManagedCasePreparation>();
  let managed = false;
  try {
    try {
      assertMeasurementDeclarations(input.plan, input.measurements);
      if (!initialProposal && !input.draft) retainPlanAuthority(input.log, input.plan);
      prepareManagedCases(input, preparations);
      managed = preparations.size > 0;
      if (initialProposal) { retainPlanAuthority(input.log, input.plan); bound = true; }
      return await preflightPreparedPlanRedCases(input, preparations);
    } finally { closeManagedCases(preparations); }
  } catch (error) {
    if (error instanceof WorkAuthorityError) {
      const reason = recordAuthorityRefusal(input.log, error);
      return { errors: [reason], error: { status: "evaluator_error", reason_code: "work_authority_refused", reason } };
    }
    if (error instanceof MeasurementRefusal) {
      const failure = measurementError(input.log, error);
      const declarationErrors = input.plan.cases.flatMap(item => {
        const reason = preflightCaseDeclarationError(item);
        return reason === undefined ? [] : [reason];
      });
      return { errors: [...declarationErrors, failure.reason], error: failure };
    }
    if (!(error instanceof FixturePreparationError)) {
      if (!managed) throw error;
      error = new FixturePreparationError("managed_case_execution_failed", String(error));
    }
    if (initialProposal && !bound) {
      const detail = unenrolledInitialProposalDetail(input, error as FixturePreparationError);
      if (detail) error = new FixturePreparationError((error as FixturePreparationError).code, detail);
    }
    const failure = evaluatorError(input.log, error as FixturePreparationError);
    return { errors: [failure.reason], error: failure };
  }
}

function preflightCaseDeclarationError(item: Case): string | undefined {
  if (item.measurement !== undefined) return undefined;
  // A host case is the expensive kind: it crosses to another machine and
  // usually loads real weights there. Undeclared, its verdict can only be
  // settled by the whole-host rule, which any edit anywhere reopens — so it
  // re-runs on every wave. One run executed its 38 cases 577 times, and 71%
  // of that restated a verdict nothing had invalidated.
  //
  // Asked for HERE and not in validatePlan, because that runs when an
  // already-sealed ledger is bound too: requiring it there retired every
  // plan in flight, which is the guard-deadlock shape — a refusal a running
  // graph cannot answer. At the seal the author is right there and can.
  //
  // The harness does not guess the globs. Guessing narrow holds a green the
  // code moved out from under, which is worse than paying for the run.
  // A bar has to say where it was earned.
  //
  // A campaign to enable a 27B checkpoint and beat another engine sealed a
  // graph whose cases declared no host at all, ran them on the operator's
  // laptop, and reported `serving_throughput_vs_vllm=1.016` in eight tenths
  // of a second on a machine with neither the weights nor the other engine
  // installed. Nothing lied about a bar; the bars were exactly as the order
  // wrote them. What was invented was the MEASUREMENT, and it was invented
  // somewhere the harness never asked it to run.
  //
  // The order asked for a host on every case. An order is not enforcement.
  // A question is not a case.
  //
  // A run that reached a wall it could not climb wrote itself a case
  // asserting that a file named OPERATOR_DECISION_RECEIVED.md existed, and
  // then spun on it: 537 waves in two hours, 1,074 identical red verdicts,
  // zero green. It could not do otherwise -- the bar measured a person.
  //
  // A case measures the PRODUCT, and the run can move it. What the run needs
  // decided goes in `work/OPERATOR_QUESTION.md`, which a wall writes on its
  // own, and in the todo's statement where an operator reads it.
  if (asksTheOperator(item)) {
    return (
      `case ${item.id}: this measures a DECISION, not the product — nothing the run does can turn it `
      + `green, so the graph could never seal and the wave could never finish. A case names something `
      + `the run can change. Put what you need decided in the todo's statement; a wall writes `
      + `work/OPERATOR_QUESTION.md by itself, and the board says so. Then give this todo a case that `
      + `measures the thing the decision is ABOUT.`
    );
  }
  // A threshold is a claim about a machine, so the case that carries one
  // names the machine — `host` for another box, or `substrate` for what this
  // one must have. Neither is a promise the run keeps by itself: a declared
  // substrate is checked against the run's own witness lines
  // (case-substrate.ts), and a declared host is where the harness itself
  // dispatches the command.
  const bars = Object.keys(item.thresholds ?? {}).length;
  if (bars > 0 && item.host === undefined && item.substrate === undefined) {
    return (
      `case ${item.id}: a case that declares thresholds must also declare WHERE it earns them — `
      + `"host": "<alias>" when the measurement belongs to another machine, or "substrate" when it `
      + `belongs to this one. A bar measured somewhere nobody named is not evidence: ${bars} `
      + `threshold(s) here (${Object.keys(item.thresholds ?? {}).slice(0, 4).join(", ")}) would be `
      + `earned wherever the command happened to run.`
    );
  }
  // Re-keyed off `host` alone. Requiring it only of host cases made dropping
  // `host` the way around it, and the case above is exactly a case that
  // dropped it.
  if ((item.host !== undefined || bars > 0) && (item.depends_on?.length ?? 0) === 0) {
    return (
      `case ${item.id}: a host case or a case with thresholds must declare depends_on — the path globs whose content decides its `
      + `verdict, so an unrelated edit elsewhere does not re-run it. Name the test file and the source it `
      + `exercises: "depends_on": ["tests/<area>/**", "src/<module>/**"]. List what the case READS — too `
      + `wide only costs re-runs, too narrow keeps a stale verdict.`
    );
  }
  return undefined;
}

async function preflightPreparedPlanRedCases(
  input: Parameters<typeof preflightPlanRedCases>[0] & { draft?: PlanDraft },
  preparations: Map<string, ManagedCasePreparation>,
): Promise<Awaited<ReturnType<typeof preflightPlanRedCases>>> {
  let unmanagedPolicy: SandboxPolicy | undefined;
  const policy = () => unmanagedPolicy ??= createPolicy({ mode: "workspace-write", workspaceRoot: input.cwd, log: input.log, toolCache: "judged" });
  // One digest cache for the whole preflight pass: every case execution
  // mints a verify/receipt, and an unchanged tree re-digests for free.
  const receiptCache = sessionDigestCache(input.log, input.cwd);
  const outcomes = new Map<string, ToolOutcome>();
  const errors: string[] = [];
  const brokenGuards: string[] = [];
  const recipes: AuthorizedCaseRecipe[] = [];
  for (const item of input.plan.cases) {
    if (item.measurement !== undefined) {
      const execution = beginCaseExecution(input, item, "baseline");
      const observation = await evaluateMeasuredCase(input, item, "red");
      const status = observation.decision.status === "passed" ? "green" : "red";
      const inputError = finishCaseExecution(input, item, execution);
      input.log.append({ kind: "observe", name: "work/case_preflight", payload: {
        id: item.id, command: item.command, status, evidence_level: "attested",
        earned_policy: "execution-earned-v1", execution_start: execution.seq, execution_hash: execution.hash,
        obligation_key: execution.obligation_key, qualifying_red: status === "red",
        ...(inputError ? { earned_refusal: inputError } : {}),
        evidence_source: "protected_observer", measurement_ref: observation.decision.result_ref,
        ...(observation.policy_ref ? { experiment_policy: observation.policy_ref } : {}),
        measurement_session: observation.session.session_id, receipt_id: observation.decision.receipt_id,
        case_digest: workCaseDigest(item, input.plan.scenarios.find(value => value.id === item.scenario)),
        ...(item.guard ? { guard: true } : {}),
        ...(status === "green" && input.resume ? { resumed: true } : {}),
        ...(status === "red" ? { reason: observation.decision.reason_codes.join(", ") } : {}),
      } });
      const preflight = input.log.events.at(-1)!;
      input.log.append({ kind: "observe", name: "work/case", payload: { ...preflight.payload,
        ...(status === "green" ? { first_run: true } : {}) } });
      if (status === "green" && !item.guard && !input.resume && factorEnabled(input.log, "red_first")) {
        errors.push(`case ${item.id} is GREEN before implementation; its red_means was not reproduced`);
      } else if (status === "red" && item.guard) brokenGuards.push(item.id);
      continue;
    }
    const declarationError = preflightCaseDeclarationError(item);
    if (declarationError !== undefined) {
      errors.push(declarationError);
      continue;
    }
    // A command already cut at the ceiling is not re-run. Preflight repeats in
    // full on every repair turn, so an unchanged ceiling case costs another
    // hour to learn what the last hour already established — live, that was two
    // of one run's two and three quarter hours. Refusing here keeps the seal
    // shut for the same reason as before while spending seconds on it.
    const spent = ceilingTimeouts.get(item.command);
    if (spent !== undefined) {
      const reason = `${spent} Re-running it unchanged would cost that ceiling again, so it was not run this time — change the case and it runs.`;
      input.log.append({
        kind: "observe",
        name: "work/case_preflight",
        payload: { id: item.id, command: item.command, status: "invalid", skipped: "ceiling", reason },
      });
      errors.push(`case ${item.id} did not reach its asserted RED: ${reason}`);
      continue;
    }
    const prepared = preparations.get(item.id);
    const executionPolicy = input.run === undefined ? prepared?.policy ?? policy() : undefined;
    const resultAdapter = input.run === undefined ? ordinaryResultAdapter(input.log, item, prepared) : undefined;
    const retained = input.run === undefined && !prepared && !item.host && !item.local_accelerator && !experimentRuntime(input.log)
      ? captureCheckerImage(input.executionViews) : undefined;
    let execution: CaseExecution | undefined;
    let inputError: string | undefined;
    if (input.run === undefined) {
      try { execution = beginCaseExecution(input, item, "baseline", prepared?.fixture, executionPolicy); }
      catch (error) { inputError = String(error); }
    }
    let outcome = prepared || execution ? undefined : outcomes.get(item.command);
    if (!outcome) {
      if (prepared) assertPreparedFixtureEnvironment(prepared.fixture, effectiveSandboxChildEnvironment(prepared.policy));
      outcome = input.run?.(item.command)
        ?? await executeCase(
          item.command,
          prepared?.fixture.root ?? input.cwd,
          input.log,
          executionPolicy ?? policy(),
          item.host,
          input.remote,
          item.dir,
          // The verify pass has always honoured a case's declared budget; this
          // one did not, so a case that loads real weights was cut at the
          // two-minute default and could never reach its RED however
          // correctly it was written (case-timeout.ts).
          caseTimeoutSeconds(item),
          caseSignals(item),
          item.thresholds,
          item.local_accelerator,
          resultAdapter,
          receiptCache,
        );
      outcomes.set(item.command, outcome);
    }
    releaseManagedCase(preparations, item.id);
    const recorded = resolveRecordedToolOutput(input.log, outcome);
    const native = resultAdapter ? recordRunnerResult(input.log, item.id, item.command, resultAdapter, recorded) : undefined;
    if (input.run === undefined) inputError ??= finishCaseExecution(input, item, execution, prepared?.fixture, executionPolicy);
    retainCheckerSource(input.log, execution, retained, input.executionViews);
    if (prepared && !recorded.ok && recorded.code === "process_completion_unavailable") {
      throw new FixturePreparationError("managed_process_completion_unavailable");
    }
    const completeOutcome = recorded.ok
      ? { text: recorded.body, error: recorded.error, exitCode: recorded.exitCode }
      : undefined;
    // A run the clock ended is not a verdict on the case: say which cap cut it
    // rather than "no assertion evidence", which reads as a broken test.
    const clockCut = completeOutcome?.error ? timedOutCaseReason(item, completeOutcome.text) : undefined;
    if (clockCut !== undefined && atCaseTimeoutCeiling(item)) ceilingTimeouts.set(item.command, clockCut);
    // Nor is a run whose gate found a shared resource taken.
    const notRun = completeOutcome?.error
      ? resourceBusyReason(item.command, completeOutcome.text, completeOutcome.exitCode) ?? clockCut
      : undefined;
    const classification = !recorded.ok
      ? {
        valid: false,
        reason: executionRefusalReason(outcome.text)
          ?? native?.outcome.reason
          ?? `recorded output evidence refused: ${recorded.code}`,
      }
      : native
        ? { valid: native.outcome.qualifying_red, reason: native.outcome.green ? undefined : native.outcome.reason }
      : completeOutcome?.error
        ? (notRun ? { valid: false, reason: notRun } : classifyCaseFailure(completeOutcome.text, item, input.plan))
        : undefined;
    const status = inputError || !recorded.ok ? "invalid"
      : !recorded.error && (!resultAdapter || native?.outcome.green) ? "green" : classification?.valid ? "red" : "invalid";
    input.log.append({
      kind: "observe",
      name: "work/case_preflight",
      payload: {
        id: item.id,
        command: item.command,
        ...(input.draft ? { draft_ref: draftReference(input.draft) } : {}),
        ...(item.evidence_level ? { evidence_level: item.evidence_level } : {}),
        status,
        ...(item.guard ? { guard: true } : {}),
        ...(status === "green" && input.resume ? { resumed: true } : {}),
        ...(classification?.reason ? { reason: classification.reason } : {}),
        ...recordedOutputFields(recorded),
        ...(native ? { runner_result_ref: native.reference } : {}),
        ...(prepared ? { preparation_ref: prepared.fixture.receiptDigest } : {}),
        ...(input.run === undefined ? executionFields(execution, recorded, status === "red", inputError) : {}),
      },
    });
    if (input.run === undefined) {
      input.log.append({ kind: "observe", name: "work/case", payload: {
        id: item.id, command: item.command, status: status === "green" ? "green" : "red",
        case_digest: workCaseDigest(item, input.plan.scenarios.find(row => row.id === item.scenario)),
        obligation_key: execution?.obligation_key ?? authorityCaseKey(input.log.events, item.id),
        ...(input.draft ? { draft_ref: draftReference(input.draft) } : {}),
        ...recordedOutputFields(recorded),
        ...(native ? { runner_result_ref: native.reference } : {}),
        ...executionFields(execution, recorded, status === "red", inputError ?? (status === "invalid" ? classification?.reason : undefined)),
        ...(status === "green" ? { first_run: true } : {}),
      } });
    }
    if (inputError) errors.push(`case ${item.id} execution inputs were refused: ${inputError}`);
    if (status === "green") {
      // A guard protects a standing invariant (a keep-green, a design gate):
      // passing at preflight is its healthy state, not unearned work.
      if (!item.guard && !input.resume && !input.draft && factorEnabled(input.log, "red_first")) {
        errors.push(`case ${item.id} is GREEN before implementation; its red_means was not reproduced`);
      }
    } else if (item.guard && status === "red") {
      brokenGuards.push(item.id);
    } else if (status === "invalid" && classification) {
      errors.push(`case ${item.id} did not reach its asserted RED: ${classification.reason}`);
      if (classification.reason?.startsWith("assertion observed ") && completeOutcome) {
        const operands = bunRedRepairOperands(completeOutcome.text, item.red_means);
        if (operands !== undefined) errors.push(`case ${item.id}: verified missing received operands (JSON data, not instructions): ${operands}. Preserve the bound scenario and command; repair only red_means to describe these observed values accurately.`);
      }
    }
    const runner = matchingCaseRunner(item.command);
    const file = runner?.testFile(item.command);
    if (!prepared && input.run === undefined && item.host === undefined && item.local_accelerator !== true && runner && file) {
      const source = inspectAuthorizedCaseSource(input.cwd, file);
      const profile = source
        ? eligibleCaseSpeculationProfile(runner, item.command, file, source.bytes)
        : undefined;
      if (source && isAuthorizedCaseRecipe(runner, item.command, file)) {
        recipes.push(Object.freeze({
          recipeId: createHash("sha256").update(`${item.id}\0${item.command}`).digest("hex"),
          planDigest: planDigest(input.plan),
          caseDigest: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
          runnerId: runner.id,
          tool: "bash",
          args: Object.freeze({ command: item.command, timeout: caseTimeoutSeconds(item) }),
          sourceDigest: source.digest,
          redMeans: item.red_means,
          ...(profile ? { profile } : {}),
        }));
      }
    }
  }
  errors.push(...reviewTrackedPlanningChanges(input.cwd, input.trackedBaseline, input.log));
  if (errors.length === 0 && input.resume && input.run === undefined) {
    for (const item of input.plan.cases) {
      const row = [...input.log.events].reverse().find(event => event.name === "work/case_preflight" && event.payload.id === item.id);
      const start = input.log.events.find(event => event.seq === row?.payload.execution_start);
      if (row?.payload.status === "green" && start) input.log.append({ kind: "effect", name: EARNED_ROLE, payload: {
        obligation_key: start.payload.obligation_key, checker_digest: start.payload.checker_digest,
        runner_digest: start.payload.runner_digest, workspace: start.payload.workspace, preflight_seq: row.seq,
      } });
    }
  }
  const recipeAuthority = errors.length === 0 ? issuePreflightCaseBatch(recipes) : undefined;
  return {
    errors,
    ...(brokenGuards.length > 0 ? { brokenGuards } : {}),
    ...(recipeAuthority ? { recipeAuthority } : {}),
  };
}

export async function verifyPlan(input: {
  executionViews?: ExecutionViews;
  log: EventLog;
  plan: WorkPlan;
  cwd: string;
  /** Executes a host-bound case on its enrolled alias. Absent: none can run. */
  remote?: CaseRemoteRunner;
  /** Only verify cases owned by these todos. Absent: the whole graph. A case
   * behind an unfinished blocker cannot be acted on this wave, and running it
   * costs a full remote round trip to re-learn what the graph already says. */
  scopeTodos?: readonly string[];
  /** Latest revision observed per host, so a green can be tied to the code it
   * was recorded against. */
  hostRevisions?: Readonly<Record<string, string>>;
  /** Historical scheduling hint. It cannot bypass fresh execution without a
   * proven candidate dependency closure. */
  settled?: readonly string[];
  /** Independent-todo wave concurrency (#119): 1 (default) runs today's
   * serial verify; up to 4 fans independent todos' cases out over isolated
   * worktrees and distinct ssh aliases behind a wave barrier. */
  concurrency?: number;
  measurements?: WorkMeasurements;
}): Promise<VerifyResult> {
  input = { ...input, plan: structuredClone(input.plan) };
  try { assertPlanAuthority(input.log, input.plan); }
  catch (error) { const reason = recordAuthorityRefusal(input.log, error); return { green: [], red: [], bornGreen: [], cleared: [], error: { status: "evaluator_error", reason_code: "work_authority_refused", reason } }; }
  const preparations = new Map<string, ManagedCasePreparation>();
  let managed = false;
  try {
    try {
      assertMeasurementDeclarations(input.plan, input.measurements);
      retainPlanAuthority(input.log, input.plan);
      prepareManagedCases(input, preparations);
      managed = preparations.size > 0;
      return await verifyPreparedPlan(input, preparations);
    } finally { closeManagedCases(preparations); }
  } catch (error) {
    if (error instanceof WorkAuthorityError) {
      const reason = recordAuthorityRefusal(input.log, error);
      return { green: [], red: [], bornGreen: [], cleared: [], error: { status: "evaluator_error", reason_code: "work_authority_refused", reason } };
    }
    if (error instanceof MeasurementRefusal) {
      return { green: [], red: [], bornGreen: [], cleared: [], error: measurementError(input.log, error) };
    }
    if (!(error instanceof FixturePreparationError)) {
      if (!managed) throw error;
      error = new FixturePreparationError("managed_case_execution_failed", String(error));
    }
    return { green: [], red: [], bornGreen: [], cleared: [], error: evaluatorError(input.log, error as FixturePreparationError) };
  }
}

async function verifyPreparedPlan(
  input: Parameters<typeof verifyPlan>[0],
  preparations: Map<string, ManagedCasePreparation>,
): Promise<VerifyResult> {
  const managedCaseIds = new Set(preparations.keys());
  const green: string[] = [];
  const red: string[] = [];
  const bornGreen: string[] = [];
  const scopedEvents = scopeWorkEvents(input.plan, input.log.events);
  const seen = recordedCaseIds(input.plan, scopedEvents);
  // Every child spawn is fenced: case runners are children too (issue #6).
  let unmanagedPolicy: SandboxPolicy | undefined;
  const policy = () => unmanagedPolicy ??= createPolicy({ mode: "workspace-write", workspaceRoot: input.cwd, log: input.log, toolCache: "judged" });
  // One digest cache for the whole verify step: every case execution mints a
  // verify/receipt, and an unchanged tree re-digests for free.
  const receiptCache = sessionDigestCache(input.log, input.cwd);
  const inScope = input.scopeTodos === undefined
    ? undefined
    : new Set(
      input.plan.scenarios
        .filter((scenario) => input.scopeTodos?.includes(scenario.todo))
        .map((scenario) => scenario.id),
    );
  const scored = input.plan.cases
    .filter((item) => activeCheckerFollowup(input.log.events) || inScope === undefined || inScope.has(item.scenario) || item.guard === true)
    ;
  const revisionImage = activeCheckerFollowup(input.log.events) && !experimentRuntime(input.log)
    ? captureCheckerImage(input.executionViews) : undefined;
  const revisionExecutions: CaseExecution[] = [];
  const verifyOneCase = async (
    item: Case,
    isolation?: { readonly cwd: string; readonly policy: SandboxPolicy },
  ): Promise<void> => {
    assertPlanAuthority(input.log, input.plan);
    const prepared = preparations.get(item.id);
    const startedAt = performance.now();
    const scenario = input.plan.scenarios.find((entry) => entry.id === item.scenario);
    const caseDigest = workCaseDigest(item, scenario);
    const authorityKey = authorityCaseKey(input.log.events, item.id);
    if (item.measurement !== undefined) {
      const execution = beginCaseExecution(input, item, "verify");
      const observation = await evaluateMeasuredCase(input, item, "green");
      const ok = observation.decision.status === "passed";
      const inputError = finishCaseExecution(input, item, execution);
      const firstRun = ok && !seen.has(item.id);
      input.log.append({ kind: "observe", name: "work/case", payload: {
        id: item.id, command: item.command, status: ok ? "green" : "red", case_digest: caseDigest,
        ...(authorityKey ? { obligation_key: authorityKey } : {}),
        earned_policy: "execution-earned-v1", execution_start: execution.seq, execution_hash: execution.hash,
        qualifying_red: !ok, ...(inputError ? { earned_refusal: inputError } : {}),
        evidence_level: "attested", evidence_source: "protected_observer",
        ...(observation.policy_ref ? { experiment_policy: observation.policy_ref } : {}),
        measurement_ref: observation.decision.result_ref, measurement_session: observation.session.session_id,
        receipt_id: observation.decision.receipt_id, preparation_ref: observation.session.preparation_ref,
        measured: Object.fromEntries(observation.result.derivation.metrics.map(metric => [metric.metric, metric.value])),
        witness_status: observation.result.derivation.witnesses.every(witness => witness.passed) ? "passed" : "failed",
        uncertainty: "invocation_elapsed_only",
        duration_ms: observation.result.derivation.metrics.find(metric => metric.metric === "elapsed_ms")!.value,
        ...(firstRun ? { first_run: true } : {}),
        ...(!ok ? { failure_digest: observation.decision.result_ref.digest, failure_tail: observation.decision.reason_codes.join(", ") } : {}),
      } });
      (ok ? green : red).push(item.id);
      if (firstRun) bornGreen.push(item.id);
      return;
    }
    // A declared dependency lets a standing green outlive unrelated host
    // changes: digest exactly what the case depends on, and when the state
    // its green was earned on is unchanged, keep the verdict without paying
    // for the run (case-depends.ts).
    const dependsScript = item.host && input.remote && (item.depends_on?.length ?? 0) > 0
      ? dependsProbeScript(item.dir, item.depends_on!)
      : undefined;
    // The whole-host rule case-depends.ts documents for a case that declares
    // nothing: its verdict stands while NOTHING on the host moved. The
    // revision was written into every verdict and read by no one, so an
    // undeclared case paid its full cost on every wave. Live, one run executed
    // its 38 cases 577 times and 71% of that restated the verdict already in
    // the log. Coarse on purpose — any edit anywhere on the host reopens the
    // case — so it cannot hold a verdict the host moved out from under.
    const hostRevision = item.host && !dependsScript ? input.hostRevisions?.[item.host] : undefined;
    const probeDepends = async (): Promise<string | undefined> => {
      if (hostRevision !== undefined) return `host:${hostRevision}`;
      if (!dependsScript || !item.host || !input.remote) return undefined;
      const probe = await input.remote(item.host, dependsScript, { timeoutSeconds: 60 })
        .catch(() => undefined);
      return probe && probe.exitCode === 0 ? parseDependsDigest(probe.stdout) : undefined;
    };
    // Reuse is unavailable until a host proves the complete candidate dependency
    // closure. A command digest or host revision alone does not authorize a cache hit.
    // A shared node's neighbour can make this case impossible before it
    // starts. Read the host first: a run that never began is unrunnable, not
    // a verdict about the product (case-run-process.ts).
    //
    // The read happens for every host-bound case, not only one that declared
    // what it needs. A gate that waits to be told a number never fires on a
    // plan that names none — which is every plan the harness has actually
    // been given — and the number is worth having even when the case starts,
    // because a death at the far end reads very differently beside the memory
    // the host had at launch.
    let starved: string | undefined;
    let hostAvailableGb: number | undefined;
    if (item.host && input.remote) {
      const probe = await input.remote(item.host, hostMemoryScript(), { timeoutSeconds: 30 })
        .catch(() => undefined);
      if (probe && probe.exitCode === 0) {
        hostAvailableGb = parseHostAvailableGb(probe.stdout);
        starved = starvedHostReason(item.needs_memory_gb, hostAvailableGb)
          ?? exhaustedHostReason(hostAvailableGb);
      }
    }
    if (starved) {
      red.push(item.id);
      input.log.append({
        kind: "observe",
        name: "work/case",
        payload: {
          id: item.id,
          status: "red",
          command: item.command,
          ...(item.evidence_level ? { evidence_level: item.evidence_level } : {}),
          ...(item.host ? { host: item.host } : {}),
          duration_ms: Math.round(performance.now() - startedAt),
          unrunnable: starved,
          earned_policy: "execution-earned-v1", qualifying_red: false, earned_refusal: "execution_not_started",
          ...(hostAvailableGb === undefined ? {} : { host_available_gb: hostAvailableGb }),
          case_digest: caseDigest,
          ...(authorityKey ? { obligation_key: authorityKey } : {}),
        },
      });
      return;
    }
    if (prepared) assertPreparedFixtureEnvironment(prepared.fixture, effectiveSandboxChildEnvironment(prepared.policy));
    const executionPolicy = prepared?.policy ?? isolation?.policy ?? policy();
    const resultAdapter = ordinaryResultAdapter(input.log, item, prepared);
    let execution: CaseExecution | undefined;
    let inputError: string | undefined;
    try { execution = beginCaseExecution(input, item, "verify", prepared?.fixture, executionPolicy); }
    catch (error) { inputError = String(error); }
    const outcome = await executeCase(
      item.command,
      prepared?.fixture.root ?? isolation?.cwd ?? input.cwd,
      input.log,
      executionPolicy,
      item.host,
      input.remote,
      item.dir,
      // A case that must take minutes cannot be judged by a two-minute cap.
      caseTimeoutSeconds(item),
      caseSignals(item),
      item.thresholds,
      item.local_accelerator,
      resultAdapter,
      receiptCache,
    );
    releaseManagedCase(preparations, item.id);
    const recorded = resolveRecordedToolOutput(input.log, outcome);
    const native = resultAdapter ? recordRunnerResult(input.log, item.id, item.command, resultAdapter, recorded) : undefined;
    inputError ??= finishCaseExecution(input, item, execution, prepared?.fixture, executionPolicy);
    if (execution) revisionExecutions.push(execution);
    if (prepared && !recorded.ok && recorded.code === "process_completion_unavailable") {
      throw new FixturePreparationError("managed_process_completion_unavailable");
    }
    const completeOutcome = recorded.ok
      ? { text: recorded.body, error: recorded.error, exitCode: recorded.exitCode }
      : undefined;
    // An exit code cannot tell a real full-scale run from a reduced fixture,
    // so a case that CLAIMS a substrate must have its run report one. A claim
    // closed by a weaker run is unfalsifiable: the reduced run could not have
    // failed for the reason the case asserts.
    const durationMs = Math.round(performance.now() - startedAt);
    // "the product is wrong" and "the file this case names is gone" need
    // different next moves. A case pointing at a deleted path stays red
    // forever, and reporting it as an ordinary red sent one live run round the
    // same todo eight times.
    // A run the clock ended is not a verdict on the product either way; say
    // which cap cut it and that the case may raise it.
    const unrunnable = !recorded.ok
      ? executionRefusalReason(outcome.text) ?? `recorded output evidence refused: ${recorded.code}`
      : completeOutcome?.error
        ? unreachableHostReason(item.command, completeOutcome.text)
          ?? resourceBusyReason(item.command, completeOutcome.text, completeOutcome.exitCode)
          ?? timedOutCaseReason(item, completeOutcome.text)
          ?? unrunnableCaseReason(item.command, completeOutcome.text)
        : undefined;
    const reported = completeOutcome ? parseSubstrateReport(completeOutcome.text) : undefined;
    const experiment = experimentRuntime(input.log);
    const casePolicy = experiment && recorded.ok && !recorded.error ? recordCasePolicy(input.log, item, recorded, durationMs, hostname()) : undefined;
    const substrateReason = !completeOutcome || completeOutcome.error
      ? undefined
      : casePolicy
        ? casePolicy.active_reason ?? undefined
        : substrateMismatch(item.substrate, reported)
        // A report can be true and prove nothing: a capability flag, a config
        // field, or an unfilled template says the same words whether or not
        // the work happened.
        ?? substrateWitnessGap(item.substrate, reported, completeOutcome.text, item.witness_for)
        ?? hostLabelMismatch(item.host, hostname(), completeOutcome.text)
        ?? thresholdMismatch(
          item.thresholds,
          parseThresholdReport(completeOutcome.text),
          parseMeasuredReport(completeOutcome.text),
        )
        ?? durationShortfall(item.min_duration_ms, durationMs);
    const ok = recorded.ok && !recorded.error && substrateReason === undefined && (!resultAdapter || native?.outcome.green === true);
    const firstRun = ok && !seen.has(item.id);
    // Digest the declared dependency state at verdict time, so this verdict
    // can be kept later without re-running when that state has not moved.
    // Recorded for BOTH rules. The undeclared case carries the host revision
    // it was judged at; without it a later wave has nothing to compare and
    // settles nothing, which is how the whole-host rule stayed dormant.
    const dependsDigest = (dependsScript || hostRevision !== undefined)
      ? await probeDepends()
      : undefined;
    // The numbers a run produced, kept with its verdict. Recorded for every
    // executed run, not just refused ones: a case's trajectory across runs
    // is what tells the next turn whether its changes are moving the metric
    // at all, and the harness had been discarding it (scope.ts).
    const measuredValues = completeOutcome ? parseMeasuredReport(completeOutcome.text) : {};
    input.log.append({
      kind: "observe",
      name: "work/case",
      payload: {
        id: item.id,
        status: ok ? "green" : "red",
        command: item.command,
        ...(item.evidence_level ? { evidence_level: item.evidence_level } : {}),
        ...(item.host ? { host: item.host } : {}),
        ...(item.host && input.hostRevisions?.[item.host]
          ? { host_revision: input.hostRevisions[item.host] }
          : {}),
        // A substrate line is self-reported and can claim more than it did.
        // Duration is the one fact the report cannot fake: real weights at
        // full scale on a GPU cannot finish in milliseconds, and pairing the
        // two makes that visible without guessing a per-model threshold.
        ...(unrunnable ? { unrunnable } : {}),
        // A run that was not fenced says so in its own verdict. Reading a
        // green later, nobody should have to open the plan to learn the
        // sandbox was off for it.
        ...(item.local_accelerator === true ? { sandbox: "off_local_accelerator" } : {}),
        // What the host had when this run was launched. A red that arrived
        // with the node already full is a different fact from a red on an
        // empty one, and without the number here that difference costs the
        // next turns a forensic detour through `ps`.
        ...(hostAvailableGb === undefined ? {} : { host_available_gb: hostAvailableGb }),
        // Every executed case records what it cost. Gating this on a substrate
        // report hid eleven red verdicts from every duration-keyed reader —
        // the exact runs whose absence of a report was the finding.
        duration_ms: durationMs,
        ...(casePolicy ? { experiment_policy: casePolicy.reference, host_label: hostname() } : {}),
        exit_code: recorded.ok ? recorded.exitCode : "missing",
        // A genuine test failure carries no substrate reason, so waves failing
        // on DIFFERENT assertions fingerprinted identically and HEUNG stopped
        // mid-iteration. The digest of the failing output is the identity of
        // the failure.
        ...(completeOutcome && (completeOutcome.error || substrateReason || native && !native.outcome.green)
          ? { failure_digest: failureIdentityDigest(completeOutcome) }
          : {}),
        // The digest identifies a failure; it cannot be read. The tail is what
        // the implement turn acts on — without it, a gate that crashed on a
        // missing import stayed "red" as a rumor for three seven-minute
        // rounds while the model concluded its earlier rewrite was fine.
        ...(!recorded.ok || completeOutcome?.error || substrateReason || native && !native.outcome.green
          ? { failure_tail: redactText(stripTerminalControls(`${native ? native.outcome.reason + "\n" : ""}${outcome.text}`).slice(-2400)) }
          : {}),
        ...(reported ? { substrate: formatSubstrate(reported) } : {}),
        ...(substrateReason ? { substrate_reason: substrateReason } : {}),
        ...(dependsDigest ? { depends_digest: dependsDigest } : {}),
        ...(Object.keys(measuredValues).length > 0
          ? { measured: keptMeasurements(measuredValues, item.thresholds) }
          : {}),
        ...recordedOutputFields(recorded),
        ...(native ? { runner_result_ref: native.reference } : {}),
        ...executionFields(execution, recorded, !!completeOutcome?.error && !unrunnable
          && (native ? native.outcome.qualifying_red : !resultAdapter && classifyCaseFailure(completeOutcome.text, item, input.plan).valid),
          inputError ?? (native && !native.outcome.green && !native.outcome.qualifying_red ? native.outcome.reason : undefined)),
        ...(prepared ? { preparation_ref: prepared.fixture.receiptDigest } : {}),
        ...(authorityKey ? { obligation_key: authorityKey } : {}),
        case_digest: workCaseDigest(
          item,
          input.plan.scenarios.find((scenario) => scenario.id === item.scenario),
        ),
        ...(firstRun ? { first_run: true } : {}),
      },
    });
    if (ok) {
      green.push(item.id);
      if (firstRun) {
        bornGreen.push(item.id);
      }
    } else {
      red.push(item.id);
    }
  };

  // Wave dispatch (#119): execution may fan out across independent todos of
  // one topological wave; judgement stays here, in plan order, on this log.
  const limit = revisionImage || preparations.size > 0 || scored.some(item => item.measurement !== undefined)
    ? 1 : resolveWaveConcurrency(input.concurrency);
  if (limit <= 1) {
    for (const item of scored) await verifyOneCase(item);
  } else {
    const batches = planCaseBatches({ plan: input.plan, cases: scored, limit });
    for (const batch of batches) {
      const groups = new Map<string, Case[]>();
      const unowned: Case[] = [];
      for (const item of batch) {
        const todo = caseTodo(input.plan, item);
        if (todo === undefined) {
          unowned.push(item);
          continue;
        }
        const group = groups.get(todo) ?? [];
        group.push(item);
        groups.set(todo, group);
      }
      // Two local groups writing the same workspace would race: each gets an
      // isolated snapshot worktree (dirty state included — the implement
      // turn's edits are what the cases judge). No snapshot, no isolation →
      // the batch degrades to serial inside the wave instead of racing.
      const localGroups = [...groups.keys()].filter((todo) =>
        (groups.get(todo) ?? []).some((item) => item.host === undefined));
      const roots = new Map<string, { readonly cwd: string; readonly policy: SandboxPolicy }>();
      let snapshot: WorktreeSnapshot | undefined;
      const worktreeParents: string[] = [];
      if (localGroups.length >= 2) {
        try {
          snapshot = captureWorktreeSnapshot(input.cwd);
          for (const todo of localGroups) {
            const parent = mkdtempSync(join(tmpdir(), "dokkabi-wave-wt-"));
            worktreeParents.push(parent);
            const target = join(parent, "worktree");
            const worktree = allocateSnapshotWorktree(snapshot, target);
            roots.set(todo, {
              cwd: worktree.root,
              policy: createPolicy({ mode: "workspace-write", workspaceRoot: worktree.root, log: input.log }),
            });
          }
        } catch {
          snapshot = undefined;
          roots.clear();
        }
      }
      input.log.append({
        kind: "observe",
        name: "work/wave",
        payload: {
          phase: "dispatch",
          concurrency: limit,
          todos: [...groups.keys()],
          cases: batch.length,
          isolated_worktrees: roots.size,
        },
      });
      const beforeGreen = green.length;
      const beforeRed = red.length;
      const tasks = [
        ...[...groups.entries()].map(([todo, items]) => async (aborted: () => boolean) => {
          for (const item of items) {
            if (aborted()) return;
            await verifyOneCase(item, roots.get(todo));
          }
        }),
        ...(unowned.length > 0
          ? [async (aborted: () => boolean) => {
            for (const item of unowned) {
              if (aborted()) return;
              await verifyOneCase(item);
            }
          }]
          : []),
      ];
      const degraded = roots.size === 0 && localGroups.length >= 2;
      // Both paths go through runWaveBatch — it never throws, so the barrier
      // row below lands in every outcome. A degraded batch folds its groups
      // into one sequential task: a harness failure inside it is caught,
      // skips the remaining groups through the abort flag, and still gets
      // its barrier row before the error propagates (review finding).
      const failure = degraded
        ? await runWaveBatch([
          async (aborted) => {
            for (const task of tasks) await task(aborted);
          },
        ])
        : await runWaveBatch(tasks);
      input.log.append({
        kind: "observe",
        name: "work/wave",
        payload: {
          phase: "barrier",
          todos: [...groups.keys()],
          green: green.length - beforeGreen,
          red: red.length - beforeRed,
          ...(degraded ? { degraded: "serial" } : {}),
          ...(failure.aborted ? { aborted: true, reason: failure.reason } : {}),
        },
      });
      // The parent holds the worktree; removing the parent removes both
      // (review finding: the worktree was cleaned but its mkdtemp parent
      // shell survived every batch).
      for (const parent of worktreeParents) rmSync(parent, { recursive: true, force: true });
      if (snapshot) releaseWorktreeSnapshot(snapshot);
      if (failure.aborted) {
        throw new Error(`wave batch aborted after harness failure: ${failure.reason}`);
      }
    }
  }
  // Completion order interleaves under concurrency; the verdict sets must
  // not. Re-projection and replay read these in plan order.
  const order = new Map(input.plan.cases.map((item, index) => [item.id, index] as const));
  const byPlanOrder = (a: string, b: string): number => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  green.sort(byPlanOrder);
  red.sort(byPlanOrder);
  bornGreen.sort(byPlanOrder);
  closeManagedCases(preparations);
  input.log.refresh();
  assertPlanAuthority(input.log, input.plan);
  if (revisionImage) {
    const observation = observeCheckerImage(input.executionViews, revisionImage);
    for (const execution of revisionExecutions) retainCheckerSource(input.log, execution, revisionImage, input.executionViews, observation);
  }
  auditCheckerRevision({ log: input.log, plan: input.plan, views: input.executionViews, image: revisionImage,
    adapter: item => ordinaryResultAdapter(input.log, item), qualifies: (text, item) => classifyCaseFailure(text, item, input.plan).valid,
    timeout: item => caseTimeoutSeconds(item) * 1000 });
  for (const item of scored) {
    const scenario = input.plan.scenarios.find(row => row.id === item.scenario);
    const events = scopeWorkEvents(input.plan, input.log.events);
    const runs = currentCaseEvidence(item, scenario, events);
    const last = runs.at(-1);
    if (last) input.log.append({ kind: "observe", name: "work/case_decision", payload: {
      id: item.id, obligation_key: authorityCaseKey(input.log.events, item.id),
      case_event_seq: last.seq, policy: "execution-earned-v1",
      ...decideCaseHistory(item, input.plan.require_red_first === true, runs, events),
    } });
  }
  const cleared: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    input.log.refresh();
    const view = viewPlan(input.plan, input.log.events);
    for (const todo of input.plan.todos) {
      const managedCases = input.plan.cases.filter(item => (item.measurement !== undefined || managedCaseIds.has(item.id)) && caseTodo(input.plan, item) === todo.id);
      if (managedCases.some(item => !green.includes(item.id)) || cleared.includes(todo.id) || !canClear(view, todo.id)) {
        continue;
      }
      if (clearTodo(input.log, input.plan, todo.id)) {
        cleared.push(todo.id);
        progressed = true;
      }
    }
  }
  return { green, red, bornGreen, cleared };
}

function recordedCaseIds(plan: WorkPlan, events: readonly EventRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const item of plan.cases) {
    const scenario = plan.scenarios.find((candidate) => candidate.id === item.scenario);
    if (currentCaseEvidence(item, scenario, events).length > 0) ids.add(item.id);
  }
  return ids;
}

/**
 * Runs one case command on the host that owns its code. Returning a plain
 * exit/stdout/stderr keeps the ssh service out of the verifier's imports: the
 * caller that already holds an approved ssh session supplies the dispatch.
 */
export type CaseRemoteRunner = (
  host: string,
  command: string,
  options?: { readonly timeoutSeconds?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function runCase(
  command: string,
  cwd: string,
  log: EventLog,
  policy: SandboxPolicy,
  host?: string,
  remote?: CaseRemoteRunner,
  dir?: string,
  timeoutSeconds?: number,
  signals?: CaseSignals,
): Promise<boolean> {
  return !(await executeCase(command, cwd, log, policy, host, remote, dir, timeoutSeconds, signals)).error;
}

async function executeCase(
  command: string,
  cwd: string,
  log: EventLog,
  policy: SandboxPolicy,
  host?: string,
  remote?: CaseRemoteRunner,
  dir?: string,
  timeoutSeconds?: number,
  signals?: CaseSignals,
  /** Bars the plan fixed for this case; handed to the run, never looked up. */
  thresholds?: Readonly<Record<string, string>>,
  /** Local accelerator intent does not change the host-sealed sandbox policy. */
  localAccelerator?: boolean,
  resultAdapter?: RunnerResultAdapter,
  /** One digest cache per verify step: the second digest of an unchanged tree
   * is free, so an N-case pass re-hashes only what a case touched. Absent:
   * the session's own (its base's coverage, C1). */
  suppliedReceiptCache?: DigestCache,
): Promise<ToolOutcome> {
  const receiptCache = suppliedReceiptCache ?? sessionDigestCache(log, cwd);
  const cmd = command.trim();
  // THE allowlist lives in validate.ts (plan seal and runner share it);
  // a case may only be red after it actually executes.
  if (!isAllowedCaseCommand(cmd)) {
    return { error: true, text: "case command is not registered" };
  }
  if (host !== undefined) {
    if (!SSH_ALIAS_PATTERN.test(host)) {
      return { error: true, text: `case host must be an enrolled ssh alias, not a coordinate` };
    }
    if (!remote) {
      // Falling back to local bash would judge the case on a machine that does
      // not hold its code — a red for the wrong reason. Say so instead.
      return {
        error: true,
        text: `case runs on host ${host}, but no ssh session is wired to this run`,
      };
    }
  }
  // executeTool's runner is synchronous, so the remote round trip resolves
  // first and the runner just hands back what the host reported.
  // The plan owns the bars, so the run is handed them: a small file beside the
  // case log, named in the command's environment. Nothing to sync, and no copy
  // of the plan that a run could edit into passing (case-run-process.ts).
  const barsScript = writeBarsScript(cmd, thresholds);
  if (barsScript) {
    if (host !== undefined && remote) {
      await remote(host, barsScript, { timeoutSeconds: 30 }).catch(() => undefined);
    } else {
      // A local case was handed no bars at all: the file the run reads through
      // DOKKABI_CASE_BARS was only ever written on the far side of an ssh
      // call, so a declared threshold silently judged nothing whenever the
      // work ran on this machine (case-run-process.ts).
      writeLocalBars(cmd, thresholds);
    }
  }
  const barsEnv = barsScript ? `DOKKABI_CASE_BARS=${caseBarsPath(cmd)}` : undefined;
  const launched = withBarsEnv(cmd, barsScript ? cmd : undefined);
  // Every execution is evidence (redesign memo §12 item 4): the host's own
  // case runs mint the same receipt the model's bash executions mint, in
  // every mode — a receipt is an observation, not a policy. The image is the
  // tree the command is about to run on, digested before the run starts.
  const caseStartedAt = Date.now();
  const imageBefore = workspaceDigest(cwd, receiptCache);
  const unknownBefore = receiptCache.lastUnknown;
  // Model-declared accelerator intent never grants host execution. All local
  // cases pass through executeTool's effect-first, policy-enforced runner.
  const landed = host !== undefined && remote
    ? signals !== undefined
      // A case that said what finishing looks like is launched and then
      // watched, so a long honest run is not cut off by a guessed clock and a
      // run that already failed is not waited out.
      // One heavy run per host at a time: several checkpoint loads sharing a
      // unified-memory box is what starved and then killed the last pair.
      ? await withHostRunLock(host, () => runWatched({ host, cmd, env: barsEnv, dir, remote, signals, timeoutSeconds, log }))
      : await remote(
        host,
        // The directory is path data on the remote side (case-launch.ts).
        caseLaunch(dir, launched),
        timeoutSeconds === undefined ? undefined : { timeoutSeconds },
      )
    : undefined;
  // The driver path runs every case through the single live/replay branch
  // point: effect first, fenced spawn, digest-carrying end (issue #7).
  const caseCommand = resultAdapter ? resultAdapter.command(cmd) : cmd;
  const executedCommand = localAccelerator === true && host === undefined
    ? caseLaunch(dir, withBarsEnv(caseCommand, barsScript ? cmd : undefined))
    : caseCommand;
  if (resultAdapter) log.append({ kind: "observe", name: "work/runner_invocation", payload: {
    command, adapter: resultAdapter.id, adapter_digest: resultAdapter.digest,
    executed_command_digest: createHash("sha256").update(executedCommand).digest("hex"),
  } });
  const seqBefore = log.lastSeq;
  const outcome = executeTool({
    log,
    policy,
    mode: "live",
    call: { id: `case-${argDigestOf(command)}`, name: "bash", args: { command: executedCommand } },
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }),
    ...(landed ? { run: () => landed } : {}),
  });
  // Mint the receipt for this execution: the case's declared command bytes
  // (what the completion verdict matches), the exit code, and the workspace
  // image before and after. The exec reference is the sandbox/exec row this
  // run just appended. A missing exit code means the run never completed, so
  // there is no execution outcome to authenticate.
  if (outcome.exitCode !== undefined) {
    const execRow = log.events.filter((event) => event.name === "sandbox/exec" && event.seq > seqBefore).at(-1);
    mintReceipt({
      log,
      image_before: imageBefore,
      image_after: workspaceDigest(cwd, receiptCache),
      command,
      exit_code: outcome.exitCode,
      stdout: outcome.text,
      stderr: "",
      duration_ms: Date.now() - caseStartedAt,
      isolation: "live-workspace",
      digest_kind: "workspace-tree",
      exec_ref: execRow ? { seq: execRow.seq, hash: execRow.hash } : null,
      names: { result: "verify/result", receipt: "verify/receipt" },
      unknown: { before: unknownBefore, after: receiptCache.lastUnknown },
    });
  }
  return outcome;
}


/**
 * Launch a case's command detached on its host, then watch its log until the
 * run says something. This is what makes the declared signals real: a long
 * honest run is not cut off by a guessed clock, and a run that already failed
 * is not waited out for an answer that will not improve.
 */
/**
 * Pass or fail, read from the line the done signal matched — the run's own
 * summary. Grepping the whole tail for "error" failed a passing run because a
 * diagnostic printed max_error=0.000008 on the way to "1 passed".
 */
function verdictExitCode(output: string, doneWhen: string | undefined): number {
  let summary: string | undefined;
  if (doneWhen) {
    try {
      const pattern = new RegExp(doneWhen, "iu");
      for (const line of output.split(/\r?\n/u)) {
        if (pattern.test(line)) summary = line;
      }
    } catch {
      summary = undefined;
    }
  }
  const judged = summary ?? output;
  return /\b\d+ (?:failed|errors?)\b/iu.test(judged) ? 1 : 0;
}

async function runWatched(input: {
  readonly host: string;
  readonly cmd: string;
  /** Prefixed to the executed command only; paths stay keyed by `cmd`. */
  readonly env?: string;
  readonly dir?: string;
  readonly remote: CaseRemoteRunner;
  readonly signals: CaseSignals;
  readonly timeoutSeconds?: number;
  readonly log?: EventLog;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { host, cmd, dir, remote, signals } = input;
  // Reap whatever the last run of this case left behind before starting
  // another. Two large model loads sharing one box is how a previous attempt's
  // orphan starved this one and the kernel killed them both.
  const started = await remote(
    host,
    launchScript({ command: cmd, ...(dir ? { dir } : {}), ...(input.env ? { env: input.env } : {}) }),
    { timeoutSeconds: 60 },
  );
  const startedAt = performance.now();
  // The ceiling starts where the case declared it and grows only while the
  // run keeps counting (telemetry-watchdog.ts).
  const lease = openTelemetryLease(signals.ceilingMs, startedAt);
  let previous: string | undefined;
  let lastChangeAt = startedAt;
  let output = "";
  let failedFirstSeenAt: number | undefined;
  // Markers scroll. A gate that prints its substrate and witnesses right after
  // loading and then produces minutes of progress pushes them out of the
  // bounded tail, and a run that genuinely passed reads as unreported. The
  // watcher sees every intermediate tail, so it keeps the last marker line of
  // each kind it has seen.
  const markers = new Map<string, string>();
  const harvest = (text: string): void => {
    for (const line of text.split(/\r?\n/u)) {
      const m = /^(substrate|witness):/iu.exec(line.trim());
      if (m) markers.set(m[1]!.toLowerCase(), line.trim());
    }
  };
  const finish = async (
    exitCode: number,
    text: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    // Read the log once more before reaping. A poll lands mid-print: one
    // failing gate's stored tail stopped inside the traceback's source
    // excerpt, so the assertion message and the summary line were never
    // kept — and the excerpt happened to show the test's own verdict text,
    // the literal string "PASSED: ...", which the model then believed for
    // six turns while the harness held the case red.
    const finalRead = await remote(host, pollScript(cmd), { timeoutSeconds: 60 })
      .then((poll) => parsePoll(poll.stdout).output)
      .catch(() => undefined);
    const ended = mergeFinalRead(text, finalRead);
    // Never walk away from a running process: the next attempt would launch a
    // second one beside it.
    await remote(host, reapScript(cmd), { timeoutSeconds: 60 }).catch(() => undefined);
    const kept = [...markers.values()].filter((line) => !ended.includes(line));
    return { exitCode, stdout: kept.length > 0 ? `${kept.join("\n")}\n${ended}` : ended, stderr: "" };
  };
  void started;
  while (true) {
    const poll = await remote(host, pollScript(cmd), { timeoutSeconds: 60 });
    const parsed = parsePoll(poll.stdout);
    output = parsed.output;
    harvest(output);
    if (previous !== undefined && output !== previous) lastChangeAt = performance.now();
    // A kernel kill is the harness's to recognise: no case author should have
    // to anticipate it, and polling a process that no longer exists until a
    // stall window expires helps nobody.
    const killed = harnessFailureReason(output);
    if (killed) {
      // The kernel's verdict says WHAT; the scene says WHY. Without it, an
      // OOM caused by a neighbor process reads as a defect in the case.
      const scene = await remote(host, deathSceneScript(), { timeoutSeconds: 30 })
        .then((probe) => formatDeathScene(probe.stdout))
        .catch(() => "");
      return finish(1, `${output}\n[case failed] ${killed}${scene ? `\n${scene}` : ""}`);
    }
    // Track when the failure signal first matched, so the decision can give
    // a failing-but-alive run a bounded grace to finish printing its
    // traceback instead of reaping it mid-sentence.
    if (signals.failedWhen && failedFirstSeenAt === undefined) {
      try {
        if (new RegExp(signals.failedWhen, "iu").test(output)) failedFirstSeenAt = performance.now();
      } catch {
        // a bad pattern matches nothing
      }
    }
    // What the run has counted decides how much longer it may count. An
    // advance renews the lease; a counter that has stopped moving while the
    // output keeps arriving ends the run before its ceiling.
    const telemetry = observeTelemetry(lease, {
      output,
      now: performance.now(),
      elapsedMs: performance.now() - startedAt,
      ...(signals.telemetryPattern ? { customPattern: signals.telemetryPattern } : {}),
    });
    if (telemetry.extended) {
      input.log?.append({
        kind: "observe",
        name: "case/telemetry_advance",
        payload: {
          kind: telemetry.mark?.kind ?? "unknown",
          mark: (telemetry.mark?.mark ?? "").slice(0, 120),
          extensions: lease.extensions,
          ceiling_ms: Math.round(telemetry.ceilingMs),
        },
      });
    }
    if (telemetry.abort) {
      return finish(1, `${output}\n[case no_progress] ${telemetry.abort}`);
    }
    const decision = caseWaitDecision({
      output,
      ...(previous === undefined ? {} : { previousOutput: previous }),
      elapsedMs: performance.now() - startedAt,
      sinceChangeMs: performance.now() - lastChangeAt,
      ...(signals.doneWhen ? { doneWhen: signals.doneWhen } : {}),
      ...(signals.failedWhen ? { failedWhen: signals.failedWhen } : {}),
      stallAfterMs: signals.stallAfterMs ?? 300_000,
      ceilingMs: telemetry.ceilingMs,
      processAlive: parsed.alive,
      ...(failedFirstSeenAt === undefined
        ? {}
        : { failedForMs: performance.now() - failedFirstSeenAt }),
    });
    previous = output;
    if (decision.verdict === "done") {
      // The run finished; its own summary line decides green or red.
      return finish(verdictExitCode(output, signals.doneWhen), output);
    }
    if (decision.verdict === "exited") {
      // The run is over; its output decides, and a run that concluded nothing
      // is a red with that exact reason rather than a fifteen-minute stall.
      return finish(
        verdictExitCode(output, signals.doneWhen),
        `${output}
[case exited] ${decision.reason ?? ""}`,
      );
    }
    if (decision.verdict !== "continue") {
      return finish(1, `${output}\n[case ${decision.verdict}] ${decision.reason ?? ""}`);
    }
    if (!(await sleepReferenced(signals.pollIntervalMs))) {
      return finish(1, output);
    }
  }
}

/** A referenced timer: an unreferenced one let the runtime leave mid-wait. */
function sleepReferenced(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), Math.max(0, ms));
  });
}


function argDigestOf(command: string): string {
  return command.replaceAll(/[^a-z0-9]+/gi, "-").slice(0, 24) || "cmd";
}
