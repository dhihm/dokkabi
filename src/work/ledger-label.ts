import type { EventRecord } from "../host/schema.ts";
import { foldLedger, revisionCases, revisionScenarios, revisionTodos, type LedgerCase, type LedgerCaseDrop, type LedgerScenario, type LedgerTodo } from "./plan-ledger.ts";
import { propertyRowStatus } from "./property-verdict.ts";

/**
 * The terminal label (interfaces-v3.md §4), derived from the event log alone.
 *
 * Everything here is pure: the latest recorded ledger revision (projectLedger:
 * the latest `work/ledger` graph with the `work/ledger_case` rows after it and
 * the check cases it keeps, D52) says which cases exist, the end-of-run
 * `ledger/case` rows say what the host saw when it
 * ran them on the final tree, the `ledger/case_base` rows say what the same
 * cases did on a copy of the workspace restored to the base commit, the
 * `ledger/case_targets` rows say which of each command's targets the session
 * changed against that base (paths and counts only), and the receipt rows say
 * those observations are bound to real executions. Nothing reads the
 * workspace or the runner registry, so a replay of the same log recomputes
 * the same label — which is the whole point of computing it here instead of
 * inside the conclusion (§4, invariant I7). A log recorded before
 * `ledger/case_base` or `ledger/case_targets` existed recomputes its recorded
 * label too: each rule only applies to sessions whose log carries its rows
 * (see deriveLedgerLabel).
 *
 * The label is an honest report, never a gate: `done_unverified` still means
 * the work was delivered, and no branch of this file refuses anything.
 */

export type LedgerLabel = "accepted" | "done_unverified" | "incomplete";

/** Why a case is not shown green on the final tree. */
export type LedgerGapReason = "red" | "not_runnable" | "not_observed" | "no_receipt";

export interface LedgerGap {
  readonly case: string;
  readonly reason: LedgerGapReason;
}

export interface LedgerLabelResult {
  readonly label: LedgerLabel;
  /** The model called `finish` in this session. */
  readonly finished: boolean;
  /** How many non-guard cases the ledger carries. */
  readonly cases: number;
  /** Case ids the host saw green on the final tree, guards included. */
  readonly green: string[];
  readonly gaps: LedgerGap[];
  /** Non-guard cases that were green on the FINAL tree and also green on the
   * base tree: they count as guards (standing checks), not as evidence of
   * the change (LABEL-EVIDENCE C2). */
  readonly green_at_base: string[];
  /** Guards whose command targets lost pre-existing lines against the
   * session base (D26): their green run was read off a file the session
   * itself rewrote, so they are not held. A guard here is either DECLARED
   * (`guard: true`) or implicit — a case green on the final tree and on the
   * base tree, which is a standing check by observation (D32). Empty for
   * every recording whose log carries no `ledger/case_targets` rows. */
  readonly guard_tampered: string[];
  /** Non-guard cases whose TEST-file target lost pre-existing lines against
   * the session base (D26): the change such a case demonstrates is the
   * session's own edit of the test, so it is not red→green evidence.
   * Added-only targets never appear here — writing a new test is the point. */
  readonly case_tampered: string[];
  readonly open_todos: string[];
  /** Todos the model marked done whose cases are not green on the final tree. */
  readonly disagreement_todos: string[];
  readonly model_host_disagreement: boolean;
  /** D52: the cases a plan revision dropped explicitly (`drop_cases`) and no
   * later revision declared again, with the reason each drop gave — present
   * only when there is one. Data, never a branch of the label: a dropped
   * case is out of the ledger and is not observed, and this is where a
   * dropped check, red or not, stays visible. */
  readonly dropped_cases?: LedgerCaseDrop[];
  /** The workspace digest the end-of-run observations were anchored to. */
  readonly workspace_image?: string;
  readonly exit_code: 0 | 1;
}

