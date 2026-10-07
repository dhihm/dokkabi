import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { z } from "zod";
import type {
  HostContext,
  PluginModule,
  ToolContributionRegistry,
} from "../../src/loader/types.ts";
import type {
  PrerequisiteRegistry,
  PrerequisiteStatus,
} from "../../src/prerequisite/registry.ts";
import type {
  RemoteDelivery,
  RemoteExtension,
  RemoteExtensionContext,
  RemoteHost,
  RemoteIngress,
  RemoteExtensionResult,
} from "../../src/remote/types.ts";
import {
  resolveRemoteLocale,
  type RemoteLocale,
} from "../../src/remote/locale.ts";
import {
  readRemoteCredentialConfig,
  resolveCredentialArguments,
} from "../../src/remote/credential-config.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

const WorkerCommandSchema = z.array(z.string().trim().min(1)).min(1).readonly();

const VpnStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("down") }),
  z.strictObject({ state: z.literal("up") }),
  z.strictObject({
    expiresAt: z.number().int().positive(),
    sessionId: z.string().trim().min(1),
    state: z.literal("awaiting_otp"),
  }),
  z.strictObject({
    errorCode: z.string().trim().min(1),
    state: z.literal("failed"),
  }),
]);

export type VpnState = z.infer<typeof VpnStateSchema>;

export interface VpnBackend {
  read(): Promise<VpnState>;
  start(): Promise<VpnState>;
  submitOtp(input: Readonly<{ code: string; sessionId: string }>): Promise<VpnState>;
  reset?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface VpnWaiter {
  wait(signal: AbortSignal): Promise<void>;
}

export type VpnRemoteConfiguration =
  | { readonly active: false; readonly reason: string; readonly kind: "not_configured" | "invalid_configuration" }
  | {
      readonly active: true;
      readonly command: readonly string[];
      readonly channelId: string;
      readonly intervalMs: number;
      readonly locale: RemoteLocale;
      readonly stabilityIntervalMs: number;
      readonly stabilityPolls: number;
    };

export function readVpnRemoteConfig(
  env: NodeJS.Dict<string> = process.env,
): VpnRemoteConfiguration {
  const deployment = readRemoteCredentialConfig(env);
  if (!deployment.active || !deployment.config.vpn) {
    return { active: false, reason: "VPN remote requires a worker command and remote channel.", kind: !deployment.active ? deployment.kind : "not_configured" };
  }
  const vpn = deployment.config.vpn;
  const command = resolveCredentialArguments(vpn.worker_command, env);
  if (!command) {
    return { active: false, reason: "VPN remote worker configuration is invalid.", kind: "invalid_configuration" };
  }
  return {
    active: true,
    channelId: vpn.channel_id ?? deployment.config.discord.channel_id,
    command,
    intervalMs: vpn.monitor_interval_ms ?? 5_000,
    locale: resolveRemoteLocale(vpn.locale ?? deployment.config.remote?.locale),
    stabilityIntervalMs: vpn.stability_interval_ms ?? 2_000,
    stabilityPolls: vpn.stability_polls ?? 3,
  };
}

type PendingResponse = Readonly<{
  resolve(state: VpnState): void;
  reject(error: Error): void;
}>;

class VpnWorkerError extends Error {
  readonly name = "VpnWorkerError";
  constructor(message = "VPN worker operation failed") {
    super(message);
  }
}

class JsonVpnBackend implements VpnBackend {
  readonly #command: readonly string[];
  readonly #pending: PendingResponse[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #disposed = false;

  constructor(command: readonly string[]) {
    this.#command = WorkerCommandSchema.parse(command);
  }

  read(): Promise<VpnState> {
    return this.#request({ operation: "status" });
  }

  start(): Promise<VpnState> {
    return this.#request({ operation: "start" });
  }

