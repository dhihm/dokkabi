/**
 * Typed presentation IPC methods.
 *
 * Subscription is not authorization: every method validates that the IPC
 * sender is the webContents of the actual current main window (identity from
 * the sender event, checked against the window service — never a
 * renderer-supplied value). Preview, PiP, permission and unregistered
 * windows are refused. All handlers go through the one DesktopPresentation
 * host service.
 */
import {
  PresentationAppliedStateSchema,
  PresentationResetResultSchema,
  PresentationSaveInputSchema,
  PresentationSaveResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopPresentation from "../../presentation/DesktopPresentation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** Refuses operations from senders the host never registered. */
class PresentationSenderRefusedError extends Schema.TaggedError<PresentationSenderRefusedError>()(
  "PresentationSenderRefusedError",
  { channel: Schema.String },
) {
  override get message(): string {
    return `Refused a presentation IPC call on ${this.channel} from a sender that is not the main window.`;
  }
}

interface MainWindowLike {
  readonly isDestroyed: () => boolean;
  readonly webContents: { readonly id: number };
}

/** True when the sender id belongs to the live current main window. */
export function isSenderMainWindow(
  main: MainWindowLike | null,
  senderId: number | undefined,
): senderId is number {
  return (
    senderId !== undefined &&
    main !== null &&
    !main.isDestroyed() &&
    main.webContents.id === senderId
  );
}

const requireMainWindowSender = (
  channel: string,
  event?: DesktopIpc.DesktopIpcInvokeEvent,
): Effect.Effect<number, PresentationSenderRefusedError, ElectronWindow.ElectronWindow> =>
  Effect.gen(function* () {
    // ElectronWindow.main is the actual registered main window — the
    // any-first-window fallback must never authorize presentation control.
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const main = yield* electronWindow.main;
    const senderId = event?.sender.id;
    if (isSenderMainWindow(Option.getOrNull(main), senderId)) {
      return senderId;
    }
    return yield* new PresentationSenderRefusedError({ channel });
  });

export const subscribePresentation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PRESENTATION_SUBSCRIBE_CHANNEL,
  payload: Schema.Void,
  result: PresentationAppliedStateSchema,
  handler: Effect.fn("desktop.ipc.presentation.subscribe")(function* (_input, event) {
    const service = yield* DesktopPresentation.DesktopPresentation;
    const senderId = yield* requireMainWindowSender("subscribe", event);
    // Register before reading state so the initial read cannot race a push.
    yield* service.registerTrustedSender(senderId);
    return yield* service.getState;
  }),
});

export const unsubscribePresentation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PRESENTATION_UNSUBSCRIBE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.presentation.unsubscribe")(function* (_input, event) {
    const service = yield* DesktopPresentation.DesktopPresentation;
    const senderId = yield* requireMainWindowSender("unsubscribe", event);
    yield* service.unregisterTrustedSender(senderId);
  }),
});

export const reloadPresentation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PRESENTATION_RELOAD_CHANNEL,
  payload: Schema.Void,
  result: PresentationAppliedStateSchema,
  handler: Effect.fn("desktop.ipc.presentation.reload")(function* (_input, event) {
    const service = yield* DesktopPresentation.DesktopPresentation;
    yield* requireMainWindowSender("reload", event);
    return yield* service.reload;
  }),
});

export const savePresentation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PRESENTATION_SAVE_CHANNEL,
  payload: PresentationSaveInputSchema,
  result: PresentationSaveResultSchema,
  handler: Effect.fn("desktop.ipc.presentation.save")(function* (input, event) {
    const service = yield* DesktopPresentation.DesktopPresentation;
    yield* requireMainWindowSender("save", event);
    return yield* service.save(input);
  }),
});

export const resetPresentation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PRESENTATION_RESET_CHANNEL,
  payload: Schema.Void,
  result: PresentationResetResultSchema,
  handler: Effect.fn("desktop.ipc.presentation.reset")(function* (_input, event) {
    const service = yield* DesktopPresentation.DesktopPresentation;
    yield* requireMainWindowSender("reset", event);
    return yield* service.reset;
  }),
});