/** The observation rows the conclusion writes carry this planner marker, so a
 * ledger session's own rows are never confused with a graph-loop plan's. They
 * also carry their own event names (`ledger/case`, `ledger/runner_*`): v1's
 * replay reads every `work/case` row with a status as a graph-loop work
 * decision, one event name per meaning. */
export const LEDGER_PLANNER = "ledger";

/** V7 (D57i): only a host-judged run's receipt stands behind a green row. */
const RECEIPT_NAMES = new Set(["verify/receipt"]);

interface CaseObservation {
  readonly status: string;
  readonly unrunnable: boolean;
  readonly receipt: string | undefined;
  readonly finalImage: string | undefined;
}

/** One `ledger/case_base` row's verdict on a case: green (passed on the base
 * tree too), red (failed there), or not_runnable (the base could not be
 * observed — unknown, never evidence). */
interface BaseObservation {
  readonly status: string;
}

/** One `ledger/case_targets` row: the command's targets the session changed
 * against its base, as the conclusion recorded them — paths and line counts
 * only, with each conventional test path already marked (so this file never
 * consults the registry or the workspace). */
interface TargetObservation {
  readonly targets: readonly {
    readonly path: string;
    readonly added: number;
    readonly removed: number;
    readonly test: boolean;
    /** The line counts could not be read (D57e): never taken as harmless. */
    readonly unknown: boolean;
  }[];
}

/** A target that lost pre-existing lines — or whose counts could not be read,
 * which is never taken as harmless (D57e). */
const lostLines = (target: { readonly removed: number; readonly unknown: boolean }) => target.removed > 0 || target.unknown;

/** A todo the model has not closed: status `open`, or absent (the default). */
function isOpenTodo(todo: { status?: string }): boolean {
  return (todo.status ?? "open") === "open";
}

/** The case ids a todo is answered by: case → scenario → todo, or a case
 * naming the todo itself. A case with neither answers no particular todo, so
 * it never carries a disagreement. */
function casesOfTodo(graph: { readonly scenarios: readonly LedgerScenario[]; readonly cases: readonly LedgerCase[] }, todo: string): string[] {
  const scenarios = new Set(graph.scenarios.filter((item) => item.todo === todo).map((item) => item.id));
  // A `check` case may name its todo directly (D48); no case recorded before
  // that carries the field, so every earlier label derives unchanged.
  return graph.cases
    .filter((item) => (item.scenario !== undefined && scenarios.has(item.scenario)) || item.todo === todo)
    .map((item) => item.id);
}

/** The last end-of-run observation per case id, the anchor those rows were
 * written against, and the base-tree and target observations of the same
 * pass. A resumed session appends a fresh pass, so only the rows carrying the
 * newest anchor are this run's; a new pass retires the previous pass's base
 * and target rows with it. */
