import { resultSourceStats, type ResultSourceStats } from "../host/result-source.ts";
import { lspDiagnosticsStats, type LspDiagnosticsStats } from "../host/lsp/stats.ts";
import { lspNavigationStats, type LspNavigationStats } from "../host/lsp/navigation-stats.ts";
import { readBatchStats, type ReadBatchStats } from "../host/read-batch.ts";
import { earlyReadStats, type EarlyReadStats } from "../host/received-calls.ts";
import { projectExperimentDashboard, type ExperimentDashboard } from "./experiment.ts";
import { projectResearchDashboard, type ResearchDashboard } from "./research.ts";
import { contextOccupancy, hitSeriesFromUsages, hitTrack, CACHE_IDLE_EXPIRY_MS, HIT_FLOOR, HIT_WARMUP_TURNS, type HitTrack, hitOf, occupancyOf } from "../host/hit-ratio.ts";
import { projectSessionReplaySchemas, type EventRecord, type HostSample, type Metric, type ModelQuota, type ModelQuotaSnapshot, type ModelQuotaWindow, type ModelUsage } from "../host/schema.ts";
import { EventIndex, indexOf } from "./event-index.ts";
import { lastHeungOn, lastHeungWave } from "../work/heung.ts";
import { lastDoing, lastPlanDigest, readPlanFromLog } from "../work/log.ts";
import type { TodoState, WorkPlan } from "../work/schema.ts";
import { scopeWorkEvents } from "../work/scope.ts";
import { viewPlan } from "../work/view.ts";
import { projectRemoteDashboard, type RemoteDashboardState } from "../remote/dashboard.ts";
import {
  projectToolProfileReferences,
  type ToolProfileReference,
} from "../host/tool-profile-event.ts";
import {
  projectSpeculationReferences,
  summarizeSpeculations,
  type SpeculationDashboardState,
} from "../speculative/events.ts";
import { projectSpeculationV2References, summarizeSpeculationsV2 } from "../speculative/events-v2.ts";

export interface ToolRow {
  name: string;
  phase: "call" | "start" | "end";
  seq: number;
  /** tool call id; joins an err row to its result text (stderr tail). */
  id?: string;
  duration_ms: number | "missing";
  error: boolean;
  diagnosis?: string;
  diagnosis_detail?: string;
  harness_ms?: number | "missing";
  command_bound_ms?: number | "missing";
  total_ms?: number | "missing";
  verdict?: "model_bound" | "harness_overhead" | "unknown";
}

export interface ToolMax {
  name: string;
  max_ms: number;
}

export interface ToolSlowRow {
  name: string;
  seq: number;
  duration_ms: number;
  reason: string;
  result_bytes: number | "missing";
  waited_ms?: number;
}

export interface CompactionRow {
  name: string;
  seq: number;
  reason?: string;
  beforeTokens?: number;
  afterTokens?: number;
  droppedMessages?: number;
  status?: string;
}

const ACTIVE_AGENT = new Set(["running", "waiting_tool", "compacting"]);

export interface WorkTodoRow {
  id: string;
  title: string;
  class: string;
  priority: number;
  state: TodoState | "doing" | "missing";
}

export interface WorkBoard {
  goalId: string | "missing";
  goal: string | "missing";
  digest: string | "missing";
  agent: string;
  agentStatus: string | "missing";
  route: string | "missing";
  intending: string | "missing";
  doing: string | "missing";
  done: string[];
  blocked: string[];
  lastUser: string | "missing";
  lastAssistant: string | "missing";
  /** Latest assistant/message thinking text, unclipped — "missing" when the
   * provider returned none (payload field absent). */
  lastAssistantReasoning: string | "missing";
  /** Recent tool calls joined with their results — the MODEL STREAM tool boxes. */
  lastToolCalls: ToolCallView[];
  /** Recent assistant/message texts, oldest→newest — the MODEL STREAM history. */
  lastAssistantHistory: string[];
  /** Latest assistant/message text, unclipped — the MODEL STREAM pane body. */
  lastAssistantFull: string;
  heung: "on" | "off" | "missing";
  heungWave: number | "missing";
  /** Latest monkey campaign (#59) recorded in this session, or missing. */
  monkey: MonkeyBoard | "missing";
  /** The sealed recipe this session ran under (#60), or missing. */
  recipe: RecipeBoard | "missing";
  /** Latest search campaign (#60 phase 3) in this session, or missing. */
  search: SearchBoard | "missing";
  /** Latest ralph-sample plan campaign (#60 phase 2), or missing. */
  planSamples: PlanSamplesBoard | "missing";
  ralphPlan: RalphPlanBoard | "missing";
  /** Host refusal reasons for the latest unsealed graph (decompose_retry /
   * plan_host). Empty once a plan seals — a stalled decompose loop must be
   * distinguishable from an idle model (constitution 6). */
  refusals: string[];
  /** Host image acquisition/execution state, independent of case verdicts. */
  executionViews?: string;
  checkerRevisions?: string;
  reviewDecision?: string;
  initialRegression?: string;
  /** An open model turn: the newest turn_start has no assistant/message or
   * turn_end after it. Chars come from the latest model/progress heartbeat
   * (0 before the first tick) — a 14-minute silent generation must be
   * distinguishable from a hang (constitution 6, run 18). */
  generating: GeneratingState | "missing";
  todos: WorkTodoRow[];
}

/** The market/recipe seal a run executed under (#60 phase 3). */
export interface RecipeBoard {
  id: string;
  digest: string;
}

/** One scannable row for a search campaign (#60 phase 3): trial count,
 * the recorded winner, the stop reason, and the holdout verdict —
 * projected from search/* records only, never re-derived. */
export interface SearchBoard {
  trials: number;
  winner: string | "missing";
  stop: string | "missing";
  holdoutCoverage: number | "missing";
  /** A search/select landed: no-winner is then a VERDICT, never progress
   * (PR #94 review M6). */
  selected: boolean;
}

/** One scannable row for a ralph-sample plan campaign (#60 phase 2):
 * draws, validator passes, and the host's pick — records only. */
export interface PlanSamplesBoard {
  samples: number;
  drawn: number;
  passed: number;
  winner: number | "missing";
  stop: string | "missing";
}

/** One scannable row for a monkey campaign (#59 Phase 2): k, samples used,
 * and the verifier's pick — projected from recorded monkey/* events only. */
export interface MonkeyBoard {
  k: number;
  kUsed: number;
  winner: string | "missing";
  stop: string | "missing";
}

export interface RalphPlanBoard {
  status: "planning" | "reviewing" | "revising" | "converged" | "stopped";
  pass: number | "missing";
  maxPasses: number | "missing";
  role: string | "missing";
  revision: number | "missing";
  digest: string | "missing";
  newGaps: number;
  unknowns: number;
  contradictions: number;
  reason?: string;
}

export interface GeneratingState {
  elapsed_s: number;
  /** Epoch ms of the turn_start event: the wall-clock anchor for a ticking
   * elapsed display between sparse model/progress events. */
  started_ts: number;
  chars: number;
  thinking_chars: number;
  /** Tool-call argument chars streamed so far: a long write() is progress. */
  tool_chars: number;
  /** Last ~800 chars of thinking from the newest model/progress (fills the 10-line window). */
  thinking_tail: string;
  /** Last ~800 chars of visible reply from the newest model/progress. */
  text_tail: string;
}

export interface SessionStats {
  turns: number;
  in_sum: number | "missing";
  out_sum: number | "missing";
  cache_r_sum: number | "missing";
  cache_w_sum: number | "missing";
  compaction_n: number;
  week_limit: Metric;
  week_used: Metric;
  /** Provider weekly window reports percent — preferred rendering. */
  week_used_percent: number | "missing";
  week_resets_at: string | "missing";
  /** Every window from the newest active-provider snapshot. */
  quota_windows: ModelQuotaWindow[];
  compact_at: Metric;
  hits: Array<number | "missing">;
  hit_min: Metric;
  hit_max: Metric;
  hit_held: "yes" | "no" | "missing";
  hitSkip: boolean[];
  /** How many blob/gc_result observes landed this session (dry-run counts). */
  blob_gc_n: number;
  /** Sum of digests actually reported removed (includes dry-run counts). */
  blob_removed_sum: number;
  /** Sum of bytes_freed from blob/gc_result. */
  blob_bytes_freed_sum: number;
  /** How many maek/ingest observes landed this session. */
  maek_ingest_n: number;
  /** How many maek/query observes landed this session. */
  maek_query_n: number;
  maek_rebuild_n: number;
  maek_failure_n: number;
}

/** Latest MAEK activity projected from the log. */
export interface MaekLast {
  last_kind: string;
  /** Current health derived from ordered failures and the sealed source head. */
  state: "ready" | "failed" | "stale";
  /** Safe failure classifier from the latest MAEK failure. */
  failure_stage?: string;
  /** Latest successful initialization or query row count. */
  rows?: number;
  last_name:
    | "maek/ingest"
    | "maek/query"
    | "maek/ready"
    | "maek/rebuild"
    | "maek/ingest_failed"
    | "maek/query_failed"
    | "maek/rebuild_failed";
}

export interface SwarmMemoryDashboardState {
  /** Public schema version, never inferred from blob contents. */
  schema: 1;
  /** Bounded aliases from recorded digests. Full repository identity stays hidden. */
  repositoryAlias: string;
  sourceRevision: string;
  viewAlias: string;
  sufficiency: "sufficient" | "insufficient";
  sections: number;
  binding: "recorded" | "bound";
  /** Provider order is the order sealed into the view event. */
  providers: SwarmMemoryProviderDashboardState[];
  /** Latest exact parent verification for this view, when one exists. */
  childStatus?: "ok" | "missing" | "mismatch";
}

export interface SwarmMemoryProviderDashboardState {
  id: string;
  sourceRevision: string;
  selections: number;
}

/** Latest blob GC result projected from the log. */
export interface BlobGcLast {
  removed: number;
  kept: number;
  bytes_freed: number;
  dry_run: boolean;
  on_disk: number | "missing";
  referenced: number | "missing";
}

