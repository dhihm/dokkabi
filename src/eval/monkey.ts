import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../host/event-log.ts";
import { redactText } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";

/**
 * Monkeymode: repeated independent sampling for tasks with an automatic
 * verifier (Large Language Monkeys, arXiv:2407.21787; issue #59).
 *
 * The coordinator runs up to k isolated samples of the same order — fresh
 * session, fresh workspace, the same sealed prefix — and the verifier picks
 * the FIRST green. There is no majority vote and no reward model: those
 * plateau where coverage keeps climbing (Monkeys §4), and the domains this
 * mode opens (SWE instances, work cases) already carry an oracle.
 *
 * Orthogonal to HEUNG: HEUNG revises one trajectory until no gaps remain;
 * monkey re-draws the proposal distribution in independent one-shots
 * (Snell et al., arXiv:2408.03314 — sequential revision vs parallel
 * best-of-N). Also not `--retries`, which reruns the SAME workspace and so
 * is not an independent sample.
 */

/** v1 keeps k small: a 27B dense serve decodes ~12 tok/s, so one trajectory
 * is minutes. First-green early exit makes the expected cost far below k. */
export const DEFAULT_MONKEY_K = 4;
export const MAX_MONKEY_K = 32;
/** The Monkeys paper samples at temperature 0.6; greedy defaults would
 * clone the same answer k times. */
export const DEFAULT_MONKEY_TEMPERATURE = 0.6;

export interface MonkeySample {
  readonly index: number;
  readonly session: string;
  readonly resolved: boolean;
  /** The sample's route reported quota_exhausted — the campaign must stop
   * before the next sample silently burns the daily window (#59 S5). */
  readonly quotaExhausted?: boolean;
}

export interface MonkeyTake {
  order: string;
  activated: boolean;
}

export type MonkeyStopReason = "resolved" | "exhausted" | "quota_exhausted";

export type MonkeyStep =
  | { action: "run"; index: number }
  | { action: "stop"; reason: MonkeyStopReason };

export interface MonkeySelection {
  readonly k: number;
  readonly k_used: number;
  readonly resolved: boolean;
  /** Session id of the first green sample. Absent means coverage 0. */
  readonly winner?: string;
}

/**
 * Separate an explicit monkeymode activation from task text, mirroring
 * takeHeungSignal: the word is host policy, so it never reaches the model's
 * goal sentence (constitution 4 — no mode tokens in the prompt).
 *
 * Deliberately as strict as HEUNG's parser — bare word or a colon prefix
 * only. A looser separator class turned orders ABOUT the feature
 * ("monkeymode is undocumented, fix the README", "monkeymode-style helper
 * rename") into refused activations (PR #91 re-review).
 */
export function takeMonkeySignal(input: string): MonkeyTake {
  const original = input.replace(/\s+/g, " ").trim();
  if (/^monkeymode[!.]?$/i.test(original)) return { order: "", activated: true };
  const prefixed = original.match(/^monkeymode\s*:\s*(.*)$/i);
  if (prefixed) return { order: prefixed[1]!.trim(), activated: true };
  return { order: original, activated: false };
}

function boundedK(value: number): number | undefined {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MONKEY_K) return undefined;
  return value;
}

export interface ResolveMonkeyKInput {
  /** Explicit --k (or --monkeymode N). Invalid explicit input is an operator
   * error, not something to guess around. */
  flagK?: number;
  /** An order-word activation (takeMonkeySignal). */
  activated?: boolean;
  env?: NodeJS.Dict<string>;
  /** ~/.dokkabi/config.json `monkeymode`: true = default k, number = that k. */
  config?: boolean | number;
}

/**
 * Invocation default: flag > order word > DOKKABI_MONKEYMODE > config > off.
 * Off is k=1 — exactly today's single run. Anything malformed fails closed
 * to 1 (an env typo must not start an 8-sample campaign), except an explicit
 * flag, which throws.
 */
export function resolveMonkeyK(input: ResolveMonkeyKInput): number {
  if (input.flagK !== undefined) {
    const k = boundedK(input.flagK);
    if (k === undefined) {
      throw new Error(`--k requires an integer from 1 to ${MAX_MONKEY_K}`);
    }
    return k;
  }
  if (input.activated) return DEFAULT_MONKEY_K;
  const raw = (input.env ?? process.env).DOKKABI_MONKEYMODE?.trim().toLowerCase();
  if (raw !== undefined && raw !== "") {
    if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return 1;
    if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return DEFAULT_MONKEY_K;
    return /^\d+$/.test(raw) ? boundedK(Number(raw)) ?? 1 : 1;
  }
  if (typeof input.config === "number") return boundedK(input.config) ?? 1;
  if (input.config === true) return DEFAULT_MONKEY_K;
  return 1;
}

