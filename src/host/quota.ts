import { createHash } from "node:crypto";
import type {
  ModelQuota,
  ModelQuotaSnapshot,
  ModelQuotaSnapshotV1,
  ModelQuotaWindow,
  QuotaConfidence,
  QuotaScopeV1,
  QuotaWindowV1,
} from "./schema.ts";
import { assertNoSecrets } from "./redact.ts";

/** Shape of `account/rateLimits/read` from `codex app-server`. */
export interface RateLimitEntry {
  limitId?: string;
  limitName?: string | null;
  primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
  secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
}

export interface RateLimitsRpc {
  rateLimits?: RateLimitEntry;
  rateLimitsByLimitId?: Record<string, RateLimitEntry>;
}

/** The weekly window in minutes (7 days). */
const WEEK_MINS = 10_080;

export interface QuotaSelection {
  route: string;
  provider: string;
  model: string;
}

export interface QuotaProbe {
  readonly id: string;
  supports(selection: QuotaSelection): boolean;
  read(selection: QuotaSelection): Promise<ModelQuotaSnapshot | undefined>;
}

/** Owner-neutral probe registry. Provider adapters register here; the model
 * loop only asks for a selection and contains no provider branch. */
export class QuotaProbeRegistry {
  readonly #probes = new Map<string, QuotaProbe>();

