import { createHash } from "node:crypto";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { recheckSpecDigest, type RecheckSpec } from "./case-spec.ts";
import { isCheckCase } from "./ledger-check.ts";
import {
  propertyFieldsOf,
  propertyInputGaps,
  propertyRefKey,
  propertyRowFields,
  propertyRowStatus,
  propertyVerdict,
  recordedPropertyReplay,
  replayOfSet,
  replaySetStep,
  type PropertyCaseRef,
  type PropertyFields,
  type PropertyReplay,
  type PropertyReplayEntry,
} from "./ledger-property.ts";
import { projectLedger, revisionCases, type LedgerCase } from "./plan-ledger.ts";
import { recheckInputsGaps, recheckInputsRecordOf, type RecheckInputsRecord } from "./recheck-inputs.ts";
import type { ScratchManifestRecord } from "./session-scratch.ts";
import { finalCaseRows, type FixOrderRecheck, type VerifierFindings } from "./verified-work.ts";
import type { KeptFile } from "./verifier-files.ts";

/**
 * RECHECK (D45): after each fix stage of a `--verify-rounds` run, the
 * ORCHESTRATOR — outside every session — observes, on a throwaway copy of the
 * developer's workspace as the fix left it, commands that sessions themselves
 * recorded:
 *
 * - `reported`: every case the verifier before that fix left red (its
 *   command and dir, the verifier copy's root mapped to the new copy's);
 * - `kept`: every case and guard the build recorded green on its final
 *   observation, and from round 2 on every case the previous fix recorded
 *   green (the live workspace root mapped to the copy), each with the D26
 *   target observation — how many test files the command names that the fix
 *   changed against its own base with lines removed.
 *
 * The rows land in the run's own event log (`<build session>-rounds`), never
 * in a stage session: nothing here invents a case, a finish or a verdict
 * inside a session, and no stage's label changes. What lives in this file is
 * the pure part — which cases, the row payloads, reading rows back, the
 * report lines and the next fix order's data — so a recorded run re-derives
 * its report from its log alone. The observation itself is
 * recheck-observe.ts, behind the runner's `recheck` seam.
 *
 * RECHECK-FILES (D47): a reported case carries the directory of the files its
 * verifier authored in its copy (verifier-files.ts); the observer overlays
 * them onto the copy those cases run in, and the `recheck/reported` row
 * records how many it overlaid (`verifier_files`). A command that could not
 * start — exit 126 or 127 — is `not_runnable`, reported and kept alike, and
 * the report's `reported_green=a/b` counts only runnable cases in `b`.
 *
 * OPEN BY IDENTITY (D49): a rechecked case is identified by the session that
 * recorded it, its id and the digest of its spec (command, dir, and for a
 * `check` case its stdin, fixtures and expectations). A `recheck/kept` row
 * that is red, or a `recheck/reported` row that is red or not_runnable, leaves
 * that identity OPEN, and every open identity is observed again after every
 * later fix. A verifier's report never closes one — it runs the original
 * order and need not run that case at all. openRechecks() is a pure function
 * of the rows, so a recorded run re-derives the same open set.
 *
 * NO SELF-CLOSE (D50): an open identity closes ONLY when a later recheck
 * observes that same identity green. Nothing a work session declares closes
 * it. When a later fix declares an open case's id with a different spec in
 * its own ledger — a changed or weakened check, or an unrelated one that
 * happens to reuse the id — a `recheck/redeclared` row records both digests
 * before that round's observations; the original keeps being observed
 * exactly as it was recorded, and the declaration is observed beside it as
 * one more case of that fix, an identity of its own. A `recheck/superseded`
 * row (the D49 build wrote it, and closed the original there) is read the
 * same way. There is no automatic invalidation: a check that a later
 * requirement made wrong stays open, the report says it was re-declared, and
 * a person decides.
 *
 * ADJUDICATION (D54): the one other way an open identity closes. A fix
 * session may DISPUTE an open identity its order states, through its
 * `dispute` tool (a `work/dispute` row in that session: the identity, a reason
 * and the order text it relies on); the orchestrator records each as a
 * `recheck/disputed` row citing that row. The next fresh verifier is given
 * every open, unruled dispute and RULES on it against the order through its
 * `ruling` tool (`work/ruling`: upheld | invalid, the order text, a reason);
 * the orchestrator records a ruling from a verifier that is neither the
 * check's source nor the disputing session as `recheck/upheld` or
 * `recheck/invalidated`, citing the ruling row. Only an `invalid` ruling that
 * holds — independent, and later than a dispute of that identity by the
 * session it names — closes the identity, for good; `upheld`, no ruling, or
 * no later verifier leaves it open. openRechecks() applies it from the rows,
 * so a recorded run re-derives the same open set.
 *
 * EVIDENCE (D55): a ruling is only as good as what the ruling verifier could
 * read. Before that verifier starts, the orchestrator puts each dispute's
 * evidence in the verifier's own scratch — the files the check's verifier
 * authored (as kept, by digest), the check as recorded and the latest
 * recheck of it — and records a `recheck/evidence` row per dispute: where,
 * the manifest's digest, and whether it was delivered complete. An `invalid`
 * ruling holds only when the evidence of that dispute was delivered complete
 * to that very verifier; otherwise the identity stays open, the dispute goes
 * to the next verifier again, and the report says why.
 *
 * SCRATCH EVIDENCE (D56): a check may assert through files in its recording
 * session's scratch (`sh "$DOKKABI_SCRATCH/checks/x.sh"`), which the recheck
 * binds (D48). So every case carries the scratch of the session that recorded
 * it (`sourceScratch`, whether or not its run binds it), and after the case
 * runs the observer records a bounded manifest of that scratch beside the
 * rounds log (session-scratch.ts); the row names it (`scratch`). Since D57
 * that manifest is output data only — what the scratch held once the run was
 * over — and never evidence.
 *
 * INPUTS BEFORE THE RUN (D57, E1): right before every execution of a case the
 * observer snapshots what that execution runs with besides the product — the
 * scratch its run binds, the verifier files overlaid onto its copy, the stdin
 * materialised from its record — into the run's own content-addressed store
 * (recheck-inputs.ts), and the row names the snapshot (`inputs`). The evidence
 * of a dispute is the snapshot of the execution that produced its FAILING
 * observation: of the identity's rows, the first `red` one since the identity
 * was last observed green (failingRecheckRow) — never a later attempt that
 * found its inputs gone, never an inventory taken after a run. An `invalid`
 * ruling holds only when the evidence delivered complete to its verifier
 * names exactly that snapshot (invalidationGap), which the fold re-derives
 * from the rows.
 *
 * THE WHOLE SURFACE (D57b, E1'): the snapshot covers everything the
 * execution's sandbox lets it read of what the host bound — the bound scratch
 * whole, `.host` included, links captured as links with where they lead —
 * and the row records what stands in the way of it being complete evidence:
 * links that lead outside it (`outside`), a sandbox that does not keep reads
 * to it (`unconfined`). The fold lets no `invalid` ruling close on a failing
 * row whose record has either (recheckInputsGaps), whatever the evidence row
 * says of itself.
 *
 * PROPERTIES (D58): a `property` case is rechecked like a check — its spec
 * digest covers its principle, bounds and fixtures — through the property
 * evaluator (work/ledger-property.ts): the counterexamples its recording
 * session and every earlier recheck of the identity recorded run first
 * (propertyReplay), then a fresh sample whose seed the row records; each
 * execution on its own copy of the pristine tree with its inputs snapshotted
 * before it starts, each counterexample's generated input snapshotted as
 * soon as its case ended (the row's `property`). Its evidence for a dispute
 * is the record plus those snapshots, and an `invalid` ruling on a failing
 * row whose counterexample inputs have a gap closes nothing.
 */

export type RecheckKind = "reported" | "kept";
export type RecheckStatus = "green" | "red" | "not_runnable";

/** The event names of the two rows. */
export const RECHECK_ROW_NAMES: Readonly<Record<RecheckKind, string>> = Object.freeze({
  reported: "recheck/reported",
  kept: "recheck/kept",
});

/** The event name of a re-declaration (D50): a later fix declared an open
 * case's id with a different spec in its own ledger. Data only: it closes,
 * replaces and stops nothing. */
