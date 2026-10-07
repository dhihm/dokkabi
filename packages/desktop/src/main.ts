/**
 * Dokkabi Desktop — agent console client.
 *
 * The console tab is a live projection of a session's EventLog: transcript
 * cards arrive from transcript.snapshot / transcript.append, the rail from
 * the snapshot's usage and plan data, and the composer speaks through the
 * embedded chat kernel (chat.open/send/abort) or — when another process
 * owns the session — stages notes into the operator inbox (note.submit).
 * The terminal grid and diff views remain as tabs. Every number on screen
 * comes from the gateway's recorded truth; nothing is client-fed.
 */

import {
  renderComposer,
  renderPlanWidget,
  renderRail,
  renderSidebar,
  renderTranscript,
  themeNames,
  themeVars,
  type ComposerState,
  type PlanSnapshotView,
  type RouteStatusView,
  type SessionRow,
  type TranscriptCard,
} from "./render/console.ts";

interface TailscaleInfo {
  connected: boolean;
  tailscaleIp: string | null;
  nodeName: string | null;
  mobileUrl: string | null;
  qrSvg: string | null;
}

interface GitFileDiff {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  diffText: string;
  additions: number;
  deletions: number;
}

interface DiffSummary {
  files: GitFileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  branch: string;
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  kind: string;
  severity: string;
  tool: string;
  args: unknown;
  reason?: string;
  createdAt: number;
}

interface ModelCandidate {
  value: string;
  summary: string;
  kind?: "route" | "model";
  route?: string;
  section?: "recent" | "favorite" | "vendor" | "catalog";
}

interface RailUsageView {
  contextUsed: number | "missing";
  contextWindow: number | "missing";
  inputTokens: number | "missing";
  outputTokens: number | "missing";
}

let ws: WebSocket | null = null;
let currentTailscale: TailscaleInfo | null = null;
let sessions: SessionRow[] = [];
let currentDiff: DiffSummary | null = null;
let selectedFilePath: string | null = null;
const pendingApprovals = new Map<string, PendingApproval>();

// Console state
let watchedSessionId: string | undefined;
let transcriptCards: TranscriptCard[] = [];
let lastUsage: RailUsageView | undefined;
let planView: PlanSnapshotView | null = null;
let modelCandidates: ModelCandidate[] = [];
let chatOwned = false;
let chatBusy = false;
let chatOwnerLine: string | undefined;
let chatRoute: RouteStatusView | undefined;
let slashSelected = 0;

// DOM Elements
const sessionListEl = document.getElementById("session-list");
const transcriptEl = document.getElementById("transcript");
const railEl = document.getElementById("context-rail");
const composerInput = document.getElementById("composer-input") as HTMLTextAreaElement;
const composerSend = document.getElementById("composer-send");
const composerStateEl = document.getElementById("composer-state");
const composerSuggestEl = document.getElementById("composer-suggest");
const sessionBadge = document.getElementById("session-badge");

// Terminal / diff / modals (kept from the control-surface client)
const pane1Output = document.getElementById("pane-1-output");
const pane1Input = document.getElementById("pane-1-input") as HTMLInputElement;
const pane2Output = document.getElementById("pane-2-output");
const pane2Input = document.getElementById("pane-2-input") as HTMLInputElement;
const tailscaleModal = document.getElementById("tailscale-modal");
const qrTarget = document.getElementById("qr-target");
const mobileUrlLink = document.getElementById("mobile-url-link") as HTMLAnchorElement;
const omnibarModal = document.getElementById("omnibar-modal");
const omnibarSearch = document.getElementById("omnibar-search") as HTMLInputElement;
const omnibarResults = document.getElementById("omnibar-results");
const tabConsoleBtn = document.getElementById("tab-console-btn");
const tabTerminalBtn = document.getElementById("tab-terminal-btn");
const tabDiffBtn = document.getElementById("tab-diff-btn");
const viewConsole = document.getElementById("view-console");
const viewTerminal = document.getElementById("view-terminal");
const viewDiff = document.getElementById("view-diff");
const diffBranchName = document.getElementById("diff-branch-name");
const diffFileList = document.getElementById("diff-file-list");
const diffSelectedFile = document.getElementById("diff-selected-file");
const diffCounts = document.getElementById("diff-counts");
const diffCodeView = document.getElementById("diff-code-view");
const desktopApprovals = document.getElementById("desktop-approvals");
const themeSelect = document.getElementById("theme-select") as HTMLSelectElement;

