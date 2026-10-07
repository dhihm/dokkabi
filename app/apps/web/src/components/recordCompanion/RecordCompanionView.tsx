/**
 * The shared controlled Record/Decisions view (Dokkabi R6).
 *
 * The Record surface presentation — tabs plus either the bounded explorer
 * (metadata page, selected row's byte window, explicit proof) or the historic
 * R5 verified-prefix page with inert <pre> row JSON — as one controlled
 * component used in BOTH placements:
 * docked beside the composer and inside the restricted native companion
 * window. It owns no state and starts no queries; the embedding surface feeds
 * the R5-resolved panel state and the current view preferences and receives
 * the CLOSED action vocabulary (first/next/pin/follow/select-from-page/tab).
 * Rows always render as inert text; inspection never mutates the
 * conversation, and `interactive=false` renders the same view visibly inert
 * (handoff preparing, docking quiesce) without unmounting it.
 */
import type { ReactNode } from "react";
import { ListOrderedIcon, PinIcon, PinOffIcon, ScrollTextIcon } from "lucide-react";
import type {
  RecordCompanionViewAction,
  RecordCompanionViewPreferences,
  WorkbenchRecordRow,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RecordExplorerView } from "../recordExplorer/RecordExplorerView";
import {
  decisionsFact,
  pinLabel,
  recordRowHashChip,
  recordRowJson,
  recordRowLabel,
  type DecisionRecordPanelState,
} from "../chat/DecisionRecordSurface.logic";

