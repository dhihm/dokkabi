/**
 * Pure render builders for the desktop agent console.
 *
 * Every builder is a DOM-free function from projection state to HTML
 * strings, so the console's markup is testable under `bun test` without a
 * browser (the ledger's render cases pin this). All operator-facing text
 * is English (docs/language.md). Untrusted content — notes, model replies,
 * tool output — is escaped before any generated markup wraps it; the small
 * markdown subset below only ever adds tags the builder itself wrote.
 */

// --- Wire types (mirror desktop-server responses; kept local so the bundle
// stays dependency-free) ---

export interface TranscriptCard {
  kind: "note" | "assistant" | "tool" | "approval" | "system";
  seq: number;
  ts: string;
  text?: string;
  thinking?: string;
  stop?: string;
  id?: string;
  tool?: string;
  argHint?: string;
  resultText?: string;
  durationMs?: number | "missing";
  error?: boolean;
  requestId?: string;
  approvalKind?: string;
  target?: string;
  detail?: string;
  state?: "requested" | "resolved";
  event?: string;
}

export interface SessionRow {
  id: string;
  status: string;
  goal: string;
  turns: number;
  events: number;
  active: boolean;
}

export interface PlanTodoRow {
  id: string;
  title: string;
  state: string;
}

export interface PlanCaseRow {
  id: string;
  scenario: string;
  command: string;
  status: "red" | "green" | "unrun";
}

export interface PlanSnapshotView {
  goal: string;
  todos: PlanTodoRow[];
  cases: PlanCaseRow[];
  errors: string[];
}

export interface ComposerState {
  /** The desktop chat kernel owns this session: Enter runs a turn. */
  owned: boolean;
  /** A kernel turn is in flight. */
  busy: boolean;
  /** Another process owns the session: notes stage to the inbox. */
  ownerLine?: string;
}

export interface RouteStatusView {
  route: string;
  model?: string;
  ready: boolean;
  reason?: string;
}

