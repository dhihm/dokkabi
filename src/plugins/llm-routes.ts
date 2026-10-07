import { cleanupSessionResources, type Api, type Context, type Model, type MutableModels, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { EventLog } from "../host/event-log.ts";
import { resolveCodexModel, resolveLlmSelection } from "../host/config.ts";
import { piAuthPath } from "../host/paths.ts";
import type { CapabilityClaim, HostContext, LlmFacade, LlmRoute, ModelAuthStatus, PluginModule, RouteStatus } from "../loader/types.ts";
import { BUILTIN_ROUTE_SPECS, catalogModelCost, gatewayModel, type LiveRouteSpec } from "./llm-route-catalog.ts";
import { replayRoute } from "./llm-route-support.ts";
import {
  createOperatorModel,
  operatorEndpoint,
  operatorEndpointBaseUrl,
  operatorEndpointHint,
  OPERATOR_ENDPOINTS,
  registerOperatorProviders,
} from "./operator-endpoints.ts";
import { PiAuthStore } from "./pi-auth-store.ts";
import { createHostedModels } from "./hosted-models.ts";
import { streamWithRequestAudit } from "./request-audit.ts";
import { admitProviderInput, appendProviderMessage, liveProviderState, replaceProviderMessages } from "../host/provider-input.ts";
import { frozenPrefixHash, lastPromptSeal, toolSchemaHash } from "../host/prefix.ts";

export { listCodexModels, routeStatuses } from "./llm-route-support.ts";
export { vllmBaseUrl } from "./operator-endpoints.ts";

/**
 * v0 roster. Named routes on ctx.llm.
 * google-antigravity is not in pi-ai 0.84.1; antigravity maps to Google API-key auth.
 */
const LIVE_ROUTE_SPECS: readonly LiveRouteSpec[] = [...BUILTIN_ROUTE_SPECS, ...OPERATOR_ENDPOINTS];

/** Validate the default manifest route before plugin boot opens long-lived resources. */
export function assertKnownLlmRoute(name: string): void {
  if (name === "replay" || LIVE_ROUTE_SPECS.some((spec) => spec.name === name)) return;
  throw new Error(`unknown llm route ${name}`);
}

export function createLlmFacade(log: EventLog, authFile = piAuthPath()): LlmFacade {
  const credentials = new PiAuthStore(authFile);
  const models = createHostedModels({ credentials });
  registerOperatorProviders(models);

  const routes = new Map<string, LlmRoute>();
  const facade: LlmFacade = {
    routes,
    activeName: "codex",
    active() {
      const route = routes.get(this.activeName);
      if (!route) {
        throw new Error(`unknown llm route ${this.activeName}`);
      }
      return route;
    },
    select(name: string, modelId?: string) {
      if (!routes.has(name)) {
        throw new Error(`unknown llm route ${name}`);
      }
      this.activeName = name;
      this.activeModelId = modelId;
    },
    registerRoute(route: LlmRoute) {
      if (routes.has(route.name)) {
        throw new Error(`duplicate llm route ${route.name}`);
      }
      routes.set(route.name, route);
      return () => {
        if (routes.get(route.name) === route) routes.delete(route.name);
      };
    },
  };

  for (const spec of LIVE_ROUTE_SPECS) {
    facade.registerRoute(liveRoute(spec, models, credentials, log));
  }
  facade.registerRoute(replayRoute(log));
  const selection = resolveLlmSelection();
  facade.select(selection.route, selection.model);
  return facade;
}

function liveRoute(
  spec: LiveRouteSpec,
  models: MutableModels,
  credentials: PiAuthStore,
  log: EventLog,
): LlmRoute {
  return {
    name: spec.name,
    providerId: spec.providerId,
    authKind: spec.authKind,
    hasNetwork: true,
    reportsCacheUsage: spec.reportsCacheUsage ?? true,
    defaultModelId() {
      if (spec.name === "codex") {
        const preferred = resolveCodexModel();
        if (models.getModel(spec.providerId, preferred)) {
          return preferred;
        }
      }
      if (spec.defaultModel) {
        return spec.defaultModel;
      }
      return models.getModels(spec.providerId)[0]?.id;
    },
    modelCost(modelId: string) {
      return catalogModelCost(spec, modelId);
    },
    async resolveModel(modelId?: string) {
      const id = modelId ?? this.defaultModelId();
      if (!id) {
        throw new Error(`no models for ${spec.providerId}`);
      }
      const operator = operatorEndpoint(spec.name);
      const model = models.getModel(spec.providerId, id) ??
        gatewayModel(spec.name, id) ??
        (operator ? createOperatorModel(operator, id) : undefined);
      if (!model) {
        throw new Error(`unknown model ${spec.providerId}/${id}`);
      }
      return model;
    },
    async ready() {
      const operator = operatorEndpoint(spec.name);
      if (operator) {
        return operatorEndpointBaseUrl(operator)
          ? { ok: true }
          : { ok: false, reason: operatorEndpointHint(operator) };
      }
      const auth = await models.checkAuth(spec.providerId);
      return auth
        ? { ok: true, reason: auth.type }
        : {
          ok: false,
          reason: spec.name === "codex"
            ? "run dokkabi login codex (openai-codex subscription OAuth; OPENAI_API_KEY is not used)"
            : spec.name === "nim"
              ? "run dokkabi login nim or set NVIDIA_API_KEY"
              : spec.name === "zen"
                ? "run dokkabi login zen or set OPENCODE_API_KEY"
                : `run dokkabi login ${spec.name}`,
        };
    },
    async authStatus(): Promise<ModelAuthStatus> {
      const operator = operatorEndpoint(spec.name);
      if (operator) return operatorEndpointBaseUrl(operator) ? "connected" : "missing";
      try {
        const credential = await credentials.read(spec.providerId);
        if (credential?.type === "oauth") {
          return credential.expires <= Date.now() ? "expired" : "connected";
        }
        if (credential?.type === "api_key") return "connected";
        return (await models.checkAuth(spec.providerId)) ? "connected" : "missing";
      } catch {
        return "unknown";
      }
    },
    resetSession(sessionId: string) {
      cleanupSessionResources(sessionId);
    },
    streamCredentialProbe(model: unknown, timeoutMs: number) {
      const context = { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "ok" }], timestamp: 0 }], tools: [] };
      const prefix = frozenPrefixHash({ systemPrompt: "", toolSchemas: [] });
      if (lastPromptSeal(log.events)?.payload.prefix_hash !== prefix) log.appendBatchDurable(() => [{
        kind: "observe", name: "prompt/seal", payload: { reason: "tools_changed", prefix_hash: prefix,
          tool_schema_hash: toolSchemaHash([]), prompt_generation: Number(lastPromptSeal(log.events)?.payload.prompt_generation ?? -1) + 1 },
      }]);
      replaceProviderMessages(log, [], liveProviderState(log).ref ? "session/fresh_start" : "start");
      log.appendBatchDurable(() => [{ kind: "surface", name: "user/message", payload: { text: "ok", origin: "credential_probe" } }]);
      appendProviderMessage(log, context.messages[0]);
      // A thinking-only model cannot authenticate with an encoded disabled
      // thinking request. Admit the effective effort before request auditing.
      const options = { maxTokens: 1, timeoutMs,
        ...(isPiModel(model) && model.reasoning && model.thinkingLevelMap?.off === null
          ? { reasoning: "low" as const } : {}) };
      admitProviderInput(log, { route: spec.name, role: "credential_probe", model, context, options });
      return this.stream(model, context, options);
    },
    stream(model: unknown, context: unknown, options?: unknown) {
      log.assertCanRequestModel();
      if (!isPiModel(model) || !isPiContext(context) || !isStreamOptions(options)) {
        throw new Error(`invalid Pi stream input for ${spec.name}`);
      }
      return streamWithRequestAudit(log, model, context, options,
        (selected, admitted, bounded) => models.streamSimple(selected, admitted as Context, bounded));
    },
    describe(): RouteStatus {
      return describeSync(spec, models);
    },
  };
}

