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

let legacyOperatorRouteAliases: Readonly<Record<string, string>> = {};

/** Installed from optional internal compat data; never part of the public export. */
export function setLegacyOperatorRouteAliases(aliases: Readonly<Record<string, string>>): void {
  legacyOperatorRouteAliases = aliases;
}

export function normalizeModelRoute(route: string): string {
  const normalized = route.trim().toLowerCase();
  const aliased = MODEL_ROUTE_ALIASES[normalized] ?? normalized;
  return legacyOperatorRouteAliases[aliased] ?? legacyOperatorRouteAliases[normalized] ?? aliased;
}

