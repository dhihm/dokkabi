import { fmtHitSeries, hitTrack, HIT_FLOOR, HIT_WARMUP_TURNS } from "../host/hit-ratio.ts";
import { lspDiagnosticsLine } from "../host/lsp/stats.ts";
import { lspNavigationLine } from "../host/lsp/navigation-stats.ts";
import { readBatchLine } from "../host/read-batch.ts";
import { earlyReadLine } from "../host/received-calls.ts";
import { formatPlanShow } from "../work/show.ts";
import { renderTodoDag } from "./dag.ts";
import { eventLines, fmtHitRatio, operatorEvents, resultSourceLine, swarmMemorySummary, toolLines } from "./cells.ts";
import { fmtMetric, type DashProjection } from "./project.ts";
import { themeByName, type DokkabiTheme } from "./theme.ts";
import { speculationDisplay } from "./speculation.ts";

export function renderDashHtml(
  view: DashProjection,
  meta: { path: string; replay: boolean; theme?: string },
): string {
  const theme = themeByName(meta.theme);
  const status = view.agent === "missing" ? "idle" : view.agent;
  const usage = view.usage;
  const work = view.work;
  const host = view.host;
  const ctxUsed = usage?.context_used;
  const ctxMax = usage?.context_window;
  const pct =
    typeof ctxUsed === "number" && typeof ctxMax === "number" && ctxMax > 0
      ? Math.min(100, Math.round((ctxUsed / ctxMax) * 100))
      : undefined;
  const speculation = speculationDisplay(view.speculation);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta http-equiv="refresh" content="1"/>
  <title>Dokkabi · ${esc(view.session)}</title>
  <style>
    :root {
      ${webVars(theme)}
      --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 var(--sans); }
    a { color: var(--ember); }
    header {
      display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: baseline;
      padding: 16px 20px 14px; border-bottom: 1px solid var(--line);
    }
    .brand { font-family: var(--mono); letter-spacing: 0.14em; font-size: 12px; color: var(--ember); }
    .pill {
      font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
      padding: 3px 8px; border: 1px solid var(--line);
    }
    .pill.failed, .pill.error { color: var(--bad); border-color: var(--bad); }
    .pill.running, .pill.waiting_tool, .pill.compacting { color: var(--ember); border-color: var(--ember); }
    .pill.idle, .pill.ready, .pill.clear { color: var(--ok); border-color: #314233; }
    .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .banner {
      margin: 0; padding: 10px 20px; background: #2a1210; color: #ffb4ab;
      font-family: var(--mono); font-size: 12px; border-bottom: 1px solid #5a241e;
    }
    main { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 1px; background: var(--line); min-height: calc(100vh - 88px); }
    @media (max-width: 880px) { main { grid-template-columns: 1fr; } }
    section { background: var(--bg); padding: 18px 20px 22px; }
    h2 {
      margin: 0 0 12px; font-family: var(--mono); font-size: 11px; font-weight: 500;
      letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted);
    }
    .goal { font-size: 18px; line-height: 1.3; margin: 0 0 14px; }
    .lanes { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .lane { background: var(--bg-2); padding: 10px; min-height: 64px; }
    .lane .k { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; color: var(--muted); }
    .lane .v { margin-top: 6px; font-family: var(--mono); font-size: 12px; word-break: break-all; }
    .todos { list-style: none; margin: 0; padding: 0; }
    .todos li {
      display: grid; grid-template-columns: 72px 1fr; gap: 10px; align-items: baseline;
      padding: 8px 0; border-top: 1px solid var(--line);
    }
    .todos .st { font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; }
    .graph { margin: 12px 0 0; padding: 12px; background: var(--bg-2); color: var(--ink); font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow: auto; max-height: 48vh; }
    .st.doing, .st.running { color: var(--ember); }
    .st.clear, .st.green { color: var(--ok); }
    .st.blocked, .st.red, .st.failed { color: var(--bad); }
    .st.ready, .st.missing { color: var(--idle); }
    .title { font-size: 13px; }
    .sub { color: var(--muted); font-family: var(--mono); font-size: 11px; margin-top: 2px; }
    .kv { display: grid; grid-template-columns: 92px 1fr; gap: 6px 10px; font-family: var(--mono); font-size: 12px; }
    .kv span { color: var(--muted); }
    .meter { height: 8px; background: #1b2129; margin: 10px 0 14px; }
    .meter > i { display: block; height: 100%; background: var(--ember); }
    .meter.missing > i { width: 0; }
    table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
    td { padding: 5px 0; border-top: 1px solid var(--line); color: var(--ink); }
    td:first-child { color: var(--muted); width: 42px; }
    .split { display: grid; gap: 22px; }
    .note { margin-top: 18px; color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">DOKKABI</div>
    <div class="pill ${esc(status)}">${esc(status)}</div>
    <div class="pill">${meta.replay ? "replay" : "live"}</div>
    <div class="meta">session ${esc(view.session)}</div>
    <div class="meta">${esc(meta.path)}</div>
  </header>
  ${view.error ? `<p class="banner">halted · ${esc(view.error)}</p>` : ""}
  <main>
    <section>
      <h2>Work / Graph</h2>
      <p class="goal">${esc(work.goal === "missing" ? "No goal sealed in this session." : work.goal)}</p>
      ${work.heung === "missing" ? "" : `<p class="sub">HEUNG=${esc(work.heung)} wave=${esc(String(work.heungWave))}</p>`}
      <div class="lanes">
        <div class="lane"><div class="k">next</div><div class="v">${esc(work.intending)}</div></div>
        <div class="lane"><div class="k">now</div><div class="v">${esc(work.doing)}</div></div>
        <div class="lane"><div class="k">done</div><div class="v">${esc(work.done.join(", ") || "(none)")}</div></div>
      </div>
      <pre class="graph">${esc(graphText(view))}</pre>
      <p class="sub" style="margin-top:14px">last user · ${esc(work.lastUser)}</p>
      <p class="sub">last assistant · ${esc(work.lastAssistant)}</p>
    </section>
    <section class="split">
      <div>
        <h2>Model</h2>
        <div class="kv">
          <span>provider</span><div>${esc(usage?.provider ?? "missing")}</div>
          <span>model</span><div>${esc(usage?.model ?? "missing")}</div>
          <span>route</span><div>${esc(usage?.route ?? "missing")}</div>
          <span>in / out</span><div>${esc(fmtMetric(usage?.input_tokens))} / ${esc(fmtMetric(usage?.output_tokens))}</div>
          <span>cache r/w</span><div>${esc(fmtMetric(usage?.cache_read_tokens))} / ${esc(fmtMetric(usage?.cache_write_tokens))}</div>
          <span>hit</span><div>${esc(fmtHitRatio(usage))}</div>
          <span>hits</span><div>${esc(fmtHitSeries(hitTrack(view.sessionStats.hits, HIT_WARMUP_TURNS, HIT_FLOOR, view.sessionStats.hitSkip)))}</div>
          <span>compaction</span><div>${esc(view.compactionActive)} · n=${view.sessionStats.compaction_n} · at ${esc(fmtMetric(view.sessionStats.compact_at))}</div>
          <span>blob gc</span><div>${esc(blobGcHtml(view))}</div>
          ${view.resultSources ? `<span>result sources</span><div>${esc(resultSourceLine(view))}</div>` : ""}
          ${view.lspDiagnostics ? `<span>lsp diagnostics</span><div>${esc(lspDiagnosticsLine(view.lspDiagnostics))}</div>` : ""}
          ${view.lspNavigation ? `<span>lsp navigation</span><div>${esc(lspNavigationLine(view.lspNavigation))}</div>` : ""}
          ${view.readBatches ? `<span>read batches</span><div>${esc(readBatchLine(view.readBatches))}</div>` : ""}
          ${view.earlyReads ? `<span>early reads</span><div>${esc(earlyReadLine(view.earlyReads))}</div>` : ""}
          ${view.work.executionViews ? `<span>execution views</span><div>${esc(view.work.executionViews)}</div>` : ""}
          ${view.work.checkerRevisions ? `<span>checker revisions</span><div>${esc(view.work.checkerRevisions)}</div>` : ""}
          ${view.work.reviewDecision ? `<span>review decision</span><div>${esc(view.work.reviewDecision)}</div>` : ""}
          ${view.work.initialRegression ? `<span>initial regression</span><div>${esc(view.work.initialRegression)}</div>` : ""}
          <span>maek</span><div>${esc(maekHtml(view))}</div>
          <span>turn</span><div>${view.sessionStats.turns}</div>
          <span>in/out sum</span><div>${esc(fmtMetric(view.sessionStats.in_sum))} / ${esc(fmtMetric(view.sessionStats.out_sum))}</div>
          <span>cache r/w sum</span><div>${esc(fmtMetric(view.sessionStats.cache_r_sum))} / ${esc(fmtMetric(view.sessionStats.cache_w_sum))}</div>
          <span>week</span><div>${esc(fmtMetric(view.sessionStats.week_used))} / ${esc(fmtMetric(view.sessionStats.week_limit))}</div>
        </div>
        <div class="meter ${pct === undefined ? "missing" : ""}"><i style="width:${pct ?? 0}%"></i></div>
        <div class="sub">context ${esc(fmtMetric(ctxUsed))} / ${esc(fmtMetric(ctxMax))}${pct === undefined ? " · missing%" : ` · ${pct}%`}</div>
      </div>
      <div>
        <h2>Host</h2>
        ${
          host
            ? `<div class="kv">
          <span>cpu</span><div>${esc(fmtMetric(host.cpu_pct))}%</div>
          <span>rss</span><div>${esc(fmtBytes(host.rss_bytes))}</div>
          <span>workspace</span><div>${esc(fmtBytes(host.workspace_bytes))}</div>
          <span>log</span><div>${esc(fmtBytes(host.log_bytes))}</div>
          <span>pids</span><div>${esc(host.pids.map((row) => `${row.pid}:${row.cmd}`).join(", ") || "missing")}</div>
        </div>`
            : `<div class="sub">cpu=missing mem=missing workspace=missing log=missing</div>`
        }
      </div>
      ${speculation ? `<div>
        <h2>Speculation</h2>
        <div class="kv">${speculation.rows.map((row) => `<span>${esc(row.label)}</span><div>${esc(row.value)}</div>`).join("")}</div>
      </div>` : ""}
      <div>
        <h2>Tools</h2>
        ${
          view.tools.length === 0
            ? `<div class="sub">(none)</div>`
            : `<table>${toolLines(view, 5)
                .map((line) => `<tr><td></td><td>${esc(line)}</td></tr>`)
                .join("")}</table>`
        }
      </div>
      <div>
        <h2>Events</h2>
        ${
          (() => {
            const rows = operatorEvents(view);
            const tail = (rows.length > 0 ? rows : view.events).slice(-10);
            return tail.length === 0
              ? `<div class="sub">(empty)</div>`
              : `<table>${eventLines(view, 10)
                  .map((line) => {
                    const seq = line.trim().split(/\s+/)[0] ?? "";
                    return `<tr><td>${esc(seq)}</td><td>${esc(line.replace(/^\s*\d+\s+/, ""))}</td></tr>`;
                  })
                  .join("")}</table>`;
          })()
        }
      </div>
      <p class="note">Log projection only. Absent fields stay missing. ${esc(view.plugins.join(", ") || "no plugins this boot")}.</p>
    </section>
  </main>
</body>
</html>`;
}

function graphText(view: DashProjection): string {
  if (!view.plan) {
    return "No work graph in this session.";
  }
  const doing = view.work.doing !== "missing" ? view.work.doing : undefined;
  const states: Record<string, string> = {};
  for (const todo of view.plan.todos) {
    states[todo.id] = todo.id === doing ? "doing" : view.work.todos.find((row) => row.id === todo.id)?.state ?? "ready";
  }
  const dag = renderTodoDag(view.plan.todos, states, 88);
  const dagLines = Array.isArray(dag) ? dag : dag.lines;
  const list = formatPlanShow(view.plan, view.events, { doing }).trimEnd();
  return [...dagLines, list].join("\n");
}

function fmtBytes(value: number | "missing"): string {
  if (value === "missing") {
    return "missing";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function maekHtml(view: DashProjection): string {
  const stats = view.sessionStats;
  if (
    stats.maek_ingest_n === 0 &&
    stats.maek_query_n === 0 &&
    stats.maek_rebuild_n === 0 &&
    stats.maek_failure_n === 0 &&
    !view.maek &&
    !view.swarmMemory
  ) {
    return "missing";
  }
  const last = view.maek ? ` · last ${view.maek.last_name}/${view.maek.last_kind}` : "";
  const state = view.maek
    ? ` · state=${view.maek.state}${view.maek.rows !== undefined ? ` rows=${view.maek.rows}` : ""}`
    : "";
  const stage = view.maek?.failure_stage ? ` · stage=${view.maek.failure_stage}` : "";
  const memory = view.swarmMemory
    ? ` · ${swarmMemorySummary(view.swarmMemory)}`
    : "";
  return `ingest=${stats.maek_ingest_n} · query=${stats.maek_query_n} · rebuild=${stats.maek_rebuild_n} · failed=${stats.maek_failure_n}${state}${stage}${memory}${last}`;
}

function blobGcHtml(view: DashProjection): string {
  const stats = view.sessionStats;
  if (stats.blob_gc_n === 0 || !view.blobGc) {
    return "missing";
  }
  const last = view.blobGc;
  const dry = last.dry_run ? " · dry" : "";
  return `runs=${stats.blob_gc_n} · removed=${stats.blob_removed_sum} · freed=${stats.blob_bytes_freed_sum} · last ${last.removed}/${last.kept}${dry}`;
}

function webVars(theme: DokkabiTheme): string {
  const web = theme.web;
  return [
    `--bg: ${web.bg};`,
    `--bg-2: ${web.bg2};`,
    `--line: ${web.line};`,
    `--ink: ${web.ink};`,
    `--muted: ${web.muted};`,
    `--ember: ${web.ember};`,
    `--ok: ${web.ok};`,
    `--bad: ${web.bad};`,
    `--idle: ${web.idle};`,
  ].join(" ");
}

function esc(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
