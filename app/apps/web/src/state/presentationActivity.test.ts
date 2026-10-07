import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  presentationActivityAtom,
  presentationRead,
  retainPresentationFreshness,
} from "./presentationActivity";

let focused = true;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let nativeWindow: EventTarget;
const registries: AtomRegistry.AtomRegistry[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  nativeWindow = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", nativeWindow);
});
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const flush = () => vi.advanceTimersByTimeAsync(20);

function harness() {
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("presentation-test"),
    label: "Presentation test",
    httpBaseUrl: "https://presentation.example.test",
    wsBaseUrl: "wss://presentation.example.test",
  });
  const state = Effect.runSync(
    SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online" as const,
      phase: "connected" as const,
      attempt: 1,
      generation: 1,
    }),
  );
  const supervisor = EnvironmentSupervisor.of({
    target,
    state,
    session: Effect.runSync(SubscriptionRef.make(Option.some({} as RpcSession))),
    prepared: Effect.runSync(SubscriptionRef.make(Option.none())),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry));
  let reads = 0;
  let blocked = false;
  const family = createEnvironmentQueryAtomFamily(runtime, {
    label: "presentation-test-query",
    staleTimeMs: 5_000,
    idleTtlMs: 0,
    refreshTrigger: () => presentationActivityAtom,
    execute: (_input: { scope: string }) =>
      presentationRead(
        Effect.suspend(() => {
          reads++;
          return blocked ? Effect.never : Effect.succeed(reads);
        }),
      ),
  });
  const atomFor = (scope: string) =>
    retainPresentationFreshness(family({ environmentId: target.environmentId, input: { scope } }));
  const atom = atomFor("first");
  const registry = AtomRegistry.make();
  registries.push(registry);
  return {
    atom,
    atomFor,
    registry,
    reads: () => reads,
    block: () => {
      blocked = true;
    },
    state,
  };
}

describe("recorded presentation query lifecycle", () => {
  it("coalesces duplicate mounted demand, pauses hidden/inactive reads, and forces fresh activation", async () => {
    const h = harness();
    const detachA = h.registry.mount(h.atom);
    const detachB = h.registry.mount(h.atom);
    await flush();
    expect(h.reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.reads()).toBe(2);
    focused = false;
    nativeWindow.dispatchEvent(new Event("blur"));
    await flush();
    expect(h.registry.get(h.atom)._tag).toBe("Failure");
    expect(Option.getOrNull(AsyncResult.value(h.registry.get(h.atom)))).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.reads()).toBe(2);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    await flush();
    Effect.runSync(SubscriptionRef.update(h.state, (state) => ({ ...state, generation: 2 })));
    h.registry.refresh(h.atom);
    await flush();
    expect(h.reads()).toBe(2);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(h.reads()).toBe(2);
    focused = true;
    nativeWindow.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.reads()).toBe(3);
    // Hide and reactivate inside staleTime: always require another read.
    focused = false;
    nativeWindow.dispatchEvent(new Event("blur"));
    await flush();
    h.block();
    focused = true;
    nativeWindow.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.reads()).toBe(4);
    const pending = h.registry.get(h.atom);
    expect(pending._tag).toBe("Failure");
    expect(pending.waiting).toBe(true);
    expect(Option.getOrNull(AsyncResult.value(pending))).toBe(3);
    detachA();
    detachB();
  });

  it("shares native listeners and releases timer/demand after the last subscriber", async () => {
    const add = vi.spyOn(page, "addEventListener");
    const remove = vi.spyOn(page, "removeEventListener");
    const h = harness();
    const first = h.registry.mount(h.atom);
    const second = h.registry.mount(h.atom);
    await flush();
    expect(add).toHaveBeenCalledTimes(1);
    first();
    await flush();
    expect(remove).not.toHaveBeenCalled();
    second();
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.reads()).toBe(1);
  });

  it("does not start a read mounted into an already hidden native window", async () => {
    page.visibilityState = "hidden";
    const h = harness();
    h.registry.mount(h.atom);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.reads()).toBe(0);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(h.reads()).toBe(1);
  });

  it("a scope changed while inactive never inherits the previous scope's retained picture", async () => {
    const h = harness();
    const detach = h.registry.mount(h.atom);
    await flush();
    expect(Option.getOrNull(AsyncResult.value(h.registry.get(h.atom)))).toBe(1);
    focused = false;
    nativeWindow.dispatchEvent(new Event("blur"));
    await flush();
    detach();
    const next = h.atomFor("second");
    h.registry.mount(next);
    await flush();
    expect(h.reads()).toBe(1);
    expect(Option.isNone(AsyncResult.value(h.registry.get(next)))).toBe(true);
    focused = true;
    nativeWindow.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.reads()).toBe(2);
    expect(Option.getOrNull(AsyncResult.value(h.registry.get(next)))).toBe(2);
  });
});
