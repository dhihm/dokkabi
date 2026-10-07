import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const REJECT = Symbol("reject");
const MAX_DEPTH = 32;
type CloneResult = unknown | typeof REJECT;

export interface BoundedValueSnapshot {
  readonly value: unknown;
  readonly bytes: number;
}

export function boundedValueSnapshot(value: unknown, maxBytes: number): BoundedValueSnapshot | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return undefined;
  const budget = { remaining: maxBytes };
  const cloned = cloneValue(value, budget, new WeakSet(), 0);
  return cloned === REJECT ? undefined : { value: cloned, bytes: maxBytes - budget.remaining };
}

export function boundedResultClone(
  result: AgentToolResult<unknown>,
  maxBytes: number,
): AgentToolResult<unknown> | undefined {
  const snapshot = boundedValueSnapshot(result, maxBytes);
  return snapshot && isAgentToolResult(snapshot.value) ? snapshot.value : undefined;
}

function cloneValue(
  value: unknown,
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): CloneResult {
  if (depth > MAX_DEPTH) return REJECT;
  if (value === null) return take(budget, 4) ? null : REJECT;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") + 2 > budget.remaining) return REJECT;
    return take(budget, Buffer.byteLength(JSON.stringify(value), "utf8")) ? value : REJECT;
  }
  if (typeof value === "boolean") return take(budget, 5) ? value : REJECT;
  if (typeof value === "number") {
    return Number.isFinite(value) && take(budget, 24) ? value : REJECT;
  }
  if (value === undefined) return take(budget, 4) ? undefined : REJECT;
  if (typeof value !== "object" || seen.has(value)) return REJECT;
  if (Array.isArray(value)) return cloneArray(value, budget, seen, depth);
  if (!isPlainRecord(value)) return REJECT;
  return cloneRecord(value, budget, seen, depth);
}

function cloneArray(
  value: readonly unknown[],
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): CloneResult {
  if (value.length > budget.remaining || !take(budget, 2 + Math.max(0, value.length - 1))) {
    return REJECT;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return REJECT;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      return REJECT;
    }
  }
  seen.add(value);
  const cloned = new Array<unknown>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      if (!take(budget, 4)) return REJECT;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return REJECT;
    const item = cloneValue(descriptor.value, budget, seen, depth + 1);
    if (item === REJECT) return REJECT;
    cloned[index] = item;
  }
  seen.delete(value);
  return cloned;
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>,
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): CloneResult {
  if (!take(budget, 2) || Object.getOwnPropertySymbols(value).length > 0) return REJECT;
  seen.add(value);
  const cloned: Record<string, unknown> = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return REJECT;
    if (Buffer.byteLength(key, "utf8") + 4 > budget.remaining) return REJECT;
    if (!take(budget, Buffer.byteLength(JSON.stringify(key), "utf8") + 2)) return REJECT;
    const item = cloneValue(descriptor.value, budget, seen, depth + 1);
    if (item === REJECT) return REJECT;
    Object.defineProperty(cloned, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  seen.delete(value);
  return cloned;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return isPlainRecordValue(value) && Array.isArray(value.content);
}

function isPlainRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && isPlainRecord(value);
}

function take(budget: { remaining: number }, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remaining) return false;
  budget.remaining -= bytes;
  return true;
}
