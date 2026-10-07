import type { EventRecord } from "../host/schema.ts";

/**
 * Transcript projection for the desktop agent console.
 *
 * The window is a projection of the session EventLog (constitution 6):
 * every card below is derived from recorded events, in event order, and a
 * field no event carries renders as missing — never invented. The projection
 * is a pure function so the same log always yields the identical card list,
 * which is what lets a snapshot plus append notifications stay consistent.
 *
 * Surface events become cards the operator reads (notes, assistant replies,
 * tool result text). Observe events only enrich them (tool duration, error
 * state); effect events surface solely as approval lifecycle, which the
 * operator themselves resolved or must resolve.
 */

export type TranscriptCard =
  | { kind: "note"; seq: number; ts: string; text: string }
  | {
    kind: "assistant";
    seq: number;
    ts: string;
    text: string;
    thinking?: string;
    stop?: string;
  }
  | {
    kind: "tool";
    seq: number;
    ts: string;
    id: string;
    tool: string;
    argHint?: string;
    resultText?: string;
    durationMs: number | "missing";
    error: boolean;
  }
  | {
    kind: "approval";
    seq: number;
    ts: string;
    requestId: string;
    approvalKind: string;
    target?: string;
    detail?: string;
    state: "requested" | "resolved";
  }
  | { kind: "system"; seq: number; ts: string; event: string; text: string };

/** Sessions lifecycle lines worth a quiet system card in the transcript. */
const SYSTEM_EVENTS: Readonly<Record<string, string>> = {
  "session/open": "session opened",
  "session/fresh_start": "fresh start — prior context archived",
  "session/resume": "session resumed",
  "session/reseed": "context reseeded under a new prefix",
};

/**
 * The host's own terminal work facts (constitution 2: what the agent did is
 * an observe event). Only OBSERVE rows earn these cards — a surface or
 * effect row carrying the same name is not a host verdict. The card text
 * opens with an explicit Host label so downstream consumers can tell the
 * host's recorded summary apart from any model narrative, and every field
 * is a bounded recorded primitive; anything absent, malformed or unsafe to
 * print inline renders as "unknown" and nothing is ever promoted.
 *
 * ONE authoritative summary is projected per recorded work/run_result
 * terminal. A work/operator_report never projects a card of its own: a
 * compatible report preceding the terminal may contribute only its bounded
 * prose as run details inside that terminal's summary, and a report without
 * a terminal (or one whose recorded status disagrees with the terminal)
 * contributes nothing — two blocked summaries for one blocked run would
 * each be half the truth.
 */
const HOST_RUN_RESULT_EVENT = "work/run_result";
const HOST_OPERATOR_REPORT_EVENT = "work/operator_report";
const HOST_RUN_RESULT_LABEL = "Host work result";
const HOST_TOKEN_MAX_CHARS = 64;
const HOST_REPORT_TEXT_MAX_CHARS = 240;

/**
 * A recorded value safe to print as one field of a host card: a string with
 * no control characters, short enough to stay bounded, and free of
 * the comma that separates fields (a value carrying one could forge a
 * neighbour field, so it fails closed to unknown). Unsafe values are never
 * repaired into success.
 */
const recordedHostToken = (value: unknown): string | undefined => {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value.length > 0 && value.length <= HOST_TOKEN_MAX_CHARS && !value.includes(",")
    ? value
    : undefined;
};

/** A recorded integer field (exit codes); anything else is unknown. */
const recordedHostInt = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;

/** Bounded recorded prose: control characters stripped and length capped. */
const recordedHostText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const safe = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (safe.length === 0) return undefined;
  return safe.length <= HOST_REPORT_TEXT_MAX_CHARS
    ? safe
    : `${safe.slice(0, HOST_REPORT_TEXT_MAX_CHARS)}…`;
};

/**
 * A pending operator report: the bounded prose the host recorded for the run
 * that has not ended yet. It pairs with the NEXT terminal only while it is
 * the nearest report (a newer report replaces it) and only when both record
 * the same status — anything else cannot be attributed to that terminal and
 * fails closed to no details.
 */
interface PendingOperatorReport {
  status: string | undefined;
  text: string | undefined;
}

const hostRunResultText = (payload: unknown, report: PendingOperatorReport | null): string => {
  const fields = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const acceptance =
    fields.accepted === true
      ? "accepted"
      : fields.accepted === false
        ? "not accepted"
        : "unknown";
  const terminalStatus = recordedHostToken(fields.status);
  const details =
    report !== null &&
    report.text !== undefined &&
    report.status !== undefined &&
    terminalStatus !== undefined &&
    report.status === terminalStatus
      ? report.text
      : undefined;
  return (
    `${HOST_RUN_RESULT_LABEL} — status: ${terminalStatus ?? "unknown"},`
    + ` outcome: ${recordedHostToken(fields.outcome) ?? "unknown"},`
    + ` acceptance: ${acceptance},`
    + ` exit code: ${recordedHostInt(fields.exit_code) ?? "unknown"},`
    + ` stop reason: ${recordedHostToken(fields.stop_reason) ?? "unknown"}`
    + (details !== undefined ? ` — ${details}` : "")
  );
};

