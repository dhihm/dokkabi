import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
  type PresentationAppliedState,
  type PresentationResetResult,
  type PresentationSaveResult,
} from "@t3tools/contracts";

import * as DesktopPresentation from "../../presentation/DesktopPresentation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  reloadPresentation,
  resetPresentation,
  savePresentation,
  subscribePresentation,
  unsubscribePresentation,
} from "./presentation.ts";

const appliedState = (revision: number): PresentationAppliedState => ({
  schemaVersion: 1,
  revision,
  digest: `${revision}`.padEnd(64, "0"),
  location: "/private/tmp/dokkabi-presentation-ipc/desktop/presentation.json",
  status: "applied",
  overrideDocument: "{}",
  override: { schemaVersion: 1 },
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

interface PresentationHarness {
  readonly calls: ReadonlyArray<string>;
  readonly layers: Layer.Layer<
    DesktopPresentation.DesktopPresentation | ElectronWindow.ElectronWindow
  >;
}

const makeHarness = (main: Electron.BrowserWindow | null): PresentationHarness => {
  const calls: Array<string> = [];
  const record = (label: string) =>
    Effect.sync(() => {
      calls.push(label);
    });
  const presentationLayer = Layer.mock(DesktopPresentation.DesktopPresentation)({
    getState: Effect.suspend(() => {
      calls.push("getState");
      return Effect.succeed(appliedState(3));
    }),
    reload: record("reload").pipe(Effect.as(appliedState(4))),
    save: () =>
      Effect.suspend(() => {
        calls.push("save");
        const result: PresentationSaveResult = { type: "applied", state: appliedState(5) };
        return Effect.succeed(result);
      }),
    reset: record("reset").pipe(
      Effect.as({
        type: "applied" as const,
        state: appliedState(6),
      } satisfies PresentationResetResult),
    ),
    registerTrustedSender: (webContentsId) => record(`register:${webContentsId}`),
    unregisterTrustedSender: (webContentsId) => record(`unregister:${webContentsId}`),
    isTrustedSender: () => false,
  });
  // The actual registered main window — the same authority the host uses.
  const windowLayer = Layer.mock(ElectronWindow.ElectronWindow)({
    main: Effect.succeed(main === null ? Option.none() : Option.some(main)),
  });
  return { calls, layers: Layer.merge(presentationLayer, windowLayer) };
};

const liveMainWindow = (): Electron.BrowserWindow =>
  ({
    isDestroyed: () => false,
    webContents: { id: 42 },
  }) as Electron.BrowserWindow;

// The registered IPC method exposes its handler through the untyped bridge
// (results arrive as unknown), so the assertions narrow with property guards
// instead of casts; refusals are observed through Exit/Cause so the error
// channel stays specific.
const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null && field in value
    ? (value as Record<string, unknown>)[field]
    : undefined;

const isRefusal = (exit: Exit.Exit<unknown, unknown>): boolean => {
  const cause = Exit.getCause(exit);
  return (
    Option.isSome(cause) && Cause.pretty(cause.value).includes("PresentationSenderRefusedError")
  );
};

const expectRefused = (exit: Exit.Exit<unknown, unknown>): void => {
  assert.isTrue(isRefusal(exit));
};

describe("presentation IPC methods", () => {
  it.effect("registers the trusted main sender before the initial read", () => {
    const harness = makeHarness(liveMainWindow());
    return Effect.gen(function* () {
      const state = yield* subscribePresentation.handler(undefined, { sender: { id: 42 } });
      // The sender is registered before the state read, so the initial read
      // cannot race the first push.
      assert.deepEqual(harness.calls, ["register:42", "getState"]);
      assert.equal(fieldOf(state, "revision"), 3);
    }).pipe(Effect.provide(harness.layers));
  });

  it.effect("refuses non-main and missing senders without host effects", () => {
    const harness = makeHarness(liveMainWindow());
    return Effect.gen(function* () {
      // A different window's webContents (preview, PiP, sign-in popup).
      expectRefused(
        yield* Effect.exit(subscribePresentation.handler(undefined, { sender: { id: 99 } })),
      );
      // No sender identity at all.
      expectRefused(yield* Effect.exit(subscribePresentation.handler(undefined)));
      // Mutations from a non-main sender never reach the host.
      expectRefused(
        yield* Effect.exit(
          savePresentation.handler({ expectedRevision: 1, document: "{}" }, { sender: { id: 99 } }),
        ),
      );
      expectRefused(
        yield* Effect.exit(resetPresentation.handler(undefined, { sender: { id: 99 } })),
      );
      expectRefused(
        yield* Effect.exit(reloadPresentation.handler(undefined, { sender: { id: 99 } })),
      );
      expectRefused(
        yield* Effect.exit(unsubscribePresentation.handler(undefined, { sender: { id: 99 } })),
      );
      // Nothing but the refused attempts happened: no registration, no host
      // mutation, no state read.
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.provide(harness.layers));
  });

  it.effect("refuses a destroyed main window without host effects", () => {
    const destroyedMain = {
      isDestroyed: () => true,
      webContents: { id: 42 },
    } as Electron.BrowserWindow;
    const harness = makeHarness(destroyedMain);
    return Effect.gen(function* () {
      expectRefused(
        yield* Effect.exit(subscribePresentation.handler(undefined, { sender: { id: 42 } })),
      );
      expectRefused(
        yield* Effect.exit(resetPresentation.handler(undefined, { sender: { id: 42 } })),
      );
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.provide(harness.layers));
  });

  it.effect("refuses everything when there is no current main window", () => {
    const harness = makeHarness(null);
    return Effect.gen(function* () {
      expectRefused(
        yield* Effect.exit(subscribePresentation.handler(undefined, { sender: { id: 42 } })),
      );
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.provide(harness.layers));
  });

  it.effect("lets the main window save, reload and reset through the host service", () => {
    const harness = makeHarness(liveMainWindow());
    return Effect.gen(function* () {
      const saved = yield* savePresentation.handler(
        { expectedRevision: 3, document: "{}" },
        { sender: { id: 42 } },
      );
      assert.equal(fieldOf(saved, "type"), "applied");
      assert.equal(fieldOf(fieldOf(saved, "state"), "revision"), 5);
      const reloaded = yield* reloadPresentation.handler(undefined, { sender: { id: 42 } });
      assert.equal(fieldOf(reloaded, "revision"), 4);
      const reset = yield* resetPresentation.handler(undefined, { sender: { id: 42 } });
      assert.equal(fieldOf(reset, "type"), "applied");
      yield* unsubscribePresentation.handler(undefined, { sender: { id: 42 } });
      assert.deepEqual(harness.calls, ["save", "reload", "reset", "unregister:42"]);
    }).pipe(Effect.provide(harness.layers));
  });
});
