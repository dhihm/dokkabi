import type { WarmupLease, WarmupRegistry } from "./registry.ts";
import { authorityForWarmupCandidate } from "./candidate.ts";
import type { WarmupCandidateReceipt } from "./candidate.ts";
import {
  attestDockerImage,
  dockerHostEnvironment,
  dockerHostEnvironmentDigest,
  dockerImageExecutionTarget,
} from "../../host/sandbox-docker.ts";
import {
  assertSandboxExecutableIdentity,
  requireAndSealSandboxExecutable,
  type SandboxHostExecutableSeal,
} from "../../host/sandbox-executable.ts";

export type WarmupCommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
export type DockerWarmupRunner = (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<WarmupCommandResult>;

export type DockerWarmupInput = {
  readonly registry: WarmupRegistry;
  readonly receipt: WarmupCandidateReceipt;
  readonly image: string;
  readonly startupCommand: readonly string[];
  readonly foregroundCommand: readonly string[];
  readonly writableRoots: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly runner?: DockerWarmupRunner;
};

export type DockerWarmResource = {
  readonly imageIdentityDigest: string;
  readonly run: () => Promise<WarmupCommandResult>;
};

export class DockerWarmupError extends Error {
  readonly code: "authority" | "allocation" | "readiness" | "cleanup";

  constructor(code: DockerWarmupError["code"]) {
    super(`Docker warmup ${code}`);
    this.name = "DockerWarmupError";
    this.code = code;
  }
}

type DockerAllocation = {
  readonly executable: SandboxHostExecutableSeal;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly hostEnvDigest: string;
  readonly containerId: string;
  readonly runner: DockerWarmupRunner;
};

const ALLOCATIONS = new WeakMap<DockerWarmResource, DockerAllocation>();

export function prepareDockerWarmup(input: DockerWarmupInput): WarmupLease<DockerWarmResource> {
  assertDockerInput(input);
  const authority = authorityForWarmupCandidate("docker", input.receipt, {
    image: input.image,
    startupCommand: input.startupCommand,
    foregroundCommand: input.foregroundCommand,
  });
  const hostEnv = dockerHostEnvironment();
  const executable = requireAndSealSandboxExecutable("docker", input.writableRoots);
  assertSandboxExecutableIdentity(executable);
  const image = attestDockerImage(executable.path, input.image, hostEnv);
  const imageExecutionTarget = dockerImageExecutionTarget(image);
  const imageIdentityDigest = image.imageIdentityDigest;
  const runner = input.runner ?? runDockerCommand;
  const fixed = Object.freeze({
    authority,
    hostEnv,
    hostEnvDigest: dockerHostEnvironmentDigest(hostEnv),
    executable,
    imageExecutionTarget,
    imageIdentityDigest,
    imageReference: input.image,
    startupCommand: Object.freeze([...input.startupCommand]),
    foregroundCommand: Object.freeze([...input.foregroundCommand]),
    runner,
  });
  return input.registry.prepare({
    authority: fixed.authority,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    acquire: async (signal) => {
      assertDockerSeal(fixed);
      let containerId: string | undefined;
      try {
        const started = await runner([
          executable.path, "run", "-d", "--rm", "--network", "none",
          "--label", `dokkabi.speculative.warmup=${fixed.authority.keyDigest}`,
          imageExecutionTarget, ...fixed.startupCommand,
        ], hostEnv, signal);
        if (started.exitCode !== 0) throw new DockerWarmupError("allocation");
        const allocatedId = dockerContainerId(started.stdout);
        containerId = allocatedId;
        await waitUntilRunning(fixed, allocatedId, signal);
        let foregroundStarted = false;
        const resource = Object.freeze({
          imageIdentityDigest,
          run: async () => {
            if (foregroundStarted) throw new DockerWarmupError("authority");
            foregroundStarted = true;
            assertDockerSeal(fixed);
            return runner([
              executable.path, "exec", allocatedId, ...fixed.foregroundCommand,
            ], hostEnv, signal);
          },
        });
        ALLOCATIONS.set(resource, Object.freeze({
          executable, hostEnv, hostEnvDigest: fixed.hostEnvDigest, containerId: allocatedId, runner,
        }));
        return resource;
      } catch (error) {
        if (containerId) {
          await removeContainer(
            { executable, hostEnv, hostEnvDigest: fixed.hostEnvDigest, containerId, runner },
            new AbortController().signal,
          );
        }
        if (error instanceof DockerWarmupError) throw error;
        throw new DockerWarmupError(signal.aborted ? "readiness" : "allocation");
      }
    },
    release: async (resource) => {
      const allocation = ALLOCATIONS.get(resource);
      if (!allocation) return;
      ALLOCATIONS.delete(resource);
      await removeContainer(allocation, new AbortController().signal);
    },
  });
}

function assertDockerInput(input: DockerWarmupInput): void {
  if (!input.image.trim() || input.writableRoots.length === 0) throw new DockerWarmupError("authority");
  assertCommand(input.startupCommand);
  assertCommand(input.foregroundCommand);
}

function assertCommand(command: readonly string[]): void {
  if (command.length === 0 || command.length > 64 || command.some((part) => !part || part.length > 16_384 || /[\0\r\n]/u.test(part))) {
    throw new DockerWarmupError("authority");
  }
}

function assertDockerConnection(input: {
  readonly executable: SandboxHostExecutableSeal;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly hostEnvDigest: string;
}): void {
  assertSandboxExecutableIdentity(input.executable);
  if (dockerHostEnvironmentDigest(input.hostEnv) !== input.hostEnvDigest) throw new DockerWarmupError("authority");
}

function assertDockerSeal(input: {
  readonly executable: SandboxHostExecutableSeal;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly hostEnvDigest: string;
  readonly imageExecutionTarget: string;
  readonly imageIdentityDigest: string;
  readonly imageReference: string;
}): void {
  assertDockerConnection(input);
  const immutable = attestDockerImage(input.executable.path, input.imageExecutionTarget, input.hostEnv);
  const selected = attestDockerImage(input.executable.path, input.imageReference, input.hostEnv);
  if (immutable.imageIdentityDigest !== input.imageIdentityDigest || dockerImageExecutionTarget(immutable) !== input.imageExecutionTarget ||
    selected.imageIdentityDigest !== input.imageIdentityDigest || dockerImageExecutionTarget(selected) !== input.imageExecutionTarget) {
    throw new DockerWarmupError("authority");
  }
}

async function waitUntilRunning(
  input: {
    readonly executable: SandboxHostExecutableSeal;
    readonly hostEnv: Readonly<Record<string, string>>;
    readonly hostEnvDigest: string;
    readonly runner: DockerWarmupRunner;
  },
  containerId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    assertDockerConnection(input);
    const result = await input.runner([
      input.executable.path, "inspect", "--format", "{{.State.Running}}", containerId,
    ], input.hostEnv, signal);
    if (result.exitCode === 0 && result.stdout.trim() === "true") return;
    await abortableDelay(signal);
  }
  throw new DockerWarmupError("readiness");
}

async function removeContainer(allocation: DockerAllocation, signal: AbortSignal): Promise<void> {
  assertDockerConnection(allocation);
  const result = await allocation.runner([
    allocation.executable.path, "rm", "-f", allocation.containerId,
  ], allocation.hostEnv, signal);
  if (result.exitCode !== 0) throw new DockerWarmupError("cleanup");
}

function dockerContainerId(stdout: string): string {
  const match = /^([a-f0-9]{64})(?:\r?\n)?$/u.exec(stdout);
  if (!match?.[1]) throw new DockerWarmupError("allocation");
  return match[1];
}

async function abortableDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function runDockerCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<WarmupCommandResult> {
  const process = Bun.spawn([...argv], { env: { ...env }, signal, timeout: 30_000, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