export interface UsageRequest {
  seq: number;
  ts: number;
  input_tokens: Metric;
  output_tokens: Metric;
  cache_read_tokens: Metric;
  cache_write_tokens: Metric;
  /** The ratio the RECORDER wrote. Kept for the legacy diagnostic only —
   * consumers render `hit`, which is derived from the raw counts here, at
   * the projection boundary. Reading this field for display is how the
   * token-stack pane showed 100% beside the usage pane's corrected 8%. */
  hit_ratio: Metric;
  /** Derived from the raw counts (writes included), once, for every surface. */
  hit: Metric;
  occupancy: Metric;
  generation: Metric;
  sealed: boolean;
  /** True when this cold read follows an idle gap past CACHE_IDLE_EXPIRY_MS. */
  rewarm: boolean;
}

export interface DashProjection {
  experiment?: ExperimentDashboard;
  research?: ResearchDashboard;
  /**
   * The log bucketed by event name, already folded.
   *
   * The projection walked the log to build itself; everything downstream --
   * the bell, the approval scanners, the alert strip -- then walked it again,
   * once per helper, ON EVERY PAINT rather than every projection. Handing the
   * buckets along makes those lookups the size of what they match.
   */
  index: EventIndex;
  session: string;
  digest: string | "missing";
  plugins: string[];
  pluginStates: PluginStateRow[];
  pluginAssets: PluginAssetState;
  agent: string | "missing";
  error: string | undefined;
  usage: ModelUsage | undefined;
  host: HostSample | undefined;
  hostSeries: HostSample[];
  requests: UsageRequest[];
  work: WorkBoard;
  tools: ToolRow[];
  toolProfile: ToolProfileReference | undefined;
  speculation: SpeculationDashboardState | undefined;
  toolMax: ToolMax[];
  toolSlow: ToolSlowRow[];
  compaction: CompactionRow[];
  compactionActive: "yes" | "no" | "unsealed";
  /** A compaction landed after the last model usage: the gauge shows the kept estimate. */
  compactionFresh: boolean;
  /** Composition of the last input context in estimated tokens, recorded by the loop. */
  contextLayers: ContextLayers | undefined;
  sessionStats: SessionStats;
  /** Most recent blob/gc_result, if any. */
  blobGc: BlobGcLast | undefined;
  /** #223 recorded tool-result sources: stored, model-visible and omitted
   * bytes and reads as separate numbers; undefined when none were recorded. */
  resultSources?: ResultSourceStats;
  /** #222 passive diagnostics: servers, batches by freshness and discard
   * reason, delivered/omitted/not-inspected; undefined when unused. */
  lspDiagnostics?: LspDiagnosticsStats;
  /** #229 navigation and rename plans: queries by status, plans, applies,
   * commits, rollbacks, reconciled outcomes; undefined when unused. */
  lspNavigation?: LspNavigationStats;
  /** #228 recorded read batches: batches and items by status, queue and
   * child latency, bytes, omissions, failures, cancellations, unpublished
   * batches and the duplicate-execution check; undefined when unused. */
  readBatches?: ReadBatchStats;
  /** #224 early reads: provider capability, eligible/ineligible calls with
   * reasons, active leases, measured overlap, ordinary reruns and the cost of
   * discarded work; undefined when unused. */
  earlyReads?: EarlyReadStats;
  /** Most recent MAEK activity, if any. */
  maek: MaekLast | undefined;
  /** Digest-only swarm memory lifecycle; never contains section bodies. */
  swarmMemory: SwarmMemoryDashboardState | undefined;
  /** Safe ontology-wiki lifecycle counters; no root path or note body. */
  knowledge?: KnowledgeDashboardState;
  remote: RemoteDashboardState;
  events: EventRecord[];
  plan: WorkPlan | undefined;
  /** Newest `model/thinking` level. `off` explains an empty reasoning block. */
  thinkingLevel: string | "missing";
  /** Latest explicit or automatic transcript restoration outcome. */
  resume: SessionResumeState | undefined;
}

export interface SessionResumeState {
  restored: boolean;
  messages: number;
  source?: string;
  reason?: string;
  mismatches?: readonly string[];
  action?: string;
  work?: string;
}

export interface PluginStateRow {
  readonly id: string;
  readonly state: "active" | "pending" | "disposed" | "failed";
  readonly reasonCode?: string;
}

export interface KnowledgeDashboardState {
  state: "ready" | "disabled" | "missing";
  queries: number;
  reads: number;
  writes: number;
  publishes: number;
  failures: number;
  pending: number;
  revision: string | "missing";
  profile: string | "missing";
  dialect: string | "missing";
  layout: string | "missing";
  documents: number | "missing";
  relations: number | "missing";
  orphans: number | "missing";
  errors: number | "missing";
  warnings: number | "missing";
  writable: boolean | "missing";
  publishable: boolean | "missing";
  publication: string | "missing";
  lastResults: number | "missing";
  checkpointPending: number;
}

export interface PluginAssetState {
  readonly packages: number;
  readonly prompts: number;
  readonly skills: number;
}

export interface ContextLayers {
  system: number;
  tools: number;
  history: number;
  skills?: number;
}

function lastContextLayers(events: readonly EventRecord[]): ContextLayers | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "model/context_layers") {
      continue;
    }
    const layers = event.payload.layers as Record<string, unknown> | undefined;
    if (
      layers &&
      typeof layers.system === "number" &&
      typeof layers.tools === "number" &&
      typeof layers.history === "number"
    ) {
      return {
        system: layers.system,
        tools: layers.tools,
        history: layers.history,
        ...(typeof layers.skills === "number" ? { skills: layers.skills } : {}),
      };
    }
  }
  return undefined;
}

/**
 * What the open turn has produced so far.
 *
 * `model/progress` used to repeat the last 800 characters every heartbeat —
 * three quarters of a session log, and the board still only saw those 800.
 * It carries deltas now, so joining them across the current turn gives the
 * whole generation. Older sessions carry tails instead; the newest tail is
 * the best view those can offer.
 *
 * Bounded: a long turn cannot grow the projection without limit, and the END
 * is what a reader needs, so the tail of the join is what is kept.
 */
const GENERATED_MAX = 4000;

function generatedText(
  telemetry: readonly EventRecord[],
  turnStartTs: number,
  field: "text" | "thinking",
  newest: EventRecord | undefined,
): string {
  const deltaKey = field === "text" ? "text_delta" : "thinking_delta";
  const tailKey = field === "text" ? "text_tail" : "thinking_tail";
  let joined = "";
  let sawDelta = false;
  for (const event of telemetry) {
    if (event.name !== "model/progress" || Date.parse(event.ts) < turnStartTs) {
      continue;
    }
    const delta = event.payload[deltaKey];
    if (typeof delta === "string") {
      sawDelta = true;
      joined += delta;
    }
  }
  if (sawDelta) {
    return joined.length > GENERATED_MAX ? joined.slice(-GENERATED_MAX) : joined;
  }
  const tail = newest?.payload[tailKey];
  return typeof tail === "string" ? tail : "";
}

/**
 * Newest recorded reasoning level. `off` is why a stream can carry tool calls
 * and no thought at all — without it on screen, an operator reads the silence
 * as a broken pane rather than as a setting (constitution 6).
 */
function lastThinkingLevel(events: readonly EventRecord[]): string | "missing" {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "model/thinking") {
      continue;
    }
    const level = event.payload.level;
    if (typeof level === "string" && level.length > 0) {
      return level;
    }
  }
  return "missing";
}

export function projectDash(
  events: readonly EventRecord[],
  telemetry: readonly EventRecord[] = [],
  /**
   * The log bucketed by event name. Every helper here walks the whole log for
   * its own two or three names -- about sixty full scans, 145ms on a live 93MB
   * session -- and walking its own buckets instead visits the same records in
   * the same order, so the helpers are unchanged and only their input narrows.
   *
   * A caller that keeps one across polls (the board does) pays the fold only
   * for what arrived; one that does not gets a fresh index, which is still a
   * single pass in place of sixty.
   */
  index: EventIndex = indexOf(events),
): DashProjection {
  // model/progress and host/sample live in the sibling telemetry stream now.
  // Old logs (and golden replay) carry them inline, so fall back to the
  // content events when no telemetry is supplied. The content events keep
  // their real seq — alerts and the timeline cite it — while host/generating
  // read telemetry, scoped by turn-start timestamp rather than seq.
  const tel = telemetry.length > 0 ? telemetry : events;
  const sinceOpen = sinceLastSessionOpen(events);
  const pluginStates = projectPluginStates(sinceOpen);
  // A shared campaign log carries many sweep runs; the board must show the
  // CURRENT one. Everything run-scoped (work graph state, error banner) is
  // projected from the last run boundary (swe/baseline opens a run).
  const sinceRun = sinceLastRunBoundary(events);
  const session = lastString(
    events.filter((event) => event.name === "session/open"),
    "session_id",
  ) ?? "missing";
  const agentStatus = lastAgentStatus(index.of("agent/status")) ?? "missing";
  const tools = toolRows(index.ofAny("tool/call", "tool/start", "tool/end"));
  const sessionSchema = projectSessionReplaySchemas(events);
  const v1Speculation = summarizeSpeculations(projectSpeculationReferences(
    events,
    sessionSchema.featureStart.get("speculation-v1"),
    sessionSchema.featureStart.get("speculation-v2"),
  ));
  const speculation = summarizeSpeculationsV2(projectSpeculationV2References(
    events, sessionSchema.featureStart.get("speculation-v2"),
  )) ?? v1Speculation;
  const plan = readPlanFromLog(events);
  const fresh = postCompactionContext(index.ofAny("compaction/start", "compaction/drop", "model/usage"));
  const recordedUsage = lastModelUsage(events);
  const measured =
    fresh && recordedUsage ? { ...recordedUsage, context_used: fresh.estimate } : recordedUsage;
  const usage = usageForActiveSelection(events, measured);
  return {
    experiment: projectExperimentDashboard(events),
    research: projectResearchDashboard(events),
    index,
    session,
    digest: lastString(sinceOpen, "plugin_manifest_digest") ?? lastPluginDigest(sinceOpen) ?? "missing",
    plugins: pluginStates.filter((plugin) => plugin.state === "active").map((plugin) => plugin.id),
    pluginStates,
    pluginAssets: pluginAssetState(sinceOpen),
    agent: agentStatus,
    error: lastError(sinceRun),
    usage,
    host: lastHost(tel),
    hostSeries: hostSeriesFrom(tel),
    requests: usageRequests(events),
    work: projectWork(sinceRun, agentStatus, tel, sinceRun.length === events.length ? index : indexOf(sinceRun)),
    tools,
    toolProfile: projectToolProfileReferences(
      index.ofAny("prompt/seal", "tool/call", "tool/profile"),
    ).at(-1),
    speculation,
    toolMax: toolMaxByName(tools),
    toolSlow: toolSlowRows(index.of("tool/slow")),
    compaction: compactionRows(index.ofPrefix("compaction/", "prompt/seal")),
    compactionActive: lastCompactionActive(events, agentStatus),
    compactionFresh: fresh !== undefined,
    contextLayers: lastContextLayers(index.of("model/context_layers")),
    sessionStats: projectSession(sinceOpen),
    blobGc: lastBlobGc(sinceOpen),
    ...(() => {
      const stats = resultSourceStats(sinceOpen);
      return stats ? { resultSources: stats } : {};
    })(),
    ...(() => {
      const stats = lspDiagnosticsStats(sinceOpen);
      return stats ? { lspDiagnostics: stats } : {};
    })(),
    ...(() => {
      const stats = lspNavigationStats(sinceOpen);
      return stats ? { lspNavigation: stats } : {};
    })(),
    ...(() => {
      const stats = readBatchStats(sinceOpen);
      return stats ? { readBatches: stats } : {};
    })(),
    ...(() => {
      const stats = earlyReadStats(sinceOpen);
      return stats ? { earlyReads: stats } : {};
    })(),
    maek: lastMaek(sinceOpen),
    swarmMemory: lastSwarmMemory(sinceOpen),
    knowledge: projectKnowledge(sinceOpen),
    remote: projectRemoteDashboard(sinceOpen),
    events: events.filter((event) => event.name !== "host/sample"),
    plan,
    thinkingLevel: lastThinkingLevel(events),
    resume: lastSessionResume(events),
  };
}

