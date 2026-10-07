/**
 * R8 work-mode usage projection — the pure read behind workbench.usage (v1).
 *
 * One read-only answer to "what did THIS recorded run cost?" across the main
 * session and every child session its own observe rows genuinely reference.
 * The legacy `workbench.overview` usage block stays exactly what it was: the
 * main prefix alone. This operation adds the referenced run scopes without
 * touching the old overview or handshake shapes (old app decoding is strict).
 *
 * Truth rules this module obeys:
 * - A child scope exists ONLY when a genuine owning parent row names it: the
 *   accept-session producers (`work/step` accept/accept_prepare/accept_preflight
 *   announcements, `work/accept` verdicts and evaluator errors) and the closed
 *   design/readiness provenance (`acceptance/design_session`,
 *   `acceptance/readiness` status=ready). There is no global session scan and
 *   no unrelated sibling directory is ever opened.
 * - A child is counted ONLY over the largest parent-PINNED prefix of one
 *   verified hash chain. Producers pin a head hash (log_hash /
 *   verifier_log_hash / spec_log_hash), never a seq; the pin resolves to the
 *   record carrying that hash in the chain-verified child log. Rows beyond
 *   the largest pin are not consumed. Overlapping or duplicate pins count the
 *   child once. A pin that matches no record — a replaced or divergent chain —
 *   is invalid, never silently skipped. A corrupt child chain is invalid. An
 *   evaluator_error child (referenced without any pin) stays visible and
 *   unpinned: partial, not omitted.
 * - Child ids must be safe charset and EXACT owned descendants of this parent
 *   (`<parent>-accept…`); the path helper refuses traversal, symlinks
 *   (including symlinked ancestors), special files and foreign prefixes
 *   before a single file is opened.
 * - Usage metrics measure only finite nonnegative integer tokens; anything
 *   else a row reports (or does not report) is preserved as `missing`, never
 *   turned into zero. Source refs inside a child scope are that child's own
 *   seq/hash; the aggregate carries no source ref because a child seq is
 *   never a main-session seq.
 * - Totals are RECORDED usage, not billing. Reasoning tokens are a labeled
 *   subset of the output total; cache read/write are counted outside the
 *   input total. Request-vs-usage gaps stay explicit even when the scope
 *   closed successfully; zero provider requests with no usage rows means no
 *   observed total (null), not an invented zero.
 * - Read-only by construction: no model, no bind, no kernel boot, no blob
 *   replay (chain + pin verification is sufficient for a usage read), no
 *   session, child or gateway append on any path.
 */

import { lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { EventLog } from "../host/event-log.ts";
import { GENESIS_HASH, type EventRecord } from "../host/schema.ts";

/** Same safe id charset the host uses for session directories. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PIN_HASH = /^[a-f0-9]{64}$/u;
const DETAIL_MAX = 240;

export type WorkbenchUsageState = "complete" | "partial" | "invalid";

export type WorkbenchUsageScopeRole = "spec" | "verifier" | "readiness";

export interface WorkbenchUsageSourceRef {
  readonly seq: number;
  readonly hash: string;
}

export interface WorkbenchUsageMetric {
  /** Sum of measured values, or null when nothing was measured. */
  readonly total: number | null;
  /** Records that exist but do not report a measurable value for this field. */
  readonly missing: number;
  /** Newest record that measured this field, scoped to THIS scope's own log. */
  readonly latestSource: WorkbenchUsageSourceRef | null;
}

export interface WorkbenchUsageRecords {
  readonly records: number;
  readonly input: WorkbenchUsageMetric;
  readonly output: WorkbenchUsageMetric;
  readonly reasoning: WorkbenchUsageMetric;
  readonly cacheRead: WorkbenchUsageMetric;
  readonly cacheWrite: WorkbenchUsageMetric;
}

export interface WorkbenchUsageCounts {
  /** Recorded provider/request rows in the counted prefix. */
  readonly requests: number;
  /** Recorded provider/send rows in the counted prefix. */
  readonly sends: number;
  /** Rows carrying observe.model_usage in the counted prefix. */
  readonly completedUsage: number;
}

