// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PresentationAppliedState } from "@t3tools/contracts";
import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
} from "@t3tools/contracts";

import {
  presentationConnectionError,
  presentationStore,
  setPresentationState,
} from "./presentationStore";

const appliedState = (revision: number): PresentationAppliedState => ({
  schemaVersion: 1,
  revision,
  digest: `${revision}`.padEnd(64, "0"),
  location: "/private/tmp/dokkabi-presentation-x/desktop/presentation.json",
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
      graph: PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
      recordCompanion: PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
      inlineBreakpoint: 1200,
    },
  },
  error: null,
});

type PushListener = (state: unknown) => void;

interface BridgeHarness {
  readonly subscribeCalls: number;
  readonly unsubscribeCalls: number;
  readonly resolveSubscribe: (state: PresentationAppliedState) => void;
  readonly rejectSubscribe: (error: unknown) => void;
  /** Scripts the next subscribe call to settle immediately with a state. */
  readonly enqueueSubscribeState: (state: PresentationAppliedState) => void;
  /** Scripts the next subscribe call to settle immediately with an error. */
  readonly enqueueSubscribeError: (error: unknown) => void;
  readonly push: (state: unknown) => void;
  readonly detachPush: () => void;
}

type SettleSubscribe = (
  resolve: (state: PresentationAppliedState) => void,
  reject: (error: unknown) => void,
) => void;

