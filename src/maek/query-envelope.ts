import type { BlobStore } from "../host/blob-store.ts";
import {
  GENESIS_HASH,
  projectSessionReplaySchemas,
  type EventRecord,
} from "../host/schema.ts";
import { digestRows } from "./hash.ts";

const DIGEST = /^[a-f0-9]{64}$/u;
const MODERN_KEYS = [
  "blob",
  "blob_bytes",
  "format",
  "kind",
  "query",
  "result_digest",
  "row_count",
  "source_hash",
  "source_seq",
] as const;

export type LegacyMaekQueryReference = {
  readonly query: string;
  readonly result_digest: string;
};

export type MaekQueryReferenceV1 = {
  readonly format: 1;
  readonly kind: "decisions" | "faults";
  readonly query: string;
  readonly result_digest: string;
  readonly row_count: number;
  readonly source_seq: number;
  readonly source_hash: string;
  readonly blob: string;
  readonly blob_bytes: number;
};

export type MaekQueryReference = LegacyMaekQueryReference | MaekQueryReferenceV1;

export interface MaekQuerySchemaContext {
  readonly featureStart: number | undefined;
}

export class MaekQueryEnvelopeError extends Error {
  readonly name = "MaekQueryEnvelopeError";
}

/** Project the replay-digest surface. Historical envelopes deliberately keep
 * their two-field shape so old replay digests remain stable. */
export function projectMaekQueryReference(
  event: EventRecord,
  events: readonly EventRecord[],
  schema?: MaekQuerySchemaContext,
): MaekQueryReference {
  if (event.payload.format === undefined) {
    const featureStart = schema === undefined
      ? projectSessionReplaySchemas(events).featureStart.get("maek-query-v1")
      : schema.featureStart;
    if (featureStart !== undefined && event.seq > featureStart) {
      throw failure(event, "format 1 required by sealed maek-query-v1 feature");
    }
    return {
      query: typeof event.payload.query === "string" ? event.payload.query : "",
      result_digest: typeof event.payload.result_digest === "string" ? event.payload.result_digest : "",
    };
  }
  if (event.payload.format !== 1) {
    throw failure(event, "format unsupported");
  }
  assertModernPayload(event, events);
  return {
    format: 1,
    kind: event.payload.kind as "decisions" | "faults",
    query: event.payload.query as string,
    result_digest: event.payload.result_digest as string,
    row_count: event.payload.row_count as number,
    source_seq: event.payload.source_seq as number,
    source_hash: event.payload.source_hash as string,
    blob: event.payload.blob as string,
    blob_bytes: event.payload.blob_bytes as number,
  };
}

/** Validate and decode one direct-replay envelope. BlobStore verifies the
 * content address; this layer binds its typed row semantics and source head. */
export function readMaekQueryEnvelope(input: {
  readonly event: EventRecord;
  readonly events: readonly EventRecord[];
  readonly store: BlobStore;
  readonly schema?: MaekQuerySchemaContext;
}): { readonly reference: MaekQueryReference; readonly rows: unknown[] } {
  const { event, events, store, schema } = input;
  if (event.kind !== "observe") throw failure(event, "event kind must be observe");
  const reference = projectMaekQueryReference(event, events, schema);
  const payload = event.payload;
  requiredDigest(payload.query, event, "query");
  const resultDigest = requiredDigest(payload.result_digest, event, "result_digest");
  const blob = requiredDigest(payload.blob, event, "blob");
  // Legacy references are projected narrowly, but their actual replay
  // envelope is still held to the same digest grammar.
  let body: string;
  try {
    body = store.get(blob);
  } catch {
    // BlobStore diagnostics contain its absolute root. Direct replay errors
    // are an operator surface, so retain only the semantic failure class.
    throw failure(event, "blob unavailable or integrity mismatch");
  }
  if (payload.blob_bytes !== undefined &&
    (!isNonNegativeInteger(payload.blob_bytes) || payload.blob_bytes !== Buffer.byteLength(body, "utf8"))) {
    throw failure(event, "blob byte count mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw failure(event, "blob JSON invalid");
  }
  if (!Array.isArray(parsed)) throw failure(event, "rows missing");
  if (!isNonNegativeInteger(payload.row_count) || payload.row_count !== parsed.length) {
    throw failure(event, "row_count mismatch");
  }
  if (resultDigest !== digestRows(parsed)) throw failure(event, "result digest mismatch");
  return { reference, rows: parsed };
}

export function validateRecordedMaekQueries(
  events: readonly EventRecord[],
  store: BlobStore,
): void {
  const schema = {
    featureStart: projectSessionReplaySchemas(events).featureStart.get("maek-query-v1"),
  };
  for (const event of events) {
    if (event.name !== "maek/query") continue;
    readMaekQueryEnvelope({ event, events, store, schema });
  }
}

function assertModernPayload(event: EventRecord, events: readonly EventRecord[]): void {
  const keys = Object.keys(event.payload).sort();
  if (keys.length !== MODERN_KEYS.length || MODERN_KEYS.some((key, index) => keys[index] !== key)) {
    throw failure(event, "v1 payload fields mismatch");
  }
  if (event.kind !== "observe") throw failure(event, "event kind must be observe");
  if (event.payload.kind !== "decisions" && event.payload.kind !== "faults") {
    throw failure(event, "query kind invalid");
  }
  requiredDigest(event.payload.query, event, "query");
  requiredDigest(event.payload.result_digest, event, "result_digest");
  requiredDigest(event.payload.blob, event, "blob");
  if (!isNonNegativeInteger(event.payload.row_count)) throw failure(event, "row_count invalid");
  if (!isNonNegativeInteger(event.payload.blob_bytes)) throw failure(event, "blob_bytes invalid");

  const sourceSeq = event.payload.source_seq;
  const sourceHash = requiredDigest(event.payload.source_hash, event, "source_hash");
  if (!isNonNegativeInteger(sourceSeq) || sourceSeq >= event.seq) {
    throw failure(event, "source head sequence invalid");
  }
  if (sourceSeq === 0) {
    if (sourceHash !== GENESIS_HASH) throw failure(event, "source head hash mismatch");
    return;
  }
  const source = events[sourceSeq - 1];
  if (!source || source.seq !== sourceSeq || source.hash !== sourceHash) {
    throw failure(event, "source head hash mismatch");
  }
}

function requiredDigest(value: unknown, event: EventRecord, field: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw failure(event, `${field} invalid`);
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function failure(event: EventRecord, reason: string): MaekQueryEnvelopeError {
  return new MaekQueryEnvelopeError(`maek/query seq ${event.seq}: ${reason}`);
}
