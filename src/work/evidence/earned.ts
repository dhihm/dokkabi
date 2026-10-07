import { projectExperimentCondition } from "../../eval/experiment/condition.ts";
import { EarnedProjectionIndex } from "./earned-projection-index.ts";
import { experimentRuntime } from "../../plugins/experiment-runtime.ts";
import { scopeWorkEvents, currentCaseEvidence, workCaseDigest } from "../scope.ts";
import { workExecutionIdentitySchema, workExecutionBodySchema, type WorkExecutionIdentity } from "./schema.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { EventLog } from "../../host/event-log.ts";
import { currentSessionSchemaPayload, projectSessionReplaySchemas, type EventRecord, type EventInput } from "../../host/schema.ts";
import { canonicalJson } from "../../host/canonical.ts";
import { BlobStore } from "../../host/blob-store.ts";
import { captureRunnerContracts } from "./authority.ts";
import { authorityCaseKey, INITIAL_REGRESSION_POLICY, projectObligations, projectPlanDrafts, type PlanDraft } from "./obligations.ts";
import { evidenceDigest } from "./contract.ts";
import { localAcceleratedDirectory } from "../case-run-process.ts";
import { matchingCaseRunner } from "../case-runners.ts";
import { captureRemoteSnapshot } from "./remote-snapshot.ts";
import type { Case, WorkPlan } from "../schema.ts";
import type { PreparedFixture } from "./fixture-prepare.ts";
import { withFixtureFileReader, FixtureFileError } from "./fixture-files.ts";
import type { RecordedOutput } from "../../tools/recorded-output.ts";
import type { SandboxPolicy } from "../../host/sandbox.ts";
import { captureCaseEnvironment, caseEnvironmentContract } from "./case-environment.ts";
import { validateRunnerResults } from "../results/evidence.ts";
import { activeCheckerFollowup, hasAdmittedCheckerRevision, observeRevisionCurrent, revisionCurrentMatches, revisionForCase } from "./checker-revision.ts";

export const EARNED_POLICY = "execution-earned-v1";
export const EARNED_START = "work/execution_start";
export const EARNED_END = "work/execution_end";
export const EARNED_CURRENT = "work/execution_current";
export const EARNED_ROLE = "work/resume_grant";
export type ExecutionIdentity = WorkExecutionIdentity;
export type CaseExecution = ExecutionIdentity & { seq: number; hash: string };
type FileIdentity = { path: string; mode: number; digest: string; link?: string; directory?: true };
type ExecutionInput = { log: EventLog; plan: WorkPlan; cwd: string; draft?: PlanDraft };
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Host-side file acquisition. A workspace fingerprint is not a protected
 * checker: managed execution retains the stronger existing fixture boundary. */
function inventory(root: string, paths: readonly string[], omitted: readonly string[]): FileIdentity[] {
  return withFixtureFileReader(root, readFile => {
    const files: FileIdentity[] = [], visited = new Set<string>();
    const skip = (path: string): boolean => omitted.some(value => path === value || path.startsWith(value + "/"));
    const walk = (path: string): void => {
      if (skip(path) || visited.has(path)) return;
      visited.add(path);
      const full = join(root, path); const stat = lstatSync(full);
      if (stat.isDirectory()) {
        files.push({ path: path || ".", mode: stat.mode & 0o777, digest: hash("directory"), directory: true });
        for (const child of readdirSync(full).sort()) walk(path ? path + "/" + child : child);
        return;
      }
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(full), target = realpathSync(full), rel = relative(root, target);
        if (rel === ".." || rel.startsWith("../")) throw new FixtureFileError("execution_input_link_escape", path);
        files.push({ path, mode: stat.mode & 0o777, digest: hash(link), link });
        return;
      }
      if (!stat.isFile()) throw new Error("execution input is not a regular file: " + path);
      const acquired = readFile(path);
      files.push({ path, mode: acquired.mode, digest: hash(acquired.bytes) });
      if (files.length > 100000) throw new Error("execution input inventory exceeds its bound");
    };
    for (const path of paths) if (existsSync(join(root, path))) walk(path);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  });
}

/** Capture installed evaluator inputs conservatively, without inferring a
 * complete module graph from import syntax or reusing an mtime cache. */
export function captureEvaluatorInputs(workspace?: string, workspaceFiles?: FileIdentity[]) {
  const root = realpathSync(resolve(dirname(import.meta.path), "../../.."));
  const paths = ["src", "node_modules", "package.json", "bun.lock", "bun.lockb", "bunfig.toml", "tsconfig.json"];
  const files = workspace === root && workspaceFiles
    ? workspaceFiles.filter(row => paths.some(path => row.path === path || row.path.startsWith(path + "/")))
    : inventory(root, paths, []);
  return { files, runtime: hash(readFileSync(process.execPath)), policy: EARNED_POLICY };
}

