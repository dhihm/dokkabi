import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { deriveMessages } from "./derive-messages.ts";
import type { EventRecord } from "./schema.ts";

/** Frozen prefix only: system + tool schemas. Growing surface must not change this. */
export function frozenPrefixHash(input: {
  systemPrompt: string;
  toolSchemas: unknown;
}): string {
  const body = canonicalJson({
    systemPrompt: input.systemPrompt,
    toolSchemas: input.toolSchemas,
  });
  return createHash("sha256").update(body).digest("hex");
}

/** Component hashes explain a frozen-prefix mismatch without logging either
 * model-facing component. */
export function systemPromptHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex");
}

export function toolSchemaHash(toolSchemas: unknown): string {
  return createHash("sha256").update(canonicalJson(toolSchemas)).digest("hex");
}

/** Full transcript hash. Used to detect rewritten surface, not to seal the prefix. */
export function prefixHash(input: {
  systemPrompt: string;
  toolSchemas: unknown;
  events: readonly EventRecord[];
}): string {
  const body = canonicalJson({
    systemPrompt: input.systemPrompt,
    toolSchemas: input.toolSchemas,
    messages: deriveMessages(input.events),
  });
  return createHash("sha256").update(body).digest("hex");
}

export function lastPromptSeal(events: readonly EventRecord[]): EventRecord | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.name === "prompt/seal") {
      return events[i];
    }
  }
  return undefined;
}

/** The only reasons a sealed prefix may change (docs/cache.md). */
export const ALLOWED_SEAL_REASONS = ["compaction", "tools_changed", "skill_set_changed"] as const;

/** A seal event is valid only with a constitution reason. */
export function assertSealEvent(event: EventRecord): void {
  const reason = event.payload.reason;
  if (typeof reason !== "string" || !(ALLOWED_SEAL_REASONS as readonly string[]).includes(reason)) {
    throw new Error(
      `prompt/seal reason must be one of ${ALLOWED_SEAL_REASONS.join(" | ")}, got ${JSON.stringify(reason)}`,
    );
  }
}

/**
 * The pre-model assertion (constitution 4): the frozen prefix hash must equal
 * the last seal's hash. A drift means the model-facing surface moved without
 * a seal — refuse to call the model, explicitly.
 */
export function assertPrefixMatchesSeal(input: {
  systemPrompt: string;
  toolSchemas: unknown;
  events: readonly EventRecord[];
}): void {
  const last = lastPromptSeal(input.events);
  if (!last) {
    throw new Error("no prompt/seal in the log; refusing to call the model on an unsealed prefix");
  }
  assertSealEvent(last);
  const expected = frozenPrefixHash({ systemPrompt: input.systemPrompt, toolSchemas: input.toolSchemas });
  const sealed = typeof last.payload.prefix_hash === "string" ? last.payload.prefix_hash : undefined;
  if (sealed !== expected) {
    throw new Error(
      `prefix_hash drifted without prompt/seal: sealed ${sealed ?? "(missing)"} != frozen ${expected}`,
    );
  }
}

const RUNTIME_MARKERS =
  /Date\.now\(\)|new Date\(|process\.pid|graph_rev|current time \d{1,2}:\d{2}/i;

/**
 * Cache hygiene: a system prompt carrying wall-clock, pid, or rev markers
 * breaks the frozen prefix and the replay contract — fail the boot.
 */
export function assertNoRuntimeMarkers(systemPrompt: string): void {
  if (RUNTIME_MARKERS.test(systemPrompt)) {
    throw new Error(
      "system prompt contains runtime markers (clock, pid, or graph_rev); the prefix would never be stable",
    );
  }
}

/** Seal the full adapter-visible declaration, including argument schemas.
 * Runtime execution closures and UI labels do not belong to the prefix. */
export function toolSchemaSnapshot(tools: readonly { name: string; description?: string }[]): Array<{
  name: string;
  description: string;
} & Record<string, unknown>> {
  return tools.map((tool) => {
    const { execute: _execute, label: _label, ...data } = tool as Record<string, unknown>;
    return JSON.parse(canonicalJson({ ...data, name: tool.name, description: tool.description ?? "" }));
  });
}

export function sameToolSchemas(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? []) === canonicalJson(right ?? []);
}