/** One parent row that names this child, with the head hash it pinned (the
 * raw recorded pin — resolution against the child chain happens in the read). */
export interface WorkbenchUsageProvenanceRef {
  readonly producer: string;
  readonly field: string;
  readonly ref: WorkbenchUsageSourceRef;
  readonly pinnedHash: string | null;
}

export type WorkbenchChildUsageScopeState = "verified" | "unpinned" | "missing" | "invalid";

export interface WorkbenchChildUsageScope {
  readonly id: string;
  /** Every declared role identity the producers gave this child. */
  readonly roles: readonly WorkbenchUsageScopeRole[];
  readonly state: WorkbenchChildUsageScopeState;
  readonly provenance: readonly WorkbenchUsageProvenanceRef[];
  /** Largest parent-pinned prefix that verified in the child chain. */
  readonly pinnedHead: WorkbenchUsageSourceRef | null;
  /** The child's own current verified head, when its log was readable. */
  readonly head: WorkbenchUsageSourceRef | null;
  readonly counts: WorkbenchUsageCounts | null;
  readonly usage: WorkbenchUsageRecords | null;
  readonly detail: string | null;
}

export interface WorkbenchMainUsageScope {
  readonly sessionId: string;
  readonly head: WorkbenchUsageSourceRef;
  /** False when a recorded turn started and never settled. */
  readonly settled: boolean;
  readonly counts: WorkbenchUsageCounts;
  readonly usage: WorkbenchUsageRecords;
}

export interface WorkbenchUsageTotals {
  readonly total: number | null;
  readonly missing: number;
}

export interface WorkbenchUsageAggregate {
  /** The main scope plus every verified child scope these totals cover. */
  readonly scopesCounted: number;
  readonly counts: WorkbenchUsageCounts;
  readonly input: WorkbenchUsageTotals;
  readonly output: WorkbenchUsageTotals;
  readonly reasoning: WorkbenchUsageTotals;
  readonly cacheRead: WorkbenchUsageTotals;
  readonly cacheWrite: WorkbenchUsageTotals;
}

export interface WorkbenchUsageSemantics {
  readonly totals: "recorded_usage_not_billing";
  readonly reasoning: "included_in_output_total";
  readonly cacheRead: "separate_from_input_total";
  readonly cacheWrite: "separate_from_input_total";
}

export interface WorkbenchUsageReport {
  readonly state: WorkbenchUsageState;
  readonly main: WorkbenchMainUsageScope;
  readonly scopes: readonly WorkbenchChildUsageScope[];
  readonly aggregate: WorkbenchUsageAggregate;
  readonly semantics: WorkbenchUsageSemantics;
  /** Bounded, closed reasons the state is partial (never paths or secrets). */
  readonly details: readonly string[];
  /** Bounded, closed reasons the state is invalid. */
  readonly errors: readonly string[];
}

export interface WorkbenchUsageResponse {
  readonly version: 1;
  readonly sessionCursor: { readonly sessionId: string; readonly seq: number; readonly hash: string; readonly generation: string };
  readonly gatewayCursor: { readonly seq: number; readonly hash: string; readonly generation: string };
  readonly resnapshot: boolean;
  readonly usage: WorkbenchUsageReport;
}

/** What the guarded child opener may answer. Corrupt is NOT missing. */
export type WorkbenchChildLogOpen =
  | { readonly state: "open"; readonly events: readonly EventRecord[] }
  | { readonly state: "missing"; readonly detail: string }
  | { readonly state: "invalid"; readonly detail: string };

/** True only for a safe-charset id that is an exact owned acceptance
 * descendant of this parent (`<parent>-accept…`). The charset already bars
 * separators, absolute spellings and `.`/`..`, so a matching id can never
 * traverse out of the sessions root. */
