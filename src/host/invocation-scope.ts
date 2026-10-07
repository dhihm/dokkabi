import { AsyncLocalStorage } from "node:async_hooks";
import type { EventRecord } from "./schema.ts";

/**
 * #227 CG-02: which rows one tool invocation appended, by host identity and
 * never by time order.
 *
 * Pi runs a batch's tool calls in parallel, so a row that lands between one
 * call's `tool/start` and another's `tool/end` cannot be attributed by its
 * position in the log. The loop runs each tool's `execute` inside its own
 * async scope; every row the host appends to that log while the scope is
 * current — an `exec/receipt`, a `ledger/check`, a `work/ledger_case` — is
 * noted against the invocation id, and the loop names those rows on the
 * call's `tool/end` (`observed_rows`). A row appended outside any scope (a
 * timer created before the call, another call's scope) is never noted here.
 *
 * Bounded: an invocation that appends more than OBSERVED_ROWS_MAX rows keeps
 * the first ones and counts the rest, so the link row says it is partial.
 */
export const OBSERVED_ROWS_MAX = 64;

export interface ObservedRow {
  readonly seq: number;
  readonly hash: string;
  readonly name: string;
}

interface InvocationScope {
  readonly log: object;
  readonly id: string;
  readonly rows: ObservedRow[];
  dropped: number;
}

const scope = new AsyncLocalStorage<InvocationScope>();

/** Run `fn` as invocation `id` of `log`; the rows it appends are collected. */
export function runInInvocation<T>(log: object, id: string, fn: () => T): { readonly result: T; readonly scope: InvocationScope } {
  const current: InvocationScope = { log, id, rows: [], dropped: 0 };
  const result = scope.run(current, fn);
  return { result, scope: current };
}

/** Called by EventLog after a batch is durable (writer handles only). */
export function noteAppendedRows(log: object, records: readonly EventRecord[]): void {
  const current = scope.getStore();
  if (current === undefined || current.log !== log) return;
  for (const record of records) {
    if (current.rows.length < OBSERVED_ROWS_MAX) current.rows.push({ seq: record.seq, hash: record.hash, name: record.name });
    else current.dropped += 1;
  }
}

/** The observed rows as a `tool/end` field, or undefined when there are none. */
export function observedRowsField(rows: readonly ObservedRow[], dropped: number): Record<string, unknown> {
  if (rows.length === 0 && dropped === 0) return {};
  return {
    observed_rows: rows.map((row) => ({ seq: row.seq, hash: row.hash, name: row.name })),
    ...(dropped > 0 ? { observed_rows_dropped: dropped } : {}),
  };
}
