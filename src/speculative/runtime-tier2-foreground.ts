import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { toolArgumentsDigest } from "../host/tool-loop.ts";
import type { DurableToolCallReceipt } from "../host/event-log.ts";
import type { SpeculationCandidate } from "./candidates.ts";
import type { PreparedTier2Candidate } from "./cow.ts";
import type {
	CandidateScheduler,
	SchedulerReceipt,
} from "./scheduler-types.ts";
import { PromotionError } from "./source-cas.ts";
import type {
	Tier2LatencyBucket,
	Tier2RuntimeOptions,
} from "./runtime-tier2-types.ts";

type Accepted = Extract<SchedulerReceipt, { readonly accepted: true }>;
type Execute = AgentTool["execute"];

type Tier2ForegroundInput = {
	readonly scheduler: CandidateScheduler<PreparedTier2Candidate>;
	readonly byCall: Map<string, Accepted>;
	readonly staged: Map<string, DurableToolCallReceipt>;
	readonly exact: (
		tool: string,
		args: unknown,
		callId: string,
	) => SpeculationCandidate | undefined;
	readonly consumeReceipt: Tier2RuntimeOptions["consumeForegroundReceipt"];
	readonly invalidate: () => void;
	readonly publish: (
		candidateId: string,
		outcome: "promoted" | "stale" | "failed" | "warm_only",
	) => boolean;
	readonly latency: (candidateId: string) => Tier2LatencyBucket;
	readonly requireRecovery: () => void;
};

export function bindTier2Foreground(
	input: Tier2ForegroundInput,
	tool: AgentTool,
): Execute {
	const fallback = (
		callId: string,
		args: unknown,
		signal?: AbortSignal,
		update?: Parameters<Execute>[3],
	): Promise<AgentToolResult<unknown>> => {
		input.invalidate();
		return tool.execute(callId, args, signal, update);
	};
	return async (callId, args, signal, update) => {
		const candidate = input.exact(tool.name, args, callId);
		const scheduled = input.byCall.get(callId);
		if (
			!candidate ||
			!scheduled ||
			scheduled.keyDigest !== candidate.keyDigest
		) {
			return fallback(callId, args, signal, update);
		}
		if (tool.name === "bash") {
			const owned = input.scheduler.take(scheduled.id);
			input.byCall.delete(callId);
			if (!owned) return fallback(callId, args, signal, update);
			owned.value.dispose();
			input.publish(scheduled.id, "warm_only");
			return tool.execute(callId, args, signal, update);
		}
		const opaque = input.staged.get(callId);
		input.staged.delete(callId);
		if (!opaque) return fallback(callId, args, signal, update);
		const record = input.consumeReceipt(opaque);
		if (
			record?.name !== "tool/call" ||
			record.payload.id !== callId ||
			record.payload.name !== tool.name ||
			record.payload.args_digest !== toolArgumentsDigest(args)
		) {
			return fallback(callId, args, signal, update);
		}
		const owned = input.scheduler.take(scheduled.id);
		input.byCall.delete(callId);
		if (!owned) return fallback(callId, args, signal, update);
		const prepared = owned.value;
		try {
			const settlement = prepared.settle({
				exactDigest: candidate.keyDigest,
				foreground: {
					callId,
					tool: tool.name === "edit" ? "edit" : "write",
					argsDigest: toolArgumentsDigest(args),
					eventSeq: record.seq,
					eventHash: record.hash,
				},
				latencyBucket: input.latency(scheduled.id),
			});
			if (!settlement) {
				owned.dispose?.();
				return fallback(callId, args, signal, update);
			}
			if (input.publish(scheduled.id, "promoted")) settlement.acknowledge();
			else {
				input.requireRecovery();
				input.scheduler.dispose();
			}
			return prepared.result;
		} catch (error) {
			owned.dispose?.();
			if (error instanceof PromotionError && error.code === "source_changed") {
				input.publish(scheduled.id, "stale");
				return fallback(callId, args, signal, update);
			}
			if (error instanceof PromotionError && error.code === "apply") {
				input.publish(scheduled.id, "failed");
				return fallback(callId, args, signal, update);
			}
			throw error;
		}
	};
}
