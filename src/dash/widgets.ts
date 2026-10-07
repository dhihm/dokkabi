import { HIT_FLOOR, HIT_WARMUP_TURNS, hitTrack } from "../host/hit-ratio.ts";
import { containsPrivateInfrastructure, containsSecret } from "../host/redact.ts";
import {
  blobGcLines,
  compactionLines,
  contextRatio,
  eventScanLines,
  formatMetricK,
  scanSource,
  lastFailLine,
  toolLines,
  workGraphLines,
} from "./cells.ts";
import type { EventRecord } from "../host/schema.ts";
import type { Demand } from "./flex.ts";
import { alertLines, brailleArea, derivedAlerts, lastOperatorSeqOf } from "./graphs.ts";
import { clip, compact, ellipsize, fmtDuration, gauge, latencyBar, padTo, stackBar } from "./glyphs.ts";
import { generatingElapsedSeconds, type DashProjection } from "./project.ts";
import { renderMarkdown } from "./markdown.ts";
import { eventLane, scanPaneTitle, isBadEvent } from "./scan.ts";
import { dimTone, visibleWidth, wrapText, type Tone } from "./screen.ts";
import { statusMark } from "./status.ts";
import { buildTurnBlocks, renderTurnBlock, spinnerFrame } from "./stream-ast.ts";
import { pendingOperatorApproval, approvalEventsOf } from "./operator-approval.ts";

export interface WidgetLine {
  text: string;
  tone: Tone;
  /** Set when a search query matched this line. */
  match?: boolean;
  /** Per-cell tones for chart rows, where one line carries many colours. */
  cells?: Tone[];
}

export interface WidgetCtx {
  view: DashProjection;
  /** Usable interior width, borders already subtracted. */
  width: number;
  /** Usable interior rows, borders already subtracted. */
  rows: number;
  focused: boolean;
  /** Rows scrolled back from the newest content. 0 pins to the tail. */
  scroll: number;
  /** Active `/` search. Matching lines carry `match: true`. */
  query?: string;
  /** Per-pane line filter from `/filter` (#48): non-matching lines are
   * dropped before the scroll window, with a hidden-count marker. */
  filter?: string;
  /** Injected so a frame is reproducible in tests and in replay. */
  now: number;
}

export type WidgetId =
  | "alerts"
  | "plan"
  | "stream"
  | "tools"
  | "events"
  | "tokens"
  | "context"
  | "timeline";

/**
 * Where a pane lives.
 *
 * `band` spans the whole width above the columns. A model reply is the thing
 * an operator reads most, and the same paragraph takes roughly half the rows
 * at full width — so the stream is a band, and WORK and EVENTS share the
 * columns underneath it.
 */
export type WidgetSlot = "band" | "side" | "main" | "aux";

export interface Widget {
  id: WidgetId;
  title(ctx: WidgetCtx): string;
  /** Per-code-point tones for the title, when it carries a colour legend. */
  titleTones?(ctx: WidgetCtx): Tone[];
  /** Rows this widget wants. Never more than `body()` can actually fill. */
  demand(ctx: WidgetCtx): Demand;
  lines(ctx: WidgetCtx): WidgetLine[];
  /** Lower survives longer when the board runs out of rows. */
  priority: number;
  slot: WidgetSlot;
  /** False keeps the widget off the board entirely for this projection. */
  relevant(view: DashProjection): boolean;
  /**
   * Optional widgets join the board only when a column has rows to spare.
   * Their headline already lives on the chrome, so a small terminal loses
   * nothing by dropping them — a large one gains the detail.
   */
  optional?: boolean;
  /** A drawer widget with a true pinned() is forced onto the board — used by
   * ALERTS while operator authority (SSH/GitHub/MCP approval or failover ask) is pending,
   * so D-2026-08-24-74's fallback survives the drawer. */
  pinned?: (view: DashProjection) => boolean;
  /**
   * Part of the `d` drawer: the token/context accounting an operator asks for
   * deliberately. Pressing d moves these ahead of the ambient panes instead
   * of waiting for rows that a small board does not have.
   */
  drawer?: boolean;
  /**
   * A band that closes the board instead of opening it: planned after the
   * columns, pinned to the bottom rows. ALERTS reads last (field feedback:
   * failures must not push the stream off screen).
   */
  bottom?: boolean;
}

/**
 * The body cache. `demand()` and `lines()` both need the full body, and the
 * board asks for a frame several times a second: rendering the same
 * projection twice per widget per paint is pure waste. Keyed by projection
 * identity, so a new EventLog read invalidates everything by construction.
 */
const BODY_CACHE = new WeakMap<DashProjection, Map<string, WidgetLine[]>>();

function cachedBody(id: string, ctx: WidgetCtx, build: () => WidgetLine[]): WidgetLine[] {
  let perView = BODY_CACHE.get(ctx.view);
  if (!perView) {
    perView = new Map();
    BODY_CACHE.set(ctx.view, perView);
  }
  // Width changes the wrapping; a live spinner changes with the clock, so
  // widgets that animate opt out by including the tick in their key.
  const key = `${id}@${ctx.width}`;
  const hit = perView.get(key);
  if (hit) {
    return hit;
  }
  const built = build();
  perView.set(key, built);
  return built;
}

/** Trim every line to the interior width so no widget can paint over a border. */
function fit(lines: readonly WidgetLine[], width: number): WidgetLine[] {
  return lines.map((line) => (visibleWidth(line.text) <= width ? line : { ...line, text: clip(line.text, width) }));
}

/** Mark search hits and, when a query is active, keep only the matches in list panes. */
function applyQuery(lines: readonly WidgetLine[], query: string | undefined): WidgetLine[] {
  if (!query) {
    return [...lines];
  }
  const needle = query.toLowerCase();
  return lines.map((line) =>
    line.text.toLowerCase().includes(needle) ? { ...line, tone: "match" as Tone, match: true } : line,
  );
}

/** Drop lines that do not carry the pane's `/filter` needle (#48). Applied
 * BEFORE the scroll window so scrolling operates on what is actually shown.
 * A marker leads the list stating how many lines were hidden — a filtered
 * pane must never read as an empty one. Exported for tests; production
 * callers go through WidgetCtx.filter. */
export function applyFilter(lines: readonly WidgetLine[], filter: string | undefined): WidgetLine[] {
  if (!filter) {
    return [...lines];
  }
  const needle = filter.toLowerCase();
  const kept = lines.filter((line) => line.text.toLowerCase().includes(needle));
  if (kept.length === lines.length) {
    return [...lines];
  }
  return [
    { text: `… ${lines.length - kept.length} hidden by filter '${filter}'`, tone: "muted" as Tone },
    ...kept,
  ];
}

/**
 * Take the visible window out of a body. `scroll` counts rows back from the
 * newest line, so 0 always shows the tail — the position an operator watching
 * a live run wants.
 */
function window(body: readonly WidgetLine[], rows: number, scroll: number, anchor: "tail" | "head"): WidgetLine[] {
  if (rows <= 0) {
    return [];
  }
  if (body.length <= rows) {
    return [...body];
  }
  if (anchor === "head") {
    const start = Math.max(0, Math.min(scroll, body.length - rows));
    return body.slice(start, start + rows);
  }
  const maxBack = body.length - rows;
  const back = Math.max(0, Math.min(scroll, maxBack));
  const start = maxBack - back;
  const slice = body.slice(start, start + rows);
  if (start > 0 && slice.length > 0) {
    slice[0] = { text: `↑ ${start} more`, tone: "muted" };
  }
  return slice;
}

