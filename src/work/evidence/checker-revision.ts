import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import { BlobStore } from "../../host/blob-store.ts";
import { observeImageTrees } from "../../host/execution-image.ts";
import type { EventLog } from "../../host/event-log.ts";
import type { EventInput, EventRecord } from "../../host/schema.ts";
import type { ExecutionViews } from "../../plugins/execution-view.ts";
import type { SandboxExecutionResult } from "../../host/sandbox.ts";
import { evidenceDigest } from "./contract.ts";
import { caseEnvironmentContract } from "./case-environment.ts";
import { projectExecutionViews, validateExecutionImage, type ExecutionImage } from "./execution-view.ts";
import { workExecutionBodySchema } from "./schema.ts";
import { authorityCaseKey, projectObligations } from "./obligations.ts";
import { executionFor, decideCaseHistory, type CaseExecution } from "./earned.ts";
import { currentCaseEvidence, scopeWorkEvents } from "../scope.ts";
import type { Case, WorkPlan } from "../schema.ts";
import type { RunnerResultAdapter } from "../results/contract.ts";
import { readPytestOutcome, pytestResultAdapter } from "../results/pytest.ts";

export const CHECKER_SOURCE = "work/checker_source";
export const CHECKER_FOLLOWUP = "work/checker_followup";
export const CHECKER_PROBE = "work/checker_probe";
export const CHECKER_REVISION = "work/checker_revision";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ref = z.object({ seq: z.number().int().nonnegative(), hash: digest }).strict();
type Ref = z.infer<typeof ref>;
const reference = (row: EventRecord): Ref => ({ seq: row.seq, hash: row.hash });
const lookup = (events: readonly EventRecord[], value: Ref, name: string): EventRecord => {
  const row = events.find(row => row.seq === value.seq && row.hash === value.hash && row.name === name);
  if (!row) throw new Error("checker_revision_reference_missing");
  return row;
};
const sourceSchema = z.object({ start: ref, end: ref, before: ref, after: ref, image: digest, trees_digest: digest, paths: z.array(z.string()).min(1) }).strict();
const followupSchema = z.object({ parent: digest, scope_seq: z.number().int().positive(), receipts: z.array(ref).min(1) }).strict();
const probeSchema = z.object({ result: ref, image: digest, command: z.string(), executed_command: z.string(),
  adapter: z.string().nullable(), adapter_digest: digest.nullable(), status: z.enum(["green", "red", "invalid"]),
  qualifying_red: z.boolean(), red_means: z.string() }).strict();
const caseRevisionSchema = z.object({ current: ref, source: ref, original: ref, previous: z.array(ref),
  baseline: ref.nullable(), role: z.enum(["implementation", "supplemental", "guard", "regression", "resume"]),
  checker_role: z.enum(["implementation", "supplemental"]), paths: z.array(z.string()).min(1) }).strict();
const revisionSchema = z.object({ schema_version: z.literal(1), authority: digest, scope_seq: z.number().int().positive(),
  followup: ref, basis: ref, image: digest, cases: z.array(caseRevisionSchema).min(1) }).strict();
const checkerSchema = z.object({ kind: z.literal("workspace-checker-inputs-v1"), paths: z.array(z.string()).min(1), manifest_digest: digest }).strict();
function supportedCase(item: Case): boolean {
  return !item.host && !item.local_accelerator && !item.measurement && !item.thresholds && !item.substrate
    && item.min_duration_ms === undefined && item.done_when === undefined && item.failed_when === undefined
    && item.stall_after_ms === undefined && item.telemetry_pattern === undefined && item.witness_for === undefined;
}

/** This is the same complete workspace manifest used by earned evidence.
 * Git and the sandbox's private home are retained in the image, separately
 * from the pre-existing ordinary-work candidate digest contract. */