// The gateway rejects an unauthenticated websocket (403). In the Tauri
// shell the token is fetched over the tokenless LOCAL unix socket; in a
// plain browser it comes from the pairing fragment and leaves visible history.
async function resolveGatewayToken(): Promise<string> {
  const fromUrl = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (fromUrl) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return fromUrl;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = (await invoke("send_rpc", { method: "tailscale.info", params: {} })) as { mobileUrl?: string };
    if (info?.mobileUrl) {
      return new URLSearchParams(new URL(info.mobileUrl).hash.slice(1)).get("token") ?? "";
    }
  } catch {
    // Browser pairing requires the fragment acquired above.
  }
  return "";
}

function setGatewayBadge(connected: boolean) {
  const badge = document.getElementById("gw-badge");
  if (!badge) return;
  badge.style.background = connected ? "var(--success)" : "var(--muted)";
  badge.textContent = connected ? "gateway" : "disconnected";
}

async function connectGateway() {
  const port = Number(new URLSearchParams(window.location.search).get("port") ?? 4174);
  const token = await resolveGatewayToken();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  ws = new WebSocket(wsUrl, ["dokkabi.rpc", "dokkabi.auth." + encodeURIComponent(token)]);

  ws.onopen = () => {
    setGatewayBadge(true);
    sendRpc("session.list");
    sendRpc("tailscale.info");
    sendRpc("speculative.metrics");
    sendRpc("diff.get");
    sendRpc("approval.list");
    sendRpc("agent.profiles");
    void rpcCall("model.candidates").then((res) => {
      const result = res?.result as { details?: ModelCandidate[] } | undefined;
      if (result?.details) modelCandidates = result.details;
    });
    // The desktop converses with its own workspace session by default —
    // the same lease a terminal chat would take. If a terminal owns it,
    // the composer falls back to observer notes honestly.
    void rpcCall("chat.open").then(async (res) => {
      chatOwned = !res?.error;
      if (res?.error) chatOwnerLine = res.error.message;
      if (!res?.error) {
        const sessionId = (res.result as { sessionId?: string })?.sessionId;
        if (sessionId) await watchSession(sessionId);
      }
      await refreshChatState();
    });
  };

  ws.onmessage = (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (err) {
      console.error("[Desktop] Parse error:", err);
    }
  };

  ws.onclose = () => {
    setGatewayBadge(false);
    liveTerminals.clear();
    for (const settle of rpcPending.values()) {
      settle({ error: { message: "gateway disconnected" } });
    }
    rpcPending.clear();
    chatOwned = false;
    renderComposerState();
    setTimeout(connectGateway, 2000);
  };
}

function sendRpc(method: string, params: unknown = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    method,
    params,
  }));
}

let rpcSeq = 0;
const rpcPending = new Map<string, (msg: unknown) => void>();

