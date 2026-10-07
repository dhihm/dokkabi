import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { deriveCodexContinuation, providerHttpPayload } from "../plugins/provider-representation.ts";
import { canonicalJson } from "./canonical.ts";
import { BlobStore, PartsWriter, storedFileMemo } from "./blob-store.ts";
import { EventLog } from "./event-log.ts";
import {
  projectSessionReplaySchemas, NAME_PATTERN, GENESIS_HASH, isEventKind,
  type EventInput, type EventRecord,
} from "./schema.ts";
import { authoredSecretDigests, authoredSecretMatches, containsSecret, containsSecretValue,
  newSecretValues, secretShapeClassInValue, redactText, sessionSecretProvenance, stripTerminalControls } from "./redact.ts";
import { assertSealEvent, frozenPrefixHash, systemPromptHash, toolSchemaSnapshot } from "./prefix.ts";
import { assertProviderRequestGuards } from "./provider-request-guard.ts";
import { assertContextFrameBindings, contextFrameMessage, messageText, recordedSurfaces } from "./context-frame.ts";
// R8-01: the checkpoint import contract reuses the closed R7 manifest and
// receipt schemas. branch-checkpoint imports this module too, so these
// bindings are touched only inside validation functions — never at module
// evaluation — which keeps the import cycle inert in Bun and tsc alike.
import { branchCheckpointReceiptSchemas, checkpointManifestSchema } from "./branch-checkpoint.ts";

/** #227: the replay feature under which a transcript may carry host-context
 * frames (`append_context`). */
const CONTEXT_GRAPH_FEATURE = "context-graph-v1";

/** Model input representations deliberately exclude authentication and HTTP headers. */
export const PROVIDER_INPUT_SCHEMA = "provider-input-v1";
export const PROVIDER_BODY_EVENTS = new Set([
  "provider/state", "provider/prefix", "provider/request", "provider/payload",
  "provider/send", "provider/response",
]);
/** The one body that IS the model's own output rather than input built for it.
 * It is retained the moment the stream completes, before loop-pi has built any
 * `assistant/message` or `tool/call` row from it — so it is where a literal the
 * model just wrote first appears, and it has to speak for its own provenance. */
export const PROVIDER_RESPONSE_EVENT = "provider/response";
export type InputReference = { seq: number; hash: string };
export interface ProviderContext {
  systemPrompt: string;
  messages: unknown[];
  tools: unknown[];
}
export interface ProviderState {
  ref: InputReference | null;
  messages: unknown[];
  pending?: { start: number; messages: unknown[]; drop: number };
  metadata?: Record<string, unknown>;
}
export interface ProviderInputRecord {
  ref: InputReference;
  state: InputReference;
  prefix: InputReference;
  route: string;
  role: string;
  model: Record<string, unknown>;
  options: Record<string, unknown>;
  context: ProviderContext;
  contextDigest: string;
}
export interface ProviderInputProjection {
  state: ProviderState;
  requests: ProviderInputRecord[];
  sends: Array<{ ref: InputReference; request: InputReference; ordinal: number; transport: string; body: unknown }>;
  identities: Array<{ seq: number; hash: string; body: string }>;
}

export class ProviderInputError extends Error {
  readonly code = "provider_input_refused";
  constructor(reason: string) {
    const safe = redactText(stripTerminalControls(reason));
    super(`provider-input: ${containsSecret(safe) ? "[redacted refusal detail]" : safe.slice(0, 480)}`);
    this.name = "ProviderInputError";
  }
}

/** Diagnostic only: this row cannot admit input or authorize a retry. Failure
 * to record a refusal must never replace it with permission to send. */
export function observeProviderInputRefusal(log: EventLog, error: unknown, stage: string): unknown {
  const refusal = error instanceof ProviderInputError ? error
    : error instanceof Error && error.message.startsWith("provider-input:")
      ? new ProviderInputError(error.message.slice("provider-input:".length).trim()) : undefined;
  if (!refusal) return error;
  const request = lastRow(log.events, "provider/request");
  try {
    log.append({ kind: "observe", name: "provider/input_refused", payload: {
      status: "refused", reason_code: refusal.code, cause_type: refusal.name, stage,
      detail_hint: refusal.message, last_input_ref: request ? inputReference(request) : null,
    } });
  } catch { /* The original refusal remains fatal even if the log is unavailable. */ }
  return refusal;
}
export function requireProviderInput(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ProviderInputError(reason);
}

/** Copy JSON data without invoking getters or toJSON. Undefined object members
 * are absent on the wire; undefined array members and non-finite numbers refuse. */
export function inputData(value: unknown, depth = 0): unknown {
  requireProviderInput(depth < 150, "input nesting exceeds its bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireProviderInput(Number.isFinite(value), "non-finite input number");
    return value;
  }
  if (Array.isArray(value)) {
    requireProviderInput(Object.getPrototypeOf(value) === Array.prototype, "input array has a custom prototype");
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireProviderInput(descriptor && "value" in descriptor, "input array has a hole or accessor");
      out.push(inputData(descriptor.value, depth + 1));
    }
    return out;
  }
  requireProviderInput(typeof value === "object" && value !== null, "input is not JSON data");
  const prototype = Object.getPrototypeOf(value);
  requireProviderInput(prototype === Object.prototype || prototype === null, "input has a custom prototype");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireProviderInput("value" in descriptor, "input has an accessor");
    if (descriptor.value !== undefined) Object.defineProperty(out, key, {
      value: inputData(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}
export function inputDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(inputData(value))).digest("hex");
}
export function inputReference(event: Pick<EventRecord, "seq" | "hash">): InputReference {
  return { seq: event.seq, hash: event.hash };
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function record(value: unknown): Record<string, unknown> {
  requireProviderInput(value !== null && typeof value === "object" && !Array.isArray(value), "invalid input record");
  return value as Record<string, unknown>;
}
function dataProperties(value: unknown, omit: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const object = record(value), out: Record<string, unknown> = {};
  requireProviderInput(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null,
    "input has a custom prototype");
  for (const key of Object.keys(object)) {
    if (omit.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
    requireProviderInput("value" in descriptor, "input has an accessor");
    if (descriptor.value !== undefined) Object.defineProperty(out, key, { value: descriptor.value, enumerable: true });
  }
  return out;
}
function reference(value: unknown): InputReference {
  const row = record(value);
  requireProviderInput(Number.isSafeInteger(row.seq) && Number(row.seq) > 0
    && typeof row.hash === "string" && /^[a-f0-9]{64}$/u.test(row.hash), "invalid input reference");
  return { seq: Number(row.seq), hash: row.hash };
}

/** Pi carries executable tools internally. Only the adapter's declared tool
 * data belongs in model context; execution closures never enter an artifact. */
export function providerContext(value: unknown): ProviderContext {
  const context = dataProperties(value);
  requireProviderInput(context.systemPrompt === undefined || typeof context.systemPrompt === "string", "invalid system prompt");
  requireProviderInput(Array.isArray(context.messages), "messages are missing");
  requireProviderInput(context.tools === undefined || Array.isArray(context.tools), "invalid tools");
  const tools = ((context.tools ?? []) as unknown[]).map(value => {
    const tool = dataProperties(value, new Set(["execute", "label"]));
    requireProviderInput(typeof tool.name === "string" && typeof tool.description === "string", "invalid tool definition");
    return inputData(tool);
  });
  return inputData({ systemPrompt: context.systemPrompt ?? "", messages: context.messages, tools }) as ProviderContext;
}

const PRIVATE_OPTIONS = new Set(["apiKey", "headers", "env", "signal", "fetch", "telemetryContext"]);
const LOOP_CALLBACKS = new Set(["onPayload", "onResponse", "convertToLlm", "transformContext", "getApiKey",
  "getSteeringMessages", "getFollowUpMessages", "beforeToolCall", "afterToolCall", "shouldStopAfterTurn", "prepareNextTurn"]);
export function providerOptions(value: unknown): Record<string, unknown> {
  const options = value === undefined ? {} : dataProperties(value, new Set([...PRIVATE_OPTIONS, ...LOOP_CALLBACKS, "model"]));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(options)) {
    if (item === undefined || PRIVATE_OPTIONS.has(key) || LOOP_CALLBACKS.has(key)) continue;
    // Pi's loop configuration carries the same model separately.
    if (key === "model") continue;
    out[key] = inputData(item);
  }
  return out;
}
export function providerModel(value: unknown): Record<string, unknown> {
  const model = dataProperties(value, new Set(["headers"]));
  const { baseUrl, ...data } = model;
  requireProviderInput(typeof model.id === "string" && typeof model.api === "string"
    && typeof model.provider === "string" && typeof baseUrl === "string", "invalid model identity");
  // Endpoint coordinates are routing metadata, not model-visible input.
  return { ...record(inputData(data)), endpoint_digest: inputDigest(baseUrl) };
}

// ---------------------------------------------------------------------------
// R8-01 checkpoint input import (docs/desktop-branches-r8.md). A fresh child
// session imports the exact retained conversation of a verified checkpoint
// under one declared transformation. The portable evidence bundle and the
// child-side receipts are closed schemas shared by the writer
// (host/checkpoint-input-import.ts) and this fold: whatever the writer
// checked before appending, the fold re-derives on every cold reload and
// replay — there is no writer-only validation.
// ---------------------------------------------------------------------------

/** The replay feature generation and the receipt schema of the import. */
export const CHECKPOINT_IMPORT_SCHEMA = "checkpoint-input-import-v1";
/** The one declared reason an import may replace a child transcript with a
 * retained source conversation. */
export const CHECKPOINT_IMPORT_REASON = "session/checkpoint_import";
/** Explicit finite bounds; a source beyond them refuses instead of growing
 * without limit. */
export const MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES = 256 * 1024 * 1024;
export const MAX_CHECKPOINT_IMPORT_EVENTS = 200_000;
export const MAX_CHECKPOINT_IMPORT_BODIES = 200_000;
const MAX_IMPORT_SESSION_BYTES = 256;
const MAX_IMPORT_SYSTEM_PROMPT_BYTES = 1024 * 1024;
const MAX_IMPORT_TOOLS = 4096;
/** The same closed id shape the R7 checkpoint reader uses (mirrored here so
 * this module stays free of a branch-checkpoint import cycle). */
const CHECKPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const importDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const importReferenceSchema = z.object({ seq: z.number().int().positive(), hash: importDigest }).strict();
const importSourceRefSchema = z.object({
  session: z.string().min(1).max(MAX_IMPORT_SESSION_BYTES),
  checkpoint: z.string().regex(CHECKPOINT_ID_PATTERN),
  digest: importDigest,
  head: importReferenceSchema,
}).strict();
const importBundleRefSchema = z.object({
  blob: importDigest, blob_bytes: z.number().int().nonnegative(),
}).strict();

/** The declared prefix transition of an import (D-2026-10-03-02). A child
 * legitimately seals a different prefix — its system prompt carries the
 * child's own workspace root — so equality with the source prefix is never
 * required. The transition is closed: both seals, both prefix hashes, the
 * child's retained prefix row, and the transformation identity. The source
 * material stays exact in the retained bundle; the child's imported metadata
 * carries the child prefix hash. */
const importPrefixTransitionSchema = z.object({
  kind: z.enum(["identical", "branch_scope"]),
  source_prefix_hash: importDigest,
  source_seal: importReferenceSchema,
  target_prefix_hash: importDigest,
  target_seal: importReferenceSchema,
  target_prefix_seq: z.number().int().positive(),
  transformation: importDigest,
}).strict();

/** Child-side durable receipts. An import is one atomic intent/state/ready
 * batch, so the receipts reference the state row and each other by position
 * inside it; the hash chain binds what a sequence number alone names. The
 * retained evidence bundle is rooted once, by the import state row's normal
 * `payload.source_blob` (what GC, pack and session preservation collect);
 * the receipts carry only the closed `bundle` reference the fold compares
 * row to row. */
export const checkpointImportReceiptSchemas = {
  "branch/import_intent": z.object({
    schema: z.literal(CHECKPOINT_IMPORT_SCHEMA),
    session: z.string().min(1).max(MAX_IMPORT_SESSION_BYTES),
    source: importSourceRefSchema,
    bundle: importBundleRefSchema,
  }).strict(),
  "branch/import_ready": z.object({
    schema: z.literal(CHECKPOINT_IMPORT_SCHEMA),
    session: z.string().min(1).max(MAX_IMPORT_SESSION_BYTES),
    source: importSourceRefSchema,
    bundle: importBundleRefSchema,
    state_seq: z.number().int().positive(),
    prefix: importPrefixTransitionSchema,
    removed_frames: z.array(z.number().int().nonnegative()),
    source_digest: importDigest,
    transformed_digest: importDigest,
  }).strict(),
} as const;

/** The closed portable evidence bundle `prepareCheckpointInputImport`
 * returns and the child retains whole: the verified source event chain
 * through the checkpoint ready row, the exact original body text of every
 * provider row keyed by digest, and the R7 manifest — byte-bound by the
 * checkpoint digest, the sha256 of its canonical text, which the R7 reader
 * verified against retained storage at preparation. No workspace file blob
 * belongs here; the image is bound by digest only. */
export const checkpointImportBundleSchema = z.object({
  version: z.literal(1),
  schema: z.literal(CHECKPOINT_IMPORT_SCHEMA),
  source: importSourceRefSchema,
  manifest: z.record(z.string(), z.unknown()),
  events: z.array(z.record(z.string(), z.unknown())).max(MAX_CHECKPOINT_IMPORT_EVENTS),
  bodies: z.array(z.object({
    digest: importDigest,
    bytes: z.number().int().nonnegative(),
    text: z.string(),
  }).strict()).max(MAX_CHECKPOINT_IMPORT_BODIES),
}).strict();

/** The identity of the declared transformation an import records: a digest
 * over every fact the fold re-derives — the prefix transition, the removed
 * frame indices and both transcript digests. Shared by writer and fold. */
export function checkpointImportTransformationDigest(input: {
  sourcePrefixHash: string;
  targetPrefixHash: string;
  sourceMessagesDigest: string;
  removedFrames: readonly number[];
  transformedDigest: string;
}): string {
  return createHash("sha256").update(canonicalJson({
    schema: CHECKPOINT_IMPORT_SCHEMA,
    source_prefix_hash: input.sourcePrefixHash,
    target_prefix_hash: input.targetPrefixHash,
    source_messages_digest: input.sourceMessagesDigest,
    removed_frames: [...input.removedFrames],
    transformed_digest: input.transformedDigest,
  })).digest("hex");
}

/** The exact metadata transform an import declares: the SOURCE metadata is
 * preserved key for key (a parent's route/model facts stay readable), the
 * child's current prefix/system/plugin facts override theirs, and one closed
 * provenance block is added. Writer and fold share this function, so the
 * recorded metadata is exactly the re-derived one. */
export function checkpointImportStateMetadata(input: {
  sourceMetadata: Record<string, unknown> | undefined;
  targetPrefixHash: string;
  targetSystemPrompt: string;
  targetPluginManifest: string | null;
  provenance: { source_prefix_hash: string; removed_frames: readonly number[]; source_digest: string; transformed_digest: string };
}): Record<string, unknown> {
  return {
    ...(input.sourceMetadata ?? {}),
    prefix_hash: input.targetPrefixHash,
    system_prompt_hash: systemPromptHash(input.targetSystemPrompt),
    ...(input.targetPluginManifest !== null ? { plugin_manifest_digest: input.targetPluginManifest } : {}),
    checkpoint_import: {
      source_prefix_hash: input.provenance.source_prefix_hash,
      removed_frames: [...input.provenance.removed_frames],
      source_digest: input.provenance.source_digest,
      transformed_digest: input.provenance.transformed_digest,
    },
  };
}

function lastNamedAtOrBefore(events: readonly EventRecord[], name: string, seq: number): EventRecord | undefined {
  for (let index = Math.min(seq, events.length) - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (row && row.name === name) return row;
  }
  return undefined;
}

/** The closed portable bundle value `prepareCheckpointInputImport` returns
 * and `importCheckpointProviderInput` revalidates as untrusted input. */
export type CheckpointImportBundle = z.infer<typeof checkpointImportBundleSchema>;

/** The replay generation under which genuine formal Work executions are
 * context-graph host actions whose retained bodies a source fold reads. */
const FORMAL_WORK_FEATURE = "context-formal-work-v1";
/** The formal Work execution rows that may name a retained body. */
export const FORMAL_EXECUTION_BODY_EVENTS = new Set(["work/execution_start", "work/execution_end"]);

/** One source row whose retained body a checkpoint import bundle carries. */
export interface CheckpointImportBodyRow {
  readonly row: EventRecord;
  /** A formal Work execution row (context-formal-work-v1), not a provider body. */
  readonly formal: boolean;
}

/** The ONE source-body selection rule preparation and validation share.
 * Every provider body row of the carried chain, exactly as before
 * context-formal-work-v1. Under that sealed generation, also each genuine
 * observed formal Work execution start and end naming a retained blob, after
 * the feature boundary and within the captured head — the bodies the source
 * ContextGraph fold authenticates a formal verdict against. A refused end
 * without a body names none and none is invented; workspace file contents
 * and other named blobs are never selected. Pure. */
export function checkpointImportSourceBodyRows(events: readonly EventRecord[], headSeq: number): CheckpointImportBodyRow[] {
  let formalStart: number | undefined;
  try {
    formalStart = projectSessionReplaySchemas(events.slice(0, headSeq)).featureStart.get(FORMAL_WORK_FEATURE);
  } catch {
    requireProviderInput(false, "checkpoint import source replay features differ");
  }
  const out: CheckpointImportBodyRow[] = [];
  for (const row of events) {
    if (row.seq > headSeq) continue;
    if (PROVIDER_BODY_EVENTS.has(row.name)) {
      out.push({ row, formal: false });
    } else if (formalStart !== undefined && row.seq > formalStart && row.seq <= headSeq
      && FORMAL_EXECUTION_BODY_EVENTS.has(row.name) && row.kind === "observe" && typeof row.payload.blob === "string") {
      out.push({ row, formal: true });
    }
  }
  return out;
}

/** What the shared import validator derived from a retained bundle. */
/** An import destination must have no admitted or interrupted operator/action history. */
export function assertCheckpointImportTargetHistory(events: readonly EventRecord[]): void {
  const actions = new Set(["user/message", "assistant/message", "tool/call", "tool/end", "tool/result", "compaction/start"]);
  requireProviderInput(!events.some(event => actions.has(event.name)),
    "checkpoint import target carries prior or unresolved actions");
}

// ---------------------------------------------------------------------------
// R8-04 shared source verifiers: the event-chain, retained-body and settlement
// checks below were the inline blocks of validateImportedCheckpointSource and
// are now the ONE implementation every retained-prefix authority uses — the
// checkpoint import validator and the branch-decision child evidence verifier
// fold identical logic, so neither can be weaker than the other.
// ---------------------------------------------------------------------------

/** Re-verify a recorded event chain from genesis: shape, seq, prev_hash and
 * the hash over every field but `hash`. Returns the verified rows keyed by
 * seq. Pure: no filesystem, no log, no provider. */
export function verifySourceEventChain(rows: readonly unknown[]): Map<number, EventRecord> {
  requireProviderInput(rows.length >= 3, "checkpoint import source chain is empty");
  const bySeq = new Map<number, EventRecord>();
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < rows.length; index += 1) {
    const row = record(rows[index]);
    requireProviderInput(row.seq === index + 1 && typeof row.hash === "string" && /^[a-f0-9]{64}$/u.test(row.hash)
      && row.prev_hash === previousHash, "checkpoint import source chain differs");
    requireProviderInput(isEventKind(row.kind) && typeof row.name === "string" && NAME_PATTERN.test(row.name)
      && typeof row.ts === "string" && typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload),
      "checkpoint import source row differs");
    const { hash: _rowHash, ...unsigned } = row;
    requireProviderInput(createHash("sha256").update(canonicalJson(unsigned)).digest("hex") === row.hash,
      "checkpoint import source row hash differs");
    previousHash = row.hash;
    bySeq.set(Number(row.seq), row as unknown as EventRecord);
  }
  return bySeq;
}

