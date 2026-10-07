import { listSessionIndex } from "./session-scan.ts";

/**
 * The model ledger: cross-session model economics on the operator board.
 *
 * OpenRouter's own analytics can say what a fortnight of runs cost, and the
 * dokkabi board could not — the economics of a model were more visible on the
 * provider's dashboard than on ours (invariant 6). Every number here folds
 * from recorded `observe.model_usage` rows only: no new events, no live
 * provider calls, so replay and the ledger can never disagree.
 *
 * Missing stays missing: a provider that never reports cache tokens shows
 * `cache_r=missing`, never a lying 0% or an invented average.
 */

export interface ModelLedgerRow {
  route: string;
  model: string;
  requests: number;
  okRequests: number;
  sessions: number;
  inputTokens: number | "missing";
  outputTokens: number | "missing";
  reasoningTokens: number | "missing";
  cacheReadTokens: number | "missing";
  cacheWriteTokens: number | "missing";
  /** Average of the provider-reported hit_ratio over the samples that had one. */
  hitRatio: number | "missing";
  failures: Readonly<Record<string, number>>;
  lastTs: number;
}

export interface ModelDayBucket {
  /** UTC YYYY-MM-DD. */
  day: string;
  requests: number;
  input: number;
  output: number;
}

export interface ModelLedgerTotals {
  requests: number;
  ok: number;
  failed: number;
  sessions: number;
  inputTokens: number | "missing";
  outputTokens: number | "missing";
}

export interface ModelLedger {
  rows: ModelLedgerRow[];
  days: ModelDayBucket[];
  totals: ModelLedgerTotals;
  latest: { session: string; route: string; model: string; ts: number; status?: string } | undefined;
}

interface FoldedRow {
  row: ModelLedgerRow;
  sessions: Set<string>;
  hitRatioSum: number;
  hitRatioSeen: number;
}

export function listModelLedger(sessionsRoot: string): ModelLedger {
  const index = listSessionIndex(sessionsRoot);
  const folded = new Map<string, FoldedRow>();
  const days = new Map<string, ModelDayBucket>();
  let totalsSessions = new Set<string>();
  let latest: ModelLedger["latest"];
  for (const rollup of index.rollups) {
    const key = `${rollup.route}/${rollup.model}`;
    let current = folded.get(key);
    if (!current) {
      current = {
        row: {
          route: rollup.route,
          model: rollup.model,
          requests: 0,
          okRequests: 0,
          sessions: 0,
          inputTokens: "missing",
          outputTokens: "missing",
          reasoningTokens: "missing",
          cacheReadTokens: "missing",
          cacheWriteTokens: "missing",
          hitRatio: "missing",
          failures: {},
          lastTs: rollup.lastTs,
        },
        sessions: new Set<string>(),
        hitRatioSum: 0,
        hitRatioSeen: 0,
      };
      folded.set(key, current);
    }
    const row = current.row;
    row.inputTokens = mergeSum(row.inputTokens, rollup.inputSeen, rollup.inputSum);
    row.outputTokens = mergeSum(row.outputTokens, rollup.outputSeen, rollup.outputSum);
    row.reasoningTokens = mergeSum(row.reasoningTokens, rollup.reasoningSeen, rollup.reasoningSum);
    row.cacheReadTokens = mergeSum(row.cacheReadTokens, rollup.cacheReadSeen, rollup.cacheReadSum);
    row.cacheWriteTokens = mergeSum(row.cacheWriteTokens, rollup.cacheWriteSeen, rollup.cacheWriteSum);
    current.hitRatioSum += rollup.hitRatioSum;
    current.hitRatioSeen += rollup.hitRatioSeen;
    row.lastTs = Math.max(row.lastTs, rollup.lastTs);
    row.requests += rollup.requests;
    row.okRequests += rollup.okRequests;
    for (const [status, count] of Object.entries(rollup.failures)) {
      const target = row.failures as Record<string, number>;
      target[status] = (target[status] ?? 0) + count;
    }
    current.sessions.add(rollup.session);
    if (!latest || rollup.lastTs > latest.ts) {
      latest = {
        session: rollup.session,
        route: rollup.route,
        model: rollup.model,
        ts: rollup.lastTs,
        ...(rollup.lastStatus ? { status: rollup.lastStatus } : {}),
      };
    }
    for (const [day, bucket] of Object.entries(rollup.days)) {
      const target = days.get(day) ?? (days.set(day, { day, requests: 0, input: 0, output: 0 }), days.get(day)!);
      target.requests += bucket.requests;
      target.input += bucket.input;
      target.output += bucket.output;
    }
  }
  for (const current of folded.values()) {
    current.row.sessions = current.sessions.size;
    if (current.hitRatioSeen > 0) current.row.hitRatio = current.hitRatioSum / current.hitRatioSeen;
    totalsSessions = union(totalsSessions, current.sessions);
  }
  const rows = [...folded.values()].map((entry) => entry.row).sort(compareRows);
  const inputSeen = rows.some((row) => row.inputTokens !== "missing");
  const outputSeen = rows.some((row) => row.outputTokens !== "missing");
  return {
    rows,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    totals: {
      requests: rows.reduce((sum, row) => sum + row.requests, 0),
      ok: rows.reduce((sum, row) => sum + row.okRequests, 0),
      failed: rows.reduce((sum, row) => sum + Object.values(row.failures).reduce((n, c) => n + c, 0), 0),
      sessions: totalsSessions.size,
      inputTokens: inputSeen ? rows.reduce((sum, row) => sum + (row.inputTokens === "missing" ? 0 : row.inputTokens), 0) : "missing",
      outputTokens: outputSeen ? rows.reduce((sum, row) => sum + (row.outputTokens === "missing" ? 0 : row.outputTokens), 0) : "missing",
    },
    latest,
  };
}

