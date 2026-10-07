import { canonicalJson } from "../../host/canonical.ts";
import type { EventLog } from "../../host/event-log.ts";
import type { EventRecord } from "../../host/schema.ts";
import type { RecordedOutput } from "../../tools/recorded-output.ts";
import type { RunnerResultAdapter } from "./contract.ts";
import { readPytestOutcome } from "./pytest.ts";
import { createHash } from "node:crypto";
import { refusedOutcome } from "./contract.ts";

export const RUNNER_RESULT = "work/runner_result";

function processRefusal(value: unknown) {
  const execution = value as { timed_out?: boolean; signal?: string; error?: string };
  return execution.timed_out ? refusedOutcome("incomplete", "native test process timed out")
    : execution.signal ? refusedOutcome("cancelled", `native test process ended with ${execution.signal}`)
    : refusedOutcome("execution_unavailable", "native test process did not complete");
}

export function recordRunnerResult(log: EventLog, caseId: string, command: string,
  adapter: RunnerResultAdapter, recorded: RecordedOutput) {
  if (!recorded.ok && recorded.code !== "process_completion_unavailable") return undefined;
  const source = log.events.find(row => row.seq === recorded.seq && row.hash === recorded.hash);
  const outcome = recorded.ok ? adapter.read(recorded.body, recorded.exitCode) : processRefusal(source!.payload.execution);
  const event = log.append({ kind: "observe", name: RUNNER_RESULT, payload: {
    case_id: caseId, command, adapter: adapter.id, adapter_digest: adapter.digest,
    result_seq: recorded.seq, result_hash: recorded.hash, outcome, evidence_level: "workspace_reported",
  } });
  return { outcome, reference: { seq: event.seq, hash: event.hash } };
}

/** Replay uses recorded bytes, not the current runner registry or a model's
 * summary. Historical sessions without this event keep their original policy. */
export function validateRunnerResults(events: readonly EventRecord[], bodies: ReadonlyMap<string, unknown>): void {
  for (const event of events) {
    if (event.name !== RUNNER_RESULT) continue;
    const p = event.payload;
    if (event.kind !== "observe" || p.adapter !== "pytest-report-v1" || p.evidence_level !== "workspace_reported"
      || typeof p.adapter_digest !== "string" || !/^[a-f0-9]{64}$/u.test(p.adapter_digest)) {
      throw new Error("unknown native runner result contract");
    }
    const source = events.find(row => row.seq === p.result_seq && row.hash === p.result_hash && row.name === "tool/result");
    if (source?.kind !== "surface") throw new Error("native runner result lacks its surface execution");
    const invocation = [...events].reverse().find(row => row.seq < (source?.seq ?? 0) && row.name === "work/runner_invocation");
    const state = source?.payload.recorded_output as { version?: number; storage?: string } | undefined;
    const body = state?.storage === "inline" ? source?.payload.text
      : state?.storage === "blob" && typeof source?.payload.blob === "string" ? bodies.get(source.payload.blob) : undefined;
    if (source?.payload.execution !== undefined) {
      if (!invocation || source.seq >= event.seq || invocation.payload.command !== p.command
        || invocation.payload.adapter !== p.adapter || invocation.payload.adapter_digest !== p.adapter_digest
        || canonicalJson(processRefusal(source.payload.execution)) !== canonicalJson(p.outcome)) {
        throw new Error("native runner interruption differs from its recorded execution");
      }
      continue;
    }
    if (!invocation || invocation.payload.command !== p.command || invocation.payload.adapter !== p.adapter
      || invocation.payload.adapter_digest !== p.adapter_digest || !source || source.seq >= event.seq
      || source.payload.execution !== undefined || typeof body !== "string"
      || typeof source.payload.exit_code !== "number" || source.payload.error !== (source.payload.exit_code !== 0)
      || state?.storage === "blob" && (createHash("sha256").update(body).digest("hex") !== source.payload.blob
        || Buffer.byteLength(body) !== source.payload.blob_bytes)
      || state?.version !== 1 || canonicalJson(readPytestOutcome(body, source.payload.exit_code)) !== canonicalJson(p.outcome)) {
      throw new Error("native runner result differs from its recorded execution");
    }
  }
}