function describeSync(spec: LiveRouteSpec, models: MutableModels): RouteStatus {
  const provider = models.getProvider(spec.providerId);
  if (!provider) {
    return {
      name: spec.name,
      providerId: spec.providerId,
      authKind: spec.authKind,
      configured: false,
      reason: "provider missing",
    };
  }
  return {
    name: spec.name,
    providerId: spec.providerId,
    authKind: spec.authKind,
    configured: false,
    reason: "check with dokkabi status (async auth)",
  };
}

function isPiModel(value: unknown): value is Model<Api> {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" &&
    "provider" in value && typeof value.provider === "string" &&
    "api" in value && typeof value.api === "string" &&
    "baseUrl" in value && typeof value.baseUrl === "string";
}

function isPiContext(value: unknown): value is Context {
  return typeof value === "object" && value !== null &&
    "messages" in value && Array.isArray(value.messages);
}

function isStreamOptions(value: unknown): value is SimpleStreamOptions | undefined {
  return value === undefined || (typeof value === "object" && value !== null);
}

function pluginClaims(): CapabilityClaim[] {
  return [
    { key: "llm", role: "definition" },
    { key: "llm", role: "provider" },
    ...LIVE_ROUTE_SPECS.map((spec): CapabilityClaim => ({ key: "llm", role: "provider", route: spec.name })),
    { key: "llm", role: "provider", route: "replay" },
  ];
}

export const plugin: PluginModule = {
  id: "llm-routes",
  claims: pluginClaims(),
  register(ctx: HostContext) {
    ctx.define("llm", { keys: [...LIVE_ROUTE_SPECS.map((spec) => spec.name), "replay"] });
    const facade = createLlmFacade(ctx.log);
    ctx.provide("llm", facade);
    for (const name of facade.routes.keys()) {
      ctx.provide("llm", facade, name);
    }
  },
};
