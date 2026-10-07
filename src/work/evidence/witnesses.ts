import { z } from "zod";

/** These labels describe the reference protocol and native boundary, not a domain oracle. */
export const requiredAxesSchema = z.strictObject({
  workload: z.strictObject({ level: z.literal("full"), rule: z.literal("checked_elements") }).optional(),
  input: z.strictObject({ level: z.literal("host_generated"), rule: z.literal("challenge_bytes") }).optional(),
  process: z.strictObject({ level: z.literal("isolated"), rule: z.literal("sandbox_process") }).optional(),
  filesystem: z.strictObject({ level: z.literal("isolated"), rule: z.literal("sandbox_filesystem") }).optional(),
  control: z.strictObject({ level: z.literal("isolated"), rule: z.literal("sandbox_control") }).optional(),
});
export type RequiredAxesV1 = z.infer<typeof requiredAxesSchema>;
export const witnessObservationSchema = z.strictObject({
  provider: z.enum(["seatbelt", "bwrap"]),
  policy_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  sandbox_policy_digest: z.string().regex(/^[a-f0-9]{16}$/u),
  process: z.boolean(), filesystem: z.boolean(), control: z.boolean(),
});
export type WitnessObservationsV1 = z.infer<typeof witnessObservationSchema>;
export const witnessDecisionSchema = z.strictObject({
  axis: z.enum(["workload", "input", "process", "filesystem", "control"]),
  level: z.enum(["full", "host_generated", "isolated"]),
  rule: z.enum(["checked_elements", "challenge_bytes", "sandbox_process", "sandbox_filesystem", "sandbox_control"]),
  passed: z.boolean(),
});
export type WitnessDecisionV1 = z.infer<typeof witnessDecisionSchema>;

/** A printed label never supplies an observation or fills a missing axis. */
export function checkSubstrateCoverage(declared: Readonly<Record<string, string>>, required: RequiredAxesV1): string[] {
  const axes = requiredAxesSchema.parse(required), reasons: string[] = [];
  for (const [axis, level] of Object.entries(declared)) {
    const claim = axes[axis as keyof RequiredAxesV1];
    if (!claim || claim.level !== level) reasons.push(`uncovered_substrate_${axis}`);
  }
  return reasons;
}

export function evaluateWitnesses(required: RequiredAxesV1, facts: {
  requestedElements: number; correctElements: number; challengeBound: boolean; isolation: WitnessObservationsV1;
}): WitnessDecisionV1[] {
  const axes = requiredAxesSchema.parse(required), isolation = witnessObservationSchema.parse(facts.isolation);
  return Object.entries(axes).map(([axis, claim]) => {
    let passed: boolean;
    switch (claim.rule) {
      case "checked_elements": passed = facts.correctElements === facts.requestedElements; break;
      case "challenge_bytes": passed = facts.challengeBound; break;
      case "sandbox_process": passed = isolation.process; break;
      case "sandbox_filesystem": passed = isolation.filesystem; break;
      case "sandbox_control": passed = isolation.control; break;
    }
    return witnessDecisionSchema.parse({ axis, ...claim, passed });
  });
}
