import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { EventRecord } from "./schema.ts";
import { canonicalJson } from "./canonical.ts";
import { workspacePathReach } from "../plugins/workspace-tools.ts";

/**
 * Received-call execution leases (#224, design memo §142).
 *
 * An early read is the same call, under the same authority, started sooner.
 * It earns nothing: no result is model-visible until the committed assistant
 * names the exact call and the resource is still what was read. This module
 * holds the parts that are pure — the identity (L1), the lease state machine,
 * the barrier rule (B1), the bounds (Q1), the resource version the
 * revalidation compares (P1), the row family, the dashboard fold and the
 * replay-preflight validator (E1). The Pi stream contract is
 * host/pi-stream-boundary.ts; the plugin that issues leases and executes is
 * plugins/received-tool-execution.ts.
 *
 * L1 One lease per identity: attempt / ordinal / call id / tool registration
 *    / args digest / schema digest / resource version. A lease is consumed
 *    exactly once, by the ordinary execution point, after revalidation.
 * A1 Eligibility comes from registered tool metadata (`ReceivedReadMetadata`,
 *    keyed by the host-built tool OBJECT — workspace-tools.ts registers it),
 *    never from a name or a command substring; a tool without metadata, or
 *    without a version identity, is an ineligible barrier.
 * B1 Early starts only before the first barrier in source order: the early
 *    set of an attempt is a PREFIX of its ordinals (`earlySetOf`).
 * Q1 Concurrency 4, buffered unpublished results 1 MiB; exhaustion falls
 *    back to the ordinary path and is itself a barrier for the attempt, so
 *    the admitted-early set stays a prefix and the per-turn guards count in
 *    source order exactly as they do with the feature off.
 */

export const EARLY_READ_CONCURRENCY = 4;
export const EARLY_READ_BUFFER_BYTES = 1024 * 1024;
/** How long an owned read is waited for after cancellation before it is
 * `unresolved` (mirrors the read batch and the kernel membership patience). */
export const EARLY_READ_SETTLE_GRACE_MS = 2_000;

/** The row family: outside `tool/` so no consumer of loop rows, the
 * observation schema or the replay contract sees a scheduling row by
 * construction; the actual execution stays `tool/call`..`tool/end`, once. */
export const EARLY_READ_CAPABILITY_EVENT = "early_read/capability";
export const EARLY_READ_ADMISSION_EVENT = "early_read/admission";
export const EARLY_READ_START_EVENT = "early_read/start";
export const EARLY_READ_SETTLE_EVENT = "early_read/settle";
export const EARLY_READ_DISCARD_EVENT = "early_read/discard";
export const EARLY_READ_PUBLISH_EVENT = "early_read/publish";

export const EARLY_LEASE_STATES = ["received", "authorized", "running", "settled", "published", "discarded", "unresolved"] as const;
export type EarlyLeaseState = (typeof EARLY_LEASE_STATES)[number];

/** The closed vocabulary of why a received call was not started early. */
export const EARLY_INELIGIBLE_REASONS = [
  "provider_unsupported", "unregistered_tool", "no_version_identity", "invalid_arguments", "no_resource_version",
  "duplicate_identity", "barrier", "durable_foreground", "concurrency_exhausted", "pipeline_refused", "batch_wrapper", "replay", "admission_failed", "revoked",
] as const;
export type EarlyIneligibleReason = (typeof EARLY_INELIGIBLE_REASONS)[number];

/** The closed vocabulary of why a lease was discarded. */
export const EARLY_DISCARD_REASONS = [
  "revised", "absent", "stream_length", "stream_error", "stream_aborted", "resource_changed", "args_changed", "buffer_exhausted",
  "not_consumed", "signal", "restart", "surface_replaced", "late_settled", "pipeline_refused", "unaccountable", "unversioned_read", "after_revocation",
] as const;
export type EarlyDiscardReason = (typeof EARLY_DISCARD_REASONS)[number];

export interface ReceivedCall {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly callId: string;
  readonly registrationId: string;
  readonly argsDigest: string;
  readonly schemaDigest: string;
  readonly resourceVersion: string;
}

