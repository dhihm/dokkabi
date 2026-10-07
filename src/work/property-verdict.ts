import { recheckInputsRecordOf, type RecheckInputsRecord } from "./recheck-inputs.ts";
import type { LedgerProperty } from "./plan-ledger.ts";

/**
 * PROPERTY VERDICT (D58, D58b; design memo §112, §114): the part of a
 * property observation every reader shares — the bounds a recorded property
 * must be within, the row's `property` field written and read back, and the
 * verdict, a PURE function of that field. The label (ledger-label.ts), the
 * recheck fold (recheck.ts), the verifier's findings (verified-work.ts) and
 * the evaluator itself (ledger-property.ts) all read a property row through
 * this file, so a row's status is always the verdict of its own fields
 * (V2), whoever wrote it and whatever it claims. No other import than the
 * row codecs, so the label can read it without a cycle.
 *
 * V1 — GREEN ONLY WHEN EVERYTHING IT SET OUT TO RUN COMPLETED AND HELD: no
 * counterexample; every recorded counterexample it set out to replay ran to
 * completion (`replayed` is all of `replay_planned`) and none was left out
 * past the replay cap (`replay_overflow` 0); every planned sample case ran
 * (`stopped: "cases"`) and no execution was cut or failed to start
 * (`unfinished` absent). A time-budget stop, the outer wall, a replay cap
 * overflow or a case cut mid-run is `not_runnable` — unknown — never green.
 * A completed counterexample is red whatever else happened: a case that
 * violated the invariant is evidence however the run ended.
 *
 * RP (D58d, design memo §116) — a recorded counterexample counts as held
 * only when its replay ran on exactly the recorded input: the evaluator
 * restores the input its snapshot recorded (E1) into the case's directory
 * before the replay, and after it every entry the snapshot recorded must
 * stand at its path as recorded (a file byte for byte). A replay that did
 * not — or whose recorded input cannot be restored — is `input_differs`:
 * not held (it is not in `replayed`, so it stays in the replay set, L1), not
 * a counterexample (its input is not the one its seed names), and the
 * observation is never green while any is.
 *
 * V2 — a case that started and ended by ANY exit status or signal is judged:
 * exit 0 holds, every other status — 126 and 127 included — and a signal
 * death violate it (a crash is a violation, not "not run"), on every sandbox
 * backend. Only an execution that did not start, or that the host itself cut
 * (its time bound, its output bound), is not judged (ledger-property.ts,
 * propertyEnding).
 */

/** The bounds of one property's run (T7), the property tool's and every
 * evaluator's (V5). */
export const PROPERTY_CASES_DEFAULT = 100;
export const PROPERTY_CASES_MAX = 1_000;
export const PROPERTY_TIME_BUDGET_DEFAULT_MS = 60_000;
export const PROPERTY_TIME_BUDGET_MAX_MS = 600_000;
export const PROPERTY_MAX_COUNTEREXAMPLES_DEFAULT = 5;
export const PROPERTY_MAX_COUNTEREXAMPLES_MAX = 20;
/** The largest seed: every language's generator can take a 32-bit seed. */
export const PROPERTY_SEED_MAX = 0xffff_ffff;
/** The principle rides on every revision of the case: a paragraph, as a
 * defect statement is bounded. */
export const PROPERTY_PRINCIPLE_MAX = 2_000;
/** At most this many recorded counterexamples are replayed first; the rest
 * (`replay_overflow`) keep the observation from being green (V1). The host
 * never records more than this many for one property (D58c L1: the replay set,
 * ledger-property.ts), which holds only while an observation's counterexamples
 * fit in it. */
export const PROPERTY_REPLAY_MAX = 32;
if (PROPERTY_MAX_COUNTEREXAMPLES_MAX > PROPERTY_REPLAY_MAX) {
  throw new Error("an observation's counterexamples must fit in the replay set (L1)");
}
/** What a row keeps of one counterexample's output, and what a result shows. */
export const PROPERTY_ROW_TAIL_CHARS = 500;

/** One case of a run: the seed its command is given and its index. */
export interface PropertyCaseRef {
  readonly seed: number;
  readonly case: number;
}

/** The recorded counterexamples an observation replays first, and how many
 * more were recorded than the replay cap lets it run (V1); `inputs`, by
 * propertyRefKey, the snapshot each one's input was recorded with (RP: a
 * replay runs on it, and without one it is not held). */
export interface PropertyReplay {
  readonly refs: readonly PropertyCaseRef[];
  readonly overflow: number;
  readonly inputs?: ReadonlyMap<string, RecheckInputsRecord>;
}

