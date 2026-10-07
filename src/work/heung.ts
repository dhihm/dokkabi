import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EventRecord } from "../host/schema.ts";
import type { DriveResult } from "./drive.ts";
import { planDigest } from "./digest.ts";
import { nextAction } from "./next.ts";
import type { WorkPlan } from "./schema.ts";
import { isBlockedByCycleError } from "./validate.ts";
import { viewPlan } from "./view.ts";

export const HEUNG_TOKEN = "heung";
export const DEFAULT_HEUNG_WAVES = 8;
/** How long a budgeted heung run keeps pursuing its goal by default. */
export const DEFAULT_HEUNG_BUDGET_MS = 12 * 60 * 60 * 1000;
/** Consecutive stalled waves tolerated in a budgeted run before it stops. */
export const DEFAULT_HEUNG_NO_PROGRESS_TOLERANCE = 3;

/**
 * What a stalled budgeted run waits before trying again.
 *
 * Climbs to five minutes and stays there: long enough that a wall costs
 * almost nothing over a fortnight, short enough that the run picks the work
 * back up promptly when the operator clears the bar or a dependency lands.
 */
export const STALL_BACKOFF_MS: readonly number[] = Object.freeze([
  0, 15_000, 60_000, 180_000, 300_000,
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const HEUNG_CONTROL_FILE = "heung-control.json";

export interface HeungTake {
  order: string;
  activated: boolean;
  legacy: boolean;
}

export interface ResolveHeungInput {
  flag?: boolean;
  activated?: boolean;
  env?: NodeJS.Dict<string>;
  config?: boolean;
  legacyConfig?: boolean;
}

const KOREAN_ADDRESS = /^(?:(?:\uB3D7\uAC00\uBE44|\uB3C4\uAE68\uBE44)\uC57C|dokkabi)(?=\s|[,!:]|$)\s*[,!:]?\s*/iu;
const KOREAN_HEUNG_PREFIX = /^\uD765\s*(?:\uC774\s*)?\uB098\uAC8C(?:\s+|$)/u;
const KOREAN_NOMINAL_REMAINDER = /^(?:\uB418\uB294|\uB41C|\uB420|\uB418\uB824\uBA74|\uB418\uAE30|\uB418\uB3C4\uB85D|\uD558\uB294|\uD560|\uD558\uB824|\uD558\uB824\uBA74|\uD558\uB824\uACE0|\uD558\uB824\uB294|\uD558\uAE30|\uD558\uB3C4\uB85D|\uD574\uC57C|\uD574\uC8FC\uB294|\uD574\uC900|\uD574\uC904|\uD574\uC8FC\uB824\uBA74|\uD574\uC8FC\uAE30|\uD574\uC8FC\uB3C4\uB85D|\uB9CC\uB4DC\uB294|\uB9CC\uB4E4\uAE30|\uB9CC\uB4E4\uB824\uBA74|\uB9CC\uB4DC\uB824\uBA74|\uBCF4\uC774\uB294|\uB290\uAEF4\uC9C0\uB294|\uC774\uC720|\uC870\uAC74|\uBC29\uBC95|\uC6D0\uB9AC|\uD604\uC0C1|\uACBD\uC6B0)(?:\s|$)/u;
const KOREAN_GENERIC_ACTION = /^(?:\uD574\s*\uBD10|\uD574\s*\uC918|\uCF1C\s*\uC918|\uC2DC\uC791\uD574\s*\uC918)[.!?\s]*$/u;
const KOREAN_ACTION_PREFIX = /^(?:\uD574\s*\uBD10|\uD574\s*\uC918)\s*[,!:]?\s+/u;

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripActivationScaffold(text: string): string {
  let next = compact(text).replace(KOREAN_ADDRESS, "");
  next = next
    .replace(/^\s*(?:and|then)\b\s*/i, "")
    .replace(KOREAN_ACTION_PREFIX, "")
    .replace(/^[,;:!\-]+\s*/, "")
    .trim();
  if (KOREAN_GENERIC_ACTION.test(next) || /^(?:on|please|mode|do it|start|enable)[.!?\s]*$/i.test(next)) {
    return "";
  }
  return next;
}

/**
 * Separate an explicit HEUNG activation from task text.
 *
 * Korean matching is deliberately narrow: the phrase means "make it lively"
 * and does not match the much broader word for "interesting". Unicode escapes
 * keep product source surfaces English-only while accepting operator language.
 */
export function takeHeungSignal(input: string): HeungTake {
  const original = compact(input);
  const hasAddress = KOREAN_ADDRESS.test(original);
  const addressed = original.replace(KOREAN_ADDRESS, "");
  const active = (order: string, legacy = false, preserveTask = false): HeungTake => ({
    order: preserveTask ? compact(order) : stripActivationScaffold(order),
    activated: true,
    legacy,
  });

  if (/^heung[!.]?$/iu.test(addressed)) return active("");
  const canonical = addressed.match(/^heung\s*:\s*(.*)$/iu);
  if (canonical) return active(canonical[1] ?? "", false, true);

  const english = [
    /^(?:turn|switch)\s+on\s+heung\b(?:\s+and\b)?\s*/iu,
    /^(?:enable|start)\s+heung\b(?:\s+and\b)?\s*/iu,
    /^use\s+heung\b(?:\s+to\b)?\s*/iu,
  ].find((pattern) => pattern.test(addressed));
  if (english) return active(addressed.replace(english, ""));

  const korean = addressed.match(KOREAN_HEUNG_PREFIX);
  if (korean) {
    const remainder = addressed.slice(korean[0].length).trim();
    const explicitImperative = KOREAN_GENERIC_ACTION.test(remainder);
    if ((hasAddress || explicitImperative) && !KOREAN_NOMINAL_REMAINDER.test(remainder)) {
      return active(remainder);
    }
  }

  if (/^crunchmode[!.]?$/iu.test(addressed)) return active("", true);
  const legacy = addressed.match(/^crunchmode(?:\s*[:;,!\-]\s*|\s+)(.+)$/iu);
  if (legacy) return active(legacy[1] ?? "", true);

  return { order: original, activated: false, legacy: false };
}

export function isHeungTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const token = value.trim().toLowerCase();
  return token === "1" || token === "true" || token === "on" || token === "yes";
}

export function isHeungFalsey(value: string | undefined): boolean {
  if (value === undefined) return false;
  const token = value.trim().toLowerCase();
  return token === "0" || token === "false" || token === "off" || token === "no";
}

/** Invocation default: flag > activation > canonical env > legacy env > config > off. */
export function resolveHeung(input: ResolveHeungInput): boolean {
  if (input.flag === false) return false;
  if (input.flag === true) return true;
  if (input.activated) return true;
  const env = input.env ?? process.env;
  const fromEnv = env.DOKKABI_HEUNG ?? env.DOKKABI_CRUNCHMODE ?? env.DOKKABI_CRUNCH;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (isHeungFalsey(fromEnv)) return false;
    return isHeungTruthy(fromEnv);
  }
  if (input.config !== undefined) return input.config;
  return input.legacyConfig === true;
}

