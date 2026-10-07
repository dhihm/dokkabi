import type { EventRecord } from "./schema.ts";

/**
 * #228 X2': a read batch's children are recorded under their own row family
 * — `read_batch/child_call` (the pre-call pipeline's admission of a child,
 * what a loop call records as `tool/call`) and `read_batch/child` (its
 * result) — never as `tool/call` or `tool/result`. Distinct by construction:
 * no consumer of the loop's tool rows (replay listing, the research runner's
 * resume, the context-graph projector, the ledger, the dashboard, the
 * observation seal) can see a child without opting in. `isChildToolRow`
 * remains only as a guard: a `parent` field on a loop `tool/call` row is
 * malformed, and replay preflight refuses it.
 */
export const READ_BATCH_CHILD_CALL_EVENT = "read_batch/child_call";

/** A loop `tool/call` row that claims a parent: malformed, never a child. */
export function isChildToolRow(event: Pick<EventRecord, "name" | "payload">): boolean {
  return event.name === "tool/call" && typeof event.payload.parent === "string";
}

/** A child's admission row (X2'). */
export function isChildCallRow(event: Pick<EventRecord, "name" | "payload">): boolean {
  return event.name === READ_BATCH_CHILD_CALL_EVENT && typeof event.payload.parent === "string";
}
