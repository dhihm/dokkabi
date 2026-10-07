import type { EventLog } from "../host/event-log.ts";
import type { EventRecord, Missing } from "../host/schema.ts";
import {
  assertSwarmCapabilityProfile,
  assertSwarmDispatchContract,
  dispatchContractDigest,
  publicSwarmWorldFact,
  publicSwarmWorldFactDigest,
  swarmCapabilityProfileDigest,
  swarmWorldDigest,
  type SwarmCapabilityProfileV1,
  type SwarmDispatchContract,
} from "./contract.ts";
import type { SwarmWorldSpec } from "./world.ts";
import {
  assertSwarmResultEnvelope,
  resultEnvelopeDigest,
  type SwarmResultEnvelopeV1,
} from "./result-envelope.ts";
import { projectSwarmReferences } from "./reference-validation.ts";
import type { SwarmRole } from "./routes.ts";
import { projectSwarmMemoryTransportReferenceForChild } from "./memory-transport.ts";

export type SwarmChildStatus = "completed" | "failed" | "cancelled" | "timeout";
export type SwarmStatus = "completed" | "failed" | "cancelled";

export interface SwarmStartInput {
  parentSession: string;
  roles: readonly SwarmRole[];
  snapshotDigest: string;
}

export interface SwarmChildOpenInput {
  parentSession: string;
  childSession: string;
  role: SwarmRole;
  route: string;
  workspace: string;
}

export interface SwarmChildCloseInput {
  parentSession: string;
  childSession: string;
  parentOpenSeq: number;
  role: SwarmRole;
  route: string;
  status: SwarmChildStatus;
  exitCode: number | Missing;
  signalCode: string | Missing;
  replayDigest: string | Missing;
  finalHash: string | Missing;
  evidenceDigest: string | Missing;
  graphRev: number | Missing;
  stdoutDigest?: string;
  stderrDigest?: string;
  resultEnvelopeDigest?: string;
}

export interface SwarmFinishInput {
  parentSession: string;
  status: SwarmStatus;
  candidateCompleted: number;
  candidateTotal: number;
  reviewerStatus: SwarmChildStatus | "missing";
  finalized: boolean;
}

export interface SessionParentInput {
  parentSession: string;
  parentOpenSeq: number;
  childSession: string;
  role: SwarmRole;
  route: string;
  contractDigest?: string;
}

export interface SwarmDispatchInput {
  childSession: string;
  contract: SwarmDispatchContract;
  capabilityProfile: SwarmCapabilityProfileV1;
  /** Modern safe replay binding. Legacy callers may omit it. */
  world?: SwarmWorldSpec;
  /** Host-resolved immutable image identity; durable evidence receives only its digest. */
  worldImageIdentityDigest?: string;
}

const HEX = /^[a-f0-9]{64}$/;

