import { foldRecoveryEpisodes, type RecoveryEpisode } from "./recovery.ts";
import { projectBranchWorkspaceReferences, type BranchWorkspaceReference } from "./branch-workspace-replay.ts";
import { projectCheckpointInputImportReferences, type CheckpointInputImportReference } from "./checkpoint-input-import-replay.ts";
import { projectBranchCheckpointReferences, type BranchCheckpointReference } from "./branch-checkpoint-replay.ts";
import { projectBranchDecisionReferences, type BranchDecisionReference } from "./branch-decision.ts";
import { projectBranchRuntimeReferences, type BranchRuntimeReference } from "../chat/desktop-branch-runtime.ts";
import { projectResultSourceReferences } from "./result-source.ts";
import { projectContextGraph } from "../context-graph/projector.ts";
import { verifyContextFrames } from "../context-graph/service.ts";
import { retainedReaderOfBodies, type RetainedBranchBodyReader } from "../context-graph/branch-context.ts";
import { CONTEXT_GRAPH_ROWS } from "../context-graph/types.ts";
import { projectCasePolicies } from "../eval/experiment/case-policy.ts";
import { projectMeasurementPolicies } from "../eval/experiment/measurement-policy.ts";
import { projectExperimentFacts } from "../eval/experiment/condition.ts";
import { projectObservationCoverage } from "./observation-schema.ts";
import { projectProviderInputs } from "./provider-input.ts";
import { projectAcceptanceReplay } from "../work/evidence/acceptance-replay.ts";
import { projectWorkReplay } from "../work/replay-evidence.ts";
import { projectGraphState } from "../graph/state-evidence.ts";
import { projectEarnedInputs } from "../work/evidence/earned.ts";
import { projectObligations, OBLIGATION_EVENT, AUTHORITY_EVENT } from "../work/evidence/obligations.ts";
import { projectMeasurements, isMeasurementEvent } from "../work/evidence/measurement-projection.ts";
import { projectFixtures, isFixtureEvent, type FixtureReference } from "../work/evidence/fixture-projection.ts";
import type { FixturePreparationReceipt } from "../work/evidence/fixture-prepare.ts";
import { projectEvidence, isEvidenceEvent, type EvidenceBodies, type EvidenceReference } from "../work/evidence/projection.ts";
import type { GateEvidenceInputV2, EvidenceDecisionV2 } from "../work/evidence/schema.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { deriveMessages } from "./derive-messages.ts";
import {
  SESSION_SCHEMA_VERSION,
  projectSessionReplaySchemas,
  type EventRecord,
  type ModelQuotaSnapshot,
} from "./schema.ts";
import {
  failoverPolicyDigest,
  normalizeFailoverPolicyV1,
} from "./model-failover.ts";
import { normalizeQuotaSnapshotV1, quotaSnapshotFreshness } from "./quota.ts";
import {
  projectSwarmReferences,
  type SwarmDispatchReference,
  type SwarmParentBindingReference,
  type SwarmReviewInputReference,
  type SwarmReferenceProjection,
  type SwarmResultReference,
} from "../swarm/reference-validation.ts";
import {
  assertPublicSwarmWorldFact,
  publicSwarmWorldFactDigest,
  type PublicSwarmWorldFactV1,
} from "../swarm/contract.ts";
import {
  projectMaekQueryReference,
  type MaekQueryReference,
} from "../maek/query-envelope.ts";
import {
  projectWorkStepReferences,
  type WorkStepReferenceV1,
} from "../work/step-reference.ts";
import {
  projectSemanticLivelockReferences,
  type SemanticLivelockReference,
} from "../work/semantic-livelock-reference.ts";
import {
  projectSwarmMemoryTransportReferences,
  projectSwarmMemoryViewReferences,
  type SwarmMemoryTransportReferenceV1,
  type SwarmMemoryViewReferenceV1,
} from "../swarm/memory-transport.ts";
import {
  projectToolProfileReferences,
  type ToolProfileReference,
} from "./tool-profile-event.ts";
import {
  projectSpeculationReferences,
  type SpeculationReference,
} from "../speculative/events.ts";
import { projectSpeculationV2References, type SpeculationV2Reference } from "../speculative/events-v2.ts";
import { projectModelLoopReplay, type ModelLoopReplayReference } from "./model-loop-replay.ts";

export interface ChildSessionReference {
  session: string;
  status: string;
  replay_digest: string;
  final_hash: string;
  graph_rev: number | "missing";
  evidence_digest: string;
}

export interface SwarmFinalizationReference {
  reviewer_session: string;
  patch_digest: string;
  final_tree: string;
}

export interface KnowledgeQueryReference {
  op: string;
  request_digest: string;
  result_digest: string;
}

export interface KnowledgeReadReference {
  document_id: string;
  request_digest: string;
  result_digest: string;
}

export interface KnowledgeMutationReference {
  /** Mutation kind in its original event order. */
  op: string;
  /** Stable document identifier, or a digest-only publication identity. */
  document_id: string;
  base_digest: string;
  result_digest: string;
  status: string;
  path_digest: string;
}

export interface SandboxNetworkReference {
  seq: number;
  name: "sandbox/policy" | "sandbox/exec";
  backend: "bwrap" | "docker" | "seatbelt" | "none";
  mode: "workspace-write" | "read-only" | "envfix";
  network: "allow" | "deny";
  policy_digest: string;
  /** Recomputable digest of the public enforcement fact. The opaque policy
   * digest also binds private host authority that replay must not expose. */
  policy_fact_digest: string;
}

export interface SwarmWorldNetworkReference {
  seq: number;
  name:
    | "swarm/world_open"
    | "swarm/world_ready"
    | "swarm/world_close"
    | "swarm/world_closed"
    | "swarm/world_failed";
  world: "local" | "docker";
  network: "allow" | "deny";
  /** Child and runtime coordinates remain digest-only in replay evidence. */
  child_session_digest: string;
  world_id_digest: string;
  image_digest: string | "missing";
  git_metadata: "common-read-only" | "missing";
  failure_phase?: "open" | "close";
  failure_reason?: "provider_error" | "invalid_lease";
  allocation?: "unallocated" | "allocated";
}

export interface SessionSchemaReference {
  seq: number;
  version: typeof SESSION_SCHEMA_VERSION;
  features: string[];
}

