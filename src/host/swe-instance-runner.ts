import { existsSync } from "node:fs";
import { join } from "node:path";

const SWE_RUNNER_SCRIPT = join("scripts", "run-swe-instance.ts");

export function sweInstanceRunnerScriptPresent(repoRoot: string): boolean {
  return existsSync(join(repoRoot, SWE_RUNNER_SCRIPT));
}

export function monkeymodeWorkRefusalMessage(repoRoot: string): string {
  const lead =
    "monkeymode draws independent verifier-scored samples, which `dokkabi work` cannot host yet — ";
  if (sweInstanceRunnerScriptPresent(repoRoot)) {
    return (
      lead +
      "run `bun scripts/run-swe-instance.ts --k N`, or set a campaign default with `dokkabi monkeymode on`"
    );
  }
  return (
    lead +
    "the SWE instance runner workflow is not available in this build; set a campaign default with `dokkabi monkeymode on`"
  );
}

function executionRecipeDirection(repoRoot: string): string {
  if (sweInstanceRunnerScriptPresent(repoRoot)) {
    return "run-swe-instance/swarm";
  }
  return "`dokkabi swarm`";
}

export function workExecutionRecipeRefusalMessage(repoRoot: string): string {
  return `--recipe on \`dokkabi work\` drives only Ralph Plan; use ${executionRecipeDirection(repoRoot)} for execution recipes`;
}

export function ralphPlanExecutionRecipeRefusalMessage(recipeId: string, repoRoot: string): string {
  return `recipe ${recipeId} has no planner axis — Ralph Plan authors plans; use ${executionRecipeDirection(repoRoot)} to execute it`;
}

export function dashNoSweCampaignMessage(
  home: string,
  availableSuffix: string,
  repoRoot: string,
): string {
  if (sweInstanceRunnerScriptPresent(repoRoot)) {
    return (
      `no SWE campaign yet under ${home}/sessions (no swe-* EventLog). Start one with bun scripts/run-swe-instance.ts, then dash --session swe follows the newest swe-*.` +
      availableSuffix
    );
  }
  return (
    `no SWE campaign yet under ${home}/sessions (no swe-* EventLog). The SWE instance runner workflow is not available in this build.` +
    availableSuffix
  );
}