function rpcCall(method: string, params: unknown = {}): Promise<any> {
  return new Promise((resolvePromise) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolvePromise({ error: { message: "gateway not connected" } });
      return;
    }
    const id = `call_${++rpcSeq}`;
    rpcPending.set(id, resolvePromise as (msg: unknown) => void);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

// --- Console flow ---

async function watchSession(sessionId: string) {
  if (watchedSessionId === sessionId) return;
  if (watchedSessionId) sendRpc("transcript.unsubscribe", { sessionId: watchedSessionId });
  watchedSessionId = sessionId;
  transcriptCards = [];
  lastUsage = undefined;
  planView = null;
  if (sessionBadge) sessionBadge.textContent = sessionId;
  renderTranscriptView();
  renderRailView();

  const res = await rpcCall("transcript.snapshot", { sessionId });
  if (!res?.error) {
    const result = res.result as { cards?: TranscriptCard[]; usage?: RailUsageView };
    transcriptCards = result.cards ?? [];
    lastUsage = result.usage;
    renderTranscriptView();
    renderRailView();
    sendRpc("transcript.subscribe", { sessionId });
  }
  const planRes = await rpcCall("plan.snapshot", { sessionId });
  if (!planRes?.error) {
    planView = planSnapshotView(planRes.result);
    renderRailView();
  }
  renderSidebarView();
}

/** The gateway's WorkView flattened into the widget's rows. */
function planSnapshotView(result: unknown): PlanSnapshotView | null {
  const data = result as {
    plan: { goal: { statement: string }; todos?: { id: string; title: string }[] } | null;
    view?: {
      todoState?: Record<string, string>;
      caseStatus?: Record<string, string>;
    };
  };
  if (!data?.plan) return null;
  const todoState = data.view?.todoState ?? {};
  const caseStatus = data.view?.caseStatus ?? {};
  // Case rows come from the plan payload when present; statuses from the view.
  const plan = data.plan as unknown as {
    goal: { statement: string };
    todos: { id: string; title: string }[];
    cases?: { id: string; scenario: string; command: string }[];
  };
  return {
    goal: plan.goal.statement,
    todos: (plan.todos ?? []).map((todo) => ({
      id: todo.id,
      title: todo.title,
      state: todoState[todo.id] ?? "blocked",
    })),
    cases: (plan.cases ?? []).map((item) => ({
      id: item.id,
      scenario: item.scenario,
      command: item.command,
      status: caseStatus[item.id] === "green" ? "green" : caseStatus[item.id] === "red" ? "red" : "unrun",
    })),
    errors: [],
  };
}

function appendCards(cards: TranscriptCard[]) {
  const nearBottom = !transcriptEl || transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 80;
  transcriptCards = [...transcriptCards, ...cards];
  if (transcriptEl && nearBottom) {
    transcriptEl.insertAdjacentHTML("beforeend", renderTranscript(cards));
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else {
    renderTranscriptView();
  }
}

function renderTranscriptView() {
  if (!transcriptEl) return;
  transcriptEl.innerHTML = renderTranscript(transcriptCards);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function renderSidebarView() {
  if (!sessionListEl) return;
  sessionListEl.innerHTML = renderSidebar(sessions);
  for (const item of sessionListEl.querySelectorAll(".session-item")) {
    (item as HTMLElement).onclick = () => {
      const id = (item as HTMLElement).dataset.session;
      if (id) void watchSession(id);
    };
  }
}

function renderRailView() {
  if (!railEl) return;
  railEl.innerHTML = renderRail({
    usage: lastUsage,
    approvals: pendingApprovals.size,
    chat: { owned: chatOwned, busy: chatBusy },
    ...(chatRoute ? { route: chatRoute } : {}),
  });
  railEl.insertAdjacentHTML("beforeend", renderPlanWidget(planView));
}

/** Refresh the kernel's route readiness and repaint the rail. */
async function refreshChatState() {
  const res = await rpcCall("chat.state");
  if (res?.error) return;
  const state = res.result as {
    owned?: boolean;
    busy?: boolean;
    route?: string;
    model?: string;
    ready?: boolean;
    reason?: string;
  };
  chatOwned = state.owned === true;
  chatBusy = state.busy === true;
  if (state.owned && state.route) {
    chatRoute = {
      route: state.route,
      ...(state.model ? { model: state.model } : {}),
      ready: state.ready === true,
      ...(state.reason ? { reason: state.reason } : {}),
    };
  } else {
    chatRoute = undefined;
  }
  renderComposerState();
  renderRailView();
}

function renderComposerState() {
  if (!composerStateEl) return;
  const state: ComposerState = { owned: chatOwned, busy: chatBusy };
  if (!chatOwned && chatOwnerLine) state.ownerLine = chatOwnerLine;
  composerStateEl.innerHTML = renderComposer(state);
  const abort = composerStateEl.querySelector("[data-action='abort']");
  if (abort) {
    (abort as HTMLElement).onclick = async () => {
      const res = await rpcCall("chat.abort");
      if (res?.result) chatBusy = false;
      renderComposerState();
      renderRailView();
    };
  }
  const own = composerStateEl.querySelector("[data-action='own']");
  if (own) {
    (own as HTMLElement).onclick = async () => {
      const res = await rpcCall("chat.open");
      if (res?.error) {
        chatOwnerLine = res.error.message;
      } else {
        chatOwnerLine = undefined;
        const sessionId = (res.result as { sessionId?: string })?.sessionId;
        if (sessionId) void watchSession(sessionId);
      }
      await refreshChatState();
    };
  }
}

// --- Composer input: chat turn, observer note, or slash command ---

interface SlashCommand {
  name: string;
  summary: string;
  run(args: string): Promise<void>;
}

function systemCard(text: string): void {
  appendCards([{ kind: "system", seq: Date.now(), ts: new Date().toISOString(), text }]);
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "model",
    summary: "set the route/model — /model <route>[/<model>]",
    async run(args) {
      const choice = args.trim();
      if (!choice) {
        systemCard("Usage: /model <route> or /model <route>/<model> — Tab completes the two-stage list");
        return;
      }
      // Owned: switch the live kernel. Observer: persist the saved pair the
      // CLI `dokkabi model` writes; it lands on the next session start.
      const method = chatOwned ? "chat.model" : "model.select";
      const res = await rpcCall(method, { choice });
      if (res?.error) {
        systemCard(`/${method === "chat.model" ? "model" : "model"} failed: ${res.error.message}`);
        return;
      }
      const result = res.result as { message?: string; handoff?: { route: string; model: string } };
      if (result?.handoff) {
        systemCard(
          `Large carry switching to ${result.handoff.route}/${result.handoff.model} — send "/model ${result.handoff.route}/${result.handoff.model} carry" or "… slim"`,
        );
      } else if (result?.message) {
        systemCard(result.message);
      }
      await refreshChatState();
    },
  },
  {
    name: "effort",
    summary: "set reasoning effort — /effort high",
    async run(args) {
      if (!chatOwned) {
        systemCard("Effort needs the chat kernel — press Own this session first");
        return;
      }
      const res = await rpcCall("chat.effort", { level: args.trim() });
      if (res?.error) {
        systemCard(`/effort failed: ${res.error.message}`);
        return;
      }
      const message = (res.result as { message?: string })?.message;
      if (message) systemCard(message);
    },
  },
  {
    name: "plan",
    summary: "refresh the plan widget",
    async run() {
      if (!watchedSessionId) return;
      const res = await rpcCall("plan.snapshot", { sessionId: watchedSessionId });
      if (!res?.error) {
        planView = planSnapshotView(res.result);
        renderRailView();
      }
    },
  },
  {
    name: "theme",
    summary: "switch palette — /theme nord",
    async run(args) {
      applyTheme(args.trim() || "dokkabi");
    },
  },
];

/** Two-stage completions: providers first, the chosen provider's models after. */
function slashSuggestions(draft: string): string[] {
  if (!draft.startsWith("/")) return [];
  const body = draft.slice(1);
  const spaceAt = body.indexOf(" ");
  if (spaceAt === -1) {
    return SLASH_COMMANDS.filter((command) => command.name.startsWith(body.toLowerCase())).map((command) => `/${command.name}`);
  }
  const name = body.slice(0, spaceAt).toLowerCase();
  if (name !== "model") return [];
  const arg = body.slice(spaceAt + 1).trim().toLowerCase();
  return modelCandidates
    .filter((candidate) => {
      if (arg.includes("/")) {
        const provider = arg.split("/")[0]!;
        return candidate.kind === "model" && candidate.route === provider;
      }
      return candidate.kind === "route" || candidate.section === "favorite" || candidate.section === "recent";
    })
    .filter((candidate) => candidate.value.toLowerCase().startsWith(arg) || arg.includes("/"))
    .map((candidate) => `/model ${candidate.value}`);
}

function renderSuggestions() {
  if (!composerSuggestEl) return;
  const draft = composerInput.value;
  const options = slashSuggestions(draft).slice(0, 8);
  if (slashSelected >= options.length) slashSelected = Math.max(0, options.length - 1);
  composerSuggestEl.replaceChildren();
  for (const [index, option] of options.entries()) {
    const button = document.createElement("button");
    button.className = `sugg${index === slashSelected ? " selected" : ""}`;
    button.dataset.option = option;
    button.textContent = option;
    composerSuggestEl.appendChild(button);
  }
  for (const button of composerSuggestEl.querySelectorAll(".sugg")) {
    (button as HTMLElement).onclick = () => {
      composerInput.value = (button as HTMLElement).dataset.option ?? "";
      renderSuggestions();
      composerInput.focus();
    };
  }
}

async function submitComposer() {
  const text = composerInput.value.trim();
  if (!text) return;
  if (text.startsWith("/")) {
    const body = text.slice(1);
    const spaceAt = body.indexOf(" ");
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const args = spaceAt === -1 ? "" : body.slice(spaceAt + 1);
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === name);
    composerInput.value = "";
    renderSuggestions();
    if (command) {
      await command.run(args);
    } else {
      appendCards([{ kind: "system", seq: Date.now(), ts: new Date().toISOString(), text: `Unknown command /${name}` }]);
    }
    return;
  }
  composerInput.value = "";
  renderSuggestions();
  if (chatOwned) {
    const res = await rpcCall("chat.send", { text });
    if (res?.error) {
      appendCards([{ kind: "system", seq: Date.now(), ts: new Date().toISOString(), text: res.error.message }]);
    }
  } else if (watchedSessionId) {
    const res = await rpcCall("note.submit", { sessionId: watchedSessionId, text });
    const ok = !res?.error;
    appendCards([{
      kind: "system",
      seq: Date.now(),
      ts: new Date().toISOString(),
      text: ok ? "Note staged — it rides the next turn" : `Note not staged: ${res?.error?.message ?? "unknown error"}`,
    }]);
  }
}

// --- Terminal panes (kept) ---

function appendToPane(target: HTMLElement | null, text: string) {
  if (!target) return;
  target.textContent += text;
  target.scrollTop = target.scrollHeight;
}

const liveTerminals = new Set<string>();

async function ensureTerminal(id: string, profileKind: string): Promise<void> {
  if (liveTerminals.has(id)) return;
  const res = await rpcCall("terminal.spawn", { terminalId: id, profileKind });
  if (res.error || res.result?.ok === false) {
    throw new Error(res.error?.message ?? res.result?.reason ?? "spawn failed");
  }
  liveTerminals.add(id);
}

async function sendChat() {
  const text = pane1Input.value.trim();
  if (!text) return;
  pane1Input.value = "";
  try {
    await ensureTerminal("1", "dokkabi");
    const res = await rpcCall("terminal.write", { terminalId: "1", data: text + "\n" });
    if (res.error || res.result?.ok === false) {
      throw new Error(res.error?.message ?? res.result?.reason ?? "write failed");
    }
  } catch (error) {
    appendToPane(pane1Output, `[chat] ${(error as Error).message}\n`);
  }
}

async function sendTerminalInput() {
  const text = pane2Input.value.trim();
  if (!text) return;
  pane2Input.value = "";
  try {
    await ensureTerminal("2", "custom");
    const res = await rpcCall("terminal.write", { terminalId: "2", data: text + "\n" });
    if (res.error || res.result?.ok === false) {
      throw new Error(res.error?.message ?? res.result?.reason ?? "write failed");
    }
  } catch (error) {
    appendToPane(pane2Output, `[terminal] ${(error as Error).message}\n`);
  }
}

// --- Message routing ---

function handleMessage(msg: any) {
  if (msg.id && String(msg.id).startsWith("call_") && rpcPending.has(String(msg.id))) {
    rpcPending.get(String(msg.id))!(msg);
    rpcPending.delete(String(msg.id));
    return;
  }
  if (msg.id && String(msg.id).startsWith("req_")) {
    handleBootstrapReply(msg);
    return;
  }
  if (msg.error) {
    appendToPane(pane1Output, `[gateway] ${msg.error.message ?? `error ${msg.error.code}`}\n`);
    return;
  }
  // Notifications
  switch (msg.method) {
    case "terminal.output": {
      const termId = msg.params?.terminalId;
      const text = msg.params?.data;
      if (termId === "1") appendToPane(pane1Output, text);
      else if (termId === "2") appendToPane(pane2Output, text);
      break;
    }
    case "terminal.exited": {
      const termId = msg.params?.terminalId;
      if (typeof termId === "string") liveTerminals.delete(termId);
      const note = `[system] exited (code ${msg.params?.exitCode ?? "?"}) — next input respawns\n`;
      if (termId === "1") appendToPane(pane1Output, note);
      if (termId === "2") appendToPane(pane2Output, note);
      break;
    }
    case "session.switched":
    case "session.created":
    case "session.deleted":
      sendRpc("session.list");
      break;
    case "transcript.append":
      if (msg.params?.sessionId === watchedSessionId && Array.isArray(msg.params.cards)) {
        appendCards(msg.params.cards as TranscriptCard[]);
        // The rail's usage rides the log: refresh it lazily with the cards.
        if (watchedSessionId) {
          void rpcCall("transcript.snapshot", { sessionId: watchedSessionId }).then((res) => {
            if (!res?.error) {
              lastUsage = (res.result as { usage?: RailUsageView }).usage;
              renderRailView();
            }
          });
        }
      }
      break;
    case "chat.turn":
      if (msg.params?.phase === "started" || msg.params?.phase === "queued") chatBusy = true;
      if (msg.params?.phase === "ended") chatBusy = false;
      renderComposerState();
      renderRailView();
      void refreshChatState();
      break;
    case "chat.opened":
      chatOwned = true;
      chatOwnerLine = undefined;
      void refreshChatState();
      break;
    case "chat.closed":
      chatOwned = false;
      chatBusy = false;
      void refreshChatState();
      break;
    case "approval.request":
      pendingApprovals.set(msg.params.approvalId, msg.params);
      renderApprovals();
      renderRailView();
      break;
    case "approval.resolved":
      pendingApprovals.delete(msg.params.approvalId);
      renderApprovals();
      renderRailView();
      break;
    case "speculative.metrics":
      break;
    default:
      break;
  }
}

function handleBootstrapReply(msg: any) {
  if (msg.error) return;
  const result = msg.result;
  if (Array.isArray(result) && result.length > 0 && (result[0]?.goal !== undefined || result[0]?.turns !== undefined)) {
    sessions = result;
    renderSidebarView();
    return;
  }
  if (Array.isArray(result) && result[0]?.approvalId) {
    for (const appr of result) pendingApprovals.set(appr.approvalId, appr);
    renderApprovals();
    renderRailView();
    return;
  }
  if (result?.branch && Array.isArray(result?.files)) {
    currentDiff = result;
    renderDiffSummary();
    return;
  }
  if (result?.qrSvg) {
    currentTailscale = result;
    renderTailscale();
  }
}

// --- Approvals (kept; the rail counts them too) ---

function renderApprovals() {
  if (!desktopApprovals) return;
  desktopApprovals.innerHTML = "";
  for (const appr of pendingApprovals.values()) {
    const bar = document.createElement("div");
    bar.className = "approval-banner";
    const message = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = `Approval waiting: ${appr.tool}`;
    const reason = document.createElement("div");
    reason.textContent = appr.reason || "This action needs operator approval.";
    message.append(title, reason);
    const controls = document.createElement("div");
    for (const decision of ["allow", "deny"] as const) {
      const button = document.createElement("button");
      button.className = decision === "allow" ? "btn btn-primary" : "btn btn-abort";
      button.textContent = decision === "allow" ? "Approve" : "Deny";
      button.onclick = () => (window as any).respondApproval(appr.approvalId, decision);
      controls.appendChild(button);
    }
    bar.append(message, controls);
    desktopApprovals.appendChild(bar);
  }
}

(window as any).respondApproval = (approvalId: string, decision: "allow" | "deny") => {
  const appr = pendingApprovals.get(approvalId);
  sendRpc("approval.respond", {
    sessionId: appr?.sessionId,
    approvalId,
    decision,
  });
  pendingApprovals.delete(approvalId);
  renderApprovals();
  renderRailView();
};

// --- Tailscale modal (kept) ---

function renderTailscale() {
  if (!currentTailscale) return;
  if (qrTarget && currentTailscale.qrSvg) qrTarget.innerHTML = currentTailscale.qrSvg;
  if (mobileUrlLink && currentTailscale.mobileUrl) {
    mobileUrlLink.href = currentTailscale.mobileUrl;
    mobileUrlLink.textContent = currentTailscale.mobileUrl;
  }
}

(window as any).openTailscaleModal = () => {
  if (tailscaleModal) tailscaleModal.classList.add("open");
  sendRpc("tailscale.info");
};

(window as any).closeTailscaleModal = () => {
  if (tailscaleModal) tailscaleModal.classList.remove("open");
};

// --- Views, terminal spawn, diff (kept, retabbed) ---

(window as any).switchView = (view: "console" | "terminal" | "diff") => {
  const show = view === "console" ? viewConsole : view === "terminal" ? viewTerminal : viewDiff;
  for (const element of [viewConsole, viewTerminal, viewDiff]) {
    if (element) element.style.display = element === show ? (element === viewConsole ? "grid" : "flex") : "none";
  }
  for (const [button, name] of [[tabConsoleBtn, "console"], [tabTerminalBtn, "terminal"], [tabDiffBtn, "diff"]] as const) {
    if (button) button.classList.toggle("active", name === view);
  }
  if (view === "diff") (window as any).refreshDiff();
};

(window as any).refreshDiff = () => {
  sendRpc("diff.get");
};

(window as any).setGridLayout = (layout: "1x1" | "1x2" | "2x2") => {
  const grid = document.getElementById("grid-container");
  if (grid) grid.className = `grid-container grid-${layout}`;
};

(window as any).spawnAgent = async (profileKind: "dokkabi" | "claude-code" | "codex" | "shell") => {
  appendToPane(pane2Output, `[system] Spawning agent profile [${profileKind}]...\n`);
  try {
    if (liveTerminals.has("2")) {
      await rpcCall("terminal.kill", { terminalId: "2" });
      liveTerminals.delete("2");
    }
    await ensureTerminal("2", profileKind);
    (window as any).switchView("terminal");
  } catch (error) {
    appendToPane(pane2Output, `[system] ${(error as Error).message}\n`);
  }
};

function renderDiffSummary() {
  if (!currentDiff) return;
  if (diffBranchName) {
    diffBranchName.textContent = `⎇ ${currentDiff.branch} (+${currentDiff.totalAdditions} -${currentDiff.totalDeletions})`;
  }
  if (!diffFileList) return;
  diffFileList.innerHTML = "";
  if (currentDiff.files.length === 0) {
    diffFileList.innerHTML = `<li style="padding: 10px; color: var(--muted); font-size: 12px;">Working tree clean.</li>`;
    if (diffCodeView) diffCodeView.textContent = "No modified files.";
    if (diffSelectedFile) diffSelectedFile.textContent = "";
    if (diffCounts) diffCounts.textContent = "";
    return;
  }
  if (!selectedFilePath || !currentDiff.files.some((f) => f.path === selectedFilePath)) {
    selectedFilePath = currentDiff.files[0].path;
  }
  for (const file of currentDiff.files) {
    const li = document.createElement("li");
    li.className = `diff-file-item ${file.path === selectedFilePath ? "selected" : ""}`;
    const statusColor = file.status === "added" ? "var(--success)" : file.status === "deleted" ? "var(--danger)" : "var(--accent)";
    const pathLabel = document.createElement("span");
    pathLabel.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;";
    pathLabel.textContent = file.path;
    const countsLabel = document.createElement("span");
    countsLabel.style.cssText = `font-size: 10px; font-weight: bold; color: ${statusColor};`;
    countsLabel.textContent = `[+${file.additions} -${file.deletions}]`;
    li.append(pathLabel, countsLabel);
    li.onclick = () => {
      selectedFilePath = file.path;
      renderDiffSummary();
    };
    diffFileList.appendChild(li);
  }
  const activeFile = currentDiff.files.find((f) => f.path === selectedFilePath);
  if (activeFile && diffCodeView && diffSelectedFile && diffCounts) {
    diffSelectedFile.textContent = activeFile.path;
    diffCounts.textContent = `${activeFile.status} · +${activeFile.additions} -${activeFile.deletions}`;
    diffCodeView.innerHTML = "";
    for (const line of (activeFile.diffText || `(no content change or new file: ${activeFile.path})`).split("\n")) {
      const div = document.createElement("div");
      if (line.startsWith("+") && !line.startsWith("+++")) div.className = "diff-line-add";
      else if (line.startsWith("-") && !line.startsWith("---")) div.className = "diff-line-del";
      else if (line.startsWith("@@")) div.className = "diff-line-hunk";
      div.textContent = line || " ";
      diffCodeView.appendChild(div);
    }
  }
}

// --- Themes ---

function applyTheme(name: string) {
  document.documentElement.setAttribute("style", themeVars(name));
  for (const option of themeSelect.options) {
    option.selected = option.value === (themeNames().includes(name.toLowerCase()) ? name.toLowerCase() : "dokkabi");
  }
}

for (const name of themeNames()) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  themeSelect.appendChild(option);
}
themeSelect.onchange = () => applyTheme(themeSelect.value);
applyTheme("dokkabi");

