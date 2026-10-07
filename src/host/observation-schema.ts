import { canonicalJson } from "./canonical.ts";
import { evidenceDigest, freezeEvidence } from "../work/evidence/contract.ts";
import type { EventLog } from "./event-log.ts";
import type { EventInput, EventRecord } from "./schema.ts";
import { projectExperimentCondition } from "../eval/experiment/condition.ts";
import { workReviewDeliveryValid } from "../work/evidence/work-review.ts";

export const OBSERVATION_SCHEMA = "observation-coverage-v1";
export const OBSERVATION_BRANCHES = ["pass", "refuse", "not_applicable", "error", "cancel", "not_evaluated"] as const;
export type ObservationBranch = typeof OBSERVATION_BRANCHES[number];

/** Producer inventory is a schema, not a claim that each branch ran. */
export const OBSERVATION_INVENTORY = freezeEvidence([
  { id: "model", producer: "src/plugins/loop-pi.ts; src/host/provider-input.ts", prefixes: ["provider/", "model/", "assistant/"], consumers: ["provider-input", "replay", "dashboard"] },
  { id: "tool", producer: "src/tools/execute.ts; src/plugins/loop-pi.ts", prefixes: ["tool/", "sandbox/"], consumers: ["recorded-output", "replay", "dashboard"] },
  { id: "graph", producer: "src/graph/store.ts", prefixes: ["graph/"], consumers: ["graph-state", "replay", "dashboard"] },
  { id: "gate", producer: "src/work/gate/registry.ts", prefixes: ["verify/", "gate/", "evidence/"], consumers: ["work-step", "replay", "dashboard"] },
  { id: "approval", producer: "src/host/ssh.ts; src/host/mcp.ts; src/host/managed-plugin.ts; src/host/github-admin.ts; src/host/cursor.ts; src/host/permissions.ts", prefixes: ["approval/", "permission/", "operator/", "ssh/approval_", "mcp/approval_", "managed_plugin/approval_", "github/admin_approval_", "cursor/approval_"], consumers: ["operator-approval", "replay", "dashboard"] },
  { id: "fixture", producer: "src/work/evidence/fixture-prepare.ts", prefixes: ["fixture/"], consumers: ["work-verify", "acceptance", "replay", "dashboard"] },
  { id: "case", producer: "src/work/verify.ts; src/work/evidence/earned.ts", prefixes: ["work/case", "work/execution", "measurement/", "evaluation/"], consumers: ["earned-case", "work-view", "replay", "dashboard"] },
  { id: "clear", producer: "src/work/log.ts", prefixes: ["work/clear"], consumers: ["work-view", "replay", "dashboard"] },
  { id: "acceptance", producer: "src/work/accept-session.ts; src/work/evidence/acceptance-execution.ts", prefixes: ["acceptance/", "work/accept"], consumers: ["terminal", "replay", "dashboard"] },
  { id: "plugin", producer: "src/loader/runtime.ts", prefixes: ["plugin/"], consumers: ["loader", "replay", "dashboard"] },
  { id: "child", producer: "src/swarm/", prefixes: ["swarm/"], consumers: ["swarm-results", "replay", "dashboard"] },
  { id: "terminal", producer: "src/cli.ts", prefixes: ["work/run_result", "session/close"], consumers: ["replay", "dashboard"] },
]);
export const OBSERVATION_SCHEMA_DIGEST = evidenceDigest({ schema: OBSERVATION_SCHEMA, branches: OBSERVATION_BRANCHES, inventory: OBSERVATION_INVENTORY });
type Reference = { seq: number; hash: string; name: string };
export const observationReference = (event: EventRecord): Reference => ({ seq: event.seq, hash: event.hash, name: event.name });

export function observationSeal(plugins: readonly string[]): EventInput {
  if (new Set(plugins).size !== plugins.length || plugins.some(id => !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id))) throw new Error("invalid observation producer inventory");
  return { kind: "observe", name: "observation/schema", payload: {
    schema: OBSERVATION_SCHEMA, digest: OBSERVATION_SCHEMA_DIGEST, plugins: [...plugins],
    inventory: OBSERVATION_INVENTORY, branches: OBSERVATION_BRANCHES,
  } };
}

