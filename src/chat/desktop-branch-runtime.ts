import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BlobStore } from "../host/blob-store.ts";
import { canonicalJson } from "../host/canonical.ts";
import { EventLog } from "../host/event-log.ts";
import { resolvePluginManifest } from "../loader/manifest.ts";
import {
  currentSessionSchemaPayload,
  projectSessionReplaySchemas,
  type EventRecord,
} from "../host/schema.ts";
import { BranchCheckpointService, CHECKPOINT_ID_PATTERN } from "../host/branch-checkpoint.ts";
import {
  BranchDecisionError,
  BranchDecisionService,
  projectBranchDecisions,
  type DecisionSnapshot,
} from "../host/branch-decision.ts";
import {
  BranchWorkspaceService,
  activeBranchWorkspaceReady,
  BRANCH_WORKSPACE_ID_PATTERN,
  BranchWorkspaceError,
  type BranchWorkspaceModelPolicy,
} from "../host/branch-workspace.ts";
import {
  importCheckpointProviderInput,
  prepareCheckpointInputImport,
} from "../host/checkpoint-input-import.ts";
import { validateImportedCheckpointSource } from "../host/provider-input.ts";
import {
  importCheckpointLessons,
  sessionRetainedReader,
  validateBranchContextAuthority,
} from "../context-graph/branch-context.ts";
import { contextGoalStatementAt } from "../context-graph/projector.ts";
import type { ContextGraphService } from "../context-graph/service.ts";
import { openDesktopChatKernel, type DesktopChatKernel, type DesktopKernelBranchMaterial } from "./desktop-kernel.ts";
import { WorkbenchGateway } from "../dash/workbench.ts";
import type { WorkbenchGatewayConfig, WorkbenchKernelHandle } from "../dash/workbench.ts";

/** R8-05 native branch runtime binding (docs/desktop-runtime-r8.md).
 *
 * A `DesktopBranchRuntime` opens one real independent persistent child
 * conversation from a checkpoint-bound selected decision. It composes the
 * accepted R8-01..R8-04 authorities — the checkpoint input import, the owned
 * persistent workspace, the scoped ContextGraph lesson import and the single
 * durable application admission — around a NORMAL leased child
 * `DesktopChatKernel` boot. Nothing here introduces a branch-specific model
 * loop, copies the parent agent cache, interprets an option label as a task,
 * or submits a hidden turn: a prepared branch is a conversation, never a
 * verified model result.
 *
 * Durability order is fixed: a closed `branch/runtime_intent` lands in the
 * parent log under the existing EventLog cross-process lock BEFORE any child
 * log, workspace or boot exists — and the same locked catchup reserves the
 * governing decision, so two different commands can never concurrently
 * allocate child resources for one selected decision. Only a newly returned
 * admission grant may publish the child `branch/runtime_child_ready`
 * receipt and the parent `branch/runtime_ready` completion. A duplicate
 * identical start without a confirmed ready is unknown and never restarts
 * creation; a changed reuse of a recorded command refuses; a historical
 * admission is never a reusable grant. The single allowed read-only
 * reconciliation publishes the missing parent completion ONLY when an exact
 * already-durable child-ready row independently proves preparation from the
 * recorded admission — with no boot, allocation or Send repeated. */

export const BRANCH_RUNTIME_SCHEMA = "branch-runtime-v1";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_MAX = 256;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REASON_PATTERN = /^[a-z0-9_]{1,64}$/u;
const CHILD_ID_PATTERN = /^br-[a-z0-9]{24}$/u;
const MAX_PATH = 4096;

export class BranchRuntimeError extends Error {
  constructor(readonly code: string) {
    // A refusal is a code only: never a stack path, a secret or a runtime id.
    super(`branch-runtime: ${code}`);
    this.name = "BranchRuntimeError";
  }
}

function fail(code: string): never {
  throw new BranchRuntimeError(code);
}

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/** Recompute one appended event row's exact hash with the same recipe the
 * shared source-chain verifier (provider-input.ts `verifySourceEventChain`)
 * applies per row: sha256 over the canonical JSON of every field but
 * `hash`. Pure; no filesystem, no log. */
function recomputeEventHash(row: EventRecord): string {
  const { hash: _hash, ...unsigned } = row;
  return sha256Hex(canonicalJson(unsigned));
}

// ---------------------------------------------------------------------------
// Closed receipt contract, shared by the writer, the live fold and cold
// replay. The parent rows are `branch/runtime_intent`, an optional bounded
// `branch/runtime_refused`, and one `branch/runtime_ready`; the child log
// carries its own `branch/runtime_child_ready` receipt.
// ---------------------------------------------------------------------------

const digestField = z.string().regex(DIGEST_PATTERN);
const eventRefSchema = z.strictObject({ seq: z.number().int().positive(), hash: digestField });
const ownerSchema = z.strictObject({
  client_id: z.string().regex(CLIENT_ID_PATTERN),
  thread_id: z.string().regex(THREAD_ID_PATTERN),
});
const childBindingSchema = z.strictObject({
  client_id: z.string().regex(CLIENT_ID_PATTERN),
  thread_id: z.string().regex(THREAD_ID_PATTERN),
});

export const branchRuntimeReceiptSchemas = {
  /** The durable creation intent: appended under the existing lock BEFORE any
   * child log, workspace or boot acquisition. Binds the exact command
   * fingerprint, the governing selection, the checkpoint source and the
   * owning client/target thread. */
  "branch/runtime_intent": z.strictObject({
    schema: z.literal(BRANCH_RUNTIME_SCHEMA),
    session: z.string().min(1).max(SESSION_MAX),
    command_id: z.string().regex(COMMAND_ID_PATTERN),
    fingerprint: digestField,
    decision: z.strictObject({
      id: z.string().regex(CHECKPOINT_ID_PATTERN),
      revision: z.literal(1),
      ref: eventRefSchema,
      option: z.string().min(1).max(200),
      actor: z.enum(["human", "policy"]),
    }),
    source: z.strictObject({
      session: z.string().min(1).max(SESSION_MAX),
      checkpoint: z.string().regex(CHECKPOINT_ID_PATTERN),
      digest: digestField,
      head: eventRefSchema,
    }),
    owner: ownerSchema,
    child: z.strictObject({
      id: z.string().regex(CHILD_ID_PATTERN),
      session: z.string().regex(CHILD_ID_PATTERN),
      binding: childBindingSchema,
    }),
    created_at: z.number().int().nonnegative(),
  }),
  /** A bounded known refusal after the intent: informational only. It never
   * converts the reserved unknown into a retryable failure, never removes
   * evidence and never contradicts a later reconciliation. Only closed
   * prepublication refusal codes are ever recorded here. */
  "branch/runtime_refused": z.strictObject({
    schema: z.literal(BRANCH_RUNTIME_SCHEMA),
    session: z.string().min(1).max(SESSION_MAX),
    command_id: z.string().regex(COMMAND_ID_PATTERN),
    reason: z.string().regex(REASON_PATTERN),
  }),
  /** The completion: binds the preceding intent, the winning selection, the
   * single application admission, the source, the owner and the actual child
   * coordinates, and roots the exact retained child-ready row by digest. */
  "branch/runtime_ready": z.strictObject({
    schema: z.literal(BRANCH_RUNTIME_SCHEMA),
    session: z.string().min(1).max(SESSION_MAX),
    command_id: z.string().regex(COMMAND_ID_PATTERN),
    fingerprint: digestField,
    intent: eventRefSchema,
    selection: eventRefSchema,
    application: eventRefSchema,
    source: z.strictObject({
      checkpoint: z.string().regex(CHECKPOINT_ID_PATTERN),
      digest: digestField,
    }),
    owner: ownerSchema,
    child: z.strictObject({
      id: z.string().regex(CHILD_ID_PATTERN),
      session: z.string().regex(CHILD_ID_PATTERN),
      workspace: z.string().startsWith("/").max(MAX_PATH),
      resource: z.strictObject({ root: z.string().startsWith("/").max(MAX_PATH), owner: digestField }),
      binding: childBindingSchema,
      ready_row: eventRefSchema,
    }),
    blob: digestField,
    blob_bytes: z.number().int().positive(),
  }),
  /** The child-side receipt: appended to the CHILD log immediately after the
   * parent admission, chaining from the exact child head the admission
   * recorded. The exact row is retained in the parent blob store. */
  "branch/runtime_child_ready": z.strictObject({
    schema: z.literal(BRANCH_RUNTIME_SCHEMA),
    session: z.string().regex(CHILD_ID_PATTERN),
    parent: z.strictObject({
      session: z.string().min(1).max(SESSION_MAX),
      decision: z.string().regex(CHECKPOINT_ID_PATTERN),
      command_id: z.string().regex(COMMAND_ID_PATTERN),
      admission: eventRefSchema,
    }),
    child_prior_head: eventRefSchema,
    child: z.strictObject({
      id: z.string().regex(CHILD_ID_PATTERN),
      workspace: z.string().startsWith("/").max(MAX_PATH),
      resource: z.strictObject({ root: z.string().startsWith("/").max(MAX_PATH), owner: digestField }),
    }),
    binding: childBindingSchema,
  }),
} as const;

