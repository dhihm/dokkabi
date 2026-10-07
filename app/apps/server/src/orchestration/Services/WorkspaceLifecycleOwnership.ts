/**
 * WorkspaceLifecycleOwnership — the shared workspace-lifecycle authority.
 *
 * One policy answers "who owns the recorded lifecycle of this filesystem
 * path / provider instance": the application, or an external harness (an
 * ENABLED provider instance whose adapter declares
 * `workspaceLifecycle: "harness"` and claims `workspaceRoots`). Every
 * worktree, checkpoint, background title-model, terminal and editor
 * mutation gate consults THIS service — never a scattered driver-name
 * check.
 *
 * Authority rules:
 * - Depends on `ProviderInstanceRegistry` (not ProviderService): ownership
 *   is decided from ENABLED instances' advertised capabilities, so a
 *   configured harness root is protected BEFORE the first session or Send.
 *   An instance that is disabled from the start (never admitted) reserves
 *   nothing; a root admitted while enabled STAYS protected by its durable
 *   lease after the instance is disabled, removed or reconfigured.
 * - Instance ownership is decided by the TARGET instance id (the thread's
 *   selected instance), available before any session starts.
 * - Paths are canonicalized with realpath; a not-yet-existing path resolves
 *   through its nearest existing ancestor. Only a genuinely missing path
 *   (ENOENT) falls back to the ancestor walk: permission/I/O failures and
 *   dangling symlinks FAIL CLOSED (refused), never silently
 *   application-owned. A claimed root must itself exist and resolve.
 * - Lookup or canonicalization failure fails closed for mutations: the
 *   error surfaces and the mutation must not run.
 * - Reads are never gated.
 *
 * @module orchestration/Services/WorkspaceLifecycleOwnership
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as NodePath from "node:path";

import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerConfig from "../../config.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";

export class WorkspaceOwnershipError extends Schema.TaggedError<WorkspaceOwnershipError>()(
  "WorkspaceOwnershipError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace ownership could not be established (failing closed): ${this.detail}`;
  }
}

export interface WorkspaceLifecycleOwnershipShape {
  /**
   * Canonicalized roots claimed by enabled harness adapters. Fails closed
   * when a claimed root is missing, unreadable or unresolvable.
   */
  readonly harnessOwnedRoots: Effect.Effect<ReadonlyArray<string>, WorkspaceOwnershipError>;
  /**
   * Instance-level ownership from the TARGET instance id — usable BEFORE a
   * session starts. An unknown or application instance is `false` (a fact,
   * not a lookup failure); only resolution errors fail closed.
   */
  readonly instanceIsHarnessOwned: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<boolean, WorkspaceOwnershipError>;
  /**
   * Path authority for mutations: true iff the canonicalized path is inside
   * (or equals) a root claimed by an enabled harness adapter. Fails closed
   * when the path or a claimed root cannot be canonicalized; dangling
   * symlinks refuse.
   */
  readonly pathIsHarnessOwned: (path: string) => Effect.Effect<boolean, WorkspaceOwnershipError>;
}

export class WorkspaceLifecycleOwnership extends Context.Service<
  WorkspaceLifecycleOwnership,
  WorkspaceLifecycleOwnershipShape
>()("t3/orchestration/Services/WorkspaceLifecycleOwnership") {}

const isNotFound = (error: unknown): boolean =>
  error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound";

const isWorkspaceOwnershipError = Schema.is(WorkspaceOwnershipError);

