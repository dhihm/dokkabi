import { BlobStore } from "../../host/blob-store.ts";
import type { EventLog } from "../../host/event-log.ts";
import { assertPatchDiffV1 } from "../artifacts/step.ts";
import type { GateInput, GateResult } from "./registry.ts";

/**
 * The step did something (#77 v1).
 *
 * `patch_applies` is an INTEGRITY gate: it proves the recorded artifact is the
 * whole and exact patch standing in the workspace. Every way it can fail is a
 * host bug or a race — nothing the model does reaches it. A registry whose
 * only member cannot fail on model behaviour is not deciding anything.
 *
 * This is the cheap verdict that can: an implement step runs only while its
 * case is RED, so a step that produced no change did not do its job. It reads
 * the recorded artifact, never a transcript and never the model's own report.
 */
export function verifyChangedWorkspace(log: EventLog, input: GateInput): GateResult {
  let body: unknown;
  try {
    body = JSON.parse(BlobStore.forSession(log.path).get(input.artifact.blob));
  } catch {
    return { status: "fail", reasonCode: "artifact_unreadable" };
  }
  try {
    assertPatchDiffV1(body);
  } catch (error) {
    return {
      status: "fail",
      reasonCode: "artifact_invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return body.files.length > 0
    ? { status: "pass", reasonCode: "workspace_changed" }
    : { status: "fail", reasonCode: "step_changed_nothing" };
}