function imageWorkspace(image: ExecutionImage) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return image.trees[0]!.entries.filter(row => ![".git", ".dokkabi-home"].some(path => row.path === path || row.path.startsWith(path + "/")))
    .map(row => row.kind === "file" ? { path: row.path, mode: row.mode, digest: row.sha256 }
      : row.kind === "directory" ? { path: row.path, mode: row.mode, digest: hash("directory"), directory: true }
      : { path: row.path, mode: 0o777, digest: hash(row.target), link: row.target })
    .sort((a, b) => a.path.localeCompare(b.path));
}
function readBody(log: EventLog, row: EventRecord): unknown {
  return JSON.parse(BlobStore.forSession(log.path).get(String(row.payload.blob)));
}
function imageFromLog(log: EventLog, image: string): ExecutionImage {
  const row = log.events.find(row => row.name === "execution_view/image" && row.payload.blob === image);
  if (!row) throw new Error("checker_revision_image_missing");
  return validateExecutionImage(readBody(log, row));
}
function sourceFor(events: readonly EventRecord[], execution: CaseExecution): EventRecord | undefined {
  return events.find(row => row.name === CHECKER_SOURCE && (row.payload.start as Ref)?.seq === execution.seq
    && (row.payload.start as Ref)?.hash === execution.hash);
}
function admittedCheckerSources(events: readonly EventRecord[], execution: CaseExecution, before: number): EventRecord[] {
  return events.filter(row => row.name === CHECKER_SOURCE && row.seq < before).filter(row => {
    const p = sourceSchema.parse(row.payload), start = lookup(events, p.start, "work/execution_start");
    if (start.payload.obligation_key !== execution.obligation_key) return false;
    const run = events.find(row => row.name === "work/case" && row.payload.execution_start === start.seq);
    const baseline = run && executionFor(run, events)?.phase === "baseline";
    const admitted = events.some(revision => revision.name === CHECKER_REVISION && revision.seq < before
      && revisionSchema.parse(revision.payload).cases.some(item => item.source.seq === row.seq && item.source.hash === row.hash));
    return baseline || admitted;
  });
}
export function captureCheckerImage(views?: ExecutionViews): string | undefined {
  const result = views?.capture();
  return result?.status === "retained" ? result.digest : undefined;
}
export function observeCheckerImage(views: ExecutionViews | undefined, image: string): Ref | null {
  const result = views?.observe(image);
  return result?.status === "observed" && result.matched ? result.reference : null;
}
/** A source receipt is attached only after both the real execution and the
 * complete before/after image agree. Acquisition failure cannot invent one. */
export function retainCheckerSource(log: EventLog, start: CaseExecution | undefined, image: string | undefined,
  views?: ExecutionViews, finalObservation?: Ref | null): void {
  if (!start || start.protection !== "workspace" || !image || !views) return;
  const end = log.events.find(row => row.name === "work/execution_end" && row.payload.execution_start === start.seq);
  if (!end || end.payload.status !== "stable") return;
  const after = finalObservation === undefined ? observeCheckerImage(views, image) : finalObservation;
  const beforeRecord = [...log.events].reverse().find(row => row.name === "execution_view/image" && row.payload.blob === image && row.seq < start.seq);
  const afterRecord = after && lookup(log.events, after, "execution_view/observation");
  const body = workExecutionBodySchema.parse(readBody(log, lookup(log.events, start, "work/execution_start")));
  const manifest = imageFromLog(log, image), evaluator = body.evaluator as { runtime?: unknown } | null;
  if (!beforeRecord || !afterRecord || afterRecord.seq <= end.seq || afterRecord.payload.image !== image || afterRecord.payload.matched !== true
    || evidenceDigest(imageWorkspace(manifest)) !== start.workspace_digest) {
    log.append({ kind: "observe", name: "work/checker_refused", payload: { reason: "checker_source_changed", execution_start: start.seq } });
    return;
  }
  if (!manifest.private_roots || manifest.runtime !== evaluator?.runtime || start.environment_digest !== evidenceDigest(caseEnvironmentContract({
    kind: "sealed-child-environment-v1", variables: manifest.environment, private_roots: manifest.private_roots,
  }))) {
    log.append({ kind: "observe", name: "work/checker_refused", payload: { reason: "checker_source_contract_mismatch", execution_start: start.seq } });
    return;
  }
  const checker = checkerSchema.safeParse(body.checker);
  if (!checker.success) return;
  log.append({ kind: "observe", name: CHECKER_SOURCE, payload: {
    start: { seq: start.seq, hash: start.hash }, end: reference(end), before: reference(beforeRecord), after: reference(afterRecord),
    image, trees_digest: evidenceDigest(manifest.trees), paths: checker.data.paths,
  } });
}