function PanelMessage({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: string | undefined;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail ? <p className="max-w-[46ch] text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/**
 * The decisions capability fact: explicit, honest, never a fake control.
 * Decision responses and alternate branches are unavailable for this
 * session — no policy execution or fork action is offered, and no pending
 * list is invented. The raw capability reason stays in optional diagnostic
 * details, out of the normal copy.
 */
function DecisionsTab({ reason }: { readonly reason?: string | undefined }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto px-3 py-4" data-decisions-tab>
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs font-medium text-foreground">
          Decision responses are unavailable for this session
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Decision responses and alternate branches are unavailable. Use Record to inspect the
          retained history.
        </p>
        {reason ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-3xs text-muted-foreground">
              Diagnostic details
            </summary>
            <p className="mt-1 font-mono text-3xs leading-relaxed text-muted-foreground">
              {reason}
            </p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** One retained row: exact seq/kind/name/hash, selectable for the inspector. */
function RecordRow({
  row,
  selected,
  disabled,
  onSelect,
}: {
  readonly row: WorkbenchRecordRow;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-3xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        selected && "bg-muted",
      )}
      onClick={onSelect}
      data-record-seq={row.seq}
      aria-pressed={selected}
      aria-disabled={disabled}
      disabled={disabled}
    >
      <span className="w-10 shrink-0 text-right text-muted-foreground">{row.seq}</span>
      <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">{row.kind}</span>
      <span className="min-w-0 truncate text-foreground">{row.name}</span>
      <span className="ml-auto shrink-0 text-muted-foreground">{recordRowHashChip(row)}</span>
    </button>
  );
}

/**
 * The shared controlled Decision/Record view. See the module comment; the
 * embedding surface owns the query, the view preferences and the action
 * application (through the closed R6 reducer or the R5 local handlers).
 */
export function RecordCompanionView({
  state,
  view,
  interactive,
  onAction,
  sourceLabel,
  headerExtra,
}: {
  /** The R5-resolved panel state (retention, stale and quarantine included). */
  readonly state: DecisionRecordPanelState;
  /** The current tab/pin/page/selection preferences. */
  readonly view: RecordCompanionViewPreferences;
  /** False renders the exact same view visibly inert (no action fires). */
  readonly interactive: boolean;
  /** Receives exactly the closed action vocabulary. */
  readonly onAction: (action: RecordCompanionViewAction) => void;
  /** Honest factual source label (companion window); omitted docked. */
  readonly sourceLabel?: string | undefined;
  /** Extra header controls (native open/dock, placement badges). */
  readonly headerExtra?: ReactNode | undefined;
}) {
  const page = state.kind === "view" ? state.page : null;
  const selectedRow =
    page?.state === "available"
      ? (page.records.find((row) => row.seq === view.selectedSeq) ?? page.records[0] ?? null)
      : null;
  const decisions = page !== null ? decisionsFact(page.decisions) : null;
  const canPin = page !== null && page.state === "available";
  const canNext = page?.state === "available" && page.hasMore && page.next !== null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-record-companion-view="true"
      aria-readonly={!interactive}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <ScrollTextIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium text-foreground">Decision / Record</span>
        {sourceLabel ? (
          <span
            className="truncate font-mono text-3xs text-muted-foreground"
            data-record-source-label
          >
            {sourceLabel}
          </span>
        ) : null}
        {(state.kind === "view" || state.kind === "explorer") && state.staleError !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="rounded bg-warning/12 px-1.5 py-0.5 font-medium text-warning-foreground"
                  data-record-stale="true"
                />
              }
            >
              stale
            </TooltipTrigger>
            <TooltipPopup side="bottom">{state.staleError}</TooltipPopup>
          </Tooltip>
        ) : null}
        {headerExtra}
        <span className="grow" />
        <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5" role="tablist">
          <Button
            variant="ghost"
            size="xs"
            role="tab"
            aria-selected={view.tab === "decisions"}
            data-decisions-tab-trigger="true"
            disabled={!interactive}
            onClick={() => onAction({ type: "tab", tab: "decisions" })}
          >
            Decisions
          </Button>
          <Button
            variant="ghost"
            size="xs"
            role="tab"
            aria-selected={view.tab === "record"}
            data-record-tab-trigger="true"
            disabled={!interactive}
            onClick={() => onAction({ type: "tab", tab: "record" })}
          >
            <ListOrderedIcon className="size-3.5" aria-hidden="true" />
            Record
          </Button>
        </div>
      </div>

      {view.tab === "decisions" ? (
        state.kind === "explorer" ? (
          <DecisionsTab />
        ) : decisions !== null ? (
          <DecisionsTab reason={decisions.reason} />
        ) : state.kind === "unsupported" ? (
          <DecisionsTab reason={state.reason} />
        ) : state.kind === "unavailable" ? (
          <PanelMessage title="Decisions unavailable" detail={state.reason} />
        ) : (
          <PanelMessage title="Decisions…" detail="Reading the recorded capability." />
        )
      ) : state.kind === "unsupported" ? (
        <PanelMessage title="Records unsupported" detail={state.reason} />
      ) : state.kind === "unavailable" ? (
        <PanelMessage title="Records unavailable" detail={state.reason} />
      ) : state.kind === "pending" ? (
        <PanelMessage title="Reading retained records…" />
      ) : state.kind === "explorer" ? (
        <RecordExplorerView
          index={state.index}
          body={state.body}
          verification={state.verification}
          view={view}
          interactive={interactive}
          onAction={onAction}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {page?.state === "unavailable" ? (
            <div
              className="border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              data-record-body-unavailable="true"
            >
              The requested page cannot be served exactly: {page.reason}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
            <span className="font-mono text-3xs text-muted-foreground" data-record-source-summary>
              {page !== null
                ? `${page.total} pinned · head ${page.sessionCursor.seq} · asOf ${page.asOf.seq} · cursor ${page.records.at(-1)?.seq ?? view.after?.seq ?? 0}${page.hasMore ? " · more" : ""}`
                : ""}
            </span>
            <span className="grow" />
            <Button
              variant="ghost"
              size="xs"
              data-record-first-page="true"
              disabled={!interactive || view.after === null}
              onClick={() => onAction({ type: "first" })}
            >
              First page
            </Button>
            <Button
              variant="ghost"
              size="xs"
              data-record-next-page="true"
              disabled={!interactive || !canNext}
              onClick={() => onAction({ type: "next" })}
            >
              Next
            </Button>
            <Button
              variant="ghost"
              size="xs"
              data-record-pin-toggle="true"
              disabled={!interactive || (!canPin && view.pin === null)}
              aria-pressed={view.pin !== null}
              onClick={() => onAction(view.pin === null ? { type: "pin" } : { type: "follow" })}
            >
              {view.pin === null ? (
                <PinIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <PinOffIcon className="size-3.5" aria-hidden="true" />
              )}
              {view.pin === null ? "Pin" : "Follow"}
            </Button>
          </div>
          {page?.state === "available" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-auto py-1" data-record-rows>
                {page.records.map((row) => (
                  <RecordRow
                    key={row.seq}
                    row={row}
                    selected={selectedRow?.seq === row.seq}
                    disabled={!interactive}
                    onSelect={() => {
                      if (interactive) onAction({ type: "select", seq: row.seq });
                    }}
                  />
                ))}
                {page.records.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    No retained rows in this window.
                  </p>
                ) : null}
              </div>
              {selectedRow !== null ? (
                <div className="max-h-[50%] min-h-0 shrink-0 border-t border-border">
                  <div className="flex items-center gap-2 px-3 py-1">
                    <span className="font-mono text-3xs text-muted-foreground">
                      {recordRowLabel(selectedRow)}
                    </span>
                    {view.pin !== null && page !== null ? (
                      <span className="ml-auto font-mono text-3xs text-muted-foreground">
                        {pinLabel(page)}
                      </span>
                    ) : null}
                  </div>
                  {/* Inert text: the exact retained row as JSON, never HTML. */}
                  <pre
                    className="max-h-48 overflow-auto px-3 pb-2 font-mono text-3xs leading-relaxed text-foreground"
                    data-record-row-json={selectedRow.seq}
                  >
                    {recordRowJson(selectedRow)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
