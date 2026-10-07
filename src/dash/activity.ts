import { containsPrivateInfrastructure, containsSecret } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";
import type { DashProjection } from "./project.ts";
import { isSafeSshTarget, type PendingSshApproval } from "./ssh-approval.ts";
import type { PendingGithubAdminApproval } from "./github-admin-approval.ts";
import type { PendingMcpApproval } from "./mcp-approval.ts";
import type { PendingManagedPluginApproval } from "./managed-plugin-approval.ts";
import { pendingOperatorApproval, approvalEventsOf } from "./operator-approval.ts";

export type CurrentActivity =
  | { kind: "ssh-approval"; approval: PendingSshApproval; elapsedMs: number }
  | { kind: "github-admin-approval"; approval: PendingGithubAdminApproval; elapsedMs: number }
  | { kind: "mcp-approval"; approval: PendingMcpApproval; elapsedMs: number }
  | { kind: "plugin-install-approval"; approval: PendingManagedPluginApproval; elapsedMs: number }
  | { kind: "model-retry"; attempt: number | "missing"; reason: string; remainingMs: number }
  | { kind: "tool-loop"; tool: string; calls: number; limit: number; decision: string }
  | { kind: "ssh"; target: string; elapsedMs: number; timeoutMs: number }
  | { kind: "tool"; name: string; elapsedMs: number }
  | { kind: "ssh-wait"; target: string; elapsedMs: number; remainingMs: number; attempt: number }
  | { kind: "generating"; elapsedMs: number; contextTokens?: number }
  | { kind: "compacting"; elapsedMs: number }
  | { kind: "verifying"; elapsedMs: number }
  | { kind: "planning"; pass: number | "missing"; maxPasses: number | "missing"; role: string }
  | { kind: "review"; target: string; number: number; status: string }
  | { kind: "agent"; status: string; reason?: string };

/**
 * Select exactly one current activity from recorded facts plus an injected
 * observer clock. Priority follows operator urgency, not event recency.
 */
