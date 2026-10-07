import {
  WS_METHODS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderWorkbenchDecisionActionResult,
  type ProviderWorkbenchDecisionDefinition,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
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
 * Read-only recorded workbench decisions (Dokkabi R8), through the
 * authenticated per-environment client and the keyed query lifecycle.
 *
 * - The cache key carries the thread AND the actual provider instance (and
 *   the environment), so a different thread, instance or environment never
 *   observes another scope's decisions and a late old-scope response can
 *   never overwrite a newer scope's view. Only the threadId travels the
 *   wire — the server resolves the recorded parent binding; credentials
 *   stay server-side.
 * - Shared native activity keeps the recorded decisions current while active.
 *   Inactivity pauses reads and marks retained data stale; activation forces
 *   validation and the last subscriber releases demand. The renderer never
 *   opens its own gateway connection and never triggers writer effects.
 */
export const WORKBENCH_DECISIONS_REFRESH_INTERVAL_MS = PRESENTATION_REFRESH_INTERVAL_MS;

const workbenchDecisionsRead = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-decisions",
  // providerInstanceKey is a client-only cache-key input; it is never sent.
  execute: (input: { readonly threadId: ThreadId; readonly providerInstanceKey: string }) =>
    presentationRead(
      request(WS_METHODS.providerGetWorkbenchDecisions, {
        threadId: input.threadId,
      }),
    ),
  staleTimeMs: 5_000,
  refreshTrigger: () => presentationActivityAtom,
  idleTtlMs: 0,
});
const workbenchDecisionsPresentation = Atom.family(
  (atom: ReturnType<typeof workbenchDecisionsRead>) => retainPresentationFreshness(atom),
);
export const workbenchDecisionsQuery = (target: Parameters<typeof workbenchDecisionsRead>[0]) =>
  workbenchDecisionsPresentation(workbenchDecisionsRead(target));

export type WorkbenchDecisionsQueryAtom = ReturnType<typeof workbenchDecisionsQuery>;

export interface WorkbenchDecisionsScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread's actual provider instance, when known; keys the cache. */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

/**
 * Deterministic client-only scope key: a JSON tuple of environment + thread
 * + provider-instance (or null). Same thread on another environment or
 * another instance is a DIFFERENT scope — its retained view can never carry
 * another scope's decisions, and a late old-scope response cannot overwrite
 * the new scope's view.
 */
export function workbenchDecisionsScopeKey(scope: WorkbenchDecisionsScope): string {
  return JSON.stringify([
    scope.environmentId,
    scope.threadId,
    scope.providerInstanceId === undefined || scope.providerInstanceId === null
      ? null
      : String(scope.providerInstanceId),
  ]);
}

/** The keyed atom for one scope (stable per environment+thread+instance). */
export function workbenchDecisionsAtomFor(
  scope: WorkbenchDecisionsScope,
): WorkbenchDecisionsQueryAtom {
  return workbenchDecisionsQuery({
    environmentId: scope.environmentId,
    input: {
      threadId: scope.threadId,
      providerInstanceKey: workbenchDecisionsScopeKey(scope),
    },
  });
}

/** One explicit decision/branch mutation, dispatched through the same
 * authenticated per-environment command seam as thread commands. Only the
 * thread id, decision identity, expected revision, option and the prepared
 * target thread travel the wire — no paths, tokens or policy. */
export type WorkbenchDecisionActionInput =
  | {
      readonly type: "create";
      readonly threadId: ThreadId;
      readonly definition: ProviderWorkbenchDecisionDefinition;
    }
  | {
      readonly type: "select";
      readonly threadId: ThreadId;
      readonly id: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly option: string;
    }
  | {
      readonly type: "start";
      readonly threadId: ThreadId;
      readonly id: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly childThreadId: ThreadId;
    };

export const workbenchDecisionAction = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:commands:provider:workbench-decision",
  execute: (input: WorkbenchDecisionActionInput) =>
    Effect.gen(function* () {
      switch (input.type) {
        case "create":
          return yield* request(WS_METHODS.providerCreateWorkbenchDecision, {
            threadId: input.threadId,
            definition: input.definition,
          });
        case "select":
          return yield* request(WS_METHODS.providerSelectWorkbenchDecision, {
            threadId: input.threadId,
            id: input.id,
            commandId: input.commandId,
            expectedRevision: input.expectedRevision,
            option: input.option,
          });
        case "start":
          return yield* request(WS_METHODS.providerStartWorkbenchBranch, {
            threadId: input.threadId,
            id: input.id,
            commandId: input.commandId,
            expectedRevision: input.expectedRevision,
            childThreadId: input.childThreadId,
          });
      }
    }),
});
