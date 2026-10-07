import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Position = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const SessionId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Ref = Schema.Struct({ seq: Position.check(Schema.isGreaterThanOrEqualTo(1)), hash: Digest });
export const CodeCursor = Schema.Struct({ seq: Position, hash: Digest, generation: Digest });
export const CodeSessionCursor = Schema.Struct({ sessionId: SessionId, ...CodeCursor.fields });
export type CodeSessionCursor = typeof CodeSessionCursor.Type;
export const CodeSelection = Schema.Struct({ ...Ref.fields, digest: Digest });
export type CodeSelection = typeof CodeSelection.Type;
export const CodeReference = Schema.Struct({ sessionId: SessionId, version: Ref, digest: Digest });
export const CodeVersionDescriptor = Schema.Struct({
  reference: CodeReference,
  bytes: Position.check(Schema.isLessThanOrEqualTo(8 * 1024 * 1024)),
  graphDigest: Digest,
});

/** Recorded producer metadata is optional for older gateways. Absence is
 * unknown, never evidence of an active observer. */
export const CodeObserverState = Schema.Struct({
  state: Schema.Literals(["off", "active", "paused"]),
  policyDigest: Schema.NullOr(Digest),
  paths: Position.check(Schema.isLessThanOrEqualTo(128)),
  checks: Position.check(Schema.isLessThanOrEqualTo(256)),
  revision: Schema.optional(Position),
  window: Schema.optional(Position),
  lifetimeChecks: Schema.optional(Position),
  retainedVersions: Schema.optional(Position),
  retainedBytes: Schema.optional(Position),
  watcher: Schema.optional(
    Schema.Struct({
      mode: Schema.Literal("selected_path_idle_poll"),
      intervalMs: Schema.Literal(5000),
      runtime: Schema.Literals(["started", "suspended", "stopped", "unavailable"]),
    }),
  ),
  reason: Schema.NullOr(
    Schema.Literals([
      "check_limit",
      "version_limit",
      "retention_bytes_limit",
      "source_refused",
      "capture_failed",
    ]),
  ),
}).check(
  Schema.makeFilter((value) => {
    const counters = [
      value.revision,
      value.window,
      value.lifetimeChecks,
      value.retainedVersions,
      value.retainedBytes,
    ];
    const legacy = counters.every((counter) => counter === undefined);
    return (
      ((value.state === "paused") === (value.reason !== null) &&
        (value.state === "off" || (value.policyDigest !== null && value.paths > 0)) &&
        (legacy
          ? value.watcher === undefined
          : counters.every((counter) => counter !== undefined) &&
            value.lifetimeChecks! >= value.checks)) ||
      "Recorded producer state is inconsistent"
    );
  }),
);
export type CodeObserverState = typeof CodeObserverState.Type;

export const CodeActionRequestFields = {
  operation: Schema.Literal("resume"),
  commandId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,80}$/u)),
  expectedRevision: Position,
  newWindow: Schema.optional(Schema.Boolean),
};
export const WorkbenchCodeActionResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("applied"),
    receipt: Schema.Struct({ commandId: CodeActionRequestFields.commandId, ...Ref.fields }),
    observer: CodeObserverState,
  }).check(
    Schema.makeFilter(
      (value) =>
        value.observer.revision !== undefined ||
        "Applied observer recovery requires recorded counters",
    ),
  ),
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literals(["unsupported", "unavailable", "busy", "conflict", "unknown"]),
    reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  }),
]);
export type WorkbenchCodeActionResponse = typeof WorkbenchCodeActionResponse.Type;
export const ProviderWorkbenchCodeActionInput = Schema.Unknown.check(
  Schema.makeFilter(
    (input) =>
      (typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).every(
          (key) => key === "threadId" || Object.hasOwn(CodeActionRequestFields, key),
        )) ||
      "Code observer actions cannot choose authority fields",
  ),
).pipe(Schema.decodeTo(Schema.Struct({ threadId: ThreadId, ...CodeActionRequestFields })));
export type ProviderWorkbenchCodeActionInput = typeof ProviderWorkbenchCodeActionInput.Type;
export const ProviderWorkbenchCodeActionResult = WorkbenchCodeActionResponse;
export type ProviderWorkbenchCodeActionResult = typeof ProviderWorkbenchCodeActionResult.Type;
export class ProviderWorkbenchCodeActionError extends Schema.TaggedError<ProviderWorkbenchCodeActionError>()(
  "ProviderWorkbenchCodeActionError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Failed to confirm Code observer recovery for thread ${this.threadId}.`;
  }
}

/** Retained canonical text is an opaque evidence body, not executable source.
 * Digest and UTF-8 byte bounds are verified at the adapter. Its graph decoding
 * belongs to the auxiliary presentation, never to the conversation reducer. */
export const WorkbenchCode = Schema.Struct({
  version: Schema.Literal(1),
  sessionCursor: CodeSessionCursor,
  gatewayCursor: CodeCursor,
  resnapshot: Schema.Boolean,
  changed: Schema.Boolean,
  observer: Schema.optional(CodeObserverState),
  versions: Schema.Array(CodeVersionDescriptor).check(Schema.isMaxLength(32)),
  body: Schema.NullOr(
    Schema.Struct({
      reference: CodeReference,
      text: Schema.String.check(Schema.isMaxLength(8 * 1024 * 1024)),
    }),
  ),
});
export type WorkbenchCode = typeof WorkbenchCode.Type;
export const ProviderWorkbenchCodeResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), code: WorkbenchCode }),
  Schema.Struct({ status: Schema.Literals(["unavailable", "unsupported"]), reason: Schema.String }),
]);
export type ProviderWorkbenchCodeResult = typeof ProviderWorkbenchCodeResult.Type;
export const ProviderGetWorkbenchCodeInput = Schema.Struct({
  threadId: ThreadId,
  after: Schema.optional(CodeSessionCursor),
  selection: Schema.optional(CodeSelection),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.after && input.selection) || "Select a body or acknowledge an index, not both",
  ),
);
export type ProviderGetWorkbenchCodeInput = typeof ProviderGetWorkbenchCodeInput.Type;
export const ProviderSubscribeWorkbenchCodeInput = Schema.Struct({
  threadId: ThreadId,
  after: CodeSessionCursor,
});
export class ProviderWorkbenchCodeError extends Schema.TaggedError<ProviderWorkbenchCodeError>()(
  "ProviderWorkbenchCodeError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Failed to read retained code versions for thread ${this.threadId}.`;
  }
}
