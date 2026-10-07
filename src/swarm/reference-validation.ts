import type { EventRecord } from "../host/schema.ts";
import {
  assertSwarmCapabilityProfile,
  assertSwarmDispatchContract,
  dispatchContractDigest,
  swarmCapabilityProfileDigest,
  type SwarmDispatchContract,
} from "./contract.ts";
import {
  assertSwarmResultEnvelope,
  resultEnvelopeDigest,
  type SwarmResultEnvelopeV1,
} from "./result-envelope.ts";
import {
  buildReviewManifestV1,
  type ReviewCandidateReferenceV1,
} from "./review-manifest.ts";
import { projectSwarmMemoryViewReferences } from "./memory-transport.ts";

export interface SwarmDispatchReference {
  child_session: string;
  contract_digest: string;
  memory_view_digest?: string;
  repository_digest?: string;
}

export interface SwarmResultReference {
  child_session: string;
  dispatch_digest: string;
  envelope_digest: string;
  status: string;
}

export interface SwarmParentBindingReference {
  parent_session: string;
  parent_open_seq: number;
  child_session: string;
  contract_digest: string;
}

export interface SwarmReviewInputReference {
  reviewer_session: string;
  manifest_digest: string;
  result_envelope_digests: string[];
}

export interface SwarmReferenceProjection {
  readonly dispatches: SwarmDispatchReference[];
  readonly results: SwarmResultReference[];
  readonly parentBindings: SwarmParentBindingReference[];
  readonly reviewInputs: SwarmReviewInputReference[];
  readonly dispatchByChild: ReadonlyMap<string, { contract: SwarmDispatchContract; digest: string }>;
  readonly resultByChild: ReadonlyMap<string, { envelope: SwarmResultEnvelopeV1; digest: string }>;
}

interface OpenReference {
  readonly seq: number;
  readonly parent: string;
  readonly role: string;
  readonly route: string;
}

const HEX = /^[a-f0-9]{64}$/;

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