export interface ReplayContract {
  recovery?: RecoveryEpisode[];
  experiment?: ReturnType<typeof projectExperimentFacts>["references"];
  branchCheckpoints?: BranchCheckpointReference[];
  branchWorkspaces?: BranchWorkspaceReference[];
  checkpointInputImports?: CheckpointInputImportReference[];
  /** R8-04: ordered durable decision lifecycle references. Absent when the
   * session recorded no decision row, so older digests stay unchanged. */
  branchDecisions?: BranchDecisionReference[];
  /** R8-05: ordered branch runtime start/completion references, re-derived
   * from the log with the same retained decision/child authority. Omitted
   * when empty so older digests are unchanged. */
  branchRuntime?: BranchRuntimeReference[];
  observations?: ReturnType<typeof projectObservationCoverage>["references"];
  providerInputs?: ReturnType<typeof projectProviderInputs>["identities"];
  acceptanceReplay?: ReturnType<typeof projectAcceptanceReplay>["references"];
  workReplay?: ReturnType<typeof projectWorkReplay>["references"];
  graphState?: ReturnType<typeof projectGraphState>["mutations"];
  earnedInputs?: ReturnType<typeof projectEarnedInputs>;
  obligationSnapshots?: Array<{ seq: number; digest: string; revision: number; scope_seq: number }>;
  measurementDecisions?: ReturnType<typeof projectMeasurements>["decisions"];
  measurementReferences?: ReturnType<typeof projectMeasurements>["references"];
  fixturePreparations?: FixturePreparationReceipt[];
  fixtureReferences?: FixtureReference[];
  evidenceInputs?: GateEvidenceInputV2[];
  evidenceReferences?: EvidenceReference[];
  evidenceDecisions?: EvidenceDecisionV2[];
  /** sha256 over deriveMessages bytes: the surface replay layer. */
  transcriptHash: string;
  /** prompt/seal prefix hashes in order. */
  prefixHashes: string[];
  /** Tool name + args digest in call order (args JSON lives as digests by constitution). */
  toolCalls: Array<{ name: string; args_digest: string }>;
  toolProfiles: ToolProfileReference[];
  speculations: SpeculationReference[];
  speculationsV2?: SpeculationV2Reference[];
  /** Allowed graph queries with their recorded result digests. */
  graphQueries: Array<{ query: string; result_digest: string }>;
  /** Recorded MAEK queries. Empty on clips that never used ctx.maek. */
  maekQueries: MaekQueryReference[];
  /** Recorded durable-wiki query results. Bodies live in referenced blobs. */
  knowledgeQueries: KnowledgeQueryReference[];
  /** Recorded durable-wiki document reads. Bodies live in referenced blobs. */
  knowledgeReads: KnowledgeReadReference[];
  /** Ordered mutation outcomes. Replay exposes references and never re-runs them. */
  knowledgeMutations: KnowledgeMutationReference[];
  /** Active plugin-set digests after each terminal lifecycle event. */
  activePluginSetDigests: string[];
  /** Sanitized model-resilience evidence, in observed order. */
  failoverPolicyDigests: string[];
  modelFailureDigests: string[];
  quotaSnapshotDigests: string[];
  failoverDecisionDigests: string[];
  routeTransitionDigests: string[];
  routeTransitionResultDigests: string[];
  /** Presence/version binding for embedded resilience facts. Omitted from
   * replay hashing when empty so historical digest-only logs stay stable. */
  modelResilienceSchemas: Array<{ seq: number; name: string; format: 1 }>;
  /** Effective sandbox networks for the modern policy+exec event format. */
  sandboxNetworkReferences: SandboxNetworkReference[];
  /** Effective network and sanitized identity of opened/closed swarm worlds. */
  swarmWorldNetworkReferences: SwarmWorldNetworkReference[];
  /** Versioned replay guarantees sealed by modern session/open rows. */
  sessionSchemas: SessionSchemaReference[];
  childSessions: ChildSessionReference[];
  swarmFinalizations: SwarmFinalizationReference[];
  /** Ordered immutable parent-to-child dispatch references. */
  swarmDispatches: SwarmDispatchReference[];
  /** Ordered immutable memory views compiled before child dispatch. */
  swarmMemoryViews: SwarmMemoryViewReferenceV1[];
  /** Ordered, digest-only parent-to-child memory transport verdicts. */
  swarmMemoryTransports: SwarmMemoryTransportReferenceV1[];
  /** Ordered host-derived child result references. */
  swarmResults: SwarmResultReference[];
  /** Ordered isolated work steps: slot, patch, child session, gate verdict. */
  workSteps: WorkStepReferenceV1[];
  /** Canonical payload digests of the model-loop contract §1 events; absent
   * in graph-loop sessions. */
  modelLoopReplay?: ModelLoopReplayReference[];
  /** #223: recorded tool-result source envelopes and exact-range reads, in
   * log order. Omitted when empty so logs without them keep their digest. */
  resultSources?: ReturnType<typeof projectResultSourceReferences>;
  semanticLivelocks: SemanticLivelockReference[];
  /** Child-side bindings to their parent dispatch contracts. */
  swarmParentBindings: SwarmParentBindingReference[];
  /** Ordered reviewer manifests bound to completed result envelopes. */
  swarmReviewInputs: SwarmReviewInputReference[];
  /** #227: the context graph's revision and digest and every recorded frame,
   * re-derived from the log (selection and exact bytes). Absent when the
   * session recorded no context-graph row, so older digests are unchanged. */
  contextGraph?: {
    revision: number;
    digest: string;
    frames: Array<{ id: string; blob: string; selection_digest: string | null; kind: string; mode: string }>;
  };
  /** sha256 over the observe+effect event sequence: gates, graph deltas, exec effects. */
  evidenceDigest: string;
  manifestDigest: string | "missing";
  graphRev: number;
}

/**
 * The replay contract (docs/replay.md): everything a replay must reproduce
 * byte-for-byte, derived purely from the recorded log. No model, no spawn,
 * no writes — replaying is a projection.
 */
