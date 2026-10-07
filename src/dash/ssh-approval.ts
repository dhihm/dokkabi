import { containsPrivateInfrastructure, containsSecret } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";

/** A public, unresolved SSH authority request safe to show or notify about. */
export interface PendingSshApproval {
  requestId: string;
  target: string;
  /** Pre-masked, display-only detail (e.g. an enroll's masked address). */
  detail?: string;
  requestedAt: string;
  seq: number;
}

/**
 * Project unresolved SSH authority requests from the EventLog.
 *
 * The logical target is the only request field that may reach operator chrome
 * or a terminal notification. Connection coordinates, command text, and the
 * command digest remain outside this projection.
 */
export function pendingSshApprovals(events: readonly EventRecord[]): PendingSshApproval[] {
  const pending = new Map<string, PendingSshApproval>();
  for (const event of events) {
    // The name first. Reading `payload.request_id` on every record touched
    // all 119,000 of them on a live log to find the handful that are
    // approvals -- and this runs on every paint, not every projection.
    // Nothing below can act on any other name, so the guard is the same walk.
    if (event.name !== "ssh/approval_requested" && event.name !== "ssh/approval_resolved") continue;
    const requestId = typeof event.payload.request_id === "string" ? event.payload.request_id : undefined;
    if (!requestId) continue;
    if (event.name === "ssh/approval_requested") {
      const target = typeof event.payload.target === "string" ? event.payload.target : undefined;
      if (!isSafeSshTarget(target)) continue;
      const rawDetail = typeof event.payload.detail === "string" ? event.payload.detail : undefined;
      // The detail is masked at the source, but re-guard it here: nothing that
      // still reads as a raw coordinate or secret reaches the popup.
      const detail = rawDetail && !containsPrivateInfrastructure(rawDetail) && !containsSecret(rawDetail)
        ? rawDetail
        : undefined;
      pending.set(requestId, {
        requestId,
        target,
        ...(detail ? { detail } : {}),
        requestedAt: event.ts,
        seq: event.seq,
      });
      continue;
    }
    if (event.name === "ssh/approval_resolved") {
      pending.delete(requestId);
    }
  }
  return [...pending.values()];
}

/** The request the operator should act on first: the newest unresolved one. */
export function pendingSshApproval(events: readonly EventRecord[]): PendingSshApproval | undefined {
  return pendingSshApprovals(events).at(-1);
}

export function isSafeSshTarget(target: unknown): target is string {
  return typeof target === "string"
    && target.length <= 63
    && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(target)
    && !containsSecret(target)
    && !containsPrivateInfrastructure(target);
}
