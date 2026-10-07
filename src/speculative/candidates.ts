import { createHash } from "node:crypto";
import { parseExactValue, serializeExactValue } from "./exact-cache-value.ts";

const MAX_PROVENANCE_ID_BYTES = 256;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export type SpeculationTier = 1 | 2 | 3;
export type PredictionSource = "output" | "topology" | "lexical";
export type CandidateProvenance =
  | { readonly kind: "prediction"; readonly source: PredictionSource }
  | { readonly kind: "queued_exact"; readonly callId: string }
  | { readonly kind: "authorized_recipe"; readonly recipeId: string };

export type CandidateSeed = {
  readonly tool: string;
  readonly args: unknown;
  readonly provenance: CandidateProvenance;
};

export type PredictionCandidateSeed = CandidateSeed & {
  readonly provenance: Extract<CandidateProvenance, { readonly kind: "prediction" }>;
};

export type SpeculationCandidate = CandidateSeed & {
  readonly keyDigest: string;
  readonly byteLength: number;
  readonly tier: SpeculationTier;
};

export function createSpeculationCandidate(
  seed: CandidateSeed,
  input: { readonly tier: SpeculationTier; readonly maxCallBytes: number },
): SpeculationCandidate | undefined {
  try {
    const tool = seed.tool;
    const args = seed.args;
    const provenance = cloneProvenance(seed.provenance);
    if (!TOOL_NAME.test(tool) || !provenance) return undefined;
    const encodedArgs = serializeExactValue(args, input.maxCallBytes);
    if (!encodedArgs) return undefined;
    const parsed = parseExactValue(encodedArgs.json);
    if (!parsed.ok) return undefined;
    const encodedKey = serializeExactValue([tool, parsed.value], input.maxCallBytes);
    if (!encodedKey) return undefined;
    return Object.freeze({
      tool,
      args: freezeJson(parsed.value),
      provenance,
      keyDigest: createHash("sha256").update(encodedKey.json, "utf8").digest("hex"),
      byteLength: encodedKey.bytes,
      tier: input.tier,
    });
  } catch (error) {
    if (error instanceof Error) return undefined;
    return undefined;
  }
}

function cloneProvenance(provenance: CandidateProvenance): CandidateProvenance | undefined {
  switch (provenance.kind) {
    case "prediction":
      return isPredictionSource(provenance.source)
        ? Object.freeze({ kind: "prediction", source: provenance.source })
        : undefined;
    case "queued_exact":
      return safeIdentifier(provenance.callId)
        ? Object.freeze({ kind: "queued_exact", callId: provenance.callId })
        : undefined;
    case "authorized_recipe":
      return safeIdentifier(provenance.recipeId)
        ? Object.freeze({ kind: "authorized_recipe", recipeId: provenance.recipeId })
        : undefined;
  }
}

function isPredictionSource(value: string): value is PredictionSource {
  return value === "output" || value === "topology" || value === "lexical";
}

function safeIdentifier(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_PROVENANCE_ID_BYTES
    && !value.includes("\0")
    && isWellFormed(value);
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeJson(nested);
    return Object.freeze(value);
  }
  return value;
}
