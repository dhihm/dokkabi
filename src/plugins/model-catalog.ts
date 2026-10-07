import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { BUILTIN_CODEX_MODEL, resolveLlmSelection } from "../host/config.ts";
import { BUILTIN_ROUTE_SPECS, gatewayModels, type LiveRouteSpec } from "./llm-route-catalog.ts";

export interface RouteModelCatalog {
  route: string;
  provider: string;
  total: number;
  defaultModel?: string;
  selectedModel?: string;
  active: boolean;
  models: readonly ModelCatalogItem[];
}

export interface ModelCatalogItem {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  source: "bundled" | "supplement";
}

export const MODEL_ROUTE_ALIASES: Readonly<Record<string, string>> = {
  "openai-codex": "codex",
  anthropic: "claude",
  "z.ai": "glm",
  zai: "glm",
  xai: "grok",
  nvidia: "nim",
  "nvidia-nim": "nim",
  "kimi-coding": "kimi",
  "opencode-zen": "zen",
};

export function normalizeModelRoute(route: string): string {
  const normalized = route.trim().toLowerCase();
  return MODEL_ROUTE_ALIASES[normalized] ?? normalized;
}

export function hostedModelCatalogs(models: Models): RouteModelCatalog[] {
  return BUILTIN_ROUTE_SPECS.map((spec) => routeModelCatalog(models, spec));
}

export function routeModelCatalog(models: Models, specOrRoute: LiveRouteSpec | string): RouteModelCatalog {
  const route = typeof specOrRoute === "string" ? normalizeModelRoute(specOrRoute) : specOrRoute.name;
  const spec = typeof specOrRoute === "string"
    ? BUILTIN_ROUTE_SPECS.find((candidate) => candidate.name === route)
    : specOrRoute;
  if (!spec) throw new Error("unknown model route");

  const merged = new Map<string, ModelCatalogItem>();
  for (const model of models.getModels(spec.providerId)) {
    merged.set(model.id, modelItem(model, "bundled"));
  }
  for (const model of gatewayModels(spec.name)) {
    merged.set(model.id, modelItem(model, "supplement"));
  }
  const catalog = [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
  const defaultModel = spec.name === "codex"
    ? BUILTIN_CODEX_MODEL
    : spec.defaultModel ?? catalog[0]?.id;
  const selection = resolveLlmSelection();
  const active = selection.route === spec.name;
  const selectedModel = active ? selection.model ?? defaultModel : undefined;
  return {
    route: spec.name,
    provider: spec.providerId,
    total: catalog.length,
    defaultModel,
    selectedModel,
    active,
    models: catalog,
  };
}

function modelItem(model: Model<Api>, source: ModelCatalogItem["source"]): ModelCatalogItem {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    source,
  };
}
