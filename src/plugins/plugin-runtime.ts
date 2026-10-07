import { createOwnedWorkResourceRegistry } from "../host/owned-work-resources.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type {
  HostContext,
  ArtifactContribution,
  ArtifactContributionRegistry,
  ArtifactRecordInput,
  GoalContextContributionRegistry,
  RecordedArtifact,
  RequestContextContributionRegistry,
  PluginModule,
  PluginSkill,
  SkillRegistry,
  SwarmMemoryContributionRegistry,
  ToolContributionRegistry,
  WorkCheckpointContributionRegistry,
} from "../loader/types.ts";
import {
  MAX_SWARM_MEMORY_PROVIDERS,
  assertSwarmMemoryProviderId,
  compileSwarmMemoryViewV1,
  type SwarmMemoryContributor,
} from "../swarm/memory-view.ts";
import { textToolResult } from "../tools/model-result.ts";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import type { EventLog } from "../host/event-log.ts";
import { createModelInputContributionRegistry, MODEL_INPUT_CONTRIBUTIONS_KEY,
  MODEL_INPUT_REQUEST_BUDGET_BYTES } from "../host/model-input-contributions.ts";

const SkillParameters = Type.Object({
  op: Type.Union([Type.Literal("list"), Type.Literal("read")]),
  id: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, PluginSkill>();
  return {
    register(skill) {
      if (skills.has(skill.id)) {
        throw new Error(`duplicate skill id ${skill.id}`);
      }
      skills.set(skill.id, skill);
      return () => {
        if (skills.get(skill.id) === skill) skills.delete(skill.id);
      };
    },
    get(id) {
      return skills.get(id);
    },
    list() {
      return [...skills.values()];
    },
  };
}

export function createToolContributionRegistry(): ToolContributionRegistry<AgentTool> {
  const tools = new Map<string, { readonly pluginId: string; readonly tool: AgentTool }>();
  return {
    register(pluginId, tool) {
      const existing = tools.get(tool.name);
      if (existing) {
        throw new Error(`duplicate contributed tool ${tool.name} from ${pluginId}; already owned by ${existing.pluginId}`);
      }
      const entry = { pluginId, tool };
      tools.set(tool.name, entry);
      return () => {
        if (tools.get(tool.name) === entry) tools.delete(tool.name);
      };
    },
    list() {
      return [...tools.values()].map((entry) => entry.tool);
    },
  };
}

export function createGoalContextContributionRegistry(): GoalContextContributionRegistry {
  const entries = new Map<string, Parameters<GoalContextContributionRegistry["register"]>[1]>();
  return {
    register(pluginId, contribution) {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(pluginId)) throw new Error("invalid goal context contribution id");
      if (entries.has(pluginId)) throw new Error(`duplicate goal context contribution ${pluginId}`);
      entries.set(pluginId, contribution);
      return () => {
        if (entries.get(pluginId) === contribution) entries.delete(pluginId);
      };
    },
    async prepare(input) {
      const blocks: Array<{ id: string; text: string }> = [];
      let remaining = 32_000;
      for (const [id, contribution] of entries) {
        if (blocks.length >= 8 || remaining <= 0) break;
        const value = await contribution(input);
        if (!value?.text.trim()) continue;
        const bounded = boundedUtf8(value.text.trim(), Math.min(16_000, remaining));
        blocks.push({ id, text: bounded });
        remaining -= Buffer.byteLength(bounded);
      }
      return blocks;
    },
  };
}

function boundedUtf8(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  const suffix = "\n[goal context truncated by host]";
  if (bytes <= Buffer.byteLength(suffix)) return suffix.slice(0, bytes);
  const available = Math.max(0, bytes - Buffer.byteLength(suffix));
  return `${Buffer.from(value).subarray(0, available).toString("utf8").replace(/\uFFFD+$/u, "")}${suffix}`;
}

