import type { EventLog } from "../host/event-log.ts";
import type { SpeculationV2Reference } from "./events-v2-schema.ts";
import { cowWorkerLeaseActive } from "./cow-lease.ts";
import { appendPromotionTerminal } from "./promotion-transaction-settlement.ts";

export function cleanTier2Orphans(input: {
	readonly log: EventLog;
	readonly references: readonly SpeculationV2Reference[];
	readonly owned: ReadonlySet<string>;
	readonly sessionRoot: string;
	readonly providerDigest: string;
}) {
	const active = new Map<
		string,
		Extract<SpeculationV2Reference, { readonly name: "prepare" }>
	>();
	for (const row of input.references) {
		if (row.name === "prepare") active.set(row.candidate_id, row);
		else if (
			row.name === "resolve" ||
			(row.name === "recover" && row.outcome !== "refused")
		) {
			active.delete(row.candidate_id);
		}
	}
	let cleaned = 0;
	let refused = 0;
	for (const row of active.values()) {
		if (
			input.owned.has(row.candidate_id) ||
			row.tier !== 2 ||
			row.provider_digest !== input.providerDigest ||
			(row.source !== "queued_exact" && row.source !== "authorized_recipe")
		)
			continue;
		if (cowWorkerLeaseActive(input.sessionRoot, row.candidate_id)) {
			refused += 1;
			continue;
		}
		try {
			appendPromotionTerminal(input.log, {
				kind: "recover",
				candidateId: row.candidate_id,
				outcome: "cleaned",
			});
			cleaned += 1;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			refused += 1;
		}
	}
	return { restored: 0, cleaned, promoted: 0, refused };
}
