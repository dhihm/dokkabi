import { createHash } from "node:crypto";

export interface ReviewCandidateReferenceV1 {
  readonly role: string;
  readonly route: string;
  readonly session: string;
  readonly patch: string;
  readonly patch_digest: string;
  readonly summary: string;
  readonly summary_digest: string;
  readonly dispatch_digest: string;
  readonly result_envelope_digest: string;
  readonly plan_digest: string;
  readonly replay_digest: string;
  readonly evidence_digest: string;
  readonly graph_rev: number;
}

export interface ReviewManifestProjectionV1 {
  readonly body: string;
  readonly digest: string;
  readonly resultEnvelopeDigests: readonly string[];
}

/** Build the exact reviewer manifest bytes whose digest is recorded by the parent. */
export function buildReviewManifestV1(
  candidates: readonly ReviewCandidateReferenceV1[],
): ReviewManifestProjectionV1 {
  const body = `${JSON.stringify({ candidates }, null, 2)}\n`;
  return {
    body,
    digest: createHash("sha256").update(body).digest("hex"),
    resultEnvelopeDigests: candidates.map((candidate) => candidate.result_envelope_digest),
  };
}