// --- Omnibar (kept; new views included) ---

function renderOmnibarOptions(query: string) {
  if (!omnibarResults) return;
  omnibarResults.innerHTML = "";
  const opts = [
    { label: "Console: watch the workspace session", action: () => (window as any).switchView("console") },
    { label: "Terminal grid", action: () => (window as any).switchView("terminal") },
    { label: "Git diff canvas", action: () => (window as any).switchView("diff") },
    { label: "Spawn Dokkabi agent terminal", action: () => (window as any).spawnAgent("dokkabi") },
    { label: "Spawn Claude Code terminal", action: () => (window as any).spawnAgent("claude-code") },
    { label: "Spawn Codex terminal", action: () => (window as any).spawnAgent("codex") },
    { label: "Spawn system shell", action: () => (window as any).spawnAgent("shell") },
    { label: "Mobile pairing QR", action: () => (window as any).openTailscaleModal() },
    { label: "Refresh workspace state", action: () => { (window as any).refreshDiff(); sendRpc("session.list"); } },
  ].filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  for (const opt of opts) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.textAlign = "left";
    btn.style.width = "100%";
    btn.style.padding = "8px 12px";
    btn.textContent = opt.label;
    btn.onclick = () => {
      opt.action();
      if (omnibarModal) omnibarModal.classList.remove("open");
    };
    omnibarResults.appendChild(btn);
  }
}

