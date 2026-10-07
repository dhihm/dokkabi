import type { EventLog } from "../host/event-log.ts";
import type { FreeModel } from "../host/openrouter-free-models.ts";
import { FREE_SWARM_ROLES, reassignRole, type RoleAssignment } from "./free-roster.ts";
import {
  buildPipelinePlan,
  stageOrder,
  type FreeswarmRoleKey,
  type PipelineStagePlan,
} from "./freeswarm-pipeline.ts";

/**
 * 두레 (freeswarm) execution core.
 *
 * Runs the role pipeline in order, threading each stage's artifact into the
 * next, and emits freeswarm/* events. The actual child spawn lives behind an
 * injectable stage runner, so the orchestration — sequencing, artifact
 * threading, blocked/error stops, events — is fully testable; production wires
 * a runner that spawns a `cli.ts work` child on the OpenRouter route with the
 * stage's assigned free model (DOKKABI_MODEL) and the stage order text.
 */

export interface FreeswarmStageRunner {
  (input: { plan: PipelineStagePlan; order: string; attempt?: number; signal?: AbortSignal }): Promise<{
    artifact: string;
    /** True when the stage failed; the pipeline stops and the rest are skipped. */
    error?: boolean;
    /** Goal GREEN but accept/spec failed — later stages still run with the artifact. */
    acceptFailed?: boolean;
    /** The route rejected the ASSIGNED model itself (invalid_request) — the
     * stage never really ran; the orchestrator may reassign (#85). */
    unroutableModel?: boolean;
  }>;
}

export interface FreeswarmRunInput {
  task: string;
  roster: readonly RoleAssignment[];
  runStage: FreeswarmStageRunner;
  /** The free-model pool the roster was drawn from. Present, it enables
   * same-class reassignment when a role's model is unroutable (#85);
   * absent, an unroutable stage folds as today. */
  models?: readonly FreeModel[];
  log?: EventLog;
  signal?: AbortSignal;
  /** Operator surface. A reassignment that only reaches the event log is
   * invisible to the person watching the run (PR #97 review M4). */
  say?: (line: string) => void;
}

/** 1 original try + at most this many reassignments per role. */
export const MAX_STAGE_REASSIGNMENTS = 2;

export type FreeswarmStageStatus = "done" | "blocked" | "error" | "skipped" | "accept_failed";

export interface FreeswarmStageOutcome {
  role: FreeswarmRoleKey;
  model?: string;
  status: FreeswarmStageStatus;
  artifact?: string;
}

export interface FreeswarmRunResult {
  task: string;
  status: "completed" | "blocked" | "failed";
  stages: FreeswarmStageOutcome[];
}

