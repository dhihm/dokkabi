import { inputData } from "./provider-input.ts";
import { containsSecret, redactText } from "./redact.ts";

/** Normalize once before a tool result enters either Pi or the input ledger.
 * The JSON copy keeps accessors and executable metadata outside that boundary.
 * Safe strings, native status fields and content block order remain unchanged. */
/** One string as it may be emitted: the known secret shapes redacted, and a
 * fixed placeholder when a shape survives the redactor. */
export function redactForEmission(text: string): string {
  if (!containsSecret(text)) return text;
  const redacted = redactText(text);
  return containsSecret(redacted) ? "[redacted tool value]" : redacted;
}

export function safeToolResultInput<T>(value: T): { result: T; redactedStrings: number } {
  const data = inputData(value);
  let redactedStrings = 0;
  function visit(item: unknown): unknown {
    if (typeof item === "string") {
      if (!containsSecret(item)) return item;
      redactedStrings += 1;
      return redactForEmission(item);
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of Object.keys(record)) record[key] = visit(record[key]);
    }
    return item;
  }
  return { result: visit(data) as T, redactedStrings };
}
