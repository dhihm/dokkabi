import { readConfig, writeConfig } from "./config.ts";
import { assertNoSecrets, containsPrivateInfrastructure } from "./redact.ts";

export interface ModelReference {
  route: string;
  model: string;
}

export interface ModelHistoryEntry extends ModelReference {
  at: string;
}

export interface ModelPreferences {
  recent: ModelHistoryEntry[];
  favorites: ModelReference[];
}

export const MODEL_HISTORY_LIMIT = 5;
export const MODEL_FAVORITES_LIMIT = 50;

/** Validate a route/model pair before it can enter config or a public event. */
export function assertPublicModelReference(reference: ModelReference): ModelReference {
  return normalizeReference(reference);
}

export function readModelPreferences(): ModelPreferences {
  const config = readConfig();
  const recent = normalizeHistory(config.modelHistory).slice(0, MODEL_HISTORY_LIMIT);
  const favorites = normalizeReferences(config.modelFavorites).slice(0, MODEL_FAVORITES_LIMIT);
  return { recent, favorites };
}

export function recordModelSelection(
  reference: ModelReference,
  at = new Date().toISOString(),
): ModelHistoryEntry {
  const normalized = normalizeReference(reference);
  const timestamp = normalizeTimestamp(at);
  const next = {
    ...normalized,
    at: timestamp,
  };
  const current = readModelPreferences();
  const modelHistory = [
    next,
    ...current.recent.filter((entry) => !sameReference(entry, normalized)),
  ].slice(0, MODEL_HISTORY_LIMIT);
  assertNoSecrets(modelHistory);
  // A live picker choice is operator intent for both this session and the next
  // launch. Keep the default pair and recent list in the same config write.
  writeConfig({ route: normalized.route, model: normalized.model, modelHistory });
  return next;
}

/** Return true when the reference was added and false when it was removed. */
export function toggleModelFavorite(reference: ModelReference): boolean {
  const normalized = normalizeReference(reference);
  const current = readModelPreferences();
  const exists = current.favorites.some((entry) => sameReference(entry, normalized));
  const modelFavorites = exists
    ? current.favorites.filter((entry) => !sameReference(entry, normalized))
    : [normalized, ...current.favorites].slice(0, MODEL_FAVORITES_LIMIT);
  assertNoSecrets(modelFavorites);
  writeConfig({ modelFavorites });
  return !exists;
}

function normalizeHistory(value: unknown): ModelHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ModelHistoryEntry[] = [];
  for (const entry of value) {
    try {
      if (typeof entry !== "object" || entry === null) continue;
      const reference = normalizeReference(entry as ModelReference);
      const at = normalizeTimestamp((entry as { at?: unknown }).at);
      if (!out.some((seen) => sameReference(seen, reference))) out.push({ ...reference, at });
    } catch {
      // Hand-edited invalid entries are ignored rather than becoming picker text.
    }
  }
  return out;
}

function normalizeReferences(value: unknown): ModelReference[] {
  if (!Array.isArray(value)) return [];
  const out: ModelReference[] = [];
  for (const entry of value) {
    try {
      const reference = normalizeReference(entry as ModelReference);
      if (!out.some((seen) => sameReference(seen, reference))) out.push(reference);
    } catch {
      // Hand-edited invalid entries are ignored rather than becoming picker text.
    }
  }
  return out;
}

function normalizeReference(value: ModelReference): ModelReference {
  const route = publicIdentifier(value?.route, "model preference route", /^[a-zA-Z0-9._-]+$/u, 128);
  const model = publicIdentifier(value?.model, "model preference model", /^[a-zA-Z0-9._:+/@~-]+$/u, 512);
  const reference = { route, model };
  assertNoSecrets(reference);
  if (containsPrivateInfrastructure(route) || containsPrivateInfrastructure(model)) {
    throw new Error("model preference contains private infrastructure");
  }
  return reference;
}

function publicIdentifier(value: unknown, label: string, pattern: RegExp, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || !pattern.test(text) || text.includes("://")) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("model history timestamp is invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("model history timestamp is invalid");
  }
  return value;
}

function sameReference(left: ModelReference, right: ModelReference): boolean {
  return left.route === right.route && left.model === right.model;
}
