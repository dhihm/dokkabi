import { z } from "zod";
import type { EventRecord } from "../host/schema.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const common = { seq: z.number().int().positive().safe() };
const tool = z.enum(["read", "grep", "glob", "git_status", "git_diff", "probe_log", "edit", "write", "bash", "ssh"]);
export const speculationV2Schema = z.discriminatedUnion("name", [
  z.strictObject({ ...common, name: z.literal("config_v2"), mode: z.enum(["off", "read-only", "full"]), predictor_digest: digest.optional() }),
  z.strictObject({ ...common, name: z.literal("prepare"), candidate_id: digest, key_digest: digest,
    provider_digest: digest, tool, tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    source: z.enum(["prediction", "queued_exact", "authorized_recipe"]) }),
  z.strictObject({ ...common, name: z.literal("resolve"), candidate_id: digest,
    outcome: z.enum(["hit", "stale", "drop", "warm_only", "promoted", "failed", "cancelled"]),
    latency_bucket: z.enum(["under_1ms", "under_10ms", "under_100ms", "under_1s", "at_least_1s"]) }),
  z.strictObject({ ...common, name: z.literal("recover"), candidate_id: digest, outcome: z.enum(["restored", "cleaned", "refused"]) }),
  z.strictObject({ ...common, name: z.literal("miss_v2"), key_digest: digest, provider_digest: digest, tool,
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
]);

export type SpeculationV2Reference = Readonly<z.infer<typeof speculationV2Schema>>;
export type SpeculationPrepareReference = Extract<SpeculationV2Reference, { name: "prepare" }>;

const eventNames = new Set(["speculation/config_v2", "speculation/prepare", "speculation/resolve", "speculation/recover", "speculation/miss_v2"]);
export function isSpeculationV2Event(name: string): boolean { return eventNames.has(name); }

export class SpeculationV2Error extends Error {
  readonly code = "invalid_speculation_v2" as const;
  constructor(seq: number) { super(`invalid speculation v2 lifecycle at seq ${seq}`); }
}

export function parseSpeculationV2Event(event: EventRecord): SpeculationV2Reference {
  if (event.kind !== "observe" || Object.hasOwn(event.payload, "seq") || Object.hasOwn(event.payload, "name")) {
    throw new SpeculationV2Error(event.seq);
  }
  const parsed = speculationV2Schema.safeParse({ ...event.payload, seq: event.seq, name: event.name.slice("speculation/".length) });
  if (!parsed.success) throw new SpeculationV2Error(event.seq);
  return parsed.data;
}

export function validTierTool(tier: 1 | 2 | 3, tool: string): boolean {
  switch (tier) {
    case 1: return ["read", "grep", "glob", "git_status", "git_diff", "probe_log"].includes(tool);
    case 2: return ["edit", "write", "bash"].includes(tool);
    case 3: return ["bash", "ssh"].includes(tool);
    default: return unreachable(tier);
  }
}

export function unreachable(value: never): never {
  throw new TypeError(`unexpected speculation variant: ${String(value)}`);
}
