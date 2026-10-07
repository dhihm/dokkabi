import type { EventRecord } from "../host/schema.ts";
import type { SpeculativeMode } from "./mode.ts";
import { isSpeculationV2Event } from "./events-v2-schema.ts";

const HEX_256 = /^[0-9a-f]{64}$/u;

export interface SpeculationConfigReference {
  readonly seq: number;
  readonly name: "config";
  readonly mode: SpeculativeMode;
  readonly rules_digest?: string;
}

export interface SpeculationResolvedReference {
  readonly seq: number;
  readonly name: "resolved";
  readonly tool: "read";
  readonly key_digest: string;
  readonly outcome: "hit" | "stale" | "drop";
}

export interface SpeculationMissReference {
  readonly seq: number;
  readonly name: "miss";
  readonly tool: "read";
  readonly key_digest: string;
}

export type SpeculationReference =
  | SpeculationConfigReference
  | SpeculationResolvedReference
  | SpeculationMissReference;

export interface SpeculationDashboardState {
  readonly mode: SpeculativeMode;
  readonly rulesDigest: string | "missing";
  readonly scheduled: number;
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly drops: number;
  readonly hitRatePpm: number;
}

export function projectSpeculationReferences(
  events: readonly EventRecord[],
  featureStart: number | undefined,
  v2FeatureStart?: number,
): SpeculationReference[] {
  if (featureStart === undefined) return [];
  const references: SpeculationReference[] = [];
  let mode: SpeculativeMode | undefined;
  for (const event of events) {
    if (event.seq < featureStart || !event.name.startsWith("speculation/")) continue;
    if (v2FeatureStart !== undefined && event.seq >= v2FeatureStart && isSpeculationV2Event(event.name)) continue;
    if (event.name === "speculation/config") {
      const config = configReference(event);
      references.push(config);
      mode = config.mode;
      continue;
    }
    const outcome = outcomeReference(event);
    if (!mode) throw new Error(`speculation event has no active config at seq ${event.seq}`);
    if (mode === "off") {
      throw new Error(`speculation event occurred while disabled at seq ${event.seq}`);
    }
    references.push(outcome);
  }
  return references;
}

export function summarizeSpeculations(
  references: readonly SpeculationReference[],
): SpeculationDashboardState | undefined {
  let mode: SpeculativeMode | undefined;
  let rulesDigest: string | "missing" = "missing";
  let scheduled = 0;
  let hits = 0;
  let misses = 0;
  let stale = 0;
  let drops = 0;
  for (const reference of references) {
    if (reference.name === "config") {
      mode = reference.mode;
      rulesDigest = reference.rules_digest ?? "missing";
    } else if (reference.name === "miss") misses += 1;
    else {
      scheduled += 1;
      if (reference.outcome === "hit") hits += 1;
      else if (reference.outcome === "stale") stale += 1;
      else drops += 1;
    }
  }
  if (!mode) return undefined;
  return {
    mode,
    rulesDigest,
    scheduled,
    hits,
    misses,
    stale,
    drops,
    hitRatePpm: scheduled === 0 ? 0 : Math.floor((hits * 1_000_000) / scheduled),
  };
}

function configReference(event: EventRecord): SpeculationConfigReference {
  const payload = event.payload;
  const expected = payload.rules_digest === undefined ? ["mode"] : ["mode", "rules_digest"];
  if (
    !exactKeys(payload, expected)
    || !isMode(payload.mode)
    || (payload.rules_digest !== undefined
      && (typeof payload.rules_digest !== "string" || !HEX_256.test(payload.rules_digest)))
  ) {
    throw new Error(`invalid speculation event at seq ${event.seq}`);
  }
  return {
    seq: event.seq,
    name: "config",
    mode: payload.mode,
    ...(typeof payload.rules_digest === "string" ? { rules_digest: payload.rules_digest } : {}),
  };
}

function outcomeReference(event: EventRecord): SpeculationResolvedReference | SpeculationMissReference {
  const name = event.name.slice("speculation/".length);
  if (name === "resolved") {
    if (
      !exactKeys(event.payload, ["key_digest", "outcome", "tool"])
      || event.payload.tool !== "read"
      || typeof event.payload.key_digest !== "string"
      || !HEX_256.test(event.payload.key_digest)
      || !isResolution(event.payload.outcome)
    ) {
      throw new Error(`invalid speculation event at seq ${event.seq}`);
    }
    return {
      seq: event.seq,
      name,
      tool: "read",
      key_digest: event.payload.key_digest,
      outcome: event.payload.outcome,
    };
  }
  if (
    name !== "miss"
    || !exactKeys(event.payload, ["key_digest", "tool"])
    || event.payload.tool !== "read"
    || typeof event.payload.key_digest !== "string"
    || !HEX_256.test(event.payload.key_digest)
  ) {
    throw new Error(`invalid speculation event at seq ${event.seq}`);
  }
  return { seq: event.seq, name: "miss", tool: "read", key_digest: event.payload.key_digest };
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isMode(value: unknown): value is SpeculativeMode {
  return value === "off" || value === "read-only" || value === "full";
}

function isResolution(value: unknown): value is SpeculationResolvedReference["outcome"] {
  return value === "hit" || value === "stale" || value === "drop";
}
