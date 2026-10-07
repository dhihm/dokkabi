import { classifySweBlame } from "../eval/swe-bench/adapter.ts";
import { lspDiagnosticsLine } from "../host/lsp/stats.ts";
import { lspNavigationLine } from "../host/lsp/navigation-stats.ts";
import { readBatchLine } from "../host/read-batch.ts";
import { earlyReadLine } from "../host/received-calls.ts";
import {
  cacheHitRatio,
  fmtHitPercent,
  fmtHitSeries,
  HIT_FLOOR,
  hitOf,
  hitTrack,
  isWarmupContext,
  type HitSample,
} from "../host/hit-ratio.ts";
import { formatPlanShow } from "../work/show.ts";
import { renderTodoDag } from "./dag.ts";
import { fmtDuration } from "./glyphs.ts";
import { eventDelta, eventLane, eventLaneTone } from "./scan.ts";
import { statusBadge, toneForLine } from "./status.ts";
import {
  fmtMetric,
  generatingElapsedSeconds,
  type DashProjection,
  type SwarmMemoryDashboardState,
  type WorkTodoRow,
} from "./project.ts";
import type { EventRecord, ModelUsage, Metric } from "../host/schema.ts";
import { containsPrivateInfrastructure, containsSecret } from "../host/redact.ts";
import type { Tone } from "./screen.ts";

const LOW_HIT_THRESHOLD = 0.7;

type CacheCause = "low_hit" | "ok" | "missing";
type CacheCauseDetail =
  | "recorded"
  | "legacy_ratio"
  | "ratio_recomputed"
  | "prompt_reset"
  | "tool_result"
  | "missing";

interface CacheState {
  hit: Metric | "missing";
  cause: CacheCause;
  detail: CacheCauseDetail;
}

/** One-line goal for the header: SWE orders carry the whole problem
 * statement — wrapping it floods the pane and pushes the DAG out. */
import layoutConfig from "./layout.json";

function clipGoal(statement: string, budget: number = layoutConfig.goalClip.header): string {
  const flat = statement.replaceAll("\n", " ").trim();
  return flat.length > budget ? `${flat.slice(0, budget - 1)}…` : flat;
}

export function workHeaderLines(view: DashProjection): string[] {
  const work = view.work;
  const lines: string[] = [];
  const dream = view.index.of("dream/result").at(-1);
  const approved = view.index.of("dream/approved").at(-1);
  if (dream) lines.push(`dream=${dream.payload.status} source=${String(dream.payload.source_head ?? "").slice(0, 12)} approved=${approved ? "yes" : "no"}`);
  const sourceAudit = view.index.of("research/audit").at(-1);
  if (sourceAudit) lines.push(`source_audit=${sourceAudit.payload.status} through=${sourceAudit.payload.source_through}`);
  if (work.refusals.length > 0) {
    // The graph is being refused and retried: show why, or a stalled
    // decompose loop looks identical to an idle model.
    lines.push(`refused=${work.refusals.length} ${clipGoal(work.refusals.join(" | "))}`);
  }
  if (work.ralphPlan !== "missing") {
    const plan = work.ralphPlan;
    lines.push(
      `ralph_plan=${plan.status} pass=${fmtMetric(plan.pass)}/${fmtMetric(plan.maxPasses)} role=${fmtMetric(plan.role)} revision=${fmtMetric(plan.revision)} digest=${fmtMetric(plan.digest)} gaps=${plan.newGaps} unknowns=${plan.unknowns} contradictions=${plan.contradictions}${plan.reason ? ` reason=${plan.reason}` : ""}`,
    );
  }
  if (view.resume) {
    const state = view.resume.restored ? "restored" : "not-restored";
    const count = view.resume.restored ? `messages=${view.resume.messages}` : `stored=${view.resume.messages}`;
    const detail = view.resume.restored
      ? `source=${view.resume.source ?? "unknown"}`
      : `reason=${view.resume.reason ?? "unknown"}`;
    const mismatches = view.resume.mismatches?.length ? ` mismatches=${view.resume.mismatches.join(",")}` : "";
    lines.push(`resume=${state} ${count} ${detail}${mismatches}${view.resume.work ? ` work=${view.resume.work}` : ""}`);
  }
  // Constitution 6: every field below is on the log. Dropping them from the
  // board (as the STREAM rework did) makes a recorded fact invisible, which
  // is the one thing the dashboard is not allowed to do.
  const heung = work.heung === "missing" ? "" : ` HEUNG=${work.heung} wave=${fmtMetric(work.heungWave)}`;
  lines.push(`agent=${work.agent} status=${fmtMetric(work.agentStatus)} route=${fmtMetric(work.route)}${heung}`);
  if (work.recipe !== "missing") {
    lines.push(`recipe ${work.recipe.id} digest=${work.recipe.digest.slice(0, 12)}`);
  }
  if (work.search !== "missing") {
    // no-winner is a verdict, not progress: it renders once a select landed
    // — winnerless-done included (PR #94 review M6); live says searching.
    const pick = work.search.winner !== "missing"
      ? `winner=${work.search.winner}`
      : work.search.selected || work.search.stop !== "missing"
        ? "no-winner"
        : "searching";
    const stop = work.search.stop !== "missing" ? ` stop=${work.search.stop}` : "";
    const holdout = work.search.holdoutCoverage !== "missing"
      ? ` holdout=${work.search.holdoutCoverage.toFixed(2)}`
      : "";
    lines.push(`search trials=${work.search.trials} ${pick}${stop}${holdout}`);
  }
  if (work.planSamples !== "missing") {
    const plan = work.planSamples;
    const pick = plan.winner !== "missing"
      ? `winner=${plan.winner}`
      : plan.stop !== "missing"
        ? ""
        : "drawing";
    const stop = plan.stop !== "missing" ? ` stop=${plan.stop}` : "";
    lines.push(`ralph_sample k=${plan.drawn}/${plan.samples} passed=${plan.passed}${pick ? ` ${pick}` : ""}${stop}`);
  }
  if (work.monkey !== "missing") {
    // coverage=0 is a verdict, not a progress state: it renders only once a
    // monkey/select landed (stop is recorded); a live campaign says sampling.
    const pick = work.monkey.winner !== "missing"
      ? `winner=${work.monkey.winner}`
      : work.monkey.stop !== "missing"
        ? "coverage=0"
        : "sampling";
    const stop = work.monkey.stop !== "missing" ? ` stop=${work.monkey.stop}` : "";
    lines.push(`monkey k=${work.monkey.kUsed}/${work.monkey.k} ${pick}${stop}`);
  }
  lines.push(`plan_digest=${fmtMetric(work.digest)}`);
  lines.push(
    `next=${fmtMetric(work.intending)}   now=${fmtMetric(work.doing)}   done=${
      work.done.join(",") || "(none)"
    }   blocked=${work.blocked.join(",") || "(none)"}`,
  );
  lines.push(`goal=${fmtMetric(work.goalId)}  ${clipGoal(work.goal === "missing" ? "-" : work.goal)}`);
  const fail = lastFailLine(view);
  if (fail) {
    lines.push(fail);
  }
  return lines;
}

/** One line naming the newest failed tool call and the tail of its output. */
export function lastFailLine(view: DashProjection): string | undefined {
  const failed = [...view.work.lastToolCalls].reverse().find((call) => call.result_error === true);
  if (!failed) {
    return undefined;
  }
  const tail =
    failed.result_text
      ?.trim()
      .split("\n")
      .filter((row) => row.trim().length > 0)
      .at(-1) ?? "";
  return `last_fail=${failed.name}: ${tail.slice(0, 110)}`;
}

/**
 * The header's one-glance activity: what the session is doing RIGHT NOW.
 * An open generation outranks a running tool outranks the recorded agent
 * status (TUI review: a small status=idle hides thinking vs executing).
 */
