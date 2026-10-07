import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { toolArgumentsDigest } from "./tool-loop.ts";

/**
 * The Pi stream contract at the dependency boundary (#224 F1, S1).
 *
 * Pi 0.84.1's agent loop awaits the whole assistant stream and only then
 * executes the message's tool calls; while it streams, the loop emits
 * `message_update` events carrying the provider adapter's
 * `AssistantMessageEvent`s. A `toolcall_end` is the adapter's word that a
 * tool-call block closed — for some adapters that is a real boundary that
 * precedes the rest of the message, for others it is emitted only when the
 * whole stream has ended. Its `arguments` are ALWAYS a salvage parse
 * (`parseStreamingJson`), so a block cut by the output limit still "ends"
 * with arguments that parse. So this adapter admits an identity only when
 *
 *   1. the provider api is `final_call_capable` — proven by the recorded
 *      stream fixtures in tests/fixtures/pi-stream/*.json run through the
 *      actual pi-ai adapters (tests/early-read-s1-stream-contract.test.ts):
 *      a tool-call block closes, with a stable id and complete arguments,
 *      before the message's own end;
 *   2. the block is CONFIRMED: a later stream event names a later content
 *      index, so the stream demonstrably continued past the block — a
 *      block cut by `max_tokens` is followed by the message's end, never by
 *      another block, and a call that is the message's last block is
 *      executed by Pi immediately after `message_end` anyway (no overlap to
 *      gain, no early start needed);
 *   3. the committed assistant (at `message_end`, stop reason `toolUse` or
 *      `stop`) still carries the exact call at the same content index and
 *      the same ordinal, with the same id, name and args digest; a
 *      length/error/aborted stop revokes every identity of the attempt.
 *
 * A duplicate `toolcall_end` for one index, one id ending at two indexes,
 * or a delta after an end (a revision) makes the identity unstable: it and
 * its twin are revoked for the attempt. Nothing here executes anything; it
 * is a pure, deterministic classifier over the event sequence.
 */

export interface FinalCallCapability {
  readonly capable: boolean;
  readonly reason: string;
}

const NO_FIXTURE: FinalCallCapability = Object.freeze({
  capable: false,
  reason: "no recorded stream fixture characterises this api; ordinary Pi execution",
});

/** What the recorded fixtures proved, per pi-ai api (S1). */
export const FINAL_CALL_CAPABILITIES: Readonly<Record<string, FinalCallCapability>> = Object.freeze({
  "anthropic-messages": Object.freeze({
    capable: true,
    reason: "content_block_stop closes a tool_use block (toolcall_end) before message_delta/message_stop; recorded fixture tests/fixtures/pi-stream/anthropic-messages.json",
  }),
  "openai-responses": Object.freeze({
    capable: true,
    reason: "response.output_item.done closes a function_call (toolcall_end) before response.completed; recorded fixture tests/fixtures/pi-stream/openai-responses.json",
  }),
  "openai-codex-responses": Object.freeze({
    capable: true,
    reason: "response.output_item.done closes a function_call (toolcall_end) before response.completed; recorded fixture tests/fixtures/pi-stream/openai-codex-responses.json",
  }),
  "openai-completions": Object.freeze({
    capable: false,
    reason: "tool-call blocks are finalised only after the stream ends (finish_reason); toolcall_end never precedes the message end; recorded fixture tests/fixtures/pi-stream/openai-completions.json",
  }),
});

export function finalCallCapability(api: string): FinalCallCapability {
  return FINAL_CALL_CAPABILITIES[api] ?? NO_FIXTURE;
}

export interface ReceivedBoundary {
  readonly contentIndex: number;
  /** Position among the message's tool-call blocks — Pi's execution order. */
  readonly ordinal: number;
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly argsDigest: string;
}

export type BoundaryRevocationReason = "duplicate" | "revised" | "unstable_identity" | "absent" | "stream_length" | "stream_error" | "stream_aborted";

export type BoundaryDecision =
  | { readonly kind: "confirmed"; readonly boundary: ReceivedBoundary }
  | { readonly kind: "revoked"; readonly contentIndex: number; readonly id: string; readonly reason: BoundaryRevocationReason };

export interface CommitResult {
  readonly committed: readonly ReceivedBoundary[];
  readonly revoked: ReadonlyArray<{ readonly contentIndex: number; readonly id: string; readonly reason: BoundaryRevocationReason }>;
  /** Blocks that ended but were never confirmed by a later event (the
   * message's last block): never a lease; Pi runs them ordinarily. */
  readonly unconfirmed: readonly ReceivedBoundary[];
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function toolCallOrdinal(content: readonly unknown[], index: number): number {
  let ordinal = 0;
  for (let i = 0; i < index && i < content.length; i += 1) {
    const block = content[i] as { type?: unknown } | undefined;
    if (block && block.type === "toolCall") ordinal += 1;
  }
  return ordinal;
}

export class StreamBoundaryTracker {
  private readonly ended = new Map<number, ReceivedBoundary>();
  private readonly confirmed = new Set<number>();
  private readonly poisoned = new Set<number>();
  private readonly idsByIndex = new Map<string, number>();
  private highestIndex = -1;

