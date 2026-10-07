import type { EventRecord } from "../host/schema.ts";
import { containsPrivateInfrastructureValue, containsSecretValue } from "../host/redact.ts";

export interface PendingMcpApproval {
  operation: "server_enroll" | "tool_call";
  requestId: string;
  server: string;
  requestedAt: string;
  seq: number;
  command?: string;
  args?: readonly string[];
  envNames?: readonly string[];
  executableDigest?: string;
  replace?: boolean;
  tool?: string;
  argumentDigest?: string;
}

export function pendingMcpApprovals(events: readonly EventRecord[]): PendingMcpApproval[] {
  const pending = new Map<string, PendingMcpApproval>();
  for (const event of events) {
    // The name first. Reading `payload.request_id` on every record touched
    // all 119,000 of them on a live log to find the handful that are
    // approvals -- and this runs on every paint, not every projection.
    // Nothing below can act on any other name, so the guard is the same walk.
    if (event.name !== "mcp/approval_requested" && event.name !== "mcp/approval_resolved") continue;
    const requestId = safeId(event.payload.request_id);
    if (!requestId) continue;
    if (event.name === "mcp/approval_requested") {
      const operation = event.payload.operation === "server_enroll"
        ? "server_enroll"
        : event.payload.operation === "tool_call"
          ? "tool_call"
          : undefined;
      const server = safeName(event.payload.server, 64);
      if (!operation || !server || event.payload.filesystem !== "isolated_empty") continue;
      const command = safeName(event.payload.command, 128);
      const args = safeStringArray(event.payload.args, 24, 512);
      const envNames = safeStringArray(event.payload.env_names, 16, 64);
      const executableDigest = safeDigest(event.payload.executable_digest);
      const tool = safeTool(event.payload.tool);
      const argumentDigest = safeDigest(event.payload.argument_digest);
      if (operation === "server_enroll" && (!command || !args || !envNames || !executableDigest)) continue;
      if (operation === "tool_call" && (!tool || !argumentDigest)) continue;
      const value = {
        operation,
        requestId,
        server,
        requestedAt: event.ts,
        seq: event.seq,
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
        ...(envNames ? { envNames } : {}),
        ...(executableDigest ? { executableDigest } : {}),
        ...(event.payload.replace === true ? { replace: true } : {}),
        ...(tool ? { tool } : {}),
        ...(argumentDigest ? { argumentDigest } : {}),
      } satisfies PendingMcpApproval;
      if (containsSecretValue(value) || containsPrivateInfrastructureValue(value)) continue;
      pending.set(requestId, value);
      continue;
    }
    if (event.name === "mcp/approval_resolved") pending.delete(requestId);
  }
  return [...pending.values()];
}

export function pendingMcpApproval(events: readonly EventRecord[]): PendingMcpApproval | undefined {
  return pendingMcpApprovals(events).at(-1);
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^mcp-[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined;
}

function safeName(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)
    ? value
    : undefined;
}

function safeTool(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function safeDigest(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function safeStringArray(value: unknown, maxItems: number, maxLength: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const strings = value.filter((item): item is string =>
    typeof item === "string" && item.length <= maxLength && !/[\0\r\n]/u.test(item)
  );
  return strings.length === value.length ? strings : undefined;
}
