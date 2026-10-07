import { createHostedModels } from "../plugins/hosted-models.ts";
import { hostedModelCatalogs, normalizeModelRoute, routeModelCatalog, type ModelCatalogItem } from "../plugins/model-catalog.ts";
import { PiAuthStore } from "../plugins/pi-auth-store.ts";
import { piAuthPath } from "../host/paths.ts";
import { readModelPreferences } from "../host/model-preferences.ts";

interface ModelsArguments {
  route?: string;
  search?: string;
  json: boolean;
  recent: boolean;
  favorites: boolean;
}

export async function runModelsCommand(args: readonly string[]): Promise<void> {
  const parsed = parseModelsArguments(args);
  if (parsed.recent || parsed.favorites) {
    const preferences = readModelPreferences();
    const values = parsed.recent ? preferences.recent : preferences.favorites;
    const name = parsed.recent ? "recent" : "favorites";
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ [name]: values }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${name}:\n`);
    for (const value of values) {
      const at = "at" in value ? `\t${value.at}` : "";
      process.stdout.write(`${value.route}/${value.model}${at}\n`);
    }
    if (values.length === 0) process.stdout.write("(none)\n");
    return;
  }
  const models = createHostedModels({ credentials: new PiAuthStore(piAuthPath()) });
  if (!parsed.route) {
    const catalogs = hostedModelCatalogs(models);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ routes: catalogs.map(withoutModels) }, null, 2)}\n`);
      return;
    }
    process.stdout.write("route         provider          models selected/default\n");
    for (const catalog of catalogs) {
      const current = catalog.active
        ? catalog.selectedModel ?? catalog.defaultModel ?? "(none)"
        : catalog.defaultModel ?? "(none)";
      const label = catalog.active ? current : `${current} (default)`;
      process.stdout.write(
        `${catalog.route.padEnd(13)} ${catalog.provider.padEnd(17)} ${String(catalog.total).padEnd(6)} ${label}\n`,
      );
    }
    process.stdout.write("\nBrowse: dokkabi models ROUTE [--search TEXT]\n");
    process.stdout.write("Select: dokkabi model --route ROUTE MODEL_ID\n");
    return;
  }

  const catalog = routeModelCatalog(models, parsed.route);
  const filtered = filterModels(catalog.models, parsed.search);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({
      ...withoutModels(catalog),
      matched: filtered.length,
      search: parsed.search,
      models: filtered.map((model) => ({
        ...model,
        selected: model.id === catalog.selectedModel,
        default: model.id === catalog.defaultModel,
      })),
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`route=${catalog.route}\nprovider=${catalog.provider}\nmodels=${catalog.total}\n`);
  process.stdout.write(`selected=${catalog.selectedModel ?? "(not active)"}\ndefault=${catalog.defaultModel ?? "(none)"}\n`);
  if (parsed.search) process.stdout.write(`matched=${filtered.length} search=${JSON.stringify(parsed.search)}\n`);
  process.stdout.write("\n");
  for (const model of filtered) {
    const labels = [
      model.id === catalog.selectedModel ? "selected" : undefined,
      model.id === catalog.defaultModel ? "default" : undefined,
      model.source === "supplement" ? "official supplement" : undefined,
    ].filter(Boolean);
    const suffix = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
    process.stdout.write(`${model.id}\t${model.name}${suffix}\n`);
  }
  if (filtered.length === 0) process.stdout.write("No matching models.\n");
  process.stdout.write(`\nSelect: dokkabi model --route ${catalog.route} MODEL_ID\n`);
}

function parseModelsArguments(args: readonly string[]): ModelsArguments {
  const parsed: ModelsArguments = { json: false, recent: false, favorites: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--recent") {
      parsed.recent = true;
      continue;
    }
    if (arg === "--favorites") {
      parsed.favorites = true;
      continue;
    }
    if (arg === "--search") {
      parsed.search = args[index + 1];
      if (!parsed.search) throw new Error("--search requires text");
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error("unknown models flag");
    if (parsed.route) throw new Error("models accepts one route");
    parsed.route = normalizeModelRoute(arg);
  }
  if (!parsed.route && parsed.search) throw new Error("--search requires a route");
  if (parsed.recent && parsed.favorites) throw new Error("models accepts either --recent or --favorites");
  if ((parsed.recent || parsed.favorites) && (parsed.route || parsed.search)) {
    throw new Error("model preference views do not accept a route or search");
  }
  return parsed;
}

function filterModels(models: readonly ModelCatalogItem[], search?: string): readonly ModelCatalogItem[] {
  if (!search) return models;
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    const text = `${model.id} ${model.name}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function withoutModels(catalog: ReturnType<typeof routeModelCatalog>) {
  const { models: _models, ...summary } = catalog;
  return summary;
}
