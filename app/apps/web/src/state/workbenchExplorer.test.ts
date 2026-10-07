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

describe("bounded explorer query atoms", () => {
  it("are demand-gated, send only the closed wire payload and isolate source scopes", async () => {
    const h = harness();
    const atomA = h.reads.indexAtom({
      environmentId: ENV,
      threadId: THREAD,
      providerInstanceId: ProviderInstanceId.make("i-1"),
      limit: 50,
    });
    const atomB = h.reads.indexAtom({
      environmentId: ENV,
      threadId: THREAD,
      providerInstanceId: ProviderInstanceId.make("i-2"),
      limit: 50,
    });
    await flush();
    expect(h.calls).toHaveLength(0);
    const detachA = h.registry.mount(atomA);
    await flush();
    expect(h.calls).toEqual([{ method: "index", payload: { threadId: THREAD, limit: 50 } }]);
    const detachB = h.registry.mount(atomB);
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(atomA).not.toBe(atomB);
    const value = AsyncResult.value(h.registry.get(atomA));
    expect(Option.getOrNull(value)?.status).toBe("available");
    detachA();
    detachB();
  });

  it("reads one bounded validated window per selection and interrupts an obsolete in-flight range", async () => {
    const h = harness();
    const request = bodyRequest(h, 60, 50_001);
    const detach = h.registry.mount(h.reads.bodyAtom(request));
    await flush();
    const plan = planRecordBodyWindow(50_001, request.expected.byteLength);
    expect(h.calls).toEqual([
      {
        method: "body",
        payload: {
          threadId: THREAD,
          row: request.row,
          asOf: request.asOf,
          offset: plan.fetchOffset,
          limit: plan.fetchLimit,
          expected: request.expected,
        },
      },
    ]);
    const result = Option.getOrNull(AsyncResult.value(h.registry.get(h.reads.bodyAtom(request))));
    expect(result?.status).toBe("available");
    detach();
    h.hold();
    const obsolete = bodyRequest(h, 5, 0);
    const detachObsolete = h.registry.mount(h.reads.bodyAtom(obsolete));
    await flush();
    expect(h.interrupts()).toBe(0);
    detachObsolete();
    await flush();
    expect(h.interrupts()).toBe(1);
  });

  it("fails a tampered range closed inside the read", async () => {
    const h = harness();
    h.source.bodyTamper = "swapRow";
    const request = bodyRequest(h, 10, 0);
    const detach = h.registry.mount(h.reads.bodyAtom(request));
    await flush();
    expect(h.registry.get(h.reads.bodyAtom(request))._tag).toBe("Failure");
    detach();
  });

  it("pauses while inactive and never repeats an explicit proof on its own", async () => {
    const h = harness();
    focused = false;
    page.dispatchEvent(new Event("visibilitychange"));
    const request = bodyRequest(h, 10, 0);
    const detach = h.registry.mount(h.reads.bodyAtom(request));
    await flush();
    expect(h.calls).toHaveLength(0);
    focused = true;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.calls.map((call) => call.method)).toEqual(["body"]);
    const verify = h.reads.verifyAtom({ ...bodyRequest(h, 10, 0), nonce: 1 });
    const detachVerify = h.registry.mount(verify);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls.filter((call) => call.method === "verify")).toHaveLength(1);
    expect(h.calls.filter((call) => call.method === "body")).toHaveLength(1);
    expect(Option.getOrNull(AsyncResult.value(h.registry.get(verify)))?.status).toBe("exact");
    detachVerify();
    detach();
  });
});
