import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventLog } from "../host/event-log.ts";
import type { SandboxPolicy } from "../host/sandbox.ts";
import type { AuthorizedBuildCaseRecipe } from "../work/case-authority.ts";
import type { WarmupCandidateReceipt } from "../speculative/warmup/candidate.ts";
import type { WarmupLease, WarmupRegistry } from "../speculative/warmup/registry.ts";
import type {
  WorkspaceBuildRecoveryResult,
  WorkspaceBuildWarmupRecovery,
} from "../speculative/warmup/workspace-build-recovery.ts";
import {
  prepareWorkspaceBuildWarmup,
  workspaceBuildCandidateArgs,
} from "../speculative/warmup/workspace-build.ts";

export interface ForegroundBashReuse {
  readonly exactCommand: string;
  readonly timeout?: number;
  readonly cacheRoot: string;
  readonly ownerLabel?: string;
  readonly network: "deny";
  isCurrent(): boolean;
  execute: AgentTool["execute"];
  dispose(): Promise<void>;
}

const registered = new WeakMap<AgentTool, SandboxPolicy>();
const revoked = new WeakSet<AgentTool>();
const aliases = new WeakMap<AgentTool, AgentTool>();

export interface WorkspaceBashReuseRegistration {
  registerAlias(alias: AgentTool): void;
  revoke(): void;
}

export function registerWorkspaceBashReuseTool(tool: AgentTool, policy: SandboxPolicy): WorkspaceBashReuseRegistration {
  registered.set(tool, policy);
  return Object.freeze({
    registerAlias(alias: AgentTool) {
      if (!revoked.has(tool)) aliases.set(alias, tool);
    },
    revoke() { revoked.add(tool); },
  });
}

export interface WorkspaceBashReuseAuthority {
  candidateArgs(surface: AgentTool, recipe: AuthorizedBuildCaseRecipe): Readonly<Record<string, unknown>> | undefined;
  matches(surface: AgentTool, recipe: AuthorizedBuildCaseRecipe, args: unknown): boolean;
  prepare(surface: AgentTool, input: Readonly<{
    registry: WarmupRegistry;
    receipt: WarmupCandidateReceipt;
    recipe: AuthorizedBuildCaseRecipe;
    workspaceRoot: string;
    log?: EventLog;
    signal?: AbortSignal;
    timeoutMs?: number;
    candidateId?: string;
    recovery?: WorkspaceBuildWarmupRecovery;
  }>): WarmupLease<ForegroundBashReuse> | undefined;
  recover(
    surface: AgentTool,
    recovery: WorkspaceBuildWarmupRecovery,
    candidateIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly WorkspaceBuildRecoveryResult[]>;
  project(surface: AgentTool, reuse: ForegroundBashReuse): AgentTool | undefined;
}

export function createWorkspaceBashReuseAuthority(
  available: readonly AgentTool[],
  projected: readonly AgentTool[],
): WorkspaceBashReuseAuthority | undefined {
  const bash = available.filter((tool) => tool.name === "bash" && registered.has(tool) && !revoked.has(tool));
  const bound = bash[0];
  if (bash.length !== 1 || !bound) return undefined;
  const surfaces = projected.filter((tool) => tool.name === "bash" && (tool === bound || aliases.get(tool) === bound));
  const fallback = surfaces[0];
  if (surfaces.length !== 1 || !fallback) return undefined;
  const policy = registered.get(bound);
  if (!policy) return undefined;
  return Object.freeze({
    candidateArgs(surface: AgentTool, recipe: AuthorizedBuildCaseRecipe): Readonly<Record<string, unknown>> | undefined {
      if (surface !== fallback || revoked.has(bound)) return undefined;
      try {
        return workspaceBuildCandidateArgs(recipe, policy);
      } catch (error) {
        if (error instanceof Error) return undefined;
        throw error;
      }
    },
    matches(surface: AgentTool, recipe: AuthorizedBuildCaseRecipe, args: unknown): boolean {
      return surface === fallback && !revoked.has(bound) && matchesExactArgs(args, recipe.args);
    },
    prepare(surface: AgentTool, input: Parameters<WorkspaceBashReuseAuthority["prepare"]>[1]) {
      if (surface !== fallback || revoked.has(bound)) return undefined;
      const crashRecovery = input.recovery && input.candidateId
        ? input.recovery.prepare(input.candidateId, policy)
        : undefined;
      try {
        return prepareWorkspaceBuildWarmup({ ...input, policy,
          ...(crashRecovery ? { crashRecovery } : {}) });
      } catch (error) {
        crashRecovery?.discard();
        throw error;
      }
    },
    recover(
      surface: AgentTool,
      recovery: WorkspaceBuildWarmupRecovery,
      candidateIds: readonly string[],
      signal?: AbortSignal,
    ) {
      if (surface !== fallback || revoked.has(bound)) return Promise.resolve([]);
      return recovery.recover(candidateIds, policy, signal);
    },
    project(surface: AgentTool, reuse: ForegroundBashReuse): AgentTool | undefined {
      if (surface !== fallback || revoked.has(bound)) return undefined;
      return {
        ...surface,
        execute(toolCallId, params, signal, onUpdate) {
          if (revoked.has(bound) || !matchesExactArgs(params, reuse) || !reuse.isCurrent()) {
            return surface.execute(toolCallId, params, signal, onUpdate);
          }
          return reuse.execute(toolCallId, params, signal, onUpdate);
        },
      };
    },
  });
}

function matchesExactArgs(params: unknown, reuse: Pick<ForegroundBashReuse, "exactCommand" | "timeout"> | AuthorizedBuildCaseRecipe["args"]): boolean {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
  const keys = Reflect.ownKeys(params);
  const expectedKeys = reuse.timeout === undefined ? ["command"] : ["command", "timeout"];
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return false;
  const command = Object.getOwnPropertyDescriptor(params, "command");
  const timeout = Object.getOwnPropertyDescriptor(params, "timeout");
  const exactCommand = "exactCommand" in reuse ? reuse.exactCommand : reuse.command;
  return command?.value === exactCommand &&
    (reuse.timeout === undefined ? timeout === undefined : timeout?.value === reuse.timeout);
}
