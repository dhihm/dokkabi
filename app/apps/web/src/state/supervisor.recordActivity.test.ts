import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";

import { makeFakeExplorerSource } from "../components/recordExplorer/explorerFake.testFixtures";
import { planRecordBodyWindow } from "../components/recordExplorer/recordBodyWindow";
import { createWorkbenchExplorerReads, type WorkbenchExplorerSend } from "./workbenchExplorer";

let focused = true;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
const registries: AtomRegistry.AtomRegistry[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const flush = () => vi.advanceTimersByTimeAsync(20);

const ENV = EnvironmentId.make("explorer-atoms");
const THREAD = ThreadId.make("explorer-thread");

function harness() {
  const target = new PrimaryConnectionTarget({
    environmentId: ENV,
    label: "Explorer test",
    httpBaseUrl: "https://explorer.example.test",
    wsBaseUrl: "wss://explorer.example.test",
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
  const source = makeFakeExplorerSource({ rows: 70, largeRowBytes: 120_000 });
  const calls: { method: string; payload: any }[] = [];
  let hold = false;
  let interrupts = 0;
  const answer = <A>(method: string, payload: unknown, value: () => A) =>
    Effect.suspend(() => {
      calls.push({ method, payload });
      return hold
        ? Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupts++)))
        : Effect.succeed(value());
    });
  const send: WorkbenchExplorerSend<never> = {
    index: (payload) => answer("index", payload, () => source.index(payload)),
    body: (payload) => answer("body", payload, () => source.body(payload)),
    verify: (payload) => answer("verify", payload, () => source.verify(payload)),
    explore: (payload) => answer("explore", payload, () => source.explore(payload)),
  };
  const reads = createWorkbenchExplorerReads(runtime, send);
  const registry = AtomRegistry.make();
  registries.push(registry);
  return {
    reads,
    registry,
    source,
    calls,
    hold: () => {
      hold = true;
    },
    interrupts: () => interrupts,
  };
}

const bodyRequest = (
  h: ReturnType<typeof harness>,
  seq: number,
  start: number,
  instance = "i-1",
) => {
  const descriptor = h.source.rows[seq - 1]!.descriptor;
  return {
    environmentId: ENV,
    threadId: THREAD,
    providerInstanceId: ProviderInstanceId.make(instance),
    row: { seq, hash: descriptor.hash, generation: h.source.generation },
    asOf: h.source.head(),
    expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
    start,
  };
};

describe("supervisor host-scoped Record demand", () => {
  it("reads the active companion range while its owner is blurred, without waking Graph", async () => {
    const h = harness();
    focused = false;
    const request = { ...bodyRequest(h, 60, 50_001), companionActive: true };
    const detach = h.registry.mount(h.reads.bodyAtom(request));
    const detachGraph = h.registry.mount(
      h.reads.exploreAtom({
        environmentId: ENV,
        threadId: THREAD,
        providerInstanceId: request.providerInstanceId,
        graphType: "work",
        query: { mode: "page", limit: 100 },
      }),
    );
    await flush();
    expect(h.calls.map((call) => call.method)).toEqual(["body"]);
    expect(
      Option.getOrNull(AsyncResult.value(h.registry.get(h.reads.bodyAtom(request))))?.status,
    ).toBe("available");
    detach();
    detachGraph();
  });
  it("has one five-second companion metadata timer and none after scoped demand ends", async () => {
    const h = harness();
    focused = false;
    const request = { environmentId: ENV, threadId: THREAD, limit: 50, companionActive: true };
    const detach = h.registry.mount(h.reads.indexAtom(request));
    await flush();
    expect(h.calls.filter((call) => call.method === "index")).toHaveLength(1);
    expect(h.registry.get(h.reads.indexAtom(request))._tag).toBe("Success");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls.filter((call) => call.method === "index")).toHaveLength(3);
    detach();
    await flush();
    const after = h.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(after);
    const inactive = h.registry.mount(h.reads.indexAtom({ ...request, companionActive: false }));
    await flush();
    expect(h.calls).toHaveLength(after);
    inactive();
  });
  it("interrupts active-child obsolete waits and refuses explicit proof when all presentations are inactive", async () => {
    const h = harness();
    focused = false;
    h.hold();
    const request = { ...bodyRequest(h, 60, 0), companionActive: true };
    const detach = h.registry.mount(h.reads.bodyAtom(request));
    await flush();
    expect(h.calls.map((call) => call.method)).toEqual(["body"]);
    detach();
    await flush();
    expect(h.interrupts()).toBe(1);
    const proof = h.registry.mount(
      h.reads.verifyAtom({ ...request, companionActive: false, nonce: 1 }),
    );
    await flush();
    expect(h.calls.map((call) => call.method)).toEqual(["body"]);
    proof();
  });
});
