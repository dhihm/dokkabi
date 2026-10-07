import type { ArtifactContributionRegistry, PluginDisposer } from "../../loader/types.ts";
import {
  assertPatchDiffV1,
  assertStepInputV1,
  patchDiffDigest,
  stepInputDigest,
  type PatchDiffV1,
  type StepInputV1,
} from "./step.ts";

/** The v1 mesh artifact kinds, in one place so the plugin and a test register
 * the same pair. A kind is a validate+digest contribution; the loop never
 * learns what a particular kind means (constitution 7). */
export function registerStepArtifactKinds(
  artifacts: ArtifactContributionRegistry,
): PluginDisposer[] {
  return [
    artifacts.register<StepInputV1>("step_input_v1", {
      validate(value) {
        assertStepInputV1(value);
        return value;
      },
      digest: stepInputDigest,
    }),
    artifacts.register<PatchDiffV1>("patch_diff_v1", {
      validate(value) {
        assertPatchDiffV1(value);
        return value;
      },
      digest: patchDiffDigest,
    }),
  ];
}
