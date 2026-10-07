import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import type { EventLog } from "../host/event-log.ts";
import type { SshService } from "../host/ssh.ts";
import { projectSessionReplaySchemas } from "../host/schema.ts";
import type { HostContext } from "../loader/types.ts";
import { createSpeculationEventWriter } from "../speculative/event-writer.ts";
import { projectSpeculationV2References } from "../speculative/events-v2.ts";
import { resolveSpeculativeMode, SPECULATIVE_MODE_ENV, type SpeculativeMode } from "../speculative/mode.ts";
import { loadSpeculativePredictor } from "../speculative/predictor-loader.ts";
import { SPECULATIVE_RULES_ENV } from "../speculative/rules-file.ts";
import { createTier1Runtime, createTier1RuntimeBudget, type Tier1Runtime, type Tier1RuntimeBudget } from "../speculative/runtime-tier1.ts";
import { TIER2_PROVIDER_DIGEST } from "../speculative/runtime-tier2.ts";
import { BUILD_TIER3_PROVIDER_DIGEST } from "../speculative/runtime-tier3-build.ts";
import { createSshTier3Runtime, SSH_TIER3_PROVIDER_DIGEST, type SshTier3Runtime } from "../speculative/runtime-tier3-ssh.ts";
import { SpeculationServiceError, type SpeculationService } from "../speculative/service.ts";
import { createWorkspaceSpeculativeAuthority } from "./workspace-tools.ts";
import { createSessionSshRecovery, SpeculationPublicationError } from "./speculative-ssh-recovery.ts";
import { createFullSpeculationSession } from "./speculative-full-session.ts";

type Authority = ReturnType<typeof createWorkspaceSpeculativeAuthority>;
type Binding = {
  readonly available: readonly AgentTool[];
  readonly mode: SpeculativeMode;
  readonly rulesPath: string | undefined;
  readonly authority: Authority;
  readonly runtime: Tier1Runtime;
  readonly sshService: SshService | undefined;
  readonly sshRuntime: SshTier3Runtime | undefined;
};

const sessionBudgets = new WeakMap<EventLog, Tier1RuntimeBudget>();

