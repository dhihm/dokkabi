import type { PredictionCandidateSeed } from "./candidates.ts";
import type { Predictor, PredictorObservation } from "./predictor.ts";
import type { SpeculationToolResult } from "./service.ts";
import { relatedCoEdits } from "./coedit.ts";
import { createToolPredictor, type SpeculativeRules } from "./rules.ts";
import { extractReadPredictions, safeRelativeFile } from "./targets.ts";

export function predictionProducer(
  predictor: Predictor | undefined,
  rules: SpeculativeRules | undefined,
  workspaceRoot: string,
  result: SpeculationToolResult,
  turnNumber: number,
): () => readonly PredictionCandidateSeed[] {
  return () => {
    const args = plainArgs(result.args);
    if (!args) return [];
    const observation: PredictorObservation = {
      tool: result.tool,
      text: result.text,
      args,
      isError: result.isError,
      exitCode: result.exitCode,
      turnNumber,
    };
    if (!predictor) return v1Predictions(rules, workspaceRoot, result);
    return predictor.predict(observation).flatMap((call) => {
      const source = call.source === "transition" ? "topology" : call.source;
      return call.tool === "read"
        ? [{ tool: "read", args: call.args, provenance: { kind: "prediction", source } }]
        : [];
    });
  };
}

function v1Predictions(
  rules: SpeculativeRules | undefined,
  workspaceRoot: string,
  result: SpeculationToolResult,
): readonly PredictionCandidateSeed[] {
  if (rules && createToolPredictor(rules)(result.tool, result.isError, result.exitCode) !== "read") return [];
  const direct = extractReadPredictions({ workspaceRoot, tool: result.tool, text: result.text });
  const related = relatedCoEdits(rules?.co_edits ?? [], direct.map((entry) => entry.path), 4)
    .flatMap((path) => {
      const safe = safeRelativeFile(workspaceRoot, path);
      return safe ? [safe] : [];
    });
  const predictions: PredictionCandidateSeed[] = [];
  for (const entry of direct) predictions.push(readSeed(entry.path, "output"));
  for (const path of related) predictions.push(readSeed(path, "topology"));
  return predictions;
}

function readSeed(path: string, source: "output" | "topology"): PredictionCandidateSeed {
  return { tool: "read", args: { path }, provenance: { kind: "prediction", source } };
}

function plainArgs(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}
