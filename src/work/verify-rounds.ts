import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import { DEFAULT_HEUNG_BUDGET_MS } from "./heung.ts";
import { recordedBaseRef } from "./ledger-base.ts";
import { recordedBase } from "./session-base.ts";
import { FIX_ORDER_CHECK_TEXT_MAX_BYTES } from "./ledger-check.ts";
import { formatPreFixLines, PRE_FIX_STATE_ROW, preFixStatePayload, preFixStatesFromEvents, type PreFixState } from "./pre-fix-state.ts";
import {
  fixOrderRecheck,
  formatOpenRecheckLines,
  formatRecheckLines,
  keptCases,
  NO_ADJUDICATION,
  openRecheckKey,
  openRechecks,
  RECHECK_DISPUTED_ROW,
  RECHECK_EVIDENCE_ROW,
  RECHECK_REDECLARED_ROW,
  RECHECK_ROW_NAMES,
  recheckAdjudicationFromEvents,
  recheckIdentityKey,
  recheckInvalidations,
  recheckRedeclarationPayload,
  recheckRedeclarations,
  recheckRedeclarationsFromEvents,
  recheckRowPayload,
  recheckRowsFromEvents,
  reportedCases,
  type OpenRecheck,
  type RecheckAdjudication,
  type RecheckCase,
  type RecheckObservation,
  type RecheckRedeclaration,
  type RecheckRequest,
  type RecheckRow,
} from "./recheck.ts";
import {
  failingRecheckObservation,
  latestRecheckObservation,
  MAX_ORDER_DISPUTES,
  recheckDisputePayloads,
  recheckEvidencePayload,
  recheckRulingRows,
  unruledDisputes,
  verifyOrderDispute,
  type DisputeEvidenceMaterial,
  type EvidenceDelivery,
  type EvidenceRequest,
} from "./recheck-adjudication.ts";
import {
  composeFixOrder,
  composeVerifyOrder,
  hasFindings,
  verifierFindings,
  type VerifierDefect,
  type VerifierFindings,
} from "./verified-work.ts";
import type { VerifierFilesKept } from "./verifier-files.ts";

/**
 * VERIFY ROUNDS (D41): the verify → fix loop of verified work, run by
 * `dokkabi work --planner ledger --verify-rounds N` itself.
 *
 * After the build session concludes with `finished`, the run starts a
 * VERIFIER: a new ledger session with a fresh context, under the `verify`
 * tool profile, on a throwaway copy of the workspace whose delivered state is
 * committed inside the copy. When the verifier finds something, a FIX session
 * runs in the developer's workspace itself, and a fresh verifier checks the
 * result on a fresh copy — at most N fix rounds, so a run verifies at most
 * N + 1 times. Every stage is an ordinary ledger session with its own log and
 * its own label; this module invents no verdict and changes no label.
 *
 * What lives here is the pure part: which stage comes next, the two orders
 * (delegated to verified-work.ts), the end-of-run report and the exit-code
 * rule. The process side — the verifier's workspace copy, the child
 * `dokkabi work` and reading its log back — is verify-rounds-stage.ts, behind
 * the `VerifyRoundsRunner` below, so the loop can be driven without a model.
 *
 * RECHECK (D45): after each fix (since D54 also one that did not finish), the
 * loop — the orchestrator, outside every session — has the runner observe
 * what the verifier before that fix left red and what the build (and the
 * previous fix) recorded green, on a copy of the tree the fix left
 * (recheck.ts), and records the rows in the run's own log. The next fix order
 * states the still-red ones as data; the report adds one line per round;
 * nothing enters a stage session.
 *
 * OPEN RECHECKS (D49): a recheck that left a case red (or a reported case not
 * runnable) stays open by identity — a verifier's report never closes one.
 * Every open identity is observed again after every later fix; a verifier
 * that reports nothing while some are open is followed by a fix (rounds
 * allowing) whose order carries them; the report lists them, and the exit
 * code stays raised while any is open.
 *
 * NO SELF-CLOSE (D50): only a later recheck that sees the same identity green
 * closes it. A fix that declares an open case's id with another spec in its
 * own ledger has re-declared it: the `recheck/redeclared` row records that
 * before the round's observations, the original is observed again exactly as
 * it was recorded, and the declaration is observed beside it as one more
 * case of that fix. Nothing a work session declares closes, replaces or stops
 * observing an open identity.
 *
 * ADJUDICATION (D54): a fix may dispute an open identity its order states;
 * the loop records each dispute (`recheck/disputed`), gives the next verifier
 * every open, unruled dispute in its order, and records that verifier's
 * rulings (`recheck/upheld`, `recheck/invalidated`) when it is neither the
 * check's source nor the disputing session. Only an `invalid` ruling closes
 * an identity; it is not observed again.
 *
 * EVIDENCE (D55): before that verifier starts, the runner writes each
 * dispute's evidence into the verifier's own scratch and the loop records a
 * `recheck/evidence` row per dispute (where, the manifest's digest, complete
 * or not) and states the evidence in the order. Since D57 the evidence is
 * what the check's failing run ran with — the snapshot its row names, taken
 * before that run (failingRecheckObservation) — beside the check as
 * recorded. An `invalid` ruling closes the identity only when that snapshot
 * was delivered complete to the verifier that ruled; a runner without the
 * `evidence` seam delivers none, so its verifiers' rulings close nothing.
 *
 * UNFINISHED FIX (D54): before every fix the runner saves the developer
 * tree's pre-fix state in the run's own directory (`rounds/pre_fix_state`,
 * pre-fix-state.ts). A fix that did not finish is still rechecked —
 * observation only — and the run then ends as before; the report prints the
 * recheck and where each pre-fix state is, with the one command that restores
 * it (since D55 `dokkabi work --restore-pre-fix <dir>`, which refuses or
 * restores the whole state, never half of it).
 */

