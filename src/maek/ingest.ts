import { BlobStore } from "../host/blob-store.ts";
import { assertNoSecrets } from "../host/redact.ts";
import type { EventRecord } from "../host/schema.ts";
import { digestRows, isDecisionType, observationId } from "./hash.ts";
import type {
  DecisionRecord,
  EvidenceSnapshot,
  FaultRecord,
  FaultResolutionRecord,
  MaekObservation,
  MaekRowKind,
  MaekSource,
} from "./types.ts";

export class MaekIntegrityError extends Error {
  readonly name = "MaekIntegrityError";

  constructor(
    readonly stage: string,
    readonly ingestSeq?: number,
  ) {
    super(`maek integrity failure at ${stage}${ingestSeq === undefined ? "" : ` (ingest seq ${ingestSeq})`}`);
  }
}

export function recordedObservations(input: {
  readonly events: readonly EventRecord[];
  readonly sessionId: string;
  readonly store: BlobStore;
}): MaekObservation[] {
  const out: MaekObservation[] = [];
  for (const ingest of input.events) {
    if (ingest.name !== "maek/ingest") {
      continue;
    }
    out.push(readObservation(input.events, input.sessionId, input.store, ingest));
  }
  return out;
}

export function observationPayload(observation: MaekObservation): Record<string, unknown> {
  return {
    kind: observation.kind,
    row_id: primaryId(observation),
    result_digest: digestRows(observation.row),
    source_session_id: observation.source.session_id,
    source_seq_start: observation.source.seq_start,
    source_seq_end: observation.source.seq_end,
    source_hash: observation.source.source_hash,
    ...(observation.source.source_blob ? { source_blob: observation.source.source_blob } : {}),
  };
}

export function observationKey(observation: MaekObservation): string {
  return `${observation.kind}:${primaryId(observation)}`;
}

function readObservation(
  events: readonly EventRecord[],
  sessionId: string,
  store: BlobStore,
  ingest: EventRecord,
): MaekObservation {
  const kind = readKind(ingest.payload.kind, ingest.seq);
  const source = readSource(events, sessionId, ingest);
  if (source.source_blob) {
    const sourceBody = getBlob(store, source.source_blob, "source_blob", ingest.seq);
    assertNoSecrets(sourceBody);
  }
  const blob = requiredString(ingest.payload.blob, "row_blob", ingest.seq);
  const body = getBlob(store, blob, "row_blob", ingest.seq);
  const parsed = parseBody(body, ingest.seq);
  assertNoSecrets(parsed);
  const observation = parseObservation(kind, parsed, source, ingest.seq);
  const rowId = requiredString(ingest.payload.row_id, "row_id", ingest.seq);
  if (primaryId(observation) !== rowId || observationId(kind, source) !== rowId) {
    throw new MaekIntegrityError("row_id", ingest.seq);
  }
  const expectedDigest = requiredString(ingest.payload.result_digest, "result_digest", ingest.seq);
  if (digestRows(observation.row) !== expectedDigest) {
    throw new MaekIntegrityError("row_digest", ingest.seq);
  }
  if (observation.kind === "fault" && observation.row.blob_digest !== source.source_blob) {
    throw new MaekIntegrityError("fault_source_blob", ingest.seq);
  }
  return observation;
}

function readSource(events: readonly EventRecord[], sessionId: string, ingest: EventRecord): MaekSource {
  const sourceSession = requiredString(ingest.payload.source_session_id, "source_session", ingest.seq);
  if (sourceSession !== sessionId) {
    throw new MaekIntegrityError("source_session", ingest.seq);
  }
  const seqStart = requiredPositiveInteger(ingest.payload.source_seq_start, "source_seq_start", ingest.seq);
  const seqEnd = requiredPositiveInteger(ingest.payload.source_seq_end, "source_seq_end", ingest.seq);
  if (seqStart > seqEnd || seqEnd >= ingest.seq) {
    throw new MaekIntegrityError("source_range", ingest.seq);
  }
  const start = events[seqStart - 1];
  const end = events[seqEnd - 1];
  if (!start || start.seq !== seqStart || !end || end.seq !== seqEnd) {
    throw new MaekIntegrityError("source_event", ingest.seq);
  }
  const sourceHash = requiredString(ingest.payload.source_hash, "source_hash", ingest.seq);
  if (end.hash !== sourceHash) {
    throw new MaekIntegrityError("source_hash", ingest.seq);
  }
  const sourceBlob = typeof ingest.payload.source_blob === "string" ? ingest.payload.source_blob : undefined;
  return {
    session_id: sourceSession,
    seq_start: seqStart,
    seq_end: seqEnd,
    source_hash: sourceHash,
    ...(sourceBlob ? { source_blob: sourceBlob } : {}),
  };
}

