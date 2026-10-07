// @effect-diagnostics nodeBuiltinImport:off -- Real temporary preference files exercise the durable scoped store under the registry.
import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePlatformPath from "@effect/platform-node/NodePath";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";
import {
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  recordCompanionScopeKey,
  type RecordCompanionOpenInput,
  type RecordCompanionHandoff,
  type RecordCompanionOwnerEvent,
  type RecordCompanionPlacementState,
  type RecordCompanionSnapshot,
  type RecordCompanionViewPreferences,
} from "@t3tools/contracts";

const { createWindow, partitionHandle, permissionHandlers, electronModule } = vi.hoisted(() => ({
  createWindow: vi.fn(),
  partitionHandle: vi.fn(),
  permissionHandlers: {
    request: vi.fn(),
    check: vi.fn(),
    registered: {
      request: null as null | ((...args: never[]) => unknown),
      check: null as null | ((...args: never[]) => unknown),
    },
  },
  // Late-bound reference to the mocked electron module: vi.mock factories
  // may not close over imports, so the test assigns this after import.
  electronModule: { current: null as unknown },
}));

vi.mock("electron", () => {
  // Minimal emitter inside the factory: vi.mock factories run before module
  // imports initialize, so nothing external may be referenced here.
  class TinyEmitter {
    private listeners = new Map<string, Set<(...args: never[]) => void>>();
    on(event: string, listener: (...args: never[]) => void) {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
      return this;
    }
    once(event: string, listener: (...args: never[]) => void) {
      const wrapped = (...args: never[]) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }
    off(event: string, listener: (...args: never[]) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    removeListener(event: string, listener: (...args: never[]) => void) {
      return this.off(event, listener);
    }
    listenerCount(event: string) {
      return this.listeners.get(event)?.size ?? 0;
    }
    emit(event: string, ...args: never[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
      return true;
    }
  }
  class FakeWebContents extends TinyEmitter {
    readonly id: number;
    send = vi.fn();
    setWindowOpenHandler = vi.fn();
    constructor(id: number) {
      super();
      this.id = id;
    }
  }
  let nextWindowId = 100;
  class FakeBrowserWindow extends TinyEmitter {
    readonly webContents: FakeWebContents;
    shown = false;
    focused = false;
    destroyed = false;
    minimized = false;
    fullScreen = false;
    maximized = false;
    bounds = { x: 40, y: 40, width: 760, height: 680 };
    minimum = { width: 0, height: 0 };
    loadURL = vi.fn(() => Promise.resolve());
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents(nextWindowId++);
      createWindow(this);
    }
    show() {
      this.shown = true;
      this.emit("show");
    }
    isVisible() {
      return this.shown;
    }
    isFocused() {
      return this.focused;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return this.minimized;
    }
    isFullScreen() {
      return this.fullScreen;
    }
    isMaximized() {
      return this.maximized;
    }
    restore() {
      this.minimized = false;
    }
    focus() {
      this.focused = true;
      this.emit("focus");
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    close() {
      this.destroy();
    }
    getBounds() {
      return { ...this.bounds };
    }
    getNormalBounds() {
      return { ...this.bounds };
    }
    setMinimumSize(width: number, height: number) {
      this.minimum = { width, height };
    }
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    session: {
      fromPartition: () => ({
        protocol: { handle: partitionHandle },
        setPermissionRequestHandler: (handler: unknown) => {
          permissionHandlers.request(handler as never);
          permissionHandlers.registered.request = handler as never;
        },
        setPermissionCheckHandler: (handler: unknown) => {
          permissionHandlers.check(handler as never);
          permissionHandlers.registered.check = handler as never;
        },
      }),
    },
    screen: {
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 3000, height: 2000 },
      }),
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 3000, height: 2000 },
      }),
    },
    net: { fetch: vi.fn() },
  };
});

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopPresentation from "../presentation/DesktopPresentation.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as RecordCompanionRegistryModule from "./RecordCompanionRegistry.ts";
import * as ElectronModule from "electron";