export type BranchRuntimeReceiptName = keyof typeof branchRuntimeReceiptSchemas;
type IntentPayload = z.infer<typeof branchRuntimeReceiptSchemas["branch/runtime_intent"]>;
type ReadyPayload = z.infer<typeof branchRuntimeReceiptSchemas["branch/runtime_ready"]>;
type ChildReadyPayload = z.infer<typeof branchRuntimeReceiptSchemas["branch/runtime_child_ready"]>;

/** Where a pure runtime fold reads a retained evidence body: the exact text
 * of the blob, or undefined when the reader's source does not hold it (the
 * projection then refuses the row, fail-closed). */
export type RetainedRuntimeBodyReader = (digest: string) => string | undefined;

// ---------------------------------------------------------------------------
// Fingerprints: recomputed by the fold from the recorded row alone.
// ---------------------------------------------------------------------------

function intentFingerprintOf(value: {
  decision_id: string; command_id: string;
  source: { checkpoint: string; digest: string };
  owner: { client_id: string; thread_id: string };
  child: { id: string; session: string; binding: { client_id: string; thread_id: string } };
}): string {
  return sha256Hex(canonicalJson({
    schema: BRANCH_RUNTIME_SCHEMA,
    decision_id: value.decision_id,
    command_id: value.command_id,
    source: { checkpoint: value.source.checkpoint, digest: value.source.digest },
    owner: { client_id: value.owner.client_id, thread_id: value.owner.thread_id },
    child: { id: value.child.id, session: value.child.session, binding: { ...value.child.binding } },
  }));
}

// ---------------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------------

function governingSessionOf(events: readonly EventRecord[]): string | undefined {
  let session: string | undefined;
  for (const row of events) {
    if (row.name !== "session/open") continue;
    const id = row.payload.session_id ?? row.payload.id;
    if (typeof id === "string") session = id;
  }
  return session;
}

interface RuntimeEntry {
  readonly commandId: string;
  readonly intentRow: EventRecord;
  readonly intent: IntentPayload;
  refusedReason?: string;
  readyRow?: EventRecord;
  ready?: ReadyPayload;
}

export interface BranchRuntimeReference {
  seq: number;
  name: BranchRuntimeReceiptName;
  payloadDigest: string;
}

export interface BranchChildDescriptor {
  readonly id: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly parent: { readonly clientId: string; readonly threadId: string };
  readonly binding: { readonly clientId: string; readonly threadId: string };
}

export interface BranchRuntimeStartView {
  readonly commandId: string;
  readonly state: "unknown" | "ready";
  readonly decisionId: string;
  readonly owner: { readonly clientId: string; readonly threadId: string };
  /** The durable child session this start claimed — present for a reserved
   * intent even before any ready completion exists. */
  readonly childSession: string;
  readonly child?: BranchChildDescriptor;
  readonly readySeq?: number;
}

export interface BranchRuntimeProjection {
  readonly starts: ReadonlyMap<string, BranchRuntimeStartView>;
  readonly children: ReadonlyMap<string, { readonly commandId: string; descriptor: BranchChildDescriptor }>;
  readonly references: readonly BranchRuntimeReference[];
}

interface RuntimeFold {
  readonly byCommand: ReadonlyMap<string, RuntimeEntry>;
  readonly byDecision: ReadonlyMap<string, RuntimeEntry>;
  readonly references: readonly BranchRuntimeReference[];
}

function parseRuntimeRow(name: BranchRuntimeReceiptName, payload: unknown): unknown {
  const parsed = branchRuntimeReceiptSchemas[name].safeParse(payload);
  if (!parsed.success) fail("branch_runtime_receipt_binding");
  return parsed.data;
}

/** Writer self-check: a payload the closed receipt schema refuses is never
 * appended — the exact snake_case wire representation is validated at every
 * write/reconciliation boundary, and historical wrong-shape receipts are
 * never accepted. */
function assertClosedReceipt(name: BranchRuntimeReceiptName, payload: unknown): void {
  parseRuntimeRow(name, payload);
}

/** The recorded checkpoint source of a decision, read from its immutable
 * open row — the snapshot itself deliberately carries no checkpoint
 * coordinates. */
function decisionSourceOf(events: readonly EventRecord[], decisionId: string): { checkpointId: string; checkpointDigest: string } {
  for (const row of events) {
    if (row.name !== "decision/open" || row.payload.id !== decisionId) continue;
    const checkpoint = row.payload.checkpoint as { id?: unknown; digest?: unknown } | undefined;
    if (checkpoint !== null && typeof checkpoint === "object"
      && typeof checkpoint.id === "string" && typeof checkpoint.digest === "string") {
      return { checkpointId: checkpoint.id, checkpointDigest: checkpoint.digest };
    }
  }
  fail("branch_runtime_decision_invalid");
}