export function activityBadge(view: DashProjection, now?: number): string {
  const generating = view.work.generating;
  if (generating !== "missing") {
    const elapsedS = now === undefined ? generating.elapsed_s : generatingElapsedSeconds(generating, now);
    return `generating +${elapsedS}s`;
  }
  const lastTool = view.tools.at(-1);
  if (lastTool && lastTool.phase === "start") {
    return `tool:${lastTool.name}`;
  }
  // An open verify pass: work/verify start with no completed verify step
  // after it. Minutes of host-side pytest are work, not idleness.
  for (let i = view.events.length - 1; i >= 0; i -= 1) {
    const event = view.events[i]!;
    if (event.name === "work/step" && event.payload.action === "verify") {
      break;
    }
    if (event.name === "work/verify" && event.payload.phase === "start") {
      return "verifying";
    }
  }
  return view.work.agentStatus;
}

export function workGraphLines(view: DashProjection, cols: number): string[] {
  if (!view.plan || view.plan.todos.length === 0) {
    return [];
  }
  const doing = view.work.doing !== "missing" ? view.work.doing : undefined;
  const states: Record<string, string> = {};
  for (const todo of view.plan.todos) {
    const row = view.work.todos.find((item) => item.id === todo.id);
    states[todo.id] = todo.id === doing ? "doing" : row?.state ?? "ready";
  }
  const drawn = renderTodoDag(view.plan.todos, states, cols);
  return Array.isArray(drawn) ? drawn : drawn.lines;
}

export function workDetailLines(view: DashProjection, opts: { collapse?: boolean } = {}): string[] {
  const work = view.work;
  const lines: string[] = [];
  if (view.plan) {
    const doing = work.doing !== "missing" ? work.doing : undefined;
    lines.push(
      ...formatPlanShow(view.plan, view.events, { doing, collapse: opts.collapse })
        .trimEnd()
        .split("\n"),
    );
  } else if (work.todos.length === 0) {
    lines.push("todos=(none)");
  } else {
    for (const todo of work.todos) {
      lines.push(todoLine(todo));
    }
  }
  lines.push(`last_user=${fmtMetric(work.lastUser)}`);
  lines.push(`last_assistant=${fmtMetric(work.lastAssistant)}`);
  return lines;
}

export function workLines(view: DashProjection): string[] {
  return [...workHeaderLines(view), ...workGraphLines(view, 88), ...workDetailLines(view)];
}

export function todoLine(todo: WorkTodoRow): string {
  return `${statusBadge(todo.state)} ${todo.id} ${todo.class} p=${todo.priority} ${todo.title}`;
}

function cacheEval(sample: HitSample): CacheState {
  const hitRatio = sample.hit_ratio ?? "missing";
  const derived = hitOf(sample);
  const recorded = typeof hitRatio === "number" && hitRatio >= 0 && hitRatio <= 1 ? hitRatio : undefined;
  if (typeof derived === "number") {
    if (recorded !== undefined && areHitEqual(recorded, derived)) {
      return {
        hit: recorded,
        cause: recorded < LOW_HIT_THRESHOLD ? "low_hit" : "ok",
        detail: "recorded",
      };
    }
    // A row recorded before #76 folded `cache_write` into the denominator
    // matches the OLD formula exactly. That is not a recomputation anomaly,
    // it is a row from an earlier convention, and calling it one lit up 678
    // of 710 rows on a single historical session — destroying the signal in
    // exactly the way a flood does. The derived value still wins, because it
    // comes from the raw counts. This label cannot quietly mask a regressed
    // recorder: an argument-dropping call to the loose cacheHitRatio form
    // THROWS at runtime (bun strips types, so the tsc error alone enforced
    // nothing) and the recorder itself is mutation-pinned, so a new row
    // matching the old formula can only be a genuinely old row.
    const legacyDerived = cacheHitRatio(sample.input_tokens, sample.cache_read_tokens, "missing");
    const legacy = recorded !== undefined
      && typeof legacyDerived === "number"
      && areHitEqual(recorded, legacyDerived);
    return {
      hit: derived,
      cause: derived < LOW_HIT_THRESHOLD ? "low_hit" : "ok",
      detail: recorded === undefined && typeof hitRatio !== "number"
        ? "recorded"
        : legacy ? "legacy_ratio" : "ratio_recomputed",
    };
  }
  if (recorded !== undefined) {
    return {
      hit: recorded,
      cause: recorded < LOW_HIT_THRESHOLD ? "low_hit" : "ok",
      detail: "recorded",
    };
  }
  return {
    hit: "missing",
    cause: "missing",
    detail: "missing",
  };
}

function cacheEvalFromHistory(events: readonly EventRecord[], usage: ModelUsage): CacheState {
  const base = cacheEval(usage);
  if (base.cause !== "low_hit") {
    return base;
  }
  const usages = collectModelUsages(events);
  if (usages.length < 2) {
    return base;
  }
  const currentUsage = usages.at(-1);
  const previousUsage = usages.at(-2);
  if (!currentUsage || !previousUsage) {
    return base;
  }
  const currentSeal = lastPromptSealBefore(events, currentUsage.index);
  const previousSeal = lastPromptSealBefore(events, previousUsage.index);
  if (
    currentSeal !== undefined &&
    previousSeal !== undefined &&
    hasPromptReset(previousSeal, currentSeal)
  ) {
    return {
      ...base,
      detail: "prompt_reset",
    };
  }
  if (
    currentUsage.usage.prompt_generation === previousUsage.usage.prompt_generation &&
    typeof currentUsage.usage.prompt_generation === "number" &&
    currentUsage.usage.prefix_hash !== previousUsage.usage.prefix_hash
  ) {
    return {
      ...base,
      detail: "tool_result",
    };
  }
  return base;
}

interface PromptSealState {
  reason: string;
  prefixHash: string;
  promptGeneration: number | "missing";
}

function hasPromptReset(before: PromptSealState, after: PromptSealState): boolean {
  return before.reason !== after.reason || before.promptGeneration !== after.promptGeneration || before.prefixHash !== after.prefixHash;
}

function lastPromptSealBefore(events: readonly EventRecord[], limitExclusive: number): PromptSealState | undefined {
  for (let i = limitExclusive - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.name !== "prompt/seal") {
      continue;
    }
    return {
      reason: typeof event.payload.reason === "string" ? event.payload.reason : "missing",
      prefixHash: typeof event.payload.prefix_hash === "string" ? event.payload.prefix_hash : "missing",
      promptGeneration:
        typeof event.payload.prompt_generation === "number" ? event.payload.prompt_generation : "missing",
    };
  }
  return undefined;
}

interface IndexedUsage {
  index: number;
  usage: ModelUsage;
}

