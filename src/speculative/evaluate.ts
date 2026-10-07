import { createHash } from "node:crypto";
import type { EventRecord } from "../host/schema.ts";
import {
	evaluateProjectedCorpus,
	projectAcceptedCorpus,
} from "./evaluate-corpus.ts";

export type SpeculativeEvaluationProvenance = "real" | "fixture";

export interface SpeculativeEvaluationSession {
	readonly provenance: SpeculativeEvaluationProvenance;
	readonly digest: string;
	readonly events: readonly EventRecord[];
}

export interface SpeculativeEvaluationOptions {
	readonly holdoutSessionCount?: number;
}

export interface SpeculativeEvaluationReport {
	readonly schema: "dokkabi-speculative-evaluation-v1";
	readonly corpus_digest: string;
	readonly provenance: SpeculativeEvaluationProvenance | "mixed";
	readonly sessions: {
		readonly supplied: number;
		readonly train: number;
		readonly holdout: number;
		readonly accepted_train: number;
		readonly accepted_holdout: number;
	};
	readonly exclusions: {
		readonly queued_exact_calls: number;
	};
	readonly support: number;
	readonly hits: number;
	readonly total: number;
	readonly accuracy: number | null;
	readonly claimable: boolean;
	readonly sufficiency: {
		readonly threshold: number;
		readonly reasons: readonly SpeculativeEvaluationReason[];
		readonly advisories: readonly SpeculativeEvaluationAdvisory[];
		readonly wilson_lower_bound: number | null;
		readonly recommended_minimum_holdout_calls: number;
	};
}

export type SpeculativeEvaluationReason =
	| "fixture_evidence"
	| "mixed_provenance"
	| "training_transitions_missing"
	| "holdout_predictions_missing"
	| "accuracy_threshold_not_met";

export type SpeculativeEvaluationAdvisory =
	| "below_recommended_support"
	| "wilson_threshold_not_met";

export class SpeculativeEvaluationError extends Error {
	readonly code = "speculative_evaluation" as const;
}

const REPORT_SCHEMA = "dokkabi-speculative-evaluation-v1" as const;
const ACCURACY_THRESHOLD = 0.9;
const RECOMMENDED_MINIMUM_HOLDOUT_CALLS = 200;

export function evaluateSpeculativeSessions(
	sessions: readonly SpeculativeEvaluationSession[],
	options: SpeculativeEvaluationOptions = {},
): SpeculativeEvaluationReport {
	validateSessions(sessions);
	const holdoutSessionCount = resolveHoldoutCount(
		sessions.length,
		options.holdoutSessionCount,
	);
	const splitIndex = sessions.length - holdoutSessionCount;
	const train = sessions.slice(0, splitIndex);
	const holdout = sessions.slice(splitIndex);
	const trainCorpus = projectAcceptedCorpus(train);
	const holdoutCorpus = projectAcceptedCorpus(holdout);
	const provenance = corpusProvenance(sessions);
	const corpusDigest = digestCorpus(sessions, holdoutSessionCount);
	const evaluation = evaluateProjectedCorpus(
		trainCorpus.events,
		holdoutCorpus.events,
	);
	const accuracy =
		evaluation.total === 0 ? null : evaluation.hits / evaluation.total;
	const wilsonLowerBound =
		accuracy === null ? null : wilsonLower(evaluation.hits, evaluation.total);
	const reasons = sufficiencyReasons({
		provenance,
		trained: evaluation.trained,
		total: evaluation.total,
		accuracy,
	});
	const advisories = robustnessAdvisories(evaluation.total, wilsonLowerBound);
	return {
		schema: REPORT_SCHEMA,
		corpus_digest: corpusDigest,
		provenance,
		sessions: {
			supplied: sessions.length,
			train: train.length,
			holdout: holdout.length,
			accepted_train: trainCorpus.acceptedSessions,
			accepted_holdout: holdoutCorpus.acceptedSessions,
		},
		exclusions: {
			queued_exact_calls:
				trainCorpus.queuedExactCalls + holdoutCorpus.queuedExactCalls,
		},
		support: evaluation.total,
		hits: evaluation.hits,
		total: evaluation.total,
		accuracy,
		claimable: reasons.length === 0,
		sufficiency: {
			threshold: ACCURACY_THRESHOLD,
			reasons,
			advisories,
			wilson_lower_bound: wilsonLowerBound,
			recommended_minimum_holdout_calls: RECOMMENDED_MINIMUM_HOLDOUT_CALLS,
		},
	};
}

