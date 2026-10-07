/**
 * Pure view-model of the bounded record explorer (metadata index pages, the
 * selected row's byte window and its explicit verification).
 *
 * - The index carries metadata only. Pages are contiguous, chained through
 *   prev_hash, end honestly at the pin and never exceed it; a page failing
 *   these checks never renders or replaces retention.
 * - Selecting a row (or paging) freezes the displayed prefix as the pin, so
 *   its byte windows and proof stay bound to one immutable asOf.
 * - Range navigation is resolved by the owner against the selected
 *   descriptor and the displayed window; actions carry no row or source.
 * - A verification request is bound to row + pin + descriptor; any change of
 *   selection, pin, page or scope drops it.
 */
import type {
  ProviderWorkbenchRecordIndex,
  ProviderWorkbenchRecordIndexResult,
  RecordCompanionBodyWindow,
  RecordCompanionVerification,
  RecordCompanionViewAction,
  RecordCompanionViewPreferences,
  WorkbenchRecordAsOf,
  WorkbenchRecordBodyExpected,
  WorkbenchRecordCursor,
  WorkbenchRecordDescriptor,
} from "@t3tools/contracts";

import type { EnvironmentQueryView } from "~/state/query";
import {
  clampRecordBodyStart,
  lastRecordBodyStart,
  nextRecordBodyStart,
  previousRecordBodyStart,
  recordCursorIdentityError,
  recordVerificationRefusal,
  type RecordBodyWindowReadResult,
} from "./recordBodyWindow";
import { recordHeadContinuityError } from "../chat/DecisionRecordSurface.logic";

export const RECORD_INDEX_PAGE_LIMIT = 50;

export type RecordExplorerIndexState =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "index";
      readonly index: ProviderWorkbenchRecordIndex;
      readonly staleError: string | null;
    };

/**
 * The latest retained metadata page. `scopeKey` names the source and page
 * position (environment + thread + instance + exact after cursor + limit);
 * `pinned` records whether it was read under an explicit pin.
 */
export interface RetainedRecordIndex {
  readonly scopeKey: string;
  readonly pinned: boolean;
  readonly index: ProviderWorkbenchRecordIndex;
}

/** Deterministic page-position key: source + exact after cursor + limit. */
export function recordIndexScopeKey(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId?: string | null | undefined;
  readonly after?: WorkbenchRecordCursor | null | undefined;
  readonly limit: number;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.providerInstanceId ?? null,
    input.after ? [input.after.seq, input.after.hash, input.after.generation] : null,
    input.limit,
  ]);
}

const sameAsOfValue = (left: WorkbenchRecordAsOf, right: WorkbenchRecordAsOf): boolean =>
  left.sessionId === right.sessionId &&
  left.seq === right.seq &&
  left.hash === right.hash &&
  left.generation === right.generation;

/**
 * Retention applies only to the same source and page position, and only to
 * the same prefix: a live page serves a live view, and a pinned view reuses a
 * page only when that page was read at exactly the pinned asOf (pinning the
 * displayed page). Another scope never inherits anything.
 */
export function retainedIndexFor(
  retained: RetainedRecordIndex | null,
  scopeKey: string,
  asOf: WorkbenchRecordAsOf | undefined,
): RetainedRecordIndex | null {
  if (retained === null || retained.scopeKey !== scopeKey) return null;
  if (asOf === undefined) return retained.pinned ? null : retained;
  return sameAsOfValue(retained.index.asOf, asOf) ? retained : null;
}

