import type { RemoteIngressHandler } from "./types.ts";
import type { DiscordGatewayConfig } from "./discord-wire.ts";

export interface DiscordGatewayTimer {
  dispose(): void;
}

export interface DiscordGatewayClock {
  setInterval(listener: () => void, milliseconds: number): DiscordGatewayTimer;
  setTimeout(listener: () => void, milliseconds: number): DiscordGatewayTimer;
}

export interface DiscordGatewaySocket {
  send(payload: string): void;
  close(): void;
  onMessage(listener: (data: unknown) => void): void;
  onOpen(listener: () => void): void;
  onClose(listener: (code: number) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface DiscordGatewayClient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordGatewayInput {
  readonly adapterId: string;
  readonly clock?: DiscordGatewayClock;
  readonly config: DiscordGatewayConfig;
  readonly connect?: (url: string) => DiscordGatewaySocket;
  readonly ingress: RemoteIngressHandler;
  readonly onError?: (error: Error) => void;
  readonly readyTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
}

export class DiscordGatewayError extends Error {
  constructor(readonly operation: string, readonly reason: string) {
    super(`${operation}: ${reason}`);
    this.name = "DiscordGatewayError";
  }
}