/** Called before the reviewer proposal can change any checker. The receipt
 * grants followup evaluation, never a model-authored guard or retirement. */
export function checkerFollowupInput(events: readonly EventRecord[], plan: WorkPlan): EventInput | undefined {
  const authority = projectObligations(events).current;
  if (!authority || canonicalJson(authority.plan) !== canonicalJson(plan) || plan.cases.some(item => !supportedCase(item))
    || events.some(row => row.name === "experiment/bind")) return undefined;
  const scoped = scopeWorkEvents(plan, events), receipts: Ref[] = [];
  for (const item of plan.cases) {
    const runs = currentCaseEvidence(item, plan.scenarios.find(row => row.id === item.scenario), scoped);
    const decision = decideCaseHistory(item, plan.require_red_first === true, runs, scoped);
    if (decision.status !== "green" || !decision.receipt_ref || executionFor(runs.at(-1)!, events)?.protection !== "workspace") return undefined;
    receipts.push(decision.receipt_ref);
  }
  return receipts.length ? { kind: "effect", name: CHECKER_FOLLOWUP,
    payload: { parent: authority.digest, scope_seq: authority.scope_seq, receipts } } : undefined;
}
export function activeCheckerFollowup(events: readonly EventRecord[]): EventRecord | undefined {
  const authority = projectObligations(events).current;
  const grant = [...events].reverse().find(row => row.name === CHECKER_FOLLOWUP && row.payload.scope_seq === authority?.scope_seq);
  if (!grant || events.some(row => row.seq > grant.seq && row.name === "work/authority_patch")
    || !events.some(row => row.seq > grant.seq && row.name === "work/step" && row.payload.action === "accept_replan_admitted")) return undefined;
  return grant;
}
export function hasAdmittedCheckerRevision(events: readonly EventRecord[], obligation: string): boolean {
  return events.some(row => row.name === CHECKER_REVISION && revisionSchema.parse(row.payload).cases.some(item =>
    lookup(events, item.current, "work/case").payload.obligation_key === obligation));
}
export function probeStatus(process: SandboxExecutionResult, changed: boolean, adapter: string | null,
  qualifies: (output: string) => boolean): { status: "green" | "red" | "invalid"; qualifying_red: boolean } {
  if (changed || process.rawExitCode === null || process.signal || process.error || process.timedOut || process.maxBufferExceeded || process.completionUnavailable) return { status: "invalid", qualifying_red: false };
  const text = `${process.stdout}${process.stderr}`.trim();
  const native = adapter === "pytest-report-v1" ? readPytestOutcome(text, process.exitCode) : undefined;
  const green = process.exitCode === 0 && (!adapter || native?.green === true);
  const red = process.exitCode === 1 && (adapter ? native?.qualifying_red === true : qualifies(text));
  return { status: green ? "green" : red ? "red" : "invalid", qualifying_red: red };
}

export function revisionForCase(events: readonly EventRecord[], current: EventRecord) {
  for (const row of [...events].reverse()) if (row.name === CHECKER_REVISION && row.kind === "effect") {
    const value = revisionSchema.parse(row.payload), authority = projectObligations(events).current;
    if (value.scope_seq !== authority?.scope_seq || row.seq <= current.seq) continue;
    const item = value.cases.find(item => item.current.seq === current.seq && item.current.hash === current.hash);
    if (item) { validateRevisionProof(value, events.filter(event => event.seq < row.seq)); return { event: row, value, item }; }
  }
  return undefined;
}
const currentSchema = z.object({ image: digest, trees_digest: digest.nullable() }).strict();
export function observeRevisionCurrent(log: EventLog, receipt: EventRecord): z.infer<typeof currentSchema> | undefined {
  const revision = revisionForCase(log.events, receipt);
  if (!revision) return undefined;
  const image = revision.value.image;
  try { return { image, trees_digest: observeImageTrees(imageFromLog(log, image), BlobStore.forSession(log.path)) }; }
  catch { return { image, trees_digest: null }; }
}
export function revisionCurrentMatches(events: readonly EventRecord[], receipt: EventRecord, observation: unknown): boolean {
  const revision = revisionForCase(events, receipt);
  if (!revision) {
    if (observation !== undefined) throw new Error("checker_current_without_revision");
    return true;
  }
  const value = currentSchema.parse(observation), source = lookup(events, revision.item.source, CHECKER_SOURCE);
  return value.image === revision.value.image && value.trees_digest === source.payload.trees_digest;
}