/** Merge one session's sum into a row that may already carry numbers, or may
 * still be missing because no session has reported the field yet. */
function mergeSum(existing: number | "missing", seen: boolean, sum: number): number | "missing" {
  if (!seen) return existing;
  return existing === "missing" ? sum : existing + sum;
}

function union(into: Set<string>, from: Set<string>): Set<string> {
  for (const id of from) into.add(id);
  return into;
}

function compareRows(a: ModelLedgerRow, b: ModelLedgerRow): number {
  if (a.requests !== b.requests) return b.requests - a.requests;
  const tokens = (row: ModelLedgerRow): number =>
    (row.inputTokens === "missing" ? 0 : row.inputTokens) + (row.outputTokens === "missing" ? 0 : row.outputTokens);
  const diff = tokens(b) - tokens(a);
  if (diff !== 0) return diff;
  return `${a.route}/${a.model}`.localeCompare(`${b.route}/${b.model}`);
}

const DAY_WINDOW = 14;

/** Lines for the models pane. `now` is injected so a frame is reproducible. */
export function modelsPaneLines(ledger: ModelLedger, width: number, now: number): string[] {
  const totals = ledger.totals;
  const lines: string[] = [
    `models=${ledger.rows.length} sessions=${totals.sessions} requests=${totals.requests} ok=${totals.ok} fail=${totals.failed} in=${fmtK(totals.inputTokens)} out=${fmtK(totals.outputTokens)}`,
  ];
  if (ledger.rows.length === 0) {
    lines.push("(no model usage found)");
    return lines;
  }
  for (const row of ledger.rows) {
    const failures = Object.entries(row.failures).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const fail = failures.length === 0
      ? "fail=0"
      : `fail=${failures.reduce((sum, [, count]) => sum + count, 0)}(${failures.slice(0, 2).map(([status, count]) => (count > 1 ? `${count}x ${status}` : status)).join(", ")})`;
    const hits = row.hitRatio === "missing" ? "" : ` hits=${fmtPercent(row.hitRatio)}`;
    const cacheRead = row.cacheReadTokens === "missing" ? "" : ` cache_r=${fmtK(row.cacheReadTokens)}`;
    lines.push(
      `${row.route}/${row.model} req=${row.requests} sess=${row.sessions} ok=${row.okRequests} ${fail} in=${fmtK(row.inputTokens)} out=${fmtK(row.outputTokens)}${cacheRead}${hits} last=${fmtAge(now - row.lastTs)}`,
    );
  }
  if (ledger.latest) {
    const latest = ledger.latest;
    lines.push(
      `latest sess=${latest.session} ${latest.route}/${latest.model}${latest.status ? ` status=${latest.status}` : ""} age=${fmtAge(now - latest.ts)}`,
    );
  }
  const windowDays = dayWindow(now);
  const inWindow = ledger.days.filter((bucket) => windowDays.has(bucket.day));
  if (inWindow.length > 0) {
    const maxRequests = Math.max(...inWindow.map((bucket) => bucket.requests));
    for (const bucket of inWindow) {
      const blocks = "█".repeat(Math.max(1, Math.round((bucket.requests / maxRequests) * 8)));
      lines.push(`d ${bucket.day} ${blocks.padEnd(8)} r=${bucket.requests} t=${fmtK(bucket.input + bucket.output)}`);
    }
  }
  return lines.map((line) => line.slice(0, width));
}

function dayWindow(now: number): Set<string> {
  const days = new Set<string>();
  const utc = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  for (let i = 0; i < DAY_WINDOW; i += 1) {
    days.add(new Date(utc - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function fmtK(value: number | "missing"): string {
  if (value === "missing") return "missing";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${value}`;
}

function fmtPercent(ratio: number): string {
  const percent = Math.floor(ratio * 1_000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function fmtAge(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
