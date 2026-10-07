import { canonicalJson } from "../host/canonical.ts";
import { projectObligations, obligationErrors } from "./evidence/obligations.ts";
import { caseMeasurementSchema } from "./evidence/measurements.ts";
import type { EventRecord } from "../host/schema.ts";
import type { WorkPlan } from "./schema.ts";

/**
 * A bar the run can move is not a bar.
 *
 * An audit reopened three cases whose thresholds sat beside a comment saying
 * they had been calibrated to the machine's observed numbers. A bar chosen
 * after the measurement cannot fail; it tests nothing. The answer was to fix
 * bars in the ledger and make each run echo the bar it applied, and later to
 * hand the bars to the run so no editable copy sat on the host.
 *
 * One door stayed open: the ledger itself. A replan turn rewrites the plan, so
 * a run that could not reach its bar could write a lower one into the case and
 * then echo it honestly — every check downstream would agree, because they all
 * compare against the declaration. That is the same forgery one level up.
 *
 * So within an evidence scope a declared bar is immutable. It may not be
 * lowered, raised, or quietly dropped; only a new operator order sets
 * different ones. Adding a bar is allowed — that is more judgment, not less.
 */

export type CaseBars = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * The operator's own bar change, recorded before the ledger is edited.
 *
 * The pin says only a new operator order may set different bars, and mid-run
 * the operator had no way to give one: an order arrives on stdin at launch,
 * and a note is transport, not authority. So an operator who found a bar
 * unreachable — an absolute error bar against a quantised checkpoint, an
 * exactness bar against a MoE whose expert choice moves with batch shape —
 * edited the ledger and watched the host refuse the run's next reload for
 * dropping a bar the run had not touched. A whole wave went to that.
 *
 * This event is that authority, and it is narrow: it names one case, sets or
 * removes named bars, and carries the reason. Everything it does not name
 * stays pinned, so it widens nothing else.
 */
export const OPERATOR_BAR_EVENT = "work/bars_set";

/** The bars a plan declares, keyed by case id. Cases without bars are absent. */
export function barsOf(plan: WorkPlan): CaseBars {
  const bars: Record<string, Record<string, string>> = {};
  for (const item of plan.cases ?? []) {
    const declared = item.thresholds;
    if (!declared || Object.keys(declared).length === 0) continue;
    bars[item.id] = { ...declared };
  }
  return bars;
}

/**
 * What this scope has already declared, merged across the scope's plans. A
 * later plan that adds a bar extends the pin rather than replacing it, so a
 * bar cannot be escaped by dropping it in one turn and rewriting it in the
 * next.
 */
export function declaredBars(events: readonly EventRecord[]): CaseBars {
  const current = projectObligations(events).current;
  if (current) return barsOf(current.plan);
  const bars: Record<string, Record<string, string>> = {};
  for (const event of events) {
    if (event.name === OPERATOR_BAR_EVENT) {
      applyOperatorBars(bars, event.payload);
      continue;
    }
    if (event.name !== "work/bars") continue;
    const recorded = (event.payload as { bars?: unknown }).bars;
    if (typeof recorded !== "object" || recorded === null) continue;
    for (const [caseId, entry] of Object.entries(recorded as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const target = bars[caseId] ?? (bars[caseId] = {});
      for (const [name, value] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof value === "string") target[name] = value;
      }
    }
  }
  return bars;
}

