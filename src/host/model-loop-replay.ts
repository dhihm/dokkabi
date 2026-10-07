import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { EventRecord } from "./schema.ts";

/** Semantic replay for model-loop sessions (interfaces.md §1): a session
 * whose work/loop names the model loop replays as observe events only — no
 * graph, no gates — so each contract §1 event contributes its canonical
 * payload digest. Graph-loop sessions have none of these rows and their
 * contracts are untouched. A ledger session (interfaces-v3.md §2) replays the
 * same way: its work/ledger_session row names the ledger planner, and its
 * ledger-only rows join the projected set — including the conclusion's
 * ledger/case and ledger/runner_* observations, which carry their own names
 * because v1's replay reads work/case and work/runner_* as graph-loop
 * authority. work/run_result stays out because the graph loop writes it too.
 * work/ledger_case (D48b) is a ledger revision like work/ledger; a recording
 * made before it existed holds none, so its references are unchanged. */
export const MODEL_LOOP_EVENT_NAMES = [
  "work/loop",
  "work/order",
  "work/budget",
  "verify/receipt",
  "exec/receipt",
  "work/note",
  "work/operator_question",
  "work/finish",
  "work/model_loop_result",
  "work/ledger_session",
  "work/ledger",
  "work/ledger_case",
  "work/continue",
  "work/plan_notice",
  "ledger/case",
  "ledger/runner_invocation",
  "ledger/runner_result",
] as const;

export interface ModelLoopReplayReference {
  readonly seq: number;
  readonly name: string;
  readonly digest: string;
}

export interface ModelLoopReplayProjection {
  readonly references: ModelLoopReplayReference[];
  /** True when a work/loop row names the model loop, or a work/ledger_session
   * row names the ledger planner (the same observe-only replay mode). */
  readonly isModelLoop: boolean;
}

export function projectModelLoopReplay(events: readonly EventRecord[]): ModelLoopReplayProjection {
  const names = new Set<string>(MODEL_LOOP_EVENT_NAMES);
  const references: ModelLoopReplayReference[] = [];
  let isModelLoop = false;
  for (const event of events) {
    if (event.name === "work/loop" && event.payload.loop === "model") isModelLoop = true;
    if (event.name === "work/ledger_session" && event.payload.planner === "ledger") isModelLoop = true;
    if (!names.has(event.name)) continue;
    references.push({ seq: event.seq, name: event.name, digest: createHash("sha256").update(canonicalJson(event.payload)).digest("hex") });
  }
  references.sort((a, b) => a.seq - b.seq);
  return { references, isModelLoop };
}
