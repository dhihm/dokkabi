import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  ProviderWorkbenchDecisionActionResult,
  ProviderWorkbenchDecisionItem,
} from "@t3tools/contracts";

import {
  BranchAttemptRunner,
  branchActionScopeEquals,
  canExplicitlyReconcile,
  decisionDefinitionEquals,
  decisionLifecycle,
  deriveDecisionCommandId,
  deriveDecisionOptions,
  fnv1aHex,
  newDecisionSubmissionId,
  preStartExpectedRevisionOf,
  preparedChildThreadIdOf,
  shouldOpenChildConversation,
  validateDecisionDefinition,
  type BranchActionScope,
  type CapturedBranchAttempt,
} from "./WorkbenchBranchesBar.logic";

const scope = (input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly providerInstanceId?: string | null;
}): BranchActionScope => ({
  environmentId: EnvironmentId.make(input.environmentId ?? "env-1"),
  threadId: ThreadId.make(input.threadId ?? "thread-1"),
  providerInstanceId:
    input.providerInstanceId === undefined || input.providerInstanceId === null
      ? null
      : ProviderInstanceId.make(input.providerInstanceId),
});

const readyResult = (childThreadId: string): ProviderWorkbenchDecisionActionResult => ({
  state: "ready",
  child: {
    id: "child-0001",
    sessionId: "child-session",
    workspacePath: "/isolated/owned/workspace",
    parent: { clientId: "main-client", threadId: "thread-1" },
    binding: { clientId: "main-client", threadId: childThreadId },
  },
});

const item = (
  overrides?: Partial<Pick<ProviderWorkbenchDecisionItem, "id" | "state" | "preparation">>,
): Pick<ProviderWorkbenchDecisionItem, "id" | "state" | "preparation"> => ({
  id: "dec-1",
  state: "awaiting",
  ...overrides,
});

