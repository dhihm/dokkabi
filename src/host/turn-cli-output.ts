import type { EventRecord } from "./schema.ts";

/** CLI lines that identify which route actually answered a `dokkabi turn`. */
export function formatTurnAnswerRouteStdout(input: {
  events: readonly EventRecord[];
  sinceSeq: number;
  activeRoute: string;
}): string {
  const lines: string[] = [];
  for (const transition of routeTransitionsInTurn(input.events, input.sinceSeq)) {
    const from = readRouteModel(transition.payload.from);
    const to = readRouteModel(transition.payload.to);
    if (!from || !to) continue;
    const failureClass = readFailureClass(transition.payload);
    lines.push(`failover: ${from.route}/${from.model} failed (${failureClass}) -> ${to.route}/${to.model}`);
  }
  lines.push(`route=${input.activeRoute}`);
  return `${lines.join("\n")}\n`;
}

function routeTransitionsInTurn(events: readonly EventRecord[], sinceSeq: number): EventRecord[] {
  const transitions: EventRecord[] = [];
  for (const event of events) {
    if (event.seq <= sinceSeq) continue;
    if (event.name === "model/route_transition") transitions.push(event);
  }
  return transitions;
}

function readRouteModel(value: unknown): { route: string; model: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { route?: unknown; model?: unknown };
  if (typeof candidate.route !== "string" || typeof candidate.model !== "string") return undefined;
  return { route: candidate.route, model: candidate.model };
}

function readFailureClass(payload: Record<string, unknown>): string {
  if (typeof payload.failure_class === "string") return payload.failure_class;
  if (typeof payload.reason_code === "string") return payload.reason_code;
  return "unknown";
}
