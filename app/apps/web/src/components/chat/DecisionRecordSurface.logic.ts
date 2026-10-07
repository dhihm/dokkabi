import type {
  ProviderWorkbenchRecord,
  ProviderWorkbenchRecordIndex,
  ProviderWorkbenchRecordResult,
  RecordCompanionBodyWindow,
  RecordCompanionVerification,
  WorkbenchRecordAsOf,
  WorkbenchRecordCursor,
  WorkbenchRecordDecisions,
  WorkbenchRecordRow,
} from "@t3tools/contracts";
import type { EnvironmentQueryView } from "~/state/query";
import { workbenchRecordScopeKey, type WorkbenchRecordScope } from "~/state/workbenchRecord";

/**
 * Pure view-model for the R5 Decision/Record surface
 * (docs/internals/dokkabi-records-r5.md). Semantics held here:
 * - A live query error OUTRANKS the value in `data`: the same scope's last
 *   valid page stays rendered, labeled stale, until a fresh success lands.
 * - Retention is same-scope only (environment+thread+instance+page): a
 *   different scope NEVER observes its predecessor's page or selection, and
 *   a late old-scope response cannot overwrite the new scope's view.
 * - The unsupported/unavailable capability results render explicit states;
 *   an explicitly opened panel never hides as if nothing happened.
 * - Page integrity is re-checked before a fresh page replaces the retained
 *   one: contiguous exact rows, honest completion, next/total coherence and
 *   rows within the pinned prefix. A page that fails never renders.
 * - Decisions are a capability fact, never data: the surface states the
 *   kernel has no decision execution or branch fork surface instead of
 *   inventing a pending-decision list from ordinary prose.
 */

export type DecisionRecordPanelState =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "view";
      readonly page: ProviderWorkbenchRecord;
      readonly staleError: string | null;
    }
  | {
      /** Bounded explorer: one metadata page, the selected row's validated
       * byte window and its explicit verification state. */
      readonly kind: "explorer";
      readonly index: ProviderWorkbenchRecordIndex;
      readonly staleError: string | null;
      readonly body: RecordCompanionBodyWindow;
      readonly verification: RecordCompanionVerification;
    };

/** The latest retained page view, keyed to the scope it belongs to. */
export interface RetainedWorkbenchRecordPage {
  /** Composite client-only scope key (environment+thread+instance+page). */
  readonly scopeKey: string;
  readonly page: ProviderWorkbenchRecord;
}

const pageOf = (result: ProviderWorkbenchRecordResult | null): ProviderWorkbenchRecord | null =>
  result !== null && result.status === "available" && result.record !== undefined
    ? result.record
    : null;

/**
 * Independent source-head continuity between the retained view and a fresh
 * same-scope success. Record reads never advance the transcript cursors,
 * and a poll may also never REWIND either independent head or replace the
 * session/generation: a response doing so is quarantined behind an explicit
 * stale error while the last validated page stays rendered. A pinned prefix
 * below the head is NOT a replacement — pins survive appends by design.
 */
export function recordHeadContinuityError(
  previous: Pick<ProviderWorkbenchRecord, "sessionCursor" | "gatewayCursor">,
  next: Pick<ProviderWorkbenchRecord, "sessionCursor" | "gatewayCursor">,
): string | null {
  if (next.sessionCursor.sessionId !== previous.sessionCursor.sessionId) {
    return `The recorded session source was replaced (session ${next.sessionCursor.sessionId.slice(0, 12)}…, expected ${previous.sessionCursor.sessionId.slice(0, 12)}…); keeping the last validated page.`;
  }
  if (next.sessionCursor.generation !== previous.sessionCursor.generation) {
    return "The recorded session source was replaced (new generation); keeping the last validated page.";
  }
  if (next.sessionCursor.seq < previous.sessionCursor.seq) {
    return `The session head rewound (seq ${next.sessionCursor.seq} after ${previous.sessionCursor.seq}); keeping the last validated page.`;
  }
  if (
    next.sessionCursor.seq === previous.sessionCursor.seq &&
    next.sessionCursor.hash !== previous.sessionCursor.hash
  ) {
    return `The session head at seq ${previous.sessionCursor.seq} carries a different hash; keeping the last validated page.`;
  }
  if (next.gatewayCursor.generation !== previous.gatewayCursor.generation) {
    return "The gateway's durable ledger was replaced; keeping the last validated page.";
  }
  if (next.gatewayCursor.seq < previous.gatewayCursor.seq) {
    return `The gateway head rewound (seq ${next.gatewayCursor.seq} after ${previous.gatewayCursor.seq}); keeping the last validated page.`;
  }
  if (
    next.gatewayCursor.seq === previous.gatewayCursor.seq &&
    next.gatewayCursor.hash !== previous.gatewayCursor.hash
  ) {
    return `The gateway head at seq ${previous.gatewayCursor.seq} carries a different hash; keeping the last validated page.`;
  }
  return null;
}