/** A stage that would start with less of the run's wall than this is not
 * started, and the report says so. Ten minutes: enough for a session to read
 * the order, do a little work and conclude its own cases; less than that is a
 * session that would spend its whole allowance booting and concluding. */
export const VERIFY_ROUNDS_MIN_STAGE_MS = 10 * 60_000;

/** The exit code a run ends with when its last build/fix session concluded
 * with 0 and the last verifier still reported findings. Distinct from 1 (the
 * session stopped without finishing) and from 2 (the graph loop's unfinished
 * work), so a caller can tell "delivered, with defects open" apart. */
export const OPEN_DEFECTS_EXIT_CODE = 3;

export type VerifyRoundsRole = "build" | "verify" | "fix";

/** What the parent read back from one stage session: its own terminal row,
 * the child's exit status, and its rows. Nothing here is computed. */
export interface StageSession {
  readonly session: string;
  /** The label of the session's `work/run_result` row. */
  readonly label?: string;
  /** The stop reason of the session's `work/run_result` row. */
  readonly stopReason?: string;
  /** The session's own conclusion exit code — the child's exit status. */
  readonly exitCode?: number;
  /** The session's recorded rows, parsed by the replay parser. */
  readonly events?: readonly EventRecord[];
  /** The absolute spellings of the workspace root the session ran in, when
   * it ran somewhere other than the developer's workspace (a verifier's
   * copy); the recheck maps them to its own copy's root. */
  readonly workspaceRoots?: readonly string[];
  /** verify only: the files the verifier authored in its copy, kept in the
   * run's own directory before the copy was removed (D47). */
  readonly verifierFiles?: VerifierFilesKept;
  /** Why no readable session came back, when none did. */
  readonly error?: string;
  /** The session's scratch directory (D48), when it had one: the recheck
   * runs the session's `check` cases with the fixtures kept there. */
  readonly scratch?: string;
}

/** One stage of the run as the report states it. */
export interface VerifyRoundsStage {
  readonly role: VerifyRoundsRole;
  /** 0 for the build; the 1-based count of its role otherwise. */
  readonly round: number;
  readonly session?: string;
  readonly label?: string;
  readonly stopReason?: string;
  readonly exitCode?: number;
  /** verify only: what the verifier's rows say, when its log was read. */
  readonly findings?: VerifierFindings;
  /** The stage session's rows, kept for the recheck (D45): the build's and a
   * fix's green cases, a fix's base, a verifier's declared cases. */
  readonly events?: readonly EventRecord[];
  /** verify only: where its copy was (StageSession.workspaceRoots). */
  readonly workspaceRoots?: readonly string[];
  /** verify only: its kept files (StageSession.verifierFiles, D47). */
  readonly verifierFiles?: VerifierFilesKept;
  /** The stage was not started: this much wall was left, less than the
   * minimum a stage is started with. */
  readonly skipped?: { readonly remainingMs: number; readonly minimumMs: number };
  readonly error?: string;
  /** The stage session's scratch directory (StageSession.scratch, D48). */
  readonly scratch?: string;
}

/** The next thing the loop does. */
export type NextStage =
  | { readonly kind: "run"; readonly role: "verify" | "fix"; readonly round: number }
  | { readonly kind: "skip"; readonly role: "verify" | "fix"; readonly round: number; readonly remainingMs: number }
  | { readonly kind: "done" };

/**
 * Stage planning, pure: the history so far, the number of fix rounds allowed
 * and the wall left now decide the next stage.
 *
 * - Only a build or a fix that stopped `finished` is verified; any other stop
 *   (or a stage that came back unreadable) ends the run.
 * - A verifier whose log could not be read ends the run. One that found
 *   nothing ends it too — unless rechecks are still open (D49): they are
 *   something to hand a fix session.
 * - A verifier that found something, or left open rechecks behind, is
 *   followed by a fix while fewer than `rounds` fixes have run; every fix is
 *   followed by a fresh verifier.
 * - A stage that would start with less than the minimum wall is skipped, and
 *   a skipped stage ends the run.
 */
