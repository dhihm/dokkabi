import { createHash } from "node:crypto";
import type { EventLog } from "./event-log.ts";
import { canonicalJson } from "./canonical.ts";
import { lastPromptSeal } from "./prefix.ts";
import type { EventRecord } from "./schema.ts";
import {
  isToolProfileName,
  toolProfileToolNames,
  type ToolProfileName,
  type ToolScope,
} from "../loader/tool-profiles.ts";
import { PROFILE_EXCEEDED } from "../loader/tool-profile-policy.ts";

const FORMAT = 1 as const;
const HEX_256 = /^[0-9a-f]{64}$/u;

interface ToolProfileBody {
  readonly format: typeof FORMAT;
  readonly profile: ToolProfileName;
  readonly todo: string;
  readonly tools: readonly string[];
  readonly tool_schema_hash: string;
  readonly prefix_hash: string;
}

export interface ToolProfileReference extends ToolProfileBody {
  readonly seq: number;
  readonly projection_digest: string;
}

function projectionDigest(body: ToolProfileBody): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function appendToolProfileEvent(input: {
  readonly log: EventLog;
  readonly scope: ToolScope;
  readonly tools: readonly string[];
  readonly toolSchemaHash: string;
}): ToolProfileReference {
  const seal = lastPromptSeal(input.log.events);
  const prefixHash = seal?.payload.prefix_hash;
  if (!seal || typeof prefixHash !== "string" || !HEX_256.test(prefixHash)) {
    throw new Error("tool profile requires a sealed prompt prefix");
  }
  if (seal.payload.tool_schema_hash !== input.toolSchemaHash) {
    throw new Error("tool profile requires a seal for its exact tool schema");
  }
  const body: ToolProfileBody = {
    format: FORMAT,
    profile: input.scope.profile,
    todo: input.scope.todo,
    tools: [...input.tools],
    tool_schema_hash: input.toolSchemaHash,
    prefix_hash: prefixHash,
  };
  const projection_digest = projectionDigest(body);
  const event = input.log.append({
    kind: "observe",
    name: "tool/profile",
    payload: { ...body, projection_digest },
  });
  return { seq: event.seq, ...body, projection_digest };
}

