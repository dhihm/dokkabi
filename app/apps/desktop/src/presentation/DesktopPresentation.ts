// @effect-diagnostics nodeBuiltinImport:off -- Operator home resolution needs platform path semantics (POSIX/Windows) before any Effect layer exists; artifacts are content-addressed with node:crypto.
/**
 * Dokkabi presentation host service (R1).
 *
 * The Electron main process owns presentation configuration I/O. This service
 * loads the shipped resource defaults, watches the operator's override file
 * (surviving atomic editor renames), validates whole candidates before
 * applying them, publishes monotonic revisions, keeps the last-valid
 * configuration across invalid edits, refuses persistent edits when the audit
 * writer is unavailable, retains validated config bytes as content-addressed
 * artifacts and applies native window minimums. It never reads project
 * presentation files and never touches model, kernel or session state.
 *
 * Every mutation — watch reload, save, reset — runs through one serialized
 * boundary (a SynchronizedRef modifier), and the disk read happens inside that
 * boundary so a pre-lock stale read can never overwrite a later save. Host
 * state is committed before any broadcast of it.
 */
import {
  PRESENTATION_CONFIG_MAX_BYTES,
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  canonicalPresentationConfigJson,
  decodePresentationOverrideText,
  mergePresentationConfig,
  validatePresentationConfig,
  type PresentationAppliedState,
  type PresentationConfig,
  type PresentationDocumentIssue,
  type PresentationOverride,
  type PresentationResetResult,
  type PresentationSaveInput,
  type PresentationSaveResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

const DEFAULT_DEBOUNCE_MS = 150;

export interface PresentationWindowIntegration {
  /**
   * Applies native minimum size to live windows without recreating them.
   * Optional: the Electron desktop routes native minimums through its window
   * service; tests inject a recorder.
   */
  readonly applyMinimums?: (minimums: {
    readonly width: number;
    readonly height: number;
  }) => Effect.Effect<void>;
  /**
   * Applies the current minimums to one registering window; a window created
   * after the last publish catches up when its renderer subscribes.
   */
  readonly applyMinimumsToSender?: (
    webContentsId: number,
    minimums: { readonly width: number; readonly height: number },
  ) => Effect.Effect<void>;
  /** Pushes an applied state to one registered renderer. */
  readonly pushState: (
    webContentsId: number,
    state: PresentationAppliedState,
  ) => Effect.Effect<void>;
  /** Whether a registered renderer is still alive; dead senders are dropped. */
  readonly isSenderAlive?: (webContentsId: number) => boolean;
}

export class DesktopPresentationInitError extends Schema.TaggedError<DesktopPresentationInitError>()(
  "DesktopPresentationInitError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class DesktopPresentation extends Context.Service<
  DesktopPresentation,
  {
    readonly getState: Effect.Effect<PresentationAppliedState>;
    /**
     * Re-reads the operator file and applies the outcome, refreshing the
     * observed-disk bookkeeping after conflicts or I/O errors, and reattaches
     * the configured-directory watch after a watcher failure, then returns
     * the current state.
     */
    readonly reload: Effect.Effect<PresentationAppliedState>;
    readonly save: (input: PresentationSaveInput) => Effect.Effect<PresentationSaveResult>;
    readonly reset: Effect.Effect<PresentationResetResult>;
    /** Stops the directory watcher; safe to call more than once. */
    readonly dispose: Effect.Effect<void>;
    /**
     * Main-process change subscription: every published applied state
     * (watch, save, reset) reaches the listener. Returns an unsubscribe.
     */
    readonly subscribeChanges: (
      listener: (state: PresentationAppliedState) => void,
    ) => Effect.Effect<() => void>;
    readonly registerTrustedSender: (webContentsId: number) => Effect.Effect<void>;
    readonly unregisterTrustedSender: (webContentsId: number) => Effect.Effect<void>;
    readonly isTrustedSender: (webContentsId: number) => boolean;
  }
>()("@t3tools/desktop/presentation/DesktopPresentation") {}

export interface LayerOptions {
  readonly configPath: string;
  readonly auditPath: string;
  /** Shipped resource defaults as JSON text; validated during startup. */
  readonly defaultsJson: string;
  /** Directory watch for external edits; tests may disable it. */
  readonly watch?: boolean;
  readonly debounceMs?: number;
  readonly maxFileBytes?: number;
  readonly windowIntegration?: PresentationWindowIntegration;
  /**
   * Test seam invoked after audit/artifact preparation and before the
   * final disk recheck + replace, so a save racing an external edit can be
   * exercised deterministically. Production never sets it.
   */
  readonly onPreparedBeforeReplace?: (configPath: string) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type DokkabiHomeResolution =
  | { readonly ok: true; readonly home: string }
  | { readonly ok: false; readonly reason: string };

/**
 * DOKKABI_HOME must be absolute when set, using platform path semantics
 * (POSIX root, Windows drive and UNC paths). An explicitly relative value is
 * a misconfiguration that fails visibly instead of silently falling back
 * into the operator's real ~/.dokkabi.
 */
export function resolveDokkabiHome(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly isAbsolute?: (path: string) => boolean;
}): DokkabiHomeResolution {
  const isAbsolute = input.isAbsolute ?? NodePath.isAbsolute;
  const configured = input.env.DOKKABI_HOME?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!isAbsolute(configured)) {
      return {
        ok: false,
        reason: `DOKKABI_HOME must be an absolute path, got "${configured}"`,
      };
    }
    return { ok: true, home: configured };
  }
  return { ok: true, home: `${input.homeDirectory.replace(/\/+$/, "")}/.dokkabi` };
}

