import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventLog } from "../host/event-log.ts";
import type { WorkspaceBashReuseAuthority } from "../plugins/workspace-bash-reuse.ts";
import type { AuthorizedCaseDispatch } from "../work/verify.ts";
import type { SpeculativeMode } from "./mode.ts";
import type {
  CandidateSchedulerBudget,
  SchedulerReceipt,
  SchedulerStateEvent,
} from "./scheduler-types.ts";
import type { SpeculationService } from "./service.ts";
import type {
  WorkspaceBuildRecoveryResult,
  WorkspaceBuildWarmupRecovery,
} from "./warmup/workspace-build-recovery.ts";

export type BuildTier3ResolutionOutcome = "hit" | "stale" | "drop" | "failed" | "cancelled";

export type BuildTier3Resolution = Readonly<{
  candidateId: string;
  outcome: BuildTier3ResolutionOutcome;
}>;

export type BuildTier3RuntimeOptions = Readonly<{
  workspaceRoot: string;
  mode: SpeculativeMode;
  log?: EventLog;
  schedulerBudget?: Partial<CandidateSchedulerBudget>;
  createBashReuseAuthority(
    available: readonly AgentTool[],
    projected: readonly AgentTool[],
  ): WorkspaceBashReuseAuthority | undefined;
  onState?: (event: SchedulerStateEvent) => boolean | void;
  onResolve?: (event: BuildTier3Resolution) => boolean | void;
  recovery?: WorkspaceBuildWarmupRecovery;
}>;

export type BuildTier3RuntimeSnapshot = Readonly<{
  revision: number;
  scheduled: number;
  ready: number;
  taken: number;
  tracked: number;
  callbackFailures: number;
  disposed: boolean;
}>;

export interface BuildTier3Runtime extends SpeculationService {
  assertHealthy(): void;
  recoverPending(candidateIds: readonly string[]): Promise<readonly WorkspaceBuildRecoveryResult[]>;
  stageAuthorizedBuilds(
    dispatch: AuthorizedCaseDispatch,
    recipeIds: readonly string[],
  ): readonly SchedulerReceipt[];
  snapshot(): BuildTier3RuntimeSnapshot;
}