function lastSessionResume(events: readonly EventRecord[]): SessionResumeState | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name !== "session/resume" || typeof event.payload.restored !== "boolean") continue;
    const count = event.payload.restored ? event.payload.messages : event.payload.stored_messages;
    return {
      restored: event.payload.restored,
      messages: typeof count === "number" ? count : 0,
      ...(typeof event.payload.source === "string" ? { source: event.payload.source } : {}),
      ...(typeof event.payload.reason === "string" ? { reason: event.payload.reason } : {}),
      ...(Array.isArray(event.payload.mismatches)
        ? { mismatches: event.payload.mismatches.filter((value): value is string => typeof value === "string") }
        : {}),
      ...(typeof event.payload.action === "string" ? { action: event.payload.action } : {}),
      ...(typeof event.payload.work === "string" ? { work: event.payload.work } : {}),
    };
  }
  return undefined;
}

function projectPluginStates(events: readonly EventRecord[]): PluginStateRow[] {
  const states = new Map<string, PluginStateRow>();
  for (const event of events) {
    const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
    if (!id) continue;
    if (event.name === "plugin/load") states.set(id, { id, state: "active" });
    if (event.name === "plugin/skip") {
      states.set(id, {
        id,
        state: "disposed",
        reasonCode: stringPayload(event.payload, "reason_code") ?? stringPayload(event.payload, "reason"),
      });
    }
    if (event.name === "plugin/unload") {
      const next = event.payload.next_state === "pending" ? "pending" : "disposed";
      states.set(id, { id, state: next, reasonCode: stringPayload(event.payload, "reason_code") });
    }
    if (event.name === "plugin/pending") {
      states.set(id, { id, state: "pending", reasonCode: stringPayload(event.payload, "reason_code") });
    }
    if (event.name === "plugin/transition_failed") {
      states.set(id, { id, state: "failed", reasonCode: stringPayload(event.payload, "reason_code") });
    }
  }
  return [...states.values()];
}

function stringPayload(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function projectKnowledge(events: readonly EventRecord[]): KnowledgeDashboardState {
  const state = projectPluginStates(events).find((plugin) => plugin.id === "knowledge")?.state;
  const count = (name: string) => events.filter((event) => event.name === name).length;
  const queries = count("knowledge/result");
  const reads = count("knowledge/read_result");
  const writes = events.filter((event) => event.name === "knowledge/write_result" && event.payload.status === "written").length;
  const publishes = events.filter((event) => event.name === "knowledge/publish_result" && (event.payload.status === "committed" || event.payload.status === "published")).length;
  const failures = events.filter((event) => event.name.startsWith("knowledge/") && event.payload.status === "failed").length;
  const pending = pendingKnowledgeEffects(events, new Set(["knowledge/query", "knowledge/lint"]), "knowledge/result")
    + pendingKnowledgeEffects(events, new Set(["knowledge/read"]), "knowledge/read_result")
    + pendingKnowledgeEffects(events, new Set(["knowledge/write"]), "knowledge/write_result")
    + pendingKnowledgeEffects(events, new Set(["knowledge/publish"]), "knowledge/publish_result")
    + pendingKnowledgeEffects(events, new Set(["knowledge/promote"]), "knowledge/promote_result")
    + pendingKnowledgeEffects(events, new Set(["knowledge/resolve"]), "knowledge/resolve_result")
    + pendingKnowledgeEffects(events, new Set(["knowledge/migrate"]), "knowledge/migrate_result");
  let revision: string | "missing" = "missing";
  let profileEvent: EventRecord | undefined;
  let healthEvent: EventRecord | undefined;
  let lintEvent: EventRecord | undefined;
  let publication: string | "missing" = "missing";
  let lastResults: number | "missing" = "missing";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!profileEvent && event?.name === "knowledge/profile") profileEvent = event;
    if (!healthEvent && (event?.name === "knowledge/profile" || event?.name === "knowledge/write_result") && typeof event.payload.documents === "number") healthEvent = event;
    if (!lintEvent && event?.name === "knowledge/lint_summary") lintEvent = event;
    if (lastResults === "missing" && event?.name === "knowledge/result" && typeof event.payload.result_count === "number") lastResults = event.payload.result_count;
    if (publication === "missing" && event?.name === "knowledge/publish_result" && typeof event.payload.status === "string") {
      publication = event.payload.status;
    }
    const value = event?.payload.revision_digest;
    if (revision === "missing" && typeof value === "string") {
      revision = value;
    }
  }
  const checkpointState = new Map<string, string>();
  for (const event of events) {
    if (event.name !== "work/checkpoint" || typeof event.payload.status !== "string") continue;
    const key = `${String(event.payload.goal ?? "missing")}:${String(event.payload.todo ?? "")}:${String(event.payload.reason ?? "missing")}`;
    checkpointState.set(key, event.payload.status);
  }
  return {
    state: state === "active" ? "ready" : state ? "disabled" : "missing",
    queries,
    reads,
    writes,
    publishes,
    failures,
    pending,
    revision,
    profile: stringPayload(profileEvent?.payload ?? {}, "profile") ?? "missing",
    dialect: stringPayload(profileEvent?.payload ?? {}, "dialect") ?? "missing",
    layout: stringPayload(profileEvent?.payload ?? {}, "layout") ?? "missing",
    documents: numberPayload(healthEvent?.payload.documents),
    relations: numberPayload(healthEvent?.payload.relations),
    orphans: numberPayload(healthEvent?.payload.orphans),
    errors: numberPayload(lintEvent?.payload.error_count ?? healthEvent?.payload.errors),
    warnings: numberPayload(lintEvent?.payload.warning_count ?? healthEvent?.payload.warnings),
    writable: booleanPayload(profileEvent?.payload.writable),
    publishable: booleanPayload(profileEvent?.payload.publishable),
    publication,
    lastResults,
    checkpointPending: [...checkpointState.values()].filter((value) => value === "pending").length,
  };
}

function pendingKnowledgeEffects(events: readonly EventRecord[], effects: ReadonlySet<string>, result: string): number {
  let pending = 0;
  for (const event of events) {
    if (event.kind === "effect" && effects.has(event.name)) pending += 1;
    else if (event.kind === "observe" && event.name === result && pending > 0) pending -= 1;
  }
  return pending;
}

function numberPayload(value: unknown): number | "missing" {
  return typeof value === "number" && Number.isFinite(value) ? value : "missing";
}

function booleanPayload(value: unknown): boolean | "missing" {
  return typeof value === "boolean" ? value : "missing";
}

function pluginAssetState(events: readonly EventRecord[]): PluginAssetState {
  const active = new Map<string, { package: boolean; prompts: number; skills: number }>();
  for (const event of events) {
    const id = typeof event.payload.id === "string" ? event.payload.id : undefined;
    if (!id) continue;
    if (event.name === "plugin/unload" || event.name === "plugin/skip" || event.name === "plugin/transition_failed") {
      active.delete(id);
      continue;
    }
    if (event.name !== "plugin/load") continue;
    active.set(id, {
      package: event.payload.kind === "package",
      prompts: Array.isArray(event.payload.prompts) ? event.payload.prompts.length : 0,
      skills: Array.isArray(event.payload.skills) ? event.payload.skills.length : 0,
    });
  }
  const values = [...active.values()];
  return {
    packages: values.filter((entry) => entry.package).length,
    prompts: values.reduce((sum, entry) => sum + entry.prompts, 0),
    skills: values.reduce((sum, entry) => sum + entry.skills, 0),
  };
}

