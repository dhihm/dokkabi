import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { STREAM_STALL_ERROR_CODE } from "./stream-stall.ts";
import { assertNoSecrets, containsPrivateInfrastructure, normalizeHomePaths, redactText, stripTerminalControls } from "./redact.ts";

export type FailoverMode = "off" | "ask" | "auto";
export type ModelCost = "free" | "paid" | "subscription" | "unknown";
export type ModelFailureClass =
  | "rate_limit"
  | "quota"
  | "provider_outage"
  | "transport"
  | "auth"
  | "context"
  | "empty_completion"
  | "output_truncated"
  | "unknown";
/**
 * The interrupt-line and turn-support ladders (host/interrupt-lines.ts,
 * work/turn-support.ts). The MODEL boundary no longer climbs these: its
 * same-route retries follow PROVIDER_RETRY_POLICY_V1 below.
 */
export const MODEL_RETRY_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000, 180_000, 300_000] as const;
export const EMPTY_COMPLETION_RETRY_BACKOFF_MS = [1_000] as const;
export const TRANSPORT_RETRY_BACKOFF_MS = [5_000, 15_000] as const;
/**
 * A truncated reply is retried at once, twice, with a bigger budget each time.
 * There is nothing to wait for — the provider is healthy and answered promptly;
 * it was simply asked for more than it was allowed to say.
 */
export const TRUNCATED_RETRY_BUDGET_SCALE = [2, 4] as const;

/**
 * Provider resilience at the model boundary, as ONE structure.
 *
 * There used to be three tables here — six rungs for a rate limit, two for a
 * dropped link, one for an empty completion — each tuned on the assumption
 * that exhausting it hands the turn to failover. Research runs turn failover
 * OFF, and then the ladder IS the resilience.
 *
 * One structure, but not one tempo, because the faults keep two different
 * kinds of time. A dropped link, a stalled stream and an empty completion come
 * back in seconds or not at all, so waiting minutes on them only burns the
 * run's clock. A rate limit or an overloaded pool is a WINDOW: the upstream
 * said "retry shortly" and meant minutes, and an unattended harness that gives
 * up after fifteen seconds turns a provider's ordinary busy minute into a
 * run-ending failure. The patient schedule is therefore at least as patient as
 * the ladder it replaced (total and per-wait), and the fast one is the
 * bounded, jittered shape the three studied harnesses share.
 *
 * Deliberately flat: two schedules and a class-to-tempo map. No per-provider,
 * per-model or per-reason-code entry — a fault that heals by waiting is
 * retried the same way whoever served it.
 */
export interface ProviderRetryScheduleV1 {
  /** Same-route attempts after the first, per turn. */
  maxRetries: number;
  /** The first rung; each later rung doubles it. */
  baseDelayMs: number;
  /** The ceiling the doubling stops at, on the exponential schedule; provider-stated waits remain a floor. */
  maxDelayMs: number;
  /** Half-width of the band each rung is drawn from, as a share of the rung. */
  jitterRatio: number;
}

export type ProviderRetryTempoV1 = "fast" | "patient";

export interface ProviderRetryPolicyV1 {
  format: 1;
  schedules: Readonly<Record<ProviderRetryTempoV1, ProviderRetryScheduleV1>>;
  /** The classes a wait can fix, each naming its tempo. Absent is ineligible. */
  classes: Readonly<Partial<Record<ModelFailureClass, ProviderRetryTempoV1>>>;
}

export const PROVIDER_RETRY_POLICY_V1: ProviderRetryPolicyV1 = Object.freeze({
  format: 1,
  schedules: Object.freeze({
    fast: Object.freeze({ maxRetries: 5, baseDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 }),
    // 5s 10s 20s 40s 80s 160s 300s 300s — 915s in total against the 635s of
    // the ladder it replaced, and the same 300s ceiling on any single wait.
    patient: Object.freeze({ maxRetries: 8, baseDelayMs: 5_000, maxDelayMs: 300_000, jitterRatio: 0.1 }),
  }),
  classes: Object.freeze({
    empty_completion: "fast",
    transport: "fast",
    rate_limit: "patient",
    provider_outage: "patient",
  }),
}) as ProviderRetryPolicyV1;

