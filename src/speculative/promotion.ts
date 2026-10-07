import { createHash } from "node:crypto";
import { captureWorktreeSnapshot, releaseWorktreeSnapshot, type WorktreeDelta, type WorktreeSnapshot } from "../swarm/worktree.ts";
import {
  copyRecoveryKey,
  createPromotionStorage,
  persistPromotionJournal,
  persistPromotionTransaction,
  removePromotionStorage,
  sourceAuthorityDigest,
  trustedSessionRoot,
  type PromotionForegroundAuthorization,
  type PromotionJournal,
  type PromotionLatencyBucket,
  type PromotionTransactionJournal,
} from "./promotion-journal.ts";
import type {
  PreparePromotionInput,
  PromotionAuthority,
  PromotionCommit,
  PromotionSettlement,
} from "./promotion-types.ts";
import { capturePromotionEntries, promotionEntriesMatch, restorePromotionEntries, verifyPromotionBase } from "./promotion-recovery.ts";
import { applyPatch, assertSourceCas, checkPatch, parseDecisionDigest, patchTargets, PromotionError, withPromotionLock } from "./source-cas.ts";
import { validatePromotionTarget } from "./promotion-target.ts";

export type {
  PreparePromotionInput,
  PromotionAuthority,
  PromotionCommit,
  PromotionSettlement,
  PromotionSettlementInput,
} from "./promotion-types.ts";

