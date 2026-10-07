/**
 * Restricted Record companion preload (Dokkabi R6).
 *
 * The ONLY bridge this preload exposes is `window.recordCompanion`, bound to
 * the closed companion channels: bootstrap, ready, quiesce, dock, viewAction
 * and the pushed snapshot/activation events. There is deliberately NO
 * desktopBridge, NO Clerk bridge, NO generic invoke, NO openURL, settings,
 * files, provider or terminal surface — a compromised companion renderer
 * starts from exactly this vocabulary and nothing else.
 */
import type { RecordCompanionBridge, RecordCompanionChildEvent } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

contextBridge.exposeInMainWorld("recordCompanion", {
  bootstrap: () => ipcRenderer.invoke(IpcChannels.RECORD_COMPANION_CHILD_BOOTSTRAP_CHANNEL),
  ready: (input) => ipcRenderer.invoke(IpcChannels.RECORD_COMPANION_CHILD_READY_CHANNEL, input),
  quiesce: (input) => ipcRenderer.invoke(IpcChannels.RECORD_COMPANION_CHILD_QUIESCE_CHANNEL, input),
  requestDock: (input) =>
    ipcRenderer.invoke(IpcChannels.RECORD_COMPANION_CHILD_DOCK_CHANNEL, input),
  viewAction: (input) =>
    ipcRenderer.invoke(IpcChannels.RECORD_COMPANION_CHILD_VIEW_ACTION_CHANNEL, input),
  onEvent: (listener: (event: RecordCompanionChildEvent) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (typeof payload !== "object" || payload === null || !("type" in payload)) return;
      const candidate = payload as { type: unknown };
      if (
        candidate.type !== "snapshot" &&
        candidate.type !== "activated" &&
        candidate.type !== "docking" &&
        candidate.type !== "closed"
      ) {
        return;
      }
      listener(payload as RecordCompanionChildEvent);
    };
    ipcRenderer.on(IpcChannels.RECORD_COMPANION_CHILD_EVENT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.RECORD_COMPANION_CHILD_EVENT_CHANNEL, wrappedListener);
    };
  },
} satisfies RecordCompanionBridge);
