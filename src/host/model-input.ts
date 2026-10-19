import type { EventLog } from "./event-log.ts";
import type { EventRecord } from "./schema.ts";
import { containsSecret, observedSecretDigests, redactText } from "./redact.ts";

export interface SafeModelInput {
  text: string;
  redacted: boolean;
}

/**
 * Sanitize operator-authored text once, before it can diverge into a durable
 * surface and a model request. Span redaction preserves the useful parts of
 * the instruction; the length-only fallback keeps the final EventLog guard
 * fail-closed if a future secret pattern cannot be removed safely.
 */
export function safeModelInputText(text: string): SafeModelInput {
  if (!containsSecret(text)) {
    return { text, redacted: false };
  }
  const redacted = redactText(text);
  return {
    text: containsSecret(redacted)
      ? `[redacted operator input ${text.length} chars]`
      : redacted,
    redacted: true,
  };
}

/** Record that input was masked without retaining the matched span. */
export function appendInputRedactionNotice(
  log: EventLog,
  input: { surface: string; chars: number },
): void {
  log.append({
    kind: "observe",
    name: "security/input_redacted",
    payload: { surface: input.surface, chars: input.chars },
  });
}

/**
 * Who a user/message actually came from.
 *
 * Every turn the harness takes is recorded as a `user/message`, because that
 * is what the transcript contract calls the thing sent to the model. But the
 * board reads the same events, and there it matters enormously: an operator
 * interrupting an unattended run is a landmark, and the harness re-prompting
 * itself for the 863rd time is not. Without this field the two were the same
 * event, and the timeline drew a run's own prompts as operator intervention.
 */
export type UserMessageSource = "operator" | "harness";

/** Whether a recorded user/message belongs on the operator-facing stream.
 * Logs from before `source` existed carry no field and are treated as operator
 * input; only an explicit non-operator label (for example harness) is hidden. */
export function isOperatorVisibleUserMessage(payload: Record<string, unknown>): boolean {
  const source = payload.source;
  if (source === undefined) {
    return true;
  }
  return source === "operator";
}

function gateOperatorReuseBoundarySeq(log: EventLog): number {
  let bound = 0;
  for (const event of log.events) {
    if (event.name === "assistant/message" || event.name === "work/gate") {
      bound = Math.max(bound, event.seq);
    }
  }
  return bound;
}

/** Record the operator order for this turn; reuse only within the current turn. */
export function ensureOperatorOrderSurface(log: EventLog, order: string): EventRecord {
  const orderText = safeModelInputText(order).text;
  const afterSeq = gateOperatorReuseBoundarySeq(log);
  const existing = [...log.events].reverse().find((event) => {
    if (event.seq <= afterSeq) {
      return false;
    }
    if (event.name !== "user/message" || event.payload.source !== "operator") {
      return false;
    }
    return event.payload.text === orderText;
  });
  if (existing) {
    return existing;
  }
  appendUserMessage(log, order, "operator");
  return log.events.at(-1)!;
}

/** Record the operator order once per work run; later decompose/plan paths reuse it. */
export function recordOperatorOrderForWorkRun(
  log: EventLog,
  order: string,
  recorded?: EventRecord,
): EventRecord {
  if (recorded !== undefined) {
    return recorded;
  }
  return ensureOperatorOrderSurface(log, order);
}

/**
 * The only ordinary user/message writer. The returned string is the exact
 * text callers must send to the model, preserving the transcript contract.
 *
 * `source` defaults to `harness` because that is the path that dominates and
 * the safe direction to be wrong in: a board that under-claims an operator
 * moment is readable, and one that invents 863 of them is not.
 */
export function appendUserMessage(
  log: EventLog,
  text: string,
  source: UserMessageSource = "harness",
): string {
  const { input, safe } = buildUserMessage(text, source);
  log.append(input);
  if (safe.redacted) {
    appendInputRedactionNotice(log, { surface: "user/message", chars: text.length });
  }
  return safe.text;
}

/** The exact durable identity of one recorded user/message row. */
export interface DurableUserMessage {
  /** The safe text the model must be sent — the transcript contract. */
  readonly text: string;
  readonly seq: number;
  readonly hash: string;
}

/**
 * The durable variant of the one ordinary user/message writer, for input
 * whose authority crosses a process boundary (an owned work child): the row
 * is fsynced before the caller can publish its identity, and the exact row
 * comes back so a parent can verify what the model will see. Ordinary
 * callers keep appendUserMessage and its behavior unchanged.
 */
export function appendUserMessageDurable(
  log: EventLog,
  text: string,
  source: UserMessageSource = "harness",
): DurableUserMessage {
  const { input, safe } = buildUserMessage(text, source);
  const record = log.appendDurable(input);
  if (safe.redacted) {
    appendInputRedactionNotice(log, { surface: "user/message", chars: text.length });
  }
  return { text: safe.text, seq: record.seq, hash: record.hash };
}

function buildUserMessage(text: string, source: UserMessageSource): {
  input: { kind: "surface"; name: "user/message"; payload: Record<string, unknown> };
  safe: SafeModelInput;
} {
  const safe = safeModelInputText(text);
  // What the operator (or the harness) hands the model is READ by the session,
  // never authored by it. Record the digests of any credential values in the
  // RAW text so the model cannot author one by quoting it back (D36).
  const observed = observedSecretDigests(text);
  return {
    input: {
      kind: "surface",
      name: "user/message",
      payload: { text: safe.text, source, ...(observed.length === 0 ? {} : { observed_secret_digests: observed }) },
    },
    safe,
  };
}
