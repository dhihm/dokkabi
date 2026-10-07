export class CowCandidateError extends Error {
	readonly name = "CowCandidateError";
	constructor(
		readonly code:
			| "aborted"
			| "disposed"
			| "invalid"
			| "tool_failed"
			| "worker_failed",
		message?: string,
	) {
		super(message ?? `Tier 2 candidate ${code.replaceAll("_", " ")}`);
	}
}
