import { EventLog } from "../host/event-log.ts";

/** Per-ledger writer bound, shared by server audit and workbench handles.
 * This is not an aggregate disk cap or a read acquisition policy. */
export const GATEWAY_LOG_MAX_BYTES = 128 * 1024 * 1024;

export function openGatewayLog(path: string, options: { maxBytes?: number } = {}): EventLog {
  return EventLog.create(path, { maxBytes: options.maxBytes === undefined ? GATEWAY_LOG_MAX_BYTES : options.maxBytes });
}
