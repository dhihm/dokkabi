import { useState, type ReactNode } from "react";
import {
  ClipboardListIcon,
  GaugeIcon,
  InfoIcon,
  ListOrderedIcon,
  NetworkIcon,
  RefreshCwIcon,
  WorkflowIcon,
} from "lucide-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderWorkbenchOverview,
  ThreadId,
  WorkbenchChildUsageScope,
} from "@t3tools/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useEnvironmentQuery } from "~/state/query";
import {
  workbenchOverviewAtomFor,
  workbenchOverviewScopeKey,
  workbenchScopedUsageAtomFor,
  workbenchScopedUsageScopeKey,
} from "~/state/workbenchOverview";
import {
  caseCoverageOf,
  childScopeStateLabel,
  resolveWorkbenchOverviewBar,
  resolveWorkbenchScopedUsage,
  scopedUsageMetricLabel,
  scopedUsageStateLabel,
  sourceRefLabel,
  todoActivityOf,
  usageCountsGapLabel,
  usageTotalOf,
  type RetainedWorkbenchOverview,
  type WorkbenchOverviewBarState,
  type WorkbenchScopedUsageDialogState,
} from "./WorkbenchContextBar.logic";

/**
 * R3 WorkbenchContextBar: a compact, read-only recorded summary that sits
 * between the chat header and the timeline — the actual goal, case coverage,
 * recorded TODO states, frame delivery and usage, each grounded in recorded
 * source rows. Refresh or inspection never remounts the timeline/composer
 * and never discards draft/scroll; missing counts show Unknown, never 0/0 or
 * 100%; work/graph mutations stay disabled. Source details open through a
 * small read-only disclosure usable with keyboard and pointer.
 */

