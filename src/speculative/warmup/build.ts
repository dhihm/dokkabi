import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { WarmupLease, WarmupRegistry } from "./registry.ts";
import type { WarmupCommandResult } from "./docker.ts";
import { authorityForWarmupCandidate } from "./candidate.ts";
import type { WarmupCandidateReceipt } from "./candidate.ts";
import {
  createPolicy,
  detectBackend,
  disposeSandboxPolicy,
  sandboxNetwork,
  type SandboxPolicy,
} from "../../host/sandbox.ts";
import { BuildWarmupError, runSealedBuild } from "./build-exec.ts";

export { BuildWarmupError } from "./build-exec.ts";

export type BuildWarmupRecipe = {
  readonly executable: string;
  readonly warmupArgs: readonly string[];
  readonly foregroundArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly outputs: readonly string[];
};

export type BuildWarmupInput = {
  readonly registry: WarmupRegistry;
  readonly receipt: WarmupCandidateReceipt;
  readonly recipe: BuildWarmupRecipe;
  readonly writableRoots: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type BuildWarmResource = {
  readonly cacheRoot: string;
  readonly cacheDigest: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: () => Promise<WarmupCommandResult>;
};

type BuildExecutableSeal = {
  readonly path: string;
  readonly identity: string;
};

type BuildAllocation = {
  readonly cacheRoot: string;
  readonly rootIdentity: string;
  readonly policy: SandboxPolicy;
};
const BUILD_ALLOCATIONS = new WeakMap<BuildWarmResource, BuildAllocation>();

export function prepareBuildWarmup(input: BuildWarmupInput): WarmupLease<BuildWarmResource> {
  assertBuildInput(input);
  const authority = authorityForWarmupCandidate("build", input.receipt, input.recipe);
  const executable = sealBuildExecutable(input.recipe.executable, input.writableRoots);
  const warmupArgs = Object.freeze([...input.recipe.warmupArgs]);
  const foregroundArgs = Object.freeze([...input.recipe.foregroundArgs]);
  const outputs = Object.freeze([...input.recipe.outputs]);
  const recipeEnv = Object.freeze({ ...input.recipe.environment });
  const timeoutMs = positiveTimeout(input.timeoutMs);
  return input.registry.prepare({
    authority,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    acquire: async (signal) => {
      const cacheRoot = mkdtempSync(join(tmpdir(), "dokkabi-warm-build-"));
      chmodSync(cacheRoot, 0o700);
      const rootIdentity = directoryIdentity(cacheRoot);
      const environment = buildEnvironment(recipeEnv, cacheRoot);
      let policy: SandboxPolicy | undefined;
      try {
        assertBuildExecutable(executable);
        const sealedPolicy = createPolicy({
          mode: "read-only",
          workspaceRoot: cacheRoot,
          writablePaths: [cacheRoot],
          backend: detectBackend(cacheRoot),
        });
        policy = sealedPolicy;
        if (sealedPolicy.disabled === true || sandboxNetwork(sealedPolicy) !== "deny") throw new BuildWarmupError("authority");
        const result = await runSealedBuild({ executable: executable.path, args: warmupArgs, policy: sealedPolicy, environment, signal, timeoutMs });
        if (result.exitCode !== 0) throw new BuildWarmupError("execution");
        const cacheDigest = digestOutputs(cacheRoot, outputs);
        let foregroundStarted = false;
        const resource = Object.freeze({
          cacheRoot,
          cacheDigest,
          environment,
          run: async () => {
            if (foregroundStarted) throw new BuildWarmupError("authority");
            foregroundStarted = true;
            assertBuildExecutable(executable);
            assertCacheIdentity(cacheRoot, outputs, cacheDigest);
            return runSealedBuild({ executable: executable.path, args: foregroundArgs, policy: sealedPolicy, environment, signal, timeoutMs });
          },
        });
        BUILD_ALLOCATIONS.set(resource, Object.freeze({ cacheRoot, rootIdentity, policy: sealedPolicy }));
        return resource;
      } catch (error) {
        if (policy) disposeSandboxPolicy(policy);
        removeCacheRoot(cacheRoot, rootIdentity);
        if (error instanceof BuildWarmupError) throw error;
        throw new BuildWarmupError("execution");
      }
    },
    release: (resource) => {
      const allocation = BUILD_ALLOCATIONS.get(resource);
      if (!allocation) return;
      BUILD_ALLOCATIONS.delete(resource);
      try {
        disposeSandboxPolicy(allocation.policy);
      } finally {
        removeCacheRoot(allocation.cacheRoot, allocation.rootIdentity);
      }
    },
  });
}

function assertBuildInput(input: BuildWarmupInput): void {
  assertArgs(input.recipe.warmupArgs);
  assertArgs(input.recipe.foregroundArgs);
  if (input.recipe.outputs.length === 0 || input.recipe.outputs.length > 32) throw new BuildWarmupError("output");
  for (const output of input.recipe.outputs) {
    if (!safeRelativePath(output)) throw new BuildWarmupError("output");
  }
  for (const [key, value] of Object.entries(input.recipe.environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || value.length > 16_384 || /[\0\r\n]/u.test(value) || key.startsWith("DOKKABI_BUILD_")) {
      throw new BuildWarmupError("authority");
    }
  }
}

function assertArgs(args: readonly string[]): void {
  if (args.length > 64 || args.some((value) => value.length > 16_384 || /[\0\r\n]/u.test(value))) {
    throw new BuildWarmupError("authority");
  }
}

function safeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const normalized = resolve("/cache", path);
  const rel = relative("/cache", normalized);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sealBuildExecutable(path: string, writableRoots: readonly string[]): BuildExecutableSeal {
  if (!isAbsolute(path)) throw new BuildWarmupError("authority");
  try {
    const canonical = realpathSync(path);
    const stat = statSync(canonical);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || writableRoots.some((root) => pathInside(root, canonical))) {
      throw new BuildWarmupError("authority");
    }
    return Object.freeze({ path: canonical, identity: executableIdentity(canonical) });
  } catch (error) {
    if (error instanceof BuildWarmupError) throw error;
    throw new BuildWarmupError("authority");
  }
}