export function currentActivity(view: DashProjection, now: number): CurrentActivity {
  const pending = pendingOperatorApproval(approvalEventsOf(view));
  if (pending?.kind === "ssh") {
    return {
      kind: "ssh-approval",
      approval: pending.approval,
      elapsedMs: elapsedSince(pending.approval.requestedAt, now),
    };
  }
  if (pending?.kind === "github-admin") {
    return {
      kind: "github-admin-approval",
      approval: pending.approval,
      elapsedMs: elapsedSince(pending.approval.requestedAt, now),
    };
  }
  if (pending?.kind === "mcp") {
    return {
      kind: "mcp-approval",
      approval: pending.approval,
      elapsedMs: elapsedSince(pending.approval.requestedAt, now),
    };
  }
  if (pending?.kind === "plugin-install") {
    return {
      kind: "plugin-install-approval",
      approval: pending.approval,
      elapsedMs: elapsedSince(pending.approval.requestedAt, now),
    };
  }

  const retry = activeRetry(view.events, now);
  if (retry) return retry;

  const toolLoop = activeToolLoop(view.events);
  if (toolLoop) return toolLoop;

  // Their own names, from the last turn boundary. Merging the boundary names
  // in meant merging `agent/step`, which is one of the biggest buckets a
  // session has -- tens of thousands of records rebuilt per paint to find a
  // call that started seconds ago. The boundary is a seq; the scan is the
  // handful of records after it.
  const ssh = activeSsh(sinceTurn(view, "ssh/exec", "ssh/result"), now);
  if (ssh) return ssh;

  // A wait is not an outstanding exec. `ssh op=wait` polls -- exec, result,
  // exec, result -- so at any instant nothing is in flight and the ssh branch
  // above finds nothing, leaving the generic tool branch to say
  // "limit unknown" about a call that knows exactly how long it has left.
  // The wait records it: elapsed and remaining, every poll.
  const waiting = activeSshWait(view, now);
  if (waiting) return waiting;

  const tool = activeTool(sinceTurn(view, "tool/start", "tool/end"), now);
  if (tool) return tool;

  const draft = findLast(view.events, event => event.name === "work/plan_draft");
  if (draft && !view.events.some(event => event.name === "work/plan_draft_result" && event.payload.draft_seq === draft.seq)
    && !view.events.some(event => event.name === "work/goal" && event.seq > draft.seq)) {
    return { kind: "planning", pass: "missing", maxPasses: "missing", role: "Native plan preparation" };
  }

  if (view.work.generating !== "missing") {
    const turnStart = findLast(view.events, (event) =>
      event.name === "agent/step" && event.payload.phase === "turn_start"
    );
    const recordedMs = view.work.generating.elapsed_s * 1_000;
    const elapsedMs = turnStart ? Math.max(recordedMs, elapsedSince(turnStart.ts, now)) : recordedMs;
    return {
      kind: "generating",
      elapsedMs,
      ...(typeof view.usage?.context_used === "number" ? { contextTokens: view.usage.context_used } : {}),
    };
  }

  if (view.compactionActive === "yes" || view.work.agentStatus === "compacting") {
    const started = findLast(view.events, (event) =>
      event.name === "compaction/start"
      || (event.name === "agent/status" && event.payload.status === "compacting")
    );
    return { kind: "compacting", elapsedMs: started ? elapsedSince(started.ts, now) : 0 };
  }

  const verify = activeVerification(view.events);
  if (verify) {
    return { kind: "verifying", elapsedMs: elapsedSince(verify.ts, now) };
  }

  if (view.work.ralphPlan !== "missing" &&
      (view.work.ralphPlan.status === "planning" || view.work.ralphPlan.status === "reviewing" || view.work.ralphPlan.status === "revising")) {
    return {
      kind: "planning",
      pass: view.work.ralphPlan.pass,
      maxPasses: view.work.ralphPlan.maxPasses,
      role: view.work.ralphPlan.role === "missing" ? "planner" : view.work.ralphPlan.role,
    };
  }

  const finished = findLast(view.events, event => event.name === "review/finished");
  const begin = findLast(view.events, event => event.name === "review/begin");
  const latestCase = findLast(view.events, event => event.name === "review/case");
  if (finished && begin && finished.payload.begin_seq===begin.seq && (!latestCase||latestCase.seq<finished.seq) && ["idle","done","missing"].includes(view.work.agentStatus)) {
    const task=findLast(view.events,event=>event.name==="review/task"&&event.payload.begin_seq===begin.seq);
    const report=findLast(view.events,event=>event.name==="review/report_result"&&event.payload.finish_ref===finished.seq&&event.payload.status==="completed");
    if(task?.payload.report_path&&!report)return {kind:"review",target:safeReviewRepository(begin.payload.target)??"unknown",number:Number(begin.payload.number),status:"incomplete report"};
    const reportOnly=finished.payload.formal_state==="not_requested"||(finished.payload.formal_state===undefined&&task?.payload.publish_review===false);
    const delivery=reportOnly?`recommendation ${String(finished.payload.verdict)}`:String(finished.payload.formal_state??"verified task");
    return {kind:"review",target:safeReviewRepository(begin.payload.target)??"unknown",number:Number(begin.payload.number),status:`completed ${delivery}`};
  }
  const assessment = findLast(view.events, event => event.name === "review/check");
  const changed = findLast(view.events, event => ["review/begin", "review/case"].includes(event.name));
  if (assessment && (!changed || assessment.seq > changed.seq) && ["idle", "done", "missing"].includes(view.work.agentStatus)) {
    return { kind: "review", target: safeReviewRepository(assessment.payload.target) ?? "unknown", number: Number(assessment.payload.number), status: assessment.payload.status === "ready" ? "ready" : "incomplete" };
  }
  const lastAgentStatus = findLast(view.events, (event) => event.name === "agent/status");
  const reason = safeToken(lastAgentStatus?.payload.error);
  return {
    kind: "agent",
    status: safeStatus(view.work.agentStatus),
    ...(reason ? { reason } : {}),
  };
}

/** Stable English text for the one-row live input surface. */
/**
 * How long a turn may go quiet before the counter is reported as silence.
 *
 * Generous on purpose. A live run's longest model turn was 195s and its remote
 * cases ran for twenty minutes, so anything tighter would cry wolf at ordinary
 * work. What this catches is the hour-long climb of a run nobody is driving.
 */
export const ACTIVITY_SILENT_AFTER_MS = 300_000;

/**
 * When an in-flight activity has gone quiet past the threshold, what it was
 * last seen doing. Undefined for anything else — an approval waiting on a
 * person is not silence, and its counter means what it says.
 */
function silentInFlight(activity: CurrentActivity): string | undefined {
  switch (activity.kind) {
    case "generating":
      return activity.elapsedMs >= ACTIVITY_SILENT_AFTER_MS ? "the model was asked" : undefined;
    case "tool":
      return activity.elapsedMs >= ACTIVITY_SILENT_AFTER_MS ? `${activity.name} started` : undefined;
    case "ssh":
      return activity.elapsedMs >= ACTIVITY_SILENT_AFTER_MS
        ? `ssh ${activity.target} started` : undefined;
    case "compacting":
      return activity.elapsedMs >= ACTIVITY_SILENT_AFTER_MS ? "compaction started" : undefined;
    case "verifying":
      return activity.elapsedMs >= ACTIVITY_SILENT_AFTER_MS ? "verify started" : undefined;
    default:
      return undefined;
  }
}