const isWithin = (parent: string, child: string): boolean => {
  const relative = NodePath.relative(parent, child);
  if (relative === "") return true;
  if (
    NodePath.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.posix.sep}`) ||
    relative.startsWith(`..${NodePath.sep}`)
  ) {
    return false;
  }
  return true;
};

/** Pure platform helpers over node:path — no Effect Path service needed. */
export const workspacePathHelpers = {
  isWithin,
  resolve: NodePath.resolve,
};

/**
 * Canonicalize a path for an ownership decision.
 *
 * - Existing path: its realpath (symlink aliases resolve INTO the claimed
 *   root, so they are protected).
 * - Missing path (ENOENT only): realpath of the nearest existing ancestor
 *   with the remainder appended.
 * - Dangling symlink (readLink succeeds, realpath ENOENT): REFUSED.
 * - Any other realPath/exists failure (permissions, I/O): surfaced, never
 *   treated as "missing".
 */
const canonicalizeForOwnership = (
  fileSystem: FileSystem.FileSystem,
  target: string,
  options: { readonly mustExist: boolean } = { mustExist: false },
): Effect.Effect<string, WorkspaceOwnershipError> => {
  const absolute = NodePath.resolve(target);
  return Effect.gen(function* () {
    // Existing path: its realpath (symlink aliases resolve INTO the claimed
    // root, so they are protected). Only ENOENT continues to the missing
    // path handling; every other failure (permissions, I/O) fails closed.
    const realpath = yield* fileSystem.realPath(absolute).pipe(
      Effect.map((resolved): string | null => resolved),
      Effect.catchIf(
        (error: unknown) => isNotFound(error),
        () => Effect.succeed<string | null>(null),
      ),
      Effect.mapError(
        (error: unknown) =>
          new WorkspaceOwnershipError({
            detail: `cannot resolve '${absolute}': ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          }),
      ),
    );
    if (realpath !== null) {
      return realpath;
    }
    if (options.mustExist) {
      // A claimed root is a configuration promise: it must exist and
      // resolve. No fallback and no silent un-claiming.
      return yield* new WorkspaceOwnershipError({
        detail: `claimed harness workspace root '${absolute}' does not exist`,
      });
    }
    // ENOENT: either genuinely missing, or a dangling symlink. A readable
    // link whose target is gone must refuse, not look safe.
    const isSymlink = yield* fileSystem.readLink(absolute).pipe(
      Effect.map((): boolean => true),
      Effect.catchIf(
        (error: unknown) => isNotFound(error),
        () => Effect.succeed(false),
      ),
      Effect.mapError(
        (error: unknown) =>
          new WorkspaceOwnershipError({
            detail: `cannot inspect '${absolute}' while resolving ownership`,
            cause: error,
          }),
      ),
    );
    if (isSymlink) {
      return yield* new WorkspaceOwnershipError({
        detail: `'${absolute}' is a dangling symlink (link target missing)`,
      });
    }
    // Genuinely missing: walk up to the nearest existing ancestor and
    // append the remainder. exists() failures surface — never "missing".
    const segments = absolute.split(NodePath.sep);
    for (let depth = segments.length; depth > 1; depth -= 1) {
      const ancestor = segments.slice(0, depth).join(NodePath.sep) || NodePath.sep;
      const ancestorExists = yield* fileSystem.exists(ancestor).pipe(
        Effect.mapError(
          (error: unknown) =>
            new WorkspaceOwnershipError({
              detail: `cannot inspect '${ancestor}' while resolving ownership of '${absolute}'`,
              cause: error,
            }),
        ),
      );
      if (!ancestorExists) continue;
      const canonicalAncestor = yield* fileSystem.realPath(ancestor).pipe(
        Effect.mapError(
          (error: unknown) =>
            new WorkspaceOwnershipError({
              detail: `cannot resolve ancestor '${ancestor}' of '${absolute}'`,
              cause: error,
            }),
        ),
      );
      const remainder = segments.slice(depth).join(NodePath.sep);
      return remainder.length > 0
        ? `${canonicalAncestor}${NodePath.sep}${remainder}`
        : canonicalAncestor;
    }
    return absolute;
  });
};

/**
 * Durable, strictly validated ownership leases.
 *
 * Once an enabled harness adapter's canonical root has been observed, a
 * settings change (disable/remove) cannot silently free it while a recorded
 * binding may still be live or unresolved: the root is RETAINED until a
 * later recorded reconciliation contract exists. There is deliberately NO
 * release API in R2 — an arbitrary string remove would be an unchecked
 * settlement release nobody can attest.
 *
 * Storage contract: a sibling-temp + rename atomic replacement of a strict
 * `{version:1, roots:string[]}` document (absolute, normalized, unique
 * canonical roots). Malformed content, a wrong version, extra fields or an
 * invalid root FAIL CLOSED — never an empty set, never a silent rewrite.
 * Only ENOENT legitimately starts empty. All reads/updates serialize under
 * one semaphore; a persistence failure refuses the ownership decision.
 * At load, every retained root must still canonically resolve to itself:
 * a missing or retargeted (symlink-swapped) root fails closed rather than
 * being silently dropped. A never-enabled adapter never creates a lease.
 */
