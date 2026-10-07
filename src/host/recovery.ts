import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { EventLog } from "./event-log.ts";
import { providerRetryDelayMs, providerRetrySchedule, type ModelFailureClass } from "./model-failover.ts";
import type { EventInput, EventRecord } from "./schema.ts";

export interface RecoveryOperation {
  readonly episodeId: string;
  readonly identityDigest: string;
  readonly inputDigest: string;
}
export interface RecoveryOperationInput {
  identity: string;
  /** Omit until the loop has the exact accepted safe input. */
  inputDigest?: string;
  deadlineMs?: number;
  maxAttempts?: number;
  maxRecoveryMs?: number;
}
export interface RecoveryAttemptGrant { readonly attempt: number; readonly revision: number; readonly dispatched?: boolean }
export interface RecoveryEpisode extends RecoveryOperation {
  identity: string;
  policyDigest: string;
  revision: number;
  state: "active" | "waiting" | "exhausted" | "completed";
  begunAt: number;
  lastClockAt: number;
  elapsedMs: number;
  deadlineMs?: number;
  recoveryDeadline?: number;
  maxRecoveryMs: number;
  maxAttempts: number;
  effectiveMaxAttempts: number;
  effectiveDeadlineMs?: number;
  effectiveRecoveryDeadline: number;
  attempts: number;
  dispatches: number;
  failures: number;
  lastFailureAt?: number;
  retryAfterMs?: number;
  dueAt?: number;
  inFlight?: RecoveryAttemptGrant;
  reason?: string;
  waitMs: number;
  tokens: number | null;
  cost: number | null;
}
export class RecoveryTerminalError extends Error {
  readonly code = "DOKKABI_RECOVERY_TERMINAL";
  constructor(readonly reason: string, readonly operation?: RecoveryOperation) {
    super(`recovery terminal: ${reason}`);
    this.name = "RecoveryTerminalError";
  }
}
export function isRecoveryTerminalError(error: unknown): boolean {
  return error instanceof RecoveryTerminalError || (error as { code?: unknown } | null)?.code === "DOKKABI_RECOVERY_TERMINAL";
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** A pure projection: all waits, reservations and limits come from retained rows. */
export function foldRecoveryEpisodes(events: readonly EventRecord[]): RecoveryEpisode[] {
  const episodes = new Map<string, RecoveryEpisode>();
  const bySeq = new Map(events.map(event => [event.seq, event]));
  for (const event of events) {
    if (!event.name.startsWith("recovery/")) continue;
    const p = event.payload;
    if (event.name === "recovery/begin") {
      const episode = p.episode as RecoveryEpisode;
      if (!episode || episodes.has(episode.episodeId) || episode.revision !== 1
        || typeof episode.identity !== "string" || episode.identityDigest !== digest(episode.identity)
        || !/^[a-f0-9]{64}$/.test(episode.inputDigest) || !/^[a-f0-9]{64}$/.test(episode.identityDigest)
        || episode.episodeId !== digest({ identityDigest: episode.identityDigest, inputDigest: episode.inputDigest })
        || episode.policyDigest !== policyDigest(episode)
        || episode.lastClockAt !== episode.begunAt || episode.elapsedMs !== 0
        || episode.tokens !== 0 || episode.cost !== 0 || episode.inFlight !== undefined || episode.reason !== undefined || episode.dueAt !== undefined
        || episode.state !== "active" || episode.attempts !== 0 || episode.dispatches !== 0 || episode.failures !== 0 || episode.waitMs !== 0
        || !Number.isInteger(episode.maxAttempts) || episode.maxAttempts < 1 || episode.maxAttempts > 64
        || !Number.isFinite(episode.begunAt) || !Number.isFinite(episode.maxRecoveryMs) || episode.maxRecoveryMs <= 0 || episode.maxRecoveryMs > 1_800_000
        || episode.effectiveMaxAttempts !== episode.maxAttempts || episode.effectiveDeadlineMs !== episode.deadlineMs || episode.effectiveRecoveryDeadline !== episode.recoveryDeadline
        || episode.recoveryDeadline !== episode.begunAt + episode.maxRecoveryMs
        || (episode.deadlineMs !== undefined && (!Number.isFinite(episode.deadlineMs) || episode.maxRecoveryMs > Math.max(0, episode.deadlineMs - episode.begunAt) * .1))) throw new Error("invalid recovery begin");
      episodes.set(episode.episodeId, structuredClone(episode));
      continue;
    }
    const episode = episodes.get(String(p.episode_id));
    if (!episode || p.revision !== episode.revision + 1) throw new Error("invalid recovery revision");
    if (!Number.isFinite(p.clock_at) || Number(p.clock_at) < episode.lastClockAt) throw new Error("invalid recovery clock");
    episode.lastClockAt = Number(p.clock_at);
    episode.elapsedMs = Math.max(episode.elapsedMs, episode.lastClockAt - episode.begunAt);
    episode.revision += 1;
    if (event.name === "recovery/narrow") {
      if (!Number.isInteger(p.max_attempts) || Number(p.max_attempts) < 0 || Number(p.max_attempts) > episode.effectiveMaxAttempts
        || (p.deadline_ms !== null && (!Number.isFinite(p.deadline_ms) || Number(p.deadline_ms) > (episode.effectiveDeadlineMs ?? Infinity)))
        || (p.deadline_ms === null && episode.effectiveDeadlineMs !== undefined)
        || !Number.isFinite(p.recovery_deadline) || Number(p.recovery_deadline) > episode.effectiveRecoveryDeadline) throw new Error("invalid recovery narrowing");
      episode.effectiveMaxAttempts = Number(p.max_attempts);
      episode.effectiveDeadlineMs = p.deadline_ms === null ? undefined : Number(p.deadline_ms);
      episode.effectiveRecoveryDeadline = Number(p.recovery_deadline);
    } else if (event.name === "recovery/attempt") {
      if (episode.inFlight || episode.state !== "active" || episode.attempts >= episode.effectiveMaxAttempts || Number(p.clock_at) >= effectiveDeadline(episode) || p.attempt !== episode.attempts + 1) throw new Error("invalid recovery attempt");
      episode.attempts += 1;
      episode.inFlight = { attempt: episode.attempts, revision: episode.revision };
    } else if (event.name === "recovery/blocked") {
      if (!episode.inFlight || p.reason !== "reconciliation_required") throw new Error("invalid recovery block");
      episode.reason = "reconciliation_required";
    } else if (event.name === "recovery/dispatch") {
      const request = p.request as { seq?: number; hash?: string } | undefined;
      const recorded = request?.seq === undefined ? undefined : bySeq.get(request.seq);
      if (episode.attempts > episode.effectiveMaxAttempts || Number(p.clock_at) + 1_000 >= effectiveDeadline(episode) || !episode.inFlight || episode.inFlight.attempt !== p.attempt || episode.inFlight.dispatched || !recorded || recorded.name !== "provider/request" || recorded.hash !== request?.hash || recorded.seq >= event.seq) throw new Error("invalid recovery dispatch");
      episode.inFlight = { ...episode.inFlight, dispatched: true };
      episode.dispatches += 1;
    } else if (event.name === "recovery/result" || event.name === "recovery/reconcile") {
      if (!episode.inFlight || p.attempt !== episode.inFlight.attempt) throw new Error("invalid recovery result");
      if (event.name === "recovery/reconcile" && (!/^[a-f0-9]{64}$/.test(String(p.evidence_digest)) || !["no_effect", "settled", "unknown"].includes(String(p.outcome)))) throw new Error("invalid recovery reconciliation");
      if (event.name === "recovery/reconcile" && p.outcome === "unknown") episode.reason = "reconciliation_required";
      else { delete episode.inFlight; delete episode.reason; }
      episode.tokens = addUsage(episode.tokens, p.tokens);
      episode.cost = addUsage(episode.cost, p.cost);
    } else if (event.name === "recovery/failure") {
      if (!episode.inFlight || p.attempt !== episode.inFlight.attempt) throw new Error("invalid recovery failure");
      delete episode.inFlight;
      delete episode.reason;
      episode.failures += 1;
      if (p.recovery_deadline !== episode.recoveryDeadline || p.failed_at !== p.clock_at || !Number.isFinite(p.failed_at) || !Number.isFinite(p.retry_after_ms) || Number(p.retry_after_ms) < 0) throw new Error("invalid recovery failure clock");
      episode.lastFailureAt = Number(p.failed_at);
      episode.retryAfterMs = Number(p.retry_after_ms);
      episode.tokens = addUsage(episode.tokens, p.tokens);
      episode.cost = addUsage(episode.cost, p.cost);
    } else if (event.name === "recovery/wait") {
      if (episode.state !== "active" || episode.inFlight || episode.lastFailureAt === undefined
        || !Number.isFinite(p.due_at) || !Number.isFinite(p.delay_ms)
        || Number(p.delay_ms) < (episode.retryAfterMs ?? 0)
        || Number(p.due_at) !== episode.lastFailureAt + Number(p.delay_ms)
        || Number(p.due_at) + 1_000 >= effectiveDeadline(episode)) throw new Error("invalid recovery wait");
      episode.state = "waiting";
      episode.dueAt = Number(p.due_at);
      episode.waitMs += Number(p.delay_ms);
    } else if (event.name === "recovery/wake") {
      if (episode.state !== "waiting" || !Number.isFinite(p.woke_at) || Number(p.woke_at) > Number(p.clock_at) || Number(p.clock_at) < (episode.dueAt ?? Infinity) || Number(p.woke_at) < (episode.dueAt ?? Infinity)) throw new Error("invalid recovery wake");
      episode.state = "active";
      delete episode.dueAt;
    } else if (event.name === "recovery/exhausted") {
      if (episode.state === "completed" || episode.inFlight) throw new Error("invalid recovery exhaustion");
      if (typeof p.due_at === "number") episode.dueAt = p.due_at;
      episode.state = "exhausted";
      episode.reason = String(p.reason);
    } else if (event.name === "recovery/completed") {
      if (episode.inFlight || episode.state !== "active" || episode.reason) throw new Error("inflight recovery completion");
      episode.state = "completed";
    } else throw new Error("unknown recovery event");
  }
  return [...episodes.values()];
}
function policyDigest(state: Pick<RecoveryEpisode, "maxRecoveryMs" | "maxAttempts" | "begunAt" | "deadlineMs" | "recoveryDeadline">): string {
  return digest({ format: 1, maxRecoveryMs: state.maxRecoveryMs, maxAttempts: state.maxAttempts, begunAt: state.begunAt, deadlineMs: state.deadlineMs ?? null, recoveryDeadline: state.recoveryDeadline });
}
function effectiveDeadline(state: RecoveryEpisode): number { return Math.min(state.effectiveDeadlineMs ?? Infinity, state.effectiveRecoveryDeadline); }
function addUsage(previous: number | null, value: unknown): number | null {
  return previous !== null && typeof value === "number" && Number.isFinite(value) && value >= 0 ? previous + value : null;
}
interface Scope { input: RecoveryOperationInput; token?: RecoveryOperation; signal?: AbortSignal }
export class DurableRecoveryService {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly now: () => number;
  private readonly waiter: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(private readonly log: EventLog, options: { now?: () => number; monotonicNow?: () => number; waiter?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}) {
    const wall = options.now ?? Date.now;
    const monotonic = options.monotonicNow ?? (options.now ? undefined : () => performance.now());
    const startedAt = wall(), tick = monotonic?.() ?? 0;
    this.now = () => Math.floor(Math.max(wall(), startedAt + (monotonic ? monotonic() - tick : 0)));
    this.waiter = options.waiter ?? abortableWait;
  }
  episodes(): RecoveryEpisode[] { return foldRecoveryEpisodes(this.log.events); }
  current(): RecoveryOperation | undefined { return this.scope.getStore()?.token; }
  currentInput(): RecoveryOperationInput | undefined { return this.scope.getStore()?.input; }
  withOperation<T>(input: RecoveryOperationInput, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.scope.run({ input, signal }, run);
  }
  bind(inputDigest: string, continuation = false): RecoveryOperation | undefined {
    const scope = this.scope.getStore();
    if (!scope) return undefined;
    if (!scope.token && continuation) {
      this.log.refresh();
      const retained = this.episodes().find(episode => episode.identityDigest === digest(scope.input.identity));
      if (!retained && !scope.input.inputDigest) throw new RecoveryTerminalError("resume_episode_missing");
      scope.token = this.begin({ ...scope.input, inputDigest: retained?.inputDigest ?? scope.input.inputDigest! });
    }
    if (scope.token && !continuation && scope.token.inputDigest !== inputDigest) throw new RecoveryTerminalError("input_mismatch", scope.token);
    if (!scope.token && scope.input.inputDigest !== undefined && scope.input.inputDigest !== inputDigest) throw new RecoveryTerminalError("input_mismatch");
    if (!scope.token) scope.token = this.begin({ ...scope.input, inputDigest: scope.input.inputDigest ?? inputDigest });
    return scope.token;
  }
  begin(input: RecoveryOperationInput & { inputDigest: string }): RecoveryOperation {
    if (!/^[a-f0-9]{64}$/.test(input.inputDigest)) throw new RecoveryTerminalError("invalid_input_digest");
    const identityDigest = digest(input.identity);
    let token!: RecoveryOperation;
    let refusal: string | undefined;
    this.transaction(() => {
      if ((input.deadlineMs !== undefined && !Number.isFinite(input.deadlineMs)) || (input.maxAttempts !== undefined && (!Number.isFinite(input.maxAttempts) || input.maxAttempts < 0)) || (input.maxRecoveryMs !== undefined && (!Number.isFinite(input.maxRecoveryMs) || input.maxRecoveryMs <= 0))) throw new RecoveryTerminalError("invalid_limits");
      const existing = this.episodes().find((episode) => episode.identityDigest === identityDigest);
      if (existing) {
        token = existing;
        if (existing.inputDigest !== input.inputDigest) { refusal = "input_mismatch"; return []; }
        const maxAttempts = Math.min(existing.effectiveMaxAttempts, Math.floor(input.maxAttempts ?? Infinity));
        const deadlineMs = Math.min(existing.effectiveDeadlineMs ?? Infinity, input.deadlineMs ?? Infinity);
        const recoveryDeadline = Math.min(existing.effectiveRecoveryDeadline, existing.begunAt + (input.maxRecoveryMs ?? Infinity));
        if (maxAttempts === existing.effectiveMaxAttempts && deadlineMs === (existing.effectiveDeadlineMs ?? Infinity) && recoveryDeadline === existing.effectiveRecoveryDeadline) return [];
        return [this.row(existing, "narrow", { max_attempts: maxAttempts, deadline_ms: Number.isFinite(deadlineMs) ? deadlineMs : null, recovery_deadline: recoveryDeadline })];
      }
      const now = this.now();
      if ((input.deadlineMs !== undefined && !Number.isFinite(input.deadlineMs)) || (input.maxAttempts !== undefined && (!Number.isFinite(input.maxAttempts) || input.maxAttempts < 1)) || (input.maxRecoveryMs !== undefined && (!Number.isFinite(input.maxRecoveryMs) || input.maxRecoveryMs <= 0))) throw new RecoveryTerminalError("invalid_limits");
      if (input.maxAttempts === 0) throw new RecoveryTerminalError("attempts");
      const remaining = input.deadlineMs === undefined ? Infinity : Math.max(0, input.deadlineMs - now);
      if (remaining <= 0) throw new RecoveryTerminalError("deadline");
      const maxRecoveryMs = Math.min(1_800_000, remaining * .1, input.maxRecoveryMs ?? Infinity);
      const episode: RecoveryEpisode = {
        episodeId: digest({ identityDigest, inputDigest: input.inputDigest }), identity: input.identity, identityDigest, inputDigest: input.inputDigest,
        policyDigest: "", revision: 1, state: "active", begunAt: now, lastClockAt: now, elapsedMs: 0,
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        maxRecoveryMs, recoveryDeadline: now + maxRecoveryMs, effectiveRecoveryDeadline: now + maxRecoveryMs,
        ...(input.deadlineMs === undefined ? {} : { effectiveDeadlineMs: input.deadlineMs }),
        effectiveMaxAttempts: Math.min(64, Math.max(1, Math.floor(input.maxAttempts ?? 64))),
        maxAttempts: Math.min(64, Math.max(1, Math.floor(input.maxAttempts ?? 64))),
        attempts: 0, dispatches: 0, failures: 0, waitMs: 0, tokens: 0, cost: 0,
      };
      episode.policyDigest = policyDigest(episode);
      token = episode;
      return [{ kind: "observe", name: "recovery/begin", payload: { episode } }];
    });
    if (refusal) throw new RecoveryTerminalError(refusal, token);
    return this.token(token);
  }
  snapshot(token: RecoveryOperation): RecoveryEpisode {
    const state = this.episodes().find((episode) => episode.episodeId === token.episodeId);
    if (!state || state.inputDigest !== token.inputDigest || state.identityDigest !== token.identityDigest) throw new RecoveryTerminalError("operation_mismatch", token);
    return state;
  }
  reserve(token: RecoveryOperation): RecoveryAttemptGrant {
    let grant!: RecoveryAttemptGrant;
    let refusal: string | undefined;
    this.transaction(() => {
      const state = this.snapshot(token);
      refusal = this.stopReason(state);
      if (refusal === "reconciliation_required" && state.inFlight) return [this.row(state, "blocked", { reason: refusal })];
      if (refusal) return state.state === "exhausted" || refusal === "reconciliation_required" || refusal === "waiting" || refusal === "completed" ? [] : [this.row(state, "exhausted", { reason: refusal })];
      grant = { attempt: state.attempts + 1, revision: state.revision + 1 };
      return [this.row(state, "attempt", { attempt: grant.attempt, granted_at: this.now() })];
    });
    if (refusal) throw new RecoveryTerminalError(refusal, token);
    return Object.freeze(grant);
  }
  dispatch(token: RecoveryOperation, grant: RecoveryAttemptGrant, request: { seq: number; hash: string }): void {
    let refusal: string | undefined;
    this.transaction(() => {
      const state = this.snapshot(token); this.assertGrant(state, grant);
      if (state.inFlight?.dispatched) throw new RecoveryTerminalError("duplicate_dispatch", token);
      if (state.attempts > state.effectiveMaxAttempts || this.now() + 1_000 >= effectiveDeadline(state)) {
        refusal = state.attempts > state.effectiveMaxAttempts ? "attempts" : "deadline";
        return [this.row(state, "result", { attempt: grant.attempt, tokens: 0, cost: 0 }), this.row({ ...state, revision: state.revision + 1 }, "exhausted", { reason: refusal })];
      }
      return [this.row(state, "dispatch", { attempt: grant.attempt, request })];
    });
    if (refusal) throw new RecoveryTerminalError(refusal, token);
  }
  exhaust(token: RecoveryOperation, reason: string): never {
    this.transaction(() => { const state = this.snapshot(token); if (state.inFlight) throw new RecoveryTerminalError("reconciliation_required", token); return state.state === "exhausted" ? [] : [this.row(state, "exhausted", { reason })]; });
    throw new RecoveryTerminalError(reason, token);
  }
  result(token: RecoveryOperation, grant: RecoveryAttemptGrant, usage: { tokens?: number; cost?: number } = {}): void {
    this.transaction(() => { const state = this.snapshot(token); this.assertGrant(state, grant); return [this.row(state, "result", { attempt: grant.attempt, tokens: usage.tokens ?? null, cost: usage.cost ?? null })]; });
  }
  /** Only the owner with external evidence may reconcile a lost reservation. Unknown blocks further effects. */
  reconcile(token: RecoveryOperation, grant: RecoveryAttemptGrant, outcome: "no_effect" | "settled" | "unknown", evidenceDigest: string): void {
    if (!/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new RecoveryTerminalError("invalid_reconciliation_evidence", token);
    this.transaction(() => { const state = this.snapshot(token); this.assertGrant(state, grant); return [this.row(state, "reconcile", { attempt: grant.attempt, outcome, evidence_digest: evidenceDigest, tokens: null, cost: null })]; });
  }
  failure(token: RecoveryOperation, grant: RecoveryAttemptGrant, failure: { class: ModelFailureClass; retryAfterMs?: number; retry?: boolean }): { attempt: number; delayMs: number } {
    let result!: { attempt: number; delayMs: number };
    let refusal: string | undefined;
    this.transaction(() => {
      const state = this.snapshot(token); this.assertGrant(state, grant);
      const now = Math.max(this.now(), state.lastClockAt);
      const recoveryDeadline = state.recoveryDeadline!;
      const schedule = providerRetrySchedule(failure.class);
      const rung = schedule ? providerRetryDelayMs(schedule, state.failures + 1) : 0;
      const floor = typeof failure.retryAfterMs === "number" && Number.isFinite(failure.retryAfterMs) ? Math.max(0, failure.retryAfterMs) : 0;
      const delayMs = Math.max(rung, floor);
      const dueAt = now + delayMs;
      refusal = state.attempts >= state.effectiveMaxAttempts ? "attempts" : dueAt + 1_000 >= effectiveDeadline(state) ? "deadline" : undefined;
      const failed = this.row(state, "failure", { attempt: grant.attempt, class: failure.class, clock_at: now, recovery_deadline: recoveryDeadline, failed_at: now, retry_after_ms: floor, tokens: null, cost: null });
      const next = { ...state, revision: state.revision + 1 };
      result = { attempt: state.attempts, delayMs };
      if (!refusal && (!schedule || failure.retry === false)) return [failed];
      return [failed, this.row(next, refusal ? "exhausted" : "wait", refusal ? { reason: refusal, due_at: dueAt, retry_after_ms: floor } : { due_at: dueAt, delay_ms: delayMs, ...(floor > 0 ? { retry_after_ms: floor } : {}) })];
    });
    if (refusal) throw new RecoveryTerminalError(refusal, token);
    return result;
  }
  async wait(token: RecoveryOperation, signal?: AbortSignal): Promise<void> {
    if (this.log.isReadOnly) throw new RecoveryTerminalError("read_only", token);
    const scopedSignal = this.scope.getStore()?.signal;
    if (scopedSignal) signal = signal ? AbortSignal.any([signal, scopedSignal]) : scopedSignal;
    for (;;) {
      this.log.refresh();
      const state = this.snapshot(token);
      if (this.now() < state.lastClockAt) {
        this.transaction(() => { const current = this.snapshot(token); return current.inFlight || current.state === "exhausted" ? [] : [this.row(current, "exhausted", { reason: "clock_regressed" })]; });
        throw new RecoveryTerminalError("clock_regressed", token);
      }
      if (signal?.aborted) throw new Error("recovery wait aborted");
      if (state.state === "exhausted") throw new RecoveryTerminalError(state.reason ?? "exhausted", token);
      if (state.state !== "waiting") return;
      if ((state.dueAt ?? Infinity) + 1_000 >= effectiveDeadline(state) || state.attempts >= state.effectiveMaxAttempts) this.exhaust(token, state.attempts >= state.effectiveMaxAttempts ? "attempts" : "deadline");
      const remaining = Math.max(0, (state.dueAt ?? 0) - this.now());
      if (signal?.aborted) throw new Error("recovery wait aborted");
      if (remaining > 0) { await this.waiter(Math.min(remaining, 60_000), signal); continue; }
      this.transaction(() => { const current = this.snapshot(token); return current.state === "waiting" && (current.dueAt ?? 0) <= this.now() ? [this.row(current, "wake", { woke_at: this.now() })] : []; });
      return;
    }
  }
  complete(token: RecoveryOperation): void {
    this.transaction(() => { const state = this.snapshot(token); if (state.state === "completed") return []; if (state.state !== "active" || state.inFlight || state.reason) throw new RecoveryTerminalError("unsettled_completion", token); return [this.row(state, "completed", {})]; });
  }
  private stopReason(state: RecoveryEpisode): string | undefined {
    if (this.now() < state.lastClockAt) return "clock_regressed";
    if (state.state === "exhausted") return state.reason ?? "exhausted";
    if (state.state === "completed") return "completed";
    if (state.inFlight || state.reason === "reconciliation_required") return "reconciliation_required";
    if (state.state === "waiting") return "waiting";
    if (this.now() >= effectiveDeadline(state)) return "deadline";
    if (state.attempts >= state.effectiveMaxAttempts) return "attempts";
    return undefined;
  }
  private assertGrant(state: RecoveryEpisode, grant: RecoveryAttemptGrant): void {
    if (state.inFlight?.attempt !== grant.attempt || state.inFlight?.revision !== grant.revision) throw new RecoveryTerminalError("stale_grant", state);
  }
  private row(state: RecoveryEpisode, action: string, payload: Record<string, unknown>): EventInput {
    return { kind: "observe", name: `recovery/${action}`, payload: { episode_id: state.episodeId, revision: state.revision + 1, clock_at: Math.max(this.now(), state.lastClockAt), ...payload } };
  }
  private token(state: RecoveryOperation): RecoveryOperation { return Object.freeze({ episodeId: state.episodeId, identityDigest: state.identityDigest, inputDigest: state.inputDigest }); }
  private transaction(build: () => readonly EventInput[]): void {
    if (this.log.isReadOnly) throw new RecoveryTerminalError("read_only");
    let error: unknown;
    this.log.appendBatchDurable(() => { try { return build(); } catch (caught) { error = caught; return []; } });
    if (error !== undefined) throw error;
  }
}
function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("recovery wait aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