export function captureCaseExecution(input: ExecutionInput, item: Case,
  phase: ExecutionIdentity["phase"], prepared?: PreparedFixture, policy?: SandboxPolicy): { identity: ExecutionIdentity; body: string } {
  if (input.draft && (phase !== "baseline" || canonicalJson(input.plan) !== canonicalJson(input.draft.snapshot.plan)
    || canonicalJson(captureRunnerContracts(input.plan)) !== canonicalJson(input.draft.snapshot.runners))) {
    throw new Error("draft execution contract changed");
  }
  const obligationKey = input.draft
    ? input.draft.snapshot.obligations.find(row => row.kind === "case" && row.alias === item.id)?.key
    : authorityCaseKey(input.log.events, item.id);
  const file = matchingCaseRunner(item.command)?.testFile(item.command);
  const runner = captureRunnerContracts(input.plan)[item.id];
  if (!file || !runner) throw new Error("execution input authority is unavailable");
  if (item.host) {
    // The transport reports an outcome, not a sealed remote filesystem.
    // Operator regression/guard checks can consume fresh process results;
    // strict implementation evidence requires a candidate snapshot instead.
    const evaluator = captureEvaluatorInputs();
    // A git checkout on the host can be read exactly (remote-snapshot.ts);
    // then the case carries the same checker/candidate pair a local one does.
    const snapshot = captureRemoteSnapshot(item.host, item.dir, file);
    if (snapshot) {
      const checker = { kind: "remote-checker-inputs-v1", host: item.host, dir: item.dir ?? null, command: item.command, files: snapshot.checker_files };
      const workspaceDigest = evidenceDigest(snapshot.workspace_files);
      const identity: ExecutionIdentity = {
        schema_version: 1, policy: EARNED_POLICY, obligation_key: obligationKey ?? "",
        workspace: `remote:${item.host}:${item.dir ?? "."}`, workspace_digest: workspaceDigest,
        command: item.command, checker_digest: evidenceDigest(checker), candidate_digest: workspaceDigest,
        runner_digest: evidenceDigest(runner), evaluator_digest: evidenceDigest(evaluator),
        environment_digest: evidenceDigest({ kind: "unobserved-remote-environment" }),
        protection: "remote_sealed", phase,
      };
      workExecutionIdentitySchema.parse(identity);
      return { identity, body: canonicalJson({ checker, candidate: workspaceDigest, workspace_files: snapshot.workspace_files, evaluator }) };
    }
    const checker = { kind: "remote-reported-v1", host: item.host, dir: item.dir ?? null, command: item.command };
    const workspaceDigest = evidenceDigest([]);
    const identity: ExecutionIdentity = {
      schema_version: 1, policy: EARNED_POLICY, obligation_key: obligationKey ?? "",
      workspace: `remote:${item.host}:${item.dir ?? "."}`, workspace_digest: workspaceDigest,
      command: item.command, checker_digest: evidenceDigest(checker), candidate_digest: workspaceDigest,
      runner_digest: evidenceDigest(runner), evaluator_digest: evidenceDigest(evaluator),
      environment_digest: evidenceDigest({ kind: "unobserved-remote-environment" }),
      protection: "remote_reported", phase,
    };
    workExecutionIdentitySchema.parse(identity);
    return { identity, body: canonicalJson({ checker, candidate: workspaceDigest, workspace_files: [], evaluator }) };
  }
  const workspace = realpathSync(item.local_accelerator === true
    ? localAcceleratedDirectory(input.cwd, item.dir) : resolve(input.cwd));
  const omission = [".git", ".dokkabi-home",
    relative(workspace, realpathSync(input.log.path)), relative(workspace, join(dirname(realpathSync(input.log.path)), "blobs"))].filter(value => value && !value.startsWith(".."));
  const checkerRoot = dirname(file) === "." ? file : dirname(file);
  const checkerPaths = [checkerRoot, "package.json", "bun.lock", "bun.lockb", "bunfig.toml", "tsconfig.json",
    "pyproject.toml", "pytest.ini", "setup.cfg", "conftest.py", "node_modules", ".venv"];
  // Acquire each file once per phase. Checker and candidate identities refer
  // to the same retained file manifest, not repeated traversals or stat caches.
  const workspaceFiles = inventory(workspace, [""], omission);
  const workspaceDigest = evidenceDigest(workspaceFiles);
  const evaluator = captureEvaluatorInputs(workspace, workspaceFiles);
  const evaluatorJson = canonicalJson(evaluator);
  const protectedFixture = prepared?.receipt.checker_protection === "ablated" ? undefined : prepared;
  const checker = protectedFixture ? protectedFixture.manifest : item.measurement ?? {
    kind: "workspace-checker-inputs-v1", paths: checkerPaths,
    manifest_digest: evidenceDigest(workspaceFiles.filter(row => checkerPaths.some(path => row.path === path || row.path.startsWith(path + "/")))),
  };
  const candidate = protectedFixture ? protectedFixture.receipt.candidate_digest : workspaceDigest;
  const environment = protectedFixture ? undefined : captureCaseEnvironment(item.local_accelerator ? undefined : policy);
  const identity: ExecutionIdentity = {
    schema_version: 1, policy: EARNED_POLICY, obligation_key: obligationKey ?? "",
    workspace, workspace_digest: workspaceDigest, command: item.command, checker_digest: evidenceDigest(checker),
    candidate_digest: String(candidate),
    runner_digest: evidenceDigest(runner), evaluator_digest: hash(evaluatorJson),
    environment_digest: evidenceDigest(environment ? caseEnvironmentContract(environment) : protectedFixture!.manifest.environment),
    protection: protectedFixture ? "managed" : "workspace", phase,
  };
  workExecutionIdentitySchema.parse(identity);
  return { identity, body: canonicalJson({ candidate, checker, evaluator, workspace_files: workspaceFiles, ...(environment ? { environment } : {}) }) };
}

export function beginCaseExecution(input: ExecutionInput, item: Case,
  phase: ExecutionIdentity["phase"], prepared?: PreparedFixture, policy?: SandboxPolicy): CaseExecution {
  experimentRuntime(input.log);
  const { identity, body } = captureCaseExecution(input, item, phase, prepared, policy);
  const store = BlobStore.forSession(input.log.path);
  if (!projectSessionReplaySchemas(input.log.events).featureStart.has("work-earned-v1")) {
    input.log.append({ kind: "observe", name: "session/open", payload: currentSessionSchemaPayload() });
  }
  const blob = store.putAndAppend(input.log, { kind: "observe", name: EARNED_START,
    payload: { ...identity, ...(input.draft ? { draft_ref: draftReference(input.draft) } : {}) } }, body);
  const row = input.log.events.at(-1)!;
  if (row.payload.blob !== blob) throw new Error("execution input append was not retained");
  return { ...identity, seq: row.seq, hash: row.hash };
}

