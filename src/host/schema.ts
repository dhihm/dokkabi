/**
 * EventLog schema frozen for 0.x.
 *
 * One JSON object per JSONL line. Hash covers every field except `hash`.
 * Token and cache numbers live only on `observe.model_usage`.
 * There is no `observe.cache` field.
 *
 * See docs/event-log.md.
 */

export const EVENT_KIND = ["surface", "observe", "effect"] as const;
export type EventKind = (typeof EVENT_KIND)[number];

export const GENESIS_HASH = "0".repeat(64);

export const NAME_PATTERN = /^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/;

/** New session/open rows seal the replay guarantees understood by this host.
 * Historical rows omit both fields and remain valid legacy input. */
export const SESSION_SCHEMA_VERSION = 1 as const;
/** The exact feature set written before MAEK/swarm-memory semantic envelopes. */
export const LEGACY_SESSION_REPLAY_FEATURES = [
  "sandbox-network-v1",
  "swarm-world-network-v1",
  "swarm-world-dispatch-v1",
] as const;
/** The set written between the MAEK/swarm-memory envelopes and the mesh. */
const MESH_PRIOR_SESSION_REPLAY_FEATURES = [
  ...LEGACY_SESSION_REPLAY_FEATURES,
  "maek-query-v1",
  "swarm-memory-v1",
] as const;
const WORK_STEP_PRIOR_SESSION_REPLAY_FEATURES = [
  ...MESH_PRIOR_SESSION_REPLAY_FEATURES,
  "work-step-v1",
] as const;
const SEMANTIC_LIVELOCK_SESSION_REPLAY_FEATURES = [
  ...WORK_STEP_PRIOR_SESSION_REPLAY_FEATURES,
  "semantic-livelock-v1",
] as const;
const SPECULATION_PRIOR_SESSION_REPLAY_FEATURES = [
  ...SEMANTIC_LIVELOCK_SESSION_REPLAY_FEATURES,
  "tool-profile-v1",
] as const;
const SPECULATION_V1_SESSION_REPLAY_FEATURES = [
  ...SPECULATION_PRIOR_SESSION_REPLAY_FEATURES,
  "speculation-v1",
] as const;
const SPECULATION_V2_SESSION_REPLAY_FEATURES = [
  ...SPECULATION_V1_SESSION_REPLAY_FEATURES,
  "speculation-v2",
] as const;

const EVIDENCE_CONTRACT_V2_SESSION_REPLAY_FEATURES = [
  ...SPECULATION_V2_SESSION_REPLAY_FEATURES,
  "evidence-contract-v2",
] as const;

const MANAGED_FIXTURE_V1_SESSION_REPLAY_FEATURES = [
  ...EVIDENCE_CONTRACT_V2_SESSION_REPLAY_FEATURES,
  "managed-fixture-v1",
] as const;

const WORK_MEASUREMENT_V1_SESSION_REPLAY_FEATURES = [
  ...MANAGED_FIXTURE_V1_SESSION_REPLAY_FEATURES,
  "work-measurement-v1",
] as const;

const WORK_AUTHORITY_V1_SESSION_REPLAY_FEATURES = [
  ...WORK_MEASUREMENT_V1_SESSION_REPLAY_FEATURES,
  "work-authority-v1",
] as const;

const WORK_EARNED_V1_SESSION_REPLAY_FEATURES = [
  ...WORK_AUTHORITY_V1_SESSION_REPLAY_FEATURES,
  "work-earned-v1",
] as const;

const STATE_REPLAY_V1_SESSION_REPLAY_FEATURES = [
  ...WORK_EARNED_V1_SESSION_REPLAY_FEATURES,
  "graph-state-v1",
  "work-replay-v1",
] as const;

const PROVIDER_INPUT_V1_SESSION_REPLAY_FEATURES = [
  ...STATE_REPLAY_V1_SESSION_REPLAY_FEATURES,
  "provider-input-v1",
] as const;

/** #227 CG-01: the context graph — `context/*` rows, host-context frames and
 * the `append_context` provider-state operation — is read only under this
 * generation; a log that carries it cannot be reopened by a host that does
 * not know it (the downgrade refusal below). */
const CONTEXT_GRAPH_V1_SESSION_REPLAY_FEATURES = [
  ...PROVIDER_INPUT_V1_SESSION_REPLAY_FEATURES,
  "context-graph-v1",
] as const;

/** R8-01: checkpoint input import — the `session/checkpoint_import`
 * provider-state transformation, the retained portable source bundle and the
 * `branch/import_*` receipts — is written and read only under this
 * generation. */
