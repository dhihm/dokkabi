import { writeFileSync } from "node:fs";
import { writeWorkPlan } from "./decompose.ts";
import { readDecomposedPlan } from "./graph.ts";
import { normalizePlanFields } from "./plan-scaffold.ts";
import type { WorkPlan } from "./schema.ts";
import { validatePlan } from "./validate.ts";

export type RepairAction =
  | { name: "plan_normalize"; added: string[] }
  | { name: "plan_repair_failed"; error: string };

export interface RepairResult {
  plan: WorkPlan;
  errors: string[];
  action?: RepairAction;
}

/**
 * Content-preserving repair of a refused decompose. The host may relocate and
 * normalize what the model ALREADY wrote — hoist scenario/case objects nested
 * inside todos, backfill ids and red/green wording — but it never authors
 * todos, scenarios, or cases. A plan that cannot seal after this stays
 * refused: the reasons go back to the model on the next turn, or the run ends
 * with an honest non-done exit (host plan authoring is retired).
 */
export function repairDecomposedPlan(input: {
  plan: WorkPlan;
  errors: string[];
  planPath: string;
  workspaceRoot: string;
  order?: string;
}): RepairResult {
  if (input.errors.length === 0) {
    return { plan: input.plan, errors: input.errors };
  }
  try {
    const filled = normalizePlanFields(input.plan);
    // Touch the model's file only when normalizing changed something AND the
    // error set strictly SHRANK (run 28: all-or-nothing repair left title
    // noise stapled to the one genuine case-command violation, and every
    // retry re-litigated both). A partial repair narrows the refusal to what
    // only the model can fix; an unchanged or grown set keeps the original
    // refusal describing what the model really wrote.
    const remaining = validatePlan(filled.plan);
    if (filled.added.length === 0 || remaining.length >= input.errors.length) {
      return { plan: input.plan, errors: input.errors };
    }
    // writeWorkPlan seals only valid plans; a still-invalid (but improved)
    // plan lands as raw JSON so the next decompose retry starts from the
    // normalized shape.
    if (remaining.length === 0) {
      writeWorkPlan(input.planPath, filled.plan);
    } else {
      writeFileSync(input.planPath, `${JSON.stringify(filled.plan, null, 2)}\n`);
    }
    const rebuilt = readDecomposedPlan(input.workspaceRoot, input.order, input.planPath);
    return {
      plan: rebuilt.plan,
      errors: rebuilt.errors,
      action: { name: "plan_normalize", added: filled.added },
    };
  } catch (error) {
    // A repair that itself fails must surface as a refusal, never a crash —
    // the fourth sk-13241 envfix child died silently inside writeWorkPlan.
    const message = error instanceof Error ? error.message : String(error);
    return {
      plan: input.plan,
      errors: [...input.errors, `plan repair failed: ${message.slice(0, 120)}`],
      action: { name: "plan_repair_failed", error: message.slice(0, 200) },
    };
  }
}