export const RECHECK_REDECLARED_ROW = "recheck/redeclared";

/** The event name the D49 build wrote for the same declaration, when it
 * closed the original there (a supersession). Read as a re-declaration
 * (D50): it closes nothing either. */
export const RECHECK_SUPERSEDED_ROW = "recheck/superseded";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// The spec digest lives in case-spec.ts (D58b), so the verifier's findings and
// the `defect` tool compute the same digest without an import cycle.
export { recheckSpecDigest, type RecheckSpec };

/** The key of one recheck identity: the recording session, the case id and
 * the spec digest. */
export function recheckIdentityKey(source: string, caseId: string, spec: string): string {
  return JSON.stringify([source, caseId, spec]);
}

/** The tool-call id one recheck run of a case gets in the run's own log: its
 * `tool/result` row there carries what the command printed, which the
 * evidence of a disputed check reads back as the observation's output tail
 * (D55). */
export function recheckCallId(round: number, kind: RecheckKind, source: string, caseId: string): string {
  return `recheck-${round}-${kind}-${sha256(`${source}\u0000${caseId}`).slice(0, 16)}`;
}

/** One recorded command to observe again. */
export interface RecheckCase {
  readonly kind: RecheckKind;
  /** The session that recorded the case. */
  readonly source: string;
  readonly id: string;
  /** The digest of its spec (recheckSpecDigest): with source and id, the
   * identity an open recheck is kept by (D49). */
  readonly spec: string;
  readonly command: string;
  readonly dir?: string;
  readonly timeout_ms?: number;
  /** kept only: the case was declared a guard. */
  readonly guard?: boolean;
  /** The absolute roots the source session's workspace was spelled with;
   * each is mapped to the copy root before the command runs. */
  readonly fromRoots: readonly string[];
  /** reported only: where the files its verifier authored were kept, when
   * any were; they are overlaid onto the copy before the case runs. */
  readonly filesDir?: string;
  /** reported only: how many authored files the keep left behind (over a
   * bound, or not a regular file). */
  readonly filesSkipped?: number;
  /** reported only (D55): what the keep of its verifier's authored files
   * recorded, when one ran — every kept file by its exact path in that
   * verifier's tree, with its sha256 and size as kept (`filesDir` holds
   * them), and why nothing could be kept when that is so. Since D57 the
   * evidence of a dispute is the snapshot of the overlaid files before the
   * failing run, not the keep; the snapshot records whether the keep ran,
   * failed or left files behind. */
  readonly filesKept?: { readonly files: readonly KeptFile[]; readonly reason?: string };
  /** A `check` case's recorded stdin, fixtures and expectations (D48): the
   * recheck runs it with its fixtures and judges it by the same evaluator as
   * every other observation of it. */
  readonly stdin?: LedgerCase["stdin"];
  readonly files?: LedgerCase["files"];
  readonly expect?: LedgerCase["expect"];
  /** A `property` case's invariant and bounds (D58); its fixtures are in
   * `files`. */
  readonly property?: LedgerCase["property"];
  /** A `property` case's replay set as its recording session left it (D58,
   * D58c L1): replayed first, then folded on by every earlier recheck of the
   * identity, before the fresh sample — at most PROPERTY_REPLAY_MAX. */
  readonly counterexamples?: readonly PropertyCaseRef[];
  /** The recorded input of each of them (D58d RP), by propertyRefKey: the
   * snapshot its recording session took, which the recheck restores before it
   * replays it — without one a replay is not held. */
  readonly counterexample_inputs?: ReadonlyMap<string, RecheckInputsRecord>;
  /** How many more its recording session's replay set held than the cap
   * lets a recheck re-run (D58b V1) — only a recording the host did not write
   * (L1): while any are left out, the property is never green. */
  readonly counterexamples_overflow?: number;
  /** The scratch directory of the session that recorded the case (D48): the
   * recheck's policy binds that same path, so the case's fixtures and
   * DOKKABI_SCRATCH are what that session saw. */
  readonly scratch?: string;
  /** The scratch directory of the session that recorded the case, whether or
   * not the recheck binds it (D56): after the case runs, the observer records
   * a manifest of it, and the evidence of a dispute of the case is held to
   * that manifest. */
  readonly sourceScratch?: string;
}

/** One observation round, as the orchestrator hands it to the observer. */
export interface RecheckRequest {
  readonly round: number;
  /** The fix session whose tree is observed. */
  readonly fix: string;
  /** The fix session's own base commit (`work/ledger_session` `base_ref`);
   * absent when its log carries none. */
  readonly fixBaseRef?: string;
  /** The fix session's base record as its `work/base_record` row names it
   * (C1, D57e): what the recheck's images cover, and the base of the kept
   * cases' target observation (the host's content diff of that record and
   * the tree the fix left). Absent: coverage is conservative and no target
   * observation is made. */
  readonly fixBase?: { readonly dir: string; readonly digest: string };
  readonly deadlineMs: number;
  /** The run's own log: execution and receipt rows land here. */
  readonly log: EventLog;
  readonly cases: readonly RecheckCase[];
}

/** What one case's run observed. */
export interface RecheckObservation {
  readonly status: RecheckStatus;
  readonly exit_code?: number;
  readonly receipt?: string;
  readonly reason?: string;
  readonly translated_paths?: number;
  /** kept only: test-file targets the fix changed with removed lines > 0
   * or unknown line counts (U1); absent when the target observation could
   * not be made — `tamper_unknown` then says why. */
  readonly tampered_targets?: number;
  /** kept only (B1, U1, D57f): why the target observation could not be made
   * (the fix session's base record cannot be loaded, the fixed tree cannot
   * be read). The kept case counts as tampered-unknown: open. */
  readonly tamper_unknown?: string;
  /** reported only: how many of its verifier's kept files were overlaid
   * onto the copy the case ran in. */
  readonly verifier_files?: number;
  /** A `check` case's expectation results, as rows carry them (D48). */
  readonly expectations?: readonly Record<string, unknown>[];
  /** The case's source scratch once the case had run (D56): the manifest the
   * observer recorded of it, or why it could not; absent when the case's
   * source session has no scratch. Output data since D57, never evidence. */
  readonly scratch?: ScratchManifestRecord;
  /** What the execution ran with besides the product, snapshotted right
   * before it started (D57): the snapshot the store holds, or why none could
   * be taken; absent when the case never started. A property's: its first
   * failing execution's, else its first execution's (D58). */
  readonly inputs?: RecheckInputsRecord;
  /** A `property` case's run (D58): the sample seed, the replays, every
   * counterexample with its input snapshot. */
  readonly property?: PropertyFields;
}

/** The observer: one observation per request case, in the request's order.
 * The default is the real one (recheck-observe.ts); a test replaces it. */
export type RecheckObserver = (request: RecheckRequest) => Promise<readonly RecheckObservation[]>;

/** One `recheck/reported` or `recheck/kept` row, as recorded and as read back. */
export interface RecheckRow {
  readonly kind: RecheckKind;
  readonly round: number;
  readonly fix: string;
  readonly source: string;
  readonly case: string;
  /** The case's spec digest; a row recorded before D49 carries none, and
   * gets the digest of its command and dir. */
  readonly spec: string;
  readonly command: string;
  readonly dir?: string;
  readonly guard?: boolean;
  readonly status: RecheckStatus;
  readonly exit_code?: number;
  readonly receipt?: string;
  readonly reason?: string;
  readonly translated_paths?: number;
  readonly tampered_targets?: number;
  readonly tamper_unknown?: string;
  readonly verifier_files?: number;
  readonly verifier_files_skipped?: number;
  /** The snapshot of the execution's inputs, taken before it ran (D57);
   * absent on a row recorded before D57 or of a case that never started. */
  readonly inputs?: RecheckInputsRecord;
  /** A `property` case's run (D58). */
  readonly property?: PropertyFields;
}

/** Exit statuses a shell gives a command that could not start: found but not
 * executable (126), or not found (127). */
const NOT_STARTED_EXIT_CODES: ReadonlySet<number> = new Set([126, 127]);

/** A red observation whose command could not start is `not_runnable` (D47):
 * a reproduction that cannot start says nothing about the fix. Anything else
 * is returned as it is. */
