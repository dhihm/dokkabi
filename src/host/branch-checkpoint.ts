import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { BlobStore } from "./blob-store.ts";
import { canonicalJson } from "./canonical.ts";
import type { EventLog } from "./event-log.ts";
import {
  assertMaterializedExecutionImage,
  assertImageSources,
  captureExecutionImage,
  disposeMaterializedExecutionImage,
  materializeExecutionImage,
  type MaterializedExecutionImage,
  within,
} from "./execution-image.ts";
import { liveWritersOf } from "./live-writers.ts";
import { assertSealEvent, frozenPrefixHash, toolSchemaSnapshot } from "./prefix.ts";
import {
  recordedProviderState,
  type InputReference,
  type ProviderState,
} from "./provider-input.ts";
import { containsSecret, redactText, stripTerminalControls } from "./redact.ts";
import type { EventRecord } from "./schema.ts";
import type { SandboxPolicy } from "./sandbox.ts";
import { executionImageSchema, validateExecutionImage, type ExecutionImage } from "../work/evidence/execution-view.ts";

/** Branch checkpoints (docs/desktop-checkpoints-r7.md): bind one settled,
 * owned session cursor to a complete retained workspace image plus the exact
 * recorded provider input and prefix material, then verify and materialize
 * that checkpoint outside the parent. The checkpoint is a restoration
 * resource only: it never claims decision or branch execution, never writes
 * the parent workspace, and never rewrites one row of the parent log.
 * Everything a read returns is re-derived from retained storage and the
 * recorded source prefix; the live parent tree is never consulted. */

export const CHECKPOINT_SCHEMA = "branch-checkpoint-v1";
/** Closed safe identifier: the same shape the loader uses for plugin ids. */
export const CHECKPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SESSION_ID_BYTES = 256;
const MAX_SYSTEM_PROMPT_BYTES = 1024 * 1024;
const MAX_PREFIX_TOOLS = 4096;
const MAX_RESOURCE_ROOT_BYTES = 4096;
/** Explicit finite bounds; a session beyond them refuses instead of growing
 * without limit. The workspace image keeps its own existing limits. */
export const MAX_CHECKPOINT_MESSAGES = 200_000;
export const MAX_CHECKPOINT_MANIFEST_BYTES = 64 * 1024 * 1024;

export class BranchCheckpointError extends Error {
  constructor(readonly code: string, detail?: string) {
    // Refusal text is a code plus at most a sanitized bounded detail; a
    // detail that still looks like a secret is dropped entirely.
    const safe = detail === undefined ? "" : redactText(stripTerminalControls(detail));
    super(`branch-checkpoint: ${code}${safe && !containsSecret(safe) ? `: ${safe.slice(0, 240)}` : ""}`);
    this.name = "BranchCheckpointError";
  }
}

function fail(code: string, detail?: string): never {
  throw new BranchCheckpointError(code, detail);
}

const sha256Hex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const inputReferenceSchema = z.object({ seq: z.number().int().positive(), hash: z.string().regex(DIGEST_PATTERN) }).strict();
const prefixMaterialSchema = z.object({
  systemPrompt: z.string().min(0).max(MAX_SYSTEM_PROMPT_BYTES),
  tools: z.array(z.unknown()).max(MAX_PREFIX_TOOLS),
}).strict();

/** The host and replay share one closed receipt contract. */
const receiptIdentity = { schema: z.literal(CHECKPOINT_SCHEMA), id: z.string().regex(CHECKPOINT_ID_PATTERN), session: z.string().min(1).max(MAX_SESSION_ID_BYTES) };
const receiptDigest = z.string().regex(DIGEST_PATTERN);
const resourceReference = z.object({ root: z.string().startsWith("/").max(MAX_RESOURCE_ROOT_BYTES), owner: receiptDigest }).strict();
export const branchCheckpointReceiptSchemas = {
  "branch/checkpoint_intent": z.object({ ...receiptIdentity, source: inputReferenceSchema }).strict(),
  "branch/checkpoint_ready": z.object({ ...receiptIdentity, source: inputReferenceSchema, blob: receiptDigest, blob_bytes: z.number().int().nonnegative().max(MAX_CHECKPOINT_MANIFEST_BYTES), image: receiptDigest }).strict(),
  "branch/checkpoint_failed": z.object({ ...receiptIdentity, source: inputReferenceSchema, reason: z.string().min(1).max(240) }).strict(),
  "branch/restore_intent": z.object({ ...receiptIdentity, source: inputReferenceSchema, digest: receiptDigest }).strict(),
  "branch/restore_ready": z.object({ ...receiptIdentity, source: inputReferenceSchema, digest: receiptDigest, image: receiptDigest, resource: resourceReference }).strict(),
  "branch/restore_failed": z.object({ ...receiptIdentity, source: inputReferenceSchema, digest: receiptDigest, reason: z.string().min(1).max(240) }).strict(),
  "branch/restore_closed": z.object({ ...receiptIdentity, digest: receiptDigest, resource: resourceReference }).strict(),
};

