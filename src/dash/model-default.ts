import { readConfig, writeConfig } from "../host/config.ts";
import { assertPublicModelReference, recordModelSelection } from "../host/model-preferences.ts";
import type { LlmFacade } from "../loader/types.ts";

/**
 * Choose a route and model from an attached board.
 *
 * `/model` opens the same picker everywhere, but only a chat session owns a
 * live agent to hand the conversation to. A board attached to someone else's
 * run has no transcript to carry, so it writes the saved default instead:
 * the operator picks with the arrow keys, the choice lands in the config the
 * next session reads, and the line says so rather than pretending the running
 * session moved.
 */
export async function selectDefaultModel(input: {
  readonly choice: string;
  readonly llm: LlmFacade;
}): Promise<string> {
  const trimmed = input.choice.trim();
  if (!trimmed) {
    const config = readConfig();
    return `default route=${config.route ?? "(none)"} model=${config.model ?? "(route default)"}`;
  }
  const slash = trimmed.indexOf("/");
  const routeName = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const requestedModel = slash === -1 ? undefined : trimmed.slice(slash + 1);
  if (!routeName || requestedModel === "") {
    throw new Error("model selection must be route or route/model");
  }
  const route = input.llm.routes.get(routeName);
  if (!route || routeName === "replay") throw new Error(`unknown live route ${routeName}`);
  // Resolving proves the model exists on that route before it becomes the
  // default a later session boots on and fails.
  const resolved: unknown = await route.resolveModel(requestedModel);
  const modelId = typeof resolved === "string"
    ? resolved
    : String((resolved as { id?: unknown } | null)?.id ?? "");
  if (!modelId) throw new Error(`route ${routeName} resolved no model id`);
  const target = assertPublicModelReference({ route: routeName, model: modelId });
  writeConfig({ route: target.route, model: target.model });
  recordModelSelection(target);
  return `saved default route=${target.route} model=${target.model} — the next session starts here`;
}