function observations(events: readonly EventRecord[]): {
  rows: Map<string, CaseObservation>;
  baseRows: Map<string, BaseObservation>;
  targetRows: Map<string, TargetObservation>;
  anchor: string | undefined;
} {
  const rows = new Map<string, CaseObservation>();
  const baseRows = new Map<string, BaseObservation>();
  const targetRows = new Map<string, TargetObservation>();
  let anchor: string | undefined;
  for (const event of events) {
    if (event.payload.planner !== LEDGER_PLANNER) continue;
    if (event.name === "ledger/case_base") {
      const id = event.payload.case;
      if (typeof id === "string") {
        // A property row's status is the verdict of its own `property` field,
        // whatever the row claims (D58b V2).
        const status = event.payload.property !== undefined
          ? propertyRowStatus(event.payload.property)
          : typeof event.payload.status === "string" ? event.payload.status : "";
        baseRows.set(id, { status });
      }
      continue;
    }
    if (event.name === "ledger/case_targets") {
      const id = event.payload.case;
      if (typeof id === "string") {
        const list = Array.isArray(event.payload.targets) ? event.payload.targets : [];
        const targets = list.flatMap((item: unknown) => {
          if (typeof item !== "object" || item === null) return [];
          const { path, added, removed, test, unknown } = item as Record<string, unknown>;
          if (typeof path !== "string") return [];
          return [{
            path,
            added: typeof added === "number" ? added : 0,
            removed: typeof removed === "number" ? removed : 0,
            test: test === true,
            unknown: unknown === true,
          }];
        });
        // A row whose targets could not be observed at all (B1, D57f: the
        // session's base record cannot be loaded) is one unknown test target:
        // the case or guard counts as tampered (U1), never as untouched.
        if (typeof event.payload.unknown === "string") targets.push({ path: "", added: 0, removed: 0, test: true, unknown: true });
        targetRows.set(id, { targets });
      }
      continue;
    }
    if (event.name !== "ledger/case") continue;
    const id = event.payload.id;
    if (typeof id !== "string") continue;
    const finalImage = typeof event.payload.final_image === "string" ? event.payload.final_image : undefined;
    if (finalImage !== undefined) {
      // A new anchor means a new observation pass (a resumed run concluding
      // again): the previous pass's rows are history, not this run's evidence.
      if (anchor !== undefined && finalImage !== anchor) {
        rows.clear();
        baseRows.clear();
        targetRows.clear();
      }
      anchor = finalImage;
    }
    // A property row: green, red or unknown by its own fields (D58b V2) —
    // unknown read as the label reads any run that did not complete.
    const verdict = event.payload.property !== undefined ? propertyRowStatus(event.payload.property) : undefined;
    rows.set(id, {
      status: verdict !== undefined ? (verdict === "green" ? "green" : "red") : typeof event.payload.status === "string" ? event.payload.status : "",
      unrunnable: verdict !== undefined
        ? verdict === "not_runnable"
        : typeof event.payload.unrunnable === "string" && event.payload.unrunnable.length > 0,
      receipt: typeof event.payload.receipt === "string" ? event.payload.receipt : undefined,
      finalImage,
    });
  }
  return { rows, baseRows, targetRows, anchor };
}

/** Receipt ids the log actually holds; a green claim with no receipt behind it
 * is a claim, not evidence. */
function receiptIds(events: readonly EventRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (!RECEIPT_NAMES.has(event.name)) continue;
    if (typeof event.payload.id === "string") ids.add(event.payload.id);
  }
  return ids;
}

/** The entries of a revision's cases list that no observation row can name
 * (V5'), each as the gap names it. */
function unnamedCases(revision: { readonly graph: unknown }): string[] {
  const cases = (revision.graph as { readonly cases?: unknown } | undefined)?.cases;
  if (!Array.isArray(cases)) return [];
  const named = new Set(revisionCases(revision as never));
  return cases.filter((item) => !named.has(item as never)).map((item) => {
    const id = typeof item === "object" && item !== null ? (item as { readonly id?: unknown }).id : undefined;
    return id === undefined ? "?" : String(id);
  });
}