/**
 * Exact page integrity, checked in the renderer before a fresh page is
 * rendered or retained: ascending contiguous seqs chained through
 * prev_hash, every row within the pinned prefix, honest completion (a
 * complete page ends exactly at the pin; an empty complete page only when
 * the window is empty), a next cursor that describes the page's actual end,
 * and a total equal to the pin. Returns null when the page is exact.
 */
export function recordPageIntegrityError(input: {
  readonly page: ProviderWorkbenchRecord;
  /** The after cursor the page was requested with, when it was. */
  readonly after?: WorkbenchRecordCursor | undefined;
}): string | null {
  const page = input.page;
  if (page.state === "unavailable") {
    if (page.records.length > 0 || page.next !== null || page.hasMore !== false) {
      return "An unavailable record body must not carry rows, a next cursor or hasMore.";
    }
    return null;
  }
  const asOf = page.asOf;
  const records = page.records;
  let previous: WorkbenchRecordRow | undefined;
  for (const row of records) {
    if (previous !== undefined) {
      if (row.seq !== previous.seq + 1) {
        return `The page is not contiguous at seq ${row.seq}.`;
      }
      if (row.prev_hash !== previous.hash) {
        return `The row at seq ${row.seq} does not chain from the previous row's hash.`;
      }
    } else if (input.after !== undefined) {
      if (row.seq !== input.after.seq + 1 || row.prev_hash !== input.after.hash) {
        return `The page does not begin exactly after the requested cursor (seq ${input.after.seq}).`;
      }
    } else if (row.seq !== 1) {
      return "A page without an after cursor must begin at the log's first row.";
    }
    if (row.seq > asOf.seq) {
      return `The row at seq ${row.seq} lies beyond the pinned prefix (${asOf.seq}).`;
    }
    previous = row;
  }
  const last = records.at(-1);
  if (page.hasMore) {
    if (last === undefined) {
      return "An empty page claims more rows remain in the requested window.";
    }
    if (page.next === null || page.next.seq !== last.seq || page.next.hash !== last.hash) {
      return "The next cursor must be the last included row when more rows remain.";
    }
    if (last.seq >= asOf.seq) {
      return "The page claims more rows remain at or beyond its own pinned end.";
    }
  } else {
    if (page.next !== null) {
      return "A complete page must not carry a next cursor.";
    }
    const end = last?.seq ?? input.after?.seq ?? 0;
    if (end !== asOf.seq) {
      return `A complete page must end at the pinned prefix (seq ${asOf.seq}); it ended at ${end}.`;
    }
  }
  if (page.total !== asOf.seq) {
    return `The page total (${page.total}) is not the pinned prefix's own seq (${asOf.seq}).`;
  }
  return null;
}

/**
 * Resolve the panel's state from the keyed query plus the previously
 * retained page. The retained page is used only when its composite scope
 * key is the query's own; otherwise it is discarded before anything is
 * decided — a moved thread/instance/page keeps no old scope's rows. An
 * unsubscribed (hidden) panel renders its retained page without polling; a
 * fresh success that breaks independent head continuity or page integrity
 * is quarantined behind an explicit stale error.
 */
