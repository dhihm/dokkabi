import {
  WS_METHODS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";

import { connectionAtomRuntime } from "../connection/runtime";
import { Atom } from "effect/unstable/reactivity";
import {
  PRESENTATION_REFRESH_INTERVAL_MS,
  presentationActivityAtom,
  presentationActiveAtom,
  presentationRead,
  retainPresentationFreshness,
} from "./presentationActivity";

/**
 * Read-only recorded workbench overview (Dokkabi R3), through the
 * authenticated per-environment client and the keyed query lifecycle.
 *
 * - The cache key carries the thread AND the actual provider instance (and
 *   the environment), so a different thread/instance/environment never
 *   observes another scope's overview and a late old-scope response can
 *   never overwrite a newer scope's view. Only the threadId travels the
 *   wire — the shared RPC stays threadId-only.
 * - A shared bounded timer keeps the active window current; inactive
 *   presentation reads pause and activation forces validation. The renderer never opens its own gateway
 *   connection and never triggers writer effects.
 */
export const WORKBENCH_OVERVIEW_REFRESH_INTERVAL_MS = PRESENTATION_REFRESH_INTERVAL_MS;

const workbenchOverviewRead = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-overview",
  // providerInstanceKey is a client-only cache-key input; it is never sent.
  execute: (input: { readonly threadId: ThreadId; readonly providerInstanceKey: string }) =>
    presentationRead(
      request(WS_METHODS.providerGetWorkbenchOverview, { threadId: input.threadId }),
    ),
  staleTimeMs: 5_000,
  refreshTrigger: () => presentationActivityAtom,
  idleTtlMs: 0,
});

const workbenchOverviewPresentation = Atom.family(
  (atom: ReturnType<typeof workbenchOverviewRead>) => retainPresentationFreshness(atom),
);
export const workbenchOverviewQuery = (target: Parameters<typeof workbenchOverviewRead>[0]) =>
  workbenchOverviewPresentation(workbenchOverviewRead(target));

export type WorkbenchOverviewQueryAtom = ReturnType<typeof workbenchOverviewQuery>;

export interface WorkbenchOverviewScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's actual provider instance, when known; keys the cache. */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

/**
 * Deterministic client-only retention scope key: a JSON tuple of
 * environment + thread + provider-instance (or null). Same thread/instance
 * moving to another environment is a DIFFERENT scope — its retained view can
 * never carry the old environment's data, and a late old-scope response
 * cannot overwrite the new scope's view.
 */
export function workbenchOverviewScopeKey(scope: WorkbenchOverviewScope): string {
  return JSON.stringify([
    scope.environmentId,
    scope.threadId,
    scope.providerInstanceId === undefined || scope.providerInstanceId === null
      ? null
      : String(scope.providerInstanceId),
  ]);
}

/** The keyed atom for one scope (stable per environment+thread+instance). */
export function workbenchOverviewAtomFor(
  scope: WorkbenchOverviewScope,
): WorkbenchOverviewQueryAtom {
  return workbenchOverviewQuery({
    environmentId: scope.environmentId,
    input: {
      threadId: scope.threadId,
      providerInstanceKey: workbenchOverviewScopeKey(scope),
    },
  });
}

// --- Scoped run usage (Dokkabi R8) ---
//
// The on-demand TOTAL run usage read (main prefix plus every referenced
// child session) rides the SAME provider.getWorkbenchOverview RPC with the
// optional includeChildUsage flag — a separate keyed query so it can never
// perturb the periodic main-only overview above. It has NO refresh interval
// and performs NO periodic scanning: the query only runs while the usage
// dialog is open (its body is the sole subscriber) and on an explicit
// Refresh or foreground activation/reconnection; staleTime 0 makes every dialog
// open a fresh read. Inactive reconnects pause without a periodic scan.

/**
 * The fixed options of the scoped usage query. Exported so tests can pin
 * the no-periodic-read contract: there is no refreshIntervalMs, and every
 * mount revalidates (staleTimeMs 0) so opening the dialog always reads.
 */
export const WORKBENCH_SCOPED_USAGE_QUERY_OPTIONS = {
  staleTimeMs: 0,
  idleTtlMs: 0,
} as const;

const workbenchScopedUsageRead = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-scoped-usage",
  // providerInstanceKey is a client-only cache-key input; it is never sent.
  execute: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceKey: string;
    readonly includeChildUsage: boolean;
  }) =>
    presentationRead(
      request(WS_METHODS.providerGetWorkbenchOverview, {
        threadId: input.threadId,
        ...(input.includeChildUsage ? { includeChildUsage: true } : {}),
      }),
    ),
  // Boolean activation changes invalidate; the shared five-second revision
  // never triggers this on-demand child-session scan.
  refreshTrigger: () => presentationActiveAtom,
  ...WORKBENCH_SCOPED_USAGE_QUERY_OPTIONS,
});
const workbenchScopedUsagePresentation = Atom.family(
  (atom: ReturnType<typeof workbenchScopedUsageRead>) => retainPresentationFreshness(atom),
);
export const workbenchScopedUsageQuery = (target: Parameters<typeof workbenchScopedUsageRead>[0]) =>
  workbenchScopedUsagePresentation(workbenchScopedUsageRead(target));

export type WorkbenchScopedUsageQueryAtom = ReturnType<typeof workbenchScopedUsageQuery>;

export interface WorkbenchScopedUsageScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's actual provider instance, when known; keys the cache. */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

/**
 * Deterministic client-only scope key for the scoped usage read: the same
 * environment+thread+instance tuple as the overview, PLUS the
 * includeChildUsage flag — a main-only view can never be observed under
 * the scoped key and a late old-scope response cannot overwrite a newer
 * scope's view.
 */
export function workbenchScopedUsageScopeKey(scope: WorkbenchScopedUsageScope): string {
  return JSON.stringify([
    scope.environmentId,
    scope.threadId,
    scope.providerInstanceId === undefined || scope.providerInstanceId === null
      ? null
      : String(scope.providerInstanceId),
    "includeChildUsage",
  ]);
}

/** The keyed atom for one scope's on-demand scoped usage read. */
export function workbenchScopedUsageAtomFor(
  scope: WorkbenchScopedUsageScope,
): WorkbenchScopedUsageQueryAtom {
  return workbenchScopedUsageQuery({
    environmentId: scope.environmentId,
    input: {
      threadId: scope.threadId,
      providerInstanceKey: workbenchScopedUsageScopeKey(scope),
      includeChildUsage: true,
    },
  });
}
