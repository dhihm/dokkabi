import type { EventLog } from "../host/event-log.ts";
import { mintReceipt, workspaceDigest } from "../host/execution-receipt.ts";
import { createPolicy, disposeSandboxPolicy } from "../host/sandbox.ts";
import { executeTool } from "../tools/execute.ts";
import { scratchOption } from "./ledger-probe.ts";
import { sessionDigestCache } from "./session-base.ts";

/**
 * A HOST-JUDGED RUN OF ONE COMMAND ON THE LIVE TREE (V7, D57i): the finish
 * re-observation of the model loop. The session cites the receipts of its
 * own bash calls; the host runs each cited command again itself, exactly as
 * the final pass runs a case — on the tree as the session left it, under a
 * judged policy (a fresh tool cache of its own, emptied around the run:
 * G3'), no derived state of the session's executions — and mints the
 * `verify/receipt` the verdict reads. The session's own receipt is never
 * the evidence (judged-evidence.ts).
 */

/** The bound on one re-observation. */
export const JUDGED_RUN_TIMEOUT_MS = 120_000;

const COMMANDS = new WeakMap<EventLog, Map<string, string>>();

/** Remember the exact command bytes of a session receipt (in this process
 * only), so the host can judge that command again at finish. */
export function recordSessionReceiptCommand(log: EventLog, receipt: string, command: string): void {
  let byId = COMMANDS.get(log);
  if (byId === undefined) {
    byId = new Map();
    COMMANDS.set(log, byId);
  }
  byId.set(receipt, command);
}

/** The command bytes of a session receipt minted in this process. */
export function sessionReceiptCommand(log: EventLog, receipt: string): string | undefined {
  return COMMANDS.get(log)?.get(receipt);
}

/** Run `command` once on the live tree under a judged policy and mint its
 * `verify/receipt`; the receipt id, or undefined when the run never
 * completed. */
export function judgeCommandOnLiveTree(input: { log: EventLog; workspaceRoot: string; command: string; timeoutMs?: number }): { receipt?: string; exitCode?: number } {
  const { log, workspaceRoot, command } = input;
  const cache = sessionDigestCache(log, workspaceRoot);
  const policy = createPolicy({ mode: "workspace-write", workspaceRoot, log, toolCache: "judged", ...scratchOption(log, workspaceRoot) });
  try {
    const startedAt = Date.now();
    const imageBefore = workspaceDigest(workspaceRoot, cache);
    const unknownBefore = cache.lastUnknown;
    const seqBefore = log.lastSeq;
    const outcome = executeTool({
      log,
      policy,
      mode: "live",
      call: { id: `judged-${startedAt}`, name: "bash", args: { command } },
      timeoutMs: input.timeoutMs ?? JUDGED_RUN_TIMEOUT_MS,
    });
    const imageAfter = workspaceDigest(workspaceRoot, cache);
    if (outcome.exitCode === undefined) return {};
    const execRow = log.events.filter((event) => event.name === "sandbox/exec" && event.seq > seqBefore).at(-1);
    const { id } = mintReceipt({
      log,
      image_before: imageBefore,
      image_after: imageAfter,
      command,
      exit_code: outcome.exitCode,
      stdout: outcome.text,
      stderr: "",
      duration_ms: Date.now() - startedAt,
      isolation: "live-workspace",
      digest_kind: "workspace-tree",
      exec_ref: execRow ? { seq: execRow.seq, hash: execRow.hash } : null,
      names: { result: "verify/result", receipt: "verify/receipt" },
      unknown: { before: unknownBefore, after: cache.lastUnknown },
    });
    return { receipt: id, exitCode: outcome.exitCode };
  } finally {
    disposeSandboxPolicy(policy);
  }
}
