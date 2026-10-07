import type { EventLog } from "../host/event-log.ts";
import type { LlmFacade } from "../loader/types.ts";

/**
 * Say at boot that the selected route cannot answer.
 *
 * A chat opened on a route with no credential looked healthy: the check ran
 * only inside the first model request, the failure was written to stderr
 * behind the alt-screen, and the one alert it produced aged off the strip in
 * thirty seconds. The operator typed, nothing came back, and `dokkabi login`
 * — which knew all along — was never mentioned on the screen they were
 * looking at.
 *
 * describe() is what `dokkabi login` prints from; it is synchronous and
 * touches no network, so it belongs at boot. The fact is recorded as an
 * event, which is where the board reads from, and the record carries the
 * command that fixes it.
 */
export interface RouteReadinessNotice {
  route: string;
  model: string;
  reason: string;
  hint: string;
}

export function routeReadinessNotice(llm: LlmFacade): RouteReadinessNotice | undefined {
  const route = llm.active();
  const status = route.describe();
  if (status.configured) return undefined;
  const reason = status.reason?.trim() || "credential missing";
  return {
    route: route.name,
    model: llm.activeModelId ?? route.defaultModelId() ?? "(route default)",
    reason,
    hint: `dokkabi login ${route.name} ${route.authKind === "oauth" ? "--oauth" : "--api-key"}`,
  };
}

/** Record the notice so every surface projecting the log can show it. */
export function announceRouteReadiness(llm: LlmFacade, log: EventLog): RouteReadinessNotice | undefined {
  const notice = routeReadinessNotice(llm);
  if (!notice) return undefined;
  log.append({
    kind: "observe",
    name: "model/route_unready",
    payload: { route: notice.route, model: notice.model, reason: notice.reason, hint: notice.hint },
  });
  return notice;
}

/** One line for a surface that can print before the board takes the screen. */
export function routeReadinessLine(notice: RouteReadinessNotice): string {
  return `route ${notice.route} cannot answer: ${notice.reason} — run: ${notice.hint}`;
}