export function replayContract(events: readonly EventRecord[], bodies?: EvidenceBodies): ReplayContract {
  const recovery = foldRecoveryEpisodes(events);
  projectCasePolicies(events, bodies);
  projectMeasurementPolicies(events, bodies ?? new Map());
  const experiment = projectExperimentFacts(events);
  const observations = projectObservationCoverage(events);
  const branchCheckpoints = projectBranchCheckpointReferences(events);
  const branchWorkspaces = projectBranchWorkspaceReferences(events);
  const checkpointInputImports = projectCheckpointInputImportReferences(events);
  const branchDecisions = projectBranchDecisionReferences(events,
    bodies === undefined ? undefined : retainedReaderOfBodies(bodies));
  const branchRuntime = projectBranchRuntimeReferences(events,
    bodies === undefined ? undefined : retainedReaderOfBodies(bodies));
  const providerInputs = projectProviderInputs(events, bodies);
  const acceptanceReplay = projectAcceptanceReplay(events, bodies);
  const graphState = projectGraphState(events);
  const workReplay = projectWorkReplay(events, bodies);
  assertCompactionSealed(events);
  const sessionSchema = projectSessionReplaySchemas(events);
  const authorityStart = sessionSchema.featureStart.get("work-authority-v1");
  const measurementStart = sessionSchema.featureStart.get("work-measurement-v1");
  const fixtureStart = sessionSchema.featureStart.get("managed-fixture-v1");
  const evidenceStart = sessionSchema.featureStart.get("evidence-contract-v2");
  for (const event of events) {
    if ((event.name === OBLIGATION_EVENT || event.name === AUTHORITY_EVENT)
      && (authorityStart === undefined || event.seq < authorityStart)) throw new Error("obligation row precedes its authority feature generation");
    if (event.name === "work/goal" && event.payload.digest !== "pending" && authorityStart !== undefined && event.seq >= authorityStart
      && (typeof event.payload.authority_digest !== "string" || typeof event.payload.authority_revision !== "number")) throw new Error("work binding has no obligation authority reference");
    if (isMeasurementEvent(event.name) && (measurementStart === undefined || event.seq < measurementStart)) throw new Error("measurement row precedes its feature generation");
    if (isFixtureEvent(event.name) && (fixtureStart === undefined || event.seq < fixtureStart)) throw new Error("fixture row precedes its feature generation");
    if (isEvidenceEvent(event.name) && (evidenceStart === undefined || event.seq < evidenceStart)) throw new Error("evidence row precedes its feature generation");
  }
  const earnedInputs = projectEarnedInputs(events, bodies);
  const obligationProjection = projectObligations(events);
  const evidenceProjection = projectEvidence(events, bodies);
  const fixtureProjection = projectFixtures(events, bodies);
  const measurementProjection = projectMeasurements(events, bodies);
  const swarmReferences = projectSwarmReferences(events);
  const swarmMemoryViews = projectSwarmMemoryViewReferences(events);
  const swarmMemoryTransports = projectSwarmMemoryTransportReferences(events);
  const sandboxNetworkReferences = projectSandboxNetworkReferences(
    events,
    sessionSchema.featureStart.get("sandbox-network-v1"),
  );
  const swarmWorldNetworkReferences = projectSwarmWorldNetworkReferences(
    events,
    sessionSchema.featureStart.get("swarm-world-network-v1"),
    sessionSchema.featureStart.get("swarm-world-dispatch-v1"),
    swarmReferences,
  );
  const workSteps = projectWorkStepReferences(
    events,
    sessionSchema.featureStart.get("work-step-v1"),
  );
  const semanticLivelocks = projectSemanticLivelockReferences(
    events,
    sessionSchema.featureStart.get("semantic-livelock-v1"),
  );
  const toolProfiles = projectToolProfileReferences(
    events,
    sessionSchema.featureStart.get("tool-profile-v1"),
  );
  const speculations = projectSpeculationReferences(
    events,
    sessionSchema.featureStart.get("speculation-v1"),
    sessionSchema.featureStart.get("speculation-v2"),
  );
  const speculationsV2 = projectSpeculationV2References(events, sessionSchema.featureStart.get("speculation-v2"));
  const modelLoopReplay = projectModelLoopReplay(events);
  const resultSources = projectResultSourceReferences(events);
  const contextGraph = projectContextGraphReplay(events,
    bodies === undefined ? undefined : retainedReaderOfBodies(bodies),
    bodies === undefined ? undefined : digest => {
      const value = bodies.get(digest);
      return typeof value === "string" ? value : undefined;
    });
  const transcriptHash = createHash("sha256").update(deriveMessagesBytes(events)).digest("hex");

  const prefixHashes: string[] = [];
  const toolCalls: Array<{ name: string; args_digest: string }> = [];
  const graphQueries: Array<{ query: string; result_digest: string }> = [];
  const maekQueries: MaekQueryReference[] = [];
  const knowledgeQueries: KnowledgeQueryReference[] = [];
  const knowledgeReads: KnowledgeReadReference[] = [];
  const knowledgeMutations: KnowledgeMutationReference[] = [];
  const pendingKnowledgeMutations = new Map<string, Array<Record<string, unknown>>>();
  const activePluginSetDigests: string[] = [];
  const failoverPolicyDigests: string[] = [];
  const modelFailureDigests: string[] = [];
  const quotaSnapshotDigests: string[] = [];
  const failoverDecisionDigests: string[] = [];
  const routeTransitionDigests: string[] = [];
  const routeTransitionResultDigests: string[] = [];
  const modelResilienceSchemas: Array<{ seq: number; name: string; format: 1 }> = [];
  const childSessions: ChildSessionReference[] = [];
  const swarmFinalizations: SwarmFinalizationReference[] = [];
  const evidence: Array<[number, string]> = [];
  let manifestDigest: string | "missing" = "missing";
  let graphRev = 0;

  for (const event of events) {
    if (event.name === "prompt/seal" && typeof event.payload.prefix_hash === "string") {
      prefixHashes.push(event.payload.prefix_hash);
    }
    if (event.name === "session/open" && typeof event.payload.plugin_manifest_digest === "string") {
      manifestDigest = event.payload.plugin_manifest_digest;
    }
    if (event.name === "graph/query") {
      graphQueries.push({
        query: typeof event.payload.query === "string" ? event.payload.query : "",
        result_digest: typeof event.payload.result_digest === "string" ? event.payload.result_digest : "",
      });
    }
    if (event.name === "maek/query") {
      maekQueries.push(projectMaekQueryReference(event, events, {
        featureStart: sessionSchema.featureStart.get("maek-query-v1"),
      }));
    }
    if (event.name === "knowledge/result") {
      knowledgeQueries.push({
        op: typeof event.payload.op === "string" ? event.payload.op : "",
        request_digest: typeof event.payload.request_digest === "string" ? event.payload.request_digest : "",
        result_digest: typeof event.payload.result_digest === "string" ? event.payload.result_digest : "",
      });
    }
    if (event.name === "knowledge/read_result") {
      knowledgeReads.push({
        document_id: typeof event.payload.document_id === "string" ? event.payload.document_id : "",
        request_digest: typeof event.payload.request_digest === "string" ? event.payload.request_digest : "",
        result_digest: typeof event.payload.result_digest === "string" ? event.payload.result_digest : "",
      });
    }
    const mutationEffect = /^knowledge\/(write|promote|resolve|migrate|publish)$/u.exec(event.name);
    if (event.kind === "effect" && mutationEffect) {
      const pending = pendingKnowledgeMutations.get(mutationEffect[1]!) ?? [];
      pending.push(event.payload);
      pendingKnowledgeMutations.set(mutationEffect[1]!, pending);
    }
    const mutationResult = /^knowledge\/(write|promote|resolve|migrate|publish)_result$/u.exec(event.name);
    if (event.kind === "observe" && mutationResult) {
      const op = mutationResult[1]!;
      const pending = pendingKnowledgeMutations.get(op) ?? [];
      const effect = pending.shift() ?? {};
      const documentId = firstString(
        event.payload.document_id,
        event.payload.target_id,
        effect.document_id,
        effect.target_id,
        effect.publication_digest,
      );
      knowledgeMutations.push({
        op,
        document_id: documentId,
        base_digest: firstString(effect.base_digest, "missing"),
        result_digest: firstString(event.payload.result_digest, event.payload.publication_digest, effect.result_digest, effect.content_digest, effect.publication_digest, "missing"),
        status: firstString(event.payload.status, "missing"),
        path_digest: firstString(event.payload.path_digest, effect.path_digest, effect.publication_digest, "missing"),
      });
    }
    if (
      (event.name === "plugin/load"
        || event.name === "plugin/unload"
        || event.name === "plugin/pending"
        || event.name === "plugin/skip"
        || event.name === "plugin/transition_failed")
      && typeof event.payload.active_plugin_set_digest === "string"
    ) {
      activePluginSetDigests.push(event.payload.active_plugin_set_digest);
    }
    if (event.name === "model/quota" && typeof event.payload.snapshot_digest === "string") {
      const embedded = validateQuotaSnapshotEvent(event);
      if (embedded) modelResilienceSchemas.push({ seq: event.seq, name: event.name, format: 1 });
      quotaSnapshotDigests.push(embedded ? canonicalDigest(event.payload) : event.payload.snapshot_digest);
    }
    if (event.name === "model/failover_policy" && typeof event.payload.policy_digest === "string") {
      const embedded = validateFailoverPolicyEvent(event);
      if (embedded) modelResilienceSchemas.push({ seq: event.seq, name: event.name, format: 1 });
      failoverPolicyDigests.push(embedded ? canonicalDigest(event.payload) : event.payload.policy_digest);
    }
    if (event.name === "model/failure" && typeof event.payload.failure_digest === "string") {
      const embedded = validateCanonicalFactEvent(event, {
        digestKey: "failure_digest",
        anchorKey: "class",
        allowedKeys: [
          "class",
          "detail",
          "failure_digest",
          "model",
          "reason_code",
          "retries_exhausted",
          "retry_after_seconds",
          "route",
        ],
        optionalKeys: ["detail", "retry_after_seconds"],
      });
      if (embedded) modelResilienceSchemas.push({ seq: event.seq, name: event.name, format: 1 });
      modelFailureDigests.push(embedded ? canonicalDigest(event.payload) : event.payload.failure_digest);
    }
    if (event.name === "model/failover" && typeof event.payload.decision_digest === "string") {
      const embedded = validateCanonicalFactEvent(event, {
        digestKey: "decision_digest",
        anchorKey: "candidate_summaries",
        allowedKeys: [
          "action",
          "candidate_digests",
          "candidate_summaries",
          "candidates",
          "continuity",
          "current",
          "decision_digest",
          "failure_class",
          "mode",
          "policy_digest",
          "quota_freshness",
          "reason",
          "state",
          "primary",
          "active",
          "target",
          "target_cost",
        ],
        optionalKeys: ["candidates", "quota_freshness", "target", "target_cost"],
      });
      if (embedded) modelResilienceSchemas.push({ seq: event.seq, name: event.name, format: 1 });
      failoverDecisionDigests.push(embedded ? canonicalDigest(event.payload) : event.payload.decision_digest);
    }
    if (event.name === "model/route_transition" && typeof event.payload.transition_digest === "string") {
      const embedded = validateCanonicalFactEvent(event, {
        digestKey: "transition_digest",
        anchorKey: "handoff_digest",
        allowedKeys: [
          "continuity",
          "dropped_failed_assistant",
          "failure_class",
          "from",
          "from_selection_digest",
          "generation",
          "handoff_digest",
          "policy_digest",
          "reason_code",
          "to",
          "to_selection_digest",
          "transition_digest",
        ],
      });
      if (embedded) modelResilienceSchemas.push({ seq: event.seq, name: event.name, format: 1 });
      routeTransitionDigests.push(embedded ? canonicalDigest(event.payload) : event.payload.transition_digest);
    }
    if (
      event.name === "model/route_transition_result"
      && typeof event.payload.transition_result_digest === "string"
    ) {
      const embedded = validateCanonicalFactEvent(event, {
        digestKey: "transition_result_digest",
        anchorKey: "generation",
        allowedKeys: [
          "active",
          "generation",
          "reason_code",
          "state",
          "status",
          "primary",
          "target",
          "transition_digest",
          "transition_result_digest",
        ],
        optionalKeys: ["reason_code", "target"],
      });
      if (embedded) modelResilienceSchemas.push({ seq: event.seq, name: event.name, format: 1 });
      routeTransitionResultDigests.push(embedded ? canonicalDigest(event.payload) : event.payload.transition_result_digest);
    }
    if (event.name === "swarm/child_close" && typeof event.payload.child_session === "string") {
      childSessions.push({
        session: event.payload.child_session,
        status: typeof event.payload.status === "string" ? event.payload.status : "missing",
        replay_digest: typeof event.payload.replay_digest === "string" ? event.payload.replay_digest : "missing",
        final_hash: typeof event.payload.final_hash === "string" ? event.payload.final_hash : "missing",
        graph_rev: typeof event.payload.graph_rev === "number" ? event.payload.graph_rev : "missing",
        evidence_digest: typeof event.payload.evidence_digest === "string" ? event.payload.evidence_digest : "missing",
      });
    }
    if (event.name === "swarm/finalized" && typeof event.payload.reviewer_session === "string") {
      swarmFinalizations.push({
        reviewer_session: event.payload.reviewer_session,
        patch_digest: typeof event.payload.patch_digest === "string" ? event.payload.patch_digest : "missing",
        final_tree: typeof event.payload.final_tree === "string" ? event.payload.final_tree : "missing",
      });
    }
    if (event.name === "graph/apply" && typeof event.payload.next === "number") {
      graphRev = Math.max(graphRev, event.payload.next);
    }
    if (event.kind === "observe" || event.kind === "effect") {
      evidence.push([event.seq, event.name]);
    }
  }

  // Tool calls pair tool/call with the args digest their tool/end recorded.
  const argsByCall = new Map<string, string>();
  for (const event of events) {
    if (event.name === "tool/end" && typeof event.payload.id === "string" && typeof event.payload.args_digest === "string") {
      argsByCall.set(event.payload.id, event.payload.args_digest);
    }
  }
  for (const event of events) {
    if (event.name !== "tool/call") {
      continue;
    }
    const id = typeof event.payload.id === "string" ? event.payload.id : "";
    const name = typeof event.payload.name === "string" ? event.payload.name : "";
    toolCalls.push({ name, args_digest: argsByCall.get(id) ?? "" });
  }

  const evidenceDigest = createHash("sha256").update(canonicalJson(evidence)).digest("hex");
  return {
    ...(experiment.references.length ? { experiment: experiment.references } : {}),
    ...(branchCheckpoints.length ? { branchCheckpoints } : {}),
    ...(branchWorkspaces.length ? { branchWorkspaces } : {}),
    ...(checkpointInputImports.length ? { checkpointInputImports } : {}),
    ...(branchDecisions.length ? { branchDecisions } : {}),
    ...(branchRuntime.length ? { branchRuntime } : {}),
    ...(observations.references.length ? { observations: observations.references } : {}),
    ...(providerInputs.identities.length ? { providerInputs: providerInputs.identities } : {}),
    ...(acceptanceReplay.references.length ? { acceptanceReplay: acceptanceReplay.references } : {}),
    ...(workReplay.references.length ? { workReplay: workReplay.references } : {}),
    ...(graphState.mutations.length ? { graphState: graphState.mutations } : {}),
    ...(earnedInputs.references.length ? { earnedInputs } : {}),
    obligationSnapshots: obligationProjection.snapshots.map(({ seq, value }) => ({ seq, digest: value.digest, revision: value.revision, scope_seq: value.scope_seq })),
    measurementDecisions: measurementProjection.decisions,
    measurementReferences: measurementProjection.references,
    fixturePreparations: fixtureProjection.preparations,
    fixtureReferences: fixtureProjection.references,
    evidenceInputs: evidenceProjection.inputs,
    evidenceReferences: evidenceProjection.references,
    evidenceDecisions: evidenceProjection.decisions,
    ...(recovery.length ? { recovery } : {}),
    transcriptHash,
    prefixHashes,
    toolCalls,
    toolProfiles,
    speculations,
    speculationsV2,
    graphQueries,
    maekQueries,
    knowledgeQueries,
    knowledgeReads,
    knowledgeMutations,
    activePluginSetDigests,
    failoverPolicyDigests,
    modelFailureDigests,
    quotaSnapshotDigests,
    failoverDecisionDigests,
    routeTransitionDigests,
    routeTransitionResultDigests,
    modelResilienceSchemas,
    sandboxNetworkReferences,
    swarmWorldNetworkReferences,
    sessionSchemas: sessionSchema.references,
    childSessions,
    swarmFinalizations,
    swarmDispatches: swarmReferences.dispatches,
    swarmMemoryViews,
    swarmMemoryTransports,
    swarmResults: swarmReferences.results,
    workSteps,
    ...(modelLoopReplay.references.length ? { modelLoopReplay: modelLoopReplay.references } : {}),
    ...(resultSources.sources.length || resultSources.reads.length ? { resultSources } : {}),
    ...(contextGraph ? { contextGraph } : {}),
    semanticLivelocks,
    swarmParentBindings: swarmReferences.parentBindings,
    swarmReviewInputs: swarmReferences.reviewInputs,
    evidenceDigest,
    manifestDigest,
    graphRev,
  };
}

