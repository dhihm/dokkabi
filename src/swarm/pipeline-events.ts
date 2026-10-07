import { createHash } from "node:crypto";
import type { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import type { SwarmCandidateRole } from "./routes.ts";
import { assertSwarmWorldSpec, type SwarmWorldSpec } from "./world.ts";

export function appendSwarmArtifact(log: EventLog, input: {
  readonly childSession: string;
  readonly role: SwarmCandidateRole;
  readonly patchDigest: string;
  readonly summaryDigest: string;
  readonly dispatchDigest: string;
  readonly resultEnvelopeDigest: string;
  readonly planDigest: string;
}): EventRecord {
  return log.append({
    kind: "observe",
    name: "swarm/artifact",
    payload: {
      child_session: input.childSession,
      role: input.role,
      patch_digest: input.patchDigest,
      summary_digest: input.summaryDigest,
      dispatch_digest: input.dispatchDigest,
      result_envelope_digest: input.resultEnvelopeDigest,
      plan_digest: input.planDigest,
    },
  });
}

export function appendReviewInputEffect(log: EventLog, input: {
  readonly reviewerSession: string;
  readonly candidateDigests: readonly string[];
  readonly resultEnvelopeDigests: readonly string[];
  readonly manifestDigest: string;
}): EventRecord {
  return log.append({
    kind: "effect",
    name: "swarm/review_input",
    payload: {
      reviewer_session: input.reviewerSession,
      candidate_digests: [...input.candidateDigests],
      result_envelope_digests: [...input.resultEnvelopeDigests],
      manifest_digest: input.manifestDigest,
    },
  });
}

export function appendReviewSeed(log: EventLog, input: {
  readonly state: "effect" | "observed";
  readonly reviewerSession: string;
  readonly candidateSession: string;
  readonly patchDigest: string;
  readonly resultEnvelopeDigest: string;
}): EventRecord {
  return log.append({
    kind: input.state === "effect" ? "effect" : "observe",
    name: input.state === "effect" ? "swarm/review_seed" : "swarm/review_seeded",
    payload: {
      reviewer_session: input.reviewerSession,
      candidate_session: input.candidateSession,
      patch_digest: input.patchDigest,
      result_envelope_digest: input.resultEnvelopeDigest,
    },
  });
}

export function appendReviewPlan(log: EventLog, input: {
  readonly state: "effect" | "observed";
  readonly reviewerSession: string;
  readonly candidateSession: string;
}): EventRecord {
  return log.append({
    kind: input.state === "effect" ? "effect" : "observe",
    name: input.state === "effect" ? "swarm/review_plan" : "swarm/review_plan_ready",
    payload: {
      reviewer_session: input.reviewerSession,
      candidate_session: input.candidateSession,
      require_red_first: false,
    },
  });
}

export function appendWorldEffect(log: EventLog, input: {
  readonly action: "open" | "close";
  readonly childSession: string;
  readonly world: SwarmWorldSpec;
  readonly worldId: string;
  readonly imageIdentityDigest?: string;
  readonly gitMetadata?: "common-read-only";
}): EventRecord {
  assertSwarmWorldSpec(input.world);
  const worldIdDigest = createHash("sha256").update(input.worldId).digest("hex");
  return log.append({
    kind: "effect",
    name: `swarm/world_${input.action}`,
    payload: {
      child_session: input.childSession,
      world: input.world.kind,
      network: input.world.network,
      world_id_digest: worldIdDigest,
      ...(input.world.kind === "docker"
        ? {
            image_digest: input.imageIdentityDigest
              ?? createHash("sha256").update(input.world.image).digest("hex"),
          }
        : {}),
      ...(input.gitMetadata ? { git_metadata: input.gitMetadata } : {}),
    },
  });
}

export function appendWorldObserved(log: EventLog, input: {
  readonly state: "ready" | "closed";
  readonly childSession: string;
  readonly worldId: string;
}): EventRecord {
  const worldIdDigest = createHash("sha256").update(input.worldId).digest("hex");
  return log.append({
    kind: "observe",
    name: `swarm/world_${input.state}`,
    payload: { child_session: input.childSession, world_id_digest: worldIdDigest },
  });
}

export type SwarmWorldFailurePhase = "open" | "close";
export type SwarmWorldFailureReason = "provider_error" | "invalid_lease";
export type SwarmWorldAllocationState = "unallocated" | "allocated";

export interface SwarmWorldFailureObservation {
  readonly phase: SwarmWorldFailurePhase;
  readonly reason: SwarmWorldFailureReason;
  readonly allocation: SwarmWorldAllocationState;
}

function assertWorldFailureObservation(input: SwarmWorldFailureObservation): void {
  if (input.phase === "close" && (
    input.reason !== "provider_error" || input.allocation !== "allocated"
  )) {
    throw new Error("a close failure requires an allocated world and provider_error");
  }
}

/**
 * Record a safe, typed terminal observation without retaining provider error
 * text or runtime coordinates. `allocation` tells replay whether a matching
 * close effect is required after an open failure.
 */
export function appendWorldFailed(log: EventLog, input: {
  readonly childSession: string;
  readonly worldId: string;
} & SwarmWorldFailureObservation): EventRecord {
  assertWorldFailureObservation(input);
  const worldIdDigest = createHash("sha256").update(input.worldId).digest("hex");
  return log.append({
    kind: "observe",
    name: "swarm/world_failed",
    payload: {
      child_session: input.childSession,
      world_id_digest: worldIdDigest,
      phase: input.phase,
      reason: input.reason,
      allocation: input.allocation,
    },
  });
}

export function appendFinalizeEffect(log: EventLog, input: {
  readonly reviewerSession: string;
  readonly sourceDigest: string;
  readonly patchDigest: string;
}): EventRecord {
  return log.append({
    kind: "effect",
    name: "swarm/finalize",
    payload: {
      reviewer_session: input.reviewerSession,
      source_digest: input.sourceDigest,
      patch_digest: input.patchDigest,
    },
  });
}

export function appendFinalized(log: EventLog, input: {
  readonly reviewerSession: string;
  readonly patchDigest: string;
  readonly finalTree: string;
}): EventRecord {
  return log.append({
    kind: "observe",
    name: "swarm/finalized",
    payload: {
      reviewer_session: input.reviewerSession,
      patch_digest: input.patchDigest,
      final_tree: input.finalTree,
    },
  });
}