if (omnibarSearch) {
  omnibarSearch.addEventListener("input", () => renderOmnibarOptions(omnibarSearch.value));
}

const omnibarTrigger = document.getElementById("omnibar-trigger");
if (omnibarTrigger) {
  omnibarTrigger.addEventListener("click", () => {
    if (omnibarModal) {
      omnibarModal.classList.add("open");
      omnibarSearch.focus();
      renderOmnibarOptions("");
    }
  });
}

// --- Input wiring ---

if (pane1Input) pane1Input.addEventListener("keydown", (e) => { if (e.key === "Enter") void sendChat(); });
if (pane2Input) pane2Input.addEventListener("keydown", (e) => { if (e.key === "Enter") void sendTerminalInput(); });

if (composerInput) {
  composerInput.addEventListener("keydown", (e) => {
    const options = slashSuggestions(composerInput.value);
    if (e.key === "Tab" && options.length > 0) {
      e.preventDefault();
      composerInput.value = options[slashSelected] ?? options[0]!;
      renderSuggestions();
      return;
    }
    if (e.key === "ArrowDown" && options.length > 0) {
      e.preventDefault();
      slashSelected = Math.min(options.length - 1, slashSelected + 1);
      renderSuggestions();
      return;
    }
    if (e.key === "ArrowUp" && options.length > 0) {
      e.preventDefault();
      slashSelected = Math.max(0, slashSelected - 1);
      renderSuggestions();
      return;
    }
    if (e.key === "Escape") {
      composerInput.value = "";
      renderSuggestions();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitComposer();
    }
  });
  composerInput.addEventListener("input", () => {
    slashSelected = 0;
    renderSuggestions();
  });
}

