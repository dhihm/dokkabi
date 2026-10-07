import type { FreeModel } from "../host/openrouter-free-models.ts";
import { FREE_SWARM_ROLES, weightClass } from "./free-roster.ts";
import type { PipelineStagePlan } from "./freeswarm-pipeline.ts";

/**
 * Human-facing rendering for the 두레 (freeswarm) preview: the free models the
 * operator can draw on, and the proposed role roster. Pure string builders so
 * the command surface (and its tests) stay thin.
 */

const LABEL_BY_ROLE = new Map(FREE_SWARM_ROLES.map((role) => [role.key, role.label]));

function fmtCtx(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** One line per free model, tier and context annotated, newest tier first. */
export function freeModelLines(models: readonly FreeModel[]): string[] {
  if (models.length === 0) {
    return ["무료 모델 없음 (free models: 0)"];
  }
  const rank = { heavy: 3, mid: 2, light: 1 } as const;
  const sorted = [...models].sort(
    (a, b) => rank[weightClass(b)] - rank[weightClass(a)] || b.contextWindow - a.contextWindow,
  );
  const out = [`무료 모델 ${models.length}개 (free models: ${models.length})`];
  for (const model of sorted) {
    const tier = weightClass(model);
    out.push(`  ${tier.padEnd(5)} ctx=${fmtCtx(model.contextWindow).padStart(5)}${model.reasoning ? " reasoning" : ""}  ${model.id}`);
  }
  return out;
}

/** One line per pipeline role: label → assigned model (tier), blocked marked. */
export function rosterLines(plan: readonly PipelineStagePlan[]): string[] {
  const out = ["두레 역할 배정 (freeswarm roster)"];
  for (const stage of plan) {
    const label = LABEL_BY_ROLE.get(stage.role) ?? stage.role;
    if (stage.blocked || !stage.model) {
      out.push(`  ${label.padEnd(6)} → (미배정 / blocked — 무료 모델 없음)`);
      continue;
    }
    out.push(`  ${label.padEnd(6)} → ${stage.model.id}  (${weightClass(stage.model)})`);
  }
  return out;
}