function demandOf(body: readonly WidgetLine[], min: number, grow: number): Demand {
  const ideal = Math.max(min, body.length);
  return { min: Math.min(min, ideal), ideal, grow };
}

// ---------------------------------------------------------------- alerts

/**
 * Everything the operator must not miss, ranked. The old board buried
 * `swe/result unresolved` as the last row of the EVENTS pane, visually equal
 * to a routine `agent/step`. Anything here is derived from a logged event.
 */
/**
 * Alerts are derived once per projection, not once per paint.
 *
 * `alertsFor` went through the body cache, but the pane's `relevant()` called
 * this directly -- and the layout asks every widget whether it is relevant on
 * EVERY paint. So the whole alert set, every helper of it, was recomputed ten
 * times a second while the cached copy sat unused beside it. Measured on a
 * live 119,000-event log, that was most of what the board was doing.
 *
 * A projection object is built once and never mutated, which is the same
 * invariant the body cache already relies on.
 */
const ALERT_BODY = new WeakMap<DashProjection, Map<string, WidgetLine[]>>();

function alertBody(view: DashProjection, width: number, detail: boolean): WidgetLine[] {
  let perView = ALERT_BODY.get(view);
  if (!perView) {
    perView = new Map();
    ALERT_BODY.set(view, perView);
  }
  const key = `${width}:${detail}`;
  const hit = perView.get(key);
  if (hit) return hit;
  const built = buildAlertBody(view, width, detail);
  perView.set(key, built);
  return built;
}

function buildAlertBody(view: DashProjection, width: number, detail: boolean): WidgetLine[] {
  const out: WidgetLine[] = [];
  const push = (text: string, tone: Tone) => {
    for (const row of wrapText(text, width)) {
      out.push({ text: row, tone });
    }
  };
  const result = view.index.last("swe/result");
  if (result) {
    const resolved = result.payload.resolved === true;
    const blame = typeof result.payload.blame === "string" ? ` blame=${result.payload.blame}` : "";
    push(`${resolved ? "✔" : "✖"} swe/result ${resolved ? "resolved" : "unresolved"}${blame}`, resolved ? "ok" : "bad");
  }
  for (const refusal of view.work.refusals) {
    push(`⛔ refused ${refusal}`, "bad");
  }
  if (view.work.executionViews) push(`execution views: ${view.work.executionViews}`, "muted");
  if (view.work.reviewDecision) push(`review decision: ${view.work.reviewDecision}`, "muted");
  if (view.work.initialRegression) push(`initial regression: ${view.work.initialRegression}`, "muted");
  if (view.work.checkerRevisions) push(`checker revisions: ${view.work.checkerRevisions}`, "muted");
  const approval = pendingOperatorApproval(approvalEventsOf(view));
  if (approval?.kind === "ssh") {
    push(`◆ SSH approval target=${approval.approval.target} — /ssh approve once | /ssh approve session | /ssh deny`, "ember");
  }
  if (approval?.kind === "github-admin") {
    push(`◆ GitHub approval repo=${approval.approval.repo} visibility=private — /github-admin approve once | /github-admin deny`, "ember");
  }
  if (approval?.kind === "mcp") {
    push(
      approval.approval.operation === "server_enroll"
        ? `◆ MCP enrollment server=${approval.approval.server} — /mcp approve once | /mcp deny`
        : `◆ MCP tool server=${approval.approval.server} tool=${approval.approval.tool ?? "unavailable"} — /mcp approve once | /mcp approve session | /mcp deny`,
      "ember",
    );
  }
  if (approval?.kind === "plugin-install") {
    push(
      `◆ Plugin install id=${approval.approval.id} repo=${approval.approval.repository} — /plugin approve once | /plugin deny`,
      "ember",
    );
  }
  const failover = [...view.events].reverse().find((event) =>
    event.name === "model/failover" || event.name === "model/route_transition"
  );
  if (failover?.name === "model/failover" && failover.payload.action === "ask") {
    const summaries = Array.isArray(failover.payload.candidate_summaries)
      ? failover.payload.candidate_summaries
          .map(failoverCandidateAlert)
          .filter((item): item is string => item !== undefined)
      : [];
    const continuity = failover.payload.continuity === "continue" || failover.payload.continuity === "checkpoint"
      ? failover.payload.continuity
      : "unknown";
    const candidates = summaries.length > 0 ? summaries.join("; ") : "candidate details unavailable";
    push(`◆ model failover approval required continuity=${continuity} — ${candidates} — /failover approve [route/model] or /failover reject`, "ember");
  }
  const fail = lastFailLine(view);
  if (fail) {
    push(`✖ ${fail}`, "bad");
  }
  // Unfocused glances read the current operator turn; focus reads history.
  const derived = derivedAlerts(view, detail ? 0 : lastOperatorSeqOf(view)).map((item) => item.text);
  const toolAlerts = derived.filter((line) => line.startsWith("tool_error"));
  const others = derived.filter((line) => !line.startsWith("tool_error"));
  for (const alert of others) {
    push(`▲ ${alert}`, alert.startsWith("compaction_unsealed") ? "bad" : "ember");
  }
  if (toolAlerts.length === 0) {
    return out;
  }
  if (!detail) {
    // A small box states that something failed and how much; the diagnosis
    // and the output belong to the expanded pane.
    const total = toolAlerts.reduce((sum, line) => sum + countOf(line), 0);
    const tools = [...new Set(toolAlerts.map((line) => line.split(" ")[1] ?? "tool"))];
    push(`▲ ${total} tool failure${total === 1 ? "" : "s"} (${tools.join(", ")}) — z to expand`, "ember");
    return out;
  }
  for (const alert of toolAlerts) {
    push(`▲ ${alert}`, "ember");
  }
  // The stderr tail is the answer to "why", and only the expanded pane has
  // the rows to carry it.
  const failed = [...view.work.lastToolCalls].reverse().find((call) => call.result_error === true);
  const tail = failed?.result_text
    ?.trim()
    .split("\n")
    .filter((row) => row.trim().length > 0)
    .slice(-3);
  for (const row of tail ?? []) {
    push(`  ${row}`, "muted");
  }
  return out;
}

function failoverCandidateAlert(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.route !== "string" || typeof row.model !== "string") return undefined;
  const selection = `${row.route}/${row.model}`;
  if (
    selection.length > 320
    || /[\u0000-\u001f\u007f]/u.test(selection)
    || containsSecret(selection)
    || containsPrivateInfrastructure(selection)
  ) return undefined;
  const auth = oneOf(row.auth, ["connected", "missing", "expired", "unknown"] as const);
  const cost = oneOf(row.cost, ["free", "subscription", "paid", "unknown"] as const);
  const freshness = oneOf(row.quota_freshness, ["fresh", "stale", "unknown"] as const);
  const remaining = typeof row.quota_remaining_percent === "number"
    && Number.isFinite(row.quota_remaining_percent)
    && row.quota_remaining_percent >= 0
    && row.quota_remaining_percent <= 100
    ? ` remaining=${row.quota_remaining_percent}%`
    : "";
  return `${selection} auth=${auth ?? "unknown"} cost=${cost ?? "unknown"} quota=${freshness ?? "unknown"}${remaining}`;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value as T[number]) ? value as T[number] : undefined;
}

