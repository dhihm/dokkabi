import { join } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import type {
  HostContext,
  LlmFacade,
  SwarmMemoryContributionRegistry,
} from "../loader/types.ts";
import { renderPrompt } from "../work/prompt-slots.ts";
import {
  type CandidateArtifact,
  type CandidateArtifactDraft,
  reviewInputManifest,
} from "./artifact.ts";
import type { SwarmCapabilityProfileV1 } from "./contract.ts";
import { swarmChildToolSchemaDigest } from "./child-capability.ts";
import {
  createSwarmChildPrivateHome,
  stageSwarmChildRouteAuthority,
} from "./child-environment.ts";
import { runSwarmChild } from "./child-runner.ts";
import { recordMarketRecipe } from "../market/recipe.ts";
import { defaultSwarmDependencies, type SwarmDependencies } from "./dependencies.ts";
import { appendSwarmStart } from "./events.ts";
import { appendSwarmMemoryView } from "./memory-transport.ts";
import {
  appendFinalized,
  appendFinalizeEffect,
  appendReviewInputEffect,
  appendReviewPlan,
  appendReviewSeed,
  appendSwarmArtifact,
} from "./pipeline-events.ts";
import {
  parseSwarmCandidateRoles,
  resolveSwarmRouteMap,
  SWARM_CANDIDATE_ROLES,
  SWARM_REVIEWER_ROLE,
  validateSwarmRoutes,
  type SwarmAssignment,
  type SwarmCandidateRole,
} from "./routes.ts";
import { appendAgentStatus, failedSwarmResult, finishSwarm } from "./result.ts";
import type { SwarmRunRequest, SwarmRunResult, SwarmService } from "./types.ts";

export type { ChildContractEvidence, ChildContractRequest } from "./child-contract.ts";
export type { SwarmRunRequest, SwarmRunResult, SwarmService } from "./types.ts";
export { defaultSwarmDependencies, type SwarmDependencies } from "./dependencies.ts";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isCandidateAssignment(
  assignment: SwarmAssignment,
): assignment is SwarmAssignment & { readonly role: SwarmCandidateRole } {
  return SWARM_CANDIDATE_ROLES.some((role) => role === assignment.role);
}

function sessionManifestDigest(ctx: HostContext): string {
  const value = [...ctx.log.events].reverse().find((event) =>
    event.name === "session/open" && typeof event.payload.plugin_manifest_digest === "string"
  )?.payload.plugin_manifest_digest;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("swarm requires a recorded plugin manifest digest");
  }
  return value;
}

function capabilityProfile(
  ctx: HostContext,
  facade: LlmFacade,
  assignment: SwarmAssignment,
  toolSchemaDigest: string,
): SwarmCapabilityProfileV1 {
  const route = facade.routes.get(assignment.route);
  if (!route) throw new Error(`swarm route ${assignment.route} disappeared after validation`);
  return {
    format: 1,
    pluginManifestDigest: sessionManifestDigest(ctx),
    toolSchemaDigest,
    route: assignment.route,
    providerId: route.providerId,
    authKind: route.authKind,
    hasNetwork: route.hasNetwork,
  };
}