/** Verify the exact original bodies of a retained prefix: each is canonical
 * JSON, hashes to its digest and carries its byte length. Returns the parsed
 * bodies keyed by digest. */
export function verifySourceBodies(entries: Iterable<{ digest: string; bytes: number; text: string }>): Map<string, unknown> {
  const bodies = new Map<string, unknown>();
  for (const entry of entries) {
    requireProviderInput(!bodies.has(entry.digest), "checkpoint import body repeats");
    let body: unknown;
    try { body = JSON.parse(entry.text); } catch { requireProviderInput(false, "checkpoint import body is not JSON"); }
    requireProviderInput(canonicalJson(body) === entry.text
      && createHash("sha256").update(entry.text).digest("hex") === entry.digest
      && Buffer.byteLength(entry.text) === entry.bytes, "checkpoint import body differs from its digest");
    bodies.set(entry.digest, body);
  }
  return bodies;
}

/** A host-owned sandboxed execution (`executeTool`, e.g. a Work verifier
 * case) records no model `tool/call`: its own `sandbox/exec` effect, then its
 * `tool/result` and `tool/end`, appended synchronously in that order. Only
 * that exact adjacent triple — same id, tool and args digest — is a completed
 * host effect rather than an orphan completion; anything else still refuses.
 * The caller enables this only in context-formal-work-v1; prior generations
 * preserve their original refusal. */
function completedHostExecution(rows: readonly EventRecord[], index: number): boolean {
  const end = rows[index]!, result = rows[index - 1], effect = rows[index - 2];
  return result !== undefined && effect !== undefined
    && result.kind === "surface" && result.name === "tool/result" && result.payload.id === end.payload.id
    && typeof end.payload.name === "string" && result.payload.tool === end.payload.name
    && effect.kind === "effect" && effect.name === "sandbox/exec" && effect.payload.tool === end.payload.name
    && typeof end.payload.args_digest === "string" && effect.payload.args_digest === end.payload.args_digest;
}

/** The settlement pairing of a retained prefix: every provider response names
 * the outstanding request it answers (through its retained body), every tool
 * completion names its outstanding call, and nothing is left open at the end.
 * An unresolved model, tool or compaction-adjacent effect refuses. */
export function assertSettledSourceEffects(rows: readonly EventRecord[], bodies: ReadonlyMap<string, unknown>): void {
  const requests = new Map<number, string>();
  const tools = new Set<string>();
  const formalStart = projectSessionReplaySchemas(rows).featureStart.get(FORMAL_WORK_FEATURE);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.name === "provider/request") requests.set(row.seq, row.hash);
    if (row.name === "provider/response") {
      const body = record(bodies.get(String(row.payload.blob)));
      const request = reference(body.request);
      requireProviderInput(requests.get(request.seq) === request.hash,
        "checkpoint import response has no outstanding request");
      requests.delete(request.seq);
    }
    if (row.name === "tool/call") {
      requireProviderInput(row.kind === "observe" && typeof row.payload.id === "string"
        && row.payload.id.length > 0 && !tools.has(row.payload.id),
        "checkpoint import source tool identity is unavailable or ambiguous");
      tools.add(row.payload.id);
    }
    if (row.name === "tool/end") {
      requireProviderInput(row.kind === "observe" && typeof row.payload.id === "string"
        && (tools.has(row.payload.id) || (formalStart !== undefined && row.seq > formalStart && completedHostExecution(rows, index))),
        "checkpoint import source tool completion has no outstanding call");
      tools.delete(row.payload.id);
    }
  }
  requireProviderInput(requests.size === 0, "checkpoint import source has unanswered provider requests");
  requireProviderInput(tools.size === 0, "checkpoint import source has unresolved tool effects");
}

export interface ImportedCheckpointSource {
  readonly sourceSession: string;
  readonly checkpointId: string;
  readonly checkpointDigest: string;
  readonly head: { seq: number; hash: string };
  /** The source transcript at the captured boundary, re-folded here. */
  readonly state: ProviderState;
  /** The positions of the authenticated host-context frame messages the
   * declared transformation omits — the only messages ever removed. */
  readonly removedFrameIndices: readonly number[];
  readonly transformedMessages: unknown[];
  readonly sourceMessagesDigest: string;
  readonly transformedDigest: string;
  readonly prefixHash: string;
  readonly sealRef: { seq: number; hash: string };
  readonly pluginManifest: string;
  readonly bundleBytes: number;
  readonly provenance: { authored: string[]; observed: string[] };
}

// Pure validation memo: only closed, byte-exact canonical values qualify.
// Returned copies never share mutable state with this bounded private store.
const CHECKPOINT_SOURCE_MEMO_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_SOURCE_MEMO_ENTRIES = 8;
const checkpointSourceMemo = new Map<string, { text: string; bytes: number; facts: ImportedCheckpointSource }>();
let checkpointSourceMemoBytes = 0;

function memoizeCheckpointSource(key: string, text: string, bytes: number, facts: ImportedCheckpointSource): void {
  if (bytes > CHECKPOINT_SOURCE_MEMO_BYTES) return;
  while (checkpointSourceMemo.size >= CHECKPOINT_SOURCE_MEMO_ENTRIES || checkpointSourceMemoBytes + bytes > CHECKPOINT_SOURCE_MEMO_BYTES) {
    const oldest = checkpointSourceMemo.keys().next().value!;
    checkpointSourceMemoBytes -= checkpointSourceMemo.get(oldest)!.bytes;
    checkpointSourceMemo.delete(oldest);
  }
  checkpointSourceMemo.set(key, { text, bytes, facts: structuredClone(facts) });
  checkpointSourceMemoBytes += bytes;
}

/** Independently authenticate a portable checkpoint input bundle. The source
 * event chain is re-verified from genesis, every retained body must be the
 * exact canonical text of its digest, the R7 manifest is byte-bound by the
 * checkpoint digest, and the source transcript is re-folded with this
 * module's own fold — the sole authority on what a recorded transcript is.
 * Pure: no filesystem, no EventLog, no provider. The import writer calls it
 * before any child mutation and the fold calls it on every reload, so the
 * two can never diverge. */