export function finishCaseExecution(input: ExecutionInput, item: Case,
  start: CaseExecution | undefined, prepared?: PreparedFixture, policy?: SandboxPolicy): string | undefined {
  if (!start) return "execution_inputs_unavailable";
  try {
    const { identity, body } = captureCaseExecution(input, item, start.phase, prepared, policy);
    const reason = !sameContract(start, { ...identity, seq: start.seq, hash: start.hash }, input.log.events)
      ? "execution_contract_changed_during_run"
      : identity.workspace_digest !== start.workspace_digest ? "execution_candidate_changed_during_run" : undefined;
    BlobStore.forSession(input.log.path).putAndAppend(input.log, { kind: "observe", name: EARNED_END,
      payload: { ...identity, execution_start: start.seq, status: reason ? "refused" : "stable", ...(reason ? { reason } : {}) } }, body);
    return reason;
  } catch (error) {
    input.log.append({ kind: "observe", name: EARNED_END, payload: { execution_start: start.seq, status: "refused", reason: "execution_inputs_unavailable_after_run", detail: String(error) } });
    return "execution_inputs_unavailable_after_run";
  }
}

export function executionFields(start: CaseExecution | undefined, recorded: RecordedOutput,
  qualifyingRed: boolean, reason?: string): Record<string, unknown> {
  return { earned_policy: EARNED_POLICY, ...(start ? { execution_start: start.seq, execution_hash: start.hash } : {}),
    qualifying_red: recorded.ok && recorded.exitCode === 1 && qualifyingRed,
    ...(reason ? { earned_refusal: reason } : {}),
  };
}

export function usesEarnedEvidence(events: readonly EventRecord[]): boolean {
  return events.some(event => event.name === EARNED_START || event.payload.earned_policy === EARNED_POLICY
    || (event.name === "session/open" && Array.isArray(event.payload.replay_features) && event.payload.replay_features.includes("work-earned-v1")));
}

export function executionFor(row: EventRecord, events: readonly EventRecord[], preparingDraft = false): CaseExecution | undefined {
  return executionForProjection(row, new EarnedProjectionIndex(events), preparingDraft);
}

function executionForProjection(row: EventRecord, index: EarnedProjectionIndex, preparingDraft = false): CaseExecution | undefined {
  const events = index.events;
  const p = row.payload;
  if (p.draft_ref && !preparingDraft) {
    const admitted = index.drafts().find(draft => canonicalJson(draftReference(draft)) === canonicalJson(p.draft_ref)
      && draft.result?.payload.status === "admitted");
    const refs = admitted?.result?.payload.case_refs as { seq: number; hash: string }[] | undefined;
    if (!refs?.some(ref => ref.seq === row.seq && ref.hash === row.hash)) return undefined;
  }
  if (p.execution_start !== undefined && index.usedBefore(p.execution_start as number, row.seq)) return undefined;
  if (p.earned_policy !== EARNED_POLICY || typeof p.execution_start !== "number") return undefined;
  const start = index.reference(p.execution_start, EARNED_START, p.execution_hash);
  const end = start && index.firstEnd(start.seq);
  if (!start || !end || end.payload.status !== "stable" || end.seq >= row.seq
    || !sameContract({ ...start.payload, seq: start.seq, hash: start.hash } as CaseExecution,
      { ...end.payload, seq: end.seq, hash: end.hash } as CaseExecution, events, index)
    || end.payload.candidate_digest !== start.payload.candidate_digest || end.payload.workspace_digest !== start.payload.workspace_digest) return undefined;
  const policyRef = p.experiment_policy as { seq?: number; hash?: string } | undefined;
  const policyRow = policyRef && index.reference(policyRef.seq, undefined, policyRef.hash);
  const policy = policyRow && policyRow.seq < row.seq && policyRow.hash === policyRef!.hash ? policyRow : undefined;
  if (p.evidence_source === "protected_observer") {
    const sample = index.rows("measurement/result").find(event => event.name === "measurement/result" && event.payload.session_id === p.measurement_session
      && event.payload.blob === (p.measurement_ref as { digest?: string } | undefined)?.digest);
    const receipt = index.rows("evaluation/receipt").find(event => event.name === "evaluation/receipt" && event.payload.receipt_id === p.receipt_id);
    const decision = index.rows("evidence/decision").find(event => event.name === "evidence/decision" && event.payload.receipt_id === p.receipt_id);
    const experimental = index.condition().binding !== undefined;
    if (experimental && (!policy || policy.name !== "experiment/measurement_policy" || policy.payload.session_id !== p.measurement_session
      || policy.payload.result_digest !== sample?.payload.blob)) return undefined;
    const effectiveStatus = experimental ? (policy?.payload.decision as { status?: string } | undefined)?.status : sample?.payload.status;
    if (!sample || !receipt || !decision || !(start.seq < sample.seq && sample.seq < receipt.seq && receipt.seq < decision.seq && decision.seq < end.seq && end.seq < row.seq)
      || decision.payload.status !== "admissible" || start.payload.obligation_key !== p.obligation_key
      || start.payload.command !== p.command || effectiveStatus !== (p.status === "green" ? "passed" : "failed")) return undefined;
    return { ...start.payload, seq: start.seq, hash: start.hash } as CaseExecution;
  }
  const output = index.reference(p.result_seq, "tool/result", p.result_hash);
  if (!output || start.seq >= output.seq || output.seq >= end.seq || start.payload.obligation_key !== p.obligation_key
    || start.payload.command !== p.command || output.payload.error !== (output.payload.exit_code !== 0)
    || p.evidence_refusal || p.earned_refusal || p.unrunnable) return undefined;
  const invocation = index.rows("work/runner_invocation").find(event => event.name === "work/runner_invocation" && event.seq > start.seq
    && event.seq < output.seq && event.payload.command === p.command);
  if (invocation || p.runner_result_ref !== undefined) {
    if (!p.runner_result_ref) return undefined;
    const ref = p.runner_result_ref as { seq?: unknown; hash?: unknown };
    const result = index.reference(ref.seq, "work/runner_result", ref.hash);
    const outcome = result?.payload.outcome as { green?: boolean; qualifying_red?: boolean } | undefined;
    if (!invocation || !result || result.seq >= row.seq || result.payload.result_seq !== output.seq || result.payload.result_hash !== output.hash
      || result.payload.adapter !== invocation.payload.adapter || result.payload.adapter_digest !== invocation.payload.adapter_digest
      || result.payload.case_id !== p.id || result.payload.command !== p.command
      || (p.status === "green" ? outcome?.green !== true : p.qualifying_red === true && outcome?.qualifying_red !== true)) return undefined;
  }
  if (start.payload.phase === "verify" && output.payload.exit_code === 0 && index.condition().binding) {
    if (!policy || policy.name !== "experiment/case_policy" || policy.payload.case_id !== p.id || policy.payload.result_seq !== output.seq
      || policy.payload.result_hash !== output.hash || policy.payload.duration_ms !== p.duration_ms || policy.payload.host_label !== p.host_label
      || ((policy.payload.decision as { active_reason?: string | null }).active_reason == null) !== (p.status === "green")) return undefined;
  }
  if (row.payload.status === "green" && (output.payload.exit_code !== 0 || output.payload.error !== false)) return undefined;
  if (row.payload.status === "red" && output.payload.exit_code !== 1) return undefined;
  return { ...start.payload, seq: start.seq, hash: start.hash } as CaseExecution;
}