function foldBranchRuntime(events: readonly EventRecord[], read?: RetainedRuntimeBodyReader): RuntimeFold {
  const featureStart = projectSessionReplaySchemas(events).featureStart.get(BRANCH_RUNTIME_SCHEMA);
  const byCommand = new Map<string, RuntimeEntry>();
  const byDecision = new Map<string, RuntimeEntry>();
  const references: BranchRuntimeReference[] = [];
  const commands = new Set<string>();
  let governing: string | undefined;
  let decisionsProjected: ReturnType<typeof projectBranchDecisions> | undefined;
  for (const row of events) {
    if (row.name === "session/open") {
      const id = row.payload.session_id ?? row.payload.id;
      if (typeof id === "string") governing = id;
    }
    if (!row.name.startsWith("branch/runtime_")) continue;
    if (!Object.hasOwn(branchRuntimeReceiptSchemas, row.name)) fail("branch_runtime_receipt_unknown");
    if (row.kind !== "observe" || featureStart === undefined || row.seq <= featureStart) {
      fail("branch_runtime_feature_generation");
    }
    const name = row.name as BranchRuntimeReceiptName;
    if (governing === undefined || row.payload.session !== governing) fail("branch_runtime_session_binding");
    // The runtime rows share the FULL decision fold's retained authority:
    // the source bundles and admission evidence are verified by the same
    // projection decisions/preflight/replay use, never by a weaker local
    // shape check.
    decisionsProjected ??= projectBranchDecisions(events, read);
    if (name === "branch/runtime_intent") {
      if (typeof row.payload.command_id !== "string") fail("branch_runtime_receipt_binding");
      if (commands.has(row.payload.command_id)) fail("branch_runtime_command_reuse");
      const payload = parseRuntimeRow(name, row.payload) as IntentPayload;
      const fingerprint = intentFingerprintOf({
        decision_id: payload.decision.id, command_id: payload.command_id,
        source: payload.source, owner: payload.owner, child: payload.child,
      });
      if (fingerprint !== payload.fingerprint) fail("branch_runtime_fingerprint");
      // The checkpoint source is THIS session's recorded ready row, and it
      // must already exist (past-prefix causality, never a future row).
      const sourceReady = events.filter(candidate => candidate.name === "branch/checkpoint_ready"
        && candidate.payload.id === payload.source.checkpoint && candidate.payload.blob === payload.source.digest
        && candidate.payload.session === payload.source.session);
      if (sourceReady.length === 0 || !sourceReady.some(candidate => candidate.seq < row.seq)) {
        fail("branch_runtime_source_binding");
      }
      if (payload.source.session !== payload.session) fail("branch_runtime_source_binding");
      // The decision's own checkpoint coordinates must equal the runtime
      // source, and the source head must bind EXACTLY to the authenticated
      // checkpoint bundle the decision open retained — a rehashed valid
      // prefix with a wrong source head is not this start's authority.
      const openRow = events.find(candidate => candidate.name === "decision/open"
        && candidate.payload.id === payload.decision.id);
      const openCheckpoint = openRow?.payload.checkpoint as { id?: unknown; digest?: unknown } | undefined;
      if (openRow === undefined || openCheckpoint?.id !== payload.source.checkpoint
        || openCheckpoint?.digest !== payload.source.digest) {
        fail("branch_runtime_source_binding");
      }
      if (read !== undefined) {
        const bundleText = read(openRow.payload.source_blob as string);
        if (bundleText === undefined) fail("branch_runtime_source_unavailable");
        let bundleFacts: ReturnType<typeof validateImportedCheckpointSource>;
        try {
          bundleFacts = validateImportedCheckpointSource(JSON.parse(bundleText));
        } catch {
          fail("branch_runtime_source_refused");
        }
        if (bundleFacts.checkpointId !== payload.source.checkpoint
          || bundleFacts.checkpointDigest !== payload.source.digest
          || bundleFacts.sourceSession !== payload.source.session
          || bundleFacts.head.seq !== payload.source.head.seq
          || bundleFacts.head.hash !== payload.source.head.hash) {
          fail("branch_runtime_source_head_binding");
        }
      }
      // The governing selection must be the decision fold's exact recorded
      // winner — same ref, option and actor — and must precede this intent.
      const decision = decisionsProjected.decisions.get(payload.decision.id);
      const selectedRow = events[payload.decision.ref.seq - 1];
      if (decision === undefined || decision.selected === null
        || !sameJson(decision.selected.ref, payload.decision.ref)
        || decision.selected.option !== payload.decision.option
        || decision.selected.actor !== payload.decision.actor) {
        fail("branch_runtime_selection_binding");
      }
      if (selectedRow === undefined || selectedRow.seq !== payload.decision.ref.seq
        || selectedRow.hash !== payload.decision.ref.hash || selectedRow.name !== "decision/response"
        || selectedRow.payload.disposition !== "selected" || selectedRow.payload.id !== payload.decision.id
        || selectedRow.payload.option !== payload.decision.option || selectedRow.payload.actor !== payload.decision.actor
        || selectedRow.seq >= row.seq) {
        fail("branch_runtime_selection_binding");
      }
      if (byDecision.has(payload.decision.id)) fail("branch_runtime_decision_reserved");
      const entry: RuntimeEntry = { commandId: payload.command_id, intentRow: row, intent: payload };
      byCommand.set(payload.command_id, entry);
      byDecision.set(payload.decision.id, entry);
      commands.add(payload.command_id);
    } else if (name === "branch/runtime_refused") {
      if (typeof row.payload.command_id !== "string") fail("branch_runtime_receipt_binding");
      const payload = parseRuntimeRow(name, row.payload) as { command_id: string; reason: string };
      const entry = byCommand.get(payload.command_id);
      if (entry === undefined || entry.ready !== undefined || entry.refusedReason !== undefined) {
        fail("branch_runtime_refused_binding");
      }
      entry.refusedReason = payload.reason;
    } else if (name === "branch/runtime_ready") {
      if (typeof row.payload.command_id !== "string") fail("branch_runtime_receipt_binding");
      const payload = parseRuntimeRow(name, row.payload) as ReadyPayload;
      const entry = byCommand.get(payload.command_id);
      if (entry === undefined) fail("branch_runtime_ready_orphan");
      const fingerprint = intentFingerprintOf({
        decision_id: entry.intent.decision.id, command_id: payload.command_id,
        source: entry.intent.source, owner: entry.intent.owner, child: entry.intent.child,
      });
      if (fingerprint !== payload.fingerprint || fingerprint !== entry.intent.fingerprint) {
        fail("branch_runtime_fingerprint");
      }
      if (entry.ready !== undefined) fail("branch_runtime_second_ready");
      if (payload.intent.seq !== entry.intentRow.seq || payload.intent.hash !== entry.intentRow.hash
        || payload.intent.seq >= row.seq) {
        fail("branch_runtime_intent_binding");
      }
      if (!sameJson(payload.selection, entry.intent.decision.ref)) fail("branch_runtime_selection_binding");
      if (payload.source.checkpoint !== entry.intent.source.checkpoint || payload.source.digest !== entry.intent.source.digest) {
        fail("branch_runtime_source_binding");
      }
      if (payload.owner.client_id !== entry.intent.owner.client_id || payload.owner.thread_id !== entry.intent.owner.thread_id
        || payload.child.id !== entry.intent.child.id || payload.child.session !== entry.intent.child.session
        || !sameJson(payload.child.binding, entry.intent.child.binding)) {
        fail("branch_runtime_child_binding");
      }
      // The application must be this log's recorded admission row, binding
      // the same decision, the SAME start command and the FULL child
      // coordinates — session, workspace id, workspace path and resource
      // root/owner — the intent named, and must lie between the intent and
      // this completion (never a future row). A ready row whose workspace or
      // resource was rehashed together with its retained evidence still
      // refuses: the admission, not the ready row, is the authority.
      const applicationRow = events[payload.application.seq - 1];
      const applicationChild = applicationRow?.payload.child as
        | {
          session?: unknown; workspace_id?: unknown; workspace?: unknown;
          resource?: { root?: unknown; owner?: unknown };
          head?: { seq: number; hash: string };
        }
        | undefined;
      if (applicationRow === undefined || applicationRow.seq !== payload.application.seq
        || applicationRow.hash !== payload.application.hash || applicationRow.name !== "decision/application_intent"
        || applicationRow.payload.id !== entry.intent.decision.id
        || applicationRow.payload.command_id !== payload.command_id
        || applicationChild?.session !== payload.child.session
        || applicationChild?.workspace_id !== payload.child.id
        || applicationChild?.workspace !== payload.child.workspace
        || applicationChild?.resource?.root !== payload.child.resource.root
        || applicationChild?.resource?.owner !== payload.child.resource.owner
        || applicationChild?.head === undefined
        || applicationRow.seq <= entry.intentRow.seq || applicationRow.seq >= row.seq) {
        fail("branch_runtime_application_binding");
      }
      // The retained exact child-ready row is required and verified: digest,
      // bytes, its own recomputed event hash, and hash-chained immediately
      // from the admission's recorded child head.
      if (read === undefined) fail("branch_runtime_retained_reader_required");
      const text = read(payload.blob);
      if (text === undefined) fail("branch_runtime_readiness_unavailable");
      if (sha256Hex(text) !== payload.blob) fail("branch_runtime_readiness_digest");
      if (Buffer.byteLength(text) !== payload.blob_bytes) fail("branch_runtime_readiness_bytes");
      let retained: unknown;
      try {
        retained = JSON.parse(text);
      } catch {
        fail("branch_runtime_readiness_invalid");
      }
      verifyRetainedChildReadyRow(retained, {
        parentSession: entry.intent.session,
        applicationChildHead: applicationChild!.head!,
        admission: { seq: payload.application.seq, hash: payload.application.hash },
        decisionId: entry.intent.decision.id,
        commandId: payload.command_id,
        child: payload.child,
      });
      entry.readyRow = row;
      entry.ready = payload;
    } else {
      // branch/runtime_child_ready: valid only inside the child log it
      // names (the session binding above already refuses a foreign row); it
      // chains from the exact prior child head recorded in the SAME log.
      const payload = parseRuntimeRow(name, row.payload) as ChildReadyPayload;
      const prior = events[payload.child_prior_head.seq - 1];
      if (prior === undefined || prior.seq !== payload.child_prior_head.seq || prior.hash !== payload.child_prior_head.hash) {
        fail("branch_runtime_child_head_binding");
      }
      if (row.seq !== payload.child_prior_head.seq + 1 || row.prev_hash !== payload.child_prior_head.hash) {
        fail("branch_runtime_child_head_binding");
      }
    }
    references.push({ seq: row.seq, name, payloadDigest: sha256Hex(canonicalJson(row.payload)) });
  }
  return { byCommand, byDecision, references };
}

/** Cold-verify a retained exact child-ready row against the parent rows that
 * root it: it must be the appended row itself (its hash recomputed with the
 * shared event recipe), hash-chained immediately from the admission's
 * recorded child head, and every parent/child coordinate — including the
 * governing parent session and the child session — must equal what the
 * runtime_ready completion recorded. */
export function verifyRetainedChildReadyRow(value: unknown, binding: {
  parentSession: string;
  applicationChildHead: { seq: number; hash: string };
  admission: { seq: number; hash: string };
  decisionId: string;
  commandId: string;
  child: {
    session: string;
    id: string;
    workspace: string;
    resource: { root: string; owner: string };
    binding: { client_id: string; thread_id: string };
    ready_row: { seq: number; hash: string };
  };
}): void {
  const row = value as Partial<EventRecord> | null;
  if (!row || typeof row !== "object") fail("branch_runtime_readiness_invalid");
  if (row.name !== "branch/runtime_child_ready" || row.kind !== "observe"
    || typeof row.seq !== "number" || typeof row.hash !== "string" || !DIGEST_PATTERN.test(row.hash)
    || typeof row.prev_hash !== "string" || !DIGEST_PATTERN.test(row.prev_hash)
    || typeof row.ts !== "string" || typeof row.payload !== "object" || row.payload === null) {
    fail("branch_runtime_readiness_invalid");
  }
  const exact = row as unknown as EventRecord;
  if (recomputeEventHash(exact) !== exact.hash) fail("branch_runtime_readiness_hash");
  if (exact.seq !== binding.applicationChildHead.seq + 1 || exact.prev_hash !== binding.applicationChildHead.hash) {
    fail("branch_runtime_child_head_binding");
  }
  if (exact.seq !== binding.child.ready_row.seq || exact.hash !== binding.child.ready_row.hash) {
    fail("branch_runtime_child_row_binding");
  }
  const payload = branchRuntimeReceiptSchemas["branch/runtime_child_ready"].safeParse(exact.payload);
  if (!payload.success) fail("branch_runtime_readiness_invalid");
  const parsed = payload.data;
  if (parsed.parent.session !== binding.parentSession || parsed.session !== binding.child.session) {
    fail("branch_runtime_session_binding");
  }
  if (parsed.parent.decision !== binding.decisionId || parsed.parent.command_id !== binding.commandId
    || parsed.parent.admission.seq !== binding.admission.seq || parsed.parent.admission.hash !== binding.admission.hash) {
    fail("branch_runtime_admission_binding");
  }
  if (parsed.child.id !== binding.child.id || parsed.child.workspace !== binding.child.workspace
    || parsed.child.resource.root !== binding.child.resource.root
    || parsed.child.resource.owner !== binding.child.resource.owner
    || !sameJson(parsed.binding, binding.child.binding)
    || !sameJson(parsed.child_prior_head, binding.applicationChildHead)) {
    fail("branch_runtime_child_binding");
  }
}

function descriptorOf(intent: IntentPayload, ready: ReadyPayload): BranchChildDescriptor {
  return Object.freeze({
    id: ready.child.id,
    sessionId: ready.child.session,
    workspacePath: ready.child.workspace,
    parent: Object.freeze({ clientId: intent.owner.client_id, threadId: intent.owner.thread_id }),
    binding: Object.freeze({
      clientId: ready.child.binding.client_id,
      threadId: ready.child.binding.thread_id,
    }),
  });
}

