import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { BlobStore } from "./blob-store.ts";
import { canonicalJson } from "./canonical.ts";
import { EventLog } from "./event-log.ts";
import { hasCurrentSessionSchema, type EventRecord } from "./schema.ts";
import { assertSealEvent, frozenPrefixHash, toolSchemaSnapshot } from "./prefix.ts";
import { readBranchCheckpoint } from "./branch-checkpoint.ts";
import {
  appendProviderBody,
  assertCheckpointImportTargetHistory,
  CHECKPOINT_IMPORT_SCHEMA,
  CHECKPOINT_IMPORT_REASON,
  checkpointImportSourceBodyRows,
  checkpointImportStateMetadata,
  checkpointImportTransformationDigest,
  inputData,
  inputDigest,
  inputReference,
  liveProviderState,
  MAX_CHECKPOINT_IMPORT_BODIES,
  MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES,
  MAX_CHECKPOINT_IMPORT_EVENTS,
  PROVIDER_BODY_EVENTS,
  PROVIDER_INPUT_SCHEMA,
  ProviderInputError,
  requireProviderInput,
  validateImportedCheckpointSource,
  type CheckpointImportBundle,
  type ImportedCheckpointSource,
  type InputReference,
} from "./provider-input.ts";

/** R8-01 authenticated checkpoint input import (docs/desktop-branches-r8.md).
 * Three host-only operations: retain the current sealed prefix bytes, prepare
 * a portable evidence bundle from a verified checkpoint, and import that
 * bundle into a fresh child session under one declared transformation.
 *
 * The R7 checkpoint reader stays the sole source authority at preparation;
 * import never authorizes filesystem allocation, a decision, a model
 * invocation or UI capability, and this module reads no original parent path
 * during child reconstruction — only the prepared bundle and the child's own
 * log and blob store. */

const MAX_IMPORT_SESSION_BYTES = 256;
const MAX_IMPORT_SYSTEM_PROMPT_BYTES = 1024 * 1024;
const MAX_IMPORT_TOOLS = 4096;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

function record(value: unknown): Record<string, unknown> {
  requireProviderInput(value !== null && typeof value === "object" && !Array.isArray(value), "invalid import record");
  return value as Record<string, unknown>;
}

/** Fail with a sanitized refusal; never a stack path, secret or runtime id. */
function refuse(reason: string): never {
  throw new ProviderInputError(reason);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Store one canonical body: put, read back, fsync (the same durability the
 * ordinary provider body writer applies). */
function putRetainedBody(store: BlobStore, text: string): { blob: string; blob_bytes: number } {
  const blob = store.put(text);
  if (store.get(blob) !== text) refuse("retained import body acquisition differs");
  const path = store.pathOf(blob);
  fsyncPath(path);
  fsyncPath(dirname(path));
  fsyncPath(store.root);
  return { blob, blob_bytes: Buffer.byteLength(text) };
}

function lastRow(events: readonly EventRecord[], name: string): EventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.name === name) return events[index]!;
  }
  return undefined;
}

/** The confirmed metadata a completed (or exactly repeated) import returns. */
export interface CheckpointImportMetadata {
  session: string;
  source: { session: string; checkpoint: string; digest: string; head: { seq: number; hash: string } };
  intent: { seq: number };
  state: InputReference;
  ready: { seq: number };
  bundle: { blob: string; blob_bytes: number };
  removedFrames: number[];
  sourceMessagesDigest: string;
  transformedDigest: string;
  prefix: {
    kind: "identical" | "branch_scope";
    sourcePrefixHash: string;
    targetPrefixHash: string;
    transformation: string;
  };
}

// ---------------------------------------------------------------------------
// Retaining the current sealed prefix.
// ---------------------------------------------------------------------------

/** Retain the actual bytes of the prefix the active seal governs: verify the
 * seal against the given material, reuse an already-retained current binding
 * (same seal, same bytes), and otherwise write a normal `provider/prefix`
 * body bound to that seal. Never invents historical bytes, never changes a
 * seal, never issues a model request. The optional desktop checkpoint owner
 * calls this after boot, before settlement becomes available. */