export function draftReference(draft: PlanDraft): { seq: number; hash: string } {
  return { seq: draft.event.seq, hash: draft.event.hash };
}

/** Authenticate one whole initial attempt before it can establish obligations.
 * Refused attempts stay observable but cannot donate a receipt to a later one. */
export function validateDraftExecutions(draft: PlanDraft, events: readonly EventRecord[]): { seq: number; hash: string }[] {
  return draftAdmissionEvidence(draft, events).case_refs;
}

type DraftCaseRef = { seq: number; hash: string };
type InitialRegressionRef = { case: DraftCaseRef; anchors: DraftCaseRef[] };

/** Supplemental authority comes from the whole native draft, with a RED on
 * the same implementation todo or an explicit verification dependency. */
export function draftAdmissionEvidence(draft: PlanDraft, events: readonly EventRecord[]): {
  case_refs: DraftCaseRef[]; supplemental_refs?: InitialRegressionRef[];
} {
  const plan = draft.snapshot.plan;
  if (!plan.cases.length || !plan.todos.length || !plan.scenarios.length || plan.cases.some(item => item.guard)
    || projectExperimentCondition(events).binding) throw new Error("initial draft lacks an ordinary implementation contract");
  const prefix = events.filter(row => row.seq < (draft.result?.seq ?? Infinity));
  const runs = prefix.filter(row => row.seq > draft.event.seq && row.name === "work/case" && row.payload.status !== undefined
    && canonicalJson(row.payload.draft_ref) === canonicalJson(draftReference(draft)));
  if (runs.length !== plan.cases.length) throw new Error("initial draft needs one complete native run per case");
  const workspaces = new Map<string, string>();
  const supplemental = draft.event.payload.supplemental_policy === INITIAL_REGRESSION_POLICY && draft.event.payload.resume !== true;
  const case_refs = plan.cases.map(item => {
    const matching = runs.filter(row => row.payload.id === item.id);
    const row = matching[0], execution = row && executionFor(row, prefix, true);
    const start = execution && prefix.find(value => value.seq === execution.seq);
    const preflight = row && prefix.find(value => value.name === "work/case_preflight" && value.seq < row.seq
      && value.payload.execution_start === execution?.seq && value.payload.id === item.id);
    const key = draft.snapshot.obligations.find(value => value.kind === "case" && value.alias === item.id)?.key;
    const scenario = plan.scenarios.find(value => value.id === item.scenario);
    if (matching.length !== 1 || !row || !execution || !start || !preflight || start.seq <= draft.event.seq
      || row.payload.case_digest !== workCaseDigest(item, scenario)
      || canonicalJson(start.payload.draft_ref) !== canonicalJson(draftReference(draft))
      || execution.phase !== "baseline" || (execution.protection !== "workspace" && execution.protection !== "remote_sealed") || execution.obligation_key !== key
      || execution.command !== item.command || execution.runner_digest !== evidenceDigest(draft.snapshot.runners[item.id])
      || !(row.payload.status === "red" && row.payload.qualifying_red === true && preflight.payload.status === "red"
        || row.payload.status === "green" && preflight.payload.status === "green"
          && (supplemental || draft.event.payload.resume === true && preflight.payload.resumed === true))) {
      throw new Error(`initial draft case ${item.id} lacks its native qualifying reproduction`);
    }
    const previous = workspaces.get(execution.workspace);
    if (previous && previous !== execution.workspace_digest) throw new Error("initial draft candidate changed between cases");
    workspaces.set(execution.workspace, execution.workspace_digest);
    return { seq: row.seq, hash: row.hash };
  });
  if (!supplemental) return { case_refs };
  const todoFor = (id: string) => plan.scenarios.find(row => row.id === plan.cases.find(item => item.id === id)?.scenario)?.todo;
  const red = runs.filter(row => row.payload.status === "red" && row.payload.qualifying_red === true);
  const anchorsFor = (todoId: string | undefined, visited = new Set<string>()): EventRecord[] => {
    if (!todoId || visited.has(todoId)) return [];
    visited.add(todoId);
    const own = red.filter(row => todoFor(String(row.payload.id)) === todoId);
    if (own.length) return own;
    const todo = plan.todos.find(row => row.id === todoId);
    return todo?.class === "verify" ? todo.blocked_by.flatMap(id => anchorsFor(id, visited)) : [];
  };
  for (const todo of plan.todos) if (!anchorsFor(todo.id).length) {
    throw new Error(`initial draft todo ${todo.id} lacks its native qualifying reproduction or verification dependency`);
  }
  const supplemental_refs = runs.filter(row => row.payload.status === "green").map(row => {
    const anchors = anchorsFor(todoFor(String(row.payload.id)));
    if (!anchors.length) throw new Error(`initial draft case ${row.payload.id} lacks its native qualifying reproduction or verification dependency`);
    return { case: { seq: row.seq, hash: row.hash }, anchors: anchors.map(value => ({ seq: value.seq, hash: value.hash })) };
  });
  return { case_refs, supplemental_refs };
}