const installBridge = (): BridgeHarness => {
  const listeners = new Set<PushListener>();
  const scripted: Array<SettleSubscribe> = [];
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let resolveSubscribe: (state: PresentationAppliedState) => void = () => {};
  let rejectSubscribe: (error: unknown) => void = () => {};
  const bridge = {
    presentation: {
      subscribe: (): Promise<PresentationAppliedState> => {
        subscribeCalls += 1;
        return new Promise<PresentationAppliedState>((resolve, reject) => {
          const settle = scripted.shift();
          if (settle !== undefined) {
            settle(resolve, reject);
            return;
          }
          resolveSubscribe = resolve;
          rejectSubscribe = reject;
        });
      },
      unsubscribe: () => {
        unsubscribeCalls += 1;
        return Promise.resolve();
      },
      reload: () => Promise.resolve(appliedState(1)),
      save: () => Promise.reject(new Error("not used")),
      reset: () => Promise.reject(new Error("not used")),
    },
    onPresentationState: (listener: PushListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  vi.stubGlobal("desktopBridge", bridge);
  return {
    get subscribeCalls() {
      return subscribeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    resolveSubscribe: (state) => resolveSubscribe(state),
    rejectSubscribe: (error) => rejectSubscribe(error),
    enqueueSubscribeState: (state) => {
      scripted.push((resolve) => {
        resolve(state);
      });
    },
    enqueueSubscribeError: (error) => {
      scripted.push((_resolve, reject) => {
        reject(error);
      });
    },
    push: (state) => {
      for (const listener of listeners) {
        listener(state);
      }
    },
    detachPush: () => {
      listeners.clear();
    },
  };
};

const flush = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

describe("presentation boot subscription", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setPresentationState(null);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the newer subscription alive across a StrictMode double mount", async () => {
    const harness = installBridge();
    const { PresentationSync } = await import("./presentationBoot");

    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(PresentationSync)));
    });
    // StrictMode mounted, unmounted and mounted again: the refcounted
    // subscription survives, so exactly one live registration exists.
    expect(harness.subscribeCalls).toBeGreaterThanOrEqual(1);

    // The initial read of the first (stale) generation resolves late, after
    // a newer push already arrived.
    harness.push(appliedState(5));
    harness.resolveSubscribe(appliedState(3));
    await flush();
    // The stale initial read loses to the newer push (revision gate).
    expect(presentationStore.get()?.revision).toBe(5);
    // The redundant stale registration is paired with one unsubscribe; the
    // window stays subscribed.
    expect(harness.unsubscribeCalls).toBeLessThan(harness.subscribeCalls);
  });

  it("ignores stale late pushes after unmount", async () => {
    const harness = installBridge();
    const { PresentationSync } = await import("./presentationBoot");

    await act(async () => {
      root.render(createElement(PresentationSync));
    });
    harness.resolveSubscribe(appliedState(2));
    await flush();
    expect(presentationStore.get()?.revision).toBe(2);

    await act(async () => root.unmount());
    await flush();
    expect(presentationStore.get()).toBeNull();
    expect(document.querySelector("style[data-dokkabi-presentation-override]")).toBeNull();
    // A late push after teardown changes nothing.
    harness.push(appliedState(9));
    await flush();
    expect(presentationStore.get()).toBeNull();
    expect(document.querySelector("style[data-dokkabi-presentation-override]")).toBeNull();
  });

  it("discards invalid push payloads and surfaces visible read failures", async () => {
    const harness = installBridge();
    const { PresentationSync, ConnectionErrorReporter } = await import("./presentationBoot");

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(PresentationSync),
          createElement(ConnectionErrorReporter),
        ),
      );
    });
    harness.push({ schemaVersion: 1, revision: 99 });
    expect(presentationStore.get()).toBeNull();
    // The invalid push leaves a visible operator diagnostic.
    await flush();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("digest");

    harness.rejectSubscribe(new Error("host read failed"));
    await flush();
    // The failure is surfaced visibly, not swallowed; the push listener stays
    // armed.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("host read failed");
    harness.push(appliedState(4));
    expect(presentationStore.get()?.revision).toBe(4);
  });

  it("retains the diagnostic for an invalid initial payload", async () => {
    const harness = installBridge();
    const { PresentationSync, ConnectionErrorReporter } = await import("./presentationBoot");

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(PresentationSync),
          createElement(ConnectionErrorReporter),
        ),
      );
    });
    // The host read resolves with a payload that fails validation.
    harness.resolveSubscribe({ schemaVersion: 1, revision: 99 } as PresentationAppliedState);
    await flush();
    expect(presentationStore.get()).toBeNull();
    // The invalid-initial-payload diagnostic must stay visible; it is not
    // cleared by the arrival of the (rejected) payload itself.
    expect(presentationConnectionError()).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("digest");
    harness.push(appliedState(5));
    expect(presentationStore.get()?.revision).toBe(5);
  });

  it("does not unsubscribe the healthy owner when a retry's subscribe rejects", async () => {
    const harness = installBridge();
    const { PresentationSync, retryPresentationConnection } = await import("./presentationBoot");

    await act(async () => {
      root.render(createElement(PresentationSync));
    });
    harness.resolveSubscribe(appliedState(2));
    await flush();
    expect(harness.unsubscribeCalls).toBe(0);

    // A rejected retry never registered on the host; balancing it would
    // decrement the healthy owned registration.
    harness.enqueueSubscribeError(new Error("transient read failure"));
    let retryError: unknown = null;
    await act(async () => {
      await retryPresentationConnection().catch((error: unknown) => {
        retryError = error;
      });
    });
    await flush();
    expect(harness.subscribeCalls).toBe(2);
    expect(harness.unsubscribeCalls).toBe(0);
    expect(presentationConnectionError()).toContain("transient read failure");
    // The owned session still receives pushes.
    harness.push(appliedState(3));
    expect(presentationStore.get()?.revision).toBe(3);
    expect(retryError).toBeNull();
  });

  it("balances a successful retry registration exactly once", async () => {
    const harness = installBridge();
    const { PresentationSync, retryPresentationConnection } = await import("./presentationBoot");

    await act(async () => {
      root.render(createElement(PresentationSync));
    });
    harness.resolveSubscribe(appliedState(2));
    await flush();
    expect(harness.unsubscribeCalls).toBe(0);

    harness.enqueueSubscribeState(appliedState(7));
    await act(async () => {
      await retryPresentationConnection();
    });
    await flush();
    // The retry's transient registration is paired with exactly one
    // unsubscribe; the owned registration is untouched.
    expect(harness.subscribeCalls).toBe(2);
    expect(harness.unsubscribeCalls).toBe(1);
    expect(presentationStore.get()?.revision).toBe(7);
    expect(presentationConnectionError()).toBeNull();
    // The owned session still receives pushes afterwards.
    harness.push(appliedState(8));
    expect(presentationStore.get()?.revision).toBe(8);
  });
});
