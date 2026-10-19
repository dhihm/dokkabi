import type { PiAuthStore } from "./pi-auth-store.ts";
import { createProvider, type ApiKeyAuth, type Model, type MutableModels, type OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { LiveRouteSpec } from "./llm-route-catalog.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModelRoute, setLegacyOperatorRouteAliases } from "../host/route-names.ts";

export interface OperatorEndpointSpec extends LiveRouteSpec {
  displayName: string;
  baseUrlEnv: readonly string[];
  apiKeyEnv: readonly string[];
  contextWindowEnv: readonly string[];
  maxTokensEnv: readonly string[];
  modelEnv?: readonly string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  compat?: OpenAICompletionsCompat;
}

const OPERATOR_GPU_SPECS = [1, 2, 3, 4] as const;

function operatorGpuEndpoint(index: number): OperatorEndpointSpec {
  const slot = String(index);
  return {
    name: `operator-gpu${slot}`,
    providerId: `operator-gpu${slot}`,
    displayName: `Operator GPU ${slot} endpoint`,
    authKind: "plan_key",
    defaultCost: "free",
    reportsCacheUsage: false,
    baseUrlEnv: [`DOKKABI_OPERATOR_GPU${slot}_BASE_URL`],
    apiKeyEnv: [`DOKKABI_OPERATOR_GPU${slot}_API_KEY`],
    contextWindowEnv: ["DOKKABI_OPERATOR_CONTEXT_WINDOW"],
    maxTokensEnv: ["DOKKABI_OPERATOR_MAX_TOKENS"],
    modelEnv: [`DOKKABI_OPERATOR_GPU${slot}_MODEL`],
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: true,
  };
}

export const OPERATOR_ENDPOINTS: readonly OperatorEndpointSpec[] = [
  {
    name: "vllm",
    providerId: "vllm",
    displayName: "vLLM operator endpoint",
    authKind: "plan_key",
    defaultCost: "free",
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
  ...OPERATOR_GPU_SPECS.map(operatorGpuEndpoint),
];

export const VLLM_ENV_HINT =
  "vllm needs VLLM_BASE_URL (or DOKKABI_VLLM_BASE_URL), e.g. http://<host>:8000/v1";

let legacyOperatorEnvAliases: Readonly<Record<string, readonly string[]>> = {};

function installOperatorLegacyCompat(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const path = join(repoRoot, "scripts", "lib", "operator-legacy-aliases.json");
  if (!existsSync(path)) {
    return;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    routes?: Record<string, string>;
    env?: Record<string, readonly string[]>;
  };
  if (parsed.routes) {
    setLegacyOperatorRouteAliases(parsed.routes);
  }
  if (parsed.env) {
    legacyOperatorEnvAliases = parsed.env;
  }
}

installOperatorLegacyCompat();

function legacyEnvNames(name: string): readonly string[] {
  return legacyOperatorEnvAliases[name] ?? [];
}

export function operatorEnvLookupKeys(name: string): readonly string[] {
  return [name, ...legacyEnvNames(name)];
}

export function envRecordValue(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    for (const key of operatorEnvLookupKeys(name)) {
      const value = env[key]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

export function canonicalOperatorRouteEnvKey(route: string, key: string): string | undefined {
  const spec = operatorEndpoint(normalizeModelRoute(route));
  if (!spec) {
    return undefined;
  }
  const candidates = [
    ...spec.baseUrlEnv,
    ...spec.apiKeyEnv,
    ...spec.contextWindowEnv,
    ...spec.maxTokensEnv,
    ...(spec.modelEnv ?? []),
  ];
  for (const canonical of candidates) {
    if (canonical === key || legacyEnvNames(canonical).includes(key)) {
      return canonical;
    }
  }
  return undefined;
}

function envValue(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
    for (const legacy of legacyEnvNames(name)) {
      const legacyValue = process.env[legacy]?.trim();
      if (legacyValue) {
        return legacyValue;
      }
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

export function operatorEndpointModelId(spec: OperatorEndpointSpec): string | undefined {
  return envValue(spec.modelEnv ?? []) ?? spec.defaultModel;
}

/** Keyless servers remain supported; authenticated deployments opt in explicitly. */
export function operatorAuthMode(spec: OperatorEndpointSpec): "none" | "api_key" {
  const mode = process.env[`DOKKABI_${spec.name.toUpperCase().replaceAll("-", "_")}_AUTH_MODE`]?.trim() ?? "none";
  if (mode !== "none" && mode !== "api_key") throw new Error(`${spec.name} AUTH_MODE must be none or api_key`);
  return mode;
}
export async function operatorEndpointKey(spec: OperatorEndpointSpec, store: PiAuthStore): Promise<string | undefined> {
  const credential = await store.read(spec.providerId);
  return credential?.type === "api_key" && credential.key?.trim() ? credential.key.trim() : envValue(spec.apiKeyEnv);
}

export function operatorEndpointHint(spec: OperatorEndpointSpec): string {
  const base = `${spec.name} needs ${spec.baseUrlEnv.join(" or ")}, e.g. http://<host>:<port>/v1`;
  if (!spec.modelEnv?.length) {
    return base;
  }
  return `${base}, and a model via ${spec.modelEnv.join(" or ")}`;
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
    async check({ ctx, credential, signal }) {
      signal.throwIfAborted();
      if (credential?.key?.trim()) return { type: "api_key", source: "stored credential" };
      for (const name of spec.apiKeyEnv) if ((await ctx.env(name))?.trim()) return { type: "api_key", source: name };
      if (operatorAuthMode(spec) === "api_key") return undefined;
      return { type: "api_key", source: "keyless operator endpoint; remote authentication unverified" };
    },
    async resolve({ ctx, credential, signal }) {
      signal.throwIfAborted();
      if (credential?.key?.trim()) {
        return { auth: { apiKey: credential.key.trim() }, source: "stored credential" };
      }
      for (const name of spec.apiKeyEnv) {
        const key = await ctx.env(name);
        signal.throwIfAborted();
        if (key?.trim()) {
          return { auth: { apiKey: key.trim() }, source: name };
        }
      }
      if (operatorAuthMode(spec) === "api_key") throw new Error(`${spec.name} API key is missing`);
      return { auth: { apiKey: "EMPTY" }, source: "explicit keyless operator endpoint" };
    },
  };
}

export function registerOperatorProviders(models: MutableModels): void {
  for (const spec of OPERATOR_ENDPOINTS) {
    if (!operatorEndpointBaseUrl(spec)) continue;
    const modelId = operatorEndpointModelId(spec);
    if (!modelId) continue;
    models.setProvider(
      createProvider({
        id: spec.providerId,
        name: spec.displayName,
        baseUrl: operatorEndpointBaseUrl(spec) ?? "http://127.0.0.1/v1",
        auth: { apiKey: endpointAuth(spec) },
        models: [createOperatorModel(spec, modelId)],
        api: openAICompletionsApi(),
      }),
    );
  }
}
