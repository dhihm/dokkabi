import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { serializeExactValue } from "./exact-cache-value.ts";
import { preparePromotion } from "./promotion.ts";
import {
	assertSourceCas,
	parseDecisionDigest,
	PromotionError,
	withPromotionLock,
} from "./source-cas.ts";
import { loadOrCreateRecoveryKey } from "./recovery-authority.ts";
import type { CowWorkerRequest } from "./cow-protocol.ts";
import type { ScheduledCandidate } from "./scheduler-types.ts";
import { toolArgumentsDigest } from "../host/tool-loop.ts";
import type {
	PreparedTier2Candidate,
	Tier2AuthorizedTest,
	Tier2CandidateExecutor,
	Tier2ExecutorOptions,
} from "./cow-types.ts";
import { createCowWorkerLease } from "./cow-lease.ts";
import { CowCandidateError } from "./cow-error.ts";
import { executeCowWorker, terminateCowWorker } from "./cow-process.ts";

export type {
	PreparedTier2Candidate,
	Tier2AuthorizedTest,
	Tier2CandidateExecutor,
	Tier2ExecutorOptions,
	Tier2ExecutorSnapshot,
} from "./cow-types.ts";
export { CowCandidateError } from "./cow-error.ts";

function exactJson(value: unknown): string | undefined {
	return serializeExactValue(value, 64 * 1024)?.json;
}

function isDigest(value: string): boolean {
	return /^[0-9a-f]{64}$/u.test(value);
}

function isToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const content = Object.getOwnPropertyDescriptor(value, "content");
	return Boolean(content && "value" in content && Array.isArray(content.value));
}

function selectedTool(
	candidate: ScheduledCandidate,
	tests: ReadonlyMap<string, Tier2AuthorizedTest>,
): "edit" | "write" | "bash" | undefined {
	if (candidate.tier !== 2) return undefined;
	if (candidate.tool === "edit" || candidate.tool === "write") {
		return candidate.provenance.kind === "queued_exact"
			? candidate.tool
			: undefined;
	}
	if (
		candidate.tool !== "bash" ||
		candidate.provenance.kind !== "authorized_recipe"
	)
		return undefined;
	const recipeId = candidate.provenance.recipeId;
	const recipe = tests.get(recipeId);
	if (
		!recipe ||
		recipe.args.command.length === 0 ||
		exactJson(recipe.args) !== exactJson(candidate.args)
	)
		return undefined;
	return "bash";
}

