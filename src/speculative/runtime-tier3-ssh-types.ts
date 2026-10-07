import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SshService } from "../host/ssh.ts";
import type { SandboxHostExecutableSeal } from "../host/sandbox-executable.ts";
import type { SpeculativeMode } from "./mode.ts";
import type { Tier1Resolution } from "./runtime-tier1-types.ts";
import type { CandidateSchedulerBudget, SchedulerStateEvent } from "./scheduler-types.ts";
import type { SpeculationService } from "./service.ts";
import type { SshControlDriver } from "./warmup/ssh.ts";
import type { SshTier3Recovery } from "./runtime-tier3-ssh-recovery.ts";

export type SshTier3RuntimeOptions = Readonly<{
  service: SshService;
  mode: SpeculativeMode;
  onState?: (event: SchedulerStateEvent) => boolean | void;
  onResolve?: (event: Tier1Resolution) => boolean | void;
  schedulerBudget?: Partial<CandidateSchedulerBudget>;
  driver?: SshControlDriver;
  assertExecutable?: (seal: SandboxHostExecutableSeal) => void;
  recovery?: SshTier3Recovery;
}>;

export type SshTier3RuntimeSnapshot = Readonly<{
  revision: number;
  scheduled: number;
  ready: number;
  taken: number;
  tracked: number;
  callbackFailures: number;
  disposed: boolean;
}>;

export interface SshTier3Runtime extends SpeculationService {
  snapshot(): SshTier3RuntimeSnapshot;
}

export type SshTier3Resolution = Tier1Resolution;
export type SshTier3ToolResult = AgentToolResult<unknown>;
export type SshTier3Tool = AgentTool;
