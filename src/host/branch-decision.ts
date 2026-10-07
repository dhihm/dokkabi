import { createHash } from "node:crypto";
import { z } from "zod";
import { BlobStore, collectReferencedBlobs } from "./blob-store.ts";
import { canonicalJson } from "./canonical.ts";
import { EventLog } from "./event-log.ts";
import { BranchCheckpointService, CHECKPOINT_ID_PATTERN } from "./branch-checkpoint.ts";
import { prepareCheckpointInputImport } from "./checkpoint-input-import.ts";
import {
  assertSettledSourceEffects,
  CHECKPOINT_IMPORT_REASON,
  MAX_CHECKPOINT_IMPORT_BODIES,
  MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES,
  MAX_CHECKPOINT_IMPORT_EVENTS,
  projectProviderInputs,
  PROVIDER_BODY_EVENTS,
  validateImportedCheckpointSource,
  verifySourceBodies,
  verifySourceEventChain,
} from "./provider-input.ts";
import {
  activeBranchWorkspaceReady,
  branchWorkspaceReceiptSchemas,
  BranchWorkspaceService,
  verifyBranchWorkspaceLiveResource,
  verifyRetainedBranchWorkspace,
  type BranchWorkspaceReady,
  type RetainedBodyStore,
} from "./branch-workspace.ts";
import { projectSessionReplaySchemas, type EventRecord } from "./schema.ts";
import { assertNoSecrets } from "./redact.ts";
import { ContextGraphService } from "../context-graph/service.ts";
import {
  branchImportRowSchema,
  IMPORTED_FIT_VERDICTS,
  sessionRetainedReader,
  validateBranchContextAuthority,
} from "../context-graph/branch-context.ts";
import { projectContextGraph } from "../context-graph/projector.ts";
import { verifyContextFrames } from "../context-graph/service.ts";

/** R8-04 durable decision and application admission
 * (docs/desktop-decisions-r8.md). One immutable decision definition is
 * retained per verified checkpoint; a human choice and an eligible standing
 * policy deadline race against the same durable revision under the EventLog
 * cross-process append lock — exactly one awaiting revision 0 becomes
 * selected revision 1, and losers record a conflict observation that changes
 * nothing. One later application admission (revision 2) requires the actual
 * child context/workspace/input authorities and retains a cold-verifiable
 * child evidence bundle BEFORE the intent row; its execution outcome stays
 * unknown until R8-05 records an independently bound downstream
 * confirmation. Nothing here converts a selection into a tool permission,
 * invokes a model, or executes filesystem effects.
 *
 * The writer, the live reader and cold replay share the fold and the
 * retained-evidence verifiers below, so a row the fold would refuse can
 * never be written, and a row the writer wrote can never be reinterpreted. */

export const BRANCH_DECISION_SCHEMA = "branch-decision-v1";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_MAX = 256;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_OPTIONS = 16;
const MIN_OPTIONS = 2;
const MAX_QUESTION_CHARS = 2000;
const MAX_RATIONALE_CHARS = 2000;
const MAX_LABEL_CHARS = 200;
const MAX_POLICY_ID = 128;
const MAX_PATH = 4096;

export class BranchDecisionError extends Error {
  constructor(readonly code: string) {
    // A refusal is a code only: never a stack path, a secret or a runtime id.
    super(`branch-decision: ${code}`);
    this.name = "BranchDecisionError";
  }
}

function fail(code: string): never {
  throw new BranchDecisionError(code);
}

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

// ---------------------------------------------------------------------------
// Closed receipt contract, shared by the host writer, the live fold and cold
// replay.
// ---------------------------------------------------------------------------

const digestField = z.string().regex(DIGEST_PATTERN);
const eventRefSchema = z.strictObject({ seq: z.number().int().positive(), hash: digestField });
const decisionIdSchema = z.string().regex(CHECKPOINT_ID_PATTERN);
const optionSchema = z.strictObject({ id: z.string().regex(OPTION_ID_PATTERN), label: z.string().min(1).max(MAX_LABEL_CHARS) });
const standingPolicySchema = z.strictObject({
  id: z.string().min(1).max(MAX_POLICY_ID),
  version: z.number().int().positive(),
  afterMs: z.number().int().positive(),
});
const recordedPolicySchema = z.strictObject({
  id: z.string().min(1).max(MAX_POLICY_ID),
  version: z.number().int().positive(),
  afterMs: z.number().int().positive(),
  deadline: z.number().int().nonnegative(),
});
const sourceRefSchema = z.strictObject({
  session: z.string().min(1).max(SESSION_MAX),
  checkpoint: z.string().regex(CHECKPOINT_ID_PATTERN),
  digest: digestField,
  head: eventRefSchema,
});

export const branchDecisionReceiptSchemas = {
  /** The immutable definition: question, options, recommendation, rationale,
   * the authenticated checkpoint source bundle that rooted it, the frozen
   * operator policy with its recorded deadline, and any immutable alternate
   * ancestry. A second open row for the same identifier never lands. */
  "decision/open": z.strictObject({
    schema: z.literal(BRANCH_DECISION_SCHEMA),
    session: z.string().min(1).max(SESSION_MAX),
    id: decisionIdSchema,
    command_id: z.string().regex(COMMAND_ID_PATTERN),
    kind: z.literal("branch"),
    fingerprint: digestField,
    checkpoint: z.strictObject({ id: z.string().regex(CHECKPOINT_ID_PATTERN), digest: digestField }),
    source: sourceRefSchema,
    source_blob: digestField,
    source_blob_bytes: z.number().int().positive(),
    question: z.string().min(1).max(MAX_QUESTION_CHARS),
    options: z.array(optionSchema).min(MIN_OPTIONS).max(MAX_OPTIONS),
    recommendation: z.string().regex(OPTION_ID_PATTERN),
    rationale: z.string().max(MAX_RATIONALE_CHARS),
    policy: recordedPolicySchema.nullable(),
    alternate_of: z.strictObject({ id: decisionIdSchema, selection: eventRefSchema }).nullable(),
    opened_at: z.number().int().nonnegative(),
  }),
  /** One selection attempt against the durable revision. The fold
   * independently re-derives the disposition: the first response of a
   * decision is its only winner; every later response is a conflict that
   * names the current winner and changes nothing. */
  "decision/response": z.strictObject({
    schema: z.literal(BRANCH_DECISION_SCHEMA),
    session: z.string().min(1).max(SESSION_MAX),
    id: decisionIdSchema,
    command_id: z.string().regex(COMMAND_ID_PATTERN),
    fingerprint: digestField,
    expected_revision: z.number().int().nonnegative(),
    actor: z.enum(["human", "policy"]),
    option: z.string().regex(OPTION_ID_PATTERN),
    at: z.number().int().nonnegative(),
    disposition: z.enum(["selected", "conflict"]),
    selected_ref: eventRefSchema.nullable(),
  }),
  /** The single application admission. Binds the exact winning selection and
   * the retained cold-verifiable child evidence bundle it roots; the
   * execution outcome is unknown and only R8-05 may confirm it. */
  "decision/application_intent": z.strictObject({
    schema: z.literal(BRANCH_DECISION_SCHEMA),
    session: z.string().min(1).max(SESSION_MAX),
    id: decisionIdSchema,
    command_id: z.string().regex(COMMAND_ID_PATTERN),
    fingerprint: digestField,
    expected_revision: z.literal(1),
    selection: eventRefSchema,
    option: z.string().regex(OPTION_ID_PATTERN),
    actor: z.enum(["human", "policy"]),
    child: z.strictObject({
      session: z.string().min(1).max(SESSION_MAX),
      workspace_id: z.string().regex(CHECKPOINT_ID_PATTERN),
      workspace: z.string().startsWith("/").max(MAX_PATH),
      resource: z.strictObject({ root: z.string().startsWith("/").max(MAX_PATH), owner: digestField }),
      head: eventRefSchema,
    }),
    blob: digestField,
    blob_bytes: z.number().int().positive(),
    state: z.literal("unknown"),
  }),
} as const;

export type BranchDecisionReceiptName = keyof typeof branchDecisionReceiptSchemas;
export type BranchDecisionStandingPolicy = Readonly<z.infer<typeof standingPolicySchema>>;
type OpenPayload = z.infer<typeof branchDecisionReceiptSchemas["decision/open"]>;
type ResponsePayload = z.infer<typeof branchDecisionReceiptSchemas["decision/response"]>;
type ApplicationPayload = z.infer<typeof branchDecisionReceiptSchemas["decision/application_intent"]>;

/** The bounded closed child evidence bundle an application intent retains:
 * the verified child event prefix, the exact original text of every JSON
 * body it references (provider bodies, retained import bundles and the
 * workspace images), the recorded workspace-ready receipt, and the fresh
 * context scope/goal/fit evidence the admission boundary produced. Caps and
 * body rules reuse the checkpoint import bounds; verification is cold — no
 * filesystem, Git, model call, allocation or clock. */