export function nextStage(input: {
  readonly stages: readonly VerifyRoundsStage[];
  readonly rounds: number;
  readonly remainingMs: number;
  readonly minimumMs?: number;
  /** How many recheck identities are open now (D49). */
  readonly openRechecks?: number;
}): NextStage {
  const last = input.stages.at(-1);
  if (last === undefined || last.skipped !== undefined || input.rounds < 1) return { kind: "done" };
  const count = (role: VerifyRoundsRole) => input.stages.filter((stage) => stage.role === role && stage.skipped === undefined).length;
  let next: { role: "verify" | "fix"; round: number };
  if (last.role === "verify") {
    if (last.findings === undefined) return { kind: "done" };
    if (!hasFindings(last.findings) && (input.openRechecks ?? 0) === 0) return { kind: "done" };
    if (count("fix") >= input.rounds) return { kind: "done" };
    next = { role: "fix", round: count("fix") + 1 };
  } else {
    if (last.stopReason !== "finished") return { kind: "done" };
    next = { role: "verify", round: count("verify") + 1 };
  }
  const minimumMs = input.minimumMs ?? VERIFY_ROUNDS_MIN_STAGE_MS;
  if (input.remainingMs < minimumMs) return { kind: "skip", ...next, remainingMs: Math.max(0, input.remainingMs) };
  return { kind: "run", ...next };
}

/** A verifier's findings with exact duplicate defects dropped: two rows whose
 * title, expected, observed and reproduce are all identical are one defect
 * reported twice (a row is an observation, never a record to amend). A pure
 * projection — the rows stay as they were recorded. */
export function withoutDuplicateDefects(findings: VerifierFindings): VerifierFindings {
  const seen = new Set<string>();
  const defects: VerifierDefect[] = [];
  for (const defect of findings.defects) {
    const key = JSON.stringify([defect.title, defect.expected, defect.observed, defect.reproduce]);
    if (seen.has(key)) continue;
    seen.add(key);
    defects.push(defect);
  }
  return { ...findings, defects };
}

/** The session's own terminal row: its label and the stop it ended on. Read,
 * never computed. */
export function stageTerminal(events: readonly EventRecord[]): { label?: string; stopReason?: string } {
  const row = [...events].reverse().find((event) => event.name === "work/run_result");
  return {
    ...(typeof row?.payload.label === "string" ? { label: row.payload.label } : {}),
    ...(typeof row?.payload.stop_reason === "string" ? { stopReason: row.payload.stop_reason } : {}),
  };
}

/** The run's shared wall, as the ledger session derives its own: the
 * session's hours budget (--budget-hours, or the default) from the start of
 * the run, capped by the supervisor ceiling folded with --budget-hours. */
export function verifyRoundsWallMs(input: {
  readonly startedMs: number;
  readonly budgetHours?: number;
  readonly deadlineUnixMs?: number;
}): number {
  const hours = input.budgetHours ?? DEFAULT_HEUNG_BUDGET_MS / 3_600_000;
  return Math.min(input.startedMs + hours * 3_600_000, input.deadlineUnixMs ?? Number.POSITIVE_INFINITY);
}

/** One stage request: the composed order and the shared wall. */
export interface StageRequest {
  readonly round: number;
  readonly order: string;
  readonly deadlineMs: number;
}

/** The process side of the loop (verify-rounds-stage.ts): start one stage
 * session and read it back. A runner never throws for a stage that failed —
 * it returns the failure as `error` — but the driver guards it anyway. */
export interface VerifyRoundsRunner {
  verify(request: StageRequest): Promise<StageSession>;
  fix(request: StageRequest): Promise<StageSession>;
  /** The recheck seam (D45): observe the requested cases on a copy of the
   * developer's workspace as the last fix left it, one observation per case
   * in the request's order. The process runner's default is the real
   * observation; a runner without it rechecks nothing. */
  recheck?(request: RecheckRequest): Promise<readonly RecheckObservation[]>;
  /** The pre-fix seam (D54): save the developer tree as it is now, before fix
   * `round`, in the run's own directory, and say what was kept. The process
   * runner's default is the real save (pre-fix-state.ts) when it has a run
   * directory; a runner without it saves nothing. */
  preFix?(request: { readonly round: number; readonly deadlineMs: number }): Promise<PreFixState>;
  /** The evidence seam (D55): before verify round `round` starts, write the
   * evidence of each dispute its order will list into the scratch of the
   * verifier session that round starts, and say what was delivered — one
   * item per material, in order — and for which session. The process
   * runner's default is the real delivery (verifier-files.ts); a runner
   * without it delivers nothing. */
  evidence?(request: EvidenceRequest): Promise<EvidenceDelivery>;
}

