import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import type { SshApprovedOperation, SshService, SshToolResult } from "../../src/host/ssh.ts";
import {
  sealEnrolledSshWarmup,
  type SshWarmupPlan,
  type SshWarmupResource,
} from "../../src/speculative/warmup/ssh.ts";
import { textToolResult } from "../../src/tools/model-result.ts";

export const SSH_EXACT_PROVIDER_DIGEST = createHash("sha256")
  .update("tier3:ssh:queued-exec-control-v1", "utf8")
  .digest("hex");

export type ProjectedQueuedSshExec = Readonly<{
  request: Readonly<{ target: string; command: string; timeout?: number }>;
}>;

export interface SshExactToolAuthority {
  readonly providerDigest: string;
  project(args: unknown): ProjectedQueuedSshExec | undefined;
  seal(projected: ProjectedQueuedSshExec): SshWarmupPlan | undefined;
  executeApproved(
    plan: SshWarmupPlan,
    resource: SshWarmupResource<SshApprovedOperation>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>>;
  format(result: SshToolResult): AgentToolResult<unknown>;
}

const SERVICES = new WeakMap<AgentTool, SshService>();
const AUTHORITIES = new WeakMap<AgentTool, SshExactToolAuthority>();

export function registerSshExactTool(tool: AgentTool, service: SshService): void {
  if (SERVICES.has(tool)) throw new Error("SSH exact tool is already registered");
  SERVICES.set(tool, service);
}

export function sshExactToolAuthority(
  tool: AgentTool,
  service: SshService,
): SshExactToolAuthority | undefined {
  if (SERVICES.get(tool) !== service) return undefined;
  const existing = AUTHORITIES.get(tool);
  if (existing) return existing;
  const projectedValues = new WeakSet<ProjectedQueuedSshExec>();
  const authority: SshExactToolAuthority = Object.freeze({
    providerDigest: SSH_EXACT_PROVIDER_DIGEST,
    project(args: unknown) {
      const request = exactRequest(args);
      if (!request) return undefined;
      const projected = Object.freeze({ request });
      projectedValues.add(projected);
      return projected;
    },
    seal(projected: ProjectedQueuedSshExec) {
      if (!projectedValues.has(projected)) return undefined;
      const transport = service.warmupTransport(projected.request.target);
      if (!transport) return undefined;
      return sealEnrolledSshWarmup({ transport, ...projected.request });
    },
    async executeApproved(
      plan: SshWarmupPlan,
      resource: SshWarmupResource<SshApprovedOperation>,
      signal?: AbortSignal,
    ) {
      const result = await service.executeApproved({
        request: plan.request,
        approval: resource.approval,
        runner: resource.runner,
        transport: resource.transport,
      }, signal);
      return textToolResult(result.text, result.error);
    },
    format: (result: SshToolResult) => textToolResult(result.text, result.error),
  });
  AUTHORITIES.set(tool, authority);
  return authority;
}

function exactRequest(args: unknown): ProjectedQueuedSshExec["request"] | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(args);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string" || !["op", "target", "command", "timeout"].includes(key)) return undefined;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return undefined;
  }
  const read = (key: string): unknown => {
    const descriptor = descriptors[key];
    return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
  };
  const op = read("op");
  const target = read("target");
  const command = read("command");
  const timeout = read("timeout");
  if (op !== "exec" || typeof target !== "string" || target.length === 0 || target.includes("\0") ||
    typeof command !== "string" || command.length === 0 || command.includes("\0")) return undefined;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600)) {
    return undefined;
  }
  return Object.freeze({ target, command, ...(timeout === undefined ? {} : { timeout }) });
}