export function resolvePresentationPaths(input: {
  readonly dokkabiHome: string;
  readonly joinPath: (first: string, ...segments: Array<string>) => string;
}): { readonly configPath: string; readonly auditPath: string } {
  return {
    configPath: input.joinPath(input.dokkabiHome, "desktop", "presentation.json"),
    auditPath: input.joinPath(input.dokkabiHome, "desktop", "presentation-audit.json"),
  };
}

/**
 * Fills the shipped defaults into a complete resolved configuration. Layout
 * must be complete in the resource file; optional token fields default to
 * "not overridden" (null).
 */
export function normalizeDefaultsDocument(document: PresentationOverride): PresentationConfig {
  const required = (value: number | undefined, field: string): number => {
    if (value === undefined) {
      throw new DesktopPresentationInitError({
        detail: `Shipped presentation defaults are missing ${field}.`,
        cause: new Error(`missing ${field}`),
      });
    }
    return value;
  };
  const layout = document.layout ?? {};
  return {
    schemaVersion: document.schemaVersion,
    tokens: {
      color: {
        background: document.tokens?.color?.background ?? null,
        surface: document.tokens?.color?.surface ?? null,
        text: document.tokens?.color?.text ?? null,
        muted: document.tokens?.color?.muted ?? null,
        border: document.tokens?.color?.border ?? null,
        accent: document.tokens?.color?.accent ?? null,
      },
      radius: {
        panel: document.tokens?.radius?.panel ?? null,
        control: document.tokens?.radius?.control ?? null,
      },
      spacing: { base: document.tokens?.spacing?.base ?? null },
      font: {
        family: document.tokens?.font?.family ?? null,
        familyMono: document.tokens?.font?.familyMono ?? null,
        sizePrompt: document.tokens?.font?.sizePrompt ?? null,
        sizeCode: document.tokens?.font?.sizeCode ?? null,
        lineHeight: document.tokens?.font?.lineHeight ?? null,
      },
      transition: { durationMs: document.tokens?.transition?.durationMs ?? null },
    },
    layout: {
      mainWindow: {
        minWidth: required(layout.mainWindow?.minWidth, "layout.mainWindow.minWidth"),
        minHeight: required(layout.mainWindow?.minHeight, "layout.mainWindow.minHeight"),
        defaultWidth: required(layout.mainWindow?.defaultWidth, "layout.mainWindow.defaultWidth"),
        defaultHeight: required(
          layout.mainWindow?.defaultHeight,
          "layout.mainWindow.defaultHeight",
        ),
      },
      navigation: {
        minWidth: required(layout.navigation?.minWidth, "layout.navigation.minWidth"),
        defaultWidth: required(layout.navigation?.defaultWidth, "layout.navigation.defaultWidth"),
        maxWidth: required(layout.navigation?.maxWidth, "layout.navigation.maxWidth"),
      },
      conversation: {
        minWidth: required(layout.conversation?.minWidth, "layout.conversation.minWidth"),
      },
      rightPanel: {
        minWidth: required(layout.rightPanel?.minWidth, "layout.rightPanel.minWidth"),
        defaultWidth: required(layout.rightPanel?.defaultWidth, "layout.rightPanel.defaultWidth"),
        maxWidth: required(layout.rightPanel?.maxWidth, "layout.rightPanel.maxWidth"),
      },
      // Graph layout is optional in shipped/default documents: an old v1
      // resource without the block inherits the one shared JSON defaults
      // (contracts), so the resolved config stays complete.
      graph: {
        direction: layout.graph?.direction ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS.direction,
        nodeWidth: layout.graph?.nodeWidth ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS.nodeWidth,
        nodeHeight: layout.graph?.nodeHeight ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS.nodeHeight,
        rankGap: layout.graph?.rankGap ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS.rankGap,
        siblingGap: layout.graph?.siblingGap ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS.siblingGap,
        canvasPadding:
          layout.graph?.canvasPadding ?? PRESENTATION_GRAPH_LAYOUT_DEFAULTS.canvasPadding,
      },
      // Record companion geometry follows the same rule (Dokkabi R6): an
      // old v1 document without the block inherits the shared defaults.
      recordCompanion: {
        defaultWidth:
          layout.recordCompanion?.defaultWidth ??
          PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS.defaultWidth,
        defaultHeight:
          layout.recordCompanion?.defaultHeight ??
          PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS.defaultHeight,
        minWidth:
          layout.recordCompanion?.minWidth ??
          PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS.minWidth,
        minHeight:
          layout.recordCompanion?.minHeight ??
          PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS.minHeight,
      },
      inlineBreakpoint: required(layout.inlineBreakpoint, "layout.inlineBreakpoint"),
    },
  };
}

const digestOfConfig = (config: PresentationConfig): string =>
  NodeCrypto.createHash("sha256").update(canonicalPresentationConfigJson(config)).digest("hex");

const loadDefaults = (
  defaultsJson: string,
): { readonly config: PresentationConfig; readonly digest: string } => {
  const decoded = decodePresentationOverrideText(defaultsJson);
  if (!decoded.ok) {
    const first = decoded.issues[0];
    throw new DesktopPresentationInitError({
      detail: `Shipped presentation defaults failed validation: ${first?.message ?? "unknown"}`,
      cause: new Error(first?.message ?? "unknown issue"),
    });
  }
  const config = normalizeDefaultsDocument(decoded.document);
  const issues = validatePresentationConfig(config);
  if (issues.length > 0) {
    throw new DesktopPresentationInitError({
      detail: `Shipped presentation defaults violate layout rules: ${issues[0]!.message}`,
      cause: new Error(issues[0]!.message),
    });
  }
  return { config, digest: digestOfConfig(config) };
};