export function validateImportedCheckpointSource(value: unknown): ImportedCheckpointSource {
  const parsed = checkpointImportBundleSchema.safeParse(value);
  requireProviderInput(parsed.success, "checkpoint import bundle is not closed");
  const bundle = parsed.data;
  const text = canonicalJson(bundle);
  requireProviderInput(Buffer.byteLength(text) <= MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES,
    "checkpoint import bundle exceeds its bound");
  const bundleBytes = Buffer.byteLength(text);
  const memoKey = createHash("sha256").update(text).digest("hex");
  const memo = checkpointSourceMemo.get(memoKey);
  if (memo?.text === text) {
    checkpointSourceMemo.delete(memoKey);
    checkpointSourceMemo.set(memoKey, memo);
    return structuredClone(memo.facts);
  }
  const source = bundle.source;
  // The manifest is bound byte-exactly: its canonical text must hash to the
  // checkpoint digest the R7 ready row recorded, so no field inside it can
  // change without breaking the binding the child retains.
  requireProviderInput(createHash("sha256").update(canonicalJson(bundle.manifest)).digest("hex") === source.digest,
    "checkpoint import manifest digest differs");
  const manifestParsed = checkpointManifestSchema.safeParse(bundle.manifest);
  requireProviderInput(manifestParsed.success, "checkpoint import manifest schema differs");
  const manifest = manifestParsed.data;
  requireProviderInput(manifest.id === source.checkpoint && manifest.session === source.session,
    "checkpoint import manifest binding differs");
  const head = reference(source.head);
  requireProviderInput(manifest.source.seq === head.seq && manifest.source.hash === head.hash,
    "checkpoint import manifest source differs");
  requireProviderInput(manifest.coverage.providerInput === "complete",
    "checkpoint import needs complete retained prefix material");
  requireProviderInput(typeof manifest.pluginManifest === "string" && /^[a-f0-9]{64}$/u.test(manifest.pluginManifest),
    "checkpoint import needs a recorded plugin manifest");
  const prefix = manifest.prefix;
  const sealRef = reference(prefix.seal);
  requireProviderInput(prefix.material !== null, "checkpoint import prefix material is missing");
  const prefixMaterial = prefix.material;
  requireProviderInput(Buffer.byteLength(prefixMaterial.systemPrompt) <= MAX_IMPORT_SYSTEM_PROMPT_BYTES
    && prefixMaterial.tools.length <= MAX_IMPORT_TOOLS, "checkpoint import prefix material differs");

  // The source chain, re-verified from genesis: shape, seq, prev_hash and the
  // hash over every field but `hash` — a row that gained or lost a field,
  // or any byte of one, breaks here. The verified rows are then the typed
  // chain everything below reads.
  const bySeq = verifySourceEventChain(bundle.events);
  const events = bundle.events as unknown as EventRecord[];
  // Bounded depth: a source that is itself an imported child is refused
  // until nested evidence is explicitly supported — never silently flattened.
  requireProviderInput(!events.some(row => row.name === "branch/import_intent" || row.name === "branch/import_ready"),
    "checkpoint import of an imported source is unsupported");
  // The captured boundary is a real row of the chain, and the bundle ends at
  // exactly this checkpoint's terminal receipt.
  const headRow = bySeq.get(head.seq);
  requireProviderInput(headRow !== undefined && headRow.hash === head.hash && head.seq < events.length,
    "checkpoint import source head differs");
  const last = bySeq.get(events.length)!;
  requireProviderInput(last.name === "branch/checkpoint_ready" && last.kind === "observe",
    "checkpoint import bundle does not end at its checkpoint ready row");
  // The checkpoint's own receipt rows, validated with the closed R7 receipt
  // schemas — one intent, one ready that closes it, no failure — bound to
  // this boundary and this digest.
  let intentRow: EventRecord | undefined;
  let readyRow: EventRecord | undefined;
  for (const row of bySeq.values()) {
    if (row.payload.id !== source.checkpoint) continue;
    if (row.name !== "branch/checkpoint_intent" && row.name !== "branch/checkpoint_ready"
      && row.name !== "branch/checkpoint_failed") continue;
    requireProviderInput(row.kind === "observe"
      && branchCheckpointReceiptSchemas[row.name as "branch/checkpoint_intent"].safeParse(row.payload).success,
      "checkpoint import receipt row differs");
    requireProviderInput(row.payload.session === source.session
      && same(row.payload.source, { seq: head.seq, hash: head.hash }),
      "checkpoint import receipt binding differs");
    if (row.name === "branch/checkpoint_intent") {
      requireProviderInput(intentRow === undefined && readyRow === undefined,
        "checkpoint import intent differs");
      intentRow = row;
    } else if (row.name === "branch/checkpoint_ready") {
      requireProviderInput(intentRow !== undefined && readyRow === undefined,
        "checkpoint import ready row differs");
      requireProviderInput(row.payload.blob === source.digest && row.payload.image === manifest.workspaceImage.digest,
        "checkpoint import ready row differs");
      readyRow = row;
    } else {
      requireProviderInput(false, "checkpoint import source checkpoint failed");
    }
  }
  requireProviderInput(intentRow !== undefined && readyRow !== undefined && readyRow.seq === last.seq,
    "checkpoint import receipt chain differs");
  requireProviderInput(readyRow.payload.blob_bytes === Buffer.byteLength(canonicalJson(bundle.manifest)),
    "checkpoint import manifest bytes differ");

  // The exact original bodies: each is canonical, hashes to its digest, and
  // the set is exactly what the shared selection over the source chain names
  // (its provider rows, and under context-formal-work-v1 its retained formal
  // execution rows within the captured head).
  const bodies = verifySourceBodies(bundle.bodies);
  const carriedBytes = new Map(bundle.bodies.map(entry => [entry.digest, entry.bytes] as const));
  const referenced = new Set<string>();
  for (const { row, formal } of checkpointImportSourceBodyRows(events, head.seq)) {
    requireProviderInput(row.kind === "observe" && typeof row.payload.blob === "string",
      "checkpoint import body row differs");
    requireProviderInput(bodies.has(row.payload.blob), "checkpoint import body is unavailable");
    if (formal) {
      requireProviderInput(row.payload.blob_bytes === carriedBytes.get(row.payload.blob),
        "checkpoint import execution body bytes differ");
    }
    referenced.add(row.payload.blob);
  }
  requireProviderInput([...bodies.keys()].every(digest => referenced.has(digest)),
    "checkpoint import carries an unreferenced body");

  // Between the captured boundary and the checkpoint receipt only capture
  // work may exist — image acquisition and checkpoint receipts. Any provider,
  // model, tool or compaction row there is an unresolved effect at the
  // boundary the checkpoint never settled.
  const headEvents = events.slice(0, head.seq);
  for (const row of events.slice(head.seq)) {
    requireProviderInput(row.name.startsWith("execution_view/")
      || row.name === "branch/checkpoint_intent" || row.name === "branch/checkpoint_ready"
      || row.name === "branch/checkpoint_failed",
      "checkpoint import source boundary carries unresolved effects");
  }
  // And within the boundary itself: no pending compaction and no admitted
  // request left unanswered (an unresolved model effect the parent may still
  // be continuing).
  assertSettledSourceEffects(headEvents, bodies);
  // Re-fold the ORIGINAL state at the captured boundary — not whatever the
  // post-boundary rows might carry — with the fold that reads any session.
  const fold = new ProviderInputFold(projectSessionReplaySchemas(headEvents), mapSource(bodies), false);
  fold.extend(headEvents);
  const state = fold.stateView();
  requireProviderInput(!state.pending, "checkpoint import source has pending compaction");
  requireProviderInput(same({ ref: state.ref, messages: state.messages },
    { ref: manifest.providerState.ref, messages: manifest.providerState.messages })
    && canonicalJson(state.metadata ?? null) === canonicalJson(manifest.providerState.metadata ?? null),
    "checkpoint import source state differs from its manifest");

  // The seal, session and plugin manifest the manifest names are the recorded
  // ones at the captured boundary.
  const sealRow = lastNamedAtOrBefore(events, "prompt/seal", head.seq);
  requireProviderInput(sealRow !== undefined && sealRow.seq === sealRef.seq && sealRow.hash === sealRef.hash
    && sealRow.payload.prefix_hash === prefix.hash, "checkpoint import seal differs");
  requireProviderInput(frozenPrefixHash({ systemPrompt: prefixMaterial.systemPrompt as string,
    toolSchemas: toolSchemaSnapshot(prefixMaterial.tools as { name: string; description?: string }[]) }) === prefix.hash,
    "checkpoint import prefix material does not hash to its seal");
  const opened = lastNamedAtOrBefore(events, "session/open", head.seq);
  requireProviderInput(opened !== undefined && (opened.payload.session_id ?? opened.payload.id) === source.session
    && opened.payload.plugin_manifest_digest === manifest.pluginManifest,
    "checkpoint import session binding differs");

  // The declared transformation source: only authenticated host-context
  // frames (the append_context operations the fold above validated) leave
  // the imported transcript, and their exact bytes stay retained in the
  // bundle as historical evidence.
  const frameMessages = new Set<string>();
  for (const row of bySeq.values()) {
    if (row.name !== "provider/state" || typeof row.payload.blob !== "string") continue;
    const body = record(bodies.get(row.payload.blob));
    if (body.operation === "append_context" && body.origin === "host_context") {
      frameMessages.add(canonicalJson(body.message));
    }
  }
  for (const row of headEvents) {
    if (row.name !== "provider/state" || typeof row.payload.blob !== "string") continue;
    const body = record(bodies.get(row.payload.blob));
    requireProviderInput(body.operation !== "append" || !frameMessages.has(canonicalJson(body.message)),
      "checkpoint import ordinary message and host frame ownership are ambiguous");
  }
  const removedFrameIndices: number[] = [];
  const transformedMessages = state.messages.filter((message, index) => {
    if (frameMessages.has(canonicalJson(message))) {
      removedFrameIndices.push(index);
      return false;
    }
    return true;
  });
  const origins = sessionSecretProvenance(headEvents);
  requireProviderInput(newSecretValues([...bodies.values()], origins.authored, origins.observed).length === 0,
    "checkpoint import source contains an unverified credential pattern");
  const facts: ImportedCheckpointSource = {
    provenance: { authored: [...origins.authored].sort(), observed: [...origins.observed].sort() },
    sourceSession: source.session,
    checkpointId: source.checkpoint,
    checkpointDigest: source.digest,
    head,
    state,
    removedFrameIndices,
    transformedMessages,
    sourceMessagesDigest: inputDigest(state.messages),
    transformedDigest: inputDigest(transformedMessages),
    prefixHash: prefix.hash as string,
    sealRef,
    pluginManifest: manifest.pluginManifest as string,
    bundleBytes,
  };
  memoizeCheckpointSource(memoKey, text, bundleBytes, facts);
  return facts;
}

export function readProviderBodies(log: EventLog): Map<string, unknown> {
  const store = BlobStore.forSession(log.path), out = new Map<string, unknown>();
  const read = (digest: string): unknown => {
    try { return JSON.parse(store.get(digest)); }
    catch { throw new ProviderInputError("retained input body acquisition failed"); }
  };
  for (const event of log.events) {
    if (!PROVIDER_BODY_EVENTS.has(event.name)) continue;
    requireProviderInput(event.kind === "observe", "input producer is not an observation");
    requireProviderInput(typeof event.payload.blob === "string", "input body is missing");
    if (!out.has(event.payload.blob)) out.set(event.payload.blob, read(event.payload.blob));
    // R8-01: a checkpoint-import state row also names its retained source
    // evidence bundle; the whole-log fold reads it through this same map.
    const body = out.get(event.payload.blob);
    if (event.name === "provider/state" && body !== null && typeof body === "object" && !Array.isArray(body)) {
      const stateBody = body as Record<string, unknown>;
      const bundleRef = stateBody.bundle;
      const digest = bundleRef !== null && typeof bundleRef === "object"
        ? (bundleRef as { blob?: unknown }).blob : undefined;
      if (stateBody.reason === CHECKPOINT_IMPORT_REASON && typeof digest === "string" && !out.has(digest)) {
        out.set(digest, read(digest));
      }
    }
  }
  return out;
}

/** The bodies that carry the whole transcript, stored as parts when they
 * split (D53): the same bytes, digest and row, each message stored once. */
const PARTED_BODIES = new Set(["provider/payload", "provider/send"]);
/** One parts writer per session log: its chains end at bodies it appended. */
const partsWriters = new WeakMap<EventLog, PartsWriter>();
function partsWriterOf(log: EventLog): PartsWriter {
  let writer = partsWriters.get(log);
  if (!writer) partsWriters.set(log, writer = new PartsWriter());
  return writer;
}
function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The provenance an ordinary body never needs to read. */
const NO_PROVENANCE = { authored: new Set<string>() as ReadonlySet<string>,
  observed: new Set<string>() as ReadonlySet<string> };

/** A successful ordinary append is insufficient: read-only EventLog handles
 * may create an in-memory row. The durable writer is the sole send authority. */
