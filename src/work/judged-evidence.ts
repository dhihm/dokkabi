import { createHash } from "node:crypto";
import type { EventRecord } from "../host/schema.ts";

/**
 * ONLY JUDGED RUNS ARE COMPLETION EVIDENCE (V7, D57i; design memo §124).
 *
 * A completion verdict — acceptV2, the model loop's finish, the ledger
 * label, the continuation line's "cases without a green receipt" — credits
 * only receipts of runs the HOST judged: `verify/receipt` rows, minted by the
 * verify step, the plan probe, the final and base passes, the recheck and
 * the finish re-observation, each under a judged policy (a fresh tool cache
 * of its own, emptied around every execution: G3', D57h). A session
 * execution's `exec/receipt` is the session's own observation: it ran with
 * the session's shared cache and whatever state the session's earlier
 * executions left, so it is never completion evidence, however green. The
 * session obtains judged evidence through the probe (the plan tool), the
 * finish re-observation and the host's passes.
 *
 * A judged receipt credits a command only when its run left the tree it ran
 * on (image == image_after, G1) and that is the tree now.
 */

export const JUDGED_RECEIPT = "verify/receipt";
export const SESSION_RECEIPT = "exec/receipt";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Whether `event` is a receipt of a host-judged run. */
export function isJudgedReceipt(event: Pick<EventRecord, "name">): boolean {
  return event.name === JUDGED_RECEIPT;
}

/** Whether a host-judged run of exactly `command` exited 0 on `image` and
 * left it as it was. */
export function judgedGreenOn(events: readonly EventRecord[], command: string, image: string): boolean {
  const digest = sha256(command);
  return events.some((event) => isJudgedReceipt(event)
    && event.payload.command_digest === digest
    && event.payload.exit_code === 0
    && event.payload.image === event.payload.image_after
    && event.payload.image === image);
}

/** Whether a host-judged run of `command` on `image` is on record, green
 * or not (the probe does not run it again on the same tree). */
export function judgedRunOn(events: readonly EventRecord[], command: string, image: string): boolean {
  const digest = sha256(command);
  return events.some((event) => isJudgedReceipt(event) && event.payload.command_digest === digest && event.payload.image === image);
}

/** Whether any host-judged run of `command` is on record. */
export function judgedRunOf(events: readonly EventRecord[], command: string): boolean {
  const digest = sha256(command);
  return events.some((event) => isJudgedReceipt(event) && event.payload.command_digest === digest);
}
