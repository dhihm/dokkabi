import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { canonicalJson } from "../host/canonical.ts";

/** Pure pinned-adapter representation rules. Both replay and the live boundary
 * use retained full inputs and responses, never Pi's private socket cache. */
export function deriveCodexContinuation(previous: {
  model: Record<string, unknown>; tools: unknown[]; payload: Record<string, unknown>; assistant: AssistantMessage;
}, full: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!previous.assistant.responseId) return;
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  const withoutInput = (body: Record<string, unknown>) => {
    const { input: _input, previous_response_id: _response, ...rest } = body;
    return rest;
  };
  if (!same(withoutInput(previous.payload), withoutInput(full))) return;
  const model = previous.model as unknown as Model<Api>;
  const grammar = createGrammarToolInputProperties(previous.tools as never,
    model.compat && "supportsOpenAIGrammarTools" in model.compat ? model.compat.supportsOpenAIGrammarTools ?? false : false);
  const responseItems = convertResponsesMessages(model, { messages: [previous.assistant] },
    new Set(["openai", "openai-codex", "opencode"]), { includeSystemPrompt: false, grammarToolInputProperties: grammar })
    .filter(item => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
  const priorInput = Array.isArray(previous.payload.input) ? previous.payload.input : [];
  const baselineLength = priorInput.length + responseItems.length;
  if (!Array.isArray(full.input) || !same(full.input.slice(0, priorInput.length), priorInput)) return;
  // Blob storage canonicalizes object keys. Pi serializes function arguments
  // as JSON inside JSON, so replay must compare their parsed value rather than
  // the live object's insertion order. All call identities and other bytes
  // still match exactly; custom grammar input is never normalized.
  const argumentValue = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    const call = item as Record<string, unknown>;
    if (call.type !== "function_call" || typeof call.arguments !== "string") return item;
    try { return { ...call, arguments: JSON.parse(call.arguments) }; }
    catch { return item; }
  };
  if (!same(full.input.slice(priorInput.length, baselineLength).map(argumentValue), responseItems.map(argumentValue))) return;
  return { ...full, previous_response_id: previous.assistant.responseId, input: full.input.slice(baselineLength) };
}

export function providerHttpPayload(api: unknown, payload: Record<string, unknown>): Record<string, unknown> {
  return api === "anthropic-messages" ? { ...payload, stream: true } : payload;
}

export function providerRequestUrl(api: string, baseUrl: string, websocket = false): URL {
  const base = baseUrl.replace(/\/+$/, "");
  const url = new URL(api === "openai-codex-responses"
    ? base.endsWith("/codex/responses") ? base : `${base}${base.endsWith("/codex") ? "" : "/codex"}/responses`
    : `${base}/${api === "openai-completions" ? "chat/completions" : api === "anthropic-messages" ? "v1/messages" : "responses"}`);
  if (websocket) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