function projectSession(events: readonly EventRecord[]): SessionStats {
  const walk = usageWalk(events);
  const usages = walk.map((entry) => entry.usage);
  const turnStarts = events.filter((event) => event.name === "agent/step" && event.payload.phase === "turn_start").length;
  const quota = lastQuota(events);
  const quotaSnapshot = lastQuotaSnapshot(events);
  const weekly = quotaSnapshot?.windows.find((window) => window.id === "week");
  const skip = walk.map((entry) => entry.rewarm);
  const track: HitTrack = hitTrack(hitSeriesFromUsages(usages), HIT_WARMUP_TURNS, HIT_FLOOR, skip);
  return {
    turns: turnStarts > 0 ? turnStarts : usages.length,
    in_sum: sumUsage(usages, (row) => row.input_tokens),
    out_sum: sumUsage(usages, (row) => row.output_tokens),
    cache_r_sum: sumUsage(usages, (row) => row.cache_read_tokens),
    cache_w_sum: sumUsage(usages, (row) => row.cache_write_tokens),
    compaction_n: compactionCount(events, usages),
    week_limit: weekly ? 100 : quota?.limit ?? "missing",
    week_used: weekly?.used_percent ?? quota?.used ?? "missing",
    week_used_percent: typeof weekly?.used_percent === "number" ? weekly.used_percent : quota?.used_percent ?? "missing",
    week_resets_at: weekly?.resets_at ?? quota?.resets_at ?? "missing",
    quota_windows: quotaSnapshot?.windows ?? [],
    compact_at: lastCompactAt(events),
    hits: track.series,
    hit_min: track.min,
    hit_max: track.max,
    hit_held: track.held === "missing" ? "missing" : track.held ? "yes" : "no",
    hitSkip: skip,
    ...blobGcSessionTotals(events),
    ...maekSessionTotals(events),
  };
}

function blobGcSessionTotals(events: readonly EventRecord[]): {
  blob_gc_n: number;
  blob_removed_sum: number;
  blob_bytes_freed_sum: number;
} {
  let n = 0;
  let removed = 0;
  let bytes = 0;
  for (const event of events) {
    if (event.name !== "blob/gc_result") {
      continue;
    }
    n += 1;
    if (typeof event.payload.removed === "number") {
      removed += event.payload.removed;
    }
    if (typeof event.payload.bytes_freed === "number") {
      bytes += event.payload.bytes_freed;
    }
  }
  return { blob_gc_n: n, blob_removed_sum: removed, blob_bytes_freed_sum: bytes };
}

function maekSessionTotals(events: readonly EventRecord[]): {
  maek_ingest_n: number;
  maek_query_n: number;
  maek_rebuild_n: number;
  maek_failure_n: number;
} {
  let ingest = 0;
  let query = 0;
  let rebuild = 0;
  let failure = 0;
  for (const event of events) {
    if (event.name === "maek/ingest") {
      ingest += 1;
    }
    if (event.name === "maek/query") {
      query += 1;
    }
    if (event.name === "maek/rebuild") {
      rebuild += 1;
    }
    if (
      event.name === "maek/ingest_failed" ||
      event.name === "maek/query_failed" ||
      event.name === "maek/rebuild_failed"
    ) {
      failure += 1;
    }
  }
  return { maek_ingest_n: ingest, maek_query_n: query, maek_rebuild_n: rebuild, maek_failure_n: failure };
}

function lastMaek(events: readonly EventRecord[]): MaekLast | undefined {
  const latestEvent = [...events].reverse().find((event): event is EventRecord & {
    readonly name: MaekLast["last_name"];
  } =>
    event.name === "maek/ingest" ||
    event.name === "maek/query" ||
    event.name === "maek/ready" ||
    event.name === "maek/rebuild" ||
    event.name === "maek/ingest_failed" ||
    event.name === "maek/query_failed" ||
    event.name === "maek/rebuild_failed"
  );
  if (!latestEvent) return undefined;

  const failureEvent = [...events].reverse().find((event) =>
    event.name === "maek/ingest_failed" ||
    event.name === "maek/query_failed" ||
    event.name === "maek/rebuild_failed"
  );
  const successEvent = [...events].reverse().find((event) =>
    (event.name === "maek/ready" && event.payload.status === "ready") ||
    (event.name === "maek/query" && event.payload.format === 1)
  );
  const failed = failureEvent !== undefined &&
    (successEvent === undefined || failureEvent.seq > successEvent.seq);
  const sourceSeq = successEvent?.payload.source_seq;
  const stale = !failed && successEvent !== undefined &&
    typeof sourceSeq === "number" && Number.isInteger(sourceSeq) &&
    events.some((event) => event.seq > sourceSeq && !event.name.startsWith("maek/"));
  const rows = successEvent?.name === "maek/query"
    ? successEvent.payload.row_count
    : successEvent?.payload.rows;

  return {
    last_name: latestEvent.name,
    last_kind: typeof latestEvent.payload.kind === "string" ? latestEvent.payload.kind : "missing",
    state: failed ? "failed" : stale || !successEvent ? "stale" : "ready",
    ...(typeof rows === "number" ? { rows } : {}),
    ...(failed && typeof failureEvent?.payload.stage === "string"
      ? { failure_stage: failureEvent.payload.stage }
      : {}),
  };
}

function lastSwarmMemory(events: readonly EventRecord[]): SwarmMemoryDashboardState | undefined {
  let selected: ParsedSwarmMemoryDashboardState | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || (event.name !== "swarm/memory_view" && event.name !== "swarm/memory_bound")) continue;
    selected = parseSwarmMemoryDashboardState(event);
    if (selected) break;
  }
  if (!selected) return undefined;

  let childStatus: SwarmMemoryDashboardState["childStatus"];
  if (selected.binding === "recorded") {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event || event.seq <= selected.seq || event.name !== "swarm/memory_verified") continue;
      const verified = parseSwarmMemoryVerification(event);
      if (!verified || verified.viewDigest !== selected.viewDigest || verified.blobDigest !== selected.blobDigest) {
        continue;
      }
      childStatus = verified.status;
      break;
    }
  }
  return {
    schema: 1,
    repositoryAlias: digestAlias(selected.repositoryDigest),
    sourceRevision: digestAlias(selected.sourceSnapshotDigest),
    viewAlias: digestAlias(selected.viewDigest),
    sufficiency: selected.sufficiency,
    sections: selected.sections,
    binding: selected.binding,
    providers: selected.providers,
    ...(childStatus ? { childStatus } : {}),
  };
}

interface ParsedSwarmMemoryDashboardState {
  readonly seq: number;
  readonly viewDigest: string;
  readonly repositoryDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly blobDigest: string;
  readonly sufficiency: "sufficient" | "insufficient";
  readonly sections: number;
  readonly binding: "recorded" | "bound";
  readonly providers: SwarmMemoryProviderDashboardState[];
}

interface ParsedSwarmMemoryVerification {
  readonly viewDigest: string;
  readonly blobDigest: string;
  readonly status: "ok" | "missing" | "mismatch";
}

const SWARM_MEMORY_DIGEST = /^[a-f0-9]{64}$/u;
const SWARM_MEMORY_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SWARM_MEMORY_ALIAS_LENGTH = 12;

function parseSwarmMemoryDashboardState(event: EventRecord): ParsedSwarmMemoryDashboardState | undefined {
  if (event.kind !== "observe") return undefined;
  const binding = event.name === "swarm/memory_bound" ? "bound" : "recorded";
  const expected = binding === "bound"
    ? [
        "blob",
        "blob_bytes",
        "child_session",
        "dispatch_digest",
        "format",
        "providers",
        "repository_digest",
        "section_count",
        "source_snapshot_digest",
        "sufficiency",
        "view_digest",
      ]
    : [
        "blob",
        "blob_bytes",
        "format",
        "providers",
        "repository_digest",
        "section_count",
        "source_snapshot_digest",
        "sufficiency",
        "view_digest",
      ];
  if (!hasExactKeys(event.payload, expected) || event.payload.format !== 1) return undefined;
  const viewDigest = exactDigest(event.payload.view_digest);
  const repositoryDigest = exactDigest(event.payload.repository_digest);
  const sourceSnapshotDigest = exactDigest(event.payload.source_snapshot_digest);
  const blobDigest = exactDigest(event.payload.blob);
  if (!viewDigest || !repositoryDigest || !sourceSnapshotDigest || !blobDigest) return undefined;
  if (binding === "bound" &&
    (typeof event.payload.child_session !== "string" || event.payload.child_session.length === 0 ||
      !exactDigest(event.payload.dispatch_digest))) {
    return undefined;
  }
  const sections = event.payload.section_count;
  const blobBytes = event.payload.blob_bytes;
  const sufficiency = event.payload.sufficiency;
  if (!Number.isSafeInteger(sections) || Number(sections) < 0 || Number(sections) > 8 ||
    !Number.isSafeInteger(blobBytes) || Number(blobBytes) < 1 || Number(blobBytes) > 32_000 ||
    (sufficiency !== "sufficient" && sufficiency !== "insufficient")) {
    return undefined;
  }
  const providers = parseSwarmMemoryProviders(event.payload.providers, Number(sections));
  if (!providers) return undefined;
  return {
    seq: event.seq,
    viewDigest,
    repositoryDigest,
    sourceSnapshotDigest,
    blobDigest,
    sufficiency,
    sections: Number(sections),
    binding,
    providers,
  };
}

function parseSwarmMemoryProviders(
  value: unknown,
  sections: number,
): SwarmMemoryProviderDashboardState[] | undefined {
  if (!Array.isArray(value) || value.length !== sections) return undefined;
  const ids = new Set<string>();
  const providers: SwarmMemoryProviderDashboardState[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const provider = raw as Record<string, unknown>;
    if (!hasExactKeys(provider, ["provider_id", "selection_count", "source_revision_digest"])) return undefined;
    const id = provider.provider_id;
    const revision = exactDigest(provider.source_revision_digest);
    const selections = provider.selection_count;
    if (typeof id !== "string" || !SWARM_MEMORY_PROVIDER.test(id) || ids.has(id) || !revision ||
      !Number.isSafeInteger(selections) || Number(selections) < 0 || Number(selections) > 16) {
      return undefined;
    }
    ids.add(id);
    providers.push({ id, sourceRevision: digestAlias(revision), selections: Number(selections) });
  }
  return providers;
}

function parseSwarmMemoryVerification(event: EventRecord): ParsedSwarmMemoryVerification | undefined {
  if (event.kind !== "observe" || !hasExactKeys(event.payload, [
    "blob_digest",
    "child_session",
    "dispatch_digest",
    "status",
    "view_digest",
  ])) {
    return undefined;
  }
  const viewDigest = exactDigest(event.payload.view_digest);
  const blobDigest = exactDigest(event.payload.blob_digest);
  const dispatchDigest = exactDigest(event.payload.dispatch_digest);
  const child = event.payload.child_session;
  const status = event.payload.status;
  if (!viewDigest || !blobDigest || !dispatchDigest || typeof child !== "string" || child.length === 0 ||
    (status !== "ok" && status !== "missing" && status !== "mismatch")) {
    return undefined;
  }
  return { viewDigest, blobDigest, status };
}

