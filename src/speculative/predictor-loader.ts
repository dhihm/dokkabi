import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { parsePredictorV2 } from "./predictor-v2-codec.ts";
import { adaptV1Rules } from "./predictor-v2-compiler.ts";
import { createPredictor, type Predictor } from "./predictor-v2-runtime.ts";
import {
	PREDICTOR_ARTIFACT_MAX_BYTES,
	PREDICTOR_V2_SCHEMA,
	type PredictorV2Artifact,
	PredictorV2Error,
} from "./predictor-v2-schema.ts";
import {
	parseSpeculativeRules,
	SPECULATIVE_RULES_SCHEMA,
	type SpeculativeRules,
} from "./rules.ts";

const schemaEnvelope = z.object({ schema: z.string() }).passthrough();

export type LoadedSpeculativePredictor =
	| {
			readonly format: "v1";
			readonly artifact: SpeculativeRules;
			readonly predictor: Predictor;
			readonly digest: string;
	  }
	| {
			readonly format: "v2";
			readonly artifact: PredictorV2Artifact;
			readonly predictor: Predictor;
			readonly digest: string;
	  };

export function loadSpeculativePredictor(
	path: string,
	runtime: { readonly workspaceRoot?: string } = {},
): LoadedSpeculativePredictor {
	const bytes = readBoundedArtifact(path);
	const text = bytes.toString("utf8");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new PredictorV2Error(
			"speculative predictor artifact is not valid JSON",
		);
	}
	const envelope = schemaEnvelope.safeParse(value);
	if (!envelope.success)
		throw new PredictorV2Error("speculative predictor artifact has no schema");
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (envelope.data.schema === PREDICTOR_V2_SCHEMA) {
		const artifact = parsePredictorV2(text);
		return {
			format: "v2",
			artifact,
			predictor: createPredictor(artifact, runtime),
			digest,
		};
	}
	if (envelope.data.schema === SPECULATIVE_RULES_SCHEMA) {
		const artifact = parseSpeculativeRules(text);
		return {
			format: "v1",
			artifact,
			predictor: createPredictor(adaptV1Rules(artifact), runtime),
			digest,
		};
	}
	throw new PredictorV2Error("unsupported speculative predictor schema");
}

function readBoundedArtifact(path: string): Buffer {
	let descriptor: number;
	try {
		descriptor = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		throw new PredictorV2Error(
			"speculative predictor artifact could not be opened safely",
			{ cause: error },
		);
	}
	try {
		const stats = fstatSync(descriptor);
		if (!stats.isFile() || stats.nlink !== 1) {
			throw new PredictorV2Error(
				"speculative predictor artifact must be a regular single-link file",
			);
		}
		if (stats.size > PREDICTOR_ARTIFACT_MAX_BYTES) {
			throw new PredictorV2Error(
				"speculative predictor artifact exceeds 5 MiB",
			);
		}
		const bytes = Buffer.alloc(PREDICTOR_ARTIFACT_MAX_BYTES + 1);
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
		if (offset > PREDICTOR_ARTIFACT_MAX_BYTES) {
			throw new PredictorV2Error(
				"speculative predictor artifact exceeds 5 MiB",
			);
		}
		return bytes.subarray(0, offset);
	} finally {
		closeSync(descriptor);
	}
}
