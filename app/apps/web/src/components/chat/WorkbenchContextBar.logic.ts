import type {
  ProviderWorkbenchOverview,
  ProviderWorkbenchOverviewResult,
  ProviderWorkbenchUsageReport,
  WorkbenchChildUsageScope,
  WorkbenchUsageCounts,
} from "@t3tools/contracts";
import type { EnvironmentQueryView } from "~/state/query";
import { workbenchOverviewScopeKey, type WorkbenchOverviewScope } from "~/state/workbenchOverview";

/**
 * Pure view-model for the R3 WorkbenchContextBar (docs/internals/
 * dokkabi-overview-r3.md). Semantics held here:
 * - A live query error OUTRANKS the value in `data`: the query lifecycle
 *   retains the previous success through a failure, so data+error together
 *   mean a refresh failed. The same scope's valid view stays, labeled stale
 *   — including while the next refresh is still in flight — and never clears.
 * - Retention is same-scope only (environment+thread+instance): a different
 *   thread or instance NEVER observes its predecessor's data, and a late
 *   old-scope response cannot overwrite a newer scope's view.
 * - Missing counts read Unknown — never 0/0 or 100%.
 * - The unsupported/unavailable capability results drive rendering with no
 *   driver-name checks; "missing" context never means "disabled".
 */

export type WorkbenchOverviewBarState =
  | { readonly kind: "hidden" }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "view";
      readonly overview: ProviderWorkbenchOverview;
      readonly staleError: string | null;
    };

/** The latest retained view, keyed to the scope it belongs to. */
export interface RetainedWorkbenchOverview {
  /** Composite client-only scope key (environment+thread+instance). */
  readonly scopeKey: string;
  readonly overview: ProviderWorkbenchOverview;
}

const overviewOf = (
  result: ProviderWorkbenchOverviewResult | null,
): ProviderWorkbenchOverview | null =>
  result !== null && result.status === "available" && result.overview !== undefined
    ? result.overview
    : null;

/**
 * Resolve the bar's state from the keyed query plus the previously retained
 * view. The retained view is used only when its composite scope key
 * (environment + thread + provider instance) is the query's own; otherwise it
 * is discarded before anything is decided — a moved thread/instance keeps no
 * old environment's data.
 */
export function resolveWorkbenchOverviewBar(input: {
  readonly scopeKey: string;
  readonly query: Pick<
    EnvironmentQueryView<ProviderWorkbenchOverviewResult>,
    "data" | "error" | "isPending"
  >;
  readonly retained: RetainedWorkbenchOverview | null;
}): WorkbenchOverviewBarState {
  const retained =
    input.retained !== null && input.retained.scopeKey === input.scopeKey ? input.retained : null;
  // A live failure outranks the retained success inside `data`: same-scope
  // valid data stays visibly stale (idle failure or in-flight refresh), and
  // nothing is cleared until a fresh success lands.
  if (input.query.error !== null) {
    const stale = retained?.overview ?? overviewOf(input.query.data);
    if (stale !== null) {
      return { kind: "view", overview: stale, staleError: input.query.error };
    }
    return { kind: "unavailable", reason: input.query.error };
  }
  if (input.query.data !== null) {
    const result = input.query.data;
    if (result.status === "unsupported") return { kind: "hidden" };
    if (result.status === "unavailable") {
      return {
        kind: "unavailable",
        reason: result.reason ?? "The recorded overview is not available yet.",
      };
    }
    return { kind: "view", overview: result.overview!, staleError: null };
  }
  return input.query.isPending ? { kind: "pending" } : { kind: "hidden" };
}

/** What the bar should say about case coverage. Missing counts stay unknown. */
export type CaseCoverageView =
  | { readonly kind: "unknown" }
  | { readonly kind: "invalid" }
  | { readonly kind: "counts"; readonly green: number; readonly total: number };

export function caseCoverageOf(overview: ProviderWorkbenchOverview): CaseCoverageView {
  const work = overview.work;
  if (work.state === "invalid") return { kind: "invalid" };
  if (work.state !== "available" || work.cases === null) return { kind: "unknown" };
  return { kind: "counts", green: work.cases.green, total: work.cases.total };
}

/**
 * Recorded TODO states exactly as the log holds them: ready, red, blocked
 * (clear/green rows are finished work). There is no execution-in-progress
 * state in this contract — a ready TODO is NOT reported as running.
 */
export function todoActivityOf(overview: ProviderWorkbenchOverview): {
  readonly ready: number;
  readonly red: number;
  readonly blocked: number;
} {
  let ready = 0;
  let red = 0;
  let blocked = 0;
  for (const todo of overview.work.todos) {
    if (todo.state === "ready") ready += 1;
    else if (todo.state === "red") red += 1;
    else if (todo.state === "blocked") blocked += 1;
  }
  return { ready, red, blocked };
}

