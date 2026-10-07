import { BlobStore } from "../host/blob-store.ts";
import type { EventLog } from "../host/event-log.ts";
import {
  inspectChildMemoryBinding,
  type ChildContractEvidence,
  type ChildContractRequest,
  type ChildMemoryVerificationStatus,
} from "./child-contract.ts";
import {
  failedProcessResult,
  type BoundedProcessResult,
  type RunDokkabiChildInput,
} from "./child-process.ts";
import { childRunInput } from "./child-request.ts";
import {
  swarmChildEventLogPath,
  type SwarmChildPrivateHome,
  type SwarmChildRouteAuthority,
} from "./child-environment.ts";
import {
  buildSwarmDispatchContract,
  dispatchContractDigest,
  type SwarmAcceptanceOwner,
  type SwarmCapabilityProfileV1,
  type SwarmDispatchContract,
} from "./contract.ts";
import {
  appendSwarmChildClose,
  appendSwarmChildOpen,
  appendSwarmDispatch,
  appendSwarmResult,
  type SwarmChildStatus,
} from "./events.ts";
import { appendWorldEffect, appendWorldFailed, appendWorldObserved } from "./pipeline-events.ts";
import { resultEnvelopeDigest, type SwarmResultEnvelopeV1 } from "./result-envelope.ts";
import {
  appendSwarmMemoryVerified,
  stageSwarmMemoryView,
} from "./memory-transport.ts";
import type { SwarmMemoryViewV1 } from "./memory-view.ts";
import type { SwarmAssignment } from "./routes.ts";
import type { SwarmChildReport } from "./types.ts";
import {
  assertSwarmWorldLease,
  plannedSwarmWorldLease,
  sealedSwarmWorldEnv,
  swarmWorldImageIdentityDigest,
  type SwarmWorldAllocationAttestor,
  type SwarmWorldLease,
  type SwarmWorldRequest,
} from "./world.ts";

export interface SwarmChildDependencies {
  readonly repoRoot: string;
  run(input: RunDokkabiChildInput): Promise<BoundedProcessResult>;
  collect(input: ChildContractRequest): ChildContractEvidence;
  openWorld(
    input: SwarmWorldRequest,
    ownership: SwarmWorldAllocationAttestor,
    plannedLease: SwarmWorldLease,
  ): SwarmWorldLease;
  closeWorld(lease: SwarmWorldLease): void;
  closeDescendants?(sessionId: string): readonly string[];
}

export interface RunSwarmChildInput {
  readonly log: EventLog;
  readonly parentSessionId: string;
  readonly assignment: SwarmAssignment;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly order: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly world: SwarmWorldRequest["spec"];
  readonly signal: AbortSignal;
  readonly planPath?: string;
  readonly deferAcceptance?: boolean;
  readonly sourceSnapshotDigest: string;
  readonly capabilityProfile: SwarmCapabilityProfileV1;
  readonly acceptanceOwner: SwarmAcceptanceOwner;
  readonly memoryView: SwarmMemoryViewV1;
  readonly privateHome: SwarmChildPrivateHome;
  readonly runtimeEnv: Readonly<Record<string, string | undefined>>;
  readonly routeAuthority?: SwarmChildRouteAuthority;
  /** 돗가비 장터 recipe seal (#60): binds this child's dispatch contract. */
  readonly recipeDigest?: string;
  complete(evidence: ChildContractEvidence): { readonly patchDigest: string };
}

export interface SwarmChildOutcome {
  readonly report: SwarmChildReport;
  readonly evidence?: ChildContractEvidence;
  readonly dispatchContract: SwarmDispatchContract;
  readonly dispatchDigest: string;
  readonly resultEnvelope: SwarmResultEnvelopeV1;
  readonly resultEnvelopeDigest: string;
}

function statusOf(
  processResult: BoundedProcessResult,
  worldHealthy: boolean,
  memoryStatus: ChildMemoryVerificationStatus,
  evidence?: ChildContractEvidence,
  patchDigest?: string,
): SwarmChildStatus {
  if (!worldHealthy) return "failed";
  if (processResult.status === "completed") {
    return memoryStatus === "ok" && evidence && patchDigest ? "completed" : "failed";
  }
  return processResult.status;
}

