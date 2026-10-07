import { projectObservationCoverage } from "./observation-schema.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { GENESIS_HASH, assertEventName, isEventKind, projectSessionReplaySchemas, type EventRecord } from "./schema.ts";
import { replayContract, replayDigest, type ReplayContract } from "./replay.ts";
import { projectGraphState } from "../graph/state-evidence.ts";
import { projectWorkReplay } from "../work/replay-evidence.ts";
import { projectAcceptanceReplay } from "../work/evidence/acceptance-replay.ts";
import type { EvidenceBodies } from "../work/evidence/projection.ts";
import { projectProviderInputs } from "./provider-input.ts";
import { projectModelLoopReplay } from "./model-loop-replay.ts";
import { auditResearchRequests } from "../eval/experiment/preflight.ts";

type Status = "passed" | "failed" | "unsupported" | "not_evaluated";
export interface ReplayAudit {
  observationCoverage: { status: Status; gaps: string[]; reason?: string };
  providerInput: { status: Status; requests: number; sends: number; reason?: string };
  structural: { status: Status; reason?: string };
  semantic: { status: Status; reason?: string; unsupported: string[]; incomplete_execution_starts: number[] };
  projection: { status: "computed" | "matched" | "mismatched" | "not_evaluated"; digest?: string; expected?: string };
  contract?: ReplayContract;
}

/** Audit an exact retained JSONL input, including an incomplete final line.
 * The operational EventLog reader may recover a prefix; an audit cannot claim
 * the omitted bytes were verified. No filesystem or clock is consulted here. */
export function parseReplayEvents(raw: string): EventRecord[] {
  if (raw && !raw.endsWith("\n")) throw new Error("replay input has an incomplete final line");
  const rows = raw ? raw.slice(0, -1).split("\n") : [];
  const events = rows.map((line, i) => {
    if (!line.trim()) throw new Error(`replay input has an empty row at ${i + 1}`);
    return JSON.parse(line) as EventRecord;
  });
  assertReplayStructure(events);
  return events;
}

export function assertReplayStructure(events: readonly EventRecord[]): void {
  let previous = GENESIS_HASH;
  for (const [index, event] of events.entries()) {
    if (!event || event.seq !== index + 1 || !isEventKind(event.kind) || typeof event.ts !== "string"
      || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Error(`invalid event envelope at ${index + 1}`);
    assertEventName(event.name);
    const { hash, ...unsigned } = event;
    if (event.prev_hash !== previous || createHash("sha256").update(canonicalJson(unsigned)).digest("hex") !== hash) throw new Error(`invalid event chain at ${event.seq}`);
    previous = hash;
  }
}

/** Structural validity, internal semantic consistency and checkpoint projection
 * equality answer different questions. None authenticates original history. */
export function auditReplay(events: readonly EventRecord[], bodies: EvidenceBodies = new Map(),
  options: { expectHash?: string; structuralError?: string } = {}): ReplayAudit {
  const result: ReplayAudit = { observationCoverage: { status: "not_evaluated", gaps: [] }, structural: { status: "not_evaluated" },
    providerInput: { status: "not_evaluated", requests: 0, sends: 0 },
    semantic: { status: "not_evaluated", unsupported: [], incomplete_execution_starts: [] },
    projection: { status: "not_evaluated", ...(options.expectHash ? { expected: options.expectHash } : {}) } };
  try {
    if (options.structuralError) throw new Error(options.structuralError);
    assertReplayStructure(events);
    result.structural.status = "passed";
  } catch (error) { result.structural = { status: "failed", reason: String(error) }; return result; }
  try {
    const coverage = projectObservationCoverage(events);
    result.observationCoverage = { status: !coverage.schema ? "unsupported" : coverage.gaps.length ? "failed" : "passed", gaps: coverage.gaps };
  } catch (error) {
    result.observationCoverage = { status: "failed", gaps: [], reason: String(error) };
    result.semantic = { ...result.semantic, status: "failed", reason: String(error) };
    return result;
  }
  try {
    const contract = replayContract(events, bodies);
    const inputs = projectProviderInputs(events, bodies);
    auditResearchRequests(events, bodies);
    result.providerInput = { status: inputs.requests.length ? "passed"
      : events.some(event => event.name === "model/usage" || event.name === "model/context_layers") ? "unsupported" : "not_evaluated",
      requests: inputs.requests.length, sends: inputs.sends.length,
      ...(!inputs.requests.length ? { reason: "no retained structured provider request; surface replay does not establish model input" } : {}) };
    const graph = projectGraphState(events), work = projectWorkReplay(events, bodies), acceptance = projectAcceptanceReplay(events, bodies);
    const unsupported = [
      ...(graph.unsupported.length ? [`legacy graph rows: ${graph.unsupported.join(",")}`] : []),
      ...(work.unsupported.length ? [`legacy work rows: ${work.unsupported.join(",")}`] : []),
      ...(acceptance.unsupported.length ? [`legacy acceptance rows: ${acceptance.unsupported.join(",")}`] : []),
    ];
    // A model-loop session replays as its contract §1 observe events alone;
    // the graph loop's work-replay-v1 enrollment is not its replay mode.
    const modelLoop = projectModelLoopReplay(events);
    if (!modelLoop.isModelLoop && !projectSessionReplaySchemas(events).featureStart.has("work-replay-v1")) unsupported.push("full state replay feature is not enrolled");
    result.semantic = { status: unsupported.length ? "unsupported" : "passed", unsupported, incomplete_execution_starts: work.incomplete };
    const digest = replayDigest(contract);
    result.projection = { ...result.projection, status: !options.expectHash ? "computed" : digest === options.expectHash ? "matched" : "mismatched", digest };
    result.contract = contract;
  } catch (error) {
    result.semantic = { ...result.semantic, status: "failed", reason: String(error) };
    result.providerInput = { ...result.providerInput, status: "not_evaluated", reason: "semantic projection failed" };
  }
  return result;
}