export function currentActivityText(activity: CurrentActivity): string {
  if (activity.kind === "ssh-approval") {
    return `◆ SSH approval target=${activity.approval.target} · waiting ${approvalAge(activity.elapsedMs)} — /ssh approve once | /ssh approve session | /ssh deny`;
  }
  if (activity.kind === "github-admin-approval") {
    if (activity.approval.operation === "repo_push") {
      const authority = activity.approval.authorizeRepository ? "repository authorization + " : "";
      return `◆ GitHub ${authority}push repo=${activity.approval.repo} branch=${activity.approval.branch ?? "unavailable"} commits=${activity.approval.commitCount ?? 0} · waiting ${approvalAge(activity.elapsedMs)} — /github-admin approve once | /github-admin deny`;
    }
    if (activity.approval.operation === "repo_publish") {
      const authority = activity.approval.authorizeRepository ? "repository authorization + " : "";
      return `◆ GitHub ${authority}publish repo=${activity.approval.repo} source=${activity.approval.sourcePath ?? "unavailable"} · waiting ${approvalAge(activity.elapsedMs)} — /github-admin approve once | /github-admin deny`;
    }
    if (activity.approval.authorizeOwner) {
      return `◆ GitHub owner authorization owner=${activity.approval.owner ?? "unavailable"} repo=${activity.approval.repo} visibility=private · waiting ${approvalAge(activity.elapsedMs)} — /github-admin approve once | /github-admin deny`;
    }
    return `◆ GitHub approval repo=${activity.approval.repo} visibility=private · waiting ${approvalAge(activity.elapsedMs)} — /github-admin approve once | /github-admin deny`;
  }
  if (activity.kind === "mcp-approval") {
    return activity.approval.operation === "server_enroll"
      ? `◆ MCP enrollment server=${activity.approval.server} command=${activity.approval.command ?? "unavailable"} · waiting ${approvalAge(activity.elapsedMs)} — /mcp approve once | /mcp deny`
      : `◆ MCP tool approval server=${activity.approval.server} tool=${activity.approval.tool ?? "unavailable"} · waiting ${approvalAge(activity.elapsedMs)} — /mcp approve once | /mcp approve session | /mcp deny`;
  }
  if (activity.kind === "plugin-install-approval") {
    return `◆ Plugin install id=${activity.approval.id} repo=${activity.approval.repository} · waiting ${approvalAge(activity.elapsedMs)} — /plugin approve once | /plugin deny`;
  }
  if (activity.kind === "model-retry") {
    const attempt = activity.attempt === "missing" ? "?" : String(activity.attempt);
    return `⚙ model retry attempt=${attempt} — ${activity.reason} · resumes in ${countdownSeconds(activity.remainingMs)}`;
  }
  if (activity.kind === "tool-loop") {
    if (activity.decision === "terminate") {
      return `✖ ${activity.tool} tool loop stopped ${activity.calls}/${activity.limit} — tool_loop`;
    }
    return `⚠ ${activity.tool} repeated ${activity.calls}/${activity.limit} — exact call loop approaching`;
  }
  // A run that has stopped and a run that is thinking look identical here,
  // and the dead one looks BUSIER: the counter is time since the last event,
  // so it climbs forever once the process is gone. A live screen read
  // "⚙ model generating … 139s" beside its own "last +2m" for a run that had
  // already crashed — the same fact, stated twice, in opposite directions.
  //
  // Past the threshold the line says what the number actually measures. It
  // does not claim the run is dead: a model turn can honestly think for
  // minutes and a remote case for longer. Silence is what it reports, and
  // silence is what it is.
  const silentSince = silentInFlight(activity);
  if (silentSince !== undefined) {
    const quiet = "elapsedMs" in activity ? seconds(activity.elapsedMs) : "?";
    return `● silent ${quiet} — no events since ${silentSince}. `
      + `That number is silence, not progress; check the process is alive`;
  }
  if (activity.kind === "ssh") {
    return `⚙ ssh ${activity.target} running … ${seconds(activity.elapsedMs)} / ${seconds(activity.timeoutMs)}`;
  }
  if (activity.kind === "ssh-wait") {
    return `⚙ ssh ${activity.target} waiting #${activity.attempt} … `
      + `${seconds(activity.elapsedMs)} elapsed · ${seconds(activity.remainingMs)} left`;
  }
  if (activity.kind === "tool") {
    return `⚙ ${activity.name} running … ${seconds(activity.elapsedMs)} · limit unknown`;
  }
  if (activity.kind === "generating") {
    const context = activity.contextTokens === undefined ? "" : ` · ctx ${compact(activity.contextTokens)}`;
    return `⚙ model generating … ${seconds(activity.elapsedMs)}${context}`;
  }
  if (activity.kind === "compacting") {
    return `⚙ compacting context … ${seconds(activity.elapsedMs)}`;
  }
  if (activity.kind === "verifying") {
    return `⚙ verifying … ${seconds(activity.elapsedMs)}`;
  }
  if (activity.kind === "planning") {
    const pass = activity.pass === "missing" ? "?" : activity.pass;
    const max = activity.maxPasses === "missing" ? "?" : activity.maxPasses;
    return `⚙ Ralph Plan ${pass}/${max} · ${activity.role}`;
  }
  if (activity.kind === "review") return `Review ${activity.target} #${activity.number}: assessment ${activity.status}`;
  if (activity.status === "idle") return "· idle";
  if (activity.status === "failed" || activity.status === "error") {
    return `✖ ${activity.status}${activity.reason ? ` — ${activity.reason}` : ""}`;
  }
  if (activity.status === "missing") return "· status unavailable";
  if (activity.status === "waiting_tool") return "⚙ waiting for tool";
  return `⚙ ${activity.status.replaceAll("_", " ")}`;
}

