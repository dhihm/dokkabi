import { createHash } from "node:crypto";
import type { EventRecord } from "../host/schema.ts";
import type { CoEditRule } from "./coedit.ts";
import { buildLexicalIndex, type LexicalDocument } from "./lexical.ts";
import { assertPredictorV2Bounds } from "./predictor-v2-codec.ts";
import { compareStage1Rows, compileStage1, stage1FeatureKey } from "./rules-v2-events.ts";
import {
  PREDICTOR_ARTIFACT_MAX_BYTES,
  PREDICTOR_MAX_CALLS,
  PREDICTOR_STAGE1_MAX_BYTES,
  PREDICTOR_V2_SCHEMA,
  coEditSchema,
  lexicalDocumentSchema,
  topologyEdgeSchema,
  type PredictorStage1Row,
  type PredictorTopologyEdge,
  type PredictorV2Artifact,
} from "./predictor-v2-schema.ts";
import type { SpeculativeRules } from "./rules-schema.ts";

export type PredictorTrainingSnapshot = {
  readonly topology: readonly PredictorTopologyEdge[];
  readonly lexicalDocuments: readonly LexicalDocument[];
  readonly coEdits: readonly CoEditRule[];
};

export function compilePredictorV2(events: readonly EventRecord[], snapshot: PredictorTrainingSnapshot): PredictorV2Artifact {
  const compiled = compileStage1(events);
  return buildArtifact({ adapter: "native-v2", trajectories: compiled.trajectories, samples: compiled.samples }, compiled.rows, snapshot);
}

export function adaptV1Rules(rules: SpeculativeRules): PredictorV2Artifact {
  const best = new Map<string, PredictorStage1Row>();
  for (const row of rules.transitions) {
    const candidate: PredictorStage1Row = {
      tool: row.previous_tool,
      is_error: row.previous_error,
      exit_code: row.previous_exit_code,
      turn_bucket: "any",
      next_tool: row.next_tool,
      support: row.count,
      total: row.total,
    };
    const key = stage1FeatureKey({ tool: candidate.tool, isError: candidate.is_error, exitCode: candidate.exit_code, bucket: "any" });
    const current = best.get(key);
    if (!current || candidate.support > current.support
      || (candidate.support === current.support && compareText(candidate.next_tool, current.next_tool) < 0)) best.set(key, candidate);
  }
  const rows = [...best.values()].sort(compareStage1Rows);
  return buildArtifact({ adapter: "v1-explicit", trajectories: rules.trajectories, samples: rules.samples }, rows, {
    topology: [], lexicalDocuments: [], coEdits: rules.co_edits,
  });
}

function buildArtifact(
  training: PredictorV2Artifact["training"] & PredictorV2Artifact["compatibility"],
  stage1: readonly PredictorStage1Row[],
  snapshot: PredictorTrainingSnapshot,
): PredictorV2Artifact {
  const topology = uniqueBy(topologyEdgeSchema.array().max(2048).parse(snapshot.topology), (edge) => JSON.stringify(edge)).sort(compareTopology);
  const lexicalDocuments = uniqueBy(lexicalDocumentSchema.array().max(256).parse(snapshot.lexicalDocuments), (document) => document.path)
    .map((document) => ({ path: document.path, symbols: [...new Set(document.symbols)].sort(compareText) }))
    .sort((left, right) => compareText(left.path, right.path));
  const coEdits = uniqueBy(coEditSchema.array().max(512).parse(snapshot.coEdits), (rule) => `${rule.source}\0${rule.target}`)
    .sort((left, right) => compareText(left.source, right.source) || compareText(left.target, right.target));
  const lexical = buildLexicalIndex(lexicalDocuments);
  const artifact: PredictorV2Artifact = {
    schema: PREDICTOR_V2_SCHEMA,
    compatibility: { adapter: training.adapter },
    training: { trajectories: training.trajectories, samples: training.samples },
    limits: { max_calls: PREDICTOR_MAX_CALLS, stage1_max_bytes: PREDICTOR_STAGE1_MAX_BYTES, artifact_max_bytes: PREDICTOR_ARTIFACT_MAX_BYTES },
    digests: {
      topology: digest(topology),
      lexical: lexical.digest,
      coedit: digest(coEdits),
    },
    stage1: [...stage1],
    targets: { topology, lexical_documents: lexicalDocuments, co_edits: coEdits },
  };
  assertPredictorV2Bounds(artifact);
  return artifact;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) if (!unique.has(key(value))) unique.set(key(value), value);
  return [...unique.values()];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareTopology(left: PredictorTopologyEdge, right: PredictorTopologyEdge): number {
  return compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.relation, right.relation);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
