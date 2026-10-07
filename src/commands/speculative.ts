import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "../host/canonical.ts";
import {
	resolveWorkspaceRoot,
	resolveWorkspaceSessionId,
	sessionLogPath,
} from "../host/paths.ts";
import { compileGitCoEdits } from "../speculative/coedit.ts";
import { evaluateSpeculativeSessions } from "../speculative/evaluate.ts";
import {
	evaluatePredictorTransitions,
	evaluatePredictorV2Sessions,
	strictlyImprovesHitRatio,
} from "../speculative/evaluate-v2.ts";
import {
	loadEvaluationManifest,
	loadEventRecords,
} from "../speculative/evaluation-file.ts";
import {
	canonicalPredictorV2,
	compilePredictorV2,
	createPredictor,
	loadSpeculativePredictor,
} from "../speculative/predictor.ts";
import { snapshotPredictorWorkspace } from "../speculative/predictor-v2-workspace.ts";
import {
	candidateImproves,
	canonicalSpeculativeRules,
	compileSpeculativeRules,
} from "../speculative/rules.ts";

type Format = "v1" | "v2";
type CompileOptions = {
	readonly format: Format;
	readonly logPath: string;
	readonly outputPath: string;
	readonly workspaceRoot: string;
};
type EvaluateOptions = {
	readonly format: Format;
	readonly manifestPath: string;
	readonly reportPath: string;
	readonly workspaceRoot: string;
};
export function runSpeculativeCommand(args: readonly string[]): number {
	if (args[0] === "--help" || args[0] === "-h") {
		process.stdout.write(
			"usage: dokkabi speculative compile --format v1|v2 ...\n       dokkabi speculative evaluate --sessions-file PATH [--format v1|v2] --json PATH\n",
		);
		return 0;
	}
	if (args[0] === "compile")
		return runCompile(parseCompileOptions(args.slice(1)));
	if (args[0] === "evaluate")
		return runEvaluate(parseEvaluateOptions(args.slice(1)));
	throw new Error("usage: dokkabi speculative compile|evaluate");
}

function runCompile(options: CompileOptions): number {
	if (!existsSync(options.logPath))
		throw new Error(`no EventLog at ${options.logPath}`);
	const events = loadEventRecords(options.logPath);
	if (options.format === "v1") {
		const candidate = compileSpeculativeRules(
			events,
			compileGitCoEdits(options.workspaceRoot),
		);
		if (existsSync(options.outputPath)) {
			const loaded = loadSpeculativePredictor(options.outputPath);
			if (loaded.format !== "v1")
				throw new Error("existing speculative output format does not match v1");
			if (!candidateImproves(candidate, loaded.artifact, events))
				throw new Error(
					"candidate speculative rules did not improve replay hit rate",
				);
		}
		atomicWrite(options.outputPath, canonicalSpeculativeRules(candidate));
		process.stdout.write(
			`speculative rules compiled: trajectories=${candidate.trajectories} transitions=${candidate.transitions.length}\noutput=${options.outputPath}\n`,
		);
		return 0;
	}
	const candidate = compilePredictorV2(
		events,
		snapshotPredictorWorkspace(options.workspaceRoot),
	);
	if (existsSync(options.outputPath)) {
		const loaded = loadSpeculativePredictor(options.outputPath);
		const before = evaluatePredictorTransitions(loaded.predictor, events);
		const after = evaluatePredictorTransitions(
			createPredictor(candidate),
			events,
		);
		if (!strictlyImprovesHitRatio(after, before))
			throw new Error(
				"candidate predictor v2 did not improve replay hit rate on the supplied evaluation corpus",
			);
	}
	atomicWrite(options.outputPath, canonicalPredictorV2(candidate));
	process.stdout.write(
		`speculative predictor v2 compiled: trajectories=${candidate.training.trajectories} transitions=${candidate.stage1.length}\noutput=${options.outputPath}\n`,
	);
	return 0;
}