export function ensureObservationSchema(log: EventLog): void {
  if (log.isReadOnly) throw new Error("observation requires a durable writer");
  log.assertCanRequestModel();
  if (!log.events.some(event => event.name === "observation/schema")) log.appendDurable(observationSeal(["gate-runtime"]));
  projectObservationCoverage(log.events);
}

function branch(event: EventRecord): ObservationBranch {
  const p = event.payload;
  const outcome = String(p.status ?? p.decision ?? p.outcome ?? "");
  if (event.name === "verify/gate" && p.reason_code === "gate_error") return "error";
  if (["cancel", "cancelled", "canceled", "aborted"].includes(outcome)) return "cancel";
  if (p.error === true || ["error", "evaluator_error", "unavailable"].includes(outcome)) return "error";
  if (["refused", "rejected", "denied", "failed", "fail", "red", "unearned", "not_done"].includes(outcome)) return "refuse";
  if (["not_applicable", "disabled", "skipped", "not_managed"].includes(outcome) || event.name === "plugin/skip") return "not_applicable";
  if (["passed", "pass", "accepted", "green", "clear", "done", "completed", "stable", "prepared", "admissible"].includes(outcome)) return "pass";
  if (/\/approval_(?:granted|approved)$/u.test(event.name)) return "pass";
  if (/\/approval_(?:refused|denied)$/u.test(event.name)) return "refuse";
  return "not_evaluated";
}