function collectModelUsages(events: readonly EventRecord[]): IndexedUsage[] {
  const out: IndexedUsage[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const usage = coerceModelUsage(events[i]?.observe?.model_usage ?? events[i]?.payload?.model_usage);
    if (usage && !isHollowUsage(usage)) {
      out.push({ index: i, usage });
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMetric(value: unknown): Metric {
  if (typeof value === "number") {
    return value;
  }
  return value === "missing" ? "missing" : "missing";
}

function coerceModelUsage(input: unknown): ModelUsage | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const auth = input.auth === "plan_key" ? "plan_key" : "oauth";
  return {
    provider: typeof input.provider === "string" ? input.provider : "missing",
    model: typeof input.model === "string" ? input.model : "missing",
    auth,
    route: typeof input.route === "string" ? input.route : "missing",
    input_tokens: toMetric(input.input_tokens),
    output_tokens: toMetric(input.output_tokens),
    reasoning_tokens: toMetric(input.reasoning_tokens),
    cache_read_tokens: toMetric(input.cache_read_tokens),
    cache_write_tokens: toMetric(input.cache_write_tokens),
    prefix_hash: typeof input.prefix_hash === "string" ? input.prefix_hash : "missing",
    prompt_generation: typeof input.prompt_generation === "number" ? input.prompt_generation : "missing",
    hit_ratio: toMetric(input.hit_ratio),
    context_window: toMetric(input.context_window),
    context_used: toMetric(input.context_used),
    // The sampling temperature is the monkey campaign's recorded diversity
    // source (#59 S4); rebuilding the object must not drop it.
    ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
  };
}

function isHollowUsage(usage: ModelUsage): boolean {
  return (
    usage.input_tokens === "missing" &&
    usage.output_tokens === "missing" &&
    usage.context_used === "missing"
  );
}

function areHitEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-12;
}

const EMPTY_SAMPLE: HitSample = { input_tokens: "missing", cache_read_tokens: "missing" };

export function usageLines(view: DashProjection): string[] {
  const usage = view.usage;
  if (!usage) {
    return [
      "provider=- model=- auth=- route=-",
      `in=- out=- reason=- cache_r=- cache_w=- hit=- cause=${fmtMetric(cacheEval(EMPTY_SAMPLE).cause)} cause_detail=${fmtMetric(cacheEval(EMPTY_SAMPLE).detail)}`,
      "prefix=- gen=-",
      `ctx=current(-)/max - (-)`,
      compactionLine(view),
      ...sessionLines(view),
    ];
  }
  const hitEval = cacheEvalFromHistory(view.events, usage);
  return [
    `provider=${fmtMetric(usage.provider)} model=${fmtMetric(usage.model)} auth=${usage.auth} route=${fmtMetric(usage.route)}`,
    `in=${fmtMetric(usage.input_tokens)} out=${fmtMetric(usage.output_tokens)} reason=${fmtMetric(usage.reasoning_tokens)} cache_r=${fmtMetric(usage.cache_read_tokens)} cache_w=${fmtMetric(usage.cache_write_tokens)} hit=${fmtHitRatio(usage)} cause=${fmtMetric(hitEval.cause)} cause_detail=${fmtMetric(hitEval.detail)}`,
    `prefix=${fmtMetric(usage.prefix_hash)} gen=${fmtMetric(usage.prompt_generation)}`,
    contextLine(usage.context_used, usage.context_window),
    compactionLine(view),
    ...sessionLines(view),
  ];
}

export function contextLine(
  used: number | "missing" | undefined,
  max: number | "missing" | undefined,
  label = "current",
): string {
  const current = formatMetricK(used ?? "missing");
  const window = formatMetricK(max ?? "missing");
  return `ctx=${label}(${current})/max ${window} (${contextPercent(used ?? "missing", max ?? "missing")})`;
}

export function usagePaneLines(view: DashProjection, opts: { debug?: boolean } = {}): string[] {
  const usage = view.usage;
  const debugLines = opts.debug === true ? [...debugSessionLines(view), ...contextLayersLines(view)] : [];
  if (!usage) {
    return [
      "provider=- model=-",
      "auth=- route=-",
      compactionLine(view),
      contextReliefLine(view),
      contextLine("missing", "missing"),
      "in=- out=- reason=-",
      "cache_r=- cache_w=- hit=- cause=- cause_detail=-",
      ...headlineSessionLines(view),
      ...debugLines,
    ].filter(Boolean);
  }
  const hitEval = cacheEvalFromHistory(view.events, usage);
  // Priority order: the pane may be small, so the decision lines —
  // hit/in/out then ctx occupancy — must come before auth and session trivia.
  // Raw counters (sums, prefix hash, blob GC, context layers) live behind the
  // d key (TUI review: headline metrics and debug dumps must not share rows).
  return [
    `provider=${fmtMetric(usage.provider)} model=${fmtMetric(usage.model)}`,
    `hit=${fmtHitRatio(usage)} in=${fmtMetric(usage.input_tokens)} out=${fmtMetric(usage.output_tokens)}`,
    `${contextLine(usage.context_used, usage.context_window, view.compactionFresh ? "post-compaction est" : "current")} cache_r=${fmtMetric(usage.cache_read_tokens)} cache_w=${fmtMetric(usage.cache_write_tokens)}`,
    `auth=${usage.auth} route=${fmtMetric(usage.route)}`,
    ...headlineSessionLines(view),
    compactionLine(view),
    contextReliefLine(view),
    ...debugLines,
  ].filter(Boolean);
}

export function contextReliefLine(view: DashProjection): string {
  for (let i = view.events.length - 1; i >= 0; i -= 1) {
    const event = view.events[i];
    if (event?.name !== "context/slim" && event?.name !== "context/prune") continue;
    const before = event.payload.before_tokens;
    const after = event.payload.after_tokens;
    if (typeof before !== "number" || typeof after !== "number") return "";
    const action = event.name.slice("context/".length);
    return `context=${action} ${formatMetricK(before)}→${formatMetricK(after)}`;
  }
  return "";
}

export function contextLayersLines(view: DashProjection): string[] {
  const layers = view.contextLayers;
  if (!layers) {
    return [];
  }
  const skills = layers.skills ?? 0;
  const total = layers.system + layers.tools + layers.history + skills;
  const pct = (value: number) => (total > 0 ? `${Math.round((value / total) * 100)}%` : "missing%");
  const fmtLayer = (value: number) => (value >= 1000 ? formatMetricK(value) : String(value));
  const prefix = layers.system + layers.tools + skills;
  return [
    `system est ${fmtLayer(layers.system)} (${pct(layers.system)})  tools est ${fmtLayer(layers.tools)} (${pct(layers.tools)})${skills ? `  skills est ${fmtLayer(skills)} (${pct(skills)})` : ""}`,
    `history est ${fmtLayer(layers.history)} (${pct(layers.history)})`,
    `prefix est ${fmtLayer(prefix)} (${pct(prefix)})  mutable est ${fmtLayer(layers.history)} (${pct(layers.history)})`,
  ];
}

export function sessionLines(view: DashProjection): string[] {
  return [...headlineSessionLines(view), ...debugSessionLines(view)];
}

/** The one session line an operator reads every glance: turn count and the
 * cache-hit series. */
export function headlineSessionLines(view: DashProjection): string[] {
  const stats = view.sessionStats;
  const track = hitTrack(stats.hits);
  // A sub-floor number inside the warmup zone is the arithmetic, not a cache
  // defect (issue #76) — say so where the number is read.
  const last = view.requests.at(-1);
  const warmup = last !== undefined && isWarmupContext(last);
  return [`turn=${stats.turns} ${fmtHitSeries(track)}${warmup ? " (warmup)" : ""}`];
}

/** Raw counters for the debug drawer (d key): sums, compaction schedule,
 * weekly quota, blob GC totals. */
export function debugSessionLines(view: DashProjection): string[] {
  const stats = view.sessionStats;
  const blobGc = blobGcLine(view);
  const quota = stats.quota_windows.length > 0
    ? `limits=${stats.quota_windows.map((window) => `${window.id}:${typeof window.used_percent === "number" ? `${window.used_percent}%` : "unknown"}${window.resets_at ? `@${window.resets_at.slice(5, 10)}` : ""}`).join(",")}`
    : `week=${stats.week_used_percent !== "missing" ? `${stats.week_used_percent}%/100%` : `${fmtMetric(stats.week_used)}/${fmtMetric(stats.week_limit)}`}${stats.week_resets_at !== "missing" ? ` resets=${stats.week_resets_at.slice(5, 10)}` : ""}`;
  return [
    `in_sum=${fmtMetric(stats.in_sum)} out_sum=${fmtMetric(stats.out_sum)} cache_r_sum=${fmtMetric(stats.cache_r_sum)} cache_w_sum=${fmtMetric(stats.cache_w_sum)} compaction_n=${stats.compaction_n}`,
    `compact_at=${fmtMetric(stats.compact_at)} ${quota}${blobGc ? ` ${blobGc}` : ""}`,
    ...(view.resultSources ? [resultSourceLine(view)] : []),
    ...(view.lspDiagnostics ? [lspDiagnosticsLine(view.lspDiagnostics)] : []),
    ...(view.lspNavigation ? [lspNavigationLine(view.lspNavigation)] : []),
    ...(view.readBatches ? [readBatchLine(view.readBatches)] : []),
    ...(view.earlyReads ? [earlyReadLine(view.earlyReads)] : []),
  ];
}

/** #223: one line of separate byte counts — stored source bytes (each blob
 * once), model-visible bytes, omitted bytes at delivery and by later
 * slimming — and reads by outcome. Bytes, not token estimates. Empty when the
 * session recorded no source. */
export function resultSourceLine(view: DashProjection): string {
  const stats = view.resultSources;
  if (!stats) return "";
  return `result_sources n=${stats.sources} stored=${stats.stored_bytes}B visible=${stats.visible_bytes}B omitted=${stats.omitted_bytes}B slim_omitted=${stats.slim_omitted_bytes}B unstored=${stats.unstored} reads ok=${stats.reads_ok} refused=${stats.reads_refused} unavailable=${stats.reads_unavailable} read=${stats.read_bytes}B`;
}

/** One line: ingest/query counts and the latest kind. Empty when MAEK is unused. */
export function maekLine(view: DashProjection): string {
  const stats = view.sessionStats;
  if (
    stats.maek_ingest_n === 0 &&
    stats.maek_query_n === 0 &&
    stats.maek_rebuild_n === 0 &&
    stats.maek_failure_n === 0 &&
    !view.maek &&
    !view.swarmMemory
  ) {
    return "";
  }
  const last = view.maek ? ` last=${view.maek.last_name}/${view.maek.last_kind}` : "";
  const state = view.maek
    ? ` state=${view.maek.state}${view.maek.rows !== undefined ? ` rows=${view.maek.rows}` : ""}`
    : "";
  const stage = view.maek?.failure_stage ? ` stage=${view.maek.failure_stage}` : "";
  const memory = view.swarmMemory ? ` ${swarmMemorySummary(view.swarmMemory)}` : "";
  return `maek ingest=${stats.maek_ingest_n} query=${stats.maek_query_n} rebuild=${stats.maek_rebuild_n} failed=${stats.maek_failure_n}${state}${stage}${memory}${last}`;
}

/** Safe, bounded parent/child memory summary. Every value was validated and
 * shortened by the EventLog projection; section content and selected IDs are
 * deliberately absent from the dashboard type. */
export function swarmMemorySummary(memory: SwarmMemoryDashboardState): string {
  const providers = memory.providers.length > 0
    ? memory.providers
        .map((provider) => `${provider.id}@${provider.sourceRevision}:${provider.selections}`)
        .join(",")
    : "-";
  const child = memory.childStatus ? ` child=${memory.childStatus}` : "";
  return `memory=${memory.sufficiency} schema=${memory.schema} repo=${memory.repositoryAlias} source=${memory.sourceRevision} view=${memory.viewAlias} sections=${memory.sections} providers=${providers} binding=${memory.binding}${child}`;
}

/** One line: runs, totals, and the latest result. Empty when no blob/gc_result yet. */
export function blobGcLine(view: DashProjection): string {
  const stats = view.sessionStats;
  if (stats.blob_gc_n === 0 || !view.blobGc) {
    return "";
  }
  const last = view.blobGc;
  const dry = last.dry_run ? " dry" : "";
  return `blob_gc runs=${stats.blob_gc_n} removed=${stats.blob_removed_sum} freed=${stats.blob_bytes_freed_sum} last=${last.removed}/${last.kept} on_disk=${fmtMetric(last.on_disk)} ref=${fmtMetric(last.referenced)}${dry}`;
}

export function blobGcLines(view: DashProjection, take = 4): string[] {
  const rows = view.events.filter((event) => event.name === "blob/gc_result").slice(-take);
  if (rows.length === 0) {
    return [];
  }
  return rows.map((event) => {
    const removed = typeof event.payload.removed === "number" ? event.payload.removed : "?";
    const kept = typeof event.payload.kept === "number" ? event.payload.kept : "?";
    const bytes = typeof event.payload.bytes_freed === "number" ? event.payload.bytes_freed : "?";
    const dry = event.payload.dry_run === true ? " dry" : "";
    return `${String(event.seq).padStart(4)} blob/gc_result removed=${removed} kept=${kept} freed=${bytes}${dry}`;
  });
}

export function compactionLine(view: DashProjection): string {
  return `compaction=${view.compactionActive}`;
}

export function fmtHitRatio(sample: HitSample | undefined): string {
  // Takes the whole row: loose arguments are how three fix rounds each left a
  // renderer on the pre-#76 arithmetic, one of which put `hit=100%` beside
  // `cause=low_hit` on a single line.
  const state = cacheEval(sample ?? EMPTY_SAMPLE);
  if (typeof state.hit !== "number") {
    return "-";
  }
  return `${Math.min(100, Math.max(0, Math.round(state.hit * 100)))}%`;
}

export function usageBarAscii(view: DashProjection, width = 28): string {
  return asciiBar(contextRatio(view), width);
}

/** Short-terminal chrome: occupancy and compaction must survive even when
 * identity is the only row that fits (operator: the bar "lost" ctx). */
export function modelBarLine(view: DashProjection): string {
  const usage = view.usage;
  const hit = usage
    ? `hit=${fmtHitRatio(usage)}`
    : "hit=-";
  const ctx = contextLine(
    usage?.context_used ?? "missing",
    usage?.context_window ?? "missing",
    view.compactionFresh ? "post-compaction est" : "current",
  );
  const resilience = modelResilienceLine(view);
  return `MODEL ${hit} ${ctx} ${compactionLine(view)}${resilience ? ` ${resilience}` : ""}`;
}

/** EventLog-only failover projection. It intentionally consumes only public,
 * normalized fields; provider error text and live route state are never read. */
/**
 * Settled once per projection, from the seven names it reads.
 *
 * It walked the whole log, twice per paint -- the MODEL line and the detail
 * pane both ask -- which on a 119,000-event session was the single most
 * expensive thing the board did.
 */
const RESILIENCE = new WeakMap<DashProjection, string>();

const RESILIENCE_NAMES = [
  "model/failover_policy",
  "model/primary_selection",
  "model/failover",
  "model/route_transition",
  "model/route_transition_result",
  "model/failure",
  "model/quota",
] as const;

export function modelResilienceLine(view: DashProjection): string {
  const hit = RESILIENCE.get(view);
  if (hit !== undefined) return hit;
  const built = buildModelResilienceLine(view);
  RESILIENCE.set(view, built);
  return built;
}

function buildModelResilienceLine(view: DashProjection): string {
  let mode: "off" | "ask" | "auto" | undefined;
  let state: string | undefined;
  let primary: { route: string; model: string } | undefined;
  let active: { route: string; model: string } | undefined;
  let continuity: string | undefined;
  let cost: string | undefined;
  let freshness: string | undefined;
  let freshnessSeq = -1;
  let auth: string | undefined;
  let transition: string | undefined;
  const candidateFacts = new Map<string, { auth?: string; cost?: string; freshness?: string; seq: number }>();
  const quotaFacts = new Map<string, { freshness: string; seq: number }>();
  for (const event of view.index.ofAny(...RESILIENCE_NAMES)) {
    if (event.name === "model/failover_policy") {
      mode = failoverMode(event.payload.mode) ?? mode;
      primary = publicSelection(event.payload.primary) ?? primary;
      active = publicSelection(event.payload.active) ?? active;
      continuity = publicEnum(event.payload.continuity, ["continue", "checkpoint"]) ?? continuity;
      state = failoverState(event.payload.next_state) ?? state ?? (mode === "off" ? "DISABLED" : "ARMED");
    }
    if (event.name === "model/primary_selection") {
      primary = publicSelection(event.payload.primary) ?? publicSelection(event.payload.selection) ?? primary;
      active = publicSelection(event.payload.active) ?? active ?? primary;
      state = failoverState(event.payload.state) ?? state ?? (mode === "off" ? "DISABLED" : "ARMED");
    }
    if (event.name === "model/failure") state = "DEGRADED";
    if (event.name === "model/failover") {
      mode = failoverMode(event.payload.mode) ?? mode;
      primary = publicSelection(event.payload.primary) ?? primary;
      active = publicSelection(event.payload.active) ?? active;
      continuity = publicEnum(event.payload.continuity, ["continue", "checkpoint"]) ?? continuity;
      if (Array.isArray(event.payload.candidate_summaries)) {
        for (const item of event.payload.candidate_summaries) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const summary = item as Record<string, unknown>;
          const selection = publicSelection(summary);
          if (!selection) continue;
          candidateFacts.set(selectionName(selection), {
            auth: publicEnum(summary.auth, ["connected", "missing", "expired", "unknown"]),
            cost: publicEnum(summary.cost, ["free", "subscription", "paid", "unknown"]),
            freshness: publicEnum(summary.quota_freshness, ["fresh", "stale", "unknown"]),
            seq: event.seq,
          });
        }
      }
      const recordedState = failoverState(event.payload.state);
      if (recordedState) state = recordedState;
      else if (event.payload.action === "ask") state = "AWAITING_OPERATOR";
      else if (event.payload.action === "stop") state = mode === "off" ? "DISABLED" : "PAUSED";
    }
    if (event.name === "model/route_transition") {
      const from = publicSelection(event.payload.from);
      const to = publicSelection(event.payload.to);
      if (from && !primary) primary = from;
      if (from && to) transition = `${selectionName(from)}->${selectionName(to)}`;
      continuity = publicEnum(event.payload.continuity, ["continue", "checkpoint"]) ?? continuity;
      state = "SWITCHING";
    }
    if (event.name === "model/route_transition_result") {
      const next = publicSelection(event.payload.active) ?? publicSelection(event.payload.target);
      primary = publicSelection(event.payload.primary) ?? primary;
      active = publicSelection(event.payload.active) ?? active;
      const recordedState = failoverState(event.payload.state);
      if (event.payload.status === "active" && next) {
        active = next;
        const fact = candidateFacts.get(selectionName(next));
        auth = fact?.auth ?? auth;
        cost = fact?.cost ?? cost;
        if (fact?.freshness) {
          freshness = fact.freshness;
          freshnessSeq = fact.seq;
        }
        state = recordedState ?? (primary && selectionName(primary) === selectionName(next) ? "ARMED" : "FALLBACK_ACTIVE");
      } else if (event.payload.status === "failed") {
        state = recordedState ?? "DEGRADED";
      } else if (event.payload.status === "paused") {
        state = recordedState ?? "PAUSED";
      }
    }
    if (event.name === "model/quota") {
      const selection = publicSelection(event.payload);
      const recorded = publicEnum(event.payload.freshness, ["fresh", "stale", "unknown"]);
      if (selection && recorded) quotaFacts.set(selectionName(selection), { freshness: recorded, seq: event.seq });
    }
  }
  const usage = view.usage;
  if (!active && usage && typeof usage.route === "string" && typeof usage.model === "string") {
    active = { route: usage.route, model: usage.model };
  }
  if (active) {
    const quota = quotaFacts.get(selectionName(active));
    if (quota && quota.seq >= freshnessSeq) freshness = quota.freshness;
  }
  if (!mode && !state && !primary && !transition) return "";
  return [
    `RESILIENCE failover=${mode ?? "unknown"}/${state ?? "unknown"}`,
    `primary=${primary ? selectionName(primary) : "-"}`,
    `active=${active ? selectionName(active) : "-"}`,
    `auth=${auth ?? "unknown"}`,
    `cost=${cost ?? "unknown"}`,
    `quota=${freshness ?? "unknown"}`,
    `continuity=${continuity ?? "unknown"}`,
    ...(transition ? [`last=${transition}`] : []),
  ].join(" ");
}

