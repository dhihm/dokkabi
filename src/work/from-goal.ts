import { validatePlan } from "./validate.ts";
import type { WorkPlan } from "./schema.ts";

export function planFromGoal(statement: string): WorkPlan {
  const text = statement.replaceAll("\n", " ").trim();
  if (!text) {
    throw new Error("work needs a goal sentence");
  }
  const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  const plan: WorkPlan = {
    goal: { id: "goal-ask", statement: text },
    todos: [
      {
        id: "todo-ask",
        title,
        class: "loop",
        priority: 10,
        blocked_by: [],
        statement: text,
      },
    ],
    scenarios: [
      {
        id: "scn-ask",
        todo: "todo-ask",
        given: "The operator issued this goal as dokkabi work text.",
        when: "The work loop implements todo-ask.",
        then: "EventLog has surface assistant/message",
      },
    ],
    cases: [
      {
        id: "case-ask",
        scenario: "scn-ask",
        layer: "contract",
        command: "bun test tests/goal-ask-missing.test.ts",
        red_means: "The goal has no case that can go green.",
        green_means: "A real case for this goal exists and passes.",
      },
    ],
  };
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    throw new Error(`goal plan invalid: ${errors.join("; ")}`);
  }
  return plan;
}
