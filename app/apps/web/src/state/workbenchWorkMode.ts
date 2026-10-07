import {
  WS_METHODS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
  type WorkbenchWorkModeKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
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
 * Explicit session work mode (Dokkabi R8-06j2), through the authenticated
 * per-environment query/command seams.
 *
 * - The read cache key carries the thread AND the actual provider instance
 *   (and the environment), so a different thread, instance or environment
 *   never observes another scope's mode and a late old-scope response can
 *   never overwrite a newer scope's view. Only the threadId travels the
 *   wire — the server derives the binding from the recorded session and
 *   credentials stay server-side.
 * - The shared bounded timer keeps the host's ACTUAL configuration current
 *   in the active window. Inactive windows pause reads; activation forces
 *   validation and the final unmounted subscriber stops demand immediately. The renderer never opens its own gateway connection and
 *   never triggers writer effects from a poll.
 * - The command is the ONLY mutation seam, dispatched exclusively from an
 *   explicit operator click with a stable per-attempt command id and the
 *   displayed revision. A status is read-only reconciliation for the SAME
 *   command id; mounting, reconnecting and polling never send a selection.
 */
export const WORKBENCH_WORK_MODE_REFRESH_INTERVAL_MS = PRESENTATION_REFRESH_INTERVAL_MS;

const workbenchWorkModeRead = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-work-mode",
  // providerInstanceKey is a client-only cache-key input; it is never sent.
  execute: (input: { readonly threadId: ThreadId; readonly providerInstanceKey: string }) =>
    presentationRead(
      request(WS_METHODS.providerGetWorkbenchWorkMode, {
        threadId: input.threadId,
      }),
    ),
  staleTimeMs: 5_000,
  refreshTrigger: () => presentationActivityAtom,
  idleTtlMs: 0,
});

const workbenchWorkModePresentation = Atom.family(
  (atom: ReturnType<typeof workbenchWorkModeRead>) => retainPresentationFreshness(atom),
);
export const workbenchWorkModeQuery = (target: Parameters<typeof workbenchWorkModeRead>[0]) =>
  workbenchWorkModePresentation(workbenchWorkModeRead(target));

export type WorkbenchWorkModeQueryAtom = ReturnType<typeof workbenchWorkModeQuery>;

export interface WorkbenchWorkModeScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's actual provider instance, when known; keys the cache. */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

/**
 * Deterministic client-only scope key: a JSON tuple of environment + thread +
 * provider-instance (or null). Same thread on another environment or another
 * instance is a DIFFERENT scope — its retained view can never carry another
 * scope's mode, and a late old-scope response cannot overwrite the new
 * scope's view.
 */
export function workbenchWorkModeScopeKey(scope: WorkbenchWorkModeScope): string {
  return JSON.stringify([
    scope.environmentId,
    scope.threadId,
    scope.providerInstanceId === undefined || scope.providerInstanceId === null
      ? null
      : String(scope.providerInstanceId),
  ]);
}

/** The keyed atom for one scope (stable per environment+thread+instance). */
export function workbenchWorkModeAtomFor(
  scope: WorkbenchWorkModeScope,
): WorkbenchWorkModeQueryAtom {
  return workbenchWorkModeQuery({
    environmentId: scope.environmentId,
    input: {
      threadId: scope.threadId,
      providerInstanceKey: workbenchWorkModeScopeKey(scope),
    },
  });
}

/** One explicit work-mode action: a set (operator click only) or a read-only
 * same-id status reconciliation. Only the thread id, command id, displayed
 * revision and closed mode travel the wire — no paths, tokens or policy. */
export type WorkbenchWorkModeActionInput =
  | {
      readonly type: "set";
      readonly threadId: ThreadId;
      readonly commandId: string;
      readonly expectedRevision: string;
      readonly mode: WorkbenchWorkModeKind;
    }
  | {
      readonly type: "status";
      readonly threadId: ThreadId;
      readonly commandId: string;
    };

export const workbenchWorkModeAction = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:commands:provider:workbench-work-mode",
  execute: (input: WorkbenchWorkModeActionInput) =>
    Effect.gen(function* () {
      switch (input.type) {
        case "set":
          return yield* request(WS_METHODS.providerSetWorkbenchWorkMode, {
            threadId: input.threadId,
            commandId: input.commandId,
            expectedRevision: input.expectedRevision,
            mode: input.mode,
          });
        case "status":
          return yield* request(WS_METHODS.providerWorkbenchWorkModeStatus, {
            threadId: input.threadId,
            commandId: input.commandId,
          });
      }
    }),
});
