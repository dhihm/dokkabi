import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import { assertNoSecrets } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";
import { observationId, sha256 } from "./hash.ts";
import type {
  DecisionRecord,
  FaultRecord,
  FaultResolutionRecord,
  MaekObservation,
  MaekSource,
} from "./types.ts";

type FaultObservation = Extract<MaekObservation, { readonly kind: "fault" }>;

interface TrackedFault {
  readonly observation: FaultObservation;
  readonly callId: string;
}

export interface HostObservationSync {
  readonly observations: MaekObservation[];
  /** Number of suffix events inspected by this sync. */
  readonly scanned: number;
}

export interface HostObservationProducer {
  sync(events: readonly EventRecord[]): HostObservationSync;
  /** Discard a speculative cursor after the caller fails to materialize rows. */
  reset(): void;
}

/** Incremental host producer. EventLog remains truth; these maps are only a
 * cursor over its immutable prefix and are discarded if that prefix changes. */
export function createHostObservationProducer(input: {
  readonly sessionId: string;
  readonly logPath?: string;
  readonly store?: BlobStore;
}): HostObservationProducer {
  const store = input.store ?? (input.logPath ? BlobStore.forSession(input.logPath) : undefined);
  if (!store) throw new Error("MAEK host producer needs a session blob store");

  let processed = 0;
  let prefixHash: string | undefined;
  const todos = new Map<string, EventRecord>();
  const starts = new Map<string, EventRecord>();
  const calls = new Map<string, EventRecord>();
  const results = new Map<string, EventRecord>();
  const unresolved = new Map<string, TrackedFault>();

  const reset = (): void => {
    processed = 0;
    prefixHash = undefined;
    todos.clear();
    starts.clear();
    calls.clear();
    results.clear();
    unresolved.clear();
  };

  return {
    reset,
    sync(events) {
      if (processed > events.length || (processed > 0 && events[processed - 1]?.hash !== prefixHash)) {
        reset();
      }
      const suffix = events.slice(processed);
      if (suffix.length === 0) return { observations: [], scanned: 0 };

      const observations: MaekObservation[] = [];
      for (const event of suffix) {
        if (event.name === "work/todo" && typeof event.payload.id === "string") {
          todos.set(event.payload.id, event);
          continue;
        }
        if (event.name === "tool/call" && typeof event.payload.id === "string") {
          calls.set(event.payload.id, event);
          if (!starts.has(event.payload.id)) starts.set(event.payload.id, event);
          continue;
        }
        if (event.name === "tool/start" && typeof event.payload.id === "string") {
          starts.set(event.payload.id, event);
          continue;
        }
        if (event.name === "tool/result" && typeof event.payload.id === "string") {
          results.set(event.payload.id, event);
          continue;
        }
        if (event.name === "work/clear" && typeof event.payload.todo === "string") {
          const todo = todos.get(event.payload.todo);
          if (todo) observations.push(completedWork(input.sessionId, todo, event));
          continue;
        }
        if (event.name === "tool/end") {
          const fault = diagnosedFault(input.sessionId, event, starts, calls, results, store);
          if (fault) {
            observations.push(fault);
            unresolved.set(fault.row.fault_id, { observation: fault, callId: String(event.payload.id) });
          }
          continue;
        }
        if (event.name === "work/case" && event.payload.status === "green") {
          for (const [faultId, tracked] of unresolved) {
            if (!greenMatchesFault(event, tracked)) continue;
            observations.push(greenResolution(input.sessionId, tracked.observation, event));
            unresolved.delete(faultId);
          }
          continue;
        }
        if (event.name === "distill/summary") {
          // A distilled campaign's repeated unresolved faults become durable
          // do-not-retry decisions (#117). Derived from the summary row, so
          // the decision is identical live and on replay.
          for (const pattern of distillFaultPatterns(event)) {
            observations.push(rejectDecision(input.sessionId, event, pattern));
          }
        }
        // A generic swarm/finalized row has no fault lineage. Treating it as a
        // resolution would turn an unrelated candidate into durable knowledge.
      }

      processed = events.length;
      prefixHash = events.at(-1)?.hash;
      observations.sort(
        (left, right) => left.source.seq_end - right.source.seq_end || left.kind.localeCompare(right.kind),
      );
      return { observations, scanned: suffix.length };
    },
  };
}

export function deriveHostObservations(input: {
  readonly events: readonly EventRecord[];
  readonly sessionId: string;
  readonly store: BlobStore;
}): MaekObservation[] {
  return createHostObservationProducer({ sessionId: input.sessionId, store: input.store })
    .sync(input.events).observations;
}

interface DistillFaultPatternRow {
  readonly command: string;
  readonly command_digest: string;
  readonly repeats: number;
}

function distillFaultPatterns(event: EventRecord): DistillFaultPatternRow[] {
  const raw = event.payload.fault_patterns;
  if (!Array.isArray(raw)) return [];
  const out: DistillFaultPatternRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const command = stringField(row.command);
    const commandDigest = stringField(row.command_digest);
    const repeats = typeof row.repeats === "number" ? row.repeats : 0;
    if (command === undefined || commandDigest === undefined || repeats < 2) continue;
    out.push({ command, command_digest: commandDigest, repeats });
  }
  return out;
}

