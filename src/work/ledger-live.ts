import type { EventLog } from "../host/event-log.ts";
import { environmentFactsFromPayload, type EnvironmentFacts } from "../host/environment-facts.ts";
import type { EventRecord } from "../host/schema.ts";
import { LedgerFold, type LedgerRevision } from "./plan-ledger.ts";
import { PropertyCounterexampleFold, type PropertyCaseRef, type PropertyReplay } from "./ledger-property.ts";

/**
 * The running ledger projection of one writer's log (D48b, design memo §99
 * T7): what the ledger tools read from the log on every call, kept as a fold
 * that each call extends by the rows appended since the previous one, so a
 * call's cost does not grow with the session. It holds the ledger
 * (LedgerFold: the same fold projectLedger runs over the whole log, so the
 * same revision, the same check cases kept across plan revisions and the
 * same drops, D52), the order the ledger works on (ledgerOrderStatement's
 * work/goal rule), the latest recorded environment facts (the latest
 * host/environment row), the number of work/defect, work/dispute and
 * work/ruling rows (D54), and the counterexamples each property's
 * observations recorded (D58), which the next call replays first.
 *
 * Rows are hash-chained, so a fold whose last row is still at the same
 * position with the same hash covers an unchanged prefix of the log; a log
 * that no longer extends it (re-read after another writer, truncated) folds
 * again from its first row — the same guard the provider-input projection
 * uses (host/provider-input.ts).
 */

/** What the running projections of one log have done so far — diagnostic
 * only: how a test holds a call's cost to the rows it appends. */
export interface LedgerFoldWork {
  rowsFolded: number;
  casesFolded: number;
  refolds: number;
}

export class LiveLedger {
  readonly fold: LedgerFold;
  /** How many rows of the log the fold has consumed, and the last one's hash. */
  consumed = 0;
  head: string | undefined;
  private readonly goals = new Map<number, string | undefined>();
  private scope: number | undefined;
  private environment: EventRecord | undefined;
  private parsed: { readonly row: EventRecord; readonly facts: EnvironmentFacts | undefined } | undefined;
  private defects = 0;
  private disputes = 0;
  private rulings = 0;
  private readonly counterexamples = new PropertyCounterexampleFold();

  constructor(private readonly work: LedgerFoldWork) {
    this.fold = new LedgerFold(work);
  }

  /** Fold rows [consumed, events.length). */
  extend(events: readonly EventRecord[]): void {
    const from = this.consumed;
    for (let index = from; index < events.length; index += 1) {
      const event = events[index]!;
      this.fold.push(event);
      this.counterexamples.push(event);
      if (event.name === "work/goal") {
        this.goals.set(event.seq, typeof event.payload.statement === "string" ? event.payload.statement : undefined);
        const scope = event.payload.scope_seq;
        this.scope = typeof scope === "number" && Number.isSafeInteger(scope) && scope > 0 && scope <= event.seq ? scope : event.seq;
      } else if (event.name === "host/environment") {
        this.environment = event;
      } else if (event.name === "work/defect") {
        this.defects += 1;
      } else if (event.name === "work/dispute") {
        this.disputes += 1;
      } else if (event.name === "work/ruling") {
        this.rulings += 1;
      }
      this.head = event.hash;
    }
    this.consumed = events.length;
    this.work.rowsFolded += events.length - from;
  }

  /** The latest revision (projectLedger of the log). */
  revision(): LedgerRevision | undefined {
    return this.fold.revision();
  }

  /** The operator order the ledger works on (ledgerOrderStatement of the
   * log): the statement of the work/goal row opening the current scope. */
  orderStatement(): string | undefined {
    return this.scope === undefined ? undefined : this.goals.get(this.scope);
  }

  /** The facts of the latest host/environment row, parsed once per row. */
  environmentFacts(): EnvironmentFacts | undefined {
    const row = this.environment;
    if (row === undefined) return undefined;
    if (this.parsed?.row !== row) this.parsed = { row, facts: environmentFactsFromPayload(row.payload as Record<string, unknown>) };
    return this.parsed.facts;
  }

  /** How many work/defect rows the log holds. */
  defectRows(): number {
    return this.defects;
  }

  /** How many work/dispute rows the log holds (D54). */
  disputeRows(): number {
    return this.disputes;
  }

  /** How many work/ruling rows the log holds (D54). */
  rulingRows(): number {
    return this.rulings;
  }

  /** The counterexamples the observations of property `id` recorded, first
   * recorded first (D58): what its next call replays before its sample. */
  propertyCounterexamples(id: string): PropertyCaseRef[] {
    return this.counterexamples.refs(id);
  }

  /** The same, with how many more were recorded than the replay cap lets an
   * observation re-run (D58b V1: they keep it from being green). */
  propertyReplay(id: string): PropertyReplay {
    return this.counterexamples.replay(id);
  }
}

const live = new WeakMap<EventLog, LiveLedger>();
const works = new WeakMap<EventLog, LedgerFoldWork>();

function workOf(log: EventLog): LedgerFoldWork {
  let work = works.get(log);
  if (work === undefined) works.set(log, work = { rowsFolded: 0, casesFolded: 0, refolds: 0 });
  return work;
}

/** The running projection of `log`, extended to its last row. */
export function liveLedger(log: EventLog): LiveLedger {
  const events = log.events;
  const work = workOf(log);
  let entry = live.get(log);
  if (entry !== undefined) {
    const extendsPrefix = entry.consumed <= events.length
      && (entry.consumed === 0 || events[entry.consumed - 1]?.hash === entry.head);
    if (!extendsPrefix) {
      entry = undefined;
      work.refolds += 1;
    }
  }
  if (entry === undefined) {
    entry = new LiveLedger(work);
    live.set(log, entry);
  }
  entry.extend(events);
  return entry;
}

/** The work the running projections of `log` have done so far. */
export function ledgerFoldWork(log: EventLog): Readonly<LedgerFoldWork> {
  return { ...workOf(log) };
}
