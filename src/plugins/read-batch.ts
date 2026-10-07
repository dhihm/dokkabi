import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HostContext, PluginModule, ToolContributionRegistry } from "../loader/types.ts";
import {
  describeReadAdapters,
  enrolWorkspaceReadAdapters,
  READ_BATCH_CONCURRENCY,
  READ_BATCH_ITEMS_MAX,
  READ_BATCH_PENDING_PREVIEW_BYTES,
  READ_BATCH_TOOLS_EVENT,
  RecordedReadBatchService,
} from "../host/read-batch.ts";
import { resultSourceReaderAuthorised } from "../host/result-source.ts";
import { createReadBatchTool } from "../tools/read-batch.ts";
import { TOOL_CALL_PIPELINE_KEY, type ToolCallPipelineHolder } from "./loop-pi.ts";

/**
 * Recorded read batches (#228, design memo §138).
 *
 * Opt-in (E1): `DOKKABI_READ_BATCH=1` adds the `read_batch` tool; off, the
 * plugin declines to activate and nothing else changes — byte-identical.
 * The plugin is not in the default manifests; an operator adds it to the
 * manifest and sets the flag (schema exposure in a new session, or under a
 * reasoned seal). The adapters are enrolled from the ACTUAL registered
 * workspace tools (`tools`) at their generation (A1); every child runs
 * through those tool objects (A2). On a read-only log (replay, dashboard)
 * the plugin activates exactly when the recorded run loaded it, contributes
 * the same tool so the profile matches, and performs no read: the tool
 * answers `rejected` (replay).
 */
export const READ_BATCH_ENV = "DOKKABI_READ_BATCH";

function enabled(value: string | undefined): boolean {
  const normalised = value?.trim().toLowerCase();
  return normalised === "1" || normalised === "on" || normalised === "true";
}

export const plugin: PluginModule = {
  id: "read-batch",
  claims: [
    { key: "tools", role: "consumer" },
    { key: "tool_contributions", role: "consumer", modelFacing: true },
    { key: "tool_call_pipeline", role: "consumer", optional: true },
  ],
  activate(ctx: HostContext) {
    if (ctx.log.isReadOnly) {
      return ctx.log.events.some((event) => event.name === "plugin/load" && event.payload.id === "read-batch")
        ? { active: true as const }
        : { active: false as const, reason: "not loaded in the recorded run", kind: "not_configured" as const };
    }
    if (!enabled(process.env[READ_BATCH_ENV])) return { active: false as const, reason: `${READ_BATCH_ENV} is not set`, kind: "not_configured" as const };
    return { active: true as const };
  },
  register(ctx: HostContext) {
    const registry = ctx.inject<ToolContributionRegistry<AgentTool>>("tool_contributions");
    const contribute = (tool: AgentTool) => ctx.effect(() => {
      const dispose = registry.register(plugin.id, tool);
      return () => {
        void dispose();
      };
    });
    if (ctx.log.isReadOnly) {
      // Constitution 5: a replay loads what the run loaded and reads nothing;
      // the recorded `read_batch/tools` row says which capabilities that was.
      const recorded = [...ctx.log.events].reverse().find((event) => event.name === READ_BATCH_TOOLS_EVENT);
      const capabilities = Array.isArray(recorded?.payload.capabilities) ? (recorded!.payload.capabilities as unknown[]).filter((item): item is string => typeof item === "string") : [];
      contribute(createReadBatchTool({ replay: true, capabilities }));
      return;
    }
    const tools = ctx.get<AgentTool[]>("tools");
    const enrolment = enrolWorkspaceReadAdapters(tools, ctx.workspaceRoot);
    if (!enrolment || enrolment.adapters.size === 0) {
      ctx.log.append({ kind: "observe", name: READ_BATCH_TOOLS_EVENT, payload: { status: "unsupported", reason: enrolment ? "no_read_adapter" : "no_tool_generation", capabilities: [] } });
      return;
    }
    const service = new RecordedReadBatchService({
      log: ctx.log,
      enrolment,
      readerAuthorised: () => resultSourceReaderAuthorised(tools, ctx.log),
      // A2': the loop's pre-call pipeline for every child, read at run time
      // (the live agent sets it; without an agent there is no loop call).
      pipeline: () => ctx.tryGet<ToolCallPipelineHolder>(TOOL_CALL_PIPELINE_KEY)?.current,
    });
    const capabilities = [...enrolment.adapters.keys()].sort();
    contribute(createReadBatchTool({ service, capabilities }));
    ctx.log.append({
      kind: "observe",
      name: READ_BATCH_TOOLS_EVENT,
      payload: {
        status: "enrolled",
        capabilities,
        adapters: describeReadAdapters(enrolment),
        generation: enrolment.generation,
        root: enrolment.rootId,
        bounds: { items: READ_BATCH_ITEMS_MAX, concurrency: READ_BATCH_CONCURRENCY, pending_preview_bytes: READ_BATCH_PENDING_PREVIEW_BYTES },
      },
    });
  },
};