  submitOtp(input: Readonly<{ code: string; sessionId: string }>): Promise<VpnState> {
    return this.#request({
      code: input.code,
      operation: "submit_otp",
      session_id: input.sessionId,
    });
  }

  async reset(): Promise<void> {
    if (this.#disposed) throw new VpnWorkerError("VPN worker is unavailable");
    await this.#stop();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#stop();
  }

  async #stop(): Promise<void> {
    const child = this.#child;
    this.#fail(new VpnWorkerError("VPN worker stopped"));
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2_000);
    await exited;
    clearTimeout(timer);
  }

  #spawn(): ChildProcessWithoutNullStreams {
    if (this.#disposed) throw new VpnWorkerError("VPN worker is unavailable");
    const [executable, ...args] = this.#command;
    if (!executable) throw new VpnWorkerError();
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#receive(line));
    child.once("error", () => this.#fail(new VpnWorkerError()));
    child.once("close", () => {
      if (this.#child === child) this.#child = undefined;
      this.#fail(new VpnWorkerError());
    });
    return child;
  }

  #request(payload: Readonly<Record<string, string>>): Promise<VpnState> {
    if (this.#disposed) return Promise.reject(new VpnWorkerError("VPN worker is unavailable"));
    const child = this.#child ?? this.#spawn();
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) this.#fail(new VpnWorkerError());
      });
    });
  }

  #receive(line: string): void {
    const pending = this.#pending.shift();
    if (!pending) {
      this.#child?.kill();
      return;
    }
    try {
      pending.resolve(VpnStateSchema.parse(JSON.parse(line)));
    } catch {
      pending.reject(new VpnWorkerError("VPN worker returned invalid state"));
      this.#child?.kill();
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.splice(0)) pending.reject(error);
  }
}

export function createVpnWorkerBackend(command: readonly string[]): VpnBackend {
  return new JsonVpnBackend(command);
}

const OtpSchema = z.string().regex(/^[0-9]{6}$/u);

type VpnMessages = Readonly<{
  awaitingOtp: string;
  disconnected: string;
  failed: string;
  notAwaitingOtp: string;
  operationFailed: string;
  outage: string;
  unstable: string;
  up: string;
}>;

const vpnCatalogs: Readonly<Record<RemoteLocale, VpnMessages>> = {
  en: {
    awaitingOtp: "VPN reconnection is ready. Send the six-digit OTP.",
    disconnected: "The VPN is disconnected.",
    failed: "The VPN connection failed. You can try again.",
    notAwaitingOtp: "The VPN is not waiting for an OTP. Send 'approve' first.",
    operationFailed: "The VPN operation failed. Please try again shortly.",
    outage: "VPN connection is down. Send 'approve' to reconnect.",
    unstable: "The VPN connection did not remain stable. Send 'approve' to try again.",
    up: "VPN connection is complete.",
  },
  ko: {
    awaitingOtp: "VPN 재접속을 준비했습니다. 6자리 OTP를 보내주세요.",
    disconnected: "VPN 연결이 끊겨 있습니다.",
    failed: "VPN 연결에 실패했습니다. 다시 시도할 수 있습니다.",
    notAwaitingOtp: "현재 VPN은 OTP 입력을 대기 중이 아닙니다.",
    operationFailed: "VPN 작업에 실패했습니다. 잠시 후 다시 시도해주세요.",
    outage: "VPN 연결이 끊겼습니다. 재접속하려면 '승인'이라고 보내주세요.",
    unstable: "VPN 접속을 시도했지만 연결이 유지되지 않았습니다. 다시 승인해주세요.",
    up: "VPN 연결이 완료되었습니다.",
  },
};

function vpnIntent(text: string): "approval" | "status" | undefined {
  const compact = text.trim().replace(/\s+/gu, "").toLowerCase();
  const vpnPrefixed = /^(?:\/|!)?vpn/u.test(compact);
  if (
    compact === "vpn"
    || compact === "/vpn"
    || compact === "!vpn"
    || (vpnPrefixed && /(?:상태|확인|status)/u.test(compact))
  ) {
    return "status";
  }
  if (
    /^(?:승인|재연결|재접속|연결|approve|confirm|connect|reconnect)(?:할게|해|해줘|해주세요)?$/iu.test(compact)
    || (vpnPrefixed && /(?:승인|재연결|재접속|연결|approve|connect|reconnect)/u.test(compact))
  ) {
    return "approval";
  }
  return undefined;
}

const defaultWaiter = (intervalMs: number): VpnWaiter => ({
  wait(signal) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, intervalMs);
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
  },
});

function publicState(state: VpnState): Readonly<Record<string, unknown>> {
  switch (state.state) {
    case "awaiting_otp":
      return { expires_at: state.expiresAt, state: state.state };
    case "failed":
      return { state: state.state };
    case "down":
    case "up":
      return { state: state.state };
  }
}

