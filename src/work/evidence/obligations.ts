import { barValuesOnly, conditionRemoves, projectExperimentCondition } from "../../eval/experiment/condition.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../host/canonical.ts";
import type { EventRecord, EventInput } from "../../host/schema.ts";
import type { WorkPlan } from "../schema.ts";

export const OBLIGATION_EVENT = "work/obligations";
export const AUTHORITY_EVENT = "work/authority_patch";
export const AUTHORITY_REFUSAL = "work/authority_refused";
export const PLAN_DRAFT = "work/plan_draft";
export const PLAN_DRAFT_RESULT = "work/plan_draft_result";
export const INITIAL_REGRESSION_POLICY = "native-draft-regression-v1";
export interface PlanDraft {
  event: EventRecord;
  snapshot: ObligationSnapshot;
  result?: EventRecord;
}
export type ObligationKind = "goal" | "todo" | "scenario" | "case";
export interface Obligation {
  key?: string;
  kind: ObligationKind;
  alias: string;
  signature: string;
}
export interface ObligationSnapshot {
  schema_version: 1;
  scope_seq: number;
  revision: number;
  parent_digest: string | null;
  plan: WorkPlan;
  runners: Record<string, unknown>;
  obligations: Obligation[];
  digest: string;
}
export interface AuthorityPatch {
  schema_version: 1;
  expected_digest: string;
  expected_revision: number;
  reason: string;
  replacement_plan: WorkPlan;
  replacement_runners: Record<string, unknown>;
  retirements: { kind: ObligationKind; alias: string; replacement_aliases: string[] }[];
}
export const obligationDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const copy = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;

/** Display names are aliases. Relationships refer to semantic parent identities,
 * and repeated identical requirements retain their multiplicity. */
/**
 * The recorded identity of every obligation. It includes each case's
 * red_means/green_means, and it must stay exactly this: every snapshot
 * already in a session log was keyed with it, and replay recomputes it.
 * Changing what goes in here strands every running session ("obligation
 * snapshot identity differs") -- which is what happened when the prose was
 * first taken out here instead of in requirementObligations below.
 */
export function planObligations(plan: WorkPlan, runners: Record<string, unknown> = {}): Obligation[] {
  return obligationsOf(plan, runners, false);
}

/**
 * What only the operator may change: the same obligations with each case's
 * red_means/green_means and each todo's tool profile left out, and the goal
 * compared without regard to whitespace. Those say what the evidence will look like;
 * they are not bars. The command, thresholds, host, dir, runner and scenario
 * stay pinned, and red_means is still held to the output at the moment a RED
 * is judged (verify.ts classifyRedFailure). A draft whose red_means missed a
 * value its genuine RED prints can say so, instead of being refused as an
 * operator-only change and resubmitting the same draft for an hour.
 */
export function requirementObligations(plan: WorkPlan, runners: Record<string, unknown> = {}): Obligation[] {
  return obligationsOf(plan, runners, true);
}

function obligationsOf(plan: WorkPlan, runners: Record<string, unknown>, requirementsOnly: boolean): Obligation[] {
  const result: Obligation[] = [];
  const add = (kind: ObligationKind, alias: string, body: unknown) => {
    const signature = obligationDigest({ kind, body }); result.push({ kind, alias, signature }); return signature;
  };
  // The sealed goal is the operator's order, stored with its newlines
  // collapsed; a run restating it keeps them. Whitespace is not a requirement:
  // a live run had eight replans refused for it in thirty minutes.
  add("goal", plan.goal.id, {
    statement: requirementsOnly ? plan.goal.statement.replace(/\s+/gu, " ").trim() : plan.goal.statement,
    require_red_first: plan.require_red_first ?? false,
  });
  const todoBodies = new Map(plan.todos.map(todo => {
    const { id, title: _title, priority: _priority, plan: _approach, blocked_by: _dependencies, ...full } = todo;
    // A todo's tool profile is how the step works, not what it must deliver:
    // a run that scoped a step to a profile without the tool it needs has to
    // be able to widen it (loader/tool-profile-policy.ts).
    const { profile: _profile, ...requirement } = full;
    return [id, requirementsOnly ? requirement : full] as const;
  }));
  const todoDefinitions = new Map(plan.todos.map(todo => [todo.id, todo]));
  const todos = new Map<string, string>();
  const visiting = new Set<string>();
  const todoSignature = (id: string): string => {
    const cached = todos.get(id); if (cached) return cached;
    if (visiting.has(id)) throw new Error("obligation dependency cycle");
    const todo = todoDefinitions.get(id);
    if (!todo) return obligationDigest({ external_prerequisite: id });
    visiting.add(id);
    const signature = obligationDigest({ kind: "todo", body: { requirement: todoBodies.get(id),
      dependencies: (todo.blocked_by ?? []).map(todoSignature).sort() } });
    visiting.delete(id); todos.set(id, signature); return signature;
  };
  for (const todo of plan.todos) result.push({ kind: "todo", alias: todo.id, signature: todoSignature(todo.id) });
  const scenarios = new Map(plan.scenarios.map(scenario => {
    const { id, todo, ...body } = scenario;
    return [id, add("scenario", id, { ...body, owner: todos.get(todo) ?? { missing_todo: todo } })];
  }));
  for (const item of plan.cases) {
    const { id, scenario, ...full } = item;
    const { red_means: _red, green_means: _green, ...requirement } = full;
    const body = requirementsOnly ? requirement : full;
    add("case", id, { ...body, scenario: scenarios.get(scenario) ?? { inherited_scenario: scenario }, runner: runners[id] ?? null });
  }
  return result;
}

