import type { EventRecord } from "../host/schema.ts";
import type { DashProjection } from "./project.ts";
import { pendingOperatorApprovals } from "./operator-approval.ts";

/**
 * What should ring. One entry per kind per transition — a paint that both
 * finished the run and cleared a todo rings twice, deliberately: they are
 * different facts worth different reactions.
 */
export interface BellEvent {
  kind: "alert" | "run-done" | "graph-done";
  label: string;
}

/**
 * Diff two consecutive projections into what is new enough to ring about.
 *
 * Everything here is a transition, never a state: repainting an unchanged
 * board must stay silent, or an idle dashboard becomes a siren. The inputs
 * are plain projections so this runs anywhere — no pty, no clock.
 *
 * Kinds:
 * - `alert` — a swe/result verdict or a refusal the previous paint did not
 *   have; these are the ALERTS pane's sources and they mean something went
 *   wrong or needs a decision.
 * - `run-done` — agent/status reached done from anything else.
 * - `graph-done` — a work/clear for a todo that was not clear before.
 */
/**
 * The newest swe/result.
 *
 * Scanning for it -- forwards or backwards -- costs the whole log on a run
 * that has none, which is most runs. The bucket is empty or it is not.
 */
function lastSweResult(view: DashProjection): EventRecord | undefined {
  return view.index.last("swe/result");
}

function lastResultSeq(view: DashProjection | undefined): number {
  if (!view) return -1;
  return lastSweResult(view)?.seq ?? -1;
}

/** Only the records an approval scanner can act on. */
const APPROVAL_NAMES = [
  "ssh/approval_requested", "ssh/approval_resolved",
  "github/admin_approval_requested", "github/admin_approval_resolved",
  "mcp/approval_requested", "mcp/approval_resolved",
  "managed_plugin/approval_requested", "managed_plugin/approval_resolved",
] as const;

function approvalRows(view: DashProjection): readonly EventRecord[] {
  return view.index.ofAny(...APPROVAL_NAMES);
}

export function bellEvents(prev: DashProjection | undefined, next: DashProjection): BellEvent[] {
  const out: BellEvent[] = [];

  // Alerts first: they outrank completions when an operator decides whether
  // to look. Only the newest new one rings — a burst of ten failures is one
  // reason to look, not ten.
  // This runs on every paint, not every projection, and it used to filter the
  // whole log and then COPY it to reverse it -- twice 119,000 records to
  // decide whether one event had arrived. A run with no swe/result at all,
  // which is most of them, paid the whole bill for nothing.
  //
  // Only the newest matters and the log only appends, so the newest seq the
  // previous paint had is the whole of what needs remembering.
  const previousResult = lastResultSeq(prev);
  const newest = lastSweResult(next);
  if (newest && newest.seq > previousResult) {
    out.push({
      kind: "alert",
      label: `swe/result ${newest.payload.resolved === true ? "resolved" : "unresolved"}`,
    });
  }
  const prevRefusals = prev?.work.refusals.length ?? 0;
  if (next.work.refusals.length > prevRefusals) {
    out.push({
      kind: "alert",
      label: `refused ${next.work.refusals[next.work.refusals.length - 1]}`,
    });
  }
  const seenApprovals = new Set(
    (prev ? pendingOperatorApprovals(approvalRows(prev)) : []).map((pending) => pending.approval.seq),
  );
  const newApproval = pendingOperatorApprovals(approvalRows(next))
    .reverse()
    .find((pending) => !seenApprovals.has(pending.approval.seq));
  if (newApproval) {
    out.push({
      kind: "alert",
      label: newApproval.kind === "ssh"
        ? `SSH approval target=${newApproval.approval.target}`
        : newApproval.kind === "github-admin"
          ? `GitHub approval repo=${newApproval.approval.repo}`
          : newApproval.kind === "plugin-install"
            ? `Plugin install id=${newApproval.approval.id} repo=${newApproval.approval.repository}`
            : newApproval.approval.operation === "server_enroll"
              ? `MCP enrollment server=${newApproval.approval.server}`
              : `MCP tool server=${newApproval.approval.server} tool=${newApproval.approval.tool ?? "unavailable"}`,
    });
  }

  if (
    prev !== undefined &&
    prev.work.agentStatus !== "done" &&
    next.work.agentStatus === "done"
  ) {
    out.push({ kind: "run-done", label: "run done" });
  }

  // The same shape as the swe/result check above, and the same fix: only the
  // newest clear can ring, and the log only appends, so the previous paint's
  // newest seq is the whole of what needs remembering. Filtering the log and
  // then copying it to reverse it was twice 119,000 records per paint.
  const newestClear = next.index.last("work/clear");
  const seenClear = prev?.index.last("work/clear")?.seq ?? -1;
  if (newestClear && newestClear.seq > seenClear) {
    const todo = typeof newestClear.payload.todo === "string" ? newestClear.payload.todo : "todo";
    out.push({ kind: "graph-done", label: `cleared ${todo}` });
  }
  return out;
}

/** Whether a bell may sound at all. Replay draws a recorded past — its
 * transitions happened hours ago and ringing about them is noise. An explicit
 * opt-out wins over everything. */
export function bellAllowed(options: { replay?: boolean; disabled?: boolean }): boolean {
  return options.replay !== true && options.disabled !== true;
}

/** BEL for the terminal plus OSC 9 for desktop notification-capable terminals. */
export function bellSequence(event: BellEvent): string {
  return `\x07\x1b]9;dokkabi: ${event.label}\x07`;
}
