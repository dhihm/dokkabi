import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventLog } from "../host/event-log.ts";
import { projectSessionReplaySchemas } from "../host/schema.ts";
import { projectSpeculationV2References } from "./events-v2.ts";
import type { SpeculationV2Reference } from "./events-v2-schema.ts";
import { copyRecoveryKey, trustedSessionRoot } from "./promotion-journal.ts";
import { assertPromotionsDirectory } from "./promotion-storage.ts";
import { assertLegacyPromotionRecovery } from "./promotion-recovery-preflight.ts";
import {
	inspectPromotionRecoveryPlan,
	type PromotionRecoveryPlan,
} from "./promotion-transaction-plan.ts";
import { reconcilePromotionPlan } from "./promotion-transaction-settlement.ts";
import { cleanTier2Orphans } from "./promotion-transaction-orphans.ts";

export interface RecoverPromotionTransactionsInput {
	readonly sourceRoot: string;
	readonly sessionRoot: string;
	readonly recoveryKey: Uint8Array;
	readonly eventLog: EventLog;
	readonly providerDigest: string;
}

export interface PromotionTransactionRecoveryReport {
	readonly restored: number;
	readonly cleaned: number;
	readonly promoted: number;
	readonly refused: number;
}

export function recoverPromotionTransactions(
	input: RecoverPromotionTransactionsInput,
): PromotionTransactionRecoveryReport {
	const key = copyRecoveryKey(input.recoveryKey);
	const sessionRoot = trustedSessionRoot(input.sessionRoot);
	const sourceRoot = realpathSync(resolve(input.sourceRoot));
	const promotions = join(sessionRoot, "promotions");
	const references = referencesFor(input.eventLog);
	if (!existsSync(promotions))
		return cleanTier2Orphans({
			log: input.eventLog,
			references,
			owned: new Set(),
			sessionRoot,
			providerDigest: input.providerDigest,
		});
	assertPromotionsDirectory(sessionRoot);
	const transactionRoots = readdirSync(promotions)
		.sort()
		.map((name) => join(promotions, name))
		.filter((root) => existsSync(join(root, "transaction.json")));
	let plans: readonly PromotionRecoveryPlan[];
	try {
		assertLegacyPromotionRecovery(promotions, sessionRoot, sourceRoot, key);
		plans = transactionRoots.map((storageRoot) =>
			inspectPromotionRecoveryPlan({
				storageRoot,
				sourceRoot,
				key,
				log: input.eventLog,
				references,
				providerDigest: input.providerDigest,
			}),
		);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return {
			restored: 0,
			cleaned: 0,
			promoted: 0,
			refused: Math.max(1, transactionRoots.length),
		};
	}
	let restored = 0;
	let cleaned = 0;
	let promoted = 0;
	let refused = 0;
	const ownedCandidates = new Set(
		plans.map((plan) => plan.transaction.candidateId),
	);
	for (const plan of plans) {
		try {
			const outcome = reconcilePromotionPlan({
				plan,
				sourceRoot,
				sessionRoot,
				key,
				log: input.eventLog,
			});
			if (outcome === "restored") restored += 1;
			else if (outcome === "promoted") promoted += 1;
			else cleaned += 1;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			refused += 1;
		}
	}
	if (refused > 0) return { restored, cleaned, promoted, refused };
	const orphan = cleanTier2Orphans({
		log: input.eventLog,
		references: referencesFor(input.eventLog),
		owned: ownedCandidates,
		sessionRoot,
		providerDigest: input.providerDigest,
	});
	return {
		restored: restored + orphan.restored,
		cleaned: cleaned + orphan.cleaned,
		promoted: promoted + orphan.promoted,
		refused: orphan.refused,
	};
}

function referencesFor(log: EventLog): readonly SpeculationV2Reference[] {
	return projectSpeculationV2References(
		log.events,
		projectSessionReplaySchemas(log.events).featureStart.get("speculation-v2"),
	);
}
