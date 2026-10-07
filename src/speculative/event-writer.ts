import { AppendRejectedError, type EventLog } from "../host/event-log.ts";
import { projectSessionReplaySchemas, type EventInput } from "../host/schema.ts";
import { projectSpeculationV2References } from "./events-v2.ts";
import { speculationV2Schema, unreachable, validTierTool,
  type SpeculationPrepareReference, type SpeculationV2Reference } from "./events-v2-schema.ts";
import type { SpeculativeMode } from "./mode.ts";
import type { SchedulerStateEvent } from "./scheduler-types.ts";

type ResolveOutcome = Extract<SpeculationV2Reference, { name: "resolve" }>["outcome"];
type RecoveryOutcome = Extract<SpeculationV2Reference, { name: "recover" }>["outcome"];
export type SpeculationPublication = "appended" | "already_durable" | "rejected";
export type SpeculationLatencyBucket = Extract<SpeculationV2Reference, { name: "resolve" }>["latency_bucket"];
export interface SpeculationEventWriter {
  configure(input: { readonly mode: SpeculativeMode; readonly predictorDigest?: string }): boolean;
  observe(event: SchedulerStateEvent): boolean;
  resolve(candidateId: string, outcome: ResolveOutcome): boolean;
  resolveDurable(candidateId: string, outcome: ResolveOutcome, latencyBucket: SpeculationLatencyBucket): SpeculationPublication;
  recover(candidateId: string, outcome: RecoveryOutcome): boolean;
  miss(call: { readonly keyDigest: string; readonly tool: string; readonly tier: 1 | 2 | 3 }): boolean;
  pending(): readonly string[];
}
export interface SpeculationEventWriterOptions {
  readonly log: EventLog;
  readonly providerDigest: (tool: string, tier: 1 | 2 | 3) => string | undefined;
  readonly now?: () => number;
}

type Pending = {
  readonly preparation: SpeculationPrepareReference;
  readonly startedAt: number | undefined;
  phase: "scheduled" | "ready" | "taken";
};

