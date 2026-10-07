import { resolve } from "node:path";
import { researchManifestPath } from "../eval/experiment/plugin-manifest.ts";

/**
 * The execution profiles a session can boot with, and the one resolver that
 * turns an operator's choice into a plugin manifest. `dokkabi work` boots
 * through it and `dokkabi doctor` diagnoses through it, so the profile a
 * diagnosis names is the profile a run would load — there is no second table.
 *
 * - `default`: plugins/manifest.json (manifest.experiment.json under
 *   DOKKABI_EXPERIMENT_MANIFEST) — chat, status, dash, and `work --planner host`.
 * - `ledger`: plugins/manifest.ledger.json — the `dokkabi work` default (D43).
 * - `plan-v2`: plugins/manifest.plan-v2.json — `work --planner model`.
 * - `model-loop`: plugins/manifest.model-loop.json — `work --loop model`.
 *
 * DOKKABI_RESEARCH_POLICY swaps each for its registered research surface at
 * boot (effectiveManifestPath), for diagnosis exactly as for a run.
 */
export const EXECUTION_PROFILE_NAMES = ["default", "ledger", "plan-v2", "model-loop"] as const;
export type ExecutionProfileName = (typeof EXECUTION_PROFILE_NAMES)[number];

export function isExecutionProfileName(value: unknown): value is ExecutionProfileName {
  return typeof value === "string" && (EXECUTION_PROFILE_NAMES as readonly string[]).includes(value);
}

/** `--loop` flag resolution: flag wins, DOKKABI_WORK_LOOP is the fallback,
 * graph stays the default. Anything else is an operator error, said loudly. */
export function resolveWorkLoop(
  flag: string | undefined,
  env: NodeJS.Dict<string> = process.env,
): "graph" | "model" {
  const value = flag ?? env.DOKKABI_WORK_LOOP ?? "graph";
  if (value !== "graph" && value !== "model") {
    throw new Error(`--loop must be graph or model, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** `--planner` flag resolution: flag wins, DOKKABI_WORK_PLANNER is the
 * fallback, ledger is the default (D43; it was host). The one exception is a
 * run that chose the model loop (`--loop model` / DOKKABI_WORK_LOOP) and no
 * planner: the ledger runs its own session and cannot take that loop, so the
 * choice keeps meaning what it meant — the model loop, which the ledger
 * default would otherwise refuse. Anything else is an operator error. */
export function resolveWorkPlanner(
  flag: string | undefined,
  loop: "graph" | "model" = "graph",
  env: NodeJS.Dict<string> = process.env,
): "host" | "model" | "ledger" {
  const chosen = flag ?? env.DOKKABI_WORK_PLANNER;
  const value = chosen ?? (loop === "model" ? "host" : "ledger");
  if (value !== "host" && value !== "model" && value !== "ledger") {
    throw new Error(`--planner must be host or model, or ledger (the default), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The profile a `dokkabi work` run with this loop and planner boots. */
export function workExecutionProfile(
  loop: "graph" | "model",
  planner: "host" | "model" | "ledger",
): ExecutionProfileName {
  if (loop === "model") return "model-loop";
  if (planner === "ledger") return "ledger";
  if (planner === "model") return "plan-v2";
  return "default";
}

/** A `dokkabi work` run's loop, planner and profile — including the refusal
 * of a combination no run can boot. `dokkabi work` and `dokkabi doctor` both
 * call this; neither decides admissibility on its own (#230, D1). */
export function resolveWorkExecution(
  flags: { readonly loop?: string; readonly planner?: string } = {},
  env: NodeJS.Dict<string> = process.env,
): { loop: "graph" | "model"; planner: "host" | "model" | "ledger"; profile: ExecutionProfileName } {
  const loop = resolveWorkLoop(flags.loop, env);
  const planner = resolveWorkPlanner(flags.planner, loop, env);
  if (planner === "ledger" && loop === "model") {
    throw new Error("--planner ledger runs its own session; --loop model does not apply to it");
  }
  return { loop, planner, profile: workExecutionProfile(loop, planner) };
}

/** The profile `dokkabi work` would boot with no flags, in this environment;
 * throws what `dokkabi work` would refuse with. */
export function effectiveWorkProfile(env: NodeJS.Dict<string> = process.env): ExecutionProfileName {
  return resolveWorkExecution({}, env).profile;
}

/** The manifest a profile names, before the research swap. */
export function profileManifestPath(
  repoRoot: string,
  profile: ExecutionProfileName,
  env: NodeJS.Dict<string> = process.env,
): string {
  switch (profile) {
    case "default":
      return resolve(repoRoot, "plugins", env.DOKKABI_EXPERIMENT_MANIFEST !== undefined ? "manifest.experiment.json" : "manifest.json");
    case "ledger":
      return resolve(repoRoot, "plugins", "manifest.ledger.json");
    case "plan-v2":
      return resolve(repoRoot, "plugins", "manifest.plan-v2.json");
    case "model-loop":
      return resolve(repoRoot, "plugins", "manifest.model-loop.json");
  }
}

/** The manifest boot actually loads for a requested one: the registered
 * research surface under DOKKABI_RESEARCH_POLICY, the request otherwise. */
export function effectiveManifestPath(manifestPath: string, env: NodeJS.Dict<string> = process.env): string {
  return env.DOKKABI_RESEARCH_POLICY !== undefined ? researchManifestPath(manifestPath) : manifestPath;
}