export function withCommandStart(observation: RecheckObservation): RecheckObservation {
  // A property's executions started and ended; 126 or 127 from one of them is
  // a violation, and the status is the verdict of its own fields (D58b V2).
  if (observation.property !== undefined) return { ...observation, status: propertyVerdict(observation.property) };
  if (observation.status !== "red" || observation.exit_code === undefined || !NOT_STARTED_EXIT_CODES.has(observation.exit_code)) {
    return observation;
  }
  return { ...observation, status: "not_runnable", reason: `the command could not start (exit ${observation.exit_code})` };
}

/** The `check` fields of a declared case and the scratch of the session
 * that recorded it (D48); empty for a plan-declared case. A `property` case
 * (D58) carries its fixtures, its property and the counterexamples its
 * session recorded (from `events`). */
function checkFields(
  item: LedgerCase | undefined,
  scratch: string | undefined,
  events: readonly EventRecord[] = [],
): Pick<RecheckCase, "stdin" | "files" | "expect" | "scratch" | "property" | "counterexamples" | "counterexample_inputs" | "counterexamples_overflow"> {
  if (item !== undefined && item.property !== undefined) {
    const recorded = recordedPropertyReplay(events, item.id);
    return {
      ...(item.files !== undefined ? { files: item.files } : {}),
      property: item.property,
      ...(recorded.refs.length > 0 ? { counterexamples: recorded.refs } : {}),
      ...(recorded.inputs !== undefined && recorded.inputs.size > 0 ? { counterexample_inputs: recorded.inputs } : {}),
      ...(recorded.overflow > 0 ? { counterexamples_overflow: recorded.overflow } : {}),
      ...(scratch !== undefined ? { scratch } : {}),
    };
  }
  if (item === undefined || !isCheckCase(item)) return {};
  return {
    ...(item.stdin !== undefined ? { stdin: item.stdin } : {}),
    ...(item.files !== undefined ? { files: item.files } : {}),
    ...(item.expect !== undefined ? { expect: item.expect } : {}),
    ...(scratch !== undefined ? { scratch } : {}),
  };
}

/** A declared case's spec digest, as the identity of a reported case keys
 * it (D58b V3: a bound property and a red case of the same id with another
 * spec are two identities). */
function caseKeyOf(item: LedgerCase): string {
  const command = typeof item.command === "string" ? item.command : "";
  const dir = typeof item.dir === "string" && item.dir.length > 0 ? item.dir : undefined;
  return recheckSpecDigest({ command, ...(dir === undefined ? {} : { dir }), ...checkFields(item, undefined) });
}

/** The scratch of the session that recorded a case (D56), for every case,
 * check or not: what the observer records a manifest of. */
function sourceScratchField(scratch: string | undefined): Pick<RecheckCase, "sourceScratch"> {
  return scratch === undefined ? {} : { sourceScratch: scratch };
}

/** The cases the verifier left red, as it recorded them (findings.red_cases,
 * bounded there), with the declared budget its ledger gives each — and since
 * D58 every property one of its defects names, red or not, after them. */
