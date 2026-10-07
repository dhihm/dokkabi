import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginModule, ToolContributionRegistry } from "../loader/types.ts";
import type { EventLog } from "../host/event-log.ts";
import { BlobStore } from "../host/blob-store.ts";
import { clampToolResultText, producerTruncation } from "../tools/model-result.ts";
import type { SandboxPolicy } from "../host/sandbox.ts";
import {
  execReceiptId,
  workspaceDigest,
  type DigestCache,
  type ExecutionReceiptViews,
} from "../host/execution-receipt.ts";
import { sessionDigestCache } from "../work/session-base.ts";
import { isJudgedReceipt, SESSION_RECEIPT } from "../work/judged-evidence.ts";
import { judgeCommandOnLiveTree, sessionReceiptCommand } from "../work/judged-run.ts";
import { workspaceToolsPolicy } from "./workspace-tools.ts";

/**
 * The model loop's judgement tools. The host never judges whether a check is
 * the right check: every execution the model runs goes through `bash`, which
 * mints an authenticated `exec/receipt` (command bytes, workspace image
 * before and after, exit code, output digests). That receipt is the
 * session's own observation (V7, D57i): `finish` runs each cited command
 * again as a host-judged run on the final workspace (judged-run.ts) and
 * supports the claim only when every judged run left the workspace as it
 * was and ran against its final image.
 */

/** The subset of ExecutionViews the model-loop tools need. Keeping it
 * structural lets tests stub capture() to exercise the finish verdict rules
 * on hosts without the sandbox backend. */
export interface ModelLoopExecutionViews extends ExecutionReceiptViews {}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Digest kinds: `execution-image` receipts point at a captured execution
 * image (Linux/bwrap); `workspace-tree` receipts digest the live workspace
 * before and after a sandboxed run (everywhere else). */
export type ReceiptDigestKind = "execution-image" | "workspace-tree";

/** Receipt identity: the candidate image, the command bytes, and the
 * authenticated execution result — nothing else (unchanged formula). */
export function modelLoopReceiptId(input: { image: string; commandDigest: string; resultHash: string }): string {
  return execReceiptId(input);
}

function textResult(text: string, error = false) {
  return { content: [{ type: "text" as const, text: clampToolResultText(text) }], details: { error, ...producerTruncation(text) } };
}


/** The `note` tool, shared with the ledger manifest (same rows, same
 * behaviour). Exported so other plugins can reuse the exact tool instead of
 * forking it. */
export function createNoteTool(log: EventLog): AgentTool {
  return {
    name: "note",
    label: "note",
    description: "Append to your durable notes. Notes survive restarts and compaction; re-read them yourself — the harness never reads them for you.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note to append." },
      },
      required: ["text"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = params as { text?: unknown };
      if (typeof p.text !== "string" || p.text.length === 0) return textResult("note: text is required", true);
      const blob = BlobStore.forSession(log.path).put(p.text);
      const blobBytes = Buffer.byteLength(p.text);
      log.append({ kind: "observe", name: "work/note", payload: { blob, blob_bytes: blobBytes } });
      return textResult(`noted (${blobBytes} bytes)`);
    },
  };
}

/** The `ask_operator` tool, shared with the ledger manifest. */
export function createAskOperatorTool(log: EventLog): AgentTool {
  return {
    name: "ask_operator",
    label: "ask operator",
    description:
      "Record a question for the operator plus the assumption you will proceed on. Unattended, nobody answers: state the assumption and continue.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question." },
        assumption: { type: "string", description: "The assumption you proceed on until answered." },
      },
      required: ["question", "assumption"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = params as { question?: unknown; assumption?: unknown };
      if (typeof p.question !== "string" || typeof p.assumption !== "string") {
        return textResult("ask_operator: question and assumption are required", true);
      }
      log.append({
        kind: "observe",
        name: "work/operator_question",
        payload: { question: p.question, assumption: p.assumption, mode: "unattended" },
      });
      return textResult("recorded; proceeding on your assumption");
    },
  };
}

