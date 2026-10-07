import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DurableToolCallReceipt, EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import type { WorkspaceMutationAuthority } from "../plugins/workspace-mutation-authority.ts";
import type { WorkspaceBashResultAuthority } from "../plugins/workspace-bash-result-authority.ts";
import type { AuthorizedCaseDispatch } from "../work/verify.ts";
import type {
	CandidateSchedulerBudget,
	CandidateSchedulerOptions,
	CandidateSchedulerSnapshot,
	SchedulerReceipt,
} from "./scheduler-types.ts";
import type { SpeculationService } from "./service.ts";

export type Tier2Publication = "appended" | "already_durable" | "rejected";
export type Tier2ResolutionOutcome =
	| "promoted"
	| "stale"
	| "drop"
	| "failed"
	| "cancelled"
	| "warm_only";
export type Tier2LatencyBucket =
	| "under_1ms"
	| "under_10ms"
	| "under_100ms"
	| "under_1s"
	| "at_least_1s";

export interface Tier2RuntimeOptions {
	readonly sourceRoot: string;
	readonly sessionRoot: string;
	readonly mode: "off" | "read-only" | "full";
	readonly replay?: boolean;
	readonly recoveryKey?: Uint8Array;
	readonly platform?: NodeJS.Platform;
	readonly eventLog: EventLog;
	readonly authorizedTestDispatch?: AuthorizedCaseDispatch;
	readonly authorizedTestRecipeIds?: readonly string[];
	readonly authorizedTestTool?: AgentTool;
	readonly schedulerBudget?: Partial<CandidateSchedulerBudget>;
	readonly consumeForegroundReceipt: (
		receipt: DurableToolCallReceipt,
	) => EventRecord | undefined;
	readonly createMutationAuthority: (
		available: readonly AgentTool[],
		projected: readonly AgentTool[],
	) => WorkspaceMutationAuthority | undefined;
	readonly createBashResultAuthority?: (
		available: readonly AgentTool[],
		projected: readonly AgentTool[],
	) => WorkspaceBashResultAuthority | undefined;
	readonly onState?: CandidateSchedulerOptions<unknown>["onState"];
	readonly onResolve?: (event: {
		readonly candidateId: string;
		readonly outcome: Tier2ResolutionOutcome;
		readonly latencyBucket: Tier2LatencyBucket;
	}) => Tier2Publication;
}

export interface Tier2Runtime extends SpeculationService {
	stageAuthorizedTests(
		dispatch: AuthorizedCaseDispatch,
		recipeIds: readonly string[],
	): number;
	scheduleAuthorizedTest(recipeId: string): SchedulerReceipt;
	snapshot(): CandidateSchedulerSnapshot & {
		readonly revision: number;
		readonly recoveryRequired: boolean;
	};
}

export class Tier2RecoveryRequiredError extends Error {
	readonly code = "tier2_recovery_required";
	constructor() {
		super("Tier 2 promotion requires authenticated restart recovery");
	}
}