function stateMessage(state: VpnState, messages: VpnMessages): string {
  switch (state.state) {
    case "up":
      return messages.up;
    case "awaiting_otp":
      return messages.awaitingOtp;
    case "down":
      return messages.disconnected;
    case "failed":
      return state.errorCode === "connection_unstable"
        ? messages.unstable
        : messages.failed;
  }
}

function lastOutageState(log: RemoteExtensionContext["log"]): {
  active: boolean;
  interrupted: boolean;
  sequence: number;
} {
  let active = false;
  let interrupted = false;
  let sequence = 0;
  for (const event of log.events) {
    if (event.name === "vpn/outage_detected") {
      active = true;
      const next = Number(event.payload.outage_sequence);
      if (Number.isInteger(next)) sequence = Math.max(sequence, next);
    } else if (event.name === "vpn/outage_cleared") {
      active = false;
      interrupted = false;
    } else if (event.name === "vpn/reconnect_start" || event.name === "vpn/otp_submit") {
      interrupted = true;
    } else if (
      event.name === "vpn/operation_failed"
      || event.name === "vpn/stability_failed"
      || event.name === "vpn/stability_confirmed"
      || (event.name === "vpn/state" && typeof event.payload.request_id === "string")
    ) {
      interrupted = false;
    }
  }
  return { active, interrupted, sequence };
}

