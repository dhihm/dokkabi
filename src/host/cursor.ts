import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "./event-log.ts";
import { dokkabiHome } from "./paths.ts";
import type { PermissionController } from "./permissions.ts";
import { containsPrivateInfrastructureValue, containsSecretValue, redactText } from "./redact.ts";
import { requireAndSealSandboxExecutable, assertSandboxExecutableIdentity, type SandboxHostExecutableSeal } from "./sandbox-executable.ts";
import { approvalRelayEnabled, waitForOperatorDecision } from "./approval-relay.ts";
import { proxyEnvironment } from "./sandbox-proxy.ts";

/**
 * A second opinion from Cursor's own agent, read-only.
 *
 * The vendor ships a CLI and an API key, so this needs none of the things the
 * security constitution forbids: no session scraping, no token conversion, no
 * unofficial proxy. What it does need is a fence of its own, because the
 * CLI's own help says print mode "has access to all tools, including write
 * and shell". A second agent editing the workspace would put changes outside
 * the ledger that judges this run, so every call here is `--mode ask` or
 * `--mode plan` — the vendor's read-only modes — and `--force`, `--yolo`, and
 * `--approve-mcps` are never passed.
 *
 * The other half is egress: the prompt and whatever the agent reads of the
 * workspace leave this machine. That is the same class of exposure as any
 * model route, so it is approval-gated like ssh, recorded before it runs, and
 * carries only a digest of the prompt into the log.
 */

export type CursorMode = "ask" | "plan";

export const CURSOR_ENV_FILE = "cursor.env";
export const CURSOR_DEFAULT_MODEL = "auto";
export const CURSOR_DEFAULT_TIMEOUT_SECONDS = 600;
export const CURSOR_MAX_TIMEOUT_SECONDS = 3_600;
export const CURSOR_PROMPT_MAX_BYTES = 16 * 1024;
export const CURSOR_OUTPUT_MAX_BYTES = 256 * 1024;

export interface CursorRequest {
  readonly mode?: CursorMode;
  readonly prompt: string;
  readonly model?: string;
  readonly timeout?: number;
}

export interface CursorResult {
  readonly error: boolean;
  readonly text: string;
}

export interface CursorService {
  ask(request: CursorRequest, signal?: AbortSignal): Promise<CursorResult>;
  status(): CursorResult;
  dispose(): void;
}

/**
 * The operator's key, kept in a mode-0600 file beside the config rather than
 * in it: the config is a public document the model may be shown, and its
 * writer refuses secret-shaped values on purpose.
 */
export function readCursorCredential(home = dokkabiHome()): { key?: string; model?: string } {
  const path = join(home, CURSOR_ENV_FILE);
  if (!existsSync(path)) return {};
  const out: { key?: string; model?: string } = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (name === "CURSOR_API_KEY" && value) out.key = value;
    if (name === "CURSOR_MODEL" && value) out.model = value;
  }
  return out;
}

/**
 * The argv one call runs as. Read-only by construction.
 *
 * `auto` is the vendor's own default and is not a value its `--model` flag
 * accepts: passing it explicitly fails the call with "Cannot use this model:
 * auto" after the request has already gone out. So the default is expressed
 * by omitting the flag, which is what it means.
 */
export function cursorArgv(input: {
  readonly executable: string;
  readonly prompt: string;
  readonly mode: CursorMode;
  readonly model: string;
}): string[] {
  return [
    input.executable,
    "-p",
    input.prompt,
    "--mode",
    input.mode,
    ...(input.model === CURSOR_DEFAULT_MODEL ? [] : ["--model", input.model]),
    "--output-format",
    "text",
    // Without this the CLI stops on an interactive workspace-trust question
    // and a headless call hangs until its deadline.
    "--trust",
  ];
}

export function assertCursorRequest(request: CursorRequest): { mode: CursorMode; model: string; timeout: number } {
  const prompt = request.prompt?.trim();
  if (!prompt) throw new Error("cursor needs a prompt");
  if (Buffer.byteLength(prompt) > CURSOR_PROMPT_MAX_BYTES) {
    throw new Error(`cursor prompt is larger than ${CURSOR_PROMPT_MAX_BYTES} bytes`);
  }
  if (containsSecretValue({ prompt })) throw new Error("cursor prompt matched the secret guard");
  if (containsPrivateInfrastructureValue({ prompt })) {
    throw new Error("cursor prompt carries a private infrastructure coordinate");
  }
  const mode = request.mode ?? "ask";
  if (mode !== "ask" && mode !== "plan") throw new Error("cursor mode must be ask or plan");
  const model = (request.model ?? "").trim() || CURSOR_DEFAULT_MODEL;
  if (!/^[A-Za-z0-9._\-[\]=,]{1,120}$/u.test(model)) throw new Error(`cursor model name is not a plain id: ${model}`);
  const timeout = request.timeout ?? CURSOR_DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > CURSOR_MAX_TIMEOUT_SECONDS) {
    throw new Error(`cursor timeout must be between 1 and ${CURSOR_MAX_TIMEOUT_SECONDS} seconds`);
  }
  return { mode, model, timeout };
}

