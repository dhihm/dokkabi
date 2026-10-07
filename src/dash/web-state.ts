import type { EventRecord } from "../host/schema.ts";
import type { DashProjection } from "./project.ts";
import { currentActivity, currentActivityText } from "./activity.ts";
import { derivedAlerts } from "./graphs.ts";

/**
 * What the web board is sent, and why it is not the projection.
 *
 * The HTML mirror used to re-render the whole board every second behind a
 * `<meta http-equiv="refresh">`. The page flickered, the scroll position
 * reset, a streaming reply was cut in half by the next reload, and everything
 * arrived as one `<pre>` — a terminal screenshot in a browser rather than a
 * board. The browser can do far more than the terminal here; it was doing
 * less.
 *
 * So the wire carries STATE, not a rendering, and the page paints it. State
 * has to be bounded: a session's log reaches tens of thousands of events, and
 * the operator needs the last few hundred, not all of them. Each slice below
 * says what it keeps and why that is enough.
 */

/** How much tail each panel keeps. Enough to read, small enough to push. */
const TURN_LIMIT = 40;
const EVENT_LIMIT = 200;
const TOOL_LIMIT = 60;

export interface WebTurn {
  readonly seq: number;
  readonly ts: string;
  readonly kind: "assistant" | "user" | "tool" | "step";
  readonly text?: string;
  readonly thinking?: string;
  readonly tool?: string;
  readonly stop?: string;
  readonly error?: boolean;
  readonly durationMs?: number;
}

export interface WebEvent {
  readonly seq: number;
  readonly ts: string;
  readonly name: string;
  readonly summary: string;
}

export interface WebState {
  readonly session: string;
  readonly generatedAt: string;
  readonly lastSeq: number;
  /** The activity line the TUI paints, so both surfaces agree. */
  readonly activity: string;
  readonly activityKind: string;
  readonly lastEventAgeMs: number;
  readonly agent: string;
  readonly error?: string;
  /** What the board must not let the operator miss. Worst first. */
  readonly alerts: readonly { text: string; bad: boolean }[];
  readonly model: {
    readonly provider?: string;
    readonly model?: string;
    readonly route?: string;
    readonly auth?: string;
    readonly inputTokens?: number | string;
    readonly outputTokens?: number | string;
    readonly contextUsed?: number | string;
    readonly contextWindow?: number | string;
    readonly hitRatio?: number | string;
  };
  readonly work: {
    readonly goal?: string;
    readonly status?: string;
    readonly route?: string;
    readonly wave?: number | string;
    readonly next?: string;
    readonly todos: readonly { id: string; title: string; state: string }[];
    readonly green: number;
    readonly red: number;
  };
  readonly host?: {
    readonly cpuPct?: number | string;
    readonly rssBytes?: number | string;
  };
  readonly turns: readonly WebTurn[];
  readonly events: readonly WebEvent[];
  readonly tools: readonly { name: string; calls: number | string }[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" ? value : undefined;
}

/**
 * The turns panel: what the model said and did, in order.
 *
 * This is the one the terminal serves worst. A reply arrives as a stream and
 * the TUI has a handful of rows for it, so thinking is truncated and a long
 * answer scrolls away. The browser has room, so the whole of each is kept and
 * the page decides what to fold.
 */
function turnsFrom(events: readonly EventRecord[]): WebTurn[] {
  const turns: WebTurn[] = [];
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.name === "assistant/message") {
      turns.push({
        seq: event.seq,
        ts: event.ts,
        kind: "assistant",
        ...(text(payload.text) ? { text: String(payload.text) } : {}),
        ...(text(payload.thinking) ? { thinking: String(payload.thinking) } : {}),
        ...(text(payload.stop) ? { stop: String(payload.stop) } : {}),
      });
      continue;
    }
    if (event.name === "user/message") {
      turns.push({
        seq: event.seq,
        ts: event.ts,
        kind: "user",
        ...(text(payload.text) ? { text: String(payload.text) } : {}),
      });
      continue;
    }
    if (event.name === "tool/end") {
      turns.push({
        seq: event.seq,
        ts: event.ts,
        kind: "tool",
        ...(text(payload.name) ? { tool: String(payload.name) } : {}),
        ...(payload.error === true ? { error: true } : {}),
        ...(typeof payload.duration_ms === "number" ? { durationMs: payload.duration_ms } : {}),
      });
    }
  }
  return turns.slice(-TURN_LIMIT);
}

