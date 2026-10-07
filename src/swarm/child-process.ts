import { createHash } from "node:crypto";
import { join } from "node:path";
import { completeLength } from "../dash/decode.ts";

export type ChildProcessStatus = "completed" | "failed" | "cancelled" | "timeout";

export interface BoundedProcessResult {
  status: ChildProcessStatus;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutCapturedBytes: number;
  stderrCapturedBytes: number;
  stdoutDigest: string;
  stderrDigest: string;
  /** Bounded UTF-8 suffix of stdout for operator-facing child failures. */
  stdoutTail: string;
  /** Bounded UTF-8 suffix of stderr for operator-facing child failures. */
  stderrTail: string;
}

export function failedProcessResult(): BoundedProcessResult {
  const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  return {
    status: "failed",
    exitCode: null,
    signalCode: null,
    killed: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutCapturedBytes: 0,
    stderrCapturedBytes: 0,
    stdoutDigest: emptyDigest,
    stderrDigest: emptyDigest,
    stdoutTail: "",
    stderrTail: "",
  };
}

export interface RunBoundedProcessInput {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  maxCaptureBytes?: number;
  signal?: AbortSignal;
}

interface StreamEvidence {
  bytes: number;
  capturedBytes: number;
  digest: string;
  tail: string;
}

/** Extra bytes before a tail window so the first decoded code point is complete. */
const UTF8_TAIL_PAD = 3;

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Decode a byte window without splitting a UTF-8 code point at the front. */
function decodeUtf8TailBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  const slice = bytes.subarray(start);
  const end = completeLength(slice);
  return new TextDecoder("utf-8").decode(slice.subarray(0, end));
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  maxCaptureBytes: number,
): Promise<StreamEvidence> {
  const reader = stream.getReader();
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    hash.update(chunk.value);
    bytes += chunk.value.byteLength;
    chunks.push(chunk.value);
  }
  const all = concatBytes(chunks);
  const capturedBytes = Math.min(all.length, maxCaptureBytes);
  const tail = tailTextFromBytes(all, maxCaptureBytes);
  return {
    bytes,
    capturedBytes,
    digest: hash.digest("hex"),
    tail,
  };
}

/** Last maxCaptureBytes decoded characters; byte suffix stays UTF-8 safe. */
function tailTextFromBytes(all: Uint8Array, maxCaptureBytes: number): string {
  if (all.length === 0) return "";
  if (all.length <= maxCaptureBytes + UTF8_TAIL_PAD) {
    return decodeUtf8TailBytes(all);
  }
  const windowStart = Math.max(0, all.length - maxCaptureBytes - UTF8_TAIL_PAD);
  const decoded = decodeUtf8TailBytes(all.subarray(windowStart));
  return decoded.length > maxCaptureBytes ? decoded.slice(-maxCaptureBytes) : decoded;
}

export async function runBoundedProcess(input: RunBoundedProcessInput): Promise<BoundedProcessResult> {
  const processHandle = Bun.spawn([...input.argv], {
    cwd: input.cwd,
    env: { ...input.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (processHandle.exitCode !== null) {
      return;
    }
    processHandle.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (processHandle.exitCode === null) {
        processHandle.kill("SIGKILL");
      }
    }, 1_000);
  };
  const abort = () => {
    cancelled = true;
    terminate();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) {
    abort();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);
  try {
    const maxCaptureBytes = input.maxCaptureBytes ?? 64 * 1024;
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      readStream(processHandle.stdout, maxCaptureBytes),
      readStream(processHandle.stderr, maxCaptureBytes),
    ]);
    const status: ChildProcessStatus = timedOut
      ? "timeout"
      : cancelled
        ? "cancelled"
        : exitCode === 0
          ? "completed"
          : "failed";
    return {
      status,
      exitCode: processHandle.exitCode,
      signalCode: processHandle.signalCode === null ? null : String(processHandle.signalCode),
      killed: processHandle.killed,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutCapturedBytes: stdout.capturedBytes,
      stderrCapturedBytes: stderr.capturedBytes,
      stdoutDigest: stdout.digest,
      stderrDigest: stderr.digest,
      stdoutTail: stdout.tail,
      stderrTail: stderr.tail,
    };
  } finally {
    clearTimeout(timeout);
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    input.signal?.removeEventListener("abort", abort);
  }
}

export interface RunDokkabiChildInput {
  repoRoot: string;
  sessionId: string;
  workspaceRoot: string;
  route: string;
  order: string;
  maxSteps: number;
  timeoutMs: number;
  planPath?: string;
  /** Omit for swarm default (work). Explicit null skips --decision work. */
  decision?: "work" | null;
  deferAcceptance?: boolean;
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

function resolveWorkDecision(input: RunDokkabiChildInput): "work" | null {
  if (!Object.prototype.hasOwnProperty.call(input, "decision")) {
    return "work";
  }
  return input.decision ?? null;
}

export function runDokkabiChild(input: RunDokkabiChildInput): Promise<BoundedProcessResult> {
  const decision = resolveWorkDecision(input);
  return runBoundedProcess({
    argv: [
      process.execPath,
      join(input.repoRoot, "src", "cli.ts"),
      "work",
      // Swarm children run the gated graph planner; the CLI default is the
      // ledger (D43).
      "--planner",
      "host",
      ...(decision ? ["--decision", decision] : []),
      "--session",
      input.sessionId,
      "--workspace",
      input.workspaceRoot,
      "--route",
      input.route,
      "--max-steps",
      String(input.maxSteps),
      ...(input.planPath ? ["--plan", input.planPath] : []),
      ...(input.deferAcceptance ? ["--defer-acceptance"] : []),
      input.order,
    ],
    cwd: input.workspaceRoot,
    env: input.env,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
}
