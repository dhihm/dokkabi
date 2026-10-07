/**
 * The operator's choice of implement path (#77 v1).
 *
 * The isolated step replaces the accumulated transcript with an artifact
 * slot. That is a large change to how a run behaves, so it is opt-in: the
 * mesh plugins ship in the default manifest but skip with a recorded reason
 * unless the operator asked for them, and `dokkabi work` keeps the transcript
 * path otherwise. Nothing in the loop branches on this — the loop only ever
 * asks whether the seams are present (constitution 7).
 */

export const ISOLATED_STEP_ENV = "DOKKABI_ISOLATED_STEP";

export function isolatedStepRequested(): boolean {
  const value = process.env[ISOLATED_STEP_ENV];
  return value === "1" || value === "true";
}
