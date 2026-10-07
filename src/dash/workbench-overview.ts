/**
 * R3 recorded overview projection — the pure read behind workbench.overview.
 *
 * Everything here folds ONE verified session prefix (the events the read
 * already validated). It is read-only by construction: no model, no bind, no
 * abort, no tool, no context_query, no append. Summary truth comes from the
 * canonical projectors only — `readPlanFromLog` + `viewPlan` for work (never
 * a re-implementation of case verdicts from assistant prose, tool exit codes
 * or green words), `ContextGraphFold` for context delivery, and the recorded
 * `observe.model_usage` rows for usage. Missing source data is an explicit
 * missing/null; data that exists but cannot be interpreted honestly is
 * INVALID with an explanation — never a zero-count success. A session that
 * never recorded a work plan says missing: it must not masquerade as a
 * verified coding project reporting 0/0.
 */

import type { EventRecord } from "../host/schema.ts";
import type { CaseStatus, TodoState, WorkClass } from "../work/schema.ts";
import { readPlanFromLog } from "../work/log.ts";
import { viewPlan } from "../work/view.ts";
import { CONTEXT_GRAPH_ROWS, type EventRef } from "../context-graph/types.ts";
import { ContextGraphFold, projectContextGraph } from "../context-graph/projector.ts";

export interface OverviewSourceRef {
  readonly seq: number;
  readonly hash: string;
}

export type OverviewDataState = "missing" | "available" | "invalid";

export interface OverviewWork {
  readonly state: OverviewDataState;
  readonly goal: { readonly id: string; readonly statement: string; readonly source: OverviewSourceRef } | null;
  readonly planDigest: string | null;
  readonly todos: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly class: WorkClass;
    readonly state: TodoState;
    readonly priority: number;
  }>;
  readonly cases: { readonly total: number; readonly green: number; readonly red: number; readonly pending: number } | null;
  readonly errors: ReadonlyArray<string>;
}

export type OverviewFrameStage = "prepared" | "appended" | "dispatched" | "responded";

export interface OverviewContext {
  readonly state: OverviewDataState;
  readonly mode: "shadow" | "on" | "unknown" | null;
  readonly revision: number | null;
  readonly digest: string | null;
  readonly frame: {
    readonly id: string;
    readonly stage: OverviewFrameStage;
    readonly source: OverviewSourceRef;
  } | null;
  readonly lessonCount: number | null;
  readonly errors: ReadonlyArray<string>;
}

export interface OverviewUsageMetric {
  /** Sum of measured values, or null when nothing was measured. */
  readonly total: number | null;
  /** Records that exist but do not report this field. */
  readonly missing: number;
  /** Newest record that measured this field, or null. */
  readonly latestSource: OverviewSourceRef | null;
}

export interface OverviewUsage {
  readonly records: number;
  readonly input: OverviewUsageMetric;
  readonly output: OverviewUsageMetric;
  readonly reasoning: OverviewUsageMetric;
  readonly cacheRead: OverviewUsageMetric;
  readonly cacheWrite: OverviewUsageMetric;
}

function sourceRef(event: EventRecord): OverviewSourceRef {
  return { seq: event.seq, hash: event.hash };
}

function refOf(ref: EventRef): OverviewSourceRef {
  return { seq: ref.seq, hash: ref.hash };
}

function lastEventNamed(events: readonly EventRecord[], name: string): EventRecord | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === name) return events[i];
  }
  return undefined;
}

/**
 * Work summary. The goal source is the LAST recorded work/goal row. When that
 * row exists but the canonical reader refuses the plan (malformed or
 * unsupported records — `readPlanFromLog` swallows the reason), the state is
 * invalid with the refusal surfaced: such work is NOT absent, and a projection
 * error inside viewPlan blocks the summary the same way. Availability is
 * declared ONLY when the reconstructed plan belongs to the latest recorded
 * goal AND the canonical projector returned no errors — an unsealed ask
 * awaiting its plan, an older plan left under a newer goal, or a refused
 * projection never becomes a zero-count success.
 */
