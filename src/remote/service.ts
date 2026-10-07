import type { EventLog } from "../host/event-log.ts";
import {
  acceptRemoteRequest,
  hasAcceptedDelivery,
  pendingRequests,
  type AcceptedRemoteRequest,
} from "./ledger.ts";
import { createRemoteOutbox } from "./outbox.ts";
import { createRemoteRouter } from "./router.ts";
import { createRemoteStatusRegistry } from "./status.ts";
import { remoteMessages, type RemoteLocale } from "./locale.ts";
import type {
  RemoteAdapter,
  RemoteExtension,
  RemoteExtensionContext,
  RemoteHost,
  RemoteIngress,
  RemoteIngressReceipt,
  RemoteRunController,
  RemoteStatusRegistry,
} from "./types.ts";
import { RemoteConfigurationError, RemoteStateError } from "./types.ts";
import { remoteRequestId } from "./ledger.ts";

interface RemoteHostInput {
  readonly adapter?: RemoteAdapter;
  readonly controller: RemoteRunController;
  readonly locale?: RemoteLocale;
  readonly log: EventLog;
  readonly status?: RemoteStatusRegistry;
}

export function createRemoteHost(input: RemoteHostInput): RemoteHost {
  const messages = remoteMessages(input.locale ?? "en");
  let adapter = input.adapter;
  let desiredStarted = false;
  let adapterStarted = false;
  const extensions: RemoteExtension[] = [];
  const startedExtensions = new Set<RemoteExtension>();
  const outbox = createRemoteOutbox({ adapter: () => adapter, log: input.log });
  const status = input.status ?? createRemoteStatusRegistry();
  const router = createRemoteRouter({
    controller: input.controller,
    locale: input.locale ?? "en",
    log: input.log,
    outbox,
    status,
  });

  async function accept(message: RemoteIngress): Promise<RemoteIngressReceipt> {
    for (const extension of extensions) {
      const result = await extension.accept(message, extensionContext(extension, message));
      if (result.handled) {
        return { duplicate: result.duplicate, requestId: result.requestId };
      }
    }
    const accepted = acceptRemoteRequest(input.log, message);
    if (accepted.duplicate) {
      return { duplicate: true, requestId: accepted.request.request_id };
    }
    enqueueAccepted(accepted.request);
    router.route(accepted.request);
    return { duplicate: false, requestId: accepted.request.request_id };
  }

  function extensionContext(
    extension: RemoteExtension,
    message?: RemoteIngress,
  ): RemoteExtensionContext {
    const requestId = message ? remoteRequestId(message) : `extension:${extension.id}`;
    return {
      log: input.log,
      accept(inputKind) {
        if (!message) throw new RemoteStateError("accept remote extension input", "no ingress is active");
        const duplicate = input.log.events.some(
          (event) => event.name === "remote/extension_accepted"
            && event.payload.request_id === requestId,
        );
        if (!duplicate) {
          input.log.append({
            kind: "observe",
            name: "remote/extension_accepted",
            payload: {
              adapter_id: message.adapterId,
              channel_id: message.channelId,
              extension_id: extension.id,
              external_id: message.externalId,
              input_kind: inputKind,
              operator_id: message.operatorId,
              request_id: requestId,
            },
          });
        }
        return { duplicate, requestId };
      },
      enqueue(delivery) {
        outbox.enqueue(delivery);
      },
      finish(status) {
        const exists = input.log.events.some(
          (event) => event.name === "remote/extension_terminal"
            && event.payload.request_id === requestId,
        );
        if (!exists) {
          input.log.append({
            kind: "observe",
            name: "remote/extension_terminal",
            payload: { extension_id: extension.id, request_id: requestId, status },
          });
        }
      },
    };
  }

  function enqueueAccepted(request: AcceptedRemoteRequest): void {
    if (hasAcceptedDelivery(input.log, request.request_id)) return;
    outbox.enqueue({
      channelId: request.channel_id,
      deliveryId: `${request.request_id}:accepted`,
      kind: "accepted",
      requestId: request.request_id,
      text: messages.accepted,
    });
  }

  async function startAdapter(current: RemoteAdapter): Promise<void> {
    if (adapterStarted) return;
    await current.start(accept);
    adapterStarted = true;
    input.log.append({
      kind: "observe",
      name: "remote/adapter_started",
      payload: { adapter_id: current.id },
    });
    outbox.recover();
    for (const request of pendingRequests(input.log)) {
      enqueueAccepted(request);
      router.route(request);
    }
  }

  async function startExtension(extension: RemoteExtension): Promise<void> {
    if (startedExtensions.has(extension)) return;
    await extension.start(extensionContext(extension));
    startedExtensions.add(extension);
    input.log.append({
      kind: "observe",
      name: "remote/extension_started",
      payload: { extension_id: extension.id },
    });
  }

  const host: RemoteHost = {
    log: input.log,
    adapterId: () => adapter?.id,
    extensionIds: () => extensions.map((extension) => extension.id),
    async registerAdapter(next) {
      if (adapter) throw new RemoteConfigurationError(`remote adapter ${adapter.id} is already registered`);
      adapter = next;
      try {
        if (desiredStarted) await startAdapter(next);
      } catch (error) {
        await next.stop().catch(() => undefined);
        if (adapter === next) adapter = undefined;
        throw error;
      }
      return async () => {
        if (adapter !== next) return;
        adapter = undefined;
        if (adapterStarted) {
          adapterStarted = false;
          await next.stop();
        }
      };
    },
    async registerExtension(extension) {
      if (extensions.some((candidate) => candidate.id === extension.id)) {
        throw new RemoteConfigurationError(`remote extension ${extension.id} is already registered`);
      }
      extensions.push(extension);
      try {
        if (desiredStarted) await startExtension(extension);
      } catch (error) {
        const index = extensions.indexOf(extension);
        if (index >= 0) extensions.splice(index, 1);
        await extension.stop().catch(() => undefined);
        throw error;
      }
      return async () => {
        if (!extensions.includes(extension)) return;
        startedExtensions.delete(extension);
        const index = extensions.indexOf(extension);
        if (index >= 0) extensions.splice(index, 1);
        await extension.stop();
      };
    },
    async start() {
      if (desiredStarted) throw new RemoteStateError("start remote host", "already started");
      const current = adapter;
      if (!current) throw new RemoteConfigurationError("remote adapter is not registered");
      desiredStarted = true;
      try {
        await startAdapter(current);
        for (const extension of extensions) await startExtension(extension);
      } catch (error) {
        desiredStarted = false;
        for (const extension of [...startedExtensions].reverse()) {
          startedExtensions.delete(extension);
          await extension.stop().catch(() => undefined);
        }
        adapterStarted = false;
        await current.stop().catch(() => undefined);
        throw error;
      }
    },
    async stop() {
      if (!desiredStarted && !adapterStarted && startedExtensions.size === 0) return;
      desiredStarted = false;
      const failures: unknown[] = [];
      for (const extension of [...startedExtensions].reverse()) {
        startedExtensions.delete(extension);
        try {
          await extension.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      if (adapterStarted) {
        adapterStarted = false;
        try {
          await adapter?.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await Promise.all([router.idle(), outbox.idle()]);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw failures[0];
    },
  };
  return host;
}