export async function runFreeswarm(input: FreeswarmRunInput): Promise<FreeswarmRunResult> {
  const plan = buildPipelinePlan(input.roster, input.task);
  const log = input.log;
  const emit = (name: string, payload: Record<string, unknown>): void => {
    log?.append({ kind: "observe", name, payload });
  };

  emit("freeswarm/start", {
    task_bytes: byteLength(input.task),
    roster: plan.map((stage) => ({ role: stage.role, model: stage.model?.id ?? null, blocked: stage.blocked })),
  });

  const artifacts: Partial<Record<FreeswarmRoleKey, string>> = {};
  const outcomes: FreeswarmStageOutcome[] = [];
  let terminal: "completed" | "blocked" | "failed" = "completed";
  let stopped = false;

  for (const stage of plan) {
    if (stopped) {
      outcomes.push({ role: stage.role, model: stage.model?.id, status: "skipped" });
      continue;
    }
    if (stage.blocked) {
      emit("freeswarm/stage", { role: stage.role, model: null, status: "blocked" });
      outcomes.push({ role: stage.role, status: "blocked" });
      terminal = "blocked";
      stopped = true;
      continue;
    }
    if (input.signal?.aborted) {
      outcomes.push({ role: stage.role, model: stage.model?.id, status: "skipped" });
      terminal = "failed";
      stopped = true;
      continue;
    }
    const order = stageOrder(stage.stage, input.task, artifacts);
    // An unroutable ASSIGNED model (invalid_request) is not a work failure:
    // the stage never really ran. With a pool in hand, reassign the role to
    // another free model of its own preference class — bounded, on the log —
    // before folding it (#85). Any other error folds exactly as before.
    let active = stage;
    const tried: string[] = [];
    // Models other roles hold are quota rivals, so a replacement prefers a
    // model nobody else is running (#59 S5, PR #97 review M1).
    const heldByOtherRoles = new Set(
      input.roster
        .filter((entry) => entry.role.key !== stage.role && entry.model !== undefined)
        .map((entry) => entry.model!.id),
    );
    let result: { artifact: string; error?: boolean; acceptFailed?: boolean; unroutableModel?: boolean };
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > 1 && input.signal?.aborted) {
        result = { artifact: `${stage.role} reassignment aborted`, error: true };
        break;
      }
      emit("freeswarm/stage", {
        role: active.role,
        model: active.model?.id ?? null,
        ...(attempt > 1 ? { attempt } : {}),
      });
      try {
        result = await input.runStage({
          plan: active,
          order,
          attempt,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        result = { artifact: error instanceof Error ? error.message : String(error), error: true };
      }
      emit("freeswarm/stage_result", {
        role: active.role,
        model: active.model?.id ?? null,
        ...(attempt > 1 ? { attempt } : {}),
        artifact_bytes: byteLength(result.artifact),
        error: result.error === true,
        ...(result.acceptFailed ? { accept_failed: true } : {}),
        ...(result.unroutableModel ? { unroutable_model: true } : {}),
      });
      if (active.model) tried.push(active.model.id);
      if (!result.error || result.unroutableModel !== true) break;
      if (!input.models) break;
      // The roster verdict never REPLACES the child's reason: overwriting it
      // would assert a routing rejection over a real failure's text
      // (PR #97 review H2). It is appended.
      if (attempt > MAX_STAGE_REASSIGNMENTS) {
        result = {
          ...result,
          artifact: `no callable free model for ${stage.role} within the reassignment budget (tried ${tried.join(", ")}); last failure: ${result.artifact}`,
        };
        break;
      }
      const roleSpec = FREE_SWARM_ROLES.find((entry) => entry.key === stage.role);
      const replacement = roleSpec
        ? reassignRole(input.models, roleSpec, new Set(tried), heldByOtherRoles)
        : undefined;
      if (!replacement) {
        result = {
          ...result,
          artifact: `no callable free model for ${stage.role} (tried ${tried.join(", ")}); last failure: ${result.artifact}`,
          error: true,
        };
        break;
      }
      emit("freeswarm/reassign", {
        role: stage.role,
        from: active.model?.id ?? null,
        to: replacement.id,
        reason: "invalid_request",
        attempt: attempt + 1,
      });
      input.say?.(
        `  ↻ ${stage.role} — ${active.model?.id ?? "-"} 호출 불가(invalid_request) → ${replacement.id} 로 재배정 (${attempt + 1}/${MAX_STAGE_REASSIGNMENTS + 1})`,
      );
      active = { ...active, model: replacement };
    }
    if (result.error) {
      outcomes.push({ role: stage.role, model: active.model?.id, status: "error", artifact: result.artifact });
      terminal = "failed";
      stopped = true;
      continue;
    }
    artifacts[stage.role] = result.artifact;
    if (result.acceptFailed) {
      outcomes.push({
        role: stage.role,
        model: active.model?.id,
        status: "accept_failed",
        artifact: result.artifact,
      });
      continue;
    }
    outcomes.push({ role: stage.role, model: active.model?.id, status: "done", artifact: result.artifact });
  }

  emit("freeswarm/finish", { status: terminal, stages: outcomes.map((o) => ({ role: o.role, status: o.status })) });
  return { task: input.task, status: terminal, stages: outcomes };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
