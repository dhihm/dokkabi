import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { parsePredictorV2 } from "./predictor-v2-codec.ts";
import { PREDICTOR_ARTIFACT_MAX_BYTES, PredictorV2Error, type PredictorV2Artifact } from "./predictor-v2-schema.ts";

export type LoadedPredictorV2 = {
  readonly artifact: PredictorV2Artifact;
  readonly digest: string;
};

export function loadPredictorV2(path: string): LoadedPredictorV2 {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new PredictorV2Error("predictor v2 artifact could not be opened safely", { cause: error });
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new PredictorV2Error("predictor v2 artifact must be a regular single-link file");
    }
    if (stats.size > PREDICTOR_ARTIFACT_MAX_BYTES) {
      throw new PredictorV2Error("predictor v2 artifact exceeds 5 MiB");
    }
    const bytes = readFileSync(descriptor);
    return {
      artifact: parsePredictorV2(bytes.toString("utf8")),
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}
