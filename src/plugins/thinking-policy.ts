import type { AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";
import type { EventLog } from "../host/event-log.ts";
import { resolveThinkingLevel } from "../host/thinking.ts";
import { reliefFor, truncatedSilentStreak } from "../work/thinking-relief.ts";

export interface PromptThinkingPolicy {
  requestedLevel?: ThinkingLevel;
  phase?: string;
  route: string;
  model: Model<Api>;
}

export function applyPromptThinkingPolicy(
  state: Pick<AgentState, "thinkingLevel">,
  log: EventLog,
  policy: PromptThinkingPolicy,
): void {
  const asked = policy.requestedLevel ?? resolveThinkingLevel();
  // A turn that spent its whole output allowance inside the reasoning block
  // emits nothing, and asking again the same way spends it the same way. Each
  // truncated silent turn takes one level of thinking off the next attempt so
  // the allowance reaches the answer (work/thinking-relief.ts).
  // Relief may adapt a default, never override an explicitly selected level.
  const starved = policy.requestedLevel === undefined ? truncatedSilentStreak(log.events) : 0;
  const requested = reliefFor(asked, starved);
  const level = clampThinkingLevel(policy.model, requested);
  const mapped = policy.model.thinkingLevelMap?.[level];
  const providerEffort = typeof mapped === "string" ? mapped : level;
  state.thinkingLevel = level;
  log.append({
    kind: "observe",
    name: "model/thinking",
    payload: {
      requested_level: requested,
      ...(starved > 0 ? { asked_level: asked, relieved_after_truncated: starved } : {}),
      level,
      provider_effort: providerEffort,
      clamped: level !== requested,
      mapped: providerEffort !== level,
      phase: policy.phase ?? "turn",
      route: policy.route,
      model: policy.model.id,
    },
  });
}
