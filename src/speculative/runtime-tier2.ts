import type { DurableToolCallReceipt } from "../host/event-log.ts";
import { createSpeculationCandidate } from "./candidates.ts";
import {
	createTier2CandidateExecutor,
	type PreparedTier2Candidate,
} from "./cow.ts";
import { createCandidateScheduler } from "./scheduler.ts";
import type {
	CandidateToolPolicy,
	SchedulerReceipt,
} from "./scheduler-types.ts";
import { recoverPromotions } from "./promotion-recovery.ts";
import { recoverPromotionTransactions } from "./promotion-transaction-recovery.ts";
import { loadOrCreateRecoveryKey } from "./recovery-authority.ts";
import {
	Tier2RecoveryRequiredError,
	type Tier2Runtime,
	type Tier2RuntimeOptions,
} from "./runtime-tier2-types.ts";
import {
	consumeTier2RuntimeRecipes,
	runtimeRecipeCurrent,
} from "./runtime-tier2-recipes.ts";
import { TIER2_PROVIDER_DIGEST } from "./runtime-tier2-provider.ts";
import { bindTier2Foreground } from "./runtime-tier2-foreground.ts";
import { createTier2Projector } from "./runtime-tier2-projector.ts";
import { tier2LatencyBucket } from "./runtime-tier2-latency.ts";

export type * from "./runtime-tier2-types.ts";
export { TIER2_PROVIDER_DIGEST } from "./runtime-tier2-provider.ts";

type Accepted = Extract<SchedulerReceipt, { readonly accepted: true }>;