// --- Escaping and the markdown subset ---

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escaped-then-marked-up text. Only tags this function writes can appear. */
export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source);
  const blocks = escaped.split(/```/);
  return blocks
    .map((block, index) => {
      if (index % 2 === 1) {
        return `<pre class="md-code"><code>${block.replace(/^\n/, "")}</code></pre>`;
      }
      return block
        .split(/\n{2,}/)
        .map((paragraph) => {
          const lines = paragraph.split("\n").filter((line) => line.trim().length > 0);
          if (lines.length === 0) return "";
          const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0]!);
          if (lines.length === 1 && heading) {
            return `<h${heading[1]!.length + 1} class="md-h">${heading[2]}</h${heading[1]!.length + 1}>`;
          }
          if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
            return `<ul class="md-list">${lines
              .map((line) => `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`)
              .join("")}</ul>`;
          }
          return `<p class="md-p">${lines.map((line) => inline(line)).join("<br>")}</p>`;
        })
        .filter((part) => part.length > 0)
        .join("");
    })
    .join("");
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// --- Transcript ---

export function renderCard(card: TranscriptCard): string {
  switch (card.kind) {
    case "note":
      return `<div class="card card-note" data-seq="${card.seq}">${renderMarkdown(card.text ?? "")}</div>`;
    case "assistant": {
      const thinking = card.thinking
        ? `<details class="thinking"><summary>Thinking</summary><div class="thinking-body">${escapeHtml(card.thinking)}</div></details>`
        : "";
      return `<article class="card card-assistant" data-seq="${card.seq}">${thinking}<div class="assistant-body">${renderMarkdown(card.text ?? "")}</div></article>`;
    }
    case "tool": {
      const duration = typeof card.durationMs === "number" ? `${card.durationMs} ms` : "—";
      const result = card.resultText
        ? `<details class="tool-result"><summary>Result</summary><pre>${escapeHtml(card.resultText)}</pre></details>`
        : "";
      return `<div class="card card-tool${card.error ? " error" : ""}" data-seq="${card.seq}">`
        + `<header><span class="tool-name">${escapeHtml(card.tool ?? "missing")}</span>`
        + `<span class="tool-args">${escapeHtml(card.argHint ?? "")}</span>`
        + `<span class="tool-duration">${duration}</span></header>${result}</div>`;
    }
    case "approval": {
      const state = card.state === "resolved" ? "resolved" : "requested";
      return `<div class="card card-approval ${state}" data-seq="${card.seq}">`
        + `<header><span class="approval-state">${state}</span>`
        + `<span class="approval-kind">${escapeHtml(card.approvalKind ?? "approval")}</span>`
        + `<span class="approval-target">${escapeHtml(card.target ?? "")}</span></header>`
        + (card.detail ? `<div class="approval-detail">${escapeHtml(card.detail)}</div>` : "")
        + `</div>`;
    }
    case "system":
      return `<div class="card card-system" data-seq="${card.seq}">${escapeHtml(card.text ?? card.event ?? "")}</div>`;
    default:
      return "";
  }
}

export function renderTranscript(cards: readonly TranscriptCard[]): string {
  return cards.map(renderCard).join("");
}

// --- Sidebar ---

export function renderSidebar(sessions: readonly SessionRow[]): string {
  if (sessions.length === 0) {
    return `<div class="sidebar-empty">No sessions yet</div>`;
  }
  return sessions
    .map(
      (session) => `<li class="session-item${session.active ? " active" : ""}" data-session="${escapeHtml(session.id)}">`
        + `<span class="session-id">${escapeHtml(session.id)}</span>`
        + `<span class="session-meta">${escapeHtml(session.status)} · ${session.turns} turns · ${escapeHtml(session.goal || "No goal")}</span>`
        + `</li>`,
    )
    .join("");
}

// --- Plan widget ---

const TODO_STATE_LABEL: Readonly<Record<string, string>> = {
  blocked: "blocked",
  ready: "ready",
  red: "red",
  green: "green",
  clear: "clear",
};

export function renderPlanWidget(plan: PlanSnapshotView | null): string {
  if (!plan) {
    return `<div class="plan-empty">No plan bound to this session</div>`;
  }
  const todos = plan.todos
    .map(
      (todo) => `<li class="plan-todo ${escapeHtml(todo.state)}">`
        + `<span class="plan-state">${TODO_STATE_LABEL[todo.state] ?? todo.state}</span>`
        + `<span class="plan-title">${escapeHtml(todo.title)}</span></li>`,
    )
    .join("");
  const cases = plan.cases
    .map(
      (item) => `<li class="plan-case ${item.status}">`
        + `<span class="case-status">${item.status}</span>`
        + `<code class="case-command">${escapeHtml(item.command)}</code></li>`,
    )
    .join("");
  const errors = plan.errors.length > 0
    ? `<div class="plan-errors">${plan.errors.map((error) => escapeHtml(error)).join("<br>")}</div>`
    : "";
  return `<section class="plan-widget"><h3>Work plan</h3>`
    + `<p class="plan-goal">${escapeHtml(plan.goal)}</p>`
    + `<ul class="plan-todos">${todos}</ul>`
    + `<ul class="plan-cases">${cases}</ul>${errors}</section>`;
}

// --- Composer ---

export function renderComposer(state: ComposerState): string {
  if (state.owned) {
    return state.busy
      ? `<div class="composer owned busy"><span class="turn-indicator" data-live="true">Turn running…</span>`
        + `<button class="btn btn-abort" data-action="abort">Abort turn</button></div>`
      : `<div class="composer owned"><span class="composer-hint">Enter sends · slash commands complete with Tab</span></div>`;
  }
  return `<div class="composer observer">`
    + `<span class="composer-hint">${escapeHtml(
      state.ownerLine ?? "Session owned elsewhere — Enter stages the note for the next turn",
    )}</span>`
    + `<button class="btn" data-action="own">Own this session</button>`
    + `</div>`;
}

// --- Context rail ---

export interface RailUsage {
  contextUsed: number | "missing";
  contextWindow: number | "missing";
  inputTokens: number | "missing";
  outputTokens: number | "missing";
}

export interface RailState {
  usage?: RailUsage;
  approvals: number;
  chat: { owned: boolean; busy: boolean };
  route?: RouteStatusView;
}

/** The rail reports recorded numbers or says missing — never an estimate. */
export function renderRail(state: RailState): string {
  const usage = state.usage;
  const contextLine = usage
    && usage.contextUsed !== "missing"
    && usage.contextWindow !== "missing"
    && usage.contextWindow > 0
    ? `${((usage.contextUsed / usage.contextWindow) * 100).toFixed(1)}%`
    : "missing";
  const tokens = usage && usage.inputTokens !== "missing"
    ? `in ${usage.inputTokens.toLocaleString("en-US")} · out ${usage.outputTokens === "missing" ? "missing" : usage.outputTokens.toLocaleString("en-US")}`
    : "tokens missing";
  const share = usage
    && usage.contextUsed !== "missing"
    && usage.contextWindow !== "missing"
    && usage.contextWindow > 0
    ? Math.min(100, Math.round((usage.contextUsed / usage.contextWindow) * 100))
    : 0;
  const routeBlock = state.route
    ? `<div class="rail-block"><h3>Model</h3>`
      + `<div class="route-line ${state.route.ready ? "ready" : "unready"}">`
      + `${state.route.ready ? "●" : "○"} ${escapeHtml(state.route.route)}`
      + `${state.route.model ? ` / ${escapeHtml(state.route.model)}` : ""}</div>`
      + (state.route.ready
        ? ""
        : `<div class="route-reason">${escapeHtml(state.route.reason ?? "route not ready")}</div>`)
      + `</div>`
    : "";
  return `<section class="rail">`
    + routeBlock
    + `<div class="rail-block"><h3>Context</h3>`
    + `<div class="ctx-bar"><div class="ctx-fill" style="width: ${share}%"></div></div>`
    + `<div class="ctx-line">${contextLine} · ${escapeHtml(tokens)}</div></div>`
    + `<div class="rail-block"><h3>Approvals</h3><div class="approvals-line">${state.approvals} waiting</div></div>`
    + `<div class="rail-block"><h3>Chat</h3><div class="chat-line">${state.chat.owned ? (state.chat.busy ? "Turn running" : "Owned by this window") : "Not owned"}</div></div>`
    + `</section>`;
}

// --- Themes ---

export interface ConsoleTheme {
  name: string;
  vars: Record<string, string>;
}

const THEMES: Readonly<Record<string, ConsoleTheme>> = {
  dokkabi: {
    name: "dokkabi",
    vars: {
      "--bg": "#14161a",
      "--panel": "#1b1e24",
      "--text": "#e6e6e6",
      "--muted": "#8b93a1",
      "--accent": "#e0a458",
      "--success": "#5fb87a",
      "--danger": "#d64f4b",
    },
  },
  slate: {
    name: "slate",
    vars: {
      "--bg": "#10151b",
      "--panel": "#182029",
      "--text": "#dce3ea",
      "--muted": "#7d8a99",
      "--accent": "#7fa8c9",
      "--success": "#79b791",
      "--danger": "#c96a5f",
    },
  },
  nord: {
    name: "nord",
    vars: {
      "--bg": "#2e3440",
      "--panel": "#3b4252",
      "--text": "#eceff4",
      "--muted": "#a9b1ba",
      "--accent": "#88c0d0",
      "--success": "#a3be8c",
      "--danger": "#bf616a",
    },
  },
};

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

/** CSS custom properties for one of the TUI's named palettes. */
export function themeVars(name: string | undefined): string {
  const theme = THEMES[(name ?? "dokkabi").toLowerCase()] ?? THEMES.dokkabi!;
  return Object.entries(theme.vars)
    .map(([key, value]) => `${key}: ${value};`)
    .join(" ");
}