function hasInitialRegressionRole(current: CaseExecution, last: EventRecord, index: EarnedProjectionIndex,
  execution: (row: EventRecord) => CaseExecution | undefined): boolean {
  const events = index.events;
  for (const draft of index.drafts()) {
    if (draft.result?.payload.status !== "admitted" || draft.result.seq >= last.seq
      || draft.event.payload.supplemental_policy !== INITIAL_REGRESSION_POLICY) continue;
    if (!Array.isArray(draft.result.payload.supplemental_refs) || !draft.result.payload.supplemental_refs.length) continue;
    const evidence = draftAdmissionEvidence(draft, events);
    if (canonicalJson(evidence.supplemental_refs) !== canonicalJson(draft.result.payload.supplemental_refs)) {
      throw new Error("initial draft regression authority differs from native execution");
    }
    if (evidence.supplemental_refs?.some(ref => {
      const row = index.reference(ref.case.seq, undefined, ref.case.hash);
      const original = row && execution(row);
      return original && sameContract(original, current, events, index);
    })) return true;
  }
  return false;
}

function sameContract(a: CaseExecution, b: CaseExecution, events: readonly EventRecord[] = [], index = new EarnedProjectionIndex(events)): boolean {
  const authority = index.removes("bar_pinning") ? index.obligations().authority : undefined;
  const lineage = authority?.current?.plan.cases.find(item => {
    const keys = index.keys(item.id); return keys.includes(a.obligation_key) && keys.includes(b.obligation_key);
  });
  const measurementCheckers = lineage && authority!.snapshots.flatMap(row => {
    const item = row.value.plan.cases.find(item => item.id === lineage.id);
    return item?.measurement ? [evidenceDigest(item.measurement)] : [];
  });
  return ["obligation_key", "workspace", "command", "checker_digest", "runner_digest", "evaluator_digest", "environment_digest", "protection"]
    .filter(key => key !== "obligation_key" || !lineage)
    .filter(key => key !== "checker_digest" || !index.removes("managed_tests"))
    .filter(key => key !== "checker_digest" || !(measurementCheckers?.includes(a.checker_digest) && measurementCheckers.includes(b.checker_digest)))
    .every(key => a[key as keyof CaseExecution] === b[key as keyof CaseExecution]);
}

export type EarnedCaseDecision = {
  status: "red" | "green" | "unearned" | "unavailable";
  reason: string;
  receipt_ref?: { seq: number; hash: string };
  baseline_ref?: { seq: number; hash: string };
  role?: "implementation" | "guard" | "regression" | "resume" | "ablation" | "supplemental";
};

/** One pure policy for verifier, drive, clear and recorded graph projection.
 * first_run and a caller-provided RED label do not confer authority. */
export function decideCaseHistory(item: Case, strict: boolean, runs: readonly EventRecord[], events: readonly EventRecord[]): EarnedCaseDecision {
  return createEarnedProjectionInternal(events).decideCaseHistory(item, strict, runs);
}

