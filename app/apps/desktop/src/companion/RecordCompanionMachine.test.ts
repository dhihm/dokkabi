import { describe, expect, it } from "vite-plus/test";

import {
  RecordCompanionMachine,
  type RecordCompanionMachineScope,
} from "./RecordCompanionMachine.ts";

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

describe("RecordCompanionMachine implementation invariants", () => {
  it("rejects malformed constructor input", () => {
    expect(() => new RecordCompanionMachine(0, id, scope)).toThrow();
    expect(() => new RecordCompanionMachine(10.5, id, scope)).toThrow();
    expect(() => new RecordCompanionMachine(10, "not-a-uuid", scope)).toThrow();
    expect(
      () => new RecordCompanionMachine(10, id, { environmentId: "", threadId: "t" }),
    ).toThrow();
    expect(
      () => new RecordCompanionMachine(10, id, { environmentId: "e", threadId: "" }),
    ).toThrow();
  });

  it("normalizes an absent provider instance to null and returns fresh snapshots", () => {
    const m = new RecordCompanionMachine(10, id, {
      environmentId: "env",
      threadId: "thread",
      providerInstanceId: undefined,
    } satisfies RecordCompanionMachineScope);
    expect(m.state().scope).toEqual({
      environmentId: "env",
      threadId: "thread",
      providerInstanceId: null,
    });
    const first = m.state();
    (first as { revision: number }).revision = 999;
    expect(m.state().revision).toBe(0);
    const second = m.state();
    expect(second).not.toBe(first);
    expect(second).toEqual(m.state());
  });

  it("increments the revision exactly once per successful transition", () => {
    const m = machine();
    expect(m.state().revision).toBe(0);
    m.requestOpen(10, 0);
    expect(m.state().revision).toBe(1);
    m.attach(20, 1);
    expect(m.state().revision).toBe(2);
    m.ready(20, 2);
    expect(m.state().revision).toBe(3);
    m.commitDetach(10, 3);
    expect(m.state().revision).toBe(4);
    m.requestDock(20, 4);
    expect(m.state().revision).toBe(5);
    m.quiesce(20, 5);
    expect(m.state().revision).toBe(6);
    m.commitDock(10, 6);
    expect(m.state().revision).toBe(7);
  });

  it("refuses stale and future revisions without changing state", () => {
    const m = machine();
    const before = structuredClone(m.state());
    expect(() => m.requestOpen(10, 1)).toThrow();
    expect(() => m.requestOpen(10, -1)).toThrow();
    expect(() => m.attach(20, 0)).toThrow();
    expect(m.state()).toEqual(before);
  });

  it("allows attach exactly once per opening", () => {
    const m = machine();
    m.requestOpen(10, 0);
    m.attach(20, 1);
    const before = structuredClone(m.state());
    expect(() => m.attach(21, 2)).toThrow();
    expect(m.state()).toEqual(before);
  });

  it("refuses repeated ready and a ready from a foreign child", () => {
    const m = machine();
    m.requestOpen(10, 0);
    m.attach(20, 1);
    m.ready(20, 2);
    const before = structuredClone(m.state());
    expect(() => m.ready(20, 3)).toThrow();
    expect(() => m.ready(21, 3)).toThrow();
    expect(m.state()).toEqual(before);
  });

  it("freezes the handoff tuple: ready must acknowledge exactly it", () => {
    const frozen = { descriptorRevision: 4, viewRevision: 9, presentationRevision: 2 };
    const m = machine();
    m.requestOpen(10, 0, frozen);
    m.attach(20, 1);
    expect(() =>
      m.ready(20, 2, { descriptorRevision: 5, viewRevision: 9, presentationRevision: 2 }),
    ).toThrow();
    expect(() => m.ready(20, 2, null)).toThrow();
    m.ready(20, 2, frozen);
    expect(m.state().acknowledgedHandoff).toEqual(frozen);
    m.commitDetach(10, 3);
    // Docking must acknowledge the same committed tuple.
    m.requestDock(20, 4);
    expect(() => m.quiesce(20, 5, null)).toThrow();
    m.quiesce(20, 5, frozen);
    m.commitDock(10, 6);
    expect(m.state().handoff).toBeNull();
    expect(m.state().acknowledgedHandoff).toBeNull();
  });

  it("keeps source descriptor updates out of the frozen tuple until commit", () => {
    const frozen = { descriptorRevision: 1, viewRevision: 1, presentationRevision: 1 };
    const m = machine();
    m.requestOpen(10, 0, frozen);
    m.attach(20, 1);
    // A pending source update cannot rewrite the frozen transaction.
    m.ready(20, 2, frozen);
    expect(m.state().handoff).toEqual(frozen);
    expect(m.state().placement).toBe("opening");
    m.commitDetach(10, 3);
    expect(m.state().placement).toBe("detached");
    // The next opening (reopen) freezes a NEW tuple; the old one never leaks.
    m.close(20, 4);
    m.requestOpen(10, 5, { descriptorRevision: 2, viewRevision: 2, presentationRevision: 2 });
    expect(m.state().handoff).toEqual({
      descriptorRevision: 2,
      viewRevision: 2,
      presentationRevision: 2,
    });
  });

  it("keeps quiesce inert: the placement stays docking until the owner commits", () => {
    const m = machine();
    detach(m);
    m.requestDock(20, rev(m));
    m.quiesce(20, rev(m));
    expect(m.state().placement).toBe("docking");
    expect(m.state().childQuiesced).toBe(true);
    // The child is still the registered sender while docking.
    expect(() => m.assertCompanionSender(21)).toThrow();
    m.assertCompanionSender(20);
  });

  it("lets the owner close from opening and docking placements and refuses when idle", () => {
    const m = machine();
    m.requestOpen(10, 0);
    m.attach(20, 1);
    m.close(10, 2);
    expect(m.state().placement).toBe("closed");
    detach(m);
    m.requestDock(20, rev(m));
    m.close(10, rev(m));
    expect(m.state().placement).toBe("closed");
    expect(() => m.close(10, rev(m))).toThrow();
  });

  it("clears the provisional child on a failed opening but keeps the docked view placement", () => {
    const m = machine();
    m.requestOpen(10, 0);
    const frozen = m.state().handoff;
    expect(frozen).toBeNull();
    m.attach(20, 1);
    m.ready(20, 2);
    m.failOpening(10, 3);
    expect(m.state().placement).toBe("docked");
    expect(m.state().childSender).toBeNull();
    expect(m.state().childReady).toBe(false);
    expect(m.state().handoff).toBeNull();
    // A fresh opening starts cleanly after the rollback.
    m.requestOpen(10, 4);
    m.attach(21, 5);
    m.ready(21, 6);
    m.commitDetach(10, 7);
    expect(m.state().placement).toBe("detached");
  });

  it("authenticates the active companion sender only in live child placements", () => {
    const m = machine();
    expect(() => m.assertCompanionSender(20)).toThrow();
    m.requestOpen(10, 0);
    expect(() => m.assertCompanionSender(20)).toThrow();
    m.attach(20, 1);
    m.assertCompanionSender(20);
    m.ready(20, 2);
    m.commitDetach(10, 3);
    m.assertCompanionSender(20);
    m.commitDock;
    m.requestDock(20, 4);
    m.quiesce(20, 5);
    m.commitDock(10, 6);
    expect(() => m.assertCompanionSender(20)).toThrow();
  });
});