const CHECKPOINT_INPUT_IMPORT_V1_SESSION_REPLAY_FEATURES = [
  ...CONTEXT_GRAPH_V1_SESSION_REPLAY_FEATURES,
  "checkpoint-input-import-v1",
] as const;

/** Persistent branch workspace receipts require this generation. Earlier
 * generations remain readable and never acquire this new authority. */
const BRANCH_WORKSPACE_V1_SESSION_REPLAY_FEATURES = [
  ...CHECKPOINT_INPUT_IMPORT_V1_SESSION_REPLAY_FEATURES,
  "branch-workspace-v1",
] as const;

/** R8-03: branch context — imported parent lesson candidates and their child
 * applicability reassessment (`context/branch_import`, `context/branch_fit`)
 * — is written and read only under this generation. */
const BRANCH_CONTEXT_V1_SESSION_REPLAY_FEATURES = [
  ...BRANCH_WORKSPACE_V1_SESSION_REPLAY_FEATURES,
  "branch-context-v1",
] as const;

/** R8-04: durable branch decisions — the `decision/*` observe rows and their
 * retained source/readiness evidence bundles — are written and read only
 * under this generation. */
const BRANCH_DECISION_V1_SESSION_REPLAY_FEATURES = [
  ...BRANCH_CONTEXT_V1_SESSION_REPLAY_FEATURES,
  "branch-decision-v1",
] as const;

/** R8-05: the native branch runtime — the parent `branch/runtime_*` rows,
 * the child `branch/runtime_child_ready` receipt and its retained exact row —
 * are written and read only under this generation. */
const BRANCH_RUNTIME_V1_SESSION_REPLAY_FEATURES = [
  ...BRANCH_DECISION_V1_SESSION_REPLAY_FEATURES,
  "branch-runtime-v1",
] as const;

/** R8-06g: lesson schema 2 — host-derived observation versions separate
 * from declared lesson conditions. */
const CONTEXT_LESSON_OBSERVATION_V1_SESSION_REPLAY_FEATURES = [
  ...BRANCH_RUNTIME_V1_SESSION_REPLAY_FEATURES,
  "context-lesson-observation-v1",
] as const;

/** Genuine formal Work executions as scoped context-graph actions and
 * observations, and lesson schema 3 with a host-derived formal-case
 * observable, are written and read only under this generation. Earlier
 * generations keep their exact graph, frame and lesson semantics. */
const CONTEXT_FORMAL_WORK_V1_SESSION_REPLAY_FEATURES = [
  ...CONTEXT_LESSON_OBSERVATION_V1_SESSION_REPLAY_FEATURES,
  "context-formal-work-v1",
] as const;

/** Generic plugin context delivery is distinct from graph-selection proof. */
export const SESSION_REPLAY_FEATURES = [
  ...CONTEXT_FORMAL_WORK_V1_SESSION_REPLAY_FEATURES,
  "host-context-frame-v1",
] as const;

/**
 * Every feature set this host has ever written, oldest first.
 *
 * Kept as a LIST rather than a legacy/current pair: a build that folds the
 * previous set away strands the logs written by the build before it, and a
 * host that cannot replay its own history has no replay guarantee to offer
 * (constitution 5). A new generation appends here; nothing is ever removed.
 */
const SESSION_REPLAY_FEATURE_GENERATIONS: readonly (readonly string[])[] = [
  LEGACY_SESSION_REPLAY_FEATURES,
  MESH_PRIOR_SESSION_REPLAY_FEATURES,
  WORK_STEP_PRIOR_SESSION_REPLAY_FEATURES,
  SEMANTIC_LIVELOCK_SESSION_REPLAY_FEATURES,
  SPECULATION_PRIOR_SESSION_REPLAY_FEATURES,
  SPECULATION_V1_SESSION_REPLAY_FEATURES,
  SPECULATION_V2_SESSION_REPLAY_FEATURES,
  EVIDENCE_CONTRACT_V2_SESSION_REPLAY_FEATURES,
  MANAGED_FIXTURE_V1_SESSION_REPLAY_FEATURES,
  WORK_MEASUREMENT_V1_SESSION_REPLAY_FEATURES,
  WORK_AUTHORITY_V1_SESSION_REPLAY_FEATURES,
  WORK_EARNED_V1_SESSION_REPLAY_FEATURES,
  STATE_REPLAY_V1_SESSION_REPLAY_FEATURES,
  PROVIDER_INPUT_V1_SESSION_REPLAY_FEATURES,
  CONTEXT_GRAPH_V1_SESSION_REPLAY_FEATURES,
  CHECKPOINT_INPUT_IMPORT_V1_SESSION_REPLAY_FEATURES,
  BRANCH_WORKSPACE_V1_SESSION_REPLAY_FEATURES,
  BRANCH_CONTEXT_V1_SESSION_REPLAY_FEATURES,
  BRANCH_DECISION_V1_SESSION_REPLAY_FEATURES,
  BRANCH_RUNTIME_V1_SESSION_REPLAY_FEATURES,
  CONTEXT_LESSON_OBSERVATION_V1_SESSION_REPLAY_FEATURES,
  CONTEXT_FORMAL_WORK_V1_SESSION_REPLAY_FEATURES,
  SESSION_REPLAY_FEATURES,
];

