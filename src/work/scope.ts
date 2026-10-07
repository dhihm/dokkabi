import { projectObligations, projectPlanDrafts, acquireObligationCases, orderScope } from "./evidence/obligations.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { EventRecord } from "../host/schema.ts";
import { planDigest } from "./digest.ts";
import type { Case, Scenario, WorkPlan } from "./schema.ts";

function numericScope(event: EventRecord): number {
  const value = event.payload.scope_seq;
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= event.seq
  ) {
    return value;
  }
  return event.seq;
}

function isGoalBinding(event: EventRecord): boolean {
  return event.name === "work/goal"
    && typeof event.payload.digest === "string"
    && event.payload.digest !== "pending";
}

/**
 * Return only events owned by the active sealed operator goal and plan.
 *
 * Historical logs without goal bindings retain their legacy all-events view.
 * Once bindings exist, absence of a binding for this plan is fail-closed: old
 * case ids and clears cannot leak into an unbound replacement plan.
 */
/**
 * The first index whose seq reaches `seq`.
 *
 * A log only ever appends, so its seq climbs: the scope slice is a binary
 * search, not a filter that builds a fresh 115,000-entry array every time the
 * board paints.
 */
function firstAtSeq(events: readonly EventRecord[], seq: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.seq >= seq) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function withSessionCondition(events: readonly EventRecord[], scope: number): readonly EventRecord[] {
  const index = firstAtSeq(events, scope);
  const condition = events.slice(0, index).filter(event => event.name === "experiment/bind" || event.name === "eval/ablation");
  return condition.length ? [...condition, ...events.slice(index)] : events.slice(index);
}

export function scopeWorkEvents(
  plan: WorkPlan,
  events: readonly EventRecord[],
): readonly EventRecord[] {
  const authority = projectObligations(events).current;
  if (authority) {
    if (canonicalJson(authority.plan) !== canonicalJson(plan)) return [];
    return withSessionCondition(events, authority.scope_seq);
  }
  const scope = orderScope(events) ?? events[0]?.seq;
  if (projectPlanDrafts(events).some(draft => draft.snapshot.scope_seq === scope)) return [];
  // Only the LAST binding matters, so this stops at the first one it finds
  // from the end rather than collecting every goal the session ever bound.
  let latest: EventRecord | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.name === "work/goal") {
      latest = events[i];
      break;
    }
  }
  if (latest === undefined) return events;

  if (!isGoalBinding(latest)) return [];
  const activeScope = numericScope(latest);
  const digest = planDigest(plan);
  const exactGoal = latest.payload.digest === digest
    && latest.payload.id === plan.goal.id
    && latest.payload.statement === plan.goal.statement;
  if (!exactGoal && !latestBindingMatchesPlan(plan, events, latest)) return [];
  return withSessionCondition(events, activeScope);
}

