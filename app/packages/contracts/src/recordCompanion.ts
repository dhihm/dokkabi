/**
 * Closed Record companion contracts (Dokkabi R6 / R5-04).
 *
 * One restricted native window inspects an exact retained record scope that
 * the authenticated main renderer reads. Everything crossing the owner ↔
 * main-registry ↔ companion IPC boundary is declared here: the logical scope,
 * the bounded view preferences, the frozen handoff tuple, the relayed
 * snapshot and the closed view actions.
 *
 * The companion renderer never receives credentials, connection bootstrap,
 * writer coordinator input, an arbitrary scope, or a raw IPC surface. The
 * main process authorizes by actual webContents identity and owner epochs,
 * never by renderer-provided values.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProviderWorkbenchRecord,
  ProviderWorkbenchRecordIndex,
  ProviderWorkbenchRecordVerification,
  WORKBENCH_RECORD_BODY_MAX_BYTES,
  WorkbenchRecordAsOf,
  WorkbenchRecordBodyExpected,
  WorkbenchRecordCursor,
} from "./provider.ts";
import { PresentationTokensConfigSchema } from "./presentation.ts";

// ---------------------------------------------------------------------------
// Logical scope
// ---------------------------------------------------------------------------

/**
 * The logical inspection scope: environment + thread + the actual provider
 * instance. Generation/prefix/hash identity lives inside the record results;
 * the scope alone names which source a companion is bound to.
 */
export const RecordCompanionScope = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
});
export type RecordCompanionScope = typeof RecordCompanionScope.Type;

/** Deterministic scope key: environment + thread + instance, never a page. */
export function recordCompanionScopeKey(scope: RecordCompanionScope): string {
  return JSON.stringify([
    scope.environmentId,
    scope.threadId,
    scope.providerInstanceId === null ? null : String(scope.providerInstanceId),
  ]);
}

// ---------------------------------------------------------------------------
// Bounded view preferences
// ---------------------------------------------------------------------------

/** A canonical byte offset inside one retained row. */
const RecordBodyOffset = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** The persisted/restorable view preferences of one scope. `bodyStart` is
 * the selected row's displayed byte-window start (bounded explorer); absent
 * means the row's first window. */
export const RecordCompanionViewPreferences = Schema.Struct({
  tab: Schema.Literals(["record", "decisions"]),
  pin: Schema.NullOr(WorkbenchRecordAsOf),
  after: Schema.NullOr(WorkbenchRecordCursor),
  selectedSeq: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e9 }))),
  bodyStart: Schema.optional(RecordBodyOffset),
});
export type RecordCompanionViewPreferences = typeof RecordCompanionViewPreferences.Type;

/** Sanitized companion window bounds (integers, clamped by the host). */
export const RecordCompanionWindowBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 4_096 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 2_560 })),
});
export type RecordCompanionWindowBounds = typeof RecordCompanionWindowBounds.Type;

/** One scope's persisted entry: view preferences plus last window bounds. */
export const RecordCompanionScopePreferences = Schema.Struct({
  view: RecordCompanionViewPreferences,
  bounds: Schema.NullOr(RecordCompanionWindowBounds),
});
export type RecordCompanionScopePreferences = typeof RecordCompanionScopePreferences.Type;

export const RECORD_COMPANION_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const RECORD_COMPANION_PREFERENCES_MAX_SCOPES = 256;

/** The durable preferences document (bounded, sanitized, atomically written). */
export const RecordCompanionPreferencesDocument = Schema.Struct({
  schemaVersion: Schema.Literal(RECORD_COMPANION_PREFERENCES_SCHEMA_VERSION),
  scopes: Schema.Record(Schema.String, RecordCompanionScopePreferences).check(
    Schema.isMaxProperties(RECORD_COMPANION_PREFERENCES_MAX_SCOPES),
  ),
});
export type RecordCompanionPreferencesDocument = typeof RecordCompanionPreferencesDocument.Type;

/** Longest preferences document the host will read or accept (bytes). */
export const RECORD_COMPANION_PREFERENCES_MAX_BYTES = 262_144;

// ---------------------------------------------------------------------------
// Placement state and the frozen handoff tuple
// ---------------------------------------------------------------------------

export const RecordCompanionPlacement = Schema.Literals([
  "docked",
  "opening",
  "detached",
  "docking",
  "closed",
]);
export type RecordCompanionPlacement = typeof RecordCompanionPlacement.Type;

