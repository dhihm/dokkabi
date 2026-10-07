import type { FreeModel } from "../host/openrouter-free-models.ts";

/**
 * Tiering and role assignment for the free-model multi-agent mode.
 *
 * There is no per-model capability metadata in the codebase, so capability is
 * proxied by what the catalog does carry: context window, max output tokens,
 * and the reasoning flag. Each role prefers a weight class, and the roster
 * assigns the best-matching free model per role — distinct where the pool
 * allows, reused when the free pool is smaller than the role set — with a
 * per-role override for the operator's manual choice.
 */

export type WeightClass = "heavy" | "mid" | "light";

const HEAVY_CONTEXT = 128_000;
const MID_CONTEXT = 32_000;

/** Capability proxy: context size, with a reasoning bump for small thinkers. */
export function weightClass(model: Pick<FreeModel, "contextWindow" | "maxTokens" | "reasoning">): WeightClass {
  let base: WeightClass = model.contextWindow >= HEAVY_CONTEXT
    ? "heavy"
    : model.contextWindow >= MID_CONTEXT
      ? "mid"
      : "light";
  if (model.reasoning && base === "light") base = "mid";
  return base;
}

export interface FreeSwarmRole {
  key: "architect" | "builder" | "tester" | "critic" | "code-reviewer";
  /** Board label (Korean), matching the operator's own naming. */
  label: string;
  /** Weight classes in preference order for this role. */
  prefer: readonly WeightClass[];
}

/** The pipeline roles, in run order: 설계자 → 빌더 → 테스터 → 비평가 → 코드리뷰어. */
export const FREE_SWARM_ROLES: readonly FreeSwarmRole[] = [
  { key: "architect", label: "설계자", prefer: ["heavy", "mid", "light"] },
  { key: "builder", label: "빌더", prefer: ["mid", "heavy", "light"] },
  { key: "tester", label: "테스터", prefer: ["light", "mid", "heavy"] },
  { key: "critic", label: "비평가", prefer: ["heavy", "mid", "light"] },
  { key: "code-reviewer", label: "코드리뷰어", prefer: ["heavy", "mid", "light"] },
];

export interface RoleAssignment {
  role: FreeSwarmRole;
  model: FreeModel | undefined;
  tier: WeightClass | undefined;
  /** True when the model came from an operator override rather than auto-fit. */
  override: boolean;
}

const CLASS_RANK: Record<WeightClass, number> = { heavy: 3, mid: 2, light: 1 };

/** Best free model for a preference, from the not-yet-used pool first, then
 * from all models (reuse) — matching the highest available preferred class,
 * breaking ties by the larger context window. */
function pick(models: readonly FreeModel[], prefer: readonly WeightClass[]): FreeModel | undefined {
  for (const wanted of prefer) {
    const matches = models
      .filter((model) => weightClass(model) === wanted)
      .sort((a, b) => b.contextWindow - a.contextWindow);
    if (matches.length > 0) return matches[0];
  }
  // No class matched a preference (pool exhausted of those classes): fall back
  // to the strongest model available.
  return [...models].sort((a, b) => CLASS_RANK[weightClass(b)] - CLASS_RANK[weightClass(a)] || b.contextWindow - a.contextWindow)[0];
}

/**
 * A replacement for a role whose assigned model the route cannot call
 * (#85: OpenRouter rejects some listed free models with invalid_request).
 * Same preference order as the original assignment, excluding every model
 * this role already tried; undefined when the pool is exhausted — the role
 * then folds with an honest reason instead of a bogus one.
 */
export function reassignRole(
  models: readonly FreeModel[],
  role: FreeSwarmRole,
  excludeIds: ReadonlySet<string>,
  /** Models other roles already hold. A free model another role runs today
   * is a quota rival (#59 S5), so it is the LAST resort — mirroring
   * assignRoster's own distinct-model preference. */
  heldByOtherRoles: ReadonlySet<string> = new Set(),
): FreeModel | undefined {
  const remaining = models.filter((model) => !excludeIds.has(model.id));
  if (remaining.length === 0) return undefined;
  const free = remaining.filter((model) => !heldByOtherRoles.has(model.id));
  return pick(free.length > 0 ? free : remaining, role.prefer);
}

/**
 * Propose a model per role. Distinct models are preferred (each role drawing
 * from the unused pool first); when the free pool is smaller than the role set
 * the pool is reused rather than leaving roles empty. `overrides` maps a role
 * key to a model id and forces that assignment.
 */
export function assignRoster(
  models: readonly FreeModel[],
  roles: readonly FreeSwarmRole[] = FREE_SWARM_ROLES,
  overrides: Readonly<Record<string, string>> = {},
): RoleAssignment[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const used = new Set<string>();
  const out: RoleAssignment[] = [];
  for (const role of roles) {
    const overrideId = overrides[role.key];
    if (overrideId && byId.has(overrideId)) {
      const model = byId.get(overrideId)!;
      used.add(model.id);
      out.push({ role, model, tier: weightClass(model), override: true });
      continue;
    }
    const unused = models.filter((model) => !used.has(model.id));
    const model = pick(unused.length > 0 ? unused : models, role.prefer);
    if (model) used.add(model.id);
    out.push({ role, model, tier: model ? weightClass(model) : undefined, override: false });
  }
  return out;
}