export function createSwarmService(ctx: HostContext, deps: SwarmDependencies): SwarmService {
  return {
    async run(request) {
      const facade: LlmFacade | undefined = ctx.llm;
      if (!facade) throw new Error("swarm requires the llm capability");
      const candidates = request.candidates ? [...request.candidates] : parseSwarmCandidateRoles();
      const childRuntimeEnv = { ...process.env, ...(request.effort ? { DOKKABI_EFFORT: request.effort } : {}) };
      // A recipe's named routes overlay the ambient map for the roles it
      // names (#60 T2); everything still goes through route validation —
      // the recipe is data, never a branch (constitution 7).
      const assignments = await validateSwarmRoutes(
        facade,
        [...candidates, SWARM_REVIEWER_ROLE],
        { ...resolveSwarmRouteMap(), ...(request.routes ?? {}) },
      );
      if (request.recipe) {
        recordMarketRecipe(ctx.log, {
          ...request.recipe,
          applied: ["candidates", "routes", "world", "max_steps"],
        });
      }
      const recipeDigest = request.recipe?.digest;
      const candidateAssignments = assignments.filter(isCandidateAssignment);
      const reviewerAssignment = assignments.find((assignment) => assignment.role === SWARM_REVIEWER_ROLE);
      if (!reviewerAssignment) throw new Error("swarm reviewer route is missing");
      const memoryRegistry = ctx.tryGet<SwarmMemoryContributionRegistry>("swarm_memory_contributions");
      if (!memoryRegistry) throw new Error("swarm requires the memory contribution registry");
      const childToolSchemaDigest = swarmChildToolSchemaDigest(ctx.toolSchemas);
      appendAgentStatus(ctx.log, "running");
      ctx.log.append({ kind: "effect", name: "swarm/snapshot", payload: { workspace: ctx.workspaceRoot } });
      const base = deps.capture(ctx.workspaceRoot);
      appendSwarmStart(ctx.log, {
        parentSession: ctx.sessionId,
        roles: [...candidates, SWARM_REVIEWER_ROLE],
        snapshotDigest: base.digest,
      });
      const repositoryDigest = deps.repositoryDigest(base.sourceRoot);
      const memoryView = await memoryRegistry.compile({
        repositoryDigest,
        sourceSnapshotDigest: base.digest,
        purpose: request.order,
      });
      appendSwarmMemoryView(ctx.log, memoryView);
      const nonce = deps.nonce();
      const signal = request.signal ?? new AbortController().signal;
      const parentAuthPath = deps.parentAuthPath();
      const root = join(deps.homeRoot(), "swarm", safeSegment(ctx.sessionId), nonce);
      const candidateTrees = candidateAssignments.map((assignment) => {
        const sessionId = `${ctx.sessionId}-swarm-${assignment.role}-${nonce}`;
        const target = join(root, assignment.role);
        ctx.log.append({
          kind: "effect",
          name: "swarm/worktree",
          payload: {
            child_session: sessionId,
            role: assignment.role,
            target,
            runtime_digest: base.runtimeArtifacts.digest,
          },
        });
        return {
          assignment,
          sessionId,
          tree: deps.allocate(base, target),
          privateHome: createSwarmChildPrivateHome(root, sessionId),
        };
      });
      const candidateRuns = await Promise.all(candidateTrees.map(async ({ assignment, sessionId, tree, privateHome }) => {
        let artifactDraft: CandidateArtifactDraft | undefined;
        const profile = capabilityProfile(ctx, facade, assignment, childToolSchemaDigest);
        const routeAuthority = await stageSwarmChildRouteAuthority({
          route: assignment.route,
          providerId: profile.providerId,
          privateHome,
          runtimeEnv: childRuntimeEnv,
          parentAuthPath,
        });
        const outcome = await runSwarmChild({
          log: ctx.log,
          parentSessionId: ctx.sessionId,
          assignment,
          sessionId,
          workspaceRoot: tree.root,
          order: request.order,
          maxSteps: request.maxSteps,
          timeoutMs: request.timeoutMs,
          world: request.world,
          signal,
          deferAcceptance: true,
          sourceSnapshotDigest: tree.snapshotDigest,
          capabilityProfile: profile,
          memoryView,
          privateHome,
          runtimeEnv: childRuntimeEnv,
          ...(routeAuthority ? { routeAuthority } : {}),
          ...(recipeDigest ? { recipeDigest } : {}),
          acceptanceOwner: "parent_reviewer",
          complete(evidence) {
            artifactDraft = deps.artifact({
              base,
              workspaceRoot: tree.root,
              role: assignment.role,
              route: assignment.route,
              evidence,
            });
            return { patchDigest: artifactDraft.delta.patchDigest };
          },
        }, deps);
        return { outcome, artifactDraft };
      }));
      const outcomes = candidateRuns.map((run) => run.outcome);
      const artifacts: CandidateArtifact[] = [];
      for (const run of candidateRuns) {
        const { outcome, artifactDraft } = run;
        if (!outcome.evidence || !artifactDraft || outcome.report.status !== "completed" ||
          outcome.evidence.planDigest === "missing") continue;
        const artifact: CandidateArtifact = {
          ...artifactDraft,
          dispatchDigest: outcome.dispatchDigest,
          resultEnvelopeDigest: outcome.resultEnvelopeDigest,
          planDigest: outcome.evidence.planDigest,
        };
        artifacts.push(artifact);
        appendSwarmArtifact(ctx.log, {
          childSession: artifact.sessionId,
          role: artifact.role,
          patchDigest: artifact.delta.patchDigest,
          summaryDigest: artifact.summaryDigest,
          dispatchDigest: artifact.dispatchDigest,
          resultEnvelopeDigest: artifact.resultEnvelopeDigest,
          planDigest: artifact.planDigest,
        });
      }
      if (signal.aborted) {
        finishSwarm(ctx.log, {
          parentSession: ctx.sessionId,
          status: "cancelled",
          candidateCompleted: artifacts.length,
          candidateTotal: candidates.length,
          reviewerStatus: "missing",
          finalized: false,
        });
        return { ...failedSwarmResult(ctx.sessionId, outcomes), status: "cancelled" };
      }
      if (artifacts.length === 0) {
        finishSwarm(ctx.log, {
          parentSession: ctx.sessionId,
          status: "failed",
          candidateCompleted: 0,
          candidateTotal: candidates.length,
          reviewerStatus: "missing",
          finalized: false,
        });
        return failedSwarmResult(ctx.sessionId, outcomes);
      }
      const reviewerSession = `${ctx.sessionId}-swarm-reviewer-${nonce}`;
      const reviewerTarget = join(root, SWARM_REVIEWER_ROLE);
      ctx.log.append({
        kind: "effect",
        name: "swarm/worktree",
        payload: {
          child_session: reviewerSession,
          role: SWARM_REVIEWER_ROLE,
          target: reviewerTarget,
          runtime_digest: base.runtimeArtifacts.digest,
        },
      });
      const reviewerTree = deps.allocate(base, reviewerTarget);
      const reviewerPrivateHome = createSwarmChildPrivateHome(root, reviewerSession);
      const seed = artifacts[0];
      if (!seed) throw new Error("swarm reviewer requires a completed candidate artifact");
      appendReviewSeed(ctx.log, {
        state: "effect",
        reviewerSession,
        candidateSession: seed.sessionId,
        patchDigest: seed.delta.patchDigest,
        resultEnvelopeDigest: seed.resultEnvelopeDigest,
      });
      deps.seed(base, seed.delta, reviewerTree.root);
      appendReviewSeed(ctx.log, {
        state: "observed",
        reviewerSession,
        candidateSession: seed.sessionId,
        patchDigest: seed.delta.patchDigest,
        resultEnvelopeDigest: seed.resultEnvelopeDigest,
      });
      appendReviewPlan(ctx.log, {
        state: "effect",
        reviewerSession,
        candidateSession: seed.sessionId,
      });
      deps.prepareReviewPlan(reviewerTree.root);
      appendReviewPlan(ctx.log, {
        state: "observed",
        reviewerSession,
        candidateSession: seed.sessionId,
      });
      const plannedReviewInputs = reviewInputManifest(artifacts);
      appendReviewInputEffect(ctx.log, {
        reviewerSession,
        candidateDigests: artifacts.map((artifact) => artifact.delta.patchDigest),
        resultEnvelopeDigests: plannedReviewInputs.resultEnvelopeDigests,
        manifestDigest: plannedReviewInputs.digest,
      });
      const inputBundle = deps.materialize(reviewerTree.root, artifacts);
      if (inputBundle.manifestDigest !== plannedReviewInputs.digest ||
        canonicalJson(inputBundle.resultEnvelopeDigests) !== canonicalJson(plannedReviewInputs.resultEnvelopeDigests)) {
        throw new Error("swarm reviewer input manifest changed during materialization");
      }
      const reviewerOrder = renderPrompt("swarm/review.md", { order: request.order, inputs: inputBundle.dir });
      const reviewerSnapshot = deps.capture(reviewerTree.root);
      const reviewerProfile = capabilityProfile(ctx, facade, reviewerAssignment, childToolSchemaDigest);
      const reviewerRouteAuthority = await stageSwarmChildRouteAuthority({
        route: reviewerAssignment.route,
        providerId: reviewerProfile.providerId,
        privateHome: reviewerPrivateHome,
        runtimeEnv: childRuntimeEnv,
        parentAuthPath,
      });
      let reviewedDelta: ReturnType<SwarmDependencies["delta"]> | undefined;
      let cleanupEffectAppended = false;
      let reviewInputsCleaned = false;
      const cleanupReviewInputs = () => {
        if (!cleanupEffectAppended) {
          ctx.log.append({
            kind: "effect",
            name: "swarm/review_input_cleanup",
            payload: { reviewer_session: reviewerSession, input_dir: inputBundle.dir },
          });
          cleanupEffectAppended = true;
        }
        deps.cleanReviewInputs(reviewerTree.root);
        reviewInputsCleaned = true;
      };
      const reviewer = await runSwarmChild({
        log: ctx.log,
        parentSessionId: ctx.sessionId,
        assignment: reviewerAssignment,
        sessionId: reviewerSession,
        workspaceRoot: reviewerTree.root,
        order: reviewerOrder,
        maxSteps: request.maxSteps,
        timeoutMs: request.timeoutMs,
        world: request.world,
        signal,
        planPath: "work/current.json",
        sourceSnapshotDigest: reviewerSnapshot.digest,
        capabilityProfile: reviewerProfile,
        memoryView,
        privateHome: reviewerPrivateHome,
        runtimeEnv: childRuntimeEnv,
        ...(reviewerRouteAuthority ? { routeAuthority: reviewerRouteAuthority } : {}),
        ...(recipeDigest ? { recipeDigest } : {}),
        acceptanceOwner: "child",
        complete() {
          // Reviewer inputs are untrusted transport artifacts, not product
          // output. Remove them effect-first before hashing the reviewed delta.
          cleanupReviewInputs();
          reviewedDelta = deps.delta(base, reviewerTree.root);
          return { patchDigest: reviewedDelta.patchDigest };
        },
      }, deps);
      if (!reviewInputsCleaned) cleanupReviewInputs();
      const children = [...outcomes.map((outcome) => outcome.report), reviewer.report];
      if (reviewer.report.status !== "completed") {
        finishSwarm(ctx.log, {
          parentSession: ctx.sessionId,
          status: "failed",
          candidateCompleted: artifacts.length,
          candidateTotal: candidates.length,
          reviewerStatus: reviewer.report.status,
          finalized: false,
        });
        return {
          parentSessionId: ctx.sessionId,
          status: "failed",
          children,
          finalized: false,
          patchDigest: "missing",
        };
      }
      const delta = reviewedDelta;
      if (!delta) throw new Error("completed swarm reviewer has no captured delta");
      appendFinalizeEffect(ctx.log, {
        reviewerSession,
        sourceDigest: base.digest,
        patchDigest: delta.patchDigest,
      });
      const applied = deps.apply(base, delta);
      appendFinalized(ctx.log, { reviewerSession, patchDigest: delta.patchDigest, finalTree: applied.tree });
      finishSwarm(ctx.log, {
        parentSession: ctx.sessionId,
        status: "completed",
        candidateCompleted: artifacts.length,
        candidateTotal: candidates.length,
        reviewerStatus: "completed",
        finalized: true,
      });
      return {
        parentSessionId: ctx.sessionId,
        status: "completed",
        children,
        finalized: true,
        patchDigest: delta.patchDigest,
      };
    },
  };
}