function rejectDecision(sessionId: string, event: EventRecord, pattern: DistillFaultPatternRow): MaekObservation {
  const source = eventRange(sessionId, event, event);
  const row: DecisionRecord = {
    decision_id: observationId("decision", source),
    session_id: sessionId,
    turn_id: event.seq,
    symbol_id: pattern.command_digest,
    decision_type: "REJECT",
    rationale: `do-not-retry: ${pattern.command} failed ${pattern.repeats} times without resolution`,
    constraints: { repeats: pattern.repeats },
  };
  return { kind: "decision", row, source };
}

function completedWork(sessionId: string, todo: EventRecord, clear: EventRecord): MaekObservation {
  const source = eventRange(sessionId, todo, clear);
  const row: DecisionRecord = {
    decision_id: observationId("decision", source),
    session_id: sessionId,
    turn_id: clear.seq,
    symbol_id: String(todo.payload.id),
    decision_type: "COMPLETE_WORK",
    rationale: String(todo.payload.statement ?? todo.payload.title ?? todo.payload.id),
    constraints: {
      title: String(todo.payload.title ?? todo.payload.id),
      class: String(todo.payload.class ?? "missing"),
      plan: String(clear.payload.plan ?? "missing"),
    },
  };
  return { kind: "decision", row, source };
}

function diagnosedFault(
  sessionId: string,
  end: EventRecord,
  starts: ReadonlyMap<string, EventRecord>,
  calls: ReadonlyMap<string, EventRecord>,
  results: ReadonlyMap<string, EventRecord>,
  store: BlobStore,
): FaultObservation | undefined {
  if (
    end.payload.error !== true ||
    typeof end.payload.id !== "string" ||
    typeof end.payload.diagnosis !== "string" ||
    end.payload.diagnosis === "intended_red"
  ) {
    return undefined;
  }
  const start = starts.get(end.payload.id);
  const call = calls.get(end.payload.id);
  const result = results.get(end.payload.id);
  if (!start || !result) return undefined;

  const tool = stringField(start.payload.name) ?? stringField(end.payload.name) ?? "unknown";
  const commandDigest = fullCommandDigest(tool, call, start, end);
  const hint = stringField(start.payload.arg_hint)?.trim() ?? "";
  const command = hint || `tool:${safeToolName(tool)}:sha256:${commandDigest}`;
  const detail = typeof end.payload.diagnosis_detail === "string" ? end.payload.diagnosis_detail : end.payload.diagnosis;
  const body = resultBody(result, store);
  assertNoSecrets({ command, detail, body });
  const blob = typeof result.payload.blob === "string" ? result.payload.blob : store.put(body);
  const source = eventRange(sessionId, start, end, blob);
  const row: FaultRecord = {
    fault_id: observationId("fault", source),
    command,
    command_digest: commandDigest,
    exit_code: diagnosedExitCode(detail),
    fault_excerpt: detail,
    blob_digest: blob,
  };
  return { kind: "fault", row, source };
}

function fullCommandDigest(
  tool: string,
  call: EventRecord | undefined,
  start: EventRecord,
  end: EventRecord,
): string {
  const args = call?.payload.args;
  if (isRecord(args) && typeof args.command === "string") {
    return commandDigest(tool, args.command);
  }
  const argsDigest = stringField(end.payload.args_digest) ?? stringField(call?.payload.args_digest);
  if (argsDigest) return sha256(canonicalJson({ tool, args_digest: argsDigest }));
  const hint = stringField(start.payload.arg_hint) ?? "";
  return commandDigest(tool, hint);
}

function commandDigest(tool: string, command: string): string {
  return sha256(canonicalJson({ tool, command }));
}

function greenMatchesFault(event: EventRecord, tracked: TrackedFault): boolean {
  const explicitFault = stringField(event.payload.fault_id);
  if (explicitFault !== undefined) return explicitFault === tracked.observation.row.fault_id;
  const explicitCall = stringField(event.payload.tool_call_id) ?? stringField(event.payload.source_tool_id);
  if (explicitCall !== undefined) return explicitCall === tracked.callId;
  const explicitDigest = stringField(event.payload.command_digest);
  if (explicitDigest !== undefined) return explicitDigest === tracked.observation.row.command_digest;
  const command = stringField(event.payload.command);
  return command !== undefined && tracked.observation.row.command_digest === commandDigest("bash", command);
}

function greenResolution(sessionId: string, fault: FaultObservation, event: EventRecord): MaekObservation {
  const source: MaekSource = {
    session_id: sessionId,
    seq_start: fault.source.seq_start,
    seq_end: event.seq,
    source_hash: event.hash,
    source_blob: fault.row.blob_digest,
  };
  const row: FaultResolutionRecord = {
    resolution_id: observationId("fault_resolution", source),
    fault_id: fault.row.fault_id,
    session_id: sessionId,
    outcome: "GREEN",
    reference: String(event.payload.id ?? "missing"),
  };
  return { kind: "fault_resolution", row, source };
}

function eventRange(sessionId: string, start: EventRecord, end: EventRecord, sourceBlob?: string): MaekSource {
  return {
    session_id: sessionId,
    seq_start: start.seq,
    seq_end: end.seq,
    source_hash: end.hash,
    ...(sourceBlob ? { source_blob: sourceBlob } : {}),
  };
}

function resultBody(event: EventRecord, store: BlobStore): string {
  if (typeof event.payload.blob === "string") return store.get(event.payload.blob);
  if (typeof event.payload.raw === "string") return event.payload.raw;
  return typeof event.payload.text === "string" ? event.payload.text : "";
}

function diagnosedExitCode(detail: string): number | "missing" {
  const match = detail.match(/\bexit (\d+)\b/u);
  const value = match?.[1];
  return value === undefined ? "missing" : Number(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeToolName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return safe || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
