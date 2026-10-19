import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BlobStore } from "../host/blob-store.ts";
import type { EventLog } from "../host/event-log.ts";
import type { InputReference } from "../host/provider-input.ts";
import {
  dokkabiHome,
  latestWorkSessionPath,
  readLatestWorkSession,
  recordLatestWorkSession,
} from "../host/paths.ts";
import { runsPath, type RunRecord } from "../host/run-registry.ts";
import type { EventRecord } from "../host/schema.ts";

const CREDENTIAL_PROBE_ROLE = "credential_probe";

/** Boundary failures log model/usage with input_tokens "missing" (loop-pi.ts). */
function modelUsageIsCompletedRequest(event: EventRecord): boolean {
  if (event.name !== "model/usage") return false;
  const usage = event.observe?.model_usage as { input_tokens?: unknown } | undefined;
  if (!usage) return false;
  return usage.input_tokens !== "missing";
}

function parseInputReference(value: unknown): InputReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const seq = (value as { seq?: unknown }).seq;
  const hash = (value as { hash?: unknown }).hash;
  if (typeof seq !== "number" || typeof hash !== "string") return undefined;
  return { seq, hash };
}

let providerBlobReadCount = 0;

/** @internal Resets the test counter for provider blob reads during abandon scans. */
export function resetProviderBlobReadsForTest(): void {
  providerBlobReadCount = 0;
}

/** @internal Returns how many blob bodies were loaded during abandon heuristic scans. */
export function providerBlobReadsForTest(): number {
  return providerBlobReadCount;
}

/** Abandon heuristics only need role (request rows) and request refs (send/response). */
type CachedProviderBody = {
  role?: string;
  request?: InputReference;
};

/** Loads one blob at a time; unreadable blobs are cached as missing. */
class LazyProviderBodies {
  private readonly store: BlobStore;
  private readonly cache = new Map<string, CachedProviderBody | undefined>();

  constructor(logPath: string) {
    this.store = BlobStore.forSession(logPath);
  }

  fieldsFor(event: EventRecord): CachedProviderBody | undefined {
    const blob = event.payload.blob;
    if (typeof blob !== "string") return undefined;
    if (!this.cache.has(blob)) {
      try {
        providerBlobReadCount += 1;
        const parsed: unknown = JSON.parse(this.store.get(blob));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          this.cache.set(blob, undefined);
        } else {
          const body = parsed as Record<string, unknown>;
          const role = body.role;
          const requestRef = parseInputReference(body.request);
          this.cache.set(blob, {
            ...(typeof role === "string" ? { role } : {}),
            ...(requestRef ? { request: requestRef } : {}),
          });
        }
      } catch {
        this.cache.set(blob, undefined);
      }
    }
    return this.cache.get(blob);
  }
}

function providerRequestBySeq(events: readonly EventRecord[]): Map<number, EventRecord> {
  const bySeq = new Map<number, EventRecord>();
  for (const event of events) {
    if (event.name === "provider/request") bySeq.set(event.seq, event);
  }
  return bySeq;
}

function requestRoleForRef(
  requestsBySeq: ReadonlyMap<number, EventRecord>,
  bodies: LazyProviderBodies,
  ref: InputReference,
): string | undefined {
  const row = requestsBySeq.get(ref.seq);
  if (!row || row.hash !== ref.hash) return undefined;
  const role = bodies.fieldsFor(row)?.role;
  return typeof role === "string" ? role : undefined;
}

/** True only when the row positively resolves to credential_probe. */
function providerRowIsCredentialProbe(
  event: EventRecord,
  requestsBySeq: ReadonlyMap<number, EventRecord>,
  bodies: LazyProviderBodies,
): boolean {
  if (event.name === "provider/request") {
    const role = bodies.fieldsFor(event)?.role;
    return typeof role === "string" && role === CREDENTIAL_PROBE_ROLE;
  }
  if (event.name === "provider/send" || event.name === "provider/response") {
    const ref = bodies.fieldsFor(event)?.request;
    if (!ref) return false;
    const role = requestRoleForRef(requestsBySeq, bodies, ref);
    return role === CREDENTIAL_PROBE_ROLE;
  }
  return false;
}

function providerRowCountsAsExecutionStarted(
  event: EventRecord,
  requestsBySeq: ReadonlyMap<number, EventRecord>,
  bodies: LazyProviderBodies,
): boolean {
  if (event.name === "provider/request") {
    const role = bodies.fieldsFor(event)?.role;
    if (typeof role !== "string") return true;
    return role !== CREDENTIAL_PROBE_ROLE;
  }
  // provider/send coverage: fresh-work-abandon.test.ts appends send without response
  // (workStartSeq at the request row) so only this branch can keep the session.
  if (event.name === "provider/send" || event.name === "provider/response") {
    if (providerRowIsCredentialProbe(event, requestsBySeq, bodies)) return false;
    return true;
  }
  return false;
}