interface OwnershipLeaseStore {
  readonly load: Effect.Effect<ReadonlyArray<string>, WorkspaceOwnershipError>;
  readonly recordAll: (
    roots: ReadonlyArray<string>,
  ) => Effect.Effect<void, WorkspaceOwnershipError>;
}

const makeLeaseStore = (
  leasePath: string,
  fileSystem: FileSystem.FileSystem,
  pathService: Path.Path,
  semaphore: Semaphore.Semaphore,
): OwnershipLeaseStore => {
  const invalid = (detail: string) =>
    new WorkspaceOwnershipError({
      detail: `workspace ownership lease file '${leasePath}' is invalid: ${detail}`,
    });

  /** Strict closed lease document: {version:1, roots:string[]} exactly. */
  const LeaseDocument = Schema.Struct({
    version: Schema.Literal(1),
    roots: Schema.Array(Schema.String),
  });
  // Excess fields are rejected at decode time: the annotate form does not
  // affect parsing, only real parse options do.
  const decodeLease = Schema.decodeUnknownSync(LeaseDocument, { onExcessProperty: "error" });
  const encodeLease = Schema.encodeSync(LeaseDocument);

  /**
   * Pure strict validation of a lease document. Throws WorkspaceOwnershipError
   * for malformed JSON, a wrong version, excess fields, a non-absolute or
   * non-normalized root, or a duplicate root — never a silent empty set and
   * never a silent rewrite.
   */
  const parseDocument = (text: string): ReadonlyArray<string> => {
    const document = decodeLease(JSON.parse(text) as unknown);
    const seen = new Set<string>();
    for (const entry of document.roots) {
      if (!NodePath.isAbsolute(entry) || NodePath.resolve(entry) !== entry) {
        throw invalid(`roots entry '${entry}' is not an absolute normalized path`);
      }
      if (seen.has(entry)) {
        throw invalid(`roots entry '${entry}' appears more than once`);
      }
      seen.add(entry);
    }
    return document.roots;
  };

  const readStrict = Effect.gen(function* () {
    const text: string | null = yield* fileSystem.readFileString(leasePath).pipe(
      Effect.map((value): string | null => value),
      Effect.catchIf(
        (error: unknown) => isNotFound(error),
        () => Effect.succeed<string | null>(null),
      ),
      Effect.mapError(
        (error: unknown) =>
          new WorkspaceOwnershipError({
            detail: `cannot read workspace ownership leases at '${leasePath}'`,
            cause: error,
          }),
      ),
    );
    if (text === null) {
      // Only ENOENT legitimately starts empty.
      return [];
    }
    const roots = yield* Effect.try({
      try: () => parseDocument(text),
      catch: (cause: unknown): WorkspaceOwnershipError =>
        isWorkspaceOwnershipError(cause)
          ? cause
          : invalid(cause instanceof Error ? cause.message : String(cause)),
    });
    // Every retained root must still BE its own canonical physical root.
    for (const root of roots) {
      const canonical = yield* canonicalizeForOwnership(fileSystem, root, { mustExist: true });
      if (canonical !== root) {
        return yield* invalid(`retained root '${root}' no longer resolves to itself (retargeted?)`);
      }
    }
    return roots;
  });

  /** Deterministic strict document rendering (no ad-hoc JSON in effect code). */
  const renderLease = (roots: ReadonlyArray<string>): string => {
    const document = encodeLease({ version: 1, roots: [...roots] });
    const entries = document.roots.map((root) => `    ${JSON.stringify(root)}`).join(",\n");
    return `{
  "version": ${JSON.stringify(document.version)},
  "roots": [
${entries}
  ]
}
`;
  };
  const writeStrict = (roots: ReadonlyArray<string>) =>
    writeFileStringAtomically({ filePath: leasePath, contents: renderLease(roots) }).pipe(
      Effect.mapError(
        (error: unknown) =>
          new WorkspaceOwnershipError({
            detail: `cannot persist workspace ownership leases at '${leasePath}'`,
            cause: error,
          }),
      ),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

  const store: OwnershipLeaseStore = {
    load: semaphore.withPermits(1)(readStrict),
    recordAll: (roots) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readStrict;
          const merged = [...new Set([...current, ...roots])];
          if (merged.length === current.length) return;
          yield* writeStrict(merged);
        }),
      ),
  };
  return store;
};