export type SessionReplayFeatureGeneration = "legacy" | "current";

/** The generation's position, oldest = 0. `undefined` means this host does
 * not know the set, which every caller treats as fail-closed. */
export function sessionReplayFeatureGenerationIndex(value: unknown): number | undefined {
  const index = SESSION_REPLAY_FEATURE_GENERATIONS.findIndex((features) => exactStrings(value, features));
  return index === -1 ? undefined : index;
}

export function sessionReplayFeatureGeneration(value: unknown): SessionReplayFeatureGeneration | undefined {
  const index = sessionReplayFeatureGenerationIndex(value);
  if (index === undefined) return undefined;
  return index === SESSION_REPLAY_FEATURE_GENERATIONS.length - 1 ? "current" : "legacy";
}

/** The features a session/open row of this generation sealed. */
export function sessionReplayFeaturesAt(index: number): readonly string[] {
  const features = SESSION_REPLAY_FEATURE_GENERATIONS[index];
  if (!features) throw new Error(`unknown session replay feature generation ${index}`);
  return features;
}

export function currentSessionSchemaPayload(): {
  readonly session_schema_version: typeof SESSION_SCHEMA_VERSION;
  readonly replay_features: string[];
} {
  return {
    session_schema_version: SESSION_SCHEMA_VERSION,
    replay_features: [...SESSION_REPLAY_FEATURES],
  };
}

export function hasCurrentSessionSchema(payload: Readonly<Record<string, unknown>>): boolean {
  return payload.session_schema_version === SESSION_SCHEMA_VERSION
    && sessionReplayFeatureGeneration(payload.replay_features) === "current";
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && expected.every((feature, index) => value[index] === feature);
}

export type AuthKind = "oauth" | "plan_key";
export type Missing = "missing";
export type Metric = number | Missing;

export interface ModelUsage {
  provider: string;
  model: string;
  auth: AuthKind;
  route: string;
  input_tokens: Metric;
  output_tokens: Metric;
  reasoning_tokens: Metric;
  cache_read_tokens: Metric;
  cache_write_tokens: Metric;
  prefix_hash: string | Missing;
  prompt_generation: number | Missing;
  hit_ratio: Metric;
  context_window: Metric;
  context_used: Metric;
  /** Present only for failed/aborted generations. Raw provider messages and
   * response bodies never enter this public observation. */
  status?:
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
  reason_code?: string;
  retry_after_sec?: number;
  /** Sampling temperature actually requested. Present only when a
   * coordinator set one (monkeymode, #59); absent is the provider default. */
  temperature?: number;
}

export interface HostPid {
  pid: number;
  cmd: string;
  cpu_pct: Metric;
  rss_bytes: Metric;
}

export interface HostSample {
  cpu_pct: Metric;
  rss_bytes: Metric;
  workspace_bytes: Metric;
  log_bytes: Metric;
  files_created: string[];
  files_written: string[];
  pids: HostPid[];
}

export interface ModelQuota {
  window: "week" | "day" | "missing";
  used: Metric;
  limit: Metric;
  /** Provider-reported usage percent (weekly windows report percents, not
   * absolute tokens) — preferred by the board when present. */
  used_percent?: number;
  resets_at?: string;
}

export type QuotaConfidence = "authoritative" | "observed" | "estimated" | "unknown";

/** One provider-reported limit window. Percentages are deliberately kept as
 * percentages: a subscription window is not an API-token allowance. */
export interface ModelQuotaWindow {
  /** Sanitized logical window id; never a provider account/limit label. */
  id: string;
  duration_minutes: Metric;
  used_percent: Metric;
  remaining_percent: Metric;
  resets_at?: string;
}

export type QuotaWindowKindV1 = "rolling" | "calendar" | "requests" | "tokens" | "credits" | "unknown";
export type QuotaWindowSourceV1 = "provider_api" | "response_headers" | "local_meter" | "operator_policy";