export function retainSealedProviderPrefix(log: EventLog, material: { systemPrompt: string; tools: unknown[] }): InputReference {
  if (!material || typeof material !== "object") refuse("prefix material is missing");
  requireProviderInput(typeof material.systemPrompt === "string"
    && Buffer.byteLength(material.systemPrompt) <= MAX_IMPORT_SYSTEM_PROMPT_BYTES
    && Array.isArray(material.tools) && material.tools.length <= MAX_IMPORT_TOOLS,
    "prefix material exceeds its bounds");
  const data = inputData({ systemPrompt: material.systemPrompt, tools: material.tools }) as {
    systemPrompt: string; tools: unknown[];
  };
  const seal = lastRow(log.events, "prompt/seal");
  requireProviderInput(seal !== undefined, "no prompt seal is in force");
  try {
    assertSealEvent(seal);
  } catch {
    refuse("active seal is invalid");
  }
  requireProviderInput(seal.payload.prefix_hash === frozenPrefixHash({
    systemPrompt: data.systemPrompt,
    toolSchemas: toolSchemaSnapshot(data.tools as { name: string; description?: string }[]),
  }), "prefix material differs from the active seal");
  // The existing provider fold validates BEFORE any idempotence or append: a
  // log whose retained input does not fold refuses closed here — a prefix row
  // is never appended to repair or gloss over unreadable prior material.
  liveProviderState(log);
  const prior = lastRow(log.events, "provider/prefix");
  if (prior) {
    // The reused row is authenticated as the fold authenticates it: the full
    // envelope (digest, bytes, body identity) of the actual stored body.
    requireProviderInput(prior.kind === "observe" && typeof prior.payload.blob === "string"
      && prior.payload.body_digest === prior.payload.blob
      && typeof prior.payload.blob_bytes === "number", "retained prefix row envelope differs");
    let text: string;
    try {
      text = BlobStore.forSession(log.path).get(prior.payload.blob);
    } catch {
      refuse("retained prefix body is unavailable");
    }
    requireProviderInput(Buffer.byteLength(text) === prior.payload.blob_bytes,
      "retained prefix body bytes differ");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      refuse("retained prefix body is not JSON");
    }
    const body = record(parsed);
    requireProviderInput(body.version === 1 && typeof body.systemPrompt === "string"
      && Array.isArray(body.tools) && body.seal !== null && typeof body.seal === "object",
      "retained prefix body differs");
    const priorSeal = record(body.seal);
    if (priorSeal.seq === seal.seq && priorSeal.hash === seal.hash
      && body.systemPrompt === data.systemPrompt && sameJson(body.tools, data.tools)) {
      return inputReference(prior);
    }
    // Same bytes under an older seal are not current material: they are
    // retained anew below, bound to the seal now in force.
  }
  const row = appendProviderBody(log, "provider/prefix", { version: 1, systemPrompt: data.systemPrompt,
    tools: data.tools, seal: inputReference(seal) });
  return inputReference(row);
}

// ---------------------------------------------------------------------------
// Preparation: the portable evidence bundle.
// ---------------------------------------------------------------------------

/** Derive a closed, self-contained evidence bundle from one verified
 * checkpoint of the source session. The R7 reader is the authority here: it
 * re-verifies the receipt, manifest and every recorded fact from retained
 * storage. The bundle carries the source chain from genesis through this
 * checkpoint's ready row, the exact original text of every body the shared
 * source-body selection names in it, and the manifest — nothing from a
 * mutable parent path. The source log
 * is preserved byte-for-byte: preparation appends nothing. */