export const branchDecisionReadinessSchema = z.strictObject({
  version: z.literal(1),
  schema: z.literal(BRANCH_DECISION_SCHEMA),
  decision: z.strictObject({
    session: z.string().min(1).max(SESSION_MAX),
    id: decisionIdSchema,
    command_id: z.string().regex(COMMAND_ID_PATTERN),
    fingerprint: digestField,
  }),
  selection: z.strictObject({
    ref: eventRefSchema,
    revision: z.number().int().positive(),
    option: z.string().regex(OPTION_ID_PATTERN),
    actor: z.enum(["human", "policy"]),
  }),
  child: z.strictObject({
    session: z.string().min(1).max(SESSION_MAX),
    workspace_id: z.string().regex(CHECKPOINT_ID_PATTERN),
    workspace: z.string().startsWith("/").max(MAX_PATH),
    resource: z.strictObject({ root: z.string().startsWith("/").max(MAX_PATH), owner: digestField }),
    root: z.strictObject({
      uid: z.number().int().nonnegative(),
      dev: z.number().int().nonnegative(),
      ino: z.number().int().positive(),
      mode: z.literal(0o700),
    }),
    head: eventRefSchema,
  }),
  source: z.strictObject({
    session: z.string().min(1).max(SESSION_MAX),
    checkpoint: z.string().regex(CHECKPOINT_ID_PATTERN),
    digest: digestField,
    head: eventRefSchema,
    source_blob: digestField,
    source_blob_bytes: z.number().int().positive(),
  }),
  workspace: branchWorkspaceReceiptSchemas["branch/workspace_ready"],
  context: z.strictObject({
    repository: z.string().min(1).max(200),
    goal: z.string().max(64).nullable(),
    fits: z.array(z.strictObject({
      lesson: z.string().min(1).max(64),
      verdict: z.enum(IMPORTED_FIT_VERDICTS),
    })).max(64),
  }),
  events: z.array(z.record(z.string(), z.unknown())).max(MAX_CHECKPOINT_IMPORT_EVENTS),
  bodies: z.array(z.strictObject({
    digest: digestField,
    bytes: z.number().int().nonnegative(),
    text: z.string(),
  })).max(MAX_CHECKPOINT_IMPORT_BODIES),
});
export type BranchDecisionReadiness = z.infer<typeof branchDecisionReadinessSchema>;

// ---------------------------------------------------------------------------
// Fingerprints: recomputed by the fold from the recorded row alone, so a
// rewritten payload that still chains cannot pose as the same command.
// ---------------------------------------------------------------------------

function openFingerprintOf(value: {
  kind: string; checkpoint: { id: string; digest: string }; question: string;
  options: readonly { id: string; label: string }[]; recommendation: string; rationale: string;
  alternate_of: { id: string; selection: { seq: number; hash: string } } | null;
}): string {
  return sha256Hex(canonicalJson({
    schema: BRANCH_DECISION_SCHEMA,
    kind: value.kind,
    checkpoint: { id: value.checkpoint.id, digest: value.checkpoint.digest },
    question: value.question,
    options: value.options.map(option => ({ id: option.id, label: option.label })),
    recommendation: value.recommendation,
    rationale: value.rationale,
    alternate_of: value.alternate_of === null ? null : {
      id: value.alternate_of.id,
      selection: { seq: value.alternate_of.selection.seq, hash: value.alternate_of.selection.hash },
    },
  }));
}

function responseFingerprintOf(value: { id: string; actor: string; option: string; expected_revision: number }): string {
  return sha256Hex(canonicalJson({
    schema: BRANCH_DECISION_SCHEMA,
    id: value.id,
    actor: value.actor,
    option: value.option,
    expected_revision: value.expected_revision,
  }));
}

function applicationFingerprintOf(value: { id: string; child_session: string; child_workspace_id: string; expected_revision: number }): string {
  return sha256Hex(canonicalJson({
    schema: BRANCH_DECISION_SCHEMA,
    id: value.id,
    child_session: value.child_session,
    child_workspace_id: value.child_workspace_id,
    expected_revision: value.expected_revision,
  }));
}

// ---------------------------------------------------------------------------
// The fold: one closed state machine over the decision rows. The writer
// re-runs it inside the append lock; the projection and cold replay run it
// over the whole prefix. No retained bodies are read here — the definition
// and every disposition are re-derived from the rows alone.
// ---------------------------------------------------------------------------

interface SelectedFact {
  option: string;
  actor: "human" | "policy";
  commandId: string;
  at: number;
  ref: { seq: number; hash: string };
}

interface ApplicationFact {
  commandId: string;
  ref: { seq: number; hash: string };
  child: { session: string; head: { seq: number; hash: string }; workspace: string };
  payload: ApplicationPayload;
}

interface DecisionEntry {
  readonly open: { readonly row: EventRecord; readonly payload: OpenPayload };
  readonly members: ReadonlySet<string>;
  revision: number;
  selected: SelectedFact | null;
  application: ApplicationFact | null;
}

export interface BranchDecisionReference {
  seq: number;
  name: BranchDecisionReceiptName;
  payloadDigest: string;
}

interface DecisionFold {
  readonly byId: ReadonlyMap<string, DecisionEntry>;
  readonly ordered: readonly { row: EventRecord; name: BranchDecisionReceiptName }[];
  readonly commands: ReadonlyMap<string, { decision: string; fingerprint: string; row: EventRecord }>;
}

function governingSessionOf(events: readonly EventRecord[]): string | undefined {
  let session: string | undefined;
  for (const row of events) {
    if (row.name !== "session/open") continue;
    const id = row.payload.session_id ?? row.payload.id;
    if (typeof id === "string") session = id;
  }
  return session;
}

function foldBranchDecisions(events: readonly EventRecord[]): DecisionFold {
  const featureStart = projectSessionReplaySchemas(events).featureStart.get(BRANCH_DECISION_SCHEMA);
  const byId = new Map<string, DecisionEntry>();
  const ordered: Array<{ row: EventRecord; name: BranchDecisionReceiptName }> = [];
  const commands = new Map<string, { decision: string; fingerprint: string; row: EventRecord }>();
  let governing: string | undefined;
  for (const row of events) {
    if (row.name === "session/open") {
      const id = row.payload.session_id ?? row.payload.id;
      if (typeof id === "string") governing = id;
    }
    if (!row.name.startsWith("decision/")) continue;
    if (!Object.hasOwn(branchDecisionReceiptSchemas, row.name)) fail("branch_decision_receipt_unknown");
    if (row.kind !== "observe" || featureStart === undefined || row.seq <= featureStart) {
      fail("branch_decision_feature_generation");
    }
    const name = row.name as BranchDecisionReceiptName;
    if (governing === undefined || row.payload.session !== governing) fail("branch_decision_session_binding");
    if (typeof row.payload.command_id !== "string") fail("branch_decision_receipt_binding");
    if (commands.has(row.payload.command_id)) fail("branch_decision_command_reuse");
    if (name === "decision/open") {
      const parsed = branchDecisionReceiptSchemas["decision/open"].safeParse(row.payload);
      if (!parsed.success) fail("branch_decision_receipt_binding");
      const payload = parsed.data;
      if (byId.has(payload.id)) fail("branch_decision_open_duplicate");
      if (openFingerprintOf(payload) !== payload.fingerprint) fail("branch_decision_fingerprint");
      if (new Set(payload.options.map(option => option.id)).size !== payload.options.length) {
        fail("branch_decision_options_invalid");
      }
      if (!payload.options.some(option => option.id === payload.recommendation)) {
        fail("branch_decision_recommendation_invalid");
      }
      // The deadline is not free-standing data: it must re-derive from the
      // immutable opened time and the recorded policy duration.
      if (payload.policy !== null && payload.policy.deadline !== payload.opened_at + payload.policy.afterMs) {
        fail("branch_decision_deadline_binding");
      }
      if (payload.alternate_of !== null) {
        const parent = byId.get(payload.alternate_of.id);
        // An alternate names an earlier SELECTED decision of this session
        // with the same checkpoint; it never rewrites the original winner.
        if (parent === undefined || parent.revision < 1 || parent.selected === null
          || !sameJson(parent.selected.ref, payload.alternate_of.selection)
          || parent.open.payload.checkpoint.id !== payload.checkpoint.id
          || parent.open.payload.checkpoint.digest !== payload.checkpoint.digest) {
          fail("branch_decision_alternate_invalid");
        }
      }
      byId.set(payload.id, {
        open: { row, payload },
        members: new Set(payload.options.map(option => option.id)),
        revision: 0,
        selected: null,
        application: null,
      });
      commands.set(payload.command_id, { decision: payload.id, fingerprint: payload.fingerprint, row });
    } else if (name === "decision/response") {
      const parsed = branchDecisionReceiptSchemas["decision/response"].safeParse(row.payload);
      if (!parsed.success) fail("branch_decision_receipt_binding");
      const payload = parsed.data;
      const entry = byId.get(payload.id);
      if (entry === undefined) fail("branch_decision_orphan_response");
      if (responseFingerprintOf(payload) !== payload.fingerprint) fail("branch_decision_fingerprint");
      if (payload.actor === "policy") {
        if (payload.option !== entry.open.payload.recommendation) fail("branch_decision_policy_option");
        // A policy response is eligible only against the recorded policy and
        // only at or after its re-derived deadline; an earlier forged time
        // cannot mint a selection.
        if (entry.open.payload.policy === null || payload.at < entry.open.payload.policy.deadline) {
          fail("branch_decision_policy_early");
        }
      } else if (!entry.members.has(payload.option)) {
        fail("branch_decision_option_invalid");
      }
      if (payload.disposition === "selected") {
        if (entry.revision !== 0 || entry.selected !== null || payload.expected_revision !== 0
          || payload.selected_ref !== null) {
          fail("branch_decision_second_winner");
        }
        entry.selected = { option: payload.option, actor: payload.actor, commandId: payload.command_id,
          at: payload.at, ref: { seq: row.seq, hash: row.hash } };
        entry.revision = 1;
      } else {
        if (entry.revision < 1 || entry.selected === null || payload.selected_ref === null
          || !sameJson(entry.selected.ref, payload.selected_ref)) {
          fail("branch_decision_conflict_disposition");
        }
      }
      commands.set(payload.command_id, { decision: payload.id, fingerprint: payload.fingerprint, row });
    } else {
      const parsed = branchDecisionReceiptSchemas["decision/application_intent"].safeParse(row.payload);
      if (!parsed.success) fail("branch_decision_receipt_binding");
      const payload = parsed.data;
      const entry = byId.get(payload.id);
      if (entry === undefined) fail("branch_decision_orphan_application");
      if (applicationFingerprintOf({
        id: payload.id, child_session: payload.child.session,
        child_workspace_id: payload.child.workspace_id, expected_revision: payload.expected_revision,
      }) !== payload.fingerprint) fail("branch_decision_fingerprint");
      if (entry.revision !== 1 || entry.selected === null || entry.application !== null) {
        fail("branch_decision_second_application");
      }
      if (!sameJson(entry.selected.ref, payload.selection) || payload.option !== entry.selected.option
        || payload.actor !== entry.selected.actor) {
        fail("branch_decision_application_binding");
      }
      entry.application = { commandId: payload.command_id, ref: { seq: row.seq, hash: row.hash },
        child: { session: payload.child.session, head: { ...payload.child.head }, workspace: payload.child.workspace },
        payload };
      entry.revision = 2;
    }
    ordered.push({ row, name });
  }
  return { byId, ordered, commands };
}