interface AuditEntry {
  readonly at: string;
  readonly operation: "save" | "reset" | "watch";
  /** prepared = validated and about to mutate; the rest are final outcomes. */
  readonly outcome: "prepared" | "applied" | "defaults" | "invalid" | "failed" | "uncertain";
  readonly revision: number;
  readonly digest: string;
}

const AuditEntrySchema = Schema.Struct({
  at: Schema.String,
  operation: Schema.Literals(["save", "reset", "watch"]),
  outcome: Schema.Literals(["prepared", "applied", "defaults", "invalid", "failed", "uncertain"]),
  revision: Schema.Int,
  digest: Schema.String,
});

const encodeAuditEntryJson = Schema.encodeSync(Schema.fromJsonString(AuditEntrySchema));

/**
 * Discriminated identity of what is on disk: raw override bytes, no file, or
 * an I/O failure observation. Identities dedupe repeated observations (no
 * revision churn for unchanged disk state); save/compare (CAS) only ever
 * matches present or absent, so an I/O identity always forces a reload
 * before an overwrite. A sentinel string is never mixed into raw content
 * space, so a malformed file whose bytes happen to equal any sentinel still
 * recovers correctly after deletion.
 */
type DiskIdentity =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "io"; readonly message: string };

type DiskRead =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly text: string }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "oversize"; readonly bytes: number };