export function resolveDecisionRecordPanel(input: {
  readonly scopeKey: string;
  readonly query: Pick<
    EnvironmentQueryView<ProviderWorkbenchRecordResult>,
    "data" | "error" | "isPending"
  >;
  readonly retained: RetainedWorkbenchRecordPage | null;
  /** False while the panel is hidden/closed (atom unsubscribed, no polling). */
  readonly subscribed?: boolean;
  readonly after?: WorkbenchRecordCursor | undefined;
}): DecisionRecordPanelState {
  const retained =
    input.retained !== null && input.retained.scopeKey === input.scopeKey ? input.retained : null;
  if (input.subscribed === false) {
    // Hidden/closed panel: the query atom is unsubscribed (polling stopped),
    // so the query view is empty — the retained page is the honest display.
    return retained !== null
      ? { kind: "view", page: retained.page, staleError: null }
      : { kind: "pending" };
  }
  // A live failure outranks the retained success inside `data`: same-scope
  // valid data stays visibly stale (idle failure or in-flight refresh), and
  // nothing is cleared until a fresh success lands.
  if (input.query.error !== null) {
    const stale = retained?.page ?? pageOf(input.query.data);
    if (stale !== null) {
      return { kind: "view", page: stale, staleError: input.query.error };
    }
    return { kind: "unavailable", reason: input.query.error };
  }
  if (input.query.data !== null) {
    const result = input.query.data;
    if (result.status === "unsupported") {
      return {
        kind: "unsupported",
        reason: result.reason ?? "This provider has no retained record capability.",
      };
    }
    if (result.status === "unavailable") {
      return {
        kind: "unavailable",
        reason: result.reason ?? "The retained records are not available right now.",
      };
    }
    const fresh = result.record;
    if (fresh === undefined) {
      // The envelope says available but carries no page: never trust the
      // label over the payload.
      return {
        kind: "unavailable",
        reason:
          "The source reported an available record read without a payload; refusing to render it.",
      };
    }
    const integrity = recordPageIntegrityError({ page: fresh, after: input.after });
    if (integrity !== null) {
      // The page never renders and never overwrites retention, even when no
      // prior view exists to fall back to.
      return retained !== null
        ? { kind: "view", page: retained.page, staleError: integrity }
        : { kind: "unavailable", reason: integrity };
    }
    if (retained !== null) {
      const continuity = recordHeadContinuityError(retained.page, fresh);
      if (continuity !== null) {
        // Quarantine: the replacement never renders as fresh data and never
        // overwrites retention; the last validated page carries the error.
        return { kind: "view", page: retained.page, staleError: continuity };
      }
    }
    return { kind: "view", page: fresh, staleError: null };
  }
  return input.query.isPending ? { kind: "pending" } : { kind: "unavailable", reason: "" };
}

/** True when two scopes name the same environment+thread+instance+page view. */
export function sameWorkbenchRecordScope(
  left: WorkbenchRecordScope,
  right: WorkbenchRecordScope,
): boolean {
  return workbenchRecordScopeKey(left) === workbenchRecordScopeKey(right);
}

// --- Pin/Follow view model ---

/** The pin's view-facing identity: null means FOLLOW the live head. */
export function pinLabel(page: ProviderWorkbenchRecord): string {
  return page.state === "unavailable"
    ? `pin @ ${page.asOf.seq} (body unavailable)`
    : `pinned @ seq ${page.asOf.seq} of ${page.sessionCursor.seq}`;
}

/** The pin captured from a page: its immutable asOf prefix. */
export function pinOf(page: ProviderWorkbenchRecord): WorkbenchRecordAsOf {
  return page.asOf;
}

// --- Row display (inert text only; never executable HTML or links) ---

/** Stable row list label: exact seq, kind and recorded name. */
export function recordRowLabel(row: WorkbenchRecordRow): string {
  return `${row.seq} · ${row.kind} · ${row.name}`;
}

/** Short exact hash chip: the row's own recorded hash. */
export function recordRowHashChip(row: Pick<WorkbenchRecordRow, "hash">): string {
  return row.hash.slice(0, 12);
}

/** The row's exact JSON for the source inspector, as plain text. */
export function recordRowJson(row: WorkbenchRecordRow): string {
  return JSON.stringify(row, null, 2);
}

/** The decisions capability fact: fixed vocabulary, no invented authority. */
export function decisionsFact(decisions: WorkbenchRecordDecisions): {
  readonly status: "unsupported";
  readonly reason: string;
} {
  return { status: decisions.status, reason: decisions.reason };
}
