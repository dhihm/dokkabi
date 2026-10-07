import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import type { SwarmRole } from "./routes.ts";
import { assertSwarmWorldSpec, type SwarmWorldSpec } from "./world.ts";

export type SwarmAcceptanceOwner = "child" | "parent_reviewer";

export interface SwarmCapabilityProfileV1 {
  readonly format: 1;
  readonly pluginManifestDigest: string;
  readonly toolSchemaDigest: string;
  readonly route: string;
  readonly providerId: string;
  readonly authKind: "oauth" | "plan_key";
  readonly hasNetwork: boolean;
}

export interface SwarmDispatchContractV1 {
  readonly format: 1;
  readonly parentSession: string;
  readonly parentOpenSeq: number;
  readonly operatorOrderDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly role: SwarmRole;
  readonly route: string;
  readonly worldDigest: string;
  readonly capabilityProfileDigest: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly acceptanceOwner: SwarmAcceptanceOwner;
  /** 돗가비 장터 recipe seal (#60): present exactly when a recipe fixed
   * this dispatch. A changed recipe is a changed child contract; absence
   * keeps the pre-market contract byte-identical (#60 S1/S2). */
  readonly recipeDigest?: string;
}

export interface SwarmDispatchContractV2 {
  readonly format: 2;
  readonly parentSession: string;
  readonly parentOpenSeq: number;
  readonly operatorOrderDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly repositoryDigest: string;
  readonly memoryViewDigest: string;
  readonly role: SwarmRole;
  readonly route: string;
  readonly worldDigest: string;
  readonly capabilityProfileDigest: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly acceptanceOwner: SwarmAcceptanceOwner;
  /** See SwarmDispatchContractV1.recipeDigest. */
  readonly recipeDigest?: string;
}

export type SwarmDispatchContract = SwarmDispatchContractV1 | SwarmDispatchContractV2;

export type PublicSwarmWorldFactV1 =
  | { readonly kind: "local"; readonly network: "allow" | "deny" }
  | {
      readonly kind: "docker";
      readonly network: "allow" | "deny";
      readonly image_digest: string;
    };

