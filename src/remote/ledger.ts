import { z } from "zod";
import type { EventLog } from "../host/event-log.ts";
import { safeNoteText } from "../work/inbox.ts";
import type { RemoteDelivery, RemoteIngress, RemoteRunResult } from "./types.ts";

const CommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work"), text: z.string() }),
  z.object({ kind: z.literal("note"), text: z.string() }),
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("cancel") }),
]);

const AcceptedPayloadSchema = z.object({
  adapter_id: z.string(),
  channel_id: z.string(),
  command: CommandSchema,
  external_id: z.string(),
  operator_id: z.string(),
  request_id: z.string(),
});

const DeliveryPayloadSchema = z.object({
  channel_id: z.string(),
  delivery_id: z.string(),
  kind: z.enum(["accepted", "status", "notice", "attached", "cancelled", "completed", "failed"]),
  request_id: z.string(),
  text: z.string(),
});

export type AcceptedRemoteRequest = z.infer<typeof AcceptedPayloadSchema>;

export function remoteRequestId(message: RemoteIngress): string {
  return `${message.adapterId}:${message.externalId}`;
}

export function acceptRemoteRequest(
  log: EventLog,
  message: RemoteIngress,
): { readonly request: AcceptedRemoteRequest; readonly duplicate: boolean } {
  const requestId = remoteRequestId(message);
  const existing = acceptedRequests(log).find((request) => request.request_id === requestId);
  if (existing) return { request: existing, duplicate: true };
  const command = sanitizeCommand(message.command);
  const payload = AcceptedPayloadSchema.parse({
    adapter_id: message.adapterId,
    channel_id: message.channelId,
    command,
    external_id: message.externalId,
    operator_id: message.operatorId,
    request_id: requestId,
  });
  log.append({ kind: "observe", name: "remote/request_accepted", payload });
  return { request: payload, duplicate: false };
}

export function acceptedRequests(log: EventLog): AcceptedRemoteRequest[] {
  return log.events.flatMap((event) => {
    if (event.name !== "remote/request_accepted") return [];
    const parsed = AcceptedPayloadSchema.safeParse(event.payload);
    return parsed.success ? [parsed.data] : [];
  });
}

export function pendingRequests(log: EventLog): AcceptedRemoteRequest[] {
  const terminal = new Set(
    log.events
      .filter((event) => event.name === "remote/request_terminal")
      .map((event) => event.payload.request_id)
      .filter((requestId): requestId is string => typeof requestId === "string"),
  );
  return acceptedRequests(log).filter((request) => !terminal.has(request.request_id));
}

export function recordRequestRouted(log: EventLog, requestId: string, route: string): void {
  log.append({
    kind: "observe",
    name: "remote/request_routed",
    payload: { request_id: requestId, route },
  });
}

export function recordRunStarted(log: EventLog, requestId: string, sessionId: string): void {
  log.append({
    kind: "observe",
    name: "remote/run_started",
    payload: { request_id: requestId, session_id: sessionId },
  });
}

export function finishRequest(log: EventLog, requestId: string, result: RemoteRunResult): boolean {
  const exists = log.events.some(
    (event) => event.name === "remote/request_terminal" && event.payload.request_id === requestId,
  );
  if (exists) return false;
  log.append({
    kind: "observe",
    name: "remote/request_terminal",
    payload: { request_id: requestId, result: sanitizeResult(result) },
  });
  return true;
}

export function queueDelivery(log: EventLog, delivery: RemoteDelivery): RemoteDelivery {
  const payload = DeliveryPayloadSchema.parse(deliveryToPayload(delivery));
  log.append({
    kind: "observe",
    name: "remote/outbox_queued",
    payload,
  });
  return payloadToDelivery(payload);
}

export function pendingDeliveries(log: EventLog): RemoteDelivery[] {
  const settled = new Set(
    log.events
      .filter((event) => event.name === "remote/outbox_sent")
      .map((event) => event.payload.delivery_id)
      .filter((deliveryId): deliveryId is string => typeof deliveryId === "string"),
  );
  return log.events.flatMap((event) => {
    if (event.name !== "remote/outbox_queued") return [];
    const parsed = DeliveryPayloadSchema.safeParse(event.payload);
    if (!parsed.success || settled.has(parsed.data.delivery_id)) return [];
    return [payloadToDelivery(parsed.data)];
  });
}

export function hasAcceptedDelivery(log: EventLog, requestId: string): boolean {
  return log.events.some(
    (event) => event.name === "remote/outbox_queued"
      && event.payload.request_id === requestId
      && event.payload.kind === "accepted",
  );
}

function sanitizeCommand(command: RemoteIngress["command"]): RemoteIngress["command"] {
  switch (command.kind) {
    case "work":
      return { kind: "work", text: safeNoteText(command.text) };
    case "note":
      return { kind: "note", text: safeNoteText(command.text) };
    case "status":
      return { kind: "status" };
    case "cancel":
      return { kind: "cancel" };
  }
}

function deliveryToPayload(delivery: RemoteDelivery): z.input<typeof DeliveryPayloadSchema> {
  return {
    channel_id: delivery.channelId,
    delivery_id: delivery.deliveryId,
    kind: delivery.kind,
    request_id: delivery.requestId,
    text: safeNoteText(delivery.text),
  };
}

function sanitizeResult(result: RemoteRunResult): RemoteRunResult {
  switch (result.kind) {
    case "completed":
      return { kind: "completed", summary: safeNoteText(result.summary) };
    case "failed":
      return { kind: "failed", reason: safeNoteText(result.reason) };
    case "cancelled":
      return { kind: "cancelled" };
  }
}

function payloadToDelivery(payload: z.infer<typeof DeliveryPayloadSchema>): RemoteDelivery {
  return {
    channelId: payload.channel_id,
    deliveryId: payload.delivery_id,
    kind: payload.kind,
    requestId: payload.request_id,
    text: payload.text,
  };
}