/** `tool_error bash exit_nonzero ×3 latest_seq=9` → 3 */
function countOf(line: string): number {
  const match = /×(\d+)/.exec(line);
  return match ? Number(match[1]) : 1;
}

/**
 * Detail is earned by room. A three-row box says what failed; a focused or
 * zoomed pane says why, with the output that proves it.
 */
/** Pending operator authority keeps the pane on every board. */
/**
 * Also asked on every paint, by the pane's `pinned()`. It copied the whole log
 * to reverse it, twice over -- once here and once inside the approval scan.
 */
const PENDING_AUTHORITY = new WeakMap<DashProjection, boolean>();

function pendingAuthority(view: DashProjection): boolean {
  const hit = PENDING_AUTHORITY.get(view);
  if (hit !== undefined) return hit;
  const answer = computePendingAuthority(view);
  PENDING_AUTHORITY.set(view, answer);
  return answer;
}

function computePendingAuthority(view: DashProjection): boolean {
  if (pendingOperatorApproval(approvalEventsOf(view))) return true;
  const failedOver = view.index.last("model/failover");
  const transition = view.index.last("model/route_transition");
  const failover = (failedOver?.seq ?? -1) > (transition?.seq ?? -1) ? failedOver : transition;
  return failover?.name === "model/failover" && failover.payload.action === "ask";
}



function alertDetail(ctx: WidgetCtx): boolean {
  // Focus alone, not the row budget: `demand()` is asked with the whole body
  // as its budget while `lines()` gets the rows actually allotted, so a
  // size-based rule made the pane claim detail rows and then draw a summary.
  return ctx.focused;
}

function alertsFor(ctx: WidgetCtx): WidgetLine[] {
  const detail = alertDetail(ctx);
  return cachedBody(`alerts:${detail}`, ctx, () => alertBody(ctx.view, ctx.width, detail));
}

const alertsWidget: Widget = {
  id: "alerts",
  slot: "band",
  // The permanent band is gone (D-2026-08-25-97): current alerts ride the
  // one-line strip above the activity row, and this pane opens on demand —
  // the d drawer, /alerts, /zoom alerts — or pins itself while operator
  // authority is pending.
  bottom: true,
  priority: 0,
  optional: true,
  drawer: true,
  pinned: (view) => pendingAuthority(view),
  relevant: (view) => alertBody(view, 200, false).length > 0,
  title: (ctx) => (alertDetail(ctx) ? "ALERTS" : "ALERTS · z"),
  demand: (ctx) => demandOf(alertsFor(ctx).slice(0, ALERTS_MAX_ROWS), 1, 0),
  lines: (ctx) => fit(window(applyQuery(applyFilter(alertsFor(ctx), ctx.filter), ctx.query), ctx.rows, ctx.scroll, "head"), ctx.width),
};

/** Content rows the bottom ALERTS band may occupy before `z` takes over. */
const ALERTS_MAX_ROWS = 4;

// ------------------------------------------------------------------ plan

/** `done/total` as a cell-per-todo strip plus a percentage. */
const GOAL_ROWS = 2;

function mask(value: string | "missing"): string {
  return value === "missing" ? "-" : value;
}

/**
 * The todo list. A sealed plan is the source when there is one: `work.todos`
 * only carries the ids the loop has emitted `work/todo` for, so a freshly
 * bound plan would otherwise show a goal with no work under it.
 */
function planTodoRows(view: DashProjection): { id: string; title: string; state: string }[] {
  if (view.plan && view.plan.todos.length > 0) {
    return [...view.plan.todos]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((todo) => ({
        id: todo.id,
        title: todo.title,
        state: view.work.todos.find((row) => row.id === todo.id)?.state ?? "ready",
      }));
  }
  return view.work.todos.map((todo) => ({ id: todo.id, title: todo.title, state: String(todo.state) }));
}

function planProgress(view: DashProjection, width: number): WidgetLine[] {
  const todos = planTodoRows(view);
  if (todos.length === 0) {
    return [];
  }
  const done = todos.filter((todo) => todo.state === "clear" || todo.state === "green").length;
  const label = `${done}/${todos.length}`;
  const barWidth = Math.max(6, width - label.length - 8);
  const pct = todos.length > 0 ? done / todos.length : 0;
  return [
    { text: `${gauge(pct, barWidth)} ${label} ${Math.round(pct * 100)}%`, tone: done === todos.length ? "ok" : "bar" },
  ];
}

/**
 * Body order is priority order: the pane is cut from the bottom when rows are
 * short, so what an operator needs first is written first. The todo rows come
 * before the order's prose — which work exists beats how it was worded — and
 * the DAG comes last because it costs four rows a node for the same facts.
 */
function planBody(view: DashProjection, width: number, detail: boolean): WidgetLine[] {
  const out: WidgetLine[] = [];
  if (view.work.ralphPlan !== "missing") {
    const plan = view.work.ralphPlan;
    const pass = plan.pass === "missing" ? "?" : String(plan.pass);
    const max = plan.maxPasses === "missing" ? "?" : String(plan.maxPasses);
    const role = plan.role === "missing" ? "" : ` · ${plan.role.toUpperCase()}`;
    const reason = plan.reason ? ` · ${plan.reason}` : "";
    out.push({
      text: ellipsize(`RALPH PLAN ${pass}/${max}${role} · ${plan.status}${reason}`, width),
      tone: plan.status === "converged" ? "ok" : plan.status === "stopped" ? "bad" : "lane",
    });
    const revision = plan.revision === "missing" ? "?" : String(plan.revision);
    const digest = plan.digest === "missing" ? "?" : plan.digest.slice(0, 12);
    out.push({
      text: ellipsize(`revision=${revision} · digest=${digest} · gaps=${plan.newGaps} · unknowns=${plan.unknowns} · contradictions=${plan.contradictions}`, width),
      tone: plan.contradictions > 0 ? "ember" : "muted",
    });
  }
  if (view.work.goalId !== "missing") {
    out.push({ text: ellipsize(`goal  ${view.work.goalId}`, width), tone: "title" });
  }
  out.push(...planProgress(view, width));
  const rows = planTodoRows(view);
  const doing = view.work.doing;
  for (const todo of rows) {
    const state = todo.id === doing ? "doing" : todo.state;
    const mark = statusMark(String(state));
    out.push({
      text: ellipsize(`${mark.glyph} ${todo.id} ${todo.title}`, width),
      tone: todo.id === doing ? "lane" : mark.tone,
    });
  }
  // Which todo is next, which is being worked, what is finished or stuck.
  // Blocked ids wrap rather than clip: a hidden blocker is a hidden reason
  // the run is not moving.
  for (const row of wrapText(`next=${mask(view.work.intending)} now=${mask(view.work.doing)}`, width)) {
    out.push({ text: row, tone: "lane" });
  }
  // No done= list: every finished todo already carries ✅ in the rows above,
  // so spelling the ids out again spent sidebar rows to repeat the glyphs.
  // Blocked keeps its line and wraps rather than clips — a hidden blocker is
  // a hidden reason the run is not moving.
  out.push(...wrapText(`blocked=${view.work.blocked.join(", ") || "-"}`, width).map((row) => ({
    text: row,
    tone: view.work.blocked.length > 0 ? ("ember" as Tone) : ("muted" as Tone),
  })));
  const goal = view.work.goal;
  if (goal !== "missing") {
    // The order can be a whole SWE problem statement. The pane carries a
    // fixed-height headline; `dokkabi plan show` keeps the full text.
    const flat = goal.replaceAll(/\s+/g, " ").trim();
    const wrapped = wrapText(flat, width);
    for (let i = 0; i < GOAL_ROWS; i += 1) {
      const last = i === GOAL_ROWS - 1 && wrapped.length > GOAL_ROWS;
      out.push({ text: last ? ellipsize(`${wrapped[i] ?? ""} …`, width) : wrapped[i] ?? "", tone: "accent" });
    }
  }
  // The graph belongs to the expanded pane. In a sidebar a DAG of more than
  // two or three nodes is a truncated mess that answers nothing the list
  // above has not already answered — and the list fits.
  const todoCount = view.plan?.todos.length ?? 0;
  if (detail && todoCount > 1) {
    const graph = workGraphLines(view, width);
    if (graph.length > 0) {
      out.push({ text: "", tone: "default" });
      for (const row of graph) {
        out.push({ text: clip(row, width), tone: "default" });
      }
    }
  } else if (todoCount > 1) {
    // Say where it went, or an operator never learns the graph exists.
    out.push({ text: ellipsize(`${todoCount} todos · /zoom work for the graph`, width), tone: "muted" });
  }
  if (out.length === 0) {
    out.push({ text: "(no sealed plan)", tone: "muted" });
  }
  return out;
}