/** The whole terminal verdict of a ledger session, from recorded rows only. */
export function deriveLedgerLabel(events: readonly EventRecord[]): LedgerLabelResult {
  // `finish` is the model's claim that the order is met. The ledger session's
  // only writer of this row is the finish tool, which always carries a summary.
  const finished = events.some(
    (event) => event.name === "work/finish" && typeof event.payload.summary_digest === "string",
  );
  const fold = foldLedger(events);
  const latest = fold.revision();
  // V5' (D58c): the lists every rule below reads, as a reader can rely on
  // them. An entry of the cases list no row can name (not an object with a
  // text id — only a hand-written graph holds one) is still a case of the
  // ledger: never observed, so a gap, never dropped from the count.
  const unnamed = latest === undefined ? [] : unnamedCases(latest);
  const graph = latest === undefined
    ? undefined
    : { cases: revisionCases(latest), todos: revisionTodos(latest) as LedgerTodo[], scenarios: revisionScenarios(latest) };
  const dropped = fold.droppedCases();
  const observed = observations(events);
  const receipts = receiptIds(events);

  const gaps: LedgerGap[] = unnamed.map((item) => ({ case: item, reason: "not_observed" as const }));
  const green: string[] = [];
  let nonGuard = unnamed.length;
  for (const item of graph?.cases ?? []) {
    if (item.guard !== true) nonGuard += 1;
    const row = observed.rows.get(item.id);
    const reason: LedgerGapReason | undefined = row === undefined
      ? "not_observed"
      : row.unrunnable
        ? "not_runnable"
        : row.status !== "green"
          ? "red"
          : row.receipt === undefined || !receipts.has(row.receipt)
            ? "no_receipt"
            : undefined;
    if (reason === undefined) green.push(item.id);
    else gaps.push({ case: item.id, reason });
  }

  // The base-tree evidence (LABEL-EVIDENCE C2). A session whose log carries
  // `ledger/case_base` rows for its cases additionally needs one non-guard
  // case that is RED on the base tree and green on the final tree: that is
  // what "the work caused this change" means by observation. A case green on
  // BOTH trees never blocks anything, but it is reported as green_at_base and
  // counts as a guard, not as evidence. not_runnable at base is unknown, and
  // unknown is never evidence.
  //
  // REPLAY TOLERANCE, stated explicitly: a session whose log has NO
  // `ledger/case_base` rows for its cases — every recording made before this
  // rule existed, and any replay of one — keeps the pre-existing rule below,
  // so re-deriving an existing recorded session's label reproduces it
  // unchanged. Base rows only appear in sessions concluded after this rule.
  const nonGuardCases = (graph?.cases ?? []).filter((item) => item.guard !== true);
  const baseObserved = nonGuardCases.some((item) => observed.baseRows.has(item.id));

  // The tamper lists (D26, D32). A session whose log carries
  // `ledger/case_targets` rows for its cases additionally has its evidence
  // read for independence: a GUARD — declared, or green on both trees and so
  // a guard by behaviour — whose command target lost pre-existing lines
  // (removed>0) was run against a file the session itself rewrote, so it is
  // not held; a non-guard CASE whose test-file target (a conventional test
  // path its command names) lost pre-existing lines demonstrates its own
  // edit, not the work. A target that only GAINED lines never counts here —
  // writing a new test is the point — and neither does a changed product or
  // data file the command merely names: that is the check's subject, the
  // work itself.
  //
  // REPLAY TOLERANCE, stated explicitly: a session whose log has NO
  // `ledger/case_targets` rows for its cases — every recording made before
  // this rule existed, and any replay of one — computes both lists empty and
  // keeps the pre-existing rules below, so re-deriving an existing recorded
  // session's label reproduces it unchanged. Target rows only appear in
  // sessions concluded after this rule.
  const targetsObserved = (graph?.cases ?? []).some((item) => observed.targetRows.has(item.id));
  const caseTampered = targetsObserved
    ? nonGuardCases
      .filter((item) => observed.targetRows.get(item.id)?.targets.some((target) => lostLines(target) && target.test) ?? false)
      .map((item) => item.id)
    : [];
  const tamperedEvidence = new Set(caseTampered);

  const greenAtBase: string[] = [];
  let redAtBaseGreenOnFinal = 0;
  for (const item of nonGuardCases) {
    const base = observed.baseRows.get(item.id);
    if (base?.status === "green" && green.includes(item.id)) greenAtBase.push(item.id);
    if (base?.status === "red" && green.includes(item.id) && !tamperedEvidence.has(item.id)) redAtBaseGreenOnFinal += 1;
  }

  // A guard is what a case BEHAVES like, not only what the model declared
  // (D32). A non-guard case green on the final tree AND green on the base
  // tree is a standing check by observation — the green_at_base set just
  // computed, which C2 already refuses as evidence — so the independence rule
  // reads it as a guard too: if any of its targets lost pre-existing lines,
  // its greenness was read off a file the session itself rewrote, and it is
  // not held. Such a case is reported in guard_tampered (its id stays in
  // green_at_base) and, exactly as a declared tampered guard, blocks
  // `accepted`.
  const implicitGuards = new Set(greenAtBase);
  const guardTampered = targetsObserved
    ? (graph?.cases ?? [])
      .filter((item) => (item.guard === true || implicitGuards.has(item.id))
        && (observed.targetRows.get(item.id)?.targets.some(lostLines) ?? false))
      .map((item) => item.id)
    : [];

  const openTodos = (graph?.todos ?? []).filter(isOpenTodo).map((item) => item.id);
  const disagreementTodos = (graph?.todos ?? [])
    .filter((item) => item.status === "done")
    .filter((item) => casesOfTodo(graph!, item.id).some((id) => !green.includes(id)))
    .map((item) => item.id);

  // §4: finish plus at least one non-guard case, every non-guard case green on
  // the final digest and every guard green — and, when the session's log
  // carries base observations, at least one of them red at base and green at
  // final (the change, observed), with no tampered guard holding and no
  // tampered case standing as that evidence. Anything less is still delivered
  // work, it is simply not shown.
  const label: LedgerLabel = !finished
    ? "incomplete"
    : nonGuard > 0 && gaps.length === 0 && guardTampered.length === 0 && (!baseObserved || redAtBaseGreenOnFinal > 0)
      ? "accepted"
      : "done_unverified";

  return {
    label,
    finished,
    cases: nonGuard,
    green,
    gaps,
    green_at_base: greenAtBase,
    guard_tampered: guardTampered,
    case_tampered: caseTampered,
    open_todos: openTodos,
    disagreement_todos: disagreementTodos,
    model_host_disagreement: disagreementTodos.length > 0,
    ...(dropped.length > 0 ? { dropped_cases: dropped } : {}),
    ...(observed.anchor !== undefined ? { workspace_image: observed.anchor } : {}),
    exit_code: label === "incomplete" ? 1 : 0,
  };
}

