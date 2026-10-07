import { randomBytes } from "node:crypto";
import type { AgentEvent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type AssistantMessage } from "@earendil-works/pi-ai";
import type { EventLog } from "../host/event-log.ts";
import type { HostContext, PluginModule } from "../loader/types.ts";
import {
  EARLY_READ_ADMISSION_EVENT,
  EARLY_READ_BUFFER_BYTES,
  EARLY_READ_CAPABILITY_EVENT,
  EARLY_READ_CONCURRENCY,
  EARLY_READ_DISCARD_EVENT,
  EARLY_READ_PUBLISH_EVENT,
  EARLY_READ_SETTLE_EVENT,
  EARLY_READ_SETTLE_GRACE_MS,
  EARLY_READ_START_EVENT,
  RECEIVED_TOOL_EXECUTION_KEY,
  isTerminalLeaseState,
  leaseKey,
  nextLeaseState,
  openEarlyReadLeases,
  accountResult,
  readVersionOf,
  runEarlyExecution,
  sameResourceVersion,
  schemaDigestOf,
  type BoundReceivedSurface,
  type EarlyAdmission,
  type EarlyDiscardReason,
  type EarlyIneligibleReason,
  type EarlyLeaseState,
  type ReceivedCall,
  type ReceivedReadMetadata,
  type ReceivedSurfaceBinding,
  type ReceivedToolExecution,
  type ResourceIdentity,
} from "../host/received-calls.ts";
import { finalCallCapability, StreamBoundaryTracker, type BoundaryRevocationReason, type ReceivedBoundary } from "../host/pi-stream-boundary.ts";
import { toolArgumentsDigest } from "../host/tool-loop.ts";
import { redactForEmission, safeToolResultInput } from "../host/tool-result-input.ts";
import { resourceFingerprintChanged } from "../host/received-calls.ts";
import { sha256Text, utf8Bytes } from "../tools/model-result.ts";
import { workspaceToolsGeneration, workspaceToolsReceivedReads } from "./workspace-tools.ts";

/**
 * `received_tool_execution` (#224, design memo §142): overlap eligible,
 * already RECEIVED read calls with the rest of the model stream.
 *
 * Opt-in (E1): `DOKKABI_EARLY_READS=1` activates the plugin; off, the loop
 * finds no capability and is byte-identical. The plugin is not in the
 * default manifests; an operator adds it BEFORE `loop-pi`. On a read-only
 * log (replay, dashboard) the plugin activates exactly when the recorded run
 * loaded it and provides an inert capability: replay consumes recorded
 * lease rows and starts no early read.
 *
 * F1 the Pi stream contract is host/pi-stream-boundary.ts: an identity is
 *    admissible only on a `final_call_capable` api, only once the stream has
 *    demonstrably continued past the block, and stays a lease only if the
 *    committed assistant still carries the exact call; one capability row per
 *    api per session explains an unsupported provider.
 * L1 one lease per identity (host/received-calls.ts `leaseKey`); prediction
 *    (#128) meets it inside the tier-1 wrapper the early start executes
 *    through — under `runEarlyExecution` the wrapper adopts its own in-flight
 *    candidate instead of running a second execution (SO-O2); a copied tool
 *    object has no registered metadata and cannot acquire a lease; the #228
 *    batch wrapper is a contribution without metadata and its children never
 *    pass through the loop (SO-O1).
 * A1 admission is the loop's own pre-call pipeline (`binding.admit`), run
 *    before any observation; its decision is recorded as
 *    `early_read/admission` and REUSED at Pi's ordinary point for the exact
 *    call (same attempt, id, args digest), where the loop appends the
 *    `tool/call` row from the recorded payload — so the loop's tool rows are
 *    exactly the off path's, in the same place.
 * B1 the early set is a prefix of the attempt's ordinals: any ineligible
 *    call — and an exhausted bound — is a barrier for every later call.
 * P1 the wrapped tool consumes the settled lease exactly once at Pi's
 *    ordinary point after revalidating the args digest and the resource
 *    version; a stale lease is discarded (recorded) and the ordinary tool
 *    runs; Pi publishes results in source order whatever the completion
 *    order; the #223 source is recorded by the loop's own delivery step, once.
 * Q1 four concurrent early reads, 1 MiB of buffered unpublished results.
 * C1 a length/error/aborted stop, a revision, a replaced surface or an
 *    unconsumed lease discards the attempt's unpublished results and cancels
 *    owned reads: settled within the grace is `termination: settled`,
 *    otherwise `unresolved` with this plugin as the recorded owner and a late
 *    settlement recorded and dropped; on register with a live log, leases a
 *    previous process left open are discarded from rows (`reason: restart`).
 */
