import type { EventRecord } from "../schema.ts";

/**
 * #222 D5 / constitution 6 — what the dashboard shows of passive
 * diagnostics, from recorded rows only: servers by state, batches by
 * freshness and discard reason, what reached the model (items, bytes,
 * requests, omissions by reason, not-inspected documents) and the
 * commit-to-matched latency. Byte counts, not token estimates.
 */
export interface LspDiagnosticsStats {
  servers_started: number;
  servers_ready: number;
  servers_unavailable: number;
  servers_ended: number;
  restarts: number;
  survivors: number;
  late_discarded: number;
  syncs: number;
  matched: number;
  unverified: number;
  /** Same-version batches that would have retracted an error (D1'). */
  retractions_ignored: number;
  discarded: number;
  discard_reasons: Record<string, number>;
  unsupported: number;
  superseded: number;
  /** Requests that carried a recorded suffix of any source. */
  contribution_requests: number;
  contribution_bytes: number;
  /** Diagnostic items delivered, by freshness. */
  delivered: Record<string, number>;
  omitted: Record<string, number>;
  not_inspected: number;
  failed_appends: number;
  /** Items abandoned after their last append attempt (each named in a row). */
  abandoned: number;
  latency_p50_ms?: number;
  latency_max_ms?: number;
  unavailable_reasons: string[];
}

export function lspDiagnosticsStats(events: readonly EventRecord[]): LspDiagnosticsStats | undefined {
  const stats: LspDiagnosticsStats = {
    servers_started: 0, servers_ready: 0, servers_unavailable: 0, servers_ended: 0, restarts: 0, survivors: 0,
    late_discarded: 0, syncs: 0, matched: 0, unverified: 0, retractions_ignored: 0, discarded: 0, discard_reasons: {}, unsupported: 0,
    superseded: 0, contribution_requests: 0, contribution_bytes: 0, delivered: {}, omitted: {}, not_inspected: 0,
    failed_appends: 0, abandoned: 0, unavailable_reasons: [],
  };
  const latencies: number[] = [];
  let seen = false;
  for (const event of events) {
    const p = event.payload;
    if (event.name === "lsp/server") {
      seen = true;
      if (p.event === "starting") stats.servers_started += 1;
      else if (p.event === "ready") stats.servers_ready += 1;
      else if (p.event === "unavailable") {
        stats.servers_unavailable += 1;
        if (typeof p.reason === "string" && !stats.unavailable_reasons.includes(p.reason)) stats.unavailable_reasons.push(p.reason);
      } else if (p.event === "ended") {
        stats.servers_ended += 1;
        if (typeof p.survivors === "number") stats.survivors += p.survivors;
      } else if (p.event === "restarting") stats.restarts += 1;
      else if (p.event === "late_discarded") stats.late_discarded += 1;
    } else if (event.name === "lsp/sync") {
      seen = true;
      stats.syncs += 1;
    } else if (event.name === "lsp/diagnostics") {
      seen = true;
      if (p.outcome === "matched") {
        stats.matched += 1;
        if (typeof p.latency_ms === "number") latencies.push(p.latency_ms);
      } else if (p.outcome === "unverified") stats.unverified += 1;
      else if (p.outcome === "retraction_ignored") stats.retractions_ignored += 1;
      if (p.outcome === "matched" && typeof p.retraction_ignored === "number") stats.retractions_ignored += 1;
      else if (p.outcome === "discarded") {
        stats.discarded += 1;
        const reason = typeof p.reason === "string" ? p.reason : "unknown";
        stats.discard_reasons[reason] = (stats.discard_reasons[reason] ?? 0) + 1;
      }
    } else if (event.name === "lsp/document") {
      seen = true;
      if (p.status === "unsupported") stats.unsupported += 1;
      else if (p.status === "superseded") stats.superseded += 1;
    } else if (event.name === "model_input/contribution") {
      stats.contribution_requests += 1;
      if (typeof p.bytes === "number") stats.contribution_bytes += p.bytes;
      const sources = Array.isArray(p.sources) ? p.sources : [];
      for (const source of sources as Array<Record<string, unknown>>) {
        if (!source || source.kind !== "diagnostic") continue;
        seen = true;
        for (const item of Array.isArray(source.items) ? source.items as Array<Record<string, unknown>> : []) {
          const freshness = typeof item.freshness === "string" ? item.freshness : "unknown";
          stats.delivered[freshness] = (stats.delivered[freshness] ?? 0) + 1;
        }
        for (const omission of Array.isArray(source.omissions) ? source.omissions as Array<Record<string, unknown>> : []) {
          const reason = typeof omission.reason === "string" ? omission.reason : "unknown";
          stats.omitted[reason] = (stats.omitted[reason] ?? 0) + (typeof omission.count === "number" ? omission.count : 0);
        }
        if (Array.isArray(source.not_inspected)) stats.not_inspected += source.not_inspected.length;
      }
    } else if (event.name === "model_input/contribution_failed") {
      stats.failed_appends += 1;
      if (Array.isArray(p.append_attempts_exhausted)) stats.abandoned += p.append_attempts_exhausted.length;
    }
  }
  if (!seen && stats.failed_appends === 0) return undefined;
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    stats.latency_p50_ms = sorted[Math.floor((sorted.length - 1) / 2)];
    stats.latency_max_ms = sorted.at(-1);
  }
  return stats;
}

export function lspDiagnosticsLine(stats: LspDiagnosticsStats | undefined): string {
  if (!stats) return "";
  const map = (record: Record<string, number>) => Object.entries(record).map(([key, value]) => `${key}:${value}`).join(",") || "0";
  return `lsp servers start=${stats.servers_started} ready=${stats.servers_ready} unavailable=${stats.servers_unavailable}`
    + `${stats.unavailable_reasons.length > 0 ? `(${stats.unavailable_reasons.slice(0, 3).join(",")})` : ""}`
    + ` ended=${stats.servers_ended} restarts=${stats.restarts} survivors=${stats.survivors}`
    + ` · batches matched=${stats.matched} unverified=${stats.unverified} retractions_ignored=${stats.retractions_ignored} discarded=${map(stats.discard_reasons)} late=${stats.late_discarded}`
    + ` · delivered=${map(stats.delivered)} in ${stats.contribution_requests} req ${stats.contribution_bytes}B omitted=${map(stats.omitted)}`
    + ` not_inspected=${stats.not_inspected} unsupported=${stats.unsupported} append_failed=${stats.failed_appends} abandoned=${stats.abandoned}`
    + (stats.latency_p50_ms !== undefined ? ` · latency p50=${stats.latency_p50_ms}ms max=${stats.latency_max_ms}ms` : "");
}