  register(probe: QuotaProbe): () => void {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(probe.id)) throw new Error("quota probe id must be public metadata");
    assertNoSecrets(probe.id);
    if (this.#probes.has(probe.id)) throw new Error(`duplicate quota probe ${probe.id}`);
    this.#probes.set(probe.id, probe);
    return () => {
      if (this.#probes.get(probe.id) === probe) this.#probes.delete(probe.id);
    };
  }

  async read(selection: QuotaSelection): Promise<ModelQuotaSnapshot | undefined> {
    const probe = this.probe(selection);
    return probe?.read(selection);
  }

  probeId(selection: QuotaSelection): string | undefined {
    return this.probe(selection)?.id;
  }

  private probe(selection: QuotaSelection): QuotaProbe | undefined {
    return [...this.#probes.values()].find((candidate) => candidate.supports(selection));
  }
}

export type QuotaFreshnessV1 = "fresh" | "stale" | "unknown";

export interface QuotaStatusV1 {
  selection: QuotaSelection;
  freshness: QuotaFreshnessV1;
  snapshot?: ModelQuotaSnapshotV1;
}

interface QuotaTrackerOptions {
  ttlMs?: number;
  backoffMs?: number;
  now?: () => number;
}

/** Cache and concurrency owner for quota probes. Probe failures never block a
 * model request and never turn local observations into provider capacity. */
export class QuotaTracker {
  readonly #cache = new Map<string, ModelQuotaSnapshotV1>();
  readonly #inflight = new Map<string, Promise<QuotaStatusV1>>();
  readonly #retryAt = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #backoffMs: number;
  readonly #now: () => number;

  constructor(readonly registry: QuotaProbeRegistry, options: QuotaTrackerOptions = {}) {
    this.#ttlMs = boundedDuration(options.ttlMs, 10 * 60 * 1000);
    this.#backoffMs = boundedDuration(options.backoffMs, 60 * 1000);
    this.#now = options.now ?? Date.now;
  }

  peek(selection: QuotaSelection): QuotaStatusV1 {
    const snapshot = this.#cache.get(quotaSelectionKey(selection));
    return snapshot
      ? { selection: { ...selection }, snapshot, freshness: quotaSnapshotFreshness(snapshot, this.#now()) }
      : { selection: { ...selection }, freshness: "unknown" };
  }

  async refresh(selection: QuotaSelection, options: { force?: boolean } = {}): Promise<QuotaStatusV1> {
    const safe = normalizeQuotaSelection(selection);
    const key = quotaSelectionKey(safe);
    const now = this.#now();
    const cached = this.#cache.get(key);
    if (!options.force && cached && quotaSnapshotFreshness(cached, now) === "fresh") {
      return { selection: safe, snapshot: cached, freshness: "fresh" };
    }
    const active = this.#inflight.get(key);
    if (active) return active;
    if (!options.force && now < (this.#retryAt.get(key) ?? 0)) {
      return cached
        ? { selection: safe, snapshot: cached, freshness: quotaSnapshotFreshness(cached, now) }
        : { selection: safe, freshness: "unknown" };
    }
    const pending = this.#read(safe, cached, now).finally(() => {
      if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
    });
    this.#inflight.set(key, pending);
    return pending;
  }

  async #read(
    selection: QuotaSelection,
    cached: ModelQuotaSnapshotV1 | undefined,
    now: number,
  ): Promise<QuotaStatusV1> {
    const key = quotaSelectionKey(selection);
    try {
      const raw = await this.registry.read(selection);
      if (!raw) throw new Error("quota unavailable");
      const snapshot = normalizeQuotaSnapshotV1(raw, selection, now, this.#ttlMs);
      this.#cache.set(key, snapshot);
      this.#retryAt.delete(key);
      return { selection, snapshot, freshness: quotaSnapshotFreshness(snapshot, now) };
    } catch {
      this.#retryAt.set(key, now + this.#backoffMs);
      return cached
        ? { selection, snapshot: cached, freshness: quotaSnapshotFreshness(cached, now) }
        : { selection, freshness: "unknown" };
    }
  }
}

function windowId(minutes: number): ModelQuotaWindow["id"] {
  if (minutes === 300) return "5h";
  if (minutes === 1_440) return "day";
  if (minutes === WEEK_MINS) return "week";
  return minutes > 0 ? `${minutes}m` : "unknown";
}

function quotaWindow(value: RateLimitEntry["primary"]): ModelQuotaWindow | undefined {
  if (!value || !validPercent(value.usedPercent)) return undefined;
  const duration = value.windowDurationMins ?? 0;
  return {
    id: windowId(duration),
    duration_minutes: duration > 0 ? duration : "missing",
    used_percent: value.usedPercent,
    remaining_percent: 100 - value.usedPercent,
    ...(value.resetsAt ? { resets_at: new Date(value.resetsAt * 1000).toISOString() } : {}),
  };
}

function quotaWindowV1(value: RateLimitEntry["primary"]): QuotaWindowV1 | undefined {
  if (!value || !validPercent(value.usedPercent)) return undefined;
  const duration = typeof value.windowDurationMins === "number" && value.windowDurationMins > 0
    ? value.windowDurationMins
    : undefined;
  const used = value.usedPercent;
  const resetsAt = validReset(value.resetsAt);
  return {
    id: duration === undefined ? "unknown" : windowId(duration),
    duration_minutes: duration ?? "missing",
    used_percent: used,
    remaining_percent: 100 - used,
    kind: "rolling",
    durationSeconds: duration === undefined ? "missing" : duration * 60,
    used,
    limit: 100,
    remaining: 100 - used,
    usedPercent: used,
    resetsAt,
    source: "provider_api",
    confidence: "authoritative",
    ...(resetsAt === "missing" ? {} : { resets_at: resetsAt }),
  };
}

function quotaBucket(value: string | undefined): ModelQuotaSnapshot["bucket"] {
  if (!value) return "missing";
  return `pool-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Convert all windows for the model's provider bucket. Missing telemetry
 * returns undefined rather than an invented 100% remaining snapshot. */
export function quotaSnapshotFromRpc(
  rpc: RateLimitsRpc,
  selection: QuotaSelection,
  observedAt = new Date().toISOString(),
): ModelQuotaSnapshotV1 | undefined {
  const staleAfter = new Date(Date.parse(observedAt) + 10 * 60 * 1000).toISOString();
  return quotaSnapshotV1FromRpc(rpc, selection, observedAt, staleAfter);
}

/** Convert the allowlisted numeric/time fields from Codex app-server. Raw
 * bucket/account values are reduced to a digest before leaving this function. */
export function quotaSnapshotV1FromRpc(
  rpc: RateLimitsRpc,
  selection: QuotaSelection,
  observedAt = new Date().toISOString(),
  staleAfter = new Date(Date.parse(observedAt) + 10 * 60 * 1000).toISOString(),
): ModelQuotaSnapshotV1 | undefined {
  const keyed = Object.entries(rpc.rateLimitsByLimitId ?? {});
  const needle = selection.model.toLowerCase();
  const named =
    keyed.find(([, entry]) => (entry.limitName ?? "").toLowerCase() === needle) ??
    keyed.find(([, entry]) => {
      const name = (entry.limitName ?? "").toLowerCase();
      return name.length > 0 && needle.includes(name);
    });
  const chosenKey = named?.[0];
  const chosen = named?.[1] ?? rpc.rateLimits ?? keyed[0]?.[1];
  if (!chosen) return undefined;
  const windows = [quotaWindowV1(chosen.primary), quotaWindowV1(chosen.secondary)]
    .filter((window): window is QuotaWindowV1 => window !== undefined);
  if (windows.length === 0) return undefined;
  const bucketDigest = quotaBucket(chosen.limitId ?? chosenKey);
  return {
    format: 1,
    provider: selection.provider,
    route: selection.route,
    model: selection.model,
    scope: selection.provider === "openai-codex" ? "subscription" : "unknown",
    bucketDigest,
    bucket: bucketDigest,
    confidence: "authoritative",
    observedAt,
    observed_at: observedAt,
    staleAfter,
    windows,
  };
}

export function quotaSnapshotFreshness(
  snapshot: ModelQuotaSnapshotV1 | undefined,
  now = Date.now(),
): QuotaFreshnessV1 {
  if (!snapshot) return "unknown";
  if (snapshot.staleAfter === "missing") return "stale";
  const deadline = Date.parse(snapshot.staleAfter);
  return Number.isFinite(deadline) && now < deadline ? "fresh" : "stale";
}

export function normalizeQuotaSnapshotV1(
  value: ModelQuotaSnapshot,
  selection: QuotaSelection,
  now = Date.now(),
  ttlMs = 10 * 60 * 1000,
): ModelQuotaSnapshotV1 {
  const input = value as ModelQuotaSnapshot & Partial<ModelQuotaSnapshotV1>;
  if (input.route !== selection.route || input.provider !== selection.provider || input.model !== selection.model) {
    throw new Error("quota probe returned a foreign selection");
  }
  const rawObservedAt = input.observedAt ?? input.observed_at;
  const observedAt = rawObservedAt === undefined
    ? new Date(now).toISOString()
    : validIso(rawObservedAt) ?? invalidQuotaTimestamp("observedAt");
  const rawStaleAfter = input.staleAfter;
  const staleAfter = rawStaleAfter === "missing"
    ? "missing"
    : rawStaleAfter === undefined
      ? new Date(Date.parse(observedAt) + ttlMs).toISOString()
      : validIso(rawStaleAfter) ?? invalidQuotaTimestamp("staleAfter");
  const bucketDigest = normalizeBucketDigest(input.bucketDigest ?? input.bucket);
  const scope = quotaScope(input.scope);
  if (!Array.isArray(input.windows) || input.windows.length === 0) {
    throw new Error("quota snapshot must contain at least one reported window");
  }
  const windows = input.windows.map((window) => normalizeQuotaWindowV1(window as ModelQuotaWindow & Partial<QuotaWindowV1>));
  const normalized: ModelQuotaSnapshotV1 = {
    format: 1,
    provider: selection.provider,
    route: selection.route,
    model: selection.model,
    scope,
    bucketDigest,
    bucket: bucketDigest,
    confidence: windows.every((window) => window.confidence === "authoritative") ? "authoritative" : "unknown",
    observedAt,
    observed_at: observedAt,
    staleAfter,
    windows,
  };
  assertNoSecrets(normalized);
  return normalized;
}

/**
 * Pick the quota entry for the active model: a limit whose limitName matches
 * the model wins; otherwise the primary codex limit. The window is reported
 * honestly (a daily limit is "day", the board never fakes a week).
 */
export function pickQuota(rpc: RateLimitsRpc, modelId: string): ModelQuota | undefined {
  const entries = Object.values(rpc.rateLimitsByLimitId ?? {});
  const needle = modelId.toLowerCase();
  const named =
    entries.find((entry) => (entry.limitName ?? "").toLowerCase() === needle) ??
    entries.find((entry) => needle.includes((entry.limitName ?? "").toLowerCase()) && (entry.limitName ?? "").length > 0);
  const chosen = named ?? rpc.rateLimits ?? entries[0];
  const primary = chosen?.primary;
  if (!primary || typeof primary.usedPercent !== "number") {
    return undefined;
  }
  const mins = primary.windowDurationMins ?? 0;
  return {
    window: mins === WEEK_MINS ? "week" : mins === 1440 ? "day" : "missing",
    used: primary.usedPercent,
    limit: 100,
    ...(primary.usedPercent !== undefined ? { used_percent: primary.usedPercent } : {}),
    ...(primary.resetsAt ? { resets_at: new Date(primary.resetsAt * 1000).toISOString() } : {}),
  };
}

/** The observe payload for a model_quota event. */
export function quotaEventFromRpc(quota: ModelQuota): ModelQuota {
  return {
    window: quota.window,
    used: quota.used,
    limit: quota.limit,
    ...(quota.used_percent !== undefined ? { used_percent: quota.used_percent } : {}),
    ...(quota.resets_at !== undefined ? { resets_at: quota.resets_at } : {}),
  };
}

function quotaSelectionKey(selection: QuotaSelection): string {
  return `${selection.route}\0${selection.provider}\0${selection.model}`;
}

function normalizeQuotaSelection(selection: QuotaSelection): QuotaSelection {
  for (const [label, value] of Object.entries(selection)) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`quota ${label} is invalid`);
    }
  }
  const normalized = { ...selection };
  assertNoSecrets(normalized);
  return normalized;
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? Math.floor(value)
    : fallback;
}

function validPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validReset(value: unknown): string | "missing" {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "missing";
  try {
    return new Date(value * 1000).toISOString();
  } catch {
    return "missing";
  }
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function invalidQuotaTimestamp(label: string): never {
  throw new Error(`quota snapshot ${label} is invalid`);
}

function quotaScope(value: unknown): QuotaScopeV1 {
  return value === "subscription" || value === "provider" || value === "project" || value === "model"
    ? value
    : "unknown";
}

function normalizeBucketDigest(value: unknown): string | "missing" {
  if (value === "missing" || value === undefined) return "missing";
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new Error("quota bucket digest is invalid");
  }
  if (/^pool-[0-9a-f]{12,64}$/i.test(value)) return value.toLowerCase();
  // A provider contribution may accidentally hand us an account/project
  // label. Keep only equality, never the label itself.
  return `pool-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function normalizeQuotaWindowV1(value: ModelQuotaWindow & Partial<QuotaWindowV1>): QuotaWindowV1 {
  const id = normalizeWindowId(value.id);
  const explicitDuration = metricValue(value.durationSeconds, "durationSeconds");
  const legacyDuration = metricValue(value.duration_minutes, "duration_minutes");
  const durationSeconds = explicitDuration ??
    (typeof legacyDuration === "number" ? legacyDuration * 60 : legacyDuration ?? "missing");
  const explicitUsedPercent = percentMetric(value.usedPercent, "usedPercent");
  const legacyUsedPercent = percentMetric(value.used_percent, "used_percent");
  if (
    typeof explicitUsedPercent === "number"
    && typeof legacyUsedPercent === "number"
    && !approximatelyEqual(explicitUsedPercent, legacyUsedPercent)
  ) {
    throw new Error("quota window used percentages are inconsistent");
  }
  let usedPercent = explicitUsedPercent ?? legacyUsedPercent ?? "missing";
  let remainingPercent = percentMetric(value.remaining_percent, "remaining_percent") ?? "missing";
  if (typeof usedPercent === "number" && typeof remainingPercent === "number") {
    if (!approximatelyEqual(usedPercent + remainingPercent, 100)) {
      throw new Error("quota window used and remaining percentages are inconsistent");
    }
  } else if (typeof usedPercent === "number") {
    remainingPercent = 100 - usedPercent;
  } else if (typeof remainingPercent === "number") {
    usedPercent = 100 - remainingPercent;
  }
  const source = value.source === "response_headers" || value.source === "local_meter" || value.source === "operator_policy"
    ? value.source
    : "provider_api";
  const confidence = value.confidence === "authoritative" || value.confidence === "observed" || value.confidence === "estimated"
    ? value.confidence
    : "unknown";
  const kind = value.kind === "calendar" || value.kind === "requests" || value.kind === "tokens" || value.kind === "credits"
    ? value.kind
    : value.kind === "unknown"
      ? "unknown"
      : "rolling";
  const canUsePercentAliases = kind === "rolling" || kind === "calendar";
  const used = metricValue(value.used, "used") ?? (canUsePercentAliases ? usedPercent : "missing");
  const limit = metricValue(value.limit, "limit") ??
    (canUsePercentAliases && typeof usedPercent === "number" ? 100 : "missing");
  const remaining = metricValue(value.remaining, "remaining") ??
    (canUsePercentAliases ? remainingPercent : "missing");
  validateQuotaArithmetic({ used, limit, remaining, usedPercent, remainingPercent, confidence });
  const resetsAt = value.resetsAt === "missing"
    ? "missing"
    : validIso(value.resetsAt ?? value.resets_at) ?? "missing";
  return {
    id,
    duration_minutes: typeof durationSeconds === "number" ? durationSeconds / 60 : "missing",
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    kind,
    durationSeconds,
    used,
    limit,
    remaining,
    usedPercent,
    resetsAt,
    source,
    confidence,
    ...(resetsAt === "missing" ? {} : { resets_at: resetsAt }),
  };
}

function normalizeWindowId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return "unknown";
  if (
    /^(?:5h|day|week|unknown|\d+m)$/i.test(value)
    || /^(?:rolling|calendar|requests|tokens|credits)(?:[-_.](?:minute|hour|day|week|month|year|\d+[mhdw]))?$/i.test(value)
  ) {
    return value.toLowerCase();
  }
  return `window-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function metricValue(value: unknown, label: string): number | "missing" | undefined {
  if (value === undefined) return undefined;
  if (value === "missing") return "missing";
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`quota window ${label} is invalid`);
}

function percentMetric(value: unknown, label: string): number | "missing" | undefined {
  const metric = metricValue(value, label);
  if (typeof metric === "number" && metric > 100) throw new Error(`quota window ${label} must be between 0 and 100`);
  return metric;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.01;
}

function validateQuotaArithmetic(input: {
  used: number | "missing";
  limit: number | "missing";
  remaining: number | "missing";
  usedPercent: number | "missing";
  remainingPercent: number | "missing";
  confidence: QuotaConfidence;
}): void {
  const { used, limit, remaining, usedPercent, remainingPercent, confidence } = input;
  if (typeof limit === "number") {
    if (typeof used === "number" && used > limit) throw new Error("quota window used exceeds limit");
    if (typeof remaining === "number" && remaining > limit) throw new Error("quota window remaining exceeds limit");
    if (
      typeof used === "number"
      && typeof remaining === "number"
      && !approximatelyEqual(used + remaining, limit)
    ) {
      throw new Error("quota window absolute metrics are inconsistent");
    }
  }
  if (confidence !== "authoritative" || typeof limit !== "number" || limit <= 0) return;
  if (
    typeof used === "number"
    && typeof usedPercent === "number"
    && !approximatelyEqual((used / limit) * 100, usedPercent)
  ) {
    throw new Error("quota window authoritative used percentage is inconsistent");
  }
  if (
    typeof remaining === "number"
    && typeof remainingPercent === "number"
    && !approximatelyEqual((remaining / limit) * 100, remainingPercent)
  ) {
    throw new Error("quota window authoritative remaining percentage is inconsistent");
  }
}

/**
 * Spawn `codex app-server` over stdio, initialize, and read
 * account/rateLimits/read. stdin stays open until the response lands (EOF
 * shuts the server down before it answers).
 */
export async function readCodexQuota(codexBin: string, timeoutMs = 8000, args: string[] = ["app-server"]): Promise<RateLimitsRpc | undefined> {
  const proc = Bun.spawn([codexBin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  try {
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "dokkabi", version: "0.1.0" }, capabilities: {} } }) + "\n",
    );
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "account/rateLimits/read", params: {} }) + "\n");
    // One persistent pump owns the reader. Racing reader.read() against a
    // timeout DROPS chunks: the abandoned promise still consumes data.
    const parts: string[] = [];
    const pump = (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(decoder.decode(value));
        }
      } catch {
        // stream closed
      }
    })();
    let out = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      out = parts.join("");
      for (const line of out.split("\n")) {
        if (!line.includes("rateLimits") || !line.includes('"id":1')) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { result?: RateLimitsRpc };
          if (parsed.result) {
            return parsed.result;
          }
        } catch {
          // partial line; keep reading
        }
      }
      await Bun.sleep(200);
    }
    void pump;
    return undefined;
  } finally {
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }
}