interface ServiceRuntime {
  readonly stateRef: SynchronizedRef.SynchronizedRef<PresentationAppliedState>;
  /** Identity of the disk content last observed, independent of validity. */
  lastObservedDisk: DiskIdentity | null;
  /** Native minimum side effects fire only on change. */
  lastPushedMinimums: { readonly width: number; readonly height: number } | null;
  /** Registered renderer senders with reference counts (StrictMode-safe). */
  readonly trustedSenders: Map<number, number>;
  /** Main-process listeners notified from publish, after state commit. */
  readonly changeListeners: Set<(state: PresentationAppliedState) => void>;
  /** The directory-watch fiber; interrupted by dispose and layer teardown. */
  watchFiber: Fiber.Fiber<void, never> | null;
  /** The visible diagnostic of a stopped watcher, until Reload reattaches. */
  watchDiagnostic: string | null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = (options: LayerOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const maxFileBytes = options.maxFileBytes ?? PRESENTATION_CONFIG_MAX_BYTES;
    const defaults = loadDefaults(options.defaultsJson);
    const configDirectory = path.dirname(options.configPath);
    const artifactDirectory = path.join(path.dirname(options.auditPath), "presentation-artifacts");
    const integration: PresentationWindowIntegration = options.windowIntegration ?? {
      applyMinimums: () => Effect.void,
      pushState: () => Effect.void,
    };

    const stateOf = (
      partial: Omit<PresentationAppliedState, "schemaVersion" | "revision" | "location">,
      revision: number,
    ): PresentationAppliedState => ({
      schemaVersion: defaults.config.schemaVersion,
      revision,
      location: options.configPath,
      ...partial,
    });

    const defaultsState = (revision: number): PresentationAppliedState =>
      stateOf(
        {
          digest: defaults.digest,
          status: "defaults",
          overrideDocument: null,
          override: null,
          config: defaults.config,
          error: null,
        },
        revision,
      );

    const runtime: ServiceRuntime = {
      stateRef: yield* SynchronizedRef.make(defaultsState(1)),
      lastObservedDisk: null,
      lastPushedMinimums: null,
      trustedSenders: new Map(),
      changeListeners: new Set(),
      watchFiber: null,
      watchDiagnostic: null,
    };

    // Host state is always committed (the modifier returns it) before this
    // broadcast runs.
    const publish = (state: PresentationAppliedState): Effect.Effect<void> =>
      Effect.gen(function* () {
        const minimums = {
          width: state.config.layout.mainWindow.minWidth,
          height: state.config.layout.mainWindow.minHeight,
        };
        const previous = runtime.lastPushedMinimums;
        if (
          previous === null ||
          previous.width !== minimums.width ||
          previous.height !== minimums.height
        ) {
          runtime.lastPushedMinimums = minimums;
          if (integration.applyMinimums !== undefined) {
            yield* integration.applyMinimums(minimums);
          }
        }
        for (const sender of runtime.trustedSenders.keys()) {
          if (integration.isSenderAlive !== undefined && !integration.isSenderAlive(sender)) {
            runtime.trustedSenders.delete(sender);
            continue;
          }
          yield* integration.pushState(sender, state);
        }
        for (const listener of runtime.changeListeners) {
          listener(state);
        }
      });

    const timestamp = Effect.map(DateTime.now, DateTime.formatIso);

    // The audit journal is append-only: entries are never rewritten,
    // truncated or reordered.
    const appendAudit = (entry: AuditEntry): Effect.Effect<void, string> =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(options.auditPath), { recursive: true });
        yield* fileSystem.writeFileString(options.auditPath, `${encodeAuditEntryJson(entry)}\n`, {
          flag: "a",
        });
      }).pipe(
        Effect.mapError(
          (error) => `failed to append the presentation audit entry: ${error.message}`,
        ),
        Effect.catchDefect((defect) =>
          Effect.fail(`failed to append the presentation audit entry: ${String(defect)}`),
        ),
      );

    /**
     * Retains the validated merged config bytes as a content-addressed
     * artifact. An existing digest-named artifact is verified against the
     * expected bytes and visibly repaired when corrupt; an unavailable or
     * unrepairable artifact store refuses the edit, so no applied revision
     * can reference unreconstructible bytes.
     */
    const writeArtifact = (config: PresentationConfig): Effect.Effect<string, string> => {
      const digest = digestOfConfig(config);
      const expected = canonicalPresentationConfigJson(config);
      const target = path.join(artifactDirectory, `${digest}.json`);
      const writeTarget = Effect.gen(function* () {
        yield* fileSystem.makeDirectory(artifactDirectory, { recursive: true });
        const tempPath = `${target}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
        yield* fileSystem.writeFileString(tempPath, expected);
        yield* fileSystem.rename(tempPath, target);
      }).pipe(
        Effect.mapError(
          (error) => `failed to retain the presentation config artifact: ${error.message}`,
        ),
        Effect.catchDefect((defect) =>
          Effect.fail(`failed to retain the presentation config artifact: ${String(defect)}`),
        ),
      );
      return Effect.gen(function* () {
        const exists = yield* fileSystem
          .exists(target)
          .pipe(
            Effect.mapError(
              (error) => `failed to retain the presentation config artifact: ${error.message}`,
            ),
          );
        if (exists) {
          const existing = yield* fileSystem.readFileString(target).pipe(
            Effect.mapError(
              (error) => `failed to retain the presentation config artifact: ${error.message}`,
            ),
            Effect.option,
          );
          if (Option.isSome(existing) && existing.value === expected) {
            return digest;
          }
          // Corrupt or unreadable content under this digest: repair it.
          yield* writeTarget;
          return digest;
        }
        yield* writeTarget;
        return digest;
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(`failed to retain the presentation config artifact: ${String(defect)}`),
        ),
      );
    };

    const atomicWriteOverride = (document: string): Effect.Effect<void, string> =>
      Effect.gen(function* () {
        const tempPath = `${options.configPath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
        yield* fileSystem.makeDirectory(configDirectory, { recursive: true });
        yield* fileSystem.writeFileString(tempPath, document);
        yield* fileSystem.rename(tempPath, options.configPath);
      }).pipe(
        Effect.mapError((error) => `failed to write the presentation override: ${error.message}`),
        Effect.catchDefect((defect) =>
          Effect.fail(`failed to write the presentation override: ${String(defect)}`),
        ),
      );

    /**
     * Whether the disk still carries the content the host last observed.
     * A check-plus-rename is not an OS-level atomic CAS against an arbitrary
     * uncooperative editor: the guarantee is bounded to content the host has
     * already observed (its own writes and applied external edits), shrinking
     * the race window to the final rename.
     */
    const diskObservationStatus = (): Effect.Effect<"match" | "changed" | "unverifiable"> =>
      readDisk().pipe(
        Effect.map((disk) => {
          const observed = runtime.lastObservedDisk;
          if (disk.kind === "present" && observed?.kind === "text") {
            return observed.text === disk.text ? ("match" as const) : ("changed" as const);
          }
          if (disk.kind === "absent" && observed?.kind === "absent") {
            return "match" as const;
          }
          if (disk.kind === "unreadable" || disk.kind === "oversize") {
            return "unverifiable" as const;
          }
          return "changed" as const;
        }),
      );

    const ioIssue = (message: string): PresentationDocumentIssue => ({
      kind: "io",
      message,
      path: null,
      line: null,
      column: null,
    });

    const errorMessage = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    /**
     * Bounded, discriminated disk read. The read itself is bounded (at most
     * maxFileBytes + 1 bytes through the handle), so a file that grows or is
     * replaced after any stat cannot blow past the limit. A missing file is
     * deletion; anything else is a visible I/O error. Effect 4 wraps the
     * system reason: ENOENT is reason._tag === "NotFound".
     */
    const readDisk = (): Effect.Effect<DiskRead> =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(options.configPath, { flag: "r" });
          // Read through EOF with a bounded total: a single readAlloc may
          // return a short chunk, which could hide an invalid suffix behind
          // a valid JSON prefix.
          const chunks: Array<Uint8Array> = [];
          let total = 0;
          for (;;) {
            const chunk = yield* handle.readAlloc(maxFileBytes + 1 - total);
            if (Option.isNone(chunk)) {
              const text = new TextDecoder("utf8", { fatal: false }).decode(Buffer.concat(chunks));
              return { kind: "present", text } as const;
            }
            const bytes = chunk.value;
            total += bytes.length;
            if (total > maxFileBytes) {
              return { kind: "oversize", bytes: total } as const;
            }
            chunks.push(bytes);
          }
        }),
      ).pipe(
        Effect.catch((error): Effect.Effect<DiskRead> => {
          const reason =
            error !== null &&
            typeof error === "object" &&
            "reason" in error &&
            error.reason !== null &&
            typeof error.reason === "object" &&
            "_tag" in error.reason
              ? (error.reason as { readonly _tag: string })._tag
              : null;
          if (reason === "NotFound") {
            return Effect.succeed({ kind: "absent" } as const);
          }
          return Effect.succeed({ kind: "unreadable", message: errorMessage(error) } as const);
        }),
      );

    /**
     * Whole-revision application of external file content. The disk read
     * itself runs inside the serialized mutation boundary so a stale pre-lock
     * read cannot overwrite a later save. The observed-disk identity is only
     * committed when processing succeeds: after a storage failure the same
     * content retries and recovers once storage returns. Every applied
     * revision retains its validated config bytes as an artifact before it
     * is published, and an audit I/O failure surfaces in the state instead
     * of producing a fake clean audit. Identical raw bytes never churn the
     * revision; different raw bytes advance it even at an equal config
     * digest, so changed editor/error metadata stays observable.
     */
    const applyExternalRead = (): Effect.Effect<PresentationAppliedState | null> =>
      SynchronizedRef.modifyEffect(runtime.stateRef, (current) =>
        Effect.gen(function* () {
          const disk = yield* readDisk();
          const identity: DiskIdentity =
            disk.kind === "absent"
              ? { kind: "absent" }
              : disk.kind === "present"
                ? { kind: "text", text: disk.text }
                : disk.kind === "unreadable"
                  ? { kind: "io", message: disk.message }
                  : { kind: "io", message: `oversize:${disk.bytes}` };
          const observed = runtime.lastObservedDisk;
          const sameIdentity =
            (identity.kind === "absent" && observed?.kind === "absent") ||
            (identity.kind === "text" &&
              observed?.kind === "text" &&
              observed.text === identity.text) ||
            (identity.kind === "io" &&
              observed?.kind === "io" &&
              observed.message === identity.message);
          if (sameIdentity) {
            return [null, current] as const;
          }

          const retainLastError = (
            issue: PresentationDocumentIssue,
          ): readonly [PresentationAppliedState, PresentationAppliedState] => {
            const state = stateOf(
              {
                digest: current.digest,
                status: "invalid",
                overrideDocument: current.overrideDocument,
                override: current.override,
                config: current.config,
                error: issue,
              },
              current.revision + 1,
            );
            return [state, state] as const;
          };

          if (disk.kind === "absent") {
            if (current.status === "defaults" && current.error === null) {
              runtime.lastObservedDisk = identity;
              return [null, current] as const;
            }
            const state = defaultsState(current.revision + 1);
            runtime.lastObservedDisk = identity;
            return [state, state] as const;
          }

          if (disk.kind === "unreadable") {
            const [state] = retainLastError(
              ioIssue(`the presentation file could not be read: ${disk.message}`),
            );
            runtime.lastObservedDisk = identity;
            return [state, state] as const;
          }

          if (disk.kind === "oversize") {
            const [state] = retainLastError(
              ioIssue(
                `the presentation file exceeds the ${maxFileBytes} byte limit (${disk.bytes} bytes read)`,
              ),
            );
            runtime.lastObservedDisk = identity;
            return [state, state] as const;
          }

          const decoded = decodePresentationOverrideText(disk.text);
          if (!decoded.ok) {
            const [state] = retainLastError(decoded.issues[0] ?? ioIssue("invalid document"));
            runtime.lastObservedDisk = identity;
            yield* appendAudit({
              at: yield* timestamp,
              operation: "watch",
              outcome: "invalid",
              revision: state.revision,
              digest: state.digest,
            }).pipe(Effect.ignore);
            return [state, state] as const;
          }

          const merged = mergePresentationConfig(defaults.config, decoded.document);
          const layoutIssues = validatePresentationConfig(merged);
          if (layoutIssues.length > 0) {
            const [state] = retainLastError(layoutIssues[0]!);
            runtime.lastObservedDisk = identity;
            return [state, state] as const;
          }

          // Retain the validated merged config bytes before publishing: an
          // applied revision is never published without its artifact. On
          // failure the identity stays uncommitted so the same content
          // retries once storage returns.
          const artifact = yield* writeArtifact(merged).pipe(Effect.result);
          if (Result.isFailure(artifact)) {
            const [state] = retainLastError(ioIssue(artifact.failure));
            return [state, state] as const;
          }

          // A different raw document always publishes a new revision: the
          // editor content and error metadata are observable state, even when
          // the resolved config digest is unchanged.
          const digest = digestOfConfig(merged);
          const auditFailure = yield* appendAudit({
            at: yield* timestamp,
            operation: "watch",
            outcome: "applied",
            revision: current.revision + 1,
            digest,
          }).pipe(Effect.result);
          const state = stateOf(
            {
              digest,
              status: "applied",
              overrideDocument: disk.text,
              override: decoded.document,
              config: merged,
              error: Result.isSuccess(auditFailure) ? null : ioIssue(auditFailure.failure),
            },
            current.revision + 1,
          );
          runtime.lastObservedDisk = identity;
          return [state, state] as const;
        }),
      );

    const reloadFromDisk = Effect.gen(function* () {
      const published = yield* applyExternalRead();
      if (published !== null) {
        yield* publish(published);
      }
    });

    // Cold start: ensure the operator directory exists, apply the initial
    // state (resource defaults, or the seeded file's outcome) and only then
    // arm the watcher, so no event races the initial read.
    yield* fileSystem.makeDirectory(configDirectory, { recursive: true }).pipe(Effect.ignore);
    yield* reloadFromDisk;

    const watchEnabled = options.watch !== false;

    /**
     * Publishes a stopped-watcher diagnostic through the ordinary state path:
     * a monotonic revision, the last-valid configuration retained, and a
     * visible I/O error. A watcher that died must never look like a healthy
     * subscription; intentional interruption (dispose, layer teardown)
     * publishes nothing.
     */
    const publishWatchStopped = (detail: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const message = `the presentation file watcher stopped: ${detail}`;
        runtime.watchDiagnostic = message;
        const published = yield* SynchronizedRef.modifyEffect(runtime.stateRef, (current) => {
          const state = stateOf(
            {
              digest: current.digest,
              status: "invalid",
              overrideDocument: current.overrideDocument,
              override: current.override,
              config: current.config,
              error: ioIssue(message),
            },
            current.revision + 1,
          );
          return Effect.succeed([state, state] as const);
        });
        yield* publish(published);
      });

    /**
     * Directory watch through the FileSystem service: atomic editor renames
     * surface as Create/Remove events on the config file name and I/O bursts
     * are debounced into one reload. The fiber is detached (no ambient scope)
     * and always interrupted by dispose; a non-interruption failure publishes
     * the stopped diagnostic above (no automatic retry — explicit Reload
     * reattaches).
     */
    const startWatch = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (runtime.watchFiber !== null) return;
        const watchedFile = path.basename(options.configPath);
        runtime.watchFiber = yield* fileSystem.watch(configDirectory).pipe(
          Stream.filter((event) => path.basename(event.path) === watchedFile),
          Stream.debounce(debounceMs),
          Stream.mapEffect(() => reloadFromDisk),
          Stream.runDrain,
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              runtime.watchFiber = null;
              const cause = Exit.getCause(exit);
              if (Option.isNone(cause) || Cause.hasInterruptsOnly(cause.value)) return;
              yield* publishWatchStopped(Cause.pretty(cause.value));
            }),
          ),
          Effect.forkDetach,
        );
      });

    if (watchEnabled) {
      yield* startWatch();
    }

    /**
     * One serialized mutation boundary for saves: validation, disk recheck,
     * audit preparation and the atomic write never interleave with a watch
     * reload or another save. The state is committed by the modifier before
     * the caller broadcasts it.
     */
    const save: DesktopPresentation["Service"]["save"] = (input) =>
      Effect.gen(function* () {
        const result = yield* SynchronizedRef.modifyEffect(
          runtime.stateRef,
          (current): Effect.Effect<readonly [PresentationSaveResult, PresentationAppliedState]> =>
            Effect.gen(function* () {
              if (input.expectedRevision !== current.revision) {
                const conflict: PresentationSaveResult = {
                  type: "conflict",
                  state: current,
                  message: `expected revision ${input.expectedRevision} but the applied revision is ${current.revision}; reload and retry`,
                };
                return [conflict, current] as const;
              }
              const documentBytes = Buffer.byteLength(input.document, "utf8");
              if (documentBytes > maxFileBytes) {
                const invalid: PresentationSaveResult = {
                  type: "invalid",
                  state: current,
                  issues: [
                    {
                      kind: "schema",
                      message: `presentation document is ${documentBytes} bytes, over the ${maxFileBytes} byte limit`,
                      path: null,
                      line: null,
                      column: null,
                    },
                  ],
                };
                return [invalid, current] as const;
              }
              const decoded = decodePresentationOverrideText(input.document);
              if (!decoded.ok) {
                const invalid: PresentationSaveResult = {
                  type: "invalid",
                  state: current,
                  issues: decoded.issues,
                };
                return [invalid, current] as const;
              }
              const merged = mergePresentationConfig(defaults.config, decoded.document);
              const layoutIssues = validatePresentationConfig(merged);
              if (layoutIssues.length > 0) {
                const invalid: PresentationSaveResult = {
                  type: "invalid",
                  state: current,
                  issues: layoutIssues,
                };
                return [invalid, current] as const;
              }

              // Recheck disk before preparing, comparing against the raw
              // bytes last observed (not the last-valid document): an
              // external edit the host has not published yet must not be
              // clobbered, while an observed invalid file stays repairable
              // by an explicit save.
              const preCheck = yield* diskObservationStatus();
              if (preCheck !== "match") {
                const conflict: PresentationSaveResult = {
                  type: "conflict",
                  state: current,
                  message:
                    preCheck === "unverifiable"
                      ? "the presentation file on disk cannot be verified right now; reload and retry"
                      : "the presentation file changed on disk after the last observed content; reload and reapply",
                };
                return [conflict, current] as const;
              }

              const nextRevision = current.revision + 1;
              const nextDigest = digestOfConfig(merged);

              // Fail closed: an unavailable audit writer (or artifact store)
              // refuses the edit before the override file is modified.
              const artifact = yield* writeArtifact(merged).pipe(Effect.result);
              if (Result.isFailure(artifact)) {
                const refused: PresentationSaveResult = {
                  type: "error",
                  state: current,
                  message: artifact.failure,
                };
                return [refused, current] as const;
              }
              const prepared = yield* appendAudit({
                at: yield* timestamp,
                operation: "save",
                outcome: "prepared",
                revision: nextRevision,
                digest: nextDigest,
              }).pipe(Effect.result);
              if (Result.isFailure(prepared)) {
                const refused: PresentationSaveResult = {
                  type: "error",
                  state: current,
                  message: prepared.failure,
                };
                return [refused, current] as const;
              }

              // Preparation is asynchronous; recheck the disk immediately
              // before replacing so an external edit that landed during it
              // conflicts here instead of being clobbered. (A check plus
              // rename, not an OS-level CAS: see diskObservationStatus.)
              if (options.onPreparedBeforeReplace !== undefined) {
                yield* options.onPreparedBeforeReplace(options.configPath);
              }
              const postCheck = yield* diskObservationStatus();
              if (postCheck !== "match") {
                yield* appendAudit({
                  at: yield* timestamp,
                  operation: "save",
                  outcome: "failed",
                  revision: nextRevision,
                  digest: nextDigest,
                }).pipe(Effect.ignore);
                const conflict: PresentationSaveResult = {
                  type: "conflict",
                  state: current,
                  message:
                    postCheck === "unverifiable"
                      ? "the presentation file on disk cannot be verified right now; reload and retry"
                      : "the presentation file changed on disk during the save; reload and reapply",
                };
                return [conflict, current] as const;
              }

              const write = yield* atomicWriteOverride(input.document).pipe(Effect.result);
              if (Result.isFailure(write)) {
                yield* appendAudit({
                  at: yield* timestamp,
                  operation: "save",
                  outcome: "failed",
                  revision: nextRevision,
                  digest: nextDigest,
                }).pipe(Effect.ignore);
                const refused: PresentationSaveResult = {
                  type: "error",
                  state: current,
                  message: write.failure,
                };
                return [refused, current] as const;
              }

              const state = stateOf(
                {
                  digest: nextDigest,
                  status: "applied",
                  overrideDocument: input.document,
                  override: decoded.document,
                  config: merged,
                  error: null,
                },
                nextRevision,
              );
              runtime.lastObservedDisk = { kind: "text", text: input.document };
              const outcome = yield* appendAudit({
                at: yield* timestamp,
                operation: "save",
                outcome: "applied",
                revision: nextRevision,
                digest: nextDigest,
              }).pipe(Effect.result);
              if (Result.isFailure(outcome)) {
                // The override write succeeded but its audit outcome could
                // not be recorded: an explicit incomplete outcome, never a
                // clean success.
                yield* appendAudit({
                  at: yield* timestamp,
                  operation: "save",
                  outcome: "uncertain",
                  revision: nextRevision,
                  digest: nextDigest,
                }).pipe(Effect.ignore);
                const uncertain: PresentationSaveResult = {
                  type: "uncertain",
                  state,
                  message: outcome.failure,
                };
                return [uncertain, state] as const;
              }
              const applied: PresentationSaveResult = { type: "applied", state };
              return [applied, state] as const;
            }),
        );
        if (result.type === "applied" || result.type === "uncertain") {
          yield* publish(result.state);
        }
        return result;
      });

    const reset: Effect.Effect<PresentationResetResult> = Effect.gen(function* () {
      const result = yield* SynchronizedRef.modifyEffect(
        runtime.stateRef,
        (current): Effect.Effect<readonly [PresentationResetResult, PresentationAppliedState]> =>
          Effect.gen(function* () {
            // Reset needs only the entry type, not the file's bytes: an
            // oversized (or unreadable) regular override is still removed.
            // A directory at the override path is never removed recursively.
            const entry = yield* fileSystem.stat(options.configPath).pipe(Effect.result);
            const entryKind = Result.isSuccess(entry)
              ? entry.success.type === "File"
                ? "file"
                : "other"
              : entry.failure !== null &&
                  typeof entry.failure === "object" &&
                  "reason" in entry.failure &&
                  entry.failure.reason !== null &&
                  typeof entry.failure.reason === "object" &&
                  "_tag" in entry.failure.reason &&
                  (entry.failure.reason as { readonly _tag: string })._tag === "NotFound"
                ? "absent"
                : "unknown";
            if (entryKind === "other") {
              const refused: PresentationResetResult = {
                type: "error",
                state: current,
                message: "the presentation override path is not a regular file; nothing was reset",
              };
              return [refused, current] as const;
            }
            if (entryKind === "unknown") {
              const refused: PresentationResetResult = {
                type: "error",
                state: current,
                message: "the presentation override file cannot be inspected; nothing was reset",
              };
              return [refused, current] as const;
            }
            if (entryKind === "absent" && current.status === "defaults" && current.error === null) {
              const applied: PresentationResetResult = { type: "applied", state: current };
              return [applied, current] as const;
            }

            const nextRevision = current.revision + 1;
            const artifact = yield* writeArtifact(defaults.config).pipe(Effect.result);
            if (Result.isFailure(artifact)) {
              const refused: PresentationResetResult = {
                type: "error",
                state: current,
                message: artifact.failure,
              };
              return [refused, current] as const;
            }
            const prepared = yield* appendAudit({
              at: yield* timestamp,
              operation: "reset",
              outcome: "prepared",
              revision: nextRevision,
              digest: defaults.digest,
            }).pipe(Effect.result);
            if (Result.isFailure(prepared)) {
              const refused: PresentationResetResult = {
                type: "error",
                state: current,
                message: prepared.failure,
              };
              return [refused, current] as const;
            }

            if (entryKind === "file") {
              const removed = yield* fileSystem.remove(options.configPath).pipe(
                Effect.mapError((error) => error.message),
                Effect.result,
              );
              if (Result.isFailure(removed)) {
                yield* appendAudit({
                  at: yield* timestamp,
                  operation: "reset",
                  outcome: "failed",
                  revision: nextRevision,
                  digest: defaults.digest,
                }).pipe(Effect.ignore);
                const refused: PresentationResetResult = {
                  type: "error",
                  state: current,
                  message: `failed to remove the presentation override file: ${removed.failure}`,
                };
                return [refused, current] as const;
              }
            }

            const state = defaultsState(nextRevision);
            runtime.lastObservedDisk = { kind: "absent" };
            const outcome = yield* appendAudit({
              at: yield* timestamp,
              operation: "reset",
              outcome: "defaults",
              revision: nextRevision,
              digest: defaults.digest,
            }).pipe(Effect.result);
            if (Result.isFailure(outcome)) {
              yield* appendAudit({
                at: yield* timestamp,
                operation: "reset",
                outcome: "uncertain",
                revision: nextRevision,
                digest: defaults.digest,
              }).pipe(Effect.ignore);
              const uncertain: PresentationResetResult = {
                type: "uncertain",
                state,
                message: outcome.failure,
              };
              return [uncertain, state] as const;
            }
            const applied: PresentationResetResult = { type: "applied", state };
            return [applied, state] as const;
          }),
      );
      if (result.type === "applied" || result.type === "uncertain") {
        yield* publish(result.state);
      }
      return result;
    });

    const dispose = Effect.gen(function* () {
      const fiber = runtime.watchFiber;
      runtime.watchFiber = null;
      if (fiber !== null) {
        yield* Fiber.interrupt(fiber);
      }
    });

    return DesktopPresentation.of({
      getState: SynchronizedRef.get(runtime.stateRef),
      reload: Effect.gen(function* () {
        yield* reloadFromDisk;
        // Explicit Reload recovery: reattach the watch on the one configured
        // directory after a watcher failure, and clear the stopped-watcher
        // diagnostic only once watching is armed again. No retry loop, and no
        // capability beyond the already-configured directory.
        if (watchEnabled && runtime.watchDiagnostic !== null) {
          const cleared = runtime.watchDiagnostic;
          runtime.watchDiagnostic = null;
          yield* startWatch();
          const published = yield* SynchronizedRef.modifyEffect(runtime.stateRef, (current) => {
            if (current.error?.message !== cleared) {
              return Effect.succeed([null, current] as const);
            }
            const state = stateOf(
              {
                digest: current.digest,
                status: current.overrideDocument === null ? "defaults" : "applied",
                overrideDocument: current.overrideDocument,
                override: current.override,
                config: current.config,
                error: null,
              },
              current.revision + 1,
            );
            return Effect.succeed([state, state] as const);
          });
          if (published !== null) {
            yield* publish(published);
          }
        }
        return yield* SynchronizedRef.get(runtime.stateRef);
      }),
      save,
      reset,
      dispose,
      subscribeChanges: (listener) =>
        Effect.sync(() => {
          runtime.changeListeners.add(listener);
          return () => {
            runtime.changeListeners.delete(listener);
          };
        }),
      registerTrustedSender: (webContentsId) =>
        Effect.gen(function* () {
          // Reference-counted so overlapping renderer subscriptions (React
          // StrictMode mounts, hot reloads) never cancel the newer one.
          const count = runtime.trustedSenders.get(webContentsId) ?? 0;
          runtime.trustedSenders.set(webContentsId, count + 1);
          // A window created after the last publish re-applies the current
          // minimums when its renderer subscribes.
          if (integration.applyMinimumsToSender !== undefined) {
            const state = yield* SynchronizedRef.get(runtime.stateRef);
            yield* integration.applyMinimumsToSender(webContentsId, {
              width: state.config.layout.mainWindow.minWidth,
              height: state.config.layout.mainWindow.minHeight,
            });
          }
        }),
      unregisterTrustedSender: (webContentsId) =>
        Effect.sync(() => {
          const count = runtime.trustedSenders.get(webContentsId) ?? 0;
          if (count <= 1) {
            runtime.trustedSenders.delete(webContentsId);
          } else {
            runtime.trustedSenders.set(webContentsId, count - 1);
          }
        }),
      isTrustedSender: (webContentsId) => runtime.trustedSenders.has(webContentsId),
    });
  });