export const EARLY_READS_ENV = "DOKKABI_EARLY_READS";
export const RECEIVED_TOOL_EXECUTION_OWNER = "received_tool_execution";

function enabled(value: string | undefined): boolean {
  const normalised = value?.trim().toLowerCase();
  return normalised === "1" || normalised === "on" || normalised === "true";
}

export interface ReceivedToolExecutionOptions {
  readonly concurrency?: number;
  readonly bufferBytes?: number;
  readonly settleGraceMs?: number;
  readonly now?: () => number;
}

type ToolResult = AgentToolResult<unknown>;

interface Lease {
  readonly key: string;
  readonly call: ReceivedCall;
  readonly boundary: ReceivedBoundary;
  readonly live: AgentTool;
  readonly metadata: ReceivedReadMetadata;
  readonly resource: ResourceIdentity;
  readonly validated: unknown;
  readonly admission: EarlyAdmission;
  readonly controller: AbortController;
  state: EarlyLeaseState;
  committed: boolean;
  /** A1': the ordinary admission at Pi's point allowed this call. */
  admitted: boolean;
  /** The stream revoked the identity: the call will not be admitted ordinarily. */
  revoked: boolean;
  startedAt?: number;
  settledAt?: number;
  latencyMs?: number;
  bytes?: number;
  digest?: string;
  /** P1''': the digest of the bytes the read returned — THE version the ordinary point re-hashes against. */
  readDigest?: string;
  result?: ToolResult;
  error?: unknown;
  failed?: boolean;
  promise?: Promise<void>;
}

interface Attempt {
  readonly id: string;
  readonly tracker: StreamBoundaryTracker;
  readonly leases: Map<string, Lease>;
  readonly keys: Set<string>;
  /** B1: once set, no later ordinal of this attempt starts early. */
  barrier: EarlyIneligibleReason | undefined;
  committed: boolean;
}

function discardReasonOf(reason: BoundaryRevocationReason): EarlyDiscardReason {
  switch (reason) {
    case "absent": return "absent";
    case "stream_length": return "stream_length";
    case "stream_error": return "stream_error";
    case "stream_aborted": return "stream_aborted";
    default: return "revised";
  }
}


function textOf(result: ToolResult | undefined): string {
  return (result?.content ?? []).map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

type Settled<T> = { readonly settled: true; readonly value?: T; readonly error?: unknown; readonly failed: boolean } | { readonly settled: false };

/** Wait for `promise`; once `signal` aborts, at most `graceMs` longer. */
function settleWithin<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let arm: (() => void) | undefined;
  const settled = promise.then(
    (value): Settled<T> => ({ settled: true, value, failed: false }),
    (error): Settled<T> => ({ settled: true, error, failed: true }),
  );
  const grace = new Promise<Settled<T>>((resolve) => {
    arm = () => { timer = setTimeout(() => resolve({ settled: false }), graceMs); };
    signal.addEventListener("abort", arm, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", arm);
      arm();
    }
  });
  return Promise.race([settled, grace]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (arm !== undefined) signal.removeEventListener("abort", arm);
  });
}