export function isOwnedAcceptanceChildId(parentSessionId: string, childSessionId: string): boolean {
  if (!SAFE_SESSION_ID.test(parentSessionId) || !SAFE_SESSION_ID.test(childSessionId)) return false;
  if (childSessionId === parentSessionId) return false;
  return childSessionId.startsWith(`${parentSessionId}-accept-`);
}

/**
 * The guarded read-only child-log opener. Refusal order: id safety and
 * ownership FIRST (no filesystem is touched for a forged id), then the
 * session directory must be a real directory (no symlink), the log a regular
 * file (no symlink, no special file), the resolved paths must stay inside the
 * resolved sessions root (symlinked ancestors cannot relocate a child), and
 * only then is the chain-verified read-only EventLog opened. Read-only by
 * construction: this function never writes, creates or boots anything.
 */
export function openChildUsageLog(
  sessionsRoot: string,
  parentSessionId: string,
  childSessionId: string,
): WorkbenchChildLogOpen {
  if (!isOwnedAcceptanceChildId(parentSessionId, childSessionId)) {
    return {
      state: "invalid",
      detail: `session id ${JSON.stringify(childSessionId).slice(0, 80)} is not a safe owned acceptance descendant of this parent`,
    };
  }
  const directory = join(sessionsRoot, childSessionId);
  const logPath = join(directory, "events.jsonl");
  let directoryStat: ReturnType<typeof lstatSync>;
  try {
    directoryStat = lstatSync(directory);
  } catch {
    return { state: "missing", detail: `session ${childSessionId} has no directory under this sessions root` };
  }
  if (directoryStat.isSymbolicLink()) {
    return { state: "invalid", detail: `session directory ${childSessionId} is a symlink` };
  }
  if (!directoryStat.isDirectory()) {
    return { state: "invalid", detail: `session path ${childSessionId} is not a directory` };
  }
  let logStat: ReturnType<typeof lstatSync>;
  try {
    logStat = lstatSync(logPath);
  } catch {
    return { state: "missing", detail: `session ${childSessionId} has no events.jsonl` };
  }
  if (logStat.isSymbolicLink()) {
    return { state: "invalid", detail: `session log ${childSessionId} is a symlink` };
  }
  if (!logStat.isFile()) {
    return { state: "invalid", detail: `session log ${childSessionId} is not a regular file` };
  }
  try {
    const resolvedRoot = realpathSync(sessionsRoot);
    const resolvedDirectory = realpathSync(directory);
    if (resolvedDirectory !== resolvedRoot && !resolvedDirectory.startsWith(resolvedRoot + sep)) {
      return { state: "invalid", detail: `session ${childSessionId} resolves outside the sessions root` };
    }
  } catch {
    return { state: "invalid", detail: "the sessions root cannot be resolved" };
  }
  try {
    const log = new EventLog(logPath, { readOnly: true });
    return { state: "open", events: log.events };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "invalid",
      detail: `session log ${childSessionId} failed chain verification: ${message}`.slice(0, DETAIL_MAX),
    };
  }
}

export interface WorkbenchUsageProjectionInput {
  readonly parentSessionId: string;
  /** The verified main-session prefix the read already validated. */
  readonly parentEvents: readonly EventRecord[];
  /** Guarded read-only opener for referenced child scopes. */
  openChildLog(sessionId: string): WorkbenchChildLogOpen;
  /** Live host signal that the main session is running a turn right now
   * (tracked active command or busy kernel). The recorded unsettled-turn
   * check below still applies on its own. */
  readonly mainLiveActive?: boolean;
}

interface CollectedPin {
  readonly hash: string;
  readonly producer: string;
}

interface CollectedChild {
  readonly id: string;
  readonly roles: Set<WorkbenchUsageScopeRole>;
  readonly provenance: WorkbenchUsageProvenanceRef[];
  readonly pins: CollectedPin[];
}

function headOf(events: readonly EventRecord[]): WorkbenchUsageSourceRef {
  const last = events.at(-1);
  return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH };
}

