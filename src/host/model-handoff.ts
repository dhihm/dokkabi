import { CONTEXT_SOFT_CAP_TOKENS, estimateMessagesTokensPublic } from "./compaction.ts";

export interface FailoverHandoff<T> {
  messages: T[];
  droppedFailedAssistant: boolean;
}

export interface FailoverHandoffV1<T> extends FailoverHandoff<T> {
  continuity: "continue" | "checkpoint";
  resumable: boolean;
  reason?: "unmatched_tool_call" | "checkpoint_missing";
}

export type FailoverHandoffOptions<T> =
  | { continuity: "continue" }
  | { continuity: "checkpoint"; checkpoint?: T };

export type ManualHandoffFailureReason =
  | "agent_busy"
  | "carry_confirmation_required"
  | "incomplete_tool_pair"
  | "target_window_exhausted"
  | "target_window_unknown"
  | "transcript_not_persisted";

export interface ManualHandoffMetrics {
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  droppedMessages: number;
  truncated: boolean;
  tokenScale: number;
  prefixTokens: number;
}

export interface ManualHandoffSuccess<T> extends ManualHandoffMetrics {
  ok: true;
  messages: T[];
}

export interface ManualHandoffFailure extends ManualHandoffMetrics {
  ok: false;
  reason: ManualHandoffFailureReason;
}

export type ManualHandoffResult<T> = ManualHandoffSuccess<T> | ManualHandoffFailure;

interface HandoffMessage {
  role: string;
  content?: unknown;
}

const MANUAL_HANDOFF_TARGET_SHARE = 0.75;
export const MANUAL_HANDOFF_SLIM_SHARE = 0.25;
/** Advertised windows above this are routinely unverified (stealth catalogs,
 * multi-backend gateways); a carry this large met live HTTP 400s at ~366k on
 * an advertised-1M model. Below it, real serving limits rarely bite. */
export const HANDOFF_CAUTION_TOKENS = CONTEXT_SOFT_CAP_TOKENS;

/** A bare manual switch this large must name carry or slim explicitly. */
export function manualHandoffCaution(afterTokens: number): boolean {
  return afterTokens > HANDOFF_CAUTION_TOKENS;
}

