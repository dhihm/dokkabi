import type { DashPickerCandidate } from "../dash/tui.ts";
import type { ModelPreferences } from "../host/model-preferences.ts";
import type { RouteModelCatalog } from "../plugins/model-catalog.ts";

export interface ModelPickerRoute {
  name: string;
  provider: string;
  defaultModel?: string;
}

export function buildModelPickerCandidates(input: {
  routes: readonly ModelPickerRoute[];
  catalogs: readonly RouteModelCatalog[];
  selection: { route: string; model?: string };
  preferences: ModelPreferences;
}): DashPickerCandidate[] {
  const catalogs = new Map(input.catalogs.map((catalog) => [catalog.route, catalog]));
  const routeNames = new Set(input.routes.map((route) => route.name));
  const known = new Map<string, { name: string }>();
  for (const catalog of input.catalogs) {
    for (const model of catalog.models) {
      known.set(`${catalog.route}/${model.id}`, { name: model.name });
    }
  }
  for (const route of input.routes) {
    const localModels = [
      route.defaultModel,
      input.selection.route === route.name ? input.selection.model : undefined,
    ];
    for (const model of localModels) {
      if (!model) continue;
      const key = `${route.name}/${model}`;
      if (!known.has(key)) known.set(key, { name: model });
    }
  }
  const selected = (route: string, model: string) =>
    input.selection.route === route && input.selection.model === model ? " · selected" : "";
  const out: DashPickerCandidate[] = [];
  for (const recent of input.preferences.recent) {
    if (!routeNames.has(recent.route)) continue;
    const model = known.get(`${recent.route}/${recent.model}`) ?? { name: recent.model };
    out.push({
      value: `${recent.route}/${recent.model}`,
      summary: `Recent · ${model.name} · ${recent.route}${selected(recent.route, recent.model)} · ${recent.at}`,
      kind: "model",
      route: recent.route,
      section: "recent",
    });
  }
  for (const favorite of input.preferences.favorites) {
    if (!routeNames.has(favorite.route)) continue;
    const model = known.get(`${favorite.route}/${favorite.model}`) ?? { name: favorite.model };
    out.push({
      value: `${favorite.route}/${favorite.model}`,
      summary: `Favorite ★ · ${model.name} · ${favorite.route}${selected(favorite.route, favorite.model)}`,
      kind: "model",
      route: favorite.route,
      section: "favorite",
    });
  }
  for (const route of input.routes) {
    const catalog = catalogs.get(route.name);
    const fallbackModels = new Set([
      route.defaultModel,
      input.selection.route === route.name ? input.selection.model : undefined,
    ].filter((model): model is string => Boolean(model)));
    const extraCount = [...fallbackModels]
      .filter((model) => !catalog?.models.some((item) => item.id === model))
      .length;
    const total = (catalog?.total ?? 0) + extraCount;
    out.push({
      value: route.name,
      summary: `${route.provider} · ${total} models · default ${route.defaultModel ?? "provider model"} ›`,
      kind: "route",
      route: route.name,
      section: "vendor",
    });
  }
  for (const catalog of input.catalogs) {
    for (const model of catalog.models) {
      const source = model.source === "supplement" ? " · official supplement" : "";
      out.push({
        value: `${catalog.route}/${model.id}`,
        summary: `${model.name} · ${catalog.route}${selected(catalog.route, model.id)}${source}`,
        kind: "model",
        route: catalog.route,
        section: "catalog",
      });
    }
  }
  for (const route of input.routes) {
    const fallbackModels = new Set([
      route.defaultModel,
      input.selection.route === route.name ? input.selection.model : undefined,
    ].filter((model): model is string => Boolean(model)));
    for (const model of fallbackModels) {
      if (catalogs.get(route.name)?.models.some((item) => item.id === model)) continue;
      const label = model === route.defaultModel ? "route default" : "current selection";
      out.push({
        value: `${route.name}/${model}`,
        summary: `${model} · ${route.name}${selected(route.name, model)} · ${label}`,
        kind: "model",
        route: route.name,
        section: "catalog",
      });
    }
  }
  return out;
}
