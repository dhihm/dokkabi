import type { EventLog } from "./event-log.ts";

export interface ProviderRequestIdentity {
  route: string;
  role: string;
  model: Record<string, unknown>;
  options: Record<string, unknown>;
  context: { systemPrompt: string; tools: unknown[] };
}
type Guard = (request: ProviderRequestIdentity) => void;
const guards = new WeakMap<EventLog, Map<string, Guard>>();

/** Host-only plugin seam. A retained policy requires its live provider after
 * restart; removing a plugin cannot silently remove a previously bound gate. */
export function registerProviderRequestGuard(log: EventLog, id: string, guard: Guard): () => void {
  const active = guards.get(log) ?? new Map<string, Guard>();
  if (active.has(id) || log.isReadOnly) throw new Error("provider request guard is unavailable");
  if (!log.events.some(row => row.name === "provider/policy" && row.payload.id === id)) {
    log.appendDurable({ kind: "observe", name: "provider/policy", payload: { id } });
  }
  active.set(id, guard); guards.set(log, active);
  return () => { if (active.get(id) === guard) active.delete(id); };
}

export function assertProviderRequestGuards(log: EventLog, request: ProviderRequestIdentity): void {
  const declared = new Set(log.events.filter(row => row.name === "provider/policy").map(row => row.payload.id));
  for (const id of declared) {
    const guard = typeof id === "string" ? guards.get(log)?.get(id) : undefined;
    if (!guard) throw new Error("recorded provider request guard is not registered");
    guard(request);
  }
}