/**
 * The sidebar lists the work; the expanded pane draws it. Focus is the
 * signal, the same one ALERTS uses, so `z` and `/zoom work` both reach it.
 */
function planFor(ctx: WidgetCtx): WidgetLine[] {
  const detail = ctx.focused;
  return cachedBody(`plan:${detail}`, ctx, () => planBody(ctx.view, ctx.width, detail));
}

const planWidget: Widget = {
  id: "plan",
  slot: "side",
  priority: 1,
  // Field feedback (#37): a chat session has no plan, and an empty WORK
  // pane spends a column saying so. Work runs still get the pane (the goal
  // is on the log, or bound in memory for dev sessions).
  relevant: (view) => view.work.goalId !== "missing" || view.work.todos.length > 0,
  // "WORK" is the repo's word for this (work/goal, work/todo, dokkabi work);
  // the pane leads with the todo list, so it is no longer "the graph pane".
  title: (ctx) => {
    const todos = planTodoRows(ctx.view);
    if (todos.length === 0) {
      return "WORK";
    }
    const done = todos.filter((todo) => todo.state === "clear" || todo.state === "green").length;
    return `WORK ${done}/${todos.length}`;
  },
  demand: (ctx) => {
    const body = planFor(ctx);
    // The pane is worthless without the todo rows under the goal, so the
    // minimum covers the goal line, the gauge and every todo — nothing more.
    // The floor covers the goal line, the gauge, every todo, and the lane
    // and blocked rows — the facts a sidebar exists to show.
    const blockedRows = wrapText(`blocked=${ctx.view.work.blocked.join(", ") || "-"}`, ctx.width).length;
    const floor = 3 + planTodoRows(ctx.view).length + blockedRows;
    return { min: Math.max(1, Math.min(body.length, floor)), ideal: Math.max(1, body.length), grow: 0 };
  },
  lines: (ctx) => fit(window(applyQuery(applyFilter(planFor(ctx), ctx.filter), ctx.query), ctx.rows, ctx.scroll, "head"), ctx.width),
};

// ---------------------------------------------------------------- stream

/**
 * The open turn, drawn as the block it is about to become.
 *
 * The old form was a spinner plus one dim line, so a reply appeared as
 * `⠋ thinking` in thought tone and then jumped into `dokkabi ❯` with the full
 * text the moment the turn closed — and the label said "thinking" while the
 * line underneath was the reply. Writing it in its final shape means nothing
 * moves when the turn ends; only the spinner goes away.
 *
 * The log carries a tail, not the whole generation (`model/progress`), so
 * that is what is shown — never a reconstruction (constitution 6).
 */
function activeStatus(view: DashProjection, width: number, now: number): WidgetLine[] {
  const generating = view.work.generating;
  if (generating === "missing") {
    const lastTool = view.tools.at(-1);
    if (lastTool && lastTool.phase === "start") {
      return [{ text: `${spinnerFrame(now)} running: ${lastTool.name}…`, tone: "spin" }];
    }
    return [];
  }
  // Wall-clock, not event-clock: model/progress can go quiet for seconds
  // during a long tool-call write, and a heartbeat that freezes with it
  // reads as a hang. The spinner turns with every paint and the seconds
  // tick between events; replay passes event time as now, so determinism
  // holds.
  const frame = spinnerFrame(now);
  const elapsedS = generatingElapsedSeconds(generating, now);
  const total = generating.chars + generating.thinking_chars + generating.tool_chars;
  const writingTool = generating.tool_chars > 0 && generating.tool_chars >= generating.chars;
  const reply = (generating.text_tail ?? "").trim();
  const thought = (generating.thinking_tail ?? "").trim();
  // Show whichever the model is actually producing, and label it that way.
  const showReply = !writingTool && reply.length > 0 && generating.chars >= generating.thinking_chars;
  const lines: WidgetLine[] = [];

  if (writingTool) {
    lines.push({ text: `${frame} writing tool call +${elapsedS}s (${compact(total)} chars)`, tone: "spin" });
    return lines;
  }
  if (showReply) {
    lines.push({ text: "dokkabi ❯", tone: "title" });
    for (const row of renderMarkdown(reply, width)) {
      lines.push(row as WidgetLine);
    }
    lines.push({ text: `${frame} +${elapsedS}s · ${compact(total)} chars`, tone: "spin" });
    return lines;
  }
  const body = thought || reply;
  if (body.length > 0) {
    lines.push({ text: `▶ thinking (${compact(generating.thinking_chars)} chars)`, tone: "thought" });
    for (const row of wrapText(body.replaceAll("\n", " "), Math.max(8, width - 2)).slice(-10)) {
      lines.push({ text: `│ ${row}`, tone: "thought" });
    }
    lines.push({ text: `${frame} +${elapsedS}s · ${compact(total)} chars`, tone: "spin" });
    return lines;
  }
  // No tail text to show (progress counters only): the spinner line itself
  // must carry the contextual verb, or the active block is a bare timer.
  const verb = generating.thinking_chars > generating.chars
    ? "thinking"
    : total > 0 ? "writing" : "generating";
  lines.push({ text: `${frame} ${verb} +${elapsedS}s · ${compact(total)} chars`, tone: "spin" });
  return lines;
}

/**
 * Turn boundaries from the end, and how many turns came before them.
 *
 * The pane needs the last few turns; building the session's every turn to
 * show twenty rows cost 786ms on a live log. Slicing at a turn_start keeps
 * each block whole -- a tool call and its result stay together -- and the
 * count of earlier turns keeps the labels right.
 */
function streamTail(
  events: readonly EventRecord[],
  turns: number,
): { events: readonly EventRecord[]; startTurn: number } {
  let total = 0;
  const starts: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.name === "agent/step" && event.payload.phase === "turn_start") {
      total += 1;
      starts.push(i);
    }
  }
  if (starts.length <= turns) return { events, startTurn: 0 };
  const at = starts[starts.length - turns]!;
  return { events: events.slice(at), startTurn: total - turns };
}

