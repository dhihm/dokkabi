import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import type { EventLog } from "../host/event-log.ts";
import { MAX_MONKEY_K } from "../eval/monkey.ts";
import { SWARM_CANDIDATE_ROLES, SWARM_ROLES, type SwarmCandidateRole, type SwarmRole } from "../swarm/routes.ts";
import type { SwarmCommandArguments } from "../swarm/cli.ts";
import type { SwarmWorldSpec } from "../swarm/world.ts";
import { networkDenied } from "../host/sandbox.ts";

/**
 * 돗가비 장터 (issue #60), phase 0: an operator-curated, digest-bound
 * catalog of inference recipes. A recipe is DATA the loop consumes — it
 * fixes the swarm's candidates/routes/world and the monkey axes k/heung/
 * temperature (#59 semantics) — never code, never a hot-loaded byte
 * (docs/plugins.md, docs/non-goals.md). Loading is fail closed: an unknown
 * id, a body that drifted from its catalog digest, or a field the schema
 * cannot account for refuses before anything spawns (#60 S3). Children see
 * the recipe's digest on their dispatch contract, not its body (#60 T1).
 */

export interface MarketRecipeV1 {
  readonly format: 1;
  /** Catalog key and filename stem. */
  readonly id: string;
  /** Candidate roles the swarm runs in parallel (never the reviewer). */
  readonly candidates: readonly SwarmCandidateRole[];
  /** Role → NAMED route. Roles the recipe does not name keep the ambient
   * default. Model-id branching stays forbidden (constitution 7). */
  readonly routes: Readonly<Partial<Record<SwarmRole, string>>>;
  /** Independent-sample budget, #59 semantics. 1 = single run. */
  readonly k: number;
  /** HEUNG on the winner's continuation (#59: monkey ⊥ HEUNG). */
  readonly heung: boolean;
  readonly max_steps: number;
  readonly world: "local" | "docker";
  /** Sampling temperature, (0, 2]. Absent = the #59 campaign default. */
  readonly temperature?: number;
  /** Plan-authoring strategy (#60 phase 2): the sequential refine loop or
   * k independent draws (ralph-sample, where k doubles as the draw count).
   * Absent = ralph-refine, today's behavior. */
  readonly planner?: "ralph-refine" | "ralph-sample";
}

export interface LoadedMarketRecipe {
  readonly recipe: MarketRecipeV1;
  readonly digest: string;
}

const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RECIPE_KEYS = ["candidates", "format", "heung", "id", "k", "max_steps", "routes", "world"] as const;
const OPTIONAL_RECIPE_KEYS = ["planner", "temperature"] as const;

function fail(message: string): never {
  throw new Error(`market recipe: ${message}`);
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unknown or missing fields`);
  }
}

export function assertMarketRecipe(value: unknown): asserts value is MarketRecipeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("body must be an object");
  const body = value as Record<string, unknown>;
  requireExactKeys(
    body,
    [...RECIPE_KEYS, ...OPTIONAL_RECIPE_KEYS.filter((key) => key in body)],
    "body",
  );
  if (body.format !== 1) fail("format must be 1");
  if (typeof body.id !== "string" || !RECIPE_ID.test(body.id)) fail("id must be kebab-case [a-z0-9-]");
  if (!Array.isArray(body.candidates) || body.candidates.length === 0) fail("candidates must be non-empty");
  for (const role of body.candidates) {
    if (!SWARM_CANDIDATE_ROLES.some((candidate) => candidate === role)) {
      fail(`candidate ${String(role)} is not a swarm candidate role`);
    }
  }
  if (new Set(body.candidates).size !== body.candidates.length) fail("candidates must be unique");
  if (typeof body.routes !== "object" || body.routes === null || Array.isArray(body.routes)) {
    fail("routes must be an object");
  }
  for (const [role, route] of Object.entries(body.routes as Record<string, unknown>)) {
    if (!SWARM_ROLES.some((known) => known === role)) fail(`routes names unknown role ${role}`);
    if (typeof route !== "string" || route.trim().length === 0) fail(`route for ${role} must be a named route`);
  }
  if (!Number.isInteger(body.k) || Number(body.k) < 1 || Number(body.k) > MAX_MONKEY_K) {
    fail(`k must be an integer from 1 to ${MAX_MONKEY_K} (#59 semantics)`);
  }
  if (typeof body.heung !== "boolean") fail("heung must be boolean");
  if (!Number.isInteger(body.max_steps) || Number(body.max_steps) < 1 || Number(body.max_steps) > 200) {
    fail("max_steps must be an integer from 1 to 200");
  }
  if (body.world !== "local" && body.world !== "docker") fail("world must be local or docker");
  if ("temperature" in body) {
    const temperature = body.temperature;
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature <= 0 || temperature > 2) {
      fail("temperature must be in (0, 2]");
    }
  }
  if ("planner" in body && body.planner !== "ralph-refine" && body.planner !== "ralph-sample") {
    fail("planner must be ralph-refine or ralph-sample");
  }
}

/** Canonical, field-sensitive identity: any change to any field is a new
 * recipe and therefore a new child contract (#60 S2). */
export function marketRecipeDigest(recipe: MarketRecipeV1): string {
  assertMarketRecipe(recipe);
  return createHash("sha256").update(canonicalJson(recipe)).digest("hex");
}

export function marketCatalogPath(root: string): string {
  return join(root, "market", "catalog.json");
}

/**
 * Load one recipe by id from the repo-local market. Fail closed on an
 * unknown id, a schema violation, an id/filename mismatch, or a body whose
 * digest disagrees with the catalog — the catalog is the operator's seal,
 * and a drifted body must not run under the old name (#60 S3).
 */