function isHeungEvent(event: EventRecord | undefined): boolean {
  return event?.name === "work/heung" || event?.name === "work/crunch";
}

export function lastHeungOn(events: readonly EventRecord[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (isHeungEvent(event)) return event?.payload.on === true;
  }
  return false;
}

export function lastHeungWave(events: readonly EventRecord[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!isHeungEvent(event)) continue;
    return typeof event?.payload.wave === "number" ? event.payload.wave : undefined;
  }
  return undefined;
}

/**
 * The cases standing red right now, latest verdict per case.
 *
 * What a stalled run is stuck behind. Named in the stall record so the
 * operator reads "c7h" and not merely "stalled".
 */
export function stillRedCaseIds(events: readonly EventRecord[]): string[] {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (event.name !== "work/case") continue;
    const payload = event.payload as { id?: unknown; status?: unknown };
    if (typeof payload.id !== "string") continue;
    if (payload.status === "red" || payload.status === "green") {
      latest.set(payload.id, payload.status);
    }
  }
  return [...latest].filter(([, status]) => status === "red").map(([id]) => id).sort();
}

export function shouldHeungContinue(result: DriveResult): boolean {
  if (result.status === "done") return false;
  if (result.status === "blocked") {
    const waiting = result.action.type === "blocked" ? result.action.waiting : [];
    if (waiting.some((item) => isBlockedByCycleError(item) || item === "no-todos")) return false;
    return true;
  }
  return (
    result.status === "still_red" ||
    result.status === "max_steps" ||
    result.status === "need_scenarios" ||
    result.status === "need_cases" ||
    result.status === "need_implement"
  );
}