// ---------------------------------------------------------------------------
// Snapshots and the pure projection.
// ---------------------------------------------------------------------------

export interface DecisionSelectedView {
  readonly option: string;
  readonly actor: "human" | "policy";
  readonly commandId: string;
  readonly at: number;
  readonly ref: { readonly seq: number; readonly hash: string };
}

export interface DecisionApplicationView {
  readonly commandId: string;
  readonly state: "unknown";
  readonly ref: { readonly seq: number; readonly hash: string };
  readonly child: { readonly session: string; readonly head: { readonly seq: number; readonly hash: string }; readonly workspace: string };
}

export interface DecisionSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly state: "awaiting" | "selected" | "application_pending";
  readonly kind: "branch";
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly recommendation: string;
  readonly rationale: string;
  readonly policy: { readonly id: string; readonly version: number; readonly afterMs: number; readonly deadline: number } | null;
  readonly openedAt: number;
  readonly selected: DecisionSelectedView | null;
  readonly application: DecisionApplicationView | null;
  readonly alternateOf: { readonly id: string; readonly selection: { readonly seq: number; readonly hash: string } } | null;
  readonly citations: { readonly open: number; readonly selected: number | null; readonly application: number | null };
}

function snapshotOf(entry: DecisionEntry): DecisionSnapshot {
  const payload = entry.open.payload;
  return Object.freeze({
    id: payload.id,
    revision: entry.revision,
    state: entry.revision === 0 ? "awaiting" as const : entry.revision === 1 ? "selected" as const : "application_pending" as const,
    kind: "branch" as const,
    question: payload.question,
    options: payload.options.map(option => Object.freeze({ id: option.id, label: option.label })),
    recommendation: payload.recommendation,
    rationale: payload.rationale,
    policy: payload.policy === null ? null : Object.freeze({
      id: payload.policy.id, version: payload.policy.version,
      afterMs: payload.policy.afterMs, deadline: payload.policy.deadline,
    }),
    openedAt: payload.opened_at,
    selected: entry.selected === null ? null : Object.freeze({
      option: entry.selected.option, actor: entry.selected.actor,
      commandId: entry.selected.commandId, at: entry.selected.at,
      ref: Object.freeze({ ...entry.selected.ref }),
    }),
    application: entry.application === null ? null : Object.freeze({
      commandId: entry.application.commandId,
      state: "unknown" as const,
      ref: Object.freeze({ ...entry.application.ref }),
      child: Object.freeze({
        session: entry.application.child.session,
        head: Object.freeze({ ...entry.application.child.head }),
        workspace: entry.application.child.workspace,
      }),
    }),
    alternateOf: payload.alternate_of === null ? null : Object.freeze({
      id: payload.alternate_of.id,
      selection: Object.freeze({ ...payload.alternate_of.selection }),
    }),
    citations: Object.freeze({
      open: entry.open.row.seq,
      selected: entry.selected?.ref.seq ?? null,
      application: entry.application?.ref.seq ?? null,
    }),
  });
}

/** Where a pure decision projection reads a retained evidence body: the exact
 * text of the blob, or undefined when the reader's source does not hold it
 * (the projection then refuses the row, fail-closed). */
export type RetainedDecisionBodyReader = (digest: string) => string | undefined;

export interface BranchDecisionProjection {
  readonly decisions: ReadonlyMap<string, DecisionSnapshot>;
  readonly references: readonly BranchDecisionReference[];
}

/** The pure decision projection: fold the rows, then verify every retained
 * authority the rows root — the authenticated checkpoint source bundle of
 * each open and the cold-verifiable child readiness bundle of each
 * application. Write-free; never evaluates a deadline or mints applied
 * state. A log that carries decision rows refuses without a retained reader. */
export function projectBranchDecisions(
  events: readonly EventRecord[],
  retained?: RetainedDecisionBodyReader,
): BranchDecisionProjection {
  const fold = foldBranchDecisions(events);
  const references = referencesOf(fold);
  if (references.length === 0) return { decisions: new Map(), references };
  if (retained === undefined) fail("branch_decision_retained_reader_required");
  for (const entry of fold.byId.values()) {
    verifyRetainedSourceByReader(events, entry.open.payload, retained, entry.open.row.seq);
    if (entry.application !== null) {
      verifyReadinessByReader(entry, retained);
    }
  }
  const decisions = new Map<string, DecisionSnapshot>();
  for (const [id, entry] of fold.byId) decisions.set(id, snapshotOf(entry));
  return { decisions, references };
}

function referencesOf(fold: DecisionFold): BranchDecisionReference[] {
  return fold.ordered.map(({ row, name }) => ({
    seq: row.seq,
    name,
    payloadDigest: sha256Hex(canonicalJson(row.payload)),
  }));
}

/** Ordered replay references use the same complete retained authority as reads. */
export function projectBranchDecisionReferences(events: readonly EventRecord[], retained?: RetainedDecisionBodyReader): BranchDecisionReference[] {
  return [...projectBranchDecisions(events, retained).references];
}

/** Replay preflight: the full retained-evidence verification over the
 * session's own blob store. Read-only; works on a cold preserved log. */
export function validateRecordedBranchDecisions(log: { readonly path: string; readonly events: readonly EventRecord[] }, suppliedStore?: BlobStore): void {
  if (!log.events.some(row => row.name.startsWith("decision/"))) return;
  const store = suppliedStore ?? BlobStore.forSession(log.path);
  projectBranchDecisions(log.events, digest => (store.has(digest) ? store.get(digest) : undefined));
}

// ---------------------------------------------------------------------------
// Retained-evidence verification, shared by the live service and the pure
// projection. Fail-closed on any missing or inconsistent body.
// ---------------------------------------------------------------------------

/** The child's recorded branch-context import must bind this decision's
 * source exactly — session, workspace, checkpoint source and retained
 * bundle — even when it carried zero candidates. A complete input and
 * workspace without that recorded binding is not admission authority. */
function requireBranchImportBinding(events: readonly EventRecord[], expected: {
  session: string;
  workspace: string;
  source: { session: string; checkpoint: string; digest: string; head: { seq: number; hash: string } };
  sourceBlob: string;
}): void {
  let row: EventRecord | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.name === "context/branch_import") {
      row = events[index]!;
      break;
    }
  }
  if (row === undefined) fail("branch_decision_child_import_missing");
  const parsed = branchImportRowSchema.safeParse(row.payload);
  if (!parsed.success) fail("branch_decision_child_import_invalid");
  const payload = parsed.data;
  if (payload.session !== expected.session || payload.workspace !== expected.workspace) {
    fail("branch_decision_child_import_binding");
  }
  if (!sameJson(payload.source, expected.source) || payload.source_blob !== expected.sourceBlob) {
    fail("branch_decision_child_import_binding");
  }
}

function verifyRetainedSourceByReader(events: readonly EventRecord[], payload: OpenPayload, read: RetainedDecisionBodyReader, openedSeq: number): void {
  // The recorded checkpoint ready row of THIS log must still bind the source
  // by id, digest and session, and the recorded source head must still name
  // an actual row — a valid foreign bundle alone is never authority here.
  const readyRow = events.find(row => row.name === "branch/checkpoint_ready"
    && row.payload.id === payload.source.checkpoint && row.payload.blob === payload.source.digest
    && row.payload.session === payload.source.session);
  if (readyRow === undefined) fail("branch_decision_source_row_missing");
  const headRow = events[payload.source.head.seq - 1];
  if (headRow === undefined || headRow.seq !== payload.source.head.seq || headRow.hash !== payload.source.head.hash) {
    fail("branch_decision_source_head_missing");
  }
  const text = read(payload.source_blob);
  if (text === undefined) fail("branch_decision_source_unavailable");
  // The exact bytes are checked against the recorded digest, length and the
  // shared bundle bound BEFORE anything decodes: a reader that substitutes
  // different bytes under the original digest refuses here.
  if (sha256Hex(text) !== payload.source_blob) fail("branch_decision_source_digest");
  if (Buffer.byteLength(text) !== payload.source_blob_bytes) fail("branch_decision_source_bytes");
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES) fail("branch_decision_source_bound");
  let bundle: unknown;
  try {
    bundle = JSON.parse(text);
  } catch {
    return fail("branch_decision_source_invalid");
  }
  if (canonicalJson(bundle) !== text) fail("branch_decision_source_noncanonical");
  let facts: ReturnType<typeof validateImportedCheckpointSource>;
  try {
    facts = validateImportedCheckpointSource(bundle);
  } catch {
    return fail("branch_decision_source_refused");
  }
  const retainedReady = (bundle as { events: EventRecord[] }).events.at(-1)!;
  if (readyRow.kind !== "observe" || readyRow.seq >= openedSeq
    || readyRow.seq !== retainedReady.seq || readyRow.hash !== retainedReady.hash) {
    fail("branch_decision_source_row_binding");
  }
  if (facts.sourceSession !== payload.session || facts.checkpointId !== payload.checkpoint.id
    || facts.checkpointDigest !== payload.checkpoint.digest || !sameJson(facts.head, payload.source.head)) {
    fail("branch_decision_source_binding");
  }
}

// Only the complete pure envelope result is memoized. Each caller still
// re-reads and authenticates current retained bytes and surrounding authority.
const READINESS_MEMO_ENTRIES = 8;
const READINESS_MEMO_BYTES = 32 * 1024 * 1024;
const readinessMemo = new Map<string, { text: string; binding: string; bytes: number }>();
let readinessMemoBytes = 0;