/** Closed manifest version 1. `prefix.material` holds the authenticated
 * prefix bytes when the recorded prefix retained them; the seal hash alone
 * never claims complete restorable input (D-2026-10-02-20). */
export const checkpointManifestSchema = z.object({
  version: z.literal(1),
  schema: z.literal(CHECKPOINT_SCHEMA),
  id: z.string().regex(CHECKPOINT_ID_PATTERN),
  session: z.string().min(1).max(MAX_SESSION_ID_BYTES),
  source: z.object({
    seq: z.number().int().positive(),
    hash: z.string().regex(DIGEST_PATTERN),
    generation: z.number().int().nonnegative(),
  }).strict(),
  providerState: z.object({
    ref: inputReferenceSchema.nullable(),
    messages: z.array(z.unknown()).max(MAX_CHECKPOINT_MESSAGES),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  prefix: z.object({
    hash: z.string().regex(DIGEST_PATTERN),
    seal: inputReferenceSchema,
    material: prefixMaterialSchema.nullable(),
  }).strict(),
  pluginManifest: z.string().regex(DIGEST_PATTERN).nullable(),
  workspaceImage: z.object({
    digest: z.string().regex(DIGEST_PATTERN),
    manifest: executionImageSchema,
  }).strict(),
  coverage: z.object({
    /** Complete only when the retained prefix material matches the bound
     * seal; otherwise the messages are exact but the prefix bytes are not. */
    providerInput: z.enum(["complete", "messages_only"]),
    workspace_files: z.literal("retained"),
    git_metadata: z.enum(["retained", "absent"]),
    external_resources: z.literal("unavailable"),
    restart_scope: z.literal("isolated_materialization"),
    decision_execution: z.literal("unsupported"),
    branch_execution: z.literal("unsupported"),
  }).strict(),
}).strict();

export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;
export type PrefixMaterial = z.infer<typeof prefixMaterialSchema>;
export type BranchCheckpointReceipt = Readonly<{ id: string; digest: string; manifest: CheckpointManifest }>;
/** Host-only restoration handle: the verified manifest plus the isolated
 * resource this service allocated for it. */
export type BranchCheckpointRestore = Readonly<{ manifest: CheckpointManifest; image: MaterializedExecutionImage }>;

function parseCheckpointManifest(value: unknown): CheckpointManifest {
  const parsed = checkpointManifestSchema.safeParse(value);
  if (!parsed.success) fail("branch_checkpoint_manifest_invalid", parsed.error.issues[0]?.path.join("."));
  return parsed.data;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Recorded-prefix derivation. Everything below reads only the log, its blob
// store and the derived provider-input projection — never the live parent
// workspace tree, so historical checkpoints stay verifiable after any later
// parent change.
// ---------------------------------------------------------------------------

/** The rows of the source prefix, refusing a cursor the log cannot confirm. */
function sourcePrefix(log: Pick<EventLog, "path" | "events">, source: { seq: number; hash: string }): readonly EventRecord[] {
  const row = log.events[source.seq - 1];
  if (!row || row.seq !== source.seq || row.hash !== source.hash) {
    fail("branch_checkpoint_source_row_missing");
  }
  return log.events.slice(0, source.seq);
}

function lastNamedAtOrBefore(events: readonly EventRecord[], name: string, seq: number): EventRecord | undefined {
  for (let index = seq - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (row && row.name === name) return row;
  }
  return undefined;
}

/** The seal in force at the source: the last `prompt/seal` row of the
 * prefix, with a constitution reason and a digest-shaped prefix hash. */
function sealAt(events: readonly EventRecord[]): { row: EventRecord; prefixHash: string } {
  const last = events.at(-1);
  const seal = last ? lastNamedAtOrBefore(events, "prompt/seal", last.seq) : undefined;
  if (!seal) fail("branch_checkpoint_seal_missing");
  try {
    assertSealEvent(seal);
  } catch (error) {
    fail("branch_checkpoint_seal_invalid", error instanceof Error ? error.message : undefined);
  }
  const prefixHash = seal.payload.prefix_hash;
  if (typeof prefixHash !== "string" || !DIGEST_PATTERN.test(prefixHash)) {
    fail("branch_checkpoint_seal_invalid", "prefix_hash is not a digest");
  }
  return { row: seal, prefixHash };
}

/** The actual session-open plugin manifest digest at the source, or null. */
function pluginManifestAt(events: readonly EventRecord[]): string | null {
  const last = events.at(-1);
  const opened = last ? lastNamedAtOrBefore(events, "session/open", last.seq) : undefined;
  const digest = opened?.payload.plugin_manifest_digest;
  return typeof digest === "string" && DIGEST_PATTERN.test(digest) ? digest : null;
}

/** Graph revision facts from the source, never invented: the highest
 * `graph/apply` next value the prefix records, 0 when it records none. */
function graphGenerationAt(events: readonly EventRecord[]): number {
  let generation = 0;
  for (const row of events) {
    const next = row.name === "graph/apply" ? row.payload.next : undefined;
    if (typeof next === "number" && Number.isSafeInteger(next) && next > generation) generation = next;
  }
  return generation;
}

/** The durable transcript state at the source prefix. The provider-input
 * fold is the sole authority: any refusal it makes — an undeclared
 * transformation, a corrupted base or digest, pending compaction — fails
 * the checkpoint closed. There is no self-authenticated fallback. */
function providerStateAt(log: Pick<EventLog, "path" | "events">, events: readonly EventRecord[], suppliedStore?: BlobStore): {
  ref: InputReference | null;
  messages: unknown[];
  metadata?: Record<string, unknown>;
} {
  let folded: ProviderState;
  try {
    folded = recordedProviderState(log, events, suppliedStore);
  } catch (error) {
    fail("branch_checkpoint_provider_input_refused", error instanceof Error ? error.message : undefined);
  }
  if (folded.pending) fail("branch_checkpoint_compaction_pending");
  return { ref: folded.ref, messages: folded.messages, ...(folded.metadata !== undefined ? { metadata: folded.metadata } : {}) };
}

/** The authenticated prefix material at the source: the last retained
 * `provider/prefix` body, read from retained storage, valid only while its
 * own seal reference is the seal this checkpoint binds and its bytes hash to
 * that seal's frozen prefix hash (D-2026-10-02-20). Null when the prefix
 * retained no such material, or when it names an older seal than the last
 * one at the source — never filled from a runtime prompt or agent.json. */
function prefixMaterialAt(log: Pick<EventLog, "path" | "events">, events: readonly EventRecord[], sealRef: { seq: number; hash: string }, suppliedStore?: BlobStore): PrefixMaterial | null {
  const last = events.at(-1);
  const row = last ? lastNamedAtOrBefore(events, "provider/prefix", last.seq) : undefined;
  if (!row) return null;
  if (row.kind !== "observe" || typeof row.payload.blob !== "string"
    || row.payload.body_digest !== row.payload.blob || typeof row.payload.blob_bytes !== "number") {
    fail("branch_checkpoint_prefix_row_invalid");
  }
  let body: Record<string, unknown>;
  try {
    const text = (suppliedStore ?? BlobStore.forSession(log.path)).get(row.payload.blob);
    if (Buffer.byteLength(text) !== row.payload.blob_bytes) throw new Error("bytes differ");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch (error) {
    fail("branch_checkpoint_prefix_body_unavailable", error instanceof Error ? error.message : undefined);
  }
  if (body.version !== 1 || typeof body.systemPrompt !== "string" || !Array.isArray(body.tools)
    || body.systemPrompt.length > MAX_SYSTEM_PROMPT_BYTES || body.tools.length > MAX_PREFIX_TOOLS) {
    fail("branch_checkpoint_prefix_body_invalid");
  }
  const named = body.seal;
  const namedSeq = named !== null && typeof named === "object" ? (named as { seq?: unknown }).seq : undefined;
  const namedHash = named !== null && typeof named === "object" ? (named as { hash?: unknown }).hash : undefined;
  if (typeof namedSeq !== "number" || !Number.isSafeInteger(namedSeq) || namedSeq <= 0
    || typeof namedHash !== "string" || !DIGEST_PATTERN.test(namedHash)) {
    fail("branch_checkpoint_prefix_body_invalid", "seal reference is malformed");
  }
  // The material is in force only while it was sealed by the exact seal this
  // checkpoint binds; a prefix naming an older seal is stale, not wrong.
  if (namedSeq !== sealRef.seq || namedHash !== sealRef.hash) return null;
  if (namedSeq >= row.seq) fail("branch_checkpoint_prefix_body_invalid", "seal does not precede its prefix row");
  const sealRow = events[namedSeq - 1];
  if (!sealRow || sealRow.name !== "prompt/seal" || sealRow.hash !== namedHash) {
    fail("branch_checkpoint_prefix_body_invalid", "seal reference does not name the recorded seal");
  }
  const frozen = frozenPrefixHash({
    systemPrompt: body.systemPrompt,
    toolSchemas: toolSchemaSnapshot(body.tools as { name: string; description?: string }[]),
  });
  if (frozen !== sealRow.payload.prefix_hash) {
    fail("branch_checkpoint_prefix_hash_mismatch", "material does not hash to the sealed prefix");
  }
  return { systemPrompt: body.systemPrompt, tools: structuredClone(body.tools) };
}

interface SourceFacts {
  seal: { seq: number; hash: string; prefixHash: string };
  providerState: { ref: InputReference | null; messages: unknown[]; metadata?: Record<string, unknown> };
  prefixMaterial: PrefixMaterial | null;
  pluginManifest: string | null;
  generation: number;
}

/** Every fact the manifest binds, derived again from the recorded prefix on
 * every read. Deterministic in the prefix alone. */
function deriveSourceFacts(log: Pick<EventLog, "path" | "events">, source: { seq: number; hash: string }, sessionId: string, suppliedStore?: BlobStore): SourceFacts {
  const events = sourcePrefix(log, source);
  const opened = lastNamedAtOrBefore(events, "session/open", source.seq);
  const recordedSession = opened?.payload.session_id ?? opened?.payload.id;
  if (recordedSession !== sessionId) fail("branch_checkpoint_session_binding_mismatch");
  const seal = sealAt(events);
  return {
    seal: { seq: seal.row.seq, hash: seal.row.hash, prefixHash: seal.prefixHash },
    providerState: providerStateAt(log, events, suppliedStore),
    prefixMaterial: prefixMaterialAt(log, events, { seq: seal.row.seq, hash: seal.row.hash }, suppliedStore),
    pluginManifest: pluginManifestAt(events),
    generation: graphGenerationAt(events),
  };
}

/** Whether the retained image actually holds Git metadata: an explicit
 * Git common tree, or the workspace tree's own `.git` entries. A tree count
 * alone proves nothing — the common case is one tree that contains `.git`. */
function gitMetadataCoverage(image: ExecutionImage): "retained" | "absent" {
  if (image.trees.length > 1) return "retained";
  for (const entry of image.trees[0]!.entries) {
    if (entry.path === ".git" || entry.path.startsWith(".git/")) return "retained";
  }
  return "absent";
}

/** Authenticate every retained file body of the workspace image from the
 * blob store, without reading the (possibly mutated) parent tree. This is
 * the same verification materializeExecutionImage applies while writing. */
function verifyRetainedWorkspaceImage(log: Pick<EventLog, "path" | "events">, workspaceImage: { digest: string; manifest: unknown }, readySeq: number, suppliedStore?: BlobStore): void {
  const image = validateExecutionImage(workspaceImage.manifest);
  if (sha256Hex(canonicalJson(image)) !== workspaceImage.digest) fail("branch_checkpoint_image_digest_mismatch");
  const named = log.events.find(row => row.seq < readySeq && row.kind === "observe" && row.name === "execution_view/image" && row.payload.blob === workspaceImage.digest);
  if (!named) fail("branch_checkpoint_image_row_missing");
  const store = suppliedStore ?? BlobStore.forSession(log.path);
  try {
    const retained = store.get(workspaceImage.digest);
    if (retained !== canonicalJson(image) || Buffer.byteLength(retained) !== named.payload.blob_bytes) {
      fail("branch_checkpoint_image_manifest_mismatch");
    }
  } catch (error) {
    fail("branch_checkpoint_image_manifest_unavailable", error instanceof Error ? error.message : undefined);
  }
  for (const tree of image.trees) {
    for (const entry of tree.entries) {
      if (entry.kind !== "file") continue;
      let body: { encoding?: unknown; data?: unknown };
      try {
        const text = store.get(entry.blob);
        if (Buffer.byteLength(text) !== entry.blob_bytes) throw new Error("bytes differ");
        body = JSON.parse(text);
      } catch (error) {
        fail("branch_checkpoint_image_body_unavailable", `${entry.path}: ${error instanceof Error ? error.message : "unreadable"}`);
      }
      const data = typeof body.data === "string" ? body.data : "";
      const bytes = Buffer.from(data, "base64");
      if (body.encoding !== "base64" || bytes.toString("base64") !== data
        || bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
        fail("branch_checkpoint_image_body_mismatch", entry.path);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The stateless verified reader. Read-only by construction: it reads the
// log and the blob store and appends nothing, so replay preflight can call
// it without a sandbox policy, a live workspace or a service instance.
// ---------------------------------------------------------------------------

interface ReadyRow {
  row: EventRecord;
  source: { seq: number; hash: string };
  digest: string;
  image: string;
}

function readyRowFor(events: readonly EventRecord[], sessionId: string, id: string): ReadyRow | undefined {
  let found: ReadyRow | undefined;
  let intent: EventRecord | undefined;
  let failed = false;
  for (const row of events) {
    if (row.payload.id !== id) continue;
    if (row.name === "branch/checkpoint_intent") {
      if (intent || found || row.kind !== "observe" || !branchCheckpointReceiptSchemas["branch/checkpoint_intent"].safeParse(row.payload).success || row.payload.session !== sessionId) {
        fail("branch_checkpoint_intent_binding_invalid");
      }
      intent = row;
      continue;
    }
    if (row.name === "branch/checkpoint_failed") {
      if (!intent || found || failed || row.kind !== "observe" || !branchCheckpointReceiptSchemas["branch/checkpoint_failed"].safeParse(row.payload).success || row.payload.session !== sessionId || !sameJson(intent.payload.source, row.payload.source)) fail("branch_checkpoint_failed_binding_invalid");
      failed = true;
      continue;
    }
    if (row.name !== "branch/checkpoint_ready") continue;
    if (!intent || found || failed || !branchCheckpointReceiptSchemas["branch/checkpoint_ready"].safeParse(row.payload).success || !sameJson(intent.payload.source, row.payload.source)) {
      fail("branch_checkpoint_ready_intent_invalid");
    }
    const source = row.payload.source as { seq?: unknown; hash?: unknown } | undefined;
    const digest = row.payload.blob;
    const image = row.payload.image;
    if (row.kind !== "observe" || row.payload.schema !== CHECKPOINT_SCHEMA
      || row.payload.session !== sessionId
      || !source || typeof source !== "object"
      || typeof source.seq !== "number" || !Number.isSafeInteger(source.seq) || source.seq <= 0
      || typeof source.hash !== "string" || !DIGEST_PATTERN.test(source.hash)
      || typeof digest !== "string" || !DIGEST_PATTERN.test(digest)
      || typeof image !== "string" || !DIGEST_PATTERN.test(image)) {
      fail("branch_checkpoint_ready_row_invalid");
    }
    found = { row, source: { seq: source.seq, hash: source.hash }, digest, image };
  }
  return found;
}

/** Resolve one checkpoint completely from retained evidence: the ready row,
 * its manifest body, and every fact the manifest claims, re-derived from the
 * recorded source prefix. A missing or tampered body refuses; nothing is
 * ever returned as an empty success. */
export function readBranchCheckpoint(
  log: Pick<EventLog, "path" | "events">,
  sessionId: string,
  id: string,
  expectedDigest?: string,
  suppliedStore?: BlobStore,
): BranchCheckpointReceipt {
  if (typeof sessionId !== "string" || sessionId.length === 0 || Buffer.byteLength(sessionId) > MAX_SESSION_ID_BYTES) {
    fail("branch_checkpoint_session_invalid");
  }
  if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) fail("branch_checkpoint_id_invalid");
  if (expectedDigest !== undefined && (typeof expectedDigest !== "string" || !DIGEST_PATTERN.test(expectedDigest))) {
    fail("branch_checkpoint_digest_invalid");
  }
  const ready = readyRowFor(log.events, sessionId, id);
  if (!ready) {
    const intent = log.events.some(row => row.name === "branch/checkpoint_intent" && row.payload.id === id);
    // An intent without its ready receipt is an unknown outcome: a crash, a
    // refusal, or a tampered tail. It is never retried automatically.
    throw new BranchCheckpointError(intent ? "branch_checkpoint_intent_unresolved" : "branch_checkpoint_unknown");
  }
  if (expectedDigest !== undefined && expectedDigest !== ready.digest) fail("branch_checkpoint_digest_mismatch");

  let text: string;
  try {
    text = (suppliedStore ?? BlobStore.forSession(log.path)).get(ready.digest);
  } catch (error) {
    fail("branch_checkpoint_body_unavailable", error instanceof Error ? error.message : undefined);
  }
  if (typeof ready.row.payload.blob_bytes !== "number" || ready.row.payload.blob_bytes !== Buffer.byteLength(text)) {
    fail("branch_checkpoint_body_bytes_mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("branch_checkpoint_body_invalid");
  }
  const manifest = parseCheckpointManifest(parsed);
  if (canonicalJson(manifest) !== text) fail("branch_checkpoint_body_noncanonical");
  if (manifest.id !== id || manifest.session !== sessionId) fail("branch_checkpoint_binding_mismatch");
  if (manifest.source.seq !== ready.source.seq || manifest.source.hash !== ready.source.hash) {
    fail("branch_checkpoint_source_binding_mismatch");
  }
  if (manifest.workspaceImage.digest !== ready.image) fail("branch_checkpoint_image_binding_mismatch");

  // Recorded-prefix identity: every retained fact is re-derived from the
  // exact source rows and compared with what the manifest claims.
  const facts = deriveSourceFacts(log, manifest.source, sessionId, suppliedStore);
  if (manifest.source.generation !== facts.generation) fail("branch_checkpoint_generation_mismatch");
  if (manifest.prefix.seal.seq !== facts.seal.seq || manifest.prefix.seal.hash !== facts.seal.hash
    || manifest.prefix.hash !== facts.seal.prefixHash) {
    fail("branch_checkpoint_prefix_binding_mismatch");
  }
  if (!sameJson(manifest.prefix.material ?? null, facts.prefixMaterial ?? null)) {
    fail("branch_checkpoint_prefix_material_mismatch");
  }
  if (manifest.pluginManifest !== facts.pluginManifest) fail("branch_checkpoint_plugin_manifest_mismatch");
  if (!sameJson({ ref: manifest.providerState.ref, messages: manifest.providerState.messages },
    { ref: facts.providerState.ref, messages: facts.providerState.messages })
    || canonicalJson(manifest.providerState.metadata ?? null) !== canonicalJson(facts.providerState.metadata ?? null)) {
    fail("branch_checkpoint_provider_state_mismatch");
  }
  const image = validateExecutionImage(manifest.workspaceImage.manifest);
  const expectedCoverage: CheckpointManifest["coverage"] = {
    providerInput: facts.prefixMaterial === null ? "messages_only" : "complete",
    workspace_files: "retained",
    git_metadata: gitMetadataCoverage(image),
    external_resources: "unavailable",
    restart_scope: "isolated_materialization",
    decision_execution: "unsupported",
    branch_execution: "unsupported",
  };
  if (canonicalJson(manifest.coverage) !== canonicalJson(expectedCoverage)) fail("branch_checkpoint_coverage_mismatch");
  verifyRetainedWorkspaceImage(log, manifest.workspaceImage, ready.row.seq, suppliedStore);
  return { id, digest: ready.digest, manifest: deepFreeze(manifest) };
}

// ---------------------------------------------------------------------------
// The bound service: one owned session cursor, one workspace policy and one
// trusted settled observation. Capture and restore append durable host
// observations; read appends nothing.
// ---------------------------------------------------------------------------

export interface BranchCheckpointOptions {
  readonly log: EventLog;
  readonly sessionId: string;
  readonly policy: SandboxPolicy;
  /** Trusted current settled observation supplied by the owning host. */
  readonly isSettled: () => boolean;
}

function appendCheckpointFailed(log: EventLog, sessionId: string, id: string, source: { seq: number; hash: string }, error: unknown): void {
  const reason = error instanceof BranchCheckpointError ? error.code : "branch_checkpoint_capture_failed";
  try {
    log.appendBatchDurable(() => [{
      kind: "observe",
      name: "branch/checkpoint_failed",
      payload: { schema: CHECKPOINT_SCHEMA, id, session: sessionId, source, reason },
    }]);
  } catch {
    // The original failure stays fatal even when its receipt cannot land.
  }
}

/** The session store must live outside the captured trees; the same overlap
 * the execution image refuses, checked before any intent is appended. */
function assertStorageOutsideSource(log: EventLog, policy: SandboxPolicy): void {
  const roots = [policy.workspaceRoot,
    ...(policy.gitCommonDir && !within(policy.workspaceRoot, policy.gitCommonDir) ? [policy.gitCommonDir] : [])];
  const logTarget = existsSync(log.path) ? realpathSync(log.path) : join(realpathSync(dirname(log.path)), basename(log.path));
  if (roots.some(root => within(root, logTarget) || within(root, join(dirname(logTarget), "blobs")))) {
    fail("branch_checkpoint_storage_inside_source");
  }
  const gitLink = join(policy.workspaceRoot, ".git");
  if (existsSync(gitLink) && !lstatSync(gitLink).isDirectory() && !policy.gitCommonDir) {
    fail("branch_checkpoint_git_metadata_unavailable");
  }
}

export class BranchCheckpointService {
  private readonly log: EventLog;
  private readonly sessionId: string;
  private readonly policy: SandboxPolicy;
  private readonly isSettled: () => boolean;
  private revoked = false;
  private readonly owned = new Map<BranchCheckpointRestore, { id: string; digest: string }>();

  constructor(options: BranchCheckpointOptions) {
    if (!options || typeof options !== "object") fail("branch_checkpoint_configuration_invalid");
    if (!options.log || typeof options.log.path !== "string" || !Array.isArray(options.log.events)) {
      fail("branch_checkpoint_configuration_invalid", "log");
    }
    if (typeof options.sessionId !== "string" || options.sessionId.length === 0
      || Buffer.byteLength(options.sessionId) > MAX_SESSION_ID_BYTES) {
      fail("branch_checkpoint_configuration_invalid", "sessionId");
    }
    if (!options.policy || typeof options.policy.workspaceRoot !== "string") {
      fail("branch_checkpoint_configuration_invalid", "policy");
    }
    if (typeof options.isSettled !== "function") fail("branch_checkpoint_configuration_invalid", "isSettled");
    this.log = options.log;
    this.sessionId = options.sessionId;
    this.policy = options.policy;
    this.isSettled = options.isSettled;
  }

  /** Capture at an exact settled head. The durable intent precedes every
   * acquisition; readiness lands only after image verification and a real
   * settlement recheck; every refusal before the intent leaves the log and
   * the store untouched. */
  capture(request: { id: string; expected: { seq: number; hash: string } }): BranchCheckpointReceipt {
    if (!request || typeof request !== "object") fail("branch_checkpoint_request_invalid");
    const { id } = request;
    if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) fail("branch_checkpoint_id_invalid");
    const expected = request.expected;
    if (!expected || typeof expected !== "object" || typeof expected.seq !== "number"
      || !Number.isSafeInteger(expected.seq) || expected.seq <= 0
      || typeof expected.hash !== "string" || !DIGEST_PATTERN.test(expected.hash)) {
      fail("branch_checkpoint_expected_source_invalid");
    }
    this.assertNotRevoked();
    if (this.log.isReadOnly) fail("branch_checkpoint_read_only");

    // Idempotence and conflict first: a ready checkpoint answers from
    // retained evidence with zero appends, and any other expected source
    // for the same id is a conflict, never a recapture.
    const ready = readyRowFor(this.log.events, this.sessionId, id);
    if (ready) {
      if (ready.source.seq === expected.seq && ready.source.hash === expected.hash) {
        return readBranchCheckpoint(this.log, this.sessionId, id);
      }
      fail("branch_checkpoint_source_conflict");
    }
    if (this.log.events.some(row => row.name === "branch/checkpoint_intent" && row.payload.id === id)) {
      fail("branch_checkpoint_intent_unresolved");
    }

    this.assertSettledNow();
    if (this.log.lastSeq !== expected.seq || this.log.lastHash !== expected.hash) {
      fail("branch_checkpoint_stale_source");
    }
    assertStorageOutsideSource(this.log, this.policy);
    const facts = deriveSourceFacts(this.log, expected, this.sessionId);

    try {
      this.log.appendBatchDurable(() => {
        if (this.log.lastSeq !== expected.seq || this.log.lastHash !== expected.hash) {
          throw new Error("branch checkpoint source head moved before intent");
        }
        return [{
          kind: "observe" as const,
          name: "branch/checkpoint_intent",
          payload: { schema: CHECKPOINT_SCHEMA, id, session: this.sessionId, source: { seq: expected.seq, hash: expected.hash } },
        }];
      });
    } catch (error) {
      throw new BranchCheckpointError("branch_checkpoint_intent_refused", error instanceof Error ? error.message : undefined);
    }

    let admitted = false;
    try {
      const image = captureExecutionImage(this.log, this.policy);
      const tail = { seq: this.log.lastSeq, hash: this.log.lastHash };
      const manifest: CheckpointManifest = {
        version: 1,
        schema: CHECKPOINT_SCHEMA,
        id,
        session: this.sessionId,
        source: { seq: expected.seq, hash: expected.hash, generation: facts.generation },
        providerState: {
          ref: facts.providerState.ref,
          messages: structuredClone(facts.providerState.messages),
          ...(facts.providerState.metadata !== undefined ? { metadata: structuredClone(facts.providerState.metadata) } : {}),
        },
        prefix: {
          hash: facts.seal.prefixHash,
          seal: { seq: facts.seal.seq, hash: facts.seal.hash },
          material: facts.prefixMaterial === null ? null : structuredClone(facts.prefixMaterial),
        },
        pluginManifest: facts.pluginManifest,
        workspaceImage: { digest: image.digest, manifest: image.manifest },
        coverage: {
          providerInput: facts.prefixMaterial === null ? "messages_only" : "complete",
          workspace_files: "retained",
          git_metadata: gitMetadataCoverage(image.manifest),
          external_resources: "unavailable",
          restart_scope: "isolated_materialization",
          decision_execution: "unsupported",
          branch_execution: "unsupported",
        },
      };
      parseCheckpointManifest(manifest);
      verifyRetainedWorkspaceImage(this.log, manifest.workspaceImage, this.log.lastSeq + 1);
      const body = canonicalJson(manifest);
      if (Buffer.byteLength(body) > MAX_CHECKPOINT_MANIFEST_BYTES) fail("branch_checkpoint_manifest_limit");
      const digest = BlobStore.forSession(this.log.path).put(body);
      this.log.appendBatchDurable(() => {
        this.assertSettledNow();
        assertImageSources(image.manifest, BlobStore.forSession(this.log.path), image.manifest.trees.map(tree => tree.target));
        if (this.log.lastSeq !== tail.seq || this.log.lastHash !== tail.hash) {
          throw new Error("branch checkpoint log head moved before ready");
        }
        return [{
          kind: "observe" as const,
          name: "branch/checkpoint_ready",
          payload: {
            schema: CHECKPOINT_SCHEMA,
            id,
            session: this.sessionId,
            source: { seq: expected.seq, hash: expected.hash },
            blob: digest,
            blob_bytes: Buffer.byteLength(body),
            image: image.digest,
          },
        }];
      });
      admitted = true;
      return readBranchCheckpoint(this.log, this.sessionId, id);
    } catch (error) {
      if (!admitted) appendCheckpointFailed(this.log, this.sessionId, id, { seq: expected.seq, hash: expected.hash }, error);
      throw error instanceof BranchCheckpointError
        ? error
        : new BranchCheckpointError("branch_checkpoint_capture_failed", error instanceof Error ? error.message : undefined);
    }
  }

  /** Verified read: the stateless reader over this owned session. Read
   * never appends and works on a read-only handle. */
  read(id: string, digest?: string): BranchCheckpointReceipt {
    this.assertNotRevoked();
    return readBranchCheckpoint(this.log, this.sessionId, id, digest);
  }

  /** Materialize one checkpoint into a fresh isolated host-owned resource.
   * The durable restore intent precedes any allocation; readiness follows
   * the verified image; the parent workspace and its log prefix are never
   * written, only appended to with these host observations. */
  materialize(id: string, digest: string): BranchCheckpointRestore {
    this.assertNotRevoked();
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) fail("branch_checkpoint_digest_invalid");
    if (this.log.isReadOnly) fail("branch_checkpoint_read_only");
    const verified = readBranchCheckpoint(this.log, this.sessionId, id, digest);
    this.assertSettledNow();
    const source = { seq: verified.manifest.source.seq, hash: verified.manifest.source.hash };
    try {
      this.log.appendBatchDurable(() => [{
        kind: "observe" as const,
        name: "branch/restore_intent",
        payload: { schema: CHECKPOINT_SCHEMA, id, session: this.sessionId, digest, source },
      }]);
    } catch (error) {
      throw new BranchCheckpointError("branch_checkpoint_restore_intent_refused", error instanceof Error ? error.message : undefined);
    }
    let image: MaterializedExecutionImage | undefined;
    try {
      image = materializeExecutionImage(this.log, verified.manifest.workspaceImage.digest, verified.manifest.workspaceImage.manifest);
      this.assertSettledNow();
      assertMaterializedExecutionImage(image);
      const resource = { root: image.resource.root, owner: image.resource.owner };
      if (Buffer.byteLength(resource.root) > MAX_RESOURCE_ROOT_BYTES) fail("branch_checkpoint_resource_ref_invalid");
      this.log.appendBatchDurable(() => [{
        kind: "observe" as const,
        name: "branch/restore_ready",
        payload: {
          schema: CHECKPOINT_SCHEMA,
          id,
          session: this.sessionId,
          digest,
          source,
          image: verified.manifest.workspaceImage.digest,
          resource,
        },
      }]);
    } catch (error) {
      if (image) disposeMaterializedExecutionImage(image);
      const reason = error instanceof BranchCheckpointError ? error.code : "branch_checkpoint_restore_failed";
      try {
        this.log.appendBatchDurable(() => [{
          kind: "observe" as const,
          name: "branch/restore_failed",
          payload: { schema: CHECKPOINT_SCHEMA, id, session: this.sessionId, digest, source, reason },
        }]);
      } catch {
        // The original failure stays fatal even when its receipt cannot land.
      }
      throw error instanceof BranchCheckpointError
        ? error
        : new BranchCheckpointError("branch_checkpoint_restore_failed", error instanceof Error ? error.message : undefined);
    }
    const handle: BranchCheckpointRestore = Object.freeze({ manifest: verified.manifest, image });
    this.owned.set(handle, { id, digest });
    return handle;
  }

  /** Clean up exactly one restore this service owns, recording its closure. */
  disposeRestore(handle: BranchCheckpointRestore): void {
    const record = this.owned.get(handle);
    if (!record) throw new BranchCheckpointError("branch_checkpoint_restore_unknown");
    this.owned.delete(handle);
    disposeMaterializedExecutionImage(handle.image);
    this.log.appendBatchDurable(() => [{
      kind: "observe" as const,
      name: "branch/restore_closed",
      payload: {
        schema: CHECKPOINT_SCHEMA,
        id: record.id,
        session: this.sessionId,
        digest: record.digest,
        resource: { root: handle.image.resource.root, owner: handle.image.resource.owner },
      },
    }]);
  }

  /** Unload: no further capture, read or materialization; owned restores
   * are cleaned and closed. The stateless reader stays available to replay. */
  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    for (const [handle, record] of [...this.owned]) {
      this.owned.delete(handle);
      disposeMaterializedExecutionImage(handle.image);
      try {
        this.log.appendBatchDurable(() => [{
          kind: "observe" as const,
          name: "branch/restore_closed",
          payload: {
            schema: CHECKPOINT_SCHEMA,
            id: record.id,
            session: this.sessionId,
            digest: record.digest,
            resource: { root: handle.image.resource.root, owner: handle.image.resource.owner },
          },
        }]);
      } catch {
        // Teardown must not fail on a closing receipt.
      }
    }
  }

  private assertNotRevoked(): void {
    if (this.revoked) fail("branch_checkpoint_revoked");
  }

  /** Settlement is the trusted observation AND the live-writer registry:
   * an image of a tree something can still write is unknown, not settled. */
  private assertSettledNow(): void {
    if (!this.isSettled()) fail("branch_checkpoint_session_active");
    const writers = liveWritersOf(this.policy.workspaceRoot);
    if (writers.length > 0) fail("branch_checkpoint_live_writers", writers[0]);
  }
}
