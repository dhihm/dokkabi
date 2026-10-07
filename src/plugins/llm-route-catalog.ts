import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelCost } from "../host/model-failover.ts";

export interface LiveRouteSpec {
  name: string;
  providerId: string;
  authKind: "oauth" | "plan_key";
  defaultModel?: string;
  reportsCacheUsage?: boolean;
  defaultCost?: ModelCost;
  modelCosts?: Readonly<Record<string, ModelCost>>;
}

/**
 * Every route carries a cost, because an unlabelled one cannot fail over.
 *
 * `catalogModelCost` falls back to "unknown" when a spec declares neither
 * `modelCosts` nor `defaultCost`, and `costAllowed` rejects "unknown" under
 * every policy — `free_only`, `subscription_and_free`, and `explicit_paid`
 * alike. `allowedCost` cannot even name it (model-failover.ts). So a route
 * without a cost is silently ineligible as a failover candidate however
 * connected and usable it is: the policy accepts it, the status line prints
 * it, and the transition finds no candidate at the moment it is needed.
 *
 * Observed live: an unattended run lost its provider to a transport failure
 * and stopped with `reason: no_candidate` and an empty candidate list, having
 * been configured with candidates that could never have been chosen.
 *
 * An operator plan key and a provider OAuth seat are both subscriptions here;
 * per-model overrides in `modelCosts` still win where a route mixes tiers.
 */
export const BUILTIN_ROUTE_SPECS: readonly LiveRouteSpec[] = [
  { name: "codex", providerId: "openai-codex", authKind: "oauth", defaultCost: "subscription" },
  { name: "claude", providerId: "anthropic", authKind: "oauth", defaultCost: "subscription" },
  { name: "google", providerId: "google", authKind: "plan_key", defaultCost: "paid" },
  // Compatibility only: this uses Google API auth, not native Antigravity ACP.
  { name: "antigravity", providerId: "google", authKind: "plan_key", defaultCost: "paid" },
  { name: "kimi", providerId: "kimi-coding", authKind: "oauth", defaultCost: "subscription" },
  { name: "glm", providerId: "zai", authKind: "plan_key", defaultCost: "subscription" },
  { name: "minimax", providerId: "minimax", authKind: "plan_key", defaultCost: "subscription" },
  { name: "grok", providerId: "xai", authKind: "oauth", defaultCost: "subscription" },
  {
    name: "nim",
    providerId: "nvidia",
    authKind: "plan_key",
    defaultModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
    modelCosts: {
      "nvidia/nemotron-3.5-lightning-30b-a3b": "free",
      "openai/gpt-oss-120b": "free",
      "meta/muse-glimmer-30b": "free",
    },
  },
  {
    name: "openrouter",
    providerId: "openrouter",
    authKind: "oauth",
    defaultModel: "stealth/ox-alpha",
    modelCosts: {
      "nvidia/nemotron-3.5-lightning:free": "free",
      "z-ai/glm-5.2:free": "free",
      "stealth/ox-alpha": "free",
      "stealth/union-alpha": "free",
      "nex-agi/nex-n2.5-pro:free": "free",
    },
  },
  {
    name: "zen",
    providerId: "opencode-zen",
    authKind: "plan_key",
    defaultModel: "muse-spark-1.3-contributor-free",
    modelCosts: {
      "muse-spark-1.3-contributor-free": "free",
      "muse-spark-1.2-contributor-free": "free",
    },
  },
];

