import { createProvider, type ApiKeyAuth, type Model, type MutableModels, type OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { LiveRouteSpec } from "./llm-route-catalog.ts";

export interface OperatorEndpointSpec extends LiveRouteSpec {
  displayName: string;
  baseUrlEnv: readonly string[];
  apiKeyEnv: readonly string[];
  contextWindowEnv: readonly string[];
  maxTokensEnv: readonly string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  compat?: OpenAICompletionsCompat;
}

export const OPERATOR_ENDPOINTS: readonly OperatorEndpointSpec[] = [
  {
    name: "vllm",
    providerId: "vllm",
    displayName: "vLLM operator endpoint",
    authKind: "plan_key",
    defaultModel: "Qwen3.8-27B",
    reportsCacheUsage: false,
    baseUrlEnv: ["DOKKABI_VLLM_BASE_URL", "VLLM_BASE_URL"],
    apiKeyEnv: ["VLLM_API_KEY"],
    contextWindowEnv: ["VLLM_CONTEXT_WINDOW"],
    maxTokensEnv: ["VLLM_MAX_TOKENS"],
    contextWindow: 128_000,
    maxTokens: 32_768,
    reasoning: true,
    compat: {
      thinkingFormat: "qwen-chat-template",
      supportsThinkingTokenBudget: true,
    },
  },
  {
    name: "kraken-gpu1",
    providerId: "kraken-gpu1",
    displayName: "Kraken GPU 1 operator endpoint",
    authKind: "plan_key",
    defaultModel: "release_ornith_35b",
    reportsCacheUsage: false,
    baseUrlEnv: ["DOKKABI_KRAKEN_GPU1_BASE_URL", "KRAKEN_GPU1_BASE_URL"],
    apiKeyEnv: ["DOKKABI_KRAKEN_GPU1_API_KEY", "KRAKEN_GPU1_API_KEY"],
    contextWindowEnv: ["KRAKEN_CONTEXT_WINDOW"],
    maxTokensEnv: ["KRAKEN_MAX_TOKENS"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: true,
  },
  {
    name: "kraken-gpu2",
    providerId: "kraken-gpu2",
    displayName: "Kraken GPU 2 operator endpoint",
    authKind: "plan_key",
    defaultModel: "release_ornith_35b",
    reportsCacheUsage: false,
    baseUrlEnv: ["DOKKABI_KRAKEN_GPU2_BASE_URL", "KRAKEN_GPU2_BASE_URL"],
    apiKeyEnv: ["DOKKABI_KRAKEN_GPU2_API_KEY", "KRAKEN_GPU2_API_KEY"],
    contextWindowEnv: ["KRAKEN_CONTEXT_WINDOW"],
    maxTokensEnv: ["KRAKEN_MAX_TOKENS"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: true,
  },
  {
    name: "kraken-gpu3",
    providerId: "kraken-gpu3",
    displayName: "Kraken GPU 3 operator endpoint",
    authKind: "plan_key",
    defaultModel: "release_ornith_35b",
    reportsCacheUsage: false,
    baseUrlEnv: ["DOKKABI_KRAKEN_GPU3_BASE_URL", "KRAKEN_GPU3_BASE_URL"],
    apiKeyEnv: ["DOKKABI_KRAKEN_GPU3_API_KEY", "KRAKEN_GPU3_API_KEY"],
    contextWindowEnv: ["KRAKEN_CONTEXT_WINDOW"],
    maxTokensEnv: ["KRAKEN_MAX_TOKENS"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: true,
  },
  {
    name: "kraken-gpu4",
    providerId: "kraken-gpu4",
    displayName: "Kraken GPU 4 operator endpoint",
    authKind: "plan_key",
    defaultModel: "release_ornith_35b",
    reportsCacheUsage: false,
    baseUrlEnv: ["DOKKABI_KRAKEN_GPU4_BASE_URL", "KRAKEN_GPU4_BASE_URL"],
    apiKeyEnv: ["DOKKABI_KRAKEN_GPU4_API_KEY", "KRAKEN_GPU4_API_KEY"],
    contextWindowEnv: ["KRAKEN_CONTEXT_WINDOW"],
    maxTokensEnv: ["KRAKEN_MAX_TOKENS"],
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: true,
  },
];

export const VLLM_ENV_HINT =
  "vllm needs VLLM_BASE_URL (or DOKKABI_VLLM_BASE_URL), e.g. http://<host>:8000/v1";

function envValue(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function numericEnv(names: readonly string[], fallback: number): number {
  const parsed = Number(envValue(names) ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function operatorEndpoint(name: string): OperatorEndpointSpec | undefined {
  return OPERATOR_ENDPOINTS.find((spec) => spec.name === name);
}

export function operatorEndpointBaseUrl(spec: OperatorEndpointSpec): string | undefined {
  return envValue(spec.baseUrlEnv);
}

export function operatorEndpointHint(spec: OperatorEndpointSpec): string {
  return `${spec.name} needs ${spec.baseUrlEnv.join(" or ")}, e.g. http://<host>:<port>/v1`;
}

export function vllmBaseUrl(): string | undefined {
  return envValue(["DOKKABI_VLLM_BASE_URL", "VLLM_BASE_URL"]);
}

export function createOperatorModel(
  spec: OperatorEndpointSpec,
  id: string,
): Model<"openai-completions"> {
  const baseUrl = operatorEndpointBaseUrl(spec);
  if (!baseUrl) {
    throw new Error(operatorEndpointHint(spec));
  }
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: spec.providerId,
    baseUrl,
    reasoning: spec.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(spec.compat ? { compat: spec.compat } : {}),
    contextWindow: numericEnv(spec.contextWindowEnv, spec.contextWindow),
    maxTokens: numericEnv(spec.maxTokensEnv, spec.maxTokens),
  };
}

export function createVllmModel(id: string): Model<"openai-completions"> {
  const spec = operatorEndpoint("vllm");
  if (!spec) {
    throw new Error("vllm operator endpoint is not registered");
  }
  return createOperatorModel(spec, id);
}

function endpointAuth(spec: OperatorEndpointSpec): ApiKeyAuth {
  return {
    name: `${spec.displayName} API key`,
    async check({ signal }) {
      signal.throwIfAborted();
      return { type: "api_key", source: "keyless operator endpoint" };
    },
    async resolve({ ctx, credential, signal }) {
      signal.throwIfAborted();
      if (credential?.key) {
        return { auth: { apiKey: credential.key }, source: "stored credential" };
      }
      for (const name of spec.apiKeyEnv) {
        const key = await ctx.env(name);
        signal.throwIfAborted();
        if (key) {
          return { auth: { apiKey: key }, source: name };
        }
      }
      return { auth: { apiKey: "EMPTY" }, source: "keyless operator endpoint" };
    },
  };
}

export function registerOperatorProviders(models: MutableModels): void {
  for (const spec of OPERATOR_ENDPOINTS) {
    models.setProvider(
      createProvider({
        id: spec.providerId,
        name: spec.displayName,
        baseUrl: operatorEndpointBaseUrl(spec) ?? "http://127.0.0.1/v1",
        auth: { apiKey: endpointAuth(spec) },
        models: [],
        api: openAICompletionsApi(),
      }),
    );
  }
}