function failoverState(value: unknown): string | undefined {
  return publicEnum(value, [
    "DISABLED",
    "ARMED",
    "DEGRADED",
    "AWAITING_OPERATOR",
    "SWITCHING",
    "FALLBACK_ACTIVE",
    "PAUSED",
  ]);
}

/**
 * MODEL headline as header chrome (operator request, restored after the
 * pane-to-bar move hid compaction and the verbose ctx line):
 * identity, token/cache/compaction, then ctx=current/max + gauge + layers.
 */
export function headerModelLines(view: DashProjection, width: number): string[] {
  const usage = view.usage;
  const turns = view.sessionStats.turns;
  // With no model/usage yet the field names still stay on the board — a bare
  // "MODEL" cannot tell an operator whether the route is missing or unread.
  // A live turn is the exception: it already knows its route, and writing
  // `model=-` next to it reads as "the model went missing".
  const identity = usage
    ? `MODEL model=${fmtMetric(usage.model)} route=${fmtMetric(usage.route)} provider=${fmtMetric(usage.provider)} auth=${usage.auth}`
    : view.work.route !== "missing"
      ? `MODEL route=${view.work.route}`
      : "MODEL model=- route=- provider=- auth=-";
  const shortTokens = (value: Metric | undefined): string =>
    typeof value === "number" && value >= 10_000 ? formatMetricK(value) : fmtMetric(value);
  const tokens = usage
    ? [
        `hit=${fmtHitRatio(usage)}`,
        `in=${shortTokens(usage.input_tokens)} out=${shortTokens(usage.output_tokens)}`,
        `turn=${turns}`,
        compactionLine(view),
        `cache_r=${shortTokens(usage.cache_read_tokens)} cache_w=${shortTokens(usage.cache_write_tokens)}`,
      ].join(" ")
    : `turn=${turns} ${compactionLine(view)}`;
  const thinking = view.thinkingLevel === "off" ? " thinking=off" : "";
  const compactAt =
    typeof view.sessionStats.compact_at === "number"
      ? ` compact_at=${formatMetricK(view.sessionStats.compact_at)}`
      : "";
  const metrics = `${tokens}${compactAt}${thinking}`;
  const ctx = contextLine(
    usage?.context_used ?? "missing",
    usage?.context_window ?? "missing",
    view.compactionFresh ? "post-compaction est" : "current",
  );
  const seg = view.contextLayers;
  const layers = seg
    ? ` system=${formatMetricK(seg.system)} tools=${formatMetricK(seg.tools)}${(seg.skills ?? 0) > 0 ? ` skills=${formatMetricK(seg.skills ?? 0)}` : ""} hist=${formatMetricK(seg.history)}`
    : "";
  const label = `${ctx}${layers} `;
  const barWidth = Math.max(10, width - label.length - 2);
  // Segmented dotted bar when the layer breakdown is known — each category a
  // dim dot in its own colour; otherwise the plain occupancy block bar.
  const gauge = seg ? contextLayerBar(view, barWidth).text : blockBar(contextRatio(view), barWidth);
  const resilience = modelResilienceLine(view);
  return [identity, metrics, `${label}${gauge}`, ...(resilience ? [resilience] : [])];
}