/** #227 CG-01/CG-05: the context graph under replay — the fold must succeed
 * (a removed field, a row before its feature, a downgrade refuse) and every
 * frame must re-derive to its recorded selection and bytes. R8-03: the fold
 * reads retained branch source bundles through `retained` — a session that
 * carries branch-context rows refuses to replay without the bodies. */
function projectContextGraphReplay(events: readonly EventRecord[], retained?: RetainedBranchBodyReader,
  readContextBody?: (digest: string) => string | undefined): ReplayContract["contextGraph"] {
  if (!events.some((event) => CONTEXT_GRAPH_ROWS.has(event.name))) return undefined;
  const fold = projectContextGraph(events, retained);
  const verified = verifyContextFrames(events, readContextBody, retained);
  if (verified.mismatches.length > 0) throw new Error(`context frame replay differs: ${verified.mismatches.slice(0, 3).join("; ")}`);
  return {
    revision: fold.revision,
    digest: fold.digest,
    frames: fold.frameOrder.map((id) => {
      const row = fold.frames.get(id)!.row;
      return { id, blob: row.blob, selection_digest: row.schema === "context-graph-v1" ? row.selection_digest : null, kind: row.schema === "context-graph-v1" ? row.kind : "contribution", mode: row.mode };
    }),
  };
}