export const layer = (
  options: LayerOptions,
): Layer.Layer<DesktopPresentation, never, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.acquireRelease(make(options), (service) => service.dispose).pipe(
      Effect.map((service) => Layer.succeed(DesktopPresentation, service)),
    ),
  );

/**
 * Environment resolution for {@link layerFromEnvironment}, kept as a plain
 * function: node:path stays a plain dependency outside Effect context.
 */
const resolveEnvironmentPaths = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}):
  | { readonly ok: true; readonly configPath: string; readonly auditPath: string }
  | { readonly ok: false; readonly reason: string } => {
  const resolution = resolveDokkabiHome(input);
  if (!resolution.ok) {
    return { ok: false, reason: resolution.reason };
  }
  const paths = resolvePresentationPaths({
    dokkabiHome: resolution.home,
    joinPath: NodePath.join,
  });
  return { ok: true, configPath: paths.configPath, auditPath: paths.auditPath };
};

/**
 * Resolves the operator's presentation paths from the environment. A relative
 * DOKKABI_HOME fails the layer visibly instead of writing into any real home.
 */
export const layerFromEnvironment = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly defaultsJson: string;
  readonly watch?: boolean;
  readonly windowIntegration?: PresentationWindowIntegration;
}): Layer.Layer<
  DesktopPresentation,
  DesktopPresentationInitError,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const resolved = resolveEnvironmentPaths(input);
      if (!resolved.ok) {
        return yield* new DesktopPresentationInitError({
          detail: resolved.reason,
          cause: new Error(resolved.reason),
        });
      }
      return layer({
        configPath: resolved.configPath,
        auditPath: resolved.auditPath,
        defaultsJson: input.defaultsJson,
        ...(input.watch === undefined ? {} : { watch: input.watch }),
        ...(input.windowIntegration === undefined
          ? {}
          : { windowIntegration: input.windowIntegration }),
      });
    }),
  );
