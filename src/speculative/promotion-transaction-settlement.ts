import type { EventLog } from "../host/event-log.ts";
import type { EventInput } from "../host/schema.ts";
import {
	persistPromotionJournal,
	persistPromotionTransaction,
	removePromotionStorage,
	type PromotionRecoveryTerminal,
	type PromotionResolveTerminal,
} from "./promotion-journal.ts";
import {
	restorePromotionEntries,
	verifyPromotionBase,
} from "./promotion-recovery.ts";
import { holdPromotionStorage } from "./promotion-storage.ts";
import {
	clearStalePromotionLock,
	PromotionError,
	withPromotionLock,
} from "./source-cas.ts";
import type { PromotionRecoveryPlan } from "./promotion-transaction-plan.ts";

export function reconcilePromotionPlan(input: {
	readonly plan: PromotionRecoveryPlan;
	readonly sourceRoot: string;
	readonly sessionRoot: string;
	readonly key: Uint8Array;
	readonly log: EventLog;
}): "restored" | "cleaned" | "promoted" {
	const { storageRoot, journal, transaction } = input.plan;
	const assertAttached = holdPromotionStorage(storageRoot);
	clearStalePromotionLock(input.sourceRoot, journal.promotionId);
	if (transaction.phase === "committed" || transaction.phase === "resolved") {
		appendPromotionTerminal(input.log, transaction.terminal);
		assertAttached();
		removePromotionStorage(input.sessionRoot, storageRoot);
		if (transaction.phase === "committed") return "promoted";
		if (transaction.terminal.kind === "resolve") {
			return transaction.terminal.outcome === "promoted"
				? "promoted"
				: "cleaned";
		}
		return transaction.terminal.outcome;
	}
	const outcome: "restored" | "cleaned" =
		transaction.phase === "applying" || journal.phase === "applying"
			? "restored"
			: "cleaned";
	const terminal: PromotionRecoveryTerminal = {
		kind: "recover",
		candidateId: transaction.candidateId,
		outcome,
	};
	if (transaction.phase === "applying" || journal.phase === "applying") {
		withPromotionLock(
			input.sourceRoot,
			() => {
				restorePromotionEntries(input.sourceRoot, storageRoot, journal.entries);
				verifyPromotionBase(input.sourceRoot, journal);
				assertAttached();
				persistPromotionJournal(
					storageRoot,
					{ ...journal, phase: "resolved" },
					input.key,
				);
				persistPromotionTransaction(
					storageRoot,
					{ ...transaction, phase: "resolved", terminal },
					input.key,
				);
			},
			journal.promotionId,
		);
	} else
		persistPromotionTransaction(
			storageRoot,
			{ ...transaction, phase: "resolved", terminal },
			input.key,
		);
	appendPromotionTerminal(input.log, terminal);
	assertAttached();
	removePromotionStorage(input.sessionRoot, storageRoot);
	return outcome;
}

export function appendPromotionTerminal(
	log: EventLog,
	terminal: PromotionResolveTerminal | PromotionRecoveryTerminal,
): void {
	const existing = log.events.find(
		(event) =>
			event.name === `speculation/${terminal.kind}` &&
			event.payload.candidate_id === terminal.candidateId,
	);
	const payload =
		terminal.kind === "resolve"
			? {
					candidate_id: terminal.candidateId,
					outcome: terminal.outcome,
					latency_bucket: terminal.latencyBucket,
				}
			: { candidate_id: terminal.candidateId, outcome: terminal.outcome };
	if (existing) {
		if (JSON.stringify(existing.payload) !== JSON.stringify(payload))
			throw new PromotionError("digest");
		return;
	}
	const input: EventInput = {
		kind: "observe",
		name: `speculation/${terminal.kind}`,
		payload,
	};
	log.appendBatchDurable(() => [input]);
}
