import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SshRunnerResult } from "../../host/ssh.ts";

export interface SshControlProcess {
  readonly exited: Promise<number | null>;
  kill(): void;
}

export interface SshControlDriver {
  spawn(argv: readonly string[], env: Readonly<Record<string, string>>): SshControlProcess;
  run(
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<SshRunnerResult>;
}

const OUTPUT_LIMIT = 2 * 1024 * 1024;

export function createSshControlDriver(executable: string): SshControlDriver {
  return {
    spawn(argv, env) {
      const child = spawn(executable, argv, { env: { ...env }, stdio: "ignore", windowsHide: true });
      return wrapProcess(child);
    },
    run(argv, env, options) {
      return runProcess(executable, argv, env, options);
    },
  };
}

function wrapProcess(child: ChildProcess): SshControlProcess {
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return Object.freeze({
    exited,
    kill: () => { child.kill("SIGTERM"); },
  });
}

async function runProcess(
  executable: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
): Promise<SshRunnerResult> {
  const startedAt = performance.now();
  let child: ChildProcess;
  try {
    child = spawn(executable, argv, { env: { ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch {
    return emptyResult("spawn_failed", startedAt);
  }
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let retainedBytes = 0;
  let truncated = false;
  let state: SshRunnerResult["state"] = "completed";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (stream === "stdout") stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    const remaining = Math.max(0, OUTPUT_LIMIT - retainedBytes);
    if (remaining === 0) {
      truncated = true;
      return;
    }
    const retained = chunk.subarray(0, remaining);
    retainedBytes += retained.byteLength;
    const text = (stream === "stdout" ? stdoutDecoder : stderrDecoder).write(retained);
    if (chunk.byteLength > remaining) truncated = true;
    if (stream === "stdout") stdout += text;
    else stderr += text;
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  const stop = (next: "cancelled" | "timed_out"): void => {
    if (state !== "completed") return;
    state = next;
    child.kill("SIGTERM");
  };
  const onAbort = (): void => stop("cancelled");
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = options?.timeoutMs === undefined
    ? undefined
    : setTimeout(() => stop("timed_out"), options.timeoutMs);
  const exitCode = await new Promise<number | undefined>((resolve) => {
    child.once("error", () => {
      state = "spawn_failed";
      resolve(undefined);
    });
    child.once("close", (code) => resolve(typeof code === "number" ? code : undefined));
  });
  if (timer) clearTimeout(timer);
  options?.signal?.removeEventListener("abort", onAbort);
  stdout += stdoutDecoder.end();
  stderr += stderrDecoder.end();
  return {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...(exitCode === undefined ? {} : { exitCode }),
    state,
    stderr,
    stderrBytes,
    stdout,
    stdoutBytes,
    truncated,
  };
}

function emptyResult(state: "spawn_failed", startedAt: number): SshRunnerResult {
  return {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    state,
    stderr: "",
    stderrBytes: 0,
    stdout: "",
    stdoutBytes: 0,
    truncated: false,
  };
}
