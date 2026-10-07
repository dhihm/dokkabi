import type { EventRecord } from "../host/schema.ts";

/** Loader boots and prepared-child seeds use the two existing aliases.
 * Restart boundaries are valid only while every open retains the same owner;
 * an ambiguous or unidentified open cannot grant source-reading authority. */
export function codeSessionIsBound(rows: readonly EventRecord[], sessionId: string): boolean {
  const opens = rows.filter((row) => row.name === "session/open");
  return opens.length > 0 && opens.every((row) => {
    if (row.kind !== "observe") return false;
    const { id, session_id: canonical } = row.payload;
    if (id !== undefined && canonical !== undefined && id !== canonical) return false;
    return (canonical ?? id) === sessionId;
  });
}