export function WorkbenchOverviewSourceDetails({
  overview,
}: {
  readonly overview: ProviderWorkbenchOverview;
}) {
  const coverage = caseCoverageOf(overview);
  const todos = todoActivityOf(overview);
  return (
    <div className="flex flex-col gap-3 text-sm" data-workbench-overview-sources>
      <section>
        <h4 className="mb-1 font-medium">Recorded goal</h4>
        {overview.work.goal === null ? (
          <p className="text-muted-foreground" data-goal-source="missing">
            No recorded goal row.
          </p>
        ) : (
          <p data-goal-source="recorded">
            {overview.work.goal.id}: {overview.work.goal.statement}
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {sourceRefLabel(overview.work.goal.source)}
            </span>
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Plan digest: {overview.work.planDigest ?? "none recorded"}
        </p>
      </section>
      <section>
        <h4 className="mb-1 font-medium">Case coverage</h4>
        <p className="text-xs text-muted-foreground">
          {coverage.kind === "counts"
            ? `${coverage.green} GREEN of ${coverage.total} recorded cases`
            : coverage.kind === "invalid"
              ? "The recorded plan could not be interpreted; coverage is not claimed."
              : "No case counts are recorded."}
        </p>
        {overview.work.errors.length > 0 ? (
          <ul className="mt-1 list-disc pl-4 text-xs text-destructive" data-work-errors>
            {overview.work.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <section>
        <h4 className="mb-1 font-medium">Recorded TODOs</h4>
        {overview.work.todos.length === 0 ? (
          <p className="text-xs text-muted-foreground">No TODO rows recorded.</p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-todo-rows>
            {overview.work.todos.map((todo) => (
              <li key={todo.id} data-todo-state={todo.state}>
                <span className="font-mono">{todo.state}</span> · {todo.title}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {todos.ready} ready · {todos.red} red · {todos.blocked} blocked
        </p>
      </section>
      <section>
        <h4 className="mb-1 font-medium">Context frame</h4>
        <p className="text-xs text-muted-foreground" data-context-frame>
          {overview.context.frame === null
            ? "No context frame recorded."
            : `${overview.context.frame.id} — ${overview.context.frame.stage} (${sourceRefLabel(overview.context.frame.source)})`}
          {overview.context.mode !== null ? ` · mode ${overview.context.mode}` : " · mode unknown"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Graph revision {overview.context.revision ?? "Unknown"} · digest{" "}
          {overview.context.digest?.slice(0, 12) ?? "Unknown"}… · lessons{" "}
          {overview.context.lessonCount ?? "Unknown"}
        </p>
        {overview.context.errors.length > 0 ? (
          <ul className="mt-1 list-disc pl-4 text-xs text-destructive" data-context-errors>
            {overview.context.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <section>
        <h4 className="mb-1 font-medium">Recorded usage</h4>
        <ul
          className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground"
          data-usage-sources
        >
          {(["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const).map((field) => {
            const metric = overview.usage[field];
            return (
              <li key={field}>
                {field}: {metric.total === null ? "Unknown" : metric.total.toLocaleString()} ·{" "}
                {metric.missing} missing record{metric.missing === 1 ? "" : "s"}
                {metric.latestSource === null ? null : (
                  <span className="ml-1 font-mono">{sourceRefLabel(metric.latestSource)}</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">
          Across {overview.usage.records} recorded usage row
          {overview.usage.records === 1 ? "" : "s"}.
        </p>
      </section>
      <section>
        <h4 className="mb-1 font-medium">Source heads</h4>
        <p className="font-mono text-xs text-muted-foreground" data-session-head>
          session {overview.sessionCursor.sessionId} · seq {overview.sessionCursor.seq} · gen{" "}
          {overview.sessionCursor.generation.slice(0, 12)}… ·{" "}
          {overview.sessionCursor.hash.slice(0, 12)}…
        </p>
        <p className="font-mono text-xs text-muted-foreground" data-gateway-head>
          gateway · seq {overview.gatewayCursor.seq} · gen{" "}
          {overview.gatewayCursor.generation.slice(0, 12)}… ·{" "}
          {overview.gatewayCursor.hash.slice(0, 12)}…
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          resnapshot {String(overview.resnapshot)}
        </p>
      </section>
    </div>
  );
}

/** The presentational bar: renders one resolved state, holds no query state. */
export function WorkbenchContextBarView({
  state,
  threadId,
  onOpenGraph,
  onOpenRecord,
  onOpenCode,
  scopedUsageDialog,
}: {
  readonly state: WorkbenchOverviewBarState;
  readonly threadId: ThreadId;
  /** Opens the recorded Work/Context graph panel (Dokkabi R4). */
  readonly onOpenGraph?: ((graphType: "work" | "context") => void) | undefined;
  /** Opens the docked Decision/Record reader (Dokkabi R5). */
  readonly onOpenRecord?: (() => void) | undefined;
  readonly onOpenCode?: (() => void) | undefined;
  /** The on-demand Total run usage dialog trigger (Dokkabi R8), when the
   * host provides the scope it reads under. */
  readonly scopedUsageDialog?: ReactNode | undefined;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (state.kind === "hidden") return null;
  if (state.kind === "pending") {
    return (
      <div
        className="flex min-h-9 items-center gap-3 border-b border-border bg-background px-4 text-xs text-muted-foreground"
        data-workbench-context-bar="pending"
        data-thread-id={threadId}
      >
        <ClipboardListIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Recorded overview…</span>
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <div
        className="flex min-h-9 items-center gap-3 border-b border-border bg-background px-4 text-xs text-muted-foreground"
        data-workbench-context-bar="unavailable"
        data-thread-id={threadId}
      >
        <ClipboardListIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Harness overview unavailable — {state.reason}</span>
      </div>
    );
  }

  const { overview, staleError } = state;
  const coverage = caseCoverageOf(overview);
  const todos = todoActivityOf(overview);
  const goal = overview.work.goal;

  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-background px-4 py-1 text-xs text-foreground"
      data-workbench-context-bar="view"
      data-thread-id={threadId}
      data-stale={staleError === null ? "false" : "true"}
    >
      <ClipboardListIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {staleError !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="rounded bg-warning/12 px-1.5 py-0.5 font-medium text-warning-foreground"
                data-stale-banner="true"
              />
            }
          >
            stale
          </TooltipTrigger>
          <TooltipPopup side="bottom">{staleError}</TooltipPopup>
        </Tooltip>
      ) : null}
      <span className="max-w-[36ch] truncate font-medium" data-workbench-goal>
        {goal === null ? "No recorded plan" : goal.statement}
      </span>
      <span data-workbench-cases>
        {coverage.kind === "counts"
          ? `Cases ${coverage.green}/${coverage.total} GREEN`
          : coverage.kind === "invalid"
            ? "Cases Unknown — recorded plan invalid"
            : "Cases Unknown"}
      </span>
      <span data-workbench-todos>
        {todos.ready} ready · {todos.red} red · {todos.blocked} blocked
      </span>
      <span data-workbench-frame>
        {overview.context.frame === null ? "No frame" : `Frame ${overview.context.frame.stage}`}
        {overview.context.mode !== null && overview.context.mode !== "on"
          ? ` (${overview.context.mode})`
          : ""}
      </span>
      <span data-workbench-usage>
        Main usage In {usageTotalOf(overview, "input")} · Out {usageTotalOf(overview, "output")}
      </span>
      <span className="grow" />
      {scopedUsageDialog}
      {onOpenGraph ? (
        <>
          <Button
            variant="ghost"
            size="xs"
            data-workbench-open-work-graph="true"
            onClick={() => onOpenGraph("work")}
          >
            <NetworkIcon className="size-3.5" aria-hidden="true" />
            Work graph
          </Button>
          <Button
            variant="ghost"
            size="xs"
            data-workbench-open-context-graph="true"
            onClick={() => onOpenGraph("context")}
          >
            <WorkflowIcon className="size-3.5" aria-hidden="true" />
            Context graph
          </Button>
        </>
      ) : null}
      {onOpenCode ? (
        <Button variant="ghost" size="xs" data-workbench-open-code="true" onClick={onOpenCode}>
          <NetworkIcon className="size-3.5" aria-hidden="true" />
          Code
        </Button>
      ) : null}
      {onOpenRecord ? (
        <Button variant="ghost" size="xs" data-workbench-open-record="true" onClick={onOpenRecord}>
          <ListOrderedIcon className="size-3.5" aria-hidden="true" />
          Record
        </Button>
      ) : null}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={detailsOpen}
          data-workbench-overview-details-trigger="true"
          onClick={() => setDetailsOpen(true)}
        >
          <InfoIcon className="size-3.5" aria-hidden="true" />
          Sources
        </Button>
        {/* Canonical dialog composition: DialogHeader pads the title,
            DialogPanel scrolls the long source body with the standard
            ScrollArea, and DialogFooter keeps the close action visible on
            short viewports — nothing sits flush against the popup edge. */}
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Recorded overview sources</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <WorkbenchOverviewSourceDetails overview={overview} />
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              data-workbench-overview-details-close="true"
              onClick={() => setDetailsOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

/**
 * The keyed container: resolves the thread's overview through the
 * authenticated per-environment query lifecycle, scoped to the thread's
 * actual provider instance. Retention is same-scope only: when the composite
 * scope changes, the retained view resets and the bar (including its source
 * dialog) remounts under the new scope — never the timeline or composer —
 * so a late old-scope response cannot overwrite the new scope's view.
 */
export function WorkbenchContextBar({
  environmentId,
  threadId,
  providerInstanceId,
  onOpenGraph,
  onOpenRecord,
  onOpenCode,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly onOpenGraph?: ((graphType: "work" | "context") => void) | undefined;
  readonly onOpenRecord?: (() => void) | undefined;
  readonly onOpenCode?: (() => void) | undefined;
}) {
  const scopeKey = workbenchOverviewScopeKey({ environmentId, threadId, providerInstanceId });
  const [retainedScope, setRetainedScope] = useState<{
    key: string;
    view: RetainedWorkbenchOverview;
  } | null>(null);
  const query = useEnvironmentQuery(
    workbenchOverviewAtomFor({ environmentId, threadId, providerInstanceId }),
  );
  const retained =
    retainedScope !== null && retainedScope.key === scopeKey ? retainedScope.view : null;
  const state = resolveWorkbenchOverviewBar({ scopeKey, query, retained });
  // Retain every fresh valid view for THIS scope (React's own
  // adjust-state-during-render pattern; the guard makes it idempotent).
  if (state.kind === "view" && state.staleError === null) {
    if (retained === null || retained.overview !== state.overview) {
      setRetainedScope({ key: scopeKey, view: { scopeKey, overview: state.overview } });
    }
  }
  // Keying the view by scope resets the source dialog when the scope moves.
  return (
    <WorkbenchContextBarView
      key={scopeKey}
      state={state}
      threadId={threadId}
      onOpenGraph={onOpenGraph}
      onOpenRecord={onOpenRecord}
      onOpenCode={onOpenCode}
      scopedUsageDialog={
        <WorkbenchScopedUsageDialog
          environmentId={environmentId}
          threadId={threadId}
          providerInstanceId={providerInstanceId}
        />
      }
    />
  );
}

// --- Scoped run usage dialog (Dokkabi R8) ---
//
// The on-demand Total run usage read: the MAIN scope plus every child
// session this session's own rows reference, each over its largest
// parent-pinned verified prefix. The read is a separate keyed query with NO
// refresh interval — it runs only while the dialog is open and on an
// explicit Refresh. Totals are recorded tokens, never billing; missing
// fields read Unknown; request-versus-usage gaps stay explicit; the
// original-source proof disclosure carries child prefix hashes and parent
// provenance only — never credentials or host paths.

const USAGE_METRIC_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

/** A totals-shaped metric: per-scope records carry this plus their own refs. */
interface ScopedUsageTotals {
  readonly total: number | null;
  readonly missing: number;
}

function ScopedUsageMetricRows({
  usage,
}: {
  readonly usage: Readonly<Record<(typeof USAGE_METRIC_FIELDS)[number], ScopedUsageTotals>>;
}) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {USAGE_METRIC_FIELDS.map((field) => {
        const metric = usage[field];
        return (
          <li key={field} data-usage-field={field}>
            {field}: {scopedUsageMetricLabel(metric)} · {metric.missing} missing record
            {metric.missing === 1 ? "" : "s"}
          </li>
        );
      })}
    </ul>
  );
}

function ScopedUsageChildScope({ scope }: { readonly scope: WorkbenchChildUsageScope }) {
  return (
    <section
      className="rounded border border-border p-2"
      data-scoped-usage-child={scope.id}
      data-child-state={scope.state}
    >
      <h4 className="font-mono text-xs font-medium">{scope.id}</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        {childScopeStateLabel(scope.state)} · {scope.roles.join(", ")}
      </p>
      {scope.counts !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">{usageCountsGapLabel(scope.counts)}</p>
      ) : null}
      {scope.usage !== null ? (
        <ScopedUsageMetricRows usage={scope.usage} />
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Recorded totals Unknown — no pinned closed prefix certifies any usage.
        </p>
      )}
      {scope.detail !== null ? <p className="mt-1 text-xs">{scope.detail}</p> : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Original source proof
        </summary>
        <div className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
          {scope.pinnedHead !== null ? (
            <p className="font-mono" data-child-pinned-prefix>
              pinned prefix {sourceRefLabel(scope.pinnedHead)}
            </p>
          ) : null}
          {scope.head !== null ? (
            <p className="font-mono" data-child-head>
              child head {sourceRefLabel(scope.head)}
            </p>
          ) : null}
          <ul className="list-disc pl-4">
            {scope.provenance.map((entry) => (
              <li
                key={`${entry.producer}:${entry.field}:${entry.ref.seq}:${entry.ref.hash}`}
                className="font-mono"
              >
                {entry.producer} · {entry.field} · parent {sourceRefLabel(entry.ref)} · pinned{" "}
                {entry.pinnedHash === null ? "none" : `${entry.pinnedHash.slice(0, 12)}…`}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </section>
  );
}

/** The pure report view: renders one resolved dialog state, holds no query. */
export function WorkbenchScopedUsageReportView({
  state,
}: {
  readonly state: WorkbenchScopedUsageDialogState;
}) {
  if (state.kind === "pending") {
    return (
      <p className="text-sm text-muted-foreground" data-scoped-usage="pending">
        reading the recorded run usage…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="text-sm text-destructive" data-scoped-usage="error">
        The scoped usage read failed: {state.reason}
      </p>
    );
  }
  if (state.kind === "unsupported") {
    return (
      <p className="text-sm text-muted-foreground" data-scoped-usage="unsupported">
        Scoped run usage is not supported here: {state.reason}
      </p>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <p className="text-sm text-muted-foreground" data-scoped-usage="unavailable">
        Scoped run usage is unavailable right now: {state.reason}
      </p>
    );
  }
  const { report } = state;
  return (
    <div className="flex flex-col gap-3 text-sm" data-scoped-usage="view">
      <section>
        <h4 className="mb-1 font-medium" data-scoped-usage-state={report.state}>
          {scopedUsageStateLabel(report.state)}
        </h4>
        <p className="text-xs text-muted-foreground">
          {report.aggregate.scopesCounted} scope
          {report.aggregate.scopesCounted === 1 ? "" : "s"} counted ·{" "}
          {usageCountsGapLabel(report.aggregate.counts)} · recorded tokens, not billing.
        </p>
        {report.details.length > 0 ? (
          <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground" data-scoped-usage-details>
            {report.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
        {report.errors.length > 0 ? (
          <ul className="mt-1 list-disc pl-4 text-xs text-destructive" data-scoped-usage-errors>
            {report.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <section>
        <h4 className="mb-1 font-medium" data-scoped-usage-main-title>
          Main usage
        </h4>
        <p className="font-mono text-xs text-muted-foreground" data-scoped-usage-main-session>
          session {report.main.sessionId} · head {sourceRefLabel(report.main.head)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {report.main.settled
            ? "All recorded turns settled."
            : "A recorded turn is still running; its final usage is not recorded yet."}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {usageCountsGapLabel(report.main.counts)}
        </p>
        <div className="mt-1">
          <ScopedUsageMetricRows usage={report.main.usage} />
        </div>
      </section>
      {report.scopes.length > 0 ? (
        <section>
          <h4 className="mb-1 font-medium" data-scoped-usage-children-title>
            Referenced child sessions
          </h4>
          <div className="flex flex-col gap-2">
            {report.scopes.map((scope) => (
              <ScopedUsageChildScope key={scope.id} scope={scope} />
            ))}
          </div>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">
          No child sessions are referenced by this run.
        </p>
      )}
      <section>
        <h4 className="mb-1 font-medium">Run total</h4>
        <p className="text-xs text-muted-foreground">{usageCountsGapLabel(report.aggregate.counts)}</p>
        <div className="mt-1">
          <ScopedUsageMetricRows usage={report.aggregate} />
        </div>
        <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground" data-scoped-usage-semantics>
          <li>Totals are recorded usage, not billing.</li>
          <li>Reasoning: Included in the output total.</li>
          <li>Cache read: Counted separately from the input total.</li>
          <li>Cache write: Counted separately from the input total.</li>
        </ul>
      </section>
    </div>
  );
}

/**
 * The dialog's live body: the ONLY subscriber of the scoped usage query, so
 * the read runs exactly while the dialog is open (plus one explicit Refresh
 * per click). Keyed by its scope: switching scopes remounts under the new
 * key and a late old-scope response cannot contaminate the new view.
 */
export function WorkbenchScopedUsageDialogBody({
  environmentId,
  threadId,
  providerInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}) {
  const query = useEnvironmentQuery(
    workbenchScopedUsageAtomFor({ environmentId, threadId, providerInstanceId }),
  );
  const state = resolveWorkbenchScopedUsage({ query });
  return (
    <div className="flex flex-col gap-3" data-workbench-scoped-usage-body>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          On-demand read — no periodic scanning.
        </p>
        <Button
          variant="outline"
          size="xs"
          data-workbench-scoped-usage-refresh="true"
          onClick={() => query.refresh()}
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <WorkbenchScopedUsageReportView state={state} />
    </div>
  );
}

/**
 * The Total run usage dialog: an accessible read-only dialog opened from
 * the workbench bar. Closing it ends the query's only subscription (the
 * read stops); reopening remounts the body under the current scope key and
 * reads fresh (staleTime 0).
 */
export function WorkbenchScopedUsageDialog({
  environmentId,
  threadId,
  providerInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}) {
  const [open, setOpen] = useState(false);
  const scopeKey = workbenchScopedUsageScopeKey({ environmentId, threadId, providerInstanceId });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        data-workbench-open-scoped-usage="true"
        onClick={() => setOpen(true)}
      >
        <GaugeIcon className="size-3.5" aria-hidden="true" />
        Total run usage
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Total run usage (recorded, not billing)</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {open ? (
            <WorkbenchScopedUsageDialogBody
              key={scopeKey}
              environmentId={environmentId}
              threadId={threadId}
              providerInstanceId={providerInstanceId}
            />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            data-workbench-scoped-usage-close="true"
            onClick={() => setOpen(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
