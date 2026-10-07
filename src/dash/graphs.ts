import type { EventRecord } from "../host/schema.ts";
import { HIT_FLOOR, HIT_WARMUP_CONTEXT_TOKENS } from "../host/hit-ratio.ts";
import { containsPrivateInfrastructure, redactText } from "../host/redact.ts";
import { projectSessionReplaySchemas, type Metric } from "../host/schema.ts";
import { remoteFailureAlertLines } from "../remote/dashboard.ts";
import { fileURLToPath } from "node:url";
import { digestOf, DOCTOR_REPORT_EVENT, doctorAlertsFromEvents, type DoctorReport, type StaleReason } from "../host/doctor-report.ts";
import { installationKey } from "../host/doctor-identity.ts";
import { freshnessNow } from "../host/doctor-freshness.ts";
import { readConfig } from "../host/config.ts";
import { semanticLivelockValidation } from "../work/semantic-livelock-validation.ts";
import { formatMetricK } from "./cells.ts";
import type { DashProjection, UsageRequest } from "./project.ts";
import { Screen, dimTone, type Tone } from "./screen.ts";

const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPARK_MISSING = "·";

/**
 * Scale numbers to block glyphs over the min-max range of the shown window.
 * Missing values render as a dot. Values beyond `width` keep the newest tail.
 */
export function sparkLine(values: readonly (number | "missing")[], width = 24): string {
  const shown = values.slice(-Math.max(1, width));
  const present = shown.filter((value): value is number => typeof value === "number");
  if (present.length === 0) {
    return shown.map(() => SPARK_MISSING).join("");
  }
  let min = present[0]!;
  let max = present[0]!;
  for (const value of present) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  const flat = max === min;
  return shown
    .map((value) => {
      if (typeof value !== "number") {
        return SPARK_MISSING;
      }
      if (flat) {
        return SPARK_GLYPHS[3]!;
      }
      const ratio = (value - min) / (max - min);
      const index = Math.min(SPARK_GLYPHS.length - 1, Math.floor(ratio * SPARK_GLYPHS.length));
      return SPARK_GLYPHS[index]!;
    })
    .join("");
}

/**
 * One bar per model request: input split into cache read and cache write.
 * The boundary column marks requests that follow a prompt/seal, so a hit drop
 * next to a generation change is visible in the same row.
 */
export function tokenStackLines(requests: readonly UsageRequest[], width = 32, maxRows = 8): string[] {
  const header = "req    bar (░=cached ▓=paid uncached)  │=generation boundary";
  const rows = requests.slice(-maxRows).map((row) => {
    const label = `req${row.seq}`.padEnd(6);
    const boundary = row.sealed ? "│" : " ";
    // row.hit, not row.hit_ratio: the recorded ratio predates the write-aware
    // arithmetic on historical rows, and this pane printing 100% beside the
    // usage pane's corrected 8% was the exact contradiction #76's fix rounds
    // kept re-shipping.
    return `${label} ${boundary} ${requestBar(row, width)}  hit=${fmtHit(row.hit)} in=${formatMetricK(
      row.input_tokens,
    )} out=${formatMetricK(row.output_tokens)}`;
  });
  return [header, ...rows];
}

function requestBar(row: UsageRequest, width: number): string {
  if (width <= 0) {
    return "";
  }
  // The whole prompt is the derived occupancy, not `input`: where input is
  // the uncached tail (a constant ~2 on the write-reporting convention),
  // read/input clamps to a full bar and paints a 190k reload as 100% cached.
  const total = row.occupancy;
  if (typeof total !== "number" || total <= 0) {
    return SPARK_MISSING.repeat(width);
  }
  const read = typeof row.cache_read_tokens === "number" ? row.cache_read_tokens : 0;
  const readChars = Math.max(0, Math.min(width, Math.round((width * read) / total)));
  return "░".repeat(readChars) + "▓".repeat(width - readChars);
}

function fmtHit(hit: Metric): string {
  return typeof hit === "number" ? `${Math.round(hit * 100)}%` : "missing";
}

