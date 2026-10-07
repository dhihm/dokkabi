import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EventRecord } from "../host/schema.ts";
import { THINKING_LEVELS } from "../host/thinking.ts";

/**
 * A turn that thinks past its own output cap produces nothing at all.
 *
 * A campaign died on its first two turns. Both ended `stop: "length"` with
 * zero characters of text and no tool call: the entire output allowance had
 * gone into the reasoning block, which the provider counts against the same
 * cap, so the turn ended mid-thought and nothing was ever emitted. The harness
 * retried with identical settings and got identical nothing, and the run ended
 * before a plan had ever been written.
 *
 * Retrying an unchanged request after a deterministic failure is not a retry.
 * A turn truncated inside its own thinking is given less room to think on the
 * next attempt, so the allowance goes to the answer rather than the
 * deliberation. Relief stops at minimal rather than off, because a turn that
 * cannot think at all writes a worse plan than a terse one; and thinking that
 * was already off stays off, having nothing to give back.
 */

/** Consecutive most recent turns that ended at the output cap saying nothing. */
export function truncatedSilentStreak(events: readonly EventRecord[]): number {
  const turns: { silent: boolean; truncated: boolean }[] = [];
  let open = false;
  let silent = true;
  let truncated = false;
  for (const event of events) {
    if (event.name === "agent/step" && event.payload.phase === "start") {
      open = true;
      silent = true;
      truncated = false;
      continue;
    }
    if (!open) continue;
    if (event.name === "tool/call") silent = false;
    if (event.name === "assistant/message") {
      if (String(event.payload.text ?? "").trim().length > 0) silent = false;
      if (event.payload.stop === "length") truncated = true;
    }
    if (event.name === "agent/step" && event.payload.phase === "end") {
      turns.push({ silent, truncated });
      open = false;
    }
  }
  let streak = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    if (!turn.silent || !turn.truncated) break;
    streak += 1;
  }
  return streak;
}

/** The level to ask for, given how many truncated silent turns came before. */
export function reliefFor(requested: ThinkingLevel, streak: number): ThinkingLevel {
  if (requested === "off" || streak <= 0) return requested;
  const order = THINKING_LEVELS as readonly ThinkingLevel[];
  const floor = order.indexOf("minimal");
  const at = order.indexOf(requested);
  if (at < 0) return requested;
  return order[Math.max(floor, at - streak)] ?? requested;
}