function isMeasured(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function metricOf(
  records: ReadonlyArray<{ readonly event: EventRecord; readonly value: unknown }>,
): WorkbenchUsageMetric {
  let total = 0;
  let measured = 0;
  let missing = 0;
  let latestSource: WorkbenchUsageSourceRef | null = null;
  for (const { event, value } of records) {
    if (isMeasured(value)) {
      measured += 1;
      total += value;
      latestSource = { seq: event.seq, hash: event.hash };
    } else {
      missing += 1;
    }
  }
  return { total: measured > 0 ? total : null, missing, latestSource };
}

function usageOf(events: readonly EventRecord[]): WorkbenchUsageRecords {
  const input: Array<{ event: EventRecord; value: unknown }> = [];
  const output: Array<{ event: EventRecord; value: unknown }> = [];
  const reasoning: Array<{ event: EventRecord; value: unknown }> = [];
  const cacheRead: Array<{ event: EventRecord; value: unknown }> = [];
  const cacheWrite: Array<{ event: EventRecord; value: unknown }> = [];
  let records = 0;
  for (const event of events) {
    if (event.kind !== "observe") continue;
    const usage = event.observe?.model_usage;
    if (usage === undefined) continue;
    records += 1;
    input.push({ event, value: usage.input_tokens });
    output.push({ event, value: usage.output_tokens });
    reasoning.push({ event, value: usage.reasoning_tokens });
    cacheRead.push({ event, value: usage.cache_read_tokens });
    cacheWrite.push({ event, value: usage.cache_write_tokens });
  }
  return {
    records,
    input: metricOf(input),
    output: metricOf(output),
    reasoning: metricOf(reasoning),
    cacheRead: metricOf(cacheRead),
    cacheWrite: metricOf(cacheWrite),
  };
}

function countsOf(events: readonly EventRecord[]): WorkbenchUsageCounts {
  let requests = 0;
  let sends = 0;
  let completedUsage = 0;
  for (const event of events) {
    if (event.kind !== "observe") continue;
    if (event.name === "provider/request") requests += 1;
    else if (event.name === "provider/send") sends += 1;
    else if (event.observe?.model_usage !== undefined) completedUsage += 1;
  }
  return { requests, sends, completedUsage };
}

/** Commands whose recorded turn started but never settled — the honest
 * "main is active/unsettled" signal, from the session's own rows. */
function unsettledCommandIds(events: readonly EventRecord[]): string[] {
  const started = new Map<string, number>();
  const settled = new Set<string>();
  for (const event of events) {
    if (event.kind !== "observe") continue;
    const payload = event.payload as Record<string, unknown>;
    if (event.name === "chat/turn_started" && typeof payload.command_id === "string") {
      if (!started.has(payload.command_id)) started.set(payload.command_id, event.seq);
    } else if (event.name === "chat/turn_settled" && typeof payload.command_id === "string") {
      settled.add(payload.command_id);
    }
  }
  return [...started.entries()].filter(([commandId]) => !settled.has(commandId)).map(([commandId]) => commandId);
}

/**
 * Project the scoped usage report. Pure over the given inputs: every effect
 * (the guarded child opens) happens through `openChildLog`, and nothing here
 * appends, boots or replays blobs.
 */
export function projectWorkbenchUsage(input: WorkbenchUsageProjectionInput): WorkbenchUsageReport {
  const details: string[] = [];
  const errors: string[] = [];
  const children = new Map<string, CollectedChild>();
  const order: string[] = [];

  const reference = (
    id: unknown,
    role: WorkbenchUsageScopeRole,
    field: string,
    producer: string,
    event: EventRecord,
    pinnedHash: unknown,
  ): void => {
    if (typeof id !== "string" || id.length === 0) return;
    if (id === input.parentSessionId) {
      // A row naming the main session as a child never double-counts it.
      details.push(`row at seq ${event.seq} names the main session as a child; the main scope is counted once`);
      return;
    }
    let child = children.get(id);
    if (child === undefined) {
      child = { id, roles: new Set(), provenance: [], pins: [] };
      children.set(id, child);
      order.push(id);
    }
    child.roles.add(role);
    const pin = typeof pinnedHash === "string" && PIN_HASH.test(pinnedHash) ? pinnedHash : null;
    child.provenance.push({
      producer,
      field,
      ref: { seq: event.seq, hash: event.hash },
      pinnedHash: pin,
    });
    if (pin !== null) child.pins.push({ hash: pin, producer });
  };

  for (const event of input.parentEvents) {
    if (event.kind !== "observe") continue;
    const payload = event.payload as Record<string, unknown>;
    if (event.name === "work/step") {
      const action = payload.action;
      if (action === "accept") {
        reference(payload.verifier_session, "verifier", "verifier_session", "work/step:accept", event, undefined);
        reference(payload.spec_session, "spec", "spec_session", "work/step:accept", event, undefined);
      } else if (action === "accept_prepare") {
        reference(payload.verifier_session, "spec", "verifier_session", "work/step:accept_prepare", event, undefined);
      } else if (action === "accept_preflight") {
        reference(payload.verifier_session, "readiness", "verifier_session", "work/step:accept_preflight", event, undefined);
      }
      continue;
    }
    if (event.name === "acceptance/design_session") {
      reference(payload.session, "spec", "session", "acceptance/design_session", event, payload.log_hash);
      continue;
    }
    if (event.name === "acceptance/readiness" && payload.status === "ready") {
      reference(payload.verifier_session, "readiness", "verifier_session", "acceptance/readiness:ready", event, payload.verifier_log_hash);
      continue;
    }
    if (event.name === "work/accept") {
      // Every decision reaches here, including evaluator_error — a child an
      // evaluator failed on stays referenced (unpinned), never dropped.
      reference(payload.verifier_session, "verifier", "verifier_session", "work/accept", event, payload.verifier_log_hash);
      reference(payload.spec_session, "spec", "spec_session", "work/accept", event, payload.spec_log_hash);
    }
  }

  const scopes: WorkbenchChildUsageScope[] = order.map((id) => {
    const child = children.get(id)!;
    const roles: WorkbenchUsageScopeRole[] = [];
    for (const role of ["spec", "verifier", "readiness"] as const) {
      if (child.roles.has(role)) roles.push(role);
    }
    const opened = input.openChildLog(id);
    if (opened.state === "missing") {
      details.push(`child session ${id} is referenced but missing: ${opened.detail}`.slice(0, DETAIL_MAX));
      return {
        id,
        roles,
        state: "missing" as const,
        provenance: child.provenance,
        pinnedHead: null,
        head: null,
        counts: null,
        usage: null,
        detail: opened.detail,
      };
    }
    if (opened.state === "invalid") {
      errors.push(`child session ${id} is invalid: ${opened.detail}`.slice(0, DETAIL_MAX));
      return {
        id,
        roles,
        state: "invalid" as const,
        provenance: child.provenance,
        pinnedHead: null,
        head: null,
        counts: null,
        usage: null,
        detail: opened.detail,
      };
    }
    const events = opened.events;
    const head = headOf(events);
    if (child.pins.length === 0) {
      // Referenced (announced or failed) but no closed producer row ever
      // pinned a prefix: its tokens are unknown, not zero, not counted.
      details.push(`child session ${id} is referenced but unpinned — no closed producer prefix certifies any usage`);
      return {
        id,
        roles,
        state: "unpinned" as const,
        provenance: child.provenance,
        pinnedHead: null,
        head,
        counts: null,
        usage: null,
        detail: "referenced without a pinned closed prefix",
      };
    }
    // Resolve every pin against the verified chain. All pins of one verified
    // chain are prefixes of that chain by construction; a pin matching no
    // record means the log was replaced or diverged — invalid, and later
    // pins are not silently preferred.
    const seqByHash = new Map<string, number>();
    for (const event of events) {
      seqByHash.set(event.hash, event.seq);
    }
    let pinnedHead: WorkbenchUsageSourceRef | null = null;
    let pinMismatch = false;
    for (const pin of child.pins) {
      const seq = seqByHash.get(pin.hash);
      if (seq === undefined) {
        pinMismatch = true;
        errors.push(
          `the ${pin.producer} pin for child session ${id} matches no record in its verified chain — the log was replaced or diverged`,
        );
      } else if (pinnedHead === null || seq > pinnedHead.seq) {
        pinnedHead = { seq, hash: pin.hash };
      }
    }
    if (pinMismatch || pinnedHead === null) {
      return {
        id,
        roles,
        state: "invalid" as const,
        provenance: child.provenance,
        pinnedHead: null,
        head,
        counts: null,
        usage: null,
        detail: "a recorded pin does not resolve in the child's verified chain",
      };
    }
    const prefix = events.filter((event) => event.seq <= pinnedHead!.seq);
    const counts = countsOf(prefix);
    if (head.seq > pinnedHead.seq) {
      details.push(
        `child session ${id} extends ${head.seq - pinnedHead.seq} row(s) beyond its largest pinned prefix ${pinnedHead.seq} — those rows are not consumed`,
      );
    }
    if (counts.requests !== counts.completedUsage) {
      details.push(
        `scope ${id} recorded ${counts.requests} provider request(s) but ${counts.completedUsage} completed usage row(s) — the difference is unknown, not zero`,
      );
    }
    return {
      id,
      roles,
      state: "verified" as const,
      provenance: child.provenance,
      pinnedHead,
      head,
      counts,
      usage: usageOf(prefix),
      detail: null,
    };
  });

  const mainCounts = countsOf(input.parentEvents);
  if (mainCounts.requests !== mainCounts.completedUsage) {
    details.push(
      `the main session recorded ${mainCounts.requests} provider request(s) but ${mainCounts.completedUsage} completed usage row(s) — the difference is unknown, not zero`,
    );
  }
  const unsettled = unsettledCommandIds(input.parentEvents);
  for (const commandId of unsettled) {
    details.push(`the main session has an unsettled recorded turn (command ${commandId})`);
  }
  if (input.mainLiveActive === true) {
    details.push("the main session is running a turn right now — its final usage is not recorded yet");
  }
  const main: WorkbenchMainUsageScope = {
    sessionId: input.parentSessionId,
    head: headOf(input.parentEvents),
    settled: unsettled.length === 0 && input.mainLiveActive !== true,
    counts: mainCounts,
    usage: usageOf(input.parentEvents),
  };

  const counted = [main, ...scopes.filter((scope) => scope.state === "verified" && scope.usage !== null)];
  const totalsOf = (
    pick: (records: WorkbenchUsageRecords) => WorkbenchUsageMetric,
  ): WorkbenchUsageTotals => {
    let total = 0;
    let measured = 0;
    let missing = 0;
    for (const scope of counted) {
      const metric = pick(scope.usage!);
      if (metric.total !== null) {
        measured += 1;
        total += metric.total;
      }
      missing += metric.missing;
    }
    return { total: measured > 0 ? total : null, missing };
  };
  const aggregateCounts = (field: keyof WorkbenchUsageCounts): number =>
    counted.reduce((sum, scope) => sum + scope.counts![field], 0);
  const aggregate: WorkbenchUsageAggregate = {
    scopesCounted: counted.length,
    counts: {
      requests: aggregateCounts("requests"),
      sends: aggregateCounts("sends"),
      completedUsage: aggregateCounts("completedUsage"),
    },
    input: totalsOf((records) => records.input),
    output: totalsOf((records) => records.output),
    reasoning: totalsOf((records) => records.reasoning),
    cacheRead: totalsOf((records) => records.cacheRead),
    cacheWrite: totalsOf((records) => records.cacheWrite),
  };

  return {
    state: errors.length > 0 ? "invalid" : details.length > 0 ? "partial" : "complete",
    main,
    scopes,
    aggregate,
    semantics: {
      totals: "recorded_usage_not_billing",
      reasoning: "included_in_output_total",
      cacheRead: "separate_from_input_total",
      cacheWrite: "separate_from_input_total",
    },
    details,
    errors,
  };
}
