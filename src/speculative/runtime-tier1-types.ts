import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExactCacheEvent } from "./exact-cache-types.ts";
import type { Predictor } from "./predictor.ts";
import type { CandidateSchedulerBudget, SchedulerStateEvent } from "./scheduler-types.ts";
import type { SpeculationService } from "./service.ts";
import type { SpeculativeRules } from "./rules.ts";
import type { Tier1ExecutionAuthority, Tier1ProviderLimits } from "./providers/index.ts";
import type { Tier1RuntimeBudget } from "./runtime-tier1-budget.ts";

export type Tier1ResolutionOutcome =
  | "hit" | "stale" | "drop" | "warm_only" | "failed" | "cancelled";

export type Tier1Resolution = {
  readonly candidateId: string;
  readonly outcome: Tier1ResolutionOutcome;
};

export type Tier1RuntimeOptions = {
  readonly workspaceRoot: string;
  readonly mode: "off" | "read-only" | "full";
  readonly replay?: boolean;
  readonly predictor?: Predictor;
  readonly rulesV1?: SpeculativeRules;
  readonly providerLimits?: Tier1ProviderLimits;
  readonly cacheBudget?: {
    readonly maxEntries?: number;
    readonly maxResultBytes?: number;
    readonly maxTotalBytes?: number;
    readonly maxCallBytes?: number;
    readonly maxInFlight?: number;
    readonly maxOutstanding?: number;
    readonly timeoutMs?: number;
  };
  readonly schedulerBudget?: Partial<CandidateSchedulerBudget>;
  readonly sharedBudget?: Tier1RuntimeBudget;
  readonly validateForegroundReuse?: (tool: AgentTool) => boolean;
  readonly gitAuthority?: Tier1ExecutionAuthority;
  readonly probeAuthority?: Tier1ExecutionAuthority & { readonly runtime: "python" | "bun" };
  readonly onState?: (event: SchedulerStateEvent) => boolean | void;
  readonly onResolve?: (event: Tier1Resolution) => boolean | void;
  readonly onMiss?: (event: ExactCacheEvent) => void;
};

export type Tier1RuntimeSnapshot = {
  readonly revision: number;
  readonly scheduled: number;
  readonly ready: number;
  readonly taken: number;
  readonly cacheEntries: number;
  readonly tracked: number;
  readonly disposed: boolean;
};

export interface Tier1Runtime extends SpeculationService {
  snapshot(): Tier1RuntimeSnapshot;
}

export type Tier1Ready = { readonly keyDigest: string };
export type Tier1ToolResult = AgentToolResult<unknown>;
export type Tier1ToolMap = ReadonlyMap<string, AgentTool>;