export function createReceivedToolExecution(ctx: HostContext, options: ReceivedToolExecutionOptions = {}): ReceivedToolExecution {
  const log = ctx.log;
  const concurrency = options.concurrency ?? EARLY_READ_CONCURRENCY;
  const bufferBytes = options.bufferBytes ?? EARLY_READ_BUFFER_BYTES;
  const settleGraceMs = options.settleGraceMs ?? EARLY_READ_SETTLE_GRACE_MS;
  const now = options.now ?? (() => performance.now());
  const nonce = randomBytes(6).toString("hex");
  const explained = new Set<string>();
  for (const event of log.events) if (event.name === EARLY_READ_CAPABILITY_EVENT && typeof event.payload.api === "string") explained.add(event.payload.api);
  let running = 0;
  let buffered = 0;
  let turn = 0;
  let current: Bound | undefined;
  let disposed = false;

  const append = (name: string, payload: Record<string, unknown>): boolean => {
    try {
      log.append({ kind: "observe", name, payload });
      return true;
    } catch {
      return false;
    }
  };

  class Bound implements BoundReceivedSurface {
    readonly tools: AgentTool[];
    private readonly metadata: ReadonlyMap<AgentTool, ReceivedReadMetadata>;
    private readonly generation: string | undefined;
    private readonly capable: boolean;
    private readonly liveToRegistered = new Map<AgentTool, AgentTool>();
    private attempt: Attempt | undefined;
    private readonly inFlight = new Set<Promise<unknown>>();
    private closed = false;

    constructor(private readonly binding: ReceivedSurfaceBinding) {
      const capability = finalCallCapability(binding.api);
      this.capable = capability.capable && !log.isReadOnly && binding.route !== "replay";
      if (!log.isReadOnly && !explained.has(binding.api)) {
        explained.add(binding.api);
        append(EARLY_READ_CAPABILITY_EVENT, { api: binding.api, capable: capability.capable, reason: capability.reason,
          bounds: { concurrency, buffer_bytes: bufferBytes, settle_grace_ms: settleGraceMs } });
      }
      const registered = binding.registered;
      const aligned = registered.length === binding.live.length && registered.every((tool, index) => tool.name === binding.live[index]?.name);
      this.metadata = aligned ? (workspaceToolsReceivedReads(registered) ?? new Map()) : new Map();
      this.generation = aligned ? workspaceToolsGeneration(registered) : undefined;
      if (aligned) for (const [index, tool] of binding.live.entries()) this.liveToRegistered.set(tool, registered[index]!);
      this.tools = binding.live.map((tool) => this.wrap(tool));
    }

    private wrap(tool: AgentTool): AgentTool {
      const registeredTool = this.liveToRegistered.get(tool);
      if (!this.capable || registeredTool === undefined || this.metadata.get(registeredTool)?.resource === undefined) return tool;
      const bound = this;
      const wrapped: AgentTool = {
        ...tool,
        async execute(callId, args, signal, onUpdate) {
          const lease = bound.attempt?.leases.get(callId);
          if (lease === undefined || !lease.committed || !lease.admitted || isTerminalLeaseState(lease.state) || lease.state === "received") {
            return tool.execute(callId, args, signal, onUpdate);
          }
          const ordinaryAt = now();
          if (lease.state === "running" && lease.promise) {
            const outcome = await settleWithin(lease.promise, signal ?? new AbortController().signal, 0);
            if (!outcome.settled || signal?.aborted) {
              await bound.discard(lease, "signal", { reexecute: "ordinary" });
              return tool.execute(callId, args, signal, onUpdate);
            }
          }
          if (lease.state !== "settled") return tool.execute(callId, args, signal, onUpdate);
          // P1/P1'/P1''/P1''': revalidate the call (args digest) and the
          // resource — the bytes re-hashed here against the digest of the
          // bytes the read RETURNED, under the same identity; a touch changes
          // nothing, a stat proves nothing, a pre-read hash decides nothing.
          const digest = toolArgumentsDigest(args);
          const resource = lease.metadata.resource?.(bound.plainArgs(args) ?? {});
          if (digest !== lease.call.argsDigest || resource === undefined || lease.readDigest === undefined || !sameResourceVersion({ identity: lease.resource.identity, version: lease.readDigest }, resource)) {
            await bound.discard(lease, digest !== lease.call.argsDigest ? "args_changed" : "resource_changed", { reexecute: "ordinary" });
            return tool.execute(callId, args, signal, onUpdate);
          }
          // Exactly once: the lease is consumed here and nowhere else.
          const settledAt = lease.settledAt ?? ordinaryAt;
          const startedAt = lease.startedAt ?? ordinaryAt;
          lease.state = "published";
          buffered = Math.max(0, buffered - (lease.bytes ?? 0));
          append(EARLY_READ_PUBLISH_EVENT, {
            lease: lease.key, id: callId, attempt: lease.call.attemptId, ordinal: lease.call.ordinal,
            overlap_ms: Math.max(0, Math.round(Math.min(settledAt, ordinaryAt) - startedAt)),
            waited_ms: Math.max(0, Math.round(settledAt - ordinaryAt)),
            latency_ms: lease.latencyMs ?? 0, bytes: lease.bytes ?? 0, ...(lease.digest ? { digest: lease.digest } : {}),
            resource_version: lease.call.resourceVersion,
          });
          const result = lease.result;
          const error = lease.error;
          const failed = lease.failed === true;
          delete lease.result;
          delete lease.error;
          if (failed) throw error;
          return result as ToolResult;
        },
      };
      return wrapped;
    }

    private plainArgs(value: unknown): Readonly<Record<string, unknown>> | undefined {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      return value as Record<string, unknown>;
    }

    async observe(event: AgentEvent): Promise<void> {
      if (this.closed || !this.capable) return;
      if (event.type === "turn_start") {
        await this.closeAttempt("not_consumed");
        turn += 1;
        this.attempt = { id: `${nonce}:${turn}`, tracker: new StreamBoundaryTracker(finalCallCapability(this.binding.api)), leases: new Map(), keys: new Set(), barrier: undefined, committed: false };
        return;
      }
      const attempt = this.attempt;
      if (!attempt) return;
      if (event.type === "message_update" && event.message.role === "assistant") {
        for (const decision of attempt.tracker.observe(event.assistantMessageEvent)) {
          if (decision.kind === "confirmed") this.consider(attempt, decision.boundary);
          else {
            // B1'/B1'': a revoked call is a barrier exactly like an ineligible
            // one — whether or not a lease was ever issued for it — and every
            // later lease that already started is cancelled (its observations
            // stay; its result is never published).
            if (attempt.barrier === undefined) attempt.barrier = "revoked";
            const lease = attempt.leases.get(decision.id);
            if (lease) lease.revoked = true;
            if (lease && !isTerminalLeaseState(lease.state)) await this.discard(lease, discardReasonOf(decision.reason));
            for (const later of [...attempt.leases.values()].sort((a, b) => a.call.ordinal - b.call.ordinal)) {
              if (later.boundary.contentIndex > decision.contentIndex && !isTerminalLeaseState(later.state)) await this.discard(later, "after_revocation");
            }
          }
        }
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant" && !attempt.committed) {
        attempt.committed = true;
        const result = attempt.tracker.commit(event.message as AssistantMessage);
        const committed = new Set(result.committed.map((boundary) => boundary.id));
        for (const entry of result.revoked) {
          const lease = attempt.leases.get(entry.id);
          if (lease) lease.revoked = true;
          if (lease && !isTerminalLeaseState(lease.state)) await this.discard(lease, discardReasonOf(entry.reason));
        }
        for (const lease of attempt.leases.values()) {
          if (committed.has(lease.call.callId)) {
            lease.committed = true;
            // P1'': the stat fingerprint is an early-discard HINT — a moved one
            // re-hashes the bytes now, before Pi's point, and discards a
            // changed digest (a touch keeps its bytes and its lease, P1'); an
            // equal fingerprint proves nothing (the ordinary point re-hashes
            // the bytes either way).
            if (lease.state === "settled") {
              const args = this.plainArgs(lease.validated) ?? {};
              const hint = lease.metadata.fingerprint?.(args);
              if (hint === undefined || resourceFingerprintChanged(lease.resource, hint)) {
                const now = lease.metadata.resource?.(args);
                if (now === undefined || lease.readDigest === undefined || !sameResourceVersion({ identity: lease.resource.identity, version: lease.readDigest }, now)) await this.discard(lease, "resource_changed", { reexecute: "ordinary", hint: "fingerprint" });
              }
            }
            continue;
          }
          lease.revoked = true;
          if (!isTerminalLeaseState(lease.state)) await this.discard(lease, "absent");
        }
        return;
      }
      if (event.type === "turn_end" || event.type === "agent_end") {
        await this.closeAttempt("not_consumed");
      }
    }

    async settleAdmission(callId: string, args: unknown, blocked: boolean): Promise<void> {
      const lease = this.attempt?.leases.get(callId);
      if (!lease || isTerminalLeaseState(lease.state)) return;
      if (blocked) { await this.discard(lease, "pipeline_refused"); return; }
      if (!lease.committed || toolArgumentsDigest(args) !== lease.call.argsDigest) return;
      lease.admitted = true;
    }

    async idle(): Promise<void> {
      while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    }

    async dispose(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      await this.closeAttempt("surface_replaced");
    }

    private async closeAttempt(reason: EarlyDiscardReason): Promise<void> {
      const attempt = this.attempt;
      if (!attempt) return;
      for (const lease of attempt.leases.values()) {
        if (!isTerminalLeaseState(lease.state)) await this.discard(lease, reason);
      }
    }

    /** F1/L1/A1/B1/Q1: one confirmed boundary, in source order. */
    private consider(attempt: Attempt, boundary: ReceivedBoundary): void {
      const base = { attempt: attempt.id, ordinal: boundary.ordinal, name: boundary.name, id: boundary.id, args_digest: boundary.argsDigest };
      const ineligible = (reason: EarlyIneligibleReason, barrier = true): void => {
        if (barrier && attempt.barrier === undefined) attempt.barrier = reason;
        append(EARLY_READ_ADMISSION_EVENT, { ...base, lease: leaseKey({ attemptId: attempt.id, ordinal: boundary.ordinal, callId: boundary.id, registrationId: "", argsDigest: boundary.argsDigest, schemaDigest: "", resourceVersion: "" }), decision: "ineligible", reason, ...(attempt.barrier !== undefined && attempt.barrier !== reason ? { barrier: attempt.barrier } : {}) });
      };
      if (attempt.barrier !== undefined) { ineligible("barrier"); return; }
      const live = this.binding.live.filter((tool) => tool.name === boundary.name);
      const liveTool = live.length === 1 ? live[0] : undefined;
      const registeredTool = liveTool ? this.liveToRegistered.get(liveTool) : undefined;
      const metadata = registeredTool ? this.metadata.get(registeredTool) : undefined;
      if (!liveTool || !registeredTool || !metadata || this.generation === undefined) { ineligible("unregistered_tool"); return; }
      if (metadata.resource === undefined || metadata.cancellation !== "owned") { ineligible("no_version_identity"); return; }
      if (this.binding.requiresDurableForeground?.(boundary.name, boundary.args) === true) { ineligible("durable_foreground"); return; }
      let validated: unknown;
      try {
        const prepared = liveTool.prepareArguments ? liveTool.prepareArguments(boundary.args) : boundary.args;
        validated = validateToolArguments(liveTool as never, { type: "toolCall", id: boundary.id, name: boundary.name, arguments: prepared as Record<string, unknown> } as never);
      } catch {
        ineligible("invalid_arguments");
        return;
      }
      const plain = this.plainArgs(validated);
      const resource = plain ? metadata.resource(plain) : undefined;
      if (!resource) { ineligible("no_resource_version"); return; }
      const argsDigest = toolArgumentsDigest(validated);
      const call: ReceivedCall = {
        attemptId: attempt.id, ordinal: boundary.ordinal, callId: boundary.id,
        registrationId: `${this.generation}:${registeredTool.name}`, argsDigest, schemaDigest: schemaDigestOf(liveTool.parameters), resourceVersion: resource.version,
      };
      const key = leaseKey(call);
      if (attempt.keys.has(key) || attempt.leases.has(boundary.id)) {
        const twin = attempt.leases.get(boundary.id);
        if (twin && !isTerminalLeaseState(twin.state)) void this.discard(twin, "revised");
        ineligible("duplicate_identity");
        return;
      }
      if (running >= concurrency) { ineligible("concurrency_exhausted"); return; }
      if (buffered >= bufferBytes) { ineligible("concurrency_exhausted"); return; }
      // A1'/B1': the attempt's earlier calls the ordinary guard will admit
      // before this one — every lease (a refused preview, an exhausted buffer
      // and a revoked call alike: the guard counts the committed call as it
      // is committed) — replayed onto the preview's shadow.
      const prior = [...attempt.leases.values()].filter((entry) => entry.call.ordinal < boundary.ordinal)
        .sort((a, b) => a.call.ordinal - b.call.ordinal).map((entry) => ({ name: entry.boundary.name, id: entry.call.callId, args: entry.validated }));
      const request = { name: boundary.name, id: boundary.id, args: validated, attempt: attempt.id, ordinal: boundary.ordinal, lease: key, registration: call.registrationId, schemaDigest: call.schemaDigest, resource, prior };
      let admission: EarlyAdmission | undefined;
      try {
        admission = this.binding.admit(request);
      } catch {
        admission = undefined;
      }
      // M1: a malformed admission (a throw, an empty or foreign record) is
      // never a lease: the ordinary path admits the call from scratch.
      if (admission === undefined || typeof admission !== "object" || admission.record === undefined || admission.record.id !== boundary.id || admission.record.name !== boundary.name) {
        ineligible("admission_failed");
        return;
      }
      const lease: Lease = { key, call, boundary, live: liveTool, metadata, resource, validated, admission, controller: new AbortController(), state: "received", committed: false, admitted: false, revoked: false };
      attempt.keys.add(key);
      attempt.leases.set(boundary.id, lease);
      if (admission.block) {
        // Refused by the pipeline: the decision is what the ordinary point reuses; nothing runs early.
        return;
      }
      lease.state = nextLeaseState(lease.state, "authorized") ?? lease.state;
      this.start(lease);
    }

    private start(lease: Lease): void {
      const started = now();
      lease.state = "running";
      lease.startedAt = started;
      running += 1;
      // R3': the model's spelling is on the tool/call row; the resolved path
      // is never text here — the identity (device:inode) and the digest are.
      const recorded = append(EARLY_READ_START_EVENT, {
        lease: lease.key, id: lease.call.callId, attempt: lease.call.attemptId, ordinal: lease.call.ordinal, name: lease.boundary.name,
        registration: lease.call.registrationId, resource_identity: lease.resource.identity, resource_version: lease.call.resourceVersion, active: running,
      });
      if (!recorded) {
        // An observation that could not be recorded starts nothing (constitution 1).
        running -= 1;
        lease.state = "discarded";
        return;
      }
      const execution = Promise.resolve().then(() => runEarlyExecution(lease.key, () => lease.live.execute(lease.call.callId, lease.validated as never, lease.controller.signal)));
      const settled = execution.then(
        (value) => this.settle(lease, started, value, undefined, false),
        (error) => this.settle(lease, started, undefined, error, true),
      );
      lease.promise = settled;
      this.inFlight.add(settled);
      void settled.finally(() => this.inFlight.delete(settled));
    }

    private settle(lease: Lease, started: number, value: ToolResult | undefined, error: unknown, failed: boolean): void {
      const latencyMs = Math.max(0, Math.round(now() - started));
      lease.latencyMs = latencyMs;
      lease.settledAt = now();
      if (lease.state !== "running") {
        // Cancelled meanwhile: the canceller records the outcome (settled within the grace, or late).
        running = Math.max(0, running - 1);
        if (lease.state === "unresolved") append(EARLY_READ_DISCARD_EVENT, { lease: lease.key, id: lease.call.callId, attempt: lease.call.attemptId, outcome: "late_settled", late: failed ? "failed" : "settled", delivered: false, latency_ms: latencyMs });
        return;
      }
      // The slot is released here, whatever follows (Q1''').
      running = Math.max(0, running - 1);
      // Q1''': redaction walks every field — a getter that throws there is the
      // same unaccountable result, never a rejection that leaks the slot.
      let safe: ReturnType<typeof safeToolResultInput<ToolResult>> | undefined;
      let redactionFailed = false;
      try {
        safe = failed ? undefined : safeToolResultInput(value as ToolResult);
      } catch {
        redactionFailed = true;
      }
      const text = safe ? textOf(safe.result) : "";
      // Q1'/Q1''/Q1''': the whole result counts against the bound, and only a
      // trustworthy count may settle a lease.
      // The lease holds the RAW result by reference, so the raw result is what
      // is accounted (a symbol key or a bigint that redaction would drop still
      // counts); a redaction that threw is unaccountable too, by the cause the
      // walk can see or else the getter that threw.
      const rawAccounting = failed ? { bytes: 0, accountable: true as const } : accountResult(value);
      const accounting = redactionFailed && rawAccounting.accountable
        ? { bytes: rawAccounting.bytes, accountable: false as const, reason: "throwing_getter" as const }
        : rawAccounting;
      const bytes = accounting.bytes;
      const textBytes = utf8Bytes(text);
      const digest = sha256Text(text);
      const base = { lease: lease.key, id: lease.call.callId, attempt: lease.call.attemptId, ordinal: lease.call.ordinal };
      // B1'': every discard, whichever path, is a barrier for what still streams.
      const barrier = (): void => { const attempt = this.attempt; if (attempt && attempt.leases.get(lease.call.callId) === lease && attempt.barrier === undefined) attempt.barrier = "revoked"; };
      if (!accounting.accountable) {
        lease.state = "discarded";
        barrier();
        append(EARLY_READ_DISCARD_EVENT, { ...base, reason: "unaccountable", cause: accounting.reason, termination: "settled", latency_ms: latencyMs, bytes, reexecute: "ordinary" });
        return;
      }
      if (!failed && buffered + bytes > bufferBytes) {
        lease.state = "discarded";
        barrier();
        append(EARLY_READ_DISCARD_EVENT, { ...base, reason: "buffer_exhausted", termination: "settled", latency_ms: latencyMs, bytes, digest, reexecute: "ordinary" });
        return;
      }
      // P1''': the version is the bytes the read returned; a read that states
      // none (a failure, an error, a tool without the versioned hook) cannot
      // be adopted — the ordinary path runs it.
      const version = failed ? undefined : readVersionOf(value);
      if (version === undefined) {
        // The observation stays (a settle row saying it failed or stated no
        // version); the lease is then discarded and the ordinary path runs.
        append(EARLY_READ_SETTLE_EVENT, { ...base, latency_ms: latencyMs, bytes, text_bytes: textBytes, digest, error: failed || (value as { isError?: unknown } | undefined)?.isError === true, buffered_bytes: buffered });
        lease.state = "discarded";
        barrier();
        append(EARLY_READ_DISCARD_EVENT, { ...base, reason: "unversioned_read", termination: "settled", latency_ms: latencyMs, bytes, digest, reexecute: "ordinary" });
        return;
      }
      lease.state = "settled";
      lease.bytes = bytes;
      lease.digest = digest;
      lease.readDigest = version.digest;
      lease.failed = failed;
      if (failed) lease.error = error; else lease.result = value;
      buffered += bytes;
      // R3': no tool text on a row of this family — a failure's words may
      // name a resolved path; the model gets them through the ordinary path.
      append(EARLY_READ_SETTLE_EVENT, {
        ...base, latency_ms: latencyMs, bytes, text_bytes: textBytes, digest, read_version: version.digest, read_bytes: version.bytes,
        error: (value as { isError?: unknown } | undefined)?.isError === true,
        buffered_bytes: buffered,
      });
    }

    /** C1: discard, with proven cancellation of an owned read or an unresolved record. */
    private async discard(lease: Lease, reason: EarlyDiscardReason, extra: Record<string, unknown> = {}): Promise<void> {
      if (isTerminalLeaseState(lease.state)) return;
      // B1': a discarded call is a barrier for whatever the attempt still streams.
      const attempt = this.attempt;
      if (attempt && attempt.leases.get(lease.call.callId) === lease && attempt.barrier === undefined) attempt.barrier = "revoked";
      const base = { lease: lease.key, id: lease.call.callId, attempt: lease.call.attemptId, ordinal: lease.call.ordinal, reason, ...extra };
      if (lease.state === "running" && lease.promise) {
        lease.state = "discarded";
        lease.controller.abort();
        const outcome = await settleWithin(lease.promise, lease.controller.signal, settleGraceMs);
        if (outcome.settled) {
          append(EARLY_READ_DISCARD_EVENT, { ...base, termination: "settled", latency_ms: lease.latencyMs ?? 0 });
        } else {
          lease.state = "unresolved";
          append(EARLY_READ_DISCARD_EVENT, { ...base, termination: "unresolved", owner: RECEIVED_TOOL_EXECUTION_OWNER, cleanup: "settles_in_process", grace_ms: settleGraceMs });
        }
        return;
      }
      const wasSettled = lease.state === "settled";
      lease.state = "discarded";
      if (wasSettled) buffered = Math.max(0, buffered - (lease.bytes ?? 0));
      delete lease.result;
      delete lease.error;
      append(EARLY_READ_DISCARD_EVENT, { ...base, termination: wasSettled ? "settled" : "not_started", ...(wasSettled ? { latency_ms: lease.latencyMs ?? 0, bytes: lease.bytes ?? 0, ...(lease.digest ? { digest: lease.digest } : {}) } : {}) });
    }
  }

  return {
    bind(binding) {
      if (disposed) throw new Error("received_tool_execution is disposed");
      const previous = current;
      if (previous) void previous.dispose();
      const bound = new Bound(binding);
      current = bound;
      return bound;
    },
    snapshot: () => ({ running, bufferedBytes: buffered, bound: current !== undefined }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await current?.dispose();
      current = undefined;
    },
  };
}

