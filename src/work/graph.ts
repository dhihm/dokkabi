import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { takeHeungSignal } from "./heung.ts";
import { loadWorkPlan } from "./load.ts";
import { WORK_CLASSES, type WorkPlan } from "./schema.ts";
import { TOOL_PROFILE_NAMES } from "../loader/tool-profiles.ts";
import { formatPlanGraphStats, planGraphStats, reviewPlanQuality } from "./plan-quality.ts";
import { reviewPlanFiles } from "./validate.ts";
import { renderPrompt } from "./prompt-slots.ts";
import { caseCommandHint } from "./case-runners.ts";
import type { DraftPlan } from "./draft-plan.ts";
import type { WorkCeiling } from "./ceiling.ts";

export function currentPlanPath(repoRoot: string): string {
  return resolve(repoRoot, "work", "current.json");
}

/** An implement-ceiling run may reuse a sealed graph the prior stage already wrote. */
export function shouldReuseSealedWorkPlan(input: {
  ceiling: WorkCeiling | undefined;
  workspaceRoot: string;
}): boolean {
  return input.ceiling === "implement" && existsSync(currentPlanPath(input.workspaceRoot));
}

/** Read a prior-stage graph for reuse. Pipeline order text must not be order-matched. */
export function readSealedWorkPlan(
  workspaceRoot: string,
  planPath?: string,
): { plan: WorkPlan; errors: string[] } {
  return readDecomposedPlan(workspaceRoot, undefined, planPath);
}

export type SealedPlanReuseKind = "off" | "handoff" | "covered";

/**
 * Reuse binds to AUTHORITY, never to the mere existence of a leftover
 * current.json (PR #96 review H2): the pipeline handoff env grants
 * coverage-free reuse (the architect just sealed this exact plan for this
 * exact task); an interactive run may reuse only a plan that PROVES it
 * covers this order; and an active ralph draft always decomposes with the
 * draft — reusing around it would seal a provenance lie (M3).
 */
export function sealedPlanReuseMode(input: {
  order: string | undefined;
  hasPlanFlag: boolean;
  ralphActive: boolean;
  ceiling: WorkCeiling | undefined;
  planExists: boolean;
  handoff: boolean;
}): SealedPlanReuseKind {
  if (!input.order || input.hasPlanFlag || input.ralphActive) return "off";
  if (input.ceiling !== "implement" || !input.planExists) return "off";
  return input.handoff ? "handoff" : "covered";
}

/** Whether an implement child should open on plan_reuse instead of decompose. */
export function resolveSealedPlanReuse(input: {
  ceiling: WorkCeiling | undefined;
  workspaceRoot: string;
}): { action: "plan_reuse" | "decompose"; errors: string[] } {
  if (!shouldReuseSealedWorkPlan(input)) {
    return { action: "decompose", errors: [] };
  }
  const read = readSealedWorkPlan(input.workspaceRoot);
  if (read.errors.length === 0) {
    return { action: "plan_reuse", errors: [] };
  }
  return { action: "decompose", errors: read.errors };
}

export function isTemplatePlan(plan: WorkPlan): boolean {
  return plan.todos.every((todo) => todo.id === "todo-ask") &&
    plan.cases.some((item) => item.command.includes("goal-ask-missing.test.ts"));
}

export interface PlanningPromptContext {
  readonly enrolledCommands?: readonly string[];
  readonly enrollmentDigest?: string;
  readonly priorRefusals?: readonly string[];
  readonly repeatedRefusalAttempts?: number;
}

function planningConstraintBlock(context: PlanningPromptContext): string {
  return context.enrolledCommands ? [
    "Host-enrolled case commands (JSON-encoded exact execution constraints):",
    ...(context.enrollmentDigest ? [`Retained enrollment digest: ${context.enrollmentDigest}`] : []),
    "Decode each JSON string once to obtain the exact executable command; quotes and backslashes here are JSON encoding, not extra shell characters.",
    ...context.enrolledCommands.map(command => `- ${JSON.stringify(command)}`),
    "Use only these exact commands. This repertoire permits commands; it does not require extra cases or todos. Each selected command still needs its registered runner and case contract. Runner registration cannot expand enrollment. Do not invent a new check or narrow an enrolled command. When host enrollment is present, take RED from its existing authorized checker; do not create or rewrite its checker. This supersedes the generic new-RED instructions below.",
  ].join("\n") : "";
}