export function prepareCheckpointInputImport(
  sourceLog: EventLog,
  parentSession: string,
  checkpointId: string,
  checkpointDigest: string,
): CheckpointImportBundle {
  const receipt = readBranchCheckpoint(sourceLog, parentSession, checkpointId, checkpointDigest);
  if (receipt.manifest.coverage.providerInput !== "complete") {
    // A messages-only checkpoint stays incomplete even if newer prefix
    // material now exists above the captured boundary; history is never
    // filled from bytes recorded later.
    refuse("checkpoint import needs complete retained prefix material");
  }
  const ready = sourceLog.events.find(row => row.name === "branch/checkpoint_ready"
    && row.payload.id === checkpointId && row.payload.blob === checkpointDigest);
  requireProviderInput(ready !== undefined, "checkpoint import ready row is missing");
  const events = sourceLog.events.slice(0, ready.seq);
  requireProviderInput(events.length <= MAX_CHECKPOINT_IMPORT_EVENTS, "checkpoint import source exceeds its event bound");
  // Bounded depth: a source that is itself an imported child is refused
  // until nested evidence is explicitly supported.
  requireProviderInput(!events.some(row => row.name === "branch/import_intent" || row.name === "branch/import_ready"),
    "checkpoint import of an imported source is unsupported");
  // Every body the shared selection names over the carried chain — each
  // provider body and, under context-formal-work-v1, each retained formal
  // execution body within the captured head — as its exact original text:
  // the existing reader reassembles split bodies from their parts, and a
  // body it cannot acquire refuses preparation here, before any child
  // mutation — all-or-nothing, never a partially supported source.
  const store = BlobStore.forSession(sourceLog.path);
  const bodies: Array<{ digest: string; bytes: number; text: string }> = [];
  const seen = new Set<string>();
  for (const { row: event } of checkpointImportSourceBodyRows(events, receipt.manifest.source.seq)) {
    requireProviderInput(event.kind === "observe" && typeof event.payload.blob === "string",
      "checkpoint import source body row differs");
    if (seen.has(event.payload.blob)) continue;
    let text: string;
    try {
      text = store.get(event.payload.blob);
    } catch {
      refuse("checkpoint import source body is unavailable");
    }
    requireProviderInput(typeof event.payload.blob_bytes === "number"
      && Buffer.byteLength(text) === event.payload.blob_bytes, "checkpoint import source body bytes differ");
    seen.add(event.payload.blob);
    bodies.push({ digest: event.payload.blob, bytes: Buffer.byteLength(text), text });
  }
  requireProviderInput(bodies.length <= MAX_CHECKPOINT_IMPORT_BODIES, "checkpoint import source exceeds its body bound");
  const bundle: CheckpointImportBundle = {
    version: 1,
    schema: CHECKPOINT_IMPORT_SCHEMA,
    source: {
      session: parentSession,
      checkpoint: checkpointId,
      digest: checkpointDigest,
      head: { seq: receipt.manifest.source.seq, hash: receipt.manifest.source.hash },
    },
    manifest: { ...structuredClone(receipt.manifest) },
    events: structuredClone(events).map(row => ({ ...row })),
    bodies,
  };
  if (Buffer.byteLength(canonicalJson(bundle)) > MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES) {
    refuse("checkpoint import bundle exceeds its bound");
  }
  // Self-check with the one validator the child fold will use: a bundle that
  // does not survive independent authentication is never handed out.
  validateImportedCheckpointSource(bundle);
  return bundle;
}

// ---------------------------------------------------------------------------
// Import into a fresh child session.
// ---------------------------------------------------------------------------

interface ImportTargetChecks {
  seal: EventRecord;
}

/** Every child-side precondition, checked before any durable mutation:
 * a real current session/open bound to this session and plugin manifest,
 * the supplied material matching the seal actually in force, and a parent
 * distinct from the child. */
