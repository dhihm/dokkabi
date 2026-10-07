import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	allocateSnapshotWorktree,
	captureWorktreeDelta,
	captureWorktreeSnapshot,
	releaseWorktreeSnapshot,
	removeSnapshotWorktree,
	type WorktreeSnapshot,
} from "../swarm/worktree.ts";
import {
	createPolicy,
	disposeSandboxPolicy,
	sandboxNetwork,
	type SandboxPolicy,
} from "../host/sandbox.ts";
import {
	createWorkspaceTools,
	disposeWorkspaceTools,
} from "../plugins/workspace-tools.ts";
import {
	CowWorkerRequestSchema,
	type CowWorkerReport,
} from "./cow-protocol.ts";
import { releaseCowWorkerLease } from "./cow-lease.ts";

class CowWorkerError extends Error {
	readonly name = "CowWorkerError";
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function failed(result: unknown): boolean {
	if (!result || typeof result !== "object") return true;
	const details = Reflect.get(result, "details");
	if (!details || typeof details !== "object") return false;
	if (
		Reflect.get(details, "error") === true ||
		Reflect.get(details, "cancelled") === true
	)
		return true;
	const exitCode =
		Reflect.get(details, "exitCode") ?? Reflect.get(details, "exit_code");
	return typeof exitCode === "number" && exitCode !== 0;
}

async function readRequest(): Promise<unknown> {
	const lines = createInterface({
		input: process.stdin,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		lines.close();
		return JSON.parse(line);
	}
	throw new CowWorkerError("protocol", "candidate worker request is missing");
}

async function waitForRelease(): Promise<void> {
	const lines = createInterface({
		input: process.stdin,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		if (line === "dispose") break;
	}
	lines.close();
}

let parentConnected = true;

function watchParent(): void {
	const disconnected = (): void => {
		parentConnected = false;
		controller.abort();
	};
	if (process.stdin.destroyed || process.stdin.readableEnded) disconnected();
	else {
		process.stdin.once("end", disconnected);
		process.stdin.once("close", disconnected);
		process.stdin.resume();
	}
}

async function run(): Promise<void> {
	const request = CowWorkerRequestSchema.parse(await readRequest());
	watchParent();
	try {
		const base = captureWorktreeSnapshot(request.sourceRoot, {
			isolatedObjects: true,
		});
		let heldBase: WorktreeSnapshot | undefined = base;
		const container = mkdtempSync(join(tmpdir(), "dokkabi-cow-"));
		const candidateRoot = join(container, "candidate");
		let tools: ReturnType<typeof createWorkspaceTools> | undefined;
		let policy: SandboxPolicy | undefined;
		try {
			if (controller.signal.aborted)
				throw new CowWorkerError("aborted", "candidate execution was aborted");
			allocateSnapshotWorktree(base, candidateRoot);
			if (controller.signal.aborted)
				throw new CowWorkerError("aborted", "candidate execution was aborted");
			if (request.testSource) {
				const target = realpathSync(
					resolve(candidateRoot, request.testSource.path),
				);
				const rel = relative(realpathSync(candidateRoot), target);
				if (
					rel === "" ||
					rel === ".." ||
					rel.startsWith(`..${sep}`) ||
					isAbsolute(rel)
				) {
					throw new CowWorkerError(
						"authority",
						"authorized test source changed",
					);
				}
				const digest = createHash("sha256")
					.update(readFileSync(target))
					.digest("hex");
				if (digest !== request.testSource.digest) {
					throw new CowWorkerError(
						"authority",
						"authorized test source changed",
					);
				}
			}
			policy = createPolicy({
				mode: "workspace-write",
				workspaceRoot: candidateRoot,
			});
			if (
				sandboxNetwork(policy) !== "deny" ||
				policy.workspaceRoot !== realpathSync(candidateRoot)
			) {
				throw new CowWorkerError(
					"authority",
					"candidate sandbox is not root-bound and network-denied",
				);
			}
			tools = createWorkspaceTools(candidateRoot, {
				policy,
				externalKnowledge: false,
				platform: request.platform,
				// A private copy for one call: the session's own authority
				// decides the effect when it is promoted (#221).
				versions: "speculative_candidate",
			});
			const tool = tools.find((item) => item.name === request.tool);
			if (!tool)
				throw new CowWorkerError(
					"unsupported",
					`ordinary tool ${request.tool} is unavailable`,
				);
			let result: Awaited<ReturnType<typeof tool.execute>>;
			try {
				result = await tool.execute(
					request.candidateId,
					request.args,
					controller.signal,
				);
			} catch (error) {
				if (controller.signal.aborted)
					throw new CowWorkerError(
						"aborted",
						"candidate execution was aborted",
					);
				throw new CowWorkerError(
					"tool_failed",
					error instanceof Error ? error.message : "ordinary tool failed",
				);
			}
			if (failed(result))
				throw new CowWorkerError(
					"tool_failed",
					`ordinary tool ${request.tool} failed`,
				);
			if (
				request.tool === "bash" &&
				JSON.stringify(result).includes(candidateRoot)
			) {
				throw new CowWorkerError(
					"result_not_portable",
					"authorized test result exposes its isolated workspace",
				);
			}
			if (controller.signal.aborted)
				throw new CowWorkerError("aborted", "candidate execution was aborted");
			const delta = captureWorktreeDelta(base, candidateRoot);
			if (request.tool === "bash" && delta.patch.length !== 0) {
				throw new CowWorkerError(
					"test_mutated",
					"authorized test changed promotable workspace bytes",
				);
			}
			disposeWorkspaceTools(tools);
			tools = undefined;
			disposeSandboxPolicy(policy);
			policy = undefined;
			const report = {
				kind: "ready",
				base: {
					...base,
					runtimeArtifacts: {
						...base.runtimeArtifacts,
						paths: [...base.runtimeArtifacts.paths],
					},
				},
				delta,
				result,
			} satisfies CowWorkerReport;
			process.stdout.write(`${JSON.stringify(report)}\n`);
			removeSnapshotWorktree(request.sourceRoot, candidateRoot);
			rmSync(container, { recursive: true, force: true });
			await waitForRelease();
			releaseWorktreeSnapshot(base);
			heldBase = undefined;
		} finally {
			if (tools) disposeWorkspaceTools(tools);
			if (policy) disposeSandboxPolicy(policy);
			if (heldBase) releaseWorktreeSnapshot(heldBase);
			rmSync(container, { recursive: true, force: true });
		}
	} finally {
		if (request.lease) releaseCowWorkerLease(request.lease);
	}
}

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());

try {
	await run();
} catch (error) {
	const code = error instanceof CowWorkerError ? error.code : "worker_failed";
	const message =
		error instanceof Error ? error.message : "unknown worker failure";
	const report = { kind: "error", code, message } satisfies CowWorkerReport;
	if (parentConnected) process.stdout.write(`${JSON.stringify(report)}\n`);
	process.exitCode = 1;
}