function assertBuildExecutable(seal: BuildExecutableSeal): void {
  if (realpathSync(seal.path) !== seal.path || executableIdentity(seal.path) !== seal.identity) {
    throw new BuildWarmupError("authority");
  }
}

function executableIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  return createHash("sha256")
    .update(path).update("\0")
    .update([stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"))
    .update("\0").update(readFileSync(path)).digest("hex");
}

function pathInside(root: string, target: string): boolean {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolve(root));
  } catch {
    throw new BuildWarmupError("authority");
  }
  const rel = relative(canonicalRoot, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildEnvironment(input: Readonly<Record<string, string>>, cacheRoot: string): Readonly<Record<string, string>> {
  return Object.freeze({
    ...input,
    HOME: cacheRoot,
    XDG_CACHE_HOME: cacheRoot,
    DOKKABI_BUILD_CACHE_ROOT: cacheRoot,
  });
}

function digestOutputs(cacheRoot: string, outputs: readonly string[]): string {
  const hash = createHash("sha256");
  let total = 0;
  for (const output of [...outputs].sort()) {
    const path = join(cacheRoot, output);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BuildWarmupError("output");
    const bytes = readFileSync(path);
    total += bytes.byteLength;
    if (total > 16 * 1024 * 1024) throw new BuildWarmupError("output");
    hash.update(output).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

function assertCacheIdentity(cacheRoot: string, outputs: readonly string[], expected: string): void {
  try {
    if (digestOutputs(cacheRoot, outputs) !== expected) throw new BuildWarmupError("output");
  } catch (error) {
    if (error instanceof BuildWarmupError) throw error;
    throw new BuildWarmupError("output");
  }
}

function directoryIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BuildWarmupError("authority");
  return [stat.dev, stat.ino].join(":");
}

function removeCacheRoot(path: string, identity: string): void {
  if (!existsSync(path)) return;
  if (directoryIdentity(path) !== identity) throw new BuildWarmupError("authority");
  rmSync(path, { recursive: true, force: true });
}

function positiveTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : 30_000;
}
