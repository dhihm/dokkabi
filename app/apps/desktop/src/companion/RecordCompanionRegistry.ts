/**
 * Main-process Record companion registry (Dokkabi R6 / R5-04).
 *
 * Owns, per owner window and logical scope, one pure RecordCompanionMachine
 * plus its restricted native child window. The registry is the ONLY bridge
 * between the authenticated owner renderer and the restricted companion:
 * snapshots flow owner → registry → child as asynchronous view messages, and
 * closed view actions flow child → registry → owner. The child never sees a
 * credential, a connection, a main bridge or an arbitrary scope.
 *
 * Authorization is by actual identity at every edge:
 * - Owner methods arrive from the IPC layer with a sender the layer already
 *   verified to be the current main window; the registry additionally keys
 *   every machine by that owner webContents id (the owner epoch), so a new
 *   main window can never steer a predecessor's companion.
 * - Companion methods resolve the record by the actual sender webContents id
 *   and call the machine's assertCompanionSender — a stale child from before
 *   a close, dock commit or failed opening is refused forever.
 *
 * Handoff transactions freeze the descriptor/view/presentation revision
 * tuple at open; the child's ready acknowledges exactly it; source updates
 * arriving mid-handoff are held as pending and applied only after the owner
 * commits. An opening that times out, fails to load or crashes rolls back to
 * the docked placement and revokes the provisional child.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import {
  RECORD_COMPANION_SNAPSHOT_MAX_BYTES,
  RecordCompanionBootstrapSchema,
  RecordCompanionChildEventSchema,
  RecordCompanionOwnerEventSchema,
  RecordCompanionPlacementState,
  RecordCompanionSnapshot,
  recordCompanionScopeKey,
  type RecordCompanionBootstrap,
  type RecordCompanionChildEvent,
  type RecordCompanionHandoff,
  type RecordCompanionOpenInput,
  type RecordCompanionOpenResult,
  type RecordCompanionOwnerEvent,
  type RecordCompanionPlacementState as PlacementState,
  RecordCompanionScope,
  type RecordCompanionSnapshot as Snapshot,
  type RecordCompanionViewAction,
  type RecordCompanionViewPreferences,
} from "@t3tools/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopPresentation from "../presentation/DesktopPresentation.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { getDesktopOrigin } from "../electron/ElectronProtocol.ts";
import * as Preferences from "./RecordCompanionPreferences.ts";
import { RecordCompanionMachine } from "./RecordCompanionMachine.ts";
import {
  RECORD_COMPANION_ENTRY_PATH,
  RECORD_COMPANION_PARTITION,
  isBlockedCompanionDevelopmentPath,
  makeCompanionContentSecurityPolicy,
  serveCompanionAsset,
  withCompanionContentSecurityPolicy,
} from "./companionAssets.ts";
import {
  RECORD_COMPANION_OWNER_EVENT_CHANNEL,
  RECORD_COMPANION_CHILD_EVENT_CHANNEL,
} from "../ipc/channels.ts";

const OPENING_TIMEOUT_MS = 20_000;
const GEOMETRY_PERSIST_DEBOUNCE_MS = 500;

const { logWarning } = makeComponentLogger("record-companion-registry");

export class RecordCompanionRegistryError extends Schema.TaggedError<RecordCompanionRegistryError>()(
  "RecordCompanionRegistryError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Record companion registry refused the operation: ${this.reason}`;
  }
}

/** Canonical snapshot text: relay dedup and the byte bound share one encoding. */
const snapshotText = (snapshot: Snapshot): string => `${JSON.stringify(snapshot)}`;

const decodeSnapshotStrict = Schema.decodeUnknownSync(RecordCompanionSnapshot, {
  onExcessProperty: "error",
});
const encodeOwnerEvent = Schema.encodeUnknownSync(RecordCompanionOwnerEventSchema);
const encodeChildEvent = Schema.encodeUnknownSync(RecordCompanionChildEventSchema);

interface CompanionRecord {
  readonly companionId: string;
  readonly machine: RecordCompanionMachine;
  readonly ownerSenderId: number;
  ownerWindow: Electron.BrowserWindow;
  child: Electron.BrowserWindow | null;
  readonly handoff: RecordCompanionHandoff;
  view: RecordCompanionViewPreferences;
  viewRevision: number;
  sourceLabel: string;
  pendingSnapshot: Snapshot | null;
  lastRelayedJson: string | null;
  openingTimeout: Fiber.Fiber<void, never> | undefined;
  geometryFiber: Fiber.Fiber<void, never> | undefined;
  closing: boolean;
  /** Last live bounds; captured before close/destroy so persistence never erases geometry. */
  cachedBounds: { x: number; y: number; width: number; height: number } | null;
  /** The latest validated inspected tuple (descriptor stays the frozen Open one). */
  latestTuple: RecordCompanionHandoff;
  /** The webContents id bound at attach; cleanup outlives the machine's revocation. */
  boundChildSender: number | null;
  /** Owner-epoch listeners this record registered; removed on drop. */
  ownerListeners: Array<() => void>;
  /** Host-only activity authority, independent of placement/CAS revisions. */
  childActive: boolean;
  childActivityRevision: number;
  childActivityListeners: Array<() => void>;
}

