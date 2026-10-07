import {
  WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type ProviderInstanceId,
  type CodeSessionCursor,
  type CodeSelection,
  type ProviderWorkbenchCodeResult,
  type ProviderWorkbenchCodeActionInput,
} from "@t3tools/contracts";
import {
  createEnvironmentSubscriptionAtomFamily,
  createEnvironmentQueryAtomFamily,
  createEnvironmentCommand,
} from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { connectionAtomRuntime } from "../connection/runtime";

export interface CodeScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}
export const codeScopeKey = (scope: CodeScope): string =>
  JSON.stringify([scope.environmentId, scope.threadId, scope.providerInstanceId ?? null]);

/** Sequential demand: acknowledge only a consumed page. There is no push
 * queue, periodic body scan or background observer. Interruption cancels RPC. */
export function codeIndexFeed<E, R>(
  read: (after?: CodeSessionCursor) => Effect.Effect<ProviderWorkbenchCodeResult, E, R>,
) {
  return Stream.unfold<
    { after?: CodeSessionCursor; done: boolean },
    ProviderWorkbenchCodeResult,
    E,
    R
  >({ done: false }, (state) =>
    Effect.gen(function* () {
      if (state.done) return undefined;
      if (state.after) yield* Effect.sleep("250 millis");
      const result = yield* read(state.after);
      return [
        result,
        result.status === "available"
          ? { after: result.code.sessionCursor, done: false }
          : { done: true },
      ] as const;
    }),
  );
}
const index = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-code-index",
  // Zero TTL disposes the active stream immediately when its last visible
  // subscriber leaves; a retained UI picture is separate from a live reader.
  idleTtlMs: 0,
  subscribe: (input: { threadId: ThreadId; scopeKey: string }) =>
    codeIndexFeed((after) =>
      after
        ? request(WS_METHODS.providerSubscribeWorkbenchCode, { threadId: input.threadId, after })
        : request(WS_METHODS.providerGetWorkbenchCode, { threadId: input.threadId }),
    ),
});
const body = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider:workbench-code-body",
  idleTtlMs: 0,
  staleTimeMs: 0,
  execute: (input: { threadId: ThreadId; selection: CodeSelection; scopeKey: string }) =>
    request(WS_METHODS.providerGetWorkbenchCode, {
      threadId: input.threadId,
      selection: input.selection,
    }),
});
export const workbenchCodeIndexAtomFor = (scope: CodeScope) =>
  index({
    environmentId: scope.environmentId,
    input: { threadId: scope.threadId, scopeKey: codeScopeKey(scope) },
  });
export const workbenchCodeBodyAtomFor = (scope: CodeScope, selection: CodeSelection) =>
  body({
    environmentId: scope.environmentId,
    input: { threadId: scope.threadId, scopeKey: codeScopeKey(scope), selection },
  });

/** Explicit operator action only. Scope identity remains client-side; the
 * server derives the authenticated binding from the thread. */
export const workbenchCodeAction = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:commands:provider:workbench-code-action",
  execute: (input: ProviderWorkbenchCodeActionInput) =>
    request(WS_METHODS.providerWorkbenchCodeAction, input),
});