/** Projection uses only retained rows; a missing producer is never a PASS. */
export function projectObservationCoverage(events: readonly EventRecord[]) {
  const references: Reference[] = [];
  const rows = OBSERVATION_INVENTORY.map(row => ({ id: row.id, count: 0,
    outcomes: Object.fromEntries(OBSERVATION_BRANCHES.map(key => [key, 0])) as Record<ObservationBranch, number> }));
  const starts = new Map<number, { event: EventRecord; gates: Array<{ id: string; owner: string }>; results: EventRecord[] }>();
  const closed = new Set<number>();
  const openTools = new Map<string, number>();
  const toolResults = new Set<string>();
  const pluginStates = new Map<string, string>();
  let sealedPlugins: string[] = [];
  let sealed = false, sealSeq = 0;
  let pendingSeal = false;
  let checkpoint: EventRecord | undefined;
  for (const event of events) {
    const p = event.payload;
    if (event.name === "session/open" && p.observation_schema !== undefined) {
      if (p.observation_schema !== OBSERVATION_SCHEMA_DIGEST) throw new Error("unknown observation session schema");
      pendingSeal = true;
    }
    if (event.name === "observation/schema") {
      if (event.kind !== "observe" || p.schema !== OBSERVATION_SCHEMA || p.digest !== OBSERVATION_SCHEMA_DIGEST
        || canonicalJson(p.inventory) !== canonicalJson(OBSERVATION_INVENTORY) || canonicalJson(p.branches) !== canonicalJson(OBSERVATION_BRANCHES)
        || !Array.isArray(p.plugins) || p.plugins.some(id => typeof id !== "string") || new Set(p.plugins).size !== p.plugins.length) throw new Error("observation producer schema mismatch");
      sealed = true; pendingSeal = false; sealSeq = event.seq;
      sealedPlugins = [...p.plugins] as string[];
    } else if (pendingSeal && event.name !== "session/open") throw new Error("observation producer seal missing before action");
    if (sealed && (event.name === "tool/call" || event.name === "tool/start") && typeof p.id === "string") {
      if (!openTools.has(p.id)) openTools.set(p.id, event.seq);
      toolResults.delete(p.id);
    }
    if (sealed && event.name === "tool/result" && typeof p.id === "string") {
      openTools.delete(p.id); toolResults.add(p.id);
    }
    if (sealed && event.name === "tool/end" && typeof p.id === "string" && !toolResults.has(p.id)) throw new Error("tool terminal lacks its result observation");
    if (event.name.startsWith("plugin/") && typeof p.id === "string") {
      const state = ({ "plugin/load": "active", "plugin/skip": "disposed", "plugin/pending": "pending", "plugin/transition_failed": "failed" } as Record<string, string>)[event.name];
      if (state) pluginStates.set(p.id, state);
      if (event.name === "plugin/unload" && typeof p.next_state === "string") pluginStates.set(p.id, p.next_state);
    }
    if (sealed && event.name === "plugin/runtime_ready") {
      if (!p.states || typeof p.states !== "object" || Array.isArray(p.states)
        || canonicalJson(Object.keys(p.states).sort()) !== canonicalJson([...sealedPlugins].sort())) throw new Error("active producer inventory differs from runtime");
      for (const [id, state] of Object.entries(p.states)) if (pluginStates.get(id) !== state) throw new Error("plugin state lacks its producer observation");
    }
    if (event.name === "verify/start") {
      if (!sealed || event.kind !== "observe" || p.observation_schema !== OBSERVATION_SCHEMA_DIGEST || typeof p.step_id !== "string"
        || !Array.isArray(p.gates) || p.gates.some(gate => !gate || typeof gate.id !== "string" || typeof gate.owner !== "string")
        || new Set(p.gates.map(gate => gate.id)).size !== p.gates.length) throw new Error("gate producer start is unbound");
      starts.set(event.seq, { event, gates: p.gates as Array<{ id: string; owner: string }>, results: [] });
    }
    if ((event.name === "verify/gate" || event.name === "verify/decision") && (sealed || p.run_seq !== undefined)) {
      const start = starts.get(p.run_seq as number);
      if (!start || closed.has(start.event.seq) || event.kind !== "observe" || p.step_id !== start.event.payload.step_id) throw new Error("gate observation has no open run");
      if (event.name === "verify/gate") {
        const enrolled = start.gates[start.results.length];
        if (!enrolled || p.gate !== enrolled.id || p.owner !== enrolled.owner || !["pass", "fail"].includes(String(p.status))) throw new Error("gate observation differs from its producer inventory");
        start.results.push(event);
      } else {
        const failed = start.results.filter(row => row.payload.status === "fail").map(row => row.payload.gate);
        const status = start.gates.length > 0 && failed.length === 0 ? "pass" : "fail";
        const reason = !start.gates.length ? "no_gate_registered" : failed.length ? "gate_failed" : "all_gates_passed";
        if (start.results.length !== start.gates.length || p.status !== status || p.reason_code !== reason
          || canonicalJson(p.gates) !== canonicalJson(start.gates.map(gate => gate.id)) || canonicalJson(p.failed) !== canonicalJson(failed)
          || canonicalJson(p.observations) !== canonicalJson(start.results.map(observationReference))) throw new Error("gate decision lacks complete matching observations");
        closed.add(start.event.seq);
      }
    }
    if (event.name === "observation/checkpoint") {
      if (!sealed || p.schema_digest !== OBSERVATION_SCHEMA_DIGEST || p.prefix_digest !== evidenceDigest(references)
        || p.count !== references.length || canonicalJson(p.open_gates) !== canonicalJson([...starts.keys()].filter(seq => !closed.has(seq)))
        || canonicalJson(p.open_tools) !== canonicalJson([...openTools.values()])) throw new Error("observation checkpoint mismatch");
      checkpoint = event;
    }
    if (event.name === "work/run_result" && sealed) {
      if (!checkpoint || checkpoint.seq !== event.seq - 1 || p.observation_checkpoint !== evidenceDigest(checkpoint.payload)) throw new Error("terminal lacks its observation checkpoint");
      if ((p.status === "done" || p.outcome === "completed") && ([...starts.keys()].some(seq => !closed.has(seq)) || openTools.size)) throw new Error("completion has missing action observations");
      const expected = terminalExperimentEvidence(events.filter(row => row.seq < event.seq), p);
      for (const [key, value] of Object.entries(expected)) if (canonicalJson(p[key]) !== canonicalJson(value)) throw new Error("terminal experiment evidence differs from observations");
    }
    if (sealed) {
      references.push(observationReference(event));
      OBSERVATION_INVENTORY.forEach((row, i) => {
        if (row.prefixes.some(prefix => event.name.startsWith(prefix))) {
          rows[i]!.count++; rows[i]!.outcomes[branch(event)]++;
        }
      });
    }
  }
  if (pendingSeal) throw new Error("observation producer seal is missing");
  const gaps = [...starts.keys()].filter(seq => !closed.has(seq)).map(seq => `gate:${seq}:not_evaluated`);
  gaps.push(...[...openTools.values()].map(seq => `tool:${seq}:not_evaluated`));
  return { schema: sealed ? OBSERVATION_SCHEMA : undefined, sealSeq, references, rows, gaps,
    status: !sealed ? "not_evaluated" as const : gaps.length ? "incomplete" as const : "recorded" as const };
}

