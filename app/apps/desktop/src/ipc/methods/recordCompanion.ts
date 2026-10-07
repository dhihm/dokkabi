/**
 * Typed Record companion IPC methods (Dokkabi R6).
 *
 * Two closed edges, both authorized by actual webContents identity from the
 * sender event — never a renderer-provided value:
 *
 * - Owner methods require the CURRENT main window (the same guard the
 *   presentation host uses); a companion, preview or unregistered window is
 *   refused before the registry is read.
 * - Companion methods require the exact registered child of the named
 *   companion (the registry enforces it through the placement machine); a
 *   foreign or stale child sender is refused.
 *
 * The companion surface carries ONLY bootstrap/ready/quiesce/dock/viewAction:
 * no main DesktopBridge, no generic invoke, no settings, files, provider or
 * terminal reach exists on these channels.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  RecordCompanionAckInputSchema,
  RecordCompanionBootstrapSchema,
  RecordCompanionHandoffAckInputSchema,
  RecordCompanionOpenInputSchema,
  RecordCompanionOpenResultSchema,
  RecordCompanionPlacementState,
  RecordCompanionRelayInputSchema,
  RecordCompanionViewActionInputSchema,
} from "@t3tools/contracts";

import * as RecordCompanionRegistry from "../../companion/RecordCompanionRegistry.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { isSenderMainWindow } from "./presentation.ts";

/** Refuses owner operations from senders the host never registered. */
class RecordCompanionSenderRefusedError extends Schema.TaggedError<RecordCompanionSenderRefusedError>()(
  "RecordCompanionSenderRefusedError",
  { channel: Schema.String },
) {
  override get message(): string {
    return `Refused a record companion IPC call on ${this.channel} from a sender that is not the main window.`;
  }
}

const requireOwnerSender = (
  channel: string,
  event?: DesktopIpc.DesktopIpcInvokeEvent,
): Effect.Effect<number, RecordCompanionSenderRefusedError, ElectronWindow.ElectronWindow> =>
  Effect.gen(function* () {
    const senderId = event?.sender.id;
    if (senderId === undefined) {
      return yield* new RecordCompanionSenderRefusedError({ channel });
    }
    // The owner must be the ACTUAL registered main window, never the
    // any-first-window fallback a companion could occupy.
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const main = yield* electronWindow.main;
    if (!isSenderMainWindow(Option.getOrNull(main), senderId)) {
      return yield* new RecordCompanionSenderRefusedError({ channel });
    }
    return senderId;
  });

export const subscribeRecordCompanion = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_SUBSCRIBE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(RecordCompanionPlacementState),
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    _input: void,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const ownerSenderId = yield* requireOwnerSender("subscribe", event);
    return yield* registry.subscribeOwner(ownerSenderId);
  }),
});

export const openRecordCompanion = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_OPEN_CHANNEL,
  payload: RecordCompanionOpenInputSchema,
  result: RecordCompanionOpenResultSchema,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const ownerSenderId = yield* requireOwnerSender("open", event);
    return yield* registry.open(ownerSenderId, input);
  }),
});

export const reopenRecordCompanion = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_REOPEN_CHANNEL,
  payload: RecordCompanionOpenInputSchema,
  result: RecordCompanionOpenResultSchema,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const ownerSenderId = yield* requireOwnerSender("reopen", event);
    return yield* registry.reopen(ownerSenderId, input.scope, input);
  }),
});

export const relayRecordCompanionSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_RELAY_CHANNEL,
  payload: RecordCompanionRelayInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const ownerSenderId = yield* requireOwnerSender("relay", event);
    yield* registry.relay(ownerSenderId, input.companionId, input.snapshot);
  }),
});

export const ackRecordCompanionDetach = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_ACK_DETACH_CHANNEL,
  payload: RecordCompanionAckInputSchema,
  result: RecordCompanionPlacementState,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const ownerSenderId = yield* requireOwnerSender("ackDetach", event);
    return yield* registry.ackDetach(ownerSenderId, input.companionId, input.revision);
  }),
});

export const ackRecordCompanionDock = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_ACK_DOCK_CHANNEL,
  payload: RecordCompanionAckInputSchema,
  result: RecordCompanionPlacementState,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const ownerSenderId = yield* requireOwnerSender("ackDock", event);
    return yield* registry.ackDock(ownerSenderId, input.companionId, input.revision);
  }),
});

export const companionBootstrap = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_CHILD_BOOTSTRAP_CHANNEL,
  payload: Schema.Void,
  result: RecordCompanionBootstrapSchema,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    _input: void,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const childSenderId = event?.sender.id;
    if (childSenderId === undefined) {
      return yield* new RecordCompanionSenderRefusedError({ channel: "childBootstrap" });
    }
    return yield* registry.companionBootstrap(childSenderId);
  }),
});

export const companionReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_CHILD_READY_CHANNEL,
  payload: RecordCompanionHandoffAckInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const childSenderId = event?.sender.id;
    if (childSenderId === undefined) {
      return yield* new RecordCompanionSenderRefusedError({ channel: "childReady" });
    }
    yield* registry.companionReady(childSenderId, input.revision, input.handoff);
  }),
});

export const companionQuiesce = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_CHILD_QUIESCE_CHANNEL,
  payload: RecordCompanionHandoffAckInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const childSenderId = event?.sender.id;
    if (childSenderId === undefined) {
      return yield* new RecordCompanionSenderRefusedError({ channel: "childQuiesce" });
    }
    yield* registry.companionQuiesce(childSenderId, input.revision, input.handoff);
  }),
});

export const companionRequestDock = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_CHILD_DOCK_CHANNEL,
  payload: RecordCompanionAckInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const childSenderId = event?.sender.id;
    if (childSenderId === undefined) {
      return yield* new RecordCompanionSenderRefusedError({ channel: "childDock" });
    }
    yield* registry.companionRequestDock(childSenderId, input.revision);
  }),
});

export const companionViewAction = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECORD_COMPANION_CHILD_VIEW_ACTION_CHANNEL,
  payload: RecordCompanionViewActionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.recordCompanion")(function* (
    input,
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const registry = yield* RecordCompanionRegistry.RecordCompanionRegistry;
    const childSenderId = event?.sender.id;
    if (childSenderId === undefined) {
      return yield* new RecordCompanionSenderRefusedError({ channel: "childViewAction" });
    }
    yield* registry.companionViewAction(childSenderId, input.viewRevision, input.action);
  }),
});
