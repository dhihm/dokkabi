import { WS_METHODS, type ThreadId } from "@t3tools/contracts";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * The explicit recorded-parent reconnect (Dokkabi R8), through the same
 * authenticated per-environment command seam as the decision mutations.
 *
 * Only the thread id travels the wire — the closed server contract refuses
 * any renderer authority addition (provider, model, path, cursor, credential,
 * command text or policy); the server resolves the exact durable binding and
 * reuses the normal validated recovery path. Dispatch happens ONLY from an
 * explicit operator click; mounting, polling and projection updates never
 * send it. "available" means the recorded source is reconnected, never that
 * model work ran.
 */
export type WorkbenchResumeInput = {
  readonly threadId: ThreadId;
};

export const workbenchResumeAction = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:commands:provider:workbench-resume",
  execute: (input: WorkbenchResumeInput) =>
    request(WS_METHODS.providerResumeWorkbenchSession, {
      threadId: input.threadId,
    }),
});
