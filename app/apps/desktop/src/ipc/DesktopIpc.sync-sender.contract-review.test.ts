import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "./DesktopIpc.ts";

class ControlledRefusal extends Schema.TaggedError<ControlledRefusal>()("ControlledRefusal", {
  message: Schema.String,
}) {}
const serializeWire = (value: unknown) => JSON.stringify(value);

describe("R6 independent real synchronous IPC sender forwarding", () => {
  it("retains sender through both schema wrapper and registered Electron callback", async () => {
    let callback: DesktopIpc.DesktopIpcSyncListener | undefined;
    const ipc = DesktopIpc.make({
      removeHandler: vi.fn(),
      handle: vi.fn(),
      removeAllListeners: vi.fn(),
      on: (_channel, fn) => {
        callback = fn;
      },
    });
    const method = DesktopIpc.makeSyncIpcMethod({
      channel: "controlled.sync.source",
      result: Schema.Number,
      handler: (event) => Effect.succeed(event?.sender?.id ?? -1),
    });
    const event = { sender: { id: 20 }, returnValue: undefined as unknown };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handleSync(method);
          callback!(event);
          expect(event.returnValue).toBe(20);
        }),
      ),
    );
  });
  it("returns an explicit refusal without throwing out of the native synchronous listener", async () => {
    let callback: DesktopIpc.DesktopIpcSyncListener | undefined;
    const ipc = DesktopIpc.make({
      removeHandler: vi.fn(),
      handle: vi.fn(),
      removeAllListeners: vi.fn(),
      on: (_channel, fn) => {
        callback = fn;
      },
    });
    const method = DesktopIpc.makeSyncIpcMethod({
      channel: "controlled.sync.denied",
      result: Schema.String,
      handler: () =>
        Effect.fail(new ControlledRefusal({ message: "private-fixture-detail-must-not-leak" })),
    });
    const event = { sender: { id: 20 }, returnValue: undefined as unknown };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handleSync(method);
          expect(() => callback!(event)).not.toThrow();
          expect(event.returnValue).toMatchObject({ type: "desktop-sync-ipc-refused" });
          expect(serializeWire(event.returnValue)).not.toContain(
            "private-fixture-detail-must-not-leak",
          );
        }),
      ),
    );
  });
  it("preserves old nonsensitive synchronous handlers without event dependency", async () => {
    const method = DesktopIpc.makeSyncIpcMethod({
      channel: "controlled.sync.compatibility",
      result: Schema.String,
      handler: () => Effect.succeed("fixed-public-fixture"),
    });
    expect(await Effect.runPromise(method.handler())).toBe("fixed-public-fixture");
  });
});