/**
 * The transaction frozen when a handoff begins: the source descriptor
 * revision, the view revision and the presentation revision the owner
 * acknowledged. `ready` must acknowledge the same tuple; the owner commits
 * only that transaction; source updates during the handoff wait for the next
 * post-commit snapshot.
 */
export const RecordCompanionHandoff = Schema.Struct({
  descriptorRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  viewRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  presentationRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
});
export type RecordCompanionHandoff = typeof RecordCompanionHandoff.Type;

/** The typed machine state the owner renderer subscribes to. */
export const RecordCompanionPlacementState = Schema.Struct({
  companionId: Schema.String,
  scope: RecordCompanionScope,
  scopeKey: Schema.String,
  placement: RecordCompanionPlacement,
  revision: Schema.Int,
  ownerSenderId: Schema.Int,
  childSender: Schema.NullOr(Schema.Int),
  childReady: Schema.Boolean,
  childQuiesced: Schema.Boolean,
  handoff: Schema.NullOr(RecordCompanionHandoff),
  acknowledgedHandoff: Schema.NullOr(RecordCompanionHandoff),
  /**
   * Host-observed effective activity of the child (ready, detached, not
   * quiesced, natively visible/focused/not minimized). Absent means false.
   * Never asserted by the child; focus changes never touch `revision` or the
   * handoff tuple — they advance only `childActivityRevision` (absent = 0).
   */
  childActive: Schema.optional(Schema.Boolean),
  childActivityRevision: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  ),
});
export type RecordCompanionPlacementState = typeof RecordCompanionPlacementState.Type;

// ---------------------------------------------------------------------------
// Relayed snapshots (owner → registry → companion)
// ---------------------------------------------------------------------------

/** A bounded explanation string (inert text). */
const RecordCompanionReason = Schema.String.check(Schema.isMaxLength(2_048));

/**
 * The selected row's displayed byte window (bounded explorer). `text` is the
 * owner-validated UTF-8 decode of at most one 32 KiB range — never the whole
 * row, never raw base64. start/end are canonical byte offsets widened to the
 * enclosing character boundaries; the flags disclose omitted bytes before
 * and after the window and boundary widening. A window is range integrity
 * only, never a whole-record proof.
 */
export const RecordCompanionBodyWindow = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.Literal("pending"), requestedStart: RecordBodyOffset }),
  Schema.Struct({
    status: Schema.Literal("window"),
    row: WorkbenchRecordCursor,
    requestedStart: RecordBodyOffset,
    start: RecordBodyOffset,
    end: RecordBodyOffset,
    totalBytes: RecordBodyOffset,
    bodyDigest: WorkbenchRecordBodyExpected.fields.bodyDigest,
    text: Schema.String.check(Schema.isMaxLength(WORKBENCH_RECORD_BODY_MAX_BYTES)),
    startExtended: Schema.Boolean,
    endExtended: Schema.Boolean,
    leadingOmitted: Schema.Boolean,
    trailingOmitted: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: RecordCompanionReason }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: RecordCompanionReason }),
  Schema.Struct({ status: Schema.Literal("unsupported"), reason: RecordCompanionReason }),
]);
export type RecordCompanionBodyWindow = typeof RecordCompanionBodyWindow.Type;

/**
 * The explicit whole-record verification state of the selected row. `exact`
 * carries the server's streamed verdict, already bound by the owner to the
 * selected row, pin and descriptor; every other state proves nothing.
 */
export const RecordCompanionVerification = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    row: WorkbenchRecordCursor,
    asOf: WorkbenchRecordAsOf,
    expected: WorkbenchRecordBodyExpected,
  }),
  Schema.Struct({
    status: Schema.Literal("exact"),
    verification: ProviderWorkbenchRecordVerification,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    row: WorkbenchRecordCursor,
    reason: RecordCompanionReason,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    row: WorkbenchRecordCursor,
    reason: RecordCompanionReason,
  }),
]);
export type RecordCompanionVerification = typeof RecordCompanionVerification.Type;

/**
 * One validated projection for the companion: the R5 record result the
 * owner's authenticated query produced, plus the small closed metadata the
 * restricted renderer needs. `result.record` is the closed
 * ProviderWorkbenchRecord schema and `tokens` the safe normalized
 * PresentationConfig token block — never opaque values, so credential-shaped
 * objects, extra source metadata and executable CSS cannot cross. No bearer
 * token, endpoint, bootstrap, queued send or model input ever enters this
 * envelope.
 */