function validateRevisionProof(p: z.infer<typeof revisionSchema>, events: readonly EventRecord[]): void {
  const authority = projectObligations(events).current, grant = lookup(events, p.followup, CHECKER_FOLLOWUP);
  if (authority?.digest !== p.authority || authority.scope_seq !== p.scope_seq || grant.payload.scope_seq !== p.scope_seq
    || activeCheckerFollowup(events)?.seq !== grant.seq || authority.plan.cases.some(item => !supportedCase(item))) throw new Error("checker_revision_authority_binding");
  const basis = lookup(events, p.basis, "work/case"), basisStart = executionFor(basis, events);
  const basisSource = basisStart && sourceFor(events, basisStart);
  if (!basisStart || basisStart.phase !== "baseline" || !basisSource || basis.seq >= grant.seq || basis.seq < p.scope_seq
    || basis.payload.qualifying_red !== true) throw new Error("checker_revision_original_source_unavailable");
  const parentPrefix = events.filter(row => row.seq < grant.seq), parentAuthority = projectObligations(parentPrefix).current;
  if (!parentAuthority || parentAuthority.digest !== grant.payload.parent) throw new Error("checker_revision_parent_missing");
  const parentEvents = scopeWorkEvents(parentAuthority.plan, parentPrefix), scoped = scopeWorkEvents(authority.plan, events);
  const greenItems = authority.plan.cases.filter(item => {
    const run = currentCaseEvidence(item, authority.plan.scenarios.find(row => row.id === item.scenario), scoped).at(-1);
    return run?.payload.status === "green" && executionFor(run, events);
  });
  if (p.cases.length !== greenItems.length) throw new Error("checker_revision_coverage_binding");
  for (const [index, revision] of p.cases.entries()) {
    const item = greenItems[index]!;
    const current = lookup(events, revision.current, "work/case"), start = executionFor(current, events);
    const source = lookup(events, revision.source, CHECKER_SOURCE), original = lookup(events, revision.original, CHECKER_PROBE);
    const runs = currentCaseEvidence(item, authority.plan.scenarios.find(row => row.id === item.scenario), scoped);
    if (!start || start.protection !== "workspace" || current.seq !== runs.at(-1)?.seq || current.seq <= grant.seq
      || start.obligation_key !== authorityCaseKey(events, item.id) || current.payload.status !== "green"
      || source.payload.image !== p.image || sourceFor(events, start)?.seq !== source.seq
      || canonicalJson(source.payload.paths) !== canonicalJson(revision.paths)) throw new Error("checker_revision_receipt_binding");
    const contract = authority.runners[item.id] as { result_adapter?: { id: string; digest: string } };
    const validProbe = (probe: EventRecord, candidate: string, checker: string): boolean => {
      const value = probeSchema.parse(probe.payload);
      const composition = events.find(row => row.name === "execution_view/composition" && row.seq < probe.seq
        && row.payload.image === value.image && row.payload.candidate === candidate && row.payload.checker === checker
        && canonicalJson(row.payload.paths) === canonicalJson(revision.paths));
      return !!composition && probe.seq > source.seq && value.command === item.command && value.red_means === item.red_means
        && value.adapter === (contract.result_adapter?.id ?? null) && value.adapter_digest === (contract.result_adapter?.digest ?? null);
    };
    if (!validProbe(original, String(basisSource.payload.image), p.image) || original.payload.status === "invalid") throw new Error("checker_revision_original_probe_binding");
    const prior = admittedCheckerSources(events, start, source.seq);
    for (const previous of prior) {
      const old = lookup(events, sourceSchema.parse(previous.payload).start, "work/execution_start");
      for (const key of ["workspace", "command", "runner_digest", "evaluator_digest", "environment_digest", "protection"] as const) {
        if (old.payload[key] !== start[key]) throw new Error("checker_revision_execution_contract_changed");
      }
      if (canonicalJson(previous.payload.paths) !== canonicalJson(revision.paths)) throw new Error("checker_revision_closure_changed");
    }
    const checkers = [...new Set(prior.map(row => String(row.payload.image)))];
    if (revision.previous.length !== checkers.length || revision.previous.some((value, i) => {
      const probe = lookup(events, value, CHECKER_PROBE);
      return probe.payload.status !== "green" || !validProbe(probe, p.image, checkers[i]!);
    })) throw new Error("checker_revision_prior_checks_missing");
    const parentItem = parentAuthority.plan.cases.find(item => authorityCaseKey(parentPrefix, item.id) === start.obligation_key);
    const parentDecision = parentItem && decideCaseHistory(parentItem, parentAuthority.plan.require_red_first === true,
      currentCaseEvidence(parentItem, parentAuthority.plan.scenarios.find(row => row.id === parentItem.scenario), parentEvents), parentEvents);
    const checkerRole = original.payload.qualifying_red === true ? "implementation" : "supplemental";
    const role = parentDecision?.role ?? (item.guard ? "guard" : !authority.plan.require_red_first ? "regression" : checkerRole);
    const baseline = role === "implementation" ? parentDecision?.baseline_ref ?? revision.original : null;
    if (parentItem && (parentDecision?.status !== "green" || !prior.length)
      || revision.checker_role !== checkerRole || revision.role !== role || canonicalJson(revision.baseline) !== canonicalJson(baseline)) throw new Error("checker_revision_role_binding");
  }
}