/** A measured total renders compactly; anything else is Unknown — never 0. */
export function usageTotalOf(
  overview: ProviderWorkbenchOverview,
  field: "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite",
): string {
  const total = overview.usage[field].total;
  return total === null ? "Unknown" : formatCompact(total);
}

export function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/u, "")}k`;
  }
  const m = value / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/u, "")}M`;
}

/** Trimmed, stable display form of a recorded source ref (seq + hash head). */
export function sourceRefLabel(ref: { readonly seq: number; readonly hash: string }): string {
  return `seq ${ref.seq} · ${ref.hash.slice(0, 12)}…`;
}

/** True when two scopes name the same environment+thread+instance view. */
export function sameWorkbenchOverviewScope(
  left: WorkbenchOverviewScope,
  right: WorkbenchOverviewScope,
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    workbenchOverviewScopeKey(left) === workbenchOverviewScopeKey(right)
  );
}

// --- Scoped run usage dialog (Dokkabi R8) ---
//
// Pure view-model for the on-demand Total run usage dialog. The read is a
// separate keyed query with NO refresh interval: it runs only while the
// dialog is open and on an explicit Refresh. Semantics held here:
// - The dialog state resolves ONLY from the current keyed query — a late
//   old-scope response lands in a different key and can never contaminate
//   this view.
// - An unsupported scoped result (an older gateway) keeps its documented
//   reason visible; it is never rendered as an empty zero-total success.
// - Missing measurements read Unknown — never 0. Request-versus-usage gaps
//   stay explicit ("N unknown"), because the difference is unknown, not
//   zero. Totals are recorded tokens, never billing.

export type WorkbenchScopedUsageDialogState =
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "view";
      readonly report: ProviderWorkbenchUsageReport;
      readonly staleError: string | null;
    };

/**
 * Resolve the dialog's state from its keyed query. The query is opened only
 * by this dialog, so its data is already scope-bound; the typed scoped
 * result carries its own unavailable/unsupported states for the scoped read
 * even when the overview itself was available.
 */
export function resolveWorkbenchScopedUsage(input: {
  readonly query: Pick<
    EnvironmentQueryView<ProviderWorkbenchOverviewResult>,
    "data" | "error" | "isPending"
  >;
}): WorkbenchScopedUsageDialogState {
  if (input.query.error !== null) {
    return { kind: "error", reason: input.query.error };
  }
  const result = input.query.data;
  if (result === null) {
    return input.query.isPending
      ? { kind: "pending" }
      : { kind: "unsupported", reason: "No scoped usage result was returned." };
  }
  if (result.status !== "available") {
    return {
      kind: "unavailable",
      reason: result.reason ?? "The recorded overview is not available yet.",
    };
  }
  const scoped = result.scopedUsage;
  if (scoped === undefined) {
    return {
      kind: "unsupported",
      reason: "This server did not return a scoped usage report for this read.",
    };
  }
  if (scoped.status === "available") {
    return { kind: "view", report: scoped.report, staleError: null };
  }
  return { kind: scoped.status, reason: scoped.reason };
}

/** The report's overall state, labeled without overclaiming. */
export function scopedUsageStateLabel(state: ProviderWorkbenchUsageReport["state"]): string {
  if (state === "complete") return "Complete";
  if (state === "partial") return "Partial — some scopes could not be fully read";
  return "Invalid — a scope failed verification";
}

/** One child scope's state, labeled as the recorded fact it is. */
export function childScopeStateLabel(state: WorkbenchChildUsageScope["state"]): string {
  if (state === "verified") return "Verified pinned prefix";
  if (state === "unpinned") return "Referenced without a pinned prefix — usage unknown";
  if (state === "missing") return "Missing session";
  return "Invalid — failed verification";
}

/**
 * Recorded counts with the request-versus-usage gap kept explicit: a
 * request with no completed usage row is UNKNOWN usage, never zero.
 */
export function usageCountsGapLabel(counts: WorkbenchUsageCounts): string {
  const base = `${counts.requests} request${counts.requests === 1 ? "" : "s"} · ${counts.completedUsage} completed usage row${counts.completedUsage === 1 ? "" : "s"}`;
  return counts.requests === counts.completedUsage
    ? base
    : `${base} · ${counts.requests - counts.completedUsage} unknown`;
}

/** A measured total renders compactly; anything else is Unknown — never 0. */
export function scopedUsageMetricLabel(metric: { readonly total: number | null }): string {
  return metric.total === null ? "Unknown" : formatCompact(metric.total);
}