export const RecordCompanionSnapshot = Schema.Struct({
  companionId: Schema.String,
  scope: RecordCompanionScope,
  scopeKey: Schema.String,
  descriptorRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  viewRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  presentationRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  view: RecordCompanionViewPreferences,
  result: Schema.Union([
    Schema.Struct({ status: Schema.Literal("pending") }),
    Schema.Struct({
      status: Schema.Literal("view"),
      staleError: Schema.NullOr(Schema.String),
      record: ProviderWorkbenchRecord,
    }),
    Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
    Schema.Struct({ status: Schema.Literal("unsupported"), reason: Schema.String }),
    // Bounded explorer: one metadata page (no payload bytes), the selected
    // row's validated window and its explicit verification state.
    Schema.Struct({
      status: Schema.Literal("explorer"),
      staleError: Schema.NullOr(RecordCompanionReason),
      index: ProviderWorkbenchRecordIndex,
      body: RecordCompanionBodyWindow,
      verification: RecordCompanionVerification,
    }),
  ]),
  sourceLabel: Schema.String,
  theme: Schema.Struct({ dark: Schema.Boolean }),
  tokens: PresentationTokensConfigSchema,
});
export type RecordCompanionSnapshot = typeof RecordCompanionSnapshot.Type;

/** Overall relayed-JSON ceiling enforced by the host before forwarding. */
export const RECORD_COMPANION_SNAPSHOT_MAX_BYTES = 2 * 1_048_576;

// ---------------------------------------------------------------------------
// Closed view actions (companion → registry → owner)
// ---------------------------------------------------------------------------

/**
 * The complete action vocabulary the companion can express. It is closed:
 * first, next, pin, follow, select (a seq from the displayed page) and tab,
 * plus the bounded explorer's byte-window navigation of the selected row
 * (first/previous/next/last window, jump to a byte offset inside the row)
 * and explicit verify/cancel of the selected row. The companion can never
 * supply an arbitrary after/asOf/path/source/row; the owner resolves every
 * action against its own displayed page and selected descriptor.
 */
export const RecordCompanionViewAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("bodyFirst") }),
  Schema.Struct({ type: Schema.Literal("bodyPrevious") }),
  Schema.Struct({ type: Schema.Literal("bodyNext") }),
  Schema.Struct({ type: Schema.Literal("bodyLast") }),
  Schema.Struct({ type: Schema.Literal("bodyJump"), offset: RecordBodyOffset }),
  Schema.Struct({ type: Schema.Literal("verify") }),
  Schema.Struct({ type: Schema.Literal("cancelVerify") }),
  Schema.Struct({ type: Schema.Literal("first") }),
  Schema.Struct({ type: Schema.Literal("next") }),
  Schema.Struct({ type: Schema.Literal("pin") }),
  Schema.Struct({ type: Schema.Literal("follow") }),
  Schema.Struct({
    type: Schema.Literal("select"),
    seq: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1e9 })),
  }),
  Schema.Struct({ type: Schema.Literal("tab"), tab: Schema.Literals(["record", "decisions"]) }),
]);
export type RecordCompanionViewAction = typeof RecordCompanionViewAction.Type;

// ---------------------------------------------------------------------------
// IPC envelopes
// ---------------------------------------------------------------------------

/** Result of an owner open/reopen request. */
export const RecordCompanionOpenResultSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("opening"),
    companionId: Schema.String,
    state: RecordCompanionPlacementState,
  }),
  Schema.Struct({
    type: Schema.Literal("conflict"),
    message: Schema.String,
    existing: RecordCompanionPlacementState,
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type RecordCompanionOpenResult = typeof RecordCompanionOpenResultSchema.Type;

/** The owner's open/reopen request payload. */
export const RecordCompanionOpenInputSchema = Schema.Struct({
  scope: RecordCompanionScope,
  view: RecordCompanionViewPreferences,
  descriptorRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  viewRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
  presentationRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1e12 })),
});
export type RecordCompanionOpenInput = typeof RecordCompanionOpenInputSchema.Type;