function decideCaseHistoryProjection(item: Case, strict: boolean, runs: readonly EventRecord[], index: EarnedProjectionIndex,
  execution: (row: EventRecord) => CaseExecution | undefined, followup: () => ReturnType<typeof activeCheckerFollowup>): EarnedCaseDecision {
  const events = index.events;
  const last = runs.at(-1);
  if (!last) return { status: "unavailable", reason: "case_not_executed" };
  const current = execution(last);
  if (!current) return { status: "unavailable", reason: String(last.payload.earned_refusal ?? "execution_receipt_unavailable") };
  const receipt_ref = { seq: last.seq, hash: last.hash };
  const latestInput = index.latestInput(current.workspace);
  if (latestInput && latestInput.payload.workspace_digest !== current.workspace_digest) return {
    status: "unavailable", reason: latestInput.payload.workspace_digest ? "candidate_changed" : "candidate_observation_unavailable", receipt_ref,
  };
  const original = runs.map(row => execution(row)).find(value => value !== undefined);
  const revision = index.rows("work/checker_revision").length ? revisionForCase(events, last) : undefined;
  if (revision && last.payload.status === "green") return { status: "green", reason: "retained_checker_revision_verified", receipt_ref,
    role: revision.item.role, ...(revision.item.baseline ? { baseline_ref: revision.item.baseline } : {}) };
  if (followup() && last.payload.status === "red" && last.payload.qualifying_red === true) return {
    status: "red", reason: "qualifying_followup_assertion_failure", receipt_ref,
  };
  if (index.rows("work/checker_revision").length && hasAdmittedCheckerRevision(events, current.obligation_key)) return { status: "unavailable", reason: "checker_revision_verification_required", receipt_ref };
  if (original && !sameContract(original, current, events, index)) return { status: "unavailable", reason: "checker_contract_changed", receipt_ref };
  if (current.protection === "remote_reported" && strict && !item.guard) {
    return { status: "unavailable", reason: "remote_candidate_not_sealed", receipt_ref };
  }
  if (last.payload.status === "red") return last.payload.qualifying_red === true
    ? { status: "red", reason: "qualifying_assertion_failure", receipt_ref }
    : { status: "unavailable", reason: "failure_did_not_qualify", receipt_ref };
  if (last.payload.status !== "green") return { status: "unavailable", reason: "unknown_case_outcome", receipt_ref };
  const resume = index.rows(EARNED_ROLE).some(event => {
    if (event.name !== EARNED_ROLE || event.kind !== "effect" || event.seq >= last.seq) return false;
    const preflight = index.reference(event.payload.preflight_seq, "work/case_preflight");
    const start = preflight && index.reference(preflight.payload.execution_start, EARNED_START);
    return preflight !== undefined && preflight.payload.status === "green" && preflight.payload.resumed === true
      && preflight.seq < event.seq && start !== undefined && start.payload.obligation_key === current.obligation_key
      && event.payload.obligation_key === current.obligation_key && event.payload.checker_digest === current.checker_digest
      && event.payload.runner_digest === current.runner_digest && event.payload.workspace === current.workspace
      && sameContract({ ...start.payload, seq: start.seq, hash: start.hash } as CaseExecution, current, events, index);
  });
  const ablatedRed = index.removes("red_first");
  const role = ablatedRed ? "ablation" : !strict ? "regression" : item.guard ? "guard" : resume ? "resume"
    : hasInitialRegressionRole(current, last, index, execution) ? "supplemental" : "implementation";
  if (role !== "implementation") return { status: "green", reason: ablatedRed ? "registered_red_first_ablation"
    : role === "supplemental" ? "admitted_initial_regression_verified" : "authorized_first_pass_role", receipt_ref, role };
  const baseline = runs.find(row => {
    const prior = execution(row);
    return row.seq < last.seq && row.payload.status === "red" && row.payload.qualifying_red === true
      && prior !== undefined && sameContract(prior, current, events, index) && prior.workspace_digest !== current.workspace_digest;
  });
  return baseline ? { status: "green", reason: "earned_after_baseline", receipt_ref, role, baseline_ref: { seq: baseline.seq, hash: baseline.hash } }
    : { status: "unearned", reason: "qualifying_prechange_baseline_required", receipt_ref, role };
}

export function earnedCaseStatus(item: Case, strict: boolean, runs: readonly EventRecord[], events: readonly EventRecord[]): "red" | "green" | undefined {
  const status = decideCaseHistory(item, strict, runs, events).status;
  return status === "red" || status === "green" ? status : undefined;
}

export type EarnedProjection = Pick<ReturnType<typeof createEarnedProjectionInternal>, "executionFor" | "decideCaseHistory" | "earnedCaseStatus">;

/** Acquire only for this synchronous read. A different prefix or a fresh read
 * must acquire again; supplied receipts must belong to this exact snapshot. */
export function createEarnedProjection(events: readonly EventRecord[]): EarnedProjection {
  return createEarnedProjectionInternal(events, true);
}

function createEarnedProjectionInternal(events: readonly EventRecord[], bound = false) {
  const index = new EarnedProjectionIndex(events);
  const executions = new Map<EventRecord, CaseExecution | undefined>();
  let followupRead = false, followupValue: ReturnType<typeof activeCheckerFollowup>;
  const followup = () => {
    if (!followupRead) { followupValue = activeCheckerFollowup(index.events); followupRead = true; }
    return followupValue;
  };
  const execution = (row: EventRecord, preparingDraft = false): CaseExecution | undefined => {
    if (bound) index.requireMember(row);
    if (preparingDraft) return executionForProjection(row, index, true);
    if (!executions.has(row)) executions.set(row, executionForProjection(row, index));
    return executions.get(row);
  };
  const decide = (item: Case, strict: boolean, runs: readonly EventRecord[]): EarnedCaseDecision => {
    if (bound) for (const row of runs) index.requireMember(row);
    return decideCaseHistoryProjection(item, strict, runs, index, execution, followup);
  };
  return { executionFor: execution, decideCaseHistory: decide,
    earnedCaseStatus: (item: Case, strict: boolean, runs: readonly EventRecord[]): "red" | "green" | undefined => {
      const status = decide(item, strict, runs).status;
      return status === "red" || status === "green" ? status : undefined;
    } };
}

/** Observe whether an authenticated local receipt still describes the world.
 * This does not dispatch a case or manufacture a second result from its receipt. */
export function observeCurrentCase(input: { log: EventLog; plan: WorkPlan; cwd: string }, item: Case,
  policy: SandboxPolicy, expected: "red" | "green"): EventRecord {
  return input.log.append(captureCurrentCase(input, item, policy, expected));
}

