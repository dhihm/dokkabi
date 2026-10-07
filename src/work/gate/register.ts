import type { EventLog } from "../../host/event-log.ts";
import type { PluginDisposer } from "../../loader/types.ts";
import { verifyChangedWorkspace } from "./changed-workspace.ts";
import { verifyPatchApplies } from "./patch-applies.ts";
import type { GateRegistry } from "./registry.ts";

/**
 * The v1 gate set: one integrity check and one that the model can actually
 * fail. Registered together so the plugin and a test judge a step the same
 * way. Order is the recorded order (registry.list()).
 */
export function registerStepGates(log: EventLog, gates: GateRegistry): PluginDisposer[] {
  return [
    gates.register("patch_applies", "work-artifacts", (input) => verifyPatchApplies(log, input)),
    gates.register("step_changed_workspace", "work-artifacts", (input) =>
      verifyChangedWorkspace(log, input)),
  ];
}