function fmtGap(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

/** Host history sparklines. Recorded samples only; no live remeasure. */
export function hostSparkLines(view: DashProjection, width = 24): string[] {
  const cpu = sparkLine(
    view.hostSeries.map((sample) => sample.cpu_pct),
    width,
  );
  const rss = sparkLine(
    view.hostSeries.map((sample) => sample.rss_bytes),
    width,
  );
  return [
    `cpu  ${cpu}  latest=${fmtHostMetric(view.host?.cpu_pct)}`,
    `rss  ${rss}  latest=${fmtBytes(view.host?.rss_bytes)}`,
  ];
}

export interface ChartBand {
  title: string;
  titleTone: Tone;
  rows: string[];
  tones: Tone[][];
}

const SUB_ROWS = 8;
const LEFT_DOTS = [0x01, 0x02, 0x04, 0x40];
const RIGHT_DOTS = [0x08, 0x10, 0x20, 0x80];

/** Braille dot bits, top to bottom, for the left and right half of a cell. */
const DOT_ROWS = 4;

export interface AreaChart {
  rows: string[];
  /** One tone per cell: bright on the stroke, dim under it. */
  tones: Tone[][];
  lo: number;
  hi: number;
}

export interface AreaOptions {
  /** "zero" anchors the floor at 0; "span" fits the data but on quantized
   * bounds so a sliding window does not re-scale the whole chart. */
  baseline?: "zero" | "span";
  /** Tone for the stroke of a column. Defaults to a flat accent. */
  columnTone?: (col: number, value: number) => Tone;
  /** Tone under the stroke. Defaults to the quiet companion of the stroke's
   * own tone, so the area carries the same lane at a lower intensity. */
  fillTone?: (col: number, value: number) => Tone;
  /** Per-column stacked-dot spike, 0..1 of the pane height, drawn from the
   * baseline on top of the area. Undefined columns draw no spike. */
  spike?: (col: number) => number | undefined;
}

/**
 * A series drawn as a connected braille stroke over a filled area.
 *
 * Two things made the old band read as scattered dots on a jumpy axis. It
 * plotted one dot per sub-column, so a climb from idle to busy left the two
 * ends of the move on screen and nothing in between; and it scaled to the
 * min and max of whatever happened to be in the window, so a 1ms wobble was
 * amplified to full height and the moment a spike aged out of the window
 * every surviving column jumped to a new height without its value changing.
 *
 * Here consecutive samples are joined, the area beneath is filled so the
 * shape reads at a glance, and the axis sits on quantized bounds that move in
 * steps rather than continuously.
 */
export function brailleArea(
  values: readonly number[],
  width: number,
  rows: number,
  options: AreaOptions = {},
): AreaChart {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(rows));
  const subCols = w * 2;
  const subRows = h * DOT_ROWS;
  const { lo, hi } = axisBounds(values, options.baseline ?? "span");
  const stroke: number[][] = Array.from({ length: h }, () => new Array<number>(w).fill(0));
  const fill: number[][] = Array.from({ length: h }, () => new Array<number>(w).fill(0));
  const sampleAt = (sub: number): number => {
    if (values.length === 0) {
      return lo;
    }
    return values[Math.min(values.length - 1, Math.floor((sub * values.length) / subCols))]!;
  };
  const yOf = (value: number): number => {
    const norm = hi === lo ? 0.5 : (value - lo) / (hi - lo);
    return Math.max(0, Math.min(subRows - 1, Math.round((1 - norm) * (subRows - 1))));
  };
  const mark = (grid: number[][], sub: number, y: number): void => {
    const col = sub >> 1;
    const row = Math.floor(y / DOT_ROWS);
    if (col < 0 || col >= w || row < 0 || row >= h) {
      return;
    }
    const bit = (sub % 2 === 0 ? LEFT_DOTS : RIGHT_DOTS)[y % DOT_ROWS]!;
    grid[row]![col] = (grid[row]![col] ?? 0) | bit;
  };
  for (let sub = 0; sub < subCols; sub += 1) {
    const y = yOf(sampleAt(sub));
    const previous = sub === 0 ? y : yOf(sampleAt(sub - 1));
    // Join the samples: without this a steep move leaves its two ends on
    // screen and nothing between them, which reads as noise, not a climb.
    for (let step = Math.min(y, previous); step <= Math.max(y, previous); step += 1) {
      mark(stroke, sub, step);
    }
    for (let step = Math.max(y, previous) + 1; step < subRows; step += 1) {
      mark(fill, sub, step);
    }
    const spike = options.spike?.(sub >> 1);
    if (spike !== undefined && spike > 0) {
      const top = Math.max(0, Math.min(subRows - 1, Math.round((1 - Math.min(1, spike)) * (subRows - 1))));
      for (let step = top; step < subRows; step += 1) {
        mark(stroke, sub, step);
      }
    }
  }
  const tone = options.columnTone ?? (() => "accent" as Tone);
  const fillTone = options.fillTone ?? ((col: number, value: number) => dimTone(tone(col, value)));
  const out: string[] = [];
  const tones: Tone[][] = [];
  for (let row = 0; row < h; row += 1) {
    let text = "";
    const rowTones: Tone[] = [];
    for (let col = 0; col < w; col += 1) {
      const bits = (stroke[row]![col] ?? 0) | (fill[row]![col] ?? 0);
      text += String.fromCharCode(0x2800 + bits);
      const value = sampleAt(col * 2);
      rowTones.push((stroke[row]![col] ?? 0) !== 0 ? tone(col, value) : fillTone(col, value));
    }
    out.push(text);
    tones.push(rowTones);
  }
  return { rows: out, tones, lo, hi };
}

/**
 * Axis bounds that hold still.
 *
 * Quantizing to a 1/2/5 step means the axis only moves when the data crosses
 * a step, so one sample leaving the window no longer redraws every column. A
 * span that is negligible next to the magnitude is treated as flat, because
 * a graph that turns a 1ms wobble into a mountain range is reporting noise as
 * if it were news.
 */