/** Exact metadata page integrity; null when exact. */
export function recordIndexIntegrityError(input: {
  readonly index: ProviderWorkbenchRecordIndex;
  readonly after?: WorkbenchRecordCursor | undefined;
  readonly asOf?: WorkbenchRecordAsOf | undefined;
  readonly limit: number;
}): string | null {
  const { index } = input;
  const asOf = index.asOf;
  for (const cursor of [asOf, index.sessionCursor, index.gatewayCursor, input.after, index.next]) {
    if (cursor === undefined || cursor === null) continue;
    const identityError = recordCursorIdentityError(cursor);
    if (identityError !== null) return identityError;
  }
  if (input.after !== undefined && input.after.generation !== asOf.generation) {
    return "The after cursor names a different source generation than the pin.";
  }
  if (index.next !== null && index.next.generation !== asOf.generation) {
    return "The next cursor names a different source generation than the pin.";
  }
  if (input.asOf !== undefined) {
    if (
      asOf.sessionId !== input.asOf.sessionId ||
      asOf.seq !== input.asOf.seq ||
      asOf.hash !== input.asOf.hash ||
      asOf.generation !== input.asOf.generation
    ) {
      return "The index answers a different pinned prefix than the requested one.";
    }
  }
  if (
    index.sessionCursor.sessionId !== asOf.sessionId ||
    index.sessionCursor.generation !== asOf.generation ||
    index.sessionCursor.seq < asOf.seq
  ) {
    return "The index's session head does not extend its pinned prefix.";
  }
  if (index.sessionCursor.seq === asOf.seq && index.sessionCursor.hash !== asOf.hash) {
    return "The index's session head at the pinned seq carries a different hash than the pin.";
  }
  if (index.entries.length > input.limit) {
    return `The index carries ${index.entries.length} entries beyond the requested ${input.limit}.`;
  }
  let previous: WorkbenchRecordDescriptor | undefined;
  for (const entry of index.entries) {
    if (previous !== undefined) {
      if (entry.seq !== previous.seq + 1 || entry.prev_hash !== previous.hash) {
        return `The index is not a contiguous chain at seq ${entry.seq}.`;
      }
    } else if (input.after !== undefined) {
      if (entry.seq !== input.after.seq + 1 || entry.prev_hash !== input.after.hash) {
        return `The index does not begin exactly after the requested cursor (seq ${input.after.seq}).`;
      }
    } else if (entry.seq !== 1) {
      return "An index page without an after cursor must begin at the log's first row.";
    }
    if (entry.seq > asOf.seq) {
      return `The entry at seq ${entry.seq} lies beyond the pinned prefix (${asOf.seq}).`;
    }
    if (entry.seq === 1 && entry.hash !== asOf.generation) {
      return "The first row's hash is not the source generation.";
    }
    if (entry.seq === 1 && entry.prev_hash !== "0".repeat(64)) {
      return "The first row's predecessor must be genesis.";
    }
    if (entry.seq === asOf.seq && entry.hash !== asOf.hash) {
      return "The entry at the pinned seq carries a different hash than the pin.";
    }
    previous = entry;
  }
  const last = index.entries.at(-1);
  if (index.hasMore) {
    if (last === undefined || index.next === null) {
      return "The index claims more entries without a next cursor.";
    }
    if (index.next.seq !== last.seq || index.next.hash !== last.hash) {
      return "The next cursor must be the last included entry when more remain.";
    }
    if (last.seq >= asOf.seq) return "The index claims more entries at or beyond its pin.";
  } else {
    if (index.next !== null) return "A complete index page must not carry a next cursor.";
    const end = last?.seq ?? input.after?.seq ?? 0;
    if (end !== asOf.seq) {
      return `A complete index page must end at the pinned prefix (seq ${asOf.seq}); it ended at ${end}.`;
    }
  }
  if (index.total !== asOf.seq) {
    return `The index total (${index.total}) is not the pinned prefix's own seq (${asOf.seq}).`;
  }
  return null;
}

/** Resolve the metadata page from its keyed query and same-scope retention. */
export function resolveRecordExplorerIndex(input: {
  readonly scopeKey: string;
  readonly query: Pick<
    EnvironmentQueryView<ProviderWorkbenchRecordIndexResult>,
    "data" | "error" | "isPending"
  >;
  readonly retained: RetainedRecordIndex | null;
  readonly subscribed: boolean;
  readonly after?: WorkbenchRecordCursor | undefined;
  readonly asOf?: WorkbenchRecordAsOf | undefined;
  readonly limit: number;
}): RecordExplorerIndexState {
  const retained = retainedIndexFor(input.retained, input.scopeKey, input.asOf);
  if (!input.subscribed) {
    return retained !== null
      ? { kind: "index", index: retained.index, staleError: null }
      : { kind: "pending" };
  }
  const fresh = input.query.data?.status === "available" ? (input.query.data.index ?? null) : null;
  const integrity =
    fresh === null
      ? null
      : recordIndexIntegrityError({
          index: fresh,
          after: input.after,
          asOf: input.asOf,
          limit: input.limit,
        });
  if (input.query.error !== null) {
    const stale = retained?.index ?? (integrity === null ? fresh : null);
    return stale !== null
      ? { kind: "index", index: stale, staleError: input.query.error }
      : { kind: "unavailable", reason: integrity ?? input.query.error };
  }
  const result = input.query.data;
  if (result === null) {
    if (retained !== null) return { kind: "index", index: retained.index, staleError: null };
    return input.query.isPending ? { kind: "pending" } : { kind: "unavailable", reason: "" };
  }
  if (result.status === "unsupported") {
    return {
      kind: "unsupported",
      reason:
        result.reason ??
        "This gateway does not offer the bounded record index; retained records are unsupported here.",
    };
  }
  if (result.status === "unavailable") {
    return {
      kind: "unavailable",
      reason: result.reason ?? "The retained records are not available right now.",
    };
  }
  if (fresh === null) {
    return {
      kind: "unavailable",
      reason: "The source reported an available index without a payload; refusing to render it.",
    };
  }
  if (integrity !== null) {
    return retained !== null
      ? { kind: "index", index: retained.index, staleError: integrity }
      : { kind: "unavailable", reason: integrity };
  }
  if (retained !== null) {
    const continuity = recordHeadContinuityError(retained.index, fresh);
    if (continuity !== null) {
      return { kind: "index", index: retained.index, staleError: continuity };
    }
  }
  return { kind: "index", index: fresh, staleError: null };
}