export function providerRetrySchedule(
  failureClass: ModelFailureClass,
  policy: ProviderRetryPolicyV1 = PROVIDER_RETRY_POLICY_V1,
): ProviderRetryScheduleV1 | undefined {
  const tempo = policy.classes[failureClass];
  return tempo === undefined ? undefined : policy.schedules[tempo];
}

export function providerRetryEligible(
  failureClass: ModelFailureClass,
  policy: ProviderRetryPolicyV1 = PROVIDER_RETRY_POLICY_V1,
): boolean {
  return providerRetrySchedule(failureClass, policy) !== undefined;
}

/**
 * The wait before a 1-based attempt: the capped exponential rung, drawn from
 * a ±jitterRatio band around it so a provider that failed a whole fleet at
 * once is not asked again by that whole fleet at once.
 *
 * `draw` is the caller's uniform [0,1) sample. It is a parameter rather than
 * an internal Math.random() so the value can be asserted directly, and so the
 * one place that draws it is the one place that records it: the delay chosen
 * here is written into `model/retry.delay_ms` and read back from there — never
 * recomputed, so a recorded run and its replay agree.
 */
export function providerRetryDelayMs(
  schedule: ProviderRetryScheduleV1,
  attempt: number,
  draw: number = Math.random(),
): number {
  const rung = Math.min(schedule.baseDelayMs * 2 ** Math.max(0, attempt - 1), schedule.maxDelayMs);
  const bounded = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0.5;
  return Math.max(0, Math.round(rung * (1 + schedule.jitterRatio * (2 * bounded - 1))));
}

export interface ProviderRetryOptionsV1 {
  draw?: number;
  /** A wait the provider itself stated (Retry-After). It stretches the rung,
   * never shrinks it, including beyond the exponential ceiling. */
  retryAfterMs?: number;
  /** What is left of the budget this wait is spent against. A sleep that wakes
   * after the deadline is not resilience; the turn stops instead. */
  remainingMs?: number;
}

export interface ProviderRetryDecisionV1 {
  attempt: number;
  delayMs: number;
  /** Recorded beside the delay when the provider stated one. */
  retryAfterMs?: number;
}

/** The next rung, or undefined when the class is ineligible, the ladder is
 * spent, or the wait would outlive the budget. `retries` is how many
 * same-route retries this turn already used. */
export function nextProviderRetry(
  retries: number,
  failureClass: ModelFailureClass,
  options: ProviderRetryOptionsV1 = {},
  policy: ProviderRetryPolicyV1 = PROVIDER_RETRY_POLICY_V1,
): ProviderRetryDecisionV1 | undefined {
  const schedule = providerRetrySchedule(failureClass, policy);
  if (schedule === undefined) return undefined;
  const spent = Number.isInteger(retries) && retries > 0 ? retries : 0;
  if (spent >= schedule.maxRetries) return undefined;
  const attempt = spent + 1;
  const rung = providerRetryDelayMs(schedule, attempt, options.draw);
  const stated = typeof options.retryAfterMs === "number" && Number.isFinite(options.retryAfterMs)
    && options.retryAfterMs > 0
    ? options.retryAfterMs
    : undefined;
  const delayMs = stated === undefined ? rung : Math.max(rung, stated);
  // The deadline is a hard edge, not a preference: waking after it buys an
  // episode that is already over, so the honest failure is reported now.
  if (typeof options.remainingMs === "number" && Number.isFinite(options.remainingMs)
    && delayMs >= options.remainingMs) {
    return undefined;
  }
  return { attempt, delayMs, ...(stated === undefined ? {} : { retryAfterMs: stated }) };
}

export const EMPTY_COMPLETION_ERROR_CODE = "DOKKABI_EMPTY_COMPLETION" as const;

