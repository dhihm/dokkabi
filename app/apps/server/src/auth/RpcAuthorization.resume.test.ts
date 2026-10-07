import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  WS_METHODS,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

/**
 * The explicit recorded-parent reconnect (Dokkabi R8) is an operator
 * mutation: it rebinds the recorded execution owner like a thread Send. It
 * therefore requires the orchestration OPERATE scope, and any client whose
 * session carries only read scopes — the restricted Record companion's scope
 * class — is refused by the ws authorization seam before the handler runs.
 */
describe("provider.resumeWorkbenchSession authorization scope", () => {
  it("requires the orchestration operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerResumeWorkbenchSession)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("refuses a read-only session exactly like the ws authorization seam does", () => {
    const requiredScope = requiredScopeForRpcMethod(WS_METHODS.providerResumeWorkbenchSession);
    // Mirrors ws.ts authorizeEffect: a session without the required scope
    // fails with EnvironmentAuthorizationError before any handler effect.
    const readOnlySessionScopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationReadScope];
    const authorized = readOnlySessionScopes.includes(requiredScope);
    expect(authorized).toBe(false);
    const refusal = new EnvironmentAuthorizationError({
      message: `The authenticated token is missing required scope: ${requiredScope}.`,
      requiredScope,
    });
    expect(refusal.requiredScope).toBe(AuthOrchestrationOperateScope);
  });
});