function publicSelection(value: unknown): { route: string; model: string } | undefined {
  if (!isRecord(value)) return undefined;
  const route = publicStatusText(value.route);
  const model = publicStatusText(value.model);
  return route && model ? { route, model } : undefined;
}

function publicStatusText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  if (containsSecret(value) || containsPrivateInfrastructure(value)) return undefined;
  return value;
}

function selectionName(selection: { route: string; model: string }): string {
  return `${selection.route}/${selection.model}`;
}

function publicEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? value as T : undefined;
}

function failoverMode(value: unknown): "off" | "ask" | "auto" | undefined {
  return publicEnum(value, ["off", "ask", "auto"]);
}

/** One-line host summary for the footer bar. */
export function hostBarLine(view: DashProjection): string {
  const host = view.host;
  if (!host) {
    return "HOST cpu=- mem=- ws=- log=- pids=0";
  }
  const cpu = typeof host.cpu_pct === "number" ? `${host.cpu_pct}%` : "-";
  return `HOST cpu=${cpu} mem=${fmtBytes(host.rss_bytes)} ws=${fmtBytes(host.workspace_bytes)} log=${fmtBytes(host.log_bytes)} pids=${host.pids.length} files_w=${host.files_written.length}`;
}

export function hostLines(view: DashProjection): string[] {
  const host = view.host;
  if (!host) {
    return ["cpu=- mem=- workspace=- log=- files=- pids=-"];
  }
  const pids = host.pids.map((row) => `${row.pid}:${row.cmd}`).join(",") || "-";
  return [
    `cpu=${typeof host.cpu_pct === "number" ? `${host.cpu_pct}%` : "-"} mem=${fmtBytes(host.rss_bytes)} workspace=${fmtBytes(host.workspace_bytes)} log=${fmtBytes(host.log_bytes)}`,
    `files_created=${host.files_created.join(",") || "(none)"}`,
    `files_written=${host.files_written.join(",") || "(none)"}`,
    `pids=${pids}`,
  ];
}

