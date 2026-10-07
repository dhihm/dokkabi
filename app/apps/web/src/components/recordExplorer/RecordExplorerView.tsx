/**
 * The bounded record explorer body of the shared Record view (docked and
 * companion placements). Controlled: it renders the owner-resolved metadata
 * page, the selected row's validated byte window and its explicit proof
 * state, and emits only the closed action vocabulary. All text is inert.
 *
 * DOM stays bounded: at most one metadata page (50 rows) and one decoded
 * window (at most 32768 bytes). The body is never fetched or concatenated
 * whole; partial ranges are labeled as such and never as a record proof.
 */
import { useState } from "react";
import { PinIcon, PinOffIcon, ShieldCheckIcon } from "lucide-react";
import type {
  ProviderWorkbenchRecordIndex,
  RecordCompanionBodyWindow,
  RecordCompanionVerification,
  RecordCompanionViewAction,
  RecordCompanionViewPreferences,
  WorkbenchRecordDescriptor,
} from "@t3tools/contracts";
import { WORKBENCH_RECORD_BODY_MAX_BYTES } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { digestChip, selectedRecordDescriptor } from "./recordExplorer.logic";
import { RECORD_VERIFY_MAX_BYTES } from "./recordBodyWindow";

function DescriptorRow({
  entry,
  selected,
  disabled,
  onSelect,
}: {
  readonly entry: WorkbenchRecordDescriptor;
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
      data-record-seq={entry.seq}
      aria-pressed={selected}
      aria-disabled={disabled}
      disabled={disabled}
    >
      <span className="w-10 shrink-0 text-right text-muted-foreground">{entry.seq}</span>
      <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">{entry.kind}</span>
      <span className="min-w-0 truncate text-foreground">{entry.name}</span>
      {entry.nameTruncated ? (
        <span
          className="shrink-0 rounded bg-muted px-1 text-muted-foreground"
          data-record-name-excerpt="true"
          title="Display excerpt of a longer recorded name; the exact value is in the body."
        >
          excerpt
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-muted-foreground">{entry.byteLength} B</span>
      <span className="shrink-0 text-muted-foreground">{entry.hash.slice(0, 12)}</span>
    </button>
  );
}

function BodyPane({
  descriptor,
  body,
  verification,
  interactive,
  onAction,
}: {
  readonly descriptor: WorkbenchRecordDescriptor;
  readonly body: RecordCompanionBodyWindow;
  readonly verification: RecordCompanionVerification;
  readonly interactive: boolean;
  readonly onAction: (action: RecordCompanionViewAction) => void;
}) {
  const [jump, setJump] = useState("");
  const window = body.status === "window" ? body : null;
  const jumpOffset = /^\d+$/u.test(jump.trim()) ? Number(jump.trim()) : null;
  const jumpValid = jumpOffset !== null && jumpOffset < descriptor.byteLength;
  const disabled = !interactive;
  return (
    <div className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-t border-border">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1">
        <span className="font-mono text-3xs text-muted-foreground" data-record-body-summary>
          {`row ${descriptor.seq} · ${descriptor.ts}${descriptor.tsTruncated ? " (excerpt)" : ""} · `}
          {window !== null
            ? `bytes ${window.start}–${window.end} of ${descriptor.byteLength}`
            : `${descriptor.byteLength} bytes`}
          {` · sha256 ${digestChip(descriptor.bodyDigest)}…`}
        </span>
        <span className="grow" />
        <Button
          variant="ghost"
          size="xs"
          data-record-body-first="true"
          disabled={disabled || window === null || window.start === 0}
          onClick={() => onAction({ type: "bodyFirst" })}
        >
          Start
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-record-body-previous="true"
          disabled={disabled || window === null || window.start === 0}
          onClick={() => onAction({ type: "bodyPrevious" })}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-record-body-next="true"
          disabled={disabled || window === null || window.end >= window.totalBytes}
          onClick={() => onAction({ type: "bodyNext" })}
        >
          Next
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-record-body-last="true"
          disabled={disabled || window === null || window.end >= window.totalBytes}
          onClick={() => onAction({ type: "bodyLast" })}
        >
          End
        </Button>
        <input
          className="h-6 w-24 rounded border border-border bg-background px-1 font-mono text-3xs"
          inputMode="numeric"
          aria-label="Jump to byte offset"
          placeholder="byte offset"
          value={jump}
          disabled={disabled}
          onChange={(event) => setJump(event.target.value)}
          data-record-body-jump-input="true"
        />
        <Button
          variant="ghost"
          size="xs"
          data-record-body-jump="true"
          disabled={disabled || !jumpValid}
          onClick={() => {
            if (jumpOffset !== null && jumpValid)
              onAction({ type: "bodyJump", offset: jumpOffset });
          }}
        >
          Jump
        </Button>
      </div>
      {window !== null ? (
        <p
          className="px-3 pb-1 font-mono text-3xs text-muted-foreground"
          data-record-body-flags="true"
        >
          {window.start === 0 && window.end === window.totalBytes
            ? "complete byte range (range-checked; not a record proof)"
            : "partial range (range-checked; not a record proof)"}
          {window.leadingOmitted ? ` · ${window.start} bytes before omitted` : ""}
          {window.trailingOmitted ? ` · ${window.totalBytes - window.end} bytes after omitted` : ""}
          {window.startExtended || window.endExtended
            ? " · widened to UTF-8 character boundaries"
            : ""}
        </p>
      ) : null}
      <VerificationLine
        descriptor={descriptor}
        verification={verification}
        interactive={interactive}
        onAction={onAction}
      />
      {body.status === "window" ? (
        // Inert text: one decoded window of the exact canonical bytes.
        <pre
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-3xs leading-relaxed text-foreground"
          data-record-body-window="true"
          data-record-body-row={body.row.seq}
          data-record-body-start={body.start}
          data-record-body-end={body.end}
          data-record-body-total={body.totalBytes}
        >
          {body.text}
        </pre>
      ) : body.status === "pending" ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground" data-record-body-pending="true">
          Reading bytes from {body.requestedStart} (at most {WORKBENCH_RECORD_BODY_MAX_BYTES}{" "}
          bytes)…
        </p>
      ) : body.status === "none" ? null : (
        <p
          className="px-3 pb-2 text-xs text-destructive"
          data-record-body-error="true"
          data-record-body-status={body.status}
        >
          {body.status === "failed"
            ? `The range failed its checks and is not shown: ${body.reason}`
            : body.status === "unsupported"
              ? `Bounded body reads are unsupported here: ${body.reason}`
              : `The body range is unavailable: ${body.reason}`}
        </p>
      )}
    </div>
  );
}

function VerificationLine({
  descriptor,
  verification,
  interactive,
  onAction,
}: {
  readonly descriptor: WorkbenchRecordDescriptor;
  readonly verification: RecordCompanionVerification;
  readonly interactive: boolean;
  readonly onAction: (action: RecordCompanionViewAction) => void;
}) {
  const ranges = Math.ceil(descriptor.byteLength / WORKBENCH_RECORD_BODY_MAX_BYTES);
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-3 pb-1 text-3xs"
      data-record-verification="true"
      data-record-verification-status={verification.status}
    >
      <Button
        variant="outline"
        size="xs"
        data-record-verify="true"
        disabled={
          !interactive ||
          verification.status === "pending" ||
          verification.status === "refused" ||
          verification.status === "exact"
        }
        onClick={() => onAction({ type: "verify" })}
      >
        <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
        Verify whole record
      </Button>
      {verification.status === "pending" ? (
        <>
          <span className="text-muted-foreground">
            Verifying on the server: {ranges} ranges are streamed against the body digest and the
            row's event hash. No live progress is reported.
          </span>
          <Button
            variant="ghost"
            size="xs"
            data-record-verify-cancel="true"
            disabled={!interactive}
            onClick={() => onAction({ type: "cancelVerify" })}
          >
            Cancel
          </Button>
        </>
      ) : verification.status === "exact" ? (
        <span className="text-emerald-600 dark:text-emerald-400">
          Exact: {verification.verification.chunks} ranges ({verification.verification.totalBytes}{" "}
          bytes) match the body digest and the row's event hash at pin seq{" "}
          {verification.verification.asOf.seq}.
        </span>
      ) : verification.status === "refused" ? (
        <span className="text-muted-foreground">
          {verification.reason} (limit {RECORD_VERIFY_MAX_BYTES} bytes)
        </span>
      ) : verification.status === "failed" ? (
        <span className="text-destructive">Not verified: {verification.reason}</span>
      ) : (
        <span className="text-muted-foreground">Not verified. Ranges are only range-checked.</span>
      )}
    </div>
  );
}

