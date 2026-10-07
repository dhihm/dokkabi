import { decideExperimentFactors, type FactorFact, type ExperimentFactor } from "../../eval/experiment/condition.ts";
import { ensureObservationSchema, OBSERVATION_SCHEMA_DIGEST, observationReference } from "../../host/observation-schema.ts";
import { decideEvidence } from "../evidence/contract.ts";
import type { EvidenceDecisionV2 } from "../evidence/schema.ts";
import { BlobStore } from "../../host/blob-store.ts";
import type { EventLog } from "../../host/event-log.ts";
import { redactText } from "../../host/redact.ts";
import type { PluginDisposer, RecordedArtifact } from "../../loader/types.ts";

/**
 * The `ctx.verify` seam (#77 T5). `docs/plugins.md` has declared a local gate
 * capability since the plugin surface was written; nothing implemented it, so
 * every quality check in the work loop is a hard-coded call site instead.
 *
 * A gate is a REGISTRATION: it reads the step's recorded artifact — never a
 * transcript, never the loop's memory — and returns a verdict. The loop asks
 * for a verdict and gets one; it never learns what a particular gate checks
 * (constitution 7). Every gate and the decision land on the log (6).
 */

export const MAX_GATES = 8;
export const MAX_GATE_DETAIL_BYTES = 2_000;

const GATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const OWNER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const REASON_CODE = /^[a-z][a-z0-9_]{1,63}$/u;
const TRUNCATED = "\n[gate detail truncated by host]";

export type GateStatus = "pass" | "fail";

export interface GateInput {
  readonly stepId: string;
  readonly workspaceRoot: string;
  /** What the step produced, already recorded. */
  readonly artifact: RecordedArtifact;
}

export interface GateResult {
  readonly status: GateStatus;
  readonly reasonCode: string;
  /** Evidence. Bounded and blob-backed — never raw text on the row: the
   * secret scanner rejects an append whose payload looks like a credential,
   * and a rejected append blocks every later model request. */
  readonly detail?: string;
}

export type Gate = (input: GateInput) => GateResult | Promise<GateResult>;

export interface GateVerdict {
  readonly stepId: string;
  readonly status: GateStatus;
  readonly gates: readonly string[];
  readonly failed: readonly string[];
  readonly reasonCode: string;
}

export interface GateRegistry {
  decideExperiment(facts: readonly FactorFact[], removed: readonly ExperimentFactor[]): ReturnType<typeof decideExperimentFactors>;
  decideEvidence(input: unknown): EvidenceDecisionV2;
  register(id: string, owner: string, gate: Gate): PluginDisposer;
  list(): readonly string[];
  run(input: GateInput): Promise<GateVerdict>;
}

export function createGateRegistry(log: EventLog): GateRegistry {
  const entries = new Map<string, { readonly owner: string; readonly gate: Gate }>();
  // First position wins and survives a disable/re-enable cycle: recorded gate
  // order feeds the replay digest, so lifecycle history must not reorder it
  // (same rule as swarm memory providers).
  const firstSeenOrder: string[] = [];

  function recordGate(id: string, owner: string, result: GateResult, runSeq: number, stepId: string) {
    let blob: string | undefined;
    let detailBytes: number | undefined;
    if (result.detail !== undefined && !log.isReadOnly) {
      const bounded = result.detail.length > MAX_GATE_DETAIL_BYTES
        ? `${result.detail.slice(0, MAX_GATE_DETAIL_BYTES)}${TRUNCATED}`
        : result.detail;
      const safe = redactText(bounded);
      blob = BlobStore.forSession(log.path).put(safe);
      detailBytes = Buffer.byteLength(safe);
    }
    return log.appendDurable({
      kind: "observe",
      name: "verify/gate",
      payload: {
        run_seq: runSeq, step_id: stepId,
        gate: id,
        owner,
        status: result.status,
        reason_code: result.reasonCode,
        ...(blob ? { blob, detail_bytes: detailBytes } : {}),
      },
    });
  }

  return {
    decideExperiment: decideExperimentFactors,
    decideEvidence,
    register(id, owner, gate) {
      if (!GATE_ID.test(id)) throw new Error(`invalid gate id ${id}`);
      if (!OWNER_ID.test(owner)) throw new Error(`invalid gate owner ${owner}`);
      if (entries.has(id)) throw new Error(`duplicate gate ${id}`);
      if (entries.size >= MAX_GATES) throw new Error(`gate limit is ${MAX_GATES}`);
      if (!firstSeenOrder.includes(id)) firstSeenOrder.push(id);
      const entry = { owner, gate };
      entries.set(id, entry);
      return () => {
        if (entries.get(id) === entry) entries.delete(id);
      };
    },
    list() {
      return firstSeenOrder.filter((id) => entries.has(id));
    },
    async run(input) {
      ensureObservationSchema(log);
      const enrolled = firstSeenOrder.filter(id => entries.has(id)).map(id => ({ id, ...entries.get(id)! }));
      const start = log.appendDurable({ kind: "observe", name: "verify/start", payload: {
        observation_schema: OBSERVATION_SCHEMA_DIGEST, step_id: input.stepId, artifact: input.artifact,
        gates: enrolled.map(({ id, owner }) => ({ id, owner })),
      } });
      const observations = [];
      const ran: string[] = [];
      const failed: string[] = [];
      for (const entry of enrolled) {
        const id = entry.id;
        ran.push(id);
        let result: GateResult;
        try {
          const raw = await entry.gate(input);
          if (raw.status !== "pass" && raw.status !== "fail") throw new Error("invalid gate status");
          if (!REASON_CODE.test(raw.reasonCode)) throw new Error("invalid gate reason code");
          result = raw;
        } catch (error) {
          // A gate that throws is a FAILED gate, never a skipped one: a
          // broken check must not read as an absent obligation.
          result = {
            status: "fail",
            reasonCode: "gate_error",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        observations.push(observationReference(recordGate(id, entry.owner, result, start.seq, input.stepId)));
        if (result.status !== "pass") failed.push(id);
      }
      // Zero gates is a FAIL. If an unguarded step passed, disabling the
      // gate plugin would silently accept every step — which is the exact
      // opposite of what this seam is for.
      const reasonCode = ran.length === 0
        ? "no_gate_registered"
        : failed.length > 0
          ? "gate_failed"
          : "all_gates_passed";
      const status: GateStatus = ran.length > 0 && failed.length === 0 ? "pass" : "fail";
      log.appendDurable({
        kind: "observe",
        name: "verify/decision",
        payload: {
          run_seq: start.seq, observations,
          step_id: input.stepId,
          status,
          reason_code: reasonCode,
          gates: [...ran],
          failed: [...failed],
        },
      });
      return { stepId: input.stepId, status, gates: ran, failed, reasonCode };
    },
  };
}