export type CursorRunner = (input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}) => Promise<{ exitCode: number | undefined; stdout: string; stderr: string; timedOut: boolean }>;

export function createCursorService(input: {
  readonly log: EventLog;
  readonly workspaceRoot: string;
  readonly permissions?: PermissionController;
  readonly home?: string;
  readonly runner?: CursorRunner;
  readonly seal?: SandboxHostExecutableSeal;
  readonly assertExecutable?: (seal: SandboxHostExecutableSeal) => void;
  readonly hostEnv?: NodeJS.Dict<string>;
}): CursorService {
  let requestSequence = 0;
  let disposed = false;
  const credential = readCursorCredential(input.home ?? dokkabiHome());
  const assertExecutable = input.assertExecutable ?? assertSandboxExecutableIdentity;
  const seal = input.seal ?? sealCursorAgent(input.workspaceRoot);
  const runner = input.runner ?? runCursorAgent;

  const status = (): CursorResult => ({
    error: false,
    text: [
      `cursor executable=${seal ? "sealed" : "missing"}`,
      `credential=${credential.key ? "present" : "absent"}`,
      `default_model=${credential.model ?? CURSOR_DEFAULT_MODEL}`,
      `modes=ask,plan (read-only; write and shell are never granted)`,
    ].join(" "),
  });

  const approve = async (digest: string, mode: CursorMode, signal?: AbortSignal): Promise<"allow" | "deny"> => {
    if (input.permissions?.current() === "bypass") return "allow";
    requestSequence += 1;
    const requestId = `cursor-${requestSequence}`;
    input.log.append({
      kind: "observe",
      name: "cursor/approval_requested",
      payload: { request_id: requestId, mode, prompt_digest: digest },
    });
    const resolved = (status_: string, reason: string): void => {
      input.log.append({
        kind: "observe",
        name: "cursor/approval_resolved",
        payload: { request_id: requestId, status: status_, reason },
      });
    };
    // There is no board dialog for this capability yet, so the two ways to
    // authorise it are the standing bypass mode and the approval relay a
    // non-interactive run already drains. Saying that is better than a
    // popup that never appears.
    if (!approvalRelayEnabled()) {
      resolved("unavailable", "not_interactive");
      return "deny";
    }
    const outcome = await waitForOperatorDecision({
      logPath: input.log.path,
      kind: "cursor",
      requestId,
      summary: `cursor ${mode} prompt ${digest.slice(0, 12)}`,
      ...(signal ? { signal } : {}),
    });
    if (outcome === "once" || outcome === "session") {
      resolved("approved", "operator");
      return "allow";
    }
    resolved(outcome === "deny" ? "deny" : "unavailable", outcome === "deny" ? "operator" : "operator_timeout");
    return "deny";
  };

  return {
    status,
    dispose() {
      disposed = true;
    },
    async ask(request, signal) {
      if (disposed) return { error: true, text: "cursor state=unavailable reason=disposed" };
      if (!seal) return { error: true, text: "cursor state=unavailable reason=executable_missing" };
      if (!credential.key) {
        return {
          error: true,
          text: `cursor state=unavailable reason=credential_absent; put CURSOR_API_KEY in ${join(input.home ?? dokkabiHome(), CURSOR_ENV_FILE)} (mode 0600)`,
        };
      }
      let checked: { mode: CursorMode; model: string; timeout: number };
      try {
        checked = assertCursorRequest(request);
      } catch (error) {
        return { error: true, text: `cursor state=refused reason=${error instanceof Error ? error.message : "invalid"}` };
      }
      const prompt = request.prompt.trim();
      const digest = createHash("sha256").update(prompt).digest("hex");
      if (await approve(digest, checked.mode, signal) === "deny") {
        return {
          error: true,
          text: "cursor state=approval_required; approve with dokkabi approve, or restart with --permission-mode bypass",
        };
      }
      // The identity is rechecked immediately before the spawn, as every
      // other sealed executable is: an approval is not a licence for whatever
      // is at that path a minute later.
      assertExecutable(seal);
      const argv = cursorArgv({ executable: seal.path, prompt, mode: checked.mode, model: checked.model });
      const egress = egressEnvironment(input.hostEnv ?? process.env);
      input.log.append({
        kind: "effect",
        name: "cursor/exec",
        payload: {
          mode: checked.mode,
          model: checked.model,
          prompt_digest: digest,
          prompt_bytes: Buffer.byteLength(prompt),
          timeout_seconds: checked.timeout,
          approval_scope: input.permissions?.current() === "bypass" ? "bypass" : "operator",
          // Names only. A CA bundle path and a proxy address are both
          // operator coordinates, and neither belongs in the log.
          egress_env: egress.names,
        },
      });
      const started = performance.now();
      const result = await runner({
        argv,
        cwd: input.workspaceRoot,
        // Only the key. The agent gets no other operator secret, and PATH is
        // the system one so it cannot pick up a workspace-controlled binary.
        // The egress names are what a machine behind an inspecting proxy needs
        // to make an HTTPS request at all; without them the vendor CLI dies on
        // `read ECONNRESET` eight seconds in and reports nothing useful.
        env: {
          CURSOR_API_KEY: credential.key,
          HOME: (input.hostEnv ?? process.env).HOME ?? "",
          PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          ...((input.hostEnv ?? process.env).TERM ? { TERM: (input.hostEnv ?? process.env).TERM as string } : {}),
          ...egress.env,
        },
        timeoutMs: checked.timeout * 1_000,
        ...(signal ? { signal } : {}),
      });
      const durationMs = Math.round(performance.now() - started);
      input.log.append({
        kind: "observe",
        name: "cursor/result",
        payload: {
          mode: checked.mode,
          model: checked.model,
          prompt_digest: digest,
          exit_code: result.exitCode ?? "missing",
          timed_out: result.timedOut,
          stdout_bytes: Buffer.byteLength(result.stdout),
          duration_ms: durationMs,
        },
      });
      if (result.timedOut) {
        return { error: true, text: `cursor state=timed_out after ${checked.timeout}s; raise timeout or narrow the prompt` };
      }
      if ((result.exitCode ?? 1) !== 0) {
        return {
          error: true,
          text: `cursor state=failed exit_code=${result.exitCode ?? "missing"}\n${bounded(redactText(result.stderr || result.stdout))}`,
        };
      }
      return { error: false, text: bounded(redactText(result.stdout)) || "cursor returned no text" };
    },
  };
}

