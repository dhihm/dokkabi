import { containsSecret } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;

/** Public metadata for one unresolved private GitHub administration request. */
export interface PendingGithubAdminApproval {
  authorizeOwner: boolean;
  authorizeRepository: boolean;
  operation: "repo_create" | "repo_publish" | "repo_push";
  owner?: string;
  sourcePath?: string;
  fileCount?: number;
  totalBytes?: number;
  branch?: string;
  remoteHead?: string;
  localHead?: string;
  commitCount?: number;
  rangeDigest?: string;
  untrackedCount?: number;
  requestId: string;
  repo: string;
  visibility: "private";
  requestedAt: string;
  seq: number;
}

export function pendingGithubAdminApprovals(
  events: readonly EventRecord[],
): PendingGithubAdminApproval[] {
  const pending = new Map<string, PendingGithubAdminApproval>();
  for (const event of events) {
    // The name first. Reading `payload.request_id` on every record touched
    // all 119,000 of them on a live log to find the handful that are
    // approvals -- and this runs on every paint, not every projection.
    // Nothing below can act on any other name, so the guard is the same walk.
    if (event.name !== "github/admin_approval_requested" && event.name !== "github/admin_approval_resolved") continue;
    const requestId = typeof event.payload.request_id === "string" ? event.payload.request_id : undefined;
    if (!requestId) continue;
    if (event.name === "github/admin_approval_requested") {
      const repo = typeof event.payload.repo === "string" ? event.payload.repo : undefined;
      if (!repo || !REPOSITORY.test(repo) || containsSecret(repo) || event.payload.visibility !== "private") continue;
      const authorizeOwner = event.payload.authorize_owner === true;
      const authorizeRepository = event.payload.authorize_repository === true;
      const operation = event.payload.operation === "repo_publish"
        ? "repo_publish"
        : event.payload.operation === "repo_push"
          ? "repo_push"
          : "repo_create";
      const owner = typeof event.payload.owner === "string" ? event.payload.owner : undefined;
      if (authorizeOwner && (!owner || repo.split("/", 1)[0]?.toLowerCase() !== owner.toLowerCase())) continue;
      const sourcePath = safeSourcePath(event.payload.source_path);
      const fileCount = boundedInteger(event.payload.file_count, 128);
      const totalBytes = boundedInteger(event.payload.total_bytes, 5 * 1024 * 1024);
      if (operation === "repo_publish" && (!sourcePath || fileCount === undefined || totalBytes === undefined)) continue;
      const branch = safeBranch(event.payload.branch);
      const remoteHead = safeHex(event.payload.remote_head, 40);
      const localHead = safeHex(event.payload.local_head, 40);
      const commitCount = boundedInteger(event.payload.commit_count, 256);
      const rangeDigest = safeHex(event.payload.range_digest, 64);
      const untrackedCount = boundedInteger(event.payload.untracked_count, 1_000_000);
      if (operation === "repo_push" && (!branch || !remoteHead || !localHead
        || commitCount === undefined || commitCount < 1 || !rangeDigest || untrackedCount === undefined)) continue;
      pending.set(requestId, {
        authorizeOwner,
        authorizeRepository,
        operation,
        ...(owner ? { owner } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        ...(fileCount === undefined ? {} : { fileCount }),
        ...(totalBytes === undefined ? {} : { totalBytes }),
        ...(branch ? { branch } : {}),
        ...(remoteHead ? { remoteHead } : {}),
        ...(localHead ? { localHead } : {}),
        ...(commitCount === undefined ? {} : { commitCount }),
        ...(rangeDigest ? { rangeDigest } : {}),
        ...(untrackedCount === undefined ? {} : { untrackedCount }),
        requestId,
        repo,
        visibility: "private",
        requestedAt: event.ts,
        seq: event.seq,
      });
      continue;
    }
    if (event.name === "github/admin_approval_resolved") pending.delete(requestId);
  }
  return [...pending.values()];
}

function safeBranch(value: unknown): string | undefined {
  if (typeof value !== "string" || containsSecret(value)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(value)
    || value.includes("..") || value.includes("//") || value.includes("@{")
    || value.endsWith("/") || value.endsWith(".lock")) return undefined;
  return value;
}

function safeHex(value: unknown, length: number): string | undefined {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)
    ? value
    : undefined;
}

function safeSourcePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("..") || containsSecret(value)) {
    return undefined;
  }
  return /^[A-Za-z0-9._/-]{1,255}$/u.test(value) ? value : undefined;
}

function boundedInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

export function pendingGithubAdminApproval(
  events: readonly EventRecord[],
): PendingGithubAdminApproval | undefined {
  return pendingGithubAdminApprovals(events).at(-1);
}