function activeRetry(events: readonly EventRecord[], now: number): CurrentActivity | undefined {
  const event = findLast(events, (candidate) => candidate.name === "model/retry");
  if (!event) return undefined;
  const delay = finiteNonNegative(event.payload.delay_ms);
  if (delay === undefined || delay === 0) return undefined;
  const remainingMs = delay - elapsedSince(event.ts, now);
  if (remainingMs <= 0) return undefined;
  const reason = safeToken(event.payload.reason_class) ?? safeToken(event.payload.reason) ?? "retryable_failure";
  const attempt = finiteNonNegative(event.payload.attempt);
  return {
    kind: "model-retry",
    attempt: attempt === undefined ? "missing" : Math.floor(attempt),
    reason,
    remainingMs,
  };
}

function activeToolLoop(events: readonly EventRecord[]): CurrentActivity | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name === "user/message") return undefined;
    if (
      event.name === "agent/status"
      && (event.payload.status === "idle" || event.payload.status === "failed" || event.payload.status === "error")
    ) return undefined;
    if (event.name !== "tool/loop") continue;
    if (event.payload.decision === "reset") return undefined;
    const calls = finiteNonNegative(event.payload.calls);
    const decision = safeToolLoopDecision(event.payload.decision);
    if (calls === undefined || calls < 2 || calls > 6 || decision === undefined) return undefined;
    return {
      kind: "tool-loop",
      tool: safeToolName(event.payload.tool),
      calls: Math.floor(calls),
      limit: 6,
      decision,
    };
  }
  return undefined;
}

function activeSsh(events: readonly EventRecord[], now: number): CurrentActivity | undefined {
  const active = new Map<string, EventRecord>();
  for (const event of events) {
    if (isTurnBoundary(event)) {
      active.clear();
      continue;
    }
    const target = event.payload.target;
    if (!isSafeSshTarget(target)) continue;
    if (event.name === "ssh/exec") active.set(target, event);
    if (event.name === "ssh/result") active.delete(target);
  }
  const event = [...active.values()].at(-1);
  if (!event) return undefined;
  const timeoutSeconds = finiteNonNegative(event.payload.timeout_seconds);
  if (timeoutSeconds === undefined || timeoutSeconds <= 0) return undefined;
  return {
    kind: "ssh",
    target: event.payload.target as string,
    elapsedMs: elapsedSince(event.ts, now),
    timeoutMs: timeoutSeconds * 1_000,
  };
}

function activeTool(events: readonly EventRecord[], now: number): CurrentActivity | undefined {
  const active = new Map<string, EventRecord>();
  for (const event of events) {
    if (isTurnBoundary(event)) {
      active.clear();
      continue;
    }
    if (event.name !== "tool/start" && event.name !== "tool/end") continue;
    const name = safeToolName(event.payload.name);
    const key = typeof event.payload.id === "string" && event.payload.id.length > 0
      ? event.payload.id
      : name;
    if (event.name === "tool/start") active.set(key, event);
    if (event.name === "tool/end") active.delete(key);
  }
  const event = [...active.values()].at(-1);
  if (!event) return undefined;
  return {
    kind: "tool",
    name: safeToolName(event.payload.name),
    elapsedMs: elapsedSince(event.ts, now),
  };
}

