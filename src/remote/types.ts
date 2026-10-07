import type { EventLog } from "../host/event-log.ts";

export type RemoteCommand =
  | { readonly kind: "work"; readonly text: string }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "status" }
  | { readonly kind: "cancel" };

export interface RemoteIngress {
  readonly adapterId: string;
  readonly externalId: string;
  readonly channelId: string;
  readonly operatorId: string;
  readonly command: RemoteCommand;
}

export interface RemoteIngressReceipt {
  readonly requestId: string;
  readonly duplicate: boolean;
}

export type RemoteDeliveryKind =
  | "accepted"
  | "status"
  | "notice"
  | "attached"
  | "cancelled"
  | "completed"
  | "failed";

export interface RemoteDelivery {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly channelId: string;
  readonly kind: RemoteDeliveryKind;
  readonly text: string;
}

export type RemoteIngressHandler = (message: RemoteIngress) => Promise<RemoteIngressReceipt>;

export interface RemoteAdapter {
  readonly id: string;
  start(ingress: RemoteIngressHandler): Promise<void>;
  stop(): Promise<void>;
  deliver(message: RemoteDelivery): Promise<{ readonly externalMessageId: string }>;
}

export interface RemoteExtensionContext {
  readonly log: EventLog;
  accept(inputKind: string): RemoteIngressReceipt;
  enqueue(delivery: RemoteDelivery): void;
  finish(status: "completed" | "failed"): void;
}

export type RemoteExtensionResult =
  | { readonly handled: false }
  | ({ readonly handled: true } & RemoteIngressReceipt);

export interface RemoteExtension {
  readonly id: string;
  start(context: RemoteExtensionContext): Promise<void>;
  stop(): Promise<void>;
  accept(
    message: RemoteIngress,
    context: RemoteExtensionContext,
  ): Promise<RemoteExtensionResult>;
}

export type RemoteRunSnapshot =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly requestId: string; readonly sessionId: string };

export type RemoteRunResult =
  | { readonly kind: "completed"; readonly summary: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "cancelled" };

export interface RemoteRunHandle {
  readonly requestId: string;
  readonly sessionId: string;
  readonly completion: Promise<RemoteRunResult>;
}

export interface RemoteRunController {
  snapshot(): RemoteRunSnapshot;
  start(request: Readonly<{ requestId: string; text: string }>): Promise<RemoteRunHandle>;
  attach(request: Readonly<{ requestId: string; text: string }>): Promise<void>;
  cancel(requestId: string): Promise<boolean>;
}

export type RemoteRegistrationDisposer = () => void | Promise<void>;

export type RemoteStatusContribution =
  () => string | readonly string[] | Promise<string | readonly string[]>;

/** Ordered host-only status contributions. Implementations must validate the
 * returned text before it crosses a remote transport boundary. */
export interface RemoteStatusRegistry {
  register(id: string, contribution: RemoteStatusContribution): RemoteRegistrationDisposer;
  lines(): Promise<readonly string[]>;
}

export interface RemoteHost {
  readonly log: EventLog;
  adapterId(): string | undefined;
  extensionIds(): readonly string[];
  registerAdapter(adapter: RemoteAdapter): Promise<RemoteRegistrationDisposer>;
  registerExtension(extension: RemoteExtension): Promise<RemoteRegistrationDisposer>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class RemoteConfigurationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RemoteConfigurationError";
  }
}

export class RemoteStateError extends Error {
  constructor(readonly operation: string, readonly reason: string) {
    super(`${operation}: ${reason}`);
    this.name = "RemoteStateError";
  }
}