/** Turns to build for a pane that wants `lines` rows, before widening. */
const STREAM_TURNS_PER_TRY = [12, 40, 120] as const;

function streamBody(
  view: DashProjection,
  width: number,
  reasoning: boolean,
  /** Rows the caller will actually show, plus what it may scroll into. */
  need = Number.POSITIVE_INFINITY,
): WidgetLine[] {
  const head: WidgetLine[] =
    view.thinkingLevel === "off"
      ? [{ text: "(reasoning off for this run — no thought is recorded)", tone: "muted" }]
      : [];
  let blocks: ReturnType<typeof buildTurnBlocks>;
  let built: WidgetLine[] | undefined;
  try {
    // Widen until the pane is covered or the log runs out: short turns need
    // more of them, and the pane must never show blank rows it could fill.
    for (const turns of Number.isFinite(need) ? STREAM_TURNS_PER_TRY : [Number.POSITIVE_INFINITY]) {
      const tail = streamTail(view.events, turns);
      blocks = buildTurnBlocks(tail.events, tail.startTurn);
      built = flatten(blocks, head, width, reasoning);
      if (built.length >= need || tail.events.length === view.events.length) break;
    }
    return built ?? [];
  } catch (error) {
    // A parse failure costs one pane line, never the board.
    const message = error instanceof Error ? error.message : String(error);
    return [{ text: `(stream render failed: ${message.slice(0, 80)})`, tone: "bad" }];
  }
}

function flatten(
  blocks: ReturnType<typeof buildTurnBlocks>,
  head: readonly WidgetLine[],
  width: number,
  reasoning: boolean,
): WidgetLine[] {
  const flat: WidgetLine[] = [...head];
  for (const block of blocks) {
    let rendered = renderTurnBlock(block, width);
    if (!reasoning) {
      rendered = rendered.filter((line) => line.tone !== "thought" && line.text !== "");
    }
    if (flat.length > 0 && rendered.length > 0) {
      flat.push({ text: "", tone: "muted" });
    }
    flat.push(...rendered);
  }
  return flat;
}

/**
 * How far past the visible rows the stream builds.
 *
 * Enough that scrolling back a screen or two costs nothing, quantised so a
 * one-row scroll does not invalidate the cached body and rebuild it.
 */
const STREAM_PREFETCH_LINES = 240;
const STREAM_NEED_STEP = 120;

function streamNeed(ctx: WidgetCtx): number {
  const want = ctx.rows + Math.abs(ctx.scroll) + STREAM_PREFETCH_LINES;
  return Math.ceil(want / STREAM_NEED_STEP) * STREAM_NEED_STEP;
}

/** The body, keyed by what it was built to cover as well as by width. */
function streamCached(ctx: WidgetCtx, reasoning: boolean): WidgetLine[] {
  const need = streamNeed(ctx);
  return cachedBody(
    `stream:${reasoning}:${need}`,
    ctx,
    () => streamBody(ctx.view, ctx.width, reasoning, need),
  );
}

const streamWidget: Widget = {
  id: "stream",
  slot: "band",
  priority: 0,
  relevant: () => true,
  title: (ctx) => {
    const turns = ctx.view.sessionStats.turns;
    return turns > 0 ? `MODEL STREAM · turn ${turns}` : "MODEL STREAM";
  },
  demand: (ctx) => {
    const body = streamCached(ctx, ctx.width >= 60);
    // The stream is the pane that always deserves more room: it grows hard,
    // and below six rows a turn block cannot even show its shape.
    return { min: 6, ideal: Math.max(6, body.length), grow: 6 };
  },
  lines: (ctx) => {
    const reasoning = ctx.width >= 60;
    const body = streamCached(ctx, reasoning);
      const status = activeStatus(ctx.view, ctx.width, ctx.now);
    const whole = status.length > 0 ? [...body, ...(body.length > 0 ? [{ text: "", tone: "muted" as Tone }] : []), ...status] : body;
    if (whole.length === 0) {
      return [{ text: "(no model reply yet)", tone: "muted" }];
    }
    return fit(window(applyQuery(applyFilter(whole, ctx.filter), ctx.query), ctx.rows, ctx.scroll, "tail"), ctx.width);
  },
};

// ----------------------------------------------------------------- tools

/**
 * Tool lifetime, not a name count (docs/observability.md). The slowest tool
 * of the session sets the bar scale, so one pathological `bash` is obvious
 * next to a millisecond `read`.
 */
function toolsBody(view: DashProjection, width: number): WidgetLine[] {
  const out: WidgetLine[] = [];
  const peak = view.toolMax.reduce((max, row) => Math.max(max, row.max_ms), 0);
  if (peak > 0) {
    const nameW = Math.max(4, ...view.toolMax.map((row) => row.name.length));
    const valueW = 8;
    const barW = Math.max(4, width - nameW - valueW - 3);
    for (const row of [...view.toolMax].sort((a, b) => b.max_ms - a.max_ms)) {
      out.push({
        text: `${padTo(row.name, nameW)} ${latencyBar(row.max_ms, peak, barW)} ${fmtDuration(row.max_ms).padStart(valueW - 1)}`,
        tone: row.max_ms >= peak ? "ember" : "default",
      });
    }
  }
  for (const row of view.toolSlow.slice(-3)) {
    const waited = row.waited_ms === undefined ? "" : ` wait=${fmtDuration(row.waited_ms)}`;
    out.push({ text: ellipsize(`slow ${row.name} ${fmtDuration(row.duration_ms)} ${row.reason}${waited}`, width), tone: "bad" });
  }
  const recent = toolLines(view, 6).filter((line) => !line.includes("max_ms=") && !line.startsWith("slow "));
  if (recent.length > 0 && recent[0] !== "(none)") {
    if (out.length > 0) {
      out.push({ text: "", tone: "default" });
    }
    for (const line of recent) {
      out.push({
        text: ellipsize(line, width),
        tone: line.includes("err=1") ? "bad" : line.includes(" start ") ? "ember" : "default",
      });
    }
  }
  for (const line of view.compaction.length > 0 ? compactionLines(view, 2) : []) {
    out.push({ text: ellipsize(line, width), tone: "ember" });
  }
  for (const line of view.blobGc ? blobGcLines(view, 2) : []) {
    out.push({ text: ellipsize(line, width), tone: "muted" });
  }
  return out.length > 0 ? out : [{ text: "(no tool calls yet)", tone: "muted" }];
}

const toolsWidget: Widget = {
  id: "tools",
  slot: "aux",
  priority: 3,
  // The pane restates what the board already carries — per-call durations
  // and [slow] suffixes ride MODEL STREAM, failures ride ALERTS, and the
  // aggregate headline rides the status bits row (toolsBarLine). It opens on
  // demand: the d accounting drawer, /tools focus, or /zoom tools.
  optional: true,
  drawer: true,
  relevant: () => true,
  title: (ctx) =>
    ctx.view.tools.length > 0 ? `TOOLS ${ctx.view.tools.filter((row) => row.phase === "end").length}` : "TOOLS",
  // Three rows like EVENTS: a tail with a count in the title.
  demand: () => ({ min: 3, ideal: 3, grow: 0 }),
  lines: (ctx) =>
    fit(
      window(applyQuery(applyFilter(cachedBody("tools", ctx, () => toolsBody(ctx.view, ctx.width)), ctx.filter), ctx.query), ctx.rows, ctx.scroll, "tail"),
      ctx.width,
    ),
};

// ---------------------------------------------------------------- events