/** L1: the lease key — every field of the identity, canonical, hashed. */
export function leaseKey(call: ReceivedCall): string {
  return createHash("sha256").update(canonicalJson({
    attempt: call.attemptId, ordinal: call.ordinal, call: call.callId, registration: call.registrationId,
    args: call.argsDigest, schema: call.schemaDigest, resource: call.resourceVersion,
  })).digest("hex");
}

export function schemaDigestOf(parameters: unknown): string {
  return createHash("sha256").update(canonicalJson(parameters ?? {})).digest("hex");
}

export interface ResourceIdentity {
  /** The workspace-relative path the call reaches. R3': never written to a
   * row, a cell or a preflight error as text — only the identity is. */
  readonly resource: string;
  /** The object identity: device and inode. */
  readonly identity: string;
  /** P1'/P1'': the content digest (sha256 of the bytes) — THE version,
   * always taken from the bytes, never lent from a stat. */
  readonly version: string;
  /** The stat fingerprint (size, mtime, ctime): an early-discard HINT only —
   * a changed fingerprint may discard before hashing; an equal one proves
   * nothing (coarse clocks). */
  readonly fingerprint: string;
}

/** P1'/P1'': the same version is the same identity with the same content
 * digest — a `touch` (same inode, same bytes) changes nothing; new bytes or a
 * replaced inode is another resource. The fingerprint never decides. */
export function sameResourceVersion(before: Pick<ResourceIdentity, "identity" | "version">, now: Pick<ResourceIdentity, "identity" | "version">): boolean {
  return before.identity === now.identity && before.version === now.version;
}

/** The early-discard hint: a fingerprint that moved is worth a discard
 * without hashing; one that did not move proves nothing. */
export function resourceFingerprintChanged(before: Pick<ResourceIdentity, "identity" | "fingerprint">, now: Pick<ResourceIdentity, "identity" | "fingerprint">): boolean {
  return before.identity !== now.identity || before.fingerprint !== now.fingerprint;
}

/** The largest file whose content digest is taken for a version identity;
 * past it a read has no version identity and is never early. */
export const RESOURCE_DIGEST_BYTES_MAX = 16 * 1024 * 1024;

/** P1''': the version of the bytes a registered read actually returned —
 * attached by the versioned read to the exact result object (never written
 * into it, so the model-visible shape stays the tool's). */
export interface ReadVersion {
  /** sha256 of the bytes the read returned. */
  readonly digest: string;
  readonly bytes: number;
  /** The object identity the read hook reported. */
  readonly identity: string;
}

const ATTACHED_READ_VERSION = new WeakMap<object, ReadVersion>();

export function attachReadVersion<T extends object>(result: T, version: ReadVersion): T {
  ATTACHED_READ_VERSION.set(result, version);
  return result;
}

export function readVersionOf(result: unknown): ReadVersion | undefined {
  return result && typeof result === "object" ? ATTACHED_READ_VERSION.get(result) : undefined;
}

/** Q1'/Q1''/Q1''': what a settled result holds, by encoded bytes — and
 * whether that count is trustworthy. The walk never throws and never
 * under-counts what it could see: a string its UTF-8 bytes, a byte buffer its
 * length, a number/boolean/null its JSON, a bigint its digits, an object its
 * own keys (string AND symbol) and values, each object once. A getter that
 * throws, a cycle, a bigint or a symbol key makes the result `unaccountable`
 * — counted as far as it goes, never trusted. */
export interface ResultAccounting {
  readonly bytes: number;
  readonly accountable: boolean;
  readonly reason?: "throwing_getter" | "cycle" | "bigint" | "symbol_key";
}

