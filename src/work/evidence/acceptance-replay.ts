import { createHash } from "node:crypto";
import type { EventRecord } from "../../host/schema.ts";
import { projectSessionReplaySchemas } from "../../host/schema.ts";
import { canonicalJson } from "../../host/canonical.ts";
import { evidenceDigest } from "./contract.ts";
import { projectEvidence, type EvidenceBodies } from "./projection.ts";
import { resultSchema } from "./schema.ts";
import { ACCEPTANCE_BODY_EVENTS, completeAcceptanceSpec, type AcceptanceContract } from "./acceptance-contract.ts";
import { deriveAcceptanceDecision, deriveAcceptanceProbe } from "./acceptance-decision.ts";
import { planObligations, type ObligationSnapshot } from "./obligations.ts";

export type AcceptanceCurrentObservation = { status: "unavailable"; reason: string } | {
  status: "observed"; contract: AcceptanceContract; authority: ObligationSnapshot;
  fixture_digest: string; delivered: unknown; evaluated: unknown | null; snapshot_closed: boolean;
};

/** Freshness is a comparison of retained world observations. A missing read
 * stays unavailable; replay never rereads the now-mutated candidate. */
export function deriveAcceptanceCurrent(observed: AcceptanceCurrentObservation, contract: AcceptanceContract,
  candidate: { delivered: string; evaluated: string; fixture_digest: string }): boolean {
  if (observed.status === "unavailable") {
    if (typeof observed.reason !== "string" || !observed.reason) throw new Error("acceptance current refusal is missing");
    return false;
  }
  if (observed.status !== "observed" || typeof observed.snapshot_closed !== "boolean") throw new Error("invalid acceptance current observation");
  const { digest, ...body } = observed.authority;
  if (evidenceDigest(body) !== digest || canonicalJson(body.obligations.map(({ key: _key, ...item }) => item)) !== canonicalJson(planObligations(body.plan, body.runners))) throw new Error("acceptance observed authority identity mismatch");
  return evidenceDigest(observed.contract) === evidenceDigest(contract) && observed.authority.scope_seq === contract.scope_seq
    && contract.obligations.every(item => observed.authority.obligations.some(row => row.key === item.key && row.signature === item.signature))
    && observed.fixture_digest === contract.fixture_digest && candidate.fixture_digest === contract.fixture_digest
    && evidenceDigest(observed.delivered) === candidate.delivered
    && (observed.snapshot_closed ? observed.evaluated === null : evidenceDigest(observed.evaluated) === candidate.evaluated);
}