export function createVpnRemoteExtension(input: {
  readonly backend: VpnBackend;
  readonly channelId: string;
  readonly intervalMs?: number;
  readonly locale?: RemoteLocale;
  readonly stabilityIntervalMs?: number;
  readonly stabilityPolls?: number;
  readonly stabilitySleep?: (intervalMs: number) => Promise<void>;
  readonly waiter?: VpnWaiter;
  readonly now?: () => number;
  readonly onFailure?: () => void;
  readonly onState?: (state: VpnState) => void;
}): RemoteExtension {
  const messages = vpnCatalogs[input.locale ?? "en"];
  const waiter = input.waiter ?? defaultWaiter(input.intervalMs ?? 5_000);
  const now = input.now ?? Date.now;
  const stabilityIntervalMs = input.stabilityIntervalMs ?? 2_000;
  const stabilityPolls = input.stabilityPolls ?? 3;
  const stabilitySleep = input.stabilitySleep ?? Bun.sleep;
  let context: RemoteExtensionContext | undefined;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let outageActive = false;
  let outageSequence = 0;
  let lastState: VpnState["state"] | undefined;

  const recordState = (state: VpnState, requestId?: string): void => {
    input.onState?.(state);
    if (state.state === lastState && !requestId) return;
    lastState = state.state;
    context?.log.append({
      kind: "observe",
      name: "vpn/state",
      payload: { ...publicState(state), ...(requestId ? { request_id: requestId } : {}) },
    });
  };

  const readRaw = async (requestId?: string): Promise<VpnState> => {
    context?.log.append({
      kind: "effect",
      name: "vpn/status_read",
      payload: requestId ? { request_id: requestId } : {},
    });
    return input.backend.read();
  };

  const read = async (requestId?: string): Promise<VpnState> => {
    const state = await readRaw(requestId);
    recordState(state, requestId);
    return state;
  };

  const stabilize = async (initial: VpnState, requestId: string): Promise<VpnState> => {
    if (initial.state !== "up") {
      recordState(initial, requestId);
      return initial;
    }
    context?.log.append({
      kind: "effect",
      name: "vpn/stability_check",
      payload: { request_id: requestId, required_polls: stabilityPolls },
    });
    for (let observed = 1; observed < stabilityPolls; observed += 1) {
      await stabilitySleep(stabilityIntervalMs);
      const state = await readRaw(requestId);
      if (state.state !== "up") {
        const failed: VpnState = { state: "failed", errorCode: "connection_unstable" };
        recordState(failed, requestId);
        context?.log.append({
          kind: "observe",
          name: "vpn/stability_failed",
          payload: { observed_polls: observed, request_id: requestId },
        });
        if (input.backend.reset) {
          context?.log.append({ kind: "effect", name: "vpn/recovery_reset", payload: {} });
          try {
            await input.backend.reset();
          } catch {
            input.onFailure?.();
          }
        }
        return failed;
      }
    }
    recordState(initial, requestId);
    context?.log.append({
      kind: "observe",
      name: "vpn/stability_confirmed",
      payload: { observed_polls: stabilityPolls, request_id: requestId },
    });
    return initial;
  };

  const startReconnect = async (requestId: string): Promise<VpnState> => {
    context?.log.append({ kind: "effect", name: "vpn/reconnect_start", payload: { request_id: requestId } });
    const state = await input.backend.start();
    return stabilize(state, requestId);
  };

  const submitOtp = async (requestId: string, code: string, sessionId: string): Promise<VpnState> => {
    context?.log.append({ kind: "effect", name: "vpn/otp_submit", payload: { request_id: requestId } });
    const state = await input.backend.submitOtp({ code, sessionId });
    return stabilize(state, requestId);
  };

  const queue = (delivery: RemoteDelivery): void => context?.enqueue(delivery);

  const clearOutage = (requestId?: string): void => {
    if (!outageActive) return;
    outageActive = false;
    context?.log.append({
      kind: "observe",
      name: "vpn/outage_cleared",
      payload: {
        outage_sequence: outageSequence,
        ...(requestId ? { request_id: requestId } : {}),
      },
    });
  };

  const observe = async (): Promise<void> => {
    try {
      const state = await read();
      if (state.state === "up") {
        clearOutage();
        return;
      }
      if (state.state === "awaiting_otp") {
        outageActive = true;
        return;
      }
      if (outageActive) return;
      outageActive = true;
      outageSequence += 1;
      context?.log.append({
        kind: "observe",
        name: "vpn/outage_detected",
        payload: { outage_sequence: outageSequence },
      });
      queue({
        channelId: input.channelId,
        deliveryId: `vpn:outage:${outageSequence}:notice`,
        kind: "notice",
        requestId: `vpn:outage:${outageSequence}`,
        text: messages.outage,
      });
    } catch {
      input.onFailure?.();
      context?.log.append({
        kind: "observe",
        name: "vpn/monitor_failed",
        payload: { reason: "VPN worker operation failed" },
      });
    }
  };

  const reply = (
    message: RemoteIngress,
    requestId: string,
    text: string,
  ): void => {
    queue({
      channelId: message.channelId,
      deliveryId: `${requestId}:reply`,
      kind: "notice",
      requestId,
      text,
    });
  };

  return {
    id: "vpn",
    async start(nextContext) {
      if (loop) return;
      context = nextContext;
      const recovered = lastOutageState(context.log);
      outageActive = recovered.active && !recovered.interrupted;
      outageSequence = recovered.sequence;
      if (recovered.interrupted) {
        context.log.append({ kind: "observe", name: "vpn/recovery_interrupted", payload: {} });
      }
      controller = new AbortController();
      const signal = controller.signal;
      await observe();
      loop = (async () => {
        while (!signal.aborted) {
          await waiter.wait(signal);
          if (!signal.aborted) await observe();
        }
      })();
    },
    async stop() {
      controller?.abort();
      await loop;
      await input.backend.dispose();
      controller = undefined;
      loop = undefined;
      context = undefined;
    },
    async accept(message, nextContext): Promise<RemoteExtensionResult> {
      context = nextContext;
      if (message.command.kind !== "work") return { handled: false };
      const text = message.command.text.trim();
      const otp = OtpSchema.safeParse(text);
      const intent = vpnIntent(text);
      const approval = intent === "approval";
      const status = intent === "status";
      if (!otp.success && !approval && !status) return { handled: false };

      const accepted = nextContext.accept(otp.success ? "otp" : status ? "status" : "approval");
      if (accepted.duplicate) return { handled: true, ...accepted };
      try {
        let state = await read(accepted.requestId);
        if (status) {
          reply(message, accepted.requestId, stateMessage(state, messages));
          nextContext.finish("completed");
          return { handled: true, ...accepted };
        }
        if (approval) {
          if ((state.state === "down" || state.state === "failed") && outageActive) {
            state = await startReconnect(accepted.requestId);
          }
          reply(message, accepted.requestId, stateMessage(state, messages));
          if (state.state === "up") clearOutage(accepted.requestId);
          nextContext.finish(state.state === "failed" ? "failed" : "completed");
          return { handled: true, ...accepted };
        }
        if (!otp.success) throw new VpnWorkerError();
        if (
          state.state !== "awaiting_otp"
          || state.expiresAt <= now()
        ) {
          reply(message, accepted.requestId, messages.notAwaitingOtp);
          nextContext.finish("failed");
          return { handled: true, ...accepted };
        }
        state = await submitOtp(accepted.requestId, otp.data, state.sessionId);
        reply(message, accepted.requestId, stateMessage(state, messages));
        if (state.state === "up") clearOutage(accepted.requestId);
        nextContext.finish(state.state === "up" ? "completed" : "failed");
        return { handled: true, ...accepted };
      } catch {
        input.onFailure?.();
        nextContext.log.append({
          kind: "observe",
          name: "vpn/operation_failed",
          payload: { request_id: accepted.requestId, reason: "VPN worker operation failed" },
        });
        reply(message, accepted.requestId, messages.operationFailed);
        nextContext.finish("failed");
        return { handled: true, ...accepted };
      }
    },
  };
}