export function orderScope(events: readonly EventRecord[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const row = events[i]!;
    if (row.name !== "work/goal") continue;
    const scope = row.payload.scope_seq;
    return typeof scope === "number" && Number.isSafeInteger(scope) && scope > 0 && scope <= row.seq ? scope : row.seq;
  }
  return undefined;
}

export function missingObligations(prior: readonly Obligation[], next: readonly Obligation[]): Obligation[] {
  const available = new Map<string, number>();
  for (const item of next) available.set(item.signature, (available.get(item.signature) ?? 0) + 1);
  return prior.filter(item => {
    const count = available.get(item.signature) ?? 0;
    if (!count) return true;
    available.set(item.signature, count - 1); return false;
  });
}

export function makeSnapshot(plan: WorkPlan, runners: Record<string, unknown>, scope: number, prior?: ObligationSnapshot): ObligationSnapshot {
  const revision = (prior?.revision ?? 0) + 1;
  const available = [...(prior?.obligations ?? [])];
  const obligations = planObligations(plan, runners).map((item, index) => {
    const exact = available.findIndex(old => old.signature === item.signature && old.alias === item.alias);
    const matching = exact >= 0 ? exact : available.findIndex(old => old.signature === item.signature);
    const key = matching < 0 ? obligationDigest({ scope, revision, index, kind: item.kind }) : available.splice(matching, 1)[0]!.key;
    return { ...item, key };
  });
  const body = { schema_version: 1 as const, scope_seq: scope, revision,
    parent_digest: prior?.digest ?? null, plan: copy(plan), runners: copy(runners), obligations };
  return { ...body, digest: obligationDigest(body) };
}

export function snapshotInput(snapshot: ObligationSnapshot): EventInput {
  return { kind: "observe", name: OBLIGATION_EVENT, payload: { schema_version: 1, snapshot_json: canonicalJson(snapshot), digest: snapshot.digest, revision: snapshot.revision, scope_seq: snapshot.scope_seq } };
}

function readSnapshot(row: EventRecord): ObligationSnapshot {
  if (row.kind !== "observe" || typeof row.payload.snapshot_json !== "string") throw new Error("obligation snapshot body is missing");
  const snapshot = JSON.parse(row.payload.snapshot_json) as ObligationSnapshot;
  const { digest, ...body } = snapshot;
  if (snapshot.schema_version !== 1 || !Number.isSafeInteger(snapshot.scope_seq) || snapshot.scope_seq < 1 || snapshot.scope_seq > row.seq
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || digest !== obligationDigest(body)
    || row.payload.digest !== digest || row.payload.revision !== snapshot.revision || row.payload.scope_seq !== snapshot.scope_seq
    || canonicalJson(snapshot.obligations.map(({ key: _key, ...item }) => item)) !== canonicalJson(planObligations(snapshot.plan, snapshot.runners))) throw new Error("obligation snapshot identity differs");
  return snapshot;
}

/** Drafts retain proposed execution contracts, not operator obligations. The
 * first admitted snapshot must be coupled to the exact successful attempt.
 * Native receipt authentication is shared with live admission in earned.ts. */