export function reportedCases(input: {
  readonly session: string;
  readonly findings: VerifierFindings;
  readonly events?: readonly EventRecord[];
  readonly workspaceRoots?: readonly string[];
  /** The verifier's kept files (D47), when a keep ran; since D55 each kept
   * file's digest, and why nothing could be kept. */
  readonly files?: {
    readonly dir: string;
    readonly kept: number;
    readonly skipped: number;
    readonly reason?: string;
    readonly files?: readonly KeptFile[];
  };
  /** The verifier session's scratch directory (D48), when it had one. */
  readonly scratch?: string;
}): RecheckCase[] {
  const declared = new Map(revisionCases(projectLedger(input.events ?? [])).map((item) => [item.id, item]));
  // D58: a property a defect names is re-run by the recheck whether or not
  // the verifier's final pass left it red — the fix is done when it holds.
  // D58b V3: the declaration the defect BOUND (`property_case`, found by the
  // digest the defect row carries), not whatever the ledger declares under
  // that id at the end — a verifier that later drops the property or
  // re-declares the id cannot take it out of the recheck. It is its own
  // identity: beside a red case of the same id with another spec, not
  // instead of it.
  const cases: { readonly item: { readonly id: string; readonly command: string; readonly dir?: string }; readonly declared?: LedgerCase }[] =
    input.findings.red_cases.map((item) => ({ item, ...(declared.get(item.id) === undefined ? {} : { declared: declared.get(item.id)! }) }));
  const seen = new Set(cases.map((entry) => `${entry.item.id}\u0000${entry.declared === undefined ? "" : caseKeyOf(entry.declared)}`));
  for (const defect of input.findings.defects) {
    const bound = defect.property === undefined ? undefined : defect.property_case ?? (defect.property_digest === undefined ? declared.get(defect.property) : undefined);
    if (bound?.property === undefined || typeof bound.command !== "string") continue;
    const key = `${bound.id}\u0000${caseKeyOf(bound)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({ item: { id: bound.id, command: bound.command, ...(typeof bound.dir === "string" && bound.dir.length > 0 ? { dir: bound.dir } : {}) }, declared: bound });
  }
  return cases.map(({ item, declared: itemDeclared }) => {
    const timeout = itemDeclared?.timeout_ms;
    const check = checkFields(itemDeclared, input.scratch, input.events ?? []);
    return {
      kind: "reported" as const,
      source: input.session,
      id: item.id,
      spec: recheckSpecDigest({ command: item.command, ...(item.dir === undefined ? {} : { dir: item.dir }), ...check }),
      command: item.command,
      ...(item.dir === undefined ? {} : { dir: item.dir }),
      ...(typeof timeout === "number" ? { timeout_ms: timeout } : {}),
      fromRoots: input.workspaceRoots ?? [],
      ...(input.files !== undefined && input.files.kept > 0 ? { filesDir: input.files.dir } : {}),
      ...(input.files !== undefined && input.files.skipped > 0 ? { filesSkipped: input.files.skipped } : {}),
      ...(input.files === undefined
        ? {}
        : { filesKept: { files: input.files.files ?? [], ...(input.files.reason === undefined ? {} : { reason: input.files.reason }) } }),
      ...check,
      ...sourceScratchField(input.scratch),
    };
  });
}

/** Every case and guard a session recorded green on its final observation
 * (the label's pass anchor; a case the host could not run is not green). */
export function keptCases(input: {
  readonly session: string;
  readonly events: readonly EventRecord[];
  readonly workspaceRoots: readonly string[];
  /** The session's scratch directory (D48), when it had one. */
  readonly scratch?: string;
}): RecheckCase[] {
  const declared = new Map(revisionCases(projectLedger(input.events)).map((item) => [item.id, item]));
  const cases: RecheckCase[] = [];
  for (const row of finalCaseRows(input.events)) {
    // A property row is green only when its own fields say so (D58b V2).
    if (row.payload.property !== undefined ? propertyRowStatus(row.payload.property) !== "green" : row.payload.status !== "green") continue;
    if (typeof row.payload.unrunnable === "string" && row.payload.unrunnable.length > 0) continue;
    const id = String(row.payload.id);
    const item = declared.get(id);
    const command = typeof row.payload.command === "string" ? row.payload.command : item?.command ?? "";
    const dir = typeof item?.dir === "string" && item.dir.length > 0 ? item.dir : undefined;
    const check = checkFields(item, input.scratch, input.events);
    cases.push({
      kind: "kept",
      source: input.session,
      id,
      spec: recheckSpecDigest({ command, ...(dir === undefined ? {} : { dir }), ...check }),
      command,
      ...(dir === undefined ? {} : { dir }),
      ...(typeof item?.timeout_ms === "number" ? { timeout_ms: item.timeout_ms } : {}),
      guard: row.payload.guard === true || item?.guard === true,
      fromRoots: input.workspaceRoots,
      ...check,
      ...sourceScratchField(input.scratch),
    });
  }
  return cases;
}

/** A case as a session's own ledger declares it, to recheck as `kind` (D50:
 * a re-declaration, observed beside the open identity it re-declares). */
export function declaredRecheckCase(input: {
  readonly kind: RecheckKind;
  readonly session: string;
  readonly item: LedgerCase;
  readonly workspaceRoots: readonly string[];
  readonly scratch?: string;
  /** The declaring session's rows: a property's recorded counterexamples. */
  readonly events?: readonly EventRecord[];
}): RecheckCase {
  const { item } = input;
  const command = typeof item.command === "string" ? item.command : "";
  const dir = typeof item.dir === "string" && item.dir.length > 0 ? item.dir : undefined;
  const check = checkFields(item, input.scratch, input.events ?? []);
  return {
    kind: input.kind,
    source: input.session,
    id: item.id,
    spec: recheckSpecDigest({ command, ...(dir === undefined ? {} : { dir }), ...check }),
    command,
    ...(dir === undefined ? {} : { dir }),
    ...(typeof item.timeout_ms === "number" ? { timeout_ms: item.timeout_ms } : {}),
    ...(input.kind === "kept" ? { guard: item.guard === true } : {}),
    fromRoots: input.workspaceRoots,
    ...check,
    ...sourceScratchField(input.scratch),
  };
}

/** The open identities a fix session re-declared (D50): each one whose case
 * id the fix's own ledger declares with a different spec, paired with that
 * declaration as one more case of the fix — `kept`, like every case a work
 * session records, and an identity of its own. A declaration with the same
 * spec is no re-declaration: it is the same check, and the open identity is
 * observed as it was. Either way nothing here closes, replaces or stops
 * observing the open identity: the pairs are data. */
export function recheckRedeclarations(input: {
  readonly open: readonly OpenRecheck[];
  readonly fixSession: string;
  readonly fixEvents: readonly EventRecord[];
  readonly workspaceRoots: readonly string[];
  readonly scratch?: string;
}): { readonly open: OpenRecheck; readonly by: RecheckCase }[] {
  if (input.open.length === 0) return [];
  const declared = new Map(revisionCases(projectLedger(input.fixEvents)).map((item) => [item.id, item]));
  const out: { open: OpenRecheck; by: RecheckCase }[] = [];
  for (const open of input.open) {
    const again = declared.get(open.case);
    if (again === undefined) continue;
    const by = declaredRecheckCase({
      kind: "kept",
      session: input.fixSession,
      item: again,
      workspaceRoots: input.workspaceRoots,
      ...(input.scratch === undefined ? {} : { scratch: input.scratch }),
      events: input.fixEvents,
    });
    if (by.spec !== open.spec) out.push({ open, by });
  }
  return out;
}

/** The row payload for one observed case. */
export function recheckRowPayload(input: {
  readonly round: number;
  readonly fix: string;
  readonly item: RecheckCase;
  readonly observation: RecheckObservation;
}): Record<string, unknown> {
  const { item, observation } = input;
  return {
    round: input.round,
    fix: input.fix,
    source: item.source,
    case: item.id,
    spec: item.spec,
    command: item.command,
    ...(item.dir === undefined ? {} : { dir: item.dir }),
    ...(item.kind === "kept" ? { guard: item.guard === true } : {}),
    status: observation.status,
    ...(observation.exit_code === undefined ? {} : { exit_code: observation.exit_code }),
    ...(observation.receipt === undefined ? {} : { receipt: observation.receipt }),
    ...(observation.reason === undefined ? {} : { reason: observation.reason }),
    ...(observation.translated_paths === undefined ? {} : { translated_paths: observation.translated_paths }),
    ...(item.kind === "kept" && observation.tampered_targets !== undefined
      ? { tampered_targets: observation.tampered_targets }
      : {}),
    ...(item.kind === "kept" && observation.tamper_unknown !== undefined
      ? { tamper_unknown: observation.tamper_unknown }
      : {}),
    ...(item.kind === "reported" && observation.verifier_files !== undefined
      ? { verifier_files: observation.verifier_files }
      : {}),
    ...(item.kind === "reported" && item.filesSkipped !== undefined ? { verifier_files_skipped: item.filesSkipped } : {}),
    ...(observation.expectations !== undefined ? { expectations: observation.expectations } : {}),
    ...(observation.scratch !== undefined ? { scratch: { ...observation.scratch } } : {}),
    ...(observation.inputs !== undefined ? { inputs: { ...observation.inputs } } : {}),
    ...(observation.property !== undefined ? propertyRowFields(observation.property) : {}),
  };
}

function isStatus(value: unknown): value is RecheckStatus {
  return value === "green" || value === "red" || value === "not_runnable";
}

/** The recheck rows of a run's log, in the order they were recorded. A row
 * missing a field the report reads is not a recheck row. */
export function recheckRowsFromEvents(events: readonly EventRecord[]): RecheckRow[] {
  const rows: RecheckRow[] = [];
  for (const event of events) {
    const kind = event.name === RECHECK_ROW_NAMES.reported ? "reported" : event.name === RECHECK_ROW_NAMES.kept ? "kept" : undefined;
    if (kind === undefined) continue;
    const p = event.payload;
    if (typeof p.round !== "number" || typeof p.case !== "string" || typeof p.command !== "string" || !isStatus(p.status)) continue;
    rows.push({
      kind,
      round: p.round,
      fix: typeof p.fix === "string" ? p.fix : "",
      source: typeof p.source === "string" ? p.source : "",
      case: p.case,
      spec: typeof p.spec === "string" ? p.spec : recheckSpecDigest({ command: p.command, ...(typeof p.dir === "string" ? { dir: p.dir } : {}) }),
      command: p.command,
      ...(typeof p.dir === "string" ? { dir: p.dir } : {}),
      ...(typeof p.guard === "boolean" ? { guard: p.guard } : {}),
      // A property row's status is the pure verdict of its own `property`
      // field, whatever the row claims (D58b V2).
      status: p.property !== undefined ? propertyRowStatus(p.property) : p.status,
      ...(typeof p.exit_code === "number" ? { exit_code: p.exit_code } : {}),
      ...(typeof p.receipt === "string" ? { receipt: p.receipt } : {}),
      ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      ...(typeof p.translated_paths === "number" ? { translated_paths: p.translated_paths } : {}),
      ...(typeof p.tampered_targets === "number" ? { tampered_targets: p.tampered_targets } : {}),
      ...(typeof p.tamper_unknown === "string" ? { tamper_unknown: p.tamper_unknown } : {}),
      ...(typeof p.verifier_files === "number" ? { verifier_files: p.verifier_files } : {}),
      ...(typeof p.verifier_files_skipped === "number" ? { verifier_files_skipped: p.verifier_files_skipped } : {}),
      ...withInputs(p.inputs),
      ...withProperty(p.property),
    });
  }
  return rows;
}

function withProperty(value: unknown): { readonly property?: PropertyFields } {
  const property = propertyFieldsOf(value);
  return property === undefined ? {} : { property };
}

/** What a property identity's next recheck replays first (D58): its replay
 * set (D58c L1) — the counterexamples its recording session left in its own
 * replay set, then every earlier recheck of the same identity in `events`
 * (the run's own log) folded on in order: a recorded counterexample a recheck
 * re-ran to completion and saw hold leaves it, every new one joins it. At
 * most PROPERTY_REPLAY_MAX. Pure. */
export function propertyReplay(item: Pick<RecheckCase, "source" | "id" | "spec" | "counterexamples">, events: readonly EventRecord[]): PropertyCaseRef[] {
  return [...recheckPropertyReplay(item, events).refs];
}

/** The same, with how many recorded counterexamples lie past the replay cap
 * (D58b V1): only a recording the host did not write can hand over more than
 * the cap (L1) — those it could not hand over, and any the set holds past it.
 * While any do, the property is never green. Pure. */
export function recheckPropertyReplay(
  item: Pick<RecheckCase, "source" | "id" | "spec" | "counterexamples" | "counterexample_inputs" | "counterexamples_overflow">,
  events: readonly EventRecord[],
): PropertyReplay {
  // RP: each recorded counterexample with the input it was recorded with.
  const set = new Map<string, PropertyReplayEntry>();
  for (const ref of item.counterexamples ?? []) {
    const key = propertyRefKey(ref);
    const input = item.counterexample_inputs?.get(key);
    if (!set.has(key)) set.set(key, { seed: ref.seed, case: ref.case, ...(input === undefined ? {} : { input }) });
  }
  const key = recheckIdentityKey(item.source, item.id, item.spec);
  for (const row of recheckRowsFromEvents(events)) {
    if (row.property === undefined || recheckIdentityKey(row.source, row.case, row.spec) !== key) continue;
    replaySetStep(set, row.property);
  }
  const replay = replayOfSet(set);
  return { ...replay, overflow: replay.overflow + Math.max(0, item.counterexamples_overflow ?? 0) };
}

function withInputs(value: unknown): { readonly inputs?: RecheckInputsRecord } {
  const inputs = recheckInputsRecordOf(value);
  return inputs === undefined ? {} : { inputs };
}

/**
 * The row a dispute's evidence is taken from (D57, E1), among the first
 * `before` events: of the identity's recheck rows in log order, the first
 * `red` one since its latest `green` one — the earliest run that failed in
 * the episode the identity is open in. A `not_runnable` row is never it (a
 * later attempt that found its inputs gone says nothing about what the check
 * asserts); undefined when no row of the episode is red. Pure: rows in.
 */
export function failingRecheckRow(
  events: readonly EventRecord[],
  identity: { readonly source: string; readonly case: string; readonly spec: string },
  before: number = events.length,
): { readonly at: number; readonly row: RecheckRow } | undefined {
  const key = openRecheckKey(identity);
  let found: { at: number; row: RecheckRow } | undefined;
  for (let at = 0; at < Math.min(before, events.length); at += 1) {
    const event = events[at]!;
    if (event.name !== RECHECK_ROW_NAMES.reported && event.name !== RECHECK_ROW_NAMES.kept) continue;
    const row = recheckRowsFromEvents([event])[0];
    if (row === undefined || openRecheckKey(row) !== key) continue;
    if (row.status === "green") found = undefined;
    else if (row.status === "red" && found === undefined) found = { at, row };
  }
  return found;
}

/** The counts one round's report line states. */
export interface RecheckCounts {
  /** reported rows that are green / reported rows that could run (every
   * reported row but the not_runnable ones, D47). */
  readonly reportedGreen: number;
  readonly reported: number;
  /** reported rows that are not_runnable. */
  readonly reportedNotRunnable: number;
  /** kept rows that are red (not_runnable is not red). */
  readonly keptRed: number;
  /** kept rows that are not_runnable: cut by the host, not startable — not
   * red, but not shown green either, so open (D58c K1). */
  readonly keptNotRunnable: number;
  /** kept rows with at least one tampered target, or whose targets are
   * unknown (U1). */
  readonly tampered: number;
}

export function recheckCounts(rows: readonly RecheckRow[]): RecheckCounts {
  const reported = rows.filter((row) => row.kind === "reported");
  const kept = rows.filter((row) => row.kind === "kept");
  return {
    reportedGreen: reported.filter((row) => row.status === "green").length,
    reported: reported.filter((row) => row.status !== "not_runnable").length,
    reportedNotRunnable: reported.filter((row) => row.status === "not_runnable").length,
    keptRed: kept.filter((row) => row.status === "red").length,
    keptNotRunnable: kept.filter((row) => row.status === "not_runnable").length,
    tampered: kept.filter(keptTampered).length,
  };
}

/** A model-authored command on one bounded report line. */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** One re-declaration (D50): a later fix session declared, in its own ledger,
 * the case id of an open recheck identity with a different spec. Data only:
 * the original stays open until a recheck observes it green, and the
 * declaration is observed beside it as a case of its own. */
export interface RecheckRedeclaration {
  readonly round: number;
  /** The fix session whose ledger re-declared the case. */
  readonly fix: string;
  /** The original identity — still open, still observed as recorded. */
  readonly kind: RecheckKind;
  readonly source: string;
  readonly case: string;
  readonly spec: string;
  readonly command: string;
  readonly dir?: string;
  /** The declaration: the fix session's own case, an identity of its own. */
  readonly by_source: string;
  readonly by_spec: string;
  readonly by_command: string;
  readonly by_dir?: string;
}

/** The row payload of one re-declaration. */
export function recheckRedeclarationPayload(input: {
  readonly round: number;
  readonly fix: string;
  readonly open: OpenRecheck;
  readonly by: RecheckCase;
}): Record<string, unknown> {
  const { open, by } = input;
  return {
    round: input.round,
    fix: input.fix,
    kind: open.kind,
    source: open.source,
    case: open.case,
    spec: open.spec,
    command: open.command,
    ...(open.dir === undefined ? {} : { dir: open.dir }),
    by_source: by.source,
    by_spec: by.spec,
    by_command: by.command,
    ...(by.dir === undefined ? {} : { by_dir: by.dir }),
  };
}

/** The re-declaration rows of a run's log, in the order they were recorded:
 * `recheck/redeclared`, and `recheck/superseded` as the D49 build wrote it
 * for the same declaration, read the same way (D50). */
export function recheckRedeclarationsFromEvents(events: readonly EventRecord[]): RecheckRedeclaration[] {
  const rows: RecheckRedeclaration[] = [];
  for (const event of events) {
    if (event.name !== RECHECK_REDECLARED_ROW && event.name !== RECHECK_SUPERSEDED_ROW) continue;
    const p = event.payload;
    if (typeof p.round !== "number" || (p.kind !== "reported" && p.kind !== "kept") || typeof p.case !== "string") continue;
    if (typeof p.source !== "string" || typeof p.spec !== "string" || typeof p.by_source !== "string" || typeof p.by_spec !== "string") continue;
    rows.push({
      round: p.round,
      fix: typeof p.fix === "string" ? p.fix : "",
      kind: p.kind,
      source: p.source,
      case: p.case,
      spec: p.spec,
      command: typeof p.command === "string" ? p.command : "",
      ...(typeof p.dir === "string" ? { dir: p.dir } : {}),
      by_source: p.by_source,
      by_spec: p.by_spec,
      by_command: typeof p.by_command === "string" ? p.by_command : "",
      ...(typeof p.by_dir === "string" ? { by_dir: p.by_dir } : {}),
    });
  }
  return rows;
}

/** One recheck identity still open (D49). */
export interface OpenRecheck {
  readonly kind: RecheckKind;
  readonly source: string;
  readonly case: string;
  readonly spec: string;
  readonly command: string;
  readonly dir?: string;
  /** Its latest observation: the round and the status. */
  readonly round: number;
  readonly status: RecheckStatus;
  /** Why its latest observation was not judged, when it was not (K1). */
  readonly reason?: string;
  /** kept: the latest observation found a target test tampered with, or
   * could not observe its targets (U1, D57f) — open whatever its status. */
  readonly tampered?: true;
}

// --- adjudication rows (D54) -------------------------------------------------

/** The event names of the adjudication rows in the run's own log (D54). */
export const RECHECK_DISPUTED_ROW = "recheck/disputed";
export const RECHECK_UPHELD_ROW = "recheck/upheld";
export const RECHECK_INVALIDATED_ROW = "recheck/invalidated";

export type RecheckRulingValue = "upheld" | "invalid";

/** One `recheck/disputed` row (D54): a fix session disputed an identity its
 * order stated as open, through its `dispute` tool. Data: it closes nothing. */
export interface RecheckDisputed {
  /** The round of the disputing fix. */
  readonly round: number;
  /** The disputing fix session. */
  readonly fix: string;
  /** The disputed identity, as the recheck rows carry it. */
  readonly kind: RecheckKind;
  readonly source: string;
  readonly case: string;
  readonly spec: string;
  readonly command: string;
  readonly dir?: string;
  /** The dispute as the fix recorded it. */
  readonly reason: string;
  readonly order_text: string;
  /** The `work/dispute` row it cites, in the fix session's log. */
  readonly dispute_id: string;
  readonly dispute_seq: number;
  readonly dispute_hash: string;
}

/** One `recheck/upheld` or `recheck/invalidated` row (D54): a verifier that
 * was given a dispute, and is neither the check's source nor the disputing
 * session, ruled on it through its `ruling` tool. */
export interface RecheckRuled {
  readonly ruling: RecheckRulingValue;
  /** The fix round the ruling verifier followed (its own round minus one):
   * the ruling takes effect after that round's observations. */
  readonly round: number;
  readonly verify_round: number;
  /** The verifier session that ruled. */
  readonly verifier: string;
  /** The dispute it ruled on: the disputing fix session and its row id. */
  readonly fix: string;
  readonly dispute_id: string;
  /** The identity ruled on. */
  readonly kind: RecheckKind;
  readonly source: string;
  readonly case: string;
  readonly spec: string;
  readonly command: string;
  readonly dir?: string;
  /** The ruling as the verifier recorded it, and the row it cites. */
  readonly order_text: string;
  readonly reason: string;
  readonly ruling_id: string;
  readonly ruling_seq: number;
  readonly ruling_hash: string;
}

/** The event name of the evidence row (D55). */
export const RECHECK_EVIDENCE_ROW = "recheck/evidence";

/** One `recheck/evidence` row (D55): before a verifier started, the
 * orchestrator put the evidence of one dispute it was given — the files the
 * check's verifier authored, the check as recorded, the latest recheck of it
 * — in that verifier's scratch, and recorded where, the manifest's digest and
 * whether the evidence was delivered complete. Data: it closes nothing. */
export interface RecheckEvidence {
  /** The fix round the verifier follows (`verify_round − 1`). */
  readonly round: number;
  readonly verify_round: number;
  /** The verifier session the evidence was written for; absent when the
   * delivery failed before one was named. */
  readonly verifier?: string;
  /** The dispute it is the evidence of. */
  readonly fix: string;
  readonly dispute_id: string;
  readonly kind: RecheckKind;
  readonly source: string;
  readonly case: string;
  readonly spec: string;
  readonly command: string;
  readonly dir?: string;
  /** Whether every piece of the check's recorded material was written and
   * read back by digest; `missing` says what was not, when it was not. */
  readonly complete: boolean;
  readonly missing: readonly string[];
  /** Where it is (inside the verifier's scratch), the sha256 of its
   * `manifest.json`, and how many files of how many bytes that lists. */
  readonly evidence_dir?: string;
  readonly manifest_sha256?: string;
  readonly files?: number;
  readonly bytes?: number;
  /** The snapshot of inputs it delivered (D57) and the round of the run
   * that snapshot was taken before. */
  readonly inputs_round?: number;
  readonly inputs_snapshot?: string;
  /** Derived, never recorded: whether `inputs_snapshot` is the snapshot the
   * identity's failing run names, as the rows before this one leave it
   * (failingRecheckRow) — the only snapshot that is its evidence (D57) — and
   * that run's record of it names no gap (D57b, recheckInputsGaps). */
  readonly inputs_match?: boolean;
  /** Derived, never recorded: the first gap the failing run's record names,
   * when it names one (D57b). */
  readonly inputs_gap?: string;
}

/** The adjudication rows of a run's log (D54), in the order recorded; since
 * D55 with the evidence rows (absent: none). */
export interface RecheckAdjudication {
  readonly disputes: readonly RecheckDisputed[];
  readonly rulings: readonly RecheckRuled[];
  readonly evidence?: readonly RecheckEvidence[];
}

export const NO_ADJUDICATION: RecheckAdjudication = Object.freeze({
  disputes: Object.freeze([]),
  rulings: Object.freeze([]),
  evidence: Object.freeze([]),
});

/** The adjudication rows of a run's log. A row missing a field the rules read
 * is not an adjudication row. */
export function recheckAdjudicationFromEvents(events: readonly EventRecord[]): RecheckAdjudication {
  const disputes: RecheckDisputed[] = [];
  const rulings: RecheckRuled[] = [];
  const evidence: RecheckEvidence[] = [];
  const identity = (p: Record<string, unknown>) =>
    typeof p.round === "number" && (p.kind === "reported" || p.kind === "kept") && typeof p.source === "string" &&
    typeof p.case === "string" && typeof p.spec === "string" && typeof p.fix === "string";
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  events.forEach((event, at) => {
    const p = event.payload;
    if (event.name === RECHECK_EVIDENCE_ROW) {
      if (!identity(p) || typeof p.verify_round !== "number" || typeof p.dispute_id !== "string" || typeof p.complete !== "boolean") return;
      // The evidence names the snapshot of the identity's failing run, as
      // the rows before it leave that run (D57) — or it is not its evidence.
      const failing = failingRecheckRow(events, { source: p.source as string, case: p.case as string, spec: p.spec as string }, at);
      const expected = failing?.row.inputs;
      // What the failing row's own record says stands in the way (D57b):
      // over its bounds, links that led outside, an unconfined sandbox.
      // A property's failing row (D58): its counterexamples' inputs, too,
      // each snapshotted as its case ended, must be deliverable whole.
      const gaps = failing === undefined ? [] : [
        ...recheckInputsGaps(expected, `its failing recheck (round ${failing.row.round})`),
        ...propertyInputGaps(failing.row.property, `its failing recheck (round ${failing.row.round})`),
      ];
      const inputsMatch = typeof p.inputs_snapshot === "string" && expected?.snapshot === p.inputs_snapshot && gaps.length === 0;
      evidence.push({
        round: p.round as number, verify_round: p.verify_round, ...(typeof p.verifier === "string" ? { verifier: p.verifier } : {}),
        fix: p.fix as string, dispute_id: p.dispute_id, kind: p.kind as RecheckKind, source: p.source as string,
        case: p.case as string, spec: p.spec as string, command: text(p.command), ...(typeof p.dir === "string" ? { dir: p.dir } : {}),
        complete: p.complete,
        missing: Array.isArray(p.missing) ? p.missing.filter((item): item is string => typeof item === "string") : [],
        ...(typeof p.evidence_dir === "string" ? { evidence_dir: p.evidence_dir } : {}),
        ...(typeof p.manifest_sha256 === "string" ? { manifest_sha256: p.manifest_sha256 } : {}),
        ...(typeof p.files === "number" ? { files: p.files } : {}),
        ...(typeof p.bytes === "number" ? { bytes: p.bytes } : {}),
        ...(typeof p.inputs_round === "number" ? { inputs_round: p.inputs_round } : {}),
        ...(typeof p.inputs_snapshot === "string" ? { inputs_snapshot: p.inputs_snapshot } : {}),
        inputs_match: inputsMatch,
        ...(gaps.length === 0 ? {} : { inputs_gap: gaps[0] }),
      });
      return;
    }
    if (event.name === RECHECK_DISPUTED_ROW) {
      if (!identity(p) || typeof p.dispute_id !== "string") return;
      disputes.push({
        round: p.round as number, fix: p.fix as string, kind: p.kind as RecheckKind, source: p.source as string,
        case: p.case as string, spec: p.spec as string, command: text(p.command), ...(typeof p.dir === "string" ? { dir: p.dir } : {}),
        reason: text(p.reason), order_text: text(p.order_text), dispute_id: p.dispute_id,
        dispute_seq: typeof p.dispute_seq === "number" ? p.dispute_seq : 0, dispute_hash: text(p.dispute_hash),
      });
      return;
    }
    const ruling = event.name === RECHECK_UPHELD_ROW ? "upheld" : event.name === RECHECK_INVALIDATED_ROW ? "invalid" : undefined;
    if (ruling === undefined || !identity(p) || typeof p.verifier !== "string" || typeof p.dispute_id !== "string") return;
    rulings.push({
      ruling, round: p.round as number, verify_round: typeof p.verify_round === "number" ? p.verify_round : (p.round as number) + 1,
      verifier: p.verifier, fix: p.fix as string, dispute_id: p.dispute_id, kind: p.kind as RecheckKind,
      source: p.source as string, case: p.case as string, spec: p.spec as string, command: text(p.command),
      ...(typeof p.dir === "string" ? { dir: p.dir } : {}), order_text: text(p.order_text), reason: text(p.reason),
      ruling_id: text(p.ruling_id), ruling_seq: typeof p.ruling_seq === "number" ? p.ruling_seq : 0, ruling_hash: text(p.ruling_hash),
    });
  });
  return { disputes, rulings, evidence };
}

/** The evidence row of the dispute a ruling ruled on, as delivered to the
 * verifier of that ruling's round (D55): the last one of that round, dispute
 * and identity naming that verifier, or naming none (a delivery that failed
 * before a verifier was named); undefined when there is none. */
export function evidenceOfRuling(ruling: RecheckRuled, adjudication: RecheckAdjudication): RecheckEvidence | undefined {
  const key = openRecheckKey(ruling);
  return [...(adjudication.evidence ?? [])].reverse().find((item) =>
    item.verify_round === ruling.verify_round && item.fix === ruling.fix && item.dispute_id === ruling.dispute_id &&
    openRecheckKey(item) === key && (item.verifier === undefined || item.verifier === ruling.verifier));
}

/**
 * Why a recorded `invalid` ruling does not close its identity, or undefined
 * when it does (D54, D55, D57): the ruling verifier is neither the check's
 * source nor the disputing session, that session disputed the same identity
 * no later than the round the ruling follows, the evidence of that dispute was
 * delivered complete to that very verifier before it started, and that
 * evidence was the snapshot of the inputs of the identity's failing run,
 * taken before that run, whose record names no gap — no link that led
 * outside it, no sandbox that did not keep the run's reads to it (D57b)
 * (RecheckEvidence.inputs_match, re-derived from the rows). The orchestrator
 * records no ruling of the first two kinds; a row that says otherwise closes
 * nothing.
 */
export function invalidationGap(ruling: RecheckRuled, adjudication: RecheckAdjudication): string | undefined {
  if (ruling.ruling !== "invalid") return "it upheld the check";
  if (ruling.verifier === ruling.source) return "the ruling session is the check's own source";
  if (ruling.verifier === ruling.fix) return "the ruling session is the one that disputed it";
  const key = openRecheckKey(ruling);
  if (!adjudication.disputes.some((item) => item.fix === ruling.fix && item.round <= ruling.round && openRecheckKey(item) === key)) {
    return "no dispute of it by that fix precedes the ruling";
  }
  const evidence = evidenceOfRuling(ruling, adjudication);
  if (evidence === undefined) return "no evidence of the check was delivered to the ruling session";
  if (!evidence.complete || evidence.verifier !== ruling.verifier) {
    const first = evidence.missing[0] ?? "it was not delivered to the ruling session";
    return `its evidence was incomplete: ${oneLine(first, 160)}${evidence.missing.length > 1 ? ` (and ${evidence.missing.length - 1} more)` : ""}`;
  }
  if (evidence.inputs_match !== true) {
    if (evidence.inputs_gap !== undefined) return `its evidence was incomplete: ${oneLine(evidence.inputs_gap, 160)}`;
    return "its evidence was not the snapshot of what its failing run ran with, taken before that run";
  }
  return undefined;
}

/** Whether a recorded `invalid` ruling closes its identity (invalidationGap). */
export function invalidationHolds(ruling: RecheckRuled, adjudication: RecheckAdjudication): boolean {
  return invalidationGap(ruling, adjudication) === undefined;
}

/** Whether an observation leaves its identity open: anything but green, for
 * a reported case and a kept one alike (D58c K1) — a reported case red or not
 * runnable is not fixed; a kept guarantee red, cut by the host (its time, a
 * hang, its output bound) or not startable is not shown to hold, unknown is
 * never evidence of a clean fix, so the identity stays open until a later
 * recheck observes it green — and a kept case whose target test the fix
 * tampered with or whose targets could not be observed, whatever its status
 * (U1, D57f: tampered-unknown is never re-verified as clean). */
function isProblem(row: RecheckRow): boolean {
  return row.status !== "green" || keptTampered(row);
}

/** A kept row with a tampered target, or one whose targets are unknown. */
export function keptTampered(row: RecheckRow): boolean {
  return row.kind === "kept" && ((row.tampered_targets ?? 0) > 0 || row.tamper_unknown !== undefined);
}

interface IdentityState {
  readonly open: boolean;
  /** Closed for good by an `invalid` ruling that holds (D54). */
  readonly invalidated: boolean;
  readonly entry: OpenRecheck;
  readonly order: number;
}

/** The fold behind the open set: every identity's state after the rows, and
 * the `invalid` rulings that closed one, in the order they took effect. */
function foldRechecks(rows: readonly RecheckRow[], adjudication: RecheckAdjudication): {
  readonly states: ReadonlyMap<string, IdentityState>;
  readonly invalidated: readonly RecheckRuled[];
} {
  const states = new Map<string, IdentityState>();
  const applied: RecheckRuled[] = [];
  let order = 0;
  const invalid = adjudication.rulings.filter((item) => item.ruling === "invalid");
  const rounds = [...new Set([...rows.map((row) => row.round), ...invalid.map((item) => item.round)])].sort((a, b) => a - b);
  for (const round of rounds) {
    for (const row of rows) {
      if (row.round !== round) continue;
      const key = recheckIdentityKey(row.source, row.case, row.spec);
      const state = states.get(key);
      // An identity a ruling closed stays closed: the check itself was ruled
      // not required by the order, so no later observation of it reopens it.
      if (state?.invalidated === true) continue;
      const open = isProblem(row);
      states.set(key, {
        open,
        invalidated: false,
        entry: {
          kind: state?.entry.kind ?? row.kind, source: row.source, case: row.case, spec: row.spec, command: row.command,
          ...(row.dir === undefined ? {} : { dir: row.dir }), round: row.round, status: row.status,
          ...(row.status === "not_runnable" && row.reason !== undefined ? { reason: row.reason } : {}),
          ...(keptTampered(row) ? { tampered: true as const } : {}),
        },
        order: state?.order ?? order++,
      });
    }
    // Rulings follow the round's observations: the verifier that made them
    // ran after the fix of this round was rechecked.
    for (const ruling of invalid) {
      if (ruling.round !== round) continue;
      const key = openRecheckKey(ruling);
      const state = states.get(key);
      if (state === undefined || !state.open || !invalidationHolds(ruling, adjudication)) continue;
      states.set(key, { ...state, open: false, invalidated: true });
      applied.push(ruling);
    }
  }
  return { states, invalidated: applied };
}

/**
 * The recheck identities still open after the given rows (D49, D50, D54), in
 * the order they were first seen. Pure: the observation rows of a run's own
 * log, round by round, and its adjudication rows. An identity opens on a
 * problem row and closes on a green row of the same identity, or — for good —
 * on an `invalid` ruling that holds (invalidationHolds); nothing else closes
 * it. Neither a verifier's report nor a re-declaration is an input: nothing a
 * session says or declares closes an identity (D50).
 */
export function openRechecks(rows: readonly RecheckRow[], adjudication: RecheckAdjudication = NO_ADJUDICATION): OpenRecheck[] {
  const { states } = foldRechecks(rows, adjudication);
  return [...states.values()].filter((state) => state.open).sort((a, b) => a.order - b.order).map((state) => state.entry);
}

/** The `invalid` rulings that closed an identity (D54), in the order they took
 * effect; a ruling that does not hold is not among them. */
export function recheckInvalidations(rows: readonly RecheckRow[], adjudication: RecheckAdjudication): RecheckRuled[] {
  return [...foldRechecks(rows, adjudication).invalidated];
}

/** The adjudication rows of the rounds up to `round` (D54). */
function adjudicationThrough(adjudication: RecheckAdjudication, round: number): RecheckAdjudication {
  return {
    disputes: adjudication.disputes.filter((item) => item.round <= round),
    rulings: adjudication.rulings.filter((item) => item.round <= round),
    evidence: (adjudication.evidence ?? []).filter((item) => item.round <= round),
  };
}

/** The identity key of an open recheck, a row or a case. */
export function openRecheckKey(item: { readonly source: string; readonly case: string; readonly spec: string }): string {
  return recheckIdentityKey(item.source, item.case, item.spec);
}

/**
 * The report lines of one round (D45 R4): `recheck round=N
 * reported_green=a/b kept_red=c tampered=d` — `b` counts only the reported
 * cases that could run, and ` not_runnable=n` follows `a/b` when n reported
 * cases could not (D47), and ` redeclared=r` when the fix declared r open
 * case ids with another spec (D50) — with ` no progress` appended when the
 * round closed nothing (no reported case green, and no identity open before it
 * green), broke nothing (no kept case red that was not already open) and the
 * verifier's defects did not shrink; then one line per kept case now red and
 * one per re-declaration. `defectsShrank` is the caller's reading of the stage
 * lines (the verifier after the fix reported fewer defects than the one before
 * it). Since D54 the line adds ` disputed=d invalidated=i` when the round's fix
 * disputed d open identities or i of the round's identities were closed by an
 * `invalid` ruling that holds, and one `- invalidated:` line each, citing the
 * ruling (since D55 also the manifest digest of the evidence the ruling
 * verifier was given, ` evidence=<12>`); a ruling is not progress of the
 * product, so it does not change ` no progress`. No rows, no lines: a round
 * with nothing to recheck recorded nothing.
 */
export function formatRecheckLines(
  round: number,
  rows: readonly RecheckRow[],
  defectsShrank: boolean,
  redeclarations: readonly RecheckRedeclaration[] = [],
  adjudication: RecheckAdjudication = NO_ADJUDICATION,
): string[] {
  const own = rows.filter((row) => row.round === round);
  if (own.length === 0) return [];
  const counts = recheckCounts(own);
  const redeclared = redeclarations.filter((item) => item.round === round);
  const disputed = adjudication.disputes.filter((item) => item.round === round).length;
  const invalidated = recheckInvalidations(rows, adjudication).filter((item) => item.round === round);
  // What was open before this round: a row of it continues an open problem.
  // A re-declaration is one more case of its fix, open only by its own rows.
  const earlier = rows.filter((row) => row.round < round);
  const before = new Set(openRechecks(earlier, adjudicationThrough(adjudication, round - 1)).map(openRecheckKey));
  const closed = own.some((row) => row.status === "green" && !keptTampered(row) && (row.kind === "reported" || before.has(openRecheckKey(row))));
  // A kept guarantee not observed green — red, cut, not startable (K1) — or
  // tampered with (U1) that was not already open is a break.
  const broke = own.some((row) => row.kind === "kept" && (row.status !== "green" || keptTampered(row)) && !before.has(openRecheckKey(row)));
  const noProgress = !closed && !broke && !defectsShrank;
  const lines = [
    `recheck round=${round} reported_green=${counts.reportedGreen}/${counts.reported}` +
      `${counts.reportedNotRunnable > 0 ? ` not_runnable=${counts.reportedNotRunnable}` : ""}` +
      ` kept_red=${counts.keptRed}${counts.keptNotRunnable > 0 ? ` kept_not_runnable=${counts.keptNotRunnable}` : ""} tampered=${counts.tampered}` +
      `${redeclared.length > 0 ? ` redeclared=${redeclared.length}` : ""}` +
      `${disputed > 0 || invalidated.length > 0 ? ` disputed=${disputed} invalidated=${invalidated.length}` : ""}` +
      `${noProgress ? " no progress" : ""}`,
  ];
  for (const row of own) {
    if (row.kind === "kept" && row.status === "red") lines.push(`- kept red: ${oneLine(row.case)} ${oneLine(row.command)}`);
    else if (row.kind === "kept" && row.tamper_unknown !== undefined) lines.push(`- kept tampered-unknown: ${oneLine(row.case)} ${oneLine(row.tamper_unknown)}`);
    else if (keptTampered(row)) lines.push(`- kept tampered: ${oneLine(row.case)} ${oneLine(row.command)}`);
    if (row.kind === "kept" && row.status === "not_runnable") {
      lines.push(`- kept not runnable: ${oneLine(row.case)} ${oneLine(row.command)}${row.reason === undefined ? "" : ` (${oneLine(row.reason, 160)})`}`);
    }
  }
  for (const item of redeclared) {
    lines.push(`- redeclared: ${oneLine(item.case)} source=${item.source} spec=${item.spec.slice(0, 12)} by=${item.by_source} spec=${item.by_spec.slice(0, 12)}`);
  }
  for (const item of invalidated) {
    const evidence = evidenceOfRuling(item, adjudication)?.manifest_sha256;
    lines.push(`- invalidated: ${oneLine(item.case)} source=${item.source} spec=${item.spec.slice(0, 12)} disputed_by=${item.fix}` +
      ` ruled_by=${item.verifier} ruling=${oneLine(item.ruling_id, 64)}${evidence === undefined ? "" : ` evidence=${evidence.slice(0, 12)}`}`);
  }
  return lines;
}

/** Where the dispute of an open identity stands (D54), for its report line:
 * nothing when it was never disputed; otherwise its latest dispute and
 * whether a verifier upheld it, ruled it invalid without closing it — and
 * since D55 why not (invalidationGap: the evidence it was given was
 * incomplete, or none was delivered) — or has not ruled on it. */
function disputeNote(item: OpenRecheck, adjudication: RecheckAdjudication): string {
  const key = openRecheckKey(item);
  const latest = [...adjudication.disputes].reverse().find((dispute) => openRecheckKey(dispute) === key);
  if (latest === undefined) return "";
  const ruled = [...adjudication.rulings].reverse()
    .find((ruling) => openRecheckKey(ruling) === key && ruling.fix === latest.fix && ruling.dispute_id === latest.dispute_id);
  if (ruled === undefined) return ` — disputed by ${latest.fix}; unruled`;
  if (ruled.ruling === "upheld") return ` — disputed by ${latest.fix}; upheld by ${ruled.verifier}`;
  const why = invalidationGap(ruled, adjudication) ?? "the check was not open when the ruling took effect";
  return ` — disputed by ${latest.fix}; ruled invalid by ${ruled.verifier}, which does not close it: ${why}`;
}

/** The report lines for the recheck identities still open at the end (D49):
 * a count and one line each — none when nothing is open. An identity a later
 * fix re-declared with a different spec (D50) is still open because the
 * original, as recorded, was not observed green; its line says so and names
 * the fix sessions that re-declared it. An identity a fix disputed (D54)
 * says so, and whether a verifier upheld the dispute, ruled it invalid
 * without closing it (and why, D55) or has not ruled on it. */
export function formatOpenRecheckLines(
  open: readonly OpenRecheck[],
  note = "",
  redeclarations: readonly RecheckRedeclaration[] = [],
  adjudication: RecheckAdjudication = NO_ADJUDICATION,
): string[] {
  if (open.length === 0) return [];
  return [
    `open rechecks: ${open.length}${note}`,
    ...open.map((item) => {
      const by = [...new Set(redeclarations.filter((redeclared) => openRecheckKey(redeclared) === openRecheckKey(item)).map((redeclared) => redeclared.by_source))];
      const disputed = disputeNote(item, adjudication);
      if (by.length === 0) return `- ${item.kind} ${item.tampered === true ? "tampered" : item.status}: ${oneLine(item.case)} ${oneLine(item.command)} (source ${item.source})${disputed}`;
      return `- open: ${oneLine(item.case)} source=${item.source} spec=${item.spec.slice(0, 12)} — re-declared by ${by.join(", ")}` +
        ` with a different spec; ${item.status === "red" ? "the original still fails" : "the original could not run"}${disputed}`;
    }),
  ];
}

/** The next fix order's data (D45 R3, D49): every recheck identity open after
 * round `round` — reported cases still red or not runnable, kept cases red or
 * not shown green (cut, not startable: D58c K1, with why) — ids and commands,
 * whichever round last observed them, and each one's identity (source and
 * spec digest), which a `dispute` names (D54); undefined when none is open. An
 * identity a fix re-declared is carried as it was recorded (D50); one an
 * `invalid` ruling closed is not carried (D54). */
export function fixOrderRecheck(
  round: number,
  rows: readonly RecheckRow[],
  adjudication: RecheckAdjudication = NO_ADJUDICATION,
): FixOrderRecheck | undefined {
  const open = openRechecks(rows.filter((row) => row.round <= round), adjudicationThrough(adjudication, round));
  if (open.length === 0) return undefined;
  const pick = (kind: RecheckKind) => open
    .filter((item) => item.kind === kind)
    .map((item) => ({
      id: item.case, command: item.command,
      ...(item.status === "not_runnable" ? { not_runnable: true as const } : {}),
      ...(item.kind === "kept" && item.status === "not_runnable" && item.reason !== undefined ? { reason: item.reason } : {}),
      ...(item.tampered === true ? { tampered: true as const } : {}),
      source: item.source, spec: item.spec,
    }));
  return { reported_red: pick("reported"), kept_red: pick("kept") };
}