/** A recorded counterexample whose replay did not run on its recorded input
 * (RP), and why: not held, not a counterexample. */
export interface PropertyInputDiffers extends PropertyCaseRef {
  readonly reason: string;
}

/** What a row keeps of an input_differs reason. */
export const PROPERTY_INPUT_DIFFERS_REASON_CHARS = 300;

/** Why an observation stopped. */
export type PropertyStop = "cases" | "counterexamples" | "time" | "wall" | "error";

/** One case that violated the invariant, as a row records it. */
export interface PropertyCounterexample extends PropertyCaseRef {
  /** It was a recorded counterexample, replayed before the sample. */
  readonly replayed?: true;
  readonly exit_code: number;
  /** The signal that ended it, when one did (V2: a crash is a violation). */
  readonly signal?: string;
  /** The end of what the case printed, stdout and stderr together. */
  readonly output_tail: string;
  /** Its per-case directory as the execution left it, snapshotted before
   * anything else ran (E1); `reason` when it could not be. */
  readonly input: RecheckInputsRecord;
  /** recheck only: what the execution ran with besides the product,
   * snapshotted before the observation's first execution — every execution
   * of one observation runs with the same (D58b V4, V6). */
  readonly inputs?: RecheckInputsRecord;
  /** The model's own call only: where the directory itself is kept. */
  readonly kept?: string;
}

/** What one observation of a property ran and saw, as its row carries it
 * (the `property` field). */
export interface PropertyFields {
  /** The seed the sample was drawn from. */
  readonly sample_seed: number;
  /** Executions that ran to completion: replayed, then sample. */
  readonly runs: number;
  /** Sample cases that ran to completion. */
  readonly sample: number;
  /** The recorded counterexamples replayed first that ran to completion, in
   * the order they ran. */
  readonly replayed: readonly PropertyCaseRef[];
  /** How many recorded counterexamples the observation set out to replay
   * (at most PROPERTY_REPLAY_MAX). */
  readonly replay_planned: number;
  /** How many more were recorded than it could replay: past the cap. */
  readonly replay_overflow: number;
  readonly stopped: PropertyStop;
  readonly elapsed_ms: number;
  /** The case execution time the time budget was charged (D58b V6): the
   * executions themselves, never the host's work around them. */
  readonly case_ms: number;
  readonly counterexamples: readonly PropertyCounterexample[];
  /** The case that was stopped before it completed, or could not start (not
   * judged), and why. */
  readonly unfinished?: PropertyCaseRef & { readonly reason: string };
  /** RP (D58d): the recorded counterexamples whose replay did not run on
   * their recorded input — not held, not counterexamples; while any is
   * listed the observation is not green. Absent when none. */
  readonly input_differs?: readonly PropertyInputDiffers[];
}

export type PropertyStatus = "green" | "red" | "not_runnable";

const isSeed = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PROPERTY_SEED_MAX;
const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const STOPS: ReadonlySet<string> = new Set(["cases", "counterexamples", "time", "wall", "error"]);

/** An integer within [min, max]. */
function within(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * A recorded property's bounds, re-checked (V5): the principle a non-empty
 * text of at most PROPERTY_PRINCIPLE_MAX characters, `cases`, `seed`,
 * `time_budget_ms` and `max_counterexamples` integers within the property
 * tool's own bounds. Every evaluator checks this before it runs anything —
 * a case whose `property` did not come through the property tool (a
 * hand-written row, another writer) is refused, stated, never run on bounds
 * it cannot rely on.
 */
export function propertyBoundsOf(value: unknown): { readonly ok: true; readonly property: LedgerProperty } | { readonly ok: false; readonly reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "the case's property is not a property the property tool recorded (not an object)" };
  }
  const p = value as Record<string, unknown>;
  const wrong: string[] = [];
  if (typeof p.principle !== "string" || p.principle.trim().length === 0 || p.principle.length > PROPERTY_PRINCIPLE_MAX) {
    wrong.push(`principle must be a non-empty text of at most ${PROPERTY_PRINCIPLE_MAX} characters`);
  }
  if (!within(p.cases, 1, PROPERTY_CASES_MAX)) wrong.push(`cases must be an integer from 1 to ${PROPERTY_CASES_MAX}`);
  if (!within(p.seed, 0, PROPERTY_SEED_MAX)) wrong.push(`seed must be an integer from 0 to ${PROPERTY_SEED_MAX}`);
  if (!within(p.time_budget_ms, 1, PROPERTY_TIME_BUDGET_MAX_MS)) wrong.push(`time_budget_ms must be an integer from 1 to ${PROPERTY_TIME_BUDGET_MAX_MS}`);
  if (!within(p.max_counterexamples, 1, PROPERTY_MAX_COUNTEREXAMPLES_MAX)) {
    wrong.push(`max_counterexamples must be an integer from 1 to ${PROPERTY_MAX_COUNTEREXAMPLES_MAX}`);
  }
  if (wrong.length > 0) return { ok: false, reason: `the case's property is outside the property tool's bounds: ${wrong.join("; ")}` };
  return {
    ok: true,
    property: {
      principle: p.principle as string,
      cases: p.cases as number,
      seed: p.seed as number,
      time_budget_ms: p.time_budget_ms as number,
      max_counterexamples: p.max_counterexamples as number,
    },
  };
}