/**
 * A compaction/drop without its closing prompt/seal reason=compaction is a
 * kernel bug (docs/cache.md). Throws on the stray drop; silent when sealed
 * or when no compaction ever ran.
 */
export function assertCompactionSealed(events: readonly EventRecord[]): void {
  let openStartSeq = -1;
  let strayDropSeq = -1;
  for (const event of events) {
    if (event.name === "compaction/start" && event.payload.reason !== "in_turn") {
      if (openStartSeq >= 0) {
        throw new Error(`compaction/start at seq ${openStartSeq} was never closed`);
      }
      openStartSeq = event.seq;
    }
    if (event.name === "compaction/drop" && event.payload.in_turn !== true) {
      strayDropSeq = event.seq;
    }
    if (event.name === "compaction/end" && openStartSeq >= 0) {
      if (event.payload.status === "nothing_to_drop" || event.payload.status === "recovered") {
        openStartSeq = -1;
      }
    }
    if (event.name === "prompt/seal" && event.payload.reason === "compaction") {
      strayDropSeq = -1;
      openStartSeq = -1;
    }
  }
  if (strayDropSeq >= 0) {
    throw new Error(`compaction/drop at seq ${strayDropSeq} has no closing prompt/seal reason=compaction`);
  }
  if (openStartSeq >= 0) {
    throw new Error(`compaction/start at seq ${openStartSeq} was never closed`);
  }
}

/** One hash to expect: covers every contract field. */
export function replayDigest(contract: ReplayContract): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ...(contract.recovery?.length ? { recovery: contract.recovery } : {}),
        ...(contract.measurementReferences?.length ? { measurementReferences: contract.measurementReferences } : {}),
        ...(contract.obligationSnapshots?.length ? { obligationSnapshots: contract.obligationSnapshots } : {}),
        ...(contract.experiment?.length ? { experiment: contract.experiment } : {}),
        ...(contract.branchCheckpoints?.length ? { branchCheckpoints: contract.branchCheckpoints } : {}),
        ...(contract.branchWorkspaces?.length ? { branchWorkspaces: contract.branchWorkspaces } : {}),
        ...(contract.checkpointInputImports?.length ? { checkpointInputImports: contract.checkpointInputImports } : {}),
        ...(contract.branchDecisions?.length ? { branchDecisions: contract.branchDecisions } : {}),
        ...(contract.branchRuntime?.length ? { branchRuntime: contract.branchRuntime } : {}),
        ...(contract.observations?.length ? { observations: contract.observations } : {}),
        ...(contract.providerInputs?.length ? { providerInputs: contract.providerInputs } : {}),
        ...(contract.acceptanceReplay?.length ? { acceptanceReplay: contract.acceptanceReplay } : {}),
        ...(contract.workReplay?.length ? { workReplay: contract.workReplay } : {}),
        ...(contract.graphState?.length ? { graphState: contract.graphState } : {}),
        ...(contract.contextGraph ? { contextGraph: contract.contextGraph } : {}),
        ...(contract.earnedInputs?.references.length ? { earnedInputs: contract.earnedInputs } : {}),
        ...(contract.measurementDecisions?.length ? { measurementDecisions: contract.measurementDecisions } : {}),
        ...(contract.fixtureReferences?.length ? { fixtureReferences: contract.fixtureReferences } : {}),
        ...(contract.fixturePreparations?.length ? { fixturePreparations: contract.fixturePreparations } : {}),
        ...(contract.evidenceReferences?.length ? { evidenceReferences: contract.evidenceReferences } : {}),
        ...(contract.evidenceInputs?.length ? { evidenceInputs: contract.evidenceInputs } : {}),
        ...(contract.evidenceDecisions?.length ? { evidenceDecisions: contract.evidenceDecisions } : {}),
        transcriptHash: contract.transcriptHash,
        prefixHashes: contract.prefixHashes,
        toolCalls: contract.toolCalls,
        ...(contract.toolProfiles.length > 0 ? { toolProfiles: contract.toolProfiles } : {}),
        ...(contract.speculations.length > 0 ? { speculations: contract.speculations } : {}),
        ...(contract.speculationsV2?.length ? { speculationsV2: contract.speculationsV2 } : {}),
        graphQueries: contract.graphQueries,
        ...(contract.maekQueries.length > 0 ? { maekQueries: contract.maekQueries } : {}),
        ...(contract.knowledgeQueries.length > 0 ? { knowledgeQueries: contract.knowledgeQueries } : {}),
        ...(contract.knowledgeReads.length > 0 ? { knowledgeReads: contract.knowledgeReads } : {}),
        ...(contract.knowledgeMutations.length > 0 ? { knowledgeMutations: contract.knowledgeMutations } : {}),
        ...(contract.activePluginSetDigests.length > 0
          ? { activePluginSetDigests: contract.activePluginSetDigests }
          : {}),
        ...(contract.failoverPolicyDigests.length > 0
          ? { failoverPolicyDigests: contract.failoverPolicyDigests }
          : {}),
        ...(contract.modelFailureDigests.length > 0
          ? { modelFailureDigests: contract.modelFailureDigests }
          : {}),
        ...(contract.quotaSnapshotDigests.length > 0
          ? { quotaSnapshotDigests: contract.quotaSnapshotDigests }
          : {}),
        ...(contract.failoverDecisionDigests.length > 0
          ? { failoverDecisionDigests: contract.failoverDecisionDigests }
          : {}),
        ...(contract.routeTransitionDigests.length > 0
          ? { routeTransitionDigests: contract.routeTransitionDigests }
          : {}),
        ...(contract.routeTransitionResultDigests.length > 0
          ? { routeTransitionResultDigests: contract.routeTransitionResultDigests }
          : {}),
        ...(contract.modelResilienceSchemas.length > 0
          ? { modelResilienceSchemas: contract.modelResilienceSchemas }
          : {}),
        ...(contract.sandboxNetworkReferences.length > 0
          ? { sandboxNetworkReferences: contract.sandboxNetworkReferences }
          : {}),
        ...(contract.swarmWorldNetworkReferences.length > 0
          ? { swarmWorldNetworkReferences: contract.swarmWorldNetworkReferences }
          : {}),
        ...(contract.sessionSchemas.length > 0
          ? { sessionSchemas: contract.sessionSchemas }
          : {}),
        ...(contract.childSessions.length > 0 ? { childSessions: contract.childSessions } : {}),
        ...(contract.swarmFinalizations.length > 0 ? { swarmFinalizations: contract.swarmFinalizations } : {}),
        ...(contract.swarmDispatches.length > 0 ? { swarmDispatches: contract.swarmDispatches } : {}),
        ...(contract.swarmMemoryViews.length > 0 ? { swarmMemoryViews: contract.swarmMemoryViews } : {}),
        ...(contract.swarmMemoryTransports.length > 0
          ? { swarmMemoryTransports: contract.swarmMemoryTransports }
          : {}),
        ...(contract.swarmResults.length > 0 ? { swarmResults: contract.swarmResults } : {}),
        ...(contract.swarmParentBindings.length > 0
          ? { swarmParentBindings: contract.swarmParentBindings }
          : {}),
        ...(contract.swarmReviewInputs.length > 0 ? { swarmReviewInputs: contract.swarmReviewInputs } : {}),
        ...(contract.workSteps.length > 0 ? { workSteps: contract.workSteps } : {}),
        ...(contract.modelLoopReplay?.length ? { modelLoopReplay: contract.modelLoopReplay } : {}),
        ...(contract.resultSources ? { resultSources: contract.resultSources } : {}),
        ...(contract.semanticLivelocks.length > 0
          ? { semanticLivelocks: contract.semanticLivelocks }
          : {}),
        evidenceDigest: contract.evidenceDigest,
        manifestDigest: contract.manifestDigest,
        graphRev: contract.graphRev,
      }),
    )
    .digest("hex");
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? "missing";
}

