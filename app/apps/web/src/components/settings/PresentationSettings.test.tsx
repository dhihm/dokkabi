// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  PresentationAppliedState,
  PresentationResetResult,
  PresentationSaveInput,
  PresentationSaveResult,
} from "@t3tools/contracts";
import {
  PRESENTATION_GRAPH_LAYOUT_DEFAULTS,
  PRESENTATION_RECORD_COMPANION_LAYOUT_DEFAULTS,
} from "@t3tools/contracts";

import {
  presentationStore,
  setPresentationConnectionError,
  setPresentationState,
} from "../../presentationStore";
import { resetPresentationSurfaceRegistryForTest } from "../../presentationLayoutSnapshot";

vi.mock("./settingsLayout", async () => {
  const { createElement } = await import("react");
  return {
    SettingsSection: (props: { id: string; title: string; children: ReactNode }) =>
      createElement("section", { "data-settings-section": props.id }, props.children),
  };
});

const { PresentationSettings } = await import("./PresentationSettings");

const appliedState = (revision: number, document_: string = "{}"): PresentationAppliedState => ({
  schemaVersion: 1,
  revision,
  digest: `${revision}`.padEnd(64, "0"),
  location: "/private/tmp/dokkabi-presentation-settings/desktop/presentation.json",
  status: "applied",
  overrideDocument: document_,
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

interface BridgeHarness {
  readonly saveCalls: Array<PresentationSaveInput>;
  readonly reloadCalls: number;
  readonly resetCalls: number;
  readonly subscribeCalls: number;
  readonly respondSave: (result: PresentationSaveResult) => void;
  readonly respondReload: (state: PresentationAppliedState) => void;
  readonly respondReset: (result: PresentationResetResult) => void;
  readonly respondSubscribe: (state: PresentationAppliedState) => void;
}

const installBridge = (): BridgeHarness => {
  let respondSave: (result: PresentationSaveResult) => void = () => {};
  let respondReload: (state: PresentationAppliedState) => void = () => {};
  let respondReset: (result: PresentationResetResult) => void = () => {};
  let respondSubscribe: (state: PresentationAppliedState) => void = () => {};
  let subscribeCalls = 0;
  let reloadCalls = 0;
  let resetCalls = 0;
  const saveCalls: Array<PresentationSaveInput> = [];
  const bridge = {
    presentation: {
      subscribe: () => {
        subscribeCalls += 1;
        return new Promise<PresentationAppliedState>((resolve) => {
          respondSubscribe = resolve;
        });
      },
      unsubscribe: () => Promise.resolve(),
      reload: () =>
        new Promise<PresentationAppliedState>((resolve) => {
          reloadCalls += 1;
          respondReload = resolve;
        }),
      save: (input: PresentationSaveInput) => {
        saveCalls.push(input);
        return new Promise<PresentationSaveResult>((resolve) => {
          respondSave = resolve;
        });
      },
      reset: () =>
        new Promise<PresentationResetResult>((resolve) => {
          resetCalls += 1;
          respondReset = resolve;
        }),
    },
    onPresentationState: () => () => {},
    getZoomFactor: () => 1,
  };
  vi.stubGlobal("desktopBridge", bridge);
  return {
    saveCalls,
    get subscribeCalls() {
      return subscribeCalls;
    },
    get reloadCalls() {
      return reloadCalls;
    },
    get resetCalls() {
      return resetCalls;
    },
    respondSave: (result) => respondSave(result),
    respondReload: (state) => respondReload(state),
    respondReset: (result) => respondReset(result),
    respondSubscribe: (state) => respondSubscribe(state),
  };
};

const flush = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const editorTextarea = (container: HTMLElement): HTMLTextAreaElement => {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).not.toBeNull();
  return textarea!;
};

const textareaValueSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value",
)!.set!;

/**
 * Edits the editor the way a real user does: through the native value setter
 * (React's value tracker ignores direct `.value` assignment) and a bubbling
 * input event inside act.
 */
const setEditorText = async (textarea: HTMLTextAreaElement, text: string): Promise<void> => {
  await act(async () => {
    textareaValueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const saveButton = (container: HTMLElement): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("Save"),
  );
  expect(button, "Save button").toBeDefined();
  return button as HTMLButtonElement;
};

const clickButton = (container: HTMLElement, label: string): void => {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button, `button ${label}`).toBeDefined();
  button!.click();
};

const draftDocument = (background: string): string =>
  `${JSON.stringify({ schemaVersion: 1, tokens: { color: { background } } }, null, 2)}\n`;