/** The selected descriptor, only when it is on the displayed page. */
export function selectedRecordDescriptor(
  index: ProviderWorkbenchRecordIndex | null,
  view: RecordCompanionViewPreferences,
): WorkbenchRecordDescriptor | null {
  if (index === null || view.selectedSeq === null) return null;
  return index.entries.find((entry) => entry.seq === view.selectedSeq) ?? null;
}

/** The exact row/pin/descriptor binding of the selected row, when pinned. */
export interface RecordSelectionBinding {
  readonly row: WorkbenchRecordCursor;
  readonly asOf: WorkbenchRecordAsOf;
  readonly expected: WorkbenchRecordBodyExpected;
}

export function recordSelectionBinding(
  index: ProviderWorkbenchRecordIndex | null,
  view: RecordCompanionViewPreferences,
): RecordSelectionBinding | null {
  const descriptor = selectedRecordDescriptor(index, view);
  if (descriptor === null || index === null) return null;
  // Explorer selection always pins; a restored older view that selected a
  // row without a pin binds to the displayed page's own prefix.
  const asOf = view.pin ?? index.asOf;
  if (descriptor.seq > asOf.seq) return null;
  return {
    row: { seq: descriptor.seq, hash: descriptor.hash, generation: asOf.generation },
    asOf,
    expected: { byteLength: descriptor.byteLength, bodyDigest: descriptor.bodyDigest },
  };
}

export function sameSelectionBinding(
  left: RecordSelectionBinding | null,
  right: RecordSelectionBinding | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.row.seq === right.row.seq &&
    left.row.hash === right.row.hash &&
    left.row.generation === right.row.generation &&
    left.asOf.sessionId === right.asOf.sessionId &&
    left.asOf.seq === right.asOf.seq &&
    left.asOf.hash === right.asOf.hash &&
    left.asOf.generation === right.asOf.generation &&
    left.expected.byteLength === right.expected.byteLength &&
    left.expected.bodyDigest === right.expected.bodyDigest
  );
}

/** Map the window read onto the closed window state for the requested start. */
export function resolveRecordBodyWindowState(input: {
  readonly binding: RecordSelectionBinding | null;
  readonly start: number;
  readonly query: Pick<
    EnvironmentQueryView<RecordBodyWindowReadResult>,
    "data" | "error" | "isPending"
  >;
}): RecordCompanionBodyWindow {
  if (input.binding === null) return { status: "none" };
  if (input.query.error !== null) return { status: "failed", reason: input.query.error };
  const data = input.query.data;
  if (data === null) return { status: "pending", requestedStart: input.start };
  if (data.status !== "available") return { status: data.status, reason: data.reason };
  const window = data.window;
  const binding = input.binding;
  if (
    window.requestedStart !== input.start ||
    window.row.seq !== binding.row.seq ||
    window.row.hash !== binding.row.hash ||
    window.totalBytes !== binding.expected.byteLength
  ) {
    return { status: "pending", requestedStart: input.start };
  }
  return window;
}

/** One explicit proof request, bound to its selection. */
export interface RecordVerificationIntent extends RecordSelectionBinding {
  readonly nonce: number;
}