/** Sample i's isolated session id. The campaign session holds monkey/*. */
export function monkeySampleSession(base: string, index: number): string {
  return `${base}-m${index}`;
}

/**
 * The campaign base session: k=1 keeps the caller's session (today's single
 * run); k>1 stamps it so sample sessions are fresh EVERY campaign — a
 * stable base reused sample sessions, inheriting the previous campaign's
 * transcript and reading its quota rows as today's verdict (PR #91 review
 * finding 1).
 */
export function campaignSessionId(base: string, k: number, stamp: string): string {
  return k > 1 ? `${base}-${stamp}` : base;
}

/** Millisecond time plus a random tail: two campaigns launched in the same
 * millisecond must not share sample sessions or workspaces. */
export function campaignStamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Sample i's isolated workspace. Each is prepared from base_commit; no
 * patch, venv, or log crosses between samples (#59 S3). A trailing slash is
 * normalized so the sample never nests INSIDE the base workspace. */
export function monkeySampleWorkspace(base: string, index: number): string {
  return `${base.replace(/\/+$/, "")}-m${index}`;
}

/**
 * Explicit --temperature validated like --k: a typo must not silently run
 * the whole campaign at the provider's greedy default (the child-side
 * resolver fails closed, so a bad value here means k clones). Without a
 * flag, k>1 gets the Monkeys setting and k=1 stays today.
 */
export function campaignTemperature(flagRaw: string | undefined, k: number): number | undefined {
  if (flagRaw !== undefined) {
    const value = Number(flagRaw);
    if (!Number.isFinite(value) || value <= 0 || value > 2) {
      throw new Error("--temperature requires a value in (0, 2]");
    }
    return value;
  }
  return k > 1 ? DEFAULT_MONKEY_TEMPERATURE : undefined;
}

/** Pure campaign walk: first green stops (unless the caller is MEASURING —
 * a difficulty pilot draws all k, #59 T5), quota stops, k bounds. */
export function nextMonkeySample(
  k: number,
  samples: readonly MonkeySample[],
  options: { stopOnResolved?: boolean } = {},
): MonkeyStep {
  if (options.stopOnResolved !== false && samples.some((sample) => sample.resolved)) {
    return { action: "stop", reason: "resolved" };
  }
  if (samples.at(-1)?.quotaExhausted === true) return { action: "stop", reason: "quota_exhausted" };
  if (samples.length >= k) return { action: "stop", reason: "exhausted" };
  return { action: "run", index: samples.length + 1 };
}

/** The verifier already chose; this only reports it. No vote, no ranking. */
export function monkeySelect(k: number, samples: readonly MonkeySample[]): MonkeySelection {
  const winner = samples.find((sample) => sample.resolved);
  return {
    k,
    k_used: samples.length,
    resolved: winner !== undefined,
    ...(winner ? { winner: winner.session } : {}),
  };
}

/** Retries rerun the same workspace; monkey samples are independent. The
 * two are different claims about the run and must not be combined. */
export function validateMonkeyRetries(k: number, retries: number): void {
  if (k > 1 && retries > 1) {
    throw new Error("--k runs independent samples; --retries reruns one workspace — pick one");
  }
}

/** Swarm children do not inherit the temperature knob (their env allowlist
 * strips it), so a swarm campaign would claim diversity it does not have.
 * v1 monkey is single-agent; the combination is refused. */
export function validateMonkeySwarm(k: number, swarm: boolean): void {
  if (k > 1 && swarm) {
    throw new Error("--k is single-agent in v1; swarm children would sample at the provider default — drop --swarm or --k");
  }
}

/**
 * Did this sample's route run out of its window? Reads only recorded
 * observations (constitution 5 — no live re-probing on replay).
 */
export function sampleQuotaExhausted(events: readonly EventRecord[]): boolean {
  return events.some(
    (event) =>
      event.observe?.model_usage?.status === "quota_exhausted" ||
      (event.name === "model/quota_guard" && event.payload.decision === "stop"),
  );
}

/**
 * The quota verdict for one sample, from the sample's own session log AND
 * its envfix children (`<sample>-envfix-<ts>` — the adapter runs those with
 * the same route, so their quota rows count). Never another sample's log:
 * a `-m1` verdict must not bleed into `-m2` (PR #91 review finding 4).
 */
export function readSampleQuotaExhausted(home: string, sampleSession: string): boolean {
  let names: string[];
  try {
    names = readdirSync(join(home, "sessions"));
  } catch {
    return false;
  }
  const envfixPrefix = `${sampleSession}-envfix-`;
  for (const name of names) {
    if (name !== sampleSession && !name.startsWith(envfixPrefix)) continue;
    try {
      const events = new EventLog(join(home, "sessions", name, "events.jsonl")).events;
      if (sampleQuotaExhausted(events)) return true;
    } catch {
      // an unreadable log carries no verdict
    }
  }
  return false;
}

export function recordMonkeyStart(
  log: EventLog,
  input: { k: number; route?: string; model?: string; temperature?: number },
): void {
  log.append({
    kind: "observe",
    name: "monkey/start",
    payload: {
      k: input.k,
      route: input.route ?? "missing",
      model: input.model ?? "missing",
      temperature: input.temperature ?? "missing",
    },
  });
}

export function recordMonkeySample(
  log: EventLog,
  input: { index: number; session: string; resolved: boolean; quotaExhausted?: boolean; error?: string },
): void {
  log.append({
    kind: "observe",
    name: "monkey/sample",
    payload: {
      i: input.index,
      session: input.session,
      resolved: input.resolved,
      ...(input.quotaExhausted ? { quota_exhausted: true } : {}),
      ...(input.error ? { error: redactText(input.error.slice(0, 300)) } : {}),
    },
  });
}

export interface MonkeyRunContext {
  readonly index: number;
  readonly session: string;
  readonly workspace: string;
}

export interface MonkeyCampaignInput<T extends { resolved: boolean }> {
  k: number;
  /** Campaign session id — sample sessions derive as `<session>-m<i>`. */
  session: string;
  /** Base workspace — sample workspaces derive as `<workspace>-m<i>`. */
  workspace: string;
  /** Campaign log; receives monkey/start|sample|select. */
  log: EventLog;
  route?: string;
  model?: string;
  temperature?: number;
  /** Run one isolated sample. A throw is an honest failed sample, not the
   * end of the campaign — independence means the next draw still happens. */
  runSample(context: MonkeyRunContext): Promise<T>;
  /** Post-sample quota verdict for a sample's session (readSampleQuotaExhausted
   * bound to a home, in production). Consulted only for unresolved samples. */
  quotaExhausted?(sampleSession: string): boolean;
  /** false = a MEASURING campaign (difficulty pilot): draw all k, never
   * stop on the first green. Default true — #59 S2. */
  stopOnResolved?: boolean;
}

export interface MonkeyCampaignOutcome<T> {
  readonly samples: MonkeySample[];
  /** Parallel to samples; a thrown sample leaves undefined. */
  readonly results: (T | undefined)[];
  readonly selection: MonkeySelection;
  readonly stop: MonkeyStopReason;
  /** Index into samples/results of the first green; -1 when coverage 0. */
  readonly winnerIndex: number;
}

/**
 * The campaign loop (#59 design): sequential independent samples, first
 * green wins, quota fails closed, and monkey/select ALWAYS lands — even
 * when every sample throws (constitution 6: an unrecorded campaign did not
 * happen).
 */
export async function runMonkeyCampaign<T extends { resolved: boolean }>(
  input: MonkeyCampaignInput<T>,
): Promise<MonkeyCampaignOutcome<T>> {
  recordMonkeyStart(input.log, {
    k: input.k,
    ...(input.route ? { route: input.route } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  });
  const samples: MonkeySample[] = [];
  const results: (T | undefined)[] = [];
  let stop: MonkeyStopReason = "exhausted";
  for (;;) {
    const step = nextMonkeySample(input.k, samples, {
      ...(input.stopOnResolved === undefined ? {} : { stopOnResolved: input.stopOnResolved }),
    });
    if (step.action === "stop") {
      stop = step.reason;
      break;
    }
    const session = monkeySampleSession(input.session, step.index);
    const workspace = monkeySampleWorkspace(input.workspace, step.index);
    let result: T | undefined;
    let error: string | undefined;
    try {
      result = await input.runSample({ index: step.index, session, workspace });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    results.push(result);
    const resolved = result?.resolved === true;
    const quotaExhausted = !resolved && input.quotaExhausted?.(session) === true;
    const sample: MonkeySample = {
      index: step.index,
      session,
      resolved,
      ...(quotaExhausted ? { quotaExhausted } : {}),
    };
    samples.push(sample);
    recordMonkeySample(input.log, { ...sample, ...(error ? { error } : {}) });
  }
  const selection = monkeySelect(input.k, samples);
  recordMonkeySelect(input.log, selection, stop);
  return {
    samples,
    results,
    selection,
    stop,
    winnerIndex: samples.findIndex((sample) => sample.resolved),
  };
}

export function recordMonkeySelect(
  log: EventLog,
  selection: MonkeySelection,
  stop?: MonkeyStopReason,
): void {
  log.append({
    kind: "observe",
    name: "monkey/select",
    payload: {
      k: selection.k,
      k_used: selection.k_used,
      ...(selection.winner ? { winner: selection.winner } : { coverage: 0 }),
      ...(stop ? { stop } : {}),
    },
  });
}
