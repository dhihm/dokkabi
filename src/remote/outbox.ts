import type { EventLog } from "../host/event-log.ts";
import { safeNoteText } from "../work/inbox.ts";
import { pendingDeliveries, queueDelivery } from "./ledger.ts";
import type { RemoteAdapter, RemoteDelivery } from "./types.ts";
import { RemoteConfigurationError, RemoteStateError } from "./types.ts";

interface RemoteOutboxInput {
  readonly adapter: () => RemoteAdapter | undefined;
  readonly log: EventLog;
}

export interface RemoteOutbox {
  enqueue(delivery: RemoteDelivery): void;
  recover(): void;
  idle(): Promise<void>;
}

export function createRemoteOutbox(input: RemoteOutboxInput): RemoteOutbox {
  const scheduled = new Set<string>();
  const tails = new Map<string, Promise<void>>();

  const schedule = (delivery: RemoteDelivery): void => {
    if (scheduled.has(delivery.deliveryId)) return;
    scheduled.add(delivery.deliveryId);
    const previous = tails.get(delivery.requestId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const adapter = input.adapter();
      if (!adapter) throw new RemoteConfigurationError("remote adapter is not registered");
      input.log.append({
        kind: "effect",
        name: "remote/send",
        payload: { delivery_id: delivery.deliveryId, request_id: delivery.requestId },
      });
      const sent = await adapter.deliver(delivery);
      input.log.append({
        kind: "observe",
        name: "remote/outbox_sent",
        payload: {
          delivery_id: delivery.deliveryId,
          external_message_id: sent.externalMessageId,
          request_id: delivery.requestId,
        },
      });
    });
    const settled = task.then(
      () => {
        scheduled.delete(delivery.deliveryId);
      },
      (error: unknown) => {
        scheduled.delete(delivery.deliveryId);
        const failure = error instanceof Error
          ? error
          : new RemoteStateError("deliver remote message", String(error));
        input.log.append({
          kind: "observe",
          name: "remote/outbox_failed",
          payload: {
            delivery_id: delivery.deliveryId,
            reason: safeNoteText(failure.message),
            request_id: delivery.requestId,
          },
        });
      },
    );
    tails.set(delivery.requestId, settled);
    void settled.then(() => {
      if (tails.get(delivery.requestId) === settled) tails.delete(delivery.requestId);
    });
  };

  return {
    enqueue(delivery) {
      schedule(queueDelivery(input.log, delivery));
    },
    recover() {
      for (const delivery of pendingDeliveries(input.log)) schedule(delivery);
    },
    async idle() {
      await Promise.all(tails.values());
    },
  };
}
