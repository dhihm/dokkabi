import { CodeActionRequestFields, type ProviderWorkbenchCodeActionInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
export type CodeObserverResumeRequest = Omit<ProviderWorkbenchCodeActionInput, "threadId">;
const Intent = Schema.Struct({
  version: Schema.Literal(1),
  request: Schema.Struct(CodeActionRequestFields),
});
const prefix = "dokkabi-code-observer-pending-v1:";
const decode = Schema.decodeUnknownSync(Intent, { onExcessProperty: "error" });
export function readCodeObserverIntent(
  scopeKey: string,
):
  | { kind: "none" }
  | { kind: "pending"; request: CodeObserverResumeRequest }
  | { kind: "unavailable" } {
  try {
    const value = window.localStorage.getItem(prefix + scopeKey);
    return value === null
      ? { kind: "none" }
      : { kind: "pending", request: decode(JSON.parse(value)).request };
  } catch {
    // An inaccessible or corrupt prior intent cannot authorize a fresh id.
    return { kind: "unavailable" };
  }
}
export function retainCodeObserverIntent(
  scopeKey: string,
  request: CodeObserverResumeRequest,
): void {
  const value = decode({ version: 1, request });
  const previous = readCodeObserverIntent(scopeKey);
  if (
    previous.kind === "unavailable" ||
    (previous.kind === "pending" &&
      JSON.stringify(previous.request) !== JSON.stringify(value.request))
  )
    throw new Error("Another Code observer recovery intent remains unresolved");
  window.localStorage.setItem(prefix + scopeKey, JSON.stringify(value));
  const retained = readCodeObserverIntent(scopeKey);
  if (
    retained.kind !== "pending" ||
    JSON.stringify(retained.request) !== JSON.stringify(value.request)
  )
    throw new Error("Code observer recovery intent could not be retained");
}
export function clearCodeObserverIntent(
  scopeKey: string,
  request: CodeObserverResumeRequest,
): void {
  const previous = readCodeObserverIntent(scopeKey);
  if (
    previous.kind === "unavailable" ||
    (previous.kind === "pending" && JSON.stringify(previous.request) !== JSON.stringify(request))
  )
    throw new Error("Code observer recovery intent changed before settlement");
  window.localStorage.removeItem(prefix + scopeKey);
}