function validateSessions(
	sessions: readonly SpeculativeEvaluationSession[],
): void {
	if (sessions.length < 2)
		throw new SpeculativeEvaluationError(
			"evaluation requires at least two sessions",
		);
	const digests = new Set<string>();
	let previousStartedAt: number | undefined;
	for (const session of sessions) {
		if (session.provenance !== "real" && session.provenance !== "fixture") {
			throw new SpeculativeEvaluationError(
				"session provenance must be real or fixture",
			);
		}
		if (!/^[a-f0-9]{64}$/u.test(session.digest)) {
			throw new SpeculativeEvaluationError(
				"session digest must be canonical sha256",
			);
		}
		if (session.events.at(-1)?.hash !== session.digest) {
			throw new SpeculativeEvaluationError(
				"session digest does not match EventLog head",
			);
		}
		const startedAt = Date.parse(session.events[0]?.ts ?? "");
		if (!Number.isFinite(startedAt)) {
			throw new SpeculativeEvaluationError(
				"session start timestamp must be parseable",
			);
		}
		if (previousStartedAt !== undefined && startedAt < previousStartedAt) {
			throw new SpeculativeEvaluationError(
				"sessions must be ordered chronologically",
			);
		}
		previousStartedAt = startedAt;
		if (digests.has(session.digest)) {
			throw new SpeculativeEvaluationError(
				"session digest appears more than once",
			);
		}
		digests.add(session.digest);
	}
}

function resolveHoldoutCount(
	sessionCount: number,
	requested: number | undefined,
): number {
	const count = requested ?? Math.max(1, Math.ceil(sessionCount / 5));
	if (!Number.isSafeInteger(count) || count < 1 || count >= sessionCount) {
		throw new SpeculativeEvaluationError(
			"holdout session count must leave non-empty train and holdout sets",
		);
	}
	return count;
}

interface SufficiencyInput {
	readonly provenance: SpeculativeEvaluationReport["provenance"];
	readonly trained: boolean;
	readonly total: number;
	readonly accuracy: number | null;
}

function sufficiencyReasons(
	input: SufficiencyInput,
): readonly SpeculativeEvaluationReason[] {
	const reasons: SpeculativeEvaluationReason[] = [];
	if (input.provenance === "fixture") reasons.push("fixture_evidence");
	if (input.provenance === "mixed") reasons.push("mixed_provenance");
	if (!input.trained) reasons.push("training_transitions_missing");
	if (input.total === 0) reasons.push("holdout_predictions_missing");
	if (input.accuracy !== null && input.accuracy <= ACCURACY_THRESHOLD)
		reasons.push("accuracy_threshold_not_met");
	return reasons;
}

function robustnessAdvisories(
	total: number,
	wilsonLowerBound: number | null,
): readonly SpeculativeEvaluationAdvisory[] {
	const advisories: SpeculativeEvaluationAdvisory[] = [];
	if (total < RECOMMENDED_MINIMUM_HOLDOUT_CALLS)
		advisories.push("below_recommended_support");
	if (wilsonLowerBound !== null && wilsonLowerBound <= ACCURACY_THRESHOLD) {
		advisories.push("wilson_threshold_not_met");
	}
	return advisories;
}

function corpusProvenance(
	sessions: readonly SpeculativeEvaluationSession[],
): SpeculativeEvaluationReport["provenance"] {
	const first = sessions[0]?.provenance;
	return sessions.every((session) => session.provenance === first)
		? (first ?? "fixture")
		: "mixed";
}

function digestCorpus(
	sessions: readonly SpeculativeEvaluationSession[],
	holdoutSessionCount: number,
): string {
	const canonical = JSON.stringify({
		schema: REPORT_SCHEMA,
		holdout_session_count: holdoutSessionCount,
		sessions: sessions.map((session) => ({
			digest: session.digest,
			provenance: session.provenance,
		})),
	});
	return createHash("sha256").update(canonical).digest("hex");
}

function wilsonLower(hits: number, total: number): number {
	const z = 1.959963984540054;
	const observed = hits / total;
	const denominator = 1 + (z * z) / total;
	const centre = observed + (z * z) / (2 * total);
	const margin =
		z * Math.sqrt((observed * (1 - observed) + (z * z) / (4 * total)) / total);
	return (centre - margin) / denominator;
}
