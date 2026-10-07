/**
 * Live enumeration of OpenRouter's usable free models.
 *
 * The route catalog hard-codes only a handful of free ids; the free-model
 * multi-agent mode wants the current, complete set. OpenRouter's public
 * `/models` endpoint lists every model with its pricing and context length, so
 * this parses that payload and keeps the free ones — zero prompt+completion
 * price, or the conventional `:free` id suffix. The fetch is injectable so the
 * parse is tested from a fixture and the network call stays at the edge.
 */

export interface FreeModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface FetchLike {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

function isFree(entry: Record<string, unknown>): boolean {
  const id = typeof entry.id === "string" ? entry.id : "";
  if (id.endsWith(":free")) return true;
  const pricing = entry.pricing;
  if (pricing && typeof pricing === "object") {
    const prompt = Number((pricing as Record<string, unknown>).prompt);
    const completion = Number((pricing as Record<string, unknown>).completion);
    return Number.isFinite(prompt) && prompt === 0 && Number.isFinite(completion) && completion === 0;
  }
  return false;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Filter and normalize an OpenRouter /models payload to its free models. */
export function parseOpenRouterFreeModels(payload: unknown): FreeModel[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: FreeModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (!isFree(entry)) continue;
    const contextWindow = toNumber(entry.context_length, 0);
    const topProvider = entry.top_provider && typeof entry.top_provider === "object"
      ? (entry.top_provider as Record<string, unknown>)
      : {};
    const maxTokens = toNumber(topProvider.max_completion_tokens, Math.min(contextWindow, 4096));
    const params = Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters.filter((p): p is string => typeof p === "string")
      : [];
    const reasoning = params.includes("reasoning") || params.includes("include_reasoning");
    out.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      contextWindow,
      maxTokens,
      reasoning,
    });
  }
  return out;
}

/**
 * Fetch and parse the free models. Returns [] on any transport or shape
 * failure — a missing roster degrades the mode to "no free models", never a
 * thrown turn. `fetchImpl` defaults to the global fetch and is injected in
 * tests.
 */
export async function fetchOpenRouterFreeModels(
  fetchImpl: (url: string) => Promise<FetchLike> = fetch as unknown as (url: string) => Promise<FetchLike>,
): Promise<FreeModel[]> {
  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL);
    if (!response.ok) return [];
    return parseOpenRouterFreeModels(await response.json());
  } catch {
    return [];
  }
}
