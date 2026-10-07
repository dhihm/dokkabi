import { expect, it } from "vite-plus/test";
import { ThreadId, type ProviderWorkbenchDecisionActionResult } from "@t3tools/contracts";
import { BranchAttemptRunner } from "./WorkbenchBranchesBar.logic";

const input = { decisionId: "review-decision", title: "Review", expectedRevision: 1 };
function fixture() {
  const effects = { targets: 0, starts: 0, navigations: [] as string[], current: true };
  let answer: ProviderWorkbenchDecisionActionResult = { state: "unknown" };
  const runner = new BranchAttemptRunner({
    createTarget: async () => {
      effects.targets += 1;
      return ThreadId.make("review-child");
    },
    startBranch: async () => {
      effects.starts += 1;
      return answer;
    },
    isCurrent: () => effects.current,
    onReady: (id) => {
      effects.navigations.push(String(id));
    },
  });
  return {
    runner,
    effects,
    setAnswer: (value: ProviderWorkbenchDecisionActionResult) => {
      answer = value;
    },
  };
}

it("primary: an inactive scope cannot allocate or dispatch a branch", async () => {
  const f = fixture();
  f.effects.current = false;
  await f.runner.run(input);
  expect(f.effects.targets).toBe(0);
  expect(f.effects.starts).toBe(0);
});
it("primary: a stopped existing attempt cannot resend before checking its owner", async () => {
  const f = fixture();
  await f.runner.run(input);
  f.runner.stop();
  await f.runner.run(input);
  expect(f.effects.targets).toBe(1);
  expect(f.effects.starts).toBe(1);
});
it("primary: a ready response for a different target cannot navigate", async () => {
  const f = fixture();
  f.setAnswer({
    state: "ready",
    child: {
      id: "foreign-child",
      sessionId: "foreign-session",
      workspacePath: "/tmp/foreign-workspace",
      parent: { clientId: "review-client", threadId: "review-parent" },
      binding: { clientId: "review-client", threadId: "foreign-thread" },
    },
  });
  const result = await f.runner.run(input);
  expect(f.effects.navigations).toEqual([]);
  expect(result.kind).not.toBe("ready");
});
