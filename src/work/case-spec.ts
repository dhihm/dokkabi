import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import { isCheckCase } from "./ledger-check.ts";
import type { LedgerCase } from "./plan-ledger.ts";

/**
 * The spec digest of a case (D49), in a file of its own so every reader —
 * the recheck (recheck.ts), the verifier's findings (verified-work.ts) and the
 * `defect` tool, which binds a named property's spec when the defect is
 * reported (D58b V3) — computes one digest without an import cycle.
 */

/** The spec a recheck identity is keyed on: what the case runs and, for a
 * `check` case, what it is fed and judged by. */
export interface RecheckSpec {
  readonly command: string;
  readonly dir?: string;
  readonly stdin?: LedgerCase["stdin"];
  readonly files?: LedgerCase["files"];
  readonly expect?: LedgerCase["expect"];
  readonly property?: LedgerCase["property"];
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A recorded text's digest; null for anything that is not a recorded text
 * (D58c V5': a digest never throws on the data it is given — every spec the
 * tools record digests exactly as before). */
function digestOf(text: unknown): string | null {
  const digest = typeof text === "object" && text !== null ? (text as { readonly digest?: unknown }).digest : undefined;
  return typeof digest === "string" ? digest : null;
}

/** The fixtures' digests by path, sorted. */
function fileDigests(files: unknown): [string, string | null][] {
  if (typeof files !== "object" || files === null || Array.isArray(files)) return [];
  return Object.entries(files as Record<string, unknown>).map(([path, text]): [string, string | null] => [path, digestOf(text)]).sort();
}

/** The digest of a case's spec (D49): the command and dir, and for a `check`
 * case the digests of its stdin and fixtures and its expectations; for a
 * `property` case (D58) the digests of its fixtures and its property (the
 * principle and the bounds). Two declarations with the same digest run and
 * are judged the same way. A case of neither kind digests as before. */
export function recheckSpecDigest(spec: RecheckSpec): string {
  const check = isCheckCase(spec);
  const property = spec.property !== undefined;
  return sha256(canonicalJson({
    command: spec.command,
    dir: spec.dir ?? null,
    ...(check
      ? {
        stdin: digestOf(spec.stdin),
        files: fileDigests(spec.files),
        expect: spec.expect ?? null,
      }
      : {}),
    ...(property
      ? {
        files: fileDigests(spec.files),
        property: spec.property,
      }
      : {}),
  }));
}

/** The spec digest of a declared ledger case: what a recheck identity of it
 * is keyed on. */
export function caseSpecDigest(item: LedgerCase): string {
  return recheckSpecDigest({
    command: typeof item.command === "string" ? item.command : "",
    ...(typeof item.dir === "string" && item.dir.length > 0 ? { dir: item.dir } : {}),
    ...(item.stdin !== undefined ? { stdin: item.stdin } : {}),
    ...(item.files !== undefined ? { files: item.files } : {}),
    ...(item.expect !== undefined ? { expect: item.expect } : {}),
    ...(item.property !== undefined ? { property: item.property } : {}),
  });
}
