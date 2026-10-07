/**
 * Bounded per-scope Record companion preferences (Dokkabi R6).
 *
 * Persists ONLY versioned view preferences (tab/pin/after/selectedSeq) and
 * sanitized window bounds per logical scope, in the branded userData state
 * directory, through serialized atomic replacement (temp file + rename).
 * Raw records, credentials, sender identities, epochs and any live IPC
 * authority are never stored here.
 *
 * Durability discipline: one SynchronizedRef transaction covers candidate
 * validation, upsert, encode, the UTF-8 byte bound, the temp write and the
 * rename — the in-memory document commits ONLY when the rename succeeded,
 * so a failed write can never leave an uncommitted selection in memory that
 * a later write would silently persist. A document that fails the closed
 * schema refuses whole; the store then starts empty rather than splicing
 * partial state. Scope count is bounded with recency eviction, and startup
 * rejects an oversized file by its stat size before any byte is read.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  RECORD_COMPANION_PREFERENCES_MAX_BYTES,
  RECORD_COMPANION_PREFERENCES_MAX_SCOPES,
  RECORD_COMPANION_PREFERENCES_SCHEMA_VERSION,
  RecordCompanionPreferencesDocument,
  type RecordCompanionPreferencesDocument as PreferencesDocument,
  type RecordCompanionScopePreferences as ScopePreferences,
} from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export class RecordCompanionPreferencesError extends Schema.TaggedError<RecordCompanionPreferencesError>()(
  "RecordCompanionPreferencesError",
  {
    operation: Schema.Literals(["read", "encode", "write", "rename"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist Record companion preferences (${this.operation}) at ${this.path}.`;
  }
}

export const EMPTY_RECORD_COMPANION_PREFERENCES: PreferencesDocument = Object.freeze({
  schemaVersion: RECORD_COMPANION_PREFERENCES_SCHEMA_VERSION,
  scopes: {},
});

const decodeDocument = Schema.decodeUnknownSync(RecordCompanionPreferencesDocument, {
  onExcessProperty: "error",
});

// Plain JSON adapters kept OUTSIDE Effect context (the codebase convention:
// raw JSON stays in plain helpers, Effect bodies use schema codecs).
const parseDocumentText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const encodeDocumentText = (document: PreferencesDocument): string =>
  `${JSON.stringify(document)}\n`;

/** Strict decode of a full preferences value; invalid documents refuse whole. */
export function sanitizeRecordCompanionPreferencesDocument(
  value: unknown,
): PreferencesDocument | null {
  try {
    return decodeDocument(value);
  } catch {
    return null;
  }
}

/**
 * Upsert one scope's entry with recency eviction: re-inserting an existing
 * key refreshes its recency, and the oldest entry beyond the bound is
 * dropped so a long-lived installation cannot grow the file unbounded.
 */
export function upsertScopePreferences(
  document: PreferencesDocument,
  scopeKey: string,
  preferences: ScopePreferences,
): PreferencesDocument {
  const scopes: Record<string, ScopePreferences> = {};
  for (const [key, entry] of Object.entries(document.scopes)) {
    if (key !== scopeKey) scopes[key] = entry;
  }
  scopes[scopeKey] = preferences;
  const keys = Object.keys(scopes);
  while (keys.length > RECORD_COMPANION_PREFERENCES_MAX_SCOPES) {
    const oldest = keys.shift();
    if (oldest === undefined) break;
    delete scopes[oldest];
  }
  return { schemaVersion: document.schemaVersion, scopes };
}

export class RecordCompanionPreferences extends Context.Service<
  RecordCompanionPreferences,
  {
    /** A defensive copy of one scope's sanitized preferences, or null. */
    readonly scopeKeys: Effect.Effect<readonly string[]>;
    readonly getScope: (scopeKey: string) => Effect.Effect<ScopePreferences | null>;
    /** Upsert one scope's sanitized entry; commits only after durable rename. */
    readonly setScope: (
      scopeKey: string,
      preferences: ScopePreferences,
    ) => Effect.Effect<void, RecordCompanionPreferencesError>;
  }
>()("@t3tools/desktop/companion/RecordCompanionPreferences") {}

export interface RecordCompanionPreferencesStoreInput {
  /** Absolute path of the preferences file inside branded userData state. */
  readonly preferencesPath: string;
}

let writeCounter = 0;

const refused = (operation: "read" | "encode" | "write" | "rename", path: string, cause: unknown) =>
  new RecordCompanionPreferencesError({ operation, path, cause });

/**
 * Startup load. An absent file is empty preferences. A file whose stat size
 * already exceeds the byte bound is refused BEFORE it is read or decoded —
 * an oversized or hostile document never enters memory. A file that fails
 * the closed schema refuses whole, never partially.
 */
