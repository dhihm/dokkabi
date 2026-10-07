import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  READ_BATCH_ITEMS_MAX,
  readBatchAggregateReason,
  readBatchAggregateText,
  type RecordedReadBatch,
} from "../host/read-batch.ts";

/**
 * `read_batch` (#228): one call composing up to 16 independent, already
 * authorised reads. The result is the exact recorded aggregate — each item
 * its own recorded invocation with its own #223 source, in request order,
 * with a closed status; the batch is never one snapshot and never a verdict.
 * The loop treats this tool like any other (no tool-name branch): the
 * aggregate passes the ordinary delivery step as one result.
 */

export const READ_BATCH_TOOL = "read_batch";

const Parameters = Type.Object({
  items: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$", description: "Stable result id, unique within the request." }),
    capabilityId: Type.String({ description: "An enrolled read capability: read, grep, glob, ls, or repo.<pin|grep|glob|ls|read> when the repo tool is present." }),
    args: Type.Object({}, { additionalProperties: true, description: "The capability's own arguments (the single tool's, minus a repo op): literals only, no reference to another item." }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: READ_BATCH_ITEMS_MAX }),
  consistency: Type.Optional(Type.Union([Type.Literal("per-item"), Type.Literal("snapshot")], {
    description: "per-item (default): each source bound to its own version. snapshot: refused as unsupported unless every adapter offers one immutable view.",
  })),
}, { additionalProperties: false });

export function createReadBatchTool(input: { readonly service?: RecordedReadBatch; readonly capabilities: readonly string[]; readonly replay?: boolean }): AgentTool<typeof Parameters> {
  const capabilities = input.capabilities.length > 0 ? input.capabilities.join(", ") : "none enrolled";
  return {
    name: READ_BATCH_TOOL,
    label: "read batch",
    description: `Run up to ${READ_BATCH_ITEMS_MAX} independent repository reads in one call (enrolled capabilities: ${capabilities}). Each item is its own recorded read through the same tool and authority as a single call, bound to its own source version; results come back in request order with a per-item status (ok, error, cancelled, stale, unsupported, unresolved) and the batch status (complete, partial, cancelled, rejected). A request with any unknown, write, shell, nested or item-dependent argument, a duplicate id or more than ${READ_BATCH_ITEMS_MAX} items is rejected as a whole before anything runs. Not a snapshot: files may change between items.`,
    parameters: Parameters,
    async execute(toolCallId, params, signal) {
      if (input.replay || !input.service) {
        const text = readBatchAggregateText({ batchRef: "rb_replay", status: "rejected", reason: "replay: recorded rows only; no live read is performed", items: [] });
        return { content: [{ type: "text", text }], details: { replay: true, status: "rejected" }, isError: true };
      }
      const result = await input.service.run(params as never, signal ?? new AbortController().signal, { parent: toolCallId });
      // Exactly the admitted aggregate the service recorded (S1'/R1).
      const text = readBatchAggregateText({ batchRef: result.batchRef, status: result.status, reason: result.reason, code: readBatchAggregateReason(result.status, result.reason.includes("deadline") ? "deadline" : "signal"), items: result.items, omitted: result.omitted });
      return {
        content: [{ type: "text", text }],
        details: { batch: result.batchRef, status: result.status, recorded: result.recorded, items: result.items.length, omitted: result.omitted.length },
        ...(result.status === "rejected" || !result.recorded ? { isError: true } : {}),
      };
    },
  };
}
