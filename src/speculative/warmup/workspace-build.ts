import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { EventLog } from "../../host/event-log.ts";
import {
  createPrivateCachePolicyFrom,
  disposeSandboxPolicy,
  assertSandboxPolicyEnforceable,
  privateCachePolicyLabel,
  policyDigest,
  type SandboxPolicy,
} from "../../host/sandbox.ts";
import { createWorkspaceBashTools } from "../../plugins/workspace-bash.ts";
import type { ForegroundBashReuse } from "../../plugins/workspace-bash-reuse.ts";
import { sourceDigestForAuthorizedCase, type AuthorizedBuildCaseRecipe } from "../../work/case-authority.ts";
import { caseTestFile } from "../../work/case-runners.ts";
import { classifyRedFailure } from "../../work/verify.ts";
import type { WarmupCandidateReceipt } from "./candidate.ts";
import { authorityForWarmupCandidate } from "./candidate.ts";
import { BuildWarmupError } from "./build-exec.ts";
import { digestWorkspaceBuildCache } from "./workspace-build-cache.ts";
import type { WarmupLease, WarmupRegistry } from "./registry.ts";
import type { WorkspaceBuildCrashReceipt } from "./workspace-build-recovery.ts";

export type WorkspaceBuildWarmupInput = Readonly<{
  registry: WarmupRegistry;
  receipt: WarmupCandidateReceipt;
  recipe: AuthorizedBuildCaseRecipe;
  workspaceRoot: string;
  policy: SandboxPolicy;
  log?: EventLog;
  signal?: AbortSignal;
  timeoutMs?: number;
  crashRecovery?: WorkspaceBuildCrashReceipt;
}>;

type Allocation = Readonly<{
  cacheRoot: string;
  cacheIdentity: string;
  policy: SandboxPolicy;
  disposeBash(): void;
  crashRecovery?: WorkspaceBuildCrashReceipt;
}>;

const allocations = new WeakMap<ForegroundBashReuse, Allocation>();

export function workspaceBuildCandidateArgs(
  recipe: AuthorizedBuildCaseRecipe,
  policy: SandboxPolicy,
): Readonly<Record<string, unknown>> {
  assertSandboxPolicyEnforceable(policy);
  return Object.freeze({
    recipeId: recipe.recipeId,
    command: recipe.args.command,
    timeout: recipe.args.timeout,
    sourceDigest: recipe.sourceDigest,
    redMeans: recipe.redMeans,
    profile: recipe.profile,
    policyDigest: policyDigest(policy),
  });
}

export function prepareWorkspaceBuildWarmup(
  input: WorkspaceBuildWarmupInput,
): WarmupLease<ForegroundBashReuse> {
  assertInput(input);
  const candidateArgs = workspaceBuildCandidateArgs(input.recipe, input.policy);
  const authority = authorityForWarmupCandidate("workspace-build", input.receipt, candidateArgs);
  return input.registry.prepare({
    authority,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    acquire: async (signal) => {
      const cacheRoot = input.crashRecovery?.root()
        ?? realpathSync(mkdtempSync(join(tmpdir(), "dokkabi-workspace-build-")));
      const cacheIdentity = directoryIdentity(cacheRoot);
      let cachePolicy: SandboxPolicy | undefined;
      let disposeBash: (() => void) | undefined;
      try {
        assertSource(input);
        cachePolicy = createPrivateCachePolicyFrom(input.policy, cacheRoot);
        if (!cachePolicy.networkDenied) throw new BuildWarmupError("authority");
        // A wrapper of its own, named by the cache root: the session's live
        // bash keeps `sandbox-sh` in the same log directory, and a warmup
        // writing that name would put the private-cache policy under every
        // later command of the live tool.
        const bash = createWorkspaceBashTools({
          workspaceRoot: input.policy.workspaceRoot,
          policy: cachePolicy,
          ...(input.log ? { log: input.log } : {}),
          shellName: `sandbox-build-${basename(cacheRoot)}-sh`,
        });
        disposeBash = bash.dispose;
        const terminal = bash.tools[0];
        if (!terminal) throw new BuildWarmupError("authority");
        const command = cachedCommand(input.recipe, cacheRoot);
        await expectAuthorizedRed(terminal.execute(`warm-${input.recipe.recipeId}`, {
          command,
          ...(input.recipe.args.timeout === undefined ? {} : { timeout: input.recipe.args.timeout }),
        }, signal), input.recipe.redMeans, signal);
        const outputDigest = digestWorkspaceBuildCache(cacheRoot, input.recipe.profile.artifactSuffix);
        let used = false;
        const execute: ForegroundBashReuse["execute"] = async (toolCallId, params, foregroundSignal, onUpdate) => {
          if (used || !isResourceCurrent(resource, input, outputDigest)) throw new BuildWarmupError("authority");
          used = true;
          return terminal.execute(toolCallId, replaceCommand(params, command), foregroundSignal, onUpdate);
        };
        const resource: ForegroundBashReuse = Object.freeze({
          exactCommand: input.recipe.args.command,
          ...(input.recipe.args.timeout === undefined ? {} : { timeout: input.recipe.args.timeout }),
          cacheRoot,
          ...(privateCachePolicyLabel(cachePolicy) ? { ownerLabel: privateCachePolicyLabel(cachePolicy) } : {}),
          network: "deny",
          isCurrent: () => isResourceCurrent(resource, input, outputDigest),
          execute,
          dispose: async () => releaseResource(resource),
        });
        allocations.set(resource, Object.freeze({ cacheRoot, cacheIdentity, policy: cachePolicy, disposeBash,
          ...(input.crashRecovery ? { crashRecovery: input.crashRecovery } : {}) }));
        return resource;
      } catch (error) {
        disposeBash?.();
        if (cachePolicy) disposeSandboxPolicy(cachePolicy);
        removeCache(cacheRoot, cacheIdentity);
        input.crashRecovery?.complete();
        if (error instanceof BuildWarmupError) throw error;
        throw new BuildWarmupError("execution");
      }
    },
    release: releaseResource,
  });
}

