import { type Model } from "@earendil-works/pi-ai";
import { DokkabiAuth } from "../auth/service.ts";
import type { EventLog } from "../host/event-log.ts";
import { piAuthPath } from "../host/paths.ts";
import type { LlmFacade, LlmRoute, RouteStatus } from "../loader/types.ts";
import { operatorEndpoint } from "./operator-endpoints.ts";
import { createHostedModels } from "./hosted-models.ts";
import { routeModelCatalog } from "./model-catalog.ts";

export function replayRoute(log: EventLog): LlmRoute {
  return {
    name: "replay",
    providerId: "replay",
    authKind: "plan_key",
    hasNetwork: false,
    defaultModelId() {
      return "replay";
    },
    modelCost() {
      return "unknown";
    },
    async ready() {
      return { ok: true, reason: "offline" };
    },
    async authStatus() {
      return "connected" as const;
    },
    async resolveModel() {
      const model: Model<"openai-completions"> = {
        id: "replay",
        name: "replay",
        api: "openai-completions",
        provider: "replay",
        baseUrl: "",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      };
      return model;
    },
    stream() {
      log.assertCanRequestModel();
      throw new Error("llm.replay has no network; recorded assistant required (issue #11)");
    },
    describe() {
      return {
        name: "replay",
        providerId: "replay",
        authKind: "plan_key",
        configured: true,
        reason: "offline",
      };
    },
  };
}

export function listCodexModels(): { id: string; name: string }[] {
  const models = createHostedModels({ env: {} });
  return routeModelCatalog(models, "codex").models.map((model) => ({ id: model.id, name: model.name }));
}

export async function routeStatuses(
  facade: LlmFacade,
  authFile = piAuthPath(),
): Promise<RouteStatus[]> {
  const listed = await new DokkabiAuth({ authFile }).list();
  const byProvider = new Map(listed.map((item) => [item.providerId, item]));
  const out: RouteStatus[] = [];
  for (const route of facade.routes.values()) {
    if (route.name === "replay") {
      out.push(route.describe());
      continue;
    }
    const operator = operatorEndpoint(route.name);
    if (operator) {
      const ready = await route.ready();
      out.push({
        name: route.name,
        providerId: route.providerId,
        authKind: route.authKind,
        configured: ready.ok,
        reason: ready.ok ? "operator endpoint" : ready.reason,
      });
      continue;
    }
    const account = byProvider.get(route.providerId);
    if (account) {
      out.push({
        name: route.name,
        providerId: route.providerId,
        authKind: route.authKind,
        configured: account.connected,
        reason: account.connected
          ? `${account.credentialType ?? account.defaultMethod}${account.source ? ` via ${account.source}` : ""}`
          : route.name === "codex"
            ? "run dokkabi login codex; ChatGPT subscription OAuth only, not OPENAI_API_KEY"
            : `run dokkabi login ${route.name}`,
      });
      continue;
    }
    const ready = await route.ready();
    out.push({ ...route.describe(), configured: ready.ok, reason: ready.reason });
  }
  return out;
}