describe("PresentationSettings", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setPresentationState(null);
    setPresentationConnectionError(null);
    resetPresentationSurfaceRegistryForTest();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(PresentationSettings));
    });
    await flush();
  };

  it("saves a dirty draft against its base revision, not the latest external push", async () => {
    const harness = installBridge();
    setPresentationState(appliedState(2, draftDocument("#101418")));
    await render();
    const textarea = editorTextarea(container);
    // A valid registered-field draft (stale candidate): if this were sent
    // with the wrong expected revision, it would silently overwrite the
    // external edit below.
    const dirtyDraft = draftDocument("#15191d");
    await setEditorText(textarea, dirtyDraft);
    // The edit actually landed: Save is enabled and the text survived.
    expect(textarea.value).toBe(dirtyDraft);
    expect(saveButton(container).disabled).toBe(false);
    // External edit: the host publishes revision 3 while the draft is dirty.
    setPresentationState(appliedState(3, draftDocument("#f8f8f8")));
    await flush();
    await act(async () => {
      clickButton(container, "Save");
    });
    harness.respondSave({
      type: "conflict",
      state: appliedState(3, draftDocument("#f8f8f8")),
      message: "expected revision 2 but the applied revision is 3; reload and retry",
    });
    await flush();
    // The save was bound to the revision the draft was loaded from.
    expect(harness.saveCalls.map((call) => call.expectedRevision)).toEqual([2]);
    expect(harness.saveCalls[0]?.document).toContain("#15191d");
    // The dirty draft is preserved, not silently rebased or discarded.
    expect(textarea.value).toBe(dirtyDraft);
    // The conflict is visible and the external revision stays applied.
    expect(container.querySelector('[role="status"]')?.textContent).toContain("revision");
    expect(presentationStore.get()?.revision).toBe(3);
    expect(presentationStore.get()?.overrideDocument).toContain("#f8f8f8");
  });

  it("applies the reload receipt through the monotonic path and keeps the dirty draft", async () => {
    const harness = installBridge();
    setPresentationState(appliedState(2, draftDocument("#101418")));
    await render();
    const textarea = editorTextarea(container);
    const dirtyDraft = draftDocument("#1b1f24");
    await setEditorText(textarea, dirtyDraft);
    expect(saveButton(container).disabled).toBe(false);
    await act(async () => {
      clickButton(container, "Reload");
    });
    harness.respondReload(appliedState(5, draftDocument("#f8f8f8")));
    await flush();
    // The reload receipt reached the store through the validated path.
    expect(presentationStore.get()?.revision).toBe(5);
    // Defined reload behavior: the dirty draft is preserved with a visible
    // note; only an explicit editor action may discard it.
    expect(textarea.value).toBe(dirtyDraft);
    expect(container.textContent).toContain("Unsaved changes");
    // A later save still uses the draft's base revision, not revision 5.
    await act(async () => {
      clickButton(container, "Save");
    });
    harness.respondSave({ type: "conflict", state: presentationStore.get()!, message: "stale" });
    await flush();
    expect(harness.saveCalls.map((call) => call.expectedRevision)).toEqual([2]);
  });

  it("applies save and reset receipts through the same validated path", async () => {
    const harness = installBridge();
    setPresentationState(appliedState(2, draftDocument("#101418")));
    await render();
    const textarea = editorTextarea(container);
    const edited = draftDocument("#12161a");
    await setEditorText(textarea, edited);
    await act(async () => {
      clickButton(container, "Save");
    });
    harness.respondSave({ type: "applied", state: appliedState(3, edited) });
    await flush();
    expect(presentationStore.get()?.revision).toBe(3);

    await act(async () => {
      clickButton(container, "Reset override");
    });
    harness.respondReset({ type: "applied", state: appliedState(4, "") });
    await flush();
    expect(presentationStore.get()?.revision).toBe(4);
  });

  it("keeps text that arrives during a pending save (deferred success)", async () => {
    const harness = installBridge();
    setPresentationState(appliedState(2, draftDocument("#101418")));
    await render();
    const textarea = editorTextarea(container);
    const firstDraft = draftDocument("#15191d");
    await setEditorText(textarea, firstDraft);
    await act(async () => {
      clickButton(container, "Save");
    });
    // The editor locks while a write is pending…
    expect(textarea.readOnly).toBe(true);
    // …but if an edit still races in (queued input, assistive tooling), its
    // text must survive the applied receipt.
    await setEditorText(textarea, draftDocument("#1b1f24"));
    harness.respondSave({ type: "applied", state: appliedState(3, firstDraft) });
    await flush();
    expect(textarea.value).toContain("#1b1f24");
    expect(container.textContent).toContain("Unsaved changes");
    // The next save carries the newer text.
    await act(async () => {
      clickButton(container, "Save");
    });
    harness.respondSave({ type: "applied", state: appliedState(4, draftDocument("#1b1f24")) });
    await flush();
    expect(harness.saveCalls[1]?.document).toContain("#1b1f24");
    expect(harness.saveCalls[1]?.expectedRevision).toBe(3);
  });

  it("recovers from a conflict through the explicit discard-and-load action", async () => {
    const harness = installBridge();
    setPresentationState(appliedState(2, draftDocument("#101418")));
    await render();
    const textarea = editorTextarea(container);
    const staleDraft = draftDocument("#15191d");
    await setEditorText(textarea, staleDraft);
    setPresentationState(appliedState(3, draftDocument("#f8f8f8")));
    await flush();
    await act(async () => {
      clickButton(container, "Save");
    });
    harness.respondSave({
      type: "conflict",
      state: appliedState(3, draftDocument("#f8f8f8")),
      message: "expected revision 2 but the applied revision is 3; reload and retry",
    });
    await flush();
    expect(textarea.value).toBe(staleDraft);

    // Explicit operator intent: adopt the newer applied content into the
    // editor. The host override is not written by this action.
    await act(async () => {
      clickButton(container, "Discard draft and load current");
    });
    await flush();
    expect(textarea.value).toContain("#f8f8f8");
    expect(container.textContent).not.toContain("Unsaved changes");
    expect(harness.saveCalls).toHaveLength(1);

    // Editing and saving now uses the adopted revision as the new base.
    const adoptedDraft = draftDocument("#eef1f4");
    await setEditorText(textarea, adoptedDraft);
    await act(async () => {
      clickButton(container, "Save");
    });
    harness.respondSave({
      type: "applied",
      state: appliedState(4, adoptedDraft),
    });
    await flush();
    expect(harness.saveCalls[1]?.expectedRevision).toBe(3);
    expect(harness.saveCalls[1]?.document).toBe(adoptedDraft);
  });

  it("labels a source I/O error distinctly from invalid file content", async () => {
    installBridge();
    const unreadable = appliedState(2, "{}");
    setPresentationState({
      ...unreadable,
      status: "invalid",
      error: {
        kind: "io",
        message: "the presentation file watcher stopped: simulated failure",
        path: null,
        line: null,
        column: null,
      },
    });
    await render();
    expect(container.textContent).toContain("source I/O error — last-valid kept (revision 2)");
    expect(container.textContent).not.toContain("invalid file — last-valid kept");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("watcher stopped");
  });

  it("surfaces connection errors with a retry control that recovers", async () => {
    const harness = installBridge();
    setPresentationState(appliedState(2, "{}"));
    await render();
    setPresentationConnectionError(
      "Could not read the initial presentation state: host read failed",
    );
    await flush();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("host read failed");
    // Retry is explicit: it re-reads through the bridge, and the recovered
    // state is applied through the validated path.
    await act(async () => {
      clickButton(container, "Retry connection");
    });
    await flush();
    expect(harness.subscribeCalls).toBe(1);
    harness.respondSubscribe(appliedState(6, "{}"));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent ?? "").not.toContain(
      "host read failed",
    );
    expect(presentationStore.get()?.revision).toBe(6);
  });

  it("captures a layout snapshot of the registered surfaces on demand", async () => {
    installBridge();
    setPresentationState(appliedState(2, "{}"));
    await render();
    const surface = document.createElement("div");
    surface.style.fontSize = "13px";
    document.body.append(surface);
    const { presentationSurfaceRef } = await import("../../presentationLayoutSnapshot");
    const detach = presentationSurfaceRef("navigation")(surface);
    try {
      await act(async () => {
        clickButton(container, "Capture layout snapshot");
      });
      await flush();
      const display = container.querySelector("[data-presentation-snapshot]");
      expect(display).not.toBeNull();
      const text = display?.textContent ?? "";
      expect(text).toContain('"configRevision": 2');
      expect(text).toContain("navigation");
      expect(text).toContain("measured");
      // Unregistered surfaces are explicitly absent, never faked.
      expect(text).toContain("absent");
    } finally {
      detach?.();
      surface.remove();
    }
  });
});