function rememberReadiness(key: string, text: string, binding: string): void {
  const bytes = Buffer.byteLength(text) + Buffer.byteLength(binding);
  if (bytes > READINESS_MEMO_BYTES) return;
  const previous = readinessMemo.get(key);
  if (previous !== undefined) {
    readinessMemoBytes -= previous.bytes;
    readinessMemo.delete(key);
  }
  while (readinessMemo.size >= READINESS_MEMO_ENTRIES || readinessMemoBytes + bytes > READINESS_MEMO_BYTES) {
    const oldest = readinessMemo.keys().next().value!;
    readinessMemoBytes -= readinessMemo.get(oldest)!.bytes;
    readinessMemo.delete(oldest);
  }
  readinessMemo.set(key, { text, binding, bytes });
  readinessMemoBytes += bytes;
}

function verifyReadinessByReader(entry: DecisionEntry, read: RetainedDecisionBodyReader): void {
  const intent = entry.application!.payload;
  const text = read(intent.blob);
  if (text === undefined) fail("branch_decision_readiness_unavailable");
  // The exact bytes are checked against the recorded digest, length and the
  // shared bundle bound BEFORE anything decodes: a reader that substitutes
  // different bytes under the original digest refuses here.
  if (sha256Hex(text) !== intent.blob) fail("branch_decision_readiness_digest");
  if (Buffer.byteLength(text) !== intent.blob_bytes) fail("branch_decision_readiness_bytes");
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES) fail("branch_decision_readiness_bound");
  const binding = readinessBindingOf(entry);
  const bindingText = canonicalJson(binding);
  const key = `${intent.blob}:${sha256Hex(bindingText)}`;
  const verified = readinessMemo.get(key);
  if (verified?.text === text && verified.binding === bindingText) {
    readinessMemo.delete(key);
    readinessMemo.set(key, verified);
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("branch_decision_readiness_invalid");
  }
  if (canonicalJson(value) !== text) fail("branch_decision_readiness_noncanonical");
  verifyRetainedBranchDecisionReadiness(value, binding);
  // The verifier is pure over carried bytes and this entire parent binding.
  // A failed parse, fold, body or binding check never reaches this store.
  rememberReadiness(key, text, bindingText);
}

function readinessBindingOf(entry: DecisionEntry): Parameters<typeof verifyRetainedBranchDecisionReadiness>[1] {
  const intent = entry.application!.payload;
  const payload = entry.open.payload;
  return {
    session: payload.session,
    id: payload.id,
    commandId: intent.command_id,
    fingerprint: intent.fingerprint,
    selection: {
      ref: entry.selected!.ref,
      option: entry.selected!.option,
      actor: entry.selected!.actor,
    },
    child: {
      session: intent.child.session,
      workspaceId: intent.child.workspace_id,
      head: intent.child.head,
      workspace: intent.child.workspace,
      resource: { root: intent.child.resource.root, owner: intent.child.resource.owner },
    },
    source: {
      session: payload.source.session,
      checkpoint: payload.source.checkpoint,
      digest: payload.source.digest,
      head: payload.source.head,
      blob: payload.source_blob,
      bytes: payload.source_blob_bytes,
    },
    blob: intent.blob,
    bytes: intent.blob_bytes,
  };
}

/** Cold-verify one retained child readiness bundle against the parent rows
 * that root it: the shared event-chain verifier, the exact body rules of an
 * authenticated source, the settlement pairing, the provider fold of the
 * imported child prefix, the re-derived context scope/goal/fit evidence, and
 * the workspace host's own retained-evidence verifier over the carried
 * bodies. Pure: no live filesystem, Git, model call, allocation or clock. */
export function verifyRetainedBranchDecisionReadiness(value: unknown, binding: {
  session: string;
  id: string;
  commandId: string;
  fingerprint: string;
  selection: { ref: { seq: number; hash: string }; option: string; actor: "human" | "policy" };
  child: {
    session: string;
    workspaceId: string;
    head: { seq: number; hash: string };
    workspace: string;
    resource: { root: string; owner: string };
  };
  source: { session: string; checkpoint: string; digest: string; head: { seq: number; hash: string }; blob: string; bytes: number };
  blob: string;
  bytes: number;
}): void {
  const parsed = branchDecisionReadinessSchema.safeParse(value);
  if (!parsed.success) fail("branch_decision_readiness_invalid");
  const bundle = parsed.data;
  const text = canonicalJson(bundle);
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES) fail("branch_decision_readiness_bound");
  if (sha256Hex(text) !== binding.blob || Buffer.byteLength(text) !== binding.bytes) {
    fail("branch_decision_readiness_digest");
  }
  // The chain from genesis, through the exact shared verifier the checkpoint
  // import source validation uses — never a weaker copied parser.
  const bySeq = verifySourceEventChain(bundle.events);
  const events = bundle.events as unknown as EventRecord[];
  const last = events.at(-1)!;
  if (bundle.child.head.seq !== events.length || last.seq !== events.length || last.hash !== bundle.child.head.hash) {
    fail("branch_decision_readiness_head");
  }
  // Every carried body is checked against its own digest and byte length,
  // exactly as stored, with no duplicate entry and no extra unvalidated
  // root: the carried set must be exactly what `collectReferencedBlobs`
  // roots over the child prefix. Nothing is dropped — the plain-text
  // surfaces stay as raw evidence for the readers below.
  const referenced = collectReferencedBlobs(events);
  const carried = new Map(bundle.bodies.map(entry => [entry.digest, entry] as const));
  if (carried.size !== bundle.bodies.length) fail("branch_decision_readiness_body_duplicate");
  if (carried.size !== referenced.size || [...referenced].some(digest => !carried.has(digest))) {
    fail("branch_decision_readiness_root_binding");
  }
  for (const entry of bundle.bodies) {
    if (sha256Hex(entry.text) !== entry.digest || Buffer.byteLength(entry.text) !== entry.bytes) {
      fail("branch_decision_readiness_body_digest");
    }
  }
  const rawBodies = new Map(bundle.bodies.map(entry => [entry.digest, entry.text] as const));
  // The canonical-JSON rule applies to the provider/import subset the folds
  // parse — the same exact verifier an authenticated source applies to its
  // bodies, over the subset it governs, never to arbitrary file bytes.
  const providerBodies: Array<{ digest: string; bytes: number; text: string }> = [];
  const providerDigests = new Set<string>();
  const claimProviderBody = (digest: string): void => {
    if (providerDigests.has(digest)) return;
    const entry = carried.get(digest);
    if (entry === undefined) fail("branch_decision_readiness_body_missing");
    providerDigests.add(digest);
    providerBodies.push({ digest: entry.digest, bytes: entry.bytes, text: entry.text });
  };
  for (const row of bySeq.values()) {
    if (!PROVIDER_BODY_EVENTS.has(row.name)) continue;
    if (typeof row.payload.blob !== "string") fail("branch_decision_readiness_body_missing");
    claimProviderBody(row.payload.blob);
    if (row.name === "provider/state") {
      const text = rawBodies.get(row.payload.blob)!;
      let body: { reason?: unknown; bundle?: { blob?: unknown } | null } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const nested = body !== null && typeof body === "object" && body.bundle !== null && typeof body.bundle === "object"
        ? body.bundle.blob : undefined;
      if (body?.reason === CHECKPOINT_IMPORT_REASON && typeof nested === "string") claimProviderBody(nested);
    }
  }
  const bodies = verifySourceBodies(providerBodies);
  // The settlement pairing of an authenticated source, not a last-response
  // heuristic: unanswered provider requests and unresolved tool effects
  // refuse here exactly as they refuse a checkpoint import source.
  assertSettledSourceEffects(events, bodies);
  let provider: ReturnType<typeof projectProviderInputs>;
  try {
    provider = projectProviderInputs(events, bodies);
  } catch {
    return fail("branch_decision_readiness_input_refused");
  }
  if (provider.state.pending !== undefined) fail("branch_decision_readiness_compaction_pending");
  // The context graph over the carried prefix: every imported candidate must
  // carry its recorded fit — an explicit ineligible/unknown state included —
  // and the scope/goal evidence must re-derive to what the bundle records.
  // The zero-candidate case is verified the same way, through the same
  // authority, with no candidate-count shortcut.
  let context: ReturnType<typeof projectContextGraph>;
  try {
    context = projectContextGraph(events, digest => rawBodies.get(digest));
  } catch {
    return fail("branch_decision_readiness_context_refused");
  }
  if (context.importedLessons.size > 0) {
    const fits = [...context.importedLessons.values()].map(state => ({
      lesson: state.id, verdict: state.fit?.row.verdict,
    }));
    if (fits.some(fit => fit.verdict === undefined)) fail("branch_decision_readiness_fit_incomplete");
    if (!sameJson(fits, bundle.context.fits)) fail("branch_decision_readiness_fit_binding");
  } else if (bundle.context.fits.length > 0) {
    fail("branch_decision_readiness_fit_binding");
  }
  if (context.repositoryId !== bundle.context.repository || (context.currentGoal ?? null) !== bundle.context.goal) {
    fail("branch_decision_readiness_scope");
  }
  // The recorded branch-context import must bind this decision's source
  // exactly, zero candidates included.
  requireBranchImportBinding(events, {
    session: bundle.child.session,
    workspace: bundle.child.workspace_id,
    source: {
      session: bundle.source.session, checkpoint: bundle.source.checkpoint,
      digest: bundle.source.digest, head: bundle.source.head,
    },
    sourceBlob: bundle.source.source_blob,
  });
  // Recorded child context frames must re-derive through the SAME frame
  // verifier replay uses — the exact row and bytes, never a copied check.
  try {
    const frames = verifyContextFrames(events,
      digest => rawBodies.get(digest), digest => rawBodies.get(digest));
    if (frames.mismatches.length > 0) fail("branch_decision_readiness_frame_mismatch");
  } catch {
    return fail("branch_decision_readiness_context_refused");
  }
  // The R8-03 shared branch-context authority over the carried prefix — the
  // same validator the live writer used: an active ready workspace, a valid
  // checkpoint input import receipt chain, and the provider fold over the
  // retained bodies.
  let authority: ReturnType<typeof validateBranchContextAuthority>;
  try {
    authority = validateBranchContextAuthority(events, {
      session: bundle.child.session, workspace: bundle.child.workspace_id,
      reader: digest => rawBodies.get(digest),
    });
  } catch {
    return fail("branch_decision_readiness_authority_refused");
  }
  const workspaceReady = authority.workspaceReady;
  if (!sameJson(workspaceReady, bundle.workspace)) fail("branch_decision_readiness_workspace_binding");
  // The workspace identity the intent recorded — resource root and owner
  // digest, the workspace path and the container's root inode identity —
  // must be exactly what the bundle carries and what the workspace's own
  // ready receipt recorded. A changed coordinate under the original blob
  // digest refuses here, not only in the caller's store.
  if (!sameJson(workspaceReady.root, bundle.child.root)) fail("branch_decision_readiness_child_binding");
  if (workspaceReady.workspace !== bundle.child.workspace
    || workspaceReady.resource.root !== bundle.child.resource.root
    || workspaceReady.resource.owner !== bundle.child.resource.owner) {
    fail("branch_decision_readiness_child_binding");
  }
  if (!sameJson(workspaceReady.source, {
    session: bundle.source.session, checkpoint: bundle.source.checkpoint,
    digest: bundle.source.digest, head: bundle.source.head,
  })) {
    fail("branch_decision_readiness_source_binding");
  }
  if (!sameJson(authority.importReady.source, workspaceReady.source)
    || authority.importReady.bundle.blob !== workspaceReady.source_blob) {
    fail("branch_decision_readiness_import_binding");
  }
  // The workspace host's own cold verifier over the carried bodies.
  const store: RetainedBodyStore = {
    get: digest => {
      const text = rawBodies.get(digest);
      if (text === undefined) throw new Error(`missing retained body ${digest}`);
      return text;
    },
  };
  try {
    verifyRetainedBranchWorkspace(events, store, workspaceReady, authority.workspaceRow.seq);
  } catch {
    return fail("branch_decision_readiness_workspace_refused");
  }
  // The parent-side bindings: the decision, the winning selection, the child
  // identity and the rooted blobs must all name exactly what the parent rows
  // recorded.
  if (bundle.decision.session !== binding.session || bundle.decision.id !== binding.id
    || bundle.decision.command_id !== binding.commandId || bundle.decision.fingerprint !== binding.fingerprint) {
    fail("branch_decision_readiness_decision_binding");
  }
  if (!sameJson(bundle.selection.ref, binding.selection.ref) || bundle.selection.option !== binding.selection.option
    || bundle.selection.actor !== binding.selection.actor || bundle.selection.revision !== 1) {
    fail("branch_decision_readiness_selection_binding");
  }
  if (bundle.child.session !== binding.child.session || bundle.child.workspace_id !== binding.child.workspaceId
    || !sameJson(bundle.child.head, binding.child.head)
    || bundle.child.workspace !== binding.child.workspace
    || bundle.child.resource.root !== binding.child.resource.root
    || bundle.child.resource.owner !== binding.child.resource.owner) {
    fail("branch_decision_readiness_child_binding");
  }
  if (bundle.source.session !== binding.source.session || bundle.source.checkpoint !== binding.source.checkpoint
    || bundle.source.digest !== binding.source.digest || !sameJson(bundle.source.head, binding.source.head)
    || bundle.source.source_blob !== binding.source.blob || bundle.source.source_blob_bytes !== binding.source.bytes) {
    fail("branch_decision_readiness_source_root");
  }
}