/** Explicit derivation name for consumers that want to emphasize no live
 * provider work occurs. Kept as an alias to the canonical replay contract. */
export const deriveReplayContract = replayContract;

function deriveMessagesBytes(events: readonly EventRecord[]): string {
  return `${JSON.stringify(deriveMessages(events))}\n`;
}

function validateFailoverPolicyEvent(event: EventRecord): boolean {
  if (event.payload.policy === undefined) return false; // legacy digest-only row
  assertExactKeys(event.payload, [
    "active",
    "candidate_count",
    "continuity",
    "mode",
    "next_state",
    "policy",
    "policy_digest",
    "primary",
  ], "model failover policy");
  const normalized = normalizeFailoverPolicyV1(event.payload.policy);
  if (canonicalJson(normalized) !== canonicalJson(event.payload.policy)) {
    throw new Error("model failover policy event is not canonical");
  }
  if (failoverPolicyDigest(normalized) !== event.payload.policy_digest) {
    throw new Error("model failover policy digest mismatch");
  }
  if (
    event.payload.mode !== normalized.mode
    || event.payload.continuity !== normalized.continuity
    || event.payload.candidate_count !== normalized.candidates.length
  ) {
    throw new Error("model failover policy wrapper mismatch");
  }
  const primary = replaySelection(event.payload.primary, "model failover policy primary");
  const active = replaySelection(event.payload.active, "model failover policy active");
  const nextState = normalized.mode === "off"
    ? "DISABLED"
    : sameSelection(primary, active)
      ? "ARMED"
      : "FALLBACK_ACTIVE";
  if (event.payload.next_state !== nextState) {
    throw new Error("model failover policy next state mismatch");
  }
  return true;
}

function validateQuotaSnapshotEvent(event: EventRecord): boolean {
  const snapshot = event.observe?.model_quota_snapshot as unknown;
  if (!isRecord(snapshot) || snapshot.format !== 1) return false; // legacy snapshot or digest-only row
  assertExactKeys(event.payload, [
    "bucket",
    "freshness",
    "model",
    "provider",
    "route",
    "snapshot_digest",
  ], "model quota snapshot");
  if (canonicalDigest(snapshot) !== event.payload.snapshot_digest) {
    throw new Error("model quota snapshot digest mismatch");
  }
  const selection = {
    provider: replayPublicId(snapshot.provider, "model quota provider"),
    route: replayPublicId(snapshot.route, "model quota route"),
    model: replayPublicId(snapshot.model, "model quota model"),
  };
  const eventTime = Date.parse(event.ts);
  const normalized = normalizeQuotaSnapshotV1(
    snapshot as unknown as ModelQuotaSnapshot,
    selection,
    Number.isFinite(eventTime) ? eventTime : 0,
  );
  if (canonicalJson(normalized) !== canonicalJson(snapshot)) {
    throw new Error("model quota snapshot is not canonical");
  }
  if (
    event.payload.provider !== normalized.provider
    || event.payload.route !== normalized.route
    || event.payload.model !== normalized.model
    || event.payload.bucket !== normalized.bucketDigest
  ) {
    throw new Error("model quota snapshot wrapper mismatch");
  }
  const freshness = quotaSnapshotFreshness(normalized, Number.isFinite(eventTime) ? eventTime : 0);
  if (event.payload.freshness !== freshness) {
    throw new Error("model quota snapshot freshness mismatch");
  }
  return true;
}