const HEX = /^[a-f0-9]{64}$/;
const CONTRACT_KEYS = [
  "acceptanceOwner",
  "capabilityProfileDigest",
  "format",
  "maxSteps",
  "operatorOrderDigest",
  "parentOpenSeq",
  "parentSession",
  "role",
  "route",
  "sourceSnapshotDigest",
  "timeoutMs",
  "worldDigest",
] as const;
const CONTRACT_V2_KEYS = [
  ...CONTRACT_KEYS,
  "memoryViewDigest",
  "repositoryDigest",
] as const;
const PROFILE_KEYS = [
  "authKind",
  "format",
  "hasNetwork",
  "pluginManifestDigest",
  "providerId",
  "route",
  "toolSchemaDigest",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase hex digest`);
  }
}

function requirePositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function operatorOrderDigest(order: string): string {
  return sha256(order);
}

export function publicSwarmWorldFact(
  world: SwarmWorldSpec,
  imageIdentityDigest?: string,
): PublicSwarmWorldFactV1 {
  assertSwarmWorldSpec(world);
  if (imageIdentityDigest !== undefined) requireDigest(imageIdentityDigest, "swarm world image identity digest");
  return world.kind === "local"
    ? { kind: "local", network: world.network }
    : { kind: "docker", network: world.network, image_digest: imageIdentityDigest ?? sha256(world.image) };
}

export function assertPublicSwarmWorldFact(value: unknown): asserts value is PublicSwarmWorldFactV1 {
  requireObject(value, "public swarm world fact");
  if (value.kind !== "local" && value.kind !== "docker") {
    throw new Error("public swarm world fact kind is invalid");
  }
  if (value.network !== "allow" && value.network !== "deny") {
    throw new Error("public swarm world fact network is invalid");
  }
  requireExactKeys(
    value,
    value.kind === "docker" ? ["image_digest", "kind", "network"] : ["kind", "network"],
    "public swarm world fact",
  );
  if (value.kind === "docker") requireDigest(value.image_digest, "public swarm world image digest");
}

export function publicSwarmWorldFactDigest(fact: PublicSwarmWorldFactV1): string {
  assertPublicSwarmWorldFact(fact);
  return sha256(canonicalJson(fact));
}

export function swarmWorldDigest(world: SwarmWorldSpec, imageIdentityDigest?: string): string {
  return publicSwarmWorldFactDigest(publicSwarmWorldFact(world, imageIdentityDigest));
}

export function assertSwarmCapabilityProfile(
  value: unknown,
): asserts value is SwarmCapabilityProfileV1 {
  requireObject(value, "swarm capability profile");
  requireExactKeys(value, PROFILE_KEYS, "swarm capability profile");
  if (value.format !== 1) throw new Error("swarm capability profile format must be 1");
  requireDigest(value.pluginManifestDigest, "plugin manifest digest");
  requireDigest(value.toolSchemaDigest, "tool schema digest");
  requireText(value.route, "capability route");
  requireText(value.providerId, "capability provider id");
  if (value.authKind !== "oauth" && value.authKind !== "plan_key") {
    throw new Error("capability auth kind is invalid");
  }
  if (typeof value.hasNetwork !== "boolean") {
    throw new Error("capability network policy must be boolean");
  }
}

export function swarmCapabilityProfileDigest(profile: SwarmCapabilityProfileV1): string {
  assertSwarmCapabilityProfile(profile);
  return sha256(canonicalJson(profile));
}

export function assertSwarmDispatchContract(value: unknown): asserts value is SwarmDispatchContract {
  requireObject(value, "swarm dispatch contract");
  if (value.format !== 1 && value.format !== 2) {
    throw new Error("swarm dispatch contract format must be 1 or 2");
  }
  // recipeDigest is the one optional key (#60): a contract without it stays
  // byte-identical to the pre-market shape, and nothing else may ride along.
  const base = value.format === 2 ? CONTRACT_V2_KEYS : CONTRACT_KEYS;
  requireExactKeys(
    value,
    "recipeDigest" in value ? [...base, "recipeDigest"] : base,
    "swarm dispatch contract",
  );
  if ("recipeDigest" in value) requireDigest(value.recipeDigest, "recipe digest");
  requireText(value.parentSession, "parent session");
  requirePositiveInteger(value.parentOpenSeq, "parent open seq");
  requireDigest(value.operatorOrderDigest, "operator order digest");
  requireDigest(value.sourceSnapshotDigest, "source snapshot digest");
  if (value.format === 2) {
    requireDigest(value.repositoryDigest, "repository digest");
    requireDigest(value.memoryViewDigest, "memory view digest");
  }
  if (value.role !== "lead" && value.role !== "scout" && value.role !== "builder" && value.role !== "reviewer") {
    throw new Error("swarm dispatch role is invalid");
  }
  requireText(value.route, "dispatch route");
  requireDigest(value.worldDigest, "world digest");
  requireDigest(value.capabilityProfileDigest, "capability profile digest");
  requirePositiveInteger(value.maxSteps, "max steps");
  requirePositiveInteger(value.timeoutMs, "timeout ms");
  if (value.acceptanceOwner !== "child" && value.acceptanceOwner !== "parent_reviewer") {
    throw new Error("acceptance owner is invalid");
  }
}

export function dispatchContractDigest(contract: SwarmDispatchContract): string {
  assertSwarmDispatchContract(contract);
  return sha256(canonicalJson(contract));
}

export function buildSwarmDispatchContract(input: {
  readonly parentSession: string;
  readonly parentOpenSeq: number;
  readonly order: string;
  readonly sourceSnapshotDigest: string;
  readonly role: SwarmRole;
  readonly route: string;
  readonly world: SwarmWorldSpec;
  readonly worldImageIdentityDigest?: string;
  readonly capabilityProfile: SwarmCapabilityProfileV1;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly acceptanceOwner: SwarmAcceptanceOwner;
  readonly repositoryDigest?: string;
  readonly memoryViewDigest?: string;
  readonly recipeDigest?: string;
}): SwarmDispatchContract {
  if ((input.repositoryDigest === undefined) !== (input.memoryViewDigest === undefined)) {
    throw new Error("swarm dispatch memory binding requires both repository and view digests");
  }
  const shared = {
    parentSession: input.parentSession,
    parentOpenSeq: input.parentOpenSeq,
    operatorOrderDigest: operatorOrderDigest(input.order),
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    role: input.role,
    route: input.route,
    worldDigest: swarmWorldDigest(input.world, input.worldImageIdentityDigest),
    capabilityProfileDigest: swarmCapabilityProfileDigest(input.capabilityProfile),
    maxSteps: input.maxSteps,
    timeoutMs: input.timeoutMs,
    acceptanceOwner: input.acceptanceOwner,
    ...(input.recipeDigest === undefined ? {} : { recipeDigest: input.recipeDigest }),
  };
  const contract: SwarmDispatchContract = input.memoryViewDigest === undefined
    ? { format: 1, ...shared }
    : {
        format: 2,
        ...shared,
        repositoryDigest: input.repositoryDigest!,
        memoryViewDigest: input.memoryViewDigest,
      };
  assertSwarmDispatchContract(contract);
  return contract;
}