export interface CompanionGeometry {
  readonly defaultWidth: number;
  readonly defaultHeight: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

export class RecordCompanionRegistry extends Context.Service<
  RecordCompanionRegistry,
  {
    readonly open: (
      ownerSenderId: number,
      input: RecordCompanionOpenInput,
    ) => Effect.Effect<RecordCompanionOpenResult, RecordCompanionRegistryError>;
    readonly reopen: (
      ownerSenderId: number,
      scope: RecordCompanionScope,
      input: Omit<RecordCompanionOpenInput, "scope" | "view">,
    ) => Effect.Effect<RecordCompanionOpenResult, RecordCompanionRegistryError>;
    readonly subscribeOwner: (
      ownerSenderId: number,
    ) => Effect.Effect<readonly PlacementState[], RecordCompanionRegistryError>;
    readonly relay: (
      ownerSenderId: number,
      companionId: string,
      snapshot: unknown,
    ) => Effect.Effect<void, RecordCompanionRegistryError>;
    readonly ackDetach: (
      ownerSenderId: number,
      companionId: string,
      revision: number,
    ) => Effect.Effect<PlacementState, RecordCompanionRegistryError>;
    readonly ackDock: (
      ownerSenderId: number,
      companionId: string,
      revision: number,
    ) => Effect.Effect<PlacementState, RecordCompanionRegistryError>;
    readonly companionBootstrap: (
      childSenderId: number,
    ) => Effect.Effect<RecordCompanionBootstrap, RecordCompanionRegistryError>;
    readonly companionReady: (
      childSenderId: number,
      revision: number,
      handoff: RecordCompanionHandoff | null,
    ) => Effect.Effect<void, RecordCompanionRegistryError>;
    readonly companionQuiesce: (
      childSenderId: number,
      revision: number,
      handoff: RecordCompanionHandoff | null,
    ) => Effect.Effect<void, RecordCompanionRegistryError>;
    readonly companionRequestDock: (
      childSenderId: number,
      revision: number,
    ) => Effect.Effect<void, RecordCompanionRegistryError>;
    readonly companionViewAction: (
      childSenderId: number,
      viewRevision: number,
      action: RecordCompanionViewAction,
    ) => Effect.Effect<void, RecordCompanionRegistryError>;
    /** Current live states of one owner, for tests and diagnostics. */
    readonly statesOfOwner: (ownerSenderId: number) => Effect.Effect<readonly PlacementState[]>;
  }
>()("@t3tools/desktop/companion/RecordCompanionRegistry") {}

const decodePlacementState = Schema.decodeUnknownSync(RecordCompanionPlacementState);
const decodeBootstrap = Schema.decodeUnknownSync(RecordCompanionBootstrapSchema);
const decodeSavedScopeTuple = Schema.decodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);
const decodeScope = Schema.decodeSync(RecordCompanionScope);
const decodeSavedScopeKey = (key: string): RecordCompanionScope | null => {
  try {
    const tuple = decodeSavedScopeTuple(key);
    const scope = decodeScope({
      environmentId: tuple[0],
      threadId: tuple[1],
      providerInstanceId: tuple[2],
    });
    return recordCompanionScopeKey(scope) === key ? scope : null;
  } catch {
    return null;
  }
};

const placementStateOf = (record: CompanionRecord): PlacementState => {
  const machineState = record.machine.state();
  refreshChildActivity(record);
  // The machine carries raw string identities; the closed placement-state
  // schema is the one place they become the branded contract shape.
  return decodePlacementState({
    companionId: machineState.companionId,
    scope: {
      environmentId: machineState.scope.environmentId,
      threadId: machineState.scope.threadId,
      providerInstanceId: machineState.scope.providerInstanceId,
    },
    scopeKey: recordCompanionScopeKey({
      environmentId: machineState.scope.environmentId as never,
      threadId: machineState.scope.threadId as never,
      providerInstanceId: machineState.scope.providerInstanceId as never,
    }),
    placement: machineState.placement,
    revision: machineState.revision,
    ownerSenderId: machineState.ownerSenderId,
    childSender: machineState.childSender,
    childReady: machineState.childReady,
    childQuiesced: machineState.childQuiesced,
    handoff: machineState.handoff,
    acknowledgedHandoff: machineState.acknowledgedHandoff,
    childActive: record.childActive,
    childActivityRevision: record.childActivityRevision,
  });
};

/** Inspect the actual native window; renderer messages never set activity. */
function refreshChildActivity(record: CompanionRecord): boolean {
  const state = record.machine.state();
  const child = record.child;
  const active =
    state.placement === "detached" &&
    state.childReady &&
    !state.childQuiesced &&
    child !== null &&
    !child.isDestroyed() &&
    child.isVisible() &&
    child.isFocused() &&
    !child.isMinimized();
  if (active === record.childActive) return false;
  record.childActive = active;
  record.childActivityRevision += 1;
  return true;
}

