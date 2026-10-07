import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopPresentation from "../presentation/DesktopPresentation.ts";
import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  type PresentationAppliedState,
  type PresentationResetResult,
} from "@t3tools/contracts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("Dokkabi"),
  systemLocale: Effect.succeed("en-US"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeedNone,
  pickFiles: () => Effect.succeed([]),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialog["Service"]);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  isActionActive: Effect.succeed(false),
  isInstallActive: Effect.succeed(false),
  subscribe: Effect.die("unexpected subscribe"),
  emitState: Effect.void,
  disabledReason: Effect.succeedNone,
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
  installPrepared: () => Effect.die("unexpected installPrepared"),
} satisfies DesktopUpdates.DesktopUpdates["Service"]);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    currentMain: Effect.die("unexpected currentMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: (direction) =>
      Deferred.succeed(selectedAction, `zoom-${direction}`).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

interface PresentationMenuHarness {
  readonly presentationLayer: Layer.Layer<DesktopPresentation.DesktopPresentation>;
  readonly dialogLayer: Layer.Layer<ElectronDialog.ElectronDialog>;
  readonly resetCalls: ReadonlyArray<number>;
  readonly messageBoxes: ReadonlyArray<{
    readonly title: string | undefined;
    readonly detail: string | undefined;
  }>;
}

const makePresentationHarness = (
  resetEffect: Effect.Effect<PresentationResetResult>,
): PresentationMenuHarness => {
  const resetCalls: Array<number> = [];
  const messageBoxes: Array<{ title: string | undefined; detail: string | undefined }> = [];
  const defaultsState = (revision: number): PresentationAppliedState => ({
    schemaVersion: 1,
    revision,
    digest: `${revision}`.padEnd(64, "0"),
    location: "/private/tmp/dokkabi-presentation-menu/desktop/presentation.json",
    status: "defaults",
    overrideDocument: null,
    override: null,
    config: {
      schemaVersion: 1,
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
        inlineBreakpoint: 1200,
        graph: PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
        recordCompanion: PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
      },
    },
    error: null,
  });
  const presentationLayer = Layer.succeed(DesktopPresentation.DesktopPresentation, {
    getState: Effect.succeed(defaultsState(1)),
    reload: Effect.succeed(defaultsState(1)),
    save: () => Effect.die("unexpected save"),
    reset: Effect.suspend(() => {
      resetCalls.push(resetCalls.length);
      return resetEffect;
    }),
    dispose: Effect.void,
    subscribeChanges: () => Effect.succeed(() => {}),
    registerTrustedSender: () => Effect.void,
    unregisterTrustedSender: () => Effect.void,
    isTrustedSender: () => false,
  } satisfies DesktopPresentation.DesktopPresentation["Service"]);
  const dialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeedNone,
    pickFiles: () => Effect.succeed([]),
    showMessageBox: (options) =>
      Effect.sync(() => {
        messageBoxes.push({ title: options.title, detail: options.detail });
        return { response: 0, checkboxChecked: false };
      }),
    showErrorBox: () => Effect.void,
  } satisfies ElectronDialog.ElectronDialog["Service"]);
  return { presentationLayer, dialogLayer, resetCalls, messageBoxes };
};

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeedNone,
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const menuDefaultsState = (): PresentationAppliedState => ({
  schemaVersion: 1,
  revision: 2,
  digest: "2".padEnd(64, "0"),
  location: "/private/tmp/dokkabi-presentation-menu/desktop/presentation.json",
  status: "defaults",
  overrideDocument: null,
  override: null,
  config: {
    schemaVersion: 1,
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
    layout: {
      mainWindow: { minWidth: 840, minHeight: 620, defaultWidth: 1100, defaultHeight: 780 },
      navigation: { minWidth: 200, defaultWidth: 240, maxWidth: 320 },
      conversation: { minWidth: 480 },
      rightPanel: { minWidth: 280, defaultWidth: 320, maxWidth: 440 },
      inlineBreakpoint: 1200,
      graph: PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
      recordCompanion: PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
    },
  },
  error: null,
});

const defaultPresentationLayer = makePresentationHarness(
  Effect.succeed({ type: "applied", state: menuDefaultsState() } satisfies PresentationResetResult),
).presentationLayer;