export function accountResult(result: unknown): ResultAccounting {
  const seen = new Set<object>();
  let bytes = 0;
  let reason: ResultAccounting["reason"];
  const mark = (why: NonNullable<ResultAccounting["reason"]>): void => { reason ??= why; };
  const walk = (value: unknown): void => {
    if (value === undefined) return;
    if (typeof value === "string") { bytes += Buffer.byteLength(value, "utf8"); return; }
    if (typeof value === "number" || typeof value === "boolean" || value === null) { bytes += Buffer.byteLength(JSON.stringify(value), "utf8"); return; }
    if (typeof value === "bigint") { bytes += String(value).length; mark("bigint"); return; }
    if (typeof value === "symbol" || typeof value === "function") { mark("symbol_key"); return; }
    if (typeof value !== "object") return;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) { bytes += value.byteLength; return; }
    if (seen.has(value)) { mark("cycle"); return; }
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") mark("symbol_key");
      else bytes += Buffer.byteLength(key, "utf8");
      let field: unknown;
      try {
        field = Reflect.get(value, key);
      } catch {
        mark("throwing_getter");
        continue;
      }
      walk(field);
    }
  };
  if (typeof result === "object" && result !== null) {
    const record = result as { content?: unknown; details?: unknown };
    try {
      walk(record.content);
      walk(record.details);
    } catch {
      mark("throwing_getter");
    }
  }
  return reason === undefined ? { bytes, accountable: true } : { bytes, accountable: false, reason };
}

/** The bytes a result holds — never a throw, never an under-count of what
 * could be seen; `accountResult` says whether the count can be trusted. */
export function resultEncodedBytes(result: unknown): number {
  return accountResult(result).bytes;
}

/**
 * A1: what a tool's provider states about it. Registered by the host that
 * built the tool object (workspace-tools.ts), looked up by that object. A
 * tool without a `resource` function has no verified version identity and
 * is never started early in v1 (grep, glob, ls — read-only and bounded, but
 * their resource is a tree, not a versioned file).
 */
export interface ReceivedReadMetadata {
  readonly readOnly: true;
  readonly bounded: true;
  readonly cancellation: "owned" | "unsupported";
  readonly resource?: (args: Readonly<Record<string, unknown>>) => ResourceIdentity | undefined;
  /** P1'': the stat-only hint (identity and fingerprint, no bytes read) for an
   * early discard; never a verdict that a resource is unchanged. */
  readonly fingerprint?: (args: Readonly<Record<string, unknown>>) => Pick<ResourceIdentity, "identity" | "fingerprint"> | undefined;
}

/** The version identity of a regular file inside the workspace (P1', P1''):
 * its object identity (device, inode), its content digest — taken from the
 * bytes on EVERY call; no stat ever lends a digest, because a coarse clock
 * (HFS+, exFAT, SMB, older Linux) keeps size, mtime and ctime across an
 * in-place rewrite within one tick — and its stat fingerprint (the
 * early-discard hint). Undefined for anything else (a directory, a missing
 * file, a path that escapes, a file past RESOURCE_DIGEST_BYTES_MAX). */
