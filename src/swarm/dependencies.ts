import { randomUUID } from "node:crypto";
import { dokkabiHome, piAuthPath } from "../host/paths.ts";
import { closeInterruptedAcceptanceSessions } from "../work/accept-cleanup.ts";
import {
  collectCandidateArtifact,
  materializeReviewInputs,
  prepareReviewPlan,
  removeReviewInputs,
  type CandidateArtifact,
  type CandidateArtifactDraft,
  type CandidateArtifactRequest,
  type ReviewInputBundle,
} from "./artifact.ts";
import { collectChildContract } from "./child-contract.ts";
import { runDokkabiChild } from "./child-process.ts";
import type { SwarmChildDependencies } from "./child-runner.ts";
import { swarmRepositoryDigest } from "./repository-identity.ts";
import {
  applyWorktreeDelta,
  applyWorktreeDeltaToTarget,
  allocateSnapshotWorktree,
  captureWorktreeDelta,
  captureWorktreeSnapshot,
  removeSnapshotWorktree,
  type SnapshotWorktree,
  type WorktreeDelta,
  type WorktreeSnapshot,
} from "./worktree.ts";
import { closeSwarmWorld, openSwarmWorld } from "./world.ts";

export interface SwarmDependencies extends SwarmChildDependencies {
  homeRoot(): string;
  parentAuthPath(): string;
  nonce(): string;
  repositoryDigest(sourceRoot: string): string;
  capture(sourceRoot: string): WorktreeSnapshot;
  allocate(snapshot: WorktreeSnapshot, targetRoot: string): SnapshotWorktree;
  remove(sourceRoot: string, targetRoot: string): void;
  artifact(input: CandidateArtifactRequest): CandidateArtifactDraft;
  materialize(reviewerRoot: string, artifacts: readonly CandidateArtifact[]): ReviewInputBundle;
  cleanReviewInputs(reviewerRoot: string): void;
  prepareReviewPlan(reviewerRoot: string): void;
  delta(base: WorktreeSnapshot, targetRoot: string): WorktreeDelta;
  seed(base: WorktreeSnapshot, delta: WorktreeDelta, targetRoot: string): WorktreeSnapshot;
  apply(base: WorktreeSnapshot, delta: WorktreeDelta): WorktreeSnapshot;
}

export function defaultSwarmDependencies(repoRoot: string): SwarmDependencies {
  return {
    repoRoot,
    homeRoot: dokkabiHome,
    parentAuthPath: piAuthPath,
    nonce: () => randomUUID().slice(0, 8),
    repositoryDigest: swarmRepositoryDigest,
    capture: captureWorktreeSnapshot,
    allocate: allocateSnapshotWorktree,
    remove: removeSnapshotWorktree,
    run: runDokkabiChild,
    collect: collectChildContract,
    openWorld: (input, ownership, plannedLease) =>
      openSwarmWorld(input, undefined, ownership, plannedLease),
    closeWorld: closeSwarmWorld,
    closeDescendants: (sessionId) => closeInterruptedAcceptanceSessions(dokkabiHome(), sessionId),
    artifact: collectCandidateArtifact,
    materialize: materializeReviewInputs,
    cleanReviewInputs: removeReviewInputs,
    prepareReviewPlan,
    delta: captureWorktreeDelta,
    seed: applyWorktreeDeltaToTarget,
    apply: applyWorktreeDelta,
  };
}