/** Full plan semantics plus earned state. Same string means no progress. */
export function progressFingerprint(plan: WorkPlan, events: readonly EventRecord[] = []): string {
  const view = viewPlan(plan, events);
  const cleared = plan.todos
    .filter((todo) => view.todoState[todo.id] === "clear")
    .map((todo) => todo.id)
    .sort();
  const greens = Object.entries(view.caseStatus)
    .filter(([, status]) => status === "green")
    .map(([id]) => id)
    .sort();
  // The latest failure text per red case. A red whose reason is MOVING —
  // reduced substrate one wave, an import error the next — is a gate being
  // iterated on, not a run going nowhere; fingerprinting only greens read
  // that iteration as no progress and stopped HEUNG mid-climb.
  const redReasons: Record<string, string> = {};
  for (const event of events) {
    if (event.name !== "work/case") continue;
    const payload = event.payload as {
      id?: unknown; status?: unknown; duration_ms?: unknown;
      substrate_reason?: unknown; unrunnable?: unknown;
    };
    if (typeof payload.id !== "string" || payload.duration_ms === undefined || payload.duration_ms === null) continue;
    if (payload.status === "red") {
      const shaped = payload as { failure_digest?: unknown; substrate_reason?: unknown; unrunnable?: unknown };
      redReasons[payload.id] = String(
        shaped.failure_digest ?? shaped.substrate_reason ?? shaped.unrunnable ?? "",
      ).slice(0, 200);
    } else {
      delete redReasons[payload.id];
    }
  }
  return JSON.stringify({
    plan: planDigest(plan),
    todos: plan.todos.map((todo) => todo.id).sort(),
    cases: plan.cases.map((item) => item.id).sort(),
    cleared,
    greens,
    redReasons,
    next: nextAction(view).type,
  });
}

function enabledNow(value: boolean | (() => boolean)): boolean {
  return typeof value === "function" ? value() : value;
}

export type HeungStopReason =
  | "done"
  | "once"
  | "control_off"
  | "cycle"
  | "no_todos"
  | "no_progress"
  | "max_waves"
  | "time_budget";

export type AcceptanceStopReason = "acceptance_rejected" | "acceptance_inconclusive";

export function terminalWorkState(input: {
  graphStatus: DriveResult["status"];
  graphStopReason: string;
  accepted?: boolean;
  acceptanceInconclusive?: boolean;
}): { status: string; stopReason: string } {
  const acceptanceStop: AcceptanceStopReason | undefined = input.accepted === false
    ? input.acceptanceInconclusive === true
      ? "acceptance_inconclusive"
      : "acceptance_rejected"
    : undefined;
  return {
    status: input.graphStatus === "done" && acceptanceStop ? acceptanceStop : input.graphStatus,
    stopReason: acceptanceStop ?? input.graphStopReason,
  };
}

function terminalGraphReason(result: DriveResult): HeungStopReason | undefined {
  if (result.status === "done") return "done";
  if (result.status !== "blocked" || result.action.type !== "blocked") return undefined;
  if (result.action.waiting.some(isBlockedByCycleError)) return "cycle";
  if (result.action.waiting.some((item) => item === "no-todos")) return "no_todos";
  return undefined;
}

/**
 * A budgeted heung run keeps going until the deadline instead of stopping at
 * the wave cap. A long autonomous push (the operator's "keep at the goal for
 * up to 12 hours") is bounded by TIME, not by an arbitrary wave count — the
 * wave cap exists to stop a runaway loop, and a clock does that better over
 * hours. When budgetMs is set the wave cap is lifted unless the caller pins
 * maxWaves explicitly, and a single stalled wave no longer ends the run: only
 * a stall STREAK reaching the tolerance does, because one unproductive wave in
 * a twelve-hour push is normal.
 */
