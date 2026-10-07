import { createHash } from "node:crypto";
import {
  attestDockerImage,
  canonicalWorkspaceRoot,
  DOCKER_HOST_ENV_KEYS,
  dockerHostEnvironment,
  dockerHostEnvironmentDigest,
  dockerImageExecutionTarget,
  worktreeCommonGitDir,
} from "../host/sandbox-docker.ts";
import {
  assertSandboxExecutableIdentity,
  requireAndSealSandboxExecutable,
  type SandboxHostExecutableSeal,
} from "../host/sandbox-executable.ts";
import type { SandboxNetwork } from "../host/sandbox.ts";

export type SwarmWorldSpec =
  | { readonly kind: "local"; readonly network: SandboxNetwork }
  | { readonly kind: "docker"; readonly image: string; readonly network: SandboxNetwork };

export function assertSwarmWorldSpec(value: unknown): asserts value is SwarmWorldSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("swarm world must be an object");
  }
  const world = value as Record<string, unknown>;
  if (world.network !== "allow" && world.network !== "deny") {
    throw new Error("swarm world network must be allow or deny");
  }
  const expected = world.kind === "local"
    ? ["kind", "network"]
    : world.kind === "docker"
      ? ["image", "kind", "network"]
      : undefined;
  if (!expected) throw new Error("swarm world kind must be local or docker");
  const keys = Object.keys(world).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("swarm world has unknown or missing fields");
  }
  if (world.kind === "docker" && (typeof world.image !== "string" || world.image.trim().length === 0)) {
    throw new Error("Docker swarm world image must be a non-empty string");
  }
}