/** A real deferred promise the test resolves/rejects explicitly. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

interface RunnerHarness {
  readonly runner: BranchAttemptRunner;
  readonly targets: ThreadId[];
  readonly starts: CapturedBranchAttempt[];
  readonly opened: ThreadId[];
  setCurrent: (current: boolean) => void;
}

const makeRunner = (input?: {
  readonly startResult?: (
    attempt: CapturedBranchAttempt,
    index: number,
  ) => Promise<ProviderWorkbenchDecisionActionResult>;
}): RunnerHarness => {
  const targets: ThreadId[] = [];
  const starts: CapturedBranchAttempt[] = [];
  const opened: ThreadId[] = [];
  const state = { current: true };
  let index = 0;
  const runner = new BranchAttemptRunner({
    createTarget: async () => {
      const id = ThreadId.make(`child-${targets.length + 1}`);
      targets.push(id);
      return id;
    },
    startBranch: (attempt) => {
      starts.push(attempt);
      index += 1;
      return (
        input?.startResult?.(attempt, index) ??
        Promise.resolve(readyResult(String(attempt.childThreadId)))
      );
    },
    isCurrent: () => state.current,
    onReady: (childThreadId) => {
      opened.push(childThreadId);
    },
  });
  return { runner, targets, starts, opened, setCurrent: (current) => (state.current = current) };
};

describe("WorkbenchBranchesBar.logic (R8 decision surface)", () => {
  it("derives safe positional option ids in the harness vocabulary", () => {
    const options = deriveDecisionOptions(["Retry loop", "Cache", ""]);
    expect(options).toEqual([
      { id: "opt-1", label: "Retry loop" },
      { id: "opt-2", label: "Cache" },
      { id: "opt-3", label: "" },
    ]);
    for (const option of options) {
      expect(option.id).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
    }
  });

  it("validates an explicit definition WITHOUT baking an identity into it", () => {
    const draft = {
      question: "Ship the retry loop or the cache first?",
      optionLabels: ["Retry loop", "Cache"],
      recommendationIndex: 0,
      rationale: "The retry loop unblocks the cache work.",
    };
    const first = validateDecisionDefinition(draft);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect("id" in first.definition).toBe(false);
      expect(first.definition.recommendation).toBe("opt-1");
    }
    expect(
      validateDecisionDefinition({
        question: "",
        optionLabels: ["A", "B"],
        recommendationIndex: 0,
        rationale: "",
      }).ok,
    ).toBe(false);
    expect(
      validateDecisionDefinition({
        question: "Q?",
        optionLabels: ["A"],
        recommendationIndex: 0,
        rationale: "",
      }).ok,
    ).toBe(false);
    expect(
      validateDecisionDefinition({
        question: "Q?",
        optionLabels: ["A", "B"],
        recommendationIndex: -1,
        rationale: "",
      }).ok,
    ).toBe(false);
    expect(
      validateDecisionDefinition({
        question: "Q?",
        optionLabels: ["A", ""],
        recommendationIndex: 0,
        rationale: "",
      }).ok,
    ).toBe(false);
  });

  it("derives dense option ids over NON-EMPTY rows and never recommends a blank row", () => {
    // A blank row before the recommended one shifts nothing: the ids are
    // dense over the filled rows and the recommendation follows the row the
    // operator actually picked.
    const validated = validateDecisionDefinition({
      question: "Which cut first?",
      optionLabels: ["A", "", "B"],
      recommendationIndex: 2,
      rationale: "B unblocks A.",
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.definition.options).toEqual([
        { id: "opt-1", label: "A" },
        { id: "opt-2", label: "B" },
      ]);
      expect(validated.definition.recommendation).toBe("opt-2");
    }
    // Recommending a BLANK row refuses; out-of-range refuses.
    expect(
      validateDecisionDefinition({
        question: "Q?",
        optionLabels: ["A", "", "B"],
        recommendationIndex: 1,
        rationale: "",
      }).ok,
    ).toBe(false);
    expect(
      validateDecisionDefinition({
        question: "Q?",
        optionLabels: ["A", "B"],
        recommendationIndex: 2,
        rationale: "",
      }).ok,
    ).toBe(false);
  });

  it("compares FULL validated definitions — any change is a fresh intent", () => {
    const base = {
      question: "Q?",
      options: [
        { id: "opt-1", label: "A" },
        { id: "opt-2", label: "B" },
      ],
      recommendation: "opt-1",
      rationale: "because",
    };
    expect(decisionDefinitionEquals(base, { ...base })).toBe(true);
    expect(decisionDefinitionEquals(base, { ...base, question: "Q2?" })).toBe(false);
    expect(decisionDefinitionEquals(base, { ...base, rationale: "changed" })).toBe(false);
    expect(decisionDefinitionEquals(base, { ...base, recommendation: "opt-2" })).toBe(false);
    expect(
      decisionDefinitionEquals(base, {
        ...base,
        options: [
          { id: "opt-1", label: "A" },
          { id: "opt-2", label: "B2" },
        ],
      }),
    ).toBe(false);
    expect(
      decisionDefinitionEquals(base, {
        ...base,
        options: [...base.options, { id: "opt-3", label: "C" }],
      }),
    ).toBe(false);
  });

  it("derives the pre-start revision for an explicit prepared reconcile", () => {
    expect(preStartExpectedRevisionOf({ state: "application_pending", revision: 2 })).toBe(1);
    expect(preStartExpectedRevisionOf({ state: "application_pending", revision: 1 })).toBe(0);
    expect(preStartExpectedRevisionOf({ state: "selected", revision: 1 })).toBe(1);
  });

  it("mints a FRESH intent id per submission — the same question later is a new decision", () => {
    const first = newDecisionSubmissionId();
    const second = newDecisionSubmissionId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^dec-[a-z0-9][a-z0-9._-]{0,127}$/u);
    expect(second).toMatch(/^dec-[a-z0-9][a-z0-9._-]{0,127}$/u);
  });

  it("derives deterministic command ids so explicit retries deduplicate", () => {
    expect(deriveDecisionCommandId("select", ["dec-1", "opt-1"])).toBe(
      deriveDecisionCommandId("select", ["dec-1", "opt-1"]),
    );
    expect(deriveDecisionCommandId("select", ["dec-1", "opt-1"])).not.toBe(
      deriveDecisionCommandId("select", ["dec-1", "opt-2"]),
    );
    expect(deriveDecisionCommandId("start", ["dec-1", "thread-9"])).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
    );
  });

  it("derives lifecycle labels from the RECORDED preparation overlay — never applied", () => {
    expect(decisionLifecycle(item({ state: "awaiting" }))).toBe("pending");
    expect(decisionLifecycle(item({ state: "selected" }))).toBe("selected");
    expect(decisionLifecycle(item({ state: "application_pending" }))).toBe("unknown");
    expect(
      decisionLifecycle(item({ state: "application_pending", preparation: { state: "unknown" } })),
    ).toBe("unknown");
    expect(
      decisionLifecycle(
        item({
          state: "application_pending",
          preparation: {
            state: "ready",
            commandId: "decision-start-1",
            child: {
              id: "child-0001",
              sessionId: "child-session",
              workspacePath: "/isolated/owned/workspace",
              parent: { clientId: "main-client", threadId: "thread-1" },
              binding: { clientId: "main-client", threadId: "thread-9" },
            },
          },
        }),
      ),
    ).toBe("prepared");
  });

  it("exposes the recorded open target for a prepared decision", () => {
    expect(preparedChildThreadIdOf(item({ state: "application_pending" }))).toBeNull();
    expect(
      preparedChildThreadIdOf(
        item({
          preparation: {
            state: "ready",
            commandId: "decision-start-1",
            child: {
              id: "child-0001",
              sessionId: "child-session",
              workspacePath: "/isolated/owned/workspace",
              parent: { clientId: "main-client", threadId: "thread-1" },
              binding: { clientId: "main-client", threadId: "thread-9" },
            },
          },
        }),
      ),
    ).toBe(ThreadId.make("thread-9"));
  });

  it("opens the child conversation only for a ready result in the SAME scope", () => {
    const initiating = scope({});
    expect(shouldOpenChildConversation(initiating, scope({}), readyResult("thread-9"))).toBe(true);
    expect(
      shouldOpenChildConversation(
        initiating,
        scope({ threadId: "thread-2" }),
        readyResult("thread-9"),
      ),
    ).toBe(false);
    expect(
      shouldOpenChildConversation(
        initiating,
        scope({ environmentId: "env-2" }),
        readyResult("thread-9"),
      ),
    ).toBe(false);
    expect(
      shouldOpenChildConversation(
        initiating,
        scope({ providerInstanceId: "instance-2" }),
        readyResult("thread-9"),
      ),
    ).toBe(false);
    expect(
      shouldOpenChildConversation(initiating, scope({}), { state: "unknown", reason: "lost" }),
    ).toBe(false);
    expect(
      shouldOpenChildConversation(initiating, scope({}), { state: "conflict", reason: "revision" }),
    ).toBe(false);
  });

  it("treats unbound instances distinctly from bound ones in scope equality", () => {
    expect(
      branchActionScopeEquals(
        scope({ providerInstanceId: null }),
        scope({ providerInstanceId: null }),
      ),
    ).toBe(true);
    expect(
      branchActionScopeEquals(
        scope({ providerInstanceId: null }),
        scope({ providerInstanceId: "instance-1" }),
      ),
    ).toBe(false);
  });

  it("allows explicit reconciliation of an unknown but never treats it as complete", () => {
    expect(canExplicitlyReconcile({ state: "unknown", reason: "lost" })).toBe(true);
    expect(canExplicitlyReconcile({ state: "ready", child: readyResult("thread-9").child })).toBe(
      false,
    );
    expect(canExplicitlyReconcile({ state: "conflict", reason: "r" })).toBe(false);
  });

  it("produces a stable fnv digest for identity derivation", () => {
    expect(fnv1aHex("same")).toBe(fnv1aHex("same"));
    expect(fnv1aHex("same")).not.toBe(fnv1aHex("different"));
    expect(fnv1aHex("x")).toMatch(/^[a-f0-9]{8}$/u);
  });
});

describe("BranchAttemptRunner (real deferred continuation/retry)", () => {
  it("an inactive owner never allocates or dispatches — guard BEFORE allocation", async () => {
    const harness = makeRunner();
    harness.setCurrent(false);
    const outcome = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(harness.targets).toHaveLength(0);
    expect(harness.starts).toHaveLength(0);
  });

  it("a stopped runner with an existing captured attempt never re-dispatches", async () => {
    const harness = makeRunner();
    const first = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(first).toMatchObject({ kind: "ready" });
    harness.runner.stop();
    expect(harness.runner.isStopped()).toBe(true);
    const second = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(second).toMatchObject({ kind: "refused" });
    // ONE allocation and ONE dispatch total; the captured identity remains.
    expect(harness.targets).toHaveLength(1);
    expect(harness.starts).toHaveLength(1);
    expect(harness.runner.attemptFor("dec-1")).toBeDefined();
  });

  it("a ready answer naming a FOREIGN target never navigates or completes", async () => {
    const harness = makeRunner({
      // The gateway confirms a child bound to another thread.
      startResult: (attempt) =>
        Promise.resolve(readyResult(`not-${String(attempt.childThreadId)}`)),
    });
    const outcome = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(outcome.kind).not.toBe("ready");
    expect(harness.opened).toHaveLength(0);
    // The captured attempt is retained for an explicit retry.
    expect(harness.runner.attemptFor("dec-1")).toBeDefined();
  });

  it("allocates the target ONCE and reuses the SAME command across explicit retries", async () => {
    const harness = makeRunner({
      startResult: () => Promise.resolve({ state: "unknown", reason: "ack lost" }),
    });
    const first = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(first).toMatchObject({ kind: "unknown" });
    expect(harness.targets).toHaveLength(1);
    const firstAttempt = harness.starts[0]!;
    // Explicit retry: same decision, same captured target and command.
    const second = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(second).toMatchObject({ kind: "unknown" });
    expect(harness.targets).toHaveLength(1);
    expect(harness.starts).toHaveLength(2);
    expect(harness.starts[1]!.commandId).toBe(firstAttempt.commandId);
    expect(String(harness.starts[1]!.childThreadId)).toBe(String(firstAttempt.childThreadId));
  });

  it("opens the child from the RECORDED ready descriptor only while current", async () => {
    const harness = makeRunner();
    const outcome = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(outcome).toMatchObject({ kind: "ready" });
    expect(harness.opened.map(String)).toEqual([String(harness.targets[0])]);
  });

  it("a deferred reply landing after the view went stale never navigates", async () => {
    const start = deferred<ProviderWorkbenchDecisionActionResult>();
    const harness = makeRunner({ startResult: () => start.promise });
    const running = harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    harness.setCurrent(false);
    start.resolve(readyResult("child-1"));
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: "unknown" });
    expect(outcome.kind === "unknown" && outcome.message).toContain("view changed");
    expect(harness.opened).toHaveLength(0);
  });

  it("stop() blocks the continuation of an in-flight attempt", async () => {
    const start = deferred<ProviderWorkbenchDecisionActionResult>();
    const harness = makeRunner({ startResult: () => start.promise });
    const running = harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    harness.runner.stop();
    start.resolve(readyResult("child-1"));
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: "unknown" });
    expect(harness.opened).toHaveLength(0);
  });

  it("a rejected start keeps the captured attempt — an explicit retry reuses it, never reallocates", async () => {
    let rejectNext = true;
    const harness = makeRunner({
      startResult: () =>
        rejectNext
          ? Promise.reject(new Error("transport lost"))
          : Promise.resolve(readyResult("child-1")),
    });
    const first = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(first).toMatchObject({ kind: "unknown" });
    expect(first.kind === "unknown" && first.message).toContain("uncertain");
    rejectNext = false;
    const retry = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(retry).toMatchObject({ kind: "ready" });
    // ONE target allocation across the uncertain attempt and its retry.
    expect(harness.targets).toHaveLength(1);
    expect(harness.starts).toHaveLength(2);
    expect(harness.starts[0]!.commandId).toBe(harness.starts[1]!.commandId);
  });

  it("retains a created target when the view changed before the start was sent", async () => {
    // The scope is LIVE at allocation; it dies while the allocation is in
    // flight — the target exists, but no start was dispatched for it.
    const allocation = deferred<ThreadId>();
    const targets: ThreadId[] = [];
    const starts: CapturedBranchAttempt[] = [];
    const state = { current: true };
    const runner = new BranchAttemptRunner({
      createTarget: () => {
        const id = ThreadId.make("child-1");
        targets.push(id);
        return allocation.promise;
      },
      startBranch: (attempt) => {
        starts.push(attempt);
        return Promise.resolve(readyResult(String(attempt.childThreadId)));
      },
      isCurrent: () => state.current,
      onReady: () => undefined,
    });
    const running = runner.run({ decisionId: "dec-1", title: "Branch", expectedRevision: 1 });
    state.current = false;
    allocation.resolve(ThreadId.make("child-1"));
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: "unknown" });
    expect(outcome.kind === "unknown" && outcome.message).toContain("no start was sent");
    expect(starts).toHaveLength(0);
    expect(targets).toHaveLength(1);
    // A later explicit attempt in a live scope reuses the retained target.
    state.current = true;
    const retry = await runner.run({ decisionId: "dec-1", title: "Branch", expectedRevision: 1 });
    expect(retry).toMatchObject({ kind: "ready" });
    expect(targets).toHaveLength(1);
    expect(String(starts[0]!.childThreadId)).toBe(String(targets[0]));
  });

  it("refuses while an attempt for the same decision is already running", async () => {
    const start = deferred<ProviderWorkbenchDecisionActionResult>();
    const harness = makeRunner({ startResult: () => start.promise });
    const running = harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    const concurrent = await harness.runner.run({
      decisionId: "dec-1",
      title: "Branch",
      expectedRevision: 1,
    });
    expect(concurrent).toMatchObject({ kind: "refused" });
    start.resolve(readyResult("child-1"));
    expect(await running).toMatchObject({ kind: "ready" });
  });

  it("a failed target creation refuses without capturing an attempt or sending", async () => {
    const starts: CapturedBranchAttempt[] = [];
    const runner = new BranchAttemptRunner({
      createTarget: () => Promise.reject(new Error("thread.create failed")),
      startBranch: (attempt) => {
        starts.push(attempt);
        return Promise.resolve(readyResult("child-1"));
      },
      isCurrent: () => true,
      onReady: () => undefined,
    });
    const outcome = await runner.run({ decisionId: "dec-1", title: "Branch", expectedRevision: 1 });
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(starts).toHaveLength(0);
    expect(runner.attemptFor("dec-1")).toBeUndefined();
  });
});
