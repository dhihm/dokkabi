import type { EventLog } from "./event-log.ts";
import { appendProviderContribution } from "./provider-input.ts";
import {
  contributionKey,
  deliveredContributionKeys,
  prepareContribution,
  type ContributionMessage,
  type ModelInputBoundary,
} from "./model-input-contributions.ts";

/** Preserve actual operator cancellation as host data at the ordinary loop
 * boundary. Failed assistant messages can be omitted by provider adapters;
 * their user requests must not thereby look like outstanding work. */
export function contributeCancelledTurn(log: EventLog, boundary: ModelInputBoundary): ContributionMessage | undefined {
  if (log.isReadOnly) return undefined;
  const events = log.events;
  let at = events.length - 1;
  while (at >= 0) {
    const row = events[at]!;
    if (row.name === "agent/status" && row.kind === "observe"
      && row.payload.status === "cancelled" && row.payload.error === "operator_abort") break;
    at -= 1;
  }
  if (at < 0) return undefined;
  const cancelled = events[at]!;
  const key = contributionKey(["turn-lifecycle", 1, cancelled.hash]);
  if (deliveredContributionKeys(log).has(key)) return undefined;
  let user;
  for (let i = at - 1; i >= 0; i -= 1) {
    if (events[i]!.name === "user/message" && events[i]!.kind === "surface") {
      user = events[i];
      break;
    }
  }
  // An idle abort never writes a cancelled status. Even a corrupt or partial
  // lifecycle must not invent an operator request that was not recorded.
  if (!user) throw new Error("turn-context: cancellation has no recorded operator input");
  const text = `The operator cancelled the prior turn associated with user/message #${user.seq} `
    + `(host agent/status #${cancelled.seq}, operator_abort). The specifically referenced earlier request `
    + "remains historical context and is no longer outstanding work. This cancellation does not cancel "
    + "later operator messages. An explicitly renewed request is a new task. Cancellation implies neither "
    + "successful completion nor rollback of effects already performed.";
  const prepared = prepareContribution({
    contributors: [{
      source: "turn-lifecycle", kind: "lifecycle", heading: "Recorded operator cancellation",
      offer: () => ({ items: [{ key, text, freshness: "recorded", facts: {
        cancellation_seq: cancelled.seq, cancellation_hash: cancelled.hash,
        user_seq: user.seq, user_hash: user.hash,
      } }] }),
    }],
    boundary,
    delivered: new Set(),
  });
  if (!prepared) throw new Error("turn-context: cancellation notice could not be prepared");
  const message: ContributionMessage = { role: "user", content: [{ type: "text", text: prepared.text }], timestamp: Date.now() };
  try {
    // Required lifecycle semantics use the existing atomic surface/transcript
    // writer. Optional advisory-source append failures remain independent.
    appendProviderContribution(log, message, prepared.payload);
  } catch {
    throw new Error("turn-context: cancellation notice is not durable");
  }
  return message;
}