// The mocked electron module, bound after imports initialize.
electronModule.current = ElectronModule;
import * as PreferencesModule from "./RecordCompanionPreferences.ts";
const { layerFromInput } = PreferencesModule;

interface FakeWindow {
  isDestroyed(): boolean;
  close(): void;
  readonly webContents: { readonly id: number; send: ReturnType<typeof vi.fn> };
  readonly options: Record<string, unknown>;
  emit(event: string, ...args: readonly unknown[]): boolean;
  destroy(): void;
  shown: boolean;
  focused: boolean;
  minimized: boolean;
  listenerCount(event: string): number;
  bounds: { x: number; y: number; width: number; height: number };
}

const OWNER_SENDER = 10;

/** Owner webContents with real listener semantics so epoch hooks fire. */
class OwnerWebContents {
  readonly id = OWNER_SENDER;
  send = vi.fn();
  private listeners = new Map<string, Set<(...args: never[]) => void>>();
  on(event: string, listener: (...args: never[]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  off(event: string, listener: (...args: never[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  removeListener(event: string, listener: (...args: never[]) => void) {
    return this.off(event, listener);
  }
  once(event: string, listener: (...args: never[]) => void) {
    const wrapped = (...args: never[]) => {
      this.listeners.get(event)?.delete(wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }
  emit(event: string, ...args: never[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    return true;
  }
  sentOwnerEvents() {
    return (this.send.mock.calls as unknown as [string, RecordCompanionOwnerEvent][])
      .filter(([channel]) => channel === "desktop:record-companion-owner-event")
      .map(([, event]) => event);
  }
}

const ownerWebContents = new OwnerWebContents();
const ownerWindow = {
  isDestroyed: () => false,
  webContents: ownerWebContents,
  once: (event: string, listener: (...args: never[]) => void) =>
    ownerWebContents.once(event, listener),
  on: (event: string, listener: (...args: never[]) => void) => ownerWebContents.on(event, listener),
  removeListener: (event: string, listener: (...args: never[]) => void) =>
    ownerWebContents.off(event, listener),
} as unknown as Electron.BrowserWindow;

let tempStoreCounter = 0;
function tempStorePath(): string {
  tempStoreCounter += 1;
  return NodePath.join(
    NodeOs.tmpdir(),
    `dokkabi-registry-test-${process.pid}-${tempStoreCounter}`,
    "record-companion-preferences.json",
  );
}

const presentationState = () => ({
  schemaVersion: 1 as const,
  revision: 1,
  digest: "digest",
  location: "/presentation.json",
  status: "defaults" as const,
  overrideDocument: null,
  override: null,
  config: {
    schemaVersion: 1 as const,
    tokens: {
      color: {
        background: null,
        surface: null,
        text: null,
        muted: null,
        border: null,
        accent: null,
      },
      radius: { panel: null, control: null },
      spacing: { base: null },
      font: {
        family: null,
        familyMono: null,
        sizePrompt: null,
        sizeCode: null,
        lineHeight: null,
      },
      transition: { durationMs: null },
    },
    layout: {
      mainWindow: { minWidth: 840, minHeight: 620, defaultWidth: 1100, defaultHeight: 780 },
      navigation: { minWidth: 200, defaultWidth: 240, maxWidth: 320 },
      conversation: { minWidth: 480 },
      rightPanel: { minWidth: 280, defaultWidth: 320, maxWidth: 440 },
      graph: {
        direction: "LR" as const,
        nodeWidth: 260,
        nodeHeight: 96,
        rankGap: 64,
        siblingGap: 32,
        canvasPadding: 24,
      },
      recordCompanion: { ...PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS },
      inlineBreakpoint: 1200,
    },
  },
  error: null,
});

const registryLayer = (storePath: string) =>
  RecordCompanionRegistryModule.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ElectronWindow.ElectronWindow)({
          create: ((options: Record<string, unknown>) =>
            Effect.succeed(
              new (
                electronModule.current as unknown as {
                  BrowserWindow: new (options: Record<string, unknown>) => FakeWindow;
                }
              ).BrowserWindow(options),
            )) as never,
          main: Effect.succeedSome(ownerWindow as never),
        } as never),
        Layer.mock(DesktopPresentation.DesktopPresentation)({
          getState: Effect.succeed(presentationState() as never),
          subscribeChanges: () => Effect.succeed(() => {}),
          isTrustedSender: () => false,
        } as never),
        Layer.mock(DesktopEnvironment.DesktopEnvironment)({
          isDevelopment: false,
          devServerUrl: Option.none(),
          clientAssetsDir: "/tmp/dokkabi-test-client-assets",
          companionPreloadPath: "/tmp/dokkabi-test-companion-preload.cjs",
        } as never),
        layerFromInput({ preferencesPath: storePath }),
        NodeCryptoLayer.layer,
      ),
    ),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodePlatformPath.layer),
  );

const scope = (suffix: string) =>
  ({
    environmentId: `env-${suffix}`,
    threadId: `thread-${suffix}`,
    providerInstanceId: null,
  }) as unknown as Parameters<typeof recordCompanionScopeKey>[0];

const defaultView: RecordCompanionViewPreferences = {
  tab: "record",
  pin: null,
  after: null,
  selectedSeq: null,
};

const openInput = (suffix: string, viewRevision = 1): RecordCompanionOpenInput => ({
  scope: scope(suffix),
  view: defaultView,
  descriptorRevision: 5,
  viewRevision,
  presentationRevision: 3,
});

function snapshotPacket(
  companionId: string,
  suffix: string,
  viewRevision: number,
): RecordCompanionSnapshot {
  return {
    companionId,
    scope: scope(suffix),
    scopeKey: recordCompanionScopeKey(scope(suffix)),
    descriptorRevision: 5,
    viewRevision,
    presentationRevision: 3,
    view: defaultView,
    result: { status: "pending" },
    sourceLabel: `source-${suffix}`,
    theme: { dark: false },
    tokens: {
      color: {
        background: null,
        surface: null,
        text: null,
        muted: null,
        border: null,
        accent: null,
      },
      radius: { panel: null, control: null },
      spacing: { base: null },
      font: { family: null, familyMono: null, sizePrompt: null, sizeCode: null, lineHeight: null },
      transition: { durationMs: null },
    },
  };
}

const ownerEvents = (): RecordCompanionOwnerEvent[] => ownerWebContents.sentOwnerEvents();

const childEvents = (window: FakeWindow): { type: string }[] =>
  (window.webContents.send.mock.calls as unknown as [string, { type: string }][])
    .filter(([channel]) => channel === "desktop:record-companion-child-event")
    .map(([, event]) => event);

const lastStateEvent = (): RecordCompanionPlacementState | null => {
  const states = ownerEvents().filter((event) => event.type === "state");
  return states.length > 0 ? states[states.length - 1]!.state : null;
};

function emitOn(target: unknown, event: string, ...args: readonly unknown[]): void {
  (target as { emit: (event: string, ...args: never[]) => boolean }).emit(
    event,
    ...(args as never[]),
  );
}

const fakeWindowOf = (record: { companionId: string }): FakeWindow => {
  // The fake constructor records itself as the CALL ARGUMENT (constructors
  // have no return value), so the newest call's first argument is the window.
  const calls = createWindow.mock.calls as unknown as [FakeWindow][];
  const window = calls[calls.length - 1]?.[0];
  if (window === undefined) {
    throw new Error(`no fake window recorded for ${record.companionId}`);
  }
  return window;
};

type RegistryService = RecordCompanionRegistryModule.RecordCompanionRegistry["Service"];

async function driveDetached(
  registry: RegistryService,
  suffix: string,
): Promise<{ companionId: string; window: FakeWindow; state: RecordCompanionPlacementState }> {
  const opened = await Effect.runPromise(registry.open(OWNER_SENDER, openInput(suffix)));
  assert(opened.type === "opening");
  const window = fakeWindowOf(opened);
  const bootstrap = await Effect.runPromise(registry.companionBootstrap(window.webContents.id));
  await Effect.runPromise(
    registry.companionReady(window.webContents.id, bootstrap.revision, bootstrap.handoff),
  );
  const state = await Effect.runPromise(
    registry.ackDetach(OWNER_SENDER, opened.companionId, bootstrap.revision + 1),
  );
  return { companionId: opened.companionId, window, state };
}

describe("record companion registry integration", () => {
  it.effect(
    "runs the full handoff: bootstrap carries revision+handoff, relay reaches the child, actions reach the owner",
    () =>
      Effect.gen(function* () {
        createWindow.mockClear();
        ownerWebContents.send.mockClear();
        const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
        const { companionId, window } = yield* Effect.promise(() =>
          driveDetached(registry, "alpha"),
        );

        // Bootstrap carried the CAS token and frozen tuple: no circular wait.
        expect(companionId).toMatch(/^[0-9a-f-]{36}$/);
        // Detach pushed activation to the child and state to the owner.
        expect(childEvents(window).map((event) => event.type)).toContain("activated");
        expect(lastStateEvent()?.placement).toBe("detached");

        // Relay a fresh snapshot; the child receives it exactly once.
        const snapshot = snapshotPacket(companionId, "alpha", 2);
        yield* registry.relay(OWNER_SENDER, companionId, snapshot);
        const snapshots = childEvents(window).filter((event) => event.type === "snapshot");
        expect(snapshots).toHaveLength(1);
        // Byte-identical relay is deduplicated.
        yield* registry.relay(OWNER_SENDER, companionId, snapshot);
        expect(childEvents(window).filter((event) => event.type === "snapshot")).toHaveLength(1);

        // A child view action at the exact revision reaches the owner.
        yield* registry.companionViewAction(window.webContents.id, 2, { type: "first" });
        const actions = ownerEvents().filter((event) => event.type === "viewAction");
        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({ type: "viewAction", viewRevision: 2 });
      }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );

  it.effect(
    "holds pending snapshots during opening and promotes view+revision on the detach commit",
    () =>
      Effect.gen(function* () {
        createWindow.mockClear();
        ownerWebContents.send.mockClear();
        const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
        const opened = yield* registry.open(OWNER_SENDER, openInput("beta"));
        assert(opened.type === "opening");
        const window = fakeWindowOf(opened);

        // Snapshot arrives BEFORE the child is ready: held, not forwarded.
        const pending = snapshotPacket(opened.companionId, "beta", 7);
        yield* registry.relay(OWNER_SENDER, opened.companionId, pending);
        expect(childEvents(window)).toHaveLength(0);

        const bootstrap = yield* registry.companionBootstrap(window.webContents.id);
        yield* registry.companionReady(
          window.webContents.id,
          bootstrap.revision,
          bootstrap.handoff,
        );
        const state = yield* registry.ackDetach(
          OWNER_SENDER,
          opened.companionId,
          bootstrap.revision + 1,
        );
        expect(state.placement).toBe("detached");
        // The pending update applied AFTER the commit, view and revision first.
        const snapshots = childEvents(window).filter((event) => event.type === "snapshot");
        expect(snapshots).toHaveLength(1);
        // A view action now validates against the PROMOTED revision.
        yield* registry.companionViewAction(window.webContents.id, 7, {
          type: "tab",
          tab: "decisions",
        });
        expect(ownerEvents().filter((event) => event.type === "viewAction")).toHaveLength(1);
        const stale = yield* Effect.flip(
          registry.companionViewAction(window.webContents.id, 6, { type: "first" }),
        );
        expect(stale.reason).toContain("view revision");
      }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );

  it.effect("refuses foreign owners, wrong scopes, extra fields and stale view revisions", () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      ownerWebContents.send.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const { companionId } = yield* Effect.promise(() => driveDetached(registry, "gamma"));

      // Foreign owner sender is refused outright.
      const foreign = yield* Effect.flip(
        registry.relay(999, companionId, snapshotPacket(companionId, "gamma", 3)),
      );
      expect(foreign.reason).toContain("unknown companion");

      // A snapshot naming a different scope refuses even with a valid shape.
      const wrongScope = yield* Effect.flip(
        registry.relay(OWNER_SENDER, companionId, snapshotPacket(companionId, "delta", 3)),
      );
      expect(wrongScope.reason).toContain("different companion or scope");

      // Extra properties refuse (closed snapshot boundary).
      const extra = yield* Effect.flip(
        registry.relay(OWNER_SENDER, companionId, {
          ...snapshotPacket(companionId, "gamma", 3),
          bootstrapToken: "must-not-cross",
        }),
      );
      expect(extra.reason).toContain("closed snapshot schema");

      // A descriptor that is not the frozen one refuses.
      const rebind = { ...snapshotPacket(companionId, "gamma", 3), descriptorRevision: 6 };
      const staleDescriptor = yield* Effect.flip(registry.relay(OWNER_SENDER, companionId, rebind));
      expect(staleDescriptor.reason).toContain("frozen source descriptor");

      // A stale view revision refuses.
      const staleView = yield* Effect.flip(
        registry.relay(OWNER_SENDER, companionId, snapshotPacket(companionId, "gamma", 0)),
      );
      expect(staleView.reason).toContain("stale view revision");
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );

  it.effect("returns a visible conflict for another scope and reveals for the same scope", () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      ownerWebContents.send.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      yield* Effect.promise(() => driveDetached(registry, "epsilon"));

      const conflict = yield* registry.open(OWNER_SENDER, openInput("zeta"));
      assert(conflict.type === "conflict");
      expect(conflict.existing.placement).toBe("detached");
      expect(conflict.message).toContain("already open");

      // Repeated open of the SAME scope reveals the existing child.
      const reveal = yield* registry.open(OWNER_SENDER, openInput("epsilon"));
      assert(reveal.type === "opening");
      expect(createWindow).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );

  it.effect("docks only after child quiesce and publishes docked before closing the child", () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      ownerWebContents.send.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const detached = yield* Effect.promise(() => driveDetached(registry, "eta"));
      const { companionId, window } = detached;
      const detachedRevision = detached.state.revision;
      const destroySpy = vi.fn(() => {
        (window as unknown as { destroyed: boolean }).destroyed = true;
        (window as unknown as { emit: (e: string) => boolean }).emit("closed");
      });
      (window as unknown as { destroy: () => void }).destroy = destroySpy;

      yield* registry.companionRequestDock(window.webContents.id, detachedRevision);
      expect(childEvents(window).map((event) => event.type)).toContain("docking");
      // Dock commit before quiesce refuses.
      const early = yield* Effect.flip(
        registry.ackDock(OWNER_SENDER, companionId, detachedRevision + 1),
      );
      expect(early.reason).toContain("quiesce");

      // The dock transaction acknowledges the LATEST inspected tuple; an
      // echoed Open tuple would refuse.
      const dockTuple = (
        childEvents(window).find((event) => event.type === "docking") as unknown as {
          handoff: RecordCompanionHandoff;
        }
      ).handoff;
      yield* registry.companionQuiesce(window.webContents.id, detachedRevision + 1, dockTuple);
      const quiesced = ownerEvents().filter((event) => event.type === "childQuiesced");
      expect(quiesced).toHaveLength(1);

      const docked = yield* registry.ackDock(OWNER_SENDER, companionId, detachedRevision + 2);
      expect(docked.placement).toBe("docked");
      // Docked is published BEFORE the child closes: the owner's docked-state
      // send is ordered before the child's destruction, so exactly one
      // interactive placement exists at any instant.
      // The DOCKED state send (not the later final-close push) must precede
      // the child's destruction.
      const dockedIndex = ownerWebContents.send.mock.calls.findIndex(
        ([channel, event], index) =>
          channel === "desktop:record-companion-owner-event" &&
          (event as { type?: string; state?: { placement?: string } }).type === "state" &&
          (event as { state?: { placement?: string } }).state?.placement === "docked" &&
          ownerWebContents.send.mock.invocationCallOrder[index] !== undefined,
      );
      const dockedStateSend = ownerWebContents.send.mock.invocationCallOrder[dockedIndex];
      const destroyOrder = destroySpy.mock.invocationCallOrder[0];
      expect(dockedStateSend).toBeDefined();
      expect(destroyOrder).toBeDefined();
      expect(dockedStateSend!).toBeLessThan(destroyOrder!);
      const lastChildEvent = childEvents(window).at(-1);
      expect(lastChildEvent?.type).toBe("closed");
      // The child sender is revoked: no further companion call is accepted.
      const revoked = yield* Effect.flip(registry.companionBootstrap(window.webContents.id));
      expect(revoked.reason).toContain("not a registered companion child");
      // Geometry was cached before destruction and persisted for the scope.
      const reopenInput = openInput("eta");
      yield* registry.reopen(OWNER_SENDER, reopenInput.scope, reopenInput);
      const preferences = yield* PreferencesModule.RecordCompanionPreferences;
      const restored = yield* preferences.getScope(recordCompanionScopeKey(scope("eta")));
      expect(restored?.bounds).not.toBeNull();
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );

  it.effect("rolls back a failed opening to the canonical docked state and revokes the child", () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      ownerWebContents.send.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const opened = yield* registry.open(OWNER_SENDER, openInput("theta"));
      assert(opened.type === "opening");
      const window = fakeWindowOf(opened);
      const bootstrap = yield* registry.companionBootstrap(window.webContents.id);

      // The main frame fails to load: prompt rollback, canonical docked push.
      emitOn(
        window.webContents,
        "did-fail-load",
        {},
        -3,
        "aborted",
        "dokkabi://app/companion.html",
        true,
      );
      const rollback = lastStateEvent();
      expect(rollback?.placement).toBe("docked");
      expect(rollback?.childSender).toBeNull();
      // The provisional child sender is revoked.
      const revoked = yield* Effect.flip(
        registry.companionReady(window.webContents.id, bootstrap.revision, bootstrap.handoff),
      );
      expect(revoked.reason).toContain("not a registered companion child");
      // The owner map is clean: a fresh open starts a new transaction.
      const fresh = yield* registry.open(OWNER_SENDER, openInput("theta"));
      expect(fresh.type).toBe("opening");
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );

  it.effect(
    "close is closed: a closed child window revokes identities and keeps persisted preferences",
    () =>
      Effect.gen(function* () {
        createWindow.mockClear();
        ownerWebContents.send.mockClear();
        const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
        const { window } = yield* Effect.promise(() => driveDetached(registry, "iota"));
        window.destroy();
        const closed = lastStateEvent();
        expect(closed === null || closed.placement !== "detached").toBe(true);
        const revoked = yield* Effect.flip(registry.companionBootstrap(window.webContents.id));
        expect(revoked.reason).toContain("not a registered companion child");
        const states = yield* registry.statesOfOwner(OWNER_SENDER);
        expect(states).toHaveLength(0);
      }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );

  it.effect("installs the restricted partition protocol exactly once with denials", () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      partitionHandle.mockClear();
      permissionHandlers.request.mockClear();
      permissionHandlers.check.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      yield* registry.open(OWNER_SENDER, openInput("kappa"));
      yield* registry.open(OWNER_SENDER, openInput("kappa"));
      expect(partitionHandle).toHaveBeenCalledTimes(1);
      expect(permissionHandlers.request).toHaveBeenCalled();
      expect(permissionHandlers.check).toHaveBeenCalled();
      // The handler denies every permission request in the partition.
      expect(permissionHandlers.request).toHaveBeenCalled();
      expect(permissionHandlers.check).toHaveBeenCalled();
      // The registered handlers deny every permission synchronously.
      expect(permissionHandlers.registered.check?.()).toBe(false);
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );
});

it.live(
  "primary review: an immediate resize and native close preserves final bounds without waiting for debounce",
  () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      ownerWebContents.send.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const opened = yield* registry.open(OWNER_SENDER, openInput("fast-close"));
      assert(opened.type === "opening");
      const window = fakeWindowOf(opened);
      const bootstrap = yield* registry.companionBootstrap(window.webContents.id);
      yield* registry.companionReady(window.webContents.id, bootstrap.revision, bootstrap.handoff);
      yield* registry.ackDetach(OWNER_SENDER, opened.companionId, bootstrap.revision + 1);
      (
        window as unknown as { bounds: { x: number; y: number; width: number; height: number } }
      ).bounds = { x: 40, y: 40, width: 940, height: 740 };
      emitOn(window, "resize");
      // Electron emits close while getBounds is still usable, then closed.
      emitOn(window, "close", { preventDefault() {} });
      window.close();
      const preferences = yield* PreferencesModule.RecordCompanionPreferences;
      let saved = yield* preferences.getScope(recordCompanionScopeKey(scope("fast-close")));
      for (let attempt = 0; attempt < 100 && saved?.bounds?.width !== 940; attempt += 1) {
        yield* Effect.sleep(10);
        saved = yield* preferences.getScope(recordCompanionScopeKey(scope("fast-close")));
      }
      expect(saved?.bounds).toEqual({ x: 40, y: 40, width: 940, height: 740 });
      expect(lastStateEvent()?.placement).toBe("closed");
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
);

it.effect(
  "primary review: a fresh owner subscription lists saved scopes as closed without launching a child",
  () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      const preferences = yield* PreferencesModule.RecordCompanionPreferences;
      const savedScope = scope("restart");
      yield* preferences.setScope(recordCompanionScopeKey(savedScope), {
        view: { ...defaultView, selectedSeq: 7 },
        bounds: { x: 40, y: 40, width: 940, height: 740 },
      });
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const states = yield* registry.subscribeOwner(OWNER_SENDER);
      expect(states).toHaveLength(1);
      expect(states[0]?.scope).toEqual(savedScope);
      expect(states[0]?.placement).toBe("closed");
      expect(states[0]?.childSender).toBeNull();
      expect(createWindow).not.toHaveBeenCalled();
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
);

it.effect(
  "primary review: Dock bootstrap returns the current host tuple after a newer relayed inspection",
  () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const { companionId, window, state } = yield* Effect.promise(() =>
        driveDetached(registry, "current-dock"),
      );
      const snapshot = {
        ...snapshotPacket(companionId, "current-dock", 9),
        presentationRevision: 8,
      };
      yield* registry.relay(OWNER_SENDER, companionId, snapshot);
      yield* registry.companionRequestDock(window.webContents.id, state.revision);
      const bootstrap = yield* registry.companionBootstrap(window.webContents.id);
      expect(bootstrap.handoff).toEqual({
        descriptorRevision: 5,
        viewRevision: 9,
        presentationRevision: 8,
      });
      yield* registry.companionQuiesce(
        window.webContents.id,
        bootstrap.revision,
        bootstrap.handoff,
      );
      const docked = yield* registry.ackDock(OWNER_SENDER, companionId, bootstrap.revision + 1);
      expect(docked.placement).toBe("docked");
      expect(window.isDestroyed()).toBe(true);
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
);

it.effect("primary review: child main-frame reload revokes the prior inspection identity", () =>
  Effect.gen(function* () {
    createWindow.mockClear();
    const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
    const { window } = yield* Effect.promise(() => driveDetached(registry, "child-reload"));
    emitOn(
      window.webContents,
      "did-start-navigation",
      {},
      "dokkabi://app/companion.html",
      false,
      true,
    );
    emitOn(
      window.webContents,
      "did-start-navigation",
      {},
      "dokkabi://app/companion.html",
      false,
      true,
    );
    const refused = yield* Effect.flip(registry.companionBootstrap(window.webContents.id));
    expect(refused.reason).toContain("not a registered companion child");
    expect(lastStateEvent()?.placement).toBe("closed");
  }).pipe(Effect.provide(registryLayer(tempStorePath()))),
);

describe("host-observed companion activity", () => {
  it.effect("publishes activity independently of CAS and rejects inactive lifecycle states", () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      ownerWebContents.send.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const opened = yield* registry.open(OWNER_SENDER, openInput("activity"));
      assert(opened.type === "opening");
      const window = fakeWindowOf(opened);
      window.shown = true;
      window.focused = true;
      emitOn(window, "focus");
      const current = () =>
        lastStateEvent() as RecordCompanionPlacementState & {
          childActive?: boolean;
          childActivityRevision?: number;
        };
      const opening = (yield* registry.statesOfOwner(OWNER_SENDER))[0] as ReturnType<
        typeof current
      >;
      expect(opening.childActive).toBe(false);
      expect(opening.childActivityRevision).toBe(0);
      const bootstrap = yield* registry.companionBootstrap(window.webContents.id);
      yield* registry.companionReady(window.webContents.id, bootstrap.revision, bootstrap.handoff);
      const ready = (yield* registry.statesOfOwner(OWNER_SENDER))[0] as ReturnType<typeof current>;
      expect(ready.childActive).toBe(false);
      const detached = yield* registry.ackDetach(
        OWNER_SENDER,
        opened.companionId,
        bootstrap.revision + 1,
      );
      expect(current().childActive).toBe(true);
      expect(current().childActivityRevision).toBe(1);
      const stable = ownerEvents().length;
      emitOn(window, "focus");
      expect(ownerEvents()).toHaveLength(stable);
      for (const [field, value, event, active] of [
        ["focused", false, "blur", false],
        ["focused", true, "focus", true],
        ["shown", false, "hide", false],
        ["shown", true, "show", true],
        ["minimized", true, "minimize", false],
        ["minimized", false, "restore", true],
      ] as const) {
        window[field] = value;
        emitOn(window, event);
        expect(current().childActive).toBe(active);
        expect(current().revision).toBe(detached.revision);
        expect(current().handoff).toEqual(detached.handoff);
      }
      expect(current().childActivityRevision).toBe(7);
      yield* registry.companionRequestDock(window.webContents.id, detached.revision);
      expect(current().childActive).toBe(false);
      expect(current().childActivityRevision).toBe(8);
      emitOn(window, "focus");
      expect(current().childActivityRevision).toBe(8);
      window.destroy();
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );
  it.effect("revokes activity on close and disposes native activity listeners", () =>
    Effect.gen(function* () {
      createWindow.mockClear();
      ownerWebContents.send.mockClear();
      const registry = yield* RecordCompanionRegistryModule.RecordCompanionRegistry;
      const { window } = yield* Effect.promise(() => driveDetached(registry, "activity-close"));
      window.shown = true;
      window.focused = true;
      emitOn(window, "focus");
      expect((lastStateEvent() as unknown as { childActive: boolean }).childActive).toBe(true);
      window.destroy();
      const closed = lastStateEvent() as unknown as {
        childActive: boolean;
        childActivityRevision: number;
        placement: string;
      };
      expect(closed.placement).toBe("closed");
      expect(closed.childActive).toBe(false);
      expect(closed.childActivityRevision).toBe(2);
      for (const event of ["focus", "blur", "show", "hide", "minimize", "restore"]) {
        expect(window.listenerCount(event)).toBe(0);
      }
      const count = ownerEvents().length;
      emitOn(window, "focus");
      emitOn(window, "show");
      emitOn(window, "restore");
      expect(ownerEvents()).toHaveLength(count);
      expect(yield* registry.statesOfOwner(OWNER_SENDER)).toEqual([]);
    }).pipe(Effect.provide(registryLayer(tempStorePath()))),
  );
});