function failedAssistant(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { role?: unknown; stopReason?: unknown };
  return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

/** A route handoff happens only after the agent is idle. At that boundary the
 * sole unsafe suffix is a failed/aborted partial assistant message. Completed
 * tool call/result pairs remain intact and are never replayed by this helper. */
export function prepareFailoverMessages<T>(messages: readonly T[]): FailoverHandoff<T> {
  if (messages.length === 0 || !failedAssistant(messages[messages.length - 1])) {
    return { messages: [...messages], droppedFailedAssistant: false };
  }
  return { messages: messages.slice(0, -1), droppedFailedAssistant: true };
}

/** Prepare the exact model-visible segment for a cross-route transition.
 * Continue mode admits only a transcript whose tool calls all have one
 * matching result. Checkpoint mode receives a host-derived durable message and
 * carries no free-form output or provider-specific tool fragments from the
 * failed segment. */
export function prepareFailoverHandoff<T>(
  messages: readonly T[],
  options: FailoverHandoffOptions<T>,
): FailoverHandoffV1<T> {
  const prepared = prepareFailoverMessages(messages);
  if (options.continuity === "checkpoint") {
    if (options.checkpoint === undefined) {
      return {
        messages: [],
        droppedFailedAssistant: prepared.droppedFailedAssistant,
        continuity: "checkpoint",
        resumable: false,
        reason: "checkpoint_missing",
      };
    }
    return {
      messages: [options.checkpoint],
      droppedFailedAssistant: prepared.droppedFailedAssistant,
      continuity: "checkpoint",
      resumable: true,
    };
  }
  if (!completeToolPairs(prepared.messages)) {
    return {
      ...prepared,
      continuity: "continue",
      resumable: false,
      reason: "unmatched_tool_call",
    };
  }
  const lastRole = roleOf(prepared.messages.at(-1));
  return {
    ...prepared,
    continuity: "continue",
    resumable: lastRole === "user" || lastRole === "toolResult",
    ...(lastRole === "user" || lastRole === "toolResult" ? {} : { reason: "unmatched_tool_call" as const }),
  };
}

/** Prepare a manual route switch without mutating either route. Full context
 * is preferred. Under pressure, only an older range ending at a user-message
 * boundary is removed, preserving the original goal, the latest complete
 * turn, and every tool-call/result pair. The 75% landing target leaves room
 * for the next operator message and completion on the destination model. */
export function prepareManualHandoff<T extends HandoffMessage>(
  messages: readonly T[],
  options: {
    contextWindow: number;
    tokenScale?: number;
    prefixTokens?: number;
    /** Landing share of the destination window (default 0.75; slim 0.25). */
    budgetShare?: number;
    /** Host-derived durable state appended to the truncation marker, so a
     * slimmed destination inherits the checkpoint instead of only a count. */
    summaryText?: string;
  },
): ManualHandoffResult<T> {
  const requestedScale = options.tokenScale;
  const tokenScale = typeof requestedScale === "number" && Number.isFinite(requestedScale) && requestedScale > 1
    ? requestedScale
    : 1;
  const prefixTokens = typeof options.prefixTokens === "number" && Number.isFinite(options.prefixTokens)
    ? Math.max(0, Math.ceil(options.prefixTokens))
    : 0;
  const messageTokensOf = (values: readonly T[]): number =>
    Math.ceil(estimateMessagesTokensPublic(values) * tokenScale);
  const contextTokensOf = (values: readonly T[]): number =>
    Math.ceil((prefixTokens + estimateMessagesTokensPublic(values)) * tokenScale);
  const beforeMessages = messages.length;
  const beforeTokens = contextTokensOf(messages);
  const prepared = prepareFailoverMessages(messages);
  const droppedFailedAssistant = beforeMessages - prepared.messages.length;
  const base = {
    beforeMessages,
    beforeTokens,
    tokenScale,
    prefixTokens,
  };
  if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
    return manualFailure(base, "target_window_unknown");
  }
  if (!completeToolPairs(prepared.messages)) {
    return manualFailure(base, "incomplete_tool_pair");
  }

  const share = typeof options.budgetShare === "number" && options.budgetShare > 0 && options.budgetShare <= 1
    ? options.budgetShare
    : MANUAL_HANDOFF_TARGET_SHARE;
  const budget = Math.max(1, Math.floor(options.contextWindow * share));
  const preparedTokens = contextTokensOf(prepared.messages);
  if (preparedTokens <= budget) {
    return {
      ok: true,
      messages: [...prepared.messages],
      ...base,
      afterMessages: prepared.messages.length,
      afterTokens: preparedTokens,
      droppedMessages: droppedFailedAssistant,
      truncated: droppedFailedAssistant > 0,
    };
  }
  if (prepared.messages.length < 2) {
    return manualFailure(base, "target_window_exhausted");
  }

  // A boundary starts a new operator turn. Keeping the suffix from there
  // preserves the last turn even when the protected first goal is very large.
  const boundaries: number[] = [];
  for (let index = 1; index < prepared.messages.length; index += 1) {
    if (roleOf(prepared.messages[index]) === "user") boundaries.push(index);
  }
  // Pass 1 carries the durable checkpoint with the drop count — worth losing
  // one more old turn for, since it is precisely the state a slimmed
  // destination needs. Pass 2 (count-only) exists so a destination window too
  // tight even for the checkpoint can still land the handoff.
  const summaries = options.summaryText ? [options.summaryText, undefined] : [undefined];
  for (const summary of summaries) {
    for (const boundary of boundaries) {
      const droppedTokens = messageTokensOf(prepared.messages.slice(1, boundary));
      const countLine = `[handoff summary] dropped ${boundary - 1} older messages (~${droppedTokens} tokens) to fit the target context; the original goal and recent state are retained.`;
      const marker = {
        role: "user",
        content: [{ type: "text", text: summary === undefined ? countLine : `${countLine}\n${summary}` }],
      } as T;
      const candidate = [prepared.messages[0]!, marker, ...prepared.messages.slice(boundary)];
      if (!completeToolPairs(candidate)) continue;
      const afterTokens = contextTokensOf(candidate);
      if (afterTokens > budget) continue;
      const carriedOriginals = 1 + prepared.messages.length - boundary;
      return {
        ok: true,
        messages: candidate,
        ...base,
        afterMessages: candidate.length,
        afterTokens,
        droppedMessages: beforeMessages - carriedOriginals,
        truncated: true,
      };
    }
  }
  return manualFailure(base, "target_window_exhausted");
}

function manualFailure(
  base: Pick<ManualHandoffMetrics, "beforeMessages" | "beforeTokens" | "tokenScale" | "prefixTokens">,
  reason: ManualHandoffFailureReason,
): ManualHandoffFailure {
  return {
    ok: false,
    reason,
    ...base,
    afterMessages: 0,
    afterTokens: 0,
    droppedMessages: 0,
    truncated: false,
  };
}

function completeToolPairs(messages: readonly unknown[]): boolean {
  const pending = new Set<string>();
  const completed = new Set<string>();
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const value = message as { role?: unknown; content?: unknown; toolCallId?: unknown };
    if (value.role === "assistant" && Array.isArray(value.content)) {
      for (const part of value.content) {
        if (
          typeof part === "object"
          && part !== null
          && (part as { type?: unknown }).type === "toolCall"
          && typeof (part as { id?: unknown }).id === "string"
        ) {
          const id = (part as { id: string }).id;
          if (pending.has(id) || completed.has(id)) return false;
          pending.add(id);
        }
      }
    }
    if (value.role === "toolResult" && typeof value.toolCallId === "string") {
      if (!pending.delete(value.toolCallId) || completed.has(value.toolCallId)) return false;
      completed.add(value.toolCallId);
    }
  }
  return pending.size === 0;
}

function roleOf(message: unknown): unknown {
  return typeof message === "object" && message !== null ? (message as { role?: unknown }).role : undefined;
}