/** The aggregate the TOOLS pane uniquely carried, at one status-bits cost:
 * finished calls, the slowest tool with its worst latency, failures. The
 * per-call facts already ride MODEL STREAM and ALERTS. */
/**
 * Counted once per projection, not once per paint.
 *
 * Two filters over every tool record the session ever wrote -- sixty thousand
 * on a live log -- plus a copy of the max table to sort it, for one status
 * line, ten times a second. The numbers are properties of the projection, so
 * they are settled when it is.
 */
const TOOLS_BAR = new WeakMap<DashProjection, string | undefined>();

export function toolsBarLine(view: DashProjection): string | undefined {
  if (TOOLS_BAR.has(view)) return TOOLS_BAR.get(view);
  const built = buildToolsBarLine(view);
  TOOLS_BAR.set(view, built);
  return built;
}

function buildToolsBarLine(view: DashProjection): string | undefined {
  const scope = view.toolProfile
    ? `profile=${view.toolProfile.profile} todo=${view.toolProfile.todo} exposed=${view.toolProfile.tools.length}`
    : "";
  if (view.tools.length === 0) {
    if (scope) return scope;
    return undefined;
  }
  // One pass for both counts, and a scan for the max rather than a sorted copy.
  let ended = 0;
  let failed = 0;
  for (const row of view.tools) {
    if (row.phase === "end") ended += 1;
    if (row.error === true) failed += 1;
  }
  let slowest: (typeof view.toolMax)[number] | undefined;
  for (const row of view.toolMax) {
    if (!slowest || row.max_ms > slowest.max_ms) slowest = row;
  }
  const slowestBit = slowest ? ` slowest=${slowest.name}:${fmtDuration(slowest.max_ms)}` : "";
  return `${scope ? `${scope} ` : ""}tools=${ended}${slowestBit} fail=${failed}`;
}

export function toolMaxLines(view: DashProjection): string[] {
  if (view.toolMax.length === 0) {
    return [];
  }
  return view.toolMax.map((row) => `${row.name} max_ms=${row.max_ms}`);
}

export function toolSlowLines(view: DashProjection, take = 3): string[] {
  return view.toolSlow.slice(-take).map((row) => {
    const bytes = row.result_bytes === "missing" ? "" : ` result_bytes=${row.result_bytes}`;
    const waited = row.waited_ms === undefined ? "" : ` waited_ms=${row.waited_ms}`;
    return `slow ${row.name} ${row.duration_ms}ms reason=${row.reason}${waited}${bytes}`;
  });
}

export function toolLines(view: DashProjection, take = 5): string[] {
  const recent = view.tools.slice(-take);
  const max = toolMaxLines(view);
  const slow = toolSlowLines(view);
  const scope = view.toolProfile
    ? [`profile=${view.toolProfile.profile} todo=${view.toolProfile.todo} tools=${view.toolProfile.tools.join(",") || "(none)"}`]
    : [];
  if (recent.length === 0 && max.length === 0 && slow.length === 0 && scope.length === 0) {
    return ["(none)"];
  }
  // A failed row names its cause here: the operator must not hunt the
  // stream for the stderr that belongs to this seq (TUI review).
  const errTail = (row: DashProjection["tools"][number]): string => {
    const id = row.id;
    if (!id) {
      return "";
    }
    const call = view.work.lastToolCalls.find((item) => item.id === id);
    const tail = call?.result_text
      ?.trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .at(-1);
    return tail ? ` ${tail.slice(0, 60)}` : "";
  };
  const rows = recent.map((row) => {
    const err =
      row.phase === "end" && row.error
        ? ` err=1${row.diagnosis ? ` ${row.diagnosis}` : ""}${errTail(row)}`
        : "";
    const ms = row.phase === "end" && row.duration_ms !== "missing" ? ` ${row.duration_ms}ms` : "";
    const lat =
      row.phase === "end" &&
      typeof row.harness_ms === "number" &&
      typeof row.command_bound_ms === "number" &&
      typeof row.total_ms === "number"
        ? ` [host ${row.harness_ms}ms + cmd ${row.command_bound_ms}ms = ${row.total_ms}ms]`
        : "";
    return `seq=${row.seq} ${row.phase} ${row.name}${err}${ms}${lat}`;
  });
  return [...scope, ...max, ...slow, ...rows];
}

export function compactionLines(view: DashProjection, take = 4): string[] {
  if (view.compaction.length === 0) {
    return ["(none)"];
  }
  return view.compaction
    .slice(-take)
    .map((row) => {
      const measured = row.name === "compaction/drop" && row.beforeTokens !== undefined && row.afterTokens !== undefined
        ? ` ${formatMetricK(row.beforeTokens)}→${formatMetricK(row.afterTokens)} dropped=${row.droppedMessages ?? "?"}`
        : "";
      const status = row.status ? ` status=${row.status}` : "";
      return `seq=${row.seq} ${row.name}${row.reason ? ` reason=${row.reason}` : ""}${measured}${status}`;
    });
}

const BIND_NOISE = new Set(["work/todo", "work/scenario"]);

export function operatorEvents(view: DashProjection): DashProjection["events"] {
  return view.events.filter((event) => {
    if (BIND_NOISE.has(event.name)) {
      return false;
    }
    if (event.name === "work/case" && event.payload.status == null) {
      return false;
    }
    return true;
  });
}

export function scanSource(view: DashProjection): DashProjection["events"] {
  const preferred = operatorEvents(view);
  return preferred.length > 0 ? preferred : view.events;
}

export interface EventScanLine {
  text: string;
  tone: Tone;
}

export function eventScanLines(view: DashProjection, take = 8): EventScanLine[] {
  const tail = scanSource(view).slice(-take);
  if (tail.length === 0) {
    return [{ text: "(empty)", tone: "muted" }];
  }
  return tail.map((event, index) => {
    const hint = eventHint(event);
    const lane = eventLane(event);
    const delta = eventDelta(index > 0 ? tail[index - 1] : undefined, event).padEnd(5);
    const base = `${String(event.seq).padStart(4)} ${lane} ${delta} ${event.name}`;
    return { text: hint ? `${base} ${hint}` : base, tone: eventLaneTone(event) };
  });
}

export function eventLines(view: DashProjection, take = 8): string[] {
  return eventScanLines(view, take).map((row) => row.text);
}

