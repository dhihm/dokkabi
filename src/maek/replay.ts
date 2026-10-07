import { BlobStore } from "../host/blob-store.ts";
import type { EventLog } from "../host/event-log.ts";
import { projectSessionReplaySchemas, type EventRecord } from "../host/schema.ts";
import { digestQuery, isDecisionType } from "./hash.ts";
import { readMaekQueryEnvelope, type MaekQuerySchemaContext } from "./query-envelope.ts";
import type { DecisionRecord, FaultRecord, MaekService } from "./types.ts";

class MaekReplayError extends Error {
  readonly name = "MaekReplayError";
}

export function createReplayMaek(log: EventLog): MaekService {
  const events = log.events;
  const recorded = events.filter((event) => event.name === "maek/query");
  let cursor = 0;
  let closed = false;
  const store = BlobStore.forSession(log.path);
  const schema: MaekQuerySchemaContext = {
    featureStart: projectSessionReplaySchemas(events).featureStart.get("maek-query-v1"),
  };
  return {
    engine: "duckdb",
    async queryDecisions(text, options) {
      assertOpen(closed);
      const rows = replayRows(events, recorded, cursor, "decisions", text, options, store, schema).map(readDecision);
      cursor += 1;
      return rows;
    },
    async querySimilarFaults(input) {
      assertOpen(closed);
      const rows = replayRows(events, recorded, cursor, "faults", input.errorPattern, input, store, schema).map(readFault);
      cursor += 1;
      return rows;
    },
    async ingest() {
      // Recorded maek/ingest rows were consumed at initialization; a replay
      // never opens DuckDB and never projects new evidence.
      assertOpen(closed);
      return 0;
    },
    async close() {
      if (cursor !== recorded.length) {
        throw new MaekReplayError(`maek replay has ${recorded.length - cursor} unconsumed query envelope(s)`);
      }
      closed = true;
    },
  };
}

function replayRows(
  events: readonly EventRecord[],
  recorded: readonly EventRecord[],
  index: number,
  kind: string,
  query: string,
  options: unknown,
  store: BlobStore,
  schema: MaekQuerySchemaContext,
): unknown[] {
  const event = recorded[index];
  if (!event) {
    throw new MaekReplayError(`maek replay missing recorded query ${index}`);
  }
  if (event.kind !== "observe") throw new MaekReplayError(`maek replay event kind mismatch at ${index}: expected observe`);
  if (event.payload.kind !== kind) {
    throw new MaekReplayError(`maek replay kind mismatch at ${index}: expected ${kind}`);
  }
  const queryDigest = requiredDigest(event.payload.query, "query");
  if (queryDigest !== digestQuery(kind, query, options)) {
    throw new MaekReplayError("maek replay query digest mismatch");
  }
  try {
    return readMaekQueryEnvelope({ event, events, store, schema }).rows;
  } catch (error) {
    if (error instanceof Error) throw new MaekReplayError(error.message);
    throw error;
  }
}

function readDecision(value: unknown): DecisionRecord {
  if (!isRecord(value) || !isDecisionType(value.decision_type)) {
    throw new MaekReplayError("maek replay decision row invalid");
  }
  const symbol = typeof value.symbol_id === "string" ? value.symbol_id : undefined;
  const constraints = value.constraints === undefined ? undefined : readConstraints(value.constraints);
  return {
    decision_id: requiredString(value.decision_id, "decision_id"),
    session_id: requiredString(value.session_id, "session_id"),
    turn_id: requiredNumber(value.turn_id, "turn_id"),
    ...(symbol ? { symbol_id: symbol } : {}),
    decision_type: value.decision_type,
    rationale: requiredString(value.rationale, "rationale"),
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function readFault(value: unknown): FaultRecord {
  if (!isRecord(value)) {
    throw new MaekReplayError("maek replay fault row invalid");
  }
  const exitCode = value.exit_code === "missing" ? "missing" : requiredNumber(value.exit_code, "exit_code");
  const commandDigest = value.command_digest === undefined
    ? undefined
    : requiredDigest(value.command_digest, "command_digest");
  return {
    fault_id: requiredString(value.fault_id, "fault_id"),
    // Historical live queries can legitimately contain the legacy empty
    // display hint. The envelope digest still binds those exact bytes.
    command: stringIncludingEmpty(value.command, "command"),
    ...(commandDigest ? { command_digest: commandDigest } : {}),
    exit_code: exitCode,
    fault_excerpt: requiredString(value.fault_excerpt, "fault_excerpt"),
    blob_digest: requiredDigest(value.blob_digest, "blob_digest"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MaekReplayError(`maek replay ${field} missing`);
  }
  return value;
}

function stringIncludingEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MaekReplayError(`maek replay ${field} missing`);
  }
  return value;
}

function readConstraints(value: unknown): Readonly<Record<string, unknown>> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new MaekReplayError("maek replay constraints JSON invalid");
    }
  }
  if (!isRecord(parsed)) {
    throw new MaekReplayError("maek replay constraints object invalid");
  }
  return parsed;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MaekReplayError(`maek replay ${field} missing`);
  }
  return value;
}

function requiredDigest(value: unknown, field: string): string {
  const digest = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new MaekReplayError(`maek replay ${field} invalid`);
  }
  return digest;
}

function assertOpen(closed: boolean): void {
  if (closed) throw new MaekReplayError("maek replay service is closed");
}