export function appendProviderBody(log: EventLog, name: string, value: unknown,
  check?: (nextSeq: number) => void, lead?: EventInput): EventRecord {
  try {
  requireProviderInput(PROVIDER_BODY_EVENTS.has(name), "unknown input body producer");
  requireProviderInput(!log.isReadOnly, "read-only log cannot authorize input");
  log.assertCanRequestModel();
  const data = inputData(value), body = canonicalJson(data);
  // A credential pattern refuses only when its VALUE is new to this session.
  // A value the model itself already wrote — recorded as a digest by the
  // builder of the `tool/call` or `assistant/message` row, BEFORE the scrub
  // withheld the only copy — is the session's own product, not an operator
  // credential, and a session implementing authentication writes password
  // literals into its tests by necessity. A digest the session read from a
  // result, the order or an operator note is not authored, and certain classes
  // stay new wherever they appear. The provenance pass runs only on the path
  // that would otherwise refuse, so an ordinary body costs what it costs today.
  const guarded = containsSecretValue(data);
  const { authored, observed } = guarded ? sessionSecretProvenance(log.events) : NO_PROVENANCE;
  // A response body is authored BY CONSTRUCTION: it is the model's own reply,
  // and it is retained before any builder can claim its provenance. The one
  // thing that still disqualifies a value-judged capture here is the session
  // having READ that value before — then the model is quoting, not writing.
  // Certain classes never become authored, in a response or anywhere else.
  const claimed = guarded && name === PROVIDER_RESPONSE_EVENT
    ? authoredSecretDigests(data, () => observed) : [];
  const exemptions = claimed.length === 0 ? authored : new Set([...authored, ...claimed]);
  const rejectedValues = newSecretValues(data, exemptions, observed);
  const rejectedClass = rejectedValues.length ? secretShapeClassInValue(rejectedValues) : undefined;
  requireProviderInput(rejectedValues.length === 0,
    `input contains a credential pattern and cannot be retained${rejectedClass ? ` (${rejectedClass})` : ""}`);
  const exempt = exemptions.size === 0 ? { classes: [], count: 0 }
    : authoredSecretMatches(data, exemptions, observed);
  const store = BlobStore.forSession(log.path);
  // A transcript-carrying body is stored as parts when it splits: putParts
  // reads back every file it writes and checks that the manifest reassembles
  // to this digest (D53). Any other body, or one that does not split, is
  // stored whole and read back as before.
  const parts = PARTED_BODIES.has(name) ? store.putParts(body, partsWriterOf(log), name) : undefined;
  const digest = parts?.digest ?? store.put(body);
  if (!parts) requireProviderInput(store.get(digest) === body, "input body acquisition differs");
  const files = parts ? parts.written : [store.pathOf(digest)];
  for (const path of files) fsyncPath(path);
  for (const path of new Set([...files.map(file => dirname(file)), store.root])) fsyncPath(path);
  try {
    const rows = log.appendBatchDurable((nextSeq) => {
      check?.(nextSeq);
      // #222 D2': a lead row (a recorded model-input suffix) lands in the same
      // durable batch as the body that names it — both or neither.
      return [...(lead ? [lead] : []), { kind: "observe", name, payload: { schema: PROVIDER_INPUT_SCHEMA,
        blob: digest, blob_bytes: Buffer.byteLength(body), body_digest: digest,
        // The reply's own provenance, so the request that carries it back is
        // admitted without asking the model to write it a second time.
        ...(claimed.length === 0 ? {} : { authored_secret_digests: claimed }) } },
        // The exemption is data, in the same transaction as the body it
        // describes, so the row cannot exist without its body or follow a
        // different one. Classes and a count only: never a value.
        ...(exempt.count > 0 ? [{ kind: "observe" as const, name: "provider/input_authored",
          payload: { classes: exempt.classes, count: exempt.count } }] : [])];
    });
    // Later bodies chain to this one only once its row is durable.
    parts?.commit();
    return rows[lead ? 1 : 0]!;
  } catch (error) {
    throw new ProviderInputError(error instanceof Error ? error.message : "durable input append failed");
  }
  } catch (error) { throw observeProviderInputRefusal(log, error, name); }
}

/** The digest of a transcript, and of a request context around it, extended
 * one message at a time. canonicalJson of an array is `[` + its elements'
 * canonical texts joined by `,` + `]`, and of a context `{"messages":[…],
 * "systemPrompt":…,"tools":…}` (keys sorted), so both digests are the same
 * sha256 a whole-array inputDigest computes — without re-serializing every
 * earlier message each time the transcript grows by one. */
class TranscriptDigest {
  private readonly list: ReturnType<typeof createHash>;
  private readonly context: ReturnType<typeof createHash>;
  private count = 0;
  private memo: string | undefined;
  /** inputData bounds nesting by depth: an element sits one level deeper in
   * a context than in a bare transcript, so a message that only the deeper
   * bound refuses is remembered and refuses the context digest, as a
   * whole-context inputDigest would. */
  private contextRefusal: unknown;
  constructor(messages: readonly unknown[], mark?: TranscriptMark) {
    this.list = mark ? mark.list.copy() : createHash("sha256").update("[");
    this.context = mark ? mark.context.copy() : createHash("sha256").update("{\"messages\":[");
    if (mark) { this.count = mark.count; this.contextRefusal = mark.contextRefusal; }
    for (const message of messages) this.push(message);
  }
  /** #227: this digest's state, to resume from later (a frame's position). */
  mark(): TranscriptMark {
    return { list: this.list.copy(), context: this.context.copy(), count: this.count, contextRefusal: this.contextRefusal };
  }
  push(message: unknown): void {
    const text = (this.count === 0 ? "" : ",") + canonicalJson(inputData(message, 1));
    if (this.contextRefusal === undefined) {
      try { inputData(message, 2); } catch (error) { this.contextRefusal = error; }
    }
    this.list.update(text);
    this.context.update(text);
    this.count += 1;
    this.memo = undefined;
  }
  get messages(): string {
    return this.memo ??= this.list.copy().update("]").digest("hex");
  }
  /** inputDigest([...messages, message]) without extending this digest. */
  messagesWith(message: unknown): string {
    return this.list.copy().update(`${this.count === 0 ? "" : ","}${canonicalJson(inputData(message, 1))}]`).digest("hex");
  }
  contextWith(systemPrompt: string, tools: unknown): string {
    if (this.contextRefusal !== undefined) throw this.contextRefusal;
    return this.context.copy().update(`],"systemPrompt":${JSON.stringify(systemPrompt)},"tools":${canonicalJson(inputData(tools, 1))}}`)
      .digest("hex");
  }
}

/** A TranscriptDigest's state after a prefix of a transcript. */
interface TranscriptMark {
  readonly list: ReturnType<typeof createHash>;
  readonly context: ReturnType<typeof createHash>;
  readonly count: number;
  readonly contextRefusal: unknown;
}

/** Where a fold reads a provider row's body. The whole-log projection reads the
 * map its caller filled. The live projection and the sampled durable reload
 * read the store: each body when its row is folded, checked against the digest
 * its row records and dropped after (D51), so neither ever holds the session's
 * bodies — each payload and send body carries the whole transcript, and their
 * sum grows with the square of the session. */
interface BodySource {
  /** A store source reads a row's body where the whole-log readers did: before
   * the row's own checks, refusing a missing or unreadable body as they did. */
  readonly early: boolean;
  /** The parsed body, or ABSENT when a map holds none for the digest. */
  read(digest: string, row: string): unknown;
  /** The row that read bodies is folded: the fold keeps none of them whole. */
  settle(): void;
}
const ABSENT = Symbol("absent input body");

function mapSource(bodies: ReadonlyMap<string, unknown>): BodySource {
  return { early: false, read: digest => bodies.has(digest) ? bodies.get(digest) : ABSENT, settle() {} };
}

/** The bodies whose parts a live projection hands out (the transcript's
 * messages, the prefix material, the newest request): frozen when read. */
const HANDED_OUT = new Set(["provider/state", "provider/prefix", "provider/request"]);

/** `count` sees each body's byte length and how many bodies the current row
 * has read so far (diagnostic). */
function storeSource(path: string, count: (bytes: number, atOnce: number) => void, freeze: boolean, suppliedStore?: BlobStore): BodySource {
  const store = suppliedStore ?? BlobStore.forSession(path);
  let open = 0;
  return {
    early: true,
    read(digest, row) {
      let text: string, body: unknown;
      try { text = store.get(digest); body = JSON.parse(text); }
      catch { throw new ProviderInputError("retained input body acquisition failed"); }
      open += 1;
      count(Buffer.byteLength(text), open);
      return freeze && HANDED_OUT.has(row) ? deepFreeze(body) : body;
    },
    settle() { open = 0; },
  };
}

/** A split payload or send body as the sampled durable reload reads it
 * (D53): its manifest, lists and parts each checked against their own
 * digest, and the body's skeleton — every field it carries, with its arrays
 * and its encoded bytes emptied. That the parts reassemble to the digest the
 * row records was checked when the body was written. */
class PartedBody {
  constructor(readonly digest: string, readonly bytes: number, readonly skeleton: unknown) {}
}

/** The sampled durable reload's reads: a whole body is read and checked
 * against its digest, as before; a split payload or send body's stored
 * files are each read and checked once per reload — the reload reads the
 * session's unique bytes, not every body (D53). `count` sees the bytes read
 * from disk for each row and how many bodies the row has read so far. */