export function buildDecomposePrompt(order: string, ralphDraft?: DraftPlan, context: PlanningPromptContext = {}): string {
  return renderPrompt("work/decompose.md", {
    order: order.trim(),
    planning_constraints: planningConstraintBlock(context),
    prior_refusals: context.priorRefusals?.length
      ? [
          `The previous planning attempt was refused. Correct these actual errors; restarting does not remove them:\n${context.priorRefusals.map(error => `- ${error}`).join("\n")}`,
          ...(context.repeatedRefusalAttempts && context.repeatedRefusalAttempts >= 3 ? [
            `The same refusal set persisted for ${context.repeatedRefusalAttempts} consecutive planning attempts despite repair. Diagnose the cause from the current plan, offending artifacts and recorded host constraints before writing another proposal. Do not resubmit an unchanged proposal or invent authority to bypass an unrepairable host constraint; report the concrete blocker when the mounted tools cannot repair it.`,
          ] : []),
        ].join("\n")
      : "",
    ralph_draft_block: ralphDraft
      ? [
          "Host-validated Ralph DraftPlan (planning evidence, not RED/GREEN evidence):",
          JSON.stringify(ralphDraft, null, 2),
          "Translate this scope into the executable WorkPlan below. Inspect before relying on a stale evidence reference, and do not silently add or remove an observable boundary.",
        ].join("\n")
      : "",
    case_hint: caseCommandHint(),
    work_classes: WORK_CLASSES.join("|"),
    tool_profiles: TOOL_PROFILE_NAMES.join("|"),
  }).trimEnd();
}

export function buildDecomposeRetryPrompt(order: string, errors: string[], context: PlanningPromptContext = {}): string {
  return renderPrompt("work/decompose-retry.md", {
    order: order.trim(),
    refusal_reasons: errors.map((error) => `- ${error}`).join("\n"),
    planning_constraints: planningConstraintBlock(context),
    case_hint: caseCommandHint(),
  }).trimEnd();
}

export function readDecomposedPlan(
  /** Workspace root: where tests were written and where work/current.json lives. */
  workspaceRoot: string,
  order?: string,
  /** Override plan path (default: <workspace>/work/current.json). */
  planPath?: string,
  options: { readonly authenticatedExternalPrerequisiteIds?: ReadonlySet<string> } = {},
): { plan: WorkPlan; errors: string[] } {
  const path = planPath ?? currentPlanPath(workspaceRoot);
  if (!existsSync(path)) {
    return { plan: emptyPlan(), errors: [`${path} is missing (expected work/current.json in the workspace)`] };
  }
  const loaded = loadWorkPlan(path, options);
  if (loaded.errors.length > 0) {
    return loaded;
  }
  if (isTemplatePlan(loaded.plan)) {
    return { plan: loaded.plan, errors: ["work/current.json is still the one-todo template, not a graph"] };
  }
  // A single real todo is allowed. Only the host placeholder template is refused.
  if (order && !planCoversOrder(takeHeungSignal(order).order, loaded.plan)) {
    return {
      plan: loaded.plan,
      errors: ["work/current.json is still the previous goal, not this order"],
    };
  }
  // RED test files are relative to the workspace the model wrote into.
  const fileErrors = reviewPlanFiles(loaded.plan, workspaceRoot);
  const qualityErrors = reviewPlanQuality(loaded.plan, {
    allowAtomic: true,
    authenticatedExternalPrerequisiteIds: options.authenticatedExternalPrerequisiteIds,
  });
  const errors = [...loaded.errors, ...fileErrors, ...qualityErrors];
  if (errors.length > 0) {
    return { plan: loaded.plan, errors };
  }
  return loaded;
}

/** Stats for dash / eval after a plan seals. */
export function sealedPlanStats(plan: WorkPlan): string {
  return formatPlanGraphStats(planGraphStats(plan));
}

/** The operator order is the goal. Cases may invent CLI contracts; the goal may not. */
export function applyOperatorGoal(plan: WorkPlan, order: string): WorkPlan {
  const statement = takeHeungSignal(order).order.replace(/\s+/g, " ").trim();
  if (!statement || plan.goal.statement === statement) {
    return plan;
  }
  return {
    ...plan,
    goal: {
      ...plan.goal,
      statement,
    },
  };
}

/** The COVERED reuse gate: an interactive run may reuse a sealed plan only
 * to resume the SAME order — planCoversOrder's hits>=1 heuristic is a
 * decompose sanity check, far too loose to stop a stale plan hijacking an
 * unrelated later order (PR #96 review H2). */
export function sealedPlanMatchesOrder(order: string, plan: WorkPlan): boolean {
  const compact = (text: string) => text.replace(/\s+/gu, " ").trim();
  return compact(plan.goal.statement) === compact(order);
}

export function planCoversOrder(order: string, plan: WorkPlan): boolean {
  const ask = tokens(order);
  if (ask.size === 0) {
    return true;
  }
  const hay = tokens([plan.goal.statement, plan.goal.id, ...plan.todos.map((todo) => `${todo.title} ${todo.statement}`)].join(" "));
  let hits = 0;
  for (const word of ask) {
    if (hay.has(word)) {
      hits += 1;
    }
  }
  return hits >= 1;
}

function tokens(text: string): Set<string> {
  const skip = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "given"]);
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter((word) => word.length >= 3 && !skip.has(word)),
  );
}

function emptyPlan(): WorkPlan {
  return {
    goal: { id: "missing", statement: "missing" },
    todos: [],
    scenarios: [],
    cases: [],
  };
}