/** One readable line per event, so the tail reads without opening payloads. */
function eventSummary(event: EventRecord): string {
  const payload = event.payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["id", "todo", "status", "reason", "resolution", "phase", "action", "name", "target", "tool"]) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${value}`);
    if (parts.length >= 4) break;
  }
  return parts.join(" ");
}

export function webState(view: DashProjection, now = Date.now()): WebState {
  const events = view.events;
  const last = events.at(-1);
  const activity = currentActivity(view, now);
  const usage = view.usage;
  const work = view.work as unknown as Record<string, unknown>;
  // Todos live on the bound plan; the board carries their STATE. Pairing the
  // two is what makes the panel readable — a title with a colour, not an id.
  const planTodos = view.plan?.todos ?? [];
  const doneSet = new Set(Array.isArray(work.done) ? work.done.map(String) : []);
  const blockedSet = new Set(Array.isArray(work.blocked) ? work.blocked.map(String) : []);
  const doing = typeof work.doing === "string" ? work.doing : undefined;
  const todos = planTodos.map((todo) => ({
    id: String(todo.id),
    title: String(todo.title ?? ""),
    state: doneSet.has(String(todo.id))
      ? "done"
      : String(todo.id) === doing
        ? "doing"
        : blockedSet.has(String(todo.id))
          ? "blocked"
          : "ready",
  }));
  const cases = events.filter((event) => event.name === "work/case");
  let green = 0;
  let red = 0;
  const seen = new Map<string, string>();
  for (const event of cases) {
    const payload = event.payload as { id?: unknown; status?: unknown };
    if (typeof payload.id !== "string") continue;
    if (payload.status === "green" || payload.status === "red") seen.set(payload.id, payload.status);
  }
  for (const status of seen.values()) {
    if (status === "green") green += 1;
    else red += 1;
  }

  return {
    session: view.session,
    generatedAt: new Date(now).toISOString(),
    lastSeq: last?.seq ?? 0,
    activity: currentActivityText(activity),
    activityKind: String((activity as { kind?: unknown }).kind ?? "idle"),
    lastEventAgeMs: last ? Math.max(0, now - Date.parse(last.ts)) : 0,
    agent: String(view.agent),
    ...(view.error ? { error: view.error } : {}),
    // A run can look healthy and decide nothing for hours; the alerts are
    // where that shows up, so they travel with the state rather than being
    // something only the terminal computes.
    alerts: derivedAlerts(view).slice(0, 6).map((alert) => ({ text: alert.text, bad: alert.bad })),
    model: {
      ...(text(usage?.provider) ? { provider: String(usage?.provider) } : {}),
      ...(text(usage?.model) ? { model: String(usage?.model) } : {}),
      ...(text(usage?.route) ? { route: String(usage?.route) } : {}),
      ...(text(usage?.auth) ? { auth: String(usage?.auth) } : {}),
      inputTokens: num(usage?.input_tokens),
      outputTokens: num(usage?.output_tokens),
      contextUsed: num(usage?.context_used),
      contextWindow: num(usage?.context_window),
      hitRatio: num(usage?.hit_ratio),
    },
    work: {
      ...(text(work.goal) ? { goal: String(work.goal) } : {}),
      ...(text(work.agentStatus) ? { status: String(work.agentStatus) } : {}),
      ...(text(work.route) ? { route: String(work.route) } : {}),
      wave: num(work.heungWave),
      ...(text(work.intending) ? { next: String(work.intending) } : {}),
      todos: todos.slice(0, 60),
      green,
      red,
    },
    ...(view.host
      ? {
        host: {
          cpuPct: num((view.host as unknown as Record<string, unknown>).cpu_pct),
          rssBytes: num((view.host as unknown as Record<string, unknown>).rss_bytes),
        },
      }
      : {}),
    turns: turnsFrom(events),
    events: events.slice(-EVENT_LIMIT).map((event) => ({
      seq: event.seq,
      ts: event.ts,
      name: event.name,
      summary: eventSummary(event),
    })),
    tools: (view.tools as unknown as Record<string, unknown>[]).slice(0, TOOL_LIMIT).map((tool) => ({
      name: String(tool.name ?? "?"),
      calls: num(tool.calls) ?? 0,
    })),
  };
}