/**
 * An aborted or crashed turn never records the matching end event for a
 * command it started, so an unmatched start must not outlive its turn: any
 * terminal agent status or a later turn_start proves the command is gone.
 */
/**
 * The named records since the turn began.
 *
 * `activeSsh` and `activeTool` clear their in-flight map at a turn boundary,
 * so everything before the newest boundary is dead weight: find the boundary's
 * seq from the two small buckets that carry one, then take only what follows.
 */
function lastTurnBoundarySeq(view: DashProjection): number {
  let seq = -1;
  for (const event of view.index.of("agent/status")) {
    if (isTurnBoundary(event) && event.seq > seq) seq = event.seq;
  }
  for (const event of view.index.of("agent/step")) {
    if (isTurnBoundary(event) && event.seq > seq) seq = event.seq;
  }
  return seq;
}

const TURN_START = new WeakMap<DashProjection, number>();

function sinceTurn(view: DashProjection, ...names: readonly string[]): readonly EventRecord[] {
  let boundary = TURN_START.get(view);
  if (boundary === undefined) {
    boundary = lastTurnBoundarySeq(view);
    TURN_START.set(view, boundary);
  }
  const at = boundary;
  return view.index.ofAny(...names).filter((event) => event.seq > at);
}

/**
 * The `ssh op=wait` in flight, from its own progress record.
 *
 * A wait that has finished is followed by the tool's end, so the tool call
 * still being open is what makes the newest progress record current.
 */
function activeSshWait(view: DashProjection, now: number): CurrentActivity | undefined {
  const progress = view.index.of("ssh/wait_progress").at(-1);
  if (!progress) return undefined;
  const ended = view.index.of("tool/end").at(-1);
  if (ended && ended.seq > progress.seq) return undefined;
  const target = progress.payload.target;
  if (!isSafeSshTarget(target)) return undefined;
  const elapsed = finiteNonNegative(progress.payload.elapsed_ms);
  const remaining = finiteNonNegative(progress.payload.remaining_ms);
  if (elapsed === undefined || remaining === undefined) return undefined;
  const attempt = finiteNonNegative(progress.payload.attempt) ?? 0;
  // The record is as old as the last poll; the clock has moved since.
  const since = elapsedSince(progress.ts, now);
  return {
    kind: "ssh-wait",
    target: target as string,
    elapsedMs: elapsed + since,
    remainingMs: Math.max(0, remaining - since),
    attempt,
  };
}

function isTurnBoundary(event: EventRecord): boolean {
  if (event.name === "agent/status") {
    const status = event.payload.status;
    return status === "idle" || status === "failed" || status === "error" || status === "cancelled";
  }
  return event.name === "agent/step" && event.payload.phase === "turn_start";
}

function activeVerification(events: readonly EventRecord[]): EventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.name === "work/step" && event.payload.action === "verify") return undefined;
    if (event.name === "work/verify" && event.payload.phase === "start") return event;
  }
  return undefined;
}

function elapsedSince(timestamp: string, now: number): number {
  const start = Date.parse(timestamp);
  return Number.isNaN(start) || !Number.isFinite(now) ? 0 : Math.max(0, now - start);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeReviewRepository(value:unknown):string|undefined {
 return typeof value==="string"&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)&&!value.split("/").some(p=>p==="."||p==="..")&&!containsSecret(value)&&!containsPrivateInfrastructure(value)?value:undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value)
    && !containsSecret(value) && !containsPrivateInfrastructure(value)
    ? value
    : undefined;
}

function safeToolName(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,63}$/iu.test(value)
    && !containsSecret(value) && !containsPrivateInfrastructure(value)
    ? value
    : "tool";
}

function safeToolLoopDecision(value: unknown): "approaching" | "warn" | "terminate" | undefined {
  return value === "approaching" || value === "warn" || value === "terminate" ? value : undefined;
}

function safeStatus(value: unknown): string {
  return safeToken(value) ?? "missing";
}

function seconds(ms: number): string {
  return `${Math.floor(Math.max(0, ms) / 1_000)}s`;
}

function countdownSeconds(ms: number): string {
  return `${Math.ceil(Math.max(0, ms) / 1_000)}s`;
}

function approvalAge(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

function compact(value: number): string {
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function findLast(
  events: readonly EventRecord[],
  predicate: (event: EventRecord) => boolean,
): EventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (predicate(event)) return event;
  }
  return undefined;
}