/** Build under the caller's append lock. The checkpoint binds the entire
 * observed prefix, including domains that have no standalone replay reducer. */
export function observationTerminalInputs(events: readonly EventRecord[], terminal: EventInput): EventInput[] {
  const view = projectObservationCoverage(events);
  if (!view.schema) return [terminal];
  if (view.gaps.length && (terminal.payload?.status === "done" || terminal.payload?.outcome === "completed")) throw new Error("completion has observation gaps");
  const payload = {
    schema_digest: OBSERVATION_SCHEMA_DIGEST, prefix_digest: evidenceDigest(view.references), count: view.references.length,
    open_gates: view.gaps.filter(gap => gap.startsWith("gate:")).map(gap => Number(gap.split(":")[1])),
    open_tools: view.gaps.filter(gap => gap.startsWith("tool:")).map(gap => Number(gap.split(":")[1])),
  };
  return [{ kind: "observe", name: "observation/checkpoint", payload },
    { ...terminal, payload: { ...terminal.payload, ...terminalExperimentEvidence(events, terminal.payload ?? {}), observation_checkpoint: evidenceDigest(payload) } }];
}

export function terminalExperimentEvidence(events: readonly EventRecord[], payload: Record<string, unknown>) {
  const condition = projectExperimentCondition(events), removed = condition.binding?.resolved.removed ?? [];
  const delivery = [...events].reverse().find(row => row.name === "work/accept");
  const policy = [...events].reverse().find(row => row.name === "acceptance/work_policy" || row.name === "acceptance/enrolled");
  const ordinary = delivery?.payload.mode === "workspace_cases_and_review" || policy?.name === "acceptance/work_policy";
  const accepted = payload.accepted === true && delivery?.payload.decision === "done"
    && (ordinary ? workReviewDeliveryValid(events, delivery)
      : ["spec_digest", "spec_log_hash", "verifier_digest", "verifier_log_hash"].every(key => /^[a-f0-9]{64}$/u.test(String(delivery.payload[key]))));
  if (payload.accepted === true && !accepted) throw new Error("terminal acceptance lacks its recorded child delivery");
  return { raw_outcome: payload.status ?? "not_evaluated",
    earned_outcome: removed.length ? "not_evaluated" : accepted ? "accepted" : payload.accepted === false ? "refused" : "not_evaluated",
    evidence_level: ordinary || removed.includes("managed_tests") ? "workspace_reported" : removed.length ? "ablated" : "full_policy",
    ...(accepted ? { acceptance_ref: observationReference(delivery!) } : {}),
    ...(condition.binding ? { condition: condition.binding.resolved.condition, binding_digest: condition.bindingDigest } : {}) };
}

/** Host terminal publication shares its lock with final authority checks and
 * the coverage checkpoint. Intermediate refusal rows are covered too. */
export function appendObservedTerminal(log: EventLog, build: (nextSeq: number) => readonly EventInput[]) {
  return log.appendProjectedBatchDurable(build, (input, prefix) => input.name === "work/run_result"
    ? observationTerminalInputs(prefix, { ...input, payload: { ...input.payload, ...terminalExperimentEvidence(prefix, input.payload ?? {}) } })
    : [input]);
}
