import { workspaceDigest } from "../host/execution-receipt.ts";
import { sessionDigestCache } from "./session-base.ts";
import type { EventLog } from "../host/event-log.ts";
import type { WorkPlan } from "./schema.ts";
import { isJudgedReceipt, judgedGreenOn, judgedRunOf, SESSION_RECEIPT } from "./judged-evidence.ts";

/**
 * The v2 completion verdict (interfaces-v2.md §5): after the working model
 * calls finish, the host checks that every non-guard sealed case and every
 * enrolled required check holds a receipt OF A HOST-JUDGED RUN
 * (`verify/receipt`: the verify step, the probe, the final/base pass, the
 * recheck — V7, D57i, judged-evidence.ts) with exit 0 whose image equals its
 * image after and the final workspace digest, and that the cited receipts
 * exist. A session execution's `exec/receipt` is never completion evidence.
 * All green → append work/accepted; anything missing or stale → a
 * work/finish-style unsupported verdict naming it. Guards are standing
 * invariants, not work claims: they are ignored here.
 */

export interface AcceptGap {
  readonly id: string;
  readonly reason: "stale" | "no_green_receipt" | "unknown_check";
}

export type AcceptV2Result =
  | { status: "accepted" }
  | { status: "unsupported"; missing: AcceptGap[] };

export function acceptV2(input: {
  log: EventLog;
  workspaceRoot: string;
  plan: WorkPlan;
  /** Enrolled required check ids (the acceptance catalog's required IDs). */
  requiredChecks: readonly string[];
  /** Receipt ids the model's finish call cited; each must exist. */
  cited: readonly string[];
}): AcceptV2Result {
  const { log } = input;
  // The final workspace digest: a receipt earned on any other tree is stale.
  const digest = workspaceDigest(input.workspaceRoot, sessionDigestCache(log, input.workspaceRoot));

  /** A judged green run of the command on the final image (V7): G1 —
   * credited only when the run left the tree it ran on (image ==
   * image_after) and that is the final tree. */
  const greenReceipt = (command: string): boolean => judgedGreenOn(log.events, command, digest);
  const anyReceipt = (command: string): boolean => judgedRunOf(log.events, command);

  const missing: AcceptGap[] = [];
  const greenCases: string[] = [];

  for (const item of input.plan.cases) {
    if (item.guard === true) continue;
    if (typeof item.command !== "string" || item.command.trim() === "") continue;
    if (greenReceipt(item.command)) {
      greenCases.push(item.id);
    } else {
      missing.push({
        id: item.id,
        reason: anyReceipt(item.command) ? "stale" : "no_green_receipt",
      });
    }
  }

  // Required checks are enrolled by id: satisfied only by a sealed case of
  // that id holding a green receipt on the final image.
  const caseIds = new Set(input.plan.cases.map((item) => item.id));
  for (const id of input.requiredChecks) {
    if (caseIds.has(id)) continue;
    missing.push({ id, reason: "unknown_check" });
  }

  // Every cited receipt must exist; a citation of nothing is data, not a gap.
  for (const id of input.cited) {
    if (!log.events.some((event) => (isJudgedReceipt(event) || event.name === SESSION_RECEIPT) && event.payload.id === id)) {
      missing.push({ id, reason: "unknown_check" });
    }
  }

  if (missing.length === 0) {
    log.append({
      kind: "observe",
      name: "work/accepted",
      payload: { digest, cases: greenCases },
    });
    return { status: "accepted" };
  }

  // The same event shape the finish tool writes, so every reader of
  // work/finish verdicts sees the v2 verdict without a new projector.
  log.append({
    kind: "observe",
    name: "work/finish",
    payload: {
      verdict: "unsupported",
      workspace_image: digest,
      receipts: [...input.cited],
      reason: missing.map((gap) => `${gap.reason}(${gap.id})`).join("; "),
      missing: missing.map((gap) => ({ id: gap.id, reason: gap.reason })),
    },
  });
  return { status: "unsupported", missing };
}
