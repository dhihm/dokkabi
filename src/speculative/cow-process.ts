import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
	CowWorkerReportSchema,
	type CowWorkerRequest,
	type CowWorkerReport,
} from "./cow-protocol.ts";
import { CowCandidateError } from "./cow-error.ts";
import { releaseCowWorkerLease } from "./cow-lease.ts";

export type CowWorkerReady = Extract<
	CowWorkerReport,
	{ readonly kind: "ready" }
>;

function workerEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		DOKKABI_SANDBOX: "on",
		DOKKABI_SANDBOX_NET: "deny",
		DOKKABI_EXTERNAL_KNOWLEDGE: "deny",
	};
}

export function terminateCowWorker(
	child: ChildProcessWithoutNullStreams,
	transientRoot?: string,
): void {
	child.stdin.destroy();
	if (
		transientRoot &&
		basename(transientRoot).startsWith("dokkabi-swarm-objects-") &&
		transientRoot.startsWith(`${realpathSync(tmpdir())}/`) &&
		existsSync(transientRoot)
	) {
		rmSync(transientRoot, { recursive: true, force: true });
	}
	child.kill("SIGTERM");
}

export async function executeCowWorker(
	request: CowWorkerRequest,
	signal: AbortSignal,
): Promise<{
	readonly child: ChildProcessWithoutNullStreams;
	readonly ready: CowWorkerReady;
}> {
	if (signal.aborted) {
		if (request.lease) releaseCowWorkerLease(request.lease);
		throw new CowCandidateError("aborted");
	}
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(
			process.execPath,
			[join(import.meta.dir, "cow-worker.ts")],
			{
				detached: process.platform !== "win32",
				env: workerEnvironment(),
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	} catch (error) {
		if (request.lease) releaseCowWorkerLease(request.lease);
		throw error;
	}
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-8_192);
	});
	let report: CowWorkerReport;
	try {
		report = await new Promise<CowWorkerReport>(
			(resolvePromise, rejectPromise) => {
			const lines = createInterface({
				input: child.stdout,
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			let settled = false;
			const finish = (outcome: () => void): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				lines.close();
				outcome();
			};
			const onAbort = (): void => {
				child.kill("SIGTERM");
			};
			signal.addEventListener("abort", onAbort, { once: true });
			lines.once("line", (line) =>
				finish(() => {
					try {
						resolvePromise(CowWorkerReportSchema.parse(JSON.parse(line)));
					} catch (error) {
						rejectPromise(error);
					}
				}),
			);
			child.once("close", () =>
				finish(() =>
					rejectPromise(
						signal.aborted
							? new CowCandidateError("aborted")
							: new CowCandidateError(
									"worker_failed",
									stderr || "candidate worker exited before reporting",
								),
					),
				),
			);
			child.once("error", (error) =>
				finish(() =>
					rejectPromise(new CowCandidateError("worker_failed", error.message)),
				),
			);
				child.stdin.write(`${JSON.stringify(request)}\n`);
			},
		);
	} catch (error) {
		await terminateFailedWorker(child);
		if (request.lease) releaseCowWorkerLease(request.lease);
		throw error;
	}
	if (report.kind === "error") {
		await terminateFailedWorker(child);
		if (request.lease) releaseCowWorkerLease(request.lease);
		const code =
			report.code === "tool_failed"
				? "tool_failed"
				: report.code === "aborted"
					? "aborted"
					: "worker_failed";
		throw new CowCandidateError(code, report.message);
	}
	return { child, ready: report };
}

async function terminateFailedWorker(
	child: ChildProcessWithoutNullStreams,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = new Promise<void>((resolvePromise) => {
		child.once("close", () => resolvePromise());
	});
	terminateCowWorker(child);
	await closed;
}
