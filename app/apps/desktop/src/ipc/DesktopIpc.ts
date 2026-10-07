import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  DESKTOP_SYNC_IPC_REFUSED_MESSAGE,
  DESKTOP_SYNC_IPC_REFUSED_TYPE,
  type DesktopSyncIpcRefusal,
} from "@t3tools/contracts";

export interface DesktopIpcInvokeEvent {
  readonly sender: { readonly id: number };
}

export interface DesktopIpcSyncEvent {
  returnValue: unknown;
  /**
   * The real webContents sender Electron attaches to the event. Optional for
   * historical handlers and fixtures that never authorize by identity;
   * credential-bearing handlers must require it before reading services.
   */
  readonly sender?: { readonly id: number } | undefined;
}

export type DesktopIpcHandleListener = (
  event: DesktopIpcInvokeEvent,
  raw: unknown,
) => unknown | Promise<unknown>;

export type DesktopIpcSyncListener = (event: DesktopIpcSyncEvent) => void;

export interface DesktopIpcMain {
  removeHandler(channel: string): void;
  handle(channel: string, listener: DesktopIpcHandleListener): void;
  removeAllListeners(channel: string): void;
  on(channel: string, listener: DesktopIpcSyncListener): void;
}

export class DesktopIpcRegistrationError extends Schema.TaggedError<DesktopIpcRegistrationError>()(
  "DesktopIpcRegistrationError",
  {
    handlerKind: Schema.Literals(["invoke", "sync"]),
    channel: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export class DesktopIpcUnregistrationError extends Schema.TaggedError<DesktopIpcUnregistrationError>()(
  "DesktopIpcUnregistrationError",
  {
    handlerKind: Schema.Literals(["invoke", "sync"]),
    channel: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export const DesktopIpcError = Schema.Union([
  DesktopIpcRegistrationError,
  DesktopIpcUnregistrationError,
]);
export type DesktopIpcError = typeof DesktopIpcError.Type;

/** The bounded sanitized answer a failed synchronous handler returns. */
export function desktopSyncIpcRefusal(): DesktopSyncIpcRefusal {
  return {
    type: DESKTOP_SYNC_IPC_REFUSED_TYPE,
    message: DESKTOP_SYNC_IPC_REFUSED_MESSAGE,
  };
}

export interface DesktopIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: (raw: unknown, event?: DesktopIpcInvokeEvent) => Effect.Effect<unknown, E, R>;
}

export interface DesktopSyncIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: (event?: DesktopIpcSyncEvent) => Effect.Effect<unknown, E, R>;
}

export class DesktopIpc extends Context.Service<
  DesktopIpc,
  {
    readonly handle: <E, R>(
      input: DesktopIpcMethod<E, R>,
    ) => Effect.Effect<void, DesktopIpcRegistrationError, R | Scope.Scope>;
    readonly handleSync: <E, R>(
      input: DesktopSyncIpcMethod<E, R>,
    ) => Effect.Effect<void, DesktopIpcRegistrationError, R | Scope.Scope>;
  }
>()("@t3tools/desktop/ipc/DesktopIpc") {}

export const make = (ipcMain: DesktopIpcMain): DesktopIpc["Service"] =>
  DesktopIpc.of({
    handle: Effect.fn("desktop.ipc.registerInvoke")(function* <E, R>({
      channel,
      handler,
    }: DesktopIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runPromise = Effect.runPromiseWith(context);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (event, raw) =>
              runPromise(
                Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({ channel });
                  return yield* handler(raw, event);
                }).pipe(Effect.annotateLogs({ channel }), Effect.withSpan("desktop.ipc.invoke")),
              ),
            );
          },
          catch: (cause) =>
            new DesktopIpcRegistrationError({ handlerKind: "invoke", channel, cause }),
        }),
        () =>
          Effect.try({
            try: () => ipcMain.removeHandler(channel),
            catch: (cause) =>
              new DesktopIpcUnregistrationError({ handlerKind: "invoke", channel, cause }),
          }).pipe(Effect.orDie),
      );
    }),

    handleSync: Effect.fn("desktop.ipc.registerSync")(function* <E, R>({
      channel,
      handler,
    }: DesktopSyncIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runSyncExit = Effect.runSyncWith(context);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            ipcMain.removeAllListeners(channel);
            ipcMain.on(channel, (event) => {
              // The real Electron event (sender included) reaches the handler
              // untouched. A failed or defective handler never throws out of
              // this native listener: the boundary answers with the bounded,
              // sanitized refusal envelope — no private cause detail, no
              // empty success that a renderer could mistake for real data.
              const exit = runSyncExit(
                Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({ channel });
                  return yield* handler(event);
                }).pipe(
                  Effect.annotateLogs({ channel }),
                  Effect.withSpan("desktop.ipc.invokeSync"),
                  Effect.exit,
                ),
              );
              event.returnValue = Exit.match(exit, {
                onSuccess: (value) => value,
                onFailure: () => desktopSyncIpcRefusal(),
              });
            });
          },
          catch: (cause) =>
            new DesktopIpcRegistrationError({ handlerKind: "sync", channel, cause }),
        }),
        () =>
          Effect.try({
            try: () => ipcMain.removeAllListeners(channel),
            catch: (cause) =>
              new DesktopIpcUnregistrationError({ handlerKind: "sync", channel, cause }),
          }).pipe(Effect.orDie),
      );
    }),
  });

export const layer = (ipcMain: DesktopIpcMain) => Layer.succeed(DesktopIpc, make(ipcMain));

/**
 * Convenience helpers for creating IPC methods
 */

export interface DesktopIpcMethodRegistration<
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly payload: Schema.Codec<
    Payload,
    EncodedPayload,
    PayloadDecodingServices,
    PayloadEncodingServices
  >;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  readonly handler: (input: Payload, event?: DesktopIpcInvokeEvent) => Effect.Effect<Result, E, R>;
}

export const makeIpcMethod = <
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopIpcMethodRegistration<
    Payload,
    EncodedPayload,
    Result,
    EncodedResult,
    E,
    R,
    PayloadDecodingServices,
    PayloadEncodingServices,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopIpcMethod<
  E | Schema.SchemaError,
  R | PayloadDecodingServices | ResultEncodingServices
> => {
  const decode = Schema.decodeUnknownEffect(method.payload);
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: (raw, event) =>
      decode(raw).pipe(
        Effect.flatMap((input) => method.handler(input, event)),
        Effect.flatMap(encode),
        Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
      ),
  };
};

export interface DesktopSyncIpcMethodRegistration<
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  readonly handler: (event?: DesktopIpcSyncEvent) => Effect.Effect<Result, E, R>;
}

export const makeSyncIpcMethod = <
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopSyncIpcMethodRegistration<
    Result,
    EncodedResult,
    E,
    R,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopSyncIpcMethod<E | Schema.SchemaError, R | ResultEncodingServices> => {
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: (event) =>
      method
        .handler(event)
        .pipe(
          Effect.flatMap(encode),
          Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
        ),
  };
};