function latestBindingMatchesPlan(
  plan: WorkPlan,
  events: readonly EventRecord[],
  binding: EventRecord,
): boolean {
  if (binding.payload.id !== plan.goal.id || binding.payload.statement !== plan.goal.statement) return false;
  const slice = events.filter((event) => event.seq > binding.seq);
  const definitions = <T extends Record<string, unknown>>(name: string): T[] => {
    const rows = new Map<string, T>();
    for (const event of slice) {
      if (event.name !== name || typeof event.payload.id !== "string") continue;
      if (
        name === "work/case"
        && (event.payload.status === "red" || event.payload.status === "green")
      ) continue;
      rows.set(event.payload.id, event.payload as T);
    }
    return [...rows.values()];
  };
  const boundShape = {
    goal: {
      id: String(binding.payload.id),
      statement: String(binding.payload.statement),
      require_red_first: typeof binding.payload.require_red_first === "boolean"
        ? binding.payload.require_red_first
        : undefined,
    },
    todos: definitions("work/todo").map((todo) => ({
      id: String(todo.id ?? ""),
      title: String(todo.title ?? ""),
      class: String(todo.class ?? ""),
      priority: Number(todo.priority),
      blocked_by: Array.isArray(todo.blocked_by) ? todo.blocked_by.map(String) : [],
      statement: String(todo.statement ?? ""),
      judgment: typeof todo.judgment === "string" ? todo.judgment : undefined,
      plan: typeof todo.plan === "string" ? todo.plan : undefined,
      profile: typeof todo.profile === "string" ? todo.profile : undefined,
    })),
    scenarios: definitions("work/scenario").map((scenario) => ({
      id: String(scenario.id ?? ""),
      todo: String(scenario.todo ?? ""),
      given: String(scenario.given ?? ""),
      when: String(scenario.when ?? ""),
      then: String(scenario.then ?? ""),
    })),
    cases: definitions("work/case").map((item) => ({
      id: String(item.id ?? ""),
      scenario: String(item.scenario ?? ""),
      layer: String(item.layer ?? ""),
      command: String(item.command ?? ""),
      red_means: String(item.red_means ?? ""),
      green_means: String(item.green_means ?? ""),
      ...(item.guard === true ? { guard: true } : {}),
      ...caseEvidenceTerms(item as unknown as Case),
    })),
  };
  const planShape = {
    goal: {
      id: plan.goal.id,
      statement: plan.goal.statement,
      require_red_first: plan.require_red_first,
    },
    todos: plan.todos.map((todo) => ({
      id: todo.id,
      title: todo.title,
      class: todo.class,
      priority: todo.priority,
      blocked_by: todo.blocked_by ?? [],
      statement: todo.statement,
      judgment: todo.judgment,
      plan: todo.plan,
      profile: todo.profile,
    })),
    scenarios: plan.scenarios.map((scenario) => ({
      id: scenario.id,
      todo: scenario.todo,
      given: scenario.given,
      when: scenario.when,
      then: scenario.then,
    })),
    cases: plan.cases.map((item) => ({
      id: item.id,
      scenario: item.scenario,
      layer: item.layer,
      command: item.command,
      red_means: item.red_means,
      green_means: item.green_means,
      ...(item.guard ? { guard: true } : {}),
      ...caseEvidenceTerms(item),
    })),
  };
  return canonicalJson(boundShape) === canonicalJson(planShape);
}

/** New evidence modes retain all terms while preserving older case identities. */
export function caseEvidenceTerms(item: Case | Record<string, unknown>): Record<string, unknown> {
  return {
    ...(item.measurement !== undefined || item.evidence_level !== undefined ? {
      evidence_terms: {
        evidence_level: item.evidence_level,
        measurement: item.measurement,
        substrate: item.substrate,
        witness_for: item.witness_for,
        thresholds: item.thresholds,
        min_duration_ms: item.min_duration_ms,
        host: item.host,
        dir: item.dir,
        depends_on: item.depends_on,
        needs_memory_gb: item.needs_memory_gb,
        local_accelerator: item.local_accelerator,
        timeout_ms: item.timeout_ms,
        done_when: item.done_when,
        failed_when: item.failed_when,
        stall_after_ms: item.stall_after_ms,
        telemetry_pattern: item.telemetry_pattern,
      },
    } : {}),
  };
}

