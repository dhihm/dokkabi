import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "../host/event-log.ts";

function acceptanceSessionIds(events: readonly { name: string; payload: Record<string, unknown> }[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.name !== "work/step" || event.payload.action !== "accept") continue;
    for (const key of ["spec_session", "verifier_session"] as const) {
      const id = event.payload[key];
      if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids];
}

export function closeInterruptedAcceptanceSessions(homeRoot: string, parentSessionId: string): string[] {
  const parentPath = join(homeRoot, "sessions", parentSessionId, "events.jsonl");
  if (!existsSync(parentPath)) return [];
  const parent = new EventLog(parentPath, { readOnly: true });
  const closed: string[] = [];
  for (const sessionId of acceptanceSessionIds(parent.events)) {
    const path = join(homeRoot, "sessions", sessionId, "events.jsonl");
    if (!existsSync(path)) continue;
    const child = new EventLog(path);
    const status = [...child.events].reverse().find((event) => event.name === "agent/status")?.payload.status;
    if (status !== "running") continue;
    child.append({
      kind: "observe",
      name: "agent/status",
      payload: { status: "cancelled", reason: "parent_terminated", supervisor: parentSessionId },
    });
    closed.push(sessionId);
  }
  return closed;
}