export function projectPlanDrafts(events: readonly EventRecord[]): PlanDraft[] {
  if (!events.some(row => row.name === PLAN_DRAFT || row.name === PLAN_DRAFT_RESULT)) return [];
  const drafts: PlanDraft[] = [];
  const bound = new Set<number>();
  let scope = events[0]?.seq;
  for (let index = 0; index < events.length; index++) {
    const row = events[index]!;
    if (row.name === "work/goal") scope = orderScope([row]);
    if (row.name === PLAN_DRAFT) {
      const snapshot = readSnapshot(row);
      const order = events.find(event => event.seq === scope && event.name === "work/goal");
      const previous = drafts.filter(draft => draft.snapshot.scope_seq === scope).at(-1);
      if (bound.has(snapshot.scope_seq) || snapshot.scope_seq !== scope || snapshot.revision !== 1
        || snapshot.parent_digest !== null || snapshot.plan.require_red_first !== true
        || typeof row.payload.operator_order !== "string" || !row.payload.operator_order.trim()
        || previous && row.payload.operator_order !== previous.event.payload.operator_order
        || order && order.payload.statement !== snapshot.plan.goal.statement
        || canonicalJson(snapshot) !== canonicalJson(makeSnapshot(snapshot.plan, snapshot.runners, snapshot.scope_seq))) {
        throw new Error("invalid initial plan draft authority");
      }
      if (row.payload.supplemental_policy !== undefined && row.payload.supplemental_policy !== INITIAL_REGRESSION_POLICY) {
        throw new Error("unknown initial draft regression policy");
      }
      drafts.push({ event: row, snapshot });
    } else if (row.name === PLAN_DRAFT_RESULT) {
      const draft = drafts.find(value => value.event.seq === row.payload.draft_seq && value.event.hash === row.payload.draft_hash);
      if (!draft || draft.result || row.kind !== "observe" || !["refused", "admitted"].includes(String(row.payload.status))
        || !Array.isArray(row.payload.errors) || !row.payload.errors.every(error => typeof error === "string")) {
        throw new Error("invalid plan draft result");
      }
      if (row.payload.status === "admitted") {
        const next = events[index + 1];
        if (draft !== drafts.at(-1) || draft.snapshot.scope_seq !== scope || row.payload.errors.length
          || !next || next.seq !== row.seq + 1 || next.name !== OBLIGATION_EVENT
          || next.payload.snapshot_json !== draft.event.payload.snapshot_json
          || !Array.isArray(row.payload.case_refs) || row.payload.case_refs.length !== draft.snapshot.plan.cases.length) {
          throw new Error("plan draft admission is stale or lacks its coupled snapshot");
        }
      } else if (!row.payload.errors.length) throw new Error("refused plan draft needs its reason");
      draft.result = row;
    } else if (row.name === OBLIGATION_EVENT) {
      const snapshot = readSnapshot(row);
      const draft = drafts.filter(value => value.snapshot.scope_seq === snapshot.scope_seq).at(-1);
      if (!bound.has(snapshot.scope_seq) && draft && (draft.result?.payload.status !== "admitted"
        || draft.result.seq + 1 !== row.seq || draft.snapshot.digest !== snapshot.digest)) {
        throw new Error("an initial plan draft requires native admission before binding");
      }
      bound.add(snapshot.scope_seq);
    }
  }
  return drafts;
}

export function validateAuthorityPatch(prior: ObligationSnapshot, next: ObligationSnapshot, patch: AuthorityPatch): void {
  if (patch.schema_version !== 1 || patch.expected_digest !== prior.digest || patch.expected_revision !== prior.revision
    || typeof patch.reason !== "string" || !patch.reason.trim() || canonicalJson(patch.replacement_plan) !== canonicalJson(next.plan)
    || canonicalJson(patch.replacement_runners) !== canonicalJson(next.runners)
    || !Array.isArray(patch.retirements)) throw new Error("operator patch does not name the exact current contract and replacement");
  const missing = missingObligations(prior.obligations, next.obligations);
  if (patch.retirements.length !== missing.length) throw new Error("operator patch needs an exact retirement/replacement mapping");
  const seen = new Set<string>();
  for (const retired of patch.retirements) {
    const key = `${retired.kind}:${retired.alias}`;
    if (seen.has(key) || !missing.some(item => item.kind === retired.kind && item.alias === retired.alias)
      || !Array.isArray(retired.replacement_aliases) || new Set(retired.replacement_aliases).size !== retired.replacement_aliases.length
      || retired.replacement_aliases.some(alias => !next.obligations.some(item => item.kind === retired.kind && item.alias === alias))) throw new Error("operator patch retirement mapping differs");
    seen.add(key);
  }
}