function axisBounds(values: readonly number[], baseline: "zero" | "span"): { lo: number; hi: number } {
  if (values.length === 0) {
    return { lo: 0, hi: 1 };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (baseline === "zero") {
    return { lo: 0, hi: Math.max(niceStepUp(max), Number.EPSILON) };
  }
  const span = max - min;
  if (span <= Math.abs(max) * 0.05) {
    // Negligible next to the magnitude: give it a window wide enough that the
    // wobble stays a texture. Fitting the axis to it instead would report a
    // 1ms jitter as a mountain range.
    const range = Math.max(Math.abs(max) * 0.4, span * 6, 1);
    const mid = (min + max) / 2;
    return { lo: mid - range / 2, hi: mid + range / 2 };
  }
  const step = niceStep(span);
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step };
}

function niceStep(span: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(span, Number.EPSILON)));
  const scaled = span / magnitude;
  const step = scaled <= 2 ? 0.5 : scaled <= 5 ? 1 : 2;
  return step * magnitude;
}

function niceStepUp(max: number): number {
  const step = niceStep(Math.max(max, Number.EPSILON));
  return Math.ceil(max / step) * step;
}
const ZONE_RANK: Record<Tone, number> = {
  default: 0,
  user: 0,
  muted: 0,
  ok: 1,
  lane: 2,
  ember: 3,
  bad: 4,
  title: 0,
  box: 0,
  header: 0,
  banner: 0,
  bar: 3,
  barEmpty: 0,
  match: 0,
  focus: 0,
  accent: 0,
  thought: 0,
  spin: 0,
  diffAdd: 0,
  diffDel: 0,
  strong: 0,
  emph: 0,
  link: 0,
  emberDim: 0,
  titleDim: 0,
  laneDim: 0,
  badDim: 0,
  okDim: 0,
  chartInput: 0,
  chartInputDim: 0,
  chartModel: 0,
  chartModelDim: 0,
  chartTool: 2,
  chartToolDim: 0,
  chartBad: 4,
  chartBadDim: 0,
};

function hotter(a: Tone, b: Tone): Tone {
  return ZONE_RANK[a] >= ZONE_RANK[b] ? a : b;
}

function cpuZone(value: number): Tone {
  return value >= 90 ? "bad" : value >= 60 ? "ember" : "ok";
}

function posZone(value: number, min: number, max: number): Tone {
  if (max <= min) {
    return "ok";
  }
  const pos = (value - min) / (max - min);
  return pos >= 0.9 ? "ember" : pos >= 0.66 ? "lane" : "ok";
}

