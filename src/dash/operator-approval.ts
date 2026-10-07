import type { EventRecord } from "../host/schema.ts";
import {
  pendingGithubAdminApprovals,
  type PendingGithubAdminApproval,
} from "./github-admin-approval.ts";
import { pendingSshApprovals, type PendingSshApproval } from "./ssh-approval.ts";
import { pendingMcpApprovals, type PendingMcpApproval } from "./mcp-approval.ts";
import {
  pendingManagedPluginApprovals,
  type PendingManagedPluginApproval,
} from "./managed-plugin-approval.ts";

export type PendingOperatorApproval =
  | { kind: "ssh"; approval: PendingSshApproval }
  | { kind: "github-admin"; approval: PendingGithubAdminApproval }
  | { kind: "mcp"; approval: PendingMcpApproval }
  | { kind: "plugin-install"; approval: PendingManagedPluginApproval };

/**
 * Every record an approval scanner can act on.
 *
 * The four scanners each walk what they are given; giving them the whole log
 * meant four passes over 119,000 records, on every paint, to find the handful
 * of approvals a session has.
 */
export const APPROVAL_EVENT_NAMES = [
  "ssh/approval_requested", "ssh/approval_resolved",
  "github/admin_approval_requested", "github/admin_approval_resolved",
  "mcp/approval_requested", "mcp/approval_resolved",
  "managed_plugin/approval_requested", "managed_plugin/approval_resolved",
] as const;

/** The approval records of a projection, already bucketed. */
export function approvalEventsOf(view: { index: { ofAny: (...names: string[]) => readonly EventRecord[] } }): readonly EventRecord[] {
  return view.index.ofAny(...APPROVAL_EVENT_NAMES);
}

export function pendingOperatorApprovals(events: readonly EventRecord[]): PendingOperatorApproval[] {
  return [
    ...pendingSshApprovals(events).map((approval) => ({ kind: "ssh" as const, approval })),
    ...pendingGithubAdminApprovals(events).map((approval) => ({ kind: "github-admin" as const, approval })),
    ...pendingMcpApprovals(events).map((approval) => ({ kind: "mcp" as const, approval })),
    ...pendingManagedPluginApprovals(events).map((approval) => ({ kind: "plugin-install" as const, approval })),
  ].sort((left, right) => left.approval.seq - right.approval.seq);
}

/** The newest unresolved request owns the single modal and direct-key route. */
export function pendingOperatorApproval(events: readonly EventRecord[]): PendingOperatorApproval | undefined {
  return pendingOperatorApprovals(events).at(-1);
}
