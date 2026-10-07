import { basename, dirname } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../host/canonical.ts";
import { auditReplay, parseReplayEvents } from "../../host/replay-audit.ts";
import { GENESIS_HASH, projectSessionReplaySchemas } from "../../host/schema.ts";
import { EventLog, withEventLogSnapshot } from "../../host/event-log.ts";
import { collectReferencedBlobs } from "../../host/blob-store.ts";
import { parseStoredFile, partsClosure, storedFileIntact, storedName } from "../../host/blob-parts.ts";
import { assertReplayBlobs } from "../../host/replay-preflight.ts";
import { readEvidenceBodies } from "../../work/evidence/bodies.ts";
import type { EvidenceBodies } from "../../work/evidence/projection.ts";
import { researchHash, researchRead } from "./environment.ts";
import { sha256Schema } from "./schema.ts";

const dimensionsSchema = z.strictObject({ structural: z.string(), semantic: z.string(), unsupported: z.array(z.string()),
  provider_input: z.string(), observation_coverage: z.string(), projection_sha256: sha256Schema.nullable() });
export const logCheckpointSchema = z.strictObject({ schema_version: z.literal(1), kind: z.literal("original-log-checkpoint"),
  raw_sha256: sha256Schema, raw_bytes: z.number().int().nonnegative(), event_count: z.number().int().nonnegative(), tail_chain: sha256Schema,
  schema_generations: z.array(z.unknown()), prefix_hashes: z.array(z.string()), blob_sha256: z.array(sha256Schema), dimensions: dimensionsSchema });
export type LogCheckpoint = z.infer<typeof logCheckpointSchema>;

/** Pure raw identity and dimension snapshot. It does not authenticate the
 * supplied external checkpoint's origin or invent unsupported replay coverage. */
export function createLogCheckpoint(raw: string, bodies: EvidenceBodies): LogCheckpoint {
  const events = parseReplayEvents(raw), audit = auditReplay(events, bodies);
  return { schema_version: 1, kind: "original-log-checkpoint", raw_sha256: researchHash(raw), raw_bytes: Buffer.byteLength(raw),
    event_count: events.length, tail_chain: events.at(-1)?.hash ?? GENESIS_HASH,
    schema_generations: projectSessionReplaySchemas(events).references,
    prefix_hashes: events.filter(row => row.name === "prompt/seal").map(row => String(row.payload.prefix_hash)),
    blob_sha256: [...collectReferencedBlobs(events)].sort(), dimensions: { structural: audit.structural.status,
      semantic: audit.semantic.status, unsupported: audit.semantic.unsupported, provider_input: audit.providerInput.status,
      observation_coverage: audit.observationCoverage.status, projection_sha256: audit.projection.digest ?? null } };
}
export function compareLogCheckpoint(raw: string, bodies: EvidenceBodies, expected: unknown) {
  try {
    const anchor = logCheckpointSchema.parse(expected), actual = createLogCheckpoint(raw, bodies);
    const differences = Object.keys(anchor).filter(key => canonicalJson(anchor[key as keyof LogCheckpoint]) !== canonicalJson(actual[key as keyof LogCheckpoint]));
    return { status: differences.length ? "mismatched" as const : "matched" as const, differences,
      trust: "operator-supplied external reference; origin not self-authenticated", expected_raw_sha256: anchor.raw_sha256, actual_raw_sha256: actual.raw_sha256 };
  } catch { return { status: "failed" as const, differences: ["invalid input or checkpoint"], trust: "external reference required" }; }
}

/** Cooperating appenders share the existing log lock. Noncooperating writes
 * are detected by a second exact read of the log and every referenced blob. */
export type SessionSnapshot = ReturnType<typeof readSessionSnapshot>;
export function snapshotSessionBytes(logPath: string): SessionSnapshot;
export function snapshotSessionBytes<T>(logPath: string, consume: (snapshot: SessionSnapshot) => T): T;
export function snapshotSessionBytes<T>(logPath: string, consume?: (snapshot: SessionSnapshot) => T): SessionSnapshot | T {
  return withEventLogSnapshot(logPath, () => {
    const snapshot = readSessionSnapshot(logPath);
    return consume ? consume(snapshot) : snapshot;
  });
}
function readSessionSnapshot(logPath: string) {
    const bytes = researchRead(dirname(logPath), basename(logPath)), raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const events = parseReplayEvents(raw), log = new EventLog(logPath, { readOnly: true });
    if (canonicalJson(log.events) !== canonicalJson(events)) throw new Error("session changed during acquisition");
    assertReplayBlobs(log);
    const bodies = readEvidenceBodies(log), files = new Map<string, Buffer>([["events.jsonl", bytes]]);
    // Each referenced body's stored files: the whole body, or the manifests,
    // lists and parts of a body stored as parts (D53), each read once and
    // checked against its own digest (assertReplayBlobs checked above that
    // every body reassembles to its digest).
    const read = (name: string): Buffer | undefined => {
      const path = `blobs/${name}`;
      if (!files.has(path)) {
        try { files.set(path, researchRead(dirname(logPath), path)); } catch { return undefined; }
      }
      return files.get(path);
    };
    const seen = new Set<string>();
    for (const digest of collectReferencedBlobs(events)) {
      const whole = storedName(digest, "whole");
      const names = read(whole) ? [whole] : partsClosure(digest, name => read(name)?.toString("utf8"), seen);
      for (const name of names) {
        const [shard, file] = name.split("/"), stored = parseStoredFile(shard!, file!), body = read(name);
        if (!stored || !body || !storedFileIntact(stored.digest, stored.kind, body)) throw new Error("session blob integrity failed");
      }
    }
    for (const [path, body] of files) {
      const input = path === "events.jsonl" ? basename(logPath) : path;
      if (!researchRead(dirname(logPath), input).equals(body)) throw new Error("session grew or changed during acquisition");
    }
    return { bytes, events, bodies, files, checkpoint: createLogCheckpoint(raw, bodies) };
}
