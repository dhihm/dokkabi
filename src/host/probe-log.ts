import { close, createReadStream, read } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { EventLog } from "./event-log.ts";
import {
  createPolicy,
  beginSandboxExecution,
  createReadOnlyPolicyFrom,
  disposeSandboxPolicy,
  endSandboxExecution,
  fencedArgv,
  appendSandboxExecutionEvent,
  prepareSandboxExecution,
  consumePreparedSandboxExecution,
  type SandboxPolicy,
} from "./sandbox.ts";
import { sliceUtf8BytesHead } from "../tools/model-result.ts";
import { WorkspacePathError } from "./path-error.ts";
import { openHeldProbeTarget, type HeldTargetFile, type TargetTraversalHook } from "./probe-target.ts";
export { openHeldBlobTarget, openHeldWorkspaceTarget, openHeldProbeTarget, resolveProbeTarget, type HeldTargetFile, type TargetTraversalHook } from "./probe-target.ts";
export const PROBE_LOG_TIMEOUT_DEFAULT_SECONDS = 5, PROBE_LOG_TIMEOUT_MAX_SECONDS = 15;
export const PROBE_LOG_LINES_DEFAULT = 50, PROBE_LOG_LINES_MAX = 200;
export const PROBE_LOG_BYTES_DEFAULT = 8_192, PROBE_LOG_BYTES_MAX = 32_768;
export interface ProbeLogInput {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly script: string;
  readonly runtime?: "python" | "bun";
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly timeoutSeconds?: number;
  readonly policy?: SandboxPolicy;
  readonly log?: EventLog;
  readonly signal?: AbortSignal;
  readonly hook?: TargetTraversalHook;
}

export interface ProbeLogResult {
  readonly text: string;
  readonly lines: number;
  readonly truncated: boolean;
  readonly error: boolean;
  readonly exitCode?: number;
}

export function createStrictReadOnlyPolicy(workspaceRoot: string, basePolicy?: SandboxPolicy): SandboxPolicy {
  if (!basePolicy) return createPolicy({ mode: "read-only", workspaceRoot, writablePaths: [] });
  if (basePolicy.backend === "docker") {
    if (basePolicy.mode === "read-only" && (basePolicy.writablePaths?.length ?? 0) > 0) {
      throw new Error("read-only Docker probe policy cannot carry writable paths");
    }
    return createReadOnlyPolicyFrom(basePolicy);
  }
  if (basePolicy.mode === "read-only" && (basePolicy.writablePaths?.length ?? 0) === 0) {
    return createReadOnlyPolicyFrom(basePolicy);
  }
  return createPolicy({ mode: "read-only", workspaceRoot: basePolicy.workspaceRoot, backend: basePolicy.backend, writablePaths: [] });
}