export function fileResourceFingerprint(root: string, path: string): Pick<ResourceIdentity, "identity" | "fingerprint"> | undefined {
  const reach = workspacePathReach(root, path);
  if (reach === undefined || reach.inode === undefined) return undefined;
  try {
    const stat = statSync(join(root, reach.relative.toString("utf8")), { bigint: true });
    if (!stat.isFile()) return undefined;
    return { identity: `${stat.dev}:${stat.ino}`, fingerprint: `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
  } catch {
    return undefined;
  }
}

export function fileResourceIdentity(root: string, path: string, previous?: ResourceIdentity): ResourceIdentity | undefined {
  // P1'': `previous` lends nothing — accepted only so a caller holding an
  // earlier identity reads the same signature; the bytes are hashed again.
  void previous;
  const reach = workspacePathReach(root, path);
  if (reach === undefined || reach.inode === undefined) return undefined;
  const relative = reach.relative.toString("utf8");
  try {
    const full = join(root, relative);
    const stat = statSync(full, { bigint: true });
    if (!stat.isFile() || stat.size > RESOURCE_DIGEST_BYTES_MAX) return undefined;
    const identity = `${stat.dev}:${stat.ino}`;
    const fingerprint = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const version = createHash("sha256").update(readFileSync(full)).digest("hex");
    return { resource: relative, identity, version, fingerprint };
  } catch {
    return undefined;
  }
}

/** The lease transitions; anything else is refused (undefined). */
export function nextLeaseState(state: EarlyLeaseState, to: EarlyLeaseState): EarlyLeaseState | undefined {
  switch (state) {
    case "received": return to === "authorized" || to === "discarded" ? to : undefined;
    case "authorized": return to === "running" || to === "discarded" ? to : undefined;
    case "running": return to === "settled" || to === "discarded" || to === "unresolved" ? to : undefined;
    case "settled": return to === "published" || to === "discarded" ? to : undefined;
    default: return undefined;
  }
}

export function isTerminalLeaseState(state: EarlyLeaseState): boolean {
  return state === "published" || state === "discarded" || state === "unresolved";
}

/**
 * B1: the early set of an attempt is the ordinals before the first barrier,
 * in source order — `read A; edit B; read C` starts A only. A call that is
 * not eligible for any reason is a barrier (an exclusive call, a call
 * outside the registered read metadata, an unknown resource relationship,
 * an exhausted bound), so the set is always a prefix.
 */
export function earlySetOf(calls: ReadonlyArray<{ readonly ordinal: number; readonly eligible: boolean }>): number[] {
  const sorted = [...calls].sort((a, b) => a.ordinal - b.ordinal);
  const early: number[] = [];
  let expected = 0;
  for (const call of sorted) {
    if (call.ordinal !== expected || !call.eligible) break;
    early.push(call.ordinal);
    expected += 1;
  }
  return early;
}

// --- the capability the loop consumes ------------------------------------------

/** The host-only capability key `received_tool_execution` (plugin-owned). */
export const RECEIVED_TOOL_EXECUTION_KEY = "received_tool_execution";

/** An early admission request: the loop runs its own pre-call pipeline for
 * it (A1) and records the decision as `early_read/admission`. */
export interface EarlyAdmissionRequest {
  readonly name: string;
  readonly id: string;
  readonly args: unknown;
  readonly attempt: string;
  readonly ordinal: number;
  readonly lease: string;
  readonly registration: string;
  readonly schemaDigest: string;
  readonly resource: ResourceIdentity;
  /** A1': the attempt's earlier live leases, in ordinal order — replayed onto
   * the preview's shadow so this decision reads the state the ordinary guard
   * will have when it reaches this call. */
  readonly prior: ReadonlyArray<Pick<EarlyAdmissionRequest, "name" | "id" | "args">>;
}

/** A1': the pipeline's PREVIEW decision (no guard mutated, no row of the
 * loop's family appended) and the `tool/call` payload the ordinary point
 * will record — kept only for the `early_read/admission` row. */
export type EarlyAdmission =
  | { readonly block: false; readonly record: Readonly<Record<string, unknown>> }
  | { readonly block: true; readonly reason: string; readonly terminate?: boolean; readonly record: Readonly<Record<string, unknown>> };

export interface ReceivedSurfaceBinding {
  /** The host-built tool objects (`ctx.get("tools")`): the registered metadata is keyed by these. */
  readonly registered: readonly AgentTool[];
  /** The objects Pi executes, 1:1 with `registered` by position (projections, links). */
  readonly live: readonly AgentTool[];
  /** The pi-ai api of the model this agent streams from (F1). */
  readonly api: string;
  readonly route: string;
  readonly admit: (call: EarlyAdmissionRequest) => EarlyAdmission;
  /** A call that needs a durable foreground receipt (#128 full mode) is never early. */
  readonly requiresDurableForeground?: (name: string, args: unknown) => boolean;
}

export interface BoundReceivedSurface {
  /** `live`, each eligible tool wrapped so the ordinary point consumes its lease. */
  readonly tools: AgentTool[];
  /** Every Pi agent event, in order; awaited by the loop (a commit's cancellations settle before Pi goes on). */
  observe(event: AgentEvent): void | Promise<void>;
  /** A1': the ordinary admission's verdict for this call at Pi's ordinary
   * point: a blocked call's lease is discarded (the read never becomes a
   * result); an allowed one may be served by the wrapped tool. */
  settleAdmission(callId: string, args: unknown, blocked: boolean): Promise<void>;
  idle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ReceivedToolExecution {
  bind(binding: ReceivedSurfaceBinding): BoundReceivedSurface;
  snapshot(): { readonly running: number; readonly bufferedBytes: number; readonly bound: boolean };
  dispose(): Promise<void>;
}

/**
 * The early execution context: set by the plugin around an early start so
 * the #128 prediction owner (speculative/runtime-tier1.ts) can tell an early
 * start from Pi's ordinary point and ADOPT its own in-flight candidate for
 * the same call instead of running a second execution (SO-O2). Outside the
 * context nothing changes.
 */
const EARLY_EXECUTION = new AsyncLocalStorage<{ readonly lease: string }>();

export function runEarlyExecution<T>(lease: string, run: () => T): T {
  return EARLY_EXECUTION.run({ lease }, run);
}

export function earlyExecutionLease(): string | undefined {
  return EARLY_EXECUTION.getStore()?.lease;
}

// --- dashboard and replay projections ---------------------------------------

export interface EarlyReadStats {
  /** Capability explanations recorded, by api → capable. */
  providers: Record<string, boolean>;
  eligible: number;
  ineligible: Record<string, number>;
  /** Leases admitted and never started (the pipeline refused them). */
  refused: number;
  started: number;
  /** Started leases with no settle/discard/publish row. */
  active: number;
  settled: number;
  published: number;
  discarded: Record<string, number>;
  unresolved: number;
  late_settled: number;
  /** Discards that name an ordinary re-execution. */
  reruns: number;
  overlap_ms: number;
  overlap_max_ms: number;
  waited_ms: number;
  /** Cost of work whose result never reached the model. */
  discarded_bytes: number;
  discarded_cpu_ms: number;
  published_bytes: number;
  /** The same (attempt, call, args, resource version) published more than once — 0 unless the log lies. */
  duplicate_publications: number;
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

export function earlyReadStats(events: readonly EventRecord[]): EarlyReadStats | undefined {
  const stats: EarlyReadStats = {
    providers: {}, eligible: 0, ineligible: {}, refused: 0, started: 0, active: 0, settled: 0, published: 0, discarded: {},
    unresolved: 0, late_settled: 0, reruns: 0, overlap_ms: 0, overlap_max_ms: 0, waited_ms: 0, discarded_bytes: 0, discarded_cpu_ms: 0,
    published_bytes: 0, duplicate_publications: 0,
  };
  const started = new Map<string, { bytes?: number; latency?: number }>();
  const settledBytes = new Map<string, { bytes: number; latency: number }>();
  const closed = new Set<string>();
  const published = new Map<string, number>();
  let seen = false;
  for (const event of events) {
    const p = event.payload;
    const lease = typeof p.lease === "string" ? p.lease : undefined;
    if (event.name === EARLY_READ_CAPABILITY_EVENT) {
      seen = true;
      if (typeof p.api === "string") stats.providers[p.api] = p.capable === true;
    } else if (event.name === EARLY_READ_ADMISSION_EVENT) {
      seen = true;
      if (p.decision === "admitted") stats.eligible += 1;
      else if (p.decision === "refused") { stats.eligible += 1; stats.refused += 1; }
      else bump(stats.ineligible, typeof p.reason === "string" ? p.reason : "unknown");
    } else if (event.name === EARLY_READ_START_EVENT) {
      seen = true;
      stats.started += 1;
      if (lease) started.set(lease, {});
    } else if (event.name === EARLY_READ_SETTLE_EVENT) {
      seen = true;
      stats.settled += 1;
      if (lease && typeof p.bytes === "number" && typeof p.latency_ms === "number") settledBytes.set(lease, { bytes: p.bytes, latency: p.latency_ms });
    } else if (event.name === EARLY_READ_DISCARD_EVENT) {
      seen = true;
      if (p.outcome === "late_settled") { stats.late_settled += 1; continue; }
      bump(stats.discarded, typeof p.reason === "string" ? p.reason : "unknown");
      if (p.reexecute === "ordinary") stats.reruns += 1;
      if (lease) {
        closed.add(lease);
        const cost = settledBytes.get(lease);
        if (cost) { stats.discarded_bytes += cost.bytes; stats.discarded_cpu_ms += cost.latency; }
        else {
          if (typeof p.bytes === "number") stats.discarded_bytes += p.bytes;
          if (typeof p.latency_ms === "number") stats.discarded_cpu_ms += p.latency_ms;
        }
      }
      if (p.termination === "unresolved") stats.unresolved += 1;
    } else if (event.name === EARLY_READ_PUBLISH_EVENT) {
      seen = true;
      stats.published += 1;
      if (lease) {
        closed.add(lease);
        published.set(lease, (published.get(lease) ?? 0) + 1);
        const cost = settledBytes.get(lease);
        if (cost) stats.published_bytes += cost.bytes;
      }
      if (typeof p.overlap_ms === "number") { stats.overlap_ms += p.overlap_ms; stats.overlap_max_ms = Math.max(stats.overlap_max_ms, p.overlap_ms); }
      if (typeof p.waited_ms === "number") stats.waited_ms += p.waited_ms;
    }
  }
  if (!seen) return undefined;
  for (const lease of started.keys()) if (!closed.has(lease)) stats.active += 1;
  for (const count of published.values()) if (count > 1) stats.duplicate_publications += count - 1;
  return stats;
}

export function earlyReadLine(stats: EarlyReadStats | undefined): string {
  if (!stats) return "";
  const map = (record: Record<string, number | boolean>) => Object.entries(record).map(([key, value]) => `${key}=${typeof value === "boolean" ? (value ? "capable" : "unsupported") : value}`).join(" ") || "none";
  return `early reads providers ${map(stats.providers)} · eligible=${stats.eligible} refused=${stats.refused} ineligible ${map(stats.ineligible)}`
    + ` · started=${stats.started} active=${stats.active} settled=${stats.settled} published=${stats.published} unresolved=${stats.unresolved} late=${stats.late_settled}`
    + ` · discarded ${map(stats.discarded)} reruns=${stats.reruns}`
    + ` · overlap=${stats.overlap_ms}ms max=${stats.overlap_max_ms}ms waited=${stats.waited_ms}ms`
    + ` · published=${stats.published_bytes}B discarded=${stats.discarded_bytes}B/${stats.discarded_cpu_ms}ms duplicate_publications=${stats.duplicate_publications}`;
}

/**
 * Replay preflight (E1): the lease rows are consistent with themselves and
 * with the loop's own tool rows. A lease is admitted once; it starts only
 * after its admission and only when admitted; it settles or is discarded
 * once (a late settlement aside); it is published at most once, only after
 * it settled, only before its call's `tool/result`, and its `tool/call` row
 * lies between the admission and the publication; the same (attempt, call,
 * args, resource) identity is never published twice under different leases.
 * Nothing here reads a file or starts a read.
 */
export function validateRecordedEarlyReads(events: readonly EventRecord[]): void {
  const fail = (seq: number, why: string): never => {
    throw new Error(`Error: recorded early read at event seq #${seq} ${why}\nReplay aborted (fail-closed).`);
  };
  const admitted = new Map<string, { seq: number; call: string; decision: string; identity: string }>();
  const started = new Map<string, number>();
  const settled = new Map<string, number>();
  const closed = new Map<string, number>();
  const publishedIdentities = new Set<string>();
  // Every tool/call and tool/result seq per call id: a model may reuse an
  // id across attempts, so the row that matters is the one between the
  // lease's admission and its publication.
  const toolCalls = new Map<string, number[]>();
  const toolResults = new Map<string, number[]>();
  for (const event of events) {
    const p = event.payload;
    if (event.name === "tool/call" && typeof p.id === "string") { toolCalls.set(p.id, [...(toolCalls.get(p.id) ?? []), event.seq]); continue; }
    if (event.name === "tool/result" && typeof p.id === "string") { toolResults.set(p.id, [...(toolResults.get(p.id) ?? []), event.seq]); continue; }
    if (!event.name.startsWith("early_read/")) continue;
    if (event.name === EARLY_READ_CAPABILITY_EVENT) continue;
    const lease = typeof p.lease === "string" ? p.lease : fail(event.seq, "names no lease");
    if (event.name === EARLY_READ_ADMISSION_EVENT) {
      if (typeof p.id !== "string" || typeof p.decision !== "string") fail(event.seq, "is malformed");
      if (admitted.has(lease)) fail(event.seq, `admits lease ${lease.slice(0, 8)} a second time`);
      const identity = canonicalJson([p.attempt ?? "", p.id, p.args_digest ?? "", p.resource_version ?? ""]);
      admitted.set(lease, { seq: event.seq, call: p.id as string, decision: p.decision as string, identity });
      continue;
    }
    const admission = admitted.get(lease) ?? fail(event.seq, "has no admission row before it");
    if (event.name === EARLY_READ_START_EVENT) {
      if (admission.decision !== "admitted") fail(event.seq, "starts a lease the pipeline did not admit");
      if (started.has(lease)) fail(event.seq, "starts a lease a second time");
      if (closed.has(lease)) fail(event.seq, "starts a lease already closed");
      started.set(lease, event.seq);
      continue;
    }
    if (event.name === EARLY_READ_SETTLE_EVENT) {
      if (!started.has(lease)) fail(event.seq, "settles a lease that never started");
      if (settled.has(lease) || closed.has(lease)) fail(event.seq, "settles a lease a second time");
      settled.set(lease, event.seq);
      continue;
    }
    if (event.name === EARLY_READ_DISCARD_EVENT) {
      if (p.outcome === "late_settled") {
        if (!closed.has(lease)) fail(event.seq, "reports a late settlement of a lease that is not unresolved");
        continue;
      }
      if (closed.has(lease)) fail(event.seq, "discards a lease already closed");
      closed.set(lease, event.seq);
      continue;
    }
    if (event.name === EARLY_READ_PUBLISH_EVENT) {
      if (closed.has(lease)) fail(event.seq, "publishes a lease already closed");
      if (!settled.has(lease)) fail(event.seq, "publishes a lease that did not settle");
      const between = (seqs: readonly number[] | undefined) => (seqs ?? []).some((seq) => seq > admission.seq && seq < event.seq);
      if (!between(toolCalls.get(admission.call))) fail(event.seq, "publishes before its call's tool/call row");
      if (between(toolResults.get(admission.call))) fail(event.seq, "publishes after its call's tool/result row");
      if (publishedIdentities.has(admission.identity)) fail(event.seq, "publishes the same call identity a second time");
      publishedIdentities.add(admission.identity);
      closed.set(lease, event.seq);
      continue;
    }
    fail(event.seq, "is an unknown early_read row");
  }
}

/**
 * C1 restart: the leases a previous process left open, from rows alone.
 * A started lease with no settle/discard/publish row belonged to a process
 * that is gone; its result was never published and cannot be now. A settled
 * one likewise: its bytes were never delivered. The caller records one
 * discard per open lease (`reason: restart`) — nothing is re-executed here;
 * a new attempt issues new leases. Never a guess about live work.
 */
export function openEarlyReadLeases(events: readonly EventRecord[]): Array<{ readonly lease: string; readonly id: string; readonly attempt: string; readonly state: "running" | "settled" }> {
  const open = new Map<string, { id: string; attempt: string; state: "running" | "settled" }>();
  for (const event of events) {
    const p = event.payload;
    const lease = typeof p.lease === "string" ? p.lease : undefined;
    if (!lease) continue;
    if (event.name === EARLY_READ_START_EVENT) open.set(lease, { id: String(p.id ?? ""), attempt: String(p.attempt ?? ""), state: "running" });
    else if (event.name === EARLY_READ_SETTLE_EVENT) { const entry = open.get(lease); if (entry) entry.state = "settled"; }
    else if ((event.name === EARLY_READ_DISCARD_EVENT && p.outcome !== "late_settled") || event.name === EARLY_READ_PUBLISH_EVENT) open.delete(lease);
  }
  return [...open.entries()].map(([lease, entry]) => ({ lease, ...entry }));
}