function reloadSource(path: string, count: (bytes: number, atOnce: number) => void): BodySource {
  const store = BlobStore.forSession(path), memo = storedFileMemo();
  let open = 0;
  return {
    early: true,
    read(digest, row) {
      const before = memo.bytesRead;
      let body: unknown;
      try {
        const stored = store.verifyBody(digest, memo);
        if (stored.layout === "whole") body = JSON.parse(stored.text);
        else if (PARTED_BODIES.has(row)) body = new PartedBody(digest, stored.manifest.bytes, JSON.parse(stored.hollow));
        // A split body of any other row is read whole (none is written so).
        else body = JSON.parse(store.get(digest));
      } catch { throw new ProviderInputError("retained input body acquisition failed"); }
      open += 1;
      count(memo.bytesRead - before, open);
      return body;
    },
    settle() { open = 0; },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** What later rows are checked against of a request: never its transcript. */
interface RequestFacts { ref: InputReference; model: Record<string, unknown>; tools: unknown[]; contextDigest: string }
/** What a send is compared with of its adapter payload: digests, and the body's
 * digest to read it back for the one check that needs the payload itself.
 * The digests are absent for a split payload at the durable reload (D53). */
interface PayloadFacts { ref: InputReference; request: RequestFacts; body: string; payloadDigest?: string; httpDigest?: string }
interface SendFacts { ref: InputReference; request: InputReference; payload: InputReference }
interface ResponseFacts { ref: InputReference; request: RequestFacts; send: InputReference | null; body: string }

/** A recorded request's identity, as the live projection and the durable
 * reload answer it. */
export interface ProviderRequestIdentity { readonly ref: InputReference; readonly contextDigest: string }

/** What the live projection of a writer's log hands out: the current
 * transcript state, the newest request with the context it was admitted with,
 * how many sends are recorded, and any recorded request's identity. */
export interface LiveProviderInputs {
  state: ProviderState;
  latestRequest: ProviderInputRecord | undefined;
  sendCount: number;
  request(ref: InputReference): ProviderRequestIdentity | undefined;
}

/** The provider-input projection as a fold over the log: every row is checked
 * once, in order, against the state the rows before it built. The whole-log
 * function below is one fold over every row; the live projection of a
 * writer's log (liveFold) keeps the fold and extends it with the rows appended
 * since, so a request no longer re-reads and re-checks the whole session
 * (D44). The checks and their refusals are the same either way.
 *
 * What the fold keeps is what later rows are checked against (D51): each
 * request's, payload's, send's and response's reference and digests, each
 * transcript state's digest, the current transcript, the prefix in force and
 * the newest request. No body is kept whole. A send is compared with its
 * payload by digest; the one check that needs payloads and a reply themselves
 * (a Codex WebSocket continuation) reads them back from the body source. Only
 * the whole-log projection collects every request, send and identity for its
 * caller. */
class ProviderInputFold {
  readonly state: ProviderState = { ref: null, messages: [] };
  private digest = new TranscriptDigest([]);
  private readonly states = new Map<number, { ref: InputReference; digest: string }>();
  /** Requests may name only the prefix in force, so only it is kept. `seal`
   * is the seal row the retained material is bound to — an older seal with
   * the same prefix hash is not the seal now in force. */
  private prefix: { ref: InputReference; seal: InputReference; systemPrompt: string; tools: unknown[] } | undefined;
  private readonly requestsBySeq = new Map<number, RequestFacts>();
  /** Requests carry the same model identity: one object per distinct model. */
  private readonly models = new Map<string, Record<string, unknown>>();
  private readonly payloads = new Map<number, PayloadFacts>();
  private readonly sendsBySeq = new Map<number, SendFacts>();
  private readonly responses = new Map<number, ResponseFacts>();
  private readonly bySeq = new Map<number, EventRecord>();
  private latestSeal: EventRecord | undefined;
  /** #227: the blob digests of every recorded context surface. */
  private readonly surfaceDigests = new Set<string>();
  /** #227: the one live frame of the current transcript — its position and
   * the digest state before it — `null` when there is none, undefined when
   * unknown (after a replace; the next need scans). */
  private liveFrame: { index: number; mark: TranscriptMark } | null | undefined = null;
  private latestOpen: EventRecord | undefined;
  /** R8-01: the import receipt chain being folded — an intent whose state
   * row is next, or an import state row whose ready row is next. An honest
   * import is one atomic intent/state/ready batch, so neither state survives
   * folding a batch; an unresolved chain (an intent-only fixture, a torn
   * write) refuses the fold and authorizes nothing. */
  private awaitingImportState: number | undefined;
  private lastImport: { seq: number; bundle: string; source: unknown; session: string } | undefined;
  /** R8-01: sessions that already imported — one import per session; a
   * second intent or an unmatched terminal receipt refuses the fold. */
  private readonly importedSessions = new Set<string>();
  private readonly history: Pick<ProviderInputProjection, "requests" | "sends" | "identities"> | undefined;
  /** The newest request, with the context it was admitted with. */
  latestRequest: ProviderInputRecord | undefined;
  sendCount = 0;
  /** How many rows of the log the fold has consumed, and the last one's hash. */
  consumed = 0;
  head: string | undefined;

  /** `history`: collect every request, send and identity (the whole-log
   * projection's result); a live fold or a reload keeps none of them. */
  constructor(private readonly schemas: ReturnType<typeof projectSessionReplaySchemas>,
    private readonly source: BodySource, history: boolean) {
    this.history = history ? { requests: [], sends: [], identities: [] } : undefined;
  }

  /** The digest of the current transcript (inputDigest(state.messages)). */
  get messagesDigest(): string {
    return this.digest.messages;
  }

  /** inputDigest([...state.messages, message]). */
  messagesDigestWith(message: unknown): string {
    return this.digest.messagesWith(message);
  }

  /** The material of the prefix row in force, with the seal it is bound to. */
  get prefixInForce(): { ref: InputReference; seal: InputReference; systemPrompt: string; tools: unknown[] } | undefined {
    return this.prefix;
  }

  /** Fold rows [consumed, events.length). `events` is the whole log: the few
   * checks that look back at earlier rows read it, never a later row. */
  extend(events: readonly EventRecord[]): void {
    const enrolled = this.schemas.featureStart.get(PROVIDER_INPUT_SCHEMA);
    for (let index = this.consumed; index < events.length; index += 1) {
      const event = events[index]!;
      this.bySeq.set(event.seq, event);
      try { this.step(events, event, enrolled); } finally { this.source.settle(); }
      if (event.name === "prompt/seal") this.latestSeal = event;
      if (event.name === "session/open") this.latestOpen = event;
      this.consumed = index + 1;
      this.head = event.hash;
    }
    // R8-01: an import receipt chain a whole batch did not close is not an
    // import state anyone may build on — it refuses here.
    requireProviderInput(this.awaitingImportState === undefined && this.lastImport === undefined,
      "checkpoint import receipt chain is unresolved");
  }

  private step(events: readonly EventRecord[], event: EventRecord, enrolled: number | undefined): void {
    const { schemas, state, states, payloads, responses, bySeq, history } = this;
    // R8-01: an intent is followed by exactly its import state row, and an
    // import state row by exactly its ready receipt — anything else between
    // (or nothing after) is a chain that never closed honestly.
    if (this.awaitingImportState !== undefined) {
      requireProviderInput(event.seq === this.awaitingImportState + 1 && event.name === "provider/state"
        && event.kind === "observe", "checkpoint import intent has no import state row");
    }
    if (event.name === "branch/import_ready") {
      // A terminal receipt no import state row is waiting for — standalone or
      // duplicate — authorizes nothing and refuses the fold.
      requireProviderInput(this.lastImport !== undefined && event.seq === this.lastImport.seq + 1,
        "checkpoint import ready receipt binding differs");
      this.stepCheckpointImportReady(event);
      return;
    }
    if (event.name === "branch/import_intent") this.stepCheckpointImportIntent(event);
    if (state.pending && event.name === "compaction/end" && event.payload.status === "recovered"
      && event.payload.start_seq === state.pending.start) delete state.pending;
    if (state.pending && event.name === "prompt/seal" && event.payload.reason === "compaction") {
      const pending = state.pending;
      requireProviderInput(events.some(row => row.seq > state.ref!.seq && row.seq < event.seq
        && row.kind === "observe" && row.name === "compaction/drop" && row.payload.start_seq === pending.start
        && row.payload.dropped_messages === pending.drop && row.payload.kept_messages === pending.messages.length),
        "compaction drop is missing or differs from the pending transformation");
      state.messages = pending.messages; delete state.pending;
      this.digest = new TranscriptDigest(state.messages);
      this.liveFrame = undefined;
      if (state.ref) states.set(state.ref.seq, { ref: state.ref, digest: this.digest.messages });
    }
    // #227: a recorded host-context surface; a transcript message with its
    // exact bytes is that frame (never a lookalike).
    if (event.name === "context/surface" && event.kind === "surface" && typeof event.payload.blob === "string") {
      this.surfaceDigests.add(event.payload.blob);
    }
    if (!PROVIDER_BODY_EVENTS.has(event.name)) return;
    requireProviderInput(event.kind === "observe", "input producer is not an observation");
    let found: unknown = ABSENT;
    if (this.source.early) {
      requireProviderInput(typeof event.payload.blob === "string", "input body is missing");
      found = this.source.read(event.payload.blob, event.name);
    }
    requireProviderInput(schemas.references.length === 0 || (enrolled !== undefined && event.seq > enrolled),
      "input row precedes its declared feature generation");
    requireProviderInput(event.payload.schema === PROVIDER_INPUT_SCHEMA, "input schema missing or changed");
    const digest = event.payload.blob;
    if (!this.source.early && typeof digest === "string") found = this.source.read(digest, event.name);
    requireProviderInput(typeof digest === "string" && found !== ABSENT, "retained input body is unavailable");
    // A split body at the durable reload is its skeleton: the manifest that
    // records this digest and length, and every file it names, were checked
    // against their own digests, and the put checked they reassemble to it.
    const parted = found instanceof PartedBody;
    const body = record(found instanceof PartedBody ? found.skeleton : found);
    if (found instanceof PartedBody) {
      requireProviderInput(found.digest === digest && event.payload.body_digest === digest
        && event.payload.blob_bytes === found.bytes, "input body identity differs");
    } else {
      const encoded = canonicalJson(inputData(body));
      // inputDigest(body) is the sha256 of exactly this canonical text.
      requireProviderInput(createHash("sha256").update(encoded).digest("hex") === digest && event.payload.body_digest === digest
        && event.payload.blob_bytes === Buffer.byteLength(encoded), "input body identity differs");
    }
    requireProviderInput(body.version === 1, "input body version differs");
    history?.identities.push({ seq: event.seq, hash: event.hash, body: digest });
    if (event.name === "provider/state") {
      requireProviderInput(same(body.prior, state.ref), "transcript history reference differs");
      requireProviderInput(body.before === this.digest.messages, "transcript before identity differs");
      requireProviderInput(!state.pending, "unsettled compaction cannot authorize new transcript state");
      let next: unknown[];
      let nextDigest: TranscriptDigest;
      // #227: where the one live frame sits after this row (append rows keep
      // it; a replace makes it unknown until the next scan).
      let liveFrame: { index: number; mark: TranscriptMark } | null | undefined = this.liveFrame;
      if (body.operation === "append_context") {
        // #227 CG-04: a host-context frame joins the transcript only under
        // the feature generation that defines it, only as the exact bytes of
        // a `context/surface` row recorded before it, and only as a user-role
        // message whose event origin is host_context — never a user/message,
        // never an operator order, never a tool result.
        const contextStart = schemas.featureStart.get(CONTEXT_GRAPH_FEATURE);
        requireProviderInput(contextStart !== undefined && event.seq > contextStart,
          "host context precedes its declared feature generation");
        const message = record(body.message);
        requireProviderInput(message.role === "user" && body.origin === "host_context", "host context has an invalid origin or role");
        const source = reference(body.source), original = bySeq.get(source.seq);
        requireProviderInput(original?.hash === source.hash && original.seq < event.seq && original.name === "context/surface"
          && original.kind === "surface" && original.payload.frame_id === body.frame_id, "host context has no recorded surface");
        const contextText = messageText(message.content);
        requireProviderInput(contextText !== undefined && createHash("sha256").update(contextText).digest("hex") === original.payload.blob
          && Buffer.byteLength(contextText) === original.payload.blob_bytes
          && Array.isArray(message.content) && message.content.length === 1, "host context differs from its recorded surface");
        // §130 F1: one live frame. The operation names every earlier frame
        // the transcript carries, and replaces them all — never appends a
        // second one.
        const replaces = body.replaces;
        requireProviderInput(Array.isArray(replaces) && same(replaces, this.frameIndexes(state.messages)),
          "host context must replace every earlier frame");
        const dropped = new Set(replaces as number[]);
        next = [...state.messages.filter((_, index) => !dropped.has(index)), body.message];
        const resumed = this.withoutFrames(state.messages, replaces as number[]);
        liveFrame = { index: next.length - 1, mark: resumed.mark() };
        resumed.push(body.message);
        nextDigest = resumed;
      } else if (body.operation === "append") {
        const message = record(body.message);
        requireProviderInput(["user", "assistant", "toolResult"].includes(String(message.role)), "unsupported message role");
        if (message.role === "user") {
          // #222 D2': a recorded model-input suffix is the row directly before
          // this one, written in the same durable batch; any other user
          // message names its earlier `user/message` by seq and hash.
          const contribution = body.source_kind === MODEL_INPUT_CONTRIBUTION_EVENT;
          const seq = Number(record(body.source).seq);
          const source = contribution ? undefined : reference(body.source);
          const original = bySeq.get(contribution ? seq : source!.seq);
          requireProviderInput(original && (contribution
            ? original.seq === event.seq - 1 && original.name === MODEL_INPUT_CONTRIBUTION_EVENT && original.kind === "surface"
            : original.hash === source!.hash && original.seq < event.seq && original.name === "user/message"),
          "user message has no prior surface authority");
          const text = typeof message.content === "string" ? message.content
            : Array.isArray(message.content) ? message.content.map(value => record(value).text ?? "").join("\n") : undefined;
          requireProviderInput(text === original.payload.text, "user message differs from admitted surface");
        }
        next = [...state.messages, body.message];
        // The running digest extends in place; a refusal below discards the
        // whole fold, so it never outlives the row it was extended for.
        nextDigest = this.digest;
        nextDigest.push(body.message);
      } else {
        requireProviderInput(body.operation === "replace" && Array.isArray(body.messages), "invalid transcript operation");
        requireProviderInput(["start", "session/fresh_start", "session/reseed", "session/resume_archive", "context/slim", "context/prune",
          "tool/unknown_tool_hint", "tool/source_recovery", "model/retry", "model/failover", "model/handoff", "model/handoff_rollback", "compaction",
          CHECKPOINT_IMPORT_REASON].includes(String(body.reason)), "undeclared transcript transformation");
        requireProviderInput(body.reason !== "start" || (state.ref === null && body.messages.length === 0), "initial transcript is not empty");
        next = body.messages;
        liveFrame = undefined;
        if (body.reason === CHECKPOINT_IMPORT_REASON) this.stepCheckpointImportState(event, body, next);
        if (body.reason === "session/fresh_start") requireProviderInput(next.length === 0, "fresh start is not empty");
        if (body.reason === "model/handoff_rollback") {
          // A state's messages are kept as the digest of their canonical text:
          // equal digests are equal canonical texts.
          const source = reference(body.source_state), original = states.get(source.seq);
          requireProviderInput(original && same(original.ref, source) && original.digest === canonicalDigest(next),
            "handoff rollback source differs");
        }
        if (body.reason === "session/resume_archive") {
          const head = reference(body.source_head), prior = bySeq.get(head.seq);
          requireProviderInput(prior?.hash === head.hash && head.seq < event.seq, "archived history source is missing");
          const rows = events.filter(row => row.seq <= head.seq);
          const archived = new ProviderInputFold(projectSessionReplaySchemas(rows), this.source, false);
          archived.extend(rows);
          requireProviderInput(archived.state.ref && !archived.state.pending && same(archived.state.messages, next),
            "archived cache is not its recorded history");
          state.metadata = archived.state.metadata;
        }
        if (body.reason === "compaction") {
          requireProviderInput(typeof body.summary === "string" && Number.isSafeInteger(body.drop_messages)
            && Number(body.drop_messages) > 0 && Number(body.drop_messages) <= state.messages.length,
            "compaction transformation is invalid");
          requireProviderInput(same(next, [{ role: "user", content: [{ type: "text", text: `[compaction summary] ${body.summary}` }] },
            ...state.messages.slice(Number(body.drop_messages))]), "compaction output differs from its recorded transformation");
        }
        nextDigest = new TranscriptDigest(next);
      }
      requireProviderInput(body.after === nextDigest.messages, "transcript after identity differs");
      if (body.metadata !== undefined) state.metadata = record(body.metadata);
      if (body.reason === "session/fresh_start") delete state.metadata;
      state.ref = inputReference(event);
      if (body.reason === "compaction") {
        const start = Number(body.compaction_start), original = bySeq.get(start);
        requireProviderInput(original?.name === "compaction/start" && original.seq < event.seq, "compaction authority is missing");
        state.pending = { start, messages: next, drop: Number(body.drop_messages) };
      } else {
        state.messages = next;
        this.digest = nextDigest;
        this.liveFrame = liveFrame;
      }
      states.set(event.seq, { ref: state.ref, digest: this.digest.messages });
    } else if (event.name === "provider/prefix") {
      requireProviderInput(typeof body.systemPrompt === "string" && Array.isArray(body.tools), "prefix material missing");
      const sealRef = reference(body.seal), seal = bySeq.get(sealRef.seq);
      requireProviderInput(seal?.name === "prompt/seal" && seal.hash === sealRef.hash && seal.seq < event.seq
        && (!this.prefix || seal.seq > this.prefix.ref.seq), "prefix has no new seal authority");
      assertSealEvent(seal);
      requireProviderInput(seal.payload.prefix_hash === frozenPrefixHash({ systemPrompt: body.systemPrompt,
        toolSchemas: toolSchemaSnapshot(body.tools as { name: string; description: string }[]) }), "prefix differs from seal");
      this.prefix = { ref: inputReference(event), seal: sealRef, systemPrompt: body.systemPrompt, tools: body.tools };
    } else if (event.name === "provider/request") {
      const stateRef = reference(body.state), prefixRef = reference(body.prefix);
      const transcript = states.get(stateRef.seq), prefix = this.prefix?.ref.seq === prefixRef.seq ? this.prefix : undefined;
      requireProviderInput(transcript && prefix && same(transcript.ref, stateRef) && same(prefix.ref, prefixRef)
        && stateRef.seq < event.seq && prefixRef.seq < event.seq && same(state.ref, stateRef)
        && same(this.prefix?.ref, prefixRef) && !state.pending,
        "request source does not match current retained input");
      // The state named is the current one (same(state.ref, stateRef)), so its
      // messages are the current transcript and the running digest is its digest.
      const context = { systemPrompt: prefix.systemPrompt, tools: prefix.tools, messages: state.messages };
      requireProviderInput(body.context_digest === this.digest.contextWith(context.systemPrompt, context.tools),
        "request differs from independently derived context");
      requireProviderInput(typeof body.route === "string" && typeof body.role === "string", "request producer missing");
      const request: ProviderInputRecord = { ref: inputReference(event), state: stateRef, prefix: prefixRef,
        route: body.route, role: body.role, model: record(body.model), options: record(body.options),
        context, contextDigest: String(body.context_digest) };
      history?.requests.push(request);
      this.latestRequest = request;
      this.requestsBySeq.set(event.seq, { ref: request.ref, model: this.model(request.model), tools: prefix.tools,
        contextDigest: request.contextDigest });
      // The seal and the session/open in force at this row: the latest of
      // each before it (rows fold in seq order).
      const seal = this.latestSeal!;
      requireProviderInput(seal.payload.prefix_hash === frozenPrefixHash({ systemPrompt: context.systemPrompt,
        toolSchemas: toolSchemaSnapshot(context.tools as { name: string; description: string }[]) }), "request differs from the active seal");
      const opened = this.latestOpen;
      state.metadata = { prefix_hash: seal.payload.prefix_hash, system_prompt_hash: systemPromptHash(context.systemPrompt),
        ...(typeof seal.payload.tool_schema_hash === "string" ? { tool_schema_hash: seal.payload.tool_schema_hash } : {}),
        ...(typeof opened?.payload.plugin_manifest_digest === "string" ? { plugin_manifest_digest: opened.payload.plugin_manifest_digest } : {}),
        model_id: record(body.model).id, route: body.route };
    } else if (event.name === "provider/payload") {
      const ref = reference(body.request), request = this.request(ref);
      requireProviderInput(request && request.ref.seq < event.seq && body.context_digest === request.contextDigest
        && body.adapter === request.model.api, "adapter payload has no matching request");
      // A send is compared with its payload by these digests (equal digests
      // are equal canonical texts); the payload itself is not kept.
      const payload = record(body.payload);
      if (parted) payloads.set(event.seq, { ref: inputReference(event), request, body: digest });
      else {
        const payloadDigest = canonicalDigest(payload), http = providerHttpPayload(request.model.api, payload);
        payloads.set(event.seq, { ref: inputReference(event), request, body: digest, payloadDigest,
          httpDigest: http === payload ? payloadDigest : canonicalDigest(http) });
      }
    } else if (event.name === "provider/send") {
      const requestRef = reference(body.request), request = this.request(requestRef);
      requireProviderInput(request && requestRef.seq < event.seq && body.ordinal === this.sendCount + 1,
        "send request reference or ordinal differs");
      requireProviderInput(body.sample_denominator === 20 && body.sample_selected === (Number(body.ordinal) % 20 === 0), "send sampling denominator differs");
      requireProviderInput(body.context_digest === request.contextDigest && typeof body.transport === "string", "send input identity differs");
      const payloadRef = reference(body.payload), payload = payloads.get(payloadRef.seq);
      requireProviderInput(payload && same(payload.ref, payloadRef) && same(payload.request.ref, requestRef)
        && payloadRef.seq < event.seq, "send has no observed adapter payload");
      if (body.sample_selected) {
        const sample = record(body.sample_audit), head = reference(sample.source_head), source = bySeq.get(head.seq);
        requireProviderInput(source?.hash === head.hash && source.seq < event.seq && source.seq >= payloadRef.seq
          && sample.source === "durable-log-reload" && sample.context_digest === request.contextDigest
          && (payload.payloadDigest === undefined ? typeof sample.payload_digest === "string"
            : sample.payload_digest === payload.payloadDigest), "sampled durable reload receipt differs");
      } else requireProviderInput(body.sample_audit === undefined, "unsampled send has a sampled receipt");
      requireProviderInput(typeof body.encoded_body === "string", "send bytes are missing");
      // A split send at the durable reload is its skeleton (D53): the checks of
      // its bytes against themselves and against its payload were made when
      // its row was folded live, on exactly the bytes its checked parts hold.
      const bytes = parted ? undefined : Buffer.from(body.encoded_body, "base64");
      requireProviderInput(bytes ? bytes.toString("base64") === body.encoded_body && bytes.byteLength === body.encoded_bytes
        && createHash("sha256").update(bytes).digest("hex") === body.encoded_digest
        : Number.isSafeInteger(body.encoded_bytes) && typeof body.encoded_digest === "string"
          && /^[a-f0-9]{64}$/u.test(body.encoded_digest), "send byte identity differs");
      const transform = record(body.transformation);
      const encoding = body.transport === "http" ? transform.encoding : "identity";
      requireProviderInput(encoding === "identity" || encoding === "zstd", "unsupported retained send encoding");
      const decoded = bytes ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoding === "zstd" ? zstdDecompressSync(bytes) : bytes))
        : body.decoded_body;
      const decodedText = bytes ? canonicalJson(decoded) : undefined;
      if (decodedText !== undefined) requireProviderInput(decodedText === canonicalJson(body.decoded_body), "send decoded bytes differ");
      requireProviderInput(body.observation === "before_transport_dispatch", "send observation boundary missing");
      // The send's decoded text and its payload's digests, when both are whole.
      const content = decodedText !== undefined && payload.payloadDigest !== undefined ? decodedText : undefined;
      if (body.transport === "http") {
        requireProviderInput(transform.kind === (request.model.api === "anthropic-messages" ? "anthropic-stream" : "identity")
          && (content === undefined || createHash("sha256").update(content).digest("hex") === payload.httpDigest),
          "HTTP transformation differs from observed adapter payload");
      } else {
        requireProviderInput(body.transport === "websocket" && request.model.api === "openai-codex-responses", "unsupported retained transport");
        const { type, ...actual } = record(decoded);
        requireProviderInput(type === "response.create", "unsupported retained WebSocket frame");
        if (transform.kind === "codex-full") requireProviderInput(content === undefined || canonicalDigest(actual) === payload.payloadDigest, "full WebSocket payload differs");
        else {
          requireProviderInput(transform.kind === "codex-cache-delta", "unsupported WebSocket transformation");
          const responseRef = reference(transform.previous_response), previous = responses.get(responseRef.seq);
          const previousSend = this.send(transform.previous_send);
          requireProviderInput(previous && same(previous.ref, responseRef) && same(previous.request.ref, transform.previous_request)
            && previousSend && same(previousSend.request, previous.request.ref) && same(previous.send, previousSend.ref)
            && previous.ref.seq < event.seq, "WebSocket continuation authority differs");
          // The one check that needs both payloads and the reply themselves:
          // they are read back from the body source for it (the durable
          // reload skips it for split bodies, as it skips the checks above).
          const previousPayload = payloads.get(previousSend.payload.seq)!;
          if (content !== undefined && previousPayload.payloadDigest !== undefined) {
            const expected = deriveCodexContinuation({ model: previous.request.model, tools: previous.request.tools,
              payload: this.payloadBody(previousPayload), assistant: this.assistantBody(previous) },
              this.payloadBody(payload));
            requireProviderInput(expected && same(actual, expected), "WebSocket cached delta differs from recorded history");
          }
        }
      }
      const ref = inputReference(event);
      history?.sends.push({ ref, request: requestRef, ordinal: Number(body.ordinal), transport: body.transport, body });
      this.sendsBySeq.set(event.seq, { ref, request: requestRef, payload: payloadRef });
      this.sendCount += 1;
    } else if (event.name === "provider/response") {
      const ref = reference(body.request), request = this.request(ref);
      requireProviderInput(request && request.ref.seq < event.seq, "response request is unavailable");
      const send = body.send === null ? null : reference(body.send);
      requireProviderInput(!send || this.sendsBySeq.has(send.seq) && same(this.sendsBySeq.get(send.seq)!.ref, send)
        && same(this.sendsBySeq.get(send.seq)!.request, ref), "response send is unavailable");
      const assistant = record(body.assistant);
      requireProviderInput(assistant.role === "assistant" && Array.isArray(assistant.content)
        && assistant.model === request.model.id && assistant.api === request.model.api && assistant.provider === request.model.provider,
        "response model identity differs");
      requireProviderInput(send || assistant.stopReason === "error" || assistant.stopReason === "aborted", "successful response has no send");
      responses.set(event.seq, { ref: inputReference(event), request, send, body: digest });
    }
  }

  /** R8-01: an intent receipt opens the one-batch import chain. One import
   * per session; its full binding is checked when the state row that owns it
   * folds. */
  private stepCheckpointImportIntent(event: EventRecord): void {
    const parsed = checkpointImportReceiptSchemas["branch/import_intent"].safeParse(event.payload);
    requireProviderInput(event.kind === "observe" && parsed.success,
      "checkpoint import intent receipt is invalid");
    const intent = parsed.data!;
    requireProviderInput(!this.importedSessions.has(intent.session),
      "checkpoint import session already has an import");
    this.awaitingImportState = event.seq;
  }

  /** R8-01: the ready receipt closes the import chain. EVERY field is
   * validated against the actual imported state row's retained body — not
   * merely the sequence numbers — so a rewritten payload that still chains
   * cannot masquerade as the publication of different facts. */
  private stepCheckpointImportReady(event: EventRecord): void {
    const parsed = checkpointImportReceiptSchemas["branch/import_ready"].safeParse(event.payload);
    requireProviderInput(event.kind === "observe" && parsed.success,
      "checkpoint import ready receipt is invalid");
    const ready = parsed.data!;
    const last = this.lastImport!;
    const stateRow = this.bySeq.get(last.seq);
    requireProviderInput(stateRow !== undefined && stateRow.name === "provider/state"
      && typeof stateRow.payload.blob === "string", "checkpoint import ready names no state row");
    const body = record(this.reread(stateRow.payload.blob, "provider/state"));
    requireProviderInput(event.seq === last.seq + 1 && ready.state_seq === last.seq
      && ready.session === last.session && ready.bundle.blob === last.bundle,
      "checkpoint import ready receipt binding differs");
    requireProviderInput(same(ready.source, body.source) && same(ready.bundle, body.bundle)
      && same(ready.prefix, body.prefix) && same(ready.removed_frames, body.removed_frames)
      && ready.source_digest === body.source_digest && ready.transformed_digest === body.after,
      "checkpoint import ready receipt differs from the imported state");
    this.lastImport = undefined;
  }

  /** R8-01: the `session/checkpoint_import` transcript transformation. The
   * fold re-derives everything the writer checked — and holds the writer to
   * conditions it could otherwise skip: a fresh empty prior state, the
   * session's actual plugin manifest equal to the source's, the prefix row
   * actually in force and bound to the seal actually in force, and metadata
   * that is exactly the declared transform of the retained source metadata. */
  private stepCheckpointImportState(event: EventRecord, body: Record<string, unknown>, next: unknown[]): void {
    const start = this.schemas.featureStart.get(CHECKPOINT_IMPORT_SCHEMA);
    requireProviderInput(start !== undefined && event.seq > start,
      "checkpoint import precedes its declared feature generation");
    const opened = this.latestOpen;
    const session = opened?.payload.session_id ?? opened?.payload.id;
    requireProviderInput(typeof session === "string" && session.length > 0, "checkpoint import has no open session");
    // First import into a fresh, empty prior state.
    const { state } = this;
    requireProviderInput(body.prior === null && state.ref === null && state.messages.length === 0,
      "checkpoint import target state is not fresh");
    requireProviderInput(importSourceRefSchema.safeParse(body.source).success
      && importBundleRefSchema.safeParse(body.bundle).success, "checkpoint import binding is malformed");
    const source = record(body.source), bundleRef = record(body.bundle);
    // The retained bundle is rooted for GC and preservation by the row's own
    // source_blob — it must name exactly the body's bundle.
    requireProviderInput(event.payload.source_blob === bundleRef.blob,
      "checkpoint import source blob differs from its bundle");
    const intent = this.bySeq.get(Number(body.intent_seq));
    const intentBundle = intent !== undefined && intent.payload.bundle !== null
      && typeof intent.payload.bundle === "object" ? intent.payload.bundle : undefined;
    requireProviderInput(typeof body.intent_seq === "number" && Number.isSafeInteger(body.intent_seq)
      && intent !== undefined && intent.seq === event.seq - 1 && intent.name === "branch/import_intent"
      && intent.kind === "observe" && intent.payload.session === session
      && same(intent.payload.source, source)
      && intentBundle !== undefined && same(intentBundle, bundleRef),
      "checkpoint import intent differs");
    requireProviderInput(this.awaitingImportState === intent.seq, "checkpoint import state row does not follow its intent");
    const bundle = record(this.reread(String(bundleRef.blob), event.name));
    const bundleText = canonicalJson(bundle);
    requireProviderInput(createHash("sha256").update(bundleText).digest("hex") === bundleRef.blob
      && Buffer.byteLength(bundleText) === bundleRef.blob_bytes, "checkpoint import bundle identity differs");
    const facts = validateImportedCheckpointSource(bundle);
    assertCheckpointImportTargetHistory([...this.bySeq.values()].filter(row => row.seq < intent.seq));
    requireProviderInput(same(event.payload.authored_secret_digests ?? [], facts.provenance.authored)
      && same(event.payload.observed_secret_digests ?? [], facts.provenance.observed),
      "checkpoint import origin claims differ from retained source evidence");
    requireProviderInput(facts.checkpointId === source.checkpoint && facts.checkpointDigest === source.digest
      && facts.sourceSession === source.session && same(facts.head, source.head)
      && facts.bundleBytes === bundleRef.blob_bytes,
      "checkpoint import source differs from its retained evidence");
    requireProviderInput(facts.sourceSession !== session, "checkpoint import names its own session");
    // Source/target plugin equality against the session/open actually in force.
    requireProviderInput(opened!.payload.plugin_manifest_digest === facts.pluginManifest,
      "checkpoint import plugin manifest differs from the open session");
    requireProviderInput(body.source_digest === facts.sourceMessagesDigest,
      "checkpoint import source digest differs");
    requireProviderInput(same(body.removed_frames, facts.removedFrameIndices),
      "checkpoint import frame removal differs");
    requireProviderInput(same(next, facts.transformedMessages),
      "imported transcript differs from its retained source");
    const transition = importPrefixTransitionSchema.safeParse(body.prefix);
    requireProviderInput(transition.success, "checkpoint import prefix transition is malformed");
    const change = transition.data!;
    const seal = this.latestSeal!;
    requireProviderInput(same(change.source_seal, facts.sealRef) && change.source_prefix_hash === facts.prefixHash,
      "checkpoint import source prefix differs");
    // The actual current target: the seal in force AND the prefix row in
    // force bound to that very seal — a prior prefix row under an older seal
    // with the same hash is not current retained material.
    requireProviderInput(same(change.target_seal, inputReference(seal)) && change.target_prefix_hash === seal.payload.prefix_hash,
      "checkpoint import target seal differs");
    requireProviderInput(this.prefix !== undefined && this.prefix.ref.seq === change.target_prefix_seq
      && same(this.prefix.seal, inputReference(seal)),
      "checkpoint import target prefix is not the row in force bound to the seal in force");
    requireProviderInput((change.kind === "identical") === (change.source_prefix_hash === change.target_prefix_hash),
      "checkpoint import transition kind differs from its prefix hashes");
    requireProviderInput(change.transformation === checkpointImportTransformationDigest({
      sourcePrefixHash: change.source_prefix_hash,
      targetPrefixHash: change.target_prefix_hash,
      sourceMessagesDigest: facts.sourceMessagesDigest,
      removedFrames: facts.removedFrameIndices,
      transformedDigest: facts.transformedDigest,
    }), "checkpoint import transformation identity differs");
    // The declared metadata is exactly the derived transform: source keys
    // preserved, current prefix/system/plugin overridden, provenance closed.
    requireProviderInput(same(body.metadata, checkpointImportStateMetadata({
      sourceMetadata: facts.state.metadata,
      targetPrefixHash: change.target_prefix_hash,
      targetSystemPrompt: this.prefix!.systemPrompt,
      targetPluginManifest: typeof opened!.payload.plugin_manifest_digest === "string"
        ? opened!.payload.plugin_manifest_digest : null,
      provenance: {
        source_prefix_hash: facts.prefixHash,
        removed_frames: facts.removedFrameIndices,
        source_digest: facts.sourceMessagesDigest,
        transformed_digest: facts.transformedDigest,
      },
    })), "checkpoint import metadata differs from its declared transform");
    this.awaitingImportState = undefined;
    this.lastImport = { seq: event.seq, bundle: String(bundleRef.blob), source, session: String(session) };
    this.importedSessions.add(String(session));
  }

  /** #227: the transcript's digest without the frames at `replaces`, from
   * the live frame's mark when that is the one frame (the suffix after it is
   * re-hashed, not the whole transcript); else from the start. */
  withoutFrames(messages: readonly unknown[], replaces: readonly number[]): TranscriptDigest {
    if (replaces.length === 0) return new TranscriptDigest([], this.digest.mark());
    const live = this.liveFrame;
    if (live && replaces.length === 1 && replaces[0] === live.index) {
      return new TranscriptDigest(messages.slice(live.index + 1), live.mark);
    }
    const dropped = new Set(replaces);
    return new TranscriptDigest(messages.filter((_, index) => !dropped.has(index)));
  }

  /** #227: the positions of the recorded frames a transcript carries. */
  frameIndexes(messages: readonly unknown[]): number[] {
    if (this.surfaceDigests.size === 0) return [];
    if (this.liveFrame === null) return [];
    if (this.liveFrame !== undefined) return [this.liveFrame.index];
    const out: number[] = [];
    messages.forEach((message, index) => {
      if (message === null || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return;
      const text = messageText((message as { content?: unknown }).content);
      if (text !== undefined && this.surfaceDigests.has(createHash("sha256").update(text).digest("hex"))) out.push(index);
    });
    return out;
  }

  private model(value: Record<string, unknown>): Record<string, unknown> {
    const key = canonicalJson(value);
    let found = this.models.get(key);
    if (!found) this.models.set(key, found = value);
    return found;
  }

  /** A body read back for a check after its row was folded. */
  private reread(digest: string, row: string): unknown {
    const found = this.source.read(digest, row);
    requireProviderInput(found !== ABSENT, "retained input body is unavailable");
    return found;
  }

  private payloadBody(facts: PayloadFacts): Record<string, unknown> {
    return record(record(this.reread(facts.body, "provider/payload")).payload);
  }

  private assistantBody(facts: ResponseFacts): AssistantMessage {
    return record(record(this.reread(facts.body, "provider/response")).assistant) as unknown as AssistantMessage;
  }

  /** The recorded request a reference names (seq is unique among rows). */
  request(ref: InputReference): RequestFacts | undefined {
    const found = this.requestsBySeq.get(ref.seq);
    return found && same(found.ref, ref) ? found : undefined;
  }

  private send(ref: unknown): SendFacts | undefined {
    const seq = ref !== null && typeof ref === "object" ? (ref as { seq?: unknown }).seq : undefined;
    const found = typeof seq === "number" ? this.sendsBySeq.get(seq) : undefined;
    return found && same(found.ref, ref) ? found : undefined;
  }

  /** The transcript state; the message arrays are never mutated in place (a
   * transcript change always builds a new array). */
  stateView(): ProviderState {
    const { state } = this;
    return { ref: state.ref, messages: state.messages,
      ...(state.pending ? { pending: state.pending } : {}),
      ...(state.metadata ? { metadata: state.metadata } : {}) };
  }

  /** The whole-log projection: a snapshot later folding cannot change. */
  snapshot(): ProviderInputProjection {
    const history = this.history!;
    return { state: this.stateView(), requests: [...history.requests], sends: [...history.sends],
      identities: [...history.identities] };
  }

  view(): LiveProviderInputs {
    return { state: this.stateView(), latestRequest: this.latestRequest, sendCount: this.sendCount,
      request: ref => this.request(ref) };
  }
}

/** Pure ledger projection. It never reads a cache, filesystem, clock or provider. */
export function projectProviderInputs(events: readonly EventRecord[], bodies: ReadonlyMap<string, unknown> = new Map()): ProviderInputProjection {
  const fold = new ProviderInputFold(projectSessionReplaySchemas(events), mapSource(bodies), true);
  fold.extend(events);
  // Message arrays are immutable snapshots built during this projection. Do
  // not duplicate every historical context again: retained wire bodies already
  // account for the growing-prefix cost of a long conversation.
  return fold.snapshot();
}

/** What the projections of one writer's log have done so far: rows folded and
 * retained bodies read back by the live projection, and the sampled durable
 * reloads with the bodies they re-checked. Diagnostic only — it is how a
 * test holds the per-request cost to the rows a request appends (D44), a
 * reload to one body at a time (D51) and to the session's unique stored
 * bytes (D53), not a count anything decides on. */
export interface ProviderInputFoldWork {
  rowsFolded: number;
  bodiesRead: number;
  /** The bodies' own bytes (a split body is reassembled from its parts). */
  bodyBytesRead: number;
  /** The most bodies the live projection held at once while folding a row. */
  bodiesAtOnce: number;
  reloads: number;
  /** Rows whose body a reload read and checked. */
  reloadBodiesRead: number;
  /** Bytes a reload read from disk: whole bodies, and each split body's
   * files not already checked by the same reload. */
  reloadBodyBytesRead: number;
  /** The most bodies any reload held at once while folding a row. */
  reloadBodiesAtOnce: number;
}
const foldWork = new WeakMap<EventLog, ProviderInputFoldWork>();
function foldWorkOf(log: EventLog): ProviderInputFoldWork {
  let work = foldWork.get(log);
  if (!work) foldWork.set(log, work = { rowsFolded: 0, bodiesRead: 0, bodyBytesRead: 0, bodiesAtOnce: 0,
    reloads: 0, reloadBodiesRead: 0, reloadBodyBytesRead: 0, reloadBodiesAtOnce: 0 });
  return work;
}
export function providerInputFoldWork(log: EventLog): Readonly<ProviderInputFoldWork> {
  return { ...foldWorkOf(log) };
}

/** The live projection of one writer's log: the fold over every row so far.
 * Rows are hash-chained, so a fold whose last row is still at the same
 * position with the same hash covers a prefix of the log that has not
 * changed. A row that changes what every earlier row is checked against (a
 * session/open: the replay schema is a whole-log property), or rows that no
 * longer extend the folded prefix, fold again from the first row, reading
 * every body from the store again, one at a time. A refusal discards the fold,
 * so the next call re-derives it and refuses the same way. */
const live = new WeakMap<EventLog, ProviderInputFold>();

function liveFold(log: EventLog): ProviderInputFold {
  const events = log.events;
  let fold = live.get(log);
  if (fold) {
    const extends_ = fold.consumed <= events.length
      && (fold.consumed === 0 || events[fold.consumed - 1]?.hash === fold.head);
    let reopened = false;
    if (extends_) {
      for (let index = fold.consumed; index < events.length; index += 1) {
        if (events[index]!.name === "session/open") { reopened = true; break; }
      }
    }
    if (!extends_ || reopened) fold = undefined;
  }
  const work = foldWorkOf(log);
  fold ??= new ProviderInputFold(projectSessionReplaySchemas(events), storeSource(log.path, (bytes, atOnce) => {
    work.bodiesRead += 1;
    work.bodyBytesRead += bytes;
    if (atOnce > work.bodiesAtOnce) work.bodiesAtOnce = atOnce;
  }, true), false);
  live.delete(log);
  const from = fold.consumed;
  fold.extend(events);
  work.rowsFolded += fold.consumed - from;
  live.set(log, fold);
  return fold;
}

/** The provider-input projection of a live log, incrementally maintained. */
export function projectLiveProviderInputs(log: EventLog): LiveProviderInputs {
  return liveFold(log).view();
}

/** The live projection and the digest of its current transcript
 * (inputDigest(projection.state.messages)), without re-serializing it. */
export function liveProviderInputs(log: EventLog): {
  projection: LiveProviderInputs; messagesDigest: string; messagesDigestWith: (message: unknown) => string;
} {
  const fold = liveFold(log);
  return { projection: fold.view(), messagesDigest: fold.messagesDigest,
    messagesDigestWith: (message) => fold.messagesDigestWith(message) };
}

/** The sampled durable reload (plugins/request-audit.ts, every twentieth
 * send): the log is re-read from disk and folded again from its first row,
 * and every stored byte its rows name is read and checked again, one body at
 * a time, never the session's bodies at once (D51). A whole body is checked
 * against the digest its row records. A split body (D53) is checked file by
 * file — its manifest, lists and parts each against its own digest, each
 * unique file once per reload — and folded as its skeleton; the put checked
 * that those files reassemble to the row's digest, so damage to any stored
 * byte is still caught at the next reload (D44), at the cost of the
 * session's unique bytes rather than of every body. */
export function reloadProviderInputs(log: EventLog): {
  head: InputReference; sendCount: number; request(ref: InputReference): ProviderRequestIdentity | undefined;
} {
  const cold = new EventLog(log.path, { readOnly: true });
  const work = foldWorkOf(log);
  work.reloads += 1;
  const fold = new ProviderInputFold(projectSessionReplaySchemas(cold.events), reloadSource(cold.path, (bytes, atOnce) => {
    work.reloadBodiesRead += 1;
    work.reloadBodyBytesRead += bytes;
    if (atOnce > work.reloadBodiesAtOnce) work.reloadBodiesAtOnce = atOnce;
  }), false);
  fold.extend(cold.events);
  return { head: inputReference(cold.events.at(-1)!), sendCount: fold.sendCount, request: ref => fold.request(ref) };
}

/** The transcript state the rows `events` (a prefix of `log`) record, folded
 * with each body read from the store when its row is folded; the bodies of the
 * log's later rows are read and dropped too, as reading every body first did —
 * never all of them at once (D51). */
export function recordedProviderState(log: Pick<EventLog, "path" | "events">, events: readonly EventRecord[], suppliedStore?: BlobStore): ProviderState {
  const fold = new ProviderInputFold(projectSessionReplaySchemas(events), storeSource(log.path, () => {}, false, suppliedStore), false);
  fold.extend(events);
  const store = suppliedStore ?? BlobStore.forSession(log.path);
  for (const event of log.events.slice(events.length)) {
    if (!PROVIDER_BODY_EVENTS.has(event.name)) continue;
    requireProviderInput(event.kind === "observe", "input producer is not an observation");
    requireProviderInput(typeof event.payload.blob === "string", "input body is missing");
    try { JSON.parse(store.get(event.payload.blob)); }
    catch { throw new ProviderInputError("retained input body acquisition failed"); }
  }
  return fold.stateView();
}

/** The last row named `name`: a backward scan, without copying the log. */
function lastRow(events: readonly EventRecord[], name: string): EventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.name === name) return events[index];
  }
  return undefined;
}