function validateCanonicalFactEvent(
  event: EventRecord,
  input: {
    digestKey: string;
    anchorKey: string;
    allowedKeys: readonly string[];
    optionalKeys?: readonly string[];
  },
): boolean {
  if (!(input.anchorKey in event.payload)) return false; // legacy digest-only row
  assertExactKeys(event.payload, input.allowedKeys, event.name, input.optionalKeys);
  const fact = Object.fromEntries(
    Object.entries(event.payload).filter(([key]) => key !== input.digestKey),
  );
  if (canonicalDigest(fact) !== event.payload[input.digestKey]) {
    throw new Error(`${event.name} embedded digest mismatch`);
  }
  return true;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort();
  const optionalSet = new Set(optional);
  const expected = [...allowed]
    .filter((key) => key in value || !optionalSet.has(key))
    .sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function replayNetwork(value: unknown, label: string): "allow" | "deny" {
  if (value !== "allow" && value !== "deny") {
    throw new Error(`${label} network must be allow or deny`);
  }
  return value;
}

function replayDigestField(value: unknown, label: string, lengths: readonly number[]): string {
  if (
    typeof value !== "string"
    || !lengths.includes(value.length)
    || !/^[a-f0-9]+$/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function featureRequired(startSeq: number | undefined, eventSeq: number): boolean {
  return startSeq !== undefined && eventSeq > startSeq;
}

/**
 * Old logs recorded `sandbox/policy.network` but not the effective network on
 * `sandbox/exec`. The sealed feature marker disambiguates new rows even if an
 * attacker removes both fields; unmarked historical rows keep their digest.
 */
function projectSandboxNetworkReferences(
  events: readonly EventRecord[],
  featureStart: number | undefined,
): SandboxNetworkReference[] {
  const references: SandboxNetworkReference[] = [];
  let activePolicy: {
    readonly digest: string;
    readonly fact: Pick<SandboxNetworkReference, "backend" | "mode" | "network" | "policy_fact_digest">;
  } | undefined;
  for (const event of events) {
    if (event.name !== "sandbox/policy" && event.name !== "sandbox/exec") continue;
    const required = featureRequired(featureStart, event.seq);
    if (required && !("network" in event.payload)) {
      throw new Error(`replay feature sandbox-network-v1 requires ${event.name}.network`);
    }
    // Field presence did not version predecessor logs. Only a preceding
    // session/open feature marker opts rows into the exact modern projection.
    if (!required) continue;
    const policyDigest = typeof event.payload.digest === "string" ? event.payload.digest : "";
    const checkedDigest = replayDigestField(policyDigest, "sandbox policy digest", [16, 64]);
    const fact = replaySandboxPolicyFact(event.payload, event.name.replace("/", " "));
    if (event.name === "sandbox/policy") {
      if (event.kind !== "observe") throw new Error("sandbox policy event kind mismatch");
      assertExactKeys(event.payload, [
        "backend",
        "digest",
        "mode",
        "network",
        "workspace_root",
      ], "sandbox policy");
      replayPublicId(event.payload.workspace_root, "sandbox policy workspace root");
      activePolicy = { digest: checkedDigest, fact };
    } else {
      if (event.kind !== "effect") throw new Error("sandbox execution event kind mismatch");
      assertSandboxExecutionPayload(event.payload);
      if (!activePolicy) {
        throw new Error("sandbox execution has no preceding active policy");
      }
      if (activePolicy.digest !== checkedDigest) {
        throw new Error("sandbox execution does not match its active policy digest");
      }
      if (activePolicy.fact.network !== fact.network) {
        throw new Error("sandbox network policy mismatch");
      }
      if (canonicalJson(activePolicy.fact) !== canonicalJson(fact)) {
        throw new Error("sandbox execution does not match its active policy fact");
      }
    }
    references.push({
      seq: event.seq,
      name: event.name,
      ...fact,
      policy_digest: checkedDigest,
    });
  }
  return references;
}

function assertSandboxExecutionPayload(payload: Record<string, unknown>): void {
  const common = ["backend", "digest", "mode", "network"] as const;
  if (typeof payload.tool === "string") {
    assertExactKeys(payload, [...common, "args_digest", "tool"], "sandbox execution");
    replayDigestField(payload.args_digest, "sandbox execution args digest", [16, 64]);
    return;
  }
  if (payload.shell === "direct") {
    assertExactKeys(payload, [...common, "command_digest", "shell"], "sandbox execution");
    replayDigestField(payload.command_digest, "sandbox execution command digest", [16, 64]);
    return;
  }
  if (payload.shell !== "workspace-tools/bash") {
    throw new Error("sandbox execution source is invalid");
  }
  assertExactKeys(
    payload,
    [...common, "attempt", "background", "handle", "observer", "probe_id", "shell"],
    "sandbox execution",
    ["attempt", "handle", "observer", "probe_id"],
  );
  if (typeof payload.background !== "boolean") {
    throw new Error("sandbox execution background must be boolean");
  }
  if (
    (payload.background === true && (typeof payload.handle !== "string" || payload.handle.length === 0))
    || (payload.background === false && payload.handle !== undefined)
  ) {
    throw new Error("sandbox execution background handle evidence is invalid");
  }
  if (payload.observer === undefined) {
    if (payload.attempt !== undefined || payload.probe_id !== undefined) {
      throw new Error("sandbox execution observation fields require an observer");
    }
    return;
  }
  if (payload.background) {
    throw new Error("sandbox execution observer cannot be backgrounded");
  }
  if (payload.observer === "bash_wait") {
    if (!Number.isInteger(payload.attempt) || Number(payload.attempt) < 1 || payload.probe_id !== undefined) {
      throw new Error("sandbox wait execution evidence is invalid");
    }
    return;
  }
  if (payload.observer === "bash_probe") {
    if (typeof payload.probe_id !== "string" || payload.probe_id.length === 0 || payload.attempt !== undefined) {
      throw new Error("sandbox probe execution evidence is invalid");
    }
    return;
  }
  throw new Error("sandbox execution observer is invalid");
}

function replaySandboxPolicyFact(
  payload: Record<string, unknown>,
  label: string,
): Pick<SandboxNetworkReference, "backend" | "mode" | "network" | "policy_fact_digest"> {
  if (payload.backend !== "bwrap" && payload.backend !== "docker" && payload.backend !== "seatbelt" && payload.backend !== "none") {
    throw new Error(`${label} backend is invalid`);
  }
  if (payload.mode !== "workspace-write" && payload.mode !== "read-only" && payload.mode !== "envfix") {
    throw new Error(`${label} mode is invalid`);
  }
  const fact = {
    backend: payload.backend,
    mode: payload.mode,
    network: replayNetwork(payload.network, label),
  } as const;
  return { ...fact, policy_fact_digest: canonicalDigest(fact) };
}

function projectSwarmWorldNetworkReferences(
  events: readonly EventRecord[],
  networkFeatureStart: number | undefined,
  dispatchFeatureStart: number | undefined,
  swarmReferences: SwarmReferenceProjection,
): SwarmWorldNetworkReference[] {
  type WorldFact = Omit<SwarmWorldNetworkReference, "seq" | "name">;
  const dispatchFacts = new Map<string, { readonly seq: number; readonly fact: PublicSwarmWorldFactV1 }>();
  for (const event of events) {
    if (event.name !== "swarm/dispatch") continue;
    const required = featureRequired(dispatchFeatureStart, event.seq);
    const hasFact = event.payload.world_fact !== undefined;
    const hasDigest = event.payload.world_fact_digest !== undefined;
    if (hasFact !== hasDigest) throw new Error("swarm dispatch public world binding is incomplete");
    if (!hasFact) {
      if (required) throw new Error("replay feature swarm-world-dispatch-v1 requires a dispatch world fact");
      continue;
    }
    assertPublicSwarmWorldFact(event.payload.world_fact);
    const fact = event.payload.world_fact;
    const factDigest = publicSwarmWorldFactDigest(fact);
    if (event.payload.world_fact_digest !== factDigest) {
      throw new Error("swarm dispatch public world fact digest mismatch");
    }
    const child = replayPublicId(event.payload.child_session, "dispatch child session");
    const dispatch = swarmReferences.dispatchByChild.get(child);
    if (!dispatch || dispatch.contract.worldDigest !== factDigest) {
      throw new Error("swarm dispatch world fact does not match its contract");
    }
    dispatchFacts.set(child, { seq: event.seq, fact });
  }

  const factByChild = new Map<string, WorldFact>();
  const childByDigest = new Map<string, string>();
  for (const event of events) {
    if (event.name === "swarm/world_open" || event.name === "swarm/world_close") {
      const required = featureRequired(networkFeatureStart, event.seq);
      if (required && !("network" in event.payload)) {
        throw new Error(`replay feature swarm-world-network-v1 requires ${event.name}.network`);
      }
      if (!("network" in event.payload)) continue;
      const childSession = replayPublicId(event.payload.child_session, "swarm child session");
      const childSessionDigest = createHash("sha256").update(childSession).digest("hex");
      childByDigest.set(childSessionDigest, childSession);
      const worldIdDigest = replayDigestField(event.payload.world_id_digest, "swarm world id digest", [64]);
      if (event.payload.world !== "local" && event.payload.world !== "docker") {
        throw new Error("swarm world kind is invalid");
      }
      assertExactKeys(
        event.payload,
        event.payload.world === "docker"
          ? [
              "child_session",
              "git_metadata",
              "image_digest",
              "network",
              "world",
              "world_id_digest",
            ]
          : ["child_session", "network", "world", "world_id_digest"],
        "swarm world effect",
        event.payload.world === "docker" ? ["git_metadata"] : [],
      );
      const network = replayNetwork(event.payload.network, "swarm world");
      const imageDigest = event.payload.world === "docker"
        ? replayDigestField(event.payload.image_digest, "swarm world image digest", [64])
        : "missing";
      const gitMetadata = event.payload.git_metadata === undefined
        ? "missing"
        : event.payload.git_metadata === "common-read-only"
          ? "common-read-only"
          : undefined;
      if (!gitMetadata) throw new Error("swarm world Git metadata is invalid");
      const fact: WorldFact = {
        world: event.payload.world,
        network,
        child_session_digest: childSessionDigest,
        world_id_digest: worldIdDigest,
        image_digest: imageDigest,
        git_metadata: gitMetadata,
      };
      const prior = factByChild.get(childSessionDigest);
      if (prior !== undefined && prior.network !== fact.network) {
        throw new Error("swarm world network lease mismatch");
      }
      if (prior !== undefined && canonicalJson(prior) !== canonicalJson(fact)) {
        throw new Error("swarm world lifecycle identity mismatch");
      }
      factByChild.set(childSessionDigest, fact);
    }
  }

  const lifecycle = new Set([
    "swarm/world_open",
    "swarm/world_ready",
    "swarm/world_close",
    "swarm/world_closed",
    "swarm/world_failed",
  ]);
  type LifecycleState =
    | "expect_open"
    | "after_open"
    | "after_allocated_open_failure"
    | "after_ready"
    | "after_close"
    | "terminal";
  const stateByChild = new Map<string, LifecycleState>();
  const references: SwarmWorldNetworkReference[] = [];
  for (const event of events) {
    if (!lifecycle.has(event.name)) continue;
    if (typeof event.payload.child_session !== "string") {
      if ("network" in event.payload || event.name === "swarm/world_failed") {
        throw new Error("swarm world lifecycle child is invalid");
      }
      continue;
    }
    const childSession = event.payload.child_session;
    const childSessionDigest = createHash("sha256").update(childSession).digest("hex");
    const fact = factByChild.get(childSessionDigest);
    if (!fact) {
      if (event.name === "swarm/world_failed" || featureRequired(networkFeatureStart, event.seq)) {
        throw new Error("replay feature swarm-world-network-v1 requires a network-bound lifecycle");
      }
      continue; // historical lifecycle: no network-bearing effect row
    }
    replayPublicId(childSession, "swarm child session");
    if (event.name === "swarm/world_ready" || event.name === "swarm/world_closed") {
      assertExactKeys(
        event.payload,
        ["child_session", "world_id_digest"],
        "swarm world observation",
      );
    }
    const observedWorldId = replayDigestField(
      event.payload.world_id_digest,
      "swarm world lifecycle id digest",
      [64],
    );
    if (observedWorldId !== fact.world_id_digest) {
      throw new Error("swarm world lifecycle digest mismatch");
    }
    if (event.name === "swarm/world_open" || event.name === "swarm/world_close") {
      if (
        event.payload.world !== fact.world
        || replayNetwork(event.payload.network, "swarm world") !== fact.network
        || (fact.world === "docker"
          && replayDigestField(event.payload.image_digest, "swarm world image digest", [64]) !== fact.image_digest)
        || (event.payload.git_metadata ?? "missing") !== fact.git_metadata
      ) {
        throw new Error("swarm world lifecycle effect mismatch");
      }
    }

    const expectedKind = event.name === "swarm/world_open" || event.name === "swarm/world_close"
      ? "effect"
      : "observe";
    if (event.kind !== expectedKind) {
      throw new Error("swarm world lifecycle event kind mismatch");
    }

    const state = stateByChild.get(childSessionDigest) ?? "expect_open";
    let next: LifecycleState;
    let failure: Pick<
      SwarmWorldNetworkReference,
      "failure_phase" | "failure_reason" | "allocation"
    > = {};
    if (state === "expect_open" && event.name === "swarm/world_open") {
      next = "after_open";
    } else if (state === "after_open" && event.name === "swarm/world_ready") {
      next = "after_ready";
    } else if (state === "after_open" && event.name === "swarm/world_failed") {
      failure = replayWorldFailure(event.payload, "open");
      next = failure.allocation === "allocated" ? "after_allocated_open_failure" : "terminal";
    } else if (
      (state === "after_ready" || state === "after_allocated_open_failure")
      && event.name === "swarm/world_close"
    ) {
      next = "after_close";
    } else if (state === "after_close" && event.name === "swarm/world_closed") {
      next = "terminal";
    } else if (state === "after_close" && event.name === "swarm/world_failed") {
      failure = replayWorldFailure(event.payload, "close");
      next = "terminal";
    } else {
      throw new Error("swarm world lifecycle order or duplicate mismatch");
    }
    references.push({ seq: event.seq, name: event.name, ...fact, ...failure });
    stateByChild.set(childSessionDigest, next);
  }
  for (const childSessionDigest of factByChild.keys()) {
    if (stateByChild.get(childSessionDigest) !== "terminal") {
      throw new Error("swarm world lifecycle is incomplete");
    }
    const child = childByDigest.get(childSessionDigest);
    if (!child) throw new Error("swarm world lifecycle child binding is missing");
    const lifecycleFact = factByChild.get(childSessionDigest)!;
    const publicFact: PublicSwarmWorldFactV1 = lifecycleFact.world === "local"
      ? { kind: "local", network: lifecycleFact.network }
      : {
          kind: "docker",
          network: lifecycleFact.network,
          image_digest: lifecycleFact.image_digest,
        };
    const dispatch = dispatchFacts.get(child);
    const lifecycleFirstSeq = references.find((reference) =>
      reference.child_session_digest === childSessionDigest
    )?.seq ?? 0;
    if (!dispatch && featureRequired(dispatchFeatureStart, lifecycleFirstSeq)) {
      throw new Error("swarm world lifecycle has no dispatch world binding");
    }
    if (dispatch && canonicalJson(dispatch.fact) !== canonicalJson(publicFact)) {
      throw new Error("swarm dispatch world does not match the child lifecycle");
    }
  }
  for (const [child, dispatch] of dispatchFacts) {
    if (!featureRequired(dispatchFeatureStart, dispatch.seq)) continue;
    const childDigest = createHash("sha256").update(child).digest("hex");
    if (!factByChild.has(childDigest)) {
      throw new Error("swarm dispatch world has no child lifecycle");
    }
  }
  return references;
}

function replayWorldFailure(
  payload: Record<string, unknown>,
  expectedPhase: "open" | "close",
): Pick<
  SwarmWorldNetworkReference,
  "failure_phase" | "failure_reason" | "allocation"
> {
  assertExactKeys(payload, [
    "allocation",
    "child_session",
    "phase",
    "reason",
    "world_id_digest",
  ], "swarm world failure");
  if (payload.phase !== expectedPhase) {
    throw new Error("swarm world failure phase does not match its lifecycle");
  }
  if (payload.reason !== "provider_error" && payload.reason !== "invalid_lease") {
    throw new Error("swarm world failure reason is invalid");
  }
  if (payload.allocation !== "unallocated" && payload.allocation !== "allocated") {
    throw new Error("swarm world failure allocation state is invalid");
  }
  if (expectedPhase === "close" && (
    payload.reason !== "provider_error" || payload.allocation !== "allocated"
  )) {
    throw new Error("swarm world close failure is not enforceable");
  }
  return {
    failure_phase: expectedPhase,
    failure_reason: payload.reason,
    allocation: payload.allocation,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaySelection(value: unknown, label: string): { route: string; model: string } {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  assertExactKeys(value, ["model", "route"], label);
  return {
    route: replayPublicId(value.route, `${label} route`),
    model: replayPublicId(value.model, `${label} model`),
  };
}

function replayPublicId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sameSelection(
  left: { route: string; model: string },
  right: { route: string; model: string },
): boolean {
  return left.route === right.route && left.model === right.model;
}