const loadInitialDocument = (
  input: RecordCompanionPreferencesStoreInput,
): Effect.Effect<PreferencesDocument, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(input.preferencesPath).pipe(Effect.option);
    if (Option.isNone(stat)) return EMPTY_RECORD_COMPANION_PREFERENCES;
    if (Number(stat.value.size) > RECORD_COMPANION_PREFERENCES_MAX_BYTES) {
      return EMPTY_RECORD_COMPANION_PREFERENCES;
    }
    const raw = yield* fileSystem.readFileString(input.preferencesPath).pipe(Effect.option);
    if (Option.isNone(raw)) return EMPTY_RECORD_COMPANION_PREFERENCES;
    const parsed = sanitizeRecordCompanionPreferencesDocument(parseDocumentText(raw.value));
    return parsed ?? EMPTY_RECORD_COMPANION_PREFERENCES;
  });

/** @public Service construction is part of the canonical Effect module API. */
export const makeStore = (input: RecordCompanionPreferencesStoreInput) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const documentRef = yield* SynchronizedRef.make(yield* loadInitialDocument(input));

    return RecordCompanionPreferences.of({
      scopeKeys: SynchronizedRef.get(documentRef).pipe(
        Effect.map((document) => Object.keys(document.scopes)),
      ),
      getScope: (scopeKey) =>
        SynchronizedRef.get(documentRef).pipe(
          Effect.map((document) => {
            const entry = document.scopes[scopeKey];
            // Defensive copy: a caller mutating its result can never change
            // what the store retains or later persists.
            return entry === undefined ? null : structuredClone(entry);
          }),
        ),
      setScope: (scopeKey, preferences) =>
        // One transaction: candidate + encode + durable rename, THEN commit.
        // Any failure keeps the previous in-memory document untouched, so a
        // refused write can never resurface through a later successful one.
        SynchronizedRef.modifyEffect(documentRef, (document) =>
          Effect.gen(function* () {
            const sanitized = sanitizeRecordCompanionPreferencesDocument({
              schemaVersion: RECORD_COMPANION_PREFERENCES_SCHEMA_VERSION,
              scopes: { [scopeKey]: preferences },
            });
            if (sanitized === null || sanitized.scopes[scopeKey] === undefined) {
              return yield* refused(
                "encode",
                input.preferencesPath,
                new Error(`refused unsanitized preferences for scope ${scopeKey}`),
              );
            }
            const candidate = upsertScopePreferences(
              document,
              scopeKey,
              sanitized.scopes[scopeKey]!,
            );
            const encoded = encodeDocumentText(candidate);
            if (Buffer.byteLength(encoded, "utf8") > RECORD_COMPANION_PREFERENCES_MAX_BYTES) {
              return yield* refused(
                "encode",
                input.preferencesPath,
                new Error(
                  `encoded document exceeds ${RECORD_COMPANION_PREFERENCES_MAX_BYTES} utf-8 bytes`,
                ),
              );
            }
            const directory = path.dirname(input.preferencesPath);
            writeCounter += 1;
            const tempPath = `${input.preferencesPath}.${process.pid}.${writeCounter}.tmp`;
            // Each durable step keeps its failure cause; the ref commits
            // only after every step succeeded.
            const made = yield* fileSystem
              .makeDirectory(directory, { recursive: true })
              .pipe(Effect.exit);
            const madeCause = Exit.match(made, {
              onSuccess: () => undefined,
              onFailure: (cause) => Cause.squash(cause),
            });
            if (madeCause !== undefined) return yield* refused("write", directory, madeCause);
            const written = yield* fileSystem.writeFileString(tempPath, encoded).pipe(Effect.exit);
            const writtenCause = Exit.match(written, {
              onSuccess: () => undefined,
              onFailure: (cause) => Cause.squash(cause),
            });
            if (writtenCause !== undefined) {
              yield* fileSystem.remove(tempPath).pipe(Effect.ignore);
              return yield* refused("write", tempPath, writtenCause);
            }
            const renamed = yield* fileSystem
              .rename(tempPath, input.preferencesPath)
              .pipe(Effect.exit);
            const renamedCause = Exit.match(renamed, {
              onSuccess: () => undefined,
              onFailure: (cause) => Cause.squash(cause),
            });
            if (renamedCause !== undefined) {
              // The temp file is garbage now; its absence is not an error.
              yield* fileSystem.remove(tempPath).pipe(Effect.ignore);
              return yield* refused("rename", input.preferencesPath, renamedCause);
            }
            return [undefined as void, candidate] as const;
          }),
        ),
    });
  });

export const layerFromInput = (
  input: RecordCompanionPreferencesStoreInput,
): Layer.Layer<RecordCompanionPreferences, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(RecordCompanionPreferences, makeStore(input));

/** Wired against the branded userData state directory in the desktop host. */
export const layerFromEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return layerFromInput({
      preferencesPath: environment.path.join(
        environment.stateDir,
        "record-companion-preferences.json",
      ),
    });
  }),
);