/** Retain body bytes without acquiring the log lock. A terminal transaction can
 * append this observation and its decision together through its existing batch. */
export function captureCurrentCase(input: { log: EventLog; plan: WorkPlan; cwd: string }, item: Case,
  policy: SandboxPolicy, expected: "red" | "green"): EventInput {
  if (item.host || item.local_accelerator || item.measurement) throw new Error("work_current_requires_local_workspace_case");
  const scoped = scopeWorkEvents(input.plan, input.log.events);
  const runs = currentCaseEvidence(item, input.plan.scenarios.find(row => row.id === item.scenario), scoped);
  const decision = decideCaseHistory(item, input.plan.require_red_first === true, runs, scoped);
  const receipt = runs.at(-1), previous = receipt && executionFor(receipt, input.log.events);
  if (decision.status !== expected || !previous || previous.protection !== "workspace") throw new Error(`work_current_${decision.reason}`);
  const { identity, body } = captureCaseExecution(input, item, previous.phase, undefined, policy);
  const checkerCurrent = observeRevisionCurrent(input.log, receipt!);
  const imageCurrent = revisionCurrentMatches(input.log.events, receipt!, checkerCurrent);
  const current = sameContract(previous, { ...identity, seq: previous.seq, hash: previous.hash }, input.log.events)
    && previous.workspace_digest === identity.workspace_digest && previous.candidate_digest === identity.candidate_digest
    && imageCurrent;
  const blob = BlobStore.forSession(input.log.path).put(body);
  return { kind: "observe", name: EARNED_CURRENT, payload: { ...identity, case_id: item.id,
    receipt_ref: decision.receipt_ref, expected, current, ...(checkerCurrent ? { checker_current: checkerCurrent } : {}), blob, blob_bytes: Buffer.byteLength(body) } };
}

/** Pure validation also used at replay/terminal boundaries. Recorded current
 * observations bind the exact receipt and obligation, never just a green label. */
export function validateCurrentCase(event: EventRecord, events: readonly EventRecord[]): boolean {
  const prefix = events.filter(row => row.seq < event.seq);
  const plan = projectObligations(prefix).current?.plan;
  const item = plan?.cases.find(row => row.id === event.payload.case_id);
  if (!plan || !item || event.name !== EARNED_CURRENT) throw new Error("work current lacks a bound case");
  const scoped = scopeWorkEvents(plan, prefix);
  const runs = currentCaseEvidence(item, plan.scenarios.find(row => row.id === item.scenario), scoped);
  const decision = decideCaseHistory(item, plan.require_red_first === true, runs, scoped);
  const receipt = runs.at(-1), previous = receipt && executionFor(receipt, prefix);
  if (!previous || previous.protection !== "workspace" || !["green", "red"].includes(String(event.payload.expected))
    || decision.status !== event.payload.expected || canonicalJson(decision.receipt_ref) !== canonicalJson(event.payload.receipt_ref)) {
    throw new Error("work current receipt is not authenticated");
  }
  const imageCurrent = revisionCurrentMatches(prefix, receipt!, event.payload.checker_current);
  const current = sameContract(previous, { ...event.payload, seq: event.seq, hash: event.hash } as CaseExecution, prefix)
    && previous.workspace_digest === event.payload.workspace_digest && previous.candidate_digest === event.payload.candidate_digest
    && imageCurrent;
  if (current !== event.payload.current) throw new Error("work current differs from retained inputs");
  return current;
}


/** Authenticate one retained native execution body against its row. Both
 * full earned replay and formal-context judgement use this exact boundary. */
export function authenticateEarnedExecutionBody(event: EventRecord, bodies: ReadonlyMap<string, unknown>) {
  const { blob, blob_bytes, execution_start: _start, status: _status, reason: _reason, draft_ref: _draft,
    case_id: _case, receipt_ref: _receipt, expected: _expected, current: _current, checker_current: _checkerCurrent, ...raw } = event.payload;
  if (_checkerCurrent !== undefined && event.name !== EARNED_CURRENT) throw new Error("checker current requires a currentness observation");
  const identity = workExecutionIdentitySchema.parse(raw);
  if (typeof blob !== "string" || !bodies.has(blob)) throw new Error("earned input body missing");
  const body = workExecutionBodySchema.parse(bodies.get(blob));
  const text = canonicalJson(body);
  if (hash(text) !== blob || Buffer.byteLength(text) !== blob_bytes) throw new Error("earned input body integrity mismatch");
  if (evidenceDigest(body.evaluator) !== identity.evaluator_digest || evidenceDigest(body.checker) !== identity.checker_digest || evidenceDigest(body.workspace_files) !== identity.workspace_digest
    || body.candidate !== identity.candidate_digest) throw new Error("earned input identity mismatch");
  if (body.environment && evidenceDigest(caseEnvironmentContract(body.environment)) !== identity.environment_digest) throw new Error("earned environment identity mismatch");
  const checker = body.checker as { kind?: unknown; paths?: unknown; manifest_digest?: unknown } | null;
  if (checker && checker.kind === "workspace-checker-inputs-v1") {
    if (!Array.isArray(checker.paths) || !checker.paths.every(path => typeof path === "string")) throw new Error("checker paths invalid");
    const paths = checker.paths as string[];
    if (checker.manifest_digest !== evidenceDigest(body.workspace_files.filter(row => paths.some(path => row.path === path || row.path.startsWith(path + "/"))))) throw new Error("checker input manifest mismatch");
  }
  if ((identity.protection === "workspace" || identity.protection === "remote_sealed") && identity.candidate_digest !== identity.workspace_digest) throw new Error("workspace candidate mismatch");
  return body;
}

