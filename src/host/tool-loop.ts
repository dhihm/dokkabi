import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";

export const TOOL_LOOP_WARN_CALLS = 3;
export const TOOL_LOOP_TERMINATE_CALLS = 6;
/**
 * Where a blocked call stops being a steer and ends the turn.
 *
 * The threshold above was written to end the turn, because "a terminated turn
 * reaches the operator; a fourth refusal reaches a fifth workaround". Over a
 * fortnight nobody is reading, so ending the turn there just ends the run. The
 * threshold now BLOCKS the call and says what to do instead, and the turn goes
 * on — the model gets to act on the refusal it was already being handed. Only
 * a model still repeating the identical call twice past that is out of ideas,
 * and only then does the turn end.
 */
export const TOOL_LOOP_HARD_STOP_CALLS = 12;
export const TOOL_LOOP_WARNING =
  "\n\n[loop] same call repeated 3 times; the result is not producing progress. change approach or report the blocker.";
export const TOOL_LOOP_TERMINATION =
  "[loop] tool_loop: this exact call has now been sent 6 times in a row and was blocked. "
  + "It will keep being blocked while it is unchanged, so sending it again spends the turn for nothing. "
  + "Read the error the call returned — it usually names what is wrong with the arguments — then either "
  + "send a DIFFERENT call, or write down the blocker and move to another part of the plan.";

export type ToolLoopDecision = "allow" | "approaching" | "warn" | "terminate" | "hard_stop";

export interface ToolCallStreak {
  tool: string;
  argsDigest: string;
  callDigest: string;
  count: number;
  decision: ToolLoopDecision;
  reset?: {
    tool: string;
    callDigest: string;
    count: number;
  };
}

/** Exact, turn-scoped consecutive-call detector. It retains digests only. */
export class ConsecutiveToolCallGuard {
  #tool?: string;
  #argsDigest?: string;
  #callDigest?: string;
  #count = 0;

  observe(tool: string, args: unknown): ToolCallStreak {
    return this.observeDigest(tool, toolArgumentsDigest(args));
  }

  observeDigest(tool: string, argsDigest: string): ToolCallStreak {
    const callDigest = digest({ tool, args_digest: argsDigest });
    const same = this.#tool === tool && this.#argsDigest === argsDigest;
    const reset = !same && this.#tool !== undefined && this.#callDigest !== undefined && this.#count >= 2
      ? { tool: this.#tool, callDigest: this.#callDigest, count: this.#count }
      : undefined;
    this.#tool = tool;
    this.#argsDigest = argsDigest;
    this.#callDigest = callDigest;
    this.#count = same ? this.#count + 1 : 1;
    return {
      tool,
      argsDigest,
      callDigest,
      count: this.#count,
      decision: toolLoopDecision(this.#count),
      ...(reset ? { reset } : {}),
    };
  }

  reset(): void {
    this.#tool = undefined;
    this.#argsDigest = undefined;
    this.#callDigest = undefined;
    this.#count = 0;
  }

  /** #224 A1': an independent copy, for a decision previewed on a shadow
   * of the guard's state that the real guard never sees. */
  clone(): ConsecutiveToolCallGuard {
    const copy = new ConsecutiveToolCallGuard();
    copy.#tool = this.#tool;
    copy.#argsDigest = this.#argsDigest;
    copy.#callDigest = this.#callDigest;
    copy.#count = this.#count;
    return copy;
  }
}

export function toolArgumentsDigest(args: unknown): string {
  return digest(args ?? {});
}

export function toolLoopDecision(count: number): ToolLoopDecision {
  if (count >= TOOL_LOOP_HARD_STOP_CALLS) return "hard_stop";
  if (count >= TOOL_LOOP_TERMINATE_CALLS) return "terminate";
  if (count === TOOL_LOOP_WARN_CALLS) return "warn";
  if (count >= 2) return "approaching";
  return "allow";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