export function catalogModelCost(spec: LiveRouteSpec, modelId: string): ModelCost {
  return spec.modelCosts?.[modelId] ?? spec.defaultCost ?? "unknown";
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const NIM_GATEWAY_MODELS: Readonly<Record<string, Model<"openai-completions">>> = {
  "nvidia/nemotron-3.5-lightning-30b-a3b": {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    name: "Nemotron 3.5 Lightning 30B A3B",
    api: "openai-completions",
    provider: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 128_000,
    maxTokens: 32_000,
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    api: "openai-completions",
    provider: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 128_000,
    maxTokens: 32_000,
  },
  "meta/muse-glimmer-30b": {
    id: "meta/muse-glimmer-30b",
    name: "Muse Glimmer 30B",
    api: "openai-completions",
    provider: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

const OPENROUTER_GATEWAY_MODELS: Readonly<Record<string, Model<"openai-completions">>> = {
  "nex-agi/nex-n2.5-pro:free": {
    id: "nex-agi/nex-n2.5-pro:free",
    name: "Nex N2.5 Pro (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 262_000,
    maxTokens: 32_000,
  },
  "nvidia/nemotron-3.5-lightning:free": {
    id: "nvidia/nemotron-3.5-lightning:free",
    name: "Nemotron 3.5 Lightning (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 1_000_000,
    maxTokens: 32_000,
  },
  "z-ai/glm-5.2:free": {
    id: "z-ai/glm-5.2:free",
    name: "GLM 5.2 (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 128_000,
    maxTokens: 32_000,
  },
  "stealth/ox-alpha": {
    id: "stealth/ox-alpha",
    name: "Ox Alpha",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    input: ["text", "image"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
  "stealth/union-alpha": {
    id: "stealth/union-alpha",
    name: "Union Alpha",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 262_144,
    maxTokens: 131_072,
  },
};

const ZAI_GATEWAY_MODELS: Readonly<Record<string, Model<"openai-completions">>> = {
  // Official model code and limits: https://docs.z.ai/guides/vlm/glm-5.3-flash
  "glm-5.3-flash": {
    id: "glm-5.3-flash", name: "GLM-5.3 Flash", api: "openai-completions",
    provider: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
    input: ["text", "image"], cost: ZERO_COST,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
      maxTokensField: "max_tokens", thinkingFormat: "zai", zaiToolStream: true },
    contextWindow: 1_000_000, maxTokens: 131_072,
  },
  "glm-5.3": {
    id: "glm-5.3",
    name: "GLM-5.3",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    input: ["text"],
    cost: ZERO_COST,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "zai",
      zaiToolStream: true,
    },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
};

/**
 * xAI models the bundled provider catalog does not list yet. Each entry is an
 * official model the provider answers under the same account (verified with
 * a one-token request through the route's own credential before it was
 * listed); its limits and pricing are the nearest listed model's until the
 * bundled catalog carries the model itself, when this entry should go.
 */
const XAI_SUPPLEMENT_MODELS: Readonly<Record<string, Model<"openai-responses">>> = {
  "grok-4.7": {
    id: "grok-4.7",
    name: "Grok 4.7",
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    compat: { supportsLongCacheRetention: false },
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 500_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
  },
};

/**
 * OpenCode Zen gateway models. Zen's endpoint table serves the Muse Spark
 * family through the Responses API (`/zen/v1/responses`) and only the
 * openai-compatible models through chat completions, so these entries pin
 * `api: "openai-responses"` while every other gateway map stays on
 * completions. Contributor-free pricing means prompts and completions may
 * train future Meta models — the operator opted into that trade.
 */
const ZEN_GATEWAY_MODELS: Readonly<Record<string, Model<"openai-responses">>> = {
  "muse-spark-1.3-contributor-free": {
    id: "muse-spark-1.3-contributor-free",
    name: "Muse Spark 1.3 (contributor free)",
    api: "openai-responses",
    provider: "opencode-zen",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
  "muse-spark-1.2-contributor-free": {
    id: "muse-spark-1.2-contributor-free",
    name: "Muse Spark 1.2 (contributor free)",
    api: "openai-responses",
    provider: "opencode-zen",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"],
    cost: ZERO_COST,
    compat: {},
    contextWindow: 1_000_000,
    maxTokens: 32_768,
  },
};

/** Current GPT-6 additions are absent from Pi 0.84.1's fixed Codex catalog. Keep the
 * bundled Codex input budget until this subscription's larger window is
 * independently verified; API limits do not establish account limits.
 * Metadata: https://developers.openai.com/api/docs/models/gpt-6-luna
 */
const CODEX_SUPPLEMENT_MODELS: Readonly<Record<string, Model<"openai-codex-responses">>> = {
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  "gpt-6-astra": {
    id: "gpt-6-astra", name: "GPT-6 Astra", api: "openai-codex-responses",
    provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true, input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 272_000, maxTokens: 128_000,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
  },
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  "gpt-6.1-sol": {
    id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api: "openai-codex-responses",
    provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true, input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    contextWindow: 272_000, maxTokens: 128_000,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
  },
  "gpt-6-luna": {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
    },
    contextWindow: 272_000,
    maxTokens: 128_000,
    thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
  },
};

/** Current Claude model metadata and adaptive-thinking compatibility.
 * https://platform.claude.com/docs/en/models/opus-5-5/overview
 * https://platform.claude.com/docs/en/models/sonnet-5-5/overview
 * Pi does not encode Sonnet's between_tools mode; discovery supports adaptive
 * thinking only rather than advertising a disabled-thinking request it rejects.
 */
const CLAUDE_SUPPLEMENT_MODELS: Readonly<Record<string, Model<"anthropic-messages">>> = {
  "claude-opus-5-5": {
    id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "anthropic-messages",
    provider: "anthropic", baseUrl: "https://api.anthropic.com",
    reasoning: true, input: ["text", "image"],
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    contextWindow: 1_000_000, maxTokens: 128_000,
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "anthropic-messages",
    provider: "anthropic", baseUrl: "https://api.anthropic.com",
    reasoning: true, input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000, maxTokens: 128_000,
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
  },
};

const GATEWAY_MODELS: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = {
  codex: CODEX_SUPPLEMENT_MODELS,
  claude: CLAUDE_SUPPLEMENT_MODELS,
  glm: ZAI_GATEWAY_MODELS,
  grok: XAI_SUPPLEMENT_MODELS,
  nim: NIM_GATEWAY_MODELS,
  openrouter: OPENROUTER_GATEWAY_MODELS,
  zen: ZEN_GATEWAY_MODELS,
};

export function gatewayModel(routeName: string, modelId: string): Model<Api> | undefined {
  return GATEWAY_MODELS[routeName]?.[modelId];
}

export function gatewayModels(routeName: string): readonly Model<Api>[] {
  return Object.values(GATEWAY_MODELS[routeName] ?? {});
}