/** True once this work invocation started or completed a real (non-probe) model request. */
export function sessionHadCompletedModelRequest(
  events: readonly EventRecord[],
  workStartSeq: number,
  log: Pick<EventLog, "path" | "events">,
): boolean {
  for (const event of events) {
    if (event.seq <= workStartSeq) continue;
    if (modelUsageIsCompletedRequest(event)) return true;
  }
  if (!log.path) return true;
  const bodies = new LazyProviderBodies(log.path);
  const requestsBySeq = providerRequestBySeq(events);
  for (const event of events) {
    if (event.seq <= workStartSeq) continue;
    if (providerRowCountsAsExecutionStarted(event, requestsBySeq, bodies)) return true;
  }
  return false;
}

const SUCCESS_WORK_STOP_REASONS = new Set(["finished", "converged"]);

/** Node may surface exit codes as string; null means unset. */
export function normalizeProcessExitCode(
  raw: string | number | null | undefined,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function coerceRunResultExitCode(payload: Record<string, unknown>): number | undefined {
  const direct = normalizeProcessExitCode(payload.exit_code as string | number | null | undefined);
  if (direct !== undefined) return direct;
  if (payload.outcome === "incomplete" || payload.status === "blocked" || payload.status === "failed") {
    return 1;
  }
  const stopReason = payload.stop_reason;
  if (typeof stopReason === "string" && stopReason.length > 0 && !SUCCESS_WORK_STOP_REASONS.has(stopReason)) {
    return 1;
  }
  if (payload.label === "done" || payload.label === "done_unverified") return 0;
  return undefined;
}

/** Exit code for abandon decisions: this run's terminal row, else the process default (0). */
export function freshWorkRunExitCodeForAbandon(
  events: readonly EventRecord[],
  workStartSeq: number,
  processExitCode: number | undefined,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.seq <= workStartSeq) break;
    if (event.name !== "work/run_result") continue;
    const fromRow = coerceRunResultExitCode(event.payload);
    if (fromRow !== undefined) return fromRow;
  }
  return processExitCode ?? 0;
}

/**
 * A fresh work run that failed before the first model request should not leave
 * a session directory, latest pointer, or runs.jsonl breadcrumb.
 */
export function shouldAbandonFreshWorkSession(input: {
  fresh: boolean;
  events: readonly EventRecord[];
  workStartSeq: number;
  processExitCode: number | undefined;
  log: Pick<EventLog, "path" | "events">;
}): boolean {
  if (!input.fresh) return false;
  const exitCode = freshWorkRunExitCodeForAbandon(
    input.events,
    input.workStartSeq,
    input.processExitCode,
  );
  if (exitCode === 0 || exitCode === 2) return false;
  if (sessionHadCompletedModelRequest(input.events, input.workStartSeq, input.log)) return false;
  return true;
}

export function abandonFreshWorkSession(input: {
  sessionId: string;
  workspaceRoot: string;
  home?: string;
  env?: NodeJS.Dict<string>;
  /** Value of readLatestWorkSession immediately before this run recorded itself. */
  priorLatestWorkSession?: string;
}): void {
  const home = input.home ?? dokkabiHome(input.env);
  const env = input.env ?? process.env;
  const dir = join(home, "sessions", input.sessionId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const parent = dirname(dir);
  if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });

  const latest = readLatestWorkSession(input.workspaceRoot, home);
  if (latest === input.sessionId) {
    try {
      if (input.priorLatestWorkSession !== undefined) {
        recordLatestWorkSession(input.workspaceRoot, input.priorLatestWorkSession, home);
      } else {
        rmSync(latestWorkSessionPath(input.workspaceRoot, home));
        const workspacesRoot = dirname(latestWorkSessionPath(input.workspaceRoot, home));
        if (existsSync(workspacesRoot) && readdirSync(workspacesRoot).length === 0) {
          rmSync(workspacesRoot, { recursive: true, force: true });
        }
      }
    } catch {
      // Best effort: a stale pointer only misroutes resume.
    }
  }

  withdrawRunRecord({ home, session: input.sessionId }, env);
}

/** Best-effort read–rewrite–rename, same pattern as run-registry trim and session-gc
 * compactRunsIndex: no lock; concurrent writers can drop each other's lines. */
function withdrawRunRecord(
  input: { home: string; session: string },
  env: NodeJS.Dict<string> = process.env,
): void {
  const path = runsPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: RunRecord;
    try {
      parsed = JSON.parse(line) as RunRecord;
    } catch {
      kept.push(line);
      continue;
    }
    if (parsed.home === input.home && parsed.session === input.session) continue;
    kept.push(line);
  }
  if (kept.length === 0) {
    try {
      rmSync(path);
    } catch {
      // Unwritable registry: nothing to repair.
    }
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${kept.join("\n")}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Best effort.
  }
}