function clampOutput(rawText: string, maxLines: number, maxBytes: number, wasAborted: boolean): { text: string; lines: number; truncated: boolean } {
  let lines = rawText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const lineTruncated = lines.length > maxLines;
  if (lineTruncated) lines = lines.slice(0, maxLines);
  const body = lines.join("\n");
  const initialBytes = Buffer.byteLength(body, "utf8");
  if (!wasAborted && !lineTruncated && initialBytes <= maxBytes) {
    return { text: body.length > 0 ? body : "probe_log: no output produced", lines: lines.length, truncated: false };
  }

  const marker = `\n[probe_log truncated at ${lines.length} lines / ${initialBytes} bytes]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) return { text: sliceUtf8BytesHead(marker, maxBytes), lines: lines.length, truncated: true };
  const fitted = sliceUtf8BytesHead(body, maxBytes - markerBytes);
  return { text: `${fitted}${marker}`, lines: lines.length, truncated: true };
}

/** Did the script fail because it tried to WRITE from a read-only sandbox? */
function writeRefusal(details: string): boolean {
  return /operation not permitted|permissionerror|read-only file system|eacces|eperm/i.test(details);
}

export async function executeProbeLog(input: ProbeLogInput): Promise<ProbeLogResult> {
  const maxBytes = Math.min(Math.max(256, input.maxBytes ?? PROBE_LOG_BYTES_DEFAULT), PROBE_LOG_BYTES_MAX);
  const maxLines = Math.min(Math.max(1, input.maxLines ?? PROBE_LOG_LINES_DEFAULT), PROBE_LOG_LINES_MAX);
  const timeoutSec = Math.min(Math.max(1, input.timeoutSeconds ?? PROBE_LOG_TIMEOUT_DEFAULT_SECONDS), PROBE_LOG_TIMEOUT_MAX_SECONDS);

  const errorResult = (message: string): ProbeLogResult => {
    const textBytes = Buffer.byteLength(message, "utf8");
    const text = textBytes > maxBytes ? sliceUtf8BytesHead(message, maxBytes) : message;
    return { text, lines: 0, truncated: textBytes > maxBytes, error: true };
  };

  if (input.signal?.aborted) {
    return errorResult(`probe_log aborted: ${input.signal.reason instanceof Error ? input.signal.reason.message : "cancelled"}`);
  }
  if (!input.script?.trim()) return errorResult("probe_log: script is required");

  const root = resolve(input.workspaceRoot);
  let heldTarget: HeldTargetFile;
  try {
    heldTarget = openHeldProbeTarget(input.path, root, input.log, input.hook);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The shared path vocabulary already names the tool and the condition.
    return errorResult(err instanceof WorkspacePathError ? message : `probe_log target error: ${message}`);
  }
  let policy: SandboxPolicy, wrapped: string[], ownedPolicy: SandboxPolicy | undefined;
  let membership: ReturnType<typeof beginSandboxExecution>;
  try {
    const runtime = input.runtime === "bun" ? "bun" : "python";
    policy = createStrictReadOnlyPolicy(root, input.policy);
    if (policy !== input.policy) ownedPolicy = policy;
    const b64Script = Buffer.from(input.script).toString("base64");
    const command = runtime === "bun"
      ? `bun -e "import('data:text/javascript;base64,${b64Script}')"`
      : `python3 -c "import base64; exec(base64.b64decode('${b64Script}').decode('utf-8'))"`;
    const commandDigest = createHash("sha256").update(command).digest("hex");
    const prepared = input.log
      ? appendSandboxExecutionEvent({
          log: input.log,
          policy,
          evidence: { kind: "direct", commandDigest },
        })
      : prepareSandboxExecution(policy);
    consumePreparedSandboxExecution(prepared);
    // G2' (D57h): the probe's own capability; its processes end with it.
    membership = beginSandboxExecution(policy);
    wrapped = fencedArgv(policy, command, membership);
  } catch (error) { heldTarget.close(); if (ownedPolicy) disposeSandboxPolicy(ownedPolicy); throw error; }
  let dockerContainer: string | undefined;
  if (policy.backend === "docker" && policy.dockerBinary) {
    dockerContainer = `dokkabi-probe-${randomUUID().slice(0, 12)}`;
    const runIdx = wrapped.indexOf("run");
    if (runIdx !== -1) wrapped.splice(runIdx + 1, 0, "--name", dockerContainer, "--label", `dokkabi.probe-owner=${createHash("sha256").update(policy.workspaceRoot).digest("hex")}`);
  }
  const childEnv = policy.backend === "docker" ? { ...(policy.dockerHostEnv ?? {}) } : { ...policy.childEnv, PYTHONUNBUFFERED: "1" };
  const dockerHostEnv = policy.backend === "docker" ? { ...(policy.dockerHostEnv ?? {}) } : undefined;
  return new Promise<ProbeLogResult>((resolvePromise) => {
    let settled = false;
    let killed = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let truncated = false;
    let dockerCleanupError: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const child = spawn(wrapped[0]!, wrapped.slice(1), { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: childEnv, detached: true });

    const killGroup = () => {
      if (killed) return;
      killed = true;
      const pid = child.pid;
      if (pid) {
        try { process.kill(-pid, "SIGKILL"); } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
      }
      try {
        if (endSandboxExecution(policy, membership) > 0) dockerCleanupError = "execution cleanup remains unverified";
      } catch { dockerCleanupError = "execution membership inspection failed"; }
      if (dockerContainer && policy.dockerBinary) {
        try {
          const res = spawnSync(policy.dockerBinary, ["rm", "-f", dockerContainer], {
            env: dockerHostEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: maxBytes,
          });
          if (res.error || res.status === null || res.status !== 0) {
            const detail = res.error?.message
              || (res.signal ? `signal ${res.signal}` : "")
              || (res.stderr ? res.stderr.toString("utf8").trim() : "")
              || `exit ${res.status}`;
            dockerCleanupError = `docker cleanup failed: ${detail}`;
          }
        } catch (err) {
          dockerCleanupError = `docker cleanup error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    };

    const finish = (result: ProbeLogResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortListener && input.signal) input.signal.removeEventListener("abort", abortListener);
      killGroup();
      let finalResult = result;
      if (dockerCleanupError) {
        const warningPrefix = "\n[warning: ", warningSuffix = "]";
        const detailBudget = maxBytes - Buffer.byteLength(`${warningPrefix}${warningSuffix}`, "utf8");
        const warningDetail = sliceUtf8BytesHead(dockerCleanupError, detailBudget);
        const warningText = `${warningPrefix}${warningDetail}${warningSuffix}`;
        const warningBytes = Buffer.byteLength(warningText, "utf8");
        const body = sliceUtf8BytesHead(finalResult.text, maxBytes - warningBytes);
        const warningTruncated = warningDetail !== dockerCleanupError || body !== finalResult.text;
        finalResult = { ...finalResult, text: `${body}${warningText}`, error: true, truncated: finalResult.truncated || warningTruncated };
      }
      let resolved = false;
      const onDone = () => {
        if (resolved) return;
        resolved = true;
        if (ownedPolicy) disposeSandboxPolicy(ownedPolicy);
        resolvePromise(finalResult);
      };
      if (fileStream.closed) onDone();
      else {
        fileStream.once("close", onDone);
        fileStream.destroy();
      }
    };

    if (input.signal) {
      abortListener = () => {
        const msg = input.signal?.reason instanceof Error ? input.signal.reason.message : "cancelled";
        finish(errorResult(`probe_log aborted: ${msg}`));
      };
      input.signal.addEventListener("abort", abortListener, { once: true });
    }

    timer = setTimeout(() => finish(errorResult(`probe_log timed out after ${timeoutSec}s`)), timeoutSec * 1000);

    // Explicit callbacks keep descriptor ownership on the normal stream path.
    // Bun 1.3.14's fast path waits for an event it never emits on this fd stream.
    const fileStream = createReadStream("", { fd: heldTarget.fd, start: 0, autoClose: true, fs: { read, close } });
    heldTarget = { ...heldTarget, close: () => {} };
    fileStream.on("error", (err) => finish(errorResult(`probe_log file stream error: ${err.message}`)));
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ERR_STREAM_WRITE_AFTER_END") return;
      finish(errorResult(`probe_log stdin error: ${err.message}`));
    });
    fileStream.pipe(child.stdin);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      stdoutBuffer += stdoutDecoder.write(chunk);
      if (Buffer.byteLength(stdoutBuffer, "utf8") > maxBytes * 2) {
        truncated = true;
        fileStream.destroy();
        killGroup();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderrBuffer, "utf8") < maxBytes * 2) stderrBuffer += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => finish(errorResult(`probe_log spawn error: ${err.message}`)));

    child.on("close", (code) => {
      stdoutBuffer += stdoutDecoder.end();
      stderrBuffer += stderrDecoder.end();
      const clamped = clampOutput(stdoutBuffer, maxLines, maxBytes, truncated);
      const failedCode = code ?? (killed ? 137 : null);
      if (failedCode !== 0 && failedCode !== null) {
        const errorDetails = stderrBuffer.trim() || clamped.text.trim() || `exit code ${failedCode}`;
        // A sandbox refusal handed back as a raw traceback reads as an
        // obstacle to route around, and it was routed around: one live turn
        // answered "Operation not permitted" by base64-encoding an exec, then
        // by probing whether /tmp was writable. Neither was going to work, and
        // both cost a turn. Say what the refusal actually is.
        const prefix = writeRefusal(errorDetails)
          ? `probe_log is a READ tool and its script runs read-only. That is the tool, not a `
            + `missing permission — no path is writable from here, /tmp included, and no `
            + `encoding of the script changes it. If this turn has no write or edit tool it is `
            + `scoped to inspection: report what you found and the next turn writes it.\n\n`
            + `The script's own error (exit ${failedCode}):\n`
          : `probe_log script failed (exit ${failedCode}):\n`;
        let fullError = `${prefix}${errorDetails}`;
        let wasTruncated = clamped.truncated;
        if (Buffer.byteLength(fullError, "utf8") > maxBytes) {
          fullError = sliceUtf8BytesHead(fullError, maxBytes);
          wasTruncated = true;
        }
        finish({ text: fullError, lines: clamped.lines, truncated: wasTruncated, error: true, exitCode: failedCode });
        return;
      }
      finish({ text: clamped.text, lines: clamped.lines, truncated: clamped.truncated, error: false, exitCode: 0 });
    });
  });
}