if (composerSend) {
  composerSend.addEventListener("click", () => void submitComposer());
}

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (omnibarModal) {
      omnibarModal.classList.toggle("open");
      if (omnibarModal.classList.contains("open")) {
        omnibarSearch.focus();
        renderOmnibarOptions("");
      }
    }
  } else if (e.key === "Escape") {
    (window as any).closeTailscaleModal();
    if (omnibarModal) omnibarModal.classList.remove("open");
  }
});

// Static controls use bound listeners; CSP never permits inline handlers.
document.querySelector('[data-action="static-action-0"]')?.addEventListener("click", () => { (window as any).openTailscaleModal(); });
document.querySelector('[data-action="static-action-1"]')?.addEventListener("click", () => { (window as any).switchView('console'); });
document.querySelector('[data-action="static-action-2"]')?.addEventListener("click", () => { (window as any).switchView('terminal'); });
document.querySelector('[data-action="static-action-3"]')?.addEventListener("click", () => { (window as any).switchView('diff'); });
document.querySelector('[data-action="static-action-4"]')?.addEventListener("click", () => { (window as any).setGridLayout('1x1'); });
document.querySelector('[data-action="static-action-5"]')?.addEventListener("click", () => { (window as any).setGridLayout('1x2'); });
document.querySelector('[data-action="static-action-6"]')?.addEventListener("click", () => { (window as any).setGridLayout('2x2'); });
document.querySelector('[data-action="static-action-7"]')?.addEventListener("click", () => { (window as any).spawnAgent('dokkabi'); });
document.querySelector('[data-action="static-action-8"]')?.addEventListener("click", () => { (window as any).spawnAgent('claude-code'); });
document.querySelector('[data-action="static-action-9"]')?.addEventListener("click", () => { (window as any).spawnAgent('codex'); });
document.querySelector('[data-action="static-action-10"]')?.addEventListener("click", () => { (window as any).spawnAgent('shell'); });
document.querySelector('[data-action="static-action-11"]')?.addEventListener("click", () => { (window as any).refreshDiff(); });
document.querySelector('[data-action="static-action-12"]')?.addEventListener("click", () => { (window as any).closeTailscaleModal(); });

renderComposerState();
renderRailView();
renderSidebarView();
connectGateway();
