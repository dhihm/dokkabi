import {
  WS_METHODS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
  type WorkbenchRecordAsOf,
  type WorkbenchRecordCursor,
} from "@t3tools/contracts";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import { Atom } from "effect/unstable/reactivity";
import {
  PRESENTATION_REFRESH_INTERVAL_MS,
  presentationActivityAtom,
  presentationRead,
  retainPresentationFreshness,
} from "./presentationActivity";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Read-only exact retained record pages (Dokkabi R5), through the
 * authenticated per-environment client and the keyed query lifecycle.
 *
 * - The cache key carries the thread, the page position (after/asOf/limit)
 *   AND the actual provider instance (and the environment), so a different
 *   thread, page, instance or environment never observes another scope's
 *   page and a late old-scope response can never overwrite a newer scope's
 *   view. Only the threadId and the bounded paging cursors travel the wire
 *   — the shared RPC stays thread-scoped; the renderer never chooses a
 *   session or path; credentials stay server-side.
 * - Shared native activity keeps the requested page current while active.
 *   Inactivity pauses reads and marks retained data stale; activation forces
 *   validation and the last subscriber releases demand. The renderer never opens its own
 *   gateway connection and never triggers writer effects.
 */
export const WORKBENCH_RECORD_REFRESH_INTERVAL_MS = PRESENTATION_REFRESH_INTERVAL_MS;
export const WORKBENCH_RECORD_PAGE_LIMIT = 50;

const workbenchRecordRead = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-record",
  // providerInstanceKey is a client-only cache-key input; it is never sent.
  execute: (input: {
    readonly threadId: ThreadId;
    readonly after?: WorkbenchRecordCursor | undefined;
    readonly asOf?: WorkbenchRecordAsOf | undefined;
    readonly limit: number;
    readonly providerInstanceKey: string;
  }) =>
    presentationRead(
      request(WS_METHODS.providerGetWorkbenchRecord, {
        threadId: input.threadId,
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
        limit: input.limit,
      }),
    ),
  staleTimeMs: 5_000,
  refreshTrigger: () => presentationActivityAtom,
  idleTtlMs: 0,
});
const workbenchRecordPresentation = Atom.family((atom: ReturnType<typeof workbenchRecordRead>) =>
  retainPresentationFreshness(atom),
);
export const workbenchRecordQuery = (target: Parameters<typeof workbenchRecordRead>[0]) =>
  workbenchRecordPresentation(workbenchRecordRead(target));

export type WorkbenchRecordQueryAtom = ReturnType<typeof workbenchRecordQuery>;

export interface WorkbenchRecordScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  /** The page position: the follow/live first page or an exact pinned window. */
  readonly after?: WorkbenchRecordCursor | undefined;
  readonly asOf?: WorkbenchRecordAsOf | undefined;
  readonly limit: number;
}

/**
 * Deterministic client-only retention scope key: a JSON tuple of
 * environment + thread + instance + page position, where the page position
 * carries the FULL exact cursor identity (seq AND hash AND generation, plus
 * the pin's session) — an ordinal alone never aliases a view. Same thread
 * on another environment, another instance or another page is a DIFFERENT
 * scope — its retained view can never carry another scope's rows, and a
 * late old-scope response cannot overwrite the new scope's view.
 */
export function workbenchRecordScopeKey(scope: WorkbenchRecordScope): string {
  return JSON.stringify([
    scope.environmentId,
    scope.threadId,
    scope.providerInstanceId === undefined || scope.providerInstanceId === null
      ? null
      : String(scope.providerInstanceId),
    scope.after === undefined ? null : [scope.after.seq, scope.after.hash, scope.after.generation],
    scope.asOf === undefined
      ? null
      : [scope.asOf.sessionId, scope.asOf.seq, scope.asOf.hash, scope.asOf.generation],
    scope.limit,
  ]);
}

/** The keyed atom for one scope (stable per environment+thread+instance+page). */
export function workbenchRecordAtomFor(scope: WorkbenchRecordScope): WorkbenchRecordQueryAtom {
  return workbenchRecordQuery({
    environmentId: scope.environmentId,
    input: {
      threadId: scope.threadId,
      ...(scope.after !== undefined ? { after: scope.after } : {}),
      ...(scope.asOf !== undefined ? { asOf: scope.asOf } : {}),
      limit: scope.limit,
      providerInstanceKey: workbenchRecordScopeKey(scope),
    },
  });
}