export function createModelLoopTools(input: { log: EventLog; views: ModelLoopExecutionViews; policy?: () => SandboxPolicy | undefined }): AgentTool[] {
  const { log, views } = input;
  // One digest cache per session: a re-digest after a no-op turn is free. Its
  // images cover what the session's base decides (C1, D57e); made when the
  // workspace root is first known.
  let digestCache: DigestCache | undefined;

  const note = createNoteTool(log);

  const askOperator = createAskOperatorTool(log);

  const finish: AgentTool = {
    name: "finish",
    label: "finish",
    description:
      "End the work with a completion claim. Cite the receipt ids that support the summary. A bash call's receipt is your own observation, never the evidence: for each one you cite, the host runs that exact command again itself on the final workspace, with a fresh cache and nothing your earlier commands left behind, and the claim is supported only when every such judged run exited 0, left the workspace unchanged and ran against its final state. A claim without such receipts is recorded as unsupported.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What was done, stated no more strongly than the receipts show." },
        receipts: { type: "array", items: { type: "string" }, description: "Receipt ids cited by the summary." },
      },
      required: ["summary", "receipts"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId, params) {
      void toolCallId;
      const p = params as { summary?: unknown; receipts?: unknown };
      if (typeof p.summary !== "string" || !Array.isArray(p.receipts) || p.receipts.some((id) => typeof id !== "string")) {
        return textResult("finish: summary (string) and receipts (string[]) are required", true);
      }
      const receipts = p.receipts as string[];
      const receiptRow = (id: string) => log.events.find((event) =>
        (isJudgedReceipt(event) || event.name === SESSION_RECEIPT) && event.payload.id === id);
      const policy = input.policy?.();
      const workspaceRoot = policy?.workspaceRoot;
      let verdict: "supported" | "unsupported" = "supported";
      let reason: string | undefined;
      // V7 (D57i): only a host-judged run is evidence. A cited session
      // receipt is judged again by the host (its exact command, on the live
      // tree, under a judged policy); a cited judged receipt stands as is.
      const judged: string[] = [];
      if (receipts.length === 0) {
        verdict = "unsupported";
        reason = "no_receipts";
      } else if (workspaceRoot === undefined) {
        verdict = "unsupported";
        reason = "no_workspace";
      } else {
        for (const id of receipts) {
          const row = receiptRow(id);
          if (!row) {
            verdict = "unsupported";
            reason = `unknown_receipt(${id})`;
            break;
          }
          if (isJudgedReceipt(row)) {
            judged.push(id);
            continue;
          }
          const command = sessionReceiptCommand(log, id);
          if (command === undefined) {
            verdict = "unsupported";
            reason = `unjudged_receipt(${id})`;
            break;
          }
          const run = judgeCommandOnLiveTree({ log, workspaceRoot, command });
          if (run.receipt === undefined) {
            verdict = "unsupported";
            reason = `judged_run_incomplete(${id})`;
            break;
          }
          judged.push(run.receipt);
        }
      }
      // The final workspace image, after every judged run.
      let workspaceImage = "";
      if (workspaceRoot !== undefined && receipts.length > 0) {
        digestCache ??= sessionDigestCache(log, workspaceRoot);
        workspaceImage = workspaceDigest(workspaceRoot, digestCache);
      }
      if (verdict === "supported") {
        for (const id of judged) {
          const row = log.events.find((event) => isJudgedReceipt(event) && event.payload.id === id)!;
          const payload = row.payload as { image?: unknown; image_after?: unknown; exit_code?: unknown };
          if (payload.exit_code !== 0) {
            verdict = "unsupported";
            reason = `red_receipt(${id})`;
            break;
          }
          // G1: a judged run that changed its tree is evidence for neither
          // image; one is credited only on the final image.
          if (payload.image !== payload.image_after) {
            verdict = "unsupported";
            reason = `changed_receipt(${id})`;
            break;
          }
          if (workspaceImage === "" || payload.image !== workspaceImage) {
            verdict = "unsupported";
            reason = `stale_receipt(${id})`;
            break;
          }
        }
      }
      const summaryDigest = sha256(p.summary);
      log.append({
        kind: "observe",
        name: "work/finish",
        payload: {
          summary_digest: summaryDigest,
          receipts: [...receipts],
          ...(judged.length > 0 ? { judged } : {}),
          workspace_image: workspaceImage,
          verdict,
          ...(reason !== undefined ? { reason } : {}),
          ...(workspaceImage !== "" ? { digest_kind: "workspace-tree", isolation: "live-workspace" } : {}),
        },
      });
      return textResult(
        verdict === "supported"
          ? `finish verdict: supported (${judged.length} judged receipt${judged.length === 1 ? "" : "s"})\nsummary ${summaryDigest}`
          : `finish verdict: unsupported — ${reason}\nsummary ${summaryDigest}`,
        verdict === "unsupported",
      );
    },
  };

  return [note, askOperator, finish];
}

export const plugin: PluginModule = {
  id: "model-loop-tools",
  claims: [
    // Optional because this plugin must register BEFORE workspace-tools (the
    // tools provider collects contributions once, at its own registration, and
    // PluginRuntime.refreshToolProviderIfNeeded only runs on enable/disable
    // transitions, never during the initial boot), while the execution-views
    // facade is provided after it. The tools resolve the facade lazily on
    // every call instead. The manifest order is therefore not arbitrary.
    { key: "execution_views", role: "consumer", optional: true },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
  ],
  register(ctx) {
    const missing = (): ModelLoopExecutionViews => ({
      capture: () => ({ status: "unavailable", reason: "execution_views_capability_missing" }),
      execute: () => ({ status: "unavailable", reason: "execution_views_capability_missing" }),
    });
    const views: ModelLoopExecutionViews = {
      capture: () => (ctx.tryGet<ModelLoopExecutionViews>("execution_views") ?? missing()).capture(),
      execute: (input) => (ctx.tryGet<ModelLoopExecutionViews>("execution_views") ?? missing()).execute(input),
    };
    // Resolved lazily on every call: this plugin registers BEFORE
    // workspace-tools, so the tools array (and its session policy) does not
    // exist yet at registration time. Same source execution-view uses.
    const modelTools = createModelLoopTools({
      log: ctx.log,
      views,
      policy: () => workspaceToolsPolicy(ctx.tryGet<AgentTool[]>("tools") ?? []),
    });
    const registry = ctx.inject<ToolContributionRegistry<AgentTool>>("tool_contributions");
    ctx.effect(() => {
      const disposers = modelTools.map((tool) => registry.register(plugin.id, tool));
      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  },
};