/** One operator decision folded in: a string sets a bar, null removes it. */
function applyOperatorBars(bars: Record<string, Record<string, string>>, payload: Record<string, unknown>): void {
  const caseId = typeof payload.case === "string" ? payload.case : undefined;
  const entry = payload.bars;
  if (!caseId || typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
  const target = bars[caseId] ?? (bars[caseId] = {});
  for (const [name, value] of Object.entries(entry as Record<string, unknown>)) {
    if (typeof value === "string") target[name] = value;
    else if (value === null) delete target[name];
  }
  if (Object.keys(target).length === 0) delete bars[caseId];
}

/**
 * The events a pin covers: everything since the operator's last order.
 *
 * The boundary is the order, not the plan. Scope helpers that key off a plan
 * digest treat a rewritten plan as a new scope — which is precisely the plan
 * whose bars need holding — so the pin reads the goal events directly. A new
 * order may set any bars it likes; a replan under the same order may not.
 */
export function barScopeEvents(events: readonly EventRecord[]): readonly EventRecord[] {
  const goals = events.filter((event) => event.name === "work/goal");
  const latest = goals.at(-1);
  if (latest === undefined) return events;
  const scope = latest.payload.scope_seq;
  const start = typeof scope === "number" && Number.isSafeInteger(scope) && scope > 0 && scope <= latest.seq ? scope : latest.seq;
  return events.filter((event) => event.seq >= start);
}

/** A bar compares by its meaning, not its spacing. */
function same(a: string, b: string): boolean {
  return a.replace(/\s+/gu, "") === b.replace(/\s+/gu, "");
}

/**
 * Every declared bar this plan moves or drops, one sentence each. Empty when
 * the plan honours what the scope already declared.
 */
export function movedBars(pinned: CaseBars, plan: WorkPlan): string[] {
  const proposed = barsOf(plan);
  const known = new Set((plan.cases ?? []).map((item) => item.id));
  const moved: string[] = [];
  for (const [caseId, bars] of Object.entries(pinned)) {
    // A case removed outright is a graph change, judged elsewhere; only a case
    // still in the plan can be passed by softening what judges it.
    if (!known.has(caseId)) continue;
    for (const [name, value] of Object.entries(bars)) {
      const now = proposed[caseId]?.[name];
      if (now === undefined) {
        moved.push(
          `case ${caseId} dropped the bar ${name}=${value} declared earlier in this order — `
          + `a case with no bar passes on anything`,
        );
        continue;
      }
      if (!same(now, value)) {
        moved.push(
          `case ${caseId} changed the bar ${name} from ${value} to ${now} — `
          + `a bar chosen after the measurement cannot fail`,
        );
      }
    }
  }
  return moved;
}

/** Why a plan that moves bars is refused, said to the model that wrote it. */
export function movedBarsRefusal(moved: readonly string[]): string[] {
  if (moved.length === 0) return [];
  return [
    ...moved,
    "The bars for this order are fixed. If one is unreachable, leave the case red and "
    + "record the measurement and the reason — only the operator changes a bar.",
  ];
}

/** Measurement requirements are fixed by the same operator-order boundary as
 * legacy bars. Read recorded case definitions; no second measurement ledger. */
export function movedMeasurements(events: readonly EventRecord[], plan: WorkPlan): string[] {
  if (projectObligations(events).current) return obligationErrors(plan, events);
  const known = new Map(plan.cases.map(item => [item.id, item]));
  const first = new Map<string, { measurement: unknown; substrate: unknown }>();
  const moved: string[] = [];
  for (const event of barScopeEvents(events)) {
    if (event.name !== "work/case" || typeof event.payload.scenario !== "string" || event.payload.measurement === undefined) continue;
    const id = event.payload.id;
    if (typeof id !== "string") throw new Error("recorded measurement case has no identity");
    const measurement = caseMeasurementSchema.parse(event.payload.measurement);
    const terms = { measurement, substrate: event.payload.substrate ?? null };
    const prior = first.get(id);
    if (prior && canonicalJson(prior) !== canonicalJson(terms)) throw new Error(`recorded measurement contract changed within this order: ${id}`);
    first.set(id, terms);
  }
  for (const [id, pinned] of first) {
    const next = known.get(id);
    if (!next) continue; // Removing obligations belongs to graph/order admission.
    const proposed = { measurement: next.measurement ?? null, substrate: next.substrate ?? null };
    if (next.evidence_level !== undefined || canonicalJson(pinned) !== canonicalJson(proposed)) {
      moved.push(`case ${id} changed or dropped its protected measurement contract within this order — workload, requirements, witnesses and evidence level require a new operator order`);
    }
  }
  return moved;
}
