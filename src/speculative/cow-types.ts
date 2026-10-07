import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	PromotionCommit,
	PromotionSettlement,
	PromotionSettlementInput,
} from "./promotion.ts";
import type { ScheduledCandidate } from "./scheduler-types.ts";

type Tier2AuthorizedTestBase = {
	readonly recipeId: string;
	readonly args: { readonly command: string; readonly timeout?: number };
	readonly resultPolicy: "root_independent" | "warm_only";
};

export type Tier2AuthorizedTest = Tier2AuthorizedTestBase &
	(
		| { readonly sourcePath?: never; readonly sourceDigest?: never }
		| { readonly sourcePath: string; readonly sourceDigest: string }
	);

export type Tier2ExecutorOptions = {
	readonly sourceRoot: string;
	readonly sessionRoot: string;
	readonly recoveryKey?: Uint8Array;
	readonly authorizedTests?: readonly Tier2AuthorizedTest[];
	readonly platform?: NodeJS.Platform;
};

export type Tier2ExecutorSnapshot = {
	readonly active: number;
	readonly disposed: boolean;
};

export interface PreparedTier2Candidate {
	readonly result: AgentToolResult<unknown>;
	readonly storageRoot: string;
	readonly decisionDigest: string;
	commit(exactDigest: string): PromotionCommit;
	settle(input: PromotionSettlementInput): PromotionSettlement | undefined;
	rollback(): void;
	dispose(): void;
}

export interface Tier2CandidateExecutor {
	prepare(
		candidate: ScheduledCandidate,
		signal: AbortSignal,
	): Promise<PreparedTier2Candidate | undefined>;
	authorizeTest(test: Tier2AuthorizedTest): boolean;
	snapshot(): Tier2ExecutorSnapshot;
	dispose(): void;
}
