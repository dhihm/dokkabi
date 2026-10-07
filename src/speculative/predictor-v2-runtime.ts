import { canonicalJson } from "../host/canonical.ts";
import { buildLexicalIndex } from "./lexical.ts";
import { canonicalPredictorV2 } from "./predictor-v2-codec.ts";
import {
  PREDICTOR_ARTIFACT_MAX_BYTES,
  PredictorV2Error,
  type PredictorStage1Row,
  type PredictorTopologyEdge,
  type PredictorV2Artifact,
} from "./predictor-v2-schema.ts";
import {
  createCanonicalPredictionRoot,
  extractReadPredictionsAtRoot,
  safeRelativeFile,
  validateCanonicalPredictionRoot,
  type CanonicalPredictionRoot,
  type ValidatedPredictionRoot,
} from "./targets.ts";

export type PredictorObservation = {
  readonly tool: string;
  readonly text: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
  readonly exitCode: number | null;
  readonly turnNumber: number;
};

export type PredictedCall =
  | { readonly tool: "read"; readonly args: { readonly path: string }; readonly source: "output" }
  | { readonly tool: "read"; readonly args: { readonly path: string }; readonly source: "topology" }
  | { readonly tool: "read"; readonly args: { readonly path: string }; readonly source: "lexical" }
  | { readonly tool: "read"; readonly args: { readonly path: string }; readonly source: "transition" };

export type PredictorMetrics = {
  readonly tableBuilds: 1;
  readonly stage1SerializedBytes: number;
  readonly artifactSerializedBytes: number;
  readonly retainedRuntimeEstimateBytes: number;
  readonly retainedRuntimeEstimateBoundary: "encoded owned table/index entries; not JavaScript heap";
};

export interface Predictor {
  readonly metrics: PredictorMetrics;
  predictTool(observation: PredictorObservation): string | undefined;
  predict(observation: PredictorObservation): readonly PredictedCall[];
}

type TargetContext = {
  readonly root: CanonicalPredictionRoot;
  readonly topology: ReadonlyMap<string, readonly string[]>;
  readonly coEdits: ReadonlyMap<string, readonly string[]>;
  readonly lexicalSearch: (query: string, limit?: number) => readonly string[];
  readonly limit: number;
};

type TargetAccumulator = {
  readonly calls: PredictedCall[];
  readonly seen: Set<string>;
  readonly context: TargetContext;
  readonly root: ValidatedPredictionRoot;
};

export function createPredictor(
  artifact: PredictorV2Artifact,
  runtime: { readonly workspaceRoot?: string } = {},
): Predictor {
  const stage1 = new Map(artifact.stage1.map((row) => [featureKey(row), row.next_tool]));
  const topology = compileTopology(artifact.targets.topology);
  const coEdits = compileCoEdits(artifact.targets.co_edits);
  const lexical = buildLexicalIndex(artifact.targets.lexical_documents.map((document) => ({
    path: document.path,
    symbols: [...document.symbols],
  })));
  const workspaceRoot = runtime.workspaceRoot ? createCanonicalPredictionRoot(runtime.workspaceRoot) : undefined;
  const artifactSerializedBytes = Buffer.byteLength(canonicalPredictorV2(artifact), "utf8");
  const retainedRuntimeEstimateBytes = retainedBytes({ stage1, topology, coEdits, lexicalBytes: lexical.byteLength });
  if (artifactSerializedBytes + retainedRuntimeEstimateBytes >= PREDICTOR_ARTIFACT_MAX_BYTES) {
    throw new PredictorV2Error("predictor v2 serialized artifact plus retained runtime estimate must be smaller than 5 MiB");
  }
  const metrics = Object.freeze({
    tableBuilds: 1 as const,
    stage1SerializedBytes: Buffer.byteLength(canonicalJson(artifact.stage1), "utf8"),
    artifactSerializedBytes,
    retainedRuntimeEstimateBytes,
    retainedRuntimeEstimateBoundary: "encoded owned table/index entries; not JavaScript heap" as const,
  });
  const predictTool = (observation: PredictorObservation): string | undefined => {
    const exact = observationKey(observation, bucket(observation.turnNumber));
    return stage1.get(exact) ?? stage1.get(observationKey(observation, "any"));
  };
  return Object.freeze({
    metrics,
    predictTool,
    predict(observation: PredictorObservation): readonly PredictedCall[] {
      if (predictTool(observation) !== "read" || !workspaceRoot) return Object.freeze([]);
      return targetCalls({
        root: workspaceRoot,
        topology,
        coEdits,
        lexicalSearch: lexical.search.bind(lexical),
        limit: artifact.limits.max_calls,
      }, observation);
    },
  });
}

