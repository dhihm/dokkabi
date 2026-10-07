/**
 * The web board's page.
 *
 * Everything is inline. The board runs on a loopback port beside an
 * unattended run and must open with no network beyond the log it is reading —
 * a CDN that is unreachable, slow, or gone takes the operator's only remote
 * window with it.
 *
 * The page never reloads. It fetches the state once, then holds an
 * EventSource open and paints what arrives, so a scroll position survives, a
 * long reply is read while it grows, and the browser stops flickering once a
 * second.
 */
export function dashPage(session: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(session)} · dokkabi</title>
<style>
:root {
  --bg: #0d1015; --panel: #151a21; --line: #232a34; --line-soft: #1b212a;
  --ink: #e6eaf0; --ink-2: #9aa5b4; --ink-3: #6b7684;
  --ok: #4ea172; --red: #d2586b; --warn: #c9a227; --live: #4a9fd8; --idle: #6b7684;
  --mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 13px/1.5 var(--mono);
}
header {
  position: sticky; top: 0; z-index: 5; background: var(--bg);
  border-bottom: 1px solid var(--line); padding: 10px 16px;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
}
.brand { font-weight: 600; letter-spacing: .04em; }
.pill {
  padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line);
  color: var(--ink-2); font-size: 12px; white-space: nowrap;
}
.pill.live { border-color: var(--live); color: var(--live); }
.pill.silent { border-color: var(--warn); color: var(--warn); }
.pill.idle { border-color: var(--line); color: var(--idle); }
#activity { flex: 1 1 320px; color: var(--ink-2); min-width: 240px; }
main {
  display: grid; gap: 12px; padding: 12px 16px 40px;
  grid-template-columns: minmax(340px, 1fr) minmax(300px, 420px);
}
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
section {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  display: flex; flex-direction: column; min-height: 0;
}
section > h2 {
  margin: 0; padding: 9px 12px; font-size: 11px; letter-spacing: .09em;
  text-transform: uppercase; color: var(--ink-3); font-weight: 600;
  border-bottom: 1px solid var(--line-soft);
  display: flex; justify-content: space-between; gap: 10px;
}
.body { padding: 10px 12px; overflow: auto; }
.tall { max-height: 62vh; }
.short { max-height: 30vh; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; }
.kv dt { color: var(--ink-3); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.turn { border-top: 1px solid var(--line-soft); padding: 9px 0; }
.turn:first-child { border-top: 0; }
.turn .who { color: var(--ink-3); font-size: 11px; display: flex; gap: 8px; }
.turn .who b { color: var(--ink-2); font-weight: 600; }
.turn pre {
  margin: 5px 0 0; white-space: pre-wrap; overflow-wrap: anywhere;
  font: inherit; color: var(--ink);
}
.turn.user pre { color: var(--live); }
.turn.tool .who b { color: var(--ink-2); }
.turn.tool.err .who b { color: var(--red); }
details.think { margin-top: 5px; }
details.think summary { cursor: pointer; color: var(--ink-3); font-size: 11px; }
details.think pre { color: var(--ink-3); }
.todo { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.dot { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 8px; margin-top: 5px; }
.dot.done { background: var(--ok); }
.dot.doing { background: var(--live); }
.dot.blocked { background: var(--ink-3); }
.dot.ready { background: var(--warn); }
.todo .id { color: var(--ink-3); }
.ev { display: grid; grid-template-columns: 62px 128px 1fr; gap: 8px; padding: 1px 0; }
.ev .t { color: var(--ink-3); }
.ev .n { color: var(--ink-2); }
.ev .s { color: var(--ink-3); overflow-wrap: anywhere; }
.counts { display: flex; gap: 10px; }
.counts b { font-weight: 600; }
.g { color: var(--ok); } .r { color: var(--red); }
#err { color: var(--red); padding: 0 16px; }
.prose { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-size: 13.5px; }
.prose p { margin: 5px 0; }
.prose h3, .prose h4, .prose h5, .prose h6 { margin: 10px 0 4px; font-size: 13.5px; color: var(--ink); }
.prose ul, .prose ol { margin: 5px 0; padding-left: 20px; }
.prose li { margin: 2px 0; }
.prose code { font-family: var(--mono); font-size: 12px; background: #0d1015; border: 1px solid var(--line-soft); border-radius: 3px; padding: 0 4px; }
.prose strong { color: #fff; }
.prose em { color: var(--ink-2); font-style: italic; }
.prose.dim, .prose.dim strong { color: var(--ink-3); }
pre.code {
  font-family: var(--mono); font-size: 12px; background: #0b0e12;
  border: 1px solid var(--line-soft); border-radius: 5px; padding: 8px 10px;
  margin: 6px 0; overflow-x: auto; white-space: pre; color: var(--ink-2);
}
.live {
  margin: 0 16px 10px; padding: 9px 12px; border-radius: 8px;
  border: 1px solid var(--live); background: #101822;
  display: flex; gap: 12px; align-items: baseline;
}
.live.stale { border-color: var(--warn); background: #1a1710; }
.live .spin { color: var(--live); }
.live.stale .spin { color: var(--warn); }
#liveText { flex: 1; color: var(--ink); overflow-wrap: anywhere; }
#liveAge { color: var(--ink-3); white-space: nowrap; }
#alerts { margin: 0 16px 10px; display: flex; flex-direction: column; gap: 6px; }
.alert {
  padding: 8px 12px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--warn); background: #1a1710; color: #f0dfa8;
}
.alert.bad { border-color: var(--red); background: #1d1013; color: #f3c2ca; }
.alert b { color: #fff; }
</style>
</head>
<body>
<header>
  <span class="brand">DOKKABI</span>
  <span class="pill" id="sess">${escapeHtml(session)}</span>
  <span class="pill idle" id="state">connecting</span>
  <span id="activity">…</span>
  <span class="pill" id="age">—</span>
</header>
<div id="err"></div>
<div id="alerts"></div>
<div class="live" id="live" hidden>
  <span class="spin" id="spin">&#9654;</span><span id="liveText">&hellip;</span><span id="liveAge"></span>
</div>
<main>
  <section>
    <h2>Turns <span id="turncount"></span></h2>
    <div class="body tall" id="turns"></div>
  </section>
  <div style="display:flex;flex-direction:column;gap:12px;min-width:0">
    <section>
      <h2>Model</h2>
      <div class="body"><dl class="kv" id="model"></dl></div>
    </section>
    <section>
      <h2>Work <span class="counts" id="counts"></span></h2>
      <div class="body short" id="work"></div>
    </section>
    <section>
      <h2>Events</h2>
      <div class="body short" id="events"></div>
    </section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const hhmmss = (ts) => String(ts).slice(11, 19);
const nz = (v) => (v === undefined || v === null || v === "missing" ? "—" : v);

// The model writes markdown. Showing it raw is showing the operator the
// source of the message instead of the message. Escape first, then mark up
// what is left, so nothing the model wrote can become markup of its own.
function md(src) {
  const fences = [];
  let text = esc(src).replace(/\`\`\`([a-z0-9+-]*)\\n?([\\s\\S]*?)\`\`\`/gi, (_m, lang, body) => {
    fences.push('<pre class="code" data-lang="' + lang + '">' + body.replace(/\\n$/, "") + "</pre>");
    return "\\u0000FENCE" + (fences.length - 1) + "\\u0000";
  });
  const lines = text.split("\\n");
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push("<" + list.tag + ">" + list.items.join("") + "</" + list.tag + ">"); list = null; } };
  for (const raw of lines) {
    const fence = raw.match(/^\\u0000FENCE(\\d+)\\u0000$/);
    if (fence) { flush(); out.push(fences[Number(fence[1])]); continue; }
    const head = raw.match(/^(#{1,4})\\s+(.*)$/);
    if (head) { flush(); out.push("<h" + (head[1].length + 2) + ">" + inline(head[2]) + "</h" + (head[1].length + 2) + ">"); continue; }
    const ul = raw.match(/^\\s*[-*]\\s+(.*)$/);
    if (ul) { if (!list || list.tag !== "ul") { flush(); list = { tag: "ul", items: [] }; } list.items.push("<li>" + inline(ul[1]) + "</li>"); continue; }
    const ol = raw.match(/^\\s*\\d+[.)]\\s+(.*)$/);
    if (ol) { if (!list || list.tag !== "ol") { flush(); list = { tag: "ol", items: [] }; } list.items.push("<li>" + inline(ol[1]) + "</li>"); continue; }
    if (!raw.trim()) { flush(); continue; }
    flush();
    out.push("<p>" + inline(raw) + "</p>");
  }
  flush();
  return out.join("");
}

function inline(s) {
  return s
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/(^|[\\s(])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
}

// Nodes are built once and kept. Replacing innerHTML every tick is what
// closed an open <details> the moment the operator opened it and dropped a
// text selection mid-drag — the DOM was thrown away and rebuilt underneath
// them. Appending only what is new leaves both alone.
const KEEP_NODES = 300;
function upsert(container, items, key, build) {
  const seen = container.__keys || (container.__keys = new Set());
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  let added = false;
  for (const item of items) {
    const id = String(key(item));
    if (seen.has(id)) continue;
    seen.add(id);
    const node = build(item);
    node.dataset.key = id;
    container.appendChild(node);
    added = true;
  }
  while (container.childElementCount > KEEP_NODES) {
    const first = container.firstElementChild;
    seen.delete(first.dataset.key);
    first.remove();
  }
  if (added && atBottom) container.scrollTop = container.scrollHeight;
}

function turnNode(t) {
  const el = document.createElement("div");
  if (t.kind === "tool") {
    el.className = "turn tool" + (t.error ? " err" : "");
    const ms = t.durationMs === undefined ? "" : " · " + t.durationMs + "ms";
    el.innerHTML = '<div class="who"><span>' + hhmmss(t.ts) + "</span><b>" + esc(t.tool || "tool")
      + "</b><span>" + (t.error ? "failed" : "ok") + ms + "</span></div>";
    return el;
  }
  el.className = "turn " + t.kind;
  const who = t.kind === "user" ? "operator" : "model";
  const think = t.thinking
    ? '<details class="think"><summary>thinking (' + t.thinking.length + " chars)</summary><div class=\\"prose dim\\">"
      + md(t.thinking) + "</div></details>"
    : "";
  const body = t.text ? '<div class="prose">' + md(t.text) + "</div>" : "";
  el.innerHTML = '<div class="who"><span>' + hhmmss(t.ts) + "</span><b>" + who + "</b>"
    + (t.stop ? "<span>stop=" + esc(t.stop) + "</span>" : "") + "</div>" + body + think;
  return el;
}

function eventNode(e) {
  const el = document.createElement("div");
  el.className = "ev";
  el.innerHTML = '<span class="t">' + hhmmss(e.ts) + '</span><span class="n">' + esc(e.name)
    + '</span><span class="s">' + esc(e.summary) + "</span>";
  return el;
}

// Only the text changes here, never the nodes, so a selection inside a panel
// survives every tick.
function setText(id, value) {
  const el = $(id);
  if (el && el.textContent !== value) el.textContent = value;
}

// A panel only rebuilds when its own data moved. Both of these ran every
// tick and compared the finished HTML, so the work panel re-rendered the
// goal's markdown once a second to discover it was identical -- work the
// main thread was doing while the operator was trying to drag a selection.
const memo = {};
function unchanged(key, value) {
  const mark = JSON.stringify(value);
  if (memo[key] === mark) return true;
  memo[key] = mark;
  return false;
}

function renderModel(m) {
  if (unchanged("model", m)) return;
  const rows = [
    ["route", nz(m.route)], ["model", nz(m.model)], ["provider", nz(m.provider)],
    ["auth", nz(m.auth)], ["in / out", nz(m.inputTokens) + " / " + nz(m.outputTokens)],
    ["context", nz(m.contextUsed) + " / " + nz(m.contextWindow)], ["cache hit", nz(m.hitRatio)],
  ];
  const html = rows.map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>").join("");
  const el = $("model");
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderWork(w) {
  if (unchanged("work", w)) return;
  const counts = '<b class="g">' + w.green + ' green</b><b class="r">' + w.red + " red</b>";
  if ($("counts").innerHTML !== counts) $("counts").innerHTML = counts;
  const head = '<dl class="kv"><dt>goal</dt><dd class="prose">' + md(w.goal || "—") + "</dd>"
    + "<dt>status</dt><dd>" + esc(nz(w.status)) + " · wave " + esc(nz(w.wave)) + "</dd>"
    + "<dt>next</dt><dd>" + esc(nz(w.next)) + "</dd></dl>";
  const todos = w.todos.map((t) =>
    '<div class="todo"><span class="dot ' + t.state + '"></span><span class="id">' + esc(t.id)
    + '</span><span>' + esc(t.title) + "</span></div>").join("");
  const html = head + (todos ? "<div style='margin-top:8px'>" + todos + "</div>" : "");
  const el = $("work");
  if (el.innerHTML !== html) el.innerHTML = html;
}

// What it is doing RIGHT NOW, which the completed-turn list cannot show: the
// call in flight, the model being waited on, and how long it has been.
//
// The clock here is the BROWSER's, not the frame's. Waiting for the server to
// say what time it is meant the age counted up in one-second jumps and the
// live marker never moved between them, so a run that was working read as a
// board that had frozen. The frame sets the anchor; this ticks against it.
let live = null;
const SPIN = ["\u2834", "\u2826", "\u2807", "\u280b", "\u2819", "\u2838", "\u2834", "\u2826"];
let spinAt = 0;

function ageText(ms) {
  const secs = Math.round(ms / 1000);
  return secs < 90 ? secs + "s" : Math.round(secs / 60) + "m";
}

function paintLive() {
  const box = $("live");
  if (!live) { box.hidden = true; return; }
  box.hidden = false;
  const ms = live.ageMs + (Date.now() - live.at);
  spinAt = (spinAt + 1) % SPIN.length;
  setText("spin", SPIN[spinAt]);
  setText("liveAge", "quiet " + ageText(ms));
  box.className = "live" + (ms > 300000 ? " stale" : "");
}

function renderLive(s) {
  if (s.activityKind === "idle") { live = null; $("live").hidden = true; return; }
  // Anchor: what the server said, and when it said it.
  live = { ageMs: s.lastEventAgeMs, at: Date.now() };
  setText("liveText", s.activity);
  paintLive();
}

// The alert an operator must not be able to miss. A run that looks healthy
// and decides nothing for hours is exactly the case this exists for.
function renderAlerts(list) {
  const html = (list || []).map((a) =>
    '<div class="alert' + (a.bad ? " bad" : "") + '">&#9650; ' + esc(a.text) + "</div>").join("");
  const el = $("alerts");
  if (el.innerHTML !== html) el.innerHTML = html;
}

// What the page has been told so far, for the fields a frame may omit.
const seen = { session: "", turns: 0 };
function apply(s) {
  // A frame carries the panels that MOVED. A key that is absent means the
  // server has nothing new for that panel, which is not the same as the panel
  // being empty — treating the two alike blanked the board four times a
  // second. Only the activity line, its kind, and the age arrive every
  // frame; they are the anchor the live marker counts from.
  if (s.session !== undefined) {
    setText("sess", s.session);
    seen.session = s.session;
  }
  setText("activity", s.activity);
  const secs = Math.round(s.lastEventAgeMs / 1000);
  setText("age", "last " + (secs < 90 ? secs + "s" : Math.round(secs / 60) + "m"));
  const pill = $("state");
  const quiet = s.lastEventAgeMs > 300000;
  const cls = "pill " + (quiet ? "silent" : s.activityKind === "idle" ? "idle" : "live");
  if (pill.className !== cls) pill.className = cls;
  setText("state", quiet ? "silent" : s.activityKind === "idle" ? "idle" : "running");
  if (s.error !== undefined) setText("err", s.error ? "error " + s.error : "");
  if (s.alerts !== undefined) renderAlerts(s.alerts);
  if (s.model !== undefined) renderModel(s.model);
  if (s.work !== undefined) renderWork(s.work);
  renderLive(s);
  if (s.turns !== undefined) {
    upsert($("turns"), s.turns, (t) => t.seq, turnNode);
    seen.turns += s.turns.length;
    setText("turncount", seen.turns ? "last " + Math.min(seen.turns, 40) : "");
  }
  if (s.events !== undefined) upsert($("events"), s.events, (e) => e.seq, eventNode);
  const title = (quiet ? "● " : "") + (seen.session || "dokkabi") + " · dokkabi";
  if (document.title !== title) document.title = title;
}

let source;
function connect() {
  source = new EventSource("/api/stream");
  source.onmessage = (e) => { try { apply(JSON.parse(e.data)); } catch (err) { void err; } };
  source.onerror = () => {
    $("state").className = "pill silent";
    setText("state", "reconnecting");
    source.close();
    // The board outlives the run it watches: a restart must not leave a dead
    // page behind, and a page that gives up is worse than one that waits.
    setTimeout(connect, 2000);
  };
}
// The marker moves on its own between frames. Eight frames a second is the
// difference between "working" and "stopped" to anyone looking at it.
setInterval(paintLive, 125);
fetch("/api/state").then((r) => r.json()).then(apply).catch(() => {});
connect();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/gu, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char));
}