/** #227 CG-04: the request-context registry. Manifest-ordered; a
 * contribution's decision is data the host records (host/request-context.ts). */
export function createRequestContextContributionRegistry(): RequestContextContributionRegistry {
  const entries = new Map<string, Parameters<RequestContextContributionRegistry["register"]>[1]>();
  return {
    register(pluginId, contribution) {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(pluginId)) throw new Error("invalid request context contribution id");
      if (entries.has(pluginId)) throw new Error(`duplicate request context contribution ${pluginId}`);
      entries.set(pluginId, contribution);
      return () => {
        if (entries.get(pluginId) === contribution) entries.delete(pluginId);
      };
    },
    active() {
      return entries.size > 0;
    },
    prepare(input) {
      return [...entries].filter(([, contribution]) => input.boundary !== "completion" || contribution.continueOnCompletion === true).map(([pluginId, contribution]) => ({ pluginId, contribution, decision: contribution.prepare(input) }));
    },
  };
}

export function createWorkCheckpointContributionRegistry(): WorkCheckpointContributionRegistry {
  const entries = new Map<string, Parameters<WorkCheckpointContributionRegistry["register"]>[1]>();
  return {
    register(pluginId, contribution) {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(pluginId)) throw new Error("invalid work checkpoint contribution id");
      if (entries.has(pluginId)) throw new Error(`duplicate work checkpoint contribution ${pluginId}`);
      entries.set(pluginId, contribution);
      return () => {
        if (entries.get(pluginId) === contribution) entries.delete(pluginId);
      };
    },
    async checkpoint(input) {
      for (const contribution of entries.values()) await contribution(input);
    },
  };
}

/** Caps: a slot that can grow without bound is the transcript again. */
export const MAX_ARTIFACT_KINDS = 8;
export const MAX_ARTIFACT_BODY_BYTES = 32_000;
export const MAX_ARTIFACT_SOURCE_BYTES = 4_000_000;

const ARTIFACT_KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
/** The host owns these payload fields; a caller cannot spoof provenance. */
const RESERVED_ARTIFACT_PAYLOAD_KEYS = [
  "artifact", "digest", "blob", "blob_bytes", "source_blob", "source_blob_bytes",
] as const;

/**
 * Typed step artifacts (#77 T2). The registry is the only thing that knows
 * how a kind is validated and digested, so the work loop stays free of
 * per-type branches (constitution 7).
 */