function checkImportTarget(childLog: EventLog, options: {
  sessionId: string; systemPrompt: string; tools: unknown[]; pluginManifest: string;
}, facts: ImportedCheckpointSource): ImportTargetChecks {
  requireProviderInput(!childLog.isReadOnly, "read-only log cannot authorize checkpoint import");
  childLog.assertCanRequestModel();
  requireProviderInput(facts.sourceSession !== options.sessionId, "checkpoint import target is the source session");
  requireProviderInput(options.pluginManifest === facts.pluginManifest,
    "checkpoint import plugin manifest differs from the source checkpoint");
  const opened = lastRow(childLog.events, "session/open");
  requireProviderInput(opened !== undefined && (opened.payload.session_id ?? opened.payload.id) === options.sessionId
    && opened.payload.plugin_manifest_digest === options.pluginManifest,
    "checkpoint import target session differs from its open row");
  requireProviderInput(hasCurrentSessionSchema(opened.payload),
    "checkpoint import target session does not carry the current replay features");
  const seal = lastRow(childLog.events, "prompt/seal");
  requireProviderInput(seal !== undefined, "checkpoint import target has no sealed prefix");
  try {
    assertSealEvent(seal);
  } catch {
    refuse("checkpoint import target seal is invalid");
  }
  requireProviderInput(seal.payload.prefix_hash === frozenPrefixHash({
    systemPrompt: options.systemPrompt,
    toolSchemas: toolSchemaSnapshot(options.tools as { name: string; description?: string }[]),
  }), "checkpoint import material differs from the target seal in force");
  return { seal };
}

/** A first import needs a fresh target: no transcript, no request and no
 * provider effect of any kind. A retained prefix row alone is boot material,
 * not conversation. */
function assertFreshImportTarget(childLog: EventLog): void {
  assertCheckpointImportTargetHistory(childLog.events);
  for (const row of childLog.events) {
    if (PROVIDER_BODY_EVENTS.has(row.name) && row.name !== "provider/prefix") {
      refuse("checkpoint import target is not a fresh conversation");
    }
    if (row.name === "compaction/start") refuse("checkpoint import target has pending compaction");
  }
}

/** Rebuild the confirmed metadata of an already-recorded import from its
 * retained rows, after the fold has revalidated the whole chain. */
function importMetadataFromRows(childLog: EventLog, ready: EventRecord): CheckpointImportMetadata {
  // The fold revalidates the retained import end to end before anything is
  // confirmed back to the caller.
  liveProviderState(childLog);
  const stateSeq = Number(ready.payload.state_seq);
  const stateRow = childLog.events[stateSeq - 1];
  requireProviderInput(Number.isSafeInteger(stateSeq) && stateSeq > 0 && stateRow !== undefined
    && stateRow.name === "provider/state" && stateRow.kind === "observe"
    && typeof stateRow.payload.blob === "string", "checkpoint import ready row names no state row");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(BlobStore.forSession(childLog.path).get(stateRow.payload.blob)) as Record<string, unknown>;
  } catch {
    refuse("checkpoint import state body is unavailable");
  }
  const source = ready.payload.source as Record<string, unknown>;
  const head = source.head as { seq: number; hash: string };
  const transition = body.prefix as Record<string, unknown>;
  return {
    session: String(ready.payload.session),
    source: {
      session: String(source.session), checkpoint: String(source.checkpoint), digest: String(source.digest),
      head: { seq: Number(head.seq), hash: String(head.hash) },
    },
    intent: { seq: stateSeq - 1 },
    state: { seq: stateRow.seq, hash: stateRow.hash },
    ready: { seq: ready.seq },
    bundle: { blob: String((ready.payload.bundle as Record<string, unknown>).blob),
      blob_bytes: Number((ready.payload.bundle as Record<string, unknown>).blob_bytes) },
    removedFrames: (ready.payload.removed_frames as number[]) ?? [],
    sourceMessagesDigest: String(ready.payload.source_digest),
    transformedDigest: String(ready.payload.transformed_digest),
    prefix: {
      kind: transition.kind as "identical" | "branch_scope",
      sourcePrefixHash: String(transition.source_prefix_hash),
      targetPrefixHash: String(transition.target_prefix_hash),
      transformation: String(transition.transformation),
    },
  };
}

/** Import a prepared checkpoint bundle into a fresh child session. The
 * prepared value is untrusted on every call: it is revalidated closed and
 * re-authenticated in full before the child is touched, an exact confirmed
 * repeat is idempotent, and every conflict refuses before any mutation. The
 * durable intent, transcript state and ready receipt land in ONE atomic
 * batch whose builder rechecks target freshness, so an interrupted import
 * leaves either nothing or a complete, replayable record. */