export function loadMarketRecipe(id: string, root: string): LoadedMarketRecipe {
  const catalogPath = marketCatalogPath(root);
  if (!existsSync(catalogPath)) fail(`no catalog at ${catalogPath}`);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    format?: unknown;
    recipes?: Record<string, unknown>;
  };
  if (catalog.format !== 1 || typeof catalog.recipes !== "object" || catalog.recipes === null) {
    fail("catalog is malformed");
  }
  const sealed = catalog.recipes[id];
  if (typeof sealed !== "string") fail(`id ${id} is not in the catalog`);
  const bodyPath = join(root, "market", "recipes", `${id}.json`);
  if (!existsSync(bodyPath)) fail(`catalog names ${id} but ${bodyPath} is missing`);
  const body = JSON.parse(readFileSync(bodyPath, "utf8")) as unknown;
  assertMarketRecipe(body);
  if (body.id !== id) fail(`body id ${body.id} disagrees with requested id ${id}`);
  const digest = marketRecipeDigest(body);
  if (digest !== sealed) {
    fail(`body digest ${digest.slice(0, 12)}… disagrees with catalog seal ${sealed.slice(0, 12)}… for ${id}`);
  }
  return { recipe: body, digest };
}

/** Constitution 6: a run that used a recipe says so — id, digest, and which
 * axes THIS surface enforced (the digest alone cannot say, since surfaces
 * own different axes). Never the body: children get the digest on their
 * dispatch (#60 T1). */
export function recordMarketRecipe(
  log: EventLog,
  input: { id: string; digest: string; applied?: readonly string[] },
): void {
  log.append({
    kind: "observe",
    name: "market/recipe",
    payload: {
      id: input.id,
      digest: input.digest,
      ...(input.applied ? { applied: [...input.applied] } : {}),
    },
  });
}

export interface InstanceRecipeAxes {
  readonly k: number;
  readonly heung: boolean;
  readonly maxSteps: number;
  readonly temperature?: number;
  readonly route?: string;
}

/**
 * The monkey axes a recipe fixes on the SWE instance runner (#60 T2, #59
 * semantics): k, HEUNG, temperature, steps, and the lead role's named
 * route. The runner is local-only in v1, so a docker recipe fails closed
 * instead of silently running in the wrong world.
 */
export function applyInstanceRecipe(recipe: MarketRecipeV1): InstanceRecipeAxes {
  assertMarketRecipe(recipe);
  if (recipe.world !== "local") {
    fail(`recipe ${recipe.id} fixes a docker world; the SWE instance runner is local-only in v1`);
  }
  if (recipe.planner !== undefined) {
    fail(`recipe ${recipe.id} fixes a planner strategy; the instance runner executes — use dokkabi ralph plan --recipe`);
  }
  // A sealed digest must never attest axes a surface silently dropped
  // (PR #92 review finding 1): the runner is single-agent, so a
  // multi-candidate recipe is a swarm recipe and belongs to `dokkabi swarm`.
  if (recipe.candidates.length !== 1 || recipe.candidates[0] !== "lead") {
    fail(`recipe ${recipe.id} shapes a swarm (candidates ${recipe.candidates.join(",")}); the instance runner is single-agent — use dokkabi swarm`);
  }
  return {
    k: recipe.k,
    heung: recipe.heung,
    maxSteps: recipe.max_steps,
    ...(recipe.temperature !== undefined ? { temperature: recipe.temperature } : {}),
    ...(recipe.routes.lead ? { route: recipe.routes.lead } : {}),
  };
}

export interface AppliedSwarmRecipe extends SwarmCommandArguments {
  readonly routes: Readonly<Partial<Record<SwarmRole, string>>>;
  readonly recipe: { readonly id: string; readonly digest: string };
}

/**
 * The recipe FIXES the swarm shape (#60 T2). parseSwarmCommandArgs already
 * refused conflicting explicit flags; this only substitutes the recipe's
 * axes into the parsed arguments.
 */
export function applySwarmRecipe(
  parsed: SwarmCommandArguments,
  recipe: MarketRecipeV1,
  digest: string,
): AppliedSwarmRecipe {
  assertMarketRecipe(recipe);
  if (recipe.planner !== undefined) {
    fail(`recipe ${recipe.id} fixes a planner strategy; the swarm executes — use dokkabi ralph plan --recipe`);
  }
  // The swarm path has no monkey coordinator: silently dropping k/heung/
  // temperature would leave every child contract sealed under axes that
  // were never in force (PR #92 review finding 1). Fail closed instead.
  if (recipe.k > 1 || recipe.heung || recipe.temperature !== undefined) {
    fail(
      `recipe ${recipe.id} carries monkey axes (k=${recipe.k} heung=${recipe.heung}` +
        `${recipe.temperature !== undefined ? ` temperature=${recipe.temperature}` : ""}) — ` +
        "the swarm path cannot enforce them; run it through the SWE instance runner",
    );
  }
  const network = networkDenied("workspace-write") ? "deny" : "allow";
  let world: SwarmWorldSpec;
  if (recipe.world === "local") {
    world = { kind: "local", network };
  } else {
    const image = process.env.DOKKABI_SWARM_DOCKER_IMAGE?.trim();
    if (!image) fail(`recipe ${recipe.id} needs a docker world: set DOKKABI_SWARM_DOCKER_IMAGE`);
    world = { kind: "docker", image, network };
  }
  return {
    ...parsed,
    candidates: [...recipe.candidates],
    maxSteps: recipe.max_steps,
    world,
    routes: recipe.routes,
    recipe: { id: recipe.id, digest },
  };
}