/** The durable transcript state. The caller owns what it receives: the
 * messages and metadata are copies, as they were when every call re-read the
 * bodies from disk. */
export function liveProviderState(log: EventLog): ProviderState {
  return structuredClone(liveFold(log).stateView());
}
export function replaceProviderMessages(log: EventLog, messages: readonly unknown[], reason: string,
  details: Record<string, unknown> = {}): void {
  const { projection: { state }, messagesDigest } = liveProviderInputs(log), next = inputData(messages) as unknown[];
  appendProviderBody(log, "provider/state", { ...details, version: 1, operation: "replace", prior: state.ref,
    before: messagesDigest, after: inputDigest(next), messages: next, reason }, () => {
    requireProviderInput(same(projectLiveProviderInputs(log).state.ref, state.ref), "stale transcript writer");
  });
}
export function appendProviderMessage(log: EventLog, message: unknown, pinned?: EventRecord): void {
  try {
  const live = liveProviderInputs(log), state = live.projection.state, value = record(inputData(message));
  let source: EventRecord | undefined;
  if (pinned) {
    // A caller may pin the exact surface row this message admits, instead of
    // racing whatever the last one happened to be; the row must be a real
    // recorded user/message surface of this log.
    requireProviderInput(pinned.name === "user/message" && pinned.kind === "surface"
      && log.events.some(row => row.seq === pinned.seq && row.hash === pinned.hash),
      "pinned message surface is not recorded");
    source = pinned;
  } else if (value.role === "user") {
    source = lastRow(log.events, "user/message");
  }
  const body = { version: 1, operation: "append", prior: state.ref, before: live.messagesDigest,
    after: live.messagesDigestWith(value), message: value, ...(source ? { source: inputReference(source) } : {}) };
  // Validate user admission before storing or publishing any derived row.
  if (value.role === "user") {
    const text = typeof value.content === "string" ? value.content
      : Array.isArray(value.content) ? value.content.map(item => record(item).text ?? "").join("\n") : undefined;
    requireProviderInput(source && text === source.payload.text, "unlogged user message");
  }
  appendProviderBody(log, "provider/state", body, () => {
    requireProviderInput(same(projectLiveProviderInputs(log).state.ref, state.ref), "stale transcript writer");
  });
  } catch (error) { throw observeProviderInputRefusal(log, error, "message"); }
}
/** #227 CG-04: append the recorded frame `frameId` to the transcript as a
 * host-context message (its surface row's exact bytes) and return it. */