/** Read-only authentication of the retained input manifests and execution links.
 * Incomplete starts remain visible; they cannot supply a case verdict. */
export function projectEarnedInputs(events: readonly EventRecord[], bodies: ReadonlyMap<string, unknown> = new Map()) {
  validateRunnerResults(events, bodies);
  const drafts = projectPlanDrafts(events);
  for (const draft of drafts) if (draft.result?.payload.status === "admitted") {
    const evidence = draftAdmissionEvidence(draft, events);
    if (canonicalJson(evidence.case_refs) !== canonicalJson(draft.result.payload.case_refs)
      || canonicalJson(evidence.supplemental_refs) !== canonicalJson(draft.result.payload.supplemental_refs)) {
      throw new Error("plan draft admission differs from native execution");
    }
  }
  const starts = new Map<number, EventRecord>();
  const ended = new Set<number>();
  const references: { seq: number; name: string; payload: Record<string, unknown> }[] = [];
  const feature = projectSessionReplaySchemas(events).featureStart.get("work-earned-v1");
  for (const event of events) {
    if (![EARNED_START, EARNED_END, EARNED_CURRENT, EARNED_ROLE, "work/case_decision"].includes(event.name)) continue;
    if (feature === undefined || event.seq < feature) throw new Error("earned evidence precedes its feature generation");
    references.push({ seq: event.seq, name: event.name, payload: structuredClone(event.payload) });
    if (event.name === EARNED_ROLE) {
      if (event.kind !== "effect") throw new Error("resume role requires host effect authority");
      const preflight = events.find(row => row.seq === event.payload.preflight_seq && row.name === "work/case_preflight");
      if (!preflight || preflight.seq >= event.seq || preflight.payload.status !== "green" || preflight.payload.resumed !== true) throw new Error("resume grant lacks its actual preflight");
      continue;
    }
    if (event.name === "work/case_decision") {
      if (event.kind !== "observe" || event.payload.policy !== EARNED_POLICY) throw new Error("unknown earned decision");
      const row = events.find(row => row.seq === event.payload.case_event_seq && row.name === "work/case");
      if (!row || row.seq >= event.seq || row.payload.obligation_key !== event.payload.obligation_key) throw new Error("earned decision case reference mismatch");
      const prefix = events.filter(row => row.seq < event.seq);
      const plan = projectObligations(prefix).current?.plan;
      const item = plan?.cases.find(item => item.id === event.payload.id);
      if (!plan || !item) throw new Error("earned decision has no bound case");
      const scoped = scopeWorkEvents(plan, prefix);
      const runs = currentCaseEvidence(item, plan.scenarios.find(row => row.id === item.scenario), scoped);
      if (runs.at(-1)?.seq !== row.seq) throw new Error("earned decision is not current");
      const { id: _id, obligation_key: _key, case_event_seq: _seq, policy: _policy, ...decision } = event.payload;
      if (canonicalJson(decision) !== canonicalJson(decideCaseHistory(item, plan.require_red_first === true, runs, scoped))) {
        throw new Error("earned decision differs from execution history");
      }
      continue;
    }
    if (event.kind !== "observe") throw new Error("execution input must be an observation");
    if (event.name === EARNED_END) {
      const seq = event.payload.execution_start;
      if (typeof seq !== "number" || !starts.has(seq) || ended.has(seq)) throw new Error("execution end has no unique start");
      ended.add(seq);
      if (event.payload.status === "refused" && event.payload.blob === undefined) {
        if (typeof event.payload.reason !== "string") throw new Error("execution refusal has no reason");
        continue;
      }
      if (!["stable", "refused"].includes(String(event.payload.status))) throw new Error("execution end has unknown status");
    }
    const { blob, blob_bytes, execution_start: _start, status: _status, reason: _reason, draft_ref,
      case_id: _case, receipt_ref: _receipt, expected: _expected, current: _current, checker_current: _checkerCurrent, ...raw } = event.payload;
    if (_checkerCurrent !== undefined && event.name !== EARNED_CURRENT) throw new Error("checker current requires a currentness observation");
    const identity = workExecutionIdentitySchema.parse(raw);
    if (draft_ref !== undefined) {
      const draft = drafts.find(value => canonicalJson(draftReference(value)) === canonicalJson(draft_ref));
      const item = draft?.snapshot.plan.cases.find(value => value.command === identity.command
        && draft.snapshot.obligations.some(obligation => obligation.kind === "case" && obligation.alias === value.id && obligation.key === identity.obligation_key));
      if (!draft || !item || event.name !== EARNED_START || identity.phase !== "baseline" || draft.event.seq >= event.seq
        || draft.result && draft.result.seq <= event.seq || identity.runner_digest !== evidenceDigest(draft.snapshot.runners[item.id])) {
        throw new Error("execution is not bound to its proposed draft");
      }
    }
    authenticateEarnedExecutionBody(event, bodies);
    if (event.name === EARNED_CURRENT) validateCurrentCase(event, events);
    else if (event.name === EARNED_START) starts.set(event.seq, event);
    else if (event.payload.status === "stable") {
      const start = starts.get(Number(event.payload.execution_start))!;
      if (!sameContract({ ...start.payload, seq: start.seq, hash: start.hash } as CaseExecution, { ...identity, seq: event.seq, hash: event.hash }, events)
        || start.payload.workspace_digest !== identity.workspace_digest) throw new Error("stable execution changed its inputs");
    }
  }
  return { references, incomplete: [...starts.keys()].filter(seq => !ended.has(seq)) };
}
