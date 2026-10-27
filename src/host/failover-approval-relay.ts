import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { selectionKey, type FailoverCandidateStatusV1, type ModelRouteSelection } from "./model-failover.ts";

/** Durable operator decision for `failover ask` when the waiting turn exits. */
export type FailoverApprovalStatus = "pending" | "approved" | "rejected";

export interface FailoverApprovalRecord {
  readonly request_id: string;
  readonly status: FailoverApprovalStatus;
  readonly current: ModelRouteSelection;
  readonly candidates: readonly FailoverCandidateStatusV1[];
  readonly policy_digest: string;
  readonly generation: number;
  readonly continuity: "continue" | "checkpoint";
  readonly turn_id: string;
  readonly requested_at: string;
  readonly approved?: ModelRouteSelection;
  readonly decided_at?: string;
}

export function failoverApprovalsDirFor(logPath: string): string {
  return join(dirname(logPath), "failover-approvals");
}

function recordPath(dir: string, requestId: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(requestId)) throw new Error("failover approval request id is not a safe file name");
  return join(dir, `${requestId}.json`);
}

function writeRecord(dir: string, record: FailoverApprovalRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = recordPath(dir, record.request_id);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

function readRecord(path: string): FailoverApprovalRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FailoverApprovalRecord>;
    if (typeof parsed.request_id !== "string" || typeof parsed.status !== "string") return undefined;
    return parsed as FailoverApprovalRecord;
  } catch {
    return undefined;
  }
}

export function writePendingFailoverApproval(logPath: string, record: Omit<FailoverApprovalRecord, "status" | "requested_at"> & { requested_at?: string }): FailoverApprovalRecord {
  const pending: FailoverApprovalRecord = {
    ...record,
    status: "pending",
    requested_at: record.requested_at ?? new Date().toISOString(),
  };
  writeRecord(failoverApprovalsDirFor(logPath), pending);
  return pending;
}

export function readFailoverApproval(logPath: string, requestId: string): FailoverApprovalRecord | undefined {
  return readRecord(recordPath(failoverApprovalsDirFor(logPath), requestId));
}

export function failoverApprovalMatchesContext(
  record: FailoverApprovalRecord,
  current: ModelRouteSelection,
  policyDigest: string,
): boolean {
  return record.policy_digest === policyDigest
    && selectionKey(record.current) === selectionKey(current);
}

/** Remove persisted approvals that no longer match the active route or policy. */
export function purgeStaleFailoverApprovals(
  logPath: string,
  current: ModelRouteSelection,
  policyDigest: string,
): void {
  const dir = failoverApprovalsDirFor(logPath);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(join(dir, name));
    if (!record || failoverApprovalMatchesContext(record, current, policyDigest)) continue;
    removeFailoverApprovalRecord(logPath, record.request_id);
  }
}

/** Newest pending approval for one session log, if any. */
export function readPendingFailoverApproval(logPath: string): FailoverApprovalRecord | undefined {
  const dir = failoverApprovalsDirFor(logPath);
  if (!existsSync(dir)) return undefined;
  let newest: FailoverApprovalRecord | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(join(dir, name));
    if (!record || record.status !== "pending") continue;
    if (!newest || record.requested_at.localeCompare(newest.requested_at) > 0) newest = record;
  }
  return newest;
}

/** Session directories under home that still have a pending failover approval. */
export function listSessionsWithPendingFailoverApprovals(home: string): string[] {
  const sessionsRoot = join(home, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  for (const sessionId of readdirSync(sessionsRoot)) {
    const logPath = join(sessionsRoot, sessionId, "events.jsonl");
    if (readPendingFailoverApproval(logPath)) out.push(sessionId);
  }
  return out.sort();
}

export function decideFailoverApproval(
  logPath: string,
  decision: "approve" | "reject",
  choice?: string,
  requestId?: string,
): FailoverApprovalRecord | undefined {
  const pending = requestId
    ? readFailoverApproval(logPath, requestId)
    : readPendingFailoverApproval(logPath);
  if (!pending || pending.status !== "pending") return undefined;
  if (decision === "reject") {
    const decided: FailoverApprovalRecord = {
      ...pending,
      status: "rejected",
      decided_at: new Date().toISOString(),
    };
    writeRecord(failoverApprovalsDirFor(logPath), decided);
    return decided;
  }
  const selected = choice
    ? pending.candidates.find((item) => `${item.route}/${item.model}` === choice)
    : pending.candidates[0];
  if (!selected) throw new Error("choose one of the pending failover candidates");
  const decided: FailoverApprovalRecord = {
    ...pending,
    status: "approved",
    approved: { route: selected.route, model: selected.model },
    decided_at: new Date().toISOString(),
  };
  writeRecord(failoverApprovalsDirFor(logPath), decided);
  return decided;
}

/** Drop one record after it has been applied or invalidated. */
export function removeFailoverApprovalRecord(logPath: string, requestId: string): void {
  const path = recordPath(failoverApprovalsDirFor(logPath), requestId);
  try {
    unlinkSync(path);
  } catch {
    /* absent */
  }
}

/** Newest decided approval or rejection for the session, if any. */
export function readDecidedFailoverApproval(logPath: string): FailoverApprovalRecord | undefined {
  const dir = failoverApprovalsDirFor(logPath);
  if (!existsSync(dir)) return undefined;
  let newest: FailoverApprovalRecord | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(join(dir, name));
    if (!record || record.status === "pending") continue;
    if (!newest || (record.decided_at ?? record.requested_at).localeCompare(newest.decided_at ?? newest.requested_at) > 0) {
      newest = record;
    }
  }
  return newest;
}

export function failoverApprovalHint(sessionId: string): string {
  return `run: dokkabi failover approve --session ${sessionId}  (or: dokkabi failover reject --session ${sessionId})`;
}

export function pendingFailoverApprovalSummary(record: FailoverApprovalRecord): string {
  const candidates = record.candidates.map((item) => `${item.route}/${item.model}`).join(", ");
  return `failover approval ${record.status} current=${record.current.route}/${record.current.model} candidates=${candidates}`;
}