function eventHint(event: DashProjection["events"][number]): string {
  const payload = event.payload;
  if (event.name === "user/message" && typeof payload.text === "string") {
    return clipHint(payload.text);
  }
  if (event.name === "assistant/message") {
    const stop = typeof payload.stop === "string" ? payload.stop : "missing";
    const text = typeof payload.text === "string" ? clipHint(payload.text) : "";
    return `stop=${stop}${text ? ` ${text}` : ""}`;
  }
  if (event.name === "agent/status" && typeof payload.status === "string") {
    return `status=${payload.status}`;
  }
  if (event.name === "runner/register") {
    const id = typeof payload.id === "string" ? payload.id : "?";
    const source = typeof payload.source === "string" ? payload.source : "?";
    return `id=${id} source=${source}`;
  }
  if (event.name === "operator/note" && typeof payload.text === "string") {
    return clipHint(payload.text);
  }
  if (event.name === "work/lesson") {
    const wave = typeof payload.wave === "number" ? payload.wave : "?";
    const status = typeof payload.status === "string" ? payload.status : "?";
    const todo = typeof payload.todo === "string" ? ` ${payload.todo}` : "";
    return `wave=${wave} ${status}${todo}`;
  }
  if (event.name === "livelock/evidence") {
    const todo = typeof payload.todo === "string" ? payload.todo : "?";
    const phase = typeof payload.phase === "string" ? payload.phase : "?";
    return `${todo} unavailable phase=${phase}`;
  }
  if (event.name === "livelock/detected" || event.name === "livelock/refused" || event.name === "livelock/cleared") {
    const todo = typeof payload.todo === "string" ? payload.todo : "?";
    const caseId = typeof payload.case_id === "string" ? ` case=${payload.case_id}` : "";
    const attempts = typeof payload.attempts === "number" ? ` attempts=${payload.attempts}` : "";
    const reason = typeof payload.reason === "string" ? ` ${payload.reason}` : "";
    return `${todo}${caseId}${attempts}${reason}`;
  }
  if (event.name === "model/progress") {
    const secs = typeof payload.elapsed_ms === "number" ? `${Math.round(payload.elapsed_ms / 1000)}s` : "?";
    const chars = typeof payload.chars === "number" ? payload.chars : "?";
    const thinking = typeof payload.thinking_chars === "number" ? payload.thinking_chars : "?";
    const tool = typeof payload.tool_chars === "number" ? ` tool=${payload.tool_chars}` : "";
    return `+${secs} chars=${chars} thinking=${thinking}${tool}`;
  }
  if (event.name === "swe/baseline") {
    const passed = payload.passed === true ? "pass" : "fail";
    const exit = typeof payload.exit_code === "number" ? payload.exit_code : "?";
    return `${passed} exit=${exit}`;
  }
  if (event.name === "swe/p2p_baseline") {
    const tests = typeof payload.tests === "number" ? payload.tests : "?";
    const run = typeof payload.run === "number" ? payload.run : "?";
    const bad = typeof payload.known_bad === "number" ? payload.known_bad : "?";
    const dropped = typeof payload.dropped === "number" ? payload.dropped : 0;
    return `tests=${tests} run=${run} known_bad=${bad}${dropped ? ` dropped=${dropped}` : ""}`;
  }
  if (event.name === "swe/envfix") {
    const exit = typeof payload.exit_code === "number" ? payload.exit_code : "?";
    const round = typeof payload.round === "number" ? ` round=${payload.round}` : "";
    const restored = typeof payload.restored_files === "number" ? ` restored=${payload.restored_files}` : "";
    return `exit=${exit}${round}${restored}`;
  }
  if (event.name === "swe/result") {
    const resolved = payload.resolved === true ? "resolved" : "unresolved";
    const blame = classifySweBlame({
      resolved: payload.resolved === true,
      prepared: payload.prepared !== false,
      planned: payload.planned === true,
      completed: payload.completed === true,
      envfix_attempted: payload.envfix_attempted === true,
      after: typeof payload.after_passed === "boolean" ? { passed: payload.after_passed } : undefined,
      error: typeof payload.error === "string" ? payload.error : undefined,
    });
    const stored = typeof payload.blame === "string" ? payload.blame : blame;
    const error = typeof payload.error === "string" ? ` ${clipHint(payload.error)}` : "";
    return `${resolved} blame=${stored}${error}`;
  }
  if (event.name === "model/retry") {
    const attempt = typeof payload.attempt === "number" ? payload.attempt : "?";
    const wait = typeof payload.delay_ms === "number" ? `${Math.round(payload.delay_ms / 1000)}s` : "?";
    const reason = typeof payload.reason === "string" ? clipHint(payload.reason) : "";
    return `attempt=${attempt} wait=${wait} ${reason}`.trim();
  }
  if (event.name === "tool/slow") {
    const name = typeof payload.name === "string" ? payload.name : "";
    const reason = typeof payload.reason === "string" ? payload.reason : "missing";
    const ms = typeof payload.duration_ms === "number" ? ` ${payload.duration_ms}ms` : "";
    const waited = typeof payload.waited_ms === "number" ? ` waited=${payload.waited_ms}ms` : "";
    return `${name}${ms} reason=${reason}${waited}`.trim();
  }
  if (event.name === "tool/call" || event.name === "tool/start" || event.name === "tool/end") {
    const name = typeof payload.name === "string" ? payload.name : "";
    const err = payload.error === true ? " err=1" : "";
    const ms = typeof payload.duration_ms === "number" ? ` ${payload.duration_ms}ms` : "";
    return `${name}${err}${ms}`.trim();
  }
  if ((event.name === "work/doing" || event.name === "work/clear") && typeof payload.todo === "string") {
    return payload.todo;
  }
  if (event.name === "work/step") {
    const action = typeof payload.action === "string" ? payload.action : "?";
    const todo = typeof payload.todo === "string" ? ` ${payload.todo}` : "";
    const reason = typeof payload.reason === "string" ? ` ${payload.reason}` : "";
    return `${action}${todo}${reason}`.trim();
  }
  // #77 isolated steps. The board carries the glanceable fact — which step,
  // how much moved, which gate said what — and never the digests: those are
  // replay machinery, and a hex string spends a whole row saying nothing.
  if (event.name === "work/step_input" || event.name === "work/step_session") {
    const step = typeof payload.step_id === "string" ? payload.step_id : "?";
    const session = typeof payload.child_session === "string" ? ` ${payload.child_session}` : "";
    return `${step}${session}`;
  }
  if (event.name === "work/step_patch") {
    const step = typeof payload.step_id === "string" ? payload.step_id : "?";
    const files = typeof payload.files_count === "number" ? payload.files_count : "?";
    return `${step} files=${files}`;
  }
  if (event.name === "work/step_refused") {
    const step = typeof payload.step_id === "string" ? payload.step_id : "?";
    const error = typeof payload.error === "string" ? ` ${clipHint(payload.error)}` : "";
    return `${step}${error}`;
  }
  if (event.name === "work/step_usage") {
    // An unmeasured field prints `missing`, never a zero: a cell the host
    // filled in for the provider is the estimate constitution 6 forbids.
    const metric = (value: unknown): string => typeof value === "number" ? String(value) : "missing";
    const turns = typeof payload.turns === "number" ? payload.turns : "?";
    const gaps = typeof payload.missing === "number" && payload.missing > 0
      ? ` gaps=${payload.missing}`
      : "";
    return `turns=${turns} in=${metric(payload.input_tokens)} out=${metric(payload.output_tokens)}`
      + ` ctx=${metric(payload.context_used_max)}/${metric(payload.context_window)}${gaps}`;
  }
  if (event.name === "verify/gate") {
    const gate = typeof payload.gate === "string" ? payload.gate : "?";
    const status = typeof payload.status === "string" ? payload.status : "?";
    const reason = typeof payload.reason_code === "string" ? ` ${payload.reason_code}` : "";
    return `${gate} ${status}${reason}`;
  }
  if (event.name === "verify/decision") {
    const step = typeof payload.step_id === "string" ? payload.step_id : "?";
    const status = typeof payload.status === "string" ? payload.status : "?";
    const reason = typeof payload.reason_code === "string" ? ` ${payload.reason_code}` : "";
    const failed = Array.isArray(payload.failed) && payload.failed.length > 0
      ? ` failed=${payload.failed.join(",")}`
      : "";
    return `${step} ${status}${reason}${failed}`;
  }
  if (event.name === "work/phase") {
    const phase = typeof payload.phase === "string" ? payload.phase : "?";
    const reason = typeof payload.reason === "string" ? ` ${payload.reason}` : "";
    return `${phase}${reason}`;
  }
  if (event.name === "work/case_preflight") {
    const id = typeof payload.id === "string" ? payload.id : "?";
    const status = typeof payload.status === "string" ? payload.status : "?";
    const reason = typeof payload.reason === "string" ? ` ${payload.reason}` : "";
    return `${id} ${status}${reason}`;
  }
  if (event.name === "knowledge/briefing_scope") {
    const status = typeof payload.status === "string" ? payload.status : "?";
    const project = typeof payload.project === "string" ? ` ${payload.project}` : "";
    const reason = typeof payload.reason === "string" ? ` ${payload.reason}` : "";
    return `${status}${project}${reason}`;
  }
  if (event.name === "blob/gc") {
    const orphan = typeof payload.orphan === "number" ? payload.orphan : "?";
    const onDisk = typeof payload.on_disk === "number" ? payload.on_disk : "?";
    const dry = payload.dry_run === true ? " dry" : "";
    return `orphan=${orphan} on_disk=${onDisk}${dry}`;
  }
  if (event.name === "blob/gc_result") {
    const removed = typeof payload.removed === "number" ? payload.removed : "?";
    const kept = typeof payload.kept === "number" ? payload.kept : "?";
    const bytes = typeof payload.bytes_freed === "number" ? payload.bytes_freed : "?";
    const dry = payload.dry_run === true ? " dry" : "";
    return `removed=${removed} kept=${kept} freed=${bytes}${dry}`;
  }
  return "";
}