/** Evaluate a complete revision atomically. Every prior retained checker for
 * each live obligation must pass the delivered candidate. The new checker
 * also runs on the original candidate; its result has its own honest role. */
export function auditCheckerRevision(input: { log: EventLog; plan: WorkPlan; views?: ExecutionViews; image?: string;
  adapter(item: Case): RunnerResultAdapter | undefined; qualifies(output: string, item: Case): boolean; timeout(item: Case): number }): void {
  const { log, plan, views, image } = input;
  const followup = activeCheckerFollowup(log.events), authority = projectObligations(log.events).current;
  if (!followup || !authority) return;
  if (plan.cases.every(item => {
    const scoped = scopeWorkEvents(plan, log.events), runs = currentCaseEvidence(item, plan.scenarios.find(row => row.id === item.scenario), scoped);
    return decideCaseHistory(item, plan.require_red_first === true, runs, scoped).status === "green";
  })) return;
  const refuse = (reason: string) => log.append({ kind: "observe", name: "work/checker_refused", payload: { reason } });
  if (!views || !image) { refuse("checker_revision_source_unavailable"); return; }
  try {
    const grant = followupSchema.parse(followup.payload);
    const parentRows = grant.receipts.map(value => lookup(log.events, value, "work/case"));
    const originalRows = log.events.filter(row => row.name === "work/case" && row.seq < followup.seq && row.seq >= authority.scope_seq)
      .filter(row => row.payload.qualifying_red === true && executionFor(row, log.events)?.phase === "baseline");
    const basis = originalRows.find(row => {
      const start = executionFor(row, log.events); return start && sourceFor(log.events, start);
    });
    const basisStart = basis && executionFor(basis, log.events), basisSource = basisStart && sourceFor(log.events, basisStart);
    if (!basis || !basisStart || !basisSource) throw new Error("checker_revision_original_source_unavailable");
    const originalImage = String(basisSource.payload.image);
    const currentManifest = imageFromLog(log, image);
    const revisions: z.infer<typeof caseRevisionSchema>[] = [];
    const probe = (item: Case, candidate: string, checker: string, paths: readonly string[]) => {
      const composition = views.compose({ candidate, checker, paths });
      if (composition.status !== "retained") throw new Error(composition.reason);
      const adapter = input.adapter(item), executed = adapter ? adapter.command(item.command.trim()) : item.command.trim();
      const result = views.execute({ image: composition.digest, command: executed, timeoutMs: input.timeout(item) });
      if (result.status !== "executed") throw new Error(result.reason);
      const status = probeStatus(result.process, result.changed, adapter?.id ?? null, text => input.qualifies(text, item));
      return log.append({ kind: "observe", name: CHECKER_PROBE, payload: { result: result.result, image: composition.digest,
        command: item.command, executed_command: executed, adapter: adapter?.id ?? null, adapter_digest: adapter?.digest ?? null,
        ...status, red_means: item.red_means } });
    };
    for (const item of plan.cases) {
      if (!supportedCase(item)) throw new Error("checker_revision_case_unsupported");
      const scoped = scopeWorkEvents(plan, log.events), runs = currentCaseEvidence(item, plan.scenarios.find(row => row.id === item.scenario), scoped);
      const current = runs.at(-1), start = current && executionFor(current, log.events);
      if (!current || !start || current.payload.status !== "green") continue;
      if (start.protection !== "workspace" || start.workspace_digest !== evidenceDigest(imageWorkspace(currentManifest))) throw new Error("checker_revision_current_not_green");
      const source = sourceFor(log.events, start);
      if (!source || source.payload.image !== image) throw new Error("checker_revision_current_source_unavailable");
      const paths = sourceSchema.parse(source.payload).paths;
      const priorSources = admittedCheckerSources(log.events, start, source.seq);
      for (const prior of priorSources) {
        const old = lookup(log.events, sourceSchema.parse(prior.payload).start, "work/execution_start");
        for (const key of ["workspace", "command", "runner_digest", "evaluator_digest", "environment_digest", "protection"] as const) {
          if (old.payload[key] !== start[key]) throw new Error("checker_revision_execution_contract_changed");
        }
        if (canonicalJson(prior.payload.paths) !== canonicalJson(paths)) throw new Error("checker_revision_closure_changed");
      }
      const checkers = [...new Set(priorSources.map(row => String(row.payload.image)))];
      const previous = checkers.map(checker => probe(item, image, checker, paths));
      if (previous.some(row => row.payload.status !== "green")) throw new Error("checker_revision_prior_check_failed");
      const original = probe(item, originalImage, image, paths);
      if (original.payload.status === "invalid") throw new Error("checker_revision_original_execution_invalid");
      const parent = parentRows.find(row => row.payload.obligation_key === start.obligation_key);
      const parentPlan = projectObligations(log.events.filter(row => row.seq < followup.seq)).current!.plan;
      const parentItem = parent && parentPlan.cases.find(value => authorityCaseKey(log.events.filter(row => row.seq < followup.seq), value.id) === start.obligation_key);
      const parentEvents = scopeWorkEvents(parentPlan, log.events.filter(row => row.seq < followup.seq));
      const parentDecision = parentItem && decideCaseHistory(parentItem, parentPlan.require_red_first === true,
        currentCaseEvidence(parentItem, parentPlan.scenarios.find(row => row.id === parentItem.scenario), parentEvents), parentEvents);
      const checker_role = original.payload.status === "red" ? "implementation" : "supplemental";
      const role = parentDecision?.role ?? (item.guard ? "guard" : !plan.require_red_first ? "regression" : checker_role);
      if (role === "ablation" || parent && parentDecision?.status !== "green") throw new Error("checker_revision_parent_role_unavailable");
      const baseline = role === "implementation" ? parentDecision?.baseline_ref ?? reference(original) : null;
      revisions.push({ current: reference(current), source: reference(source), original: reference(original),
        previous: previous.map(reference), baseline, role, checker_role, paths });
    }
    log.refresh();
    if (!revisions.length) return;
    if (projectObligations(log.events).current?.digest !== authority.digest || !observeCheckerImage(views, image)) throw new Error("checker_revision_candidate_changed");
    const payload = { schema_version: 1 as const, authority: authority.digest,
      scope_seq: authority.scope_seq, followup: reference(followup), basis: reference(basis), image, cases: revisions };
    log.appendBatchDurable(() => {
      try { validateRevisionProof(payload, log.events); return [{ kind: "effect", name: CHECKER_REVISION, payload }]; }
      catch (error) { return [{ kind: "observe", name: "work/checker_refused", payload: {
        reason: error instanceof Error ? error.message : "checker_revision_unavailable",
      } }]; }
    });
  } catch (error) { refuse(error instanceof Error ? error.message : "checker_revision_unavailable"); }
}

