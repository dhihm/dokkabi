import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { DurableToolCallReceipt } from "../host/event-log.ts";
import type { AuthorizedCaseBatchReceipt } from "../work/verify.ts";

export interface SpeculationToolResult {
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly text: string;
  readonly isError: boolean;
  readonly exitCode: number | null;
}

export interface SpeculationProjection {
  readonly revision: number;
  readonly tools: readonly AgentTool[];
}

export interface SpeculationService {
  project(input: {
    readonly available: readonly AgentTool[];
    readonly projected: readonly AgentTool[];
  }): SpeculationProjection;
  observeToolResult(result: SpeculationToolResult): void;
  observeAgentEvent(event: AgentEvent): void;
  requiresDurableForeground?(tool: string, args: unknown): boolean;
  stageForegroundAuthorization?(callId: string, receipt: DurableToolCallReceipt): void;
  stageAuthorizedCases?(receipt: AuthorizedCaseBatchReceipt): void;
  assertHealthy?(): void;
  idle(): Promise<void>;
  invalidate(): void;
  dispose(): void;
}

export class SpeculationServiceError extends Error {
  readonly code = "speculation_service_disposed" as const;

  constructor() {
    super("speculation service is disposed");
  }
}