export function createSpeculationEventWriter(input: SpeculationEventWriterOptions): SpeculationEventWriter {
  const featureStart = projectSessionReplaySchemas(input.log.events).featureStart.get("speculation-v2");
  const references = projectSpeculationV2References(input.log.events, featureStart);
  const active = new Map<string, Pending>();
  const seen = new Set<string>();
  const terminals = new Map<string, { readonly name: "resolve" | "recover"; readonly outcome: string; readonly latency?: SpeculationLatencyBucket }>();
  const now = input.now ?? performance.now.bind(performance);
  let mode: SpeculativeMode | undefined;
  let failed = false;
  let observedSeq = input.log.lastSeq;
  for (const reference of references) accept(reference);

  function accept(row: SpeculationV2Reference, startedAt?: number): void {
    switch (row.name) {
      case "config_v2": mode = row.mode; break;
      case "prepare":
        seen.add(row.candidate_id);
        active.set(row.candidate_id, { preparation: row, startedAt, phase: "scheduled" });
        break;
      case "resolve": active.delete(row.candidate_id); terminals.set(row.candidate_id,
        { name: "resolve", outcome: row.outcome, latency: row.latency_bucket }); break;
      case "recover": if (row.outcome !== "refused") active.delete(row.candidate_id);
        terminals.set(row.candidate_id, { name: "recover", outcome: row.outcome }); break;
      case "miss_v2": break;
      default: unreachable(row);
    }
  }

  function permitted(row: SpeculationV2Reference): boolean {
    if (row.name === "config_v2") return active.size === 0;
    if (mode === undefined || mode === "off") return false;
    switch (row.name) {
      case "prepare":
        return !seen.has(row.candidate_id) && validTierTool(row.tier, row.tool)
          && (mode === "full" || row.tier === 1) && (row.tier !== 2 || row.source !== "prediction");
      case "resolve": {
        const pending = active.get(row.candidate_id);
        if (!pending || pending.startedAt === undefined) return false;
        switch (row.outcome) {
          case "hit": return pending.phase === "taken" && pending.preparation.tier !== 2;
          case "promoted": return pending.phase === "taken" && pending.preparation.tier === 2;
          case "stale": case "drop": case "warm_only": case "failed": case "cancelled": return true;
          default: return unreachable(row);
        }
      }
      case "recover": return active.has(row.candidate_id);
      case "miss_v2": return validTierTool(row.tier, row.tool) && (mode === "full" || row.tier === 1);
      default: return unreachable(row);
    }
  }

  function synchronize(): void {
    const suffix = input.log.events.slice(observedSeq);
    if (suffix.some((event) => event.name.startsWith("speculation/"))) {
      const current = projectSpeculationV2References(input.log.events, featureStart);
      const live = new Map(active);
      active.clear();
      seen.clear();
      terminals.clear();
      mode = undefined;
      for (const row of current) accept(row);
      for (const [id, pending] of active) {
        const previous = live.get(id);
        if (previous?.preparation.seq === pending.preparation.seq) active.set(id, previous);
      }
    }
    observedSeq = input.log.lastSeq;
  }

  function append(name: SpeculationV2Reference["name"], payload: EventInput["payload"], durable = false): boolean {
    if (input.log.isReadOnly || failed || featureStart === undefined) return false;
    let committed: SpeculationV2Reference | undefined;
    let startedAt: number | undefined;
    try {
      const build = (seq: number): readonly EventInput[] => {
        synchronize();
        const parsed = speculationV2Schema.safeParse({ ...payload, name, seq });
        if (!parsed.success || !permitted(parsed.data)) return [];
        committed = parsed.data;
        startedAt = now();
        return [{ kind: "observe", name: `speculation/${name}`, payload }];
      };
      const records = durable ? input.log.appendBatchDurable(build) : input.log.appendBatch(build);
      if (records.length === 0 || !committed) return false;
    } catch (error) {
      if (!(error instanceof AppendRejectedError)) throw error;
      failed = true;
      return false;
    }
    accept(committed, startedAt);
    observedSeq = committed.seq;
    return true;
  }

  const resolve = (candidateId: string, outcome: ResolveOutcome): boolean => {
    const pending = active.get(candidateId);
    if (!pending || pending.startedAt === undefined) return false;
    return append("resolve", { candidate_id: candidateId, outcome,
      latency_bucket: latencyBucket(Math.max(0, now() - pending.startedAt)) });
  };
  return {
    configure: (configuration) => append("config_v2", { mode: configuration.mode,
      ...(configuration.predictorDigest === undefined ? {} : { predictor_digest: configuration.predictorDigest }) }),
    observe(event) {
      switch (event.phase) {
        case "scheduled": {
          const providerDigest = input.providerDigest(event.tool, event.tier);
          if (!providerDigest) return false;
          return append("prepare", { candidate_id: event.id, key_digest: event.keyDigest,
            provider_digest: providerDigest, tool: event.tool, tier: event.tier, source: event.source });
        }
        case "ready": case "taken": {
          const pending = active.get(event.id);
          if (failed || input.log.isReadOnly || !pending || pending.startedAt === undefined) return false;
          if ((event.phase === "ready" && pending.phase !== "scheduled")
            || (event.phase === "taken" && pending.phase !== "ready")) return false;
          pending.phase = event.phase;
          return true;
        }
        case "dropped": return resolve(event.id, event.reason === "failed" ? "failed" : "drop");
        case "disposed": return resolve(event.id, "cancelled");
        case "cleanup_failed": {
          if (input.log.isReadOnly || !seen.has(event.id)) return false;
          failed = true;
          try {
            input.log.append({ kind: "observe", name: "resource/cleanup_failed",
              payload: { owner: "speculation", candidate_digest: event.id } });
            return true;
          } catch (error) {
            if (error instanceof AppendRejectedError) return false;
            throw error;
          }
        }
        default: return unreachable(event.phase);
      }
    },
    resolve,
    resolveDurable(candidateId, outcome, bucket) {
      synchronize();
      const terminal = terminals.get(candidateId);
      if (terminal) return terminal.name === "resolve" && terminal.outcome === outcome && terminal.latency === bucket
        ? "already_durable" : "rejected";
      const pending = active.get(candidateId);
      if (!pending || pending.startedAt === undefined) return "rejected";
      return append("resolve", { candidate_id: candidateId, outcome, latency_bucket: bucket }, true)
        ? "appended" : "rejected";
    },
    recover: (candidateId, outcome) => append("recover", { candidate_id: candidateId, outcome }),
    miss(call) {
      const providerDigest = input.providerDigest(call.tool, call.tier);
      if (!providerDigest) return false;
      return append("miss_v2", { key_digest: call.keyDigest, provider_digest: providerDigest,
        tool: call.tool, tier: call.tier });
    },
    pending: () => Object.freeze([...active.keys()]),
  };
}

function latencyBucket(elapsedMs: number): Extract<SpeculationV2Reference, { name: "resolve" }>["latency_bucket"] {
  if (elapsedMs < 1) return "under_1ms";
  if (elapsedMs < 10) return "under_10ms";
  if (elapsedMs < 100) return "under_100ms";
  if (elapsedMs < 1_000) return "under_1s";
  return "at_least_1s";
}
