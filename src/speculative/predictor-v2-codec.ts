import { createHash } from "node:crypto";
import { canonicalJson } from "../host/canonical.ts";
import { buildLexicalIndex } from "./lexical.ts";
import {
  PREDICTOR_ARTIFACT_MAX_BYTES,
  PREDICTOR_STAGE1_MAX_BYTES,
  PredictorV2Error,
  predictorV2Schema,
  type PredictorV2Artifact,
} from "./predictor-v2-schema.ts";

export function canonicalPredictorV2(artifact: PredictorV2Artifact): string {
  return `${canonicalJson(artifact)}\n`;
}

export function parsePredictorV2(text: string): PredictorV2Artifact {
  if (Buffer.byteLength(text, "utf8") > PREDICTOR_ARTIFACT_MAX_BYTES) {
    throw new PredictorV2Error("predictor v2 artifact exceeds 5 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PredictorV2Error("predictor v2 artifact is not valid JSON");
  }
  const parsed = predictorV2Schema.safeParse(value);
  if (!parsed.success) throw new PredictorV2Error("predictor v2 artifact has unknown or missing fields");
  const canonical = canonicalPredictorV2(parsed.data);
  if (canonical !== text) throw new PredictorV2Error("predictor v2 artifact is not canonical JSON");
  assertPredictorV2Bounds(parsed.data);
  assertCanonicalContents(parsed.data);
  return parsed.data;
}

function assertCanonicalContents(artifact: PredictorV2Artifact): void {
  assertSortedUnique(artifact.stage1, (row) => JSON.stringify([row.tool, row.is_error, row.exit_code, row.turn_bucket]), "stage1");
  if (artifact.stage1.some((row) => row.support > row.total)) throw new PredictorV2Error("predictor v2 stage1 support exceeds total");
  assertSortedUnique(artifact.targets.topology, (edge) => JSON.stringify([edge.from, edge.to, edge.relation]), "topology");
  assertSortedUnique(artifact.targets.lexical_documents, (document) => document.path, "lexical documents");
  for (const document of artifact.targets.lexical_documents) {
    assertSortedUnique(document.symbols, (symbol) => symbol, `lexical symbols for ${document.path}`);
  }
  assertSortedUnique(artifact.targets.co_edits, (rule) => JSON.stringify([rule.source, rule.target]), "co-edits");
  const topologyDigest = digest(artifact.targets.topology);
  const lexicalDigest = buildLexicalIndex(artifact.targets.lexical_documents).digest;
  const coeditDigest = digest(artifact.targets.co_edits);
  if (artifact.digests.topology !== topologyDigest || artifact.digests.lexical !== lexicalDigest || artifact.digests.coedit !== coeditDigest) {
    throw new PredictorV2Error("predictor v2 target digest is inconsistent");
  }
}

function assertSortedUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  let previous: string | undefined;
  for (const value of values) {
    const current = key(value);
    if (previous !== undefined && previous >= current) throw new PredictorV2Error(`predictor v2 ${label} must be unique and sorted`);
    previous = current;
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertPredictorV2Bounds(artifact: PredictorV2Artifact): void {
  const stage1Bytes = Buffer.byteLength(canonicalJson(artifact.stage1), "utf8");
  if (stage1Bytes >= PREDICTOR_STAGE1_MAX_BYTES) {
    throw new PredictorV2Error("predictor v2 stage1 table must be smaller than 100 KiB");
  }
  const artifactBytes = Buffer.byteLength(canonicalPredictorV2(artifact), "utf8");
  if (artifactBytes >= PREDICTOR_ARTIFACT_MAX_BYTES) {
    throw new PredictorV2Error("predictor v2 artifact must be smaller than 5 MiB");
  }
}