function clipHint(text: string): string {
  const flat = text.replaceAll("\n", " ").trim();
  return flat.length > 42 ? `${flat.slice(0, 39)}...` : flat;
}

export function pluginLine(view: DashProjection): string {
  // The manifest digest is replay machinery (matched by `dokkabi replay`),
  // not a glanceable fact — field feedback asked for the hex to leave the
  // board. The projection keeps it (view.digest); the paint does not.
  const assets = view.pluginAssets;
  const inactive = view.pluginStates
    .filter((plugin) => plugin.state !== "active")
    .map((plugin) => `${plugin.id}:${plugin.state}${plugin.reasonCode ? `(${plugin.reasonCode})` : ""}`);
  return `loaded=${view.plugins.join(",") || "missing"}${inactive.length > 0 ? `   inactive=${inactive.join(",")}` : ""}   packages=${assets.packages} prompts=${assets.prompts} skills=${assets.skills}`;
}

export function knowledgeLine(view: DashProjection): string {
  const wiki = view.knowledge;
  if (!wiki) return "state=missing";
  const revision = wiki.revision === "missing" ? "-" : wiki.revision.slice(0, 12);
  const profile = wiki.profile === "missing" ? "-" : wiki.profile;
  const mode = wiki.dialect === "missing" ? "-" : `${wiki.dialect}/${wiki.layout}`;
  const access = `${wiki.writable === true ? "rw" : "ro"}/${wiki.publishable === true ? "publish" : "local"}`;
  return `state=${wiki.state} query=${wiki.queries} read=${wiki.reads} write=${wiki.writes} publish=${wiki.publishes} pending=${wiki.pending} failures=${wiki.failures} rev=${revision} profile=${profile} mode=${mode} access=${access} docs=${fmtMetric(wiki.documents)} rel=${fmtMetric(wiki.relations)} orphan=${fmtMetric(wiki.orphans)} last_results=${fmtMetric(wiki.lastResults)} checkpoints=${wiki.checkpointPending} lint=${fmtMetric(wiki.errors)}/${fmtMetric(wiki.warnings)} publication=${fmtMetric(wiki.publication)}`;
}

export function remoteLine(view: DashProjection): string {
  const remote = view.remote;
  const running = remote.runningRequest === "missing" ? "idle" : remote.runningRequest;
  return `adapter=${remote.adapter} accepted=${remote.accepted} pending=${remote.pending} running=${running} failures=${remote.requestFailures}/${remote.deliveryFailures}/${remote.transportFailures} vpn=${remote.vpnState} outages=${remote.vpnOutages} vpn_failures=${remote.vpnFailures}`;
}

export function formatMetricK(value: number | "missing"): string {
  if (value === "missing") {
    return "-";
  }
  const k = Math.round(value / 1000);
  // A four-digit k count reads worse than M (field feedback: `1049k`).
  // Roll the moment rounding would carry into a fourth digit.
  if (k >= 1000) {
    return `${Math.round(k / 1000)}M`;
  }
  return `${k}k`;
}

export function contextPercent(used: number | "missing", max: number | "missing"): string {
  if (used === "missing" || max === "missing" || max <= 0) {
    return "-";
  }
  return `${Math.round((used / max) * 100)}%`;
}

/** Human-readable byte counts: rss_bytes=123715584 tells nobody anything;
 * 118.0MB does (TUI review). */
export function fmtBytes(value: Metric | undefined): string {
  if (typeof value !== "number" || value < 0) {
    return "-";
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)}KB`;
  }
  return `${Math.round(value)}B`;
}

export function contextRatio(view: DashProjection): number | undefined {
  const used = view.usage?.context_used;
  const max = view.usage?.context_window;
  if (typeof used === "number" && typeof max === "number" && max > 0) {
    return used / max;
  }
  return undefined;
}

export function asciiBar(ratio: number | undefined, width: number): string {
  const w = Math.max(0, width);
  if (ratio === undefined) {
    return `[${"-".repeat(w)}]`;
  }
  const filled = Math.max(0, Math.min(w, Math.round(ratio * w)));
  return `[${"#".repeat(filled)}${".".repeat(w - filled)}]`;
}

/**
 * The context window as a segmented dotted bar: one dim dot per cell, coloured
 * by the layer that occupies it — system, tools, skills, history — with the
 * free tail dimmer still. Each cell's share is its layer's fraction of the
 * window, so the operator sees not just "how full" but "full of what", at a
 * glance and in the sparklines' quiet dotted idiom rather than a solid block.
 * Returns the glyph run and a parallel per-cell tone list; the board paints
 * the dots with those tones.
 */
export function contextLayerBar(view: DashProjection, width: number): { text: string; tones: Tone[] } {
  const w = Math.max(0, width);
  if (w === 0) {
    return { text: "", tones: [] };
  }
  const layers = view.contextLayers;
  const window = typeof view.usage?.context_window === "number" ? view.usage.context_window : undefined;
  if (!layers || typeof window !== "number" || window <= 0) {
    return { text: "·".repeat(w), tones: new Array<Tone>(w).fill("barEmpty") };
  }
  const segments: Array<{ tokens: number; tone: Tone }> = [
    { tokens: layers.system, tone: "chartModelDim" },
    { tokens: layers.tools, tone: "chartToolDim" },
    { tokens: layers.skills ?? 0, tone: "chartInputDim" },
    { tokens: layers.history, tone: "laneDim" },
  ];
  const tones: Tone[] = [];
  for (const segment of segments) {
    const cells = Math.round((Math.max(0, segment.tokens) / window) * w);
    for (let i = 0; i < cells && tones.length < w; i += 1) {
      tones.push(segment.tone);
    }
  }
  while (tones.length < w) {
    tones.push("barEmpty");
  }
  return { text: "·".repeat(w), tones: tones.slice(0, w) };
}

export function blockBar(ratio: number | undefined, width: number): string {
  const w = Math.max(0, width);
  if (w === 0) {
    return "";
  }
  if (ratio === undefined) {
    return "─".repeat(w);
  }
  const filled = Math.max(0, Math.min(w, Math.round(ratio * w)));
  return `${"█".repeat(filled)}${"░".repeat(w - filled)}`;
}

export function statusTone(status: string): "ok" | "ember" | "bad" | "muted" {
  if (status === "failed" || status === "error") {
    return "bad";
  }
  if (status.startsWith("generating") || status.startsWith("tool:")) {
    return "ember";
  }
  if (status === "running" || status === "waiting_tool" || status === "compacting") {
    return "ember";
  }
  if (status === "idle" || status === "clear") {
    return "ok";
  }
  return "muted";
}

export function todoTone(state: string): "ok" | "ember" | "bad" | "muted" {
  if (state === "doing" || state === "running") {
    return "ember";
  }
  if (state === "clear" || state === "green") {
    return "ok";
  }
  if (state === "blocked" || state === "red" || state === "failed") {
    return "bad";
  }
  return "muted";
}