/** Host-owned marker for a successful transport that returned no usable
 * assistant response. The stable code, rather than provider text, drives
 * normalization, retry, failover, and public error formatting. */
export class EmptyCompletionError extends Error {
  readonly code = EMPTY_COMPLETION_ERROR_CODE;

  constructor() {
    super("provider returned an empty completion");
    this.name = "EmptyCompletionError";
  }
}

export interface ModelRouteSelection {
  route: string;
  model: string;
}

export type FailoverTriggerV1 =
  | "quota_exhausted"
  | "rate_limit_retries_exhausted"
  | "auth_unavailable"
  | "transport_retries_exhausted"
  | "empty_completion";

export type FailoverSelectorV1 = "ordered" | "most_remaining";
export type FailoverCostPolicyV1 = "free_only" | "subscription_and_free" | "explicit_paid";
export type FailoverContinuityV1 = "continue" | "checkpoint";
export type FailoverRecoveryV1 = "manual" | "next_session";

export interface FailoverCandidatePolicyV1 extends ModelRouteSelection {
  allowedCost: Exclude<ModelCost, "unknown">;
  reservePercent?: number;
}

export interface FailoverPolicyV1 {
  format: 1;
  mode: FailoverMode;
  triggers: FailoverTriggerV1[];
  candidates: FailoverCandidatePolicyV1[];
  selector: FailoverSelectorV1;
  costPolicy: FailoverCostPolicyV1;
  continuity: FailoverContinuityV1;
  recovery: FailoverRecoveryV1;
  maxTransitionsPerTurn: number;
  cooldownSeconds: number;
}

export interface FailoverCandidateStatusV1 extends ModelRouteSelection {
  cost: ModelCost;
  connected: boolean;
  auth?: "connected" | "missing" | "expired" | "unknown";
  quota?: {
    confidence: "authoritative" | "observed" | "estimated" | "unknown";
    freshness?: "fresh" | "stale" | "unknown";
    remainingPercent: number | "missing";
    snapshotDigest?: string;
  };
}

export type RouteFailureClassV1 =
  | "quota_exhausted"
  | "rate_limited"
  | "auth_unavailable"
  | "transport_failure"
  | "invalid_request"
  | "content_rejected"
  | "context_exhausted"
  | "empty_completion"
  | "output_truncated"
  | "tool_failure"
  | "policy_failure";

export interface NormalizedModelFailureV1 {
  class: RouteFailureClassV1;
  reasonCode: string;
  retryAfterSeconds?: number;
  retriesExhausted?: boolean;
  /** Present ONLY on the unclassified fallthrough: a bounded, redacted hint
   * of the message no pattern recognized. Three process deaths in one day
   * shared an identical failure digest and an empty record — the one case
   * where the message IS the diagnosis had dropped it by design. */
  detailHint?: string;
}

export interface ModelFailureInputV1 {
  error?: unknown;
  status?: number;
  message?: string;
  code?: string | number;
  kind?: "tool" | "policy" | "empty_completion" | "output_truncated";
  retryAfterSeconds?: number;
  retriesExhausted?: boolean;
}

const TRIGGERS = new Set<FailoverTriggerV1>([
  "quota_exhausted",
  "rate_limit_retries_exhausted",
  "auth_unavailable",
  "transport_retries_exhausted",
  "empty_completion",
]);
const COSTS = new Set<ModelCost>(["free", "paid", "subscription", "unknown"]);

export function defaultFailoverPolicyV1(): FailoverPolicyV1 {
  return {
    format: 1,
    mode: "off",
    triggers: ["quota_exhausted", "rate_limit_retries_exhausted", "empty_completion"],
    candidates: [],
    selector: "ordered",
    costPolicy: "subscription_and_free",
    continuity: "checkpoint",
    recovery: "manual",
    maxTransitionsPerTurn: 1,
    cooldownSeconds: 60,
  };
}

/** Validate both the v1 schema and the legacy `{mode, free_only, candidates}`
 * shape. Migration deliberately narrows ambiguous legacy candidates to a
 * subscription grant; free-only legacy policy remains exactly free-only. */