function targetCalls(
  context: TargetContext,
  observation: PredictorObservation,
): readonly PredictedCall[] {
  const root = validateCanonicalPredictionRoot(context.root);
  if (!root) return Object.freeze([]);
  const outputPaths = extractReadPredictionsAtRoot(root, {
    tool: observation.tool,
    text: observation.text,
  }).map((entry) => entry.path);
  const accumulator: TargetAccumulator = { calls: [], seen: new Set<string>(), context, root };
  for (const path of outputPaths) addRead(accumulator, path, "output");
  if (accumulator.calls.length < context.limit) {
    for (const source of outputPaths) {
      for (const path of context.topology.get(source) ?? []) addRead(accumulator, path, "topology");
    }
  }
  if (accumulator.calls.length < context.limit) {
    for (const source of outputPaths) {
      for (const path of context.coEdits.get(source) ?? []) addRead(accumulator, path, "topology");
    }
  }
  if (accumulator.calls.length < context.limit) {
    for (const path of context.lexicalSearch(observation.text, context.limit)) addRead(accumulator, path, "lexical");
  }
  return Object.freeze(accumulator.calls);
}

function addRead(
  accumulator: TargetAccumulator,
  candidate: string,
  source: "output" | "topology" | "lexical",
): void {
  if (accumulator.calls.length >= accumulator.context.limit || accumulator.seen.has(candidate)) return;
  const path = source === "output" ? candidate : safeRelativeFile(accumulator.root.path, candidate);
  if (!path || accumulator.seen.has(path)) return;
  accumulator.seen.add(path);
  accumulator.calls.push(Object.freeze({ tool: "read", args: Object.freeze({ path }), source }));
}

function compileTopology(edges: readonly PredictorTopologyEdge[]): ReadonlyMap<string, readonly string[]> {
  const ranked = new Map<string, Array<{ readonly path: string; readonly rank: number }>>();
  for (const edge of edges) {
    if (edge.relation === "imports" || edge.relation === "calls") {
      const incoming = ranked.get(edge.to) ?? [];
      incoming.push({ path: edge.from, rank: 0 });
      ranked.set(edge.to, incoming);
    }
    const outgoing = ranked.get(edge.from) ?? [];
    outgoing.push({ path: edge.to, rank: edge.relation === "tested_by" ? 1 : 2 });
    ranked.set(edge.from, outgoing);
  }
  return new Map([...ranked].map(([source, targets]) => [source, uniqueRanked(targets)]));
}

function compileCoEdits(
  rules: readonly { readonly source: string; readonly target: string; readonly count: number }[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, Array<{ readonly path: string; readonly rank: number }>>();
  for (const rule of rules) {
    const targets = grouped.get(rule.source) ?? [];
    targets.push({ path: rule.target, rank: -rule.count });
    grouped.set(rule.source, targets);
  }
  return new Map([...grouped].map(([source, targets]) => [source, uniqueRanked(targets)]));
}

function uniqueRanked(targets: readonly { readonly path: string; readonly rank: number }[]): readonly string[] {
  const seen = new Set<string>();
  return targets.slice().sort((left, right) => left.rank - right.rank || compareText(left.path, right.path)).flatMap((target) => {
    if (seen.has(target.path)) return [];
    seen.add(target.path);
    return [target.path];
  });
}

function featureKey(row: PredictorStage1Row): string {
  return JSON.stringify([row.tool, row.is_error, row.exit_code, row.turn_bucket]);
}

function observationKey(observation: PredictorObservation, turnBucket: "any" | "early" | "middle" | "late"): string {
  return JSON.stringify([observation.tool, observation.isError, observation.exitCode, turnBucket]);
}

function bucket(turnNumber: number): "early" | "middle" | "late" {
  if (turnNumber <= 4) return "early";
  if (turnNumber <= 12) return "middle";
  return "late";
}

function retainedBytes(input: {
  readonly stage1: ReadonlyMap<string, string>;
  readonly topology: ReadonlyMap<string, readonly string[]>;
  readonly coEdits: ReadonlyMap<string, readonly string[]>;
  readonly lexicalBytes: number;
}): number {
  const tableBytes = [...input.stage1].reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
  return tableBytes + encodedMapBytes(input.topology) + encodedMapBytes(input.coEdits) + input.lexicalBytes;
}

function encodedMapBytes(values: ReadonlyMap<string, readonly string[]>): number {
  return [...values].reduce((total, [key, entries]) => total + Buffer.byteLength(key) + entries.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0), 0);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
