/**
 * Electron integration for the presentation host.
 *
 * Pushes applied presentation states to registered renderers over the typed
 * presentation state channel, and reports sender liveness so destroyed
 * windows drop off the push list. Native window minimums are owned by
 * DesktopWindow (main window only), not by this integration.
 */
import { PresentationAppliedStateSchema, type PresentationAppliedState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import type { PresentationWindowIntegration } from "./DesktopPresentation.ts";

const encodeState = Schema.encodeUnknownSync(PresentationAppliedStateSchema);

export const makeElectronPresentationIntegration = (input: {
  readonly electron: typeof Electron;
  readonly stateChannel: string;
}): PresentationWindowIntegration => {
  const { electron, stateChannel } = input;

  return {
    pushState: (webContentsId, state: PresentationAppliedState) =>
      Effect.sync(() => {
        const contents = electron.webContents.fromId(webContentsId);
        if (contents === undefined || contents.isDestroyed()) return;
        contents.send(stateChannel, encodeState(state));
      }),
    isSenderAlive: (webContentsId) => {
      const contents = electron.webContents.fromId(webContentsId);
      return contents !== undefined && !contents.isDestroyed();
    },
  };
};