function runEvaluate(options: EvaluateOptions): number {
	const manifest = loadEvaluationManifest(options.manifestPath);
	const evaluationOptions = {
		holdoutSessionCount: manifest.holdoutSessionCount,
	};
	const report =
		options.format === "v2"
			? evaluatePredictorV2Sessions(
					manifest.sessions,
					snapshotPredictorWorkspace(options.workspaceRoot),
					evaluationOptions,
				)
			: evaluateSpeculativeSessions(manifest.sessions, evaluationOptions);
	atomicWrite(options.reportPath, `${canonicalJson(report)}\n`);
	process.stdout.write(
		`speculative ${options.format} evaluation: hits=${report.hits} total=${report.total}\nreport=${options.reportPath}\n`,
	);
	return 0;
}

function parseCompileOptions(args: readonly string[]): CompileOptions {
	let format: Format = "v1";
	let session: string | undefined;
	let logPath: string | undefined;
	let outputPath: string | undefined;
	let workspaceFlag: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--format")
			format = parseFormat(
				requiredValue(args, ++index, "--format requires v1 or v2"),
			);
		else if (arg === "--session")
			session = requiredValue(args, ++index, "--session requires an ID");
		else if (arg === "--log")
			logPath = requiredValue(args, ++index, "--log requires a path");
		else if (arg === "--output")
			outputPath = requiredValue(args, ++index, "--output requires a path");
		else if (arg === "--workspace")
			workspaceFlag = requiredValue(
				args,
				++index,
				"--workspace requires a path",
			);
		else throw new Error(`unknown speculative compile flag ${arg}`);
	}
	if (session && logPath)
		throw new Error(
			"speculative compile accepts either --session or --log, not both",
		);
	if (
		session &&
		(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(session) ||
			session === "." ||
			session === "..")
	)
		throw new Error("--session must be a safe session ID");
	if (!outputPath) throw new Error("--output requires a path");
	// One workspace for the compile and for "this workspace's session",
	// resolved the way `dokkabi work` resolves it (D49).
	const workspaceRoot = resolveWorkspaceRoot(workspaceFlag);
	return {
		format,
		logPath: resolve(
			logPath ??
				sessionLogPath(session ?? resolveWorkspaceSessionId(workspaceRoot)),
		),
		outputPath: resolve(outputPath),
		workspaceRoot,
	};
}

function parseEvaluateOptions(args: readonly string[]): EvaluateOptions {
	let format: Format = "v2";
	let manifestPath: string | undefined;
	let reportPath: string | undefined;
	let workspaceRoot = process.cwd();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--format")
			format = parseFormat(
				requiredValue(args, ++index, "--format requires v1 or v2"),
			);
		else if (arg === "--sessions-file")
			manifestPath = requiredValue(
				args,
				++index,
				"--sessions-file requires a path",
			);
		else if (arg === "--json")
			reportPath = requiredValue(args, ++index, "--json requires a path");
		else if (arg === "--workspace")
			workspaceRoot = requiredValue(
				args,
				++index,
				"--workspace requires a path",
			);
		else throw new Error(`unknown speculative evaluate flag ${arg}`);
	}
	if (!manifestPath) throw new Error("--sessions-file requires a path");
	if (!reportPath) throw new Error("--json requires a path");
	return {
		format,
		manifestPath: resolve(manifestPath),
		reportPath: resolve(reportPath),
		workspaceRoot: resolve(workspaceRoot),
	};
}

function parseFormat(value: string): Format {
	if (value !== "v1" && value !== "v2")
		throw new Error("--format requires v1 or v2");
	return value;
}

function requiredValue(
	args: readonly string[],
	index: number,
	complaint: string,
): string {
	const value = args[index];
	if (!value || value.startsWith("--")) throw new Error(complaint);
	return value;
}

function atomicWrite(outputPath: string, body: string): void {
	mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
	const temporary = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
		renameSync(temporary, outputPath);
	} finally {
		rmSync(temporary, { force: true });
	}
}
