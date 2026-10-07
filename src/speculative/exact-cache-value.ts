import { createHash } from "node:crypto";
import type { ExactCall } from "./exact-cache-types.ts";

const MAX_DEPTH = 32;
export const DEFAULT_MAX_CALL_BYTES = 64 * 1024;
export const EXACT_CACHE_DEFAULTS = {
  maxEntries: 32,
  maxResultBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxInFlight: 4,
  maxOutstanding: 8,
  timeoutMs: 2_000,
} as const;

export interface CanonicalExactCall {
  readonly key: string;
  readonly digest: string;
  readonly providerDigest: string;
  readonly call: ExactCall;
}

export interface SerializedExactValue {
  readonly json: string;
  readonly bytes: number;
}

export type ParsedExactValue =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

export function serializeExactValue(
  value: unknown,
  maxBytes: number,
): SerializedExactValue | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return undefined;
  try {
    const budget = { remaining: maxBytes };
    const json = serializeValue(value, budget, new WeakSet(), 0);
    if (json === undefined) return undefined;
    return { json, bytes: maxBytes - budget.remaining };
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}

export function parseExactValue(json: string): ParsedExactValue {
  try {
    const value: unknown = JSON.parse(json);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Error) return { ok: false };
    return { ok: false };
  }
}

export function canonicalExactCall(
  providerName: string,
  call: ExactCall,
  maxBytes: number,
): CanonicalExactCall | undefined {
  try {
    const tool = call.tool;
    const callArgs = call.args;
    if (providerName.length === 0 || tool.length === 0) return undefined;
    const args = serializeExactValue(callArgs, maxBytes);
    if (!args) return undefined;
    const parsedArgs = parseExactValue(args.json);
    if (!parsedArgs.ok) return undefined;
    const keyValue = serializeExactValue([providerName, tool, parsedArgs.value], maxBytes);
    if (!keyValue) return undefined;
    return {
      key: keyValue.json,
      digest: digestExactValue(keyValue.json),
      providerDigest: digestExactValue(providerName),
      call: { tool, args: parsedArgs.value },
    };
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}

export function readExactProviderName(provider: { readonly name: string }): string | undefined {
  try {
    return provider.name;
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}

export function digestExactCall(providerName: string, call: ExactCall): string | undefined {
  return canonicalExactCall(providerName, call, DEFAULT_MAX_CALL_BYTES)?.digest;
}

export function validExactProof(validate: () => boolean): boolean {
  try {
    return validate() === true;
  } catch (error) {
    if (error instanceof Error) return false;
    return false;
  }
}

export function positiveExactBound(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function serializeValue(
  value: unknown,
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null) return take("null", budget);
  if (typeof value === "boolean") return take(value ? "true" : "false", budget);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return take(Object.is(value, -0) ? "0" : String(value), budget);
  }
  if (typeof value === "string") return serializeString(value, budget);
  if (typeof value !== "object" || seen.has(value)) return undefined;
  if (Array.isArray(value)) return serializeArray(value, budget, seen, depth);
  if (!isPlainRecord(value)) return undefined;
  return serializeRecord(value, budget, seen, depth);
}

function serializeString(value: string, budget: { remaining: number }): string | undefined {
  if (Buffer.byteLength(value, "utf8") > budget.remaining) return undefined;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? undefined : take(encoded, budget);
}

function serializeArray(
  value: readonly unknown[],
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): string | undefined {
  if (Object.getOwnPropertySymbols(value).length > 0 || take("[", budget) === undefined) {
    return undefined;
  }
  seen.add(value);
  const parts: string[] = ["["];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return undefined;
    if (index > 0) {
      const comma = take(",", budget);
      if (!comma) return undefined;
      parts.push(comma);
    }
    const item = serializeValue(descriptor.value, budget, seen, depth + 1);
    if (item === undefined) return undefined;
    parts.push(item);
  }
  seen.delete(value);
  const close = take("]", budget);
  if (!close) return undefined;
  parts.push(close);
  return parts.join("");
}

function serializeRecord(
  value: Readonly<Record<string, unknown>>,
  budget: { remaining: number },
  seen: WeakSet<object>,
  depth: number,
): string | undefined {
  if (Object.getOwnPropertySymbols(value).length > 0 || take("{", budget) === undefined) {
    return undefined;
  }
  seen.add(value);
  const parts: string[] = ["{"];
  const keys = Object.keys(value).sort();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    if (index > 0) {
      const comma = take(",", budget);
      if (!comma) return undefined;
      parts.push(comma);
    }
    const encodedKey = serializeString(key, budget);
    const colon = take(":", budget);
    const item = serializeValue(descriptor.value, budget, seen, depth + 1);
    if (encodedKey === undefined || colon === undefined || item === undefined) return undefined;
    parts.push(encodedKey, colon, item);
  }
  seen.delete(value);
  const close = take("}", budget);
  if (!close) return undefined;
  parts.push(close);
  return parts.join("");
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function take(text: string, budget: { remaining: number }): string | undefined {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > budget.remaining) return undefined;
  budget.remaining -= bytes;
  return text;
}

function digestExactValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