const VpnToolParameters = Type.Object({
  op: Type.Literal("status"),
}, { additionalProperties: false });

export function createVpnStatusTool(
  ctx: HostContext,
  backendFactory: () => VpnBackend,
  onState?: (state: VpnState) => void,
  onFailure?: () => void,
): AgentTool<typeof VpnToolParameters> {
  return {
    name: "vpn",
    label: "vpn",
    description: "Read the host VPN tunnel state. Reconnection and OTP submission remain operator-controlled.",
    parameters: VpnToolParameters,
    async execute() {
      const backend = backendFactory();
      ctx.log.append({ kind: "effect", name: "vpn/tool_status_read", payload: {} });
      try {
        const state = await backend.read();
        onState?.(state);
        ctx.log.append({ kind: "observe", name: "vpn/tool_state", payload: publicState(state) });
        return textToolResult(JSON.stringify(publicState(state)));
      } catch {
        onFailure?.();
        ctx.log.append({
          kind: "observe",
          name: "vpn/tool_failed",
          payload: { reason: "VPN worker operation failed" },
        });
        return textToolResult("VPN status is unavailable", true);
      } finally {
        await backend.dispose().catch(() => undefined);
      }
    },
  };
}

export const plugin: PluginModule = {
  id: "vpn",
  claims: [
    { key: "remote", role: "consumer" },
    { key: "prerequisites", role: "consumer" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "skills", role: "consumer", modelFacing: true },
  ],
  activate() {
    const configured = readVpnRemoteConfig();
    return configured.active ? { active: true } : { active: false, reason: configured.reason, kind: configured.kind };
  },
  // Activation already declines an unconfigured VPN; the same reading is the
  // boot's refusal should it change between the two (#230 round 4, D1'').
  preflight() {
    const configured = readVpnRemoteConfig();
    if (!configured.active) throw new Error(configured.reason);
  },
  async register(ctx) {
    const configured = readVpnRemoteConfig();
    if (!configured.active) throw new Error(configured.reason);
    const backend = createVpnWorkerBackend(configured.command);
    const prerequisites = ctx.get<PrerequisiteRegistry>("prerequisites");
    ctx.effect(() => prerequisites.register("private_network", "vpn"));
    prerequisites.update("private_network", "unavailable", "state_pending");
    const updatePrerequisite = (state: VpnState): void => {
      const projection: Readonly<{ status: PrerequisiteStatus; reason: string }> = state.state === "up"
        ? { status: "ready", reason: "available" }
        : state.state === "failed"
          ? { status: "unavailable", reason: "provider_failed" }
          : state.state === "awaiting_otp"
            ? { status: "waiting_operator", reason: "otp_required" }
            : { status: "waiting_operator", reason: "operator_input_required" };
      prerequisites.update("private_network", projection.status, projection.reason);
    };
    const markUnavailable = (): void => {
      prerequisites.update("private_network", "unavailable", "provider_unreachable");
    };
    const removeExtension = await ctx.get<RemoteHost>("remote").registerExtension(createVpnRemoteExtension({
      backend,
      channelId: configured.channelId,
      intervalMs: configured.intervalMs,
      locale: configured.locale,
      stabilityIntervalMs: configured.stabilityIntervalMs,
      stabilityPolls: configured.stabilityPolls,
      onFailure: markUnavailable,
      onState: updatePrerequisite,
    }));
    ctx.effect(() => removeExtension);
    const tools = ctx.get<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.effect(() => tools.register(
        "vpn",
        createVpnStatusTool(
          ctx,
          () => createVpnWorkerBackend(configured.command),
          updatePrerequisite,
          markUnavailable,
        ),
      ));
  },
};
