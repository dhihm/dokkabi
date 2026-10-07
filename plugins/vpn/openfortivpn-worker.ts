import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type VpnWorkerState =
  | Readonly<{ state: "down" }>
  | Readonly<{ state: "up" }>
  | Readonly<{ expiresAt: number; sessionId: string; state: "awaiting_otp" }>
  | Readonly<{ errorCode: string; state: "failed" }>;

type VpnWorkerRequest = Readonly<{
  code?: unknown;
  operation?: unknown;
  session_id?: unknown;
}>;

export interface VpnTunnelProbe {
  isUp(): boolean;
}

export interface VpnConnector {
  detach(): void;
  sendOtp(code: string): void;
  start(): void;
  terminate(): Promise<void>;
  waitForConnected(timeoutMs: number): Promise<boolean>;
  waitForOtpPrompt(timeoutMs: number): Promise<boolean>;
}

type ActiveAttempt = Readonly<{
  expiresAt: number;
  session: VpnConnector;
  sessionId: string;
}>;

const OTP_PATTERN = /^[0-9]{6}$/u;
const OTP_PROMPTS = [
  "Please enter one-time password:",
  "Two-factor authentication token:",
] as const;
const CONNECTED_MARKERS = ["Tunnel is up and running."] as const;
const FAILURE_MARKERS = [
  "Authentication failed",
  "No OTP specified",
  "No token specified",
  "unsupported challenge",
] as const;

export class DokkabiVpnWorker {
  readonly #connectorFactory: () => VpnConnector;
  readonly #leaseMs: number;
  readonly #now: () => number;
  readonly #otpWaitMs: number;
  readonly #probe: VpnTunnelProbe;
  readonly #sessionId: () => string;
  #attempt: ActiveAttempt | undefined;
  #connected: VpnConnector | undefined;
  #lastFailure: VpnWorkerState | undefined;

  constructor(input: Readonly<{
    connectorFactory: () => VpnConnector;
    leaseMs: number;
    now?: () => number;
    otpWaitMs: number;
    probe: VpnTunnelProbe;
    sessionId?: () => string;
  }>) {
    this.#connectorFactory = input.connectorFactory;
    this.#leaseMs = input.leaseMs;
    this.#now = input.now ?? Date.now;
    this.#otpWaitMs = input.otpWaitMs;
    this.#probe = input.probe;
    this.#sessionId = input.sessionId ?? randomUUID;
  }

  async handle(request: unknown): Promise<VpnWorkerState> {
    if (!isRequest(request)) return failed("invalid_request");
    switch (request.operation) {
      case "status":
        return await this.#status();
      case "start":
        return await this.#start();
      case "submit_otp":
        return await this.#submitOtp(request);
      default:
        return failed("invalid_request");
    }
  }

  async close(): Promise<void> {
    if (this.#probe.isUp()) {
      this.#connected?.detach();
      this.#connected = undefined;
      return;
    }
    await this.#terminateAttempt();
    await this.#connected?.terminate();
    this.#connected = undefined;
  }

  async #status(): Promise<VpnWorkerState> {
    if (this.#probe.isUp()) return { state: "up" };
    if (this.#attempt) {
      if (this.#attempt.expiresAt <= this.#now()) {
        await this.#terminateAttempt();
        return this.#rememberFailure("expired");
      }
      return awaiting(this.#attempt);
    }
    if (this.#connected) {
      await this.#connected.terminate();
      this.#connected = undefined;
    }
    return this.#lastFailure ?? { state: "down" };
  }

  async #start(): Promise<VpnWorkerState> {
    const current = await this.#status();
    if (current.state === "up" || current.state === "awaiting_otp") return current;
    this.#lastFailure = undefined;
    const session = this.#connectorFactory();
    try {
      session.start();
      if (!await session.waitForOtpPrompt(this.#otpWaitMs)) {
        await session.terminate();
        return this.#rememberFailure("otp_prompt_missing");
      }
      this.#attempt = {
        expiresAt: this.#now() + this.#leaseMs,
        session,
        sessionId: this.#sessionId(),
      };
      return awaiting(this.#attempt);
    } catch {
      await session.terminate().catch(() => undefined);
      return this.#rememberFailure("backend_failure");
    }
  }

  async #submitOtp(request: VpnWorkerRequest): Promise<VpnWorkerState> {
    if (typeof request.code !== "string" || !OTP_PATTERN.test(request.code)) {
      return failed("invalid_request");
    }
    const attempt = this.#attempt;
    if (!attempt || typeof request.session_id !== "string" || request.session_id !== attempt.sessionId) {
      return failed("invalid_session");
    }
    if (attempt.expiresAt <= this.#now()) {
      await this.#terminateAttempt();
      return this.#rememberFailure("expired");
    }
    try {
      attempt.session.sendOtp(request.code);
      if (!await attempt.session.waitForConnected(this.#otpWaitMs)) {
        await this.#terminateAttempt();
        return this.#rememberFailure("gateway_rejected");
      }
      this.#connected = attempt.session;
      this.#attempt = undefined;
      this.#lastFailure = undefined;
      return { state: "up" };
    } catch {
      await this.#terminateAttempt();
      return this.#rememberFailure("backend_failure");
    }
  }

  async #terminateAttempt(): Promise<void> {
    const attempt = this.#attempt;
    this.#attempt = undefined;
    await attempt?.session.terminate().catch(() => undefined);
  }

