import {
  beginSandboxExecution,
  consumePreparedSandboxExecution,
  endSandboxExecution,
  fencedArgv,
  prepareSandboxExecution,
  type SandboxPolicy,
} from "../../host/sandbox.ts";
import type { WarmupCommandResult } from "./docker.ts";

const MAX_RESULT_BYTES = 32 * 1024;

export class BuildWarmupError extends Error {
  readonly code: "authority" | "execution" | "output";

  constructor(code: BuildWarmupError["code"]) {
    super(`build warmup ${code}`);
    this.name = "BuildWarmupError";
    this.code = code;
  }
}

export async function runSealedBuild(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly policy: SandboxPolicy;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<WarmupCommandResult> {
  if (input.signal.aborted) throw new BuildWarmupError("execution");
  const command = [
    "/usr/bin/env",
    ...Object.entries(input.environment).map(([key, value]) => `${key}=${value}`),
    input.executable,
    ...input.args,
  ].map(shellWord).join(" ");
  const prepared = prepareSandboxExecution(input.policy);
  consumePreparedSandboxExecution(prepared);
  // G2' (D57h): the build's own capability; its processes end with it.
  const membership = beginSandboxExecution(input.policy);
  const argv = fencedArgv(input.policy, command, membership);
  try {
    return await runBuild(argv, input);
  } finally {
    if (endSandboxExecution(input.policy, membership) > 0) throw new Error("warmup execution cleanup remains unverified");
  }
}

async function runBuild(argv: string[], input: {
  readonly policy: SandboxPolicy;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<WarmupCommandResult> {
  const process = Bun.spawn(argv, {
    cwd: input.policy.workspaceRoot,
    env: input.policy.backend === "docker"
      ? { ...(input.policy.dockerHostEnv ?? {}) }
      : { ...input.policy.childEnv },
    signal: input.signal,
    timeout: input.timeoutMs,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readBounded(process.stdout),
    readBounded(process.stderr),
  ]);
  if (input.signal.aborted) throw new BuildWarmupError("execution");
  return { exitCode, stdout, stderr };
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let remaining = MAX_RESULT_BYTES;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (remaining > 0) {
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      remaining -= chunk.byteLength;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