/**
 * What a network-inspecting machine needs to make an HTTPS request.
 *
 * The vendor CLI is a Node program talking to the vendor's API. On a host
 * whose egress is proxied and TLS-inspected, a minimal environment costs it
 * the CA bundle and the route, and it dies on `read ECONNRESET` a few seconds
 * in — a failure that looks like the vendor being down and is not. These are
 * the same trust names a swarm child already inherits, plus the proxy address
 * with its credential guard: a proxy URL carrying userinfo is dropped, not
 * forwarded. Values never reach the log; `cursor/exec` records the names.
 */
const EGRESS_TRUST_KEYS: readonly string[] = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
];

export function egressEnvironment(hostEnv: NodeJS.Dict<string>): {
  env: Record<string, string>;
  names: string[];
} {
  const env: Record<string, string> = {};
  for (const key of EGRESS_TRUST_KEYS) {
    const value = hostEnv[key]?.trim();
    if (value) env[key] = value;
  }
  Object.assign(env, proxyEnvironment(hostEnv).env);
  return { env, names: Object.keys(env).sort() };
}

function bounded(text: string): string {
  if (Buffer.byteLength(text) <= CURSOR_OUTPUT_MAX_BYTES) return text.trim();
  return `${text.slice(0, CURSOR_OUTPUT_MAX_BYTES)}\n[cursor output truncated]`;
}

function sealCursorAgent(workspaceRoot: string): SandboxHostExecutableSeal | undefined {
  try {
    return requireAndSealSandboxExecutable("cursor-agent", [workspaceRoot]);
  } catch {
    return undefined;
  }
}

const runCursorAgent: CursorRunner = (input) => new Promise((resolve) => {
  const child = spawn(input.argv[0]!, input.argv.slice(1), {
    cwd: input.cwd,
    env: { ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, input.timeoutMs);
  const onAbort = () => child.kill("SIGKILL");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stdout) < CURSOR_OUTPUT_MAX_BYTES) stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) < CURSOR_OUTPUT_MAX_BYTES) stderr += chunk.toString();
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    resolve({ exitCode: code ?? undefined, stdout, stderr, timedOut });
  });
  child.once("error", () => {
    clearTimeout(timer);
    resolve({ exitCode: undefined, stdout, stderr: "cursor-agent could not be started", timedOut });
  });
});