const APPROVAL_REQUESTED = /\/approval_requested$/;
const APPROVAL_RESOLVED = /\/approval_resolved$/;

export function projectTranscript(events: readonly EventRecord[]): TranscriptCard[] {
  // Tool cards merge by call id: tool/start opens the card, tool/result
  // attaches the recorded surface text, tool/end attaches duration and error.
  const tools = new Map<string, Extract<TranscriptCard, { kind: "tool" }>>();
  const approvals = new Map<
    string,
    Extract<TranscriptCard, { kind: "approval" }> & { seq: number }
  >();
  const resolved = new Set<string>();
  const cards: TranscriptCard[] = [];
  let pendingOperatorReport: PendingOperatorReport | null = null;

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.name === "user/message" && typeof payload.text === "string") {
      cards.push({ kind: "note", seq: event.seq, ts: event.ts, text: payload.text });
      continue;
    }
    if (event.name === "assistant/message" && typeof payload.text === "string") {
      cards.push({
        kind: "assistant",
        seq: event.seq,
        ts: event.ts,
        text: payload.text,
        ...(typeof payload.thinking === "string" ? { thinking: payload.thinking } : {}),
        ...(typeof payload.stop === "string" ? { stop: payload.stop } : {}),
      });
      continue;
    }
    if (event.name === "tool/start" && typeof payload.id === "string") {
      const card: Extract<TranscriptCard, { kind: "tool" }> = {
        kind: "tool",
        seq: event.seq,
        ts: event.ts,
        id: payload.id,
        tool: typeof payload.name === "string" ? payload.name : "missing",
        ...(typeof payload.arg_hint === "string" ? { argHint: payload.arg_hint } : {}),
        durationMs: "missing",
        error: false,
      };
      tools.set(payload.id, card);
      cards.push(card);
      continue;
    }
    if (event.name === "tool/result") {
      const id = typeof payload.id === "string" ? payload.id : undefined;
      const card = id ? tools.get(id) : undefined;
      if (card && typeof payload.text === "string") {
        card.resultText = payload.text;
      }
      continue;
    }
    if (event.name === "tool/end" && typeof payload.id === "string") {
      const card = tools.get(payload.id);
      if (card) {
        card.durationMs = typeof payload.duration_ms === "number" ? payload.duration_ms : "missing";
        card.error = payload.error === true;
      }
      continue;
    }
    if (APPROVAL_REQUESTED.test(event.name) && typeof payload.request_id === "string") {
      const card: Extract<TranscriptCard, { kind: "approval" }> & { seq: number } = {
        kind: "approval",
        seq: event.seq,
        ts: event.ts,
        requestId: payload.request_id,
        approvalKind: event.name.slice(0, event.name.indexOf("/")),
        ...(typeof payload.target === "string" ? { target: payload.target } : {}),
        ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
        state: "requested",
      };
      approvals.set(payload.request_id, card);
      cards.push(card);
      continue;
    }
    if (APPROVAL_RESOLVED.test(event.name) && typeof payload.request_id === "string") {
      resolved.add(payload.request_id);
      const card = approvals.get(payload.request_id);
      if (card) card.state = "resolved";
      continue;
    }
    if (event.kind === "observe" && event.name === HOST_OPERATOR_REPORT_EVENT) {
      // Never a card of its own: the report's prose rides with the terminal
      // that ends this run, or is not shown at all. A newer report replaces
      // an older pending one — only the latest recorded summary is the run's.
      pendingOperatorReport = {
        status: recordedHostToken((payload as Record<string, unknown>).status),
        text: recordedHostText((payload as Record<string, unknown>).text),
      };
      continue;
    }
    if (event.kind === "observe" && event.name === HOST_RUN_RESULT_EVENT) {
      cards.push({
        kind: "system",
        seq: event.seq,
        ts: event.ts,
        event: event.name,
        text: hostRunResultText(payload, pendingOperatorReport),
      });
      // A report precedes at most the one terminal that ends its run.
      pendingOperatorReport = null;
      continue;
    }
    const system = SYSTEM_EVENTS[event.name];
    if (system && event.kind !== "effect") {
      cards.push({ kind: "system", seq: event.seq, ts: event.ts, event: event.name, text: system });
    }
  }

  // A request that resolved before it was ever projected (snapshot raced an
  // approval relay) still deserves its resolved state.
  for (const card of approvals.values()) {
    if (resolved.has(card.requestId)) card.state = "resolved";
  }
  return cards;
}

/** Cards that arrived after `fromSeq` — the append-notification payload. */
export function transcriptCardsAfter(cards: readonly TranscriptCard[], fromSeq: number): TranscriptCard[] {
  return cards.filter((card) => card.seq > fromSeq);
}