// ---------------------------------------------------------------------------
// The bound host-only service.
// ---------------------------------------------------------------------------

export interface BranchDecisionOptions {
  readonly log: EventLog;
  readonly sessionId: string;
  readonly checkpoints: BranchCheckpointService;
  /** Operator-authorized standing recommendation policy, frozen at
   * construction. Omission disables automatic selection everywhere,
   * including for decisions that recorded a policy. */
  readonly standingPolicy?: BranchDecisionStandingPolicy;
  /** Production clock; injectable for host tests only. */
  readonly now?: () => number;
}

export interface DecisionOpenRequest {
  readonly id: string;
  readonly commandId: string;
  readonly kind: "branch";
  readonly checkpointId: string;
  readonly checkpointDigest: string;
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly recommendation: string;
  readonly rationale: string;
  readonly alternateOf?: { readonly id: string; readonly selection: { readonly seq: number; readonly hash: string } } | null;
}

export interface DecisionSelectionRequest {
  readonly id: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly option?: string;
}

export interface DecisionApplicationRequest {
  readonly id: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly child: {
    readonly sessionId: string;
    readonly context: ContextGraphService;
    readonly workspace: BranchWorkspaceService;
    readonly workspaceId: string;
  };
}

export type SelectionOutcome = { readonly outcome: "selected" | "existing" | "conflict"; readonly decision: DecisionSnapshot };
export type ApplicationOutcome = { readonly outcome: "admitted" | "existing" | "conflict"; readonly decision: DecisionSnapshot };

export class BranchDecisionService {
  private readonly log: EventLog;
  private readonly sessionId: string;
  private readonly checkpoints: BranchCheckpointService;
  private readonly standingPolicy: BranchDecisionStandingPolicy | undefined;
  private readonly now: () => number;

  constructor(options: BranchDecisionOptions) {
    if (!options || typeof options !== "object") fail("branch_decision_configuration_invalid");
    if (!options.log || typeof options.log.path !== "string" || !Array.isArray(options.log.events)) {
      fail("branch_decision_configuration_invalid");
    }
    if (typeof options.sessionId !== "string" || options.sessionId.length === 0
      || Buffer.byteLength(options.sessionId) > SESSION_MAX) {
      fail("branch_decision_configuration_invalid");
    }
    if (!(options.checkpoints instanceof BranchCheckpointService)) {
      fail("branch_decision_configuration_invalid");
    }
    let standing: BranchDecisionStandingPolicy | undefined;
    if (options.standingPolicy !== undefined) {
      const parsed = standingPolicySchema.safeParse(options.standingPolicy);
      if (!parsed.success) fail("branch_decision_policy_invalid");
      standing = Object.freeze({ id: parsed.data.id, version: parsed.data.version, afterMs: parsed.data.afterMs });
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      fail("branch_decision_configuration_invalid");
    }
    this.log = options.log;
    this.sessionId = options.sessionId;
    this.checkpoints = options.checkpoints;
    this.standingPolicy = standing;
    this.now = options.now ?? (() => Date.now());
  }

  /** Open one immutable decision definition over an authenticated complete
   * retained checkpoint of this session. An exact confirmed repeat answers
   * from retained evidence with zero appends; a changed definition or a
   * reused command refuses. Appends nothing else and touches no workspace. */
  open(request: DecisionOpenRequest): DecisionSnapshot {
    const definition = this.validateOpenRequest(request);
    if (this.log.isReadOnly) fail("branch_decision_read_only");
    this.assertBinding();
    const fingerprint = openFingerprintOf(definition);

    // Idempotence first: an existing decision answers only for the exact
    // same command and definition, re-verifying its retained authority.
    const current = foldBranchDecisions(this.log.events);
    const existing = current.byId.get(definition.id);
    if (existing !== undefined) {
      const command = current.commands.get(definition.commandId);
      if (command === undefined || command.decision !== definition.id || command.fingerprint !== fingerprint
        || openFingerprintOf(existing.open.payload) !== fingerprint) {
        fail("branch_decision_definition_conflict");
      }
      this.verifyRetainedSource(existing);
      return snapshotOf(existing);
    }
    if (current.commands.has(definition.commandId)) fail("branch_decision_command_reuse");

    // The authenticated parent source: the existing checkpoint import
    // preparation is the sole authority; no new capture happens and the
    // parent tree is never read beyond the retained evidence.
    let prepared: ReturnType<typeof prepareCheckpointInputImport>;
    try {
      prepared = prepareCheckpointInputImport(this.log, this.sessionId, definition.checkpoint.id, definition.checkpoint.digest);
    } catch {
      return fail("branch_decision_source_refused");
    }
    let facts: ReturnType<typeof validateImportedCheckpointSource>;
    try {
      facts = validateImportedCheckpointSource(prepared);
    } catch {
      return fail("branch_decision_source_refused");
    }
    const bundleText = canonicalJson(prepared);
    const bundleDigest = BlobStore.forSession(this.log.path).put(bundleText);
    const source = {
      session: this.sessionId,
      checkpoint: definition.checkpoint.id,
      digest: definition.checkpoint.digest,
      head: { seq: facts.head.seq, hash: facts.head.hash },
    };

    let refusal: BranchDecisionError | undefined;
    this.log.appendBatchDurable(() => {
      // Every state, command and ancestry check re-runs inside the
      // cross-process append lock, against the folded catch-up. An ordinary
      // gate refusal captures into an empty batch — it never poisons the
      // writer; only corruption and persist failures fail closed.
      const fold = foldBranchDecisions(this.log.events);
      const race = fold.byId.get(definition.id);
      if (race !== undefined) {
        const command = fold.commands.get(definition.commandId);
        if (command === undefined || command.decision !== definition.id || command.fingerprint !== fingerprint
          || openFingerprintOf(race.open.payload) !== fingerprint) {
          refusal = new BranchDecisionError("branch_decision_definition_conflict");
        }
        return [];
      }
      if (fold.commands.has(definition.commandId)) {
        refusal = new BranchDecisionError("branch_decision_command_reuse");
        return [];
      }
      if (definition.alternate_of !== null) {
        const parent = fold.byId.get(definition.alternate_of.id);
        if (parent === undefined || parent.revision < 1 || parent.selected === null
          || !sameJson(parent.selected.ref, definition.alternate_of.selection)
          || parent.open.payload.checkpoint.id !== definition.checkpoint.id
          || parent.open.payload.checkpoint.digest !== definition.checkpoint.digest) {
          refusal = new BranchDecisionError("branch_decision_alternate_invalid");
          return [];
        }
      }
      const openedAt = this.now();
      return [{
        kind: "observe" as const,
        name: "decision/open",
        payload: {
          schema: BRANCH_DECISION_SCHEMA,
          session: this.sessionId,
          id: definition.id,
          command_id: definition.commandId,
          kind: "branch",
          fingerprint,
          checkpoint: { id: definition.checkpoint.id, digest: definition.checkpoint.digest },
          source,
          source_blob: bundleDigest,
          source_blob_bytes: Buffer.byteLength(bundleText),
          question: definition.question,
          options: definition.options.map(option => ({ id: option.id, label: option.label })),
          recommendation: definition.recommendation,
          rationale: definition.rationale,
          policy: this.standingPolicy === undefined ? null : {
            id: this.standingPolicy.id, version: this.standingPolicy.version,
            afterMs: this.standingPolicy.afterMs, deadline: openedAt + this.standingPolicy.afterMs,
          },
          alternate_of: definition.alternate_of,
          opened_at: openedAt,
        },
      }];
    });
    if (refusal !== undefined) throw refusal;
    return this.read(definition.id);
  }