export function workCaseDigest(
  item: Case | Record<string, unknown>,
  scenario?: Scenario,
): string {
  const canonical = canonicalJson({
    id: String(item.id ?? ""),
    scenario: String(item.scenario ?? ""),
    layer: String(item.layer ?? ""),
    command: String(item.command ?? ""),
    red_means: String(item.red_means ?? ""),
    green_means: String(item.green_means ?? ""),
    ...(item.guard === true ? { guard: true } : {}),
    ...caseEvidenceTerms(item),
    scenario_contract: scenario
      ? {
          id: scenario.id,
          todo: scenario.todo,
          given: scenario.given,
          when: scenario.when,
          then: scenario.then,
        }
      : undefined,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The two event names case evidence is made of, filtered once per log.
 *
 * Both functions below scan the whole log, and both are called once per CASE.
 * A graph with eight cases therefore walked the session's entire history
 * sixteen times to answer questions about two event names -- measured at a
 * tenth of the board's projection cost on a 115,000-event log.
 *
 * Keyed on the array itself, and on how long it was. `EventLog.events` hands
 * back the live array, which GROWS IN PLACE on every append -- so identity
 * alone would have served a cached filter that predated the caller's own new
 * events, which is a wrong answer rather than a slow one. The length is what
 * makes the entry valid, and a log only appends, so a longer array with the
 * same identity is the same prefix plus a tail: filter the tail and keep the
 * rest. Equivalent by construction -- everything below already ignores every
 * other name.
 */
const CASE_ROWS = new WeakMap<object, { length: number; rows: EventRecord[] }>();
const isCaseRow = (event: EventRecord): boolean =>
  event.name === "work/case" || event.name === "work/scenario";

function caseRows(events: readonly EventRecord[]): readonly EventRecord[] {
  const hit = CASE_ROWS.get(events as object);
  if (hit && hit.length === events.length) return hit.rows;
  if (hit && hit.length < events.length) {
    for (let i = hit.length; i < events.length; i += 1) {
      const event = events[i]!;
      if (isCaseRow(event)) hit.rows.push(event);
    }
    hit.length = events.length;
    return hit.rows;
  }
  const rows = events.filter(isCaseRow);
  CASE_ROWS.set(events as object, { length: events.length, rows });
  return rows;
}

/** Sequence after which evidence belongs to the current case definition. */
export function caseEvidenceBoundary(
  item: Case,
  scenario: Scenario | undefined,
  events: readonly EventRecord[],
): number | undefined {
  const rows = caseRows(events);
  const definitions = rows.filter(
    (event) => event.name === "work/case"
      && event.payload.id === item.id
      && typeof event.payload.scenario === "string"
      && event.payload.status !== "red"
      && event.payload.status !== "green",
  );
  if (definitions.length === 0) return undefined;

  const expected = workCaseDigest(item, scenario);
  const definitionDigest = (event: EventRecord): string => {
    if (typeof event.payload.case_digest === "string") return event.payload.case_digest;
    const scenarioId = typeof event.payload.scenario === "string" ? event.payload.scenario : "";
    const scenarioEvent = [...rows].reverse().find(
      (candidate) => candidate.seq <= event.seq
        && candidate.name === "work/scenario"
        && candidate.payload.id === scenarioId,
    );
    const historicalScenario = scenarioEvent
      ? {
          id: String(scenarioEvent.payload.id ?? ""),
          todo: String(scenarioEvent.payload.todo ?? ""),
          given: String(scenarioEvent.payload.given ?? ""),
          when: String(scenarioEvent.payload.when ?? ""),
          then: String(scenarioEvent.payload.then ?? ""),
        }
      : undefined;
    return workCaseDigest(event.payload, historicalScenario);
  };
  let lastMismatch = -1;
  for (let index = 0; index < definitions.length; index += 1) {
    const event = definitions[index]!;
    const actual = definitionDigest(event);
    if (actual !== expected) lastMismatch = index;
  }
  const current = definitions.slice(lastMismatch + 1).find((event) => {
    return definitionDigest(event) === expected;
  });
  return current?.seq ?? Number.POSITIVE_INFINITY;
}

/** Recorded RED/GREEN rows that belong to the current case revision. */
export function currentCaseEvidence(
  item: Case,
  scenario: Scenario | undefined,
  events: readonly EventRecord[],
): EventRecord[] {
  return createCaseEvidenceReader(events)(item, scenario);
}

export type CaseEvidenceReader = (item: Case, scenario: Scenario | undefined) => EventRecord[];

/** Acquire canonical state once for one synchronous evaluation of this prefix.
 * Direct public lookups above always acquire fresh state. */
export function createCaseEvidenceReader(events: readonly EventRecord[]): CaseEvidenceReader {
  const { authority, caseKeys } = acquireObligationCases(events);
  let admittedDrafts: ReturnType<typeof projectPlanDrafts> | undefined;
  const drafts = () => admittedDrafts ??= projectPlanDrafts(events).filter(draft =>
    draft.result?.payload.status === "admitted" && draft.snapshot.scope_seq === authority.current!.scope_seq);
  return (item, scenario) => readCaseEvidence(item, scenario, events, authority, caseKeys, drafts);
}

function readCaseEvidence(
  item: Case,
  scenario: Scenario | undefined,
  events: readonly EventRecord[],
  authority: ReturnType<typeof projectObligations>,
  caseKeys: (caseId: string) => string[],
  drafts: () => ReturnType<typeof projectPlanDrafts>,
): EventRecord[] {
  if (authority.current) {
    const bound = authority.current.plan.cases.find(candidate => candidate.id === item.id);
    const boundScenario = authority.current.plan.scenarios.find(candidate => candidate.id === bound?.scenario);
    if (!bound || workCaseDigest(bound, boundScenario) !== workCaseDigest(item, scenario)) return [];
    const key = authority.current.obligations.find(value => value.kind === "case" && value.alias === item.id)?.key;
    const keys = caseKeys(item.id);
    const origin = authority.snapshots.find(snapshot => snapshot.value.scope_seq === authority.current!.scope_seq);
    const legacyCase = origin?.value.obligations.find(value => value.kind === "case" && value.key === key);
    const legacyDefinition = legacyCase && origin!.value.plan.cases.find(value => value.id === legacyCase.alias);
    const legacyCovered = legacyDefinition && Object.keys(legacyDefinition).every(field =>
      ["id", "scenario", "layer", "command", "red_means", "green_means", "guard"].includes(field));
    const admittedDrafts = drafts();
    return caseRows(events).filter(row => {
      if (origin && legacyCovered && row.seq < origin.seq && row.name === "work/case" && row.payload.id === legacyCase!.alias
        && (row.payload.status === "red" || row.payload.status === "green") && row.payload.obligation_key === undefined) {
        return row.payload.case_digest === workCaseDigest(legacyDefinition!, origin.value.plan.scenarios.find(value => value.id === legacyDefinition!.scenario));
      }
      if (row.name !== "work/case" || (row.payload.status !== "red" && row.payload.status !== "green")
        || !key || !keys.includes(String(row.payload.obligation_key)) || typeof row.payload.case_digest !== "string") return false;
      if (row.payload.draft_ref) return admittedDrafts.some(draft => {
        const refs = draft.result!.payload.case_refs as { seq: number; hash: string }[];
        const historical = draft.snapshot.plan.cases.find(value => value.id === row.payload.id);
        return historical !== undefined && refs.some(ref => ref.seq === row.seq && ref.hash === row.hash)
          && row.payload.case_digest === workCaseDigest(historical, draft.snapshot.plan.scenarios.find(value => value.id === historical.scenario));
      });
      return authority.snapshots.some(snapshot => {
        if (snapshot.seq >= row.seq || snapshot.value.scope_seq !== authority.current!.scope_seq) return false;
        const obligation = snapshot.value.obligations.find(value => value.kind === "case" && value.key === row.payload.obligation_key && value.alias === row.payload.id);
        const historical = obligation && snapshot.value.plan.cases.find(value => value.id === obligation.alias);
        return historical !== undefined && row.payload.case_digest === workCaseDigest(historical,
          snapshot.value.plan.scenarios.find(value => value.id === historical.scenario));
      });
    });
  }
  const boundary = caseEvidenceBoundary(item, scenario, events);
  const expectedDigest = workCaseDigest(item, scenario);
  return caseRows(events).filter((event) =>
    event.name === "work/case"
      && event.payload.id === item.id
      && (event.payload.status === "red" || event.payload.status === "green")
      && (boundary === undefined || event.seq > boundary)
      && (typeof event.payload.case_digest !== "string" || event.payload.case_digest === expectedDigest)
  );
}

/**
 * Cases in this todo whose most recent run could not execute at all — the path
 * they name is gone. Reported to the model each turn, because a red it reads as
 * "already handled" is what sent one live run round the same todo eight times.
 */
export function unrunnableCases(
  events: readonly EventRecord[],
  plan: WorkPlan,
  todoId: string,
): { id: string; reason: string }[] {
  const scenarios = new Set(
    plan.scenarios.filter((item) => item.todo === todoId).map((item) => item.id),
  );
  const owned = new Set(
    plan.cases.filter((item) => scenarios.has(item.scenario)).map((item) => item.id),
  );
  const latest = new Map<string, string | undefined>();
  for (const event of scopeWorkEvents(plan, events)) {
    if (event.name !== "work/case") continue;
    const payload = event.payload as { id?: unknown; status?: unknown; unrunnable?: unknown };
    if (typeof payload.id !== "string" || !owned.has(payload.id)) continue;
    if (typeof payload.status !== "string") continue;
    latest.set(payload.id, typeof payload.unrunnable === "string" ? payload.unrunnable : undefined);
  }
  return [...latest]
    .filter(([, reason]) => reason !== undefined)
    .map(([id, reason]) => ({ id, reason: reason as string }));
}

/**
 * The latest failing output of this todo's red cases.
 *
 * A red verdict without its output is a rumor. Live, a gate crashed on a
 * missing import — a one-line fix — but the implement turn was only told "the
 * case is red"; the model had rewritten that file in an earlier turn, so it
 * concluded the work was already done and ended, and the loop re-ran a
 * seven-minute checkpoint load into the same NameError, three rounds in a
 * row. The verifier held those failing lines the whole time. Now they travel
 * to the turn that has to act on them.
 */
export function redCaseOutputs(
  events: readonly EventRecord[],
  plan: WorkPlan,
  todoId: string,
): { id: string; tail: string; durationMs?: number; reconfirmed?: number; refusal?: string }[] {
  const scenarios = new Set(
    plan.scenarios.filter((item) => item.todo === todoId).map((item) => item.id),
  );
  const owned = new Set(
    plan.cases.filter((item) => scenarios.has(item.scenario)).map((item) => item.id),
  );
  const latest = new Map<string, { tail: string; durationMs?: number; reconfirmed: number; refusal?: string } | undefined>();
  for (const event of scopeWorkEvents(plan, events)) {
    if (event.name !== "work/case") continue;
    const payload = event.payload as {
      id?: unknown;
      status?: unknown;
      failure_tail?: unknown;
      duration_ms?: unknown;
      settled_by?: unknown;
      substrate_reason?: unknown;
    };
    if (typeof payload.id !== "string" || !owned.has(payload.id)) continue;
    if (payload.status !== "red" && payload.status !== "green") continue;
    // A settled re-record confirms the standing verdict against unchanged
    // dependencies. Counting them tells the implement turn that this red
    // reflects the code AS IT STANDS — a model that believed its fix was
    // "awaiting verification" idled through fourteen such confirmations.
    if (payload.status === "red" && payload.settled_by === "depends_unchanged") {
      const standing = latest.get(payload.id);
      if (standing) {
        latest.set(payload.id, { ...standing, reconfirmed: standing.reconfirmed + 1 });
        continue;
      }
    }
    latest.set(
      payload.id,
      payload.status === "red" && typeof payload.failure_tail === "string"
        ? {
            tail: payload.failure_tail,
            reconfirmed: 0,
            ...(typeof payload.duration_ms === "number" ? { durationMs: payload.duration_ms } : {}),
            // The harness's own half of the verdict. A gate can print
            // "1 passed" and still be refused — for an unechoed bar, an
            // unwitnessed substrate, a run too fast to be real. Without
            // this the model reads only the run's output, concludes the
            // recorder is broken, and mints successor case ids forever.
            ...(typeof payload.substrate_reason === "string"
              ? { refusal: payload.substrate_reason }
              : {
                // A run can print the word PASSED — in a summary, in a
                // traceback's source excerpt, in its own verdict-assembly
                // code — and still have failed. One model read such an
                // excerpt honestly and argued for six turns that a red case
                // had passed. The verdict itself is the fact.
                refusal: "the run exited non-zero or matched its failed_when signal, so the runner judged it FAILED"
                  + " — a PASSED string inside the output (a summary line, a traceback excerpt, the gate's own"
                  + " verdict text) is not the verdict",
              }),
          }
        : undefined,
    );
  }
  return [...latest]
    .filter((entry): entry is [string, { tail: string; durationMs?: number; reconfirmed: number; refusal?: string }] => entry[1] !== undefined)
    .map(([id, found]) => ({ id, ...found }));
}

/**
 * What each of this todo's cases has been measuring, run over run.
 *
 * An optimization campaign moved a ratio 0.011 → 0.221 on real engine work,
 * then spent hours landing kernel gates that moved it 0.221 → 0.224. Every
 * turn showed the same fact — "0.224, bar 0.85, red" — and every turn that
 * fact justified another kernel. The trajectory was the missing one: five
 * changes had bought three thousandths, so the bottleneck had moved
 * somewhere the work was not. The harness recorded every measurement and
 * played none of them back.
 *
 * Only executed runs contribute; a settled re-record repeats a verdict
 * without producing a new number.
 */
export function measurementTrajectories(
  events: readonly EventRecord[],
  plan: WorkPlan,
  todoId: string,
): Record<string, Record<string, number[]>> {
  const scenarios = new Set(
    plan.scenarios.filter((item) => item.todo === todoId).map((item) => item.id),
  );
  const owned = new Set(
    plan.cases.filter((item) => scenarios.has(item.scenario)).map((item) => item.id),
  );
  const RECENT = 8;
  const out: Record<string, Record<string, number[]>> = {};
  for (const event of scopeWorkEvents(plan, events)) {
    if (event.name !== "work/case") continue;
    const payload = event.payload as {
      id?: unknown; duration_ms?: unknown; settled_by?: unknown; measured?: unknown;
    };
    if (typeof payload.id !== "string" || !owned.has(payload.id)) continue;
    if (payload.duration_ms === undefined || payload.duration_ms === null) continue;
    if (payload.settled_by !== undefined) continue;
    const measured = payload.measured;
    if (typeof measured !== "object" || measured === null) continue;
    for (const [name, value] of Object.entries(measured as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const perCase = out[payload.id] ?? (out[payload.id] = {});
      const series = perCase[name] ?? (perCase[name] = []);
      series.push(value);
      if (series.length > RECENT) series.shift();
    }
  }
  return out;
}

/**
 * Why the last ledger edit was thrown away, when it was.
 *
 * A reload that fails validation is refused, the previous plan is kept, and
 * the next persist writes it back over the model's file — so a re-plan the
 * model had just reasoned its way to simply vanished. It noticed the
 * erasure twice, guessed at a cause, and re-registered blindly, because
 * nothing in its turn said "your edit was refused, and here is the line
 * that refused it". Only a refusal newer than the last completed turn is
 * reported: an older one has already been answered.
 */
export function latestPlanRefusal(events: readonly EventRecord[]): string[] | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.name === "agent/step" && event.payload.phase === "end") return undefined;
    if (event.name !== "work/step") continue;
    const action = event.payload.action;
    if (typeof action !== "string" || !action.endsWith("_refused")) continue;
    const errors = event.payload.errors;
    if (!Array.isArray(errors) || errors.length === 0) return undefined;
    return errors.filter((error): error is string => typeof error === "string");
  }
  return undefined;
}

/**
 * Whether the last completed model turn produced nothing at all.
 *
 * A provider that caps completions can let reasoning consume the entire
 * budget: eighteen consecutive turns ended with no tool call, no text and
 * no edit, each truncated mid-thought and each re-deriving the diagnosis
 * the last had reached. Thinking is not output, and a loop that cannot see
 * the difference will wait forever.
 */
export function lastTurnProducedNothing(events: readonly EventRecord[]): boolean {
  let end = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "agent/step" && events[i]?.payload.phase === "end") { end = i; break; }
  }
  if (end < 0) return false;
  let start = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "agent/step" && events[i]?.payload.phase === "start") { start = i; break; }
  }
  if (start < 0) return false;
  for (let i = start + 1; i < end; i += 1) {
    const event = events[i];
    if (!event) continue;
    if (event.name === "tool/call") return false;
    if (event.name === "assistant/message" && String(event.payload.text ?? "").trim().length > 0) return false;
  }
  return true;
}