export function RecordExplorerView({
  index,
  body,
  verification,
  view,
  interactive,
  onAction,
}: {
  readonly index: ProviderWorkbenchRecordIndex;
  readonly body: RecordCompanionBodyWindow;
  readonly verification: RecordCompanionVerification;
  readonly view: RecordCompanionViewPreferences;
  readonly interactive: boolean;
  readonly onAction: (action: RecordCompanionViewAction) => void;
}) {
  const descriptor = selectedRecordDescriptor(index, view);
  const first = index.entries[0]?.seq ?? 0;
  const last = index.entries.at(-1)?.seq ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-record-explorer="true">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <span className="font-mono text-3xs text-muted-foreground" data-record-index-summary>
          {index.entries.length > 0
            ? `rows ${first}–${last} of ${index.total}`
            : `0 of ${index.total}`}
          {` · ${view.pin !== null ? `pinned @ seq ${index.asOf.seq}` : "live"} · head ${index.sessionCursor.seq}`}
          {index.hasMore ? " · more" : ""}
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
          disabled={!interactive || !index.hasMore || index.next === null}
          onClick={() => onAction({ type: "next" })}
        >
          Next
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-record-pin-toggle="true"
          disabled={!interactive}
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
      <div className="min-h-0 flex-1 overflow-auto py-1" data-record-rows>
        {index.entries.map((entry) => (
          <DescriptorRow
            key={entry.seq}
            entry={entry}
            selected={view.selectedSeq === entry.seq}
            disabled={!interactive}
            onSelect={() => {
              if (interactive) onAction({ type: "select", seq: entry.seq });
            }}
          />
        ))}
        {index.entries.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No retained rows in this window.
          </p>
        ) : null}
      </div>
      {descriptor !== null ? (
        <BodyPane
          key={descriptor.seq}
          descriptor={descriptor}
          body={body}
          verification={verification}
          interactive={interactive}
          onAction={onAction}
        />
      ) : (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Select a row to read its exact canonical bytes in bounded ranges.
        </p>
      )}
    </div>
  );
}