/** The pure runtime projection: fold the rows and verify every retained
 * authority they root. Write-free; never boots, allocates or dispatches. A
 * log that carries runtime rows refuses without a retained reader. */
export function projectBranchRuntime(events: readonly EventRecord[], retained?: RetainedRuntimeBodyReader): BranchRuntimeProjection {
  const fold = foldBranchRuntime(events, retained);
  const starts = new Map<string, BranchRuntimeStartView>();
  const children = new Map<string, { commandId: string; descriptor: BranchChildDescriptor }>();
  for (const entry of fold.byCommand.values()) {
    const descriptor = entry.ready === undefined ? undefined : descriptorOf(entry.intent, entry.ready);
    starts.set(entry.commandId, Object.freeze({
      commandId: entry.commandId,
      state: entry.ready === undefined ? "unknown" : "ready",
      decisionId: entry.intent.decision.id,
      owner: Object.freeze({
        clientId: entry.intent.owner.client_id,
        threadId: entry.intent.owner.thread_id,
      }),
      childSession: entry.ready === undefined ? entry.intent.child.session : entry.ready.child.session,
      ...(descriptor ? { child: descriptor, readySeq: entry.readyRow!.seq } : {}),
    }));
    if (descriptor !== undefined && !children.has(descriptor.id)) {
      children.set(descriptor.id, Object.freeze({ commandId: entry.commandId, descriptor }));
    }
  }
  return { starts, children, references: fold.references };
}

/** Ordered replay references use the same complete retained authority. */
export function projectBranchRuntimeReferences(events: readonly EventRecord[], retained?: RetainedRuntimeBodyReader): BranchRuntimeReference[] {
  return [...projectBranchRuntime(events, retained).references];
}

/** Replay preflight: the full retained-evidence verification over the
 * session's own blob store. Read-only; works on a cold preserved log. */
export function validateRecordedBranchRuntime(log: { readonly path: string; readonly events: readonly EventRecord[] }, suppliedStore?: BlobStore): void {
  if (!log.events.some(row => row.name.startsWith("branch/runtime_"))) return;
  const store = suppliedStore ?? BlobStore.forSession(log.path);
  projectBranchRuntime(log.events, digest => (store.has(digest) ? store.get(digest) : undefined));
}

// ---------------------------------------------------------------------------
// The runtime.
// ---------------------------------------------------------------------------

/** The actual current parent model selection, read through the live llm
 * facade (custom plugin routes included). Host authority only: supplied by
 * the trusted plugin boundary, never wire input, never a static catalog. */
export interface DesktopModelSelection {
  readonly route: string;
  readonly provider: string;
  readonly model: string;
}

export interface DesktopBranchRuntimeOptions {
  /** The parent session log and id this runtime owns. */
  readonly log: EventLog;
  readonly sessionId: string;
  readonly checkpoints: BranchCheckpointService;
  readonly decisions: BranchDecisionService;
  /** Trusted host coordinates (never wire input): the sessions home, the
   * repository root and the current plugin manifest the child boots with. */
  readonly home: string;
  readonly repoRoot: string;
  readonly manifestPath: string;
  /** Operator-owned branch workspace storage root. Allocation happens only
   * after a durable intent; discovery/reads never create it. */
  readonly storageRoot: string;
  /** The current sandbox runtime executable the workspace policy binds. */
  readonly runtimeExecutable: string;
  /** Actual current parent route/provider/model getter over the live llm
   * facade. The selection is fixed at child creation and compared on every
   * later boot/reconnect/dispatch — a mismatch refuses by name. */
  readonly parentModelSelection: () => DesktopModelSelection;
  /** Production clock; injectable for host tests only. */
  readonly now?: () => number;
}

export interface BranchStartRequest {
  readonly commandId: string;
  readonly decisionId: string;
  readonly expectedRevision: number;
  readonly owner: { readonly clientId: string; readonly threadId: string };
  readonly childThreadId: string;
}

export type BranchStartOutcome =
  | { readonly state: "ready"; readonly decision: DecisionSnapshot; readonly child: BranchChildDescriptor }
  | { readonly state: "unknown"; readonly decision?: DecisionSnapshot; readonly reason: string }
  | { readonly state: "conflict"; readonly decision?: DecisionSnapshot; readonly reason: string };

interface ChildState {
  readonly descriptor: BranchChildDescriptor;
  gateway?: WorkbenchGateway;
  kernel?: DesktopChatKernel;
  bootting?: Promise<DesktopChatKernel>;
}

export class DesktopBranchRuntime {
  private readonly log: EventLog;
  private readonly sessionId: string;
  private readonly decisions: BranchDecisionService;
  private readonly home: string;
  private readonly repoRoot: string;
  private readonly manifestPath: string;
  private readonly storageRoot: string;
  private readonly runtimeExecutable: string;
  private readonly parentModelSelection: () => DesktopModelSelection;
  private readonly now: () => number;
  private readonly children = new Map<string, ChildState>();
  /** Every owned in-flight start/reconnect operation, so shutdown can await
   * them before it releases the parent lease — none of them may append an
   * admission or publish a completion after disposal began. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** The single idempotent disposal barrier: every caller of dispose()
   * awaits the same completion, and disposal is marked BEFORE the awaited
   * operations are resolved. */
  private disposal?: Promise<void>;
  private disposed = false;