/**
 * `model/progress` is a heartbeat: a single 3-minute turn writes hundreds of
 * them and they push every other actor off the pane. A run of them collapses
 * to its newest line plus a count — the individual ticks stay in the log.
 */
function foldHeartbeats(rows: readonly { text: string; tone: Tone }[]): { text: string; tone: Tone }[] {
  const out: { text: string; tone: Tone }[] = [];
  let run = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const isBeat = row.text.includes("model/progress");
    const nextIsBeat = rows[i + 1]?.text.includes("model/progress") === true;
    if (isBeat && nextIsBeat) {
      run += 1;
      continue;
    }
    if (isBeat && run > 0) {
      out.push({ text: `${row.text}  (${run + 1} ticks folded)`, tone: "muted" });
      run = 0;
      continue;
    }
    out.push(row);
  }
  return out;
}

function eventsBody(view: DashProjection, width: number): WidgetLine[] {
  const rows = foldHeartbeats(eventScanLines(view, 4_000));
  return rows.map((row) => ({ text: ellipsize(row.text, width), tone: row.tone }));
}

const eventsWidget: Widget = {
  id: "events",
  slot: "main",
  // The firehose is a drawer (D-2026-08-25-95): failures ride ALERTS, model
  // output rides STREAM, activity rides TIMELINE and the activity row, and
  // the count/span/recency aggregates ride the TIMELINE title and header.
  // d, /events, or /zoom events summons the raw seq tail on demand.
  optional: true,
  drawer: true,
  priority: 2,
  relevant: () => true,
  title: (ctx) => scanPaneTitle("EVENTS", scanSource(ctx.view), ctx.width + 2),
  // Field feedback (#37): EVENTS grew with its body and starved the stream
  // while leaving the board half blank. It is a tail, not a reading
  // surface: three rows, scroll (j/k) for more.
  demand: () => ({ min: 3, ideal: 3, grow: 0 }),
  lines: (ctx) =>
    fit(
      window(applyQuery(applyFilter(cachedBody("events", ctx, () => eventsBody(ctx.view, ctx.width)), ctx.filter), ctx.query), ctx.rows, ctx.scroll, "tail"),
      ctx.width,
    ),
};

// ---------------------------------------------------------------- tokens

/**
 * One row per model request: the input bar split into cache read and cache
 * write, with the generation boundary marked. A hit collapse next to a
 * `prompt/seal` reads as cause and effect in the same column.
 */
function tokensBody(view: DashProjection, width: number): WidgetLine[] {
  const requests = view.requests;
  if (requests.length === 0) {
    return [{ text: "(no model request recorded)", tone: "muted" }];
  }
  const out: WidgetLine[] = [];
  const stats = view.sessionStats;
  const track = hitTrack(stats.hits, HIT_WARMUP_TURNS, HIT_FLOOR, stats.hitSkip);
  if (track.series.length > 0) {
    // One cell per request: full block at or above the floor, half below,
    // a dot where the ratio was never reported or the turn was skipped.
    const spark = track.series
      .map((value, index) =>
        stats.hitSkip[index] === true || typeof value !== "number"
          ? "·"
          : value >= track.floor
            ? "█"
            : value >= 0.5
              ? "▄"
              : "▁",
      )
      .join("");
    out.push({ text: ellipsize(`hit ${spark.slice(-Math.max(4, width - 6))}`, width), tone: "bar" });
  }
  const labelW = 7;
  const tailW = 20;
  const barW = Math.max(6, width - labelW - tailW - 2);
  for (const row of requests.slice(-40)) {
    const read = typeof row.cache_read_tokens === "number" ? row.cache_read_tokens : 0;
    const input = typeof row.input_tokens === "number" ? row.input_tokens : 0;
    const write = Math.max(0, input - read);
    const stacked =
      input > 0
        ? stackBar(
            [
              { value: read, glyph: "▓", tone: "ok" },
              { value: write, glyph: "█", tone: "ember" },
            ],
            barW,
          )
        : { text: "·".repeat(barW), tones: Array.from({ length: barW }, () => "muted" as Tone) };
    const bar = stacked.text;
    const hit = typeof row.hit_ratio === "number" ? `${Math.round(row.hit_ratio * 100)}%` : "-";
    out.push({
      text: clip(
        `${padTo(`${row.sealed ? "│" : " "}${row.seq}`, labelW)}${bar} ${padTo(`${hit} in=${formatMetricK(row.input_tokens)}`, tailW)}`,
        width,
      ),
      tone: row.sealed ? "ember" : "default",
      cells: [...Array.from({ length: labelW }, () => (row.sealed ? "ember" : "muted") as Tone), ...stacked.tones],
    });
  }
  return out;
}

const tokensWidget: Widget = {
  id: "tokens",
  slot: "aux",
  drawer: true,
  priority: 4,
  optional: true,
  relevant: (view) => view.requests.length > 0,
  title: () => "TOKENS ▓read █write",
  demand: (ctx) => ({ min: 2, ideal: Math.max(2, cachedBody("tokens", ctx, () => tokensBody(ctx.view, ctx.width)).length), grow: 1 }),
  lines: (ctx) =>
    fit(window(cachedBody("tokens", ctx, () => tokensBody(ctx.view, ctx.width)), ctx.rows, ctx.scroll, "tail"), ctx.width),
};

// --------------------------------------------------------------- context

/** What the last prompt was actually made of, as a single stacked bar. */
function contextBody(view: DashProjection, width: number): WidgetLine[] {
  const layers = view.contextLayers;
  if (!layers) {
    return [{ text: "(no context_layers recorded)", tone: "muted" }];
  }
  const segments = [
    { value: layers.system, glyph: "█", tone: "lane" as Tone, label: "sys" },
    { value: layers.tools, glyph: "▓", tone: "ember" as Tone, label: "tools" },
    { value: layers.skills ?? 0, glyph: "▒", tone: "spin" as Tone, label: "skills" },
    { value: layers.history, glyph: "░", tone: "ok" as Tone, label: "hist" },
  ].filter((segment) => segment.value > 0);
  const bar = stackBar(segments, Math.max(4, width));
  const legend = segments.map((segment) => `${segment.glyph}${segment.label} ${compact(segment.value)}`).join("  ");
  const out: WidgetLine[] = [{ text: bar.text, tone: "default", cells: bar.tones }];
  for (const row of wrapText(legend, width)) {
    out.push({ text: row, tone: "muted" });
  }
  const ratio = contextRatio(view);
  if (ratio !== undefined) {
    out.push({ text: ellipsize(`window ${gauge(ratio, Math.max(4, width - 8))} ${Math.round(ratio * 100)}%`, width), tone: ratio > 0.8 ? "bad" : "bar" });
  }
  return out;
}

const contextWidget: Widget = {
  id: "context",
  slot: "aux",
  drawer: true,
  priority: 6,
  optional: true,
  relevant: (view) => view.contextLayers !== undefined,
  title: () => "CONTEXT",
  demand: (ctx) => demandOf(cachedBody("context", ctx, () => contextBody(ctx.view, ctx.width)), 2, 0),
  lines: (ctx) => fit(window(cachedBody("context", ctx, () => contextBody(ctx.view, ctx.width)), ctx.rows, 0, "head"), ctx.width),
};

// -------------------------------------------------------------- timeline

