import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { policyDigest, type SandboxPolicy } from "../host/sandbox.ts";
import type { Tier1ExecutionAuthority, Tier1ProviderName } from "../speculative/providers/index.ts";

type Registration = {
  readonly state: { active: boolean };
  readonly tools: ReadonlySet<AgentTool>;
  readonly policy: SandboxPolicy;
  readonly policyDigest: string;
  readonly gitAuthority?: Tier1ExecutionAuthority;
  readonly probeAuthority?: Tier1ExecutionAuthority & { readonly runtime: "python" };
};

export interface WorkspaceSpeculativeAuthority {
  readonly gitAuthority?: Tier1ExecutionAuthority;
  readonly probeAuthority?: Tier1ExecutionAuthority & { readonly runtime: "python" };
  project(projected: readonly AgentTool[]): readonly AgentTool[];
  validateForegroundReuse(tool: AgentTool): boolean;
}

export interface WorkspaceSpeculativeAuthorityRegistry {
  register(input: WorkspaceSpeculativeRegistration): () => void;
  create(available: readonly AgentTool[]): WorkspaceSpeculativeAuthority | undefined;
}

type WorkspaceSpeculativeRegistration = {
  readonly tools: readonly AgentTool[];
  readonly policy: SandboxPolicy;
};

export function createWorkspaceSpeculativeAuthorityRegistry(): WorkspaceSpeculativeAuthorityRegistry {
  const registrations = new WeakMap<AgentTool, Registration>();
  return Object.freeze({
    register(input: WorkspaceSpeculativeRegistration): () => void {
      const tools = uniqueTier1Tools(input.tools);
      const digest = sealedPolicyDigest(input.policy);
      if (!digest || tools.size === 0) return () => undefined;
      const state = { active: true };
      const registration: Registration = {
        state,
        tools: new Set(tools.values()),
        policy: input.policy,
        policyDigest: digest,
        ...executionAuthorities(input.policy, digest, () => state.active),
      };
      for (const tool of registration.tools) registrations.set(tool, registration);
      return () => {
        if (!registration.state.active) return;
        registration.state.active = false;
        for (const tool of registration.tools) registrations.delete(tool);
      };
    },
    create(available: readonly AgentTool[]): WorkspaceSpeculativeAuthority | undefined {
      const records = new Set<Registration>();
      for (const tool of available) {
        const registration = registrations.get(tool);
        if (registration) records.add(registration);
      }
      if (records.size !== 1) return undefined;
      const registration = records.values().next().value;
      if (!registration || !validRegistration(registration)) return undefined;
      const supported = (tool: AgentTool): boolean => {
        if (!registration.tools.has(tool)) return false;
        if ((tool.name === "git_status" || tool.name === "git_diff") && !registration.gitAuthority) return false;
        return tool.name !== "probe_log" || Boolean(registration.probeAuthority);
      };
      return Object.freeze({
        ...(registration.gitAuthority ? { gitAuthority: registration.gitAuthority } : {}),
        ...(registration.probeAuthority ? { probeAuthority: registration.probeAuthority } : {}),
        project(projected: readonly AgentTool[]): readonly AgentTool[] {
          if (!validRegistration(registration)) return [];
          const counts = toolNameCounts(projected);
          return projected.filter((tool) => counts.get(tool.name) === 1 && supported(tool));
        },
        validateForegroundReuse(tool: AgentTool): boolean {
          if (!validRegistration(registration) || !supported(tool)) return false;
          if (tool.name === "git_status" || tool.name === "git_diff") return registration.gitAuthority?.validate() === true;
          if (tool.name === "probe_log") return registration.probeAuthority?.validate() === true;
          return true;
        },
      });
    },
  });
}

function uniqueTier1Tools(tools: readonly AgentTool[]): ReadonlyMap<Tier1ProviderName, AgentTool> {
  const candidates = new Map<Tier1ProviderName, AgentTool | undefined>();
  for (const tool of tools) {
    if (!isTier1Name(tool.name)) continue;
    candidates.set(tool.name, candidates.has(tool.name) ? undefined : tool);
  }
  const unique = new Map<Tier1ProviderName, AgentTool>();
  for (const [name, tool] of candidates) if (tool) unique.set(name, tool);
  return unique;
}

function isTier1Name(name: string): name is Tier1ProviderName {
  return name === "read" || name === "grep" || name === "glob"
    || name === "git_status" || name === "git_diff" || name === "probe_log";
}

function toolNameCounts(tools: readonly AgentTool[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return counts;
}

function executionAuthorities(
  policy: SandboxPolicy,
  digest: string,
  active: () => boolean,
): Pick<Registration, "gitAuthority" | "probeAuthority"> {
  const gitExecutable = policy.backend === "docker" ? policy.dockerBinary : localExecutable("/usr/bin/git", policy);
  const pythonExecutable = policy.backend === "docker" ? policy.dockerBinary : localExecutable("python3", policy);
  const gitAuthority = gitExecutable ? executionAuthority(policy, digest, gitExecutable, "git:/usr/bin/git", active) : undefined;
  const probe = pythonExecutable ? executionAuthority(policy, digest, pythonExecutable, "probe:python:stdin-byte-count", active) : undefined;
  return {
    ...(gitAuthority ? { gitAuthority } : {}),
    ...(probe ? { probeAuthority: Object.freeze({ ...probe, runtime: "python" as const }) } : {}),
  };
}

function executionAuthority(
  policy: SandboxPolicy,
  digest: string,
  executablePath: string,
  operation: string,
  active: () => boolean,
): Tier1ExecutionAuthority {
  const environmentDigest = createHash("sha256").update(`${digest}\0${operation}`).digest("hex");
  return Object.freeze({
    executablePath,
    environmentDigest,
    validate: () => active() && validPolicy(policy, digest)
      && (policy.backend === "docker"
        ? policy.dockerBinary === executablePath
        : localExecutable(operation.startsWith("git:") ? "/usr/bin/git" : "python3", policy) === executablePath),
  });
}

function localExecutable(command: string, policy: SandboxPolicy): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : (policy.childEnv.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || (statSync(candidate).mode & 0o111) === 0) continue;
      const path = realpathSync(candidate);
      const rel = relative(policy.workspaceRoot, path);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return undefined;
      return path;
    } catch (error) {
      if (error instanceof Error) continue;
      throw error;
    }
  }
  return undefined;
}

function sealedPolicyDigest(policy: SandboxPolicy): string | undefined {
  if (policy.disabled === true || policy.mode !== "read-only") return undefined;
  try {
    return policyDigest(policy);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

function validPolicy(policy: SandboxPolicy, digest: string): boolean {
  return sealedPolicyDigest(policy) === digest;
}

function validRegistration(registration: Registration): boolean {
  return registration.state.active && validPolicy(registration.policy, registration.policyDigest);
}
