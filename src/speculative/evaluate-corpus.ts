import type { EventRecord } from "../host/schema.ts";
import {
	compileSpeculativeRules,
	evaluateSpeculativeRules,
	SpeculativeRulesError,
} from "./rules.ts";
import { acceptedSpeculativeTrajectories } from "./trajectories.ts";

export interface EventSession {
	readonly events: readonly EventRecord[];
}

export interface ProjectedCorpus {
	readonly events: readonly EventRecord[];
	readonly acceptedSessions: number;
	readonly queuedExactCalls: number;
}

export function projectAcceptedCorpus(
	sessions: readonly EventSession[],
): ProjectedCorpus {
	const events: EventRecord[] = [];
	let acceptedSessions = 0;
	let queuedExactCalls = 0;
	for (const session of sessions) {
		const accepted = acceptedSpeculativeTrajectories(session.events);
		if (accepted.length > 0) acceptedSessions += 1;
		for (const trajectory of accepted) {
			const eligible = excludeQueuedExact(trajectory);
			queuedExactCalls += eligible.excluded;
			events.push(...eligible.events);
		}
	}
	return { events, acceptedSessions, queuedExactCalls };
}

export function evaluateProjectedCorpus(
	trainEvents: readonly EventRecord[],
	holdoutEvents: readonly EventRecord[],
): {
	readonly hits: number;
	readonly total: number;
	readonly trained: boolean;
} {
	if (trainEvents.length === 0 || holdoutEvents.length === 0)
		return { hits: 0, total: 0, trained: false };
	try {
		const rules = compileSpeculativeRules(trainEvents);
		return { ...evaluateSpeculativeRules(rules, holdoutEvents), trained: true };
	} catch (error) {
		if (
			error instanceof SpeculativeRulesError &&
			isEmptyCorpusError(error.message)
		) {
			return { hits: 0, total: 0, trained: false };
		}
		throw error;
	}
}

function excludeQueuedExact(events: readonly EventRecord[]): {
	readonly events: readonly EventRecord[];
	readonly excluded: number;
} {
	const queuedIds = queuedExactIds(events);
	if (queuedIds.size === 0) return { events, excluded: 0 };
	const terminal = events.filter(
		(event) => event.name === "work/accept" || event.name === "work/checkpoint",
	);
	const groups: EventRecord[][] = [[]];
	for (const event of events) {
		if (event.name !== "tool/call" && event.name !== "tool/result") continue;
		const id = event.payload.id;
		if (typeof id === "string" && queuedIds.has(id)) {
			if (event.name === "tool/call" && groups.at(-1)?.length !== 0)
				groups.push([]);
			continue;
		}
		groups.at(-1)?.push(event);
	}
	return {
		events: groups.flatMap((group) =>
			group.length === 0 ? [] : [...group, ...terminal],
		),
		excluded: queuedIds.size,
	};
}

function queuedExactIds(events: readonly EventRecord[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const event of events) {
		if (
			(event.name === "tool/call" || event.name === "tool/result") &&
			isQueuedExact(event.payload)
		) {
			const id = event.payload.id;
			if (typeof id === "string") ids.add(id);
		}
	}
	return ids;
}

function isQueuedExact(payload: Readonly<Record<string, unknown>>): boolean {
	const value =
		payload.prediction_provenance ?? payload.provenance ?? payload.source;
	return (
		typeof value === "string" &&
		value.replaceAll("-", "_").toUpperCase() === "QUEUED_EXACT"
	);
}

function isEmptyCorpusError(message: string): boolean {
	return (
		message === "no accepted EventLog trajectories to compile" ||
		message === "accepted trajectories contain no completed tool transitions"
	);
}
