import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
vi.mock("electron", () => ({}));
import * as Pool from "../../backend/DesktopBackendPool.ts";
import * as Auth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { getLocalEnvironmentBearerToken, getLocalEnvironmentBootstraps } from "./window.ts";

const main = { isDestroyed: () => false, webContents: { id: 10 } };
const bearerReads = vi.fn(() => "controlled-fixture-token");
const backendReads = vi.fn(() => []);
const layers = () =>
  Layer.mergeAll(
    Layer.mock(Pool.DesktopBackendPool)({ list: Effect.sync(backendReads) }),
    Layer.mock(Auth.DesktopLocalEnvironmentAuth)({ getBearerToken: Effect.sync(bearerReads) }),
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(main as never) }),
    Layer.mock(DesktopWindow.DesktopWindow)({ currentMain: Effect.succeedSome(main as never) }),
  );
describe("R6 independent inherited credential IPC boundary", () => {
  it("refuses foreign companion sender before returning a bearer", async () => {
    bearerReads.mockClear();
    const result = await Effect.runPromise(
      Effect.result(getLocalEnvironmentBearerToken.handler(undefined, { sender: { id: 20 } })).pipe(
        Effect.provide(layers()),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(bearerReads).not.toHaveBeenCalled();
  });
  it("forwards the actual sender of synchronous bootstrap IPC and refuses foreign windows", async () => {
    backendReads.mockClear();
    const result = await Effect.runPromise(
      Effect.result(
        getLocalEnvironmentBootstraps.handler({ sender: { id: 20 }, returnValue: undefined }),
      ).pipe(Effect.provide(layers())),
    );
    expect(result._tag).toBe("Failure");
    expect(backendReads).not.toHaveBeenCalled();
  });
  it("keeps actual main renderer credential bootstrap working", async () => {
    const token = await Effect.runPromise(
      getLocalEnvironmentBearerToken
        .handler(undefined, { sender: { id: 10 } })
        .pipe(Effect.provide(layers())),
    );
    expect(token).toBe("controlled-fixture-token");
  });
});

const onlyAuxiliaryWindow = () =>
  Layer.mergeAll(
    Layer.mock(Pool.DesktopBackendPool)({ list: Effect.sync(backendReads) }),
    Layer.mock(Auth.DesktopLocalEnvironmentAuth)({ getBearerToken: Effect.sync(bearerReads) }),
    Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedNone }),
    Layer.mock(DesktopWindow.DesktopWindow)({
      currentMain: Effect.succeedSome({
        isDestroyed: () => false,
        webContents: { id: 20 },
      } as never),
    }),
  );
it("never promotes an auxiliary first-window fallback into bearer authority when no main is registered", async () => {
  bearerReads.mockClear();
  const result = await Effect.runPromise(
    Effect.result(getLocalEnvironmentBearerToken.handler(undefined, { sender: { id: 20 } })).pipe(
      Effect.provide(onlyAuxiliaryWindow()),
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(bearerReads).not.toHaveBeenCalled();
});
it("never promotes an auxiliary first-window fallback into bootstrap authority when no main is registered", async () => {
  backendReads.mockClear();
  const result = await Effect.runPromise(
    Effect.result(
      getLocalEnvironmentBootstraps.handler({ sender: { id: 20 }, returnValue: undefined }),
    ).pipe(Effect.provide(onlyAuxiliaryWindow())),
  );
  expect(result._tag).toBe("Failure");
  expect(backendReads).not.toHaveBeenCalled();
});
