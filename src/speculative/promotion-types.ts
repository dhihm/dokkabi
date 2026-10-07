import type { WorktreeDelta, WorktreeSnapshot } from "../swarm/worktree.ts";
import type { PromotionForegroundAuthorization, PromotionLatencyBucket } from "./promotion-journal.ts";

export interface PreparePromotionInput {
  readonly base: WorktreeSnapshot;
  readonly delta: WorktreeDelta;
  readonly decisionDigest: string;
  readonly sessionRoot: string;
  readonly recoveryKey: Uint8Array;
  readonly applyPatch?: (root: string, patch: string) => void;
  readonly afterApply?: () => void;
  readonly transaction?: {
    readonly candidateId: string;
    readonly foregroundCallId: string;
    readonly tool: "edit" | "write";
    readonly argsDigest: string;
  };
}

export interface PromotionSettlementInput {
  readonly exactDigest: string;
  readonly foreground: PromotionForegroundAuthorization;
  readonly latencyBucket: PromotionLatencyBucket;
}

export interface PromotionSettlement {
  readonly outcome: "promoted" | "stale" | "failed" | "drop";
  readonly commit?: PromotionCommit;
  acknowledge(): void;
}

export interface PromotionAuthority {
  readonly storageRoot: string;
  readonly promotionId: string;
  readonly baseDigest: string;
  readonly baseTree: string;
  readonly runtimeDigest: string;
  readonly decisionDigest: string;
  readonly patchDigest: string;
  readonly finalTree: string;
  commit(exactDigest: string): PromotionCommit;
  settle(input: PromotionSettlementInput): PromotionSettlement;
  rollback(): void;
  dispose(): void;
}

export interface PromotionCommit {
  readonly tree: string;
  readonly digest: string;
  readonly runtimeDigest: string;
}
