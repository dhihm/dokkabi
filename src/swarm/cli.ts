import { resolve } from "node:path";
import { bootSession, defaultManifestPath } from "../boot.ts";
import { dokkabiHome } from "../host/paths.ts";
import { recordRun } from "../host/run-registry.ts";
import { applySwarmRecipe, loadMarketRecipe, type AppliedSwarmRecipe } from "../market/recipe.ts";
import { parseSwarmCandidateRoles, type SwarmCandidateRole } from "./routes.ts";
import type { SwarmRunResult, SwarmService } from "./service.ts";
import type { SwarmWorldSpec } from "./world.ts";
import { networkDenied } from "../host/sandbox.ts";
import { resolveThinkingLevel } from "../host/thinking.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface SwarmCommandArguments {
  sessionId: string;
  workspaceRoot: string;
  candidates: SwarmCandidateRole[];
  world: SwarmWorldSpec;
  maxSteps: number;
  timeoutMs: number;
  effort: ThinkingLevel;
  order: string;
  /** 돗가비 장터 recipe id (#60). The recipe FIXES candidates/world/steps/
   * routes, so those flags conflict with it and are refused at parse. */
  recipeId?: string;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

export function parseSwarmCommandArgs(args: readonly string[], cwd = process.cwd()): SwarmCommandArguments {
  let sessionId = `swarm-${Date.now().toString(36)}`;
  let workspaceRoot = cwd;
  let candidates: SwarmCandidateRole[] | undefined;
  const network = networkDenied("workspace-write") ? "deny" : "allow";
  let world: SwarmWorldSpec = { kind: "local", network };
  let worldKind: string | undefined;
  let maxSteps = 8;
  let timeoutMs = 20 * 60_000;
  let explicitEffort: string | undefined;
  let recipeId: string | undefined;
  const recipeFixed: string[] = [];
  const order: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--recipe") {
      const value = args[++i];
      if (!value) throw new Error("--recipe requires a catalog id");
      recipeId = value;
      continue;
    }
    if (arg === "--session") {
      const value = args[++i];
      if (!value) throw new Error("--session requires an id");
      sessionId = value;
      continue;
    }
    if (arg === "--workspace") {
      const value = args[++i];
      if (!value) throw new Error("--workspace requires a directory");
      workspaceRoot = value;
      continue;
    }
    if (arg === "--candidates") {
      candidates = parseSwarmCandidateRoles(args[++i]);
      recipeFixed.push("--candidates");
      continue;
    }
    if (arg === "--world") {
      // Note only the kind here: docker image resolution waits until after
      // the recipe-conflict check, so `--recipe … --world docker` reports
      // the conflict, not a misleading missing-image error.
      recipeFixed.push("--world");
      worldKind = args[++i];
      if (worldKind !== "local" && worldKind !== "docker") {
        throw new Error(`unknown swarm world ${worldKind ?? "(missing)"}`);
      }
      continue;
    }
    if (arg === "--max-steps") {
      maxSteps = positiveInteger(args[++i], "--max-steps");
      recipeFixed.push("--max-steps");
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = positiveInteger(args[++i], "--timeout-ms");
      continue;
    }
    if (arg === "--effort") {
      explicitEffort = args[++i];
      if (!explicitEffort) throw new Error("--effort requires a level");
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`unknown swarm flag ${arg}`);
    if (arg) order.push(arg);
  }
  const text = order.join(" ").trim();
  if (!text) throw new Error("swarm requires order text");
  // A recipe fixes these axes (#60 T2): silently blending an explicit flag
  // with a sealed recipe would blur which contract the children ran under.
  if (recipeId && recipeFixed.length > 0) {
    throw new Error(`--recipe fixes ${recipeFixed.join(", ")} — drop the flag or the recipe`);
  }
  if (worldKind === "docker") {
    const image = process.env.DOKKABI_SWARM_DOCKER_IMAGE?.trim();
    if (!image) throw new Error("Docker swarm world requires DOKKABI_SWARM_DOCKER_IMAGE");
    world = { kind: "docker", image, network };
  }
  return {
    sessionId,
    workspaceRoot: resolve(workspaceRoot),
    candidates: candidates ?? parseSwarmCandidateRoles(),
    world,
    maxSteps,
    timeoutMs,
    effort: resolveThinkingLevel(explicitEffort),
    order: text,
    ...(recipeId ? { recipeId } : {}),
  };
}

export function formatSwarmResult(result: SwarmRunResult): string {
  const lines = [
    `parent=${result.parentSessionId} status=${result.status} finalized=${result.finalized} patch=${result.patchDigest}`,
  ];
  for (const child of result.children) {
    lines.push(
      `role=${child.role} session=${child.sessionId} route=${child.route} status=${child.status} worktree=${child.workspaceRoot}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runSwarmCommand(args: readonly string[], repoRoot: string): Promise<number> {
  let parsed = parseSwarmCommandArgs(args);
  let routes: AppliedSwarmRecipe["routes"] | undefined;
  let recipe: AppliedSwarmRecipe["recipe"] | undefined;
  if (parsed.recipeId) {
    // Fail closed BEFORE any session effect: an unknown or drifted recipe
    // must not open a run (#60 S3).
    const loaded = loadMarketRecipe(parsed.recipeId, repoRoot);
    const applied = applySwarmRecipe(parsed, loaded.recipe, loaded.digest);
    parsed = applied;
    routes = applied.routes;
    recipe = applied.recipe;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  recordRun({ home: dokkabiHome(), session: parsed.sessionId, label: "swarm" });
  const { ctx, runtime } = await bootSession({
    sessionId: parsed.sessionId,
    workspaceRoot: parsed.workspaceRoot,
    manifestPath: defaultManifestPath(repoRoot),
    repoRoot,
  });
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const service = ctx.get<SwarmService>("swarm");
    const result = await service.run({
      order: parsed.order,
      candidates: parsed.candidates,
      maxSteps: parsed.maxSteps,
      timeoutMs: parsed.timeoutMs,
      effort: parsed.effort,
      world: parsed.world,
      signal: controller.signal,
      ...(routes ? { routes } : {}),
      ...(recipe ? { recipe } : {}),
    });
    process.stdout.write(formatSwarmResult(result));
    return result.status === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await runtime.dispose();
  }
}