  constructor(options: DesktopBranchRuntimeOptions) {
    if (!options || typeof options !== "object") fail("branch_runtime_configuration_invalid");
    if (!options.log || typeof options.log.path !== "string" || !Array.isArray(options.log.events)
      || options.log.isReadOnly) {
      fail("branch_runtime_configuration_invalid");
    }
    if (typeof options.sessionId !== "string" || options.sessionId.length === 0
      || Buffer.byteLength(options.sessionId) > SESSION_MAX) {
      fail("branch_runtime_configuration_invalid");
    }
    if (!(options.decisions instanceof BranchDecisionService)) fail("branch_runtime_configuration_invalid");
    if (!(options.checkpoints instanceof BranchCheckpointService)) fail("branch_runtime_configuration_invalid");
    for (const key of ["home", "repoRoot", "manifestPath", "storageRoot", "runtimeExecutable"] as const) {
      const value = options[key];
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH) {
        fail("branch_runtime_configuration_invalid");
      }
    }
    if (typeof options.parentModelSelection !== "function") fail("branch_runtime_configuration_invalid");
    this.log = options.log;
    this.sessionId = options.sessionId;
    this.decisions = options.decisions;
    this.home = options.home;
    this.repoRoot = options.repoRoot;
    this.manifestPath = options.manifestPath;
    this.storageRoot = options.storageRoot;
    this.runtimeExecutable = options.runtimeExecutable;
    this.parentModelSelection = options.parentModelSelection;
    this.now = options.now ?? (() => Date.now());
  }

  private reader(): RetainedRuntimeBodyReader {
    const store = BlobStore.forSession(this.log.path);
    return digest => (store.has(digest) ? store.get(digest) : undefined);
  }

  private fold(): RuntimeFold {
    this.log.refresh();
    return foldBranchRuntime(this.log.events, this.reader());
  }

  // --- identifiers ---------------------------------------------------------

  /** Deterministic safe host-derived child identity, bound to the exact
   * governing source, decision, start command and owning client/target
   * thread — never a user path. */
  private deriveChild(request: BranchStartRequest): { id: string } {
    const id = `br-${createHash("sha256").update(canonicalJson({
      schema: BRANCH_RUNTIME_SCHEMA,
      session: this.sessionId,
      decision: request.decisionId,
      command: request.commandId,
      owner: { client_id: request.owner.clientId, thread_id: request.owner.threadId },
      target: { thread_id: request.childThreadId },
    })).digest("hex").slice(0, 24)}`;
    if (!CHILD_ID_PATTERN.test(id) || !BRANCH_WORKSPACE_ID_PATTERN.test(id)) fail("branch_runtime_child_id_invalid");
    return { id };
  }

  private childSessionDirectory(childSession: string): string {
    return join(this.home, "sessions", childSession);
  }

  private childLogPath(childSession: string): string {
    return join(this.childSessionDirectory(childSession), "events.jsonl");
  }

  private currentManifestDigest(): string {
    return resolvePluginManifest(this.manifestPath).digest;
  }

  /** The child's recorded workspace model policy — the authority that wins. */
  private recordedWorkspacePolicy(descriptor: BranchChildDescriptor): BranchWorkspaceModelPolicy {
    const log = new EventLog(this.childLogPath(descriptor.sessionId), { readOnly: true });
    const active = activeBranchWorkspaceReady(log.events, descriptor.sessionId, descriptor.id);
    if (active === undefined) fail("branch_runtime_child_workspace_inactive");
    return active.payload.policy;
  }

  /** The recorded workspace model policy wins over the child's own LIVE
   * facade: the actual current child selection (trusted kernel getter, no
   * provider request) must still equal what its workspace recorded at
   * birth. The parent's model may change freely — it never retargets or
   * rejects an unchanged child. */
  private requireChildFacadePolicy(kernel: DesktopChatKernel, recorded: BranchWorkspaceModelPolicy): void {
    const live = kernel.currentModelSelection();
    if (live === undefined
      || live.route !== recorded.route || live.provider !== recorded.model.provider
      || live.model !== recorded.model.id) {
      fail("branch_runtime_model_policy_changed");
    }
  }

  // --- start ---------------------------------------------------------------

  /** Register one owned in-flight operation for the disposal barrier. The
   * registration happens in the operation's opening synchronous frame, so a
   * concurrent dispose() can never miss a boot that already passed its
   * disposed recheck. */
  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    void operation.catch(() => undefined).then(() => {
      this.inFlight.delete(operation);
    });
    return operation;
  }

  /** Open one real child conversation from a selected decision. See the
   * module header for the fixed durability order and the retry rules. */
  async startChild(request: BranchStartRequest): Promise<BranchStartOutcome> {
    return this.trackOperation(this.startChildOperation(request));
  }

  private async startChildOperation(request: BranchStartRequest): Promise<BranchStartOutcome> {
    if (!request || typeof request !== "object") fail("branch_runtime_request_invalid");
    const { commandId, decisionId, expectedRevision, owner, childThreadId } = request;
    if (typeof commandId !== "string" || !COMMAND_ID_PATTERN.test(commandId)) fail("branch_runtime_command_invalid");
    if (typeof decisionId !== "string" || !CHECKPOINT_ID_PATTERN.test(decisionId)) fail("branch_runtime_decision_invalid");
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision !== 1) {
      fail("branch_runtime_revision_invalid");
    }
    if (!owner || typeof owner !== "object" || typeof owner.clientId !== "string" || !CLIENT_ID_PATTERN.test(owner.clientId)
      || typeof owner.threadId !== "string" || !THREAD_ID_PATTERN.test(owner.threadId)) {
      fail("branch_runtime_owner_invalid");
    }
    if (typeof childThreadId !== "string" || !THREAD_ID_PATTERN.test(childThreadId)) fail("branch_runtime_target_invalid");
    // The child conversation is a distinct identity, not the parent thread
    // rebadged: its binding, cursors and ledger stay isolated from the
    // parent's own thread.
    if (childThreadId === owner.threadId) fail("branch_runtime_target_invalid");
    if (this.disposed) fail("branch_runtime_disposed");
    if (this.log.isReadOnly) fail("branch_runtime_read_only");

    // The recorded state answers first — always recomputed from the EXACT
    // INCOMING request: an identical confirmed start is read-only, an
    // identical unconfirmed start is unknown and never restarts creation,
    // and any changed reuse of a recorded command (decision, owner or
    // target thread) refuses.
    const answer = (): BranchStartOutcome | undefined => {
      const fold = this.fold();
      const existing = fold.byCommand.get(commandId);
      if (existing === undefined) return undefined;
      const derived = this.deriveChild(request);
      const fingerprint = intentFingerprintOf({
        decision_id: decisionId, command_id: commandId,
        source: existing.intent.source,
        owner: { client_id: owner.clientId, thread_id: owner.threadId },
        child: { id: derived.id, session: derived.id, binding: { client_id: owner.clientId, thread_id: childThreadId } },
      });
      if (existing.intent.decision.id !== decisionId || existing.intent.fingerprint !== fingerprint) {
        fail("branch_runtime_command_reuse");
      }
      if (existing.ready !== undefined) {
        return {
          state: "ready",
          decision: this.decisions.read(decisionId),
          child: descriptorOf(existing.intent, existing.ready),
        };
      }
      // Read-only reconciliation: publish the missing parent completion only
      // when an exact already-durable child-ready row independently proves
      // preparation from the recorded admission — no boot, allocation or
      // Send is repeated. A historical admission alone is never a grant.
      const reconciled = this.reconcileRecordedChildReady(existing);
      if (reconciled !== undefined) {
        return { state: "ready", decision: this.decisions.read(decisionId), child: reconciled };
      }
      return {
        state: "unknown",
        decision: this.safeRead(decisionId),
        reason: existing.refusedReason ?? "branch_runtime_start_reserved",
      };
    };
    const recorded = answer();
    if (recorded !== undefined) return recorded;

    // Zero-effect preflight refusals, before any durable row.
    this.log.refresh();
    if (governingSessionOf(this.log.events) !== this.sessionId) fail("branch_runtime_session_binding");
    if (this.log.events.some(row => row.name === "branch/import_ready")) fail("branch_runtime_nested_child_unsupported");
    if (process.env.DOKKABI_CONTEXT_GRAPH !== "on") fail("branch_runtime_context_mode_invalid");
    let manifestDigest: string;
    try {
      manifestDigest = this.currentManifestDigest();
    } catch {
      return fail("branch_runtime_manifest_unavailable");
    }
    const decision = this.decisions.read(decisionId);
    if (decision.revision !== 1 || decision.selected === null) fail("branch_runtime_not_selected");
    if (decision.application !== null) fail("branch_runtime_application_exists");
    const selected = decision.selected;
    const decisionSource = decisionSourceOf(this.log.events, decisionId);
    let currentSelection: DesktopModelSelection;
    try {
      currentSelection = this.parentModelSelection();
    } catch {
      return fail("branch_runtime_model_policy_unresolved");
    }
    if (currentSelection.route.length === 0 || currentSelection.provider.length === 0
      || currentSelection.model.length === 0) {
      fail("branch_runtime_model_policy_unresolved");
    }
    const modelPolicy: BranchWorkspaceModelPolicy = Object.freeze({
      route: currentSelection.route,
      model: Object.freeze({ provider: currentSelection.provider, id: currentSelection.model }),
    });
    const childIds = this.deriveChild(request);
    const prepared = prepareCheckpointInputImport(this.log, this.sessionId, decisionSource.checkpointId, decisionSource.checkpointDigest);
    const facts = validateImportedCheckpointSource(prepared);
    if (facts.pluginManifest !== manifestDigest) fail("branch_runtime_manifest_changed");
    const fingerprint = intentFingerprintOf({
      decision_id: decisionId, command_id: commandId,
      source: { checkpoint: decisionSource.checkpointId, digest: decisionSource.checkpointDigest },
      owner: { client_id: owner.clientId, thread_id: owner.threadId },
      child: { id: childIds.id, session: childIds.id, binding: { client_id: owner.clientId, thread_id: childThreadId } },
    });
    const sourceGoal = contextGoalStatementAt(this.log.events, facts.head, sessionRetainedReader(this.log.path));

    // The durable creation intent, under the existing cross-process lock,
    // BEFORE any child log/workspace/boot acquisition. The same locked
    // catchup reserves the governing decision — a second, different command
    // for the same selected decision conflicts with zero effects — and
    // re-derives the decision fold's full retained authority. Ordinary gate
    // refusals capture into an empty batch outside the writer. The closed
    // payload is validated before the append.
    const intentPayload = {
      schema: BRANCH_RUNTIME_SCHEMA,
      session: this.sessionId,
      command_id: commandId,
      fingerprint,
      decision: {
        id: decisionId,
        revision: 1 as const,
        ref: selected.ref,
        option: selected.option,
        actor: selected.actor,
      },
      source: {
        session: this.sessionId,
        checkpoint: decisionSource.checkpointId,
        digest: decisionSource.checkpointDigest,
        head: { seq: facts.head.seq, hash: facts.head.hash },
      },
      owner: { client_id: owner.clientId, thread_id: owner.threadId },
      child: {
        id: childIds.id,
        session: childIds.id,
        binding: { client_id: owner.clientId, thread_id: childThreadId },
      },
      created_at: this.now(),
    };
    assertClosedReceipt("branch/runtime_intent", intentPayload);
    let appended = false;
    let decisionReserved = false;
    let selectionMoved = false;
    this.log.appendBatchDurable(() => {
      this.log.refresh();
      const refold = foldBranchRuntime(this.log.events, this.reader());
      if (refold.byCommand.has(commandId)) return [];
      if (refold.byDecision.has(decisionId)) {
        decisionReserved = true;
        return [];
      }
      const decisionsNow = projectBranchDecisions(this.log.events, this.reader());
      const current = decisionsNow.decisions.get(decisionId);
      if (current === undefined || current.selected === null
        || !sameJson(current.selected.ref, selected.ref)) {
        selectionMoved = true;
        return [];
      }
      if (current.application !== null) {
        decisionReserved = true;
        return [];
      }
      appended = true;
      return [{
        kind: "observe" as const,
        name: "branch/runtime_intent",
        payload: intentPayload,
      }];
    });
    if (!appended) {
      // A concurrent identical command may have landed under the lock: its
      // recorded state answers (ready/unknown), never a second creation.
      const raced = answer();
      if (raced !== undefined) return raced;
      if (selectionMoved) {
        return { state: "conflict", decision: this.safeRead(decisionId), reason: "branch_runtime_selection_moved" };
      }
      return { state: "conflict", decision, reason: "branch_runtime_decision_reserved" };
    }

    // From here the intent exists: any failure leaves a reserved unknown
    // with its evidence. Only a closed BranchRuntimeError code may record a
    // bounded reason; an unexpected acquisition/boot failure is never
    // marked as a normal terminal refusal and nothing is cleaned up.
    let prepared2: PreparedChild;
    try {
      prepared2 = await this.prepareChild(childIds.id, request, prepared, sourceGoal, modelPolicy);
    } catch (error) {
      if (error instanceof BranchRuntimeError) {
        this.recordBoundedRefusal(commandId, error.code);
        throw error;
      }
      process.stderr.write(`branch runtime start failed unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`);
      throw new BranchRuntimeError("branch_runtime_start_reserved");
    }
    // Disposal may have begun while the preparation was in flight: the
    // parent lease is being released, so this start may neither append an
    // admission nor publish a completion. The booted kernel is disposed
    // here — its persistent workspace and evidence are preserved.
    if (this.disposed) {
      const state = this.ensureChildState(prepared2.descriptor);
      await prepared2.kernel.dispose();
      state.kernel = undefined;
      fail("branch_runtime_disposed");
    }

    // The single R8-04 admission. Only a newly returned grant may publish
    // this runtime's completion; existing/unknown outcomes never do. A
    // decision-service refusal after the boot disposes the unexposed kernel
    // and its lease before it propagates, and records its bounded reason —
    // the reserved intent and its evidence are still preserved.
    let admission: ReturnType<BranchDecisionService["beginApplication"]>;
    try {
      admission = this.decisions.beginApplication({
        id: decisionId,
        commandId,
        expectedRevision: 1,
        child: {
          sessionId: prepared2.descriptor.sessionId,
          context: prepared2.contextService,
          workspace: prepared2.workspace,
          workspaceId: prepared2.descriptor.id,
        },
      });
    } catch (error) {
      const state = this.ensureChildState(prepared2.descriptor);
      await prepared2.kernel.dispose();
      state.kernel = undefined;
      // The decision admission path refuses through the branch services'
      // closed error codes (decision- or workspace-shaped): a matching code
      // is recorded as this start's bounded refusal reason.
      const code = error instanceof BranchDecisionError || error instanceof BranchWorkspaceError
        ? error.code
        : undefined;
      if (code !== undefined && REASON_PATTERN.test(code)) {
        this.recordBoundedRefusal(commandId, code);
      }
      throw error;
    }
    if (admission.outcome !== "admitted") {
      // A lost race or an existing admission is not a reusable grant: keep
      // this start reserved/unknown and dispose only what this runtime owns.
      const state = this.ensureChildState(prepared2.descriptor);
      await prepared2.kernel.dispose();
      state.kernel = undefined;
      return {
        state: "unknown",
        decision: admission.decision,
        reason: admission.outcome === "existing"
          ? "branch_runtime_admission_existing"
          : "branch_runtime_application_lost",
      };
    }

    // Child receipt: appended immediately after the admission, chaining from
    // the exact child head the admission recorded.
    const childLog = new EventLog(this.childLogPath(prepared2.descriptor.sessionId));
    const priorHead = { seq: childLog.lastSeq, hash: childLog.lastHash };
    const admittedChild = admission.decision.application?.child;
    if (admittedChild === undefined || priorHead.seq !== admittedChild.head.seq
      || priorHead.hash !== admittedChild.head.hash) {
      const state = this.ensureChildState(prepared2.descriptor);
      await prepared2.kernel.dispose();
      state.kernel = undefined;
      fail("branch_runtime_child_head_moved");
    }
    // The closed receipts carry the exact snake_case wire representation;
    // both payloads are validated against the closed schemas BEFORE any
    // append (a wrong-shape receipt is never written or accepted).
    const childReadyPayload = {
      schema: BRANCH_RUNTIME_SCHEMA,
      session: prepared2.descriptor.sessionId,
      parent: {
        session: this.sessionId,
        decision: decisionId,
        command_id: commandId,
        admission: admission.decision.application!.ref,
      },
      child_prior_head: priorHead,
      child: {
        id: prepared2.descriptor.id,
        workspace: prepared2.descriptor.workspacePath,
        resource: { ...prepared2.workspaceDescriptor.resource },
      },
      binding: { client_id: owner.clientId, thread_id: childThreadId },
    };
    assertClosedReceipt("branch/runtime_child_ready", childReadyPayload);
    const childReadyRow = childLog.appendBatchDurable(() => [{
      kind: "observe" as const,
      name: "branch/runtime_child_ready",
      payload: childReadyPayload,
    }])[0]!;

    // Retain the exact child ready row, then publish the parent completion.
    const retainedText = canonicalJson(childReadyRow);
    const blob = BlobStore.forSession(this.log.path).put(retainedText);
    const readyPayload = {
      schema: BRANCH_RUNTIME_SCHEMA,
      session: this.sessionId,
      command_id: commandId,
      fingerprint,
      intent: { seq: prepared2.intentRow.seq, hash: prepared2.intentRow.hash },
      selection: selected.ref,
      application: admission.decision.application!.ref,
      source: { checkpoint: decisionSource.checkpointId, digest: decisionSource.checkpointDigest },
      owner: { client_id: owner.clientId, thread_id: owner.threadId },
      child: {
        id: prepared2.descriptor.id,
        session: prepared2.descriptor.sessionId,
        workspace: prepared2.descriptor.workspacePath,
        resource: { ...prepared2.workspaceDescriptor.resource },
        binding: { client_id: owner.clientId, thread_id: childThreadId },
        ready_row: { seq: childReadyRow.seq, hash: childReadyRow.hash },
      },
      blob,
      blob_bytes: Buffer.byteLength(retainedText),
    };
    assertClosedReceipt("branch/runtime_ready", readyPayload);
    this.log.appendBatchDurable(() => [{
      kind: "observe" as const,
      name: "branch/runtime_ready",
      payload: readyPayload,
    }]);

    this.registerChild(prepared2);
    return { state: "ready", decision: admission.decision, child: prepared2.descriptor };
  }

  /** Seed the child log, acquire the persistent workspace, boot the normal
   * leased child kernel and run the authenticated input/lesson import inside
   * the boot's sealed boundary — before any frontend is exposed. The owned
   * storage allocation happens only here, after the durable intent. */
  private async prepareChild(childId: string, request: BranchStartRequest,
    prepared: unknown, sourceGoal: string | undefined,
    modelPolicy: BranchWorkspaceModelPolicy): Promise<PreparedChild> {
    const fold = this.fold();
    const entry = fold.byCommand.get(request.commandId);
    if (entry === undefined) fail("branch_runtime_intent_missing");
    const childSession = childId;

    // The current-schema seed session/open with the source's authenticated
    // manifest identity. Not a live kernel: the normal boot below records
    // the real root/environment/plugins/seal (the existing import verifiers
    // already accept a trusted seed followed by the ordinary boot).
    const seedLog = EventLog.create(this.childLogPath(childSession));
    seedLog.append({
      kind: "observe",
      name: "session/open",
      payload: {
        id: childSession,
        plugin_manifest_digest: validateImportedCheckpointSource(prepared).pluginManifest,
        ...currentSessionSchemaPayload(),
      },
    });

    // The owned allocation, only after the durable intent: the operator
    // storage root is created here, never at capability discovery.
    if (!existsSync(this.storageRoot)) mkdirSync(this.storageRoot, { recursive: true, mode: 0o700 });
    const workspace = new BranchWorkspaceService({
      log: new EventLog(this.childLogPath(childSession)),
      sessionId: childSession,
      storageRoot: this.storageRoot,
      runtimeExecutable: this.runtimeExecutable,
      modelPolicy,
    });
    const workspaceDescriptor = workspace.acquire({
      id: childId,
      sourceLog: this.log,
      parentSession: this.sessionId,
      checkpointId: entry.intent.source.checkpoint,
      checkpointDigest: entry.intent.source.digest,
    });

    // The normal leased child boot, pinned to the birth model policy
    // through the trusted boot configuration. The branch bootstrap runs
    // after the boot sealed the actual current material and before the
    // frontend exists; a refusal disposes the boot and releases the lease.
    // Every tracked child turn — success or failure — settles durably into
    // THIS child's own gateway ledger before its active command tracking
    // clears (D1): the closure resolves the child's gateway at settle time,
    // so a gateway created later still receives the receipt.
    let contextService: ContextGraphService | undefined;
    const kernel = await openDesktopChatKernel({
      sessionId: childSession,
      home: this.home,
      workspaceRoot: workspaceDescriptor.workspace,
      repoRoot: this.repoRoot,
      manifestPath: this.manifestPath,
      resume: true,
      modelSelection: { route: modelPolicy.route, model: modelPolicy.model.id },
      turnLifecycle: {
        onTurnSettled: (commandId, outcome) => {
          this.children.get(childId)?.gateway?.noteSettlement(commandId, outcome);
        },
      },
      branchBootstrap: async (material: DesktopKernelBranchMaterial) => {
        if (material.sessionId !== childSession) fail("branch_runtime_child_binding");
        if (material.pluginManifestDigest !== this.currentManifestDigest()) fail("branch_runtime_manifest_changed");
        const service = material.contextGraphService();
        if (service === undefined || service.mode !== "on"
          || service.workspaceRoot !== workspaceDescriptor.workspace) {
          fail("branch_runtime_context_unavailable");
        }
        importCheckpointProviderInput(material.log, prepared, {
          sessionId: childSession,
          systemPrompt: material.systemPrompt,
          tools: material.toolSchemas,
          pluginManifest: material.pluginManifestDigest,
        });
        if (sourceGoal !== undefined) {
          material.log.append({ kind: "observe", name: "work/goal", payload: { statement: sourceGoal, digest: "pending" } });
        }
        importCheckpointLessons(service, {
          sessionId: childSession,
          workspace,
          workspaceId: childId,
        });
        contextService = service;
      },
    });
    // Disposal may have begun while the boot was in flight: the just-booted
    // kernel is unexposed, so it is disposed here — before any admission or
    // publication — and the start fails as disposed.
    if (this.disposed) {
      await kernel.dispose();
      fail("branch_runtime_disposed");
    }
    if (contextService === undefined) {
      await kernel.dispose();
      fail("branch_runtime_context_unavailable");
    }
    // The actual current child facade must equal the recorded birth policy
    // before anything is exposed. A refusal disposes the unexposed boot and
    // releases its lease — no kernel is left holding the child session
    // against every later reconnect attempt.
    try {
      this.requireChildFacadePolicy(kernel, modelPolicy);
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
    const descriptor: BranchChildDescriptor = Object.freeze({
      id: childId,
      sessionId: childSession,
      workspacePath: workspaceDescriptor.workspace,
      parent: Object.freeze({ clientId: request.owner.clientId, threadId: request.owner.threadId }),
      binding: Object.freeze({ clientId: request.owner.clientId, threadId: request.childThreadId }),
    });
    // The booted kernel is owned from the moment it exists — before the
    // admission/receipt appends — so a lost acknowledgement still leaves it
    // registered for shutdown disposal instead of leaking its lease.
    this.ensureChildState(descriptor).kernel = kernel;

    return {
      descriptor,
      intentRow: entry.intentRow,
      workspaceDescriptor,
      workspace,
      contextService,
      kernel,
    };
  }

  private recordBoundedRefusal(commandId: string, code: string): void {
    if (!REASON_PATTERN.test(code)) return;
    const payload = { schema: BRANCH_RUNTIME_SCHEMA, session: this.sessionId, command_id: commandId, reason: code };
    assertClosedReceipt("branch/runtime_refused", payload);
    try {
      this.log.appendBatchDurable(() => [{
        kind: "observe" as const,
        name: "branch/runtime_refused",
        payload,
      }]);
    } catch {
      // The reserved intent still stands; the reason row is informational.
    }
  }

  /** The read-only reconciliation path: an exact already-durable
   * `branch/runtime_child_ready` row that binds the recorded admission
   * independently proves preparation, so the missing parent completion may
   * be published without repeating any boot, allocation or Send. */
  private reconcileRecordedChildReady(entry: RuntimeEntry): BranchChildDescriptor | undefined {
    const decision = this.safeRead(entry.intent.decision.id);
    if (decision === undefined) return undefined;
    const application = decision.application;
    if (application === null) return undefined;
    if (application.child.session !== entry.intent.child.session) return undefined;
    const childPath = this.childLogPath(entry.intent.child.session);
    if (!existsSync(childPath)) return undefined;
    const childLog = new EventLog(childPath, { readOnly: true });
    const expectedSeq = application.child.head.seq + 1;
    const row = childLog.events[expectedSeq - 1];
    if (row === undefined || row.seq !== expectedSeq || row.name !== "branch/runtime_child_ready") return undefined;
    // The admission row's own child evidence carries the exact workspace and
    // resource coordinates the completion must repeat.
    this.log.refresh();
    const admissionRow = this.log.events[application.ref.seq - 1];
    const admissionChild = admissionRow !== undefined && admissionRow.seq === application.ref.seq
      && admissionRow.hash === application.ref.hash && admissionRow.name === "decision/application_intent"
      ? admissionRow.payload.child as
        | { resource?: { root?: unknown; owner?: unknown } }
        | undefined
      : undefined;
    const resource = admissionChild?.resource;
    if (admissionChild === undefined || resource === undefined
      || typeof resource.root !== "string" || typeof resource.owner !== "string") {
      return undefined;
    }
    try {
      verifyRetainedChildReadyRow(row, {
        parentSession: entry.intent.session,
        applicationChildHead: application.child.head,
        admission: application.ref,
        decisionId: entry.intent.decision.id,
        commandId: entry.commandId,
        child: {
          session: entry.intent.child.session,
          id: entry.intent.child.id,
          workspace: application.child.workspace,
          resource: { root: resource.root, owner: resource.owner },
          binding: entry.intent.child.binding,
          ready_row: { seq: row.seq, hash: row.hash },
        },
      });
    } catch {
      return undefined;
    }
    const descriptor: BranchChildDescriptor = Object.freeze({
      id: entry.intent.child.id,
      sessionId: entry.intent.child.session,
      workspacePath: application.child.workspace,
      parent: Object.freeze({
        clientId: entry.intent.owner.client_id,
        threadId: entry.intent.owner.thread_id,
      }),
      binding: Object.freeze({
        clientId: entry.intent.child.binding.client_id,
        threadId: entry.intent.child.binding.thread_id,
      }),
    });
    const retainedText = canonicalJson(row);
    const blob = BlobStore.forSession(this.log.path).put(retainedText);
    const readyPayload = {
      schema: BRANCH_RUNTIME_SCHEMA,
      session: this.sessionId,
      command_id: entry.commandId,
      fingerprint: entry.intent.fingerprint,
      intent: { seq: entry.intentRow.seq, hash: entry.intentRow.hash },
      selection: entry.intent.decision.ref,
      application: application.ref,
      source: { checkpoint: entry.intent.source.checkpoint, digest: entry.intent.source.digest },
      owner: { ...entry.intent.owner },
      child: {
        id: entry.intent.child.id,
        session: entry.intent.child.session,
        workspace: application.child.workspace,
        resource: { root: resource.root, owner: resource.owner },
        binding: { ...entry.intent.child.binding },
        ready_row: { seq: row.seq, hash: row.hash },
      },
      blob,
      blob_bytes: Buffer.byteLength(retainedText),
    };
    assertClosedReceipt("branch/runtime_ready", readyPayload);
    let readyRefusal: BranchRuntimeError | undefined;
    this.log.appendBatchDurable(() => {
      const refold = foldBranchRuntime(this.log.events, this.reader());
      const fresh = refold.byCommand.get(entry.commandId);
      if (fresh === undefined || fresh.ready !== undefined) {
        readyRefusal = new BranchRuntimeError("branch_runtime_second_ready");
        return [];
      }
      return [{
        kind: "observe" as const,
        name: "branch/runtime_ready",
        payload: readyPayload,
      }];
    });
    if (readyRefusal !== undefined) throw readyRefusal;
    this.ensureChildState(descriptor);
    return descriptor;
  }

  private safeRead(decisionId: string): DecisionSnapshot | undefined {
    try {
      return this.decisions.read(decisionId);
    } catch {
      return undefined;
    }
  }

  private ensureChildState(descriptor: BranchChildDescriptor): ChildState {
    let state = this.children.get(descriptor.id);
    if (state === undefined) {
      state = { descriptor };
      this.children.set(descriptor.id, state);
    }
    return state;
  }

  private registerChild(prepared: PreparedChild): void {
    const state = this.ensureChildState(prepared.descriptor);
    state.kernel = prepared.kernel;
  }

  // --- recorded reads ------------------------------------------------------

  /** The recorded confirmed children of this runtime, keyed by child id. */
  recordedChildren(): Map<string, { commandId: string; descriptor: BranchChildDescriptor }> {
    return new Map(projectBranchRuntime(this.log.events, this.reader()).children);
  }

  /** The recorded start view for one command id, if any. */
  recordedStart(commandId: string): BranchRuntimeStartView | undefined {
    return projectBranchRuntime(this.log.events, this.reader()).starts.get(commandId);
  }

  /** The confirmed ready child descriptor of a decision, when one exists. */
  childForDecision(decisionId: string): BranchChildDescriptor | undefined {
    for (const view of projectBranchRuntime(this.log.events, this.reader()).starts.values()) {
      if (view.decisionId === decisionId && view.state === "ready") return view.child;
    }
    return undefined;
  }

  /** The recorded start view of a decision — ready OR still reserved — so a
   * status read can expose a durable intent as unknown even before any
   * application admission exists. */
  startForDecision(decisionId: string): BranchRuntimeStartView | undefined {
    for (const view of projectBranchRuntime(this.log.events, this.reader()).starts.values()) {
      if (view.decisionId === decisionId) return view;
    }
    return undefined;
  }

  /** True when the session id is one of this runtime's recorded children —
   * including a durable INTENT's claimed child session before any ready
   * completion exists (the fence the desktop server consults for
   * note.submit and delete). Cold durable claims fence with no live
   * kernels; unknown intents are never cleaned up or rebooted here. */
  ownsChildSession(sessionId: string): boolean {
    this.log.refresh();
    for (const view of projectBranchRuntime(this.log.events, this.reader()).starts.values()) {
      if (view.childSession === sessionId) return true;
    }
    return false;
  }

  // --- child kernels and gateways -------------------------------------------

  /** Validate a child id against the recorded ready completions. */
  private requireRecordedChild(childId: string): BranchChildDescriptor {
    if (typeof childId !== "string" || !CHILD_ID_PATTERN.test(childId)) fail("branch_runtime_child_invalid");
    if (this.disposed) fail("branch_runtime_disposed");
    const recorded = this.recordedChildren().get(childId);
    if (recorded === undefined) fail("branch_runtime_child_unknown");
    return recorded.descriptor;
  }

  /** The host-only mutable dispatch guard: current owned workspace, recorded
   * input/context authority, recorded workspace model policy and current
   * manifest identity — checked before a child submit intent/handoff. The
   * ordinary request context is still applied later at the actual provider
   * request; nothing here copies a frame proposal into request authority. */
  assertBranchDispatchReady(childId: string): void {
    const descriptor = this.requireRecordedChild(childId);
    const recorded = this.recordedWorkspacePolicy(descriptor);
    const workspace = new BranchWorkspaceService({
      log: new EventLog(this.childLogPath(descriptor.sessionId)),
      sessionId: descriptor.sessionId,
      storageRoot: this.storageRoot,
      runtimeExecutable: this.runtimeExecutable,
      modelPolicy: recorded,
    });
    const read = workspace.read(descriptor.id);
    if (read.session !== descriptor.sessionId || read.workspace !== descriptor.workspacePath) {
      fail("branch_runtime_child_binding");
    }
    // The live child facade (when the kernel is open — a submit always has
    // one) must still carry the recorded policy. The parent's own model
    // selection is irrelevant here by design.
    const kernel = this.childKernel(childId);
    if (kernel !== undefined) {
      this.requireChildFacadePolicy(kernel, recorded);
    }
    const childLog = new EventLog(this.childLogPath(descriptor.sessionId), { readOnly: true });
    try {
      validateBranchContextAuthority(childLog.events, {
        session: descriptor.sessionId,
        workspace: descriptor.id,
        reader: sessionRetainedReader(childLog.path),
      });
    } catch {
      fail("branch_runtime_child_authority_lost");
    }
    const opened = [...childLog.events].reverse().find(row => row.name === "session/open");
    if (opened === undefined || opened.payload.plugin_manifest_digest !== this.currentManifestDigest()) {
      fail("branch_runtime_manifest_changed");
    }
  }

  /** An explicit confirmed reconnect: reopens the same recorded child
   * through the ordinary lease after verifying current ownership, the
   * recorded workspace model policy and the manifest identity. Never
   * repeats application admission, the input import or a prior Send. */
  async resumeChild(childId: string): Promise<DesktopChatKernel> {
    const descriptor = this.requireRecordedChild(childId);
    if (this.disposed) fail("branch_runtime_disposed");
    return this.trackOperation(this.resumeChildOperation(descriptor));
  }

  private async resumeChildOperation(descriptor: BranchChildDescriptor): Promise<DesktopChatKernel> {
    const state = this.ensureChildState(descriptor);
    if (state.kernel !== undefined) return state.kernel;
    if (state.bootting !== undefined) return state.bootting;
    const boot = this.bootRecordedChild(descriptor);
    state.bootting = boot;
    try {
      return await boot;
    } finally {
      if (state.bootting === boot) state.bootting = undefined;
    }
  }

  private async bootRecordedChild(descriptor: BranchChildDescriptor): Promise<DesktopChatKernel> {
    if (this.disposed) fail("branch_runtime_disposed");
    const state = this.ensureChildState(descriptor);
    // Cold reconnect validates ACTUAL current ownership/context — the same
    // host-only guard a submit rechecks — BEFORE the interactive lease is
    // taken or a kernel boots: a lost or replaced ownership marker refuses
    // with no new child session rows and no lease held. The live facade
    // comparison inside the guard is skipped here (no kernel is open yet)
    // and re-checked against the recorded policy right after the boot.
    this.assertBranchDispatchReady(descriptor.id);
    const recorded = this.recordedWorkspacePolicy(descriptor);
    const childLog = new EventLog(this.childLogPath(descriptor.sessionId), { readOnly: true });
    const opened = [...childLog.events].reverse().find(row => row.name === "session/open");
    if (opened === undefined || opened.payload.plugin_manifest_digest !== this.currentManifestDigest()) {
      fail("branch_runtime_manifest_changed");
    }
    const kernel = await openDesktopChatKernel({
      sessionId: descriptor.sessionId,
      home: this.home,
      workspaceRoot: descriptor.workspacePath,
      repoRoot: this.repoRoot,
      manifestPath: this.manifestPath,
      resume: true,
      // Reconnect pins the boot to the recorded workspace policy — never to
      // whatever the parent currently selected.
      modelSelection: { route: recorded.route, model: recorded.model.id },
      // Every tracked reconnect turn settles durably into the child's OWN
      // gateway ledger (D1): the closure resolves the child's gateway at
      // settle time, cold or warm.
      turnLifecycle: {
        onTurnSettled: (commandId, outcome) => {
          this.children.get(descriptor.id)?.gateway?.noteSettlement(commandId, outcome);
        },
      },
    });
    // Disposal began while the boot was in flight: the unexposed kernel is
    // disposed here and the reconnect fails as disposed.
    if (this.disposed) {
      await kernel.dispose();
      fail("branch_runtime_disposed");
    }
    try {
      this.requireChildFacadePolicy(kernel, recorded);
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
    state.kernel = kernel;
    return kernel;
  }

  childKernel(childId: string): DesktopChatKernel | undefined {
    return this.children.get(childId)?.kernel;
  }

  /** The distinct per-child gateway over its own ledger and kernel. The
   * gateway is constructed pre-bound to the recorded child binding, with the
   * trusted explicit child session id so unbooted/restarted reads can never
   * fall back to another session. */
  childGateway(childId: string): WorkbenchGateway {
    const descriptor = this.requireRecordedChild(childId);
    const state = this.ensureChildState(descriptor);
    if (state.gateway === undefined) {
      // The trusted configured model identity is the child's exact recorded
      // workspace policy, so a cold child handshake can never report the
      // global/parent selection after a config change.
      const policy = this.recordedWorkspacePolicy(descriptor);
      const config: WorkbenchGatewayConfig = {
        workspaceCwd: descriptor.workspacePath,
        sessionsRoot: join(this.home, "sessions"),
        gatewayLogPath: join(this.childSessionDirectory(descriptor.sessionId), "gateway.jsonl"),
        sessionId: descriptor.sessionId,
        binding: { clientId: descriptor.binding.clientId, threadId: descriptor.binding.threadId },
        modelIdentity: { route: policy.route, provider: policy.model.provider, model: policy.model.id },
        openKernel: async () => await this.resumeChildHandle(childId),
        getKernel: () => this.childKernelHandle(childId),
      };
      state.gateway = new WorkbenchGateway(config);
    }
    return state.gateway;
  }

  /** An explicit child bind resumes through the ordinary lease and answers
   * the guarded kernel handle. */
  private async resumeChildHandle(childId: string): Promise<WorkbenchKernelHandle> {
    await this.resumeChild(childId);
    const handle = this.childKernelHandle(childId);
    if (handle === undefined) fail("branch_runtime_child_unavailable");
    return handle;
  }

  /** The child kernel handle the child gateway sees: the real kernel behind
   * the host-only mutable dispatch guard. */
  private childKernelHandle(childId: string): WorkbenchKernelHandle | undefined {
    const kernel = this.childKernel(childId);
    if (kernel === undefined) return undefined;
    return {
      sessionId: kernel.sessionId,
      submitNote: (text: string, commandId?: string) => kernel.submitNote(text, commandId),
      abortActive: () => kernel.abortActive(),
      busy: () => kernel.busy(),
      routeStatus: () => kernel.routeStatus(),
      workModeService: () => kernel.workModeService?.(),
      permissionMode: () => kernel.permissionMode(),
      currentModelSelection: () => kernel.currentModelSelection(),
      assertBranchDispatchReady: () => this.assertBranchDispatchReady(childId),
    };
  }

  /** Validate the recorded owner of a child against a caller binding. */
  childForOwner(childId: string, owner: { clientId: string; threadId: string }): BranchChildDescriptor {
    const descriptor = this.requireRecordedChild(childId);
    if (descriptor.parent.clientId !== owner.clientId || descriptor.parent.threadId !== owner.threadId) {
      fail("branch_runtime_owner_mismatch");
    }
    return descriptor;
  }

  /** Dispose only the kernels/leases this runtime owns. Persistent
   * workspaces, logs and evidence are preserved. Disposal is marked BEFORE
   * the awaited in-flight start/reconnect operations resolve, and every
   * caller — the parent kernel's plugin disposer, the desktop server's stop
   * barrier, a direct host caller — awaits the ONE same completion barrier. */
  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposed = true;
    const barrier = (async (): Promise<void> => {
      if (this.inFlight.size > 0) {
        await Promise.allSettled([...this.inFlight]);
      }
      for (const state of [...this.children.values()]) {
        state.gateway = undefined;
        await state.kernel?.dispose();
        state.kernel = undefined;
      }
      this.children.clear();
    })();
    this.disposal = barrier;
    return barrier;
  }
}

interface PreparedChild {
  readonly descriptor: BranchChildDescriptor;
  readonly intentRow: EventRecord;
  readonly workspaceDescriptor: { workspace: string; resource: { root: string; owner: string } };
  readonly workspace: BranchWorkspaceService;
  readonly contextService: ContextGraphService;
  readonly kernel: DesktopChatKernel;
}

/** The trusted desktop boot boundary capability key: only the desktop host
 * (openDesktopChatKernel) provides it, so non-desktop boots never expose a
 * runnable branch capability. */
export const DESKTOP_BRANCH_RUNTIME_BOUNDARY = "desktop_branch_runtime_boundary";

/** The host-only runnable branch runtime capability the optional plugin
 * defines and provides. */
export const BRANCH_RUNTIME_CAPABILITY = "branch_runtime";
