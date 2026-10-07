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
  presentationRead,
  retainPresentationFreshness,
} from "./presentationActivity";

/**
 * Read-only recorded workbench graph (Dokkabi R4), through the
 * authenticated per-environment client and the keyed query lifecycle.
 *
 * - The cache key carries the thread, the graph type AND the actual
 *   provider instance (and the environment), so a different thread, graph
 *   type, instance or environment never observes another scope's graph and
 *   a late old-scope response can never overwrite a newer scope's view.
 *   Only the threadId and the closed graphType travel the wire — the shared
 *   RPC stays thread-scoped; credentials stay server-side.
 * - A shared bounded timer keeps the active graph current. Inactive windows
 *   pause reads; the final unmounted subscriber stops demand immediately. The renderer
 *   never opens its own gateway connection and never triggers writer
 *   effects.
 */
export const WORKBENCH_GRAPH_REFRESH_INTERVAL_MS = PRESENTATION_REFRESH_INTERVAL_MS;

const workbenchGraphRead = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-graph",
  // providerInstanceKey is a client-only cache-key input; it is never sent.
  execute: (input: {
    readonly threadId: ThreadId;
    readonly graphType: "work" | "context";
    readonly providerInstanceKey: string;
  }) =>
    presentationRead(
      request(WS_METHODS.providerGetWorkbenchGraph, {
        threadId: input.threadId,
        graphType: input.graphType,
      }),
    ),
  staleTimeMs: 5_000,
  refreshTrigger: () => presentationActivityAtom,
  idleTtlMs: 0,
});

const workbenchGraphPresentation = Atom.family((atom: ReturnType<typeof workbenchGraphRead>) =>
  retainPresentationFreshness(atom),
);
export const workbenchGraphQuery = (target: Parameters<typeof workbenchGraphRead>[0]) =>
  workbenchGraphPresentation(workbenchGraphRead(target));

export type WorkbenchGraphQueryAtom = ReturnType<typeof workbenchGraphQuery>;

export interface WorkbenchGraphScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly graphType: "work" | "context";
  /** The thread's actual provider instance, when known; keys the cache. */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

/**
 * Deterministic client-only retention scope key: a JSON tuple of
 * environment + thread + graph type + provider-instance (or null). Same
 * thread on another environment, another instance or the other graph type
 * is a DIFFERENT scope — its retained view can never carry another scope's
 * data, and a late old-scope response cannot overwrite the new scope's
 * view.
 */
export function workbenchGraphScopeKey(scope: WorkbenchGraphScope): string {
  return JSON.stringify([
    scope.environmentId,
    scope.threadId,
    scope.graphType,
    scope.providerInstanceId === undefined || scope.providerInstanceId === null
      ? null
      : String(scope.providerInstanceId),
  ]);
}

/** The keyed atom for one scope (stable per environment+thread+type+instance). */
export function workbenchGraphAtomFor(scope: WorkbenchGraphScope): WorkbenchGraphQueryAtom {
  return workbenchGraphQuery({
    environmentId: scope.environmentId,
    input: {
      threadId: scope.threadId,
      graphType: scope.graphType,
      providerInstanceKey: workbenchGraphScopeKey(scope),
    },
  });
}