export function createCurrentSpeculationService(ctx: HostContext): SpeculationService {
  const budget = sessionBudgets.get(ctx.log) ?? createTier1RuntimeBudget();
  sessionBudgets.set(ctx.log, budget);
  const writer = createSpeculationEventWriter({ log: ctx.log, providerDigest });
  const startupPending = new Set(writer.pending());
  const featureStart = projectSessionReplaySchemas(ctx.log.events).featureStart.get("speculation-v2");
  const startupReferences = projectSpeculationV2References(ctx.log.events, featureStart);
  const sshRecoveries = createSessionSshRecovery(ctx, writer, startupReferences, startupPending);
  const fullSession = createFullSpeculationSession(ctx, writer, startupReferences, startupPending);
  if (!ctx.log.isReadOnly) {
    for (const row of startupReferences) {
      if (row.name === "prepare" && row.tier === 1 && startupPending.has(row.candidate_id)
        && row.provider_digest === providerDigest(row.tool, 1)) writer.recover(row.candidate_id, "cleaned");
    }
  }
  const retired = new Set<Promise<void>>();
  let binding: Binding | undefined;
  let revision = 0;
  let projectedRevision = -1;
  let projectedSshRevision = -1;
  let projectedTier2Revision = -1;
  let disposed = false;
  let retiredFailure: Error | undefined;
  const rememberFailure = (cause: unknown): void => {
    retiredFailure ??= cause instanceof Error ? cause : new Error("speculation cleanup failed", { cause });
  };
  const retainHealth = (runtime: SpeculationService | undefined): void => {
    try { runtime?.assertHealthy?.(); }
    catch (cause) { rememberFailure(cause); }
  };
  const invalidate = (): void => {
    fullSession.invalidate();
    try { fullSession.assertHealthy(); } catch (cause) { rememberFailure(cause); }
    const previous = binding;
    binding = undefined;
    projectedRevision = -1;
    projectedSshRevision = -1;
    projectedTier2Revision = -1;
    revision += 1;
    if (!previous) return;
    previous.runtime.dispose();
    previous.sshRuntime?.dispose();
    retainHealth(previous.sshRuntime);
    const cleanup = Promise.all([previous.runtime.idle(), previous.sshRuntime?.idle()])
      .then(() => retainHealth(previous.sshRuntime), rememberFailure);
    retired.add(cleanup);
    void cleanup.finally(() => retired.delete(cleanup));
  };
  return {
    project(input) {
      if (disposed) throw new SpeculationServiceError();
      if (retiredFailure) throw retiredFailure;
      if (ctx.log.isReadOnly) return { revision, tools: input.projected };
      const mode = resolveSpeculativeMode({ env: process.env[SPECULATIVE_MODE_ENV] }).mode;
      if (!fullSession.prepare(input, mode)) return { revision, tools: input.projected };
      const rulesPath = mode === "off" ? undefined : process.env[SPECULATIVE_RULES_ENV]?.trim() || undefined;
      const sshService = mode === "full" ? ctx.tryGet<SshService>("ssh") : undefined;
      const sshRecovery = sshRecoveries.prepare(sshService);
      if (sshRecovery?.task) return { revision, tools: input.projected };
      if (!binding || binding.mode !== mode || binding.rulesPath !== rulesPath
        || binding.sshService !== sshService
        || !sameTools(binding.available, input.available)) {
        invalidate();
        if (retiredFailure) throw retiredFailure;
        const loaded = rulesPath ? loadSpeculativePredictor(rulesPath, { workspaceRoot: ctx.workspaceRoot }) : undefined;
        if (!writer.configure({ mode, ...(loaded ? { predictorDigest: loaded.digest } : {}) })) {
          return { revision, tools: input.projected };
        }
        const authority = createWorkspaceSpeculativeAuthority(input.available);
        binding = {
          available: [...input.available], mode, rulesPath, authority,
          sshService,
          sshRuntime: sshService ? createSshTier3Runtime({
            service: sshService, mode,
            ...(sshRecovery ? { recovery: sshRecovery.recovery } : {}),
            onState: (event) => event.phase === "dropped" || event.phase === "disposed" || writer.observe(event),
            onResolve: (event) => {
              if (!writer.resolve(event.candidateId, event.outcome)) throw new SpeculationPublicationError(event.candidateId);
            },
          }) : undefined,
          runtime: createTier1Runtime({
            workspaceRoot: ctx.workspaceRoot, mode, sharedBudget: budget,
            ...(loaded ? { predictor: loaded.predictor } : {}),
            ...(authority?.gitAuthority ? { gitAuthority: authority.gitAuthority } : {}),
            ...(authority?.probeAuthority ? { probeAuthority: authority.probeAuthority } : {}),
            validateForegroundReuse: (tool) => authority?.validateForegroundReuse(tool) === true,
            onState: (event) => event.phase === "dropped" || event.phase === "disposed" || writer.observe(event),
            onResolve: (event) => writer.resolve(event.candidateId, event.outcome),
          }),
        };
      }
      const authorized = binding.authority?.project(input.projected) ?? [];
      const projection = binding.runtime.project({ available: authorized, projected: authorized });
      if (projection.revision !== projectedRevision) {
        projectedRevision = projection.revision;
        revision += 1;
      }
      const replacements = new Map(authorized.map((tool, index) => [tool, projection.tools[index] ?? tool]));
      const tier1Tools = input.projected.map((tool) => replacements.get(tool) ?? tool);
      const sshProjection = binding.sshRuntime?.project({ available: input.available, projected: tier1Tools });
      if (sshProjection && sshProjection.revision !== projectedSshRevision) {
        projectedSshRevision = sshProjection.revision;
        revision += 1;
      }
      const precedingTools = sshProjection?.tools ?? tier1Tools;
      const mutationProjection = mode === "full"
        ? fullSession.project({ available: input.available, projected: precedingTools }) : undefined;
      if (mutationProjection && mutationProjection.revision !== projectedTier2Revision) {
        projectedTier2Revision = mutationProjection.revision;
        revision += 1;
      }
      return { revision, tools: mutationProjection?.tools ?? precedingTools };
    },
    observeAgentEvent(event) {
      binding?.runtime.observeAgentEvent(event);
      binding?.sshRuntime?.observeAgentEvent(event);
      if (binding?.mode === "full") fullSession.observeAgentEvent(event);
    },
    observeToolResult(result) {
      binding?.runtime.observeToolResult(result);
      binding?.sshRuntime?.observeToolResult(result);
      if (binding?.mode === "full") fullSession.observeToolResult(result);
    },
    requiresDurableForeground: (tool, args) => binding?.mode === "full" && fullSession.requiresDurableForeground(tool, args),
    stageForegroundAuthorization(callId, receipt) {
      if (binding?.mode === "full") fullSession.stageForegroundAuthorization(callId, receipt);
    },
    stageAuthorizedCases(receipt) {
      if (resolveSpeculativeMode({ env: process.env[SPECULATIVE_MODE_ENV] }).mode === "full") fullSession.stage(receipt);
    },
    assertHealthy() {
      if (retiredFailure) throw retiredFailure;
      sshRecoveries.assertHealthy();
      binding?.sshRuntime?.assertHealthy?.();
      fullSession.assertHealthy();
    },
    async idle() {
      await sshRecoveries.idle();
      await Promise.all([binding?.runtime.idle(), binding?.sshRuntime?.idle(), fullSession.idle()]);
      while (retired.size > 0) await Promise.all([...retired]);
      if (retiredFailure) throw retiredFailure;
      sshRecoveries.assertHealthy();
      fullSession.assertHealthy();
    },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
      fullSession.dispose();
    },
  };
}

function sameTools(left: readonly AgentTool[], right: readonly AgentTool[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function providerDigest(tool: string, tier: 1 | 2 | 3): string | undefined {
  if (tier === 3 && tool === "ssh") return SSH_TIER3_PROVIDER_DIGEST;
  if (tier === 3 && tool === "bash") return BUILD_TIER3_PROVIDER_DIGEST;
  if (tier === 2 && (tool === "edit" || tool === "write" || tool === "bash")) return TIER2_PROVIDER_DIGEST;
  if (tier !== 1) return undefined;
  return createHash("sha256").update(`tier1:${tool}`).digest("hex");
}