export function createTier2CandidateExecutor(
	options: Tier2ExecutorOptions,
): Tier2CandidateExecutor {
	const recoveryKey =
		options.recoveryKey ?? loadOrCreateRecoveryKey(options.sessionRoot);
	const tests = new Map(
		(options.authorizedTests ?? []).map((test) => [test.recipeId, test]),
	);
	const active = new Set<PreparedTier2Candidate>();
	const controllers = new Set<AbortController>();
	let disposed = false;
	return {
		async prepare(candidate, signal) {
			if (disposed) throw new CowCandidateError("disposed");
			const tool = selectedTool(candidate, tests);
			if (!tool) return undefined;
			const recipeId =
				candidate.provenance.kind === "authorized_recipe"
					? candidate.provenance.recipeId
					: undefined;
			const recipe =
				tool === "bash" && recipeId ? tests.get(recipeId) : undefined;
			const controller = new AbortController();
			controllers.add(controller);
			const operationSignal = AbortSignal.any([signal, controller.signal]);
			const lease = isDigest(candidate.id)
				? createCowWorkerLease(options.sessionRoot, candidate.id)
				: undefined;
			const request = {
				sourceRoot: options.sourceRoot,
				candidateId: candidate.id,
				tool,
				args: candidate.args,
				platform: options.platform ?? process.platform,
				...(recipe?.sourcePath && recipe.sourceDigest
					? {
							testSource: {
								path: recipe.sourcePath,
								digest: recipe.sourceDigest,
							},
						}
					: {}),
				...(lease ? { lease } : {}),
			} satisfies CowWorkerRequest;
			let execution: Awaited<ReturnType<typeof executeCowWorker>>;
			try {
				execution = await executeCowWorker(request, operationSignal);
			} catch (error) {
				controllers.delete(controller);
				throw error;
			}
			const { child, ready } = execution;
			if (operationSignal.aborted) {
				controllers.delete(controller);
				terminateCowWorker(child, ready.base.transientObjectRoot);
				throw new CowCandidateError("aborted");
			}
			if (!isToolResult(ready.result)) {
				controllers.delete(controller);
				terminateCowWorker(child, ready.base.transientObjectRoot);
				throw new CowCandidateError(
					"worker_failed",
					"candidate worker returned an invalid tool result",
				);
			}
			const hasMutation = ready.delta.patch.length > 0;
			const foregroundArgsDigest =
				exactJson(candidate.args) === undefined
					? undefined
					: toolArgumentsDigest(candidate.args);
			let promotion: ReturnType<typeof preparePromotion> | undefined;
			try {
				promotion = hasMutation
					? preparePromotion({
							base: ready.base,
							delta: ready.delta,
							decisionDigest: candidate.keyDigest,
							sessionRoot: options.sessionRoot,
							recoveryKey,
							...(candidate.provenance.kind === "queued_exact" &&
							tool !== "bash" &&
							foregroundArgsDigest &&
							isDigest(candidate.id)
								? {
										transaction: {
											candidateId: candidate.id,
											foregroundCallId: candidate.provenance.callId,
											tool,
											argsDigest: foregroundArgsDigest,
										},
									}
								: {}),
						})
					: undefined;
			} catch (error) {
				terminateCowWorker(child, ready.base.transientObjectRoot);
				throw error;
			}
			let terminal = false;
			let prepared: PreparedTier2Candidate;
			const finish = <Result>(action: () => Result): Result => {
				if (terminal) return action();
				terminal = true;
				operationSignal.removeEventListener("abort", onAbort);
				controllers.delete(controller);
				try {
					return action();
				} finally {
					active.delete(prepared);
					terminateCowWorker(child, ready.base.transientObjectRoot);
				}
			};
			const rollback = (): void => {
				promotion?.rollback();
			};
			const onAbort = (): void => {
				finish(rollback);
			};
			prepared = {
				result: ready.result,
				storageRoot: promotion?.storageRoot ?? "",
				decisionDigest: candidate.keyDigest,
				commit: (exactDigest) => {
					if (terminal) throw new PromotionError("consumed");
					return finish(() => {
						if (promotion) return promotion.commit(exactDigest);
						if (parseDecisionDigest(exactDigest) !== candidate.keyDigest)
							throw new PromotionError("digest");
						return withPromotionLock(
							ready.base.sourceRoot,
							() => {
								assertSourceCas(ready.base);
								return {
									tree: ready.base.tree,
									digest: ready.base.digest,
									runtimeDigest: ready.base.runtimeArtifacts.digest,
								};
							},
							candidate.id,
						);
					});
				},
				settle: (input) => {
					if (terminal) throw new PromotionError("consumed");
					return finish(() => promotion?.settle(input));
				},
				rollback: () => {
					finish(rollback);
				},
				dispose: () => {
					finish(() => promotion?.dispose());
				},
			};
			active.add(prepared);
			operationSignal.addEventListener("abort", onAbort, { once: true });
			return prepared;
		},
		authorizeTest(test) {
			if (disposed || tests.has(test.recipeId)) return false;
			tests.set(test.recipeId, Object.freeze(test));
			return true;
		},
		snapshot: () => ({ active: active.size, disposed }),
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const controller of controllers) controller.abort();
			for (const prepared of [...active]) prepared.dispose();
		},
	};
}