export function importCheckpointProviderInput(childLog: EventLog, prepared: unknown, options: {
  sessionId: string; systemPrompt: string; tools: unknown[]; pluginManifest: string;
}): CheckpointImportMetadata {
  if (!options || typeof options !== "object") refuse("checkpoint import options are missing");
  requireProviderInput(typeof options.sessionId === "string" && options.sessionId.length > 0
    && Buffer.byteLength(options.sessionId) <= MAX_IMPORT_SESSION_BYTES, "checkpoint import session is invalid");
  requireProviderInput(typeof options.systemPrompt === "string"
    && Buffer.byteLength(options.systemPrompt) <= MAX_IMPORT_SYSTEM_PROMPT_BYTES
    && Array.isArray(options.tools) && options.tools.length <= MAX_IMPORT_TOOLS,
    "checkpoint import material exceeds its bounds");
  requireProviderInput(typeof options.pluginManifest === "string" && DIGEST_PATTERN.test(options.pluginManifest),
    "checkpoint import plugin manifest is invalid");
  // The prepared value is untrusted: full closed-shape and independent
  // authentication before anything else, so a tampered or foreign value
  // refuses without touching the child.
  const facts = validateImportedCheckpointSource(prepared);
  const bundleText = canonicalJson(prepared);
  const bundleDigest = sha256Hex(bundleText);
  checkImportTarget(childLog, options, facts);
  // Exact-repeat idempotence: an existing ready receipt that binds this
  // exact source and bundle answers from retained evidence with zero
  // appends; anything else already imported is a conflict.
  const existing = lastRow(childLog.events, "branch/import_ready");
  if (existing) {
    const source = existing.payload.source as Record<string, unknown> | undefined;
    const bundleRef = existing.payload.bundle as Record<string, unknown> | undefined;
    const sameSource = source !== null && typeof source === "object"
      && String(source.session) === facts.sourceSession && String(source.checkpoint) === facts.checkpointId
      && String(source.digest) === facts.checkpointDigest;
    const sameBundle = bundleRef !== null && typeof bundleRef === "object"
      && String(bundleRef.blob) === bundleDigest && Number(bundleRef.blob_bytes) === facts.bundleBytes;
    requireProviderInput(existing.payload.session === options.sessionId && sameSource && sameBundle,
      "checkpoint import conflicts with the target's existing import");
    return importMetadataFromRows(childLog, existing);
  }
  // An intent without its ready receipt is an unknown outcome; it is never
  // retried automatically and never authorizes a live continuation.
  requireProviderInput(!childLog.events.some(row => row.name === "branch/import_intent"),
    "checkpoint import target has an unresolved import intent");
  assertFreshImportTarget(childLog);
  // Child prefix material is retained under the child's own current seal
  // first (idempotent, no model request); the import's prefix transition
  // names that row.
  const prefixRef = retainSealedProviderPrefix(childLog, { systemPrompt: options.systemPrompt, tools: options.tools });
  const seal = lastRow(childLog.events, "prompt/seal")!;
  const head = { seq: childLog.lastSeq, hash: childLog.lastHash };
  const intentSeq = head.seq + 1;
  const childPrefixHash = frozenPrefixHash({
    systemPrompt: options.systemPrompt,
    toolSchemas: toolSchemaSnapshot(options.tools as { name: string; description?: string }[]),
  });
  const source = {
    session: facts.sourceSession, checkpoint: facts.checkpointId, digest: facts.checkpointDigest, head: facts.head,
  };
  const transition = {
    kind: facts.prefixHash === childPrefixHash ? "identical" as const : "branch_scope" as const,
    source_prefix_hash: facts.prefixHash,
    source_seal: facts.sealRef,
    target_prefix_hash: childPrefixHash,
    target_seal: inputReference(seal),
    target_prefix_seq: prefixRef.seq,
    transformation: checkpointImportTransformationDigest({
      sourcePrefixHash: facts.prefixHash,
      targetPrefixHash: childPrefixHash,
      sourceMessagesDigest: facts.sourceMessagesDigest,
      removedFrames: facts.removedFrameIndices,
      transformedDigest: facts.transformedDigest,
    }),
  };
  const bundleRef = { blob: bundleDigest, blob_bytes: facts.bundleBytes };
  const stateBody = {
    version: 1,
    operation: "replace",
    reason: CHECKPOINT_IMPORT_REASON,
    prior: null,
    before: inputDigest([]),
    after: facts.transformedDigest,
    messages: structuredClone(facts.transformedMessages),
    metadata: checkpointImportStateMetadata({
      sourceMetadata: facts.state.metadata,
      targetPrefixHash: childPrefixHash,
      targetSystemPrompt: options.systemPrompt,
      targetPluginManifest: options.pluginManifest,
      provenance: {
        source_prefix_hash: facts.prefixHash,
        removed_frames: facts.removedFrameIndices,
        source_digest: facts.sourceMessagesDigest,
        transformed_digest: facts.transformedDigest,
      },
    }),
    source,
    source_digest: facts.sourceMessagesDigest,
    removed_frames: [...facts.removedFrameIndices],
    bundle: bundleRef,
    intent_seq: intentSeq,
    prefix: transition,
  };
  const store = BlobStore.forSession(childLog.path);
  putRetainedBody(store, bundleText);
  const stateRef = putRetainedBody(store, canonicalJson(stateBody));
  try {
    const rows = childLog.appendBatchDurable(nextSeq => {
      requireProviderInput(nextSeq === intentSeq, "checkpoint import target head moved");
      requireProviderInput(childLog.lastSeq === head.seq && childLog.lastHash === head.hash,
        "checkpoint import target is stale");
      childLog.assertCanRequestModel();
      return [
        { kind: "observe" as const, name: "branch/import_intent", payload: {
          schema: CHECKPOINT_IMPORT_SCHEMA, session: options.sessionId, source, bundle: bundleRef } },
        { kind: "observe" as const, name: "provider/state", payload: {
          schema: PROVIDER_INPUT_SCHEMA, blob: stateRef.blob, blob_bytes: stateRef.blob_bytes,
          body_digest: stateRef.blob, source_blob: bundleRef.blob,
          ...(facts.provenance.authored.length ? { authored_secret_digests: facts.provenance.authored } : {}),
          ...(facts.provenance.observed.length ? { observed_secret_digests: facts.provenance.observed } : {}) } },
        { kind: "observe" as const, name: "branch/import_ready", payload: {
          schema: CHECKPOINT_IMPORT_SCHEMA, session: options.sessionId, source, bundle: bundleRef,
          state_seq: intentSeq + 1, prefix: transition, removed_frames: [...facts.removedFrameIndices],
          source_digest: facts.sourceMessagesDigest, transformed_digest: facts.transformedDigest } },
      ];
    });
    requireProviderInput(rows.length === 3 && rows[0]!.seq === intentSeq
      && rows[1]!.name === "provider/state" && rows[2]!.name === "branch/import_ready",
      "checkpoint import batch differs");
    // The fold is the acceptance authority: a durable chain it refuses is a
    // failed import, never a confirmed one.
    liveProviderState(childLog);
    return {
      session: options.sessionId,
      source,
      intent: { seq: rows[0]!.seq },
      state: inputReference(rows[1]!),
      ready: { seq: rows[2]!.seq },
      bundle: bundleRef,
      removedFrames: [...facts.removedFrameIndices],
      sourceMessagesDigest: facts.sourceMessagesDigest,
      transformedDigest: facts.transformedDigest,
      prefix: {
        kind: transition.kind, sourcePrefixHash: facts.prefixHash,
        targetPrefixHash: childPrefixHash, transformation: transition.transformation,
      },
    };
  } catch (error) {
    // The rows may have landed while a post-append check refused; either way
    // the original failure stays fatal and the state is unknown, never
    // silently retried.
    throw error instanceof ProviderInputError ? error
      : new ProviderInputError(error instanceof Error ? error.message : "checkpoint import failed");
  }
}