export function createArtifactContributionRegistry(log: EventLog): ArtifactContributionRegistry {
  const entries = new Map<string, ArtifactContribution>();
  const store = (): BlobStore => BlobStore.forSession(log.path);
  return {
    register<T>(kind: string, contribution: ArtifactContribution<T>) {
      if (!ARTIFACT_KIND.test(kind)) throw new Error(`invalid artifact kind ${kind}`);
      if (entries.has(kind)) throw new Error(`duplicate artifact kind ${kind}`);
      if (entries.size >= MAX_ARTIFACT_KINDS) {
        throw new Error(`artifact kind limit is ${MAX_ARTIFACT_KINDS}`);
      }
      const entry = contribution as ArtifactContribution;
      entries.set(kind, entry);
      return () => {
        if (entries.get(kind) === entry) entries.delete(kind);
      };
    },
    kinds() {
      return [...entries.keys()].sort();
    },
    record(input: ArtifactRecordInput): RecordedArtifact {
      // Replay PROJECTS what a step did; it never re-records it. An append on
      // a read-only handle is a silent no-op, but BlobStore.put would still
      // write a real file — so refuse explicitly.
      if (log.isReadOnly) throw new Error("artifact record is unavailable in replay");
      const contribution = entries.get(input.kind);
      if (!contribution) throw new Error(`unregistered artifact kind ${input.kind}`);
      for (const reserved of RESERVED_ARTIFACT_PAYLOAD_KEYS) {
        if (input.payload && reserved in input.payload) {
          throw new Error(`artifact payload field ${reserved} is host-owned`);
        }
      }
      const body = contribution.validate(input.body);
      const digest = contribution.digest(body);
      const canonical = canonicalJson(body);
      const blobBytes = Buffer.byteLength(canonical);
      if (blobBytes > MAX_ARTIFACT_BODY_BYTES) {
        throw new Error(`artifact ${input.kind} exceeds ${MAX_ARTIFACT_BODY_BYTES} bytes`);
      }
      const sourceBytes = input.source === undefined ? 0 : Buffer.byteLength(input.source);
      if (sourceBytes > MAX_ARTIFACT_SOURCE_BYTES) {
        throw new Error(`artifact ${input.kind} source exceeds ${MAX_ARTIFACT_SOURCE_BYTES} bytes`);
      }
      // Bytes first, then the row: replay preflight fails closed on a
      // payload.blob whose file is absent, so a crash between the two must
      // not be able to leave an unreplayable log.
      const blobs = store();
      const blob = blobs.put(canonical);
      const sourceBlob = input.source === undefined ? undefined : blobs.put(input.source);
      log.append({
        kind: "observe",
        name: input.name,
        payload: {
          ...(input.payload ?? {}),
          artifact: input.kind,
          digest,
          blob,
          blob_bytes: blobBytes,
          ...(sourceBlob ? { source_blob: sourceBlob, source_blob_bytes: sourceBytes } : {}),
        },
      });
      return { kind: input.kind, digest, blob, blobBytes, ...(sourceBlob ? { sourceBlob } : {}) };
    },
    read<T>(kind: string, blob: string): T {
      const contribution = entries.get(kind);
      if (!contribution) throw new Error(`unregistered artifact kind ${kind}`);
      return contribution.validate(JSON.parse(store().get(blob))) as T;
    },
  };
}

export function createSwarmMemoryContributionRegistry(): SwarmMemoryContributionRegistry {
  const entries = new Map<string, SwarmMemoryContributor>();
  const firstSeenOrder: string[] = [];
  return {
    register(providerId, contribution) {
      assertSwarmMemoryProviderId(providerId);
      if (entries.has(providerId)) throw new Error(`duplicate swarm memory provider ${providerId}`);
      if (entries.size >= MAX_SWARM_MEMORY_PROVIDERS) {
        throw new Error(`swarm memory provider limit is ${MAX_SWARM_MEMORY_PROVIDERS}`);
      }
      if (!firstSeenOrder.includes(providerId)) firstSeenOrder.push(providerId);
      entries.set(providerId, contribution);
      return () => {
        if (entries.get(providerId) === contribution) entries.delete(providerId);
      };
    },
    async compile(input) {
      const contributions = [];
      // Sequential evaluation preserves each provider's first manifest
      // position even when its reversible lifecycle removes and re-adds it.
      // Provider latency and enable history therefore cannot reorder bytes.
      for (const providerId of firstSeenOrder) {
        const contribution = entries.get(providerId);
        if (!contribution) continue;
        const value = await contribution(Object.freeze({ ...input }));
        if (value !== undefined) contributions.push({ providerId, contribution: value });
      }
      return compileSwarmMemoryViewV1(input, contributions);
    },
  };
}

export function createSkillTool(skills: SkillRegistry): AgentTool<typeof SkillParameters> {
  return {
    name: "skill",
    label: "skill",
    description: "List installed plugin skills or load one skill by its exact id before applying it.",
    parameters: SkillParameters,
    async execute(_toolCallId, params) {
      if (params.op === "list") {
        return textToolResult(JSON.stringify(skills.list().map((skill) => ({
          id: skill.id,
          plugin: skill.pluginId,
          description: skill.description,
          digest: skill.digest,
        }))));
      }
      if (!params.id) {
        return textToolResult("skill read requires id", true);
      }
      const skill = skills.get(params.id);
      if (!skill) {
        return textToolResult(`unknown skill ${params.id}`, true);
      }
      return textToolResult(skill.body);
    },
  };
}