export function projectWorkOverview(events: readonly EventRecord[]): OverviewWork {
  const goalEvent = lastEventNamed(events, "work/goal");
  if (goalEvent === undefined) {
    return { state: "missing", goal: null, planDigest: null, todos: [], cases: null, errors: [] };
  }
  const goal =
    typeof goalEvent.payload.id === "string" && typeof goalEvent.payload.statement === "string"
      ? {
        id: goalEvent.payload.id,
        statement: goalEvent.payload.statement,
        source: sourceRef(goalEvent),
      }
      : null;
  const planDigest =
    typeof goalEvent.payload.digest === "string" ? goalEvent.payload.digest : null;
  const refuse = (errors: ReadonlyArray<string>): OverviewWork => ({
    state: "invalid",
    goal,
    planDigest,
    todos: [],
    cases: null,
    errors,
  });
  // A pending digest is an operator ask still awaiting its sealed plan: no
  // verified plan exists for THIS goal yet, and an earlier scope's plan must
  // never surface its counts under the new goal's title.
  if (goalEvent.payload.digest === "pending") {
    return refuse([
      "the recorded goal is awaiting its sealed plan (digest is pending) — no plan has been sealed for this goal",
    ]);
  }
  const plan = readPlanFromLog(events);
  if (plan === undefined) {
    return refuse([
      "the recorded work/goal cannot be reconstructed into a plan: malformed or unsupported work records (readPlanFromLog refused)",
    ]);
  }
  // Correspondence: the plan the canonical reader selected must BE the latest
  // goal's plan, not a stale earlier scope the reader still holds.
  if (
    typeof goalEvent.payload.id !== "string" ||
    typeof goalEvent.payload.statement !== "string" ||
    plan.goal.id !== goalEvent.payload.id ||
    plan.goal.statement !== goalEvent.payload.statement
  ) {
    return refuse([
      "the reconstructed plan does not belong to the latest recorded work/goal — an older plan cannot summarize the current goal",
    ]);
  }
  try {
    const view = viewPlan(plan, events);
    if (view.errors.length > 0) {
      // The canonical projector refused this plan (obligation errors, cycles,
      // invalid definitions): the recorded work cannot be interpreted, which
      // is invalid — never a clean 0/0.
      return refuse([...view.errors]);
    }
    const statuses = plan.cases.map((item) => view.caseStatus[item.id]);
    const counted = statuses.filter((status): status is CaseStatus => status !== undefined);
    return {
      state: "available",
      goal,
      planDigest,
      todos: plan.todos.map((todo) => ({
        id: todo.id,
        title: todo.title,
        class: todo.class,
        state: view.todoState[todo.id] ?? "blocked",
        priority: todo.priority,
      })),
      cases: {
        total: plan.cases.length,
        green: counted.filter((status) => status === "green").length,
        red: counted.filter((status) => status === "red").length,
        pending: statuses.length - counted.length,
      },
      errors: [],
    };
  } catch (error) {
    return refuse([
      `the recorded plan could not be projected: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

/**
 * Context delivery summary from the pure fold at this prefix. The recorded
 * scope mode is shadow/on, or unknown when no scope row exists — absence can
 * never prove "off". Frame stages collapse to the presentation pipeline
 * (prepared/appended/dispatched/responded): a shadow or surfaced frame has
 * NOT reached the transcript, so it stays "prepared" — prepared is never
 * model delivery. The stage's source is the recorded row that proves it.
 */
export function projectContextOverview(events: readonly EventRecord[], retained?: (digest: string) => string | undefined): OverviewContext {
  const hasGraphRows = events.some((event) => CONTEXT_GRAPH_ROWS.has(event.name));
  if (!hasGraphRows) {
    return { state: "missing", mode: null, revision: null, digest: null, frame: null, lessonCount: null, errors: [] };
  }
  let fold: ContextGraphFold;
  try {
    fold = projectContextGraph(events, retained);
  } catch (error) {
    return {
      state: "invalid",
      mode: null,
      revision: null,
      digest: null,
      frame: null,
      lessonCount: null,
      errors: [
        `the recorded context-graph rows cannot be folded: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const latestId = fold.frameOrder.at(-1);
  let frame: OverviewContext["frame"] = null;
  if (latestId !== undefined) {
    const state = fold.frames.get(latestId);
    const stage = state === undefined ? undefined : fold.frameStage(latestId);
    if (state !== undefined && stage !== undefined) {
      // Ground the stage in the recorded row that proves it: the answered or
      // dispatched request, the appended provider/state row, else the frame's
      // own row (prepared/shadow/surfaced all mean not yet delivered).
      const proof =
        stage === "responded"
          ? state.responded.at(-1)
          : stage === "dispatched"
            ? state.dispatched.at(-1)
            : stage === "appended"
              ? state.appended
              : undefined;
      frame = {
        id: latestId,
        stage: stage === "responded" || stage === "dispatched" || stage === "appended" ? stage : "prepared",
        source: refOf(proof ?? state.ref),
      };
    }
  }
  return {
    state: "available",
    mode: fold.scopeMode ?? "unknown",
    revision: fold.revision,
    digest: fold.digest,
    frame,
    lessonCount: fold.lessons.size + fold.importedLessons.size,
    errors: [],
  };
}

function metricOf(
  records: ReadonlyArray<{ readonly event: EventRecord; readonly value: unknown }>,
): OverviewUsageMetric {
  let total = 0;
  let measured = 0;
  let missing = 0;
  let latestSource: OverviewSourceRef | null = null;
  for (const { event, value } of records) {
    if (typeof value === "number" && Number.isFinite(value)) {
      measured += 1;
      total += value;
      latestSource = sourceRef(event);
    } else {
      missing += 1;
    }
  }
  return {
    total: measured > 0 ? total : null,
    missing,
    latestSource,
  };
}

/**
 * Usage from recorded observe.model_usage rows only. Each provider field is
 * reported separately with its measured total, its missing-record count and
 * the newest record that measured it — preserving missing values (an aborted
 * request's usage is missing, never zero), never estimating billing, and
 * never folding reasoning into another field's total.
 */
export function projectUsageOverview(events: readonly EventRecord[]): OverviewUsage {
  const input: Array<{ event: EventRecord; value: unknown }> = [];
  const output: Array<{ event: EventRecord; value: unknown }> = [];
  const reasoning: Array<{ event: EventRecord; value: unknown }> = [];
  const cacheRead: Array<{ event: EventRecord; value: unknown }> = [];
  const cacheWrite: Array<{ event: EventRecord; value: unknown }> = [];
  let records = 0;
  for (const event of events) {
    const usage = event.observe?.model_usage;
    if (usage === undefined) continue;
    records += 1;
    input.push({ event, value: usage.input_tokens });
    output.push({ event, value: usage.output_tokens });
    reasoning.push({ event, value: usage.reasoning_tokens });
    cacheRead.push({ event, value: usage.cache_read_tokens });
    cacheWrite.push({ event, value: usage.cache_write_tokens });
  }
  return {
    records,
    input: metricOf(input),
    output: metricOf(output),
    reasoning: metricOf(reasoning),
    cacheRead: metricOf(cacheRead),
    cacheWrite: metricOf(cacheWrite),
  };
}
