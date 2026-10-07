// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  recordCompanionScopeKey,
} from "@t3tools/contracts";
import type { RecordCompanionPlacementState } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  companionPresentationActive,
  resetRecordCompanionHubForTest,
  useRecordCompanionHubStore,
} from "./recordCompanion";

const scope = {
  environmentId: EnvironmentId.make("activity-env"),
  threadId: ThreadId.make("activity-thread"),
  providerInstanceId: ProviderInstanceId.make("activity-instance"),
};
const scopeKey = recordCompanionScopeKey(scope);
const tuple = { descriptorRevision: 0, viewRevision: 0, presentationRevision: 0 };
function placement(overrides: object = {}): RecordCompanionPlacementState {
  return {
    companionId: "activity-child",
    scope,
    scopeKey,
    placement: "detached",
    revision: 4,
    ownerSenderId: 1,
    childSender: 7,
    childReady: true,
    childQuiesced: false,
    handoff: tuple,
    acknowledgedHandoff: tuple,
    childActive: false,
    childActivityRevision: 0,
    ...overrides,
  } as RecordCompanionPlacementState;
}
function push(state: RecordCompanionPlacementState) {
  useRecordCompanionHubStore.getState().handleOwnerEvent({ type: "state", state });
}
const current = () =>
  useRecordCompanionHubStore.getState().entries[scopeKey]!
    .placement as RecordCompanionPlacementState & {
    childActive?: boolean;
    childActivityRevision?: number;
  };
beforeEach(() => {
  resetRecordCompanionHubForTest();
  useRecordCompanionHubStore.getState().ensureEntry(scope, "Activity fixture");
});

describe("supervisor host activity reconciliation", () => {
  it("refuses altered raw scope tuples even when the message repeats the old scope key", () => {
    push(placement());
    push(
      placement({
        childActive: true,
        childActivityRevision: 1,
        scope: { ...scope, threadId: ThreadId.make("foreign-thread") },
      }),
    );
    expect(current().childActive).toBe(false);
    expect(
      companionPresentationActive(
        placement({
          childActive: true,
          scope: { ...scope, threadId: ThreadId.make("foreign-thread") },
        }),
      ),
    ).toBe(false);
  });

  it("accepts a newer host activity revision at unchanged lifecycle CAS revision", () => {
    push(placement());
    push(placement({ childActive: true, childActivityRevision: 1 }));
    expect(current().revision).toBe(4);
    expect(current().childActive).toBe(true);
    expect(current().childActivityRevision).toBe(1);
  });
  it("ignores older hydration and activity snapshots without rewinding the active child", () => {
    push(placement({ childActive: true, childActivityRevision: 3 }));
    push(placement({ childActive: false, childActivityRevision: 2 }));
    push(placement({ revision: 3, childActive: false, childActivityRevision: 0 }));
    expect(current().revision).toBe(4);
    expect(current().childActive).toBe(true);
    expect(current().childActivityRevision).toBe(3);
  });
  it("does not let a same-CAS activity message replace identity or a handoff tuple", () => {
    push(placement());
    push(placement({ childActive: true, childActivityRevision: 1, childSender: 99 }));
    expect(current().childSender).toBe(7);
    expect(current().childActive).toBe(false);
    push(
      placement({
        childActive: true,
        childActivityRevision: 2,
        handoff: { ...tuple, viewRevision: 9 },
      }),
    );
    expect(current().childActive).toBe(false);
  });
  it("accepts newer lifecycle without rewinding the host activity revision", () => {
    push(placement({ childActive: true, childActivityRevision: 3 }));
    push(placement({ revision: 5, childActive: false, childActivityRevision: 2 }));
    expect(current().revision).toBe(5);
    expect(current().childActive).toBe(true);
    expect(current().childActivityRevision).toBe(3);
  });
});