export function projectToolProfileReferences(
  events: readonly EventRecord[],
  featureStart?: number,
): ToolProfileReference[] {
  let lastSealHash: string | undefined;
  let lastSealSchemaHash: string | undefined;
  let lastSealReason: unknown;
  let lastSealSeq: number | undefined;
  let activeTools: ReadonlySet<string> | undefined;
  let activeToolNames: readonly string[] | undefined;
  let activeSchemaHash: string | undefined;
  let activePrefixHash: string | undefined;
  let activeProfileSeq: number | undefined;
  let activeScope: string | undefined;
  // Tools a step's profile was widened by in auto mode, per profile+todo, and
  // the one call a recorded out-of-profile decision admits (tool-profile-policy.ts).
  const widened = new Map<string, Set<string>>();
  let admittedCall: string | undefined;
  const references: ToolProfileReference[] = [];
  for (const event of events) {
    if (event.name === PROFILE_EXCEEDED) {
      const p = event.payload;
      if (typeof p.id !== "string" || typeof p.tool !== "string" || !["refuse", "widen", "allow"].includes(String(p.action))) {
        throw new Error(`invalid tool profile decision at seq ${event.seq}`);
      }
      admittedCall = p.id;
      if (p.action === "widen" && activeTools) {
        const key = `${String(p.profile)}\u0000${String(p.todo)}`;
        if (key !== activeScope) throw new Error(`tool profile widening names another step at seq ${event.seq}`);
        const set = widened.get(key) ?? new Set<string>();
        set.add(p.tool);
        widened.set(key, set);
        activeTools = new Set([...activeTools, p.tool]);
      }
      continue;
    }
    if (event.name === "prompt/seal" && typeof event.payload.prefix_hash === "string") {
      lastSealHash = event.payload.prefix_hash;
      lastSealSchemaHash = typeof event.payload.tool_schema_hash === "string"
        ? event.payload.tool_schema_hash
        : undefined;
      lastSealReason = event.payload.reason;
      lastSealSeq = event.seq;
      continue;
    }
    const featureActive = featureStart === undefined
      ? activeTools !== undefined
      : event.seq >= featureStart;
    if (event.name === "tool/call" && featureActive) {
      const tool = event.payload.name;
      const admitted = admittedCall !== undefined && event.payload.id === admittedCall;
      admittedCall = undefined;
      if (typeof tool !== "string" || (!activeTools?.has(tool) && !admitted)) {
        throw new Error(`tool call exceeds active tool profile at seq ${event.seq}`);
      }
      continue;
    }
    if (event.name !== "tool/profile" || (!featureActive && featureStart !== undefined)) {
      continue;
    }
    const payload = event.payload;
    if (
      payload.format !== FORMAT
      || !isToolProfileName(payload.profile)
      || typeof payload.todo !== "string"
      || payload.todo.length === 0
      || !Array.isArray(payload.tools)
      || payload.tools.some((tool) => typeof tool !== "string" || tool.length === 0)
      || new Set(payload.tools).size !== payload.tools.length
      || typeof payload.tool_schema_hash !== "string"
      || !HEX_256.test(payload.tool_schema_hash)
      || typeof payload.prefix_hash !== "string"
      || !HEX_256.test(payload.prefix_hash)
      || payload.prefix_hash !== lastSealHash
      || payload.tool_schema_hash !== lastSealSchemaHash
      || typeof payload.projection_digest !== "string"
      || !HEX_256.test(payload.projection_digest)
    ) {
      throw new Error(`invalid tool profile event at seq ${event.seq}`);
    }
    const body: ToolProfileBody = {
      format: FORMAT,
      profile: payload.profile,
      todo: payload.todo,
      tools: [...payload.tools],
      tool_schema_hash: payload.tool_schema_hash,
      prefix_hash: payload.prefix_hash,
    };
    const allowed = toolProfileToolNames(body.profile);
    if (
      body.profile !== "default"
      && body.tools.some((tool) => !allowed.includes(tool))
    ) {
      throw new Error(`tool profile event exceeds ${body.profile} at seq ${event.seq}`);
    }
    if (projectionDigest(body) !== payload.projection_digest) {
      throw new Error(`tool profile digest mismatch at seq ${event.seq}`);
    }
    // Only what the provider is sent needs a new seal. A working profile sends
    // the full surface, so moving between two of them changes the tools held
    // at the call, not the prompt (tool-profile-policy.ts).
    const projectionChanged = activeToolNames !== undefined && body.tool_schema_hash !== activeSchemaHash;
    if (
      projectionChanged
      && (
        lastSealSeq === undefined
        || activeProfileSeq === undefined
        || lastSealSeq <= activeProfileSeq
        || lastSealReason !== "tools_changed"
        || body.prefix_hash === activePrefixHash
      )
    ) {
      throw new Error(`tool profile projection changed without a tools_changed seal at seq ${event.seq}`);
    }
    references.push({
      seq: event.seq,
      ...body,
      projection_digest: payload.projection_digest,
    });
    activeScope = `${body.profile}\u0000${body.todo}`;
    activeTools = new Set([...body.tools, ...(widened.get(activeScope) ?? [])]);
    activeToolNames = body.tools;
    activeSchemaHash = body.tool_schema_hash;
    activePrefixHash = body.prefix_hash;
    activeProfileSeq = event.seq;
  }
  return references;
}

/**
 * Would appending this profile change the projection?
 *
 * The projection compares against the last recorded PROFILE; sealIfNeeded
 * compares against the last SEAL. Those are different questions, and across a
 * process boundary they give different answers: a run that ended on a narrow
 * tool scope leaves a four-tool profile behind, the next process starts on the
 * full twenty-eight, and the prefix hash can already match the last seal — so
 * no `tools_changed` seal is written and the projection rejects the log for
 * the rest of the session. The dashboard for that session never opens again.
 *
 * Asking this before the seal is what keeps the two in step.
 */
export function toolProfileProjectionChanges(
  events: readonly EventRecord[],
  tools: readonly string[],
  toolSchemaHash: string,
): boolean {
  const last = projectToolProfileReferences(events).at(-1);
  if (!last) return false;
  void tools;
  return last.tool_schema_hash !== toolSchemaHash;
}

export function hasPriorToolProfilePrefix(
  events: readonly EventRecord[],
  prefixHash: string,
  toolSchemaHash: string,
): boolean {
  const references = projectToolProfileReferences(events);
  return references.slice(0, -1).some((reference) =>
    reference.prefix_hash === prefixHash
    && reference.tool_schema_hash === toolSchemaHash
  );
}