/** Validate source acquisition and native probe bodies independently of the
 * current workspace. The caller supplies the same pure failure classifier. */
export function projectCheckerRevisions(events: readonly EventRecord[], bodies: ReadonlyMap<string, unknown>,
  qualifies: (output: string, redMeans: string) => boolean) {
  if (!events.some(row => row.name.startsWith("work/checker_"))) return [];
  const images = projectExecutionViews(events, bodies).images;
  const references: { seq: number; name: string; digest: string }[] = [];
  for (const event of events) {
    if (!event.name.startsWith("work/checker_")) continue;
    references.push({ seq: event.seq, name: event.name, digest: evidenceDigest(event.payload) });
    if (event.name === CHECKER_SOURCE) {
      const p = sourceSchema.parse(event.payload), start = lookup(events, p.start, "work/execution_start"), end = lookup(events, p.end, "work/execution_end");
      const image = images.find(row => row.digest === p.image), body = bodies.get(String(start.payload.blob)) as { checker?: { paths?: unknown }; evaluator?: { runtime?: string } } | undefined;
      const before = lookup(events, p.before, "execution_view/image");
      const after = events.find(row => row.seq === p.after.seq && row.hash === p.after.hash
        && (row.name === "execution_view/image" && row.payload.blob === p.image || row.name === "execution_view/observation"
          && row.payload.image === p.image && row.payload.matched === true && row.payload.trees_digest === p.trees_digest));
      if (event.kind !== "observe" || !image || start.seq >= end.seq || end.seq >= event.seq || end.payload.status !== "stable"
        || before.seq >= start.seq || !after || after.seq <= end.seq || after.seq >= event.seq || before.payload.blob !== p.image
        || end.payload.execution_start !== start.seq || start.payload.workspace !== image.manifest.workspace
        || p.trees_digest !== evidenceDigest(image.manifest.trees)
        || !image.manifest.private_roots || image.manifest.runtime !== body?.evaluator?.runtime
        || start.payload.environment_digest !== evidenceDigest(caseEnvironmentContract({ kind: "sealed-child-environment-v1", variables: image.manifest.environment, private_roots: image.manifest.private_roots }))
        || start.payload.workspace_digest !== evidenceDigest(imageWorkspace(image.manifest))
        || canonicalJson(body?.checker?.paths) !== canonicalJson(p.paths)) throw new Error("checker_source_binding");
    } else if (event.name === CHECKER_FOLLOWUP) {
      const p = followupSchema.parse(event.payload), prefix = events.filter(row => row.seq < event.seq);
      const authority = projectObligations(prefix).current;
      if (event.kind !== "effect" || authority?.digest !== p.parent || authority.scope_seq !== p.scope_seq
        || canonicalJson(checkerFollowupInput(prefix, authority.plan)?.payload) !== canonicalJson(p)) throw new Error("checker_followup_binding");
    } else if (event.name === CHECKER_PROBE) {
      const p = probeSchema.parse(event.payload), result = lookup(events, p.result, "execution_view/result");
      const resultBody = bodies.get(String(result.payload.blob)) as { dispatch: Ref; process: SandboxExecutionResult; changed: boolean };
      const dispatch = lookup(events, resultBody.dispatch, "execution_view/dispatch");
      const request = bodies.get(String(dispatch.payload.blob)) as { image: string; command: string };
      const expected = probeStatus(resultBody.process, resultBody.changed, p.adapter, text => qualifies(text, p.red_means));
      if (event.kind !== "observe" || result.seq >= event.seq || request.image !== p.image || request.command !== p.executed_command
        || p.adapter !== null && (p.adapter !== pytestResultAdapter.id || p.adapter_digest !== pytestResultAdapter.digest)
        || p.adapter === null && p.adapter_digest !== null
        || p.executed_command !== (p.adapter ? pytestResultAdapter.command(p.command.trim()) : p.command.trim())
        || expected.status !== p.status || expected.qualifying_red !== p.qualifying_red) throw new Error("checker_probe_binding");
    } else if (event.name === CHECKER_REVISION) {
      if (event.kind !== "effect") throw new Error("checker_revision_authority_binding");
      validateRevisionProof(revisionSchema.parse(event.payload), events.filter(row => row.seq < event.seq));
    } else if (event.name !== "work/checker_refused" || event.kind !== "observe" || typeof event.payload.reason !== "string") throw new Error("checker_revision_unknown_event");
  }
  return references;
}