/**
 * Lane colour, not lane glyph.
 *
 * The ribbon used to spend its one row on which lane dominated a bucket, with
 * `▂` `▅` `█` standing for model, tool and input. Height now carries the event
 * rate, which is the question an operator actually has of a timeline — when
 * was it busy — so the lane moved to the colour of the stroke.
 */
/** Chart lanes get their own hues — magenta, gold, cyan — because the text
 * tones they used to borrow sit at chroma 1 in the 256-colour cube, which is
 * grey by any other name. A chart is read by colour; prose is not. */
const LANE_TONE: Record<string, Tone> = { I: "chartInput", M: "chartModel", T: "chartTool", O: "muted" };

/**
 * An operator moment, as opposed to the harness prompting itself.
 *
 * `user/message` is what the transcript contract calls everything sent to the
 * model, so the harness's own turns wear the same name as a person typing.
 * Only `source: "operator"` -- set by the interactive transports and by the
 * order itself -- is a landmark. Logs recorded before that field existed carry
 * no source and are not claimed as operator input.
 */
/**
 * The lane a stretch of time belongs to.
 *
 * Same as `eventLane`, except that a harness `user/message` is bookkeeping,
 * not an input phase: it is the prompt that STARTS a model turn, so the half
 * minute before it belongs to whatever was running, and it inherits the phase
 * around it exactly as `agent/step` does.
 */
function phaseLane(event: EventRecord): string {
  const lane = eventLane(event);
  return lane === "I" && !isOperatorInput(event) ? "O" : lane;
}

function isOperatorInput(event: EventRecord): boolean {
  if (event.name === "operator/note") {
    return true;
  }
  return event.name === "user/message" && event.payload.source === "operator";
}

/**
 * The whole session compressed to one ribbon: every cell is a bucket of
 * events, coloured by whichever lane dominated it. Long silences, tool storms
 * and the moment a run turned red are all visible without scrolling.
 */
function timelineBody(view: DashProjection, width: number): WidgetLine[] {
  const events = view.events;
  if (events.length === 0 || width < 8) {
    return [];
  }
  const buckets = Math.max(1, width);
  // Parsed once. `bucketOf` is called from three separate loops and the held-
  // time pass parses two more per interval, so a 118,000-event log was doing
  // most of half a million Date.parse calls to draw one ribbon.
  const at = new Float64Array(events.length);
  for (let i = 0; i < events.length; i += 1) at[i] = Date.parse(events[i]!.ts);
  const first = at[0]!;
  const last = at[events.length - 1]!;
  const span = Number.isNaN(first) || Number.isNaN(last) || last <= first ? undefined : last - first;
  // Buckets are wall time, not event index. Indexing made a burst and an idle
  // hour the same width, so the ribbon could not answer "when was it busy".
  const bucketOf = (index: number): number => {
    if (span === undefined) {
      return Math.min(buckets - 1, Math.floor((index * buckets) / events.length));
    }
    const stamp = at[index]!;
    if (Number.isNaN(stamp)) {
      return 0;
    }
    return Math.min(buckets - 1, Math.floor(((stamp - first) / span) * buckets));
  };
  const counts = new Array<number>(buckets).fill(0);
  const lanes: Record<string, number>[] = Array.from({ length: buckets }, () => ({ I: 0, M: 0, T: 0, O: 0 }));
  const bad = new Array<number>(buckets).fill(0);
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const at = bucketOf(i);
    counts[at] = (counts[at] ?? 0) + 1;
    const lane = eventLane(event);
    lanes[at]![lane] = (lanes[at]![lane] ?? 0) + 1;
    // Same classifier as the EVENTS tones: a boolean-only check missed every
    // failure recorded as a status string (agent/status failed, turn errors).
    if (isBadEvent(event)) {
      bad[at] = (bad[at] ?? 0) + 1;
    }
  }
  // Carry the lane across empty buckets. A gap between two tool calls is
  // still the tool phase and the half minute a model spends thinking is still
  // the model's, so colouring every quiet column grey made a real run — which
  // is mostly waiting — read as a grey field with a few coloured pixels in it.
  // The phase keeps its hue and drops to the dim companion instead.
  // Colour is what the run was doing over that stretch of time, not which
  // event name occurred most. Counting events let eight tool records outvote
  // the one assistant/message that ended a half-minute of thinking, so a
  // whole session came out in the tool's hue no matter how long the model had
  // actually held the floor.
  //
  // Every interval between two events belongs to the one that ends it: the
  // gap before a reply is the model working toward that reply. agent/step and
  // the other bookkeeping name no phase, so they inherit the next event that
  // does.
  const phaseOf: string[] = new Array(events.length).fill("");
  let ahead = "";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const lane = phaseLane(events[i]!);
    if (lane === "I" || lane === "M" || lane === "T") {
      ahead = lane;
    }
    phaseOf[i] = ahead;
  }
  let behind = "O";
  for (let i = 0; i < events.length; i += 1) {
    const lane = phaseLane(events[i]!);
    if (lane === "I" || lane === "M" || lane === "T") {
      behind = lane;
    }
    if (phaseOf[i] === "") {
      phaseOf[i] = behind;
    }
  }
  const held: Record<string, number>[] = Array.from({ length: buckets }, () => ({}));
  if (span !== undefined) {
    const per = span / buckets;
    for (let i = 1; i < events.length; i += 1) {
      const from = at[i - 1]! - first;
      const to = at[i]! - first;
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
        continue;
      }
      const lane = phaseOf[i]!;
      const last = Math.min(buckets - 1, Math.floor(to / per));
      for (let col = Math.max(0, Math.min(buckets - 1, Math.floor(from / per))); col <= last; col += 1) {
        const lo = Math.max(from, col * per);
        const hi = Math.min(to, (col + 1) * per);
        if (hi > lo) {
          held[col]![lane] = (held[col]![lane] ?? 0) + (hi - lo);
        }
      }
    }
  }
  const longest = (col: number): string => {
    let lane = "";
    for (const [key, time] of Object.entries(held[col] ?? {})) {
      if (key !== "O" && (lane === "" || time > (held[col]![lane] ?? 0))) {
        lane = key;
      }
    }
    return lane;
  };
  const carried: string[] = new Array(buckets).fill("");
  let next = "";
  for (let col = buckets - 1; col >= 0; col -= 1) {
    const lane = longest(col);
    if (lane !== "") {
      next = lane;
    }
    carried[col] = next;
  }
  let previous = "O";
  for (let col = 0; col < buckets; col += 1) {
    const lane = longest(col);
    if (lane !== "") {
      previous = lane;
    }
    if (carried[col] === "") {
      carried[col] = previous;
    }
  }
  // The activity strip carries ONE metric per channel: height is the event
  // rate, hue is the phase. Nothing else may touch either.
  const toneAt = (col: number): Tone => {
    const lane = LANE_TONE[carried[col] ?? "O"] ?? "muted";
    return (counts[col] ?? 0) === 0 ? dimTone(lane) : lane;
  };
  // Height is fixed, not read from ctx.rows: demand() and lines() are called
  // with different row budgets, and a body that changes shape between them
  // makes a pane claim rows it then does not draw.
  const activity = brailleArea(counts, width, ACTIVITY_ROWS, {
    baseline: "zero",
    columnTone: (col) => toneAt(col),
  });
  const cells: WidgetLine[] = activity.rows.map((row, i) => ({
    text: row,
    tone: "default" as Tone,
    cells: activity.tones[i],
  }));
  // Failure gets its own strip below, on its own scale, and never borrows a
  // column the activity strip needed to say what the run was doing.
  cells.push(faultStrip(bad, width));
  return cells;
}