/** C1 restart: discard, from rows alone, the leases a previous process left open. */
export function reconcileEarlyReadLeases(log: EventLog): number {
  if (log.isReadOnly) return 0;
  let discarded = 0;
  for (const open of openEarlyReadLeases(log.events)) {
    log.append({ kind: "observe", name: EARLY_READ_DISCARD_EVENT, payload: { lease: open.lease, id: open.id, attempt: open.attempt, reason: "restart", termination: open.state === "running" ? "unresolved" : "settled", owner: RECEIVED_TOOL_EXECUTION_OWNER, cleanup: "process_exited" } });
    discarded += 1;
  }
  return discarded;
}

export const plugin: PluginModule = {
  id: "received-tool-execution",
  claims: [
    { key: RECEIVED_TOOL_EXECUTION_KEY, role: "definition" },
    { key: RECEIVED_TOOL_EXECUTION_KEY, role: "provider" },
  ],
  activate(ctx: HostContext) {
    if (ctx.log.isReadOnly) {
      return ctx.log.events.some((event) => event.name === "plugin/load" && event.payload.id === "received-tool-execution")
        ? { active: true as const }
        : { active: false as const, reason: "not loaded in the recorded run", kind: "not_configured" as const };
    }
    if (!enabled(process.env[EARLY_READS_ENV])) return { active: false as const, reason: `${EARLY_READS_ENV} is not set`, kind: "not_configured" as const };
    return { active: true as const };
  },
  register(ctx: HostContext) {
    const service = createReceivedToolExecution(ctx);
    ctx.define(RECEIVED_TOOL_EXECUTION_KEY, { visibility: "host_only", origin: "received-tool-execution" });
    ctx.provide(RECEIVED_TOOL_EXECUTION_KEY, service);
    ctx.effect(() => () => { void service.dispose(); });
    reconcileEarlyReadLeases(ctx.log);
  },
};
