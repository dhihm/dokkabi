import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";

const environmentId = EnvironmentId.make("passive-read-environment");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Passive display test",
  httpBaseUrl: "https://passive.example.test",
  wsBaseUrl: "wss://passive.example.test",
});
const connected: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};
const connectionState = Effect.runSync(SubscriptionRef.make(connected));
const supervisor = EnvironmentSupervisor.of({
  target,
  state: connectionState,
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
const environments = EnvironmentRegistry.of({
  run,
  followStream,
  stateChanges: () => SubscriptionRef.changes(connectionState),
} as unknown as EnvironmentRegistry["Service"]);
const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
let blocked = false;
const calls: { method: string; input: { threadId: string }; value: unknown }[] = [];
const rpcRead = (method: string, input: { threadId: string }) =>
  Effect.suspend(() => {
    const value = { status: "unsupported", reason: `${input.threadId}:read-${calls.length + 1}` };
    calls.push({ method, input, value });
    return blocked ? Effect.never : Effect.succeed(value);
  });
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: runtime }));
vi.mock("@t3tools/client-runtime/rpc", () => ({ request: rpcRead }));
const { workbenchDecisionsAtomFor, workbenchDecisionAction } = await import("./workbenchDecisions");
const { workbenchRecordAtomFor } = await import("./workbenchRecord");
const { workbenchScopedUsageAtomFor } = await import("./workbenchOverview");

let focused = true;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let nativeWindow: EventTarget;
let registry: AtomRegistry.AtomRegistry;
beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  blocked = false;
  focused = true;
  Effect.runSync(SubscriptionRef.set(connectionState, connected));
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  nativeWindow = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", nativeWindow);
  registry = AtomRegistry.make();
});
afterEach(() => {
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const flush = () => vi.advanceTimersByTimeAsync(20);
const scope = {
  environmentId,
  threadId: ThreadId.make("first-thread"),
  providerInstanceId: ProviderInstanceId.make("first-instance"),
};
const families = [
  {
    name: "Decision",
    method: WS_METHODS.providerGetWorkbenchDecisions,
    atom: workbenchDecisionsAtomFor,
  },
  {
    name: "Record",
    method: WS_METHODS.providerGetWorkbenchRecord,
    atom: (input: typeof scope) => workbenchRecordAtomFor({ ...input, limit: 50 }),
  },
];

describe.each(families)("actual $name query activity", ({ atom: atomFor, method }) => {
  const getAtom = (input = scope): Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> =>
    atomFor(input);
  it("shared mounts pause on inactivity and force activation validation with scoped retained truth", async () => {
    const atom = getAtom();
    registry.mount(atom);
    registry.mount(atom);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    const previous = calls[1]!.value;
    focused = false;
    nativeWindow.dispatchEvent(new Event("blur"));
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
    expect(registry.get(atom)._tag).toBe("Failure");
    expect(Option.getOrNull(AsyncResult.value(registry.get(atom)))).toEqual(previous);
    Effect.runSync(
      SubscriptionRef.update(connectionState, (state) => ({ ...state, generation: 2 })),
    );
    registry.refresh(atom);
    await flush();
    expect(calls).toHaveLength(2);
    focused = true;
    nativeWindow.dispatchEvent(new Event("focus"));
    await flush();
    expect(calls).toHaveLength(3);
    focused = false;
    nativeWindow.dispatchEvent(new Event("blur"));
    await flush();
    blocked = true;
    focused = true;
    nativeWindow.dispatchEvent(new Event("focus"));
    await flush();
    expect(calls).toHaveLength(4);
    expect(registry.get(atom)).toMatchObject({ _tag: "Failure", waiting: true });
    expect(Option.getOrNull(AsyncResult.value(registry.get(atom)))).toEqual(calls[2]!.value);
  });
  it("starts no hidden mounted read and retains no foreign scope on an inactive scope change", async () => {
    const first = getAtom();
    const detach = registry.mount(first);
    await flush();
    expect(calls).toHaveLength(1);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    detach();
    const next = getAtom({
      ...scope,
      threadId: ThreadId.make("second-thread"),
      providerInstanceId: ProviderInstanceId.make("second-instance"),
    });
    registry.mount(next);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1);
    expect(Option.isNone(AsyncResult.value(registry.get(next)))).toBe(true);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input.threadId).toBe("second-thread");
    expect(Option.getOrNull(AsyncResult.value(registry.get(next)))).toEqual(calls[1]!.value);
  });
  it("last subscriber disposal stops automatic reads and first detach preserves the other reader", async () => {
    const atom = getAtom();
    const first = registry.mount(atom);
    const second = registry.mount(atom);
    await flush();
    first();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    second();
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
  });
});
it("an explicit Decision mutation still runs while presentation is inactive", async () => {
  focused = false;
  page.visibilityState = "hidden";
  const pending = runAtomCommand(registry, workbenchDecisionAction, {
    environmentId,
    input: {
      type: "select",
      threadId: scope.threadId,
      id: "decision",
      commandId: "stable-command",
      expectedRevision: 1,
      option: "one",
    },
  });
  await flush();
  expect((await pending)._tag).toBe("Success");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe(WS_METHODS.providerSelectWorkbenchDecision);
  expect(calls[0]!.input).toMatchObject({ commandId: "stable-command", expectedRevision: 1 });
});

it("scoped usage pauses reconnect reads, retains its own view and validates on activation without periodic scans", async () => {
  const atom = workbenchScopedUsageAtomFor(scope);
  registry.mount(atom);
  await flush();
  expect(calls).toHaveLength(1);
  const previous = calls[0]!.value;
  expect(calls[0]!.input).toMatchObject({ includeChildUsage: true });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toHaveLength(1);
  focused = false;
  nativeWindow.dispatchEvent(new Event("blur"));
  await flush();
  Effect.runSync(SubscriptionRef.update(connectionState, (state) => ({ ...state, generation: 2 })));
  await flush();
  expect(calls).toHaveLength(1);
  expect(registry.get(atom)._tag).toBe("Failure");
  expect(Option.getOrNull(AsyncResult.value(registry.get(atom)))).toEqual(previous);
  blocked = true;
  focused = true;
  nativeWindow.dispatchEvent(new Event("focus"));
  await flush();
  expect(calls).toHaveLength(2);
  expect(registry.get(atom)).toMatchObject({ _tag: "Failure", waiting: true });
  expect(Option.getOrNull(AsyncResult.value(registry.get(atom)))).toEqual(previous);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(calls).toHaveLength(2);
});

it("Record exact page identities never inherit another inactive page's cache", async () => {
  const after = { seq: 50, hash: "a".repeat(64), generation: "b".repeat(64) };
  const first = workbenchRecordAtomFor({ ...scope, limit: 50, after });
  const detach = registry.mount(first);
  await flush();
  expect(calls[0]!.input).toMatchObject({ after, limit: 50 });
  focused = false;
  nativeWindow.dispatchEvent(new Event("blur"));
  await flush();
  detach();
  const next = workbenchRecordAtomFor({
    ...scope,
    limit: 50,
    after: { ...after, hash: "c".repeat(64) },
  });
  registry.mount(next);
  await flush();
  expect(calls).toHaveLength(1);
  expect(Option.isNone(AsyncResult.value(registry.get(next)))).toBe(true);
  focused = true;
  nativeWindow.dispatchEvent(new Event("focus"));
  await flush();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.input).toMatchObject({ after: { ...after, hash: "c".repeat(64) } });
});
