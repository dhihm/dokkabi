import type { EventRecord } from "../../host/schema.ts";
import { projectExperimentCondition, type ExperimentFactor } from "../../eval/experiment/condition.ts";
import { acquireObligationCases, projectPlanDrafts } from "./obligations.ts";

/** Private to one synchronous earned projection. Rows retain their exact
 * identities and array order; no log, blob, file or process cache outlives it. */
export class EarnedProjectionIndex {
  readonly events: readonly EventRecord[];
  private readonly members: Set<EventRecord>;
  private readonly sequences = new Map<unknown, EventRecord[]>();
  private readonly names = new Map<string, EventRecord[]>();
  private readonly ends = new Map<unknown, EventRecord>();
  private readonly firstCases = new Map<unknown, number>();
  private readonly workspaceInputs = new Map<unknown, EventRecord>();
  private conditionValue?: ReturnType<typeof projectExperimentCondition>;
  private draftsValue?: ReturnType<typeof projectPlanDrafts>;
  private obligationValue?: ReturnType<typeof acquireObligationCases>;
  private readonly caseKeys = new Map<string, string[]>();

  constructor(events: readonly EventRecord[]) {
    this.events = [...events];
    this.members = new Set(events);
    for (const row of this.events) {
      this.add(this.sequences, row.seq, row);
      this.add(this.names, row.name, row);
      if (row.name === "work/execution_end" && !this.ends.has(row.payload.execution_start)) this.ends.set(row.payload.execution_start, row);
      if (row.name === "work/case") {
        const key = row.payload.execution_start;
        this.firstCases.set(key, Math.min(this.firstCases.get(key) ?? Infinity, row.seq));
      }
    }
    // End observations may omit workspace: preserve the original first-start
    // fallback, including the refusal of a later unknown candidate observation.
    for (const row of this.rows("work/execution_start", "work/execution_end")) {
      const workspace = row.name === "work/execution_start" ? row.payload.workspace
        : row.payload.workspace ?? this.reference(row.payload.execution_start, "work/execution_start")?.payload.workspace;
      this.workspaceInputs.set(workspace, row);
    }
  }

  private add<K>(map: Map<K, EventRecord[]>, key: K, row: EventRecord): void {
    const rows = map.get(key);
    if (rows) rows.push(row); else map.set(key, [row]);
  }

  requireMember(row: EventRecord): void {
    if (!this.members.has(row)) throw new Error("earned projection receipt is outside its event snapshot");
  }

  reference(seq: unknown, name?: string, hash?: unknown): EventRecord | undefined {
    const exactHash = arguments.length >= 3;
    return this.sequences.get(seq)?.find(row => (name === undefined || row.name === name) && (!exactHash || row.hash === hash));
  }

  rows(...names: string[]): readonly EventRecord[] {
    if (names.length === 1) return this.names.get(names[0]!) ?? [];
    const selected = new Set(names);
    return this.events.filter(row => selected.has(row.name));
  }

  firstEnd(start: number): EventRecord | undefined { return this.ends.get(start); }
  usedBefore(start: number, seq: number): boolean { return (this.firstCases.get(start) ?? Infinity) < seq; }
  latestInput(workspace: string): EventRecord | undefined { return this.workspaceInputs.get(workspace); }
  condition() { return this.conditionValue ??= projectExperimentCondition(this.events); }
  removes(factor: ExperimentFactor): boolean { return this.condition().binding?.resolved.removed.includes(factor) ?? false; }
  drafts() { return this.draftsValue ??= projectPlanDrafts(this.events); }
  obligations() { return this.obligationValue ??= acquireObligationCases(this.events); }
  keys(id: string): readonly string[] {
    let keys = this.caseKeys.get(id);
    if (!keys) { keys = this.obligations().caseKeys(id); this.caseKeys.set(id, keys); }
    return keys;
  }
}