type DecisionInput = Parameters<typeof deriveAcceptanceDecision>[0];
export function projectAcceptanceReplay(events: readonly EventRecord[], bodies: EvidenceBodies = new Map()) {
  const start = projectSessionReplaySchemas(events).featureStart.get("work-replay-v1");
  const references: { seq: number; name: string; digest: string }[] = [], unsupported: number[] = [];
  const retained = new Map<number, unknown>();
  const body = (event: EventRecord): unknown => {
    const value = bodies.get(String(event.payload.blob));
    if (value === undefined || evidenceDigest(value) !== event.payload.blob || Buffer.byteLength(canonicalJson(value)) !== event.payload.blob_bytes) throw new Error(`acceptance body integrity mismatch at ${event.seq}`);
    return value;
  };
  for (const event of events) {
    if (!ACCEPTANCE_BODY_EVENTS.has(event.name)) continue;
    if (start === undefined || event.seq < start) {
      if (event.name === "acceptance/current" || "replay_schema" in event.payload) throw new Error("acceptance replay evidence precedes its feature generation");
      unsupported.push(event.seq); continue;
    }
    if (event.kind !== "observe") throw new Error("acceptance evidence is not an observation");
    const value = body(event);
    retained.set(event.seq, value);
    references.push({ seq: event.seq, name: event.name, digest: evidenceDigest(value) });
    if (event.name !== "acceptance/decision") continue;
    if (event.payload.replay_schema !== 1) throw new Error("acceptance decision lost its replay schema");
    const recorded = value as { facts: DecisionInput; decision: ReturnType<typeof deriveAcceptanceDecision>; current_ref: string };
    const prefix = events.filter(row => row.seq < event.seq);
    const preceding = (name: string) => prefix.filter(row => row.name === name).at(-1);
    const candidateEvent = preceding("acceptance/candidate"), specificationEvent = preceding("acceptance/specification"), currentEvent = preceding("acceptance/current");
    if (!candidateEvent || !specificationEvent || !currentEvent || candidateEvent.seq >= specificationEvent.seq || specificationEvent.seq >= currentEvent.seq
      || currentEvent.payload.blob !== recorded.current_ref) throw new Error("acceptance decision has no current bound snapshot");
    const candidate = retained.get(candidateEvent.seq) as { candidate: { delivered: string; evaluated: string; fixture_digest: string }; delivered: unknown; evaluated: unknown };
    const spec = retained.get(specificationEvent.seq) as { contract: AcceptanceContract; review: string };
    const observed = retained.get(currentEvent.seq) as AcceptanceCurrentObservation;
    const facts = recorded.facts;
    if (evidenceDigest(candidate.delivered) !== candidate.candidate.delivered || evidenceDigest(candidate.evaluated) !== candidate.candidate.evaluated
      || evidenceDigest(candidate.candidate) !== facts.candidate_digest || evidenceDigest(spec.contract) !== facts.contract_digest
      || evidenceDigest(spec) !== facts.specification_digest || canonicalJson(spec.contract) !== canonicalJson(facts.contract) || spec.review !== facts.specification
      || facts.specification_complete !== completeAcceptanceSpec(spec.review, spec.contract)
      || facts.candidate_current !== deriveAcceptanceCurrent(observed, spec.contract, candidate.candidate)) throw new Error("acceptance decision snapshot binding mismatch");
    const authenticated = projectEvidence(prefix, bodies);
    for (const fact of facts.facts) {
      const index = authenticated.inputs.findIndex(input => input.receipt.execution_id === fact.execution_id && evidenceDigest(input.receipt) === fact.receipt_digest);
      const input = authenticated.inputs[index], decision = authenticated.decisions[index];
      if (!input || !decision || input.context.authority.role !== "acceptance_checker" || input.receipt.candidate_digest !== facts.candidate_digest
        || input.receipt.contract_digest !== evidenceDigest({ contract: spec.contract, specification_digest: facts.specification_digest })
        || decision.reason_codes.some(reason => reason !== "execution_not_passed")) throw new Error("acceptance fact has no authenticated receipt");
      const result = resultSchema.parse(bodies.get(input.receipt.body.blob));
      const output = result.output as { process?: unknown; template?: unknown; comparison?: unknown } | null;
      const nativeEvents = prefix.filter(row => row.seq > specificationEvent.seq && row.name === "acceptance/process"
        && (retained.get(row.seq) as { execution_id?: string } | undefined)?.execution_id === fact.execution_id);
      if (nativeEvents.length !== 1) throw new Error("acceptance fact lacks a unique native execution");
      const nativeEvent = nativeEvents[0]!;
      const native = retained.get(nativeEvent.seq) as { process: unknown; check_id: string; command: string; stdin: string; native_digest: string; boundary: { isolation: string; network: string; backend: string } };
      const command = fact.template.argv.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
      const execution = prefix.find(row => row.seq > specificationEvent.seq && row.seq < nativeEvent.seq && row.name === "sandbox/exec" && row.payload.digest === native.native_digest);
      const resultEvent = prefix.find(row => row.name === "evaluation/result" && row.payload.blob === input.receipt.body.blob);
      const dispatchEvent = prefix.find(row => row.name === "evaluation/dispatch" && row.payload.execution_id === fact.execution_id);
      const comparison = deriveAcceptanceProbe(fact.template, fact.process);
      if (!execution || !resultEvent || !dispatchEvent || dispatchEvent.seq >= execution.seq || nativeEvent.seq >= resultEvent.seq
        || execution.kind !== "effect" || execution.payload.mode !== "read-only" || execution.payload.network !== "deny"
        || !["seatbelt", "bwrap"].includes(String(execution.payload.backend))
        || execution.payload.command_digest !== createHash("sha256").update(command).digest("hex")
        || native.boundary?.isolation !== "protected-observer-v1" || native.boundary.network !== "deny" || native.boundary.backend !== execution.payload.backend
        || native.check_id !== fact.check_id || native.command !== command || native.stdin !== fact.template.stdin
        || canonicalJson(native.process) !== canonicalJson(fact.process) || !output || canonicalJson(output.process) !== canonicalJson(fact.process)
        || canonicalJson(output.template) !== canonicalJson(fact.template) || output.comparison !== comparison
        || result.outcome.status !== (comparison === "unavailable" ? "error" : comparison)
        || result.outcome.exit_code !== (comparison === "passed" ? 0 : comparison === "failed" ? 1 : null)
        || (comparison === "passed" && decision.status !== "admissible")) throw new Error("acceptance raw process and receipt disagree");
    }
    const decision = deriveAcceptanceDecision(facts);
    if (canonicalJson(decision) !== canonicalJson(recorded.decision) || event.payload.status !== decision.status || event.payload.reason !== decision.reason) throw new Error(`acceptance verdict differs from raw executions at ${event.seq}`);
  }
  return { references, unsupported };
}