export function appendProviderContext(log: EventLog, frameId: string): { message: unknown; state: InputReference; replaces: number[] } {
  try {
  const surface = recordedSurfaces(log).get(frameId);
  requireProviderInput(surface, "host context has no recorded surface");
  const fold = liveFold(log), live = liveProviderInputs(log), state = live.projection.state;
  const message = record(inputData(contextFrameMessage(log, surface)));
  // §130 F1: the new frame replaces every earlier one the transcript carries.
  const replaces = fold.frameIndexes(state.messages);
  const resumed = fold.withoutFrames(state.messages, replaces);
  resumed.push(message);
  const after = resumed.messages;
  const body = { version: 1, operation: "append_context", origin: "host_context", frame_id: frameId, replaces,
    prior: state.ref, before: live.messagesDigest, after, message, source: surface.ref };
  const row = appendProviderBody(log, "provider/state", body, () => {
    requireProviderInput(same(projectLiveProviderInputs(log).state.ref, state.ref), "stale transcript writer");
  });
  return { message, state: inputReference(row), replaces };
  } catch (error) { throw observeProviderInputRefusal(log, error, "context"); }
}

/** The newest admitted request's reference (the row admitProviderInput
 * appended), or undefined before any. */
export function latestProviderRequestRef(log: EventLog): InputReference | undefined {
  const row = lastRow(log.events, "provider/request");
  return row ? inputReference(row) : undefined;
}