export const plugin: PluginModule = {
  id: "plugin-runtime",
  claims: [
    { key: "skills", role: "definition" },
    { key: "skills", role: "provider" },
    { key: "tool_contributions", role: "definition" },
    { key: "tool_contributions", role: "provider" },
    { key: "goal_context_contributions", role: "definition" },
    { key: "goal_context_contributions", role: "provider" },
    { key: "owned_work_resources", role: "definition" },
    { key: "owned_work_resources", role: "provider" },
    { key: "work_checkpoint_contributions", role: "definition" },
    { key: "work_checkpoint_contributions", role: "provider" },
    { key: "request_context_contributions", role: "definition" },
    { key: "request_context_contributions", role: "provider" },
    { key: "swarm_memory_contributions", role: "definition" },
    { key: "swarm_memory_contributions", role: "provider" },
    { key: "artifact_contributions", role: "definition" },
    { key: "artifact_contributions", role: "provider" },
    { key: "model_input_contributions", role: "definition" },
    { key: "model_input_contributions", role: "provider" },
  ],
  register(ctx: HostContext) {
    const skills = createSkillRegistry();
    const tools = createToolContributionRegistry();
    const goalContext = createGoalContextContributionRegistry();
    const workCheckpoints = createWorkCheckpointContributionRegistry();
    const ownedWorkResources = createOwnedWorkResourceRegistry(ctx.log);
    const requestContext = createRequestContextContributionRegistry();
    const swarmMemory = createSwarmMemoryContributionRegistry();
    const artifacts = createArtifactContributionRegistry(ctx.log);
    ctx.effect(() => tools.register("plugin-runtime", createSkillTool(skills)));
    ctx.define("skills", { lifecycle: "session_open", activation: "tool_result" });
    ctx.provide("skills", skills);
    ctx.define("tool_contributions", { ordering: "manifest" });
    ctx.provide("tool_contributions", tools);
    ctx.define("goal_context_contributions", { ordering: "manifest", visibility: "recorded_turn_input" });
    ctx.provide("goal_context_contributions", goalContext);
    ctx.define("work_checkpoint_contributions", { ordering: "manifest", source: "event_log" });
    ctx.provide("work_checkpoint_contributions", workCheckpoints);
    ctx.define("owned_work_resources", { ordering: "manifest", modelFacing: false });
    ctx.provide("owned_work_resources", ownedWorkResources);
    // Not model-facing: a frame is dynamic transcript data recorded per
    // request, never part of the sealed prefix (constitution 4).
    ctx.define("request_context_contributions", { ordering: "manifest", visibility: "recorded_request_input", format: 1 });
    ctx.provide("request_context_contributions", requestContext);
    // Not model-facing: an artifact body never enters the frozen prefix, so
    // registering one can never demand a seal reason (constitution 4).
    ctx.define("artifact_contributions", {
      ordering: "manifest",
      visibility: "host_only",
      storage: "payload_blob",
      format: 1,
    });
    ctx.provide("artifact_contributions", artifacts);
    ctx.define("swarm_memory_contributions", {
      ordering: "manifest",
      visibility: "immutable_child_view",
      format: 1,
    });
    ctx.provide("swarm_memory_contributions", swarmMemory);
    // #222 D2: recorded model-input suffixes (diagnostics, #227's lessons).
    // Not model-facing at registration: nothing enters the frozen prefix; a
    // suffix is recorded per request by the loop (host/model-input-contributions.ts).
    ctx.define(MODEL_INPUT_CONTRIBUTIONS_KEY, {
      ordering: "registration",
      visibility: "recorded_request_suffix",
      budget_bytes: MODEL_INPUT_REQUEST_BUDGET_BYTES,
    });
    ctx.provide(MODEL_INPUT_CONTRIBUTIONS_KEY, createModelInputContributionRegistry());
  },
};
