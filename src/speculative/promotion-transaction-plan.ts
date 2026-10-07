import { lstatSync } from "node:fs";
import type { EventLog } from "../host/event-log.ts";
import {
	captureWorktreeSnapshot,
	releaseWorktreeSnapshot,
} from "../swarm/worktree.ts";
import type {
	SpeculationPrepareReference,
	SpeculationV2Reference,
} from "./events-v2-schema.ts";
import {
	assertJournalAuthority,
	readPromotionJournal,
	readPromotionTransaction,
	type PromotionForegroundAuthorization,
	type PromotionJournal,
	type PromotionTransactionJournal,
} from "./promotion-journal.ts";
import { PromotionError } from "./source-cas.ts";

export type PromotionRecoveryPlan = {
	readonly storageRoot: string;
	readonly journal: PromotionJournal;
	readonly transaction: PromotionTransactionJournal;
};

export function inspectPromotionRecoveryPlan(input: {
	readonly storageRoot: string;
	readonly sourceRoot: string;
	readonly key: Uint8Array;
	readonly log: EventLog;
	readonly references: readonly SpeculationV2Reference[];
	readonly providerDigest: string;
}): PromotionRecoveryPlan {
	const stat = lstatSync(input.storageRoot);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new PromotionError("rollback");
	const journal = readPromotionJournal(input.storageRoot, input.key);
	const transaction = readPromotionTransaction(input.storageRoot, input.key);
	assertJournalAuthority(journal, input.sourceRoot);
	if (
		journal.promotionId !== transaction.promotionId ||
		journal.decisionDigest !== transaction.candidateKeyDigest
	)
		throw new PromotionError("digest");
	let preparation: SpeculationPrepareReference | undefined;
	for (const row of input.references) {
		if (row.name === "prepare" && row.candidate_id === transaction.candidateId)
			preparation = row;
	}
	if (
		preparation?.tier !== 2 ||
		preparation.source !== "queued_exact" ||
		preparation.provider_digest !== input.providerDigest ||
		preparation.key_digest !== transaction.candidateKeyDigest ||
		preparation.tool !== transaction.foregroundTool
	)
		throw new PromotionError("digest");
	verifyTransactionForeground(transaction, input.log);
	if (transaction.phase === "committed")
		verifyCommitted(input.sourceRoot, journal, transaction);
	return { storageRoot: input.storageRoot, journal, transaction };
}

function verifyTransactionForeground(
	transaction: PromotionTransactionJournal,
	log: EventLog,
): void {
	switch (transaction.phase) {
		case "prepared":
			return;
		case "authorized":
		case "applying":
		case "committed":
			verifyForeground(transaction, transaction.foreground, log);
			return;
		case "resolved":
			if (!transaction.foreground) {
				if (transaction.terminal.kind === "resolve")
					throw new PromotionError("digest");
				return;
			}
			verifyForeground(transaction, transaction.foreground, log);
			return;
	}
}

function verifyForeground(
	transaction: PromotionTransactionJournal,
	foreground: PromotionForegroundAuthorization,
	log: EventLog,
): void {
	const record = log.events.find((event) => event.seq === foreground.eventSeq);
	if (
		!record ||
		record.hash !== foreground.eventHash ||
		record.name !== "tool/call" ||
		record.payload.id !== foreground.callId ||
		record.payload.name !== foreground.tool ||
		record.payload.args_digest !== foreground.argsDigest ||
		foreground.callId !== transaction.foregroundCallId ||
		foreground.tool !== transaction.foregroundTool ||
		foreground.argsDigest !== transaction.foregroundArgsDigest
	)
		throw new PromotionError("digest");
}

function verifyCommitted(
	root: string,
	journal: PromotionJournal,
	transaction: Extract<
		PromotionTransactionJournal,
		{ readonly phase: "committed" }
	>,
): void {
	const snapshot = captureWorktreeSnapshot(root, {
		isolatedObjects: true,
		runtimeArtifacts: journal.captureRuntimeArtifacts,
	});
	try {
		if (
			snapshot.tree !== transaction.finalTree ||
			snapshot.digest !== transaction.committedDigest ||
			snapshot.runtimeArtifacts.digest !== journal.runtimeDigest
		)
			throw new PromotionError("source_changed");
	} finally {
		releaseWorktreeSnapshot(snapshot);
	}
}
