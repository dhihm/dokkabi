import type { EventRecord } from "../host/schema.ts";
import { projectAcceptedCorpus } from "./evaluate-corpus.ts";
import { acceptedSpeculativeTrajectories } from "./trajectories.ts";
import { PredictorV2Error, type PredictorStage1Row } from "./predictor-v2-schema.ts";

type CompletedCall = { readonly tool: string; readonly isError: boolean; readonly exitCode: number | null };
type CountGroup = {
  readonly call: CompletedCall;
  readonly bucket: "early" | "middle" | "late";
  readonly targets: Map<string, number>;
};

export type Stage1Compilation = {
  readonly trajectories: number;
  readonly samples: number;
  readonly rows: readonly PredictorStage1Row[];
};
export type Stage1Example = {
  readonly tool: string;
  readonly isError: boolean;
  readonly exitCode: number | null;
  readonly turnNumber: number;
  readonly nextTool: string;
};
export type Stage1Projection = {
  readonly trajectories: number;
  readonly excludedQueuedExact: number;
  readonly examples: readonly Stage1Example[];
};
export type Stage1Feature = {
  readonly tool: string;
  readonly isError: boolean;
  readonly exitCode: number | null;
  readonly bucket: "any" | "early" | "middle" | "late";
};

export function compileStage1(events: readonly EventRecord[]): Stage1Compilation {
  const projection = projectStage1(events);
  if (projection.trajectories === 0) throw new PredictorV2Error("no accepted EventLog trajectories to compile");
  if (projection.examples.length === 0) throw new PredictorV2Error("accepted trajectories contain no completed tool transitions");
  const counts = new Map<string, CountGroup>();
  for (const example of projection.examples) {
    const call = { tool: example.tool, isError: example.isError, exitCode: example.exitCode };
    const bucket = turnBucket(example.turnNumber);
    const key = stage1FeatureKey({ ...call, bucket });
    const group = counts.get(key) ?? { call, bucket, targets: new Map<string, number>() };
    group.targets.set(example.nextTool, (group.targets.get(example.nextTool) ?? 0) + 1);
    counts.set(key, group);
  }
  return { trajectories: projection.trajectories, samples: projection.examples.length, rows: bestRows(counts) };
}

export function projectStage1(events: readonly EventRecord[]): Stage1Projection {
  const projected = projectAcceptedCorpus([{ events }]);
  const trajectories = acceptedSpeculativeTrajectories(projected.events);
  const examples: Stage1Example[] = [];
  for (const trajectory of trajectories) {
    const calls = completedCalls(trajectory);
    for (let index = 0; index + 1 < calls.length; index += 1) {
      const previous = calls[index];
      const next = calls[index + 1];
      if (!previous || !next) continue;
      examples.push({
        tool: previous.tool,
        isError: previous.isError,
        exitCode: previous.exitCode,
        turnNumber: index + 1,
        nextTool: next.tool,
      });
    }
  }
  return { trajectories: trajectories.length, excludedQueuedExact: projected.queuedExactCalls, examples };
}

export function stage1FeatureKey(feature: Stage1Feature): string {
  return JSON.stringify([feature.tool, feature.isError, feature.exitCode, feature.bucket]);
}

export function compareStage1Rows(left: PredictorStage1Row, right: PredictorStage1Row): number {
  return compareText(
    stage1FeatureKey({ tool: left.tool, isError: left.is_error, exitCode: left.exit_code, bucket: left.turn_bucket }),
    stage1FeatureKey({ tool: right.tool, isError: right.is_error, exitCode: right.exit_code, bucket: right.turn_bucket }),
  );
}

function completedCalls(events: readonly EventRecord[]): readonly (CompletedCall | undefined)[] {
  const calls: Array<{ readonly id: string; readonly tool: string }> = [];
  const called = new Set<string>();
  const results = new Map<string, CompletedCall>();
  for (const event of events) {
    if (event.name === "tool/call") {
      const id = eventId(event);
      const named = event.payload.name;
      if (named !== undefined && event.payload.tool !== undefined && named !== event.payload.tool) {
        throw new PredictorV2Error("tool call has conflicting names");
      }
      const tool = eventTool(named ?? event.payload.tool, "tool/call");
      if (called.has(id)) throw new PredictorV2Error(`duplicate tool call ${id}`);
      called.add(id);
      calls.push({ id, tool });
    }
    if (event.name === "tool/result") {
      const id = eventId(event);
      if (!called.has(id)) continue;
      const tool = eventTool(event.payload.tool, "tool/result");
      if (typeof event.payload.error !== "boolean") throw new PredictorV2Error(`tool result ${id} has no error flag`);
      if (results.has(id)) throw new PredictorV2Error(`duplicate tool result ${id}`);
      const rawExit = event.payload.exit_code;
      if (rawExit !== undefined && (!Number.isSafeInteger(rawExit) || Number(rawExit) < 0)) {
        throw new PredictorV2Error(`tool result ${id} has invalid exit_code`);
      }
      results.set(id, { tool, isError: event.payload.error, exitCode: rawExit === undefined ? null : Number(rawExit) });
    }
  }
  return calls.map((call) => {
    const result = results.get(call.id);
    if (!result) return undefined;
    if (result.tool !== call.tool) throw new PredictorV2Error(`tool identity mismatch for ${call.id}`);
    return result;
  });
}

function bestRows(counts: ReadonlyMap<string, CountGroup>): readonly PredictorStage1Row[] {
  return [...counts.values()].map((group) => {
    const ranked = [...group.targets].sort(([leftTool, left], [rightTool, right]) => right - left || compareText(leftTool, rightTool));
    const best = ranked[0];
    if (!best) throw new PredictorV2Error("stage1 feature has no target");
    return {
      tool: group.call.tool,
      is_error: group.call.isError,
      exit_code: group.call.exitCode,
      turn_bucket: group.bucket,
      next_tool: best[0],
      support: best[1],
      total: ranked.reduce((sum, row) => sum + row[1], 0),
    };
  }).sort(compareStage1Rows);
}

function eventId(event: EventRecord): string {
  const id = event.payload.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 1024 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new PredictorV2Error(`${event.name} id is invalid`);
  }
  return id;
}

function eventTool(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
    throw new PredictorV2Error(`${label} tool is invalid`);
  }
  return value;
}

function turnBucket(turn: number): "early" | "middle" | "late" {
  if (turn <= 4) return "early";
  if (turn <= 12) return "middle";
  return "late";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