  /** A human selection: races the durable revision under the append lock.
   * Exactly one awaiting revision becomes selected; a loser records a
   * conflict observation naming the current winner, and an exact retry of a
   * recorded command is read-only. */
  selectHuman(request: DecisionSelectionRequest): SelectionOutcome {
    const input = this.validateSelectionRequest(request, "human");
    if (this.log.isReadOnly) fail("branch_decision_read_only");
    this.assertBinding();
    return this.appendSelection(input.id, input.commandId, input.expectedRevision, input.option, "human");
  }

  /** The due standing policy: selects only the recorded recommendation, only
   * after the deadline the frozen construction policy implies, and only
   * while the current policy still equals the one recorded at open. Reads
   * never evaluate any of this. */
  selectDuePolicy(request: DecisionSelectionRequest): SelectionOutcome {
    const input = this.validateSelectionRequest(request, "policy");
    if (this.log.isReadOnly) fail("branch_decision_read_only");
    this.assertBinding();
    if (this.standingPolicy === undefined) fail("branch_decision_policy_absent");
    return this.appendSelection(input.id, input.commandId, input.expectedRevision, undefined, "policy");
  }

  private appendSelection(id: string, commandId: string, expectedRevision: number, option: string | undefined,
    actor: "human" | "policy"): SelectionOutcome {
    // The recorded option is fixed before the fingerprint: a policy response
    // always carries the decision's recorded recommendation, so the fold's
    // recomputation from the row can never mismatch.
    const current = foldBranchDecisions(this.log.events);
    const entry = current.byId.get(id);
    if (entry === undefined) fail("branch_decision_unknown");
    this.assertSelectionOption(entry, actor, option);
    const chosen = actor === "policy" ? entry.open.payload.recommendation : option!;
    const fingerprint = responseFingerprintOf({
      id, actor, option: chosen, expected_revision: expectedRevision,
    });
    // A confirmed command is read-only: it re-verifies the retained source
    // authority and answers from the recorded row without appending.
    const used = current.commands.get(commandId);
    if (used !== undefined) {
      if (used.decision !== id || used.fingerprint !== fingerprint) fail("branch_decision_command_reuse");
      this.verifyRetainedSource(entry);
      return {
        outcome: String(used.row.payload.disposition) === "selected" ? "existing" : "conflict",
        decision: snapshotOf(entry),
      };
    }
    this.verifyRetainedSource(entry);

    let refusal: BranchDecisionError | undefined;
    const appended = this.log.appendBatchDurable(() => {
      const fold = foldBranchDecisions(this.log.events);
      const fresh = fold.byId.get(id);
      if (fresh === undefined) {
        refusal = new BranchDecisionError("branch_decision_unknown");
        return [];
      }
      // The retained source authority must still hold under the lock.
      this.verifyRetainedSource(fresh);
      const taken = fold.commands.get(commandId);
      if (taken !== undefined) {
        if (taken.decision !== id || taken.fingerprint !== fingerprint) {
          refusal = new BranchDecisionError("branch_decision_command_reuse");
        }
        return [];
      }
      if (actor === "human" && (option === undefined || !fresh.members.has(option))) {
        refusal = new BranchDecisionError("branch_decision_option_invalid");
        return [];
      }
      if (actor === "policy") {
        const recorded = fresh.open.payload.policy;
        if (recorded === null) {
          refusal = new BranchDecisionError("branch_decision_policy_absent");
          return [];
        }
        if (this.standingPolicy === undefined || this.standingPolicy.id !== recorded.id
          || this.standingPolicy.version !== recorded.version || this.standingPolicy.afterMs !== recorded.afterMs) {
          refusal = new BranchDecisionError("branch_decision_policy_revoked");
          return [];
        }
        if (this.now() < recorded.deadline) {
          refusal = new BranchDecisionError("branch_decision_deadline_not_due");
          return [];
        }
      }
      const at = this.now();
      if (fresh.revision === 0 && fresh.selected === null) {
        if (expectedRevision !== 0) {
          refusal = new BranchDecisionError("branch_decision_revision_conflict");
          return [];
        }
        return [{
          kind: "observe" as const,
          name: "decision/response",
          payload: {
            schema: BRANCH_DECISION_SCHEMA, session: this.sessionId, id,
            command_id: commandId, fingerprint, expected_revision: expectedRevision,
            actor, option: chosen, at, disposition: "selected", selected_ref: null,
          },
        }];
      }
      // A valid loser: the fold keeps the winner immutable; this row only
      // observes the loss against the current winner.
      return [{
        kind: "observe" as const,
        name: "decision/response",
        payload: {
          schema: BRANCH_DECISION_SCHEMA, session: this.sessionId, id,
          command_id: commandId, fingerprint, expected_revision: expectedRevision,
          actor, option: chosen, at, disposition: "conflict", selected_ref: fresh.selected!.ref,
        },
      }];
    });
    if (refusal !== undefined) throw refusal;
    const folded = foldBranchDecisions(this.log.events);
    const finalEntry = folded.byId.get(id)!;
    const recorded = folded.commands.get(commandId)!;
    const newly = appended.some(row => row.name === "decision/response");
    return {
      outcome: String(recorded.row.payload.disposition) === "selected" ? (newly ? "selected" : "existing") : "conflict",
      decision: snapshotOf(finalEntry),
    };
  }