/** Pure projection: a source label or an old bars effect cannot authorize a new
 * contract. The exact patch must precede its snapshot in the protected log. */
export function projectObligations(events: readonly EventRecord[]): { current?: ObligationSnapshot; snapshots: { seq: number; value: ObligationSnapshot }[] } {
  projectPlanDrafts(events);
  const snapshots: { seq: number; value: ObligationSnapshot }[] = [];
  let current: ObligationSnapshot | undefined;
  let binding: EventRecord | undefined;
  let experimentChange: EventRecord | undefined;
  let pending: { patch: AuthorityPatch; seq: number; result: string } | undefined;
  for (const row of events) {
    if (row.name === "work/goal") binding = row;
    if (row.name === "experiment/bar_change") {
      const binding = projectExperimentCondition(events.filter(event => event.seq < row.seq));
      if (experimentChange || pending || row.kind !== "observe" || !binding.binding?.resolved.removed.includes("bar_pinning")
        || row.payload.binding_digest !== binding.bindingDigest || row.payload.previous_digest !== current?.digest) throw new Error("unbound experimental bar change");
      experimentChange = row; continue;
    }
    if (row.name === AUTHORITY_EVENT) {
      if (pending || experimentChange || row.kind !== "effect" || row.payload.source !== "operator" || typeof row.payload.patch_json !== "string"
        || typeof row.payload.result_digest !== "string") throw new Error("invalid operator authority event");
      pending = { patch: JSON.parse(row.payload.patch_json) as AuthorityPatch, seq: row.seq, result: row.payload.result_digest };
      continue;
    }
    if (row.name === "work/goal" && row.payload.authority_digest !== undefined) {
      if (!current || current.digest !== row.payload.authority_digest || current.revision !== row.payload.authority_revision
        || current.scope_seq !== row.payload.scope_seq) throw new Error("work binding lost its obligation snapshot");
    }
    if (current && row.name === "work/goal" && row.payload.authority_digest !== undefined
      && (row.payload.id !== current.plan.goal.id || row.payload.statement !== current.plan.goal.statement)) throw new Error("work goal differs from its obligation snapshot");
    const declaredKind = row.name === "work/todo" ? "todos" : row.name === "work/scenario" ? "scenarios"
      : row.name === "work/case" && row.payload.status === undefined && row.payload.scenario !== undefined ? "cases" : undefined;
    if (current && declaredKind) {
      if (binding?.payload.authority_digest === current.digest) {
        const expected = current.plan[declaredKind].find(item => item.id === row.payload.id);
        const { case_digest: _caseDigest, scope_seq: _scope, ...body } = row.payload;
        if (!expected || canonicalJson(body) !== canonicalJson(expected)) throw new Error("work definition differs from its obligation snapshot");
      }
    }
    if (row.name !== OBLIGATION_EVENT) continue;
    const next = readSnapshot(row);
    if (current?.scope_seq !== next.scope_seq) {
      const scope = binding ? orderScope([binding]) : events[0]?.seq ?? row.seq;
      if (next.scope_seq !== scope) throw new Error("obligation scope is not the current operator order");
      if (pending || experimentChange || next.parent_digest !== null || next.revision !== 1) throw new Error("new obligation scope has invalid authority");
      if (current && !events.some(event => event.seq === next.scope_seq && event.name === "work/goal" && event.payload.digest === "pending")) throw new Error("a replan cannot invent a new operator scope");
    } else {
      if (!current || next.parent_digest !== current.digest || next.revision !== current.revision + 1) throw new Error("obligation revision is stale or discontinuous");
      if (pending) {
        if (pending.seq + 1 !== row.seq || pending.result !== next.digest) throw new Error("operator patch is not coupled to its exact snapshot");
        validateAuthorityPatch(current, next, pending.patch);
      } else if (experimentChange) {
        if (experimentChange.seq + 1 !== row.seq || experimentChange.payload.next_digest !== next.digest
          || !barValuesOnly(current.plan, next.plan) || canonicalJson(current.runners) !== canonicalJson(next.runners)) throw new Error("experimental bar change altered another obligation");
      } else if (missingObligations(requirementObligations(current.plan, current.runners), requirementObligations(next.plan, next.runners)).length) throw new Error("recorded replan dropped an operator obligation");
    }
    const expected = makeSnapshot(next.plan, next.runners, next.scope_seq, current?.scope_seq === next.scope_seq ? current : undefined);
    if (canonicalJson(expected) !== canonicalJson(next)) throw new Error("obligation lineage keys differ");
    pending = undefined; experimentChange = undefined; current = next; snapshots.push({ seq: row.seq, value: next });
  }
  if (pending) throw new Error("operator patch has no durably coupled snapshot");
  if (experimentChange) throw new Error("experimental bar change lacks its snapshot");
  const scope = orderScope(events);
  return { current: current && (scope === undefined || current.scope_seq === scope) ? current : undefined, snapshots };
}