function requireHex(value: string | Missing, label: string): void {
  if (value !== "missing" && !HEX.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase hex digest or missing`);
  }
}

export function appendSwarmStart(log: EventLog, input: SwarmStartInput): EventRecord {
  requireHex(input.snapshotDigest, "snapshot digest");
  return log.append({
    kind: "observe",
    name: "swarm/start",
    payload: {
      parent_session: input.parentSession,
      roles: [...input.roles],
      snapshot_digest: input.snapshotDigest,
    },
  });
}

export function appendSessionParent(log: EventLog, input: SessionParentInput): EventRecord {
  if (input.contractDigest !== undefined) requireHex(input.contractDigest, "dispatch contract digest");
  return log.append({
    kind: "observe",
    name: "session/parent",
    payload: {
      parent_session: input.parentSession,
      parent_open_seq: input.parentOpenSeq,
      child_session: input.childSession,
      role: input.role,
      route: input.route,
      ...(input.contractDigest ? { contract_digest: input.contractDigest } : {}),
    },
  });
}

export function appendSwarmDispatch(log: EventLog, input: SwarmDispatchInput): EventRecord {
  assertSwarmDispatchContract(input.contract);
  assertSwarmCapabilityProfile(input.capabilityProfile);
  if (input.contract.capabilityProfileDigest !== swarmCapabilityProfileDigest(input.capabilityProfile)) {
    throw new Error("dispatch capability profile digest mismatch");
  }
  if (input.contract.format === 2) {
    const contract = input.contract;
    const memory = [...log.events].reverse().find((event) => event.name === "swarm/memory_view" &&
      event.payload.view_digest === contract.memoryViewDigest);
    if (!memory || memory.seq >= contract.parentOpenSeq ||
      memory.payload.repository_digest !== contract.repositoryDigest) {
      throw new Error("dispatch memory view does not match a preceding recorded view");
    }
  }
  // A contract sealed under a recipe must match the seal THIS log recorded
  // (PR #92 review finding 2, mirroring the memory-view rule): without this,
  // a refactor could record digest A on the parent log while dispatching
  // children under digest B with no refusal.
  if (input.contract.recipeDigest !== undefined) {
    const contract = input.contract;
    const sealed = [...log.events].reverse().find((event) => event.name === "market/recipe");
    if (!sealed || sealed.payload.digest !== contract.recipeDigest) {
      throw new Error("dispatch recipe digest does not match the recorded market/recipe seal");
    }
  }
  const worldFact = input.world
    ? publicSwarmWorldFact(input.world, input.worldImageIdentityDigest)
    : undefined;
  if (input.world && input.contract.worldDigest !== swarmWorldDigest(
    input.world,
    input.worldImageIdentityDigest,
  )) {
    throw new Error("dispatch public world fact does not match the contract");
  }
  const opened = [...log.events].reverse().find((event) =>
    event.name === "swarm/child_open" && event.payload.child_session === input.childSession
  );
  if (!opened || opened.seq !== input.contract.parentOpenSeq ||
    opened.payload.parent_session !== input.contract.parentSession ||
    opened.payload.role !== input.contract.role || opened.payload.route !== input.contract.route) {
    throw new Error("dispatch contract does not match a preceding child_open");
  }
  if (log.events.some((event) =>
    event.name === "swarm/dispatch" && event.payload.child_session === input.childSession
  )) {
    throw new Error(`duplicate swarm dispatch for ${input.childSession}`);
  }
  return log.append({
    kind: "effect",
    name: "swarm/dispatch",
    payload: {
      child_session: input.childSession,
      contract: input.contract,
      contract_digest: dispatchContractDigest(input.contract),
      capability_profile: input.capabilityProfile,
      ...(worldFact
        ? {
            world_fact: worldFact,
            world_fact_digest: publicSwarmWorldFactDigest(worldFact),
          }
        : {}),
    },
  });
}

export function appendSwarmResult(log: EventLog, envelope: SwarmResultEnvelopeV1): EventRecord {
  const dispatch = log.events.find((event) =>
    event.name === "swarm/dispatch" && event.payload.child_session === envelope.childSession
  );
  const dispatchDigest = dispatch?.payload.contract_digest;
  if (!dispatch || typeof dispatchDigest !== "string") {
    throw new Error(`swarm result has no dispatch for ${envelope.childSession}`);
  }
  assertSwarmResultEnvelope(envelope, {
    childSession: envelope.childSession,
    dispatchDigest,
  });
  const contract = dispatch.payload.contract;
  if (typeof contract === "object" && contract !== null && !Array.isArray(contract) &&
    (contract as { readonly format?: unknown }).format === 2) {
    const memory = projectSwarmMemoryTransportReferenceForChild(log.events, envelope.childSession);
    if (memory.dispatch_digest !== dispatchDigest) {
      throw new Error(`swarm result memory transport digest mismatch for ${envelope.childSession}`);
    }
    if (envelope.status === "completed" && memory.status !== "ok") {
      throw new Error(`completed swarm child requires an ok memory verification for ${envelope.childSession}`);
    }
  }
  if (log.events.some((event) =>
    event.name === "swarm/result" && event.payload.child_session === envelope.childSession
  )) {
    throw new Error(`duplicate swarm result for ${envelope.childSession}`);
  }
  return log.append({
    kind: "observe",
    name: "swarm/result",
    payload: {
      child_session: envelope.childSession,
      envelope,
      envelope_digest: resultEnvelopeDigest(envelope),
    },
  });
}

export function appendSwarmChildOpen(log: EventLog, input: SwarmChildOpenInput): EventRecord {
  return log.append({
    kind: "observe",
    name: "swarm/child_open",
    payload: {
      parent_session: input.parentSession,
      child_session: input.childSession,
      role: input.role,
      route: input.route,
      workspace: input.workspace,
    },
  });
}

export function appendSwarmChildClose(log: EventLog, input: SwarmChildCloseInput): EventRecord {
  requireHex(input.replayDigest, "replay digest");
  requireHex(input.finalHash, "final hash");
  requireHex(input.evidenceDigest, "evidence digest");
  if (input.stdoutDigest !== undefined) {
    requireHex(input.stdoutDigest, "stdout digest");
  }
  if (input.stderrDigest !== undefined) {
    requireHex(input.stderrDigest, "stderr digest");
  }
  if (input.resultEnvelopeDigest !== undefined) {
    requireHex(input.resultEnvelopeDigest, "result envelope digest");
  }
  if (input.status === "completed" && (
    input.exitCode !== 0 ||
    input.signalCode !== "missing" ||
    input.replayDigest === "missing" ||
    input.finalHash === "missing" ||
    input.evidenceDigest === "missing" ||
    input.graphRev === "missing"
  )) {
    throw new Error("completed child requires replay digest, final hash, evidence digest, and graph rev");
  }
  return log.append({
    kind: "observe",
    name: "swarm/child_close",
    payload: {
      parent_session: input.parentSession,
      child_session: input.childSession,
      parent_open_seq: input.parentOpenSeq,
      role: input.role,
      route: input.route,
      status: input.status,
      exit_code: input.exitCode,
      signal_code: input.signalCode,
      replay_digest: input.replayDigest,
      final_hash: input.finalHash,
      evidence_digest: input.evidenceDigest,
      graph_rev: input.graphRev,
      ...(input.stdoutDigest ? { stdout_digest: input.stdoutDigest } : {}),
      ...(input.stderrDigest ? { stderr_digest: input.stderrDigest } : {}),
      ...(input.resultEnvelopeDigest ? { result_envelope_digest: input.resultEnvelopeDigest } : {}),
    },
  });
}

export function appendSwarmFinish(log: EventLog, input: SwarmFinishInput): EventRecord {
  if (input.status === "completed" && (
    input.candidateCompleted < 1 || input.reviewerStatus !== "completed" || !input.finalized
  )) {
    throw new Error("completed swarm requires a candidate, completed reviewer, and finalized result");
  }
  if (input.status === "completed" && log.events.some((event) => event.name === "swarm/dispatch")) {
    const references = projectSwarmReferences(log.events);
    const completedCandidates = [...references.resultByChild.values()].filter((result) => {
      const dispatch = references.dispatchByChild.get(result.envelope.childSession);
      return result.envelope.status === "completed" && dispatch?.contract.role !== "reviewer";
    });
    const completedReviewer = [...references.resultByChild.values()].find((result) => {
      const dispatch = references.dispatchByChild.get(result.envelope.childSession);
      return result.envelope.status === "completed" && dispatch?.contract.role === "reviewer";
    });
    const reviewInput = completedReviewer
      ? references.reviewInputs.filter((item) =>
          item.reviewer_session === completedReviewer.envelope.childSession
        )
      : [];
    const finalized = completedReviewer && log.events.some((event) =>
      event.name === "swarm/finalized" && event.payload.reviewer_session === completedReviewer.envelope.childSession &&
      event.payload.patch_digest === completedReviewer.envelope.patchDigest
    );
    if (references.dispatchByChild.size !== references.resultByChild.size ||
      completedCandidates.length !== input.candidateCompleted || !completedReviewer || !finalized ||
      reviewInput.length !== 1 || reviewInput[0]!.result_envelope_digests.length !== completedCandidates.length) {
      throw new Error("completed swarm references are incomplete or inconsistent");
    }
  }
  return log.append({
    kind: "observe",
    name: "swarm/finish",
    payload: {
      parent_session: input.parentSession,
      status: input.status,
      candidate_completed: input.candidateCompleted,
      candidate_total: input.candidateTotal,
      reviewer_status: input.reviewerStatus,
      finalized: input.finalized,
    },
  });
}