export function preparePromotion(input: PreparePromotionInput): PromotionAuthority {
  const recoveryKey = copyRecoveryKey(input.recoveryKey);
  const decisionDigest = parseDecisionDigest(input.decisionDigest);
  const base: WorktreeSnapshot = Object.freeze({
    sourceRoot: input.base.sourceRoot,
    head: input.base.head,
    tree: input.base.tree,
    commit: input.base.commit,
    digest: input.base.digest,
    runtimeArtifacts: Object.freeze({
      paths: Object.freeze([...input.base.runtimeArtifacts.paths]),
      digest: input.base.runtimeArtifacts.digest,
    }),
    captureRuntimeArtifacts: input.base.captureRuntimeArtifacts,
    transientObjectDirectory: input.base.transientObjectDirectory,
    transientObjectRoot: input.base.transientObjectRoot,
  });
  const delta: WorktreeDelta = Object.freeze({
    patch: input.delta.patch,
    patchDigest: input.delta.patchDigest,
    finalTree: input.delta.finalTree,
  });
  const executePatch = input.applyPatch ?? applyPatch;
  const afterApply = input.afterApply;
  if (createHash("sha256").update(delta.patch).digest("hex") !== delta.patchDigest) {
    throw new PromotionError("digest");
  }
  const root = base.sourceRoot;
  const sessionRoot = trustedSessionRoot(input.sessionRoot);
  const storage = createPromotionStorage(sessionRoot);
  const storageRoot = storage.root;
  const persist = (value: PromotionJournal): void => {
    storage.assertAttached();
    persistPromotionJournal(storageRoot, value, recoveryKey);
  };
  let journal: PromotionJournal = {
    version: 1,
    promotionId: storage.id,
    phase: "prepared",
    sourceAuthorityDigest: sourceAuthorityDigest(root),
    baseDigest: base.digest,
    baseTree: base.tree,
    runtimeDigest: base.runtimeArtifacts.digest,
    captureRuntimeArtifacts: base.captureRuntimeArtifacts !== false,
    decisionDigest,
    patchDigest: delta.patchDigest,
    entries: [],
  };
  const transactionBase = input.transaction === undefined ? undefined : {
    version: 2 as const,
    promotionId: storage.id,
    candidateId: parseDecisionDigest(input.transaction.candidateId),
    foregroundCallId: input.transaction.foregroundCallId,
    foregroundTool: input.transaction.tool,
    foregroundArgsDigest: parseDecisionDigest(input.transaction.argsDigest),
    candidateKeyDigest: decisionDigest,
    finalTree: delta.finalTree,
  };
  let transactionJournal: PromotionTransactionJournal | undefined;
  try {
    persist(journal);
    journal = withPromotionLock(root, () => {
      assertSourceCas(base);
      checkPatch(root, delta.patch);
      const entries = capturePromotionEntries(root, patchTargets(root, delta.patch), storageRoot);
      const prepared = { ...journal, entries } satisfies PromotionJournal;
      persist(prepared);
      return prepared;
    }, storage.id);
    if (transactionBase) {
      transactionJournal = { ...transactionBase, phase: "prepared" };
      persistPromotionTransaction(storageRoot, transactionJournal, recoveryKey);
    }
  } catch (error) {
    removePromotionStorage(sessionRoot, storageRoot);
    throw error;
  }
  let state: "prepared" | "committing" | "settled" | "consumed" | "recovery" = "prepared";
  let retainedForeground: PromotionForegroundAuthorization | undefined;
  let retainedLatency: PromotionLatencyBucket | undefined;
  const finish = (): void => {
    storage.assertAttached();
    if (journal.phase === "committed" && retainedForeground && retainedLatency) {
      state = "settled";
      return;
    }
    state = "consumed";
    removePromotionStorage(sessionRoot, storageRoot);
  };
  const ensurePrepared = (): void => {
    if (state !== "prepared") throw new PromotionError("consumed");
  };
  const authority: PromotionAuthority = {
    storageRoot,
    promotionId: storage.id,
    baseDigest: base.digest,
    baseTree: base.tree,
    runtimeDigest: base.runtimeArtifacts.digest,
    decisionDigest,
    patchDigest: delta.patchDigest,
    finalTree: delta.finalTree,
    commit(exactDigest) {
      ensurePrepared();
      storage.assertAttached();
      let matchedDigest: string;
      try {
        matchedDigest = parseDecisionDigest(exactDigest);
      } catch (error) {
        finish();
        throw error;
      }
      if (matchedDigest !== decisionDigest) {
        finish();
        throw new PromotionError("digest");
      }
      state = "committing";
      try {
        return withPromotionLock(root, () => {
          let mutationStarted = false;
          try {
            assertSourceCas(base);
            if (!promotionEntriesMatch(root, storageRoot, journal.entries)) {
              throw new PromotionError("source_changed");
            }
            journal = { ...journal, phase: "applying" };
            persist(journal);
            if (transactionBase && retainedForeground) {
              transactionJournal = { ...transactionBase, phase: "applying", foreground: retainedForeground };
              persistPromotionTransaction(storageRoot, transactionJournal, recoveryKey);
            }
            mutationStarted = true;
            executePatch(root, delta.patch);
            afterApply?.();
            for (const item of journal.entries) validatePromotionTarget(root, item.relative);
            const applied = captureWorktreeSnapshot(root, {
              runtimeArtifacts: base.captureRuntimeArtifacts !== false,
              isolatedObjects: true,
            });
            try {
              if (applied.tree !== delta.finalTree
                || applied.runtimeArtifacts.digest !== base.runtimeArtifacts.digest) {
                throw new PromotionError("apply");
              }
              const result = {
                tree: applied.tree,
                digest: applied.digest,
                runtimeDigest: applied.runtimeArtifacts.digest,
              } satisfies PromotionCommit;
              journal = { ...journal, phase: "committed" };
              persist(journal);
              if (transactionBase && retainedForeground && retainedLatency) {
                transactionJournal = {
                  ...transactionBase,
                  phase: "committed",
                  foreground: retainedForeground,
                  committedDigest: result.digest,
                  terminal: { kind: "resolve", candidateId: transactionBase.candidateId,
                    outcome: "promoted", latencyBucket: retainedLatency },
                };
                persistPromotionTransaction(storageRoot, transactionJournal, recoveryKey);
              }
              finish();
              return result;
            } finally {
              releaseWorktreeSnapshot(applied);
            }
          } catch (error) {
            if (mutationStarted) {
              try {
                restorePromotionEntries(root, storageRoot, journal.entries);
                verifyPromotionBase(root, journal);
                journal = { ...journal, phase: "resolved" };
                persist(journal);
              } catch (restoreError) {
                state = "recovery";
                if (restoreError instanceof Error) throw new PromotionError("rollback");
                throw restoreError;
              }
            }
            finish();
            throw error;
          }
        }, storage.id);
      } catch (error) {
        if (state === "committing") finish();
        throw error;
      }
    },
    settle(input) {
      ensurePrepared();
      if (!transactionBase || input.foreground.callId !== transactionBase.foregroundCallId
        || input.foreground.tool !== transactionBase.foregroundTool
        || input.foreground.argsDigest !== transactionBase.foregroundArgsDigest) {
        finish();
        throw new PromotionError("digest");
      }
      retainedForeground = input.foreground;
      retainedLatency = input.latencyBucket;
      transactionJournal = { ...transactionBase, phase: "authorized", foreground: input.foreground };
      persistPromotionTransaction(storageRoot, transactionJournal, recoveryKey);
      const commit = authority.commit(input.exactDigest);
      return Object.freeze({ outcome: "promoted" as const, commit,
        acknowledge: () => {
          if (state !== "settled") return;
          state = "consumed";
          removePromotionStorage(sessionRoot, storageRoot);
        } });
    },
    rollback() { if (state === "prepared") finish(); },
    dispose() { if (state === "prepared") finish(); },
  };
  return authority;
}