export function normalizeFailoverPolicyV1(value: unknown): FailoverPolicyV1 {
  if (value === undefined || value === null) return defaultFailoverPolicyV1();
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("failover policy must be an object");
  const input = value as Record<string, unknown>;
  if (input.format !== undefined && input.format !== 1) throw new Error("unsupported failover policy format");
  const defaults = defaultFailoverPolicyV1();
  const mode = enumValue(input.mode, ["off", "ask", "auto"] as const, "mode", defaults.mode);
  const legacyFreeOnly = input.free_only === true;
  const costPolicy = legacyFreeOnly
    ? "free_only"
    : enumValue(
        input.costPolicy,
        ["free_only", "subscription_and_free", "explicit_paid"] as const,
        "costPolicy",
        defaults.costPolicy,
      );
  const rawTriggers = input.triggers === undefined ? defaults.triggers : input.triggers;
  if (!Array.isArray(rawTriggers)) throw new Error("failover triggers must be an array");
  const triggers = unique(rawTriggers.map((item) => {
    if (typeof item !== "string" || !TRIGGERS.has(item as FailoverTriggerV1)) {
      throw new Error(`unsupported failover trigger ${String(item)}`);
    }
    return item as FailoverTriggerV1;
  }));
  const rawCandidates = input.candidates === undefined ? [] : input.candidates;
  if (!Array.isArray(rawCandidates)) throw new Error("failover candidates must be an array");
  const candidates = rawCandidates.map((item, index): FailoverCandidatePolicyV1 => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`failover candidate ${index + 1} must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    const route = publicRouteId(candidate.route, `candidate ${index + 1} route`);
    const model = publicModelId(candidate.model, `candidate ${index + 1} model`);
    const fallbackCost: Exclude<ModelCost, "unknown"> = legacyFreeOnly ? "free" : "subscription";
    const allowedCost = enumValue(
      candidate.allowedCost,
      ["free", "subscription", "paid"] as const,
      `candidate ${index + 1} allowedCost`,
      fallbackCost,
    );
    const reservePercent = candidate.reservePercent === undefined
      ? undefined
      : boundedNumber(candidate.reservePercent, `candidate ${index + 1} reservePercent`, 0, 100);
    return { route, model, allowedCost, ...(reservePercent === undefined ? {} : { reservePercent }) };
  });
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = selectionKey(candidate);
    if (seen.has(id)) throw new Error(`duplicate failover candidate ${candidate.route}/${candidate.model}`);
    seen.add(id);
  }
  if (mode !== "off" && candidates.length === 0) {
    throw new Error("failover requires at least one explicit route/model candidate");
  }
  const policy: FailoverPolicyV1 = {
    format: 1,
    mode,
    triggers,
    candidates,
    selector: enumValue(input.selector, ["ordered", "most_remaining"] as const, "selector", defaults.selector),
    costPolicy,
    continuity: enumValue(input.continuity, ["continue", "checkpoint"] as const, "continuity", defaults.continuity),
    recovery: enumValue(input.recovery, ["manual", "next_session"] as const, "recovery", defaults.recovery),
    maxTransitionsPerTurn: integerInRange(
      input.maxTransitionsPerTurn ?? defaults.maxTransitionsPerTurn,
      "maxTransitionsPerTurn",
      1,
      32,
    ),
    cooldownSeconds: integerInRange(input.cooldownSeconds ?? defaults.cooldownSeconds, "cooldownSeconds", 0, 86_400),
  };
  assertNoSecrets(policy);
  return policy;
}

export function failoverPolicyDigest(policy: FailoverPolicyV1): string {
  const normalized = normalizeFailoverPolicyV1(policy);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export function modelFailureTrigger(failure: NormalizedModelFailureV1): FailoverTriggerV1 | undefined {
  switch (failure.class) {
    case "quota_exhausted":
      return "quota_exhausted";
    case "rate_limited":
      return "rate_limit_retries_exhausted";
    case "auth_unavailable":
      return "auth_unavailable";
    case "transport_failure":
      return "transport_retries_exhausted";
    case "empty_completion":
      return "empty_completion";
    default:
      return undefined;
  }
}

export function policyAllowsFailure(policy: FailoverPolicyV1, failure: NormalizedModelFailureV1): boolean {
  const trigger = modelFailureTrigger(failure);
  return trigger !== undefined && policy.triggers.includes(trigger);
}

export function selectFailoverCandidatesV1(
  policy: FailoverPolicyV1,
  available: readonly FailoverCandidateStatusV1[],
  current?: ModelRouteSelection,
  excluded: ReadonlySet<string> = new Set(),
): FailoverCandidateStatusV1[] {
  if (policy.mode === "off") return [];
  const liveByKey = new Map(available.map((candidate) => [selectionKey(candidate), candidate]));
  const eligible = policy.candidates.flatMap((saved) => {
    const key = selectionKey(saved);
    const live = liveByKey.get(key);
    if (!live?.connected || excluded.has(key) || (current && key === selectionKey(current))) return [];
    if (live.cost !== saved.allowedCost || !costAllowed(policy.costPolicy, live.cost)) return [];
    if (saved.reservePercent !== undefined) {
      if (live.quota?.confidence !== "authoritative" || typeof live.quota.remainingPercent !== "number") return [];
      if (live.quota.remainingPercent <= saved.reservePercent) return [];
    }
    return [live];
  });
  if (policy.selector === "ordered") return eligible;
  return eligible
    .filter((candidate) => candidate.quota?.confidence === "authoritative" && typeof candidate.quota.remainingPercent === "number")
    .sort((left, right) => Number(right.quota?.remainingPercent) - Number(left.quota?.remainingPercent));
}

/** Normalize a provider failure to a deliberately small public record. Raw
 * messages, bodies, headers, endpoints and account identifiers are never
 * copied into the result. Structured status/code wins over message heuristics. */
export function normalizeModelFailureV1(input: ModelFailureInputV1 | unknown): NormalizedModelFailureV1 {
  const value = failureInput(input);
  const suffix = {
    ...(safeRetryAfter(value.retryAfterSeconds) === undefined ? {} : { retryAfterSeconds: safeRetryAfter(value.retryAfterSeconds) }),
    ...(value.retriesExhausted === true ? { retriesExhausted: true } : {}),
  };
  if (value.kind === "tool") return { class: "tool_failure", reasonCode: "tool_failed", ...suffix };
  if (value.kind === "policy") return { class: "policy_failure", reasonCode: "policy_refused", ...suffix };
  const status = Number.isInteger(value.status) ? value.status : undefined;
  // Matching is case-insensitive; the hint is not. A provider's own casing
  // and punctuation are part of what identifies which fault this was, and a
  // lowercased copy of the message is a worse record than the message.
  const rawMessage = typeof value.message === "string"
    ? value.message
    : value.error instanceof Error
      ? value.error.message
      : String(value.error ?? "");
  const message = rawMessage.toLowerCase();
  const code = String(value.code ?? errorCode(value.error) ?? "").toUpperCase();
  // Pi may carry the host's typed input refusal as an assistant error string.
  // An explicit provider HTTP failure still wins over that string fallback.
  if (code === "PROVIDER_INPUT_REFUSED"
    || (status === undefined && /^provider-input:/u.test(rawMessage.trim()))) {
    return { class: "policy_failure", reasonCode: "provider_input_refused", ...suffix };
  }
  // The reply was cut off at its output budget. Not a route fault and not an
  // answer: the route is healthy and would say more if asked for more, so this
  // never earns a failover — it earns a bigger budget on the same route.
  if (value.kind === "output_truncated" || message === "output_truncated") {
    return { class: "output_truncated", reasonCode: "stop_length", ...suffix };
  }
  if (
    value.kind === "empty_completion"
    || code === EMPTY_COMPLETION_ERROR_CODE
    || message === "empty_completion"
  ) {
    return { class: "empty_completion", reasonCode: "empty_completion", ...suffix };
  }
  if (status === 401 || status === 403) return { class: "auth_unavailable", reasonCode: `http_${status}`, ...suffix };
  if (status === 429) return { class: "rate_limited", reasonCode: "http_429", ...suffix };
  if (status === 413 || /context.{0,24}(?:length|window|token)|maximum context/.test(message)) {
    return { class: "context_exhausted", reasonCode: status === 413 ? "http_413" : "context_limit", ...suffix };
  }
  if (status === 422 || /content.{0,20}(?:reject|filter|safety)|safety.{0,20}(?:reject|filter)/.test(message)) {
    return { class: "content_rejected", reasonCode: status === 422 ? "http_422" : "content_rejected", ...suffix };
  }
  if (status === 400) return { class: "invalid_request", reasonCode: "http_400", ...suffix };
  if (status !== undefined && status >= 500 && status <= 599) {
    return { class: "transport_failure", reasonCode: "provider_unavailable", ...suffix };
  }
  if (/quota|usage limit|capacity exhausted/.test(message)) {
    return { class: "quota_exhausted", reasonCode: "quota_exhausted", ...suffix };
  }
  if (/429|rate.?limit|too many requests/.test(message)) {
    return { class: "rate_limited", reasonCode: "rate_limited", ...suffix };
  }
  if (/401|403|unauthori[sz]ed|forbidden|authentication|credential/.test(message)) {
    return { class: "auth_unavailable", reasonCode: "authentication_failed", ...suffix };
  }
  // A stream that stopped without erroring, aborted by the stall watchdog
  // (host/stream-stall.ts): a dropped link with a stable name of its own.
  if (code === STREAM_STALL_ERROR_CODE) return { class: "transport_failure", reasonCode: "stream_stalled", ...suffix };
  if (code === "ECONNRESET") return { class: "transport_failure", reasonCode: "connection_reset", ...suffix };
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return { class: "transport_failure", reasonCode: "network_timeout", ...suffix };
  }
  // "connection error." — the provider's bare phrasing matched none of the
  // older tokens, so a plainly transient failure fell through to the
  // deterministic class, skipped every backoff, and killed three runs.
  //
  // This branch keeps the message for the same reason the unclassified one
  // does: fifteen alternatives share a single reason code, so the code says
  // only "one of these matched" and WHICH one is the whole diagnosis. Live,
  // eleven runs died as `network_unavailable` and the log could not say
  // whether the socket reset, the stream ended, or the fetch never left —
  // three different faults with three different fixes, recorded identically.
  if (/websocket|sse stream|stream ended|econn|socket|network|connection|fetch failed|timed? ?out|timeout|overloaded|service unavailable|bad gateway|upstream/.test(message)) {
    const transportHint = redactedFailureHint(rawMessage);
    return {
      class: "transport_failure",
      reasonCode: "network_unavailable",
      ...(transportHint.length > 0 ? { detailHint: transportHint } : {}),
      ...suffix,
    };
  }
  const hint = redactedFailureHint(rawMessage);
  return {
    class: "invalid_request",
    reasonCode: "unclassified_failure",
    ...(hint.length > 0 ? { detailHint: hint } : {}),
    ...suffix,
  };
}

/**
 * A provider message, safe to record: terminal control stripped, operator home
 * paths normalised, secret shapes redacted, and bounded. The same pipeline the
 * unclassified fallthrough has always used — nothing here is new exposure, it
 * is the existing guard applied to one more branch.
 */
function redactedFailureHint(message: string): string {
  return redactText(normalizeHomePaths(stripTerminalControls(message))).trim().slice(0, 240);
}

/** Legacy policy/candidate API retained for plugins and old tests while the
 * richer runtime uses FailoverPolicyV1. */
export interface FailoverCandidate extends ModelRouteSelection {
  cost: ModelCost;
  connected: boolean;
}

export interface FailoverPolicy {
  mode: FailoverMode;
  freeOnly?: boolean;
  candidates: FailoverCandidate[];
}

export type FailoverDecision =
  | { action: "stop"; reason: "disabled" | "no_candidate" }
  | { action: "ask"; candidates: FailoverCandidate[] }
  | { action: "switch"; candidate: FailoverCandidate };

export function defaultFailoverPolicy(): FailoverPolicy {
  return { mode: "off", candidates: [] };
}

export function classifyModelFailure(error: unknown): ModelFailureClass {
  switch (normalizeModelFailureV1({ error }).class) {
    case "rate_limited": return "rate_limit";
    case "quota_exhausted": return "quota";
    case "auth_unavailable": return "auth";
    case "context_exhausted": return "context";
    case "empty_completion": return "empty_completion";
    case "output_truncated": return "output_truncated";
    case "transport_failure":
      return /502|503|504|overloaded|service unavailable|bad gateway|upstream/i.test(error instanceof Error ? error.message : String(error))
        ? "provider_outage"
        : "transport";
    default: return "unknown";
  }
}

export function failureAllowsFailover(kind: ModelFailureClass): boolean {
  return kind === "rate_limit"
    || kind === "quota"
    || kind === "provider_outage"
    || kind === "transport"
    || kind === "auth"
    || kind === "empty_completion";
  // output_truncated is deliberately absent: the route answered, and answered
  // well, right up to the budget it was given. Moving to another route asks a
  // different model the same too-large question.
}

export function eligibleFailoverCandidates(
  // Either policy format. Eligibility reads only the selections a policy names
  // and whether it is restricted to free ones; the V0-only parameter refused
  // the v1 policy that live runs actually pass.
  policy: FailoverPolicy | FailoverPolicyV1,
  available: readonly FailoverCandidate[],
  current?: ModelRouteSelection,
): FailoverCandidate[] {
  const availableByKey = new Map(available.map((candidate) => [selectionKey(candidate), candidate]));
  return policy.candidates.flatMap((saved) => {
    const live = availableByKey.get(selectionKey(saved));
    if (!live?.connected || (current && selectionKey(live) === selectionKey(current))) return [];
    if ("freeOnly" in policy && policy.freeOnly && live.cost !== "free") return [];
    return [live];
  });
}

export function failoverDecision(
  policy: FailoverPolicy,
  available: readonly FailoverCandidate[],
  current: ModelRouteSelection,
): FailoverDecision {
  if (policy.mode === "off") return { action: "stop", reason: "disabled" };
  const candidates = eligibleFailoverCandidates(policy, available, current);
  if (candidates.length === 0) return { action: "stop", reason: "no_candidate" };
  if (policy.mode === "ask") return { action: "ask", candidates };
  return { action: "switch", candidate: candidates[0]! };
}

export function parseFailoverPolicy(text: string, catalog: readonly FailoverCandidate[]): FailoverPolicy {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const mode = words.shift()?.toLowerCase();
  if (mode === "off") return defaultFailoverPolicy();
  if (mode !== "ask" && mode !== "auto") throw new Error("usage: failover <off|ask|auto> [free-only] <route/model>...");
  const freeOnly = words[0]?.toLowerCase() === "free-only";
  if (freeOnly) words.shift();
  const byName = new Map(catalog.map((candidate) => [`${candidate.route}/${candidate.model}`, candidate]));
  const candidates = words.map((word) => {
    const candidate = byName.get(word);
    if (!candidate) throw new Error(`unknown failover candidate ${word}`);
    return candidate;
  });
  if (candidates.length === 0) throw new Error("failover requires at least one explicit route/model candidate");
  return { mode, ...(freeOnly ? { freeOnly: true } : {}), candidates };
}

export function selectionKey(selection: ModelRouteSelection): string {
  return `${selection.route}\0${selection.model}`;
}

function costAllowed(policy: FailoverCostPolicyV1, cost: ModelCost): boolean {
  if (policy === "free_only") return cost === "free";
  if (policy === "subscription_and_free") return cost === "free" || cost === "subscription";
  return cost !== "unknown";
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
  fallback: T[number],
): T[number] {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T[number])) throw new Error(`unsupported failover ${label}`);
  return value as T[number];
}

function publicRouteId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} is not a public route id`);
  }
  assertNoSecrets(value);
  if (containsPrivateInfrastructure(value)) throw new Error(`${label} contains private infrastructure`);
  return value;
}

