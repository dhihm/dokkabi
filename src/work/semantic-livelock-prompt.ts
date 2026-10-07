import type { SemanticLivelockDetection } from "./semantic-livelock-types.ts";

export function renderSemanticLivelockDirective(detection: SemanticLivelockDetection): string {
  return [
    `SEMANTIC LIVELOCK DETECTED for ${detection.todo}/${detection.caseId} after ${detection.attempts} equivalent attempts.`,
    "Do not make another minor edit in the same footprint.",
    "Change strategy first: query MAEK or the project wiki for prior evidence, challenge the current assumption, split or rewrite the plan, or mark the todo blocked with the missing fact.",
  ].join("\n");
}