export function createTier2Runtime(options: Tier2RuntimeOptions): Tier2Runtime {
	const enabled = options.mode === "full" && options.replay !== true;
	const recoveryKey =
		options.recoveryKey ??
		(enabled
			? loadOrCreateRecoveryKey(options.sessionRoot)
			: new Uint8Array(32));
	if (enabled) {
		const transactionRecovery = recoverPromotionTransactions({
			sourceRoot: options.sourceRoot,
			sessionRoot: options.sessionRoot,
			recoveryKey,
			eventLog: options.eventLog,
			providerDigest: TIER2_PROVIDER_DIGEST,
		});
		const legacyRecovery = recoverPromotions({
			sourceRoot: options.sourceRoot,
			sessionRoot: options.sessionRoot,
			recoveryKey,
		});
		if (transactionRecovery.refused > 0 || legacyRecovery.refused > 0)
			throw new Tier2RecoveryRequiredError();
	}
	const initialTests = consumeTier2RuntimeRecipes(
		options.sourceRoot,
		options.authorizedTestDispatch,
		options.authorizedTestRecipeIds ?? [],
	);
	const testTool =
		options.authorizedTestTool?.name === "bash" &&
		options.createBashResultAuthority
			? options.authorizedTestTool
			: undefined;
	const executor = createTier2CandidateExecutor({
		...options,
		authorizedTests: initialTests,
		recoveryKey,
	});
	const tests = new Map(initialTests.map((test) => [test.recipeId, test]));
	const byCall = new Map<string, Accepted>();
	const byRecipe = new Map<string, Accepted>();
	const staged = new Map<string, DurableToolCallReceipt>();
	const started = new Map<string, number>();
	let disposed = false;
	let recoveryRequired = false;
	const testPolicies: readonly CandidateToolPolicy[] = testTool
		? [{ name: testTool.name, authorizedRecipe: 2 }]
		: [];
	const policies: readonly CandidateToolPolicy[] = enabled
		? [
				{ name: "edit", queuedExact: 2 },
				{ name: "write", queuedExact: 2 },
				...testPolicies,
			]
		: [];
	const scheduler = createCandidateScheduler<PreparedTier2Candidate>({
		tools: policies,
		budget: { deadlineMs: 10_000, ...options.schedulerBudget },
		onState(event) {
			if (event.phase === "scheduled") started.set(event.id, performance.now());
			if (event.phase === "dropped" || event.phase === "disposed") {
				started.delete(event.id);
				for (const [callId, receipt] of byCall)
					if (receipt.id === event.id) byCall.delete(callId);
			}
			return options.onState?.(event) === true;
		},
		async execute(candidate, signal) {
			const prepared = await executor.prepare(candidate, signal);
			return prepared
				? { value: prepared, dispose: () => prepared.dispose() }
				: undefined;
		},
	});
	const clearCandidates = (): void => {
		scheduler.invalidate();
		byCall.clear();
		byRecipe.clear();
		staged.clear();
	};
	const exact = (tool: string, args: unknown, callId: string) =>
		createSpeculationCandidate(
			{ tool, args, provenance: { kind: "queued_exact", callId } },
			{
				tier: 2,
				maxCallBytes: options.schedulerBudget?.maxCallBytes ?? 64 * 1024,
			},
		);
	const publish = (
		candidateId: string,
		outcome: "promoted" | "stale" | "failed" | "warm_only",
	): boolean => {
		const value = options.onResolve?.({
			candidateId,
			outcome,
			latencyBucket: tier2LatencyBucket(
				performance.now() - (started.get(candidateId) ?? performance.now()),
			),
		});
		started.delete(candidateId);
		return value === "appended" || value === "already_durable";
	};
	let projector: ReturnType<typeof createTier2Projector>;
	const invalidate = (): void => {
		clearCandidates();
		projector.invalidate();
	};
	const foreground = {
		scheduler,
		byCall,
		staged,
		exact,
		consumeReceipt: options.consumeForegroundReceipt,
		invalidate,
		publish,
		latency: (candidateId: string) =>
			tier2LatencyBucket(
				performance.now() - (started.get(candidateId) ?? performance.now()),
			),
		requireRecovery: () => {
			recoveryRequired = true;
		},
	};
	projector = createTier2Projector({
		enabled,
		options,
		...(testTool ? { testTool } : {}),
		execute: (tool) => bindTier2Foreground(foreground, tool),
		clearCandidates,
		disposed: () => disposed,
	});
	return {
		project: (input) => projector.project(input),
		observeAgentEvent(event) {
			if (!enabled || disposed || recoveryRequired) return;
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "toolcall_end"
			) {
				const call = event.assistantMessageEvent.toolCall;
				const candidate = exact(call.name, call.arguments, call.id);
				const authorized = candidate
					? byRecipe.get(candidate.keyDigest)
					: undefined;
				if (authorized) {
					byCall.set(call.id, authorized);
					return;
				}
			}
			const receipt = scheduler.observeAgentEvent(event);
			if (
				receipt?.accepted &&
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "toolcall_end"
			) {
				byCall.set(event.assistantMessageEvent.toolCall.id, receipt);
			}
		},
		observeToolResult() {},
		requiresDurableForeground(tool, args) {
			if (
				!enabled ||
				disposed ||
				recoveryRequired ||
				(tool !== "edit" && tool !== "write")
			)
				return false;
			for (const [callId, receipt] of byCall) {
				if (receipt.keyDigest === exact(tool, args, callId)?.keyDigest)
					return true;
			}
			return false;
		},
		stageForegroundAuthorization(callId, receipt) {
			if (byCall.has(callId) && !staged.has(callId))
				staged.set(callId, receipt);
		},
		assertHealthy() { if (recoveryRequired) throw new Tier2RecoveryRequiredError(); },
		stageAuthorizedTests(dispatch, recipeIds) {
			if (!enabled || disposed || recoveryRequired) return 0;
			let accepted = 0;
			for (const recipe of consumeTier2RuntimeRecipes(options.sourceRoot, dispatch, recipeIds)) {
				if (executor.authorizeTest(recipe)) { tests.set(recipe.recipeId, recipe); accepted += 1; }
			}
			return accepted;
		},
		scheduleAuthorizedTest(recipeId) {
			const recipe = tests.get(recipeId);
			const rejected: SchedulerReceipt = Object.freeze({
				accepted: false,
				keyDigest: undefined,
				reason: "unsupported",
			});
			const receipt =
				recipe && runtimeRecipeCurrent(options.sourceRoot, recipe) && testTool
					? scheduler.enqueue({
							tool: "bash",
							args: recipe.args,
							provenance: { kind: "authorized_recipe", recipeId },
						})
					: rejected;
			if (receipt.accepted && recipe) {
				byRecipe.set(receipt.keyDigest, receipt);
			}
			return receipt;
		},
		idle: async () => {
			await scheduler.idle();
		},
		invalidate,
		dispose() {
			if (disposed) return;
			disposed = true;
			invalidate();
			scheduler.dispose();
			executor.dispose();
		},
		snapshot: () => ({ ...scheduler.snapshot(), revision: projector.revision(), recoveryRequired }),
	};
}