/** The whole run as the report states it. */
export interface VerifyRoundsResult {
  readonly stages: readonly VerifyRoundsStage[];
  /** The recheck rows the run recorded (D45), in its own log's order. */
  readonly rechecks: readonly RecheckRow[];
  /** The re-declaration rows it recorded (D50), in its own log's order: data
   * for the report, never an input to the open set. */
  readonly redeclarations?: readonly RecheckRedeclaration[];
  /** The dispute and ruling rows it recorded (D54), in its own log's order:
   * an `invalid` ruling that holds is an input to the open set. */
  readonly adjudication?: RecheckAdjudication;
  /** The pre-fix state rows it recorded (D54), one per fix stage that ran
   * with a runner that saves them. */
  readonly preFix?: readonly PreFixState[];
  /** The recheck identities still open at the end (D49): a function of the
   * recheck and adjudication rows alone. */
  readonly openRechecks?: readonly OpenRecheck[];
  /** The last verifier that was read, deduplicated; undefined when none was. */
  readonly open?: VerifierFindings;
  /** Whether a fix ran after the last verifier that was read, so its findings
   * were reported before the tree changed and nothing re-verified them. */
  readonly stale: boolean;
  readonly exitCode: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drive the loop: plan, run through the injected runner, read findings, and
 * stop when the plan says so. The build is the first stage and has already
 * run; every later stage gets what is left of the shared wall.
 */
export async function driveVerifyRounds(input: {
  /** The operator's order, exactly as the build session read it. */
  readonly order: string;
  /** The number of fix rounds allowed (N ≥ 1). */
  readonly rounds: number;
  readonly build: VerifyRoundsStage;
  readonly deadlineMs: number;
  readonly runner: VerifyRoundsRunner;
  readonly now?: () => number;
  readonly minimumMs?: number;
  /** Called with each stage as soon as it is recorded. */
  readonly onStage?: (stage: VerifyRoundsStage) => void;
  /** The run's own event log (`<build session>-rounds`), opened at its first
   * row; without it (or without the runner's `recheck`) nothing is rechecked,
   * and no dispute, ruling or pre-fix state is recorded (D54). */
  readonly openRoundsLog?: () => EventLog;
  /** The developer's workspace root spellings: the build's and every fix's
   * recorded commands are mapped from these. */
  readonly workspaceRoots?: readonly string[];
}): Promise<VerifyRoundsResult> {
  const now = input.now ?? Date.now;
  const stages: VerifyRoundsStage[] = [input.build];
  const rechecks: RecheckRow[] = [];
  const redeclarations: RecheckRedeclaration[] = [];
  let adjudication: RecheckAdjudication = NO_ADJUDICATION;
  const preFix: PreFixState[] = [];
  // Every case a recheck was asked to observe, by identity: an identity still
  // open is observed again after every later fix (D49), as it was recorded —
  // its own fixtures, scratch and verifier files — until it is green (D50).
  const requested = new Map<string, RecheckCase>();
  let roundsLog: EventLog | undefined;
  const openRounds = (open: () => EventLog): EventLog => (roundsLog ??= open());
  // Everything the loop decides from its own log is read back from the log,
  // so a recorded run re-derives it.
  const reread = () => {
    const events = roundsLog!.events;
    rechecks.splice(0, rechecks.length, ...recheckRowsFromEvents(events));
    redeclarations.splice(0, redeclarations.length, ...recheckRedeclarationsFromEvents(events));
    adjudication = recheckAdjudicationFromEvents(events);
    preFix.splice(0, preFix.length, ...preFixStatesFromEvents(events));
  };
  const record = (stage: VerifyRoundsStage) => {
    stages.push(stage);
    input.onStage?.(stage);
  };
  for (;;) {
    const open = openRechecks(rechecks, adjudication);
    const next = nextStage({
      stages,
      rounds: input.rounds,
      remainingMs: input.deadlineMs - now(),
      ...(input.minimumMs === undefined ? {} : { minimumMs: input.minimumMs }),
      openRechecks: open.length,
    });
    if (next.kind === "done") break;
    if (next.kind === "skip") {
      record({
        role: next.role,
        round: next.round,
        skipped: { remainingMs: next.remainingMs, minimumMs: input.minimumMs ?? VERIFY_ROUNDS_MIN_STAGE_MS },
      });
      break;
    }
    if (next.role === "verify") {
      // Every open dispute no verifier has ruled on yet (D54), as data for
      // this order: the check as recorded, the fixer's reason and quote.
      const presented = unruledDisputes(open, adjudication).slice(0, MAX_ORDER_DISPUTES);
      const budget = { left: FIX_ORDER_CHECK_TEXT_MAX_BYTES };
      // Their evidence (D55), in the scratch of the verifier about to start,
      // one `recheck/evidence` row each — before the verifier runs. Since D57
      // it is what each check's failing run ran with, snapshotted before that
      // run: the first red row of the identity since it was last green.
      const delivery = presented.length === 0 || input.runner.evidence === undefined || input.openRoundsLog === undefined
        ? undefined
        : await deliverEvidence(input.runner, next.round, input.deadlineMs, presented.map((item, index) => {
          const recorded = requested.get(openRecheckKey(item));
          const observation = roundsLog === undefined ? undefined : failingRecheckObservation(roundsLog.events, item);
          return {
            index: index + 1,
            dispute: item,
            ...(recorded === undefined ? {} : { recorded }),
            ...(observation === undefined ? {} : { observation }),
          };
        }));
      if (delivery !== undefined) {
        const log = openRounds(input.openRoundsLog!);
        presented.forEach((item, index) => {
          const evidence = delivery.items[index] ?? { index: index + 1, complete: false, missing: ["the runner returned no evidence for this dispute"] };
          log.append({
            kind: "observe",
            name: RECHECK_EVIDENCE_ROW,
            payload: recheckEvidencePayload({ verifyRound: next.round, ...(delivery.session === undefined ? {} : { verifier: delivery.session }), dispute: item, evidence }),
          });
        });
        reread();
      }
      const disputes = presented.map((item, index) => verifyOrderDispute(
        item, requested.get(openRecheckKey(item)), budget, delivery?.items[index],
        roundsLog === undefined ? undefined : latestRecheckObservation(roundsLog.events, item),
      ));
      const session = await guarded(() => input.runner.verify({
        round: next.round,
        order: composeVerifyOrder(input.order, disputes),
        deadlineMs: input.deadlineMs,
      }));
      record({
        ...stageFields("verify", next.round, session),
        ...(session.events === undefined ? {} : { findings: verifierFindings(session.events, session.scratch === undefined ? {} : { scratch: session.scratch }), events: session.events }),
        ...(session.workspaceRoots === undefined ? {} : { workspaceRoots: session.workspaceRoots }),
        ...(session.verifierFiles === undefined ? {} : { verifierFiles: session.verifierFiles }),
      });
      // Its rulings on those disputes (D54), recorded when it may rule —
      // neither the check's source nor the disputing session.
      if (presented.length > 0 && session.events !== undefined && input.openRoundsLog !== undefined) {
        const ruled = recheckRulingRows({ verifyRound: next.round, verifier: session.session, events: session.events, presented });
        if (ruled.length > 0) {
          const log = openRounds(input.openRoundsLog);
          for (const item of ruled) log.append({ kind: "observe", name: item.name, payload: item.payload });
          reread();
        }
      }
      continue;
    }
    // A fix follows a verifier that was read (nextStage guarantees it) and
    // found something or left open rechecks behind; its report is that
    // verifier's, duplicates dropped.
    const verified = [...stages].reverse().find((stage) => stage.role === "verify" && stage.findings !== undefined);
    const findings = withoutDuplicateDefects(verified!.findings!);
    // Every recheck still open, as data for this order (D45 R3, D49), each
    // with the identity a dispute names (D54).
    const previous = fixOrderRecheck(next.round - 1, rechecks, adjudication);
    // The developer tree as it is before this fix (D54), kept in the run's
    // own directory; the row says where, or why nothing was kept.
    if (input.runner.preFix !== undefined && input.openRoundsLog !== undefined) {
      let state: PreFixState;
      try {
        state = await input.runner.preFix({ round: next.round, deadlineMs: input.deadlineMs });
      } catch (error) {
        state = { round: next.round, saved: false, reason: `the pre-fix state could not be saved: ${message(error).slice(0, 200)}` };
      }
      openRounds(input.openRoundsLog).append({ kind: "observe", name: PRE_FIX_STATE_ROW, payload: preFixStatePayload(state) });
      reread();
    }
    const session = await guarded(() => input.runner.fix({
      round: next.round,
      order: previous === undefined
        ? composeFixOrder(input.order, findings)
        : composeFixOrder(input.order, findings, undefined, previous),
      deadlineMs: input.deadlineMs,
    }));
    const fix: VerifyRoundsStage = {
      ...stageFields("fix", next.round, session),
      ...(session.events === undefined ? {} : { events: session.events }),
    };
    record(fix);
    // What was open before this round (D49): what the fix order stated.
    const openBefore = open;
    // The disputes this fix recorded on those identities (D54), whether or
    // not it finished: data, closing nothing.
    if (input.openRoundsLog !== undefined && fix.events !== undefined && openBefore.length > 0) {
      const disputed = recheckDisputePayloads({ round: next.round, fix: fix.session ?? "none", events: fix.events, open: openBefore });
      if (disputed.length > 0) {
        const log = openRounds(input.openRoundsLog);
        for (const payload of disputed) log.append({ kind: "observe", name: RECHECK_DISPUTED_ROW, payload });
        reread();
      }
    }
    if (input.runner.recheck === undefined || input.openRoundsLog === undefined) continue;
    // A fix that did not finish is rechecked too (D54): observation only, on
    // a copy of the tree as it left it; nothing follows it (nextStage).
    const workspaceRoots = input.workspaceRoots ?? [];
    // Which open identities this fix re-declared — declared the same case id
    // with another spec in its own ledger (D50). That is recorded first, with
    // both digests, as data: the original is observed again below exactly as
    // recorded, and the declaration beside it, as one more case of the fix.
    const redeclared = fix.events === undefined ? [] : recheckRedeclarations({
      open: openBefore,
      fixSession: fix.session ?? "none",
      fixEvents: fix.events,
      workspaceRoots,
      ...(fix.scratch === undefined ? {} : { scratch: fix.scratch }),
    });
    if (redeclared.length > 0) {
      const log = openRounds(input.openRoundsLog);
      for (const item of redeclared) {
        log.append({
          kind: "observe",
          name: RECHECK_REDECLARED_ROW,
          payload: recheckRedeclarationPayload({ round: next.round, fix: fix.session ?? "none", open: item.open, by: item.by }),
        });
      }
      reread();
    }
    // An identity an `invalid` ruling closed (D54) is not observed again.
    const invalidated = new Set(recheckInvalidations(rechecks, adjudication).map(openRecheckKey));
    const cases = uniqueCases([
      ...recheckCasesFor(stages, verified!, workspaceRoots),
      ...openBefore.map((item) => requested.get(openRecheckKey(item))).filter((item): item is RecheckCase => item !== undefined),
      ...redeclared.map((item) => item.by),
    ]).filter((item) => !invalidated.has(caseKey(item)));
    if (cases.length === 0) continue;
    for (const item of cases) requested.set(caseKey(item), item);
    const log = openRounds(input.openRoundsLog);
    const baseRef = fix.events === undefined ? undefined : recordedBaseRef(fix.events);
    const fixBase = fix.events === undefined ? undefined : recordedBase(fix.events);
    const request: RecheckRequest = {
      round: next.round,
      fix: fix.session ?? "none",
      ...(baseRef === undefined ? {} : { fixBaseRef: baseRef }),
      ...(fixBase === undefined ? {} : { fixBase }),
      deadlineMs: input.deadlineMs,
      log,
      cases,
    };
    let observations: readonly RecheckObservation[];
    try {
      observations = await input.runner.recheck(request);
    } catch (error) {
      const reason = `the recheck failed: ${message(error).slice(0, 200)}`;
      observations = cases.map(() => ({ status: "not_runnable" as const, reason }));
    }
    cases.forEach((item, index) => {
      const observation = observations[index] ?? { status: "not_runnable" as const, reason: "the recheck returned no observation for this case" };
      log.append({
        kind: "observe",
        name: RECHECK_ROW_NAMES[item.kind],
        payload: recheckRowPayload({ round: request.round, fix: request.fix, item, observation }),
      });
    });
    reread();
  }
  return summarize(stages, rechecks, redeclarations, adjudication, preFix);
}

/** The runner's evidence delivery (D55), never throwing: a delivery that
 * failed delivers every dispute incomplete, with the reason. */
async function deliverEvidence(
  runner: VerifyRoundsRunner,
  round: number,
  deadlineMs: number,
  items: readonly DisputeEvidenceMaterial[],
): Promise<EvidenceDelivery> {
  try {
    return await runner.evidence!({ round, items, deadlineMs });
  } catch (error) {
    const reason = `the evidence could not be delivered: ${message(error).slice(0, 200)}`;
    return { items: items.map((item) => ({ index: item.index, complete: false, missing: [reason] })) };
  }
}

/** The identity key of a case to recheck. */
function caseKey(item: RecheckCase): string {
  return recheckIdentityKey(item.source, item.id, item.spec);
}

/** The cases with every identity once, first occurrence kept. */
function uniqueCases(cases: readonly RecheckCase[]): RecheckCase[] {
  const seen = new Set<string>();
  return cases.filter((item) => {
    const key = caseKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What the recheck after the latest fix observes (D45 R1): the cases the
 * verifier before it left red, then every case the build recorded green, and
 * from round 2 on every case the previous fix recorded green. */
function recheckCasesFor(
  stages: readonly VerifyRoundsStage[],
  verifier: VerifyRoundsStage,
  workspaceRoots: readonly string[],
): RecheckCase[] {
  const ran = stages.filter((stage) => stage.skipped === undefined);
  const build = ran.find((stage) => stage.role === "build");
  const fixes = ran.filter((stage) => stage.role === "fix");
  const previousFix = fixes.length >= 2 ? fixes.at(-2) : undefined;
  const reported = verifier.findings === undefined ? [] : reportedCases({
    session: verifier.session ?? "none",
    findings: verifier.findings,
    ...(verifier.events === undefined ? {} : { events: verifier.events }),
    ...(verifier.workspaceRoots === undefined ? {} : { workspaceRoots: verifier.workspaceRoots }),
    ...(verifier.verifierFiles === undefined ? {} : { files: verifier.verifierFiles }),
    ...(verifier.scratch === undefined ? {} : { scratch: verifier.scratch }),
  });
  const kept = [build, previousFix].flatMap((stage) =>
    stage?.events === undefined ? [] : keptCases({
      session: stage.session ?? "none",
      events: stage.events,
      workspaceRoots,
      ...(stage.scratch === undefined ? {} : { scratch: stage.scratch }),
    }));
  return [...reported, ...kept];
}

async function guarded(run: () => Promise<StageSession>): Promise<StageSession> {
  try {
    return await run();
  } catch (error) {
    return { session: "none", error: message(error) };
  }
}

function stageFields(role: "verify" | "fix", round: number, session: StageSession): VerifyRoundsStage {
  return {
    role,
    round,
    session: session.session,
    ...(session.label === undefined ? {} : { label: session.label }),
    ...(session.stopReason === undefined ? {} : { stopReason: session.stopReason }),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    ...(session.error === undefined ? {} : { error: session.error }),
    ...(session.scratch === undefined ? {} : { scratch: session.scratch }),
  };
}

/** The result of a finished loop: the last verifier's findings, the recheck
 * identities still open, and the exit code rule. */
export function summarize(
  stages: readonly VerifyRoundsStage[],
  rechecks: readonly RecheckRow[] = [],
  redeclarations: readonly RecheckRedeclaration[] = [],
  adjudication: RecheckAdjudication = NO_ADJUDICATION,
  preFix: readonly PreFixState[] = [],
): VerifyRoundsResult {
  const ran = stages.filter((stage) => stage.skipped === undefined);
  const lastVerifier = [...ran].reverse().find((stage) => stage.role === "verify" && stage.findings !== undefined);
  const lastWork = [...ran].reverse().find((stage) => stage.role === "build" || stage.role === "fix");
  const open = lastVerifier === undefined ? undefined : withoutDuplicateDefects(lastVerifier.findings!);
  const stale = lastVerifier !== undefined && lastWork !== undefined && ran.indexOf(lastWork) > ran.indexOf(lastVerifier);
  // Open by identity (D49): whatever any verifier said after them, and
  // whatever any fix re-declared (D50) — the rows alone decide, an `invalid`
  // ruling that holds among them (D54).
  const stillOpen = openRechecks(rechecks, adjudication);
  return {
    stages,
    rechecks,
    redeclarations,
    adjudication,
    preFix,
    openRechecks: stillOpen,
    ...(open === undefined ? {} : { open }),
    stale,
    exitCode: verifyRoundsExitCode(
      lastWork?.exitCode ?? 1,
      (open !== undefined && hasFindings(open)) || stillOpen.length > 0,
    ),
  };
}

/** The result re-derived from the run's own log and its stages (replay): the
 * rows the loop read back from that log as it ran — rechecks, re-declarations,
 * disputes and rulings, pre-fix states. */
export function summarizeRoundsLog(stages: readonly VerifyRoundsStage[], events: readonly EventRecord[]): VerifyRoundsResult {
  return summarize(
    stages,
    recheckRowsFromEvents(events),
    recheckRedeclarationsFromEvents(events),
    recheckAdjudicationFromEvents(events),
    preFixStatesFromEvents(events),
  );
}

/**
 * The exit-code rule: the last build/fix session's own conclusion exit code,
 * raised to OPEN_DEFECTS_EXIT_CODE when it is 0 and the last verifier still
 * reported findings — or, since D49, a recheck identity is still open,
 * whatever the last verifier said (`findingsOpen` carries both). A non-zero
 * code (that session stopped without finishing, or could not be read) is kept
 * as it is.
 */
export function verifyRoundsExitCode(lastWorkExitCode: number, findingsOpen: boolean): number {
  if (lastWorkExitCode !== 0) return lastWorkExitCode;
  return findingsOpen ? OPEN_DEFECTS_EXIT_CODE : 0;
}

/** Whether the verifier after fix `round` reported fewer defects (exact
 * duplicates dropped) than the verifier before it; false when either was not
 * read. */
function defectsShrank(ran: readonly VerifyRoundsStage[], round: number): boolean {
  const count = (verifyRound: number) => {
    const stage = ran.find((item) => item.role === "verify" && item.round === verifyRound && item.findings !== undefined);
    return stage === undefined ? undefined : withoutDuplicateDefects(stage.findings!).defects.length;
  };
  const before = count(round);
  const after = count(round + 1);
  return before !== undefined && after !== undefined && after < before;
}

/** A model-authored or error string on one bounded report line. */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** How many checks a verifier recorded: the non-guard case count its own
 * `work/run_result` row carries. `defects=0` over `checks=0` is a verifier
 * that recorded no evidence at all, which the report makes visible; undefined
 * when the session's rows were not read or carry no result. */
export function checksRecorded(events: readonly EventRecord[] | undefined): number | undefined {
  if (events === undefined) return undefined;
  const row = [...events].reverse().find((event) => event.name === "work/run_result");
  const cases = row?.payload.cases;
  return typeof cases === "number" ? cases : undefined;
}

/** One report line per stage: role, session, stop reason, and what the stage
 * is worth. A build or fix carries its own label. A verifier carries the
 * defects it reported (and the cases it left red, when any) instead: it checks
 * delivered work, so its checks are green on its base tree by construction and
 * its own label says nothing about the product. */
export function formatStageLine(stage: VerifyRoundsStage): string {
  const head = stage.role === "build" ? "stage=build" : `stage=${stage.role} round=${stage.round}`;
  if (stage.skipped !== undefined) {
    return `${head} not_started=wall remaining_seconds=${Math.floor(stage.skipped.remainingMs / 1_000)}` +
      ` minimum_seconds=${Math.floor(stage.skipped.minimumMs / 1_000)}`;
  }
  const found = stage.findings === undefined ? undefined : withoutDuplicateDefects(stage.findings);
  const worth = stage.role !== "verify"
    ? `label=${stage.label ?? "none"}`
    : found === undefined
      ? "defects=unknown"
      : `defects=${found.defects.length}${found.red_cases.length > 0 ? ` red_cases=${found.red_cases.length}` : ""}` +
        `${checksRecorded(stage.events) === undefined ? "" : ` checks=${checksRecorded(stage.events)}`}`;
  return `${head} session=${stage.session ?? "none"} ${worth} stop_reason=${stage.stopReason ?? "none"}` +
    `${stage.error === undefined ? "" : ` error=${JSON.stringify(oneLine(stage.error))}`}`;
}

/**
 * The end-of-run report, printed after the build's own lines: one line per
 * stage, then the last verifier's open defects — a count and one title per
 * defect, exact duplicates dropped — and, when that verifier also left cases
 * red, their ids. When a fix ran after that verifier and nothing re-verified
 * it, the count says so; when no verifier was read at all, it says that.
 * When that verifier's own result row says it recorded no checks at all, the
 * count says that too (D47 G8) — data, nothing gates on it. Then the recheck
 * identities still open (D49), a count and one line each, whatever the last
 * verifier said — an identity a fix re-declared says so (D50), and one a fix
 * disputed says whether a verifier upheld it or has not ruled (D54); when a
 * fix ran after the last recheck, that count says so. After each fix's lines,
 * where its pre-fix state is and the command that restores it (D54, D55).
 */
export function formatVerifyRoundsReport(result: VerifyRoundsResult): string[] {
  const lines: string[] = [];
  const ran = result.stages.filter((stage) => stage.skipped === undefined);
  const rechecks = result.rechecks ?? [];
  const redeclarations = result.redeclarations ?? [];
  const adjudication = result.adjudication ?? NO_ADJUDICATION;
  const preFix = result.preFix ?? [];
  for (const stage of result.stages) {
    lines.push(formatStageLine(stage));
    if (stage.role !== "fix" || stage.skipped !== undefined) continue;
    lines.push(...formatRecheckLines(stage.round, rechecks, defectsShrank(ran, stage.round), redeclarations, adjudication));
    for (const state of preFix) if (state.round === stage.round) lines.push(...formatPreFixLines(state));
  }
  const open = result.openRechecks ?? openRechecks(rechecks, adjudication);
  const lastRechecked = Math.max(0, ...rechecks.map((row) => row.round));
  const unrechecked = ran.some((stage) => stage.role === "fix" && stage.round > lastRechecked);
  const openLines = formatOpenRecheckLines(open, unrechecked ? " (observed before the last fix; not rechecked)" : "", redeclarations, adjudication);
  if (result.open === undefined) {
    lines.push("open defects: unknown (no verifier session was read)");
    return [...lines, ...openLines];
  }
  const note = result.stale ? " (reported before the last fix; not re-verified)" : "";
  const lastVerifier = [...ran].reverse().find((stage) => stage.role === "verify" && stage.findings !== undefined);
  const noChecks = checksRecorded(lastVerifier?.events) === 0 ? " (the last verifier recorded no checks)" : "";
  lines.push(`open defects: ${result.open.defects.length}${note}${noChecks}`);
  for (const defect of result.open.defects) lines.push(`- ${oneLine(defect.title)}`);
  if (result.open.red_cases.length > 0) {
    lines.push(`red cases left by the last verifier: ${result.open.red_cases.length}${note}`);
    for (const item of result.open.red_cases) lines.push(`- ${oneLine(item.id)}`);
  }
  return [...lines, ...openLines];
}