/** #222 D2: the row a recorded model-input suffix is appended from. */
export const MODEL_INPUT_CONTRIBUTION_EVENT = "model_input/contribution";

/** #222 D2': append a host-recorded model-input suffix. The
 * `model_input/contribution` surface row (`payload`, whose `text` is exactly
 * the message's text) and the transcript append that names it are ONE
 * durable batch: both land or neither does, so a recorded suffix always is
 * in the transcript and a failed append leaves no row behind. Returns the
 * surface row. */
export function appendProviderContribution(log: EventLog, message: unknown, payload: Record<string, unknown>): EventRecord {
  try {
  const live = liveProviderInputs(log), state = live.projection.state, value = record(inputData(message));
  requireProviderInput(value.role === "user", "contribution is not a user-role suffix");
  const text = Array.isArray(value.content) ? value.content.map(item => record(item).text ?? "").join("\n") : value.content;
  requireProviderInput(typeof text === "string" && text === payload.text, "contribution differs from its recorded row");
  const at = log.lastSeq + 1;
  const body = { version: 1, operation: "append", prior: state.ref, before: live.messagesDigest,
    after: live.messagesDigestWith(value), message: value, source: { seq: at }, source_kind: MODEL_INPUT_CONTRIBUTION_EVENT };
  const row = appendProviderBody(log, "provider/state", body, (nextSeq) => {
    requireProviderInput(nextSeq === at, "contribution row moved");
    requireProviderInput(same(projectLiveProviderInputs(log).state.ref, state.ref), "stale transcript writer");
  }, { kind: "surface", name: MODEL_INPUT_CONTRIBUTION_EVENT, payload });
  const events = log.events;
  let lead: EventRecord | undefined;
  for (let index = events.length - 1; index >= 0 && events[index]!.seq >= row.seq - 1; index -= 1) {
    if (events[index]!.seq === row.seq - 1) lead = events[index];
  }
  requireProviderInput(lead?.name === MODEL_INPUT_CONTRIBUTION_EVENT && lead.seq === at, "contribution row is not recorded");
  return lead;
  } catch (error) { throw observeProviderInputRefusal(log, error, "contribution"); }
}
export function assertProviderMessages(log: EventLog, messages: readonly unknown[]): void {
  const { projection: { state }, messagesDigest } = liveProviderInputs(log);
  // The projection's own transcript array is never mutated in place, so the
  // very array it handed out (a request's context) needs no re-digest.
  requireProviderInput(state.ref && !state.pending
    && (messages === state.messages || inputDigest(messages) === messagesDigest), "messages differ from the durable transcript");
}
/** assertProviderMessages for messages whose digest the caller already holds. */
function assertProviderMessagesDigest(log: EventLog, digest: string): void {
  const { projection: { state }, messagesDigest } = liveProviderInputs(log);
  requireProviderInput(state.ref && !state.pending && digest === messagesDigest, "messages differ from the durable transcript");
}

const admissions = new WeakMap<object, { log: EventLog; request: ProviderInputRecord; context: unknown; model: unknown }>();
export function assertProviderSeal(log: EventLog, context: ProviderContext): void {
  const seal = lastRow(log.events, "prompt/seal");
  requireProviderInput(seal && seal.payload.prefix_hash === frozenPrefixHash({ systemPrompt: context.systemPrompt,
    toolSchemas: toolSchemaSnapshot(context.tools as { name: string; description: string }[]) }), "request differs from the active seal");
  assertSealEvent(seal);
}
export function admitProviderInput(log: EventLog, input: { route: string; role: string; model: unknown; context: unknown; options: object }): object {
  try {
  const context = providerContext(input.context), live = liveProviderInputs(log), state = live.projection.state;
  assertProviderRequestGuards(log, { ...input, context, model: providerModel(input.model), options: providerOptions(input.options) });
  assertProviderSeal(log, context);
  // `context` is this admission's own copy: its digest cannot change below.
  const messagesDigest = inputDigest(context.messages);
  requireProviderInput(state.ref && !state.pending && messagesDigest === live.messagesDigest,
    "messages differ from the durable transcript");
  // #227 G4/C12: a frame the request carries is sent only as its recorded
  // bytes, with its surface row and its blob present.
  assertContextFrameBindings(log, context.messages, (reason) => { throw new ProviderInputError(reason); });
  const priorPrefix = lastRow(log.events, "provider/prefix");
  // The live projection folded that row: the prefix in force is its material.
  const inForce = priorPrefix ? liveFold(log).prefixInForce : undefined;
  const priorBody = priorPrefix ? record(inForce && inForce.ref.seq === priorPrefix.seq
    && inForce.ref.hash === priorPrefix.hash ? inForce : undefined) : undefined;
  let prefix = priorPrefix;
  if (!priorBody || !same(priorBody.systemPrompt, context.systemPrompt) || !same(priorBody.tools, context.tools)) {
    const seal = lastRow(log.events, "prompt/seal");
    requireProviderInput(seal && (!priorPrefix || seal.seq > priorPrefix.seq), "prefix changed without a new seal");
    requireProviderInput(seal.payload.prefix_hash === frozenPrefixHash({ systemPrompt: context.systemPrompt,
      toolSchemas: toolSchemaSnapshot(context.tools as { name: string; description: string }[]) }), "prefix differs from seal");
    prefix = appendProviderBody(log, "provider/prefix", { version: 1, systemPrompt: context.systemPrompt,
      tools: context.tools, seal: seal ? inputReference(seal) : null });
  }
  const event = appendProviderBody(log, "provider/request", { version: 1, route: input.route, role: input.role,
    state: state.ref, prefix: inputReference(prefix!), model: providerModel(input.model), options: providerOptions(input.options),
    context_digest: inputDigest(context) }, () => assertProviderMessagesDigest(log, messagesDigest));
  const request = liveFold(log).latestRequest!;
  requireProviderInput(request.ref.seq === event.seq, "request was not reconstructed");
  admissions.set(input.options, { log, request, context: input.context, model: input.model });
  return input.options;
  } catch (error) { throw observeProviderInputRefusal(log, error, "request"); }
}
export function consumeProviderInput(log: EventLog, model: unknown, context: unknown, options: unknown): ProviderInputRecord {
  try {
  requireProviderInput(!log.isReadOnly, "read-only log cannot authorize input");
  log.assertCanRequestModel();
  const admitted = options && typeof options === "object" ? admissions.get(options) : undefined;
  requireProviderInput(admitted?.log === log && admitted.context === context && admitted.model === model, "live route has no host input admission");
  admissions.delete(options as object);
  assertProviderRequestGuards(log, admitted.request);
  requireProviderInput(inputDigest(providerContext(context)) === admitted.request.contextDigest
    && same(providerModel(model), admitted.request.model) && same(providerOptions(options), admitted.request.options),
    "input changed after host admission");
  assertProviderMessages(log, admitted.request.context.messages);
  assertProviderSeal(log, admitted.request.context);
  return admitted.request;
  } catch (error) { throw observeProviderInputRefusal(log, error, "request_audit"); }
}
