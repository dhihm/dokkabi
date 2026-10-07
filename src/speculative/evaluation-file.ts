import {
	closeSync,
	constants,
	fstatSync,
	mkdtempSync,
	openSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { EventLog } from "../host/event-log.ts";
import type { EventRecord } from "../host/schema.ts";
import type { SpeculativeEvaluationSession } from "./evaluate.ts";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const manifestSchema = z.strictObject({
	schema: z.literal("dokkabi-speculative-evaluation-manifest-v1"),
	holdout_session_count: z.number().int().positive().safe(),
	sessions: z
		.array(
			z.strictObject({
				path: z.string().min(1).max(4096),
				digest: z.string().regex(/^[a-f0-9]{64}$/u),
				provenance: z.enum(["real", "fixture"]),
			}),
		)
		.min(2)
		.max(256),
});

export type LoadedEvaluationManifest = {
	readonly sessions: readonly SpeculativeEvaluationSession[];
	readonly holdoutSessionCount: number;
};

export function loadEvaluationManifest(path: string): LoadedEvaluationManifest {
	const raw = boundedRead(path, MAX_MANIFEST_BYTES).toString("utf8");
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("speculative evaluation manifest is not valid JSON");
	}
	const manifest = manifestSchema.safeParse(value);
	if (!manifest.success)
		throw new Error(
			"speculative evaluation manifest has unknown or missing fields",
		);
	const base = dirname(path);
	const sessions = manifest.data.sessions.map((entry) => {
		const events = loadEventRecords(resolve(base, entry.path));
		if (events.at(-1)?.hash !== entry.digest)
			throw new Error("session digest does not match EventLog head");
		return { provenance: entry.provenance, digest: entry.digest, events };
	});
	return { sessions, holdoutSessionCount: manifest.data.holdout_session_count };
}

export function loadEventRecords(path: string): readonly EventRecord[] {
	const temporary = mkdtempSync(join(tmpdir(), "dokkabi-evaluation-log-"));
	try {
		const copy = join(temporary, "session.jsonl");
		writeFileSync(copy, boundedRead(path, MAX_SESSION_BYTES), { mode: 0o600 });
		return [...new EventLog(copy, { readOnly: true }).events];
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function boundedRead(path: string, maximum: number): Buffer {
	let descriptor: number;
	try {
		descriptor = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		throw new Error(`could not open bounded input ${path}`, { cause: error });
	}
	try {
		const stats = fstatSync(descriptor);
		if (!stats.isFile() || stats.nlink !== 1)
			throw new Error("bounded input must be a regular single-link file");
		if (stats.size > maximum)
			throw new Error("bounded input exceeds its byte limit");
		const bytes = Buffer.alloc(maximum + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(
				descriptor,
				bytes,
				offset,
				bytes.length - offset,
				null,
			);
			if (count === 0) break;
			offset += count;
		}
		if (offset > maximum)
			throw new Error("bounded input exceeds its byte limit");
		return bytes.subarray(0, offset);
	} finally {
		closeSync(descriptor);
	}
}
