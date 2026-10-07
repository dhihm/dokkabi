import type {
  ArtifactContributionRegistry,
  HostContext,
  PluginModule,
} from "../loader/types.ts";
import { registerStepArtifactKinds } from "../work/artifacts/kinds.ts";
import { registerStepGates } from "../work/gate/register.ts";
import type { GateRegistry } from "../work/gate/registry.ts";
import { runIsolatedImplementStep, type IsolatedStepRunner } from "../work/step-run.ts";
import { ISOLATED_STEP_ENV, isolatedStepRequested } from "../work/step-opt-in.ts";

/**
 * The Artifact-State Mesh v1 contributions (#77).
 *
 * This plugin is the whole opt-in. `artifact_contributions` and `verify` are
 * registries that ALWAYS exist — `plugin-runtime` and `gate-runtime` register
 * them unconditionally — so their presence says nothing about whether this
 * host runs isolated steps. The loop therefore asks for `work_step`, a
 * capability that exists only when this plugin activated and found a gate
 * seam to judge with. The first review of this code caught the earlier
 * shape: the loop checked the two registries, so a plain `dokkabi work`
 * entered the isolated path with zero registered kinds and died on the first
 * implement turn.
 *
 * The loop never names an artifact SHAPE — it asks for a runner and gets a
 * verdict (constitution 7).
 */
export const plugin: PluginModule = {
  id: "work-artifacts",
  claims: [
    { key: "artifact_contributions", role: "consumer" },
    { key: "verify", role: "consumer", optional: true },
    { key: "work_step", role: "definition" },
    { key: "work_step", role: "provider" },
  ],
  activate(ctx: HostContext) {
    // A replay must reload whatever the recorded run loaded, regardless of
    // what this machine's operator asked for today (constitution 5).
    if (ctx.log.isReadOnly) {
      return ctx.log.events.some(
        (event) => event.name === "plugin/load" && event.payload.id === "work-artifacts",
      )
        ? { active: true as const }
        : { active: false as const, reason: "not loaded in the recorded run", kind: "not_configured" as const };
    }
    return isolatedStepRequested()
      ? { active: true as const }
      : { active: false as const, reason: `${ISOLATED_STEP_ENV} is not set`, kind: "not_configured" as const };
  },
  register(ctx: HostContext) {
    const artifacts = ctx.get<ArtifactContributionRegistry>("artifact_contributions");
    for (const dispose of registerStepArtifactKinds(artifacts)) ctx.effect(() => dispose);

    const gates = ctx.tryGet<GateRegistry>("verify");
    // No gate seam means nothing can judge a step, and an unjudged step is
    // exactly what this design refuses to run. The kinds still register: an
    // artifact that cannot be graded is still a recordable artifact.
    if (!gates) return;
    for (const dispose of registerStepGates(ctx.log, gates)) ctx.effect(() => dispose);

    ctx.define("work_step", { ordering: "manifest", visibility: "host_only", format: 1 });
    const runner: IsolatedStepRunner = {
      run: (request) => runIsolatedImplementStep({ ...request, log: ctx.log, artifacts, gates }),
    };
    ctx.provide("work_step", runner);
  },
};