export const WorkspaceLifecycleOwnershipLive = Layer.effect(
  WorkspaceLifecycleOwnership,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const leaseLock = yield* Semaphore.make(1);
    const leaseStore = makeLeaseStore(
      NodePath.resolve(serverConfig.stateDir, "workspace-ownership-leases.json"),
      fileSystem,
      pathService,
      leaseLock,
    );

    /** Canonicalize and persist observed roots; a persistence failure refuses. */
    const recordRoots = (
      roots: ReadonlyArray<string>,
    ): Effect.Effect<void, WorkspaceOwnershipError> =>
      Effect.gen(function* () {
        const canonical: string[] = [];
        for (const root of roots) {
          canonical.push(yield* canonicalizeForOwnership(fileSystem, root, { mustExist: true }));
        }
        yield* leaseStore.recordAll(canonical);
      });

    /**
     * Instance ownership from the TARGET instance id — usable BEFORE a
     * session starts. When the instance IS harness-owned, its roots are
     * persisted BEFORE returning true: disabling immediately after the first
     * admission but before any path query must not skip persistence.
     */
    const instanceIsHarnessOwned: WorkspaceLifecycleOwnershipShape["instanceIsHarnessOwned"] = (
      instanceId,
    ) =>
      registry.getInstance(instanceId).pipe(
        Effect.flatMap((instance) => {
          if (instance === undefined || !instance.enabled) {
            return Effect.succeed(false);
          }
          if (instance.adapter.capabilities.workspaceLifecycle !== "harness") {
            return Effect.succeed(false);
          }
          const roots = instance.adapter.capabilities.workspaceRoots ?? [];
          if (roots.length === 0) {
            return Effect.succeed(true);
          }
          return Effect.as(recordRoots(roots), true);
        }),
        Effect.mapError(
          (cause) =>
            new WorkspaceOwnershipError({
              detail: `cannot resolve ownership of provider instance '${instanceId}'`,
              cause,
            }),
        ),
      );

    /**
     * Live roots from ENABLED instances: an enabled harness adapter's roots
     * must exist and resolve — a missing or unreadable claimed root is an
     * error, never a silent no-claim. Disabled instances contribute no live
     * roots, but roots they contributed while enabled remain in the durable
     * lease store below (retention, not release).
     */
    const liveHarnessRoots: Effect.Effect<
      ReadonlyArray<string>,
      WorkspaceOwnershipError
    > = registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(
          instances.flatMap((instance) =>
            instance.enabled && instance.adapter.capabilities.workspaceLifecycle === "harness"
              ? (instance.adapter.capabilities.workspaceRoots ?? [])
              : [],
          ),
          (root: string) => canonicalizeForOwnership(fileSystem, root, { mustExist: true }),
        ),
      ),
    );

    /**
     * Effective roots: live roots UNIONED with retained leases — a
     * disable/removal cannot free a root that was ever claimed (R2 has no
     * release API). New observations persist a lease BEFORE the decision
     * completes; a lease that cannot be persisted fails it closed.
     */
    const harnessOwnedRoots: Effect.Effect<
      ReadonlyArray<string>,
      WorkspaceOwnershipError
    > = liveHarnessRoots.pipe(
      Effect.flatMap((live) => Effect.andThen(leaseStore.recordAll(live), leaseStore.load)),
    );

    const pathIsHarnessOwned: WorkspaceLifecycleOwnershipShape["pathIsHarnessOwned"] = (target) =>
      harnessOwnedRoots.pipe(
        Effect.flatMap((roots) =>
          canonicalizeForOwnership(fileSystem, target).pipe(
            Effect.map((canonical) => roots.some((root) => isWithin(root, canonical))),
          ),
        ),
      );

    return {
      harnessOwnedRoots,
      instanceIsHarnessOwned,
      pathIsHarnessOwned,
    } satisfies WorkspaceLifecycleOwnershipShape;
  }),
);
