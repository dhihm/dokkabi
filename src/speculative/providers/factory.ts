import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExactCall, ExactCallProvider, ExactPreparation } from "../exact-cache-types.ts";
import { canonicalWorkspaceRoot, fileProof, manifestLimits, treeProof, type DependencyProof } from "./manifest.ts";
import {
  TIER1_PROBE_RECIPES,
  TIER1_PROVIDER_NAMES,
  type Tier1ProviderName,
  type Tier1ProviderOptions,
  type Tier1Providers,
} from "./types.ts";

type Result = AgentToolResult<unknown>;

export function createTier1Providers(options: Tier1ProviderOptions): Tier1Providers {
  const root = canonicalWorkspaceRoot(options.workspaceRoot);
  const limits = manifestLimits(options.limits);
  const available = uniqueTools(options.tools);
  const providers: Partial<Record<Tier1ProviderName, ExactCallProvider<Result>>> = {};
  let sequence = 0;
  for (const name of TIER1_PROVIDER_NAMES) {
    const tool = available.get(name);
    if (!tool) continue;
    providers[name] = {
      name: `tier1:${name}`,
      async prepare(call, signal) {
        sequence += 1;
        const before = dependencyProof(name, call, root, limits, options);
        const result = await tool.execute(`speculative-tier1:${name}:${sequence}`, call.args, signal);
        if (!before) return { kind: "warm-only" };
        const after = dependencyProof(name, call, root, limits, options);
        if (!after || before.digest !== after.digest) return { kind: "warm-only" };
        return reusable(result, after);
      },
    };
  }
  return Object.freeze(providers);
}

function dependencyProof(
  name: Tier1ProviderName,
  call: ExactCall,
  root: string,
  limits: ReturnType<typeof manifestLimits>,
  options: Tier1ProviderOptions,
): DependencyProof | undefined {
  if (call.tool !== name) return undefined;
  switch (name) {
    case "read": {
      const path = ownString(call.args, "path");
      return path ? fileProof(root, path, limits) : undefined;
    }
    case "grep": {
      const path = ownString(call.args, "path") ?? ".";
      return treeProof(root, path, "inspect", limits);
    }
    case "glob":
      return treeProof(root, ".", "inspect", limits);
    case "git_status":
    case "git_diff":
      return options.gitAuthority
        ? treeProof(root, ".", "git", limits, options.gitAuthority)
        : undefined;
    case "probe_log":
      return probeProof(call.args, root, limits, options);
    default:
      return undefined;
  }
}

function probeProof(
  args: unknown,
  root: string,
  limits: ReturnType<typeof manifestLimits>,
  options: Tier1ProviderOptions,
): DependencyProof | undefined {
  const path = ownString(args, "path");
  const script = ownString(args, "script");
  const runtime = ownString(args, "runtime") ?? "python";
  const authority = options.probeAuthority;
  if (!path || path.startsWith("blob:") || !script || !authority || authority.runtime !== runtime) return undefined;
  const recipe = runtime === "python" ? TIER1_PROBE_RECIPES.python_byte_count : TIER1_PROBE_RECIPES.bun_byte_count;
  if (script !== recipe.script) return undefined;
  return fileProof(root, path, limits, authority);
}

function reusable(result: Result, proof: DependencyProof): ExactPreparation<Result> {
  return { kind: "reusable", result, validate: proof.validate };
}

function uniqueTools(tools: readonly AgentTool[]): ReadonlyMap<Tier1ProviderName, AgentTool> {
  const seen = new Map<string, AgentTool | undefined>();
  for (const tool of tools) seen.set(tool.name, seen.has(tool.name) ? undefined : tool);
  const available = new Map<Tier1ProviderName, AgentTool>();
  for (const name of TIER1_PROVIDER_NAMES) {
    const tool = seen.get(name);
    if (tool) available.set(name, tool);
  }
  return available;
}

function ownString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}