function parseObservation(
  kind: MaekRowKind,
  value: unknown,
  source: MaekSource,
  ingestSeq: number,
): MaekObservation {
  if (!isRecord(value)) {
    throw new MaekIntegrityError("row_shape", ingestSeq);
  }
  switch (kind) {
    case "decision":
      return { kind, row: parseDecision(value, ingestSeq), source };
    case "fault":
      return { kind, row: parseFault(value, ingestSeq), source };
    case "snapshot":
      return { kind, row: parseSnapshot(value, ingestSeq), source };
    case "fault_resolution":
      return { kind, row: parseResolution(value, ingestSeq), source };
  }
}

function parseDecision(value: Record<string, unknown>, seq: number): DecisionRecord {
  if (!isDecisionType(value.decision_type)) {
    throw new MaekIntegrityError("decision_type", seq);
  }
  const symbol = typeof value.symbol_id === "string" ? value.symbol_id : undefined;
  const constraints = value.constraints === undefined
    ? undefined
    : requiredObject(value.constraints, "decision_constraints", seq);
  return {
    decision_id: requiredString(value.decision_id, "decision_id", seq),
    session_id: requiredString(value.session_id, "decision_session", seq),
    turn_id: requiredInteger(value.turn_id, "decision_turn", seq),
    ...(symbol ? { symbol_id: symbol } : {}),
    decision_type: value.decision_type,
    rationale: requiredString(value.rationale, "decision_rationale", seq),
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function parseFault(value: Record<string, unknown>, seq: number): FaultRecord {
  const exitCode = value.exit_code === "missing" ? "missing" : requiredInteger(value.exit_code, "fault_exit", seq);
  const commandDigest = value.command_digest === undefined
    ? undefined
    : requiredDigest(value.command_digest, "fault_command_digest", seq);
  return {
    fault_id: requiredString(value.fault_id, "fault_id", seq),
    // Historical L1 rows could contain an empty display hint. The immutable
    // row digest still protects those bytes, so rebuild must preserve them.
    command: stringIncludingEmpty(value.command, "fault_command", seq),
    ...(commandDigest ? { command_digest: commandDigest } : {}),
    exit_code: exitCode,
    fault_excerpt: requiredString(value.fault_excerpt, "fault_excerpt", seq),
    blob_digest: requiredString(value.blob_digest, "fault_blob", seq),
  };
}

function parseSnapshot(value: Record<string, unknown>, seq: number): EvidenceSnapshot {
  return {
    snapshot_id: requiredString(value.snapshot_id, "snapshot_id", seq),
    session_id: requiredString(value.session_id, "snapshot_session", seq),
    prefix_hash: requiredString(value.prefix_hash, "snapshot_prefix", seq),
    blob_digest: requiredString(value.blob_digest, "snapshot_blob", seq),
  };
}

function parseResolution(value: Record<string, unknown>, seq: number): FaultResolutionRecord {
  if (value.outcome !== "GREEN" && value.outcome !== "FINALIZED") {
    throw new MaekIntegrityError("resolution_outcome", seq);
  }
  return {
    resolution_id: requiredString(value.resolution_id, "resolution_id", seq),
    fault_id: requiredString(value.fault_id, "resolution_fault", seq),
    session_id: requiredString(value.session_id, "resolution_session", seq),
    outcome: value.outcome,
    reference: requiredString(value.reference, "resolution_reference", seq),
  };
}

function primaryId(observation: MaekObservation): string {
  switch (observation.kind) {
    case "decision":
      return observation.row.decision_id;
    case "fault":
      return observation.row.fault_id;
    case "snapshot":
      return observation.row.snapshot_id;
    case "fault_resolution":
      return observation.row.resolution_id;
  }
}

function readKind(value: unknown, seq: number): MaekRowKind {
  if (value === "decision" || value === "fault" || value === "snapshot" || value === "fault_resolution") {
    return value;
  }
  throw new MaekIntegrityError("kind", seq);
}

function getBlob(store: BlobStore, digest: string, stage: string, seq: number): string {
  try {
    return store.get(digest);
  } catch (error) {
    if (error instanceof Error) {
      throw new MaekIntegrityError(stage, seq);
    }
    throw error;
  }
}

function parseBody(body: string, seq: number): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new MaekIntegrityError("row_json", seq);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredObject(value: unknown, stage: string, seq: number): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new MaekIntegrityError(stage, seq);
  return value;
}

function requiredString(value: unknown, stage: string, seq: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MaekIntegrityError(stage, seq);
  }
  return value;
}

function stringIncludingEmpty(value: unknown, stage: string, seq: number): string {
  if (typeof value !== "string") throw new MaekIntegrityError(stage, seq);
  return value;
}

function requiredDigest(value: unknown, stage: string, seq: number): string {
  const digest = requiredString(value, stage, seq);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new MaekIntegrityError(stage, seq);
  return digest;
}

function requiredInteger(value: unknown, stage: string, seq: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MaekIntegrityError(stage, seq);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, stage: string, seq: number): number {
  const integer = requiredInteger(value, stage, seq);
  if (integer < 1) {
    throw new MaekIntegrityError(stage, seq);
  }
  return integer;
}