export function projectSwarmReferences(events: readonly EventRecord[]): SwarmReferenceProjection {
  projectSwarmMemoryViewReferences(events);
  const opens = new Map<string, OpenReference>();
  const dispatchByChild = new Map<string, { contract: SwarmDispatchContract; digest: string }>();
  const resultByChild = new Map<string, { envelope: SwarmResultEnvelopeV1; digest: string }>();
  const dispatches: SwarmDispatchReference[] = [];
  const results: SwarmResultReference[] = [];
  const parentBindings: SwarmParentBindingReference[] = [];
  const reviewInputs: SwarmReviewInputReference[] = [];
  const reviewInputReviewers = new Set<string>();
  const artifactCandidates: ReviewCandidateReferenceV1[] = [];

  for (const event of events) {
    if (event.name === "swarm/child_open") {
      const child = text(event.payload.child_session, "swarm child session");
      if (!opens.has(child)) {
        opens.set(child, {
          seq: event.seq,
          parent: text(event.payload.parent_session, "swarm parent session"),
          role: text(event.payload.role, "swarm child role"),
          route: text(event.payload.route, "swarm child route"),
        });
      }
      continue;
    }
    if (event.name === "session/parent" && event.payload.contract_digest !== undefined) {
      const digest = text(event.payload.contract_digest, "session parent contract digest");
      if (!HEX.test(digest)) throw new Error("session parent contract digest is invalid");
      const parentOpenSeq = event.payload.parent_open_seq;
      if (!Number.isSafeInteger(parentOpenSeq) || Number(parentOpenSeq) < 1) {
        throw new Error("session parent open seq is invalid");
      }
      parentBindings.push({
        parent_session: text(event.payload.parent_session, "session parent id"),
        parent_open_seq: Number(parentOpenSeq),
        child_session: text(event.payload.child_session, "session child id"),
        contract_digest: digest,
      });
      continue;
    }
    if (event.name === "swarm/dispatch") {
      const child = text(event.payload.child_session, "dispatch child session");
      if (dispatchByChild.has(child)) throw new Error(`duplicate swarm dispatch for ${child}`);
      const opened = opens.get(child);
      if (!opened) throw new Error(`swarm dispatch has no preceding child_open for ${child}`);
      assertSwarmDispatchContract(event.payload.contract);
      assertSwarmCapabilityProfile(event.payload.capability_profile);
      const contract = event.payload.contract;
      const digest = dispatchContractDigest(contract);
      if (event.payload.contract_digest !== digest) throw new Error(`swarm dispatch digest mismatch for ${child}`);
      if (contract.parentSession !== opened.parent || contract.parentOpenSeq !== opened.seq ||
        contract.role !== opened.role || contract.route !== opened.route) {
        throw new Error(`swarm dispatch lineage mismatch for ${child}`);
      }
      if (contract.capabilityProfileDigest !== swarmCapabilityProfileDigest(event.payload.capability_profile)) {
        throw new Error(`swarm dispatch capability profile mismatch for ${child}`);
      }
      if (contract.format === 2) {
        const memory = [...events].reverse().find((candidate) =>
          candidate.seq < event.seq && candidate.name === "swarm/memory_view" &&
          candidate.payload.view_digest === contract.memoryViewDigest
        );
        if (!memory || memory.seq >= contract.parentOpenSeq) {
          throw new Error(`swarm dispatch memory view order mismatch for ${child}`);
        }
        if (memory.payload.repository_digest !== contract.repositoryDigest) {
          throw new Error(`swarm dispatch memory binding mismatch for ${child}`);
        }
      }
      dispatchByChild.set(child, { contract, digest });
      dispatches.push({
        child_session: child,
        contract_digest: digest,
        ...(contract.format === 2
          ? {
              memory_view_digest: contract.memoryViewDigest,
              repository_digest: contract.repositoryDigest,
            }
          : {}),
      });
      continue;
    }
    if (event.name === "swarm/result") {
      const child = text(event.payload.child_session, "result child session");
      if (resultByChild.has(child)) throw new Error(`duplicate swarm result for ${child}`);
      const dispatch = dispatchByChild.get(child);
      if (!dispatch) throw new Error(`swarm result has no dispatch for ${child}`);
      assertSwarmResultEnvelope(event.payload.envelope, {
        childSession: child,
        dispatchDigest: dispatch.digest,
      });
      const envelope = event.payload.envelope;
      const digest = resultEnvelopeDigest(envelope);
      if (event.payload.envelope_digest !== digest) throw new Error(`swarm result digest mismatch for ${child}`);
      resultByChild.set(child, { envelope, digest });
      results.push({
        child_session: child,
        dispatch_digest: envelope.dispatchDigest,
        envelope_digest: digest,
        status: envelope.status,
      });
      continue;
    }
    if (event.name === "swarm/child_close" && event.payload.result_envelope_digest !== undefined) {
      const child = text(event.payload.child_session, "closed child session");
      const result = resultByChild.get(child);
      const dispatch = dispatchByChild.get(child);
      if (!result || event.payload.result_envelope_digest !== result.digest ||
        !dispatch || event.payload.parent_session !== dispatch.contract.parentSession ||
        event.payload.parent_open_seq !== dispatch.contract.parentOpenSeq ||
        event.payload.role !== dispatch.contract.role || event.payload.route !== dispatch.contract.route ||
        event.payload.status !== result.envelope.status ||
        event.payload.replay_digest !== result.envelope.replayDigest ||
        event.payload.final_hash !== result.envelope.finalHash ||
        event.payload.evidence_digest !== result.envelope.evidenceDigest ||
        event.payload.graph_rev !== result.envelope.graphRev) {
        throw new Error(`swarm child_close result mismatch for ${child}`);
      }
      continue;
    }
    if (event.name === "swarm/artifact" && event.payload.result_envelope_digest !== undefined) {
      const child = text(event.payload.child_session, "artifact child session");
      const result = resultByChild.get(child);
      const dispatch = dispatchByChild.get(child);
      if (!result || !dispatch || result.envelope.status !== "completed" ||
        event.payload.role !== dispatch.contract.role || dispatch.contract.role === "reviewer" ||
        event.payload.result_envelope_digest !== result.digest ||
        event.payload.dispatch_digest !== result.envelope.dispatchDigest ||
        event.payload.patch_digest !== result.envelope.patchDigest ||
        event.payload.summary_digest !== result.envelope.summaryDigest ||
        event.payload.plan_digest !== result.envelope.planDigest) {
        throw new Error(`swarm artifact result mismatch for ${child}`);
      }
      artifactCandidates.push({
        role: dispatch.contract.role,
        route: dispatch.contract.route,
        session: child,
        patch: `${dispatch.contract.role}/patch.diff`,
        patch_digest: String(result.envelope.patchDigest),
        summary: `${dispatch.contract.role}/summary.md`,
        summary_digest: String(result.envelope.summaryDigest),
        dispatch_digest: result.envelope.dispatchDigest,
        result_envelope_digest: result.digest,
        plan_digest: String(result.envelope.planDigest),
        replay_digest: String(result.envelope.replayDigest),
        evidence_digest: String(result.envelope.evidenceDigest),
        graph_rev: Number(result.envelope.graphRev),
      });
      continue;
    }
    if ((event.name === "swarm/review_seed" || event.name === "swarm/review_seeded") &&
      event.payload.result_envelope_digest !== undefined) {
      const child = text(event.payload.candidate_session, "review seed candidate session");
      const result = resultByChild.get(child);
      if (!result || result.envelope.status !== "completed" ||
        event.payload.result_envelope_digest !== result.digest ||
        event.payload.patch_digest !== result.envelope.patchDigest) {
        throw new Error(`swarm review seed result mismatch for ${child}`);
      }
      continue;
    }
    if (event.name === "swarm/review_input" && event.payload.result_envelope_digests !== undefined) {
      const reviewerSession = text(event.payload.reviewer_session, "reviewer session");
      if (reviewInputReviewers.has(reviewerSession)) {
        throw new Error(`duplicate swarm review input for ${reviewerSession}`);
      }
      if (!Array.isArray(event.payload.result_envelope_digests) ||
        event.payload.result_envelope_digests.some((digest) => typeof digest !== "string" || !HEX.test(digest))) {
        throw new Error("swarm review input result digests are invalid");
      }
      const completed = new Set([...resultByChild.values()]
        .filter((item) => item.envelope.status === "completed")
        .map((item) => item.digest));
      if (event.payload.result_envelope_digests.some((digest) => !completed.has(String(digest)))) {
        throw new Error("swarm review input references an unavailable result envelope");
      }
      const manifest = buildReviewManifestV1(artifactCandidates);
      if (event.payload.result_envelope_digests.length !== manifest.resultEnvelopeDigests.length ||
        event.payload.result_envelope_digests.some((digest, index) => digest !== manifest.resultEnvelopeDigests[index])) {
        throw new Error("swarm review input does not match the ordered candidate artifacts");
      }
      const manifestDigest = text(event.payload.manifest_digest, "swarm review manifest digest");
      if (!HEX.test(manifestDigest)) throw new Error("swarm review manifest digest is invalid");
      if (manifestDigest !== manifest.digest) {
        throw new Error("swarm review manifest digest does not match the ordered candidate artifacts");
      }
      if (!Array.isArray(event.payload.candidate_digests) ||
        event.payload.candidate_digests.length !== artifactCandidates.length ||
        event.payload.candidate_digests.some((digest, index) =>
          digest !== artifactCandidates[index]?.patch_digest
        )) {
        throw new Error("swarm review input patch digests do not match the ordered candidate artifacts");
      }
      reviewInputs.push({
        reviewer_session: reviewerSession,
        manifest_digest: manifestDigest,
        result_envelope_digests: event.payload.result_envelope_digests.map(String),
      });
      reviewInputReviewers.add(reviewerSession);
      continue;
    }
    if (event.name === "swarm/finalized" && dispatchByChild.size > 0) {
      const reviewer = text(event.payload.reviewer_session, "finalized reviewer session");
      const dispatch = dispatchByChild.get(reviewer);
      const result = resultByChild.get(reviewer);
      if (!dispatch || dispatch.contract.role !== "reviewer" || !result ||
        result.envelope.status !== "completed" || event.payload.patch_digest !== result.envelope.patchDigest) {
        throw new Error(`swarm finalization result mismatch for ${reviewer}`);
      }
    }
  }

  return { dispatches, results, parentBindings, reviewInputs, dispatchByChild, resultByChild };
}