function exactDigest(value: unknown): string | undefined {
  return typeof value === "string" && SWARM_MEMORY_DIGEST.test(value) ? value : undefined;
}

function digestAlias(digest: string): string {
  return digest.slice(0, SWARM_MEMORY_ALIAS_LENGTH);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function lastBlobGc(events: readonly EventRecord[]): BlobGcLast | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "blob/gc_result") {
      continue;
    }
    // Pair with the preceding effect when present for on_disk/referenced.
    let onDisk: number | "missing" = "missing";
    let referenced: number | "missing" = "missing";
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = events[j];
      if (prev?.name === "blob/gc" && prev.kind === "effect") {
        onDisk = typeof prev.payload.on_disk === "number" ? prev.payload.on_disk : "missing";
        referenced = typeof prev.payload.referenced === "number" ? prev.payload.referenced : "missing";
        break;
      }
      if (prev?.name === "blob/gc_result") {
        break;
      }
    }
    return {
      removed: typeof event.payload.removed === "number" ? event.payload.removed : 0,
      kept: typeof event.payload.kept === "number" ? event.payload.kept : 0,
      bytes_freed: typeof event.payload.bytes_freed === "number" ? event.payload.bytes_freed : 0,
      dry_run: event.payload.dry_run === true,
      on_disk: onDisk,
      referenced,
    };
  }
  return undefined;
}

function usageRequests(events: readonly EventRecord[]): UsageRequest[] {
  return usageWalk(events).map((entry) => ({
    seq: entry.event.seq,
    ts: entry.at,
    input_tokens: entry.usage.input_tokens,
    output_tokens: entry.usage.output_tokens,
    cache_read_tokens: entry.usage.cache_read_tokens,
    cache_write_tokens: entry.usage.cache_write_tokens,
    hit_ratio: entry.usage.hit_ratio,
    hit: hitOf(entry.usage),
    occupancy: occupancyOf(entry.usage),
    generation: entry.usage.prompt_generation,
    sealed: entry.sealed,
    rewarm: entry.rewarm,
  }));
}

interface UsageWalkEntry {
  event: EventRecord;
  usage: ModelUsage;
  at: number;
  sealed: boolean;
  rewarm: boolean;
}

/** One pass over the log for every usage-derived surface. */
function usageWalk(events: readonly EventRecord[]): UsageWalkEntry[] {
  const out: UsageWalkEntry[] = [];
  let sealedSinceUsage = false;
  let prevAt: number | undefined;
  for (const event of events) {
    if (event.name === "prompt/seal") {
      sealedSinceUsage = true;
      continue;
    }
    const usage = coerceModelUsage(event.observe?.model_usage ?? event.payload.model_usage);
    if (!usage || isHollowUsage(usage)) {
      continue;
    }
    const at = Date.parse(event.ts);
    const gap = prevAt !== undefined && !Number.isNaN(at) ? at - prevAt : 0;
    out.push({
      event,
      usage,
      at: Number.isNaN(at) ? 0 : at,
      sealed: sealedSinceUsage,
      rewarm:
        gap > CACHE_IDLE_EXPIRY_MS &&
        usage.cache_read_tokens === 0,
    });
    if (!Number.isNaN(at)) {
      prevAt = at;
    }
    sealedSinceUsage = false;
  }
  return out;
}

function hostSeriesFrom(events: readonly EventRecord[]): HostSample[] {
  const out: HostSample[] = [];
  for (const event of events) {
    const host = event.observe?.host;
    if (host) {
      out.push(host);
    }
  }
  return out.slice(-60);
}

function sessionUsages(events: readonly EventRecord[]): ModelUsage[] {
  const out: ModelUsage[] = [];
  for (const event of events) {
    const usage = coerceModelUsage(event.observe?.model_usage ?? event.payload.model_usage);
    if (usage && !isHollowUsage(usage)) {
      out.push(usage);
    }
  }
  return out;
}

function sumUsage(usages: readonly ModelUsage[], pick: (row: ModelUsage) => Metric): number | "missing" {
  let total = 0;
  let seen = false;
  for (const usage of usages) {
    const value = pick(usage);
    if (typeof value === "number") {
      total += value;
      seen = true;
    }
  }
  return seen ? total : "missing";
}

function compactionCount(events: readonly EventRecord[], usages: readonly ModelUsage[]): number {
  const starts = events.filter((event) => event.name === "compaction/start" && event.payload.reason !== "in_turn").length;
  if (starts > 0) {
    return starts;
  }
  const seals = events.filter((event) => event.name === "prompt/seal" && event.payload.reason === "compaction").length;
  if (seals > 0) {
    return seals;
  }
  let drops = 0;
  for (let i = 1; i < usages.length; i += 1) {
    const prev = usages[i - 1]?.context_used;
    const curr = usages[i]?.context_used;
    if (typeof prev === "number" && prev > 0 && typeof curr === "number" && curr < prev * 0.7) {
      drops += 1;
    }
  }
  return drops;
}

/**
 * The MODEL panel's identity has to be the model that is running.
 *
 * It was the model that last REPORTED, which is a different thing the moment a
 * route changes. A live run switched to another provider and the panel went on
 * naming the old one — for as long as the new model had not finished a turn,
 * which is exactly the window an operator is watching. Failover has the same
 * shape and worse stakes: the route moves precisely when something is wrong,
 * and the board would name the route that had already failed.
 *
 * The identity is taken from the newest selection. The MEASUREMENTS are not:
 * they belong to the model that produced them, and carrying them across would
 * turn a stale label into a wrong reading. Everything unmeasured reads as
 * missing until the new model reports, which is the truth — nothing has been
 * measured on it yet.
 */
function usageForActiveSelection(
  events: readonly EventRecord[],
  measured: ModelUsage | undefined,
): ModelUsage | undefined {
  let selection: { route?: unknown; model?: unknown } | undefined;
  let selectionSeq = -1;
  let usageSeq = -1;
  for (const event of events) {
    if (event.name === "model/usage") usageSeq = event.seq;
    if (event.name === "model/primary_selection" || event.name === "model/route_transition_result") {
      const payload = event.payload as { active?: unknown; selection?: unknown };
      const active = (payload.active ?? payload.selection) as { route?: unknown; model?: unknown } | undefined;
      if (active && typeof active === "object") {
        selection = active;
        selectionSeq = event.seq;
      }
    }
  }
  if (!selection || selectionSeq <= usageSeq) return measured;
  const route = typeof selection.route === "string" ? selection.route : undefined;
  const model = typeof selection.model === "string" ? selection.model : undefined;
  if (!route && !model) return measured;
  return {
    ...(measured ?? {}),
    provider: route ?? measured?.provider ?? "missing",
    route: route ?? "missing",
    model: model ?? "missing",
    auth: measured?.auth ?? "unknown",
    // Nothing has been measured on this model yet. The previous model's
    // numbers are not this one's.
    input_tokens: "missing",
    output_tokens: "missing",
    reasoning_tokens: "missing",
    cache_read_tokens: "missing",
    cache_write_tokens: "missing",
    prefix_hash: "missing",
    prompt_generation: "missing",
    hit_ratio: "missing",
    context_used: "missing",
    context_window: measured?.context_window ?? "missing",
  } as ModelUsage;
}

function lastQuota(events: readonly EventRecord[]): ModelQuota | undefined {
  // A quota from another provider must never render against the active
  // model's run: find the ACTIVE provider's newest usage, then the newest
  // quota recorded at-or-after it (same-provider). Older foreign quotas -
  // e.g. codex 90% left over in a reused session - stay invisible.
  const activeIdx = (() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.name === "model/usage" && events[i]?.observe?.model_usage?.provider) {
        return i;
      }
    }
    return -1; // no usage at all: providerless log, nothing to mismatch
  })();
  const provider = activeIdx >= 0 ? events[activeIdx]!.observe!.model_usage!.provider : undefined;
  for (let i = events.length - 1; i >= activeIdx; i -= 1) {
    const quota = events[i]?.observe?.model_quota;
    if (quota && (provider === undefined || events[i]?.payload?.provider === provider)) {
      return quota;
    }
  }
  return undefined;
}

function lastQuotaSnapshot(events: readonly EventRecord[]): ModelQuotaSnapshot | undefined {
  let provider: string | undefined;
  let activeIdx = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const usage = events[i]?.observe?.model_usage;
    if (events[i]?.name === "model/usage" && usage?.provider) {
      provider = usage.provider;
      activeIdx = i;
      break;
    }
  }
  for (let i = events.length - 1; i >= activeIdx; i -= 1) {
    const snapshot = events[i]?.observe?.model_quota_snapshot;
    if (snapshot && (provider === undefined || snapshot.provider === provider)) return snapshot;
  }
  return undefined;
}

function lastCompactAt(events: readonly EventRecord[]): Metric {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "compaction/start" || event.payload.reason === "in_turn") {
      continue;
    }
    const budget = event.payload.budget_tokens;
    if (typeof budget === "number") {
      return budget;
    }
    const estimate = event.payload.estimated_tokens;
    if (typeof estimate === "number") {
      return estimate;
    }
    const threshold = event.payload.threshold;
    if (typeof threshold === "number") {
      return threshold;
    }
    const tokens = event.payload.tokens;
    if (typeof tokens === "number") {
      return tokens;
    }
  }
  return "missing";
}

interface FreshContext {
  estimate: number;
  budget: Metric;
}

/**
 * After a compaction that no model usage follows yet, the recorded usage
 * still describes the pre-compaction overflow. The honest gauge is the
 * kept_tokens the drop event measured from the rewritten transcript —
 * what the model will actually see — until the next real request lands.
 */
