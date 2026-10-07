import type { EventLog } from "../host/event-log.ts";
import { readFixtureEnrollment } from "./evidence/fixture-manifest.ts";
import type { PlanningPromptContext } from "./graph.ts";

/** Execution repertoire is retained authority, never a model proposal or cwd file. */
export function planningPromptContext(log: EventLog, workspaceRoot: string, priorRefusals?: readonly string[]): PlanningPromptContext {
  const enrollment = readFixtureEnrollment(log, workspaceRoot);
  return {
    ...(enrollment ? { enrolledCommands: [...enrollment.manifest.commands], enrollmentDigest: enrollment.digest } : {}),
    ...(priorRefusals?.length ? { priorRefusals: [...priorRefusals] } : {}),
  };
}
