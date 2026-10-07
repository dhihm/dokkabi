import { DokkabiAuth } from "../auth/service.ts";
import { createHostedModels } from "../plugins/hosted-models.ts";
import { hostedModelCatalogs } from "../plugins/model-catalog.ts";
import { gatewayModel } from "../plugins/llm-route-catalog.ts";
import { AUDITED_PROVIDER_APIS } from "../plugins/request-audit.ts";
import type { WorkbenchModel } from "./workbench.ts";

/** Metadata only: a credential connection is not model entitlement/readiness. */
export async function listWorkbenchModels(): Promise<WorkbenchModel[]> {
  const accounts = await new DokkabiAuth().list();
  const connected = new Map(accounts.map(account => [account.providerId, account.connected]));
  const hosted = createHostedModels();
  return hostedModelCatalogs(hosted)
    .filter(catalog => catalog.route !== "antigravity")
    .flatMap(catalog => catalog.models.filter(model => {
      const resolved = hosted.getModel(catalog.provider, model.id) ?? gatewayModel(catalog.route, model.id);
      return resolved !== undefined && AUDITED_PROVIDER_APIS.has(resolved.api);
    }).map(model => ({
      route: catalog.route, provider: catalog.provider, model: model.id,
      name: model.name, connected: connected.get(catalog.provider) === true,
    })));
}