/**
 * The fault line: when the run was failing, and how hard.
 *
 * Errors used to ride the activity strip's hue, and they won every column they
 * touched. That is what overloading a channel does -- whichever metric has a
 * veto takes the ribbon, and here 711 failures out of 56,966 events were
 * enough to put 84 of 120 columns in the error hue while `model` was never
 * drawn once. Raising the bar for red only moved the number at which the same
 * collision happens; it stayed one channel carrying two metrics.
 *
 * So failure is drawn separately, scaled against itself. An empty strip means
 * nothing failed, which is a thing the operator can read at a glance and could
 * not before.
 */
function faultStrip(bad: readonly number[], width: number): WidgetLine {
  const worst = Math.max(...bad, 0);
  if (worst <= 0) {
    // All-zero input would put brailleArea's flat line across the middle of
    // the strip -- a fault line drawn where there are no faults.
    return { text: " ".repeat(width), tone: "muted" };
  }
  const strip = brailleArea(bad, width, FAULT_ROWS, {
    baseline: "zero",
    columnTone: () => "chartBad",
  });
  // An area chart always inks its baseline, so a bucket that failed nothing
  // came out identical to one that failed once and the strip read as a solid
  // line: 29 clean stretches out of 120 were invisible. A clean column is
  // blank, so the gaps are the good news and they are legible.
  const glyphs = [...(strip.rows[0] ?? "")];
  const tones = [...(strip.tones[0] ?? [])];
  for (let col = 0; col < glyphs.length; col += 1) {
    if ((bad[col] ?? 0) === 0) {
      glyphs[col] = " ";
      tones[col] = "muted";
    }
  }
  return { text: glyphs.join(""), tone: "default", cells: tones };
}

/**
 * The title, with the legend in it.
 *
 * The legend lives on the title row because that row already exists. As a body
 * row it cost the pane a third of its height, and a band whose height depends
 * on how much else is on the board is a band that moves the stream every time
 * the plan blinks.
 *
 * Only the lanes the chart actually drew: a run that never took an operator
 * note should not spend room explaining the colour for one.
 */
/**
 * The title and its tones are one computation, asked for twice a paint --
 * `title` and `titleTones` are separate hooks over the same cells.
 */
const TIMELINE_TITLE = new WeakMap<DashProjection, { text: string; tones: Tone[] }>();

function timelineTitleCells(view: DashProjection): { text: string; tones: Tone[] } {
  const hit = TIMELINE_TITLE.get(view);
  if (hit) return hit;
  const built = buildTimelineTitleCells(view);
  TIMELINE_TITLE.set(view, built);
  return built;
}

function buildTimelineTitleCells(view: DashProjection): { text: string; tones: Tone[] } {
  const events = view.events;
  let text = "";
  const tones: Tone[] = [];
  const write = (chunk: string, tone: Tone): void => {
    text += chunk;
    for (const _ of chunk) {
      tones.push(tone);
    }
  };
  if (events.length === 0) {
    write("TIMELINE", "title");
    return { text, tones };
  }
  const first = Date.parse(events[0]!.ts);
  const last = Date.parse(events.at(-1)!.ts);
  const span = Number.isNaN(first) || Number.isNaN(last) || last <= first ? undefined : last - first;
  write(`TIMELINE · ${events.length} event${events.length === 1 ? "" : "s"}`, "title");
  if (span !== undefined) {
    write(` · ${fmtDuration(span)}`, "title");
  }
  // The legend names the lanes the CHART drew, so it has to classify input
  // the same way the chart does. Reading it off eventLane advertised a swatch
  // for a colour no column ever wore, because every harness turn is a
  // `user/message` and none of them is an operator moment.
  // Which lanes occurred, from the NAMES rather than the records. This mapped
  // every event in the log and called eventLane twice on each, on every paint,
  // to build a set of at most four strings.
  const seen = new Set(
    view.index.names().map((name) => {
      const lane = eventLane({ name });
      return lane === "I" ? "O" : lane;
    }),
  );
  if (view.index.of("operator/note").length > 0
    || view.index.of("user/message").some((event) => isOperatorInput(event))) {
    seen.add("I" as never);
  }
  const failed = events.some((event) => isBadEvent(event));
  for (const lane of ["I", "M", "T"]) {
    if (seen.has(lane as never)) {
      write("  ", "title");
      write("▇", LANE_TONE[lane] ?? "muted");
      write(` ${LANE_LABEL[lane] ?? lane}`, "title");
    }
  }
  // Name the two encodings the swatches cannot: what the area height means,
  // and what the dimmer shade of each hue is. `dim=idle` was only half true --
  // the dim companion is the area UNDER the rate line as well as a bucket with
  // no events at all, so a busy column shows both shades and the legend was
  // read as saying the run had gone quiet there.
  write(" · height=rate · bright=rate line, dim=below it", "title");
  // The fault line is a separate strip on its own scale, so the legend says
  // so rather than offering it as one more colour in the ribbon above.
  write("  ", "title");
  write("▁", failed ? "chartBad" : "muted");
  write(failed ? " fault line below" : " no faults", failed ? "title" : "muted");
  return { text, tones };
}

/** What each lane is called when the legend has to say it out loud. The
 * input lane is a phase like the others now: it no longer sizes anything, so
 * the legend no longer claims it does. */
const LANE_LABEL: Record<string, string> = { I: "operator", M: "model", T: "tool" };

/** Rows the activity strip draws: rate as height, phase as hue. */
const ACTIVITY_ROWS = 2;
/** The fault line below it. One row: it is a when, not a shape. */
const FAULT_ROWS = 1;
/** Chart rows the ribbon draws, above its legend. */
const TIMELINE_ROWS = ACTIVITY_ROWS + FAULT_ROWS;

const timelineWidget: Widget = {
  id: "timeline",
  slot: "band",
  priority: 3,
  relevant: (view) => view.events.length > 0,
  title: (ctx) => timelineTitleCells(ctx.view).text,
  titleTones: (ctx) => timelineTitleCells(ctx.view).tones,
  // Fixed height: the body is the chart and nothing else, so the pane cannot
  // change shape between demand() and lines() or as pressure moves around it.
  demand: () => ({ min: TIMELINE_ROWS, ideal: TIMELINE_ROWS, grow: 0 }),
  lines: (ctx) => fit(window(cachedBody("timeline", ctx, () => timelineBody(ctx.view, ctx.width)), ctx.rows, 0, "head"), ctx.width),
};

/**
 * Paint order. The bands come first, in the order they read: what is wrong,
 * when it happened, then what the model said. The stream is the widest thing
 * on the board because it is what an operator reads most, and the columns
 * underneath carry the work and the event tail.
 */
export const ALL_WIDGETS: readonly Widget[] = [
  // The timeline is the board's spine: one full-width row at the very top,
  // above the stream, so the shape of the run is readable before its prose.
  timelineWidget,
  streamWidget,
  planWidget,
  eventsWidget,
  toolsWidget,
  tokensWidget,
  contextWidget,
  alertsWidget,
];

const BY_ID = new Map<WidgetId, Widget>(ALL_WIDGETS.map((widget) => [widget.id, widget]));

export function widgetById(id: WidgetId | string): Widget | undefined {
  return BY_ID.get(id as WidgetId);
}