function publicModelId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/.test(value)) {
    throw new Error(`${label} is not a public model id`);
  }
  if (looksLikeEndpoint(value)) throw new Error(`${label} is an endpoint, not a public model id`);
  assertNoSecrets(value);
  if (containsPrivateInfrastructure(value)) throw new Error(`${label} contains private infrastructure`);
  return value;
}

function looksLikeEndpoint(value: string): boolean {
  if (/^(?:https?|wss?|file|ssh|tcp|udp):/i.test(value) || value.startsWith("//")) return true;
  const firstSegment = value.split("/", 1)[0] ?? value;
  if (/^(?:localhost|[^/:]+\.[A-Za-z]{2,})(?::\d+)?$/i.test(firstSegment)) return true;
  return /^[^/:]+:\d+$/.test(firstSegment);
}

function boundedNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function integerInRange(value: unknown, label: string, min: number, max: number): number {
  const number = boundedNumber(value, label, min, max);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function failureInput(value: unknown): ModelFailureInputV1 {
  if (value instanceof Error) {
    const structured = value as Error & {
      status?: unknown;
      statusCode?: unknown;
      retryAfterSeconds?: unknown;
    };
    const status = numericStatus(structured.status ?? structured.statusCode);
    const retryAfterSeconds = safeRetryAfter(structured.retryAfterSeconds) ?? headerRetryAfter(value);
    const code = errorCode(value);
    return {
      error: value,
      message: value.message,
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
      ...(status === undefined ? {} : { status }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: value };
  const input = value as ModelFailureInputV1;
  const nested = typeof input.error === "object" && input.error !== null
    ? input.error as { status?: unknown; statusCode?: unknown; code?: unknown; retryAfterSeconds?: unknown }
    : undefined;
  const status = numericStatus(input.status ?? nested?.status ?? nested?.statusCode);
  const retryAfterSeconds = safeRetryAfter(input.retryAfterSeconds ?? nested?.retryAfterSeconds)
    ?? headerRetryAfter(input.error) ?? headerRetryAfter(value);
  const code = input.code ?? nested?.code;
  return {
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(status === undefined ? {} : { status }),
    ...(typeof input.message === "string" ? { message: input.message } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(input.kind === "tool" || input.kind === "policy" || input.kind === "empty_completion"
      || input.kind === "output_truncated"
      ? { kind: input.kind }
      : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(input.retriesExhausted === true ? { retriesExhausted: true } : {}),
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * `Retry-After` off a failed response, in RFC 9110's two forms: delta-seconds
 * or an HTTP date. The adapters normalise their provider errors to carry
 * `status` and `headers`, so this reads the one header every HTTP provider
 * sends and knows nothing about which provider sent it. Only the number is
 * taken — no header text is retained, copied or recorded.
 */
function headerRetryAfter(carrier: unknown): number | undefined {
  const raw = headerValue(carrier, "retry-after");
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return safeRetryAfter(Number(trimmed));
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return undefined;
  return safeRetryAfter(Math.max(0, Math.ceil((when - Date.now()) / 1_000)));
}

/** A header from either shape an adapter hands back: a Headers instance or a
 * plain record. Names are compared case-insensitively, as HTTP requires. */
function headerValue(carrier: unknown, name: string): string | undefined {
  if (typeof carrier !== "object" || carrier === null) return undefined;
  const headers = (carrier as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value: unknown = (get as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function safeRetryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 604_800
    ? Math.floor(value)
    : undefined;
}

function numericStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}
