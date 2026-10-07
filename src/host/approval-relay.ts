import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Operator approval for a process that has no operator in front of it.
 *
 * Every approval-gated capability — ssh, MCP, plugin install, GitHub
 * administration — could ask only inside `dokkabi chat`, where the board
 * captures a keystroke. `work`, `turn`, `resume`, and the HEUNG children chat
 * spawns are not interactive, and their answer to every request was an
 * immediate refusal: "use Dokkabi chat or restart with bypass". An unattended
 * campaign therefore either ran in bypass or lost every ssh call.
 *
 * The relay keeps the request in the session directory as a small file and
 * waits for a decision written there by `dokkabi approve`, from any shell,
 * up to a deadline. The file is the whole protocol: no socket, no daemon,
 * nothing a child can forge past the 0700 directory. A missing answer at the
 * deadline is a deny with its own reason, never a silent hang.
 */

export const APPROVAL_TIMEOUT_ENV = "DOKKABI_APPROVAL_TIMEOUT_SECONDS";
export const APPROVAL_RELAY_ENV = "DOKKABI_APPROVAL_RELAY";
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

/**
 * The relay is a property of the process, switched on by the commands that
 * run without an operator (work, turn, resume). A service constructed in a
 * test, or inside chat, keeps the old instant answer. `DOKKABI_APPROVAL_RELAY=off`
 * turns it back off for a process that would rather fail fast.
 */
let relayEnabled = false;

export function enableApprovalRelay(enabled = true): void {
  relayEnabled = enabled;
}

export function approvalRelayEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return relayEnabled && env[APPROVAL_RELAY_ENV]?.trim().toLowerCase() !== "off";
}

export type RelayKind = "ssh" | "mcp" | "plugin" | "github-admin" | "cursor" | "work-contract";
export type RelayDecision = "once" | "session" | "deny";
export type RelayOutcome = RelayDecision | "timeout" | "cancelled";

export interface RelayRecord {
  readonly kind: RelayKind;
  readonly request_id: string;
  readonly summary: string;
  readonly target?: string;
  /** Exact reviewable work patch; capability requests may omit it. */
  readonly details?: string;
  readonly requested_at: string;
  readonly status: "pending" | RelayOutcome;
  readonly decided_at?: string;
}

/** Where a session keeps its relay files: beside its event log. */
export function approvalsDirFor(logPath: string): string {
  return join(dirname(logPath), "approvals");
}

/** How long a non-interactive request waits. 0 restores the instant refusal. */
export function approvalTimeoutMs(env: NodeJS.Dict<string> = process.env): number {
  const raw = env[APPROVAL_TIMEOUT_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_APPROVAL_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) throw new Error(`${APPROVAL_TIMEOUT_ENV} must be a whole number of seconds`);
  return Number(raw) * 1_000;
}

function recordPath(dir: string, requestId: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(requestId)) throw new Error("approval request id is not a safe file name");
  return join(dir, `${requestId}.json`);
}

function writeRecord(dir: string, record: RelayRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = recordPath(dir, record.request_id);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

function readRecord(path: string): RelayRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RelayRecord>;
    if (typeof parsed.request_id !== "string" || typeof parsed.status !== "string") return undefined;
    return parsed as RelayRecord;
  } catch {
    return undefined;
  }
}

/**
 * Park one request and wait for the operator. Resolves with the decision, or
 * `timeout` at the deadline, or `cancelled` if the caller's signal fires.
 * The record is updated in place so a later listing shows what happened.
 */
export async function waitForOperatorDecision(input: {
  readonly logPath: string;
  readonly kind: RelayKind;
  readonly requestId: string;
  readonly summary: string;
  readonly target?: string;
  /** Exact reviewable work patch; capability requests may omit it. */
  readonly details?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}): Promise<RelayOutcome> {
  const dir = approvalsDirFor(input.logPath);
  const timeoutMs = input.timeoutMs ?? approvalTimeoutMs();
  const pollMs = input.pollMs ?? 1_000;
  const record: RelayRecord = {
    kind: input.kind,
    request_id: input.requestId,
    summary: input.summary,
    ...(input.target ? { target: input.target } : {}),
    ...(input.details ? { details: input.details } : {}),
    requested_at: new Date().toISOString(),
    status: "pending",
  };
  if (timeoutMs <= 0) {
    writeRecord(dir, { ...record, status: "timeout", decided_at: record.requested_at });
    return "timeout";
  }
  writeRecord(dir, record);
  const path = recordPath(dir, input.requestId);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (input.signal?.aborted) {
      writeRecord(dir, { ...record, status: "cancelled", decided_at: new Date().toISOString() });
      return "cancelled";
    }
    const current = readRecord(path);
    if (current && current.status !== "pending") {
      return current.status === "once" || current.status === "session" || current.status === "deny"
        ? current.status
        : current.status === "cancelled" ? "cancelled" : "timeout";
    }
    if (Date.now() >= deadline) {
      writeRecord(dir, { ...record, status: "timeout", decided_at: new Date().toISOString() });
      return "timeout";
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      input.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

/** Every request a session has parked, pending first, newest last. */
export function listApprovals(sessionDir: string): RelayRecord[] {
  const dir = join(sessionDir, "approvals");
  if (!existsSync(dir)) return [];
  const records: RelayRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readRecord(join(dir, name));
    if (record) records.push(record);
  }
  return records.sort((a, b) =>
    (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1)
    || a.requested_at.localeCompare(b.requested_at));
}

/** Answer one pending request. Returns the record as written, or undefined when there is nothing pending by that id. */
export function decideApproval(sessionDir: string, requestId: string, decision: RelayDecision): RelayRecord | undefined {
  const dir = join(sessionDir, "approvals");
  const current = readRecord(recordPath(dir, requestId));
  if (!current || current.status !== "pending") return undefined;
  const decided: RelayRecord = { ...current, status: decision, decided_at: new Date().toISOString() };
  writeRecord(dir, decided);
  return decided;
}

export function parseRelayDecision(raw: string | undefined): RelayDecision {
  const value = raw?.trim().toLowerCase();
  if (value === "once" || value === "session" || value === "deny") return value;
  throw new Error("decision must be once, session, or deny");
}
