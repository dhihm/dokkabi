import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveMessages } from "../host/derive-messages.ts";
import { EventLog } from "../host/event-log.ts";
import { dokkabiHome, sessionLogPath } from "../host/paths.ts";
import { writeWorkPlan } from "../work/decompose.ts";
import { loadWorkPlan } from "../work/load.ts";
import { loadRunnerSpecs } from "../work/runner-load.ts";
import type { ChildContractEvidence } from "./child-contract.ts";
import { buildReviewManifestV1 } from "./review-manifest.ts";
import type { SwarmCandidateRole } from "./routes.ts";
import { captureWorktreeDelta, type WorktreeDelta, type WorktreeSnapshot } from "./worktree.ts";

export const REVIEW_INPUT_DIR = ".dokkabi-swarm-input";

export interface CandidateArtifactDraft {
  readonly role: SwarmCandidateRole;
  readonly route: string;
  readonly sessionId: string;
  readonly evidence: ChildContractEvidence;
  readonly delta: WorktreeDelta;
  readonly summary: string;
  readonly summaryDigest: string;
}

export interface CandidateArtifact extends CandidateArtifactDraft {
  readonly dispatchDigest: string;
  readonly resultEnvelopeDigest: string;
  readonly planDigest: string;
}

export interface CandidateArtifactRequest {
  readonly base: WorktreeSnapshot;
  readonly workspaceRoot: string;
  readonly role: SwarmCandidateRole;
  readonly route: string;
  readonly evidence: ChildContractEvidence;
}

export function collectCandidateArtifact(input: CandidateArtifactRequest): CandidateArtifactDraft {
  const log = new EventLog(sessionLogPath(input.evidence.sessionId));
  const summary = [...deriveMessages(log.events)].reverse()
    .find((message) => message.role === "assistant")?.text ?? "";
  const summaryDigest = createHash("sha256").update(summary).digest("hex");
  if (summaryDigest !== input.evidence.summaryDigest) {
    throw new Error("candidate summary digest does not match child terminal evidence");
  }
  return {
    role: input.role,
    route: input.route,
    sessionId: input.evidence.sessionId,
    evidence: input.evidence,
    delta: captureWorktreeDelta(input.base, input.workspaceRoot),
    summary,
    summaryDigest,
  };
}

export interface ReviewInputBundle {
  readonly dir: string;
  readonly manifestDigest: string;
  readonly resultEnvelopeDigests: readonly string[];
}

export interface ReviewInputManifest {
  readonly body: string;
  readonly digest: string;
  readonly resultEnvelopeDigests: readonly string[];
}

export function reviewInputManifest(artifacts: readonly CandidateArtifact[]): ReviewInputManifest {
  const candidates = artifacts.map((artifact) => ({
    role: artifact.role,
    route: artifact.route,
    session: artifact.sessionId,
    patch: `${artifact.role}/patch.diff`,
    patch_digest: artifact.delta.patchDigest,
    summary: `${artifact.role}/summary.md`,
    summary_digest: artifact.summaryDigest,
    dispatch_digest: artifact.dispatchDigest,
    result_envelope_digest: artifact.resultEnvelopeDigest,
    plan_digest: artifact.planDigest,
    replay_digest: artifact.evidence.replayDigest,
    evidence_digest: artifact.evidence.evidenceDigest,
    graph_rev: artifact.evidence.graphRev,
  }));
  return buildReviewManifestV1(candidates);
}

export function materializeReviewInputs(
  reviewerRoot: string,
  artifacts: readonly CandidateArtifact[],
): ReviewInputBundle {
  const root = join(reviewerRoot, REVIEW_INPUT_DIR);
  if (existsSync(root)) {
    throw new Error(`swarm review input already exists: ${root}`);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const artifact of artifacts) {
    const candidateRoot = join(root, artifact.role);
    mkdirSync(candidateRoot, { mode: 0o700 });
    writeFileSync(join(candidateRoot, "patch.diff"), artifact.delta.patch, { mode: 0o600 });
    writeFileSync(join(candidateRoot, "summary.md"), artifact.summary, { mode: 0o600 });
  }
  const manifest = reviewInputManifest(artifacts);
  writeFileSync(join(root, "manifest.json"), manifest.body, { mode: 0o600 });
  return {
    dir: REVIEW_INPUT_DIR,
    manifestDigest: manifest.digest,
    resultEnvelopeDigests: manifest.resultEnvelopeDigests,
  };
}

export function removeReviewInputs(reviewerRoot: string): void {
  rmSync(join(reviewerRoot, REVIEW_INPUT_DIR), { recursive: true, force: true });
}

export function prepareReviewPlan(reviewerRoot: string): void {
  const path = join(reviewerRoot, "work", "current.json");
  const runners = loadRunnerSpecs({ workspaceRoot: reviewerRoot, homeDir: dokkabiHome() });
  if (runners.errors.length > 0) {
    throw new Error(`cannot prepare swarm review plan: ${runners.errors.map((error) => `runner spec ${error}`).join("; ")}`);
  }
  const loaded = loadWorkPlan(path);
  if (loaded.errors.length > 0) {
    throw new Error(`cannot prepare swarm review plan: ${loaded.errors.join("; ")}`);
  }
  writeWorkPlan(path, { ...loaded.plan, require_red_first: false });
}
