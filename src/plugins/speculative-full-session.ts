import { dirname } from "node:path";
import type { HostContext } from "../loader/types.ts";
import type { SpeculationEventWriter } from "../speculative/event-writer.ts";
import type { SpeculationV2Reference } from "../speculative/events-v2-schema.ts";
import type { SpeculativeMode } from "../speculative/mode.ts";
import { loadOrCreateRecoveryKey } from "../speculative/recovery-authority.ts";
import { createTier2Runtime, type Tier2Runtime } from "../speculative/runtime-tier2.ts";
import { BUILD_TIER3_PROVIDER_DIGEST, createBuildTier3Runtime, type BuildTier3Runtime } from "../speculative/runtime-tier3-build.ts";
import { SpeculationServiceError, type SpeculationService } from "../speculative/service.ts";
import { createWorkspaceBuildWarmupRecovery } from "../speculative/warmup/workspace-build-recovery.ts";
import { authorizedCaseRecipeIds, consumeAuthorizedCaseDispatch, type AuthorizedCaseBatchReceipt } from "../work/verify.ts";
import { createWorkspaceBashResultAuthority } from "./workspace-bash-result-authority.ts";
import { createWorkspaceBashReuseAuthority } from "./workspace-bash-reuse.ts";
import { createWorkspaceMutationAuthority } from "./workspace-mutation-authority.ts";

type ProjectionInput = Parameters<SpeculationService["project"]>[0];

export function createFullSpeculationSession(
  ctx: HostContext,
  writer: SpeculationEventWriter,
  references: readonly SpeculationV2Reference[],
  startupPending: ReadonlySet<string>,
) {
  const buildCandidates = references.flatMap((row) => row.name === "prepare" && row.tier === 3
    && row.tool === "bash" && row.provider_digest === BUILD_TIER3_PROVIDER_DIGEST && startupPending.has(row.candidate_id)
    ? [row.candidate_id] : []);
  let tier2: Tier2Runtime | undefined;
  let build: BuildTier3Runtime | undefined;
  let pendingReceipt: AuthorizedCaseBatchReceipt | undefined;
  let recoveryTask: Promise<void> | undefined;
  let failure: Error | undefined;
  let disposed = false;
  const assertHealthy = (): void => {
    if (failure) throw failure;
    tier2?.assertHealthy?.();
    build?.assertHealthy();
  };
  return {
    prepare(input: ProjectionInput, mode: SpeculativeMode): boolean {
      if (disposed) throw new SpeculationServiceError();
      assertHealthy();
      if (ctx.log.isReadOnly || mode !== "full") {
        pendingReceipt = undefined;
        return true;
      }
      if (!tier2) {
        const sessionRoot = dirname(ctx.log.path);
        const bash = input.available.filter((tool) => tool.name === "bash");
        const authorizedTestTool = bash.length === 1 ? bash[0] : undefined;
        tier2 = createTier2Runtime({
          sourceRoot: ctx.workspaceRoot, sessionRoot, mode, eventLog: ctx.log,
          consumeForegroundReceipt: (receipt) => ctx.log.consumeDurableToolCall(receipt),
          createMutationAuthority: createWorkspaceMutationAuthority,
          createBashResultAuthority: createWorkspaceBashResultAuthority,
          ...(authorizedTestTool ? { authorizedTestTool } : {}),
          onState: (event) => writer.observe(event),
          onResolve: (event) => writer.resolveDurable(event.candidateId, event.outcome, event.latencyBucket),
        });
        build = createBuildTier3Runtime({
          workspaceRoot: ctx.workspaceRoot, mode, log: ctx.log,
          createBashReuseAuthority: createWorkspaceBashReuseAuthority,
          recovery: createWorkspaceBuildWarmupRecovery({ sessionRoot, recoveryKey: loadOrCreateRecoveryKey(sessionRoot) }),
          onState: (event) => event.phase === "dropped" || event.phase === "disposed" || writer.observe(event),
          onResolve: (event) => writer.resolve(event.candidateId, event.outcome),
        });
        if (buildCandidates.length > 0) {
          build.project(input);
          const pending = new Set(writer.pending());
          recoveryTask = build.recoverPending(buildCandidates.filter((id) => pending.has(id))).then((results) => {
            for (const result of results) {
              if (!writer.recover(result.candidateId, result.outcome)) {
                throw new Error("speculative build recovery could not be recorded");
              }
            }
          }).catch((cause: unknown) => { failure = new Error("speculative build recovery failed", { cause }); })
            .finally(() => { recoveryTask = undefined; });
        }
      }
      return recoveryTask === undefined;
    },
    project(input: ProjectionInput) {
      assertHealthy();
      const mutations = tier2?.project(input);
      const warmed = build?.project({ available: input.available, projected: mutations?.tools ?? input.projected });
      if (pendingReceipt && !recoveryTask) {
        const receipt = pendingReceipt;
        pendingReceipt = undefined;
        const dispatch = consumeAuthorizedCaseDispatch(receipt);
        if (dispatch) {
          build?.stageAuthorizedBuilds(dispatch, authorizedCaseRecipeIds(dispatch));
          const remaining = authorizedCaseRecipeIds(dispatch);
          tier2?.stageAuthorizedTests(dispatch, remaining);
          for (const id of remaining) tier2?.scheduleAuthorizedTest(id);
        }
      }
      return { revision: (mutations?.revision ?? 0) + (warmed?.revision ?? 0), tools: warmed?.tools ?? mutations?.tools ?? input.projected };
    },
    stage(receipt: AuthorizedCaseBatchReceipt) {
      if (disposed) throw new SpeculationServiceError();
      if (!ctx.log.isReadOnly) pendingReceipt = receipt;
    },
    observeAgentEvent: (event: Parameters<SpeculationService["observeAgentEvent"]>[0]) => tier2?.observeAgentEvent(event),
    observeToolResult: (result: Parameters<SpeculationService["observeToolResult"]>[0]) => tier2?.observeToolResult(result),
    requiresDurableForeground: (tool: string, args: unknown) => tier2?.requiresDurableForeground?.(tool, args) === true,
    stageForegroundAuthorization(callId: string, receipt: Parameters<NonNullable<SpeculationService["stageForegroundAuthorization"]>>[1]) {
      tier2?.stageForegroundAuthorization?.(callId, receipt);
    },
    assertHealthy,
    async idle() {
      const settled = await Promise.allSettled([recoveryTask, tier2?.idle(), build?.idle()]);
      for (const result of settled) if (result.status === "rejected") throw result.reason;
      assertHealthy();
    },
    invalidate() { tier2?.invalidate(); build?.invalidate(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingReceipt = undefined;
      tier2?.dispose();
      build?.dispose();
    },
  };
}