export async function runSwarmChild(
  input: RunSwarmChildInput,
  deps: SwarmChildDependencies,
): Promise<SwarmChildOutcome> {
  const worldRequest = {
    spec: input.world,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
  } satisfies SwarmWorldRequest;
  // Resolve mutable Docker selectors before any dispatch or world-open effect.
  const plannedLease = plannedSwarmWorldLease(worldRequest);
  const worldImageIdentityDigest = swarmWorldImageIdentityDigest(worldRequest, plannedLease);
  const opened = appendSwarmChildOpen(input.log, {
    parentSession: input.parentSessionId,
    childSession: input.sessionId,
    role: input.assignment.role,
    route: input.assignment.route,
    workspace: input.workspaceRoot,
  });
  const dispatchContract = buildSwarmDispatchContract({
    parentSession: input.parentSessionId,
    parentOpenSeq: opened.seq,
    order: input.order,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    role: input.assignment.role,
    route: input.assignment.route,
    world: input.world,
    ...(worldImageIdentityDigest ? { worldImageIdentityDigest } : {}),
    capabilityProfile: input.capabilityProfile,
    maxSteps: input.maxSteps,
    timeoutMs: input.timeoutMs,
    acceptanceOwner: input.acceptanceOwner,
    repositoryDigest: input.memoryView.repositoryDigest,
    memoryViewDigest: input.memoryView.digest,
    ...(input.recipeDigest ? { recipeDigest: input.recipeDigest } : {}),
  });
  const dispatchDigest = dispatchContractDigest(dispatchContract);
  appendSwarmDispatch(input.log, {
    childSession: input.sessionId,
    contract: dispatchContract,
    capabilityProfile: input.capabilityProfile,
    world: input.world,
    ...(worldImageIdentityDigest ? { worldImageIdentityDigest } : {}),
  });
  const childLogPath = swarmChildEventLogPath(input.privateHome, input.sessionId);
  const stagedMemory = stageSwarmMemoryView({
    log: input.log,
    childSession: input.sessionId,
    childStore: BlobStore.forSession(childLogPath),
    view: input.memoryView,
  });
  const childMemoryBinding = {
    childSession: input.sessionId,
    repositoryDigest: input.memoryView.repositoryDigest,
    viewDigest: input.memoryView.digest,
    sourceSnapshotDigest: input.memoryView.sourceSnapshotDigest,
    blobDigest: stagedMemory.blobDigest,
    dispatchDigest,
  } as const;
  const plannedWorldId = plannedLease.id;
  const plannedGitMetadata = plannedLease.gitMetadata;
  appendWorldEffect(input.log, {
    action: "open",
    childSession: input.sessionId,
    world: input.world,
    worldId: plannedWorldId,
    ...(worldImageIdentityDigest ? { imageIdentityDigest: worldImageIdentityDigest } : {}),
    ...(plannedGitMetadata ? { gitMetadata: plannedGitMetadata } : {}),
  });
  let worldAllocated = false;
  let worldHealthy = false;
  let processResult = failedProcessResult();
  let allocationAttestationRejected = false;
  const ownership = Object.freeze<SwarmWorldAllocationAttestor>({
    allocated(candidate) {
      try {
        if (allocationAttestationRejected) {
          throw new Error("swarm world allocation attestation was already rejected");
        }
        if (worldAllocated) throw new Error("swarm world allocation was attested twice");
        assertSwarmWorldLease(worldRequest, candidate);
        if (candidate !== plannedLease) {
          throw new Error("swarm world provider did not attest the host-created lease");
        }
      } catch (error) {
        // Provider callbacks are adversarial boundaries. Even when a provider
        // catches this rejection, the host remembers it for the whole open.
        allocationAttestationRejected = true;
        throw error;
      }
      worldAllocated = true;
    },
  });
  let openFailure: {
    readonly reason: "provider_error" | "invalid_lease";
    readonly allocation: "unallocated" | "allocated";
  } | undefined;
  try {
    let returnedLease: SwarmWorldLease;
    try {
      returnedLease = deps.openWorld(worldRequest, ownership, plannedLease);
    } catch (error) {
      openFailure = {
        reason: allocationAttestationRejected ? "invalid_lease" : "provider_error",
        allocation: worldAllocated ? "allocated" : "unallocated",
      };
      throw error;
    }
    if (allocationAttestationRejected) {
      openFailure = {
        reason: "invalid_lease",
        allocation: worldAllocated ? "allocated" : "unallocated",
      };
      throw new Error("swarm world open returned after a rejected allocation attestation");
    }
    let worldEnv: Readonly<Record<string, string | undefined>>;
    try {
      assertSwarmWorldLease(worldRequest, returnedLease);
      if (returnedLease !== plannedLease) {
        throw new Error("swarm world provider did not return the host-created lease");
      }
      worldEnv = sealedSwarmWorldEnv(worldRequest, plannedLease);
    } catch (error) {
      openFailure = {
        reason: "invalid_lease",
        allocation: worldAllocated ? "allocated" : "unallocated",
      };
      throw error;
    }
    // Compatibility for providers that atomically return a valid lease. A
    // throw is never implicit ownership; post-allocation failures must attest.
    if (!worldAllocated) worldAllocated = true;
    worldHealthy = true;
    appendWorldObserved(input.log, { state: "ready", childSession: input.sessionId, worldId: plannedLease.id });
    input.log.append({
      kind: "effect",
      name: "swarm/spawn",
      payload: { child_session: input.sessionId, role: input.assignment.role, route: input.assignment.route },
    });
    try {
      processResult = await deps.run(childRunInput({
        repoRoot: deps.repoRoot,
        request: { order: input.order, maxSteps: input.maxSteps, timeoutMs: input.timeoutMs },
        assignment: input.assignment,
        workspaceRoot: input.workspaceRoot,
        sessionId: input.sessionId,
        parentOpenSeq: opened.seq,
        parentSessionId: input.parentSessionId,
        dispatchDigest,
        signal: input.signal,
        ...(input.planPath ? { planPath: input.planPath } : {}),
        ...(input.deferAcceptance ? { deferAcceptance: true } : {}),
        privateHome: input.privateHome,
        runtimeEnv: input.runtimeEnv,
        ...(input.routeAuthority ? { routeAuthority: input.routeAuthority } : {}),
        worldEnv,
        memoryBinding: {
          repositoryDigest: input.memoryView.repositoryDigest,
          viewDigest: input.memoryView.digest,
          blobDigest: stagedMemory.blobDigest,
        },
        capabilityBinding: {
          pluginManifestDigest: input.capabilityProfile.pluginManifestDigest,
          toolSchemaDigest: input.capabilityProfile.toolSchemaDigest,
        },
      }));
    } catch {
      processResult = failedProcessResult();
    }
  } catch {
    worldHealthy = false;
    if (openFailure) {
      appendWorldFailed(input.log, {
        childSession: input.sessionId,
        worldId: plannedLease.id,
        phase: "open",
        ...openFailure,
      });
    }
  } finally {
    if (worldAllocated) {
      let closeEffectRecorded = false;
      try {
        appendWorldEffect(input.log, {
          action: "close",
          childSession: input.sessionId,
          world: input.world,
          worldId: plannedLease.id,
          ...(worldImageIdentityDigest ? { imageIdentityDigest: worldImageIdentityDigest } : {}),
          ...(plannedLease.gitMetadata ? { gitMetadata: plannedLease.gitMetadata } : {}),
        });
        closeEffectRecorded = true;
      } catch {
        // Cleanup is mandatory even when durable close intent cannot be
        // recorded. The child remains failed and no false observation lands.
        worldHealthy = false;
      }
      let closeSucceeded = false;
      try {
        // Cleanup always uses the host-created, frozen plan. A provider lease
        // can be a Proxy or mutate after validation; none of its selectors may
        // choose the cleanup target.
        deps.closeWorld(plannedLease);
        closeSucceeded = true;
      } catch {
        worldHealthy = false;
        if (closeEffectRecorded) {
          appendWorldFailed(input.log, {
            childSession: input.sessionId,
            worldId: plannedLease.id,
            phase: "close",
            reason: "provider_error",
            allocation: "allocated",
          });
        }
      }
      if (closeSucceeded && closeEffectRecorded) {
        try {
          appendWorldObserved(input.log, {
            state: "closed",
            childSession: input.sessionId,
            worldId: plannedLease.id,
          });
        } catch {
          worldHealthy = false;
        }
      }
    }
  }
  let evidence: ChildContractEvidence | undefined;
  if (processResult.status !== "completed") {
    const closed = deps.closeDescendants?.(input.sessionId) ?? [];
    if (closed.length > 0) {
      input.log.append({
        kind: "observe",
        name: "swarm/descendants_closed",
        payload: { child_session: input.sessionId, descendants: [...closed], status: processResult.status },
      });
    }
  }
  // A non-zero child can still leave a verified partial EventLog and sealed
  // plan. Preserve every reference the host can derive; only unavailable
  // fields remain `missing`, and no failed child is promoted to completed.
  if (worldHealthy) {
    try {
      const collected = deps.collect({
        sessionId: input.sessionId,
        parentSession: input.parentSessionId,
        parentOpenSeq: opened.seq,
        role: input.assignment.role,
        route: input.assignment.route,
        dispatchDigest,
        operatorOrderDigest: dispatchContract.operatorOrderDigest,
        workspaceRoot: input.workspaceRoot,
        planPath: input.planPath ?? "work/current.json",
        eventLogPath: childLogPath,
        memoryBinding: childMemoryBinding,
        capabilityProfile: input.capabilityProfile,
      });
      if (collected.sessionId !== input.sessionId || collected.dispatchDigest !== dispatchDigest ||
        collected.repositoryDigest !== input.memoryView.repositoryDigest ||
        collected.memoryViewDigest !== input.memoryView.digest) {
        throw new Error("child collection evidence does not match its dispatch and memory binding");
      }
      evidence = collected;
    } catch {
      evidence = undefined;
    }
  }
  const memoryVerificationStatus = inspectChildMemoryBinding({
    eventLogPath: childLogPath,
    binding: childMemoryBinding,
    parentSession: input.parentSessionId,
    parentOpenSeq: opened.seq,
    role: input.assignment.role,
    route: input.assignment.route,
  });
  appendSwarmMemoryVerified(input.log, {
    childSession: input.sessionId,
    viewDigest: input.memoryView.digest,
    blobDigest: stagedMemory.blobDigest,
    dispatchDigest,
    status: memoryVerificationStatus,
  });
  let patchDigest: string | undefined;
  if (worldHealthy && processResult.status === "completed" &&
    memoryVerificationStatus === "ok" && evidence) {
    try {
      const artifact = input.complete(evidence);
      if (!/^[a-f0-9]{64}$/.test(artifact.patchDigest)) {
        throw new Error("child patch digest is invalid");
      }
      patchDigest = artifact.patchDigest;
    } catch {
      patchDigest = undefined;
    }
  }
  const status = statusOf(processResult, worldHealthy, memoryVerificationStatus, evidence, patchDigest);
  const resultEnvelope: SwarmResultEnvelopeV1 = {
    format: 1,
    dispatchDigest,
    childSession: input.sessionId,
    status,
    replayDigest: evidence?.replayDigest ?? "missing",
    finalHash: evidence?.finalHash ?? "missing",
    evidenceDigest: evidence?.evidenceDigest ?? "missing",
    graphRev: evidence?.graphRev ?? "missing",
    planDigest: evidence?.planDigest ?? "missing",
    patchDigest: patchDigest ?? "missing",
    summaryDigest: evidence?.summaryDigest ?? "missing",
  };
  appendSwarmResult(input.log, resultEnvelope);
  const resultDigest = resultEnvelopeDigest(resultEnvelope);
  appendSwarmChildClose(input.log, {
    parentSession: input.parentSessionId,
    childSession: input.sessionId,
    parentOpenSeq: opened.seq,
    role: input.assignment.role,
    route: input.assignment.route,
    status,
    exitCode: processResult.exitCode ?? "missing",
    signalCode: processResult.signalCode ?? "missing",
    replayDigest: evidence?.replayDigest ?? "missing",
    finalHash: evidence?.finalHash ?? "missing",
    evidenceDigest: evidence?.evidenceDigest ?? "missing",
    graphRev: evidence?.graphRev ?? "missing",
    stdoutDigest: processResult.stdoutDigest,
    stderrDigest: processResult.stderrDigest,
    resultEnvelopeDigest: resultDigest,
  });
  return {
    report: {
      role: input.assignment.role,
      route: input.assignment.route,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      status,
      replayDigest: evidence?.replayDigest ?? "missing",
      finalHash: evidence?.finalHash ?? "missing",
      dispatchDigest,
      resultEnvelopeDigest: resultDigest,
    },
    ...(evidence ? { evidence } : {}),
    dispatchContract,
    dispatchDigest,
    resultEnvelope,
    resultEnvelopeDigest: resultDigest,
  };
}
