import type { RoleAssignment } from "./free-roster.ts";
import type { FreeModel } from "../host/openrouter-free-models.ts";

/**
 * 두레 (freeswarm) — the role pipeline's orchestration core.
 *
 * The roster (free model per role) becomes an ordered run: architect designs,
 * builder implements the design, tester exercises the build, critic weighs the
 * whole, code-reviewer gives the final verdict. Each stage consumes only the
 * artifacts of earlier stages (forward-only), so the plan is a straight
 * pipeline, not a fan-out. This module is pure — it binds a roster + task into
 * an executable plan and renders each stage's order text; the live child spawn
 * wires this to the swarm runner in the final phase.
 */

export type FreeswarmRoleKey =
  | "architect"
  | "builder"
  | "tester"
  | "critic"
  | "code-reviewer";

export interface FreeswarmStage {
  role: FreeswarmRoleKey;
  /** Earlier roles whose artifacts this stage reads. Forward-only. */
  inputFrom: readonly FreeswarmRoleKey[];
}

/** The pipeline, in run order. Each stage sees every stage before it that it
 * names — the reviewer sees all four predecessors. */
export const FREESWARM_PIPELINE: readonly FreeswarmStage[] = [
  { role: "architect", inputFrom: [] },
  { role: "builder", inputFrom: ["architect"] },
  { role: "tester", inputFrom: ["architect", "builder"] },
  { role: "critic", inputFrom: ["architect", "builder", "tester"] },
  { role: "code-reviewer", inputFrom: ["architect", "builder", "tester", "critic"] },
];

const PERSONAS: Record<FreeswarmRoleKey, string> = {
  architect:
    "너는 두레의 설계자(architect)다. 주어진 과제를 받아 접근 방식, 모듈 구조, 인터페이스, 위험 요소를 담은 설계를 내라. 코드를 구현하지 말고 빌더가 따라갈 수 있는 명확한 설계만 낸다.",
  builder:
    "너는 두레의 빌더(builder)다. 설계자의 설계를 받아 최소하고 정확하게 구현한다. 설계에서 벗어난 부분은 이유를 남긴다.",
  tester:
    "너는 두레의 테스터(tester)다. 빌더의 구현을 대상으로 테스트를 작성·실행하고, 통과/실패와 재현 가능한 근거를 보고한다. RED-first 규율을 지킨다.",
  critic:
    "너는 두레의 비평가(critic)다. 설계·구현·테스트 전체를 놓고 정확성 결함, 빠진 경우, 위험을 회의적으로 지적한다. 칭찬이 아니라 반증을 낸다.",
  "code-reviewer":
    "너는 두레의 코드리뷰어(code-reviewer)다. 앞 단계 산출물 전부를 놓고 최종 리뷰와 판정(merge 가능/불가와 그 이유)을 낸다.",
};

/** The role's job instruction. Distinct per role. */
export function personaPrompt(role: FreeswarmRoleKey): string {
  return PERSONAS[role];
}

/** Whether a stage runs the full implement work loop or a bounded design/review turn. */
export type FreeswarmStageMode = "design" | "implement" | "review";

export function stageMode(role: FreeswarmRoleKey): FreeswarmStageMode {
  switch (role) {
    case "architect":
      return "design";
    case "builder":
    case "tester":
      return "implement";
    case "critic":
    case "code-reviewer":
      return "review";
  }
}

export interface FreeswarmStageSpawnOptions {
  /** null skips --decision work for design/review-only stages. */
  decision: "work" | null;
  deferAcceptance?: boolean;
}

/** Only the BUILDER inherits the architect's sealed plan (PR #96 review
 * H2): the tester writes its OWN tests and must decompose its own graph, so
 * the plan-handoff authority is per-role, never ambient in the workspace. */
export function stagePlanHandoff(role: FreeswarmRoleKey): boolean {
  return role === "builder";
}

/** Spawn flags must agree with the role persona — design/review stages are not implement turns. */
export function stageSpawnOptions(role: FreeswarmRoleKey): FreeswarmStageSpawnOptions {
  if (stageMode(role) === "implement") {
    return { decision: "work" };
  }
  return { decision: null, deferAcceptance: true };
}

function stageOrderCeilingSuffix(role: FreeswarmRoleKey): string | undefined {
  switch (role) {
    case "architect":
      return "Write a work plan only. Do not implement product code.";
    case "critic":
    case "code-reviewer":
      return "Explain your review and critique. Do not edit files or implement product code.";
    default:
      return undefined;
  }
}

export interface PipelineStagePlan {
  role: FreeswarmRoleKey;
  stage: FreeswarmStage;
  model: FreeModel | undefined;
  persona: string;
  /** True when the role has no assigned free model — the stage cannot run. */
  blocked: boolean;
}

/**
 * Bind a roster (free model per role) and a task into the ordered plan. A role
 * with no assigned model is a blocked stage — surfaced, never silently
 * dropped, so the operator sees the gap.
 */
export function buildPipelinePlan(
  roster: readonly RoleAssignment[],
  _task: string,
): PipelineStagePlan[] {
  const modelByRole = new Map<string, FreeModel | undefined>(
    roster.map((assignment) => [assignment.role.key, assignment.model]),
  );
  return FREESWARM_PIPELINE.map((stage) => {
    const model = modelByRole.get(stage.role);
    return {
      role: stage.role,
      stage,
      model,
      persona: personaPrompt(stage.role),
      blocked: model === undefined,
    };
  });
}

/**
 * The order text handed to a stage's child: its persona, the operator task,
 * and exactly the prior artifacts its inputFrom names (in pipeline order).
 * A missing prior artifact is skipped, so a partial run still renders.
 */
export function stageOrder(
  stage: FreeswarmStage,
  task: string,
  priorArtifacts: Readonly<Partial<Record<FreeswarmRoleKey, string>>>,
): string {
  const parts: string[] = [personaPrompt(stage.role), "", `## 과제\n${task}`];
  const consumed = stage.inputFrom
    .map((role) => ({ role, artifact: priorArtifacts[role] }))
    .filter((entry): entry is { role: FreeswarmRoleKey; artifact: string } => typeof entry.artifact === "string");
  if (consumed.length > 0) {
    parts.push("", "## 앞 단계 산출물");
    for (const { role, artifact } of consumed) {
      parts.push(`### ${role}\n${artifact}`);
    }
  }
  const ceiling = stageOrderCeilingSuffix(stage.role);
  if (ceiling) {
    parts.push("", "## 제약", ceiling);
  }
  return parts.join("\n");
}
