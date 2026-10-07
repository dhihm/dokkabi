import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkPlan } from "./schema.ts";
import { flattenPlanLeaves } from "./plan-scaffold.ts";
import { validatePlan, type PlanValidationOptions } from "./validate.ts";
import { assertNoRuntimeMarkers } from "../host/prefix.ts";

export function loadSystemPrompt(repoRoot: string): string {
  const prompt = readFileSync(resolve(repoRoot, "prompts", "system.md"), "utf8").trim();
  // Cache hygiene gate: runtime markers would make the frozen prefix
  // unstable and break replay — fail the boot, not a log line.
  assertNoRuntimeMarkers(prompt);
  return prompt;
}

export function loadWorkPlan(path: string, options: PlanValidationOptions = {}): { plan: WorkPlan; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      plan: emptyInvalidPlan(),
      errors: [`${path} is not valid JSON: ${message}`],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      plan: emptyInvalidPlan(),
      errors: ["work plan must be a JSON object with goal, todos, scenarios, cases"],
    };
  }
  const raw = parsed as WorkPlan;
  // Array-shape refusals cannot be repaired by flattening (a dict of todos
  // is not content we may invent). Keep them even after the shape-safe copy.
  const arrayErrors = validatePlan(raw, options).filter((error) => error.includes("must be a top-level ARRAY"));
  // The model writes this file; it may omit or miswrite any field. The
  // refusal lives in `errors` — the returned plan object is ALWAYS shape-safe
  // so downstream host code (scaffold, quality review, drive) never crashes
  // on the model's structure (third sk-13241 envfix run lesson).
  const shaped: WorkPlan = {
    ...raw,
    goal:
      raw.goal && typeof raw.goal === "object" && !Array.isArray(raw.goal)
        ? raw.goal
        : { id: "goal-invalid", statement: "" },
    todos: Array.isArray(raw.todos) ? raw.todos : [],
    scenarios: Array.isArray(raw.scenarios) ? raw.scenarios : [],
    cases: Array.isArray(raw.cases) ? raw.cases : [],
  };
  // Implement turns rewrite statement as an object (runs 37/38/39). Flatten
  // the model's own words so scoring and reload see a sealable plan.
  const plan = flattenPlanLeaves(shaped).plan;
  const errors = [...arrayErrors, ...validatePlan(plan, options)];
  return { plan, errors };
}

function emptyInvalidPlan(): WorkPlan {
  return { goal: { id: "goal-invalid", statement: "" }, todos: [], scenarios: [], cases: [] };
}
