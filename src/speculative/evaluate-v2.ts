import { createHash } from "node:crypto";
import {
	evaluateSpeculativeSessions,
	type SpeculativeEvaluationOptions,
	type SpeculativeEvaluationSession,
} from "./evaluate.ts";
import { projectAcceptedCorpus } from "./evaluate-corpus.ts";
import {
	canonicalPredictorV2,
	compilePredictorV2,
	createPredictor,
	type Predictor,
	type PredictorTrainingSnapshot,
	type PredictorV2Artifact,
	PredictorV2Error,
} from "./predictor.ts";
import { projectStage1 } from "./rules-v2-events.ts";

const ACCURACY_THRESHOLD = 0.9;
const RECOMMENDED_MINIMUM_HOLDOUT_CALLS = 200;

export type PredictorV2EvaluationReport = {
	readonly schema: "dokkabi-speculative-evaluation-v2";
	readonly format: "v2";
	readonly corpus_digest: string;
	readonly artifact_digest: string | null;
	readonly provenance: "real" | "fixture" | "mixed";
	readonly sessions: {
		readonly supplied: number;
		readonly train: number;
		readonly holdout: number;
		readonly accepted_train: number;
		readonly accepted_holdout: number;
	};
	readonly exclusions: { readonly queued_exact_calls: number };
	readonly support: number;
	readonly hits: number;
	readonly total: number;
	readonly accuracy: number | null;
	readonly by_tool: readonly {
		readonly tool: string;
		readonly support: number;
		readonly hits: number;
	}[];
	readonly claimable: boolean;
	readonly sufficiency: {
		readonly threshold: number;
		readonly wilson_lower_bound: number | null;
		readonly recommended_minimum_holdout_calls: number;
		readonly reasons: readonly string[];
		readonly advisories: readonly string[];
	};
};

export function evaluatePredictorV2Sessions(
	sessions: readonly SpeculativeEvaluationSession[],
	snapshot: PredictorTrainingSnapshot,
	options: SpeculativeEvaluationOptions = {},
): PredictorV2EvaluationReport {
	const base = evaluateSpeculativeSessions(sessions, options);
	const splitIndex = sessions.length - base.sessions.holdout;
	const train = projectAcceptedCorpus(sessions.slice(0, splitIndex));
	const holdout = projectAcceptedCorpus(sessions.slice(splitIndex));
	const holdoutProjection = projectStage1(holdout.events);
	let artifactDigest: string | null = null;
	let predictTool:
		| ((
				example: (typeof holdoutProjection.examples)[number],
		  ) => string | undefined)
		| undefined;
	try {
		const artifact = compilePredictorV2(train.events, snapshot);
		artifactDigest = createHash("sha256")
			.update(canonicalPredictorV2(artifact))
			.digest("hex");
		const predictor = createPredictor(artifact);
		predictTool = (example) =>
			predictor.predictTool({
				tool: example.tool,
				text: "",
				args: {},
				isError: example.isError,
				exitCode: example.exitCode,
				turnNumber: example.turnNumber,
			});
	} catch (error) {
		if (!(error instanceof PredictorV2Error) || !isEmptyTraining(error.message))
			throw error;
	}
	const evaluated = evaluateExamples(holdoutProjection.examples, predictTool);
	const { hits, total, tools } = evaluated;
	const accuracy = total === 0 ? null : hits / total;
	const wilson = total === 0 ? null : wilsonLower(hits, total);
	const reasons = sufficiencyReasons({
		provenance: base.provenance,
		trained: predictTool !== undefined,
		total,
		accuracy,
	});
	const advisories = robustnessAdvisories(total, wilson);
	return {
		schema: "dokkabi-speculative-evaluation-v2",
		format: "v2",
		corpus_digest: base.corpus_digest,
		artifact_digest: artifactDigest,
		provenance: base.provenance,
		sessions: base.sessions,
		exclusions: {
			queued_exact_calls: train.queuedExactCalls + holdout.queuedExactCalls,
		},
		support: total,
		hits,
		total,
		accuracy,
		by_tool: [...tools]
			.map(([tool, counts]) => ({ tool, ...counts }))
			.sort((left, right) => compareText(left.tool, right.tool)),
		claimable: reasons.length === 0,
		sufficiency: {
			threshold: ACCURACY_THRESHOLD,
			wilson_lower_bound: wilson,
			recommended_minimum_holdout_calls: RECOMMENDED_MINIMUM_HOLDOUT_CALLS,
			reasons,
			advisories,
		},
	};
}

export function evaluatePredictorV2Artifact(
	artifact: PredictorV2Artifact,
	events: readonly import("../host/schema.ts").EventRecord[],
): { readonly hits: number; readonly total: number } {
	return evaluatePredictorTransitions(createPredictor(artifact), events);
}

export function evaluatePredictorTransitions(
	predictor: Predictor,
	events: readonly import("../host/schema.ts").EventRecord[],
): { readonly hits: number; readonly total: number } {
	const examples = projectStage1(events).examples;
	return evaluateExamples(examples, (example) =>
		predictor.predictTool({
			tool: example.tool,
			text: "",
			args: {},
			isError: example.isError,
			exitCode: example.exitCode,
			turnNumber: example.turnNumber,
		}),
	);
}

export function strictlyImprovesHitRatio(
	candidate: { readonly hits: number; readonly total: number },
	baseline: { readonly hits: number; readonly total: number },
): boolean {
	return (
		candidate.total > 0 &&
		baseline.total > 0 &&
		candidate.hits * baseline.total > baseline.hits * candidate.total
	);
}

function sufficiencyReasons(input: {
	readonly provenance: "real" | "fixture" | "mixed";
	readonly trained: boolean;
	readonly total: number;
	readonly accuracy: number | null;
}): readonly string[] {
	const reasons: string[] = [];
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
	wilson: number | null,
): readonly string[] {
	const advisories: string[] = [];
	if (total < RECOMMENDED_MINIMUM_HOLDOUT_CALLS)
		advisories.push("below_recommended_support");
	if (wilson !== null && wilson <= ACCURACY_THRESHOLD)
		advisories.push("wilson_threshold_not_met");
	return advisories;
}

function evaluateExamples(
	examples: readonly import("./rules-v2-events.ts").Stage1Example[],
	predictTool:
		| ((
				example: import("./rules-v2-events.ts").Stage1Example,
		  ) => string | undefined)
		| undefined,
): {
	readonly hits: number;
	readonly total: number;
	readonly tools: ReadonlyMap<
		string,
		{ readonly support: number; readonly hits: number }
	>;
} {
	const tools = new Map<string, { support: number; hits: number }>();
	let hits = 0;
	for (const example of examples) {
		const hit = predictTool?.(example) === example.nextTool;
		const current = tools.get(example.tool) ?? { support: 0, hits: 0 };
		const aggregate = {
			support: current.support + 1,
			hits: current.hits + (hit ? 1 : 0),
		};
		if (hit) hits += 1;
		tools.set(example.tool, aggregate);
	}
	return { hits, total: examples.length, tools };
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

function isEmptyTraining(message: string): boolean {
	return (
		message === "no accepted EventLog trajectories to compile" ||
		message === "accepted trajectories contain no completed tool transitions"
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