export interface SwarmWorldRequest {
  readonly spec: SwarmWorldSpec;
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

export interface SwarmWorldLease {
  readonly kind: SwarmWorldSpec["kind"];
  readonly id: string;
  readonly env: Readonly<Record<string, string>>;
  readonly gitMetadata?: "common-read-only";
}

// The host connection is deliberately not stored as an inspectable property.
// A provider may return a Proxy or a visible clone, but neither can mint the
// host-only authority that was captured before the world-open effect.
const SWARM_DOCKER_EXECUTION_TARGETS = new WeakMap<object, string>();

interface SwarmDockerPlanAuthority {
  readonly executable: SandboxHostExecutableSeal;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly hostEnvDigest: string;
  readonly imageExecutionTarget: string;
  readonly imageIdentityDigest: string;
}

const SWARM_DOCKER_PLAN_AUTHORITIES = new WeakMap<object, SwarmDockerPlanAuthority>();

/** Two-phase ownership handoff. Providers call this only after they own the
 * requested resource. A name-collision failure must throw without attesting. */
export interface SwarmWorldAllocationAttestor {
  allocated(lease: SwarmWorldLease): void;
}

const LOCAL_WORLD_ENV = {
  DOKKABI_DOCKER_CONTAINER: "",
  DOKKABI_DOCKER_IMAGE: "",
  DOKKABI_DOCKER_NETWORK_STATE: "",
  DOKKABI_SWE_CONTAINER: "",
  DOKKABI_SWE_IMAGE: "",
} as const;

function requestedWorldEnv(input: SwarmWorldRequest): Readonly<Record<string, string>> {
  return input.spec.kind === "local"
    ? { ...LOCAL_WORLD_ENV, DOKKABI_SANDBOX_NET: input.spec.network }
    : {
        DOKKABI_DOCKER_CONTAINER: swarmWorldId(input),
        DOKKABI_DOCKER_IMAGE: input.spec.image,
        DOKKABI_DOCKER_NETWORK_STATE: input.spec.network === "deny" ? "none" : "connected",
        DOKKABI_SANDBOX_NET: input.spec.network,
        DOKKABI_SWE_CONTAINER: "",
        DOKKABI_SWE_IMAGE: "",
      };
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

/**
 * A world provider is an execution boundary. Never trust its returned lease
 * to select a different container or network than the immutable dispatch.
 * Errors intentionally omit the supplied values: container/image coordinates
 * are private even when a provider is faulty.
 */
export function assertSwarmWorldLease(
  input: SwarmWorldRequest,
  value: unknown,
): asserts value is SwarmWorldLease {
  assertSwarmWorldSpec(input.spec);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("swarm world provider returned an invalid lease");
  }
  const lease = value as Record<string, unknown>;
  if (lease.kind !== input.spec.kind || lease.id !== swarmWorldId(input) || !isStringRecord(lease.env)) {
    throw new Error("swarm world lease does not match its request");
  }
  const leaseEnv = lease.env as Readonly<Record<string, string>>;
  const expectedMetadata = swarmWorldGitMetadata(input);
  if (lease.gitMetadata !== expectedMetadata) {
    throw new Error("swarm world lease Git metadata does not match its request");
  }

  const expectedEnv = requestedWorldEnv(input);
  const expectedEntries = Object.entries(expectedEnv);
  if (Object.keys(leaseEnv).length !== expectedEntries.length ||
    expectedEntries.some(([key, expected]) => leaseEnv[key] !== expected)) {
    throw new Error("swarm world lease environment does not match its request");
  }
}

/** Safe identity derived only from the sealed request. Cleanup must never use
 * an id or metadata value returned by a provider before that lease validates. */
export function plannedSwarmWorldLease(input: SwarmWorldRequest): SwarmWorldLease {
  assertSwarmWorldSpec(input.spec);
  const gitMetadata = swarmWorldGitMetadata(input);
  let dockerAuthority: SwarmDockerPlanAuthority | undefined;
  if (input.spec.kind === "docker") {
    const hostEnv = dockerHostEnvironment();
    const executable = sealWorldDockerExecutable(input);
    assertSandboxExecutableIdentity(executable);
    const image = attestDockerImage(executable.path, input.spec.image, hostEnv);
    dockerAuthority = Object.freeze({
      executable,
      hostEnv,
      hostEnvDigest: dockerHostEnvironmentDigest(hostEnv),
      imageExecutionTarget: dockerImageExecutionTarget(image),
      imageIdentityDigest: image.imageIdentityDigest,
    });
  }
  const lease: SwarmWorldLease = Object.freeze({
    kind: input.spec.kind,
    id: swarmWorldId(input),
    env: Object.freeze({ ...requestedWorldEnv(input) }),
    ...(gitMetadata ? { gitMetadata } : {}),
  });
  if (dockerAuthority) SWARM_DOCKER_PLAN_AUTHORITIES.set(lease, dockerAuthority);
  return lease;
}

/** Digest-only public binding for dispatch and lifecycle evidence. */
export function swarmWorldImageIdentityDigest(
  input: SwarmWorldRequest,
  lease: SwarmWorldLease,
): string | undefined {
  assertSwarmWorldLease(input, lease);
  if (input.spec.kind !== "docker") return undefined;
  const authority = SWARM_DOCKER_PLAN_AUTHORITIES.get(lease);
  if (!authority) throw new Error("Docker swarm world lease has no sealed image authority");
  return authority.imageIdentityDigest;
}

/** Return the only environment that may cross into the child process. */
export function sealedSwarmWorldEnv(
  input: SwarmWorldRequest,
  lease: SwarmWorldLease,
): Readonly<Record<string, string | undefined>> {
  assertSwarmWorldLease(input, lease);
  const dockerAuthority = input.spec.kind === "docker"
    ? SWARM_DOCKER_PLAN_AUTHORITIES.get(lease)
    : undefined;
  const executionTarget = input.spec.kind === "docker"
    ? SWARM_DOCKER_EXECUTION_TARGETS.get(lease)
    : undefined;
  if (input.spec.kind === "docker" && (!dockerAuthority || !executionTarget)) {
    throw new Error("Docker swarm world lease has no host-sealed connection authority");
  }
  const sealed: Record<string, string | undefined> = {
    ...requestedWorldEnv(input),
    ...(executionTarget && dockerAuthority
      ? {
          DOKKABI_DOCKER_CONTAINER: executionTarget,
          DOKKABI_DOCKER_IMAGE: dockerAuthority.imageExecutionTarget,
        }
      : {}),
    ...(dockerAuthority
      ? Object.fromEntries(DOCKER_HOST_ENV_KEYS.map((key) => [key, dockerAuthority.hostEnv[key]]))
      : {}),
  };
  return Object.freeze(sealed);
}

export interface WorldCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type WorldCommandRunner = (
  argv: readonly string[],
  hostEnv?: Readonly<Record<string, string>>,
) => WorldCommandResult;

interface WorldExecutionAuthority {
  readonly executable: SandboxHostExecutableSeal;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly hostEnvDigest: string;
  readonly executionTarget: string;
}

const WORLD_EXECUTION_AUTHORITIES = new Map<string, WorldExecutionAuthority>();

function worldAllocationKey(lease: SwarmWorldLease): string {
  return createHash("sha256").update(JSON.stringify({
    kind: lease.kind,
    id: lease.id,
    image: lease.env.DOKKABI_DOCKER_IMAGE ?? "",
    network: lease.env.DOKKABI_DOCKER_NETWORK_STATE ?? "",
    gitMetadata: lease.gitMetadata ?? "",
  })).digest("hex");
}

function defaultRunner(
  argv: readonly string[],
  hostEnv: Readonly<Record<string, string>> = dockerHostEnvironment(),
): WorldCommandResult {
  const result = Bun.spawnSync([...argv], {
    env: { ...hostEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function swarmWorldId(input: SwarmWorldRequest): string {
  assertSwarmWorldSpec(input.spec);
  if (input.spec.kind === "local") {
    return "local";
  }
  const sessionId = input.sessionId;
  const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-48);
  return `dokkabi-world-${safe}`;
}

export function swarmWorldGitMetadata(input: SwarmWorldRequest): "common-read-only" | undefined {
  assertSwarmWorldSpec(input.spec);
  return input.spec.kind === "docker" && worktreeCommonGitDir(input.workspaceRoot)
    ? "common-read-only"
    : undefined;
}

export function dockerWorldArgv(input: SwarmWorldRequest, id: string): string[] {
  assertSwarmWorldSpec(input.spec);
  if (input.spec.kind !== "docker") {
    throw new Error("docker world argv requires a Docker world specification");
  }
  const seal = sealWorldDockerExecutable(input);
  assertSandboxExecutableIdentity(seal);
  const hostEnv = dockerHostEnvironment();
  const image = attestDockerImage(seal.path, input.spec.image, hostEnv);
  return dockerWorldArgvWithSeal(input, id, seal, dockerImageExecutionTarget(image));
}

function dockerWorldArgvWithSeal(
  input: SwarmWorldRequest,
  id: string,
  seal: SandboxHostExecutableSeal,
  imageExecutionTarget: string,
): string[] {
  assertSwarmWorldSpec(input.spec);
  if (input.spec.kind !== "docker") throw new Error("docker world argv requires a Docker world specification");
  const commonGitDir = worktreeCommonGitDir(input.workspaceRoot);
  const workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
  const dockerNetwork = input.spec.network === "deny" ? "none" : "bridge";
  return [
    seal.path, "run", "-d", "--rm", "--name", id,
    "--network", dockerNetwork,
    "--mount", `type=bind,source=${workspaceRoot},target=/testbed`,
    ...(commonGitDir
      ? ["--mount", `type=bind,source=${commonGitDir},target=${commonGitDir},readonly`]
      : []),
    "-w", "/testbed",
    imageExecutionTarget,
    "sleep", "infinity",
  ];
}

function sealWorldDockerExecutable(input: SwarmWorldRequest): SandboxHostExecutableSeal {
  const commonGitDir = worktreeCommonGitDir(input.workspaceRoot);
  const workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
  return requireAndSealSandboxExecutable("docker", [
    workspaceRoot,
    ...(commonGitDir ? [commonGitDir] : []),
  ]);
}

export function openSwarmWorld(
  input: SwarmWorldRequest,
  run: WorldCommandRunner = defaultRunner,
  ownership?: SwarmWorldAllocationAttestor,
  plannedLease: SwarmWorldLease = plannedSwarmWorldLease(input),
): SwarmWorldLease {
  assertSwarmWorldSpec(input.spec);
  assertSwarmWorldLease(input, plannedLease);
  if (input.spec.kind === "local") {
    ownership?.allocated(plannedLease);
    return plannedLease;
  }
  const id = swarmWorldId(input);
  const lease = plannedLease;
  const allocationKey = worldAllocationKey(lease);
  if (WORLD_EXECUTION_AUTHORITIES.has(allocationKey)) {
    throw new Error("Docker swarm world allocation identity is already active");
  }
  const plan = SWARM_DOCKER_PLAN_AUTHORITIES.get(lease);
  if (!plan) {
    throw new Error("Docker swarm world lease has no host-sealed connection authority");
  }
  const { executable, hostEnv } = plan;
  if (dockerHostEnvironmentDigest(hostEnv) !== plan.hostEnvDigest) {
    throw new Error("Docker swarm world host connection authority changed");
  }
  const authority = Object.freeze({
    executable,
    hostEnv,
    hostEnvDigest: dockerHostEnvironmentDigest(hostEnv),
  });
  assertSandboxExecutableIdentity(executable);
  const imageAttestation = attestDockerImage(
    executable.path,
    plan.imageExecutionTarget,
    authority.hostEnv,
  );
  if (dockerImageExecutionTarget(imageAttestation) !== plan.imageExecutionTarget ||
    imageAttestation.imageIdentityDigest !== plan.imageIdentityDigest) {
    throw new Error("Docker swarm world image authority changed after planning");
  }
  const result = run(
    dockerWorldArgvWithSeal(input, id, executable, plan.imageExecutionTarget),
    authority.hostEnv,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Docker swarm world failed to start: ${(result.stderr || result.stdout).trim()}`);
  }
  const executionTarget = dockerRunExecutionTarget(result.stdout);
  WORLD_EXECUTION_AUTHORITIES.set(allocationKey, Object.freeze({ ...authority, executionTarget }));
  SWARM_DOCKER_EXECUTION_TARGETS.set(lease, executionTarget);
  ownership?.allocated(lease);
  return lease;
}

export function closeSwarmWorld(
  lease: SwarmWorldLease,
  run: WorldCommandRunner = defaultRunner,
): void {
  if (lease.kind === "local") {
    return;
  }
  const allocationKey = worldAllocationKey(lease);
  const authority = WORLD_EXECUTION_AUTHORITIES.get(allocationKey);
  if (!authority) throw new Error("Docker swarm world lease has no sealed host execution authority");
  if (dockerHostEnvironmentDigest(authority.hostEnv) !== authority.hostEnvDigest) {
    throw new Error("Docker swarm world host connection authority changed");
  }
  assertSandboxExecutableIdentity(authority.executable);
  const result = run(
    [authority.executable.path, "rm", "-f", authority.executionTarget],
    authority.hostEnv,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Docker swarm world failed to close: ${(result.stderr || result.stdout).trim()}`);
  }
  WORLD_EXECUTION_AUTHORITIES.delete(allocationKey);
  SWARM_DOCKER_EXECUTION_TARGETS.delete(lease);
}

function dockerRunExecutionTarget(stdout: string): string {
  const matched = /^([a-f0-9]{64})(?:\r?\n)?$/u.exec(stdout);
  if (!matched?.[1]) {
    throw new Error("Docker swarm world returned an invalid allocation identity");
  }
  return matched[1];
}