/** Clamps persisted bounds to a display work area and the live minima. */
export function clampCompanionBounds(input: {
  readonly persisted: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly geometry: CompanionGeometry;
  readonly workArea: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}): { x: number; y: number; width: number; height: number } {
  const { geometry, workArea } = input;
  const width = Math.min(
    Math.max(input.persisted?.width ?? geometry.defaultWidth, geometry.minWidth),
    Math.max(geometry.minWidth, workArea.width),
  );
  const height = Math.min(
    Math.max(input.persisted?.height ?? geometry.defaultHeight, geometry.minHeight),
    Math.max(geometry.minHeight, workArea.height),
  );
  const fallbackX = workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2));
  const fallbackY = workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2));
  const requestedX = input.persisted?.x ?? fallbackX;
  const requestedY = input.persisted?.y ?? fallbackY;
  const x = Math.min(
    Math.max(requestedX, workArea.x),
    Math.max(workArea.x, workArea.x + workArea.width - width),
  );
  const y = Math.min(
    Math.max(requestedY, workArea.y),
    Math.max(workArea.y, workArea.y + workArea.height - height),
  );
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const presentation = yield* DesktopPresentation.DesktopPresentation;
  const preferences = yield* Preferences.RecordCompanionPreferences;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<
    | DesktopEnvironment.DesktopEnvironment
    | ElectronWindow.ElectronWindow
    | DesktopPresentation.DesktopPresentation
    | Preferences.RecordCompanionPreferences
    | FileSystem.FileSystem
    | Path.Path
  >();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const byOwner = new Map<number, Map<string, CompanionRecord>>();
  const byCompanionId = new Map<string, CompanionRecord>();
  const byChildSender = new Map<number, CompanionRecord>();
  let partitionProtocolInstalled = false;

  // --- Owner/child event plumbing (async view messages only) ---

  const pushOwnerEvent = (record: CompanionRecord, event: RecordCompanionOwnerEvent) => {
    const owner = record.ownerWindow;
    if (owner.isDestroyed()) return;
    owner.webContents.send(RECORD_COMPANION_OWNER_EVENT_CHANNEL, encodeOwnerEvent(event));
  };

  const pushChildEvent = (record: CompanionRecord, event: RecordCompanionChildEvent) => {
    const child = record.child;
    if (child === null || child.isDestroyed()) return;
    child.webContents.send(RECORD_COMPANION_CHILD_EVENT_CHANNEL, encodeChildEvent(event));
  };

  const pushState = (record: CompanionRecord) => {
    pushOwnerEvent(record, { type: "state", state: placementStateOf(record) });
  };

  // --- Restricted partition ---

  const installCompanionPartitionProtocol = Effect.sync(() => {
    if (partitionProtocolInstalled) return;
    const session = Electron.session.fromPartition(RECORD_COMPANION_PARTITION, {
      cache: false,
    });
    const scheme = (() => {
      const origin = getDesktopOrigin(environment.isDevelopment);
      return new URL(origin).protocol.replace(":", "");
    })();
    const contentSecurityPolicy = makeCompanionContentSecurityPolicy(environment.isDevelopment);
    session.protocol.handle(scheme, async (request: Request) => {
      const url = new URL(request.url);
      if (environment.isDevelopment) {
        if (isBlockedCompanionDevelopmentPath(url.pathname)) {
          return new Response(null, { status: 404 });
        }
        const targetOrigin = Option.getOrThrow(environment.devServerUrl);
        const target = new URL(`${url.pathname}${url.search}`, targetOrigin);
        const response = await Electron.net.fetch(target.toString(), {
          method: request.method,
          headers: request.headers,
        });
        return withCompanionContentSecurityPolicy(response, contentSecurityPolicy);
      }
      const served = await runPromise(serveCompanionAsset(request, environment.clientAssetsDir));
      return withCompanionContentSecurityPolicy(served, contentSecurityPolicy);
    });
    session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.setPermissionCheckHandler(() => false);
    partitionProtocolInstalled = true;
  });

  // --- Geometry and persistence ---

  let currentGeometry: CompanionGeometry = {
    defaultWidth: 760,
    defaultHeight: 680,
    minWidth: 560,
    minHeight: 420,
  };

  const refreshGeometry = Effect.gen(function* () {
    const state = yield* presentation.getState;
    const block = state.config.layout.recordCompanion;
    if (block !== undefined) {
      currentGeometry = { ...block };
    }
  });

  const readWorkArea = (bounds: { x: number; y: number; width: number; height: number }) => {
    try {
      return Electron.screen.getDisplayMatching(bounds).workArea;
    } catch {
      return Electron.screen.getPrimaryDisplay().workArea;
    }
  };

  const persistScopePreferencesEffect = (record: CompanionRecord) => {
    // Capture a candidate before scheduling: later relays cannot mutate this write.
    const state = placementStateOf(record);
    const candidate = {
      view: structuredClone(record.view),
      bounds: readPersistableBounds(record),
    };
    return preferences.setScope(state.scopeKey, candidate).pipe(
      Effect.catch((error) =>
        logWarning("failed to persist record companion preferences", {
          message: error.message,
        }),
      ),
    );
  };

  const persistScopePreferences = (record: CompanionRecord) => {
    runFork(persistScopePreferencesEffect(record));
  };

  const readPersistableBounds = (
    record: CompanionRecord,
  ): { x: number; y: number; width: number; height: number } | null => {
    const child = record.child;
    if (child === null || child.isDestroyed()) {
      // A destroyed child must not erase geometry: the last cached bounds
      // (captured on close/resize BEFORE destruction) stay authoritative.
      return record.cachedBounds;
    }
    const raw =
      child.isFullScreen() || child.isMaximized() ? child.getNormalBounds() : child.getBounds();
    const bounds = {
      x: Math.round(raw.x),
      y: Math.round(raw.y),
      width: Math.round(raw.width),
      height: Math.round(raw.height),
    };
    record.cachedBounds = bounds;
    return bounds;
  };

  // --- Child window lifecycle ---

  const clearOpeningTimeout = (record: CompanionRecord) => {
    if (record.openingTimeout === undefined) return;
    const fiber = record.openingTimeout;
    record.openingTimeout = undefined;
    runFork(Fiber.interrupt(fiber));
  };

  const clearGeometryPersist = (record: CompanionRecord) => {
    if (record.geometryFiber === undefined) return;
    const fiber = record.geometryFiber;
    record.geometryFiber = undefined;
    runFork(Fiber.interrupt(fiber));
  };

  const scheduleGeometryPersist = (record: CompanionRecord) => {
    readPersistableBounds(record);
    clearGeometryPersist(record);
    record.geometryFiber = runFork(
      Effect.sleep(GEOMETRY_PERSIST_DEBOUNCE_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            record.geometryFiber = undefined;
            persistScopePreferences(record);
          }),
        ),
      ),
    );
  };

  const dropRecord = (record: CompanionRecord) => {
    clearOpeningTimeout(record);
    clearGeometryPersist(record);
    // Repeated open/close must not accumulate epoch listeners on the owner.
    for (const remove of record.ownerListeners.splice(0)) remove();
    for (const remove of record.childActivityListeners.splice(0)) remove();
    byCompanionId.delete(record.companionId);
    if (record.boundChildSender !== null) byChildSender.delete(record.boundChildSender);
    const scopes = byOwner.get(record.ownerSenderId);
    const scopeKey = recordCompanionScopeKey(placementStateOf(record).scope);
    if (scopes !== undefined) {
      if (scopes.get(scopeKey) === record) scopes.delete(scopeKey);
      if (scopes.size === 0) byOwner.delete(record.ownerSenderId);
    }
  };

  const destroyChild = (record: CompanionRecord) => {
    readPersistableBounds(record);
    const child = record.child;
    record.child = null;
    if (child !== null && !child.isDestroyed()) {
      child.destroy();
    }
  };

  const failOpening = (record: CompanionRecord, reason: string) => {
    clearOpeningTimeout(record);
    const before = record.machine.state();
    const revision = before.revision;
    try {
      record.machine.failOpening(record.ownerSenderId, revision);
    } catch {
      // Already transitioned (for example the child closed after commit):
      // nothing to roll back.
    }
    // The owner renderer learns the canonical placement BEFORE the record
    // leaves the owner map — whether this call rolled the transaction back
    // or arrived after another transition already had.
    pushState(record);
    destroyChild(record);
    dropRecord(record);
    void logWarning("record companion opening failed", { reason });
  };

  const onChildWindowClosed = (record: CompanionRecord) => {
    const state = record.machine.state();
    if (state.placement === "opening") {
      // The provisional child died before the handoff committed: roll the
      // whole transaction back; the owner keeps its docked view.
      failOpening(record, "child window closed during opening");
      return;
    }
    try {
      record.machine.close(state.childSender ?? record.ownerSenderId, state.revision);
    } catch {
      // Already closed or docked: the identity is revoked either way; the
      // canonical final state below still reaches the owner.
    }
    // The FINAL canonical state reaches the owner BEFORE the record leaves
    // the map: a detached (or docking) Close stays CLOSED — never docked —
    // so the hub stops its scope queries and offers an explicit Reopen.
    pushOwnerEvent(record, { type: "state", state: placementStateOf(record) });
    readPersistableBounds(record);
    destroyChild(record);
    dropRecord(record);
  };

  const createChildWindow = Effect.fn("desktop.companion.createChildWindow")(function* (
    record: CompanionRecord,
    persistedBounds: { x: number; y: number; width: number; height: number } | null,
  ) {
    yield* installCompanionPartitionProtocol;
    yield* refreshGeometry;
    const geometry = currentGeometry;
    const requested = persistedBounds === null ? null : { ...persistedBounds };
    const workArea = readWorkArea(
      requested ?? {
        x: 0,
        y: 0,
        width: geometry.defaultWidth,
        height: geometry.defaultHeight,
      },
    );
    const bounds = clampCompanionBounds({
      persisted: requested,
      geometry,
      workArea,
    });
    const origin = getDesktopOrigin(environment.isDevelopment);
    const companionUrl = `${origin}${RECORD_COMPANION_ENTRY_PATH}?companion=${encodeURIComponent(record.companionId)}`;
    const window = yield* electronWindow.create({
      ...bounds,
      minWidth: geometry.minWidth,
      minHeight: geometry.minHeight,
      show: false,
      parent: record.ownerWindow,
      title: "Record — Dokkabi",
      backgroundColor: "#0a0a0a",
      webPreferences: {
        preload: environment.companionPreloadPath,
        partition: RECORD_COMPANION_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    record.child = window;

    // Only effective activity changes publish; repeated native notifications
    // do not create reads or change handoff/placement revision tokens.
    const activityChanged = () => {
      if (byCompanionId.get(record.companionId) !== record || record.child !== window) return;
      if (refreshChildActivity(record)) pushState(record);
    };
    window.on("focus", activityChanged);
    window.on("blur", activityChanged);
    window.on("show", activityChanged);
    window.on("hide", activityChanged);
    window.on("minimize", activityChanged);
    window.on("restore", activityChanged);
    record.childActivityListeners.push(() => {
      window.removeListener("focus", activityChanged);
      window.removeListener("blur", activityChanged);
      window.removeListener("show", activityChanged);
      window.removeListener("hide", activityChanged);
      window.removeListener("minimize", activityChanged);
      window.removeListener("restore", activityChanged);
    });

    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on("resize", () => scheduleGeometryPersist(record));
    window.on("move", () => scheduleGeometryPersist(record));
    window.on("close", (event) => {
      // A native close must flush live geometry before destruction; the debounce
      // is for repeated drags only and is never the durability boundary.
      event.preventDefault();
      if (record.closing) return;
      record.closing = true;
      clearGeometryPersist(record);
      const write = persistScopePreferencesEffect(record);
      const state = record.machine.state();
      if (state.placement === "detached" || state.placement === "docking") {
        record.machine.close(state.childSender ?? record.ownerSenderId, state.revision);
        pushState(record);
      }
      if (record.boundChildSender !== null) byChildSender.delete(record.boundChildSender);
      runFork(
        write.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!window.isDestroyed()) window.destroy();
            }),
          ),
        ),
      );
    });
    window.on("closed", () => {
      onChildWindowClosed(record);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        if (record.machine.state().placement === "opening") {
          failOpening(
            record,
            `companion failed to load (${errorCode} ${errorDescription ?? ""} ${validatedURL ?? ""})`,
          );
        }
      },
    );
    let childNavigationStarted = false;
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      if (!childNavigationStarted) {
        childNavigationStarted = true;
        return;
      }
      // A new child document cannot inherit the previous renderer's receipt.
      if (!window.isDestroyed()) window.close();
    });
    window.webContents.on("render-process-gone", () => {
      const placement = record.machine.state().placement;
      if (placement === "opening") {
        failOpening(record, "companion render process gone during opening");
      } else if (!window.isDestroyed()) {
        window.close();
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url === companionUrl) return;
      event.preventDefault();
    });

    // The machine binds the ACTUAL child webContents identity before any
    // child message can arrive, and the sender index registers the same
    // identity so bootstrap/ready arriving before the detach commit already
    // authorize against it.
    record.machine.attach(window.webContents.id, record.machine.state().revision);
    record.boundChildSender = window.webContents.id;
    byChildSender.set(window.webContents.id, record);
    record.openingTimeout = runFork(
      Effect.sleep(OPENING_TIMEOUT_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const placement = record.machine.state().placement;
            if (placement === "opening") {
              failOpening(record, "opening timed out");
            }
          }),
        ),
      ),
    );
    void window.loadURL(companionUrl).catch(() => undefined);
    return window;
  });

  // Presentation geometry changes apply live minima to open children only.
  const stopPresentationChanges = yield* presentation.subscribeChanges((state) => {
    const block = state.config.layout.recordCompanion;
    if (block === undefined) return;
    currentGeometry = { ...block };
    for (const scopes of byOwner.values()) {
      for (const record of scopes.values()) {
        const child = record.child;
        if (child !== null && !child.isDestroyed()) {
          child.setMinimumSize(block.minWidth, block.minHeight);
        }
      }
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => stopPresentationChanges()));

  // --- Open / reopen ---

  const livePlacement = (record: CompanionRecord): boolean => {
    const placement = record.machine.state().placement;
    return (
      record.closing ||
      placement === "opening" ||
      placement === "detached" ||
      placement === "docking"
    );
  };

  const revealChild = (record: CompanionRecord) => {
    const child = record.child;
    if (child !== null && !child.isDestroyed()) {
      if (child.isMinimized()) child.restore();
      child.focus();
    }
  };

  const startHandoff = Effect.fn("desktop.companion.startHandoff")(function* (
    ownerSenderId: number,
    ownerWindow: Electron.BrowserWindow,
    scope: RecordCompanionScope,
    view: RecordCompanionViewPreferences,
    handoff: RecordCompanionHandoff,
  ) {
    const companionId = yield* crypto.randomUUIDv4;
    const machine = new RecordCompanionMachine(ownerSenderId, companionId, {
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      providerInstanceId:
        scope.providerInstanceId === null || scope.providerInstanceId === undefined
          ? null
          : scope.providerInstanceId,
    });
    const record: CompanionRecord = {
      companionId,
      machine,
      ownerSenderId,
      ownerWindow,
      child: null,
      handoff,
      view,
      viewRevision: handoff.viewRevision,
      sourceLabel: "",
      pendingSnapshot: null,
      lastRelayedJson: null,
      openingTimeout: undefined,
      geometryFiber: undefined,
      closing: false,
      cachedBounds: null,
      latestTuple: { ...handoff },
      boundChildSender: null,
      ownerListeners: [],
      childActive: false,
      childActivityRevision: 0,
      childActivityListeners: [],
    };
    machine.requestOpen(ownerSenderId, machine.state().revision, handoff);
    let scopes = byOwner.get(ownerSenderId);
    if (scopes === undefined) {
      scopes = new Map();
      byOwner.set(ownerSenderId, scopes);
    }
    const scopeKey = recordCompanionScopeKey(scope);
    scopes.set(scopeKey, record);
    byCompanionId.set(companionId, record);

    // Owner epoch end closes the child and invalidates every identity of
    // this epoch, exactly once. A window close is one cause; a renderer
    // crash or a main-frame reload is another — the webContents id can
    // survive a reload while the owner hub that steered the companion is
    // gone, so a main-frame navigation ends the epoch too.
    let epochEnded = false;
    const endOwnerEpoch = () => {
      if (epochEnded) return;
      epochEnded = true;
      const current = byCompanionId.get(companionId);
      if (current === undefined) return;
      const state = current.machine.state();
      try {
        current.machine.close(ownerSenderId, state.revision);
      } catch {
        // Already closed/docked: nothing live to invalidate.
      }
      readPersistableBounds(current);
      destroyChild(current);
      dropRecord(current);
    };
    record.ownerListeners.push(
      () => ownerWindow.removeListener("closed", endOwnerEpoch),
      () => record.ownerWindow.webContents.removeListener("destroyed", endOwnerEpoch),
      () => {
        record.ownerWindow.webContents.removeListener(
          "did-start-navigation",
          onOwnerMainFrameNavigation,
        );
        record.ownerWindow.webContents.removeListener(
          "render-process-gone",
          onOwnerRenderProcessGone,
        );
      },
    );
    const onOwnerMainFrameNavigation = (
      _event: unknown,
      _url: unknown,
      isSameDocument: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && !isSameDocument) endOwnerEpoch();
    };
    const onOwnerRenderProcessGone = () => endOwnerEpoch();
    ownerWindow.once("closed", endOwnerEpoch);
    record.ownerWindow.webContents.once("destroyed", endOwnerEpoch);
    record.ownerWindow.webContents.on("did-start-navigation", onOwnerMainFrameNavigation);
    // A crashed owner renderer cannot steer the companion even though its
    // webContents may not fire "destroyed": revoke the epoch directly.
    record.ownerWindow.webContents.on("render-process-gone", onOwnerRenderProcessGone);

    const persisted = yield* preferences.getScope(scopeKey);
    const created = yield* createChildWindow(record, persisted?.bounds ?? null).pipe(Effect.option);
    if (Option.isNone(created)) {
      // The handoff never opened a child: roll the provisional machine back
      // to docked and drop the record so the docked view stays usable.
      yield* Effect.try(() =>
        record.machine.failOpening(ownerSenderId, record.machine.state().revision),
      ).pipe(Effect.ignore);
      dropRecord(record);
      return yield* new RecordCompanionRegistryError({
        reason: "companion window creation failed",
      });
    }
    return record;
  });

  const open = Effect.fn("desktop.companion.open")(function* (
    ownerSenderId: number,
    input: RecordCompanionOpenInput,
  ): Effect.fn.Return<RecordCompanionOpenResult, RecordCompanionRegistryError> {
    // The owner is the ACTUAL registered main window: the any-first-window
    // fallback must never authorize opening (or steering) a companion.
    const ownerWindowOption = yield* electronWindow.main;
    if (Option.isNone(ownerWindowOption) || ownerWindowOption.value.isDestroyed()) {
      return yield* new RecordCompanionRegistryError({ reason: "no live main window" });
    }
    const ownerWindow = ownerWindowOption.value;
    if (ownerWindow.webContents.id !== ownerSenderId) {
      return yield* new RecordCompanionRegistryError({
        reason: "owner sender is not the current main window",
      });
    }
    const scopeKey = recordCompanionScopeKey(input.scope);
    const scopes = byOwner.get(ownerSenderId);
    const existing = scopes?.get(scopeKey);
    if (existing?.closing)
      return {
        type: "error",
        message: "The record companion is closing. Reopen after it has closed.",
      };
    if (existing !== undefined && livePlacement(existing)) {
      // Repeated Open of the current scope reveals the same child.
      revealChild(existing);
      return {
        type: "opening",
        companionId: existing.companionId,
        state: placementStateOf(existing),
      };
    }
    for (const [otherKey, record] of scopes ?? []) {
      if (otherKey !== scopeKey && livePlacement(record)) {
        // A different scope is live: a visible conflict, never a silent rebind.
        revealChild(record);
        return {
          type: "conflict",
          message:
            "Another record companion is already open for this window. Close it before inspecting another scope.",
          existing: placementStateOf(record),
        };
      }
    }
    const record = yield* startHandoff(ownerSenderId, ownerWindow, input.scope, input.view, {
      descriptorRevision: input.descriptorRevision,
      viewRevision: input.viewRevision,
      presentationRevision: input.presentationRevision,
    }).pipe(
      Effect.mapError(
        (error) =>
          new RecordCompanionRegistryError({
            reason: error instanceof Error ? error.message : String(error),
          }),
      ),
    );
    pushState(record);
    return { type: "opening", companionId: record.companionId, state: placementStateOf(record) };
  });

  const reopen = Effect.fn("desktop.companion.reopen")(function* (
    ownerSenderId: number,
    scope: RecordCompanionScope,
    input: Omit<RecordCompanionOpenInput, "scope" | "view">,
  ): Effect.fn.Return<RecordCompanionOpenResult, RecordCompanionRegistryError> {
    const scopeKey = recordCompanionScopeKey(scope);
    const persisted = yield* preferences.getScope(scopeKey);
    const view: RecordCompanionViewPreferences = persisted?.view ?? {
      tab: "record",
      pin: null,
      after: null,
      selectedSeq: null,
    };
    // The reopened handoff keeps the owner's CURRENT revisions: the persisted
    // view is a preference, not a source identity.
    return yield* open(ownerSenderId, {
      scope,
      view,
      descriptorRevision: input.descriptorRevision,
      viewRevision: input.viewRevision,
      presentationRevision: input.presentationRevision,
    });
  });

  const recordForOwner = (
    ownerSenderId: number,
    companionId: string,
  ): Effect.Effect<CompanionRecord, RecordCompanionRegistryError> =>
    Effect.gen(function* () {
      const record = byCompanionId.get(companionId);
      if (record === undefined || record.ownerSenderId !== ownerSenderId) {
        return yield* new RecordCompanionRegistryError({
          reason: "unknown companion for this owner",
        });
      }
      return record;
    });

  const recordForChild = (
    childSenderId: number,
  ): Effect.Effect<CompanionRecord, RecordCompanionRegistryError> =>
    Effect.gen(function* () {
      const record = byChildSender.get(childSenderId);
      if (record === undefined) {
        return yield* new RecordCompanionRegistryError({
          reason: "sender is not a registered companion child",
        });
      }
      yield* Effect.try({
        try: () => record.machine.assertCompanionSender(childSenderId),
        catch: () =>
          new RecordCompanionRegistryError({ reason: "sender is not the active companion child" }),
      });
      return record;
    });

  return RecordCompanionRegistry.of({
    open,
    reopen,
    subscribeOwner: (ownerSenderId) =>
      Effect.gen(function* () {
        const ownerWindowOption = yield* electronWindow.main;
        if (
          Option.isNone(ownerWindowOption) ||
          ownerWindowOption.value.isDestroyed() ||
          ownerWindowOption.value.webContents.id !== ownerSenderId
        ) {
          return yield* new RecordCompanionRegistryError({
            reason: "owner sender is not the current main window",
          });
        }
        const scopes = byOwner.get(ownerSenderId) ?? new Map<string, CompanionRecord>();
        const states = Array.from(scopes.values(), (record) => placementStateOf(record));
        // Saved preferences restore a CLOSED inspection hint only. They never
        // restore a child, an epoch, a source query, or execution authority.
        for (const key of yield* preferences.scopeKeys) {
          if (scopes.has(key)) continue;
          const scope = decodeSavedScopeKey(key);
          if (scope === null) continue;
          const companionId = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) => new RecordCompanionRegistryError({ reason: String(cause) })),
          );
          const hint = new RecordCompanionMachine(ownerSenderId, companionId, scope).state();
          states.push(decodePlacementState({ ...hint, placement: "closed", scope, scopeKey: key }));
        }
        return states;
      }),
    relay: (ownerSenderId, companionId, snapshot) =>
      Effect.gen(function* () {
        const record = yield* recordForOwner(ownerSenderId, companionId);
        const placement = record.machine.state().placement;
        const decoded = yield* Effect.try({
          try: () => decodeSnapshotStrict(snapshot),
          catch: () =>
            new RecordCompanionRegistryError({
              reason: "relay packet failed the closed snapshot schema",
            }),
        });
        const encoded = snapshotText(decoded);
        if (Buffer.byteLength(encoded, "utf8") > RECORD_COMPANION_SNAPSHOT_MAX_BYTES) {
          return yield* new RecordCompanionRegistryError({
            reason: "relay packet exceeds the snapshot byte bound",
          });
        }
        const machineScope = record.machine.state().scope;
        const scopeMatches =
          decoded.companionId === companionId &&
          decoded.scope.environmentId === machineScope.environmentId &&
          decoded.scope.threadId === machineScope.threadId &&
          decoded.scope.providerInstanceId === machineScope.providerInstanceId &&
          decoded.scopeKey === recordCompanionScopeKey(placementStateOf(record).scope);
        if (!scopeMatches) {
          return yield* new RecordCompanionRegistryError({
            reason: "relay packet names a different companion or scope",
          });
        }
        if (decoded.descriptorRevision !== record.handoff.descriptorRevision) {
          return yield* new RecordCompanionRegistryError({
            reason: "relay packet carries a different frozen source descriptor",
          });
        }
        if (decoded.viewRevision < record.viewRevision) {
          return yield* new RecordCompanionRegistryError({
            reason: "relay packet carries a stale view revision",
          });
        }
        if (placement === "opening" || placement === "docking") {
          // Pending source updates wait for the commit; they never change the
          // acknowledged handoff mid-transaction.
          record.pendingSnapshot = decoded;
          return;
        }
        if (placement !== "detached") {
          return yield* new RecordCompanionRegistryError({
            reason: "relay arrived while no companion is detached",
          });
        }
        record.sourceLabel = decoded.sourceLabel;
        record.latestTuple = {
          descriptorRevision: record.handoff.descriptorRevision,
          viewRevision: decoded.viewRevision,
          presentationRevision: decoded.presentationRevision,
        };
        if (decoded.viewRevision > record.viewRevision || record.lastRelayedJson === null) {
          record.view = decoded.view;
          persistScopePreferences(record);
        }
        record.viewRevision = decoded.viewRevision;
        // Deduplicate byte-identical relays: the child re-rendering the same
        // projection is noise, not information.
        if (record.lastRelayedJson === encoded) return;
        record.lastRelayedJson = encoded;
        pushChildEvent(record, { type: "snapshot", snapshot: decoded });
        pushOwnerEvent(record, {
          type: "snapshotRelayed",
          companionId,
          scopeKey: decoded.scopeKey,
          viewRevision: decoded.viewRevision,
        });
      }),
    ackDetach: (ownerSenderId, companionId, revision) =>
      Effect.gen(function* () {
        const record = yield* recordForOwner(ownerSenderId, companionId);
        yield* Effect.try({
          try: () => {
            record.machine.commitDetach(ownerSenderId, revision);
          },
          catch: (cause) =>
            new RecordCompanionRegistryError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        // The committed transaction now applies any source update that
        // arrived during the handoff — including its view state, BEFORE any
        // future child action is validated, so the child and the host can
        // never disagree about which view revision is live.
        const pending = record.pendingSnapshot;
        record.pendingSnapshot = null;
        clearOpeningTimeout(record);
        if (pending !== null) {
          record.view = pending.view;
          record.viewRevision = pending.viewRevision;
          record.sourceLabel = pending.sourceLabel;
          record.latestTuple = {
            descriptorRevision: record.handoff.descriptorRevision,
            viewRevision: pending.viewRevision,
            presentationRevision: pending.presentationRevision,
          };
          persistScopePreferences(record);
          record.lastRelayedJson = snapshotText(pending);
          pushChildEvent(record, { type: "snapshot", snapshot: pending });
        }
        pushChildEvent(record, { type: "activated" });
        pushState(record);
        return placementStateOf(record);
      }),
    ackDock: (ownerSenderId, companionId, revision) =>
      Effect.gen(function* () {
        const record = yield* recordForOwner(ownerSenderId, companionId);
        const childSender = record.machine.state().childSender;
        yield* Effect.try({
          try: () => record.machine.commitDock(ownerSenderId, revision),
          catch: (cause) =>
            new RecordCompanionRegistryError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        yield* persistScopePreferencesEffect(record);
        if (childSender !== null) byChildSender.delete(childSender);
        const state = placementStateOf(record);
        // Publish the one active docked destination before destroying its inert child.
        pushState(record);
        pushChildEvent(record, { type: "closed" });
        destroyChild(record);
        dropRecord(record);
        return state;
      }),
    companionBootstrap: (childSenderId) =>
      Effect.gen(function* () {
        const record = yield* recordForChild(childSenderId);
        const state = placementStateOf(record);
        return decodeBootstrap({
          companionId: record.companionId,
          scope: state.scope,
          scopeKey: state.scopeKey,
          view: record.view,
          placement: state.placement,
          sourceLabel: record.sourceLabel,
          revision: state.revision,
          handoff: state.handoff,
        });
      }),
    companionReady: (childSenderId, revision, handoff) =>
      Effect.gen(function* () {
        const record = yield* recordForChild(childSenderId);
        yield* Effect.try({
          try: () => record.machine.ready(childSenderId, revision, handoff),
          catch: (cause) =>
            new RecordCompanionRegistryError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        clearOpeningTimeout(record);
        pushOwnerEvent(record, {
          type: "childReady",
          companionId: record.companionId,
          revision: record.machine.state().revision,
          handoff: record.handoff,
          view: record.view,
        });
      }),
    companionQuiesce: (childSenderId, revision, handoff) =>
      Effect.gen(function* () {
        const record = yield* recordForChild(childSenderId);
        yield* Effect.try({
          try: () => {
            record.machine.quiesce(childSenderId, revision, handoff);
          },
          catch: (cause) =>
            new RecordCompanionRegistryError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        pushOwnerEvent(record, {
          type: "childQuiesced",
          companionId: record.companionId,
          revision: record.machine.state().revision,
          view: record.view,
        });
      }),
    companionRequestDock: (childSenderId, revision) =>
      Effect.gen(function* () {
        const record = yield* recordForChild(childSenderId);
        yield* Effect.try({
          try: () => {
            // The dock transaction acknowledges the CURRENT inspected tuple,
            // never the original Open tuple: the host always passes the latest
            // validated relay, and quiesce must echo exactly this one.
            record.machine.requestDock(childSenderId, revision, record.latestTuple);
          },
          catch: (cause) =>
            new RecordCompanionRegistryError({
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        pushChildEvent(record, { type: "docking", handoff: record.latestTuple });
        pushState(record);
      }),
    companionViewAction: (childSenderId, viewRevision, action) =>
      Effect.gen(function* () {
        const record = yield* recordForChild(childSenderId);
        if (viewRevision !== record.viewRevision) {
          return yield* new RecordCompanionRegistryError({
            reason: "view action carries a stale or future view revision",
          });
        }
        pushOwnerEvent(record, {
          type: "viewAction",
          companionId: record.companionId,
          scopeKey: placementStateOf(record).scopeKey,
          viewRevision,
          action,
        });
      }),
    statesOfOwner: (ownerSenderId) =>
      Effect.sync(() =>
        Array.from(byOwner.get(ownerSenderId)?.values() ?? [], (record) =>
          placementStateOf(record),
        ),
      ),
  });
});

export const layer = Layer.effect(RecordCompanionRegistry, make);