function fmtPct(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Host history as braille line charts: 8 vertical sub-rows per two-cell band,
 * two samples per character. Each cell carries the zone tone of its samples
 * (cpu by absolute percent, rss by window position), so the line shows heat,
 * not just shape.
 */
export function hostChartBands(view: DashProjection, width: number): ChartBand[] {
  const w = Math.max(4, Math.floor(width));
  return [
    brailleBand("cpu", view.hostSeries.map((sample) => sample.cpu_pct), w, fmtPct, (v) => cpuZone(v)),
    brailleBand("rss", view.hostSeries.map((sample) => sample.rss_bytes), w, fmtBytes, (v, min, max) => posZone(v, min, max)),
  ];
}

function brailleBand(
  name: string,
  raw: readonly (number | "missing")[],
  width: number,
  fmt: (value: number) => string,
  zone: (value: number, min: number, max: number) => Tone,
): ChartBand {
  const values = raw.filter((value): value is number => typeof value === "number");
  if (values.length === 0) {
    return { title: `${name}  no samples`, titleTone: "muted", rows: [], tones: [] };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const latest = values.at(-1)!;
  const title = `${name}  now=${fmt(latest)} min=${fmt(min)} max=${fmt(max)} n=${values.length}`;
  const chart = brailleArea(values, width, 2, {
    baseline: "span",
    columnTone: (_col, value) => zone(value, min, max),
  });
  return { title, titleTone: zone(latest, min, max), rows: chart.rows, tones: chart.tones };
}

/** Paint the braille bands onto a pane screen. Returns rows consumed. */
export function drawHostCharts(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  budget: number,
  view: DashProjection,
): number {
  let row = y;
  for (const band of hostChartBands(view, width)) {
    if (budget < 3) {
      break;
    }
    screen.text(x, row, width, ` ${band.title}`, band.titleTone);
    for (let r = 0; r < band.rows.length && r < 2; r += 1) {
      const line = band.rows[r]!;
      for (let c = 0; c < line.length; c += 1) {
        screen.set(x + c, row + 1 + r, line[c]!, band.tones[r]?.[c] ?? "default");
      }
    }
    const used = 1 + Math.min(band.rows.length, 2) + 1;
    row += used;
    budget -= used;
  }
  return row - y;
}

function fmtHostMetric(value: Metric | undefined): string {
  if (typeof value === "number") {
    return `${Math.round(value * 100) / 100}`;
  }
  return "missing";
}

function fmtBytes(value: Metric | undefined): string {
  if (typeof value !== "number") {
    return "missing";
  }
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)}G`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(0)}M`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(0)}K`;
  }
  return `${value}B`;
}

/**
 * Failed tool calls worth waking someone for.
 *
 * Listing every failed call one per line made ALERTS a log of the agent's
 * exploration: a grep that found nothing and a RED case that is SUPPOSED to
 * fail both arrived as warnings, and none of them said why — only a seq
 * number, while `tool/end.diagnosis` sat unused on the log.
 *
 * A planned RED is the workflow working, so it is not an alert. The rest are
 * grouped by tool and diagnosis, because "bash failed 12 times with
 * exit_nonzero" is one fact, not twelve.
 */
function toolFailureAlerts(view: DashProjection, sinceSeq = 0): { text: string; seq: number }[] {
  const groups = new Map<string, { tool: string; why: string; count: number; latest: number }>();
  for (const row of view.tools) {
    if (row.phase !== "end" || !row.error || row.seq < sinceSeq) {
      continue;
    }
    // RED-first: a case that fails on purpose is not a failure of the run.
    if (row.diagnosis === "intended_red") {
      continue;
    }
    const why = row.diagnosis ?? "error";
    const key = `${row.name} ${why}`;
    const seen = groups.get(key);
    if (seen) {
      seen.count += 1;
      seen.latest = Math.max(seen.latest, row.seq);
      continue;
    }
    groups.set(key, { tool: row.name, why, count: 1, latest: row.seq });
  }
  return [...groups.values()]
    .sort((a, b) => b.latest - a.latest)
    .map((group) => ({
      seq: group.latest,
      text: group.count === 1
        ? `tool_error ${group.tool} ${group.why} seq=${group.latest}`
        : `tool_error ${group.tool} ${group.why} ×${group.count} latest_seq=${group.latest}`,
    }));
}

/**
 * Derived alerts. Every line traces back to log events: a hit ratio that
 * crosses below the floor (with the seal that explains it or the lack of one),
 * a compaction that never sealed, failed tool ends, and a dead sampler.
 */
/** One derived alert: what to say, when it happened, how bad, and whether it
 * describes current state (sticky) rather than a windowed incident. */
export interface DerivedAlert {
  text: string;
  seq: number;
  bad: boolean;
  sticky: boolean;
  /** Epoch ms of the event this alert traces to. Incidents age out of the
   * one-line strip after ALERT_STRIP_TTL_MS; sticky state alerts never do. */
  ts?: number;
}

/** A windowed incident leaves the strip this long after it happened; the
 * /alerts pane keeps the full history. Sticky state alerts ignore this. */
export const ALERT_STRIP_TTL_MS = 30_000;

/** The seq of the newest operator message — incident alerts older than the
 * current operator turn are history, not news. */
export function lastOperatorSeq(events: DashProjection["events"]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.name === "user/message") return events[i]!.seq;
  }
  return 0;
}

/** The same answer from the buckets, for callers that hold a projection. */
export function lastOperatorSeqOf(view: DashProjection): number {
  return view.index.last("user/message")?.seq ?? 0;
}

/**
 * Derived alerts, scoped and ordered. Incident builders recount inside
 * [sinceSeq, ...] so ancient failures neither crowd the window nor inflate
 * ×counts; state alerts (sticky) ignore the scope because they describe now.
 * Order is severity first, then newest first — the head of the list is
 * always the worst current fact.
 */
/** The record carrying this seq, or nothing. Binary search: seq only climbs. */
function eventAtSeq(events: readonly EventRecord[], seq: number): EventRecord | undefined {
  let lo = 0;
  let hi = events.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = events[mid]!.seq;
    if (at === seq) return events[mid];
    if (at < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * Derived once per projection, not once per paint.
 *
 * Five callers reach this, and one of them is the one-line alert strip that is
 * on screen at all times -- so every helper below ran ten times a second on a
 * 119,000-event log while the pane's cached copy sat unused beside it.
 * Memoising the pane's body was not enough, because the strip does not go
 * through the pane.
 *
 * A projection is built once and never mutated, the same invariant the widget
 * body cache already stands on.
 */
const DERIVED = new WeakMap<DashProjection, Map<number, DerivedAlert[]>>();

export function derivedAlerts(view: DashProjection, sinceSeq = 0): DerivedAlert[] {
  let perView = DERIVED.get(view);
  if (!perView) {
    perView = new Map();
    DERIVED.set(view, perView);
  }
  let built = perView.get(sinceSeq);
  if (!built) {
    built = buildDerivedAlerts(view, sinceSeq);
    perView.set(sinceSeq, built);
  }
  // A recorded readiness report is rechecked against this machine on every
  // read, never memoised with the projection: the configuration it depends
  // on is not in the log (#230, D5).
  const doctor = doctorReportAlertItems(view);
  if (doctor.length === 0) return built;
  return [...built, ...doctor.map((item) => ({ text: item.text, seq: item.seq, bad: item.bad, sticky: true }))]
    .sort((a, b) => (a.bad === b.bad ? b.seq - a.seq : a.bad ? -1 : 1));
}

function buildDerivedAlerts(view: DashProjection, sinceSeq: number): DerivedAlert[] {
  const out: DerivedAlert[] = [];
  const incident = (text: string, seq: number, bad = false) => out.push({ text, seq, bad, sticky: false });
  const sticky = (text: string, seq: number, bad = false) => out.push({ text, seq, bad, sticky: true });

  const requests = view.requests;
  let prevTs: number | undefined;
  for (let i = 0; i < requests.length; i += 1) {
    const curr = requests[i]!;
    const prev = requests[i - 1];
    if (i > 0 && curr.seq >= sinceSeq) {
      const prevHit = prev!.hit;
      if (typeof prevHit === "number" && typeof curr.hit === "number") {
        // Inside the warmup zone the floor is unreachable by arithmetic
        // (issue #76 cause 1), so a crossing there is expected, not news.
        if (
          prevHit >= HIT_FLOOR && curr.hit < HIT_FLOOR
          && !(typeof curr.occupancy === "number" && curr.occupancy < HIT_WARMUP_CONTEXT_TOKENS)
        ) {
          // Cause order matches analyzeHitRatio: an idle gap first, then a
          // seal. The two paths classifying one row differently (dash said
          // seal, the analyzer said idle_expiry over a 10-hour gap) meant the
          // board and the tool disagreed about the same fact. Explained drops
          // stay VISIBLE with their cause — docs/cache.md: distinguish and
          // exclude from the floor, never hide.
          const cause = curr.rewarm ? "expired" : curr.sealed ? "seal" : "no_seal";
          const gap = curr.rewarm && prevTs !== undefined ? ` gap=${fmtGap(curr.ts - prevTs)}` : "";
          incident(`hit_drop req=${curr.seq} hit=${fmtHit(curr.hit)} cause=${cause}${gap}`, curr.seq);
        }
      }
    }
    prevTs = curr.ts;
  }
  let openCompaction: number | undefined;
  for (const row of view.compaction) {
    if (row.name === "compaction/start") openCompaction = row.seq;
    if (row.name === "compaction/end" || row.name === "prompt/seal") openCompaction = undefined;
  }
  if (openCompaction !== undefined) {
    sticky(`compaction_unsealed start_seq=${openCompaction}`, openCompaction, true);
  }
  for (const item of toolFailureAlerts(view, sinceSeq)) incident(item.text, item.seq);
  for (const item of emptyCompletionAlerts(view, sinceSeq)) incident(item.text, item.seq);
  for (const item of chatTurnFailureAlerts(view, sinceSeq)) incident(item.text, item.seq);
  for (const item of semanticLivelockAlerts(view)) sticky(item.text, item.seq);
  for (const line of resumeWarningAlerts(view)) sticky(line, seqOf(line));
  for (const line of emptyManualHandoffAlerts(view, sinceSeq)) incident(line, seqOf(line));
  for (const line of inputRedactionAlerts(view, sinceSeq)) incident(line, seqOf(line));
  for (const line of sandboxAttestationAlerts(view)) sticky(line, seqOf(line), true);
  for (const line of sandboxOffAlerts(view)) sticky(line, seqOf(line), false);
  for (const line of routeUnreadyAlerts(view)) sticky(line, seqOf(line), true);
  for (const line of remoteFailureAlertLines(view.events)) sticky(line, 0);
  if (!view.host) {
    sticky("host_missing sampler=no_sample", 0);
  }
  for (const alert of noProgressAlerts(view)) sticky(alert.text, alert.seq, alert.bad);
  // Trace each incident to its event's timestamp so the strip can age it out.
  //
  // This built a seq-to-timestamp map of the WHOLE log first -- 118,000
  // entries and 118,000 Date.parse calls on a live session -- to look up the
  // handful of seqs that actually raised an alert. A log's seq climbs, so
  // each lookup is a binary search and only the matched event is parsed.
  for (const item of out) {
    if (item.sticky) continue;
    const found = eventAtSeq(view.events, item.seq);
    if (found) item.ts = Date.parse(found.ts);
  }
  return out.sort((a, b) => (a.bad === b.bad ? b.seq - a.seq : a.bad ? -1 : 1));
}

/**
 * Busy and deciding nothing.
 *
 * A run spent three and a half hours restarting the same decompose attempt
 * 264 times. Every surface said "running": turns arrived, tools ran, the event
 * count climbed, the activity line was honest. Nothing said the attempts were
 * identical and no case had been judged in hours, so the operator watched a
 * healthy-looking board and only learned what was happening when someone read
 * the ledger by hand.
 *
 * Two shapes, both read straight from the log. Attempts repeating is the
 * harness saying so itself. A long stretch of model turns with no verdict and
 * no todo cleared is the general case — whatever the cause, work that decides
 * nothing is work the operator wants to know about.
 */
const NO_PROGRESS_TURNS = 40;
const REPEATED_ATTEMPTS = 3;

function noProgressAlerts(view: DashProjection): { text: string; seq: number; bad: boolean }[] {
  const out: { text: string; seq: number; bad: boolean }[] = [];
  // The eight names this reads, rather than the whole log.
  const events = view.index.ofAny(
    "work/stalled",
    "work/step",
    "session/open",
    "work/case",
    "work/case_preflight",
    "work/clear",
    "work/accept",
    "assistant/message",
  );

  let restarts = 0;
  let restartSeq = 0;
  let lastDecided = 0;
  let turnsSince = 0;
  let lastTurnSeq = 0;
  let stallStreak = 0;
  let stallSeq = 0;
  let stallRed: string[] = [];
  let stallAsking: string[] = [];
  let stallQuestion = "";
  // The verdict each case last carried. A case that was red and is red again
  // for the same reason has decided nothing -- see below.
  const verdictOf = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload as {
      action?: unknown; status?: unknown; id?: unknown; failure_digest?: unknown;
      streak?: unknown; red?: unknown; asking?: unknown; question?: unknown;
    };
    if (event.name === "work/stalled") {
      stallStreak = typeof payload.streak === "number" ? payload.streak : stallStreak + 1;
      stallSeq = event.seq;
      stallRed = Array.isArray(payload.red) ? payload.red.map(String) : [];
      stallAsking = Array.isArray(payload.asking) ? payload.asking.map(String) : [];
      stallQuestion = typeof payload.question === "string" ? payload.question : "";
      continue;
    }
    if (event.name === "work/step" && payload.action === "decompose_restart") {
      restarts += 1;
      restartSeq = event.seq;
    }
    // A restart is a new attempt, and the old attempt's silence is not this
    // one's. Counting across it made a run that had just come back and was
    // working read as badly as the hours that preceded it — and an alert that
    // overstates is an alert that stops being believed, which is the same as
    // not having one.
    if (event.name === "session/open") {
      turnsSince = 0;
      restarts = 0;
      continue;
    }
    // A verdict is a decision only when it CHANGES something. Re-running a
    // case that was already red and getting the same failure back decides
    // nothing, and counting it as progress is what let a run put 1,074
    // identical red verdicts of one case through this branch over two hours
    // while every alert stayed quiet: each one reset the counter.
    if (event.name === "work/case" && (payload.status === "green" || payload.status === "red")) {
      const id = typeof payload.id === "string" ? payload.id : "";
      const mark = `${String(payload.status)}:${String(payload.failure_digest ?? "")}`;
      const repeat = verdictOf.get(id) === mark;
      verdictOf.set(id, mark);
      if (repeat) continue;
    }
    // Deciding something. A preflight verdict counts: running a case on the
    // host and judging it is the expensive, real work of a decompose, and it
    // is the only progress there IS before a graph seals. Ignoring it called
    // two hours of case runs "nothing has been judged".
    if (
      (event.name === "work/case" && (payload.status === "green" || payload.status === "red"))
      || (event.name === "work/case_preflight"
        && (payload.status === "green" || payload.status === "red" || payload.status === "invalid"))
      || event.name === "work/clear"
      || event.name === "work/accept"
    ) {
      lastDecided = event.seq;
      turnsSince = 0;
      restarts = 0;
      continue;
    }
    if (event.name === "assistant/message") {
      turnsSince += 1;
      lastTurnSeq = event.seq;
    }
  }

  if (restarts >= REPEATED_ATTEMPTS) {
    out.push({
      text: `graph_will_not_seal attempts=${restarts} — the same refusal is being retried; `
        + `nothing has sealed since seq=${lastDecided || 0}`,
      seq: restartSeq,
      bad: true,
    });
  }
  if (stallStreak >= 1) {
    // A wall the run can never climb is a different message from one it is
    // still working at: the first needs a person, and saying so is the only
    // thing that moves it.
    if (stallAsking.length > 0) {
      out.push({
        text: `needs_operator ${stallAsking.join(", ")} — the run cannot clear ${
          stallAsking.length === 1 ? "this" : "these"
        } by working; it asks in ${stallQuestion || "work/OPERATOR_QUESTION.md"} and keeps retrying meanwhile`,
        seq: stallSeq,
        bad: true,
      });
    } else {
      const behind = stallRed.length > 0 ? ` — waiting on ${stallRed.join(", ")}` : "";
      out.push({
        text: `wall_hit streak=${stallStreak} — ${stallStreak} wave${stallStreak === 1 ? "" : "s"} in a row `
          + `changed nothing; the run is backing off and will keep retrying${behind}`,
        seq: stallSeq,
        bad: true,
      });
    }
  }
  if (turnsSince >= NO_PROGRESS_TURNS) {
    out.push({
      text: `no_progress turns=${turnsSince} — the model is working but nothing has been `
        + `judged or cleared since seq=${lastDecided || 0}`,
      seq: lastTurnSeq,
      bad: true,
    });
  }
  return out;
}

function semanticLivelockAlerts(view: DashProjection): { text: string; seq: number }[] {
  const featureStart = projectSessionReplaySchemas(view.events).featureStart.get("semantic-livelock-v1");
  if (featureStart === undefined) return [];
  return [...semanticLivelockValidation(view.events, featureStart).active.values()]
    .map(({ detection, eventSeq }) => ({
      text: `semantic_livelock todo=${detection.todo} case=${detection.caseId} attempts=${detection.attempts}`,
      seq: eventSeq,
    }));
}

/** `... seq=41874` / `... latest_seq=41874` → 41874; unmarked lines sort last. */
function seqOf(line: string): number {
  const match = /(?:latest_)?seq=(\d+)/.exec(line);
  return match ? Number(match[1]) : 0;
}

/** Full-history string facade over derivedAlerts. */
export function alertLines(view: DashProjection): string[] {
  return derivedAlerts(view, 0).map((item) => item.text);
}

/** The one-line strip for the default live board: the worst current alert
 * plus a count, or nothing at all when the current operator turn is clean.
 * host_missing stays pane-only — it is a startup/fixture constant, not news. */
export function alertStrip(
  view: DashProjection,
  now: number = Date.now(),
): { text: string; bad: boolean } | undefined {
  const items = derivedAlerts(view, lastOperatorSeqOf(view))
    .filter((item) => !item.text.startsWith("host_missing"))
    // Incidents leave the strip after their TTL; sticky state alerts and any
    // whose event ts we could not resolve stay until the state clears.
    .filter((item) => item.sticky || item.ts === undefined || now - item.ts <= ALERT_STRIP_TTL_MS);
  const top = items[0];
  if (!top) return undefined;
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : "";
  return { text: `▲ ${top.text}${more} — /alerts`, bad: top.bad };
}

/** The fence is off for this session: said once, and kept on the strip. */
/**
 * A recorded capability readiness report (#230), read through the same
 * report reader the CLI renders from, and never shown without a recheck
 * (D5): the report's profile, configuration digest and generation are
 * compared with what this machine has now, or it is stale. The observation is
 * held for DOCTOR_RECHECK_TTL_MS so a painting board does not reread the
 * configuration ten times a second.
 */
const DOCTOR_RECHECK_TTL_MS = 2_000;
const DOCTOR_REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const doctorVerdicts = new Map<string, { at: number; value: { readonly current: boolean; readonly reasons: readonly StaleReason[] } }>();

/** The CLI's own freshness decision (doctor-freshness.ts), with the key read
 * but never made here. */
function doctorFreshness(report: DoctorReport): { readonly current: boolean; readonly reasons: readonly StaleReason[] } {
  // Keyed by the whole report: a copy with the same MAC and other bytes is
  // another report, and is judged afresh.
  const cacheKey = digestOf(report);
  const now = Date.now();
  const held = doctorVerdicts.get(cacheKey);
  if (held && now - held.at < DOCTOR_RECHECK_TTL_MS) return held.value;
  const cwd = process.cwd();
  const value = freshnessNow(report, {
    repoRoot: DOCTOR_REPO_ROOT,
    cwd,
    env: process.env,
    config: () => readConfig(),
    key: installationKey({ create: false, workspace: cwd }),
  });
  doctorVerdicts.set(cacheKey, { at: now, value });
  return value;
}

function doctorReportAlertItems(view: DashProjection): { text: string; bad: boolean; seq: number }[] {
  if (!view.index.last(DOCTOR_REPORT_EVENT)) return [];
  return doctorAlertsFromEvents(view.index.ofAny(DOCTOR_REPORT_EVENT), doctorFreshness);
}

function sandboxOffAlerts(view: DashProjection): string[] {
  return view.events
    .filter((event) => event.name === "sandbox/policy" && event.payload.backend === "none")
    .slice(-1)
    .map((event) => `sandbox_off backend=none — kernel fence disabled by the operator seq=${event.seq}`);
}

function sandboxAttestationAlerts(view: DashProjection): string[] {
  return view.events
    .filter((event) => event.name === "sandbox/probe_result" && event.payload.status === "failed")
    .slice(-1)
    .map((event) => {
      const reason = typeof event.payload.reason === "string" ? event.payload.reason : "unknown";
      return `sandbox_attestation_failed reason=${reason} seq=${event.seq}`;
    });
}

function emptyManualHandoffAlerts(view: DashProjection, sinceSeq = 0): string[] {
  return view.events
    .filter((event) =>
      event.name === "model/handoff"
      && event.payload.cause === "manual"
      && event.payload.warning === "empty_source_transcript"
      && event.seq >= sinceSeq
    )
    .slice(-4)
    .map((event) => `manual_handoff_empty prior context was unavailable seq=${event.seq}`);
}

function resumeWarningAlerts(view: DashProjection): string[] {
  const event = [...view.events].reverse().find((candidate) => candidate.name === "session/resume");
  if (!event || event.payload.restored !== false || event.payload.action !== "fresh_start") return [];
  const reason = typeof event.payload.reason === "string" ? event.payload.reason : "unknown";
  const stored = typeof event.payload.stored_messages === "number" ? event.payload.stored_messages : 0;
  const mismatches = Array.isArray(event.payload.mismatches)
    ? event.payload.mismatches.filter((value): value is string => typeof value === "string").join(",")
    : "unknown";
  return [`resume_warning stored=${stored} reason=${reason} mismatches=${mismatches}; continuing fresh — /resume --reseed seq=${event.seq}`];
}

function emptyCompletionAlerts(view: DashProjection, sinceSeq = 0): { text: string; seq: number }[] {
  const groups = new Map<string, { count: number; latest: number }>();
  for (const event of view.events) {
    if (event.name !== "model/failure" || event.payload.class !== "empty_completion" || event.seq < sinceSeq) continue;
    const route = safeAlertSelectionPart(event.payload.route);
    const model = safeAlertSelectionPart(event.payload.model);
    const key = `${route}/${model}`;
    const seen = groups.get(key);
    if (seen) {
      seen.count += 1;
      seen.latest = Math.max(seen.latest, event.seq);
    } else {
      groups.set(key, { count: 1, latest: event.seq });
    }
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].latest - left[1].latest)
    .map(([selection, group]) => {
      const count = group.count > 1 ? ` ×${group.count}` : "";
      return {
        seq: group.latest,
        text: `empty_completion ${selection} returned no content${count}; retry, switch model, or allow failover seq=${group.latest}`,
      };
    });
}

function safeAlertSelectionPart(value: unknown): string {
  if (typeof value !== "string") return "missing";
  const safe = redactText(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 256);
  return !safe ? "missing" : containsPrivateInfrastructure(safe) ? "redacted" : safe;
}

function inputRedactionAlerts(view: DashProjection, sinceSeq = 0): string[] {
  return view.events
    .filter((event) => event.name === "security/input_redacted" && event.seq >= sinceSeq)
    .slice(-8)
    .map((event) => {
      const surface = typeof event.payload.surface === "string" ? event.payload.surface : "unknown";
      const chars = typeof event.payload.chars === "number" ? event.payload.chars : "missing";
      return `credential_redacted surface=${surface} chars=${chars} seq=${event.seq}`;
    });
}

/**
 * Interactive turn failures (#37 T2). The alt-screen hides stderr, so the
 * kernel side of the Frontend Seam appends `chat/turn_failed` and the board
 * carries the failure. Same grouping grammar as tool errors: reason text is
 * short, the count is honest, and the seq traces the line to its event.
 */
function chatTurnFailureAlerts(view: DashProjection, sinceSeq = 0): { text: string; seq: number }[] {
  const groups = new Map<string, { count: number; latest: number }>();
  for (const event of view.events) {
    if (event.name !== "chat/turn_failed" || event.kind !== "observe" || event.seq < sinceSeq) {
      continue;
    }
    const raw = typeof event.payload?.reason === "string" ? event.payload.reason : "unknown";
    // A pane line is one grid line: a provider's raw JSON reply carries
    // newlines and tabs that would tear the board's row geometry apart.
    // Flatten at the projection so already-written events render safely.
    const reason = raw.replace(/\s+/g, " ").trim();
    const seen = groups.get(reason);
    if (seen) {
      seen.count += 1;
      seen.latest = Math.max(seen.latest, event.seq);
      continue;
    }
    groups.set(reason, { count: 1, latest: event.seq });
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].latest - a[1].latest)
    .map(([reason, group]) => ({
      seq: group.latest,
      text: group.count === 1
        ? `turn_failed ${reason} seq=${group.latest}`
        : `turn_failed ${reason} ×${group.count} latest_seq=${group.latest}`,
    }));
}

/**
 * The selected route cannot answer, and nothing has answered since.
 *
 * Two records say so: `model/route_unready`, written at chat boot from the
 * same fact `dokkabi login` prints, and `agent/status` failing with
 * `auth_unavailable`, written when a request tried anyway. Either one is a
 * standing condition, not an incident — it does not age off the strip, and
 * it carries the command that ends it. A later successful model request on
 * any route clears it: the operator either logged in or moved routes.
 */
function routeUnreadyAlerts(view: DashProjection): string[] {
  let latest: { text: string; seq: number } | undefined;
  for (const event of view.events) {
    if (event.name === "model/usage") {
      latest = undefined;
      continue;
    }
    if (event.name === "model/route_unready") {
      const route = typeof event.payload.route === "string" ? event.payload.route : "?";
      const reason = typeof event.payload.reason === "string" ? event.payload.reason : "credential missing";
      const hint = typeof event.payload.hint === "string" ? event.payload.hint : `dokkabi login ${route}`;
      latest = { text: `route_unready route=${route} reason=${reason} — ${hint} seq=${event.seq}`, seq: event.seq };
      continue;
    }
    if (event.name === "agent/status" && event.payload.status === "failed" && event.payload.failure_class === "auth_unavailable") {
      const route = typeof event.payload.route === "string" ? event.payload.route : "?";
      latest = { text: `route_unready route=${route} reason=authentication_failed — dokkabi login ${route} seq=${event.seq}`, seq: event.seq };
    }
  }
  return latest ? [latest.text] : [];
}