/** Versioned provider-neutral window. Legacy aliases remain on the value so
 * old dashboard/replay projections can read a v1 snapshot without migration. */
export interface QuotaWindowV1 extends ModelQuotaWindow {
  kind: QuotaWindowKindV1;
  durationSeconds: Metric;
  used: Metric;
  limit: Metric;
  remaining: Metric;
  usedPercent: Metric;
  resetsAt: string | Missing;
  source: QuotaWindowSourceV1;
  confidence: QuotaConfidence;
}

/** Sanitized quota fact for one route/model. Credentials and provider account
 * identifiers are never part of this structure. `bucket` is a provider's
 * public limit id, used only to show that models consume the same pool. */
export interface ModelQuotaSnapshot {
  provider: string;
  route: string;
  model: string;
  bucket: string | Missing;
  confidence: QuotaConfidence;
  observed_at: string;
  windows: ModelQuotaWindow[];
}

export type QuotaScopeV1 = "subscription" | "provider" | "project" | "model" | "unknown";

/** Sanitized v1 snapshot. `bucketDigest` proves shared capacity without
 * retaining provider account, organization, project, or raw limit ids. */
export interface ModelQuotaSnapshotV1 extends ModelQuotaSnapshot {
  format: 1;
  scope: QuotaScopeV1;
  bucketDigest: string | Missing;
  observedAt: string;
  staleAfter: string | Missing;
  windows: QuotaWindowV1[];
}

export interface ObserveFields {
  model_usage?: ModelUsage;
  model_quota?: ModelQuota;
  model_quota_snapshot?: ModelQuotaSnapshot;
  plugin?: {
    action: "load" | "unload";
    id: string;
    digest: string;
  };
  host?: HostSample;
}

export interface EventInput {
  kind: EventKind;
  name: string;
  payload?: Record<string, unknown>;
  observe?: ObserveFields;
  ts?: string;
}

export interface EventRecord {
  seq: number;
  ts: string;
  kind: EventKind;
  name: string;
  prev_hash: string;
  hash: string;
  payload: Record<string, unknown>;
  observe?: ObserveFields;
}

export interface SessionReplaySchemaProjection {
  readonly references: Array<{
    readonly seq: number;
    readonly version: typeof SESSION_SCHEMA_VERSION;
    readonly features: string[];
  }>;
  readonly featureStart: ReadonlyMap<string, number>;
}

/** Validate versioned session/open markers. The immediately prior exact set is
 * retained for historical logs; partial sets and current-to-old downgrades are
 * never interpreted as another legacy generation. */
export function projectSessionReplaySchemas(
  events: readonly EventRecord[],
): SessionReplaySchemaProjection {
  const references: SessionReplaySchemaProjection["references"] = [];
  const featureStart = new Map<string, number>();
  let versionedSeen = false;
  let highestSeen = -1;
  for (const event of events) {
    if (event.name !== "session/open") continue;
    const hasVersion = "session_schema_version" in event.payload;
    const hasFeatures = "replay_features" in event.payload;
    if (!hasVersion && !hasFeatures) {
      if (versionedSeen) throw new Error("modern session schema cannot downgrade to a legacy session/open");
      continue;
    }
    if (!hasVersion || !hasFeatures || event.payload.session_schema_version !== SESSION_SCHEMA_VERSION) {
      throw new Error("modern session schema marker is invalid");
    }
    const generation = sessionReplayFeatureGenerationIndex(event.payload.replay_features);
    if (generation === undefined) {
      throw new Error("modern session replay feature marker is invalid");
    }
    // A session may gain guarantees across a restart but never shed them:
    // reopening on an older set would let newer rows be read under older
    // semantics, which is exactly the reinterpretation replay must refuse.
    if (generation < highestSeen) {
      throw new Error("current session schema cannot downgrade to the prior replay feature set");
    }
    versionedSeen = true;
    highestSeen = generation;
    const checkedFeatures = [...sessionReplayFeaturesAt(generation)];
    references.push({ seq: event.seq, version: SESSION_SCHEMA_VERSION, features: checkedFeatures });
    for (const feature of checkedFeatures) {
      if (!featureStart.has(feature)) featureStart.set(feature, event.seq);
    }
  }
  return { references, featureStart };
}

export interface DerivedMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  name?: string;
}

export function isEventKind(value: unknown): value is EventKind {
  return value === "surface" || value === "observe" || value === "effect";
}

export function assertEventName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`event name must be area/action, got ${JSON.stringify(name)}`);
  }
}
