import { describe, expect, it } from "vite-plus/test";
import { RecordCompanionMachine } from "./RecordCompanionMachine.ts";

const scope = {
  environmentId: "env-fixture",
  threadId: "thread-fixture",
  providerInstanceId: "instance-fixture",
};
const id = "11111111-1111-4111-8111-111111111111";
const machine = () => new RecordCompanionMachine(10, id, scope);
const rev = (m: RecordCompanionMachine) => m.state().revision;
function detach(m: RecordCompanionMachine, child = 20) {
  m.requestOpen(10, rev(m));
  m.attach(child, rev(m));
  m.ready(child, rev(m));
  m.commitDetach(10, rev(m));
}

describe("R6 independent placement and actual-sender contract", () => {
  it("does not activate child before main acknowledges leaving its docked view", () => {
    const m = machine();
    expect(m.state().placement).toBe("docked");
    m.requestOpen(10, rev(m));
    expect(m.state().placement).toBe("opening");
    expect(() => m.ready(20, rev(m))).toThrow();
    m.attach(20, rev(m));
    expect(() => m.commitDetach(10, rev(m))).toThrow();
    m.ready(20, rev(m));
    expect(m.state().placement).toBe("opening");
    m.commitDetach(10, rev(m));
    expect(m.state().placement).toBe("detached");
  });
  it("refuses forged owner, foreign child and stale revisions without changing state", () => {
    const m = machine();
    const before = structuredClone(m.state());
    expect(() => m.requestOpen(11, rev(m))).toThrow();
    expect(m.state()).toEqual(before);
    detach(m);
    const active = structuredClone(m.state());
    expect(() => m.requestDock(21, rev(m))).toThrow();
    expect(() => m.requestDock(20, rev(m) - 1)).toThrow();
    expect(m.state()).toEqual(active);
  });
  it("docks only after child quiesces and owner acknowledges the prepared docked view", () => {
    const m = machine();
    detach(m);
    m.requestDock(20, rev(m));
    expect(m.state().placement).toBe("docking");
    expect(() => m.commitDock(10, rev(m))).toThrow();
    m.quiesce(20, rev(m));
    expect(m.state().placement).toBe("docking");
    expect(() => m.commitDock(20, rev(m))).toThrow();
    m.commitDock(10, rev(m));
    expect(m.state().placement).toBe("docked");
    expect(() => m.assertCompanionSender(20)).toThrow();
  });
  it("Close is closed and reopen invalidates the previous child sender", () => {
    const m = machine();
    detach(m);
    m.close(20, rev(m));
    expect(m.state().placement).toBe("closed");
    expect(() => m.assertCompanionSender(20)).toThrow();
    detach(m, 30);
    expect(() => m.ready(20, rev(m))).toThrow();
    expect(() => m.assertCompanionSender(20)).toThrow();
    expect(m.state().placement).toBe("detached");
  });
  it("opening failure preserves docked placement and clears the provisional child", () => {
    const m = machine();
    m.requestOpen(10, rev(m));
    m.attach(20, rev(m));
    m.failOpening(10, rev(m));
    expect(m.state().placement).toBe("docked");
    expect(() => m.assertCompanionSender(20)).toThrow();
  });
  it("owns its source identity without trusting mutable caller or returned state objects", () => {
    const input = { ...scope };
    const m = new RecordCompanionMachine(10, id, input);
    input.threadId = "foreign-mutated-thread";
    expect(m.state().scope).toEqual(scope);
    const exposed = m.state() as unknown as { placement: string; scope: { threadId: string } };
    exposed.placement = "detached";
    exposed.scope.threadId = "foreign-returned-thread";
    expect(m.state().placement).toBe("docked");
    expect(m.state().scope).toEqual(scope);
  });
  it("duplicate or out-of-phase open never resets a ready active companion", () => {
    const m = machine();
    detach(m);
    const before = structuredClone(m.state());
    expect(() => m.requestOpen(10, rev(m))).toThrow();
    expect(m.state()).toEqual(before);
    expect(() => m.attach(30, rev(m))).toThrow();
    expect(m.state()).toEqual(before);
  });
});

it("Dock acknowledges the current inspected tuple instead of reusing the initial Open tuple", () => {
  const m = machine();
  const opened = { descriptorRevision: 1, viewRevision: 2, presentationRevision: 3 };
  const inspected = { descriptorRevision: 1, viewRevision: 9, presentationRevision: 8 };
  m.requestOpen(10, rev(m), opened);
  m.attach(20, rev(m));
  m.ready(20, rev(m), opened);
  m.commitDetach(10, rev(m));
  m.requestDock(20, rev(m), inspected);
  expect(m.state().handoff).toEqual(inspected);
  const before = structuredClone(m.state());
  expect(() => m.quiesce(20, rev(m), opened)).toThrow();
  expect(m.state()).toEqual(before);
  m.quiesce(20, rev(m), inspected);
  m.commitDock(10, rev(m));
  expect(m.state().placement).toBe("docked");
});
