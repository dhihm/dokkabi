import type { EventRecord } from "../host/schema.ts";
import { containsPrivateInfrastructureValue, containsSecretValue } from "../host/redact.ts";

export interface PendingManagedPluginApproval {
  requestId: string;
  id: string;
  skillName: string;
  repository: string;
  commit: string;
  sourcePath: string;
  license: string;
  packageDigest: string;
  fileCount: number;
  totalBytes: number;
  referenceCount: number;
  replace: boolean;
  requestedAt: string;
  seq: number;
}

export function pendingManagedPluginApprovals(events: readonly EventRecord[]): PendingManagedPluginApproval[] {
  const pending = new Map<string, PendingManagedPluginApproval>();
  for (const event of events) {
    // The name first. Reading `payload.request_id` on every record touched
    // all 119,000 of them on a live log to find the handful that are
    // approvals -- and this runs on every paint, not every projection.
    // Nothing below can act on any other name, so the guard is the same walk.
    if (event.name !== "managed_plugin/approval_requested" && event.name !== "managed_plugin/approval_resolved") continue;
    const requestId = safeRequestId(event.payload.request_id);
    if (!requestId) continue;
    if (event.name === "managed_plugin/approval_requested") {
      const id = safeId(event.payload.id);
      const skillName = safeId(event.payload.skill_name);
      const repository = safeRepository(event.payload.repository);
      const commit = safeCommit(event.payload.commit);
      const sourcePath = safePath(event.payload.source_path);
      const license = safeLicense(event.payload.license);
      const packageDigest = safeDigest(event.payload.package_digest);
      const fileCount = safeCount(event.payload.file_count, 64);
      const totalBytes = safeCount(event.payload.total_bytes, 2 * 1024 * 1024);
      const referenceCount = safeCount(event.payload.reference_count, 64);
      if (!id || !skillName || !repository || !commit || !sourcePath || !license || !packageDigest
        || fileCount === undefined || totalBytes === undefined || referenceCount === undefined
        || event.payload.content_kind !== "inert_skill_bundle" || event.payload.runtime !== "none"
        || event.payload.host_execution !== false) continue;
      const value = {
        requestId,
        id,
        skillName,
        repository,
        commit,
        sourcePath,
        license,
        packageDigest,
        fileCount,
        totalBytes,
        referenceCount,
        replace: event.payload.replace === true,
        requestedAt: event.ts,
        seq: event.seq,
      } satisfies PendingManagedPluginApproval;
      if (containsSecretValue(value) || containsPrivateInfrastructureValue(value)) continue;
      pending.set(requestId, value);
      continue;
    }
    if (event.name === "managed_plugin/approval_resolved") pending.delete(requestId);
  }
  return [...pending.values()];
}

export function pendingManagedPluginApproval(
  events: readonly EventRecord[],
): PendingManagedPluginApproval | undefined {
  return pendingManagedPluginApprovals(events).at(-1);
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^managed-plugin-[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined;
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9._-]{0,127}$/u.test(value) ? value : undefined;
}

function safeRepository(value: unknown): string | undefined {
  return typeof value === "string"
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u.test(value)
    ? value
    : undefined;
}

function safeCommit(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : undefined;
}

function safeDigest(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function safePath(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 1024
      && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => !part || part === "." || part === "..")
    ? value
    : undefined;
}

function safeLicense(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(value) ? value : undefined;
}

function safeCount(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
}