const configureMenu = (
  selectedAction: Deferred.Deferred<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  extras: {
    readonly presentationLayer?: Layer.Layer<DesktopPresentation.DesktopPresentation>;
    readonly dialogLayer?: Layer.Layer<ElectronDialog.ElectronDialog>;
  } = {},
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
        Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
        Layer.provideMerge(desktopUpdatesLayer),
        Layer.provideMerge(extras.dialogLayer ?? electronDialogLayer),
        Layer.provideMerge(extras.presentationLayer ?? defaultPresentationLayer),
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(
          DesktopEnvironment.layer(environmentInput).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          ),
        ),
      ),
    ),
  );

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  it.effect("owns Paste as Text and routes it through the renderer", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "Edit");
      assert.isDefined(editMenu);
      if (!Array.isArray(editMenu.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "Paste as Text");
      assert.isDefined(pasteAsTextItem);
      assert.equal(pasteAsTextItem.accelerator, "CmdOrCtrl+Shift+V");
      if (typeof pasteAsTextItem.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {} as KeyboardEvent,
      );
      assert.equal(yield* Deferred.await(selectedAction), "paste-as-text");
    }),
  );

  // Chromium pastes as plain text for the accelerator on its own. Dispatching
  // the action as well injects a second paste, which doubles the pasted text.
  it.effect("leaves the accelerator to Chromium instead of injecting a paste", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "Edit");
      if (!Array.isArray(editMenu?.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "Paste as Text");
      if (typeof pasteAsTextItem?.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {
          triggeredByAccelerator: true,
        } as unknown as KeyboardEvent,
      );
      assert.isFalse(yield* Deferred.isDone(selectedAction));
    }),
  );

  // Zoom must route through DesktopWindow.zoomMain instead of the Electron
  // zoom roles: the roles zoom whichever webContents has focus, which breaks
  // app zoom while an embedded preview WebContentsView holds focus.
  it.effect("routes View menu zoom to the main window instead of zoom roles", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) => item.role?.toLowerCase().includes("zoom")),
      );

      const zoomIn = viewMenu.submenu.find((item) => item.label === "Zoom In");
      assert.isDefined(zoomIn);
      assert.equal(zoomIn.accelerator, "CmdOrCtrl+=");
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "zoom-in");
    }),
  );

  // The native reset is reachable even when the renderer layout is broken:
  // it goes straight through the presentation host, and an incomplete
  // outcome is reported, never hidden.
  it.effect("resets the presentation override from the View menu", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const resetDone = yield* Deferred.make<void>();
      const harness = makePresentationHarness(
        Deferred.succeed(resetDone, undefined).pipe(
          Effect.as({
            type: "applied",
            state: menuDefaultsState(),
          } satisfies PresentationResetResult),
        ),
      );

      yield* configureMenu(selectedAction, applicationMenuTemplate, {
        presentationLayer: harness.presentationLayer,
        dialogLayer: harness.dialogLayer,
      });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }
      const resetItem = viewMenu.submenu.find((item) => item.label === "Reset Presentation");
      assert.isDefined(resetItem);
      if (typeof resetItem.click !== "function") {
        throw new Error("Expected Reset Presentation to have a click handler.");
      }

      resetItem.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      yield* Deferred.await(resetDone);
      assert.equal(harness.resetCalls.length, 1);
      // A clean applied reset reports nothing further.
      assert.equal(harness.messageBoxes.length, 0);
    }),
  );

  it.effect("reports an incomplete native reset instead of hiding it", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const resetDone = yield* Deferred.make<void>();
      const harness = makePresentationHarness(
        Deferred.succeed(resetDone, undefined).pipe(
          Effect.as({
            type: "uncertain",
            state: menuDefaultsState(),
            message: "failed to append the presentation audit entry",
          } satisfies PresentationResetResult),
        ),
      );

      yield* configureMenu(selectedAction, applicationMenuTemplate, {
        presentationLayer: harness.presentationLayer,
        dialogLayer: harness.dialogLayer,
      });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }
      const resetItem = viewMenu.submenu.find((item) => item.label === "Reset Presentation");
      if (typeof resetItem?.click !== "function") {
        throw new Error("Expected Reset Presentation to have a click handler.");
      }

      resetItem.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      yield* Deferred.await(resetDone);
      assert.equal(harness.resetCalls.length, 1);
      assert.equal(harness.messageBoxes.length, 1);
      assert.equal(harness.messageBoxes[0]?.title, "Presentation reset incomplete");
      assert.match(harness.messageBoxes[0]?.detail ?? "", /audit/);
    }),
  );
});
