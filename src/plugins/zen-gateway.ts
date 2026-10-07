import { createProvider, type ApiKeyAuth, type MutableModels } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/**
 * OpenCode Zen (https://opencode.ai/zen) as a hosted route. Zen has no
 * provider in pi-ai, so this registers one by hand the way the operator
 * endpoints do — but with a fixed public base URL and a real API key, not
 * an operator box. The Muse Spark family serves through the Responses API
 * (`/zen/v1/responses`), so the provider rides `openai-responses`.
 */

export const ZEN_PROVIDER_ID = "opencode-zen";
export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_KEY_URL = "https://opencode.ai/auth";

const zenApiKeyAuth: ApiKeyAuth = {
  name: "OpenCode Zen API key",
  async login(interaction) {
    interaction.notify({
      type: "info",
      message: "Create an API key at opencode.ai/auth. The free Muse Spark tier trades prompts and completions for Meta model training.",
      links: [{ url: ZEN_KEY_URL, label: "opencode.ai/auth" }],
    });
    const key = await interaction.prompt({
      type: "secret",
      message: "OpenCode Zen API key",
      signal: interaction.signal,
    });
    const trimmed = key.trim();
    if (!trimmed) throw new Error("empty API key");
    return { type: "api_key", key: trimmed };
  },
  async check({ ctx, credential, signal }) {
    signal.throwIfAborted();
    if (credential?.key) {
      return { type: "api_key", source: "stored credential" };
    }
    if (await ctx.env("OPENCODE_API_KEY")) {
      return { type: "api_key", source: "OPENCODE_API_KEY" };
    }
    return undefined;
  },
  async resolve({ ctx, credential, signal }) {
    signal.throwIfAborted();
    const key = credential?.key ?? await ctx.env("OPENCODE_API_KEY");
    if (!key) return undefined;
    return {
      auth: { apiKey: key },
      source: credential?.key ? "stored credential" : "OPENCODE_API_KEY",
    };
  },
};

export function registerZenProvider(models: MutableModels): void {
  models.setProvider(
    createProvider({
      id: ZEN_PROVIDER_ID,
      name: "OpenCode Zen",
      baseUrl: ZEN_BASE_URL,
      auth: { apiKey: zenApiKeyAuth },
      models: [],
      api: openAIResponsesApi(),
    }),
  );
}
