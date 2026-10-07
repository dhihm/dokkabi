import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { SpeculativeMode } from "./mode.ts";
import {
  createSpeculativeReadBudget,
  type SpeculativeReadBudget,
} from "./prefetch-budget.ts";
import { extractReadPredictions, safeRelativeFile } from "./targets.ts";
import { createToolPredictor, type SpeculativeRules } from "./rules.ts";
import { relatedCoEdits } from "./coedit.ts";
import {
  currentFingerprint,
  sameFingerprint,
  type FileFingerprint,
} from "./prefetch-file.ts";
import {
  createPrefetchLifecycle,
  type SpeculationEvent,
  type SpeculationSnapshot,
} from "./prefetch-lifecycle.ts";
import { startPrefetch } from "./prefetch-task.ts";
export { extractReadPredictions } from "./targets.ts";
export type { ReadPrediction } from "./targets.ts";
export type { SpeculationEvent, SpeculationSnapshot } from "./prefetch-lifecycle.ts";

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 4;
const DEFAULT_MAX_OUTSTANDING = 8;
const DEFAULT_TIMEOUT_MS = 2_000;
export interface PrefetchObservation {
  readonly tool: string;
  readonly text: string;
  readonly isError: boolean;
  readonly exitCode?: number | null;
}

export interface ReadOnlySpeculation {
  readonly tools: readonly AgentTool[];
  project(tools: readonly AgentTool[]): readonly AgentTool[];
  observe(observation: PrefetchObservation): void;
  idle(): Promise<void>;
  snapshot(): SpeculationSnapshot;
  dispose(): void;
}

interface CacheEntry {
  readonly fingerprint: FileFingerprint;
  readonly result: AgentToolResult<unknown>;
}

export function createReadOnlySpeculation(input: {
  readonly mode: SpeculativeMode;
  readonly workspaceRoot: string;
  readonly tools: readonly AgentTool[];
  readonly maxEntries?: number;
  readonly maxInFlight?: number;
  readonly maxOutstanding?: number;
  readonly maxResultBytes?: number;
  readonly timeoutMs?: number;
  readonly readBudget?: SpeculativeReadBudget;
  readonly onEvent?: (event: SpeculationEvent) => void;
  readonly rules?: SpeculativeRules;
}): ReadOnlySpeculation {
  const sourceRead = input.tools.find((tool) => tool.name === "read");
  if (input.mode === "off" || !sourceRead) return disabledRuntime(input.tools);
  const predict = input.rules ? createToolPredictor(input.rules) : undefined;
  const root = realpathSync(input.workspaceRoot);
  const maxEntries = positiveBound(input.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxInFlight = positiveBound(input.maxInFlight, DEFAULT_MAX_IN_FLIGHT);
  const maxOutstanding = Math.max(
    maxInFlight,
    positiveBound(input.maxOutstanding, DEFAULT_MAX_OUTSTANDING),
  );
  const maxResultBytes = positiveBound(input.maxResultBytes, DEFAULT_MAX_RESULT_BYTES);
  const timeoutMs = positiveBound(input.timeoutMs, DEFAULT_TIMEOUT_MS);
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  const readBudget = input.readBudget ?? createSpeculativeReadBudget();
  let disposed = false;
  const lifecycle = createPrefetchLifecycle(input.onEvent);

  const wrappedRead: AgentTool = {
    ...sourceRead,
    async execute(id, params, signal, onUpdate) {
      const path = exactReadPath(params);
      if (path) {
        const key = readKey(path);
        const entry = cache.get(key);
        if (entry) {
          cache.delete(key);
          if (sameFingerprint(entry.fingerprint, currentFingerprint(root, path, maxResultBytes))) {
            lifecycle.close(key, "hit");
            return structuredClone(entry.result);
          }
          lifecycle.close(key, "stale");
        }
        pending.get(key)?.abort();
      }
      lifecycle.miss(path ? keyDigest(readKey(path)) : undefined);
      return sourceRead.execute(id, params, signal, onUpdate);
    },
  };

  const schedule = (path: string): void => {
    if (disposed) return;
    const key = readKey(path);
    if (cache.has(key) || pending.has(key)) return;
    if (tasks.size >= maxInFlight || !readBudget.hasCapacity(maxOutstanding)) {
      lifecycle.begin(key, keyDigest(key));
      lifecycle.close(key, "drop");
      return;
    }
    const controller = new AbortController();
    pending.set(key, controller);
    lifecycle.begin(key, keyDigest(key));
    const attempt = startPrefetch({
      sourceRead,
      root,
      path,
      controller,
      timeoutMs,
      maxSourceBytes: maxResultBytes,
    });
    readBudget.track(attempt.active);
    const task = attempt.result
      .then((prefetched) => {
        const after = prefetched
          ? currentFingerprint(root, path, maxResultBytes)
          : undefined;
        if (
          disposed || !prefetched || !sameFingerprint(prefetched.fingerprint, after)
          || resultBytes(prefetched.result) > maxResultBytes
        ) {
          lifecycle.close(key, "drop");
          return;
        }
        cache.set(key, { fingerprint: prefetched.fingerprint, result: prefetched.result });
        while (cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) {
            cache.delete(oldest);
            lifecycle.close(oldest, "drop");
          }
        }
      })
      .finally(() => {
        pending.delete(key);
        tasks.delete(task);
      });
    tasks.add(task);
  };

  return {
    tools: input.tools.map((tool) => tool === sourceRead ? wrappedRead : tool),
    project: (tools) => tools.map((tool) => tool === sourceRead ? wrappedRead : tool),
    observe(observation) {
      if (disposed) return;
      if (predict && predict(
        observation.tool,
        observation.isError,
        observation.exitCode ?? null,
      ) !== "read") return;
      const direct = extractReadPredictions({
        workspaceRoot: root,
        tool: observation.tool,
        text: observation.text,
      });
      const related = input.rules
        ? relatedCoEdits(input.rules.co_edits, direct.map((prediction) => prediction.path), 4)
          .flatMap((path) => {
            const safe = safeRelativeFile(root, path);
            return safe ? [{ path: safe }] : [];
          })
        : [];
      for (const prediction of [...direct, ...related]) schedule(prediction.path);
    },
    async idle() {
      await Promise.all([...tasks]);
    },
    snapshot: lifecycle.snapshot,
    dispose() {
      disposed = true;
      for (const controller of pending.values()) controller.abort();
      lifecycle.closeAll();
      pending.clear();
      cache.clear();
    },
  };
}

function exactReadPath(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const params = value as Record<string, unknown>;
  return Object.keys(params).length === 1 && typeof params.path === "string" ? params.path : undefined;
}

function readKey(path: string): string {
  return JSON.stringify({ path });
}

function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function resultBytes(result: AgentToolResult<unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(result), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

function disabledRuntime(tools: readonly AgentTool[]): ReadOnlySpeculation {
  return {
    tools,
    project: (projected) => projected,
    observe() {},
    async idle() {},
    snapshot: () => ({ scheduled: 0, hits: 0, misses: 0, stale: 0, dropped: 0 }),
    dispose() {},
  };
}