/**
 * How many turns in a row changed nothing the cases can see.
 *
 * Two live campaigns spent 19 and 34 minutes in turns that read, reasoned,
 * replanned and rewrote the plan while nothing on the host moved and no case
 * ran. Every turn looked productive on its own; only the sequence gave it
 * away, and the sequence was visible to nobody but an operator reading the
 * event log by hand. A loop that cannot see its own idling waits forever.
 *
 * Only two things reset the count: a verdict from an EXECUTED run (a settled
 * re-record is the harness repeating itself, not work), and a change in the
 * host revision the verdicts carry (the workspace the cases judge actually
 * moved). Planning turns count as idle — a plan that never reaches a run has
 * not been tested by anything.
 */
export function idleTurnStreak(events: readonly EventRecord[]): number {
  let streak = 0;
  let revision: unknown;
  for (const event of events) {
    if (event.name === "work/case") {
      const payload = event.payload as {
        duration_ms?: unknown; settled_by?: unknown; host_revision?: unknown;
      };
      const executed = payload.duration_ms !== undefined
        && payload.duration_ms !== null
        && payload.settled_by === undefined;
      const moved = payload.host_revision !== undefined
        && revision !== undefined
        && payload.host_revision !== revision;
      if (payload.host_revision !== undefined) revision = payload.host_revision;
      if (executed || moved) streak = 0;
      continue;
    }
    if (event.name !== "work/step") continue;
    const action = (event.payload as { action?: unknown }).action;
    if (action === "implement" || action === "replan") streak += 1;
  }
  return streak;
}