/** Why a `done_unverified` conclusion could not show the work, as one line
 * of text read off the returned result alone (D42 B3) — reporting only, the
 * label above is not consulted again. Gaps come first, as they always did;
 * without gaps the specific causes the result carries are named: no
 * non-guard case, a tampered guard, a tampered case, or no case red on the
 * base tree and green on the final one (with the cases green on both). "no
 * cases recorded" is said only when the result holds no case at all. */
export function describeUnverified(conclusion: LedgerLabelResult): string {
  if (conclusion.gaps.length > 0) {
    return conclusion.gaps.map((gap) => `${gap.case}=${gap.reason}`).join(" ");
  }
  if (conclusion.cases === 0 && conclusion.green.length === 0) return "no cases recorded";
  const causes: string[] = [];
  if (conclusion.cases === 0) causes.push("no non-guard case");
  // Every non-guard case is green here (no gaps). The red→green evidence is
  // certainly missing when no tampered guard explains the label, or when
  // every non-guard case is green on both trees or a tampered case — the two
  // lists hold non-guard ids only.
  const withoutEvidence = new Set([...conclusion.green_at_base, ...conclusion.case_tampered]).size;
  if (conclusion.cases > 0 && (conclusion.guard_tampered.length === 0 || withoutEvidence >= conclusion.cases)) {
    causes.push(conclusion.green_at_base.length > 0
      ? `no case red on base and green on final (green on both: ${conclusion.green_at_base.join(" ")})`
      : "no case red on base and green on final");
  }
  if (conclusion.guard_tampered.length > 0) causes.push(`tampered guard: ${conclusion.guard_tampered.join(" ")}`);
  if (conclusion.case_tampered.length > 0) causes.push(`tampered case: ${conclusion.case_tampered.join(" ")}`);
  return causes.join("; ");
}
