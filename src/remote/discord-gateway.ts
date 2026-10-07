import type { RemoteIngress } from "./types.ts";
import { connectDiscordSocket, systemDiscordClock } from "./discord-socket.ts";
import {
  DiscordGatewayError,
  type DiscordGatewayClient,
  type DiscordGatewayClock,
  type DiscordGatewayInput,
  type DiscordGatewaySocket,
  type DiscordGatewayTimer,
} from "./discord-gateway-contract.ts";
import {
  parseDiscordEnvelope,
  parseDiscordHello,
  parseDiscordIngress,
  parseDiscordReady,
} from "./discord-wire.ts";

export type {
  DiscordGatewayClient,
  DiscordGatewayClock,
  DiscordGatewaySocket,
  DiscordGatewayTimer,
} from "./discord-gateway-contract.ts";
export { DiscordGatewayError } from "./discord-gateway-contract.ts";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

export function createDiscordGatewayClient(input: DiscordGatewayInput): DiscordGatewayClient {
  const clock = input.clock ?? systemDiscordClock;
  const connect = input.connect ?? connectDiscordSocket;
  let socket: DiscordGatewaySocket | undefined;
  let heartbeat: DiscordGatewayTimer | undefined;
  let readyTimeout: DiscordGatewayTimer | undefined;
  let reconnectTimeout: DiscordGatewayTimer | undefined;
  let heartbeatAcknowledged = true;
  let sequence: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let acceptTail = Promise.resolve();
  let started = false;
  let stopping = false;
  let ready = false;
  let resolveStart: (() => void) | undefined;
  let rejectStart: ((error: Error) => void) | undefined;

  const report = (error: Error): void => input.onError?.(error);

  const send = (current: DiscordGatewaySocket, payload: object): boolean => {
    if (socket !== current) return false;
    try {
      current.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      disconnect(current, normalizeError("send", error));
      return false;
    }
  };

  const scheduleReconnect = (): void => {
    if (!started || stopping || reconnectTimeout) return;
    reconnectTimeout = clock.setTimeout(() => {
      reconnectTimeout = undefined;
      connectSocket();
    }, input.reconnectDelayMs ?? 1_000);
  };

  const disconnect = (current: DiscordGatewaySocket, error: Error): void => {
    if (socket !== current || stopping) return;
    socket = undefined;
    heartbeat?.dispose();
    heartbeat = undefined;
    readyTimeout?.dispose();
    readyTimeout = undefined;
    current.close();
    if (!ready) {
      started = false;
      const reject = rejectStart;
      resolveStart = undefined;
      rejectStart = undefined;
      reject?.(error);
      return;
    }
    report(error);
    scheduleReconnect();
  };

  const sendHeartbeat = (current: DiscordGatewaySocket, requested: boolean): void => {
    if (!requested && !heartbeatAcknowledged) {
      disconnect(current, new DiscordGatewayError("heartbeat", "acknowledgement missing"));
      return;
    }
    heartbeatAcknowledged = false;
    send(current, { d: sequence, op: 1 });
  };

  const acceptMessage = (
    current: DiscordGatewaySocket,
    message: RemoteIngress,
    dispatchSequence: number | undefined,
  ): void => {
    const accepted = acceptTail.then(async () => {
      if (socket !== current) return;
      await input.ingress(message);
      if (socket === current && dispatchSequence !== undefined) sequence = dispatchSequence;
    });
    acceptTail = accepted.then(
      () => undefined,
      (error: unknown) => disconnect(current, normalizeError("durable accept", error)),
    );
  };

  const handlePayload = (current: DiscordGatewaySocket, raw: unknown): void => {
    if (socket !== current) return;
    const envelope = parseDiscordEnvelope(raw);
    if (!envelope) return;
    const dispatchSequence = envelope.s ?? undefined;
    switch (envelope.op) {
      case 10: {
        const heartbeatInterval = parseDiscordHello(envelope.d);
        if (heartbeatInterval === undefined) return;
        heartbeatAcknowledged = true;
        const resumable = ready && sessionId !== undefined && resumeUrl !== undefined && sequence !== null;
        const sent = resumable
          ? send(current, { d: { seq: sequence, session_id: sessionId, token: input.config.botToken }, op: 6 })
          : send(current, {
              d: {
                intents: INTENTS,
                properties: { browser: "dokkabi", device: "dokkabi", os: process.platform },
                token: input.config.botToken,
              },
              op: 2,
            });
        if (!sent) return;
        heartbeat?.dispose();
        heartbeat = clock.setInterval(() => sendHeartbeat(current, false), heartbeatInterval);
        return;
      }
      case 1:
        sendHeartbeat(current, true);
        return;
      case 11:
        heartbeatAcknowledged = true;
        return;
      case 7:
        disconnect(current, new DiscordGatewayError("gateway", "reconnect requested"));
        return;
      case 9:
        sessionId = undefined;
        resumeUrl = undefined;
        sequence = null;
        disconnect(current, new DiscordGatewayError("gateway", "session invalidated"));
        return;
      case 0:
        break;
      default:
        return;
    }
    if (envelope.t === "READY") {
      const parsed = parseDiscordReady(envelope.d);
      if (!parsed) {
        disconnect(current, new DiscordGatewayError("ready", "invalid payload"));
        return;
      }
      ready = true;
      sessionId = parsed.session_id;
      resumeUrl = parsed.resume_gateway_url;
      if (dispatchSequence !== undefined) sequence = dispatchSequence;
      readyTimeout?.dispose();
      readyTimeout = undefined;
      const resolve = resolveStart;
      resolveStart = undefined;
      rejectStart = undefined;
      resolve?.();
      return;
    }
    if (envelope.t === "RESUMED") {
      if (dispatchSequence !== undefined) sequence = dispatchSequence;
      return;
    }
    const message = parseDiscordIngress(envelope, input.adapterId, input.config);
    if (message) acceptMessage(current, message, dispatchSequence);
  };

  const connectSocket = (): void => {
    if (!started || stopping) return;
    const url = ready && resumeUrl ? `${resumeUrl.replace(/\/$/u, "")}/?v=10&encoding=json` : GATEWAY_URL;
    let current: DiscordGatewaySocket;
    try {
      current = connect(url);
    } catch (error) {
      const failure = normalizeError("connect", error);
      if (!ready) rejectStart?.(failure);
      else {
        report(failure);
        scheduleReconnect();
      }
      return;
    }
    socket = current;
    current.onOpen(() => undefined);
    current.onMessage((data) => handlePayload(current, data));
    current.onError((error) => disconnect(current, error));
    current.onClose((code) => disconnect(current, new DiscordGatewayError("socket", `closed with ${code}`)));
    readyTimeout = clock.setTimeout(
      () => disconnect(current, new DiscordGatewayError("ready", "timeout")),
      input.readyTimeoutMs ?? 30_000,
    );
  };

  return {
    async start() {
      if (started) throw new DiscordGatewayError("start", "already started");
      started = true;
      stopping = false;
      return await new Promise<void>((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
        connectSocket();
      });
    },
    async stop() {
      if (!started && !socket) return;
      stopping = true;
      started = false;
      heartbeat?.dispose();
      readyTimeout?.dispose();
      reconnectTimeout?.dispose();
      const current = socket;
      socket = undefined;
      current?.close();
      ready = false;
    },
  };
}

function normalizeError(operation: string, error: unknown): Error {
  return error instanceof Error ? error : new DiscordGatewayError(operation, String(error));
}
