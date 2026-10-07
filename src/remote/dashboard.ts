import type { EventRecord } from "../host/schema.ts";

export interface RemoteDashboardState {
  readonly accepted: number;
  readonly adapter: string | "missing";
  readonly deliveryFailures: number;
  readonly pending: number;
  readonly requestFailures: number;
  readonly runningRequest: string | "missing";
  readonly runningSession: string | "missing";
  readonly transportFailures: number;
  readonly vpnFailures: number;
  readonly vpnOutages: number;
  readonly vpnState: string | "missing";
}

export function projectRemoteDashboard(events: readonly EventRecord[]): RemoteDashboardState {
  const accepted = events.filter((event) => event.name === "remote/request_accepted");
  const terminals = events.filter((event) => event.name === "remote/request_terminal");
  const terminalIds = new Set(
    terminals
      .map((event) => event.payload.request_id)
      .filter((requestId): requestId is string => typeof requestId === "string"),
  );
  const running = [...events].reverse().find(
    (event) => event.name === "remote/run_started"
      && typeof event.payload.request_id === "string"
      && !terminalIds.has(event.payload.request_id),
  );
  return {
    accepted: accepted.length,
    adapter: lastAdapterId(events) ?? "missing",
    deliveryFailures: events.filter((event) => event.name === "remote/outbox_failed").length,
    pending: accepted.filter((event) => !terminalIds.has(String(event.payload.request_id))).length,
    requestFailures: terminals.filter((event) => resultKind(event) === "failed").length,
    runningRequest: typeof running?.payload.request_id === "string"
      ? running.payload.request_id
      : "missing",
    runningSession: typeof running?.payload.session_id === "string"
      ? running.payload.session_id
      : "missing",
    transportFailures: events.filter((event) => event.name === "remote/transport_failed").length,
    vpnFailures: events.filter((event) => vpnFailureName(event.name)).length,
    vpnOutages: events.filter((event) => event.name === "vpn/outage_detected").length,
    vpnState: lastVpnState(events) ?? "missing",
  };
}

export function remoteFailureAlertLines(events: readonly EventRecord[]): string[] {
  return events.flatMap((event) => {
    // Same reason as the approval scanners: the name costs a comparison, the
    // payload costs a property read on every record of a 119,000-event log,
    // and this runs on every paint.
    if (
      event.name !== "remote/outbox_failed"
      && event.name !== "remote/transport_failed"
      && event.name !== "remote/request_terminal"
      && !vpnFailureName(event.name)
    ) {
      return [];
    }
    const request = typeof event.payload.request_id === "string"
      ? ` request=${event.payload.request_id}`
      : "";
    const reason = failureReason(event);
    if (event.name === "remote/outbox_failed") {
      return [`remote_delivery_failed${request}${reason}`];
    }
    if (event.name === "remote/transport_failed") {
      return [`remote_transport_failed${reason}`];
    }
    if (event.name === "remote/request_terminal" && resultKind(event) === "failed") {
      return [`remote_run_failed${request}${reason}`];
    }
    if (vpnFailureName(event.name)) {
      return [`${event.name.replace("/", "_")}${reason}`];
    }
    return [];
  });
}

function vpnFailureName(name: string): boolean {
  return name === "vpn/monitor_failed"
    || name === "vpn/operation_failed"
    || name === "vpn/tool_failed";
}

function lastVpnState(events: readonly EventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name !== "vpn/state") continue;
    const state = event.payload.state;
    if (typeof state === "string") return state;
  }
  return undefined;
}

function lastAdapterId(events: readonly EventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.name !== "remote/adapter_started" && event?.name !== "remote/request_accepted") continue;
    const adapter = event.payload.adapter_id;
    if (typeof adapter === "string") return adapter;
  }
  return undefined;
}

function resultKind(event: EventRecord): string | undefined {
  const result = event.payload.result;
  if (!result || typeof result !== "object") return undefined;
  const kind = (result as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

function failureReason(event: EventRecord): string {
  const nested = event.payload.result;
  const value = typeof event.payload.reason === "string"
    ? event.payload.reason
    : nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).reason === "string"
      ? String((nested as Record<string, unknown>).reason)
      : "unknown";
  const flat = value.replaceAll("\n", " ").trim();
  return ` ${flat.length > 80 ? `${flat.slice(0, 77)}...` : flat}`;
}