/** The selected row's verification state (refusal precedes any request). */
export function resolveRecordVerificationState(input: {
  readonly binding: RecordSelectionBinding | null;
  readonly intent: RecordVerificationIntent | null;
  readonly query: Pick<
    EnvironmentQueryView<RecordCompanionVerification>,
    "data" | "error" | "isPending"
  >;
}): RecordCompanionVerification {
  const { binding, intent } = input;
  if (binding === null) return { status: "idle" };
  const refusal = recordVerificationRefusal(binding.expected);
  if (refusal !== null) return { status: "refused", row: binding.row, reason: refusal };
  if (intent === null || !sameSelectionBinding(intent, binding)) return { status: "idle" };
  if (input.query.error !== null) {
    return { status: "failed", row: binding.row, reason: input.query.error };
  }
  if (input.query.data === null) {
    return { status: "pending", row: binding.row, asOf: binding.asOf, expected: binding.expected };
  }
  return input.query.data;
}

/** True for the explicit proof intents (not view-preference changes). */
export function isVerificationAction(action: RecordCompanionViewAction): boolean {
  return action.type === "verify" || action.type === "cancelVerify";
}

const sameCursorOrNull = (
  left: WorkbenchRecordCursor | null,
  right: WorkbenchRecordCursor | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.seq === right.seq && left.hash === right.hash && left.generation === right.generation;

/**
 * Apply one closed action to the explorer view against the displayed page,
 * the selected descriptor and the displayed window. Null = not applicable.
 * Verification intents are not view changes and return null here.
 */
export function applyRecordExplorerViewAction(input: {
  readonly view: RecordCompanionViewPreferences;
  readonly action: RecordCompanionViewAction;
  readonly index: ProviderWorkbenchRecordIndex | null;
  readonly window: RecordCompanionBodyWindow | null;
}): RecordCompanionViewPreferences | null {
  const { view, action, index } = input;
  const descriptor = selectedRecordDescriptor(index, view);
  const current = view.bodyStart ?? 0;
  const withBodyStart = (start: number): RecordCompanionViewPreferences | null => {
    if (descriptor === null) return null;
    const clamped = clampRecordBodyStart(start, descriptor.byteLength);
    return clamped === current ? null : { ...view, bodyStart: clamped };
  };
  const shownWindow =
    input.window !== null &&
    input.window.status === "window" &&
    descriptor !== null &&
    input.window.row.seq === descriptor.seq
      ? input.window
      : null;
  const clearedSelection = (
    next: RecordCompanionViewPreferences,
  ): RecordCompanionViewPreferences => {
    const { bodyStart: _dropped, ...rest } = next;
    return { ...rest, selectedSeq: null };
  };
  switch (action.type) {
    case "first":
      return view.after === null && view.selectedSeq === null
        ? null
        : clearedSelection({ ...view, after: null });
    case "next":
      if (index === null || !index.hasMore || index.next === null) return null;
      if (sameCursorOrNull(view.after, index.next)) return null;
      return clearedSelection({ ...view, after: index.next, pin: view.pin ?? index.asOf });
    case "pin":
      if (index === null) return null;
      if (view.pin !== null) return clearedSelection({ ...view, pin: null, after: null });
      return { ...view, pin: index.asOf };
    case "follow":
      if (view.pin === null) return null;
      return clearedSelection({ ...view, pin: null, after: null });
    case "select": {
      if (index === null) return null;
      if (!index.entries.some((entry) => entry.seq === action.seq)) return null;
      if (view.selectedSeq === action.seq) return null;
      const { bodyStart: _dropped, ...rest } = view;
      return { ...rest, selectedSeq: action.seq, pin: view.pin ?? index.asOf };
    }
    case "tab":
      return view.tab === action.tab ? null : { ...view, tab: action.tab };
    case "bodyFirst":
      return withBodyStart(0);
    case "bodyNext": {
      if (shownWindow === null) return null;
      const next = nextRecordBodyStart(shownWindow);
      return next === null ? null : withBodyStart(next);
    }
    case "bodyPrevious": {
      if (shownWindow === null) return null;
      const previous = previousRecordBodyStart(shownWindow);
      return previous === null ? null : withBodyStart(previous);
    }
    case "bodyLast":
      return descriptor === null ? null : withBodyStart(lastRecordBodyStart(descriptor.byteLength));
    case "bodyJump":
      if (descriptor === null || action.offset >= descriptor.byteLength) return null;
      return withBodyStart(action.offset);
    case "verify":
    case "cancelVerify":
      return null;
  }
}

/** Short exact digest chip. */
export function digestChip(digest: string): string {
  return digest.slice(0, 12);
}