export function obligationErrors(plan: WorkPlan, events: readonly EventRecord[], runners?: Record<string, unknown>): string[] {
  const prior = projectObligations(events).current;
  if (!prior) return [];
  if (conditionRemoves(events, "bar_pinning") && barValuesOnly(prior.plan, plan)
    && canonicalJson(prior.runners) === canonicalJson(runners ?? remapRunners(prior, plan))) return [];
  const proposed = requirementObligations(plan, runners ?? remapRunners(prior, plan));
  return missingObligations(requirementObligations(prior.plan, prior.runners), proposed).map(item => {
    const previous = item.kind === "case" ? prior.plan.cases.find(value => value.id === item.alias) : undefined;
    const next = item.kind === "case" ? plan.cases.find(value => value.id === item.alias) : undefined;
    const bars = previous?.thresholds ? `; accepted bars ${canonicalJson(previous.thresholds)}, proposed ${canonicalJson(next?.thresholds ?? null)}` : "";
    return `obligation ${item.kind}:${item.alias} was removed or changed without an exact operator patch${bars}; only the operator changes a bar or requirement`;
  });
}

/** Pure readers use the recorded runner declaration; dispatch supplies a freshly
 * resolved one so replacing a registry entry cannot reuse the old contract. */
export function remapRunners(prior: ObligationSnapshot, plan: WorkPlan): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const remaining = [...prior.plan.cases];
  for (const item of plan.cases) {
    const index = remaining.findIndex(old => old.id === item.id) >= 0
      ? remaining.findIndex(old => old.id === item.id) : remaining.findIndex(old => old.command === item.command);
    if (index < 0) continue;
    const old = remaining.splice(index, 1)[0]!; result[item.id] = prior.runners[old.id] ?? null;
  }
  return result;
}

/** The host identity for a case at a recorded point in time. */
export function authorityCaseKey(events: readonly EventRecord[], caseId: string): string | undefined {
  return projectObligations(events).current?.obligations.find(item => item.kind === "case" && item.alias === caseId)?.key;
}

/** A numeric bar experiment preserves the executed baseline's case lineage.
 * Other edits and new operator scopes still require their own evidence. */
export function experimentCaseKeys(events: readonly EventRecord[], caseId: string): string[] {
  return acquireObligationCases(events).caseKeys(caseId);
}

/** One synchronous reader acquires its own validated prefix; callers cannot
 * supply a substitute authority projection. Keep it local to that evaluation. */
export function acquireObligationCases(events: readonly EventRecord[]) {
  const authority = projectObligations(events);
  return {
    authority,
    caseKeys: (caseId: string): string[] => experimentCaseKeysFromProjection(events, caseId, authority),
  };
}

function experimentCaseKeysFromProjection(
  events: readonly EventRecord[],
  caseId: string,
  authority: ReturnType<typeof projectObligations>,
): string[] {
  const current = authority.current;
  if (!current) return [];
  const keyOf = (snapshot: ObligationSnapshot) => snapshot.obligations.find(row => row.kind === "case" && row.alias === caseId)?.key;
  const currentKey = keyOf(current);
  if (!currentKey) return [];
  const keys = [currentKey];
  if (!conditionRemoves(events, "bar_pinning")) return keys;
  const snapshots = authority.snapshots.filter(row => row.value.scope_seq === current.scope_seq);
  for (let i = snapshots.length - 1; i > 0; i--) {
    const after = snapshots[i]!, before = snapshots[i - 1]!;
    const oldKey = keyOf(before.value), newKey = keyOf(after.value);
    if (!oldKey || !newKey) break;
    if (oldKey !== newKey && !events.some(row => row.name === "experiment/bar_change" && row.seq + 1 === after.seq
      && row.payload.previous_digest === before.value.digest && row.payload.next_digest === after.value.digest)) break;
    if (!keys.includes(oldKey)) keys.push(oldKey);
  }
  return keys;
}
