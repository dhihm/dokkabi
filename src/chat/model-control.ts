import type { LlmFacade, LoopFacade } from "../loader/types.ts";
import type { ModelResilienceService } from "../plugins/model-resilience.ts";
import {
  assertPublicModelReference,
  recordModelSelection,
  type ModelReference,
} from "../host/model-preferences.ts";
import type { HandoffConfirmation } from "../dash/handoff-prompt.ts";

interface ResolvedModel {
  id: string;
  contextWindow: number;
}

export interface LiveModelSelectionInput {
  choice: string;
  llm: LlmFacade;
  loop: LoopFacade;
  resilience?: ModelResilienceService;
}

/** Resolve and persist the destination transcript before changing the active
 * route. This makes a manual selection atomic from the chat operator's point
 * of view: a failed handoff keeps the source route and live agent untouched. */
export type LiveModelSelectionResult = string | HandoffConfirmation;

export async function selectLiveModel(input: LiveModelSelectionInput): Promise<LiveModelSelectionResult> {
  const trimmed = input.choice.trim();
  if (!trimmed) {
    return `route=${input.llm.activeName} model=${input.llm.activeModelId ?? "(route default)"}`;
  }
  // An optional trailing mode word answers the large-carry confirmation:
  // `/model <route/model> carry` or `/model <route/model> slim`.
  const words = trimmed.split(/\s+/u);
  const modeWord = words.length > 1 && (words.at(-1) === "carry" || words.at(-1) === "slim")
    ? words.at(-1) as "carry" | "slim"
    : undefined;
  const choice = modeWord ? words.slice(0, -1).join(" ") : trimmed;
  const slash = choice.indexOf("/");
  const routeName = slash === -1 ? choice : choice.slice(0, slash);
  const requestedModel = slash === -1 ? undefined : choice.slice(slash + 1);
  if (!routeName || requestedModel === "") throw new Error("model selection must be route or route/model");
  const route = input.llm.routes.get(routeName);
  if (!route || routeName === "replay") throw new Error(`unknown live route ${routeName}`);
  const resolved = asResolvedModel(await route.resolveModel(requestedModel));
  const target = assertPublicModelReference({ route: routeName, model: resolved.id });
  const current = currentSelection(input.llm);

  if (current.route === target.route && current.model === target.model) {
    input.resilience?.setManualPrimary(target);
    recordModelSelection(target);
    return `route=${target.route} model=${target.model} (already active)`;
  }
  if (!input.loop.handoff) throw new Error("manual model handoff is unavailable");
  const handoff = input.loop.handoff({
    ...target,
    contextWindow: resolved.contextWindow,
    ...(modeWord ? { mode: modeWord } : {}),
  });
  if (!handoff.ok) {
    if (handoff.reason === "carry_confirmation_required") {
      // Structured, so the live board opens the MODEL HANDOFF overlay
      // instead of a footer notice an operator could read as an error.
      return {
        kind: "handoff_confirmation",
        choice,
        route: target.route,
        model: target.model,
        afterMessages: handoff.afterMessages,
        afterTokens: handoff.afterTokens,
        contextWindow: resolved.contextWindow,
        percent: resolved.contextWindow > 0
          ? Math.round((handoff.afterTokens / resolved.contextWindow) * 100)
          : 0,
      };
    }
    throw new Error(`manual model handoff failed: ${handoff.reason}`);
  }

  input.llm.select(target.route, target.model);
  input.resilience?.setManualPrimary(target);
  recordModelSelection(target);
  if (handoff.beforeMessages === 0) {
    return `route=${target.route} model=${target.model} — warning: prior context was unavailable; started the target with an empty transcript`;
  }
  if (handoff.truncated) {
    return `route=${target.route} model=${target.model} — carried ${handoff.afterMessages} messages (~${handoff.afterTokens} tokens); truncated ${handoff.droppedMessages} older messages to fit the ${resolved.contextWindow}-token target window`;
  }
  return `route=${target.route} model=${target.model} — carried ${handoff.afterMessages} messages (~${handoff.afterTokens} tokens)`;
}

function currentSelection(llm: LlmFacade): ModelReference {
  return {
    route: llm.activeName,
    model: llm.activeModelId ?? llm.active().defaultModelId() ?? "missing",
  };
}

function asResolvedModel(value: unknown): ResolvedModel {
  if (typeof value !== "object" || value === null) {
    throw new Error("selected model metadata is unavailable");
  }
  const model = value as { id?: unknown; contextWindow?: unknown };
  if (typeof model.id !== "string" || !model.id) {
    throw new Error("selected model id is unavailable");
  }
  if (
    typeof model.contextWindow !== "number"
    || !Number.isFinite(model.contextWindow)
    || model.contextWindow <= 0
  ) {
    throw new Error("selected model context window is unavailable");
  }
  return { id: model.id, contextWindow: model.contextWindow };
}