  /** Admit one application command for a selected decision. The full child
   * boundary — actual workspace ownership, the shared branch-context
   * authority, complete input import, settled effects, and a fresh normal
   * context prepare that records current scope/goal/fit — runs BEFORE the
   * parent intent, and the retained cold-verifiable evidence is durably
   * rooted before the row that names it. Only a newly admitted outcome is a
   * start grant; repeats are existing, other commands conflict. Nothing here
   * dispatches a model call or filesystem effect. */
  beginApplication(request: DecisionApplicationRequest): ApplicationOutcome {
    if (!request || typeof request !== "object") fail("branch_decision_request_invalid");
    const { id, commandId, expectedRevision, child } = request as Partial<DecisionApplicationRequest>;
    if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) fail("branch_decision_id_invalid");
    if (typeof commandId !== "string" || !COMMAND_ID_PATTERN.test(commandId)) fail("branch_decision_command_invalid");
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("branch_decision_revision_invalid");
    }
    if (!child || typeof child !== "object") fail("branch_decision_child_invalid");
    if (typeof child.sessionId !== "string" || child.sessionId.length === 0 || Buffer.byteLength(child.sessionId) > SESSION_MAX) {
      fail("branch_decision_child_invalid");
    }
    if (typeof child.workspaceId !== "string" || !CHECKPOINT_ID_PATTERN.test(child.workspaceId)) {
      fail("branch_decision_child_invalid");
    }
    if (!(child.workspace instanceof BranchWorkspaceService)) fail("branch_decision_child_service_invalid");
    if (!(child.context instanceof ContextGraphService)) fail("branch_decision_child_service_invalid");
    // The canonical arguments are validated before any recorded reply is
    // consulted: application admission targets revision 1 only.
    if (expectedRevision !== 1) fail("branch_decision_revision_conflict");
    if (this.log.isReadOnly) fail("branch_decision_read_only");
    this.assertBinding();
    const fingerprint = applicationFingerprintOf({
      id, child_session: child.sessionId, child_workspace_id: child.workspaceId, expected_revision: expectedRevision,
    });

    // Existing/unknown admission outcomes answer from the recorded intent:
    // an exact retry re-verifies retained readiness and never re-prepares
    // the child or renews the grant. A changed reuse of the same command id
    // refuses globally; a different new command id after the intent conflicts.
    const current = foldBranchDecisions(this.log.events);
    const entry = current.byId.get(id);
    if (entry === undefined) fail("branch_decision_unknown");
    const priorCommand = current.commands.get(commandId);
    if (priorCommand !== undefined && (priorCommand.decision !== id || priorCommand.fingerprint !== fingerprint)) {
      fail("branch_decision_command_reuse");
    }
    this.verifyRetainedSource(entry);
    if (entry.application !== null) {
      const decision = snapshotOf(entry);
      if (entry.application.commandId === commandId) {
        if (entry.application.payload.fingerprint !== fingerprint) fail("branch_decision_command_reuse");
        this.verifyRetainedReadiness(entry);
        return { outcome: "existing", decision };
      }
      return { outcome: "conflict", decision };
    }
    if (current.commands.has(commandId)) fail("branch_decision_command_reuse");
    if (entry.revision !== 1 || entry.selected === null) fail("branch_decision_not_selected");
    if (expectedRevision !== 1) fail("branch_decision_revision_conflict");
    this.verifyRetainedSource(entry);

    // The full live child boundary. Every check refuses before any parent
    // row lands; the fresh context prepare appends only to the CHILD log.
    const readiness = this.verifyChildBoundary(entry, child, commandId, fingerprint);

    let refusal: BranchDecisionError | undefined;
    const appended = this.log.appendBatchDurable(() => {
      const fold = foldBranchDecisions(this.log.events);
      const fresh = fold.byId.get(id);
      if (fresh === undefined) {
        refusal = new BranchDecisionError("branch_decision_unknown");
        return [];
      }
      // The retained source authority must still hold under the lock.
      this.verifyRetainedSource(fresh);
      const priorCommand = fold.commands.get(commandId);
      if (priorCommand !== undefined && (priorCommand.decision !== id || priorCommand.fingerprint !== fingerprint)) {
        refusal = new BranchDecisionError("branch_decision_command_reuse");
        return [];
      }
      if (fresh.application !== null) {
        // The lock already published a winner: this caller's outcome is
        // derived from it below, never a second grant.
        return [];
      }
      if (fresh.revision !== 1 || fresh.selected === null || !sameJson(fresh.selected.ref, entry.selected!.ref)) {
        refusal = new BranchDecisionError("branch_decision_selection_moved");
        return [];
      }
      // The final admission closure revalidates the current child head and
      // the live ownership of the recorded resource. No child append happens
      // while the parent lock is held — only reads.
      const cold = new EventLog(readiness.childLogPath, { readOnly: true });
      if (cold.lastSeq !== readiness.head.seq || cold.lastHash !== readiness.head.hash) {
        refusal = new BranchDecisionError("branch_decision_child_head_moved");
        return [];
      }
      const active = activeBranchWorkspaceReady(cold.events, child.sessionId, child.workspaceId);
      if (active === undefined) {
        refusal = new BranchDecisionError("branch_decision_child_workspace_inactive");
        return [];
      }
      try {
        verifyBranchWorkspaceLiveResource(active.payload);
      } catch {
        refusal = new BranchDecisionError("branch_decision_child_ownership_lost");
        return [];
      }
      return [{
        kind: "observe" as const,
        name: "decision/application_intent",
        payload: {
          schema: BRANCH_DECISION_SCHEMA,
          session: this.sessionId,
          id,
          command_id: commandId,
          fingerprint,
          expected_revision: 1,
          selection: fresh.selected.ref,
          option: fresh.selected.option,
          actor: fresh.selected.actor,
          child: {
            session: child.sessionId,
            workspace_id: child.workspaceId,
            workspace: readiness.descriptor.workspace,
            resource: { root: readiness.descriptor.resource.root, owner: readiness.descriptor.resource.owner },
            head: readiness.head,
          },
          blob: readiness.digest,
          blob_bytes: readiness.bytes,
          state: "unknown",
        },
      }];
    });
    if (refusal !== undefined) throw refusal;
    // Only a row THIS call appended is a start grant. An empty batch means
    // the lock already published a winner: the same recorded command is an
    // existing (never repeated) grant, anything else a conflict.
    if (!appended.some(row => row.name === "decision/application_intent")) {
      const folded = foldBranchDecisions(this.log.events);
      const fresh = folded.byId.get(id)!;
      return {
        outcome: fresh.application !== null && fresh.application.commandId === commandId
          && fresh.application.payload.fingerprint === fingerprint ? "existing" : "conflict",
        decision: snapshotOf(fresh),
      };
    }
    return { outcome: "admitted", decision: this.read(id) };
  }

  /** Verified read: the fold plus the retained authorities this session's
   * store still holds. Read never appends, starts a timer or evaluates a
   * deadline, and works on a read-only handle. */
  read(id: string): DecisionSnapshot {
    if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) fail("branch_decision_id_invalid");
    this.assertBinding();
    const fold = foldBranchDecisions(this.log.events);
    const entry = fold.byId.get(id);
    if (entry === undefined) fail("branch_decision_unknown");
    this.verifyRetainedSource(entry);
    if (entry.application !== null) this.verifyRetainedReadiness(entry);
    return snapshotOf(entry);
  }

  // --- private helpers ---

  private validateOpenRequest(request: DecisionOpenRequest): {
    id: string; commandId: string; kind: "branch";
    checkpoint: { id: string; digest: string };
    question: string; options: { id: string; label: string }[];
    recommendation: string; rationale: string;
    alternate_of: { id: string; selection: { seq: number; hash: string } } | null;
  } {
    if (!request || typeof request !== "object") fail("branch_decision_request_invalid");
    const { id, commandId, kind, checkpointId, checkpointDigest, question, recommendation, rationale } = request as Partial<DecisionOpenRequest>;
    if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) fail("branch_decision_id_invalid");
    if (typeof commandId !== "string" || !COMMAND_ID_PATTERN.test(commandId)) fail("branch_decision_command_invalid");
    if (kind !== "branch") fail("branch_decision_kind_invalid");
    if (typeof checkpointId !== "string" || !CHECKPOINT_ID_PATTERN.test(checkpointId)) fail("branch_decision_checkpoint_invalid");
    if (typeof checkpointDigest !== "string" || !DIGEST_PATTERN.test(checkpointDigest)) fail("branch_decision_checkpoint_invalid");
    if (typeof question !== "string" || question.length === 0 || question.length > MAX_QUESTION_CHARS) {
      fail("branch_decision_question_invalid");
    }
    if (typeof rationale !== "string" || rationale.length > MAX_RATIONALE_CHARS) fail("branch_decision_rationale_invalid");
    if (!Array.isArray(request.options) || request.options.length < MIN_OPTIONS || request.options.length > MAX_OPTIONS) {
      fail("branch_decision_options_invalid");
    }
    const options = request.options.map(option => {
      if (!option || typeof option !== "object") fail("branch_decision_options_invalid");
      if (typeof option.id !== "string" || !OPTION_ID_PATTERN.test(option.id)) fail("branch_decision_options_invalid");
      if (typeof option.label !== "string" || option.label.length === 0 || option.label.length > MAX_LABEL_CHARS) {
        fail("branch_decision_options_invalid");
      }
      return { id: option.id, label: option.label };
    });
    if (new Set(options.map(option => option.id)).size !== options.length) fail("branch_decision_options_invalid");
    if (typeof recommendation !== "string" || !OPTION_ID_PATTERN.test(recommendation)
      || !options.some(option => option.id === recommendation)) {
      fail("branch_decision_recommendation_invalid");
    }
    const rawAlternate = request.alternateOf ?? null;
    let alternate_of: { id: string; selection: { seq: number; hash: string } } | null = null;
    if (rawAlternate !== null && rawAlternate !== undefined) {
      if (typeof rawAlternate.id !== "string" || !CHECKPOINT_ID_PATTERN.test(rawAlternate.id)) {
        fail("branch_decision_alternate_invalid");
      }
      const selection = rawAlternate.selection;
      if (!selection || typeof selection !== "object" || typeof selection.seq !== "number"
        || !Number.isSafeInteger(selection.seq) || selection.seq <= 0
        || typeof selection.hash !== "string" || !DIGEST_PATTERN.test(selection.hash)) {
        fail("branch_decision_alternate_invalid");
      }
      alternate_of = { id: rawAlternate.id, selection: { seq: selection.seq, hash: selection.hash } };
    }
    // The credential guard runs before any append so a refused definition
    // never poisons the writer.
    try {
      assertNoSecrets({
        payload: { question, rationale, options } as unknown as Record<string, unknown>,
        name: "decision/open",
      });
    } catch {
      return fail("branch_decision_definition_guard");
    }
    return {
      id, commandId, kind: "branch",
      checkpoint: { id: checkpointId, digest: checkpointDigest },
      question, options, recommendation, rationale, alternate_of,
    };
  }

  private validateSelectionRequest(request: DecisionSelectionRequest, actor: "human" | "policy"): {
    id: string; commandId: string; expectedRevision: number; option?: string;
  } {
    if (!request || typeof request !== "object") fail("branch_decision_request_invalid");
    const { id, commandId, expectedRevision } = request as Partial<DecisionSelectionRequest>;
    if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) fail("branch_decision_id_invalid");
    if (typeof commandId !== "string" || !COMMAND_ID_PATTERN.test(commandId)) fail("branch_decision_command_invalid");
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("branch_decision_revision_invalid");
    }
    if (actor === "human") {
      if (typeof request.option !== "string" || !OPTION_ID_PATTERN.test(request.option)) {
        fail("branch_decision_option_invalid");
      }
      return { id, commandId, expectedRevision, option: request.option };
    }
    if (request.option !== undefined) fail("branch_decision_option_invalid");
    return { id, commandId, expectedRevision };
  }

  private assertSelectionOption(entry: DecisionEntry, actor: "human" | "policy", option: string | undefined): void {
    if (actor === "human") {
      if (option === undefined || !entry.members.has(option)) fail("branch_decision_option_invalid");
    } else if (option !== undefined && option !== entry.open.payload.recommendation) {
      fail("branch_decision_policy_option");
    }
  }

  private assertBinding(): void {
    this.log.refresh();
    if (projectSessionReplaySchemas(this.log.events).featureStart.get(BRANCH_DECISION_SCHEMA) === undefined) {
      fail("branch_decision_feature_generation");
    }
    const governing = governingSessionOf(this.log.events);
    if (governing === undefined || governing !== this.sessionId) fail("branch_decision_session_binding");
  }

  private verifyRetainedSource(entry: DecisionEntry): void {
    const store = BlobStore.forSession(this.log.path);
    verifyRetainedSourceByReader(this.log.events, entry.open.payload,
      digest => (store.has(digest) ? store.get(digest) : undefined), entry.open.row.seq);
  }

  private verifyRetainedReadiness(entry: DecisionEntry): void {
    const store = BlobStore.forSession(this.log.path);
    let text: string;
    try {
      text = store.get(entry.application!.payload.blob);
    } catch {
      return fail("branch_decision_readiness_unavailable");
    }
    if (Buffer.byteLength(text) !== entry.application!.payload.blob_bytes) fail("branch_decision_readiness_bytes");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return fail("branch_decision_readiness_invalid");
    }
    verifyRetainedBranchDecisionReadiness(value, readinessBindingOf(entry));
  }

  /** The complete live child boundary before any parent intent: the actual
   * workspace and context services, the shared branch-context authority, the
   * source binding to this decision's checkpoint, the settled-effects
   * pairing, the normal context prepare, and the bounded retained evidence
   * bundle built from the child's own recorded prefix. */
  private verifyChildBoundary(entry: DecisionEntry, child: DecisionApplicationRequest["child"],
    commandId: string, fingerprint: string): {
    descriptor: { workspace: string; resource: { root: string; owner: string } };
    head: { seq: number; hash: string };
    childLogPath: string;
    digest: string;
    bytes: number;
  } {
    if (child.context.mode !== "on") fail("branch_decision_child_mode_invalid");
    const childLog = child.context.log;
    if (!child.workspace.isBoundTo(childLog, child.sessionId)) fail("branch_decision_child_log_binding");
    if (childLog.path === this.log.path || childLog.isReadOnly) fail("branch_decision_child_log_invalid");
    childLog.refresh();
    if (governingSessionOf(childLog.events) !== child.sessionId) fail("branch_decision_child_session_binding");
    // The workspace's own live verification: ownership, retained evidence
    // and current containment all re-checked by its service.
    const descriptor = child.workspace.read(child.workspaceId);
    if (descriptor.session !== child.sessionId) fail("branch_decision_child_session_binding");
    if (child.context.workspaceRoot === undefined || child.context.workspaceRoot !== descriptor.workspace) {
      fail("branch_decision_child_root_mismatch");
    }
    // The R8-03 shared authority: active ready workspace, checkpoint input
    // import receipts and the provider fold over the retained child prefix.
    let authority: ReturnType<typeof validateBranchContextAuthority>;
    try {
      authority = validateBranchContextAuthority(childLog.events, {
        session: child.sessionId, workspace: child.workspaceId, reader: sessionRetainedReader(childLog.path),
      });
    } catch {
      return fail("branch_decision_child_authority_refused");
    }
    const workspaceReady = authority.workspaceReady;
    if (workspaceReady.workspace !== descriptor.workspace
      || workspaceReady.resource.root !== descriptor.resource.root
      || workspaceReady.resource.owner !== descriptor.resource.owner) {
      fail("branch_decision_child_resource_mismatch");
    }
    // The child's source must be EXACTLY the decision's selected parent
    // source — same parent session, checkpoint, digest and retained bundle.
    const decisionSource = entry.open.payload.source;
    if (workspaceReady.source.session !== decisionSource.session
      || workspaceReady.source.checkpoint !== decisionSource.checkpoint
      || workspaceReady.source.digest !== decisionSource.digest
      || workspaceReady.source_blob !== entry.open.payload.source_blob) {
      fail("branch_decision_child_source_mismatch");
    }
    // The recorded branch-context import must bind this decision's source
    // exactly — zero candidates included. A complete input and workspace
    // without that recorded binding is not admission authority.
    requireBranchImportBinding(childLog.events, {
      session: child.sessionId,
      workspace: child.workspaceId,
      source: {
        session: decisionSource.session, checkpoint: decisionSource.checkpoint,
        digest: decisionSource.digest, head: decisionSource.head,
      },
      sourceBlob: entry.open.payload.source_blob,
    });
    // Recorded child context frames must re-derive through the SAME frame
    // verifier replay uses; a corrupted frame refuses admission here.
    try {
      const store = BlobStore.forSession(childLog.path);
      const frames = verifyContextFrames(childLog.events,
        digest => (store.has(digest) ? store.get(digest) : undefined),
        digest => (store.has(digest) ? store.get(digest) : undefined));
      if (frames.mismatches.length > 0) fail("branch_decision_child_frame_mismatch");
    } catch {
      return fail("branch_decision_child_context_refused");
    }

    // The settled-effects pairing of the shared source verifier, and the
    // provider fold with no pending compaction.
    const bodies = this.childParsedBodies(childLog.path, childLog.events);
    try {
      assertSettledSourceEffects(childLog.events, bodies);
    } catch {
      return fail("branch_decision_child_unsettled");
    }
    let provider: ReturnType<typeof projectProviderInputs>;
    try {
      provider = projectProviderInputs(childLog.events, bodies);
    } catch {
      return fail("branch_decision_child_input_refused");
    }
    if (provider.state.pending !== undefined) fail("branch_decision_child_unsettled");

    // The normal context prepare boundary: it records the fresh tree, scope
    // and fit rows in the CHILD log before the prefix is captured. This is
    // not a model call; its frame decision belongs to the R8-05 dispatch
    // boundary and is never appended here.
    try {
      child.context.contribution().prepare({
        boundary: "initial",
        messages: provider.state.messages,
        profile: "branch-decision-admission",
        readerAuthorised: false,
      });
    } catch {
      return fail("branch_decision_child_context_refused");
    }
    childLog.refresh();
    let context: ReturnType<typeof projectContextGraph>;
    try {
      context = projectContextGraph(childLog.events, sessionRetainedReader(childLog.path));
    } catch {
      return fail("branch_decision_child_context_refused");
    }
    if (context.repositoryId === undefined) fail("branch_decision_child_scope_missing");
    const fits = [...context.importedLessons.values()].map(state => ({
      lesson: state.id, verdict: state.fit?.row.verdict,
    }));
    if (fits.some(fit => fit.verdict === undefined)) fail("branch_decision_child_fit_incomplete");
    const head = { seq: childLog.lastSeq, hash: childLog.lastHash };

    // The bounded retained evidence bundle: the child prefix and the exact
    // text of every retained body it references.
    const rawBodies = this.childRawBodies(childLog.path, childLog.events);
    const bundle: BranchDecisionReadiness = {
      version: 1,
      schema: BRANCH_DECISION_SCHEMA,
      decision: { session: this.sessionId, id: entry.open.payload.id, command_id: commandId, fingerprint },
      selection: { ref: entry.selected!.ref, revision: 1, option: entry.selected!.option, actor: entry.selected!.actor },
      child: {
        session: child.sessionId,
        workspace_id: child.workspaceId,
        workspace: descriptor.workspace,
        resource: { root: descriptor.resource.root, owner: descriptor.resource.owner },
        root: { ...workspaceReady.root },
        head,
      },
      source: {
        session: decisionSource.session,
        checkpoint: decisionSource.checkpoint,
        digest: decisionSource.digest,
        head: { ...decisionSource.head },
        source_blob: entry.open.payload.source_blob,
        source_blob_bytes: entry.open.payload.source_blob_bytes,
      },
      workspace: structuredClone(workspaceReady) as BranchWorkspaceReady,
      context: {
        repository: context.repositoryId,
        goal: context.currentGoal ?? null,
        fits: fits.map(fit => ({ lesson: fit.lesson, verdict: fit.verdict! })),
      },
      events: structuredClone(childLog.events) as unknown as BranchDecisionReadiness["events"],
      bodies: [...rawBodies.entries()].map(([digest, text]) => ({ digest, bytes: Buffer.byteLength(text), text })),
    };
    if (bundle.events.length > MAX_CHECKPOINT_IMPORT_EVENTS || bundle.bodies.length > MAX_CHECKPOINT_IMPORT_BODIES) {
      fail("branch_decision_readiness_bound");
    }
    const text = canonicalJson(bundle);
    if (Buffer.byteLength(text) > MAX_CHECKPOINT_IMPORT_BUNDLE_BYTES) fail("branch_decision_readiness_bound");
    const digest = sha256Hex(text);
    // The same cold contract must succeed before publishing any admission.
    verifyRetainedBranchDecisionReadiness(bundle, {
      session: this.sessionId, id: entry.open.payload.id, commandId, fingerprint,
      selection: { ref: entry.selected!.ref, option: entry.selected!.option, actor: entry.selected!.actor },
      child: { session: child.sessionId, workspaceId: child.workspaceId, workspace: descriptor.workspace,
        resource: descriptor.resource, head },
      source: { ...decisionSource, blob: entry.open.payload.source_blob, bytes: entry.open.payload.source_blob_bytes },
      blob: digest, bytes: Buffer.byteLength(text),
    });
    BlobStore.forSession(this.log.path).put(text);
    return { descriptor, head, childLogPath: childLog.path, digest, bytes: Buffer.byteLength(text) };
  }

  /** The parsed bodies the provider-input fold and the settlement pairing
   * read: every provider body of the child prefix plus the retained import
   * bundle an import state row roots. Plain-text surfaces are not parsed —
   * they stay in the bundle as raw evidence bytes. */
  private childParsedBodies(path: string, events: readonly EventRecord[]): Map<string, unknown> {
    const raw = this.childRawBodies(path, events);
    const bodies = new Map<string, unknown>();
    const parse = (digest: string): void => {
      if (bodies.has(digest)) return;
      const text = raw.get(digest);
      if (text === undefined) fail("branch_decision_child_body_unavailable");
      bodies.set(digest, JSON.parse(text));
    };
    for (const row of events) {
      if (!PROVIDER_BODY_EVENTS.has(row.name)) continue;
      if (typeof row.payload.blob !== "string") fail("branch_decision_child_body_unavailable");
      parse(row.payload.blob);
      if (row.name === "provider/state") readNestedImportBundle(row.payload.blob, digest => {
        parse(digest);
        return raw.get(digest)!;
      });
    }
    return bodies;
  }

  /** Every retained body the child prefix roots, captured through the ONE
   * ordinary collection primitive (payload.blob, payload.source_blob and
   * source_refs-qualified digests) — exactly the closure the cold verifier
   * re-derives, kept as exact raw bytes. Nothing is filtered by content. */
  private childRawBodies(path: string, events: readonly EventRecord[]): Map<string, string> {
    const store = BlobStore.forSession(path);
    const out = new Map<string, string>();
    for (const digest of collectReferencedBlobs(events)) {
      let text: string;
      try {
        text = store.get(digest);
      } catch {
        return fail("branch_decision_child_body_unavailable");
      }
      out.set(digest, text);
    }
    return out;
  }
}

function readNestedImportBundle(blob: string, read: (digest: string) => string): void {
  let body: unknown;
  try {
    body = JSON.parse(read(blob));
  } catch {
    return;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const state = body as { reason?: unknown; bundle?: { blob?: unknown } | null };
  if (state.reason !== CHECKPOINT_IMPORT_REASON) return;
  const nested = state.bundle !== null && typeof state.bundle === "object" ? state.bundle.blob : undefined;
  if (typeof nested === "string" && DIGEST_PATTERN.test(nested)) read(nested);
}
