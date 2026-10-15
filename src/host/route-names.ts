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

