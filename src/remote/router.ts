import type { EventLog } from "../host/event-log.ts";
import {
  finishRequest,
  recordRequestRouted,
  recordRunStarted,
  type AcceptedRemoteRequest,
} from "./ledger.ts";
import type { RemoteOutbox } from "./outbox.ts";
import { remoteMessages, type RemoteLocale } from "./locale.ts";
import type {
  RemoteDelivery,
  RemoteRunController,
  RemoteRunResult,
  RemoteStatusRegistry,
} from "./types.ts";
import { RemoteStateError } from "./types.ts";

interface RemoteRouterInput {
  readonly controller: RemoteRunController;
  readonly locale: RemoteLocale;
  readonly log: EventLog;
  readonly outbox: RemoteOutbox;
  readonly status: RemoteStatusRegistry;
}

export interface RemoteRouter {
  idle(): Promise<void>;
  route(request: AcceptedRemoteRequest): void;
}

export function createRemoteRouter(input: RemoteRouterInput): RemoteRouter {
  const messages = remoteMessages(input.locale);
  let workTail = Promise.resolve();
  let controlTail = Promise.resolve();
  const scheduled = new Set<string>();

  const complete = (request: AcceptedRemoteRequest, result: RemoteRunResult): void => {
    if (!finishRequest(input.log, request.request_id, result)) return;
    input.outbox.enqueue(terminalDelivery(request, result, messages));
  };

  const fail = (request: AcceptedRemoteRequest, error: unknown): void => {
    const failure = error instanceof Error
      ? error
      : new RemoteStateError("route remote request", String(error));
    complete(request, { kind: "failed", reason: failure.message });
  };

  const routeWork = async (request: AcceptedRemoteRequest): Promise<void> => {
    if (request.command.kind !== "work" && request.command.kind !== "note") {
      throw new RemoteStateError("route work", `unexpected ${request.command.kind} command`);
    }
    const current = input.controller.snapshot();
    if (current.kind === "running") {
      await input.controller.attach({ requestId: request.request_id, text: request.command.text });
      recordRequestRouted(input.log, request.request_id, "active_run_note");
      finishRequest(input.log, request.request_id, { kind: "completed", summary: "attached" });
      input.outbox.enqueue({
        channelId: request.channel_id,
        deliveryId: `${request.request_id}:attached`,
        kind: "attached",
        requestId: request.request_id,
        text: messages.attached,
      });
      return;
    }
    recordRequestRouted(input.log, request.request_id, "new_run");
    const handle = await input.controller.start({
      requestId: request.request_id,
      text: request.command.text,
    });
    recordRunStarted(input.log, request.request_id, handle.sessionId);
    void handle.completion.then(
      (result) => complete(request, result),
      (error: unknown) => fail(request, error),
    );
  };

  const routeControl = async (request: AcceptedRemoteRequest): Promise<void> => {
    switch (request.command.kind) {
      case "status": {
        recordRequestRouted(input.log, request.request_id, "control_status");
        const current = input.controller.snapshot();
        const statusLines = await input.status.lines();
        const runStatus = current.kind === "running"
          ? messages.statusRunning
          : messages.statusIdle;
        input.outbox.enqueue({
          channelId: request.channel_id,
          deliveryId: `${request.request_id}:status`,
          kind: "status",
          requestId: request.request_id,
          text: [runStatus, ...statusLines].join("\n"),
        });
        finishRequest(input.log, request.request_id, { kind: "completed", summary: "status" });
        return;
      }
      case "cancel": {
        recordRequestRouted(input.log, request.request_id, "control_cancel");
        const current = input.controller.snapshot();
        const cancelled = current.kind === "running"
          ? await input.controller.cancel(current.requestId)
          : false;
        if (current.kind === "running" && cancelled) {
          finishRequest(input.log, current.requestId, { kind: "cancelled" });
        }
        input.outbox.enqueue({
          channelId: request.channel_id,
          deliveryId: `${request.request_id}:cancelled`,
          kind: "cancelled",
          requestId: request.request_id,
          text: cancelled && current.kind === "running"
            ? messages.cancelRunning
            : messages.cancelIdle,
        });
        finishRequest(input.log, request.request_id, { kind: "completed", summary: "cancel" });
        return;
      }
      case "work":
      case "note":
        throw new RemoteStateError("route control", `unexpected ${request.command.kind} command`);
    }
  };

  const route = (request: AcceptedRemoteRequest): void => {
    if (scheduled.has(request.request_id)) return;
    scheduled.add(request.request_id);
    const work = request.command.kind === "work" || request.command.kind === "note";
    const task = work ? workTail.then(() => routeWork(request)) : controlTail.then(() => routeControl(request));
    const settled = task.then(
      () => {
        scheduled.delete(request.request_id);
      },
      (error: unknown) => {
        scheduled.delete(request.request_id);
        fail(request, error);
      },
    );
    if (work) workTail = settled;
    else controlTail = settled;
  };

  return {
    idle: async () => await Promise.all([workTail, controlTail]).then(() => undefined),
    route,
  };
}

function terminalDelivery(
  request: AcceptedRemoteRequest,
  result: RemoteRunResult,
  messages: ReturnType<typeof remoteMessages>,
): RemoteDelivery {
  switch (result.kind) {
    case "completed":
      return {
        channelId: request.channel_id,
        deliveryId: `${request.request_id}:completed`,
        kind: "completed",
        requestId: request.request_id,
        text: result.summary,
      };
    case "failed":
      return {
        channelId: request.channel_id,
        deliveryId: `${request.request_id}:failed`,
        kind: "failed",
        requestId: request.request_id,
        text: messages.failed,
      };
    case "cancelled":
      return {
        channelId: request.channel_id,
        deliveryId: `${request.request_id}:cancelled`,
        kind: "cancelled",
        requestId: request.request_id,
        text: messages.cancelled,
      };
  }
}