  #rememberFailure(errorCode: string): VpnWorkerState {
    const state = failed(errorCode);
    this.#lastFailure = state;
    return state;
  }
}

export class OpenFortiVpnConnector implements VpnConnector {
  readonly #argv: readonly string[];
  #buffer = "";
  #change = Promise.withResolvers<void>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #exit: Promise<void> | undefined;

  constructor(binary: string, configPath: string) {
    this.#argv = [binary, "-c", configPath];
  }

  start(): void {
    if (this.#child) throw new Error("connector already started");
    const child = spawn(this.#argv[0]!, this.#argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    this.#exit = new Promise((resolve) => child.once("close", () => {
      this.#notify();
      resolve();
    }));
    child.stdout.on("data", (chunk: Buffer) => this.#append(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#append(chunk));
    child.once("error", () => this.#notify());
  }

  waitForOtpPrompt(timeoutMs: number): Promise<boolean> {
    return this.#waitFor(OTP_PROMPTS, timeoutMs);
  }

  waitForConnected(timeoutMs: number): Promise<boolean> {
    return this.#waitFor(CONNECTED_MARKERS, timeoutMs);
  }

  sendOtp(code: string): void {
    if (!OTP_PATTERN.test(code)) throw new Error("invalid OTP");
    const stdin = this.#child?.stdin;
    if (!stdin) throw new Error("connector is unavailable");
    stdin.write(`${code}\n`);
  }

  async terminate(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const exited = this.#exit ?? Promise.resolve();
    const graceful = await resolvesBefore(exited, 2_000);
    if (!graceful && child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }

  detach(): void {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }

  async #waitFor(markers: readonly string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (markers.some((marker) => this.#buffer.includes(marker))) return true;
      if (FAILURE_MARKERS.some((marker) => this.#buffer.includes(marker))) return false;
      if (this.#child?.exitCode !== null && this.#child?.exitCode !== undefined) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const changed = this.#change.promise;
      await resolvesBefore(changed, remaining);
    }
  }

  #append(chunk: Buffer): void {
    this.#buffer = `${this.#buffer}${chunk.toString("utf8")}`.slice(-64 * 1_024);
    this.#notify();
  }

  #notify(): void {
    const current = this.#change;
    this.#change = Promise.withResolvers<void>();
    current.resolve();
  }
}

class RouteProbe implements VpnTunnelProbe {
  readonly #command: string;
  readonly #host: string;

  constructor(command: string, host: string) {
    this.#command = command;
    this.#host = host;
  }

  isUp(): boolean {
    const result = spawnSync(this.#command, ["route", "get", this.#host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0 || output.toLowerCase().includes("unreachable")) return false;
    const tokens = output.split(/\s+/u);
    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (tokens[index] === "dev" && /^(?:ppp|tun)/u.test(tokens[index + 1] ?? "")) return true;
    }
    return false;
  }
}

type WorkerOptions = Readonly<{
  configPath: string;
  leaseMs: number;
  openfortivpn: string;
  otpWaitMs: number;
  probeHost: string;
  routeCommand: string;
}>;

function parseOptions(argv: readonly string[]): WorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("invalid worker options");
    values.set(key, value);
  }
  const configPath = required(values, "--config");
  const probePath = required(values, "--probe-file");
  assertSecureFile(configPath);
  assertSecureFile(probePath);
  const probeHost = readFileText(probePath, 4_096).trim();
  if (!/^[A-Za-z0-9._:-]+$/u.test(probeHost)) throw new Error("invalid probe credential");
  const leaseSeconds = positiveInteger(values.get("--lease-seconds") ?? "180");
  const otpWaitSeconds = positiveInteger(values.get("--otp-wait-seconds") ?? "60");
  return {
    configPath,
    leaseMs: leaseSeconds * 1_000,
    openfortivpn: values.get("--openfortivpn") ?? "/usr/bin/openfortivpn",
    otpWaitMs: otpWaitSeconds * 1_000,
    probeHost,
    routeCommand: values.get("--route-command") ?? "/usr/sbin/ip",
  };
}

function assertSecureFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("credential is unavailable");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("credential permissions are unsafe");
  }
}

function readFileText(path: string, maxBytes: number): string {
  const metadata = lstatSync(path);
  if (metadata.size > maxBytes) throw new Error("credential is too large");
  return readFileSync(path, "utf8");
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error("missing worker option");
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("invalid timeout");
  return parsed;
}

function resolvesBefore(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function isRequest(value: unknown): value is VpnWorkerRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(errorCode: string): VpnWorkerState {
  return { errorCode, state: "failed" };
}

function awaiting(attempt: ActiveAttempt): VpnWorkerState {
  return {
    expiresAt: attempt.expiresAt,
    sessionId: attempt.sessionId,
    state: "awaiting_otp",
  };
}

async function run(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv);
  const probe = new RouteProbe(options.routeCommand, options.probeHost);
  const worker = new DokkabiVpnWorker({
    connectorFactory: () => new OpenFortiVpnConnector(options.openfortivpn, options.configPath),
    leaseMs: options.leaseMs,
    otpWaitMs: options.otpWaitMs,
    probe,
  });
  try {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        request = undefined;
      }
      process.stdout.write(`${JSON.stringify(await worker.handle(request))}\n`);
    }
  } finally {
    await worker.close();
  }
}

if (import.meta.main) {
  await run(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}