export async function runHeungWaves(input: {
  enabled: boolean | (() => boolean);
  once?: boolean;
  maxWaves?: number;
  /** Wall-clock budget for the whole run; stops with `time_budget`. */
  budgetMs?: number;
  /** Consecutive unchanged fingerprints tolerated before `no_progress`. */
  noProgressTolerance?: number;
  /** Told each time a stall streak crosses the tolerance, with the streak so
   * far and how long the loop is about to wait. The caller records it and
   * raises the operator's alert; this function only decides. */
  onStall?: (input: { waves: number; streak: number; backoffMs: number }) => void;
  /** Injected sleep so the backoff is testable without waiting. */
  wait?: (ms: number) => Promise<void>;
  /** Injected clock so the budget is testable without waiting. */
  now?: () => number;
  fingerprint: (result: DriveResult) => string;
  drive: () => Promise<DriveResult>;
  replan?: (input: { result: DriveResult; wave: number }) => Promise<void>;
}): Promise<{ result: DriveResult; waves: number; stopReason: HeungStopReason }> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const budgetMs = input.budgetMs;
  const overBudget = (): boolean => budgetMs !== undefined && now() - startedAt >= budgetMs;
  // A budgeted run is bounded by the clock; the wave cap applies only when the
  // caller pinned one or when there is no budget at all.
  const maxWaves = input.maxWaves !== undefined
    ? Math.max(1, input.maxWaves)
    : budgetMs === undefined
      ? DEFAULT_HEUNG_WAVES
      : Number.POSITIVE_INFINITY;
  const tolerance = Math.max(1, input.noProgressTolerance ?? (budgetMs === undefined ? 1 : DEFAULT_HEUNG_NO_PROGRESS_TOLERANCE));

  let result = await input.drive();
  let waves = 1;
  const firstTerminal = terminalGraphReason(result);
  if (firstTerminal) return { result, waves, stopReason: firstTerminal };
  if (input.once) return { result, waves, stopReason: "once" };
  if (!enabledNow(input.enabled)) return { result, waves, stopReason: "control_off" };

  if (waves >= maxWaves) return { result, waves, stopReason: "max_waves" };
  if (overBudget()) return { result, waves, stopReason: "time_budget" };
  let last = input.fingerprint(result);
  let stalls = 0;
  // Unlike `stalls`, these are NOT reset by the tolerance -- only by real
  // progress. `streak` is how many waves in a row changed nothing, which is
  // what the operator reads; `walls` is how many times the run has hit the
  // tolerance, which is what makes each wall cost more than the last.
  let streak = 0;
  let walls = 0;
  while (shouldHeungContinue(result)) {
    if (!enabledNow(input.enabled)) return { result, waves, stopReason: "control_off" };
    if (input.replan) await input.replan({ result, wave: waves + 1 });
    if (!enabledNow(input.enabled)) return { result, waves, stopReason: "control_off" };
    result = await input.drive();
    waves += 1;
    const terminal = terminalGraphReason(result);
    if (terminal) return { result, waves, stopReason: terminal };
    if (!enabledNow(input.enabled)) return { result, waves, stopReason: "control_off" };
    const next = input.fingerprint(result);
    if (next === last) {
      stalls += 1;
      streak += 1;
      if (stalls >= tolerance) {
        // An unbudgeted run has no other bound, so a stall streak ends it. A
        // budgeted one does not stop here: the budget IS the operator's
        // statement of how long to keep at the goal, and a stall is a reason
        // to change approach, not to go home. The replan above runs every
        // wave and shifts strategy on exactly this signal — live, one run
        // shifted six times and finished work after each, yet stopped at
        // three stalls with sixteen of its twenty-four hours unspent and the
        // graph still red. The clock, the control file, and a terminal graph
        // state remain the ways out.
        if (budgetMs === undefined) return { result, waves, stopReason: "no_progress" };
        // But `stalls = 0` alone made the loop unbounded in the other
        // direction, because it assumes the replan CAN change something. When
        // the blocker is a bar only a person can clear -- a case asserting a
        // file the operator has to write -- the replan changes nothing, the
        // fingerprint never moves, and the reset fires forever: 537 waves in
        // two hours, 13 seconds apart, 1,074 identical red verdicts, no green,
        // 11M input tokens. Trying again is still right; trying again
        // instantly is not. Each streak waits longer than the last, so a run
        // with nothing to do costs nearly nothing while it keeps its budget.
        stalls = 0;
        walls += 1;
        // Indexed by walls HIT, not by stalled waves: one wall is `tolerance`
        // waves wide, so counting waves skipped most of the ladder and the
        // first wall already waited a minute.
        const backoffMs = STALL_BACKOFF_MS[Math.min(walls - 1, STALL_BACKOFF_MS.length - 1)]!;
        input.onStall?.({ waves, streak, backoffMs });
        if (backoffMs > 0) await (input.wait ?? sleep)(backoffMs);
      }
    } else {
      stalls = 0;
      streak = 0;
      walls = 0;
    }
    if (waves >= maxWaves) return { result, waves, stopReason: "max_waves" };
    if (overBudget()) return { result, waves, stopReason: "time_budget" };
    last = next;
  }
  return { result, waves, stopReason: "no_progress" };
}

export function heungControlPath(sessionDir: string): string {
  return join(sessionDir, HEUNG_CONTROL_FILE);
}

export function readHeungControl(sessionDir: string): boolean | undefined {
  const path = heungControlPath(sessionDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : undefined;
  } catch {
    return undefined;
  }
}

export function writeHeungControl(sessionDir: string, enabled: boolean): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const path = heungControlPath(sessionDir);
  const temporary = join(sessionDir, `.${HEUNG_CONTROL_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may already have been atomically renamed.
    }
    throw error;
  }
}
