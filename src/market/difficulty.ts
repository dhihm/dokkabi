import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import type { EventLog } from "../host/event-log.ts";
import { applyInstanceRecipe, loadMarketRecipe, marketCatalogPath } from "./recipe.ts";

/**
 * Difficulty-binned recipe allocation (#59 T5, Snell et al. 2408.03314):
 * a small pilot measures how hard THIS instance is for THIS route, and a
 * sealed POLICY — data, never an `if (difficulty)` in any loop
 * (constitution 7) — maps the measured coverage to a sealed recipe. Easy
 * bins can prefer revision (k=1 + HEUNG), medium bins independent samples,
 * and a floor bin maps to the smallest spend instead of inflating k
 * (#59 S8: coverage 0 is recorded honestly, never papered over). The
 * pilot's own cost is on the log and inside the trial total — never a
 * hidden free oracle.
 */

export interface MarketPolicyBin {
  /** Inclusive upper bound on pilot coverage for this bin. */
  readonly max_coverage: number;
  /** A CATALOGED recipe id — resolved fail-closed at load time. */
  readonly recipe: string;
}

export interface MarketPolicyV1 {
  readonly format: 1;
  readonly id: string;
  /** Independent pilot draws (no early stop — the pilot measures). */
  readonly pilot_k: number;
  /** Ascending by max_coverage; the last bin must reach 1. */
  readonly bins: readonly MarketPolicyBin[];
}

export interface LoadedMarketPolicy {
  readonly policy: MarketPolicyV1;
  readonly digest: string;
}

const POLICY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POLICY_KEYS = ["bins", "format", "id", "pilot_k"] as const;
const MAX_PILOT_K = 8;

function fail(message: string): never {
  throw new Error(`market policy: ${message}`);
}

export function assertMarketPolicy(value: unknown): asserts value is MarketPolicyV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("body must be an object");
  const body = value as Record<string, unknown>;
  const actual = Object.keys(body).sort();
  const expected = [...POLICY_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("body has unknown or missing fields");
  }
  if (body.format !== 1) fail("format must be 1");
  if (typeof body.id !== "string" || !POLICY_ID.test(body.id)) fail("id must be kebab-case [a-z0-9-]");
  if (!Number.isInteger(body.pilot_k) || Number(body.pilot_k) < 1 || Number(body.pilot_k) > MAX_PILOT_K) {
    fail(`pilot_k must be an integer from 1 to ${MAX_PILOT_K}`);
  }
  if (!Array.isArray(body.bins) || body.bins.length === 0) fail("bins must be non-empty");
  let previous = 0;
  for (const bin of body.bins) {
    if (typeof bin !== "object" || bin === null || Array.isArray(bin)) fail("bin must be an object");
    const row = bin as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    if (keys.length !== 2 || keys[0] !== "max_coverage" || keys[1] !== "recipe") {
      fail("bin has unknown or missing fields");
    }
    if (typeof row.max_coverage !== "number" || row.max_coverage <= previous || row.max_coverage > 1) {
      fail("bins must be strictly increasing in max_coverage and stay within (0, 1]");
    }
    previous = row.max_coverage;
    if (typeof row.recipe !== "string" || row.recipe.length === 0) fail("bin recipe must be a catalog id");
  }
  if (previous !== 1) fail("the last bin must reach max_coverage 1 — every measurement needs a home");
}

export function marketPolicyDigest(policy: MarketPolicyV1): string {
  assertMarketPolicy(policy);
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

/**
 * Load one policy by id, fail closed like a recipe (#60 S3): unknown id,
 * schema violation, id mismatch, digest drift — and every bin's recipe id
 * must itself be sealed in the catalog, so a policy can never smuggle an
 * unknown recipe past the recipe loader.
 */
export function loadMarketPolicy(id: string, root: string): LoadedMarketPolicy {
  const catalogPath = marketCatalogPath(root);
  if (!existsSync(catalogPath)) fail(`no catalog at ${catalogPath}`);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    format?: unknown;
    recipes?: Record<string, unknown>;
    policies?: Record<string, unknown>;
  };
  if (catalog.format !== 1 || typeof catalog.recipes !== "object" || catalog.recipes === null) {
    fail("catalog is malformed");
  }
  const sealed = catalog.policies?.[id];
  if (typeof sealed !== "string") fail(`policy ${id} is not in the catalog`);
  const bodyPath = join(root, "market", "policies", `${id}.json`);
  if (!existsSync(bodyPath)) fail(`catalog names policy ${id} but ${bodyPath} is missing`);
  const body = JSON.parse(readFileSync(bodyPath, "utf8")) as unknown;
  assertMarketPolicy(body);
  if (body.id !== id) fail(`policy body id ${body.id} disagrees with requested id ${id}`);
  const digest = marketPolicyDigest(body);
  if (digest !== sealed) {
    fail(`policy digest ${digest.slice(0, 12)}… disagrees with catalog seal ${sealed.slice(0, 12)}… for ${id}`);
  }
  for (const bin of body.bins) {
    if (typeof catalog.recipes[bin.recipe] !== "string") {
      fail(`policy bin recipe ${bin.recipe} is not in the catalog`);
    }
    // The bin recipe must be one the instance runner can HONOR — a planner
    // or docker or multi-candidate recipe smuggled through a bin would hit
    // the same silent-drop hole the surfaces refuse (PR #94 review H2).
    applyInstanceRecipe(loadMarketRecipe(bin.recipe, root).recipe);
  }
  return { policy: body, digest };
}

/** The largest campaign this policy could start — max over bin ks and the
 * pilot itself (pilot draws are independent samples too). The sweep-level
 * retries/swarm guards see this number. */
export function worstPolicyK(id: string, root: string): number {
  const loaded = loadMarketPolicy(id, root);
  return Math.max(
    loaded.policy.pilot_k,
    ...loaded.policy.bins.map((bin) => applyInstanceRecipe(loadMarketRecipe(bin.recipe, root).recipe).k),
  );
}

/** The table read the loop performs instead of a difficulty branch: the
 * first bin whose inclusive upper bound holds the measured coverage. */
export function selectPolicyBin(
  policy: MarketPolicyV1,
  pilotCoverage: number,
): { bin: number; recipe: string } {
  for (let index = 0; index < policy.bins.length; index += 1) {
    if (pilotCoverage <= policy.bins[index]!.max_coverage) {
      return { bin: index, recipe: policy.bins[index]!.recipe };
    }
  }
  const last = policy.bins.length - 1;
  return { bin: last, recipe: policy.bins[last]!.recipe };
}

/** Constitution 6: the pilot, the bin, and the chosen seal are on the log —
 * the pilot is never a hidden oracle (#59: 숨긴 2048샘플 빈 금지). */
export function recordMonkeyDifficulty(
  log: EventLog,
  input: {
    policy: string;
    policyDigest: string;
    pilotK: number;
    pilotResolved: number;
    bin: number;
    recipe: string;
    recipeDigest: string;
  },
): void {
  log.append({
    kind: "observe",
    name: "monkey/difficulty",
    payload: {
      policy: input.policy,
      policy_digest: input.policyDigest,
      pilot_k: input.pilotK,
      pilot_resolved: input.pilotResolved,
      pilot_coverage: input.pilotK > 0 ? input.pilotResolved / input.pilotK : 0,
      bin: input.bin,
      recipe: input.recipe,
      recipe_digest: input.recipeDigest,
    },
  });
}