function postCompactionContext(events: readonly EventRecord[]): FreshContext | undefined {
  let lastUsageSeq = -1;
  let dropSeq = -1;
  let keptTokens: number | undefined;
  let budget: Metric = "missing";
  for (const event of events) {
    if (event.name === "model/usage") {
      lastUsageSeq = event.seq;
    }
    if (event.name === "compaction/start" && event.payload.reason !== "in_turn") {
      budget = toMetric(event.payload.budget_tokens);
    }
    if (event.name === "compaction/drop" && event.payload.in_turn !== true) {
      dropSeq = event.seq;
      keptTokens = typeof event.payload.kept_tokens === "number" ? event.payload.kept_tokens : undefined;
    }
  }
  if (dropSeq < 0 || dropSeq < lastUsageSeq || keptTokens === undefined) {
    return undefined;
  }
  return { estimate: keptTokens, budget };
}

/**
 * Refusal reasons for the graph still being negotiated: the latest
 * decompose_retry/plan_host reasons AFTER the last sealed goal (a real
 * digest — "pending" marks the operator order, not a seal).
 */
function planRefusals(events: readonly EventRecord[]): string[] {
  let sealIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event?.name === "work/goal" &&
      typeof event.payload.digest === "string" &&
      event.payload.digest !== "pending"
    ) {
      sealIndex = i;
      break;
    }
  }
  for (let i = events.length - 1; i > sealIndex; i -= 1) {
    const event = events[i];
    if (event?.name === "work/plan_draft_result" && Array.isArray(event.payload.errors)) {
      return event.payload.errors.map(String);
    }
    if (event?.name === "work/plan_refused" && Array.isArray(event.payload.errors)) {
      return event.payload.errors.map(String);
    }
    if (event?.name === "work/plan_stopped" && Array.isArray(event.payload.errors)) {
      return event.payload.errors.map(String);
    }
    if (event?.name !== "work/step") {
      continue;
    }
    const action = event.payload.action;
    if (action === "accept_replan_admitted") return [];
    if ((action === "accept_replan_retry" || action === "accept_replan_stopped") && Array.isArray(event.payload.errors)) {
      return event.payload.errors.map(String);
    }
    if (action === "decompose_retry" && Array.isArray(event.payload.errors)) {
      return event.payload.errors.map(String);
    }
    if (action === "plan_host" && Array.isArray(event.payload.reason)) {
      return event.payload.reason.map(String);
    }
  }
  return [];
}

function generatingState(
  events: readonly EventRecord[],
  agentStatus: string,
  telemetry: readonly EventRecord[],
): GeneratingState | "missing" {
  if (agentStatus === "failed" || agentStatus === "error" || agentStatus === "idle") {
    return "missing";
  }
  let turnStart: EventRecord | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.name === "assistant/message") {
      return "missing";
    }
    if (event.name === "agent/step") {
      const phase = event.payload.phase;
      if (phase === "turn_start") {
        turnStart = event;
      }
      break;
    }
  }
  if (!turnStart) {
    return "missing";
  }
  // Progress lives in the telemetry stream now, keyed to this turn by
  // timestamp rather than seq — the content log and the telemetry stream have
  // separate seq spaces, and time is what both share.
  const turnStartTs = Date.parse(turnStart.ts);
  let progress: EventRecord | undefined;
  for (let i = telemetry.length - 1; i >= 0; i -= 1) {
    const event = telemetry[i]!;
    if (event.name === "model/progress" && Date.parse(event.ts) >= turnStartTs) {
      progress = event;
      break;
    }
  }
  // No progress heartbeat yet is still an open turn: turn_start is on the
  // log, so the busy state is derivable (constitution 6) and the interactive
  // CLI needs it from the first second. Zero chars, elapsed from the last
  // recorded event — the same fallback the heartbeat path uses.
  const chars = progress && typeof progress.payload.chars === "number" ? progress.payload.chars : 0;
  const thinking =
    progress && typeof progress.payload.thinking_chars === "number" ? progress.payload.thinking_chars : 0;
  const toolChars =
    progress && typeof progress.payload.tool_chars === "number" ? progress.payload.tool_chars : 0;
  const latestTs = Math.max(
    Date.parse(events.at(-1)!.ts),
    telemetry.length > 0 ? Date.parse(telemetry.at(-1)!.ts) : 0,
  );
  const elapsedMs =
    progress && typeof progress.payload.elapsed_ms === "number"
      ? progress.payload.elapsed_ms
      : latestTs - turnStartTs;
  return {
    elapsed_s: Math.max(0, Math.round(elapsedMs / 1000)),
    started_ts: turnStartTs,
    chars,
    thinking_chars: thinking,
    thinking_tail: generatedText(telemetry, turnStartTs, "thinking", progress),
    text_tail: generatedText(telemetry, turnStartTs, "text", progress),
    tool_chars: toolChars,
  };
}

/**
 * Seconds to display for an open generation at wall-clock `now`. The recorded
 * elapsed_ms only advances when a model/progress event lands, so between
 * sparse events the display froze and then jumped (+93s to +99s). The larger
 * of the recorded value and the wall time since turn_start ticks every second
 * at paint cadence; replay passes the replayed event's timestamp as now, so
 * the same log still renders the same screen.
 */
export function generatingElapsedSeconds(generating: GeneratingState, now: number): number {
  const wall = Number.isFinite(generating.started_ts) ? Math.floor((now - generating.started_ts) / 1000) : 0;
  return Math.max(generating.elapsed_s, wall, 0);
}

function projectWork(
  events: readonly EventRecord[],
  agentStatus: string,
  telemetry: readonly EventRecord[],
  // Narrows each helper below to its own event names. `sinceRun` is the whole
  // log whenever the session has no run boundary, which is the common case,
  // so these were fifteen full scans of the session's entire history.
  index: EventIndex = indexOf(events),
): WorkBoard {
  const plan = readPlanFromLog(events);
  const refusals = planRefusals(events);
  const viewEvents = index.ofPrefix("execution_view/");
  const viewLast = viewEvents.filter(row => row.name !== "execution_view/source" && row.name !== "execution_view/cleanup").at(-1);
  const executionViews = viewLast ? `${viewEvents.filter(row => row.name === "execution_view/image").length} images; ${viewEvents.filter(row => row.name === "execution_view/result").length} executions; ${viewLast.name.slice("execution_view/".length)}${typeof viewLast.payload.reason === "string" ? ": " + viewLast.payload.reason : ""}` : undefined;
  const checkerEvents = index.ofPrefix("work/checker_");
  const checkerLast = checkerEvents.at(-1);
  const checkerRevisions = checkerLast ? `${checkerEvents.filter(row => row.name === "work/checker_source").length} retained executions; ${checkerEvents.filter(row => row.name === "work/checker_revision").length} admitted revisions; ${checkerLast.name.slice("work/checker_".length)}${typeof checkerLast.payload.reason === "string" ? ": " + checkerLast.payload.reason : ""}` : undefined;
  const review = [...events].reverse().find(row => row.name === "work/accept" || row.name === "work/review_finalization" || row.name === "work/review_finalization_result");
  const reviewReason = review?.payload.reason_code ?? review?.payload.reason;
  const reviewDecision = review ? `${String(review.payload.decision ?? "finalizing")}${typeof reviewReason === "string" ? ": " + reviewReason : ""}` : undefined;
  const admission = index.ofPrefix("work/plan_draft").filter(row => row.name === "work/plan_draft_result").at(-1);
  const initialRegression = admission?.payload.status === "admitted" && Array.isArray(admission.payload.supplemental_refs)
    && admission.payload.supplemental_refs.length ? `${admission.payload.supplemental_refs.length} supplemental checks admitted with native RED anchors` : undefined;
  const generating = generatingState(events, agentStatus, telemetry);
  const empty: WorkBoard = {
    goalId: "missing",
    goal: "missing",
    digest: lastPlanDigest(events) ?? "missing",
    agent: "dokkabi",
    agentStatus,
    route: lastRoute(events) ?? "missing",
    intending: "missing",
    doing: "missing",
    done: [],
    blocked: [],
    lastUser: lastSurface(index.of("user/message"), "user/message"),
    lastAssistant: lastSurface(index.of("assistant/message"), "assistant/message"),
    lastAssistantFull: lastAssistantFull(index.of("assistant/message")),
    lastAssistantReasoning: lastAssistantReasoning(index.of("assistant/message")),
    lastToolCalls: toolCallViews(index.ofAny("tool/call", "tool/result"), 8),
    lastAssistantHistory: assistantHistory(index.of("assistant/message"), 12),
    heung: lastHeungState(index.ofAny("work/heung", "work/crunch")),
    heungWave: lastHeungWave(events) ?? "missing",
    monkey: lastMonkeyState(index.ofPrefix("monkey/")),
    recipe: lastRecipeState(index.of("market/recipe")),
    search: lastSearchState(index.ofPrefix("search/")),
    planSamples: lastPlanSamplesState(index.ofPrefix("work/plan_")),
    ralphPlan: lastRalphPlan(index.ofPrefix("work/plan_")),
    refusals,
    ...(executionViews ? { executionViews } : {}),
    ...(checkerRevisions ? { checkerRevisions } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(initialRegression ? { initialRegression } : {}),
    generating,
    todos: [],
  };
  if (!plan) {
    return empty;
  }
  const view = viewPlan(plan, events);
  const doing = lastDoing(scopeWorkEvents(plan, events));
  const active = ACTIVE_AGENT.has(agentStatus);
  const doingId =
    active && doing && view.todoState[doing.todo] !== "clear" ? doing.todo : undefined;
  const intending = view.ready.find((id) => id !== doingId);
  const done = plan.todos.filter((todo) => view.todoState[todo.id] === "clear").map((todo) => todo.id);
  const blocked = plan.todos.filter((todo) => view.todoState[todo.id] === "blocked").map((todo) => todo.id);
  return {
    goalId: plan.goal.id,
    goal: plan.goal.statement,
    digest: lastPlanDigest(events) ?? "missing",
    agent: doing?.agent ?? "dokkabi",
    agentStatus,
    route: lastRoute(events) ?? "missing",
    intending: intending ?? "missing",
    doing: doingId ?? "missing",
    done,
    blocked,
    lastUser: lastSurface(index.of("user/message"), "user/message"),
    lastAssistant: lastSurface(index.of("assistant/message"), "assistant/message"),
    lastAssistantFull: lastAssistantFull(index.of("assistant/message")),
    lastAssistantReasoning: lastAssistantReasoning(index.of("assistant/message")),
    lastToolCalls: toolCallViews(index.ofAny("tool/call", "tool/result"), 8),
    lastAssistantHistory: assistantHistory(index.of("assistant/message"), 12),
    heung: lastHeungState(index.ofAny("work/heung", "work/crunch")),
    heungWave: lastHeungWave(events) ?? "missing",
    monkey: lastMonkeyState(index.ofPrefix("monkey/")),
    recipe: lastRecipeState(index.of("market/recipe")),
    search: lastSearchState(index.ofPrefix("search/")),
    planSamples: lastPlanSamplesState(index.ofPrefix("work/plan_")),
    ralphPlan: lastRalphPlan(index.ofPrefix("work/plan_")),
    refusals,
    ...(executionViews ? { executionViews } : {}),
    ...(checkerRevisions ? { checkerRevisions } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(initialRegression ? { initialRegression } : {}),
    generating,
    todos: plan.todos
      .slice()
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((todo) => ({
        id: todo.id,
        title: todo.title,
        class: todo.class,
        priority: todo.priority,
        state: todo.id === doingId ? "doing" : (view.todoState[todo.id] ?? "missing"),
      })),
  };
}

function lastRalphPlan(events: readonly EventRecord[]): RalphPlanBoard | "missing" {
  let state: RalphPlanBoard | undefined;
  for (const event of events) {
    if (event.name === "work/plan_started" && event.payload.mode === "ralph") {
      state = {
        status: "planning",
        pass: 0,
        maxPasses: finiteNumber(event.payload.max_passes),
        role: "scout",
        revision: 0,
        digest: "missing",
        newGaps: 0,
        unknowns: 0,
        contradictions: 0,
      };
      continue;
    }
    if (!state) continue;
    if (event.name === "work/plan_pass" && event.payload.mode === "ralph") {
      state = {
        ...state,
        status: event.payload.role === "critic" ? "reviewing" : event.payload.role === "synthesizer" ? "revising" : "planning",
        pass: finiteNumber(event.payload.pass),
        maxPasses: finiteNumber(event.payload.max_passes),
        role: typeof event.payload.role === "string" ? event.payload.role : "missing",
      };
      continue;
    }
    if (event.name === "work/plan_revision" && event.payload.mode === "ralph") {
      state = {
        ...state,
        status: event.payload.role === "critic" && event.payload.decision === "revise" ? "revising" : state.status,
        pass: finiteNumber(event.payload.pass),
        role: typeof event.payload.role === "string" ? event.payload.role : state.role,
        revision: finiteNumber(event.payload.revision, state.revision),
        digest: typeof event.payload.digest === "string" ? event.payload.digest : state.digest,
        newGaps: finiteCount(event.payload.new_gaps, state.newGaps),
        unknowns: finiteCount(event.payload.unknowns, state.unknowns),
        contradictions: finiteCount(event.payload.contradictions, state.contradictions),
      };
      continue;
    }
    if (event.name === "work/plan_converged" && event.payload.mode === "ralph") {
      state = {
        ...state,
        status: "converged",
        pass: finiteNumber(event.payload.passes),
        revision: finiteNumber(event.payload.revision),
        digest: typeof event.payload.digest === "string" ? event.payload.digest : state.digest,
      };
      continue;
    }
    if (event.name === "work/plan_stopped" && event.payload.mode === "ralph") {
      state = {
        ...state,
        status: "stopped",
        pass: finiteNumber(event.payload.passes),
        ...(typeof event.payload.reason === "string" ? { reason: event.payload.reason } : {}),
      };
    }
  }
  return state ?? "missing";
}

function finiteNumber(value: unknown, fallback: number | "missing" = "missing"): number | "missing" {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function lastHeungState(events: readonly EventRecord[]): "on" | "off" | "missing" {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "work/heung" || events[i]?.name === "work/crunch") {
      return lastHeungOn(events) ? "on" : "off";
    }
  }
  return "missing";
}

/** The latest campaign since the last monkey/start: live progress counts
 * samples; a landed monkey/select is authoritative for k_used and winner. */
function lastRecipeState(events: readonly EventRecord[]): RecipeBoard | "missing" {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "market/recipe") continue;
    if (typeof event.payload.id === "string" && typeof event.payload.digest === "string") {
      return { id: event.payload.id, digest: event.payload.digest };
    }
  }
  return "missing";
}