function assertInput(input: WorkspaceBuildWarmupInput): void {
  assertSandboxPolicyEnforceable(input.policy);
  if (realpathSync(resolve(input.workspaceRoot)) !== input.policy.workspaceRoot || input.recipe.profile.kind !== "bun-transpiler-cache-v1") {
    throw new BuildWarmupError("authority");
  }
  if (input.policy.disabled === true) throw new BuildWarmupError("authority");
  assertSource(input);
}

function assertSource(input: WorkspaceBuildWarmupInput): void {
  assertSandboxPolicyEnforceable(input.policy);
  const file = caseTestFile(input.recipe.args.command);
  if (!file) throw new BuildWarmupError("authority");
  if (sourceDigestForAuthorizedCase(input.policy.workspaceRoot, file) !== input.recipe.sourceDigest) {
    throw new BuildWarmupError("authority");
  }
}

function cachedCommand(recipe: AuthorizedBuildCaseRecipe, cacheRoot: string): string {
  const value = cacheRoot;
  return `export ${recipe.profile.environmentVariable}=${shellWord(value)}; ${recipe.args.command}`;
}

function replaceCommand(params: unknown, command: string): unknown {
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new BuildWarmupError("authority");
  return Object.assign({}, params, { command });
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function expectAuthorizedRed(
  execution: ReturnType<ForegroundBashReuse["execute"]>,
  redMeans: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await execution;
    throw new BuildWarmupError("execution");
  } catch (error) {
    if (error instanceof BuildWarmupError) throw error;
    if (signal.aborted || !(error instanceof Error)) throw new BuildWarmupError("execution");
    if (!classifyRedFailure(error.message, redMeans).valid) throw new BuildWarmupError("execution");
  }
}

function directoryIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BuildWarmupError("authority");
  return `${stat.dev}:${stat.ino}`;
}

function assertDirectory(path: string, identity: string): void {
  if (directoryIdentity(path) !== identity) throw new BuildWarmupError("authority");
}

async function releaseResource(resource: ForegroundBashReuse): Promise<void> {
  const allocation = allocations.get(resource);
  if (!allocation) return;
  allocations.delete(resource);
  allocation.disposeBash();
  disposeSandboxPolicy(allocation.policy);
  removeCache(allocation.cacheRoot, allocation.cacheIdentity);
  allocation.crashRecovery?.complete();
}

function isResourceCurrent(resource: ForegroundBashReuse, input: WorkspaceBuildWarmupInput, outputDigest: string): boolean {
  const allocation = allocations.get(resource);
  if (!allocation) return false;
  try {
    assertSource(input);
    assertDirectory(allocation.cacheRoot, allocation.cacheIdentity);
    return digestWorkspaceBuildCache(allocation.cacheRoot, input.recipe.profile.artifactSuffix) === outputDigest;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function removeCache(path: string, identity: string): void {
  if (!existsSync(path)) return;
  assertDirectory(path, identity);
  rmSync(path, { recursive: true, force: true });
}
