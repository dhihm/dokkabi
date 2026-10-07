import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";

/**
 * Standard evaluation-result export (#107).
 *
 * Every campaign surface (single SWE instance, monkeymode, sweep, 돗가비
 * 장터 search) already records its outcome in the EventLog; the ad-hoc
 * `.dokkabi-swe/result.json` shapes were the only way OUT. This module is
 * the one stable envelope: a pure, re-derivable projection of recorded
 * events — the same session log exports the same bytes every time, no
 * clocks, no live reads beyond the log itself (the #76 hit-analysis rule).
 *
 * `format` gates consumers: bump it only with a migration note in
 * docs/swe-eval-design.md.
 */
export const EVAL_EXPORT_FORMAT = 1;

/** One exported row. `kind` names the recorded event family; the remaining
 * fields are copied verbatim from the recorded payload (already redacted at
 * append time). `session`/`seq`/`ts` locate the row in its log — they are
 * envelope fields and always win: a payload key that collides with one
 * (monkey/sample records its own `session`, the derived sample id) is
 * exported under a `payload_` prefix instead of clobbering the envelope. */
export interface EvalExportRow {
  format: typeof EVAL_EXPORT_FORMAT;
  kind:
    | "swe_baseline"
    | "swe_result"
    | "monkey_start"
    | "monkey_sample"
    | "monkey_select"
    | "search_trial"
    | "search_holdout"
    | "search_select";
  session: string;
  seq: number;
  ts: string;
  [field: string]: unknown;
}

const EXPORTED_EVENTS: Readonly<Record<string, EvalExportRow["kind"]>> = {
  "swe/baseline": "swe_baseline",
  "swe/result": "swe_result",
  "monkey/start": "monkey_start",
  "monkey/sample": "monkey_sample",
  "monkey/select": "monkey_select",
  "search/trial": "search_trial",
  "search/holdout": "search_holdout",
  "search/select": "search_select",
};

const ENVELOPE_KEYS = new Set(["format", "kind", "session", "seq", "ts"]);

/** Project one session's recorded evaluation events into export rows, in
 * log order. Pure: same events, same rows. */
export function exportEvalRows(sessionId: string, events: readonly EventRecord[]): EvalExportRow[] {
  const rows: EvalExportRow[] = [];
  for (const event of events) {
    const kind = EXPORTED_EVENTS[event.name];
    if (!kind) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.payload)) {
      fields[ENVELOPE_KEYS.has(key) ? `payload_${key}` : key] = value;
    }
    rows.push({
      format: EVAL_EXPORT_FORMAT,
      kind,
      session: sessionId,
      seq: event.seq,
      ts: event.ts,
      ...fields,
    });
  }
  return rows;
}

/** Export every session under a Dokkabi home, sessions in lexicographic
 * order so the whole-home export is deterministic too. Sessions whose log
 * cannot be read are skipped — an exporter must never invent rows. */
export function exportEvalHome(homeDir: string): EvalExportRow[] {
  const sessionsDir = join(homeDir, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const rows: EvalExportRow[] = [];
  for (const session of readdirSync(sessionsDir).sort()) {
    const logPath = join(sessionsDir, session, "events.jsonl");
    if (!existsSync(logPath)) continue;
    try {
      const log = new EventLog(logPath, { readOnly: true });
      rows.push(...exportEvalRows(session, log.events));
    } catch {
      continue;
    }
  }
  return rows;
}

/** JSONL: one canonical-JSON row per line. Byte-identical across exports of
 * the same log (canonicalJson sorts keys; ts/seq come from the log). */
export function renderEvalJsonl(rows: readonly Record<string, unknown>[]): string {
  return rows.map((row) => canonicalJson(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

/** Fixed CSV column set — the union of the load-bearing per-kind fields.
 * Unknown/absent cells render empty; nested values render as canonical
 * JSON so a spreadsheet never sees `[object Object]`. */
export const EVAL_CSV_COLUMNS = [
  "format", "kind", "session", "seq", "ts", "payload_session",
  "instance", "resolved", "blame", "work_exit", "prepared", "planned", "completed",
  "tests", "passed", "exit_code",
  "k", "k_used", "i", "winner", "coverage", "stop", "quota_exhausted", "temperature",
  "recipe_id", "recipe_digest", "status", "instances", "lambda", "budget_calls",
  "eligible", "trials", "error",
] as const;

export function renderEvalCsv(rows: readonly EvalExportRow[]): string {
  const lines = [EVAL_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(EVAL_CSV_COLUMNS.map((column) => csvCell((row as Record<string, unknown>)[column])).join(","));
  }
  return lines.join("\n") + "\n";
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? canonicalJson(value) : String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Sweep scorecard rows. Same `format` (the ENVELOPE version — it names the
 * export contract, and `kind` names each row's shape), but sweep rows are
 * the sweep script's own outcome record, not an EventLog projection: they
 * carry no session/ts because the sweep is not a log. Per-instance detail
 * lives in the preserved sessions and exports through exportEvalHome. */
export interface SweepExportInput {
  results: readonly { id: string; resolved: boolean; runs: number }[];
  stop: "done" | "unresolved" | "quota";
}

export interface SweepExportRow {
  format: typeof EVAL_EXPORT_FORMAT;
  kind: "sweep_row" | "sweep_summary";
  seq: number;
  [field: string]: unknown;
}

export function sweepExportRows(outcome: SweepExportInput): SweepExportRow[] {
  return [
    ...outcome.results.map((row, index): SweepExportRow => ({
      format: EVAL_EXPORT_FORMAT,
      kind: "sweep_row",
      seq: index,
      instance: row.id,
      resolved: row.resolved,
      runs: row.runs,
    })),
    {
      format: EVAL_EXPORT_FORMAT,
      kind: "sweep_summary",
      seq: outcome.results.length,
      resolved: outcome.results.filter((row) => row.resolved).length,
      total: outcome.results.length,
      stop: outcome.stop,
    },
  ];
}

/** One renderer, one contract — the sweep name survives for its call site. */
export const renderSweepJsonl = renderEvalJsonl;