/** Trials counted since the start of the log (one campaign per search
 * session by construction); a landed select/holdout is authoritative. */
function lastSearchState(events: readonly EventRecord[]): SearchBoard | "missing" {
  let trials = 0;
  let winner: string | "missing" = "missing";
  let stop: string | "missing" = "missing";
  let holdoutCoverage: number | "missing" = "missing";
  let seen = false;
  let selected = false;
  for (const event of events) {
    if (event.name === "search/trial") {
      trials += 1;
      seen = true;
    }
    if (event.name === "search/select") {
      seen = true;
      selected = true;
      if (typeof event.payload.winner === "string") winner = event.payload.winner;
      if (typeof event.payload.stop === "string") stop = event.payload.stop;
      if (typeof event.payload.trials === "number") trials = event.payload.trials;
    }
    if (event.name === "search/holdout" && typeof event.payload.coverage === "number") {
      seen = true;
      holdoutCoverage = event.payload.coverage;
    }
  }
  return seen ? { trials, winner, stop, holdoutCoverage, selected } : "missing";
}

/** The latest ralph-sample campaign since its plan_started (#60 phase 2):
 * a stopped or selected campaign is a verdict; before that, progress. */
function lastPlanSamplesState(events: readonly EventRecord[]): PlanSamplesBoard | "missing" {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name === "work/plan_started" && event.payload.mode === "ralph-sample") {
      start = i;
      break;
    }
  }
  if (start < 0) return "missing";
  const samples = typeof events[start]?.payload.samples === "number"
    ? (events[start]!.payload.samples as number)
    : 0;
  let drawn = 0;
  let passed = 0;
  let winner: number | "missing" = "missing";
  let stop: string | "missing" = "missing";
  for (let i = start + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event?.payload.mode !== "ralph-sample") continue;
    if (event.name === "work/plan_sample") {
      drawn += 1;
      if (event.payload.passed === true) passed += 1;
    }
    if (event.name === "work/plan_selected" && typeof event.payload.winner === "number") {
      winner = event.payload.winner;
    }
    if (event.name === "work/plan_stopped" && typeof event.payload.reason === "string") {
      stop = event.payload.reason;
    }
  }
  return { samples, drawn, passed, winner, stop };
}

function lastMonkeyState(events: readonly EventRecord[]): MonkeyBoard | "missing" {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "monkey/start") {
      start = i;
      break;
    }
  }
  if (start < 0) return "missing";
  const k = typeof events[start]?.payload.k === "number" ? (events[start]!.payload.k as number) : 0;
  let kUsed = 0;
  let winner: string | "missing" = "missing";
  let stop: string | "missing" = "missing";
  for (let i = start + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event?.name === "monkey/sample") kUsed += 1;
    if (event?.name === "monkey/select") {
      if (typeof event.payload.k_used === "number") kUsed = event.payload.k_used;
      if (typeof event.payload.winner === "string") winner = event.payload.winner;
      if (typeof event.payload.stop === "string") stop = event.payload.stop;
    }
  }
  return { k, kUsed, winner, stop };
}

function lastSurface(events: readonly EventRecord[], name: string): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== name) {
      continue;
    }
    const text = typeof event.payload.text === "string" ? event.payload.text.replaceAll("\n", " ").trim() : "";
    const stop = typeof event.payload.stop === "string" ? event.payload.stop : "";
    const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    if (name === "assistant/message") {
      return `stop=${stop || "missing"} ${clipped || "(empty)"}`;
    }
    return clipped || "(empty)";
  }
  return "missing";
}

/** Recent assistant texts, unclipped, oldest→newest — MODEL STREAM history. */
function assistantHistory(events: readonly EventRecord[], limit: number): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event?.name !== "assistant/message") {
      continue;
    }
    const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
    if (text.length > 0) {
      out.push(text);
    }
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

export interface ToolCallView {
  id: string;
  name: string;
  arg_hint?: string;
  args?: Record<string, unknown>;
  result_text?: string;
  result_blob?: string;
  result_error?: boolean;
  missing_reason?: string;
}

/** Tool calls joined with their results, newest last, capped for the pane. */
function toolCallViews(events: readonly EventRecord[], limit: number): ToolCallView[] {
  const byId = new Map<string, ToolCallView>();
  const order: string[] = [];
  for (const event of events) {
    if (event.name === "tool/call" && typeof event.payload.id === "string") {
      const id = event.payload.id;
      const view: ToolCallView = {
        id,
        name: typeof event.payload.name === "string" ? event.payload.name : "tool",
        ...(typeof event.payload.arg_hint === "string" ? { arg_hint: event.payload.arg_hint } : {}),
        ...(isArgsObject(event.payload.args) ? { args: event.payload.args } : {}),
      };
      byId.set(id, view);
      order.push(id);
    }
    if (event.name === "tool/result" && typeof event.payload.id === "string") {
      const view = byId.get(event.payload.id);
      if (view) {
        view.result_text = typeof event.payload.text === "string" ? event.payload.text : undefined;
        view.result_error = event.payload.error === true;
        if (typeof event.payload.blob === "string") {
          view.result_blob = event.payload.blob;
        }
      }
    }
  }
  return order
    .slice(-limit)
    .map((id) => {
      const view = byId.get(id)!;
      if (view.result_text === undefined) {
        view.missing_reason = view.result_blob ? "blob" : "pending";
      }
      return view;
    });
}

function isArgsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The latest assistant text, unclipped — the MODEL STREAM pane body. */
function lastAssistantFull(events: readonly EventRecord[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "assistant/message") {
      continue;
    }
    const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function lastRoute(events: readonly EventRecord[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const route = events[i]?.payload.route;
    if (typeof route === "string") {
      return route;
    }
  }
  return undefined;
}

/** Events after the last sweep run boundary: swe/baseline opens a run. */
function sinceLastRunBoundary(events: readonly EventRecord[]): EventRecord[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "swe/baseline") {
      return events.slice(i);
    }
  }
  return events.slice();
}