/** The owner's relayed snapshot packet (schema-checked before forwarding). */
export const RecordCompanionRelayInputSchema = Schema.Struct({
  companionId: Schema.String,
  snapshot: RecordCompanionSnapshot,
});
export type RecordCompanionRelayInput = typeof RecordCompanionRelayInputSchema.Type;

/** Owner acknowledgement payloads (revision-CAS). */
export const RecordCompanionAckInputSchema = Schema.Struct({
  companionId: Schema.String,
  revision: Schema.Int,
});
export type RecordCompanionAckInput = typeof RecordCompanionAckInputSchema.Type;

/** The companion's bootstrap receipt: only what the restricted entry needs.
 *
 * It carries the machine's CURRENT revision and the frozen handoff tuple so
 * the child can acknowledge `ready` immediately — before any owner detach
 * ack — without guessing or polling. Without them the child could never
 * produce a valid ready and the owner would buffer snapshots forever (a
 * circular wait). */
export const RecordCompanionBootstrapSchema = Schema.Struct({
  companionId: Schema.String,
  scope: RecordCompanionScope,
  scopeKey: Schema.String,
  view: RecordCompanionViewPreferences,
  placement: RecordCompanionPlacement,
  sourceLabel: Schema.String,
  revision: Schema.Int,
  handoff: RecordCompanionHandoff,
});
export type RecordCompanionBootstrap = typeof RecordCompanionBootstrapSchema.Type;

/** The companion's ready/quiesce acknowledgement of the frozen tuple. */
export const RecordCompanionHandoffAckInputSchema = Schema.Struct({
  companionId: Schema.String,
  revision: Schema.Int,
  handoff: Schema.NullOr(RecordCompanionHandoff),
});
export type RecordCompanionHandoffAckInput = typeof RecordCompanionHandoffAckInputSchema.Type;

/** A companion view action with the revision it applies to. */
export const RecordCompanionViewActionInputSchema = Schema.Struct({
  companionId: Schema.String,
  viewRevision: Schema.Int,
  action: RecordCompanionViewAction,
});
export type RecordCompanionViewActionInput = typeof RecordCompanionViewActionInputSchema.Type;

/** Events the registry pushes to the owner renderer. */
export const RecordCompanionOwnerEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), state: RecordCompanionPlacementState }),
  Schema.Struct({
    type: Schema.Literal("childReady"),
    companionId: Schema.String,
    revision: Schema.Int,
    handoff: RecordCompanionHandoff,
    view: RecordCompanionViewPreferences,
  }),
  Schema.Struct({
    type: Schema.Literal("childQuiesced"),
    companionId: Schema.String,
    revision: Schema.Int,
    view: RecordCompanionViewPreferences,
  }),
  Schema.Struct({
    type: Schema.Literal("viewAction"),
    companionId: Schema.String,
    scopeKey: Schema.String,
    viewRevision: Schema.Int,
    action: RecordCompanionViewAction,
  }),
  Schema.Struct({
    type: Schema.Literal("snapshotRelayed"),
    companionId: Schema.String,
    scopeKey: Schema.String,
    viewRevision: Schema.Int,
  }),
]);
export type RecordCompanionOwnerEvent = typeof RecordCompanionOwnerEventSchema.Type;

/** Events the registry pushes to the companion renderer. */
export const RecordCompanionChildEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: RecordCompanionSnapshot }),
  Schema.Struct({ type: Schema.Literal("activated") }),
  Schema.Struct({ type: Schema.Literal("docking"), handoff: RecordCompanionHandoff }),
  Schema.Struct({ type: Schema.Literal("closed") }),
]);
export type RecordCompanionChildEvent = typeof RecordCompanionChildEventSchema.Type;

/**
 * The complete bridge the restricted companion preload exposes. It carries
 * no main DesktopBridge surface, no generic invoke, no eval/openURL,
 * settings, files, provider or terminal reach.
 */
export interface RecordCompanionBridge {
  bootstrap: () => Promise<RecordCompanionBootstrap>;
  ready: (input: RecordCompanionHandoffAckInput) => Promise<void>;
  quiesce: (input: RecordCompanionHandoffAckInput) => Promise<void>;
  requestDock: (input: RecordCompanionAckInput) => Promise<void>;
  viewAction: (input: RecordCompanionViewActionInput) => Promise<void>;
  onEvent: (listener: (event: RecordCompanionChildEvent) => void) => () => void;
}