/** The verdict a row's fields give (V1, V2): a pure function, so replay
 * derives the verdict the row records. */
export function propertyVerdict(fields: PropertyFields): PropertyStatus {
  if (fields.counterexamples.length > 0) return "red";
  return propertyShortfall(fields) === undefined ? "green" : "not_runnable";
}

/** Why an observation with no counterexample is not green, in the words a
 * reason uses; undefined when it is (V1). Pure. */
export function propertyShortfall(fields: PropertyFields): string | undefined {
  const reasons: string[] = [];
  if (fields.runs === 0) reasons.push("no case completed");
  if (fields.unfinished !== undefined) {
    reasons.push(`case ${fields.unfinished.case} (seed ${fields.unfinished.seed}) was not judged: ${fields.unfinished.reason}`);
  }
  if (fields.replay_overflow > 0) {
    reasons.push(`${fields.replay_overflow} recorded counterexample(s) past the replay cap of ${PROPERTY_REPLAY_MAX} were not re-run`);
  }
  const differs = fields.input_differs ?? [];
  if (differs.length > 0) {
    const first = differs[0]!;
    reasons.push(`${differs.length} recorded counterexample(s) were not re-run on their recorded input, so none of them counts as held `
      + `(the case's generator is not a function of its seed, or the case changed its recorded input): case ${first.case} (seed ${first.seed}): ${first.reason}`);
  }
  const notCompleted = fields.replay_planned - fields.replayed.length - differs.length;
  if (notCompleted > 0) {
    reasons.push(`${notCompleted} of the ${fields.replay_planned} recorded counterexample(s) it set out to re-run did not run to completion`);
  }
  // The stop, unless the case it cut already says it.
  if (fields.unfinished === undefined) {
    if (fields.stopped === "time") reasons.push("the time budget ran out before every planned case ran");
    else if (fields.stopped === "wall") reasons.push("the run's outer wall was reached before every planned case ran");
    else if (fields.stopped === "error") reasons.push("an execution could not be made");
    else if (fields.stopped === "counterexamples") reasons.push("it stopped at max_counterexamples with no counterexample recorded");
  }
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

/** The status a row's `property` field gives, whatever the row claims (V2):
 * a field that is not a readable property run is unknown. */
export function propertyRowStatus(value: unknown): PropertyStatus {
  const fields = propertyFieldsOf(value);
  return fields === undefined ? "not_runnable" : propertyVerdict(fields);
}

/** The last characters of a text. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** The `property` field an observation row carries: bounded (T7) — at most
 * PROPERTY_MAX_COUNTEREXAMPLES_MAX counterexamples, each with at most
 * PROPERTY_ROW_TAIL_CHARS of output, and at most PROPERTY_REPLAY_MAX replays. */
export function propertyRowFields(observation: PropertyFields): { readonly property: Record<string, unknown> } {
  return {
    property: {
      sample_seed: observation.sample_seed,
      runs: observation.runs,
      sample: observation.sample,
      replayed: observation.replayed.map((ref) => [ref.seed, ref.case]),
      replay_planned: observation.replay_planned,
      replay_overflow: observation.replay_overflow,
      stopped: observation.stopped,
      elapsed_ms: observation.elapsed_ms,
      case_ms: observation.case_ms,
      counterexamples: observation.counterexamples.map((item) => ({
        seed: item.seed,
        case: item.case,
        ...(item.replayed === true ? { replayed: true } : {}),
        exit_code: item.exit_code,
        ...(item.signal === undefined ? {} : { signal: item.signal }),
        output_tail: tail(item.output_tail, PROPERTY_ROW_TAIL_CHARS),
        input: { ...item.input },
        ...(item.inputs === undefined ? {} : { inputs: { ...item.inputs } }),
        ...(item.kept === undefined ? {} : { kept: item.kept }),
      })),
      ...(observation.unfinished === undefined ? {} : { unfinished: { ...observation.unfinished } }),
      ...((observation.input_differs ?? []).length === 0 ? {} : {
        input_differs: observation.input_differs!.map((item) => ({ seed: item.seed, case: item.case, reason: item.reason.slice(0, PROPERTY_INPUT_DIFFERS_REASON_CHARS) })),
      }),
    },
  };
}

/**
 * A row's `property` field read back, or undefined when it is not one this
 * build writes. The bounds a reader relies on are re-checked (V5): at most
 * PROPERTY_MAX_COUNTEREXAMPLES_MAX counterexamples, PROPERTY_REPLAY_MAX
 * replays planned and replayed, and `runs` exactly the completed replays and
 * sample cases — a field that says otherwise is not read as a run at all
 * (its verdict: unknown).
 */
export function propertyFieldsOf(value: unknown): PropertyFields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (!isSeed(p.sample_seed) || !isIndex(p.runs) || !isIndex(p.sample) || typeof p.stopped !== "string" || !STOPS.has(p.stopped)
    || !Array.isArray(p.replayed) || !Array.isArray(p.counterexamples)
    || !within(p.replay_planned, 0, PROPERTY_REPLAY_MAX) || !isIndex(p.replay_overflow) || !isIndex(p.case_ms)) {
    return undefined;
  }
  if (p.counterexamples.length > PROPERTY_MAX_COUNTEREXAMPLES_MAX || p.replayed.length > p.replay_planned) return undefined;
  const replayed: PropertyCaseRef[] = [];
  for (const entry of p.replayed) {
    if (!Array.isArray(entry) || !isSeed(entry[0]) || !isIndex(entry[1])) return undefined;
    replayed.push({ seed: entry[0], case: entry[1] });
  }
  if (p.runs !== replayed.length + p.sample) return undefined;
  // RP: the replays that did not run on their recorded input — each a
  // planned replay, none of them held.
  const differs: PropertyInputDiffers[] = [];
  if (p.input_differs !== undefined) {
    if (!Array.isArray(p.input_differs)) return undefined;
    for (const entry of p.input_differs) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
      const d = entry as Record<string, unknown>;
      if (!isSeed(d.seed) || !isIndex(d.case)) return undefined;
      differs.push({ seed: d.seed, case: d.case, reason: typeof d.reason === "string" ? d.reason : "" });
    }
    if (replayed.length + differs.length > p.replay_planned) return undefined;
    const held = new Set(replayed.map((ref) => `${ref.seed}:${ref.case}`));
    if (differs.some((ref) => held.has(`${ref.seed}:${ref.case}`))) return undefined;
  }
  const counterexamples: PropertyCounterexample[] = [];
  for (const entry of p.counterexamples) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const c = entry as Record<string, unknown>;
    if (!isSeed(c.seed) || !isIndex(c.case) || typeof c.exit_code !== "number" || !Number.isInteger(c.exit_code)) return undefined;
    const input = recheckInputsRecordOf(c.input) ?? { reason: "the row names no snapshot of its input" };
    const inputs = recheckInputsRecordOf(c.inputs);
    counterexamples.push({
      seed: c.seed,
      case: c.case,
      ...(c.replayed === true ? { replayed: true as const } : {}),
      exit_code: c.exit_code,
      ...(typeof c.signal === "string" && c.signal.length > 0 ? { signal: c.signal } : {}),
      output_tail: typeof c.output_tail === "string" ? c.output_tail : "",
      input,
      ...(inputs === undefined ? {} : { inputs }),
      ...(typeof c.kept === "string" ? { kept: c.kept } : {}),
    });
  }
  // A counterexample is a completed case: there are never more of them than
  // cases that completed.
  if (counterexamples.length > p.runs) return undefined;
  const u = p.unfinished as Record<string, unknown> | undefined;
  if (u !== undefined && (typeof u !== "object" || u === null || !isSeed(u.seed) || !isIndex(u.case))) return undefined;
  const unfinished = u === undefined ? undefined : { seed: u.seed as number, case: u.case as number, reason: typeof u.reason === "string" ? u.reason : "" };
  return {
    sample_seed: p.sample_seed,
    runs: p.runs,
    sample: p.sample,
    replayed,
    replay_planned: p.replay_planned,
    replay_overflow: p.replay_overflow,
    stopped: p.stopped as PropertyStop,
    elapsed_ms: typeof p.elapsed_ms === "number" ? p.elapsed_ms : 0,
    case_ms: p.case_ms,
    counterexamples,
    ...(unfinished === undefined ? {} : { unfinished }),
    ...(differs.length === 0 ? {} : { input_differs: differs }),
  };
}