function sinceLastSessionOpen(events: readonly EventRecord[]): EventRecord[] {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "session/open") {
      start = i;
      break;
    }
  }
  return events.slice(start);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function lastError(events: readonly EventRecord[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const error = event?.payload.error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
  }
  return undefined;
}

function lastModelUsage(events: readonly EventRecord[]): ModelUsage | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const observed = coerceModelUsage(event.observe?.model_usage);
    if (observed && !isHollowUsage(observed)) {
      return observed;
    }
    const payloadObserve = isRecord(event.payload.observe) ? event.payload.observe.model_usage : undefined;
    const payloadUsage = event.payload.model_usage ?? payloadObserve;
    const fromPayload = coerceModelUsage(payloadUsage);
    if (fromPayload && !isHollowUsage(fromPayload)) {
      return fromPayload;
    }
  }
  return undefined;
}

function coerceModelUsage(input: unknown): ModelUsage | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const payload = input as Record<string, unknown>;
  const auth = payload.auth === "plan_key" ? "plan_key" : "oauth";
  const contextUsed = toMetric(payload.context_used);
  const inputTokens = toMetric(payload.input_tokens);
  return {
    provider: typeof payload.provider === "string" ? payload.provider : "missing",
    model: typeof payload.model === "string" ? payload.model : "missing",
    auth,
    route: typeof payload.route === "string" ? payload.route : "missing",
    input_tokens: toMetric(payload.input_tokens),
    output_tokens: toMetric(payload.output_tokens),
    reasoning_tokens: toMetric(payload.reasoning_tokens),
    cache_read_tokens: toMetric(payload.cache_read_tokens),
    cache_write_tokens: toMetric(payload.cache_write_tokens),
    prefix_hash: typeof payload.prefix_hash === "string" ? payload.prefix_hash : "missing",
    prompt_generation: typeof payload.prompt_generation === "number" ? payload.prompt_generation : "missing",
    hit_ratio: toMetric(payload.hit_ratio),
    context_window: toMetric(payload.context_window),
    context_used: occupancyOf({
      input_tokens: inputTokens,
      cache_read_tokens: toMetric(payload.cache_read_tokens),
      cache_write_tokens: toMetric(payload.cache_write_tokens),
      context_used: contextUsed,
    }),
    // The sampling temperature is the monkey campaign's recorded diversity
    // source (#59 S4); rebuilding the object must not drop it.
    ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}),
  };
}

function isHollowUsage(usage: ModelUsage): boolean {
  return (
    usage.input_tokens === "missing" &&
    usage.output_tokens === "missing" &&
    usage.context_used === "missing"
  );
}

function toMetric(value: unknown): Metric {
  if (typeof value === "number") {
    return value;
  }
  return value === "missing" ? "missing" : "missing";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastHost(events: readonly EventRecord[]): HostSample | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const host = events[i]?.observe?.host;
    if (host) {
      return host;
    }
  }
  return undefined;
}

function lastPluginDigest(events: readonly EventRecord[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const digest = events[i]?.observe?.plugin?.digest;
    if (digest) {
      return digest;
    }
  }
  return undefined;
}

function lastString(events: readonly EventRecord[], key: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const value = events[i]?.payload[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function lastAgentStatus(events: readonly EventRecord[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "agent/status" && typeof events[i]?.payload.status === "string") {
      return events[i]?.payload.status as string;
    }
  }
  return undefined;
}

function toolRows(events: readonly EventRecord[]): ToolRow[] {
  const out: ToolRow[] = [];
  const started = new Map<string, number>();
  for (const event of events) {
    if (event.name !== "tool/call" && event.name !== "tool/start" && event.name !== "tool/end") {
      continue;
    }
    const phase = event.name.slice("tool/".length) as ToolRow["phase"];
    const name = typeof event.payload.name === "string" ? event.payload.name : event.name;
    const key = typeof event.payload.id === "string" && event.payload.id.length > 0 ? event.payload.id : name;
    const at = Date.parse(event.ts);
    if ((phase === "call" || phase === "start") && !Number.isNaN(at)) {
      started.set(key, at);
    }
    let duration: number | "missing" = "missing";
    if (phase === "end") {
      if (typeof event.payload.duration_ms === "number" && event.payload.duration_ms >= 0) {
        duration = event.payload.duration_ms;
      } else {
        const startMs = started.get(key);
        if (startMs !== undefined && !Number.isNaN(at) && at > startMs) {
          duration = at - startMs;
        }
      }
      started.delete(key);
    }
    out.push({
      name,
      phase,
      seq: event.seq,
      id: typeof event.payload.id === "string" ? event.payload.id : undefined,
      duration_ms: duration,
      error: event.payload.error === true,
      diagnosis: typeof event.payload.diagnosis === "string" ? event.payload.diagnosis : undefined,
      diagnosis_detail:
        typeof event.payload.diagnosis_detail === "string" ? event.payload.diagnosis_detail : undefined,
      harness_ms: typeof event.payload.harness_ms === "number" ? event.payload.harness_ms : undefined,
      command_bound_ms:
        typeof event.payload.command_bound_ms === "number" ? event.payload.command_bound_ms : undefined,
      total_ms: typeof event.payload.total_ms === "number" ? event.payload.total_ms : undefined,
      verdict:
        event.payload.verdict === "model_bound" || event.payload.verdict === "harness_overhead"
          ? event.payload.verdict
          : undefined,
    });
  }
  return out;
}

function toolSlowRows(events: readonly EventRecord[]): ToolSlowRow[] {
  const out: ToolSlowRow[] = [];
  for (const event of events) {
    if (event.name !== "tool/slow") {
      continue;
    }
    const duration = event.payload.duration_ms;
    if (typeof duration !== "number") {
      continue;
    }
    out.push({
      name: typeof event.payload.name === "string" ? event.payload.name : "missing",
      seq: event.seq,
      duration_ms: duration,
      reason: typeof event.payload.reason === "string" ? event.payload.reason : "missing",
      result_bytes: typeof event.payload.result_bytes === "number" ? event.payload.result_bytes : "missing",
      waited_ms: typeof event.payload.waited_ms === "number" ? event.payload.waited_ms : undefined,
    });
  }
  return out;
}

function toolMaxByName(rows: readonly ToolRow[]): ToolMax[] {
  const max = new Map<string, number>();
  for (const row of rows) {
    if (row.phase !== "end" || row.duration_ms === "missing") {
      continue;
    }
    const current = max.get(row.name);
    if (current === undefined || row.duration_ms > current) {
      max.set(row.name, row.duration_ms);
    }
  }
  return [...max.entries()]
    .map(([name, max_ms]) => ({ name, max_ms }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function lastCompactionActive(
  events: readonly EventRecord[],
  agentStatus: string,
): "yes" | "no" | "unsealed" {
  if (agentStatus === "compacting") {
    return "yes";
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    if (
      (event.name === "compaction/start" && event.payload.reason === "in_turn") ||
      (event.name === "compaction/drop" && event.payload.in_turn === true)
    ) {
      continue;
    }
    if (event.name === "prompt/seal" && event.payload.reason === "compaction") {
      return "no";
    }
    if (event.name === "compaction/end") {
      return "no";
    }
    if (event.name.startsWith("compaction/")) {
      // A finished compaction must be closed by a seal (docs/cache.md:
      // a compaction without a seal is a kernel bug). Say so instead of
      // silently claiming it is still running.
      return event.name === "compaction/drop" ? "unsealed" : "yes";
    }
  }
  return occupancyDropped(events) ? "yes" : "no";
}

function occupancyDropped(events: readonly EventRecord[]): boolean {
  const occupancies: number[] = [];
  for (let i = events.length - 1; i >= 0 && occupancies.length < 2; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const raw = event.observe?.model_usage ?? event.payload.model_usage;
    const usage = coerceModelUsage(raw);
    if (!usage || isHollowUsage(usage) || typeof usage.context_used !== "number") {
      continue;
    }
    occupancies.push(usage.context_used);
  }
  const current = occupancies[0];
  const previous = occupancies[1];
  if (typeof current !== "number" || typeof previous !== "number" || previous <= 0) {
    return false;
  }
  return current < previous * 0.7;
}

function compactionRows(events: readonly EventRecord[]): CompactionRow[] {
  const out: CompactionRow[] = [];
  let beforeTokens: number | undefined;
  for (const event of events) {
    if (
      (event.name === "compaction/start" && event.payload.reason === "in_turn") ||
      (event.name === "compaction/drop" && event.payload.in_turn === true)
    ) {
      continue;
    }
    if (!event.name.startsWith("compaction/") && !(event.name === "prompt/seal" && event.payload.reason === "compaction")) {
      continue;
    }
    if (event.name === "compaction/start") {
      beforeTokens = typeof event.payload.estimated_tokens === "number" ? event.payload.estimated_tokens : undefined;
    }
    out.push({
      name: event.name,
      seq: event.seq,
      reason: typeof event.payload.reason === "string" ? event.payload.reason : undefined,
      ...(beforeTokens !== undefined ? { beforeTokens } : {}),
      ...(typeof event.payload.kept_tokens === "number" ? { afterTokens: event.payload.kept_tokens } : {}),
      ...(typeof event.payload.dropped_messages === "number" ? { droppedMessages: event.payload.dropped_messages } : {}),
      ...(typeof event.payload.status === "string" ? { status: event.payload.status } : {}),
    });
    if (event.name === "compaction/end" || event.name === "prompt/seal") beforeTokens = undefined;
  }
  return out;
}

/** Absent provider fields render as "-" (TUI review: the word "missing"
 * repeated across six panes is noise, not honesty — the footer carries the
 * legend). The projection keeps "missing" internally; only display masks. */
export function fmtMetric(value: Metric | string | undefined): string {
  if (value === undefined || value === "missing") {
    return "-";
  }
  return String(value);
}

/** Latest assistant thinking text; "missing" when the provider returned none. */
function lastAssistantReasoning(events: readonly EventRecord[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.name !== "assistant/message") {
      continue;
    }
    const thinking = typeof event.payload.thinking === "string" ? event.payload.thinking.trim() : "";
    if (thinking.length > 0) {
      return thinking;
    }
    return "missing";
  }
  return "missing";
}
