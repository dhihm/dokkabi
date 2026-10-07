import type { EventRecord } from "../schema.ts";

/**
 * #229 LN-04 / constitution 6 — what the dashboard shows of navigation and
 * rename plans, from recorded rows only: queries by status and method,
 * late answers discarded, plans by status, applies by outcome, per-file
 * commits, rollbacks, reconciled outcomes, and the query latency.
 */
export interface LspNavigationStats {
  queries: Record<string, number>;
  methods: Record<string, number>;
  late_discarded: number;
  omitted: Record<string, number>;
  plans: Record<string, number>;
  plan_reasons: Record<string, number>;
  applies: Record<string, number>;
  commits: number;
  reconciled: number;
  rollbacks: Record<string, number>;
  latency_p50_ms?: number;
  latency_max_ms?: number;
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

export function lspNavigationStats(events: readonly EventRecord[]): LspNavigationStats | undefined {
  const stats: LspNavigationStats = {
    queries: {}, methods: {}, late_discarded: 0, omitted: {}, plans: {}, plan_reasons: {}, applies: {}, commits: 0, reconciled: 0, rollbacks: {},
  };
  const latencies: number[] = [];
  let seen = false;
  for (const event of events) {
    const p = event.payload;
    if (event.name === "lsp/navigation") {
      seen = true;
      if (p.outcome === "late_discarded") {
        stats.late_discarded += 1;
        continue;
      }
      bump(stats.queries, typeof p.status === "string" ? p.status : "unknown");
      bump(stats.methods, typeof p.method === "string" ? p.method : "unknown");
      if (typeof p.latency_ms === "number" && (p.status === "current" || p.status === "empty")) latencies.push(p.latency_ms);
      if (p.omitted && typeof p.omitted === "object") {
        for (const [reason, count] of Object.entries(p.omitted as Record<string, unknown>)) if (typeof count === "number") bump(stats.omitted, reason, count);
      }
    } else if (event.name === "lsp/rename_plan") {
      seen = true;
      bump(stats.plans, typeof p.status === "string" ? p.status : "unknown");
      if (typeof p.reason === "string") bump(stats.plan_reasons, p.reason);
    } else if (event.name === "lsp/rename_outcome") {
      seen = true;
      bump(stats.applies, typeof p.status === "string" ? p.status : "unknown");
      if (p.reconciled === true) stats.reconciled += 1;
    } else if (event.name === "lsp/rename_commit") {
      seen = true;
      stats.commits += 1;
    } else if (event.name === "lsp/rename_rollback") {
      seen = true;
      bump(stats.rollbacks, typeof p.status === "string" ? p.status : "unknown");
    }
  }
  if (!seen) return undefined;
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    stats.latency_p50_ms = sorted[Math.floor((sorted.length - 1) / 2)];
    stats.latency_max_ms = sorted.at(-1);
  }
  return stats;
}

export function lspNavigationLine(stats: LspNavigationStats | undefined): string {
  if (!stats) return "";
  const map = (record: Record<string, number>) => Object.entries(record).map(([key, value]) => `${key}=${value}`).join(" ") || "none";
  return `lsp navigation ${map(stats.queries)} · by method ${map(stats.methods)} · late=${stats.late_discarded} omitted ${map(stats.omitted)}`
    + ` · rename plans ${map(stats.plans)}${Object.keys(stats.plan_reasons).length > 0 ? ` (${map(stats.plan_reasons)})` : ""}`
    + ` · applies ${map(stats.applies)} commits=${stats.commits} reconciled=${stats.reconciled} rollbacks ${map(stats.rollbacks)}`
    + (stats.latency_p50_ms !== undefined ? ` · latency p50=${stats.latency_p50_ms}ms max=${stats.latency_max_ms}ms` : "");
}