  constructor(private readonly capability: FinalCallCapability) {}

  get capable(): boolean {
    return this.capability.capable;
  }

  /** Feed one provider stream event; the decisions it yields, in order. */
  observe(event: AssistantMessageEvent): BoundaryDecision[] {
    if (!this.capability.capable) return [];
    const decisions: BoundaryDecision[] = [];
    if (event.type === "start" || event.type === "done" || event.type === "error") return decisions;
    const index = event.contentIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return decisions;
    // A later index confirms every ended, unrevoked block before it.
    if (index > this.highestIndex) {
      for (const [ended, boundary] of [...this.ended.entries()].sort((a, b) => a[0] - b[0])) {
        if (ended < index && !this.confirmed.has(ended) && !this.poisoned.has(ended)) {
          this.confirmed.add(ended);
          decisions.push({ kind: "confirmed", boundary });
        }
      }
      this.highestIndex = index;
    }
    if (event.type === "toolcall_end") {
      const call = event.toolCall;
      const args = plainRecord(call.arguments);
      const inPartial = event.partial.content[index] as { type?: unknown; id?: unknown; name?: unknown } | undefined;
      const consistent = inPartial !== undefined && inPartial.type === "toolCall" && inPartial.id === call.id && inPartial.name === call.name;
      if (this.ended.has(index) || this.poisoned.has(index)) {
        decisions.push(...this.revoke(index, call.id, "duplicate"));
        return decisions;
      }
      const twin = this.idsByIndex.get(call.id);
      if (typeof call.id !== "string" || call.id.length === 0 || typeof call.name !== "string" || call.name.length === 0 || args === undefined || !consistent) {
        this.poisoned.add(index);
        decisions.push({ kind: "revoked", contentIndex: index, id: typeof call.id === "string" ? call.id : "", reason: "unstable_identity" });
        return decisions;
      }
      if (twin !== undefined && twin !== index) {
        this.poisoned.add(index);
        decisions.push(...this.revoke(twin, call.id, "duplicate"));
        decisions.push({ kind: "revoked", contentIndex: index, id: call.id, reason: "duplicate" });
        return decisions;
      }
      this.idsByIndex.set(call.id, index);
      this.ended.set(index, {
        contentIndex: index,
        ordinal: toolCallOrdinal(event.partial.content, index),
        id: call.id,
        name: call.name,
        args,
        argsDigest: toolArgumentsDigest(args),
      });
      return decisions;
    }
    if ((event.type === "toolcall_delta" || event.type === "toolcall_start") && (this.ended.has(index) || this.poisoned.has(index))) {
      const boundary = this.ended.get(index);
      decisions.push(...this.revoke(index, boundary?.id ?? "", "revised"));
    }
    return decisions;
  }

  /** The final assistant: what stays committed, what is revoked, and what
   * ended without confirmation (never a lease). */
  commit(message: AssistantMessage): CommitResult {
    const revoked: Array<{ contentIndex: number; id: string; reason: BoundaryRevocationReason }> = [];
    const committed: ReceivedBoundary[] = [];
    const unconfirmed: ReceivedBoundary[] = [];
    const stop = message.stopReason;
    const terminalFailure: BoundaryRevocationReason | undefined = stop === "length" ? "stream_length"
      : stop === "error" ? "stream_error" : stop === "aborted" ? "stream_aborted" : undefined;
    for (const [index, boundary] of [...this.ended.entries()].sort((a, b) => a[0] - b[0])) {
      if (this.poisoned.has(index)) continue;
      if (!this.confirmed.has(index)) { unconfirmed.push(boundary); continue; }
      if (terminalFailure !== undefined) { revoked.push({ contentIndex: index, id: boundary.id, reason: terminalFailure }); continue; }
      const block = message.content[index] as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown } | undefined;
      if (block === undefined || block.type !== "toolCall") { revoked.push({ contentIndex: index, id: boundary.id, reason: "absent" }); continue; }
      const args = plainRecord(block.arguments);
      const same = block.id === boundary.id && block.name === boundary.name && args !== undefined
        && toolArgumentsDigest(args) === boundary.argsDigest
        && toolCallOrdinal(message.content, index) === boundary.ordinal;
      if (!same) { revoked.push({ contentIndex: index, id: boundary.id, reason: "revised" }); continue; }
      committed.push(boundary);
    }
    return { committed, revoked, unconfirmed };
  }

  private revoke(index: number, id: string, reason: BoundaryRevocationReason): BoundaryDecision[] {
    const boundary = this.ended.get(index);
    this.poisoned.add(index);
    this.ended.delete(index);
    this.confirmed.delete(index);
    return [{ kind: "revoked", contentIndex: index, id: boundary?.id ?? id, reason }];
  }
}
